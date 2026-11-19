/**
 * When the Visualizer draws, and with what time and sound. No WebGL here (the
 * picture is drawn by the `draw` callback), so all of it can be tested with
 * fake clocks.
 *
 * - Sound playing: the loop subscribes to the shared sound signal
 *   (lib/audio-signal.js) at the chosen frame rate (15, 30 or 60) and draws
 *   inside each signal frame, so there is one read and one draw per frame and
 *   no second loop. With a `react` hook (the Beat Reactor, reactor.js) the
 *   subscription asks for the float spectrum too, and the hook turns each
 *   frame (or silence, when idle) into the scene's sound values and the time
 *   surge; without one the loop smooths the signal's own band levels. With
 *   the hook the signal is read at least MIN_REACT_FPS times a second; at 15
 *   frames a second every other frame only feeds the reactor.
 * - Nothing to hear (paused, stopped, muted, volume 0, no readable sound): the
 *   signal rests, and the picture keeps moving slowly on its own timer at
 *   VISUALIZER_IDLE_FPS (a timer, then one animation frame, like the signal),
 *   for the first VISUALIZER_IDLE_SECONDS of the spell. Never both at once.
 * - A longer spell without sound (rest): the last picture is held and nothing
 *   at all is scheduled. The signal subscription stays (a resting signal
 *   schedules nothing either), so sound brings the motion back at once. A
 *   resize or quality change draws that same picture again at the new size.
 *   Every new spell without sound (after sound, or after the motion was
 *   stopped by a hidden document, reduced motion or a lost context) starts
 *   with a fresh VISUALIZER_IDLE_SECONDS.
 * - Hidden document, lost graphics context, or stopped: nothing is scheduled
 *   and the signal subscription is dropped.
 * - Minimised window: WebView2 keeps the document "visible" but gives about
 *   one animation frame a second. Two long gaps in a row mean the window is
 *   not being shown, and frames are skipped (not drawn) until they come at
 *   the normal pace again (status.throttled says so).
 *
 * Frame-rate readout (status.fps): counted afresh whenever the state changes
 * (live, idle, rest, throttled or not, frame rate), never across a long gap, and
 * null until a whole second of the current state has been counted, so a
 * number from one state is never shown with another.
 * - Reduced motion (prefers-reduced-motion, as the player-bar meter): no
 *   subscription and no loop; one still picture, drawn again only on resize.
 */

import { MAX_DT } from '../lib/audio-signal.js';
import { smoothToward } from '../lib/player-meter.js';
import {
  DEFAULT_VISUALIZER_FPS, VISUALIZER_IDLE_FPS, VISUALIZER_IDLE_SECONDS, normalizeVisualizerFps,
} from '../lib/visualizer-settings.js';

/** A gap between frames longer than this, twice in a row, means the host is
 *  throttling frames (minimised or covered window). */
export const THROTTLE_GAP_MS = 400;
/** The picture runs at half speed while there is no sound, eased over about
 *  a second either way so it never jumps. */
export const IDLE_TIME_RATE = 0.5;
export const TIME_RATE_SECONDS = 0.8;
/** Smoothing of the sound values given to the shader (seconds). */
export const AUDIO_ATTACK = 0.04;
export const AUDIO_RELEASE = 0.3;
/** The longest frame step (state.dt) of an idle frame, in idle frame
 *  intervals: idle frames are further apart than MAX_DT (the cap for live
 *  frames and restarts). The scene clock itself moves at most
 *  MAX_SCENE_STEP_S per drawn frame, live or idle. */
export const IDLE_DT_INTERVALS = 1.5;
/** The time surge a `react` hook may ask for is taken only below this (the
 *  reactor's own surge stays under 3x). */
export const MAX_SPEED = 4;
/** With a `react` hook the sound is read at least this often, whatever the
 *  drawing rate: the reactor's onset and tempo detection miss beats when fed
 *  only 15 times a second (a 120 BPM kick read every 67 ms came out as 60
 *  BPM). Frames between draws only update the reactor. */
export const MIN_REACT_FPS = 30;
/** The most the scene clock moves between two drawn frames, live or idle
 *  (s, before its rate and speed): one
 *  frame at 30 a second, the rate the flash check measures at. A frame that
 *  comes late (a heavy scene, a busy computer, 15 frames a second chosen or
 *  stepped down to) slows the picture down instead of making a bigger jump
 *  in light than the check allowed: the tester saw Mandelbrot and Tricorn
 *  step over 0.10 in the real window where late frames made each step
 *  larger, while the check at an even 30 passed them. */
export const MAX_SCENE_STEP_S = 1 / 30;

export const LOOP_MODES = Object.freeze({
  off: 'off', // not started, or stopped
  still: 'still', // reduced motion: one still picture
  paused: 'paused', // document hidden or the graphics context is lost
  idle: 'idle', // moving on its own clock, no sound (the start of a spell)
  rest: 'rest', // no sound for longer: the last picture held, nothing scheduled
  live: 'live', // drawing in the sound signal's frames
});

export function createVisualizerLoop({
  signal,
  draw,
  onStatus = null,
  fps: chosenFps = DEFAULT_VISUALIZER_FPS,
  react = null,
  idleFps = VISUALIZER_IDLE_FPS,
  idleSeconds = VISUALIZER_IDLE_SECONDS,
  doc = globalThis.document,
  win = globalThis.window,
  requestFrame = (fn) => globalThis.requestAnimationFrame(fn),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  let targetFps = normalizeVisualizerFps(chosenFps);
  let started = false;
  let destroyed = false;
  let suspended = false;
  let reducedMotion = false;
  let unsubscribe = null;
  let live = false;
  let mode = LOOP_MODES.off;
  // Idle loop: one timer or one animation frame pending at a time.
  let idleTimer = 0;
  let idleFrame = 0;
  let idleDue = 0;
  let idleSince = Number.NaN; // clock ms the current spell without sound began
  const idleMaxDt = Math.max(MAX_DT, IDLE_DT_INTERVALS / idleFps);
  // Picture clock.
  let time = 0;
  let rate = IDLE_TIME_RATE;
  let lastDrawMs = Number.NaN;
  let lastReactMs = Number.NaN;
  let lastCallbackMs = Number.NaN;
  let longGaps = 0;
  let throttled = false; // frames come throttled, so they are skipped
  // Frame-rate readout.
  let windowStart = Number.NaN;
  let windowFrames = 0;
  let fps = null;
  let reactFailed = false;
  const audio = { bass: 0, mid: 0, high: 0, level: 0 };
  const beat = { kick: 0, snare: 0, hat: 0, clock: 0 }; // filled by `react`
  // speed: the time surge (1 = normal); zoom: the zoom punch (1 = none);
  // sources: the limited values the scene's parameter links read (null:
  // links at rest).
  const state = {
    time: 0, dt: 0, audio, beat, speed: 1, zoom: 1, sources: null, live: false, still: false,
  };
  const stats = {
    draws: 0, liveDraws: 0, idleDraws: 0, skipped: 0, stills: 0, rests: 0, reactOnly: 0,
  };
  const cleanups = [];

  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const wantMotion = () => started && !destroyed && !suspended && !reducedMotion && visible();
  const moving = () => mode === LOOP_MODES.idle || mode === LOOP_MODES.live;

  function report() {
    try { onStatus?.({ mode, fps, throttled, targetFps }); } catch (_) {}
  }

  /** Start counting frames afresh: no number until a whole second is counted. */
  function resetReadout() {
    fps = null;
    windowStart = Number.NaN;
    windowFrames = 0;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    if (!moving()) throttled = false;
    if (next === LOOP_MODES.idle) idleSince = clock();
    resetReadout();
    report();
  }

  /** Count a drawn frame. A frame after a long gap starts a new count (the
   *  gap is not a frame rate). */
  function countFrame(now, afterLongGap) {
    if (afterLongGap || !Number.isFinite(windowStart)) { windowStart = now; windowFrames = 0; return; }
    windowFrames += 1;
    const elapsed = now - windowStart;
    if (elapsed < 1000) return;
    const next = Math.round((windowFrames * 1000) / elapsed);
    windowStart = now;
    windowFrames = 0;
    if (next !== fps) { fps = next; report(); }
  }

  function callDraw() {
    try {
      draw(state);
      stats.draws += 1;
    } catch (error) {
      console.error('visualizer draw failed:', error);
    }
  }

  /** The `react` hook for one frame at `now` (ms), with its own time step
   *  (it may run between draws). */
  function reactStep(now, source) {
    const maxDt = live ? MAX_DT : idleMaxDt;
    let dt = Number.isFinite(lastReactMs) ? (now - lastReactMs) / 1000 : 0;
    dt = dt <= 0 ? 0 : (dt >= maxDt ? maxDt : dt);
    lastReactMs = now;
    try {
      react(state, source, now / 1000, dt);
    } catch (error) {
      if (!reactFailed) { reactFailed = true; console.error('visualizer sound reaction failed:', error); }
    }
  }

  /** Frames a second the signal is asked for: the drawing rate, or more
   *  with a `react` hook (MIN_REACT_FPS). */
  const signalFps = () => (react && targetFps < MIN_REACT_FPS ? MIN_REACT_FPS : targetFps);

  /** A live frame that is not due to be drawn (the signal runs faster than
   *  the drawing rate): only the reactor hears it. Due within half a signal
   *  frame counts as due, so 15 of 30 frames a second are drawn. */
  function drawDue(now) {
    if (!Number.isFinite(lastDrawMs)) return true;
    const slack = 500 / signalFps();
    return now - lastDrawMs >= 1000 / targetFps - slack;
  }

  /** One moving frame at `now` (ms), with the signal frame when live. */
  function render(now, frame) {
    const longGap = now - lastCallbackMs > THROTTLE_GAP_MS;
    longGaps = longGap ? longGaps + 1 : 0;
    lastCallbackMs = now;
    const source = live && frame?.active ? frame : null;
    if (live && react && !throttled && !longGap && !drawDue(now)) {
      reactStep(now, source);
      stats.reactOnly += 1;
      return;
    }
    const maxDt = live ? MAX_DT : idleMaxDt;
    let dt = Number.isFinite(lastDrawMs) ? (now - lastDrawMs) / 1000 : 0;
    dt = dt <= 0 ? 0 : (dt >= maxDt ? maxDt : dt);
    lastDrawMs = now;
    if ((longGaps >= 2) !== throttled) {
      throttled = longGaps >= 2;
      resetReadout();
      report();
    }
    if (throttled) { stats.skipped += 1; return; }
    rate = smoothToward(rate, live ? 1 : IDLE_TIME_RATE, dt, TIME_RATE_SECONDS, TIME_RATE_SECONDS);
    if (react) {
      reactStep(now, source);
    } else {
      audio.bass = smoothToward(audio.bass, source ? source.bass : 0, dt, AUDIO_ATTACK, AUDIO_RELEASE);
      audio.mid = smoothToward(audio.mid, source ? source.mid : 0, dt, AUDIO_ATTACK, AUDIO_RELEASE);
      audio.high = smoothToward(audio.high, source ? source.high : 0, dt, AUDIO_ATTACK, AUDIO_RELEASE);
      audio.level = smoothToward(audio.level, source ? source.level : 0, dt, AUDIO_ATTACK, AUDIO_RELEASE);
    }
    const speed = state.speed > 0 && state.speed < MAX_SPEED ? state.speed : 1;
    // Live or idle: an idle draw (5 a second) moves the scene no further
    // than one live frame would; the picture winds down slower instead.
    time += (dt > MAX_SCENE_STEP_S ? MAX_SCENE_STEP_S : dt) * rate * speed;
    state.time = time;
    state.dt = dt;
    state.live = live;
    state.still = false;
    callDraw();
    if (live) stats.liveDraws += 1; else stats.idleDraws += 1;
    countFrame(now, longGap);
  }

  /* ---- Idle loop ---- */

  function cancelIdle() {
    if (idleTimer) clearTimer(idleTimer);
    if (idleFrame) cancelFrame(idleFrame);
    idleTimer = 0;
    idleFrame = 0;
  }

  const idling = () => wantMotion() && !live && mode === LOOP_MODES.idle;

  function startIdle() {
    if (idleTimer || idleFrame || !idling()) return;
    idleDue = clock();
    idleFrame = requestFrame(onIdleFrame);
  }

  function onIdleTick() {
    idleTimer = 0;
    if (!idling() || idleFrame) return;
    idleFrame = requestFrame(onIdleFrame);
  }

  function onIdleFrame() {
    idleFrame = 0;
    if (!idling()) return;
    render(clock(), null);
    const now = clock();
    if (now - idleSince >= idleSeconds * 1000) {
      // Long enough without sound: hold this picture, schedule nothing.
      stats.rests += 1;
      setMode(LOOP_MODES.rest);
      return;
    }
    // Next tick one interval after this one was due; far behind: start afresh.
    const interval = 1000 / idleFps;
    idleDue += interval;
    if (!(idleDue >= now - interval)) idleDue = now;
    const delay = idleDue - now;
    idleTimer = setTimer(onIdleTick, delay > 0 ? delay : 0);
  }

  /* ---- Sound signal ---- */

  function onSignal(frame) {
    if (!wantMotion()) return;
    const hasSound = frame.active === true && frame.running !== false;
    if (hasSound) {
      if (!live) {
        live = true;
        cancelIdle();
        setMode(LOOP_MODES.live);
      }
      render(clock(), frame);
    } else if (live) {
      live = false;
      setMode(LOOP_MODES.idle);
      startIdle();
    }
  }

  const subscription = () => ({ fps: signalFps(), floatSpectrum: Boolean(react) });

  function subscribe() {
    if (!signal) return;
    unsubscribe = signal.subscribe(onSignal, subscription());
  }

  function drawStill() {
    state.time = time;
    state.dt = 0;
    state.live = false;
    state.still = true;
    state.speed = 1;
    state.zoom = 1;
    state.sources = null;
    audio.bass = 0; audio.mid = 0; audio.high = 0; audio.level = 0;
    beat.kick = 0; beat.snare = 0; beat.hat = 0; beat.clock = 0;
    callDraw();
    stats.stills += 1;
  }

  /** Bring subscriptions and loops in line with the current conditions. */
  function sync() {
    if (wantMotion()) {
      if (!moving() && mode !== LOOP_MODES.rest) {
        // (Re)starting motion: fresh clocks, no jump, a fresh spell.
        lastDrawMs = Number.NaN;
        lastReactMs = Number.NaN;
        lastCallbackMs = Number.NaN;
        longGaps = 0;
        throttled = false;
        live = false;
        setMode(LOOP_MODES.idle);
      }
      if (!unsubscribe) subscribe();
      if (!live) startIdle(); // (not at rest: that waits for sound)
      return;
    }
    cancelIdle();
    live = false;
    if (unsubscribe) {
      const off = unsubscribe;
      unsubscribe = null;
      off();
    }
    if (!started || destroyed) setMode(LOOP_MODES.off);
    else if (suspended || !visible()) setMode(LOOP_MODES.paused);
    else {
      setMode(LOOP_MODES.still);
      drawStill();
    }
  }

  if (doc?.addEventListener) {
    doc.addEventListener('visibilitychange', sync);
    cleanups.push(() => doc.removeEventListener('visibilitychange', sync));
  }
  if (typeof win?.matchMedia === 'function') {
    const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motion?.matches === true;
    const onMotion = () => { reducedMotion = motion.matches === true; sync(); };
    motion?.addEventListener?.('change', onMotion);
    cleanups.push(() => motion?.removeEventListener?.('change', onMotion));
  }

  return {
    start() { if (destroyed) return; started = true; sync(); },
    stop() { started = false; sync(); },
    /** Graphics context lost (true) or back (false). */
    setSuspended(next) { suspended = next === true; sync(); },
    /** Frames a second while sound plays (15, 30 or 60). */
    setFps(next) {
      const value = normalizeVisualizerFps(next);
      if (value === targetFps) return;
      targetFps = value;
      // Subscribing the same listener again changes its rate in place.
      if (unsubscribe && signal) unsubscribe = signal.subscribe(onSignal, subscription());
      if (moving()) resetReadout(); // a new rate: count afresh
      report();
    },
    /** Draw again without moving time on (after a resize cleared the canvas). */
    redraw() {
      if (destroyed || !started || suspended || !visible()) return;
      if (mode === LOOP_MODES.still) drawStill();
      else if (moving() || mode === LOOP_MODES.rest) {
        state.dt = 0;
        callDraw();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      started = false;
      sync();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    get mode() { return mode; },
    /** Frames a second over the last whole second of this state; null before. */
    get fps() { return fps; },
    get throttled() { return throttled; },
    get subscribed() { return Boolean(unsubscribe); },
    get pending() { return (idleTimer ? 1 : 0) + (idleFrame ? 1 : 0); },
    get reducedMotion() { return reducedMotion; },
    /** The chosen frame rate while sound plays. */
    get targetFps() { return targetFps; },
    state,
    stats,
  };
}
