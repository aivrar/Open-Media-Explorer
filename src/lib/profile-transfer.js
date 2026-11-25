/**
 * Browser storage belongs to a full origin, including localhost's port.  This
 * small authenticated handoff keeps the user profile available when the native
 * listener is intentionally moved to a different port.
 */

import { controlRequest } from './capture-client.js';
import { EQ_STORAGE_KEY, MAX_PROFILE_BYTES, PROFILE_STORAGE_KEYS, profileStorageSize, readProfileStorage } from './profile-storage.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';

export { PROFILE_STORAGE_KEYS } from './profile-storage.js';

/** The keys every release up to 0.1.8 knows. Only these decide whether this
 *  origin already holds a profile, exactly as in 0.1.8: a newer key on its own
 *  (categories left behind by an older build's Clear cache, or a partial
 *  restore) does not, so the data folder copy is still restored. */
export const LEGACY_PROFILE_STORAGE_KEYS = Object.freeze([
  'worldmedia.favorites.v1',
  'worldmedia.settings.v1',
  'worldmedia.volume.v1',
  'worldmedia.jobs.v1',
  EQ_STORAGE_KEY,
]);

/** The keys the data folder keeps a second copy of, because releases 0.1.9 to
 *  0.1.11 drop them from the extra file (worldmedia_runtime
 *  PROFILE_TRANSFER_COPY_KEYS). */
export const PROFILE_COPY_KEYS = Object.freeze([
  'worldmedia.favnames.v1',
  'worldmedia.ownstream.v1',
]);

/*
 * Write order, enforced by the server (worldmedia_runtime.save_profile_transfer):
 * every write carries this page's random id and a number that only goes up. A
 * write that gave up on its timeout may still reach the server later; the
 * server then finds a higher number already applied for this page and answers
 * "superseded" without touching the files, so it can never bring back data a
 * later save or Clear cache replaced. The body format is unchanged.
 */
export const PROFILE_WRITER_HEADER = 'X-WorldMedia-Profile-Writer';
export const PROFILE_SEQUENCE_HEADER = 'X-WorldMedia-Profile-Sequence';

function newWriterId() {
  const bytes = new Uint8Array(16);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch (_) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PAGE_WRITER_ID = newWriterId();
let profileWriteSequence = 0;

/** The order headers for the next profile write from this page. */
function nextWriteHeaders() {
  profileWriteSequence += 1;
  return { [PROFILE_WRITER_HEADER]: PAGE_WRITER_ID, [PROFILE_SEQUENCE_HEADER]: String(profileWriteSequence) };
}

const PROFILE_ROUTE = '/api/v1/profile/preferences';
const AUTO_SYNC_DELAY_MS = 350;
const STARTUP_RESTORE_RETRY_MS = 1_000;
/** Longest one profile request may take before it counts as failed. */
export const PROFILE_REQUEST_TIMEOUT_MS = 10_000;

let automaticSyncTimer = null;
let startupRestore = null;

// An automatic save that fails or times out is tried once more, quietly,
// after this long; the notice is shown only when that try fails too. (On a
// first launch the save can wait behind the slow first catalogue load.)
export const AUTO_SYNC_RETRY_MS = 5_000;
let quietRetryTimer = null;
// Cancelling (Clear cache, a backup, a port change) moves the generation on:
// an automatic save that started before and fails afterwards schedules no
// retry and shows no notice. While an operation has retries suspended
// (suspendProfileRetries) none is scheduled either.
let retryGeneration = 0;
let retriesSuspended = 0;

/** A profile write that failed or was stopped; `code` tells the cases apart. */
export class ProfileWriteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProfileWriteError';
    this.code = code;
  }
}

/*
 * Every write of the native profile copy goes through this one queue: one
 * request in flight at a time, each sending the values current when it starts,
 * and none waiting longer than PROFILE_REQUEST_TIMEOUT_MS. Saves that arrive
 * while one is in flight share the single next save, so an older copy can never
 * land after a newer one and no change is lost. A save waiter is only ever
 * settled by a save. A clear (Clear cache) replaces saves still waiting their
 * turn, because they would only write data the user just removed; their callers
 * are told so instead of being given a cleared result.
 */
let profileWriteInFlight = false;
const pendingProfileWrites = [];

function supersededError() {
  return new ProfileWriteError(
    'Your saved data was cleared before it could be saved. Try again.',
    'PROFILE_SAVE_SUPERSEDED',
  );
}

function queueProfileWrite(kind, run) {
  return new Promise((resolve, reject) => {
    if (kind === 'clear') {
      for (let index = pendingProfileWrites.length - 1; index >= 0; index -= 1) {
        const job = pendingProfileWrites[index];
        if (job.kind !== 'save') continue;
        pendingProfileWrites.splice(index, 1);
        for (const waiter of job.waiters) waiter.reject(supersededError());
      }
    }
    const last = pendingProfileWrites[pendingProfileWrites.length - 1];
    if (last?.kind === kind) {
      last.run = run; // The newest request decides how the shared write is sent.
      last.waiters.push({ resolve, reject });
    } else {
      pendingProfileWrites.push({ kind, run, waiters: [{ resolve, reject }] });
    }
    startNextProfileWrite();
  });
}

function startNextProfileWrite() {
  if (profileWriteInFlight || pendingProfileWrites.length === 0) return;
  const { run, waiters } = pendingProfileWrites.shift();
  profileWriteInFlight = true;
  let attempt;
  try {
    attempt = Promise.resolve(run());
  } catch (error) {
    attempt = Promise.reject(error);
  }
  attempt.then(
    (result) => { for (const waiter of waiters) waiter.resolve(result); },
    (error) => { for (const waiter of waiters) waiter.reject(error); },
  ).finally(() => {
    profileWriteInFlight = false;
    startNextProfileWrite();
  });
}

/** Send one profile request, giving up (and aborting it) after the timeout. */
function sendProfileRequest(requestImpl, requestOptions, body) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const callerSignal = requestOptions.signal;
  if (controller && callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener?.('abort', () => controller.abort(), { once: true });
  }
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = globalThis.setTimeout?.(() => {
      controller?.abort();
      reject(new ProfileWriteError('Saving your profile took too long and was stopped.', 'PROFILE_WRITE_TIMEOUT'));
    }, PROFILE_REQUEST_TIMEOUT_MS) ?? null;
  });
  const request = Promise.resolve().then(() => requestImpl(PROFILE_ROUTE, {
    ...requestOptions,
    ...(controller ? { signal: controller.signal } : {}),
    headers: { ...(requestOptions.headers || {}), ...nextWriteHeaders() },
    // Its own connection: never queued behind a slow catalogue load in the
    // browser, so the time limit measures the save (capture-client.js).
    ownConnection: true,
    method: 'POST',
    body,
  }));
  return Promise.race([request, timedOut]).finally(() => {
    if (timer !== null) globalThis.clearTimeout?.(timer);
  });
}

async function syncAutomatically(options, { quietRetry = true } = {}) {
  const generation = retryGeneration;
  try {
    await saveProfileHandoff(options);
    if (quietRetry && quietRetryTimer !== null) {
      // A later automatic save worked: the retry waiting is not needed.
      globalThis.clearTimeout?.(quietRetryTimer);
      quietRetryTimer = null;
    }
    clearPersistenceFailure('profile-backup');
  } catch (error) {
    // A save replaced by Clear cache did not fail; there is nothing to report.
    if (error?.code === 'PROFILE_SAVE_SUPERSEDED') return;
    // Cancelled while it was being sent, or an operation that writes the
    // profile itself is running: that operation decides, nothing is retried.
    if (generation !== retryGeneration || retriesSuspended > 0) return;
    const schedule = globalThis.setTimeout;
    if (quietRetry && typeof schedule === 'function') {
      // One more try, without a notice; one retry waiting is enough.
      if (quietRetryTimer === null) {
        quietRetryTimer = schedule(() => {
          quietRetryTimer = null;
          void syncAutomatically(options, { quietRetry: false });
        }, AUTO_SYNC_RETRY_MS);
      }
      return;
    }
    reportPersistenceFailure('profile-backup', 'The portable profile backup could not be updated. Keep using the same port and back up your data folder before moving the app. Your existing saved browser data has not been deleted.');
  }
}

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
  for (const key of PROFILE_STORAGE_KEYS) {
    if (typeof value[key] === 'string') output[key] = value[key];
  }
  if (profileStorageSize(output) > MAX_PROFILE_BYTES) {
    throw new Error('Profile backup is too large. Port change cancelled to protect your saved data.');
  }
  return output;
}

/** Read the supported persistent app keys without parsing or altering them. */
export function captureProfileStorage(storage) {
  return validValues(readProfileStorage(resolveStorage(storage)));
}

/** True when this origin already holds a profile: any of the legacy keys. */
export function hasLegacyProfile(storage) {
  const selected = resolveStorage(storage);
  if (typeof selected?.getItem !== 'function') throw new Error('Saved profile storage is unavailable.');
  return LEGACY_PROFILE_STORAGE_KEYS.some((key) => typeof selected.getItem(key) === 'string');
}

/** Apply a server handoff only into an origin without a profile of its own
 *  (none of the legacy keys). The data folder copy wins for every key it has,
 *  newer keys included: categories already in this origin are replaced by the
 *  data folder's, and kept only when the data folder has none. */
export function restoreProfileStorageValues(values, storage) {
  const selected = resolveStorage(storage);
  const previous = new Map();
  try {
    const safeValues = validValues(values);
    if (hasLegacyProfile(selected)) return false;
    if (Object.keys(safeValues).length === 0 || typeof selected?.setItem !== 'function') return false;
    for (const [key, value] of Object.entries(safeValues)) {
      previous.set(key, selected.getItem(key));
      selected.setItem(key, value);
    }
    return true;
  } catch (_) {
    // Leave the origin as it was (and retryable) if a quota/storage error
    // interrupts the restore.
    for (const [key, value] of previous) {
      try {
        if (typeof value === 'string') selected.setItem(key, value);
        else selected.removeItem(key);
      } catch (_) { /* Storage may be unavailable. */ }
    }
    return false;
  }
}

/** One write of the current profile; it reads the values when it starts. */
async function writeProfileNow(options) {
  const {
    storage,
    requestImpl = controlRequest,
    ...requestOptions
  } = options;
  const values = captureProfileStorage(storage);
  if (!canUseNativeProfileService(requestImpl)) return { saved: false, values };
  const data = await sendProfileRequest(requestImpl, requestOptions, { values });
  // "Superseded": a later write from this page is already on disk. Done.
  return { saved: true, superseded: data?.superseded === true, values };
}

/** Save the exact profile (through the write queue) and resolve once a save
 *  that started after this call has finished. Used before a port change. */
export function saveProfileHandoff(options = {}) {
  return queueProfileWrite('save', () => writeProfileNow(options));
}

/**
 * Keep a small native copy current during normal use as well as immediately
 * before an intentional port change.  That also covers a rare automatic
 * fallback when the preferred localhost port is already occupied.
 */
export function scheduleProfileHandoff(options = {}) {
  const { delayMs = AUTO_SYNC_DELAY_MS, ...requestOptions } = options;
  if (startupRestore || !canUseNativeProfileService(controlRequest)) return false;
  if (automaticSyncTimer !== null) return true;
  const schedule = globalThis.setTimeout;
  if (typeof schedule !== 'function') {
    void syncAutomatically(requestOptions);
    return true;
  }
  automaticSyncTimer = schedule(() => {
    automaticSyncTimer = null;
    void syncAutomatically(requestOptions);
  }, Math.max(0, Number(delayMs) || 0));
  return true;
}

/**
 * Save the profile now and wait until the native copy has it, for a backup.
 * The write goes through the same queue as every other save, so it starts
 * after any save already being sent and carries the values current at that
 * moment; a change made meanwhile is either in it or saved by a later write.
 * A pending debounced save is folded into this one. Rejects when the write
 * fails or times out, or when Clear cache replaces it; it always settles within
 * two request timeouts (one save already in flight, then its own).
 */
export async function flushProfileHandoff(options = {}) {
  const resume = suspendProfileRetries();
  let failed = null;
  try {
    const result = await saveProfileHandoff(options);
    if (result.saved) clearPersistenceFailure('profile-backup');
    return result;
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    resume();
    // Keep the normal background save (and its notice) after a failed flush;
    // after Clear cache there is nothing left to retry.
    if (failed && failed?.code !== 'PROFILE_SAVE_SUPERSEDED' && retriesSuspended === 0) scheduleProfileHandoff();
  }
}

/** For an operation that writes the profile itself (a backup, a port change):
 *  cancels a waiting retry and schedules none until the returned function is
 *  called (once, when the operation ends). */
export function suspendProfileRetries() {
  cancelScheduledProfileHandoff();
  retriesSuspended += 1;
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    retriesSuspended = Math.max(0, retriesSuspended - 1);
  };
}

/** Prevent a queued old-profile save from following a deliberate cache reset.
 *  A save already being sent that fails later schedules nothing. */
export function cancelScheduledProfileHandoff() {
  retryGeneration += 1;
  if (quietRetryTimer !== null) {
    globalThis.clearTimeout?.(quietRetryTimer);
    quietRetryTimer = null;
  }
  if (automaticSyncTimer === null) return;
  globalThis.clearTimeout?.(automaticSyncTimer);
  automaticSyncTimer = null;
}

/** In an origin that has a profile of its own, set only the keys the server
 *  says came from the data folder's second copy (`copied`) and that this
 *  origin lacks. That is the case after an older release moved the port: it
 *  restored the favorites here but not the names it does not know. A key the
 *  extra file holds is never reported as copied, and a key this origin has is
 *  never replaced. */
function restoreCopiedProfileOutcome(values, copied, selected) {
  if (!Array.isArray(copied)) return 'nothing';
  const set = [];
  try {
    const safeValues = validValues(values);
    for (const key of PROFILE_COPY_KEYS) {
      if (!copied.includes(key) || typeof safeValues[key] !== 'string') continue;
      if (typeof selected.getItem(key) === 'string') continue;
      selected.setItem(key, safeValues[key]);
      set.push(key);
    }
    return set.length > 0 ? 'restored' : 'nothing';
  } catch (_) {
    for (const key of set) {
      try { selected.removeItem(key); } catch (_) { /* Storage may be unavailable. */ }
    }
    return 'failed';
  }
}

export function restoreCopiedProfileValues(values, copied, storage) {
  return restoreCopiedProfileOutcome(values, copied, resolveStorage(storage)) === 'restored';
}

/** Restore the previous origin's handoff before state.js reads localStorage.
 *  An origin with a profile of its own only takes copied keys it lacks (see
 *  restoreCopiedProfileValues); when it has them all, nothing is asked. */
export async function restoreProfileHandoff(options = {}) {
  return (await restoreProfileHandoffOutcome(options)) === 'restored';
}

function plainValues(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * restoreProfileHandoff, telling how it ended:
 * - 'restored': values from the data folder were written to this page;
 * - 'nothing': the data folder answered and there was nothing to take (or
 *   nothing needed asking);
 * - 'failed': the data folder could not be asked or read (a network error, an
 *   error answer, an unreadable answer) or the values could not be written;
 *   what is in this page may then be only part of the profile;
 * - 'skipped': no local server to ask (the page opened from a file).
 */
export async function restoreProfileHandoffOutcome(options = {}) {
  const {
    storage,
    requestImpl = controlRequest,
    ...requestOptions
  } = options;
  if (!canUseNativeProfileService(requestImpl)) return 'skipped';
  try {
    const selected = resolveStorage(storage);
    if (hasLegacyProfile(selected)) {
      if (PROFILE_COPY_KEYS.every((key) => typeof selected.getItem(key) === 'string')) return 'nothing';
      const data = await requestImpl(PROFILE_ROUTE, requestOptions);
      if (!plainValues(data?.values)) return 'failed';
      return restoreCopiedProfileOutcome(data.values, data.copied, selected);
    }
    const data = await requestImpl(PROFILE_ROUTE, requestOptions);
    if (!plainValues(data?.values)) return 'failed';
    let safeValues;
    try { safeValues = validValues(data.values); } catch (_) { return 'failed'; }
    if (Object.keys(safeValues).length === 0) return 'nothing';
    return restoreProfileStorageValues(data.values, selected) ? 'restored' : 'failed';
  } catch (_) {
    return 'failed';
  }
}

/** Keep startup and automatic writes waiting while the disk copy is unreadable. */
export function restoreStartupProfileHandoff() {
  if (startupRestore) return startupRestore;
  cancelScheduledProfileHandoff();
  startupRestore = (async () => {
    while (await restoreProfileHandoffOutcome() === 'failed') {
      reportPersistenceFailure('profile-restore', 'Could not restore your saved profile. Retrying.');
      await new Promise((resolve) => setTimeout(resolve, STARTUP_RESTORE_RETRY_MS));
    }
  })().finally(() => {
    clearPersistenceFailure('profile-restore');
    startupRestore = null;
  });
  return startupRestore;
}

/** A deliberate cache reset must not be resurrected after a port change. */
export async function clearProfileHandoff(options = {}) {
  const { requestImpl = controlRequest, ...requestOptions } = options;
  if (!canUseNativeProfileService(requestImpl)) return false;
  // Queued like every write, so an older save still being sent cannot land after
  // it; saves still waiting their turn are dropped. Rejects if not acknowledged.
  await queueProfileWrite('clear', async () => {
    await sendProfileRequest(requestImpl, requestOptions, { values: {} });
    return { cleared: true };
  });
  return true;
}
