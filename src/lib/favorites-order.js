/**
 * Display order for saved favorites.
 *
 * Favorites are stored newest first, and that stored list is "My order": the
 * user can rearrange it by hand (state.js moveFavorite). "A-Z" only changes
 * how the list is shown; it never rewrites the stored order, so switching
 * back to "My order" restores the hand-made arrangement exactly.
 *
 * The choice lives in the settings object as `favoritesSort`. A missing or
 * unknown value means "My order", so older saved settings keep today's
 * behaviour and an older build simply ignores the field.
 */

import { isContentAllowed, showExplicitContent } from './content-rating.js';

export const FAVORITES_SORT_MANUAL = 'manual';
export const FAVORITES_SORT_NAME = 'name';

export function normalizeFavoritesSort(value) {
  return value === FAVORITES_SORT_NAME ? FAVORITES_SORT_NAME : FAVORITES_SORT_MANUAL;
}

// Case-insensitive, locale-aware, and "Radio 2" before "Radio 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' });

/** The name a favorite sorts by. A favorite hidden by the explicit-content
 *  setting is shown under a placeholder, so its real title must not decide
 *  where it appears; it sorts with the untitled ones at the end. */
function nameKey(item, settings) {
  if (!isContentAllowed(item, settings)) return '';
  return typeof item?.title === 'string' ? item.title.trim() : '';
}

/** A new array sorted by name. Equal names keep their stored order. */
export function sortFavoritesByName(favorites, settings = {}) {
  const keyed = (Array.isArray(favorites) ? favorites : [])
    .map((item, index) => ({ item, index, key: nameKey(item, settings) }));
  keyed.sort((a, b) => {
    if (Boolean(a.key) !== Boolean(b.key)) return a.key ? -1 : 1;
    return collator.compare(a.key, b.key) || a.index - b.index;
  });
  return keyed.map(({ item }) => item);
}

// One remembered result. Checking it is a single pass over the list (each
// entry, its title and rating), which is far cheaper than sorting 2,000
// names with a collator on every render. It notices a new list, an added,
// removed or moved favorite, and a title rewritten in place by metadata.
let memo = null;

function memoMatches(list, explicit) {
  if (!memo || memo.explicit !== explicit || memo.entries.length !== list.length) return false;
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const entry = memo.entries[i];
    if (item !== entry.item || item?.title !== entry.title || item?.content_rating !== entry.rating) return false;
  }
  return true;
}

/**
 * Favorites in the order every list shows them (Library Favorites, the Tuner
 * "My favorites" dial and its station strip). "My order" returns the stored
 * array itself; "A-Z" returns a sorted copy, remembered until the list or
 * the choice changes. Callers must not modify the returned array.
 */
export function favoritesInDisplayOrder(favorites, settings = {}) {
  const list = Array.isArray(favorites) ? favorites : [];
  if (normalizeFavoritesSort(settings?.favoritesSort) !== FAVORITES_SORT_NAME) return list;
  const explicit = showExplicitContent(settings);
  if (memoMatches(list, explicit)) return memo.items;
  memo = {
    explicit,
    entries: list.map((item) => ({ item, title: item?.title, rating: item?.content_rating })),
    items: sortFavoritesByName(list, settings),
  };
  return memo.items;
}
