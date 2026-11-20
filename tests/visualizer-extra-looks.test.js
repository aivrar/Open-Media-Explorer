import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXTRA_LOOKS, EXTRA_LOOKS_HELD, EXTRA_LOOKS_LEFT_OUT, EXTRA_LOOK_FIRST, lookOverrides, sceneLooks,
} from '../src/visualizer/looks.js';
import { VISUALIZER_LOOK_MAX } from '../src/lib/visualizer-settings.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { sceneById } from '../src/visualizer/scenes.js';
import { FakeGL } from './helpers/visualizer-fakes.js';

/* The labs' formulas that no preset shows, as extra looks: offered since
   measured, except those left out; upstream defaults only. No GPU. */

const LABS = Object.freeze({
  escape_time_lab: ['formula'],
  analytic_field_lab: ['field_mode'],
  fractal_flame_lab: ['flame_variation_a', 'flame_variation_b'],
});

async function registered(id) {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  return renderer.register(await sceneById(id).load(), id);
}

const presetsOf = (def) => [def.smokePresets, def.fractalFlight?.smokePresets, def.meta?.smokePresets].find(Array.isArray) || [];

test('released: offered after the presets, except those left out; a saved number of one left out shows the start look', async () => {
  assert.equal(EXTRA_LOOKS_HELD, false);
  assert.deepEqual(Object.keys(EXTRA_LOOKS).sort(), Object.keys(LABS).sort());
  // Measured: these change by 0.1 to 0.46 a frame; the 28 offered by 0.05 at most.
  assert.deepEqual(EXTRA_LOOKS_LEFT_OUT, { escape_time_lab: [20, 22, 38, 39, 40, 41, 42] });
  const counts = {};
  for (const id of Object.keys(LABS)) {
    const def = await registered(id);
    const offered = sceneLooks(def);
    const extra = offered.filter((look) => look.number >= EXTRA_LOOK_FIRST);
    counts[id] = extra.length;
    const out = EXTRA_LOOKS_LEFT_OUT[id] || [];
    assert.deepEqual(extra.map((look) => look.number),
      EXTRA_LOOKS[id].map((row, index) => EXTRA_LOOK_FIRST + index).filter((number) => !out.includes(number)), id);
    const entry = sceneById(id);
    for (const number of out) {
      assert.deepEqual(lookOverrides(entry, def, number), entry.defaults || null, `${id} #${number}`);
    }
    // An offered one sets its formula.
    assert.deepEqual(lookOverrides(entry, def, extra[0].number), { ...(entry.defaults || {}), ...extra[0].values }, id);
    // Every preset number stays below the first extra number.
    assert.ok(presetsOf(def).length < EXTRA_LOOK_FIRST, id);
  }
  assert.deepEqual(counts, { escape_time_lab: 16, analytic_field_lab: 2, fractal_flame_lab: 10 });
});

test('for the flash check: numbered on from 20 in order, named by their labels, within the saved range', async () => {
  for (const [id, params] of Object.entries(LABS)) {
    const def = await registered(id);
    const offered = sceneLooks(def);
    const all = sceneLooks(def, { held: true });
    const extra = all.filter((look) => look.number >= EXTRA_LOOK_FIRST);
    assert.deepEqual(all.filter((look) => offered.some((row) => row.number === look.number)), [...offered], `${id}: the offered looks, unchanged`);
    assert.equal(extra.length, EXTRA_LOOKS[id].length, id);
    extra.forEach((look, index) => {
      assert.equal(look.number, EXTRA_LOOK_FIRST + index);
      assert.ok(look.number <= VISUALIZER_LOOK_MAX);
      assert.deepEqual(Object.keys(look.values).sort(), [...params].sort(), `${id}: only the formula, upstream defaults otherwise`);
      const labels = params.map((name) => def.params.find((param) => param.name === name).options[look.values[name]]);
      assert.equal(look.name, labels.join(' + '));
    });
    const names = all.map((look) => look.name);
    assert.equal(new Set(names).size, names.length, `${id}: every name its own`);
  }
});

test('the extra looks are exactly the formulas no preset shows', async () => {
  for (const [id, params] of Object.entries(LABS)) {
    const def = await registered(id);
    const presets = presetsOf(def);
    for (const name of params) {
      const param = def.params.find((row) => row.name === name);
      const shown = new Set(presets.map((preset) => preset.values?.[name]).filter(Number.isInteger));
      shown.add(param.default);
      const extra = new Set(EXTRA_LOOKS[id].map((values) => values[name])
        .filter((value) => value !== param.default));
      for (const value of extra) assert.ok(!shown.has(value), `${id}.${name} ${value}: a preset shows it`);
      const every = new Set([...shown, ...extra]);
      assert.equal(every.size, param.options.length, `${id}.${name}: every option shown once`);
    }
  }
  // Flame pairs keep the other variation at Psychedelia's default.
  const flame = await registered('fractal_flame_lab');
  const a = flame.params.find((param) => param.name === 'flame_variation_a').default;
  const b = flame.params.find((param) => param.name === 'flame_variation_b').default;
  for (const values of EXTRA_LOOKS.fractal_flame_lab) {
    assert.ok(values.flame_variation_a === a || values.flame_variation_b === b, JSON.stringify(values));
  }
});

test('the flash check can draw them (--held-looks)', () => {
  const text = readFileSync('tests/helpers/visualizer-flash-check.mjs', 'utf8');
  assert.match(text, /const heldLooks = args\.includes\('--held-looks'\);/);
  assert.match(text, /sceneLooks\(def, \{ all: allLooks, held: heldLooks \}\)/);
});
