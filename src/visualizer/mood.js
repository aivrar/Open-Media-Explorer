/**
 * The music's mood, small first version: calm, steady or energetic, from
 * what the Beat Reactor already hears. It biases the shuffle (calm prefers
 * scenes tagged calm, energetic lively ones) and the strength of the
 * reaction (always inside the flash limiter, which caps depth and rate
 * whatever the strength).
 *
 * The reactor's own level is normalised to the music (a quiet pad and a loud
 * club track both average about 0.5), so it cannot tell calm from busy. The
 * mood therefore comes from how many hits there are and how fast a beat the
 * reactor is sure of, with the smoothed level only as a gate: near silence
 * is calm.
 *
 * Hits: an onset on any of kick, snare and hat starts a hit; onsets on the
 * other channels within MOOD_HIT_MERGE_S belong to the same hit (one drum
 * stroke is broadband and used to count up to three times). A hit with a
 * kick or a snare counts 1, a hat alone MOOD_HAT_WEIGHT: hats on eighths or
 * sixteenths subdivide a beat, they do not make it faster. Counted over the
 * last MOOD_WINDOW_S; the first hit a second is the pulse itself and counts
 * nothing. The tempo term starts at MOOD_TEMPO_FROM bpm:
 *
 *   hits   = min(1, max(0, weighted hits a second - 1) / 4)
 *   tempo  = confidence x clamp((bpm - 80) / 60, 0, 1)
 *   energy = 0.6 x hits + 0.4 x tempo
 *
 * (Before, every channel's onsets counted separately and in full, and the
 * tempo term grew from 0 bpm: a slow 60 bpm beat with hats on the eighths
 * counted 4 to 6 "hits" a second and read energetic.)
 *
 * Hysteresis: calm below 0.30 (left above 0.38), energetic above 0.48 (left
 * below 0.42). The energetic line is set from readings of real stations:
 * two minutes each of ambient, pop, rock, house, trance, drum and bass and
 * metal gave medians of 0.24 for ambient and 0.38 to 0.47 for the rest, so a
 * line of 0.65 was reached by trance alone; 0.48 is the lowest line that
 * still keeps a slow beat with hats on the sixteenths, heard as double time,
 * from reading energetic (0.474). A new mood must hold for MOOD_HOLD_S, and the mood changes at
 * most once every MOOD_MIN_CHANGE_S. It starts steady and decides after
 * MOOD_HOLD_S of sound (`ready` from then on). Only stepped while sound
 * plays. reset() starts it afresh (another station, a resume after a gap):
 * no hit, level or hold from before counts, and every channel is armed
 * again, so the first hit after it is heard.
 */

export const MOODS = Object.freeze(['calm', 'steady', 'energetic']);
export const MOOD_WINDOW_S = 8;
export const MOOD_HOLD_S = 3;
export const MOOD_MIN_CHANGE_S = 10;
export const MOOD_STRENGTH = Object.freeze({ calm: 0.8, steady: 1, energetic: 1.15 });
/** How fast the reaction strength follows the mood (per second). */
export const STRENGTH_SLEW = 0.25;
/** Onsets closer than this (s) on different channels are one hit. */
export const MOOD_HIT_MERGE_S = 0.06;
/** What a hit of hats alone counts. */
export const MOOD_HAT_WEIGHT = 0.5;
/** The tempo from which a beat adds energy (bpm), and the span to full. */
export const MOOD_TEMPO_FROM = 80;
export const MOOD_TEMPO_SPAN = 60;
/** Energy below which the mood turns calm, and above which energetic (from
 *  steady; leaving them takes 0.38 and 0.42). */
export const MOOD_CALM_BELOW = 0.30;
export const MOOD_ENERGETIC_ABOVE = 0.48;
/** Energy below which an energetic mood goes back to steady. */
export const MOOD_ENERGETIC_LEAVE = 0.42;
/** Most hits kept (a ring: nothing allocated per hit). */
const HIT_RING = 256;
const ONSET = 0.3;
const REARM = 0.15;
const QUIET_LEVEL = 0.03;
const CHANNELS = Object.freeze(['kick', 'snare', 'hat']);

/** Energy (0..1) from weighted hits a second, tempo confidence and bpm. */
export function moodEnergy(hitsPerSecond, confidence, bpm) {
  const hits = Math.min(1, Math.max(0, (Number(hitsPerSecond) || 0) - 1) / 4);
  const pace = Math.max(0, Math.min(1, ((Number(bpm) || 0) - MOOD_TEMPO_FROM) / MOOD_TEMPO_SPAN));
  const sure = Math.max(0, Math.min(1, confidence || 0)) * pace;
  return 0.6 * hits + 0.4 * sure;
}

export function createMoodTracker() {
  let mood = 'steady';
  let candidate = 'steady';
  let candidateSince = 0;
  let lastChange = Number.NEGATIVE_INFINITY;
  let heard = 0; // seconds of sound stepped
  let lastNow = Number.NaN;
  let level = 0;
  let energy = 0;
  let rate = 0; // weighted hits a second, as last counted
  let strength = 1;
  // The hits of the last MOOD_WINDOW_S: their times and weights, a ring.
  const hitTimes = new Float64Array(HIT_RING);
  const hitWeights = new Float32Array(HIT_RING);
  let hitStart = 0;
  let hitCount = 0;
  let hitSum = 0;
  const armed = { kick: true, snare: true, hat: true };
  const stats = { changes: 0 };

  function wanted(value) {
    if (level < QUIET_LEVEL) return 'calm';
    if (mood === 'calm') {
      if (value > MOOD_ENERGETIC_ABOVE) return 'energetic';
      return value > 0.38 ? 'steady' : 'calm';
    }
    if (mood === 'energetic') {
      if (value < 0.30) return 'calm';
      return value < MOOD_ENERGETIC_LEAVE ? 'steady' : 'energetic';
    }
    if (value < MOOD_CALM_BELOW) return 'calm';
    if (value > MOOD_ENERGETIC_ABOVE) return 'energetic';
    return 'steady';
  }

  return {
    get mood() { return mood; },
    get energy() { return energy; },
    /** Weighted hits a second over the window, as last counted. */
    get hitsPerSecond() { return rate; },
    get strength() { return strength; },
    /** A reading of its own: MOOD_HOLD_S of sound since it started or was reset. */
    get ready() { return heard >= MOOD_HOLD_S; },
    stats,
    /**
     * One step while sound plays.
     * @param {number} now seconds
     * @param {object} sound  { kick, snare, hat, level } raw reactor values
     *        (0..1), confidence (0..1) and bpm
     */
    step(now, sound) {
      const dt = Number.isFinite(lastNow) && now > lastNow ? Math.min(0.5, now - lastNow) : 0;
      lastNow = now;
      heard += dt;
      for (const name of CHANNELS) {
        const value = Number(sound?.[name]) || 0;
        if (armed[name] && value >= ONSET) {
          armed[name] = false;
          addOnset(now, name === 'hat' ? MOOD_HAT_WEIGHT : 1);
        } else if (value < REARM) armed[name] = true;
      }
      while (hitCount && now - hitTimes[hitStart] > MOOD_WINDOW_S) {
        hitSum -= hitWeights[hitStart];
        hitStart = (hitStart + 1) % HIT_RING;
        hitCount -= 1;
      }
      const follow = dt > 0 ? 1 - Math.exp(-dt / 2) : 0;
      level += ((Number(sound?.level) || 0) - level) * follow;
      const span = Math.min(MOOD_WINDOW_S, Math.max(1, heard));
      rate = Math.max(0, hitSum) / span;
      energy = moodEnergy(rate, sound?.confidence, sound?.bpm);
      const next = wanted(energy);
      if (next !== candidate) { candidate = next; candidateSince = now; }
      if (candidate !== mood && heard >= MOOD_HOLD_S && now - candidateSince >= MOOD_HOLD_S
        && now - lastChange >= MOOD_MIN_CHANGE_S) {
        mood = candidate;
        lastChange = now;
        stats.changes += 1;
      }
      const target = MOOD_STRENGTH[mood];
      const most = STRENGTH_SLEW * dt;
      strength += Math.max(-most, Math.min(most, target - strength));
      return mood;
    },
    reset() {
      mood = 'steady';
      candidate = 'steady';
      candidateSince = 0;
      lastChange = Number.NEGATIVE_INFINITY;
      heard = 0;
      lastNow = Number.NaN;
      level = 0;
      energy = 0;
      rate = 0;
      hitStart = 0;
      hitCount = 0;
      hitSum = 0;
      for (const name of CHANNELS) armed[name] = true;
    },
  };

  /** An onset at `now` worth `weight`: a new hit, or part of the last one
   *  (then the hit is worth the most of its onsets). */
  function addOnset(now, weight) {
    if (hitCount) {
      const last = (hitStart + hitCount - 1) % HIT_RING;
      if (now - hitTimes[last] <= MOOD_HIT_MERGE_S) {
        if (weight > hitWeights[last]) { hitSum += weight - hitWeights[last]; hitWeights[last] = weight; }
        return;
      }
    }
    if (hitCount === HIT_RING) {
      hitSum -= hitWeights[hitStart];
      hitStart = (hitStart + 1) % HIT_RING;
      hitCount -= 1;
    }
    const at = (hitStart + hitCount) % HIT_RING;
    hitTimes[at] = now;
    hitWeights[at] = weight;
    hitSum += weight;
    hitCount += 1;
  }
}
