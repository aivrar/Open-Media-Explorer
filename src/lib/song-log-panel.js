/**
 * The Song log panel, opened from the header. Built like Settings: the same
 * backdrop and dialog, focus kept inside while open, Escape or the backdrop
 * closes it, and focus goes back to where it was.
 *
 * Song and station names come from radio stations and are untrusted, so every
 * text is set with textContent, title or setAttribute; nothing is ever parsed
 * as HTML. The list is built in one pass before the panel is shown and then
 * updated row by row while it is open (a new song adds one row).
 */

import { songLog as appSongLog, exportSongLog, SONG_LOG_LIMIT } from './song-log.js';
import { openDownloadsFolder } from './download-client.js';

export const SONG_LOG_TITLE = 'Song log';
export const SONG_LOG_EMPTY_TEXT = 'No songs yet. Songs appear here when a radio station announces what it is playing.';
export const COPY_LABEL = 'Copy';
export const COPIED_LABEL = 'Copied';
export const COPIED_MS = 1500;
export const SAVE_LABEL = 'Save to file';
export const SAVE_BUSY_LABEL = 'Saving\u2026';
export const CLEAR_LABEL = 'Clear log';
export const COPY_FAILED = 'The song could not be copied: the clipboard is not available.';
export const CLEAR_FAILED = 'The song log could not be cleared, so the songs are still in it. Try Clear log again.';
export const REMOVE_FAILED = 'The song was removed here, but the saved song log could not be updated.';
const SVG_NS = 'http://www.w3.org/2000/svg';

let openPanel = null;

function reasonOf(error, fallback) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text || fallback;
}

function songCount(count) {
  if (count === 0) return 'No songs';
  const text = `${count} ${count === 1 ? 'song' : 'songs'}`;
  return count >= SONG_LOG_LIMIT ? `${text} (the newest ${SONG_LOG_LIMIT} are kept)` : text;
}

function localTimeFormatter() {
  try {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return (time) => format.format(new Date(time));
  } catch (_) {
    return (time) => new Date(time).toLocaleString();
  }
}

/** Visible, enabled buttons inside `node`, in document order. */
function focusableButtons(node, found = []) {
  if (!node || node.hidden) return found;
  if (node.tagName === 'BUTTON') {
    const shown = typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
    if (!node.disabled && shown) found.push(node);
    return found;
  }
  for (const child of node.children || []) focusableButtons(child, found);
  return found;
}

/**
 * Open the panel (or focus it when it is already open). Everything it uses
 * can be passed in for tests; the defaults are the app's.
 */
export function openSongLog({
  log = appSongLog,
  documentImpl = globalThis.document,
  clipboard = globalThis.navigator?.clipboard,
  confirmClear = (count) => globalThis.confirm(`Clear the song log? ${songCount(count)} will be removed from the list.`),
  saveToFile = exportSongLog,
  openFolder = openDownloadsFolder,
  formatTime = localTimeFormatter(),
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  if (openPanel && !openPanel.closed) {
    openPanel.focus();
    return openPanel;
  }
  const doc = documentImpl;
  const previousFocus = doc.activeElement;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className = 'btn btn-small') => {
    const node = make('button', className, label);
    node.type = 'button';
    return node;
  };

  const root = make('div', 'modal-backdrop');
  root.setAttribute('data-song-log-modal', 'true');
  const dialog = make('div', 'modal song-log-modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'song-log-title');
  dialog.setAttribute('aria-describedby', 'song-log-description');

  const header = make('div', 'modal-header');
  const heading = make('div');
  const title = make('h2', '', SONG_LOG_TITLE);
  title.id = 'song-log-title';
  const description = make('span', 'sr-only', 'Songs radio stations announced while you listened, newest first.');
  description.id = 'song-log-description';
  heading.appendChild(title);
  heading.appendChild(description);
  const closeButton = button('', 'icon-btn');
  closeButton.setAttribute('data-act', 'close');
  closeButton.setAttribute('aria-label', 'Close Song log');
  closeButton.title = 'Close';
  if (typeof doc.createElementNS === 'function') {
    const icon = doc.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries({
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true',
    })) icon.setAttribute(name, value);
    for (const [x1, y1, x2, y2] of [[18, 6, 6, 18], [6, 6, 18, 18]]) {
      const line = doc.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      icon.appendChild(line);
    }
    closeButton.appendChild(icon);
  } else {
    closeButton.textContent = '\u00D7';
  }
  header.appendChild(heading);
  header.appendChild(closeButton);

  const toolbar = make('div', 'song-log-toolbar');
  const count = make('span', 'song-log-count');
  const actions = make('div', 'song-log-actions');
  const saveButton = button(SAVE_LABEL, 'btn');
  saveButton.setAttribute('data-act', 'save-song-log');
  const clearButton = button(CLEAR_LABEL, 'btn btn-danger');
  clearButton.setAttribute('data-act', 'clear-song-log');
  actions.appendChild(saveButton);
  actions.appendChild(clearButton);
  toolbar.appendChild(count);
  toolbar.appendChild(actions);

  const statusRow = make('div', 'song-log-status');
  const status = make('span', 'song-log-status-text');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const openFolderButton = button('Open folder');
  openFolderButton.setAttribute('data-act', 'song-log-open-folder');
  openFolderButton.hidden = true;
  statusRow.appendChild(status);
  statusRow.appendChild(openFolderButton);

  const body = make('div', 'modal-body song-log-body');
  const empty = make('p', 'song-log-empty', SONG_LOG_EMPTY_TEXT);
  const list = make('ol', 'song-log-list');
  list.setAttribute('aria-label', 'Songs, newest first');
  body.appendChild(empty);
  body.appendChild(list);

  dialog.appendChild(header);
  dialog.appendChild(toolbar);
  dialog.appendChild(statusRow);
  dialog.appendChild(body);
  root.appendChild(dialog);

  const rows = new Map(); // entry -> row element
  const timers = new Set();
  let closed = false;
  let saving = false;
  let clearing = false;
  let noticeShown = false;

  function show(text, state) {
    status.textContent = text;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  function later(fn, ms) {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!closed) fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function buildRow(entry) {
    const row = make('li', 'song-log-row');
    const text = make('div', 'song-log-text');
    const song = make('span', 'song-log-title', entry.title);
    song.title = entry.title;
    const meta = make('span', 'song-log-meta');
    const when = make('time', 'song-log-time', formatTime(entry.time));
    try { when.setAttribute('datetime', new Date(entry.time).toISOString()); } catch (_) {}
    meta.appendChild(when);
    if (entry.station) {
      const separator = make('span', 'song-log-sep', ' \u00B7 ');
      separator.setAttribute('aria-hidden', 'true');
      const station = make('span', 'song-log-station', entry.station);
      station.title = entry.station;
      meta.appendChild(separator);
      meta.appendChild(station);
    }
    text.appendChild(song);
    text.appendChild(meta);
    const rowActions = make('div', 'song-log-row-actions');
    const copyButton = button(COPY_LABEL);
    copyButton.setAttribute('aria-label', `Copy "${entry.title}"`);
    copyButton.addEventListener('click', () => { void copy(entry, copyButton); });
    const removeButton = button('Remove');
    removeButton.setAttribute('aria-label', `Remove "${entry.title}" from the song log`);
    removeButton.addEventListener('click', () => remove(entry, row));
    rowActions.appendChild(copyButton);
    rowActions.appendChild(removeButton);
    row.appendChild(text);
    row.appendChild(rowActions);
    return row;
  }

  /** Bring the list in line with the log: newest first. Rows that stay are
   *  never moved (entries only come in at the newest end), so focus inside
   *  them is kept. */
  function render(entries = log.entries()) {
    const keep = new Set(entries);
    for (const [entry, row] of rows) {
      if (!keep.has(entry)) {
        row.remove();
        rows.delete(entry);
      }
    }
    let next = list.firstChild;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const existing = rows.get(entry);
      if (existing) {
        next = existing.nextSibling;
        continue;
      }
      const row = buildRow(entry);
      rows.set(entry, row);
      list.insertBefore(row, next);
    }
    const notice = log.readNotice;
    if (notice && !noticeShown) {
      noticeShown = true;
      show(notice, 'error');
    }
    const total = entries.length;
    count.textContent = songCount(total);
    empty.hidden = total > 0;
    list.hidden = total === 0;
    saveButton.disabled = saving || total === 0;
    clearButton.disabled = clearing || total === 0;
  }

  async function copy(entry, copyButton) {
    try {
      if (typeof clipboard?.writeText !== 'function') throw new Error('unavailable');
      await clipboard.writeText(entry.title);
    } catch (_) {
      if (!closed) show(COPY_FAILED, 'error');
      return;
    }
    if (closed) return;
    copyButton.textContent = COPIED_LABEL;
    show(COPIED_LABEL, 'ready');
    later(() => {
      copyButton.textContent = COPY_LABEL;
      if (status.textContent === COPIED_LABEL) show('', '');
    }, COPIED_MS);
  }

  function remove(entry, row) {
    // Keep the keyboard in the list: the next row's Remove, else the one above.
    const neighbour = row.nextSibling || row.previousSibling;
    const target = neighbour ? focusableButtons(neighbour).pop() : null;
    log.remove(entry).catch(() => {
      if (!closed) show(REMOVE_FAILED, 'error');
    });
    if (closed) return;
    (target && !target.disabled ? target : closeButton).focus();
  }

  async function saveToDisk() {
    if (saving) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = SAVE_BUSY_LABEL;
    openFolderButton.hidden = true;
    show('', 'checking');
    try {
      const data = await saveToFile(log.entries().reverse());
      if (closed) return;
      const name = typeof data?.name === 'string' && data.name ? data.name : 'the song log file';
      show(`Saved: ${name}`, 'ready');
      openFolderButton.hidden = false;
    } catch (error) {
      if (closed) return;
      show(`The song log could not be saved to a file: ${reasonOf(error, 'try again.')}`, 'error');
    } finally {
      saving = false;
      if (!closed) {
        saveButton.textContent = SAVE_LABEL;
        saveButton.disabled = log.size === 0;
      }
    }
  }

  async function openTheFolder() {
    openFolderButton.disabled = true;
    try {
      await openFolder();
    } catch (error) {
      if (!closed) show(`The folder could not be opened: ${reasonOf(error, 'it is not available.')}`, 'error');
    } finally {
      if (!closed) openFolderButton.disabled = false;
    }
  }

  async function clearAll() {
    const total = log.size;
    if (clearing || total === 0 || !confirmClear(total)) return;
    clearing = true;
    clearButton.disabled = true;
    openFolderButton.hidden = true;
    closeButton.focus(); // the Clear button is about to be disabled
    try {
      await log.clear();
      if (!closed) show('The song log was cleared.', 'ready');
    } catch (_) {
      if (!closed) show(CLEAR_FAILED, 'error');
    } finally {
      clearing = false;
      if (!closed) clearButton.disabled = log.size === 0;
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableButtons(dialog);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const unsubscribe = log.onChange((entries) => { if (!closed) render(entries); });

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    const app = doc.getElementById?.('app');
    if (app) app.inert = false;
    root.remove();
    doc.removeEventListener('keydown', onKeyDown);
    if (openPanel === panel) openPanel = null;
    if (previousFocus?.focus) previousFocus.focus();
  }

  closeButton.addEventListener('click', close);
  root.addEventListener('click', (event) => { if (event.target === root) close(); });
  saveButton.addEventListener('click', () => { void saveToDisk(); });
  openFolderButton.addEventListener('click', () => { void openTheFolder(); });
  clearButton.addEventListener('click', () => { void clearAll(); });

  render(); // in one pass, before the panel is in the page
  // A saved log that was busy at start is read now; the list updates when it arrives.
  Promise.resolve(log.load?.()).catch(() => {});
  const host = doc.getElementById?.('modal-host') || doc.body;
  host.appendChild(root);
  doc.addEventListener('keydown', onKeyDown);
  const app = doc.getElementById?.('app');
  if (app) app.inert = true;
  closeButton.focus();

  const panel = {
    root,
    dialog,
    list,
    status,
    close,
    focus: () => closeButton.focus(),
    get closed() { return closed; },
  };
  openPanel = panel;
  return panel;
}
