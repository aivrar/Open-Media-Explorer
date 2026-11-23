/**
 * The player bar's volume control: an up button, the level (0-100) as an
 * LED-style readout, and a down button, in a narrow column beside the
 * speaker (mute) button (a row on the stacked bar; base.css).
 *
 * - A click is one step of 1 (Enter or Space on a focused button too).
 * - A held button repeats: after 400 ms, one step every 50 ms, until it is
 *   let go, the pointer leaves it, the window loses focus or the level
 *   reaches 0 or 100. The timers exist only while a button is held. Each
 *   step first checks that the mouse button is still down (:active), and
 *   steps never bunch up after a busy moment (createHoldRepeat).
 * - The group can take focus (tabindex -1 in its markup), so a click on the
 *   number or between the buttons leaves the keys with the control, not
 *   with whatever holds the area around it (the Tuner's dial, say).
 * - The wheel anywhere over the control: 2 per notch, up is louder; the
 *   page does not scroll. Touchpad moves add up to whole notches.
 * - Keys on the focused control: arrows 1, Page Up / Page Down 10, Home 0,
 *   End 100 (as the old slider did).
 *
 * The level itself is kept by the caller (lib/player.js: the hidden
 * #player-volume input and setVolume); this module only reads and sets it.
 * elementVolumeChange tells the player what a media element's own controls
 * changed, so the video's volume and mute follow into the store.
 */

export const VOLUME_STEP = 1;
export const VOLUME_WHEEL_STEP = 2;
export const VOLUME_HOLD_DELAY_MS = 400;
export const VOLUME_REPEAT_MS = 50;
const WHEEL_NOTCH_PX = 100;

export function clampVolume(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function steppedVolume(current, delta) {
  return clampVolume(clampVolume(current) + delta);
}

/** What a media element's volumechange asks of the store: the new level
 *  (0-100) and mute, each null when the store already has it, or null for
 *  nothing at all. During a sleep-timer fade the level is the fade's, not
 *  the user's, so only a mute change counts (the fade never mutes). The
 *  element's 0..1 volume is rounded to the store's whole percent first. */
export function elementVolumeChange({ volume, muted, storedPct, storedMuted, fading = false }) {
  const known = !fading && Number.isFinite(Number(volume));
  const pct = clampVolume(Number(volume) * 100);
  const nextMuted = !!muted !== !!storedMuted ? !!muted : null;
  const nextPct = known && pct !== clampVolume(storedPct) ? pct : null;
  return nextMuted === null && nextPct === null ? null : { muted: nextMuted, pct: nextPct };
}

/** Volume change for one wheel event. Mouse wheels send about 100 px per
 *  notch; touchpads send many small values, pooled in `pool.px`. */
export function volumeWheelDelta(pool, event) {
  const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 100 : 1;
  pool.px += (Number(event.deltaY) || 0) * unit;
  const notches = Math.trunc(pool.px / WHEEL_NOTCH_PX);
  pool.px -= notches * WHEEL_NOTCH_PX;
  return notches === 0 ? 0 : -notches * VOLUME_WHEEL_STEP;
}

export function volumeKeyDelta(key) {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return 1;
    case 'ArrowDown':
    case 'ArrowLeft':
      return -1;
    case 'PageUp':
      return 10;
    case 'PageDown':
      return -10;
    case 'End':
      return 100;
    case 'Home':
      return -100;
    default:
      return 0;
  }
}

/** Calls onTick every `repeatMs` after a first wait of `delayMs`, until
 *  stop() or until onTick returns false. Each step schedules the next one
 *  only after it ran (a timeout, not an interval), so a main thread held up
 *  for a while (the Visualizer starting, say) can never bring a burst of
 *  steps to catch up: at most one step comes after the wait. */
export function createHoldRepeat(onTick, { delayMs = VOLUME_HOLD_DELAY_MS, repeatMs = VOLUME_REPEAT_MS, timers = globalThis } = {}) {
  let delay = null;
  let repeat = null;

  function stop() {
    if (delay !== null) {
      timers.clearTimeout(delay);
      delay = null;
    }
    if (repeat !== null) {
      timers.clearTimeout(repeat);
      repeat = null;
    }
  }

  function next() {
    repeat = timers.setTimeout(() => {
      repeat = null;
      if (onTick() === false) return;
      next();
    }, repeatMs);
  }

  function start() {
    stop();
    // The first repeated step comes when the wait ends, then every repeatMs.
    delay = timers.setTimeout(() => {
      delay = null;
      if (onTick() === false) return;
      next();
    }, delayMs);
  }

  function isActive() {
    return delay !== null || repeat !== null;
  }

  return { start, stop, isActive };
}

/** Wires the control; returns a function that removes every listener. */
export function bindVolumeStepper({ group, down, up, getVolume, setVolume, win = globalThis, timers = globalThis }) {
  const listeners = [];

  function on(target, type, fn, options) {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, fn, options);
    listeners.push([target, type, fn, options]);
  }

  // True while the level moved, so a held button stops at 0 or 100.
  function change(delta) {
    const before = clampVolume(getVolume());
    const after = steppedVolume(before, delta);
    if (after !== before) setVolume(after);
    return after !== before;
  }

  let held = 0;
  let heldButton = null;
  let heldByMouse = false;

  // Before every repeated step: is the mouse button really still down on
  // it? The browser's own :active says so even if our pointerup was lost.
  function stillPressed() {
    if (!heldByMouse || typeof heldButton?.matches !== 'function') return true;
    try { return heldButton.matches(':active'); } catch (_) { return true; }
  }

  const hold = createHoldRepeat(() => {
    if (!held || !stillPressed()) { release(); return false; }
    return change(held);
  }, { timers });

  function release() {
    held = 0;
    heldButton = null;
    heldByMouse = false;
    hold.stop();
  }

  for (const [button, delta] of [[down, -VOLUME_STEP], [up, VOLUME_STEP]]) {
    // The first step comes at once on pointerdown, so the click that
    // follows is not a second step; a keyboard click (detail 0) is one.
    on(button, 'pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      held = delta;
      heldButton = button;
      heldByMouse = e.pointerType === 'mouse';
      change(delta);
      hold.start();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      on(button, type, release);
    }
    on(button, 'click', (e) => {
      if (!e.detail) change(delta);
    });
  }

  // A release that never reaches the button still ends the hold: caught on
  // the way down (capture), so nothing on the page can stop it first, and
  // the mouse's own events too. A menu, a drag or a move with no button
  // down end it as well.
  for (const type of ['pointerup', 'pointercancel', 'mouseup', 'contextmenu', 'dragstart']) {
    on(win, type, release, { capture: true });
  }
  on(win, 'blur', release);
  on(win, 'pointermove', (e) => {
    if (held && e.buttons === 0) release();
  }, { capture: true, passive: true });

  const pool = { px: 0 };
  on(group, 'wheel', (e) => {
    // Ctrl + wheel (or a touchpad pinch) is the window's zoom, and a mainly
    // sideways move is not a volume change: both are left to the page.
    if (e.ctrlKey) return;
    if (Math.abs(Number(e.deltaX) || 0) > Math.abs(Number(e.deltaY) || 0)) return;
    e.preventDefault();
    const d = volumeWheelDelta(pool, e);
    if (d) change(d);
  }, { passive: false });

  on(group, 'keydown', (e) => {
    const d = volumeKeyDelta(e.key);
    if (!d) return;
    e.preventDefault();
    change(d);
  });

  return () => {
    release();
    for (const [target, type, fn, options] of listeners) {
      target.removeEventListener(type, fn, options);
    }
    listeners.length = 0;
  };
}
