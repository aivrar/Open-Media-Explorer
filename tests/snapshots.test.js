import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogScheduler } from '../src/lib/catalog-scheduler.js';
import { ensureCatalogStore, mergeCatalogItems } from '../src/modes/library/catalog-store.js';
import { createSnapshotManager } from '../src/modes/library/snapshots.js';

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

function makeStore() {
  return ensureCatalogStore({
    items: [], itemIndex: new Map(), finiteItemIds: new Set(), snapshotIdsBySource: new Map(),
    snapshotState: new Map(), cumulativeCounts: new Map(), cumulativeTypeCounts: new Map(),
    cumulativeSourceTypeCounts: new Map(), sessionCounts: new Map(),
  });
}

function live(id, title = id) {
  return { id: `live:${id}`, source: 'live', type: 'tv', title };
}

test('snapshot refresh adds, updates, removes, goes stale, recovers, and leaves finite ownership intact', async () => {
  const clock = new FakeClock();
  const scheduler = new CatalogScheduler({
    maxConcurrent: 2, defaultSourceConcurrency: 1,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const store = makeStore();
  mergeCatalogItems(store, [{ ...live('finite'), type: 'video' }], { kind: 'finite' });
  const responses = [
    { items: [live('one', 'One'), live('two', 'Two'), { ...live('finite'), type: 'video' }], snapshotId: 's1', refreshAfterMs: 30_000 },
    { items: [live('two', 'Two updated'), live('three', 'Three')], snapshotId: 's2', refreshAfterMs: 30_000 },
    Object.assign(new Error('temporary'), { status: 503 }),
    { items: [live('three', 'Three recovered')], snapshotId: 's3', refreshAfterMs: 30_000 },
  ];
  const states = [];
  const manager = createSnapshotManager({
    scheduler,
    store,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    getPinnedIds: () => new Set(['live:one']),
    loadAdapter: async () => ({
      refreshSnapshot: async () => {
        const result = responses.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    }),
    onState: (_source, state) => states.push(state?.state || 'unsupported'),
  });

  const first = manager.refresh('live');
  assert.equal(manager.refresh('live'), first, 'concurrent refresh callers must share one operation');
  await first;
  assert.equal(manager.state('live').state, 'live');
  assert.equal(manager.timerCount, 1);
  assert.deepEqual([...store.snapshotIdsBySource.get('live')], ['live:one', 'live:two', 'live:finite']);

  await clock.advance(30_000);
  assert.equal(manager.state('live').snapshotId, 's2');
  assert.equal(store.itemIndex.get('live:two').title, 'Two updated');
  assert.equal(store.itemIndex.get('live:one').__snapshotOffline, true);
  assert.ok(store.itemIndex.has('live:finite'), 'finite item survives leaving the live snapshot');

  await clock.advance(30_000);
  assert.equal(manager.state('live').state, 'stale');
  assert.match(manager.state('live').error, /temporary/);
  assert.deepEqual([...store.snapshotIdsBySource.get('live')], ['live:two', 'live:three', 'live:one']);

  await clock.advance(30_000);
  assert.equal(manager.state('live').state, 'live');
  assert.equal(manager.state('live').snapshotId, 's3');
  assert.equal(store.itemIndex.get('live:three').title, 'Three recovered');
  assert.ok(states.includes('stale'));
  manager.destroy();
  scheduler.destroy();
  assert.equal(clock.timers.size, 0);
});

test('an adapter-supplied native LKG is published as stale and retried without discarding verified items', async () => {
  const clock = new FakeClock();
  const scheduler = new CatalogScheduler({
    maxConcurrent: 1,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const store = makeStore();
  const calls = [];
  const manager = createSnapshotManager({
    scheduler,
    store,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    loadAdapter: async () => ({
      refreshSnapshot: async (options) => {
        calls.push(options);
        if (calls.length === 1) {
          return {
            items: [live('native-lkg')],
            snapshotId: 'verified-old',
            refreshAfterMs: 120_000,
            stale: true,
            error: 'SUSPICIOUS_EMPTY_REFRESH',
            retryAfterMs: 30_000,
          };
        }
        return {
          items: [live('recovered')], snapshotId: 'fresh', refreshAfterMs: 120_000,
        };
      },
    }),
  });

  const stale = await manager.refresh('live', { force: true, showExplicitContent: true });
  assert.equal(stale.stale, true);
  assert.equal(manager.state('live').state, 'stale');
  assert.equal(manager.state('live').stale, true);
  assert.equal(manager.state('live').error, 'SUSPICIOUS_EMPTY_REFRESH');
  assert.equal(manager.state('live').retryAt, 30_000);
  assert.equal(store.itemIndex.has('live:native-lkg'), true);
  assert.equal(calls[0].force, true);
  assert.equal(calls[0].showExplicitContent, true);

  await clock.advance(10_000);
  manager.pause();
  assert.equal(manager.timerCount, 0);
  await clock.advance(5_000);
  manager.resume();
  assert.equal(manager.timerCount, 1);
  await clock.advance(14_999);
  assert.equal(manager.state('live').state, 'stale');
  await clock.advance(1);
  assert.equal(manager.state('live').state, 'live');
  assert.equal(calls[1].force, true, 'scheduled stale recovery bypasses the adapter adoption cache');
  assert.equal(manager.state('live').snapshotId, 'fresh');
  assert.equal(store.itemIndex.has('live:recovered'), true);
  assert.equal(store.itemIndex.has('live:native-lkg'), false);
  assert.equal(manager.timerCount, 1);
  manager.destroy();
  scheduler.destroy();
  assert.equal(clock.timers.size, 0);
});

test('disable cancels an in-flight snapshot and stale completion cannot mutate the store', async () => {
  const scheduler = new CatalogScheduler({ maxConcurrent: 1 });
  const store = makeStore();
  const gate = deferred();
  const manager = createSnapshotManager({
    scheduler,
    store,
    isSourceEnabled: () => true,
    loadAdapter: async () => ({ refreshSnapshot: () => gate.promise }),
  });
  const pending = manager.refresh('live');
  void pending.catch(() => {});
  await flush();
  manager.disableSource('live');
  gate.resolve({ items: [live('late')], snapshotId: 'late', refreshAfterMs: 30_000 });
  await assert.rejects(pending, { name: 'AbortError' });
  await flush();
  assert.equal(store.itemIndex.has('live:late'), false);
  assert.equal(manager.state('live').state, 'disabled');
  assert.deepEqual(scheduler.stats().activeBySource, {});
  manager.destroy();
  scheduler.destroy();
});

test('an adapter without refreshSnapshot is remembered as unsupported and schedules no timer', async () => {
  const scheduler = new CatalogScheduler({ maxConcurrent: 1 });
  const store = makeStore();
  let loads = 0;
  const manager = createSnapshotManager({
    scheduler,
    store,
    loadAdapter: async () => { loads += 1; return {}; },
  });
  assert.deepEqual(await manager.refresh('finite-only'), { supported: false });
  assert.deepEqual(await manager.refresh('finite-only'), { supported: false });
  assert.equal(loads, 1);
  assert.equal(manager.hasDiscovered('finite-only'), true);
  assert.equal(manager.timerCount, 0);
  assert.equal(manager.state('finite-only'), null);
  manager.destroy();
  scheduler.destroy();
});

test('pause and resume preserve the remaining snapshot refresh cadence', async () => {
  const clock = new FakeClock();
  const scheduler = new CatalogScheduler({
    maxConcurrent: 1,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const store = makeStore();
  let calls = 0;
  const manager = createSnapshotManager({
    scheduler,
    store,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    loadAdapter: async () => ({
      refreshSnapshot: async () => {
        calls += 1;
        return { items: [live('cadence')], snapshotId: `s${calls}`, refreshAfterMs: 30_000 };
      },
    }),
  });
  await manager.refresh('live');
  assert.equal(calls, 1);
  assert.equal(manager.hasDiscovered('live'), true);
  manager.pause();
  assert.equal(manager.timerCount, 0);
  await clock.advance(10_000);
  manager.resume();
  assert.equal(calls, 1, 'resume must not refresh before the original due time');
  assert.equal(manager.timerCount, 1);
  await clock.advance(19_999);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  manager.destroy();
  scheduler.destroy();
  assert.equal(clock.timers.size, 0);
});

test('a paused first snapshot attempt is resumed after capability discovery', async () => {
  const scheduler = new CatalogScheduler({ maxConcurrent: 1 });
  const store = makeStore();
  let calls = 0;
  const manager = createSnapshotManager({
    scheduler,
    store,
    loadAdapter: async () => ({
      refreshSnapshot: ({ signal }) => {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve({
            items: [live('resumed')], snapshotId: 'resumed', refreshAfterMs: 30_000,
          });
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }),
  });
  const first = manager.refresh('live');
  void first.catch(() => {});
  await flush();
  assert.equal(calls, 1);
  manager.pause();
  await assert.rejects(first, { name: 'AbortError' });
  manager.resume();
  await manager.refresh('live');
  assert.equal(calls, 2);
  assert.equal(manager.state('live').state, 'live');
  assert.equal(store.itemIndex.has('live:resumed'), true);
  manager.destroy();
  scheduler.destroy();
});
