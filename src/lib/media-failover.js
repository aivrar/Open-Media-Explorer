/** Fast, bounded connection selection for live media with alternate streams. */

import { expireMedia, registerMedia } from './capture-client.js';
import { detectStreamKind, safeExternalUrl, sanitizeCaptureHeaders } from './item-model.js';
import { rankStreams } from './best-stream.js';

export const MAX_MEDIA_CANDIDATES = 8;
// HLS registration can require a master manifest, a child manifest, and a
// live segment from a slow origin. Eight seconds canceled healthy streams
// before that chain completed, so leave enough room for the initial probe.
export const MEDIA_PROBE_TIMEOUT_MS = 15_000;
export const MEDIA_PROBE_CONCURRENCY = 2;
// With "Pick the best stream", the preferred stream of each pair is started
// alone and has this long to deliver before the next listed stream starts
// too; from then on whichever delivers first plays. If the preferred one
// fails outright, the next starts at once. (Proposed value.)
export const BEST_STREAM_HEAD_START_MS = 6_000;

export const MEDIA_REGISTRY_FULL = 'MEDIA_REGISTRY_FULL';
export const MEDIA_REGISTRY_FULL_MESSAGE = "The app's stream relay is full. Restart the app to clear it.";

/** Distinct error codes carried by the underlying candidate failures. */
export function underlyingErrorCodes(errors) {
  const codes = [];
  for (const error of Array.isArray(errors) ? errors : []) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

export class MediaConnectionError extends Error {
  constructor(message, { attempts = 0, errors = [], code = 'MEDIA_CANDIDATES_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'MediaConnectionError';
    this.code = code;
    this.attempts = attempts;
    this.errors = errors;
    this.codes = underlyingErrorCodes(errors);
    // A full relay registry does not clear by retrying; only a restart does.
    this.retryable = code !== MEDIA_REGISTRY_FULL;
  }
}

const HOST_NOT_FOUND = 'MEDIA_HOST_NOT_FOUND';
const DNS_FAILED = 'MEDIA_DNS_FAILED';

/**
 * A plain sentence for a start that failed because the stream's host name
 * could not be found: every failed stream said its host does not exist
 * (`MEDIA_HOST_NOT_FOUND`) or that the name could not be looked up
 * (`MEDIA_DNS_FAILED`). '' for any other failure, which keeps its own text.
 */
export function hostLookupFailureMessage(error, item = null) {
  const nested = Array.isArray(error?.errors) && error.errors.length ? error.errors : [error];
  const codes = nested.map((entry) => (typeof entry?.code === 'string' ? entry.code : ''));
  if (!codes.every((code) => code === HOST_NOT_FOUND || code === DNS_FAILED)) return '';
  if (codes.includes(DNS_FAILED)) {
    return "This stream's address could not be looked up. Check your internet connection, then press Play to retry.";
  }
  const kind = item?.type === 'radio' || item?.type === 'tv'
    ? 'station'
    : (Array.isArray(item?.tags) && item.tags.includes('podcast') ? 'episode' : 'item');
  return `This ${kind}'s address does not exist. Press Play to retry.`;
}

function abortError(reason = null) {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') {
    return new DOMException(String(reason?.message || reason || 'Aborted'), 'AbortError');
  }
  const error = new Error(String(reason?.message || reason || 'Aborted'));
  error.name = 'AbortError';
  return error;
}

function normalizedCandidate(value, item) {
  const url = safeExternalUrl(value?.url || value?.stream_url);
  if (!url) return null;
  let kind = value?.kind || value?.stream_kind;
  if (!['audio', 'video', 'hls', 'dash'].includes(kind)) {
    kind = detectStreamKind(url, item?.type === 'radio' || item?.type === 'audio' ? 'audio' : 'video');
  }
  if (kind === 'audio' && (item?.type === 'tv' || item?.type === 'video')) kind = 'video';
  const candidate = {
    url,
    kind,
    headers: sanitizeCaptureHeaders(value?.headers || value?.capture_headers),
  };
  // What the directory says about the stream, for "Pick the best stream".
  if (typeof value?.quality === 'string' && value.quality) candidate.quality = value.quality.slice(0, 32);
  const bitrate = Number(value?.bitrate);
  if (Number.isFinite(bitrate) && bitrate > 0) candidate.bitrate = Math.round(bitrate);
  if (typeof value?.codec === 'string' && value.codec) candidate.codec = value.codec.slice(0, 12);
  // A stream verified by Auto: it must still end on https after redirects.
  if (value?.requireHttps === true && /^https:/i.test(url)) candidate.requireHttps = true;
  return candidate;
}

function candidateKey(candidate) {
  return JSON.stringify([candidate.url, candidate.kind, candidate.headers]);
}

// The stream each item last played (by item id), kept apart from the item
// so that playback never changes an item's own address, which is what a
// favourite saves. A few items at most; the oldest goes first.
const MAX_PLAYED_STREAMS = 16;
const playedStreams = new Map();

/** The stream item `itemOrId` last connected to ({ url, kind, headers,
 *  bitrate?, codec?, quality? }), or null. */
export function playedStream(itemOrId) {
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
  return (id && playedStreams.get(id)) || null;
}

/** The streams to try for an item, in order. By default: the stream it
 *  plays now first, then its own stream and the source's alternates (a
 *  recording takes this, so it records what plays). `preferBest: false`
 *  (the setting is off): its own stream, then the alternates.
 *  `preferBest: true`: the same streams plus `extraStreams` (other
 *  directory entries of the same station), best first (best-stream.js);
 *  the item's own stream always keeps a place within the limit. */
export function streamCandidatesForItem(item, { preferBest, extraStreams = [] } = {}) {
  const extra = item?._extra || {};
  const played = preferBest === undefined ? playedStream(item) : null;
  const values = [...(played ? [played] : []), {
    url: item?.stream_url,
    kind: item?.stream_kind,
    headers: item?.capture_headers,
    quality: extra.quality,
    bitrate: extra.bitrate,
    codec: extra.codec,
  }, ...(Array.isArray(extra.streamCandidates) ? extra.streamCandidates : []),
  ...(preferBest === true && Array.isArray(extraStreams) ? extraStreams : [])];
  const own = normalizedCandidate(values[played ? 1 : 0], item);
  const seen = new Set();
  const candidates = [];
  for (const value of values) {
    const candidate = normalizedCandidate(value, item);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  if (preferBest !== true) return candidates.slice(0, MAX_MEDIA_CANDIDATES);
  const ranked = rankStreams(candidates);
  const ownKey = own ? candidateKey(own) : '';
  const ownAt = ranked.findIndex((candidate) => candidateKey(candidate) === ownKey);
  if (ownAt < MAX_MEDIA_CANDIDATES) return ranked.slice(0, MAX_MEDIA_CANDIDATES);
  return [...ranked.slice(0, MAX_MEDIA_CANDIDATES - 1), ranked[ownAt]];
}

/** Remember the stream `item` connected to (playedStream). The item itself
 *  is left as it is. */
export function applyStreamCandidate(item, candidate) {
  if (!item?.id || !candidate?.url) return item;
  playedStreams.delete(item.id);
  playedStreams.set(item.id, Object.freeze({ ...candidate, headers: Object.freeze({ ...candidate.headers }) }));
  while (playedStreams.size > MAX_PLAYED_STREAMS) playedStreams.delete(playedStreams.keys().next().value);
  return item;
}

async function relayError(response) {
  let code = 'MEDIA_RELAY_STATUS';
  try {
    const envelope = await response.clone().json();
    if (envelope?.error?.code) code = envelope.error.code;
  } catch (_) { /* upstream status/body is intentionally not exposed */ }
  const error = new Error(`Media relay returned HTTP ${response.status}.`);
  error.code = code;
  error.status = Number(response.status || 0);
  error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return error;
}

async function fetchProbe(url, range, { fetchImpl, signal }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Range: range },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response?.ok) throw await relayError(response || { status: 0, clone: () => ({ json: async () => ({}) }) });
  return response;
}

function hlsResources(text) {
  const resources = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith('#')) resources.push(value);
  }
  return resources;
}

function firstHlsAttributeResource(text) {
  const attribute = String(text || '').match(/\bURI\s*=\s*"([^"\r\n]+)"/i)
    || String(text || '').match(/\bURI\s*=\s*([^,\s]+)/i);
  return attribute?.[1] || '';
}

function localRelayResource(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().replaceAll('&amp;', '&');
  if (/^\/api\/v1\/(?:media|dash)\/[A-Za-z0-9_-]{8,}/.test(candidate)) return candidate;
  return '';
}

async function probeHls(relayUrl, options) {
  let current = relayUrl;
  for (let depth = 0; depth < 4; depth++) {
    const response = await fetchProbe(current, 'bytes=0-', options);
    const contentType = response.headers?.get?.('content-type')?.toLowerCase() || '';
    if (depth > 0 && !contentType.includes('mpegurl')) {
      try { await response.body?.cancel?.(); } catch (_) {}
      return true;
    }
    const text = await response.text();
    if (!/^\s*#EXTM3U\b/m.test(text)) {
      const error = new Error('Media relay did not return a valid HLS playlist.');
      error.code = 'INVALID_HLS_MANIFEST';
      throw error;
    }
    const resources = hlsResources(text).map(localRelayResource).filter(Boolean);
    const isMaster = /#EXT-X-(?:STREAM-INF|MEDIA)\s*:/i.test(text);
    if (!isMaster && resources.length) {
      // Short live playlists commonly evict their oldest fragment while the
      // master/child manifests are being fetched. Probe the newest fragment,
      // which is also the fragment a fresh player can still retrieve.
      let lastError = null;
      for (const resource of resources.slice(-3).reverse()) {
        try {
          const segment = await fetchProbe(resource, 'bytes=0-', options);
          try { await segment.body?.cancel?.(); } catch (_) {}
          return true;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = error;
        }
      }
      throw lastError || new Error('No HLS media segment was reachable.');
    }
    const next = resources[0] || localRelayResource(firstHlsAttributeResource(text));
    if (!next) return true;
    current = next;
  }
  return true;
}

export async function probeMediaRelay(relay, candidate, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
  if (!relay?.relay_url) throw new TypeError('Media relay URL is missing');
  if (candidate.kind === 'hls') return probeHls(relay.relay_url, { fetchImpl, signal: options.signal });
  const response = await fetchProbe(
    relay.relay_url,
    candidate.kind === 'dash' ? 'bytes=0-' : 'bytes=0-0',
    { fetchImpl, signal: options.signal },
  );
  try { await response.body?.cancel?.(); } catch (_) {}
  return true;
}

// Relays whose stream answered a test request before playback (a single
// plain stream gets no test request: registering it only looks up its name).
const probedRelays = new WeakSet();

/** True when `relay`'s stream answered a test request while connecting. */
export function relayWasProbed(relay) {
  return Boolean(relay && typeof relay === 'object' && probedRelays.has(relay));
}

async function connectCandidate(item, candidate, index, options, shouldProbe) {
  const controller = options.controller;
  const onAbort = () => controller.abort(abortError(options.signal?.reason));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = (options.setTimer || setTimeout)(
    () => controller.abort(abortError('Media connection timed out.')),
    options.timeoutMs,
  );
  let relay = null;
  try {
    const candidateItem = {
      ...item,
      stream_url: candidate.url,
      stream_kind: candidate.kind,
      capture_headers: { ...candidate.headers },
      require_https: candidate.requireHttps === true,
    };
    relay = await options.registerImpl(candidateItem, {
      fetchImpl: options.fetchImpl,
      signal: controller.signal,
    });
    if (shouldProbe) {
      await options.probeImpl(relay, candidate, {
        fetchImpl: options.fetchImpl,
        signal: controller.signal,
      });
      if (relay && typeof relay === 'object') probedRelays.add(relay);
    }
    return { relay, candidate, index };
  } catch (error) {
    if (!relay && error && typeof error === 'object') error.mediaRegistrationFailed = true;
    if (relay?.media_id) {
      options.expireImpl(relay.media_id, 0, { fetchImpl: options.fetchImpl }).catch(() => {});
    }
    throw error;
  } finally {
    (options.clearTimer || clearTimeout)(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function firstSuccessful(entries) {
  return new Promise((resolve, reject) => {
    const errors = new Array(entries.length);
    let remaining = entries.length;
    let finished = false;
    entries.forEach((entry, index) => {
      entry.promise.then((result) => {
        if (finished) {
          entry.expire(result);
          return;
        }
        finished = true;
        for (const other of entries) {
          if (other !== entry) other.controller.abort(abortError('Another stream connected first.'));
        }
        resolve(result);
      }, (error) => {
        errors[index] = error;
        remaining -= 1;
        if (!finished && remaining === 0) reject(errors);
      });
    });
  });
}

/** Register and verify the first reachable candidate, racing only two at once.
 *  With `preferBest` the streams go best first and the better of each pair
 *  gets a head start (BEST_STREAM_HEAD_START_MS); without it, as before. */
export async function connectMediaRelay(item, options = {}) {
  const preferBest = options.preferBest === true;
  const headStartMs = preferBest
    ? Math.max(0, Number(options.headStartMs ?? BEST_STREAM_HEAD_START_MS) || 0) : 0;
  // `skipUrls`: streams that already connected for this start and did not
  // play (start-failover.js); the rest keep their order.
  const skip = new Set(Array.isArray(options.skipUrls) ? options.skipUrls : []);
  const candidates = streamCandidatesForItem(item, {
    preferBest: options.preferBest, extraStreams: options.extraStreams,
  }).filter((candidate) => !skip.has(candidate.url));
  if (!candidates.length) {
    throw new MediaConnectionError('This item has no valid media stream.', { attempts: 0 });
  }
  const settings = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    signal: options.signal,
    timeoutMs: Math.max(1_000, Number(options.timeoutMs || MEDIA_PROBE_TIMEOUT_MS)),
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    registerImpl: options.registerImpl || registerMedia,
    expireImpl: options.expireImpl || expireMedia,
    probeImpl: options.probeImpl || probeMediaRelay,
  };
  const errors = [];
  const concurrency = Math.max(1, Math.min(
    Number(options.concurrency || MEDIA_PROBE_CONCURRENCY),
    MEDIA_PROBE_CONCURRENCY,
  ));
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    if (settings.signal?.aborted) throw abortError(settings.signal.reason);
    const batch = candidates.slice(offset, offset + concurrency);
    // The head start: the later streams of the batch wait for the timer, an
    // outright failure of the first, or the caller giving up.
    let releaseLater = () => {};
    const later = new Promise((resolve) => { releaseLater = resolve; });
    const setTimer = settings.setTimer || setTimeout;
    const clearTimer = settings.clearTimer || clearTimeout;
    const headTimer = headStartMs > 0 && batch.length > 1 ? setTimer(() => releaseLater(), headStartMs) : null;
    const onCallerAbort = () => releaseLater();
    if (headTimer !== null) settings.signal?.addEventListener?.('abort', onCallerAbort, { once: true });
    const entries = batch.map((candidate, batchIndex) => {
      const controller = new AbortController();
      const index = offset + batchIndex;
      const shouldProbe = candidate.kind === 'hls' || candidate.kind === 'dash' || candidates.length > 1;
      const entry = { controller };
      const begin = () => connectCandidate(item, candidate, index, {
        ...settings, controller,
      }, shouldProbe);
      if (headTimer === null || batchIndex === 0) {
        entry.promise = begin();
        if (headTimer !== null) entry.promise.catch(() => releaseLater());
      } else {
        // Never started when the preferred stream already won.
        entry.promise = later.then(() => {
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          return begin();
        });
      }
      entry.expire = (result) => {
        if (result?.relay?.media_id) {
          settings.expireImpl(result.relay.media_id, 0, { fetchImpl: settings.fetchImpl }).catch(() => {});
        }
      };
      return entry;
    });
    try {
      const winner = await firstSuccessful(entries);
      applyStreamCandidate(item, winner.candidate);
      return winner.relay;
    } catch (batchErrors) {
      errors.push(...batchErrors);
    } finally {
      if (headTimer !== null) {
        clearTimer(headTimer);
        settings.signal?.removeEventListener?.('abort', onCallerAbort);
        // A stream still waiting for its turn settles (as aborted) now.
        releaseLater();
      }
    }
  }
  if (underlyingErrorCodes(errors).includes(MEDIA_REGISTRY_FULL)) {
    throw new MediaConnectionError(MEDIA_REGISTRY_FULL_MESSAGE, {
      attempts: candidates.length, errors, code: MEDIA_REGISTRY_FULL,
    });
  }
  if (candidates.length === 1 && errors[0]?.mediaRegistrationFailed) throw errors[0];
  throw new MediaConnectionError(
    `No working stream was reachable after ${candidates.length} attempt${candidates.length === 1 ? '' : 's'}.`,
    { attempts: candidates.length, errors },
  );
}
