import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom } from './helpers/fake-dom.js';
import { setCurrentItem } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { initCaptureUi } from '../src/lib/capture-ui.js';
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

async function setup(t) {
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  };
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  const win = new EventTarget();
  win.setTimeout = () => 0; // capture polling stays off; tests call refresh()
  win.clearTimeout = () => {};
  globalThis.document = document;
  globalThis.window = win;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  let registrations = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'capture-token' });
    if (path === '/api/v1/jobs') return envelope(200, { jobs: [] });
    if (path === '/api/v1/ffmpeg/status') return envelope(200, { state: 'ready' });
    if (path === '/api/v1/media/register') {
      registrations++;
      const id = `capture_media_${String(registrations).padStart(12, '0')}`;
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
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
  });
  await settle();
  return { player, elements, capture };
}

const captureLabel = (elements) => elements['player-capture-label'].textContent;
const captureBusy = (elements) => !elements['player-capture-progress'].hidden;

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
