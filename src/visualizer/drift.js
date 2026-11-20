/**
 * Slow drift: between shuffles a few settings of the scene and of each
 * effect drawn wander slowly around their base value, on long sine waves
 * locked to the music's bars, and a slow swell of the music sets how far.
 * It moves shape, size and colour mixes, never light (the link rule), and
 * costs a few sines a frame.
 *
 *   Drift clock   a phase in bars that only ever moves on smoothly: the tempo
 *                 (the reactor's when it is sure of one, else IDLE_BPM) is
 *                 integrated over each drawn frame's time step, 4 beats to a
 *                 bar. A tempo above DRIFT_BPM_RANGE is followed at half
 *                 (again until inside), one below at double, so a fast track
 *                 never drifts faster than the flash check measured; the
 *                 fold is kept until the tempo leaves the range again or
 *                 unfolding lands well inside it (DRIFT_BPM_RETURN). A new
 *                 tempo changes its pace only, eased over about 2 s
 *                 (DRIFT_PACE_EASE_S); a new station or a pause neither resets
 *                 nor skips it. Not the reactor's beat clock, which is
 *                 phase-corrected and can jump.
 *   Waves         param = base + depth x scale x span x sin(2 pi (bars /
 *                 period + offset)), the base first brought inside the
 *                 param's range and the result held inside it (the bounds
 *                 its links clamp to). period is one of DRIFT_PERIODS bars, a
 *                 different one for each param of a scene, so the whole does
 *                 not repeat soon; the fastest at DRIFT_FAST_SHARE of the
 *                 depth (a small wobble; the slow waves carry the big moves).
 *                 Everything about a wave, its offset too, comes from the
 *                 scene's or effect's id and the param's name: the app shows
 *                 exactly the phases the flash check measured, and one full
 *                 cycle of DRIFT_WRAP_BARS covers them all.
 *   Scenes        up to DRIFT_SCENE_MAX params that pass the link rule
 *                 (reactor.js linkRuleViolation) and are plain floats, chosen
 *                 per scene from its id (the same ones each visit). Not the
 *                 beat reaction's strength, a camera's place or view, a hue,
 *                 a fractal's power (between whole numbers its cut sweeps
 *                 across the picture), or a scene's detail settings
 *                 (DRIFT_AVOID, scenes.js SCENE_QUALITY_CAPS).
 *                 scenes.js SCENE_DRIFT may switch a scene's drift off, leave
 *                 params out, lower its depth or name its own params (ints
 *                 too, where its shader takes them as a continuous number).
 *                 The links push on top of the drifted base.
 *   Effects       up to DRIFT_FX_MAX of the params fx-catalog.js marks
 *                 linkable (and the link rule allows), inside the range the
 *                 shuffle draws them from; a link pushes on top.
 *   Swell         the limiter's output level and bass, low-passed (about 2 s
 *                 up, 3 s down): slower and smaller than anything the limiter
 *                 already lets through. It scales the depth (a quiet passage
 *                 about DRIFT_SCALE_QUIET, a loud one DRIFT_SCALE_LOUD, silence
 *                 the quiet end), with the mood's reaction strength; links
 *                 may also read it (sources `swell` and `bassSwell`).
 *
 * No timers and nothing allocated per frame: the plans are made when a scene
 * is installed or the effects change, and applyDrift writes into a values
 * object made with them.
 */

import { IDLE_BPM, linkRuleViolation } from './reactor.js';
import { seededRandom } from './shuffle.js';

export { SWELL_DOWN_S, SWELL_UP_S, createSwell } from './swell.js';

/** Wave periods, in bars. */
export const DRIFT_PERIODS = Object.freeze([4, 8, 16, 32]);
/** The phase wraps here (every period divides it, so the waves never jump). */
export const DRIFT_WRAP_BARS = 32;
/** The fastest period's share of the depth. */
export const DRIFT_FAST_SHARE = 0.5;
export const DRIFT_SCENE_MAX = 3;
export const DRIFT_FX_MAX = 2;
/** A param's swing each way at a scale of 1, as a share of its range. */
export const DRIFT_DEPTH = 0.1;
/** How long the clock takes to settle on a new tempo (to 95%), and how long
 *  drift takes to come in or go out when switched on or off. */
export const DRIFT_PACE_EASE_S = 2;
export const DRIFT_FADE_S = 2;
/** Tempos the clock follows as they are; above, it follows half (again
 *  until inside), below, double. The flash check runs it at the top. */
export const DRIFT_BPM_RANGE = Object.freeze([60, 150]);
/** A folded tempo is followed as heard again (an octave back) only when
 *  that lands above the first or below the second of these, well inside
 *  DRIFT_BPM_RANGE, so an estimate hovering at an edge does not swing the
 *  pace between two octaves. */
export const DRIFT_BPM_RETURN = Object.freeze([66, 135]);
/** The depth scale from the swell: DRIFT_SCALE_QUIET at a swell of
 *  SWELL_QUIET or less (silence too), DRIFT_SCALE_LOUD at SWELL_LOUD or
 *  more, in a straight line between. The reactor's level is normalised to
 *  the music (it averages about 0.5 on any track), so these mark a passage
 *  quieter or louder than the track around it. */
export const SWELL_QUIET = 0.25;
export const SWELL_LOUD = 0.75;
export const DRIFT_SCALE_QUIET = 0.6;
export const DRIFT_SCALE_LOUD = 1.4;

/** Params never drifted by the automatic choice: the beat reaction's
 *  strength (how hard the scene's own shader flashes on the beat), a
 *  camera's place and view (a 3D camera brought nearer a surface may end up
 *  in it), hues (colour travel is a separate feature), a fractal's power or
 *  exponent (between whole numbers its cut sweeps across the picture),
 *  escape radius and detail settings (the picture changes in steps or costs
 *  more). */
export const DRIFT_AVOID = /(^|_)(audio_react|react|altitude|cam_height|distance|orbit_radius|fov|roll|bank|sway|look_down|latitude|inclination|hue|hue_shift|power|exponent|bailout|quality)(_|$)/;

const TAU = Math.PI * 2;
const clamp01 = (value) => (value > 1 ? 1 : (value > 0 ? value : 0)); // NaN -> 0

/** A number from a string (FNV-1a), for seeding by id. */
export function idSeed(id) {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

/** `list` shuffled by `random` (a copy). */
function shuffled(list, random) {
  const out = list.slice();
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const kept = out[index];
    out[index] = out[other];
    out[other] = kept;
  }
  return out;
}

/** Why scene param `param` of `def` is not drifted by the automatic choice
 *  (null: it may be). `capped`: names with a quality cap (scenes.js). */
export function sceneDriftViolation(def, param, capped = null) {
  const rule = linkRuleViolation(def, param);
  if (rule) return rule;
  if (param.type && param.type !== 'float') return 'not a plain float';
  if (DRIFT_AVOID.test(param.name)) return 'kept still (beat reaction, camera, hue or detail)';
  if (capped && capped.includes(param.name)) return 'a detail setting';
  return null;
}

/** One planned wave for param `name` of `owner` (a scene's or effect's
 *  id): the fastest period at DRIFT_FAST_SHARE of the depth; the offset
 *  from the owner and the param. */
function wave(owner, name, lo, hi, depth, period) {
  return {
    name,
    lo,
    hi,
    span: hi - lo,
    depth: period === DRIFT_PERIODS[0] ? depth * DRIFT_FAST_SHARE : depth,
    period,
    offset: seededRandom(idSeed(`${owner}:${name}`))(),
  };
}

/**
 * The params of scene `def` that drift, with their waves: [{ name, lo, hi,
 * span, depth, period, offset }], or [] for none.
 * @param {object} def     the registered scene (params, shader, specialize)
 * @param {object} [options]
 *   override  scenes.js SCENE_DRIFT row: false (none), or { depth, exclude:
 *             [names], params: { name: depth | true } (these instead of the
 *             automatic choice) }
 *   capped    names with a quality cap (never drifted automatically)
 */
export function sceneDriftPlan(def, { override = undefined, capped = null } = {}) {
  if (!def?.name || override === false) return [];
  const params = new Map((def.params || []).map((param) => [param?.name, param]));
  const depth = Number.isFinite(override?.depth) ? override.depth : DRIFT_DEPTH;
  const exclude = Array.isArray(override?.exclude) ? override.exclude : [];
  const picker = seededRandom(idSeed(def.name));
  let chosen;
  if (override?.params) {
    // A curated list: each must still pass the link rule (ints allowed).
    chosen = Object.entries(override.params)
      .filter(([name]) => params.has(name) && !linkRuleViolation(def, params.get(name)))
      .map(([name, own]) => [name, Number.isFinite(own) ? own : depth]);
  } else {
    const candidates = (def.params || [])
      .filter((param) => param?.name && !exclude.includes(param.name) && !sceneDriftViolation(def, param, capped))
      .map((param) => param.name);
    chosen = shuffled(candidates, picker).slice(0, DRIFT_SCENE_MAX).map((name) => [name, depth]);
  }
  const periods = shuffled(DRIFT_PERIODS, picker);
  return chosen.slice(0, DRIFT_SCENE_MAX).map(([name, own], index) => {
    const param = params.get(name);
    return wave(def.name, name, Number(param.min), Number(param.max), own, periods[index % periods.length]);
  });
}

/**
 * The params of effect `fx` (fx-catalog.js row) that drift, inside `bounds`
 * (name -> [lo, hi]: the range the shuffle draws it from): up to
 * DRIFT_FX_MAX of `linkable` (the params marked linkable that pass the link
 * rule), the params, periods and offsets by the effect's id.
 */
export function fxDriftPlan(fx, linkable, bounds) {
  if (!fx?.id || !Array.isArray(linkable) || !linkable.length) return [];
  const owner = `fx:${fx.id}`;
  const picker = seededRandom(idSeed(owner));
  const names = shuffled(linkable, picker).slice(0, DRIFT_FX_MAX);
  const periods = shuffled(DRIFT_PERIODS, picker);
  const plan = [];
  names.forEach((name, index) => {
    const range = bounds(name);
    if (!range || !(range[1] > range[0])) return;
    plan.push(wave(owner, name, range[0], range[1], DRIFT_DEPTH, periods[index % periods.length]));
  });
  return plan;
}

/** `base` with the planned params drifted, into `out` (every other value
 *  copied as it is). `bars`: the drift clock; `scale`: the depth scale
 *  (driftScale; 0 leaves the base as it is). */
export function applyDrift(base, plan, bars, scale, out) {
  for (const key in base) out[key] = base[key];
  if (!(scale > 0)) return out;
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    const given = base[item.name];
    if (typeof given !== 'number') continue;
    // The base inside the range first (as a link would clamp it), then the
    // wave, held inside the same range.
    const { lo, hi } = item;
    const at = given < lo ? lo : (given > hi ? hi : given);
    const value = at + item.depth * scale * item.span * Math.sin(TAU * (bars / item.period + item.offset));
    out[item.name] = value < lo ? lo : (value > hi ? hi : value);
  }
  return out;
}

/** The depth scale for a swell (0..1) and the mood's reaction strength. */
export function driftScale(swell, strength = 1) {
  const share = clamp01((swell - SWELL_QUIET) / (SWELL_LOUD - SWELL_QUIET));
  const most = DRIFT_SCALE_QUIET + (DRIFT_SCALE_LOUD - DRIFT_SCALE_QUIET) * share;
  return most * (strength > 0 ? strength : 1);
}

/** The fold (a power of two) the drift clock follows tempo `bpm` at, given
 *  the fold it follows at now (`fold`): the same unless `bpm` x fold leaves
 *  DRIFT_BPM_RANGE (then halved or doubled until inside), or unfolding by an
 *  octave would land well inside it (DRIFT_BPM_RETURN), so an estimate
 *  hovering at an edge keeps one fold. `bpm` x the fold is never outside
 *  DRIFT_BPM_RANGE. */
export function driftFold(bpm, fold = 1) {
  const [lowest, highest] = DRIFT_BPM_RANGE;
  const [up, down] = DRIFT_BPM_RETURN;
  let at = fold > 0 && Number.isFinite(fold) ? fold : 1;
  while (at < 1 && bpm * at * 2 < down) at *= 2;
  while (at > 1 && (bpm * at) / 2 > up) at /= 2;
  while (bpm * at > highest) at /= 2;
  while (bpm * at < lowest) at *= 2;
  return at;
}

/** The tempo the drift clock follows for `bpm` coming to it unfolded:
 *  halved while above DRIFT_BPM_RANGE, doubled while below. */
export function driftTempo(bpm) {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : IDLE_BPM;
  return tempo * driftFold(tempo, 1);
}

/**
 * The drift clock: bars, moving on smoothly.
 * @param {object} [options]
 * @param {number} [options.idleBpm]  the pace with no tempo heard
 */
export function createDriftClock({ idleBpm = IDLE_BPM } = {}) {
  let bars = 0;
  let pace = Number.NaN; // bars a second
  let fold = 1; // the octave the tempo is followed at (driftFold)
  return {
    /** One drawn frame of `dt` seconds at tempo `bpm` (0 or unknown: idle). */
    step(dt, bpm) {
      const heard = Number.isFinite(bpm) && bpm > 0 ? bpm : (idleBpm > 0 ? idleBpm : IDLE_BPM);
      fold = driftFold(heard, fold);
      const target = (heard * fold) / 240;
      if (!Number.isFinite(pace)) pace = target;
      if (!(dt > 0)) return bars;
      // Eased: 95% of the way in DRIFT_PACE_EASE_S.
      pace += (target - pace) * (1 - Math.exp((-3 * dt) / DRIFT_PACE_EASE_S));
      bars += pace * dt;
      if (bars >= DRIFT_WRAP_BARS) bars -= DRIFT_WRAP_BARS * Math.floor(bars / DRIFT_WRAP_BARS);
      return bars;
    },
    get bars() { return bars; },
    /** The fold the tempo is followed at now (driftFold). */
    get fold() { return fold; },
    /** Bars a second now. */
    get pace() { return Number.isFinite(pace) ? pace : idleBpm / 240; },
  };
}
