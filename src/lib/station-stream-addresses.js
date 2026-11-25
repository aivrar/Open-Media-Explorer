/** Saved station addresses use the same stable item IDs as favorites. */
import { isSavedItem } from './did-not-play-view.js';
import { safeExternalUrl } from './item-model.js';
import { loadPlaylists, playlistsLoaded } from './playlists.js';
import { checkProfileStorageBudget, ProfileStorageBudgetError } from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { emit } from './state.js';

export const STATION_STREAMS_KEY = 'worldmedia.stationstreams.v1';
export const MAX_BACKUP_STREAMS = 5;
export const MAX_STATION_STREAM_BYTES = 512 * 1024;

const EMPTY = Object.freeze([]);
const emptyDocument = { edits: new Map(), locked: false };
let cachedRaw;
let cachedDocument = emptyDocument;

export function cleanStreamAddress(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(url) && !/[\u0000-\u0020\u007f|]/.test(url) && safeExternalUrl(url) ? url : '';
}

function readDocument(raw) {
  try {
    const doc = JSON.parse(raw);
    if (Number.isInteger(doc?.version) && doc.version > 1) return { edits: new Map(), locked: true };
    if (doc?.version !== 1 || !doc.stations || typeof doc.stations !== 'object' || Array.isArray(doc.stations)) {
      return emptyDocument;
    }
    const edits = new Map();
    for (const [id, value] of Object.entries(doc.stations)) {
      if (!id || !value || typeof value !== 'object') continue;
      const main = cleanStreamAddress(value.main);
      const backups = Array.isArray(value.backups)
        ? Object.freeze(value.backups.slice(0, MAX_BACKUP_STREAMS).map(cleanStreamAddress).filter(Boolean))
        : null;
      if (main || backups) edits.set(id, Object.freeze({ main, backups }));
    }
    return { edits, locked: false };
  } catch (_) {
    return emptyDocument;
  }
}

export function stationStreamDocument() {
  let raw = null;
  try { raw = globalThis.localStorage?.getItem(STATION_STREAMS_KEY) ?? null; } catch (_) {}
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedDocument = readDocument(raw);
  }
  return cachedDocument;
}

function stationStreamEditsText(edits) {
  return edits.size ? JSON.stringify({ version: 1, stations: Object.fromEntries(edits) }) : null;
}

export function stationStreamsTextWithNewIds(raw, ids) {
  const doc = readDocument(raw);
  if (doc.locked) return raw;
  const edits = new Map(doc.edits);
  let changed = false;
  for (const [oldId, newId] of ids) {
    if (!edits.has(oldId) || oldId === newId) continue;
    if (!edits.has(newId)) edits.set(newId, edits.get(oldId));
    edits.delete(oldId);
    changed = true;
  }
  return changed ? stationStreamEditsText(edits) : raw;
}

export function writeStationStreamEdits(edits, { checkBudget = false } = {}) {
  const raw = stationStreamEditsText(edits);
  if (checkBudget) {
    const utf8 = new TextEncoder();
    const size = utf8.encode(raw || '').byteLength;
    if (size > MAX_STATION_STREAM_BYTES
        && size >= utf8.encode(cachedRaw || '').byteLength) {
      throw new Error('Saved stream addresses are full. Remove some addresses and try again.');
    }
  }
  try {
    const storage = globalThis.localStorage;
    if (checkBudget) checkProfileStorageBudget(storage, [[STATION_STREAMS_KEY, raw]]);
    if (raw) storage.setItem(STATION_STREAMS_KEY, raw);
    else storage.removeItem(STATION_STREAMS_KEY);
  } catch (error) {
    if (error instanceof ProfileStorageBudgetError) throw error;
    throw new Error('Could not save the stream addresses.');
  }
}

export function removeUnusedStationStreams(ids) {
  const doc = stationStreamDocument();
  if (!doc.edits.size) return;
  const unused = [];
  const unchecked = [];
  for (const id of ids) {
    if (!doc.edits.has(id) || isSavedItem(id)) continue;
    // Imported stations may still belong to a playlist that is loading.
    if (id.startsWith('playlist:') && !playlistsLoaded()) unchecked.push(id);
    else unused.push(id);
  }
  if (unchecked.length) {
    loadPlaylists().then(() => removeUnusedStationStreams(unchecked)).catch(() => {});
  }
  if (!unused.length) return;
  const edits = new Map(doc.edits);
  for (const id of unused) edits.delete(id);
  try { writeStationStreamEdits(edits); } catch (_) { return; }
  scheduleProfileHandoff();
  for (const id of unused) emit('station-streams-change', id);
}

export function stationStreamAddresses(item) {
  const edit = stationStreamDocument().edits.get(item?.id);
  const saved = edit && isSavedItem(item.id) ? edit : null;
  const main = saved?.main || '';
  const imported = item?._extra?.backupStreamUrls;
  const backups = saved?.backups ?? (Array.isArray(imported) ? imported : EMPTY);
  return { main, backups, ordered: Boolean(main || backups.length) };
}
