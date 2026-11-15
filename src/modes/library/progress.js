/** Pure per-source pagination/retry state used by the library chain. */

import { MAX_RETRY_AFTER_MS } from '../../lib/catalog-scheduler.js';

export const RETRY_BASE_MS = 1_500;
export const RETRY_MAX_MS = 30_000;
// A source may declare a hold longer than an hour (up to six hours after a
// block); a declared wait is never shortened below that. Same cap as the
// scheduler's declared cooldown.
export const RETRY_AFTER_MAX_MS = MAX_RETRY_AFTER_MS;

export function createSourceProgress() {
  return {
    cursor: null,
    loaded: 0,
    exhausted: false,
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
  return progress;
}

export function recordSourceFailure(progress, err, now = Date.now()) {
  progress.failures += 1;
  const declared = Number(err?.retryAfterMs);
  const delay = Number.isFinite(declared) && declared >= 0
    ? Math.min(RETRY_AFTER_MAX_MS, declared)
    : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (progress.failures - 1)));
  progress.retryAt = now + delay;
  progress.error = String(err?.message || err || 'Unknown source error');
  progress.notice = sourceNoticeFromError(err);
  progress.rateLimited = Number(err?.status) === 429 || Number.isFinite(declared);
  // Failures are never exhaustion. Keep the cursor intact and retry the same
  // page after the cooldown.
  progress.exhausted = false;
  return delay;
}
