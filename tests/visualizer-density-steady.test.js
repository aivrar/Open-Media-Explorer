import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DENSITY_QUALITY, DENSITY_WHITE_RATE, DENSITY_WHITE_STEP, createDensityRenderer, densityShare, densityStatsNow, easeWhiteScale,
  liveDensityWorkers, setDensityShareScale, suspendDensityWorker,
} from '../src/visualizer/density-host.js';
import {
  DENSITY_SHARE_SCALE, PROCESSOR_USE_LEVELS, densityShareScale,
} from '../src/lib/processor-budget.js';
import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { VISUALIZER_IDLE_SECONDS } from '../src/lib/visualizer-settings.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { LOOP_MODES } from '../src/visualizer/loop.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import loadDensityWorker from '../src/visualizer/vendor/psychedelia/workers/progressive-density-worker.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';
import { SimGL } from './helpers/sim-fakes.js';

/* The density labs' worker kept steady (density-host.js): its white point
   eased from reply to reply, so the pixels already there never change
   brightness at once; no worker while nothing is drawn (hidden, minimised,
   throttled, at rest), the picture so far kept on screen; and its share of
   a core by the processor use. No GPU and no real worker thread. */

/** A stand-in for the browser's Worker (messages copied, buffers moved). */
class FakeWorker {
  constructor() {
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message, transfer = []) {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.posted.push(structuredClone(message, { transfer }));
  }

  terminate() { this.terminated = true; }

  reply(overrides = {}) {
    const request = this.posted.at(-1);
    const data = {
      type: 'frame',
      requestId: request.requestId,
      generation: request.generation,
      width: request.width,
      height: request.height,
      lastBatchSize: 1000,
      workMs: 8,
      image: request.image || new ArrayBuffer(request.width * request.height * 4),
      ...overrides,
    };
    this.onmessage?.({ data: structuredClone(data, { transfer: [data.image] }) });
  }
}

const config = (extra = {}) => ({
  densityType: 'buddhabrot',
  resetKey: 'look-a',
  tonemapKey: 'tone-a',
  params: { mode: 0 },
  tonemap: { exposure: 2, gamma: 0.82, gain: 1.15, glow: 1.1, curve: 0.86, palette: 1, colorPhase: 0 },
  batchSize: 16000,
  resolutionScale: 0.5,
  maxSide: 1280,
  ...extra,
});

function rig() {
  const r = { clock: 0, step: 1 / 60, workers: [] };
  r.canvas = { width: 640, height: 360 };
  r.gl = new SimGL({ canvas: r.canvas });
  const Renderer = {
    getCanvas: () => r.canvas, bindFramebuffer() {}, getViewZoom: () => 1, getFrameStep: () => r.step,
  };
  r.factory = createDensityRenderer({ Renderer, sceneQuality: () => 'medium' }, {
    startWorker: () => { const w = new FakeWorker(); r.workers.push(w); return w; },
    now: () => r.clock,
  });
  r.instance = r.factory.create({ name: 'test' });
  r.worker = () => r.workers.at(-1) || null;
  r.frame = (ms = 1000 / 60, step = ms / 1000) => {
    r.clock += ms;
    r.step = step;
    return r.instance.render(r.gl, r.clock / 1000, config());
  };
  /** Frames until the worker is asked again; returns that request. */
  r.untilAsked = () => {
    const worker = r.worker();
    const before = worker.posted.length;
    for (let i = 0; i < 600 && worker.posted.length === before; i += 1) r.frame();
    assert.ok(worker.posted.length > before, 'asked again');
    return worker.posted.at(-1);
  };
  return r;
}

/* ---------------- The white point ---------------- */

test('the white point is eased: the first taken as it is, then at most DENSITY_WHITE_STEP a reply and DENSITY_WHITE_RATE a second', () => {
  assert.equal(easeWhiteScale(null, 3, 0), 3);
  assert.equal(easeWhiteScale(2, Number.NaN, 1), 2, 'no measure: unchanged');
  assert.equal(easeWhiteScale(2, 0, 1), 2);
  // A long gap: the step per reply still holds.
  assert.equal(easeWhiteScale(2, 8, 60), 2 * DENSITY_WHITE_STEP);
  assert.equal(easeWhiteScale(2, 0.5, 60), 2 / DENSITY_WHITE_STEP);
  // Quick replies: the rate a second holds.
  assert.ok(Math.abs(easeWhiteScale(2, 8, 0.05) - 2 * DENSITY_WHITE_RATE ** 0.05) < 1e-12);
  let value = 1;
  for (let i = 0; i < 20; i += 1) value = easeWhiteScale(value, 100, 0.05);
  assert.ok(Math.abs(value - DENSITY_WHITE_RATE) < 1e-9, `one second of replies: ${value}`);
  // Close enough is reached, not passed.
  assert.equal(easeWhiteScale(2, 2.05, 1), 2.05);
});

test('the host sends the eased white point: a jump in what the worker measured reaches the picture a step at a time', () => {
  const r = rig();
  r.frame();
  const first = r.worker().posted[0];
  assert.equal(first.whiteScale, 0, 'none yet: the worker uses its own');
  r.worker().reply({ whiteScale: 1 });
  assert.equal(r.untilAsked().whiteScale, 1, 'the first measure as it is');
  // The worker's measure jumps fourfold (a percentile instead of the
  // brightest pixel, or a pixel grown hot).
  let last = 1;
  let at = r.clock;
  const start = r.clock;
  for (let i = 0; i < 40; i += 1) {
    r.worker().reply({ whiteScale: 4 });
    const sent = r.untilAsked().whiteScale;
    const seconds = (r.clock - at) / 1000;
    assert.ok(sent >= last && sent <= last * DENSITY_WHITE_STEP + 1e-12, `reply ${i}: ${last} -> ${sent}`);
    assert.ok(sent <= last * DENSITY_WHITE_RATE ** Math.max(seconds, 1 / 60) + 1e-9, `reply ${i}: ${sent} in ${seconds} s`);
    last = sent;
    at = r.clock;
  }
  assert.ok(last > 1.5, `it does get there (${last})`);
  assert.ok(last <= DENSITY_WHITE_RATE ** ((r.clock - start) / 1000) + 1e-9);
  r.instance.cleanup(r.gl);
});

/** The vendored worker run in this process (its clock a counter). */
function localWorker() {
  class Scope {}
  const scope = new Scope();
  const replies = [];
  scope.postMessage = (message) => replies.push(message);
  scope.close = () => {};
  const within = (fn) => {
    const saved = { self: globalThis.self, WorkerGlobalScope: globalThis.WorkerGlobalScope };
    globalThis.self = scope;
    globalThis.WorkerGlobalScope = Scope;
    try {
      return fn();
    } finally {
      if (saved.self === undefined) delete globalThis.self; else globalThis.self = saved.self;
      if (saved.WorkerGlobalScope === undefined) delete globalThis.WorkerGlobalScope; else globalThis.WorkerGlobalScope = saved.WorkerGlobalScope;
    }
  };
  within(() => loadDensityWorker({}));
  const counted = (fn) => {
    const real = Date.now;
    let clock = 1e12;
    Date.now = () => (clock += 1);
    try { return fn(); } finally { Date.now = real; }
  };
  return { replies, send: (data) => within(() => counted(() => scope.onmessage({ data }))) };
}

/** Buddhabrot built a few orbits a reply, through the 32 lit pixels where
 *  the worker's white point switches to a percentile: per reply, the lit
 *  pixels and the mean luminance of the pixels lit in this reply and the
 *  last (new over old). `eased`: the host's white point sent back. */
function buildUp(eased) {
  const { replies, send } = localWorker();
  let scale = null;
  let prev = null;
  const rows = [];
  for (let i = 1; i <= 24; i += 1) {
    send({
      type: 'accumulate', requestId: i, generation: 1, resetKey: 'a', densityType: 'buddhabrot', width: 64, height: 36, batchSize: 2, decay: 1,
      params: {
        mode: 0, sampleScale: 1, minIter: 8, maxIter: 180, xMin: -2.2, xMax: 1.15, yMin: -1.35, yMax: 1.35, windowDrift: 0, windowZoomSpeed: 0,
        slowBucket: 160, midBucket: 55, sampleMotion: 0, driftSpeed: 0, channelGain: 1.15, globalZoom: 1, seed: 0.3,
      },
      tonemap: { exposure: 2, gamma: 0.84, gain: 1, glow: 1, curve: 0.8, palette: -1, colorPhase: 0 },
      time: 0, budgetMs: 3, deadlineMs: 3, image: null, whiteScale: eased && scale ? scale : 0,
    });
    const reply = replies.at(-1);
    const px = new Uint8ClampedArray(reply.image);
    const lum = new Float64Array(px.length / 4);
    let lit = 0;
    for (let p = 0; p < lum.length; p += 1) {
      lum[p] = (0.2126 * px[p * 4] + 0.7152 * px[p * 4 + 1] + 0.0722 * px[p * 4 + 2]) / 255;
      if (lum[p] > 0) lit += 1;
    }
    let ratio = null;
    if (prev) {
      let before = 0;
      let after = 0;
      for (let p = 0; p < lum.length; p += 1) if (lum[p] > 0 && prev[p] > 0) { before += prev[p]; after += lum[p]; }
      if (before > 0) ratio = after / before;
    }
    rows.push({ lit, ratio, measured: reply.whiteScale });
    // Replies a tenth of a second apart, as the duty cycle gives them.
    if (eased) scale = easeWhiteScale(scale, reply.whiteScale, 0.1);
    prev = lum;
  }
  return rows;
}

test('real pixels across the 32 lit pixels: with the worker\'s own white point they jump; eased, the pixels already there change by a step at most', () => {
  const own = buildUp(false);
  const eased = buildUp(true);
  assert.ok(own.some((row) => row.lit < 32) && own.some((row) => row.lit >= 32), 'the build-up crosses 32 lit pixels');
  assert.ok(own.every((row) => row.measured > 0), 'each frame says its white point');
  const worst = (rows) => rows.filter((row) => row.ratio !== null).reduce((most, row) => Math.max(most, Math.abs(Math.log(row.ratio))), 0);
  // Its own: a jump (about 0.71 to 0.78 of the brightness at once).
  assert.ok(Math.exp(worst(own)) > 1.25, `own white point: worst step ${Math.exp(worst(own)).toFixed(3)}`);
  // Eased: within the white point's own step a reply.
  assert.ok(Math.exp(worst(eased)) <= DENSITY_WHITE_STEP, `eased: worst step ${Math.exp(worst(eased)).toFixed(3)}`);
});

/* ---------------- Nothing drawn: no worker ---------------- */

test('nothing drawn: the worker ends, the picture so far stays; frames again start a new picture mixed in over it', () => {
  const r = rig();
  r.frame();
  // A picture fully shown.
  for (let i = 0; i < 400 && r.instance.getDiagnostics().mix < 1; i += 1) {
    if (r.worker().posted.length && !r.instance.getDiagnostics().inFlight) r.frame();
    else { r.worker().reply({ lastBatchSize: 20000 }); r.frame(); }
  }
  const shown = r.instance.getDiagnostics();
  assert.equal(shown.mix, 1);
  assert.equal(shown.finished, false);
  const worker = r.worker();
  assert.equal(liveDensityWorkers(), 1);
  assert.equal(suspendDensityWorker(), true);
  assert.equal(worker.terminated, true, 'ended');
  assert.equal(worker.onmessage, null, 'nothing it still sends arrives');
  assert.equal(liveDensityWorkers(), 0);
  assert.equal(r.factory.stats.suspended, 1);
  const kept = r.instance.getDiagnostics();
  assert.equal(kept.hasFront, true, 'the picture stays');
  assert.equal(kept.mix, 1);
  // Still frames (hidden, at rest) start nothing.
  for (let i = 0; i < 30; i += 1) r.frame(1000 / 60, 0);
  assert.equal(r.workers.length, 1, 'no worker while still');
  // Frames again: a new picture, the old one shown under it until it fills.
  r.frame();
  const back = r.instance.getDiagnostics();
  assert.equal(r.workers.length, 2, 'a new worker');
  assert.equal(back.generation, shown.generation + 1, 'a new picture');
  assert.equal(back.hasBack, true, 'the old picture under it');
  assert.equal(back.mix, 0, 'mixed in from nothing');
  assert.equal(suspendDensityWorker(), true);
  // Nothing alive to end: false.
  assert.equal(suspendDensityWorker(), false);
  r.instance.cleanup(r.gl);
});

test('a picture part way in when nothing is drawn goes back out before the new one starts (no jump)', () => {
  const r = rig();
  r.frame();
  r.worker().reply({ lastBatchSize: 20000 });
  for (let i = 0; i < 5; i += 1) r.frame();
  const before = r.instance.getDiagnostics();
  assert.ok(before.mix > 0 && before.mix < 1, `part way (${before.mix})`);
  suspendDensityWorker();
  r.frame();
  const after = r.instance.getDiagnostics();
  assert.equal(after.leaving, true, 'it goes back out');
  assert.ok(after.mix <= before.mix && before.mix - after.mix <= 0.5 / 60 + 1e-9, 'at the fade rate');
  r.instance.cleanup(r.gl);
});

/* ---------------- Its share of a core ---------------- */

test('the worker\'s share of a core comes from the processor use: Light keeps the measured shares', () => {
  assert.deepEqual([...PROCESSOR_USE_LEVELS].map(densityShareScale), PROCESSOR_USE_LEVELS.map((level) => DENSITY_SHARE_SCALE[level]));
  assert.equal(densityShareScale('light'), 1);
  assert.equal(densityShareScale('nonsense'), 1);
  for (const quality of ['low', 'medium', 'high']) assert.equal(densityShare(quality), DENSITY_QUALITY[quality].share);
  try {
    setDensityShareScale(1.4);
    assert.ok(Math.abs(densityShare('medium') - DENSITY_QUALITY.medium.share * 1.4) < 1e-12);
    // The duty cycle follows it: after an 8 ms slice the next waits 8 / share.
    const r = rig();
    r.frame();
    const sentAt = r.clock;
    r.worker().reply({ workMs: 8 });
    r.untilAsked();
    const wait = r.clock - sentAt;
    const want = 8 / (DENSITY_QUALITY.medium.share * 1.4);
    assert.ok(wait >= want && wait < want + 1000 / 60 + 1e-6, `waited ${wait} ms for ${want}`);
    r.instance.cleanup(r.gl);
    setDensityShareScale(Number.NaN);
    assert.equal(densityShare('medium'), DENSITY_QUALITY.medium.share, 'nonsense: as measured');
  } finally {
    setDensityShareScale(1);
  }
});

/* ---------------- In the tab ---------------- */

async function mount() {
  const h = createClockHarness();
  const vis = fakeDocWithElements({ width: 1280, height: 720 });
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false, isPlaying() { return this.playing; }, isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; }, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  let current = normalizeSettings({ visualizerNoticeSeen: true });
  const session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); },
    subscribeSettings: () => () => {},
    win,
    doc: vis.doc,
    createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
    scenes: SCENES,
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
  });
  for (let round = 0; round < 400 && !session.switcher.current; round += 1) {
    await settle(() => Boolean(session.switcher.current), 20);
    h.run(COMPILE_POLL_MS);
  }
  assert.ok(session.switcher.current, 'first scene');
  return { h, vis, session, source, signal };
}

/** A density picture with its worker alive (as a lab in the tab has). */
function liveLab() {
  const r = rig();
  r.frame();
  assert.equal(liveDensityWorkers(), 1);
  return r;
}

test('in the tab: hidden ends the density worker; at rest (long without sound) it ends too', async () => {
  const m = await mount();
  const lab = liveLab();
  m.vis.setVisible(false);
  assert.equal(lab.worker().terminated, true, 'ended when hidden');
  assert.equal(liveDensityWorkers(), 0);
  m.vis.setVisible(true);
  // No sound: the loop moves on its own clock, then rests.
  const resting = liveLab();
  assert.notEqual(m.session.loop.mode, LOOP_MODES.rest);
  m.h.run((VISUALIZER_IDLE_SECONDS + 2) * 1000, 1000 / 30);
  assert.equal(m.session.loop.mode, LOOP_MODES.rest);
  assert.equal(resting.worker().terminated, true, 'ended at rest');
  assert.equal(liveDensityWorkers(), 0);
  m.session.destroy();
  lab.instance.cleanup(lab.gl);
  resting.instance.cleanup(resting.gl);
});

test('the measuring page reads the counts of the density host made last', () => {
  const first = createDensityRenderer({ Renderer: {} }, { startWorker: () => null });
  assert.equal(densityStatsNow(), first.stats);
  const second = createDensityRenderer({ Renderer: {} }, { startWorker: () => null });
  assert.equal(densityStatsNow(), second.stats);
  assert.notEqual(first.stats, second.stats);
});
