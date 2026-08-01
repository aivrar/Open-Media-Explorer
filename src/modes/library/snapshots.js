/** Optional live-snapshot orchestration, independent from finite page cursors. */

import { CATALOG_PRIORITY } from '../../lib/catalog-scheduler.js';
import { replaceSourceSnapshot } from './catalog-store.js';

export const SNAPSHOT_REFRESH_MIN_MS = 30_000;
export const SNAPSHOT_REFRESH_DEFAULT_MS = 120_000;
export const SNAPSHOT_REFRESH_MAX_MS = 30 * 60 * 1000;

function abortError(reason = 'Snapshot cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

function refreshDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return SNAPSHOT_REFRESH_DEFAULT_MS;
  return Math.max(SNAPSHOT_REFRESH_MIN_MS, Math.min(SNAPSHOT_REFRESH_MAX_MS, number));
}

export function createSnapshotManager(options) {
  const scheduler = options.scheduler;
  const loadAdapter = options.loadAdapter;
  const store = options.store;
  if (!scheduler || typeof loadAdapter !== 'function' || !store) {
    throw new TypeError('Snapshot manager requires scheduler, adapter loader, and store');
  }
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
  const getPinnedIds = options.getPinnedIds || (() => new Set());
  const isSourceEnabled = options.isSourceEnabled || (() => true);
  const getRefreshOptions = options.getRefreshOptions || (() => ({}));
  const filterItems = options.filterItems || ((items) => items);
  const onState = options.onState || (() => {});
  const onItemsChanged = options.onItemsChanged || (() => {});
  const states = store.snapshotState || (store.snapshotState = new Map());
  const timers = new Map();
  const generations = new Map();
  const controllers = new Map();
  const inFlight = new Map();
  const supported = new Set();
  const unsupported = new Set();
  const attempted = new Set();
  let active = true;

  const generation = (sourceId) => generations.get(sourceId) || 0;
  const bumpGeneration = (sourceId) => {
    const next = generation(sourceId) + 1;
    generations.set(sourceId, next);
    return next;
  };

  function publish(sourceId, patch) {
    const previous = states.get(sourceId) || {
      state: 'idle', stale: false, failures: 0, lastGoodAt: 0, snapshotId: '',
    };
    const next = { ...previous, ...patch };
    states.set(sourceId, next);
    onState(sourceId, next);
    return next;
  }

  function clearRefreshTimer(sourceId) {
    const handle = timers.get(sourceId);
    if (handle != null) clearTimer(handle);
    timers.delete(sourceId);
  }

  function scheduleRefresh(sourceId, delayMs, scheduleOptions = {}) {
    clearRefreshTimer(sourceId);
    if (!active || !isSourceEnabled(sourceId) || unsupported.has(sourceId)) return;
    const delay = scheduleOptions.exact === true
      ? Math.max(0, Number(delayMs) || 0)
      : refreshDelay(delayMs);
    timers.set(sourceId, setTimer(() => {
      timers.delete(sourceId);
      refresh(sourceId, { force: true }).catch(() => {});
    }, delay));
  }

  async function runRefresh(sourceId, refreshOptions = {}) {
    if (!active) throw abortError('Snapshot manager paused');
    if (!isSourceEnabled(sourceId)) throw abortError('Source disabled');
    if (unsupported.has(sourceId)) return { supported: false };
    attempted.add(sourceId);
    clearRefreshTimer(sourceId);
    const expectedGeneration = generation(sourceId);
    const controller = new AbortController();
    controllers.set(sourceId, controller);
    const externalSignal = refreshOptions.signal;
    const onExternalAbort = () => controller.abort(abortError(externalSignal.reason));
    if (externalSignal?.aborted) controller.abort(abortError(externalSignal.reason));
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const oldState = states.get(sourceId);
    publish(sourceId, {
      state: oldState?.lastGoodAt ? 'refreshing' : 'loading',
      error: '',
      retryAt: 0,
    });
    try {
      const result = await scheduler.enqueue({
        sourceId,
        key: `snapshot:${expectedGeneration}`,
        priority: refreshOptions.priority ?? CATALOG_PRIORITY.SNAPSHOT,
        signal: controller.signal,
        task: async ({ signal }) => {
          const adapter = await loadAdapter(sourceId);
          if (typeof adapter.refreshSnapshot !== 'function') return { supported: false };
          supported.add(sourceId);
          const value = await adapter.refreshSnapshot({
            signal,
            force: refreshOptions.force === true,
            ...(Object.hasOwn(refreshOptions, 'showExplicitContent')
              ? { showExplicitContent: refreshOptions.showExplicitContent === true }
              : {}),
          });
          if (!value || !Array.isArray(value.items)) {
            throw new TypeError(`${sourceId} refreshSnapshot returned an invalid snapshot`);
          }
          return {
            supported: true,
            items: value.items,
            snapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : '',
            refreshAfterMs: refreshDelay(value.refreshAfterMs),
            stale: value.stale === true,
            error: value.stale === true
              ? String(value.error || 'The last verified snapshot is temporarily stale.').slice(0, 500)
              : '',
            retryAfterMs: value.stale === true
              ? refreshDelay(value.retryAfterMs)
              : 0,
          };
        },
      });

      if (result.supported === false) {
        unsupported.add(sourceId);
        supported.delete(sourceId);
        states.delete(sourceId);
        onState(sourceId, null);
        return result;
      }
      if (!active || controller.signal.aborted || expectedGeneration !== generation(sourceId)
          || !isSourceEnabled(sourceId)) {
        throw abortError('Stale snapshot completion');
      }
      const visibleItems = filterItems(result.items, sourceId);
      if (!Array.isArray(visibleItems)) {
        throw new TypeError('Snapshot content filter must return an array');
      }
      const replacement = replaceSourceSnapshot(store, sourceId, visibleItems, {
        pinnedIds: getPinnedIds(sourceId),
      });
      const previous = states.get(sourceId) || {};
      const observedAt = now();
      const retryAfterMs = result.stale
        ? result.retryAfterMs
        : result.refreshAfterMs;
      const next = publish(sourceId, result.stale ? {
        state: 'stale',
        stale: true,
        failures: (previous.failures || 0) + 1,
        error: result.error,
        retryAt: observedAt + retryAfterMs,
        // A native last-known-good cache may be the first snapshot observed by
        // a freshly started frontend. It is still verified data, but its age is
        // unknown, so record only when this frontend first received it.
        lastGoodAt: previous.lastGoodAt || observedAt,
        snapshotId: result.snapshotId,
        refreshAfterMs: result.refreshAfterMs,
        count: visibleItems.length,
      } : {
        state: 'live',
        stale: false,
        failures: 0,
        error: '',
        retryAt: 0,
        lastGoodAt: observedAt,
        snapshotId: result.snapshotId,
        refreshAfterMs: result.refreshAfterMs,
        count: visibleItems.length,
      });
      onItemsChanged(sourceId, replacement, next);
      scheduleRefresh(sourceId, retryAfterMs);
      return { ...result, replacement };
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted
          || expectedGeneration !== generation(sourceId) || !active) throw abortError(error);
      const previous = states.get(sourceId) || {};
      const failures = (previous.failures || 0) + 1;
      const requestedDelay = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : Math.min(SNAPSHOT_REFRESH_MAX_MS, 1_500 * (2 ** Math.max(0, failures - 1)));
      const retryAfterMs = refreshDelay(requestedDelay);
      const hasLastGood = Boolean(previous.lastGoodAt)
        || (store.snapshotIdsBySource.get(sourceId)?.size || 0) > 0;
      publish(sourceId, {
        state: hasLastGood ? 'stale' : 'retrying',
        stale: hasLastGood,
        failures,
        error: String(error?.message || error),
        retryAt: now() + retryAfterMs,
      });
      scheduleRefresh(sourceId, retryAfterMs);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (controllers.get(sourceId) === controller) controllers.delete(sourceId);
    }
  }

  function refresh(sourceId, refreshOptions = {}) {
    const effectiveOptions = { ...getRefreshOptions(sourceId), ...refreshOptions };
    const existing = inFlight.get(sourceId);
    if (existing) return existing;
    const promise = runRefresh(sourceId, effectiveOptions).finally(() => {
      if (inFlight.get(sourceId) === promise) inFlight.delete(sourceId);
    });
    inFlight.set(sourceId, promise);
    return promise;
  }

  function invalidateSource(sourceId, reason = 'Snapshot preference changed') {
    bumpGeneration(sourceId);
    clearRefreshTimer(sourceId);
    controllers.get(sourceId)?.abort(abortError(reason));
    controllers.delete(sourceId);
    inFlight.delete(sourceId);
  }

  function disableSource(sourceId) {
    invalidateSource(sourceId, 'Source disabled');
    scheduler.setSourceEnabled(sourceId, false);
    publish(sourceId, { state: 'disabled', stale: false, retryAt: 0 });
  }

  function enableSource(sourceId) {
    bumpGeneration(sourceId);
    scheduler.setSourceEnabled(sourceId, true);
    if (!unsupported.has(sourceId) && (supported.has(sourceId) || attempted.has(sourceId))) {
      refresh(sourceId, { force: true }).catch(() => {});
    }
  }

  function pause() {
    active = false;
    for (const sourceId of [...timers.keys()]) clearRefreshTimer(sourceId);
    for (const [sourceId, controller] of controllers) {
      bumpGeneration(sourceId);
      controller.abort(abortError('Snapshot manager paused'));
    }
    controllers.clear();
    inFlight.clear();
  }

  function resume() {
    if (active) return;
    active = true;
    for (const sourceId of new Set([...supported, ...attempted])) {
      if (unsupported.has(sourceId)) continue;
      if (!isSourceEnabled(sourceId)) continue;
      const state = states.get(sourceId) || {};
      const refreshDueAt = state.lastGoodAt != null && state.refreshAfterMs != null
        ? Number(state.lastGoodAt) + Number(state.refreshAfterMs)
        : 0;
      // A stale/retrying snapshot intentionally retries sooner than its normal
      // healthy cadence. Pausing the Library must preserve that retry deadline
      // rather than stretching it back out to the two-minute live interval.
      const dueAt = Number(state.retryAt) > 0
        ? Number(state.retryAt)
        : refreshDueAt;
      if (dueAt > now()) scheduleRefresh(sourceId, dueAt - now(), { exact: true });
      else refresh(sourceId, { force: true }).catch(() => {});
    }
  }

  function destroy() {
    pause();
    unsupported.clear();
    supported.clear();
    attempted.clear();
  }

  return {
    refresh,
    invalidateSource,
    disableSource,
    enableSource,
    pause,
    resume,
    destroy,
    state: (sourceId) => states.get(sourceId) || null,
    hasDiscovered: (sourceId) => supported.has(sourceId) || unsupported.has(sourceId)
      || inFlight.has(sourceId)
      || ['live', 'stale', 'retrying', 'refreshing'].includes(states.get(sourceId)?.state),
    get active() { return active; },
    get timerCount() { return timers.size; },
  };
}
