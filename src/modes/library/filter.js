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
import { isComputerItem } from '../../lib/item-model.js';
import { isContentAllowed } from '../../lib/content-rating.js';
import { isPersonalSource, personalFilters } from './personal.js';
import { normalizePersonalTypes, PERSONAL_TYPES } from './personal-types.js';
import { favoriteGroupsSnapshot, UNCATEGORIZED } from '../../lib/favorite-groups.js';

const languageAliases = new Map([
  ['en', 'eng', 'english'], ['es', 'spa', 'spanish'], ['fr', 'fra', 'fre', 'french'],
  ['de', 'deu', 'ger', 'german'], ['pt', 'por', 'portuguese'], ['it', 'ita', 'italian'],
  ['nl', 'nld', 'dut', 'dutch'], ['ru', 'rus', 'russian'], ['uk', 'ukr', 'ukrainian'],
  ['ar', 'ara', 'arabic'], ['zh', 'zho', 'chi', 'chinese'],
  ['ja', 'jpn', 'japanese'], ['ko', 'kor', 'korean'], ['hi', 'hin', 'hindi'],
  ['tr', 'tur', 'turkish'], ['pl', 'pol', 'polish'], ['sv', 'swe', 'swedish'],
].flatMap(([code, ...aliases]) => aliases.map((alias) => [alias, code])));

function languageKey(value) {
  const token = value.trim().toLowerCase();
  return languageAliases.get(token) || token;
}

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
  if (!onFavorites && !isComputerItem(it) && getState().settings.enabledSources[it.source] === false) return false;
  if (!onFavorites && it.__snapshotOffline === true) return false;

  if (personal) {
    const filters = personalFilters();
    const types = normalizePersonalTypes(filters.type);
    if (types.length > 0 && types.length < PERSONAL_TYPES.length && !types.includes(it.type)) return false;
    const query = filters.query.trim().toLocaleLowerCase();
    // A renamed favorite is found by its new name and by the station's own.
    const haystack = [it.title, it.originalTitle, it.description, ...(it.tags || [])].join(' ').toLocaleLowerCase();
    if (query && !haystack.includes(query)) return false;
  } else {
    const local = isComputerItem(it);
    const activeQ = ((local ? view.query : view.lastQuery) || '').trim();
    if (local && !activeQ) return false;
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

  if (!personal && view.filters.type && it.type !== view.filters.type) return false;
  if (view.filters.country) {
    if (!it.country || it.country.toUpperCase() !== view.filters.country.toUpperCase()) return false;
  }
  if (view.filters.language) {
    if (!it.language || languageKey(it.language) !== languageKey(view.filters.language)) return false;
  }
  if (view.filters.yearMin != null && (it.year == null || it.year < view.filters.yearMin)) return false;
  if (view.filters.yearMax != null && (it.year == null || it.year > view.filters.yearMax)) return false;
  return true;
}
