import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DENSITY_SHARE_BY_LEVEL, DENSITY_SHARE_MOST, MOST_AT_ONCE_EVERY_LEVEL, PROCESSOR_EXTRAS_RELEASED,
  PROCESSOR_USE_LEVELS, QUALITY_ABOVE_HIGH, SIM_SIZES_ABOVE_HIGH, VERY_HIGH_HEAVY_ALLOWED, densityShareFor, drawsAtVeryHigh,
  processorExtras, qualityAboveHighUseful, simCapsWithExtras, simStartWithExtras,
} from '../src/lib/processor-budget.js';
import {
  VISUALIZER_ALL_QUALITIES, VISUALIZER_FX_MAX, VISUALIZER_OVERLAY_MAX, VISUALIZER_PRESETS, VISUALIZER_QUALITIES, normalizeVisualizerQuality,
  tableQuality, visualizerPreset,
} from '../src/lib/visualizer-settings.js';
import { SCENES, SCENE_QUALITY_CAPS, sceneCaps } from '../src/visualizer/scenes.js';
import { createStepDown, stepDownLevels } from '../src/visualizer/step-down.js';
import { DENSITY_QUALITY } from '../src/visualizer/density-host.js';
import { OVERLAY_MAX } from '../src/visualizer/overlay-catalog.js';
import { FX_MAX_ACTIVE } from '../src/visualizer/fx-shuffle.js';
import { PROCESSOR_EXTRAS_TEXT, processorExtrasParagraph, renderAbout } from '../src/modes/about.js';

const NOTHING = {
  topQuality: 'high', qualityAboveHigh: false, simSizes: null, densityShare: null,
};

test('processor extras: released; held, no level gets any', () => {
  assert.equal(PROCESSOR_EXTRAS_RELEASED, true);
  assert.equal(processorExtras('high').qualityAboveHigh, true);
  assert.deepEqual({ ...processorExtras('light') }, NOTHING);
  for (const level of PROCESSOR_USE_LEVELS) assert.deepEqual({ ...processorExtras(level, false) }, NOTHING, level);
  assert.equal(densityShareFor('high', 'high', 0.35), 0.35);
});

test('processor extras: Light never gets any, even released', () => {
  assert.deepEqual({ ...processorExtras('light', true) }, NOTHING);
  assert.deepEqual({ ...processorExtras('nonsense', true) }, NOTHING, 'an unknown level reads as Light');
  assert.equal(densityShareFor('light', 'medium', 0.25, true), 0.25, 'the table is empty: the host\'s own');
});

test('processor extras: released, Balanced and High offer Very high; only High the larger simulations', () => {
  const balanced = processorExtras('balanced', true);
  assert.equal(balanced.topQuality, QUALITY_ABOVE_HIGH.id);
  assert.equal(balanced.qualityAboveHigh, true);
  assert.equal(balanced.simSizes, null);
  assert.equal(balanced.densityShare, DENSITY_SHARE_BY_LEVEL.balanced);
  const high = processorExtras('high', true);
  assert.equal(high.topQuality, QUALITY_ABOVE_HIGH.id);
  assert.equal(high.qualityAboveHigh, true);
  assert.equal(high.simSizes, SIM_SIZES_ABOVE_HIGH);
  for (const level of PROCESSOR_USE_LEVELS) assert.equal('lineSegments' in processorExtras(level, true), false, 'the segment limit stays');
});

test('Very high: a quality a setting may hold, drawn with High\'s table rows and twice its pixel budget', () => {
  assert.deepEqual([...VISUALIZER_ALL_QUALITIES], [...VISUALIZER_QUALITIES, 'very_high']);
  assert.equal(normalizeVisualizerQuality('very_high'), 'very_high');
  assert.equal(tableQuality('very_high'), 'high');
  for (const quality of VISUALIZER_QUALITIES) assert.equal(tableQuality(quality), quality);
  assert.equal(visualizerPreset('very_high').maxPixels, QUALITY_ABOVE_HIGH.maxPixels);
  assert.equal(visualizerPreset('very_high').scale, 1);
  assert.equal(visualizerPreset('very_high').label, 'Very high');
  assert.equal(visualizerPreset('high'), VISUALIZER_PRESETS.high);
});

test('Very high by cost class: Light and Medium scenes at its budget; Heavy at High\'s unless measured', () => {
  assert.deepEqual(Object.keys(VERY_HIGH_HEAVY_ALLOWED).sort(), ['curl_silk', 'fluid_ink', 'lenia', 'mandelbox_flight', 'physarum']);
  for (const [id, ms] of Object.entries(VERY_HIGH_HEAVY_ALLOWED)) {
    const entry = SCENES.find((scene) => scene.id === id);
    assert.ok(entry, id);
    assert.equal(entry.cost, 'heavy', id);
    assert.ok(ms < 1000 / 30, `${id}: under a 30 fps frame`);
    assert.equal(drawsAtVeryHigh(entry), true, id);
  }
  for (const entry of SCENES) {
    if (entry.cost !== 'heavy') assert.equal(drawsAtVeryHigh(entry), true, entry.id);
    else if (!(entry.id in VERY_HIGH_HEAVY_ALLOWED)) assert.equal(drawsAtVeryHigh(entry), false, entry.id);
  }
  for (const id of ['path_traced_fractal_flight', 'fractal_canyon', 'golden_hour_clouds']) {
    const entry = SCENES.find((scene) => scene.id === id);
    if (entry) assert.equal(drawsAtVeryHigh(entry), false, `${id}: measured over a 30 fps frame`);
  }
  assert.equal(drawsAtVeryHigh(null), false);
});

test('the step-down starts at Very high when chosen and goes through High', () => {
  assert.deepEqual(stepDownLevels('very_high', 30).map((level) => level.quality).slice(0, 4), ['very_high', 'high', 'medium', 'low']);
  assert.deepEqual(stepDownLevels('high', 30).map((level) => level.quality).slice(0, 3), ['high', 'medium', 'low']);
  assert.equal(createStepDown({ quality: 'very_high', fps: 30 }).quality, 'very_high');
});

test('the simulations one size up: at the High level and High quality only, a size already set wins', () => {
  assert.deepEqual(Object.keys(SIM_SIZES_ABOVE_HIGH).sort(), ['curl_silk', 'fluid_ink', 'physarum'], 'Lenia keeps its size');
  for (const [id, row] of Object.entries(SIM_SIZES_ABOVE_HIGH)) {
    const caps = sceneCaps(id, 'high');
    assert.deepEqual(simCapsWithExtras(id, 'high', caps, 'high', true), { ...caps, ...row }, id);
    assert.equal(simCapsWithExtras(id, 'high', caps, 'balanced', true), caps, `${id}: Balanced keeps today's`);
    assert.equal(simCapsWithExtras(id, 'medium', sceneCaps(id, 'medium'), 'high', true), sceneCaps(id, 'medium'), `${id}: Medium keeps today's`);
    assert.equal(simCapsWithExtras(id, 'high', caps, 'high', false), caps, `${id}: held`);
    const params = Object.keys(row);
    assert.deepEqual(simStartWithExtras(id, 'high', null, params, 'high', true), { ...row }, `${id}: set as it starts`);
    const picked = Object.fromEntries(params.map((name) => [name, 0]));
    assert.deepEqual(simStartWithExtras(id, 'high', picked, params, 'high', true), picked, `${id}: a size set by a look or by hand wins`);
    assert.equal(simStartWithExtras(id, 'high', null, params, 'light', true), null, `${id}: Light`);
  }
  assert.equal(simCapsWithExtras('lenia', 'high', sceneCaps('lenia', 'high'), 'high', true), sceneCaps('lenia', 'high'));
  assert.equal(simStartWithExtras('lenia', 'high', null, ['resolution'], 'high', true), null);
});

test('processor extras: each proposal is one step above today\'s High', () => {
  // The quality: the same scale, twice the pixel budget (as each step today).
  const today = VISUALIZER_PRESETS.high;
  assert.equal(QUALITY_ABOVE_HIGH.scale, today.scale);
  assert.equal(QUALITY_ABOVE_HIGH.maxPixels, today.maxPixels * 2);
  assert.deepEqual([...QUALITY_ABOVE_HIGH.levels], ['balanced', 'high']);
  assert.equal(qualityAboveHighUseful(1920 * 1080), false, 'High already draws every pixel');
  assert.equal(qualityAboveHighUseful(2560 * 1440), true);
  assert.equal(qualityAboveHighUseful(undefined), false);
  // The simulations: one option up, on a setting the scene already caps.
  for (const [id, row] of Object.entries(SIM_SIZES_ABOVE_HIGH)) {
    const now = SCENE_QUALITY_CAPS[id]?.high;
    assert.ok(now, id);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(now).sort(), id);
    const raised = Object.keys(row).filter((key) => row[key] !== now[key]);
    assert.equal(raised.length, 1, `${id}: one setting up`);
    assert.equal(row[raised[0]], now[raised[0]] + 1, `${id}.${raised[0]}`);
    assert.ok(row[raised[0]] <= 2, 'within the three options');
  }
});

test('processor extras: the worker share table holds the shares measured (slice 16), the density host\'s own at every level', () => {
  for (const level of PROCESSOR_USE_LEVELS) {
    assert.deepEqual(Object.keys(DENSITY_SHARE_BY_LEVEL[level]), Object.keys(DENSITY_QUALITY), level);
  }
  // Measured at the density host's own shares; larger ones not yet, so no
  // level gives more than those.
  for (const level of PROCESSOR_USE_LEVELS) {
    assert.deepEqual({ ...DENSITY_SHARE_BY_LEVEL[level] }, { low: 0.15, medium: 0.25, high: 0.35 }, level);
    for (const quality of Object.keys(DENSITY_QUALITY)) {
      assert.equal(DENSITY_SHARE_BY_LEVEL[level][quality], DENSITY_QUALITY[quality].share, `${level} ${quality}`);
      assert.equal(densityShareFor(level, quality, 0.01, true), level === 'light' ? 0.01 : DENSITY_QUALITY[quality].share);
      assert.equal(densityShareFor(level, quality, 0.01, false), 0.01, 'held: the fallback');
    }
  }
  assert.ok(DENSITY_SHARE_MOST <= 0.5);
});

test('processor extras: no level allows more effects or overlays at once', () => {
  assert.equal(MOST_AT_ONCE_EVERY_LEVEL, 3);
  assert.equal(VISUALIZER_FX_MAX, MOST_AT_ONCE_EVERY_LEVEL);
  assert.equal(VISUALIZER_OVERLAY_MAX, MOST_AT_ONCE_EVERY_LEVEL);
  assert.equal(OVERLAY_MAX, MOST_AT_ONCE_EVERY_LEVEL);
  assert.equal(FX_MAX_ACTIVE, MOST_AT_ONCE_EVERY_LEVEL);
  for (const level of PROCESSOR_USE_LEVELS) {
    assert.ok(!('fxMax' in processorExtras(level, true)) && !('overlayMax' in processorExtras(level, true)), level);
  }
});

test('processor extras: the About page says what they are, and nothing while held', () => {
  assert.equal(processorExtrasParagraph(false), '');
  const host = { innerHTML: '', querySelector: () => null };
  renderAbout(host);
  assert.ok(host.innerHTML.includes('Processor use'));
  assert.ok(host.innerHTML.includes('data-about-processor-extras'));
  for (const line of PROCESSOR_EXTRAS_TEXT) assert.ok(host.innerHTML.includes(line.slice(0, 40)));
  assert.match(PROCESSOR_EXTRAS_TEXT[0], /Very high/);
  assert.doesNotMatch(PROCESSOR_EXTRAS_TEXT[0], /line/);
  // Released, both lines; the second is the plain sentence about three at once.
  const shown = processorExtrasParagraph(true);
  assert.equal(shown.split('<p data-about-processor-extras>').length - 1, 2);
  assert.match(PROCESSOR_EXTRAS_TEXT[1], /three of each/);
  for (const line of PROCESSOR_EXTRAS_TEXT) assert.match(line, /^[\x20-\x7e]+$/);
});
