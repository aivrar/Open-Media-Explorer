/**
 * Pure filter pipeline. Given an item and the current view state, decide
 * whether the item should be shown. No DOM, no mutation, no side effects.
 *
 * Favorites and imported playlists use independent local search/type filters,
 * without public-catalog query tags. Other tabs select the public catalog by
 * query generation, source, and type. Shared country/language/year filters
 * apply to both pools. Disabled providers never hide saved favorites.
 */

import { view } from './state.js';
import { getState } from '../../lib/state.js';
import { isContentAllowed } from '../../lib/content-rating.js';
import { isPersonalSource, personalFilters } from './personal.js';
import { favoriteGroupsSnapshot, UNCATEGORIZED } from '../../lib/favorite-groups.js';

export function filterItems(items) {
  const inCategory = favoritesCategoryTest();
  return items.filter((it) => itemPassesFilters(it, inCategory));
}

/** For the Favorites category chips: a test for "is this favorite in the
 *  chosen category", or null when no category is chosen (or it no longer
 *  exists). Reads the categories once for a whole pass. */
export function favoritesCategoryTest() {
  if (view.activeSource !== 'favorites') return null;
  const category = personalFilters()?.category || '';
  if (!category) return null;
  const groups = favoriteGroupsSnapshot();
  if (category === UNCATEGORIZED) return (id) => !groups.has(groups.groupOf(id));
  if (!groups.has(category)) return null;
  return (id) => groups.groupOf(id) === category;
}

export function itemPassesFilters(it, inCategory = favoritesCategoryTest()) {
  const onFavorites = view.activeSource === 'favorites';
  const personal = isPersonalSource();

  if (it.__contentHidden !== true && !isContentAllowed(it, getState().settings)) return false;
  if (onFavorites && inCategory && !inCategory(it.id)) return false;

  // Disabled sources disappear from the regular Library pool immediately;
  // favorites remain visible so disabling a catalog never hides saved items.
  if (!onFavorites && getState().settings.enabledSources[it.source] === false) return false;
  if (!onFavorites && it.__snapshotOffline === true) return false;

  if (personal) {
    const query = personalFilters().query.trim().toLocaleLowerCase();
    // A renamed favorite is found by its new name and by the station's own.
    const haystack = [it.title, it.originalTitle, it.description, ...(it.tags || [])].join(' ').toLocaleLowerCase();
    if (query && !haystack.includes(query)) return false;
  } else {
    const activeQ = (view.lastQuery || '').trim();
    if (activeQ) {
      const tags = Array.isArray(it.__queries)
        ? it.__queries
        : (it.__query ? [it.__query] : []);
      if (!tags.includes(activeQ)) return false;
    }
  }

  if (!personal
      && view.activeSource && view.activeSource !== 'all'
      && !view.activeSource.startsWith('type:')
      && it.source !== view.activeSource) return false;

  const type = personal ? personalFilters().type : view.filters.type;
  if (type && it.type !== type) return false;
  if (view.filters.country) {
    if (!it.country || it.country.toUpperCase() !== view.filters.country.toUpperCase()) return false;
  }
  if (view.filters.language) {
    if (!it.language || it.language.toLowerCase() !== view.filters.language.toLowerCase()) return false;
  }
  if (view.filters.yearMin != null && (it.year == null || it.year < view.filters.yearMin)) return false;
  if (view.filters.yearMax != null && (it.year == null || it.year > view.filters.yearMax)) return false;
  return true;
}
