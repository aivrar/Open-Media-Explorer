import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom } from './helpers/fake-dom.js';
import { getState, saveSettings } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import {
  VERIFY_AFTER_MS, cancelScheduledCheck, checkPlannedFor, scheduleCheck, verifyStation,
} from '../src/lib/best-stream-auto.js';
import { START_CONFIRM_MS, START_FAILOVER_MS, createStartWatch } from '../src/lib/start-failover.js';
import { storedVerification } from '../src/lib/stream-verify.js';
import { CatalogScheduler } from '../src/lib/catalog-scheduler.js';
import { ensureCatalogStore } from '../src/modes/library/catalog-store.js';
import { SNAPSHOT_REFRESH_MIN_MS, createSnapshotManager } from '../src/modes/library/snapshots.js';
import * as mediaCcc from '../src/adapters/media-ccc.js';
import * as owncast from '../src/adapters/owncast.js';

const TEST_TIMEOUT_MS = 20_000;

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  key(index) { return [...this.data.keys()][index] ?? null; }
  get length() { return this.data.size; }
}

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: null,
  json: async () => ({ ok: !error, data, error }),
});

/** A Radio Browser station with two other listed streams. */
function station(uuid = 'aaaa-1', overrides = {}) {
  return {
    id: `radio-browser:${uuid}`, title: `Station ${uuid}`, description: '', source: 'radio-browser',
    type: 'radio', stream_kind: 'audio', stream_url: `https://radio.example/${uuid}/a.mp3`,
    delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
    country: '', language: '',
    _extra: {
      streamCandidates: [
        { url: `https://radio.example/${uuid}/b.mp3`, kind: 'audio' },
        { url: `https://radio.example/${uuid}/c.mp3`, kind: 'audio' },
      ],
    },
    ...overrides,
  };
}

/** The real player (lib/player.js) on a fake page, with mocked timers and
 *  clock. The media element sends its events only when the test says. */
async function setup(t, mode) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  const net = { registered: [], unexpected: [] };
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaSession: { playbackState: 'none', setActionHandler() {} } },
  });
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'review-token' });
    if (path === '/api/v1/media/register') {
      const body = JSON.parse(options.body || '{}');
      net.registered.push(body.stream_url || body.url || '');
      if (net.registered.length === 1) net.connectedAt = Date.now();
      const id = `rv_media_${String(net.registered.length).padStart(12, '0')}`;
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    if (String(path).startsWith('/api/v1/media/')) return envelope(206, null);
    net.unexpected.push(String(path));
    return envelope(404, null, { code: 'NOT_FOUND', message: 'not here' });
  };
  resetControlSession();
  let player = null;
  t.after(() => {
    try { player?.stop(); } catch (_) {}
    cancelScheduledCheck();
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'localStorage', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?reviewFixes7=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  saveSettings({ bestStreamMode: mode });
  await settle();
  const audio = elements['audio-el'];
  audio.autoEvents = false;
  const tick = async (ms) => {
    // In steps, so promise chains between timers settle.
    for (let left = ms; left > 0; left -= 500) {
      t.mock.timers.tick(Math.min(500, left));
      await settle(4);
    }
    await settle();
  };
  const start = async (item) => {
    const playing = player.playItem(item);
    await settle();
    await playing;
    await settle();
    assert.equal(net.registered.length, 1, 'connected on its first stream');
    assert.equal(net.connectedAt, Date.now(), 'at once');
  };
  /** On to `ms` after the stream connected (the start watch was armed then). */
  const tickTo = async (ms) => {
    const left = net.connectedAt + ms - Date.now();
    assert.ok(left >= 0, `already ${Date.now() - net.connectedAt} ms after connecting`);
    await tick(left);
  };
  /** The position moves forward by `seconds`, in small steps. */
  const move = (seconds) => {
    for (let moved = 0; moved < seconds - 1e-9; moved += 0.25) {
      audio.currentTime += 0.25;
      audio.emit('timeupdate');
    }
  };
  /** Plays on for `ms`: the position moves with the clock. */
  const playFor = async (ms) => {
    for (let left = ms; left > 0; left -= 1000) {
      const step = Math.min(1000, left);
      await tick(step);
      move(step / 1000);
    }
  };
  return { player, elements, audio, net, tick, tickTo, start, move, playFor };
}

/* ============ 1. A change of the setting ends Auto's check ============ */

test('Auto: the player ends a planned check when the setting changes to Listed streams or Off', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  for (const next of ['listed', 'off']) {
    await t.test(next, async (sub) => {
      const { player, audio, tick, start } = await setup(sub, 'auto');
      const item = station(`set-${next}`);
      await start(item);
      audio.emit('playing');
      await settle();
      assert.equal(checkPlannedFor(item.id), true, 'planned at the first playing');
      saveSettings({ bestStreamMode: next });
      await settle();
      assert.equal(checkPlannedFor(item.id), false, 'the session ended with the setting');
      await tick(VERIFY_AFTER_MS + 5000);
      assert.equal(storedVerification(`set-${next}`, Date.now()), null, 'nothing checked or remembered');
      player.stop();
    });
  }
});

test('Auto: a check on its way when the setting changes is aborted and its late answer is not remembered', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player } = await setup(t, 'auto');
  const item = station('late');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let options = null;
  const timers = [];
  const runs = [];
  scheduleCheck(item, {
    settings: getState().settings,
    current: () => item,
    nowPlaying: () => ({ itemId: item.id, title: 'Miles Davis - So What' }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clear: () => {},
    run: (it, opts) => {
      options = opts;
      // The directory answers only after the setting changed.
      const adapter = {
        betterStationStreams: async () => {
          await gate;
          return [{ url: 'https://hq.example/late.mp3', kind: 'audio', bitrate: 320, codec: 'MP3' }];
        },
      };
      const probe = async () => { throw new Error('never asked'); };
      const p = verifyStation(it, { ...opts, adapter, probe });
      runs.push(p);
      return p;
    },
  });
  timers[0]();
  await settle();
  assert.ok(options?.signal, 'the check is on its way');
  // Through the player's own wiring: the settings event.
  saveSettings({ bestStreamMode: 'off' });
  assert.equal(options.signal.aborted, true, 'the request to the local server is aborted');
  release();
  assert.equal(await runs[0], null);
  assert.equal(storedVerification('late', Date.now()), null, 'nothing remembered from the late answer');
  player.stop();
});

/* ============ 3. The first Auto wait starts at the first `playing` ============ */

test('Auto: a stream that takes 30 s to begin is checked only after 45 s of play, not 15', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tickTo, start, move, playFor } = await setup(t, 'auto');
  const item = station('slow');
  await start(item);
  assert.equal(checkPlannedFor(item.id), false, 'nothing planned while it only connected');
  await tickTo(27_000);
  assert.equal(checkPlannedFor(item.id), false);
  audio.emit('playing');
  await settle();
  move(1.25); // it plays (the start watch is over)
  assert.equal(checkPlannedFor(item.id), true);
  await playFor(VERIFY_AFTER_MS - 1000);
  assert.equal(storedVerification('slow', Date.now()), null, 'not yet: 44 s of play');
  await playFor(1500);
  assert.equal(net.registered.length, 1, 'the same stream all along');
  // No song title on this stream: the check's first step remembers that.
  assert.equal(storedVerification('slow', Date.now())?.reason, 'noTitles', 'checked after 45 s of play');
  player.stop();
});

/* ============ 2. The start hand-over is for a stream that never begins ============ */

test('the start watch: playing and movement before the limit lift it; the confirm window runs 10 s from playing', () => {
  let clock = 0;
  const timers = new Map();
  let id = 0;
  const calls = [];
  const watch = createStartWatch({
    onNext: (item, tried) => calls.push(tried),
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (handle) => timers.delete(handle),
    now: () => clock,
  });
  const run = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = end;
  };
  assert.equal(START_CONFIRM_MS, 10_000);
  // Playing just before the limit, moving, then stalling: not handed over at 30 s.
  watch.arm(1, { id: 'x' }, ['a']);
  run(START_FAILOVER_MS - 500);
  watch.playing(1);
  watch.moved(1);
  assert.equal(watch.confirming, true);
  run(1000);
  assert.equal(calls.length, 0, 'the start time limit no longer applies');
  run(START_CONFIRM_MS - 1000 - 1);
  assert.equal(calls.length, 0);
  run(1);
  assert.equal(calls.length, 1, 'no second of play within 10 s of playing: handed over');
  // A `playing` without any movement keeps the start time limit.
  watch.arm(2, { id: 'y' }, ['a']);
  run(5000);
  watch.playing(2);
  run(START_FAILOVER_MS - 5000 - 1);
  assert.equal(calls.length, 1);
  run(1);
  assert.equal(calls.length, 2, 'handed over at the start time limit');
  // Movement without `playing` does nothing; a later playing counts from then.
  watch.arm(3, { id: 'z' }, ['a']);
  watch.moved(3);
  assert.equal(watch.confirming, false);
  run(2000);
  watch.playing(3);
  run(12_000); // moved only 12 s after playing: the window is already over
  watch.moved(3);
  run(0);
  assert.equal(calls.length, 3, 'a stream that took over 10 s from playing to move is handed over');
  // A second of play ends the watch for good; a later playing changes nothing.
  watch.arm(4, { id: 'w' }, ['a']);
  watch.playing(4);
  watch.moved(4);
  watch.end();
  watch.playing(4);
  watch.moved(4);
  run(START_FAILOVER_MS * 2);
  assert.equal(calls.length, 3);
  assert.equal(timers.size, 0);
  // Another token's events do nothing.
  watch.arm(5, { id: 'v' }, ['a']);
  watch.playing(4);
  watch.moved(4);
  assert.equal(watch.confirming, false);
  watch.end();
});

test('the player: a stream that begins just before 30 s and stalls is given its confirm window, not handed over at 30 s', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tickTo, start, move } = await setup(t, 'listed');
  await start(station('late-start'));
  await tickTo(START_FAILOVER_MS - 1000);
  audio.emit('playing');
  await settle();
  move(0.5); // it began: half a second, then a stall
  await tickTo(START_FAILOVER_MS + 1000); // past the 30 s limit
  assert.equal(net.registered.length, 1, 'not handed over at 30 s: it began');
  await tickTo(START_FAILOVER_MS - 1000 + START_CONFIRM_MS - 500);
  assert.equal(net.registered.length, 1, 'still within 10 s of playing');
  await tickTo(START_FAILOVER_MS - 1000 + START_CONFIRM_MS + 500);
  assert.equal(net.registered[1], 'https://radio.example/late-start/b.mp3', 'handed over: no second of play in the confirm window');
  player.stop();
});

test('the player: a stream that begins just before 30 s and plays a second is never handed over by the watch', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tickTo, start, move } = await setup(t, 'listed');
  await start(station('plays'));
  await tickTo(START_FAILOVER_MS - 2000);
  audio.emit('playing');
  await settle();
  move(0.5);
  await tickTo(START_FAILOVER_MS + 2000);
  move(0.75); // a second in all, after the 30 s limit
  // Past the confirm window (and before the player's own stall check, which
  // belongs to its recovery, would notice the stream standing still).
  await tickTo(START_FAILOVER_MS + START_CONFIRM_MS + 2000);
  assert.equal(net.registered.length, 1, 'played a second: the watch is over');
  player.stop();
});

test('the player: a playing with no movement keeps the 30 s limit', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tickTo, start } = await setup(t, 'listed');
  await start(station('frozen'));
  await tickTo(5000);
  audio.emit('playing');
  await settle();
  audio.emit('timeupdate'); // a timeupdate with no movement at all
  await tickTo(START_FAILOVER_MS - 500);
  assert.equal(net.registered.length, 1);
  await tickTo(START_FAILOVER_MS + 500);
  assert.equal(net.registered[1], 'https://radio.example/frozen/b.mp3', 'handed over at the start time limit');
  player.stop();
});

/* ============ 4. A failing live list keeps its source's own wait ============ */

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const timerId = this.nextId++;
    this.timers.set(timerId, { at: this.time + Math.max(0, delay), callback });
    return timerId;
  };
  clearTimer = (timerId) => this.timers.delete(timerId);
  async advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [timerId, timer] = due;
      this.timers.delete(timerId);
      this.time = timer.at;
      timer.callback();
      for (let index = 0; index < 10; index++) await Promise.resolve();
    }
    this.time = target;
    for (let index = 0; index < 10; index++) await Promise.resolve();
  }
}

function makeStore() {
  return ensureCatalogStore({
    items: [], itemIndex: new Map(), finiteItemIds: new Set(), snapshotIdsBySource: new Map(),
    snapshotState: new Map(), cumulativeCounts: new Map(), cumulativeTypeCounts: new Map(),
    cumulativeSourceTypeCounts: new Map(), sessionCounts: new Map(),
  });
}

async function failingRefreshes(sourceId, minimum, { stale = false } = {}) {
  const clock = new FakeClock();
  const scheduler = new CatalogScheduler({
    maxConcurrent: 1, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const asked = [];
  const manager = createSnapshotManager({
    scheduler,
    store: makeStore(),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    loadAdapter: async () => ({
      snapshotRetryMinMs: minimum,
      refreshSnapshot: async () => {
        asked.push(clock.now());
        if (stale && asked.length > 1) {
          return { items: [], snapshotId: 's', refreshAfterMs: minimum, stale: true, retryAfterMs: 30_000 };
        }
        if (stale) return { items: [{ id: `${sourceId}:a`, source: sourceId, type: 'tv', title: 'A' }], snapshotId: 's', refreshAfterMs: minimum };
        throw Object.assign(new Error('upstream down'), { status: 503 });
      },
    }),
  });
  await manager.refresh(sourceId).catch(() => {});
  return { clock, manager, scheduler, asked };
}

test('a failing media.ccc.de live list is asked again after five minutes, not every 30 s; Owncast after two', async () => {
  assert.equal(mediaCcc.snapshotRetryMinMs, 5 * 60 * 1000);
  assert.equal(owncast.snapshotRetryMinMs, 2 * 60 * 1000);
  for (const [sourceId, minimum] of [['media-ccc', mediaCcc.snapshotRetryMinMs], ['owncast', owncast.snapshotRetryMinMs]]) {
    const { clock, manager, scheduler, asked } = await failingRefreshes(sourceId, minimum);
    assert.equal(asked.length, 1);
    assert.equal(manager.state(sourceId).state, 'retrying');
    assert.equal(manager.state(sourceId).retryAt, minimum, `${sourceId}: the next ask at its own minimum`);
    await clock.advance(minimum - 1);
    assert.equal(asked.length, 1, `${sourceId}: not asked again sooner`);
    await clock.advance(1);
    assert.equal(asked.length, 2);
    // Failing again: still never sooner than its minimum.
    await clock.advance(minimum - 1);
    assert.equal(asked.length, 2);
    await clock.advance(1);
    assert.equal(asked.length, 3);
    manager.destroy();
    scheduler.destroy();
  }
  // A source without a minimum of its own keeps the general backoff.
  const { clock, manager, scheduler, asked } = await failingRefreshes('other', 0);
  assert.equal(manager.state('other').retryAt, SNAPSHOT_REFRESH_MIN_MS);
  await clock.advance(SNAPSHOT_REFRESH_MIN_MS);
  assert.equal(asked.length, 2);
  manager.destroy();
  scheduler.destroy();
});

test('a stale answer from Owncast is asked again after its two minutes too', async () => {
  const minimum = owncast.snapshotRetryMinMs;
  const { clock, manager, scheduler, asked } = await failingRefreshes('owncast', minimum, { stale: true });
  await clock.advance(minimum);
  assert.equal(asked.length, 2);
  assert.equal(manager.state('owncast').state, 'stale');
  await clock.advance(minimum - 1);
  assert.equal(asked.length, 2, 'not after its own 30 s');
  await clock.advance(1);
  assert.equal(asked.length, 3);
  manager.destroy();
  scheduler.destroy();
});
