import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { moveFavoritesToNewIds } from '../src/lib/favorite-migration.js';
import { createStreamAddressEditor } from '../src/modes/library/stream-addresses.js';
import { applyStreamCandidate, connectMediaRelay, streamCandidatesForItem } from '../src/lib/media-failover.js';
import { captureProfileStorage, restoreProfileStorageValues } from '../src/lib/profile-transfer.js';
import { markDidNotPlay, didNotPlayAt, forgetLoadedDidNotPlay } from '../src/lib/did-not-play.js';
import { forgetLoadedPlayedStreams, rememberPlayedStream, stationStreamLabel } from '../src/lib/played-streams.js';
import { addFavorite, clearCache, getState, removeFavorite } from '../src/lib/state.js';
import { importPlaylistFile, removePlaylist } from '../src/lib/playlists.js';
import { MAX_STATION_STREAM_BYTES, stationStreamAddresses, STATION_STREAMS_KEY } from '../src/lib/station-stream-addresses.js';
import { saveStationStreams } from '../src/lib/station-stream-edit.js';
import { FakeElement } from './helpers/fake-dom.js';

const original = 'https://station.example/live.mp3';
const replacement = 'http://station.example/new.aac';
const backup1 = 'https://backup.example/one';
const backup2 = 'https://backup.example/two';
const station = {
  id: 'radio-browser:test-station', source: 'radio-browser', type: 'radio', title: 'Test FM',
  stream_url: original, stream_kind: 'audio', delivery: 'live',
  _extra: { codec: 'MP3', bitrate: 128 },
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function setup(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const favorites = getState().favorites;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() });
  forgetLoadedPlayedStreams();
  forgetLoadedDidNotPlay();
  t.after(() => {
    getState().favorites = favorites;
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
}

test('saved addresses follow the station ID, transfer with the profile, and clear with local cache', async (t) => {
  setup(t);
  assert.equal(addFavorite(station), true);
  markDidNotPlay(station.id);
  rememberPlayedStream(station.id, { codec: 'MP3', bitrate: 128 });
  const calls = [];
  const request = async (path, options) => calls.push([path, options.body]);
  assert.equal(await saveStationStreams(station, { main: replacement, backups: [backup2, backup1] }, { request }), true);
  assert.deepEqual(calls, [['/api/v1/playlists/validate-stream-addresses', { urls: [replacement, backup2, backup1] }]]);
  assert.equal(didNotPlayAt(station.id), 0);
  assert.equal(stationStreamLabel(station), '');
  assert.equal(station.stream_url, original);
  assert.equal(getState().favorites.find((item) => item.id === station.id).stream_url, original);

  const newOrigin = memoryStorage();
  assert.equal(restoreProfileStorageValues(captureProfileStorage(localStorage), newOrigin), true);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: newOrigin });
  assert.deepEqual(stationStreamAddresses({ ...station }), { main: replacement, backups: [backup2, backup1], ordered: true });
  assert.equal(await saveStationStreams(station, { main: original, backups: [backup2, backup1] }, { request }), true);
  assert.deepEqual(stationStreamAddresses(station), { main: '', backups: [backup2, backup1], ordered: true });
  await clearCache();
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
  assert.deepEqual(stationStreamAddresses(station), { main: '', backups: [], ordered: false });
});

test('Clear local cache removes imported station edits and describes what it removes', async (t) => {
  setup(t);
  const item = { ...station, id: 'playlist:clear-cache', source: 'playlist' };
  const file = new File(['stations'], 'cache.m3u');
  const request = async (path) => path.endsWith('/import')
    ? { playlist: { id: 'cache', items: [item] } }
    : { playlists: [] };
  await importPlaylistFile(file, 'radio', request);
  await saveStationStreams(item, { main: replacement, backups: [backup1] }, { request });
  await clearCache();
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
  assert.equal(stationStreamAddresses(item).main, '');
  assert.equal(await saveStationStreams(item, { main: replacement, backups: [] }, { request }), true);

  const settings = await readFile(new URL('../src/lib/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /Clear local cache<\/label>\s*<span class="description">Removes favorites, stream address edits,/);
});

test('a My Playlists edit is kept when the same station is reimported', async (t) => {
  setup(t);
  const entry = { ...station, id: 'playlist:one', source: 'playlist', _extra: { backupStreamUrls: [backup1] } };
  let title = 'First name';
  const request = async (_path, options) => !options ? { playlists: [] } : {
    playlist: { id: 'list', items: [{ ...entry, title }] },
  };
  const file = new File(['not parsed by the client'], 'stations.json');
  const first = await importPlaylistFile(file, 'radio', request);
  assert.equal(await saveStationStreams(first.playlist.items[0], { main: replacement, backups: [] }, { request }), true);
  title = 'New name';
  const second = await importPlaylistFile(file, 'radio', request);
  const refreshed = second.playlist.items[0];
  assert.equal(refreshed.title, 'New name');
  assert.deepEqual(streamCandidatesForItem(refreshed, { preferBest: false }).map((c) => c.url), [replacement]);
  await saveStationStreams(refreshed, { main: original, backups: [] }, { request });
  assert.deepEqual(streamCandidatesForItem(refreshed, { preferBest: false }).map((c) => c.url), [original]);
});

test('unfavoriting a directory station removes its edit and orphaned edits are ignored', async (t) => {
  setup(t);
  addFavorite(station);
  await saveStationStreams(station, { main: replacement, backups: [backup1] }, { request: async () => {} });
  const raw = localStorage.getItem(STATION_STREAMS_KEY);
  applyStreamCandidate(station, { url: replacement, kind: 'audio' });
  removeFavorite(station.id);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
  assert.equal(streamCandidatesForItem(station, { preferBest: false })[0].url, original);
  assert.equal(streamCandidatesForItem(station)[0].url, original);

  localStorage.setItem(STATION_STREAMS_KEY, raw);
  assert.deepEqual(stationStreamAddresses(station), { main: '', backups: [], ordered: false });
});

test('removing a playlist preserves edits until the last saved copy is removed', async (t) => {
  setup(t);
  const item = { ...station, id: 'playlist:shared', source: 'playlist' };
  const file = new File(['stations'], 'shared.m3u');
  let listId = 'first';
  const request = async (path) => path.endsWith('/import')
    ? { playlist: { id: listId, items: [item] } }
    : { playlists: [] };
  await importPlaylistFile(file, 'radio', request);
  listId = 'second';
  await importPlaylistFile(file, 'radio', request);
  addFavorite(item);
  await saveStationStreams(item, { main: replacement, backups: [backup1] }, { request });
  await removePlaylist('first', request);
  removeFavorite(item.id);
  assert.equal(stationStreamAddresses(item).main, replacement);

  addFavorite(item);
  await removePlaylist('second', request);
  assert.equal(stationStreamAddresses(item).main, replacement);
  removeFavorite(item.id);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);

  await importPlaylistFile(file, 'radio', request);
  await saveStationStreams(item, { main: replacement, backups: [backup1] }, { request });
  await removePlaylist('second', request);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
  assert.equal(stationStreamAddresses(item).main, '');
});

test('the editor store refuses a save over its UTF-8 budget and keeps saved addresses', async (t) => {
  setup(t);
  const request = async () => {};
  const stationAt = (index) => ({ ...station, id: `budget:${index}` });
  const valueAt = (index) => ({
    main: `https://station.example/${index}/${'é'.repeat(4000)}`,
    backups: Array.from({ length: 5 }, (_, backup) => `https://backup.example/${backup}/${'x'.repeat(4000)}`),
  });
  const count = Math.floor(MAX_STATION_STREAM_BYTES / 28_200);
  for (let index = 0; index < count; index++) {
    const item = stationAt(index);
    addFavorite(item);
    assert.equal(await saveStationStreams(item, valueAt(index), { request }), true);
  }
  const saved = localStorage.getItem(STATION_STREAMS_KEY);
  const item = stationAt(count);
  addFavorite(item);
  await assert.rejects(saveStationStreams(item, valueAt(count), { request }), /Saved stream addresses are full/);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), saved);
  const first = stationAt(0);
  assert.equal(await saveStationStreams(first, { main: original, backups: [] }, { request }), true);
  assert.equal(await saveStationStreams(item, valueAt(count), { request }), true);
});

test('invalid URLs and failed validation never change the saved addresses', async (t) => {
  setup(t);
  const request = t.mock.fn(async () => { throw new Error('Public address required.'); });
  const save = (main, backups = []) => saveStationStreams(station, { main, backups }, { request });
  await assert.rejects(save(replacement), /Save this station/);
  addFavorite(station);
  await assert.rejects(save('file:///a'), /HTTP or HTTPS/);
  await assert.rejects(save('https://user:pass@example.com/a'), /HTTP or HTTPS/);
  await assert.rejects(save(replacement, [replacement]), /different address/);
  await assert.rejects(save(replacement, Array(6).fill(backup1)), /up to 5/);
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(save('http://127.0.0.1/live'), /Public address required/);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
});

test('saved addresses take precedence over best-stream ranking and use the existing relay in order', async (t) => {
  setup(t);
  addFavorite(station);
  await saveStationStreams(station, { main: replacement, backups: [backup2, backup1] }, { request: async () => {} });
  const item = {
    ...station, capture_headers: { userAgent: 'Original/1' },
    _extra: { ...station._extra, streamCandidates: [{ url: original, kind: 'audio', bitrate: 320 }] },
  };
  const extraStreams = [{ url: 'https://verified.example/fm', kind: 'audio', bitrate: 320 }];
  const candidates = streamCandidatesForItem(item, { preferBest: true, extraStreams });
  assert.deepEqual(candidates.map((c) => c.url), [replacement, backup2, backup1]);
  assert.deepEqual(candidates[0], { url: replacement, kind: 'audio', headers: {} });
  const tried = [];
  const relay = await connectMediaRelay(item, {
    preferBest: true, extraStreams,
    registerImpl: async (candidate) => {
      tried.push(candidate.stream_url);
      assert.equal(candidate.capture_headers.userAgent, undefined);
      if (candidate.stream_url !== backup1) throw new Error('No connection');
      return { media_id: 'winner', relay_url: '/winner' };
    },
    probeImpl: async () => {},
  });
  assert.deepEqual(tried, [replacement, backup2, backup1]);
  assert.equal(relay.media_id, 'winner');
  assert.equal(streamCandidatesForItem(item)[0].url, backup1, 'recording still selects the stream that played');
  applyStreamCandidate(item, candidates[1]);
  assert.equal(streamCandidatesForItem(item, { preferBest: false })[0].url, replacement, 'a new playback starts at the main address');
});

test('the editor supports ownership, cancel, adding, reordering, removing, and restoring', async (t) => {
  setup(t);
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => Object.assign(new FakeElement('', tag), {
    replaceChildren() { this.children = []; },
    focus() {},
  }) };
  t.after(() => { globalThis.document = previous; });

  const draft = [];
  const editor = createStreamAddressEditor(station, {
    save: async (_item, values) => {
      await saveStationStreams(station, values, { request: async () => {} });
      draft.push(values);
      return true;
    },
  });
  t.after(() => editor.destroy());
  const find = (node, match) => match(node) ? node : node.children.map((child) => find(child, match)).find(Boolean);
  const button = (name) => find(editor.form, (node) => node.tagName === 'BUTTON' && node.textContent === name);
  const byAria = (name) => find(editor.form, (node) => node.getAttribute('aria-label') === name);
  const main = find(editor.form, (node) => node.getAttribute('id') === 'library-detail-main-stream-address');
  const click = (node) => node.dispatchEvent(new Event('click'));
  const submit = async () => {
    editor.form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
  };

  assert.equal(editor.button.hidden, true);
  addFavorite(station);
  assert.equal(editor.button.hidden, false);
  click(editor.button);
  assert.equal(main.value, original);
  assert.equal(button('Restore original').hidden, true);
  main.value = replacement;
  click(button('Cancel'));
  assert.equal(editor.form.hidden, true);
  click(editor.button);
  assert.equal(main.value, original);
  main.value = replacement;
  click(button('Add backup'));
  byAria('Backup address 1').value = backup1;
  click(button('Add backup'));
  const secondBackup = byAria('Backup address 2');
  secondBackup.value = backup2;
  const list = byAria('Backup addresses');
  const [field, controls] = list.children[1].children;
  assert.equal(field, secondBackup);
  assert.equal(controls.className, 'detail-backup-controls');
  assert.deepEqual(controls.children.map((node) => [
    node.tagName, node.getAttribute('aria-label'), node.getAttribute('title'),
  ]), [
    ['BUTTON', 'Move backup 2 up', 'Move up'],
    ['BUTTON', 'Move backup 2 down', 'Move down'],
    ['BUTTON', 'Remove backup 2', 'Remove backup'],
  ]);
  click(byAria('Move backup 2 up'));
  click(byAria('Remove backup 2'));
  await submit();
  assert.deepEqual(draft, [{ main: replacement, backups: [backup2] }]);
  click(editor.button);
  assert.equal(main.value, replacement);
  assert.equal(button('Restore original').hidden, false);
  click(button('Restore original'));
  await submit();
  assert.deepEqual(draft.at(-1), { main: original, backups: [backup2] });

  click(editor.button);
  const promote = byAria('Make this the main address');
  assert.equal(promote.getAttribute('title'), 'Make this the main address');
  assert.notEqual(promote.disabled, true);
  click(promote);
  assert.equal(main.value, backup2);
  assert.equal(byAria('Backup address 1').value, original);
  click(button('Restore original'));
  assert.equal(main.value, original);
  assert.equal(byAria('Backup address 1').value, backup2);
  click(promote);
  click(button('Cancel'));
  click(editor.button);
  assert.equal(main.value, original);
  assert.equal(byAria('Backup address 1').value, backup2);

  rememberPlayedStream(station.id, { codec: 'MP3', bitrate: 128 });
  click(byAria('Make this the main address'));
  await submit();
  assert.deepEqual(draft.at(-1), { main: backup2, backups: [original] });
  assert.equal(stationStreamLabel(station), '', 'a promoted main clears the learned format');
  click(editor.button);
  click(button('Restore original'));
  await submit();
  assert.deepEqual(draft.at(-1), { main: original, backups: [backup2] });
});

test('a type migration moves the addresses and rolls back if they cannot be saved', async (t) => {
  setup(t);
  addFavorite(station);
  await saveStationStreams(station, { main: replacement, backups: [backup1] }, { request: async () => {} });
  const storage = globalThis.localStorage;
  const originalSet = storage.setItem;
  const oldRaw = storage.getItem(STATION_STREAMS_KEY);
  const tv = { ...station, id: 'playlist:tv-new', type: 'tv' };
  const moves = new Map([[station.id, tv]]);
  storage.setItem = (key, value) => {
    if (key === STATION_STREAMS_KEY) throw new Error('write refused');
    originalSet(key, value);
  };
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(moveFavoritesToNewIds(moves), { moved: 0, failed: true });
  assert.equal(getState().favorites[0].id, station.id);
  assert.equal(JSON.parse(storage.getItem('worldmedia.favorites.v1'))[0].id, station.id);
  assert.equal(storage.getItem(STATION_STREAMS_KEY), oldRaw);

  storage.setItem = originalSet;
  assert.deepEqual(moveFavoritesToNewIds(moves), { moved: 1, failed: false });
  assert.deepEqual(stationStreamAddresses(tv), { main: replacement, backups: [backup1], ordered: true });
  assert.equal(Object.hasOwn(JSON.parse(storage.getItem(STATION_STREAMS_KEY)).stations, station.id), false);
});

test('address edits cannot grow the combined UTF-8 profile past the handoff limit', async (t) => {
  setup(t);
  addFavorite(station);
  const bytes = new TextEncoder();
  const before = Object.values(captureProfileStorage()).reduce((total, value) => total + bytes.encode(value).length, 0);
  localStorage.setItem('worldmedia.settings.v1', 'é'.repeat(Math.floor((2 * 1024 * 1024 - before - 200) / 2)));
  assert.doesNotThrow(() => captureProfileStorage());
  const main = `https://station.example/${'é'.repeat(150)}`;
  await assert.rejects(saveStationStreams(station, { main, backups: [] }, { request: async () => {} }), /profile is full/i);
  assert.equal(localStorage.getItem(STATION_STREAMS_KEY), null);
});
