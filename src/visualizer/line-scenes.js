/**
 * Psychedelia's seven line-drawing scenes, on the line host (line-host.js):
 * Fourier Epicycles, Hopf Fibration, Knots & Surfaces, Lissajous, Attractor
 * Ribbons, 4D Polytopes and Spirograph. Each scene file is vendored by
 * scripts/import_psychedelia.mjs (LINE_FILES) and loaded with GlowLines as
 * its own chunk.
 *
 * Offered once LINE_SCENES_RELEASED is true, all but LINE_SCENES_HELD (a
 * held one is offered nowhere: scene list, previous and next, shuffle,
 * favourites; a saved one opens the default scene). Each was measured over
 * every look from a cold start (the flash check, 360 s of its clock at its
 * speed cap, the surge at its most, on the graphics card, with and without
 * drift): 0.024 a frame at most, so the usual effects; at most 14% of a
 * processor core at Medium (the segments are built on the processor), cost
 * class heavy as for the simulations.
 *
 * Their looks are their palettes (looks.js LOOK_PARAMS 'palette': Rainbow,
 * Neon, Ember), as for other scenes with a colour-scheme list.
 */

import { createLineGlowLines } from './line-host.js';

/** Whether the line-drawing scenes are offered (scenes.js SCENES). */
export const LINE_SCENES_RELEASED = true;

/** A line-drawing scene's module, loaded with Psychedelia's GlowLines (a
 *  fresh copy for each scene registered, given through the line host). */
const withGlowLines = (own) => () => Promise.all([
  import('./vendor/psychedelia/engine/glow-lines.js'),
  own(),
]).then(([glow, file]) => ({
  default: (G) => file.default({ ...G, GlowLines: createLineGlowLines(G, glow.default) }),
}));

/** The most some params may be at each quality (scene-renderer.js applies
 *  them to what is drawn, as scenes.js SCENE_QUALITY_CAPS): the trail and
 *  detail settings that set how many points and segments a scene builds on
 *  the processor each frame. */
export const LINE_QUALITY_CAPS = Object.freeze({
  // Points kept along the ribbon (each projected every frame).
  lorenz: Object.freeze({
    low: Object.freeze({ trail_length: 2000 }),
    medium: Object.freeze({ trail_length: 4000 }),
    high: Object.freeze({ trail_length: 6000 }),
  }),
  // Echoes of the curve (up to 1600 or 4000 points each, by curve family).
  lissajous: Object.freeze({
    low: Object.freeze({ trails: 1 }),
    medium: Object.freeze({ trails: 2 }),
    high: Object.freeze({ trails: 3 }),
  }),
  // Layers of the roulette.
  spirograph: Object.freeze({
    low: Object.freeze({ trails: 1 }),
    medium: Object.freeze({ trails: 2 }),
    high: Object.freeze({ trails: 3 }),
  }),
  // Circles (each a term summed at every point of the trace) and the trace.
  epicycles: Object.freeze({
    low: Object.freeze({ terms: 20, trace: 0.6 }),
    medium: Object.freeze({ terms: 40 }),
    high: Object.freeze({ terms: 60 }),
  }),
  // Rings and fibres (65 points each).
  hopf: Object.freeze({
    low: Object.freeze({ rings: 3, fibers: 12 }),
    medium: Object.freeze({ rings: 4, fibers: 18 }),
    high: Object.freeze({ rings: 6, fibers: 24 }),
  }),
  // Tube strands (421 points each) and the surfaces' grid.
  knots: Object.freeze({
    low: Object.freeze({ strands: 3, grid: 16 }),
    medium: Object.freeze({ strands: 5, grid: 24 }),
  }),
});

const NO_FX_LEFT_OUT = Object.freeze([]);
/** Drift (drift.js) moves their shape and the camera, never their
 *  brightness (line width, glow, trails, circle brightness), their speed
 *  (the surge already carries it) or Attractor Ribbons' chaos (each new
 *  value starts its ribbon again). */
const LINE_DRIFT = Object.freeze({
  exclude: Object.freeze(['thickness', 'width', 'glow', 'trails', 'trail_fade', 'circles', 'chaos', 'speed', 'audio_react']),
});
const line = (id, name, base, mood, load, extra = {}) => Object.freeze({
  id,
  name,
  category: 'Math',
  file: `effects/${base}.js`,
  cost: 'heavy',
  // They read the beat sources themselves (kick, bass, snare: AudioReactor).
  audio: 'shader',
  load: withGlowLines(load),
  // Drawn through the host for scenes that own their passes; 8-bit targets.
  needs: 'webgl2',
  mood,
  hue: 'rainbow',
  // Measured over every look (360 s of their clock at the cap, the surge at
  // its most, on the graphics card): 0.021 a frame at most, with drift.
  maxSpeed: extra.maxSpeed || 1,
  // Under the 0.06 at which the FX shuffle holds its effects back.
  fxCalm: false,
  fxNone: false,
  fxLeftOut: NO_FX_LEFT_OUT,
  drift: extra.drift === undefined ? LINE_DRIFT : extra.drift,
  links: null,
  defaults: extra.defaults ? Object.freeze(extra.defaults) : null,
});

/** Thin lines on black average under 0.05 (near black) with their own
 *  settings: on the Nebula Glow background, with wider lines and more glow
 *  (none of them drifted), they stay over it. */
const LIT = Object.freeze({ background: 2 });

/** Every line-drawing scene, in the shape of scenes.js entries. */
export const LINE_SCENE_ENTRIES = Object.freeze([
  line('epicycles', 'Fourier Epicycles', 'epicycles', 'lively', () => import('./vendor/psychedelia/effects/epicycles.js'), {
    // Kicks flash its glow (x (1 + 0.8 kick)): half its own beat reaction.
    // A few circles and one trace: on Nebula Glow with twice its line width
    // and glow it still sat under 0.05 for 6 s and more. Here on Nebula Glow
    // with wider lines, a larger figure, its circles at full brightness and
    // longer trails instead (its glow, which the kicks flash, as its own).
    defaults: {
      audio_react: 0.5, ...LIT, thickness: 4, size: 1.3, circles: 1, trails: 0.8,
    },
  }),
  line('hopf', 'Hopf Fibration', 'hopf', 'calm', () => import('./vendor/psychedelia/effects/hopf.js'), {
    // Kicks flash its glow and speed its rotation: half its own beat reaction.
    defaults: { audio_react: 0.5 },
    maxSpeed: 1.5,
    // Its drift (size, tumble, reach) shrank it under 0.05 for up to 8 s;
    // without, never under 0.07.
    drift: false,
  }),
  line('knots', 'Knots & Surfaces', 'knots', 'calm', () => import('./vendor/psychedelia/effects/knots.js'), {
    // Kicks flash its glow and spin it on: half its own beat reaction.
    defaults: { audio_react: 0.5, ...LIT, thickness: 3.5, glow: 2.4, size: 1.25 },
    maxSpeed: 1.5,
  }),
  line('lissajous', 'Lissajous', 'lissajous', 'calm', () => import('./vendor/psychedelia/effects/lissajous.js'), {
    defaults: { ...LIT, thickness: 3.6, glow: 2.1 },
  }),
  // (Psychedelia calls it Strange Attractors; a distinct name here, beside
  // Strange Attractor Flight.)
  line('lorenz', 'Attractor Ribbons', 'lorenz-attractor', 'calm', () => import('./vendor/psychedelia/effects/lorenz-attractor.js'), {
    defaults: { ...LIT, width: 3.9, glow: 1.8 },
    // Its zoom drifting out took it under 0.05 for up to 4 s; without, 0.3 s.
    drift: false,
  }),
  line('polytopes', '4D Polytopes', 'polytopes', 'lively', () => import('./vendor/psychedelia/effects/polytopes.js'), {
    // Its own start, "Change Every 4 Bars", swaps the planes it turns in
    // every 12 s (on the beat clock with music): the whole figure jumps to a
    // new pose in one frame. One rotation throughout instead; and half its
    // own beat reaction (kicks flash its glow and spin it on). Its own
    // Tesseract (32 edges) sat under 0.05 for 16 s and more in its edge-on
    // poses even on Nebula Glow with wider lines, more glow and longer
    // trails: the 600-Cell (720 edges) on Nebula Glow instead.
    defaults: {
      rotation_style: 0, audio_react: 0.5, ...LIT, shape: 3,
    },
  }),
  line('spirograph', 'Spirograph', 'spirograph', 'calm', () => import('./vendor/psychedelia/effects/spirograph.js'), {
    defaults: { ...LIT, thickness: 3.2, glow: 2.5, trail_fade: 0.75, zoom: 1.2 },
    // Its drift (breathing, the radii) took it under 0.05 for up to 8 s.
    drift: false,
  }),
]);

/** Line-drawing scenes held back once the rest are released, with why. */
// Fourier Epicycles and 4D Polytopes are back on their new start values
// (defaults above), each look 120 s at Medium on the graphics card, the
// surge at its most, with and without drift: Epicycles under 0.05 for
// 0.4 s at most at a time (mean 0.086 to 0.090), steps 0.010 at most;
// Polytopes never under 0.05 (mean 0.117 to 0.124), steps 0.019 at most.
export const LINE_SCENES_HELD = Object.freeze({});

/** The line-drawing scenes offered: once released, all but the held ones. */
export const OFFERED_LINE_SCENES = Object.freeze(LINE_SCENES_RELEASED
  ? LINE_SCENE_ENTRIES.filter((entry) => !Object.hasOwn(LINE_SCENES_HELD, entry.id)) : []);
