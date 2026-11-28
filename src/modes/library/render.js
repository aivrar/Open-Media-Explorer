/**
 * The render layer. Reads state.js + filter.js, writes DOM.
 *
 * All "show something on screen" lives here — the cards grid, the stable
 * collection summary at the top of the results pane, the sentinel-status line
 * at the bottom, the sidebar counts/statuses, and the lazy-DOM render-window logic
 * that decides how many cards are actually mounted at once.
 *
 * Pure outputs: no fetching, no state mutation beyond `view.renderLimit`
 * (which is render-layer state about *how much we've drawn*, not about the
 * data we have).
 */

import {
  getState, isFavorite, isLocalFileFavorite, addFavorite, removeFavorite, moveFavorite, moveFavoriteTo,
} from '../../lib/state.js';
import { FAVORITES_SORT_MANUAL, normalizeFavoritesSort } from '../../lib/favorites-order.js';
import { favoriteGroupsSnapshot, UNCATEGORIZED } from '../../lib/favorite-groups.js';
import { syncFavoriteTitles } from './favorite-titles.js';
import { startReorderScroll } from './reorder-scroll.js';
import { buildCategoryButton, closeDetachedCategoryMenu, updateCategoryButton } from './card-category.js';
import {
  canonicalArtworkUrl, computerItemArtSource, isArtworkRelayUrl, isStationImageSource, stationImageSourceFor,
} from '../../lib/artwork.js';
import { SOURCES, getSourceLabel } from '../../lib/sources.js';
import { el, setDescriptionReference } from './utils.js';
import { artworkInitials, initialsHue } from '../../lib/initials.js';
import { stationStreamLabel, streamTooltipLine } from '../../lib/played-streams.js';
import { isComputerItem, shownLicense } from '../../lib/item-model.js';
import {
  view, renderedIds,
  RENDER_LIMIT_INITIAL, RENDER_LIMIT_STEP, RENDER_WINDOW_MAX,
  thumbHydration,
} from './state.js';
import { filterItems } from './filter.js';
import { isPersonalSource, libraryPool, personalFilters } from './personal.js';
import { normalizePersonalTypes, personalTypeFilterLabels } from './personal-types.js';
import { getPlaylistItems } from '../../lib/playlists.js';
import { carriesFiles } from '../../lib/playlist-drop.js';
import { mountPictureDropPreview } from './picture-drop.js';
import { didNotPlayNote } from '../../lib/did-not-play-view.js';
import {
  getThumbnailHydrationSignal, insertThumbImage, requestThumbnailHydration,
  resetThumbnailHydrationScope,
  THUMBNAIL_EAGER_CARD_COUNT,
} from './thumbnails.js';
import { openDetail } from './detail.js';
import { COMPUTER_OFFLINE_TOOLTIP } from '../../lib/computer-play.js';
import { computerCardSubtitle, playLibraryItem } from './computer.js';
import { syncComputerSource } from './sidebar.js';
import {
  contentBadgeText,
} from '../../lib/content-rating.js';

// Shared shell refs — set by shell.js once, read here.
import { ui } from './shell-refs.js';

const SOURCE_ID_SET = new Set(SOURCES.map((source) => source.id));

let filteredCache = {
  pool: null,
  poolLength: 0,
  context: '',
  revision: -1,
  items: [],
};

let filteredComputerCache = { hits: null, context: '', items: [] };

function filterContextSignature() {
  const settings = getState().settings;
  return JSON.stringify([
    view.activeSource,
    view.playlistId,
    isPersonalSource() ? personalFilters() : null,
    view.filters.type,
    view.filters.country,
    view.filters.language,
    view.filters.yearMin,
    view.filters.yearMax,
    settings.showExplicitContent === true,
    SOURCES.map((source) => settings.enabledSources[source.id] !== false ? 1 : 0).join(''),
  ]);
}

/** Cache the current filtered pool and inspect only appended pages while the
 * filter context is unchanged. Destructive/snapshot mutations force one full
 * pass, while ordinary continuous collection stays proportional to page size. */
export function filteredItemsForCurrentView(pool = view.items) {
  const context = filterContextSignature();
  const items = filteredProviderOrPersonalItems(pool, context + (view.lastQuery || '').trim());
  if (isPersonalSource() || pool !== view.items || !view.computerHits.length) return items;
  const localContext = context + (view.query || '').trim();
  if (filteredComputerCache.hits !== view.computerHits || filteredComputerCache.context !== localContext) {
    filteredComputerCache = { hits: view.computerHits, context: localContext, items: filterItems(view.computerHits) };
  }
  const local = filteredComputerCache.items;
  return local.length ? [...local, ...items] : items;
}

function filteredProviderOrPersonalItems(pool, context) {
  const revision = Number(view.catalogRevision) || 0;
  if (filteredCache.pool === pool && filteredCache.context === context) {
    if (filteredCache.revision === revision && filteredCache.poolLength === pool.length) {
      return filteredCache.items;
    }
    const appendOnly = filteredCache.revision >= (Number(view.catalogNonAppendRevision) || 0)
      && pool.length >= filteredCache.poolLength;
    if (appendOnly) {
      const appended = filterItems(pool.slice(filteredCache.poolLength));
      filteredCache.items.push(...appended);
      filteredCache.poolLength = pool.length;
      filteredCache.revision = revision;
      return filteredCache.items;
    }
  }
  filteredCache = {
    pool,
    poolLength: pool.length,
    context,
    revision,
    items: filterItems(pool),
  };
  return filteredCache.items;
}

/* ============ Cards grid + render window ============ */

// The window start the mounted cards were drawn for.
let lastRenderStart = 0;
let lastRenderHost = null;
let lastCollection = '';
let filterView = null;
let filterAnchor = null;
let pendingFilterRestore = null;
let lastRenderWasFiltered = false;
let stopCardAnchorRestore = null;

function hasBoxFilters() {
  const { country, language, yearMin, yearMax } = view.filters;
  return Boolean(country || language || yearMin != null || yearMax != null);
}

function dropPendingFilterRestore() {
  pendingFilterRestore?.stopWatching();
  pendingFilterRestore = null;
}

/** Observe search input immediately, even when the catalog render is debounced. */
export function syncFilterAnchor() {
  const personal = isPersonalSource() ? personalFilters() : null;
  const scope = JSON.stringify([
    view.activeSource, view.playlistId, view.filters.type,
    personal?.type, personal?.category,
    view.activeSource === 'favorites' ? normalizeFavoritesSort(getState().settings.favoritesSort) : null,
  ]);
  const query = personal ? personal.query : view.query;
  const typed = hasBoxFilters() || Boolean(query?.trim());
  const context = JSON.stringify([
    scope, query, view.filters.country, view.filters.language, view.filters.yearMin, view.filters.yearMax,
    getState().settings.showExplicitContent === true,
  ]);
  if (filterView?.context !== context || filterView?.host !== ui.resultsHost) {
    stopCardAnchorRestore?.();
    dropPendingFilterRestore();
  }
  if (!filterView || filterView.host !== ui.resultsHost || filterView.scope !== scope) {
    filterAnchor = null;
    filterView = { host: ui.resultsHost, scope, typed, baseItems: null };
  } else if (typed !== filterView.typed) {
    filterView.typed = typed;
    if (typed) {
      const anchor = filterView.baseItems && captureCardAnchor();
      filterAnchor = anchor ? { anchor, order: filterView.baseItems.map(({ id }) => id), missing: false } : null;
    } else if (filterAnchor) {
      pendingFilterRestore = {
        ...filterAnchor, until: Date.now() + 2000, initial: true,
        stopWatching: watchScrollInput(filterAnchor.anchor.scroller, dropPendingFilterRestore),
      };
      filterAnchor = null;
    }
  }
  filterView.context = context;
}

function survivingNeighbour(order, id, items) {
  const oldIndex = order.indexOf(id);
  if (oldIndex < 0 || items.length === 0) return -1;
  const positions = new Map(items.map((item, index) => [item.id, index]));
  for (let distance = 1; distance < order.length; distance++) {
    const index = positions.get(order[oldIndex - distance]) ?? positions.get(order[oldIndex + distance]);
    if (index != null) return index;
  }
  return -1;
}

/** Read the mounted grid before its contents or width change. */
export function captureCardAnchor(itemId = null, { viewport = false } = {}) {
  const scroller = ui.resultsHost?.parentNode;
  const bounds = scroller?.getBoundingClientRect?.();
  if (!bounds) return null;
  const card = itemId ? mountedCard(itemId) : Array.from(ui.resultsHost.children).find((node) => {
    if (!node.dataset?.id) return false;
    const rect = node.getBoundingClientRect?.();
    return rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  const rect = card?.getBoundingClientRect?.();
  return rect ? { id: card.dataset.id, offset: rect.top - (viewport ? 0 : bounds.top), scroller, viewport } : null;
}

function alignCardAnchor(anchor) {
  if (!anchor || anchor.scroller !== ui.resultsHost?.parentNode) return false;
  const rect = mountedCard(anchor.id)?.getBoundingClientRect?.();
  if (!rect) return false;
  const { scroller } = anchor;
  const delta = rect.top - (anchor.viewport ? 0 : scroller.getBoundingClientRect().top) - anchor.offset;
  if (Math.abs(delta) > 1) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  return true;
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function watchScrollInput(scroller, stop) {
  const keyTarget = scroller.ownerDocument || scroller;
  const onKey = (event) => {
    if (SCROLL_KEYS.has(event.key) && !event.target?.closest?.('input, textarea, select, [contenteditable]')) stop();
  };
  const onPointer = (event) => {
    if (event.target === scroller || event.button === 1) stop();
  };
  const passiveCapture = { passive: true, capture: true };
  scroller.addEventListener('wheel', stop, passiveCapture);
  scroller.addEventListener('touchmove', stop, passiveCapture);
  scroller.addEventListener('pointerdown', onPointer, passiveCapture);
  keyTarget.addEventListener('keydown', onKey, passiveCapture);
  return () => {
    scroller.removeEventListener('wheel', stop, passiveCapture);
    scroller.removeEventListener('touchmove', stop, passiveCapture);
    scroller.removeEventListener('pointerdown', onPointer, passiveCapture);
    keyTarget.removeEventListener('keydown', onKey, passiveCapture);
  };
}

/** Hold the offset through the first few layouts after a filter or pane change. */
export function restoreCardAnchor(anchor) {
  stopCardAnchorRestore?.();
  if (!anchor || anchor.scroller !== ui.resultsHost?.parentNode) return false;
  if (typeof requestAnimationFrame !== 'function') return alignCardAnchor(anchor);

  const grid = ui.resultsHost;
  const { scroller } = anchor;
  scroller.classList.add('is-restoring-anchor');
  if (!alignCardAnchor(anchor)) {
    scroller.classList.remove('is-restoring-anchor');
    return false;
  }

  let expectedScrollTop = scroller.scrollTop;
  let frame;
  const stop = () => {
    if (stopCardAnchorRestore !== stop) return;
    stopCardAnchorRestore = null;
    globalThis.cancelAnimationFrame?.(frame);
    for (const timer of timers) clearTimeout(timer);
    observer?.disconnect();
    stopWatchingInput();
    scroller.removeEventListener('scroll', onScroll);
    scroller.classList.remove('is-restoring-anchor');
  };
  const check = () => {
    if (stopCardAnchorRestore !== stop) return;
    if (grid.isConnected === false || grid !== ui.resultsHost || !alignCardAnchor(anchor)) {
      stop();
      return;
    }
    expectedScrollTop = scroller.scrollTop;
  };
  const onScroll = () => {
    // Native scrollbar drags can scroll without a pointer event reaching the page.
    // A smaller grid can also clamp a scroll we set, which the next check corrects.
    const maximum = scroller.scrollHeight - scroller.clientHeight;
    const expected = Math.min(expectedScrollTop, Math.max(0, maximum));
    if (Math.abs(scroller.scrollTop - expected) > 1) stop();
  };
  const stopWatchingInput = watchScrollInput(scroller, stop);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
  const timers = [setTimeout(check, 250), setTimeout(check, 600), setTimeout(stop, 1000)];
  stopCardAnchorRestore = stop;
  observer?.observe(grid);
  frame = requestAnimationFrame(() => {
    check();
    if (stopCardAnchorRestore === stop) frame = requestAnimationFrame(check);
  });
  return true;
}

/** Keep enough of the old video clearance to avoid clamping the scroll when
 * a smaller picture arrives or the player releases its reservation. */
export function bindLibraryVideoClearance(scroller) {
  const app = scroller?.closest?.('#app');
  if (!app || typeof MutationObserver !== 'function') return () => {};
  let reserved = 0;
  const sync = () => {
    // The computed scroll padding resolves the same length used by the CSS.
    const actual = Math.ceil(parseFloat(getComputedStyle(scroller).scrollPaddingBottom) || 0);
    if (reserved === actual) return;
    const lostSpace = reserved - actual;
    if (lostSpace > 0 && scroller.scrollTop > Math.max(0, scroller.scrollHeight - scroller.clientHeight - lostSpace)) return;
    reserved = actual;
    scroller.style.setProperty('--library-video-clearance', `${reserved}px`);
  };
  const observer = new MutationObserver(sync);
  observer.observe(app, { attributes: true, attributeFilter: ['class', 'style', 'data-video-clearance'] });
  const layout = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
  layout?.observe(scroller);
  layout?.observe(ui.resultsHost);
  scroller.addEventListener('scroll', sync, { passive: true });
  sync();
  return () => {
    observer.disconnect();
    layout?.disconnect();
    scroller.removeEventListener('scroll', sync);
  };
}

export function renderResults() {
  syncFilterAnchor();
  syncComputerSource();
  // Favorites is its own pool (kept in state)
  // and lives outside the regular accumulating view.items. This keeps a
  // visit to Favorites from polluting your browse pool, and means clearing
  // the search box doesn't wipe what you favorited.
  const pool = libraryPool();
  const filtered = filteredItemsForCurrentView(pool);
  const exportButton = view.activeSource === 'favorites' ? ui.favoritesExport
    : view.activeSource === 'playlists' ? ui.playlistExport : null;
  if (exportButton) {
    exportButton.disabled = !filtered.some((item) => item.__contentHidden !== true && !isLocalFileFavorite(item));
    exportButton.title = exportButton.disabled ? 'No items match this view.' : 'Export the items shown';
  }
  updateFilterCount(filtered);
  const collection = JSON.stringify([view.activeSource, view.playlistId]);
  const sameHost = ui.resultsHost === lastRenderHost;
  const sameCollection = sameHost && collection === lastCollection;
  lastRenderHost = ui.resultsHost;
  lastCollection = collection;
  const signature = JSON.stringify([
    collection, view.computerHits.length ? (view.query || '').trim() : '', view.lastQuery, view.filters.type, view.filters.country,
    isPersonalSource() ? personalFilters() : null,
    view.filters.language, view.filters.yearMin, view.filters.yearMax,
    getState().settings.showExplicitContent === true,
  ]);
  const signatureChanged = signature !== view.renderSignature;
  if (favoriteDrag && (signatureChanged || !favoritesManualOrder()
      || !filtered.some((item) => item.id === favoriteDrag.id))) endFavoriteDrag(false);
  // The applied catalog query can lag behind the search box during debounce.
  const showingFiltered = hasBoxFilters() || Boolean((isPersonalSource()
    ? personalFilters().query : view.lastQuery)?.trim() || (view.computerHits.length && view.query?.trim()));
  const wasFiltered = lastRenderWasFiltered;
  lastRenderWasFiltered = showingFiltered;
  filterView.baseItems = showingFiltered ? null : filtered;

  const pending = pendingFilterRestore;
  const canRetry = pending && Date.now() <= pending.until;
  if (pending && !pending.initial && !canRetry) dropPendingFilterRestore();
  const clearing = !showingFiltered && pending?.initial;
  const retrying = !showingFiltered && !pending?.initial && canRetry;
  const filterIndex = filterAnchor ? filtered.findIndex((item) => item.id === filterAnchor.anchor.id) : -1;
  const filtering = filterAnchor && (signatureChanged || filterAnchor.missing !== (filterIndex < 0));
  let anchor = clearing || retrying ? pending.anchor : filtering ? filterAnchor.anchor
    : signatureChanged && sameCollection && !showingFiltered && !wasFiltered ? captureCardAnchor() : null;
  let anchorIndex = filtering ? filterIndex : anchor ? filtered.findIndex(({ id }) => id === anchor.id) : -1;
  const originalFound = anchorIndex >= 0;
  if (clearing && !originalFound) {
    anchorIndex = survivingNeighbour(pending.order, anchor.id, filtered);
    if (anchorIndex >= 0) anchor = { ...anchor, id: filtered[anchorIndex].id };
  }
  const resetWindow = signatureChanged || clearing || filtering || (retrying && originalFound);
  view.renderLimit = Math.min(RENDER_WINDOW_MAX, view.renderLimit || RENDER_LIMIT_INITIAL);
  const limit = favoriteDrag?.limit ?? view.renderLimit;
  if (resetWindow) {
    view.renderSignature = signature;
    view.renderStart = anchorIndex < limit ? 0 : anchorIndex - Math.floor(limit / 3);
  }
  const maximumStart = Math.max(0, filtered.length - limit);
  view.renderStart = Math.max(0, Math.min(view.renderStart || 0, maximumStart));
  const visible = filtered.slice(view.renderStart, view.renderStart + limit);
  const windowMoved = view.renderStart !== lastRenderStart;
  lastRenderStart = view.renderStart;
  if (ui.windowBack) {
    ui.windowBack.style.display = view.renderStart > 0 ? 'inline-flex' : 'none';
    ui.windowBack.textContent = view.renderStart > 0
      ? `Show earlier items (currently ${view.renderStart + 1}-${view.renderStart + visible.length})`
      : 'Show earlier items';
  }
  const cards = ui.resultsHost.children;
  const outOfOrder = renderedIds.size > visible.length || Array.from(cards).some((card, i) => (
    card.dataset?.id && (card.dataset.id !== visible[i]?.id
      || Number(card.dataset.revision || 0) !== Number(visible[i]?.__revision || 0))
  ));
  const refreshAnchor = outOfOrder && sameCollection && !resetWindow && !windowMoved
    && !stopCardAnchorRestore && view.activeSource !== 'favorites' ? captureCardAnchor() : null;
  if (outOfOrder && (!sameCollection || !reconcileCardsInPlace(visible))) {
    thumbHydration.observer?.disconnect();
    thumbHydration.observer = null;
    thumbHydration.observerRoot = null;
    resetThumbnailHydrationScope();
    ui.resultsHost.innerHTML = '';
    renderedIds.clear();
  }
  const restoreScroll = () => {
    const target = (anchorIndex >= 0 ? anchor : null) || refreshAnchor;
    const restored = clearing || (retrying && originalFound) ? restoreCardAnchor(target) : alignCardAnchor(target);
    if (!restored && sameHost && resetWindow && ui.resultsHost.parentNode) ui.resultsHost.parentNode.scrollTop = 0;
    if (filtering) filterAnchor.missing = !originalFound;
    if (clearing && !originalFound && canRetry) {
      pending.initial = false;
    } else if (clearing || (retrying && originalFound)) {
      dropPendingFilterRestore();
    }
  };

  if (visible.length === 0) {
    closeDetachedCategoryMenu();
    // Settled is judged on this view's own sources: the global loading flags
    // also cover background prefetch of every other source (and, during a
    // search, browse pages that have nothing to do with the results shown).
    const onlyHolds = viewWaitsOnlyOnHolds();
    // Every source this view still needs failed its quick retries and is now
    // asked again only every few minutes: say so instead of an empty page.
    const slowSources = onlyHolds ? [] : viewSlowRetrySources();
    if (isPersonalSource() || onlyHolds || slowSources.length > 0 || !viewHasPendingSources()) {
      // Hold notices explain the empty page only when nothing else is pending.
      const notices = onlyHolds ? currentSourceNotices() : [];
      const sourceOff = getState().settings.enabledSources[view.activeSource] === false;
      const title = sourceOff ? 'Source is off'
        : slowSources.length > 0 ? notAnsweringText(slowSources) : 'No matching items';
      const message = sourceOff ? 'Turn it on in Settings under Sources.'
        : slowSources.length > 0
        ? 'World Media tries again by itself every few minutes. Retry now, below, tries at once.'
        : notices.length > 0 ? notices.join(' ') : isPersonalSource()
        ? personalEmptyMessage() : view.query
        ? `Try a different search term, or pick a different source.`
        : `Type a search above, or browse a single source on the left.`;
      const key = slowSources.length > 0 ? `${title} ${message}` : message;
      // An empty view left over from another tab keeps its own message; replace it.
      if (ui.resultsHost.querySelector('.empty-state')?.getAttribute('data-message') !== key) {
        ui.resultsHost.innerHTML = '';
        renderedIds.clear();
        const empty = el('div', { className: 'empty-state', attrs: { 'data-message': key } });
        empty.appendChild(el('h3', { text: title }));
        empty.appendChild(el('p', { text: message }));
        ui.resultsHost.appendChild(empty);
      }
    } else {
      // Something for this view is still on its way (a first page, a search,
      // or loading again after a hold): no "No matching items" meanwhile.
      ui.resultsHost.querySelector('.empty-state')?.remove();
    }
    restoreScroll();
    return;
  }

  const stale = ui.resultsHost.querySelector('.empty-state');
  if (stale) stale.remove();
  const refocus = refreshChangedCards(visible);

  // Append only the items we haven't already mounted. Use a document
  // fragment so one reflow handles the whole batch.
  const frag = document.createDocumentFragment();
  for (const [index, it] of visible.entries()) {
    if (renderedIds.has(it.id)) continue;
    frag.appendChild(renderCard(it, { eagerArtwork: index < THUMBNAIL_EAGER_CARD_COUNT }));
    renderedIds.add(it.id);
  }
  if (frag.childNodes.length > 0) ui.resultsHost.appendChild(frag);
  if (view.activeSource === 'favorites') syncFavoriteTitles();
  syncFavoriteCategoryControls();
  syncFavoriteOrderControls(filtered);
  syncDidNotPlayMarks();
  syncStreamLabels();
  refocus?.();
  restoreScroll();
}

/* ============ "Did not play last time" mark ============ */

let troubleMarkCount = 0;

/** Give a card the small "Did not play last time" mark when its station is
 *  one of the user's own (did-not-play-view.js) and its last start did not
 *  play, or take it off. The mark sits on the picture, inside the card's
 *  button, so a click on it plays the station as always; its sentence is the
 *  tooltip and the button's accessible description. */
function setCardTroubleMark(card) {
  const item = card?.__item;
  if (!item || !card.__thumb) return;
  const text = didNotPlayNote(item);
  let mark = card.__trouble || null;
  if (!text) {
    if (!mark) return;
    mark.remove();
    card.__trouble = null;
    setDescriptionReference(card.__open, mark.getAttribute('id'), false);
    card.classList?.remove?.('has-trouble');
    return;
  }
  if (!mark) {
    troubleMarkCount += 1;
    mark = el('span', {
      className: 'card-trouble',
      text: '!',
      attrs: { role: 'img', id: `card-trouble-${troubleMarkCount}` },
    });
    card.__thumb.appendChild(mark);
    card.__trouble = mark;
    card.classList?.add?.('has-trouble');
  }
  if (mark.getAttribute('aria-label') !== text) {
    mark.setAttribute('aria-label', text);
    mark.setAttribute('title', text);
  }
  setDescriptionReference(card.__open, mark.getAttribute('id'), true);
}

/** Bring the marks of every mounted card in line with the stored results.
 *  Only the marks change; the cards and their pictures are left alone. */
export function syncDidNotPlayMarks() {
  if (!ui.resultsHost?.children) return;
  for (const card of ui.resultsHost.children) {
    if (card.dataset?.id) setCardTroubleMark(card);
  }
}

/* ============ Stream format and bitrate ============ */

/** Update the stream label in its own row and in the card's tooltip. */
function setCardStream(card) {
  const item = card?.__item;
  if (!item || !card.__meta) return;
  const quality = stationStreamLabel(item);
  const title = item.__computerOffline ? COMPUTER_OFFLINE_TOOLTIP : item.title || 'Untitled';
  if (card.__streamShown && card.__streamShown.quality === quality && card.__streamShown.title === title) return;
  card.__streamShown = { quality, title };
  const streamLine = streamTooltipLine(quality);
  card.__quality?.remove();
  card.__quality = quality
    ? el('span', { className: 'card-quality', text: quality, attrs: { title: streamLine } })
    : null;
  if (card.__quality) card.__meta.appendChild(card.__quality);
  const tooltip = item.__computerOffline ? title : [title, streamLine].filter(Boolean).join('\n');
  card.__open?.setAttribute?.('title', tooltip);
  card.__titleNode?.setAttribute?.('title', tooltip);
}

/** Bring every mounted card's stream format and bitrate in line with what
 *  is remembered. */
export function syncStreamLabels() {
  if (!ui.resultsHost?.children) return;
  for (const card of ui.resultsHost.children) {
    if (card.dataset?.id) setCardStream(card);
  }
}

const typeList = new Intl.ListFormat('en', { type: 'disjunction' });

/** What an empty Favorites or My Playlists view says. */
function personalEmptyMessage() {
  const { type, category } = personalFilters();
  const labels = personalTypeFilterLabels(type).map((label) => label === 'TV' ? label : label.toLowerCase());
  const prefix = labels.length ? `${typeList.format(labels)} ` : '';
  if (view.activeSource === 'playlists') {
    const hint = 'Import a playlist above, or clear your filters.';
    return prefix ? `No ${prefix}channels match. ${hint}` : hint;
  }
  if (category === UNCATEGORIZED) {
    return `No uncategorized ${prefix}favorites match. Choose All categories, or clear your filters.`;
  }
  if (category && favoriteGroupsSnapshot().has(category)) {
    return `No ${prefix}favorites in this category match. Use the category button on a favorite to put it here, or clear your filters.`;
  }
  const hint = 'Star items to save them here, or clear your filters.';
  return prefix ? `No ${prefix}favorites match. ${hint}` : hint;
}

/** What a card shows, apart from artwork (see artworkIdentity). */
function cardContentKey(item) {
  return JSON.stringify([
    item.title || '', item.originalTitle || '', item.source || '', item.type || '', item.year || '', item.country || '',
    item.license || '', item.content_rating || '', item.__contentHidden === true, Number(item.__revision) || 0,
    item.__computerMissing === true, item.__computerOffline === true, isComputerItem(item) ? computerCardSubtitle(item) : '',
  ]);
}

/** The provider artwork a card stands for. Session relay URLs are left out:
 *  hydration swaps an item's own thumbnail for a relay (and blanks it while
 *  it works), which the card already handles without being rebuilt. */
function artworkIdentity(item) {
  if (item?.__contentHidden === true) return '';
  if (isComputerItem(item)) return computerItemArtSource(item);
  // The user's own station picture stands in for the provider artwork.
  return stationImageSourceFor(item)
    || canonicalArtworkUrl(item?._extra?.artworkUrl) || canonicalArtworkUrl(item?.thumbnail) || '';
}

function rememberShown(card, item) {
  card.__shown = { item, key: cardContentKey(item), artwork: artworkIdentity(item) };
}

/** True when a mounted card no longer matches its item: a new title, type,
 *  rating, other shown text, or different artwork (for example after a
 *  favorite's metadata was saved again without a new __revision). */
function cardIsStale(card, item) {
  const shown = card.__shown;
  if (!shown) return false;
  if (shown.key !== cardContentKey(item)) return true;
  const artwork = artworkIdentity(item);
  if (artwork === shown.artwork) return false;
  // A station picture added, changed, removed or failed: redraw this card.
  if (isStationImageSource(artwork) || isStationImageSource(shown.artwork)) return true;
  if (!artwork) {
    // Still artwork: a session relay image (its provider URL is not always
    // kept), or one a saved favorite will fetch again (needsArtwork).
    if (isArtworkRelayUrl(item.thumbnail) || item._extra?.needsArtwork === true) return false;
    // A card shows an image only once its lookup has finished, so without
    // one this is the brief blank of a lookup still running: nothing to drop.
    // With one, the artwork is really gone: redraw to the initials tile.
    return Boolean(card.__thumb?.querySelector?.('img'));
  }
  // The card's own item found its artwork; the card has already shown it.
  if (!shown.artwork && shown.item === item) {
    shown.artwork = artwork;
    return false;
  }
  return true;
}

/** Rebuild just the mounted cards whose item changed, in place. The others
 *  (and their loaded artwork) are left alone, but take the current item
 *  object, so opening, playing, starring and moving always act on it (a
 *  replacement can differ only in data the card does not show, such as its
 *  stream URL). Returns a function that puts focus back on the matching
 *  control of a rebuilt card, to be called once the move buttons are synced,
 *  or null. */
function refreshChangedCards(visible) {
  const host = ui.resultsHost;
  if (!host?.children || renderedIds.size === 0) return null;
  const canReplace = typeof host.insertBefore === 'function';
  const items = new Map(visible.map((item, index) => [item.id, { item, index }]));
  const focused = globalThis.document?.activeElement || null;
  let refocus = null;
  for (const card of [...host.children]) {
    const entry = items.get(card.dataset?.id);
    if (!entry) continue;
    if (card === favoriteDrag?.card || !canReplace || !cardIsStale(card, entry.item)) {
      card.__item = entry.item;
      continue;
    }
    const fresh = renderCard(entry.item, { eagerArtwork: entry.index < THUMBNAIL_EAGER_CARD_COUNT });
    let held = null;
    for (let node = focused; node; node = node.parentNode) if (node === card) { held = focused; break; }
    retireCardArtwork(card);
    host.insertBefore(fresh, card);
    card.remove();
    if (held) refocus = () => matchingControl(fresh, held)?.focus?.({ preventScroll: true });
  }
  return refocus;
}

/** The control in a rebuilt card that does what `old` did in the old card. */
function matchingControl(card, old) {
  const direction = old.getAttribute?.('data-move');
  if (direction) return card.__orderControls?.__buttons?.[direction] || null;
  if (old.className?.startsWith?.('card-star')) return card.__star || null;
  if (old.className?.startsWith?.('card-category')) return card.__categoryButton || null;
  return card.children?.[0] || null;
}

/** Bring the mounted cards in line with `visible` without rebuilding them:
 *  drop the cards no longer shown, create the missing ones, and move the rest
 *  into place (only the cards that are out of place move). Returns false,
 *  leaving the DOM untouched, when a full rebuild is needed instead. */
function reconcileCardsInPlace(visible) {
  const host = ui.resultsHost;
  if (typeof host?.insertBefore !== 'function') return false;
  const wanted = new Map(visible.map((item) => [item.id, item]));
  const cards = [...host.children];
  if (cards.some((card) => !card.dataset?.id)) return false;
  const scroller = host.parentNode;
  const scrollTop = scroller?.scrollTop;
  const focused = globalThis.document?.activeElement;
  const mounted = new Map();
  for (const card of cards) {
    if (wanted.has(card.dataset.id)) {
      mounted.set(card.dataset.id, card);
      continue;
    }
    retireCardArtwork(card);
    card.remove();
    renderedIds.delete(card.dataset.id);
  }
  for (const [index, item] of visible.entries()) {
    let card = mounted.get(item.id);
    if (!card) {
      card = renderCard(item, { eagerArtwork: index < THUMBNAIL_EAGER_CARD_COUNT });
      renderedIds.add(item.id);
    }
    const current = host.children[index] || null;
    if (current === card) continue;
    if (card.parentNode === host && host.moveBefore) host.moveBefore(card, current);
    else host.insertBefore(card, current);
  }
  if (typeof scrollTop === 'number' && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  // Moving a node in the DOM drops its focus; put it back on the same control.
  if (focused?.isConnected && globalThis.document.activeElement !== focused) {
    focused.focus?.({ preventScroll: true });
  }
  return true;
}

/* ============ Favorites category button ============ */

/** Give each mounted Favorites card its category button (see
 *  card-category.js), named after its current category, and take it off cards
 *  shown anywhere else. Like the move buttons this runs in every view, because
 *  a card reused from Favorites (same item, same place) must lose it there.
 *  The button goes in before the move buttons and the star, matching the
 *  layout from left to right. */
function syncFavoriteCategoryControls() {
  if (!ui.resultsHost?.children) return;
  const favorites = view.activeSource === 'favorites';
  const groups = favorites ? favoriteGroupsSnapshot() : null;
  for (const card of ui.resultsHost.children) {
    if (!card.dataset?.id) continue;
    let button = card.__categoryButton || null;
    if (!favorites || isLocalFileFavorite(card.__item)) {
      if (button) {
        button.remove();
        card.__categoryButton = null;
        card.classList.remove('has-category-control');
      }
      continue;
    }
    const item = card.__item;
    if (!item) continue;
    if (!button) {
      button = buildCategoryButton(card, item);
      card.__categoryButton = button;
      const before = card.__orderControls || card.__star;
      if (before && typeof card.insertBefore === 'function') card.insertBefore(button, before);
      else card.appendChild(button);
      card.classList.add('has-category-control');
    }
    updateCategoryButton(button, item, groups);
  }
  closeDetachedCategoryMenu();
}

/* ============ Favorites "My order" controls ============ */

const MOVE_ACTIONS = [
  { direction: 'top', label: (title) => `Move ${title} to top`, tip: 'Move to top',
    icon: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5h12M7 14l5-5 5 5M12 9v11"/></svg>' },
  { direction: 'up', label: (title) => `Move ${title} up`, tip: 'Move up',
    icon: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>' },
  { direction: 'down', label: (title) => `Move ${title} down`, tip: 'Move down',
    icon: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' },
  { direction: 'bottom', label: (title) => `Move ${title} to bottom`, tip: 'Move to bottom',
    icon: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 19h12M7 10l5 5 5-5M12 15V4"/></svg>' },
];

/** True when Favorites cards offer the move buttons ("My order" only). */
export function favoritesManualOrder() {
  return view.activeSource === 'favorites'
    && normalizeFavoritesSort(getState().settings.favoritesSort) === FAVORITES_SORT_MANUAL;
}

function buildOrderControls(item, card) {
  const title = item.title || 'Untitled';
  const group = el('div', { className: 'card-order' });
  group.__buttons = {};
  for (const action of MOVE_ACTIONS) {
    const button = el('button', {
      className: 'card-order-btn',
      attrs: { type: 'button', 'data-move': action.direction, 'aria-label': action.label(title), title: action.tip },
      html: action.icon,
      on: { click: (event) => {
        event.stopPropagation();
        onMoveFavorite((card?.__item || item).id, action.direction, button);
      } },
    });
    group.__buttons[action.direction] = button;
    group.appendChild(button);
  }
  return group;
}

function setMoveEnabled(button, enabled) {
  if (!button) return;
  if (enabled) button.removeAttribute('aria-disabled');
  else button.setAttribute('aria-disabled', 'true');
}

/* Dragging a card in "My order" onto another card puts it in that card's
   place, wherever on the card it is dropped. Only the cards shown take part,
   so it works the same with a type, search or category filter. The move
   buttons stay the keyboard way to do the same. The results host handles
   reordering and the active drag tracks scrolling across the document. */

export const FAVORITE_DRAG_TYPE = 'application/x-worldmedia-favorite';
const boundDragHosts = new WeakSet();
let favoriteDrag = null;
let shownFavoritePositions = new Map(); // id -> place in the shown order

/** Where a card dropped on another goes so that it takes the target's place
 *  in the shown order (`order`: ids in shown order, or a Map id -> index):
 *  coming from later in the order it goes before the target, coming from
 *  earlier it goes after it. '' when either is not shown or they are one. */
export function favoriteDropPlace(order, draggedId, targetId) {
  const positions = order instanceof Map ? order : new Map((order || []).map((id, index) => [id, index]));
  const from = positions.get(draggedId);
  const to = positions.get(targetId);
  if (from === undefined || to === undefined || from === to) return '';
  return from > to ? 'before' : 'after';
}

function dragCardOf(target) {
  const card = target?.closest?.('.card[data-id]');
  return card && ui.resultsHost?.contains?.(card) ? card : null;
}

/** True while one of this page's favorite cards is being dragged. A drag
 *  that carries files (a playlist dropped on the window) never is. */
function isFavoriteDrag(event) {
  return Boolean(favoriteDrag) && !carriesFiles(event?.dataTransfer);
}

function clearDropMark() {
  const marked = favoriteDrag?.marked;
  if (!marked) return;
  marked.classList.remove('drop-before', 'drop-after');
  favoriteDrag.marked = null;
  favoriteDrag.place = '';
}

function endFavoriteDrag(restoreWindow = true) {
  if (!favoriteDrag) return;
  clearDropMark();
  const { card, limit, scroller, stopScroll } = favoriteDrag;
  stopScroll?.();
  card.classList.remove('is-dragging');
  favoriteDrag = null;
  if (!restoreWindow || !limit) return;

  // Return to the bounded render window around the part of the list reached.
  const top = scroller.getBoundingClientRect().top;
  const anchor = [...ui.resultsHost.children].find((node) => node.getBoundingClientRect().bottom > top);
  const index = shownFavoritePositions.get(anchor?.dataset.id);
  const offset = anchor?.getBoundingClientRect().top;
  if (index !== undefined) view.renderStart = Math.max(0, index - Math.floor(view.renderLimit / 3));
  renderResults();
  const mounted = anchor && mountedCard(anchor.dataset.id);
  if (mounted) scroller.scrollTop += mounted.getBoundingClientRect().top - offset;
  updateSentinelStatus();
}

function canExtendFavoriteDrag(speed) {
  const start = view.renderStart;
  const limit = favoriteDrag.limit ?? view.renderLimit;
  return speed < 0 ? start > 0 : start + limit < shownFavoritePositions.size;
}

function extendFavoriteDrag(speed) {
  // Grow the mounted slice during the drag so the native source stays in the DOM.
  const { scroller } = favoriteDrag;
  const anchor = ui.resultsHost.children[0];
  const top = anchor.getBoundingClientRect().top;
  const start = view.renderStart;
  const limit = favoriteDrag.limit ?? view.renderLimit;
  if (speed < 0) view.renderStart = Math.max(0, start - RENDER_LIMIT_STEP);
  const added = speed < 0 ? start - view.renderStart
    : Math.min(RENDER_LIMIT_STEP, shownFavoritePositions.size - start - limit);
  favoriteDrag.limit = limit + added;
  renderResults();
  if (speed < 0) scroller.scrollTop += anchor.getBoundingClientRect().top - top;
}

function onFavoriteDragStart(event) {
  const card = dragCardOf(event.target);
  if (!card || card.getAttribute('draggable') !== 'true' || !favoritesManualOrder()) return;
  const id = (card.__item?.id) || card.dataset.id;
  endFavoriteDrag();
  const host = ui.resultsHost;
  const scroller = host.parentNode;
  favoriteDrag = { id, card, marked: null, place: '', scroller, limit: null };
  favoriteDrag.stopScroll = startReorderScroll(scroller, {
    refresh: (target) => markFavoriteDrop(dragCardOf(target)),
    end: () => endFavoriteDrag(),
    canExtend: canExtendFavoriteDrag,
    extend: extendFavoriteDrag,
    contains: (target) => host.contains(target),
  });
  try {
    event.dataTransfer.setData(FAVORITE_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
  } catch (_) { /* the drag still works inside the page */ }
  card.classList.add('is-dragging');
}

/* `dragenter` and `dragover` are handled alike: a drop is refused until one
   of them is cancelled, so cancelling only `dragover` showed the "no entry"
   cursor for a moment on every element entered (the picture, the tag and
   move buttons). While a favorite is dragged the whole results area accepts
   it, gaps and the dragged card included; only a drop on another card
   changes the order. */
function onFavoriteDragOver(event) {
  if (!isFavoriteDrag(event)) return; // files and anything else: not a reorder
  if (!favoritesManualOrder()) { clearDropMark(); return; }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  markFavoriteDrop(dragCardOf(event.target));
}

function markFavoriteDrop(card) {
  if (!favoriteDrag) return;
  const targetId = card && card !== favoriteDrag.card ? ((card.__item?.id) || card.dataset.id) : '';
  const place = targetId ? favoriteDropPlace(shownFavoritePositions, favoriteDrag.id, targetId) : '';
  if (!place) { clearDropMark(); return; }
  if (favoriteDrag.marked === card && favoriteDrag.place === place) return;
  clearDropMark();
  card.classList.add(place === 'before' ? 'drop-before' : 'drop-after');
  favoriteDrag.marked = card;
  favoriteDrag.place = place;
}

function onFavoriteDragLeave(event) {
  if (!favoriteDrag) return;
  if (event.relatedTarget && ui.resultsHost?.contains?.(event.relatedTarget)) return;
  clearDropMark();
}

function onFavoriteDrop(event) {
  if (!isFavoriteDrag(event)) return;
  const doc = favoriteDrag.scroller?.ownerDocument;
  const target = doc?.elementFromPoint ? doc.elementFromPoint(event.clientX, event.clientY) : event.target;
  const card = dragCardOf(target);
  const { id } = favoriteDrag;
  const dragged = favoriteDrag.card;
  endFavoriteDrag();
  // Taken in, so the browser does nothing of its own with it.
  event.preventDefault();
  if (!card || card === dragged) return;
  onDropFavorite(id, (card.__item?.id) || card.dataset.id);
}

function bindFavoriteDrag(host) {
  if (!host?.addEventListener || boundDragHosts.has(host)) return;
  boundDragHosts.add(host);
  host.addEventListener('dragstart', onFavoriteDragStart);
  host.addEventListener('dragenter', onFavoriteDragOver);
  host.addEventListener('dragover', onFavoriteDragOver);
  host.addEventListener('dragleave', onFavoriteDragLeave);
  host.addEventListener('drop', onFavoriteDrop);
  host.addEventListener('dragend', endFavoriteDrag);
}

/** A card was dropped on another: it takes that card's place in "My order"
 *  (see favoriteDropPlace). `place` ('before' or 'after') overrides that. */
export function onDropFavorite(itemId, targetId, place = '') {
  if (!favoritesManualOrder()) return false;
  const order = filteredItemsForCurrentView(libraryPool()).map((item) => item.id);
  const shown = new Set(order);
  if (!shown.has(itemId) || !shown.has(targetId)) return false;
  const where = place || favoriteDropPlace(order, itemId, targetId);
  if (!where) return false;
  // The Library re-renders on the favorites-change event this sends. Hidden
  // favorites keep their places.
  return moveFavoriteTo(itemId, targetId, where, shown);
}

function setCardDraggable(card, draggable) {
  if (draggable) {
    if (card.getAttribute('draggable') !== 'true') card.setAttribute('draggable', 'true');
    card.classList.add('is-draggable');
  } else if (card.hasAttribute?.('draggable')) {
    card.removeAttribute('draggable');
    card.classList.remove('is-draggable', 'is-dragging', 'drop-before', 'drop-after');
  }
}

/** Add or remove each mounted card's move buttons for the current sort, and
 *  disable the ones that cannot move: up/top for the first item shown, down
 *  for the last. aria-disabled (not `disabled`) keeps a button focusable, so
 *  focus can stay on it after its card reaches the top or bottom. */
function syncFavoriteOrderControls(filtered) {
  if (!ui.resultsHost?.children) return;
  // Runs in every view: a card reused from Favorites (same item, same place,
  // for example in My Playlists) must lose its move buttons there.
  const manual = favoritesManualOrder();
  const ordered = manual ? filtered.filter((item) => !isLocalFileFavorite(item)) : [];
  const positions = new Map(ordered.map((item, index) => [item.id, index]));
  // The shown order the drag marks use (a drop works it out again).
  shownFavoritePositions = positions;
  if (manual) bindFavoriteDrag(ui.resultsHost);
  for (const card of ui.resultsHost.children) {
    const id = card.dataset?.id;
    if (!id) continue;
    // Cards can be dragged into place in "My order" only.
    if (typeof card.setAttribute === 'function') setCardDraggable(card, manual && positions.has(id));
    let controls = card.__orderControls || null;
    if (!positions.has(id)) {
      if (controls) {
        controls.remove();
        card.__orderControls = null;
        card.classList.remove('has-order-controls');
      }
      continue;
    }
    if (!controls) {
      const item = ordered[positions.get(id)];
      if (!item) continue;
      controls = buildOrderControls(item, card);
      card.__orderControls = controls;
      const star = card.__star;
      if (star && typeof card.insertBefore === 'function') card.insertBefore(controls, star);
      else card.appendChild(controls);
      card.classList.add('has-order-controls');
    }
    const index = positions.get(id) ?? -1;
    setMoveEnabled(controls.__buttons.top, index > 0);
    setMoveEnabled(controls.__buttons.up, index > 0);
    setMoveEnabled(controls.__buttons.down, index < ordered.length - 1);
    setMoveEnabled(controls.__buttons.bottom, index < ordered.length - 1);
  }
}

/** Keep the moved favorite inside the render window, so its card (and the
 *  button that was pressed) stays mounted after a move across the window edge. */
function revealFilteredItem(itemId) {
  const filtered = filteredItemsForCurrentView(libraryPool());
  const index = filtered.findIndex((item) => item.id === itemId);
  if (index < 0) return;
  const limit = Math.min(RENDER_WINDOW_MAX, view.renderLimit || RENDER_LIMIT_INITIAL);
  const start = view.renderStart || 0;
  if (index >= start && index < start + limit) return;
  view.renderStart = index < start ? index : Math.max(0, index - limit + 1);
  renderResults();
  updateSentinelStatus();
}

function mountedCard(itemId) {
  for (const card of ui.resultsHost?.children || []) {
    if (card.dataset?.id === itemId) return card;
  }
  return null;
}

/** A move button was pressed: move the favorite among the items the user can
 *  see, then keep focus on the same button of the same card. */
export function onMoveFavorite(itemId, direction, button = null) {
  if (button?.getAttribute?.('aria-disabled') === 'true' || !favoritesManualOrder()) return false;
  const visibleIds = filteredItemsForCurrentView(libraryPool()).map((item) => item.id);
  // The Library re-renders on the favorites-change event this sends.
  if (!moveFavorite(itemId, direction, { visibleIds })) return false;
  if (!mountedCard(itemId)) revealFilteredItem(itemId);
  const target = mountedCard(itemId)?.__orderControls?.__buttons?.[direction];
  if (target && globalThis.document?.activeElement !== target) target.focus?.({ preventScroll: true });
  // Up and down stay next to where they were. "Move to top" and "Move to
  // bottom" can leave the list behind, so bring the card (and the focused
  // button) just into view.
  if (direction === 'top' || direction === 'bottom') target?.scrollIntoView?.({ block: 'nearest' });
  return true;
}

/** Bump the render window so more cards mount. Called from the sentinel
 *  observer when the user scrolls near the current bottom of the list.
 *  Returns true if there were unrendered items to expose; the sentinel
 *  observer uses that to decide whether to also fetch more from upstream. */
export function expandRenderWindow() {
  if (favoriteDrag) return false;
  const pool = libraryPool();
  const filteredCount = filteredItemsForCurrentView(pool).length;
  const limit = Math.min(RENDER_WINDOW_MAX, view.renderLimit || RENDER_LIMIT_INITIAL);
  const currentStart = view.renderStart || 0;
  if (filteredCount > currentStart + limit) {
    view.renderStart = Math.min(
      Math.max(0, filteredCount - limit),
      currentStart + RENDER_LIMIT_STEP,
    );
    renderResults();
    updateSentinelStatus();
    return true;
  }
  return false;
}

export function rewindRenderWindow() {
  if ((view.renderStart || 0) <= 0) return false;
  view.renderStart = Math.max(0, view.renderStart - RENDER_LIMIT_STEP);
  renderResults();
  updateSentinelStatus();
  return true;
}

/* ============ Individual card ============ */

function retireCardArtwork(card) {
  thumbHydration.observer?.unobserve?.(card);
  delete card.__thumbHydration;
  card.__artworkAbort?.abort();
}

function renderCard(item, opts = {}) {
  const sourceLabel = getSourceLabel(item.source);
  const card = el('article', {
    className: 'card' + (view.currentId === item.id ? ' is-playing' : '') + ((item.__computerMissing || item.__computerOffline) ? ' is-missing' : ''),
    attrs: {
      'data-id': item.id,
      'data-revision': String(Number(item.__revision) || 0),
    },
  });
  const openButton = el('button', {
    className: 'card-open',
    attrs: {
      type: 'button',
      'aria-label': `Open ${item.title || 'Untitled'} from ${sourceLabel}${item.__computerOffline ? ', not connected' : item.__computerMissing ? ', not found' : ''}`,
      // The whole name on hover anywhere on the card; on the card itself it
      // may end in an ellipsis.
      title: item.title || 'Untitled',
    },
    // card.__item, not `item`: a reused card is handed the current object.
    on: { click: () => onCardClick(card.__item || item) },
  });
  card.__item = item;

  const thumb = el('div', { className: 'card-thumb' });
  const placeholder = el('div', { className: 'placeholder' });
  const initials = artworkInitials(item.title);
  if (initials) {
    placeholder.classList.add('has-initials');
    placeholder.appendChild(el('div', {
      className: 'ph-initials',
      text: initials,
      attrs: { 'aria-hidden': 'true', style: `--ph-hue: ${initialsHue(item.title)}` },
    }));
  } else {
    placeholder.innerHTML = sourceGlyph(item.type);
  }
  placeholder.appendChild(el('div', { className: 'ph-label', text: getSourceLabel(item.source) }));
  thumb.appendChild(placeholder);
  const star = el('button', {
    className: 'card-star' + (isFavorite(item.id) ? ' is-fav' : ''),
    attrs: {
      title: isFavorite(item.id) ? 'Remove from favorites' : 'Add to favorites',
      'aria-label': isFavorite(item.id) ? 'Remove from favorites' : 'Add to favorites',
      'aria-pressed': isFavorite(item.id) ? 'true' : 'false',
    },
    on: { click: (e) => { e.stopPropagation(); toggleFav(card.__item || item, star); } },
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  });
  const previewPending = mountPictureDropPreview(thumb, item);
  card.__artworkAbort = new AbortController();
  const artworkOptions = {
    eager: opts.eagerArtwork === true || previewPending,
    signal: AbortSignal.any([getThumbnailHydrationSignal(), card.__artworkAbort.signal]),
  };
  insertThumbImage(thumb, item, null, artworkOptions);
  const ratingLabel = contentBadgeText(item);
  if (ratingLabel && item.__contentHidden !== true) {
    thumb.appendChild(el('span', {
      className: 'content-rating-badge', text: ratingLabel,
      attrs: { 'aria-label': 'Content rating: Explicit or NSFW' },
    }));
  }
  requestThumbnailHydration(card, item, thumb, star, artworkOptions);
  openButton.appendChild(thumb);

  const body = el('div', { className: 'card-body' });
  const titleNode = body.appendChild(el('div', {
    className: 'card-title',
    text: item.title || 'Untitled',
    attrs: { title: item.title || 'Untitled' },
  }));
  const subtitle = isComputerItem(item) ? computerCardSubtitle(item) : '';
  if (subtitle) body.appendChild(el('div', { className: 'card-subtitle', text: subtitle, attrs: { title: item.__computerOffline ? COMPUTER_OFFLINE_TOOLTIP : subtitle } }));
  const meta = el('div', { className: 'card-meta' });
  meta.appendChild(el('span', {
    className: 'source-badge',
    text: sourceLabel,
    attrs: { title: sourceLabel },
  }));
  const facts = el('span', { className: 'card-facts' });
  if (item.year) facts.appendChild(el('span', {
    className: 'card-year',
    text: String(item.year),
  }));
  if (item.country) facts.appendChild(el('span', {
    className: 'card-country',
    text: item.country,
  }));
  if (facts.childElementCount > 0) meta.appendChild(facts);
  const license = shownLicense(item);
  if (license) meta.appendChild(el('span', { className: 'card-license', text: license, attrs: { title: license } }));
  body.appendChild(meta);
  openButton.appendChild(body);
  card.appendChild(openButton);
  card.appendChild(star);
  // Favorites "My order" move buttons go in before the star (see
  // syncFavoriteOrderControls), so the tab order matches what is seen.
  card.__star = star;
  card.__thumb = thumb;
  card.__open = openButton;
  card.__meta = meta;
  card.__titleNode = titleNode;
  setCardStream(card);
  setCardTroubleMark(card);
  rememberShown(card, item);
  return card;
}

function onCardClick(item) {
  if (!isComputerItem(item)) {
    view.currentId = item.id;
    for (const card of ui.resultsHost.querySelectorAll('.card')) {
      card.classList.toggle('is-playing', card.dataset.id === item.id);
    }
  }
  openDetail(item, { focus: true, anchorCard: true });
  if (item.__contentHidden === true) return;
  playLibraryItem(item).catch((err) => console.warn('play failed:', err));
}

function setStarState(btn, fav) {
  const label = fav ? 'Remove from favorites' : 'Add to favorites';
  btn.classList.toggle('is-fav', fav);
  btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function toggleFav(item, btn) {
  if (isFavorite(item.id)) {
    if (removeFavorite(item.id) === false) return;
    setStarState(btn, false);
  } else {
    if (addFavorite(item) === false) return;
    setStarState(btn, true);
  }
}

/** Bring the stars on the mounted cards in line with saved favorites. */
export function syncCardStars() {
  if (!ui.resultsHost?.querySelectorAll) return;
  const saved = new Set(getState().favorites.map((f) => f.id));
  for (const card of ui.resultsHost.querySelectorAll('.card')) {
    const star = card.querySelector?.('.card-star');
    if (star) setStarState(star, saved.has(card.dataset.id));
  }
}

function sourceGlyph(type) {
  const map = {
    radio: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 12a7 7 0 0 1 7-7M5 16a3 3 0 0 1 3-3M19 12a7 7 0 0 0-7-7M19 16a3 3 0 0 0-3-3"/><circle cx="12" cy="18" r="2"/></svg>',
    tv: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg>',
    video: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
    audio: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
  };
  return map[type] || '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/></svg>';
}

/* ============ Stable collection summary ============ */

/** Which sources contribute to the fixed summary at the top of the results
 *  area. This DOES respect the sidebar filter. Note this
 *  is different from `fetchSourcesAllEnabled` in chain.js, which always
 *  returns every enabled source regardless of the sidebar tab. */
export function effectiveStatusSources() {
  const all = SOURCES.filter((s) => getState().settings.enabledSources[s.id] !== false);
  if (view.activeSource === 'all') return all.map((s) => s.id);
  if (isPersonalSource()) return [];
  if (view.activeSource && view.activeSource.startsWith('type:')) {
    const t = view.activeSource.slice('type:'.length);
    return all.filter((s) => s.types.includes(t)).map((s) => s.id);
  }
  return all.some((source) => source.id === view.activeSource) ? [view.activeSource] : [];
}

export function setSourceStatus(sourceId, status) {
  view.sourceStatus.set(sourceId, status);
}

function statusBucket(status) {
  const finite = status?.state;
  const snapshot = status?.snapshot?.state;
  if (['rate-limited', 'retrying', 'error'].includes(finite)
      || ['stale', 'retrying'].includes(snapshot)) return 'waiting';
  // A finished search ('ready') is done for the results it shows.
  if (['complete', 'ready'].includes(finite)
      && !['live', 'loading', 'refreshing'].includes(snapshot)) return 'done';
  return 'collecting';
}

/**
 * True while something the current view shows is still on its way: a search
 * that has not answered, a browse page in flight, a browse first page not
 * answered yet, a browse retry the chain will make by itself, or a live
 * snapshot still loading for the first time. Explained holds, finished
 * searches (including failed ones), disabled, complete and exhausted sources
 * are not pending.
 */
export function viewHasPendingSources(sources = effectiveStatusSources(), now = Date.now()) {
  if (isPersonalSource()) return false;
  const searching = Boolean((view.lastQuery || '').trim());
  return sources.some((id) => {
    const status = view.sourceStatus.get(id);
    if (!status || isHeldStatus(status, now)) return false;
    if (!searching && ['retrying', 'rate-limited'].includes(status.state)) return true;
    return sourceIsLoading(id, status, searching);
  });
}

/** True while one of the view's own sources is fetching or still owes its
 *  first page: the "Loading more…" spinner. Background prefetch of sources
 *  outside the view does not count; retries are shown by their own line. */
export function viewSourcesLoading(sources = effectiveStatusSources()) {
  if (isPersonalSource()) return false;
  const searching = Boolean((view.lastQuery || '').trim());
  return sources.some((id) => sourceIsLoading(id, view.sourceStatus.get(id), searching));
}

function sourceIsLoading(id, status, searching) {
  if (!status) return false;
  if (status.state === 'loading') return true;
  if (searching) return false;
  const snapshot = status.snapshot;
  if (['loading', 'refreshing'].includes(snapshot?.state) && !snapshot?.lastGoodAt) return true;
  if (status.state !== 'more') return false;
  const progress = view.sourceProgress?.get(id);
  return Boolean(progress && !progress.exhausted && !progress.error
    && progress.cursor == null && !(progress.loaded > 0));
}

/** A browse source whose quick retries are used up: it is asked again only
 *  every few minutes (progress.js slowRetryDelayMs) until it answers. */
export function isSlowRetryStatus(status) {
  return status?.state === 'retrying' && status.slow === true;
}

/** "LibriVox is not answering" / "2 sources are not answering". */
export function notAnsweringText(sourceIds) {
  if (sourceIds.length === 1) {
    const name = SOURCES.find((source) => source.id === sourceIds[0])?.displayName || 'This source';
    return `${name} is not answering`;
  }
  return `${sourceIds.length} sources are not answering`;
}

/**
 * The view's slow-retry sources when nothing else of the view is on its way:
 * every other source is finished, switched off, has nothing more, or is
 * waiting out a declared hold (which sends nothing either). Empty while
 * anything else is loading, during a search (the visible status then belongs
 * to the search) and in the personal views.
 */
export function viewSlowRetrySources(sources = effectiveStatusSources(), now = Date.now()) {
  if (isPersonalSource() || (view.lastQuery || '').trim()) return [];
  const slow = [];
  for (const id of sources) {
    const status = view.sourceStatus.get(id);
    if (isSlowRetryStatus(status)) {
      slow.push(id);
      continue;
    }
    if (status?.state === 'disabled' || view.exhausted?.has(id) || isHeldStatus(status, now)) continue;
    return [];
  }
  return slow;
}

/** Plain-language explanation for a waiting source, or '' when there is none
 *  (raw adapter errors stay in tooltips only). */
export function sourceNotice(status) {
  if (!['rate-limited', 'retrying', 'error'].includes(status?.state)) return '';
  return typeof status?.notice === 'string' ? status.notice : '';
}

/**
 * True when the current view still has sources to come and every one of them
 * is waiting out a declared, explained hold (see isHeldStatus), so
 * nothing for this view is loading and nothing will be requested until the
 * hold ends. Such a view is settled for the spinner and the empty page.
 */
export function viewWaitsOnlyOnHolds(sources = effectiveStatusSources(), now = Date.now()) {
  if (isPersonalSource()) return false;
  const searching = Boolean((view.lastQuery || '').trim());
  let held = 0;
  for (const id of sources) {
    const status = view.sourceStatus.get(id);
    if (isHeldStatus(status, now)) {
      held += 1;
      continue;
    }
    if (status?.state === 'disabled') continue;
    if (searching ? status?.state === 'ready' : view.exhausted?.has(id)) continue;
    return false;
  }
  return held > 0;
}

/** A source status waiting out a declared hold that the source explained in
 *  plain words (its adapter set a user message). It sends nothing until
 *  retryAt, so Retry now cannot help. A bare rate limit with no notice keeps
 *  the old behaviour: spinner, and Retry now still sends a request. */
function isHeldStatus(status, now = Date.now()) {
  return status?.state === 'rate-limited' && Number(status.retryAt) > now && Boolean(sourceNotice(status));
}

/** Notices for the sources the current view covers, without repeats. */
export function currentSourceNotices(sourceIds = effectiveStatusSources()) {
  const notices = sourceIds.map((id) => sourceNotice(view.sourceStatus.get(id))).filter(Boolean);
  return [...new Set(notices)];
}

function compactSourceStatus(status, disabled) {
  if (disabled) {
    return { text: 'Off', kind: 'off', title: 'Source disabled' };
  }
  if (status?.state === 'rate-limited') {
    return { text: 'Wait', kind: 'wait', title: sourceNotice(status) || 'Rate limited; retry scheduled' };
  }
  if (isSlowRetryStatus(status)) {
    const detail = sourceNotice(status) || status?.error || '';
    return {
      text: 'Wait',
      kind: 'wait',
      title: `Not answering; tried again every few minutes${detail ? ` (${detail})` : ''}`,
    };
  }
  if (['retrying', 'error'].includes(status?.state)) {
    return { text: 'Wait', kind: 'wait', title: sourceNotice(status) || status?.error || 'Retry scheduled' };
  }
  const snapshot = status?.snapshot;
  if (snapshot?.state === 'stale' || snapshot?.state === 'retrying') {
    return { text: 'Stale', kind: 'wait', title: snapshot.error || 'Snapshot retry scheduled' };
  }
  if (snapshot?.state === 'live') {
    return { text: 'Live', kind: 'live', title: 'Live snapshot' };
  }
  if (snapshot?.state === 'refreshing' && snapshot.lastGoodAt) {
    return { text: 'Live', kind: 'live', title: 'Live snapshot refreshing' };
  }
  if (['loading', 'refreshing'].includes(snapshot?.state)) {
    return { text: 'Sync', kind: 'pull', title: 'Loading live snapshot' };
  }
  if (status?.state === 'complete') {
    return { text: 'Done', kind: 'done', title: 'Source complete' };
  }
  if (status?.state === 'ready') {
    return { text: 'Done', kind: 'done', title: 'Search complete' };
  }
  return { text: 'Pull', kind: 'pull', title: 'Collecting' };
}

export function renderStatus() {
  if (!ui.statusHost) return;
  if (isPersonalSource()) {
    const summaryText = view.activeSource === 'favorites' ? 'Saved favorites' : 'Imported channels (stored locally; provider terms apply)';
    if (ui.statusHost.dataset.summary === summaryText) return;
    ui.statusHost.dataset.summary = summaryText;
    ui.statusHost.replaceChildren(el('span', {
      className: 'collection-summary collection-summary-favorites',
      text: summaryText,
    }));
    return;
  }
  const targets = effectiveStatusSources();
  const totals = { collecting: 0, waiting: 0, done: 0 };
  for (const id of targets) {
    totals[statusBucket(view.sourceStatus.get(id))] += 1;
  }
  const notice = currentSourceNotices(targets).join(' ');
  const summaryText = `Collecting ${totals.collecting} · Waiting ${totals.waiting} · Done ${totals.done}`
    + (notice ? ` · ${notice}` : '');
  if (ui.statusHost.dataset.summary === summaryText) return;
  ui.statusHost.dataset.summary = summaryText;
  const summary = el('span', { className: 'collection-summary' });
  summary.appendChild(el('span', {
    className: 'collection-summary-part is-collecting', text: `Collecting ${totals.collecting}`,
  }));
  summary.appendChild(el('span', { className: 'collection-summary-separator', text: '·' }));
  summary.appendChild(el('span', {
    className: 'collection-summary-part is-waiting', text: `Waiting ${totals.waiting}`,
  }));
  summary.appendChild(el('span', { className: 'collection-summary-separator', text: '·' }));
  summary.appendChild(el('span', {
    className: 'collection-summary-part is-done', text: `Done ${totals.done}`,
  }));
  if (notice) {
    // A source said in plain words why it is waiting (for example a
    // provider-side block). Keep it on the always-visible summary line.
    summary.appendChild(el('span', { className: 'collection-summary-separator', text: '·' }));
    summary.appendChild(el('span', {
      className: 'collection-summary-notice', text: notice, attrs: { title: notice },
    }));
  }
  ui.statusHost.replaceChildren(summary);
}

/* ============ Sentinel status (bottom of results) ============ */

function updateFilterCount(items) {
  if (!ui.filterCount) return;
  const count = items.length.toLocaleString('en-US');
  let text = `${count} so far`;
  if (!viewSourcesLoading()) {
    const types = isPersonalSource() ? normalizePersonalTypes(personalFilters().type)
      : view.filters.type ? [view.filters.type] : SOURCES.find(({ id }) => id === view.activeSource)?.types || [];
    const onlyType = types.length === 1 ? types[0] : items[0]?.type;
    const stationView = (onlyType === 'tv' || onlyType === 'radio')
      && (types.length === 1 || items.every(({ type }) => type === onlyType));
    const noun = stationView ? (onlyType === 'tv' ? 'channel' : 'station') : 'item';
    text = `${count} ${noun}${items.length === 1 ? '' : 's'}`;
  }
  if (ui.filterCount.textContent !== text) ui.filterCount.textContent = text;
}

export function updateSentinelStatus() {
  if (!ui.sentinelStatus || !ui.sentinelButton) return;
  if (isPersonalSource()) {
    ui.sentinelStatus.textContent = '';
    ui.sentinelButton.style.display = 'none';
    return;
  }
  const total = filteredItemsForCurrentView(view.items).length;
  const sources = effectiveStatusSources();
  const exhausted = view.exhausted || new Set();
  const liveSources = sources.filter((id) => !exhausted.has(id));
  const retryingSources = sources.filter((id) => ['retrying', 'rate-limited'].includes(view.sourceStatus.get(id)?.state));
  const searching = Boolean((view.lastQuery || '').trim());
  const searchLoading = searching
    && sources.some((id) => view.sourceStatus.get(id)?.state === 'loading');
  if (searchLoading) {
    ui.sentinelStatus.textContent = 'Searching...';
    ui.sentinelButton.style.display = 'none';
  } else if (viewWaitsOnlyOnHolds(sources)) {
    // Every source this view still needs is waiting out a declared hold:
    // nothing is loading and Retry cannot help until it ends. The empty page
    // carries the message when there are no items; otherwise this line does.
    const notices = currentSourceNotices(sources);
    ui.sentinelStatus.textContent = total === 0
      ? ''
      : `${total} items${notices.length > 0 ? ` · ${notices.join(' ')}` : ''}`;
    ui.sentinelButton.style.display = 'none';
  } else if (!searching && viewSourcesLoading(sources)) {
    ui.sentinelStatus.innerHTML = '<span class="spinner-inline"></span> Loading more…';
    ui.sentinelButton.style.display = 'none';
  } else if (retryingSources.length > 0) {
    const notices = currentSourceNotices(retryingSources);
    // During a search the line keeps its plain wording: a browse status
    // restored under a search is not what the results shown wait for.
    const slowOnes = searching
      ? [] : retryingSources.filter((id) => isSlowRetryStatus(view.sourceStatus.get(id)));
    const waiting = slowOnes.length > 0 && slowOnes.length === retryingSources.length
      ? `${notAnsweringText(slowOnes)}; trying again every few minutes`
      : `${retryingSources.length} ${retryingSources.length === 1 ? 'source' : 'sources'} retrying`;
    ui.sentinelStatus.textContent = `${total} items · ${waiting}`
      + (notices.length > 0 ? ` · ${notices.join(' ')}` : '');
    ui.sentinelButton.textContent = 'Retry now';
    ui.sentinelButton.dataset.action = 'retry';
    ui.sentinelButton.dataset.restartExhausted = 'false';
    // Only offer Retry now when some retrying source is not inside a hold.
    const now = Date.now();
    const canRetry = retryingSources.some((id) => !isHeldStatus(view.sourceStatus.get(id), now));
    ui.sentinelButton.style.display = canRetry ? 'inline-flex' : 'none';
  } else if (searching) {
    ui.sentinelStatus.textContent = `${total} search ${total === 1 ? 'result' : 'results'} loaded`;
    ui.sentinelButton.style.display = 'none';
  } else if (sources.length > 0 && liveSources.length === 0) {
    ui.sentinelStatus.textContent = `All ${total} matching items loaded`;
    ui.sentinelButton.textContent = 'Check again';
    ui.sentinelButton.dataset.action = 'retry';
    ui.sentinelButton.dataset.restartExhausted = 'true';
    ui.sentinelButton.style.display = 'inline-flex';
  } else if (total > 0) {
    ui.sentinelStatus.textContent = `${total} matching items loaded · more available`;
    ui.sentinelButton.style.display = 'none';
  } else {
    ui.sentinelStatus.textContent = '';
    ui.sentinelButton.style.display = 'none';
  }
}

/* ============ Sidebar counts ============ */

export function updateSidebarCounts() {
  const cum = view.cumulativeCounts;
  const settings = getState().settings;
  const enabled = new Set(SOURCES
    .filter((source) => settings.enabledSources[source.id] !== false)
    .map((source) => source.id));
  let totalAll = 0;
  for (const [id, count] of cum.entries()) {
    if (enabled.has(id)) totalAll += count;
  }
  const typeCounts = new Map();
  for (const id of enabled) {
    const sourceTypes = view.cumulativeSourceTypeCounts.get(id);
    if (!sourceTypes) continue;
    for (const [type, count] of sourceTypes) {
      typeCounts.set(type, (typeCounts.get(type) || 0) + count);
    }
  }

  totalAll += view.computerHits.length;
  for (const item of view.computerHits) typeCounts.set(item.type, (typeCounts.get(item.type) || 0) + 1);
  for (const li of ui.sidebar.querySelectorAll('.source-item')) {
    const id = li.dataset.source;
    const span = li.querySelector('[data-role="count"]');
    if (!span) continue;
    const isDirectSource = SOURCE_ID_SET.has(id);
    const isDisabled = isDirectSource && !enabled.has(id);
    let n = 0;
    if (id === 'all') n = totalAll;
    else if (id === 'favorites') n = getState().favorites.length;
    else if (id === 'playlists') n = getPlaylistItems().length;
    else if (id === 'computer') n = view.computerHits.length;
    else if (id.startsWith('type:')) n = typeCounts.get(id.slice('type:'.length)) || 0;
    else if (!isDisabled) n = cum.get(id) || 0;
    const countText = String(n);
    if (span.textContent !== countText) span.textContent = countText;

    const healthSpan = li.querySelector('[data-role="source-health"]');
    if (healthSpan) {
      const health = compactSourceStatus(view.sourceStatus.get(id), isDisabled);
      const signature = `${health.text}\u0000${health.kind}\u0000${health.title}`;
      if (healthSpan.dataset.signature !== signature) {
        healthSpan.dataset.signature = signature;
        healthSpan.textContent = health.text;
        healthSpan.className = `source-health is-${health.kind}`;
        healthSpan.title = health.title;
        healthSpan.setAttribute('aria-label', `${getSourceLabel(id)}: ${health.title}`);
        // With technical details off the label is hidden; keep the status
        // one hover away on the whole row.
        li.title = `${getSourceLabel(id)}: ${health.text} (${health.title})`;
      }
    }
  }
}
