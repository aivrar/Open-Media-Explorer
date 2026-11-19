/**
 * Issue 6 and discussion 8, reports on v0.1.10: favorites that are not on the
 * dial, station pictures for names Windows cannot use, pictures that are not
 * used, "See provider terms" on own channels, "Move to bottom", removing all
 * favorites and a playlist, and the playlists read that failed once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  STATION_IMAGES_NAME_RULE, STATION_IMAGE_NO_MATCH_TEXT, applyStationImageList, bindStationImageControls,
  setStationImageTitleSource, stationImageProblems, stationImageSourceFor,
} from '../src/lib/station-images.js';
import { shownLicense } from '../src/lib/item-model.js';
import {
  STORAGE_KEYS, getState, moveFavorite, normalizeSettings, removeAllFavorites, subscribe,
} from '../src/lib/state.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { favoriteStations, otherBandFavoritesText } from '../src/modes/tuner.js';
import {
  ADD_AS_CHOICES, ensurePlaylistsLoaded, followTypeChanges, importResultMessage, playlistSnapshot, removeAllFavoritesAsked,
} from '../src/modes/library/personal-controls.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { getPlaylistItems, importPlaylistFile, loadPlaylists, playlistsLoaded } from '../src/lib/playlists.js';
import { moveFavoritesToNewIds, planTypeMoves, typeMoveMessage } from '../src/lib/favorite-migration.js';
import { createFavoriteGroup, favoriteGroupOf } from '../src/lib/favorite-groups.js';
import { EQ_STORAGE_KEY, loadEqState } from '../src/lib/eq-store.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const id = (n) => String(n).repeat(32).slice(0, 32);
const picture = (key, n, file = '') => ({ key, id: id(n), v: 'abc123', ...(file ? { file } : {}) });
const source = (n) => `station-image:${id(n)}:abc123`;

/** Fake localStorage and a clean favorites list for one test. */
function withFavorites(list, fn) {
  const state = getState();
  const previous = { favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage };
  const values = new Map();
  const storage = {
    fail: false,
    getItem: (key) => values.get(key) ?? null,
    // A test can refuse any write (throw from onSet).
    onSet: null,
    setItem(key, value) {
      storage.onSet?.(key, value);
      if (key === STORAGE_KEYS.favorites && storage.fail) throw new Error('Quota exceeded');
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  let events = 0;
  const off = subscribe('favorites-change', () => { events += 1; });
  globalThis.localStorage = storage;
  state.favorites = list.map((item) => ({ ...item }));
  state.settings = normalizeSettings({});
  const restore = () => {
    off();
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    clearPersistenceFailure('favorites');
  };
  let waiting = false;
  try {
    const result = fn({ state, storage, values, events: () => events });
    // An async test keeps the fake storage until it has finished.
    if (typeof result?.then === 'function') {
      waiting = true;
      return result.finally(restore);
    }
    return result;
  } finally {
    if (!waiting) restore();
  }
}

const station = (n, extra = {}) => ({
  id: `playlist:${String(n).padStart(4, '0')}`, source: 'playlist', type: 'radio',
  title: n % 10 === 0 ? `Nu-Metal/Alternative ${n}` : `Dream Pop ${n}`, ...extra,
});

/* ============ A: favorites on the dial ============ */

test('A: all 60 starred stations with near-identical names are on the dial, in order', () => {
  const favorites = Array.from({ length: 60 }, (_, index) => station(index + 1));
  const dial = favoriteStations(favorites, { band: 'radio', settings: normalizeSettings({}) });
  assert.equal(dial.length, 60);
  assert.deepEqual(dial.map((item) => item.id), favorites.map((item) => item.id));
});

test('A: a starred station saved as TV is named in the status line, not silently missing', () => {
  // A playlist imported with "Add as: TV": addresses without .mp3 etc. (Live365)
  // became TV channels, so they were only on the TV dial.
  const favorites = [
    station(1), station(2, { title: 'Live365 - Alt Radio', type: 'tv' }), station(3, { type: 'tv' }), station(4),
  ];
  const settings = normalizeSettings({});
  assert.equal(favoriteStations(favorites, { band: 'radio', settings }).length, 2);
  assert.equal(otherBandFavoritesText(favorites, { band: 'radio', settings }),
    ' \u00B7 2 more saved as TV (switch to TV to see them)');
  assert.equal(otherBandFavoritesText(favorites, { band: 'tv', settings }),
    ' \u00B7 2 more saved as radio (switch to Radio to see them)');
  assert.equal(otherBandFavoritesText([station(1)], { band: 'radio', settings }), '');
  assert.equal(otherBandFavoritesText([station(1, { type: 'tv' })], { band: 'radio', settings }),
    ' \u00B7 1 more saved as TV (switch to TV to see it)');
});

test('A: the import result says how many channels took the "Add as" type', () => {
  const data = (defaulted) => ({ replaced: false, playlist: { items: new Array(42), skipped: 0, duplicates: 1, defaulted } });
  assert.equal(importResultMessage(data(0), 'tv'), 'Imported 42 channels; 0 unsupported entries skipped; 1 duplicate removed.');
  assert.equal(importResultMessage(data(12), 'tv'), 'Imported 42 channels; 0 unsupported entries skipped; 1 duplicate removed.'
    + ' 12 channels do not say in the file whether they are radio or TV, so they were added as TV.'
    + ' If they are radio stations, choose Add as Radio and import the file again.');
  assert.equal(importResultMessage({ ...data(1), replaced: true }, 'radio'), 'Updated 42 channels; 0 unsupported entries skipped; 1 duplicate removed.'
    + ' 1 channel does not say in the file whether it is radio or TV, so it was added as radio.'
    + ' If it is a TV channel, choose Add as TV and import the file again.');
});

test('A: counts of one read as one, and private addresses are named as the reason', () => {
  const message = (playlist) => importResultMessage({ replaced: false, playlist: { duplicates: 0, skipped: 0, ...playlist } }, 'tv');
  assert.equal(message({ items: [1], skipped: 1, duplicates: 1 }),
    'Imported 1 channel; 1 unsupported entry skipped; 1 duplicate removed.');
  assert.equal(message({ items: [1, 2], skipped: 2, duplicates: 2 }),
    'Imported 2 channels; 2 unsupported entries skipped; 2 duplicates removed.');
  // Entries for this computer or a private network: their own sentence, not "unsupported".
  assert.equal(message({ items: [1, 2], skipped: 1, private: 1 }), 'Imported 2 channels; 0 unsupported entries skipped; '
    + '0 duplicates removed. 1 entry was skipped because it points at this computer or a private network address.');
  assert.equal(message({ items: [1, 2], skipped: 4, private: 3 }), 'Imported 2 channels; 1 unsupported entry skipped; '
    + '0 duplicates removed. 3 entries were skipped because they point at this computer or a private network address.');
  // A count the backend did not send, or a wrong one, never makes a negative number.
  assert.equal(message({ items: [1], skipped: 1, private: 5 }), 'Imported 1 channel; 0 unsupported entries skipped; '
    + '0 duplicates removed. 1 entry was skipped because it points at this computer or a private network address.');
});

test('A: a failed first read of the playlists is tried again when My Playlists opens', async () => {
  const oldUi = { ...ui };
  try {
    ui.root = new FakeElement('root');
    ui.playlistMessage = new FakeElement('message', 'span');
    assert.equal(playlistsLoaded(), false);
    let calls = 0;
    const answer = { playlists: [{ id: 'p1', name: 'Mine.m3u', items: [station(1), station(2)], skipped: 0, duplicates: 0 }] };
    const request = async () => {
      calls += 1;
      if (calls === 1) throw new Error('Session token is missing or invalid.');
      return answer;
    };
    const load = () => loadPlaylists(request);
    assert.equal(await ensurePlaylistsLoaded(load), false);
    assert.equal(ui.playlistMessage.textContent,
      'Your playlists could not be loaded: Session token is missing or invalid. Open My Playlists again to try again.');
    assert.equal(getPlaylistItems().length, 0);
    assert.equal(await ensurePlaylistsLoaded(load), true);
    assert.equal(ui.playlistMessage.textContent, '');
    assert.equal(getPlaylistItems().length, 2);
    // Once read, nothing is asked again.
    assert.equal(await ensurePlaylistsLoaded(load), true);
    assert.equal(calls, 2);
    // Opening My Playlists asks for it (sidebar.js), the Library mount too (index.js).
    assert.match(await read('src/modes/library/sidebar.js'), /if \(sourceId === 'playlists'\) void ensurePlaylistsLoaded\(\);/);
    assert.match(await read('src/modes/library/index.js'), /void ensurePlaylistsLoaded\(\);/);
  } finally {
    Object.assign(ui, oldUi);
  }
});

/* ============ B: picture names Windows does not allow ============ */

/** Pictures by normalized name (the backend's key) and the favorite and
 *  playlist station names pictures are shared out between. */
function pictures(keys, titles = []) {
  // The same array each time, as the favorites and playlist lists are.
  const stations = [titles.map((title) => ({ title }))];
  setStationImageTitleSource(() => stations);
  const ids = (at) => (at + 1).toString(16).padStart(32, '0');
  applyStationImageList({ images: keys.map((key, at) => ({ key, id: ids(at), v: 'abc123', file: `${key}.png` })) });
  const bySource = new Map(keys.map((key, at) => [`station-image:${ids(at)}:abc123`, key]));
  return (title) => bySource.get(stationImageSourceFor({ title })) || '';
}

test('B: "Nu-Metal/Alternative" matches a file with -, _, a space or nothing for the slash', () => {
  for (const key of ['nu-metal-alternative', 'nu-metal_alternative', 'nu-metal alternative', 'nu-metalalternative']) {
    const pick = pictures([key]);
    assert.equal(pick('Nu-Metal/Alternative'), key);
    assert.equal(pick('NU-METAL/ALTERNATIVE'), key, 'capital letters do not matter');
  }
  // A station without such characters uses only its exact name, so a dash is
  // never read as a slash the other way round.
  assert.equal(pictures(['nu-metal-alternative'])('Nu-Metal Alternative'), '');
  // Only the forbidden character changes: the rest must be as written.
  const pick = pictures(['rock - pop', 'rock--pop']);
  assert.equal(pick('Rock/Pop'), '');
  assert.equal(pick('Rock / Pop'), 'rock - pop');
});

test('B: when several pictures fit, - wins, then _, then a space, then a left-out character', () => {
  assert.equal(pictures(['rockpop', 'rock pop', 'rock_pop', 'rock-pop'])('Rock/Pop'), 'rock-pop');
  assert.equal(pictures(['rockpop', 'rock pop', 'rock_pop'])('Rock/Pop'), 'rock_pop');
  assert.equal(pictures(['rockpop', 'rock pop'])('Rock/Pop'), 'rock pop');
  // A picture that fits only by leaving the character out still works alone
  // (the only rule before this version).
  assert.equal(pictures(['rockpop'])('Rock/Pop'), 'rockpop');
});

test('B: a picture named exactly like a station is never given to another station', () => {
  // "Rock-Pop" is a station of its own: Rock-Pop.png is its picture.
  let pick = pictures(['rock-pop'], ['Rock-Pop', 'Rock/Pop']);
  assert.equal(pick('Rock-Pop'), 'rock-pop');
  assert.equal(pick('Rock/Pop'), '');
  pick = pictures(['rock-pop', 'rock_pop'], ['Rock-Pop', 'Rock/Pop']);
  assert.equal(pick('Rock/Pop'), 'rock_pop');
  // RockPop.png belongs to the station RockPop, not to Rock/Pop.
  pick = pictures(['rockpop', 'rock pop'], ['RockPop', 'Rock/Pop']);
  assert.equal(pick('RockPop'), 'rockpop');
  assert.equal(pick('Rock/Pop'), 'rock pop');
  // A catalog station (on no list) follows the same rule.
  assert.equal(pictures(['rock-pop'], ['Rock-Pop'])('Rock\\Pop'), '');
});

test('B: one picture that fits two stations goes to one of them, the same every time', () => {
  for (const titles of [['Rock/Pop', 'Rock:Pop'], ['Rock:Pop', 'Rock/Pop']]) {
    const pick = pictures(['rock-pop'], titles);
    assert.equal(pick('Rock/Pop'), 'rock-pop');
    assert.equal(pick('Rock:Pop'), '');
  }
  // The station that lost its first choice takes its next one.
  const pick = pictures(['rock-pop', 'rock pop'], ['Rock:Pop', 'Rock/Pop']);
  assert.equal(pick('Rock/Pop'), 'rock-pop');
  assert.equal(pick('Rock:Pop'), 'rock pop');
});

test('B: any number of forbidden characters, trailing dots and reserved names', () => {
  const many = 'a/b\\c:d*e?f"g<h>i|j';
  assert.equal(pictures(['a-b_c d-efg_h i-j'])(many), 'a-b_c d-efg_h i-j');
  assert.equal(pictures(['abcdefghij'])(many), 'abcdefghij');
  assert.equal(pictures(['a-b_c d-efg_h i-'])(many), '');
  // Windows drops trailing dots and spaces from file names: so does the match.
  assert.equal(pictures(['what-', 'what'])('What?'), 'what-');
  assert.equal(pictures(['what'])('What?'), 'what');
  assert.equal(pictures(['radio x'])('Radio X./'), 'radio x');
  // CON, AUX, COM1... cannot be file names; with _ or - after them they can.
  assert.equal(pictures(['aux_'])('AUX'), 'aux_');
  assert.equal(pictures(['com1-'])('Com1'), 'com1-');
  assert.equal(pictures(['aux_ radio'])('Aux Radio'), '');
  // Nothing here is a path: names are only looked up in the backend's list.
  assert.equal(pictures(['windows-system32'])('..\\..\\Windows/System32'), '');
  assert.equal(pictures(['x'])('x'.repeat(1025)), '');
  assert.equal(pictures(['x'])(null), '');
});

test('B: matching stays quick with many stations and many forbidden characters', () => {
  const titles = Array.from({ length: 1000 }, (_, at) => `Station ${at}/Rock:Pop*Live?Now`);
  const keys = Array.from({ length: 1000 }, (_, at) => `station ${at}-rock_pop live-now`);
  const started = performance.now();
  const pick = pictures(keys, titles);
  for (const title of titles) pick(title);
  const elapsed = performance.now() - started;
  assert.equal(pick('Station 999/Rock:Pop*Live?Now'), 'station 999-rock_pop live-now');
  assert.ok(elapsed < 300, `took ${elapsed.toFixed(0)} ms`);
  // 6,000 names on no list (catalog stations): the oldest are forgotten one at
  // a time and asked again correctly.
  for (let at = 0; at < 6000; at += 1) pick(`Other ${at}/x`);
  assert.equal(pick('Station 0/Rock:Pop*Live?Now'), 'station 0-rock_pop live-now');
  assert.equal(pictures(['other 1-x'])('Other 1/x'), 'other 1-x');
  setStationImageTitleSource(() => []);
  applyStationImageList({ images: [] });
});

test('B: the rule is shown in Settings > Station images as plain text', async () => {
  const rule = new FakeElement('rule', 'span');
  bindStationImageControls({
    path: new FakeElement('path', 'code'), status: new FakeElement('status', 'span'),
    openButton: new FakeElement('open', 'button'), refreshButton: new FakeElement('refresh', 'button'),
    rule, load: async () => ({}), openFolder: async () => ({}),
  });
  assert.equal(rule.textContent, STATION_IMAGES_NAME_RULE);
  assert.equal(STATION_IMAGES_NAME_RULE, 'Capital letters do not matter. Windows does not allow '
    + '\\ / : * ? " < > | in file names: write each of them as - or _ or a space, or leave it out. '
    + 'For example Nu-Metal-Alternative.png for the station Nu-Metal/Alternative. '
    + 'A name Windows keeps for itself, such as CON or AUX, takes a _ at the end: AUX_.png.');
  const settings = await read('src/lib/settings.js');
  assert.match(settings, /data-station-images-rule><\/span>/);
  assert.match(settings, /rule: root\.querySelector\('\[data-station-images-rule\]'\)/);
});

/* ============ C: pictures that are not used ============ */

class ListElement extends FakeElement {
  replaceChildren(...children) { this.children = [...children]; }
}
const createElement = (tag) => new ListElement('', tag);
const lineTexts = (problems) => problems.children[1]?.children.map((row) => row.textContent) || [];

function rejectedList(count) {
  return Array.from({ length: count }, (_, index) => ({
    file: `Big ${String(index).padStart(2, '0')}.png`, reason: 'too_large', text: 'too large (the limit is 2 MB)',
  }));
}

test('C: Settings lists the rejected pictures from the last scan, with no new scan', async () => {
  setStationImageTitleSource(() => []);
  applyStationImageList({
    folder: 'D:\\Data\\station-images', exists: true, version: 'v',
    images: [picture('radio paradise', 'a', 'Radio Paradise.png')],
    rejected: [
      { file: 'Huge.png', reason: 'too_large', text: 'too large (the limit is 2 MB)' },
      { file: 'Logo.svg', reason: 'svg', text: 'SVG is not allowed' },
      { file: 'Text.jpg', reason: 'not_image', text: 'not a valid picture' },
    ],
    rejected_more: 0,
  });
  const problems = new ListElement('problems', 'div');
  problems.hidden = true;
  let loads = 0;
  bindStationImageControls({
    path: new FakeElement('path', 'code'), status: new FakeElement('status', 'span'),
    openButton: new FakeElement('open', 'button'), refreshButton: new FakeElement('refresh', 'button'),
    problems, createElement, load: async () => { loads += 1; return {}; }, openFolder: async () => ({}),
  });
  assert.equal(loads, 0, 'opening Settings does not scan again');
  assert.equal(problems.hidden, false);
  assert.equal(problems.children[0].textContent, 'Pictures to check:');
  assert.deepEqual(lineTexts(problems), [
    'Huge.png: too large (the limit is 2 MB)', 'Logo.svg: SVG is not allowed', 'Text.jpg: not a valid picture',
  ]);
});

test('C: the list is capped and says how many more; a picture no station is named like is noted', () => {
  applyStationImageList({
    images: [picture('radio paradise', 'a', 'Radio Paradise.png'), picture('nu-metal-alternative', 'b', 'Nu-Metal-Alternative.png'),
      picture('old station', 'c', 'Old Station.png')],
    rejected: rejectedList(20), rejected_more: 7,
  });
  const capped = stationImageProblems();
  assert.equal(capped.lines.length, 10);
  assert.equal(capped.more, 17);
  applyStationImageList({
    images: [picture('radio paradise', 'a', 'Radio Paradise.png'), picture('nu-metal-alternative', 'b', 'Nu-Metal-Alternative.png'),
      picture('old station', 'c', 'Old Station.png')],
    rejected: rejectedList(1),
  });
  // Without the station names (playlists not read yet) nothing is guessed.
  assert.equal(stationImageProblems().lines.length, 1);
  const named = stationImageProblems({ titles: ['Radio Paradise', 'Nu-Metal/Alternative', undefined] });
  assert.deepEqual(named.lines.map((line) => `${line.file}: ${line.text}`), [
    'Big 00.png: too large (the limit is 2 MB)', `Old Station.png: ${STATION_IMAGE_NO_MATCH_TEXT}`,
  ]);
  assert.equal(named.more, 0);
  applyStationImageList({ images: [] });
  assert.deepEqual(stationImageProblems(), { lines: [], more: 0 });
});

test('C: after Refresh the list follows the new scan, and an empty one is hidden', async () => {
  applyStationImageList({ folder: 'D:\\Data\\station-images', images: [] });
  const problems = new ListElement('problems', 'div');
  let answer = { folder: 'D:\\Data\\station-images', exists: true, images: [], found: 0, ignored: 12,
    ignored_reasons: [{ reason: 'too_large', text: 'too large', count: 12 }], rejected: rejectedList(12), rejected_more: 0 };
  const controls = bindStationImageControls({
    path: new FakeElement('path', 'code'), status: new FakeElement('status', 'span'),
    openButton: new FakeElement('open', 'button'), refreshButton: new FakeElement('refresh', 'button'),
    problems, createElement,
    load: async () => { applyStationImageList(answer); return answer; }, openFolder: async () => ({}),
  });
  assert.equal(problems.hidden, true);
  await controls.refresh();
  assert.equal(problems.hidden, false);
  const lines = lineTexts(problems);
  assert.equal(lines.length, 11);
  assert.equal(lines.at(-1), 'and 2 more');
  answer = { ...answer, ignored: 0, ignored_reasons: [], rejected: [] };
  await controls.refresh();
  assert.equal(problems.hidden, true);
  applyStationImageList({ images: [] });
});

/* ============ E: "See provider terms" ============ */

test('E: own playlist channels show no terms note; catalog sources keep theirs', async () => {
  assert.equal(shownLicense({ source: 'playlist', license: 'See provider terms' }), '');
  assert.equal(shownLicense({ source: 'radio-browser', license: 'See source' }), 'See source');
  assert.equal(shownLicense({ source: 'internet-archive', license: 'CC-BY-4.0' }), 'CC-BY-4.0');
  assert.equal(shownLicense({ source: 'wikimedia', license: 'Unknown' }), '');
  assert.equal(shownLicense({ source: 'nasa' }), '');
  assert.match(await read('src/modes/library/render.js'), /const license = shownLicense\(item\);/);
  assert.match(await read('src/modes/library/detail.js'), /if \(shownLicense\(item\)\) meta\.appendChild/);
});

/* ============ F: Move to bottom ============ */

test('F: "Move to bottom" puts a favorite last, and the dial follows the order', () => {
  const list = [station(1), station(2, { type: 'tv' }), station(3), station(4)];
  withFavorites(list, ({ state, events }) => {
    assert.equal(moveFavorite('playlist:0001', 'bottom'), true);
    assert.deepEqual(state.favorites.map((item) => item.id),
      ['playlist:0002', 'playlist:0003', 'playlist:0004', 'playlist:0001']);
    assert.equal(events(), 1);
    // Already last: nothing to do.
    assert.equal(moveFavorite('playlist:0001', 'bottom'), false);
    // With a filter, only a shown favorite below makes the move possible;
    // the moved one still goes to the very end of the stored list.
    assert.equal(moveFavorite('playlist:0004', 'bottom', { visibleIds: ['playlist:0003', 'playlist:0004'] }), false);
    assert.equal(moveFavorite('playlist:0003', 'bottom', { visibleIds: ['playlist:0003', 'playlist:0004'] }), true);
    assert.deepEqual(state.favorites.map((item) => item.id),
      ['playlist:0002', 'playlist:0004', 'playlist:0001', 'playlist:0003']);
    const dial = favoriteStations(state.favorites, { band: 'radio', settings: state.settings });
    assert.deepEqual(dial.map((item) => item.id), ['playlist:0004', 'playlist:0001', 'playlist:0003']);
  });
});

/* ============ G: remove all favorites ============ */

test('G: "Remove all favorites" asks with the count and the backup hint, and nothing goes without a yes', () => {
  const list = Array.from({ length: 42 }, (_, index) => station(index + 1));
  withFavorites(list, ({ state, values, events }) => {
    const asked = [];
    const no = removeAllFavoritesAsked({ confirmImpl: (text) => { asked.push(text); return false; } });
    assert.deepEqual(no, { removed: 0, cancelled: true, message: 'Nothing was removed.' });
    assert.equal(state.favorites.length, 42);
    assert.deepEqual(asked, ['Remove all 42 favorites? This cannot be undone. To keep a copy, first use Back up my data in Settings > Storage.']);
    values.set('worldmedia.eq.v1', JSON.stringify({ favorites: { 'playlist:0001': {}, keep: {} } }));
    const yes = removeAllFavoritesAsked({ confirmImpl: () => true });
    assert.deepEqual(yes, { removed: 42, message: 'All 42 favorites were removed.' });
    assert.deepEqual(state.favorites, []);
    assert.equal(values.get(STORAGE_KEYS.favorites), '[]');
    assert.equal(events(), 1, 'one change event for the whole list');
    assert.deepEqual(removeAllFavoritesAsked({ confirmImpl: () => assert.fail('nothing to ask') }),
      { removed: 0, message: 'There are no favorites to remove.' });
  });
});

test('G: a list that cannot be saved stays as it was, with its equalizer curves', () => {
  withFavorites([station(1), station(2)], ({ state, storage, values }) => {
    const curves = JSON.stringify({ favorites: { 'playlist:0001': { bands: [1] } } });
    values.set(EQ_STORAGE_KEY, curves);
    const eqBefore = JSON.stringify(loadEqState());
    storage.fail = true;
    assert.deepEqual(removeAllFavorites(), { removed: 0, failed: 'nothing' });
    assert.equal(state.favorites.length, 2);
    // The curves were taken out first and put back.
    assert.equal(JSON.stringify(loadEqState()), eqBefore);
    assert.deepEqual(removeAllFavoritesAsked({ confirmImpl: () => true }),
      { removed: 0, message: 'Favorites could not be saved. Nothing was removed.' });
  });
});

test('G: equalizer curves that cannot be removed stop the whole removal', () => {
  withFavorites([station(1)], ({ state, storage, values }) => {
    values.set(EQ_STORAGE_KEY, JSON.stringify({ favorites: { 'playlist:0001': { bands: [1] } } }));
    storage.onSet = (key) => { if (key === EQ_STORAGE_KEY) throw new Error('Quota exceeded'); };
    assert.deepEqual(removeAllFavorites(), { removed: 0, failed: 'nothing' });
    assert.equal(state.favorites.length, 1);
    assert.equal(values.has(STORAGE_KEYS.favorites), false, 'the list was not touched');
    assert.ok(Object.hasOwn(loadEqState().favorites, 'playlist:0001'));
  });
});

test('G: when the curves cannot be put back the user is told plainly', () => {
  withFavorites([station(1)], ({ state, storage, values }) => {
    values.set(EQ_STORAGE_KEY, JSON.stringify({ favorites: { 'playlist:0001': { bands: [1] } } }));
    let eqWrites = 0;
    storage.onSet = (key) => {
      if (key === EQ_STORAGE_KEY && (eqWrites += 1) > 1) throw new Error('Quota exceeded');
    };
    storage.fail = true;
    assert.deepEqual(removeAllFavoritesAsked({ confirmImpl: () => true }), { removed: 0,
      message: 'Favorites could not be saved, so they were kept, but their own equalizer settings were lost; '
        + 'they now use the main equalizer.' });
    assert.equal(state.favorites.length, 1);
  });
});

test('G and H: the playlist and favorites controls say how to remove and change stations', async () => {
  const controls = await read('src/modes/library/personal-controls.js');
  assert.match(controls, /text: 'Remove all favorites'/);
  assert.match(controls, /'Choose the playlist to remove in the list that says All playlists, then press Remove playlist\.'/);
  // "All playlists" with one playlist imported removes that one (after a yes).
  assert.match(controls, /\|\| \(lists\.length === 1 \? lists\[0\] : null\)/);
  assert.match(controls, /globalThis\.confirm\(`Remove the playlist \$\{selected\.name\} with its/);
  assert.match(controls, /ui\.playlistRemove\.disabled = lists\.length === 0;/);
});

/* ============ Review: pictures that fit more than one station ============ */

test('C: Settings says which station a shared picture went to and what else it fits', () => {
  const stations = [['Rock-Pop', 'Rock/Pop', 'Rock:Pop', 'Jazz/Funk'].map((title) => ({ title }))];
  setStationImageTitleSource(() => stations);
  applyStationImageList({ images: [
    picture('rock-pop', 'a', 'Rock-Pop.png'), picture('rock_pop', 'b', 'Rock_Pop.png'),
    picture('jazz-funk', 'c', 'Jazz-Funk.png'), picture('jazz funk', 'd', 'Jazz Funk.png'),
  ] });
  assert.deepEqual(stationImageProblems().lines.map((line) => `${line.file}: ${line.text}`), [
    'Jazz Funk.png: not used: Jazz/Funk uses Jazz-Funk.png',
    'Rock-Pop.png: used for Rock-Pop; also fits Rock/Pop, Rock:Pop',
    'Rock_Pop.png: used for Rock/Pop; also fits Rock:Pop',
  ]);
  setStationImageTitleSource(() => []);
  applyStationImageList({ images: [] });
});

/* ============ Review: Add as Auto, and favorites that follow a new type ============ */

test('A: "Add as" starts on Auto, and the import says what Auto chose and why', async () => {
  assert.deepEqual(ADD_AS_CHOICES, [['auto', 'Auto'], ['tv', 'TV'], ['radio', 'Radio']]);
  const data = (defaulted, auto, type) => ({
    replaced: false, playlist: { items: new Array(42), skipped: 0, duplicates: 0, defaulted, auto, default_type: type },
  });
  const head = 'Imported 42 channels; 0 unsupported entries skipped; 0 duplicates removed.';
  assert.equal(importResultMessage(data(12, 'majority', 'radio'), 'auto'), `${head} 12 channels do not say in the file `
    + 'whether they are radio or TV. Most channels in the file that do say are radio, so these were added as radio too. '
    + 'If that is wrong, choose Add as TV and import the file again.');
  assert.equal(importResultMessage(data(1, 'majority', 'tv'), 'auto'), `${head} 1 channel does not say in the file `
    + 'whether it is radio or TV. Most channels in the file that do say are TV, so it was added as TV too. '
    + 'If that is wrong, choose Add as Radio and import the file again.');
  assert.equal(importResultMessage(data(3, 'fallback', 'tv'), 'auto'), `${head} 3 channels do not say in the file `
    + 'whether they are radio or TV, and the rest of the file does not decide it, so they were added as TV. '
    + 'If they are radio stations, choose Add as Radio and import the file again.');
  const controls = await read('src/modes/library/personal-controls.js');
  assert.match(controls, /selectControl\('Radio or TV, for channels the playlist does not mark\. '/);
});

const channel = (key, type, title = 'Live365 - Alt Radio') => ({
  id: `playlist:${type}-${key}`, source: 'playlist', type, title,
  stream_url: `https://streaming.example.org/${key}`, stream_kind: type === 'radio' ? 'audio' : 'video', delivery: 'live',
});

test('A: a favorite follows its channel from TV to radio, keeping place, category and equalizer', () => {
  const oldItems = [channel('a1', 'tv'), channel('b2', 'tv', 'Dream Pop'), channel('c3', 'radio', 'Already radio')];
  const newItems = [channel('a1', 'radio'), channel('b2', 'radio', 'Dream Pop'), channel('c3', 'radio', 'Already radio')];
  const before = [station(1), oldItems[0], station(2), oldItems[1], oldItems[2]];
  withFavorites(before, ({ state, values, events }) => {
    const rock = createFavoriteGroup('Rock', { assign: 'playlist:tv-a1' });
    assert.equal(rock.ok, true);
    values.set(EQ_STORAGE_KEY, JSON.stringify({ favorites: { 'playlist:tv-a1': { bands: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } }));
    const curve = loadEqState().favorites['playlist:tv-a1'];
    const moves = planTypeMoves(oldItems, newItems, state.favorites);
    assert.deepEqual([...moves.keys()], ['playlist:tv-a1', 'playlist:tv-b2']);
    const result = moveFavoritesToNewIds(moves);
    assert.deepEqual(result, { moved: 2, failed: false });
    assert.deepEqual(state.favorites.map((favorite) => favorite.id),
      ['playlist:0001', 'playlist:radio-a1', 'playlist:0002', 'playlist:radio-b2', 'playlist:radio-c3']);
    assert.equal(state.favorites[1].type, 'radio');
    assert.equal(favoriteGroupOf('playlist:radio-a1'), rock.group.id);
    assert.equal(favoriteGroupOf('playlist:tv-a1'), '');
    assert.deepEqual(loadEqState().favorites['playlist:radio-a1'], curve);
    assert.equal(Object.hasOwn(loadEqState().favorites, 'playlist:tv-a1'), false);
    assert.equal(events(), 1);
    assert.equal(typeMoveMessage(result, moves),
      ' 2 favorites were changed to radio to match; their place, category and equalizer settings were kept.');
    // Now on the Radio dial.
    assert.equal(favoriteStations(state.favorites, { band: 'radio', settings: state.settings }).length, 5);
  });
});

test('A: a channel whose name changed, or that is already a favorite as radio, is left alone', () => {
  const oldItems = [channel('a1', 'tv'), channel('b2', 'tv', 'Dream Pop')];
  const newItems = [channel('a1', 'radio', 'Renamed'), channel('b2', 'radio', 'Dream Pop')];
  withFavorites([oldItems[0], oldItems[1], newItems[1]], ({ state }) => {
    assert.equal(planTypeMoves(oldItems, newItems, state.favorites).size, 0);
  });
});

test('A: if any of the three saves fails, nothing changes', () => {
  const oldItems = [channel('a1', 'tv')];
  const newItems = [channel('a1', 'radio')];
  withFavorites([station(1), oldItems[0]], ({ state, storage, values }) => {
    createFavoriteGroup('Rock', { assign: 'playlist:tv-a1' });
    values.set(EQ_STORAGE_KEY, JSON.stringify({ favorites: { 'playlist:tv-a1': { bands: [3] } } }));
    const saved = new Map(values);
    storage.onSet = (key) => { if (key === STORAGE_KEYS.favoriteGroups) throw new Error('Quota exceeded'); };
    const moves = planTypeMoves(oldItems, newItems, state.favorites);
    assert.deepEqual(moveFavoritesToNewIds(moves), { moved: 0, failed: true });
    assert.deepEqual(state.favorites.map((favorite) => favorite.id), ['playlist:0001', 'playlist:tv-a1']);
    for (const [key, value] of saved) assert.equal(values.get(key), value, key);
    assert.equal(typeMoveMessage({ moved: 0, failed: true }, moves),
      ' 1 favorite could not be changed to its new radio or TV type and still points at the old entry.');
  });
});

test('A: importing the same playlist again as Radio moves its TV favorites (the whole import path)', async () => {
  const file = (name) => new File(['#EXTM3U\nhttps://streaming.example.org/a1\n'], name);
  const answer = (type, replaced) => async () => ({
    replaced, playlist: { id: 'mine', name: 'Mine', items: [channel('a1', type)], skipped: 0, duplicates: 0, defaulted: 1 },
  });
  await loadPlaylists(async () => ({ playlists: [] }));
  await importPlaylistFile(file('Mine.m3u'), 'tv', answer('tv', false));
  await withFavorites([channel('a1', 'tv')], async ({ state }) => {
    const before = playlistSnapshot();
    const data = await importPlaylistFile(file('Mine.m3u'), 'radio', answer('radio', true));
    assert.equal(followTypeChanges(before, data),
      ' 1 favorite was changed to radio to match; its place, category and equalizer settings were kept.');
    assert.deepEqual(state.favorites.map((favorite) => favorite.id), ['playlist:radio-a1']);
    // A first import (nothing replaced) moves nothing.
    assert.equal(followTypeChanges(new Map(), { replaced: false, playlist: { id: 'other' } }), '');
  });
});
