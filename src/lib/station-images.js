/**
 * The user's own station pictures: the station-images folder in the data
 * folder (worldmedia_station_images.py).
 *
 * The backend lists the pictures by normalized name. A picture is shown for
 * any item whose title normalizes to the same name, in place of its own
 * artwork (artwork.js decides; every view goes through it). The list is
 * fetched once at startup and again when the user presses Refresh in
 * Settings. A picture is fetched with the session token like every control
 * request and shown through an object URL; the page never sees a file path,
 * and nothing about it is saved in the profile.
 *
 * Matching rule (the same as normalize_station_name in Python; the shared
 * cases are in tests/fixtures/station-image-names.json): Unicode NFKC, every
 * kind of whitespace becomes a space, the characters Windows forbids in file
 * names and control characters are removed, lower case, runs of spaces become
 * one, and leading or trailing spaces and trailing dots are removed.
 */

import { controlRequest, getControlSession, resetControlSession } from './capture-client.js';

export const STATION_IMAGES_ROUTE = '/api/v1/station-images';
export const STATION_IMAGES_OPEN_ROUTE = '/api/v1/station-images/open-folder';
export const STATION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const STATION_IMAGES_HINT = 'Put a picture in this folder named exactly like the station, '
  + 'for example Radio Paradise.png. PNG, JPG, WebP or GIF, up to 2 MB each.';

const SOURCE_PREFIX = 'station-image:';
const SOURCE_PATTERN = /^station-image:([0-9a-f]{32}):([0-9a-f]{1,32})$/;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const STAMP_PATTERN = /^[0-9a-f]{1,32}$/;
// Longer names can never match: Windows file names are at most 255 units long.
const MAX_NAME_INPUT = 1024;
const MAX_OBJECT_URLS = 256;
const MAX_REMEMBERED_TITLES = 5000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SPACES = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const DROPPED = /[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/g;
const SPACE_RUNS = / {2,}/g;

/** The text a station's name is compared by; '' when it can never match. */
export function normalizeStationName(value) {
  if (typeof value !== 'string' || value.length > MAX_NAME_INPUT) return '';
  return value.normalize('NFKC')
    .replace(SPACES, ' ')
    .replace(DROPPED, '')
    .toLowerCase()
    .replace(SPACE_RUNS, ' ')
    .replace(/^ +| +$/g, '')
    .replace(/[. ]+$/, '');
}

let index = { version: '', folder: '', loaded: false, byKey: new Map() };
const failed = new Set();
const listeners = new Set();
// source -> { promise, url }, oldest first.
const objectUrls = new Map();
const titleKeys = new Map();
let loading = null;

/** Called whenever the pictures that apply to items change. */
export function onStationImagesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of [...listeners]) {
    try { listener(); } catch (error) { console.error('station pictures listener threw:', error); }
  }
}

function releaseObjectUrl(source, revoke = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)) {
  const entry = objectUrls.get(source);
  if (!entry) return;
  objectUrls.delete(source);
  if (entry.url) {
    try { revoke?.(entry.url); } catch (_) { /* already gone */ }
  }
  entry.released = true;
}

/** Take in the backend's list. Returns true when the pictures changed.
 *  `retryFailed` (a fresh load: startup or Refresh) forgets which pictures
 *  failed to load, so a picture that failed once for a passing reason is
 *  tried again even when the list names it unchanged. */
export function applyStationImageList(data, { retryFailed = false } = {}) {
  const byKey = new Map();
  for (const entry of Array.isArray(data?.images) ? data.images : []) {
    const key = entry?.key;
    if (typeof key !== 'string' || !key || key.length > MAX_NAME_INPUT || byKey.has(key)) continue;
    if (!ID_PATTERN.test(String(entry.id)) || !STAMP_PATTERN.test(String(entry.v))) continue;
    byKey.set(key, `${SOURCE_PREFIX}${entry.id}:${entry.v}`);
  }
  let changed = byKey.size !== index.byKey.size
    || [...byKey].some(([key, source]) => index.byKey.get(key) !== source);
  index = {
    version: typeof data?.version === 'string' ? data.version.slice(0, 64) : '',
    folder: typeof data?.folder === 'string' ? data.folder : '',
    loaded: true,
    byKey,
  };
  const current = new Set(byKey.values());
  for (const source of [...objectUrls.keys()]) if (!current.has(source)) releaseObjectUrl(source);
  for (const source of [...failed]) {
    if (current.has(source) && !retryFailed) continue;
    failed.delete(source);
    // Items that had gone back to their own artwork take the picture again.
    if (current.has(source)) changed = true;
  }
  if (changed) notify();
  return changed;
}

/** What the last list said, for Settings. */
export function stationImagesSnapshot() {
  return { loaded: index.loaded, folder: index.folder, version: index.version, count: index.byKey.size };
}

function keyForTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  let key = titleKeys.get(title);
  if (key === undefined) {
    if (titleKeys.size >= MAX_REMEMBERED_TITLES) titleKeys.clear();
    key = normalizeStationName(title);
    titleKeys.set(title, key);
  }
  return key;
}

/** The user's picture for an item ('station-image:<id>:<stamp>'), or ''.
 *  Costs nothing when there are no pictures. */
export function stationImageSourceFor(item) {
  if (index.byKey.size === 0 || !item || typeof item !== 'object' || item.__contentHidden === true) return '';
  const key = keyForTitle(item.title);
  const source = key ? index.byKey.get(key) || '' : '';
  return source && !failed.has(source) ? source : '';
}

export function isStationImageSource(value) {
  return typeof value === 'string' && SOURCE_PATTERN.test(value);
}

/** A picture that would not load: its items go back to their own artwork
 *  until the list is loaded again (Refresh) or the file is replaced. */
export function markStationImageFailed(source) {
  if (!isStationImageSource(source) || failed.has(source)) return;
  failed.add(source);
  releaseObjectUrl(source);
  notify();
}

/** The object URL of a picture already fetched, or ''. */
export function peekStationImageUrl(source) {
  return objectUrls.get(source)?.url || '';
}

function requestError(message, status = 0, code = 'STATION_IMAGE_FAILED') {
  const error = new Error(message);
  error.name = 'StationImageError';
  error.status = status;
  error.code = code;
  return error;
}

function abortError(reason) {
  if (reason?.name === 'AbortError') return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'The station picture is no longer wanted.');
  error.name = 'AbortError';
  return error;
}

async function fetchStationImage(source, { fetchImpl = globalThis.fetch, sleep, signal } = {}) {
  const id = SOURCE_PATTERN.exec(source)[1];
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Stopped (nobody waits for it any more): no further request or retry.
  const check = () => { if (signal?.aborted) throw abortError(signal.reason); };
  for (let attempt = 0; ; attempt += 1) {
    check();
    const session = await getControlSession({ fetchImpl });
    check();
    const response = await fetchImpl(`${STATION_IMAGES_ROUTE}/${id}`, {
      method: 'GET',
      headers: { 'X-WorldMedia-Token': session.token },
      credentials: 'same-origin',
      // Always ask again: a replaced file keeps its address, and the ETag
      // makes an unchanged one cheap.
      cache: 'no-cache',
      ...(signal ? { signal } : {}),
    });
    check();
    if (response.ok) {
      const type = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) throw requestError('The station picture is not an image.', response.status);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > STATION_IMAGE_MAX_BYTES) {
        throw requestError('The station picture is too large.', response.status);
      }
      const blob = await response.blob();
      if (!blob || blob.size <= 0 || blob.size > STATION_IMAGE_MAX_BYTES) {
        throw requestError('The station picture is empty or too large.', response.status);
      }
      return blob.type === type ? blob : new Blob([blob], { type });
    }
    try { await response.body?.cancel?.(); } catch (_) { /* nothing to read */ }
    // A new session after a restart, or a briefly busy server, gets one more try.
    if (response.status === 403) resetControlSession();
    const retry = (response.status === 403 && attempt === 0)
      || ((response.status === 429 || response.status === 503) && attempt < 2);
    if (!retry) throw requestError('The station picture could not be loaded.', response.status);
    await wait(150 * (attempt + 1));
  }
}

/** The caller's own view of a shared fetch. With `signal`, the caller can
 *  stop waiting: it is answered with an AbortError at once and a late result
 *  is never handed to it. When every caller that asked has stopped (and none
 *  asked without a signal, like the player bar), the fetch itself stops too,
 *  with no further retry, and is forgotten so a later request starts fresh. */
function waitForEntry(source, entry, signal) {
  if (!signal) {
    entry.held = true;
    return entry.promise;
  }
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  if (entry.url) return entry.promise;
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return false;
      settled = true;
      entry.waiters -= 1;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (!entry.held && entry.waiters <= 0 && !entry.url) {
        entry.controller.abort();
        if (objectUrls.get(source) === entry) objectUrls.delete(source);
      }
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then((url) => { if (leave()) resolve(url); }, (error) => { if (leave()) reject(error); });
  });
}

/** An object URL for a picture, fetched once and shared by every view.
 *  `options.signal` lets a caller stop waiting (see waitForEntry). */
export function stationImageUrl(source, options = {}) {
  if (!isStationImageSource(source)) return Promise.reject(requestError('Not a station picture.'));
  const { signal, ...fetchOptions } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  const cached = objectUrls.get(source);
  if (cached) {
    objectUrls.delete(source);
    objectUrls.set(source, cached);
    return waitForEntry(source, cached, signal);
  }
  const createUrl = fetchOptions.createUrl || globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const controller = new AbortController();
  const entry = { url: '', promise: null, released: false, held: false, waiters: 0, controller };
  entry.promise = fetchStationImage(source, { ...fetchOptions, signal: controller.signal }).then((blob) => {
    // Stopped while the bytes arrived: no object URL is made for nobody.
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    const url = createUrl(blob);
    entry.url = url;
    if (entry.released) {
      // Dropped while it was on its way: whoever asked still gets it, briefly.
      setTimeout(() => { try { globalThis.URL?.revokeObjectURL?.(url); } catch (_) {} }, 60_000);
    }
    return url;
  }, (error) => {
    if (objectUrls.get(source) === entry) objectUrls.delete(source);
    throw error;
  });
  // A fetch stopped because nobody waits for it has nobody to tell.
  entry.promise.catch(() => {});
  objectUrls.set(source, entry);
  while (objectUrls.size > MAX_OBJECT_URLS) releaseObjectUrl(objectUrls.keys().next().value);
  return waitForEntry(source, entry, signal);
}

/** Ask the backend for the list (it scans the folder) and take it in. */
export function loadStationImages({ request = controlRequest } = {}) {
  if (loading) return loading;
  loading = Promise.resolve()
    .then(() => request(STATION_IMAGES_ROUTE))
    .then((data) => {
      applyStationImageList(data, { retryFailed: true });
      return data;
    })
    .finally(() => { loading = null; });
  return loading;
}

export function openStationImagesFolder({ request = controlRequest } = {}) {
  return request(STATION_IMAGES_OPEN_ROUTE, { method: 'POST', body: {} });
}

function count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/** One plain line, e.g. "12 pictures found. 1 ignored: too large." */
export function stationImagesStatusText(data) {
  if (typeof data?.problem === 'string' && data.problem.trim()) return data.problem.trim();
  if (data?.exists === false) return 'There is no station-images folder yet. Open folder makes it.';
  const found = count(data?.found);
  let text = found ? `${found} ${found === 1 ? 'picture' : 'pictures'} found.` : 'No pictures found.';
  const ignored = count(data?.ignored);
  if (ignored) {
    const reasons = (Array.isArray(data.ignored_reasons) ? data.ignored_reasons : [])
      .filter((reason) => typeof reason?.text === 'string' && reason.text && count(reason.count));
    const detail = reasons.length === 1
      ? reasons[0].text
      : reasons.map((reason) => `${count(reason.count)} ${reason.text}`).join(', ');
    text += ` ${ignored} ignored${detail ? `: ${detail}` : ''}.`;
  }
  return text;
}

function failureReason(error, fallback) {
  const reason = typeof error?.message === 'string' ? error.message.trim() : '';
  return reason || fallback;
}

/** Wire the Station images block in Settings. All text is plain text. */
export function bindStationImageControls({
  path, status, openButton, refreshButton,
  load = loadStationImages, openFolder = openStationImagesFolder, isDisposed = () => false,
}) {
  function show(text, state) {
    status.textContent = text;
    status.dataset.state = state;
  }
  function showFolder(folder) {
    if (typeof folder === 'string' && folder) path.textContent = folder;
  }

  const known = stationImagesSnapshot();
  if (known.folder) {
    showFolder(known.folder);
  } else {
    path.textContent = 'Checking\u2026';
    void Promise.resolve().then(() => load()).then((data) => {
      if (!isDisposed()) showFolder(data?.folder);
    }).catch(() => {
      if (!isDisposed() && !stationImagesSnapshot().folder) path.textContent = 'Unavailable';
    });
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    show('Checking the folder\u2026', 'checking');
    try {
      const data = await load();
      if (isDisposed()) return;
      showFolder(data?.folder);
      show(stationImagesStatusText(data), data?.problem ? 'error' : 'ready');
    } catch (error) {
      if (isDisposed()) return;
      show(`The folder could not be checked: ${failureReason(error, 'it is not available.')}`, 'error');
    } finally {
      refreshing = false;
      if (!isDisposed()) refreshButton.disabled = false;
    }
  }

  async function open() {
    openButton.disabled = true;
    try {
      const data = await openFolder();
      if (isDisposed()) return;
      showFolder(data?.path);
    } catch (error) {
      if (isDisposed()) return;
      show(`The folder could not be opened: ${failureReason(error, 'it is not available.')}`, 'error');
    } finally {
      if (!isDisposed()) openButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => { void refresh(); });
  openButton.addEventListener('click', () => { void open(); });
  return { refresh, open };
}
