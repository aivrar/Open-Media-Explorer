/**
 * World Media's own scenes (src/visualizer/own/), written for the app rather
 * than ported: Band Ridgelines, Sound Ring, Hex Weave, Contour Lines and
 * Petal Bloom. Each is one shader in Psychedelia's effect format, loaded as
 * its own chunk, with the shared helpers every scene has (simplex noise,
 * the seed) and no borrowed code.
 *
 * Their sound moves shape only: each reads u_audio (bass, mid, high; after
 * the flash limiter) scaled by its own "Sound Response", and never u_beat;
 * no band reaches a colour or a brightness. Their looks are their palettes
 * (looks.js LOOK_PARAMS 'palette', four each).
 *
 * Held: they are offered nowhere (scene list, previous and next, shuffle,
 * favourites; a saved one opens the default scene) while
 * OWN_SCENES_RELEASED is false. Until each is measured (the flash check and
 * the frame time on the graphics card) they carry the most cautious
 * settings, as the held line-drawing scenes do: the time surge capped at
 * 1x, no drift, no post effects, cost class heavy. OWN_SCENES_PROPOSED
 * lists what each is expected to get once measured.
 */

/** Whether World Media's own scenes are offered (scenes.js SCENES). */
export const OWN_SCENES_RELEASED = true;

/** PROPOSED, not in use: each scene's cost class from reading its shader,
 *  its speed cap and whether it may drift, to confirm by measuring. */
export const OWN_SCENES_PROPOSED = Object.freeze({
  // 28 ridges (48 at most), two value-noise reads each.
  band_ridges: Object.freeze({ cost: 'light', maxSpeed: 1.5, drift: true }),
  // 5 rings (8 at most), a few sines each.
  band_ring: Object.freeze({ cost: 'light', maxSpeed: 1.5, drift: true }),
  // One hexagon lookup and three distances.
  hex_weave: Object.freeze({ cost: 'light', maxSpeed: 1.5, drift: true }),
  // Six simplex-noise reads (the field and its slope).
  contour_lines: Object.freeze({ cost: 'medium', maxSpeed: 1.5, drift: true }),
  // 4 layers (5 at most), a few sines each.
  petal_bloom: Object.freeze({ cost: 'light', maxSpeed: 1.5, drift: true }),
});

/** The settings each scene is drawn with: the proposed ones while they are
 *  measured (cost, speed cap, drift), with the usual effects (each steps by
 *  0.0125 at most, well under 0.06). */
export const OWN_SCENES_SETTINGS = OWN_SCENES_PROPOSED;

const NO_FX_LEFT_OUT = Object.freeze([]);
const own = (id, name, category, base, mood, hue, load) => Object.freeze({
  id,
  name,
  category,
  file: `own/${base}.js`,
  cost: OWN_SCENES_SETTINGS[id].cost,
  // They read the bands themselves (u_audio), shape only.
  audio: 'shader',
  load,
  mood,
  hue,
  maxSpeed: OWN_SCENES_SETTINGS[id].maxSpeed,
  fxCalm: false,
  fxNone: false,
  fxLeftOut: NO_FX_LEFT_OUT,
  // Drift where allowed: the scene's own plan (drift.js), chosen automatically.
  drift: OWN_SCENES_SETTINGS[id].drift ? undefined : false,
  links: null,
  defaults: null,
});

/** Every one of World Media's own scenes, in the shape of scenes.js entries. */
export const OWN_SCENE_ENTRIES = Object.freeze([
  own('band_ridges', 'Band Ridgelines', 'Sound Shapes', 'band-ridges', 'calm', 'warm', () => import('./own/band-ridges.js')),
  own('band_ring', 'Sound Ring', 'Sound Shapes', 'band-ring', 'lively', 'rainbow', () => import('./own/band-ring.js')),
  own('hex_weave', 'Hex Weave', 'Patterns', 'hex-weave', 'calm', 'warm', () => import('./own/hex-weave.js')),
  own('contour_lines', 'Contour Lines', 'Patterns', 'contour-lines', 'calm', 'cool', () => import('./own/contour-lines.js')),
  own('petal_bloom', 'Petal Bloom', 'Sound Shapes', 'petal-bloom', 'calm', 'warm', () => import('./own/petal-bloom.js')),
]);

/** World Media's own scenes offered: all of them once released, else none. */
export const OFFERED_OWN_SCENES = Object.freeze(OWN_SCENES_RELEASED ? [...OWN_SCENE_ENTRIES] : []);
