/**
 * Start-up tidy, run once per start by initState (state.js): after the
 * profile was restored from the data folder (a new port starts with empty
 * page storage and gets favorites, names and categories from the files) and
 * the favorites were read, and before the first profile save.
 *
 * It drops what belongs to no saved favorite, as the app already does at
 * every change of the favorites (favorite-rename.js, favorite-groups.js):
 * - the user's names for stations that are not favorites, so a station
 *   starred again shows its own name, not one left from long ago;
 * - category assignments of stations that are not favorites (the categories
 *   themselves stay).
 * Names and assignments of saved favorites are never changed. Data in a
 * layout from a newer version, or unreadable, is left as it is. The first
 * profile save then writes the tidied values to the data folder.
 *
 * Pure apart from the storage it is given; nothing here imports state.js.
 */

import {
  FAVORITE_NAMES_KEY, favoriteNamesText, parseFavoriteNames, resetFavoriteNamesCache,
} from './favorite-names.js';

// state.js STORAGE_KEYS.favoriteGroups and favorite-groups.js
// FAVORITE_GROUPS_VERSION (that module imports state.js, so not imported).
export const FAVORITE_GROUPS_KEY = 'worldmedia.favgroups.v1';
const FAVORITE_GROUPS_VERSION = 1;

/** The names text keeping only names of `saved` favorites: `raw` itself
 *  when nothing is dropped, null when no name is left. */
export function namesKeptFor(raw, saved) {
  if (typeof raw !== 'string') return raw;
  const doc = parseFavoriteNames(raw);
  if (doc.locked || doc.names.size === 0) return raw;
  const kept = new Map([...doc.names].filter(([favoriteId]) => saved.has(favoriteId)));
  if (kept.size === doc.names.size) return raw;
  return favoriteNamesText(kept);
}

/** The categories text keeping only assignments of `saved` favorites (the
 *  rest as stored); `raw` itself when nothing is dropped. */
export function groupsKeptFor(raw, saved) {
  if (typeof raw !== 'string') return raw;
  let value;
  try { value = JSON.parse(raw); } catch (_) { return raw; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== FAVORITE_GROUPS_VERSION) return raw;
  const stored = value.assign;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return raw;
  const entries = Object.entries(stored);
  const kept = entries.filter(([favoriteId]) => saved.has(favoriteId));
  if (kept.length === entries.length) return raw;
  return JSON.stringify({ ...value, assign: Object.fromEntries(kept) });
}

/**
 * Tidy `storage` for the saved favorites' ids. Returns the keys it changed.
 * A storage that cannot be written is left as it is.
 */
export function tidyStorageAtStart(storage, favoriteIds) {
  const changed = [];
  if (!storage || typeof storage.getItem !== 'function') return changed;
  const saved = new Set([...(favoriteIds || [])].filter((id) => typeof id === 'string' && id));
  for (const [key, keep] of [[FAVORITE_NAMES_KEY, namesKeptFor], [FAVORITE_GROUPS_KEY, groupsKeptFor]]) {
    try {
      const raw = storage.getItem(key);
      const next = keep(raw, saved);
      if (next === raw) continue;
      if (next == null) storage.removeItem(key);
      else storage.setItem(key, next);
      changed.push(key);
    } catch (error) {
      console.warn(`Could not tidy ${key}:`, error);
    }
  }
  if (changed.includes(FAVORITE_NAMES_KEY)) resetFavoriteNamesCache();
  return changed;
}
