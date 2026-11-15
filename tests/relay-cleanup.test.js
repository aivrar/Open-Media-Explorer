import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIVE_RELAY_KEY, createRelayMemory } from '../src/lib/relay-memory.js';
import {
  connectMediaRelay, MediaConnectionError, MEDIA_REGISTRY_FULL, MEDIA_REGISTRY_FULL_MESSAGE,
} from '../src/lib/media-failover.js';
import { startItemRecording } from '../src/lib/recording-client.js';
import { startItemDownload } from '../src/lib/download-client.js';
import {
  ControlApiError, expireMedia, isDefinitiveRejection, resetControlSession,
} from '../src/lib/capture-client.js';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('relay memory sets and clears the active playback relay id', () => {
  const storage = new MemoryStorage();
  const memory = createRelayMemory({ storage, release: async () => {} });
  memory.remember('play_media_123456789012');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'play_media_123456789012');
  memory.remember('play_media_223456789012');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'play_media_223456789012');
  assert.equal(memory.forgetIf('play_media_123456789012'), false, 'a different id is kept');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'play_media_223456789012');
  assert.equal(memory.forgetIf('play_media_223456789012'), true);
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);
  memory.remember('play_media_123456789012');
  memory.forget();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);
  memory.remember('not a relay id/../x');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);
});

test('a leftover id is removed only after its release succeeded, once per page', async () => {
  const storage = new MemoryStorage();
  storage.setItem(ACTIVE_RELAY_KEY, 'old_page_media_1234567890');
  const released = [];
  let finishRelease;
  const memory = createRelayMemory({
    storage,
    release: (id) => { released.push(id); return new Promise((resolve) => { finishRelease = resolve; }); },
  });
  const pending = memory.releaseLeftover();
  await flush();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'old_page_media_1234567890', 'kept until the release answers');
  finishRelease({ expired: true });
  assert.equal(await pending, 'old_page_media_1234567890');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);
  assert.equal(await memory.releaseLeftover(), '');
  assert.deepEqual(released, ['old_page_media_1234567890']);
});

test('a leftover survives a transport failure, and a newer id is never removed', async () => {
  const storage = new MemoryStorage();
  storage.setItem(ACTIVE_RELAY_KEY, 'old_page_media_2234567890');
  let calls = 0;
  const offline = createRelayMemory({
    storage, release: async () => { calls++; throw new TypeError('Failed to fetch'); },
  });
  assert.equal(await offline.releaseLeftover(), 'old_page_media_2234567890');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'old_page_media_2234567890', 'left for the next start');
  assert.equal(await offline.releaseLeftover(), '', 'no retry loop within one page');
  assert.equal(calls, 1);

  // An error reply proves nothing either: the backend answers success even for
  // an unknown or already-expired id, so a stale session token or a busy
  // server must not clear the stored id.
  for (const error of [
    new ControlApiError('INVALID_TOKEN', 'Invalid session.', 403),
    new ControlApiError('RELAY_BUSY', 'Media relay is busy.', 503),
    new ControlApiError('ROUTE_NOT_FOUND', 'Not found.', 404),
  ]) {
    const refused = createRelayMemory({ storage, release: async () => { throw error; } });
    await refused.releaseLeftover();
    assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'old_page_media_2234567890', error.code);
  }
  // Success, which the backend also returns for an id that is already gone.
  const released = createRelayMemory({ storage, release: async () => ({ expired: true }) });
  await released.releaseLeftover();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);

  // Playback started and stored a new id while the release was in flight.
  storage.setItem(ACTIVE_RELAY_KEY, 'old_page_media_3234567890');
  let finishRelease;
  const racing = createRelayMemory({
    storage, release: () => new Promise((resolve) => { finishRelease = resolve; }),
  });
  const pending = racing.releaseLeftover();
  await flush();
  racing.remember('new_page_media_123456789012');
  finishRelease();
  await pending;
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), 'new_page_media_123456789012');
});

test('relay memory keeps working when storage is missing or throws', async () => {
  const released = [];
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); },
  };
  const memory = createRelayMemory({ storage: throwing, release: (id) => { released.push(id); } });
  assert.doesNotThrow(() => memory.remember('play_media_123456789012'));
  assert.doesNotThrow(() => memory.forget());
  assert.equal(await memory.releaseLeftover(), '');
  const absent = createRelayMemory({ storage: null, release: (id) => { released.push(id); } });
  assert.doesNotThrow(() => absent.remember('play_media_123456789012'));
  assert.equal(await absent.releaseLeftover(), '');
  const accessorThrows = createRelayMemory({
    storage: () => { throw new Error('SecurityError'); },
    release: (id) => { released.push(id); },
  });
  assert.doesNotThrow(() => accessorThrows.remember('play_media_123456789012'));
  assert.equal(await accessorThrows.releaseLeftover(), '');
  assert.deepEqual(released, []);
});

test('expire can be sent with keepalive for pagehide, and only when asked', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 't' } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  await expireMedia('page_media_1234567890', 0, { fetchImpl, keepalive: true });
  await expireMedia('page_media_2234567890', 0, { fetchImpl });
  assert.equal(calls[1].options.keepalive, true);
  assert.equal(calls[1].options.headers['X-WorldMedia-Token'], 't');
  assert.deepEqual(JSON.parse(calls[1].options.body), { grace_seconds: 0 });
  assert.equal('keepalive' in calls[2].options, false);
  resetControlSession();
});

function radioItem(extra = {}) {
  return {
    id: 'radio:full', title: 'Full', source: 'radio-browser', type: 'radio',
    stream_url: 'https://radio.example/live', stream_kind: 'audio', delivery: 'live',
    capture_headers: {}, ...extra,
  };
}

function registryFull() {
  return Object.assign(new Error('Media relay is temporarily full.'), {
    code: MEDIA_REGISTRY_FULL, status: 503, retryable: true,
  });
}

test('a full relay registry is reported plainly and is not retryable', async () => {
  for (const item of [
    radioItem(),
    radioItem({ _extra: { streamCandidates: [{ url: 'https://backup.example/live', kind: 'audio', headers: {} }] } }),
  ]) {
    await assert.rejects(
      connectMediaRelay(item, {
        registerImpl: async () => { throw registryFull(); },
        probeImpl: async () => true,
        expireImpl: async () => {},
        fetchImpl: async () => { throw new Error('unused'); },
      }),
      (error) => error instanceof MediaConnectionError
        && error.code === MEDIA_REGISTRY_FULL
        && error.message === MEDIA_REGISTRY_FULL_MESSAGE
        && error.retryable === false
        && error.codes.includes(MEDIA_REGISTRY_FULL),
    );
  }
  assert.equal(MEDIA_REGISTRY_FULL_MESSAGE, "The app's stream relay is full. Restart the app to clear it.");
});

test('an aggregated connection error keeps its underlying codes', async () => {
  let call = 0;
  await assert.rejects(
    connectMediaRelay(radioItem({
      _extra: { streamCandidates: [{ url: 'https://backup.example/live', kind: 'audio', headers: {} }] },
    }), {
      registerImpl: async () => ({ media_id: `m_${++call}_1234567890`, relay_url: `/api/v1/media/m_${call}` }),
      probeImpl: async (relay) => {
        throw Object.assign(new Error('bad'), {
          code: relay.media_id.startsWith('m_1') ? 'MEDIA_CONNECT_FAILED' : 'MEDIA_RELAY_STATUS',
        });
      },
      expireImpl: async () => {},
      fetchImpl: async () => { throw new Error('unused'); },
    }),
    (error) => error instanceof MediaConnectionError
      && error.code === 'MEDIA_CANDIDATES_UNAVAILABLE'
      && error.retryable === true
      && error.codes.length === 2
      && error.codes.includes('MEDIA_CONNECT_FAILED')
      && error.codes.includes('MEDIA_RELAY_STATUS'),
  );
});

function jobFetch(jobStatus, calls) {
  return async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 't' } }) };
    if (path === '/api/v1/media/register') {
      return { ok: true, status: 201, json: async () => ({ ok: true, data: { media_id: 'own_media_1234567890', relay_url: '/api/v1/media/own' } }) };
    }
    if (path.endsWith('/expire')) return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    if (jobStatus === 'lost') throw new TypeError('Failed to fetch');
    if (jobStatus === 'abort') throw new DOMException('The operation was aborted.', 'AbortError');
    if (jobStatus === 'unreadable') {
      return { ok: true, status: 202, headers: { get: () => null }, json: async () => { throw new SyntaxError('cut off'); } };
    }
    return {
      ok: jobStatus < 300,
      status: jobStatus,
      headers: { get: () => null },
      json: async () => (jobStatus < 300
        ? { ok: true, data: { id: 'job_1', state: 'queued' } }
        : { ok: false, data: null, error: { code: 'JOB_LIMIT', message: 'Too many jobs.' } }),
    };
  };
}

test('a rejected recording start releases the registration it made, and rethrows', async () => {
  resetControlSession();
  const calls = [];
  await assert.rejects(
    startItemRecording(radioItem(), 'balanced', { fetchImpl: jobFetch(429, calls) }),
    (error) => error.code === 'JOB_LIMIT',
  );
  await flush();
  assert.deepEqual(calls.map((call) => call.path).slice(1), [
    '/api/v1/media/register', '/api/v1/jobs/record', '/api/v1/media/own_media_1234567890/expire',
  ]);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { grace_seconds: 0 });

  // A started job keeps its registration.
  resetControlSession();
  const okCalls = [];
  await startItemRecording(radioItem(), 'balanced', { fetchImpl: jobFetch(202, okCalls) });
  await flush();
  assert.equal(okCalls.some((call) => call.path.endsWith('/expire')), false);
  resetControlSession();
});

test('only a reply that refused the request counts as definitive', () => {
  assert.equal(isDefinitiveRejection(new ControlApiError('JOB_LIMIT', 'x', 429)), true);
  assert.equal(isDefinitiveRejection(new ControlApiError('INVALID_MEDIA_ID', 'x', 400)), true);
  assert.equal(isDefinitiveRejection(new ControlApiError('RECORDING_NOT_LIVE', 'x', 409)), true);
  assert.equal(isDefinitiveRejection(new ControlApiError('RELAY_BUSY', 'x', 503)), true);
  assert.equal(isDefinitiveRejection(new ControlApiError('INTERNAL_ERROR', 'x', 500)), false);
  assert.equal(isDefinitiveRejection(new ControlApiError(undefined, undefined, 202)), false);
  assert.equal(isDefinitiveRejection(new ControlApiError('X', 'x', 0)), false);
  assert.equal(isDefinitiveRejection(new TypeError('Failed to fetch')), false);
  assert.equal(isDefinitiveRejection(new DOMException('aborted', 'AbortError')), false);
  assert.equal(isDefinitiveRejection(null), false);
});

test('an ambiguous job-start failure keeps the registration: the job may be running', async () => {
  const item = {
    id: 'nasa:clip', title: 'Clip', source: 'nasa', type: 'video', stream_kind: 'video',
    download_url: 'https://media.example/clip.mp4', download_name: 'clip.mp4', capture_headers: {},
  };
  for (const outcome of ['lost', 'abort', 'unreadable', 500]) {
    for (const start of [
      (fetchImpl) => startItemRecording(radioItem(), 'balanced', { fetchImpl }),
      (fetchImpl) => startItemDownload(item, { fetchImpl }),
    ]) {
      resetControlSession();
      const calls = [];
      await assert.rejects(start(jobFetch(outcome, calls)));
      await flush();
      assert.equal(calls.some((call) => call.path.endsWith('/expire')), false, `released after ${outcome}`);
    }
  }
  resetControlSession();
});

test('a rejected download start releases the registration it made, and rethrows', async () => {
  resetControlSession();
  const calls = [];
  const item = {
    id: 'nasa:clip', title: 'Clip', source: 'nasa', type: 'video', stream_kind: 'video',
    download_url: 'https://media.example/clip.mp4', download_name: 'clip.mp4', capture_headers: {},
  };
  await assert.rejects(
    startItemDownload(item, { fetchImpl: jobFetch(429, calls) }),
    (error) => error.code === 'JOB_LIMIT',
  );
  await flush();
  assert.deepEqual(calls.map((call) => call.path).slice(1), [
    '/api/v1/media/register', '/api/v1/jobs/download', '/api/v1/media/own_media_1234567890/expire',
  ]);

  resetControlSession();
  const okCalls = [];
  await startItemDownload(item, { fetchImpl: jobFetch(202, okCalls) });
  await flush();
  assert.equal(okCalls.some((call) => call.path.endsWith('/expire')), false);
  resetControlSession();
});
