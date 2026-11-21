import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { controlRequest, getControlSession, registerMedia, resetControlSession } from '../src/lib/capture-client.js';
import {
  PROFILE_REQUEST_TIMEOUT_MS, cancelScheduledProfileHandoff, clearProfileHandoff, saveProfileHandoff,
} from '../src/lib/profile-transfer.js';

const KEY = 'worldmedia.favorites.v1';
const drain = () => new Promise((resolve) => setImmediate(resolve));

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

/** The browser's connections to one server, as Chromium keeps them: six at
 *  a time for requests sent with credentials, six more for requests sent
 *  without; a request beyond that waits in its group's queue. */
function browserConnections(answer) {
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { busy: 0, queue: [] });
    return groups.get(key);
  };
  const pool = {
    sent: [],
    fetch(path, options = {}) {
      const key = options.credentials === 'omit' ? 'without credentials' : 'with credentials';
      const lane = group(key);
      return new Promise((resolve, reject) => {
        const start = () => {
          lane.busy += 1;
          pool.sent.push({ path, credentials: options.credentials });
          Promise.resolve(answer(path, options)).then((response) => {
            if (response === null) return; // held open, like a slow catalogue request
            lane.busy -= 1;
            lane.queue.shift()?.();
            resolve(response);
          }, reject);
        };
        options.signal?.addEventListener?.('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        if (lane.busy < 6) start();
        else lane.queue.push(start);
      });
    },
  };
  return pool;
}

function setup(t) {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:' };
  resetControlSession();
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    cancelScheduledProfileHandoff();
    mock.timers.reset();
    resetControlSession();
    globalThis.location = previousLocation;
  });
}

test('a control request asked to use its own connection is sent without credentials, with its token', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const seen = [];
  const fetchImpl = async (path, options) => {
    seen.push({ path, credentials: options.credentials, token: options.headers?.['X-WorldMedia-Token'] });
    if (path === '/api/v1/session') return json(200, { ok: true, data: { token: 'own-connection-token' } });
    return json(200, { ok: true, data: { done: true } });
  };
  await controlRequest('/api/v1/jobs', { fetchImpl });
  await controlRequest('/api/v1/profile/preferences', { fetchImpl, method: 'POST', body: { values: {} }, ownConnection: true });
  assert.deepEqual(seen.slice(1), [
    { path: '/api/v1/jobs', credentials: 'same-origin', token: 'own-connection-token' },
    { path: '/api/v1/profile/preferences', credentials: 'omit', token: 'own-connection-token' },
  ]);
});

test('every profile write, saves and clears, asks for its own connection', async (t) => {
  setup(t);
  const asked = [];
  const requestImpl = async (path, options) => {
    asked.push({ path, method: options.method, ownConnection: options.ownConnection });
    return { saved: true };
  };
  const storage = { getItem: (key) => (key === KEY ? '[]' : null) };
  await saveProfileHandoff({ storage, requestImpl });
  await clearProfileHandoff({ requestImpl });
  assert.deepEqual(asked, [
    { path: '/api/v1/profile/preferences', method: 'POST', ownConnection: true },
    { path: '/api/v1/profile/preferences', method: 'POST', ownConnection: true },
  ]);
});

test('the stream registration for Play is answered while six slow catalogue requests hold the browser\'s connections', async (t) => {
  setup(t);
  const pool = browserConnections((path) => {
    if (path === '/api/v1/session') return json(200, { ok: true, data: { token: 'pool-token' } });
    if (path === '/api/v1/media/register') {
      return json(201, { ok: true, data: { media_id: 'pool_media_1234567890', relay_url: '/api/v1/media/pool_media_1234567890' } });
    }
    return null; // catalogue pages and feeds from slow outside servers
  });
  await getControlSession({ fetchImpl: pool.fetch });
  for (let index = 0; index < 6; index += 1) {
    void controlRequest('/api/v1/catalog/feed/resolve', { fetchImpl: pool.fetch, method: 'POST', body: { url: `https://feeds.example/${index}` } });
  }
  await drain();
  const episode = {
    id: 'gpodder:episode-902', title: 'Episode', source: 'gpodder', type: 'audio', stream_kind: 'audio',
    stream_url: 'https://media.example/episode-902.mp3', delivery: 'on-demand', capture_headers: {},
  };
  const relay = await registerMedia(episode, { fetchImpl: pool.fetch });
  assert.equal(relay.media_id, 'pool_media_1234567890');
  assert.deepEqual(pool.sent.filter((entry) => entry.path === '/api/v1/media/register'),
    [{ path: '/api/v1/media/register', credentials: 'omit' }]);
});

test('a profile save is answered while six slow catalogue requests hold the browser\'s connections', async (t) => {
  setup(t);
  const pool = browserConnections((path) => {
    if (path === '/api/v1/session') return json(200, { ok: true, data: { token: 'pool-token' } });
    if (path === '/api/v1/profile/preferences') return json(200, { ok: true, data: { saved: true, keys: [KEY] } });
    return null; // a catalogue request that takes longer than the save may wait
  });
  // The session token is fetched first, then the catalogue takes all six.
  await getControlSession({ fetchImpl: pool.fetch });
  for (let index = 0; index < 6; index += 1) {
    void controlRequest('/api/v1/catalog/feed/resolve', { fetchImpl: pool.fetch, method: 'POST', body: { url: `https://feeds.example/${index}` } });
  }
  void controlRequest('/api/v1/jobs', { fetchImpl: pool.fetch });
  await drain();
  let outcome = 'waiting';
  saveProfileHandoff({ storage: { getItem: (key) => (key === KEY ? '[]' : null) }, fetchImpl: pool.fetch }).then(
    (result) => { outcome = result.saved ? 'saved' : 'not saved'; },
    (error) => { outcome = error.code || error.message; },
  );
  await drain();
  mock.timers.tick(PROFILE_REQUEST_TIMEOUT_MS);
  await drain();
  assert.equal(outcome, 'saved');
  assert.deepEqual(pool.sent.filter((entry) => entry.path === '/api/v1/profile/preferences'),
    [{ path: '/api/v1/profile/preferences', credentials: 'omit' }]);
});
