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
    const entries = JSON.parse(globalThis.localStorage?.getItem(PART_RESUME_KEY) || '[]');
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => typeof entry?.id === 'string' && typeof entry.partKey === 'string'
      && Number.isFinite(entry.position) && entry.position >= 0).slice(0, LIMIT);
  } catch (_) {
    return [];
  }
}

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
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const profile = readProfileStorage(storage);
    delete profile[PART_RESUME_KEY];
    const available = Math.min(MAX_BOOKMARKS_BYTES, MAX_PROFILE_BYTES - profileStorageSize(profile));
    const encoded = [];
    let size = 2;
    for (const entry of rest.slice(0, LIMIT)) {
      const value = JSON.stringify(entry);
      const bytes = utf8.encode(value).byteLength;
      if (bytes > MAX_BOOKMARK_BYTES) continue;
      const nextSize = size + bytes + (encoded.length ? 1 : 0);
      if (nextSize > available) break;
      encoded.push(value);
      size = nextSize;
    }
    // Keep the old bookmarks if even the new one alone cannot fit.
    if (!encoded.length && partKey) return;
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

export function clearPartResume() {
  generation += 1;
  try { globalThis.localStorage?.removeItem(PART_RESUME_KEY); } catch (_) {}
}
