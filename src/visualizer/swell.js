/**
 * The swell: a slow envelope of the music, made from the flash limiter's
 * OUTPUT level and bass (flash-limiter.js), low-passed with a time constant
 * of SWELL_UP_S rising and SWELL_DOWN_S falling. It is slower and smaller
 * than anything the limiter already lets through, so it adds no pulse.
 * Links may read it (reactor.js sources `swell` and `bassSwell`), and it
 * scales the slow drift's depth (drift.js driftScale). Silence lets it fall
 * to 0. Stepped with the reactor; nothing allocated per step.
 */

export const SWELL_UP_S = 2;
export const SWELL_DOWN_S = 3;

const clamp01 = (value) => (value > 1 ? 1 : (value > 0 ? value : 0)); // NaN -> 0

export function createSwell() {
  let level = 0;
  let bass = 0;
  const follow = (value, target, dt) => value + (target - value) * (1 - Math.exp(-dt / (target > value ? SWELL_UP_S : SWELL_DOWN_S)));
  return {
    /** One step of `dt` seconds from the limiter's output `out`. */
    step(dt, out) {
      if (!(dt > 0)) return;
      level = follow(level, clamp01(out?.level), dt);
      bass = follow(bass, clamp01(out?.bass), dt);
    },
    get level() { return level; },
    get bass() { return bass; },
    reset() { level = 0; bass = 0; },
  };
}
