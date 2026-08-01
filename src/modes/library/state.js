/**
 * Mutable per-session Library state and its catalog-pool wrapper.
 * No DOM is created here; render-layer ids are only used as eviction pins.
 */

import { getState } from '../../lib/state.js';
import { artworkRequests } from '../../lib/artwork.js';
import {
  ensureCatalogStore,
  evictResidentItems,
  mergeCatalogItems,
} from './catalog-store.js';

export const PAGE_SIZE = 30;
export const RENDER_LIMIT_INITIAL = 300;
export const RENDER_LIMIT_STEP = 200;
export const RENDER_WINDOW_MAX = 300;
// Preserve the original Library contract: every unique item collected during
// this app session remains searchable/browsable and its source count cannot
// disappear. DOM work is still bounded independently by RENDER_WINDOW_MAX.
export const RESIDENT_ITEM_LIMIT = Number.POSITIVE_INFINITY;
export const AUTO_CHAIN_MIN_GAP_MS = 100;
export const CHAIN_RENDER_MIN_GAP_MS = 100;

export const view = {
  query: '',
  activeSource: 'all', // 'all' | adapter id | 'favorites' | 'type:radio' | ...
  filters: { type: '', country: '', language: '', yearMin: null, yearMax: null },
  items: [],
  itemIndex: new Map(),
  currentId: null,
  detailItemId: null,
  sourceStatus: new Map(),
  sourceCounts: new Map(),
  sourceProgress: new Map(),
  enabledSourcesSnapshot: new Set(),
  cumulativeCounts: new Map(),       // complete session source counts
  cumulativeTypeCounts: new Map(),   // complete session type counts
  cumulativeSourceTypeCounts: new Map(),
  sessionCounts: new Map(),          // accepted new items this session
  catalogRevision: 0,
  catalogNonAppendRevision: 0,
  finiteItemIds: new Set(),
  snapshotIdsBySource: new Map(),
  snapshotState: new Map(),
  loading: false,
  loadingMore: false,
  loadAbort: null,
  searchDebounced: null,
  catalogActive: false,
  chainTimer: null,
  sentinel: null,
  infiniteObserver: null,
  searchGen: 0,
  lastQuery: '',
  exhausted: new Set(),
  renderLimit: RENDER_LIMIT_INITIAL,
  renderStart: 0,
  renderSignature: '',
  contentPreference: null,
};

/** IDs of the card objects currently mounted by renderResults(). */
export const renderedIds = new Set();

/** Hydration observer + per-item promise dedupe. */
export const thumbHydration = {
  requests: artworkRequests,
  observer: null,
  observerRoot: null,
  abortController: null,
};

export function getCatalogPinnedIds(extra = []) {
  const appState = getState();
  const ids = new Set(extra);
  for (const favorite of appState.favorites || []) if (favorite?.id) ids.add(favorite.id);
  if (appState.currentItem?.id) ids.add(appState.currentItem.id);
  if (view.currentId) ids.add(view.currentId);
  if (view.detailItemId) ids.add(view.detailItemId);
  return ids;
}

export function enforceResidentCeiling(extraPinned = []) {
  return evictResidentItems(view, {
    limit: RESIDENT_ITEM_LIMIT,
    pinnedIds: getCatalogPinnedIds(extraPinned),
    visibleIds: renderedIds,
    activeQuery: view.lastQuery,
  });
}

/** Track catalog changes so the renderer can append-filter new pages without
 * rescanning a 40,000+ item session after every source completion. */
export function markCatalogMutation({ appendOnly = false } = {}) {
  view.catalogRevision += 1;
  if (!appendOnly) view.catalogNonAppendRevision = view.catalogRevision;
  return view.catalogRevision;
}

/** Add/update items while retaining the complete per-session catalog. */
export function addItems(items, queryTag = view.lastQuery, options = {}) {
  ensureCatalogStore(view);
  const result = mergeCatalogItems(view, items, {
    queryTag,
    kind: options.kind || 'finite',
  });
  const evicted = enforceResidentCeiling(options.pinnedIds || []);
  if (result.added > 0 || result.updated > 0 || evicted.length > 0) {
    markCatalogMutation({
      appendOnly: result.added > 0 && result.updated === 0 && evicted.length === 0,
    });
  }
  return { ...result, evicted };
}
