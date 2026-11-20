/**
 * The user's own names for favorites ("Rename" in a favorite's details).
 *
 * Stored apart from the favorites list, under its own key:
 *   { version: 1, names: { favoriteId: name } }
 * The favorite itself keeps the station's own name, so it can always be
 * brought back ("Use original name"), an older build simply shows the
 * original names, and persistFavoriteMetadata (state.js), which rewrites a
 * saved favorite from the playing item, never loses a name. The key travels
 * with the profile (profile-transfer.js, worldmedia_runtime.py), so it is in
 * the data folder copy and in backups.
 *
 * Lists show a favorite through withFavoriteName(): a copy whose title is the
 * user's name and whose originalTitle is the station's own (searches match
 * both). normalizeFavoriteItem (state.js) turns such a copy back with
 * withoutFavoriteName(), so the name is never saved into the favorite.
 *
 * Pure apart from reading localStorage: nothing here imports state.js, so the
 * favorites sort and the player can use it. Changes go through
 * favorite-rename.js.
 */

export const FAVORITE_NAMES_KEY = 'worldmedia.favnames.v1';
export const FAVORITE_NAMES_VERSION = 1;
// A name longer than this made a Tuner card hundreds of pixels wide; a
// longer name saved by an earlier version is read (and shown) cut to it.
export const MAX_FAVORITE_NAME_LENGTH = 80;
export const MAX_FAVORITE_NAMES = 5000;

const MAX_FAVORITE_ID_LENGTH = 4096;
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const EMPTY = Object.freeze({ names: new Map(), locked: false });
let cache = { raw: undefined, doc: EMPTY };
const copies = new WeakMap(); // favorite -> { name, copy }

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

/** A name as it is saved: one plain line, at most MAX_FAVORITE_NAME_LENGTH
 *  characters, no control or invisible characters. */
export function cleanFavoriteName(value) {
  if (typeof value !== 'string') return '';
  let text = value;
  try { text = text.normalize('NFC'); } catch (_) { /* keep as typed */ }
  text = text.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, MAX_FAVORITE_NAME_LENGTH).join('').trim();
}

/** The stored text, parsed. Unreadable data is no names; a newer layout is
 *  no names and locked (never written over). */
export function parseFavoriteNames(raw) {
  if (raw == null) return EMPTY;
  let value;
  try { value = JSON.parse(raw); } catch (_) { return EMPTY; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
  if (value.version !== FAVORITE_NAMES_VERSION) {
    const newer = Number.isInteger(value.version) && value.version > FAVORITE_NAMES_VERSION;
    return newer ? { names: new Map(), locked: true } : EMPTY;
  }
  const names = new Map();
  const stored = value.names;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return EMPTY;
  for (const [favoriteId, name] of Object.entries(stored)) {
    if (names.size >= MAX_FAVORITE_NAMES) break;
    if (!favoriteId || favoriteId.length > MAX_FAVORITE_ID_LENGTH) continue;
    const clean = cleanFavoriteName(name);
    if (clean) names.set(favoriteId, clean);
  }
  return { names, locked: false };
}

/** The saved names (read once per stored text). */
export function favoriteNamesSnapshot() {
  let raw = null;
  try {
    const value = storage()?.getItem(FAVORITE_NAMES_KEY);
    raw = typeof value === 'string' ? value : null;
  } catch (_) { raw = null; }
  if (cache.raw !== raw) cache = { raw, doc: parseFavoriteNames(raw) };
  return cache.doc;
}

/** A short text that changes whenever the saved names change (for caches). */
export function favoriteNamesSignature() {
  favoriteNamesSnapshot();
  return cache.raw || '';
}

/** The user's name for this favorite id, or ''. */
export function favoriteName(favoriteId) {
  if (typeof favoriteId !== 'string' || !favoriteId) return '';
  return favoriteNamesSnapshot().names.get(favoriteId) || '';
}

/** `item` as lists show it: the same object when it has no name of its own,
 *  else a copy (the same copy while the name stays) with the name as title
 *  and the station's own name as originalTitle. Only for saved favorites.
 *  A list passes `names` (favoriteNamesSnapshot().names) to read them once. */
export function withFavoriteName(item, names = favoriteNamesSnapshot().names) {
  if (!item || typeof item !== 'object' || item.__favoriteName === true) return item;
  const name = typeof item.id === 'string' ? names.get(item.id) || '' : '';
  if (!name) return item;
  const known = copies.get(item);
  if (known && known.name === name && known.title === item.title) return known.copy;
  const copy = { ...item, title: name, originalTitle: typeof item.title === 'string' ? item.title : '', __favoriteName: true };
  copies.set(item, { name, title: item.title, copy });
  return copy;
}

/** A copy made by withFavoriteName turned back into the favorite as saved
 *  (its own title, no extra fields); anything else as it is. */
export function withoutFavoriteName(item) {
  if (!item || typeof item !== 'object' || item.__favoriteName !== true) return item;
  const { originalTitle, __favoriteName, ...rest } = item;
  return { ...rest, title: typeof originalTitle === 'string' ? originalTitle : rest.title };
}

/** The text to save for `names` (a Map), or null when there are none. */
export function favoriteNamesText(names) {
  if (!names || names.size === 0) return null;
  return JSON.stringify({ version: FAVORITE_NAMES_VERSION, names: Object.fromEntries(names) });
}

/** The stored names text with favorites given new ids (`ids`: old id -> new
 *  id), for favorite-migration.js; anything unreadable comes back unchanged. */
export function favoriteNamesTextWithNewIds(raw, ids) {
  if (raw == null) return raw;
  const doc = parseFavoriteNames(raw);
  if (doc.locked || doc.names.size === 0) return raw;
  let changed = false;
  const next = new Map();
  for (const [favoriteId, name] of doc.names) {
    const moved = ids.get(favoriteId);
    if (moved && !doc.names.has(moved)) { next.set(moved, name); changed = true; }
    else if (!next.has(favoriteId)) next.set(favoriteId, name);
  }
  return changed ? favoriteNamesText(next) : raw;
}

/** Forget the parsed copy (tests, and after this module wrote the key). */
export function resetFavoriteNamesCache() {
  cache = { raw: undefined, doc: EMPTY };
}
