import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SYNC_RETRY_MS, PROFILE_REQUEST_TIMEOUT_MS, cancelScheduledProfileHandoff, clearProfileHandoff, flushProfileHandoff,
  saveProfileHandoff, scheduleProfileHandoff, suspendProfileRetries,
} from '../src/lib/profile-transfer.js';
import { runBackup } from '../src/lib/backup.js';
import { clearPersistenceFailure, getPersistenceWarnings } from '../src/lib/persistence-notice.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { clearCache } from '../src/lib/state.js';
import { CLEAR_CACHE_FAILED, bindClearCache } from '../src/lib/settings.js';
import { FakeElement } from './helpers/fake-dom.js';

const KEY = 'worldmedia.favorites.v1';
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** A native profile copy whose requests finish only when the test says so. */
function fakeServer() {
  const server = {
    saved: undefined,
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
    requestImpl(path, options) {
      server.inFlight += 1;
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      const values = options.body.values;
      return new Promise((resolve, reject) => {
        server.requests.push({
          values,
          signal: options.signal,
          finish() { server.inFlight -= 1; server.saved = values; resolve({ saved: true }); },
          fail(message = 'Disk full') { server.inFlight -= 1; reject(new Error(message)); },
        });
      });
    },
    pending() { return server.requests.filter((request) => !request.done); },
    async finishNext() {
      const request = server.pending()[0];
      request.done = true;
      request.finish();
      await drain();
      return request;
    },
  };
  return server;
}

function memoryStorage(initial) {
  const values = new Map([[KEY, initial]]);
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    set(value) { values.set(KEY, value); },
  };
}

function setup(t) {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:' };
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    cancelScheduledProfileHandoff();
    mock.timers.reset();
    globalThis.location = previousLocation;
    clearPersistenceFailure('profile-backup');
  });
  const server = fakeServer();
  const storage = memoryStorage('v0');
  return { server, storage, options: { storage, requestImpl: server.requestImpl } };
}

test('overlapping saves run one at a time and cannot finish out of order', async (t) => {
  const { server, storage, options } = setup(t);
  const first = saveProfileHandoff(options);
  storage.set('v1');
  const second = saveProfileHandoff(options);
  storage.set('v2');
  const third = saveProfileHandoff(options);
  await drain();
  assert.equal(server.requests.length, 1, 'later saves wait for the one in flight');
  assert.equal(server.requests[0].values[KEY], 'v0');

  await server.finishNext();
  assert.equal((await first).values[KEY], 'v0');
  assert.equal(server.requests.length, 2, 'the two waiting saves share one write');
  assert.equal(server.requests[1].values[KEY], 'v2', 'it sends the values current when it starts');
  await server.finishNext();
  assert.equal((await second).values[KEY], 'v2');
  assert.equal((await third).values[KEY], 'v2');
  assert.equal(server.saved[KEY], 'v2');
  assert.equal(server.maxInFlight, 1);
});

test('a flush waits for a save already being sent, then writes the newest values', async (t) => {
  const { server, storage, options } = setup(t);
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  assert.equal(server.requests.length, 1);

  let flushed = false;
  const flushing = flushProfileHandoff(options).then((result) => { flushed = true; return result; });
  storage.set('changed while the old save was being sent');
  await drain();
  assert.equal(server.requests.length, 1, 'the flush does not overlap the save in flight');
  await server.finishNext();
  assert.equal(flushed, false, 'the earlier save does not satisfy the flush');
  assert.equal(server.requests[1].values[KEY], 'changed while the old save was being sent');
  await server.finishNext();
  assert.equal((await flushing).values[KEY], 'changed while the old save was being sent');
  assert.equal(server.saved[KEY], 'changed while the old save was being sent');
  assert.equal(server.maxInFlight, 1);
});

test('a change made during a flush is saved by a following write', async (t) => {
  const { server, storage, options } = setup(t);
  scheduleProfileHandoff(options); // A pending debounce is folded into the flush.
  const flushing = flushProfileHandoff(options);
  await drain();
  assert.equal(server.requests.length, 1);
  storage.set('v1');
  scheduleProfileHandoff(options);
  await server.finishNext();
  assert.equal((await flushing).values[KEY], 'v0');
  assert.equal(server.requests.length, 1, 'the ordinary 350 ms debounce still applies');
  mock.timers.tick(349);
  await drain();
  assert.equal(server.requests.length, 1);
  mock.timers.tick(1);
  await drain();
  assert.equal(server.requests.length, 2);
  await server.finishNext();
  assert.equal(server.saved[KEY], 'v1');
  assert.equal(server.maxInFlight, 1);
});

test('a flush rejects when its write fails, and the background retry and notice remain', async (t) => {
  const { server, options } = setup(t);
  const flushing = flushProfileHandoff(options);
  await drain();
  server.requests[0].done = true;
  server.requests[0].fail('Disk full');
  await assert.rejects(flushing, /Disk full/);
  // The retry is the ordinary automatic save; here it cannot read storage, so
  // it reports the usual persistence notice, exactly like any failed save.
  assert.equal(getPersistenceWarnings().length, 0);
  mock.timers.tick(350);
  await drain();
  assert.equal(getPersistenceWarnings().length, 0, 'the first automatic failure is retried quietly');
  mock.timers.tick(AUTO_SYNC_RETRY_MS);
  await drain();
  assert.match(getPersistenceWarnings().join(' '), /portable profile backup could not be updated/);
});

test('a first automatic save that times out is retried once quietly; the notice comes only if that fails too', async (t) => {
  assert.equal(AUTO_SYNC_RETRY_MS, 5_000);
  {
    const { server, options } = setup(t);
    scheduleProfileHandoff(options);
    mock.timers.tick(350);
    await drain();
    mock.timers.tick(PROFILE_REQUEST_TIMEOUT_MS);
    await drain();
    server.requests[0].done = true;
    assert.equal(server.requests[0].signal.aborted, true);
    assert.equal(getPersistenceWarnings().length, 0, 'no notice after the first timeout');
    mock.timers.tick(AUTO_SYNC_RETRY_MS - 1);
    await drain();
    assert.equal(server.requests.length, 1);
    mock.timers.tick(1);
    await drain();
    assert.equal(server.requests.length, 2, 'one quiet retry');
    await server.finishNext();
    assert.equal(getPersistenceWarnings().length, 0, 'it worked: no notice at all');
    mock.timers.tick(AUTO_SYNC_RETRY_MS * 4);
    await drain();
    assert.equal(server.requests.length, 2, 'no further retries');
  }
});

test('an automatic save that fails after Clear cache cancelled the timers schedules no retry', async (t) => {
  const { server, options } = setup(t);
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  assert.equal(server.requests.length, 1, 'the automatic save is being sent');
  cancelScheduledProfileHandoff(); // Clear cache (state.js clearCache)
  server.requests[0].done = true;
  server.requests[0].fail('Disk full');
  await drain();
  mock.timers.tick(AUTO_SYNC_RETRY_MS * 4);
  await drain();
  assert.equal(server.requests.length, 1, 'no retry was scheduled');
  assert.equal(getPersistenceWarnings().length, 0);
});

test('no retry is scheduled while a port change or a backup writes the profile, nor after it', async (t) => {
  const { server, options } = setup(t);
  // A port change: suspended at its start, while an automatic save is out.
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  const resume = suspendProfileRetries();
  server.requests[0].done = true;
  server.requests[0].fail('Disk full');
  await drain();
  mock.timers.tick(AUTO_SYNC_RETRY_MS * 2);
  await drain();
  assert.equal(server.requests.length, 1, 'nothing retried during the port change');
  resume();
  resume(); // a second call changes nothing
  mock.timers.tick(AUTO_SYNC_RETRY_MS * 2);
  await drain();
  assert.equal(server.requests.length, 1, 'and nothing was left scheduled for after it');

  // A backup: an automatic save out when it starts fails during it.
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  assert.equal(server.requests.length, 2);
  let created = 0;
  const backup = runBackup({ flush: async () => ({ saved: true }), create: async () => { created += 1; return {}; } });
  server.requests[1].done = true;
  server.requests[1].fail('Disk full');
  await backup;
  assert.equal(created, 1);
  mock.timers.tick(AUTO_SYNC_RETRY_MS * 2);
  await drain();
  assert.equal(server.requests.length, 2, 'no retry from the save that failed during the backup');
});

test('when the quiet retry of an automatic save also fails, the notice is shown, and nothing more is tried', async (t) => {
  {
    const { server, options } = setup(t);
    scheduleProfileHandoff(options);
    mock.timers.tick(350);
    await drain();
    server.requests[0].done = true;
    server.requests[0].fail('Disk full');
    await drain();
    assert.equal(getPersistenceWarnings().length, 0);
    mock.timers.tick(AUTO_SYNC_RETRY_MS);
    await drain();
    assert.equal(server.requests.length, 2);
    server.requests[1].done = true;
    server.requests[1].fail('Disk full');
    await drain();
    assert.match(getPersistenceWarnings().join(' '), /portable profile backup could not be updated/);
    mock.timers.tick(AUTO_SYNC_RETRY_MS * 4);
    await drain();
    assert.equal(server.requests.length, 2, 'retried once only');
  }
});

test('no write is lost when many changes arrive quickly', async (t) => {
  const { server, storage, options } = setup(t);
  for (let index = 1; index <= 200; index += 1) {
    storage.set(`v${index}`);
    scheduleProfileHandoff(options);
    if (index % 7 === 0) mock.timers.tick(350);
    if (index % 11 === 0) void saveProfileHandoff(options);
    await drain();
    if (index % 5 === 0 && server.pending().length) await server.finishNext();
  }
  mock.timers.tick(350);
  await drain();
  while (server.pending().length) await server.finishNext();
  assert.equal(server.saved[KEY], 'v200');
  assert.equal(server.maxInFlight, 1);
  assert.ok(server.requests.length < 200, `coalesced into ${server.requests.length} writes`);
});

test('clearing the native copy also waits its turn, so an older save cannot land after it', async (t) => {
  const { server, options } = setup(t);
  const saving = saveProfileHandoff(options);
  const clearing = clearProfileHandoff({ requestImpl: server.requestImpl });
  await drain();
  assert.equal(server.requests.length, 1);
  await server.finishNext();
  await saving;
  assert.deepEqual(server.requests[1].values, {});
  await server.finishNext();
  assert.equal(await clearing, true);
  assert.deepEqual(server.saved, {});
  assert.equal(server.maxInFlight, 1);
});

test('a flush waiting behind a save is rejected, never resolved, when Clear cache replaces it', async (t) => {
  const { server, storage, options } = setup(t);
  const inFlight = saveProfileHandoff(options);
  const flushing = flushProfileHandoff(options);
  let flushSettled = false;
  flushing.then(() => { flushSettled = true; }, () => { flushSettled = true; });
  // An automatic save is also waiting; being replaced is not a failure to report.
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  storage.set('cleared');
  const clearing = clearProfileHandoff({ requestImpl: server.requestImpl });
  await assert.rejects(flushing, (error) => error.code === 'PROFILE_SAVE_SUPERSEDED'
    && /cleared before it could be saved/.test(error.message));
  assert.equal(flushSettled, true);
  await server.finishNext();
  await inFlight;
  assert.deepEqual(server.requests.map((request) => request.values), [{ [KEY]: 'v0' }, {}],
    'the replaced saves are never sent');
  await server.finishNext();
  assert.equal(await clearing, true);
  assert.deepEqual(server.saved, {});
  assert.equal(getPersistenceWarnings().length, 0);
  assert.equal(server.requests.length, 2, 'a replaced flush does not queue a retry either');

  // A flush asked for after the clear gets a real save that starts after it.
  storage.set('after clear');
  const later = flushProfileHandoff(options);
  await drain();
  await server.finishNext();
  assert.equal((await later).values[KEY], 'after clear');
  assert.equal(server.saved[KEY], 'after clear');
});

test('a save only ever settles a save: a clear queued after a flush does not satisfy it', async (t) => {
  const { server, options } = setup(t);
  const flushing = flushProfileHandoff(options); // Starts at once: nothing in flight.
  const clearing = clearProfileHandoff({ requestImpl: server.requestImpl });
  await drain();
  assert.deepEqual(server.requests[0].values, { [KEY]: 'v0' });
  await server.finishNext();
  assert.deepEqual((await flushing).values, { [KEY]: 'v0' });
  await server.finishNext();
  assert.equal(await clearing, true);
});

test('a stalled request times out, the queue moves on, and a flush always settles', async (t) => {
  const { server, options } = setup(t);
  scheduleProfileHandoff(options);
  mock.timers.tick(350);
  await drain();
  assert.equal(server.requests.length, 1);
  const flushing = flushProfileHandoff(options);
  let flushError = null;
  flushing.catch((error) => { flushError = error; });
  mock.timers.tick(PROFILE_REQUEST_TIMEOUT_MS - 1);
  await drain();
  assert.equal(server.requests.length, 1, 'still waiting just before the timeout');
  mock.timers.tick(1);
  await drain();
  assert.equal(server.requests[0].signal.aborted, true, 'the stalled request is aborted');
  assert.equal(getPersistenceWarnings().length, 0, 'the flush started after it: the flush decides');
  assert.equal(server.requests.length, 2, 'the flush write starts once the stalled one gives up');
  assert.equal(flushError, null);
  mock.timers.tick(PROFILE_REQUEST_TIMEOUT_MS);
  await drain();
  assert.equal(flushError?.code, 'PROFILE_WRITE_TIMEOUT');
  assert.equal(server.requests[1].signal.aborted, true);
  server.requests[0].done = true; // The two that timed out.
  server.requests[1].done = true;
  // The automatic save that timed out while the flush waited schedules no
  // retry of its own (the flush was asked after it).
  assert.equal(server.requests.length, 2);
  // The failed flush re-armed the ordinary save; the queue is free again.
  cancelScheduledProfileHandoff();
  const after = saveProfileHandoff(options);
  await drain();
  assert.equal(server.requests.length, 3);
  await server.finishNext();
  assert.equal((await after).saved, true);
});

test('a clear that stalls also times out, so Clear cache can report the failure', async (t) => {
  const { server } = setup(t);
  const clearing = clearProfileHandoff({ requestImpl: server.requestImpl });
  let clearError = null;
  clearing.catch((error) => { clearError = error; });
  await drain();
  mock.timers.tick(PROFILE_REQUEST_TIMEOUT_MS);
  await drain();
  assert.equal(clearError?.code, 'PROFILE_WRITE_TIMEOUT');
  for (const request of server.requests) request.done = true;
});

test('clearCache returns a promise that settles only when the native clear is acknowledged', async (t) => {
  setup(t);
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  let answer = 'fail';
  const bodies = [];
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 't' } }) };
    }
    bodies.push(options.body);
    if (answer === 'fail') {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'DISK', message: 'Disk full' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { saved: true } }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousStorage;
    resetControlSession();
  });
  resetControlSession();
  await assert.rejects(clearCache(), /Disk full/);
  answer = 'ok';
  assert.equal(await clearCache(), true);
  assert.deepEqual(bodies, ['{"values":{}}', '{"values":{}}']);
});

test('Clear cache in Settings waits for the clear before closing, and shows a plain failure', async () => {
  function controls() {
    const button = new FakeElement('clear', 'button');
    button.textContent = 'Clear cache';
    const status = new FakeElement('clear-status', 'p');
    status.hidden = true;
    return { button, status };
  }
  const first = controls();
  let release;
  let done = 0;
  const api = bindClearCache({
    ...first,
    confirmClear: () => true,
    clear: () => new Promise((resolve) => { release = resolve; }),
    onDone: () => { done += 1; },
  });
  const running = api.run();
  await drain();
  assert.equal(first.button.disabled, true);
  assert.equal(first.button.textContent, 'Clearing…');
  assert.equal(done, 0, 'Settings stays open until the clear is acknowledged');
  release(true);
  await running;
  assert.equal(done, 1);

  const second = controls();
  const failing = bindClearCache({
    ...second,
    confirmClear: () => true,
    clear: async () => { throw new Error('Saving your profile took too long and was stopped.'); },
    onDone: () => { done += 1; },
  });
  await failing.run();
  assert.equal(done, 1, 'a failed clear is not reported as done');
  assert.equal(second.status.hidden, false);
  assert.equal(second.status.textContent, CLEAR_CACHE_FAILED);
  assert.equal(second.button.disabled, false);
  assert.equal(second.button.textContent, 'Clear cache');

  const third = controls();
  let cleared = 0;
  await bindClearCache({ ...third, confirmClear: () => false, clear: async () => { cleared += 1; }, onDone() {} }).run();
  assert.equal(cleared, 0, 'nothing happens when the confirmation is declined');
});
