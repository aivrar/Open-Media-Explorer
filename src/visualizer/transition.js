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
 * Each change is charged to the flash limiter's budget (one large change of
 * light, like a pulse). When the budget is full the change still happens
 * but over CROSSFADE_SLOW_MS instead of CROSSFADE_MS.
 *
 * Two ways, the first when the browser can:
 *   cross-fade  the outgoing frame is drawn once more and copied, already
 *               dimmed by the brightness setting, to a 2D canvas on top,
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
 */

export const CROSSFADE_MS = 600;
export const CROSSFADE_SLOW_MS = 1500;

export const TRANSITION_KINDS = Object.freeze({ fade: 'fade', dip: 'dip', cut: 'cut' });

/**
 * @param {object} deps
 *   canvas, fade (the 2D canvas on top), setTimer, clearTimer, clock (ms),
 *   brightness() (0..1), enabled() (the picture moves and is seen),
 *   drawOld() (draws the outgoing frame into the canvas; false: nothing to
 *   draw), charge() (true when the flash budget had room; charged)
 */
export function createTransition({
  canvas, fade, setTimer, clearTimer, clock, brightness, enabled, drawOld, charge,
}) {
  let phase = 'idle'; // idle | fading | out | dark | in
  let timer = 0;
  let endAt = 0;
  let duration = CROSSFADE_MS;
  let animation = null;
  const stats = {
    fades: 0, dips: 0, cuts: 0, slow: 0, waits: 0,
  };

  const level = () => {
    const b = brightness();
    return b >= 1 ? '' : String(b);
  };
  function arm(ms, then) {
    if (timer) clearTimer(timer);
    endAt = clock() + ms;
    timer = setTimer(() => { timer = 0; then(); }, ms);
  }
  function releaseFade() {
    const running = animation;
    animation = null;
    if (running) { try { running.cancel(); } catch (_) {} }
    fade.hidden = true;
    fade.width = 0; // its memory back
    fade.height = 0;
  }
  function settle() {
    canvas.style.transition = '';
    canvas.style.opacity = level();
  }
  /** End the change now. `keepFade` (the picture stays in view: a pause):
   *  nothing seen is cut short. A cross-fade, or a dip on its way back up,
   *  runs on to its end; a dip on its way down (the change not yet made)
   *  goes back up at the same pace. */
  function finishNow({ keepFade = false } = {}) {
    if (keepFade && (phase === 'fading' || phase === 'in')) return;
    if (timer) clearTimer(timer);
    timer = 0;
    if (phase === 'fading') releaseFade();
    if (keepFade && (phase === 'out' || phase === 'dark')) {
      canvas.style.transition = `opacity ${Math.round(duration / 2)}ms linear`;
      canvas.style.opacity = level();
    } else if (phase === 'out' || phase === 'dark' || phase === 'in') settle();
    phase = 'idle';
  }

  /** The outgoing frame, dimmed, on top, faded out by the compositor. */
  function crossFade(ms) {
    if (typeof fade.animate !== 'function') return false;
    const g2 = fade.getContext?.('2d');
    if (!g2) return false;
    try {
      fade.width = canvas.width;
      fade.height = canvas.height;
      // Drawn and copied in the same task, so the drawing buffer still holds it.
      if (!drawOld()) { releaseFade(); return false; }
      g2.globalAlpha = 1;
      g2.fillStyle = '#000';
      g2.fillRect(0, 0, fade.width, fade.height);
      g2.globalAlpha = brightness();
      g2.drawImage(canvas, 0, 0);
      g2.globalAlpha = 1;
      fade.hidden = false;
      animation = fade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'linear', fill: 'forwards' });
    } catch (_) {
      releaseFade();
      return false;
    }
    phase = 'fading';
    arm(ms, () => { releaseFade(); phase = 'idle'; });
    return true;
  }

  return {
    /** Ms to wait before the change may be made; 0: make it now. */
    begin() {
      if (phase === 'dark') return 0;
      if (phase !== 'idle') {
        stats.waits += 1;
        return Math.max(1, Math.ceil(endAt - clock()));
      }
      if (!enabled()) { stats.cuts += 1; return 0; }
      duration = CROSSFADE_MS;
      // Not charged when the budget is full, by choice (slice 4): a 1.5 s ramp
      // is a gradual change, not a pulse, and holding a change asked for by
      // hand up to a second would feel broken. It is never cut short while it
      // can be seen (finishNow keepFade) nor restarted fast: a change asked for
      // during it waits for its end, then charges again.
      if (!charge()) { duration = CROSSFADE_SLOW_MS; stats.slow += 1; }
      if (crossFade(duration)) { stats.fades += 1; return 0; }
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
      const half = Math.round(duration / 2);
      phase = 'in';
      canvas.style.transition = `opacity ${half}ms linear`;
      canvas.style.opacity = level();
      arm(half, () => { phase = 'idle'; settle(); });
    },
    finishNow,
    /** A change is in progress (nothing else may start). */
    get busy() { return phase !== 'idle'; },
    /** The canvas's opacity belongs to the dip just now (brightness waits). */
    get ownsOpacity() { return phase === 'out' || phase === 'dark' || phase === 'in'; },
    get phase() { return phase; },
    get duration() { return duration; },
    get pending() { return Boolean(timer); },
    stats,
  };
}
