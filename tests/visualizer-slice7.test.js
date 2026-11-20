import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  ALL_SCENE_FILES, BORROWED, ENDLESS_FILES, FILES, FLIGHT_FILES, HELPER_FILES, SCENE_GLOBALS, VENDOR_DIR, borrowedHeader, borrowedIn, borrowedRows,
} from '../scripts/import_psychedelia.mjs';
import {
  DEFAULT_SCENE, FX_CALM_SCENES, FX_NONE_SCENES, HELD_SCENES, HELD_SCENE_ENTRIES, SCENES, SPEED_CAPS, SCENE_MAX_PIXELS, SCENE_QUALITY_CAPS, cappedValues, sceneMaxPixels, orderedScenes, sceneById, sceneCaps, stepScene,
} from '../src/visualizer/scenes.js';
import {
  LOOKS_LEFT_OUT, PRESETS_LEFT_OUT, currentLook, lookOverrides, sceneLooks, startLook,
} from '../src/visualizer/looks.js';
import { favouriteEntries } from '../src/visualizer/favourites.js';
import { createShuffle, seededRandom } from '../src/visualizer/shuffle.js';
import { COMPILE_POLL_MS, createSceneRenderer, sceneDefaults } from '../src/visualizer/scene-renderer.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

const REPO = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));
const NEW_IDS = [
  'mandelbulb_flight', 'triplex_mutation_flight', 'kifs_flight', 'difs_tunnel_flight', 'mandelbox_flight',
  'folded_box_variants_flight', 'quaternion_julia_flight', 'hypercomplex_slice_flight', 'schottky_inversion_flight',
  'apollonian_foam_flight', 'polyfold_flight', 'fractal_flame_volume_flight', 'strange_attractor_flight',
  'lsystem_tube_flight', 'path_traced_fractal_flight', 'menger_citadel', 'recursive_cathedral', 'fractal_canyon',
  'infinite_lattice', 'crystal_geode', 'golden_hour_clouds', 'planet_sunrise',
];
// (Five more came back in slice 12: tests/visualizer-slice12.test.js.)
const HELD_IDS = ['hypercomplex_slice_flight', 'difs_tunnel_flight', 'quaternion_julia_flight'];
const BACK_IN_SLICE12 = ['apollonian_foam_flight', 'folded_box_variants_flight', 'mandelbox_flight', 'triplex_mutation_flight', 'path_traced_fractal_flight'];
/** Offered or held: every ported entry. */
const entryOf = (id) => sceneById(id) || HELD_SCENE_ENTRIES.find((entry) => entry.id === id) || null;
const OFFERED_IDS = NEW_IDS.filter((id) => !HELD_IDS.includes(id));
/** Classed medium by their software-WebGL time (scenes.js cost). */
const MEDIUM_IDS = ['mandelbulb_flight', 'menger_citadel', 'recursive_cathedral', 'infinite_lattice', 'planet_sunrise'];
const sceneFile = (id) => entryOf(id).file.replace(/^effects\//, '').replace(/\.js$/, '');

/* ---------------- The scenes ---------------- */

test('slice 7: the fifteen 3D flights and seven endless scenes are scenes like the others, from the flight files and two endless files', () => {
  for (const id of OFFERED_IDS) assert.ok(sceneById(id), id);
  assert.deepEqual(FLIGHT_FILES.map((name) => entryOf(NEW_IDS[FLIGHT_FILES.indexOf(name)]).file), FLIGHT_FILES.map((name) => `effects/${name}.js`));
  assert.deepEqual(SCENES.filter((scene) => scene.file === 'effects/endless-scenes.js').map((scene) => scene.id), ['menger_citadel', 'recursive_cathedral', 'fractal_canyon', 'infinite_lattice']);
  assert.deepEqual(SCENES.filter((scene) => scene.file === 'effects/endless-sky-crystal.js').map((scene) => scene.id), ['crystal_geode', 'golden_hour_clouds', 'planet_sunrise']);
  assert.deepEqual(ENDLESS_FILES, ['endless-scenes', 'endless-sky-crystal']);
  // (Slice 13 added the lab helpers: tests/visualizer-slice13.test.js.)
  assert.deepEqual(HELPER_FILES, ['fractal-flight-common', 'fractal-lab-common']);
  assert.deepEqual(SCENE_GLOBALS, ['EffectRegistry', 'FractalFlight', 'FractalLab', 'EndlessScenes']);
  for (const name of [...ALL_SCENE_FILES, ...HELPER_FILES]) assert.ok(FILES.some((file) => file.source === `src/effects/${name}.js`), name);
  for (const id of NEW_IDS) {
    const scene = entryOf(id);
    assert.equal(scene.cost, MEDIUM_IDS.includes(id) ? 'medium' : 'heavy', id);
    // The flights read no sound: only the time surge; the endless scenes read it themselves.
    assert.equal(scene.audio, scene.category === 'Endless Scenes' ? 'shader' : 'motion', id);
    assert.equal(scene.links, null, id);
  }
});

test('the flights get Psychedelia\'s flight helpers; the sky scenes load the endless engine on the same registry first', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 64, height: 36 }, gl, mode: 'webgl2' });
  assert.equal(typeof renderer.engine.FractalFlight?.metadata, 'function');
  const kifs = renderer.register(await sceneById('kifs_flight').load(), 'kifs_flight');
  assert.equal(kifs.fractalFlight.kind, 'de-raymarch', 'its metadata came from FractalFlight.metadata');
  assert.deepEqual(kifs.specialize, ['family'], 'its mode is compiled in (the registry, from the metadata)');
  const geode = renderer.register(await sceneById('crystal_geode').load(), 'crystal_geode');
  assert.ok(geode);
  for (const id of ['menger_citadel', 'golden_hour_clouds', 'planet_sunrise']) {
    assert.ok(renderer.engine.EffectRegistry.getDefinition(id), `${id} registered on this mount's registry`);
  }
  // Without the helpers a flight file cannot load at all.
  const bare = await sceneById('kifs_flight').load();
  assert.throws(() => bare.default({ EffectRegistry: { register() {} } }));
  renderer.destroy();
});

test('flights and endless scenes take their looks from their own presets (the flight metadata), after Default', async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const def = renderer.register(await sceneById('strange_attractor_flight').load(), 'strange_attractor_flight');
  const looks = sceneLooks(def);
  assert.equal(looks.length, 1 + def.fractalFlight.smokePresets.length - PRESETS_LEFT_OUT.strange_attractor_flight.length);
  assert.equal(looks[0].name, 'Default');
  assert.equal(looks[1].name, def.fractalFlight.smokePresets[1].name);
  // A flight without presets falls back to its palette list (a plain uniform).
  const bulb = renderer.register(await sceneById('mandelbulb_flight').load(), 'mandelbulb_flight');
  assert.ok(sceneLooks(bulb).length > 1);
  assert.ok(sceneLooks(bulb).every((look) => Object.keys(look.values).every((name) => name === 'palette')));
  const geode = renderer.register(await sceneById('crystal_geode').load(), 'crystal_geode');
  assert.equal(sceneLooks(geode).length, 7);
  // Presets that fail the flash check are left out (PRESETS_LEFT_OUT): three
  // of Strange Attractor Flight's four, so it offers Default and Thomas Knot Orbit.
  const leftOut = ['Lorenz Wing Dive', 'Aizawa Bloom Tunnel', 'Rossler Spiral Graze'];
  assert.deepEqual(PRESETS_LEFT_OUT.strange_attractor_flight, leftOut);
  assert.deepEqual(looks.map((look) => look.name), ['Default', 'Thomas Knot Orbit']);
  for (const name of leftOut) {
    assert.ok(def.fractalFlight.smokePresets.some((preset) => preset.name === name), `Psychedelia has ${name}`);
    assert.ok(!looks.some((look) => look.name === name), `${name} not offered`);
    assert.ok(sceneLooks(def, { all: true }).some((look) => look.name === name), `the flash check can still look at ${name}`);
  }
  // L-System's Crystal Fern Cathedral is back (Psychedelia 0a4fdc1).
  const tube = renderer.register(await sceneById('lsystem_tube_flight').load(), 'lsystem_tube_flight');
  assert.ok(sceneLooks(tube).some((look) => look.name === 'Crystal Fern Cathedral'));
  assert.equal(sceneLooks(tube).length, 1 + tube.fractalFlight.smokePresets.length);
  renderer.destroy();
});

test('the scene shuffle offers the ones not held by their measured cost: the five medium ones with the default filter', () => {
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(5) });
  const picked = new Set();
  let current = 'plasma';
  for (let i = 0; i < 400; i += 1) {
    current = shuffle.next({ current, costMax: 'heavy' });
    shuffle.shown(current);
    picked.add(current);
  }
  for (const id of OFFERED_IDS) assert.ok(picked.has(id), `${id} picked`);
  for (const id of HELD_IDS) assert.ok(!picked.has(id), `${id} held`);
  // The default filter, light and medium: the five medium ones, no heavy one.
  const medium = createShuffle({ scenes: SCENES, random: seededRandom(5) });
  const pickedMedium = new Set();
  for (let i = 0; i < 400; i += 1) { const id = medium.next({ costMax: 'medium' }); medium.shown(id); pickedMedium.add(id); }
  assert.deepEqual(NEW_IDS.filter((id) => pickedMedium.has(id)).sort(), [...MEDIUM_IDS].sort());
});

/* ---------------- Held scenes ---------------- */

test('held scenes: ported, credited and in the manifest, but not offered by the list, previous/next, search or the shuffle', () => {
  assert.deepEqual(Object.keys(HELD_SCENES).sort(), [...HELD_IDS].sort());
  assert.deepEqual(HELD_SCENE_ENTRIES.map((entry) => entry.id).sort(), [...HELD_IDS].sort());
  for (const id of HELD_IDS) {
    assert.match(HELD_SCENES[id], /0\.\d+ at 1x over 360 s/, `${id}: the reason and the measure`);
    assert.equal(sceneById(id), null, `${id} not offered`);
    assert.ok(!SCENES.some((scene) => scene.id === id));
    assert.ok(!orderedScenes().some((scene) => scene.id === id));
    assert.ok(FILES.some((file) => file.target === entryOf(id).file), `${id}: still imported`);
    assert.ok(manifest.files.some((file) => file.target === entryOf(id).file), `${id}: still in the manifest`);
  }
  assert.ok(manifest.borrowed.some((row) => row.scene === 'difs_tunnel_flight'), 'its borrowed rows stay');
  // Previous / next go round the offered scenes only.
  const ordered = orderedScenes();
  for (let i = 0, id = ordered[0].id; i < ordered.length; i += 1, id = stepScene(id, 1, ordered)) assert.ok(!HELD_IDS.includes(id));
  // A shuffle of favourites that name held scenes never picks them.
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(9) });
  const favourites = [...HELD_IDS.map((scene) => ({ scene, look: null })), { scene: 'kifs_flight', look: null }, { scene: 'tunnel', look: null }];
  assert.deepEqual(shuffle.poolOf({ pool: 'favourites', favourites }).sort(), ['kifs_flight', 'tunnel']);
  for (let i = 0; i < 50; i += 1) assert.ok(!HELD_IDS.includes(shuffle.next({ pool: 'favourites', favourites })));
});

test('held scenes in the tab: a saved scene or old favourite of one falls back to the default and is never shown', async () => {
  const m = await mount({
    visualizerScene: 'difs_tunnel_flight',
    visualizerShuffle: true,
    visualizerShufflePool: 'favourites',
    visualizerFavourites: ['difs_tunnel_flight', 'hypercomplex_slice_flight:2', 'kifs_flight', 'tunnel'],
  });
  assert.equal(m.session.switcher.current, DEFAULT_SCENE, 'the saved held scene: the default instead');
  for (const id of HELD_IDS) assert.ok(!m.session.sceneList.shown.includes(id), `${id} not in the list`);
  assert.ok(m.session.sceneList.shown.includes('kifs_flight'));
  const shown = new Set([m.session.switcher.current]);
  for (let i = 0; i < 12; i += 1) {
    const pick = m.session.shuffle.next({ pool: 'favourites', favourites: favouriteEntries(m.session.favourites) });
    shown.add(pick);
  }
  for (const id of HELD_IDS) assert.ok(!shown.has(id), `${id} never picked`);
  // The favourites are kept as saved (they come back when the scene does).
  assert.ok(m.settings.visualizerFavourites.includes('difs_tunnel_flight'));
  m.session.destroy();
});

/* ---------------- Look numbers ---------------- */

test("a look's number is its place in Psychedelia's list: leaving one out renumbers nothing; a left-out number shows the start look", async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const attractor = renderer.register(await sceneById('strange_attractor_flight').load(), 'strange_attractor_flight');
  const presets = attractor.fractalFlight.smokePresets.map((preset) => preset.name);
  const looks = sceneLooks(attractor);
  // Default is 0, preset i is i + 1; Lorenz Wing Dive (1), Aizawa Bloom
  // Tunnel (3) and Rossler Spiral Graze (4) are not offered.
  assert.deepEqual(presets, ['Lorenz Wing Dive', 'Thomas Knot Orbit', 'Aizawa Bloom Tunnel', 'Rossler Spiral Graze']);
  assert.deepEqual(looks.map((look) => look.number), [0, 2]);
  for (const look of looks.slice(1)) assert.equal(look.name, presets[look.number - 1]);
  const entry = sceneById('strange_attractor_flight');
  const thomas = attractor.fractalFlight.smokePresets[1];
  assert.equal(lookOverrides(entry, attractor, 2).curve_scale, thomas.values.curve_scale, 'saved 2 is Thomas Knot Orbit');
  const start = startLook(looks, sceneDefaults(attractor));
  assert.equal(start, 0);
  for (const left of [1, 3, 4]) {
    assert.equal(lookOverrides(entry, attractor, left), entry.defaults, `saved ${left} (left out): the start, no look values`);
    assert.equal(currentLook(looks, left, start), start);
  }
  assert.equal(currentLook(looks, 2, start), 2);
  // Mandelbrot's palette looks keep the palette's own index (Neon 1 and
  // Ocean 3 left out): Rainbow 0, Fire 2, Psychedelic 4.
  const mandel = renderer.register(await sceneById('mandelbrot').load(), 'mandelbrot');
  assert.deepEqual(LOOKS_LEFT_OUT.mandelbrot, [1, 3]);
  assert.deepEqual(sceneLooks(mandel).map((look) => [look.number, look.name]), [[0, 'Rainbow'], [2, 'Fire'], [4, 'Psychedelic']]);
  assert.deepEqual(lookOverrides(null, mandel, 2), { palette_type: 2 });
  assert.equal(lookOverrides(null, mandel, 1), null);
  // The look shuffle picks numbers offered only.
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(4) });
  const numbers = looks.map((look) => look.number);
  for (let i = 0; i < 60; i += 1) assert.ok([0, 2].includes(shuffle.look('strange_attractor_flight', numbers)));
  for (let i = 0; i < 20; i += 1) {
    assert.equal(shuffle.look('strange_attractor_flight', numbers, [1, 3, 4, 2]), 2, 'a favourite of a left-out look is not picked');
  }
  renderer.destroy();
});

test('in the tab: a saved look shows the same preset, and a saved left-out look shows the start look; stepping skips it', async () => {
  const thomas = await mount({ visualizerScene: 'strange_attractor_flight', visualizerLooks: { strange_attractor_flight: 2 } });
  assert.equal(thomas.session.switcher.current, 'strange_attractor_flight');
  const presets = thomas.session.renderer.definition.fractalFlight.smokePresets;
  assert.equal(thomas.session.renderer.values.curve_scale, presets[1].values.curve_scale, 'Thomas Knot Orbit');
  thomas.session.destroy();
  // Saved (or a favourite of) Lorenz Wing Dive, Aizawa Bloom Tunnel or
  // Rossler Spiral Graze: the start look, as for any left-out look.
  for (const number of [1, 3, 4]) {
    const out = await mount({ visualizerScene: 'strange_attractor_flight', visualizerLooks: { strange_attractor_flight: number } });
    const start = sceneDefaults(out.session.renderer.definition);
    assert.equal(out.session.renderer.values.curve_scale, start.curve_scale, `the start look, not ${presets[number - 1].name}`);
    assert.notEqual(out.session.renderer.values.curve_scale, presets[number - 1].values.curve_scale);
    // The look buttons go round Default and Thomas Knot Orbit only.
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      out.session.controls[i % 2 ? 'lookPrev' : 'lookNext'].dispatchEvent(new Event('click'));
      seen.push(out.settings.visualizerLooks.strange_attractor_flight ?? 0);
    }
    assert.deepEqual(seen, [2, 0, 2, 0]);
    out.session.destroy();
    // A favourite of it, picked from the favourites in the scene list: the
    // scene at its start look.
    const fav = await mount({ visualizerScene: 'plasma', visualizerFavourites: [`strange_attractor_flight:${number}`] });
    fav.session.sceneList.favouritesOnly.dispatchEvent(new Event('click'));
    fav.session.sceneList.pick('strange_attractor_flight');
    for (let round = 0; round < 400 && fav.session.switcher.current !== 'strange_attractor_flight'; round += 1) {
      await settle(() => fav.session.switcher.current === 'strange_attractor_flight', 20);
      fav.h.run(COMPILE_POLL_MS);
    }
    assert.equal(fav.session.switcher.current, 'strange_attractor_flight');
    assert.equal(fav.session.renderer.values.curve_scale, start.curve_scale, `favourite ${number}: the start look`);
    fav.session.destroy();
  }
});

/* ---------------- Flash: speed caps and class ---------------- */

test('flash: the offered slice 7 scenes get their measured speed caps; the two back from the held list and Strange Attractor Flight are calm (the two with no effects), the others normal', () => {
  // From the 120-s flash check with the surge held at its most, over the
  // same stretch of each scene's clock as 3x (scenes.js SPEED_CAPS).
  // (The flights back in slice 12: tests/visualizer-slice12.test.js.)
  const offered = OFFERED_IDS.filter((id) => !BACK_IN_SLICE12.includes(id));
  const caps = Object.fromEntries(offered.map((id) => [id, sceneById(id).maxSpeed ?? null]));
  assert.deepEqual(caps, {
    mandelbulb_flight: null, kifs_flight: null, strange_attractor_flight: 1.5, lsystem_tube_flight: 1,
    polyfold_flight: 2, fractal_flame_volume_flight: 2, schottky_inversion_flight: 1.5,
    menger_citadel: null, recursive_cathedral: null, fractal_canyon: null, infinite_lattice: 1.5,
    crystal_geode: null, golden_hour_clouds: null, planet_sunrise: null,
  });
  for (const id of offered) {
    if (SPEED_CAPS[id]) assert.equal(sceneById(id).maxSpeed, SPEED_CAPS[id]);
    const calm = ['polyfold_flight', 'fractal_flame_volume_flight', 'strange_attractor_flight'].includes(id);
    assert.equal(FX_CALM_SCENES.has(id), calm, id);
    // The two back from the held list reach 0.085 on a look: no effects at all.
    const none = ['polyfold_flight', 'fractal_flame_volume_flight'].includes(id);
    assert.equal(FX_NONE_SCENES.has(id), none, id);
    assert.equal(sceneById(id).fxCalm, calm);
    assert.equal(sceneById(id).fxNone, none);
  }
});

/* ---------------- Cost: caps per quality ---------------- */

test('quality caps: the heaviest scenes\' own detail is lowered at Low and Medium (and High where needed), on what is drawn only', () => {
  // (Slice 14's simulations: their own size, tests/visualizer-slice14.test.js.)
  assert.deepEqual(Object.keys(SCENE_QUALITY_CAPS).sort(), [
    'curl_silk', 'fluid_ink', 'fractal_flame_volume_flight', 'golden_hour_clouds', 'lenia', 'lsystem_tube_flight', 'physarum', 'strange_attractor_flight',
  ]);
  // Strange Attractor and L-System: one cap at every quality, so each draws
  // in about 28 ms or less at High (the step-down keeps a scene at High down
  // to 24 frames a second, step-down.js).
  for (const quality of ['low', 'medium', 'high']) {
    assert.deepEqual(sceneCaps('strange_attractor_flight', quality), { detail: 0.55 });
    assert.deepEqual(sceneCaps('lsystem_tube_flight', quality), { quality: 0.45, detail: 0.7 });
  }
  assert.deepEqual(sceneCaps('golden_hour_clouds', 'low'), { detail: 100 });
  assert.equal(sceneCaps('golden_hour_clouds', 'high'), null);
  assert.deepEqual(sceneCaps('fractal_flame_volume_flight', 'high'), { iterations: 9, detail: 0.6 });
  assert.equal(sceneCaps('plasma', 'low'), null);
  const values = { orbit_steps: 28, detail: 1.15, speed: 1 };
  assert.deepEqual(cappedValues('strange_attractor_flight', 'medium', values), { orbit_steps: 28, detail: 0.55, speed: 1 });
  assert.equal(cappedValues('plasma', 'low', values), values, 'nothing to cap: the same object');
  assert.deepEqual(cappedValues('strange_attractor_flight', 'low', { detail: 0.5 }), { detail: 0.5 }, 'only lowered, never raised');
});

test('the renderer draws the caps for the quality drawn now; the scene\'s values stay as chosen', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 64, height: 36 }, gl, mode: 'webgl2', capsFor: sceneCaps });
  const def = renderer.register(await sceneById('strange_attractor_flight').load(), 'strange_attractor_flight');
  for (const [name, caps] of Object.entries(SCENE_QUALITY_CAPS)) {
    const own = renderer.register(await entryOf(name).load(), name);
    const defaults = sceneDefaults(own);
    for (const quality of ['low', 'medium', 'high']) {
      for (const [param, most] of Object.entries(caps[quality] || {})) {
        const row = own.params.find((p) => p.name === param);
        assert.ok(row, `${name}.${param}`);
        if (row.type === 'select' || row.type === 'int') {
          // A size choice (a simulation's): at most its start, so a larger
          // one picked by hand is lowered too.
          const least = row.type === 'select' ? 0 : row.min;
          assert.ok(Number.isInteger(most) && most >= least && most <= defaults[param], `${name}.${param} at ${quality}: ${most} inside ${least}..${defaults[param]}`);
        } else {
          assert.ok(most >= row.min && most < defaults[param], `${name}.${param} at ${quality}: ${most} inside ${row.min}..${defaults[param]}`);
        }
        assert.ok(!(own.specialize || []).includes(param), `${name}.${param} is a plain uniform`);
      }
    }
  }
  renderer.useSceneNow(def);
  const state = { time: 1, audio: {}, beat: {}, sources: {} };
  renderer.draw(state);
  assert.equal(Math.fround(gl.uniforms.get('u_detail')[0]), Math.fround(1.15), 'no quality yet: as chosen');
  renderer.setQuality('high');
  renderer.draw(state);
  assert.equal(Math.fround(gl.uniforms.get('u_detail')[0]), Math.fround(0.55));
  assert.equal(renderer.values.detail, 1.15, 'the values are not changed');
  // The caps follow the quality drawn now: Golden-Hour Clouds is capped at
  // Low and Medium only.
  const clouds = renderer.register(await sceneById('golden_hour_clouds').load(), 'golden_hour_clouds');
  renderer.useSceneNow(clouds);
  renderer.setQuality('low');
  renderer.draw(state);
  assert.equal(gl.uniforms.get('u_detail')[0], 100);
  renderer.setQuality('high');
  renderer.draw(state);
  assert.equal(gl.uniforms.get('u_detail')[0], sceneDefaults(clouds).detail);
  assert.ok(sceneDefaults(clouds).detail > 100);
  renderer.destroy();
});

const LAYOUT = { width: 1280, height: 720 };
async function mount(settings) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); },
    subscribeSettings: () => () => {},
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(3),
  });
  for (let round = 0; round < 400 && !session.switcher.current; round += 1) {
    await settle(() => Boolean(session.switcher.current), 20);
    h.run(COMPILE_POLL_MS);
  }
  assert.ok(session.switcher.current, 'first scene');
  source.playing = true;
  signal.refresh();
  for (let i = 0; i < 4; i += 1) { h.run(250, 1000 / 30); await settle(() => false, 3); }
  return { gl, h, session, get settings() { return current; } };
}

test('in the tab: the chosen quality caps what a heavy scene draws', async () => {
  const high = await mount({ visualizerScene: 'strange_attractor_flight', visualizerQuality: 'high' });
  assert.equal(high.session.switcher.current, 'strange_attractor_flight');
  assert.equal(Math.fround(high.gl.uniforms.get('u_detail')[0]), Math.fround(0.55));
  high.session.destroy();
  const low = await mount({ visualizerScene: 'golden_hour_clouds', visualizerQuality: 'low' });
  assert.equal(low.session.switcher.current, 'golden_hour_clouds');
  assert.equal(low.gl.uniforms.get('u_detail')[0], 100);
  low.session.destroy();
  const cloudsHigh = await mount({ visualizerScene: 'golden_hour_clouds', visualizerQuality: 'high' });
  assert.ok(cloudsHigh.gl.uniforms.get('u_detail')[0] > 100);
  cloudsHigh.session.destroy();
});

test('pixel budget: Strange Attractor Flight is drawn with fewer pixels than its quality allows, stretched; the next scene gets the quality\'s own', async () => {
  assert.deepEqual(Object.keys(SCENE_MAX_PIXELS), ['strange_attractor_flight']);
  assert.equal(sceneMaxPixels('strange_attractor_flight', 'medium'), 240000);
  assert.equal(sceneMaxPixels('plasma', 'medium'), undefined);
  const m = await mount({ visualizerScene: 'strange_attractor_flight', visualizerQuality: 'medium' });
  const canvas = m.session.canvas;
  const size = () => [canvas.width, canvas.height];
  // The tab is 1600 x 900 device pixels: Medium draws 1200 x 675 (810 000).
  const [w, h] = size();
  assert.ok(w * h <= 240000 && w * h > 235000, `${w} x ${h}`);
  assert.ok(Math.abs(w / h - 16 / 9) < 0.01, 'the tab\'s shape');
  const until = async (done) => {
    for (let round = 0; round < 400 && !done(); round += 1) {
      await settle(done, 20);
      m.h.run(COMPILE_POLL_MS);
    }
    assert.ok(done());
  };
  m.session.sceneList.pick('plasma');
  await until(() => m.session.switcher.current === 'plasma');
  assert.deepEqual(size(), [1200, 675], 'the next scene: Medium\'s own size');
  m.session.sceneList.pick('strange_attractor_flight');
  await until(() => m.session.switcher.current === 'strange_attractor_flight');
  assert.deepEqual(size(), [w, h]);
  m.session.destroy();
});

/* ---------------- Borrowed code and credits ---------------- */

test('borrowed code: every piece is named in its vendored file\'s header with author, source and licence', () => {
  assert.ok(BORROWED.length >= 12);
  for (const piece of BORROWED) {
    assert.ok(piece.author && piece.licence && (piece.link || piece.linkNote), piece.id);
    for (const source of piece.files) {
      const file = FILES.find((row) => row.source === source);
      assert.ok(file, `${source} is imported`);
      const text = readFileSync(join(VENDOR_DIR, ...file.target.split('/')), 'utf8').replace(/\r\n/g, '\n');
      const header = text.slice(0, text.indexOf('export default function load(G)'));
      for (const line of borrowedHeader(source)) assert.ok(header.includes(line), `${file.target}: ${line}`);
      assert.ok(borrowedIn(source).includes(piece));
    }
  }
  const apollonian = readFileSync(join(VENDOR_DIR, 'effects', 'apollonian-foam-flight.js'), 'utf8');
  assert.match(apollonian, /BORROWED: Apollonian sphere-packing[^]*CC BY-NC-SA 3\.0[^]*This part stays under that licence \(non-commercial use only\), not MIT\./);
  assert.match(apollonian, /BORROWED: pseudo-Kleinian fold[^]*Licence: no licence stated at the source/);
});

test('borrowed code: the manifest lists every scene that carries it, with the non-commercial and no-licence flags', () => {
  const rows = manifest.borrowed;
  assert.ok(Array.isArray(rows) && rows.length > 0);
  const ids = new Set([...SCENES, ...HELD_SCENE_ENTRIES].map((scene) => scene.id));
  for (const row of rows) {
    assert.ok(row.scene === '*' || ids.has(row.scene), row.scene);
    assert.ok(BORROWED.some((piece) => piece.id === row.piece && piece.licence === row.licence && piece.author === row.author), row.piece);
    assert.equal(typeof row.nonCommercial, 'boolean');
    assert.equal(typeof row.noLicenceStated, 'boolean');
  }
  // Rebuilt from the scenes as this build has them, the list is the same.
  const defsByFile = new Map();
  for (const scene of [...SCENES, ...HELD_SCENE_ENTRIES]) {
    const name = sceneFile(scene.id);
    defsByFile.set(name, [...(defsByFile.get(name) || []), { name: scene.id }]);
  }
  assert.deepEqual(rows, borrowedRows(defsByFile));
  const flagged = rows.filter((row) => row.nonCommercial || row.noLicenceStated);
  assert.deepEqual(flagged.map((row) => [row.scene, row.piece, row.nonCommercial, row.noLicenceStated]), [
    ['apollonian_foam_flight', 'iq-apollonian', true, false],
    ['apollonian_foam_flight', 'knighty-pseudo-kleinian', false, true],
  ]);
  // Engine pieces reach every scene.
  assert.ok(rows.some((row) => row.scene === '*' && row.piece === 'webgl-noise'));
  // The hash and iq snippets reach the endless scenes and flights.
  for (const id of ['menger_citadel', 'planet_sunrise', 'endless_terrain']) assert.ok(rows.some((row) => row.scene === id && row.piece === 'hoskins-hash'), id);
  for (const id of ['kifs_flight', 'mandelbulb_flight']) assert.ok(rows.some((row) => row.scene === id && row.piece === 'iq-soft-shadows'), id);
});

test('borrowed code: one entry per piece in CREDITS.md and the notices; the share-alike part is not called MIT', () => {
  const credits = readFileSync(join(REPO, 'CREDITS.md'), 'utf8');
  const notices = readFileSync(join(REPO, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const piece of BORROWED) {
    if (piece.link) {
      assert.ok(credits.includes(piece.link), `CREDITS.md: ${piece.link}`);
      assert.ok(notices.includes(piece.link), `notices: ${piece.link}`);
    }
    assert.ok(credits.includes(piece.author), `CREDITS.md: ${piece.author}`);
    assert.ok(notices.includes(piece.author), `notices: ${piece.author}`);
  }
  for (const text of [credits, notices]) {
    assert.match(text, /CC BY-NC-SA 3\.0\)?[^]{0,200}non-commercial use only/i);
    assert.match(text, /no licence stated at the source/);
    assert.match(text, /Apollonian Foam Flight/);
  }
  assert.match(credits, /It is not under MIT\./);
  assert.match(notices, /It is not covered by the MIT license above\./);
});
