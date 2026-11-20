import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { PROCESSOR_EXTRAS_RELEASED, SIM_SIZES_ABOVE_HIGH, VERY_HIGH_HEAVY_ALLOWED } from '../src/lib/processor-budget.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { SCENES, sceneCaps } from '../src/visualizer/scenes.js';
import { QUALITY_TEXT, mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import { SimGL, withWebgl2Global } from './helpers/sim-fakes.js';
import {
  FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Very high and the simulations' larger sizes in the Visualizer tab, as the
   Processor use level gives them (processor-budget.js processorExtras). No
   GPU; fake clocks. */

async function mount({ settings = {}, width = 2560, height = 1440 } = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements({ width, height });
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    isPlaying: () => false, isAudible: () => true, getAnalyser: () => null, getVolume: () => 1, release() {}, node,
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  // The simulations' fake context (float targets, so they are offered).
  const gl = new SimGL();
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const m = {
    h,
    get settings() { return current; },
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
    readProcessorUse: async () => ({ available: true, share: 0.1 }),
  });
  await ready(m);
  return m;
}
async function ready(m, test = () => Boolean(m.session.switcher.current)) {
  for (let round = 0; round < 400 && !test(); round += 1) {
    await settle(test, 20);
    m.h.run(COMPILE_POLL_MS);
  }
}
const pixels = (m) => m.session.renderer.width * m.session.renderer.height;
const option = (m) => [...m.session.controls.qualitySelect.children].find((o) => o.value === 'very_high');

test('released: the switch is on', () => {
  assert.equal(PROCESSOR_EXTRAS_RELEASED, true);
});

test('Very high: offered at Balanced and High, not at Light, where a saved one reads as High and is kept', async () => {
  for (const level of ['balanced', 'high']) {
    const m = await mount({ settings: { processorUse: level, visualizerQuality: 'very_high' } });
    assert.equal(m.session.stepDown.quality, 'very_high', level);
    assert.equal(option(m).hidden, false, level);
    assert.equal(m.session.controls.qualitySelect.value, 'very_high', level);
    m.session.destroy();
  }
  const m = await mount({ settings: { visualizerQuality: 'very_high' } });
  assert.equal(m.session.stepDown.quality, 'high');
  assert.equal(option(m).hidden, true);
  assert.equal(m.session.controls.qualitySelect.value, 'high');
  assert.equal(m.settings.visualizerQuality, 'very_high', 'not overwritten');
  // Back to a level that offers it: Very high again.
  m.apply({ processorUse: 'high' });
  assert.equal(m.session.stepDown.quality, 'very_high');
  m.apply({ processorUse: 'light' });
  assert.equal(m.session.stepDown.quality, 'high');
  m.session.destroy();
});

test('Very high draws a Light or Medium scene at twice High\'s pixel budget; a heavy one not measured at High\'s, with the note', async () => {
  const high = await mount({ settings: { processorUse: 'high', visualizerQuality: 'high', visualizerScene: 'plasma' } });
  const atHigh = pixels(high);
  high.session.destroy();
  const m = await mount({ settings: { processorUse: 'high', visualizerQuality: 'very_high', visualizerScene: 'plasma' } });
  assert.ok(pixels(m) > atHigh * 1.8, `${pixels(m)} against ${atHigh}`);
  assert.ok(pixels(m) <= 4800000);
  assert.equal(m.session.controls.qualityNote.hidden, true);
  m.session.destroy();
  const heavy = SCENES.find((scene) => scene.cost === 'heavy' && !(scene.id in VERY_HIGH_HEAVY_ALLOWED) && !scene.needs);
  const h = await mount({ settings: { processorUse: 'high', visualizerQuality: 'very_high', visualizerScene: heavy.id } });
  assert.equal(h.session.switcher.current.id ?? h.session.switcher.current, heavy.id);
  assert.ok(pixels(h) <= 2400000, `${heavy.id}: ${pixels(h)}`);
  assert.equal(h.session.controls.qualityNote.hidden, false);
  assert.equal(h.session.controls.qualityNote.textContent, QUALITY_TEXT.heavyAtHigh);
  h.session.destroy();
});

test('the simulations start one size up at the High level and High quality; not at Balanced', () => withWebgl2Global(async () => {
  for (const [id, row] of Object.entries(SIM_SIZES_ABOVE_HIGH)) {
    const m = await mount({ settings: { processorUse: 'high', visualizerQuality: 'high', visualizerScene: id } });
    assert.equal(m.session.renderer.definition?.name, id);
    assert.deepEqual({ ...m.session.renderer.caps }, { ...sceneCaps(id, 'high'), ...row }, id);
    for (const [name, value] of Object.entries(row)) assert.equal(m.session.renderer.values?.[name], value, `${id}.${name}: set as it starts`);
    m.session.destroy();
    const b = await mount({ settings: { processorUse: 'balanced', visualizerQuality: 'high', visualizerScene: id } });
    assert.deepEqual({ ...b.session.renderer.caps }, { ...sceneCaps(id, 'high') }, `${id} at Balanced`);
    const raised = Object.keys(row).find((name) => row[name] !== sceneCaps(id, 'high')[name]);
    assert.notEqual(b.session.renderer.values?.[raised], row[raised], `${id}.${raised} at Balanced`);
    b.session.destroy();
  }
}));

test('a change of level updates the quality menu at once, the chosen High kept', async () => {
  const m = await mount({ settings: { visualizerQuality: 'high' } });
  assert.equal(option(m).hidden, true, 'Light');
  m.apply({ processorUse: 'balanced' });
  assert.equal(option(m).hidden, false, 'Balanced offers Very high');
  assert.equal(m.session.controls.qualitySelect.value, 'high');
  assert.equal(m.session.stepDown.quality, 'high');
  m.apply({ processorUse: 'light' });
  assert.equal(option(m).hidden, true, 'back to Light');
  assert.equal(m.session.controls.qualitySelect.value, 'high');
  m.session.destroy();
});

test('an open simulation takes the size of a new level through the transition, and back', () => withWebgl2Global(async () => {
  for (const [id, row] of Object.entries(SIM_SIZES_ABOVE_HIGH)) {
    const m = await mount({ settings: { processorUse: 'balanced', visualizerQuality: 'high', visualizerScene: id } });
    const today = sceneCaps(id, 'high');
    const raised = Object.keys(row).find((name) => row[name] !== today[name]);
    assert.deepEqual({ ...m.session.renderer.caps }, { ...today }, id);
    assert.notEqual(m.session.renderer.values?.[raised], row[raised], `${id}: today's size at Balanced`);
    m.apply({ processorUse: 'high' });
    m.h.run(3000, 1000 / 30);
    await settle(() => m.session.renderer.values?.[raised] === row[raised], 20);
    assert.deepEqual({ ...m.session.renderer.caps }, { ...today, ...row }, `${id}: caps at High`);
    assert.equal(m.session.renderer.values?.[raised], row[raised], `${id}.${raised}: set at High`);
    assert.equal(m.session.renderer.definition?.name, id, `${id}: still shown`);
    m.apply({ processorUse: 'balanced' });
    m.h.run(3000, 1000 / 30);
    await settle(() => JSON.stringify({ ...m.session.renderer.caps }) === JSON.stringify({ ...today }), 20);
    assert.deepEqual({ ...m.session.renderer.caps }, { ...today }, `${id}: back at Balanced`);
    assert.equal(m.session.renderer.values?.[raised], today[raised], `${id}.${raised}: back to today's`);
    m.session.destroy();
  }
}));
