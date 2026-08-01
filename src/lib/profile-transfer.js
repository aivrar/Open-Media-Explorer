/**
 * Browser storage belongs to a full origin, including localhost's port.  This
 * small authenticated handoff keeps the user profile available when the native
 * listener is intentionally moved to a different port.
 */

import { controlRequest } from './capture-client.js';
import { EQ_STORAGE_KEY } from './eq-store.js';

export const PROFILE_STORAGE_KEYS = Object.freeze([
  'worldmedia.favorites.v1',
  'worldmedia.settings.v1',
  'worldmedia.volume.v1',
  'worldmedia.jobs.v1',
  EQ_STORAGE_KEY,
]);

const PROFILE_ROUTE = '/api/v1/profile/preferences';
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const AUTO_SYNC_DELAY_MS = 350;

let automaticSyncTimer = null;

function resolveStorage(storage) {
  return storage || globalThis.localStorage;
}

function canUseNativeProfileService(requestImpl) {
  if (requestImpl !== controlRequest) return true;
  return /^https?:/.test(globalThis.location?.protocol || '');
}

function validValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  let total = 0;
  for (const key of PROFILE_STORAGE_KEYS) {
    const entry = value[key];
    if (typeof entry !== 'string') continue;
    const size = new TextEncoder().encode(entry).byteLength;
    if (size > MAX_PROFILE_BYTES || total + size > MAX_PROFILE_BYTES) continue;
    total += size;
    output[key] = entry;
  }
  return output;
}

/** Read the supported persistent app keys without parsing or altering them. */
export function captureProfileStorage(storage) {
  const selected = resolveStorage(storage);
  const output = {};
  try {
    for (const key of PROFILE_STORAGE_KEYS) {
      const value = selected?.getItem?.(key);
      if (typeof value === 'string') output[key] = value;
    }
  } catch (_) {
    // Browser privacy/storage failures must not interfere with the app itself.
  }
  return validValues(output);
}

/** Apply a server handoff only into a truly fresh localhost origin. */
export function restoreProfileStorageValues(values, storage) {
  const selected = resolveStorage(storage);
  const safeValues = validValues(values);
  if (Object.keys(captureProfileStorage(selected)).length > 0) return false;
  if (Object.keys(safeValues).length === 0) return false;
  try {
    for (const [key, value] of Object.entries(safeValues)) selected?.setItem?.(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

/** Save the exact profile before Settings changes the next-launch port. */
export async function saveProfileHandoff(options = {}) {
  const {
    storage,
    requestImpl = controlRequest,
    ...requestOptions
  } = options;
  const values = captureProfileStorage(storage);
  if (!canUseNativeProfileService(requestImpl)) return { saved: false, values };
  await requestImpl(PROFILE_ROUTE, {
    ...requestOptions,
    method: 'POST',
    body: { values },
  });
  return { saved: true, values };
}

/**
 * Keep a small native copy current during normal use as well as immediately
 * before an intentional port change.  That also covers a rare automatic
 * fallback when the preferred localhost port is already occupied.
 */
export function scheduleProfileHandoff(options = {}) {
  const { delayMs = AUTO_SYNC_DELAY_MS, ...requestOptions } = options;
  if (!canUseNativeProfileService(controlRequest)) return false;
  if (automaticSyncTimer !== null) return true;
  const schedule = globalThis.setTimeout;
  if (typeof schedule !== 'function') {
    void saveProfileHandoff(requestOptions).catch(() => {});
    return true;
  }
  automaticSyncTimer = schedule(() => {
    automaticSyncTimer = null;
    void saveProfileHandoff(requestOptions).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
  return true;
}

/** Prevent a queued old-profile save from following a deliberate cache reset. */
export function cancelScheduledProfileHandoff() {
  if (automaticSyncTimer === null) return;
  globalThis.clearTimeout?.(automaticSyncTimer);
  automaticSyncTimer = null;
}

/** Restore the previous origin's handoff before state.js reads localStorage. */
export async function restoreProfileHandoff(options = {}) {
  const {
    storage,
    requestImpl = controlRequest,
    ...requestOptions
  } = options;
  const selected = resolveStorage(storage);
  if (Object.keys(captureProfileStorage(selected)).length > 0) return false;
  if (!canUseNativeProfileService(requestImpl)) return false;
  try {
    const data = await requestImpl(PROFILE_ROUTE, requestOptions);
    return restoreProfileStorageValues(data?.values, selected);
  } catch (_) {
    return false;
  }
}

/** A deliberate cache reset must not be resurrected after a port change. */
export async function clearProfileHandoff(options = {}) {
  const { requestImpl = controlRequest, ...requestOptions } = options;
  if (!canUseNativeProfileService(requestImpl)) return false;
  await requestImpl(PROFILE_ROUTE, {
    ...requestOptions,
    method: 'POST',
    body: { values: {} },
  });
  return true;
}
