/**
 * Fair cursor/snapshot orchestration for the accumulating Library pool.
 * Only explicit adapter exhaustion retires a finite cursor; every transport,
 * parse, timeout, and cancellation path keeps the same cursor recoverable.
 */

import { getState } from '../../lib/state.js';
import { SOURCES, loadAdapter } from '../../lib/sources.js';
import {
  catalogScheduler, CATALOG_PRIORITY,
} from '../../lib/catalog-scheduler.js';
import { searchOne, browsePageOne } from '../../lib/search.js';
import {
  view, addItems, enforceResidentCeiling, getCatalogPinnedIds, markCatalogMutation,
  PAGE_SIZE, RENDER_LIMIT_INITIAL, AUTO_CHAIN_MIN_GAP_MS, CHAIN_RENDER_MIN_GAP_MS,
} from './state.js';
import {
  createSourceProgress, recordSourceFailure, recordSourceSuccess,
} from './progress.js';
import { filterContentItems } from '../../lib/content-rating.js';
import { removeSourceItems } from './catalog-store.js';
import { createSnapshotManager } from './snapshots.js';
import {
  renderResults, renderStatus, updateSidebarCounts,
  updateSentinelStatus, setSourceStatus, expandRenderWindow,
} from './render.js';

let unbindVisibility = null;

export function fetchSourcesAllEnabled() {
  return SOURCES
    .filter((source) => getState().settings.enabledSources[source.id] !== false)
    .map((source) => source.id);
}

function sourceEnabled(sourceId) {
  return getState().settings.enabledSources[sourceId] !== false;
}

function mergeFiniteStatus(sourceId, finite) {
  const previous = view.sourceStatus.get(sourceId) || {};
  const snapshot = previous.snapshot ?? view.snapshotState.get(sourceId) ?? null;
  setSourceStatus(sourceId, { ...previous, ...finite, snapshot });
}

const snapshotManager = createSnapshotManager({
  scheduler: catalogScheduler,
  loadAdapter,
  store: view,
  getPinnedIds: () => getCatalogPinnedIds(),
  isSourceEnabled: sourceEnabled,
  getRefreshOptions: () => ({
    showExplicitContent: getState().settings.showExplicitContent === true,
  }),
  filterItems: (items) => filterContentItems(items, getState().settings),
  onState: (sourceId, snapshot) => {
    const previous = view.sourceStatus.get(sourceId) || {};
    if (!snapshot) {
      const next = { ...previous };
      delete next.snapshot;
      setSourceStatus(sourceId, next);
    } else {
      setSourceStatus(sourceId, { ...previous, snapshot });
    }
    if (view.catalogActive) queueChainRender();
  },
  onItemsChanged: () => {
    markCatalogMutation();
    enforceResidentCeiling();
    if (view.catalogActive) queueChainRender();
  },
});

function clearChainTimer() {
  if (view.chainTimer != null) clearTimeout(view.chainTimer);
  view.chainTimer = null;
}

function ensureProgress(sourceId) {
  let progress = view.sourceProgress.get(sourceId);
  if (!progress) {
    progress = createSourceProgress();
    view.sourceProgress.set(sourceId, progress);
  }
  return progress;
}

function resetBrowseProgress(sourceIds = fetchSourcesAllEnabled()) {
  clearChainTimer();
  view.sourceProgress.clear();
  view.sourceCounts.clear();
  view.exhausted = new Set();
  view.enabledSourcesSnapshot = new Set(sourceIds);
  for (const id of sourceIds) view.sourceProgress.set(id, createSourceProgress());
}

function renderChainState() {
  if (!view.catalogActive) return;
  renderResults();
  renderStatus();
  updateSidebarCounts();
  updateSentinelStatus();
}

let renderQueued = false;
let renderTimer = null;
let lastChainRenderAt = 0;
function queueChainRender() {
  if (renderQueued || !view.catalogActive) return;
  renderQueued = true;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const delay = Math.max(0, CHAIN_RENDER_MIN_GAP_MS - (now - lastChainRenderAt));
  const flush = () => {
    renderTimer = null;
    renderQueued = false;
    lastChainRenderAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    renderChainState();
  };
  const scheduleFrame = () => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else queueMicrotask(flush);
  };
  if (delay > 0) renderTimer = setTimeout(scheduleFrame, delay);
  else scheduleFrame();
}

function statusFromProgress(progress) {
  if (progress.inFlight) return { state: 'loading', count: progress.loaded };
  if (progress.error) {
    return {
      state: progress.rateLimited ? 'rate-limited' : 'retrying',
      count: progress.loaded,
      error: progress.error,
      retryAt: progress.retryAt,
    };
  }
  if (progress.exhausted) return { state: 'complete', count: progress.loaded };
  return { state: 'more', count: progress.loaded };
}

function restoreBrowseStatuses() {
  view.sourceStatus.clear();
  for (const id of SOURCES.map((source) => source.id)) {
    if (!sourceEnabled(id)) {
      mergeFiniteStatus(id, { state: 'disabled', count: 0 });
      continue;
    }
    mergeFiniteStatus(id, statusFromProgress(ensureProgress(id)));
  }
}

function currentGenerationSignal() {
  if (!view.loadAbort || view.loadAbort.signal.aborted) view.loadAbort = new AbortController();
  return view.loadAbort.signal;
}

function beginGeneration() {
  view.loadAbort?.abort(new DOMException('Catalog generation replaced', 'AbortError'));
  view.loadAbort = new AbortController();
  view.searchGen += 1;
  return { generation: view.searchGen, signal: view.loadAbort.signal };
}

function scheduleNextLoad(minimumDelay = AUTO_CHAIN_MIN_GAP_MS) {
  clearChainTimer();
  if (!view.catalogActive) {
    updateSentinelStatus();
    return;
  }
  const now = Date.now();
  const waiting = fetchSourcesAllEnabled()
    .map((id) => ensureProgress(id))
    .filter((progress) => !progress.exhausted && !progress.inFlight);
  if (waiting.length === 0) {
    updateSentinelStatus();
    return;
  }
  const ready = waiting.some((progress) => progress.retryAt <= now);
  const earliestRetry = Math.min(...waiting.map((progress) => progress.retryAt || now));
  const delay = ready ? Math.max(0, minimumDelay) : Math.max(minimumDelay, earliestRetry - now);
  view.chainTimer = setTimeout(() => {
    view.chainTimer = null;
    maybeLoadMore();
  }, delay);
}

function cursorKey(cursor) {
  try { return JSON.stringify(cursor ?? null); } catch (_) { return String(cursor); }
}

function discoverSnapshot(sourceId) {
  if (!view.catalogActive || !sourceEnabled(sourceId)) return;
  if (snapshotManager.hasDiscovered(sourceId)) return;
  // Snapshot lifetime belongs to the mode/source manager, not to a finite
  // browse or text-search generation. Mode pause and source disable already
  // abort it explicitly; replacing a search must not strand live discovery.
  snapshotManager.refresh(sourceId).catch((error) => {
    if (error?.name !== 'AbortError') console.warn(`[${sourceId}] snapshot refresh failed:`, error);
  });
}

async function fetchBrowsePage(sourceId, generation, options = {}) {
  const progress = ensureProgress(sourceId);
  if (progress.exhausted || progress.inFlight || progress.retryAt > Date.now() || !sourceEnabled(sourceId)) return;
  progress.inFlight = true;
  view.loadingMore = true;
  mergeFiniteStatus(sourceId, { state: 'loading', count: progress.loaded });
  const generationSignal = options.signal || currentGenerationSignal();
  const requestedCursorKey = cursorKey(progress.cursor);

  try {
    const page = await catalogScheduler.enqueue({
      sourceId,
      key: `browse:${generation}:${requestedCursorKey}`,
      priority: options.priority ?? CATALOG_PRIORITY.PREFETCH,
      signal: generationSignal,
      task: ({ signal }) => browsePageOne(sourceId, {
        limit: PAGE_SIZE,
        cursor: progress.cursor,
        signal,
      }),
    });
    if (generation !== view.searchGen || generationSignal.aborted || !sourceEnabled(sourceId)) return;
    if (page.exhausted !== true
        && (page.cursor == null || cursorKey(page.cursor) === requestedCursorKey)) {
      throw new TypeError(`[${sourceId}] non-exhausted browse page did not advance its cursor`);
    }

    addItems(page.items, '', { kind: 'finite' });
    const sessionCount = view.sessionCounts.get(sourceId) || 0;
    recordSourceSuccess(progress, page, sessionCount);
    view.sourceCounts.set(sourceId, sessionCount);
    if (progress.exhausted) view.exhausted.add(sourceId);
    else view.exhausted.delete(sourceId);
    mergeFiniteStatus(sourceId, statusFromProgress(progress));
    queueMicrotask(() => discoverSnapshot(sourceId));
  } catch (error) {
    if (generation !== view.searchGen || generationSignal.aborted || error?.name === 'AbortError') return;
    if (!sourceEnabled(sourceId)) {
      mergeFiniteStatus(sourceId, { state: 'disabled', count: progress.loaded });
      return;
    }
    recordSourceFailure(progress, error);
    view.exhausted.delete(sourceId);
    mergeFiniteStatus(sourceId, statusFromProgress(progress));
  } finally {
    progress.inFlight = false;
    view.loadingMore = [...view.sourceProgress.values()].some((item) => item.inFlight);
    if (generation === view.searchGen && !generationSignal.aborted) {
      if (sourceEnabled(sourceId)) mergeFiniteStatus(sourceId, statusFromProgress(progress));
      queueChainRender();
      if (options.autoChain !== false) scheduleNextLoad();
    }
  }
}

export async function runSearch() {
  const { generation, signal } = beginGeneration();
  clearChainTimer();
  view.catalogActive = true;
  const query = (view.query || '').trim();
  view.lastQuery = query;
  view.renderLimit = RENDER_LIMIT_INITIAL;
  view.renderStart = 0;

  const hasBrowseHistory = view.sourceCounts.size > 0
    || [...view.sourceProgress.values()].some((progress) => (
      progress.cursor != null || progress.failures > 0 || progress.exhausted
    ));
  if (!query && hasBrowseHistory) {
    view.loading = false;
    restoreBrowseStatuses();
    renderChainState();
    scheduleNextLoad(0);
    return;
  }

  if (!query) {
    const sourceIds = fetchSourcesAllEnabled();
    resetBrowseProgress(sourceIds);
    view.sourceStatus.clear();
    view.loading = true;
    for (const source of SOURCES) {
      const enabled = sourceIds.includes(source.id);
      setSourceStatus(source.id, { state: enabled ? 'loading' : 'disabled', count: 0 });
      catalogScheduler.setSourceEnabled(source.id, enabled);
    }
    renderChainState();
    await Promise.allSettled(sourceIds.map((sourceId) => fetchBrowsePage(sourceId, generation, {
      priority: CATALOG_PRIORITY.INITIAL,
      signal,
    })));
    if (generation !== view.searchGen || signal.aborted) return;
    view.loading = false;
    renderChainState();
    scheduleNextLoad();
    return;
  }

  // Search is a bounded page-0 snapshot. Partial results still render as each
  // scheduled source completes; the finite browse cursors remain independent.
  view.loading = false;
  view.sourceStatus.clear();
  const sourceIds = fetchSourcesAllEnabled();
  for (const source of SOURCES) {
    mergeFiniteStatus(source.id, {
      state: sourceIds.includes(source.id) ? 'loading' : 'disabled', count: 0,
    });
  }
  renderChainState();

  await Promise.allSettled(sourceIds.map((sourceId) => catalogScheduler.enqueue({
    sourceId,
    key: `search:${generation}:${query}`,
    priority: CATALOG_PRIORITY.SEARCH,
    signal,
    task: ({ signal: taskSignal }) => searchOne(sourceId, query, {
      limit: PAGE_SIZE,
      offset: 0,
      signal: taskSignal,
      throwOnError: true,
      onPartial: (id, items) => {
        if (taskSignal.aborted || generation !== view.searchGen) return;
        addItems(items, query, { kind: 'search' });
        mergeFiniteStatus(id, { state: 'ready', count: items.length });
        queueChainRender();
      },
      onError: (id, error) => {
        if (taskSignal.aborted || generation !== view.searchGen) return;
        mergeFiniteStatus(id, {
          state: Number(error?.status) === 429 ? 'rate-limited' : 'retrying',
          count: 0,
          error: String(error?.message || error),
          retryAt: Date.now() + Number(error?.retryAfterMs || 0),
        });
      },
    }),
  })));
  if (generation !== view.searchGen || signal.aborted) return;
  // A search-first session must still enroll live-snapshot adapters in their
  // independent refresh lifecycle. The adapter can donate the just-loaded
  // verified result, avoiding another network request while the manager takes
  // ownership of its timer and stale state.
  for (const sourceId of sourceIds) discoverSnapshot(sourceId);
  renderChainState();
  scheduleNextLoad();
}

export async function loadMore(options = {}) {
  if (!view.catalogActive) return;
  const priority = options.priority ?? CATALOG_PRIORITY.PREFETCH;
  const generation = view.searchGen;
  const signal = currentGenerationSignal();
  const now = Date.now();
  const readyIds = fetchSourcesAllEnabled().filter((sourceId) => {
    const progress = ensureProgress(sourceId);
    return !progress.exhausted && !progress.inFlight && progress.retryAt <= now;
  });
  if (readyIds.length === 0) {
    scheduleNextLoad();
    return;
  }
  view.loadingMore = true;
  updateSentinelStatus();
  await Promise.allSettled(readyIds.map((sourceId) => fetchBrowsePage(sourceId, generation, {
    priority,
    signal,
  })));
  if (generation !== view.searchGen || signal.aborted) return;
  renderChainState();
  scheduleNextLoad();
}

export function maybeLoadMore(options = {}) {
  if (!view.catalogActive) return;
  loadMore(options).catch((error) => {
    if (error?.name !== 'AbortError') console.error('[library] loadMore failed:', error);
    view.loadingMore = false;
    scheduleNextLoad();
  });
}

export function retrySources({ restartExhausted = true } = {}) {
  clearChainTimer();
  for (const sourceId of fetchSourcesAllEnabled()) {
    snapshotManager.refresh(sourceId, {
      priority: CATALOG_PRIORITY.USER,
      force: true,
    }).catch((error) => {
      if (error?.name !== 'AbortError') {
        console.warn(`[${sourceId}] manual snapshot retry failed:`, error);
      }
    });
  }
  if ((view.lastQuery || '').trim()) {
    for (const sourceId of fetchSourcesAllEnabled()) catalogScheduler.resetSource(sourceId);
    return runSearch().catch((error) => {
      if (error?.name !== 'AbortError') console.error('[library] search retry failed:', error);
    });
  }
  for (const sourceId of fetchSourcesAllEnabled()) {
    catalogScheduler.resetSource(sourceId);
    let progress = ensureProgress(sourceId);
    if (restartExhausted && progress.exhausted) {
      progress = createSourceProgress();
      view.sourceProgress.set(sourceId, progress);
      view.sourceCounts.delete(sourceId);
    } else {
      progress.failures = 0;
      progress.retryAt = 0;
      progress.error = '';
      progress.rateLimited = false;
    }
    if (restartExhausted) {
      progress.exhausted = false;
      view.exhausted.delete(sourceId);
    }
    mergeFiniteStatus(sourceId, statusFromProgress(progress));
  }
  renderChainState();
  queueMicrotask(() => maybeLoadMore({ priority: CATALOG_PRIORITY.USER }));
}

export function loadMoreNow() {
  maybeLoadMore({ priority: CATALOG_PRIORITY.USER });
}

export function reconcileEnabledSources() {
  const current = new Set(fetchSourcesAllEnabled());
  const previous = view.enabledSourcesSnapshot;
  const changed = current.size !== previous.size
    || [...current].some((sourceId) => !previous.has(sourceId));
  for (const source of SOURCES) {
    const sourceId = source.id;
    const enabled = current.has(sourceId);
    catalogScheduler.setSourceEnabled(sourceId, enabled);
    if (enabled && !previous.has(sourceId)) {
      view.sourceProgress.set(sourceId, createSourceProgress());
      view.sourceCounts.delete(sourceId);
      view.exhausted.delete(sourceId);
      snapshotManager.enableSource(sourceId);
    } else if (!enabled && previous.has(sourceId)) {
      snapshotManager.disableSource(sourceId);
      const removed = removeSourceItems(view, sourceId);
      if (removed.length > 0) markCatalogMutation();
      const progress = view.sourceProgress.get(sourceId);
      if (progress) progress.inFlight = false;
      mergeFiniteStatus(sourceId, { state: 'disabled', count: 0 });
    } else if (!enabled) {
      // A source that was already disabled has no work to cancel. Keep its
      // visible status and transient pool defensive without repeatedly
      // advancing snapshot generations on unrelated settings changes.
      const removed = removeSourceItems(view, sourceId);
      if (removed.length > 0) markCatalogMutation();
      mergeFiniteStatus(sourceId, { state: 'disabled', count: 0 });
    }
  }
  view.enabledSourcesSnapshot = current;
  if (changed) {
    clearChainTimer();
    if (view.catalogActive) queueMicrotask(() => maybeLoadMore());
  }
  return changed;
}

const CONTENT_AWARE_FINITE_SOURCES = Object.freeze(['iptv-org', 'gpodder', 'peertube']);
const CONTENT_AWARE_SNAPSHOT_SOURCES = Object.freeze(['owncast']);

/**
 * Replace the active Library generation when the deliberate content setting
 * changes. Turning off is an immediate local filter. Turning on replays only
 * the three rating-aware finite adapters (their IPTV/podcast caches are local;
 * PeerTube intentionally performs a fresh upstream page) plus Owncast's cached
 * verified snapshot.
 */
export function reconcileContentPreference(previous, current) {
  const showExplicit = current === true;
  view.contentPreference = showExplicit;
  view.renderSignature = '';
  const { generation, signal } = beginGeneration();
  clearChainTimer();

  // Rating-aware cursors are defined over different visible pools. Reset
  // them on both transitions so the next user-driven page cannot skip safe
  // rows (or repeat an upstream PeerTube cursor from the opposite policy).
  const finiteSourceIds = CONTENT_AWARE_FINITE_SOURCES.filter(sourceEnabled);
  for (const sourceId of finiteSourceIds) {
    catalogScheduler.resetSource(sourceId);
    view.sourceProgress.set(sourceId, createSourceProgress());
    view.sourceCounts.delete(sourceId);
    view.exhausted.delete(sourceId);
    mergeFiniteStatus(sourceId, {
      state: showExplicit && view.catalogActive ? 'loading' : 'more',
      count: 0,
      error: '',
    });
  }

  for (const sourceId of CONTENT_AWARE_SNAPSHOT_SOURCES) {
    snapshotManager.invalidateSource(sourceId);
    if (sourceEnabled(sourceId) && view.catalogActive) {
      snapshotManager.refresh(sourceId, {
        priority: CATALOG_PRIORITY.USER,
        showExplicitContent: showExplicit,
      }).catch((error) => {
        if (error?.name !== 'AbortError') {
          console.warn(`[${sourceId}] content snapshot refresh failed:`, error);
        }
      });
    }
  }

  queueChainRender();
  if (!showExplicit || !view.catalogActive) {
    return Promise.resolve([]);
  }

  const query = (view.lastQuery || '').trim();
  const jobs = query
    ? finiteSourceIds.map((sourceId) => catalogScheduler.enqueue({
      sourceId,
      key: `content-search:${generation}:${query}`,
      priority: CATALOG_PRIORITY.USER,
      signal,
      task: ({ signal: taskSignal }) => searchOne(sourceId, query, {
        limit: PAGE_SIZE,
        offset: 0,
        signal: taskSignal,
        throwOnError: true,
        onPartial: (id, items) => {
          if (taskSignal.aborted || generation !== view.searchGen) return;
          addItems(items, query, { kind: 'search' });
          mergeFiniteStatus(id, { state: 'ready', count: items.length, error: '' });
          queueChainRender();
        },
      }),
    }))
    : finiteSourceIds.map((sourceId) => fetchBrowsePage(sourceId, generation, {
      priority: CATALOG_PRIORITY.USER,
      signal,
      autoChain: false,
    }));

  return Promise.allSettled(jobs).finally(() => {
    if (generation !== view.searchGen || signal.aborted) return;
    queueChainRender();
  });
}

export function resumeCatalogWork() {
  view.catalogActive = true;
  currentGenerationSignal();
  if (!unbindVisibility) unbindVisibility = catalogScheduler.bindVisibility();
  snapshotManager.resume();
  restoreBrowseStatuses();
  scheduleNextLoad(0);
}

export function pauseCatalogWork() {
  if (!view.catalogActive && !unbindVisibility) return;
  view.catalogActive = false;
  view.searchGen += 1;
  clearChainTimer();
  if (renderTimer != null) clearTimeout(renderTimer);
  renderTimer = null;
  renderQueued = false;
  view.searchDebounced?.cancel?.();
  view.searchDebounced = null;
  view.loadAbort?.abort(new DOMException('Library mode paused', 'AbortError'));
  view.loadAbort = null;
  view.loading = false;
  view.loadingMore = false;
  for (const progress of view.sourceProgress.values()) progress.inFlight = false;
  snapshotManager.pause();
  if (unbindVisibility) unbindVisibility();
  unbindVisibility = null;
}

export function onSentinelVisible() {
  const poolSize = view.activeSource === 'favorites'
    ? (getState().favorites || []).length
    : view.items.length;
  if (poolSize === 0) return;
  const advanced = expandRenderWindow();
  if (advanced) {
    scheduleNextLoad(0);
    return;
  }
  maybeLoadMore();
}
