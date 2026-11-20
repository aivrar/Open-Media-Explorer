/**
 * A scene's "looks": ready-made sets of values the Look chooser steps through
 * (previous / next), remembered per scene in the `visualizerLooks` setting.
 *
 * Where Psychedelia gives a scene presets (`smokePresets`, on the scene or its
 * flight metadata `fractalFlight`: { name, values }), those are the looks,
 * after a first "Default" look that keeps the scene's own start. Psychedelia
 * has them only for some of its 3D flights and its endless scenes; every
 * other scene takes its looks from its colour-scheme list instead: the options of its first select param named in LOOK_PARAMS that is
 * a plain uniform (not compiled into the shader), so a change of look is a
 * change of uniform with no new compile. A scene without either has no looks
 * and the chooser is hidden.
 *
 * A look is chosen by hand only; the music never changes it, so it is not a
 * flash risk (a single change of colours, at most a few times a second when
 * the button is pressed that often).
 *
 * Each look has a `number`, which is what the settings, favourites and the
 * shuffle keep: its place in Psychedelia's own list (the option's index; for
 * presets 0 is Default and preset i is i + 1), not its place among the looks
 * offered. A look left out (LOOKS_LEFT_OUT, PRESETS_LEFT_OUT) is simply not
 * offered, so leaving one out, or bringing it back, never changes what any
 * other saved number shows; a saved number of a left-out look shows the
 * scene's start look.
 */

import { VISUALIZER_LOOKS_MAX_SCENES } from '../lib/visualizer-settings.js';

export const LOOK_PARAMS = Object.freeze([
  'scheme', 'palette_type', 'palette', 'color_mode', 'palette_mode', 'background', 'metal', 'world', 'coloring',
]);

export const DEFAULT_LOOK_NAME = 'Default';

/** Colour schemes left out of a scene's looks (by option index), because
 *  the flash check (tests/helpers/visualizer-flash-check.mjs --worst --looks
 *  --gpu) found them stepping over 0.10 on their own clock, with no time
 *  surge at all: Mandelbrot's Neon (0.105) and Ocean (0.112) palettes cycle
 *  hard-edged bands through its dive. */
export const LOOKS_LEFT_OUT = Object.freeze({
  mandelbrot: Object.freeze([1, 3]),
  // Glass Fractal DE Flight's Chrome Cyan (0.088 at its cap of 1x over 360 s
  // of its clock, 0.094 with drift; its other colour schemes 0.056 at most).
  path_traced_fractal_flight: Object.freeze([2]),
  // Physarum's Bioluminescent flickers as its agents first gather (0.219,
  // a 4 Hz flicker of 0.31 peak to peak in its first 10 s; dimmer, still
  // 0.127; from a ring or circle start, near black for 20 s or over 0.10).
  // From a centre burst it is calm, but near black for its first 8 to 10 s.
  physarum: Object.freeze([1]),
  // The near-black sweep (every look, 30 s at Medium on the graphics card;
  // a look under 0.05 for more than about 2 s at a time reads as broken).
  // Dark throughout: Liquid Chrome's Black Mirror (mean 0.044, under 0.05
  // for 22 of 30 s) and Multibrot's Blue Magenta (0.049, 19 of 30 s). The
  // others still dark with their colours held (LOOK_ADJUSTED) or more glow:
  // Multibrot's Violet Gold (2.2 s, under 0.05 for 15 of 30 s), Mandelbulb
  // Slice's Aqua Rose and Violet Gold (dark throughout once held), Orbit
  // Trap's Blue Orchid (3.5 s), Tricorn's Ruby Ice and Toxic Violet (3.7 s,
  // 3.0 s) and Mandelbox Flight's Molten Brass and Ember Vault (4.8 s, 7.4 s;
  // dark where its path flies, with glow 1.6 too).
  liquid_chrome: Object.freeze([3]),
  multibrot: Object.freeze([2, 4]),
  mandelbulb_slice: Object.freeze([5, 6]),
  orbit_trap: Object.freeze([3]),
  tricorn: Object.freeze([1, 2]),
  mandelbox_flight: Object.freeze([0, 3]),
});

/** Psychedelia presets left out of a scene's looks (by preset name), for
 *  the same reason, found the same way. Strange Attractor Flight, drawn
 *  around the trajectory its setUniforms hook feeds, as the tab draws it:
 *  its Aizawa Bloom Tunnel drops by 0.37 in a frame at 1.25x (Psychedelia
 *  0a4fdc1); its Lorenz Wing Dive and Rossler Spiral Graze fly through their
 *  bright ribbons about three times as fast as its start look, stepping by
 *  0.32 and 0.37 at 3x, 0.199 and 0.218 at its cap of 1.5x (scenes.js
 *  SPEED_CAPS) and still 0.146 and 0.183 at 1x (360 s of its clock, the
 *  surge at its most, on the graphics card). (L-System Tube Flight's
 *  Crystal Fern Cathedral, left out until Psychedelia 0a4fdc1 for flying
 *  through a branch, is back: 0.056 at 1x.) */
export const PRESETS_LEFT_OUT = Object.freeze({
  strange_attractor_flight: Object.freeze(['Lorenz Wing Dive', 'Aizawa Bloom Tunnel', 'Rossler Spiral Graze']),
  // Slice 12, the flights back from the held list (scenes.js SPEED_CAPS),
  // each at its cap of 1x over 360 s of its clock. Apollonian Foam: its
  // Knighty Foam Orbit and Kleinian Box Graze fly in and out of the foam
  // (0.275, 0.165), its Apollonian Cell Tunnel 0.091 (too near 0.10).
  apollonian_foam_flight: Object.freeze(['Knighty Foam Orbit', 'Apollonian Cell Tunnel', 'Kleinian Box Graze']),
  // Its Amazing Box Orbit: 0.212.
  folded_box_variants_flight: Object.freeze(['Amazing Box Orbit']),
  // Burning Tunnel Push 0.532, Spudsville Fold Dive 0.292.
  triplex_mutation_flight: Object.freeze(['Burning Tunnel Push', 'Spudsville Fold Dive']),
  // Glass Fractal DE Flight: all four (0.170 to 0.354); its start look 0.041.
  // With no preset left it offers its colour schemes (LOOKS_LEFT_OUT).
  path_traced_fractal_flight: Object.freeze(['Glass Mandelbox Dive', 'Crystal Bulb Chamber', 'Mirror Menger Corridor', 'Void Caustic Shell Orbit']),
  // Slice 13, 2D Formula Lab: its Root Solver Bloom flips bands of its
  // root basins (0.256 at 3x over 360 s of its clock, 0.144 still at 1x);
  // its other looks 0.076 at most at 3x.
  escape_time_lab: Object.freeze(['Root Solver Bloom']),
  // Fractal Flame Lab: its colours cycle through its palette, and four of
  // its palettes have a dark end; these four sit near black (under 0.05)
  // for 14 to 18 s of every cycle at the music's own pace, and with their
  // colours held (LOOK_ADJUSTED) they stay dark throughout.
  fractal_flame_lab: Object.freeze(['Spherical Ember Cloud', 'Julia Veil Glass', 'Radial Streak Crown', 'Popcorn Texture Bloom']),
  // The near-black sweep (every look, 30 s at Medium on the graphics card):
  // Analytic Field Lab's Continued Portal under 0.05 for 16.7 s at a time
  // (16.2 s at brightness 2), 3D Fractal Flame Volume Flight's Swirl Flame
  // Dive 2.6 s (the same at glow 2).
  analytic_field_lab: Object.freeze(['Continued Portal']),
  fractal_flame_volume_flight: Object.freeze(['Swirl Flame Dive']),
});

/** Values the app sets on top of a look (by the look's name: a Psychedelia
 *  preset, or a colour scheme), to keep it lit: a look that sits near black
 *  (under 0.05) for more than a few seconds reads as broken. Fractal Flame
 *  Lab: these five went near black for 7 to 16 s of every
 *  colour cycle (a real-window finding for Starburst Ray Choir; the other
 *  four found the same way); with their colour cycling held they stay lit
 *  all through (darkest 10 s 0.054 to 0.21) and still move with their
 *  structure. */
export const LOOK_ADJUSTED = Object.freeze({
  fractal_flame_lab: Object.freeze({
    'Mandala Bloom Wheel': Object.freeze({ flame_color_speed: 0 }),
    'Lace Arch Lantern': Object.freeze({ flame_color_speed: 0 }),
    'Starburst Ray Choir': Object.freeze({ flame_color_speed: 0 }),
    'PDJ Chaos Silk': Object.freeze({ flame_color_speed: 0 }),
    'Rings Orbit Flame': Object.freeze({ flame_color_speed: 0 }),
  }),
  // Fluid Ink: its darker colour schemes sat under 0.05 for up to 17 s at
  // a time (Ink & Gold) at its own brightness; brighter, they stay over it.
  // Its Pastel is bright as it is. (scenes.js starts it at 1.6, so a
  // scene shown before any look is chosen matches its first look.)
  fluid_ink: Object.freeze({
    'Rainbow Cycle': Object.freeze({ brightness: 1.6 }),
    'Ink & Gold': Object.freeze({ brightness: 2.2 }),
    Neon: Object.freeze({ brightness: 1.6 }),
    Pastel: Object.freeze({ brightness: 1 }),
  }),
  // The near-black sweep (every look, 30 s at Medium on the graphics card)
  // found these under 0.05 for 2.3 to 5.7 s at a time. Palettes with a dark
  // end that the colour cycling sweeps through: their colours held (longest
  // under 0.05 then 0 to 2.2 s). Sierpinski's Violet Gold: more glow (2.6 s
  // to 1.1 s); 2D Formula Lab's Magnet Gate: brighter (2.8 s to 1.5 s).
  escape_time_lab: Object.freeze({ 'Magnet Gate': Object.freeze({ brightness: 1.6 }) }),
  mandelbulb_slice: Object.freeze({
    Organic: Object.freeze({ color_speed: 0 }),
    'Neon Magma': Object.freeze({ color_speed: 0 }),
  }),
  multibrot: Object.freeze({ 'Amber Crown': Object.freeze({ color_speed: 0 }) }),
  orbit_trap: Object.freeze({ 'Amber Lines': Object.freeze({ color_speed: 0 }) }),
  sierpinski: Object.freeze({ 'Violet Gold': Object.freeze({ glow: 1.4 }) }),
  tricorn: Object.freeze({ 'Gold Glass': Object.freeze({ color_speed: 0 }) }),
  // World Media's own Contour Lines: its Ember and Neon palettes sat under
  // 0.05 for 55 s and 14 s at a time at its own brightness (0.85).
  contour_lines: Object.freeze({
    Ember: Object.freeze({ brightness: 1.2 }),
    Neon: Object.freeze({ brightness: 1.2 }),
  }),
});

/** Formulas Psychedelia's labs have that none of their presets shows, as
 *  extra looks: each sets only the formula (every other value is
 *  Psychedelia's own default). Numbered from EXTRA_LOOK_FIRST in this
 *  order, so the list may only grow at its end. Offered since measured
 *  (EXTRA_LOOKS_HELD false), except those in EXTRA_LOOKS_LEFT_OUT; the flash
 *  check can draw every one (sceneLooks(def, { held: true })). Named by their
 *  option labels (a pair joined by ' + '). */
export const EXTRA_LOOKS_HELD = false;
export const EXTRA_LOOK_FIRST = 20;
const formulas = (param, indices) => Object.freeze(indices.map((index) => Object.freeze({ [param]: index })));
export const EXTRA_LOOKS = Object.freeze({
  escape_time_lab: formulas('formula', [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 15, 17, 18, 19, 21, 22, 23, 25, 27, 29, 30, 31]),
  analytic_field_lab: formulas('field_mode', [5, 10]),
  // Variation A with Psychedelia's B (2, Spherical), then its A (3, Swirl)
  // with each B.
  fractal_flame_lab: Object.freeze([
    ...[0, 5, 6, 7, 9].map((a) => Object.freeze({ flame_variation_a: a, flame_variation_b: 2 })),
    ...[0, 4, 8, 10, 11].map((b) => Object.freeze({ flame_variation_a: 3, flame_variation_b: b })),
  ]),
});

/** Extra looks left out by look number: measured over 360 s of the clock at
 *  the scene's speed cap, these change by 0.1 to 0.46 of full brightness
 *  from one frame to the next (the others 0.05 at most). Rows of EXTRA_LOOKS
 *  stay, so the numbers of the others never move. */
export const EXTRA_LOOKS_LEFT_OUT = Object.freeze({
  escape_time_lab: Object.freeze([20, 22, 38, 39, 40, 41, 42]),
});

function extraLooksOf(def, all) {
  const rows = EXTRA_LOOKS[def?.name];
  if (!rows) return [];
  const out = new Set(all ? [] : EXTRA_LOOKS_LEFT_OUT[def.name] || []);
  const params = new Map((def.params || []).map((param) => [param.name, param]));
  return rows.map((values, index) => {
    const labels = Object.entries(values).map(([name, value]) => params.get(name)?.options?.[value]);
    if (labels.some((label) => typeof label !== 'string')) return null;
    if (out.has(EXTRA_LOOK_FIRST + index)) return null;
    return Object.freeze({ name: labels.join(' + '), number: EXTRA_LOOK_FIRST + index, values: Object.freeze({ ...values }) });
  }).filter(Boolean);
}

function adjusted(def, name, values) {
  const params = new Set((def.params || []).map((param) => param.name));
  const extra = Object.entries(LOOK_ADJUSTED[def.name]?.[name] || {}).filter(([param]) => params.has(param));
  return extra.length ? { ...values, ...Object.fromEntries(extra) } : values;
}

function presetsOf(def, all) {
  const list = [def?.smokePresets, def?.fractalFlight?.smokePresets, def?.meta?.smokePresets].find(Array.isArray);
  if (!Array.isArray(list)) return [];
  const params = new Set((def.params || []).map((param) => param.name));
  const out = new Set(all ? [] : PRESETS_LEFT_OUT[def.name] || []);
  const looks = [];
  list.forEach((preset, index) => {
    if (!preset || typeof preset.values !== 'object' || !preset.values || out.has(preset.name)) return;
    const values = {};
    for (const [name, value] of Object.entries(preset.values)) {
      if (params.has(name) && Number.isFinite(value)) values[name] = value;
    }
    if (!Object.keys(values).length) return;
    const name = typeof preset.name === 'string' && preset.name ? preset.name : `Look ${index + 1}`;
    looks.push(Object.freeze({ name, number: index + 1, values: Object.freeze(adjusted(def, name, values)) }));
  });
  return looks;
}

/** The looks of a registered scene `def` offered (frozen list of { name,
 *  number, values }, in Psychedelia's order), or an empty list. `all`:
 *  those left out too (for the flash check, to look at them again).
 *  `held`: every extra look (EXTRA_LOOKS), held or left out. */
export function sceneLooks(def, { all = false, held = false } = {}) {
  if (!def) return [];
  const presets = presetsOf(def, all);
  const extra = !EXTRA_LOOKS_HELD || held ? extraLooksOf(def, all || held) : [];
  if (presets.length || extra.length) {
    return Object.freeze([Object.freeze({ name: DEFAULT_LOOK_NAME, number: 0, values: Object.freeze({}) }), ...presets, ...extra]);
  }
  const compiled = new Set(def.specialize || []);
  for (const name of LOOK_PARAMS) {
    const param = (def.params || []).find((row) => row.name === name);
    if (!param || param.type !== 'select' || compiled.has(name) || !Array.isArray(param.options) || param.options.length < 2) continue;
    const out = new Set(all ? [] : LOOKS_LEFT_OUT[def.name] || []);
    return Object.freeze(param.options.map((label, index) => (out.has(index) ? null : Object.freeze({
      name: String(label), number: index, values: Object.freeze(adjusted(def, String(label), { [name]: index })),
    }))).filter(Boolean));
  }
  return [];
}

/** The look offered with number `number` in `looks`, or null. */
export function lookByNumber(looks, number) {
  return Number.isInteger(number) ? looks.find((look) => look.number === number) || null : null;
}

/** The number of the look a scene starts with, given the values it starts
 *  with (Psychedelia's defaults with scenes.js `defaults` on top): the first
 *  look all of whose values match, else the first look's. */
export function startLook(looks, values) {
  const look = looks.find((row) => Object.entries(row.values).every(([name, value]) => values?.[name] === value));
  return (look || looks[0])?.number ?? 0;
}

/** The number of the look a scene shows: the saved one when it is offered,
 *  else its start. */
export function currentLook(looks, saved, start) {
  return lookByNumber(looks, saved) ? saved : start;
}

/** The values to prepare scene `entry` with: its `defaults` with the saved
 *  look on top (null when there are none; a left-out or unknown number
 *  counts as none). */
export function lookOverrides(entry, def, saved) {
  const look = lookByNumber(sceneLooks(def), saved);
  if (!look) return entry?.defaults || null;
  return { ...(entry?.defaults || {}), ...look.values };
}

/** `looks` (the visualizerLooks setting) with scene `id` at look number
 *  `index`; the entry is dropped when `index` is the scene's start, so the setting
 *  keeps only looks that differ. A choice is always kept: the latest goes
 *  last, and when the setting is full (VISUALIZER_LOOKS_MAX_SCENES) room is
 *  made by dropping entries for scenes this build does not have (`known`,
 *  a list of ids), then the oldest. */
export function withLook(looks, id, index, start, known = null) {
  const next = { ...(looks || {}) };
  delete next[id];
  if (index === start) return next;
  const ids = Object.keys(next);
  const knownIds = known ? new Set(known) : null;
  const unknown = knownIds ? ids.filter((key) => !knownIds.has(key)) : [];
  const oldest = ids.filter((key) => !unknown.includes(key));
  for (const key of [...unknown, ...oldest]) {
    if (Object.keys(next).length < VISUALIZER_LOOKS_MAX_SCENES) break;
    delete next[key];
  }
  next[id] = index;
  return next;
}
