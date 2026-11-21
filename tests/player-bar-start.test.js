import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPlayerDom } from './helpers/fake-dom.js';
import { setCurrentItem } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { initCaptureUi } from '../src/lib/capture-ui.js';
import { hostLookupFailureMessage } from '../src/lib/media-failover.js';

// A test awaiting work that never settles must fail, not hang `npm test`.
const TEST_TIMEOUT_MS = 20_000;

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

function apiResponse(status, payload, headers = { 'content-type': 'application/json' }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, { status, headers });
}

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

function item(id, overrides = {}) {
  return {
    id, title: id, description: '', source: 'radio-browser', type: 'radio', stream_kind: 'audio',
    stream_url: `https://media.example/live/${id.replace(/\W/g, '-')}`, delivery: 'live',
    capture_headers: {}, thumbnail: '', country: '', language: '', tags: [],
    _extra: { streamCandidates: [] },
    ...overrides,
  };
}

/** The real player and capture controls on a fake page. `server.failWith`:
 *  an error code the relay answers registrations with ('' for none). */
async function setup(t) {
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  const win = new EventTarget();
  win.setTimeout = () => 0; // capture polling stays off
  win.clearTimeout = () => {};
  globalThis.document = document;
  globalThis.window = win;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const server = { failWith: '', registrations: 0 };
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return apiResponse(200, { ok: true, data: { token: 'bar-start-token' }, error: null });
    if (path === '/api/v1/jobs') return apiResponse(200, { ok: true, data: { jobs: [] }, error: null });
    if (path === '/api/v1/ffmpeg/status') return apiResponse(200, { ok: true, data: { state: 'ready' }, error: null });
    if (path === '/api/v1/media/register' && options.method === 'POST') {
      server.registrations += 1;
      if (server.failWith) {
        return apiResponse(502, {
          ok: false, data: null, error: { code: server.failWith, message: 'Media host name does not exist.', retryable: true },
        });
      }
      const id = `bar_start_media_${String(server.registrations).padStart(12, '0')}`;
      return apiResponse(201, { ok: true, data: { media_id: id, relay_url: `/api/v1/media/${id}` }, error: null });
    }
    if (String(path).endsWith('/expire')) return apiResponse(202, { ok: true, data: { state: 'expired' }, error: null });
    // The relay's answer to the HLS test request: a live media playlist.
    if (String(path).startsWith('/api/v1/media/bar_start_media_')) {
      return apiResponse(200, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n', { 'content-type': 'application/vnd.apple.mpegurl' });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  const player = await import(`../src/lib/player.js?barstart=${Date.now()}-${Math.random()}`);
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
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
  });
  await settle();
  return { player, elements, server };
}

/** Records what the bar shows each time the player draws it (the draw ends
 *  by telling Media Session its state): [{ seekShown, lengthShown, time }]. */
function watchBar(elements) {
  const steps = [];
  let state = 'none';
  const mediaSession = {
    setActionHandler() {},
    get playbackState() { return state; },
    set playbackState(value) {
      state = value;
      steps.push({
        seekShown: !elements['player-seek'].classList.contains('is-no-length'),
        lengthShown: !elements['player-dur'].classList.contains('is-no-length'),
        live: elements['player-seek'].classList.contains('is-live'),
        time: elements['player-time'].textContent,
      });
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
  return { steps, reset: () => { steps.length = 0; } };
}

const seekShown = (elements) => !elements['player-seek'].classList.contains('is-no-length');

test('from the press of Play to playing, live radio and live HLS never show a seek bar or "--:--", and on-demand media never loses it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements } = await setup(t);
  const bar = watchBar(elements);
  // HLS played by the page's own player (hls.js cannot run here).
  elements['video-el'].canPlayType = () => 'maybe';

  for (const live of [
    item('radio-browser:bar-start-radio'),
    item('iptv-org:bar-start-tv', {
      source: 'iptv-org', type: 'tv', stream_kind: 'hls', stream_url: 'https://media.example/live/tv/index.m3u8',
    }),
  ]) {
    bar.reset();
    await player.playItem(live);
    await settle();
    const target = live.stream_kind === 'hls' ? elements['video-el'] : elements['audio-el'];
    assert.equal(target.paused, false, `${live.id} plays`);
    assert.ok(bar.steps.length > 0, `${live.id}: the bar was drawn while it started`);
    for (const [index, step] of bar.steps.entries()) {
      assert.equal(step.seekShown, false, `${live.id} step ${index}: no seek bar`);
      assert.equal(step.lengthShown, false, `${live.id} step ${index}: no length`);
      assert.equal(step.live, true, `${live.id} step ${index}: the live layout`);
      assert.notEqual(step.time, '--:--', `${live.id} step ${index}: the time played`);
    }
    assert.match(elements['player-time'].textContent, /^0:0\d$/);
  }

  // An audio recording listed as on demand keeps its seek bar at every step
  // from the press of Play to playing, disabled until its length is known.
  const episode = item('internet-archive:bar-start-episode', {
    source: 'internet-archive', type: 'audio', stream_kind: 'audio', delivery: 'on-demand',
    stream_url: 'https://media.example/shows/episode-one.mp3',
  });
  bar.reset();
  await player.playItem(episode);
  await settle();
  const audio = elements['audio-el'];
  assert.equal(audio.paused, false, 'the episode plays');
  assert.ok(Number.isNaN(audio.duration), 'its length is not known yet');
  assert.ok(bar.steps.length > 0, 'the bar was drawn while it started');
  for (const [index, step] of bar.steps.entries()) {
    assert.equal(step.seekShown, true, `episode step ${index}: the seek bar shows`);
    assert.equal(step.lengthShown, true, `episode step ${index}: the length label shows`);
    assert.equal(step.live, false, `episode step ${index}: the layout with a seek bar`);
  }
  assert.equal(elements['player-seek'].disabled, true, 'disabled while the length is unknown');
  assert.equal(elements['player-dur'].textContent, '--:--');
  audio.duration = 465.6;
  audio.emit('durationchange');
  assert.equal(seekShown(elements), true);
  assert.equal(elements['player-seek'].disabled, false, 'movable once the length is known');
  assert.equal(elements['player-dur'].textContent, '7:45');
  assert.ok(bar.steps.every((step) => step.seekShown), 'never hidden in between');

  // A film listed as on demand still gets its seek bar once its length is known.
  const film = item('internet-archive:bar-start-film', {
    source: 'internet-archive', type: 'video', stream_kind: 'video', delivery: 'on-demand',
    stream_url: 'https://media.example/films/film.mp4',
  });
  await player.playItem(film);
  elements['video-el'].duration = 3906;
  elements['video-el'].emit('durationchange');
  assert.equal(seekShown(elements), true);
  assert.equal(elements['player-dur'].textContent, '1:05:06');

  // An on-demand item whose length turns out to be endless has no dead seek bar.
  elements['video-el'].duration = Infinity;
  elements['video-el'].emit('durationchange');
  assert.equal(seekShown(elements), false);

  // With no item at all the bar looks as before.
  player.stop();
  assert.equal(seekShown(elements), true);
  assert.equal(elements['player-seek'].classList.contains('is-live'), false);
  assert.equal(elements['player-time'].textContent, '--:--');
});

test('a wide bar gives the seek bar\'s room to the name column only for live media', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const css = (await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = css.indexOf('/* Wide bar, live media');
  assert.ok(start > 0, 'the live layout rules exist');
  const block = css.slice(start, css.indexOf('\n}\n', start) + 3);
  const live = '.player-bar:not(.is-capture-only):has(> .player-progress > #player-seek.is-live)';
  assert.match(block, /^\/\* Wide bar, live media[\s\S]*?\*\/\n@media \(min-width: 1001px\) \{/);
  // The progress cell sizes to the meter and the time; the name column (the
  // only flexible one) takes the rest. Every other column is as before.
  assert.ok(block.includes(`${live} {\n    grid-template-columns: minmax(clamp(190px, 75vw - 760px, 1400px), 1.1fr) auto auto auto auto;`));
  assert.match(css, /grid-template-columns: minmax\(clamp\(190px, 75vw - 760px, 1400px\), 1\.1fr\) auto auto minmax\(180px, 1\.5fr\) auto;/);
  assert.ok(block.includes(`${live} .player-progress {`) && /container-type: normal;/.test(block));
  // The meter stays (the setting still hides it: .player-meter[hidden] wins).
  assert.ok(block.includes(`${live} #player-meter {`) && /display: block;\s+flex: none;/.test(block));
  assert.match(css, /\.player-meter\[hidden\] \{ display: none !important; \}/);
  assert.ok(block.includes(`${live} .player-time { flex-shrink: 0; }`));
  assert.ok(block.includes(`${live} #player-seek,`) && block.includes(`${live} #player-dur { display: none; }`));
  // The stacked bar of a narrow window is not touched.
  assert.doesNotMatch(block, /max-width/);

  const { player, elements } = await setup(t);
  const isLive = () => elements['player-seek'].classList.contains('is-live');
  // Not listed as live or on demand, length not known yet: the layout with a
  // seek bar (hidden), so nothing moves if it turns out to be a recording...
  const unlisted = item('playlist:bar-start-unlisted', {
    source: 'playlist', type: 'audio', delivery: '', stream_url: 'https://media.example/shows/unlisted.mp3',
  });
  await player.playItem(unlisted);
  await settle();
  assert.equal(seekShown(elements), false);
  assert.equal(isLive(), false);
  // ...and the live layout once its length is endless.
  elements['audio-el'].duration = Infinity;
  elements['audio-el'].emit('durationchange');
  assert.equal(isLive(), true);
});

test('a live start that failed shows no seek bar, says why, and keeps a working Play in the bar', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, server } = await setup(t);
  const bar = watchBar(elements);
  const station = item('radio-browser:bar-start-dead');
  server.failWith = 'MEDIA_HOST_NOT_FOUND';
  await player.playItem(station);
  await settle();
  assert.equal(elements['player-source'].textContent, "This station's address does not exist. Press Play to retry.");
  for (const [index, step] of bar.steps.entries()) {
    assert.equal(step.seekShown, false, `step ${index}: no seek bar`);
    assert.notEqual(step.time, '--:--', `step ${index}: no placeholder time`);
  }
  assert.equal(seekShown(elements), false);
  assert.equal(elements['player-time'].textContent, '0:00');

  // Play stays in the bar and starts the item again, as the message says.
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-play'].disabled, false);
  server.failWith = '';
  const before = server.registrations;
  elements['player-play'].dispatchEvent(new Event('click'));
  await settle();
  assert.ok(server.registrations > before, 'a new connection');
  assert.equal(elements['audio-el'].paused, false, 'it plays');
  assert.equal(player.getCurrentItem().id, station.id);

  // A name that could not be looked up at all says to check the connection.
  server.failWith = 'MEDIA_DNS_FAILED';
  await player.playItem(item('radio-browser:bar-start-offline'));
  await settle();
  assert.equal(
    elements['player-source'].textContent,
    "This stream's address could not be looked up. Check your internet connection, then press Play to retry.",
  );
  assert.equal(elements['player-play'].hidden, false);

  // Other relay failures keep their text.
  server.failWith = 'RELAY_UNAVAILABLE';
  await player.playItem(item('radio-browser:bar-start-relay'));
  await settle();
  assert.match(elements['player-source'].textContent, /^Secure media relay unavailable\. Press Play on the item to retry\.$/);
});

test('a start that failed offers no recording until the item plays; playing or paused media keeps it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, server } = await setup(t);
  const record = elements['player-capture'];
  const status = () => elements['player-capture-status-text'].textContent;
  const station = item('radio-browser:bar-start-dead-record');
  server.failWith = 'MEDIA_HOST_NOT_FOUND';
  await player.playItem(station);
  await settle();
  assert.equal(elements['player-capture-label'].textContent, 'Record audio');
  assert.equal(record.disabled, true, 'nothing attached, nothing to record');
  assert.equal(record.dataset.action, '');
  assert.equal(status(), 'Recording is available once this item plays.');

  // Play again: it plays, and recording is offered as before.
  server.failWith = '';
  elements['player-play'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(elements['audio-el'].paused, false, 'it plays');
  assert.equal(record.disabled, false);
  assert.equal(record.dataset.action, 'record');
  assert.equal(status(), 'Live media can be recorded.');

  // Paused media can still be recorded.
  elements['player-play'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(elements['audio-el'].paused, true, 'paused');
  assert.equal(record.disabled, false);
  assert.equal(record.dataset.action, 'record');
  assert.equal(status(), 'Live media can be recorded.');
});

test('an address that does not exist is worded for a station, an episode, or another item', () => {
  const missing = Object.assign(new Error('Media host name does not exist.'), { code: 'MEDIA_HOST_NOT_FOUND' });
  const lookup = Object.assign(new Error('Media host could not be resolved.'), { code: 'MEDIA_DNS_FAILED' });
  const refused = Object.assign(new Error('refused'), { code: 'MEDIA_CONNECT_FAILED' });
  assert.equal(hostLookupFailureMessage(missing, { type: 'tv' }), "This station's address does not exist. Press Play to retry.");
  assert.equal(
    hostLookupFailureMessage(missing, { type: 'audio', tags: ['podcast'] }),
    "This episode's address does not exist. Press Play to retry.",
  );
  assert.equal(hostLookupFailureMessage(missing, { type: 'video' }), "This item's address does not exist. Press Play to retry.");
  // Every stream tried must have failed that way.
  assert.equal(hostLookupFailureMessage({ code: 'MEDIA_CANDIDATES_UNAVAILABLE', errors: [missing, missing] }, { type: 'radio' }),
    "This station's address does not exist. Press Play to retry.");
  assert.match(hostLookupFailureMessage({ errors: [missing, lookup] }, { type: 'radio' }), /could not be looked up/);
  assert.equal(hostLookupFailureMessage({ errors: [missing, refused] }, { type: 'radio' }), '');
  assert.equal(hostLookupFailureMessage(refused, { type: 'radio' }), '');
  assert.equal(hostLookupFailureMessage(null, null), '');
});

test('a playlist entry listed as a station that plays an MP3 is not called live once it is a recording', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements } = await setup(t);
  const status = () => elements['player-capture-status-text'].textContent;
  const entry = item('playlist:bar-start-mp3', {
    source: 'playlist', stream_url: 'https://media.example/shows/chapter-two.mp3',
  });
  await player.playItem(entry);
  await settle();
  assert.equal(seekShown(elements), false, 'no length known yet');
  assert.equal(status(), 'Live media can be recorded.');
  const audio = elements['audio-el'];
  audio.duration = 3546;
  audio.emit('durationchange');
  assert.equal(seekShown(elements), true, 'the seek bar decision: a recording');
  assert.equal(status(), 'This stream can be recorded.');

  // A live station keeps its wording.
  await player.playItem(item('radio-browser:bar-start-live'));
  await settle();
  audio.duration = Infinity;
  audio.emit('durationchange');
  assert.equal(status(), 'Live media can be recorded.');
});
