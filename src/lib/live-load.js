/**
 * Shared helpers for the Tuner and Grid live-source loads.
 *
 * Both views ask several live sources at once. Waiting for all of them meant
 * one slow source (typically a podcast-feed check) held the whole screen on
 * "Loading". Instead, each source is shown as soon as it answers, and each
 * source has a time limit so a stalled one can never block the view.
 */

export const LIVE_SOURCE_TIMEOUT_MS = 20_000;

/**
 * An abort signal that fires when `parent` aborts or `timeoutMs` passes.
 * `timedOut()` tells a timeout apart from an ordinary cancellation.
 * Always call `done()` once the source settles.
 */
export function sourceDeadline(parent, timeoutMs = LIVE_SOURCE_TIMEOUT_MS, timers = globalThis) {
  const controller = new AbortController();
  let expired = false;
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener?.('abort', onParentAbort, { once: true });
  const timer = timers.setTimeout(() => {
    expired = true;
    controller.abort(new Error(`Source did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    done() {
      timers.clearTimeout(timer);
      parent?.removeEventListener?.('abort', onParentAbort);
    },
  };
}

/**
 * One load of the Tuner or the Grid: every source in `candidates` is asked at
 * once (`ask(source, signal)`), each under its own time limit inside
 * `signal`, and reported as it answers (`onItems(source, items)`) or fails
 * (`onFailed(source, message)`; a plain cancellation is not a failure).
 * `onDone()` runs once all have settled. Once `isCurrent()` is false (a newer
 * load took over, or the view closed) nothing more is reported: an overtaken
 * load never changes the list, the source states or the automatic tries.
 */
export async function runLiveLoad({
  candidates, signal, ask, isCurrent, onItems, onFailed, onDone,
  timeoutMs = LIVE_SOURCE_TIMEOUT_MS, timers = globalThis,
}) {
  await Promise.allSettled(candidates.map((source) => {
    const deadline = sourceDeadline(signal, timeoutMs, timers);
    return Promise.resolve()
      .then(() => ask(source, deadline.signal))
      .then((items) => {
        if (isCurrent()) onItems(source, items);
      }, (error) => {
        if (!isCurrent()) return;
        if (deadline.timedOut() || error?.name !== 'AbortError') {
          onFailed(source, deadline.timedOut() ? 'Timed out' : String(error?.message || error));
        }
      })
      .finally(() => deadline.done());
  }));
  if (isCurrent()) onDone();
}

/**
 * Add one source's items to the list already on screen.
 * The source's previous items are replaced (so a refresh never duplicates),
 * everything else keeps its position, and items are de-duplicated by id.
 */
export function mergeSourceItems(current, sourceId, incoming, band) {
  const kept = (current || []).filter((item) => item.source !== sourceId);
  const seen = new Set(kept.map((item) => item.id));
  const added = (incoming || []).filter((item) => (
    item?.id && item.type === band && !seen.has(item.id) && seen.add(item.id)
  ));
  return [...kept, ...added];
}

/** "Loading 2 more sources…" style suffix while some sources are pending.
 *  During a refresh of the list already on screen it says "refreshing". */
export function pendingSourcesText(sourceStates) {
  const loading = [...sourceStates.values()].filter(({ state }) => state === 'loading');
  const pending = loading.length;
  if (!pending) return '';
  const plural = `source${pending === 1 ? '' : 's'}`;
  if (loading.every((status) => status.refreshing === true)) return ` · refreshing ${pending} ${plural}…`;
  return ` · loading ${pending} more ${plural}…`;
}

/**
 * The state a source is left in when it fails or times out. Its stations
 * from the previous load stay on screen when there are any ('stale', so the
 * status line can say they could not be refreshed); otherwise 'error'.
 */
export function failedSourceState(current, sourceId, message) {
  const count = (current || []).filter((item) => item?.source === sourceId).length;
  return { state: count > 0 ? 'stale' : 'error', count, error: String(message || '') };
}

/**
 * The status line under the Tuner and the Grid. `noun` is what is counted
 * ("stations", "live items"); `sourceCount` (the sources this load asks) is
 * used while nothing is known yet. A count of 0 sources is never shown
 * beside stations.
 */
export function liveStatusText({ count, noun, sourceStates, loading, sourceCount = 0 }) {
  const states = [...(sourceStates?.values?.() || [])];
  if (loading && count === 0) {
    const asked = states.length || sourceCount;
    return `Loading ${asked} live source${asked === 1 ? '' : 's'}\u2026`;
  }
  const has = (value) => states.filter(({ state }) => state === value).length;
  const stale = has('stale');
  const failures = has('error');
  const answered = has('ready') + stale + states.filter(({ state, refreshing }) => state === 'loading' && refreshing).length;
  return `${count} ${noun}${answered ? ` from ${answered} source${answered === 1 ? '' : 's'}` : ''}`
    + (stale ? ` · ${stale} source${stale === 1 ? '' : 's'} could not be refreshed (earlier list kept)` : '')
    + (failures ? ` · ${failures} unavailable` : '')
    + (loading ? pendingSourcesText(sourceStates) : '');
}

/**
 * How a load starts. Asking the same view again (same band, filters and
 * sources: `key` unchanged) keeps the list on screen and each source's
 * stations are replaced when it answers, so a source that fails keeps its
 * earlier list. Any change of view starts from an empty list.
 */
export function refreshKeepsList(previousKey, key, current) {
  return Boolean(key) && previousKey === key && (current || []).length > 0;
}

/** When an automatic try is made after a load left the view empty because a
 *  source failed: after 8 s, then after 20 s, then no more. */
export const LIVE_RETRY_DELAYS_MS = Object.freeze([8_000, 20_000]);

/** True while the window is not minimized or hidden. */
function documentVisible() {
  return globalThis.document?.visibilityState !== 'hidden';
}

/** Call `callback` when the window is shown again; returns the function that
 *  stops listening, or null when there is no window to listen to. */
function whenDocumentVisible(callback) {
  const doc = globalThis.document;
  if (typeof doc?.addEventListener !== 'function') return null;
  const onChange = () => { if (doc.visibilityState !== 'hidden') callback(); };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}

/**
 * Automatic tries for a view left empty by a failed source. `settle(true)`
 * after such a load waits for the next delay and calls `run()`. A try that
 * falls due while the window is hidden waits until it is shown again (one
 * listener) and is made then. Only one try is ever waiting; `run` only
 * happens while `isShown()` (the view is open) is true; `reset()` (any
 * reload the user asks for) cancels the wait and starts the count again, and
 * `stop()` cancels it when the view closes.
 */
export function createLiveRetry({
  run, isShown = () => true, isVisible = documentVisible, whenVisible = whenDocumentVisible,
  delays = LIVE_RETRY_DELAYS_MS, timers = globalThis,
} = {}) {
  let timer = null;
  let unwatch = null;
  let tries = 0;
  let halted = false;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (unwatch) unwatch();
    unwatch = null;
  };
  const attempt = () => {
    // The view was closed: no request; the user's next visit or press reloads.
    if (!isShown()) { halted = true; return; }
    tries += 1;
    run();
  };
  return {
    settle(failedEmpty) {
      clear();
      if (!failedEmpty || halted || tries >= delays.length) return false;
      timer = timers.setTimeout(() => {
        timer = null;
        if (isVisible()) { attempt(); return; }
        unwatch = whenVisible(() => {
          const stopWatching = unwatch;
          unwatch = null;
          stopWatching?.();
          attempt();
        }) || null;
        if (!unwatch) halted = true;
      }, delays[tries]);
      return true;
    },
    reset() { clear(); tries = 0; halted = false; },
    stop() { clear(); },
    waiting: () => timer !== null || unwatch !== null,
    tries: () => tries,
  };
}
