/**
 * Automatic step-down for computers that cannot keep up with a scene.
 *
 * While sound plays (the loop is live), the time between drawn frames is
 * measured: only the frame intervals the loop sees, nothing read back from the
 * graphics card (no readPixels, no finish), so measuring costs nothing on the
 * GPU. The frames the display offers are learnt from the sound loop's
 * animation-frame ticks (the shortest interval between two, drawn or not):
 * 60 chosen on a 40 Hz display expects 40, so a display that offers fewer
 * frames is not taken for a computer that cannot keep up (below
 * STEP_DOWN_MIN_DISPLAY_FPS the two cannot be told apart). When the frames
 * over a few seconds (STEP_DOWN_WINDOW_MS) come at less than STEP_DOWN_SHARE
 * of the smaller of the chosen rate and the display's, one notch is taken off:
 * first post effects while any are on (fx-chain.js: down to one, then none;
 * `fxInUse` says how many are drawn), then overlays while any are on
 * (overlay-layer.js: down to one, then none; `overlaysInUse`), then the
 * picture quality (High, Medium,
 * Low: fewer pixels), then, at Low, the frame rate (60, 30, 15). After each
 * step the next measurement waits STEP_DOWN_SETTLE_MS for the change to take
 * hold.
 *
 * The step-down belongs to the scene shown (newScene(id)): each scene starts
 * at the chosen quality and frame rate with all its effects and overlays,
 * unless it needed less earlier this visit; then it starts at what it needed
 * (the notches it took, remembered per scene: quality and frame rate, and
 * the effect and overlay caps), so a heavy scene shown again does not hitch
 * its way down again. Within a scene it never steps back up by itself. The
 * saved settings are not touched: the step-down is only what is drawn now.
 * Choosing a quality or a frame rate by hand clears it and what the scenes
 * needed (choose()), and so does closing the tab. `stepped` says a notch was
 * taken while this scene shows (the note is shown for that, not for a scene
 * that starts at a level it needed before).
 *
 * A gap longer than STEP_DOWN_MAX_GAP_MS (a minimised or covered window, a
 * hitch) starts the measurement afresh instead of counting as a slow frame.
 *
 * Short hitches are not a slow computer (the real-window test saw Plasma
 * stepped down while screenshots were taken, and scenes stepped down under a
 * moment's load from other programs that later held 30 with no trouble):
 *   - Sustained: a notch is taken only after STEP_DOWN_WINDOWS_NEEDED (2)
 *     slow windows in a row; a window that keeps up clears the count.
 *   - Isolated gaps: a window whose shortfall comes from at most
 *     STEP_DOWN_ISOLATED_GAPS (2) long gaps (each more than
 *     STEP_DOWN_LONG_GAP times the expected interval) is measured without
 *     them; if the cadence is fine apart from them, the window is not slow.
 *   - Warm-up: after a scene is installed (newScene()), the first
 *     STEP_DOWN_GRACE_MS after its first drawn frame do not count (shaders
 *     finish compiling and warm their caches on the first draws).
 */

import {
  VISUALIZER_FRAME_RATES, VISUALIZER_QUALITIES, normalizeVisualizerFps, normalizeVisualizerQuality,
} from '../lib/visualizer-settings.js';

export const STEP_DOWN_NOTE = 'Lowered quality to keep this scene smooth';
export const STEP_DOWN_WINDOW_MS = 3000;
export const STEP_DOWN_SHARE = 0.8;
export const STEP_DOWN_SETTLE_MS = 1000;
export const STEP_DOWN_MAX_GAP_MS = 1000;
export const STEP_DOWN_WINDOWS_NEEDED = 2;
export const STEP_DOWN_ISOLATED_GAPS = 2;
export const STEP_DOWN_LONG_GAP = 3;
export const STEP_DOWN_GRACE_MS = 1500;
/** Ticks closer together than this are not a display frame interval. */
const MIN_TICK_MS = 4;
/** The display rate assumed at the least: a display (or power plan) that
 *  offers fewer frames than this is not told apart from a computer that
 *  cannot keep up. */
export const STEP_DOWN_MIN_DISPLAY_FPS = 30;

/** The notches from the chosen quality and frame rate down: [{ quality, fps }],
 *  the chosen pair first. */
export function stepDownLevels(quality, fps) {
  const chosenQuality = normalizeVisualizerQuality(quality);
  const chosenFps = normalizeVisualizerFps(fps);
  const levels = [];
  for (let at = VISUALIZER_QUALITIES.indexOf(chosenQuality); at >= 0; at -= 1) {
    levels.push({ quality: VISUALIZER_QUALITIES[at], fps: chosenFps });
  }
  const lowest = levels[levels.length - 1].quality;
  for (let at = VISUALIZER_FRAME_RATES.indexOf(chosenFps) - 1; at >= 0; at -= 1) {
    levels.push({ quality: lowest, fps: VISUALIZER_FRAME_RATES[at] });
  }
  return levels;
}

export function createStepDown({
  quality, fps, onStep = null, fxInUse = () => 0, overlaysInUse = () => 0,
} = {}) {
  let levels = stepDownLevels(quality, fps);
  let level = 0;
  // The most post effects allowed now (Infinity: as many as chosen).
  let fxCap = Number.POSITIVE_INFINITY;
  // The most overlays allowed now (Infinity: as many as chosen).
  let overlayCap = Number.POSITIVE_INFINITY;
  let windowStart = Number.NaN;
  let windowFrames = 0;
  let lastFrame = Number.NaN;
  let settleUntil = Number.NEGATIVE_INFINITY;
  // The two longest frame gaps of the window (ms), longest first.
  let gapA = 0;
  let gapB = 0;
  let slowWindows = 0; // slow windows in a row
  let graceArmed = false; // a new scene: its first frame starts a grace time
  // The scene shown (newScene), what each scene needed this visit
  // (id -> { level, fx, overlays }), and whether a notch was taken while this
  // scene shows.
  let sceneId = null;
  const needed = new Map();
  let stepped = false;
  // The display's frame cadence: the shortest interval seen between two
  // animation-frame ticks of the sound loop this visit (drawn or not). Frames
  // that are late come further apart than that; a display that simply offers
  // fewer frames shows it in this shortest interval too.
  let lastTick = Number.NaN;
  let shortestTick = Number.POSITIVE_INFINITY;
  const stats = {
    steps: 0, windows: 0, fxSteps: 0, overlaySteps: 0, slowWindows: 0, forgiven: 0, graces: 0,
  };
  /** Frames a second the display offers (at least STEP_DOWN_MIN_DISPLAY_FPS;
   *  Infinity before any are seen). */
  const displayFps = () => (Number.isFinite(shortestTick)
    ? Math.max(STEP_DOWN_MIN_DISPLAY_FPS, 1000 / shortestTick)
    : Number.POSITIVE_INFINITY);

  function openWindow(now) {
    windowStart = now;
    windowFrames = 0;
    gapA = 0;
    gapB = 0;
  }

  function restart() {
    openWindow(Number.NaN);
    lastFrame = Number.NaN;
    slowWindows = 0;
  }

  return {
    /** What to draw with now: { quality, fps }. */
    get quality() { return levels[level].quality; },
    get fps() { return levels[level].fps; },
    /** The most post effects allowed now (Infinity: no cap). */
    get fx() { return fxCap; },
    /** The most overlays allowed now (Infinity: no cap). */
    get overlays() { return overlayCap; },
    /** Something has been stepped down since the last choice. */
    get lowered() { return level > 0 || fxCap !== Number.POSITIVE_INFINITY || overlayCap !== Number.POSITIVE_INFINITY; },
    get level() { return level; },
    get levels() { return levels; },
    /** A notch was taken while this scene shows (not one it started at). */
    get stepped() { return stepped; },
    /** What scene `id` needed this visit ({ quality, fps, fx, overlays }), or
     *  null when it keeps up with what was chosen. */
    neededBy(id) {
      const kept = needed.get(id);
      return kept ? { ...levels[kept.level], fx: kept.fx, overlays: kept.overlays } : null;
    },
    get displayFps() { return displayFps(); },
    stats,

    /** An animation-frame tick of the sound loop at `now` (ms), drawn or
     *  only heard: teaches it the display's frame cadence. */
    tick(now) {
      if (!Number.isFinite(now)) return;
      const gap = now - lastTick;
      lastTick = now;
      if (gap >= MIN_TICK_MS && gap < shortestTick) shortestTick = gap;
    },

    /** A quality and frame rate chosen (by hand, or from the settings): the
     *  step-down is cleared, with what each scene needed, and measuring
     *  starts afresh. */
    choose(nextQuality, nextFps) {
      levels = stepDownLevels(nextQuality, nextFps);
      level = 0;
      fxCap = Number.POSITIVE_INFINITY;
      overlayCap = Number.POSITIVE_INFINITY;
      settleUntil = Number.NEGATIVE_INFINITY;
      needed.clear();
      stepped = false;
      restart();
    },

    /** Start measuring afresh (sound stopped, the window was hidden, another
     *  scene was installed): nothing measured so far counts. */
    restart,

    /** Scene `id` was installed: it starts at the chosen quality and frame
     *  rate with no caps, or at what it needed earlier this visit, and is
     *  measured afresh after a short warm-up from its first drawn frame.
     *  Returns true when the quality or frame rate to draw with changed. */
    newScene(id = null) {
      const was = levels[level];
      const kept = id === null ? undefined : needed.get(id);
      sceneId = id;
      level = kept ? Math.min(kept.level, levels.length - 1) : 0;
      fxCap = kept ? kept.fx : Number.POSITIVE_INFINITY;
      overlayCap = kept ? kept.overlays : Number.POSITIVE_INFINITY;
      stepped = false;
      settleUntil = Number.NEGATIVE_INFINITY;
      restart();
      graceArmed = true;
      return levels[level] !== was;
    },

    /** A frame was drawn while live at `now` (ms). Returns true when it took a
     *  notch off (onStep has then been called with the new { quality, fps }). */
    frame(now) {
      if (!Number.isFinite(now)) return false;
      const gap = now - lastFrame;
      lastFrame = now;
      if (graceArmed) {
        graceArmed = false;
        settleUntil = Math.max(settleUntil, now + STEP_DOWN_GRACE_MS);
        stats.graces += 1;
      }
      if (now < settleUntil || !Number.isFinite(windowStart) || !(gap <= STEP_DOWN_MAX_GAP_MS)) {
        openWindow(now);
        return false;
      }
      windowFrames += 1;
      if (gap > gapA) { gapB = gapA; gapA = gap; } else if (gap > gapB) gapB = gap;
      const elapsed = now - windowStart;
      if (elapsed < STEP_DOWN_WINDOW_MS) return false;
      stats.windows += 1;
      const rate = (windowFrames * 1000) / elapsed;
      // Late only against the frames the display offered: 60 chosen on a
      // 40 Hz display expects 40.
      const target = Math.min(levels[level].fps, displayFps());
      const frames = windowFrames;
      const longA = gapA;
      const longB = gapB;
      openWindow(now);
      if (rate >= target * STEP_DOWN_SHARE) { slowWindows = 0; return false; }
      // One or two isolated long gaps (a screenshot, another program's
      // moment): the cadence without them decides.
      const long = (STEP_DOWN_LONG_GAP * 1000) / target;
      let dropped = 0;
      let droppedMs = 0;
      for (const longGap of [longA, longB].slice(0, STEP_DOWN_ISOLATED_GAPS)) {
        if (longGap > long) { dropped += 1; droppedMs += longGap; }
      }
      if (dropped && frames > dropped && elapsed > droppedMs) {
        const without = ((frames - dropped) * 1000) / (elapsed - droppedMs);
        if (without >= target * STEP_DOWN_SHARE) { stats.forgiven += 1; slowWindows = 0; return false; }
      }
      stats.slowWindows += 1;
      slowWindows += 1;
      if (slowWindows < STEP_DOWN_WINDOWS_NEEDED) return false;
      slowWindows = 0;
      // Post effects go first: to one, then none; then overlays the same way.
      let inUse = 0;
      try { inUse = Math.max(0, Math.min(fxCap, Number(fxInUse()) || 0)); } catch (_) {}
      let overlaysOn = 0;
      try { overlaysOn = Math.max(0, Math.min(overlayCap, Number(overlaysInUse()) || 0)); } catch (_) {}
      if (inUse > 0) {
        fxCap = inUse > 1 ? 1 : 0;
        stats.fxSteps += 1;
      } else if (overlaysOn > 0) {
        overlayCap = overlaysOn > 1 ? 1 : 0;
        stats.overlaySteps += 1;
      } else if (level < levels.length - 1) {
        level += 1;
      } else return false;
      stats.steps += 1;
      stepped = true;
      if (sceneId !== null) needed.set(sceneId, { level, fx: fxCap, overlays: overlayCap });
      settleUntil = now + STEP_DOWN_SETTLE_MS;
      try {
        onStep?.({
          quality: levels[level].quality, fps: levels[level].fps, fx: fxCap, overlays: overlayCap,
        });
      } catch (_) {}
      return true;
    },
  };
}
