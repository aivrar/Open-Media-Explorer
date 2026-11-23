import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  MAX_PLAYED_STREAMS, PLAYED_STREAMS_KEY, clearPlayedStreams, createPlayedStreamNote, forgetLoadedPlayedStreams,
  onPlayedStreamChange, playedStreamOf, rememberPlayedStream, sameStreamFacts, stationStreamLabel,
  streamFactsFromRelay, streamTooltipLine, compactStreamLabel, stationStreamFacts,
} from '../src/lib/played-streams.js';
import { codecFromContentType } from '../src/lib/stream-quality.js';
import { createNowPlayingPoller } from '../src/lib/now-playing.js';
import { clearCache, getState, STORAGE_KEYS } from '../src/lib/state.js';
import { syncTunerMarks } from '../src/modes/tuner.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { renderResults, syncStreamLabels } from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const DOT = '·';

class MemoryStorage {
  constructor() { this.data = new Map(); this.writes = 0; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.writes += 1; this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

/** A fresh browser storage, put back afterwards. */
function withStorage(t, storage = new MemoryStorage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  forgetLoadedPlayedStreams();
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    forgetLoadedPlayedStreams();
  });
  return storage;
}

function withFavorites(t, list) {
  const state = getState();
  const before = state.favorites;
  state.favorites = list;
  t.after(() => { state.favorites = before; });
}

/* ============ What the relay says ============ */

test('the relay\'s content type and icy-br become a format and a bitrate', () => {
  assert.equal(codecFromContentType('audio/mpeg'), 'MP3');
  assert.equal(codecFromContentType('Audio/MPEG; charset=x'), 'MP3');
  assert.equal(codecFromContentType('audio/aacp'), 'AAC+');
  assert.equal(codecFromContentType('audio/aac'), 'AAC');
  assert.equal(codecFromContentType('application/ogg'), 'OGG');
  assert.equal(codecFromContentType('audio/flac'), 'FLAC');
  assert.equal(codecFromContentType('text/html'), '');
  assert.equal(codecFromContentType(null), '');
  assert.deepEqual(streamFactsFromRelay({ content_type: 'audio/mpeg', bitrate: 128 }), { codec: 'MP3', bitrate: 128 });
  assert.deepEqual(streamFactsFromRelay({ content_type: '', bitrate: 96 }), { codec: '', bitrate: 96 });
  assert.deepEqual(streamFactsFromRelay({ content_type: 'audio/aacp', bitrate: 0 }), { codec: 'AAC+', bitrate: 0 });
  for (const nothing of [null, undefined, [], 'audio/mpeg', { content_type: 'text/html', bitrate: 0 }, { bitrate: -5 }]) {
    assert.equal(streamFactsFromRelay(nothing), null, JSON.stringify(nothing));
  }
  assert.equal(sameStreamFacts({ codec: 'MP3', bitrate: 128 }, { codec: 'MP3', bitrate: 128 }), true);
  assert.equal(sameStreamFacts({ codec: 'MP3', bitrate: 128 }, { codec: 'MP3', bitrate: 192 }), false);
  assert.equal(sameStreamFacts(null, { codec: 'MP3', bitrate: 128 }), false);
});

test('the now-playing poll reports the stream facts once, and again only when they change', async () => {
  const replies = [
    { title: null, changed_at: null },
    { title: null, changed_at: null, stream: { content_type: 'audio/mpeg', bitrate: 128 } },
    { title: 'Song', changed_at: 1, stream: { content_type: 'audio/mpeg', bitrate: 128 } },
    { title: 'Song', changed_at: 1, stream: { content_type: 'audio/mpeg', bitrate: 192 } },
  ];
  const timers = [];
  const streams = [];
  const poller = createNowPlayingPoller({
    fetchTitle: async () => replies.shift() ?? { title: 'Song', changed_at: 1 },
    onStream: (state) => streams.push(state),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  poller.follow('relay-1', { itemId: 'playlist:0001' });
  for (let i = 0; i < 5; i += 1) {
    timers.shift()();
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(streams, [
    { itemId: 'playlist:0001', mediaId: 'relay-1', stream: { codec: 'MP3', bitrate: 128 } },
    { itemId: 'playlist:0001', mediaId: 'relay-1', stream: { codec: 'MP3', bitrate: 192 } },
  ]);
  // The song state keeps its shape.
  assert.deepEqual(Object.keys(poller.state).sort(), ['changedAt', 'itemId', 'mediaId', 'title']);
  poller.stop();
});

/* ============ Remembering ============ */

test('a station\'s stream is kept per item, written only when it changes', (t) => {
  const storage = withStorage(t);
  const seen = [];
  t.after(onPlayedStreamChange((id) => seen.push(id)));
  assert.equal(playedStreamOf('playlist:a'), null);
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 }), true);
  assert.equal(storage.writes, 1);
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 }), false, 'the same again is not written');
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'mp3', bitrate: '128' }), false, 'cleaned, it is the same');
  assert.equal(storage.writes, 1);
  assert.deepEqual(JSON.parse(storage.getItem(PLAYED_STREAMS_KEY)), { version: 1, items: [['playlist:a', 'MP3', 128]] });
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), true);
  assert.equal(storage.writes, 2);
  // Read back by a new page.
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 320 });
  assert.deepEqual(seen, ['playlist:a', 'playlist:a']);
  for (const id of ['', null, 5, 'x'.repeat(513)]) assert.equal(rememberPlayedStream(id, { codec: 'MP3', bitrate: 1 }), false);
  for (const facts of [null, {}, { codec: '', bitrate: 0 }, { codec: 'unknown', bitrate: -1 }]) {
    assert.equal(rememberPlayedStream('playlist:b', facts), false);
  }
  assert.equal(storage.writes, 2);
});

test('a write that fails keeps nothing, so a later play tries the same values again', (t) => {
  const storage = withStorage(t);
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  const seen = [];
  t.after(onPlayedStreamChange((id) => seen.push(id)));
  const setItem = storage.setItem;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), false);
  assert.equal(rememberPlayedStream('playlist:b', { codec: 'AAC', bitrate: 64 }), false);
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 128 }, 'the saved value stays');
  assert.equal(playedStreamOf('playlist:b'), null);
  assert.deepEqual(seen, [], 'nothing changed on screen');
  // The storage works again: the same values are not taken as unchanged.
  storage.setItem = setItem;
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), true);
  assert.equal(rememberPlayedStream('playlist:b', { codec: 'AAC', bitrate: 64 }), true);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 320 });
  assert.deepEqual(playedStreamOf('playlist:b'), { codec: 'AAC', bitrate: 64 });
  // No storage at all: nothing is kept as if saved.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: undefined });
  forgetLoadedPlayedStreams();
  assert.equal(rememberPlayedStream('playlist:c', { codec: 'MP3', bitrate: 128 }), false);
  assert.equal(playedStreamOf('playlist:c'), null);
});

test('the remembered streams are bounded: the oldest go first', (t) => {
  withStorage(t);
  assert.equal(MAX_PLAYED_STREAMS, 1000);
  for (let i = 0; i < MAX_PLAYED_STREAMS + 5; i += 1) rememberPlayedStream(`id-${i}`, { codec: 'MP3', bitrate: 64 + i });
  assert.equal(playedStreamOf('id-0'), null);
  assert.equal(playedStreamOf('id-4'), null);
  assert.deepEqual(playedStreamOf('id-5'), { codec: 'MP3', bitrate: 69 });
  // Changed: it is the newest now and stays.
  rememberPlayedStream('id-5', { codec: 'AAC', bitrate: 69 });
  rememberPlayedStream('id-new', { codec: 'MP3', bitrate: 128 });
  assert.deepEqual(playedStreamOf('id-5'), { codec: 'AAC', bitrate: 69 });
  assert.equal(playedStreamOf('id-6'), null);
  forgetLoadedPlayedStreams();
  assert.equal(JSON.parse(globalThis.localStorage.getItem(PLAYED_STREAMS_KEY)).items.length, MAX_PLAYED_STREAMS);
});

test('an unreadable or foreign stored value is an empty cache', (t) => {
  const storage = withStorage(t);
  for (const value of ['not json', '{"version":2,"items":[["a","MP3",128]]}', '{"version":1,"items":{}}', 'null']) {
    storage.setItem(PLAYED_STREAMS_KEY, value);
    forgetLoadedPlayedStreams();
    assert.equal(playedStreamOf('a'), null, value);
  }
  storage.setItem(PLAYED_STREAMS_KEY, JSON.stringify({ version: 1, items: [['a', 'MP3', 128], ['b', '', 0], [7, 'MP3', 1], 'c'] }));
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('a'), { codec: 'MP3', bitrate: 128 });
  assert.equal(playedStreamOf('b'), null);
});

test('Clear cache removes them; they are no part of the profile or a backup', async (t) => {
  const storage = withStorage(t);
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  await clearCache().catch(() => {});
  assert.equal(storage.getItem(PLAYED_STREAMS_KEY), null);
  assert.equal(playedStreamOf('playlist:a'), null);
  assert.ok(!Object.values(STORAGE_KEYS).includes(PLAYED_STREAMS_KEY));
  for (const path of ['src/lib/profile-transfer.js', 'worldmedia_backup.py', 'worldmedia_runtime.py', 'worldmedia_profile.py']) {
    const text = await read(path).catch(() => '');
    assert.doesNotMatch(text, /playedstreams|played-streams/i, path);
  }
  clearPlayedStreams(); // nothing left: no error, nothing written
});

/* ============ Only a start that played ============ */

test('the relay\'s facts are remembered only once the start has played, in either order', () => {
  const kept = [];
  const note = createPlayedStreamNote({ remember: (id, facts) => { kept.push([id, facts]); return true; } });
  // Heard first, played after.
  note.begin();
  assert.equal(note.heard('a', { codec: 'MP3', bitrate: 128 }), false);
  assert.deepEqual(kept, []);
  assert.equal(note.played('a'), true);
  assert.deepEqual(kept, [['a', { codec: 'MP3', bitrate: 128 }]]);
  // Played first, heard after (and heard again with other values).
  note.begin();
  note.played('b');
  assert.equal(note.heard('b', { codec: 'AAC+', bitrate: 64 }), true);
  assert.equal(note.heard('b', { codec: 'AAC+', bitrate: 48 }), true);
  assert.deepEqual(kept.slice(1), [['b', { codec: 'AAC+', bitrate: 64 }], ['b', { codec: 'AAC+', bitrate: 48 }]]);
});

test('nothing is remembered for a start that does not play', () => {
  const kept = [];
  const note = createPlayedStreamNote({ remember: (id, facts) => { kept.push([id, facts]); return true; } });
  note.begin();
  note.heard('a', { codec: 'MP3', bitrate: 128 });
  // It failed: the next start begins, and that one plays another station.
  note.begin();
  note.played('b');
  assert.deepEqual(kept, []);
  // Heard for one station, another played: not mixed up.
  note.begin();
  note.heard('c', { codec: 'MP3', bitrate: 128 });
  note.played('d');
  assert.deepEqual(kept, []);
  // Nothing worth keeping.
  note.begin();
  note.played('e');
  assert.equal(note.heard('e', { codec: '', bitrate: 0 }), false);
  assert.equal(note.heard('e', null), false);
  assert.deepEqual(kept, []);
});

test('the player ties the facts to its start: begin with each start, played after a second of play', async () => {
  const player = await read('src/lib/player.js');
  assert.match(player, /playSession = newPlaySession\(myToken\);\s+playedStreamNote\.begin\(\);/);
  assert.match(player, /startOutcome\.played\(currentItem\?\.id\);[\s\S]{0,120}playedStreamNote\.played\(currentItem\?\.id\);/);
  assert.match(player, /onStream: \(\{ itemId, stream \}\) => \{\s+if \(itemId && itemId === currentItem\?\.id\) playedStreamNote\.heard\(itemId, stream\);/);
  // No timer or request of its own: the facts come with the song poll.
  const module = await read('src/lib/played-streams.js');
  assert.doesNotMatch(module, /setTimeout|setInterval|fetch\(|controlRequest/);
});

/* ============ What is shown ============ */

test('the label: the played values, the directory\'s as before, and nothing when nothing is known', (t) => {
  withStorage(t);
  const own = { id: 'playlist:a', source: 'playlist' };
  assert.equal(stationStreamLabel(own), '', 'never played: nothing, no filler');
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  assert.equal(stationStreamLabel(own), `MP3 ${DOT} 128 kbps`);
  rememberPlayedStream('playlist:b', { codec: '', bitrate: 96 });
  assert.equal(stationStreamLabel({ id: 'playlist:b' }), '96 kbps');
  // Radio Browser: the listed values stay.
  const listed = { id: 'rb:1', _extra: { codec: 'AAC+', bitrate: 64 } };
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  rememberPlayedStream('rb:1', { codec: 'AAC+', bitrate: 64 });
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  // They disagree: the listed values stay, nothing is added.
  rememberPlayedStream('rb:1', { codec: 'AAC', bitrate: 128 });
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  // The directory leaves the bitrate out and the format agrees: filled in.
  rememberPlayedStream('rb:2', { codec: 'MP3', bitrate: 128 });
  assert.equal(stationStreamLabel({ id: 'rb:2', _extra: { codec: 'MP3', bitrate: 0 } }), `MP3 ${DOT} 128 kbps`);
  rememberPlayedStream('rb:3', { codec: 'OGG', bitrate: 128 });
  assert.equal(stationStreamLabel({ id: 'rb:3', _extra: { codec: 'MP3', bitrate: 0 } }), 'MP3');
  // The directory lists nothing: the played values.
  rememberPlayedStream('rb:4', { codec: 'MP3', bitrate: 192 });
  assert.equal(stationStreamLabel({ id: 'rb:4', _extra: { stationuuid: 'x' } }), `MP3 ${DOT} 192 kbps`);
  assert.equal(streamTooltipLine(`MP3 ${DOT} 128 kbps`), `Stream: MP3 ${DOT} 128 kbps`);
  assert.equal(streamTooltipLine(''), '');
  // The Tuner card's short form, from the same parts.
  assert.deepEqual(stationStreamFacts({ id: 'rb:2', _extra: { codec: 'MP3', bitrate: 0 } }),
    { codec: 'MP3', bitrate: 128, hls: false });
  assert.equal(compactStreamLabel({ codec: 'AAC', bitrate: 128 }), 'AAC 128k');
  assert.equal(compactStreamLabel({ codec: 'AAC+', bitrate: 320 }), 'AAC+ 320k');
  assert.equal(compactStreamLabel({ codec: 'MP3', bitrate: 0 }), 'MP3');
  assert.equal(compactStreamLabel({ codec: '', bitrate: 128 }), '128k');
  assert.equal(compactStreamLabel({ hls: true }), 'HLS');
  assert.equal(compactStreamLabel({}), '');
});

class Node extends FakeElement {
  constructor(id = '', tag = 'div') {
    super(id, tag);
    this.parentNode = null;
    this.html = '';
  }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.length; }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = value;
    if (value === '') for (const child of [...this.children]) this.removeChild(child);
  }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') {
      for (const node of [...child.children]) this.appendChild(node);
      return child;
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll(selector) {
    return selector === '.card' ? this.children.filter((node) => node.className?.startsWith('card')) : [];
  }
}

test('Library cards: the label in the tooltip, and in the technical column; changed in place', (t) => {
  withStorage(t);
  // __contentHidden keeps these cards from asking the artwork relay for logos.
  withFavorites(t, [
    { id: 'fav:a', title: 'Alpha', type: 'radio', source: 'playlist', __contentHidden: true },
    { id: 'fav:b', title: 'Beta', type: 'radio', source: 'playlist', __contentHidden: true },
  ]);
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const before = { source: view.activeSource, filters: { ...view.personalFilters.favorites }, signature: view.renderSignature };
  const host = new Node('', 'div');
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node('', tag),
    createDocumentFragment: () => new Node('', 'fragment'),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  ui.resultsHost = host;
  ui.windowBack = null;
  ui.sentinelStatus = null;
  renderedIds.clear();
  view.activeSource = 'favorites';
  view.personalFilters.favorites = { query: '', type: '' };
  t.after(() => {
    renderedIds.clear();
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    view.activeSource = before.source;
    view.personalFilters.favorites = before.filters;
    view.renderSignature = before.signature;
  });

  rememberPlayedStream('fav:a', { codec: 'MP3', bitrate: 128 });
  renderResults();
  const [alpha, beta] = host.children;
  assert.equal(alpha.__open.getAttribute('title'), `Alpha\nStream: MP3 ${DOT} 128 kbps`);
  assert.equal(alpha.__titleNode.getAttribute('title'), `Alpha\nStream: MP3 ${DOT} 128 kbps`);
  const column = alpha.__license;
  assert.equal(column.className, 'card-license has-quality is-quality-only');
  assert.equal(column.parentNode, alpha.__meta);
  assert.deepEqual(column.children.map((child) => [child.className, child.textContent]), [['card-quality', `MP3 ${DOT} 128 kbps`]]);
  // Never played: no column and no extra tooltip line.
  assert.equal(beta.__license, null);
  assert.equal(beta.__open.getAttribute('title'), 'Beta');

  // Beta played: only its text changes; the cards stay.
  rememberPlayedStream('fav:b', { codec: 'AAC+', bitrate: 64 });
  syncStreamLabels();
  assert.deepEqual(host.children, [alpha, beta]);
  assert.equal(beta.__open.getAttribute('title'), `Beta\nStream: AAC+ ${DOT} 64 kbps`);
  assert.equal(beta.__license.children[0].textContent, `AAC+ ${DOT} 64 kbps`);
  // The same again changes nothing.
  const kept = beta.__license;
  syncStreamLabels();
  assert.equal(beta.__license, kept);
  // Clear cache: the text goes again.
  clearPlayedStreams();
  syncStreamLabels();
  assert.equal(alpha.__license, null);
  assert.equal(alpha.__open.getAttribute('title'), 'Alpha');
  assert.equal(alpha.__meta.children.some((child) => child === column), false);
});

test('Tuner cards: the label after the source, and in the tooltip; changed in place', (t) => {
  withStorage(t);
  withFavorites(t, [{ id: 'fav:a', title: 'Alpha', type: 'radio', source: 'playlist' }]);
  const oldDocument = globalThis.document;
  const strip = new Node('', 'div');
  const pills = [['fav:a', 'Alpha'], ['fav:b', 'Beta']].map(([id, title]) => {
    const pill = new Node('', 'button');
    pill.className = 'station-pill';
    pill.__sourceLine = pill.appendChild(Object.assign(new Node('', 'small'), { textContent: 'My Playlists' }));
    pill.__station = { id, title, source: 'playlist' };
    pill.__saved = id === 'fav:a';
    strip.appendChild(pill);
    return pill;
  });
  globalThis.document = {
    activeElement: pills[1],
    createElement: (tag) => new Node('', tag),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  t.after(() => { globalThis.document = oldDocument; });

  rememberPlayedStream('fav:a', { codec: 'MP3', bitrate: 128 });
  syncTunerMarks(strip);
  assert.deepEqual(strip.children, pills);
  const [alpha, beta] = pills;
  assert.equal(alpha.__quality.className, 'pill-quality');
  // Stream first (short form), source second, as one text with real spaces
  // around the dot.
  assert.equal(alpha.__quality.textContent, `MP3 128k ${DOT} My Playlists`);
  assert.equal(alpha.__quality.parentNode, alpha.__sourceLine, 'on the source line: no new row');
  // The plain source text stays: it is what sizes the card, and what shows
  // with the setting off.
  assert.equal(alpha.__sourceLine.textContent, 'My Playlists');
  assert.equal(alpha.__sourceLine.classList.contains('pill-with-quality'), true, 'sized so the card keeps its width');
  assert.equal(beta.__sourceLine.classList.contains('pill-with-quality'), false);
  assert.match(alpha.getAttribute('title'), new RegExp(`^★ Favorite ${DOT} Alpha ${DOT} .+\\nStream: MP3 ${DOT} 128 kbps$`));
  assert.equal(beta.__quality ?? null, null);
  assert.doesNotMatch(beta.getAttribute('title'), /Stream:/);
  // Played again with another bitrate: the same span, new text.
  const span = alpha.__quality;
  rememberPlayedStream('fav:a', { codec: 'MP3', bitrate: 192 });
  syncTunerMarks(strip);
  assert.equal(alpha.__quality, span);
  assert.equal(span.textContent, `MP3 192k ${DOT} My Playlists`);
  // The tooltip keeps the full form.
  assert.match(alpha.getAttribute('title'), new RegExp(`\\nStream: MP3 ${DOT} 192 kbps$`));
  // Format only, and bitrate only.
  rememberPlayedStream('fav:a', { codec: 'AAC+', bitrate: 0 });
  syncTunerMarks(strip);
  assert.equal(span.textContent, `AAC+ ${DOT} My Playlists`);
  rememberPlayedStream('fav:a', { codec: '', bitrate: 128 });
  syncTunerMarks(strip);
  assert.equal(span.textContent, `128k ${DOT} My Playlists`);
  assert.match(alpha.getAttribute('title'), /\nStream: 128 kbps$/);
  clearPlayedStreams();
  syncTunerMarks(strip);
  assert.equal(alpha.__quality, null);
  assert.equal(span.parentNode, null);
  assert.equal(alpha.__sourceLine.classList.contains('pill-with-quality'), false);
});

test('Tuner cards keep their width at every size when the format and bitrate come', async () => {
  const css = (await read('src/styles/tuner.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  // The stream line counts for nothing when the card is sized, sits in the
  // first row over the room the name and the plain source give, and is cut
  // short at its end there.
  const quality = rule('.pill-with-quality > .pill-quality');
  for (const part of ['grid-area: 1 / 1;', 'min-width: 0;', 'contain: inline-size;', 'overflow: hidden;',
    'white-space: nowrap;', 'text-overflow: ellipsis;']) assert.ok(quality.includes(part), part);
  // Only with the setting on: the plain source text goes to a second row of
  // no height (clipped by the line's overflow: hidden), where it still sizes
  // the column; off, the line is exactly as before.
  const on = rule(':root[data-tech-details="on"] .pill-with-quality');
  assert.match(on, /display: grid;/);
  assert.match(on, /grid-template-columns: minmax\(0, auto\);/);
  assert.match(on, /grid-template-rows: auto 0;/);
  assert.match(rule('.station-pill > small'), /overflow: hidden;/);
  assert.match(css, /:root:not\(\[data-tech-details="on"\]\) \.pill-quality \{ display: none; \}/);
  // No card size gives the source line or the stream line a width of its own,
  // or undoes the above.
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g);
  const mine = new Set(['.pill-with-quality > .pill-quality', ':root[data-tech-details="on"] .pill-with-quality']);
  for (const block of blocks) {
    const selector = block.slice(0, block.indexOf('{')).trim();
    if (/small|pill-quality|pill-with-quality/.test(selector) && !mine.has(selector)) {
      assert.doesNotMatch(block,
        /(?:^|[\s;{])(?:(?:width|max-width|flex-basis|flex|contain):|min-width: (?!0;)|display: (?!none;))/, selector);
    }
  }
  for (const size of ['medium', 'large']) {
    assert.doesNotMatch(css, new RegExp(`data-card-size='${size}'[^{]*(small|pill-quality|pill-with-quality)`));
  }
  assert.doesNotMatch(css, /data-card-size='small'/);
});

test('on cards only with technical details on; the card keeps its height; the setting says so', async () => {
  const [libraryCss, tunerCss, settings, tuner, index] = await Promise.all([
    read('src/styles/library.css'), read('src/styles/tuner.css'), read('src/lib/settings.js'),
    read('src/modes/tuner.js'), read('src/modes/library/index.js'),
  ]);
  assert.match(libraryCss, /:root:not\(\[data-tech-details="on"\]\) \.card-license \{ display: none; \}/);
  assert.match(tunerCss, /:root:not\(\[data-tech-details="on"\]\) \.pill-quality \{ display: none; \}/);
  // Compact cards: alone, it takes only the room beside the badge (no new line).
  assert.match(libraryCss,
    /:root\[data-tech-details="on"\] \.library-root\.is-personal-view \.card-license\.is-quality-only \{ flex: 1 1 0; min-width: 0; \}/);
  assert.match(settings, /stream format and bitrate \(such as MP3 · 128 kbps\) once a station has played/);
  assert.doesNotMatch(settings, /full source badges/);
  // A change shows at once, without rebuilding the strip or the cards.
  assert.match(tuner, /subs\.push\(onPlayedStreamChange\(\(\) => \{\s*if \(getState\(\)\.mode === 'tuner'\) syncTunerMarks\(\);/);
  assert.match(index, /subs\.push\(onPlayedStreamChange\(\(\) => \{ syncStreamLabels\(\); refreshDetailQuality\(\); \}\)\);/);
});
