/**
 * Renaming favorites: the user's own name for a saved favorite, and going
 * back to the station's own name. The names are stored by favorite-names.js;
 * this saves them and tells every list (one 'favorites-change' event, which
 * the Library, the Tuner and the player bar already follow).
 *
 * A name for a favorite that is no longer saved is dropped when the
 * favorites change, as categories are (favorite-groups.js).
 */

import { emit, getState, isLocalFileFavorite, subscribe } from './state.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';
import {
  FAVORITE_NAMES_KEY, MAX_FAVORITE_NAMES, cleanFavoriteName, favoriteNamesSnapshot, favoriteNamesText,
  resetFavoriteNamesCache,
} from './favorite-names.js';

export const FAVORITE_NAMES_EVENT = 'favorite-names-change';
export const RENAME_SAVE_FAILED = 'The new name could not be saved. Check available disk space and try again.';

function savedFavorite(favoriteId) {
  return getState().favorites.find((favorite) => favorite?.id === favoriteId && !isLocalFileFavorite(favorite)) || null;
}

function commit(names, detail) {
  let target = null;
  try { target = globalThis.localStorage || null; } catch (_) { target = null; }
  if (!target || typeof target.setItem !== 'function') return { ok: false, error: RENAME_SAVE_FAILED };
  const saved = new Set(getState().favorites.map((favorite) => favorite?.id).filter(Boolean));
  const kept = new Map([...names].filter(([favoriteId]) => saved.has(favoriteId)));
  const raw = favoriteNamesText(kept);
  try {
    if (raw == null) target.removeItem?.(FAVORITE_NAMES_KEY);
    else target.setItem(FAVORITE_NAMES_KEY, raw);
  } catch (error) {
    console.warn('Could not save favorite names:', error);
    reportPersistenceFailure('favorite-names', RENAME_SAVE_FAILED);
    return { ok: false, error: RENAME_SAVE_FAILED };
  }
  clearPersistenceFailure('favorite-names');
  resetFavoriteNamesCache();
  scheduleProfileHandoff();
  emit(FAVORITE_NAMES_EVENT, detail);
  // Every list of favorites redraws on this event (the title is part of
  // what a card shows, so a renamed card is redrawn in place).
  if (detail.action !== 'prune') emit('favorites-change', getState().favorites);
  return { ok: true, error: '', changed: true };
}

/** Give a saved favorite the user's own name. An empty name, or the
 *  station's own name, goes back to the station's own name. */
export function renameFavorite(favoriteId, value) {
  const favorite = savedFavorite(favoriteId);
  if (!favorite) return { ok: false, error: 'Only saved favorites can be renamed.' };
  const doc = favoriteNamesSnapshot();
  if (doc.locked) return { ok: false, error: 'Names were saved by a newer version of World Media and cannot be changed here.' };
  const name = cleanFavoriteName(value);
  const original = typeof favorite.title === 'string' ? favorite.title : '';
  const next = new Map(doc.names);
  if (!name || name === original) next.delete(favoriteId);
  else next.set(favoriteId, name);
  if ((doc.names.get(favoriteId) || '') === (next.get(favoriteId) || '')) return { ok: true, error: '', changed: false };
  if (!doc.names.has(favoriteId) && next.has(favoriteId) && doc.names.size >= MAX_FAVORITE_NAMES) {
    return { ok: false, error: `At most ${MAX_FAVORITE_NAMES} favorites can have a name of their own.` };
  }
  return commit(next, { action: 'rename', favoriteId });
}

/** Back to the station's own name. */
export function resetFavoriteName(favoriteId) {
  return renameFavorite(favoriteId, '');
}

// Names that arrived from another window are never pruned here: that
// window may have favorites this one has not loaded.
let fromOtherWindow = false;

/** Another window saved names (a 'storage' event): the lists, the Tuner and
 *  the player bar here show them at once. True when it was about the names. */
export function onFavoriteNamesStorage(event) {
  if (!event || (event.key !== FAVORITE_NAMES_KEY && event.key !== null)) return false;
  resetFavoriteNamesCache();
  fromOtherWindow = true;
  try {
    emit(FAVORITE_NAMES_EVENT, { action: 'other-window' });
    emit('favorites-change', getState().favorites);
  } finally {
    fromOtherWindow = false;
  }
  return true;
}

const watchedWindows = new WeakSet();

/** Follow name changes made in other windows of the app (once per window). */
export function watchFavoriteNamesInOtherWindows(target = globalThis) {
  if (!target || typeof target.addEventListener !== 'function' || watchedWindows.has(target)) return false;
  watchedWindows.add(target);
  target.addEventListener('storage', onFavoriteNamesStorage);
  return true;
}

/** Drop names of favorites that are no longer saved. True when it saved. */
export function pruneFavoriteNames() {
  const doc = favoriteNamesSnapshot();
  if (doc.locked || doc.names.size === 0) return false;
  const saved = new Set(getState().favorites.map((favorite) => favorite?.id).filter(Boolean));
  if ([...doc.names.keys()].every((favoriteId) => saved.has(favoriteId))) return false;
  return commit(doc.names, { action: 'prune' }).ok;
}

subscribe('favorites-change', () => { if (!fromOtherWindow) pruneFavoriteNames(); });
watchFavoriteNamesInOtherWindows();
