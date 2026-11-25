/**
 * "Pick the best stream" (Listed streams and Auto): the stream picked first
 * can connect (its relay registers and its manifest or first bytes answer)
 * and still never play. Then the streams not yet tried for this start get
 * their turn, in the same order and pairs as at connection
 * (media-failover.js connectMediaRelay), as soon as the player gives up on
 * the stream, and at the latest START_FAILOVER_MS after it connected: the
 * player's start time limit for a live stream (HLS_STARTUP_BUFFER_TIMEOUT_MS,
 * how long a start waits for its first buffer). The hand-over is for a
 * stream that never begins: once its first `playing` has come AND its
 * position has moved at all, that limit no longer applies; it then has
 * START_CONFIRM_MS from that `playing` to play a whole second, and only if it
 * does not are the next streams tried. A `playing` with no movement at all
 * leaves the start time limit as it was. A stream that plays for a second
 * ends the watch for good (later stalls are the player's recovery), and so do
 * a pause, Stop and another station. Saved backups also work with the setting off.
 */

import { HLS_STARTUP_BUFFER_TIMEOUT_MS } from './hls-recovery.js';
import { streamCandidatesForItem } from './media-failover.js';

export const START_FAILOVER_MS = HLS_STARTUP_BUFFER_TIMEOUT_MS;
/** After the first `playing` and some movement: how long (from that
 *  `playing`) a stream has to play its first whole second. */
export const START_CONFIRM_MS = 10_000;

/** The streams of `item` still to try after the addresses in `tried`, in
 *  the order a start with "Pick the best stream" tries them. */
export function untriedStreams(item, { addresses, extraStreams = [], tried = [] } = {}) {
  const done = new Set(tried);
  return streamCandidatesForItem(item, { preferBest: true, extraStreams, addresses }).filter((stream) => !done.has(stream.url));
}

/** One watch at a time. arm(token, item, tried) after a stream connected;
 *  playing(token) on its first `playing`; moved(token) when its position
 *  moved forward after that; failed(token) when the player gave up on it
 *  before it played (true when the next streams were released); end() when
 *  it played a second or the start ended. onNext(item, tried, token) starts
 *  the next streams. */
export function createStartWatch({
  onNext = () => {},
  timeoutMs = START_FAILOVER_MS,
  confirmMs = START_CONFIRM_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  now = () => Date.now(),
} = {}) {
  let watch = null;
  const end = () => {
    const ending = watch;
    watch = null;
    if (ending?.timer != null) clearTimer(ending.timer);
  };
  const next = (token) => {
    const mine = watch;
    if (!mine || mine.token !== token) return false;
    end();
    onNext(mine.item, mine.tried, token);
    return true;
  };
  const mineFor = (token) => (watch && watch.token === token ? watch : null);
  return {
    arm(token, item, tried) {
      end();
      const mine = {
        token, item, tried: [...tried], timer: null, playingAt: null, confirming: false,
      };
      watch = mine;
      mine.timer = setTimer(() => {
        if (watch === mine) next(token);
      }, timeoutMs);
    },
    /** Its first `playing` (later ones, after buffering, change nothing). */
    playing(token) {
      const mine = mineFor(token);
      if (mine && mine.playingAt === null) mine.playingAt = now();
    },
    /** Its position moved forward after `playing`: the start time limit
     *  gives way to the confirm window, which runs from that `playing`. */
    moved(token) {
      const mine = mineFor(token);
      if (!mine || mine.playingAt === null || mine.confirming) return;
      mine.confirming = true;
      if (mine.timer != null) clearTimer(mine.timer);
      const left = Math.max(0, mine.playingAt + confirmMs - now());
      mine.timer = setTimer(() => {
        if (watch === mine) next(token);
      }, left);
    },
    failed: next,
    end,
    get active() { return watch !== null; },
    /** In the confirm window (it began; a second of play still to come). */
    get confirming() { return watch?.confirming === true; },
  };
}
