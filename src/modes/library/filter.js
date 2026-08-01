/**
 * Pure filter pipeline. Given an item and the current view state, decide
 * whether the item should be shown. No DOM, no mutation, no side effects.
 *
 * Two facts drive the predicates:
 *   - The favorites POOL is rendered separately from view.items. When the
 *     active sidebar tab is 'favorites', the items here came from
 *     state.favorites and have no `__query` tag — so we skip the query
 *     filter and the source filter entirely (otherwise a search active
 *     when the user clicks Favorites would hide every favorite).
 *   - For every other tab, activeSource is either 'all', a specific source
 *     id, or 'type:x'. Type-tabs are translated into view.filters.type by
 *     selectSource, so itemPassesFilters only has to check the type filter
 *     directly.
 */

import { view } from './state.js';
import { getState } from '../../lib/state.js';
import { isContentAllowed } from '../../lib/content-rating.js';

export function filterItems(items) {
  return items.filter(itemPassesFilters);
}

export function itemPassesFilters(it) {
  const onFavorites = view.activeSource === 'favorites';

  if (it.__contentHidden !== true && !isContentAllowed(it, getState().settings)) return false;

  // Disabled sources disappear from the regular Library pool immediately;
  // favorites remain visible so disabling a catalog never hides saved items.
  if (!onFavorites && getState().settings.enabledSources[it.source] === false) return false;
  if (!onFavorites && it.__snapshotOffline === true) return false;

  if (!onFavorites) {
    const activeQ = (view.lastQuery || '').trim();
    if (activeQ) {
      const tags = Array.isArray(it.__queries)
        ? it.__queries
        : (it.__query ? [it.__query] : []);
      if (!tags.includes(activeQ)) return false;
    }
  }

  if (!onFavorites
      && view.activeSource && view.activeSource !== 'all'
      && !view.activeSource.startsWith('type:')
      && it.source !== view.activeSource) return false;

  if (view.filters.type && it.type !== view.filters.type) return false;
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
