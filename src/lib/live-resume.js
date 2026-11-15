/** Auto-reconnect episodes for live streams that drop after playing.
 *
 * This is the tier above hls-recovery.js. When a live stream that was really
 * playing ends in the broken state, the player hands the failure to this
 * controller, which retries the full Play rebuild on a backoff schedule until
 * the stream plays steadily again or the episode deadline passes.
 *
 * Pure: no DOM access. Timers and the clock are injected for tests.
 *
 * While an episode is active exactly one of these is pending, so it can never
 * stall and nothing can escape its bound: the wait before the next attempt, a
 * running attempt (with its timeout), the stable timer while the reconnected
 * stream plays, or the "did not come back" timer while it does not. During an
 * attempt, playing/interrupted are only recorded; settle() arms the timer.
 * Every transition arms the next timer before it clears the previous one.
 *
 * Recovery is 30 s of playing time accumulated since the last reconnect;
 * brief buffering pauses the count instead of restarting it.
 */

export const RECONNECT_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 30_000]);
export const RECONNECT_WINDOW_MS = 10 * 60_000;
export const RECONNECT_STABLE_MS = 30_000; // total playing time since the reconnect
// A reconnected stream that stops (buffering, stalled) and does not play again
// within this window counts as dropped again.
export const RECONNECT_RESUME_MS = 20_000;
// A rebuild can try several endpoints and wait for an HLS start-up buffer.
// An attempt that has not finished by then is abandoned as a failure.
export const RECONNECT_ATTEMPT_TIMEOUT_MS = 90_000;

// Each fits the player bar's meta line at 1024 px wide (about 150 px at 12 px).
export const RECONNECTING_TEXT = 'Connection lost. Retrying…';
export const RECONNECT_GAVE_UP_TEXT = "Can't reconnect. Press Play.";
export const RECONNECT_STOPPED_TEXT = 'Connection lost. Press Play.';

/** Delay before the attempt with this zero-based index. */
export function reconnectDelay(index) {
  const position = Math.max(0, Math.min(Number(index) || 0, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[position];
}

/** True for a live stream: declared live, or the media itself was unbounded
 *  (hls.js saw a live playlist, or the element reported an infinite
 *  duration). NaN only means "not known yet" and is not evidence. A declared
 *  on-demand item is never live. */
export function isLiveMedia({ delivery = '', hlsLive = null, duration } = {}) {
  if (delivery === 'live') return true;
  if (delivery === 'on-demand') return false;
  if (typeof hlsLive === 'boolean') return hlsLive;
  return duration === Number.POSITIVE_INFINITY;
}

/**
 * @param {object} options
 * @param {() => Promise<'ok'|'retry'|'stop'>} options.runAttempt  one full rebuild
 * @param {() => void} [options.abortAttempt]  invalidate an attempt that is still running
 * @param {(delayMs: number) => void} [options.onWaiting]  waiting for the next attempt
 * @param {() => void} [options.onGiveUp]  the deadline passed
 * @param {() => void} [options.onRecovered]  30 s of stable playback ended the episode
 */
export function createLiveResume({
  runAttempt,
  abortAttempt = () => {},
  onWaiting = () => {},
  onGiveUp = () => {},
  onRecovered = () => {},
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  delays = RECONNECT_DELAYS_MS,
  windowMs = RECONNECT_WINDOW_MS,
  stableMs = RECONNECT_STABLE_MS,
  resumeMs = RECONNECT_RESUME_MS,
  attemptTimeoutMs = RECONNECT_ATTEMPT_TIMEOUT_MS,
} = {}) {
  if (typeof runAttempt !== 'function') throw new TypeError('runAttempt is required');
  let episode = null;
  let attemptSeq = 0;

  const delayAt = (index) => delays[Math.max(0, Math.min(index, delays.length - 1))];

  function clear(timer) {
    if (timer != null) clearTimer(timer);
  }

  function clearProbationTimers() {
    clear(episode.stableTimer);
    clear(episode.resumeTimer);
    episode.stableTimer = null;
    episode.resumeTimer = null;
  }

  /** Forget the playing time counted towards recovery (a new reconnect). */
  function resetProbation() {
    clearProbationTimers();
    episode.playedMs = 0;
    episode.playingSince = null;
    episode.interrupted = false;
  }

  /** Stop counting playing time; the stream is not playing right now. */
  function pauseStableCount() {
    if (episode.playingSince != null) {
      episode.playedMs += Math.max(0, now() - episode.playingSince);
      episode.playingSince = null;
    }
    clear(episode.stableTimer);
    episode.stableTimer = null;
  }

  /** Playing: count time towards recovery. The stable timer is armed first and
   *  only then the "did not come back" timer cleared, so one is always set. */
  function resumeStableCount() {
    episode.interrupted = false;
    if (episode.playingSince == null) episode.playingSince = now();
    if (episode.stableTimer == null) {
      const remaining = Math.max(0, stableMs - episode.playedMs - (now() - episode.playingSince));
      episode.stableTimer = setTimer(() => {
        if (!episode) return;
        episode.stableTimer = null;
        finish();
        onRecovered();
      }, remaining);
    }
    clear(episode.resumeTimer);
    episode.resumeTimer = null;
  }

  /** Not playing after a reconnect: if it does not play again soon, it has
   *  dropped again. Armed before the stable timer is dropped. The window is
   *  not restarted by further interruptions, so it cannot be pushed back. */
  function armResumeWindow() {
    episode.interrupted = true;
    if (episode.resumeTimer == null) {
      episode.resumeTimer = setTimer(() => {
        if (!episode) return;
        episode.resumeTimer = null;
        scheduleNext();
      }, resumeMs);
    }
    pauseStableCount();
  }

  function finish() {
    if (episode) {
      clear(episode.waitTimer);
      clear(episode.attemptTimer);
      clearProbationTimers();
    }
    episode = null;
    attemptSeq++;
  }

  function giveUp() {
    finish();
    onGiveUp();
  }

  function scheduleNext() {
    resetProbation();
    clear(episode.waitTimer);
    episode.waitTimer = null;
    const current = now();
    if (current >= episode.deadline) {
      giveUp();
      return;
    }
    const delay = delayAt(episode.attempts);
    // After an attempt that `online` brought forward, this wait runs in full.
    episode.onlineAllowed = !episode.lastAttemptByOnline;
    if (current + delay > episode.deadline) {
      // No attempt may start after the deadline; wait it out, then give up.
      episode.waitTimer = setTimer(() => {
        if (episode) episode.waitTimer = null;
        giveUp();
      }, episode.deadline - current);
    } else {
      episode.waitTimer = setTimer(() => {
        if (episode) episode.waitTimer = null;
        attempt();
      }, delay);
    }
    onWaiting(delay);
  }

  function settle(id, result) {
    if (!episode || !episode.inFlight || id !== attemptSeq) return;
    episode.inFlight = null;
    episode.lastSettledAt = now();
    clear(episode.attemptTimer);
    episode.attemptTimer = null;
    // A failure reported while the attempt ran overrides a hopeful result.
    const outcome = result === 'ok' && episode.attemptFailed ? 'retry' : result;
    episode.attemptFailed = false;
    if (outcome === 'stop') {
      finish();
      return;
    }
    if (outcome === 'ok') {
      // A later drop may use `online` again.
      episode.lastAttemptByOnline = false;
      // Playing again. The episode ends only after enough playing time. If the
      // last thing seen during the attempt was an interruption, the stream is
      // not playing now: wait for it to come back instead.
      if (episode.interrupted) armResumeWindow();
      else resumeStableCount();
      return;
    }
    scheduleNext();
  }

  function attempt(trigger = 'schedule') {
    if (!episode || episode.inFlight) return episode?.inFlight || null;
    clear(episode.waitTimer);
    episode.waitTimer = null;
    episode.lastAttemptByOnline = trigger === 'online';
    // Recovery is counted per reconnect, so flapping cannot add up across them.
    resetProbation();
    episode.attempts++;
    episode.attemptFailed = false;
    const id = ++attemptSeq;
    episode.attemptTimer = setTimer(() => {
      if (!episode || id !== attemptSeq || !episode.inFlight) return;
      episode.attemptTimer = null;
      abortAttempt();
      settle(id, 'retry');
    }, attemptTimeoutMs);
    const promise = Promise.resolve()
      .then(() => runAttempt())
      .then((result) => settle(id, result), () => settle(id, 'retry'));
    episode.inFlight = promise;
    return promise;
  }

  return {
    /** A qualifying failure of the current item. Starts or continues the episode.
     *  While an attempt runs, the failure is recorded against that attempt. */
    failed() {
      if (!episode) {
        const start = now();
        episode = {
          startedAt: start,
          deadline: start + windowMs,
          attempts: 0,
          inFlight: null,
          attemptFailed: false,
          lastSettledAt: null,
          waitTimer: null,
          attemptTimer: null,
          stableTimer: null,
          resumeTimer: null,
          playedMs: 0,
          playingSince: null,
          interrupted: false,
          onlineAllowed: true,
          lastAttemptByOnline: false,
        };
        scheduleNext();
        return true;
      }
      if (episode.inFlight) {
        episode.attemptFailed = true;
        return true;
      }
      if (episode.waitTimer != null) return true;
      scheduleNext();
      return true;
    },
    /** Media is playing. While waiting, that counts as a recovery. Playing
     *  time accumulates towards the stable total. */
    notePlaying() {
      if (!episode) return;
      if (episode.inFlight) {
        // Only record it: the attempt's timeout stays the one pending timer,
        // and settle() arms the stable count from what was seen.
        episode.interrupted = false;
        if (episode.playingSince == null) episode.playingSince = now();
        return;
      }
      if (episode.waitTimer != null) {
        resumeStableCount();
        clear(episode.waitTimer);
        episode.waitTimer = null;
        return;
      }
      resumeStableCount();
    },
    /** A real playback interruption (buffering, an unexpected pause or end):
     *  the stable count pauses, and if the stream does not play again soon it
     *  has dropped again. During an attempt this is remembered for settle().
     *  A user pause must cancel() the episode instead of reporting this. */
    noteInterrupted() {
      if (!episode || episode.waitTimer != null) return;
      if (episode.inFlight) {
        // Only record it; settle() arms the "did not come back" timer.
        episode.interrupted = true;
        pauseStableCount();
        return;
      }
      armResumeWindow();
    },
    /** Try at once because the user asked (Play). One attempt at a time. */
    attemptNow() {
      if (!episode) return null;
      if (episode.inFlight) return episode.inFlight;
      if (episode.waitTimer == null) return null;
      if (now() >= episode.deadline) return null;
      return attempt('user');
    },
    /** The network says it is back. This may bring one wait's attempt forward,
     *  never sooner than the first delay after the episode began or the last
     *  attempt finished. A wait that follows such an early attempt cannot be
     *  shortened again, so a flapping connection adds at most one attempt per
     *  scheduled wait. */
    networkBack() {
      if (!episode || episode.inFlight || episode.waitTimer == null) return null;
      if (!episode.onlineAllowed) return null;
      const current = now();
      if (current >= episode.deadline) return null;
      const since = episode.lastSettledAt ?? episode.startedAt;
      if (current - since < delayAt(0)) return null;
      episode.onlineAllowed = false;
      return attempt('online');
    },
    /** End the episode and drop its timers; a running attempt is abandoned,
     *  unless keepAttempt: then it runs on, but its result is ignored (a user
     *  pause of an attempt that is already playing keeps that stream). */
    cancel({ keepAttempt = false } = {}) {
      if (!episode) return;
      const running = Boolean(episode.inFlight);
      finish();
      if (running && !keepAttempt) abortAttempt();
    },
    get active() { return Boolean(episode); },
    get waiting() { return Boolean(episode && episode.waitTimer != null && !episode.inFlight); },
    get inFlight() { return Boolean(episode?.inFlight); },
    get attempts() { return episode?.attempts || 0; },
    get deadline() { return episode?.deadline ?? null; },
    /** Timers outstanding (for tests: exactly 1 while active, 0 otherwise). */
    get pendingWork() {
      if (!episode) return 0;
      return [episode.waitTimer, episode.attemptTimer, episode.stableTimer, episode.resumeTimer]
        .filter((timer) => timer != null).length;
    },
  };
}

// A plain live stream (Icecast/Shoutcast) whose connection dies can freeze
// with no error, no `ended` and no `waiting`. The watchdog samples the
// playhead and reports a stall after this long without forward movement.
export const STALL_TIMEOUT_MS = 20_000;
export const STALL_SAMPLE_MS = 2_000;
// A sample this late (the machine slept, or timers were throttled) is not an
// observation of the stream: it only sets a new starting point.
const STALL_LATE_FACTOR = 2;
const STALL_EPSILON_SECONDS = 0.01;

/**
 * Stall watchdog for plain live streams. Pure: the playhead and the clock are
 * read through injected functions, so tests can drive it with a fake clock.
 *
 * One timer at most. A stall is reported only after consecutive, on-time
 * samples over STALL_TIMEOUT_MS of wall-clock time all saw the same playhead;
 * any movement, any late sample and any ineligible sample starts over.
 *
 * @param {object} options
 * @param {() => {eligible: boolean, position: number}} options.read
 *   the current state: eligible is false when paused, stopped, seeking, not
 *   live, inside a reconnect episode, or not really started yet.
 * @param {() => void} options.onStall  the stream is frozen
 */
export function createStallWatchdog({
  read,
  onStall,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  stallMs = STALL_TIMEOUT_MS,
  sampleMs = STALL_SAMPLE_MS,
} = {}) {
  if (typeof read !== 'function' || typeof onStall !== 'function') {
    throw new TypeError('read and onStall are required');
  }
  let timer = null;
  let lastAt = 0;
  let lastPosition = null;
  let stillSince = 0;

  function schedule() {
    timer = setTimer(sample, sampleMs);
  }

  function stop() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function baseline(at, position) {
    lastAt = at;
    lastPosition = position;
    stillSince = at;
  }

  function currentState() {
    const state = read() || {};
    const position = Number(state.position);
    return { eligible: state.eligible === true && Number.isFinite(position), position };
  }

  function sample() {
    timer = null;
    const state = currentState();
    if (!state.eligible) return; // stopped: start() arms it again
    const at = now();
    const gap = at - lastAt;
    if (gap > sampleMs * STALL_LATE_FACTOR || gap < 0) {
      baseline(at, state.position);
      schedule();
      return;
    }
    lastAt = at;
    if (Math.abs(state.position - lastPosition) > STALL_EPSILON_SECONDS) {
      baseline(at, state.position);
      schedule();
      return;
    }
    if (at - stillSince >= stallMs) {
      onStall();
      return;
    }
    schedule();
  }

  return {
    /** Watch from now on; does nothing if already watching or not eligible. */
    start() {
      if (timer != null) return;
      const state = currentState();
      if (!state.eligible) return;
      baseline(now(), state.position);
      schedule();
    },
    stop,
    get running() { return timer != null; },
  };
}