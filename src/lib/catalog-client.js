/** Authenticated client for hardened dynamic catalog and artwork routes. */

import { ControlApiError, controlRequest } from './capture-client.js';

function requiredString(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) throw new ControlApiError(code, message);
  return value.trim();
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * At most `limit` tasks at a time; the others wait in the order they came. A
 * waiter whose signal aborts leaves the queue at once (rejected with the
 * abort's reason) and frees nothing, as it held nothing; a running task frees
 * its place when it settles, however it ends (an answer, a failure, an
 * abort), and a task that throws at once frees it too.
 */
export function createRequestSlots(limit) {
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  let active = 0;
  const waiting = [];
  function next() {
    while (active < size && waiting.length) waiting.shift().start();
  }
  function run(task, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const waiter = {};
      const onAbort = () => {
        const index = waiting.indexOf(waiter);
        if (index === -1) return;
        waiting.splice(index, 1);
        reject(abortReason(signal));
      };
      waiter.start = () => {
        signal?.removeEventListener?.('abort', onAbort);
        active += 1;
        let running;
        try {
          running = Promise.resolve(task());
        } catch (error) {
          running = Promise.reject(error);
        }
        // The place is free before the caller hears the outcome.
        const release = () => {
          active -= 1;
          next();
        };
        running.then((value) => { release(); resolve(value); }, (error) => { release(); reject(error); });
      };
      if (active < size && waiting.length === 0) {
        waiter.start();
      } else {
        waiting.push(waiter);
        signal?.addEventListener?.('abort', onAbort, { once: true });
      }
    });
  }
  return {
    run,
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

/**
 * The browser opens at most six connections to the local server at a time
 * (see capture-client.js), and a playing stream holds one or two of them.
 * The slow catalogue routes below each wait on outside servers, so together
 * they may hold at most SLOW_CATALOG_SLOTS; the rest of the page (the jobs
 * check, artwork, playback, settings) keeps the others. Slow, from the
 * server's limits (worldmedia_catalog.py, worldmedia_media.py): each fetch
 * from an outside server may take up to 8 s to connect and 12 s for its
 * headers on each of up to 5 redirects, and up to 30 s in all for its body
 * (MAX_UPSTREAM_SECONDS):
 *   /api/v1/catalog/feed/resolve      one podcast feed
 *   /api/v1/catalog/peertube/resolve  one PeerTube video
 *   /api/v1/catalog/owncast/snapshot  two to four fetches
 * Quick, kept out: /api/v1/assets/register (a name lookup only, no fetch),
 * /api/v1/assets/<id>/expire and /api/v1/catalog/cache/clear (local work).
 */
export const SLOW_CATALOG_SLOTS = 3;
const slowCatalogSlots = createRequestSlots(SLOW_CATALOG_SLOTS);

/** `forPlayback: true` marks a resolve made because the user pressed Play
 *  (the adapters' resolveStream): one request the user is waiting for, sent
 *  at once and not counted against the places. Browse and preview lookups
 *  queue. */
function slowCatalogRequest(path, options = {}) {
  const { forPlayback = false, ...requestOptions } = options;
  if (forPlayback === true) return controlRequest(path, requestOptions);
  return slowCatalogSlots.run(() => controlRequest(path, requestOptions), { signal: requestOptions.signal });
}

/** How many slow catalogue requests run and wait now (tests). */
export function slowCatalogLoad() {
  return { active: slowCatalogSlots.active, waiting: slowCatalogSlots.waiting };
}

export function resolvePodcastFeed(url, options = {}) {
  const body = { url: requiredString(url, 'INVALID_FEED_URL', 'Podcast feed URL is missing.') };
  return slowCatalogRequest('/api/v1/catalog/feed/resolve', { ...options, method: 'POST', body });
}

export function resolvePeerTubeVideo(watchUrl, uuid, options = {}) {
  const body = {
    watch_url: requiredString(watchUrl, 'INVALID_PEERTUBE_URL', 'PeerTube watch URL is missing.'),
    uuid: requiredString(uuid, 'INVALID_PEERTUBE_UUID', 'PeerTube UUID is missing.'),
  };
  return slowCatalogRequest('/api/v1/catalog/peertube/resolve', { ...options, method: 'POST', body });
}

export function getOwncastSnapshot(options = {}) {
  return slowCatalogRequest('/api/v1/catalog/owncast/snapshot', options);
}

/** Codes with which the app refuses an artwork address itself (one on a
 *  private or local network, or one no catalog may reach). Such a refusal is
 *  remembered per address, and that address is not asked for again while it
 *  holds: for the session, or for REFUSED_ASSET_TTL_MS where the answer comes
 *  from a name lookup that can be wrong for a while (a captive portal, or a
 *  router answering with its own address while the internet is down). */
export const REFUSED_ASSET_CODES = Object.freeze(['NON_GLOBAL_MEDIA_TARGET', 'CATALOG_TARGET_REJECTED']);
export const REFUSED_ASSET_TTL_MS = Object.freeze({ NON_GLOBAL_MEDIA_TARGET: 10 * 60 * 1000 });
export const MAX_REFUSED_ASSETS = 500;
const refusedAssets = new Map(); // address -> { code, until } (until: Infinity for the session)

/** True for an artwork registration the app refused because of its address. */
export function isRefusedAssetError(error) {
  return Number(error?.status) === 403 && REFUSED_ASSET_CODES.includes(error?.code);
}

/** The remembered refusal for an address, or null; an expired one is dropped. */
function refusalFor(address, now) {
  const entry = refusedAssets.get(address);
  if (!entry) return null;
  if (now >= entry.until) {
    refusedAssets.delete(address);
    return null;
  }
  return entry;
}

/** True when this address was refused earlier and that refusal still holds. */
export function assetRefusedThisSession(url, now = Date.now()) {
  return typeof url === 'string' && refusalFor(url.trim(), now) !== null;
}

/** Forget the remembered refusals (tests). */
export function forgetRefusedAssets() {
  refusedAssets.clear();
}

function rememberRefusal(address, code, now) {
  const ttl = REFUSED_ASSET_TTL_MS[code];
  refusedAssets.delete(address);
  refusedAssets.set(address, { code, until: Number.isFinite(ttl) ? now + ttl : Infinity });
  while (refusedAssets.size > MAX_REFUSED_ASSETS) refusedAssets.delete(refusedAssets.keys().next().value);
}

/** `options.now` (a clock in ms) is for tests; the rest goes to the request. */
export function registerCatalogAsset({ url, sourceId, itemId }, options = {}) {
  const { now = Date.now, ...requestOptions } = options;
  const body = {
    url: requiredString(url, 'INVALID_ASSET_URL', 'Artwork URL is missing.'),
    source_id: requiredString(sourceId, 'INVALID_ASSET_SCOPE', 'Artwork source scope is missing.'),
    item_id: requiredString(itemId, 'INVALID_ASSET_SCOPE', 'Artwork item scope is missing.'),
  };
  const refused = refusalFor(body.url, now());
  if (refused) {
    // The same answer as last time, without asking the app again.
    return Promise.reject(new ControlApiError(refused.code, 'This artwork address was refused a short while ago.', 403, false));
  }
  return controlRequest('/api/v1/assets/register', { ...requestOptions, method: 'POST', body }).catch((error) => {
    if (isRefusedAssetError(error)) rememberRefusal(body.url, error.code, now());
    throw error;
  });
}

export function expireCatalogAsset(assetId, sourceId, itemId, options = {}) {
  const token = requiredString(assetId, 'INVALID_ASSET_ID', 'Artwork registration ID is missing.');
  return controlRequest(`/api/v1/assets/${encodeURIComponent(token)}/expire`, {
    ...options,
    method: 'POST',
    body: {
      source_id: requiredString(sourceId, 'INVALID_ASSET_SCOPE', 'Artwork source scope is missing.'),
      item_id: requiredString(itemId, 'INVALID_ASSET_SCOPE', 'Artwork item scope is missing.'),
    },
  });
}

export function clearCatalogCache(options = {}) {
  return controlRequest('/api/v1/catalog/cache/clear', {
    ...options,
    method: 'POST',
    body: {},
  });
}
