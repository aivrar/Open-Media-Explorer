/**
 * The few small buttons over the picture (previous scene, next scene, shuffle
 * on or off, favourite star, open the side panel). They fade away
 * HUD_FADE_MS after the last mouse movement and come back on movement, a
 * touch, keyboard focus, or any key pressed while the tab is open (wherever
 * focus is: the tab's button, the page itself; the one key listener is on
 * the document and goes with the tab).
 *
 * Light by design: the fade is a CSS opacity transition (the compositor's
 * work, no script per frame). At most one timer is pending, and only while
 * the buttons are shown and not hovered or focused; mouse movement only
 * notes the time. Once faded, nothing is scheduled at all. destroy() (the
 * tab's cleanups) clears the timer. Inactive (before the photosensitivity
 * notice is accepted, while it is shown again, while the window is hidden)
 * the buttons are hidden and nothing is armed whatever happens.
 */

export const HUD_FADE_MS = 3000;

/** The marks on the buttons (written as escapes; source files stay ASCII). */
const MARKS = Object.freeze({
  prev: String.fromCharCode(0x2039),
  next: String.fromCharCode(0x203a),
  shuffle: String.fromCharCode(0x21c4),
  starOff: String.fromCharCode(0x2606),
  starOn: String.fromCharCode(0x2605),
  panel: String.fromCharCode(0x2630),
});

/**
 * @param {object} deps
 *   doc, stage (the element movement is watched on), listen (adds a listener
 *   removed when the tab closes), setTimer, clearTimer, clock
 */
export function createHud({
  doc, stage, listen, setTimer, clearTimer, clock,
}) {
  const el = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (name, label, mark, extra = {}) => el('button', `viz-hud-btn viz-hud-${name}`, {
    type: 'button', 'aria-label': label, title: label, ...extra,
  }, mark);

  const element = el('div', 'viz-hud', { role: 'toolbar', 'aria-label': 'Visualizer' });
  const prev = button('prev', 'Previous scene', MARKS.prev);
  const next = button('next', 'Next scene', MARKS.next);
  const shuffle = button('shuffle', 'Shuffle scenes', MARKS.shuffle, { 'aria-pressed': 'false' });
  const star = button('star', 'Add to favourites', MARKS.starOff, { 'aria-pressed': 'false' });
  const panel = button('panel', 'Visualizer settings', MARKS.panel, { 'aria-expanded': 'false', 'aria-controls': 'viz-panel' });
  element.append(prev, next, shuffle, star, panel);
  element.hidden = true; // until setActive(true)

  let faded = false;
  let active = false;
  let timer = 0;
  let lastActivity = clock();
  let hovered = false;
  let focused = false;
  const stats = { timers: 0, fades: 0 };

  function arm(ms) {
    if (timer) return;
    stats.timers += 1;
    timer = setTimer(check, ms);
  }
  function disarm() {
    if (timer) clearTimer(timer);
    timer = 0;
  }
  function setFaded(next) {
    if (faded === next) return;
    faded = next;
    element.classList[next ? 'add' : 'remove']('viz-hud-faded');
    stage?.classList?.[next ? 'add' : 'remove']('viz-hud-away');
    if (next) stats.fades += 1;
  }
  function check() {
    timer = 0;
    if (!active) return;
    if (hovered || focused) return; // shown while in use; armed again on leaving
    const left = lastActivity + HUD_FADE_MS - clock();
    if (left > 0) { arm(left); return; }
    setFaded(true);
  }
  /** Movement, a touch or a key: shown, and faded again HUD_FADE_MS later. */
  function wake() {
    if (!active) return;
    lastActivity = clock();
    setFaded(false);
    if (!hovered && !focused) arm(HUD_FADE_MS);
  }

  if (stage) {
    listen(stage, 'pointermove', wake);
    listen(stage, 'pointerdown', wake);
  }
  // Any key while the tab is open, not only with focus over the picture.
  const keys = typeof doc?.addEventListener === 'function' ? doc : stage;
  if (keys) listen(keys, 'keydown', wake);
  listen(element, 'pointerenter', () => { hovered = true; disarm(); if (active) setFaded(false); });
  listen(element, 'pointerleave', () => { hovered = false; wake(); });
  listen(element, 'focusin', () => { focused = true; disarm(); if (active) setFaded(false); });
  listen(element, 'focusout', (event) => {
    if (event.relatedTarget && element.contains?.(event.relatedTarget)) return;
    focused = false;
    wake();
  });

  return {
    element,
    buttons: {
      prev, next, shuffle, star, panel,
    },
    wake,
    /** On: shown (and faded HUD_FADE_MS later). Off: hidden, no timer. */
    setActive(on) {
      if (on === active) return;
      active = on;
      element.hidden = !on;
      if (on) { wake(); return; }
      disarm();
      setFaded(false);
      stage?.classList?.remove('viz-hud-away');
    },
    /** The window was hidden: no timer while nobody can see it. */
    sleep() { disarm(); },
    get active() { return active; },
    get faded() { return faded; },
    get pending() { return Boolean(timer); },
    stats,
    setShuffle(on) {
      shuffle.setAttribute('aria-pressed', on ? 'true' : 'false');
      const label = on ? 'Shuffle is on' : 'Shuffle scenes';
      shuffle.setAttribute('aria-label', label);
      shuffle.setAttribute('title', label);
    },
    setStar(on, enabled = true) {
      star.setAttribute('aria-pressed', on ? 'true' : 'false');
      star.textContent = on ? MARKS.starOn : MARKS.starOff;
      const label = on ? 'Remove from favourites' : 'Add to favourites';
      star.setAttribute('aria-label', label);
      star.setAttribute('title', label);
      star.disabled = !enabled;
    },
    setPanel(open) { panel.setAttribute('aria-expanded', open ? 'true' : 'false'); },
    destroy() { disarm(); },
  };
}
