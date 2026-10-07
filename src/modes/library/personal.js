/** Local-only collection pools; filters never trigger provider searches. */
import { getState } from '../../lib/state.js';
import { favoriteForContentView } from '../../lib/content-rating.js';
import { getPlaylistItems } from '../../lib/playlists.js';
import { view } from './state.js';

export function isPersonalSource(source = view.activeSource) {
  return source === 'favorites' || source === 'playlists';
}

export function libraryPool() {
  if (view.activeSource === 'favorites') {
    return getState().favorites.map((item) => favoriteForContentView(item, getState().settings));
  }
  if (view.activeSource === 'playlists') return getPlaylistItems(view.playlistId);
  return view.items;
}

export function personalFilters() { return view.personalFilters[view.activeSource]; }
