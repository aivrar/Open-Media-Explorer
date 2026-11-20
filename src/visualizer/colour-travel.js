/**
 * Colour travel (I7), held: a slow turn of the picture's hues in time with
 * the bars, for the scenes whose colours may move. Not wired yet; released
 * with COLOUR_TRAVEL_RELEASED once measured. All numbers PROPOSED.
 *
 * Luminance does not change, by construction. Each pixel's Rec. 709 luma
 *   Y = 0.2126 r + 0.7152 g + 0.0722 b
 * is kept: the colour is split into Y on the grey axis and a chroma part
 * d = c - Y (whose luma is 0, since the weights add to 1); d is turned about
 * the luma weights' direction n (Rodrigues; n . d = 0, so the turned d stays
 * in the luma-0 plane) and, where the turn would leave the 0..1 cube, shrunk
 * toward grey just enough to fit (a scale of d keeps luma 0). So every
 * pixel's luma, and the frame's mean, is the same before and after, and greys
 * stay grey. (The effect library's hueRot turns about the grey axis instead,
 * which keeps the mean of r, g and b but not luma: pure green turned a third
 * of the way round becomes blue at a tenth of its luma. It is not used.)
 *
 * Rate: the angle follows the drift clock's bars (drift.js: smooth, never
 * faster than DRIFT_BPM_RANGE's top), one full turn every
 * COLOUR_TRAVEL_BARS_PER_TURN bars; at 150 bpm that is 3.5 degrees a
 * second. The clock's wrap is followed through (no jump).
 *
 * Which scenes: colourTravelAllowed(entry). Not the scenes whose colour
 * cycling is held or whose colours were left out by measurement (looks.js
 * LOOK_ADJUSTED, LOOKS_LEFT_OUT, PRESETS_LEFT_OUT), not those drawn without
 * post effects (fxNone: the line scenes, the simulations kept plain), and
 * not the held ones.
 *
 * Wiring (next step, held): one pass at the end of the effects chain
 * (fx-chain.js), so with no effects on it would make the chain's framebuffer
 * that bypass otherwise avoids: a CPU and GPU cost to measure. The pass
 * reads u_travel (the angle) and does nothing at 0.
 */

import { LOOK_ADJUSTED, LOOKS_LEFT_OUT, PRESETS_LEFT_OUT } from './looks.js';
import { HELD_SCENES } from './scenes.js';

export const COLOUR_TRAVEL_RELEASED = false;
/** Bars for one full turn of the hues (PROPOSED). */
export const COLOUR_TRAVEL_BARS_PER_TURN = 64;
/** The most of a turn it may be away from the scene's own colours (a full
 *  turn: every hue visited; PROPOSED). */
export const COLOUR_TRAVEL_SPAN = 1;
export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

/** The same turn in GLSL (for the pass). */
export const COLOUR_TRAVEL_GLSL = `
vec3 colourTravel(vec3 c, float angle) {
    vec3 w = vec3(0.2126, 0.7152, 0.0722);
    float y = dot(c, w);
    vec3 d = c - vec3(y);
    vec3 n = normalize(w);
    vec3 t = d * cos(angle) + cross(n, d) * sin(angle);
    float s = 1.0;
    for (int i = 0; i < 3; i++) {
        float ti = i == 0 ? t.x : (i == 1 ? t.y : t.z);
        if (ti > 1e-6) s = min(s, (1.0 - y) / ti);
        else if (ti < -1e-6) s = min(s, y / -ti);
    }
    return vec3(y) + t * max(s, 0.0);
}
`;

const NORM = Math.hypot(...LUMA);
const N = LUMA.map((v) => v / NORM);

/** The turn on the CPU, as the shader does it: [r, g, b] (0..1) turned by
 *  `angle` (radians), luma kept. Into `out` when given. */
export function colourTravel(c, angle, out = [0, 0, 0]) {
  const y = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
  const d0 = c[0] - y;
  const d1 = c[1] - y;
  const d2 = c[2] - y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // n x d
  const x0 = N[1] * d2 - N[2] * d1;
  const x1 = N[2] * d0 - N[0] * d2;
  const x2 = N[0] * d1 - N[1] * d0;
  const t = [d0 * cos + x0 * sin, d1 * cos + x1 * sin, d2 * cos + x2 * sin];
  let s = 1;
  for (const ti of t) {
    if (ti > 1e-6) s = Math.min(s, (1 - y) / ti);
    else if (ti < -1e-6) s = Math.min(s, y / -ti);
  }
  s = Math.max(0, s);
  out[0] = y + t[0] * s;
  out[1] = y + t[1] * s;
  out[2] = y + t[2] * s;
  return out;
}

/** Whether scene `entry` (scenes.js shape) may travel. */
export function colourTravelAllowed(entry) {
  if (!entry?.id) return false;
  const id = entry.id;
  if (entry.fxNone) return false;
  if (Object.hasOwn(HELD_SCENES, id)) return false;
  if (Object.hasOwn(LOOK_ADJUSTED, id) || Object.hasOwn(LOOKS_LEFT_OUT, id) || Object.hasOwn(PRESETS_LEFT_OUT, id)) return false;
  return true;
}

/** The angle from the drift clock's bars: step(bars) each drawn frame
 *  returns the angle (radians); a wrap of the clock is followed through. */
export function createColourTravel({ barsPerTurn = COLOUR_TRAVEL_BARS_PER_TURN, wrapBars = 32 } = {}) {
  let lastBars = Number.NaN;
  let turns = 0;
  return {
    get angle() { return 2 * Math.PI * COLOUR_TRAVEL_SPAN * (turns % 1); },
    step(bars) {
      if (!Number.isFinite(bars)) return this.angle;
      if (Number.isFinite(lastBars)) {
        let delta = bars - lastBars;
        if (delta < -wrapBars / 2) delta += wrapBars; // the clock wrapped
        if (delta > 0 && delta < wrapBars / 2) turns = (turns + delta / barsPerTurn) % 1;
      }
      lastBars = bars;
      return this.angle;
    },
    reset() { lastBars = Number.NaN; turns = 0; },
  };
}
