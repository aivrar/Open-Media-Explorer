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
 *   },
 *   sleepTimer: { until: number | null }
 * }
 */

import { SOURCE_IDS } from './sources.js';
import { makeItem } from './item-model.js';
import {
  loadEqState, getEffectiveEq, persistFavoriteEq, deleteFavoriteEq, clearEqState,
} from './eq-store.js';
import { DEFAULT_RECORDING_QUALITY, normalizeRecordingQuality } from './recording-profiles.js';
import { repairFiniteMediaFields } from './media-capabilities.js';
import { applyTheme, normalizeTheme } from './themes.js';
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
  if (!item || !item.id) return;
  if (state.favorites.some((f) => f.id === item.id)) return;
  emit('eq-before-scope-change', { itemId: item.id, scope: 'favorite' });
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return;
  const eqState = loadEqState();
  const effectiveCurve = getEffectiveEq(eqState, item.id, false);
  persistFavoriteEq(item.id, effectiveCurve);
  state.favorites.unshift(normalized);
  persistFavorites();
  emit('favorites-change', state.favorites);
  if (state.currentItem?.id === item.id) emit('eq-scope-change', { itemId: item.id, scope: 'favorite' });
}

export function removeFavorite(itemId) {
  const before = state.favorites.length;
  if (state.favorites.some((f) => f.id === itemId)) {
    emit('eq-before-scope-change', { itemId, scope: 'global' });
  }
  state.favorites = state.favorites.filter((f) => f.id !== itemId);
  if (state.favorites.length !== before) {
    deleteFavoriteEq(itemId);
    persistFavorites();
    emit('favorites-change', state.favorites);
    if (state.currentItem?.id === itemId) emit('eq-scope-change', { itemId, scope: 'global' });
  }
}

export function isFavorite(itemId) {
  return state.favorites.some((f) => f.id === itemId);
}

/** Persist adapter resolution/capability metadata without changing favorite order. */
export function persistFavoriteMetadata(item) {
  if (!item?.id) return false;
  const index = state.favorites.findIndex((favorite) => favorite.id === item.id);
  if (index < 0) return false;
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return false;
  // Dynamic favorites deliberately persist without short-lived stream/asset
  // URLs. If the player is resolving the favorite object itself, mutating that
  // same object with the restart-safe copy would erase the fresh stream before
  // it can be attached. Detach the persisted copy while playback keeps owning
  // the resolved runtime object; stable IDs preserve favorite/EQ identity.
  if (state.favorites[index] === item) state.favorites[index] = normalized;
  else Object.assign(state.favorites[index], normalized);
  persistFavorites();
  return true;
}

function persistFavorites() {
  try {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(state.favorites));
    scheduleProfileHandoff();
  } catch (e) { console.warn('Could not persist favorites:', e); }
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
    scheduleProfileHandoff();
  } catch (e) { console.warn('Could not persist settings:', e); }
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

export function clearCache() {
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  try {
    localStorage.removeItem(STORAGE_KEYS.favorites);
    localStorage.removeItem(STORAGE_KEYS.settings);
    localStorage.removeItem(STORAGE_KEYS.volume);
    localStorage.removeItem(STORAGE_KEYS.jobs);
    clearEqState(localStorage);
  } catch (_) {}
  cancelScheduledProfileHandoff();
  void clearProfileHandoff().catch(() => {});
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
}
