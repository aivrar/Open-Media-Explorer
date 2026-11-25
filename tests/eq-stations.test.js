import test from 'node:test';
import assert from 'node:assert/strict';

import { eqStations, trackEqStations } from '../src/lib/eq-stations.js';
import { eqStorageEntries, freshEqState, loadEqState, saveEqState, setStationEqPreset } from '../src/lib/eq-store.js';
import { loadPlaylists, removePlaylist } from '../src/lib/playlists.js';
import { cancelScheduledProfileHandoff } from '../src/lib/profile-transfer.js';
import { getState, initState, removeFavorite, STORAGE_KEYS } from '../src/lib/state.js';

const radio = { id: 'radio:one', title: 'One FM', type: 'radio' };
const tv = { id: 'tv:two', title: 'News', type: 'tv' };
const podcast = { id: 'podcast:three', title: 'An episode', type: 'audio' };
const playlist = { id: 'mine', name: 'My stations', items: [radio, tv, podcast] };

test('the station picker combines radio and TV from both saved lists by id', () => {
  const stations = eqStations([radio, podcast], [playlist], new Map([[radio.id, 'Morning station']]));
  assert.deepEqual([...stations.keys()], [radio.id, tv.id]);
  assert.equal(stations.get(radio.id).name, 'Morning station');
  assert.equal(stations.get(radio.id).original, 'One FM');
  assert.deepEqual([...stations.get(radio.id).lists], ['Favorites', 'My stations']);
  assert.deepEqual([...stations.get(tv.id).lists], ['My stations']);
});

test('a removed station loses its assignment when it leaves its last saved list', async () => {
  const previousStorage = globalThis.localStorage;
  const state = getState();
  const previousFavorites = state.favorites;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  values.set(STORAGE_KEYS.favorites, JSON.stringify([radio]));
  let stop;
  try {
    await initState();
    await loadPlaylists(async () => ({ playlists: [playlist] }));
    saveEqState(setStationEqPreset(freshEqState(), [radio.id, tv.id], 'bass-boost'));
    stop = trackEqStations();
    await removePlaylist(playlist.id, async () => ({}));
    assert.deepEqual(loadEqState().assignments, { [radio.id]: 'bass-boost' });
    removeFavorite(radio.id);
    assert.deepEqual(loadEqState().assignments, {});
  } finally {
    stop?.();
    cancelScheduledProfileHandoff();
    state.favorites = previousFavorites;
    globalThis.localStorage = previousStorage;
  }
});

test('a favorite-only assignment survives when the favorites read fails at startup', async (t) => {
  const previousStorage = globalThis.localStorage;
  const previousFavorites = getState().favorites;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) {
      if (key === STORAGE_KEYS.favorites) throw new Error('unreadable favorites');
      return values.get(key) ?? null;
    },
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  getState().favorites = [];
  t.mock.method(console, 'warn', () => {});
  let stop;
  try {
    const eq = setStationEqPreset(freshEqState(), [radio.id], 'bass-boost');
    for (const [key, value] of eqStorageEntries(eq)) values.set(key, value);
    assert.deepEqual(loadEqState().assignments, { [radio.id]: 'bass-boost' });
    await initState();
    await loadPlaylists(async () => ({ playlists: [] }));
    stop = trackEqStations();
    assert.deepEqual(loadEqState().assignments, { [radio.id]: 'bass-boost' });
  } finally {
    stop?.();
    cancelScheduledProfileHandoff();
    getState().favorites = previousFavorites;
    globalThis.localStorage = previousStorage;
  }
});
