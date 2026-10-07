import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../src/lib/state.js';
import { validateItem } from '../src/lib/item-model.js';
import { view } from '../src/modes/library/state.js';
import { filterItems } from '../src/modes/library/filter.js';
import { libraryPool } from '../src/modes/library/personal.js';

test('Add link posts to native service, keeps previous data on failure, and validates schemes locally', async () => {
  const client = await import(`../src/lib/playlists.js?links=${Date.now()}`);
  let payload;
  let fail = false;
  const request = async (path, options) => {
    if (!options) return { playlists: [] };
    assert.equal(path, '/api/v1/playlists/link');
    payload = options.body;
    if (fail) throw new Error('Playlist unavailable');
    return { playlist: { id: 'link', name: 'Radio', items: [] }, kind: 'stream' };
  };
  await client.addPlaylistLink({ url: ' https://example.org/live ', name: 'Radio', defaultType: 'radio' }, request);
  assert.deepEqual(payload, { url: 'https://example.org/live', name: 'Radio', default_type: 'radio', kind: 'stream' });
  fail = true;
  await assert.rejects(client.addPlaylistLink({ url: 'https://example.org/list', kind: 'playlist' }, request), /unavailable/);
  assert.equal(client.getPlaylists().length, 1);
  for (const url of ['', 'hello', 'file:///c:/data', 'https://user:pass@example.org/', 'https://example.org/evil\npath']) {
    await assert.rejects(client.addPlaylistLink({ url }, () => assert.fail('invalid input must not fetch')), /valid HTTP/);
  }
});

test('Favorites type and local search filters do not search or change the public catalog', () => {
  const state = getState();
  const before = { favorites: state.favorites, source: view.activeSource, last: view.lastQuery, type: view.filters.type };
  try {
    state.favorites = ['radio', 'tv', 'video', 'audio'].map((type) => ({
      id: `saved:${type}`, type, source: 'iptv-org', title: `${type} favorite`, content_rating: 'unrated',
    }));
    view.activeSource = 'favorites';
    view.lastQuery = 'unrelated public search';
    view.filters.type = 'video';
    view.personalFilters.favorites = { type: 'radio', query: 'FAVORITE' };
    assert.deepEqual(filterItems(libraryPool()).map((item) => item.type), ['radio']);
    view.personalFilters.favorites.type = 'tv';
    assert.deepEqual(filterItems(libraryPool()).map((item) => item.type), ['tv']);
    view.personalFilters.favorites.type = '';
    assert.equal(filterItems(libraryPool()).length, 4);
    view.personalFilters.favorites.query = 'does not exist';
    assert.equal(filterItems(libraryPool()).length, 0);
    assert.equal(view.lastQuery, 'unrelated public search');
    assert.equal(view.filters.type, 'video');
  } finally {
    state.favorites = before.favorites;
    view.activeSource = before.source; view.lastQuery = before.last; view.filters.type = before.type;
    view.personalFilters.favorites = { query: '', type: '' };
  }
});

test('playlist native writes succeed before local changes; replacement and removal keep favorites', async () => {
  const client = await import(`../src/lib/playlists.js?test=${Date.now()}`);
  const calls = [];
  const channel = { id: 'playlist:fixture', title: 'My station', type: 'radio', source: 'playlist', stream_url: 'https://example.org/live', stream_kind: 'audio', delivery: 'live' };
  const entry = { id: 'test-list', name: 'music.m3u', items: [channel], skipped: 0, duplicates: 0 };
  let fail = false;
  const request = async (path, options) => {
    calls.push({ path, options });
    if (fail) throw new Error('Disk full');
    if (!options) return { playlists: [] };
    if (path.endsWith('/import')) return { playlist: entry };
    return { removed: true };
  };
  const file = new File(['#EXTM3U\nhttps://example.org/live'], 'music.m3u');
  await client.importPlaylistFile(file, 'radio', request);
  assert.equal(client.getPlaylists().length, 1);
  assert.deepEqual(validateItem(client.getPlaylistItems()[0]), []);
  assert.equal(calls[1].options.body.default_type, 'radio');
  const revision = client.getPlaylistItems()[0].__revision;
  await client.importPlaylistFile(file, 'radio', request);
  assert.equal(client.getPlaylists().length, 1);
  assert.ok(client.getPlaylistItems()[0].__revision > revision);
  const favorites = getState().favorites;
  fail = true;
  await assert.rejects(client.removePlaylist(entry.id, request), /Disk full/);
  assert.equal(client.getPlaylists().length, 1);
  await assert.rejects(client.importPlaylistFile(file, 'radio', request), /Disk full/);
  assert.equal(client.getPlaylists().length, 1);
  fail = false;
  await client.removePlaylist(entry.id, request);
  assert.equal(client.getPlaylistItems().length, 0);
  assert.equal(getState().favorites, favorites);
});

test('playlist file decoding supports legacy radio names, rejects invalid files without requests', async () => {
  const client = await import(`../src/lib/playlists.js?encoding=${Date.now()}`);
  let imported;
  const request = async (_path, options) => {
    if (!options) return { playlists: [] };
    imported = options.body.text;
    return { playlist: { id: 'a', name: 'radio.m3u', items: [] } };
  };
  const file = new File([new Uint8Array([0x63, 0x61, 0x66, 0xe9])], 'radio.m3u');
  await client.importPlaylistFile(file, 'radio', request);
  assert.equal(imported, 'caf\u00e9');
  await assert.rejects(client.importPlaylistFile(new File(['x'], 'bad.exe'), 'tv', request), /Choose/);
  await assert.rejects(client.importPlaylistFile({ name: 'big.m3u', size: 9 * 1024 * 1024 }, 'tv', request), /8 MiB/);
});
