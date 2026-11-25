/**
 * Processor use: how much of the computer the app may use (Settings >
 * Processor use), and the one place everything asks.
 *
 * Light is the default and is exactly how the app has always behaved: the
 * Visualizer steps quality down when frames come late and never steps back
 * up by itself, and nothing reads the processor use. Balanced and High let
 * the Visualizer steer by a limit instead: while it plays at those levels the
 * app's own processor use is read every few seconds (worldmedia_processor.py,
 * the app and the window's processes together, as a share of the whole
 * processor). When it stays over the limit for several seconds a notch is
 * taken off; with clear headroom for a long while a notch is given back,
 * slowly, and a notch given back that has to be taken off again soon after
 * stops further step-ups for that scene, so it never swings back and forth.
 * Without a reading (none available, or not yet) only the frame-time
 * step-down of Light applies.
 *
 * The limit is a target the app steers by, not a cap the operating system
 * enforces: a hard cap (a Windows job object with a CPU rate limit) would
 * also hold back the processes that decode and play the sound, so an
 * overloaded moment would be heard as stutter rather than seen as a lower
 * picture quality.
 *
 * Nothing here runs by itself: a reader starts only when the Visualizer asks
 * (createUseReader), and stops when it is hidden, silent or closed.
 *
 * Flash safety does not depend on the level: the brightness-step limit, the
 * flash limiter and every left-out look and effect apply at every level.
 * What Balanced and High add beyond the steering (a fourth picture quality,
 * larger simulations at High) is in PROCESSOR_EXTRAS below; the frame rate
 * choices and the most effects and overlays at once are the same at every
 * level.
 */

export const PROCESSOR_USE_LIGHT = 'light';
export const PROCESSOR_USE_BALANCED = 'balanced';
export const PROCESSOR_USE_HIGH = 'high';
export const PROCESSOR_USE_LEVELS = Object.freeze([PROCESSOR_USE_LIGHT, PROCESSOR_USE_BALANCED, PROCESSOR_USE_HIGH]);
export const DEFAULT_PROCESSOR_USE = PROCESSOR_USE_LIGHT;
export const PROCESSOR_USE_LABELS = Object.freeze({
  [PROCESSOR_USE_LIGHT]: 'Low (default)',
  [PROCESSOR_USE_BALANCED]: 'Balanced',
  [PROCESSOR_USE_HIGH]: 'High',
});

/** The levels' plain names, for a line of text. */
export const PROCESSOR_USE_NAMES = Object.freeze({
  [PROCESSOR_USE_LIGHT]: 'Low',
  [PROCESSOR_USE_BALANCED]: 'Balanced',
  [PROCESSOR_USE_HIGH]: 'High',
});

/** The limit, in percent of the whole processor (all cores together), in
 *  whole percent (a step of 5 could not start at 2). */
export const PROCESSOR_LIMIT_MIN = 2;
export const PROCESSOR_LIMIT_MAX = 80;
export const PROCESSOR_LIMIT_STEP = 1;
/** The limit each level starts with until the user sets one (proposed). */
export const PROCESSOR_LIMIT_PRESETS = Object.freeze({
  [PROCESSOR_USE_LIGHT]: 25,
  [PROCESSOR_USE_BALANCED]: 40,
  [PROCESSOR_USE_HIGH]: 60,
});

/* Steering (proposed numbers, to be checked in the real window). */
/** How often the use is read while something steers by it. */
export const BUDGET_READ_MS = 3_000;
/** The weight of a new reading in the smoothed use (0..1). */
export const BUDGET_SMOOTHING = 0.4;
/** Over the limit this long (smoothed) before a notch is taken off. */
export const BUDGET_OVER_MS = 6_000;
/** Clear headroom: under this share of the limit... */
export const BUDGET_HEADROOM = 0.6;
/** ...for this long before a notch is given back. */
export const BUDGET_UNDER_MS = 30_000;
/** After a notch either way, no decision for this long. */
export const BUDGET_SETTLE_MS = 8_000;
/** A notch taken off within this long after one was given back stops
 *  further step-ups (for the scene, until reset). */
export const BUDGET_BOUNCE_MS = 60_000;

export function normalizeProcessorUse(value) {
  return PROCESSOR_USE_LEVELS.includes(value) ? value : DEFAULT_PROCESSOR_USE;
}

/** A limit the user set (a whole number of percent, on the step, within the
 *  range), or null: the level's preset. */
export function normalizeProcessorLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const stepped = Math.round(number / PROCESSOR_LIMIT_STEP) * PROCESSOR_LIMIT_STEP;
  return Math.min(PROCESSOR_LIMIT_MAX, Math.max(PROCESSOR_LIMIT_MIN, stepped));
}

/** What the settings allow now:
 *  { level, limit (percent), limitShare (0..1), readsUse, stepsUp,
 *    softwareQuality (the quality to draw with when WebGL runs on the
 *    processor; null: the chosen one) }. */
export function processorBudget(settings = {}) {
  const level = normalizeProcessorUse(settings?.processorUse);
  const limit = normalizeProcessorLimit(settings?.processorLimit) ?? PROCESSOR_LIMIT_PRESETS[level];
  const light = level === PROCESSOR_USE_LIGHT;
  return Object.freeze({
    level,
    limit,
    limitShare: limit / 100,
    // Light: exactly as before (frame time only, never back up, no reading).
    readsUse: !light,
    stepsUp: !light,
    // Light keeps a picture drawn by the processor gentle: the lowest quality.
    softwareQuality: light ? 'low' : null,
  });
}

/**
 * The shuffle's cost filter ('light' | 'medium' | 'all', visualizer-settings
 * VISUALIZER_SHUFFLE_COSTS) to use with the stored one: at Balanced and High
 * the untouched default ('medium') widens to 'all', so measured and released
 * heavy scenes may come up too. A filter picked by hand (`picked`, or any
 * stored value other than the default) is always used as it is, and Light
 * always uses the stored one. Changes no brightness rule: only which
 * released scenes the shuffle may choose. (The step-down's cost cap still
 * applies on top.)
 */
export function shuffleCostFor(stored, { picked = false, level = PROCESSOR_USE_LIGHT, defaultCost = 'medium' } = {}) {
  if (picked || stored !== defaultCost) return stored;
  return normalizeProcessorUse(level) === PROCESSOR_USE_LIGHT ? stored : 'all';
}

/* ---- What the higher levels unlock ----
 *
 * Read only through processorExtras(level): at Light it gives nothing,
 * whatever the switch says. Measured on the test machine (graphics card).
 */
export const PROCESSOR_EXTRAS_RELEASED = true;

/** The quality above High (visualizer-settings.js VISUALIZER_QUALITY_VERY_HIGH). */
export const QUALITY_ABOVE_HIGH_ID = 'very_high';

/** A fourth picture quality above High, offered at Balanced and High.
 *  Each step today doubles the pixel budget (Low 0.6, Medium 1.2, High 2.4
 *  million) and adds a quarter to the scale (0.5, 0.75, 1). High already
 *  draws every pixel of the screen (scale 1) in a window up to 2.4 million
 *  device pixels, a full 1920 x 1080 screen among them. A scale above 1
 *  draws pixels the screen cannot show: smoother edges only, 1.56 times the
 *  work at 1.25, so not proposed. The step up is the budget: 4.8 million, so
 *  a 2560 x 1440 screen (3.7 million) is drawn at every pixel and a 3840 x
 *  2160 one (8.3 million) at 0.76 of each side instead of 0.54. Where High
 *  already draws every pixel, Very high draws the same picture
 *  (qualityAboveHighUseful tells the two cases apart). The other per-quality
 *  tables (overlay sheets, glow, halo, line and density limits, scene caps
 *  and pixel budgets) use High's row at Very high. */
export const QUALITY_ABOVE_HIGH = Object.freeze({
  id: QUALITY_ABOVE_HIGH_ID, label: 'Very high', scale: 1, maxPixels: 4800000,
  levels: Object.freeze([PROCESSOR_USE_BALANCED, PROCESSOR_USE_HIGH]),
});

/** Very high by cost class: Light and Medium scenes draw at its budget;
 *  Heavy scenes at High's, except these, measured holding 30 frames a second
 *  with room at Very high (a picture of 2918 x 1642): the graphics card's ms
 *  a frame (median) there. The other heavy scenes measured took
 *  33 to 74 ms there (Path-Traced Fractal Flight 42.6, Fractal Canyon 73.8,
 *  Golden Hour Clouds 68.0) and are drawn at High's budget. */
export const VERY_HIGH_HEAVY_ALLOWED = Object.freeze({
  mandelbox_flight: 19.9,
  curl_silk: 1.7,
  fluid_ink: 2.9,
  lenia: 1.4,
  physarum: 1.5,
});

/** True when scene `entry` (a scenes.js entry) draws at Very high's budget
 *  when Very high is chosen; false: at High's. */
export function drawsAtVeryHigh(entry) {
  if (!entry) return false;
  return entry.cost !== 'heavy' || Object.prototype.hasOwnProperty.call(VERY_HIGH_HEAVY_ALLOWED, entry.id);
}
/** High's pixel budget (visualizer-settings.js VISUALIZER_PRESETS high). */
const HIGH_MAX_PIXELS = 2400000;

/** True when Very high would draw more than High in a tab of `devicePixels`
 *  (its width x height in device pixels). */
export function qualityAboveHighUseful(devicePixels) {
  return Number(devicePixels) > HIGH_MAX_PIXELS;
}

/** The simulations one size up at the High level, with quality High or Very
 *  high: their cap raised and the size set as they start (a size a look sets
 *  wins). Measured at High in 1920 x 1080 (graphics card ms a frame, median /
 *  95th percentile, today's size then this one; every look's flash and
 *  near-black check no worse than today's): Curl-Noise Silk 1M particles
 *  (1.4 / 2.3, then 2.2 / 3.4), Fluid Ink High detail (2.8 / 3.9, then
 *  2.9 / 4.1), Physarum Three Quarters trails (1.3 / 1.9, then 1.4 / 2.3).
 *  Lenia's Large world is left out: its start stayed under 0.05 for longer
 *  (its own look 2.0 s to 3.9 s, its second 3.8 s to 6.0 s). Reaction-
 *  Diffusion has no size setting. */
export const SIM_SIZES_ABOVE_HIGH = Object.freeze({
  curl_silk: Object.freeze({ particles: 2 }),
  fluid_ink: Object.freeze({ resolution: 2 }),
  physarum: Object.freeze({ agents: 1, resolution: 1, steps: 1 }),
});

/** The accumulating labs' worker share (of one processor core) per level
 *  and quality. Measured on the test machine (the three density labs, at
 *  each quality, building a picture until it finished): the worker busy
 *  12.8 to 13.4% of a core at 0.15, 19.5 to 22.6% at 0.25 and 28.8 to 31.8%
 *  at 0.35 (the whole browser 11 to 33% of a core, at most 2.7% of the
 *  12-core processor); a picture finished in 18 to 52 s. Larger shares were
 *  not measured, so Balanced and High keep these too until they are (the
 *  app's processor use with a lab building at each larger share, with the
 *  sound playing, and how long a picture then takes to fill in; never over
 *  DENSITY_SHARE_MOST). Light takes nothing from here (processorExtras). */
export const DENSITY_SHARE_BY_LEVEL = Object.freeze({
  [PROCESSOR_USE_LIGHT]: Object.freeze({ low: 0.15, medium: 0.25, high: 0.35 }),
  [PROCESSOR_USE_BALANCED]: Object.freeze({ low: 0.15, medium: 0.25, high: 0.35 }),
  [PROCESSOR_USE_HIGH]: Object.freeze({ low: 0.15, medium: 0.25, high: 0.35 }),
});
/** The most of one core a lab's worker may use at any level. */
export const DENSITY_SHARE_MOST = 0.5;

/** Not an extra: the most post effects and overlays at once stay 3 at every
 *  level (visualizer-settings.js VISUALIZER_FX_MAX, VISUALIZER_OVERLAY_MAX).
 *  Combinations of more than three were never measured, and the ways they
 *  can brighten together multiply with each one added. */
export const MOST_AT_ONCE_EVERY_LEVEL = 3;

const NO_EXTRAS = Object.freeze({
  topQuality: 'high', qualityAboveHigh: false, simSizes: null, densityShare: null,
});

/** What `level` unlocks: { topQuality (the highest quality offered),
 *  qualityAboveHigh (Very high offered), simSizes (the simulations' sizes at
 *  High quality, or null), densityShare ({ low, medium, high } shares, or
 *  null) }. Light: nothing, whatever `released` says; held: nothing at any
 *  level. */
export function processorExtras(level, released = PROCESSOR_EXTRAS_RELEASED) {
  const chosen = normalizeProcessorUse(level);
  if (!released || chosen === PROCESSOR_USE_LIGHT) return NO_EXTRAS;
  const high = chosen === PROCESSOR_USE_HIGH;
  return Object.freeze({
    topQuality: QUALITY_ABOVE_HIGH_ID,
    qualityAboveHigh: QUALITY_ABOVE_HIGH.levels.includes(chosen),
    simSizes: high ? SIM_SIZES_ABOVE_HIGH : null,
    densityShare: DENSITY_SHARE_BY_LEVEL[chosen],
  });
}

/** The caps of simulation `id` at `quality` (the table's row) with the
 *  larger size allowed when `level` gives it. */
export function simCapsWithExtras(id, quality, caps, level, released = PROCESSOR_EXTRAS_RELEASED) {
  const up = quality === 'high' ? processorExtras(level, released).simSizes?.[id] : null;
  return up ? { ...(caps || {}), ...up } : caps;
}

/** `values` (a scene's start values: its defaults and look) with its larger
 *  size set when `level` gives one at `quality` and nothing there sets it;
 *  `params`: the scene's param names. */
export function simStartWithExtras(id, quality, values, params, level, released = PROCESSOR_EXTRAS_RELEASED) {
  const up = quality === 'high' ? processorExtras(level, released).simSizes?.[id] : null;
  if (!up) return values;
  const out = { ...(values || {}) };
  let changed = false;
  for (const [name, value] of Object.entries(up)) {
    if (name in out || !params.includes(name)) continue;
    out[name] = value;
    changed = true;
  }
  return changed ? out : values;
}

/** A lab's worker share at `quality` for `level`: the table's when filled
 *  in (never over DENSITY_SHARE_MOST), else `fallback` (the density host's). */
export function densityShareFor(level, quality, fallback, released = PROCESSOR_EXTRAS_RELEASED) {
  const row = processorExtras(level, released).densityShare;
  const value = Number(row?.[quality]);
  return row && row[quality] !== null && Number.isFinite(value) && value > 0 ? Math.min(DENSITY_SHARE_MOST, value) : fallback;
}

/**
 * The density labs' worker (visualizer/density-host.js): its share of one
 * core at each quality is its measured one (DENSITY_QUALITY) times this.
 * Light keeps the measured shares; Balanced and High may have the larger
 * ones measured as safe.
 */
export const DENSITY_SHARE_SCALE = Object.freeze({
  [PROCESSOR_USE_LIGHT]: 1,
  [PROCESSOR_USE_BALANCED]: 1,
  [PROCESSOR_USE_HIGH]: 1,
});

/** The density worker's share scale at `level` (Light's for an unknown one). */
export function densityShareScale(level) {
  return DENSITY_SHARE_SCALE[normalizeProcessorUse(level)];
}

/* ---- Software rendering ---- */

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|basic render|software (?:rasterizer|renderer|adapter)|\bwarp\b/i;

/** The renderer name a WebGL context reports (the unmasked one when the
 *  browser offers it), or ''. */
export function rendererName(gl) {
  if (!gl || typeof gl.getParameter !== 'function') return '';
  try {
    const info = gl.getExtension?.('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch (_) {
    return '';
  }
}

/** True when the name is a renderer that draws with the processor
 *  (SwiftShader, llvmpipe, Microsoft Basic Render Driver / WARP). */
export function isSoftwareRenderer(name) {
  return typeof name === 'string' && SOFTWARE_RENDERERS.test(name);
}

/* ---- Steering ---- */

/**
 * Steer by a limit (a share, 0..1). feed(share, now) takes a reading (null:
 * none) and answers 'down' (take a notch off), 'up' (give one back) or null.
 * `stepsUp: false` never answers 'up'. reset() forgets everything (a new
 * scene, a quality chosen by hand); raised(now) says an 'up' really gave a
 * notch back; changed(now) says a notch was taken by something else (the
 * frame-time step-down), which also settles. A notch taken either way within
 * BUDGET_BOUNCE_MS of a real raise is a bounce: no more step-ups until
 * reset().
 */
export function createBudgetSteer({ limit, stepsUp = true } = {}) {
  const cap = Number(limit);
  let smoothed = null;
  let overSince = Number.NaN;
  let underSince = Number.NaN;
  let settleUntil = Number.NEGATIVE_INFINITY;
  let lastUp = Number.NEGATIVE_INFINITY;
  let upsBlocked = false;
  const quiet = () => { overSince = Number.NaN; underSince = Number.NaN; };
  return {
    get smoothed() { return smoothed; },
    get upsBlocked() { return upsBlocked; },
    feed(share, now) {
      if (!Number.isFinite(cap) || cap <= 0) return null;
      if (share === null || share === undefined || !Number.isFinite(Number(share))) {
        // No reading: no decision, and nothing held over a gap.
        smoothed = null;
        quiet();
        return null;
      }
      const value = Math.max(0, Math.min(1, Number(share)));
      smoothed = smoothed === null ? value : smoothed + BUDGET_SMOOTHING * (value - smoothed);
      if (now < settleUntil) { quiet(); return null; }
      if (smoothed > cap) {
        underSince = Number.NaN;
        if (Number.isNaN(overSince)) overSince = now;
        if (now - overSince < BUDGET_OVER_MS) return null;
        quiet();
        settleUntil = now + BUDGET_SETTLE_MS;
        if (now - lastUp < BUDGET_BOUNCE_MS) upsBlocked = true;
        return 'down';
      }
      if (stepsUp && !upsBlocked && smoothed < cap * BUDGET_HEADROOM) {
        overSince = Number.NaN;
        if (Number.isNaN(underSince)) underSince = now;
        if (now - underSince < BUDGET_UNDER_MS) return null;
        quiet();
        settleUntil = now + BUDGET_SETTLE_MS;
        return 'up';
      }
      quiet();
      return null;
    },
    raised(now) {
      lastUp = now;
    },
    changed(now) {
      quiet();
      settleUntil = Math.max(settleUntil, now + BUDGET_SETTLE_MS);
      if (now - lastUp < BUDGET_BOUNCE_MS) upsBlocked = true;
    },
    reset() {
      smoothed = null;
      quiet();
      settleUntil = Number.NEGATIVE_INFINITY;
      lastUp = Number.NEGATIVE_INFINITY;
      upsBlocked = false;
    },
  };
}

/* ---- Reading ---- */

/**
 * Reads the app's processor use every `intervalMs` while started, and passes
 * each share (or null) to onReading. One request at a time, a timer only
 * while started; stop() ends it at once (a reply that arrives later is
 * dropped).
 */
export function createUseReader({
  read, onReading, intervalMs = BUDGET_READ_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;
  let generation = 0;
  const schedule = (mine) => {
    if (!running || mine !== generation) return;
    timer = setTimer(() => {
      timer = null;
      if (!running || mine !== generation) return;
      Promise.resolve()
        .then(() => read())
        .then((data) => (Number.isFinite(Number(data?.share)) && data?.share !== null ? Number(data.share) : null),
          () => null)
        .then((share) => {
          if (!running || mine !== generation) return;
          try { onReading?.(share); } catch (_) { /* a reading never stops the reader */ }
          schedule(mine);
        });
    }, intervalMs);
  };
  return {
    get running() { return running; },
    start() {
      if (running) return;
      running = true;
      generation += 1;
      schedule(generation);
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
