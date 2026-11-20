/**
 * Favorites that follow a re-imported playlist to its new radio or TV type.
 *
 * A playlist channel's id is made from its type and address
 * (worldmedia_playlists.py parse_playlist). A station imported "as TV" and
 * starred, then imported again "as Radio", is therefore a new channel, and the
 * old favorite would stay a TV favorite that the Radio dial never shows.
 *
 * After a playlist is imported again under the same name, planTypeMoves()
 * finds each favorite that came from the old copy and whose channel now has
 * the other type (same address and same name), and moveFavoritesToNewIds()
 * gives it the new id: same place in "My order", same category, same own
 * equalizer curve. The favorites list, the equalizer curves and the
 * categories are written together; if any write fails, the ones already
 * written are put back and nothing changes.
 */

import { emit, getState, normalizeFavoriteItem, STORAGE_KEYS } from './state.js';
import { EQ_STORAGE_KEY, loadEqState, normalizeEqState } from './eq-store.js';
import { FAVORITE_GROUPS_EVENT, favoriteGroupsTextWithNewIds } from './favorite-groups.js';
import { favoriteNamesTextWithNewIds } from './favorite-names.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { clearPersistenceFailure } from './persistence-notice.js';

const addressKey = (item) => `${item?.stream_url || ''}\n${item?.title || ''}`;

/** Which favorites to move: Map(old favorite id -> new playlist item).
 *  `oldItems` are the playlist's channels before the import, `newItems` after.
 *  A favorite moves only when its old channel is gone, and exactly one new
 *  channel has the same address and name with the other type. A new channel
 *  that is already a favorite is left alone (nothing is merged). */
export function planTypeMoves(oldItems = [], newItems = [], favorites = []) {
  const newIds = new Set(newItems.map((item) => item.id));
  const saved = new Set(favorites.map((favorite) => favorite?.id));
  const oldById = new Map(oldItems.map((item) => [item.id, item]));
  const byAddress = new Map();
  for (const item of newItems) {
    const key = addressKey(item);
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key).push(item);
  }
  const moves = new Map();
  const taken = new Set();
  for (const favorite of favorites) {
    const old = oldById.get(favorite?.id);
    if (!old || newIds.has(old.id) || !old.stream_url) continue;
    const matches = (byAddress.get(addressKey(old)) || []).filter((item) => item.type !== old.type);
    if (matches.length !== 1) continue;
    const [match] = matches;
    if (saved.has(match.id) || taken.has(match.id)) continue;
    moves.set(old.id, match);
    taken.add(match.id);
  }
  return moves;
}

function writeAll(storage, writes) {
  const done = [];
  try {
    for (const [key, value] of writes) {
      const before = storage.getItem(key);
      if (value == null) storage.removeItem(key);
      else storage.setItem(key, value);
      done.push([key, before]);
    }
    return true;
  } catch (error) {
    console.warn('Could not move favorites to their new type:', error);
    for (const [key, before] of done.reverse()) {
      try {
        if (before == null) storage.removeItem(key);
        else storage.setItem(key, before);
      } catch (_) { /* The first failure is what gets reported. */ }
    }
    return false;
  }
}

/** Give the planned favorites their new ids. Returns { moved, failed }:
 *  moved is how many changed; failed is true when nothing could be saved
 *  (then nothing changed). One favorites-change event. */
export function moveFavoritesToNewIds(moves, storage = globalThis.localStorage) {
  const state = getState();
  const live = new Map([...moves].filter(([oldId]) => state.favorites.some((favorite) => favorite.id === oldId)));
  if (live.size === 0) return { moved: 0, failed: false };
  if (!storage) return { moved: 0, failed: true };
  const ids = new Map([...live].map(([oldId, item]) => [oldId, item.id]));
  const next = state.favorites.map((favorite) => {
    const item = live.get(favorite.id);
    return item ? (normalizeFavoriteItem(item) || favorite) : favorite;
  });
  const writes = [[STORAGE_KEYS.favorites, JSON.stringify(next)]];
  let eqRaw = null;
  try { eqRaw = storage.getItem(EQ_STORAGE_KEY); } catch (_) { eqRaw = null; }
  if (eqRaw != null) {
    const eq = loadEqState(storage);
    const curves = { ...eq.favorites };
    let changed = false;
    for (const [oldId, newId] of ids) {
      if (!Object.hasOwn(curves, oldId)) continue;
      if (!Object.hasOwn(curves, newId)) curves[newId] = curves[oldId];
      delete curves[oldId];
      changed = true;
    }
    if (changed) writes.push([EQ_STORAGE_KEY, JSON.stringify(normalizeEqState({ ...eq, favorites: curves }))]);
  }
  let groupsRaw = null;
  try { groupsRaw = storage.getItem(STORAGE_KEYS.favoriteGroups); } catch (_) { groupsRaw = null; }
  const groupsNext = favoriteGroupsTextWithNewIds(groupsRaw, ids);
  if (groupsNext !== groupsRaw) writes.push([STORAGE_KEYS.favoriteGroups, groupsNext]);
  // The user's names for them move with them too.
  let namesRaw = null;
  try { namesRaw = storage.getItem(STORAGE_KEYS.favoriteNames); } catch (_) { namesRaw = null; }
  const namesNext = favoriteNamesTextWithNewIds(namesRaw, ids);
  if (namesNext !== namesRaw) writes.push([STORAGE_KEYS.favoriteNames, namesNext]);

  const currentId = state.currentItem?.id;
  const playingMoved = Boolean(currentId) && ids.has(currentId);
  if (playingMoved) emit('eq-before-scope-change', { itemId: currentId, scope: 'global' });
  if (!writeAll(storage, writes)) {
    if (playingMoved) emit('eq-scope-change', { itemId: currentId, scope: 'favorite' });
    return { moved: 0, failed: true };
  }
  state.favorites = next;
  clearPersistenceFailure('favorites');
  scheduleProfileHandoff();
  if (groupsNext !== groupsRaw) emit(FAVORITE_GROUPS_EVENT, { action: 'move', count: ids.size });
  emit('favorites-change', state.favorites);
  if (playingMoved) emit('eq-scope-change', { itemId: currentId, scope: 'global' });
  return { moved: ids.size, failed: false };
}

/** Plain words for the import message ('' when nothing was to move). */
export function typeMoveMessage({ moved = 0, failed = false } = {}, moves = new Map()) {
  if (failed) {
    const count = moves.size;
    return count === 1
      ? ' 1 favorite could not be changed to its new radio or TV type and still points at the old entry.'
      : ` ${count} favorites could not be changed to their new radio or TV type and still point at the old entries.`;
  }
  if (!moved) return '';
  const types = new Set([...moves.values()].map((item) => item.type));
  const type = types.size === 1 ? (types.has('radio') ? 'radio' : 'TV') : '';
  return moved === 1
    ? ` 1 favorite was changed to ${type || 'its new type'} to match; its place, category and equalizer settings were kept.`
    : ` ${moved} favorites were changed to ${type || 'their new type'} to match; their place, category and equalizer settings were kept.`;
}
