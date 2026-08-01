/**
 * Library mode — public entry point.
 *
 * The mode is split across several files in this directory:
 *   utils.js        — el() DOM helper
 *   state.js        — view singleton + constants + addItems
 *   shell-refs.js   — shared `ui` DOM-element registry
 *   filter.js       — pure functions deciding what to show
 *   thumbnails.js   — lazy artwork hydration
 *   render.js       — cards grid + stable summary + sentinel/sidebar statuses
 *   detail.js       — right-side detail panel
 *   sidebar.js      — the source-list sidebar + selectSource handler
 *   chain.js        — fetch orchestration (runSearch, loadMore, sentinel hook)
 *   shell.js        — top-level layout (sidebar + search bar + results + sentinel)
 *   index.js        — this file: mount/teardown lifecycle, state subscriptions
 *
 * The chain pulls from EVERY enabled source independent of the active
 * sidebar tab; sidebar / search / filter chips are all display filters
 * applied at render time over the single accumulating pool.
 */

import { subscribe, getState } from '../../lib/state.js';
import { playItem } from '../../lib/player.js';
import { view, renderedIds, thumbHydration } from './state.js';
import { buildShell } from './shell.js';
import {
  runSearch, reconcileEnabledSources, pauseCatalogWork, resumeCatalogWork,
  reconcileContentPreference,
} from './chain.js';
import {
  renderResults, renderStatus, updateSidebarCounts, updateSentinelStatus,
} from './render.js';
import { cancelThumbnailHydration, resetThumbnailHydrationScope } from './thumbnails.js';
import { openDetail, closeDetail, getRestorableDetailItem } from './detail.js';
import { filterItems } from './filter.js';
import { favoriteForContentView } from '../../lib/content-rating.js';
import { ui } from './shell-refs.js';

const subs = [];

function tearDown() {
  pauseCatalogWork();
  while (subs.length) {
    const off = subs.pop();
    try { off(); } catch (_) {}
  }
  if (thumbHydration.observer) {
    try { thumbHydration.observer.disconnect(); } catch (_) {}
    thumbHydration.observer = null;
    thumbHydration.observerRoot = null;
  }
  cancelThumbnailHydration();
  if (view.infiniteObserver) {
    try { view.infiniteObserver.disconnect(); } catch (_) {}
    view.infiniteObserver = null;
  }
  // The panel DOM belongs to the outgoing Library shell, but its selected
  // item belongs to the session. Preserve that identity so returning to
  // Library can rebuild the same panel.
  closeDetail({ preserveSelection: true });
}

/** Skip to the next item from the current pool. Used by the player's
 *  "Try next" button when a stream fails. */
function tryNext() {
  const pool = view.activeSource === 'favorites'
    ? getState().favorites.map((item) => favoriteForContentView(item, getState().settings))
    : view.items;
  const filtered = filterItems(pool).filter((item) => item.__contentHidden !== true);
  if (filtered.length === 0) return;
  const idx = filtered.findIndex((it) => it.id === view.currentId);
  const nextIdx = idx >= 0 ? (idx + 1) % filtered.length : 0;
  const next = filtered[nextIdx];
  if (!next) return;
  view.currentId = next.id;
  for (const card of ui.resultsHost?.querySelectorAll?.('.card') || []) {
    card.classList.toggle('is-playing', card.dataset.id === view.currentId);
  }
  openDetail(next);
  playItem(next).catch(() => {});
}

// Marker for cache-bust verification (build id changes whenever this string
// changes, so the WebView2 has to fetch a fresh bundle on next launch).
  // build-id: 2026-07-10-v0.1.2-windows
export function renderLibrary(host) {
  console.info('[library] build 2026-07-10-v0.1.2-windows loaded');
  tearDown();
  resetThumbnailHydrationScope();
  host.appendChild(buildShell());

  // buildShell() created a fresh resultsHost — so any ids we tracked as
  // "mounted" from a previous visit no longer have a real card in the DOM.
  renderedIds.clear();
  resumeCatalogWork();
  reconcileEnabledSources();

  const mountedPreference = getState().settings.showExplicitContent === true;
  const preferenceChanged = view.contentPreference != null
    && view.contentPreference !== mountedPreference;
  const previousPreference = view.contentPreference;
  view.contentPreference = mountedPreference;

  // Start fresh when the pool is empty or when teardown canceled a pending
  // debounced query. The view object
  // lives at module scope so it survives setMode() — switching to
  // Tuner/Discovery/About and back should preserve the loaded pool; reconnecting
  // a pending query keeps the search box and displayed cards consistent.
  const pendingQuery = (view.query || '').trim() !== (view.lastQuery || '').trim();
  if (preferenceChanged) {
    reconcileContentPreference(previousPreference, mountedPreference);
  } else if (view.items.length === 0 || pendingQuery) {
    runSearch();
  } else {
    renderResults();
    renderStatus();
    updateSidebarCounts();
    updateSentinelStatus();
  }

  const state = getState();
  const restoredDetail = getRestorableDetailItem(
    state.currentItem, view.itemIndex, state.favorites,
  );
  if (restoredDetail) openDetail(restoredDetail);

  subs.push(subscribe('current-item', (item) => {
    view.currentId = item?.id || null;
    for (const card of ui.resultsHost?.querySelectorAll?.('.card') || []) {
      card.classList.toggle('is-playing', card.dataset.id === view.currentId);
    }
  }));
  subs.push(subscribe('favorites-change', () => {
    updateSidebarCounts();
    if (view.activeSource === 'favorites') renderResults();
  }));
  subs.push(subscribe('settings-change', (settings) => {
    const nextPreference = settings.showExplicitContent === true;
    const contentChanged = view.contentPreference !== nextPreference;
    const priorPreference = view.contentPreference;
    view.contentPreference = nextPreference;
    if (view.activeSource !== 'all'
        && view.activeSource !== 'favorites'
        && !view.activeSource.startsWith('type:')
        && settings.enabledSources[view.activeSource] === false) {
      view.activeSource = 'all';
      view.filters.type = '';
    }
    reconcileEnabledSources();
    if (contentChanged) reconcileContentPreference(priorPreference, nextPreference);
    renderResults();
    renderStatus();
    updateSidebarCounts();
    updateSentinelStatus();
    if (view.detailItemId) {
      const nextDetail = getRestorableDetailItem(
        getState().currentItem, view.itemIndex, getState().favorites,
      );
      if (nextDetail) openDetail(nextDetail);
      else closeDetail();
    }
  }));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'library') tryNext();
  }));
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'library') tearDown();
  }));
}
