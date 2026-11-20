import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { BUDGET_OVER_MS, BUDGET_READ_MS } from '../src/lib/processor-budget.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { LOOP_MODES } from '../src/visualizer/loop.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Processor use in the Visualizer tab: what is read, when, and what it
   changes. No GPU; fake clocks. */

function playingSource() {
  const node = fakeAnalyser({ level: 60, db: -60 });
  return {
    node,
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
}

async function mount({ settings = {}, renderer = 'ANGLE (Fake GPU)', share = 0.1 } = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements({ width: 1280, height: 720 });
  const win = fakeResizeObserverWin(fakeMotion(false));
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  const realGet = gl.getParameter.bind(gl);
  gl.getParameter = (name) => (name === gl.RENDERER ? renderer : realGet(name));
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const reads = [];
  const m = {
    h, reads, source, signal, share,
    play() { source.playing = true; signal.refresh(); },
    apply(partial) { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
  };
  m.session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    scenes: SCENES,
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    readProcessorUse: async () => { reads.push(h.io.clock()); return { available: true, share: m.share }; },
  });
  for (let round = 0; round < 400 && !m.session.switcher.current; round += 1) {
    await settle(() => Boolean(m.session.switcher.current), 20);
    h.run(COMPILE_POLL_MS);
  }
  assert.ok(m.session.switcher.current, 'first scene');
  return m;
}

/** Run the clock in reading-sized steps, letting the replies arrive. */
async function runFor(m, ms) {
  for (let t = 0; t < ms; t += 500) {
    m.h.run(500, 1000 / 30);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }
}

test('Light reads nothing, even while sound plays', async () => {
  const m = await mount();
  m.play();
  await runFor(m, 20_000);
  assert.equal(m.session.loop.mode, LOOP_MODES.live);
  assert.deepEqual(m.reads, []);
  m.session.destroy();
});

test('Balanced reads only while sound plays, and stops with it', async () => {
  const m = await mount({ settings: { processorUse: 'balanced' } });
  await runFor(m, 10_000);
  assert.deepEqual(m.reads, [], 'no sound: no reading');
  m.play();
  await runFor(m, 10_000);
  assert.ok(m.reads.length >= 2 && m.reads.length <= 10_000 / BUDGET_READ_MS + 1, String(m.reads.length));
  m.source.playing = false;
  m.signal.refresh();
  await runFor(m, 2_000);
  const after = m.reads.length;
  await runFor(m, 20_000);
  assert.equal(m.reads.length, after, 'stopped with the sound');
  m.session.destroy();
});

test('Balanced over its limit steps the quality down; back to Light stops reading', async () => {
  const m = await mount({ settings: { processorUse: 'balanced', visualizerQuality: 'high' }, share: 0.9 });
  m.play();
  await runFor(m, BUDGET_OVER_MS + 4 * BUDGET_READ_MS);
  assert.equal(m.session.stepDown.quality, 'medium');
  m.apply({ processorUse: 'light' });
  const after = m.reads.length;
  await runFor(m, 20_000);
  assert.equal(m.reads.length, after);
  m.session.destroy();
});

test('a picture drawn by the processor with no quality ever picked: Low at Light, the default at Balanced', async () => {
  const m = await mount({ renderer: 'Google SwiftShader' });
  assert.equal(m.session.stepDown.quality, 'low');
  m.apply({ processorUse: 'balanced' });
  assert.equal(m.session.stepDown.quality, 'medium');
  m.apply({ processorUse: 'light' });
  assert.equal(m.session.stepDown.quality, 'low');
  // Picked by hand in the tab: respected from then on.
  m.session.controls.qualitySelect.value = 'medium';
  m.session.controls.qualitySelect.dispatchEvent(new Event('change'));
  assert.equal(m.session.stepDown.quality, 'medium');
  m.session.destroy();
  const gpu = await mount();
  assert.equal(gpu.session.stepDown.quality, 'medium', 'a graphics card: the default at Light too');
  gpu.session.destroy();
});

test('a quality picked by hand is drawn on a processor-drawn picture at every level', async () => {
  for (const settings of [
    { visualizerQuality: 'high' },
    { visualizerQuality: 'medium', visualizerQualityPicked: true },
    { visualizerQuality: 'high', processorUse: 'balanced' },
  ]) {
    const m = await mount({ settings, renderer: 'Google SwiftShader' });
    assert.equal(m.session.stepDown.quality, settings.visualizerQuality, JSON.stringify(settings));
    m.session.destroy();
  }
});

test('the shuffle\'s cost ceiling follows the level unless the filter was picked by hand', async () => {
  const m = await mount();
  assert.equal(m.session.shuffleCostMax, 'medium', 'Light: as before');
  m.apply({ processorUse: 'balanced' });
  assert.equal(m.session.shuffleCostMax, 'heavy');
  m.apply({ processorUse: 'high' });
  assert.equal(m.session.shuffleCostMax, 'heavy');
  m.apply({ processorUse: 'light' });
  assert.equal(m.session.shuffleCostMax, 'medium');
  // Picked by hand: kept at every level, even the default.
  m.apply({ visualizerShuffleCost: 'medium', visualizerShuffleCostPicked: true, processorUse: 'high' });
  assert.equal(m.session.shuffleCostMax, 'medium');
  m.session.destroy();
  const light = await mount({ settings: { visualizerShuffleCost: 'light', processorUse: 'high' } });
  assert.equal(light.session.shuffleCostMax, 'light', 'a filter other than the default is kept');
  light.session.destroy();
});

test('a line under the Scenes choice says when Processor use includes heavy scenes too', async () => {
  const m = await mount();
  const note = m.session.controls.shuffleCostNote;
  const shown = () => (note.hidden ? '' : note.textContent);
  assert.equal(shown(), '', 'Light: nothing');
  m.apply({ processorUse: 'balanced' });
  assert.equal(shown(), 'Processor use is set to Balanced: heavy scenes are included too.');
  m.apply({ processorUse: 'high' });
  assert.equal(shown(), 'Processor use is set to High: heavy scenes are included too.');
  // Picked by hand in the panel: the choice is what is used, no line.
  m.session.controls.shuffleCost.value = 'medium';
  m.session.controls.shuffleCost.dispatchEvent(new Event('change'));
  assert.equal(shown(), '');
  m.apply({ processorUse: 'balanced' });
  assert.equal(shown(), '');
  m.session.destroy();
  for (const settings of [{ processorUse: 'high', visualizerShuffleCost: 'all' }, { processorUse: 'high', visualizerShuffleCost: 'light' }]) {
    const other = await mount({ settings });
    assert.equal(other.session.controls.shuffleCostNote.hidden, true, JSON.stringify(settings));
    other.session.destroy();
  }
  const high = await mount({ settings: { processorUse: 'high' } });
  assert.equal(high.session.controls.shuffleCostNote.hidden, false, 'shown from the start');
  high.session.destroy();
});
