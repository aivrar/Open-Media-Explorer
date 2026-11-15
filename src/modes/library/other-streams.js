/**
 * "Other streams" in the Library detail panel of a Radio Browser station: a
 * button that looks up other directory entries for the same station
 * (lib/other-streams.js has the rule) and lists them with a Play button each.
 *
 * Nothing is switched or chosen automatically. Playing a row plays that
 * entry as an ordinary item with its own id, so favouriting it is the usual
 * favourite of that entry; the station the panel was opened for is left as
 * it is. All text is set as plain text: station names are directory data.
 */

import { catalogScheduler, CATALOG_PRIORITY } from '../../lib/catalog-scheduler.js';
import { loadAdapter } from '../../lib/sources.js';
import {
  OTHER_STREAMS_LIMIT, OTHER_STREAMS_SOURCE, canFindOtherStreams,
} from '../../lib/other-streams.js';
import { streamQualityLabel } from '../../lib/stream-quality.js';
import { el } from './utils.js';

export const OTHER_STREAMS_TEXT = Object.freeze({
  button: 'Other streams',
  loading: 'Looking for other streams\u2026',
  empty: 'No other streams found for this station.',
  failed: 'Could not look up other streams.',
  retry: 'Retry',
  sameStation: 'Other streams of this station',
  sameName: 'Stations with the same name. They may be different stations.',
  playlistNote: 'Other streams are offered only for Radio Browser stations, not for playlist items.',
});

const SECTION_ID = 'library-other-streams';

/** One request through the catalog queue, at the priority of what the user
 *  is looking at. Equal requests for one station share the same answer. */
export function findOtherStreamsQueued(item, { signal } = {}) {
  return catalogScheduler.enqueue({
    sourceId: OTHER_STREAMS_SOURCE,
    key: `other-streams:${item.id}`,
    priority: CATALOG_PRIORITY.USER,
    signal,
    task: async ({ signal: taskSignal }) => {
      const adapter = await loadAdapter(OTHER_STREAMS_SOURCE);
      return adapter.findOtherStreams(item, { signal: taskSignal, limit: OTHER_STREAMS_LIMIT });
    },
  });
}

function clear(node) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else node.textContent = '';
}

/** The closest ancestor that scrolls its own content (the detail panel); null
 *  rather than the page itself, which is never scrolled for this. */
export function scrollContainerOf(node) {
  const doc = node?.ownerDocument || globalThis.document;
  const view = doc?.defaultView || globalThis;
  for (let parent = node?.parentNode; parent && parent.nodeType === 1; parent = parent.parentNode) {
    if (parent === doc?.body || parent === doc?.documentElement) return null;
    let overflowY = '';
    try { overflowY = view.getComputedStyle?.(parent)?.overflowY || ''; } catch (_) { overflowY = ''; }
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
  }
  return null;
}

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch (_) {
    return false;
  }
}

/**
 * Scroll `scroller` the least it takes to show all of `node` (like
 * scrollIntoView with block 'nearest', but only this one container, so the
 * page never moves). Focus is not touched. Returns true when it scrolled.
 */
export function revealInScroller(node, scroller, { reducedMotion = prefersReducedMotion() } = {}) {
  if (!node || !scroller || typeof node.getBoundingClientRect !== 'function'
      || typeof scroller.getBoundingClientRect !== 'function') return false;
  const box = node.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const top = frame.top + (Number(scroller.clientTop) || 0);
  const height = Number(scroller.clientHeight) || (frame.bottom - frame.top);
  const bottom = top + height;
  let delta = 0;
  if (box.top < top) delta = box.top - top;
  else if (box.bottom > bottom) delta = Math.min(box.bottom - bottom, box.top - top); // a tall section shows its top
  if (!(Math.abs(delta) >= 1)) return false; // already fully visible
  const behavior = reducedMotion ? 'auto' : 'smooth';
  if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top: delta, behavior });
  else scroller.scrollTop = (Number(scroller.scrollTop) || 0) + delta;
  return true;
}

function streamFacts(stream) {
  return [streamQualityLabel(stream), stream.country].filter(Boolean).join(' \u00B7 ')
    || 'Format not listed';
}

/**
 * Controls for one detail panel. Returns `{ button, section, note, abort }`:
 * `button` and `section` for a Radio Browser station, `note` (one line) for a
 * radio item from the user's playlists, and nulls for anything else.
 * `find(item, { signal })` resolves `{ streams, total, sameNameOnly }`;
 * `onPlay(stream)` plays a listed entry.
 */
export function createOtherStreams(item, {
  find = findOtherStreamsQueued,
  onPlay = () => {},
  getScroller = scrollContainerOf,
  reducedMotion = prefersReducedMotion,
} = {}) {
  const none = { button: null, section: null, note: null, abort() {} };
  if (!item || item.__contentHidden === true) return none;
  if (!canFindOtherStreams(item)) {
    if (item.source === 'playlist' && item.type === 'radio') {
      return { ...none, note: el('p', { className: 'other-streams-note', text: OTHER_STREAMS_TEXT.playlistNote }) };
    }
    return none;
  }

  let controller = null;
  const button = el('button', {
    className: 'btn',
    text: OTHER_STREAMS_TEXT.button,
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': SECTION_ID },
  });
  const header = el('p', { className: 'other-streams-header' });
  const status = el('p', {
    className: 'other-streams-status',
    attrs: { role: 'status', 'aria-live': 'polite', tabindex: '-1' },
  });
  const retry = el('button', {
    className: 'btn btn-small other-streams-retry',
    text: OTHER_STREAMS_TEXT.retry,
    attrs: { type: 'button' },
  });
  const list = el('ul', { className: 'other-streams-list' });
  const section = el('section', {
    className: 'other-streams',
    attrs: { id: SECTION_ID, 'aria-label': OTHER_STREAMS_TEXT.button },
  }, header, status, retry, list);
  section.hidden = true;
  header.hidden = true;
  retry.hidden = true;
  list.hidden = true;

  const abort = () => {
    if (controller && !controller.signal.aborted) controller.abort();
    controller = null;
  };

  /** At small window sizes the section opens below the visible part of the
   *  detail panel: bring it into view there. Nothing happens once it is
   *  collapsed again or the panel has moved on to another item. */
  const reveal = () => {
    if (section.hidden || button.getAttribute('aria-expanded') !== 'true' || section.isConnected === false) return;
    try {
      revealInScroller(section, getScroller(section), { reducedMotion: reducedMotion() });
    } catch (_) { /* scrolling is only a convenience */ }
  };

  const renderRows = (streams) => {
    clear(list);
    for (const stream of streams) {
      const name = stream.title || 'Unnamed station';
      const play = el('button', {
        className: 'btn btn-small',
        text: 'Play',
        attrs: { type: 'button', 'aria-label': `Play ${name}` },
        on: { click: () => onPlay(stream) },
      });
      list.appendChild(el('li', { className: 'other-stream' },
        el('div', { className: 'other-stream-text' },
          el('span', { className: 'other-stream-name', text: name, attrs: { title: name } }),
          el('span', { className: 'other-stream-facts', text: streamFacts(stream) })),
        play));
    }
    list.hidden = streams.length === 0;
  };

  const showResult = (result) => {
    const streams = Array.isArray(result?.streams) ? result.streams.slice(0, OTHER_STREAMS_LIMIT) : [];
    section.removeAttribute('aria-busy');
    renderRows(streams);
    if (streams.length === 0) {
      header.hidden = true;
      status.textContent = OTHER_STREAMS_TEXT.empty;
      return;
    }
    header.textContent = result.sameNameOnly === true ? OTHER_STREAMS_TEXT.sameName : OTHER_STREAMS_TEXT.sameStation;
    header.hidden = false;
    const total = Math.max(streams.length, Number(result.total) || 0);
    status.textContent = total > streams.length
      ? `Showing ${streams.length} of ${total}.`
      : `${streams.length} found.`;
  };

  const load = () => {
    abort();
    const mine = new AbortController();
    controller = mine;
    section.setAttribute('aria-busy', 'true');
    header.hidden = true;
    retry.hidden = true;
    clear(list);
    list.hidden = true;
    status.textContent = OTHER_STREAMS_TEXT.loading;
    let request;
    try {
      request = Promise.resolve(find(item, { signal: mine.signal }));
    } catch (error) {
      request = Promise.reject(error);
    }
    return request.then((result) => {
      if (controller !== mine || mine.signal.aborted) return;
      showResult(result);
      reveal();
    }, (error) => {
      if (controller !== mine || mine.signal.aborted) return;
      console.warn('Other streams lookup failed:', error);
      section.removeAttribute('aria-busy');
      status.textContent = OTHER_STREAMS_TEXT.failed;
      retry.hidden = false;
      reveal();
    });
  };

  retry.addEventListener('click', () => {
    const pending = load();
    // The Retry button hides while loading; keep keyboard focus in the list.
    status.focus?.();
    return pending;
  });
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') {
      abort();
      section.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      return undefined;
    }
    section.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const pending = load();
    reveal(); // the loading line
    return pending;
  });

  return { button, section, note: null, abort };
}
