#!/usr/bin/env node
/**
 * Flash and brightness check for the post effects, run by hand (slow, needs
 * a browser; not part of `npm test`):
 *
 *   node tests/helpers/visualizer-fx-check.mjs [out.json] [combos]
 *   python tests/helpers/visualizer-fx-check.py out.json [width height] [--gpu]
 *
 * This half prepares a sample of scenes (their shaders, values and sound
 * links; recordScene in visualizer-flash-check.mjs) and rolls `combos`
 * (300) effect combinations per intensity from the FX shuffle as the tab
 * does (seeded, Medium's cost budget and cap of 3; a calm scene's own
 * limits, scenes.js fxCalm). Every scene's runs alternate the global beat
 * flash off and on (it is off by default). Then the trigger runs ("triggers
 * +flash"): Shockwave and Datamosh, alone and together, on every scene that
 * allows them, flash on. The Python half drives each run live in Chromium:
 * the real sound path at 30 frames a second (a 120 BPM track through the
 * signal, the loop, the Beat Reactor and the flash limiter, with the time
 * surge held at its most, as the tester's bass-heavy stream drove it) and
 * the app's own fx-chain.js and fx-reactions.js together, the chain
 * charging its trigger firings to that limiter. It counts the large changes
 * of light from what is drawn (limited pulses, the clock's wraps as the
 * scene gets them, the u_age each effect program gets) and reports per
 * intensity the most in a rolling second, the mean luminance,
 * the largest frame-to-frame step and the steps over 0.10 a second, with the
 * worst combinations.
 *
 *   node tests/helpers/visualizer-fx-check.mjs out.json --overlays
 *
 * writes the overlay runs instead (overlay-catalog.js; drawn by the page
 * through the app's overlay-layer.js, its flash gate on the same limiter):
 *   "overlay alone"   every overlay alone, plain on top, at its strongest
 *                     settings (OVERLAY_CHECK_WORST), on a bright, a dark and
 *                     a beat-clock scene;
 *   "blend <mode>"    the strongest overlays (OVERLAY_CHECK_STRONG) blended in
 *                     with each mode they allow, and "blend extras" with the
 *                     mask (bright, dark areas), the tint, bending and under
 *                     a lively effect, on the same scenes; each run notes
 *                     whether the calm rule (overlaysDrawnFor) would draw it;
 *   "cost ..."        time per frame: each overlay alone at Medium's size,
 *                     and one blended in against the same plain and none at
 *                     Low, Medium and High.
 *
 *   node tests/helpers/visualizer-fx-check.mjs out.json --overlays --overlay-focus=spectrum
 *
 * writes only that overlay's runs: plain and with every blend-in it allows,
 * on the same scenes, from three places in the track (focusRuns).
 */

import { writeFileSync } from 'node:fs';

import loadPostFx from '../../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import {
  FX_CALM_MAX, FX_SYNC, fxCalmIds, fxCatalog, fxDrawnFor,
} from '../../src/visualizer/fx-catalog.js';
import {
  FX_COST_BUDGET, FX_INTENSITIES, FX_MAX_BY_QUALITY, createFxShuffle,
} from '../../src/visualizer/fx-shuffle.js';
import { createSceneRenderer } from '../../src/visualizer/scene-renderer.js';
import { SCENES } from '../../src/visualizer/scenes.js';
import { seededRandom } from '../../src/visualizer/shuffle.js';
import { FakeGL } from './visualizer-fakes.js';
import { sceneLinks } from '../../src/visualizer/reactor.js';
import { recordScene } from './visualizer-flash-check.mjs';
import {
  OVERLAY_IDS, PLAIN_BLEND, overlayRow, overlaysDrawnFor,
} from '../../src/visualizer/overlay-catalog.js';
import { readsBeatClock } from '../../src/visualizer/scene-renderer.js';

/** Scenes from each family: flat colour fields, tunnels, fractals, light
 *  curtains, fire, cells and a starfield. */
export const FX_CHECK_SCENES = Object.freeze([
  'plasma', 'tunnel', 'kaleidoscope', 'mandelbrot', 'aurora', 'liquid_light', 'fire', 'voronoi', 'starfield', 'sierpinski',
]);
export const FX_CHECK_CLIP_FRAMES = 90; // 3 s at 30 a second
/** The overlay runs' scenes: bright (Voronoi), dark (Starfield), one that
 *  shows the beat clock (Islamic Stars), and a calm bright one (Plasma). */
export const OVERLAY_CHECK_SCENES = Object.freeze(['voronoi', 'starfield', 'islamic_stars', 'plasma']);
/** The overlays that light the most of the picture, or on hits. */
export const OVERLAY_CHECK_STRONG = Object.freeze(['spotlights', 'fireworks', 'lasers', 'bokeh', 'hexgrid', 'tri_grid', 'starburst']);
/** The drawing sizes of Low, Medium and High on a 1920 x 1080 screen
 *  (size.js drawingSize with the presets). */
export const OVERLAY_CHECK_SIZES = Object.freeze({ low: [960, 540], medium: [1440, 810], high: [1920, 1080] });

/** An overlay at its strongest settings: the top of every range, on the
 *  kick when it has a sync (the most hits), else the first pick. */
export function OVERLAY_CHECK_WORST(id) {
  const values = {};
  for (const [name, spec] of Object.entries(overlayRow(id).ranges || {})) {
    if (typeof spec === 'number') values[name] = spec;
    else if (Array.isArray(spec)) values[name] = spec[1];
    else if (spec?.pick) values[name] = /_sync$/.test(name) && spec.pick.includes(1) ? 1 : spec.pick[0];
  }
  return { ...values, ...(OVERLAY_CHECK_BRIGHTEST[id] || {}) };
}
/** Picks that light more of the picture than the first pick does: Spectrum's
 *  mirrored bars from the middle (twice the height), in white. */
export const OVERLAY_CHECK_BRIGHTEST = Object.freeze({
  spectrum: Object.freeze({
    spectrum_style: 1, spectrum_position: 1, spectrum_color_mode: 1, spectrum_color: '#ffffff',
  }),
});

/** --overlay-focus=<id>: one overlay alone, plain and with every blend-in it
 *  allows (each mode over and under the effects, the masks, the tint,
 *  bending), on every overlay check scene, from three places in the track. */
function focusRuns(id, flashScenes, entryOf, item) {
  const row = overlayRow(id);
  const blends = [['plain', {}]];
  for (const mode of row.blends) {
    if (mode !== 'add') blends.push([mode, { mode }]);
    if (row.under) blends.push([`${mode} under`, { mode, under: true }]);
  }
  blends.push(['mask bright', { mode: 'add', mask: 'bright' }], ['mask dark', { mode: 'add', mask: 'dark' }], ['tint', { mode: 'add', tint: true }], ['bend', { mode: 'add', bend: true }]);
  const runs = [];
  flashScenes.forEach((scene, which) => {
    const entry = entryOf(scene);
    for (let start = 0; start < 3; start += 1) {
      for (const [name, blend] of blends) {
        const asked = item(id, blend);
        const drawn = overlaysDrawnFor(entry, [asked])[0];
        runs.push({
          group: `focus ${name}`, scene, from: (which * 13 + start * 30) % (RECORDED_FRAMES - FX_CHECK_CLIP_FRAMES), fx: [], intensity: 'normal', flash: false,
          overlays: [asked], blendName: name, allowed: JSON.stringify(drawn.blend) === JSON.stringify(asked.blend),
        });
      }
    }
  });
  return runs;
}

async function overlayRuns(out, focus = null) {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const scenes = [];
  for (const id of [...OVERLAY_CHECK_SCENES, 'tunnel']) {
    const entry = SCENES.find((scene) => scene.id === id);
    const def = renderer.register(await entry.load(), entry.id);
    const { frames, ...prepared } = recordScene(renderer, entry, def, { worst: true, recordMs: 0 });
    scenes.push({
      ...prepared, links: sceneLinks(def, entry), maxSpeed: entry.maxSpeed, frameCount: RECORDED_FRAMES, clock: readsBeatClock(prepared.frag),
    });
    process.stdout.write(`${id} `);
  }
  const at = (id) => scenes.findIndex((scene) => scene.id === id);
  const entryOf = (index) => SCENES.find((row) => row.id === scenes[index].id);
  const runs = [];
  const { PostFxLibrary } = loadPostFx({});
  const kaleidoscope = createFxShuffle({ catalog: fxCatalog(PostFxLibrary), random: seededRandom(66) })
    .build(['kaleidoscope'], 'strong').fx.map(({ id, values, links }) => ({ id, values, links }));
  const item = (id, blend = PLAIN_BLEND) => ({ id, blend: { ...PLAIN_BLEND, ...blend }, values: OVERLAY_CHECK_WORST(id) });
  const flashScenes = OVERLAY_CHECK_SCENES.map(at);
  if (focus) {
    if (!overlayRow(focus)) throw new Error(`--overlay-focus: no overlay ${focus}`);
    runs.push(...focusRuns(focus, flashScenes, entryOf, item));
    writeFileSync(out, JSON.stringify({ scenes, runs, clip: FX_CHECK_CLIP_FRAMES }));
    console.log(`\n${scenes.length} scenes, ${runs.length} ${focus} runs -> ${out}`);
    return;
  }
  // Each overlay alone, plain on top.
  for (const id of OVERLAY_IDS) {
    flashScenes.forEach((scene, which) => {
      runs.push({
        group: 'overlay alone', scene, from: (which * 29) % (RECORDED_FRAMES - FX_CHECK_CLIP_FRAMES), fx: [], intensity: 'normal', flash: false, overlays: [item(id)],
      });
    });
  }
  // The strongest, blended in.
  const extras = [
    ['mask bright', { mode: 'add', mask: 'bright' }], ['mask dark', { mode: 'add', mask: 'dark' }],
    ['tint', { mode: 'screen', tint: true }], ['bend', { mode: 'add', bend: true }],
    ['difference + mask bright', { mode: 'difference', mask: 'bright' }], ['multiply + bend', { mode: 'multiply', bend: true }],
  ];
  for (const id of OVERLAY_CHECK_STRONG) {
    const row = overlayRow(id);
    flashScenes.forEach((scene, which) => {
      const entry = entryOf(scene);
      const push = (group, blend, fx = []) => {
        const { name, ...only } = blend;
        const asked = item(id, only);
        const drawn = overlaysDrawnFor(entry, [asked])[0];
        runs.push({
          group, scene, from: (which * 31) % (RECORDED_FRAMES - FX_CHECK_CLIP_FRAMES), fx, intensity: 'strong', flash: false,
          overlays: [asked], blendName: name || '', allowed: JSON.stringify(drawn.blend) === JSON.stringify(asked.blend),
        });
      };
      for (const mode of row.blends) if (mode !== 'add') push(`blend ${mode}`, { mode });
      for (const [name, blend] of extras) if (row.blends.includes(blend.mode)) push('blend extras', { ...blend, name });
      // Under an effect that moves the picture (Kaleidoscope), Difference
      // where allowed: the effect acts on scene and overlay together.
      if (row.under && row.blends.includes('difference')) push('blend extras', { mode: 'difference', under: true, name: 'difference under kaleidoscope' }, kaleidoscope);
    });
  }
  // Cost: each overlay alone at Medium's size on Tunnel (timing only).
  const tunnel = at('tunnel');
  for (const id of OVERLAY_IDS) {
    runs.push({
      group: 'cost alone (medium)', scene: tunnel, from: 0, fx: [], intensity: 'normal', flash: false, cost: true,
      quality: 'medium', size: OVERLAY_CHECK_SIZES.medium, overlays: [item(id)],
    });
  }
  // Cost of a blend-in at each quality: none, plain, blended (Rings, Screen).
  for (const [quality, size] of Object.entries(OVERLAY_CHECK_SIZES)) {
    for (const [kind, overlays] of [['none', []], ['plain', [item('rings')]], ['blended', [item('rings', { mode: 'screen' })]], ['blended under', [item('rings', { mode: 'screen', under: true })]]]) {
      runs.push({
        group: `cost ${quality}`, kind, scene: tunnel, from: 0, fx: [], intensity: 'normal', flash: false, cost: true, quality, size, overlays,
      });
    }
  }
  writeFileSync(out, JSON.stringify({ scenes, runs, clip: FX_CHECK_CLIP_FRAMES }));
  console.log(`\n${scenes.length} scenes, ${runs.length} overlay runs -> ${out}`);
}
const RECORDED_FRAMES = 180; // where clips start: 6 s of the track after its warm-up

async function main() {
  if (process.argv.includes('--overlays')) {
    const focus = process.argv.find((arg) => arg.startsWith('--overlay-focus='))?.split('=')[1] || null;
    await overlayRuns(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'visualizer-overlay-frames.json', focus);
    return;
  }
  const [out = 'visualizer-fx-frames.json', combosArg = '300'] = process.argv.slice(2);
  const combos = Math.max(1, Number(combosArg) || 300);
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const scenes = [];
  const defs = [];
  for (const id of FX_CHECK_SCENES) {
    const entry = SCENES.find((scene) => scene.id === id);
    const def = renderer.register(await entry.load(), entry.id);
    defs.push([entry, def]);
    // The scene as prepared (the sound is live in the page): no frames.
    const { frames, ...prepared } = recordScene(renderer, entry, def, { worst: true, recordMs: 0 });
    // Links whole (min, max, span), as applyLinks reads them in the page.
    scenes.push({ ...prepared, links: sceneLinks(def, entry), maxSpeed: entry.maxSpeed, frameCount: RECORDED_FRAMES });
    process.stdout.write(`${id} `);
  }
  const triggerScene = new Map();
  defs.forEach(([entry], index) => { if (!entry.fxNone) triggerScene.set(entry.id, index); });
  const { PostFxLibrary } = loadPostFx({});
  const catalog = fxCatalog(PostFxLibrary);
  const calmIds = fxCalmIds(catalog);
  const runs = [];
  FX_INTENSITIES.forEach((intensity, which) => {
    const shuffle = createFxShuffle({ catalog, random: seededRandom(2026 + which) });
    for (let index = 0; index < combos; index += 1) {
      const scene = index % defs.length;
      const entry = SCENES.find((row) => row.id === scenes[scene].id);
      const calm = entry.fxCalm;
      const combo = shuffle.next({
        intensity,
        mood: null,
        maxCount: entry.fxNone ? 0 : (calm ? FX_CALM_MAX : FX_MAX_BY_QUALITY.medium),
        costBudget: FX_COST_BUDGET.medium,
        allowed: calm ? calmIds : null,
      });
      shuffle.shown(combo || { ids: [] });
      const clipFrom = (index * 37) % (scenes[scene].frameCount - FX_CHECK_CLIP_FRAMES);
      runs.push({
        intensity,
        flash: Math.floor(index / defs.length) % 2 === 1,
        scene,
        from: clipFrom,
        fx: (combo?.fx || []).map(({ id, values, links }) => ({ id, values, links })),
      });
    }
  });
  // Trigger effects with flash on, on every scene that allows them: Shockwave
  // free running fast and on the beat, Datamosh on the bar, both together.
  // Their firings are charged to the live limiter (the page).
  const triggerSets = [
    [['shockwave'], { shockwave: { sync: FX_SYNC.free, interval: 0.2 } }],
    [['shockwave'], { shockwave: { sync: FX_SYNC.beat } }],
    [['datamosh'], { datamosh: { sync: FX_SYNC.bar } }],
    [['shockwave', 'datamosh'], { shockwave: { sync: FX_SYNC.free, interval: 0.3 }, datamosh: { sync: FX_SYNC.beat } }],
  ];
  const triggerShuffle = createFxShuffle({ catalog, random: seededRandom(77) });
  for (const [id, scene] of triggerScene) {
    const entry = SCENES.find((row) => row.id === id);
    triggerSets.forEach(([ids, values], which) => {
      const allowed = fxDrawnFor(entry, ids);
      if (allowed.length !== ids.length) return; // a calm scene leaves Datamosh out
      const combo = triggerShuffle.build(ids, 'strong');
      for (const item of combo.fx) Object.assign(item.values, values[item.id] || {});
      runs.push({
        group: 'triggers +flash',
        intensity: 'strong',
        flash: true,
        scene,
        from: (which * 41) % (scenes[scene].frameCount - FX_CHECK_CLIP_FRAMES),
        fx: combo.fx.map(({ id: fx, values: v, links }) => ({ id: fx, values: v, links })),
      });
    });
  }
  writeFileSync(out, JSON.stringify({ scenes, runs, clip: FX_CHECK_CLIP_FRAMES }));
  console.log(`\n${scenes.length} scenes, ${runs.length} runs -> ${out}`);
}

if (process.argv[1] && /visualizer-fx-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) await main();
