/**
 * The music's mood, small first version: calm, steady or energetic, from
 * what the Beat Reactor already hears. It biases the shuffle (calm prefers
 * scenes tagged calm, energetic lively ones) and the strength of the
 * reaction (always inside the flash limiter, which caps depth and rate
 * whatever the strength).
 *
 * The reactor's own level is normalised to the music (a quiet pad and a loud
 * club track both average about 0.5), so it cannot tell calm from busy. The
 * mood therefore comes from how many hits there are (kick, snare and hat
 * onsets a second over the last MOOD_WINDOW_S) and how sure the reactor is of
 * a beat (tempo confidence, scaled by the tempo), with the smoothed level only
 * as a gate: near silence is calm.
 *
 *   energy = 0.65 x min(1, onsets a second / 5) + 0.35 x confidence x min(1, bpm / 130)
 *
 * Hysteresis: calm below 0.30 (left above 0.38), energetic above 0.65 (left
 * below 0.57). A new mood must hold for MOOD_HOLD_S, and the mood changes at
 * most once every MOOD_MIN_CHANGE_S. It starts steady and decides after
 * MOOD_HOLD_S of sound. Only stepped while sound plays.
 */

export const MOODS = Object.freeze(['calm', 'steady', 'energetic']);
export const MOOD_WINDOW_S = 8;
export const MOOD_HOLD_S = 3;
export const MOOD_MIN_CHANGE_S = 10;
export const MOOD_STRENGTH = Object.freeze({ calm: 0.8, steady: 1, energetic: 1.15 });
/** How fast the reaction strength follows the mood (per second). */
export const STRENGTH_SLEW = 0.25;
const ONSET = 0.3;
const REARM = 0.15;
const QUIET_LEVEL = 0.03;
const CHANNELS = Object.freeze(['kick', 'snare', 'hat']);

export function moodEnergy(onsetsPerSecond, confidence, bpm) {
  const hits = Math.min(1, Math.max(0, onsetsPerSecond) / 5);
  const sure = Math.max(0, Math.min(1, confidence || 0)) * Math.min(1, Math.max(0, bpm || 0) / 130);
  return 0.65 * hits + 0.35 * sure;
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
  let strength = 1;
  const onsets = [];
  const armed = { kick: true, snare: true, hat: true };
  const stats = { changes: 0 };

  function wanted(value) {
    if (level < QUIET_LEVEL) return 'calm';
    if (mood === 'calm') {
      if (value > 0.65) return 'energetic';
      return value > 0.38 ? 'steady' : 'calm';
    }
    if (mood === 'energetic') {
      if (value < 0.30) return 'calm';
      return value < 0.57 ? 'steady' : 'energetic';
    }
    if (value < 0.30) return 'calm';
    if (value > 0.65) return 'energetic';
    return 'steady';
  }

  return {
    get mood() { return mood; },
    get energy() { return energy; },
    get strength() { return strength; },
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
        if (armed[name] && value >= ONSET) { armed[name] = false; onsets.push(now); }
        else if (value < REARM) armed[name] = true;
      }
      while (onsets.length && now - onsets[0] > MOOD_WINDOW_S) onsets.shift();
      const follow = dt > 0 ? 1 - Math.exp(-dt / 2) : 0;
      level += ((Number(sound?.level) || 0) - level) * follow;
      const span = Math.min(MOOD_WINDOW_S, Math.max(1, heard));
      energy = moodEnergy(onsets.length / span, sound?.confidence, sound?.bpm);
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
      onsets.length = 0;
    },
  };
}
