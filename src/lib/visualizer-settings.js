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
  return VISUALIZER_QUALITIES.includes(value) ? value : DEFAULT_VISUALIZER_QUALITY;
}

export function visualizerPreset(value) {
  return VISUALIZER_PRESETS[normalizeVisualizerQuality(value)];
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
 *  (visualizer/overlay-catalog.js overlayToken). */
const OVERLAY = '[a-z][a-z0-9_]{0,23}(?:~[asmod]u?[bk]?t?n?)?';
const FAVOURITE = new RegExp(`^([a-z][a-z0-9_]{0,47})(?::([0-9]{1,2}))?(?:[|](${FX_ID}(?:[+]${FX_ID}){0,${VISUALIZER_FX_MAX - 1}}))?(?:[/](${OVERLAY}(?:[+]${OVERLAY}){0,${VISUALIZER_OVERLAY_MAX - 1}}))?$`);
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
 *    visualizerFavourites     see normalizeVisualizerFavourites
 *    visualizerNoticeSeen     the photosensitivity notice was accepted
 *    visualizerFx             post effects on (default off)
 *    visualizerFxShuffle      the FX shuffle picks them (default on)
 *    visualizerFxIntensity    'subtle' | 'normal' | 'strong'
 *    visualizerFxTiming       'scene' | 4 | 8 | 16 bars
 *    visualizerFxFlash        the global beat flash, limited (default off)
 *    visualizerFxSet          the effects chosen by hand (ids)
 *    visualizerOverlays       overlays on (default off)
 *    visualizerOverlayShuffle the overlay shuffle picks them (default on)
 *    visualizerOverlaySet     the overlays chosen by hand (saved tokens) */
export function normalizeVisualizerExtras(source = {}) {
  const value = source || {};
  const bars = Number(value.visualizerShuffleBars);
  return {
    visualizerPanelOpen: value.visualizerPanelOpen === true,
    visualizerShuffle: value.visualizerShuffle === true,
    visualizerShufflePool: VISUALIZER_SHUFFLE_POOLS.includes(value.visualizerShufflePool) ? value.visualizerShufflePool : 'all',
    visualizerShuffleCost: VISUALIZER_SHUFFLE_COSTS.includes(value.visualizerShuffleCost)
      ? value.visualizerShuffleCost : DEFAULT_VISUALIZER_SHUFFLE_COST,
    visualizerShuffleBars: VISUALIZER_SHUFFLE_BARS.includes(bars) ? bars : DEFAULT_VISUALIZER_SHUFFLE_BARS,
    visualizerFavourites: normalizeVisualizerFavourites(value.visualizerFavourites),
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
    visualizerOverlaySet: normalizeVisualizerOverlaySet(value.visualizerOverlaySet),
  };
}
