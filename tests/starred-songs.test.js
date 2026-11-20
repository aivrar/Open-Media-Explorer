import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createSongLog, makeSongLogEntry } from '../src/lib/song-log.js';
import {
  NOT_A_SONG, SONG_SEARCHES, STARRED_SONGS_LIMIT, cleanStarredText, createStarredSongs, makeStarredEntry,
  parseStarredEntries, sameStarredSong, songSearchUrl, songStarBlock,
} from '../src/lib/starred-songs.js';
import {
  SAVE_CSV_LABEL, SAVE_TEXT_LABEL, STARRED_EMPTY_TEXT, STARRED_MARK, STAR_MARK, openSongLog,
} from '../src/lib/song-log-panel.js';
import { bindSongStar } from '../src/lib/song-star.js';
import { NOW_PLAYING_EVENT } from '../src/lib/now-playing.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);

/* ---------------- A small DOM (as in song-log-panel.test.js) ---------------- */

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
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes().has(name),
      toggle: (name, on) => {
        const set = classes();
        const want = on === undefined ? !set.has(name) : Boolean(on);
        if (want) set.add(name); else set.delete(name);
        this.className = [...set].join(' ');
        return want;
      },
    };
  }

  set innerHTML(_) { throw new Error('innerHTML must not be used'); }
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
  focus() { this.ownerDocument.activeElement = this; }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click'));
  }
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
  doc.createElement = (tag) => new MiniElement(doc, tag);
  doc.createElementNS = (_, tag) => new MiniElement(doc, tag);
  doc.body = new MiniElement(doc, 'body');
  const app = doc.createElement('div');
  app.id = 'app';
  const host = doc.createElement('div');
  host.id = 'modal-host';
  const opener = doc.createElement('button');
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

/* ---------------- Stores with a fake data folder ---------------- */

/** A starred songs store whose saved copy is `server` (entries, revision). */
function starredStore({ saved = [], revision = 0, now } = {}) {
  const server = { entries: saved, revision, posts: [], fail: false, unreadable: false };
  let clock = T0;
  const store = createStarredSongs({
    native: true,
    now: now || (() => { clock += 60_000; return clock; }),
    request: async (_, options = {}) => {
      if (options.method !== 'POST') return { entries: server.entries, revision: server.revision, unreadable: server.unreadable };
      server.posts.push(options.body);
      if (server.fail) throw new Error('Disk full');
      if (options.body.revision <= server.revision) {
        return { saved: false, stale: true, revision: server.revision, entries: server.entries };
      }
      server.entries = options.body.entries;
      server.revision = options.body.revision;
      return { saved: true, revision: server.revision };
    },
    onSaveFailed: () => {},
    onSaved: () => {},
  });
  return { store, server };
}

function songLogWith(titles, station = 'Jazz FM') {
  const log = createSongLog({ native: false, getItem: (itemId) => ({ id: itemId, title: station, source: 'radio-browser' }) });
  titles.forEach((title, n) => log.handleNowPlaying({ itemId: `id:${station}`, title, changedAt: T0 + n * 60_000 }));
  return log;
}

const song = (title, station = 'Jazz FM', stationId = `id:${station}`) => ({ title, station, stationId, source: 'radio-browser' });

/* ---------------- What can be starred ---------------- */

test('a title that is not a song cannot be starred: empty, no letters or digits, or the station\'s own name', () => {
  for (const title of ['', '   ', '-', '...', ' - ', '\u266A', '\u200B']) assert.equal(songStarBlock(title, 'Jazz FM'), NOT_A_SONG, JSON.stringify(title));
  for (const name of ['Jazz FM', 'jazz fm', ' JAZZ-FM ', 'Jazz  FM!']) assert.equal(songStarBlock(name, 'Jazz FM'), NOT_A_SONG, name);
  for (const title of ['Artist - Song', '1999', 'Jazz FM Theme - Band', '\u00C9dith Piaf - La Vie en rose']) {
    assert.equal(songStarBlock(title, 'Jazz FM'), '', title);
  }
  assert.equal(makeStarredEntry({ starred: T0, ...song('Jazz FM') }), null);
  assert.equal(makeStarredEntry({ starred: 0, ...song('Song') }), null, 'a date is needed');
});

test('a starred song is plain, one-line text within the song log\'s limits', () => {
  const entry = makeStarredEntry({ starred: T0, title: '  Artist\n -\tSong\u200B ', station: 'Jazz\u0000 FM', stationId: 'id', source: 'radio-browser', extra: 'x' });
  assert.deepEqual({ ...entry }, { starred: T0, title: 'Artist - Song', station: 'Jazz FM', stationId: 'id', source: 'radio-browser' });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(makeStarredEntry({ starred: T0, ...song('x'.repeat(300)) }).title.length, 200);
  const parsed = parseStarredEntries([{ starred: T0, ...song('One') }, null, [], { starred: 'soon', ...song('Two') }, { starred: T0, ...song('-') }]);
  assert.deepEqual(parsed.map((item) => item.title), ['One']);
  assert.equal(parseStarredEntries('nope').length, 0);
});

test('starring the same title from the same station twice keeps one; another station is another song', () => {
  const { store } = starredStore();
  store.start();
  const first = store.star(song('Artist - Song'));
  assert.equal(first.added, true);
  const again = store.star(song('artist -  song'));
  assert.equal(again.added, false);
  assert.equal(again.entry, first.entry);
  // The same name without an id is the same station; two different ids are not.
  assert.equal(store.star(song('Artist - Song', 'Jazz FM', '')).added, false);
  assert.equal(store.star(song('Artist - Song', 'Jazz FM', 'other-id')).added, true);
  assert.equal(store.star(song('Artist - Song', 'Rock FM')).added, true);
  assert.equal(store.size, 3);
  assert.equal(sameStarredSong(first.entry, makeStarredEntry({ starred: T0, ...song('ARTIST - SONG') })), true);
  const blocked = store.star(song('Jazz FM'));
  assert.equal(blocked.entry, null);
  assert.equal(blocked.reason, NOT_A_SONG);
  assert.equal(store.size, 3);
});

test('two songs are the same only from the same station: ids decide, then names, then neither', () => {
  const at = (station, stationId, title = 'Artist - Song') => makeStarredEntry({ starred: T0, title, station, stationId });
  // Two ids: equal is the same station whatever the names; different is not.
  assert.equal(sameStarredSong(at('Jazz FM', 'a'), at('Other name', 'a')), true);
  assert.equal(sameStarredSong(at('Jazz FM', 'a'), at('Jazz FM', 'b')), false);
  assert.equal(sameStarredSong(at('', 'a'), at('', 'b')), false);
  // One id or none: two names that are both given decide.
  assert.equal(sameStarredSong(at('Jazz FM', 'a'), at('jazz fm', '')), true);
  assert.equal(sameStarredSong(at('Jazz FM', ''), at('Rock FM', '')), false);
  assert.equal(sameStarredSong(at('', 'a'), at('', '')), false);
  assert.equal(sameStarredSong(at('Jazz FM', ''), at('', '')), false);
  assert.equal(sameStarredSong(at('', 'a'), at('Jazz FM', '')), false);
  // Neither an id nor a name on both: the same when the titles are.
  assert.equal(sameStarredSong(at('', ''), at('', '')), true);
  assert.equal(sameStarredSong(at('', ''), at('', '', 'Other - Song')), false);
});

test('the page cleans out what the server refuses: controls, separators, bidi and zero-width characters', () => {
  const unsafe = ['\u0085', '\u0080', '\u009F', '\u202A', '\u202E', '\u2066', '\u2069', '\u200E', '\u200F',
    '\u061C', '\u200B', '\u200D', '\u2060', '\uFEFF', '\u2028', '\u2029', '\u00AD'];
  // The same set as worldmedia_starred.py (_CONTROL_TEXT and _INVISIBLE_TEXT).
  const server = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  for (const char of unsafe) {
    const text = cleanStarredText(`Art${char}ist`, 200);
    assert.doesNotMatch(text, server, char.codePointAt(0).toString(16));
    const entry = makeStarredEntry({ starred: T0, title: `A${char}B - Song`, station: `Jazz${char}FM`, stationId: `x${char}`, source: `s${char}` });
    for (const field of ['title', 'station', 'stationId', 'source']) assert.doesNotMatch(entry[field], server, field);
  }
  assert.equal(cleanStarredText('Art\u061Cist \u2028 - Song', 200), 'Artist - Song');
});

test('at most 2000 are kept: one more drops the oldest and says which', () => {
  const saved = Array.from({ length: STARRED_SONGS_LIMIT }, (_, n) => ({ starred: T0 + n, ...song(`Song ${n}`) }));
  const { store } = starredStore({ saved, now: () => T0 + 10_000_000 });
  store.start();
  return drain().then(() => {
    assert.equal(store.size, STARRED_SONGS_LIMIT);
    const result = store.star(song('One more'));
    assert.equal(result.added, true);
    assert.equal(result.dropped.title, 'Song 0');
    assert.equal(store.size, STARRED_SONGS_LIMIT);
    assert.equal(store.entries()[0].title, 'Song 1');
    assert.equal(store.entries().at(-1).title, 'One more');
  });
});

test('starred songs survive the song log\'s limit and Clear log: they are a list of their own', async () => {
  const log = songLogWith(['One', 'Two']);
  const { store, server } = starredStore();
  store.start();
  await drain();
  store.star(song('One'));
  await log.clear();
  for (let n = 0; n < 600; n += 1) log.handleNowPlaying({ itemId: 'id:Jazz FM', title: `Filler ${n}`, changedAt: T0 + (n + 10) * 60_000 });
  await drain();
  assert.equal(log.size, 500);
  assert.deepEqual(store.entries().map((item) => item.title), ['One']);
  assert.deepEqual(server.entries.map((item) => item.title), ['One']);
});

test('saved like the song log: whole list with a newer revision; a stale write merges, and unstarred songs stay unstarred', async () => {
  const other = { starred: T0 + 5, ...song('From another window') };
  const { store, server } = starredStore({ saved: [{ starred: T0, ...song('Kept') }], revision: 3 });
  store.start();
  await drain();
  assert.deepEqual(store.entries().map((item) => item.title), ['Kept']);
  store.star(song('First'));
  await store.flush();
  assert.equal(server.posts.at(-1).revision, 4);
  assert.deepEqual(server.entries.map((item) => item.title), ['Kept', 'First']);
  // Another window wrote meanwhile: this page's unstar is stale, and is made
  // again on what is stored now.
  server.entries = [{ starred: T0, ...song('Kept') }, server.entries[1], other];
  server.revision = 9;
  store.unstar(store.entries()[0]);
  await drain();
  await store.flush();
  assert.deepEqual(store.entries().map((item) => item.title), ['First', 'From another window']);
  assert.deepEqual(server.entries.map((item) => item.title), ['First', 'From another window']);
  assert.equal(server.revision, 10);
  for (const body of server.posts) assert.deepEqual(Object.keys(body).sort(), ['entries', 'revision']);
});

/** Two windows on one data folder: each a store, both on the same server. */
function twoWindows(saved) {
  const server = { entries: saved, revision: 1 };
  const window = () => {
    let clock = T0;
    let hold = null; // when set, the next answer waits for it
    const store = createStarredSongs({
      native: true,
      now: () => { clock += 60_000; return clock; },
      request: async (_, options = {}) => {
        if (hold) await hold;
        if (options.method !== 'POST') return { entries: server.entries, revision: server.revision };
        if (options.body.revision <= server.revision) {
          return { saved: false, stale: true, revision: server.revision, entries: server.entries };
        }
        server.entries = options.body.entries;
        server.revision = options.body.revision;
        return { saved: true, revision: server.revision };
      },
      onSaveFailed: () => {},
      onSaved: () => {},
    });
    return { store, setHold: (promise) => { hold = promise; } };
  };
  return { server, one: window(), two: window() };
}

const titles = (list) => list.map((item) => item.title);

test('a song unstarred in one window is not brought back by a stale write from another (either order)', async () => {
  // Window one unstars A and saves first; window two stars B on the old list.
  {
    const { server, one, two } = twoWindows([{ starred: T0, ...song('A') }]);
    one.store.start();
    two.store.start();
    await drain();
    await one.store.unstar(one.store.entries()[0]);
    assert.deepEqual(titles(server.entries), []);
    await two.store.star(song('B')).saved;
    assert.deepEqual(titles(server.entries), ['B']);
    assert.deepEqual(titles(two.store.entries()), ['B']);
  }
  // Window two stars B and saves first; window one unstars A on the old list.
  {
    const { server, one, two } = twoWindows([{ starred: T0, ...song('A') }]);
    one.store.start();
    two.store.start();
    await drain();
    await two.store.star(song('B')).saved;
    assert.deepEqual(titles(server.entries), ['A', 'B']);
    await one.store.unstar(one.store.entries()[0]);
    assert.deepEqual(titles(server.entries), ['B']);
    assert.deepEqual(titles(one.store.entries()), ['B']);
  }
});

test('Clear cache stays a clear when another window saved a song this one never saw', async () => {
  const { server, one, two } = twoWindows([{ starred: T0, ...song('A') }]);
  one.store.start();
  two.store.start();
  await drain();
  await two.store.star(song('Seen only in two')).saved;
  // Window one's clear is stale: what is stored is not merged back in.
  assert.equal(await one.store.clear(), true);
  assert.deepEqual(server.entries, []);
  assert.deepEqual(one.store.entries(), []);
  // A song starred here after the clear, while the clear is still on its way, is kept.
  const { server: later, one: three, two: four } = twoWindows([{ starred: T0, ...song('A') }]);
  three.store.start();
  four.store.start();
  await drain();
  await four.store.star(song('Elsewhere')).saved;
  const cleared = three.store.clear();
  three.store.star(song('After the clear'));
  assert.equal(await cleared, true);
  await three.store.flush();
  assert.deepEqual(titles(later.entries), ['After the clear']);
});

test('a song starred then unstarred before the saved list arrives stays unstarred', async () => {
  const { server, one } = twoWindows([{ starred: T0 - 3_600_000, ...song('A') }]);
  let release;
  one.setHold(new Promise((resolve) => { release = resolve; }));
  one.store.start();
  // The read is still on its way: star A (a new time) and unstar it again.
  const result = one.store.toggle(song('A'));
  assert.equal(result.starred, true);
  assert.equal(one.store.toggle(song('A')).starred, false);
  one.setHold(null);
  release();
  await drain();
  await one.store.flush();
  await drain();
  await one.store.flush();
  assert.deepEqual(one.store.entries(), []);
  assert.deepEqual(server.entries, []);
});

test('nothing is written before the saved list was read, and a failed save is reported', async () => {
  const failures = [];
  let reads = 0;
  const store = createStarredSongs({
    native: true,
    request: async (_, options = {}) => {
      if (options.method !== 'POST') {
        reads += 1;
        if (reads === 1) throw new Error('busy');
        return { entries: [{ starred: T0, ...song('Saved') }], revision: 2 };
      }
      throw new Error('Disk full');
    },
    onSaveFailed: (error) => failures.push(error.message),
    onSaved: () => {},
  });
  store.start();
  await drain();
  const result = store.star(song('Starred while busy'));
  await assert.rejects(result.saved);
  assert.equal(reads, 2, 'read again before writing');
  assert.deepEqual(store.entries().map((item) => item.title), ['Saved', 'Starred while busy']);
  assert.ok(failures.length >= 1);
});

test('changes waiting through a long outage stay few: toggles keep only their net effect', async () => {
  let down = true;
  const server = { entries: [{ starred: T0, ...song('Saved') }], revision: 1 };
  const store = createStarredSongs({
    native: true,
    request: async (_, options = {}) => {
      if (options.method !== 'POST') return { entries: server.entries, revision: server.revision };
      if (down) throw new Error('Disk full');
      server.entries = options.body.entries;
      server.revision = options.body.revision;
      return { saved: true, revision: server.revision };
    },
    onSaveFailed: () => {},
    onSaved: () => {},
  });
  store.start();
  await drain();
  for (let index = 0; index < 10_000; index += 1) {
    store.toggle(song(`Song ${index % 7}`)).saved?.catch(() => {});
    store.toggle(song('Saved')).saved?.catch(() => {});
  }
  await drain();
  await store.flush().catch(() => {});
  assert.ok(store.pending <= 8, `${store.pending} changes wait`);
  // The net effect: each of the seven toggled 10000 / 7 times, Saved an even number of times.
  const expected = [...Array(7).keys()].filter((n) => Math.ceil((10_000 - n) / 7) % 2 === 1).map((n) => `Song ${n}`);
  assert.deepEqual(store.entries().map((item) => item.title).sort(), ['Saved', ...expected].sort());
  // Back up: what is saved is what was shown.
  down = false;
  store.star(song('Last')).saved.catch(() => {});
  await drain();
  await store.flush();
  await drain();
  assert.equal(store.pending, 0);
  assert.deepEqual(server.entries.map((item) => item.title), store.entries().map((item) => item.title));
});

test('a clear drops the changes before it, and a star and unstar of a song not saved cancel out', async () => {
  const server = { entries: [{ starred: T0, ...song('Saved') }], revision: 1 };
  const store = createStarredSongs({
    native: true,
    request: async (_, options = {}) => {
      if (options.method !== 'POST') return { entries: server.entries, revision: server.revision };
      throw new Error('Disk full');
    },
    onSaveFailed: () => {},
    onSaved: () => {},
  });
  store.start();
  await drain();
  store.toggle(song('New')).saved.catch(() => {});
  store.toggle(song('New')).saved?.catch(() => {});
  await drain();
  assert.equal(store.pending, 0, 'star then unstar of a song not saved: nothing left');
  store.toggle(song('Saved')).saved?.catch(() => {});
  await drain();
  assert.equal(store.pending, 1, 'the unstar of a saved song stays');
  store.star(song('A')).saved.catch(() => {});
  store.star(song('B')).saved.catch(() => {});
  store.clear().catch(() => {});
  assert.deepEqual(store.entries(), []);
  // Only what is on its way keeps its place; the waiting ones before the clear go.
  assert.ok(store.pending <= 3, `${store.pending} changes wait`);
  assert.equal(store.entries().length, 0);
});

test('Find: a web search and a YouTube search for the song text only, https on fixed hosts, the query encoded', () => {
  assert.deepEqual(SONG_SEARCHES.map((search) => search.id), ['web', 'youtube']);
  const title = 'AC/DC - Back in Black & Blue? #1 <script>alert(1)</script> 100%';
  for (const search of SONG_SEARCHES) {
    const url = new URL(songSearchUrl(search, title));
    assert.equal(url.protocol, 'https:');
    assert.ok(['duckduckgo.com', 'www.youtube.com'].includes(url.host), url.host);
    assert.equal(url.hash, '');
    const key = search.id === 'youtube' ? 'search_query' : 'q';
    assert.deepEqual([...url.searchParams.keys()], [key]);
    assert.equal(url.searchParams.get(key), title);
  }
  assert.equal(songSearchUrl(SONG_SEARCHES[1], 'a b'), 'https://www.youtube.com/results?search_query=a%20b');
  assert.equal(songSearchUrl(SONG_SEARCHES[0], 'x\n\u0000y'), 'https://duckduckgo.com/?q=x%20y');
});

/* ---------------- The panel ---------------- */

async function openPanel({ titles = ['One', 'Two'], starred = [], ...options } = {}) {
  const dom = miniDocument();
  const log = songLogWith(titles);
  const { store, server } = starredStore({ saved: starred });
  store.start();
  await drain();
  const panel = openSongLog({
    log, starred: store, documentImpl: dom.doc, formatTime: (time) => `t${(time - T0) / 60_000}`,
    setTimer: () => 0, clearTimer: () => {}, ...options,
  });
  return { ...dom, log, store, server, panel };
}

const rowsOf = (list) => list.children;
const titleOf = (row) => row.find((node) => node.className === 'song-log-title').textContent;
const buttonIn = (node, label) => node.find((child) => child.tagName === 'BUTTON' && child.textContent === label);
const byAct = (node, act) => node.find((child) => child.getAttribute('data-act') === act);
const starOf = (row) => byAct(row, 'star-song');

test('the panel shows Song log or Starred songs, one at a time, the shown one pressed', async () => {
  const { panel } = await openPanel();
  const logView = byAct(panel.dialog, 'show-song-log');
  const starredView = byAct(panel.dialog, 'show-starred-songs');
  assert.equal(panel.view, 'log');
  assert.equal(logView.getAttribute('aria-pressed'), 'true');
  assert.equal(panel.list.parentNode.hidden, false);
  assert.equal(panel.starList.parentNode.hidden, true);
  starredView.click();
  assert.equal(panel.view, 'starred');
  assert.equal(starredView.getAttribute('aria-pressed'), 'true');
  assert.equal(logView.getAttribute('aria-pressed'), 'false');
  assert.equal(panel.list.parentNode.hidden, true);
  assert.equal(panel.starList.parentNode.hidden, false);
  const empty = panel.dialog.find((node) => node.textContent === STARRED_EMPTY_TEXT);
  assert.equal(empty.hidden, false);
  assert.equal(buttonIn(panel.dialog, SAVE_TEXT_LABEL).disabled, true);
  assert.equal(buttonIn(panel.dialog, SAVE_CSV_LABEL).disabled, true);
  panel.close();
});

test('each log row has a star: pressed once starred, and off for a title that is not a song', async () => {
  const { panel, store, server } = await openPanel({ titles: ['Artist - Song', 'Jazz FM', 'Artist - Song B'] });
  const [b, station, a] = rowsOf(panel.list);
  assert.equal(starOf(a).textContent, STAR_MARK);
  assert.equal(starOf(a).getAttribute('aria-pressed'), 'false');
  assert.equal(starOf(a).getAttribute('aria-label'), 'Star "Artist - Song"');
  assert.equal(starOf(station).disabled, true);
  assert.equal(starOf(station).title, NOT_A_SONG);
  starOf(a).click();
  await drain();
  assert.equal(starOf(a).textContent, STARRED_MARK);
  assert.equal(starOf(a).getAttribute('aria-pressed'), 'true');
  assert.equal(starOf(a).getAttribute('aria-label'), 'Unstar "Artist - Song"');
  assert.equal(starOf(b).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(server.entries.map((item) => [item.title, item.station]), [['Artist - Song', 'Jazz FM']]);
  starOf(a).click();
  await drain();
  assert.equal(store.size, 0);
  assert.equal(starOf(a).getAttribute('aria-pressed'), 'false');
  panel.close();
});

test('Starred songs: newest first with title, station and date starred; count shown; live as songs are starred', async () => {
  const starred = [{ starred: T0 + 60_000, ...song('Older') }, { starred: T0 + 120_000, ...song('Newer', 'Rock FM') }];
  const { panel, store } = await openPanel({ starred, view: 'starred' });
  const rows = rowsOf(panel.starList);
  assert.deepEqual(rows.map(titleOf), ['Newer', 'Older']);
  const meta = rows[0].find((node) => node.className === 'song-log-meta');
  assert.equal(meta.text(), 'Starred t2 \u00B7 Rock FM');
  assert.equal(rows[0].find((node) => node.tagName === 'TIME').getAttribute('datetime'), new Date(T0 + 120_000).toISOString());
  assert.equal(panel.dialog.find((node) => node.className.includes('starred-count')).textContent, '2 starred songs');
  const kept = rows[1];
  store.star(song('Newest'));
  assert.deepEqual(rowsOf(panel.starList).map(titleOf), ['Newest', 'Newer', 'Older']);
  assert.equal(rowsOf(panel.starList)[2], kept, 'rows that stay are the same elements');
  panel.close();
});

test('a full list says so in the count, and says which song starring one more removed', async () => {
  const starred = Array.from({ length: STARRED_SONGS_LIMIT }, (_, n) => ({ starred: T0 + n, ...song(`Song ${n}`) }));
  const { panel } = await openPanel({ titles: ['Brand new'], starred });
  starOf(rowsOf(panel.list)[0]).click();
  assert.match(panel.status.textContent, /oldest starred song, "Song 0", was removed/);
  panel.showView('starred');
  assert.equal(panel.dialog.find((node) => node.className.includes('starred-count')).textContent,
    `${STARRED_SONGS_LIMIT} starred songs (the newest ${STARRED_SONGS_LIMIT} are kept: starring another removes the oldest)`);
  panel.close();
});

test('Find links open a web or YouTube search in the browser, as the app\'s other outside links do', async () => {
  const { panel } = await openPanel({ starred: [{ starred: T0, ...song('Artist & Co - Song?') }], view: 'starred' });
  const links = rowsOf(panel.starList)[0].findAll((node) => node.tagName === 'A');
  assert.deepEqual(links.map((link) => link.textContent), ['Web', 'YouTube']);
  assert.deepEqual(links.map((link) => link.getAttribute('href')), [
    'https://duckduckgo.com/?q=Artist%20%26%20Co%20-%20Song%3F',
    'https://www.youtube.com/results?search_query=Artist%20%26%20Co%20-%20Song%3F',
  ]);
  for (const link of links) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  }
  assert.equal(links[1].getAttribute('aria-label'), 'Search YouTube for "Artist & Co - Song?"');
  panel.close();
});

test('Copy and Unstar on a starred song; the keyboard stays in the list, links included', async () => {
  const written = [];
  const starred = [{ starred: T0, ...song('A') }, { starred: T0 + 1, ...song('B') }];
  const { panel, server, doc, store } = await openPanel({
    starred, view: 'starred', clipboard: { writeText: async (text) => { written.push(text); } },
  });
  const [b, a] = rowsOf(panel.starList);
  buttonIn(b, 'Copy').click();
  await drain();
  assert.deepEqual(written, ['B']);
  buttonIn(b, 'Unstar').click();
  await drain();
  assert.deepEqual(rowsOf(panel.starList).map(titleOf), ['A']);
  assert.deepEqual(server.entries.map((item) => item.title), ['A']);
  assert.equal(doc.activeElement, buttonIn(a, 'Unstar'));
  // Tab wraps from the last control (a button) and Shift+Tab from the first;
  // a focused link is inside the dialog, so Tab is left alone.
  const link = a.find((node) => node.tagName === 'A');
  link.focus();
  assert.equal(doc.key('Tab').defaultPrevented, false);
  assert.equal(store.size, 1);
  panel.close();
});

test('Save as text and Save as CSV send the list newest first with the format; then Open folder', async () => {
  const sent = [];
  const starred = [{ starred: T0, ...song('Old') }, { starred: T0 + 1, ...song('New') }];
  const { panel } = await openPanel({
    starred, view: 'starred',
    saveStarred: async (format, entries) => {
      sent.push([format, entries.map((item) => item.title)]);
      return { name: `WorldMedia-starred-songs-20261115-080000.${format}`, count: entries.length };
    },
  });
  buttonIn(panel.dialog, SAVE_TEXT_LABEL).click();
  await drain();
  assert.equal(panel.status.textContent, 'Saved: WorldMedia-starred-songs-20261115-080000.txt');
  assert.equal(buttonIn(panel.dialog, 'Open folder').hidden, false);
  buttonIn(panel.dialog, SAVE_CSV_LABEL).click();
  await drain();
  assert.deepEqual(sent, [['txt', ['New', 'Old']], ['csv', ['New', 'Old']]]);
  panel.close();
});

test('the starred list is plain text only, and the panel still never parses markup', async () => {
  const markup = '<img src=x onerror="alert(1)"> - Song';
  const { panel } = await openPanel({ starred: [{ starred: T0, ...song(markup, '<b>FM</b>') }], view: 'starred' });
  const row = rowsOf(panel.starList)[0];
  assert.equal(titleOf(row), markup);
  assert.equal(row.findAll((node) => node.tagName === 'IMG' || node.tagName === 'B').length, 0);
  panel.close();
  for (const file of ['song-log-panel.js', 'starred-songs.js', 'song-star.js']) {
    const source = await readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|window\.open/, file);
  }
});

/* ---------------- The player bar ---------------- */

function playerStar({ playing = null, item = null } = {}) {
  const { doc } = miniDocument();
  const button = doc.createElement('button');
  button.hidden = true;
  const listeners = new Map();
  const subscribe = (event, fn) => {
    listeners.set(event, fn);
    return () => listeners.delete(event);
  };
  const { store, server } = starredStore();
  store.start();
  const state = { playing, item };
  const bound = bindSongStar({
    button, starred: store, subscribe,
    getNowPlaying: () => state.playing, getCurrentItem: () => state.item,
  });
  const fire = () => listeners.get(NOW_PLAYING_EVENT)?.({});
  return { button, store, server, state, fire, bound, listeners };
}

test('the player bar star shows only while the playing station announces a song, and stars it', async () => {
  const station = { id: 'rb:1', title: 'Jazz FM', source: 'radio-browser' };
  const star = playerStar();
  assert.equal(star.button.hidden, true);
  star.state.item = station;
  star.state.playing = { itemId: 'rb:1', title: 'Artist - Song' };
  star.fire();
  assert.equal(star.button.hidden, false);
  assert.equal(star.button.getAttribute('aria-label'), 'Star "Artist - Song"');
  star.button.click();
  await drain();
  assert.equal(star.button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(star.server.entries.map((item) => [item.title, item.station, item.stationId, item.source]),
    [['Artist - Song', 'Jazz FM', 'rb:1', 'radio-browser']]);
  star.button.click();
  assert.equal(star.button.getAttribute('aria-pressed'), 'false');
  assert.equal(star.store.size, 0);
  // Another station's song, the station's own name, or no song: no star.
  star.state.playing = { itemId: 'rb:2', title: 'Artist - Song' };
  star.fire();
  assert.equal(star.button.hidden, true);
  star.state.playing = { itemId: 'rb:1', title: 'Jazz FM' };
  star.fire();
  assert.equal(star.button.hidden, true);
  star.state.playing = null;
  star.fire();
  assert.equal(star.button.hidden, true);
  star.bound.destroy();
  assert.equal(star.listeners.size, 0);
});

test('the player bar star follows a star set in the song log', async () => {
  const station = { id: 'rb:1', title: 'Jazz FM', source: 'radio-browser' };
  const star = playerStar({ item: station, playing: { itemId: 'rb:1', title: 'Song' } });
  assert.equal(star.button.getAttribute('aria-pressed'), 'false');
  star.store.star(song('Song', 'Jazz FM', 'rb:1'));
  assert.equal(star.button.getAttribute('aria-pressed'), 'true');
  star.bound.destroy();
});

test('wired in: the star button sits on the song line, the store starts at boot, and Clear cache clears it', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const row = html.slice(html.indexOf('<div class="player-source-row">'), html.indexOf('id="player-fav"'));
  assert.match(row, /id="player-source"/);
  assert.match(row, /<button id="player-song-star" class="player-song-star" type="button" title="Star this song" aria-label="Star this song" aria-pressed="false" hidden>/);
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /starredSongs\.start\(\)/);
  assert.match(main, /bindSongStar\(\{\s*button: document\.getElementById\('player-song-star'\)/);
  const state = await readFile(new URL('../src/lib/state.js', import.meta.url), 'utf8');
  assert.match(state, /songLog\.clear\(\), starredSongs\.clear\(\)/);
  const settings = await readFile(new URL('../src/lib/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /the song log, starred songs, and job history/);
  // Kept out of browser storage and the mirrored profile.
  const store = await readFile(new URL('../src/lib/starred-songs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /localStorage\.|sessionStorage|from '\.\/profile-transfer/);
  const transfer = await readFile(new URL('../src/lib/profile-transfer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(transfer, /starred/i);
});

test('a log entry and a starred song are different shapes: the log is never changed by starring', async () => {
  const log = songLogWith(['One']);
  const before = log.entries()[0];
  const { store } = starredStore();
  store.start();
  store.star(before);
  assert.equal(log.entries()[0], before);
  assert.deepEqual(Object.keys(before).sort(), Object.keys(makeSongLogEntry({ time: T0, title: 'x' })).sort());
  assert.deepEqual(Object.keys(store.entries()[0]).sort(), ['source', 'starred', 'station', 'stationId', 'title']);
});

test('the player-bar star answers over 24 x 24 px while it takes 18 px of the song line', async () => {
  const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const star = rule('.player-song-star');
  assert.match(star, /padding: 2px;/);
  assert.match(star, /position: relative;/);
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="player-song-star"[^>]*>\s*<svg viewBox="0 0 24 24" width="14" height="14"/);
  const layer = rule('.player-song-star::before');
  assert.match(layer, /position: absolute;/);
  const inset = Number(layer.match(/inset: -(\d+)px;/)[1]);
  assert.ok(14 + 2 * 2 + 2 * inset >= 24, 'hit area at least 24 px');
});
