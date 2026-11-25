/**
 * Every visible change of picture - a new scene, a scene prepared again, a
 * new look - goes through here, so none is ever a hard cut (except with
 * reduced motion, when the picture is still anyway, or while the picture is
 * not moving or not seen).
 *
 * The protocol: call begin() until it returns 0, then make the change, then
 * call applied(). A number above 0 is how many ms to wait before calling
 * begin() again (a change already in progress, or the picture still dipping
 * out). So at most one change is visible at a time: changes asked for
 * meanwhile wait, and the latest one wins (the caller keeps only that).
 *
 * Each change asks for a flash charge (one large change of light, like a
 * pulse). When the budget is full the change runs more slowly.
 *
 * A warped dissolve can snapshot the outgoing scene and composite it over
 * the incoming scene once per frame.
 * Other changes can use either of these compositor transitions:
 *   cross-fade  the outgoing frame is copied, dimmed by the brightness
 *               setting, to a 2D canvas on top,
 *               which the compositor fades from opacity 1 to 0 over the
 *               incoming frame (Web Animations). The sum is old x a + new x
 *               (1 - a), both at the same brightness: never brighter than
 *               the brighter of the two.
 *   dip         otherwise (no Web Animations, no 2D context, the copy
 *               failed): the canvas's opacity ramps down to the black backing
 *               (a CSS transition), the change is made in the dark, and it
 *               ramps back up.
 *
 * finishNow() ends whatever is running at once (the window hidden, the tab
 * paused or closed).
 *
 * Stretched: begin({ ready }) for a scene whose picture builds up slowly (a
 * density lab: density-host.js). The cross-fade starts at once but runs
 * over CROSSFADE_STRETCH_MS; ready() is asked every CROSSFADE_STRETCH_POLL_MS
 * and once it is true the rest of the fade runs at the normal pace (never
 * faster than CROSSFADE_MS for the whole way, nor shorter than CROSSFADE_MS
 * in all). A change asked for meanwhile does the same, then waits for the
 * end as for any fade. Only a cross-fade stretches (not a dip or a cut).
 */

export const CROSSFADE_MS = 600;
export const CROSSFADE_SLOW_MS = 1500;
export const WARP_DISSOLVE_MS = 1000;
// A black-to-white blend at 60 fps advances by about 0.01 in luma per
// frame, below the Visualizer flash check's 0.10 step threshold.
const WARP_DISSOLVE_SLOW_MS = 2500;
export const WARP_FALLBACK_MS = 1800;
const WARP_FRAME_MS = 1000 / 60;
// Allow slower frames to catch up by at most three 60 fps intervals.
const WARP_MAX_FRAME_MS = 3 * WARP_FRAME_MS;
export const WARP_MAX_FRAME_STEP = WARP_MAX_FRAME_MS / WARP_DISSOLVE_MS;
/** The longest a stretched cross-fade runs. */
export const CROSSFADE_STRETCH_MS = 4000;
/** How often a stretched cross-fade asks whether the picture is there. */
export const CROSSFADE_STRETCH_POLL_MS = 100;

/**
 * @param {object} deps
 *   canvas, fade (the 2D canvas on top), setTimer, clearTimer, clock (ms),
 *   brightness() (0..1), enabled() (the picture moves and is seen),
 *   drawOld() (makes the outgoing frame available in the canvas; false
 *   when unavailable), charge() (true when the flash budget had room)
 */
export function createTransition({
  canvas, fade, setTimer, clearTimer, clock, brightness, enabled, drawOld, charge, warp = null, debug = false,
}) {
  let phase = 'idle'; // idle | warping | warp-out | fading | out | dark | in
  let warpAt = 0;
  let warpFrameAt = null;
  let warpProgress = 0;
  let warpResize = null;
  let timer = 0;
  let endAt = 0;
  let duration = CROSSFADE_MS;
  let animation = null;
  // A stretched cross-fade: { ready, startedAt, total, pace, poll } until it
  // runs on at the normal pace.
  let stretch = null;
  const stats = {
    fades: 0, dips: 0, cuts: 0, slow: 0, waits: 0, stretched: 0, readyAfter: [],
    ...(debug ? { warps: 0 } : {}),
  };

  const dissolveStats = debug ? {
    started: 0, slow: 0, completed: 0, fallbacks: 0, interrupted: 0, skipped: 0, skipReasons: {}, last: null,
  } : null;
  let warpDrawnFrames;

  function skipWarp(reason) {
    if (!dissolveStats) return;
    dissolveStats.skipped += 1;
    dissolveStats.skipReasons[reason] = (dissolveStats.skipReasons[reason] || 0) + 1;
  }
  function endWarp(outcome) {
    if (!dissolveStats) return;
    dissolveStats[outcome] += 1;
    dissolveStats.last = { outcome, drawnFrames: warpDrawnFrames, durationMs: clock() - warpAt };
  }

  const level = () => {
    const b = brightness();
    return b >= 1 ? '' : String(b);
  };
  function arm(ms, then) {
    if (timer) clearTimer(timer);
    endAt = clock() + ms;
    timer = setTimer(() => { timer = 0; then(); }, ms);
  }
  function endStretch() {
    if (stretch?.poll) clearTimer(stretch.poll);
    stretch = null;
  }
  function releaseFade() {
    endStretch();
    const running = animation;
    animation = null;
    if (running) { try { running.cancel(); } catch (_) {} }
    fade.hidden = true;
    fade.width = 0; // its memory back
    fade.height = 0;
  }
  function releaseWarp() {
    warpFrameAt = null;
    warpProgress = 0;
    warp?.release();
  }
  function settle() {
    canvas.style.transition = '';
    canvas.style.opacity = level();
  }
  function rise() {
    const half = Math.round(duration / 2);
    phase = 'in';
    canvas.style.transition = `opacity ${half}ms linear`;
    canvas.style.opacity = level();
    arm(half, () => { phase = 'idle'; settle(); });
  }
  /** Transfer the last composite to the fade canvas before releasing its
   *  texture. Without a copy, hold the composite through a dip to black. */
  function finishWarpGradually() {
    duration = duration === WARP_DISSOLVE_SLOW_MS ? CROSSFADE_SLOW_MS : CROSSFADE_MS;
    if (crossFade(duration)) {
      releaseWarp();
      return true;
    }
    const half = duration / 2;
    phase = 'warp-out';
    canvas.style.transition = `opacity ${half}ms linear`;
    canvas.style.opacity = '0';
    arm(half, () => {
      const resize = warpResize;
      warpResize = null;
      releaseWarp();
      phase = 'dark';
      resize?.();
      warp.redraw();
      rise();
    });
    return false;
  }

  /** Hand off only after a gap in drawn progress, even at a low frame rate. */
  function checkWarpFallback() {
    const remaining = WARP_FALLBACK_MS - (clock() - (warpFrameAt ?? warpAt));
    if (remaining > 0) arm(remaining, checkWarpFallback);
    else {
      endWarp('fallbacks');
      if (finishWarpGradually()) warp.redraw();
    }
  }

  /** End the change now. `keepFade` (the picture stays in view: a pause):
   *  nothing seen is cut short. A cross-fade, or a dip on its way back up,
   *  runs on to its end; a dip on its way down (the change not yet made)
   *  goes back up at the same pace. */
  function finishNow({ keepFade = false } = {}) {
    if (keepFade && (phase === 'fading' || phase === 'in' || phase === 'warp-out')) return;
    if (timer) clearTimer(timer);
    timer = 0;
    if (phase === 'fading') releaseFade();
    if (phase === 'warping') endWarp(warpProgress >= 1 ? 'completed' : 'interrupted');
    if (phase === 'warping' && keepFade) {
      // A pause stops visualizer frames. Let the compositor finish the fade.
      if (finishWarpGradually()) warp.redraw();
      return;
    }
    const resize = warpResize;
    warpResize = null;
    if (phase === 'warping' || phase === 'warp-out') releaseWarp();
    if (keepFade && (phase === 'out' || phase === 'dark')) {
      canvas.style.transition = `opacity ${Math.round(duration / 2)}ms linear`;
      canvas.style.opacity = level();
    } else if (phase === 'out' || phase === 'dark' || phase === 'in' || phase === 'warp-out') settle();
    phase = 'idle';
    resize?.();
  }

  /** A stretched cross-fade from here on at the normal pace: what is left of
   *  it over at most `pace` ms for the whole way, and CROSSFADE_MS in all. */
  function settleStretch() {
    if (!stretch || phase !== 'fading') return;
    const { startedAt, total, pace } = stretch;
    endStretch();
    const gone = Math.max(0, clock() - startedAt);
    const left = Math.max(0, 1 - gone / total);
    const ms = Math.max(1, Math.round(Math.max(pace - gone, pace * left)));
    stats.readyAfter.push(Math.round(gone));
    try {
      const running = animation;
      animation = fade.animate([{ opacity: left }, { opacity: 0 }], { duration: ms, easing: 'linear', fill: 'forwards' });
      if (running) { try { running.cancel(); } catch (_) {} }
    } catch (_) {
      releaseFade();
      phase = 'idle';
      return;
    }
    arm(ms, () => { releaseFade(); phase = 'idle'; });
  }
  function pollStretch() {
    if (!stretch) return;
    stretch.poll = 0;
    let ready = false;
    try { ready = Boolean(stretch.ready()); } catch (_) { ready = true; }
    if (ready) settleStretch();
    else stretch.poll = setTimer(pollStretch, CROSSFADE_STRETCH_POLL_MS);
  }

  /** The outgoing frame, dimmed, on top, faded out by the compositor. */
  function crossFade(ms, ready = null) {
    if (typeof fade.animate !== 'function') return false;
    try {
      const g2 = fade.getContext?.('2d');
      if (!g2) return false;
      fade.width = canvas.width;
      fade.height = canvas.height;
      // The buffer holds the last picture, or it was redrawn in this task.
      if (!drawOld()) { releaseFade(); return false; }
      g2.globalAlpha = 1;
      g2.fillStyle = '#000';
      g2.fillRect(0, 0, fade.width, fade.height);
      g2.globalAlpha = brightness();
      g2.drawImage(canvas, 0, 0);
      g2.globalAlpha = 1;
      fade.hidden = false;
      const total = ready ? Math.max(ms, CROSSFADE_STRETCH_MS) : ms;
      animation = fade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: total, easing: 'linear', fill: 'forwards' });
      phase = 'fading';
      arm(total, () => { releaseFade(); phase = 'idle'; });
      if (ready) {
        stats.stretched += 1;
        stretch = { ready, startedAt: clock(), total, pace: ms, poll: 0 };
        stretch.poll = setTimer(pollStretch, CROSSFADE_STRETCH_POLL_MS);
      }
    } catch (_) {
      releaseFade();
      phase = 'idle';
      return false;
    }
    return true;
  }

  return {
    /** Ms to wait before the change may be made; 0: make it now.
     *  `ready` (optional): stretch the cross-fade until it is true.
     *  `dissolve`: true to try it, or a skip reason for a scene change. */
    begin({ ready = null, dissolve = false } = {}) {
      if (phase === 'dark') return 0;
      if (phase !== 'idle') {
        stats.waits += 1;
        // A stretched fade gives way: the rest at the normal pace.
        settleStretch();
        const by = phase === 'warping' ? warpAt + duration : endAt;
        return Math.max(phase === 'warping' ? Math.ceil(2 * WARP_FRAME_MS) : 1, Math.ceil(by - clock()));
      }
      if (!enabled()) {
        if (dissolve) skipWarp(dissolve === true ? 'not-moving-or-visible' : dissolve);
        stats.cuts += 1;
        return 0;
      }
      duration = CROSSFADE_MS;
      // A hand pick can start a slower ramp even when the flash budget is
      // full. A later change waits for this one to finish before it charges.
      const charged = charge();
      if (!charged) { duration = CROSSFADE_SLOW_MS; stats.slow += 1; }
      if (dissolve) {
        let result = dissolve;
        if (dissolve === true) {
          if (ready) result = 'stretched-fade';
          else result = warp?.capture(drawOld) ?? 'unavailable';
        }
        if (result === true) {
          phase = 'warping';
          duration = charged ? WARP_DISSOLVE_MS : WARP_DISSOLVE_SLOW_MS;
          warpAt = clock();
          arm(WARP_FALLBACK_MS, checkWarpFallback);
          if (dissolveStats) {
            stats.warps += 1;
            dissolveStats.started += 1;
            if (!charged) dissolveStats.slow += 1;
            warpDrawnFrames = 0;
          }
          return 0;
        }
        skipWarp(result || 'snapshot-unavailable');
      }
      if (crossFade(duration, typeof ready === 'function' ? ready : null)) { stats.fades += 1; return 0; }
      // Dip: down to the backing, the change in the dark, back up.
      stats.dips += 1;
      const half = Math.round(duration / 2);
      canvas.style.transition = `opacity ${half}ms linear`;
      canvas.style.opacity = '0';
      phase = 'out';
      arm(half, () => { phase = 'dark'; });
      return half;
    },
    /** The change was made. */
    applied() {
      if (phase !== 'dark') return;
      if (!enabled()) { finishNow(); return; }
      rise();
    },
    finishNow,
    beforeResize(retry) {
      if (phase === 'warping') {
        endWarp('interrupted');
        if (finishWarpGradually()) return true;
      }
      if (phase !== 'warp-out') return true;
      warpResize = retry;
      return false;
    },
    /** Advance from the last drawn frame, capping the step after a gap. */
    nextWarpProgress(at = clock()) {
      if (phase !== 'warping' || warpFrameAt === null) return warpProgress;
      const elapsed = Math.max(0, Math.min(WARP_MAX_FRAME_MS, at - warpFrameAt));
      return Math.min(1, warpProgress + elapsed / duration);
    },
    /** Commit progress only after a new composite has drawn to the screen.
     *  Redraws (at === null) keep the last frame's clock. */
    presentWarp(progress, at = clock()) {
      if (phase !== 'warping') return;
      if (dissolveStats) warpDrawnFrames += 1;
      if (at !== null && (warpFrameAt === null || progress > warpProgress)) warpFrameAt = at;
      warpProgress = progress;
      if (progress >= 1) finishNow();
    },
    get showingWarp() { return phase === 'warping' || phase === 'warp-out'; },
    get warpProgress() { return warpProgress; },
    /** The canvas owns the old picture while it dips, even after a resize. */
    get ownsOpacity() { return phase === 'out' || phase === 'dark' || phase === 'in' || phase === 'warp-out'; },
    /** A change is in progress (nothing else may start). */
    get busy() { return phase !== 'idle'; },
    get phase() { return phase; },
    get duration() { return duration; },
    get pending() { return Boolean(timer); },
    /** A stretched cross-fade is waiting for its picture. */
    get stretching() { return Boolean(stretch); },
    stats,
    ...(dissolveStats ? { dissolveStats } : {}),
  };
}
