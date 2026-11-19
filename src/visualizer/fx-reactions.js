/**
 * Global reactions: Psychedelia's Beat Reactor "global" pass (rotation kick,
 * RGB split, colour pump, hue drift, flash; engine/audio-reactor.js
 * computeOutputs and post-process.js's audio pass), made here from the
 * flash limiter's output instead of the reactor's raw envelopes, so every
 * one of them pulses no more often than the limiter lets a hit through (3 a
 * second, shared with everything else).
 *
 * Differences from Psychedelia:
 *   - The styles are its Subtle, Club and Psychedelic amounts, one per FX
 *     intensity. Its Wild style (flash up to 45% brighter, shake) is not
 *     offered.
 *   - Zoom stays the scene's own view zoom (the limiter's zoom punch) and the
 *     time surge the limiter's speed: not applied twice here.
 *   - Flash is off unless the `visualizerFxFlash` setting is on. On, it is
 *     at most GLOBAL_FLASH_MAX (the pass makes that about 11% brighter), and
 *     only from kick or snare hits the limiter let through: a held hit gives
 *     at most a quarter of it.
 *   - The pump's brightness share is capped (GLOBAL_PUMP_MAX: 4.5% brighter
 *     at most); its colour share is what moves.
 *   - The hue drifts with the bass only (no jump on each kick).
 *   - No shake.
 *   - Flash and pump change light, so neither may jump: each moves by at
 *     most FLASH_SLEW / PUMP_SLEW a second, up or down (the flash takes
 *     0.3 s to reach its most), whatever the hit does. The FX flash check
 *     found a one-frame flash on top of a scene's own motion made steps of
 *     0.135.
 * They are drawn only as the last pass of the FX chain, so with no FX on
 * they cost nothing (fx-chain.js).
 */

import { FLASH_LIMITS } from './flash-limiter.js';

export const GLOBAL_FLASH_MAX = 0.12;
export const GLOBAL_PUMP_MAX = 0.3;
/** The most flash and pump move in a second, up or down. */
export const FLASH_SLEW = 0.4;
export const PUMP_SLEW = 1.2;

/** Per FX intensity: Psychedelia's Subtle, Club and Psychedelic amounts. */
export const REACTION_STYLES = Object.freeze({
  subtle: Object.freeze({
    rotate: 0, hue: 0, chroma: 0.1, pump: 0.15,
  }),
  normal: Object.freeze({
    rotate: 0, hue: 0, chroma: 0.2, pump: 0.25,
  }),
  strong: Object.freeze({
    rotate: 0.4, hue: 0.6, chroma: 0.45, pump: 0.5,
  }),
});

const clamp01 = (value) => (value > 1 ? 1 : (value > 0 ? value : 0));

export function createGlobalReactions({ limits = FLASH_LIMITS } = {}) {
  const values = {
    rot: 0, hue: 0, chroma: 0, pump: 0, flash: 0, shakeX: 0, shakeY: 0,
  };
  let rotDir = 1;
  let kickHigh = false;
  const stats = { flashes: 0 };
  const depth = limits.maxPulseDepth;
  const floor = limits.rearmLevel;

  /** Move `from` toward `to` by at most `rate` * `dt`. */
  const slew = (from, to, rate, dt) => {
    const most = rate * dt;
    return to > from + most ? from + most : (to < from - most ? from - most : to);
  };

  /** One frame from the limiter's output (`sources`), the intensity's style,
   *  whether flash is allowed, and the time since the last frame (s; at most
   *  0.1). Returns the one values object. */
  function step(sources, intensity, flashOn, dt = 1 / 30) {
    const seconds = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
    const style = REACTION_STYLES[intensity] || REACTION_STYLES.normal;
    const kick = clamp01(sources?.kick);
    const snare = clamp01(sources?.snare);
    const bass = clamp01(sources?.bass);
    const k = clamp01(kick / depth);
    const punch = k * k * (3 - 2 * k);
    // Each let-through kick turns the other way (as Psychedelia's rotDir).
    const high = kick >= limits.pulseThreshold;
    if (high && !kickHigh) rotDir = -rotDir;
    kickHigh = high;
    values.rot = style.rotate * 0.06 * punch * rotDir;
    values.hue = style.hue * 0.05 * bass;
    values.chroma = style.chroma * (0.012 * snare + 0.004 * clamp01(sources?.hat));
    values.pump = slew(values.pump, Math.min(GLOBAL_PUMP_MAX, style.pump * (0.6 * bass + 0.4 * punch)), PUMP_SLEW, seconds);
    let flash = 0;
    if (flashOn) {
      const hit = Math.max(kick, snare);
      flash = GLOBAL_FLASH_MAX * clamp01((hit - floor) / (depth - floor));
    }
    flash = slew(values.flash, flash, FLASH_SLEW, seconds);
    if (flash > 0.5 * GLOBAL_FLASH_MAX && values.flash <= 0.5 * GLOBAL_FLASH_MAX) stats.flashes += 1;
    values.flash = flash;
    return values;
  }

  function reset() {
    for (const key of Object.keys(values)) values[key] = 0;
    rotDir = 1;
    kickHigh = false;
  }

  return {
    step, reset, values, stats,
  };
}
