/**
 * Psychedelia's four accumulating labs: Attractor Density Lab, Buddhabrot
 * Lab and FLAM3 Density Lab (each builds its picture point by point in the
 * density worker, on the density host: density-host.js), and IFS / L-System
 * Lab (its own lines and points into a persistence target). Each file is
 * vendored by scripts/import_psychedelia.mjs (ACCUMULATING_FILES) and drawn
 * through the host for scenes that own their passes (sim-host.js).
 *
 * Held: a lab not in ACCUMULATING_RELEASED_IDS is offered nowhere (scene
 * list, previous and next, shuffle, favourites; a saved one opens the
 * default scene). Their speed cap, drift, effects
 * and cost class are the most cautious choice until each is measured: the
 * time surge capped at 1x, no drift, no post effects (fxNone), cost class
 * heavy.
 *
 * Drawn still: whatever a look sets, each lab's motion and colour cycling
 * are held at 0 and its persistence at 1 (ACCUMULATING_HELD), so a picture
 * builds to a finished image and then nothing more is computed until the
 * look or a value changes (the density host ends its worker; IFS / L-System
 * Lab stops drawing into its persistence target once it has settled).
 * IFS / L-System Lab's backgrounds stop at Nebula Glow (its Palette Haze
 * and Ink on Paper are far brighter: a change of look to or from them would
 * light the whole picture at once).
 *
 * Their looks are Psychedelia's presets for them (looks.js).
 */

import { createDensityRenderer } from './density-host.js';

/** The accumulating labs offered (scenes.js SCENES), each released on its
 *  own once measured. Buddhabrot Lab: every look's cold start stayed out of
 *  near black, its worker took 13 to 32% of one core by quality, and it
 *  ended with the scene and on a lost context. Still held, each over every
 *  look from a cold start and through the fade from a dark scene
 *  (30 s at Medium, paced): FLAM3 Density Lab's own look under 0.05 for
 *  5.0 s at a time cold and 4.3 s through the fade; IFS / L-System Lab's
 *  own look under 0.05 throughout (mean 0.042); Attractor Density Lab's
 *  own look 2.5 s cold. */
export const ACCUMULATING_RELEASED_IDS = Object.freeze(['buddhabrot_lab']);

/** The labs drawn on the density host: their picture builds up from black,
 *  so the cross-fade into one waits for it (index.js, transition.js). */
export const DENSITY_LAB_IDS = Object.freeze(['attractor_density_lab', 'buddhabrot_lab', 'flam3_density_lab']);
/** A density lab's picture counts as there from this mean brightness. */
export const DENSITY_READY_MEAN = 0.05;

/** Values held whatever a look sets: `set` (that value), `most` (at most
 *  that value) and `least` (at least that value). */
export const ACCUMULATING_HELD = Object.freeze({
  attractor_density_lab: Object.freeze({
    set: Object.freeze({
      attractor_constant_motion: 0,
      attractor_orbit_speed: 0,
      attractor_projection_speed: 0,
      attractor_constant_drift: 0,
      attractor_camera_orbit: 0,
      attractor_color_speed: 0,
      attractor_fade: 1,
    }),
    most: null,
  }),
  buddhabrot_lab: Object.freeze({
    set: Object.freeze({
      buddha_window_drift: 0,
      buddha_window_zoom_speed: 0,
      buddha_sample_motion: 0,
      buddha_drift_speed: 0,
      buddha_color_speed: 0,
      buddha_accumulation_decay: 1,
    }),
    most: null,
  }),
  flam3_density_lab: Object.freeze({
    // Its affine drift, symmetry pulse and variation morph all move with
    // its motion time (Flame Motion times the clock): held at 0, they hold.
    set: Object.freeze({ flam3_motion_rate: 0, flam3_color_speed: 0, flam3_accumulation_decay: 1 }),
    most: null,
  }),
  ifs_lsystem_lab: Object.freeze({
    // Its growth, sway, roll, zoom pulse and colour all move with its motion
    // time (Motion Rate times the clock): held at 0, they hold.
    set: Object.freeze({ ifs_motion_rate: 0 }),
    most: Object.freeze({ ifs_background: 2 }),
    // Lifted for every look: the Nebula Glow background (2, as its brightest
    // passing looks have), a stronger glow and lines no thinner than its own
    // start (11 of its 15 looks sat under 0.05 as they started without it).
    least: Object.freeze({ ifs_background: 2, ifs_glow: 1.8, ifs_thickness: 3.2, ifs_exposure: 2.4 }),
  }),
});

/** The most some params may be at each quality (scene-renderer.js applies
 *  them to what is drawn, as scenes.js SCENE_QUALITY_CAPS). Buddhabrot Lab
 *  and FLAM3 Density Lab need none: their slices of work stop at the density
 *  host's time limit. */
export const ACCUMULATING_QUALITY_CAPS = Object.freeze({
  // Particles (or orbits) a batch and their steps: the attractor's batches do
  // not stop at the time limit, so a batch is kept small.
  attractor_density_lab: Object.freeze({
    low: Object.freeze({ attractor_batch_size: 48, attractor_steps: 520 }),
    medium: Object.freeze({ attractor_batch_size: 96 }),
    high: Object.freeze({ attractor_batch_size: 144 }),
  }),
  // Points drawn into the persistence target until it settles.
  ifs_lsystem_lab: Object.freeze({
    low: Object.freeze({ ifs_point_count: 8000 }),
    medium: Object.freeze({ ifs_point_count: 16000 }),
    high: Object.freeze({ ifs_point_count: 24000 }),
  }),
});

/** `Controls` with `held` applied to the values it gives (one object, filled
 *  again each call: nothing made per frame). */
export function heldControls(Controls, held) {
  const out = {};
  return Object.freeze({
    getValues() {
      const values = Controls?.getValues ? Controls.getValues() : null;
      for (const key in out) out[key] = undefined;
      if (values) for (const key in values) out[key] = values[key];
      if (held?.set) for (const key in held.set) out[key] = held.set[key];
      if (held?.most) {
        for (const key in held.most) {
          const value = Number(out[key]);
          if (Number.isFinite(value) && value > held.most[key]) out[key] = held.most[key];
        }
      }
      if (held?.least) {
        for (const key in held.least) {
          const value = Number(out[key]);
          if (!Number.isFinite(value) || value < held.least[key]) out[key] = held.least[key];
        }
      }
      return out;
    },
  });
}

/** A lab's module, given the held Controls and (for a density lab) the
 *  density host as its ProgressiveDensityRenderer. */
const hosted = (id, own, density) => () => own().then((file) => ({
  default: (G) => file.default({
    ...G,
    Controls: heldControls(G.Controls, ACCUMULATING_HELD[id]),
    // The held density scenes get a dim backing while their workers build
    // the first visible points. Buddhabrot keeps its measured black level.
    ...(density ? { ProgressiveDensityRenderer: createDensityRenderer(G, {
      backingLift: id === 'buddhabrot_lab' ? 0 : 0.055,
    }) } : {}),
  }),
}));

const NO_FX_LEFT_OUT = Object.freeze([]);
const lab = (id, name, base, mood, hue, load, density, defaults = null) => Object.freeze({
  id,
  name,
  category: 'Fractals',
  file: `effects/${base}.js`,
  cost: 'heavy',
  // No beat reaction of their own; the zoom punch crops in (density host).
  audio: 'motion',
  load: hosted(id, load, density),
  // Drawn through the host for scenes that own their passes; 8-bit targets.
  needs: 'webgl2',
  mood,
  hue,
  maxSpeed: 1,
  fxCalm: true,
  fxNone: true,
  fxLeftOut: NO_FX_LEFT_OUT,
  drift: false,
  links: null,
  defaults,
});

/** Every accumulating lab, in the shape of scenes.js entries. */
export const ACCUMULATING_SCENE_ENTRIES = Object.freeze([
  // Its density curve lifted for every look (its own 0.72; no look sets
  // it): its sparse first points show brighter, so its picture is there
  // sooner. Its own look through the fade from a dark scene: under 0.05 for
  // 2.7 s at a time at its own curve, 1.2 s at 0.45; from a cold start still
  // 2.5 s at 0.45, so it stays held (ACCUMULATING_RELEASED_IDS).
  lab('attractor_density_lab', 'Attractor Density Lab', 'attractor-density-lab', 'calm', 'rainbow',
    () => import('./vendor/psychedelia/effects/attractor-density-lab.js'), true, Object.freeze({ attractor_density_curve: 0.45 })),
  lab('buddhabrot_lab', 'Buddhabrot Lab', 'buddhabrot-lab', 'calm', 'cool',
    () => import('./vendor/psychedelia/effects/buddhabrot-lab.js'), true),
  // Its gamma lifted for every look (its own 0.9; no look sets it): twelve
  // of its 26 looks sat under 0.05 as they started at its own.
  lab('flam3_density_lab', 'FLAM3 Density Lab', 'flam3-density-lab', 'calm', 'warm',
    () => import('./vendor/psychedelia/effects/flam3-density-lab.js'), true, Object.freeze({ flam3_gamma: 1.8 })),
  lab('ifs_lsystem_lab', 'IFS / L-System Lab', 'ifs-lsystem-lab', 'calm', 'rainbow',
    () => import('./vendor/psychedelia/effects/ifs-lsystem-lab.js'), false),
]);

/** The accumulating labs offered: those released. */
export const OFFERED_ACCUMULATING_SCENES = Object.freeze(ACCUMULATING_SCENE_ENTRIES.filter((entry) => ACCUMULATING_RELEASED_IDS.includes(entry.id)));
