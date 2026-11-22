import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLineWatch, QUIET_MS, CHECK_EVERY_MS, CHECK_ONE_EVERY_MS,
} from '../src/modes/library/line-watch.js';

/** A watch with a hand-driven clock, timer, connection check and answers. */
function harness({ waiting = 2 } = {}) {
  const h = {
    time: 1_000_000,
    waiting,
    wakes: 0,
    checks: 0,
    lastAnswer: 1_000_000,
    timers: [],
    listeners: new Set(),
    windowListeners: new Map(),
    answerCheck: null,
  };
  h.watch = createLineWatch({
    waitingCount: () => h.waiting,
    wake: () => { h.wakes += 1; },
    now: () => h.time,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    confirm: () => { h.checks += 1; return new Promise((resolve) => { h.answerCheck = resolve; }); },
    subscribe: (listener) => { h.listeners.add(listener); return () => h.listeners.delete(listener); },
    lastAnswerAt: () => h.lastAnswer,
    hidden: () => h.hidden === true,
    target: {
      addEventListener: (name, fn) => h.windowListeners.set(name, fn),
      removeEventListener: (name) => h.windowListeners.delete(name),
    },
  });
  /** Something outside answered now. */
  h.answer = () => { h.lastAnswer = h.time; for (const listener of [...h.listeners]) listener(h.time); };
  /** Let the pending timer run after `ms`. */
  h.pass = (ms) => {
    h.time += ms;
    const timer = h.timers.filter((t) => !t.cleared).pop();
    timer.cleared = true;
    timer.fn();
  };
  h.settle = () => new Promise((resolve) => setImmediate(resolve));
  return h;
}

test('a dropped line that comes back wakes the waiting sources once', async () => {
  const h = harness();
  h.watch.start();
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 1, 'quiet for long enough with sources waiting: the line is checked');
  h.answerCheck(false);
  await h.settle();
  assert.equal(h.watch.state().lineDown, true);
  assert.equal(h.wakes, 0);

  h.time += 5_000;
  h.answer();
  assert.equal(h.wakes, 1, 'the first answer after the drop wakes them');
  h.time += 1_000;
  h.answer();
  assert.equal(h.wakes, 1, 'later answers do not');
  h.watch.stop();
});

test('a provider that is down while the line works is left to its own schedule', async () => {
  const h = harness();
  h.watch.start();
  // Other sources keep answering: no check is made at all.
  h.time += CHECK_EVERY_MS - 1_000;
  h.answer();
  h.pass(1_000);
  await h.settle();
  assert.equal(h.checks, 0);
  // Quiet (everything else finished), and the check finds the line working.
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 1);
  h.answerCheck(true);
  h.answer();
  await h.settle();
  assert.equal(h.wakes, 0);
  assert.equal(h.watch.state().lineDown, false);
  h.watch.stop();
});

test('one waiting source is checked less often than several', async () => {
  const h = harness({ waiting: 1 });
  h.watch.start();
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 1);
  h.answerCheck(true);
  await h.settle();
  h.pass(CHECK_EVERY_MS);
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 1, 'not again within two minutes');
  h.pass(CHECK_ONE_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 2);
  h.watch.stop();
});

test('nothing waiting: no check, and an old drop is forgotten', async () => {
  const h = harness({ waiting: 0 });
  h.watch.start();
  h.pass(CHECK_EVERY_MS);
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 0);
  h.answer();
  assert.equal(h.wakes, 0);
  h.watch.stop();
});

test("the window's online event checks at once and wakes on the answer", async () => {
  const h = harness();
  h.watch.start();
  h.time += 2_000; // far less than QUIET_MS
  h.windowListeners.get('online')();
  await h.settle();
  assert.equal(h.checks, 1);
  h.time += 300;
  h.answerCheck(true);
  h.answer();
  await h.settle();
  assert.equal(h.wakes, 1);
  h.watch.stop();
});

test('stop clears the timer, the listeners and a check on its way', async () => {
  const h = harness();
  h.watch.start();
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  h.watch.stop();
  assert.equal(h.timers.every((t) => t.cleared), true);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.windowListeners.size, 0);
  h.answerCheck(false);
  await h.settle();
  assert.deepEqual(h.watch.state(), { running: false, lineDown: false, timer: false });
  h.answer();
  assert.equal(h.wakes, 0);
  assert.ok(QUIET_MS < CHECK_EVERY_MS);
});

test('no check while the window is hidden', async () => {
  const h = harness();
  h.hidden = true;
  h.watch.start();
  h.pass(CHECK_EVERY_MS);
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 0);
  h.hidden = false;
  h.pass(CHECK_EVERY_MS);
  await h.settle();
  assert.equal(h.checks, 1);
  h.watch.stop();
});

test('online with a check answered a moment ago still wakes the sources', async () => {
  const h = harness();
  h.watch.start();
  h.windowListeners.get('online')();
  await h.settle();
  // The check reuses its last good answer: no new outside answer is noted.
  h.answerCheck(true);
  await h.settle();
  assert.equal(h.wakes, 1);
  h.answer();
  assert.equal(h.wakes, 1, 'not twice');
  h.watch.stop();
});
