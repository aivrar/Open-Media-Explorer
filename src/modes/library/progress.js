/** Pure per-source pagination/retry state used by the library chain. */

import { MAX_RETRY_AFTER_MS } from '../../lib/catalog-scheduler.js';

export const RETRY_BASE_MS = 1_500;
export const RETRY_MAX_MS = 30_000;
// A source may declare a hold longer than an hour (up to six hours after a
// block); a declared wait is never shortened below that. Same cap as the
// scheduler's declared cooldown.
export const RETRY_AFTER_MAX_MS = MAX_RETRY_AFTER_MS;

/** The same page failing this many times in a row ends the quick retries of
 *  that source. From then on it is asked again only slowly (see
 *  slowRetryDelayMs) until it answers or the user presses Retry now. */
export const AUTO_RETRY_LIMIT = 2;

// The slow retries: after one minute, then two, four and eight, then every
// ten minutes. A source that is down costs a handful of requests an hour, and
// one that was only slow for a moment (a time-out at start-up) comes back by
// itself instead of staying empty for the rest of the session.
export const SLOW_RETRY_BASE_MS = 60_000;
export const SLOW_RETRY_MAX_MS = 10 * 60_000;

/** The pause before the next automatic try once `failures` requests of the
 *  same page have failed in a row (failures >= AUTO_RETRY_LIMIT). */
export function slowRetryDelayMs(failures) {
  const step = Math.min(10, Math.max(0, Number(failures || 0) - AUTO_RETRY_LIMIT));
  return Math.min(SLOW_RETRY_MAX_MS, SLOW_RETRY_BASE_MS * (2 ** step));
}

/** True for a source whose quick retries are used up and which is now asked
 *  again only slowly. A declared wait (rate limit, hold) is not this. */
export function isSlowRetryProgress(progress) {
  return Boolean(progress && progress.error && !progress.rateLimited && !progress.stopped
    && progress.failures >= AUTO_RETRY_LIMIT);
}

/** A refusal of the request itself (HTTP 4xx other than 408 and 429, with
 *  no wait declared): asking for the same page again cannot help. A source
 *  that declares a wait (a block with Retry-After) is held instead. */
/** The wait an error declares (Retry-After), in ms, or NaN when it declares
 *  none. An HttpError without a Retry-After carries retryAfterMs: null, and
 *  Number(null) is 0: read that way, every failed request "declared" a wait
 *  of 0 ms and was retried at once, with no backoff and no bound. */
export function declaredWaitMs(err) {
  const value = err?.retryAfterMs;
  if (value == null || value === '') return Number.NaN;
  return Number(value);
}

export function isClientRefusal(err) {
  const status = Number(err?.status || 0);
  const declared = declaredWaitMs(err);
  if (Number.isFinite(declared) && declared > 0) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function createSourceProgress() {
  return {
    cursor: null,
    loaded: 0,
    exhausted: false,
    // Automatic loading stopped because the provider refused the page;
    // only the user's Retry starts it again. Repeated failures do not stop
    // a source: they slow its retries down (isSlowRetryProgress).
    stopped: false,
    failures: 0,
    retryAt: 0,
    error: '',
    notice: '',
    inFlight: false,
    rateLimited: false,
  };
}

/** True while a source is waiting out a delay it declared (a hold or rate limit). */
export function isHeldProgress(progress, now = Date.now()) {
  return Boolean(progress?.rateLimited && progress.error && progress.retryAt > now);
}

/**
 * Run one job per source. Each source's own follow-up runs as soon as that
 * source settles, so a source that is still waiting (for example behind a
 * long hold) never delays the others. `all` settles when every job has;
 * `only(ids)` when the named jobs have; `untilSettledExcept(skip)` when every
 * job has settled or `skip(sourceId)` says it need not be waited for. That
 * check is repeated whenever a job settles and every `pollMs`, so a source
 * that goes on hold mid-way stops being waited for promptly.
 */
export function settleEachSource(sourceIds, runOne, onSettled) {
  const done = new Set();
  const listeners = new Set();
  const jobs = new Map(sourceIds.map((sourceId) => [sourceId, Promise.resolve()
    .then(() => runOne(sourceId))
    .finally(() => {
      done.add(sourceId);
      try {
        onSettled(sourceId);
      } finally {
        for (const listener of [...listeners]) listener();
      }
    })]));
  const only = (ids) => Promise.allSettled(ids.filter((id) => jobs.has(id)).map((id) => jobs.get(id)));

  /** Resolves once every source has settled or is skipped, or at once when
   *  `signal` aborts (a replaced or cancelled search); the poll timer and the
   *  listeners are removed either way. */
  function untilSettledExcept(skip, {
    pollMs = 500, setTimer = setTimeout, clearTimer = clearTimeout, signal = null,
  } = {}) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        listeners.delete(check);
        signal?.removeEventListener?.('abort', finish);
        if (timer != null) clearTimer(timer);
        timer = null;
        resolve();
      };
      function check() {
        if (!sourceIds.every((id) => done.has(id) || skip(id))) return false;
        finish();
        return true;
      }
      const tick = () => {
        timer = null;
        if (!check()) timer = setTimer(tick, pollMs);
      };
      if (signal?.aborted) {
        resolve();
        return;
      }
      listeners.add(check);
      signal?.addEventListener?.('abort', finish, { once: true });
      if (!check()) timer = setTimer(tick, pollMs);
    });
  }

  return { all: only(sourceIds), only, untilSettledExcept };
}

/** Plain-language failure text an adapter marked as fit to show as-is. */
export function sourceNoticeFromError(err) {
  const text = typeof err?.userMessage === 'string' ? err.userMessage.trim() : '';
  return text.slice(0, 400);
}

export function recordSourceSuccess(progress, page, loadedCount) {
  progress.cursor = page.cursor ?? progress.cursor;
  progress.loaded = Math.max(0, Number(loadedCount || 0));
  progress.exhausted = page.exhausted === true;
  progress.failures = 0;
  progress.retryAt = 0;
  progress.error = '';
  progress.notice = '';
  progress.rateLimited = false;
  progress.stopped = false;
  return progress;
}

export function recordSourceFailure(progress, err, now = Date.now()) {
  if (isClientRefusal(err)) {
    // The provider refused this page (for example a page past the end of
    // what its index serves): the listing ends here for this session, and
    // the page is never asked for again automatically.
    progress.failures += 1;
    progress.exhausted = true;
    progress.cursor = null;
    progress.stopped = true;
    progress.retryAt = 0;
    progress.error = '';
    progress.notice = sourceNoticeFromError(err);
    progress.rateLimited = false;
    return 0;
  }
  progress.failures += 1;
  const declared = declaredWaitMs(err);
  const rateLimited = Number(err?.status) === 429 || Number.isFinite(declared);
  // Failures are never exhaustion. Keep the cursor intact and retry the same
  // page after the cooldown. A source that did not declare a wait gets
  // AUTO_RETRY_LIMIT quick tries of the same page; after that it is asked
  // again only slowly, so a failing source never turns into a request loop
  // and never stays silent for the rest of the session either.
  const slow = !rateLimited && progress.failures >= AUTO_RETRY_LIMIT;
  const delay = Number.isFinite(declared) && declared >= 0
    ? Math.min(RETRY_AFTER_MAX_MS, declared)
    : slow
      ? slowRetryDelayMs(progress.failures)
      : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (progress.failures - 1)));
  progress.retryAt = now + delay;
  progress.error = String(err?.message || err || 'Unknown source error');
  progress.notice = sourceNoticeFromError(err);
  progress.rateLimited = rateLimited;
  progress.exhausted = false;
  progress.stopped = false;
  return delay;
}
