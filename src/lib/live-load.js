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

/** "Loading 2 more sources…" style suffix while some sources are pending. */
export function pendingSourcesText(sourceStates) {
  const pending = [...sourceStates.values()].filter(({ state }) => state === 'loading').length;
  if (!pending) return '';
  return ` · loading ${pending} more source${pending === 1 ? '' : 's'}…`;
}
