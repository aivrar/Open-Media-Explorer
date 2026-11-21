/**
 * Where "Did not play last time" is shown (did-not-play.js keeps the marks):
 * only for the user's own stations, the favorites and the stations of My
 * Playlists, wherever their cards are (Library, Tuner) and in the details
 * panel. A catalog item the user has not saved shows nothing: the catalog
 * changes all the time, and the question is which of your own stations work.
 */

import { isFavorite } from './state.js';
import { getPlaylistItems } from './playlists.js';
import { didNotPlayAt, didNotPlayText } from './did-not-play.js';

let playlistIds = { list: null, ids: new Set() };

/** True for a favorite or a station of My Playlists. */
export function isSavedItem(id) {
  if (typeof id !== 'string' || !id) return false;
  if (isFavorite(id)) return true;
  const list = getPlaylistItems();
  if (list !== playlistIds.list) {
    playlistIds = { list, ids: new Set((Array.isArray(list) ? list : []).map((item) => item?.id)) };
  }
  return playlistIds.ids.has(id);
}

/** The sentence for `item`, or '' when it played last time or is not saved. */
export function didNotPlayNote(item, { formatDate } = {}) {
  if (!item?.id || !isSavedItem(item.id)) return '';
  const at = didNotPlayAt(item.id);
  return at ? didNotPlayText(at, formatDate ? { formatDate } : {}) : '';
}
