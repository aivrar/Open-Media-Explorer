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
/** The longest a stretched cross-fade runs. */
export const CROSSFADE_STRETCH_MS = 4000;
/** How often a stretched cross-fade asks whether the picture is there. */
export const CROSSFADE_STRETCH_POLL_MS = 100;

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
  // A stretched cross-fade: { ready, startedAt, total, pace, poll } until it
  // runs on at the normal pace.
  let stretch = null;
  const stats = {
    fades: 0, dips: 0, cuts: 0, slow: 0, waits: 0, stretched: 0, readyAfter: [],
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
     *  `ready` (optional): stretch the cross-fade until it is true. */
    begin({ ready = null } = {}) {
      if (phase === 'dark') return 0;
      if (phase !== 'idle') {
        stats.waits += 1;
        // A stretched fade gives way: the rest at the normal pace.
        settleStretch();
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
    /** A stretched cross-fade is waiting for its picture. */
    get stretching() { return Boolean(stretch); },
    stats,
  };
}
