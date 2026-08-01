/**
 * One fail-closed content-rating policy shared by every catalog surface.
 *
 * Providers may label an item, but they never control the user's preference.
 * Only the exact persisted/UI boolean `true` reveals explicit items.
 */

export const CONTENT_RATINGS = Object.freeze(['explicit', 'not-explicit', 'unrated']);

export function showExplicitContent(settingsOrValue) {
  if (settingsOrValue === true) return true;
  return settingsOrValue?.showExplicitContent === true;
}

export function isExplicitItem(item) {
  return item?.content_rating === 'explicit';
}

export function isContentAllowed(item, settingsOrValue = false) {
  return !isExplicitItem(item) || showExplicitContent(settingsOrValue);
}

export function filterContentItems(items, settingsOrValue = false) {
  if (!Array.isArray(items)) return [];
  if (showExplicitContent(settingsOrValue)) return items;
  return items.filter((item) => !isExplicitItem(item));
}

/**
 * Derive a nonrevealing, nonplayable favorite row without mutating/persisting
 * over the real favorite. Switching the preference back on therefore restores
 * the original object, media identity, and EQ association immediately.
 */
export function favoriteForContentView(item, settingsOrValue = false) {
  if (!item || isContentAllowed(item, settingsOrValue)) return item;
  return {
    id: item.id,
    source: item.source,
    type: item.type,
    title: 'Explicit favorite hidden',
    description: 'Enable explicit/NSFW content in Settings to reveal this saved favorite.',
    stream_url: '',
    stream_kind: '',
    thumbnail: '',
    year: null,
    country: '',
    language: '',
    tags: [],
    license: '',
    source_url: '',
    delivery: '',
    download_url: '',
    download_name: '',
    capture_headers: {},
    content_rating: 'explicit',
    __contentHidden: true,
  };
}

export function contentBadgeText(item) {
  return isExplicitItem(item) ? 'Explicit / NSFW' : '';
}
