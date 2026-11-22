/**
 * Did the connection drop and come back? The Library asks this while sources
 * wait in their slow retry (progress.js), so that they are loaded again as
 * soon as the line is back, not minutes later when their own turn comes.
 *
 * A source that waits is not proof of a dropped line: the provider itself may
 * be down while everything else works. So the line counts as down only after
 * the small connection check (connection-evidence.js, about 150 bytes) has
 * failed, and that check is made only while sources wait and nothing outside
 * has answered for QUIET_MS. The first outside answer after that, from the
 * check or from anything else, wakes the waiting sources once. The window's
 * own `online` event is taken as a sign too.
 *
 * One timer while the Library is collecting; nothing at all otherwise, and no
 * check while the window is hidden.
 */

import {
  confirmConnection, lastOutsideAnswerAt, onOutsideAnswer,
} from '../../lib/connection-evidence.js';

export const QUIET_MS = 20_000;
/** Between checks while two or more sources wait: likely the line. */
export const CHECK_EVERY_MS = 31_000;
/** Between checks while one source waits: likely that provider. */
export const CHECK_ONE_EVERY_MS = 120_000;

export function createLineWatch({
  waitingCount,
  wake,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle?.unref?.(); // tests: this timer alone must not keep a run alive
    return handle;
  },
  clearTimer = (handle) => clearTimeout(handle),
  confirm = () => confirmConnection(),
  subscribe = onOutsideAnswer,
  lastAnswerAt = lastOutsideAnswerAt,
  target = globalThis.window,
  hidden = () => globalThis.document?.hidden === true,
} = {}) {
  let running = false;
  let timer = null;
  let unsubscribe = null;
  let lineDown = false;
  let lastCheckAt = 0;
  let run = 0;

  /** The line answers again: wake the waiting sources, once per drop. */
  function lineIsBack() {
    if (!running || !lineDown) return;
    lineDown = false;
    if (waitingCount() > 0) wake();
  }

  function onAnswer() {
    lineIsBack();
  }

  function check(force = false) {
    const waiting = waitingCount();
    if (waiting <= 0) {
      lineDown = false;
      return;
    }
    if (hidden()) return;
    const at = now();
    if (!force) {
      if (at - lastAnswerAt() < QUIET_MS) return;
      const every = waiting >= 2 ? CHECK_EVERY_MS : CHECK_ONE_EVERY_MS;
      if (lastCheckAt && at - lastCheckAt < every) return;
    }
    lastCheckAt = at;
    const mine = run;
    Promise.resolve().then(() => confirm()).then((ok) => {
      if (!running || mine !== run) return;
      // A good check usually reaches onAnswer by itself (it notes an outside
      // answer), but an answer reused from a moment ago does not.
      if (ok) lineIsBack();
      else lineDown = true;
    }, () => {});
  }

  function tick() {
    timer = null;
    if (!running) return;
    check();
    timer = setTimer(tick, CHECK_EVERY_MS);
  }

  function onOnline() {
    if (!running || waitingCount() <= 0) return;
    // The window says the link just came up, so it was down.
    lineDown = true;
    check(true);
  }

  return {
    start() {
      if (running) return;
      running = true;
      run += 1;
      lineDown = false;
      lastCheckAt = 0;
      unsubscribe = subscribe(onAnswer);
      target?.addEventListener?.('online', onOnline);
      timer = setTimer(tick, CHECK_EVERY_MS);
    },
    stop() {
      if (!running) return;
      running = false;
      run += 1;
      lineDown = false;
      if (timer != null) clearTimer(timer);
      timer = null;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      target?.removeEventListener?.('online', onOnline);
    },
    /** Tests. */
    state() {
      return { running, lineDown, timer: timer != null };
    },
  };
}
