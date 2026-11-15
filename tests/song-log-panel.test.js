import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SONG_LOG_UNREADABLE_NOTICE, createSongLog, makeSongLogEntry } from '../src/lib/song-log.js';
import {
  CLEAR_FAILED, COPIED_LABEL, COPIED_MS, COPY_FAILED, SONG_LOG_EMPTY_TEXT, openSongLog,
} from '../src/lib/song-log-panel.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);

/** A small DOM tree: enough for the panel, and strict about HTML parsing. */
class MiniElement extends EventTarget {
  constructor(doc, tagName) {
    super();
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.title = '';
    this.id = '';
    this.type = '';
    this.disabled = false;
    this.hidden = false;
  }

  set innerHTML(_) { throw new Error('innerHTML must not be used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must not be used'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, reference) {
    child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    this.ownerDocument.insertions += 1;
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    const siblings = this.parentNode?.children;
    return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
  }
  get previousSibling() {
    const siblings = this.parentNode?.children;
    return siblings ? siblings[siblings.indexOf(this) - 1] ?? null : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click'));
  }
  /** All text below this element, as a reader would get it. */
  text() { return this.textContent + this.children.map((child) => child.text()).join(''); }
  findAll(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.findAll(predicate, found);
    }
    return found;
  }
  find(predicate) { return this.findAll(predicate)[0] ?? null; }
}

function miniDocument() {
  const doc = new EventTarget();
  doc.insertions = 0;
  doc.createElement = (tag) => new MiniElement(doc, tag);
  doc.createElementNS = (_, tag) => new MiniElement(doc, tag);
  doc.body = new MiniElement(doc, 'body');
  const app = doc.createElement('div');
  app.id = 'app';
  const host = doc.createElement('div');
  host.id = 'modal-host';
  const opener = doc.createElement('button');
  opener.id = 'song-log-btn';
  app.appendChild(opener);
  doc.body.appendChild(app);
  doc.body.appendChild(host);
  doc.getElementById = (id) => doc.body.find((node) => node.id === id);
  doc.activeElement = opener;
  doc.key = (key, shiftKey = false) => {
    const event = new Event('keydown', { cancelable: true });
    event.key = key;
    event.shiftKey = shiftKey;
    doc.dispatchEvent(event);
    return event;
  };
  return { doc, app, host, opener };
}

function entry(title, n = 0, station = 'Jazz FM') {
  return makeSongLogEntry({ time: T0 + n * 60_000, station, stationId: `id:${station}`, source: 'radio-browser', title });
}

/** A song log whose saved copy always works, filled with entries oldest first. */
function filledLog(titles = []) {
  const server = { entries: [], posts: 0, fail: false, unreadable: false };
  const log = createSongLog({
    native: true,
    request: async (_, options = {}) => {
      if (options.method !== 'POST') return { entries: server.entries, revision: 0, unreadable: server.unreadable };
      server.posts += 1;
      if (server.fail) throw new Error('Disk full');
      server.entries = options.body.entries;
      return { saved: true, revision: options.body.revision };
    },
    onSaveFailed: () => {},
    onSaved: () => {},
  });
  server.entries = titles.map((title, n) => ({ ...entry(title, n) }));
  return { log, server };
}

function timers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { pending.set(next, { fn, ms }); return next++; },
    clearTimer: (id) => pending.delete(id),
    runAll() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
    pending,
  };
}

async function open(titles, options = {}) {
  const dom = miniDocument();
  const { log, server } = filledLog(titles);
  log.start(() => {});
  await drain();
  const clock = timers();
  const panel = openSongLog({
    log, documentImpl: dom.doc, formatTime: (time) => `t${(time - T0) / 60_000}`,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options,
  });
  return { ...dom, log, server, panel, clock };
}

const rows = (panel) => panel.list.children;
const rowTitle = (row) => row.find((node) => node.className === 'song-log-title');
const buttonIn = (node, label) => node.find((child) => child.tagName === 'BUTTON' && child.textContent === label);

test('opens as a modal dialog over an inert app, focused on Close', async () => {
  const { panel, host, app, doc } = await open(['One']);
  assert.equal(panel.root.parentNode, host);
  assert.equal(panel.dialog.getAttribute('role'), 'dialog');
  assert.equal(panel.dialog.getAttribute('aria-modal'), 'true');
  assert.equal(panel.dialog.getAttribute('aria-labelledby'), 'song-log-title');
  assert.equal(doc.getElementById('song-log-title').textContent, 'Song log');
  assert.equal(app.inert, true);
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Close Song log');
  panel.close();
});

test('Escape, Close and the backdrop close it and focus returns to the opener', async () => {
  for (const how of ['escape', 'button', 'backdrop']) {
    const { panel, doc, app, opener } = await open(['One']);
    if (how === 'escape') assert.equal(doc.key('Escape').defaultPrevented, true);
    if (how === 'button') panel.dialog.find((node) => node.getAttribute('data-act') === 'close').click();
    if (how === 'backdrop') panel.root.click();
    assert.equal(panel.closed, true, how);
    assert.equal(panel.root.parentNode, null);
    assert.equal(app.inert, false);
    assert.equal(doc.activeElement, opener);
    doc.key('Escape'); // no longer listening
  }
});

test('a click inside the dialog does not close it, and opening again focuses the open panel', async () => {
  const { panel, doc } = await open(['One']);
  panel.dialog.dispatchEvent(new Event('click'));
  assert.equal(panel.closed, false);
  doc.activeElement = doc.body;
  assert.equal(openSongLog(), panel);
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Close Song log');
  panel.close();
});

test('Tab and Shift+Tab stay inside the dialog', async () => {
  const { panel, doc } = await open(['One', 'Two']);
  const close = doc.activeElement;
  const lastRemove = buttonIn(rows(panel).at(-1), 'Remove');
  assert.equal(doc.key('Tab', true).defaultPrevented, true);
  assert.equal(doc.activeElement, lastRemove);
  assert.equal(doc.key('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, close);
  const save = buttonIn(panel.dialog, 'Save to file');
  save.focus();
  assert.equal(doc.key('Tab').defaultPrevented, false, 'ordinary Tab inside the dialog is left alone');
  doc.activeElement = doc.body; // focus somehow outside: brought back in
  doc.key('Tab');
  assert.equal(doc.activeElement, close);
  panel.close();
});

test('lists newest first with local time, song and station, in one pass before it is shown', async () => {
  const dom = miniDocument();
  const { log } = filledLog(Array.from({ length: 500 }, (_, n) => `Song ${n}`));
  log.start(() => {});
  await drain();
  let insertionsWhenShown = null;
  const appendChild = dom.host.appendChild.bind(dom.host);
  dom.host.appendChild = (child) => {
    const added = appendChild(child);
    insertionsWhenShown = dom.doc.insertions;
    return added;
  };
  const panel = openSongLog({ log, documentImpl: dom.doc, formatTime: (time) => `t${(time - T0) / 60_000}` });
  const list = rows(panel);
  assert.equal(list.length, 500);
  assert.equal(dom.doc.insertions, insertionsWhenShown, 'nothing is added after the panel is in the page');
  assert.equal(rowTitle(list[0]).textContent, 'Song 499');
  assert.equal(rowTitle(list[499]).textContent, 'Song 0');
  const meta = list[0].find((node) => node.className === 'song-log-meta');
  assert.equal(meta.text(), 't499 \u00B7 Jazz FM');
  assert.equal(list[0].find((node) => node.tagName === 'TIME').getAttribute('datetime'), new Date(T0 + 499 * 60_000).toISOString());
  assert.equal(panel.dialog.find((node) => node.className === 'song-log-count').textContent, '500 songs (the newest 500 are kept)');
  panel.close();
});

test('long titles and stations keep their full text on hover', async () => {
  const long = 'L'.repeat(200);
  const { panel } = await open([long]);
  const row = rows(panel)[0];
  assert.equal(rowTitle(row).title, long);
  assert.equal(row.find((node) => node.className === 'song-log-station').title, 'Jazz FM');
  panel.close();
});

test('the empty state explains where songs come from', async () => {
  const { panel } = await open([]);
  const empty = panel.dialog.find((node) => node.className === 'song-log-empty');
  assert.equal(empty.textContent, SONG_LOG_EMPTY_TEXT);
  assert.equal(empty.hidden, false);
  assert.equal(panel.list.hidden, true);
  assert.equal(buttonIn(panel.dialog, 'Save to file').disabled, true);
  assert.equal(buttonIn(panel.dialog, 'Clear log').disabled, true);
  panel.close();
});

test('new songs appear live at the top without rebuilding the other rows', async () => {
  const { panel, log, doc } = await open(['One']);
  const first = rows(panel)[0];
  const removeOne = buttonIn(first, 'Remove');
  removeOne.focus();
  log.handleNowPlaying({ itemId: 'id:Rock', title: 'Two', changedAt: T0 + 120_000 });
  assert.deepEqual(rows(panel).map((row) => rowTitle(row).textContent), ['Two', 'One']);
  assert.equal(rows(panel)[1], first, 'the existing row is the same element');
  assert.equal(doc.activeElement, removeOne, 'focus is kept');
  assert.equal(panel.dialog.find((node) => node.className === 'song-log-empty').hidden, true);
  panel.close();
  log.handleNowPlaying({ itemId: 'id:Rock', title: 'Three', changedAt: T0 + 180_000 });
  assert.equal(rows(panel).length, 2, 'a closed panel no longer updates');
});

test('Copy puts the song on the clipboard and says Copied briefly', async () => {
  const written = [];
  const { panel, clock } = await open(['Artist - Song'], { clipboard: { writeText: async (text) => { written.push(text); } } });
  const copy = buttonIn(rows(panel)[0], 'Copy');
  assert.equal(copy.getAttribute('aria-label'), 'Copy "Artist - Song"');
  copy.click();
  await drain();
  assert.deepEqual(written, ['Artist - Song']);
  assert.equal(copy.textContent, COPIED_LABEL);
  assert.equal(panel.status.textContent, COPIED_LABEL);
  assert.equal([...clock.pending.values()][0].ms, COPIED_MS);
  clock.runAll();
  assert.equal(copy.textContent, 'Copy');
  assert.equal(panel.status.textContent, '');
  panel.close();
});

test('a refused or missing clipboard gives one plain line', async () => {
  for (const clipboard of [{ writeText: async () => { throw new Error('NotAllowedError'); } }, undefined, {}]) {
    const { panel } = await open(['Song'], { clipboard });
    buttonIn(rows(panel)[0], 'Copy').click();
    await drain();
    assert.equal(panel.status.textContent, COPY_FAILED);
    assert.equal(panel.status.dataset.state, 'error');
    panel.close();
  }
});

test('Remove takes out that song, saves, and keeps the keyboard in the list', async () => {
  const { panel, log, server, doc } = await open(['One', 'Two', 'Three']);
  const [three, two, one] = rows(panel);
  buttonIn(two, 'Remove').click();
  await drain();
  assert.deepEqual(rows(panel).map((row) => rowTitle(row).textContent), ['Three', 'One']);
  assert.deepEqual(server.entries.map((item) => item.title), ['One', 'Three']);
  assert.equal(doc.activeElement, buttonIn(one, 'Remove'));
  buttonIn(one, 'Remove').click();
  assert.equal(doc.activeElement, buttonIn(three, 'Remove'), 'the last row hands focus to the one above');
  buttonIn(three, 'Remove').click();
  await drain();
  assert.equal(log.size, 0);
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Close Song log');
  assert.equal(panel.dialog.find((node) => node.className === 'song-log-empty').hidden, false);
  panel.close();
});

test('Clear log asks first, then empties the list and the saved copy', async () => {
  const asked = [];
  let answer = false;
  const { panel, log, server } = await open(['One', 'Two'], { confirmClear: (count) => { asked.push(count); return answer; } });
  const clear = buttonIn(panel.dialog, 'Clear log');
  clear.click();
  await drain();
  assert.deepEqual(asked, [2]);
  assert.equal(log.size, 2, 'cancelled: nothing changes');
  answer = true;
  clear.click();
  await drain();
  assert.equal(log.size, 0);
  assert.deepEqual(server.entries, []);
  assert.equal(rows(panel).length, 0);
  assert.equal(panel.status.textContent, 'The song log was cleared.');
  assert.equal(clear.disabled, true);
  panel.close();
});

test('a failed clear is said plainly, the songs come back and Clear log works again', async () => {
  const { panel, server, log } = await open(['One', 'Two'], { confirmClear: () => true });
  server.fail = true;
  const clear = buttonIn(panel.dialog, 'Clear log');
  clear.click();
  await drain();
  assert.equal(panel.status.textContent, CLEAR_FAILED);
  assert.equal(panel.status.dataset.state, 'error');
  assert.deepEqual(rows(panel).map((row) => rowTitle(row).textContent), ['Two', 'One']);
  assert.equal(clear.disabled, false);
  assert.equal(buttonIn(panel.dialog, 'Save to file').disabled, false);
  server.fail = false;
  clear.click();
  await drain();
  assert.equal(log.size, 0);
  assert.deepEqual(server.entries, []);
  assert.equal(panel.status.textContent, 'The song log was cleared.');
  panel.close();
});

test('an unreadable saved log is said in one plain line when the panel opens', async () => {
  const dom = miniDocument();
  const { log, server } = filledLog([]);
  server.unreadable = true;
  log.start(() => {});
  await drain();
  const panel = openSongLog({ log, documentImpl: dom.doc, formatTime: () => 'now' });
  assert.equal(panel.status.textContent, SONG_LOG_UNREADABLE_NOTICE);
  panel.close();
});

test('opening the panel reads a saved log that was busy at start', async () => {
  const dom = miniDocument();
  let busy = true;
  const log = createSongLog({
    native: true,
    request: async (_, options = {}) => {
      if (options.method === 'POST') return { saved: true, revision: options.body.revision };
      if (busy) throw new Error('locked');
      return { entries: [{ ...entry('Saved earlier') }], revision: 3, unreadable: false };
    },
    onSaveFailed: () => {},
    onSaved: () => {},
  });
  log.start(() => {});
  await drain();
  busy = false;
  const panel = openSongLog({ log, documentImpl: dom.doc, formatTime: () => 'now' });
  await drain();
  assert.deepEqual(rows(panel).map((row) => rowTitle(row).textContent), ['Saved earlier']);
  panel.close();
});

test('Save to file sends the list newest first, then offers Open folder', async () => {
  const sent = [];
  let opened = 0;
  const { panel } = await open(['Old', 'New'], {
    saveToFile: async (entries) => { sent.push(entries.map((item) => item.title)); return { name: 'WorldMedia-song-log-20261115-080000.csv', count: 2 }; },
    openFolder: async () => { opened += 1; },
  });
  const save = buttonIn(panel.dialog, 'Save to file');
  const openFolder = buttonIn(panel.dialog, 'Open folder');
  assert.equal(openFolder.hidden, true);
  save.click();
  assert.equal(save.textContent, 'Saving\u2026');
  assert.equal(save.disabled, true);
  await drain();
  assert.deepEqual(sent, [['New', 'Old']]);
  assert.equal(panel.status.textContent, 'Saved: WorldMedia-song-log-20261115-080000.csv');
  assert.equal(openFolder.hidden, false);
  assert.equal(save.textContent, 'Save to file');
  openFolder.click();
  await drain();
  assert.equal(opened, 1);
  panel.close();
});

test('Save and Open folder failures are one plain line', async () => {
  const { panel } = await open(['One'], {
    saveToFile: async () => { throw new Error('The downloads folder is not available, so the song log was not saved.'); },
    openFolder: async () => { throw new Error('Explorer is busy.'); },
  });
  buttonIn(panel.dialog, 'Save to file').click();
  await drain();
  assert.equal(panel.status.textContent, 'The song log could not be saved to a file: The downloads folder is not available, so the song log was not saved.');
  assert.equal(panel.status.dataset.state, 'error');
  const openFolder = buttonIn(panel.dialog, 'Open folder');
  openFolder.hidden = false;
  openFolder.click();
  await drain();
  assert.equal(panel.status.textContent, 'The folder could not be opened: Explorer is busy.');
  panel.close();
});

test('station text is only ever plain text', async () => {
  const markup = '<img src=x onerror="alert(1)">&amp;';
  const dom = miniDocument();
  const log = createSongLog({ native: false });
  log.handleNowPlaying({ itemId: 'x', title: markup, changedAt: T0 });
  const panel = openSongLog({ log, documentImpl: dom.doc, formatTime: () => 'now' });
  const row = rows(panel)[0];
  assert.equal(rowTitle(row).textContent, markup);
  assert.equal(rowTitle(row).title, markup);
  assert.equal(row.findAll((node) => node.tagName === 'IMG').length, 0);
  panel.close();
  const source = await readFile(new URL('../src/lib/song-log-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('the header has a Song log button next to Settings, styled like it', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const tools = html.slice(html.indexOf('<div class="topbar-tools">'), html.indexOf('</header>'));
  const songLog = tools.indexOf('id="song-log-btn"');
  assert.ok(songLog > 0 && songLog < tools.indexOf('id="settings-btn"'));
  assert.match(tools, /<button id="song-log-btn" class="icon-btn" type="button" title="Song log" aria-label="Song log">/);
  assert.match(html, /href="\.\/styles\/song-log\.css"/);
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /getElementById\('song-log-btn'\)[^\n]*openSongLog\(\)/);
  assert.match(main, /startSongLog\(subscribe,/);
});
