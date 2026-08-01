/** Pure per-source pagination/retry state used by the library chain. */

export const RETRY_BASE_MS = 1_500;
export const RETRY_MAX_MS = 30_000;
export const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

export function createSourceProgress() {
  return {
    cursor: null,
    loaded: 0,
    exhausted: false,
    failures: 0,
    retryAt: 0,
    error: '',
    inFlight: false,
    rateLimited: false,
  };
}

export function recordSourceSuccess(progress, page, loadedCount) {
  progress.cursor = page.cursor ?? progress.cursor;
  progress.loaded = Math.max(0, Number(loadedCount || 0));
  progress.exhausted = page.exhausted === true;
  progress.failures = 0;
  progress.retryAt = 0;
  progress.error = '';
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
  progress.rateLimited = Number(err?.status) === 429 || Number.isFinite(declared);
  // Failures are never exhaustion. Keep the cursor intact and retry the same
  // page after the cooldown.
  progress.exhausted = false;
  return delay;
}
