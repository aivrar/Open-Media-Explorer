/**
 * The LED-style sound meter in the player bar: 14 segmented bars (lows on the
 * left) with a slowly falling peak segment each. A plain consumer of the
 * shared audio signal (audio-signal.js); it never touches Web Audio itself.
 *
 * It listens to the signal only while the setting is on, the canvas is
 * actually laid out (not hidden by the setting, the capture-only bar, a
 * narrow window, or a hidden player bar) and the user has not asked for
 * reduced motion. Otherwise it draws its resting state once and costs nothing.
 * When the signal has no real sound (paused, stopped, silent, no data) the
 * bars sit flat: the dim unlit segments stay visible, nothing is faked.
 *
 * The setting is `soundMeter` inside the saved settings value (state.js),
 * default on, like `tunerCardSize`.
 */

import { autoGainDbStep, valueToDb } from './audio-signal.js';

export const METER_BARS = 14;
export const METER_MIN_HZ = 40;
export const METER_MAX_HZ = 16000;
export const METER_TILT_DB_PER_OCTAVE = 3;
/** Frames a second the meter asks the shared signal for. Each redraw costs a
 *  main-thread commit and a compositor frame, so this is kept low on purpose;
 *  the timings below are tuned for it. */
export const METER_FPS = 15;
// A shared FFT window can include the outgoing track as the standby starts.
// Keep levels, peak hold and gain history through those boundary samples.
const HANDOFF_SETTLE_SECONDS = 0.12;
const MUTED_COLORS = Object.freeze({ on: '#f04848', hot: '#f04848', offAlpha: 0.16 });
const FRAME_OPTIONS = Object.freeze({
  minHz: METER_MIN_HZ, maxHz: METER_MAX_HZ, tiltDbPerOctave: METER_TILT_DB_PER_OCTAVE,
});

/** Time constants in seconds; peakFall in meter heights per second. At 15
 *  frames a second the attack still lands a hit in one frame, and the
 *  release lets a bar fall about a quarter of the way per frame (three
 *  segments from full, fewer lower down) so the fall reads as motion, not a
 *  jump. */
export const METER_TIMING = Object.freeze({
  attack: 0.03,
  release: 0.22,
  peakHold: 0.45,
  peakFall: 0.7,
});

/** How far (in segments) a bar's level or peak must go past the edge halfway
 *  between two segments before the lit count changes, so a bar hovering on
 *  an edge does not flip (and redraw) every frame. */
export const METER_HYSTERESIS = 0.2;

/** What the segments show: the top segment is METER_TOP_DB (after gain),
 *  the bottom of the meter METER_SPAN_DB below it, about 3.5-4.5 dB a
 *  segment like a hardware LED meter, so a kick drum moves a bar by a few
 *  segments. The analyser floor (-85 dB, VISUAL_ANALYSER_SETTINGS) is the
 *  meter floor less the most gain, so boosted quiet sound still starts at the
 *  analyser's own floor. */
export const METER_TOP_DB = -16;
export const METER_SPAN_DB = 45;

/** Auto-gain for the meter (audio-signal.js autoGainDbStep): boost only, up to
 *  18 dB for the whole meter plus up to 6 dB per band, adapting over seconds. */
export const METER_GAIN = Object.freeze({
  targetDb: -19, maxBoostDb: 18, bandBoostDb: 6, fallDbPerSecond: 3, floorDb: -75,
});

/* ---------------- Pure maths ---------------- */

/** Move `current` toward `target` with an exponential time constant: attack
 *  when rising, release when falling. Same result at any frame rate. */
export function smoothToward(current, target, dt, attackSeconds, releaseSeconds) {
  if (!(dt > 0)) return current;
  const tau = target > current ? attackSeconds : releaseSeconds;
  if (!(tau > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function advancePeak(peak, holdLeft, level, dt, hold, fall, out) {
  if (level >= peak) {
    out.peak = level;
    out.hold = hold;
    return out;
  }
  let remaining = holdLeft - dt;
  let next = peak;
  if (remaining < 0) {
    next = peak + remaining * fall; // only the part of dt after the hold ended
    remaining = 0;
  }
  out.peak = next < level ? level : next;
  out.hold = remaining;
  return out;
}

/** Peak hold: a new high sets the peak and restarts the hold; once the hold
 *  has run out the peak falls at `fall` per second, never below the level.
 *  Returns [peak, holdLeft]. */
export function stepPeak(peak, holdLeft, level, dt, hold, fall) {
  const result = advancePeak(peak, holdLeft, level, dt, hold, fall, { peak: 0, hold: 0 });
  return [result.peak, result.hold];
}

const peakScratch = { peak: 0, hold: 0 };

export function createMeterState(bars = METER_BARS) {
  return {
    levels: new Float32Array(bars),
    peaks: new Float32Array(bars),
    holds: new Float32Array(bars),
    raw: new Float32Array(bars),
    levelsDb: new Float64Array(bars),
    trackedDb: new Float64Array(bars).fill(METER_GAIN.targetDb),
    gainedDb: new Float64Array(bars),
    targets: new Float32Array(bars),
    tops: new Int16Array(bars), // peak tops last shown, in segments (quantizeMeter)
  };
}

/** dB levels to 0..1 meter heights for a window topDb - spanDb .. topDb.
 *  No energy (-Infinity) is exactly 0. Writes into `out`. */
export function dbToMeter(levelsDb, out, topDb = METER_TOP_DB, spanDb = METER_SPAN_DB) {
  const floor = topDb - spanDb;
  for (let index = 0; index < out.length; index += 1) {
    const value = (levelsDb[index] - floor) / spanDb;
    out[index] = value > 0 ? (value < 1 ? value : 1) : 0;
  }
  return out;
}

/** One frame of the meter's sound path: bars from the shared frame, to dB,
 *  auto-gain, to meter heights in state.targets. */
export function meterTargetsFromFrame(state, frame) {
  frame.bars(state.raw.length, state.raw, FRAME_OPTIONS);
  for (let index = 0; index < state.raw.length; index += 1) {
    state.levelsDb[index] = valueToDb(state.raw[index], frame.minDecibels, frame.maxDecibels);
  }
  autoGainDbStep(state.levelsDb, state.trackedDb, frame.dt, state.gainedDb, METER_GAIN);
  return dbToMeter(state.gainedDb, state.targets);
}

/** Advance levels and peaks toward `targets` (0..1) by dt seconds. */
export function stepMeter(state, targets, dt, timing = METER_TIMING) {
  for (let index = 0; index < state.levels.length; index += 1) {
    const target = targets[index] > 1 ? 1 : (targets[index] > 0 ? targets[index] : 0);
    const level = smoothToward(state.levels[index], target, dt, timing.attack, timing.release);
    state.levels[index] = level;
    advancePeak(state.peaks[index], state.holds[index], level, dt, timing.peakHold, timing.peakFall, peakScratch);
    state.peaks[index] = peakScratch.peak;
    state.holds[index] = peakScratch.hold;
  }
  return state;
}

/** Back to rest: every bar and peak at zero (the auto-gain memory is kept). */
export function resetMeter(state) {
  state.levels.fill(0);
  state.peaks.fill(0);
  state.holds.fill(0);
  state.tops.fill(0);
  return state;
}

/** `value` (in segments, 0..segments) as a whole segment count, keeping
 *  `shown` unless the value has moved more than half a segment plus
 *  `hysteresis` away from it. */
export function segmentCount(value, shown, segments, hysteresis = METER_HYSTERESIS) {
  const scaled = value > 0 ? (value < segments ? value : segments) : 0;
  const count = Math.round(scaled);
  if (count === shown || !(shown >= 0 && shown <= segments)) return count;
  const distance = scaled > shown ? scaled - shown : shown - scaled;
  return distance > 0.5 + hysteresis ? count : shown;
}

/** Lit segment counts and peak segment indexes (-1 = none) into `lit` and
 *  `peak`, with METER_HYSTERESIS on both (state.tops keeps the peak tops
 *  shown). Returns true when anything differs from what they held before, so
 *  an unchanged meter (resting, a steady tone, a bar hovering on an edge) is
 *  not redrawn. */
export function quantizeMeter(state, segments, lit, peak, hysteresis = METER_HYSTERESIS) {
  let changed = false;
  for (let index = 0; index < state.levels.length; index += 1) {
    const count = segmentCount(state.levels[index] * segments, lit[index], segments, hysteresis);
    let top = segmentCount(state.peaks[index] * segments, state.tops[index], segments, hysteresis);
    if (top < count) top = count;
    state.tops[index] = top;
    const peakIndex = top > count ? top - 1 : -1;
    if (lit[index] !== count || peak[index] !== peakIndex) changed = true;
    lit[index] = count;
    peak[index] = peakIndex;
  }
  return changed;
}

/** Whole-device-pixel geometry for `bars` bars in a w x h device-pixel canvas,
 *  so the segments stay crisp at 100/125/150/175 % scaling. */
export function meterLayout(width, height, dpr = 1, bars = METER_BARS) {
  const scale = dpr > 0 ? dpr : 1;
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  let barGap = Math.max(1, Math.round(2 * scale));
  let barWidth = Math.floor((w - barGap * (bars - 1)) / bars);
  if (barWidth < 1) {
    barGap = 1;
    barWidth = Math.max(1, Math.floor((w - (bars - 1)) / bars));
  }
  const segGap = Math.max(1, Math.round(scale));
  const segHeight = Math.max(1, Math.round(2 * scale));
  const segments = Math.max(1, Math.floor((h + segGap) / (segHeight + segGap)));
  const usedW = bars * barWidth + (bars - 1) * barGap;
  const usedH = segments * segHeight + (segments - 1) * segGap;
  return {
    bars,
    barWidth,
    barGap,
    segHeight,
    segGap,
    segments,
    hotFrom: segments - Math.max(1, Math.round(segments * 0.2)),
    left: Math.max(0, Math.floor((w - usedW) / 2)),
    top: Math.max(0, Math.floor((h - usedH) / 2)),
  };
}

/** The scale meterLayout is given. The player bar's meter (no `segments`)
 *  uses the screen scale, so its segments are 2 px at 100 %. A larger meter
 *  (the Now Playing tab) asks for about `segments` segments over its height,
 *  so its LEDs grow with the canvas instead of turning into thin lines; never
 *  smaller than the screen scale. */
export function meterScale(height, dpr = 1, segments = 0) {
  const scale = dpr > 0 ? dpr : 1;
  const h = Number(height);
  if (!(segments > 0) || !(h > 0)) return scale;
  return Math.max(scale, h / (3 * segments));
}

/* ---------------- Drawing ---------------- */


function fillSegments(ctx, layout, lit, peak, wantLit, hot) {
  const { bars, barWidth, barGap, segHeight, segGap, segments, hotFrom, left, top } = layout;
  const from = hot ? hotFrom : 0;
  const to = hot ? segments : hotFrom;
  let any = false;
  ctx.beginPath();
  for (let bar = 0; bar < bars; bar += 1) {
    const x = left + bar * (barWidth + barGap);
    for (let segment = from; segment < to; segment += 1) {
      const on = segment < lit[bar] || segment === peak[bar];
      if (on !== wantLit) continue;
      // Segment 0 is the bottom one.
      const y = top + (segments - 1 - segment) * (segHeight + segGap);
      ctx.rect(x, y, barWidth, segHeight);
      any = true;
    }
  }
  if (any) ctx.fill();
}

/** Draw one meter state. Colours: { on, hot, offAlpha }. */
export function drawMeter(ctx, layout, lit, peak, colors, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = colors.offAlpha;
  ctx.fillStyle = colors.on;
  fillSegments(ctx, layout, lit, peak, false, false);
  ctx.fillStyle = colors.hot;
  fillSegments(ctx, layout, lit, peak, false, true);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.on;
  fillSegments(ctx, layout, lit, peak, true, false);
  ctx.fillStyle = colors.hot;
  fillSegments(ctx, layout, lit, peak, true, true);
}

/* ---------------- The meter ---------------- */

/**
 * @param {object} options
 * @param {HTMLElement} options.root   the block that is shown/hidden by the setting
 * @param {HTMLCanvasElement} options.canvas
 * @param {{ subscribe(fn, opts): () => void }} options.signal
 * @param {number} [options.segments] about this many segments over the
 *   height (meterScale); left out, the player bar's 2 px segments
 */
export function createPlayerMeter({
  root,
  canvas,
  signal,
  win = globalThis.window,
  doc = globalThis.document,
  enabled = true,
  segments: targetSegments = 0,
} = {}) {
  const state = createMeterState(METER_BARS);
  const lit = new Int8Array(METER_BARS);
  const peak = new Int8Array(METER_BARS).fill(-1);
  const colors = { on: '#5eead4', hot: '#f6b44b', offAlpha: 0.16 };
  let ctx = null;
  let layout = null;
  let deviceWidth = 0;
  let deviceHeight = 0;
  let shown = false;
  let isEnabled = enabled !== false;
  let reducedMotion = false;
  let muted = false;
  let mutedDrawPending = false;
  let unsubscribe = null;
  let destroyed = false;
  const cleanups = [];
  const stats = { draws: 0, frames: 0 };

  function readColors() {
    if (!canvas || typeof win?.getComputedStyle !== 'function') return;
    try {
      // The canvas carries its colours as CSS (base.css .player-meter-canvas):
      // `color` is the lit colour, the (zero-width) top border colour the hot
      // one. Computed colours come back resolved, whatever the theme wrote.
      const style = win.getComputedStyle(canvas);
      if (style.color) colors.on = style.color;
      if (style.borderTopColor) colors.hot = style.borderTopColor;
      const alpha = Number.parseFloat(style.getPropertyValue('--meter-off-alpha'));
      if (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) colors.offAlpha = alpha;
    } catch (_) {}
  }

  function draw(force = false) {
    if (!shown || !ctx || !layout) return false;
    if (muted) {
      if (!force) return false;
      mutedDrawPending = doc?.visibilityState === 'hidden';
      if (mutedDrawPending) return false;
      lit.fill(1);
      peak.fill(-1);
    } else if (!quantizeMeter(state, layout.segments, lit, peak) && !force) {
      return false;
    }
    drawMeter(ctx, layout, lit, peak, muted ? MUTED_COLORS : colors, deviceWidth, deviceHeight);
    stats.draws += 1;
    return true;
  }

  function onFrame(frame) {
    stats.frames += 1;
    if (!frame.active) {
      resetMeter(state);
      draw();
      return;
    }
    if (frame.time < frame.handoffTime + HANDOFF_SETTLE_SECONDS) return;
    if (frame.dt > 0) {
      meterTargetsFromFrame(state, frame);
      stepMeter(state, state.targets, frame.dt);
    }
    draw();
  }

  function sync() {
    const listen = !destroyed && isEnabled && shown && !reducedMotion && !muted && Boolean(signal);
    if (listen && !unsubscribe) {
      unsubscribe = signal.subscribe(onFrame, { fps: METER_FPS });
    } else if (!listen && unsubscribe) {
      const stop = unsubscribe;
      unsubscribe = null;
      stop();
      resetMeter(state);
      draw();
    } else if (!listen) {
      resetMeter(state);
    }
  }

  function resize(width, height) {
    const w = Math.max(0, Math.round(width));
    const h = Math.max(0, Math.round(height));
    shown = w > 0 && h > 0;
    if (shown) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      deviceWidth = w;
      deviceHeight = h;
      const dpr = Number(win?.devicePixelRatio) || 1;
      layout = meterLayout(w, h, meterScale(h, dpr, targetSegments), METER_BARS);
      ctx = ctx || canvas.getContext?.('2d') || null;
      readColors();
      draw(true);
    }
    sync();
  }

  function onResize(entries) {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const device = entry.devicePixelContentBoxSize?.[0];
    if (device) {
      resize(device.inlineSize, device.blockSize);
      return;
    }
    const dpr = Number(win?.devicePixelRatio) || 1;
    const box = entry.contentBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect?.width || 0;
    const height = box ? box.blockSize : entry.contentRect?.height || 0;
    resize(width * dpr, height * dpr);
  }

  function themeChanged() {
    readColors();
    draw(true);
  }

  if (canvas && typeof win?.ResizeObserver === 'function') {
    const observer = new win.ResizeObserver(onResize);
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch (_) {
      observer.observe(canvas);
    }
    cleanups.push(() => observer.disconnect());
  }
  if (doc?.documentElement && typeof win?.MutationObserver === 'function') {
    const observer = new win.MutationObserver(themeChanged);
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => observer.disconnect());
  }
  if (typeof win?.matchMedia === 'function') {
    const scheme = win.matchMedia('(prefers-color-scheme: dark)');
    scheme?.addEventListener?.('change', themeChanged);
    cleanups.push(() => scheme?.removeEventListener?.('change', themeChanged));
    const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motion?.matches === true;
    const onMotion = () => { reducedMotion = motion.matches === true; sync(); };
    motion?.addEventListener?.('change', onMotion);
    cleanups.push(() => motion?.removeEventListener?.('change', onMotion));
  }
  if (root) root.hidden = !isEnabled;

  return {
    /** Turn the meter on or off at once (the Settings switch). */
    setEnabled(next) {
      isEnabled = next !== false;
      if (root) root.hidden = !isEnabled;
      sync();
    },
    /** Show the Now Playing mute indicator without listening to the signal. */
    setMuted(next) {
      if (muted === next) {
        if (mutedDrawPending) draw(true);
        return;
      }
      muted = next;
      mutedDrawPending = false;
      sync();
      draw(true);
    },
    destroy() {
      destroyed = true;
      sync();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    get listening() { return Boolean(unsubscribe); },
    get enabled() { return isEnabled; },
    get shown() { return shown; },
    // For tests: feed a size directly when there is no ResizeObserver.
    resize,
    onFrame,
    state,
    lit,
    peak,
    colors,
    stats,
  };
}

/** Bind the player bar's meter to the audio signal and the Sound meter setting. */
export function initPlayerMeter({ signal, getSettings, subscribeSettings, doc = globalThis.document }) {
  const meters = [];
  for (const root of doc?.querySelectorAll?.('[data-player-meter]') || []) {
    const canvas = root.querySelector('canvas');
    if (!canvas) continue;
    meters.push(createPlayerMeter({
      root, canvas, signal, doc, enabled: getSettings()?.soundMeter !== false,
    }));
  }
  if (meters.length) {
    subscribeSettings((settings) => {
      for (const meter of meters) meter.setEnabled(settings?.soundMeter !== false);
    });
  }
  return meters;
}
