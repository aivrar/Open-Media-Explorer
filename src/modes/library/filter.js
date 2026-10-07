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

export function filterItems(items) {
  return items.filter(itemPassesFilters);
}

export function itemPassesFilters(it) {
  const onFavorites = view.activeSource === 'favorites';
  const personal = isPersonalSource();

  if (it.__contentHidden !== true && !isContentAllowed(it, getState().settings)) return false;

  // Disabled sources disappear from the regular Library pool immediately;
  // favorites remain visible so disabling a catalog never hides saved items.
  if (!onFavorites && getState().settings.enabledSources[it.source] === false) return false;
  if (!onFavorites && it.__snapshotOffline === true) return false;

  if (personal) {
    const query = personalFilters().query.trim().toLocaleLowerCase();
    const haystack = [it.title, it.description, ...(it.tags || [])].join(' ').toLocaleLowerCase();
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
