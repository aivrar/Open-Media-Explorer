import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createHlsRecoveryController, hlsPlaybackConfig, stableHlsLevelOrder,
  selectHlsPlaybackEngine, waitForHlsStartupBuffer,
} from '../src/lib/hls-recovery.js';

function harness({ selectLowerRendition = () => false, getCurrentTime = () => Number.NaN } = {}) {
  const timers = [];
  const events = [];
  let owned = true;
  const hls = {
    stopLoad() { events.push(['stop']); },
    startLoad(position) { events.push(['network', position]); },
    recoverMediaError() { events.push(['media']); },
  };
  const controller = createHlsRecoveryController({
    hls,
    errorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' },
    owns: () => owned,
    onRecovering: (message) => events.push(['recovering', message]),
    onRecovered: () => events.push(['recovered']),
    onTerminal: (message) => events.push(['terminal', message]),
    selectLowerRendition,
    getCurrentTime,
    setTimer(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  const runNext = () => {
    const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran);
    if (!timer) return null;
    timer.ran = true;
    timer.fn();
    return timer;
  };
  return { controller, events, timers, runNext, setOwned(value) { owned = value; } };
}

test('HLS stable rendition order mirrors recording selection and provides lower fallbacks', () => {
  const levels = [
    { height: 1080, bitrate: 5_000_000 },
    { height: 360, bitrate: 700_000 },
    { height: 720, bitrate: 2_500_000 },
    { height: 480, bitrate: 1_200_000 },
    { bitrate: 900_000 },
  ];
  assert.deepEqual(stableHlsLevelOrder(levels, 720), [2, 3, 1]);
  assert.deepEqual(stableHlsLevelOrder([{ height: 1080 }, { height: 1440 }], 720), [0]);
  assert.deepEqual(stableHlsLevelOrder([{ bitrate: 900 }, { bitrate: 400 }], 720), [0, 1]);
  assert.deepEqual(stableHlsLevelOrder(null), []);
});

test('hls.js wins over WebView2 native HLS claims', () => {
  assert.equal(selectHlsPlaybackEngine({ hlsSupported: true, nativeSupport: 'maybe' }), 'hlsjs');
  assert.equal(selectHlsPlaybackEngine({ hlsSupported: false, nativeSupport: 'probably' }), 'native');
  assert.equal(selectHlsPlaybackEngine({ hlsSupported: false, nativeSupport: '' }), 'unavailable');
});

test('HLS startup waits for a bounded playback cushion', async () => {
  let bufferedSeconds = 2;
  let timeout = null;
  const media = new EventTarget();
  media.buffered = {
    length: 1,
    start: () => 0,
    end: () => bufferedSeconds,
  };
  const waiting = waitForHlsStartupBuffer(media, {
    targetSeconds: 6,
    timeoutMs: 10_000,
    setTimer(fn, delay) { timeout = { fn, delay, cleared: false }; return timeout; },
    clearTimer(timer) { timer.cleared = true; },
  });
  bufferedSeconds = 6.2;
  media.dispatchEvent(new Event('progress'));
  assert.equal(await waiting, true);
  assert.equal(timeout.cleared, true);

  bufferedSeconds = 8;
  let fastTimerCreated = false;
  assert.equal(await waitForHlsStartupBuffer(media, {
    targetSeconds: 6,
    setTimer() { fastTimerCreated = true; return 1; },
  }), true);
  assert.equal(fastTimerCreated, false, 'a fast stream with a full cushion starts immediately');

  let ranges = [[0, 8]];
  const jumped = new EventTarget();
  jumped.currentTime = 20;
  jumped.buffered = {
    get length() { return ranges.length; },
    start: (index) => ranges[index][0],
    end: (index) => ranges[index][1],
  };
  let jumpedTimer = null;
  const liveWindow = waitForHlsStartupBuffer(jumped, {
    targetSeconds: 6,
    setTimer(fn) { jumpedTimer = { fn, cleared: false }; return jumpedTimer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  assert.ok(jumpedTimer, 'a disconnected stale range must not satisfy startup buffering');
  ranges = [[20, 27]];
  jumped.dispatchEvent(new Event('progress'));
  assert.equal(await liveWindow, true);
  assert.equal(jumpedTimer.cleared, true);

  let fallbackTimer = null;
  bufferedSeconds = 1;
  const bounded = waitForHlsStartupBuffer(media, {
    targetSeconds: 6,
    timeoutMs: 3210,
    setTimer(fn, delay) { fallbackTimer = { fn, delay }; return fallbackTimer; },
    clearTimer() {},
  });
  assert.equal(fallbackTimer.delay, 3210);
  fallbackTimer.fn();
  assert.equal(await bounded, false);
});

test('HLS fatal network and media recovery is delayed, bounded, and reports terminal failure', () => {
  const h = harness();
  assert.deepEqual(hlsPlaybackConfig(), {
    enableWorker: true,
    capLevelToPlayerSize: true,
    autoStartLoad: false,
    startLevel: -1,
    lowLatencyMode: false,
    initialLiveManifestSize: 3,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 12,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 45,
    maxBufferHole: 0.5,
    nudgeMaxRetry: 5,
    abrEwmaDefaultEstimate: 700_000,
    abrBandWidthFactor: 0.72,
    abrBandWidthUpFactor: 0.5,
    abrMaxWithRealBitrate: true,
    maxStarvationDelay: 2,
    maxLoadingDelay: 4,
  });

  assert.equal(h.controller.handleFatal({ fatal: true, type: 'network' }), true);
  assert.equal(h.controller.isRecovering, true);
  assert.equal(h.controller.handleFatal({ fatal: true, type: 'network' }), true);
  assert.deepEqual(h.controller.attempts, { network: 1, media: 0 }, 'duplicate fatal must not consume a retry');
  assert.equal(h.runNext().delay, 1200);
  assert.deepEqual(h.events.at(-2), ['network', -1]);

  h.controller.notePlaying();
  assert.equal(h.controller.isRecovering, false);
  assert.equal(h.controller.handleFatal({ fatal: true, type: 'network' }), true);
  assert.equal(h.runNext().delay, 3500);
  h.controller.notePlaying();
  assert.equal(h.controller.handleFatal({ fatal: true, type: 'network' }), false);
  assert.match(h.events.at(-1)[1], /exhausted/);

  const m = harness();
  assert.equal(m.controller.handleFatal({ fatal: true, type: 'media' }), true);
  assert.equal(m.runNext().delay, 0);
  assert.deepEqual(m.events.at(-2), ['media']);
  m.controller.notePlaying();
  assert.equal(m.controller.handleFatal({ fatal: true, type: 'media' }), true);
  assert.equal(m.runNext().delay, 5000);
  m.controller.notePlaying();
  assert.equal(m.controller.handleFatal({ fatal: true, type: 'media' }), false);
  assert.match(m.events.at(-1)[1], /exhausted/);
});

test('HLS recovery ignores nonfatal/stale work and destroy cancels queued recovery', () => {
  const h = harness();
  assert.equal(h.controller.handleFatal({ fatal: false, type: 'network' }), false);
  h.setOwned(false);
  assert.equal(h.controller.handleFatal({ fatal: true, type: 'network' }), false);
  h.setOwned(true);
  h.controller.handleFatal({ fatal: true, type: 'network' });
  h.controller.destroy();
  assert.equal(h.controller.isRecovering, false);
  assert.equal(h.runNext(), null);
  assert.equal(h.events.some(([type]) => type === 'network'), false);
});

test('HLS waiting watchdog recovers a genuine stall and moving time cancels false alarms', () => {
  const moving = harness();
  assert.equal(moving.controller.noteStalled(), true);
  assert.equal(moving.timers.at(-1).delay, 8000);
  moving.controller.noteProgress(1);
  assert.equal(moving.runNext(), null, 'time progress must cancel pending stall recovery');

  const resumed = harness();
  resumed.controller.noteStalled();
  resumed.controller.notePlaying();
  assert.equal(resumed.runNext().delay, 30000, 'playing must cancel the stall timer');

  const fatal = harness();
  fatal.controller.noteStalled();
  fatal.controller.handleFatal({ fatal: true, type: 'network' });
  assert.equal(fatal.runNext().delay, 1200, 'fatal recovery must supersede stall recovery');

  const stuck = harness();
  assert.equal(stuck.controller.noteStalled(), true);
  assert.equal(stuck.controller.noteStalled(), false, 'duplicate waiting events share one watchdog');
  assert.equal(stuck.runNext().delay, 8000);
  assert.deepEqual(stuck.events.at(-2), ['network', -1]);
  assert.deepEqual(stuck.events.at(-1), ['recovered']);
  assert.equal(stuck.controller.isRecovering, true);
  stuck.controller.noteProgress(9.25);
  assert.equal(stuck.controller.isRecovering, false);

  let fallbacks = 0;
  const rendition = harness({ selectLowerRendition: () => { fallbacks++; return true; } });
  rendition.controller.noteStalled();
  rendition.runNext();
  assert.equal(fallbacks, 1, 'a genuine stall steps down one rendition before restarting');
});

test('HLS repeated short stalls may lower quality without restarting a healthy loader', () => {
  let fallbacks = 0;
  const h = harness({ selectLowerRendition: () => { fallbacks++; return true; } });

  assert.equal(h.controller.noteStalled(), true);
  h.controller.noteProgress(1);
  assert.equal(h.controller.noteStalled(), true);
  h.controller.noteProgress(2);
  assert.equal(fallbacks, 0, 'two isolated stalls retain the current ceiling');

  assert.equal(h.controller.noteStalled(), true);
  assert.equal(fallbacks, 1, 'the third short stall lowers exactly one rendition');
  assert.equal(h.events.some(([type]) => type === 'network'), false,
    'brief rebuffering must not create segment holes by restarting HLS');
  assert.equal(h.controller.isRecovering, false);
  h.controller.noteProgress(3);
  assert.equal(h.controller.isRecovering, false);
});

test('a new HLS stall cancels the stable-playback reset window', () => {
  const h = harness();
  h.controller.notePlaying();
  const stableReset = h.timers.find((timer) => timer.delay === 30000 && !timer.cleared);
  assert.equal(stableReset.delay, 30000);

  h.controller.noteStalled();
  assert.equal(stableReset.cleared, true, 'buffering must invalidate the stable interval');
  assert.equal(h.runNext().delay, 8000, 'only the stall watchdog remains runnable');
});

test('HLS progress heartbeat restarts a silent freeze and is disabled while paused', () => {
  const frozen = harness();
  frozen.controller.notePlaying();
  const heartbeat = frozen.timers.find((timer) => timer.delay === 8000 && !timer.cleared);
  heartbeat.ran = true;
  heartbeat.fn();
  assert.equal(frozen.controller.isRecovering, true);
  assert.deepEqual(frozen.events.slice(-3), [['stop'], ['network', -1], ['recovered']]);
  assert.match(frozen.events.at(-4)[1], /frozen/i);
  assert.equal(frozen.controller.handleFatal({ fatal: true, type: 'network' }), true);
  assert.deepEqual(frozen.controller.attempts, { network: 1, media: 0 },
    'a fatal event from the same freeze must not consume another retry');

  const paused = harness();
  paused.controller.notePlaying();
  const pausedHeartbeat = paused.timers.find((timer) => timer.delay === 8000 && !timer.cleared);
  paused.controller.notePaused();
  assert.equal(pausedHeartbeat.cleared, true);
  assert.equal(paused.controller.isRecovering, false);
  assert.equal(paused.runNext(), null, 'an intentional pause must not trigger recovery');

  let actualTime = 1;
  const delayedEvent = harness({ getCurrentTime: () => actualTime });
  delayedEvent.controller.notePlaying();
  delayedEvent.controller.noteProgress(actualTime);
  const delayedHeartbeat = delayedEvent.timers.filter(
    (timer) => timer.delay === 8000 && !timer.cleared,
  ).at(-1);
  actualTime = 4;
  delayedHeartbeat.ran = true;
  delayedHeartbeat.fn();
  assert.equal(delayedEvent.controller.isRecovering, false);
  assert.equal(delayedEvent.events.some(([type]) => type === 'network'), false,
    'actual clock progress must suppress a false reconnect');
});

test('player keeps automatic ABR below a downward-only quality ceiling', () => {
  const source = readFileSync(new URL('../src/lib/player.js', import.meta.url), 'utf8');
  assert.match(source, /instance\.autoLevelCapping = stableLevels\[stableLevelPosition\]/);
  assert.match(source, /instance\.nextAutoLevel = lowerLevel/);
  assert.match(source, /currentLevel > lowerLevel/);
  assert.match(source, /instance\.startLoad\(-1\)/);
  assert.doesNotMatch(
    source,
    /instance\.(?:currentLevel|nextLevel|loadLevel)\s*=/,
    'manual level setters would disable measured automatic selection',
  );
});
