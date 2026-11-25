import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavoriteTitleScheduler } from '../src/modes/library/favorite-title-scheduler.js';

const MINUTE = 60_000;
const URL = 'https://station.example/live';
const targets = (...ids) => new Map(ids.map((id) => [id, URL]));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function setup() {
  let time = 0;
  let handle = 0;
  const timers = new Map();
  const calls = [];
  const scheduler = createFavoriteTitleScheduler({
    now: () => time,
    setTimer: (fn, delay) => {
      timers.set(++handle, { fn, due: time + delay });
      return handle;
    },
    clearTimer: (id) => timers.delete(id),
    request: (id, url, signal) => new Promise((resolve, reject) => {
      calls.push({ id, url, signal, resolve, reject });
    }),
  });
  function advance(ms) {
    time += ms;
    for (const [id, timer] of timers) {
      if (timer.due > time) continue;
      timers.delete(id);
      timer.fn();
    }
  }
  return { scheduler, calls, advance, timers, ids: () => calls.map(({ id }) => id) };
}

test('favorite titles start with visible cards and run at most four at once', async () => {
  const { scheduler, calls, ids } = setup();
  scheduler.setVisible(targets('in-view'));
  assert.deepEqual(ids(), []);
  scheduler.setActive(true);
  scheduler.setVisible(targets('in-view', 'second', 'third', 'fourth', 'fifth'));
  assert.deepEqual(ids(), ['in-view', 'second', 'third', 'fourth']);
  scheduler.setVisible(targets('fourth', 'fifth', 'just-scrolled-in'));
  assert.deepEqual(calls.map(({ signal }) => signal.aborted), [true, true, true, false]);
  calls[1].resolve({ title: 'Second song' });
  await flush();
  assert.deepEqual(ids(), ['in-view', 'second', 'third', 'fourth', 'fifth']);
  assert.equal(scheduler.titleFor('second', URL), '');
  calls[2].resolve({ title: 'Third song' });
  await flush();
  assert.equal(ids().at(-1), 'just-scrolled-in');
  scheduler.setActive(false);
});

test('favorite titles refresh after three minutes and failures and silence wait ten', async () => {
  const { scheduler, calls, ids, advance } = setup();
  scheduler.setActive(true);
  scheduler.setVisible(targets('ok', 'silent', 'failed'));
  calls[0].resolve({ title: 'The song' });
  calls[1].resolve({ title: null });
  calls[2].reject(new Error('Network failure'));
  await flush();
  assert.equal(scheduler.titleFor('ok', URL), 'The song');
  assert.equal(scheduler.titleFor('silent', URL), '');
  assert.equal(scheduler.titleFor('failed', URL), '');
  advance(3 * MINUTE - 1);
  assert.equal(calls.length, 3);
  advance(1);
  assert.deepEqual(ids(), ['ok', 'silent', 'failed', 'ok']);
  advance(7 * MINUTE - 1);
  assert.equal(calls.length, 4);
  advance(1);
  assert.deepEqual(ids(), ['ok', 'silent', 'failed', 'ok', 'silent', 'failed']);
  scheduler.setActive(false);
});

test('stopping favorite titles aborts requests, clears timers, and ignores late results', async () => {
  const { scheduler, calls, ids, advance, timers } = setup();
  scheduler.setActive(true);
  scheduler.setVisible(targets('active', 'cached'));
  calls[1].resolve({ title: 'Cached song' });
  await flush();
  assert.equal(timers.size, 1);
  scheduler.setActive(false);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(timers.size, 0);
  calls[0].resolve({ title: 'Late result' });
  await flush();
  assert.equal(scheduler.titleFor('active', URL), '');
  scheduler.setVisible(targets('active', 'cached', 'new'));
  advance(20 * MINUTE);
  assert.deepEqual(ids(), ['active', 'cached']);
  scheduler.setActive(true);
  assert.deepEqual(ids(), ['active', 'cached', 'active', 'cached', 'new']);
  scheduler.setActive(false);
});

test('an address edit drops the cached title and aborts a peek for the previous address', async () => {
  const { scheduler, calls } = setup();
  scheduler.setActive(true);
  scheduler.setVisible(targets('station'));
  calls[0].resolve({ title: 'First song' });
  await flush();
  assert.equal(scheduler.titleFor('station', URL), 'First song');

  const second = 'https://station.example/second';
  scheduler.setVisible(new Map([['station', second]]));
  assert.equal(scheduler.titleFor('station', URL), '');
  assert.equal(calls[1].url, second);

  scheduler.setVisible(targets('station'));
  assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve({ title: 'Wrong song' });
  await flush();
  assert.equal(calls[2].url, URL);
  assert.equal(scheduler.titleFor('station', URL), '');
  calls[2].resolve({ title: 'New song' });
  await flush();
  assert.equal(scheduler.titleFor('station', URL), 'New song');
  scheduler.setActive(false);
});
