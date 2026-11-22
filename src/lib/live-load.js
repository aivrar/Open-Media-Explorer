/**
 * Shared helpers for the Tuner and Grid live-source loads.
 *
 * Both views ask several live sources at once. Waiting for all of them meant
 * one slow source (typically a podcast-feed check) held the whole screen on
 * "Loading". Instead, each source is shown as soon as it answers, and each
 * source has a time limit so a stalled one can never block the view.
 */

import { MAX_RETRY_AFTER_MS } from './catalog-scheduler.js';

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
 * (`onFailed(source, message, error)`; a plain cancellation is not a failure).
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
          onFailed(source, deadline.timedOut() ? 'Timed out' : String(error?.message || error), error);
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

/** When a source that failed is asked again by itself while the view stays
 *  open: after 15 s, then after 60 s, then every 5 minutes. */
export const SOURCE_RETRY_DELAYS_MS = Object.freeze([15_000, 60_000, 300_000]);

/**
 * The wait before a failed source is asked again, `tries` tries after its
 * first failure: the schedule's step, but never sooner than the provider
 * asked. A wait it declared (Retry-After, `error.retryAfterMs`; or
 * `declaredMs`, what the catalog scheduler still holds for it) is kept, and
 * a 429 that names no wait skips the quick first step.
 */
export function sourceRetryDelay(tries, error = null, declaredMs = 0, delays = SOURCE_RETRY_DELAYS_MS) {
  const step = (index) => delays[Math.min(Math.max(0, index), delays.length - 1)];
  const asked = Math.max(0, Number(error?.retryAfterMs) || 0, Number(declaredMs) || 0);
  const rateLimited = Number(error?.status) === 429 && asked === 0 ? step(tries + 1) : 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(step(tries), asked, rateLimited));
}

/** An outside answer after at least this long without one is taken as the
 *  line coming back (see createSourceRetries). */
export const LINE_BACK_QUIET_MS = 15_000;

/** Call `callback` on the window's `online` event; returns the function that
 *  stops listening, or null when there is no window to listen to. */
function whenOnline(callback) {
  const target = globalThis;
  if (typeof target?.addEventListener !== 'function') return null;
  target.addEventListener('online', callback);
  return () => target.removeEventListener('online', callback);
}

/**
 * Automatic tries of single sources, so one that failed while others
 * answered does not stay missing. `fail(source, run, { error, declaredMs })`
 * waits (sourceRetryDelay) and then calls `run(source, signal, isCurrent,
 * attempt)` (`attempt`: a number of its own for every try); when that try
 * fails too, the view calls `fail` again and the next step is used.
 * `succeeded(id)` forgets a source. A try due while the window is hidden is
 * made once it is shown again; none is made once the view is closed
 * (`isShown()`). `stop(ids)` (those sources; all without `ids`) clears their
 * waits and aborts their tries in flight, whose results are then no longer
 * current.
 *
 * When the line seems to be back, every source still waiting is tried at
 * once (`retryNow`): a retried source answered, the window got `online`, or
 * something outside answered (`onAnswer`, see lib/connection-evidence.js)
 * after LINE_BACK_QUIET_MS without any answer. Each source gets at most one
 * such early try per step of its schedule; one that fails stays on the wait
 * it was in, unless the provider answered it with a wait (429 or a declared
 * wait): then the next try is set from that answer. A source whose provider
 * asked to wait gets no early try until the wait is over. The listeners are there only while a source is waiting.
 */
export function createSourceRetries({
  isShown = () => true, isVisible = documentVisible, whenVisible = whenDocumentVisible,
  onAnswer = null, lastAnswerAt = () => 0, onOnline = whenOnline, quietMs = LINE_BACK_QUIET_MS,
  now = () => Date.now(), delays = SOURCE_RETRY_DELAYS_MS, timers = globalThis,
} = {}) {
  const entries = new Map();
  let sequence = 0;
  let unlisten = [];
  let lastSeen = 0;
  const clearWait = (entry) => {
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.timer = null;
    entry.unwatch?.();
    entry.unwatch = null;
  };
  const syncListeners = () => {
    if (entries.size === 0) {
      for (const stopListening of unlisten) stopListening();
      unlisten = [];
      return;
    }
    if (unlisten.length) return;
    lastSeen = Number(lastAnswerAt()) || 0;
    unlisten = [
      onOnline?.(() => retryNow()),
      onAnswer?.((at) => {
        const quiet = at - lastSeen >= quietMs;
        lastSeen = Math.max(lastSeen, at);
        // Not inside the request that noted the answer.
        if (quiet) Promise.resolve().then(retryNow);
      }),
    ].filter(Boolean);
  };
  const end = (id, abort = true) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    clearWait(entry);
    if (abort) entry.controller?.abort();
    syncListeners();
  };
  const attempt = (id, entry, early) => {
    if (entries.get(id) !== entry) return;
    // The view was closed: no request; the user's next visit loads it.
    if (!isShown()) { end(id); return; }
    if (entry.controller) {
      // Due while an early try is on its way: that try is this step's.
      if (!early && entry.early) { entry.early = false; entry.tries += 1; }
      return;
    }
    if (early) entry.earlyUsed = true;
    else entry.tries += 1;
    entry.early = early;
    const controller = new AbortController();
    entry.controller = controller;
    sequence += 1;
    void entry.run(entry.source, controller.signal,
      () => entries.get(id) === entry && entry.controller === controller && !controller.signal.aborted, sequence);
  };
  const retryNow = () => {
    if (!isVisible()) return;
    for (const [id, entry] of [...entries]) {
      const waiting = entry.timer !== null || entry.unwatch !== null;
      if (!waiting || entry.controller || entry.earlyUsed || now() < entry.holdUntil) continue;
      attempt(id, entry, true);
    }
  };
  return {
    fail(source, run, { error = null, declaredMs = 0 } = {}) {
      const id = source.id;
      const previous = entries.get(id);
      const askedToWait = Number(error?.status) === 429 || Number(error?.retryAfterMs) > 0 || Number(declaredMs) > 0;
      if (!askedToWait && previous?.early && (previous.timer !== null || previous.unwatch !== null)) {
        // An early try failed: back to the wait it was in.
        previous.early = false;
        previous.controller = null;
        return null;
      }
      // The try that just failed is over; its count carries on (an early try
      // the provider answered with a wait adds none, but its wait is kept).
      if (previous) clearWait(previous);
      const entry = {
        source, run, tries: previous?.tries || 0, timer: null, unwatch: null, controller: null,
        early: false, earlyUsed: false, holdUntil: 0,
      };
      entries.set(id, entry);
      const delay = sourceRetryDelay(entry.tries, error, declaredMs, delays);
      // A provider that asked to wait is never asked early.
      if (askedToWait) entry.holdUntil = now() + delay;
      entry.timer = timers.setTimeout(() => {
        entry.timer = null;
        if (isVisible()) { attempt(id, entry, false); return; }
        entry.unwatch = whenVisible(() => {
          const stopWatching = entry.unwatch;
          entry.unwatch = null;
          stopWatching?.();
          attempt(id, entry, false);
        }) || null;
        if (!entry.unwatch) end(id);
      }, delay);
      syncListeners();
      return delay;
    },
    succeeded(id) {
      const entry = entries.get(id);
      end(id, false);
      // A source that had failed answers again: the line may be back.
      if (entry?.controller) retryNow();
    },
    stop(ids = null) {
      for (const id of ids ? [...ids] : [...entries.keys()]) end(id);
    },
    retryNow,
    pending: () => [...entries.keys()],
    tries: (id) => entries.get(id)?.tries || 0,
    listening: () => unlisten.length > 0,
  };
}
