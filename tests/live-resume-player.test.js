import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPlayerDom } from './helpers/fake-dom.js';
import { emit, getState } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import {
  RECONNECTING_TEXT, RECONNECT_GAVE_UP_TEXT, RECONNECT_STOPPED_TEXT, RECONNECT_WINDOW_MS,
} from '../src/lib/live-resume.js';
import { MEDIA_REGISTRY_FULL_MESSAGE } from '../src/lib/media-failover.js';
import { ACTIVE_RELAY_KEY } from '../src/lib/relay-memory.js';

// A test awaiting work that never settles must fail, not hang `npm test`:
// the runner's stdio pipes keep a child process alive indefinitely.
const TEST_TIMEOUT_MS = 20_000;

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ ok: !error, data, error }),
});

function liveItem(id, overrides = {}) {
  return {
    id: `test-live:${id}`, title: `Station ${id}`, description: '', source: 'radio-browser',
    type: 'radio', stream_kind: 'audio', stream_url: `https://radio.example/${id}`,
    // Already a local artwork relay URL, so no background artwork lookup (with
    // its own retry timers) is started by the player bar.
    delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
    country: '', language: '',
    _extra: { streamCandidates: [] },
    ...overrides,
  };
}

async function setup(t, { storage = new MemoryStorage() } = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  const win = new EventTarget();
  const net = {
    mode: 'ok', expireMode: 'ok', registrations: 0, expired: [], held: [], keepalive: [],
  };
  globalThis.document = document;
  globalThis.window = win;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  const mediaActions = new Map();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaSession: {
        playbackState: 'none',
        setActionHandler(name, handler) { mediaActions.set(name, handler); },
      },
    },
  });
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'live-resume-token' });
    if (path === '/api/v1/media/register') {
      net.registrations++;
      const id = `live_media_${String(net.registrations).padStart(12, '0')}`;
      const ok = envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
      if (net.mode === 'down') {
        return envelope(502, null, { code: 'MEDIA_CONNECT_FAILED', message: 'Upstream failed.', retryable: true });
      }
      if (net.mode === 'full') {
        return envelope(503, null, { code: 'MEDIA_REGISTRY_FULL', message: 'Media relay is temporarily full.', retryable: true });
      }
      if (net.mode === 'hold') return new Promise((resolve) => net.held.push(() => resolve(ok)));
      return ok;
    }
    if (String(path).endsWith('/expire')) {
      const id = String(path).split('/')[4];
      net.expired.push(id);
      if (options.keepalive) net.keepalive.push(id);
      const ok = envelope(200, { expired: true });
      if (net.expireMode === 'fail') throw new TypeError('Failed to fetch');
      if (net.expireMode === 'hold') return new Promise((resolve) => net.held.push(() => resolve(ok)));
      return ok;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  let player = null;
  t.after(() => {
    // Leave nothing behind, also when the test failed part-way: stop the
    // player (its timers, attempts and episode), release held requests so no
    // async chain is left waiting, and switch the network off for any late
    // work. Mock timers are restored by the test runner itself.
    net.mode = 'down';
    try { player?.stop(); } catch (_) {}
    while (net.held.length) net.held.shift()();
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?liveResume=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const audio = elements['audio-el'];
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  /** Real playback: the playhead moves forward in small steps. */
  const progress = (seconds = 1.5) => {
    for (let moved = 0; moved < seconds; moved += 0.5) {
      audio.currentTime += 0.5;
      audio.emit('timeupdate');
    }
  };
  /** Drop the connection; the reconnecting state follows a microtask later. */
  const drop = async (type = 'error') => {
    audio.emit(type);
    await settle();
  };
  /** Play, move the playhead (real progress), then drop the connection. */
  const playThenDrop = async (item) => {
    await player.playItem(item);
    await settle();
    progress();
    await drop();
  };
  return {
    player, elements, audio, net, win, storage, tick, progress, drop, playThenDrop, mediaActions,
  };
}

const sourceText = (elements) => elements['player-source'].textContent;

test('a live station that drops reconnects on the backoff and settles after stable play', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick, progress, drop, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('a'));
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(getState().isPlaying, false);
  assert.equal(elements['player-play'].hidden, false, 'Play stays available while reconnecting');
  assert.equal(elements['player-next-broken'].hidden, false, 'Try next stays available');
  const before = net.registrations;

  await tick(1999);
  assert.equal(net.registrations, before);
  await tick(1);
  assert.equal(net.registrations, before + 1, 'one rebuild after 2 s');
  assert.equal(getState().isPlaying, true);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(elements['player-next-broken'].hidden, true);

  // Stable for 30 s: the episode ends, so the next drop starts again at 2 s.
  await tick(30_000);
  progress();
  await drop();
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  await tick(2000);
  assert.equal(net.registrations, before + 2);
  assert.equal(getState().isPlaying, true);
  player.stop();
});

test('a brief recovery keeps the same episode and the next wait is longer', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, net, tick, drop, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('brief'));
  await tick(2000);
  const afterFirst = net.registrations;
  await tick(5000); // playing again, but only for 5 s
  await drop();
  await tick(2000);
  assert.equal(net.registrations, afterFirst, 'not at 2 s: the episode continues');
  await tick(2000);
  assert.equal(net.registrations, afterFirst + 1, 'the second wait is 4 s');
  player.stop();
});

test('a station that never started, and an on-demand item, keep the immediate broken state', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);
  await player.playItem(liveItem('dead'));
  await settle();
  audio.emit('error'); // no playhead progress in this session
  assert.equal(sourceText(elements), 'Playback error');
  assert.equal(elements['player-next-broken'].hidden, false);
  const afterDead = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterDead);

  await playThenDrop(liveItem('vod', { delivery: 'on-demand', stream_url: 'https://media.example/show.mp3' }));
  assert.equal(sourceText(elements), 'Playback error');
  const afterVod = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterVod);
  player.stop();
});

test('an unbounded stream without a declared delivery still counts as live', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, progress, drop } = await setup(t);
  await player.playItem(liveItem('unknown', { delivery: 'unknown' }));
  audio.duration = Infinity;
  audio.emit('durationchange');
  progress();
  await drop('ended'); // an Icecast stream "ends" when its connection closes
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  const before = net.registrations;
  await tick(2000);
  assert.equal(net.registrations, before + 1);
  audio.duration = Number.NaN;
  player.stop();
});

test('Stop, switching, pause and the sleep timer cancel queued and running attempts', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);

  await playThenDrop(liveItem('stop'));
  player.stop();
  const afterStop = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterStop, 'Stop cancels the queued attempt');

  await playThenDrop(liveItem('switch-from'));
  const other = liveItem('switch-to');
  await player.playItem(other);
  const afterSwitch = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterSwitch, 'switching cancels the queued attempt');
  assert.equal(player.getCurrentItem().id, other.id);

  // A running attempt that finishes late must not restart the old station.
  await playThenDrop(liveItem('late'));
  net.mode = 'hold';
  await tick(2000);
  assert.equal(net.held.length, 1);
  player.stop();
  net.held.shift()();
  await settle();
  assert.equal(player.getCurrentItem(), null);
  assert.equal(audio.paused, true);
  assert.equal(getState().isPlaying, false);
  assert.ok(net.expired.includes(`live_media_${String(net.registrations).padStart(12, '0')}`),
    'the late registration is released');
  net.mode = 'ok';

  // The sleep timer stops a waiting episode and leaves a plain Play-to-retry state.
  await playThenDrop(liveItem('sleep'));
  emit('sleep-fired');
  assert.equal(sourceText(elements), RECONNECT_STOPPED_TEXT);
  const afterSleep = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterSleep);
  assert.equal(elements['player-play'].hidden, false);

  // A user pause while the reconnected stream is settling ends the episode.
  await playThenDrop(liveItem('pause'));
  await tick(2000);
  assert.equal(getState().isPlaying, true);
  await player.togglePlay();
  assert.equal(audio.paused, true);
  const afterPause = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, afterPause);
  player.stop();
});

test('Play during the wait tries at once; online is rate-limited; one attempt at a time', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, net, win, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('press'));
  const before = net.registrations;
  await player.togglePlay();
  await settle();
  assert.equal(net.registrations, before + 1, 'Play runs the attempt now');
  assert.equal(getState().isPlaying, true);

  // Repeated `online` events between failures: nothing before 2 s have passed
  // since the episode began or the last attempt finished.
  await playThenDrop(liveItem('online'));
  const beforeOnline = net.registrations;
  for (let i = 0; i < 5; i++) win.dispatchEvent(new Event('online'));
  await tick(1000);
  for (let i = 0; i < 5; i++) win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(net.registrations, beforeOnline, 'a flapping connection does not start rebuilds');
  net.mode = 'down';
  await tick(1000); // the scheduled first attempt fails; the next wait is 4 s
  assert.equal(net.registrations, beforeOnline + 1);
  for (let i = 0; i < 5; i++) win.dispatchEvent(new Event('online'));
  await tick(1000);
  for (let i = 0; i < 5; i++) win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(net.registrations, beforeOnline + 1, 'still nothing within 2 s of that failure');
  await tick(1000);
  net.mode = 'hold';
  win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(net.registrations, beforeOnline + 2, 'online brings the attempt forward once 2 s have passed');
  win.dispatchEvent(new Event('online'));
  // Choosing the same station again joins the running attempt (it resolves with it).
  const joined = player.playItem(liveItem('online'));
  await settle();
  assert.equal(net.registrations, beforeOnline + 2, 'no second attempt while one is running');
  net.mode = 'ok';
  net.held.shift()();
  await joined;
  await settle();
  assert.equal(getState().isPlaying, true);
  await tick(1000);
  player.stop();
});

test('NotAllowedError and a full relay end the episode instead of retrying', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('autoplay'));
  audio.playError = new DOMException('Autoplay blocked', 'NotAllowedError');
  await tick(2000);
  assert.equal(sourceText(elements), 'Playback did not start. Press Play to retry.');
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-play'].disabled, false);
  const afterBlocked = net.registrations;
  await tick(RECONNECT_WINDOW_MS);
  assert.equal(net.registrations, afterBlocked);
  audio.playError = null;

  await playThenDrop(liveItem('full'));
  net.mode = 'full';
  await tick(2000);
  assert.equal(sourceText(elements), MEDIA_REGISTRY_FULL_MESSAGE);
  // The media is gone, but Play stays so the user can retry by hand.
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-play'].disabled, false);
  const afterFull = net.registrations;
  await tick(RECONNECT_WINDOW_MS);
  assert.equal(net.registrations, afterFull);
  net.mode = 'ok';
  player.stop();
});

test('after ten minutes without a connection the player gives up with Play to retry', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('gone'));
  const before = net.registrations;
  net.mode = 'down';
  for (let elapsed = 0; elapsed <= RECONNECT_WINDOW_MS + 60_000; elapsed += 1000) await tick(1000);
  const attempts = net.registrations - before;
  assert.ok(attempts >= 10 && attempts <= 25, `${attempts} attempts`);
  assert.equal(sourceText(elements), RECONNECT_GAVE_UP_TEXT);
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-play'].disabled, false);
  await tick(10 * 60_000);
  assert.equal(net.registrations - before, attempts);
  // Play afterwards is the ordinary full rebuild.
  net.mode = 'ok';
  await player.togglePlay();
  await settle();
  assert.equal(getState().isPlaying, true);
  player.stop();
});

test('the playback relay id is remembered for a reload and a leftover is released once', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const storage = new MemoryStorage();
  storage.setItem(ACTIVE_RELAY_KEY, 'leftover_media_000000000001');
  const { player, net, win } = await setup(t, { storage });
  assert.deepEqual(net.expired, ['leftover_media_000000000001']);
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);

  await player.playItem(liveItem('remember'));
  await settle();
  const active = `live_media_${String(net.registrations).padStart(12, '0')}`;
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), active);

  const pagehide = new Event('pagehide');
  pagehide.persisted = false;
  win.dispatchEvent(pagehide);
  await settle();
  assert.deepEqual(net.keepalive, [active], 'pagehide releases with keepalive');
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), active, 'kept for the next start in case it was lost');

  player.stop();
  await settle();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null);
});

test('a reconnected stream that stalls and never plays again counts as dropped', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('stall'));
  await tick(2000);
  const afterFirst = net.registrations;
  assert.equal(getState().isPlaying, true);
  await tick(10_000);
  audio.emit('waiting'); // buffering forever, and no error ever arrives
  await tick(19_999);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  await tick(1);
  assert.equal(sourceText(elements), RECONNECTING_TEXT, 'after 20 s it is treated as a new drop');
  await tick(4000); // the same episode: the next wait is 4 s
  assert.equal(net.registrations, afterFirst + 1);
  assert.equal(getState().isPlaying, true);
  player.stop();
});

test('a failure reported while an attempt is still settling makes that attempt fail', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('settling'));
  const before = net.registrations;
  // The rebuilt stream starts, then its connection closes before the attempt
  // has reported back. The element itself still looks unpaused.
  audio.duration = Infinity;
  const ordinaryPlay = audio.play;
  audio.play = async function failingAfterStart() {
    this.paused = false;
    this.emit('play');
    this.emit('playing');
    this.emit('ended');
  };
  await tick(2000);
  audio.play = ordinaryPlay;
  assert.equal(net.registrations, before + 1);
  assert.equal(sourceText(elements), RECONNECTING_TEXT, 'the attempt settled as failed, not ok');
  await tick(4000);
  assert.equal(net.registrations, before + 2);
  audio.duration = Number.NaN;
  player.stop();
});

test('a seek or a jump is not playback: only forward progress starts an episode', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick } = await setup(t);
  await player.playItem(liveItem('seeked'));
  await settle();
  audio.emit('seeking');
  audio.currentTime += 30;
  audio.emit('timeupdate');
  audio.emit('seeked');
  audio.emit('timeupdate');
  audio.currentTime += 5; // one jump with no seek events
  audio.emit('timeupdate');
  audio.emit('error');
  await settle();
  assert.equal(sourceText(elements), 'Playback error');
  const after = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, after);
  player.stop();
});

test('a failure queued just before the sleep timer fires never starts an episode', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('sleep-race'));
  await settle();
  progress();
  audio.emit('error'); // the reconnect transition is queued for a microtask
  audio.pause();
  emit('sleep-fired'); // ...and the sleep timer stops playback first
  await settle();
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(sourceText(elements), 'Playback error', 'the plain error, no reconnecting');
  const after = net.registrations;
  await tick(60_000);
  assert.equal(net.registrations, after);
  player.stop();
});

test('stalled alone (buffered media still playing) does not tear down a reconnected stream', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop } = await setup(t);
  await playThenDrop(liveItem('stalled-fetch'));
  await tick(2000);
  const after = net.registrations;
  await tick(5000);
  audio.emit('stalled'); // fetching paused; no `waiting`, no new `playing`
  await tick(25_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(getState().isPlaying, true);
  assert.equal(net.registrations, after);
  player.stop();
});

test('a remembered relay id is cleared only after its release succeeded', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const storage = new MemoryStorage();
  const { player, net } = await setup(t, { storage });
  const idAt = (n) => `live_media_${String(n).padStart(12, '0')}`;

  await player.playItem(liveItem('kept-a'));
  await settle();
  net.expireMode = 'fail';
  player.stop();
  await settle();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), idAt(net.registrations),
    'a lost release leaves the id for the next start');

  // A slow release of the old id must not clear the newer one stored meanwhile.
  net.expireMode = 'hold';
  await player.playItem(liveItem('kept-b'));
  await settle();
  const older = idAt(net.registrations);
  player.stop();
  await settle();
  net.expireMode = 'ok';
  await player.playItem(liveItem('kept-c'));
  await settle();
  const newer = idAt(net.registrations);
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), newer);
  while (net.held.length) net.held.shift()(); // the old release finally succeeds
  await settle();
  assert.ok(net.expired.includes(older));
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), newer, 'the newer id survives');

  player.stop();
  await settle();
  assert.equal(storage.getItem(ACTIVE_RELAY_KEY), null, 'cleared once its release succeeded');
});

test('throttled timeupdate events still count as real playback', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, tick } = await setup(t);
  await player.playItem(liveItem('throttled'));
  await settle();
  // A minimised window: one timeupdate after 5 s of real (mocked) time.
  await tick(5000);
  audio.currentTime += 5;
  audio.emit('timeupdate');
  audio.emit('error');
  await settle();
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  player.stop();
});

test('the Media Session play action rebuilds a stream whose media is gone, like the Play button', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, playThenDrop, mediaActions } = await setup(t);
  const sessionPlay = async () => { mediaActions.get('play')(); await settle(); };

  // After giving up: the last attempt tore the media down.
  await playThenDrop(liveItem('session-gave-up'));
  net.mode = 'down';
  for (let elapsed = 0; elapsed <= RECONNECT_WINDOW_MS + 60_000; elapsed += 5000) await tick(5000);
  assert.equal(sourceText(elements), RECONNECT_GAVE_UP_TEXT);
  assert.equal(audio.src, '', 'no source left');
  net.mode = 'ok';
  const beforeGaveUp = net.registrations;
  await sessionPlay();
  assert.equal(net.registrations, beforeGaveUp + 1, 'rebuilt through the full Play path');
  assert.equal(getState().isPlaying, true);

  // A waiting episode stopped by the sleep timer after a failed attempt.
  progress(audio);
  await drop(audio);
  net.mode = 'down';
  await tick(2000);
  emit('sleep-fired');
  assert.equal(sourceText(elements), RECONNECT_STOPPED_TEXT);
  assert.equal(audio.src, '');
  net.mode = 'ok';
  const beforeStopped = net.registrations;
  await sessionPlay();
  assert.equal(net.registrations, beforeStopped + 1);
  assert.equal(getState().isPlaying, true);

  // While waiting, it tries at once inside the episode, like the button.
  progress(audio);
  await drop(audio);
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  const beforeWaiting = net.registrations;
  await sessionPlay();
  assert.equal(net.registrations, beforeWaiting + 1);
  assert.equal(getState().isPlaying, true);
  player.stop();

  function progress() {
    for (let moved = 0; moved < 1.5; moved += 0.5) { audio.currentTime += 0.5; audio.emit('timeupdate'); }
  }
  async function drop() { audio.emit('error'); await settle(); }
});

/** An item whose details must be looked up first; the lookup throws `error`. */
function unresolvedItem(id, error) {
  const extra = { needsResolve: true };
  // The NASA adapter reads this before any network request, so the throw
  // stands in for an adapter that refuses at once (a source on hold, or one
  // the app no longer offers), without touching the network.
  Object.defineProperty(extra, 'manifestUrl', { enumerable: false, get() { throw error; } });
  return {
    id: `nasa:${id}`, title: `Item ${id}`, description: '', source: 'nasa',
    type: 'video', stream_kind: 'video', stream_url: '', delivery: 'on-demand',
    capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001', country: '', language: '',
    _extra: extra,
  };
}

test('a lookup refused with a plain message shows that message, as text, and starts nothing', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick } = await setup(t);
  const message = 'Example Archive is turning away requests <b>right now</b>. Try again later.';
  const refused = Object.assign(new Error('SOURCE_BLOCKED'), { userMessage: `  ${message}\n` });
  await player.playItem(unresolvedItem('held', refused));
  await settle();
  assert.equal(sourceText(elements), message, 'the plain message, markup left as text');
  assert.equal(elements['player-title'].textContent, 'Item held');
  assert.equal(elements['player-next-broken'].hidden, false, 'Try next stays offered');
  await tick(60_000);
  assert.equal(net.registrations, 0, 'no relay and no reconnect episode');
  assert.equal(sourceText(elements), message);

  const long = Object.assign(new Error('x'), { userMessage: 'word '.repeat(100) });
  await player.playItem(unresolvedItem('long', long));
  await settle();
  assert.equal(sourceText(elements).length, 240);
  assert.ok(sourceText(elements).endsWith('…'));
  player.stop();
});

test('a lookup failure without a plain message keeps "No stream URL"', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick } = await setup(t);
  for (const [id, error] of [
    ['plain', new Error('Upstream failed')],
    ['blank', Object.assign(new Error('x'), { userMessage: '   ' })],
    ['object', Object.assign(new Error('x'), { userMessage: { text: 'no' } })],
  ]) {
    await player.playItem(unresolvedItem(id, error));
    await settle();
    assert.equal(sourceText(elements), 'No stream URL', id);
  }
  await tick(60_000);
  assert.equal(net.registrations, 0);
  player.stop();
});

/** Record every title the player bar shows from now on. */
function recordTitles(element) {
  const shown = [];
  let value = element.textContent;
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get() { return value; },
    set(next) { value = next; shown.push(next); },
  });
  return shown;
}

test('Stop or a switch while a start still awaits audio resume never shows the old station', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net } = await setup(t);
  const stopped = player.playItem(liveItem('old'));
  player.stop(); // while that start awaits audioEngine.resume()
  await stopped;
  await settle();
  assert.equal(elements['player-bar'].hidden, true, 'Stop keeps the player bar hidden');
  assert.notEqual(elements['player-title'].textContent, 'Station old');
  assert.equal(net.registrations, 0);

  const first = player.playItem(liveItem('first'));
  const shown = recordTitles(elements['player-title']);
  const second = player.playItem(liveItem('second'));
  await Promise.all([first, second]);
  await settle();
  assert.equal(shown.includes('Station first'), false, `titles shown: ${shown.join(', ')}`);
  assert.equal(elements['player-title'].textContent, 'Station second');
  assert.equal(net.registrations, 1, 'only the new station registers');
  player.stop();
});

/** play() that reports `play` (and `playing`) at once but settles only when
 *  told, like a real element; pause() rejects a pending play() as a browser
 *  does, unless rejectOnPause is false (the test settles it by hand). */
function holdPlay(audio, { playingEvent = true, rejectOnPause = true } = {}) {
  const pending = [];
  audio.play = function play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
    if (playingEvent) this.dispatchEvent(new Event('playing'));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  audio.pause = function pause() {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event('pause'));
    while (rejectOnPause && pending.length) {
      const error = new Error('The play() request was interrupted by a call to pause().');
      error.name = 'AbortError';
      pending.shift().reject(error);
    }
  };
  return {
    get pending() { return pending.length; },
    reject(error) { while (pending.length) pending.shift().reject(error); },
    restore() {
      delete audio.play;
      delete audio.pause;
      while (pending.length) pending.shift().resolve();
    },
  };
}

for (const via of ['button', 'media-session']) {
  test(`pausing (${via}) a reconnect attempt that already plays pauses it and ends the episode`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const { player, elements, audio, net, tick, playThenDrop, mediaActions } = await setup(t);
    await playThenDrop(liveItem(`pause-${via}`));
    const held = holdPlay(audio);
    t.after(() => held.restore());
    await tick(2000);
    const registrations = net.registrations;
    assert.equal(held.pending, 1, 'the attempt is still settling its play()');
    assert.equal(audio.paused, false);
    assert.equal(getState().isPlaying, true, 'the button shows Pause');

    if (via === 'button') await player.togglePlay();
    else mediaActions.get('pause')();
    await settle();
    assert.equal(audio.paused, true, 'the click paused playback');
    assert.equal(getState().isPlaying, false);
    assert.equal(held.pending, 0);
    assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
    assert.notEqual(sourceText(elements), 'Playback did not start. Press Play to retry.');
    assert.equal(elements['player-next-broken'].hidden, true);
    assert.ok(audio.src, 'the stream is kept, only paused');
    await tick(RECONNECT_WINDOW_MS);
    assert.equal(net.registrations, registrations, 'the episode ended: no more attempts');

    held.restore();
    await player.togglePlay();
    await settle();
    assert.equal(audio.paused, false, 'Play resumes the kept stream');
    assert.equal(net.registrations, registrations, 'without rebuilding it');
    player.stop();
  });
}

test('pausing an attempt before `playing` arrives shows the station line, not "Reconnecting…"', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, tick, progress, drop } = await setup(t);
  await player.playItem(liveItem('status'));
  await settle();
  const normal = sourceText(elements);
  assert.notEqual(normal, RECONNECTING_TEXT);
  progress();
  await drop();
  const held = holdPlay(audio, { playingEvent: false });
  t.after(() => held.restore());
  await tick(2000);
  assert.equal(held.pending, 1);
  assert.equal(audio.paused, false);
  assert.equal(sourceText(elements), RECONNECTING_TEXT, 'only `play` so far');

  await player.togglePlay();
  await settle();
  assert.equal(audio.paused, true);
  assert.equal(sourceText(elements), normal);
  player.stop();
});

test('a pause racing the first play() hides only the interruption, not a real start failure', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio } = await setup(t);
  // A genuine failure that happens to settle the play() the user paused.
  let held = holdPlay(audio, { rejectOnPause: false });
  t.after(() => held.restore());
  const start = player.playItem(liveItem('race'));
  await settle();
  assert.equal(held.pending, 1);
  await player.togglePlay();
  const failure = new Error('The element has no supported sources.');
  failure.name = 'NotSupportedError';
  held.reject(failure);
  await start;
  await settle();
  assert.equal(sourceText(elements), 'Playback did not start. Press Play to retry.');

  // The pause's own interruption (AbortError) is not a failure.
  held.restore();
  held = holdPlay(audio);
  const paused = player.playItem(liveItem('paused'));
  await settle();
  assert.equal(held.pending, 1);
  await player.togglePlay();
  await paused;
  await settle();
  assert.equal(audio.paused, true);
  assert.notEqual(sourceText(elements), 'Playback did not start. Press Play to retry.');
  assert.equal(elements['player-next-broken'].hidden, true);
  player.stop();
});

test('the reconnect texts are short enough for the player bar column', () => {
  assert.equal(RECONNECTING_TEXT, 'Connection lost. Retrying…');
  assert.equal(RECONNECT_GAVE_UP_TEXT, "Can't reconnect. Press Play.");
  assert.equal(RECONNECT_STOPPED_TEXT, 'Connection lost. Press Play.');
});

test('a status or error line also shows in full on hover; the normal line clears it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick, playThenDrop } = await setup(t);
  const source = elements['player-source'];
  const hover = () => source.title;

  await playThenDrop(liveItem('hover'));
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(hover(), RECONNECTING_TEXT);
  await tick(2000); // reconnected
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(hover(), '', 'the normal source line has no tooltip');

  await playThenDrop(liveItem('hover-gone'));
  net.mode = 'down';
  for (let elapsed = 0; elapsed <= RECONNECT_WINDOW_MS + 60_000; elapsed += 1000) await tick(1000);
  assert.equal(sourceText(elements), RECONNECT_GAVE_UP_TEXT);
  assert.equal(hover(), RECONNECT_GAVE_UP_TEXT);

  net.mode = 'full';
  await player.togglePlay(); // the user's rebuild meets a full relay
  await settle();
  assert.equal(sourceText(elements), MEDIA_REGISTRY_FULL_MESSAGE);
  assert.equal(hover(), MEDIA_REGISTRY_FULL_MESSAGE);

  net.mode = 'ok';
  const message = 'Example Archive is turning away requests from apps right now <i>x</i>.';
  await player.playItem(unresolvedItem('hover-held', Object.assign(new Error('held'), { userMessage: message })));
  await settle();
  assert.equal(sourceText(elements), message);
  assert.equal(hover(), message, 'set as text, markup included literally');

  await player.playItem(liveItem('hover-normal'));
  await settle();
  assert.equal(hover(), '');
  player.stop();
});

/** Advance in 1 s steps, as real time passes: the stall watchdog samples on
 *  its own timer, and one big mock-timer jump would look like a late sample. */
const walk = async (tick, ms) => {
  for (let done = 0; done < ms; done += 1000) await tick(Math.min(1000, ms - done));
};

test('a plain live stream that freezes silently starts the reconnect episode after about 20 s', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('frozen'));
  await settle();
  progress(); // really playing; then the network path dies: no event at all
  const before = net.registrations;
  await walk(tick, 19_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT, 'not before 20 s');
  await walk(tick, 4_000);
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(getState().isPlaying, false);
  await walk(tick, 2_000);
  assert.equal(net.registrations, before + 1, 'the normal backoff: first attempt 2 s later');
  player.stop();
});

test('a frozen playhead that moves again, or a muted stream that plays, starts nothing', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('hiccup'));
  await settle();
  progress();
  await walk(tick, 16_000);
  progress(); // the browser recovered by itself before the watchdog fired
  await walk(tick, 16_000);
  audio.muted = true;
  audio.volume = 0;
  for (let i = 0; i < 30; i++) { await walk(tick, 2_000); progress(); }
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(net.registrations, 1);
  assert.equal(getState().isPlaying, true);
  player.stop();
});

test('a user pause and an on-demand item never trigger the stall watchdog', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('paused'));
  await settle();
  progress();
  await walk(tick, 5_000);
  await player.togglePlay(); // pause
  assert.equal(audio.paused, true);
  await walk(tick, 120_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(net.registrations, 1);

  await player.playItem(liveItem('vod', { delivery: 'on-demand', stream_url: 'https://media.example/talk.mp3' }));
  await settle();
  progress();
  await walk(tick, 120_000); // frozen, but on demand: never reconnect
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(net.registrations, 2);
  assert.equal(audio.paused, false);
  player.stop();
});

test('switching station clears the stall timer of the previous one', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('first'));
  await settle();
  progress(); // the watchdog runs for the first station
  await walk(tick, 12_000);
  await player.playItem(liveItem('second'));
  await settle();
  // The first station's 20 s passes: nothing, the second has not played yet.
  await walk(tick, 12_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(net.registrations, 2);
  // The second plays, then freezes: its own full 20 s from here.
  progress();
  await walk(tick, 18_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  await walk(tick, 5_000);
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  assert.equal(elements['player-title'].textContent, 'Station second');
  player.stop();
});

test('after a seek the stall watchdog watches again from where the playhead landed', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, audio, tick, progress } = await setup(t);
  await player.playItem(liveItem('seek'));
  await settle();
  progress();
  audio.currentTime += 30;
  audio.emit('seeking');
  await walk(tick, 30_000); // a long seek is not a stall
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT);
  audio.emit('seeked'); // lands on a frozen stream: no timeupdate, no playing
  await walk(tick, 19_000);
  assert.notEqual(sourceText(elements), RECONNECTING_TEXT, 'not before 20 s');
  await walk(tick, 2_000); // the episode's first attempt follows 2 s later
  assert.equal(sourceText(elements), RECONNECTING_TEXT);
  player.stop();
});

test('player wiring: failures, cancellation and lifecycle hooks go through the reconnect tier', { timeout: TEST_TIMEOUT_MS }, () => {
  const source = readFileSync(new URL('../src/lib/player.js', import.meta.url), 'utf8');
  assert.match(source, /onTerminal: \(message\) => failPlayback\(message, \{ showNext: true \}\)/);
  assert.match(source, /failPlayback\('DASH playback failed\.', \{ showNext: true \}\)/);
  assert.match(source, /failPlayback\('Playback error'\);/);
  assert.match(source, /Events\.LEVEL_LOADED/);
  assert.match(source, /export function stop\(\) \{\s+cancelReconnect\(\);/);
  assert.match(source, /export async function playItem\(item\) \{[\s\S]*?cancelReconnect\(\);\s+await startPlayback\(item\);/);
  assert.match(source, /subscribe\('sleep-fired', \(\) => \{ stopReconnecting\(\); \}\)/);
  assert.match(source, /addEventListener\('online', \(\) => \{ liveResume\.networkBack\(\); \}\)/);
  assert.match(source, /addEventListener\('pagehide'/);
  assert.match(source, /expireMedia\(relayId, 0, \{ keepalive: true \}\)/);
  assert.match(source, /relayMemory\.releaseLeftover\(\)\.catch/);
  assert.match(source, /resolveMessage = resolveFailureMessage\(err\);/);
  assert.match(source, /showBrokenState\(resolveMessage \|\| 'No stream URL'\);/);
  assert.match(source, /setActionHandler\('pause', \(\) => \{ pauseFromUser\(\); \}\)/);
  assert.match(source, /await audioEngine\.resume\(\{ create: true \}\);\s+\/\/[^\n]*\n\s+if \(myToken !== playToken\) return;/);
  assert.match(source, /setActionHandler\('play', \(\) => \{ playFromUser\(\)\.catch\(\(\) => \{\}\); \}\)/);
  assert.match(source, /export async function togglePlay\(\) \{[\s\S]*?return playFromUser\(\);/);
  // The hls.js error callback never tears down synchronously.
  const fail = source.match(/function failPlayback\([\s\S]*?\n\}/)[0];
  assert.match(fail, /queueMicrotask\(/);
  assert.doesNotMatch(fail, /stopLoad|showReconnecting/);
  assert.match(source, /\['seeking', owned\(\(\) => noteSeeking\(el, true\)\)\]/);
  assert.match(source, /\['seeked', owned\(\(\) => noteSeeking\(el, false\)\)\]/);
  // The first-tier HLS recovery budgets are untouched.
  const hls = readFileSync(new URL('../src/lib/hls-recovery.js', import.meta.url), 'utf8');
  assert.match(hls, /const NETWORK_DELAYS_MS = Object\.freeze\(\[1200, 3500\]\);/);
  assert.match(hls, /const STABLE_RESET_MS = 30_000;/);
});
