import {
  checkProfileStorageBudget, MAX_PROFILE_BYTES, profileStorageSize, readProfileStorage,
} from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';

export const PART_RESUME_KEY = 'worldmedia.partresume.v1';
const LIMIT = 200;
const MAX_BOOKMARK_BYTES = 8 * 1024;
const MAX_BOOKMARKS_BYTES = 128 * 1024;
const utf8 = new TextEncoder();
let generation = 0;

function read() {
  try {
    const storage = globalThis.localStorage;
    const entries = JSON.parse(storage?.getItem(PART_RESUME_KEY) || '[]');
    if (!Array.isArray(entries)) return [];
    let changed = false;
    const cleaned = entries.filter((entry) => typeof entry?.id === 'string' && typeof entry.partKey === 'string'
      && Number.isFinite(entry.position) && entry.position >= 0).slice(0, LIMIT).flatMap((entry) => {
      if (!entry.id.startsWith('computer:book:') || !entry.partKey.startsWith('[')) return [entry];
      try {
        const ids = JSON.parse(entry.partKey);
        if (Array.isArray(ids) && ids.length && ids.every((id) => typeof id === 'string')) return [entry];
        changed = true;
        // Older audiobook bookmarks put the file's sort path after the id.
        return typeof ids?.[0] === 'string' ? [{ ...entry, partKey: ids[0] }] : [];
      } catch {
        changed = true;
        return [];
      }
    });
    if (changed) {
      try { storage.setItem(PART_RESUME_KEY, JSON.stringify(cleaned)); } catch { /* Storage is unavailable. */ }
    }
    return cleaned;
  } catch (_) {
    return [];
  }
}

export function removeComputerResumePaths() { read(); }

export function partResumeGeneration() { return generation; }

export function readPartResume(id) {
  return read().find((entry) => entry.id === id) || null;
}

export function rememberPartResume(id, partKey, seconds, epoch) {
  if (epoch !== generation || !id || !Number.isFinite(seconds) || seconds < 0) return;
  const position = Math.floor(seconds);
  const entries = read();
  const existing = entries.find((entry) => entry.id === id);
  if (!partKey && !existing) return;
  if (entries[0] === existing && existing?.partKey === partKey && existing?.position === position) return;
  const bookmark = { id, partKey, position };
  if (partKey && utf8.encode(JSON.stringify(bookmark)).byteLength > MAX_BOOKMARK_BYTES) return;
  const rest = entries.filter((entry) => entry.id !== id);
  if (partKey) rest.unshift(bookmark);
  write(rest, Boolean(partKey));
}

function write(entries, keepIfEmpty = false) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const profile = readProfileStorage(storage);
    delete profile[PART_RESUME_KEY];
    const available = Math.min(MAX_BOOKMARKS_BYTES, MAX_PROFILE_BYTES - profileStorageSize(profile));
    const encoded = [];
    let size = 2;
    for (const entry of entries.slice(0, LIMIT)) {
      const value = JSON.stringify(entry);
      const bytes = utf8.encode(value).byteLength;
      if (bytes > MAX_BOOKMARK_BYTES) continue;
      const nextSize = size + bytes + (encoded.length ? 1 : 0);
      if (nextSize > available) break;
      encoded.push(value);
      size = nextSize;
    }
    // Keep the old bookmarks if even the new one alone cannot fit.
    if (!encoded.length && keepIfEmpty) return;
    if (!encoded.length) {
      storage.removeItem(PART_RESUME_KEY);
    } else {
      const raw = '[' + encoded.join(',') + ']';
      checkProfileStorageBudget(storage, [[PART_RESUME_KEY, raw]]);
      storage.setItem(PART_RESUME_KEY, raw);
    }
    scheduleProfileHandoff();
  } catch (_) {}
}

// The library publishes resume marks, track choices, then the live queue.
// Take the storage snapshots first. The queue callback supplies the catalog
// for the entire batch before library listeners see any of the changes.
const moveBatches = new WeakMap();

export function stageComputerMoves(moves, apply) {
  if (!moveBatches.has(moves)) moveBatches.set(moves, []);
  moveBatches.get(moves).push(apply);
}

export function applyComputerMoves(moves, entriesById) {
  const edges = new Map(moves);
  const destinations = new Map();
  const distance = new Map();
  const cycleMembers = new Set();
  for (const from of edges.keys()) {
    const path = new Set();
    let id = from;
    while (edges.has(id) && !destinations.has(id) && !path.has(id)) {
      path.add(id);
      id = edges.get(id);
    }
    // A cycle is a simultaneous exchange. Each member takes one edge.
    let inCycle = path.has(id);
    const to = cycleMembers.has(id) ? id : destinations.get(id) ?? id;
    let steps = cycleMembers.has(id) ? 0 : distance.get(id) ?? 0;
    for (const source of [...path].reverse()) {
      if (inCycle) {
        cycleMembers.add(source);
        destinations.set(source, edges.get(source));
        distance.set(source, 1);
        if (source === id) inCycle = false;
      } else {
        destinations.set(source, to);
        distance.set(source, ++steps);
      }
    }
  }
  const batch = { destinations, distance, entriesById };
  for (const apply of moveBatches.get(moves) ?? []) apply(batch);
  moveBatches.delete(moves);
  return destinations;
}

// Each proposal refers to an original record. A live, stationary destination
// keeps its record. When a chain converges, its origin precedes intermediate
// records left at the same destination.
export function movedComputerRecords(records, batch, targetFor) {
  const plans = new Map();
  const winners = new Map();
  for (const key of records.keys()) {
    const target = targetFor(key, batch.destinations);
    if (!target || target.key === key) continue;
    if (records.has(target.key) && !batch.destinations.has(target.to) && batch.entriesById.has(target.to)) continue;
    plans.set(key, target.key);
    const previous = winners.get(target.key);
    const priority = batch.distance.get(target.from);
    if (!previous || priority > previous.priority) winners.set(target.key, { key, priority });
  }
  const result = new Map();
  for (const [key, value] of records) {
    const to = plans.get(key) ?? key;
    if (!winners.has(to) || winners.get(to).key === key) result.set(to, value);
  }
  return result;
}

export function moveComputerResumeMarks(moves) {
  const entries = read();
  if (!entries.length) return;
  const records = new Map(entries.map(entry => [entry.id, entry]));
  stageComputerMoves(moves, (batch) => {
    const targets = new Map();
    for (const [from, to] of batch.destinations) {
      targets.set('computer:' + from, { from, to, key: 'computer:' + to });
      targets.set('computer:book:' + JSON.stringify([from]), { from, to, key: 'computer:book:' + JSON.stringify([to]) });
    }
    const moved = movedComputerRecords(records, batch, key => targets.get(key));
    const updated = [];
    let changed = moved.size !== records.size;
    for (const [id, record] of moved) {
      let partKey = record.partKey;
      if (id.startsWith('computer:book:')) {
        const ids = partKey.startsWith('[') ? JSON.parse(partKey) : [partKey];
        const parts = [...new Set(ids.map(part => targets.get(part)?.key ?? part))];
        if (parts.some((part, i) => part !== ids[i]) || parts.length !== ids.length) {
          partKey = parts.length === 1 ? parts[0] : JSON.stringify(parts);
        }
      }
      changed ||= id !== record.id || partKey !== record.partKey;
      updated.push({ ...record, id, partKey });
    }
    if (changed) write(updated, true);
  });
}

export function clearPartResume() {
  generation += 1;
  try { globalThis.localStorage?.removeItem(PART_RESUME_KEY); } catch (_) {}
}
