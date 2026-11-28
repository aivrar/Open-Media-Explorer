/** Local-only collection pools; filters never trigger provider searches. */
import { displayFavorites, getState, isLocalFileFavorite } from '../../lib/state.js';
import { computerItemForView } from './computer.js';
import { favoriteForContentView } from '../../lib/content-rating.js';
import { favoriteNamesSnapshot, withFavoriteName } from '../../lib/favorite-names.js';
import { getPlaylistItems } from '../../lib/playlists.js';
import { view } from './state.js';

export function isPersonalSource(source = view.activeSource) {
  return source === 'favorites' || source === 'playlists';
}

export function libraryPool() {
  if (view.activeSource === 'favorites') {
    // Shown in the chosen order ("My order" or A-Z); see lib/favorites-order.js.
    // A renamed favorite is shown under its new name (lib/favorite-names.js).
    const { names } = favoriteNamesSnapshot();
    return displayFavorites().map((item) => favoriteForContentView(
      withFavoriteName(isLocalFileFavorite(item) ? computerItemForView(item) : item, names), getState().settings,
    ));
  }
  if (view.activeSource === 'playlists') return getPlaylistItems(view.playlistId);
  return view.items;
}

export function personalFilters() { return view.personalFilters[view.activeSource]; }
