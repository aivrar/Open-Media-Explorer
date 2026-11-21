/**
 * The post effects ("FX") the Visualizer offers, over Psychedelia's post FX
 * library (vendor/psychedelia/engine/post-fx-library.js, used unchanged: its
 * shader passes and their parameter definitions). This table is ours: which
 * passes are offered, what each costs, how strong it looks, what it may be
 * combined with, the range each parameter is drawn from when the FX shuffle
 * picks it, and which parameters may move with the music.
 *
 * Per FX:
 *   cost     'light' | 'medium' | 'heavy': texture reads per pixel
 *            (light: up to ~10, medium: up to ~30, heavy: more), as for scenes
 *   weight   how much it changes the picture (0..1); a combination's weights
 *            add up and stay under the intensity's budget (fx-shuffle.js)
 *   tags     'calm' | 'lively': the music's mood favours its own
 *   groups   at most one FX of a group in a combination: 'geometry' (moves
 *            the picture around), 'replace' (redraws it in another medium),
 *            'feedback' (keeps past frames), 'glow' (adds light), 'retro'
 *   ranges   param -> [lo, hi] (a float drawn uniformly in it), [lo, hi,
 *            'int'], { pick: [...] } (one of these values), { strength:
 *            [lo, hi] } (a float drawn in the part of it the intensity
 *            allows), or a number (always that). Params not named keep
 *            Psychedelia's default.
 *   links    param -> 'punch' | 'size' | 'detail': may move with the music
 *            (kick or snare hits for punchy geometric params, bass or
 *            loudness for slow size and warp, hats or treble for fine
 *            detail). Each still has to pass reactor.js linkRuleViolation.
 *
 * Light rules (the flash limiter's, docs in flash-limiter.js): a parameter
 * that is a change of light (brightness, exposure, gain, glow, bloom
 * strength, flash, flicker, invert, white-out, an FX's mix) never moves with
 * the music and is held in a narrow range here. FX or modes that invert or
 * strobe the whole picture are left out or pinned, as FX_EXCLUDED and the
 * `fixed` notes below say.
 */

import { americanText } from './spelling.js';

/** Passes of Psychedelia's library that are not offered, and why. */
export const FX_EXCLUDED = Object.freeze({});

/** Parts of passes that are pinned or left out (light rules). */
export const FX_PINNED = Object.freeze({
  color_grade: 'Invert pinned at 0 (it would invert the whole picture); brightness, contrast and gamma held near neutral',
  vision: 'X-Ray mode left out (it inverts the picture); gain held near 1',
  crt: 'Flicker pinned at 0 (a 30 Hz brightness flicker); brightness held near 1',
  dither: '1-Bit mode left out (full black and white patterns); brightness held at 0',
  led_wall: 'Brightness held near 1',
  glitch: 'Colour swaps pinned at 0 and static lines held low (line strobing)',
  shockwave: 'Ring glow held low; fires on the beat or bar only',
  datamosh: 'Refreshes on the bar only, with live bleed kept up so the snap back is small',
  palette_map: 'Bands pinned at 0 (they flip many pixels at once); its offset never moves with the beat; its mix held under full and its colour cycling slow',
});

export const FX_COSTS = Object.freeze(['light', 'medium', 'heavy']);
/** What a cost class counts for against a combination's cost budget. */
export const FX_COST_UNITS = Object.freeze({ light: 1, medium: 2, heavy: 4 });

/** The last palette of Psychedelia's palettes.js (71 palettes): the
 *  Palette Map pass picks any of them. */
export const PALETTE_MAP_LAST = 70;

const MIX = 1; // an FX's own mix stays full: the shuffle never fades one half in

/* Sync choices of the trigger passes, as indexes into Psychedelia's list
 * (SYNC_OPTIONS: Free Run, Kick, Snare, Beat, Bar, Drops, Hi-hat). Only
 * these are used here; fx-chain.js times them from the limited beat clock. */
export const FX_SYNC = Object.freeze({ free: 0, beat: 3, bar: 4 });

export const FX_TABLE = Object.freeze({
  /* ---- Distort ---- */
  mirror: {
    cost: 'light', weight: 0.8, tags: ['calm', 'lively'], groups: ['geometry'],
    ranges: {
      mode: { pick: [0, 1, 2, 3, 4] }, segments: [3, 10, 'int'], rotation: [0, 1], spin: [-0.06, 0.06], zoom: [0.8, 1.6],
    },
  },
  droste: {
    cost: 'light', weight: 0.9, tags: ['calm'], groups: ['geometry'],
    ranges: {
      zoom_speed: [0.12, 0.45], scale: [2.2, 5], twist: { pick: [-1, 0, 1] }, spin: [-0.05, 0.05], mix: MIX,
    },
    links: { scale: 'punch' },
  },
  swirl: {
    cost: 'light', weight: 0.6, tags: ['calm'], groups: ['geometry'],
    ranges: {
      strength: { strength: [0.35, 1.2] }, radius: [0.45, 1.1], wobble: [0.1, 0.5], speed: [0.3, 1.2],
    },
    links: { strength: 'size' },
  },
  wave: {
    cost: 'light', weight: 0.4, tags: ['calm'], groups: ['geometry'],
    ranges: {
      mode: { pick: [0, 1, 2, 3] }, amplitude: { strength: [0.006, 0.03] }, frequency: [4, 18], speed: [0.4, 1.6], turbulence: [0.1, 0.5],
    },
    links: { amplitude: 'size' },
  },
  fisheye: {
    cost: 'light', weight: 0.5, tags: ['lively'], groups: ['geometry'],
    ranges: { strength: { strength: [0.2, 0.6] }, radius: [0.5, 1.1] },
    links: { strength: 'punch' },
  },
  shockwave: {
    cost: 'light', weight: 0.4, tags: ['lively'], groups: [],
    ranges: {
      sync: { pick: [FX_SYNC.beat, FX_SYNC.bar] }, interval: [1, 2.5], strength: { strength: [0.03, 0.08] },
      width: [0.04, 0.1], speed: [0.7, 1.4], glow: [0, 0.2], chroma: [0.1, 0.5],
    },
  },
  zoom_blur: {
    cost: 'medium', weight: 0.5, tags: ['lively'], groups: [],
    ranges: { mode: { pick: [0, 1] }, strength: { strength: [0.05, 0.16] }, quality: { pick: [0, 1] }, glow: [0, 0.2] },
    links: { strength: 'punch' },
  },
  pixelate: {
    cost: 'light', weight: 0.7, tags: ['lively'], groups: ['replace'],
    ranges: { size: [3, 10, 'int'], shape: { pick: [0, 1, 2] }, gap: [0, 0.3] },
  },
  heat_haze: {
    cost: 'light', weight: 0.5, tags: ['calm'], groups: ['geometry'],
    ranges: {
      mode: 0, strength: { strength: [0.3, 1.2] }, scale: [1, 4], speed: [0.4, 1.4], mix: MIX,
    },
    links: { strength: 'size' },
  },

  /* ---- Feedback ---- */
  trails: {
    cost: 'light', weight: 0.7, tags: ['calm'], groups: ['feedback'],
    ranges: {
      amount: { strength: [0.55, 0.88] }, zoom: [0.996, 1.012], rotate: [-0.006, 0.006], hue: [-0.004, 0.004],
      blend: { pick: [0, 2] }, drift_x: [-0.002, 0.002], drift_y: [-0.002, 0.002],
    },
    links: { zoom: 'punch' },
  },
  rgb_echo: {
    cost: 'light', weight: 0.6, tags: ['lively'], groups: ['feedback'],
    ranges: {
      mode: { pick: [0, 1, 2, 3] }, lag1: [0.4, 0.75], lag2: [0.6, 0.9], drift: [-0.006, 0.008], twist: [-0.008, 0.008], mix: MIX,
    },
  },
  slit_scan: {
    cost: 'light', weight: 0.9, tags: ['lively'], groups: ['feedback', 'geometry'],
    ranges: {
      mode: { pick: [0, 1, 2, 3] }, speed: [1, 4], slit: [0.3, 0.7], width: [2, 12], mix: MIX,
    },
  },
  datamosh: {
    cost: 'light', weight: 1, tags: ['lively'], groups: ['feedback', 'replace'],
    ranges: {
      sync: FX_SYNC.bar, interval: [2, 4], smear: { strength: [0.4, 1.4] }, block: [8, 32, 'int'], bleed: [0.2, 0.4], jitter: [0.1, 0.4], mix: MIX,
    },
    links: { smear: 'size' },
  },

  /* ---- Colour ---- */
  color_grade: {
    cost: 'light', weight: 0.4, tags: ['calm', 'lively'], groups: [],
    ranges: {
      brightness: [-0.04, 0.04], contrast: [0.95, 1.2], saturation: [0.9, 1.7], hue_shift: [0, 1], gamma: [0.9, 1.1],
      temperature: [-0.4, 0.4], tint: [-0.3, 0.3], vibrance: [0, 0.6], invert: 0,
    },
    links: { saturation: 'size' },
  },
  color_wash: {
    cost: 'light', weight: 0.6, tags: ['calm', 'lively'], groups: [],
    ranges: {
      mode: { pick: [0, 1, 2, 3] }, amount: { strength: [0.25, 0.6] }, scale: [1, 5], speed: [-1, 1], saturation: [0.9, 1.4],
    },
  },
  posterize: {
    cost: 'light', weight: 0.6, tags: ['lively'], groups: ['replace'],
    ranges: {
      levels: [3, 8, 'int'], gamma: [0.9, 1.15], ink: [0.2, 0.7], ink_threshold: [0.08, 0.2], mix: MIX,
    },
  },
  // Its palette is a look-up texture the chain binds (fxCatalog: lut).
  palette_map: {
    cost: 'light', weight: 0.8, tags: ['calm', 'lively'], groups: ['replace'],
    ranges: {
      palette: [0, PALETTE_MAP_LAST, 'int'], mix: { strength: [0.35, 0.7] }, spread: [0.6, 1.6], cycle: [-0.03, 0.03],
      source: { pick: [0, 1, 2] }, offset: [0, 1], posterize: 0,
    },
    links: { spread: 'size' },
  },
  vision: {
    cost: 'light', weight: 0.9, tags: ['lively'], groups: ['replace'],
    ranges: {
      mode: { pick: [0, 1, 3] }, gain: [0.95, 1.25], noise: [0.05, 0.25], scanlines: [0.1, 0.4], vignette: [0.2, 0.6], mix: MIX,
    },
  },

  /* ---- Stylize ---- */
  edge_glow: {
    cost: 'medium', weight: 0.8, tags: ['lively'], groups: ['glow'],
    ranges: {
      intensity: { strength: [0.5, 1.3] }, threshold: [0.06, 0.2], color_speed: [0.2, 1.5], mode: 0, width: [0.8, 2], color_mode: { pick: [0, 1] },
    },
  },
  halftone: {
    cost: 'light', weight: 1, tags: ['calm', 'lively'], groups: ['replace'],
    ranges: {
      size: [5, 14], angle: [0, 0.25], mode: { pick: [0, 1, 2] }, contrast: [1, 1.4], mix: MIX,
    },
    links: { size: 'size' },
  },
  led_wall: {
    cost: 'light', weight: 0.9, tags: ['lively'], groups: ['replace', 'glow'],
    ranges: {
      cell: [6, 14], roundness: [0.3, 1], gap: [0.06, 0.2], glow: [0.2, 0.5], brightness: [1, 1.2],
    },
  },
  sharpen: {
    cost: 'light', weight: 0.3, tags: ['lively'], groups: [],
    ranges: { amount: { strength: [0.5, 1.6] }, radius: [0.8, 2] },
    links: { radius: 'detail' },
  },
  oil_paint: {
    cost: 'heavy', weight: 0.8, tags: ['calm'], groups: ['replace'],
    ranges: {
      radius: [2, 5, 'int'], spacing: [1, 2, 'int'], saturation: [1, 1.3], canvas: [0.15, 0.45], mix: MIX,
    },
  },
  relief: {
    cost: 'light', weight: 0.8, tags: ['calm'], groups: ['replace'],
    ranges: {
      material: { pick: [0, 1, 2, 3] }, height: { strength: [1.2, 4] }, angle: [0, 1], elevation: [0.3, 0.6], shine: [0.2, 0.5], spread: [1, 2.5], mix: MIX,
    },
    links: { height: 'punch' },
  },
  holo_foil: {
    cost: 'light', weight: 0.6, tags: ['calm'], groups: [],
    ranges: {
      amount: { strength: [0.3, 0.7] }, scale: [1.5, 4], tilt: [0.2, 0.8], shimmer: [0.2, 0.6], sparkle: [0.1, 0.4], mix: MIX,
    },
    links: { scale: 'size' },
  },
  pixel_sort: {
    cost: 'heavy', weight: 0.9, tags: ['lively'], groups: ['replace'],
    ranges: {
      direction: { pick: [0, 1, 2, 3] }, mode: { pick: [0, 1, 2] }, low: [0.25, 0.5], high: [0.85, 1], length: [60, 220, 'int'], mix: MIX,
    },
    links: { length: 'punch' },
  },
  stained_glass: {
    cost: 'medium', weight: 1, tags: ['calm'], groups: ['replace'],
    ranges: {
      cell: [24, 70], jitter: [0.6, 1], lead: [0.25, 0.5], saturation: [1, 1.5], glow: [0.2, 0.6], ripple: [0.1, 0.5], mix: MIX,
    },
    links: { cell: 'size' },
  },
  watercolour: {
    cost: 'medium', weight: 0.8, tags: ['calm'], groups: ['replace'],
    ranges: {
      bleed: { strength: [1.2, 3.5] }, levels: [4, 9, 'int'], edges: [0.4, 0.9], paper: [0.2, 0.6], granulation: [0.2, 0.5], mix: MIX,
    },
    links: { bleed: 'size' },
  },

  /* ---- Glow & Blur ---- */
  bloom: {
    cost: 'medium', weight: 0.5, tags: ['calm'], groups: ['glow'],
    ranges: {
      intensity: { strength: [0.3, 0.8] }, threshold: [0.45, 0.75], radius: [2, 5], softness: [0.4, 0.8], tint_hue: [0, 1], tint: [0, 0.4], blend: 1,
    },
  },
  tilt_shift: {
    cost: 'medium', weight: 0.4, tags: ['calm'], groups: [],
    ranges: {
      mode: { pick: [0, 1] }, focus: [0.35, 0.65], width: [0.2, 0.45], blur: { strength: [2, 7] }, saturation: [1, 1.35],
    },
    links: { blur: 'size' },
  },
  god_rays: {
    cost: 'heavy', weight: 0.6, tags: ['calm'], groups: ['glow'],
    ranges: {
      light_x: [0.3, 0.7], light_y: [0.35, 0.7], length: [0.4, 0.9], decay: [0.95, 0.98], threshold: [0.45, 0.75],
      intensity: { strength: [0.35, 0.8] }, tint_hue: [0, 1], tint: [0.1, 0.4],
    },
    links: { length: 'punch' },
  },
  anamorphic: {
    cost: 'heavy', weight: 0.5, tags: ['lively'], groups: ['glow'],
    ranges: {
      threshold: [0.55, 0.8], length: [0.25, 0.6], intensity: { strength: [0.3, 0.8] }, tint_hue: [0, 1], ghosts: [0.1, 0.4],
    },
  },

  /* ---- Lens & Retro ---- */
  chromatic: {
    cost: 'light', weight: 0.4, tags: ['lively'], groups: [],
    ranges: {
      amount: { strength: [2, 9] }, falloff: [1, 2], mode: { pick: [0, 1] }, angle: [0, 1],
    },
    links: { amount: 'punch' },
  },
  glitch: {
    cost: 'light', weight: 0.7, tags: ['lively'], groups: ['retro'],
    ranges: {
      intensity: { strength: [0.3, 0.9] }, speed: [0.3, 1.2], block_size: [15, 50, 'int'], rgb_shift: [0.4, 1.2],
      static: [0, 0.12], blocks: [0, 0.3], color_swap: 0,
    },
  },
  vhs: {
    cost: 'light', weight: 0.6, tags: ['lively', 'calm'], groups: ['retro'],
    ranges: {
      wobble: [0.2, 0.6], jitter: [0.1, 0.4], tracking: [0.1, 0.35], bleed: [0.3, 0.7], noise: [0.1, 0.35], saturation: [0.75, 1.1],
    },
    links: { wobble: 'size' },
  },
  crt: {
    cost: 'light', weight: 0.6, tags: ['calm', 'lively'], groups: ['retro'],
    ranges: {
      curvature: [0.6, 2], scan_intensity: [0.12, 0.35], vignette: [0.4, 0.8], mask: [0.1, 0.35], flicker: 0, brightness: [1, 1.15],
    },
    links: { curvature: 'punch' },
  },
  ascii: {
    cost: 'light', weight: 1, tags: ['lively'], groups: ['replace'],
    ranges: {
      size: [7, 14], mode: { pick: [0, 1, 2, 3, 4] }, contrast: [1, 1.5], background: [0.04, 0.12], mix: MIX,
    },
  },
  dither: {
    cost: 'light', weight: 0.9, tags: ['lively'], groups: ['replace'],
    ranges: {
      mode: { pick: [1, 2, 3, 4, 5] }, pixel: [1, 3, 'int'], levels: [3, 6, 'int'], dither: [0.6, 1.2], contrast: [1, 1.3], brightness: 0, mix: MIX,
    },
  },
  grain: {
    cost: 'light', weight: 0.3, tags: ['calm', 'lively'], groups: [],
    ranges: {
      intensity: { strength: [0.04, 0.12] }, size: [1, 2.5], colored: [0, 0.6], shadows: [0, 0.6], fps: { pick: [24, 30] },
    },
    links: { size: 'detail' },
  },
});

/** The effects that most enlarge a scene's own frame-to-frame changes of
 *  light: the FX flash check (tests/helpers/visualizer-fx-check.*, 900 runs
 *  on the graphics card) found each adding 0.02 to 0.045 to the steps of
 *  scenes already near 0.07-0.09 (streaks and rays that gather light,
 *  quantising that flips many pixels at once, copies of the picture, grain),
 *  or 0.03 and more alone. A scene marked fxCalm in scenes.js does not get
 *  them from the shuffle, and gets at most FX_CALM_MAX effects. Palette Map
 *  (slice 12) adds 0.03 to 0.065 alone: its palettes turn small changes of
 *  light into larger ones (Kaleidoscope 0.018 to 0.083, Liquid Light 0.007
 *  to 0.074, Mandelbrot 0.014 to 0.075, strong, the most of 9 scenes 0.085). */
export const FX_LIVELY = Object.freeze(new Set([
  'anamorphic', 'color_wash', 'datamosh', 'dither', 'droste', 'edge_glow', 'glitch', 'god_rays', 'grain',
  'mirror', 'palette_map', 'posterize', 'stained_glass', 'swirl', 'vhs',
]));
export const FX_CALM_MAX = 2;

/** What scene `entry` allows of `ids` before the pairs: none on fxNone,
 *  not its fxLeftOut, on a calm one none of FX_LIVELY. */
function sceneKept(entry, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (entry?.fxNone) return [];
  const out = entry?.fxLeftOut;
  const kept = out?.length ? list.filter((id) => !out.includes(id)) : list.slice();
  return entry?.fxCalm ? kept.filter((id) => !FX_LIVELY.has(id)) : kept;
}

/** The effects of `ids` (in their order) scene `entry` draws: none on a
 *  scene marked fxNone; never one the scene leaves out (scenes.js
 *  FX_LEFT_OUT, its fxLeftOut); on a calm one (fxCalm) none of FX_LIVELY and
 *  at most FX_CALM_MAX, the first ones; all the others on any other. Of a
 *  pair that is never combined (FX_CLASHES) only the first in `ids` (the
 *  chain's order) is drawn: the other stays chosen (fxClashedFor). The one
 *  rule for every way effects come (shuffle, by hand, favourites, settings). */
export function fxDrawnFor(entry, ids) {
  const kept = sceneKept(entry, ids);
  const clashed = clashedOut(kept);
  const drawn = clashed.length ? kept.filter((id) => !clashed.includes(id)) : kept;
  return entry?.fxCalm ? drawn.slice(0, FX_CALM_MAX) : drawn;
}

/** The effects of `ids` scene `entry` would draw but for a pair: each one
 *  after another of `ids` it is never combined with (fxDrawnFor). */
export function fxClashedFor(entry, ids) {
  return clashedOut(sceneKept(entry, ids));
}

/** The ids of `catalog` a calm scene may get. */
export function fxCalmIds(catalog) {
  return new Set(catalog.map((fx) => fx.id).filter((id) => !FX_LIVELY.has(id)));
}

/** The ids the FX shuffle may choose from for scene `entry`, or null (any):
 *  `calmIds` (fxCalmIds) on a calm scene, without the ones it leaves out
 *  (fxLeftOut); `catalog` gives every id for a scene that is not calm but
 *  leaves some out. */
export function fxShuffleAllowed(entry, catalog, calmIds) {
  const out = entry?.fxLeftOut || [];
  if (!entry?.fxCalm && !out.length) return null;
  const from = entry?.fxCalm ? [...calmIds] : catalog.map((fx) => fx.id);
  return out.length ? new Set(from.filter((id) => !out.includes(id))) : calmIds;
}

/** Pairs that look like mush together or fight over the same thing (beyond
 *  the groups): never combined. */
export const FX_CLASHES = Object.freeze([
  ['sharpen', 'grain'], // sharpening the grain
  ['sharpen', 'glitch'],
  ['posterize', 'dither'],
  ['posterize', 'halftone'],
  ['crt', 'vision'],
  ['color_wash', 'vision'],
  ['color_grade', 'vision'],
  ['chromatic', 'rgb_echo'],
  ['zoom_blur', 'tilt_shift'],
  ['zoom_blur', 'trails'],
  ['edge_glow', 'posterize'],
  ['bloom', 'led_wall'],
  ['mirror', 'shockwave'],
  // Palette Map with Halftone 0.104 on Plasma, with Fisheye 0.107 on Aurora
  // (strong, flash on); with the other pairs measured 0.085 at most.
  ['palette_map', 'halftone'],
  ['palette_map', 'fisheye'],
]);

const CLASH = new Set(FX_CLASHES.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
export function fxClash(a, b) { return a === b || CLASH.has(`${a}|${b}`); }

/** The ids of `list` that clash with one kept before them (in order). */
function clashedOut(list) {
  const kept = [];
  const out = [];
  for (const id of list) {
    if (kept.some((other) => other !== id && CLASH.has(`${other}|${id}`))) out.push(id);
    else kept.push(id);
  }
  return out;
}

/** A palette's look-up texture data (256 x 1, RGBA bytes), as
 *  Psychedelia's palettes.js bakes it: from its sample() at each texel's
 *  start (which returns that texel exactly). */
export function paletteLut(palettes, index) {
  const data = new Uint8Array(PALETTE_LUT_SIZE * 4);
  for (let i = 0; i < PALETTE_LUT_SIZE; i += 1) {
    const rgb = palettes.sample(index, i / PALETTE_LUT_SIZE);
    data[i * 4] = Math.round(rgb[0] * 255);
    data[i * 4 + 1] = Math.round(rgb[1] * 255);
    data[i * 4 + 2] = Math.round(rgb[2] * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}
export const PALETTE_LUT_SIZE = 256;

/** Names the app shows instead of the library's, where it draws only part of
 *  what that name says. Heat Haze is pinned to its heat-haze mode (mode 0 in
 *  FX_TABLE), so the caustic light the library's name also lists is never
 *  drawn; the shorter name also fits on one line of the effects list. */
export const FX_LABELS = Object.freeze({
  heat_haze: 'Heat Haze',
});

/** The FX the app offers, in the library's own order (the chain's order):
 *  [{ id, label, category, cost, weight, tags, groups, ranges, links, def,
 *  lut }] from the loaded library (`PostFxLibrary`). A pass that samples a
 *  palette (its options.lut: Palette Map) gets `lut(index)`, its look-up
 *  texture data from `palettes` (Psychedelia's PsyPalettes, the same one
 *  the library was given); without them it is not offered. */
export function fxCatalog(library, palettes = null) {
  const list = [];
  for (const def of library?.list?.() || []) {
    const row = FX_TABLE[def.name];
    if (!row || FX_EXCLUDED[def.name]) continue;
    const lut = def.options?.lut ? (typeof palettes?.sample === 'function' ? (index) => paletteLut(palettes, index) : null) : undefined;
    if (lut === null) continue;
    list.push(Object.freeze({
      id: def.name,
      // Shown in American spelling (Watercolor, Acid Colors, Color).
      label: FX_LABELS[def.name] || americanText(def.label),
      category: americanText(def.category),
      cost: row.cost,
      weight: row.weight,
      tags: row.tags,
      groups: row.groups,
      ranges: row.ranges,
      links: row.links || {},
      def,
      ...(lut ? { lut } : {}),
    }));
  }
  return list;
}

/** Order `ids` as the chain draws them (the catalog's order); unknown ids
 *  dropped, duplicates once. */
export function fxOrder(catalog, ids) {
  const wanted = new Set(ids || []);
  return catalog.filter((fx) => wanted.has(fx.id)).map((fx) => fx.id);
}
