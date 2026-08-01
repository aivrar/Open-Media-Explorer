import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_ATTEMPT_DEADLINE_MS, withDiscoveryAttemptDeadline,
} from '../src/modes/discovery-attempt.js';

test('Discovery provider attempts time out, release their timer, and acknowledge abort', async () => {
  assert.equal(DISCOVERY_ATTEMPT_DEADLINE_MS, 5_000);
  let fire = null;
  let cleared = 0;
  const promise = withDiscoveryAttemptDeadline(null, (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), {
    timeoutMs: 25,
    setTimer(callback) { fire = callback; return 17; },
    clearTimer(handle) { assert.equal(handle, 17); cleared += 1; },
  });
  assert.equal(typeof fire, 'function');
  fire();
  await assert.rejects(promise, (error) => error?.name === 'AbortError');
  assert.equal(cleared, 1);
});

test('Discovery attempts propagate parent cancellation and clear success timers', async () => {
  let cleared = 0;
  const success = await withDiscoveryAttemptDeadline(null, async () => 'match', {
    setTimer() { return 23; },
    clearTimer(handle) { assert.equal(handle, 23); cleared += 1; },
  });
  assert.equal(success, 'match');
  assert.equal(cleared, 1);

  const parent = new AbortController();
  const cancelled = withDiscoveryAttemptDeadline(parent.signal, (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), {
    setTimer() { return 29; },
    clearTimer(handle) { assert.equal(handle, 29); cleared += 1; },
  });
  parent.abort(new DOMException('Mode changed', 'AbortError'));
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError');
  assert.equal(cleared, 2);
});
