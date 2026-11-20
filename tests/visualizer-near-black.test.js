/*
 * The near-black sweep (every offered scene and look, 30 s each at Medium on
 * the graphics card): a look under 0.05 for more than about 2 s at a time
 * reads as broken. The looks it found are held lit (looks.js LOOK_ADJUSTED)
 * or left out (LOOKS_LEFT_OUT, PRESETS_LEFT_OUT).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LOOK_ADJUSTED, LOOKS_LEFT_OUT, PRESETS_LEFT_OUT, sceneLooks } from '../src/visualizer/looks.js';
import { sceneById } from '../src/visualizer/scenes.js';
import { createSceneRenderer, sceneDefaults } from '../src/visualizer/scene-renderer.js';
import { FakeGL } from './helpers/visualizer-fakes.js';

const HELD_LIT = Object.freeze({
  escape_time_lab: { 'Magnet Gate': { brightness: 1.6 } },
  mandelbulb_slice: { Organic: { color_speed: 0 }, 'Neon Magma': { color_speed: 0 } },
  multibrot: { 'Amber Crown': { color_speed: 0 } },
  orbit_trap: { 'Amber Lines': { color_speed: 0 } },
  sierpinski: { 'Violet Gold': { glow: 1.4 } },
  tricorn: { 'Gold Glass': { color_speed: 0 } },
});

const LEFT_OUT = Object.freeze({
  liquid_chrome: ['Black Mirror'],
  multibrot: ['Blue Magenta', 'Violet Gold'],
  mandelbulb_slice: ['Aqua Rose', 'Violet Gold'],
  orbit_trap: ['Blue Orchid'],
  tricorn: ['Ruby Ice', 'Toxic Violet'],
  mandelbox_flight: ['Molten Brass', 'Ember Vault'],
  analytic_field_lab: ['Continued Portal'],
  fractal_flame_volume_flight: ['Swirl Flame Dive'],
});

async function looksOf(renderer, id, options) {
  const def = renderer.register(await sceneById(id).load(), id);
  return sceneLooks(def, options);
}

test('the near-black sweep: these looks are offered held lit, with their values', async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  for (const [id, rows] of Object.entries(HELD_LIT)) {
    const looks = await looksOf(renderer, id);
    for (const [name, values] of Object.entries(rows)) {
      assert.deepEqual({ ...LOOK_ADJUSTED[id][name] }, values, `${id} ${name}: in the table`);
      const look = looks.find((row) => row.name === name);
      assert.ok(look, `${id} ${name}: offered`);
      for (const [param, value] of Object.entries(values)) assert.equal(look.values[param], value, `${id} ${name}: ${param}`);
    }
  }
  renderer.destroy();
});

test('the near-black sweep: 3D Fractal Flame Volume Flight starts on its Spherical Bloom Cloud preset (its own start look sat near black)', async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const id = 'fractal_flame_volume_flight';
  const def = renderer.register(await sceneById(id).load(), id);
  const presets = def.smokePresets || def.fractalFlight?.smokePresets || def.meta?.smokePresets;
  const bloom = presets.find((preset) => preset.name === 'Spherical Bloom Cloud');
  assert.deepEqual({ ...sceneById(id).defaults }, { ...bloom.values });
  // Its start look (number 0) draws the scene's defaults: those values.
  const start = sceneLooks(def).find((look) => look.number === 0);
  assert.deepEqual({ ...start.values }, {});
  const drawn = sceneDefaults(def, sceneById(id).defaults);
  for (const [param, value] of Object.entries(bloom.values)) assert.equal(drawn[param], value, param);
  renderer.destroy();
});

test('the near-black sweep: these looks are left out (and come back only with all), the scene keeps its others', async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  for (const [id, names] of Object.entries(LEFT_OUT)) {
    assert.ok(Object.hasOwn(LOOKS_LEFT_OUT, id) || Object.hasOwn(PRESETS_LEFT_OUT, id), `${id}: in a left-out table`);
    const offered = (await looksOf(renderer, id)).map((look) => look.name);
    const all = (await looksOf(renderer, id, { all: true })).map((look) => look.name);
    for (const name of names) {
      assert.ok(all.includes(name), `${id} ${name}: a look of the scene`);
      assert.ok(!offered.includes(name), `${id} ${name}: left out`);
    }
    assert.equal(offered.length, all.length - names.length, `${id}: only those left out`);
    assert.ok(offered.length >= 2, `${id}: still has looks to choose from`);
  }
  renderer.destroy();
});
