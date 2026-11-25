import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom } from './helpers/fake-dom.js';
import { getState, setCurrentItem } from '../src/lib/state.js';
import { STATION_STREAMS_KEY } from '../src/lib/station-stream-addresses.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { initCaptureUi } from '../src/lib/capture-ui.js';
import { RECONNECT_DELAYS_MS } from '../src/lib/live-resume.js';
import { MEDIA_PROBE_TIMEOUT_MS } from '../src/lib/media-failover.js';
import { RETIRED_SOURCE_MESSAGE } from '../src/lib/sources.js';

// A test awaiting work that never settles must fail, not hang `npm test`.
const TEST_TIMEOUT_MS = 20_000;

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

const envelope = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ ok: true, data, error: null }),
});

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

/** A saved favourite whose details must be looked up before it can play,
 *  from a source the app no longer has. */
const retiredItem = () => ({
  id: 'library-of-congress:saved-1', title: 'A saved recording', description: '',
  source: 'library-of-congress', type: 'audio', stream_kind: 'audio', stream_url: '',
  delivery: 'on-demand', capture_headers: {}, thumbnail: '', country: '', language: '',
  _extra: { needsResolve: true },
});

const liveItem = () => ({
  id: 'test-live:capture', title: 'Station capture', description: '', source: 'radio-browser',
  type: 'radio', stream_kind: 'audio', stream_url: 'https://radio.example/capture',
  delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
  country: '', language: '', _extra: { streamCandidates: [] },
});

async function setup(t, { failedAddress, beforeRegister } = {}) {
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    favorites: getState().favorites,
  };
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  const win = new EventTarget();
  win.setTimeout = () => 0; // capture polling stays off; tests call refresh()
  win.clearTimeout = () => {};
  globalThis.document = document;
  globalThis.window = win;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const registrations = [];
  const records = [];
  const expired = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'capture-token' });
    if (path === '/api/v1/jobs') return envelope(200, { jobs: [] });
    if (path === '/api/v1/ffmpeg/status') return envelope(200, { state: 'ready' });
    if (path === '/api/v1/media/register') {
      const body = JSON.parse(options.body);
      const number = registrations.push(body);
      await beforeRegister?.(number, options.signal);
      const id = `capture_media_${String(number).padStart(12, '0')}`;
      if (body.url === failedAddress) {
        return { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'OFFLINE' } }) };
      }
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (path === '/api/v1/jobs/record') {
      records.push(JSON.parse(options.body));
      return envelope(202, { id: 'recording' });
    }
    if (String(path).endsWith('/expire')) {
      expired.push(path);
      return envelope(200, { expired: true });
    }
    if (path.startsWith('/api/v1/media/')) return new Response('probe bytes');
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  const player = await import(`../src/lib/player.js?capture=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  const capture = initCaptureUi({ fetchImpl: globalThis.fetch, confirmImpl: () => false });
  t.after(() => {
    try { player.stop(); } catch (_) {}
    capture?.destroy();
    setCurrentItem(null);
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    if (previous.sessionStorage) Object.defineProperty(globalThis, 'sessionStorage', previous.sessionStorage);
    else delete globalThis.sessionStorage;
    if (previous.localStorage) Object.defineProperty(globalThis, 'localStorage', previous.localStorage);
    else delete globalThis.localStorage;
    getState().favorites = previous.favorites;
  });
  await settle();
  return { player, elements, capture, storage, registrations, records, expired };
}

const captureLabel = (elements) => elements['player-capture-label'].textContent;
const captureBusy = (elements) => !elements['player-capture-progress'].hidden;

test('capture leaves a finite playlist backup unavailable for live recording', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const main = 'https://station.example/main.aac';
  const backup = 'https://backup.example/live.mp3';
  const { player, elements, capture, storage, registrations, records } = await setup(t, { failedAddress: main });
  const item = { ...liveItem(), source: 'playlist', stream_url: '', delivery: 'unknown',
    capture_headers: { userAgent: 'Original/1' }, _extra: { needsResolve: true } };
  getState().favorites = [item];
  storage.setItem(STATION_STREAMS_KEY, JSON.stringify({
    version: 1, stations: { [item.id]: { main, backups: [backup] } },
  }));
  await player.playItem(item);
  await settle();
  await capture.refresh();
  assert.equal(captureLabel(elements), 'Record audio');
  assert.equal(item.stream_url, '');

  const audio = elements['audio-el'];
  audio.duration = 3546;
  audio.emit('durationchange');
  assert.match(elements['player-capture-hint'].textContent, /This is a finite stream/);
  assert.equal(captureLabel(elements), 'Unavailable');

  elements['player-capture'].dispatchEvent(new Event('click'));
  await settle();
  assert.deepEqual(registrations.map((entry) => entry.url), [main, backup]);
  assert.deepEqual(records, []);
  item.download_url = backup;
  await capture.refresh();
  assert.equal(captureLabel(elements), 'Download');
});

for (const change of ['finite duration', 'different address', 'switching stations']) {
  test(`a pending recording expires its registration after ${change}`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const { promise, resolve } = Promise.withResolvers();
    const { promise: registered, resolve: onRegister } = Promise.withResolvers();
    const { player, elements, registrations, records, expired } = await setup(t, {
      beforeRegister: (number) => {
        if (number === 2) {
          onRegister();
          return promise;
        }
      },
    });
    const item = { ...liveItem(), delivery: 'unknown', source: 'playlist' };
    await player.playItem(item);
    elements['player-capture'].dispatchEvent(new Event('click'));
    await registered;
    if (change === 'finite duration') {
      elements['audio-el'].duration = 90;
      elements['audio-el'].emit('durationchange');
    } else if (change === 'different address') {
      setCurrentItem(item, { ...getState().currentStream, url: 'https://radio.example/backup' });
    } else {
      await player.playItem({ ...item, id: 'test-live:other', stream_url: 'https://radio.example/other' });
      await settle();
      assert.equal(elements['player-capture'].disabled, false);
    }
    resolve();
    await settle();
    assert.deepEqual(records, []);
    assert.equal(registrations[1].delivery, 'unknown');
    assert.ok(expired.includes('/api/v1/media/capture_media_000000000002/expire'));
    if (change !== 'switching stations') {
      assert.equal(elements['player-capture-status-text'].textContent, 'Playback changed. Recording cancelled.');
    }
  });
}

test('observing live delivery for a declared live station keeps a pending recording', async (t) => {
  const { promise, resolve } = Promise.withResolvers();
  const { promise: registered, resolve: onRegister } = Promise.withResolvers();
  const { player, elements, records } = await setup(t, {
    beforeRegister(number) {
      if (number === 2) {
        onRegister();
        return promise;
      }
    },
  });
  await player.playItem(liveItem());
  elements['player-capture'].dispatchEvent(new Event('click'));
  await registered;
  elements['audio-el'].duration = Infinity;
  elements['audio-el'].emit('durationchange');
  resolve();
  await settle();
  assert.equal(records.length, 1);
  assert.equal(records[0].delivery, 'live');
});

test('a same-address automatic reconnect keeps a pending recording', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { promise, resolve } = Promise.withResolvers();
  const { promise: registered, resolve: onRegister } = Promise.withResolvers();
  const { player, elements, registrations, records, expired } = await setup(t, {
    beforeRegister(number) {
      if (number === 2) {
        onRegister();
        return promise;
      }
    },
  });
  const item = liveItem();
  await player.playItem(item);
  const stream = getState().currentStream;
  const audio = elements['audio-el'];
  for (const time of [0.5, 1, 1.5]) {
    audio.currentTime = time;
    audio.emit('timeupdate');
  }
  elements['player-capture'].dispatchEvent(new Event('click'));
  await registered;
  audio.duration = Infinity;
  audio.emit('durationchange');
  audio.emit('error');
  await settle();
  t.mock.timers.tick(RECONNECT_DELAYS_MS[0]);
  await settle();
  assert.deepEqual(registrations.map(({ url }) => url), Array(3).fill(item.stream_url));
  assert.notEqual(getState().currentStream, stream);
  resolve();
  await settle();
  assert.equal(records.length, 1);
  assert.equal(records[0].delivery, 'live');
  assert.equal(records[0].media_id, 'capture_media_000000000002');
  assert.ok(!expired.includes('/api/v1/media/capture_media_000000000002/expire'));
});

test('an unanswered recording registration times out, freeing controls and releasing a late ID', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { promise, resolve } = Promise.withResolvers();
  const { promise: registered, resolve: onRegister } = Promise.withResolvers();
  const { player, elements, records, expired } = await setup(t, {
    beforeRegister(number, signal) {
      if (number === 2) {
        onRegister(signal);
        return promise;
      }
    },
  });
  await player.playItem(liveItem());
  const record = elements['player-capture'];
  record.dispatchEvent(new Event('click'));
  const signal = await registered;
  assert.equal(record.disabled, true);
  t.mock.timers.tick(MEDIA_PROBE_TIMEOUT_MS);
  await settle();
  assert.equal(record.disabled, false);
  assert.equal(signal?.aborted, true);
  assert.equal(captureBusy(elements), false);
  assert.deepEqual(records, []);

  resolve();
  await settle();
  assert.ok(expired.includes('/api/v1/media/capture_media_000000000002/expire'));
  assert.deepEqual(records, []);
});

test('an unknown playlist registration keeps its delivery until live is observed', async (t) => {
  const { player, elements, registrations, records } = await setup(t);
  const item = { ...liveItem(), source: 'playlist', delivery: 'unknown' };
  await player.playItem(item);
  elements['player-capture'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(registrations[1].delivery, 'unknown');
  assert.equal(records[0].delivery, 'unknown');

  elements['audio-el'].duration = Infinity;
  elements['audio-el'].emit('durationchange');
  elements['player-capture'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(registrations[2].delivery, 'live');
  assert.equal(records[1].delivery, 'live');
});

test('observing live media does not promote an ineligible release capture action', async (t) => {
  const { player, elements, registrations, records } = await setup(t);
  const item = { ...liveItem(), type: 'audio', source: 'playlist', delivery: 'unknown' };
  await player.playItem(item);
  const audio = elements['audio-el'];
  audio.duration = Infinity;
  audio.emit('durationchange');
  assert.equal(captureLabel(elements), 'Unavailable');
  elements['player-capture'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(registrations.length, 1);
  assert.deepEqual(records, []);
});

test('a Play that fails at the lookup ends "Checking…" in the capture controls', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, capture } = await setup(t);
  const item = retiredItem();
  await player.playItem(item);
  await settle();
  assert.equal(elements['player-source'].textContent, RETIRED_SOURCE_MESSAGE);
  await capture.refresh();
  assert.equal(captureLabel(elements), 'Unavailable', 'the normal idle state, not Checking…');
  assert.equal(captureBusy(elements), false, 'no endless progress bar');

  // The next Play of the same item checks afresh while it resolves.
  setCurrentItem(item);
  assert.equal(captureLabel(elements), 'Checking…');
  await player.playItem(item);
  await settle();
  assert.equal(captureLabel(elements), 'Unavailable');

  // A later successful Play runs the capability check normally.
  await player.playItem(liveItem());
  await settle();
  await capture.refresh();
  assert.equal(captureLabel(elements), 'Record audio');
  assert.equal(captureBusy(elements), false);
  player.stop();
});
