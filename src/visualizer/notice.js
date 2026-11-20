/**
 * The photosensitivity notice, shown the first time the Visualizer tab is
 * opened, before anything is loaded or moves (the `visualizerNoticeSeen`
 * setting is set once it is accepted), and again from the side panel's line,
 * which pauses the picture behind it just the same.
 *
 * "Continue" accepts it. "Not now" leaves the picture still (or, the first
 * time, the empty placeholder) with a button to start. Escape is "Not now".
 *
 * A modal dialog: Tab and Shift+Tab stay inside it, the rest of the
 * visualizer is made inert while it is open (setInert), and focus goes back
 * where it was when it closes.
 */

export const NOTICE = Object.freeze({
  title: 'Before the picture moves',
  text: [
    'The Visualizer shows moving, pulsing and color-changing patterns that follow the music.',
    'If you, or anyone watching, may be sensitive to flashing lights or patterns (photosensitive epilepsy), please use discretion.',
    'A flash limiter is always on: it keeps light pulses to at most three a second and fades between scenes, but it cannot rule out every risk.',
  ],
  continue: 'Continue',
  notNow: 'Not now',
  still: 'The picture is still.',
  start: 'Start the Visualizer',
  again: 'About flashing and photosensitivity',
});

/**
 * @param {object} deps
 *   doc, listen, onContinue(), onNotNow(), setInert(on) (the rest of the
 *   visualizer inert or not)
 */
export function createNotice({
  doc, listen, onContinue, onNotNow, setInert = () => {},
}) {
  const el = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const focus = (node) => { try { node?.focus?.(); } catch (_) {} };

  const element = el('div', 'viz-notice', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'viz-notice-title', 'aria-describedby': 'viz-notice-text',
  });
  const box = el('div', 'viz-notice-box');
  const title = el('h2', 'viz-notice-title', { id: 'viz-notice-title' }, NOTICE.title);
  const body = el('div', 'viz-notice-text', { id: 'viz-notice-text' });
  for (const line of NOTICE.text) body.append(el('p', '', {}, line));
  const actions = el('div', 'viz-notice-actions');
  const accept = el('button', 'viz-notice-btn viz-notice-continue', { type: 'button' }, NOTICE.continue);
  const decline = el('button', 'viz-notice-btn', { type: 'button' }, NOTICE.notNow);
  actions.append(accept, decline);
  box.append(title, body, actions);
  element.append(box);
  element.hidden = true;
  const stops = [accept, decline]; // what Tab moves between

  // The still picture's start button.
  const startBox = el('div', 'viz-start');
  const startText = el('p', 'viz-start-text', {}, NOTICE.still);
  const start = el('button', 'viz-notice-btn viz-notice-continue', { type: 'button' }, NOTICE.start);
  startBox.append(startText, start);
  startBox.hidden = true;

  let returnTo = null; // focused before the notice opened

  function close() {
    if (element.hidden) return false;
    element.hidden = true;
    setInert(false);
    return true;
  }

  listen(accept, 'click', () => onContinue());
  listen(start, 'click', () => onContinue());
  listen(decline, 'click', () => onNotNow());
  listen(element, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      onNotNow();
      return;
    }
    if (event.key !== 'Tab') return;
    // Kept inside: from the last to the first, and back.
    event.preventDefault?.();
    const at = stops.indexOf(doc.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const next = at < 0 ? (step > 0 ? 0 : stops.length - 1) : (at + step + stops.length) % stops.length;
    focus(stops[next]);
  });

  return {
    element,
    startBox,
    buttons: { accept, decline, start },
    get open() { return !element.hidden; },
    /** The notice itself (modal). */
    show() {
      startBox.hidden = true;
      if (element.hidden) {
        const active = doc.activeElement;
        returnTo = active && !element.contains?.(active) ? active : null;
      }
      element.hidden = false;
      setInert(true);
      focus(accept);
    },
    /** The still picture and its start button. */
    showStart() {
      close();
      startBox.hidden = false;
      focus(start);
    },
    /** Both gone (the picture moves); focus back where it was. */
    hide() {
      const was = close();
      startBox.hidden = true;
      if (was && returnTo && returnTo !== doc.body) focus(returnTo);
      returnTo = null;
    },
  };
}
