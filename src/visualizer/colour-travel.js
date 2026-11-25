/**
 * Turn chroma around the luminance axis in linear light and scale it
 * toward grey to fit the RGB gamut before encoding back to sRGB.
 * A gentle hue sweep follows the drift clock while music has a clear tempo.
 */

import { LOOK_ADJUSTED, LOOKS_LEFT_OUT, PRESETS_LEFT_OUT } from './looks.js';
import { DRIFT_WRAP_BARS } from './drift.js';
import { HELD_SCENES } from './scenes.js';

export const COLOUR_TRAVEL_RELEASED = true;
/** Bars for one full sweep of the hues. */
export const COLOUR_TRAVEL_BARS_PER_TURN = 64;
/** Maximum hue displacement in radians (about 20 degrees). */
export const COLOUR_TRAVEL_SPAN = 0.35;
export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

/** The same turn in GLSL (for the pass). */
export const COLOUR_TRAVEL_GLSL = `
vec3 colourTravel(vec3 c, float angle) {
    c = clamp(c, 0.0, 1.0);
    vec3 linear = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    vec3 w = vec3(0.2126, 0.7152, 0.0722);
    float y = dot(linear, w);
    vec3 d = linear - vec3(y);
    vec3 n = normalize(w);
    vec3 t = d * cos(angle) + cross(n, d) * sin(angle);
    float s = 1.0;
    for (int i = 0; i < 3; i++) {
        float ti = i == 0 ? t.x : (i == 1 ? t.y : t.z);
        if (ti > 1e-6) s = min(s, (1.0 - y) / ti);
        else if (ti < -1e-6) s = min(s, y / -ti);
    }
    linear = clamp(vec3(y) + t * max(s, 0.0), 0.0, 1.0);
    return mix(12.92 * linear, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), linear));
}
`;

const NORM = Math.hypot(...LUMA);
const N = LUMA.map((v) => v / NORM);

function fromSrgb(value) {
  const c = Math.max(0, Math.min(1, value));
  return c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function toSrgb(value) {
  const c = Math.max(0, Math.min(1, value));
  return c < 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** The turn on the CPU, as the shader does it: sRGB (0..1) turned by
 *  `angle` (radians), luminance kept. Into `out` when given. */
export function colourTravel(c, angle, out = [0, 0, 0]) {
  const r = fromSrgb(c[0]);
  const g = fromSrgb(c[1]);
  const b = fromSrgb(c[2]);
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const d0 = r - y;
  const d1 = g - y;
  const d2 = b - y;
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
  out[0] = toSrgb(y + t[0] * s);
  out[1] = toSrgb(y + t[1] * s);
  out[2] = toSrgb(y + t[2] * s);
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
export function createColourTravel({ barsPerTurn = COLOUR_TRAVEL_BARS_PER_TURN, wrapBars = DRIFT_WRAP_BARS } = {}) {
  let lastBars = Number.NaN;
  let turns = 0;
  return {
    get angle() { return COLOUR_TRAVEL_SPAN * Math.sin(2 * Math.PI * turns); },
    step(bars, playing = true) {
      if (!Number.isFinite(bars)) return this.angle;
      if (playing && Number.isFinite(lastBars)) {
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
