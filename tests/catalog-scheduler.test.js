import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogScheduler, CATALOG_PRIORITY,
  DEFAULT_CATALOG_CONCURRENCY, DEFAULT_SOURCE_CONCURRENCY,
} from '../src/lib/catalog-scheduler.js';

const flush = async () => {
  // Scheduler completion crosses the task promise, finally cleanup, slot
  // release, queued drain, and next task invocation microtasks.
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, Number(delay) || 0), callback });
    return id;
  };

  clearTimer = (id) => this.timers.delete(id);

  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
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

function makeScheduler(options = {}) {
  const clock = options.clock || new FakeClock();
  const scheduler = new CatalogScheduler({
    maxConcurrent: options.maxConcurrent ?? 4,
    defaultSourceConcurrency: options.defaultSourceConcurrency ?? 2,
    maxQueue: options.maxQueue ?? 64,
    visible: options.visible,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    taskTimeoutMs: options.taskTimeoutMs,
  });
  return { scheduler, clock };
}

function blockingTask(sourceId, gates, events, active, maxima) {
  return async ({ signal, key }) => {
    active.total += 1;
    active.bySource[sourceId] = (active.bySource[sourceId] || 0) + 1;
    maxima.total = Math.max(maxima.total, active.total);
    maxima.bySource[sourceId] = Math.max(maxima.bySource[sourceId] || 0, active.bySource[sourceId]);
    events.push(`start:${sourceId}:${key}`);
    try {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        gates.get(key).promise.then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
      });
      return key;
    } finally {
      active.total -= 1;
      active.bySource[sourceId] -= 1;
      events.push(`end:${sourceId}:${key}`);
    }
  };
}

test('production defaults let all eleven sources start independently', async () => {
  assert.equal(DEFAULT_CATALOG_CONCURRENCY, 11);
  assert.equal(DEFAULT_SOURCE_CONCURRENCY, 1);
  const scheduler = new CatalogScheduler();
  const sources = Array.from({ length: 11 }, (_, index) => `source-${index}`);
  const gates = new Map(sources.map((sourceId) => [sourceId, deferred()]));
  const starts = [];
  const jobs = sources.map((sourceId) => scheduler.enqueue({
    sourceId,
    key: 'page-0',
    task: async () => {
      starts.push(sourceId);
      await gates.get(sourceId).promise;
      return sourceId;
    },
  }));

  await flush();
  assert.equal(scheduler.stats().active, 11);
  assert.equal(new Set(starts).size, 11);
  assert.ok(Object.values(scheduler.stats().activeBySource).every((count) => count === 1));

  for (const gate of gates.values()) gate.resolve();
  assert.deepEqual(await Promise.all(jobs), sources);
  scheduler.destroy();
});

test('catalog concurrency is globally bounded, per-source bounded, and deduplicated', async () => {
  const { scheduler } = makeScheduler();
  const gates = new Map();
  const events = [];
  const active = { total: 0, bySource: {} };
  const maxima = { total: 0, bySource: {} };
  const jobs = [];
  for (const sourceId of ['a', 'b', 'c']) {
    for (let index = 0; index < 3; index++) {
      const key = `${sourceId}-${index}`;
      gates.set(key, deferred());
      jobs.push(scheduler.enqueue({
        sourceId, key,
        task: blockingTask(sourceId, gates, events, active, maxima),
      }));
    }
  }
  const duplicate = scheduler.enqueue({ sourceId: 'a', key: 'a-0', task: () => 'wrong' });
  assert.equal(duplicate, jobs[0]);
  await flush();
  assert.equal(scheduler.stats().active, 4);
  assert.equal(maxima.total, 4);
  assert.ok(Object.values(maxima.bySource).every((count) => count <= 2));

  for (const gate of gates.values()) {
    gate.resolve();
    await flush();
  }
  assert.deepEqual(await Promise.all(jobs), [...gates.keys()]);
  assert.deepEqual(scheduler.stats(), {
    active: 0, pending: 0, visible: true, activeBySource: {},
  });
  scheduler.destroy();
});

test('round-robin fairness skips a blocked source and user work preempts queued prefetch', async () => {
  const { scheduler } = makeScheduler({ maxConcurrent: 2, defaultSourceConcurrency: 1 });
  const gates = new Map([['a1', deferred()], ['a2', deferred()], ['b1', deferred()], ['c1', deferred()]]);
  const events = [];
  const active = { total: 0, bySource: {} };
  const maxima = { total: 0, bySource: {} };
  const task = (source) => blockingTask(source, gates, events, active, maxima);
  const promises = [
    scheduler.enqueue({ sourceId: 'a', key: 'a1', task: task('a') }),
    scheduler.enqueue({ sourceId: 'a', key: 'a2', task: task('a'), priority: CATALOG_PRIORITY.PREFETCH }),
    scheduler.enqueue({ sourceId: 'b', key: 'b1', task: task('b') }),
    scheduler.enqueue({ sourceId: 'c', key: 'c1', task: task('c'), priority: CATALOG_PRIORITY.USER }),
  ];
  await flush();
  assert.deepEqual(events.filter((event) => event.startsWith('start:')), ['start:c:c1', 'start:a:a1']);
  gates.get('c1').resolve();
  await flush();
  assert.equal(events.filter((event) => event.startsWith('start:'))[2], 'start:b:b1');
  gates.get('b1').resolve();
  await flush();
  assert.equal(events.filter((event) => event.startsWith('start:')).length, 3,
    'a2 must respect the one-active-per-source policy while a1 is slow');
  gates.get('a1').resolve();
  await flush();
  assert.equal(events.filter((event) => event.startsWith('start:'))[3], 'start:a:a2');
  gates.get('a2').resolve();
  await Promise.all(promises);
  scheduler.destroy();
});

test('Retry-After cooldown and source minimum interval use fake time without occupying a slot', async () => {
  const { scheduler, clock } = makeScheduler({ maxConcurrent: 1, defaultSourceConcurrency: 1 });
  scheduler.setPolicy('limited', { maxConcurrent: 1, minIntervalMs: 1_000 });
  const starts = [];
  const first = scheduler.enqueue({
    sourceId: 'limited', key: 'first',
    task: async () => {
      starts.push(clock.now());
      const error = new Error('rate limited');
      error.status = 429;
      error.retryAfterMs = 5_000;
      throw error;
    },
  });
  void first.catch(() => {});
  const second = scheduler.enqueue({
    sourceId: 'limited', key: 'second', task: async () => { starts.push(clock.now()); return 'ok'; },
  });
  await flush();
  await assert.rejects(first, (error) => error.status === 429);
  assert.deepEqual(starts, [0]);
  assert.equal(scheduler.stats().active, 0);
  await clock.advance(4_999);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  assert.deepEqual(starts, [0, 5_000]);
  assert.equal(await second, 'ok');
  assert.equal(clock.timers.size, 0);
  scheduler.destroy();
});

test('a hung adapter hits the final watchdog, releases its lane, and retries later', async () => {
  const { scheduler, clock } = makeScheduler({
    maxConcurrent: 1,
    defaultSourceConcurrency: 1,
    taskTimeoutMs: 50,
  });
  const starts = [];
  const hung = scheduler.enqueue({
    sourceId: 'hung',
    key: 'stuck-page',
    task: async () => {
      starts.push('hung');
      return new Promise(() => {});
    },
  });
  void hung.catch(() => {});
  const recovered = scheduler.enqueue({
    sourceId: 'hung',
    key: 'next-page',
    task: async () => {
      starts.push('recovered');
      return 'ok';
    },
  });
  await flush();
  await clock.advance(50);
  await assert.rejects(hung, (error) => (
    error.name === 'CatalogTaskTimeoutError' && error.status === 408
  ));
  assert.deepEqual(starts, ['hung']);
  assert.equal(scheduler.stats().active, 0);
  await clock.advance(1_499);
  assert.deepEqual(starts, ['hung']);
  await clock.advance(1);
  assert.equal(await recovered, 'ok');
  assert.deepEqual(starts, ['hung', 'recovered']);
  assert.equal(clock.timers.size, 0);
  scheduler.destroy();
});

test('queued, active, and disabled-source cancellation releases promises, slots, and timers', async () => {
  const { scheduler, clock } = makeScheduler({ maxConcurrent: 1, defaultSourceConcurrency: 1 });
  const activeGate = deferred();
  const active = scheduler.enqueue({
    sourceId: 'a', key: 'active',
    task: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      activeGate.promise.then(resolve, reject);
    }),
  });
  const queuedController = new AbortController();
  const queued = scheduler.enqueue({
    sourceId: 'b', key: 'queued', signal: queuedController.signal, task: async () => 'must-not-run',
  });
  void active.catch(() => {});
  void queued.catch(() => {});
  await flush();
  queuedController.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  scheduler.setSourceEnabled('a', false);
  await assert.rejects(active, { name: 'AbortError' });
  await flush();
  assert.equal(scheduler.stats().active, 0);
  assert.equal(scheduler.stats().pending, 0);
  assert.equal(clock.timers.size, 0);
  await assert.rejects(
    scheduler.enqueue({ sourceId: 'a', key: 'disabled', task: async () => null }),
    { name: 'AbortError' },
  );
  scheduler.destroy();
});

test('hidden visibility pauses only prefetch and resumes it without duplicate work', async () => {
  const { scheduler } = makeScheduler({ maxConcurrent: 1, visible: false });
  const events = [];
  const low = scheduler.enqueue({
    sourceId: 'low', key: 'prefetch', priority: CATALOG_PRIORITY.PREFETCH,
    task: async () => { events.push('low'); return 'low'; },
  });
  const high = scheduler.enqueue({
    sourceId: 'high', key: 'search', priority: CATALOG_PRIORITY.SEARCH,
    task: async () => { events.push('high'); return 'high'; },
  });
  await flush();
  assert.deepEqual(events, ['high']);
  assert.equal(await high, 'high');
  assert.equal(scheduler.stats().pending, 1);
  scheduler.setVisible(true);
  await flush();
  assert.equal(await low, 'low');
  assert.deepEqual(events, ['high', 'low']);
  scheduler.destroy();
});

test('active playback throttles background catalog work and restores normal concurrency', async () => {
  const { scheduler } = makeScheduler({ maxConcurrent: 4, defaultSourceConcurrency: 1 });
  const userGate = deferred();
  const backgroundGate = deferred();
  const starts = [];
  const run = (sourceId, priority, gate) => scheduler.enqueue({
    sourceId, key: sourceId, priority,
    task: async () => { starts.push(sourceId); await gate.promise; return sourceId; },
  });

  scheduler.setPlaybackPriority(true);
  const jobs = [
    run('user-1', CATALOG_PRIORITY.USER, userGate),
    run('user-2', CATALOG_PRIORITY.USER, userGate),
    run('background-1', CATALOG_PRIORITY.PREFETCH, backgroundGate),
    run('background-2', CATALOG_PRIORITY.PREFETCH, backgroundGate),
    run('background-3', CATALOG_PRIORITY.PREFETCH, backgroundGate),
  ];
  await flush();
  assert.deepEqual(starts, ['user-1', 'user-2']);
  assert.equal(scheduler.stats().active, 2);

  userGate.resolve();
  await flush();
  assert.equal(starts.filter((name) => name.startsWith('background')).length, 1,
    'only one background source runs while playback owns priority');

  scheduler.setPlaybackPriority(false);
  await flush();
  assert.equal(starts.filter((name) => name.startsWith('background')).length, 3,
    'queued sources immediately regain ordinary shared concurrency');
  backgroundGate.resolve();
  await Promise.all(jobs);
  scheduler.destroy();
});

test('round-robin source membership stays unique across repeated queue lifecycles', async () => {
  const { scheduler } = makeScheduler({ maxConcurrent: 1, defaultSourceConcurrency: 1 });
  for (let index = 0; index < 50; index++) {
    assert.equal(await scheduler.enqueue({
      sourceId: 'repeat', key: `page-${index}`, task: async () => index,
    }), index);
  }
  assert.deepEqual(scheduler.sourceOrder, ['repeat']);
  assert.equal(scheduler.knownSources.size, 1);
  scheduler.destroy();
});

test('eleven-source stress drains thousands of operations without starvation, leaks, or duplicate work', async () => {
  const { scheduler, clock } = makeScheduler({
    maxConcurrent: 4,
    defaultSourceConcurrency: 1,
    maxQueue: 2_500,
  });
  const sources = Array.from({ length: 11 }, (_, index) => `source-${index}`);
  const starts = [];
  const runs = new Map();
  const active = { total: 0, bySource: new Map(), maximum: 0 };
  const promises = [];

  for (let index = 0; index < 2_200; index++) {
    const sourceId = sources[index % sources.length];
    const key = `operation-${index}`;
    const promise = scheduler.enqueue({
      sourceId,
      key,
      priority: index % 17 === 0 ? CATALOG_PRIORITY.USER : CATALOG_PRIORITY.INITIAL,
      task: async () => {
        starts.push(sourceId);
        runs.set(key, (runs.get(key) || 0) + 1);
        active.total += 1;
        active.bySource.set(sourceId, (active.bySource.get(sourceId) || 0) + 1);
        active.maximum = Math.max(active.maximum, active.total);
        assert.ok(active.total <= 4);
        assert.ok(active.bySource.get(sourceId) <= 1);
        await Promise.resolve();
        active.total -= 1;
        active.bySource.set(sourceId, active.bySource.get(sourceId) - 1);
        return index;
      },
    });
    promises.push(promise);
    if (index % 100 === 0) {
      assert.equal(scheduler.enqueue({ sourceId, key, task: async () => -1 }), promise);
    }
  }

  const values = await Promise.all(promises);
  assert.equal(values.length, 2_200);
  assert.equal(runs.size, 2_200);
  assert.ok([...runs.values()].every((count) => count === 1));
  assert.equal(new Set(starts.slice(0, 44)).size, 11,
    'all eleven sources must receive work near the front of a mixed-priority run');
  assert.equal(active.maximum, 4);
  assert.deepEqual(scheduler.stats(), {
    active: 0, pending: 0, visible: true, activeBySource: {},
  });
  assert.equal(scheduler.jobsByKey.size, 0);
  assert.equal(scheduler.activeJobs.size, 0);
  assert.equal(scheduler.knownSources.size, 11);
  assert.equal(clock.timers.size, 0);
  scheduler.destroy();
});

test('simultaneous provider faults remain isolated while user and healthy source work completes', async () => {
  const { scheduler, clock } = makeScheduler({
    maxConcurrent: 4,
    defaultSourceConcurrency: 1,
  });
  const slowLoc = deferred();
  const starts = [];
  const run = (sourceId, outcome, priority = CATALOG_PRIORITY.INITIAL) => scheduler.enqueue({
    sourceId,
    key: `fault-${sourceId}`,
    priority,
    task: async () => {
      starts.push(sourceId);
      if (sourceId === 'library-of-congress') await slowLoc.promise;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  const retryable = (message, status, retryAfterMs = undefined) => {
    const error = new Error(message);
    error.status = status;
    if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
    return error;
  };

  const jobs = [
    run('library-of-congress', retryable('LOC cooldown', 429, 3_600_000)),
    run('gpodder', retryable('dead feed', 503)),
    run('peertube', retryable('broken origin', 502)),
    run('owncast', retryable('safety metadata invalid', 400)),
    run('media-ccc', []),
    run('internet-archive', retryable('old source retry', 500)),
    run('radio-browser', 'healthy radio', CATALOG_PRIORITY.USER),
    run('iptv-org', 'healthy television'),
    run('nasa', 'healthy nasa'),
    run('wikimedia', 'healthy wikimedia'),
    run('librivox', 'healthy librivox'),
  ];
  jobs.forEach((job) => void job.catch(() => {}));
  await flush();
  assert.ok(starts.includes('radio-browser'), 'user work must start despite the slow LOC task');
  slowLoc.resolve();
  const outcomes = await Promise.allSettled(jobs);

  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 6);
  assert.equal(outcomes.filter((entry) => entry.status === 'rejected').length, 5);
  assert.deepEqual(outcomes[4], { status: 'fulfilled', value: [] },
    'an authoritative empty C3VOC snapshot remains a successful empty snapshot');
  assert.equal(scheduler._state('library-of-congress').cooldownUntil, 3_600_000);
  assert.equal(scheduler._state('owncast').cooldownUntil, 0,
    'permanent schema/safety failures must not create a retry storm timer');
  assert.ok(scheduler._state('gpodder').cooldownUntil > 0);
  assert.ok(scheduler._state('peertube').cooldownUntil > 0);
  assert.ok(scheduler._state('internet-archive').cooldownUntil > 0);
  assert.deepEqual(scheduler.stats(), {
    active: 0, pending: 0, visible: true, activeBySource: {},
  });
  assert.equal(clock.timers.size, 0,
    'settled provider cooldown metadata must not leave a wake timer without queued work');
  scheduler.destroy();
});
