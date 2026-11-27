import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { NOW_PLAYING_FIRST_POLL_MS, NOW_PLAYING_POLL_MS } from '../src/lib/now-playing.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const TEST_TIMEOUT_MS = 20_000;

/** The rule `selector { ... }` at the top level of `css` (not in a media query). */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(found, selector);
  return found[1];
}

/** The size a `clamp(MINpx, Avw + Bpx, MAXpx)` font size gives at a window `width` px wide. */
function clampAt(value, width) {
  const parts = value.match(/clamp\((\d+(?:\.\d+)?)px, (\d+(?:\.\d+)?)vw \+ (\d+(?:\.\d+)?)px, (\d+(?:\.\d+)?)px\)/);
  assert.ok(parts, value);
  const [min, vw, px, max] = parts.slice(1).map(Number);
  return Math.round(Math.min(max, Math.max(min, (vw * width) / 100 + px)) * 10) / 10;
}

const fontSize = (body) => body.match(/font-size: ([^;]+);/)[1];

test('the song in the player bar is larger than the old source line and grows with the window', async () => {
  const css = await read('src/styles/base.css');
  const song = rule(css, '.player-source.is-song');
  const title = rule(css, '.player-title');
  assert.equal(fontSize(rule(css, '.player-source')), '12px', 'the plain source line is unchanged');
  assert.match(song, /font-weight: 600;/);
  assert.match(song, /color: var\(--text\);/);
  // Sizes at 1024, 1920 and 3840 px wide (CSS pixels).
  assert.deepEqual([1024, 1920, 3840].map((width) => clampAt(fontSize(song), width)), [14.1, 18.1, 22]);
  assert.deepEqual([1024, 1920, 3840].map((width) => clampAt(fontSize(title), width)), [14, 15.8, 18]);
  // 1024 x 640: no larger than the station name line by more than a pixel.
  assert.ok(clampAt(fontSize(song), 1024) - clampAt(fontSize(title), 1024) < 1);
  // Two lines at their largest fit the bar's fixed 80 px inner height.
  assert.ok(18 * 1.3 + 22 * 1.3 + 4 < 80);
  // Narrow windows keep the small sizes.
  const narrow = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(narrow, /\.player-source\.is-song \{ font-size: 13px; \}/);
});

test('a long song or station name still ends in an ellipsis', async () => {
  const [css, tunerCss] = await Promise.all([read('src/styles/base.css'), read('src/styles/tuner.css')]);
  assert.match(rule(tunerCss, '.tuner-frequency .station-name'), /-webkit-line-clamp: 2;/);
  for (const body of [rule(css, '.player-title'), rule(css, '.player-source')]) {
    assert.match(body, /white-space: nowrap;/);
    assert.match(body, /overflow: hidden;/);
    assert.match(body, /text-overflow: ellipsis;/);
  }
});

test('the Tuner dial\'s station name grows with the window too', async () => {
  const css = await read('src/styles/tuner.css');
  const name = rule(css, '.tuner-frequency .station-name');
  assert.equal(fontSize(name), 'clamp(12px, 3.6cqw, 18px)');
  assert.match(rule(css, '.tuner-frequency'), /width: var\(--dial-name-width, 32cqw\);/);
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /ui\.stationName\.setAttribute\('title', s\.title \|\| ''\);/);
});

/* ============ The player marks the song line ============ */

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

const envelope = (status, data) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => ({ ok: true, data }),
});

test('only a song makes the line large; the station name has its whole text on hover', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  elements['player-art-initials'] = document.register(new FakeElement('player-art-initials'));
  let song = null;
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaSession: { playbackState: 'none', metadata: null, setActionHandler() {} } },
  });
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'size-token' });
    if (path === '/api/v1/media/register') return envelope(201, { media_id: 'size_media_000000000001', relay_url: '/api/v1/media/size_media_000000000001' });
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    if (/\/now-playing$/.test(String(path))) return envelope(200, song || { title: null, changed_at: null });
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  let player = null;
  t.after(() => {
    try { player?.stop(); } catch (_) {}
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?songSize=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const source = elements['player-source'];
  const title = elements['player-title'];
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };

  const name = 'A station with a very long name that the player bar cannot show whole';
  await player.playItem({
    id: 'test-size:a', title: name, description: '', source: 'radio-browser', type: 'radio', stream_kind: 'audio',
    stream_url: 'https://radio.example/a', delivery: 'live', capture_headers: {},
    thumbnail: '/api/v1/assets/test_artwork_0001', country: '', language: '', _extra: { streamCandidates: [] },
  });
  await settle();
  assert.equal(title.textContent, name);
  assert.equal(title.title, name);
  assert.equal(source.classList.contains('is-song'), false);

  song = { title: 'Artist - A song with a long title', changed_at: 1_700_000_000 };
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.match(source.textContent, /Artist - A song with a long title$/);
  assert.equal(source.classList.contains('is-song'), true);
  assert.match(source.title, /^\u266A Artist - A song with a long title\n/);

  song = null;
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.classList.contains('is-song'), false, 'the plain line is plain again');
  song = { title: 'Second', changed_at: 1_700_000_100 };
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.classList.contains('is-song'), true);
  player.stop();
  assert.equal(source.classList.contains('is-song'), false);
});
