/** Bounded per-provider attempt used by Discovery's globally scheduled race. */

export const DISCOVERY_ATTEMPT_DEADLINE_MS = 5_000;

function abortError(reason = 'Discovery source cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') {
    return new DOMException(String(reason?.message || reason), 'AbortError');
  }
  const error = new Error(String(reason?.message || reason));
  error.name = 'AbortError';
  return error;
}

export async function withDiscoveryAttemptDeadline(parentSignal, operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('Discovery attempt requires an operation');
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DISCOVERY_ATTEMPT_DEADLINE_MS);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const controller = new AbortController();
  const abortAttempt = () => controller.abort(abortError(parentSignal?.reason));
  if (parentSignal?.aborted) abortAttempt();
  else parentSignal?.addEventListener('abort', abortAttempt, { once: true });
  const attemptDeadline = setTimer(() => {
    controller.abort(abortError('Discovery source timed out'));
  }, timeoutMs);
  try {
    const value = await operation(controller.signal);
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    return value;
  } finally {
    clearTimer(attemptDeadline);
    parentSignal?.removeEventListener('abort', abortAttempt);
  }
}
