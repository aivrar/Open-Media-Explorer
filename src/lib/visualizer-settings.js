/**
 * Settings of the Visualizer tab (modes/visualizer.js, visualizer/).
 *
 * Quality sets only how sharp the picture is (how many pixels it is drawn
 * with):
 *   scale      share of the tab's device pixels in each direction
 *   maxPixels  cap on width x height after scaling (big or high-DPI screens)
 * Frame rate is its own choice (15, 30 or 60 frames a second while sound is
 * playing). While nothing can be heard the picture moves on at
 * VISUALIZER_IDLE_FPS for VISUALIZER_IDLE_SECONDS, then holds still.
 * Brightness (30-100 %) dims the whole picture (the canvas's opacity over a
 * black backing, so it costs nothing per frame).
 *
 * All of them live in the settings object (`visualizerQuality`,
 * `visualizerFps`, `visualizerBrightness`, `visualizerScene`,
 * `visualizerShowFps`, `visualizerDebug`, `visualizerLooks`, and those of
 * normalizeVisualizerExtras: panel, shuffle, favourites, notice) inside the one
 * saved settings value
 * (worldmedia.settings.v1), like `tunerCardSize` and `soundMeter`. They are
 * not new storage or profile keys: every release since 0.1.0 keeps settings
 * fields it does not know (state.js normalizeSettings spreads the saved
 * object), so an older build leaves them alone and they come back on return.
 * This file is small on purpose: it is in the main bundle, the visualizer
 * itself (with its list of scenes) is loaded only when its tab is opened.
 */

export const VISUALIZER_QUALITY_LOW = 'low';
export const VISUALIZER_QUALITY_MEDIUM = 'medium';
export const VISUALIZER_QUALITY_HIGH = 'high';
export const VISUALIZER_QUALITIES = Object.freeze([
  VISUALIZER_QUALITY_LOW, VISUALIZER_QUALITY_MEDIUM, VISUALIZER_QUALITY_HIGH,
]);
export const DEFAULT_VISUALIZER_QUALITY = VISUALIZER_QUALITY_MEDIUM;
/** Very high: offered at the Balanced and High Processor use levels only
 *  (the Processor use extras). Every per-quality table uses High's
 *  row at Very high (tableQuality); only the pixel budget is larger. */
export const VISUALIZER_QUALITY_VERY_HIGH = 'very_high';
/** Every quality a setting may hold, lowest first. */
export const VISUALIZER_ALL_QUALITIES = Object.freeze([...VISUALIZER_QUALITIES, VISUALIZER_QUALITY_VERY_HIGH]);
/** Very high's picture: every device pixel, up to twice High's budget. */
export const VISUALIZER_VERY_HIGH_PRESET = Object.freeze({ label: 'Very high', scale: 1, maxPixels: 4800000 });
/** The measured frame-rate readout is off until turned on in the tab. */
export const DEFAULT_VISUALIZER_SHOW_FPS = false;
/** The developer strip (sound values the scenes get) is off unless asked for. */
export const DEFAULT_VISUALIZER_DEBUG = false;

export const VISUALIZER_PRESETS = Object.freeze({
  [VISUALIZER_QUALITY_LOW]: Object.freeze({ label: 'Low', scale: 0.5, maxPixels: 600000 }),
  [VISUALIZER_QUALITY_MEDIUM]: Object.freeze({ label: 'Medium', scale: 0.75, maxPixels: 1200000 }),
  [VISUALIZER_QUALITY_HIGH]: Object.freeze({ label: 'High', scale: 1, maxPixels: 2400000 }),
});

/** Frames a second while sound is playing. */
export const VISUALIZER_FRAME_RATES = Object.freeze([15, 30, 60]);
export const DEFAULT_VISUALIZER_FPS = 30;

/** Brightness in percent: the slider's range, step and starting value. */
export const VISUALIZER_BRIGHTNESS_MIN = 30;
export const VISUALIZER_BRIGHTNESS_MAX = 100;
export const VISUALIZER_BRIGHTNESS_STEP = 5;
export const DEFAULT_VISUALIZER_BRIGHTNESS = 100;

/** The scene shown first. The list of scenes is in the visualizer chunk
 *  (visualizer/scenes.js); here a saved id is only checked for its shape, so
 *  a scene a later build adds survives a trip through this one. */
export const DEFAULT_VISUALIZER_SCENE = 'plasma';
const SCENE_ID = /^[a-z][a-z0-9_]{0,47}$/;

/** Frames a second while paused, stopped, muted or silent. */
export const VISUALIZER_IDLE_FPS = 5;
/** How long a spell without sound keeps moving (seconds); after that the
 *  last picture is held and nothing is scheduled until sound comes back. */
export const VISUALIZER_IDLE_SECONDS = 20;

export function normalizeVisualizerQuality(value) {
  return VISUALIZER_ALL_QUALITIES.includes(value) ? value : DEFAULT_VISUALIZER_QUALITY;
}

/** The quality whose rows of the per-quality tables apply: High's at Very high. */
export function tableQuality(value) {
  const quality = normalizeVisualizerQuality(value);
  return quality === VISUALIZER_QUALITY_VERY_HIGH ? VISUALIZER_QUALITY_HIGH : quality;
}

export function visualizerPreset(value) {
  const quality = normalizeVisualizerQuality(value);
  return quality === VISUALIZER_QUALITY_VERY_HIGH ? VISUALIZER_VERY_HIGH_PRESET : VISUALIZER_PRESETS[quality];
}

/** 15, 30 or 60 (a number, or the same number as text from a form field). */
export function normalizeVisualizerFps(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return VISUALIZER_FRAME_RATES.includes(number) ? number : DEFAULT_VISUALIZER_FPS;
}

/** A whole percent from 30 to 100 (out of range: the nearest end; not a
 *  number: 100). */
export function normalizeVisualizerBrightness(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return DEFAULT_VISUALIZER_BRIGHTNESS;
  const whole = Math.round(number);
  return Math.min(VISUALIZER_BRIGHTNESS_MAX, Math.max(VISUALIZER_BRIGHTNESS_MIN, whole));
}

export function normalizeVisualizerScene(value) {
  return typeof value === 'string' && SCENE_ID.test(value) ? value : DEFAULT_VISUALIZER_SCENE;
}

/** Looks chosen by hand (`visualizerLooks`): { sceneId: look number }, kept
 *  only for scenes whose look differs from the one they start with. The
 *  scene's list of looks is in the visualizer chunk (visualizer/looks.js);
 *  here only the shape is checked, as for the scene id. */
export const VISUALIZER_LOOKS_MAX_SCENES = 128;
export const VISUALIZER_LOOK_MAX = 63;

export function normalizeVisualizerLooks(value) {
  const looks = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return looks;
  let count = 0;
  for (const [id, look] of Object.entries(value)) {
    if (count >= VISUALIZER_LOOKS_MAX_SCENES) break;
    if (!SCENE_ID.test(id) || !Number.isInteger(look) || look < 0 || look > VISUALIZER_LOOK_MAX) continue;
    looks[id] = look;
    count += 1;
  }
  return looks;
}

/** Favourites (`visualizerFavourites`): starred scene + look + post effects,
 *  oldest first, each a short string: "sceneId" for a scene without looks,
 *  else "sceneId:look", then "|fx+fx" when post effects were on (at most
 *  VISUALIZER_FX_MAX of them, in the chain's order), then "/ov+ov" when
 *  overlays were on (saved tokens, overlay-catalog.js overlayToken, in the
 *  table's order). Strings without effects or overlays (all from before they
 *  existed) stay as they are. At most
 *  VISUALIZER_FAVOURITES_MAX; visualizer/favourites.js makes room when a new
 *  one is starred. */
export const VISUALIZER_FAVOURITES_MAX = 128;
/** Most post effects on at once (visualizer/fx-shuffle.js FX_MAX_ACTIVE). */
export const VISUALIZER_FX_MAX = 3;
/** Most overlays at once (visualizer/overlay-catalog.js OVERLAY_MAX). */
export const VISUALIZER_OVERLAY_MAX = 3;
const FX_ID = '[a-z][a-z0-9_]{0,23}';
/** An overlay as saved: its id, then "~" and its blend-in when it has one
 *  (visualizer/overlay-catalog.js overlayToken). Only the shape is checked
 *  here: any letters after the "~" are kept, so a blend-in this build does
 *  not know (from a later one) costs only that blend-in, never the overlay
 *  set or the favourite: the Visualizer reads such an overlay as drawn
 *  plain, and drops an overlay whose id it does not have
 *  (overlay-catalog.js readOverlayToken, overlaysDrawnFor). */
const OVERLAY = '[a-z][a-z0-9_]{0,23}(?:~[a-z0-9]{1,8})?';
const favouritePattern = (overlay) => new RegExp(`^([a-z][a-z0-9_]{0,47})(?::([0-9]{1,2}))?(?:[|](${FX_ID}(?:[+]${FX_ID}){0,${VISUALIZER_FX_MAX - 1}}))?(?:[/](${overlay}(?:[+]${overlay}){0,${VISUALIZER_OVERLAY_MAX - 1}}))?$`);
const FAVOURITE = favouritePattern(OVERLAY);
const overlayIdOf = (token) => token.split('~')[0];

/** { scene, look, fx, overlays } of a favourite's string, or null (look:
 *  null for none; fx and overlays: [] for none; overlays as saved tokens).
 *  Favourites from before overlays (no "/" part) read as no overlays. */
export function parseVisualizerFavourite(value) {
  const match = typeof value === 'string' ? FAVOURITE.exec(value) : null;
  if (!match) return null;
  const look = match[2] === undefined ? null : Number(match[2]);
  if (look !== null && look > VISUALIZER_LOOK_MAX) return null;
  const fx = match[3] === undefined ? [] : match[3].split('+');
  if (new Set(fx).size !== fx.length) return null;
  const overlays = match[4] === undefined ? [] : match[4].split('+');
  if (new Set(overlays.map(overlayIdOf)).size !== overlays.length) return null;
  return {
    scene: match[1], look, fx, overlays,
  };
}

export function normalizeVisualizerFavourites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= VISUALIZER_FAVOURITES_MAX) break;
    if (parseVisualizerFavourite(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/** Scene shuffle. `visualizerShuffle` is on or off (the overlay button);
 *  what it draws from, which scenes by cost and how often it changes are
 *  remembered apart, so turning it off and on keeps them. */
export const VISUALIZER_SHUFFLE_POOLS = Object.freeze(['all', 'favourites']);
export const VISUALIZER_SHUFFLE_COSTS = Object.freeze(['light', 'medium', 'all']);
export const DEFAULT_VISUALIZER_SHUFFLE_COST = 'medium'; // light and medium scenes
export const VISUALIZER_SHUFFLE_BARS = Object.freeze([8, 16, 32]);
export const DEFAULT_VISUALIZER_SHUFFLE_BARS = 16;

/** Post effects (visualizer/fx-chain.js). Off unless switched on; when on,
 *  shuffled by default, changing with the scene. */
export const VISUALIZER_FX_INTENSITIES = Object.freeze(['subtle', 'normal', 'strong']);
export const DEFAULT_VISUALIZER_FX_INTENSITY = 'normal';
/** When the FX shuffle changes them: with each scene, or every N bars. */
export const VISUALIZER_FX_TIMINGS = Object.freeze(['scene', 4, 8, 16]);
export const DEFAULT_VISUALIZER_FX_TIMING = 'scene';

/** The post effects chosen by hand (ids, at most VISUALIZER_FX_MAX). */
export function normalizeVisualizerFxSet(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const id = new RegExp(`^${FX_ID}$`);
  for (const item of value) {
    if (out.length >= VISUALIZER_FX_MAX) break;
    if (typeof item === 'string' && id.test(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/** The overlays chosen by hand (saved tokens, at most VISUALIZER_OVERLAY_MAX,
 *  one per overlay). */
export function normalizeVisualizerOverlaySet(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const token = new RegExp(`^${OVERLAY}$`);
  for (const item of value) {
    if (out.length >= VISUALIZER_OVERLAY_MAX) break;
    if (typeof item === 'string' && token.test(item) && !out.some((other) => overlayIdOf(other) === overlayIdOf(item))) out.push(item);
  }
  return out;
}

/* ---- A visit to release 0.1.12 and back ----
   Release 0.1.12 reads `visualizerFavourites` and `visualizerOverlaySet`
   more strictly than this build. A blend-in letter other than a, s, m, o or
   d (Lighten "l" and Color "c" are newer) makes it drop the whole favourite,
   and that overlay of the set, the next time it saves any setting; an
   overlay it does not have (Ripples, Fireflies, Orbits) is taken out of a
   favourite when its Visualizer tab opens, which saves the changed list at
   once. So those two fields hold only what 0.1.12 reads as it is, and the
   whole of each is kept beside them in a field of its own, which 0.1.12
   keeps untouched (its normalizeSettings keeps every field it does not
   know; none of these is a storage or profile key):
     visualizerFavouritesAll   every favourite, in the user's order
     visualizerOverlaySetAll   the whole overlay set
   Here (normalizeVisualizerExtras, with no list of scenes or overlays)
   only the split is kept: the favourites field holds only those 0.1.12
   reads, and a newer one found in it goes to the copy. The two lists are
   put together by the Visualizer when it opens (visualizer/favourites.js
   favouritesFromSaved): 0.1.12's tab rewrites a favourite it reads into the
   form it draws (overlays in the table's order, a blend-in the scene or
   overlay does not allow left out, two that become the same merged), so
   they are compared in that form, which this build's tab gives every
   favourite 0.1.12 reads in the same way. The whole overlay set is used
   only while the field still holds the part of it this build wrote beside
   it, so a set chosen in 0.1.12 wins over the copy (0.1.12 does not
   rewrite the set when its tab opens). Extra glow
   (visualizerOverlayGlow) and drift (visualizerDrift) are plain switches
   that 0.1.12 keeps as they are, and the three newer overlays have no Style
   (visualizerOverlayStyles), so nothing else needs a copy. */

/** The overlays release 0.1.12 has (its overlay-catalog.js OVERLAY_IDS). */
const RELEASE_0_1_12_OVERLAY_IDS = Object.freeze(new Set([
  'lasers', 'spotlights', 'lightning', 'fireworks', 'laser_room', 'figures', 'rings', 'plexus', 'hexgrid', 'sacred',
  'frame', 'particles', 'bokeh', 'matrix', 'vignette', 'scanlines', 'cinematic', 'spectrum', 'petals', 'ribbons',
  'dot_spiral', 'contours', 'starburst', 'tri_grid', 'harmonograph', 'color_strobe',
]));
/** An overlay token as release 0.1.12 checks it (its five blend letters). */
const RELEASE_0_1_12_OVERLAY = '[a-z][a-z0-9_]{0,23}(?:~[asmod]u?[bk]?t?n?)?';
const RELEASE_0_1_12_TOKEN = new RegExp(`^${RELEASE_0_1_12_OVERLAY}$`);
const RELEASE_0_1_12_FAVOURITE = favouritePattern(RELEASE_0_1_12_OVERLAY);

/** Release 0.1.12 reads overlay token `token` as it is (its form, one of its
 *  overlays) and keeps it. */
export function olderReleaseReadsOverlay(token) {
  return typeof token === 'string' && RELEASE_0_1_12_TOKEN.test(token) && RELEASE_0_1_12_OVERLAY_IDS.has(overlayIdOf(token));
}

/** Release 0.1.12 keeps favourite `value` (its form, only its overlays and
 *  blend-ins). Its Visualizer tab may still rewrite it into the form it
 *  draws, which is the form this build's tab gives it too (the same scene,
 *  effect and overlay rules for everything 0.1.12 has). */
export function olderReleaseReadsFavourite(value) {
  const entry = parseVisualizerFavourite(value);
  return Boolean(entry) && RELEASE_0_1_12_FAVOURITE.test(value) && entry.overlays.every(olderReleaseReadsOverlay);
}

/** The two saved favourites fields, split (see above): `older`
 *  (visualizerFavourites) keeps only those 0.1.12 reads; `all`
 *  (visualizerFavouritesAll) is the copy, or `older` itself when there is
 *  none, with any newer favourite found in `older` added at its end (at
 *  most VISUALIZER_FAVOURITES_MAX, the oldest going). Nothing is taken off
 *  here: what 0.1.12 changed is worked out when the Visualizer opens. */
export function visualizerFavouriteFields(older, all) {
  const kept = normalizeVisualizerFavourites(older);
  const whole = Array.isArray(all) ? normalizeVisualizerFavourites(all) : kept.slice();
  for (const item of kept) {
    if (!olderReleaseReadsFavourite(item) && !whole.includes(item)) whole.push(item);
  }
  return {
    visualizerFavourites: kept.filter(olderReleaseReadsFavourite),
    visualizerFavouritesAll: whole.length > VISUALIZER_FAVOURITES_MAX ? whole.slice(whole.length - VISUALIZER_FAVOURITES_MAX) : whole,
  };
}

/** The whole overlay set from the two saved fields: `all`
 *  (visualizerOverlaySetAll) while `older` (visualizerOverlaySet) still
 *  holds the part of it 0.1.12 reads, else `older`. */
export function mergedVisualizerOverlaySet(older, all) {
  const kept = normalizeVisualizerOverlaySet(older);
  if (!Array.isArray(all)) return kept;
  const whole = normalizeVisualizerOverlaySet(all);
  const part = whole.filter(olderReleaseReadsOverlay);
  return part.length === kept.length && part.every((token, index) => token === kept[index]) ? whole : kept;
}

/** The settings that save favourites `list` (the whole list, in order):
 *  the part 0.1.12 reads in its field, the whole list beside it. */
export function visualizerFavouritesToSave(list) {
  const all = normalizeVisualizerFavourites(list);
  return { visualizerFavourites: all.filter(olderReleaseReadsFavourite), visualizerFavouritesAll: all };
}

/** The settings that save the overlay set `set` (saved tokens): as for
 *  favourites. */
export function visualizerOverlaySetToSave(set) {
  const all = normalizeVisualizerOverlaySet(set);
  return { visualizerOverlaySet: all.filter(olderReleaseReadsOverlay), visualizerOverlaySetAll: all };
}

/** Most overlays with a Style picked by hand that are kept, and the most
 *  styles an overlay may have. */
export const VISUALIZER_OVERLAY_STYLES_MAX = 32;
export const VISUALIZER_OVERLAY_STYLE_COUNT_MAX = 16;

/** The overlays' Style choices picked by hand: { overlay id: style index }.
 *  Anything else is dropped (a missing or unknown one reads as Any; the
 *  Visualizer also drops an index its overlay does not have). */
export function normalizeVisualizerOverlayStyles(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let count = 0;
  for (const [id, style] of Object.entries(value)) {
    if (count >= VISUALIZER_OVERLAY_STYLES_MAX) break;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) continue;
    if (!Number.isInteger(style) || style < 0 || style >= VISUALIZER_OVERLAY_STYLE_COUNT_MAX) continue;
    out[id] = style;
    count += 1;
  }
  return out;
}

/** The sections of the Visualizer's side panel, in its order. */
export const VISUALIZER_PANEL_SECTIONS = Object.freeze(['scene', 'shuffle', 'fx', 'ov', 'picture']);

/** The side panel's folded sections: known ids, each once, in the panel's
 *  order. Anything else is dropped (none: every section open). */
export function normalizeVisualizerFolded(value) {
  if (!Array.isArray(value)) return [];
  return VISUALIZER_PANEL_SECTIONS.filter((id) => value.includes(id));
}

function normalizeFxTiming(value) {
  if (value === 'scene') return 'scene';
  const bars = Number(value);
  return VISUALIZER_FX_TIMINGS.includes(bars) ? bars : DEFAULT_VISUALIZER_FX_TIMING;
}

/** The Visualizer settings added with the side panel, shuffle, favourites
 *  and the photosensitivity notice, normalised from `source` (state.js
 *  spreads these into the settings object):
 *    visualizerPanelOpen      the side panel is open (default closed)
 *    visualizerShuffle        scene shuffle on (default off)
 *    visualizerShufflePool    'all' | 'favourites'
 *    visualizerShuffleCost    'light' | 'medium' (light and medium) | 'all'
 *    visualizerShuffleBars    8 | 16 | 32 bars between changes
 *    visualizerFavourites     see normalizeVisualizerFavourites; only the
 *                             ones release 0.1.12 reads as they are
 *    visualizerFavouritesAll  every favourite, in order, as this build
 *                             last saved them (with the field above:
 *                             visualizer/favourites.js favouritesFromSaved)
 *    visualizerNoticeSeen     the photosensitivity notice was accepted
 *    visualizerFx             post effects on (default off)
 *    visualizerFxShuffle      the FX shuffle picks them (default on)
 *    visualizerFxIntensity    'subtle' | 'normal' | 'strong'
 *    visualizerFxTiming       'scene' | 4 | 8 | 16 bars
 *    visualizerFxFlash        the global beat flash, limited (default off)
 *    visualizerFxSet          the effects chosen by hand (ids)
 *    visualizerOverlays       overlays on (default off)
 *    visualizerOverlayShuffle the overlay shuffle picks them (default on)
 *    visualizerOverlaySet     the overlays chosen by hand (saved tokens) that
 *                             release 0.1.12 reads as they are
 *    visualizerOverlaySetAll  the whole set chosen by hand
 *                             (mergedVisualizerOverlaySet)
 *    visualizerOverlayGlow    "Extra glow" on the overlays (default off)
 *    visualizerOverlayStyles  the overlays' Style picked by hand
 *                             ({ id: index }; none: Any)
 *    visualizerDrift          slow drift of the scene's, the effects' and
 *                             the overlays' settings (drift.js,
 *                             overlay-drift.js; default on)
 *    visualizerFolded         the side panel's folded sections (default
 *                             none: every section open) */
export function normalizeVisualizerExtras(source = {}) {
  const value = source || {};
  const bars = Number(value.visualizerShuffleBars);
  const favourites = visualizerFavouriteFields(value.visualizerFavourites, value.visualizerFavouritesAll);
  const overlaySet = visualizerOverlaySetToSave(mergedVisualizerOverlaySet(value.visualizerOverlaySet, value.visualizerOverlaySetAll));
  return {
    visualizerPanelOpen: value.visualizerPanelOpen === true,
    visualizerShuffle: value.visualizerShuffle === true,
    visualizerShufflePool: VISUALIZER_SHUFFLE_POOLS.includes(value.visualizerShufflePool) ? value.visualizerShufflePool : 'all',
    visualizerShuffleCost: VISUALIZER_SHUFFLE_COSTS.includes(value.visualizerShuffleCost)
      ? value.visualizerShuffleCost : DEFAULT_VISUALIZER_SHUFFLE_COST,
    visualizerShuffleBars: VISUALIZER_SHUFFLE_BARS.includes(bars) ? bars : DEFAULT_VISUALIZER_SHUFFLE_BARS,
    ...favourites,
    visualizerNoticeSeen: value.visualizerNoticeSeen === true,
    visualizerFx: value.visualizerFx === true,
    visualizerFxShuffle: value.visualizerFxShuffle !== false,
    visualizerFxIntensity: VISUALIZER_FX_INTENSITIES.includes(value.visualizerFxIntensity)
      ? value.visualizerFxIntensity : DEFAULT_VISUALIZER_FX_INTENSITY,
    visualizerFxTiming: normalizeFxTiming(value.visualizerFxTiming),
    visualizerFxFlash: value.visualizerFxFlash === true,
    visualizerFxSet: normalizeVisualizerFxSet(value.visualizerFxSet),
    visualizerOverlays: value.visualizerOverlays === true,
    visualizerOverlayShuffle: value.visualizerOverlayShuffle !== false,
    ...overlaySet,
    visualizerOverlayGlow: value.visualizerOverlayGlow === true,
    visualizerOverlayStyles: normalizeVisualizerOverlayStyles(value.visualizerOverlayStyles),
    // Only an explicit false turns it off.
    visualizerDrift: value.visualizerDrift !== false,
    visualizerColorTravel: value.visualizerColorTravel !== false,
    visualizerFolded: normalizeVisualizerFolded(value.visualizerFolded),
  };
}
