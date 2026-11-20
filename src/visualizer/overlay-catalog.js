/**
 * The overlays the Visualizer offers: Canvas 2D layers drawn over (or blended
 * into) the picture. Two sources:
 *
 *   psychedelia  Psychedelia Studio's overlays (vendor/psychedelia/engine/
 *                overlays.js, MIT, same owner; used unchanged apart from the
 *                import PATCHES that let it draw into the app's canvas and
 *                hand its laser beams to the app, overlay-layer.js laserBeam).
 *   ours         written for this app (overlay-patterns.js).
 *
 * This table is ours: which overlays are offered, what each costs (measured,
 * tests/helpers/visualizer-fx-check.py overlay runs), whether it can change
 * the overall light quickly, which blend-ins suit it, which settings are
 * pinned for flash safety, and the ranges the overlay shuffle draws from.
 *
 * Per overlay:
 *   label     as the panel names it
 *   source    'psychedelia' | 'ours'
 *   cost      'light' | 'medium' | 'heavy': the time a frame of it takes on
 *             its sheet (OVERLAY_TOP_MAX_PIXELS, with OVERLAY_QUALITY_LIMITS),
 *             the worse of its defaults and its strongest settings, at Medium
 *             and High on a 1920 x 1080 screen, less the measuring's own wait
 *             (about 0.6 ms; the canvas clear and hand-over stay in): light
 *             up to 1 ms on Medium and 2 on High, medium up to about 2 and 4,
 *             heavy more (measured on the test machine's graphics card,
 *             tests/helpers/visualizer-fx-check.py cost runs). A cost unit
 *             (OVERLAY_COST_UNITS) is so about a millisecond on Medium.
 *   flash     'trigger': it fires on hits (a burst, a flare, a strike); every
 *             firing passes the flash gate (overlay-layer.js), charged to the
 *             flash limiter's one rolling second like a trigger effect.
 *             'steady': it never changes the light quickly by itself.
 *   blends    the blend modes that make sense for it (OVERLAY_BLENDS); 'add'
 *             (drawn on top, as in Psychedelia) always
 *   under     it may go under the effects (most can)
 *   shuffle   the overlay shuffle may pick it (false: by hand only)
 *   moods     (optional) the moods (mood.js) in which the shuffle may pick
 *             it; by hand it can be chosen in any
 *   anchored  (optional) drawn against the screen's edges or its horizontal
 *             lines (a frame, bars, rows, lights hung from an edge): the
 *             sheet holding it never moves (overlay-motion.js): Stage
 *             Lights and Lightning (hung from an edge; the sky at the top),
 *             Matrix Rain (columns from the top edge, upright glyphs),
 *             Vignette, Scanlines, Cinematic's bars, Neon Frame, Spectrum
 *             (on an edge or the middle line) and Contour Lines (level rows
 *             across, like scanlines)
 *   calmPlain (optional) on a calm scene (scenes.js fxCalm) drawn plain on
 *             top only, never blended in
 *   tintFloor (optional) blended in with "Scene colours", the least
 *             saturation the tint may leave it (fx-chain.js): a white or
 *             grey part of the scene never turns it neutral
 *   pins      settings held at one value whatever chose it (light rules)
 *   auto      Psychedelia's "Auto" beat settings, as there (sync on a hit)
 *   ranges    param -> [lo, hi] | [lo, hi, 'int'] | { pick: [...] } for the
 *             shuffle; params not named keep their default
 *
 * Light rules (as the effects', fx-catalog.js): a setting that flickers or
 * strobes the light by itself is pinned off; anything that fires on the music
 * fires only through the flash gate (its "Fire On" is never Free Run, which
 * would fire at random past the gate, and never Drops, which only
 * Psychedelia's Studio sends).
 */

import { OVERLAY_NEW_PATTERNS_RELEASED } from './overlay-patterns.js';

/** Held: two more blend-ins, both calm by construction (fx-chain.js
 *  OVERLAY_BLEND_SRC): Lighten (each channel the brighter of the scene and
 *  the overlay: never more light than Screen adds) and Colour (the overlay's
 *  hue and saturation on the scene's own luminance: no change of light at
 *  all). Added after the others; nothing renumbered. PROPOSED. */
export const OVERLAY_EXTRA_BLENDS_RELEASED = false;
export const OVERLAY_EXTRA_BLENDS = Object.freeze(['lighten', 'colour']);

/** How the overlay is put on the picture. 'add' is Psychedelia's (the canvas
 *  over the picture; its shapes add light). The others blend it into the
 *  picture on the graphics card (fx-chain.js OVERLAY_BLEND_SRC). */
export const OVERLAY_BLENDS = Object.freeze([
  'add', 'screen', 'multiply', 'soft', 'difference', ...(OVERLAY_EXTRA_BLENDS_RELEASED ? OVERLAY_EXTRA_BLENDS : []),
]);
export const OVERLAY_BLEND_LABELS = Object.freeze({
  add: 'Add', screen: 'Screen', multiply: 'Multiply', soft: 'Soft light', difference: 'Difference', lighten: 'Lighten', colour: 'Color',
});
/** Scene shapes the overlay: shown only in the scene's bright or dark areas. */
export const OVERLAY_MASKS = Object.freeze(['none', 'bright', 'dark']);
export const OVERLAY_MASK_LABELS = Object.freeze({ none: 'Everywhere', bright: 'In bright areas', dark: 'In dark areas' });

const ALL = OVERLAY_BLENDS;
const SOFT = Object.freeze(['add', 'screen', 'soft', ...(OVERLAY_EXTRA_BLENDS_RELEASED ? OVERLAY_EXTRA_BLENDS : [])]);
/** Strobe under "Scene colours": at least this saturation (its own is about
 *  0.82), so over white it stays a colour, never a white flash. */
export const STROBE_TINT_FLOOR = 0.6;
const ADD_ONLY = Object.freeze(['add']);
/** Psychedelia's sync choices (its SYNC_TYPES): 1 kick, 2 snare, 4 beat, 5 bar. */
const HITS = Object.freeze({ pick: [1, 2, 4, 5] });
const PALETTE = Object.freeze({
  pick: ['#ff2a6d', '#05d9e8', '#33e0ff', '#ff4fb0', '#b07cff', '#ffd27a', '#7aff9e', '#ff9a3c', '#ffffff', '#6f8bff'],
});
const COLOR_MODE = Object.freeze({ pick: [0, 1, 2] });

/** Held: three more of ours (overlay-patterns.js HELD_OVERLAY_PATTERNS),
 *  steady and calm: the soft blends only. Costs PROPOSED (light, as the
 *  others of ours), to be measured. */
export const HELD_OVERLAY_ROWS = Object.freeze({
  ripples: {
    label: 'Ripples', source: 'ours', category: 'Ours', cost: 'light', flash: 'steady', blends: SOFT, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  fireflies: {
    label: 'Fireflies', source: 'ours', category: 'Ours', cost: 'light', flash: 'steady', blends: SOFT, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.4, 1], speed: [0.4, 1.4] },
  },
  orbits: {
    label: 'Orbits', source: 'ours', category: 'Ours', cost: 'light', flash: 'steady', blends: SOFT, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
});

export const OVERLAY_TABLE = Object.freeze({
  /* ---- Light Show (Psychedelia) ---- */
  lasers: {
    label: 'Lasers', source: 'psychedelia', category: 'Light show', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    // Drawn as beams with their own glow (overlay-layer.js laserBeam): 1.1
    // to 1.3 ms a frame on Medium and High, less than as Psychedelia's lines
    // (1.8 to 4.1). Its own glow stays off: a shadow blur for every beam.
    pins: { laser_flicker: 0, laser_glow: 0 },
    auto: { laser_sync: 1 },
    ranges: {
      laser_count: [3, 10, 'int'], laser_speed: [0.3, 1.6], laser_mode: { pick: [0, 2, 3, 4, 5, 6] }, laser_thickness: [1.5, 4],
      laser_color_mode: COLOR_MODE, laser_color: PALETTE, laser_color2: PALETTE, laser_opacity: [0.6, 0.9], laser_sync: HITS,
    },
  },
  spotlights: {
    label: 'Stage Lights', source: 'psychedelia', category: 'Light show', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true, anchored: true,
    pins: {},
    auto: { spot_sync: 4 },
    ranges: {
      spot_count: [2, 6, 'int'], spot_origin: { pick: [0, 1, 2, 3] }, spot_speed: [0.3, 1], spot_intensity: [0.3, 0.5],
      spot_color_mode: COLOR_MODE, spot_color: PALETTE, spot_color2: PALETTE, spot_sync: HITS,
    },
  },
  lightning: {
    // A sky flash lights the whole picture: kept to Add and Screen, low, and
    // left to a choice by hand (as Psychedelia keeps it out of its shuffle).
    label: 'Lightning', source: 'psychedelia', category: 'Light show', cost: 'medium', flash: 'trigger', blends: Object.freeze(['add', 'screen']), under: true, shuffle: false, anchored: true,
    pins: { bolt_flash: 0.2 },
    auto: { bolt_sync: 2 },
    ranges: { bolt_sync: { pick: [1, 2, 5] } },
  },
  fireworks: {
    label: 'Fireworks', source: 'psychedelia', category: 'Light show', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: { fw_sync: 5 },
    ranges: {
      fw_sync: { pick: [4, 5] }, fw_style: { pick: [0, 1, 2, 3, 4, 5] }, fw_count: [60, 140, 'int'], fw_size: [0.15, 0.3],
      fw_color_mode: { pick: [0, 1, 2, 3] }, fw_color: PALETTE, fw_color2: PALETTE,
    },
  },
  laser_room: {
    label: '3D Laser Room', source: 'psychedelia', category: 'Light show', cost: 'light', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    // No haze: it drew each beam again seven times as wide (8.7 ms a frame on
    // Medium with it, 1.4 ms without).
    pins: { lr_glow: 0, lr_haze: 0 },
    auto: { lr_sync: 1 },
    ranges: {
      lr_style: { pick: [0, 1, 2, 3] }, lr_speed: [0.4, 1.4], lr_count: [6, 14, 'int'], lr_ring_shape: { pick: [0, 1, 2, 3] },
      lr_color_mode: COLOR_MODE, lr_color: PALETTE, lr_color2: PALETTE, lr_sync: HITS,
    },
  },
  /* ---- Shapes (Psychedelia) ---- */
  figures: {
    label: 'Figures', source: 'psychedelia', category: 'Shapes', cost: 'light', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: {},
    ranges: {
      figure_type: { pick: [0, 1, 2, 3, 5, 7, 9, 11] }, figure_count: [1, 6, 'int'], figure_size: [0.15, 0.4], figure_rotation: [-1.5, 1.5],
      figure_layout: { pick: [0, 1, 2, 3] }, figure_color_mode: COLOR_MODE, figure_color: PALETTE, figure_color2: PALETTE,
    },
  },
  rings: {
    label: 'Pulse Rings', source: 'psychedelia', category: 'Shapes', cost: 'light', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: { ring_sync: 1 },
    ranges: {
      ring_sync: HITS, ring_speed: [0.3, 0.8], ring_shape: { pick: [0, 1, 2, 3, 4] }, ring_thickness: [2, 8],
      ring_color_mode: COLOR_MODE, ring_color: PALETTE, ring_color2: PALETTE,
    },
  },
  plexus: {
    label: 'Plexus', source: 'psychedelia', category: 'Shapes', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: { px_glow: 0 },
    auto: {},
    ranges: {
      px_count: [40, 80, 'int'], px_distance: [0.12, 0.22], px_speed: [0.3, 1.2],
      px_color_mode: COLOR_MODE, px_color: PALETTE, px_color2: PALETTE,
    },
  },
  hexgrid: {
    label: 'Tron Hex Grid', source: 'psychedelia', category: 'Shapes', cost: 'heavy', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    // Heavy: about 3.8 ms a frame on Medium and 5 on High with its halo
    // (OVERLAY_HALO), its thin line and fewer, larger cells
    // (OVERLAY_QUALITY_LIMITS; 13 and 21 ms with its own glow and line).
    // Flat only: its Floor in Perspective drew two to three times as much
    // (20 ms a frame on Medium at its usual line, 6 ms at the thinnest).
    pins: { hx_flicker: 0.15, hx_view: 0 },
    auto: { hx_sync: 1 },
    ranges: {
      hx_size: [0.04, 0.09], hx_sync: HITS, hx_scroll: [0, 0.4],
      hx_color_mode: COLOR_MODE, hx_color: PALETTE, hx_color2: PALETTE,
    },
  },
  sacred: {
    label: 'Sacred Geometry', source: 'psychedelia', category: 'Shapes', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: {},
    ranges: {
      sg_shape: { pick: [0, 1, 2, 3, 4, 5, 6] }, sg_cycle: { pick: [1, 2, 3] }, sg_size: [0.45, 0.75], sg_rotation: [-0.3, 0.3],
      sg_color_mode: COLOR_MODE, sg_color: PALETTE, sg_color2: PALETTE,
    },
  },
  frame: {
    label: 'Neon Frame', source: 'psychedelia', category: 'Shapes', cost: 'light', flash: 'steady', blends: SOFT, under: true, shuffle: true, anchored: true,
    pins: {},
    auto: {},
    ranges: {
      frame_style: { pick: [0, 1, 2, 3] }, frame_color_mode: { pick: [0, 1, 2] }, frame_color: PALETTE, frame_color2: PALETTE,
      frame_chase_speed: [0.2, 0.9],
    },
  },
  /* ---- Atmosphere (Psychedelia) ---- */
  particles: {
    label: 'Particles', source: 'psychedelia', category: 'Atmosphere', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: {},
    ranges: {
      particle_count: [30, 120, 'int'], particle_speed: [0.4, 1.6], particle_style: { pick: [0, 1, 2, 3, 4, 5, 6] },
      particle_shape: { pick: [0, 1, 2, 3] }, particle_color_mode: { pick: [0, 1, 2] }, particle_color: PALETTE,
    },
  },
  bokeh: {
    // Its flares (35% of the lights, up to 2.4 times as bright, on a hit) are
    // its steps of light. At its strongest here (32 lights, opacity 0.45):
    // 0.065 at most over plain, every mode over and under, the masks, tint
    // and bend on Voronoi, Starfield, Islamic Stars and Plasma (0.046 on
    // Starfield plain; Plasma's own steps are 0.062). 40 lights at 0.5 gave
    // 0.093 (Starfield, Screen, under the effects).
    label: 'Bokeh Lights', source: 'psychedelia', category: 'Atmosphere', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    pins: {},
    auto: { bk_sync: 1 },
    ranges: {
      bk_count: [20, 32, 'int'], bk_shape: { pick: [0, 1, 2, 3] }, bk_motion: { pick: [0, 1, 2, 3] }, bk_sync: HITS,
      bk_color_mode: { pick: [0, 1, 2, 3] }, bk_color: PALETTE, bk_color2: PALETTE, bk_opacity: [0.3, 0.45],
    },
  },
  matrix: {
    label: 'Matrix Rain', source: 'psychedelia', category: 'Atmosphere', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true, anchored: true,
    // Darken Behind would lay a black veil over the whole picture.
    pins: { mx_dim: 0, mx_glow: 0 },
    auto: { mx_sync: 1 },
    ranges: {
      mx_charset: { pick: [0, 1, 2, 3, 4] }, mx_density: [0.3, 0.6], mx_speed: [0.6, 1.4], mx_sync: HITS,
      mx_color_mode: COLOR_MODE, mx_color: PALETTE, mx_color2: PALETTE,
    },
  },
  vignette: {
    label: 'Vignette', source: 'psychedelia', category: 'Atmosphere', cost: 'light', flash: 'steady', blends: ADD_ONLY, under: true, shuffle: true, anchored: true,
    pins: {},
    auto: {},
    ranges: { vignette_strength: [0.3, 0.6], vignette_size: [0.15, 0.35], vignette_shape: { pick: [0, 1] } },
  },
  scanlines: {
    // Lines scrolled fast shimmer at 15 fps: held to a slow drift.
    label: 'Scanlines', source: 'psychedelia', category: 'Atmosphere', cost: 'light', flash: 'steady', blends: ADD_ONLY, under: true, shuffle: true, anchored: true,
    pins: {},
    auto: {},
    ranges: { scanline_density: [1, 3, 'int'], scanline_opacity: [0.1, 0.25], scanline_speed: [-12, 12], scanline_orientation: { pick: [0, 1, 2] } },
  },
  cinematic: {
    // Letterbox bars and a warm film burn on the bar; the dip to black and
    // the projector flicker change the whole picture's light: pinned off.
    label: 'Cinematic', source: 'psychedelia', category: 'Atmosphere', cost: 'light', flash: 'trigger', blends: ADD_ONLY, under: false, shuffle: true, anchored: true,
    pins: { cn_dip: 0, cn_flicker: 0, cn_burn: 0.35 },
    auto: { cn_burn_sync: 5 },
    ranges: { cn_aspect: { pick: [1, 2, 3, 4] }, cn_burn_sync: { pick: [5] } },
  },
  spectrum: {
    // Steady: its bars follow the music, never a hit. Psychedelia raises them
    // at once with the FFT; at its brightest here (white mirrored bars from
    // the middle, 64 bars, 0.3 high) a kick then stepped the light by up to
    // 0.094 a frame (Starfield, Screen). With its bars rising at most
    // OVERLAY_SPECTRUM_RISE_PER_S (overlay-layer.js): 0.023 at most on
    // Voronoi, Starfield and Islamic Stars over plain, every mode over and
    // under, the masks, tint and bend (0.064 on Plasma, whose own steps are
    // 0.062).
    label: 'Spectrum', source: 'psychedelia', category: 'Audio', cost: 'light', flash: 'steady', blends: ALL, under: true, shuffle: true, anchored: true,
    pins: { spectrum_smoothing: 0.75, spectrum_glow: 0 },
    auto: {},
    ranges: {
      spectrum_style: { pick: [0, 1, 2, 3, 4] }, spectrum_bars: [24, 64, 'int'], spectrum_height: [0.15, 0.3],
      spectrum_position: { pick: [0, 1] }, spectrum_color_mode: { pick: [0, 1, 2] }, spectrum_color: PALETTE, spectrum_opacity: [0.5, 0.8],
    },
  },
  /* ---- Ours (overlay-patterns.js) ---- */
  petals: {
    label: 'Petal Mandala', source: 'ours', category: 'Ours', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  ribbons: {
    label: 'Ribbons', source: 'ours', category: 'Ours', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  dot_spiral: {
    label: 'Dot Spiral', source: 'ours', category: 'Ours', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  contours: {
    // Medium: its halo (OVERLAY_HALO) takes it to about 1.6 ms a frame on
    // Medium and 1.8 on High (0.8 to 0.9 without).
    label: 'Contour Lines', source: 'ours', category: 'Ours', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true, anchored: true,
    pins: {}, auto: {}, ranges: { size: [0.4, 1], speed: [0.4, 1.4] },
  },
  starburst: {
    label: 'Starburst', source: 'ours', category: 'Ours', cost: 'medium', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  tri_grid: {
    label: 'Triangle Grid', source: 'ours', category: 'Ours', cost: 'medium', flash: 'trigger', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.4, 1], speed: [0.4, 1.4] },
  },
  harmonograph: {
    label: 'Harmonograph', source: 'ours', category: 'Ours', cost: 'light', flash: 'steady', blends: ALL, under: true, shuffle: true,
    pins: {}, auto: {}, ranges: { size: [0.5, 1], speed: [0.4, 1.4] },
  },
  color_strobe: {
    // Ours (overlay-patterns.js strobe): a soft coloured pulse on a hit, picked
    // by the shuffle only while the music is energetic. At its strongest
    // (size 1, the green colour, on the kick, peak STROBE_PEAK 0.4), 40 s of
    // hits on each overlay check scene at 752 x 398, every style: plain on
    // top, and Add under, Screen and Soft over and under Bloom: its largest
    // step 0.013 over the scene's own (Islamic Stars, bloom style, plain;
    // 0.027 in all), at most 0.009 with Bloom; Plasma (calm, plain only) no
    // step above its own 0.079. About one hit a second let through the gate
    // (39 of 79), never more than the limiter's three large changes a
    // second. Light: 0.3 to 0.6 ms a frame on Medium and High, as Rings.
    label: 'Strobe', source: 'ours', category: 'Light show', cost: 'light', flash: 'trigger', blends: SOFT, under: true, shuffle: true,
    moods: Object.freeze(['energetic']), calmPlain: true, tintFloor: STROBE_TINT_FLOOR,
    // Its `style` values by name, for the Style choice in the tab (all four
    // were in the measurement above).
    styles: Object.freeze(['From the center', 'From the edges', 'Sweep', 'Halves']),
    pins: {}, auto: {},
    ranges: { size: [0.4, 1], style: { pick: [0, 1, 2, 3] }, sync: HITS, color: { pick: [0, 1, 2, 3, 4, 5] } },
  },
  ...(OVERLAY_NEW_PATTERNS_RELEASED ? HELD_OVERLAY_ROWS : {}),
});

/** Psychedelia overlays not offered, and why. */
export const OVERLAY_EXCLUDED = Object.freeze({
  strobe: 'flashes the whole picture by design (full-screen flashes several times a second; no setting tames it): replaced by ours, color_strobe, a soft coloured pulse',
  text: 'shows words the user types (its default is Psychedelia\'s name); needs a text box, not in this slice',
  lyrics: 'a sequence of the user\'s own lines; needs a text box, not in this slice',
  image_layer: 'the user\'s own picture file; the settings cannot hold a file, not in this slice',
  flash: 'internal (Psychedelia\'s triggerFlash, a white full-screen flash); never offered',
});

export const OVERLAY_COSTS = Object.freeze(['light', 'medium', 'heavy']);
export const OVERLAY_COST_UNITS = Object.freeze({ light: 1, medium: 2, heavy: 4 });
/** Most overlays at once, per quality, and the cost units they may use. */
export const OVERLAY_MAX = 3;
export const OVERLAY_MAX_BY_QUALITY = Object.freeze({ high: 3, medium: 3, low: 2 });
export const OVERLAY_COST_BUDGET = Object.freeze({ high: 6, medium: 5, low: 3 });
/** The heaviest cost class the overlay shuffle offers per quality (with the
 *  scene shuffle's cost filter): no heavy one on Low. */
export const OVERLAY_SHUFFLE_COST_MAX = Object.freeze({ high: 'heavy', medium: 'heavy', low: 'medium' });
/** A blend-in (the canvas uploaded and blended on the graphics card) counts
 *  this much against the cost budget. At most one overlay is blended in at a
 *  time (one texture, one pass). */
export const OVERLAY_BLEND_COST = 1;
/** The blended overlay's canvas, as a share of the picture's drawing size in
 *  each direction, per quality, and at most OVERLAY_BLEND_MAX_PIXELS: its
 *  upload costs about 10 ms per million pixels on the test machine's
 *  graphics card (drawn there or in memory alike), so it is kept to a few
 *  hundred thousand (about 1 ms on Low, 2 on Medium, 3 on High); the blend
 *  pass scales it up (soft edges). */
export const OVERLAY_BLEND_SCALE = Object.freeze({ high: 1, medium: 0.75, low: 0.5 });
export const OVERLAY_BLEND_MAX_PIXELS = Object.freeze({ high: 300000, medium: 200000, low: 130000 });
/** The plain overlays' canvas (the top sheet) at most this many pixels per
 *  quality, in the picture's shape; the browser stretches it over the
 *  picture (CSS). At the picture's own size (up to 2.4 million pixels on
 *  High) one overlay took up to 10 to 25 ms a frame (Tron Hex Grid, 3D Laser
 *  Room); filled and blurred shapes cost about as much as the pixels they
 *  cover. Lines keep their thickness on the picture (OVERLAY_LINE_PARAMS),
 *  thin ones stay sharp enough stretched (looked at on a 1920 x 1080 screen
 *  at each quality: Lasers, Plexus, Hex Grid, Contour Lines). */
export const OVERLAY_TOP_MAX_PIXELS = Object.freeze({ high: 900000, medium: 500000, low: 250000 });

/** Psychedelia's glow (a canvas shadow blur, drawn again for every shape) is
 *  most of an overlay's cost: Plexus 31 ms a frame at Medium's size with its
 *  default glow, 4 ms without. Each overlay's glow setting, scaled per
 *  quality (OVERLAY_GLOW_SCALE: none on any quality now; even a quarter of it
 *  on High left Sacred Geometry at 5.4 to 6.5 ms a frame, 2.5 without). */
export const OVERLAY_GLOW_PARAMS = Object.freeze({
  lasers: 'laser_glow',
  lightning: 'bolt_glow',
  laser_room: 'lr_glow',
  figures: 'figure_glow',
  rings: 'ring_glow',
  plexus: 'px_glow',
  hexgrid: 'hx_glow',
  sacred: 'sg_glow',
  frame: 'frame_glow',
  matrix: 'mx_glow',
  spectrum: 'spectrum_glow',
});
export const OVERLAY_GLOW_SCALE = Object.freeze({ high: 0, medium: 0, low: 0 });

/** Held: "Extra glow", a switch in the panel (off by default). Every sheet
 *  without a line overlay's halo (OVERLAY_HALO_IDS) gets the same halo pass
 *  (overlay-layer.js halo), at `near` and `wide` per quality (null: none).
 *  It moves light rather than adding it: before the glow is laid on, the
 *  sheet itself is faded by the glow's share (near x (1 + wide)), so the
 *  sheet's mean light stays as it was (up to the glow spreading it onto
 *  nearby pixels). Its cost: the halo's, about 0.6 to 1.5 ms a frame, to be
 *  measured. Numbers PROPOSED. */
export const OVERLAY_EXTRA_GLOW_RELEASED = false;
/** The glow's share of the sheet's light (and what the sheet gives up). */
export const extraGlowShare = (look) => (look ? look.near * (1 + (look.wide || 0)) : 0);
export const OVERLAY_EXTRA_GLOW = Object.freeze({
  high: Object.freeze({ near: 0.4, wide: 0.5 }),
  medium: Object.freeze({ near: 0.4, wide: 0.5 }),
  low: null,
});

/** A soft halo for thin-line overlays (their glow without a shadow blur or
 *  a wide line, both drawn on the processor): when a sheet holds one of
 *  OVERLAY_HALO_IDS, the sheet as drawn is shrunk by halvings on the graphics
 *  card and drawn back stretched over it, adding light (overlay-layer.js
 *  halo): `near` the quarter's strength, `wide` the eighth's added to it
 *  (a wider glow; 0: none). The whole sheet gets it (the other overlays on
 *  it too); Medium and High only (null: none). Its time (the cost runs with
 *  and without it, interleaved, the sheet read back so the card's work is in
 *  it): about 0.6 to 1.0 ms a frame on Medium and 0.9 to 1.5 on High, mostly
 *  a fixed cost per image copy whatever its size (so as few copies as this).
 *  Lasers have their own glow instead (overlay-layer.js laserBeam). */
export const OVERLAY_HALO_IDS = Object.freeze(new Set(['hexgrid', 'contours']));
export const OVERLAY_HALO = Object.freeze({
  high: Object.freeze({ near: 1, wide: 1 }),
  medium: Object.freeze({ near: 1, wide: 0 }),
  low: null,
});

/** Psychedelia settings given in canvas pixels (the others scale with the
 *  canvas themselves): on a sheet drawn smaller than the picture
 *  (OVERLAY_TOP_MAX_PIXELS, OVERLAY_BLEND_MAX_PIXELS) they are scaled by the
 *  sheet's share of the picture's height, so a line is as thick on the
 *  picture as it was at the picture's own size. Thinner lines are also much
 *  cheaper: a canvas line up to 1 pixel wide is drawn directly, a wider one
 *  is first turned into a filled outline on the processor. (Lasers' Thickness
 *  is not one: their beams follow the sheet's height themselves,
 *  overlay-layer.js laserBeam.) */
export const OVERLAY_LINE_PARAMS = Object.freeze({
  lightning: Object.freeze(['bolt_thickness']),
  plexus: Object.freeze(['px_line_width', 'px_point_size']),
  figures: Object.freeze(['figure_thickness']),
  rings: Object.freeze(['ring_thickness']),
  frame: Object.freeze(['frame_thickness']),
  spectrum: Object.freeze(['spectrum_thickness']),
});

/** Held: Psychedelia's overlay sizes in pixels follow the picture's height
 *  by the rule our own patterns use (overlay-patterns.js lineScale), which is
 *  also Psychedelia's own rule now (its pixel sizes x the canvas height /
 *  720): one unit is a 720th of the picture's height, and never less than
 *  one of the picture's pixels (a picture under 720 lines keeps today's
 *  sizes). A width is then the same share of the screen at every quality and
 *  window size. Today one unit is one of the picture's pixels, so the same
 *  width is a smaller share of the screen at High than at Low.
 *  Switched on, in a 1920 x 1080 window (pictures 531, 797 and 1063 lines
 *  high), the OVERLAY_LINE_PARAMS widths on the screen: Low as now, Medium
 *  x 1.11, High x 1.48. Particles' Size (OVERLAY_SIZE_720_PARAMS), not
 *  scaled at all today, then follows the same rule: on the plain sheet
 *  smaller dots on Low and Medium (x 0.68 and x 0.71), about the same on
 *  High (x 0.96); blended in (a smaller sheet) about half the size at each.
 *  Not changed: Lasers (their own rule, per 1080 lines of the sheet) and the
 *  overlays that already scale by 720 themselves (3D Laser Room, Matrix, Hex
 *  Grid, Sacred Geometry, Image and Lyrics glow). */
export const OVERLAY_SIZE_720_RELEASED = false;
/** Sizes in pixels that are not scaled at all today, scaled with the switch. */
export const OVERLAY_SIZE_720_PARAMS = Object.freeze({
  particles: Object.freeze(['particle_size']),
});

/** The pixel-size settings of overlay `id` that tune() scales (with the
 *  switch, OVERLAY_SIZE_720_PARAMS too). */
export function overlaySizedParams(id, size720 = OVERLAY_SIZE_720_RELEASED) {
  const lines = OVERLAY_LINE_PARAMS[id] || [];
  const more = size720 ? OVERLAY_SIZE_720_PARAMS[id] || [] : [];
  return more.length ? [...lines, ...more] : lines;
}

/** What a pixel-size setting is multiplied by on a sheet `sheetHeight`
 *  pixels high over a picture `pictureHeight` pixels high: held, the sheet's
 *  share of the picture (at most 1); with the switch, the sheet's height /
 *  min(720, the picture's height). 1 when either is unknown. */
export function overlaySizeUnit(sheetHeight, pictureHeight, size720 = OVERLAY_SIZE_720_RELEASED) {
  const sheet = Number(sheetHeight);
  const picture = Number(pictureHeight);
  if (!(sheet > 0) || !(picture > 0)) return 1;
  return size720 ? sheet / Math.min(720, picture) : Math.min(1, sheet / picture);
}

/** The most (max) or least (min) a setting may be per quality, whatever the
 *  shuffle drew: less work on Medium and Low where an overlay's own drawing
 *  is the cost (measured on the test machine's graphics card; see each).
 *  { id: { param: { max | min: { low, medium, high } } } } */
export const OVERLAY_QUALITY_LIMITS = Object.freeze({
  // Its links are checked for every pair of points (and drawn): the count is
  // the cost.
  plexus: {
    px_count: { max: { low: 40, medium: 50, high: 70 } },
    px_line_width: { max: { low: 1.5, medium: 1.5, high: 1.5 } },
  },
  // A glyph drawn per cell of every trail.
  matrix: {
    mx_size: { min: { low: 36, medium: 34, high: 28 } },
    mx_trail: { max: { low: 7, medium: 7, high: 10 } },
    mx_density: { max: { low: 0.35, medium: 0.35, high: 0.45 } },
  },
  laser_room: { lr_width: { max: { low: 1.6, medium: 1.2, high: 1 } } },
  // The whole grid is one long outline: kept under a pixel wide (its line
  // is Line Width x the canvas height / 720).
  // and its cells are many: fewer, larger ones.
  hexgrid: {
    hx_line: { max: { low: 1.2, medium: 0.8, high: 0.62 } },
    hx_size: { min: { low: 0.09, medium: 0.09, high: 0.08 } },
  },
  // A sprite drawn per particle.
  particles: { particle_count: { max: { low: 60, medium: 80, high: 120 } } },
  lasers: {
    laser_count: { max: { low: 5, medium: 5, high: 8 } },
  },
});

/** "Bend the scene" (the overlay's luminance slope moves the scene's
 *  picture a little: fx-chain.js OVERLAY_BEND_MAX) is offered. */
export const OVERLAY_BEND_OFFERED = true;

/** Blends that turn a hit into a large change of light on a scene already
 *  near the limit (scenes.js fxCalm): left out there, as are the mask and
 *  bending (they make the scene's own steps the overlay's). On a scene marked
 *  fxNone no overlay is blended in (plain on top only). */
export const OVERLAY_LIVELY_BLENDS = Object.freeze(new Set(['multiply', 'difference']));

/** The ids offered (table order). */
export const OVERLAY_IDS = Object.freeze(Object.keys(OVERLAY_TABLE));

/** One overlay's row, or null. */
export const overlayRow = (id) => (Object.prototype.hasOwnProperty.call(OVERLAY_TABLE, id) ? OVERLAY_TABLE[id] : null);

/* ---- The chosen form: { id, blend: { mode, under, mask, tint, bend } } ----
   Saved as a short token: the id, then "~" and the blend-in when there is one:
   the mode's letter (a add, s screen, m multiply, o soft light, d difference),
   then "u" (under the effects), "b" or "k" (mask: bright or dark areas), "t"
   (tinted from the scene), "n" (bends the scene), in that order. */
const MODE_LETTER = Object.freeze({
  add: 'a', screen: 's', multiply: 'm', soft: 'o', difference: 'd', lighten: 'l', colour: 'c',
});
const LETTER_MODE = Object.freeze(Object.fromEntries(Object.entries(MODE_LETTER).map(([mode, letter]) => [letter, mode])));
// Only the letters of the modes offered (held ones are not read back).
const MODE_LETTERS = OVERLAY_BLENDS.map((mode) => MODE_LETTER[mode]).join('');
export const OVERLAY_TOKEN = `[a-z][a-z0-9_]{0,23}(?:~[${MODE_LETTERS}]u?[bk]?t?n?)?`;
const TOKEN = new RegExp(`^([a-z][a-z0-9_]{0,23})(?:~([${MODE_LETTERS}])(u?)([bk]?)(t?)(n?))?$`);

export const PLAIN_BLEND = Object.freeze({ mode: 'add', under: false, mask: 'none', tint: false, bend: false });

/** The blend-in is on: anything other than plain Add on top. */
export function isBlendIn(blend) {
  return Boolean(blend) && (blend.mode !== 'add' || blend.under || blend.mask !== 'none' || blend.tint || blend.bend);
}

export function normalizeBlend(blend) {
  const value = blend || {};
  return {
    mode: OVERLAY_BLENDS.includes(value.mode) ? value.mode : 'add',
    under: value.under === true,
    mask: OVERLAY_MASKS.includes(value.mask) ? value.mask : 'none',
    tint: value.tint === true,
    bend: value.bend === true,
  };
}

export function overlayToken(item) {
  const blend = normalizeBlend(item?.blend);
  if (!isBlendIn(blend)) return item.id;
  return `${item.id}~${MODE_LETTER[blend.mode]}${blend.under ? 'u' : ''}${blend.mask === 'bright' ? 'b' : (blend.mask === 'dark' ? 'k' : '')}${blend.tint ? 't' : ''}${blend.bend ? 'n' : ''}`;
}

/** { id, blend } of a token, or null. */
export function parseOverlayToken(token) {
  const match = typeof token === 'string' ? TOKEN.exec(token) : null;
  if (!match) return null;
  if (!match[2]) return { id: match[1], blend: { ...PLAIN_BLEND } };
  return {
    id: match[1],
    blend: {
      mode: LETTER_MODE[match[2]], under: match[3] === 'u', mask: match[4] === 'b' ? 'bright' : (match[4] === 'k' ? 'dark' : 'none'), tint: match[5] === 't', bend: match[6] === 'n',
    },
  };
}

/** The overlays as `entry` (a scenes.js row) draws them, from a chosen list
 *  [{ id, blend }]: ids this build does not offer dropped, at most OVERLAY_MAX,
 *  at most one blended in (the first; the others drawn plain on top), each
 *  blend-in kept to what the overlay allows and the scene allows (fxNone:
 *  none; fxCalm: no lively blend, no mask, no bending, none at all for one
 *  marked calmPlain). The one rule for every
 *  way overlays come (shuffle, by hand, favourites, settings). */
export function overlaysDrawnFor(entry, list) {
  const out = [];
  let blended = false;
  for (const item of overlayOrder(list)) {
    const row = overlayRow(item?.id);
    if (!row || out.some((other) => other.id === item.id)) continue;
    if (out.length >= OVERLAY_MAX) break;
    let blend = normalizeBlend(item.blend);
    if (!row.blends.includes(blend.mode)) blend = { ...blend, mode: 'add' };
    if (!row.under) blend = { ...blend, under: false };
    if (entry?.fxNone || (entry?.fxCalm && row.calmPlain)) blend = { ...PLAIN_BLEND };
    else if (entry?.fxCalm) {
      blend = {
        ...blend, mode: OVERLAY_LIVELY_BLENDS.has(blend.mode) ? 'add' : blend.mode, mask: 'none', bend: false,
      };
    }
    if (isBlendIn(blend)) {
      if (blended) blend = { ...PLAIN_BLEND };
      else blended = true;
    }
    out.push({ id: item.id, blend });
  }
  return out;
}

/** `list` [{ id, blend }] in the table's order (the order they are drawn in,
 *  so the same set always has one key); unknown ids and repeats dropped. */
export function overlayOrder(list) {
  const items = (Array.isArray(list) ? list : []).filter((item) => overlayRow(item?.id));
  const seen = new Set();
  return items
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort((a, b) => OVERLAY_IDS.indexOf(a.id) - OVERLAY_IDS.indexOf(b.id));
}

/** A sheet holding `items` ([{ id }]) may move (overlay-motion.js): none of
 *  them is anchored to the screen, and there is one. */
export function overlaysMove(items) {
  return Array.isArray(items) && items.length > 0 && items.every((item) => overlayRow(item?.id) && !overlayRow(item.id).anchored);
}

/** The key of a chosen or drawn list ("a+b~su"), '' for none. */
export function overlaysKey(list) {
  return (Array.isArray(list) ? list : []).map(overlayToken).join('+');
}
