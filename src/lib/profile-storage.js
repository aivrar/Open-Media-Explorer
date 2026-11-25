export const EQ_STORAGE_KEY = 'worldmedia.eq.v1';
export const EQ_EXTRA_STORAGE_KEY = 'worldmedia.eq-extra.v1';
export const PICTURE_STORAGE_KEY = 'worldmedia.picture.v1';

export const PROFILE_STORAGE_KEYS = Object.freeze([
  'worldmedia.favorites.v1',
  'worldmedia.settings.v1',
  'worldmedia.volume.v1',
  'worldmedia.jobs.v1',
  EQ_STORAGE_KEY,
  EQ_EXTRA_STORAGE_KEY,
  PICTURE_STORAGE_KEY,
  'worldmedia.favgroups.v1', // Favorites categories (lib/favorite-groups.js)
  'worldmedia.favnames.v1', // The user's names for favorites (lib/favorite-names.js)
  'worldmedia.ownstream.v1', // Stations kept on their own stream (lib/stream-verify.js)
  'worldmedia.stationstreams.v1', // Main and backup addresses for saved stations
  'worldmedia.partresume.v1', // Playback position for chapters and tracks
]);

export const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

export function profileStorageSize(values) {
  const utf8 = new TextEncoder();
  let total = 0;
  for (const key of PROFILE_STORAGE_KEYS) {
    if (typeof values[key] === 'string') total += utf8.encode(values[key]).byteLength;
  }
  return total;
}

export function readProfileStorage(storage) {
  if (typeof storage?.getItem !== 'function') throw new Error('Saved profile storage is unavailable.');
  const values = {};
  for (const key of PROFILE_STORAGE_KEYS) {
    const value = storage.getItem(key);
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

export class ProfileStorageBudgetError extends Error {
  constructor() {
    super('Saved profile is full. Remove some saved items and try again.');
  }
}

export function checkProfileStorageBudget(storage, writes) {
  const current = readProfileStorage(storage);
  const proposed = { ...current, ...Object.fromEntries(writes) };
  const size = profileStorageSize(proposed);
  // Let an already oversized profile be reduced in several edits if needed.
  if (size > MAX_PROFILE_BYTES && size >= profileStorageSize(current)) {
    throw new ProfileStorageBudgetError();
  }
}
