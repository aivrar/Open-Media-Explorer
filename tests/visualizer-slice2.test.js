import test from 'node:test';
import { HUD_FADE_MS } from '../src/visualizer/hud.js';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import {
  DEFAULT_VISUALIZER_BRIGHTNESS, DEFAULT_VISUALIZER_DEBUG, DEFAULT_VISUALIZER_FPS, DEFAULT_VISUALIZER_SCENE,
  VISUALIZER_FRAME_RATES, normalizeVisualizerBrightness, normalizeVisualizerFps, normalizeVisualizerScene,
} from '../src/lib/visualizer-settings.js';
import { STORAGE_KEYS, normalizeSettings } from '../src/lib/state.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { LOOP_MODES, MIN_REACT_FPS, createVisualizerLoop } from '../src/visualizer/loop.js';
import {
  COMPILE_LIMIT_MS, COMPILE_POLL_MS, createSceneRenderer, readsBeatClock,
} from '../src/visualizer/scene-renderer.js';
import { createSceneSwitcher } from '../src/visualizer/scene-switcher.js';
import {
  COST_CLASSES, DEFAULT_SCENE, HELD_SCENE_ENTRIES, SCENES, orderedScenes, sceneById, stepScene,
} from '../src/visualizer/scenes.js';
import {
  FLASH_LIMITS, LEVEL_CHANNELS, PULSE_CHANNELS, createFlashLimiter,
} from '../src/visualizer/flash-limiter.js';
import {
  IDLE_BPM, PSYCHEDELIA_DB, applyLinks, bytesToDb, clockScaled, createAudioAdapter, createReactorBridge,
  linkRuleViolation, usableLinks,
} from '../src/visualizer/reactor.js';
import {
  DEBUG_INTERVAL_MS, MESSAGES, debugText, isDebugKey, mountVisualizer,
} from '../src/visualizer/index.js';
import { ALL_SCENE_FILES, ENDLESS_FILES, FILES, VENDOR_DIR } from '../scripts/import_psychedelia.mjs';
import { createClockHarness, fakeAnalyser, fakeVisibilityDoc } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 2 of the visualizer: its own frame rate, brightness, ten more scenes
   chosen in the tab (each its own chunk), Psychedelia's Beat Reactor fed from
   the shared sound signal, the flash limiter and the developer strip.
   Everything here runs without a GPU and on fake clocks. */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`,
);
const LAYOUT = { width: 1280, height: 720 };

/** An analyser with a kick drum: on a hit the bins from about 23 to 190 Hz
 *  jump from -75 to -25 dB; everything else stays near the floor. */
function drumAnalyser() {
  const node = fakeAnalyser({ level: 60, db: -85 });
  node.hit = false;
  node.byteCalls = 0;
  const bass = (index) => index >= 1 && index <= 8;
  node.getByteFrequencyData = (data) => {
    node.byteCalls += 1;
    for (let index = 0; index < data.length; index += 1) data[index] = bass(index) ? (node.hit ? 240 : 60) : 0;
  };
  node.getFloatFrequencyData = (data) => {
    node.floatCalls += 1;
    for (let index = 0; index < data.length; index += 1) data[index] = bass(index) ? (node.hit ? -25 : -75) : -85;
  };
  return node;
}

function playerSource(node) {
  return {
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    release() {},
  };
}

/** Drive `ms` of drumming at `bpm` (a hit lasts 60 ms). */
function drum(h, node, ms, bpm = 120) {
  const period = 60000 / bpm;
  const end = h.now + ms;
  while (h.now < end) {
    node.hit = h.now % period < 60;
    h.run(10);
  }
  node.hit = false;
}

/* ---------------- Settings ---------------- */

test('frame rate, brightness, scene and the developer strip are settings fields with safe defaults', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.visualizerFps, 30);
  assert.equal(DEFAULT_VISUALIZER_FPS, 30);
  assert.deepEqual(VISUALIZER_FRAME_RATES, [15, 30, 60]);
  assert.equal(defaults.visualizerBrightness, 100);
  assert.equal(DEFAULT_VISUALIZER_BRIGHTNESS, 100);
  assert.equal(defaults.visualizerScene, 'plasma');
  assert.equal(DEFAULT_VISUALIZER_SCENE, DEFAULT_SCENE);
  assert.equal(defaults.visualizerDebug, false);
  assert.equal(DEFAULT_VISUALIZER_DEBUG, false);
  assert.equal(defaults.visualizerShowFps, false);
  // Frame rate: one of the three, as a number or as the same number in text.
  for (const value of [15, 30, 60]) assert.equal(normalizeSettings({ visualizerFps: value }).visualizerFps, value);
  assert.equal(normalizeVisualizerFps('60'), 60);
  assert.equal(normalizeVisualizerFps(' 15 '), 15);
  for (const value of [45, 0, -30, 120, 29.9, '', 'fast', null, undefined, NaN, Infinity, {}, [60], true]) {
    assert.equal(normalizeVisualizerFps(value), 30, `fps ${String(value)}`);
    assert.equal(normalizeSettings({ visualizerFps: value }).visualizerFps, 30);
  }
  // Brightness: a whole percent, 30..100.
  assert.equal(normalizeVisualizerBrightness(55), 55);
  assert.equal(normalizeVisualizerBrightness('70'), 70);
  assert.equal(normalizeVisualizerBrightness(57.4), 57);
  assert.equal(normalizeVisualizerBrightness(10), 30, 'never darker than 30 %');
  assert.equal(normalizeVisualizerBrightness(0), 30);
  assert.equal(normalizeVisualizerBrightness(-5), 30);
  assert.equal(normalizeVisualizerBrightness(250), 100);
  for (const value of [null, undefined, NaN, Infinity, 'dim', '', {}, true]) {
    assert.equal(normalizeVisualizerBrightness(value), 100, `brightness ${String(value)}`);
  }
  assert.equal(normalizeSettings({ visualizerBrightness: 12 }).visualizerBrightness, 30);
  // Scene: an id of the right shape is kept (a later build's scene survives),
  // anything else is Plasma.
  assert.equal(normalizeVisualizerScene('tunnel'), 'tunnel');
  assert.equal(normalizeVisualizerScene('some_later_scene'), 'some_later_scene');
  for (const value of ['Tunnel', '../tunnel', 'tun nel', '', '1abc', 'a'.repeat(60), 5, null, {}, ['tunnel']]) {
    assert.equal(normalizeVisualizerScene(value), 'plasma', `scene ${String(value)}`);
  }
  // Developer strip: only a real true turns it on.
  for (const value of ['true', 1, 'yes', {}, null]) assert.equal(normalizeSettings({ visualizerDebug: value }).visualizerDebug, false);
  assert.equal(normalizeSettings({ visualizerDebug: true }).visualizerDebug, true);
  // A round trip, and through an older build that keeps unknown fields.
  const saved = JSON.stringify(normalizeSettings({
    visualizerFps: 60, visualizerBrightness: 45, visualizerScene: 'voronoi', visualizerDebug: true,
  }));
  const back = normalizeSettings({ ...JSON.parse(saved), version: 1 });
  assert.deepEqual(
    [back.visualizerFps, back.visualizerBrightness, back.visualizerScene, back.visualizerDebug],
    [60, 45, 'voronoi', true],
  );
  // Still no new storage or profile key.
  assert.ok(!Object.values(STORAGE_KEYS).some((key) => /visual/i.test(key)));
  assert.ok(!PROFILE_STORAGE_KEYS.some((key) => /visual/i.test(key)));
});

/* ---------------- Frame rate through the signal ---------------- */

test('the chosen frame rate paces the drawing through the shared signal; the meter keeps its 15 and there is one read a tick', () => {
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const motion = fakeMotion(false);
  const node = drumAnalyser();
  const source = playerSource(node);
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const meter = [];
  signal.subscribe((frame) => meter.push(h.now), { fps: 15 });
  const bridge = createReactorBridge();
  const draws = [];
  const loop = createVisualizerLoop({
    signal, fps: 15, react: bridge.react, draw: () => draws.push(h.now), doc: vis.doc, win: motion.win, ...h.io,
  });
  loop.start();
  source.playing = true;
  signal.refresh();
  h.run(500);
  assert.equal(loop.mode, LOOP_MODES.live);
  for (const fps of [15, 30, 60, 30, 15]) {
    loop.setFps(fps);
    assert.equal(loop.targetFps, fps);
    h.run(1000); // settle on the new pace
    const [drawn, metered, bytes, floats, readings] = [draws.length, meter.length, node.byteCalls, node.floatCalls, bridge.adapter.stats.readings];
    h.run(1000);
    near(draws.length - drawn, fps, 2, `${fps} fps drawn`);
    near(meter.length - metered, 15, 1, `the meter at ${fps}`);
    // One shared read a tick: the signal ticks at the fastest asked for -
    // and the reactor asks for at least MIN_REACT_FPS whatever is drawn.
    const fed = Math.max(fps, MIN_REACT_FPS);
    assert.ok(node.byteCalls - bytes <= fed + 1, `${node.byteCalls - bytes} spectrum reads at ${fps}`);
    // The float spectrum only when the visualizer is due, and the reactor
    // reads it once a frame it is fed (no analyser of its own).
    near(node.floatCalls - floats, fed, 2, `float reads at ${fps}`);
    near(bridge.adapter.stats.readings - readings, fed, 2, 'one reading a fed frame');
  }
  assert.equal(signal.subscriberCount, 2, 'resubscribing changed the rate in place');
  assert.equal(normalizeVisualizerFps(loop.targetFps), 15);
  // Bad values from anywhere end up as 30.
  loop.setFps('ninety');
  assert.equal(loop.targetFps, 30);
  loop.destroy();
  assert.equal(signal.subscriberCount, 1, 'only the meter is left');
});

/* ---------------- The flash limiter ---------------- */

test('flash limiter: pulse depth is capped and a level can swell but not snap', () => {
  const limiter = createFlashLimiter();
  assert.deepEqual([...PULSE_CHANNELS], ['kick', 'snare', 'hat', 'beat', 'flash']);
  assert.deepEqual([...LEVEL_CHANNELS], ['bass', 'mid', 'high', 'level']);
  let out = limiter.step(0, { kick: 1, snare: 0.9, hat: 0.3, beat: 2, flash: 1 });
  assert.equal(out.kick, FLASH_LIMITS.maxPulseDepth);
  assert.equal(out.snare, 0.6);
  assert.equal(out.hat, 0.3, 'small values pass as they are');
  assert.equal(out.beat, 0.6, 'out of range values are clamped first');
  // Bad input is silence.
  out = limiter.step(0.02, { kick: NaN, snare: -1, hat: 'x', bass: undefined });
  for (const name of [...PULSE_CHANNELS, ...LEVEL_CHANNELS]) assert.equal(out[name], 0, name);
  // A level that jumps from 0 to 1 is held within maxLevelSwing of its
  // running average and catches up over about a second.
  const levels = createFlashLimiter();
  levels.step(0, { bass: 0 });
  out = levels.step(1 / 60, { bass: 1 });
  assert.ok(out.bass <= FLASH_LIMITS.maxLevelSwing + 0.02, `jump held at ${out.bass}`);
  for (let frame = 2; frame <= 180; frame += 1) out = levels.step(frame / 60, { bass: 1 });
  assert.ok(out.bass > 0.95, `swelled to ${out.bass} in 3 s`);
  // A slow swell passes untouched.
  const slow = createFlashLimiter();
  for (let frame = 0; frame <= 600; frame += 1) {
    const value = frame / 600;
    out = slow.step(frame / 60, { mid: value });
    assert.ok(Math.abs(out.mid - value) < 0.05, `slow swell at ${value}: ${out.mid}`);
  }
  assert.equal(slow.stats.held, 0);
});

test('flash limiter: at most three large pulses a second, whatever comes in', () => {
  // Hits at 8 a second, each a one-frame spike of the full kick, at 60 fps.
  const limiter = createFlashLimiter();
  const crossings = [];
  let armed = true;
  for (let frame = 0; frame < 600; frame += 1) {
    const now = frame / 60;
    const hit = frame % 8 === 0 ? 1 : (frame % 8 === 1 ? 0.5 : 0);
    const out = limiter.step(now, { kick: hit, snare: hit * 0.8 });
    const drive = Math.max(out.kick, out.snare);
    assert.ok(drive <= FLASH_LIMITS.maxPulseDepth);
    if (drive < FLASH_LIMITS.rearmLevel) armed = true;
    else if (armed && drive >= FLASH_LIMITS.pulseThreshold) { armed = false; crossings.push(now); }
    if (limiter.holding) assert.ok(limiter.drive < FLASH_LIMITS.pulseThreshold, 'held pulses stay below the threshold');
  }
  for (let index = FLASH_LIMITS.maxPulsesPerSecond; index < crossings.length; index += 1) {
    assert.ok(crossings[index] - crossings[index - FLASH_LIMITS.maxPulsesPerSecond] >= 1 - 1e-9, `pulse ${index} keeps to three a second`);
  }
  near(crossings.length, 30, 1, 'three a second over ten seconds');
  assert.ok(limiter.stats.held >= 40, `held ${limiter.stats.held}`);
  // Two a second all pass, and a held note is one pulse, not many.
  const calm = createFlashLimiter();
  for (let frame = 0; frame < 600; frame += 1) calm.step(frame / 60, { kick: frame % 30 < 3 ? 0.9 : 0 });
  assert.equal(calm.stats.pulses, 20);
  assert.equal(calm.stats.held, 0);
  const held = createFlashLimiter();
  for (let frame = 0; frame < 120; frame += 1) held.step(frame / 60, { flash: 0.5 });
  assert.equal(held.stats.pulses, 1);
  // A level swing counts as a pulse too: bass snapping up and down 6 times a second.
  const swings = createFlashLimiter();
  for (let frame = 0; frame < 600; frame += 1) swings.step(frame / 60, { bass: frame % 10 < 3 ? 1 : 0 });
  assert.ok(swings.stats.pulses <= 31, `${swings.stats.pulses} level pulses in 10 s`);
  assert.ok(swings.stats.held > 0);
  // reset() forgets everything.
  swings.reset();
  assert.equal(swings.out.bass, 0);
  assert.equal(swings.holding, false);
});

test('flash limiter: the beat clock is slowed above 180 BPM, continuously', () => {
  const limiter = createFlashLimiter();
  let beats = 0;
  let previous = limiter.beatClock(0, 120);
  const at = (bpm, seconds) => {
    const rates = [];
    for (let frame = 0; frame < seconds * 60; frame += 1) {
      beats += bpm / 60 / 60;
      const value = limiter.beatClock(beats, bpm);
      const step = value - previous;
      assert.ok(step >= 0 && step < 0.1, `no jump (${step}) at ${bpm}`);
      rates.push(step * 60);
      previous = value;
    }
    return rates.at(-1);
  };
  near(at(120, 2), 2, 1e-6, '120 BPM as it is');
  assert.equal(limiter.clockFactor, 1);
  near(at(170, 2), 170 / 60, 1e-6, '170 BPM as it is');
  near(at(240, 2), 2, 1e-6, '240 BPM at half pace');
  assert.equal(limiter.clockFactor, 0.5);
  near(at(400, 2), 400 / 60 / 4, 1e-6, '400 BPM at a quarter');
  near(at(120, 2), 2, 1e-6, 'back to 120');
  assert.equal(limiter.clockFactor, 1);
  // Unknown tempo counts as 120; a clock that goes back (a reset) is followed.
  assert.equal(limiter.beatClock(1.5, 0), 1.5);
  assert.equal(limiter.beatClock(NaN, 120), 1.5, 'nonsense keeps the last value');
});

/** Large pulses seen on each output channel: rising from below the re-arm
 *  level to the threshold, per channel. Returns [{ time, name }]. */
function pulseCounter() {
  const armed = {};
  const seen = [];
  return {
    seen,
    look(now, out, names) {
      for (const name of names) {
        const value = out[name];
        if (armed[name] === undefined) armed[name] = true;
        if (value < FLASH_LIMITS.rearmLevel) armed[name] = true;
        else if (armed[name] && value >= FLASH_LIMITS.pulseThreshold) { armed[name] = false; seen.push({ time: now, name }); }
      }
    },
  };
}

/** No rolling second holds more than `most` of `times` (flashes closer than
 *  the coincidence window count as one). */
function assertRate(times, most, label, slack = 0) {
  const flashes = [];
  for (const time of times) if (!flashes.length || time - flashes.at(-1) > FLASH_LIMITS.coincidenceSeconds + 1e-9) flashes.push(time);
  for (let index = most; index < flashes.length; index += 1) {
    assert.ok(flashes[index] - flashes[index - most] >= 1 - slack - 1e-9, `${label}: more than ${most} in a second near ${flashes[index].toFixed(3)} s`);
  }
  return flashes.length;
}

test('flash limiter: one channel held high cannot hide another channel\'s pulses', () => {
  // A sustained kick at 0.3 (one large pulse, then above the threshold for
  // good) while a hat flips between 0 and 0.6 ten times a second.
  const limiter = createFlashLimiter();
  const counter = pulseCounter();
  for (let frame = 0; frame < 300; frame += 1) {
    const now = frame / 60;
    const out = limiter.step(now, { kick: 0.3, hat: frame % 6 < 3 ? 0.6 : 0 });
    counter.look(now, out, ['kick', 'hat']);
    assert.ok(out.kick >= 0.25, 'the sustained kick itself is left alone');
  }
  const hats = counter.seen.filter((pulse) => pulse.name === 'hat').map((pulse) => pulse.time);
  const all = counter.seen.map((pulse) => pulse.time);
  assert.ok(hats.length >= 1, 'hat pulses are seen at all');
  // Codex's case: five hat pulses in the first half second got through before.
  // Now three (the first one rises with the kick: one flash), then none until
  // the second is over.
  assert.equal(hats.filter((time) => time < 0.5).length, 3);
  assert.equal(hats.filter((time) => time >= 0.5 && time < 1).length, 0);
  const flashes = assertRate(all, 3, 'kick and hat together');
  near(flashes, 15, 1, 'three a second over five seconds, the kick included');
  assert.ok(limiter.stats.held > 20);
});

test('flash limiter: two channels taking turns share one budget', () => {
  // Kick and snare alternate, each hitting four times a second (8 in all).
  const limiter = createFlashLimiter();
  const counter = pulseCounter();
  for (let frame = 0; frame < 600; frame += 1) {
    const now = frame / 60;
    const slot = frame % 15;
    const out = limiter.step(now, { kick: slot < 3 && frame % 30 < 15 ? 0.6 : 0, snare: slot < 3 && frame % 30 >= 15 ? 0.6 : 0 });
    counter.look(now, out, ['kick', 'snare']);
  }
  const flashes = assertRate(counter.seen.map((pulse) => pulse.time), 3, 'kick and snare');
  near(flashes, 30, 1, 'three a second');
  assert.ok(counter.seen.some((pulse) => pulse.name === 'kick') && counter.seen.some((pulse) => pulse.name === 'snare'));
  // A kick that lifts the bass in the same frame is one flash, not two.
  const together = createFlashLimiter();
  together.step(0, { bass: 0 });
  for (let frame = 1; frame < 120; frame += 1) {
    const hit = frame % 30 === 0;
    together.step(frame / 60, { kick: hit ? 0.6 : 0, bass: hit ? 0.6 : 0.1 });
  }
  assert.equal(together.stats.pulses, 3, 'three hits, each one flash on two channels');
  assert.equal(together.stats.held, 0);
});

test('flash limiter: a scene that shows the beat clock gets one cycle a second of the budget, the pulses the other two', () => {
  const limiter = createFlashLimiter();
  assert.equal(limiter.pulseBudget, 3);
  limiter.setClockShown(true);
  assert.equal(limiter.pulseBudget, 2);
  // 120 BPM with a kick on every beat and a hat on every off-beat: 4 hits a
  // second plus the clock.
  const counter = pulseCounter();
  const events = [];
  let beats = 0;
  let previous = limiter.beatClock(0, 120);
  for (let frame = 1; frame <= 600; frame += 1) {
    const now = frame / 60;
    beats += 2 / 60;
    const clock = limiter.beatClock(beats, 120);
    if (Math.floor(clock) > Math.floor(previous)) events.push(now); // fract(u_beat.w) wraps: a ring starts
    assert.ok(clock - previous >= 0 && clock - previous < 0.05, 'continuous');
    previous = clock;
    const out = limiter.step(now, { kick: frame % 30 < 3 ? 0.6 : 0, hat: (frame + 15) % 30 < 3 ? 0.6 : 0 });
    counter.look(now, out, ['kick', 'hat']);
  }
  assert.equal(limiter.clockFactor, 0.5, 'every second beat');
  near(events.length, 10, 1, 'one clock cycle a second');
  assertRate(counter.seen.map((pulse) => pulse.time), 2, 'envelope pulses');
  // (A clock wrap is seen on the first frame after it, so two wraps can look
  // up to a frame closer than a second apart.)
  assertRate([...events, ...counter.seen.map((pulse) => pulse.time)].sort((a, b) => a - b), 3, 'clock and pulses together', 1 / 60);
  // The clock carries on smoothly when the scene changes.
  const before = limiter.beatClock(beats, 120);
  limiter.setClockShown(false);
  beats += 2 / 60;
  const after = limiter.beatClock(beats, 120);
  assert.ok(after - before >= 0 && after - before < 0.05);
  assert.equal(limiter.clockFactor, 1);
  assert.equal(limiter.pulseBudget, 3);
});

test('flash limiter: the time surge swells but does not snap', () => {
  const limiter = createFlashLimiter();
  const speeds = [];
  for (let frame = 0; frame < 240; frame += 1) {
    // The reactor jumping between 1 and 2.8 on every kick, twice a second.
    const out = limiter.step(frame / 60, { speed: frame % 30 < 5 ? 2.8 : 1 });
    speeds.push(out.speed);
  }
  for (let index = 1; index < speeds.length; index += 1) {
    assert.ok(Math.abs(speeds[index] - speeds[index - 1]) <= FLASH_LIMITS.maxSpeedSlew / 60 + 1e-9, `frame ${index}`);
  }
  assert.ok(Math.max(...speeds) < 1.3, `a short push stays a push: ${Math.max(...speeds)}`);
  assert.ok(Math.max(...speeds) > 1.1);
  // A steady surge is reached, at the slew rate; nonsense counts as 1; far too much is capped.
  const steady = createFlashLimiter();
  let out;
  for (let frame = 0; frame <= 120; frame += 1) out = steady.step(frame / 60, { speed: 9 });
  assert.equal(out.speed, FLASH_LIMITS.maxSpeed);
  for (let frame = 121; frame <= 180; frame += 1) out = steady.step(frame / 60, { speed: NaN });
  near(out.speed, 1.5, 0.03, 'easing back down at 1.5 a second');
  for (let frame = 181; frame <= 300; frame += 1) out = steady.step(frame / 60, { speed: 0 });
  assert.equal(out.speed, 1, 'and settling at 1');
  steady.reset();
  assert.equal(steady.out.speed, 1);
});

/* ---------------- The Beat Reactor and its adapter ---------------- */

test('the adapter gives the reactor Psychedelia\'s analysis shape from a signal frame, and silence without one', () => {
  const adapter = createAudioAdapter();
  let reading = adapter.getAnalysis({ time: 3 });
  assert.equal(reading.available, true);
  assert.equal(reading.active, false, 'no frame: nothing to hear');
  assert.equal(reading.time, 3);
  const spectrum = new Uint8Array(1024).fill(100);
  const spectrumDb = new Float32Array(1024).fill(-40);
  const waveform = new Uint8Array(2048).fill(130);
  const frame = {
    active: true, version: 7, spectrum, spectrumDb, waveform, sampleRate: 48000, fftSize: 2048, minDecibels: -85, maxDecibels: -15, time: 9,
  };
  adapter.setFrame(frame);
  reading = adapter.getAnalysis({ time: 4 });
  assert.equal(reading.active, true);
  assert.equal(reading.source, 'player');
  assert.equal(reading.fft, spectrum, 'the signal\'s own arrays, not copies');
  assert.equal(reading.spectrum, spectrum);
  assert.equal(reading.waveform, waveform);
  assert.equal(reading.spectrumDb, spectrumDb);
  assert.equal(reading.byteData, true);
  assert.equal(reading.fftScale, 'normalized-db');
  assert.deepEqual([reading.fftMinDecibels, reading.fftMaxDecibels], [PSYCHEDELIA_DB.min, PSYCHEDELIA_DB.max]);
  assert.deepEqual([PSYCHEDELIA_DB.min, PSYCHEDELIA_DB.max], [-100, -30]);
  assert.deepEqual([reading.sampleRate, reading.fftSize, reading.signalVersion, reading.time], [48000, 2048, 7, 4]);
  assert.equal(adapter.stats.converted, 0);
  // No float spectrum: converted from the bytes on the tap's own -85..-15 span.
  adapter.setFrame({ ...frame, spectrumDb: null, spectrum: Uint8Array.from([0, 255, 128, 1]) });
  reading = adapter.getAnalysis({});
  assert.equal(reading.spectrumDb[0], Number.NEGATIVE_INFINITY, 'byte 0 is nothing');
  near(reading.spectrumDb[1], -15, 1e-4, 'byte 255');
  near(reading.spectrumDb[2], -85 + (128 / 255) * 70, 1e-4, 'byte 128');
  assert.equal(reading.time, 9, 'the frame\'s time when none is given');
  assert.equal(adapter.stats.converted, 1);
  assert.deepEqual([...bytesToDb(Uint8Array.from([0, 255]), -100, -30, new Float32Array(2))], [Number.NEGATIVE_INFINITY, -30]);
  // An inactive frame is silence too.
  adapter.setFrame({ ...frame, active: false });
  assert.equal(adapter.getAnalysis({}).active, false);
  adapter.setFrame(null);
  assert.equal(adapter.getAnalysis({}).active, false);
});

test('fed from the shared signal, the reactor finds the beat and the bass, limited; silence brings everything to rest', () => {
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const motion = fakeMotion(false);
  const node = drumAnalyser();
  const source = playerSource(node);
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const bridge = createReactorBridge();
  const frames = [];
  const loop = createVisualizerLoop({
    signal,
    fps: 30,
    react: bridge.react,
    draw: (state) => frames.push({
      now: h.now, kick: state.beat.kick, bass: state.audio.bass, clock: state.beat.clock, speed: state.speed, sources: state.sources,
    }),
    doc: vis.doc,
    win: motion.win,
    ...h.io,
  });
  loop.start();
  source.playing = true;
  signal.refresh();
  drum(h, node, 12000, 120);
  const snap = bridge.snapshot();
  assert.equal(snap.active, true);
  near(snap.bpm, 120, 2, 'tempo');
  assert.ok(snap.confidence > 0.5, `confidence ${snap.confidence}`);
  assert.ok(snap.bass > snap.mid && snap.bass > snap.treble, 'the kick is bass');
  assert.equal(bridge.reactor.isLive(), true);
  const kicks = frames.map((frame) => frame.kick);
  assert.ok(Math.max(...kicks) <= FLASH_LIMITS.maxPulseDepth, 'kicks no deeper than the cap');
  assert.ok(Math.max(...kicks) > 0.3, 'but they are there');
  assert.equal(bridge.limiter.stats.held, 0, 'two kicks a second pass');
  assert.ok(frames.some((frame) => frame.speed > 1.05), 'the time surge pushes on the beat');
  assert.ok(frames.every((frame) => frame.speed > 0 && frame.speed <= FLASH_LIMITS.maxSpeed));
  for (let index = 1; index < frames.length; index += 1) {
    const dt = (frames[index].now - frames[index - 1].now) / 1000;
    assert.ok(Math.abs(frames[index].speed - frames[index - 1].speed) <= FLASH_LIMITS.maxSpeedSlew * dt + 1e-9, 'the surge is slew-limited');
  }
  assert.ok(bridge.limiter.stats.slewed > 0, 'the reactor\'s own surge is faster than that');
  assert.equal(frames.at(-1).sources, bridge.limiter.out, 'links read the limited values');
  const last = frames.slice(-30);
  near((last.at(-1).clock - last[0].clock) / ((last.at(-1).now - last[0].now) / 1000), 2, 0.1, 'beat clock at 2 a second');
  // The sound stops: the loop goes idle and the reactor hears silence.
  source.playing = false;
  signal.refresh();
  h.run(5000);
  assert.equal(loop.mode, LOOP_MODES.idle);
  const quiet = bridge.snapshot();
  assert.equal(quiet.active, false);
  assert.equal(quiet.bpm, 0);
  for (const name of ['bass', 'mid', 'treble', 'kick', 'snare', 'hat']) assert.ok(quiet[name] < 0.01, `${name} ${quiet[name]}`);
  assert.equal(bridge.reactor.isLive(), false);
  near(frames.at(-1).speed, 1, 1e-9, 'no surge in silence');
  const idle = frames.slice(-10);
  near((idle.at(-1).clock - idle[0].clock) / ((idle.at(-1).now - idle[0].now) / 1000), IDLE_BPM / 60, 0.1, 'the clock runs on at 120 BPM');
  assert.ok(bridge.stats.silent > 0);
  loop.destroy();
});

test('parameter links: only our own table, through the link rule; never Psychedelia\'s automatic suggestions', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 10, height: 10 }, gl, mode: 'webgl2' });
  const bridge = createReactorBridge({ EffectRegistry: renderer.engine.EffectRegistry });
  let linked = 0;
  for (const scene of SCENES) {
    const def = renderer.register(await scene.load(), scene.id);
    assert.deepEqual(bridge.linksFor(def), [], `${scene.id}: no table, no links (Psychedelia's suggestions nudge glow)`);
    const links = bridge.linksFor(def, scene);
    linked += links.length ? 1 : 0;
    assert.equal(links.length, (scene.links || []).length, `${scene.id}: every row of its table passes the rule`);
    assert.deepEqual(bridge.linksFor(def, scene.links || []), links, 'a bare table works the same');
  }
  assert.ok(linked >= 30, `${linked} scenes move through links`);
  assert.deepEqual(bridge.linksFor(null), []);
  // A row that breaks the rule is dropped even from our own table.
  const plasma = renderer.register(await sceneById('plasma').load(), 'plasma');
  const rows = bridge.linksFor(plasma, [{ param: 'brightness', source: 'kick', amount: 0.1 }, { param: 'speed', source: 'kick', amount: 0.1 }, { param: 'scale', source: 'kick', amount: 0.03 }]);
  assert.ok(plasma.params.some((p) => p.name === 'speed'), 'plasma has a speed');
  assert.deepEqual(rows.map((row) => row.param), ['scale']);
  // Pushing and clamping.
  const def = { params: [{ name: 'glow', type: 'float', min: 0, max: 2 }, { name: 'mode', type: 'int', min: 0, max: 4 }] };
  const links = usableLinks(def, [
    { param: 'glow', source: 'kick', amount: 0.08 },
    { param: 'mode', source: 'kick', amount: 0.5 },
    { param: 'glow', source: 'lfo_1', amount: 0.5 },
    { param: 'missing', source: 'bass', amount: 0.5 },
  ]);
  assert.deepEqual(links, [{ param: 'glow', source: 'kick', amount: 0.08, min: 0, max: 2, span: 2 }]);
  const out = {};
  assert.deepEqual(applyLinks({ glow: 1, mode: 2 }, links, { kick: 0.5 }, out), { glow: 1.08, mode: 2 });
  assert.equal(applyLinks({ glow: 1.99, mode: 2 }, links, { kick: 1 }, out).glow, 2, 'clamped to the range');
  assert.equal(applyLinks({ glow: 1, mode: 2 }, links, null, out).glow, 1, 'no sources: the base values');
  renderer.destroy();
});

test('the link rule names what each refused param is', () => {
  const shader = 'uniform float u_speed;\nuniform float u_wave;\nvoid main(){ float t = u_time; float a = t * u_wave; }';
  const def = { shader, specialize: ['style'], params: [] };
  const cases = {
    brightness: 'changes light', glow: 'changes light', contrast: 'changes light', lightning: 'changes light',
    speed: 'a rate', color_speed: 'a rate', rotation: 'a rate', animate_slice: 'a rate',
    zoom_depth: 'moves the view far or in steps', target_x: 'moves the view far or in steps', max_iter: 'moves the view far or in steps',
    wave: 'multiplied by the clock',
    scale: null, twist: null, saturation: null,
  };
  for (const [name, why] of Object.entries(cases)) {
    assert.equal(linkRuleViolation(def, { name, type: 'float', min: 0, max: 1 }), why, name);
  }
  assert.equal(linkRuleViolation(def, { name: 'style', type: 'float', min: 0, max: 1 }), 'compiled in');
  assert.equal(linkRuleViolation(def, { name: 'palette', type: 'select', min: 0, max: 1 }), 'not a number');
  assert.equal(linkRuleViolation(def, { name: 'scale', min: 1, max: 1 }), 'no range');
  assert.equal(linkRuleViolation(def, { name: 'scale', min: 0, max: 2, audioLink: false }), 'Psychedelia marks it not linkable');
  assert.equal(linkRuleViolation(def, undefined), 'no such param');
  assert.equal(clockScaled('float t = u_time * 0.5; float a = t * u_wave;', 'wave'), true, 'through a clock variable');
  assert.equal(clockScaled('float a = u_wave * u_time;', 'wave'), true);
  assert.equal(clockScaled('float a = u_wave * 2.0;', 'wave'), false);
});

/* ---------------- Scenes ---------------- */

test('every scene is a lazily loaded vendored file that registers under its id, compiles and draws; old programs are freed', async () => {
  // 79 ported; eight 3D flights held (scenes.js HELD_SCENES).
  assert.equal(SCENES.length, 71);
  assert.equal(HELD_SCENE_ENTRIES.length, 8);
  assert.equal(SCENES[0].id, 'plasma');
  assert.equal(new Set(SCENES.map((scene) => scene.id)).size, SCENES.length);
  const scenesJs = readFileSync(join(REPO, 'src', 'visualizer', 'scenes.js'), 'utf8');
  const imports = [...scenesJs.matchAll(/import\('\.\/vendor\/psychedelia\/(effects\/[a-z-]+\.js)'\)/g)].map((match) => match[1]);
  // One literal import per scene file (one chunk each); the endless scenes
  // share theirs (endless-scenes.js four, endless-sky-crystal.js three).
  const files = [...new Set([...SCENES, ...HELD_SCENE_ENTRIES].map((scene) => scene.file))];
  assert.deepEqual([...imports].sort(), [...files].sort(), 'one literal import per scene file: one chunk each');
  assert.deepEqual(ALL_SCENE_FILES.map((name) => `effects/${name}.js`).sort(), [...files].sort(), 'the import script vendors exactly these');
  const shared = SCENES.filter((scene) => SCENES.some((other) => other !== scene && other.file === scene.file)).map((scene) => scene.file);
  assert.deepEqual([...new Set(shared)], ENDLESS_FILES.map((name) => `effects/${name}.js`), 'only the endless scenes share a file');
  for (const scene of SCENES) {
    assert.ok(FILES.some((file) => file.target === scene.file), `${scene.file} in the manifest`);
    assert.ok(existsSync(join(VENDOR_DIR, ...scene.file.split('/'))), `${scene.file} vendored`);
    assert.ok(COST_CLASSES.includes(scene.cost), `${scene.id}: ${scene.cost}`);
    assert.ok(['links', 'shader', 'motion'].includes(scene.audio));
    assert.equal(typeof scene.category, 'string');
    assert.equal(sceneById(scene.id), scene);
    // Only the registry and the flight helpers (and EndlessScenes, from
    // endless-scenes.js): no scene file may need the renderer, the reactor
    // or Studio.
    const text = readFileSync(join(VENDOR_DIR, ...scene.file.split('/')), 'utf8');
    const needs = [...text.matchAll(/^var (\w+) = G\.\1;$/gm)].map((match) => match[1]);
    assert.ok(needs.length && needs.every((name) => ['EffectRegistry', 'FractalFlight', 'EndlessScenes'].includes(name)), `${scene.id} needs ${needs.join(', ')}`);
  }
  const leftOut = ['cymatics', 'feedback-loop', 'escape-time-lab', 'fractal-flame-lab', 'physarum', 'lissajous'];
  assert.ok(!SCENES.some((scene) => leftOut.some((name) => scene.file === `effects/${name}.js`)), 'left-out scenes stay out');
  assert.equal(sceneById('nope'), null);
  assert.equal(stepScene('plasma', -1), SCENES.at(-1).id, 'previous wraps round');
  assert.equal(stepScene(SCENES.at(-1).id, 1), 'plasma', 'next wraps round');
  assert.equal(stepScene('unknown', 1), 'tunnel');
  // Compile and draw every one through one renderer, one context.
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 64, height: 36 }, gl, mode: 'webgl2' });
  for (const scene of SCENES) {
    const def = renderer.register(await scene.load(), scene.id);
    assert.ok(def, `${scene.id} registers under its id`);
    assert.equal(def.name, scene.id);
    renderer.useSceneNow(def);
    const audio = { bass: 0.5, mid: 0.2, high: 0.1, level: 0.4 };
    assert.equal(renderer.draw({ time: 1, audio, beat: { kick: 0.3, clock: 2 }, sources: { kick: 0.3, bass: 0.5 } }), true, `${scene.id} draws`);
    if (scene.audio === 'shader') assert.match(gl.current.fragment, /u_audio|u_beat/, `${scene.id} reads the sound itself`);
    assert.equal(gl.programs.size, 1, `${scene.id}: the old program was deleted`);
  }
  assert.equal(renderer.stats.deleted, SCENES.length - 1);
  // The endless engine's own scenes are registered too when a sky scene is
  // loaded first (endless-sky-crystal.js loads it on the same registry).
  renderer.destroy();
  assert.equal(gl.programs.size, 0);
  assert.equal(gl.buffers.size, 0);
});

test('a compile that fails half way deletes whatever it had made', async (t) => {
  t.mock.method(console, 'error', () => {});
  const plasma = await sceneById('plasma').load();
  for (const [label, breakIt] of [
    ['no fragment shader', (gl) => { const make = gl.createShader.bind(gl); gl.createShader = (type) => (type === gl.FRAGMENT_SHADER ? null : make(type)); }],
    ['no vertex shader', (gl) => { const make = gl.createShader.bind(gl); gl.createShader = (type) => (type === gl.VERTEX_SHADER ? null : make(type)); }],
    ['no program', (gl) => { gl.createProgram = () => null; }],
    ['the driver throws', (gl) => { gl.compileShader = () => { throw new Error('driver'); }; }],
  ]) {
    for (const parallel of [false, true]) {
      const gl = new FakeGL({ parallel });
      const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl, mode: 'webgl2' });
      const prepared = renderer.prepare(renderer.register(plasma, 'plasma'));
      breakIt(gl);
      let result;
      // Without parallel compile it starts a moment later (the note first):
      // a timer that runs at once here.
      const job = renderer.compile(prepared, (program) => { result = program; }, { setTimer: (fn) => { fn(); return 1; }, clearTimer() {} });
      if (parallel) assert.equal(job, null, `${label}: finished on the spot`);
      else assert.equal(job.pending, false, `${label}: finished`);
      assert.equal(result, null, `${label}: no program`);
      assert.equal(gl.shaders.size, 0, `${label}: no shader left (parallel ${parallel})`);
      assert.equal(gl.programs.size, 0, `${label}: no program left`);
      assert.equal(renderer.compileNow(prepared), null);
      assert.equal(gl.shaders.size + gl.programs.size, 0);
      renderer.destroy();
    }
  }
});

test('which scenes show the beat clock as a pulse, and the limiter is told on every scene change', async () => {
  assert.equal(readsBeatClock('uniform vec4 u_beat;\nfloat r = fract(u_beat.w);'), true);
  assert.equal(readsBeatClock('uniform vec4 u_beat;\nvec2 b = u_beat.zw;'), true);
  assert.equal(readsBeatClock('uniform vec4 u_beat;\nvec4 b = f(u_beat);'), true, 'passed on whole');
  assert.equal(readsBeatClock('uniform vec4 u_beat;\nfloat k = u_beat.x + u_beat.z;'), false);
  assert.equal(readsBeatClock('uniform vec4 u_beat;'), false, 'declared only');
  assert.equal(readsBeatClock(''), false);
  const m = await mount();
  const { session } = m;
  const shown = {};
  for (const id of ['islamic_stars', 'domain_colouring', 'spiral_galaxy', 'plasma']) {
    m.pick(id);
    await m.until(() => session.switcher.current === id, id);
    shown[id] = session.bridge.limiter.clockShown;
  }
  assert.deepEqual(shown, {
    islamic_stars: true, domain_colouring: true, spiral_galaxy: false, plasma: false,
  });
  session.destroy();
});

/** Scenes whose chunks arrive when the test says so. */
function deferredScenes(base = SCENES) {
  const waiting = [];
  const loads = new Map();
  const scenes = base.map((scene) => ({
    ...scene,
    load: () => {
      loads.set(scene.id, (loads.get(scene.id) || 0) + 1);
      return new Promise((resolveLoad, rejectLoad) => waiting.push({ id: scene.id, resolve: () => resolveLoad(scene.load()), reject: rejectLoad }));
    },
  }));
  return {
    scenes,
    waiting,
    loads,
    release(id) {
      const at = waiting.findIndex((entry) => entry.id === id);
      assert.ok(at >= 0, `${id} is loading`);
      waiting.splice(at, 1)[0].resolve();
    },
  };
}

async function mount({
  settings = {}, scenes = SCENES, parallel = false, reduced = false, layout = LAYOUT, wait = true,
} = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(layout);
  const motion = fakeMotion(reduced);
  const win = fakeResizeObserverWin(motion);
  const node = drumAnalyser();
  const source = playerSource(node);
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL({ parallel });
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
    createContext: () => { contexts += 1; return { gl, mode: 'webgl2' }; },
    scenes,
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
  });
  const m = {
    h, vis, motion, win, node, source, signal, gl, saved, settingsListeners, root, session,
    controls: session.controls,
    get contexts() { return contexts; },
    apply(partial) { current = normalizeSettings({ ...current, ...partial }); for (const fn of settingsListeners) fn(current); },
    /** Choose a scene in the list, as a click on it does. */
    pick(id) { session.sceneList.pick(id); },
    /** Let chunks arrive and compile polls run until `done()`. */
    async until(done, label = 'condition') {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        h.run(COMPILE_POLL_MS);
      }
      assert.fail(`never reached: ${label}`);
    },
  };
  if (wait) {
    if (parallel) {
      await m.until(() => session.switcher.compiling || Boolean(session.switcher.current), 'compiling');
      gl.finishCompiles();
    }
    await m.until(() => Boolean(session.switcher.current), 'first scene');
  }
  return m;
}

/** The list's order (category, then name), and the scene `step` places
 *  after `id` in it. */
const ORDER = orderedScenes(SCENES).map((scene) => scene.id);
const after = (id, step) => ORDER[(((ORDER.indexOf(id) + step) % ORDER.length) + ORDER.length) % ORDER.length];

test('the scene chooser: list, previous and next, remembered in the settings', async () => {
  const m = await mount();
  const { session, controls, gl } = m;
  const list = session.sceneList;
  assert.equal(session.switcher.current, 'plasma');
  assert.equal(list.value, 'plasma');
  assert.equal(list.options.get('plasma').getAttribute('aria-selected'), 'true');
  assert.deepEqual([...list.options.keys()], ORDER, 'every scene, by category then name');
  assert.equal(controls.prev.getAttribute('aria-label'), 'Previous scene');
  assert.equal(controls.next.getAttribute('aria-label'), 'Next scene');
  assert.match(controls.sceneButton.getAttribute('aria-label'), /^Scene: Plasma, Light$/);
  // Next follows the list's order.
  controls.next.dispatchEvent(new Event('click'));
  const second = after('plasma', 1);
  assert.deepEqual(m.saved.at(-1), { visualizerScene: second });
  await m.until(() => session.switcher.current === second);
  assert.equal(list.value, second);
  assert.equal(list.options.get('plasma').getAttribute('aria-selected'), 'false');
  assert.match(session.canvas.getAttribute('aria-label'), new RegExp(`^${sceneById(second).name}`));
  // Previous from the first in the list wraps round to the last one.
  m.pick(ORDER[0]);
  await m.until(() => session.switcher.current === ORDER[0]);
  controls.prev.dispatchEvent(new Event('click'));
  assert.deepEqual(m.saved.at(-1), { visualizerScene: ORDER.at(-1) });
  await m.until(() => session.switcher.current === ORDER.at(-1));
  // The list.
  m.pick('voronoi');
  assert.deepEqual(m.saved.at(-1), { visualizerScene: 'voronoi' });
  await m.until(() => session.switcher.current === 'voronoi');
  assert.equal(gl.programs.size, 1, 'one program at a time');
  assert.equal(m.contexts, 1, 'one context');
  // A setting changed elsewhere (another window, a restored backup).
  m.apply({ visualizerScene: 'starfield' });
  await m.until(() => session.switcher.current === 'starfield');
  session.destroy();
  // Opening the tab again shows the remembered scene first; Plasma is not even loaded.
  const deferred = deferredScenes();
  const again = await mount({ settings: { visualizerScene: 'metaballs' }, scenes: deferred.scenes, wait: false });
  assert.deepEqual([...deferred.loads.keys()], ['metaballs']);
  deferred.release('metaballs');
  await again.until(() => again.session.switcher.current === 'metaballs');
  assert.equal(again.session.sceneList.value, 'metaballs');
  again.session.destroy();
  // An id this build does not have shows Plasma (and keeps the setting).
  const unknown = await mount({ settings: { visualizerScene: 'from_a_later_build' } });
  assert.equal(unknown.session.switcher.current, 'plasma');
  assert.equal(unknown.saved.length, 0, 'nothing rewritten');
  unknown.session.destroy();
});

test('rapid switching: only the last scene asked for is installed, late chunks are ignored', async () => {
  const deferred = deferredScenes();
  const m = await mount({ scenes: deferred.scenes, wait: false });
  const { session, gl } = m;
  deferred.release('plasma');
  await m.until(() => session.switcher.current === 'plasma');
  const installs = session.renderer.stats.installs;
  // Four clicks on Next before any chunk arrives.
  for (let click = 0; click < 4; click += 1) m.controls.next.dispatchEvent(new Event('click'));
  const steps = [1, 2, 3, 4].map((step) => after('plasma', step));
  const last = steps.at(-1);
  assert.equal(session.switcher.wanted, last);
  assert.equal(session.switcher.current, 'plasma', 'the old scene keeps being drawn meanwhile');
  // They arrive out of order: the wanted one, then the stale ones.
  deferred.release(last);
  await m.until(() => session.switcher.current === last);
  for (const id of steps.slice(0, 3)) deferred.release(id);
  await settle(() => false, 40);
  assert.equal(session.switcher.current, last);
  assert.equal(session.renderer.stats.installs, installs + 1, 'nothing installed late');
  assert.equal(session.switcher.stats.abandoned, 3);
  assert.equal(gl.programs.size, 1, 'no program made for an abandoned scene');
  assert.equal(m.saved.at(-1).visualizerScene, last);
  // Back and forth to the scene being drawn: nothing to load.
  m.controls.next.dispatchEvent(new Event('click'));
  m.controls.prev.dispatchEvent(new Event('click'));
  assert.equal(session.switcher.current, last);
  assert.equal(session.switcher.busy, false);
  deferred.release(after(last, 1));
  await settle(() => false, 40);
  assert.equal(session.switcher.current, last);
  session.destroy();
});

test('a background compile is polled on one timer, cancelled when superseded, and dropped after its time limit', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = await mount({ parallel: true });
  const { session, gl, h } = m;
  assert.equal(session.switcher.current, 'plasma');
  assert.equal(gl.extensionAsks.get('KHR_parallel_shader_compile'), 1);
  // Tunnel compiles in the background while Plasma is still drawn.
  m.pick('tunnel');
  await m.until(() => session.switcher.compiling, 'tunnel compiling');
  const checks = gl.statusChecks;
  h.run(COMPILE_POLL_MS * 5);
  assert.ok(gl.statusChecks - checks >= 4, 'polled');
  assert.ok(h.liveTimers().filter((timer) => timer.ms === COMPILE_POLL_MS).length <= 1, 'one poll timer at a time');
  assert.equal(session.switcher.current, 'plasma');
  assert.equal(gl.programs.size, 2, 'plasma, and tunnel half made');
  // Superseded: starfield. Tunnel's poll stops at once, but its half-made
  // program is only deleted once its link has ended (deleting a program
  // mid-link is what made the driver warn on rapid switching).
  m.pick('starfield');
  assert.equal(session.switcher.compiling, false);
  assert.equal(session.renderer.stats.abandoned, 1);
  assert.equal(session.renderer.buried, 1, 'tunnel waits for its link');
  assert.equal(gl.programs.size, 2, 'not deleted mid-link');
  await m.until(() => session.switcher.compiling, 'starfield compiling');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'starfield');
  await m.until(() => session.renderer.buried === 0, 'tunnel deleted after its link');
  assert.equal(gl.programs.size, 1);
  // A compile that never finishes is dropped after the limit; the current scene stays.
  m.pick('metaballs');
  await m.until(() => session.switcher.compiling, 'metaballs compiling');
  h.run(COMPILE_LIMIT_MS + 1000);
  await settle(() => !session.switcher.compiling, 20);
  assert.equal(session.switcher.current, 'starfield');
  assert.equal(session.message.textContent, MESSAGES.sceneFailed);
  assert.equal(m.session.sceneList.value, 'starfield', 'the list shows what is drawn');
  // Its program waits one more limit for the link to end, then goes anyway.
  assert.equal(session.renderer.buried, 1);
  h.run(COMPILE_LIMIT_MS + 1000);
  assert.equal(session.renderer.buried, 0);
  assert.equal(gl.programs.size, 1);
  // The next good scene clears the message.
  m.pick('voronoi');
  await m.until(() => session.switcher.compiling, 'voronoi compiling');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'voronoi');
  assert.equal(session.message.hidden, true);
  assert.equal(gl.extensionAsks.get('KHR_parallel_shader_compile'), 1, 'one context, asked once');
  session.destroy();
  assert.equal(h.pending(), 0);
});

test('a scene that cannot load keeps the current one; with nothing shown yet, Plasma is used', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = { id: 'broken', name: 'Broken', file: 'effects/broken.js', cost: 'light', audio: 'links', load: () => Promise.reject(new Error('chunk missing')) };
  const scenes = [...SCENES, broken];
  const m = await mount({ scenes });
  m.pick('broken');
  await settle(() => m.session.message.textContent === MESSAGES.sceneFailed, 100);
  assert.equal(m.session.message.textContent, MESSAGES.sceneFailed);
  assert.equal(m.session.switcher.current, 'plasma');
  assert.equal(m.session.sceneList.value, 'plasma');
  m.session.destroy();
  const first = await mount({ scenes, settings: { visualizerScene: 'broken' } });
  assert.equal(first.session.switcher.current, 'plasma');
  assert.equal(first.session.message.hidden, true);
  first.session.destroy();
});

test('leaving the tab abandons a chunk still loading and a compile still running: nothing mounts late', async () => {
  // A chunk still on its way.
  const deferred = deferredScenes();
  const m = await mount({ scenes: deferred.scenes, wait: false });
  assert.equal(deferred.waiting.length, 1);
  m.session.destroy();
  deferred.release('plasma');
  await settle(() => false, 40);
  assert.equal(m.session.switcher.current, null);
  assert.equal(m.session.switcher.stats.abandoned, 1);
  assert.equal(m.gl.programs.size, 0, 'no program made after leaving');
  assert.equal(m.gl.loseCount, 1);
  assert.equal(m.h.pending(), 0);
  assert.equal(m.signal.subscriberCount, 0);
  // A compile waiting on the browser.
  const k = await mount({ parallel: true, wait: false });
  await k.until(() => k.session.switcher.compiling, 'compiling');
  assert.equal(k.gl.programs.size, 1);
  k.session.destroy();
  // Not deleted mid-link: giving the context back frees it with the rest.
  assert.equal(k.gl.loseCount, 1, 'the context is given back');
  assert.equal(k.h.pending(), 0, 'its poll timer is stopped, and no graveyard timer');
  k.gl.finishCompiles();
  k.h.run(1000);
  assert.equal(k.session.switcher.current, null);
  assert.equal(k.gl.draws, 0);
});

test('a lost context cancels a scene change in flight and asks for it again once restored', async () => {
  const m = await mount({ parallel: true });
  const { session, gl, h } = m;
  m.pick('tunnel');
  await m.until(() => session.switcher.compiling, 'tunnel compiling');
  session.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(session.switcher.compiling, false);
  assert.equal(h.liveTimers().filter((timer) => timer.ms === COMPILE_POLL_MS).length, 0, 'no poll while lost');
  gl.programs.clear();
  const compiles = session.renderer.stats.compiles;
  session.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(session.renderer.stats.compiles, compiles, 'nothing compiled on the spot (it would block)');
  assert.equal(session.switcher.current, null, 'plasma went with the old context');
  await m.until(() => session.switcher.compiling, 'tunnel compiling again');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'tunnel');
  assert.equal(m.contexts, 1);
  session.destroy();
});

test('after a context restore the scene drawn is compiled again without blocking; if it cannot be, Plasma, and the loop runs again', async (t) => {
  const m = await mount({ parallel: true });
  const { session, gl, h } = m;
  m.pick('tunnel');
  await m.until(() => session.switcher.compiling, 'tunnel compiling');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'tunnel');
  session.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(session.loop.mode, LOOP_MODES.paused);
  gl.programs.clear();
  // The restored context refuses the next fragment shader (Tunnel's, asked
  // for again); Plasma's after it compiles.
  let refuse = 1;
  gl.getShaderParameter = (shader) => {
    if (shader.type === gl.FRAGMENT_SHADER && refuse > 0) { refuse -= 1; return false; }
    return true;
  };
  t.mock.method(console, 'error', () => {});
  const compiles = session.renderer.stats.compiles;
  session.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(session.renderer.stats.compiles, compiles, 'not compiled on the spot');
  assert.notEqual(session.loop.mode, LOOP_MODES.paused, 'the loop runs again at once');
  await m.until(() => session.switcher.compiling, 'Tunnel compiling in the background');
  gl.finishCompiles();
  await m.until(() => session.switcher.compiling && refuse === 0, 'plasma compiling, Tunnel having failed');
  assert.equal(refuse, 0, 'Tunnel was refused');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'plasma', 'plasma');
  assert.notEqual(session.message.textContent, MESSAGES.noScene);
  const draws = gl.draws;
  h.run(500);
  assert.ok(gl.draws > draws, 'drawing again');
  assert.equal(m.contexts, 1);
  session.destroy();
});

/* ---------------- Frame rate and brightness in the tab ---------------- */

test('the frame-rate buttons: one pressed, saved, applied at once, and following the setting', async () => {
  const m = await mount({ settings: { visualizerFps: 15 } });
  const { session, controls } = m;
  const pressed = () => controls.fpsButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.textContent);
  assert.deepEqual(controls.fpsButtons.map((button) => button.textContent), ['15', '30', '60']);
  assert.deepEqual(pressed(), ['15']);
  assert.equal(session.loop.targetFps, 15);
  m.source.playing = true;
  m.signal.refresh();
  m.h.run(1000);
  let draws = m.gl.draws;
  m.h.run(1000);
  near(m.gl.draws - draws, 15, 2, '15 a second');
  controls.fpsButtons[2].dispatchEvent(new Event('click'));
  assert.deepEqual(m.saved.at(-1), { visualizerFps: 60 });
  assert.deepEqual(pressed(), ['60']);
  m.h.run(500);
  draws = m.gl.draws;
  m.h.run(1000);
  near(m.gl.draws - draws, 60, 2, '60 a second');
  m.apply({ visualizerFps: 30 });
  assert.deepEqual(pressed(), ['30']);
  assert.equal(session.loop.targetFps, 30);
  m.apply({ visualizerFps: 'bad' });
  assert.equal(session.loop.targetFps, 30);
  assert.equal(session.loop.mode, LOOP_MODES.live, 'no restart');
  // The readout's switch is worded as the measured rate.
  assert.equal(controls.fpsToggle.getAttribute('aria-label'), 'Show measured frames a second');
  session.destroy();
});

test('brightness dims the picture through the canvas opacity: at once, even when still, with no redraw', async () => {
  const m = await mount({ settings: { visualizerBrightness: 60 } });
  const { session, controls, gl } = m;
  assert.equal(session.canvas.style.opacity, '0.6');
  assert.equal(controls.brightSlider.value, '60');
  assert.equal(controls.brightValue.textContent, '60%');
  assert.equal(controls.brightSlider.getAttribute('min'), '30');
  assert.equal(controls.brightSlider.getAttribute('max'), '100');
  // Dragging: shown at once, saved when let go.
  const draws = gl.draws;
  controls.brightSlider.value = '45';
  controls.brightSlider.dispatchEvent(new Event('input'));
  assert.equal(session.canvas.style.opacity, '0.45');
  assert.equal(controls.brightValue.textContent, '45%');
  assert.equal(m.saved.length, 0, 'not saved while dragging');
  controls.brightSlider.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerBrightness: 45 });
  assert.equal(gl.draws, draws, 'nothing redrawn for it');
  // Full brightness leaves the canvas as it is.
  m.apply({ visualizerBrightness: 100 });
  assert.equal(session.canvas.style.opacity, '');
  assert.equal(controls.brightValue.textContent, '100%');
  // Out of range from the settings: the nearest end.
  m.apply({ visualizerBrightness: 5 });
  assert.equal(session.canvas.style.opacity, '0.3');
  session.destroy();
  // A still picture (reduced motion) is dimmed at once too, and not redrawn.
  const still = await mount({ reduced: true });
  assert.equal(still.session.loop.mode, LOOP_MODES.still);
  const stills = still.gl.draws;
  still.controls.brightSlider.value = '30';
  still.controls.brightSlider.dispatchEvent(new Event('input'));
  still.controls.brightSlider.dispatchEvent(new Event('change'));
  assert.equal(still.session.canvas.style.opacity, '0.3');
  assert.equal(still.gl.draws, stills);
  // Nothing scheduled once the buttons over the picture have faded.
  still.h.run(HUD_FADE_MS);
  assert.equal(still.session.hud.faded, true);
  assert.equal(still.h.pending(), 0, 'nothing scheduled');
  still.session.destroy();
});

test('the tab draws each scene with its own link table from scenes.js, and the zoom punch on the drawn frame', async () => {
  const m = await mount();
  const { session } = m;
  assert.deepEqual(session.renderer.links.map((row) => `${row.param}<-${row.source}`), sceneById('plasma').links.map((row) => `${row.param}<-${row.source}`));
  m.source.playing = true;
  m.signal.refresh();
  drum(m.h, m.node, 3000);
  assert.ok(session.loop.state.zoom >= 1 && session.loop.state.zoom <= FLASH_LIMITS.maxZoom, `zoom ${session.loop.state.zoom}`);
  session.destroy();
});

/* ---------------- The developer strip ---------------- */

test('the developer strip: off and free by default, Ctrl+Shift+D shows the reactor\'s values a few times a second', async () => {
  assert.equal(isDebugKey({ ctrlKey: true, shiftKey: true, key: 'D' }), true);
  assert.equal(isDebugKey({ ctrlKey: true, shiftKey: true, key: 'd' }), true);
  assert.equal(isDebugKey({ ctrlKey: true, key: 'd' }), false);
  assert.equal(isDebugKey({ ctrlKey: true, shiftKey: true, altKey: true, key: 'd' }), false);
  assert.equal(isDebugKey(null), false);
  assert.match(debugText({
    bass: 0.5, mid: 0.25, treble: 0.125, kick: 0.6, snare: 0, hat: 0, bpm: 121.4, confidence: 0.8, held: 2, active: true,
  }), /^bass 0\.50 {2}mid 0\.25 {2}treble 0\.13 {2}\| {2}kick 0\.60 .* 121 bpm \(80%\) {2}\| {2}held 2$/);
  // The tempo heard and, apart from it, the beat clock the scene is given.
  assert.match(debugText({
    bass: 0, mid: 0, treble: 0, kick: 0, snare: 0, hat: 0, bpm: 120, confidence: 0.9, clock: 1, held: 0, active: true,
  }), / {2}120 bpm \(90%\) {2}\| {2}clock 1\.00\/s {2}\| {2}held 0$/);
  assert.match(debugText({ bpm: 0, active: false, held: 0 }), /no tempo .* no sound$/);
  const m = await mount();
  const { session } = m;
  let snapshots = 0;
  const snapshot = session.bridge.snapshot;
  session.bridge.snapshot = () => { snapshots += 1; return snapshot(); };
  m.source.playing = true;
  m.signal.refresh();
  drum(m.h, m.node, 2000);
  assert.equal(session.debugStrip, null, 'no element while off');
  assert.equal(snapshots, 0, 'and nothing read for it');
  // Ctrl+Shift+D.
  const event = m.vis.press({ ctrlKey: true, shiftKey: true, key: 'D' });
  assert.equal(event.prevented, true);
  assert.deepEqual(m.saved.at(-1), { visualizerDebug: true });
  const strip = session.debugStrip;
  assert.ok(strip);
  assert.equal(strip.hidden, false);
  assert.match(strip.textContent, /^bass \d\.\d\d {2}mid \d\.\d\d {2}treble \d\.\d\d/);
  snapshots = 0;
  drum(m.h, m.node, 2000);
  assert.ok(snapshots <= 2 * (1000 / DEBUG_INTERVAL_MS) + 1, `${snapshots} updates in 2 s`);
  assert.ok(snapshots >= 6);
  assert.match(strip.textContent, /bpm|no tempo/);
  assert.match(strip.textContent, /clock \d\.\d\d\/s/, 'the clock rate apart from the tempo');
  // Off again: hidden and not updated.
  m.vis.press({ ctrlKey: true, shiftKey: true, key: 'd' });
  assert.equal(strip.hidden, true);
  assert.deepEqual(m.saved.at(-1), { visualizerDebug: false });
  snapshots = 0;
  m.h.run(1000);
  assert.equal(snapshots, 0);
  // Other keys do nothing.
  assert.equal(m.vis.press({ ctrlKey: true, key: 'd' }).prevented, false);
  session.destroy();
  assert.equal(m.vis.count(), 0, 'the key listener is gone');
  // Turned on in the settings: shown from the start.
  const on = await mount({ settings: { visualizerDebug: true } });
  assert.equal(on.session.debugStrip.hidden, false);
  on.session.destroy();
});

/* ---------------- Credits ---------------- */

test('every vendored file is credited in CREDITS.md and the third-party notices', () => {
  const credits = readFileSync(join(REPO, 'CREDITS.md'), 'utf8');
  const notices = readFileSync(join(REPO, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const file of FILES) {
    assert.ok(credits.includes(file.source), `CREDITS.md names ${file.source}`);
    assert.ok(notices.includes(file.source), `the notices name ${file.source}`);
  }
});
