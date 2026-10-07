/** Portable native storage; never mixed with disposable catalog snapshots. */
import { controlRequest } from './capture-client.js';
import { makeItem } from './item-model.js';
import { emit } from './state.js';

let playlists = [];
let combinedItems = [];
let pendingLoad = null;
let loaded = false;
let revision = 0;

export function getPlaylists() { return playlists; }
export function playlistName(value) {
  return Array.from(String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 160).join('');
}
export function getPlaylistItems(id = '') {
  return id ? playlists.find((entry) => entry.id === id)?.items || [] : combinedItems;
}

function publish(entries) {
  revision += 1;
  playlists = entries.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ ...makeItem(item), __revision: revision })) }));
  combinedItems = [...new Map(playlists.flatMap((entry) => entry.items).map((item) => [item.id, item])).values()];
  emit('playlists-change', playlists);
}

export async function loadPlaylists(requestImpl = controlRequest) {
  if (loaded) return playlists;
  if (pendingLoad) return pendingLoad;
  pendingLoad = requestImpl('/api/v1/playlists').then((data) => {
    publish(data.playlists);
    loaded = true;
    return playlists;
  }).finally(() => { pendingLoad = null; });
  return pendingLoad;
}

export async function importPlaylistFile(file, defaultType = 'tv', requestImpl = controlRequest) {
  if (!file || !/\.m3u8?$/i.test(file.name)) throw new Error('Choose an .m3u or .m3u8 file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Playlist exceeds 8 MiB; split it into smaller files.');
  await loadPlaylists(requestImpl);
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { text = new TextDecoder('windows-1252').decode(bytes); }
  const data = await requestImpl('/api/v1/playlists/import', {
    method: 'POST', body: { name: playlistName(file.name), text, default_type: defaultType },
  });
  publish([...playlists.filter((entry) => entry.id !== data.playlist.id), data.playlist]);
  return data;
}

export async function removePlaylist(id, requestImpl = controlRequest) {
  await loadPlaylists(requestImpl);
  await requestImpl('/api/v1/playlists/remove', { method: 'POST', body: { id } });
  publish(playlists.filter((entry) => entry.id !== id));
}

export async function addPlaylistLink({ url, name = '', defaultType = 'tv', kind = 'stream' }, requestImpl = controlRequest) {
  let parsed;
  const value = String(url || '').trim();
  try { parsed = new URL(value); } catch (_) { /* Validation below. */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new Error('Paste a valid HTTP or HTTPS stream/playlist link.');
  }
  await loadPlaylists(requestImpl);
  const data = await requestImpl('/api/v1/playlists/link', {
    method: 'POST', body: { url: value, name: playlistName(name), default_type: defaultType, kind },
  });
  publish([...playlists.filter((entry) => entry.id !== data.playlist.id), data.playlist]);
  return data;
}
