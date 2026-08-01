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

import { getState, isFavorite, addFavorite, removeFavorite } from '../../lib/state.js';
import { SOURCES, getSourceLabel } from '../../lib/sources.js';
import { el } from './utils.js';
import {
  view, renderedIds,
  RENDER_LIMIT_INITIAL, RENDER_LIMIT_STEP, RENDER_WINDOW_MAX,
  thumbHydration,
} from './state.js';
import { filterItems } from './filter.js';
import {
  getThumbnailHydrationSignal, insertThumbImage, requestThumbnailHydration,
  resetThumbnailHydrationScope, resolveItemArtwork,
  THUMBNAIL_EAGER_CARD_COUNT,
} from './thumbnails.js';
import { openDetail } from './detail.js';
import { playItem } from '../../lib/player.js';
import {
  contentBadgeText, favoriteForContentView,
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

function filterContextSignature() {
  const settings = getState().settings;
  return JSON.stringify([
    view.activeSource,
    view.lastQuery,
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

export function renderResults() {
  // Favorites is its own pool (kept in state, persisted to localStorage)
  // and lives outside the regular accumulating view.items. This keeps a
  // visit to Favorites from polluting your browse pool, and means clearing
  // the search box doesn't wipe what you favorited.
  const pool = view.activeSource === 'favorites'
    ? getState().favorites.map((item) => favoriteForContentView(item, getState().settings))
    : view.items;
  const filtered = filteredItemsForCurrentView(pool);
  const signature = JSON.stringify([
    view.activeSource, view.lastQuery, view.filters.type, view.filters.country,
    view.filters.language, view.filters.yearMin, view.filters.yearMax,
    getState().settings.showExplicitContent === true,
  ]);
  if (signature !== view.renderSignature) {
    view.renderSignature = signature;
    view.renderStart = 0;
  }
  view.renderLimit = Math.min(RENDER_WINDOW_MAX, view.renderLimit || RENDER_LIMIT_INITIAL);
  const maximumStart = Math.max(0, filtered.length - view.renderLimit);
  view.renderStart = Math.max(0, Math.min(view.renderStart || 0, maximumStart));
  const visible = filtered.slice(view.renderStart, view.renderStart + view.renderLimit);
  if (ui.windowBack) {
    ui.windowBack.style.display = view.renderStart > 0 ? 'inline-flex' : 'none';
    ui.windowBack.textContent = view.renderStart > 0
      ? `Show earlier items (currently ${view.renderStart + 1}-${view.renderStart + visible.length})`
      : 'Show earlier items';
  }
  const visibleIds = new Set();
  for (const it of visible) visibleIds.add(it.id);

  // If any currently-mounted card is no longer in the visible slice (because
  // the user changed source/type filters, or scrolled UP enough that the old
  // cards fell out of the window), full clear-and-rebuild.
  let needClear = false;
  for (const id of renderedIds) {
    if (!visibleIds.has(id)) { needClear = true; break; }
  }
  // ALSO: the DOM order has to match the visible-array order. When a search
  // term filtered the pool to a subset and we rendered those subset cards,
  // they're in the DOM in their pool-insertion order. Clearing the search
  // relaxes the filter — the filtered cards are still part of `visible` but
  // now sit at positions 30+ in the array, while the newly-relaxed cards
  // occupy positions 0-29. Without an order check we'd just APPEND the new
  // cards after the existing filtered ones, leaving the old search hits
  // pinned at the top — looks like "the search is still active". Comparing
  // DOM[i].data-id to visible[i].id catches that and forces a rebuild.
  if (!needClear) {
    const cards = ui.resultsHost.children;
    for (let i = 0; i < cards.length && i < visible.length; i++) {
      if (cards[i].dataset && (cards[i].dataset.id !== visible[i].id
          || Number(cards[i].dataset.revision || 0) !== Number(visible[i].__revision || 0))) {
        needClear = true;
        break;
      }
    }
  }
  if (needClear) {
    if (thumbHydration.observer) thumbHydration.observer.disconnect();
    thumbHydration.observer = null;
    thumbHydration.observerRoot = null;
    resetThumbnailHydrationScope();
    ui.resultsHost.innerHTML = '';
    renderedIds.clear();
  }

  if (visible.length === 0) {
    if (!view.loading && !view.loadingMore) {
      if (!ui.resultsHost.querySelector('.empty-state')) {
        ui.resultsHost.innerHTML = '';
        renderedIds.clear();
        const empty = el('div', { className: 'empty-state' });
        empty.appendChild(el('h3', { text: view.query ? 'No results' : 'Nothing here yet' }));
        empty.appendChild(el('p', { text: view.query
          ? `Try a different search term, or pick a different source.`
          : `Type a search above, or browse a single source on the left.` }));
        ui.resultsHost.appendChild(empty);
      }
    }
    return;
  }

  const stale = ui.resultsHost.querySelector('.empty-state');
  if (stale) stale.remove();

  // Append only the items we haven't already mounted. Use a document
  // fragment so one reflow handles the whole batch.
  const frag = document.createDocumentFragment();
  for (const [index, it] of visible.entries()) {
    if (renderedIds.has(it.id)) continue;
    frag.appendChild(renderCard(it, { eagerArtwork: index < THUMBNAIL_EAGER_CARD_COUNT }));
    renderedIds.add(it.id);
  }
  if (frag.childNodes.length > 0) ui.resultsHost.appendChild(frag);
}

/** Bump the render window so more cards mount. Called from the sentinel
 *  observer when the user scrolls near the current bottom of the list.
 *  Returns true if there were unrendered items to expose; the sentinel
 *  observer uses that to decide whether to also fetch more from upstream. */
export function expandRenderWindow() {
  const pool = view.activeSource === 'favorites'
    ? getState().favorites.map((item) => favoriteForContentView(item, getState().settings))
    : view.items;
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

function renderCard(item, opts = {}) {
  const sourceLabel = getSourceLabel(item.source);
  const card = el('article', {
    className: 'card' + (view.currentId === item.id ? ' is-playing' : ''),
    attrs: {
      'data-id': item.id,
      'data-revision': String(Number(item.__revision) || 0),
    },
  });
  const openButton = el('button', {
    className: 'card-open',
    attrs: {
      type: 'button',
      'aria-label': `Open ${item.title || 'Untitled'} from ${sourceLabel}`,
    },
    on: { click: () => onCardClick(item) },
  });

  const thumb = el('div', { className: 'card-thumb' });
  const placeholder = el('div', { className: 'placeholder' });
  placeholder.innerHTML = sourceGlyph(item.type);
  placeholder.appendChild(el('div', { className: 'ph-label', text: getSourceLabel(item.source) }));
  thumb.appendChild(placeholder);
  const star = el('button', {
    className: 'card-star' + (isFavorite(item.id) ? ' is-fav' : ''),
    attrs: {
      title: isFavorite(item.id) ? 'Remove from favorites' : 'Add to favorites',
      'aria-label': isFavorite(item.id) ? 'Remove from favorites' : 'Add to favorites',
      'aria-pressed': isFavorite(item.id) ? 'true' : 'false',
    },
    on: { click: (e) => { e.stopPropagation(); toggleFav(item, star); } },
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  });
  const artworkOptions = {
    eager: opts.eagerArtwork === true,
    signal: getThumbnailHydrationSignal(),
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
  body.appendChild(el('div', {
    className: 'card-title',
    text: item.title || 'Untitled',
    attrs: { title: item.title || 'Untitled' },
  }));
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
  if (item.license && item.license !== 'Unknown') meta.appendChild(el('span', {
    className: 'card-license',
    text: item.license,
    attrs: { title: item.license },
  }));
  body.appendChild(meta);
  openButton.appendChild(body);
  card.appendChild(openButton);
  card.appendChild(star);
  return card;
}

function onCardClick(item) {
  view.currentId = item.id;
  for (const card of ui.resultsHost.querySelectorAll('.card')) {
    card.classList.toggle('is-playing', card.dataset.id === item.id);
  }
  openDetail(item, { focus: true });
  if (item.__contentHidden === true) return;
  playItem(item).catch((err) => console.warn('play failed:', err));
}

function toggleFav(item, btn) {
  if (isFavorite(item.id)) {
    removeFavorite(item.id);
    btn.classList.remove('is-fav');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Add to favorites');
    btn.title = 'Add to favorites';
  } else {
    addFavorite(item);
    btn.classList.add('is-fav');
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', 'Remove from favorites');
    btn.title = 'Remove from favorites';
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
function effectiveStatusSources() {
  const all = SOURCES.filter((s) => getState().settings.enabledSources[s.id] !== false);
  if (view.activeSource === 'all') return all.map((s) => s.id);
  if (view.activeSource === 'favorites') return [];
  if (view.activeSource && view.activeSource.startsWith('type:')) {
    const t = view.activeSource.slice('type:'.length);
    return all.filter((s) => s.types.includes(t)).map((s) => s.id);
  }
  return [view.activeSource];
}

export function setSourceStatus(sourceId, status) {
  view.sourceStatus.set(sourceId, status);
}

function statusBucket(status) {
  const finite = status?.state;
  const snapshot = status?.snapshot?.state;
  if (['rate-limited', 'retrying', 'error'].includes(finite)
      || ['stale', 'retrying'].includes(snapshot)) return 'waiting';
  if (finite === 'complete'
      && !['live', 'loading', 'refreshing'].includes(snapshot)) return 'done';
  return 'collecting';
}

function compactSourceStatus(status, disabled) {
  if (disabled || status?.state === 'disabled') {
    return { text: 'Off', kind: 'off', title: 'Source disabled' };
  }
  if (status?.state === 'rate-limited') {
    return { text: 'Wait', kind: 'wait', title: 'Rate limited; retry scheduled' };
  }
  if (['retrying', 'error'].includes(status?.state)) {
    return { text: 'Wait', kind: 'wait', title: status?.error || 'Retry scheduled' };
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
  return { text: 'Pull', kind: 'pull', title: 'Collecting' };
}

export function renderStatus() {
  if (!ui.statusHost) return;
  if (view.activeSource === 'favorites') {
    const summaryText = 'Saved favorites';
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
  const summaryText = `Collecting ${totals.collecting} · Waiting ${totals.waiting} · Done ${totals.done}`;
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
  ui.statusHost.replaceChildren(summary);
}

/* ============ Sentinel status (bottom of results) ============ */

export function updateSentinelStatus() {
  if (!ui.sentinelStatus || !ui.sentinelButton) return;
  if (view.activeSource === 'favorites') {
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
  } else if (view.loading || (view.loadingMore && !searching)) {
    ui.sentinelStatus.innerHTML = '<span class="spinner-inline"></span> Loading more…';
    ui.sentinelButton.style.display = 'none';
  } else if (retryingSources.length > 0) {
    ui.sentinelStatus.textContent = `${total} items · ${retryingSources.length} ${retryingSources.length === 1 ? 'source' : 'sources'} retrying`;
    ui.sentinelButton.textContent = 'Retry now';
    ui.sentinelButton.dataset.action = 'retry';
    ui.sentinelButton.dataset.restartExhausted = 'false';
    ui.sentinelButton.style.display = 'inline-flex';
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

  for (const li of ui.sidebar.querySelectorAll('.source-item')) {
    const id = li.dataset.source;
    const span = li.querySelector('[data-role="count"]');
    if (!span) continue;
    const isDirectSource = SOURCE_ID_SET.has(id);
    const isDisabled = isDirectSource && !enabled.has(id);
    const disabledState = isDisabled ? 'true' : 'false';
    if (li.dataset.disabledState !== disabledState) {
      li.dataset.disabledState = disabledState;
      li.classList.toggle('is-disabled', isDisabled);
      li.setAttribute('aria-disabled', disabledState);
    }
    let n = 0;
    if (id === 'all') n = totalAll;
    else if (id === 'favorites') n = getState().favorites.length;
    else if (id.startsWith('type:')) n = typeCounts.get(id.slice('type:'.length)) || 0;
    else if (!isDisabled) n = cum.get(id) || 0;
    const countText = n > 0 ? String(n) : '';
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
      }
    }
  }
}
