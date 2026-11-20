/**
 * The overlay sheets' slow motion: a slow turn, a breathing scale and a
 * small sway, each a sine of the drift clock (drift.js: bars, locked to the
 * music's tempo), its depth the drift's (the swell and mood scale, faded with
 * the "Slow drift" setting: at 0 nothing moves). The SHEET moves, not its
 * drawing: the top sheet by a CSS transform (the compositor's; nothing is
 * drawn again), the blend sheet by its texture coordinates in its own pass
 * (fx-chain.js). Light is moved around, never added.
 *
 *   Turn     OVERLAY_TURN_DEG each way at a depth of 1, over 32 bars
 *   Breath   up to OVERLAY_BREATH larger at a depth of 1, over 16 bars
 *   Sway     OVERLAY_SWAY of the picture each way at a depth of 1, over 8
 *            bars across and 16 down (a slow ellipse)
 *
 * Offsets come from fixed names (idSeed), as drift's do: the same phases
 * every time. The sheet always covers the picture: it is scaled up by what
 * the turn and the sway need (coverScale, from the picture's shape), and the
 * breath only ever enlarges it further. At the deepest drift (about 1.6:
 * a turn of 1.9 degrees each way) that is at most 10 % on a 16:9 picture
 * (12 % on 21:9; OVERLAY_MOTION_MOST): the top sheet is already stretched by
 * the browser (it is drawn at most 500 000 pixels on Medium), so its lines
 * lose about a tenth of their sharpness at that moment and next to none when
 * the motion is small; a tenth of the sheet's edge is off the picture then.
 *
 * Measured at its deepest with the drift clock at 150 (a whole 32-bar
 * cycle), Bokeh, Tron Hex Grid and Lasers on top and blended with Screen on
 * the overlay check scenes: the largest step at most 0.006 above the same
 * run held still (Bokeh on Starfield), never over the scene's own on Plasma.
 *
 * Overlays drawn against the screen's edges or its horizontal lines are
 * anchored (overlay-catalog.js `anchored`): a sheet holding one does not move.
 */

import { idSeed } from './drift.js';
import { seededRandom } from './shuffle.js';

export const OVERLAY_TURN_DEG = 1.2;
export const OVERLAY_BREATH = 0.015;
export const OVERLAY_SWAY = 0.006;
/** The waves' periods in bars: turn, breath, sway across, sway down. */
export const OVERLAY_MOTION_PERIODS = Object.freeze({
  turn: 32, breath: 16, swayX: 8, swayY: 16,
});
/** Below this depth the sheet is held still (the transform removed). */
export const OVERLAY_MOTION_EPSILON = 1e-4;

const TAU = Math.PI * 2;
const OFFSETS = Object.freeze(Object.fromEntries(
  Object.keys(OVERLAY_MOTION_PERIODS).map((name) => [name, seededRandom(idSeed(`overlay:${name}`))()]),
));
// The same, as plain numbers (read every frame: no lookups by name).
const TURN_PERIOD = OVERLAY_MOTION_PERIODS.turn;
const BREATH_PERIOD = OVERLAY_MOTION_PERIODS.breath;
const SWAYX_PERIOD = OVERLAY_MOTION_PERIODS.swayX;
const SWAYY_PERIOD = OVERLAY_MOTION_PERIODS.swayY;
const TURN_OFFSET = OFFSETS.turn;
const BREATH_OFFSET = OFFSETS.breath;
const SWAYX_OFFSET = OFFSETS.swayX;
const SWAYY_OFFSET = OFFSETS.swayY;
const TURN_RAD = (OVERLAY_TURN_DEG * Math.PI) / 180;

/** How far (in shares of the sheet's half size) the picture's corner
 *  (cx, cy) reaches in the sheet's frame: one corner of coverScale. */
function cornerReach(cx, cy, dx, dy, a, c, s) {
  const px = (cx - dx) * a;
  const py = cy - dy;
  const x = Math.abs(c * px + s * py) / (a / 2);
  const y = Math.abs(-s * px + c * py) / 0.5;
  return x > y ? x : y;
}

/** The scale at which a sheet the picture's shape (`aspect`: width / height),
 *  turned by `angle` (radians) and moved by (dx, dy) (shares of the picture's
 *  width and height), still covers the whole picture: every corner of the
 *  picture, taken back into the sheet's frame, inside it. 1 when nothing
 *  moves. */
export function coverScale(angle, dx, dy, aspect) {
  const a = aspect > 0 ? aspect : 1;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Each corner relative to the sheet's centre (in picture heights), turned
  // back by the sheet's angle. Plain numbers: nothing allocated.
  return Math.max(
    1,
    cornerReach(-0.5, -0.5, dx, dy, a, c, s),
    cornerReach(0.5, -0.5, dx, dy, a, c, s),
    cornerReach(-0.5, 0.5, dx, dy, a, c, s),
    cornerReach(0.5, 0.5, dx, dy, a, c, s),
  );
}

/**
 * The motion at drift clock `bars` and depth `depth` (drift's scale: 0 is
 * none), for a picture of shape `aspect`, into `out` ({ angle (radians),
 * scale, dx, dy (shares of the picture), moving }). Allocates nothing.
 */
export function overlayMotion(bars, depth, aspect, out = {}) {
  const d = depth > 0 && Number.isFinite(depth) ? depth : 0;
  if (!(d > OVERLAY_MOTION_EPSILON)) {
    out.angle = 0; out.scale = 1; out.dx = 0; out.dy = 0; out.moving = false;
    return out;
  }
  const b = Number.isFinite(bars) ? bars : 0;
  out.angle = TURN_RAD * d * Math.sin(TAU * (b / TURN_PERIOD + TURN_OFFSET));
  out.dx = OVERLAY_SWAY * d * Math.sin(TAU * (b / SWAYX_PERIOD + SWAYX_OFFSET));
  out.dy = OVERLAY_SWAY * d * Math.sin(TAU * (b / SWAYY_PERIOD + SWAYY_OFFSET));
  // Breath: 1 to 1 + OVERLAY_BREATH x depth, on top of the cover.
  const breath = 1 + OVERLAY_BREATH * d * (0.5 + 0.5 * Math.sin(TAU * (b / BREATH_PERIOD + BREATH_OFFSET)));
  out.scale = coverScale(out.angle, out.dx, out.dy, aspect) * breath;
  out.moving = true;
  return out;
}

/** How little of a change the top sheet's transform ignores (it is written
 *  again only when it has moved by more): a quarter of a pixel at the
 *  sheet's edge, a hundredth of a degree. */
export const OVERLAY_MOTION_QUANTUM = Object.freeze({ px: 0.25, deg: 0.01 });

/** `motion` rounded to what can be seen on a picture `w` x `h` pixels
 *  (OVERLAY_MOTION_QUANTUM), into `out` ({ tx, ty (percent), deg, scale });
 *  nothing allocated. Two motions that round alike look alike. */
export function quantiseMotion(motion, w, h, out) {
  const W = w > 0 ? w : 1;
  const H = h > 0 ? h : 1;
  const qx = (OVERLAY_MOTION_QUANTUM.px / W) * 100;
  const qy = (OVERLAY_MOTION_QUANTUM.px / H) * 100;
  const qs = OVERLAY_MOTION_QUANTUM.px / (Math.max(W, H) / 2);
  out.tx = Math.round((motion.dx * 100) / qx) * qx;
  out.ty = Math.round((motion.dy * 100) / qy) * qy;
  out.deg = Math.round((motion.angle * 180) / Math.PI / OVERLAY_MOTION_QUANTUM.deg) * OVERLAY_MOTION_QUANTUM.deg;
  // Up, and one step more: the rounding of the rest (at most a fifth of a
  // pixel at a corner) never shows an edge.
  out.scale = (Math.ceil(motion.scale / qs) + 1) * qs;
  return out;
}

/** The CSS transform for `motion` (centre origin, as CSS has it), or ''. */
export function motionCss(motion) {
  if (!motion?.moving) return '';
  return `translate(${(motion.dx * 100).toFixed(3)}%,${(motion.dy * 100).toFixed(3)}%) rotate(${(motion.angle * 180 / Math.PI).toFixed(4)}deg) scale(${motion.scale.toFixed(5)})`;
}

/** The blend pass's texture mapping for `motion` on a picture of shape
 *  `aspect`, the same as the top sheet's CSS transform: for a point q of the
 *  picture (from its centre, shares of its width and height, y down as on
 *  the screen) the sheet's point is m x (q - off), m = [m0 m1; m2 m3] row by
 *  row (from the sheet's centre, y down as its rows). Into `out` ({ m: [4],
 *  off: [2] }), or null when it does not move. */
export function motionUv(motion, aspect, out = { m: [1, 0, 0, 1], off: [0, 0] }) {
  if (!motion?.moving) return null;
  const a = aspect > 0 ? aspect : 1;
  // CSS turns by +angle (y down) and scales about the centre; taken back:
  // turned by -angle in pixels, divided by the scale.
  const c = Math.cos(motion.angle) / motion.scale;
  const s = Math.sin(motion.angle) / motion.scale;
  out.m[0] = c; out.m[1] = s / a;
  out.m[2] = -s * a; out.m[3] = c;
  out.off[0] = motion.dx;
  out.off[1] = motion.dy;
  return out;
}

/** Where the sheet's point is for picture point (qx, qy) (from the centre,
 *  shares, y down) under `uv` (motionUv), into `out` [x, y]: for the tests
 *  and the checks, as the blend pass computes it. */
export function sheetPoint(uv, qx, qy, out = [0, 0]) {
  if (!uv) { out[0] = qx; out[1] = qy; return out; }
  const x = qx - uv.off[0];
  const y = qy - uv.off[1];
  out[0] = uv.m[0] * x + uv.m[1] * y;
  out[1] = uv.m[2] * x + uv.m[3] * y;
  return out;
}

/** The most the sheet is enlarged on a 16:9 picture over a whole cycle at
 *  the drift check's depth (the tests hold it to this). */
export const OVERLAY_MOTION_MOST = 0.105;
