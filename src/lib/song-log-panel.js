/**
 * The Song log panel, opened from the header. Built like Settings: the same
 * backdrop and dialog, focus kept inside while open, Escape or the backdrop
 * closes it, and focus goes back to where it was.
 *
 * Song and station names come from radio stations and are untrusted, so every
 * text is set with textContent, title or setAttribute; nothing is ever parsed
 * as HTML. The list is built in one pass before the panel is shown and then
 * updated row by row while it is open (a new song adds one row).
 *
 * Its second view, Starred songs, lists the songs starred with the star on a
 * log row or on the player bar (starred-songs.js), newest first, with Find
 * links (a web or YouTube search for the title, opened in the browser like
 * the app's other outside links), Copy and Unstar, and saves the list as a
 * .txt or .csv file. It lives here, next to the log it is starred from.
 */

import { songLog as appSongLog, exportSongLog, SONG_LOG_LIMIT } from './song-log.js';
import { openDownloadsFolder } from './download-client.js';
import {
  starredSongs as appStarredSongs, exportStarredSongs, songSearchUrl, songStarBlock,
  SONG_SEARCHES, STARRED_SONGS_LIMIT,
} from './starred-songs.js';

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
export const STARRED_TITLE = 'Starred songs';
export const STARRED_EMPTY_TEXT = 'No starred songs yet. Star a song in the log, or the song playing now on the player bar.';
export const SAVE_TEXT_LABEL = 'Save as text';
export const SAVE_CSV_LABEL = 'Save as CSV';
export const UNSTAR_LABEL = 'Unstar';
export const STAR_MARK = '\u2606';
export const STARRED_MARK = '\u2605';
export const STAR_FAILED = 'The star was set here, but your starred songs could not be saved.';
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

function starredCount(count) {
  if (count === 0) return 'No starred songs';
  const text = `${count} starred ${count === 1 ? 'song' : 'songs'}`;
  return count >= STARRED_SONGS_LIMIT
    ? `${text} (the newest ${STARRED_SONGS_LIMIT} are kept: starring another removes the oldest)`
    : text;
}

function localTimeFormatter() {
  try {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return (time) => format.format(new Date(time));
  } catch (_) {
    return (time) => new Date(time).toLocaleString();
  }
}

/** Visible, enabled buttons and links inside `node`, in document order. */
function focusableButtons(node, found = []) {
  if (!node || node.hidden) return found;
  if (node.tagName === 'BUTTON' || (node.tagName === 'A' && node.getAttribute?.('href'))) {
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
  starred = appStarredSongs,
  view: startView = 'log',
  documentImpl = globalThis.document,
  clipboard = globalThis.navigator?.clipboard,
  confirmClear = (count) => globalThis.confirm(`Clear the song log? ${songCount(count)} will be removed from the list.`),
  saveToFile = exportSongLog,
  saveStarred = exportStarredSongs,
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
  const description = make('span', 'sr-only', 'Songs radio stations announced while you listened, and the songs you starred, newest first.');
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

  // Song log | Starred songs: two buttons, the shown one pressed.
  const views = make('div', 'song-log-views');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Show');
  const logViewButton = button(SONG_LOG_TITLE, 'btn btn-small song-log-view');
  logViewButton.setAttribute('data-act', 'show-song-log');
  const starredViewButton = button(STARRED_TITLE, 'btn btn-small song-log-view');
  starredViewButton.setAttribute('data-act', 'show-starred-songs');
  views.appendChild(logViewButton);
  views.appendChild(starredViewButton);

  const starToolbar = make('div', 'song-log-toolbar');
  const starCount = make('span', 'song-log-count starred-count');
  const starActions = make('div', 'song-log-actions');
  const saveTextButton = button(SAVE_TEXT_LABEL, 'btn');
  saveTextButton.setAttribute('data-act', 'save-starred-txt');
  const saveCsvButton = button(SAVE_CSV_LABEL, 'btn');
  saveCsvButton.setAttribute('data-act', 'save-starred-csv');
  starActions.appendChild(saveTextButton);
  starActions.appendChild(saveCsvButton);
  starToolbar.appendChild(starCount);
  starToolbar.appendChild(starActions);

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

  const starBody = make('div', 'modal-body song-log-body');
  const starEmpty = make('p', 'song-log-empty', STARRED_EMPTY_TEXT);
  const starList = make('ol', 'song-log-list starred-list');
  starList.setAttribute('aria-label', 'Starred songs, newest first');
  starBody.appendChild(starEmpty);
  starBody.appendChild(starList);

  dialog.appendChild(header);
  dialog.appendChild(views);
  dialog.appendChild(toolbar);
  dialog.appendChild(starToolbar);
  dialog.appendChild(statusRow);
  dialog.appendChild(body);
  dialog.appendChild(starBody);
  root.appendChild(dialog);

  const rows = new Map(); // entry -> row element
  const starRows = new Map(); // starred entry -> row element
  const starButtons = new Map(); // log entry -> its star button
  const timers = new Set();
  let view = startView === 'starred' ? 'starred' : 'log';
  let closed = false;
  let saving = false;
  let clearing = false;
  let noticeShown = false;
  let starNoticeShown = false;

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
    const starButton = button(STAR_MARK, 'btn btn-small song-star');
    starButton.setAttribute('data-act', 'star-song');
    starButton.addEventListener('click', () => toggleStar(entry));
    starButtons.set(entry, starButton);
    syncStar(entry, starButton);
    rowActions.appendChild(starButton);
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
        starButtons.delete(entry);
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

  /** The star on a log row: pressed when that song is starred; off (with the
   *  reason on hover) for a title that is not a song. */
  function syncStar(entry, starButton) {
    const blocked = songStarBlock(entry.title, entry.station);
    const on = !blocked && Boolean(starred.starredFor(entry));
    starButton.disabled = Boolean(blocked);
    starButton.textContent = on ? STARRED_MARK : STAR_MARK;
    starButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    starButton.classList?.toggle?.('is-starred', on);
    starButton.title = blocked || (on ? 'Unstar this song' : 'Star this song');
    starButton.setAttribute('aria-label', blocked || (on ? `Unstar "${entry.title}"` : `Star "${entry.title}"`));
  }

  function toggleStar(entry) {
    const result = starred.toggle(entry);
    if (!result.entry && result.reason) {
      show(result.reason, 'error');
      return;
    }
    result.saved?.catch?.(() => { if (!closed) show(STAR_FAILED, 'error'); });
    if (result.dropped) show(`Starred. The oldest starred song, "${result.dropped.title}", was removed to make room.`, 'ready');
  }

  function buildStarRow(entry) {
    const row = make('li', 'song-log-row starred-row');
    const text = make('div', 'song-log-text');
    const song = make('span', 'song-log-title', entry.title);
    song.title = entry.title;
    const meta = make('span', 'song-log-meta');
    const when = make('time', 'song-log-time', `Starred ${formatTime(entry.starred)}`);
    try { when.setAttribute('datetime', new Date(entry.starred).toISOString()); } catch (_) {}
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
    // Find: plain links to fixed https search pages, opened outside the app
    // like the app's other outside links.
    const find = make('span', 'starred-find');
    find.setAttribute('role', 'group');
    find.setAttribute('aria-label', `Find "${entry.title}"`);
    for (const search of SONG_SEARCHES) {
      const link = make('a', 'btn btn-small starred-find-link', search.label);
      link.setAttribute('href', songSearchUrl(search, entry.title));
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('data-search', search.id);
      link.setAttribute('aria-label', `Search ${search.name} for "${entry.title}"`);
      link.title = `Search ${search.name} in your browser`;
      find.appendChild(link);
    }
    const copyButton = button(COPY_LABEL);
    copyButton.setAttribute('aria-label', `Copy "${entry.title}"`);
    copyButton.addEventListener('click', () => { void copy(entry, copyButton); });
    const unstarButton = button(UNSTAR_LABEL);
    unstarButton.setAttribute('aria-label', `Unstar "${entry.title}"`);
    unstarButton.addEventListener('click', () => unstar(entry, row));
    rowActions.appendChild(find);
    rowActions.appendChild(copyButton);
    rowActions.appendChild(unstarButton);
    row.appendChild(text);
    row.appendChild(rowActions);
    return row;
  }

  /** The starred list, newest first; rows that stay are kept. */
  function renderStarred(entries = starred.entries()) {
    const keep = new Set(entries);
    for (const [entry, row] of starRows) {
      if (!keep.has(entry)) {
        row.remove();
        starRows.delete(entry);
      }
    }
    let next = starList.firstChild;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      let row = starRows.get(entry);
      if (!row) {
        row = buildStarRow(entry);
        starRows.set(entry, row);
      }
      if (row !== next) starList.insertBefore(row, next);
      next = row.nextSibling;
    }
    const notice = starred.readNotice;
    if (notice && !starNoticeShown && view === 'starred') {
      starNoticeShown = true;
      show(notice, 'error');
    }
    const total = entries.length;
    starCount.textContent = starredCount(total);
    starredViewButton.setAttribute('aria-label', `${STARRED_TITLE} (${total})`);
    starEmpty.hidden = total > 0;
    starList.hidden = total === 0;
    saveTextButton.disabled = saving || total === 0;
    saveCsvButton.disabled = saving || total === 0;
    for (const [entry, starButton] of starButtons) syncStar(entry, starButton);
  }

  function unstar(entry, row) {
    const neighbour = row.nextSibling || row.previousSibling;
    const target = neighbour ? focusableButtons(neighbour).pop() : null;
    starred.unstar(entry).catch(() => {
      if (!closed) show(STAR_FAILED, 'error');
    });
    if (closed) return;
    (target && !target.disabled ? target : starredViewButton).focus();
  }

  /** Show one view; the other's toolbar and list are hidden (so Tab skips them). */
  function showView(next) {
    view = next === 'starred' ? 'starred' : 'log';
    const onLog = view === 'log';
    toolbar.hidden = !onLog;
    body.hidden = !onLog;
    starToolbar.hidden = onLog;
    starBody.hidden = onLog;
    logViewButton.setAttribute('aria-pressed', onLog ? 'true' : 'false');
    starredViewButton.setAttribute('aria-pressed', onLog ? 'false' : 'true');
    logViewButton.classList?.toggle?.('is-active', onLog);
    starredViewButton.classList?.toggle?.('is-active', !onLog);
    openFolderButton.hidden = true;
    show('', '');
    noticeShown = false;
    starNoticeShown = false;
    if (onLog) render(); else renderStarred();
  }

  async function saveStarredToDisk(format) {
    if (saving) return;
    saving = true;
    saveTextButton.disabled = true;
    saveCsvButton.disabled = true;
    openFolderButton.hidden = true;
    show(SAVE_BUSY_LABEL, 'checking');
    try {
      const data = await saveStarred(format, starred.entries().reverse());
      if (closed) return;
      const name = typeof data?.name === 'string' && data.name ? data.name : 'the starred songs file';
      show(`Saved: ${name}`, 'ready');
      openFolderButton.hidden = false;
    } catch (error) {
      if (closed) return;
      show(`The starred songs could not be saved to a file: ${reasonOf(error, 'try again.')}`, 'error');
    } finally {
      saving = false;
      if (!closed) {
        saveTextButton.disabled = starred.size === 0;
        saveCsvButton.disabled = starred.size === 0;
      }
    }
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
  const unsubscribeStarred = starred.onChange((entries) => { if (!closed) renderStarred(entries); });

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeStarred();
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
  logViewButton.addEventListener('click', () => showView('log'));
  starredViewButton.addEventListener('click', () => showView('starred'));
  saveTextButton.addEventListener('click', () => { void saveStarredToDisk('txt'); });
  saveCsvButton.addEventListener('click', () => { void saveStarredToDisk('csv'); });

  // Both lists in one pass, before the panel is in the page.
  render();
  renderStarred();
  showView(view);
  // Saved lists that were busy at start are read now; the lists update when they arrive.
  Promise.resolve(log.load?.()).catch(() => {});
  Promise.resolve(starred.load?.()).catch(() => {});
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
    starList,
    status,
    showView,
    get view() { return view; },
    close,
    focus: () => closeButton.focus(),
    get closed() { return closed; },
  };
  openPanel = panel;
  return panel;
}
