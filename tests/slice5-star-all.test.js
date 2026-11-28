import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement } from './helpers/fake-dom.js';
import {
  addFavorite, addFavorites, BULK_FAVORITES_LIMIT, countNewFavorites, getState, isFavorite, removeFavorite,
  STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import {
  addFavoriteEq, addFavoritesEq, EQ_STORAGE_KEY, freshEqState, getEffectiveEq, normalizeEqState, setScopedEq,
} from '../src/lib/eq-store.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { exportPlaylist, loadPlaylists } from '../src/lib/playlists.js';
import { FAVORITE_NAMES_KEY } from '../src/lib/favorite-names.js';
import { STATION_STREAMS_KEY } from '../src/lib/station-stream-addresses.js';
import { libraryExportSelection, STAR_ALL_CONFIRM_ABOVE, starAllListed, starAllMessage } from '../src/modes/library/personal-controls.js';
import { renderResults } from '../src/modes/library/render.js';
import { view } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';

const channel = (id, extra = {}) => ({
  id: `playlist:${id}`, source: 'playlist', title: `Channel ${id}`, type: 'tv',
  stream_url: `https://example.org/${id}.m3u8`, stream_kind: 'hls', delivery: 'live', ...extra,
});

/** Fake localStorage that counts writes per key and can refuse favorites. */
function withStorage(fn) {
  const previousStorage = globalThis.localStorage;
  const state = getState();
  const previousFavorites = state.favorites;
  const values = new Map();
  const writes = new Map();
  const storage = {
    failFavorites: false,
    failEq: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (storage.failFavorites && key === STORAGE_KEYS.favorites) throw new Error('Quota exceeded');
      if (storage.failEq && key === EQ_STORAGE_KEY) throw new Error('Quota exceeded');
      values.set(key, value);
      writes.set(key, (writes.get(key) || 0) + 1);
    },
    removeItem: (key) => values.delete(key),
  };
  let events = 0;
  const off = subscribe('favorites-change', () => events++);
  globalThis.localStorage = storage;
  state.favorites = [];
  try {
    return fn({ storage, values, writes, state, events: () => events });
  } finally {
    off();
    state.favorites = previousFavorites;
    globalThis.localStorage = previousStorage;
    clearPersistenceFailure('favorites');
  }
}

test('bulk add keeps the given order at the front, skips saved items, and saves once', () => {
  withStorage(({ values, writes, state, events }) => {
    assert.equal(addFavorite(channel('a')), true);
    writes.clear();
    const before = events();
    const result = addFavorites([channel('b'), channel('a'), channel('c'), channel('b'), null, {}]);
    assert.deepEqual(result, { added: 2, already: 2, refused: 2, leftOut: 0, failed: false, eqFailed: false });
    assert.deepEqual(state.favorites.map((f) => f.id), ['playlist:b', 'playlist:c', 'playlist:a']);
    assert.equal(writes.get(STORAGE_KEYS.favorites), 1);
    assert.equal(writes.has(EQ_STORAGE_KEY), false);
    assert.equal(events() - before, 1);
    // New station favorites follow the main equalizer until assigned a preset.
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEYS.favorites)).map((f) => f.id), state.favorites.map((f) => f.id));
    // Nothing new: no save and no event.
    writes.clear();
    assert.deepEqual(addFavorites([channel('a'), channel('c')]), { added: 0, already: 2, refused: 0, leftOut: 0, failed: false });
    assert.equal(writes.size, 0);
    assert.equal(events() - before, 1);
  });
});

test('bulk add stops at the favorites limit and says how many were left out', () => {
  withStorage(({ state }) => {
    assert.equal(BULK_FAVORITES_LIMIT, 1000);
    state.favorites = Array.from({ length: BULK_FAVORITES_LIMIT - 2 }, (_, i) => channel(`old${i}`));
    const items = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => channel(id));
    assert.equal(countNewFavorites(items), 2);
    assert.equal(state.favorites.length, BULK_FAVORITES_LIMIT - 2);  // Counting changes nothing.
    const result = addFavorites(items);
    assert.deepEqual(result, { added: 2, already: 0, refused: 0, leftOut: 3, failed: false, eqFailed: false });
    assert.equal(state.favorites.length, BULK_FAVORITES_LIMIT);
    assert.deepEqual(state.favorites.slice(0, 2).map((f) => f.id), ['playlist:n1', 'playlist:n2']);
    assert.equal(starAllMessage(result), `Added 2 to Favorites; 3 left out (Favorites is limited to ${BULK_FAVORITES_LIMIT}).`);
    // Single stars are not limited.
    assert.equal(addFavorite(channel('single')), true);
    assert.equal(state.favorites.length, BULK_FAVORITES_LIMIT + 1);
  });
});

test('a refused save leaves storage, memory and the equalizer as they were', () => {
  withStorage(({ storage, values, state, events }) => {
    addFavorite(channel('a'));
    const saved = new Map(values);
    const before = events();
    storage.failFavorites = true;
    const result = addFavorites([channel('b'), channel('c')]);
    assert.equal(result.failed, true);
    assert.equal(result.added, 0);
    assert.deepEqual(values, saved);
    assert.deepEqual(state.favorites.map((f) => f.id), ['playlist:a']);
    assert.equal(events(), before);
    assert.equal(starAllMessage(result), 'Favorites could not be saved. Nothing was added.');
  });
});

test('the result is reported in plain words', () => {
  const r = (extra) => ({ added: 0, already: 0, refused: 0, leftOut: 0, failed: false, ...extra });
  assert.equal(starAllMessage(r({ added: 12 })), 'Added 12 to Favorites.');
  assert.equal(starAllMessage(r({ added: 12, already: 3 })), 'Added 12 to Favorites; 3 were already there.');
  assert.equal(starAllMessage(r({ added: 1, already: 1 })), 'Added 1 to Favorites; 1 was already there.');
  assert.equal(starAllMessage(r({ already: 15 })), 'All 15 are already in Favorites.');
  assert.equal(starAllMessage(r({ already: 1 })), 'It is already in Favorites.');
  assert.equal(starAllMessage(r({})), 'No channels are listed to star.');
  assert.equal(starAllMessage(r({ added: 2, refused: 1 })), 'Added 2 to Favorites; 1 could not be added.');
  // Nothing added because Favorites is full: lead with the reason.
  assert.equal(starAllMessage(r({ leftOut: 200 })), `Favorites is full (limited to ${BULK_FAVORITES_LIMIT}); 200 not added.`);
  assert.equal(starAllMessage(r({ leftOut: 200, already: 300 })), `Favorites is full (limited to ${BULK_FAVORITES_LIMIT}); 200 not added, 300 were already there.`);
});

test('Star all covers every channel listed, not just the rendered cards, and asks first above the threshold', async () => {
  const news = Array.from({ length: 40 }, (_, i) => channel(`news${i}`, { title: `News ${i}` }));
  const radio = channel('news-radio', { title: 'News radio', type: 'radio', stream_kind: 'audio' });
  const audio = channel('news-audio', { title: 'News audio', type: 'audio', stream_kind: 'audio' });
  const music = channel('music', { title: 'Music' });
  const other = channel('other-list', { title: 'News elsewhere' });
  await loadPlaylists(async () => ({ playlists: [
    { id: 'list-a', name: 'a.m3u', items: [...news, radio, audio, music], skipped: 0, duplicates: 0 },
    { id: 'list-b', name: 'b.m3u', items: [other], skipped: 0, duplicates: 0 },
  ] }));
  const before = { source: view.activeSource, playlistId: view.playlistId, filters: view.personalFilters.playlists };
  try {
    view.activeSource = 'playlists';
    view.playlistId = 'list-a';
    view.personalFilters.playlists = { query: 'news', type: ['radio', 'tv'] };
    const listed = [...news, radio];
    const selection = libraryExportSelection();
    assert.equal(selection.format, 'm3u8');
    assert.equal(selection.collection, 'a.m3u - Radio');
    assert.equal(selection.type, 'TV');
    assert.deepEqual(selection.stations.map(({ name, group }) => [name, group]), listed.map(({ title }) => [title, 'a.m3u']));
    await exportPlaylist(selection, async (url, options) => {
      assert.equal(url, '/api/v1/playlists/export');
      assert.deepEqual(options, { method: 'POST', body: selection });
    });
    withStorage(({ state }) => {
      const asked = [];
      const cancelled = starAllListed({ confirmImpl: (text) => { asked.push(text); return false; } });
      assert.equal(STAR_ALL_CONFIRM_ABOVE, 25);
      assert.deepEqual(asked, ['Add 41 channels to Favorites? There is no undo for all of them at once.']);
      assert.equal(cancelled.cancelled, true);
      assert.equal(state.favorites.length, 0);

      const done = starAllListed({ confirmImpl: () => true });
      assert.equal(done.message, 'Added 41 to Favorites.');
      // Only the chosen playlist, types and search, in the listed order.
      assert.deepEqual(state.favorites.map((f) => f.id), listed.map((item) => item.id));

      // Few enough new channels: no question asked.
      view.playlistId = '';
      view.personalFilters.playlists = { query: 'news', type: ['radio', 'tv', 'audio', 'video'] };
      assert.equal(libraryExportSelection().type, 'All');
      const quiet = starAllListed({ confirmImpl: () => assert.fail('must not ask') });
      assert.equal(quiet.message, 'Added 2 to Favorites; 41 were already there.');
      assert.deepEqual(state.favorites.slice(0, 2).map((f) => f.id), [audio.id, other.id]);
    });
  } finally {
    view.activeSource = before.source;
    view.playlistId = before.playlistId;
    view.personalFilters.playlists = before.filters;
  }
});

test('Favorites export uses the selected category, search, type, name and effective addresses', () => {
  const previous = { source: view.activeSource, filters: view.personalFilters.favorites };
  try {
    view.activeSource = 'favorites';
    view.personalFilters.favorites = { query: 'renamed', type: 'tv', category: 'news' };
    withStorage(({ state, values }) => {
      const station = channel('one', { _extra: { artworkUrl: 'https://cdn.example.org/tv.png' } });
      const wrongCategory = channel('two', { title: 'Renamed elsewhere' });
      const wrongType = channel('three', { type: 'radio', title: 'Renamed radio' });
      const wrongSearch = channel('four');
      const hidden = channel('five', { title: 'Renamed hidden', content_rating: 'explicit' });
      state.favorites = [station, wrongCategory, wrongType, wrongSearch, hidden];
      values.set(FAVORITE_NAMES_KEY, JSON.stringify({ version: 1, names: { [station.id]: 'Renamed TV' } }));
      values.set(STORAGE_KEYS.favoriteGroups, JSON.stringify({
        version: 1, groups: [{ id: 'news', name: 'News' }],
        assign: Object.fromEntries([station, wrongType, wrongSearch, hidden].map(({ id }) => [id, 'news'])),
      }));
      const main = 'https://streams.example.org/new.m3u8';
      const backups = ['https://streams.example.org/backup.m3u8'];
      values.set(STATION_STREAMS_KEY, JSON.stringify({ version: 1, stations: { [station.id]: { main, backups } } }));
      const selection = libraryExportSelection('json');
      assert.deepEqual([selection.format, selection.collection, selection.type], ['json', 'Favorites - News', 'TV']);
      assert.deepEqual(selection.stations.map(({ name, url, logo, group, backups }) => ({ name, url, logo, group, backups })), [
        { name: 'Renamed TV', url: main, logo: 'https://cdn.example.org/tv.png', group: 'News', backups },
      ]);
      view.activeSource = 'all';
      assert.equal(libraryExportSelection(), null);
    });
  } finally {
    view.activeSource = previous.source;
    view.personalFilters.favorites = previous.filters;
  }
});

test('Favorites export uses only stream addresses already available', () => {
  const previous = { source: view.activeSource, filters: view.personalFilters.favorites };
  try {
    view.activeSource = 'favorites';
    view.personalFilters.favorites = { query: '', type: '', category: '' };
    withStorage(({ state }) => {
      const book = { type: 'audio', source: 'librivox', stream_url: '', download_url: 'https://books.example/audio.ZIP?get=1' };
      const archive = { type: 'audio', source: 'internet-archive', stream_url: '', download_url: '' };
      const clip = { type: 'audio', stream_url: '', download_url: 'https://books.example/audio.mp3?get=1' };
      state.favorites = [
        channel('book', book),
        channel('archive', archive),
        channel('clip', clip),
        channel('played', { ...book, stream_url: 'https://books.example/chapter.mp3', stream_kind: 'audio' }),
      ];
      const stations = libraryExportSelection().stations;
      assert.deepEqual(stations.map(({ url }) => url), [
        '', '', clip.download_url, 'https://books.example/chapter.mp3',
      ]);
      assert.equal(stations[2].kind, 'audio');
    });
  } finally {
    view.activeSource = previous.source;
    view.personalFilters.favorites = previous.filters;
  }
});

class Element extends FakeElement {
  append(...children) { children.forEach((child) => this.appendChild(child)); }
}

class Host extends Element {
  set innerHTML(_value) { this.children = []; }
  querySelector(selector) {
    return selector === '.empty-state' ? this.children.find((node) => node.className === 'empty-state') ?? null : null;
  }
}

test('an empty My Playlists or Favorites shows its own message, even after an empty All Sources', () => {
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const before = {
    source: view.activeSource, playlistId: view.playlistId, query: view.query, items: view.items,
    personalFilters: { ...view.personalFilters },
  };
  const state = getState();
  const previousFavorites = state.favorites;
  try {
    globalThis.document = { createElement: (tag) => new Element('', tag), createDocumentFragment: () => new Element('', 'fragment') };
    ui.resultsHost = new Host('', 'div');
    ui.windowBack = null;
    ui.favoritesExport = new Element('', 'button');
    ui.playlistExport = new Element('', 'button');
    state.favorites = [];
    const shown = () => ui.resultsHost.children.map((node) => node.children[1].textContent);
    view.activeSource = 'all';
    view.query = '';
    view.items = [];
    renderResults();
    assert.deepEqual(shown(), ['Type a search above, or browse a single source on the left.']);
    view.activeSource = 'playlists';
    view.playlistId = 'no-such-list';
    view.personalFilters.playlists = { query: '', type: [] };
    renderResults();
    assert.deepEqual(shown(), ['Import a playlist above, or clear your filters.']);
    assert.equal(ui.playlistExport.disabled, true);
    assert.equal(ui.playlistExport.title, 'No items match this view.');
    view.personalFilters.playlists.type = ['radio', 'tv', 'video'];
    renderResults();
    assert.deepEqual(shown(), ['No radio, TV, or video channels match. Import a playlist above, or clear your filters.']);
    view.activeSource = 'favorites';
    view.personalFilters.favorites = { query: '', type: [], category: '' };
    renderResults();
    assert.deepEqual(shown(), ['Star items to save them here, or clear your filters.']);
    assert.equal(ui.favoritesExport.disabled, true);
    view.personalFilters.favorites.type = ['radio', 'audio'];
    renderResults();
    assert.deepEqual(shown(), ['No radio or audio favorites match. Star items to save them here, or clear your filters.']);
    // The same message is not rebuilt on every render.
    const node = ui.resultsHost.children[0];
    renderResults();
    assert.equal(ui.resultsHost.children[0], node);
  } finally {
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    state.favorites = previousFavorites;
    view.activeSource = before.source;
    view.playlistId = before.playlistId;
    view.query = before.query;
    view.items = before.items;
    Object.assign(view.personalFilters, before.personalFilters);
  }
});

test('the one-pass equalizer update gives the same entries as adding one at a time', () => {
  let start = setScopedEq(freshEqState(), '', false, { preamp: -3, bands: [1, 2, 3], presetId: 'custom' });
  start = addFavoriteEq(start, 'playlist:old', { preamp: 4, bands: [5], presetId: 'mine' });
  const ids = ['playlist:a', 'playlist:b', '__proto__', 'playlist:c'];
  let looped = start;
  for (const id of ids) looped = addFavoriteEq(looped, id, getEffectiveEq(looped, id, false));
  const bulk = addFavoritesEq(start, ids);
  assert.deepEqual(normalizeEqState(bulk), normalizeEqState(looped));
  assert.deepEqual(JSON.stringify(normalizeEqState(bulk)), JSON.stringify(normalizeEqState(looped)));
  assert.equal(Object.getPrototypeOf(bulk.favorites), Object.prototype);
  assert.deepEqual(bulk.favorites['playlist:old'].bands.slice(0, 1), [5]);  // Existing entries untouched.
  // The input state is not changed.
  assert.equal(Object.keys(start.favorites).length, 1);
});

test('bulk add of 1,000 channels stays quick with many equalizer entries already saved', () => {
  withStorage(({ values }) => {
    const seeded = { ...freshEqState(), favorites: Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`playlist:eq${i}`, freshEqState().global])) };
    values.set(EQ_STORAGE_KEY, JSON.stringify(seeded));
    const started = performance.now();
    const result = addFavorites(Array.from({ length: 1000 }, (_, i) => channel(`n${i}`)));
    const elapsed = performance.now() - started;
    assert.equal(result.added, 1000);
    assert.equal(values.get(EQ_STORAGE_KEY), JSON.stringify(seeded));
    assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  });
});

test('identity uses the stored id: non-string ids are refused, repeats are counted once', () => {
  withStorage(({ state }) => {
    const numeric = { ...channel('x'), id: 42 };
    assert.deepEqual(addFavorites([numeric, numeric, { ...channel('y'), id: ['a'] }]),
      { added: 0, already: 0, refused: 3, leftOut: 0, failed: false });
    assert.equal(state.favorites.length, 0);
    // With no room left, a channel listed twice is one left out and one repeat.
    state.favorites = Array.from({ length: BULK_FAVORITES_LIMIT }, (_, i) => channel(`old${i}`));
    assert.deepEqual(addFavorites([channel('a'), channel('a'), channel('b')]),
      { added: 0, already: 1, refused: 0, leftOut: 2, failed: false });
  });
});

test('favorites saved without their equalizer entries are reported', () => {
  withStorage(({ storage, values, state }) => {
    storage.failEq = true;
    const result = addFavorites([channel('a', { type: 'audio' }), channel('b', { type: 'audio' })]);
    assert.equal(result.added, 2);
    assert.equal(result.eqFailed, true);
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEYS.favorites)).map((f) => f.id), state.favorites.map((f) => f.id));
    assert.equal(starAllMessage(result), 'Added 2 to Favorites. Equalizer settings for the new favorites could not be saved.');
  });
});

test('single star uses the same stored id as the bulk path and never duplicates', () => {
  withStorage(({ state, writes, events }) => {
    const before = events();
    // A non-string id would be stored as '' and re-added on every star.
    for (const bad of [{ ...channel('x'), id: 42 }, { ...channel('y'), id: ['a'] }, { ...channel('z'), id: '' }, null, {}]) {
      assert.equal(addFavorite(bad), false);
      assert.equal(addFavorite(bad), false);
    }
    assert.equal(state.favorites.length, 0);
    assert.equal(writes.size, 0);
    assert.equal(events(), before);
    assert.equal(isFavorite(42), false);
    assert.equal(isFavorite(''), false);

    assert.equal(addFavorite(channel('a')), true);
    assert.equal(addFavorite(channel('a')), undefined, 'already saved: no-op');
    assert.deepEqual(state.favorites.map((f) => f.id), ['playlist:a']);
    assert.equal(isFavorite('playlist:a'), true);
    // The single and bulk paths agree on what is already saved.
    assert.deepEqual(addFavorites([channel('a'), { ...channel('x'), id: 42 }]),
      { added: 0, already: 1, refused: 1, leftOut: 0, failed: false });
    assert.equal(removeFavorite('playlist:a'), true);
    assert.equal(isFavorite('playlist:a'), false);
    assert.equal(state.favorites.length, 0);
  });
});
