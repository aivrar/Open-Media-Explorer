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
});

/** Psychedelia presets left out of a scene's looks (by preset name), for
 *  the same reason, found the same way: Strange Attractor Flight's Aizawa
 *  Bloom Tunnel drops by 0.37 in a frame at 1.25x (Psychedelia 0a4fdc1,
 *  drawn around the trajectory its setUniforms hook feeds, as the tab draws
 *  it). (L-System Tube Flight's Crystal Fern Cathedral, left out until
 *  Psychedelia 0a4fdc1 for flying through a branch, is back: 0.056 at 1x.) */
export const PRESETS_LEFT_OUT = Object.freeze({
  strange_attractor_flight: Object.freeze(['Aizawa Bloom Tunnel']),
});

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
    looks.push(Object.freeze({ name, number: index + 1, values: Object.freeze(values) }));
  });
  return looks;
}

/** The looks of a registered scene `def` offered (frozen list of { name,
 *  number, values }, in Psychedelia's order), or an empty list. `all`:
 *  those left out too (for the flash check, to look at them again). */
export function sceneLooks(def, { all = false } = {}) {
  if (!def) return [];
  const presets = presetsOf(def, all);
  if (presets.length) return Object.freeze([Object.freeze({ name: DEFAULT_LOOK_NAME, number: 0, values: Object.freeze({}) }), ...presets]);
  const compiled = new Set(def.specialize || []);
  for (const name of LOOK_PARAMS) {
    const param = (def.params || []).find((row) => row.name === name);
    if (!param || param.type !== 'select' || compiled.has(name) || !Array.isArray(param.options) || param.options.length < 2) continue;
    const out = new Set(all ? [] : LOOKS_LEFT_OUT[def.name] || []);
    return Object.freeze(param.options.map((label, index) => (out.has(index) ? null : Object.freeze({
      name: String(label), number: index, values: Object.freeze({ [name]: index }),
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
