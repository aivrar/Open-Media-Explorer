/**
 * Song structure: notices a build-up (the level rising over several bars)
 * and a drop (the sudden full return after a build or a break), on the bar
 * clock the shuffle already uses (the reactor's beat clock, 4 beats a bar).
 * A pure detector: fed one frame at a time with the beat clock and the
 * sound's level in dB (before the reactor's auto-gain, which would flatten a
 * build); no timers, nothing allocated per frame.
 *
 * Per bar it keeps the mean level (the last STRUCTURE_BARS bars, a ring).
 *   Build   the last BUILD_BARS bar means each no more than BUILD_SLACK_DB
 *           below the one before, and rising by BUILD_RISE_DB in all.
 *           `building` while it holds; `buildAmount` 0..1 how far (the rise
 *           over BUILD_FULL_DB). When it stops, a drop may follow for
 *           AFTER_BUILD_BARS bars.
 *   Break   a bar BREAK_DB or more below the mean of the BREAK_BARS before
 *           it: a drop may follow for BREAK_WAIT_BARS bars, back to that
 *           mean.
 *   Drop    on the first beat of a bar (judged when that beat ends), while a
 *           drop may follow: the beat's mean level at least the reference
 *           less DROP_FULL_DB (the level before the break, or the top of the
 *           build) and DROP_JUMP_DB over the bar before. step() returns
 *           'drop' once; then none for DROP_COOLDOWN_BARS.
 * A beat clock that goes back (a new track) or no sure tempo (step with a
 * non-finite clock) starts it afresh.
 *
 * Held hooks (index.js, SONG_STRUCTURE_RELEASED): through a build the drift
 * deepens a little (structureDriftScale, never past the most the flash
 * check measured); a drop brings the shuffle's next change forward
 * (shuffle.js createShuffleTimer bringForward: only when it has shown the
 * scene for its minimum time; it replaces the change, adds none).
 */

/** Whether song structure steers drift and the shuffle. */
export const SONG_STRUCTURE_RELEASED = false;
export const STRUCTURE_BARS = 16;
export const BUILD_BARS = 4;
export const BUILD_SLACK_DB = 0.5;
export const BUILD_RISE_DB = 3;
export const BUILD_FULL_DB = 9;
export const AFTER_BUILD_BARS = 2;
export const BREAK_BARS = 4;
export const BREAK_DB = 6;
export const BREAK_WAIT_BARS = 16;
export const DROP_FULL_DB = 2;
export const DROP_JUMP_DB = 3;
export const DROP_COOLDOWN_BARS = 8;
/** The quietest level counted (dB): silence reads this. */
export const STRUCTURE_FLOOR_DB = -90;
/** How much a full build deepens the drift (a share; PROPOSED). */
export const BUILD_DRIFT_BOOST = 0.25;

/** The drift scale through a build: `scale` deepened by up to
 *  BUILD_DRIFT_BOOST x `buildAmount`, never above `most` (the largest the
 *  flash check measured). */
export function structureDriftScale(scale, buildAmount, most) {
  const deeper = scale * (1 + BUILD_DRIFT_BOOST * Math.max(0, Math.min(1, buildAmount || 0)));
  return Math.max(scale, Math.min(deeper, Number.isFinite(most) ? Math.max(scale, most) : scale));
}

export function createStructureDetector() {
  const means = new Float64Array(STRUCTURE_BARS);
  let filled = 0; // bars closed (up to STRUCTURE_BARS kept)
  let head = 0; // where the next bar mean goes
  let bar = Number.NaN;
  let barSum = 0;
  let barCount = 0;
  let beatSum = 0;
  let beatCount = 0;
  let firstBeatJudged = false;
  let lastBeats = Number.NaN;
  let building = false;
  let buildAmount = 0;
  let buildTop = Number.NaN;
  let afterBuildUntil = -1;
  let breakRef = Number.NaN;
  let breakUntil = -1;
  let quietUntil = -1;
  const stats = { builds: 0, breaks: 0, drops: 0, bars: 0 };

  /** The mean `back` bars ago (1: the last closed bar). */
  const meanAgo = (back) => means[(head - back + STRUCTURE_BARS * 2) % STRUCTURE_BARS];

  function reset() {
    filled = 0;
    head = 0;
    bar = Number.NaN;
    barSum = 0;
    barCount = 0;
    beatSum = 0;
    beatCount = 0;
    firstBeatJudged = false;
    lastBeats = Number.NaN;
    building = false;
    buildAmount = 0;
    buildTop = Number.NaN;
    afterBuildUntil = -1;
    breakRef = Number.NaN;
    breakUntil = -1;
    quietUntil = -1;
  }

  function closeBar(closed) {
    if (!barCount) return;
    const mean = barSum / barCount;
    // A break: well under the bars before it.
    if (filled >= BREAK_BARS) {
      let before = 0;
      for (let back = 1; back <= BREAK_BARS; back += 1) before += meanAgo(back);
      before /= BREAK_BARS;
      // (Within a break the bars before are quiet too, so only its first
      // bar starts one: the reference is the level before it.)
      if (mean <= before - BREAK_DB && closed > breakUntil) {
        stats.breaks += 1;
        breakRef = before;
        breakUntil = closed + BREAK_WAIT_BARS;
      }
    }
    means[head] = mean;
    head = (head + 1) % STRUCTURE_BARS;
    filled = Math.min(STRUCTURE_BARS, filled + 1);
    stats.bars += 1;
    // A build: rising, bar on bar.
    let rising = filled >= BUILD_BARS;
    for (let back = 1; rising && back < BUILD_BARS; back += 1) {
      if (meanAgo(back) < meanAgo(back + 1) - BUILD_SLACK_DB) rising = false;
    }
    const rise = filled >= BUILD_BARS ? meanAgo(1) - meanAgo(BUILD_BARS) : 0;
    const was = building;
    // (Not in the cool-down after a drop: the drop's own bars are not a
    // new build.)
    building = rising && rise >= BUILD_RISE_DB && closed > quietUntil;
    if (building) {
      if (!was) stats.builds += 1;
      buildAmount = Math.min(1, rise / BUILD_FULL_DB);
      buildTop = meanAgo(1);
    } else {
      buildAmount = 0;
      if (was) afterBuildUntil = closed + 1 + AFTER_BUILD_BARS;
    }
  }

  return {
    get building() { return building; },
    get buildAmount() { return buildAmount; },
    /** A drop may come now (after a build or in a break). */
    get armed() {
      return Number.isFinite(bar) && (building || bar <= afterBuildUntil || bar <= breakUntil);
    },
    stats,
    reset,
    /**
     * One frame: the beat clock (beats, counting up; not finite without a
     * sure tempo) and the level in dB. Returns 'drop' on the frame a drop
     * is noticed, else null.
     */
    step(beats, levelDb) {
      if (!Number.isFinite(beats)) { if (Number.isFinite(bar)) reset(); return null; }
      if (Number.isFinite(lastBeats) && beats < lastBeats) reset();
      lastBeats = beats;
      const level = Number.isFinite(levelDb) ? Math.max(STRUCTURE_FLOOR_DB, levelDb) : STRUCTURE_FLOOR_DB;
      const now = Math.floor(beats / 4);
      if (!Number.isFinite(bar)) bar = now;
      if (now > bar) {
        closeBar(bar);
        bar = now;
        barSum = 0;
        barCount = 0;
        beatSum = 0;
        beatCount = 0;
        firstBeatJudged = false;
      }
      barSum += level;
      barCount += 1;
      const inBar = beats - now * 4;
      if (inBar < 1) {
        beatSum += level;
        beatCount += 1;
        return null;
      }
      if (firstBeatJudged || !beatCount) return null;
      firstBeatJudged = true;
      const canDrop = (building || bar <= afterBuildUntil || bar <= breakUntil) && bar > quietUntil && filled >= 1;
      if (!canDrop) return null;
      const first = beatSum / beatCount;
      const inBreak = bar <= breakUntil;
      const reference = inBreak ? breakRef : buildTop;
      if (!Number.isFinite(reference)) return null;
      if (first >= reference - DROP_FULL_DB && first >= meanAgo(1) + DROP_JUMP_DB) {
        stats.drops += 1;
        building = false;
        buildAmount = 0;
        afterBuildUntil = -1;
        breakUntil = -1;
        breakRef = Number.NaN;
        quietUntil = bar + DROP_COOLDOWN_BARS;
        return 'drop';
      }
      return null;
    },
  };
}
