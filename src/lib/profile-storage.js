export const EQ_STORAGE_KEY = 'worldmedia.eq.v1';
export const EQ_EXTRA_STORAGE_KEY = 'worldmedia.eq-extra.v1';
export const EXTRA_SETTINGS_STORAGE_KEY = 'worldmedia.settings-extra.v1';
export const PICTURE_STORAGE_KEY = 'worldmedia.picture.v1';
export const STATION_IMAGE_OWNERS_KEY = 'worldmedia.stationimageowners.v1';

export const PROFILE_STORAGE_KEYS = Object.freeze([
  'worldmedia.favorites.v1',
  'worldmedia.settings.v1',
  EXTRA_SETTINGS_STORAGE_KEY,
  'worldmedia.volume.v1',
  'worldmedia.jobs.v1',
  EQ_STORAGE_KEY,
  EQ_EXTRA_STORAGE_KEY,
  PICTURE_STORAGE_KEY,
  STATION_IMAGE_OWNERS_KEY,
  'worldmedia.favgroups.v1', // Favorites categories (lib/favorite-groups.js)
  'worldmedia.favnames.v1', // The user's names for favorites (lib/favorite-names.js)
  'worldmedia.ownstream.v1', // Stations kept on their own stream (lib/stream-verify.js)
  'worldmedia.stationstreams.v1', // Main and backup addresses for saved stations
  'worldmedia.partresume.v1', // Playback position for chapters and tracks
]);

export const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

export const isComputerFavoriteId = (id) => typeof id === 'string' && id.startsWith('computer:') && id.length > 9;

/** Strip legacy local stars and the settings attached to them from portable values. */
export function portableProfileValue(key, raw) {
  if (typeof raw !== 'string' || !raw.includes('computer:')) return raw;
  try {
    const value = JSON.parse(raw);
    if (key === 'worldmedia.favorites.v1' && Array.isArray(value)) {
      const kept = value.filter((item) => !isComputerFavoriteId(item?.id));
      return kept.length === value.length ? raw : JSON.stringify(kept);
    }
    const maps = {
      [EQ_STORAGE_KEY]: [value?.favorites, value?.assignments],
      [EQ_EXTRA_STORAGE_KEY]: [value?.assignments, value?.q?.favorites],
      'worldmedia.favgroups.v1': [value?.assign],
      'worldmedia.favnames.v1': [value?.names],
    }[key];
    let changed = false;
    for (const map of maps || []) {
      for (const id of Object.keys(map || {})) {
        if (!isComputerFavoriteId(id)) continue;
        delete map[id];
        changed = true;
      }
    }
    return changed ? JSON.stringify(value) : raw;
  } catch {
    return raw;
  }
}

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
    if (typeof value === 'string') values[key] = portableProfileValue(key, value);
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
