import test from 'node:test';
import assert from 'node:assert/strict';
import { resetControlSession } from '../src/lib/capture-client.js';
import { createComputerLibrary } from '../src/lib/computer-library.js';
import { computerItemForView, createComputerSearch } from '../src/modes/library/computer.js';
import { makeComputerItem } from '../src/lib/computer-play.js';
import { saveEqState, loadEqState, setStationEqPreset } from '../src/lib/eq-store.js';
import { assignFavoriteToGroup, createFavoriteGroup } from '../src/lib/favorite-groups.js';
import { moveFavoritesToNewIds } from '../src/lib/favorite-migration.js';
import { renameFavorite } from '../src/lib/favorite-rename.js';
import { getPersistenceWarnings, clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { captureProfileStorage, saveProfileHandoff } from '../src/lib/profile-transfer.js';
import {
  addFavorite, addFavorites, getState, initState, isFavorite, loadComputerStars,
  moveFavorite, removeAllFavorites, removeFavorite, removeFavorites, STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { libraryExportSelection } from '../src/modes/library/personal-controls.js';
import { view } from '../src/modes/library/state.js';
import { fakeComputerStars } from './helpers/fake-computer-stars.js';

const id = (number) => number.toString(16).padStart(24, '0');
const item = (number, title = `Song ${number}`) => makeComputerItem({
  id: id(number), kind: 'audio', title, artist: 'Artist', album: 'Album',
  ext: 'flac', acodec: 'flac', duration: 240, chapters: [{ start: 0, title: 'Intro' }],
});
const record = (number, seq = number) => ({
  id: id(number), t: 1234, seq, snap: { kind: 'video', title: `Video ${number}`, format: 'MKV' },
});
const radio = { id: 'radio:favorite', type: 'radio', source: 'radio', title: 'Station', stream_url: 'https://example.com/live' };
const idle = () => new Promise(setImmediate);

function fixture(t, records) {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const server = fakeComputerStars(records);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previous = { ...getState() };
  t.mock.method(globalThis, 'fetch', (...args) => server.fetch(...args));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  resetControlSession();
  t.after(async () => {
    await idle();
    Object.assign(getState(), previous);
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
    clearPersistenceFailure('computer-stars');
    resetControlSession();
  });
  return { data, server, storage };
}

test('local stars load, batch by 2,000, roll back failed writes and stay out of portable saves', async (t) => {
  const { server, data, storage } = fixture(t, [record(1, 30), record(2, 10)]);
  storage.setItem(STORAGE_KEYS.favorites, JSON.stringify([radio]));
  await initState();
  assert.equal(await loadComputerStars(), true);
  assert.equal(await loadComputerStars(), true);
  assert.deepEqual(server.requests, [{ method: 'GET' }]);
  assert.deepEqual(getState().favorites.map(({ id }) => id), [radio.id, 'computer:' + id(1), 'computer:' + id(2)]);
  assert.equal(getState().favorites[1].type, 'video');

  const changed = t.mock.fn();
  const attempts = [];
  const batch = Array.from({ length: 2_500 }, (_, index) => item(index + 100, 'Song ' + (index + 100)));
  t.after(subscribe('favorites-change', changed));
  const stopReentry = subscribe('favorites-change', () => {
    attempts.push(removeFavorites([batch[0].id]));
  });
  t.after(stopReentry);
  assert.equal(addFavorites(batch, { allOrNothing: true }).added, 2_500);
  stopReentry();
  assert.deepEqual(attempts, [false]);
  assert.equal(isFavorite(batch[0].id), true);
  assert.equal(isFavorite(batch.at(-1).id), true);
  const order = () => getState().favorites.slice(1, 2_501).map(({ id }) => id);
  assert.deepEqual(order(), batch.map(({ id }) => id), 'optimistic album order');
  assert.equal(changed.mock.callCount(), 1);
  await idle();
  assert.deepEqual(server.requests.slice(1).map(({ add }) => add.length), [500, 2_000]);
  assert.deepEqual(order(), batch.map(({ id }) => id), 'saved album order');
  const snap = server.stars.get(id(100)).snap;
  assert.deepEqual(Object.keys(snap).sort(), ['album', 'artist', 'duration', 'ext', 'format', 'kind', 'title']);
  assert.equal(snap.title, 'Song 100');
  assert.equal(changed.mock.callCount(), 1);
  assert.equal(getState().favorites[1].id, batch[0].id);
  assert.equal(new Set(getState().favorites.slice(1).map(({ _extra }) => _extra.computer.starSequence)).size, 2_502);

  assert.equal(removeFavorites(batch.map(({ id }) => id)), true);
  assert.equal(isFavorite(batch[0].id), false);
  await idle();
  assert.deepEqual(server.requests.slice(-2).map(({ remove }) => remove.length), [2_000, 500]);
  assert.equal(changed.mock.callCount(), 2);
  const single = item(3);
  server.failWrite = () => 422;
  assert.equal(addFavorite(single), true);
  assert.equal(isFavorite(single.id), true);
  await idle();
  assert.equal(isFavorite(single.id), false);
  assert.equal(getPersistenceWarnings().includes('The star could not be saved.'), true);
  const existing = 'computer:' + id(1);
  assert.equal(removeFavorite(existing), true);
  assert.equal(isFavorite(existing), false);
  await idle();
  assert.equal(isFavorite(existing), true);

  server.failWrite = () => false;
  assert.equal(addFavorite(single), true);
  assert.equal(addFavorites([{ ...radio, id: 'radio:second' }]).added, 1);
  assert.equal(moveFavorite(single.id, 'top'), false);
  assert.equal(moveFavorite(radio.id, 'top'), true);
  const group = createFavoriteGroup('Portable').group;
  assert.equal(assignFavoriteToGroup(single.id, group.id).ok, false);
  assert.equal(renameFavorite(single.id, 'Renamed').ok, false);
  saveEqState({ ...loadEqState(), favorites: { [single.id]: {} }, assignments: { [single.id]: 'flat' } });
  assert.equal(Object.hasOwn(setStationEqPreset(loadEqState(), [single.id], 'flat').assignments, single.id), false);
  const moved = { ...radio, id: 'tv:favorite', type: 'tv' };
  assert.equal(moveFavoritesToNewIds(new Map([[radio.id, moved]]), storage).moved, 1);
  await idle();
  assert.equal(server.stars.has(id(3)), true);
  assert.equal([...data.values()].some((raw) => raw.includes('computer:')), false);
  assert.deepEqual(JSON.parse(data.get(STORAGE_KEYS.favorites)).map(({ id }) => id), [moved.id, 'radio:second']);

  const previousSource = view.activeSource;
  try {
    view.activeSource = 'favorites';
    assert.deepEqual(libraryExportSelection('json').stations.map(({ name }) => name), ['Station', 'Station']);
  } finally {
    view.activeSource = previousSource;
  }
  const { values } = await saveProfileHandoff({ storage, requestImpl: async (_path, { body }) => {
    assert.equal(Object.values(body.values).some((raw) => raw.includes('computer:')), false);
    return { saved: true };
  } });
  assert.deepEqual(values, captureProfileStorage(storage));
});

test('the new catalog and moved stars are visible together, including an existing destination star', async (t) => {
  const { server } = fixture(t, [record(1), record(3), record(4)]);
  await initState();
  await loadComputerStars();
  const folders = [{ id: 'music', available: true }];
  const entry = (number) => ({ id: id(number), folder: 'music', kind: 'video', title: 'Concert ' + number });
  let catalog = { revision: 1, folders, items: [entry(1), entry(3)] };
  const status = async () => ({ scanning: false, revision: catalog.revision });
  const library = createComputerLibrary({
    loadComputerLibrary: async () => catalog, computerStatus: status, startComputerScan: status,
  });
  t.after(library.closeComputerLibrary);
  await library.openComputerLibrary();
  const search = createComputerSearch();
  const before = search('Concert', library.getComputerLibrary());
  assert.deepEqual(before.map(({ id }) => id), ['computer:' + id(1), 'computer:' + id(3)]);

  for (const [from, to] of [[1, 2], [3, 4]]) {
    const star = server.stars.get(id(from));
    server.stars.delete(id(from));
    if (!server.stars.has(id(to))) server.stars.set(id(to), { ...star, id: id(to) });
  }
  assert.equal(isFavorite('computer:' + id(1)), true);
  assert.equal(isFavorite('computer:' + id(2)), false);

  function visible(snapshot) {
    return getState().favorites.map((item) => computerItemForView(item, snapshot))
      .map((item) => [item.id, item.title, item.__computerMissing]);
  }
  const catalogViews = [];
  const favoriteViews = [];
  t.after(library.subscribeComputerLibrary((snapshot) => catalogViews.push(visible(snapshot))));
  t.after(subscribe('favorites-change', () => favoriteViews.push(visible(library.getComputerLibrary()))));
  catalog = { revision: 2, folders, items: [entry(2), entry(4)],
    moved: [[id(1), id(2)], [id(3), id(4)]] };
  await library.refreshAvailability();
  const expected = [
    ['computer:' + id(4), 'Video 4', false],
    ['computer:' + id(2), 'Video 1', false],
  ];
  assert.deepEqual(catalogViews, [expected]);
  assert.deepEqual(favoriteViews, [expected]);
  assert.deepEqual(search('Concert', library.getComputerLibrary()).map(({ id }) => id),
    ['computer:' + id(2), 'computer:' + id(4)]);
  assert.deepEqual(server.requests, [{ method: 'GET' }]);
  await library.foldersChanged(folders);
  assert.deepEqual(favoriteViews, [expected], 'a repeated full answer did not change Favorites again');
});

test('a star answer that started before a move cannot restore the old id', async (t) => {
  const { server } = fixture(t, [record(1)]);
  const fetch = server.fetch;
  const requested = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(server, 'fetch', async (path, request) => {
    const reply = fetch(path, request);
    if (path === '/api/v1/computer/stars') {
      requested.resolve();
      await release.promise;
    }
    return reply;
  });
  await initState();
  const loading = loadComputerStars();
  await requested.promise;

  const folders = [{ id: 'music', available: true }];
  const library = createComputerLibrary({
    loadComputerLibrary: async () => ({ revision: 2, folders,
      items: [{ id: id(2), folder: 'music', kind: 'video' }], moved: [[id(1), id(2)]] }),
  });
  await library.ensureComputerLibrary();
  release.resolve();
  assert.equal(await loading, true);
  const [star] = getState().favorites;
  assert.equal(star.id, 'computer:' + id(2));
  assert.equal(computerItemForView(star, library.getComputerLibrary()).__computerMissing, false);
});

test('failed startup reads can retry, and failed legacy migration retains its input until the next startup', async (t) => {
  const { server, storage } = fixture(t, [record(1)]);
  const legacy = item(2);
  const raw = JSON.stringify([legacy, radio]);
  storage.setItem(STORAGE_KEYS.favorites, raw);
  storage.setItem(STORAGE_KEYS.favoriteNames, JSON.stringify({ version: 1, names: { [legacy.id]: 'Old name', [radio.id]: 'Portable' } }));
  storage.setItem(STORAGE_KEYS.favoriteGroups, JSON.stringify({ version: 1, groups: [{ id: 'g', name: 'Group' }], assign: { [legacy.id]: 'g' } }));
  storage.setItem('worldmedia.eq.v1', JSON.stringify({ favorites: { [legacy.id]: {} } }));
  storage.setItem('worldmedia.eq-extra.v1', JSON.stringify({ q: { favorites: { [legacy.id]: [] } }, assignments: { [legacy.id]: 'flat' } }));
  server.failRead = true;
  server.failWrite = () => 422;
  await initState();
  assert.equal(await loadComputerStars(), false);
  assert.deepEqual(getState().favorites.map(({ id }) => id), [radio.id]);
  assert.equal(storage.getItem(STORAGE_KEYS.favorites), raw);
  assert.equal(Object.values(captureProfileStorage(storage)).some((value) => value.includes('computer:')), false);
  server.failRead = false;
  assert.equal(await loadComputerStars(), true);
  assert.equal(isFavorite('computer:' + id(1)), true);
  assert.equal(isFavorite(legacy.id), false);
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'POST', 'GET']);

  // A regular favorite edit can go ahead while the legacy import is pending.
  assert.equal(addFavorite({ ...radio, id: 'radio:new' }), true);
  assert.equal(storage.getItem(STORAGE_KEYS.favorites).includes('computer:'), false);
  server.failWrite = () => false;
  await initState();
  assert.equal(await loadComputerStars(), true);
  assert.equal(isFavorite(legacy.id), true);
  assert.equal(server.stars.get(id(2)).snap.title, legacy.title);
  assert.equal(server.requests.filter(({ method }) => method === 'POST').length, 2);
  assert.equal([...storageValues()].some((value) => value.includes('computer:')), false);

  function storageValues() {
    return [...Object.values(captureProfileStorage(storage)), storage.getItem('worldmedia.computer-stars-migration.v1') || ''];
  }
});

test('removing all local stars does not need browser storage', async (t) => {
  const { server, storage } = fixture(t, [record(1), record(2)]);
  await initState();
  await loadComputerStars();
  t.mock.method(storage, 'setItem', () => { throw new Error('Storage unavailable'); });
  assert.deepEqual(removeAllFavorites(), { removed: 2, failed: '' });
  assert.equal(getState().favorites.length, 0);
  await idle();
  assert.deepEqual(server.requests.at(-1), { method: 'POST', add: [], remove: [id(2), id(1)] });
  assert.equal(server.stars.size, 0);
});

test('at 10,000 local stars membership uses a Set and portable bulk room is still 1,000', async (t) => {
  const { server } = fixture(t, Array.from({ length: 10_000 }, (_, index) => record(index)));
  await initState();
  await loadComputerStars();
  const has = Set.prototype.has;
  let lookups = 0;
  const spy = t.mock.method(Set.prototype, 'has', function (key) {
    if (typeof key === 'string' && key.startsWith('computer:')) lookups++;
    return has.call(this, key);
  });
  for (let index = 0; index < 10_000; index++) assert.equal(isFavorite('computer:' + id(index)), true);
  assert.equal(isFavorite('computer:' + id(10_000)), false);
  spy.mock.restore();
  assert.equal(lookups, 10_001);
  assert.equal(addFavorites(Array.from({ length: 1_001 }, (_, n) => ({ ...radio, id: 'radio:' + n }))).added, 1_000);
  assert.deepEqual(server.requests, [{ method: 'GET' }]);
});

test('UTF-8 bytes cap every chunk without changing the album order', async (t) => {
  const { server } = fixture(t);
  await initState();
  await loadComputerStars();
  const album = Array.from({ length: 2_100 }, (_, index) => item(index, '\u{1f3b5}'.repeat(350)));
  const order = () => getState().favorites.map(({ id }) => id);
  const expected = album.map(({ id }) => id);
  assert.equal(addFavorites(album).added, album.length);
  assert.deepEqual(order(), expected);
  await idle();
  const chunks = server.requests.slice(1).map(({ add }) => add);
  assert.ok(chunks.length > 2);
  const size = (add) => new TextEncoder().encode(JSON.stringify({ add })).byteLength;
  assert.ok(chunks.every((add) => add.length <= 2_000 && size(add) <= 1024 * 1024));
  assert.ok(chunks.slice(1).every((add) => size([...add, add[0]]) > 1024 * 1024));
  assert.equal(Array.from(chunks[0][0].snap.title).length, 300);
  assert.deepEqual(order(), expected);
  assert.deepEqual([...server.stars.values()].sort((a, b) => b.seq - a.seq).map(({ id }) => 'computer:' + id), expected);
});

test('lost write replies reread committed stars and replay later edits', async (t) => {
  const { server } = fixture(t, [record(1)]);
  await initState();
  await loadComputerStars();
  const lost = Promise.withResolvers();
  const normal = server.replyToWrite;
  server.replyToWrite = () => lost.promise;
  addFavorite(item(2));
  await idle();
  assert.equal(server.stars.has(id(2)), true);
  removeFavorite(item(2).id);
  addFavorite(item(3));
  assert.equal(isFavorite(item(2).id), false);
  assert.equal(isFavorite(item(3).id), true);
  server.replyToWrite = normal;
  lost.reject(new TypeError('Network disconnected'));
  await idle();
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'POST', 'GET', 'POST', 'POST']);
  assert.deepEqual(getState().favorites.map(({ id }) => id), [item(3).id, item(1).id]);
  assert.deepEqual([...server.stars.keys()], [id(1), id(3)]);
});

test('5xx, wrong counts and unexpected removals reconcile against GET', async (t) => {
  const { server } = fixture(t, [record(1), record(2)]);
  await initState();
  await loadComputerStars();
  const success = server.replyToWrite;
  server.replyToWrite = () => Response.json({ ok: false, error: { message: 'Busy' } }, { status: 503 });
  addFavorite(item(3));
  await idle();
  assert.equal(isFavorite(item(3).id), true);
  server.replyToWrite = (data) => success({ ...data, count: data.count + 1 });
  addFavorite(item(4));
  await idle();
  assert.equal(isFavorite(item(4).id), true);
  server.replyToWrite = (data) => success({ ...data, removed: [] });
  removeFavorite(item(1).id);
  await idle();
  assert.equal(isFavorite(item(1).id), false);
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'POST', 'GET', 'POST', 'GET', 'POST', 'GET']);
});

test('an explicit refusal rolls back only its own chunk', async (t) => {
  const { server } = fixture(t);
  await initState();
  await loadComputerStars();
  const album = Array.from({ length: 2_001 }, (_, index) => item(index));
  server.failWrite = (add) => add[0].id === id(2_000) ? 422 : false;
  addFavorites(album);
  assert.equal(getState().favorites.length, 2_001);
  await idle();
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'POST', 'POST']);
  assert.deepEqual(getState().favorites.map(({ id }) => id), album.slice(0, 2_000).map(({ id }) => id));
});
