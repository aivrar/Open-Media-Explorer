import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OFFERED_OWN_SCENES, OWN_SCENES_PROPOSED, OWN_SCENES_RELEASED, OWN_SCENE_ENTRIES,
} from '../src/visualizer/own-scenes.js';
import { COST_CLASSES, SCENES, sceneById } from '../src/visualizer/scenes.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { sceneLooks } from '../src/visualizer/looks.js';
import { FakeGL } from './helpers/visualizer-fakes.js';

/* World Media's own scenes (own-scenes.js): released with their measured
   settings, their sound moving shape only, their looks their palettes. No
   GPU. */

const IDS = Object.freeze(['band_ridges', 'band_ring', 'hex_weave', 'contour_lines', 'petal_bloom']);
const source = (entry) => readFileSync(join('src', 'visualizer', entry.file), 'utf8');

async function registered(id) {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const entry = OWN_SCENE_ENTRIES.find((row) => row.id === id);
  return renderer.register(await entry.load(), id);
}

test('released: all five offered with their measured settings (cost, a 1.5x speed cap, drift, the usual effects)', () => {
  // Measured on the graphics card: every look over 360 s of their clock at
  // the 1.5x cap, with and without drift: 0.013 a frame at most, under 0.05
  // for 0.4 s at most; drawn as the tab paces them, 5.5 to 8.8% of a core
  // (Plasma 7.2%).
  assert.equal(OWN_SCENES_RELEASED, true);
  assert.deepEqual(OFFERED_OWN_SCENES, [...OWN_SCENE_ENTRIES]);
  assert.deepEqual(OWN_SCENE_ENTRIES.map((entry) => entry.id), IDS);
  assert.deepEqual(Object.fromEntries(OWN_SCENE_ENTRIES.map((entry) => [entry.id, entry.cost])), {
    band_ridges: 'light', band_ring: 'light', hex_weave: 'light', contour_lines: 'medium', petal_bloom: 'light',
  });
  for (const entry of OWN_SCENE_ENTRIES) {
    assert.ok(SCENES.includes(entry), entry.id);
    assert.equal(sceneById(entry.id), entry, entry.id);
    assert.equal(SCENES.filter((scene) => scene.id === entry.id || scene.name === entry.name).length, 1, `${entry.id}: a name of its own`);
    assert.equal(entry.maxSpeed, 1.5);
    assert.equal(entry.drift, undefined, `${entry.id}: drift, its own plan`);
    assert.equal(entry.fxNone, false);
    assert.equal(entry.fxCalm, false);
    assert.equal(entry.links, null);
    assert.equal(entry.audio, 'shader');
    assert.match(entry.mood, /^(calm|lively)$/);
    assert.match(entry.hue, /^(warm|cool|rainbow)$/);
    // PROPOSED values, for after measuring.
    const proposed = OWN_SCENES_PROPOSED[entry.id];
    assert.ok(COST_CLASSES.includes(proposed.cost), entry.id);
    assert.ok(proposed.maxSpeed >= 1);
  }
  assert.deepEqual(Object.keys(OWN_SCENES_PROPOSED).sort(), [...IDS].sort());
});

test('each registers under its id with every param a uniform of its shader', async () => {
  for (const id of IDS) {
    const def = await registered(id);
    assert.ok(def, id);
    assert.equal(def.name, id);
    assert.equal(def.label, OWN_SCENE_ENTRIES.find((entry) => entry.id === id).name);
    for (const param of def.params) {
      assert.match(def.shader, new RegExp(`uniform float u_${param.name};`), `${id}: ${param.name}`);
      if (param.type !== 'select') {
        assert.ok(param.min < param.max && param.default >= param.min && param.default <= param.max, `${id}: ${param.name}`);
      }
    }
    assert.match(def.shader, /FRAG_OUT = vec4\(col, 1\.0\);/);
    // Balanced braces and brackets (a cheap guard against a broken shader).
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      assert.equal(def.shader.split(open).length, def.shader.split(close).length, `${id}: ${open}${close}`);
    }
  }
});

test('their looks are their four palettes', async () => {
  for (const id of IDS) {
    const def = await registered(id);
    const palette = def.params.find((param) => param.name === 'palette');
    const looks = sceneLooks(def);
    assert.equal(looks.length, 4, id);
    assert.deepEqual(looks.map((look) => look.name), palette.options, id);
  }
});

test('the compile check page builds every look of each own scene on both contexts and reports failures', async () => {
  const made = [];
  globalThis.window = globalThis.window || {};
  const before = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext(mode) {
        const gl = new FakeGL();
        made.push(mode);
        // One shader that does not compile, to see the log reported.
        gl.getShaderParameter = (shader) => !/u_rings/.test(shader.source || '');
        gl.getShaderInfoLog = () => 'ERROR: 0:1: fake';
        return gl;
      },
    }),
  };
  try {
    await import('./helpers/visualizer-compile-check-page.js');
    assert.equal(window.compileReady, true);
    const rows = await window.checkCompile([]);
    assert.deepEqual(made, ['webgl2', 'webgl']);
    assert.equal(rows.length, 2 * 4 * IDS.length, 'each scene, each look, both contexts');
    assert.deepEqual([...new Set(rows.map((row) => row.id))].sort(), [...IDS].sort());
    const failing = rows.filter((row) => !row.ok);
    assert.ok(failing.length > 0 && failing.every((row) => row.id === 'band_ring'));
    assert.match(failing[0].fragment, /fake/);
    const unknown = await window.checkCompile(['no_such_scene']);
    assert.ok(unknown.every((row) => !row.ok && row.link === 'unknown scene'));
  } finally {
    globalThis.document = before;
  }
});

test('their sound moves shape only: the bands after the flash limiter, scaled by Sound Response, never the beat', async () => {
  for (const entry of OWN_SCENE_ENTRIES) {
    const def = await registered(entry.id);
    const shader = def.shader;
    assert.doesNotMatch(shader, /u_beat/, entry.id);
    // u_audio is read only into the band values, each clamped and scaled by
    // the response.
    const reads = shader.split('\n').filter((line) => /u_audio\./.test(line));
    assert.ok(reads.length >= 1, entry.id);
    for (const line of reads) {
      assert.match(line, /^\s*float (bass|mid|high) = clamp\(u_audio\.[xyz], 0\.0, 1\.0\) \* (react|clamp\(u_react, 0\.0, 1\.0\));$/, `${entry.id}: ${line}`);
    }
    // No band reaches a colour, brightness or palette call.
    for (const line of shader.split('\n')) {
      if (/Palette\(|u_brightness/.test(line)) assert.doesNotMatch(line, /\b(bass|mid|high)\b/, `${entry.id}: ${line}`);
    }
    // Nothing borrowed, and said so.
    assert.match(source(entry), /No borrowed code/);
    assert.match(source(entry), /^[\x00-\x7f]*$/, `${entry.id}: ASCII`);
  }
});
