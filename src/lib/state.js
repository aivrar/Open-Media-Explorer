/**
 * Central app state. The only place mutable globals live.
 *
 * State shape:
 * {
 *   mode: 'library' | 'tuner' | 'grid' | 'discovery',
 *   currentItem: Item | null,
 *   isPlaying: bool,
 *   favorites: Item[],
 *   settings: {
 *     theme: 'system' | 'light' | 'dark' | 'midnight' | 'forest' | 'ember' | 'amethyst',
 *     defaultMode: string,
 *     recordingEnabled: bool,
 *     enabledSources: Record<adapterId, bool>,
 *     showExplicitContent: bool,
 *     tunerFavoritesOnly: bool,
 *     showTechnicalDetails: bool,
 *     videoSize: 'normal' | 'large',
 *     favoritesSort: 'manual' | 'name',   // "My order" (stored order) or "A-Z"
 *     tunerCardSize: 'small' | 'medium' | 'large',   // Tuner strip cards (tuner-card-size.js)
 *     soundMeter: bool,   // LED sound meter in the player bar (player-meter.js), default on
 *   },
 *   sleepTimer: { until: number | null }
 * }
 */

import { isRetiredSource, SOURCE_IDS } from './sources.js';
import { makeItem } from './item-model.js';
import {
  loadEqState, getEffectiveEq, persistFavoriteEq, deleteFavoriteEq, clearEqState,
  addFavoritesEq, saveEqState,
} from './eq-store.js';
import { DEFAULT_RECORDING_QUALITY, normalizeRecordingQuality } from './recording-profiles.js';
import { repairFiniteMediaFields } from './media-capabilities.js';
import { applyTheme, normalizeTheme } from './themes.js';
import { FAVORITES_SORT_MANUAL, favoritesInDisplayOrder, normalizeFavoritesSort } from './favorites-order.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';
import { TUNER_CARD_SMALL, normalizeTunerCardSize } from './tuner-card-size.js';
import { songLog } from './song-log.js';
import { STREAM_QUALITY_FIELDS } from './stream-quality.js';
import {
  cancelScheduledProfileHandoff,
  clearProfileHandoff,
  restoreProfileHandoff,
  scheduleProfileHandoff,
} from './profile-transfer.js';

export const STORAGE_KEYS = {
  favorites: 'worldmedia.favorites.v1',
  settings: 'worldmedia.settings.v1',
  volume:    'worldmedia.volume.v1',
  jobs:      'worldmedia.jobs.v1',
  // Favorites categories (lib/favorite-groups.js), kept apart from the list.
  favoriteGroups: 'worldmedia.favgroups.v1',
};

export const SETTINGS_VERSION = 1;

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
  showTechnicalDetails: false,
  videoSize: 'normal',
  favoritesSort: FAVORITES_SORT_MANUAL,
  tunerCardSize: TUNER_CARD_SMALL,
  soundMeter: true,
  enabledSources: Object.fromEntries(SOURCE_IDS.map((id) => [id, true])),
};

// Enabling explicit content is intentionally a privileged user gesture. Other
// modules may call saveSettings for ordinary fields, but cannot accidentally
// reveal content by passing provider/favorite/URL-derived data into it.
const EXPLICIT_USER_GESTURE = Symbol('explicit-user-gesture');

function freshDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
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
    recordingEnabled: source.recordingEnabled !== false,
    recordingQuality: normalizeRecordingQuality(source.recordingQuality),
    showExplicitContent: source.showExplicitContent === true,
    tunerFavoritesOnly: source.tunerFavoritesOnly === true,
    showTechnicalDetails: source.showTechnicalDetails === true,
    videoSize: source.videoSize === 'large' ? 'large' : 'normal',
    favoritesSort: normalizeFavoritesSort(source.favoritesSort),
    tunerCardSize: normalizeTunerCardSize(source.tunerCardSize),
    // Only an explicit false turns it off; older builds keep the field as is.
    soundMeter: source.soundMeter !== false,
    enabledSources,
  };
}

export function normalizeFavoriteItem(value, options = {}) {
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
  isPlaying: false,
  favorites: [],
  settings: freshDefaultSettings(),
  sleepTimer: { until: null },
};

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

export function setMode(mode) {
  state.mode = mode;
  emit('mode-change', mode);
}

export function setCurrentItem(item) {
  state.currentItem = item;
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
  const eqState = loadEqState();
  const effectiveCurve = getEffectiveEq(eqState, itemId, false);
  const next = [normalized, ...state.favorites];
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  persistFavoriteEq(itemId, effectiveCurve);
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
  saveEqState(addFavoritesEq(loadEqState(), ids), undefined, () => { eqFailed = true; });
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
    emit('favorites-change', state.favorites);
    if (state.currentItem?.id === itemId) emit('eq-scope-change', { itemId, scope: 'global' });
  }
  return true;
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
 *  very start of the saved list. */
function favoriteMoveTarget(list, from, direction, visibleIds) {
  const visible = visibleIds ? new Set(visibleIds) : null;
  const shown = (index) => !visible || visible.has(list[index].id);
  if (direction === 'up' || direction === 'top') {
    for (let i = from - 1; i >= 0; i -= 1) if (shown(i)) return direction === 'top' ? 0 : i;
  } else if (direction === 'down') {
    for (let i = from + 1; i < list.length; i += 1) if (shown(i)) return i;
  }
  return -1;
}

/** Rearrange "My order" by hand: 'up' or 'down' swaps the favorite with its
 *  nearest shown neighbour, 'top' moves it to the start. One save and one
 *  favorites-change event per move. Returns true when the order changed. */
export function moveFavorite(itemId, direction, { visibleIds = null } = {}) {
  const from = state.favorites.findIndex((favorite) => favorite.id === itemId);
  if (from < 0) return false;
  const to = favoriteMoveTarget(state.favorites, from, direction, visibleIds);
  if (to < 0) return false;
  const next = [...state.favorites];
  if (direction === 'top') next.unshift(...next.splice(from, 1));
  else [next[from], next[to]] = [next[to], next[from]];
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

function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.favorites);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.favorites = parsed.map((item) => normalizeFavoriteItem(item, { restart: true })).filter(Boolean);
      // Persist normalized capability fields so a migrated favorite stays
      // repaired on later launches instead of depending on runtime inference.
      persistFavorites();
    }
  } catch (e) { console.warn('Could not load favorites:', e); }
}

/* ============ Settings ============ */

export function saveSettings(partial, authorization = null) {
  const requested = partial && typeof partial === 'object' && !Array.isArray(partial)
    ? { ...partial }
    : {};
  if (requested.showExplicitContent === true && authorization !== EXPLICIT_USER_GESTURE) {
    delete requested.showExplicitContent;
  }
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  state.settings = normalizeSettings({ ...state.settings, ...requested });
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
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
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.settings = normalizeSettings(parsed);
  } catch (e) { console.warn('Could not load settings:', e); }
}

/* ============ Init ============ */

export async function initState() {
  // A localhost port is part of the browser origin. Restore a saved handoff
  // before reading any local keys when Settings deliberately changed that port.
  await restoreProfileHandoff();
  loadFavorites();
  loadSettings();
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
    localStorage.removeItem(STORAGE_KEYS.volume);
    localStorage.removeItem(STORAGE_KEYS.jobs);
    localStorage.removeItem(STORAGE_KEYS.favoriteGroups);
    clearEqState(localStorage);
  } catch (_) {}
  cancelScheduledProfileHandoff();
  // The song log is kept apart from the profile (see song-log.js); it is
  // cleared with it, here and in the data folder.
  const nativeCleared = Promise.all([clearProfileHandoff(), songLog.clear()]).then(([cleared]) => cleared);
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
