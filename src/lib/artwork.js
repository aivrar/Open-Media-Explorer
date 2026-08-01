/**
 * One artwork boundary for every source and every view.
 *
 * Provider image URLs are catalog metadata, not display URLs.  They are
 * registered with the native backend, which performs the DNS/private-network
 * checks, and only the resulting opaque same-origin route may reach an <img>.
 */

import { registerCatalogAsset } from './catalog-client.js';
import { safeExternalUrl } from './item-model.js';
import { loadAdapter } from './sources.js';

export const ARTWORK_MAX_CONCURRENT = 12;
export const ARTWORK_MAX_ATTEMPTS = 3;
export const ARTWORK_RETRY_BASE_MS = 500;
export const ARTWORK_TASK_TIMEOUT_MS = 25_000;
// The backend has a finite number of artwork relay slots.  Queue actual image
// loads as well as artwork registrations so a newly visible card is never
// drowned out by hundreds of <img> requests from a discarded view.
export const ARTWORK_IMAGE_MAX_CONCURRENT = 8;
export const ARTWORK_IMAGE_MAX_ATTEMPTS = 3;
export const ARTWORK_IMAGE_RETRY_BASE_MS = 400;
export const PLAYBACK_ARTWORK_CONCURRENCY = 1;
export const PLAYBACK_ARTWORK_IMAGE_CONCURRENCY = 2;

const LOCAL_ASSET_RELAY = /^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/;

export function isArtworkRelayUrl(value) {
  return typeof value === 'string' && LOCAL_ASSET_RELAY.test(value.trim());
}

/** Canonicalize provider artwork metadata without ever attaching it to DOM. */
export function canonicalArtworkUrl(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate || candidate === 'null' || candidate === 'undefined') return '';
  return safeExternalUrl(candidate.startsWith('//') ? `https:${candidate}` : candidate);
}

/** Small priority queue shared by Library, Grid, Discovery, and the player. */
export function createTaskQueue(maxConcurrent = ARTWORK_MAX_CONCURRENT) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  let currentLimit = limit;
  const pending = [];
  let active = 0;
  let sequence = 0;

  const drain = () => {
      while (active < currentLimit && pending.length > 0) {
        const job = pending.shift();
        job.signal?.removeEventListener('abort', job.cancel);
        active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    setLimit(value) {
      currentLimit = Math.max(1, Math.min(limit, Number(value) || 1));
      drain();
    },
    enqueue(task, priority = 0, opts = {}) {
      return new Promise((resolve, reject) => {
        const signal = opts?.signal;
        let job;
        const cancel = () => {
          const index = pending.indexOf(job);
          if (index < 0) return;
          pending.splice(index, 1);
          signal?.removeEventListener('abort', cancel);
          reject(artworkAbortError(signal?.reason));
        };
        if (signal?.aborted) {
          reject(artworkAbortError(signal.reason));
          return;
        }
        job = {
          task,
          priority: Number(priority) || 0,
          sequence: sequence++,
          resolve,
          reject,
          signal,
          cancel,
        };
        signal?.addEventListener('abort', cancel, { once: true });
        pending.push(job);
        pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        drain();
      });
    },
    get activeCount() { return active; },
    get pendingCount() { return pending.length; },
    get limit() { return currentLimit; },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryArtworkLookup(task, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts || ARTWORK_MAX_ATTEMPTS));
  const baseMs = Math.max(0, Number(opts.baseMs ?? ARTWORK_RETRY_BASE_MS));
  const sleep = opts.sleep || delay;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const transient = error?.name !== 'AbortError'
        && (status === 0 || status === 408 || status === 429 || status >= 500);
      if (!transient) throw error;
      if (attempt + 1 < attempts) await sleep(baseMs * (2 ** attempt));
    }
  }
  throw lastError;
}

const artworkQueue = createTaskQueue();
const artworkImageQueue = createTaskQueue(ARTWORK_IMAGE_MAX_CONCURRENT);
const rawArtwork = new WeakMap();
const artworkChecked = new WeakMap();

/** Exported only for lifecycle assertions and the Library's session state. */
export const artworkRequests = new Map();

/** Keep visible artwork moving slowly while active media owns network priority. */
export function setArtworkPlaybackPriority(active) {
  artworkQueue.setLimit(active ? PLAYBACK_ARTWORK_CONCURRENCY : ARTWORK_MAX_CONCURRENT);
  artworkImageQueue.setLimit(
    active ? PLAYBACK_ARTWORK_IMAGE_CONCURRENCY : ARTWORK_IMAGE_MAX_CONCURRENT,
  );
}

function artworkAbortError(reason = 'Artwork resolution cancelled') {
  if (reason?.name === 'AbortError' || reason?.name === 'TimeoutError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

function imageLoadError(message = 'Artwork image could not load.') {
  const error = new Error(message);
  error.name = 'ArtworkImageError';
  return error;
}

function waitForArtworkImage(image, source, signal, requireConnected = true) {
  return new Promise((resolve, reject) => {
    if (!image || typeof image.addEventListener !== 'function') {
      reject(imageLoadError('Artwork image target is unavailable.'));
      return;
    }
    if (requireConnected && !image.isConnected) {
      reject(artworkAbortError('Artwork target left the view.'));
      return;
    }

    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(image);
    };
    const onLoad = () => {
      if (image.getAttribute('src') !== source) return;
      if (image.naturalWidth > 0) finish();
      else finish(imageLoadError('Artwork image decoded without pixels.'));
    };
    const onError = () => {
      if (image.getAttribute('src') !== source) return;
      finish(imageLoadError());
    };
    const onAbort = () => {
      if (image.getAttribute('src') === source) image.removeAttribute('src');
      finish(artworkAbortError(signal?.reason));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = source;
    // Cached images can complete before the browser dispatches a new event.
    queueMicrotask(() => {
      if (image.getAttribute('src') === source && image.complete) onLoad();
    });
  });
}

/**
 * Set a relay-backed image source through the shared bounded queue.
 * The caller owns the element and can abort its view scope at any time.
 */
export async function loadArtworkImage(image, relayUrl, opts = {}) {
  const source = typeof relayUrl === 'string' ? relayUrl.trim() : '';
  if (!isArtworkRelayUrl(source)) {
    throw imageLoadError('Artwork image source is not an opaque relay URL.');
  }
  const attempts = Math.max(1, Number(opts.attempts ?? ARTWORK_IMAGE_MAX_ATTEMPTS));
  const baseMs = Math.max(0, Number(opts.baseMs ?? ARTWORK_IMAGE_RETRY_BASE_MS));
  const signal = opts.signal;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw artworkAbortError(signal.reason);
    try {
      return await artworkImageQueue.enqueue(
        () => waitForArtworkImage(image, source, signal, opts.requireConnected !== false),
        opts.priority || 0,
        { signal },
      );
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || signal?.aborted || attempt + 1 >= attempts) break;
      await delay(baseMs * (2 ** attempt));
    }
  }
  throw lastError || imageLoadError();
}

async function runArtworkTask(task, opts = {}) {
  const timeoutMs = Math.max(0, Number(opts.taskTimeoutMs ?? ARTWORK_TASK_TIMEOUT_MS));
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => controller.abort(artworkAbortError(external.reason));
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  let timer = null;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => rejectCancellation(artworkAbortError(controller.signal.reason));
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0) {
    timer = (opts.setTimer || setTimeout)(() => {
      const error = typeof DOMException === 'function'
        ? new DOMException(`Artwork resolution timed out after ${timeoutMs} ms`, 'TimeoutError')
        : Object.assign(new Error(`Artwork resolution timed out after ${timeoutMs} ms`), { name: 'TimeoutError' });
      controller.abort(error);
    }, timeoutMs);
  }
  try {
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), cancellation]);
  } finally {
    if (timer != null) (opts.clearTimer || clearTimeout)(timer);
    controller.signal.removeEventListener('abort', onAbort);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

function captureProviderArtwork(item) {
  if (!item || typeof item !== 'object') return '';
  if (isArtworkRelayUrl(item.thumbnail)) return '';
  const candidate = canonicalArtworkUrl(item.thumbnail);
  if (item.thumbnail) item.thumbnail = '';
  if (candidate) rawArtwork.set(item, candidate);
  return candidate || rawArtwork.get(item) || canonicalArtworkUrl(item._extra?.artworkUrl);
}

function lookupKey(item) {
  if (isArtworkRelayUrl(item?.thumbnail)) return item.thumbnail.trim();
  return rawArtwork.get(item)
    || canonicalArtworkUrl(item?.thumbnail)
    || canonicalArtworkUrl(item?._extra?.artworkUrl)
    || '';
}

export function artworkNeedsResolution(item) {
  if (!item || typeof item !== 'object' || !item.id || !item.source) return false;
  if (isArtworkRelayUrl(item.thumbnail)) return false;
  const key = lookupKey(item);
  return artworkChecked.get(item) !== key;
}

function storeResolvedArtwork(item, relayUrl, canonicalUrl = '') {
  item.thumbnail = relayUrl;
  rawArtwork.delete(item);
  if (canonicalUrl) {
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' && !Array.isArray(item._extra)
        ? item._extra : {}),
      artworkUrl: canonicalUrl,
      needsArtwork: false,
    };
  } else if (item._extra && typeof item._extra === 'object') {
    item._extra.needsArtwork = false;
  }
  artworkChecked.set(item, relayUrl);
  return item;
}

async function registerProviderArtwork(item, url, opts) {
  const registerAssetImpl = opts.registerAssetImpl || registerCatalogAsset;
  const registration = await retryArtworkLookup(() => registerAssetImpl({
    url,
    sourceId: item.source,
    itemId: item.id,
  }, { signal: opts.signal }), opts.retry);
  const relayUrl = typeof registration?.relay_url === 'string'
    ? registration.relay_url.trim() : '';
  if (!isArtworkRelayUrl(relayUrl)) {
    throw new TypeError('Artwork relay returned an invalid same-origin route.');
  }
  return { relayUrl, canonicalUrl: url };
}

async function performResolution(item, candidate, opts) {
  if (candidate) return registerProviderArtwork(item, candidate, opts);

  const loadAdapterImpl = opts.loadAdapterImpl || loadAdapter;
  const adapter = await loadAdapterImpl(item.source);
  if (typeof adapter.resolveArtwork !== 'function') return { relayUrl: '', canonicalUrl: '' };

  await retryArtworkLookup(() => adapter.resolveArtwork(item, { signal: opts.signal }), opts.retry);
  if (isArtworkRelayUrl(item.thumbnail)) {
    return {
      relayUrl: item.thumbnail.trim(),
      canonicalUrl: canonicalArtworkUrl(item._extra?.artworkUrl),
    };
  }

  const resolvedCandidate = canonicalArtworkUrl(item.thumbnail)
    || canonicalArtworkUrl(item._extra?.artworkUrl);
  if (item.thumbnail) item.thumbnail = '';
  if (!resolvedCandidate) return { relayUrl: '', canonicalUrl: '' };
  rawArtwork.set(item, resolvedCandidate);
  return registerProviderArtwork(item, resolvedCandidate, opts);
}

/**
 * Resolve artwork without blocking media playback or view rendering.
 * Concurrent consumers of the same source/item share one bounded request.
 */
export async function resolveArtworkRelay(item, opts = {}) {
  if (!item || typeof item !== 'object') return item;
  if (isArtworkRelayUrl(item.thumbnail)) return item;
  if (!item.id || !item.source) {
    if (item.thumbnail) item.thumbnail = '';
    return item;
  }

  const candidate = captureProviderArtwork(item);
  const currentKey = candidate || lookupKey(item);
  if (artworkChecked.get(item) === currentKey) return item;

  const scope = `${item.source}\u0000${item.id}`;
  let entry = artworkRequests.get(scope);
  // A tab switch can abort an old view while its promise is still unwinding.
  // Do not make the current view inherit that cancellation for the same item.
  if (entry?.signal?.aborted) {
    artworkRequests.delete(scope);
    entry = null;
  }
  if (!entry || entry.lookupKey !== currentKey) {
    const workItem = item;
    const promise = artworkQueue.enqueue(
      () => runArtworkTask(
        (signal) => performResolution(workItem, candidate, { ...opts, signal }),
        opts,
      ),
      opts.priority || 0,
      { signal: opts.signal },
    ).finally(() => {
      if (artworkRequests.get(scope)?.promise === promise) artworkRequests.delete(scope);
    });
    entry = { lookupKey: currentKey, promise, signal: opts.signal };
    artworkRequests.set(scope, entry);
  }

  const result = await entry.promise;
  if (result.relayUrl) return storeResolvedArtwork(item, result.relayUrl, result.canonicalUrl);
  item.thumbnail = '';
  rawArtwork.delete(item);
  artworkChecked.set(item, lookupKey(item));
  return item;
}
