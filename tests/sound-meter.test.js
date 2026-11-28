import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { AudioEngine, VISUAL_ANALYSER_SETTINGS } from '../src/lib/audio-engine.js';
import {
  MAX_DT, PROBE_MS, SIGNAL_BANDS, autoGainDbStep, bandLevel, barsFromSpectrum, binRange, binWidthHz,
  bytePowerTable, createAudioSignal, frameDt, levelFromRms, logBarRanges, valueToDb, waveformStats,
} from '../src/lib/audio-signal.js';
import {
  METER_BARS, METER_FPS, METER_GAIN, METER_HYSTERESIS, METER_SPAN_DB, METER_TIMING, METER_TOP_DB,
  createMeterState, createPlayerMeter, dbToMeter, meterLayout, quantizeMeter, resetMeter, segmentCount,
  smoothToward, stepMeter, stepPeak,
} from '../src/lib/player-meter.js';
import { STORAGE_KEYS, normalizeSettings } from '../src/lib/state.js';
import { LEGACY_PROFILE_STORAGE_KEYS, PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { EQ_STORAGE_KEY } from '../src/lib/eq-store.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { createPlayerDom } from './helpers/fake-dom.js';

/* Discussion: an LED-style sound meter after EQ in the player bar, as a sign
   that a station is really playing. One shared signal layer reads a separate
   visual analyser (never the EQ one) once per frame; the meter is a plain
   consumer. Nothing runs while paused, hidden, or with the meter off. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`,
);

/* ---------------- Pure maths ---------------- */

test('bands become bins from sampleRate / fftSize, never fixed bin numbers', () => {
  assert.equal(binWidthHz(48000, 2048), 23.4375);
  assert.equal(binWidthHz(44100, 2048), 44100 / 2048);
  assert.equal(binWidthHz(0, 2048), 0);
  assert.deepEqual(binRange(30, 300, 48000, 2048), [1, 12]);
  assert.deepEqual(binRange(30, 300, 44100, 2048), [1, 13]);
  assert.deepEqual(binRange(300, 4000, 48000, 2048), [13, 170]);
  // Capped below Nyquist, never bin 0 (DC), never empty.
  assert.deepEqual(binRange(4000, 20000, 32000, 2048), [256, 1023]);
  assert.deepEqual(binRange(0, 1, 48000, 2048), [1, 1]);
  for (const rate of [32000, 44100, 48000, 96000]) {
    for (const fft of [512, 2048, 4096]) {
      const ranges = logBarRanges(14, rate, fft, 40, 16000);
      assert.equal(ranges.length, 28);
      let previous = 0;
      for (let bar = 0; bar < 14; bar += 1) {
        const first = ranges[bar * 2];
        const last = ranges[bar * 2 + 1];
        assert.ok(first >= 1 && last >= first && last <= fft / 2 - 1, `${rate}/${fft} bar ${bar}`);
        // No two bars share a bin while there are bins to give.
        if (fft >= 2048) assert.ok(first > previous, `${rate}/${fft} bar ${bar} overlaps`);
        previous = last;
      }
    }
  }
  // Different rates give different bins for the same bars.
  assert.notDeepEqual([...logBarRanges(14, 44100, 2048)], [...logBarRanges(14, 96000, 2048)]);
  // The lowest bar at 48 kHz / 2048 starts near 40 Hz, the highest ends near 16 kHz.
  const ranges = logBarRanges(14, 48000, 2048, 40, 16000);
  near(ranges[0] * 23.4375, 40, 12, 'low edge');
  near((ranges[27] + 1) * 23.4375, 16000, 30, 'high edge');
  assert.deepEqual(SIGNAL_BANDS, { bass: [30, 300], mid: [300, 4000], high: [4000, 20000] });
});

test('band levels are energy means on the analyser scale, and silence stays exactly zero', () => {
  const table = bytePowerTable(-85, -15);
  assert.equal(table[0], 0);
  near(10 * Math.log10(table[255]), -15, 1e-9, 'top byte');
  near(10 * Math.log10(table[1]), -85 + 70 / 255, 1e-9, 'first byte');
  const spectrum = new Uint8Array(1024);
  assert.equal(bandLevel(spectrum, 1, 100, table, -85, -15), 0);
  // A tilt or gain offset never lifts a band with no energy.
  assert.equal(bandLevel(spectrum, 1, 100, table, -85, -15, 20), 0);
  spectrum.fill(255, 10, 20);
  near(bandLevel(spectrum, 10, 19, table, -85, -15), 1, 1e-9, 'full band');
  // Half the bins at -15 dB, half silent: -3 dB on a 70 dB scale.
  near(bandLevel(spectrum, 10, 29, table, -85, -15), 1 - 3.0103 / 70, 1e-3, 'half band');
  const out = new Float32Array(2);
  barsFromSpectrum(spectrum, Int32Array.from([10, 19, 40, 50]), out, { powerTable: table, minDb: -85, maxDb: -15 });
  near(out[0], 1, 1e-6, 'bar 0');
  assert.equal(out[1], 0);
  near(valueToDb(0.5, -85, -15), -50, 1e-9, 'valueToDb');
  assert.equal(valueToDb(0, -85, -15), Number.NEGATIVE_INFINITY);
});

test('waveform RMS, level and dt are bounded and time based', () => {
  const samples = new Float32Array(2048);
  const bytes = new Uint8Array(2048);
  assert.equal(waveformStats(samples, bytes), 0);
  assert.ok(bytes.every((byte) => byte === 128));
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index / 5);
  near(waveformStats(samples, bytes), Math.SQRT1_2, 0.01, 'sine RMS');
  assert.ok(Math.max(...bytes) === 255 && Math.min(...bytes) <= 1);
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(1), 1);
  near(levelFromRms(0.001), 0, 1e-9, '-60 dBFS');
  near(levelFromRms(10 ** (-30 / 20)), 0.5, 1e-9, '-30 dBFS');
  assert.equal(frameDt(Number.NaN, 100), 0);
  assert.equal(frameDt(100, 90), 0);
  near(frameDt(1000, 1016.7), 0.0167, 1e-9, '60 Hz');
  assert.equal(frameDt(0, 5000), MAX_DT);
});

test('auto-gain only boosts, gently, and adapts over seconds rather than frames', () => {
  const opts = METER_GAIN;
  const levels = Float64Array.from([-40, -55, Number.NEGATIVE_INFINITY]);
  const tracked = new Float64Array(3).fill(opts.targetDb);
  const out = new Float64Array(3);
  // At first nothing is boosted: tracking starts at the target.
  autoGainDbStep(levels, tracked, 0, out, opts);
  assert.deepEqual([...out.slice(0, 2)], [-40, -55]);
  assert.equal(out[2], Number.NEGATIVE_INFINITY);
  // A quiet station for 20 s: the loudest band is lifted to the target, at
  // most maxBoostDb; the quieter band gets up to bandBoostDb on top.
  for (let step = 0; step < 600; step += 1) autoGainDbStep(levels, tracked, 1 / 30, out, opts);
  near(out[0], -40 + opts.maxBoostDb, 1e-6, 'loudest band');
  near(out[1], -55 + opts.maxBoostDb + opts.bandBoostDb, 1e-6, 'quieter band');
  assert.equal(out[2], Number.NEGATIVE_INFINITY, 'no energy stays no energy');
  // A loud station: no cut, and the boost goes at once.
  const loud = Float64Array.from([-10, -20, -30]);
  autoGainDbStep(loud, tracked, 1 / 30, out, opts);
  assert.deepEqual([...out], [-10, -20 + 5, -30 + 6]);
  // Same adaptation at 60 and 144 frames per second.
  const run = (fps) => {
    const t = new Float64Array(1).fill(opts.targetDb);
    const o = new Float64Array(1);
    for (let step = 0; step < fps * 2; step += 1) autoGainDbStep(Float64Array.from([-40]), t, 1 / fps, o, opts);
    return o[0];
  };
  near(run(60), run(144), 1e-6, 'frame-rate independent');
});

test('smoothing and peak hold behave the same at 60 and 144 frames per second', () => {
  const simulate = (fps) => {
    const state = createMeterState(1);
    const targets = new Float32Array(1);
    const trace = [];
    for (let frame = 0; frame < fps * 2; frame += 1) {
      targets[0] = frame < fps * 0.5 ? 1 : 0; // half a second of sound, then silence
      stepMeter(state, targets, 1 / fps);
      if ((frame + 1) % (fps / 4 | 0) === 0) trace.push([state.levels[0], state.peaks[0]]);
    }
    return { state, trace };
  };
  const a = simulate(60);
  const b = simulate(144);
  for (let index = 0; index < Math.min(a.trace.length, b.trace.length); index += 1) {
    near(a.trace[index][0], b.trace[index][0], 0.02, `level ${index}`);
    near(a.trace[index][1], b.trace[index][1], 0.02, `peak ${index}`);
  }
  // Rises fast, falls back to rest after the sound stops.
  near(smoothToward(0, 1, METER_TIMING.attack * 5, METER_TIMING.attack, METER_TIMING.release), 1, 0.01, 'attack');
  assert.equal(smoothToward(0.5, 1, 0, 0.1, 0.1), 0.5);
  assert.ok(a.state.levels[0] < 0.01);
  // Peak: held, then falls at peakFall per second, never below the level.
  assert.deepEqual(stepPeak(0.2, 0, 0.8, 0.01, 0.45, 0.7), [0.8, 0.45]);
  const [held, left] = stepPeak(0.8, 0.45, 0.1, 0.2, 0.45, 0.7);
  assert.equal(held, 0.8);
  near(left, 0.25, 1e-9, 'hold left');
  near(stepPeak(0.8, 0.05, 0.1, 0.15, 0.45, 0.7)[0], 0.8 - 0.1 * 0.7, 1e-9, 'falls after hold');
  assert.equal(stepPeak(0.3, 0, 0.25, 1, 0.45, 0.7)[0], 0.25);
});

test('the meter maps a 45 dB window onto its segments and redraws only on change', () => {
  assert.equal(METER_SPAN_DB, 45);
  const out = new Float32Array(4);
  dbToMeter(Float64Array.from([METER_TOP_DB, METER_TOP_DB - METER_SPAN_DB, Number.NEGATIVE_INFINITY, 0]), out);
  assert.deepEqual([...out], [1, 0, 0, 1]);
  const state = createMeterState(3);
  const lit = new Int8Array(3);
  const peak = new Int8Array(3).fill(-1);
  assert.equal(quantizeMeter(state, 12, lit, peak), false, 'rest stays rest: no redraw');
  state.levels.set([0.5, 0, 1]);
  state.peaks.set([0.75, 0, 1]);
  assert.equal(quantizeMeter(state, 12, lit, peak), true);
  assert.deepEqual([...lit], [6, 0, 12]);
  assert.deepEqual([...peak], [8, -1, -1]);
  assert.equal(quantizeMeter(state, 12, lit, peak), false);
  // A bar hovering on a segment edge keeps its count (no redraw) until it
  // moves more than half a segment plus METER_HYSTERESIS away.
  assert.equal(METER_HYSTERESIS, 0.2);
  for (const value of [6.45, 6.6, 6.4, 6.65, 5.4, 5.35]) {
    state.levels[0] = value / 12;
    assert.equal(quantizeMeter(state, 12, lit, peak), false, `${value} stays at 6`);
    assert.equal(lit[0], 6);
  }
  state.levels[0] = 6.75 / 12;
  assert.equal(quantizeMeter(state, 12, lit, peak), true);
  assert.equal(lit[0], 7);
  state.levels[0] = 6.4 / 12;
  assert.equal(quantizeMeter(state, 12, lit, peak), false, 'and stays at 7 on the way back');
  state.levels[0] = 6.25 / 12;
  assert.equal(quantizeMeter(state, 12, lit, peak), true);
  assert.equal(lit[0], 6);
  // Big moves go straight through, and silence is exactly zero.
  state.levels[0] = 11.2 / 12;
  quantizeMeter(state, 12, lit, peak);
  assert.equal(lit[0], 11);
  assert.equal(peak[0], -1, 'the peak sits under the level, so no marker');
  resetMeter(state);
  assert.equal(quantizeMeter(state, 12, lit, peak), true);
  assert.deepEqual([...lit], [0, 0, 0]);
  assert.deepEqual([...peak], [-1, -1, -1]);
  assert.equal(segmentCount(0.4, 1, 12), 1);
  assert.equal(segmentCount(0.25, 1, 12), 0);
  assert.equal(segmentCount(0, 1, 12), 0);
  assert.equal(segmentCount(20, 3, 12), 12);
});

test('segments use whole device pixels and fit the 90 x 36 canvas at every scale', () => {
  for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
    const width = Math.round(90 * dpr);
    const height = Math.round(36 * dpr);
    const layout = meterLayout(width, height, dpr, METER_BARS);
    for (const key of ['barWidth', 'barGap', 'segHeight', 'segGap', 'left', 'top', 'segments']) {
      assert.ok(Number.isInteger(layout[key]) && layout[key] >= 0, `${dpr}: ${key}`);
    }
    assert.ok(layout.barWidth >= 3, `${dpr}: bars wide enough`);
    assert.ok(layout.segments >= 9 && layout.segments <= 13, `${dpr}: ${layout.segments} segments`);
    assert.ok(layout.left + 14 * layout.barWidth + 13 * layout.barGap <= width);
    assert.ok(layout.top + layout.segments * layout.segHeight + (layout.segments - 1) * layout.segGap <= height);
    assert.ok(layout.hotFrom >= layout.segments - 3 && layout.hotFrom < layout.segments);
  }
});

/* ---------------- The visual tap in the audio engine ---------------- */

class FakeNode {
  constructor(kind) { this.kind = kind; this.outputs = []; this.disconnected = []; }
  connect(target) { this.outputs.push(target); return target; }
  disconnect(target) {
    this.disconnected.push(target);
    this.outputs = target ? this.outputs.filter((node) => node !== target) : [];
  }
}
class FakeContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new FakeNode('destination');
    this.analysers = [];
    this.gains = [];
    this.resumes = 0;
  }
  createGain() { const node = new FakeNode('gain'); node.gain = { value: 1 }; this.gains.push(node); return node; }
  createBiquadFilter() {
    const node = new FakeNode('biquad');
    node.frequency = { value: 0 }; node.Q = { value: 0 }; node.gain = { value: 0 };
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode('compressor');
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[name] = { value: 0 };
    return node;
  }
  createAnalyser() {
    const node = new FakeNode('analyser');
    node.context = this;
    node.fftSize = 2048;
    node.minDecibels = -100;
    node.maxDecibels = -30;
    node.smoothingTimeConstant = 0.8;
    node.level = 200;
    node.getFloatTimeDomainData = (data) => data.fill(0.02);
    node.getByteFrequencyData = (data) => data.fill(node.level);
    this.analysers.push(node);
    return node;
  }
  createMediaElementSource() { return new FakeNode('source'); }
  async resume() { this.resumes += 1; this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

test('the visual tap is a separate analyser beside the EQ one and never starts Web Audio', async () => {
  let created = 0;
  const context = new FakeContext();
  const engine = new AudioEngine({ contextFactory: () => { created += 1; return context; } });
  const element = { paused: false, ended: false };
  assert.equal(engine.visualTapFor(element), null);
  assert.equal(created, 0, 'asking for the tap must not create a context');
  await engine.attachElement(element);
  const { dry, wet, analyser } = engine.graph;
  // A suspended context is not resumed by the tap.
  context.state = 'suspended';
  const resumes = context.resumes;
  assert.equal(engine.visualTapFor(element), null);
  assert.equal(context.resumes, resumes);
  context.state = 'running';
  assert.equal(engine.visualTapFor({ paused: false }), null, 'an element that is not attached');
  const tap = engine.visualTapFor(element);
  assert.ok(tap && tap !== analyser);
  assert.equal(engine.visualTapFor(element), tap, 'one tap, reused');
  assert.deepEqual(
    { fftSize: tap.fftSize, minDecibels: tap.minDecibels, maxDecibels: tap.maxDecibels, smoothingTimeConstant: tap.smoothingTimeConstant },
    { ...VISUAL_ANALYSER_SETTINGS },
  );
  assert.ok(VISUAL_ANALYSER_SETTINGS.maxDecibels >= -20 && VISUAL_ANALYSER_SETTINGS.maxDecibels <= -10);
  // Fed like the EQ analyser, connected to nothing.
  assert.deepEqual(dry.outputs, [analyser, tap]);
  assert.deepEqual(wet.outputs, [analyser, tap]);
  assert.deepEqual(tap.outputs, []);
  // The EQ analyser and what is heard are untouched.
  assert.equal(analyser.fftSize, 2048);
  assert.equal(analyser.smoothingTimeConstant, 0.1);
  assert.deepEqual(analyser.outputs, [context.destination]);
  assert.equal(engine.getAnalyserData().length, 2048);
  engine.releaseVisualTap();
  assert.deepEqual(dry.outputs, [analyser]);
  assert.deepEqual(wet.outputs, [analyser]);
  assert.equal(engine.graph.visual, null);
  // An external block (relay unavailable) refuses the tap too.
  engine.setExternalUnavailable('relay down');
  assert.equal(engine.visualTapFor(element), null);
  assert.equal(created, 1);
});

/* ---------------- The shared signal loop ---------------- */

// A small event simulation on one clock: timers fire when due, animation
// frames on the first display refresh after they were asked for (every
// `frameMs`; a minimised WebView2 window gets about one a second).
function loopHarness({ playing = true, analyser = null, audible = true } = {}) {
  const frames = [];
  const timers = [];
  const listeners = new Set();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
  };
  const source = {
    playing,
    audible,
    node: analyser,
    gets: 0,
    releases: 0,
    isPlaying() { return this.playing; },
    isAudible() { return this.audible; },
    getAnalyser() { this.gets += 1; return this.node; },
    release() { this.releases += 1; },
  };
  let now = 0;
  let handle = 0;
  const counts = { frameRequests: 0, timersSet: 0, maxPending: 0, maxFramesPending: 0 };
  const liveFrames = () => frames.filter((frame) => frame.live).length;
  const liveTimers = () => timers.filter((timer) => timer.live);
  const pending = () => liveFrames() + liveTimers().length;
  const track = () => {
    counts.maxPending = Math.max(counts.maxPending, pending());
    counts.maxFramesPending = Math.max(counts.maxFramesPending, liveFrames());
  };
  const signal = createAudioSignal({
    source,
    doc,
    requestFrame: (fn) => {
      handle += 1;
      counts.frameRequests += 1;
      frames.push({ fn, handle, live: true });
      track();
      return handle;
    },
    cancelFrame: (id) => { for (const frame of frames) if (frame.handle === id) frame.live = false; },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, due: now + Math.max(0, ms), live: true };
      counts.timersSet += 1;
      timers.push(timer);
      track();
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.live = false; },
    clock: () => now,
  });
  /** Let `ms` of real time pass with the display refreshing every `frameMs`. */
  const run = (ms, frameMs = 1000 / 60) => {
    const end = now + ms;
    for (;;) {
      let timer = null;
      for (const entry of liveTimers()) if (!timer || entry.due < timer.due) timer = entry;
      const refresh = liveFrames() ? (Math.floor(now / frameMs + 1e-9) + 1) * frameMs : Number.POSITIVE_INFINITY;
      const at = Math.min(timer ? timer.due : Number.POSITIVE_INFINITY, refresh);
      if (!(at <= end)) break;
      now = Math.max(now, at);
      if (timer && timer.due <= refresh) {
        timer.live = false;
        timer.fn();
      } else {
        for (const frame of frames.filter((entry) => entry.live)) { frame.live = false; frame.fn(now); }
      }
    }
    now = end;
  };
  const setVisible = (visible) => {
    doc.visibilityState = visible ? 'visible' : 'hidden';
    for (const fn of [...listeners]) fn();
  };
  return { signal, source, doc, listeners, pending, run, setVisible, timers, counts, liveTimers };
}

test('the loop runs only with a subscriber, while playing, audible and visible; otherwise nothing is scheduled', () => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  node.minDecibels = -85; node.maxDecibels = -15;
  const h = loopHarness({ playing: false, analyser: node });
  // Playing without a subscriber: nothing.
  h.source.playing = true;
  h.signal.refresh();
  assert.equal(h.pending(), 0);
  assert.equal(h.listeners.size, 0, 'no visibility listener without subscribers');
  // A subscriber while paused: still nothing.
  h.source.playing = false;
  const seen = [];
  const off = h.signal.subscribe((frame) => seen.push(frame.active), { fps: METER_FPS });
  assert.equal(h.pending(), 0);
  assert.equal(h.signal.running, false);
  h.run(1000);
  assert.equal(h.counts.frameRequests + h.counts.timersSet, 0, 'paused: no frame, no timer');
  // Playing: one thing pending at a time (a frame, then the next tick's timer).
  h.source.playing = true;
  h.signal.refresh();
  assert.equal(h.pending(), 1);
  h.run(1000);
  near(h.signal.stats.reads, METER_FPS, 1, 'reads at the meter rate');
  assert.equal(h.counts.maxPending, 1, 'never a timer and a frame at once');
  // Paused: the loop stops, the tap is released, one resting frame is sent.
  h.source.playing = false;
  h.signal.refresh();
  assert.equal(h.pending(), 0);
  assert.equal(h.source.releases, 1);
  assert.equal(seen.at(-1), false);
  assert.equal(h.signal.frame.running, false);
  // Muted or volume 0: rests like a pause; sound back: runs again.
  h.source.playing = true;
  h.signal.refresh();
  h.run(200);
  h.source.audible = false;
  h.signal.refresh();
  assert.equal(h.pending(), 0, 'muted: nothing scheduled');
  assert.equal(h.signal.running, false);
  assert.equal(h.source.releases, 2, 'muted: the tap is released');
  assert.equal(seen.at(-1), false, 'muted: the bars rest');
  const readsMuted = h.signal.stats.reads;
  const requestsMuted = h.counts.frameRequests + h.counts.timersSet;
  h.run(1000);
  assert.equal(h.counts.frameRequests + h.counts.timersSet, requestsMuted);
  h.source.audible = true;
  h.signal.refresh();
  assert.equal(h.pending(), 1);
  h.run(1000);
  near(h.signal.stats.reads - readsMuted, METER_FPS, 1, 'sound back: the meter rate again');
  // Hidden while playing: stopped; visible again: running again.
  h.setVisible(false);
  assert.equal(h.pending(), 0);
  assert.equal(h.signal.running, false);
  h.run(1000);
  const readsHidden = h.signal.stats.reads;
  h.setVisible(true);
  assert.equal(h.pending(), 1);
  h.run(20);
  assert.equal(h.signal.stats.reads, readsHidden + 1);
  // Last unsubscribe: stopped, released, the visibility listener removed.
  off();
  assert.equal(h.pending(), 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.signal.running, false);
});

test('each tick asks for one animation frame and reads once inside it, at the fastest asked rate', () => {
  assert.equal(METER_FPS, 15);
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  node.minDecibels = -85; node.maxDecibels = -15;
  const h = loopHarness({ playing: true, analyser: node });
  const a = [];
  const b = [];
  h.signal.subscribe((frame) => a.push(frame), { fps: METER_FPS });
  h.run(1000); // one second on a 60 Hz display
  near(h.signal.stats.reads, METER_FPS, 1, 'reads at the meter rate, not the display rate');
  const unread = () => h.counts.frameRequests - h.signal.stats.reads; // at most the one still pending
  assert.ok(unread() === 0 || unread() === 1, 'one animation frame per read, none skipped');
  assert.equal(h.counts.maxFramesPending, 1);
  assert.equal(a.length, h.signal.stats.reads);
  near(h.signal.frame.dt, 1 / METER_FPS, 1 / 60, 'dt is real time');
  const frame = h.signal.frame;
  const spectrum = frame.spectrum;
  let reads = h.signal.stats.reads;
  h.run(1000, 1000 / 144); // one second on a 144 Hz display
  near(h.signal.stats.reads - reads, METER_FPS, 1, 'the same rate at 144 Hz');
  assert.ok(unread() === 0 || unread() === 1);
  // A second, faster subscriber: one read per frame, shared by both. Each is
  // called at its own rate (per-subscriber pacing, added for the visualizer):
  // the meter stays at 15 while the loop reads at 30.
  h.signal.subscribe((frame) => b.push(frame), { fps: 30 });
  const aBefore = a.length;
  reads = h.signal.stats.reads;
  h.run(1000);
  near(h.signal.stats.reads - reads, 30, 1, 'the fastest asked rate');
  near(b.length, h.signal.stats.reads - reads, 1, 'the faster one gets (nearly) every read');
  near(a.length - aBefore, METER_FPS, 1, 'the meter keeps its own rate');
  assert.ok([...a.slice(aBefore), ...b].every((entry) => entry === h.signal.frame), 'the same frame object for both');
  assert.equal(h.counts.maxPending, 1);
  assert.equal(frame.spectrum, spectrum, 'arrays are reused, not reallocated');
  // Frame contents.
  assert.equal(frame.active, true);
  assert.equal(frame.running, true);
  assert.equal(frame.sampleRate, 48000);
  assert.equal(frame.fftSize, 2048);
  assert.equal(frame.binHz, 48000 / 2048);
  assert.equal(frame.minDecibels, -85);
  assert.equal(frame.maxDecibels, -15);
  assert.equal(frame.spectrum.length, 1024);
  assert.equal(frame.waveform.length, 2048);
  assert.ok(frame.dt > 0 && frame.dt <= MAX_DT);
  near(frame.rms, 0.02, 1e-6, 'rms');
  near(frame.level, levelFromRms(0.02), 1e-6, 'level');
  for (const name of ['bass', 'mid', 'high']) near(frame[name], 200 / 255, 1e-6, name);
  const bars = new Float32Array(14);
  assert.equal(frame.bars(14, bars), bars);
  assert.ok(bars.every((value) => Math.abs(value - 200 / 255) < 1e-6));
  // A future consumer can still ask for more.
  const before = h.signal.stats.reads;
  const offFast = h.signal.subscribe(() => {}, { fps: 60 });
  h.run(1000);
  near(h.signal.stats.reads - before, 60, 2, 'reads at 60 fps');
  offFast();
  const slower = h.signal.stats.reads;
  h.run(1000);
  near(h.signal.stats.reads - slower, 30, 1, 'back to the fastest remaining rate');
});

test('a subscriber that stops the loop mid-dispatch leaves every subscriber on one resting frame', (t) => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  for (const pauserFirst of [true, false]) {
    const h = loopHarness({ playing: true, analyser: node });
    const seenA = [];
    const seenB = [];
    let pauseNow = false;
    const a = (frame) => {
      seenA.push({ active: frame.active, running: frame.running });
      if (pauseNow && frame.running) { h.source.playing = false; h.signal.refresh(); }
    };
    const b = (frame) => seenB.push({ active: frame.active, running: frame.running });
    if (pauserFirst) { h.signal.subscribe(a, { fps: METER_FPS }); h.signal.subscribe(b, { fps: METER_FPS }); }
    else { h.signal.subscribe(b, { fps: METER_FPS }); h.signal.subscribe(a, { fps: METER_FPS }); }
    h.run(200);
    pauseNow = true;
    h.run(100);
    for (const [name, seen] of [['A', seenA], ['B', seenB]]) {
      const label = `${name} (${pauserFirst ? 'pauser first' : 'pauser last'})`;
      assert.deepEqual(seen.at(-1), { active: false, running: false }, `${label} ends at rest`);
      assert.equal(seen.filter((entry) => !entry.running).length, 1, `${label} gets the resting frame once`);
      assert.ok(seen.slice(0, -1).every((entry) => entry.active && entry.running), `${label}: active frames before it, none after`);
    }
    assert.equal(h.pending(), 0);
  }
  // A listener that throws is logged once; the others and the loop carry on.
  const errors = t.mock.method(console, 'error', () => {});
  const h = loopHarness({ playing: true, analyser: node });
  const seen = [];
  h.signal.subscribe(() => { throw new Error('broken visual'); }, { fps: METER_FPS });
  h.signal.subscribe((frame) => seen.push(frame.active), { fps: METER_FPS });
  h.run(1000);
  near(seen.length, METER_FPS, 1, 'the other subscriber still gets every frame');
  assert.equal(errors.mock.callCount(), 1, 'logged once, not every frame');
  assert.equal(h.signal.running, true);
});

test('a minimised window (frames throttled to one a second) reads once a second and never piles up timers', () => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  const h = loopHarness({ playing: true, analyser: node });
  h.signal.subscribe(() => {}, { fps: METER_FPS });
  h.run(1000);
  let reads = h.signal.stats.reads;
  const timersSet = h.counts.timersSet;
  // WebView2 keeps visibilityState "visible" when minimised; only frames slow.
  h.run(10000, 1000);
  near(h.signal.stats.reads - reads, 10, 1, 'one read per throttled frame');
  assert.equal(h.counts.maxPending, 1, 'one frame or one timer, never a queue');
  assert.ok(h.counts.timersSet - timersSet <= 11, `one timer per frame (${h.counts.timersSet - timersSet})`);
  assert.equal(h.signal.frame.dt, MAX_DT, 'a long gap counts as MAX_DT');
  // Restored: the meter rate at once, with no burst to catch up.
  reads = h.signal.stats.reads;
  h.run(1000);
  near(h.signal.stats.reads - reads, METER_FPS, 1, 'back to the meter rate');
  assert.equal(h.counts.maxPending, 1);
});

test('a faster subscriber moves the waiting tick instead of adding a timer', () => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  const h = loopHarness({ playing: true, analyser: node });
  h.signal.subscribe(() => {}, { fps: 1 });
  h.run(100);
  assert.equal(h.signal.stats.reads, 1);
  assert.equal(h.liveTimers().length, 1);
  assert.ok(h.liveTimers()[0].due > 900, 'the next tick is a second away');
  const off = h.signal.subscribe(() => {}, { fps: 30 });
  assert.equal(h.pending(), 1, 'still one timer');
  assert.ok(h.liveTimers()[0].due <= 1000 / 30 + 100, 'moved to the faster rate');
  h.run(900);
  near(h.signal.stats.reads, 1 + 30 * 0.9, 2, 'the faster rate at once');
  off();
  assert.equal(h.pending(), 1);
  const reads = h.signal.stats.reads;
  h.run(3000);
  near(h.signal.stats.reads - reads, 3, 1, 'slow again after it left');
});

test('without readable sound the frame is inactive once, then only a slow probe runs', () => {
  const h = loopHarness({ playing: true, analyser: null });
  const seen = [];
  h.signal.subscribe((frame) => seen.push({ active: frame.active, sum: frame.spectrum.reduce((s, v) => s + v, 0) }), { fps: METER_FPS });
  h.run(20);
  assert.deepEqual(seen, [{ active: false, sum: 0 }]);
  assert.equal(h.pending(), 1);
  assert.equal(h.timers.at(-1).ms, PROBE_MS);
  // No animation frames while probing; no repeated inactive frames.
  const requests = h.counts.frameRequests;
  const gets = h.source.gets;
  h.run(2000);
  assert.equal(h.counts.frameRequests, requests, 'no animation frames while probing');
  near(h.source.gets - gets, 2000 / PROBE_MS, 1, 'one look per PROBE_MS');
  assert.equal(seen.length, 1);
  // The tap appears (the element got attached): back to frames at the meter rate.
  const ctx = new FakeContext();
  h.source.node = ctx.createAnalyser();
  h.run(PROBE_MS + 20);
  assert.equal(seen.at(-1).active, true);
  const reads = h.signal.stats.reads;
  h.run(1000);
  near(h.signal.stats.reads - reads, METER_FPS, 1);
  assert.equal(h.counts.maxPending, 1);
  // Paused while probing: everything stops.
  h.source.node = null;
  h.run(100);
  h.source.playing = false;
  h.signal.refresh();
  assert.equal(h.pending(), 0);
});

test('a tap that becomes unreadable mid-play is released, and taken again through the normal path', () => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  const h = loopHarness({ playing: true, analyser: node });
  h.signal.subscribe(() => {}, { fps: METER_FPS });
  h.run(20);
  assert.equal(h.signal.hasAnalyser, true);
  assert.equal(h.source.releases, 0);
  // The context suspends (or the element is detached): the loop lets go.
  h.source.node = null;
  h.run(100);
  assert.equal(h.source.releases, 1, 'released when it stops reading');
  assert.equal(h.signal.hasAnalyser, false);
  assert.equal(h.signal.running, true, 'still probing while playing');
  // Readable again: probe -> getAnalyser() -> a frame, reading the new tap.
  h.source.node = node;
  const gets = h.source.gets;
  const reads = h.signal.stats.reads;
  h.run(PROBE_MS + 20);
  assert.ok(h.source.gets > gets);
  assert.ok(h.signal.stats.reads > reads);
  assert.equal(h.signal.hasAnalyser, true);
});

test('a listener that unsubscribes inside its callback leaves nothing scheduled, and a quick re-subscribe runs one loop', () => {
  const ctx = new FakeContext();
  const node = ctx.createAnalyser();
  // Active path.
  const h = loopHarness({ playing: true, analyser: node });
  let off = null;
  off = h.signal.subscribe(() => off());
  h.run(20);
  assert.equal(h.signal.running, false);
  assert.equal(h.pending(), 0, 'no frame scheduled after the loop stopped');
  // Stop and re-subscribe from inside the callback: exactly one loop.
  let again = null;
  let resubscribed = false;
  off = h.signal.subscribe(() => {
    if (resubscribed) return;
    resubscribed = true;
    off();
    again = h.signal.subscribe(() => {});
  });
  h.run(20);
  assert.ok(again);
  assert.equal(h.pending(), 1, 'one frame pending, not two');
  const reads = h.signal.stats.reads;
  h.counts.maxPending = 0;
  h.run(1000);
  near(h.signal.stats.reads - reads, 30, 1, 'one loop at the default 30 fps');
  assert.equal(h.counts.maxPending, 1);
  again();
  assert.equal(h.pending(), 0);
  // Inactive path: no probe timer after the last listener left in its callback.
  const idle = loopHarness({ playing: true, analyser: null });
  let offIdle = null;
  offIdle = idle.signal.subscribe(() => offIdle());
  idle.run(20);
  assert.equal(idle.signal.running, false);
  assert.equal(idle.pending(), 0, 'no probe timer after the loop stopped');
  // start() twice never doubles the schedule.
  const twice = loopHarness({ playing: true, analyser: node });
  twice.signal.subscribe(() => {});
  twice.signal.refresh();
  twice.signal.refresh();
  assert.equal(twice.pending(), 1);
});

/* ---------------- The meter as a consumer ---------------- */

function fakeCanvas() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    fillStyle: '',
    clearRect: () => calls.push('clear'),
    beginPath() {},
    rect() {},
    fill: () => calls.push('fill'),
  };
  return { width: 90, height: 36, getContext: () => ctx, ctx };
}
function fakeSignal() {
  const subs = new Set();
  return {
    subs,
    subscribe(fn, opts) { subs.add(fn); this.opts = opts; return () => subs.delete(fn); },
  };
}

test('gapless FFT transients do not re-seed the meter or extend its peak hold', (t) => {
  const meter = createPlayerMeter({ canvas: fakeCanvas(), signal: fakeSignal(), win: {}, doc: null });
  t.after(meter.destroy);
  meter.resize(90, 36);
  const steady = {
    active: true, dt: 1 / METER_FPS, minDecibels: -85, maxDecibels: -15,
    bars: (_count, out) => out.fill(0.48),
  };
  for (let index = 0; index < 30; index++) meter.onFrame(steady);
  const state = () => [meter.state.levels, meter.state.peaks, meter.state.holds, meter.state.trackedDb, meter.lit];
  const before = state().map((values) => values.slice());
  const loud = { ...steady, handoffTime: 2, bars: (_count, out) => out.fill(1) };
  meter.onFrame({ ...loud, time: 2.06 });
  meter.onFrame({ ...loud, time: 2.11 });
  assert.deepEqual(state(), before);
  meter.onFrame({ ...loud, time: 2.14 });
  assert.ok(meter.state.levels[0] > before[0][0], 'a sustained louder track still raises the meter');
  meter.onFrame({ active: false, time: 2.15 });
  assert.ok(meter.lit.every((value) => value === 0), 'pause still clears the meter');
});

test('the meter listens only while enabled, laid out and allowed to move', () => {
  const signal = fakeSignal();
  const canvas = fakeCanvas();
  const root = { hidden: false };
  const meter = createPlayerMeter({ root, canvas, signal, win: {}, doc: null });
  assert.equal(signal.subs.size, 0, 'not laid out yet');
  meter.resize(90, 36);
  assert.equal(signal.subs.size, 1);
  assert.equal(signal.opts.fps, METER_FPS);
  assert.ok(canvas.ctx.calls.includes('clear'), 'the resting meter is drawn');
  meter.resize(0, 0); // hidden by CSS (narrow bar, capture-only, bar hidden)
  assert.equal(signal.subs.size, 0);
  meter.resize(113, 45); // 125 % scaling
  assert.equal(canvas.width, 113);
  assert.equal(canvas.height, 45);
  assert.equal(signal.subs.size, 1);
  meter.setEnabled(false);
  assert.equal(root.hidden, true);
  assert.equal(signal.subs.size, 0);
  meter.setEnabled(true);
  assert.equal(root.hidden, false);
  assert.equal(signal.subs.size, 1);
  meter.destroy();
  assert.equal(signal.subs.size, 0);
  // Reduced motion: the resting meter only, never a subscription.
  const still = fakeSignal();
  const reduced = createPlayerMeter({
    root: { hidden: false },
    canvas: fakeCanvas(),
    signal: still,
    win: { matchMedia: (query) => ({ matches: query.includes('reduced-motion'), addEventListener() {} }) },
    doc: null,
  });
  reduced.resize(90, 36);
  assert.equal(still.subs.size, 0);
});

test('real frames move the bars; an inactive frame puts them back to rest without faking movement', () => {
  const signal = fakeSignal();
  const canvas = fakeCanvas();
  const meter = createPlayerMeter({ root: { hidden: false }, canvas, signal, win: {}, doc: null });
  meter.resize(90, 36);
  const listener = [...signal.subs][0];
  const frame = {
    active: true, dt: 1 / 30, minDecibels: -85, maxDecibels: -15,
    bars(count, out) { return out.fill(0.85); }, // about -25.5 dB in every bar
  };
  for (let index = 0; index < 15; index += 1) listener(frame);
  assert.ok(meter.lit.every((count) => count > 0), 'bars lit with sound');
  const drawsBefore = meter.stats.draws;
  listener(frame);
  assert.equal(meter.stats.draws, drawsBefore, 'a steady level is not redrawn');
  listener({ ...frame, active: false, dt: 0 });
  assert.ok(meter.lit.every((count) => count === 0));
  assert.ok(meter.peak.every((index) => index === -1));
  // Silence that is real data: bars fall, never rise.
  listener(frame);
  listener({ ...frame, bars(count, out) { return out.fill(0); } });
  const silentDraws = meter.stats.draws;
  for (let index = 0; index < 60; index += 1) listener({ ...frame, bars(count, out) { return out.fill(0); } });
  assert.ok(meter.lit.every((count) => count === 0));
  assert.ok(meter.stats.draws - silentDraws < 30, 'resting bars stop redrawing');
});

/* ---------------- Player wiring with a real engine and fake Web Audio ---------------- */

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

test('the player feeds the signal only from relayed, attached, running playback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const contexts = [];
  class Context extends FakeContext { constructor() { super(); contexts.push(this); } }
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    storage: globalThis.localStorage, AudioContext: globalThis.AudioContext,
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  const storage = new MemoryStorage();
  storage.setItem(EQ_STORAGE_KEY, JSON.stringify({ version: 1, global: { preamp: 0, bands: Array(10).fill(0) }, favorites: {}, customPresets: {} }));
  let registration = 0;
  const envelope = (status, data) => ({ ok: true, status, json: async () => ({ ok: true, data, error: null }) });
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'meter-token' });
    if (path === '/api/v1/media/register') {
      registration += 1;
      const id = `opaque_meter_media_${String(registration).padStart(8, '0')}`;
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    throw new Error(`unexpected ${path}`);
  };
  let rafQueue = [];
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => { rafQueue = []; };
  globalThis.document = document;
  globalThis.window = {};
  globalThis.localStorage = storage;
  globalThis.AudioContext = Context;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaSession: { playbackState: 'none', setActionHandler() {} } },
  });
  resetControlSession();
  try {
    const player = await import(`../src/lib/player.js?soundMeter=${Date.now()}`);
    player.initPlayer();
    const signal = player.getAudioSignal();
    const seen = [];
    const off = signal.subscribe((frame) => seen.push(frame.active));
    assert.equal(rafQueue.length, 0, 'nothing plays yet');
    assert.equal(contexts.length, 0, 'subscribing does not create Web Audio');

    await player.playItem({
      id: 'meter:radio', title: 'Radio', description: '', source: 'radio-browser', type: 'audio',
      stream_kind: 'audio', stream_url: 'https://media.example/radio.mp3', delivery: 'live',
      capture_headers: {}, thumbnail: '', country: '', language: '',
    });
    assert.equal(elements['audio-el'].paused, false);
    assert.equal(contexts.length, 1);
    assert.ok(rafQueue.length >= 1, 'playing starts the loop');
    const runFrame = (time) => { const queue = rafQueue; rafQueue = []; for (const fn of queue) fn(time); };
    runFrame(100);
    assert.equal(seen.at(-1), true, 'real data from the relayed element');
    const [eqAnalyser, tap] = contexts[0].analysers;
    assert.ok(tap, 'a second analyser was made for visuals');
    assert.equal(eqAnalyser.smoothingTimeConstant, 0.1);
    assert.equal(tap.maxDecibels, VISUAL_ANALYSER_SETTINGS.maxDecibels);
    assert.deepEqual(tap.outputs, []);

    // The next frame is asked for by the pacing timer, not by the frame itself.
    assert.equal(rafQueue.length, 0, 'no frame re-requested from inside a frame');
    const nextFrame = async () => {
      for (let tries = 0; tries < 100 && !rafQueue.length; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(rafQueue.length, 1, 'one frame per tick');
    };

    // Windows suspends the context: no data, and the meter does not resume it.
    const resumes = contexts[0].resumes;
    contexts[0].state = 'suspended';
    await nextFrame();
    runFrame(200);
    assert.equal(seen.at(-1), false);
    assert.equal(contexts[0].resumes, resumes);
    contexts[0].state = 'running';
    await new Promise((resolve) => setTimeout(resolve, 300)); // the probe finds it again
    await nextFrame();
    runFrame(300);
    assert.equal(seen.at(-1), true);

    // Muted, or the volume all the way down: the loop rests until sound is back.
    const audio = elements['audio-el'];
    player.setMuted(true);
    audio.emit('volumechange');
    assert.equal(signal.running, false, 'muted: no reads');
    assert.equal(signal.scheduled, false);
    assert.equal(seen.at(-1), false);
    player.setMuted(false);
    audio.emit('volumechange');
    assert.equal(signal.running, true, 'unmuted: reading again');
    player.setVolume(0);
    audio.emit('volumechange');
    assert.equal(signal.running, false, 'volume 0: no reads');
    player.setVolume(80);
    audio.emit('volumechange');
    assert.equal(signal.running, true);
    await nextFrame();
    runFrame(400);
    assert.equal(seen.at(-1), true);

    // Pause: the loop stops and the tap is disconnected.
    await player.togglePlay();
    assert.equal(elements['audio-el'].paused, true);
    assert.equal(rafQueue.length, 0);
    assert.equal(seen.at(-1), false);
    assert.equal(contexts[0].gains.filter((gain) => gain.disconnected.includes(tap)).length, 2, 'dry and wet let go of the tap');
    off();
    player.stop();
  } finally {
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    globalThis.localStorage = previous.storage;
    globalThis.AudioContext = previous.AudioContext;
    globalThis.requestAnimationFrame = previous.raf;
    globalThis.cancelAnimationFrame = previous.caf;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
  }
});

/* ---------------- Setting, markup, styles ---------------- */

test('the setting defaults to on and is stored inside the saved settings, never as a profile key', async () => {
  assert.equal(normalizeSettings({}).soundMeter, true);
  assert.equal(normalizeSettings(undefined).soundMeter, true);
  assert.equal(normalizeSettings({ soundMeter: false }).soundMeter, false);
  assert.equal(normalizeSettings({ soundMeter: true }).soundMeter, true);
  for (const other of [null, 0, 'false', {}]) assert.equal(normalizeSettings({ soundMeter: other }).soundMeter, true);
  // Older builds keep fields they do not know (they normalise with a spread).
  const olderNormalize = (value) => ({ ...value, version: 1, theme: value.theme || 'system' });
  const saved = JSON.stringify(normalizeSettings({ soundMeter: false }));
  assert.equal(normalizeSettings(olderNormalize(JSON.parse(saved))).soundMeter, false);
  assert.ok(LEGACY_PROFILE_STORAGE_KEYS.includes(STORAGE_KEYS.settings));
  assert.ok(!Object.keys(STORAGE_KEYS).some((key) => /meter/i.test(key)));
  assert.ok(!PROFILE_STORAGE_KEYS.some((key) => /meter/i.test(key)));
  assert.doesNotMatch(await read('worldmedia_runtime.py'), /meter/i);
  const settings = await read('src/lib/settings.js');
  const appearance = settings.match(/<h3>Appearance<\/h3>[\s\S]*?<\/section>/)[0];
  assert.match(appearance, /<label for="settings-sound-meter">Sound meter in the player bar<\/label>/);
  assert.match(appearance, /<input id="settings-sound-meter" type="checkbox" class="switch" data-field="soundMeter" \/>/);
  assert.match(settings, /meterToggle\.checked = state\.settings\.soundMeter !== false;/);
  assert.match(settings, /meterToggle\.addEventListener\('change', \(\) => saveSettings\(\{ soundMeter: meterToggle\.checked \}\)\);/);
  const main = await read('src/main.js');
  assert.match(main, /initPlayerMeter\(\{\s+signal: getAudioSignal\(\),/);
  assert.match(main, /subscribeSettings: \(fn\) => subscribe\('settings-change', fn\)/);
});

test('one decorative meter follows the actions in the progress group', async () => {
  const html = await read('src/index.html');
  const actions = html.match(/<div class="player-actions"[\s\S]*?\n {8}<\/div>/)[0];
  assert.doesNotMatch(actions, /data-player-meter/);
  const progress = html.match(/<div class="player-progress">[\s\S]*?<\/div>\s+<span id="player-time"/)[0];
  assert.match(progress, /<div id="player-meter" class="player-meter" data-player-meter aria-hidden="true">\s+<canvas class="player-meter-canvas" width="90" height="36"><\/canvas>/);
  assert.equal((html.match(/data-player-meter/g) || []).length, 1);
  assert.doesNotMatch(progress, /tabindex|role=/);
});

test('the bar keeps its height and controls: the meter only uses spare room', async () => {
  const css = await read('src/styles/base.css');
  const block = css.slice(css.indexOf('/* Sound meter (lib/player-meter.js)'), css.indexOf('.player-capture-status {'));
  assert.match(block, /\.player-meter \{ display: block; flex: none; \}/);
  assert.match(block, /\.player-meter-canvas \{\s+display: block;\s+width: 90px;\s+height: 36px;/);
  assert.match(css, /\.player-bar:is\(\[data-fit="meter"\][^\n]*\.player-meter,/);
  assert.match(block, /\.player-bar\.is-capture-only \.player-meter \{ display: none !important; \}/);
  // The meter fits the bar's normal 56px track.
  assert.match(css, /grid-template-rows: minmax\(56px, auto\);/);
  assert.match(css, /grid-template-rows: 56px 36px;/);
  assert.match(css, /--player-h: 74px;/);
  // Media actions retain the bar's 8px spacing.
  assert.match(css, /\.player-actions \{\s+grid-area: actions;\s+display: flex;\s+align-items: center;\s+gap: 8px;/);
  // Colours come from the theme tokens; Light gets a darker hot colour.
  assert.match(block, /color: var\(--accent\);\s+border: 0 solid var\(--warm\);/);
  assert.match(block, /:root\[data-theme='light'\] \.player-meter-canvas \{\s+border-color: #b86a00;/);
});

test('switched off, the meter stays hidden at every width', async () => {
  const css = await read('src/styles/base.css');
  // The hidden attribute wins over every layout rule for the meter blocks.
  assert.match(css, /\n\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.player-meter\[hidden\] \{ display: none !important; \}/);
  const block = css.slice(css.indexOf('/* Sound meter (lib/player-meter.js)'), css.indexOf('.player-capture-status {'));
  // No meter rule can show a block with !important (only hiding uses it).
  for (const match of block.matchAll(/display:\s*([^;]+);/g)) {
    if (/!important/.test(match[1])) assert.match(match[1], /^none\s*!important$/);
  }
  const html = await read('src/index.html');
  assert.match(html, /<div id="player-meter" class="player-meter" data-player-meter/);
  const roots = [{ hidden: false }, { hidden: false }];
  const meters = roots.map((root) => createPlayerMeter({ root, canvas: fakeCanvas(), signal: fakeSignal(), win: {}, doc: null }));
  meters.forEach((meter) => meter.setEnabled(false));
  assert.ok(roots.every((root) => root.hidden === true));
  // The seek's full width depends only on the meter being displayed: the
  // time labels are pinned only while a visible meter is in the cell.
  assert.match(css, /\.player-time \{ flex: none; \}/);
});

test('new files are ASCII only', async () => {
  for (const path of ['src/lib/audio-signal.js', 'src/lib/player-meter.js', 'tests/sound-meter.test.js']) {
    const text = await read(path);
    assert.ok(/^[\x00-\x7f]*$/.test(text), `${path} has non-ASCII characters`);
  }
});
