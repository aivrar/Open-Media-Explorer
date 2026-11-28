import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import {
  DEFAULT_VISUALIZER_QUALITY, DEFAULT_VISUALIZER_SHOW_FPS, VISUALIZER_IDLE_FPS, VISUALIZER_IDLE_SECONDS,
  VISUALIZER_PRESETS, normalizeVisualizerQuality, visualizerPreset,
} from '../src/lib/visualizer-settings.js';
import { STORAGE_KEYS, normalizeSettings } from '../src/lib/state.js';
import { LEGACY_PROFILE_STORAGE_KEYS, PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import {
  IDLE_TIME_RATE, LOOP_MODES, MAX_SCENE_STEP_S, createVisualizerLoop,
} from '../src/visualizer/loop.js';
import { MIN_SIDE, deviceSizeFromEntry, drawingSize } from '../src/visualizer/size.js';
import {
  BLOCKING_COMPILE_DELAY_MS, CONTEXT_ATTRIBUTES, contextLimits, createSceneRenderer, createWebglContext,
} from '../src/visualizer/scene-renderer.js';
import { MESSAGES, READOUT, fpsText, mountVisualizer } from '../src/visualizer/index.js';
import loadPlasma from '../src/visualizer/vendor/psychedelia/effects/plasma.js';
import {
  FILES, PATCHES, VENDOR_DIR, applyPatches, checkDrift, embeddedBody, readOriginals, sha256, toLf, uncommittedSources, wrap,
} from '../scripts/import_psychedelia.mjs';
import { createClockHarness, fakeAnalyser, fakeVisibilityDoc } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 1 of the visualizer: a Visualizer tab with one scene (Plasma from
   Psychedelia Studio). It costs nothing until opened, and leaving it stops
   every timer and frame, drops the sound subscription and gives the WebGL
   context back. Everything here runs without a GPU. (Slice 2 - frame rate,
   brightness, scenes, the Beat Reactor and the flash limiter - is in
   visualizer-slice2.test.js.) */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(REPO, path), 'utf8');
const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`,
);

/* ---------------- Doubles (tests/helpers/visualizer-fakes.js) ---------------- */

function playingSource(node = fakeAnalyser({ level: 230 })) {
  return {
    playing: false,
    audible: true,
    node,
    isPlaying() { return this.playing; },
    isAudible() { return this.audible; },
    getAnalyser() { return this.playing ? this.node : null; },
    release() {},
  };
}

/* ---------------- Settings ---------------- */

test('quality and the readout are fields in the saved settings, never a new key, and survive older builds', () => {
  assert.equal(DEFAULT_VISUALIZER_QUALITY, 'medium');
  const defaults = normalizeSettings({});
  assert.equal(defaults.visualizerQuality, 'medium');
  assert.equal(defaults.visualizerShowFps, false, 'the readout is off until turned on');
  assert.equal(DEFAULT_VISUALIZER_SHOW_FPS, false);
  for (const value of ['low', 'medium', 'high']) assert.equal(normalizeSettings({ visualizerQuality: value }).visualizerQuality, value);
  for (const value of [null, 'ultra', 3, {}]) assert.equal(normalizeSettings({ visualizerQuality: value }).visualizerQuality, 'medium');
  assert.equal(normalizeSettings({ visualizerShowFps: true }).visualizerShowFps, true);
  assert.equal(normalizeSettings({ visualizerShowFps: false }).visualizerShowFps, false);
  assert.equal(normalizeSettings({ visualizerShowFps: 'yes' }).visualizerShowFps, false);
  // Round trip through storage and through an older build's normaliser,
  // which keeps unknown fields by spreading the saved object.
  const olderNormalize = (value) => ({ ...value, version: 1, theme: value.theme || 'system' });
  const saved = JSON.stringify(normalizeSettings({ visualizerQuality: 'high', visualizerShowFps: false }));
  const back = normalizeSettings(olderNormalize(JSON.parse(saved)));
  assert.equal(back.visualizerQuality, 'high');
  assert.equal(back.visualizerShowFps, false);
  // No storage key, no profile key; the legacy list is unchanged.
  assert.ok(!Object.values(STORAGE_KEYS).some((key) => /visual/i.test(key)));
  assert.ok(!PROFILE_STORAGE_KEYS.some((key) => /visual/i.test(key)));
  assert.equal(LEGACY_PROFILE_STORAGE_KEYS.length, 5);
  assert.ok(LEGACY_PROFILE_STORAGE_KEYS.includes(STORAGE_KEYS.settings), 'older builds restore the settings value');
  // The Visualizer is not offered as the start-up tab (it would start the GPU at launch).
  assert.equal(normalizeSettings({ defaultMode: 'visualizer' }).defaultMode, 'library');
});

test('quality presets: sharpness only (scale and a pixel cap), no frame rate; default Medium', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(VISUALIZER_PRESETS).map(([id, p]) => [id, [p.scale, p.maxPixels]])),
    { low: [0.5, 600000], medium: [0.75, 1200000], high: [1, 2400000] },
  );
  for (const preset of Object.values(VISUALIZER_PRESETS)) assert.equal(preset.fps, undefined, 'the frame rate is its own setting');
  assert.equal(visualizerPreset('nonsense'), VISUALIZER_PRESETS.medium);
  assert.equal(normalizeVisualizerQuality(undefined), 'medium');
  assert.equal(VISUALIZER_IDLE_FPS, 5);
  assert.equal(VISUALIZER_IDLE_SECONDS, 20);
  // 1600 x 900 device pixels (1280 x 720 at 125 %).
  assert.deepEqual(drawingSize(1600, 900, VISUALIZER_PRESETS.low), { width: 800, height: 450 });
  assert.deepEqual(drawingSize(1600, 900, VISUALIZER_PRESETS.medium), { width: 1200, height: 675 });
  assert.deepEqual(drawingSize(1600, 900, VISUALIZER_PRESETS.high), { width: 1600, height: 900 });
  // A 4K screen: capped, shape kept.
  for (const preset of Object.values(VISUALIZER_PRESETS)) {
    const size = drawingSize(3840, 2160, preset);
    assert.ok(size.width * size.height <= preset.maxPixels, `${preset.label} capped`);
    near(size.width / size.height, 16 / 9, 0.01, `${preset.label} shape`);
  }
  // Tall and narrow windows keep their shape too; nothing laid out gives 0.
  const tall = drawingSize(600, 1400, VISUALIZER_PRESETS.medium);
  near(tall.width / tall.height, 600 / 1400, 0.01, 'tall');
  assert.deepEqual(drawingSize(0, 900, VISUALIZER_PRESETS.medium), { width: 0, height: 0 });
  assert.deepEqual(drawingSize(10, 10, VISUALIZER_PRESETS.low), { width: 16, height: 16 });
  // A very wide, short window (three screens side by side, a thin strip):
  // the area cap alone would still ask for 8944 x 134, more than a 4096
  // GPU can make. The context's per-side limits shrink it as a whole.
  const limits = { maxWidth: 4096, maxHeight: 4096 };
  assert.deepEqual(drawingSize(20000, 300, VISUALIZER_PRESETS.medium), { width: 8944, height: 134 }, 'area cap only');
  const wide = drawingSize(20000, 300, VISUALIZER_PRESETS.medium, limits);
  assert.equal(wide.width, 4096, 'the long side fits the limit');
  near(wide.width / wide.height, 20000 / 300, 1.2, 'shape kept');
  const narrow = drawingSize(300, 20000, VISUALIZER_PRESETS.high, { maxWidth: 16384, maxHeight: 2048 });
  assert.equal(narrow.height, 2048, 'a different limit per side (viewport dims)');
  near(narrow.width / narrow.height, 300 / 20000, 0.001, 'tall shape kept');
  for (const preset of Object.values(VISUALIZER_PRESETS)) {
    for (const [w, h] of [[20000, 300], [300, 20000], [16000, 9000], [5000, 5000]]) {
      const size = drawingSize(w, h, preset, limits);
      assert.ok(size.width <= 4096 && size.height <= 4096, `${preset.label} ${w}x${h} within limits`);
      assert.ok(size.width * size.height <= preset.maxPixels, `${preset.label} ${w}x${h} still capped`);
    }
  }
  // Limits that do not bind (or are unknown) change nothing.
  assert.deepEqual(drawingSize(1600, 900, VISUALIZER_PRESETS.medium, limits), { width: 1200, height: 675 });
  assert.deepEqual(drawingSize(1600, 900, VISUALIZER_PRESETS.medium, { maxWidth: 0, maxHeight: null }), { width: 1200, height: 675 });
  // Resize entries: the exact device box, else CSS size x devicePixelRatio.
  assert.deepEqual(deviceSizeFromEntry({ devicePixelContentBoxSize: [{ inlineSize: 1601, blockSize: 899 }] }, 2), { width: 1601, height: 899 });
  assert.deepEqual(deviceSizeFromEntry({ contentBoxSize: [{ inlineSize: 1280, blockSize: 720 }] }, 1.25), { width: 1600, height: 900 });
  assert.deepEqual(deviceSizeFromEntry({ contentRect: { width: 100, height: 50 } }, 1.5), { width: 150, height: 75 });
});

/* ---------------- The loop ---------------- */

function loopHarness({ reduced = false, fps = 30 } = {}) {
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const motion = fakeMotion(reduced);
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const meter = [];
  signal.subscribe((frame) => meter.push(frame.dt), { fps: 15 });
  const draws = [];
  const statuses = [];
  const loop = createVisualizerLoop({
    signal,
    fps,
    draw: (state) => draws.push({ time: state.time, live: state.live, still: state.still, level: state.audio.level }),
    onStatus: (status) => statuses.push({ ...status }),
    doc: vis.doc,
    win: motion.win,
    ...h.io,
  });
  return { h, vis, motion, source, signal, meter, draws, statuses, loop };
}

test('the tab moves on its own at 5 fps while nothing plays, and draws in the sound frames while it plays', () => {
  const t = loopHarness();
  assert.equal(t.loop.mode, LOOP_MODES.off);
  assert.equal(t.loop.pending, 0);
  assert.equal(t.signal.subscriberCount, 1, 'only the meter');
  t.loop.start();
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  assert.equal(t.signal.subscriberCount, 2);
  assert.equal(t.signal.running, false, 'nothing playing: the signal rests');
  t.h.run(2000);
  near(t.draws.length, 2 * VISUALIZER_IDLE_FPS, 1, 'idle at 5 a second');
  assert.equal(t.signal.stats.reads, 0, 'idle drawing reads no sound');
  assert.ok(t.loop.pending <= 1, 'one timer or one frame');
  assert.ok(t.h.counts.maxPending <= 1);
  near(t.statuses.at(-1).fps, 5, 1, 'readout');
  // Idle frames are 0.2 s apart; each moves the scene clock at most
  // MAX_SCENE_STEP_S (at the idle half rate), like a live frame: the drift
  // winds down slower rather than step further per drawn frame.
  near(t.draws.at(-1).time, (t.draws.length - 1) * MAX_SCENE_STEP_S * IDLE_TIME_RATE, 0.02, 'idle clock: one capped step per drawn frame');
  for (let index = 1; index < t.draws.length; index += 1) assert.ok(t.draws[index].time >= t.draws[index - 1].time, 'time never goes back');
  // Play: the signal runs, the idle loop stops, draws come in the signal's frames.
  t.source.playing = true;
  t.signal.refresh();
  t.h.run(20);
  assert.equal(t.loop.mode, LOOP_MODES.live);
  assert.equal(t.loop.pending, 0, 'no idle timer while live');
  t.h.counts.maxPending = 0; // (the idle tick may overlap the signal's first frame once)
  const before = t.draws.length;
  const meterBefore = t.meter.length;
  const reads = t.signal.stats.reads;
  t.h.run(2000);
  near(t.draws.length - before, 60, 2, '30 a second (the default frame rate)');
  near(t.signal.stats.reads - reads, 60, 2, 'one read per drawn frame');
  near(t.meter.length - meterBefore, 30, 1, 'the meter keeps 15 a second');
  assert.ok(t.draws.at(-1).live);
  assert.ok(t.draws.at(-1).level > 0.1, 'the sound reaches u_audio');
  assert.equal(t.h.counts.maxPending, 1, 'never a second loop');
  // 60 a second; the meter still 15.
  t.loop.setFps(60);
  const high = t.draws.length;
  const meterHigh = t.meter.length;
  t.h.run(1000);
  near(t.draws.length - high, 60, 2, '60 a second');
  near(t.meter.length - meterHigh, 15, 1, 'the meter is not raised');
  // Pause: back to the idle clock; the sound values fade out.
  t.source.playing = false;
  t.signal.refresh();
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  const idle = t.draws.length;
  t.h.run(1000);
  near(t.draws.length - idle, 5, 1, 'idle again');
  assert.ok(t.draws.at(-1).level < 0.1, 'sound fades out');
  assert.equal(t.signal.running, false);
  t.loop.destroy();
});

test('hidden, minimised, reduced motion and a lost context each stop the drawing', () => {
  const t = loopHarness();
  t.loop.start();
  t.h.run(500);
  // Hidden: nothing scheduled, no subscription.
  t.vis.setVisible(false);
  assert.equal(t.loop.mode, LOOP_MODES.paused);
  assert.equal(t.loop.pending, 0);
  assert.equal(t.loop.subscribed, false);
  assert.equal(t.signal.subscriberCount, 1);
  let count = t.draws.length;
  t.h.run(2000);
  assert.equal(t.draws.length, count);
  t.vis.setVisible(true);
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  t.h.run(500);
  // Minimised (about one frame a second): frames are skipped, not drawn.
  count = t.draws.length;
  t.h.run(10000, 1000);
  assert.ok(t.draws.length - count <= 2, `at most the first throttled frame is drawn (${t.draws.length - count})`);
  assert.ok(t.loop.stats.skipped >= 7);
  assert.ok(t.h.counts.maxPending <= 2, 'no pile-up');
  count = t.draws.length;
  t.h.run(1000);
  near(t.draws.length - count, 5, 1, 'restored: drawing again');
  // Reduced motion: one still picture, no loop, no subscription.
  count = t.draws.length;
  t.motion.set(true);
  assert.equal(t.loop.mode, LOOP_MODES.still);
  assert.equal(t.draws.length, count + 1);
  assert.equal(t.draws.at(-1).still, true);
  assert.equal(t.loop.pending, 0);
  assert.equal(t.loop.subscribed, false);
  t.source.playing = true;
  t.signal.refresh();
  t.h.run(2000);
  assert.equal(t.draws.length, count + 1, 'still means still, even with sound');
  t.loop.redraw();
  assert.equal(t.draws.length, count + 2, 'drawn again after a resize');
  t.motion.set(false);
  t.h.run(100);
  assert.equal(t.loop.mode, LOOP_MODES.live);
  // A lost graphics context: everything pauses until it is back.
  t.loop.setSuspended(true);
  assert.equal(t.loop.mode, LOOP_MODES.paused);
  assert.equal(t.loop.subscribed, false);
  count = t.draws.length;
  t.h.run(1000);
  assert.equal(t.draws.length, count);
  t.loop.setSuspended(false);
  t.h.run(1000);
  near(t.draws.length - count, 30, 2);
  t.loop.destroy();
});

test('reduced motion from the start: a still picture and nothing else, like the meter', () => {
  const t = loopHarness({ reduced: true });
  t.loop.start();
  assert.equal(t.loop.mode, LOOP_MODES.still);
  assert.equal(t.draws.length, 1);
  assert.equal(t.loop.subscribed, false);
  assert.equal(t.signal.subscriberCount, 1);
  t.h.run(3000);
  assert.equal(t.draws.length, 1);
  assert.equal(t.loop.pending, 0);
  t.loop.destroy();
  assert.equal(t.motion.listeners.size, 0);
});

const SPELL_MS = VISUALIZER_IDLE_SECONDS * 1000;

test('without sound the picture drifts for 20 s at 5 fps, then holds still with nothing scheduled', () => {
  const t = loopHarness();
  t.loop.start();
  t.h.run(SPELL_MS - 500);
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  near(t.draws.length, (SPELL_MS - 500) / 1000 * VISUALIZER_IDLE_FPS, 2, 'drifting at 5 a second');
  t.h.run(1000);
  assert.equal(t.loop.mode, LOOP_MODES.rest, 'held still after 20 s');
  assert.equal(t.loop.stats.rests, 1);
  assert.equal(t.loop.pending, 0);
  assert.equal(t.loop.subscribed, true, 'still listening for sound');
  assert.equal(t.signal.running, false);
  assert.equal(t.h.pending(), 0, 'not a timer or an animation frame anywhere');
  const held = t.draws.length;
  const heldTime = t.draws.at(-1).time;
  const requests = t.h.counts.frameRequests + t.h.counts.timersSet;
  t.h.run(60000);
  assert.equal(t.draws.length, held);
  assert.equal(t.h.counts.frameRequests + t.h.counts.timersSet, requests, 'nothing asked for while held');
  // A resize clears the canvas: the same picture is drawn once more.
  t.loop.redraw();
  assert.equal(t.draws.length, held + 1);
  assert.equal(t.draws.at(-1).time, heldTime, 'the same moment, not moved on');
  assert.equal(t.h.pending(), 0);
  // A frame-rate change, a visibility event while visible or a context that was
  // never lost changes nothing.
  t.loop.setFps(60);
  t.vis.setVisible(true);
  t.loop.setSuspended(false);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  assert.equal(t.h.pending(), 0);
  // Sound: live at once.
  t.source.playing = true;
  t.signal.refresh();
  t.h.run(20);
  assert.equal(t.loop.mode, LOOP_MODES.live);
  const live = t.draws.length;
  t.h.run(1000);
  near(t.draws.length - live, 60, 2, '60 a second');
  // Paused again: a fresh 20 s.
  t.source.playing = false;
  t.signal.refresh();
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  t.h.run(SPELL_MS - 500);
  assert.equal(t.loop.mode, LOOP_MODES.idle, 'a new spell has its own 20 s');
  t.h.run(1000);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  assert.equal(t.loop.stats.rests, 2);
  assert.equal(t.h.pending(), 0);
  t.loop.destroy();
  assert.equal(t.loop.mode, LOOP_MODES.off);
  assert.equal(t.signal.subscriberCount, 1, 'only the meter');
});

test('held still: hidden, reduced motion and a lost context behave as before; coming back starts a fresh spell', () => {
  const t = loopHarness();
  t.loop.start();
  t.h.run(SPELL_MS + 500);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  // Hidden: paused, no subscription.
  t.vis.setVisible(false);
  assert.equal(t.loop.mode, LOOP_MODES.paused);
  assert.equal(t.loop.subscribed, false);
  assert.equal(t.h.pending(), 0);
  t.vis.setVisible(true);
  assert.equal(t.loop.mode, LOOP_MODES.idle, 'shown again: drifting');
  let count = t.draws.length;
  t.h.run(1000);
  near(t.draws.length - count, 5, 1);
  t.h.run(SPELL_MS);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  // Reduced motion: the one still picture, as before.
  count = t.draws.length;
  t.motion.set(true);
  assert.equal(t.loop.mode, LOOP_MODES.still);
  assert.equal(t.draws.length, count + 1);
  assert.equal(t.draws.at(-1).still, true);
  assert.equal(t.h.pending(), 0);
  t.motion.set(false);
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  t.h.run(SPELL_MS + 500);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  // A lost context: paused; back: drifting again.
  t.loop.setSuspended(true);
  assert.equal(t.loop.mode, LOOP_MODES.paused);
  assert.equal(t.loop.subscribed, false);
  t.loop.setSuspended(false);
  assert.equal(t.loop.mode, LOOP_MODES.idle);
  t.h.run(1000);
  // Stopped (leaving the tab): nothing left.
  t.loop.destroy();
  assert.equal(t.loop.mode, LOOP_MODES.off);
  assert.equal(t.signal.subscriberCount, 1);
  assert.equal(t.h.pending(), 0);
});

test('the frame-rate readout counts each state afresh and never shows a number from another', () => {
  const t = loopHarness();
  const text = () => fpsText(t.statuses.at(-1));
  t.loop.start();
  assert.equal(text(), '-- fps, no sound playing', 'no number before a second is counted');
  t.h.run(1500);
  assert.equal(text(), '5 fps, no sound playing');
  t.source.playing = true;
  t.signal.refresh();
  t.h.run(20);
  assert.equal(t.loop.mode, LOOP_MODES.live);
  assert.equal(text(), '-- fps', 'no idle number next to live');
  t.h.run(1500);
  assert.equal(text(), '30 fps');
  t.source.playing = false;
  t.signal.refresh();
  assert.equal(text(), '-- fps, no sound playing', 'no live number next to the idle label');
  t.h.run(1500);
  assert.equal(text(), '5 fps, no sound playing');
  // Minimised: nothing drawn, so no number.
  t.h.run(5000, 1000);
  assert.equal(t.loop.throttled, true);
  assert.equal(text(), READOUT.notDrawing);
  t.h.run(500);
  assert.equal(t.loop.throttled, false, 'shown again');
  assert.equal(text(), '-- fps, no sound playing', 'counted afresh, the gap is no frame rate');
  t.h.run(1500);
  assert.equal(text(), '5 fps, no sound playing');
  // Held still: the label alone.
  t.h.run(SPELL_MS);
  assert.equal(t.loop.mode, LOOP_MODES.rest);
  assert.equal(t.statuses.at(-1).fps, null);
  assert.equal(text(), READOUT.rest);
  // Live and minimised: not drawing, never "1 fps".
  t.source.playing = true;
  t.signal.refresh();
  t.h.run(1500);
  assert.equal(text(), '30 fps');
  t.h.run(5000, 1000);
  assert.equal(text(), READOUT.notDrawing);
  t.h.run(1500);
  assert.equal(text(), '30 fps');
  // A new frame rate is counted afresh too.
  t.loop.setFps(60);
  assert.equal(text(), '-- fps');
  t.h.run(1500);
  assert.equal(text(), '60 fps');
  // Every number shown belonged to the state it was shown with.
  for (const status of t.statuses) {
    if (status.fps === null) continue;
    assert.ok(!status.throttled, 'no number while not drawing');
    if (status.mode === LOOP_MODES.idle) near(status.fps, 5, 1, 'idle number');
    else if (status.mode === LOOP_MODES.live) near(status.fps, status.targetFps, 1, 'live number');
    else assert.fail(`a number in ${status.mode}`);
  }
  // The other states have no readout (their message says it all).
  for (const mode of [LOOP_MODES.off, LOOP_MODES.paused, LOOP_MODES.still]) assert.equal(fpsText({ mode, fps: 12 }), '');
  for (const words of Object.values(READOUT)) assert.ok(/^[\x20-\x7e]+$/.test(words) && words.length < 40, words);
  t.loop.destroy();
});

test('stopping or destroying the loop leaves no subscriber, timer, frame or listener behind', () => {
  for (const playing of [false, true]) {
    const t = loopHarness();
    t.source.playing = playing;
    t.signal.refresh();
    t.loop.start();
    t.h.run(1000);
    assert.ok(t.draws.length >= (playing ? 25 : 5), `drawing (${t.draws.length})`);
    t.loop.stop();
    assert.equal(t.loop.mode, LOOP_MODES.off);
    assert.equal(t.loop.pending, 0);
    assert.equal(t.signal.subscriberCount, 1, 'only the meter is left');
    t.loop.start();
    t.h.run(500);
    t.loop.destroy();
    t.loop.start(); // ignored after destroy
    assert.equal(t.loop.mode, LOOP_MODES.off);
    assert.equal(t.loop.pending, 0);
    assert.equal(t.signal.subscriberCount, 1);
    assert.equal(t.motion.listeners.size, 0, 'motion listener removed');
    assert.equal(t.vis.listeners.get('visibilitychange').size, 1, 'only the signal keeps its own listener (for the meter)');
    const count = t.draws.length;
    t.h.run(2000);
    assert.equal(t.draws.length, count);
    // With the meter gone too, nothing at all is scheduled.
    t.source.playing = false;
    t.signal.refresh();
    assert.equal(t.h.pending(), 0);
  }
});

/* ---------------- The scene renderer ---------------- */

/** A renderer drawing Plasma (registered, compiled on the spot, installed). */
function plasmaRenderer(gl, { canvas = { width: 300, height: 150 }, mode = 'webgl2', random } = {}) {
  const renderer = createSceneRenderer({ canvas, gl, mode, random });
  renderer.useSceneNow(renderer.register({ default: loadPlasma }, 'plasma'));
  return renderer;
}

test('Plasma is compiled through Psychedelia\'s own shader manager and fed the standard and audio uniforms', () => {
  const gl = new FakeGL();
  const canvas = { width: 300, height: 150 };
  const renderer = plasmaRenderer(gl, { canvas, random: () => 0.25 });
  const fragment = gl.sources.find((entry) => entry.type === gl.FRAGMENT_SHADER).source;
  assert.match(fragment, /^#version 300 es/);
  assert.match(fragment, /=== Psychedelia Common GLSL ===/);
  assert.match(fragment, /uniform float u_complexity;/);
  assert.doesNotMatch(fragment, /FRAG_OUT/, 'Psychedelia rewrites its output name');
  assert.equal(gl.programs.size, 1, 'one real program; building the shader text compiled nothing');
  assert.equal(gl.shaders.size, 0, 'the shaders are deleted once linked');
  assert.equal(renderer.definition.name, 'plasma');
  assert.deepEqual(renderer.values, { speed: 1, scale: 6, complexity: 4, saturation: 0.85, brightness: 0.9 });
  assert.equal(renderer.resize(1200, 675), true);
  assert.equal(renderer.resize(1200, 675), false);
  assert.ok(renderer.draw({ time: 3.5, audio: { bass: 0.1, mid: 0.2, high: 0.3, level: 0.4 }, beat: {} }));
  assert.deepEqual(gl.viewportSize, [1200, 675]);
  assert.deepEqual(gl.uniforms.get('u_time'), [3.5]);
  assert.deepEqual(gl.uniforms.get('u_resolution'), [1200, 675]);
  assert.deepEqual(gl.uniforms.get('u_speed'), [1]);
  assert.deepEqual(gl.uniforms.get('u_seed'), [250]);
  assert.deepEqual(gl.uniforms.get('u_seed_vec'), [0.25, 0.25, 0.25, 0.25]);
  assert.equal(gl.draws, 1);
  // A scene that declares the audio uniforms gets (bass, mid, high, level) and zeros for the beat.
  const audioGl = new FakeGL();
  const audioRenderer = plasmaRenderer(audioGl, { canvas: { width: 10, height: 10 }, mode: 'webgl' });
  const program = audioRenderer.program;
  program.fragment += '\nuniform vec4 u_audio;\nuniform vec4 u_beat;';
  audioRenderer.draw({ time: 1, audio: { bass: 0.1, mid: 0.2, high: 0.3, level: 0.4 }, beat: {} });
  assert.deepEqual(audioGl.uniforms.get('u_audio'), [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(audioGl.uniforms.get('u_beat'), [0, 0, 0, 0]);
  assert.doesNotMatch(audioGl.sources.find((entry) => entry.type === audioGl.FRAGMENT_SHADER).source, /#version 300 es/, 'WebGL 1 gets GLSL 100');
  // Restore after a context loss rebuilds the quad; the scene went with the
  // context and is not compiled here (the switcher compiles it again the
  // usual way, without blocking); destroy frees and gives the context back.
  gl.programs.clear(); // the driver dropped every object with the old context
  gl.buffers.clear();
  const compiles = renderer.stats.compiles;
  assert.equal(renderer.restore(), 'plasma', 'the scene that was drawn');
  assert.equal(renderer.stats.builds, 2);
  assert.equal(renderer.stats.compiles, compiles, 'nothing compiled on the spot');
  assert.equal(gl.programs.size, 0);
  assert.equal(renderer.definition, null);
  assert.equal(renderer.draw({ time: 1, audio: {}, beat: {} }), false, 'nothing drawn until a scene is installed again');
  renderer.destroy();
  assert.equal(gl.loseCount, 1);
  assert.equal(gl.programs.size, 0, 'programs deleted');
  assert.equal(gl.buffers.size, 0, 'buffer deleted');
  assert.equal(renderer.draw({ time: 1 }), false, 'nothing drawn after destroy');
  renderer.destroy(); // twice is harmless
  assert.equal(gl.loseCount, 1);
  // Before any scene is installed nothing is drawn (and nothing breaks).
  const empty = createSceneRenderer({ canvas: { width: 10, height: 10 }, gl: new FakeGL(), mode: 'webgl2' });
  assert.equal(empty.draw({ time: 1, audio: {}, beat: {} }), false);
  empty.destroy();
  // Context attributes: cheap ones.
  assert.equal(CONTEXT_ATTRIBUTES.preserveDrawingBuffer, false);
  assert.equal(CONTEXT_ATTRIBUTES.antialias, false);
  assert.equal(CONTEXT_ATTRIBUTES.depth, false);
  // WebGL 2 first, then WebGL 1, else null.
  const asked = [];
  assert.equal(createWebglContext({ getContext: (kind) => { asked.push(kind); return null; } }), null);
  assert.deepEqual(asked, ['webgl2', 'webgl', 'experimental-webgl']);
  assert.equal(createWebglContext({ getContext: (kind) => (kind === 'webgl' ? gl : null) }).mode, 'webgl');
  // A failed compile is an error the tab can show, not a black screen.
  const broken = new FakeGL();
  broken.failCompile = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.throws(() => plasmaRenderer(broken), /could not be compiled/);
    assert.equal(broken.programs.size, 0, 'the failed program is deleted');
  } finally {
    console.error = originalError;
  }
});

/* ---------------- The tab ---------------- */

async function mountHarness({
  context = 'ok', settings = {}, gpu = null, layout = null, reduced = false,
} = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(layout);
  const motion = fakeMotion(reduced);
  const win = fakeResizeObserverWin(motion);
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  if (gpu) Object.assign(gl, gpu);
  const saved = [];
  const settingsListeners = new Set();
  // (the photosensitivity notice accepted: its own tests are in visualizer-slice4)
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const root = new FakeNodeEl('div');
  let contexts = 0;
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of settingsListeners) fn(current); },
    subscribeSettings: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => { contexts += 1; return context === 'none' ? null : { gl, mode: 'webgl2' }; },
    createRenderer: context === 'broken'
      ? () => { throw new Error('compile'); }
      : undefined,
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
  });
  // The scene's chunk is a dynamic import: let it arrive (and the compile,
  // which starts a moment later on a context without parallel compile).
  if (context === 'ok') {
    for (let round = 0; round < 10 && !session.switcher.current; round += 1) {
      await settle(() => Boolean(session.switcher.current), 40);
      if (!session.switcher.current) h.run(BLOCKING_COMPILE_DELAY_MS);
    }
    assert.ok(session.switcher.current, 'the scene is shown');
  }
  return {
    h, vis, motion, win, source, signal, gl, saved, settingsListeners, root, session, controls: session.controls,
    get contexts() { return contexts; },
  };
}

test('the tab fills its area at the right drawing size, follows quality, and tears down to nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = await mountHarness();
  const { session, gl, win, root, controls } = m;
  const canvas = session.canvas;
  assert.equal(root.children.length, 1);
  assert.equal(canvas.getAttribute('role'), 'img');
  assert.match(canvas.getAttribute('aria-label'), /^Plasma/);
  assert.equal(win.observers.length, 1);
  assert.equal(win.observers[0].observed[0].options.box, 'device-pixel-content-box');
  assert.equal(session.loop.mode, LOOP_MODES.idle);
  // The window at 1280 x 720 CSS pixels and 125 %: Medium draws 1200 x 675.
  assert.equal(gl.draws, 0, 'no layout size yet: nothing drawn into the 300 x 150 default');
  win.observers[0].fire(1600, 900);
  assert.deepEqual([canvas.width, canvas.height], [1200, 675]);
  assert.equal(gl.draws, 1, 'drawn as soon as the size is known');
  assert.deepEqual(gl.viewportSize, [1200, 675]);
  m.h.run(1000);
  near(gl.draws, 6, 1, 'idle frames drawn');
  // A taller, narrower window: follows the shape.
  win.observers[0].fire(1000, 1200);
  assert.deepEqual([canvas.width, canvas.height], [750, 900]);
  // Quality from the control is saved, and the saved setting is applied: it
  // changes the sharpness only, not the frame rate.
  const select = controls.qualitySelect;
  select.value = 'high';
  select.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerQuality: 'high', visualizerQualityPicked: true });
  assert.equal(session.loop.targetFps, 30);
  assert.deepEqual([canvas.width, canvas.height], [1000, 1200]);
  // The frame rate has its own buttons.
  const sixty = controls.fpsButtons.find((button) => button.getAttribute('data-fps') === '60');
  sixty.dispatchEvent(new Event('click'));
  assert.deepEqual(m.saved.at(-1), { visualizerFps: 60 });
  assert.equal(session.loop.targetFps, 60);
  assert.equal(sixty.getAttribute('aria-pressed'), 'true');
  const toggle = controls.fpsToggle;
  const readout = controls.readout;
  assert.equal(toggle.checked, false, 'the readout is off by default');
  assert.equal(readout.hidden, true);
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerShowFps: true });
  assert.equal(readout.hidden, false, 'and can be turned on');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerShowFps: false });
  assert.equal(readout.hidden, true);
  // Playing: live at 60.
  m.source.playing = true;
  m.signal.refresh();
  const draws = gl.draws;
  m.h.run(1000);
  near(gl.draws - draws, 60, 2);
  // The driver resets the context: paused with a message, then back.
  const lostEvent = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(lostEvent);
  assert.equal(lostEvent.defaultPrevented, true, 'asks for the context back');
  assert.equal(session.loop.mode, LOOP_MODES.paused);
  assert.equal(session.message.hidden, false);
  assert.equal(session.message.textContent, MESSAGES.lost);
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(session.message.hidden, true);
  m.h.run(100);
  assert.equal(session.loop.mode, LOOP_MODES.live);
  assert.equal(m.contexts, 1, 'one context for the whole visit');
  // Leaving the tab.
  session.destroy();
  assert.equal(gl.loseCount, 1, 'the WebGL context is given back');
  assert.equal(win.observers[0].disconnected, true);
  assert.equal(canvas.listenerCount, 0, 'no canvas listeners left');
  for (const [name, control] of Object.entries(controls)) {
    for (const element of [control].flat()) assert.equal(element.listenerCount, 0, `${name} has no listeners left`);
  }
  assert.equal(m.settingsListeners.size, 0);
  assert.equal(m.signal.subscriberCount, 0, 'no sound subscription');
  assert.equal(m.motion.listeners.size, 0);
  assert.equal(m.vis.count(), 0, 'no document listeners');
  assert.equal(root.children.length, 0);
  assert.equal(session.loop.pending, 0);
  assert.equal(canvas.width, 0);
  m.source.playing = false;
  m.signal.refresh();
  assert.equal(m.h.pending(), 0, 'not a single timer or animation frame left');
  session.destroy(); // twice is harmless
});

test('the drawing buffer never asks for more than the context can make, per side', async (t) => {
  t.mock.method(console, 'error', () => {});
  // What the context reports: the smallest of viewport, renderbuffer and
  // texture limits per side; nothing known means no limit.
  const probe = new FakeGL();
  probe.maxViewport = [8192, 4096];
  probe.maxRenderbuffer = 6000;
  probe.maxTexture = 16384;
  assert.deepEqual(contextLimits(probe), { maxWidth: 6000, maxHeight: 4096 });
  probe.lost = true;
  assert.deepEqual(contextLimits(probe), { maxWidth: Infinity, maxHeight: Infinity });
  assert.deepEqual(contextLimits({}), { maxWidth: Infinity, maxHeight: Infinity });
  // The tab on a small GPU in a very wide, short window.
  const m = await mountHarness({ gpu: { maxViewport: [4096, 4096], maxRenderbuffer: 4096, maxTexture: 4096 }, settings: { visualizerQuality: 'high' } });
  const { session, win } = m;
  assert.deepEqual(session.renderer.limits, { maxWidth: 4096, maxHeight: 4096 });
  win.observers[0].fire(20000, 300);
  const { width, height } = session.canvas;
  assert.equal(width, 4096);
  assert.ok(height >= MIN_SIDE && height < 300, `height ${height}`);
  near(width / height, 20000 / 300, 2, 'shape kept');
  // An ordinary window is untouched by the limits.
  win.observers[0].fire(1600, 900);
  assert.deepEqual([session.canvas.width, session.canvas.height], [1600, 900]);
  session.destroy();
});

const LAYOUT = { width: 1280, height: 720 }; // CSS pixels; x 1.25 = 1600 x 900 device pixels

test('the first picture is drawn at the tab size, before the ResizeObserver reports', async () => {
  const m = await mountHarness({ layout: LAYOUT });
  const { canvas } = m.session;
  assert.deepEqual([canvas.width, canvas.height], [1200, 675], 'sized from the layout at once');
  m.h.run(200); // the first idle draw (5 a second) after the scene came in
  assert.equal(m.gl.draws, 1);
  assert.deepEqual(m.gl.viewportSize, [1200, 675], 'the first draw is at the right size');
  m.win.observers[0].fire(1600, 900);
  assert.equal(m.gl.draws, 1, 'the observer\'s first report changes nothing');
  m.session.destroy();
  // Reduced motion: the one still picture is drawn at the right size as soon
  // as the scene is there.
  const still = await mountHarness({ layout: LAYOUT, reduced: true });
  assert.equal(still.session.loop.mode, LOOP_MODES.still);
  assert.equal(still.gl.draws, 1);
  assert.deepEqual(still.gl.viewportSize, [1200, 675]);
  still.win.observers[0].fire(1600, 900);
  assert.equal(still.gl.draws, 1);
  still.session.destroy();
  // Not laid out yet: nothing is drawn until the size is known, then one picture.
  const early = await mountHarness({ reduced: true });
  assert.equal(early.gl.draws, 0);
  early.h.run(1000);
  assert.equal(early.gl.draws, 0);
  early.win.observers[0].fire(1600, 900);
  assert.equal(early.gl.draws, 1);
  assert.deepEqual(early.gl.viewportSize, [1200, 675]);
  early.session.destroy();
});

test('held still, the tab redraws one correctly sized picture on a resize or a quality change, and leaving cancels everything', async () => {
  const m = await mountHarness({ layout: LAYOUT, settings: { visualizerShowFps: true } });
  const { readout } = m.controls;
  assert.equal(readout.hidden, false, 'turned on in the settings');
  assert.equal(readout.textContent, '-- fps, no sound playing');
  m.h.run(2000);
  assert.equal(readout.textContent, '5 fps, no sound playing');
  m.h.run(SPELL_MS);
  assert.equal(m.session.loop.mode, LOOP_MODES.rest);
  assert.equal(readout.textContent, READOUT.rest);
  assert.equal(m.h.pending(), 0, 'nothing scheduled while held');
  const draws = m.gl.draws;
  // A resize: one picture at the new size.
  m.win.observers[0].fire(1000, 1200);
  assert.deepEqual([m.session.canvas.width, m.session.canvas.height], [750, 900]);
  assert.equal(m.gl.draws, draws + 1);
  assert.deepEqual(m.gl.viewportSize, [750, 900]);
  // A quality change: one picture at that quality's size.
  const select = m.controls.qualitySelect;
  select.value = 'high';
  select.dispatchEvent(new Event('change'));
  assert.deepEqual([m.session.canvas.width, m.session.canvas.height], [1000, 1200]);
  assert.equal(m.gl.draws, draws + 2);
  assert.deepEqual(m.gl.viewportSize, [1000, 1200]);
  assert.equal(m.session.loop.mode, LOOP_MODES.rest);
  assert.equal(readout.textContent, READOUT.rest);
  // The same size again draws nothing; time passing draws nothing.
  m.win.observers[0].fire(1000, 1200);
  m.h.run(60000);
  assert.equal(m.gl.draws, draws + 2);
  assert.equal(m.h.pending(), 0);
  // Sound: live at once.
  m.source.playing = true;
  m.signal.refresh();
  m.h.run(20);
  assert.equal(m.session.loop.mode, LOOP_MODES.live);
  assert.equal(readout.textContent, '-- fps');
  // Held still again, then the tab is left.
  m.source.playing = false;
  m.signal.refresh();
  m.h.run(SPELL_MS + 500);
  assert.equal(m.session.loop.mode, LOOP_MODES.rest);
  m.session.destroy();
  assert.equal(m.signal.subscriberCount, 0);
  assert.equal(m.gl.loseCount, 1);
  assert.equal(m.vis.count(), 0);
  assert.equal(m.h.pending(), 0);
});

test('without WebGL, or when the scene cannot be prepared, the tab says so plainly and runs nothing', async () => {
  for (const context of ['none', 'broken']) {
    const originalError = console.error;
    console.error = () => {};
    let m;
    try { m = await mountHarness({ context }); } finally { console.error = originalError; }
    assert.equal(m.session.message.hidden, false);
    assert.equal(m.session.message.textContent, context === 'none' ? MESSAGES.noWebgl : MESSAGES.noScene);
    assert.equal(m.session.loop, null);
    assert.equal(m.session.switcher, null);
    assert.equal(m.signal.subscriberCount, 0);
    assert.equal(m.win.observers.length, 0);
    m.h.run(1000);
    assert.equal(m.h.pending(), 0);
    if (context === 'broken') assert.equal(m.gl.loseCount, 1, 'the unused context is given back');
    m.session.destroy();
  }
  for (const text of Object.values(MESSAGES)) assert.ok(/^[\x20-\x7e]+$/.test(text) && text.length < 120, text);
});

/* ---------------- Lazy loading ---------------- */

function staticImports(source) {
  const out = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(match[1]);
  return out;
}

test('nothing of the visualizer is in the main bundle\'s static graph; the tab loads it with a dynamic import', async () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const spec of staticImports(text)) {
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      if (target.endsWith('.js') && existsSync(target)) visit(target);
    }
  };
  visit(join(REPO, 'src', 'main.js'));
  const visualizerDir = join(REPO, 'src', 'visualizer');
  assert.ok(seen.has(join(REPO, 'src', 'modes', 'visualizer.js')), 'the shell is reachable');
  assert.ok(![...seen].some((file) => file.startsWith(visualizerDir)), 'no static import into src/visualizer');
  const shell = await read('src/modes/visualizer.js');
  assert.match(shell, /import\('\.\.\/visualizer\/visualizer\.js'\)/);
  assert.doesNotMatch(shell, /requestAnimationFrame|setInterval|getContext/);
  const main = await read('src/main.js');
  assert.match(main, /visualizer: renderVisualizer,/);
  const html = await read('src/index.html');
  assert.match(html, /data-mode="computer">Computer<\/button>\s+<button class="mode-btn" data-mode="now-playing">Now Playing<\/button>\s+<button class="mode-btn" data-mode="visualizer">Visualizer<\/button>\s+<button class="mode-btn" data-mode="about">/);
  // Its styles come with the chunk, not the page.
  assert.doesNotMatch(html, /visualizer\.css/);
  assert.match(await read('src/visualizer/visualizer.js'), /^import '\.\/visualizer\.css';/m);
  assert.doesNotMatch(await read('src/visualizer/index.js'), /\.css'/);
  // No blur over the moving picture (it would be recomputed every frame).
  assert.doesNotMatch(await read('src/visualizer/visualizer.css'), /backdrop-filter|filter:/);
});

/* Contrast as WCAG works it out; layers are blended in sRGB, as browsers do. */
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hexColor = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
const over = (top, alpha, under) => under.map((c, index) => top[index] * alpha + c * (1 - alpha));

function cssRules(css) {
  const rules = new Map();
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  for (let index = 0; index < flat.length; index += 1) {
    if (flat[index] === '{') {
      if (depth === 0) {
        const selector = flat.slice(start, index).trim().replace(/\s+/g, ' ');
        const end = flat.indexOf('}', index);
        if (!selector.startsWith('@')) rules.set(selector, flat.slice(index + 1, end));
      }
      depth += 1;
    } else if (flat[index] === '}') {
      depth -= 1;
      start = index + 1;
    }
  }
  return rules;
}

function declaration(body, name) {
  const match = body.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

test('the buttons, panel, notes and notice read at 4.5:1 or better over a white picture, the same in every theme', async () => {
  const rules = cssRules(await read('src/visualizer/visualizer.css'));
  const white = [1, 1, 1];
  const rgba = (value) => {
    const match = String(value).match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/);
    assert.ok(match, `a fixed backing (${value})`);
    return { color: [match[1], match[2], match[3]].map((c) => Number(c) / 255), alpha: Number(match[4]) };
  };
  // Fixed colours (no theme variables), so every theme looks the same.
  const hex = (body, name = 'color') => {
    const value = declaration(body, name);
    assert.match(value, /^#[0-9a-f]{6}$/i, `${name}: ${value}`);
    return hexColor(value);
  };
  const backingOver = (body, under = white) => {
    const { color, alpha } = rgba(declaration(body, 'background'));
    return over(color, alpha, under);
  };
  const check = (what, text, back) => {
    const ratio = contrast(text, back);
    assert.ok(ratio >= 4.5, `${what} ${ratio.toFixed(2)}:1`);
  };
  // The buttons over the picture: never half dimmed (only gone, opacity 0,
  // or shown, opacity 1).
  for (const [selector, body] of rules) {
    if (!selector.includes('.viz-hud')) continue;
    const opacity = declaration(body, 'opacity');
    assert.ok(opacity === null || opacity === '0' || opacity === '1', `${selector} opacity ${opacity}`);
  }
  assert.equal(declaration(rules.get('.viz-hud.viz-hud-faded'), 'opacity'), '0');
  assert.equal(declaration(rules.get('.viz-hud.viz-hud-faded'), 'pointer-events'), 'none');
  assert.equal(declaration(rules.get('.viz-hud:focus-within'), 'opacity'), '1', 'keyboard focus shows them');
  assert.match(declaration(rules.get('.viz-hud'), 'transition'), /^opacity /, 'a compositor fade');
  const hud = rules.get('.viz-hud');
  const hudBack = backingOver(hud);
  const hudBtn = rules.get('.viz-hud-btn');
  const hudBox = backingOver(hudBtn, hudBack);
  check('button marks', hex(hud), hudBox);
  const pressedHud = rules.get('.viz-hud-btn[aria-pressed="true"], .viz-hud-btn[aria-expanded="true"]');
  check('a button that is on', hex(pressedHud), hex(pressedHud, 'background'));
  check('the star when on', hex(rules.get('.viz-hud-star[aria-pressed="true"]')), hex(pressedHud, 'background'));
  check('a button that cannot be used', hex(rules.get('.viz-hud-btn:disabled')), hudBox);
  // The side panel.
  const panel = rules.get('.viz-panel');
  const panelBack = backingOver(panel);
  check('panel text', hex(panel), panelBack);
  const field = rules.get('.viz-select, .viz-btn, .viz-seg');
  assert.ok(rgba(declaration(field, 'background')).color.every((c) => c === 1), 'lists and buttons only lighten the panel');
  check('list and button text', hex(panel), backingOver(field, panelBack));
  check('section titles', hex(rules.get('.viz-section-title')), panelBack);
  check('the notice line', hex(rules.get('.viz-link')), panelBack);
  check('the mood line', hex(rules.get('.viz-mood')), panelBack);
  const pressed = rules.get('.viz-seg[aria-pressed="true"]');
  check('the chosen frame rate', hex(pressed), hex(pressed, 'background'));
  for (const selector of ['.viz-minor', '.viz-bright-value', '.viz-label']) {
    assert.equal(declaration(rules.get(selector) || '', 'color'), null, `${selector} keeps the panel's colour`);
  }
  // The scene list in the panel, its headings, cost badges and stars.
  const list = rules.get('.viz-scene-panel');
  const listBack = hex(list, 'background');
  check('scene names', hex(list), listBack);
  check('category headings', hex(rules.get('.viz-scene-heading')), listBack);
  check('the empty line', hex(rules.get('.viz-scene-empty')), listBack);
  check('favourite stars', hex(rules.get('.viz-scene-star')), listBack);
  for (const cost of ['light', 'medium', 'heavy']) check(`${cost} badge`, hex(rules.get(`.viz-cost-${cost}`)), listBack);
  // Notes over the picture: light text on a near-black backing over white.
  for (const selector of ['.viz-note', '.viz-fps', '.viz-debug', '.viz-start', '.viz-message']) {
    const body = rules.get(selector);
    check(selector, hex(body), backingOver(body));
  }
  // The notice.
  const box = rules.get('.viz-notice-box');
  check('notice text', hex(box), hex(box, 'background'));
  const go = rules.get('.viz-notice-continue');
  check('Continue', hex(go), hex(go, 'background'));
  const notNow = rules.get('.viz-notice-btn');
  check('Not now', hex(notNow), backingOver(notNow, hex(box, 'background')));
});

test('the tab shell mounts once loaded, ignores a load that finishes after leaving, and tears down on leaving', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNodeEl(tag) };
  try {
    const shell = await import('../src/modes/visualizer.js');
    const state = await import('../src/lib/state.js');
    let mounts = 0;
    let destroys = 0;
    let release = null;
    shell.setVisualizerLoaderForTests(() => new Promise((resolveLoad) => {
      release = () => resolveLoad({ mountVisualizer: (root, deps) => {
        mounts += 1;
        assert.equal(typeof deps.signal.subscribe, 'function');
        return { destroy() { destroys += 1; } };
      } });
    }));
    const host = new FakeNodeEl('main');
    state.setMode('visualizer');
    shell.renderVisualizer(host);
    assert.equal(host.children.length, 1);
    release();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(mounts, 1);
    assert.equal(shell.visualizerMounted(), true);
    state.setMode('tuner');
    assert.equal(destroys, 1, 'leaving the tab tears it down');
    assert.equal(shell.visualizerMounted(), false);
    // Left before the module arrived: never mounted.
    state.setMode('visualizer');
    shell.renderVisualizer(new FakeNodeEl('main'));
    state.setMode('library');
    release();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(mounts, 1, 'a late load is ignored');
    // Opening the tab again while it is open replaces the old one.
    state.setMode('visualizer');
    shell.renderVisualizer(new FakeNodeEl('main'));
    release();
    await new Promise((done) => setTimeout(done, 0));
    shell.renderVisualizer(new FakeNodeEl('main'));
    assert.equal(destroys, 2);
    release();
    await new Promise((done) => setTimeout(done, 0));
    state.setMode('library');
    assert.equal(destroys, 3);
    shell.setVisualizerLoaderForTests(null);
  } finally {
    globalThis.document = previousDocument;
  }
});

/* ---------------- The imported Psychedelia files ---------------- */

test('the vendored Psychedelia files match their manifest (the live originals are compared by hand: import_psychedelia.mjs --check-drift)', async () => {
  const manifest = JSON.parse(await read('src/visualizer/vendor/psychedelia/manifest.json'));
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.files.map((file) => file.target), FILES.map((file) => file.target));
  for (const entry of manifest.files) {
    const wrapped = readFileSync(join(VENDOR_DIR, ...entry.target.split('/')), 'utf8');
    assert.ok(/^[\x00-\x7f]*$/.test(wrapped), `${entry.target} is ASCII`);
    const body = embeddedBody(wrapped, entry.source);
    assert.ok(body, `${entry.target} has its BEGIN / END lines`);
    assert.equal(sha256(body), entry.bodySha256, `${entry.target} was not edited by hand`);
    assert.match(wrapped, new RegExp(`SHA-256 of the original \\(LF line endings\\): ${entry.sha256}`));
    assert.match(wrapped, /Copyright \(c\) 2026 aivrar\. MIT License/);
    // The manifest lists exactly the import patches the script has for it.
    const listed = PATCHES.filter((patch) => patch.source === entry.source)
      .map((patch) => ({ find: patch.find, replace: patch.replace, why: patch.why }));
    assert.deepEqual(entry.patches || [], listed, `${entry.target}: its import patches`);
    if (!listed.length && !entry.asciiEscapes) {
      // Nothing changed on import: the embedded text is the original itself
      // (a missing last newline is the only addition), and the whole file is
      // what the script writes from it.
      const original = body.endsWith('\n') && sha256(body) !== entry.sha256 ? body.slice(0, -1) : body;
      assert.equal(sha256(original), entry.sha256, `${entry.target} is the original`);
      const again = wrap({ source: entry.source, original, globals: [...entry.needs, ...entry.provides], crlf: false });
      assert.ok(toLf(wrapped) === again.text, `${entry.target} is what the script writes`);
    }
    if (entry.upstream) assert.match(entry.upstream.commit, /^[0-9a-f]{40}$/, `${entry.target}: the upstream commit it came from`);
  }
  for (const notice of manifest.notices) {
    assert.equal(sha256(toLf(readFileSync(join(VENDOR_DIR, notice.target), 'utf8'))), notice.sha256);
  }
  // Import patches: overlays.js drawn into the app's canvas (init(host); no
  // layout read per frame), and its lasers drawn by the app's beam function
  // when one is set (the variable, the call in renderLasers, setBeamSprite).
  // Tunnel's depth fade and the dive budget in whole steps of 60 are not
  // patches any more: Psychedelia has the first since 410e10c, and since
  // b4739fa its fractals colour the inside of the set from the orbit point
  // closest to the origin, which holds still as the dive's budget grows (the
  // cause of the flicker the patch held back).
  // And (slice 12) the camera fade of three flights, three patches each
  // (tests/visualizer-slice12.test.js). Cymatics: each visit starts afresh,
  // three patches (tests/visualizer-slice13.test.js). Curl-Noise Silk: its
  // warm-up at most two extra steps a frame (slice 14). Palette Map: its
  // colour index without a jump (two patches). Slice 14's simulations: a
  // resize carries their state over (GpuSim.carry, two in each); Fluid Ink
  // steps every other frame with its ink blended between, and fewer
  // pressure passes (seven more).
  assert.deepEqual(PATCHES.map((patch) => patch.source), [
    ...Array(5).fill('src/engine/overlays.js'),
    ...Array(2).fill('src/engine/post-fx-library.js'),
    ...['apollonian-foam-flight', 'folded-box-variants-flight', 'mandelbox-flight'].flatMap((name) => Array(3).fill(`src/effects/${name}.js`)),
    ...Array(3).fill('src/effects/cymatics.js'),
    'src/effects/curl-silk.js',
    ...Array(2).fill('src/engine/gpu-sim.js'),
    ...['curl-silk', 'fluid-ink', 'lenia', 'physarum'].flatMap((name) => Array(2).fill(`src/effects/${name}.js`)),
    // Its step spread over two frames (three more).
    ...Array(10).fill('src/effects/fluid-ink.js'),
    // GlowLines: its persistence target sized by the line host (two, and a
    // third: on a failed new target it draws on at the old size), no array
    // made per frame (two), a new target checked and the trails carried
    // into it (one): tests/visualizer-lines.test.js.
    ...Array(6).fill('src/engine/glow-lines.js'),
    // Physarum: at most two steps a frame, its agents resampled to a new
    // count (two), its deposit scaled with its trail field's area.
    ...Array(4).fill('src/effects/physarum.js'),
    // Four line scenes take the host's time step (two each).
    ...['epicycles', 'hopf', 'knots', 'polytopes'].flatMap((name) => Array(2).fill(`src/effects/${name}.js`)),
    // The density worker (six) and IFS / L-System Lab (eight):
    // tests/visualizer-accumulating.test.js; then the worker's white point
    // eased by the host (four): tests/visualizer-density-steady.test.js.
    ...Array(6).fill('src/workers/progressive-density-worker.js'),
    ...Array(8).fill('src/effects/ifs-lsystem-lab.js'),
    ...Array(4).fill('src/workers/progressive-density-worker.js'),
  ]);
  const overlaysFile = manifest.files.find((file) => file.target === 'engine/overlays.js');
  assert.equal(overlaysFile.patches.length, 5);
  const vendoredOverlays = readFileSync(join(VENDOR_DIR, 'engine', 'overlays.js'), 'utf8');
  assert.ok(vendoredOverlays.includes('if (beamSprite && beamSprite(ctx, x1, y1, xm, ym, x2, y2, col, P.laser_thickness)) continue;'), 'lasers through the beam function');
  assert.ok(vendoredOverlays.includes('setBeamSprite: function(fn)'), 'which the app sets');
  const engine = manifest.files.find((file) => file.target === 'engine/shader-manager.js');
  assert.equal(engine.patches, undefined);
  const vendoredEngine = readFileSync(join(VENDOR_DIR, 'engine', 'shader-manager.js'), 'utf8');
  assert.ok(vendoredEngine.includes('return min(cap, baseIter * (1.0 + 0.09 * max(dive, 0.0)));'), 'the budget grows smoothly, as upstream');
  assert.doesNotMatch(vendoredEngine, /PATCHED on import/);
  for (const name of ['mandelbrot', 'burning-ship', 'tricorn', 'mandelbrot-power', 'mandelbrot-deep']) {
    const scene = readFileSync(join(VENDOR_DIR, 'effects', `${name}.js`), 'utf8');
    assert.ok(scene.includes('psyDiveIterations('), `${name} grows its budget in a dive`);
    assert.match(scene, /zMin = z;/, `${name}: its inside coloured from the closest orbit point (Psychedelia b4739fa)`);
    assert.equal(manifest.files.find((file) => file.target === `effects/${name}.js`).upstream.commit.slice(0, 7), 'b4739fa', name);
  }
  const tunnel = manifest.files.find((file) => file.target === 'effects/tunnel.js');
  assert.equal(tunnel.patches, undefined);
  assert.equal(tunnel.upstream.commit.slice(0, 7), '410e10c');
  assert.equal(applyPatches('src/effects/plasma.js', 'x\n').text, 'x\n', 'files without patches untouched');
  // The registry's one non-ASCII character (an ellipsis in a message) is escaped, not dropped.
  const registry = manifest.files.find((file) => file.target === 'effects/registry.js');
  assert.equal(registry.asciiEscapes, 1);
  assert.match(readFileSync(join(VENDOR_DIR, 'effects', 'registry.js'), 'utf8'), /'\\u2026'/);
});

test('the drift check lists originals changed or missing since the import and new scene files, and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'psy-drift-'));
  try {
    const effects = join(root, 'src', 'effects');
    mkdirSync(effects, { recursive: true });
    const scene = (name) => `EffectRegistry.register({ name: '${name}', shader: 'void main() {}' });\n`;
    writeFileSync(join(effects, 'same.js'), scene('same'));
    writeFileSync(join(effects, 'moved.js'), scene('moved v2'));
    writeFileSync(join(effects, 'brand-new.js'), scene('brand_new'));
    writeFileSync(join(effects, 'custom.js'), "EffectRegistry.register({ name: 'custom', render() {} });\n");
    writeFileSync(join(root, 'LICENSE'), 'MIT\n');
    const manifest = {
      files: [
        { source: 'src/effects/same.js', target: 'effects/same.js', sha256: sha256(scene('same')) },
        { source: 'src/effects/moved.js', target: 'effects/moved.js', sha256: sha256(scene('moved')) },
        { source: 'src/effects/gone.js', target: 'effects/gone.js', sha256: sha256('x') },
      ],
      notices: [{ source: 'LICENSE', target: 'LICENSE.txt', sha256: sha256('MIT\n') }],
    };
    const report = checkDrift(root, manifest);
    assert.equal(report.same, 1);
    assert.deepEqual(report.changed.map((row) => row.source), ['src/effects/moved.js']);
    assert.deepEqual(report.missing, ['src/effects/gone.js']);
    assert.deepEqual(report.notices, []);
    assert.ok(report.newScenes.includes('brand-new'), 'a new simple scene file is named');
    assert.ok(!report.newScenes.includes('custom'), 'not one with its own render');
    assert.deepEqual(readdirSync(effects).sort(), ['brand-new.js', 'custom.js', 'moved.js', 'same.js'], 'nothing written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the importer takes only committed originals: it refuses (and the drift check warns) while one has uncommitted changes, unless told to', () => {
  const root = mkdtempSync(join(tmpdir(), 'psy-git-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    const effects = join(root, 'src', 'effects');
    mkdirSync(effects, { recursive: true });
    const scene = (name) => `EffectRegistry.register({ name: '${name}', shader: 'void main() {}' });\n`;
    writeFileSync(join(effects, 'a.js'), scene('a'));
    writeFileSync(join(effects, 'b.js'), scene('b'));
    writeFileSync(join(root, 'LICENSE'), 'MIT\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const sources = ['src/effects/a.js', 'src/effects/b.js', 'LICENSE'];
    const manifest = {
      files: [
        { source: 'src/effects/a.js', target: 'effects/a.js', sha256: sha256(scene('a')) },
        { source: 'src/effects/b.js', target: 'effects/b.js', sha256: sha256(scene('b')) },
      ],
      notices: [{ source: 'LICENSE', target: 'LICENSE.txt', sha256: sha256('MIT\n') }],
    };
    // All committed: read, and no warning.
    assert.deepEqual(uncommittedSources(root, sources), []);
    assert.equal(readOriginals(root, sources).get('src/effects/a.js'), scene('a'));
    assert.deepEqual(checkDrift(root, manifest).uncommitted, []);
    // One changed, one staged: refused by name, warned of by the drift check.
    writeFileSync(join(effects, 'a.js'), scene('a v2'));
    writeFileSync(join(root, 'LICENSE'), 'MIT, changed\n');
    git('add', 'LICENSE');
    assert.deepEqual(uncommittedSources(root, sources), ['src/effects/a.js', 'LICENSE']);
    assert.throws(() => readOriginals(root, sources), /not committed.*src\/effects\/a\.js, LICENSE/);
    assert.throws(() => readOriginals(root, ['src/effects/a.js']), /src\/effects\/a\.js/);
    assert.equal(readOriginals(root, ['src/effects/b.js']).get('src/effects/b.js'), scene('b'), 'the committed ones alone may come in');
    assert.deepEqual(checkDrift(root, manifest).uncommitted, ['src/effects/a.js', 'LICENSE']);
    // The flag takes them as they are.
    assert.equal(readOriginals(root, sources, { allowUncommitted: true }).get('src/effects/a.js'), scene('a v2'));
    // Committed again: taken.
    git('commit', '-q', '-am', 'second');
    assert.equal(readOriginals(root, sources).get('src/effects/a.js'), scene('a v2'));
    // Not a git checkout: git cannot say, so refused unless told to.
    rmSync(join(root, '.git'), { recursive: true, force: true });
    assert.equal(uncommittedSources(root, sources), null);
    assert.throws(() => readOriginals(root, sources), /Cannot tell/);
    assert.equal(checkDrift(root, manifest).uncommitted, null);
    assert.ok(readOriginals(root, sources, { allowUncommitted: true }).get('LICENSE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // The import itself reads its originals through that check, before writing.
  const script = readFileSync(join(REPO, 'scripts', 'import_psychedelia.mjs'), 'utf8');
  const main = script.slice(script.indexOf('function main()'));
  assert.ok(main.indexOf('readOriginals(') > 0 && main.indexOf('readOriginals(') < main.indexOf('writeFileSync('), 'checked before anything is written');
  assert.match(main, /allowUncommitted: flags\.includes\('--allow-uncommitted'\)/);
  assert.doesNotMatch(main, /readFileSync\(join\(root/, 'no original read around the check');
});

test('the wrapper keeps strict-mode code, scope and the original as is', () => {
  const { text, entry } = wrap({
    source: 'src/effects/demo.js',
    original: "/* demo */\r\nvar Demo = (function () { return typeof Missing === 'undefined' ? 'caf\u00e9' : 0; })();\r\nRenderer.go();",
    globals: ['Demo', 'Renderer', 'Missing', 'Unused'],
  });
  assert.deepEqual(entry.needs, ['Renderer', 'Missing']);
  assert.deepEqual(entry.provides, ['Demo']);
  assert.equal(entry.asciiEscapes, 1);
  assert.ok(text.includes('\r\n'), 'CRLF like the rest of src/');
  const lf = toLf(text);
  assert.match(lf, /^var Renderer = G\.Renderer;$/m);
  assert.doesNotMatch(lf, /^var Unused/m);
  assert.match(lf, /return \{ Demo: Demo \};/);
  // Runs: the module scope is its own, globals come from G.
  let went = 0;
  const load = new Function(lf.replace('export default function load(G)', 'return function load(G)'))();
  assert.equal(load({ Renderer: { go: () => { went += 1; } } }).Demo, 'caf\u00e9');
  assert.equal(went, 1);
});

test('new visualizer files are ASCII only', async () => {
  for (const path of [
    'src/lib/visualizer-settings.js', 'src/modes/visualizer.js', 'src/visualizer/index.js', 'src/visualizer/loop.js',
    'src/visualizer/scene-renderer.js', 'src/visualizer/size.js', 'src/visualizer/visualizer.js', 'src/visualizer/visualizer.css',
    'scripts/import_psychedelia.mjs', 'tests/visualizer.test.js', 'tests/visualizer-signal.test.js',
    'tests/helpers/signal-harness.js', 'src/lib/audio-signal.js',
    'src/visualizer/flash-limiter.js', 'src/visualizer/reactor.js', 'src/visualizer/scenes.js',
    'src/visualizer/scene-switcher.js', 'tests/helpers/visualizer-fakes.js', 'tests/visualizer-slice2.test.js',
  ]) {
    assert.ok(/^[\x00-\x7f]*$/.test(await read(path)), `${path} has non-ASCII characters`);
  }
});
