import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COLOUR_TRAVEL_BARS_PER_TURN, COLOUR_TRAVEL_GLSL, COLOUR_TRAVEL_RELEASED, LUMA, colourTravel, colourTravelAllowed,
  createColourTravel,
} from '../src/visualizer/colour-travel.js';
import { DRIFT_BPM_RANGE, DRIFT_WRAP_BARS } from '../src/visualizer/drift.js';
import { LOOK_ADJUSTED, LOOKS_LEFT_OUT, PRESETS_LEFT_OUT } from '../src/visualizer/looks.js';
import { HELD_SCENE_ENTRIES, SCENES } from '../src/visualizer/scenes.js';

const luma = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

test('the turn keeps every pixel\'s luma, stays inside 0..1 and keeps greys grey', () => {
  let seed = 11;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 20000; i += 1) {
    const c = [random(), random(), random()];
    const angle = random() * 2 * Math.PI;
    const out = colourTravel(c, angle);
    assert.ok(Math.abs(luma(out) - luma(c)) < 1e-9, `${c} ${angle}`);
    for (const v of out) assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${c} ${angle}: ${out}`);
  }
  for (const g of [0, 0.3, 1]) {
    assert.deepEqual(colourTravel([g, g, g], 1.2).map((v) => Math.round(v * 1e9) / 1e9), [g, g, g]);
  }
  // It really turns: pure red goes somewhere else, at the same luma.
  const red = colourTravel([1, 0, 0], Math.PI / 2);
  assert.ok(Math.abs(red[0] - 1) > 0.1);
  // A whole turn is no change.
  const c = [0.2, 0.5, 0.7];
  colourTravel(c, 2 * Math.PI).forEach((v, k) => assert.ok(Math.abs(v - c[k]) < 1e-9));
});

test('the shader does the same steps', () => {
  assert.match(COLOUR_TRAVEL_GLSL, /float y = dot\(c, w\);/);
  assert.match(COLOUR_TRAVEL_GLSL, /vec3 t = d \* cos\(angle\) \+ cross\(n, d\) \* sin\(angle\);/);
  assert.match(COLOUR_TRAVEL_GLSL, /return vec3\(y\) \+ t \* max\(s, 0\.0\);/);
  assert.doesNotMatch(COLOUR_TRAVEL_GLSL, /hueRot/);
});

test('the rate is tied to the drift clock\'s bars and bounded; its wrap is followed through', () => {
  const travel = createColourTravel();
  const barsPerSecond = DRIFT_BPM_RANGE[1] / 4 / 60;
  let bars = 0;
  let before = travel.step(bars);
  let most = 0;
  for (let frame = 0; frame < 60 * 120; frame += 1) {
    bars = (bars + barsPerSecond / 60) % DRIFT_WRAP_BARS;
    const angle = travel.step(bars);
    let step = Math.abs(angle - before);
    if (step > Math.PI) step = 2 * Math.PI - step;
    most = Math.max(most, step);
    before = angle;
  }
  const perSecond = (most * 60 * 180) / Math.PI;
  assert.ok(perSecond <= (360 * barsPerSecond) / COLOUR_TRAVEL_BARS_PER_TURN + 1e-6, `${perSecond} degrees a second`);
  assert.ok(perSecond < 4);
  // A clock that stands still, or no clock, moves nothing.
  const still = createColourTravel();
  still.step(3);
  assert.equal(still.step(3), 0);
  assert.equal(still.step(Number.NaN), 0);
});

test('which scenes may travel: not the held, left-out or colour-held ones, not those without effects', () => {
  for (const entry of [...SCENES, ...HELD_SCENE_ENTRIES]) {
    const out = entry.fxNone || HELD_SCENE_ENTRIES.includes(entry)
      || Object.hasOwn(LOOK_ADJUSTED, entry.id) || Object.hasOwn(LOOKS_LEFT_OUT, entry.id)
      || Object.hasOwn(PRESETS_LEFT_OUT, entry.id);
    assert.equal(colourTravelAllowed(entry), !out, entry.id);
  }
  for (const id of ['mandelbrot', 'physarum', 'fractal_flame_lab', 'fluid_ink', 'path_traced_fractal_flight']) {
    const entry = SCENES.find((row) => row.id === id);
    if (entry) assert.equal(colourTravelAllowed(entry), false, id);
  }
  assert.ok(SCENES.filter(colourTravelAllowed).length > 30);
  assert.equal(colourTravelAllowed(null), false);
});

test('held and not wired', () => {
  assert.equal(COLOUR_TRAVEL_RELEASED, false);
  for (const path of ['src/visualizer/index.js', 'src/visualizer/fx-chain.js']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /colour-travel/, path);
  }
});
