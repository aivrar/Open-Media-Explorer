import { isEqStation, loadEqState, saveEqState } from './eq-store.js';
import { favoriteNamesSnapshot } from './favorite-names.js';
import { getPlaylists, loadPlaylists, playlistsLoaded } from './playlists.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { emit, favoritesLoaded, getState, subscribe } from './state.js';

export function eqStations(favorites, playlists, names = new Map()) {
  const stations = new Map();
  function add(item, list, favorite = false) {
    if (!item.id || item.id.length > 512 || !isEqStation(item)) return;
    if (!stations.has(item.id)) {
      stations.set(item.id, {
        id: item.id, name: favorite && names.get(item.id) || item.title || 'Untitled station',
        type: item.type === 'tv' ? 'TV' : 'Radio', original: item.title, lists: new Set(),
      });
    }
    stations.get(item.id).lists.add(list);
  }
  for (const item of favorites) add(item, 'Favorites', true);
  for (const playlist of playlists) {
    for (const item of playlist.items) add(item, playlist.name || 'My Playlists');
  }
  return stations;
}

export function savedEqStations() {
  return eqStations(getState().favorites, getPlaylists(), favoriteNamesSnapshot().names);
}

export function trackEqStations() {
  let active = true;
  function prune() {
    if (!active || !favoritesLoaded() || !playlistsLoaded()) return;
    const eq = loadEqState();
    const ids = Object.keys(eq.assignments);
    if (!ids.length) return;
    const stations = savedEqStations();
    const removed = ids.filter((id) => !stations.has(id));
    if (!removed.length) return;
    for (const id of removed) delete eq.assignments[id];
    let failed = false;
    saveEqState(eq, undefined, () => { failed = true; });
    if (failed) return;
    scheduleProfileHandoff();
    emit('eq-change');
  }
  function reconcile() {
    if (playlistsLoaded()) prune();
    else if (Object.keys(loadEqState().assignments).length) loadPlaylists().catch(() => {});
  }
  const offPlaylists = subscribe('playlists-change', prune);
  const offFavorites = subscribe('favorites-change', reconcile);
  reconcile();
  return () => {
    active = false;
    offPlaylists();
    offFavorites();
  };
}
