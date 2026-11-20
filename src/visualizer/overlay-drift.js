/**
 * Held: overlay value drift. A few of an overlay's settings wander slowly
 * around the value chosen, on the drift clock (drift.js: smooth, tempo
 * folded into DRIFT_BPM_RANGE, the swell setting the depth), inside the
 * range the shuffle draws them from. Released with
 * OVERLAY_VALUE_DRIFT_RELEASED once measured; numbers PROPOSED.
 *
 * Which settings: only sizes and spreads (OVERLAY_DRIFT_PARAMS), chosen by
 * hand. Never a speed or rate (the overlays turn time into motion by
 * multiplying it: a changing rate jumps the picture), a count (shapes would
 * come and go), a style, colour, sync, opacity or strength (light), a
 * setting with a quality limit (OVERLAY_QUALITY_LIMITS), or anything of an
 * overlay that fires on hits apart from Fireworks' burst size.
 *
 * How far: OVERLAY_DRIFT_DEPTH of the range's span (drift.js's waves, the
 * fastest at half that), times the drift depth scale (drift.js driftScale:
 * up to 1.4 x 1.15). Its waves' periods and phases come from the overlay's
 * id and the setting's name, as the effects' do.
 */

import { DRIFT_DEPTH, fxDriftPlan } from './drift.js';
import { HELD_OVERLAY_ROWS, OVERLAY_QUALITY_LIMITS, overlayRow } from './overlay-catalog.js';

export const OVERLAY_VALUE_DRIFT_RELEASED = false;
/** Share of the range's span (PROPOSED; the effects' drift uses 0.1). */
export const OVERLAY_DRIFT_DEPTH = 0.06;
export const OVERLAY_DRIFT_PARAMS = Object.freeze({
  petals: Object.freeze(['size']),
  ribbons: Object.freeze(['size']),
  dot_spiral: Object.freeze(['size']),
  starburst: Object.freeze(['size']),
  harmonograph: Object.freeze(['size']),
  ripples: Object.freeze(['size']),
  fireflies: Object.freeze(['size']),
  orbits: Object.freeze(['size']),
  figures: Object.freeze(['figure_size']),
  sacred: Object.freeze(['sg_size']),
  plexus: Object.freeze(['px_distance']),
  spectrum: Object.freeze(['spectrum_height']),
  fireworks: Object.freeze(['fw_size']),
});

const rowOf = (id) => overlayRow(id) || HELD_OVERLAY_ROWS[id] || null;
const plans = new Map();

/** The waves for overlay `id` (made once and kept): [] for none. The
 *  depth in each is drift.js's; overlayDriftScale turns it into ours. */
export function overlayDriftPlan(id) {
  if (plans.has(id)) return plans.get(id);
  const row = rowOf(id);
  const names = (OVERLAY_DRIFT_PARAMS[id] || []).filter((name) => {
    const range = row?.ranges?.[name];
    return Array.isArray(range) && range[2] !== 'int' && range[1] > range[0]
      && !Object.prototype.hasOwnProperty.call(OVERLAY_QUALITY_LIMITS[id] || {}, name)
      && !Object.prototype.hasOwnProperty.call(row.pins || {}, name);
  });
  const plan = Object.freeze(fxDriftPlan({ id: `overlay:${id}` }, names, (name) => row.ranges[name]).map(Object.freeze));
  plans.set(id, plan);
  return plan;
}

/** The scale applyDrift takes for drift depth scale `scale`: our depth in
 *  place of drift.js's. */
export function overlayDriftScale(scale) {
  return scale > 0 ? (scale * OVERLAY_DRIFT_DEPTH) / DRIFT_DEPTH : 0;
}
