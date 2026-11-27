/**
 * Central app state. The only place mutable globals live.
 *
 * State shape:
 * {
 *   mode: 'library' | 'tuner' | 'grid' | 'discovery' | 'now-playing' | 'visualizer' | 'about',
 *   currentItem: Item | null,
 *   currentStream: the upstream candidate selected for currentItem, or null,
 *   isPlaying: bool,
 *   favorites: Item[],
 *   settings: {
 *     theme: 'system' | 'light' | 'dark' | 'midnight' | 'forest' | 'ember' | 'amethyst',
 *     defaultMode: string,
 *     tabsShown: Record<mode, bool>,
 *     recordingEnabled: bool,
 *     enabledSources: Record<adapterId, bool>,
 *     showExplicitContent: bool,
 *     tunerFavoritesOnly: bool,
 *     tunerToneKnobs: bool,
 *     tunerStations: bool,
 *     showTechnicalDetails: bool,
 *     videoSize: 'normal' | 'large',
 *     favoritesSort: 'manual' | 'name',   // "My order" (stored order) or "A-Z"
 *     tunerCardSize: 'small' | 'medium' | 'large',   // Tuner strip cards (tuner-card-size.js)
 *     nowPlayingBackgroundBlur: 'off' | 'light' | 'medium' | 'strong',
 *     soundMeter: bool,   // LED sound meter in the player bar (player-meter.js), default on
 *     bestStreamMode: 'off' | 'listed' | 'auto',   // "Pick the best stream" (best-stream.js), default 'listed'
 *     processorUse: 'light' | 'balanced' | 'high',   // Processor use (processor-budget.js), default 'light'
 *     processorLimit: number | null,   // its limit, 2-80 (%), null: the level's preset
 *     visualizerQuality: 'low' | 'medium' | 'high',   // Visualizer picture sharpness (visualizer-settings.js)
 *     visualizerFps: 15 | 30 | 60,   // Visualizer frames a second while sound plays, default 30
 *     visualizerBrightness: number,   // Visualizer brightness, 30-100 (%), default 100
 *     visualizerScene: string,   // last Visualizer scene id, default 'plasma'
 *     visualizerShowFps: bool,   // measured frame-rate readout in the Visualizer tab, default off
 *     visualizerQualityPicked: bool,   // a Visualizer quality was picked by hand, default off
 *     visualizerShuffleCostPicked: bool,   // the shuffle's cost filter was picked by hand, default off
 *     tunerVisualizerBackground: bool,   // the dimmed Visualizer behind the Tuner (lib/tuner-background.js), default off
 *     tunerVisualizerLevel: number,   // how strongly it shows, 1-100 (% opacity), kept while it is off, default 8
 *     visualizerDebug: bool,   // developer strip with the sound values, default off
 *     visualizerLooks: object,   // Visualizer look chosen per scene, { sceneId: number }, default {}
 *     visualizerPanelOpen, visualizerShuffle, visualizerShufflePool, visualizerShuffleCost,
 *     visualizerShuffleBars, visualizerFavourites, visualizerNoticeSeen: see normalizeVisualizerExtras
 *   },
 *   sleepTimer: { until: number | null }
 * }
 */

import { isRetiredSource, SOURCE_IDS } from './sources.js';
import { makeItem } from './item-model.js';
import { clearStreamLookups } from './stream-lookups.js';
import { DEFAULT_BEST_STREAM_MODE, bestStreamMode } from './best-stream.js';
import { DEFAULT_PROCESSOR_USE, normalizeProcessorLimit, normalizeProcessorUse } from './processor-budget.js';
import { clearStreamVerifications } from './stream-verify.js';
import { clearDidNotPlayCache } from './did-not-play.js';
import { EXTRA_SETTINGS_STORAGE_KEY, PICTURE_STORAGE_KEY } from './profile-storage.js';
import { clearPlayedStreams } from './played-streams.js';
import {
  loadEqState, getEffectiveEq, persistFavoriteEq, deleteFavoriteEq, clearEqState,
  addFavoritesEq, EQ_EXTRA_STORAGE_KEY, EQ_STORAGE_KEY, isEqStation, saveEqState,
} from './eq-store.js';
import { DEFAULT_RECORDING_QUALITY, normalizeRecordingQuality } from './recording-profiles.js';
import { repairFiniteMediaFields } from './media-capabilities.js';
import { applyTheme, normalizeTheme } from './themes.js';
import { FAVORITES_SORT_MANUAL, favoritesInDisplayOrder, normalizeFavoritesSort } from './favorites-order.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';
import { TUNER_CARD_SMALL, normalizeTunerCardSize } from './tuner-card-size.js';
import { normalizeTabsShown } from './top-tabs.js';
import {
  DEFAULT_VISUALIZER_BRIGHTNESS, DEFAULT_VISUALIZER_DEBUG, DEFAULT_VISUALIZER_FPS, DEFAULT_VISUALIZER_QUALITY,
  DEFAULT_VISUALIZER_SCENE, DEFAULT_VISUALIZER_SHOW_FPS, normalizeVisualizerBrightness, normalizeVisualizerFps,
  normalizeVisualizerQuality, normalizeVisualizerScene, normalizeVisualizerLooks, normalizeVisualizerExtras,
} from './visualizer-settings.js';
import { TUNER_BACKGROUND_DEFAULT_LEVEL, normalizeTunerBackgroundLevel } from './tuner-background.js';
import { songLog } from './song-log.js';
import { FAVORITE_NAMES_KEY, withoutFavoriteName } from './favorite-names.js';
import { removeUnusedStationStreams, STATION_STREAMS_KEY } from './station-stream-addresses.js';
import { tidyStorageAtStart } from './startup-tidy.js';
import { starredSongs } from './starred-songs.js';
import { STREAM_QUALITY_FIELDS } from './stream-quality.js';
import {
  cancelScheduledProfileHandoff,
  clearProfileHandoff,
  restoreStartupProfileHandoff,
  scheduleProfileHandoff,
} from './profile-transfer.js';
import { clearPartResume } from './part-resume.js';

export const STORAGE_KEYS = {
  favorites: 'worldmedia.favorites.v1',
  settings: 'worldmedia.settings.v1',
  volume:    'worldmedia.volume.v1',
  jobs:      'worldmedia.jobs.v1',
  // Favorites categories (lib/favorite-groups.js), kept apart from the list.
  favoriteGroups: 'worldmedia.favgroups.v1',
  // The user's own names for favorites (lib/favorite-names.js), the same.
  favoriteNames: FAVORITE_NAMES_KEY,
};

export const SETTINGS_VERSION = 1;

export const NOW_PLAYING_BACKGROUND_BLUR_LABELS = Object.freeze({
  off: 'Off', light: 'Light', medium: 'Medium', strong: 'Strong',
});
const DEFAULT_NOW_PLAYING_BACKGROUND_BLUR = 'medium';

export function normalizeNowPlayingBackgroundBlur(value) {
  return typeof value === 'string' && Object.hasOwn(NOW_PLAYING_BACKGROUND_BLUR_LABELS, value)
    ? value
    : DEFAULT_NOW_PLAYING_BACKGROUND_BLUR;
}

export function loadVolume() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.volume);
    if (raw == null) return null;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(100, v));
  } catch (_) { return null; }
}

export function saveVolume(pct) {
  try {
    localStorage.setItem(STORAGE_KEYS.volume, String(Math.round(pct)));
    scheduleProfileHandoff();
  } catch (_) {}
}

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  theme: 'system',
  defaultMode: 'library',
  recordingEnabled: true,
  recordingQuality: DEFAULT_RECORDING_QUALITY,
  showExplicitContent: false,
  tunerFavoritesOnly: false,
  tunerToneKnobs: false,
  tunerStations: true,
  showTechnicalDetails: false,
  videoSize: 'normal',
  favoritesSort: FAVORITES_SORT_MANUAL,
  showFavoriteTitles: false,
  tunerCardSize: TUNER_CARD_SMALL,
  nowPlayingBackgroundBlur: DEFAULT_NOW_PLAYING_BACKGROUND_BLUR,
  soundMeter: true,
  bestStreamMode: DEFAULT_BEST_STREAM_MODE,
  processorUse: DEFAULT_PROCESSOR_USE,
  processorLimit: null,
  visualizerQuality: DEFAULT_VISUALIZER_QUALITY,
  visualizerFps: DEFAULT_VISUALIZER_FPS,
  visualizerBrightness: DEFAULT_VISUALIZER_BRIGHTNESS,
  visualizerScene: DEFAULT_VISUALIZER_SCENE,
  visualizerShowFps: DEFAULT_VISUALIZER_SHOW_FPS,
  visualizerQualityPicked: false,
  visualizerShuffleCostPicked: false,
  tunerVisualizerBackground: false,
  tunerVisualizerLevel: TUNER_BACKGROUND_DEFAULT_LEVEL,
  visualizerDebug: DEFAULT_VISUALIZER_DEBUG,
  enabledSources: Object.fromEntries(SOURCE_IDS.map((id) => [id, true])),
};

// Enabling explicit content is intentionally a privileged user gesture. Other
// modules may call saveSettings for ordinary fields, but cannot accidentally
// reveal content by passing provider/favorite/URL-derived data into it.
const EXPLICIT_USER_GESTURE = Symbol('explicit-user-gesture');

function freshDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    tabsShown: normalizeTabsShown(),
    enabledSources: { ...DEFAULT_SETTINGS.enabledSources },
  };
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const enabledSources = { ...DEFAULT_SETTINGS.enabledSources };
  if (source.enabledSources && typeof source.enabledSources === 'object' && !Array.isArray(source.enabledSources)) {
    for (const [sourceId, enabled] of Object.entries(source.enabledSources)) {
      // A switch saved for a source the app no longer offers is dropped quietly.
      if (isRetiredSource(sourceId)) continue;
      if (typeof enabled === 'boolean') enabledSources[sourceId] = enabled;
    }
  }
  const version = Number.isInteger(source.version) && source.version > 0
    ? source.version
    : SETTINGS_VERSION;
  return {
    ...source,
    version,
    theme: normalizeTheme(source.theme),
    defaultMode: ['library', 'tuner', 'grid', 'discovery', 'about'].includes(source.defaultMode)
      ? source.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    tabsShown: normalizeTabsShown(source.tabsShown),
    recordingEnabled: source.recordingEnabled !== false,
    recordingQuality: normalizeRecordingQuality(source.recordingQuality),
    showExplicitContent: source.showExplicitContent === true,
    tunerFavoritesOnly: source.tunerFavoritesOnly === true,
    tunerToneKnobs: source.tunerToneKnobs === true,
    tunerStations: source.tunerStations !== false,
    showTechnicalDetails: source.showTechnicalDetails === true,
    videoSize: source.videoSize === 'large' ? 'large' : 'normal',
    favoritesSort: normalizeFavoritesSort(source.favoritesSort),
    showFavoriteTitles: source.showFavoriteTitles === true,
    tunerCardSize: normalizeTunerCardSize(source.tunerCardSize),
    nowPlayingBackgroundBlur: normalizeNowPlayingBackgroundBlur(source.nowPlayingBackgroundBlur),
    // Only an explicit false turns it off; older builds keep the field as is.
    soundMeter: source.soundMeter !== false,
    bestStreamMode: bestStreamMode(source),
    processorUse: normalizeProcessorUse(source.processorUse),
    processorLimit: normalizeProcessorLimit(source.processorLimit),
    visualizerQuality: normalizeVisualizerQuality(source.visualizerQuality),
    visualizerFps: normalizeVisualizerFps(source.visualizerFps),
    visualizerBrightness: normalizeVisualizerBrightness(source.visualizerBrightness),
    visualizerScene: normalizeVisualizerScene(source.visualizerScene),
    visualizerLooks: normalizeVisualizerLooks(source.visualizerLooks),
    // Off unless turned on (an explicit true).
    visualizerShowFps: source.visualizerShowFps === true,
    visualizerQualityPicked: source.visualizerQualityPicked === true,
    visualizerShuffleCostPicked: source.visualizerShuffleCostPicked === true,
    tunerVisualizerBackground: source.tunerVisualizerBackground === true,
    // Settings saved before the level existed get the default: today's look.
    tunerVisualizerLevel: normalizeTunerBackgroundLevel(source.tunerVisualizerLevel),
    visualizerDebug: source.visualizerDebug === true,
    ...normalizeVisualizerExtras(source),
    enabledSources,
  };
}

export function normalizeFavoriteItem(value, options = {}) {
  // A list's renamed copy (favorite-names.js) is saved with its own title.
  value = withoutFavoriteName(value);
  if (!value || typeof value !== 'object' || !value.id) return null;
  const normalized = makeItem(value);
  const extra = normalized._extra && typeof normalized._extra === 'object'
    && !Array.isArray(normalized._extra)
    ? { ...normalized._extra }
    : normalized._extra;
  // Asset relay IDs are random, scoped to one app session, and expire. Keep
  // the adapter's canonical artwork URL in `_extra`, but never write a dead
  // local token into saved favorites. The visible-card hydrator will obtain a
  // fresh relay URL next session.
  if (/^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(normalized.thumbnail)) {
    normalized.thumbnail = '';
    if (extra && typeof extra === 'object') extra.needsArtwork = true;
  }
  // Playback relay URLs have the same per-launch lifetime as asset relays.
  // They must never survive restart as if they were canonical provider URLs.
  // A capable adapter can resolve the stable metadata again; otherwise the
  // favorite remains present with an honest unavailable/checking state.
  const expiredMediaToken = [normalized.stream_url, normalized.download_url]
    .some((url) => /^\/api\/v1\/media\/[A-Za-z0-9_-]{16,}$/.test(url));
  if (expiredMediaToken) {
    normalized.stream_url = '';
    normalized.download_url = '';
    normalized.download_name = '';
    if (extra && typeof extra === 'object') {
      extra.needsResolve = true;
      extra.downloadResolved = false;
      extra.resolutionStatus = 'unresolved';
    }
  }
  // Some providers require a fresh semantic rights/availability check each
  // launch even when their canonical media URL itself is not an opaque local
  // token. Apply this only during startup migration, not on every in-session
  // metadata save, so a completed resolver remains stable until restart.
  if (options.restart === true && extra?.restartResolve === true) {
    normalized.stream_url = '';
    normalized.download_url = '';
    normalized.download_name = '';
    extra.needsResolve = true;
    extra.downloadResolved = false;
    extra.resolutionStatus = 'unresolved';
  }
  // A live snapshot URI is short-lived catalog state, not favorite identity.
  // Persist the stable instance ID/source/artwork metadata and force the
  // adapter to revalidate on selection. This also prevents a public directory
  // query string from being copied into long-lived browser storage.
  if (normalized.delivery === 'live' && extra?.snapshotItem === true) {
    normalized.stream_url = '';
    normalized.download_url = '';
    extra.needsResolve = true;
    extra.resolutionStatus = 'unresolved';
  }
  return repairFiniteMediaFields({ ...value, ...normalized, ...(extra ? { _extra: extra } : {}) });
}

const state = {
  mode: 'library',
  currentItem: null,
  currentStream: null,
  isPlaying: false,
  favorites: [],
  settings: freshDefaultSettings(),
  sleepTimer: { until: null },
};

let favoritesKnown = false;
const listeners = {};

/** Subscribe to a named event. Returns an unsubscribe function. */
export function subscribe(event, fn) {
  (listeners[event] ||= new Set()).add(fn);
  return () => listeners[event]?.delete(fn);
}

/** Emit a named event with optional payload. */
export function emit(event, payload) {
  const set = listeners[event];
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`listener for ${event} threw:`, e); }
  }
}

export function getState() { return state; }
export function favoritesLoaded() { return favoritesKnown; }

export function setMode(mode) {
  state.mode = mode;
  emit('mode-change', mode);
}

export function setCurrentItem(item, stream = null) {
  state.currentItem = item;
  state.currentStream = stream;
  emit('current-item', item);
}

export function setPlaying(playing) {
  state.isPlaying = playing;
  emit('playing-change', playing);
}

/* ============ Favorites ============ */

export function addFavorite(item) {
  // Same identity rule as the bulk path (planFavoriteAdds): the stored,
  // normalised id. An item whose id does not normalise to a non-empty string
  // is refused, so it can never be saved as '' and duplicated on every star.
  const normalized = normalizeFavoriteItem(item);
  if (!normalized?.id) return false;
  const itemId = normalized.id;
  if (state.favorites.some((f) => f.id === itemId)) return;
  emit('eq-before-scope-change', { itemId, scope: 'favorite' });
  const next = [normalized, ...state.favorites];
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  if (!isEqStation(normalized)) {
    persistFavoriteEq(itemId, getEffectiveEq(loadEqState(), itemId, false));
  }
  emit('favorites-change', state.favorites);
  if (state.currentItem?.id === itemId) emit('eq-scope-change', { itemId, scope: 'favorite' });
  return true;
}

/** The most favorites a bulk add will build up to. The portable profile
 *  backup holds 2 MiB for favorites, equalizer curves and settings together
 *  (profile-transfer.js MAX_PROFILE_BYTES, worldmedia_runtime.py
 *  PROFILE_TRANSFER_MAX_BYTES). A playlist channel costs about 0.7 KB there
 *  (about 570 bytes of favorite plus 150 bytes of equalizer curve), so 1,000
 *  uses roughly a third of it and leaves room for larger items. */
export const BULK_FAVORITES_LIMIT = 1000;

function planFavoriteAdds(items) {
  const plan = { fresh: [], already: 0, refused: 0, leftOut: 0 };
  const known = new Set(state.favorites.map((f) => f.id));
  const room = Math.max(0, BULK_FAVORITES_LIMIT - state.favorites.length);
  for (const item of items || []) {
    // Identity is the stored (normalised) id; a non-string id normalises to ''.
    const normalized = normalizeFavoriteItem(item);
    if (!normalized?.id) { plan.refused += 1; continue; }
    if (known.has(normalized.id)) { plan.already += 1; continue; }
    known.add(normalized.id);
    if (plan.fresh.length >= room) { plan.leftOut += 1; continue; }
    plan.fresh.push({ item, normalized });
  }
  return plan;
}

/** How many of `items` addFavorites would add right now. */
export function countNewFavorites(items) {
  return planFavoriteAdds(items).fresh.length;
}

/** Add many favorites with one save, one favorites-change event and one
 *  profile backup. New items keep their given order at the front of the list
 *  (where addFavorite puts one); items already saved are left where they are. */
export function addFavorites(items) {
  const { fresh, already, refused, leftOut } = planFavoriteAdds(items);
  const result = { added: 0, already, refused, leftOut, failed: false };
  if (fresh.length === 0) return result;
  const ids = fresh.map(({ normalized }) => normalized.id);
  for (const itemId of ids) emit('eq-before-scope-change', { itemId, scope: 'favorite' });
  const next = [...fresh.map(({ normalized }) => normalized), ...state.favorites];
  if (!persistFavorites(next)) return { ...result, failed: true };
  state.favorites = next;
  let eqFailed = false;
  const curveIds = fresh.filter(({ normalized }) => !isEqStation(normalized)).map(({ normalized }) => normalized.id);
  if (curveIds.length) {
    saveEqState(addFavoritesEq(loadEqState(), curveIds), undefined, () => { eqFailed = true; });
  }
  emit('favorites-change', state.favorites);
  const current = ids.find((itemId) => itemId === state.currentItem?.id);
  if (current) emit('eq-scope-change', { itemId: current, scope: 'favorite' });
  return { ...result, added: fresh.length, eqFailed };
}

export function removeFavorite(itemId) {
  const before = state.favorites.length;
  if (state.favorites.some((f) => f.id === itemId)) {
    emit('eq-before-scope-change', { itemId, scope: 'global' });
  }
  const next = state.favorites.filter((f) => f.id !== itemId);
  if (next.length !== before) {
    if (!persistFavorites(next)) return false;
    state.favorites = next;
    deleteFavoriteEq(itemId);
    removeUnusedStationStreams([itemId]);
    emit('favorites-change', state.favorites);
    if (state.currentItem?.id === itemId) emit('eq-scope-change', { itemId, scope: 'global' });
  }
  return true;
}

/** Empty the favorites list with one save and one favorites-change event, and
 *  drop the favorites' own equalizer curves. Categories and every other
 *  setting stay. The caller asks first.
 *
 *  All or nothing: the curves are removed first; if that cannot be saved,
 *  nothing changes. If the empty list then cannot be saved, the curves are
 *  put back. Returns { removed, failed }: failed is '' on success, 'nothing'
 *  when nothing changed, or 'curves' in the one case that cannot be undone
 *  (the list could not be saved and the curves could not be put back: the
 *  favorites stay, without their own equalizer settings). */
export function removeAllFavorites() {
  const removed = state.favorites;
  if (removed.length === 0) return { removed: 0, failed: '' };
  const currentId = state.currentItem?.id;
  const playingFavorite = Boolean(currentId) && removed.some((f) => f.id === currentId);
  if (playingFavorite) emit('eq-before-scope-change', { itemId: currentId, scope: 'global' });
  const eq = loadEqState();
  const curves = { ...eq.favorites };
  let hadCurves = false;
  for (const favorite of removed) {
    if (Object.hasOwn(curves, favorite.id)) { delete curves[favorite.id]; hadCurves = true; }
  }
  const undoScope = () => { if (playingFavorite) emit('eq-scope-change', { itemId: currentId, scope: 'favorite' }); };
  const savedEq = [];
  let eqFailed = false;
  if (hadCurves) {
    try {
      for (const key of [EQ_STORAGE_KEY, EQ_EXTRA_STORAGE_KEY]) savedEq.push([key, localStorage.getItem(key)]);
      saveEqState({ ...eq, favorites: curves }, undefined, () => { eqFailed = true; });
    } catch (_) { eqFailed = true; }
  }
  if (eqFailed) { undoScope(); return { removed: 0, failed: 'nothing' }; }
  if (!persistFavorites([])) {
    let restoreFailed = false;
    for (const [key, value] of savedEq) {
      try {
        if (localStorage.getItem(key) === value) continue;
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (_) { restoreFailed = true; }
    }
    undoScope();
    return { removed: 0, failed: restoreFailed ? 'curves' : 'nothing' };
  }
  state.favorites = [];
  removeUnusedStationStreams(removed.map((item) => item.id));
  emit('favorites-change', state.favorites);
  if (playingFavorite) emit('eq-scope-change', { itemId: currentId, scope: 'global' });
  return { removed: removed.length, failed: '' };
}

export function isFavorite(itemId) {
  return state.favorites.some((f) => f.id === itemId);
}

/** Favorites in the order the user chose to see them ("My order" or A-Z).
 *  Every list of favorites uses this; see favorites-order.js. */
export function displayFavorites() {
  return favoritesInDisplayOrder(state.favorites, state.settings);
}

/** Where moveFavorite would put `itemId`, or -1 when it cannot move that way.
 *  With `visibleIds`, up and down skip favorites the user cannot see (another
 *  type, a search, a filter), so the item trades places with the neighbour it
 *  is shown next to. "top" needs a shown favorite above it and goes to the
 *  very start of the saved list; "bottom" needs one below it and goes to the
 *  very end. */
function favoriteMoveTarget(list, from, direction, visibleIds) {
  const visible = visibleIds ? new Set(visibleIds) : null;
  const shown = (index) => !visible || visible.has(list[index].id);
  if (direction === 'up' || direction === 'top') {
    for (let i = from - 1; i >= 0; i -= 1) if (shown(i)) return direction === 'top' ? 0 : i;
  } else if (direction === 'down' || direction === 'bottom') {
    for (let i = from + 1; i < list.length; i += 1) if (shown(i)) return direction === 'bottom' ? list.length - 1 : i;
  }
  return -1;
}

/** Rearrange "My order" by hand: 'up' or 'down' swaps the favorite with its
 *  nearest shown neighbour, 'top' moves it to the start and 'bottom' to the
 *  end. One save and one
 *  favorites-change event per move. Returns true when the order changed. */
export function moveFavorite(itemId, direction, { visibleIds = null } = {}) {
  const from = state.favorites.findIndex((favorite) => favorite.id === itemId);
  if (from < 0) return false;
  const to = favoriteMoveTarget(state.favorites, from, direction, visibleIds);
  if (to < 0) return false;
  const next = [...state.favorites];
  if (direction === 'top') next.unshift(...next.splice(from, 1));
  else if (direction === 'bottom') next.push(...next.splice(from, 1));
  else [next[from], next[to]] = [next[to], next[from]];
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  emit('favorites-change', state.favorites);
  return true;
}

/** Drag and drop in "My order": put `itemId` just before or just after
 *  `targetId` (place 'before' | 'after') in the saved list. `visibleIds`
 *  (optional) are the favorites shown, with a filter or category: only they
 *  are reordered, back into the places they had, so hidden favorites keep
 *  their exact positions. One save and one favorites-change event. Returns
 *  true when the order changed. */
export function moveFavoriteTo(itemId, targetId, place = 'before', visibleIds = null) {
  if (!itemId || itemId === targetId || (place !== 'before' && place !== 'after')) return false;
  const visible = visibleIds ? new Set(visibleIds) : null;
  if (visible && (!visible.has(itemId) || !visible.has(targetId))) return false;
  const slots = [];
  state.favorites.forEach((favorite, index) => {
    if (!visible || visible.has(favorite.id)) slots.push(index);
  });
  const shown = slots.map((index) => state.favorites[index]);
  const from = shown.findIndex((favorite) => favorite.id === itemId);
  if (from < 0 || !shown.some((favorite) => favorite.id === targetId)) return false;
  const moved = shown.filter((_, index) => index !== from);
  const at = moved.findIndex((favorite) => favorite.id === targetId) + (place === 'after' ? 1 : 0);
  moved.splice(at, 0, shown[from]);
  const next = state.favorites.slice();
  slots.forEach((slot, index) => { next[slot] = moved[index]; });
  if (next.every((favorite, index) => favorite === state.favorites[index])) return false;
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  emit('favorites-change', state.favorites);
  return true;
}

/** The stream format and bitrate a favorite was saved with stay when the item
 *  that rewrites it does not carry them (an older copy of the same station);
 *  when it does carry them, its fresh values win. */
function keepStreamQuality(next, saved) {
  const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const savedExtra = saved?._extra;
  if (!next || !isPlain(savedExtra)) return;
  const kept = STREAM_QUALITY_FIELDS.filter((field) => field in savedExtra);
  if (kept.length === 0) return;
  // An incoming item without an `_extra` object lacks the fields too. `next`
  // is the normalized copy, so this never changes the caller's item.
  if (!isPlain(next._extra)) next._extra = {};
  for (const field of kept) {
    if (!(field in next._extra)) next._extra[field] = savedExtra[field];
  }
}

/** Persist adapter resolution/capability metadata without changing favorite order. */
export function persistFavoriteMetadata(item) {
  if (!item?.id) return false;
  const index = state.favorites.findIndex((favorite) => favorite.id === item.id);
  if (index < 0) return false;
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return false;
  keepStreamQuality(normalized, state.favorites[index]);
  // Dynamic favorites deliberately persist without short-lived stream/asset
  // URLs. If the player is resolving the favorite object itself, mutating that
  // same object with the restart-safe copy would erase the fresh stream before
  // it can be attached. Detach the persisted copy while playback keeps owning
  // the resolved runtime object; stable IDs preserve favorite/EQ identity.
  const next = [...state.favorites];
  next[index] = normalized;
  if (!persistFavorites(next)) return false;
  if (state.favorites[index] === item) state.favorites[index] = normalized;
  else Object.assign(state.favorites[index], normalized);
  return true;
}

function persistFavorites(favorites = state.favorites) {
  try {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
    clearPersistenceFailure('favorites');
    scheduleProfileHandoff();
    return true;
  } catch (e) {
    console.warn('Could not persist favorites:', e);
    reportPersistenceFailure('favorites', 'Favorites could not be saved. Your previous saved list is unchanged. Check available disk space and retry; do not delete your app data.');
    return false;
  }
}

/** True when the saved favorites are known (read, or none saved); false
 *  when they could not be read. */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.favorites);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.favorites = parsed.map((item) => normalizeFavoriteItem(item, { restart: true })).filter(Boolean);
      // Persist normalized capability fields so a migrated favorite stays
      // repaired on later launches instead of depending on runtime inference.
      persistFavorites();
      return true;
    }
  } catch (e) { console.warn('Could not load favorites:', e); }
  return false;
}

/* ============ Settings ============ */

// The last settings JSON seen by this window. Another window can update or
// clear it before this one saves a different preference.
let savedSettingsRaw;
let savedExtraSettingsRaw;

function readExtraSettings(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (_) {}
  return {};
}

function extraTunerSettings(raw) {
  const { tunerToneKnobs, tunerStations } = readExtraSettings(raw);
  return { tunerToneKnobs: tunerToneKnobs === true, tunerStations: tunerStations !== false };
}

export function saveSettings(partial, authorization = null) {
  const requested = partial && typeof partial === 'object' && !Array.isArray(partial)
    ? { ...partial }
    : {};
  if (requested.showExplicitContent === true && authorization !== EXPLICIT_USER_GESTURE) {
    delete requested.showExplicitContent;
  }
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  let currentSettings = state.settings;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (savedSettingsRaw !== undefined && raw !== savedSettingsRaw) {
      currentSettings = normalizeSettings({
        ...(raw ? JSON.parse(raw) : null),
        tunerToneKnobs: currentSettings.tunerToneKnobs,
        tunerStations: currentSettings.tunerStations,
      });
    }
    const extra = localStorage.getItem(EXTRA_SETTINGS_STORAGE_KEY);
    if (extra !== savedExtraSettingsRaw) {
      currentSettings = { ...currentSettings, ...extraTunerSettings(extra) };
      savedExtraSettingsRaw = extra;
    }
  } catch (_) { /* Keep the settings in use when storage cannot be read. */ }
  state.settings = normalizeSettings({ ...currentSettings, ...requested });
  try {
    const { tunerToneKnobs, tunerStations, ...legacySettings } = state.settings;
    const raw = JSON.stringify(legacySettings);
    localStorage.setItem(STORAGE_KEYS.settings, raw);
    savedSettingsRaw = raw;
    if (Object.hasOwn(requested, 'tunerToneKnobs') || Object.hasOwn(requested, 'tunerStations')) {
      const extra = JSON.stringify({
        ...readExtraSettings(savedExtraSettingsRaw),
        ...(Object.hasOwn(requested, 'tunerToneKnobs') ? { tunerToneKnobs } : {}),
        ...(Object.hasOwn(requested, 'tunerStations') ? { tunerStations } : {}),
      });
      localStorage.setItem(EXTRA_SETTINGS_STORAGE_KEY, extra);
      savedExtraSettingsRaw = extra;
    }
    clearPersistenceFailure('settings');
    scheduleProfileHandoff();
  } catch (e) {
    console.warn('Could not persist settings:', e);
    reportPersistenceFailure('settings', 'Settings could not be saved and may revert after restart. Check available disk space and retry.');
  }
  const nextExplicit = state.settings.showExplicitContent === true;
  if (nextExplicit !== previousExplicit) {
    emit('content-policy-change', {
      previous: previousExplicit,
      current: nextExplicit,
      currentItem,
    });
  }
  emit('settings-change', state.settings);
  applyTheme(state.settings.theme);
}

/** The sole runtime path that can turn explicit-content visibility on. */
export function setShowExplicitContent(enabled) {
  saveSettings({ showExplicitContent: enabled === true }, EXPLICIT_USER_GESTURE);
}

export function setSourceEnabled(sourceId, enabled) {
  const next = { ...state.settings.enabledSources, [sourceId]: enabled };
  saveSettings({ enabledSources: next });
}

function loadSettings() {
  state.settings = freshDefaultSettings();
  savedSettingsRaw = undefined;
  savedExtraSettingsRaw = undefined;
  try {
    savedSettingsRaw = localStorage.getItem(STORAGE_KEYS.settings);
    if (savedSettingsRaw) state.settings = normalizeSettings(JSON.parse(savedSettingsRaw));
  } catch (e) { console.warn('Could not load settings:', e); }
  Object.assign(state.settings, extraTunerSettings(null));
  try {
    savedExtraSettingsRaw = localStorage.getItem(EXTRA_SETTINGS_STORAGE_KEY);
    Object.assign(state.settings, extraTunerSettings(savedExtraSettingsRaw));
  } catch (e) { console.warn('Could not load extra settings:', e); }
}

/* ============ Init ============ */

export async function initState() {
  // A localhost port is part of the browser origin. Restore a saved handoff
  // before reading any local keys when Settings deliberately changed that port.
  await restoreStartupProfileHandoff();
  favoritesKnown = loadFavorites();
  loadSettings();
  // Tidy only after the restore, when the saved favorites are known.
  if (favoritesKnown) {
    try {
      tidyStorageAtStart(localStorage, state.favorites.map((favorite) => favorite?.id));
    } catch (_) { /* storage unavailable */ }
  }
  applyTheme(state.settings.theme);
  scheduleProfileHandoff();
}

/** Clears this window's saved data at once and returns a promise that settles
 *  when the native copy has also been cleared (rejects if it was not), so the
 *  caller can wait before reporting done. Not awaiting it is safe. */
export function clearCache() {
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  try {
    localStorage.removeItem(STORAGE_KEYS.favorites);
    localStorage.removeItem(STORAGE_KEYS.settings);
    savedSettingsRaw = null;
    localStorage.removeItem(EXTRA_SETTINGS_STORAGE_KEY);
    savedExtraSettingsRaw = null;
    localStorage.removeItem(STORAGE_KEYS.volume);
    localStorage.removeItem(STORAGE_KEYS.jobs);
    localStorage.removeItem(STORAGE_KEYS.favoriteGroups);
    localStorage.removeItem(STORAGE_KEYS.favoriteNames);
    clearStreamLookups();
    clearStreamVerifications();
    localStorage.removeItem(STATION_STREAMS_KEY);
    clearDidNotPlayCache(); // "Did not play last time" marks (a cache)
    clearPlayedStreams(); // the format and bitrate stations played with (a cache)
    clearEqState(localStorage);
    localStorage.removeItem(PICTURE_STORAGE_KEY);
  } catch (_) {}
  clearPartResume();
  emit('part-resume-cleared');
  emit('picture-settings-cleared');
  cancelScheduledProfileHandoff();
  // The song log and starred songs are kept apart from the profile (see
  // song-log.js, starred-songs.js); they are cleared with it, here and in the
  // data folder.
  const nativeCleared = Promise.all([clearProfileHandoff(), songLog.clear(), starredSongs.clear()])
    .then(([cleared]) => cleared);
  nativeCleared.catch(() => {}); // Callers that do not wait must not see an unhandled rejection.
  state.favorites = [];
  state.settings = freshDefaultSettings();
  applyTheme(state.settings.theme);
  emit('favorites-change', []);
  if (previousExplicit) {
    emit('content-policy-change', {
      previous: true,
      current: false,
      currentItem,
    });
  }
  emit('settings-change', state.settings);
  return nativeCleared;
}
