import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getJson, getJsonWithMetadata, getText, postJson, parseRetryAfter,
  MAX_RETRY_AFTER_MS,
  HttpContentTypeError, HttpParseError, HttpResponseTooLargeError, ProviderError,
} from '../src/lib/http.js';

function response(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: options.headers || {},
  });
}

test('strict JSON and text helpers keep response types separate', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    if (init.method === 'POST') {
      return response(JSON.stringify({ echoed: JSON.parse(init.body) }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init.headers.Accept === 'text/plain') return response('plain fixture', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    return response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };

  assert.deepEqual(await getJson('https://api.example/data', { fetchImpl }), { ok: true });
  const withMetadata = await getJsonWithMetadata('https://api.example/data', {
    fetchImpl: async () => response('{"ok":true}', {
      headers: {
        'content-type': 'application/json',
        link: '<https://api.example/data?page=2>; rel="next"',
        etag: '"fixture"',
        'last-modified': 'Wed, 15 Jul 2026 00:00:00 GMT',
      },
    }),
  });
  assert.deepEqual(withMetadata, {
    data: { ok: true },
    status: 200,
    headers: {
      link: '<https://api.example/data?page=2>; rel="next"',
      etag: '"fixture"',
      lastModified: 'Wed, 15 Jul 2026 00:00:00 GMT',
    },
  });
  assert.equal(await getText('https://api.example/text', {
    fetchImpl, headers: { Accept: 'text/plain' }, contentTypes: ['text/plain'],
  }), 'plain fixture');
  assert.deepEqual(await postJson('https://api.example/graphql', { query: '{ fixture }' }, { fetchImpl }), {
    echoed: { query: '{ fixture }' },
  });
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).headers['Content-Type'], 'application/json');
});

test('HTML/CAPTCHA, malformed JSON, and GraphQL errors are typed failures rather than empty success', async () => {
  await assert.rejects(
    getJson('https://www.loc.gov/audio', {
      fetchImpl: async () => response('<!doctype html><h1>CAPTCHA</h1>', {
        headers: { 'content-type': 'text/html' },
      }),
    }),
    HttpContentTypeError,
  );
  await assert.rejects(
    getJson('https://api.example/malformed', {
      fetchImpl: async () => response('{"broken":', {
        headers: { 'content-type': 'application/json' },
      }),
    }),
    HttpParseError,
  );
  await assert.rejects(
    postJson('https://api.example/graphql', { query: '{}' }, {
      graphql: true,
      fetchImpl: async () => response(JSON.stringify({ data: null, errors: [{ message: 'fixture' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    }),
    (error) => error instanceof ProviderError
      && error.code === 'GRAPHQL_ERROR'
      && error.errors[0].message === 'fixture',
  );
});

test('decoded response budgets reject declared and streamed oversize bodies', async () => {
  await assert.rejects(
    getJson('https://api.example/declared-large', {
      maxBytes: 4,
      fetchImpl: async () => response('{"ok":true}', {
        headers: { 'content-type': 'application/json', 'content-length': '999' },
      }),
    }),
    HttpResponseTooLargeError,
  );
  await assert.rejects(
    getJson('https://api.example/streamed-large', {
      maxBytes: 8,
      fetchImpl: async () => response('{"payload":"too large"}', {
        headers: { 'content-type': 'application/json' },
      }),
    }),
    HttpResponseTooLargeError,
  );
});

test('Retry-After controls transient retry timing and malformed values fall back exponentially', async () => {
  assert.equal(parseRetryAfter('5', 0), 5_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:55 GMT')), 5_000);
  assert.equal(parseRetryAfter('invalid', 0), null);

  const delays = [];
  let calls = 0;
  const payload = await getJson('https://api.example/rate-limited', {
    retries: 2,
    retryBaseMs: 25,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response('rate', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '7' },
      });
      if (calls === 2) return response('upstream', {
        status: 503, headers: { 'content-type': 'text/plain' },
      });
      return response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(payload, { ok: true });
  assert.deepEqual(delays, [7_000, 50]);
});

test('explicit abort during retry wait and timeout abort never retry or leak another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const waiting = getJson('https://api.example/retry-abort', {
    retries: 3,
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      return response('temporary', { status: 503, headers: { 'content-type': 'text/plain' } });
    },
    sleep: (_ms, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(calls, 1);

  let timeoutCalls = 0;
  const timeout = getJson('https://api.example/timeout', {
    timeoutMs: 10,
    retries: 0,
    setTimer: (callback) => { queueMicrotask(callback); return 1; },
    clearTimer: () => {},
    fetchImpl: async (_url, init) => {
      timeoutCalls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(timeout, (error) => error.code === 'TIMEOUT' && error.status === 0);
  assert.equal(timeoutCalls, 1);
});

test('failed response bodies are canceled and fallback retry waits stay bounded', async () => {
  let canceled = 0;
  let calls = 0;
  const delays = [];
  const value = await getJson('https://api.example/bounded-error', {
    retries: 1,
    retryBaseMs: MAX_RETRY_AFTER_MS * 2,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          statusText: 'fixture',
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: { cancel: async () => { canceled += 1; } },
        };
      }
      return response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(canceled, 1);
  assert.deepEqual(delays, [MAX_RETRY_AFTER_MS]);
});
