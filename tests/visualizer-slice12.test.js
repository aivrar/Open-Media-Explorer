import test from 'node:test';
import assert from 'node:assert/strict';

import loadPostFx from '../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import loadPalettes from '../src/visualizer/vendor/psychedelia/engine/palettes.js';
import {
  FX_EXCLUDED, FX_LIVELY, FX_PINNED, FX_TABLE, PALETTE_LUT_SIZE, PALETTE_MAP_LAST, fxCatalog, fxClash, fxDrawnFor, paletteLut,
} from '../src/visualizer/fx-catalog.js';
import { createFxShuffle, fxDriftFor, fxLinkViolation } from '../src/visualizer/fx-shuffle.js';
import { FX_LUT_UNIT, createFxChain } from '../src/visualizer/fx-chain.js';
import { createShuffle, seededRandom } from '../src/visualizer/shuffle.js';
import { FakeGL } from './helpers/visualizer-fakes.js';
import {
  FX_NONE_SCENES, HELD_SCENES, HELD_SCENE_ENTRIES, SCENES, SCENE_DRIFT, SPEED_CAPS, sceneById, sceneCappedParams,
} from '../src/visualizer/scenes.js';
import {
  LOOKS_LEFT_OUT, PRESETS_LEFT_OUT, currentLook, lookByNumber, lookOverrides, sceneLooks, startLook,
} from '../src/visualizer/looks.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creditEntries } from '../src/modes/about-credits.js';
import { sceneDriftPlan } from '../src/visualizer/drift.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { FLIGHT_CAMERA_NEAR, FLIGHT_CAMERA_SCENES } from '../scripts/import_psychedelia.mjs';
import { hookUniforms } from './helpers/visualizer-flash-check.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(REPO, 'src', 'visualizer', 'vendor', 'psychedelia', 'manifest.json'), 'utf8'));
const { PsyPalettes } = loadPalettes({});
const { PostFxLibrary } = loadPostFx({ PsyPalettes });
const CATALOG = fxCatalog(PostFxLibrary, PsyPalettes);
const byId = new Map(CATALOG.map((fx) => [fx.id, fx]));
const PALETTE_MAP = byId.get('palette_map');

/* ---------------- Palette Map ---------------- */

test('Palette Map is offered when the library has the palettes: its catalog row, light, one of the passes that redraw the picture', () => {
  assert.ok(PALETTE_MAP, 'in the catalog');
  assert.equal(FX_EXCLUDED.palette_map, undefined);
  assert.equal(PALETTE_MAP.label, 'Palette Map');
  assert.equal(PALETTE_MAP.cost, 'light');
  assert.deepEqual(PALETTE_MAP.groups, ['replace']);
  assert.equal(typeof PALETTE_MAP.lut, 'function');
  // Every palette of the library may be drawn, and only those.
  assert.equal(PALETTE_MAP_LAST, PsyPalettes.count - 1);
  assert.deepEqual(FX_TABLE.palette_map.ranges.palette, [0, PALETTE_MAP_LAST, 'int']);
  // Without the palettes the library leaves the pass out, and so does the
  // catalog when it is not given them.
  const plain = loadPostFx({}).PostFxLibrary;
  assert.equal(fxCatalog(plain).some((fx) => fx.id === 'palette_map'), false);
  assert.equal(fxCatalog(PostFxLibrary).some((fx) => fx.id === 'palette_map'), false);
  // No other pass gets a look-up texture.
  assert.deepEqual(CATALOG.filter((fx) => fx.lut).map((fx) => fx.id), ['palette_map']);
});

test('Palette Map follows the light rules: bands pinned off, the mix under full, slow cycling, no beat on its offset', () => {
  const { ranges } = FX_TABLE.palette_map;
  assert.equal(ranges.posterize, 0);
  assert.ok(ranges.mix.strength[1] < 1);
  assert.ok(Math.abs(ranges.cycle[0]) <= 0.03 && Math.abs(ranges.cycle[1]) <= 0.03);
  assert.ok(FX_PINNED.palette_map);
  // Only its spread may move with the music (and drift); never its mix,
  // offset, palette, cycling or bands.
  assert.deepEqual(Object.keys(PALETTE_MAP.links), ['spread']);
  assert.equal(fxLinkViolation(PALETTE_MAP, 'spread'), null);
  for (const name of ['mix', 'offset', 'palette', 'cycle', 'posterize']) assert.ok(fxLinkViolation(PALETTE_MAP, name), name);
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(12) });
  for (let draw = 0; draw < 40; draw += 1) {
    const { values } = shuffle.build(['palette_map'], 'strong').fx[0];
    assert.equal(values.posterize, 0);
    assert.ok(values.mix <= ranges.mix.strength[1] + 1e-9);
    assert.ok(Number.isInteger(values.palette) && values.palette >= 0 && values.palette <= PALETTE_MAP_LAST);
  }
});

test('Palette Map drifts only its spread, inside the range the shuffle draws it from', () => {
  const plan = fxDriftFor(PALETTE_MAP);
  assert.deepEqual(plan.map((item) => item.name), ['spread']);
  assert.equal(plan[0].lo, FX_TABLE.palette_map.ranges.spread[0]);
  assert.equal(plan[0].hi, FX_TABLE.palette_map.ranges.spread[1]);
});

test('Palette Map is one of the lively effects kept from calm scenes, and never paired with Halftone or Fisheye', () => {
  assert.equal(FX_LIVELY.has('palette_map'), true);
  assert.equal(fxDrawnFor({ fxCalm: true }, ['palette_map', 'bloom']).includes('palette_map'), false);
  assert.deepEqual(fxDrawnFor({}, ['palette_map', 'bloom']), ['palette_map', 'bloom']);
  for (const other of ['halftone', 'fisheye']) assert.equal(fxClash('palette_map', other), true, other);
  for (const other of ['color_grade', 'bloom', 'tilt_shift', 'zoom_blur']) assert.equal(fxClash('palette_map', other), false, other);
});

test('a palette\'s look-up texture is the one Psychedelia bakes for it', () => {
  const gl = new FakeGL();
  for (const index of [0, 7, 35, PALETTE_MAP_LAST]) {
    PsyPalettes.texture(gl, index);
    const ours = paletteLut(PsyPalettes, index);
    assert.equal(ours.length, PALETTE_LUT_SIZE * 4);
    assert.deepEqual(Array.from(ours), Array.from(gl.lastData), `palette ${index}`);
  }
  PsyPalettes.resetTextures();
});

function palettePass(values) {
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(3) });
  const item = shuffle.build(['palette_map'], 'normal').fx[0];
  return { ...item, values: { ...item.values, ...values }, fx: PALETTE_MAP };
}

test('the chain binds the pass\'s palette to its own texture unit, once per palette, and frees them', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  let time = 1;
  const frame = () => {
    assert.ok(chain.begin(640, 360));
    time += 1 / 30;
    return chain.finish({ time, dt: 1 / 30, beat: { clock: 0 }, sources: null });
  };
  chain.setPasses([palettePass({ palette: 5 })]);
  frame();
  assert.equal(gl.uniforms.get('u_lut')[0], FX_LUT_UNIT);
  assert.deepEqual(Array.from(gl.lastData), Array.from(paletteLut(PsyPalettes, 5)));
  assert.equal(chain.luts, 1);
  // Unbound again after the pass (no texture left on its unit).
  assert.equal(gl.boundTextures.get(gl.TEXTURE0 + FX_LUT_UNIT), null);
  frame();
  frame();
  assert.equal(chain.stats.lutsMade, 1, 'made once, then reused');
  chain.setPasses([palettePass({ palette: 9 })]);
  frame();
  assert.equal(chain.stats.lutsMade, 2);
  assert.deepEqual(Array.from(gl.lastData), Array.from(paletteLut(PsyPalettes, 9)));
  const textures = gl.textures.size;
  chain.setPasses([]);
  assert.equal(chain.luts, 0);
  assert.ok(gl.textures.size <= textures - 2, 'its textures deleted with the targets');
  // A lost context takes them with it; they are made again after.
  chain.setPasses([palettePass({ palette: 9 })]);
  frame();
  chain.contextLost();
  assert.equal(chain.luts, 0);
  chain.restore(gl);
  gl.finishCompiles?.();
  chain.setPasses([palettePass({ palette: 9 })]);
  frame();
  assert.equal(chain.luts, 1);
  chain.destroy();
});

/* ---------------- The held flights ---------------- */

const BACK = Object.freeze([
  'apollonian_foam_flight', 'folded_box_variants_flight', 'mandelbox_flight', 'triplex_mutation_flight', 'path_traced_fractal_flight',
]);
const STILL_HELD = Object.freeze(['hypercomplex_slice_flight', 'difs_tunnel_flight', 'quaternion_julia_flight']);
const FADED = Object.freeze({
  apollonian_foam_flight: 'foamDE', folded_box_variants_flight: 'foldedBoxDE', mandelbox_flight: 'mandelboxDE',
});

async function registered(id) {
  const entry = [...SCENES, ...HELD_SCENE_ENTRIES].find((row) => row.id === id);
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const def = renderer.register(await entry.load(), entry.id);
  return { entry, def, renderer };
}

test('five held flights are offered again, at a speed cap of 1x; three stay held', () => {
  const offered = new Set(SCENES.map((entry) => entry.id));
  for (const id of BACK) {
    assert.ok(offered.has(id), `${id} offered`);
    assert.equal(Object.hasOwn(HELD_SCENES, id), false);
    assert.equal(SPEED_CAPS[id], 1, `${id} capped at 1x`);
    assert.equal(sceneById(id).maxSpeed, 1);
  }
  assert.deepEqual(Object.keys(HELD_SCENES).sort(), [...STILL_HELD].sort());
  for (const id of STILL_HELD) assert.equal(offered.has(id), false, `${id} held`);
  assert.equal(HELD_SCENE_ENTRIES.length, STILL_HELD.length);
});

test('the flights back lose the looks that step too far, by their preset names, and keep the rest', async () => {
  const kept = {
    apollonian_foam_flight: ['Default', 'Cathedral Deep Push', 'Sphere Chain Glide'],
    folded_box_variants_flight: ['Default', 'Amazing Surf Tunnel', 'Smooth Mandelbox Drift', 'ABoxMod Deep Fold', 'Box-Bulb Hybrid'],
    triplex_mutation_flight: ['Default', 'Abs Crown Orbit', 'DarkBeam Spiral'],
  };
  for (const id of BACK) {
    const { def } = await registered(id);
    const presets = new Set((def.fractalFlight?.smokePresets || def.smokePresets || []).map((preset) => preset.name));
    for (const name of PRESETS_LEFT_OUT[id] || []) assert.ok(presets.has(name), `${id}: ${name} is one of its presets`);
    const names = sceneLooks(def).map((look) => look.name);
    for (const name of PRESETS_LEFT_OUT[id] || []) assert.equal(names.includes(name), false, `${id}: ${name} not offered`);
    if (kept[id]) assert.deepEqual(names, kept[id], id);
  }
  // Mandelbox keeps all four of its looks; the Glass Fractal none of its
  // presets (it offers its colour schemes instead).
  assert.equal(PRESETS_LEFT_OUT.mandelbox_flight, undefined);
  assert.equal(PRESETS_LEFT_OUT.path_traced_fractal_flight.length, 4);
});

test('Apollonian Foam, Folded Box Variants and Mandelbox fade into their background as the camera nears the surface; the others do not', async () => {
  assert.deepEqual(FLIGHT_CAMERA_SCENES.map(([file]) => file), ['apollonian-foam-flight', 'folded-box-variants-flight', 'mandelbox-flight']);
  for (const id of [...BACK, ...STILL_HELD]) {
    const { entry, def, renderer } = await registered(id);
    const frag = renderer.prepare(def, entry.defaults || null).sources.frag;
    const de = FADED[id];
    if (!de) {
      assert.equal(/camNear/.test(frag), false, `${id}: no fade`);
      continue;
    }
    assert.ok(frag.includes(`const float CAM_NEAR_IN = ${FLIGHT_CAMERA_NEAR[0].toFixed(3)};`), id);
    assert.ok(frag.includes(`const float CAM_NEAR_OUT = ${FLIGHT_CAMERA_NEAR[1].toFixed(3)};`), id);
    assert.ok(frag.includes(`float camNear = 1.0 - smoothstep(CAM_NEAR_IN, CAM_NEAR_OUT, ${de}(ro).dist);`), id);
    // Last, before the tone map: the whole picture, glow and fog included.
    assert.match(frag, /col = mix\(col, background\(rd, t\), camNear\);\s*col = psyGamma\(psyTonemap\(col\)\);/, id);
  }
  assert.ok(FLIGHT_CAMERA_NEAR[0] < FLIGHT_CAMERA_NEAR[1]);
});

test('the flights back have no uniforms hook of their own: the flash check draws them as the tab does', async () => {
  for (const id of BACK) {
    const { def } = await registered(id);
    assert.equal(typeof def.setUniforms, 'undefined', id);
    assert.equal(hookUniforms(def, {}), null, id);
  }
});

test('the flights back that step by 0.06 or more are calm scenes', () => {
  for (const id of ['apollonian_foam_flight', 'mandelbox_flight', 'triplex_mutation_flight']) assert.equal(sceneById(id).fxCalm, true, id);
  for (const id of ['folded_box_variants_flight', 'path_traced_fractal_flight']) assert.equal(sceneById(id).fxCalm, false, id);
  for (const id of BACK) assert.equal(FX_NONE_SCENES.has(id), false, id);
});

test('four of the flights back do not drift (their drift moves the surface past the camera); the Glass Fractal does', async () => {
  for (const id of ['apollonian_foam_flight', 'folded_box_variants_flight', 'mandelbox_flight', 'triplex_mutation_flight']) {
    assert.equal(SCENE_DRIFT[id], false, id);
    const { entry, def } = await registered(id);
    assert.deepEqual(sceneDriftPlan(def, { override: entry.drift, capped: sceneCappedParams(id) }), [], id);
  }
  const { entry, def } = await registered('path_traced_fractal_flight');
  assert.equal(Object.hasOwn(SCENE_DRIFT, 'path_traced_fractal_flight'), false);
  assert.ok(sceneDriftPlan(def, { override: entry.drift, capped: sceneCappedParams(entry.id) }).length > 0);
});

test('the Glass Fractal offers its colour schemes but Chrome Cyan', async () => {
  const { def } = await registered('path_traced_fractal_flight');
  assert.deepEqual(LOOKS_LEFT_OUT.path_traced_fractal_flight, [2]);
  const names = sceneLooks(def).map((look) => look.name);
  assert.deepEqual(names, ['Glass Prism', 'Opal Flame', 'Void Gold']);
});

test('a saved look number of a look now left out (Strange Attractor Flight: three left out since v0.1.11 offered all but one) shows the start look, never another', async () => {
  const { entry, def } = await registered('strange_attractor_flight');
  const presets = def.fractalFlight.smokePresets.map((preset) => preset.name);
  for (const name of PRESETS_LEFT_OUT.strange_attractor_flight) {
    const number = presets.indexOf(name) + 1;
    assert.ok(number > 0, name);
    assert.equal(lookByNumber(sceneLooks(def), number), null, `${name} (${number}) not offered`);
    assert.deepEqual(lookOverrides(entry, def, number), entry.defaults, `${name}: the start look's values`);
    const looks = sceneLooks(def);
    assert.equal(currentLook(looks, number, startLook(looks, {})), startLook(looks, {}), `${name}: shown as the start look`);
  }
  // A favourite naming only such a look gives the shuffle nothing to pick (the saved or start look then).
  const shuffle = createShuffle({ scenes: [], random: seededRandom(1) });
  assert.equal(shuffle.look('strange_attractor_flight', sceneLooks(def).map((look) => look.number), [1]), null);
});

test('the notices carry the full Apache License 2.0 once, for hls.js and the Turbo palette; CREDITS.md and the About page give the Turbo licence as the manifest does', () => {
  const notices = readFileSync(join(REPO, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  const credits = readFileSync(join(REPO, 'CREDITS.md'), 'utf8');
  for (const clause of ['TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION', '4. Redistribution.', '9. Accepting Warranty or Additional Liability.', 'END OF TERMS AND CONDITIONS']) {
    assert.equal(notices.split(clause).length - 1, 1, clause);
  }
  assert.equal(notices.split('in full under "Apache License, Version 2.0" at the end').length - 1, 2, 'hls.js and Turbo point to it');
  const turbo = manifest.borrowed.find((row) => row.piece === 'turbo');
  const flat = (text) => text.replace(/\s+/g, ' ');
  assert.ok(flat(notices).includes(flat(turbo.licence)), 'notices: the manifest\'s words');
  assert.ok(flat(credits).includes(flat(turbo.licence)), 'CREDITS.md: the manifest\'s words');
  assert.ok(flat(credits).includes('its full text is in THIRD_PARTY_NOTICES.txt'));
  assert.equal(creditEntries(manifest.borrowed).find((row) => row.piece === 'turbo').licence, turbo.licence, 'the About page shows the same');
});
