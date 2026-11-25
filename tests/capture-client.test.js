import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  ControlApiError, expireMedia, getControlSession, listCaptureJobs, mediaTypeForItem, recordingKindForItem,
  registerDownloadMedia, registerMedia, resetControlSession,
} from '../src/lib/capture-client.js';
import { STATION_STREAMS_KEY } from '../src/lib/station-stream-addresses.js';
import { getState } from '../src/lib/state.js';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('capture client registers only normalized media fields with session auth', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, {
      ok: true, data: { token: 'session-token', origin: 'http://127.0.0.1:9124' }, error: null,
    });
    return response(201, { ok: true, data: {
      media_id: 'opaque_media_token_1234567890',
      relay_url: '/api/v1/media/opaque_media_token_1234567890',
    }, error: null });
  };
  const data = await registerMedia({
    id: 'source:item', source: 'source', stream_url: 'https://media.example/live.m3u8?secret=yes',
    stream_kind: 'hls', delivery: 'live', capture_headers: { referer: 'https://catalog.example/' },
    download_url: 'https://must-not-be-sent.example/file', _extra: { private: true },
  }, { fetchImpl });
  assert.equal(data.relay_url.startsWith('/api/v1/media/'), true);
  assert.equal(calls.length, 2);
  const request = calls[1];
  assert.equal(request.options.headers['X-WorldMedia-Token'], 'session-token');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {
    item_id: 'source:item', url: 'https://media.example/live.m3u8?secret=yes',
    delivery: 'live', media_type: 'hls', recording_kind: 'audio',
    capture_headers: { referer: 'https://catalog.example/' },
    source: 'source', download_name: '',
  });
});

test('finite downloads keep the approved file when a live main address is saved', async (t) => {
  resetControlSession();
  const item = {
    id: 'radio:edited', type: 'radio', stream_kind: 'audio', delivery: 'on-demand',
    stream_url: 'https://station.example/original',
    download_url: 'https://downloads.example/original.mp3',
    capture_headers: { userAgent: 'Original/1' },
  };
  const main = 'https://station.example/live.mp3';
  const raw = JSON.stringify({ version: 1, stations: { [item.id]: { main } } });
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const favorites = getState().favorites;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: (key) => key === STATION_STREAMS_KEY ? raw : null },
  });
  t.after(() => {
    getState().favorites = favorites;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
  });
  const calls = [];
  const fetchImpl = async (path, options) => {
    if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'download-token' } });
    calls.push(JSON.parse(options.body));
    return response(201, { ok: true, data: { media_id: 'opaque-id' } });
  };
  getState().favorites = [item];
  await assert.rejects(registerDownloadMedia({ ...item, download_url: '' }, { fetchImpl }),
    { code: 'DOWNLOAD_UNAVAILABLE' });
  await registerDownloadMedia(item, { fetchImpl });
  assert.equal(calls[0].url, item.download_url);
  assert.equal(calls[0].delivery, 'on-demand');
  assert.equal(calls[0].media_type, 'audio');
  assert.deepEqual(calls[0].capture_headers, item.capture_headers);

  getState().favorites = [];
  await registerDownloadMedia(item, { fetchImpl });
  assert.equal(calls[1].url, item.download_url);
  assert.deepEqual(calls[1].capture_headers, item.capture_headers);
});

test('job synchronization uses the fixed authenticated list route', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'jobs-token' } });
    return response(200, { ok: true, data: { jobs: [{ id: 'job_sync_1234567890', item_id: 'radio:one' }] } });
  };
  const jobs = await listCaptureJobs({ fetchImpl });
  assert.equal(jobs[0].item_id, 'radio:one');
  assert.equal(calls[1].path, '/api/v1/jobs');
  assert.equal(calls[1].options.headers['X-WorldMedia-Token'], 'jobs-token');
});

test('media expiry is authenticated and API errors remain structured', async () => {
  resetControlSession();
  let count = 0;
  const fetchImpl = async (path, options) => {
    count++;
    if (count === 1) return response(200, { ok: true, data: { token: 'token' } });
    assert.equal(path, '/api/v1/media/opaque_id_1234567890123456/expire');
    assert.deepEqual(JSON.parse(options.body), { grace_seconds: 5 });
    return response(403, { ok: false, error: {
      code: 'INVALID_TOKEN', message: 'Session expired.', retryable: true,
    } });
  };
  await assert.rejects(
    expireMedia('opaque_id_1234567890123456', 5, { fetchImpl }),
    (error) => error instanceof ControlApiError && error.code === 'INVALID_TOKEN' && error.retryable,
  );
  assert.equal(mediaTypeForItem({ type: 'tv', stream_kind: '' }), 'video');
  assert.equal(mediaTypeForItem({ type: 'radio', stream_kind: '' }), 'audio');
  assert.equal(recordingKindForItem({ type: 'tv', stream_kind: 'hls' }), 'video');
  assert.equal(recordingKindForItem({ type: 'radio', stream_kind: 'hls' }), 'audio');
});

test('cancelling a cold media registration leaves a concurrent registration running', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const first = new AbortController();
  const second = new AbortController();
  const sessionRequests = [];
  const fetchImpl = async (path, options) => {
    if (path === '/api/v1/session') {
      sessionRequests.push(options.signal);
      if (sessionRequests.length === 1) return new Promise(() => {});
      return response(200, { ok: true, data: { token: 'session-token' } });
    }
    assert.equal(options.headers['X-WorldMedia-Token'], 'session-token');
    assert.equal(options.signal?.aborted ?? false, false);
    return response(201, { ok: true, data: { media_id: 'working-relay' } });
  };
  const item = { id: 'radio:station', source: 'radio-browser', stream_url: 'https://media.example/live' };
  const cancelled = assert.rejects(registerMedia(item, { fetchImpl, signal: first.signal }), { name: 'AbortError' });
  const concurrent = registerMedia(item, { fetchImpl, signal: second.signal });
  first.abort();

  await cancelled;
  assert.equal((await concurrent).media_id, 'working-relay');
  await registerMedia(item, { fetchImpl });
  assert.equal(sessionRequests.length, 2, 'later registrations reuse the successful session');
  assert.equal(sessionRequests[0].aborted, true);
  assert.equal(sessionRequests[1].aborted, false);
});

test('a delayed session lookup cannot overwrite a newer server token', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  let finishOld;
  const old = getControlSession({
    fetchImpl: () => new Promise((resolve) => { finishOld = resolve; }),
  });
  const fresh = await getControlSession({
    signal: new AbortController().signal,
    fetchImpl: async () => response(200, { ok: true, data: { token: 'new' } }),
  });
  finishOld(response(200, { ok: true, data: { token: 'old' } }));
  assert.equal((await old).token, 'new');
  assert.equal(await getControlSession(), fresh);
});

test('a delayed rejection clears only the session token it used', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  let rejectOld;
  let markSent;
  const sent = new Promise((resolve) => { markSent = resolve; });
  const refusal = response(403, { ok: false, error: { code: 'INVALID_TOKEN' } });
  const outdated = listCaptureJobs({
    fetchImpl: async (path, options) => {
      if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'old' } });
      assert.equal(options.headers['X-WorldMedia-Token'], 'old');
      markSent();
      return new Promise((resolve) => { rejectOld = resolve; });
    },
  });
  const rejected = assert.rejects(outdated, { code: 'INVALID_TOKEN' });
  await sent;
  await assert.rejects(listCaptureJobs({
    fetchImpl: async (_path, options) => {
      assert.equal(options.headers['X-WorldMedia-Token'], 'old');
      return refusal;
    },
  }), { code: 'INVALID_TOKEN' });
  const fresh = await getControlSession({
    fetchImpl: async () => response(200, { ok: true, data: { token: 'new' } }),
  });
  rejectOld(refusal);
  await rejected;
  assert.equal(await getControlSession(), fresh);
});

test('resetting the session aborts a pending lookup', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  let signal;
  const old = getControlSession({
    fetchImpl: (_path, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const cancelled = assert.rejects(old, { name: 'AbortError' });
  resetControlSession();
  assert.equal(signal.aborted, true);
  await cancelled;
});

test('a slow lookup can finish beyond ten seconds with or without a caller signal', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    resetControlSession();
    mock.timers.reset();
  });
  for (const signal of [undefined, new AbortController().signal]) {
    resetControlSession();
    let finish;
    let lookupSignal;
    let calls = 0;
    const fetchImpl = async (_path, options) => {
      lookupSignal = options.signal;
      calls += 1;
      return { status: 200, ok: true, json: () => new Promise((resolve) => { finish = resolve; }) };
    };
    const first = getControlSession({ fetchImpl, signal });
    const second = getControlSession({ fetchImpl, signal });
    await Promise.resolve();
    mock.timers.tick(11_000);
    assert.equal(calls, 1);
    assert.equal(lookupSignal.aborted, false);
    finish({ ok: true, data: { token: 'slow' } });
    assert.deepEqual(await Promise.all([first, second]), [{ token: 'slow' }, { token: 'slow' }]);
  }
});

test('a superseded lookup with an empty cache retries under its original signal', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const { signal } = new AbortController();
  let finishOld;
  let calls = 0;
  const fetchImpl = async (_path, options) => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finishOld = resolve; });
    assert.equal(options.signal.aborted, false);
    return response(200, { ok: true, data: { token: 'replacement' } });
  };
  const old = getControlSession({ fetchImpl, signal });
  const joined = getControlSession({ fetchImpl, signal });
  await getControlSession({
    fetchImpl: async () => response(200, { ok: true, data: { token: 'new' } }),
  });
  await assert.rejects(listCaptureJobs({
    fetchImpl: async (_path, options) => {
      assert.equal(options.headers['X-WorldMedia-Token'], 'new');
      return response(403, { ok: false, error: { code: 'INVALID_TOKEN' } });
    },
  }), { code: 'INVALID_TOKEN' });
  finishOld(response(200, { ok: true, data: { token: 'old' } }));
  assert.deepEqual(await Promise.all([old, joined]), [{ token: 'replacement' }, { token: 'replacement' }]);
  assert.equal(calls, 2);
});
