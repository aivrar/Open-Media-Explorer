/**
 * Library of Congress audio/video adapter.
 *
 * LOC catalog JSON is intentionally treated as heterogeneous and rate-limited:
 * one shared gate owns browse, search, detail resolution, random seeding, and
 * retries. Cards stay as summaries until playback/download needs item resources.
 */

import {
  getJson, HttpContentTypeError, ProviderError,
} from '../lib/http.js';
import {
  detectStreamKind, filenameFromUrl, makeItem, prefixId,
} from '../lib/item-model.js';
import { registerCatalogAsset } from '../lib/catalog-client.js';

export const id = 'library-of-congress';
export const displayName = 'Library of Congress';
export const itemTypes = ['audio', 'video'];
export const catalogPolicy = Object.freeze({ maxConcurrent: 1, minIntervalMs: 6_000 });

export const LOC_AUDIO_URL = 'https://www.loc.gov/audio/';
export const LOC_VIDEO_URL = 'https://www.loc.gov/film-and-videos/';

const PAGE_SIZE = 30;
const MAX_DEEP_ITEMS = 100_000;
const MAX_REQUEST_PAGE = Math.floor(MAX_DEEP_ITEMS / PAGE_SIZE);
const MAX_PROVIDER_TOTAL = 100_000_000;
const MAX_CATALOG_CACHE = 64;
const MAX_DETAIL_CACHE = 128;
const MAX_RESERVOIR = 300;
const MAX_RESULTS = PAGE_SIZE;
const MAX_RESOURCES = 128;
const MAX_RESOURCE_NODES = 512;
const MAX_RESOURCE_DEPTH = 6;
const MAX_CANDIDATES = 256;
const MAX_TEXT_NODES = 128;
const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const HEAVY_LOAD_COOLDOWN_MS = 60 * 1000;
const LOC_JSON_MAX_BYTES = 8 * 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|key|password|signature|token)$/i;

const LANES = Object.freeze({
  audio: Object.freeze({ endpoint: LOC_AUDIO_URL, type: 'audio' }),
  video: Object.freeze({ endpoint: LOC_VIDEO_URL, type: 'video' }),
});

const LANGUAGE_CODES = Object.freeze({
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
  portuguese: 'pt', russian: 'ru', dutch: 'nl', polish: 'pl', japanese: 'ja',
  chinese: 'zh', arabic: 'ar', hebrew: 'he', korean: 'ko', swedish: 'sv',
});

function abortError(reason = 'Cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function stringValues(value, options = {}) {
  const maxNodes = Math.max(1, Number(options.maxNodes) || MAX_TEXT_NODES);
  const maxValues = Math.max(1, Number(options.maxValues) || 16);
  const maxLength = Math.max(1, Number(options.maxLength) || 300);
  const stack = [value];
  const values = [];
  let inspected = 0;
  while (stack.length > 0 && inspected < maxNodes && values.length < maxValues) {
    const current = stack.pop();
    inspected += 1;
    if (Array.isArray(current)) {
      const remaining = Math.max(0, maxNodes - inspected - stack.length);
      for (let index = Math.min(current.length, remaining) - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
      continue;
    }
    if (current && typeof current === 'object') continue;
    const text = cleanString(current, maxLength);
    if (text) values.push(text);
  }
  return values;
}

function boundedPlainText(value, maxLength = 2_000) {
  const joined = stringValues(value, {
    maxNodes: MAX_TEXT_NODES, maxValues: 32, maxLength: maxLength * 2,
  }).join('\n');
  return joined.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, maxLength);
}

function normalizeTags(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    for (const text of stringValues(value, { maxValues: 16, maxLength: 64 })) {
      const key = text.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 16) return out;
    }
  }
  return out;
}

function yearFrom(value) {
  for (const text of stringValues(value, { maxValues: 8, maxLength: 80 })) {
    const match = text.match(/(?:^|\D)(1\d{3}|2\d{3}|3000)(?:\D|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function languageFrom(value) {
  const text = stringValues(value, { maxValues: 1, maxLength: 40 })[0]?.toLowerCase() || '';
  if (!text) return '';
  if (LANGUAGE_CODES[text]) return LANGUAGE_CODES[text];
  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(text) ? text.slice(0, 16) : '';
}

function safeLocUrl(value, options = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return '';
  try {
    const parsed = new URL(value.trim(), 'https://www.loc.gov/');
    const host = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (parsed.port) return '';
    if (host !== 'loc.gov' && !host.endsWith('.loc.gov')) return '';
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    for (const key of parsed.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return '';
    parsed.hash = '';
    if (options.artwork && /\.(?:svg|ico)(?:$|[?#])/i.test(parsed.pathname)) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function canonicalLocIdentity(value) {
  if (typeof value !== 'string') return null;
  try {
    if (new URL(value.trim(), 'https://www.loc.gov/').hash) return null;
  } catch (_) {
    return null;
  }
  const url = safeLocUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['loc.gov', 'www.loc.gov'].includes(parsed.hostname.toLowerCase())) return null;
    const match = parsed.pathname.match(/^\/item\/(.+?)\/?$/);
    if (!match || parsed.search) return null;
    const key = match[1].replace(/^\/+|\/+$/g, '');
    if (!key || key.length > 500 || CONTROL_PATTERN.test(key) || key.includes('\\')) return null;
    let decoded;
    try { decoded = decodeURIComponent(key); } catch (_) { return null; }
    if (!decoded || CONTROL_PATTERN.test(decoded)
        || decoded.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    const sourceUrl = `https://www.loc.gov/item/${key}/`;
    return {
      key,
      sourceUrl,
      detailUrl: `${sourceUrl}?fo=json&at=item%2Cresources`,
    };
  } catch (_) {
    return null;
  }
}

function canonicalArtwork(value) {
  return safeLocUrl(value, { artwork: true });
}

function firstArtwork(value) {
  for (const candidate of stringValues(value, { maxValues: 16, maxLength: 4_096 })) {
    const url = canonicalArtwork(candidate);
    if (url) return url;
  }
  return '';
}

function rightsLabel(item) {
  for (const value of [
    item?.rights, item?.rights_information, item?.rights_advisory,
    item?.access_advisory, item?.restriction,
  ]) {
    const text = boundedPlainText(value, 240);
    if (text) return text;
  }
  return 'See LOC rights';
}

function accessAdvisoryRestricted(value) {
  for (const text of stringValues(value, { maxValues: 16, maxLength: 300 })) {
    const lower = text.toLowerCase();
    if (/\b(?:access restricted|onsite only|on-site only|viewing permission required)\b/.test(lower)) {
      return true;
    }
    if (/\bpermission required (?:to |for )?(?:access|view|viewing|playback)\b/.test(lower)) return true;
    if (/\bavailable only (?:at|on) (?:the )?(?:library of congress|loc premises|site|onsite|on-site|reading room)\b/.test(lower)) {
      return true;
    }
    if (/\b(?:no known restrictions?|unrestricted|not restricted)\b/.test(lower)) continue;
    if (/\b(?:access|viewing)\b.{0,48}\brestrict(?:ed|ions?)\b/.test(lower)) return true;
  }
  return false;
}

function downloadAdvisoryRestricted(value) {
  for (const text of stringValues(value, { maxValues: 16, maxLength: 300 })) {
    const lower = text.toLowerCase();
    if (/\b(?:permission required|streaming only|not available for download|download prohibited)\b/.test(lower)) {
      return true;
    }
    if (/\b(?:no known restrictions?|unrestricted|not restricted)\b/.test(lower)) continue;
    if (/\b(?:download|reproduction|rights?|use)\b.{0,48}\brestrict(?:ed|ions?)\b/.test(lower)) return true;
  }
  return false;
}

function itemAccessRestricted(item) {
  return item?.access_restricted === true
    || accessAdvisoryRestricted(item?.access_advisory)
    || accessAdvisoryRestricted(item?.restriction);
}

function itemDownloadRestricted(item) {
  return item?.access_restricted === true
    || item?.download_restricted === true
    || item?.canDownload === false
    || item?.rights_restricted === true
    || downloadAdvisoryRestricted(item?.access_advisory)
    || downloadAdvisoryRestricted(item?.restriction)
    || downloadAdvisoryRestricted(item?.rights)
    || downloadAdvisoryRestricted(item?.rights_advisory)
    || downloadAdvisoryRestricted(item?.rights_information);
}

/** One burst-1 queue shared by every LOC JSON operation in an adapter. */
export function createLocRateGate(options = {}) {
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs ?? catalogPolicy.minIntervalMs));
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
  const queue = [];
  let active = false;
  let nextStartAt = 0;
  let cooldownUntil = 0;
  let timer = null;
  let disposed = false;

  function clearWake() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function drain() {
    if (disposed || active || timer !== null) return;
    while (queue.length > 0 && queue[0].signal?.aborted) {
      const job = queue.shift();
      job.signal.removeEventListener('abort', job.onAbort);
      job.reject(abortError(job.signal.reason));
    }
    if (queue.length === 0) return;
    const waitMs = Math.max(nextStartAt, cooldownUntil) - now();
    if (waitMs > 0) {
      timer = setTimer(() => { timer = null; drain(); }, waitMs);
      return;
    }
    const job = queue.shift();
    job.signal?.removeEventListener('abort', job.onAbort);
    active = true;
    nextStartAt = now() + minIntervalMs;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      active = false;
      drain();
    });
  }

  function run(task, signal) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(abortError('LOC rate gate disposed'));
        return;
      }
      if (signal?.aborted) {
        reject(abortError(signal.reason));
        return;
      }
      const job = { task, signal, resolve, reject, onAbort: null };
      job.onAbort = () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        signal.removeEventListener('abort', job.onAbort);
        reject(abortError(signal.reason));
        if (queue.length === 0) clearWake();
        else {
          clearWake();
          drain();
        }
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      queue.push(job);
      drain();
    });
  }

  function imposeCooldown(delayMs) {
    const delay = Math.max(0, Number(delayMs) || 0);
    cooldownUntil = Math.max(cooldownUntil, now() + delay);
    clearWake();
    drain();
    return cooldownUntil;
  }

  function dispose(reason = 'LOC rate gate disposed') {
    if (disposed) return;
    disposed = true;
    clearWake();
    for (const job of queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.onAbort);
      job.reject(abortError(reason));
    }
  }

  return {
    run,
    imposeCooldown,
    dispose,
    get pendingCount() { return queue.length; },
    get activeCount() { return active ? 1 : 0; },
    get cooldownUntil() { return cooldownUntil; },
  };
}

function cachedLoad(cache, key, options, loader) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
  const currentTime = options.now();
  const existing = cache.get(key);
  if (existing?.promise && existing.signal === options.signal) return existing.promise;
  if (existing && existing.expiresAt > currentTime) {
    cache.delete(key);
    cache.set(key, existing);
    return Promise.resolve(existing.value);
  }
  cache.delete(key);
  const entry = {
    promise: null, value: null, expiresAt: 0, signal: options.signal,
  };
  const promise = Promise.resolve().then(loader).then((value) => {
    if (cache.get(key) === entry) {
      entry.promise = null;
      entry.signal = null;
      entry.value = value;
      entry.expiresAt = options.now() + options.ttlMs;
    }
    return value;
  }).catch((error) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  entry.promise = promise;
  cache.set(key, entry);
  while (cache.size > options.maxEntries) cache.delete(cache.keys().next().value);
  return promise;
}

function cloneItem(item) {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    capture_headers: { ...(item.capture_headers || {}) },
    ...(item._extra && typeof item._extra === 'object'
      ? { _extra: { ...item._extra } }
      : {}),
  };
}

function normalizeSummary(summary, lane) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  if (summary.access_restricted === true) return null;
  const identity = canonicalLocIdentity(summary.id) || canonicalLocIdentity(summary.url);
  if (!identity) return null;
  const expectedType = LANES[lane].type;
  const title = cleanString(summary.title, 300) || 'Library of Congress item';
  const artworkUrl = firstArtwork(summary.image_url);
  return makeItem({
    id: prefixId(id, identity.key),
    title,
    description: boundedPlainText(summary.description || summary.summary || ''),
    source: id,
    type: expectedType,
    stream_url: '',
    stream_kind: expectedType,
    delivery: 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: '',
    year: yearFrom(summary.date || summary.dates),
    country: '',
    language: languageFrom(summary.language),
    tags: normalizeTags(summary.subject, summary.subjects, summary.genre, summary.online_format),
    license: rightsLabel(summary),
    source_url: identity.sourceUrl,
    content_rating: 'unrated',
    _extra: {
      schemaVersion: 1,
      locKey: identity.key,
      detailUrl: identity.detailUrl,
      artworkUrl,
      expectedType,
      needsResolve: true,
      downloadResolved: false,
      restartResolve: true,
    },
  });
}

function catalogUrl(lane, page, query = '') {
  const target = new URL(LANES[lane].endpoint);
  target.searchParams.set('fo', 'json');
  target.searchParams.set('at', 'results,pagination');
  target.searchParams.set('c', String(PAGE_SIZE));
  target.searchParams.set('sp', String(page));
  if (query) target.searchParams.set('q', query);
  return target.href;
}

function validatedNextPage(value, lane, page, query) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'www.loc.gov'
        || parsed.pathname.replace(/\/+$/, '') !== new URL(LANES[lane].endpoint).pathname.replace(/\/+$/, '')) {
      return null;
    }
    const nextPage = Number(parsed.searchParams.get('sp'));
    if (!Number.isInteger(nextPage) || nextPage !== page + 1) return null;
    if ((parsed.searchParams.get('q') || '') !== query) return null;
    return nextPage;
  } catch (_) {
    return null;
  }
}

function providerFailure(message, retryAfterMs = HEAVY_LOAD_COOLDOWN_MS, code = 'LOC_PROVIDER_ERROR') {
  return new ProviderError(message, { code, retryAfterMs });
}

function normalizeCatalogPage(payload, lane, page, query) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Library of Congress returned an invalid catalog response');
  }
  if (payload.error || (Array.isArray(payload.errors) && payload.errors.length)) {
    throw providerFailure('Library of Congress returned a provider error');
  }
  if (!Array.isArray(payload.results) || !payload.pagination
      || typeof payload.pagination !== 'object' || Array.isArray(payload.pagination)) {
    throw new TypeError('Library of Congress catalog response omitted results or pagination');
  }
  if (payload.results.length > MAX_RESULTS) {
    throw new TypeError('Library of Congress catalog page exceeded the requested size');
  }
  const current = Number(payload.pagination.current);
  const total = Number(payload.pagination.total);
  if (!Number.isInteger(current) || current !== page || !Number.isSafeInteger(total)
      || total < 0 || total > MAX_PROVIDER_TOTAL) {
    throw new TypeError('Library of Congress returned invalid pagination totals');
  }

  const nextValue = payload.pagination.next;
  const hasNext = typeof nextValue === 'string' && Boolean(nextValue.trim());
  const nextPage = hasNext ? validatedNextPage(nextValue, lane, page, query) : null;
  if (hasNext && !nextPage) throw new TypeError('Library of Congress returned an invalid next-page URL');

  if (total === 0) {
    if (payload.results.length !== 0 || hasNext || page !== 1) {
      throw new TypeError('Library of Congress returned inconsistent empty pagination');
    }
    if (!query) throw providerFailure('Library of Congress returned a suspicious zero-item format page');
    return { items: [], nextPage: null, exhausted: true, refineRequired: false, total };
  }
  if (payload.results.length === 0) {
    throw providerFailure('Library of Congress returned a suspicious empty catalog page');
  }

  const from = Number(payload.pagination.from);
  const to = Number(payload.pagination.to);
  const expectedFrom = ((page - 1) * PAGE_SIZE) + 1;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from !== expectedFrom || to < from || to > total
      || to - from + 1 !== payload.results.length) {
    throw new TypeError('Library of Congress returned inconsistent page bounds');
  }
  if (hasNext ? to >= total : to < total) {
    throw new TypeError('Library of Congress pagination disagreed with its total');
  }

  const items = payload.results.map((summary) => normalizeSummary(summary, lane)).filter(Boolean);
  const canonicalResults = payload.results.filter((summary) => (
    summary && typeof summary === 'object' && !Array.isArray(summary)
    && (canonicalLocIdentity(summary.id) || canonicalLocIdentity(summary.url))
  ));
  if (items.length === 0 && canonicalResults.length === 0) {
    throw new TypeError('Library of Congress catalog page contained no usable canonical items');
  }
  const crossesDeepBoundary = hasNext && nextPage > MAX_REQUEST_PAGE;
  return {
    items,
    nextPage: hasNext && !crossesDeepBoundary ? nextPage : null,
    exhausted: !hasNext || crossesDeepBoundary,
    refineRequired: crossesDeepBoundary && total > to,
    total,
  };
}

function newDualCursor(query = '') {
  return {
    version: 1,
    query,
    nextLane: 'audio',
    lanes: {
      audio: { page: 1, exhausted: false, refineRequired: false },
      video: { page: 1, exhausted: false, refineRequired: false },
    },
  };
}

function normalizeDualCursor(value, query, resetOnQueryChange = false) {
  if (value == null || (resetOnQueryChange && value?.query !== query)) return newDualCursor(query);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || value.query !== query || !['audio', 'video'].includes(value.nextLane)
      || !value.lanes || typeof value.lanes !== 'object') {
    throw new TypeError('Invalid Library of Congress cursor');
  }
  const cursor = newDualCursor(query);
  cursor.nextLane = value.nextLane;
  for (const lane of Object.keys(LANES)) {
    const source = value.lanes[lane];
    const page = Number(source?.page);
    if (!source || !Number.isInteger(page) || page < 1 || page > MAX_REQUEST_PAGE + 1
        || typeof source.exhausted !== 'boolean'
        || typeof source.refineRequired !== 'boolean') {
      throw new TypeError('Malformed Library of Congress lane cursor');
    }
    cursor.lanes[lane] = {
      page,
      exhausted: source.exhausted,
      refineRequired: source.refineRequired,
    };
  }
  return cursor;
}

function firstAvailableLane(cursor) {
  for (const lane of [cursor.nextLane, cursor.nextLane === 'audio' ? 'video' : 'audio']) {
    const state = cursor.lanes[lane];
    if (state.page > MAX_REQUEST_PAGE) {
      state.exhausted = true;
      state.refineRequired = true;
    }
    if (!state.exhausted) return lane;
  }
  return '';
}

function refineLanes(cursor) {
  return Object.keys(LANES).filter((lane) => cursor.lanes[lane].refineRequired);
}

function assetRelayUrl(value) {
  return typeof value === 'string' && /^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(value)
    ? value
    : '';
}

function mediaDescriptor(value, mimeValue, hint) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  const url = safeLocUrl(value);
  if (!url) return null;
  const mime = cleanString(mimeValue, 100).toLowerCase();
  const lowerUrl = url.toLowerCase();
  if (mime.includes('mpegurl') || /\.m3u8(?:[?#]|$)/.test(lowerUrl)) {
    return { url, type: hint === 'audio' ? 'audio' : 'video', streamKind: 'hls' };
  }
  if (mime.includes('dash+xml') || /\.mpd(?:[?#]|$)/.test(lowerUrl)) {
    return { url, type: 'video', streamKind: 'dash' };
  }
  if (/^audio\/(?:mpeg|mp3|mp4|aac|ogg|wav|wave|flac)/.test(mime)
      || /\.(?:mp3|m4a|aac|ogg|oga|wav|flac)(?:[?#]|$)/.test(lowerUrl)) {
    return { url, type: 'audio', streamKind: 'audio' };
  }
  if (/^video\/(?:mp4|webm|ogg|quicktime)/.test(mime)
      || /\.(?:mp4|m4v|webm|ogv|mov)(?:[?#]|$)/.test(lowerUrl)) {
    return { url, type: 'video', streamKind: 'video' };
  }
  return null;
}

function mediaHint(value, fallback = '') {
  const text = cleanString(value, 80).toLowerCase();
  if (text === 'a' || text.includes('audio')) return 'audio';
  if (text === 'v' || text.includes('video') || text.includes('film')) return 'video';
  return fallback;
}

function inheritedFlag(child, parent, key) {
  if (child && Object.hasOwn(child, key)) return child[key];
  return parent?.[key];
}

function nestedFilePolicy(value, parent = null) {
  const policy = {};
  for (const key of [
    'access_restricted', 'access_advisory', 'canDownload', 'download_restricted',
    'restriction', 'rights', 'rights_restricted', 'rights_advisory', 'rights_information',
  ]) {
    if (value && Object.hasOwn(value, key)) policy[key] = value[key];
    else if (parent && Object.hasOwn(parent, key)) policy[key] = parent[key];
  }
  return policy;
}

function safeDownloadName(value, url, type) {
  const fallback = `library-of-congress.${type === 'video' ? 'mp4' : 'mp3'}`;
  const raw = typeof value === 'string' && /^https?:\/\//i.test(value.trim())
    ? filenameFromUrl(value, '')
    : (typeof value === 'string' ? value.split(/[\\/]/).pop() : '');
  const candidate = cleanString(raw, 240)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 200);
  if (candidate && candidate !== '.' && candidate !== '..'
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)) return candidate;
  return filenameFromUrl(url, fallback).replace(/[<>:"/\\|?*]/g, '_') || fallback;
}

function playbackScore(candidate, expectedType) {
  let score = candidate.type === expectedType ? 10_000 : 0;
  if (candidate.streamKind === 'hls') score += 600;
  else if (candidate.type === 'audio' && /\.mp3(?:[?#]|$)/i.test(candidate.url)) score += 550;
  else if (candidate.type === 'video' && /\.mp4(?:[?#]|$)/i.test(candidate.url)) score += 500;
  else score += 300;
  return score;
}

function collectMediaCandidates(item, resources, expectedType) {
  if (!Array.isArray(resources)) throw new TypeError('Library of Congress item resources are malformed');
  if (resources.length > MAX_RESOURCES) {
    throw new TypeError('Library of Congress item exceeded the resource bound');
  }
  if (itemAccessRestricted(item)) return [];
  const candidates = new Map();
  let inspectedNodes = 0;

  function add(value, mime, hint, resource, file = null, name = '') {
    const descriptor = mediaDescriptor(value, mime, hint);
    if (!descriptor) return;
    const accessBlocked = resource?.access_restricted === true || file?.access_restricted === true
      || accessAdvisoryRestricted(resource?.access_advisory)
      || accessAdvisoryRestricted(file?.access_advisory)
      || accessAdvisoryRestricted(resource?.restriction)
      || accessAdvisoryRestricted(file?.restriction);
    if (accessBlocked) return;
    const downloadRestricted = inheritedFlag(file, resource, 'download_restricted');
    const canDownload = inheritedFlag(file, resource, 'canDownload');
    const downloadDenied = itemDownloadRestricted(item)
      || downloadRestricted === true || canDownload === false
      || resource?.rights_restricted === true || file?.rights_restricted === true
      || downloadAdvisoryRestricted(resource?.access_advisory)
      || downloadAdvisoryRestricted(file?.access_advisory)
      || downloadAdvisoryRestricted(resource?.restriction)
      || downloadAdvisoryRestricted(file?.restriction)
      || downloadAdvisoryRestricted(resource?.rights)
      || downloadAdvisoryRestricted(file?.rights)
      || downloadAdvisoryRestricted(resource?.rights_advisory)
      || downloadAdvisoryRestricted(file?.rights_advisory)
      || downloadAdvisoryRestricted(resource?.rights_information)
      || downloadAdvisoryRestricted(file?.rights_information);
    const downloadEligible = descriptor.streamKind !== 'hls' && descriptor.streamKind !== 'dash'
      && downloadRestricted === false && canDownload === true && !downloadDenied;
    const candidate = {
      ...descriptor,
      downloadEligible,
      downloadDenied,
      downloadName: safeDownloadName(name || value, descriptor.url, descriptor.type),
    };
    candidate.score = playbackScore(candidate, expectedType);
    const existing = candidates.get(candidate.url);
    if (!existing) candidates.set(candidate.url, candidate);
    else {
      const preferred = candidate.score > existing.score ? candidate : existing;
      const denied = existing.downloadDenied || candidate.downloadDenied;
      const eligible = !denied && (
        existing.downloadEligible && existing.type === preferred.type
        || candidate.downloadEligible && candidate.type === preferred.type
      );
      candidates.set(candidate.url, {
        ...preferred,
        downloadDenied: denied,
        downloadEligible: eligible,
        downloadName: eligible && candidate.downloadEligible
          ? candidate.downloadName
          : preferred.downloadName,
      });
    }
    if (candidates.size > MAX_CANDIDATES) {
      throw new TypeError('Library of Congress item exceeded the media candidate bound');
    }
  }

  for (const resource of resources) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const resourceHint = mediaHint(resource.type, expectedType);
    add(resource.audio, 'audio/mpeg', 'audio', resource);
    add(resource.video_stream, 'application/vnd.apple.mpegurl', 'video', resource);
    add(resource.video, resource.mimetype || resource.mime_type, 'video', resource);
    add(resource.url, resource.mimetype || resource.mime_type, resourceHint, resource);

    const stack = [];
    for (const value of [resource.files, resource.streams, resource.derivatives]) {
      if (value != null) stack.push({ value, depth: 0, policy: null });
    }
    while (stack.length > 0) {
      const { value, depth, policy } = stack.pop();
      inspectedNodes += 1;
      if (inspectedNodes > MAX_RESOURCE_NODES) {
        throw new TypeError('Library of Congress item exceeded the resource traversal bound');
      }
      if (Array.isArray(value)) {
        if (depth >= MAX_RESOURCE_DEPTH) {
          throw new TypeError('Library of Congress item exceeded the resource nesting bound');
        }
        const remaining = MAX_RESOURCE_NODES - inspectedNodes - stack.length;
        if (value.length > remaining) {
          throw new TypeError('Library of Congress item exceeded the resource traversal bound');
        }
        for (let index = value.length - 1; index >= 0; index--) {
          stack.push({ value: value[index], depth: depth + 1, policy });
        }
        continue;
      }
      if (typeof value === 'string') {
        add(value, '', resourceHint, resource, policy, value);
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const currentPolicy = nestedFilePolicy(value, policy);
      const mime = value.mimetype || value.mime_type || value.mimeType || value.format?.mimetype;
      const hint = mediaHint(value.mediaType || value.type, resourceHint);
      const name = value.shortName || value.other_name || value.filename || value.url || value.download;
      add(value.url, mime, hint, resource, currentPolicy, name);
      add(value.filename, mime, hint, resource, currentPolicy, name);
      add(value.download, mime, hint, resource, currentPolicy, name);
      add(value.derivativeUrl, mime, hint, resource, currentPolicy, name);
      for (const nested of [value.files, value.streams, value.derivatives]) {
        if (nested != null) stack.push({
          value: nested, depth: depth + 1, policy: currentPolicy,
        });
      }
    }
  }
  return [...candidates.values()];
}

function chooseMedia(item, resources, expectedType) {
  const candidates = collectMediaCandidates(item, resources, expectedType)
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  const playback = candidates[0] || null;
  if (!playback) return { playback: null, download: null };
  const download = candidates.filter((candidate) => (
    candidate.downloadEligible && candidate.type === playback.type
  )).sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))[0] || null;
  return { playback, download };
}

export function createLibraryOfCongressAdapter(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const randomValue = dependencies.random || Math.random;
  const getJsonImpl = dependencies.getJson || getJson;
  const registerAssetImpl = dependencies.registerCatalogAsset || registerCatalogAsset;
  const rateGate = dependencies.rateGate || createLocRateGate({
    minIntervalMs: dependencies.minIntervalMs ?? catalogPolicy.minIntervalMs,
    now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
  });
  const catalogCache = new Map();
  const detailCache = new Map();
  const reservoir = new Map();
  let standaloneLane = 'audio';

  function classifyProviderError(error) {
    if (error?.name === 'AbortError') return error;
    let cooldown = Number.isFinite(error?.retryAfterMs) ? Number(error.retryAfterMs) : null;
    let code = error?.code || 'LOC_PROVIDER_ERROR';
    if (Number(error?.status) === 429) {
      cooldown = RATE_LIMIT_COOLDOWN_MS;
      code = 'LOC_RATE_LIMITED';
    } else if (error instanceof HttpContentTypeError || error?.code === 'UNEXPECTED_CONTENT_TYPE') {
      cooldown = RATE_LIMIT_COOLDOWN_MS;
      code = 'LOC_CAPTCHA_OR_HTML';
    } else if (Number(error?.status) >= 500) {
      cooldown = Math.max(HEAVY_LOAD_COOLDOWN_MS, cooldown ?? 0);
      code = 'LOC_HEAVY_LOAD';
    }
    if (!Number.isFinite(cooldown) || cooldown < 0) return error;
    const bounded = Math.min(RATE_LIMIT_COOLDOWN_MS, cooldown);
    rateGate.imposeCooldown(bounded);
    if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs === bounded) return error;
    return new ProviderError(String(error?.message || 'Library of Congress request failed'), {
      status: Number(error?.status || 0),
      code,
      retryAfterMs: bounded,
      cause: error,
    });
  }

  function requestLoc(task, signal) {
    return rateGate.run(async () => {
      try {
        return await task();
      } catch (error) {
        throw classifyProviderError(error);
      }
    }, signal);
  }

  function addToReservoir(items) {
    for (const item of items) {
      if (!item?.id) continue;
      reservoir.delete(item.id);
      reservoir.set(item.id, cloneItem(item));
      while (reservoir.size > MAX_RESERVOIR) reservoir.delete(reservoir.keys().next().value);
    }
  }

  async function catalogPage(lane, page, query = '', opts = {}) {
    if (!LANES[lane] || !Number.isInteger(page) || page < 1 || page > MAX_REQUEST_PAGE) {
      throw new TypeError('Invalid Library of Congress catalog lane or page');
    }
    const key = `${lane}\u0000${query}\u0000${page}`;
    const cached = await cachedLoad(catalogCache, key, {
      now,
      signal: opts.signal,
      ttlMs: dependencies.catalogCacheTtlMs ?? CATALOG_CACHE_TTL_MS,
      maxEntries: MAX_CATALOG_CACHE,
    }, () => requestLoc(async () => {
      const payload = await getJsonImpl(catalogUrl(lane, page, query), {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        maxBytes: LOC_JSON_MAX_BYTES,
      });
      return normalizeCatalogPage(payload, lane, page, query);
    }, opts.signal));
    const value = { ...cached, items: cached.items.map(cloneItem) };
    addToReservoir(value.items);
    return value;
  }

  async function dualPage(query, opts = {}, resetOnQueryChange = false) {
    const cursor = normalizeDualCursor(opts.cursor, query, resetOnQueryChange);
    const lane = firstAvailableLane(cursor);
    if (!lane) {
      return {
        items: [], cursor: null, exhausted: true, refineRequired: refineLanes(cursor), lane: '',
      };
    }
    const laneState = cursor.lanes[lane];
    const result = await catalogPage(lane, laneState.page, query, opts);
    laneState.page = result.nextPage || laneState.page;
    laneState.exhausted = result.exhausted;
    laneState.refineRequired ||= result.refineRequired;
    const other = lane === 'audio' ? 'video' : 'audio';
    cursor.nextLane = !cursor.lanes[other].exhausted ? other : lane;
    const exhausted = Object.values(cursor.lanes).every((state) => state.exhausted);
    return {
      items: result.items,
      cursor: exhausted ? null : cursor,
      exhausted,
      refineRequired: refineLanes(cursor),
      lane,
      total: result.total,
    };
  }

  function browsePage(opts = {}) {
    return dualPage('', opts, false);
  }

  function searchPage(query, opts = {}) {
    const normalized = cleanString(query, 200);
    if (!normalized) {
      return Promise.resolve({ items: [], cursor: null, exhausted: true, refineRequired: [] });
    }
    return dualPage(normalized, opts, true);
  }

  async function browse(opts = {}) {
    const lane = standaloneLane;
    const page = await catalogPage(lane, 1, '', opts);
    standaloneLane = lane === 'audio' ? 'video' : 'audio';
    return page.items.slice(0, Math.max(1, Math.min(PAGE_SIZE, Number(opts.limit) || PAGE_SIZE)));
  }

  function interleave(left, right, limit) {
    const out = [];
    for (let index = 0; out.length < limit && (index < left.length || index < right.length); index++) {
      if (index < left.length) out.push(left[index]);
      if (out.length < limit && index < right.length) out.push(right[index]);
    }
    return out;
  }

  async function search(query, opts = {}) {
    const normalized = cleanString(query, 200);
    if (!normalized) return [];
    const requestedPage = Number(opts.page)
      || Math.floor(Math.max(0, Number(opts.offset) || 0) / PAGE_SIZE) + 1;
    const page = Math.max(1, Math.min(MAX_REQUEST_PAGE, Math.trunc(requestedPage)));
    const successes = { audio: [], video: [] };
    const errors = [];
    for (const lane of Object.keys(LANES)) {
      try {
        successes[lane] = (await catalogPage(lane, page, normalized, opts)).items;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        errors.push({ lane, error });
        opts.onLaneError?.(lane, error);
        if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) break;
      }
    }
    if (!successes.audio.length && !successes.video.length && errors.length) throw errors[0].error;
    const limit = Math.max(1, Math.min(PAGE_SIZE, Number(opts.limit) || PAGE_SIZE));
    const items = interleave(successes.audio, successes.video, limit);
    Object.defineProperty(items, 'locSearchState', {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        partial: errors.length > 0,
        failedLanes: Object.freeze(errors.map(({ lane }) => lane)),
      }),
    });
    return items;
  }

  async function itemDetail(key, opts = {}) {
    const identity = canonicalLocIdentity(`https://www.loc.gov/item/${key}/`);
    if (!identity) throw new TypeError('Invalid Library of Congress item identity');
    return cachedLoad(detailCache, identity.key, {
      now,
      signal: opts.signal,
      ttlMs: dependencies.detailCacheTtlMs ?? DETAIL_CACHE_TTL_MS,
      maxEntries: MAX_DETAIL_CACHE,
    }, () => requestLoc(async () => {
      const payload = await getJsonImpl(identity.detailUrl, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        maxBytes: LOC_JSON_MAX_BYTES,
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || !payload.item || typeof payload.item !== 'object' || Array.isArray(payload.item)
          || !Array.isArray(payload.resources)) {
        throw new TypeError('Library of Congress returned an invalid item/resource response');
      }
      const returned = canonicalLocIdentity(payload.item.id)
        || canonicalLocIdentity(payload.item.url);
      if (!returned || returned.key !== identity.key) {
        throw new TypeError('Library of Congress item/resource identity changed');
      }
      if (payload.resources.length > MAX_RESOURCES) {
        throw new TypeError('Library of Congress item exceeded the resource bound');
      }
      return payload;
    }, opts.signal));
  }

  async function resolveStream(item, opts = {}) {
    if (!item || item.source !== id || item.stream_url) return item;
    if (item._extra?.needsResolve === false) return item;
    const rawKey = cleanString(item._extra?.locKey
      || (String(item.id || '').startsWith(`${id}:`) ? String(item.id).slice(id.length + 1) : ''), 500);
    const identity = canonicalLocIdentity(`https://www.loc.gov/item/${rawKey}/`);
    if (!identity) {
      item.stream_url = '';
      item.download_url = '';
      item.download_name = '';
      item.capture_headers = {};
      item._extra = {
        ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
        needsResolve: false,
        downloadResolved: true,
        resolutionStatus: 'unavailable',
        validationError: 'LOC_IDENTITY_INVALID',
      };
      return item;
    }
    const detail = await itemDetail(identity.key, opts);
    const expectedType = ['audio', 'video'].includes(item._extra?.expectedType)
      ? item._extra.expectedType
      : item.type;
    const selection = chooseMedia(detail.item, detail.resources, expectedType);
    const artworkUrl = firstArtwork(detail.item.image_url) || canonicalArtwork(item._extra?.artworkUrl);
    const description = boundedPlainText(detail.item.description || detail.item.summary || item.description);
    item.title = cleanString(detail.item.title, 300) || item.title;
    item.description = description;
    item.year = yearFrom(detail.item.date || detail.item.dates) ?? item.year;
    item.language = languageFrom(detail.item.language) || item.language;
    item.license = rightsLabel(detail.item);
    item.source_url = identity.sourceUrl;
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
      locKey: identity.key,
      detailUrl: identity.detailUrl,
      artworkUrl,
      expectedType,
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: selection.playback ? 'playable' : 'unavailable',
    };
    item.stream_url = '';
    item.download_url = '';
    item.download_name = '';
    item.capture_headers = {};
    if (!selection.playback) return item;
    item.type = selection.playback.type;
    item.stream_kind = selection.playback.streamKind
      || detectStreamKind(selection.playback.url, selection.playback.type);
    item.stream_url = selection.playback.url;
    item.delivery = 'on-demand';
    if (selection.download) {
      item.download_url = selection.download.url;
      item.download_name = selection.download.downloadName;
    }
    return item;
  }

  async function resolveArtwork(item, opts = {}) {
    if (!item || item.source !== id) return item;
    if (assetRelayUrl(item.thumbnail)) return item;
    const artworkUrl = canonicalArtwork(item._extra?.artworkUrl)
      || canonicalArtwork(item.thumbnail);
    if (!artworkUrl) {
      if (item.thumbnail) item.thumbnail = '';
      return item;
    }
    item.thumbnail = '';
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
      artworkUrl,
    };
    const registration = await registerAssetImpl({
      url: artworkUrl,
      sourceId: id,
      itemId: item.id,
    }, { signal: opts.signal });
    const relayUrl = assetRelayUrl(registration?.relay_url);
    if (!relayUrl) throw new TypeError('Artwork relay returned an invalid LOC registration');
    item.thumbnail = relayUrl;
    return item;
  }

  async function random(opts = {}) {
    if (reservoir.size === 0) await browse({ ...opts, limit: PAGE_SIZE });
    const items = [...reservoir.values()].map(cloneItem);
    for (let index = items.length - 1; index > 0; index--) {
      const value = Number(randomValue());
      const other = Number.isFinite(value)
        ? Math.max(0, Math.min(index, Math.floor(value * (index + 1))))
        : 0;
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items.slice(0, Math.max(1, Math.min(PAGE_SIZE, Number(opts.limit) || 12)));
  }

  function dispose() {
    rateGate.dispose?.('Library of Congress adapter disposed');
    catalogCache.clear();
    detailCache.clear();
    reservoir.clear();
  }

  return {
    browse,
    browsePage,
    search,
    searchPage,
    random,
    resolveStream,
    resolveArtwork,
    dispose,
  };
}

const defaultAdapter = createLibraryOfCongressAdapter();

export const browse = (...args) => defaultAdapter.browse(...args);
export const browsePage = (...args) => defaultAdapter.browsePage(...args);
export const search = (...args) => defaultAdapter.search(...args);
export const searchPage = (...args) => defaultAdapter.searchPage(...args);
export const random = (...args) => defaultAdapter.random(...args);
export const resolveStream = (...args) => defaultAdapter.resolveStream(...args);
export const resolveArtwork = (...args) => defaultAdapter.resolveArtwork(...args);
export const dispose = (...args) => defaultAdapter.dispose(...args);
