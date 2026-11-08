import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_SOURCE_TIMEOUT_MS, mergeSourceItems, pendingSourcesText, sourceDeadline,
} from '../src/lib/live-load.js';

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
    pending,
  };
}

const item = (id, source, type = 'radio') => ({ id, source, type, title: id });

test('each source is merged as it arrives without moving earlier stations', () => {
  let list = mergeSourceItems([], 'radio-browser', [item('a', 'radio-browser'), item('b', 'radio-browser')], 'radio');
  list = mergeSourceItems(list, 'gpodder', [item('p', 'gpodder'), item('b', 'gpodder'), item('t', 'gpodder', 'tv')], 'radio');
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'p'], 'dedupes by id and filters the band');
  // A refresh of one source replaces only that source's items.
  list = mergeSourceItems(list, 'radio-browser', [item('c', 'radio-browser')], 'radio');
  assert.deepEqual(list.map((s) => s.id), ['p', 'c']);
  assert.deepEqual(mergeSourceItems(undefined, 'x', undefined, 'radio'), []);
});

test('a stalled source times out on its own deadline', () => {
  const timers = fakeTimers();
  const parent = new AbortController();
  const deadline = sourceDeadline(parent.signal, 5_000, timers);
  assert.equal(deadline.signal.aborted, false);
  timers.fire();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.timedOut(), true);
  assert.match(String(deadline.signal.reason?.message), /5 seconds/);
  deadline.done();
});

test('leaving the view cancels without being reported as a timeout, and done() clears the timer', () => {
  const timers = fakeTimers();
  const parent = new AbortController();
  const deadline = sourceDeadline(parent.signal, LIVE_SOURCE_TIMEOUT_MS, timers);
  parent.abort();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.timedOut(), false);
  deadline.done();
  assert.equal(timers.pending.size, 0);
  const already = new AbortController();
  already.abort();
  assert.equal(sourceDeadline(already.signal, 1000, timers).signal.aborted, true);
});

test('status text lists only the sources still loading', () => {
  const states = new Map([['a', { state: 'ready' }], ['b', { state: 'loading' }], ['c', { state: 'error' }]]);
  assert.equal(pendingSourcesText(states), ' · loading 1 more source…');
  states.set('c', { state: 'loading' });
  assert.equal(pendingSourcesText(states), ' · loading 2 more sources…');
  assert.equal(pendingSourcesText(new Map()), '');
});
