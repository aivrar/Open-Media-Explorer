import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLiveResume, createStallWatchdog, isLiveMedia, reconnectDelay,
  STALL_SAMPLE_MS, STALL_TIMEOUT_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS, RECONNECT_DELAYS_MS, RECONNECT_RESUME_MS, RECONNECT_STABLE_MS,
  RECONNECT_WINDOW_MS,
} from '../src/lib/live-resume.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A manual clock: timers fire only when advance() passes them. */
function fakeClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, delay) => { const id = ++seq; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    get pending() { return timers.size; },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.at)) { nextId = id; next = timer; }
        }
        if (!next) break;
        timers.delete(nextId);
        time = next.at;
        next.fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

function harness(outcome = () => 'retry') {
  const clock = fakeClock();
  const log = { attempts: [], aborts: 0, waits: [], gaveUp: 0, recovered: 0, running: 0, maxRunning: 0 };
  const resume = createLiveResume({
    runAttempt: async () => {
      log.attempts.push(clock.now());
      log.running++;
      log.maxRunning = Math.max(log.maxRunning, log.running);
      try { return await outcome(log.attempts.length, clock); } finally { log.running--; }
    },
    abortAttempt: () => { log.aborts++; },
    onWaiting: (delay) => log.waits.push(delay),
    onGiveUp: () => { log.gaveUp++; },
    onRecovered: () => { log.recovered++; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  return { clock, log, resume };
}

async function playFor(clock, resume, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    const step = Math.min(1000, ms - elapsed);
    await clock.advance(step);
    resume.noteProgress(step);
  }
}

test('the backoff grows 2, 4, 8, 16 s and then stays at 30 s', async () => {
  assert.deepEqual(RECONNECT_DELAYS_MS, [2000, 4000, 8000, 16000, 30000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  const { clock, log, resume } = harness();
  resume.failed();
  assert.equal(resume.waiting, true);
  await clock.advance(1999);
  assert.deepEqual(log.attempts, []);
  await clock.advance(1);
  await clock.advance(120_000 - 2000);
  // Each failed attempt waits the next delay: 2, +4, +8, +16, +30, +30 ...
  assert.deepEqual(log.attempts.slice(0, 6), [2000, 6000, 14000, 30000, 60000, 90000]);
  assert.deepEqual(log.waits.slice(0, 6), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('attempts never overlap, even when Play or online asks again', async () => {
  let finish;
  const { clock, log, resume } = harness(() => new Promise((resolve) => { finish = resolve; }));
  resume.failed();
  await clock.advance(2000);
  assert.equal(log.attempts.length, 1);
  assert.equal(resume.inFlight, true);
  const again = resume.attemptNow();
  assert.ok(again, 'attemptNow while running returns the running attempt');
  resume.failed(); // a failure inside the attempt is reported by the attempt itself
  await clock.advance(30_000);
  assert.equal(log.attempts.length, 1);
  assert.equal(log.maxRunning, 1);
  finish('retry');
  await flush();
  assert.equal(resume.waiting, true);
  await clock.advance(4000);
  assert.equal(log.attempts.length, 2);
  assert.equal(log.maxRunning, 1);
});

test('the deadline ends the episode with the give-up callback and bounded attempts', async () => {
  const { clock, log, resume } = harness();
  resume.failed();
  await clock.advance(RECONNECT_WINDOW_MS + 60_000);
  assert.equal(log.gaveUp, 1);
  assert.equal(resume.active, false);
  assert.ok(log.attempts.length <= 25, `${log.attempts.length} attempts`);
  assert.ok(log.attempts.every((at) => at <= RECONNECT_WINDOW_MS));
  assert.equal(clock.pending, 0);
  const count = log.attempts.length;
  await clock.advance(10 * 60_000);
  assert.equal(log.attempts.length, count);
});

test('a moving stream gets probation beyond the reconnect deadline', async () => {
  const clock = fakeClock();
  const log = { gaveUp: 0, recovered: 0 };
  const resume = createLiveResume({
    runAttempt: async () => 'ok',
    onGiveUp: () => { log.gaveUp++; },
    onRecovered: () => { log.recovered++; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    delays: [5_000], windowMs: 10_000,
  });
  resume.failed();
  await clock.advance(5_000);
  await playFor(clock, resume, 6_000);
  assert.equal(log.gaveUp, 0);
  assert.equal(resume.active, true);
  await playFor(clock, resume, 24_000);
  assert.equal(log.recovered, 1);
  assert.equal(clock.pending, 0);

  resume.failed();
  await clock.advance(5_000 + RECONNECT_RESUME_MS);
  assert.equal(log.gaveUp, 1, 'a restart with no progress still gives up');
  assert.equal(clock.pending, 0);
});

test('sparse playback at the probation deadline retries within the same episode', async () => {
  const { clock, log, resume } = harness(() => 'ok');
  resume.failed();
  const deadline = resume.deadline;
  await clock.advance(2000);
  for (const gap of [17_000, 18_000, 14_000]) {
    await clock.advance(gap);
    resume.noteProgress(1000);
  }
  await clock.advance(1000);
  assert.equal(log.recovered, 0);
  assert.equal(resume.deadline, deadline);
  assert.equal(resume.waiting, true);
  await clock.advance(4000);
  assert.deepEqual(log.attempts, [2000, 56_000]);
});

test('30 s of stable playback ends the episode; a brief playing does not', async () => {
  const { clock, log, resume } = harness(() => 'ok');
  resume.failed();
  await clock.advance(2000);
  assert.equal(log.attempts.length, 1);
  await playFor(clock, resume, 5000);
  // Dropped again after only 5 s: the same episode continues with the next delay.
  resume.failed();
  assert.equal(resume.active, true);
  assert.deepEqual(log.waits, [2000, 4000]);
  await clock.advance(4000);
  assert.equal(log.attempts.length, 2);
  await playFor(clock, resume, 20_000);
  await clock.advance(3000); // brief buffering pauses the count
  await playFor(clock, resume, 10_000 - 1);
  assert.equal(resume.active, true);
  await playFor(clock, resume, 1);
  assert.equal(resume.active, false, '30 s of playing time in total');
  assert.equal(log.recovered, 1);
  assert.equal(log.gaveUp, 0);
  // The next failure starts a fresh episode at the first delay.
  resume.failed();
  assert.deepEqual(log.waits.at(-1), 2000);
});

test('cancel drops a queued attempt and abandons a running one', async () => {
  const queued = harness();
  queued.resume.failed();
  queued.resume.cancel();
  await queued.clock.advance(60_000);
  assert.deepEqual(queued.log.attempts, []);
  assert.equal(queued.log.aborts, 0);
  assert.equal(queued.clock.pending, 0);

  let finish;
  const running = harness(() => new Promise((resolve) => { finish = resolve; }));
  running.resume.failed();
  await running.clock.advance(2000);
  assert.equal(running.resume.inFlight, true);
  running.resume.cancel();
  assert.equal(running.log.aborts, 1);
  finish('retry'); // a late result from the old attempt changes nothing
  await flush();
  await running.clock.advance(120_000);
  assert.equal(running.log.attempts.length, 1);
  assert.equal(running.resume.active, false);
  assert.equal(running.clock.pending, 0);
});

test('a stuck attempt is abandoned after its timeout and the next one is queued', async () => {
  const { clock, log, resume } = harness((n) => (n === 1 ? new Promise(() => {}) : 'ok'));
  resume.failed();
  await clock.advance(2000);
  await clock.advance(RECONNECT_ATTEMPT_TIMEOUT_MS);
  assert.equal(log.aborts, 1);
  assert.equal(resume.waiting, true);
  await clock.advance(4000);
  assert.equal(log.attempts.length, 2);
});

test('attemptNow while waiting tries once at once; a stop result ends quietly', async () => {
  const { clock, log, resume } = harness(() => 'stop');
  resume.failed();
  await clock.advance(500);
  const first = resume.attemptNow();
  const second = resume.attemptNow();
  assert.equal(first, second);
  await flush();
  assert.deepEqual(log.attempts, [500]);
  assert.equal(resume.active, false);
  assert.equal(log.gaveUp, 0);
  assert.equal(clock.pending, 0);
  assert.equal(resume.attemptNow(), null);
});

test('a failure that is not inside an episode starts one; a thrown attempt counts as failed', async () => {
  const { clock, log, resume } = harness(() => { throw new Error('boom'); });
  assert.equal(resume.active, false);
  resume.failed();
  await clock.advance(2000);
  assert.equal(log.attempts.length, 1);
  assert.equal(resume.waiting, true);
});

test('an interrupted recovery that never plays again is retried, never left idle', async () => {
  const { clock, log, resume } = harness(() => 'ok');
  resume.failed();
  await clock.advance(2000);
  await playFor(clock, resume, 10_000);
  // The playhead stops here without an error.
  assert.ok(resume.pendingWork > 0, 'something is always pending while active');
  await clock.advance(RECONNECT_RESUME_MS - 1);
  assert.equal(log.waits.length, 1);
  await clock.advance(1);
  assert.deepEqual(log.waits, [2000, 4000], 'treated as a failure: the next delay is queued');
  await clock.advance(4000);
  assert.equal(log.attempts.length, 2);
  // Progress resumes just before the playback timeout.
  await clock.advance(RECONNECT_RESUME_MS - 1);
  resume.noteProgress(1);
  await playFor(clock, resume, RECONNECT_STABLE_MS - 1);
  assert.equal(log.waits.length, 2);
  assert.equal(resume.active, false);
  assert.equal(log.recovered, 1);
});

test('an active episode always has exactly one timer, whatever order events arrive in', async () => {
  // Attempts take a few seconds and end ok, retry, or hang until their
  // timeout; progress and failures arrive at pseudo-random moments,
  // including in the middle of attempts.
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 6; run++) {
    const { clock, log, resume } = harness((n, attemptClock) => new Promise((resolve) => {
      const roll = random();
      if (roll < 0.1) return; // hangs: only the attempt timeout can end it
      attemptClock.setTimer(() => resolve(roll < 0.55 ? 'retry' : 'ok'), 500 + Math.floor(random() * 4000));
    }));
    resume.failed();
    for (let step = 0; step < 2000 && resume.active; step++) {
      // Exactly one: a probation timer beside a running attempt would show as 2.
      assert.equal(resume.pendingWork, 1, `run ${run} step ${step} at ${clock.now()} ms`);
      const roll = random();
      if (roll < 0.25) resume.noteProgress(500);
      else if (roll < 0.3) resume.failed();
      else if (roll < 0.33) resume.networkBack();
      assert.equal(resume.pendingWork, resume.active ? 1 : 0, `after event, run ${run} step ${step}`);
      await clock.advance(250 + Math.floor(random() * 2000));
    }
    assert.equal(resume.active, false, `run ${run} ended`);
    assert.equal(resume.pendingWork, 0);
    assert.ok(log.attempts.length <= 50, `run ${run}: ${log.attempts.length} attempts`);
  }
});

test('playing during a slow attempt cannot finish the episode or escape the attempt timeout', async () => {
  const { clock, log, resume } = harness(() => new Promise(() => {})); // hangs
  resume.failed();
  await clock.advance(2000);
  assert.equal(resume.inFlight, true);
  await playFor(clock, resume, RECONNECT_STABLE_MS + 5000);
  assert.equal(resume.pendingWork, 1, 'only the attempt timeout is armed');
  assert.equal(log.recovered, 0, 'no recovery while the attempt is still running');
  assert.equal(resume.inFlight, true);
  await clock.advance(RECONNECT_ATTEMPT_TIMEOUT_MS - (RECONNECT_STABLE_MS + 5000));
  assert.equal(log.aborts, 1, 'the hung attempt still hit its timeout');
  assert.equal(resume.waiting, true);
});

test('playing time seen during an attempt counts once it settles ok', async () => {
  let finish;
  const { clock, log, resume } = harness(() => new Promise((resolve) => { finish = resolve; }));
  resume.failed();
  await clock.advance(2000);
  await playFor(clock, resume, 20_000);
  finish('ok');
  await flush();
  assert.equal(resume.pendingWork, 1);
  await playFor(clock, resume, 10_000 - 1);
  assert.equal(log.recovered, 0);
  await playFor(clock, resume, 1);
  assert.equal(log.recovered, 1);
});

test('an interruption during an attempt is kept: ok then waits for playback to come back', async () => {
  let finish;
  const { clock, log, resume } = harness(() => new Promise((resolve) => { finish = resolve; }));
  resume.failed();
  await clock.advance(2000);
  await playFor(clock, resume, 1000); // stalled again before the attempt reported back
  finish('ok');
  await flush();
  assert.equal(resume.active, true);
  assert.ok(resume.pendingWork > 0);
  await clock.advance(RECONNECT_STABLE_MS); // no recovery is declared
  assert.equal(log.recovered, 0);
  assert.deepEqual(log.waits, [2000, 4000], 'did not come back within 20 s: a new drop');
});

test('a mostly-working stream recovers; flapping between reconnects does not add up', async () => {
  // 25 s playing, brief buffering, 25 s playing: recovered after 30 s in total.
  const steady = harness(() => 'ok');
  steady.resume.failed();
  await steady.clock.advance(2000);
  await playFor(steady.clock, steady.resume, 25_000);
  await steady.clock.advance(2000);
  await playFor(steady.clock, steady.resume, 5000);
  assert.equal(steady.resume.active, false);
  assert.equal(steady.log.recovered, 1);

  // A few seconds of play per reconnect: each reconnect counts from zero, so
  // the episode is never declared recovered and its deadline still applies.
  const flapping = harness(() => 'ok');
  flapping.resume.failed();
  for (let cycle = 0; cycle < 100 && flapping.resume.active; cycle++) {
    const before = flapping.log.attempts.length;
    while (flapping.resume.active && flapping.log.attempts.length === before) {
      await flapping.clock.advance(1000);
    }
    if (!flapping.resume.active) break;
    await playFor(flapping.clock, flapping.resume, 5000);
    flapping.resume.failed();
  }
  assert.equal(flapping.log.recovered, 0);
  assert.equal(flapping.log.gaveUp, 1);
});

test('a failure while an attempt runs makes that attempt fail even if it reports ok', async () => {
  let finish;
  const { clock, log, resume } = harness(() => new Promise((resolve) => { finish = resolve; }));
  resume.failed();
  await clock.advance(2000);
  resume.failed(); // e.g. a fatal callback before the attempt settled
  finish('ok');
  await flush();
  assert.equal(resume.waiting, true);
  assert.deepEqual(log.waits, [2000, 4000]);
  // The mark belongs to that attempt only.
  await clock.advance(4000);
  finish('ok');
  await flush();
  assert.equal(resume.waiting, false);
  assert.equal(resume.active, true);
});

test('repeated online events between failures are rate-limited to the first delay', async () => {
  const { clock, log, resume } = harness();
  resume.failed();
  assert.equal(resume.networkBack(), null);
  await clock.advance(1500);
  assert.equal(resume.networkBack(), null, 'under 2 s since the episode began');
  await clock.advance(500); // the scheduled attempt runs and fails at 2 s
  assert.equal(log.attempts.length, 1);
  for (let i = 0; i < 10; i++) resume.networkBack();
  await clock.advance(1999);
  for (let i = 0; i < 10; i++) resume.networkBack();
  await flush();
  assert.equal(log.attempts.length, 1, 'under 2 s since the last attempt finished');
  await clock.advance(1);
  assert.ok(resume.networkBack(), 'brought forward once 2 s have passed');
  await flush();
  assert.equal(log.attempts.length, 2);
  assert.equal(resume.networkBack(), null, 'and not again straight away');
  // An explicit Play is not rate-limited.
  assert.ok(resume.attemptNow());
  await flush();
  assert.equal(log.attempts.length, 3);
});

test('online can bring one wait forward; the next wait then runs its normal delay', async () => {
  const { clock, log, resume } = harness();
  resume.failed();
  await clock.advance(2000); // scheduled attempt 1 fails; the next wait is 4 s
  assert.equal(log.attempts.length, 1);
  await clock.advance(2000);
  assert.ok(resume.networkBack(), 'online brings attempt 2 forward');
  await flush();
  assert.equal(log.attempts.length, 2);
  // Attempt 2 failed; this wait (8 s) cannot be shortened by online.
  for (let elapsed = 0; elapsed < 7900; elapsed += 100) {
    assert.equal(resume.networkBack(), null);
    await clock.advance(100);
  }
  assert.equal(log.attempts.length, 2);
  await clock.advance(100);
  assert.equal(log.attempts.length, 3, 'attempt 3 at its normal time');
  // The wait after a scheduled attempt may be shortened once again.
  await clock.advance(2000);
  assert.ok(resume.networkBack());
  await flush();
  assert.equal(log.attempts.length, 4);
});

test('a flapping network adds at most about one attempt per scheduled wait', async () => {
  const run = async (flapping) => {
    const { clock, log, resume } = harness();
    resume.failed();
    while (resume.active) {
      if (flapping) resume.networkBack();
      await clock.advance(100);
    }
    return log.attempts.length;
  };
  const scheduled = await run(false);
  const flapped = await run(true);
  assert.ok(flapped <= scheduled * 2, `${flapped} attempts with online every 100 ms, ${scheduled} without`);
  assert.ok(flapped <= 40, `${flapped} attempts in ten minutes`);
});

test('live means declared live, a live HLS playlist, or an infinite duration', () => {
  assert.equal(isLiveMedia({ delivery: 'live' }), true);
  assert.equal(isLiveMedia({ delivery: 'on-demand', duration: Infinity }), false);
  assert.equal(isLiveMedia({ delivery: 'on-demand', hlsLive: true }), false);
  assert.equal(isLiveMedia({ delivery: 'unknown', hlsLive: true }), true);
  assert.equal(isLiveMedia({ delivery: 'unknown', hlsLive: false, duration: Infinity }), false);
  assert.equal(isLiveMedia({ delivery: 'unknown', duration: Infinity }), true);
  assert.equal(isLiveMedia({ delivery: 'unknown', duration: Number.NaN }), false);
  assert.equal(isLiveMedia({ delivery: 'unknown', duration: 3600 }), false);
  assert.equal(isLiveMedia({}), false);
});

/** A clock for the stall watchdog: run() fires due timers in order; sleep()
 *  moves time on without firing anything, like a machine that slept, so the
 *  next timer fires late. */
function watchClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimer: (fn, delay) => { const id = ++seq; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    get pending() { return timers.size; },
    run(ms) {
      const end = time + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.at)) { nextId = id; next = timer; }
        }
        if (!next) break;
        timers.delete(nextId);
        time = Math.max(time, next.at);
        next.fn();
      }
      time = end;
    },
    sleep(ms) {
      time += ms;
      clock.run(0); // overdue timers fire now, late
    },
  };
  return clock;
}

function watchHarness() {
  const clock = watchClock();
  const media = { eligible: true, position: 10 };
  const stalls = [];
  const watchdog = createStallWatchdog({
    read: () => ({ ...media }),
    onStall: () => stalls.push(clock.now()),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  return { clock, media, stalls, watchdog };
}

test('stall watchdog: a playhead frozen for 20 s is reported once, at 20 s', () => {
  const { clock, stalls, watchdog } = watchHarness();
  watchdog.start();
  watchdog.start(); // already watching: still one timer
  assert.equal(clock.pending, 1);
  clock.run(STALL_TIMEOUT_MS - 1);
  assert.deepEqual(stalls, []);
  clock.run(1);
  assert.deepEqual(stalls, [STALL_TIMEOUT_MS]);
  assert.equal(clock.pending, 0, 'it stops after reporting');
  clock.run(60_000);
  assert.equal(stalls.length, 1);
});

test('stall watchdog: a brief stall that moves again before 20 s reports nothing', () => {
  const { clock, media, stalls, watchdog } = watchHarness();
  watchdog.start();
  clock.run(18_000);
  media.position += 0.5; // the browser recovered by itself
  clock.run(STALL_TIMEOUT_MS - 2 * STALL_SAMPLE_MS);
  assert.deepEqual(stalls, []);
  for (let i = 0; i < 30; i++) { media.position += 2; clock.run(STALL_SAMPLE_MS); }
  assert.deepEqual(stalls, []);
  assert.equal(clock.pending, 1);
  watchdog.stop();
  assert.equal(clock.pending, 0);
});

test('stall watchdog: paused or otherwise ineligible media is never reported and drops its timer', () => {
  const { clock, media, stalls, watchdog } = watchHarness();
  watchdog.start();
  clock.run(10_000);
  media.eligible = false; // the user paused
  clock.run(STALL_SAMPLE_MS);
  assert.equal(clock.pending, 0);
  clock.run(60_000);
  assert.deepEqual(stalls, []);
  watchdog.start(); // not eligible: does not arm
  assert.equal(clock.pending, 0);
  media.eligible = true; // playing again: a fresh 20 s
  watchdog.start();
  clock.run(STALL_TIMEOUT_MS - 1);
  assert.deepEqual(stalls, []);
  clock.run(1);
  assert.equal(stalls.length, 1);
});

test('stall watchdog: a single late sample after a long gap is not a stall', () => {
  const { clock, stalls, watchdog } = watchHarness();
  watchdog.start();
  clock.run(STALL_SAMPLE_MS);
  clock.sleep(5 * 60_000); // the machine slept; the next sample fires very late
  assert.deepEqual(stalls, []);
  assert.equal(clock.pending, 1, 'it keeps watching from a new starting point');
  // Throttled timers: every sample late. Never counts.
  for (let i = 0; i < 20; i++) clock.sleep(60_000);
  assert.deepEqual(stalls, []);
  // On-time samples again: a full 20 s from the last late one is needed.
  const from = clock.now();
  clock.run(STALL_TIMEOUT_MS + STALL_SAMPLE_MS);
  assert.equal(stalls.length, 1);
  assert.ok(stalls[0] - from >= STALL_TIMEOUT_MS, `${stalls[0] - from} ms`);
});
