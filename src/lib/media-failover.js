/** Fast, bounded connection selection for live media with alternate streams. */

import { expireMedia, registerMedia } from './capture-client.js';
import { detectStreamKind, safeExternalUrl, sanitizeCaptureHeaders } from './item-model.js';

export const MAX_MEDIA_CANDIDATES = 8;
// HLS registration can require a master manifest, a child manifest, and a
// live segment from a slow origin. Eight seconds canceled healthy streams
// before that chain completed, so leave enough room for the initial probe.
export const MEDIA_PROBE_TIMEOUT_MS = 15_000;
export const MEDIA_PROBE_CONCURRENCY = 2;

export class MediaConnectionError extends Error {
  constructor(message, { attempts = 0, errors = [] } = {}) {
    super(message);
    this.name = 'MediaConnectionError';
    this.code = 'MEDIA_CANDIDATES_UNAVAILABLE';
    this.attempts = attempts;
    this.errors = errors;
    this.retryable = true;
  }
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
  return {
    url,
    kind,
    headers: sanitizeCaptureHeaders(value?.headers || value?.capture_headers),
  };
}

function candidateKey(candidate) {
  return JSON.stringify([candidate.url, candidate.kind, candidate.headers]);
}

export function streamCandidatesForItem(item) {
  const values = [{
    url: item?.stream_url,
    kind: item?.stream_kind,
    headers: item?.capture_headers,
  }, ...(Array.isArray(item?._extra?.streamCandidates) ? item._extra.streamCandidates : [])];
  const seen = new Set();
  const candidates = [];
  for (const value of values) {
    const candidate = normalizedCandidate(value, item);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_MEDIA_CANDIDATES) break;
  }
  return candidates;
}

export function applyStreamCandidate(item, candidate) {
  item.stream_url = candidate.url;
  item.stream_kind = candidate.kind;
  item.capture_headers = { ...candidate.headers };
  item._extra = {
    ...(item._extra || {}),
    activeStreamUrl: candidate.url,
  };
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

/** Register and verify the first reachable candidate, racing only two at once. */
export async function connectMediaRelay(item, options = {}) {
  const candidates = streamCandidatesForItem(item);
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
    const entries = batch.map((candidate, batchIndex) => {
      const controller = new AbortController();
      const index = offset + batchIndex;
      const shouldProbe = candidate.kind === 'hls' || candidate.kind === 'dash' || candidates.length > 1;
      const entry = { controller };
      entry.promise = connectCandidate(item, candidate, index, {
        ...settings, controller,
      }, shouldProbe);
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
    }
  }
  if (candidates.length === 1 && errors[0]?.mediaRegistrationFailed) throw errors[0];
  throw new MediaConnectionError(
    `No working stream was reachable after ${candidates.length} attempt${candidates.length === 1 ? '' : 's'}.`,
    { attempts: candidates.length, errors },
  );
}
