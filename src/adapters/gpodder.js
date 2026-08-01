/**
 * gPodder directory + hardened native podcast-feed adapter.
 *
 * gPodder discovers shows only. Publisher feeds are never fetched by the
 * browser metadata proxy: every feed crosses the authenticated Phase 2 native
 * resolver, then this module schedules and maps its bounded normalized JSON.
 */

import { getJson, ProviderError } from '../lib/http.js';
import {
  filenameFromUrl, makeItem, prefixId,
} from '../lib/item-model.js';
import {
  registerCatalogAsset, resolvePodcastFeed,
} from '../lib/catalog-client.js';

export const id = 'gpodder';
export const displayName = 'gPodder Podcasts';
export const itemTypes = ['audio', 'video', 'radio', 'tv'];
export const catalogPolicy = Object.freeze({ maxConcurrent: 4, minIntervalMs: 0 });

export const GPODDER_TOPLIST_URL = 'https://gpodder.net/toplist/100.json';
export const GPODDER_SEARCH_URL = 'https://gpodder.net/search.json';

const APP_PAGE_SIZE = 30;
const MAX_DIRECTORY_RESULTS = 100;
const DIRECTORY_BURST = 2;
const DIRECTORY_REFILL_MS = 1_000;
const DIRECTORY_CACHE_TTL_MS = 30 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const PARTIAL_SEARCH_TTL_MS = 60 * 1000;
const FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const DEAD_FEED_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_DEAD_FEED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_FEED_CACHE = 256;
const MAX_FEED_ALIASES = 1_024;
const MAX_SNAPSHOTS = 3;
const MAX_SEARCH_CACHE = 32;
const MAX_FEED_ITEMS = 1_000;
const MAX_ENCLOSURES = 16;
const FEEDS_PER_BATCH = 4;
const EPISODES_PER_FEED_BATCH = 7;
const MAX_EPISODES_PER_FEED = 14;
const MAX_SEARCH_FEEDS = 8;
const MAX_SEARCH_EPISODES_PER_FEED = 5;
const MAX_SEARCH_RESULTS = 40;
const MAX_RESERVOIR = 500;
const DIRECTORY_JSON_MAX_BYTES = 2 * 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const DISPLAY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:access|apikey|auth|authorization|credential|key|pass|password|secret|sig|signature|token)(?:$|[_-])/i;
const STABLE_ID = /^[0-9a-f]{64}$/;
const CONTENT_RATINGS = new Set(['explicit', 'not-explicit', 'unrated']);
const CACHE_STATES = new Set(['fresh', 'updated', 'revalidated', 'stale', 'uncached']);

function abortError(reason = 'Cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(value).replace(DISPLAY_CONTROL_PATTERN, '')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  const names = {
    amp: '&', apos: "'", gt: '>', hellip: '…', laquo: '«', lt: '<', nbsp: ' ',
    ndash: '–', quot: '"', raquo: '»', rsquo: '’', lsquo: '‘', mdash: '—',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, token) => {
    if (token[0] !== '#') return names[token.toLowerCase()] ?? match;
    const radix = token[1]?.toLowerCase() === 'x' ? 16 : 10;
    const digits = radix === 16 ? token.slice(2) : token.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '';
    try { return String.fromCodePoint(codePoint); } catch (_) { return ''; }
  });
}

function boundedPlainText(value, maxLength = 2_000) {
  if (typeof value !== 'string' || !value) return '';
  const bounded = value.slice(0, 16_000)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlEntities(bounded)
    .replace(DISPLAY_CONTROL_PATTERN, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, maxLength);
}

function safeHttpUrl(value, options = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192
      || CONTROL_PATTERN.test(value) || value.includes('\\')) return '';
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (parsed.port === '0') return '';
    if (options.httpsOnly && parsed.protocol !== 'https:') return '';
    if (options.hosts && !options.hosts.has(parsed.hostname.toLowerCase())) return '';
    if (options.rejectSensitiveQuery !== false) {
      for (const key of parsed.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return '';
    }
    parsed.hash = '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function safeArtworkUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return '';
  try {
    return /\.(?:svg|ico)(?:$|[?#])/i.test(new URL(url).pathname) ? '' : url;
  } catch (_) {
    return '';
  }
}

function assetRelayUrl(value) {
  return typeof value === 'string' && /^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(value)
    ? value
    : '';
}

function languageToken(value) {
  const token = cleanString(value, 32).toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(token) ? token.slice(0, 24) : '';
}

function yearFromDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return null;
  const year = new Date(stamp).getUTCFullYear();
  return year >= 1900 && year <= 3000 ? year : null;
}

function safeDownloadName(value, url, type) {
  const fallback = `podcast.${type === 'video' ? 'mp4' : 'mp3'}`;
  const raw = cleanString(value, 240) || filenameFromUrl(url, fallback);
  const extension = type === 'video' ? 'mp4' : 'mp3';
  let candidate = raw.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 190);
  if (candidate && !new RegExp(`\\.${extension}$`, 'i').test(candidate)) {
    const stem = candidate.replace(/\.[^.]{1,12}$/, '').replace(/[. ]+$/g, '') || 'podcast';
    candidate = `${stem.slice(0, 190 - extension.length)}.${extension}`;
  }
  if (candidate && candidate !== '.' && candidate !== '..'
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)) return candidate;
  return fallback;
}

function cloneItem(item) {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    capture_headers: { ...(item.capture_headers || {}) },
    ...(item._extra && typeof item._extra === 'object'
      ? { _extra: { ...item._extra, feedAliases: [...(item._extra.feedAliases || [])] } }
      : {}),
  };
}

async function defaultSha256Hex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
    throw new Error('SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function linkSignal(external, controller) {
  const onAbort = () => controller.abort(abortError(external.reason));
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  return () => external?.removeEventListener('abort', onAbort);
}

/** Burst-2 token bucket with one directory token refilled per second. */
export function createGpodderDirectoryGate(options = {}) {
  const capacity = Math.max(1, Number(options.capacity) || DIRECTORY_BURST);
  const refillMs = Math.max(1, Number(options.refillMs) || DIRECTORY_REFILL_MS);
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
  const queue = [];
  const jobs = new Set();
  let tokens = capacity;
  let lastRefill = now();
  let cooldownUntil = 0;
  let timer = null;
  let disposed = false;

  function refill() {
    const current = now();
    const steps = Math.floor(Math.max(0, current - lastRefill) / refillMs);
    if (steps > 0) {
      tokens = Math.min(capacity, tokens + steps);
      lastRefill += steps * refillMs;
    }
  }

  function clearWake() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function cleanup(job) {
    job.unlink();
    jobs.delete(job);
  }

  function scheduleWake() {
    if (disposed || timer !== null || queue.length === 0) return;
    refill();
    const current = now();
    const wait = current < cooldownUntil
      ? cooldownUntil - current
      : (tokens < 1 ? Math.max(1, lastRefill + refillMs - current) : 0);
    if (wait > 0) timer = setTimer(() => { timer = null; drain(); }, wait);
  }

  function start(job) {
    job.state = 'active';
    tokens -= 1;
    Promise.resolve().then(() => job.task(job.controller.signal)).then(
      (value) => { cleanup(job); job.resolve(value); },
      (error) => { cleanup(job); job.reject(error); },
    ).finally(drain);
  }

  function drain() {
    if (disposed) return;
    clearWake();
    refill();
    if (now() < cooldownUntil) {
      scheduleWake();
      return;
    }
    while (tokens >= 1 && queue.length > 0) {
      const job = queue.shift();
      if (job.controller.signal.aborted) {
        cleanup(job);
        job.reject(abortError(job.controller.signal.reason));
        continue;
      }
      start(job);
    }
    scheduleWake();
  }

  function run(task, signal) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(abortError('gPodder directory gate disposed'));
        return;
      }
      const controller = new AbortController();
      const job = {
        task, controller, resolve, reject, state: 'queued', unlink: () => {},
      };
      job.unlink = linkSignal(signal, controller);
      const onAbort = () => {
        if (job.state !== 'queued') return;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        cleanup(job);
        reject(abortError(controller.signal.reason));
        drain();
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const previousUnlink = job.unlink;
      job.unlink = () => {
        previousUnlink();
        controller.signal.removeEventListener('abort', onAbort);
      };
      if (controller.signal.aborted) {
        job.unlink();
        reject(abortError(controller.signal.reason));
        return;
      }
      jobs.add(job);
      queue.push(job);
      drain();
    });
  }

  function imposeCooldown(delayMs) {
    cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, Number(delayMs) || 0));
    clearWake();
    drain();
  }

  function dispose(reason = 'gPodder directory gate disposed') {
    if (disposed) return;
    disposed = true;
    clearWake();
    for (const job of [...jobs]) {
      if (job.state === 'queued') {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        cleanup(job);
        job.reject(abortError(reason));
      } else {
        job.controller.abort(abortError(reason));
      }
    }
  }

  return {
    run, imposeCooldown, dispose,
    get pendingCount() { return queue.length; },
    get activeCount() { return [...jobs].filter((job) => job.state === 'active').length; },
    get cooldownUntil() { return cooldownUntil; },
  };
}

/** Global-four, per-host-one scheduler for publisher feed resolution. */
export function createPodcastFeedScheduler(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 4);
  const perHost = Math.max(1, Number(options.perHost) || 1);
  const queue = [];
  const jobs = new Set();
  const activeHosts = new Map();
  let activeCount = 0;
  let disposed = false;

  function cleanup(job) {
    job.unlink();
    jobs.delete(job);
  }

  function finish(job) {
    activeCount -= 1;
    const count = (activeHosts.get(job.host) || 1) - 1;
    if (count > 0) activeHosts.set(job.host, count);
    else activeHosts.delete(job.host);
    cleanup(job);
    drain();
  }

  function start(job) {
    job.state = 'active';
    activeCount += 1;
    activeHosts.set(job.host, (activeHosts.get(job.host) || 0) + 1);
    Promise.resolve().then(() => job.task(job.controller.signal)).then(
      (value) => { job.resolve(value); },
      (error) => { job.reject(error); },
    ).finally(() => finish(job));
  }

  function drain() {
    if (disposed) return;
    while (activeCount < maxConcurrent) {
      const index = queue.findIndex((job) => (
        !job.controller.signal.aborted && (activeHosts.get(job.host) || 0) < perHost
      ));
      if (index < 0) break;
      start(queue.splice(index, 1)[0]);
    }
  }

  function run(host, task, signal) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(abortError('Podcast feed scheduler disposed'));
        return;
      }
      const normalizedHost = cleanString(host, 253).toLowerCase();
      if (!normalizedHost) {
        reject(new TypeError('Podcast feed scheduler requires a host'));
        return;
      }
      const controller = new AbortController();
      const job = {
        host: normalizedHost, task, controller, resolve, reject, state: 'queued', unlink: () => {},
      };
      job.unlink = linkSignal(signal, controller);
      const onAbort = () => {
        if (job.state !== 'queued') return;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        cleanup(job);
        reject(abortError(controller.signal.reason));
        drain();
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const previousUnlink = job.unlink;
      job.unlink = () => {
        previousUnlink();
        controller.signal.removeEventListener('abort', onAbort);
      };
      if (controller.signal.aborted) {
        job.unlink();
        reject(abortError(controller.signal.reason));
        return;
      }
      jobs.add(job);
      queue.push(job);
      drain();
    });
  }

  function dispose(reason = 'Podcast feed scheduler disposed') {
    if (disposed) return;
    disposed = true;
    for (const job of [...jobs]) {
      if (job.state === 'queued') {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        cleanup(job);
        job.reject(abortError(reason));
      } else {
        job.controller.abort(abortError(reason));
      }
    }
  }

  return {
    run, dispose,
    get pendingCount() { return queue.length; },
    get activeCount() { return activeCount; },
    get activeHosts() { return new Map(activeHosts); },
  };
}

function normalizeDirectoryResponse(payload, mode = 'browse') {
  if (!Array.isArray(payload) || payload.length > MAX_DIRECTORY_RESULTS) {
    throw new TypeError('gPodder returned an invalid or oversized directory response');
  }
  const shows = [];
  const seen = new Set();
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const feedUrl = safeHttpUrl(raw.url);
    if (!feedUrl || seen.has(feedUrl)) continue;
    seen.add(feedUrl);
    let host = '';
    try { host = new URL(feedUrl).hostname.toLowerCase(); } catch (_) { continue; }
    const title = cleanString(raw.title, 300) || host;
    const sourceUrl = safeHttpUrl(raw.website)
      || safeHttpUrl(raw.mygpo_link, { hosts: new Set(['gpodder.net', 'www.gpodder.net']) })
      || feedUrl;
    shows.push({
      feedUrl,
      host,
      title,
      author: cleanString(raw.author, 200),
      description: boundedPlainText(raw.description),
      artworkUrl: safeArtworkUrl(raw.logo_url) || safeArtworkUrl(raw.scaled_logo_url),
      sourceUrl,
      subscribers: Number.isFinite(Number(raw.subscribers))
        ? Math.max(0, Math.min(1_000_000_000, Number(raw.subscribers)))
        : 0,
    });
  }
  if (payload.length > 0 && shows.length === 0) {
    throw new TypeError('gPodder directory contained no usable canonical feeds');
  }
  if (mode === 'browse' && shows.length === 0) {
    throw new ProviderError('gPodder returned a suspicious empty toplist', {
      code: 'GPODDER_SUSPICIOUS_EMPTY', retryAfterMs: 60_000,
    });
  }
  return shows;
}

function enclosureMimeKind(mime) {
  const base = cleanString(mime, 128).toLowerCase().split(';', 1)[0].trim();
  if (!base) return { kind: '', hint: '' };
  if (base.includes('mpegurl')) {
    return { kind: 'hls', hint: base.startsWith('video/') ? 'video' : 'audio' };
  }
  if (['audio/mpeg', 'audio/mp3'].includes(base)) {
    return { kind: 'audio', hint: 'audio' };
  }
  if (base === 'video/mp4') return { kind: 'video', hint: 'video' };
  if (['application/octet-stream', 'binary/octet-stream'].includes(base)) return { kind: '', hint: '' };
  return { kind: 'unsupported', hint: '' };
}

function enclosureExtensionKind(url) {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) { return ''; }
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mp3')) return 'audio';
  if (path.endsWith('.mp4')) return 'video';
  if (/\.(?:m4a|aac|ogg|oga|webm|m4v|mov|mkv|flac|wav|opus|torrent)$/.test(path)) return 'unsupported';
  return '';
}

function podcastCodecCompatible(value, kind) {
  const codecs = cleanString(value, 256).toLowerCase();
  if (!codecs) return true;
  if (/\b(?:av01|flac|hev1|hvc1|opus|theora|vorbis|vp0?[89])\b/.test(codecs)) return false;
  if (kind === 'video') return /(?:^|[ ,])(?:avc1|avc3|h264)(?:[., ]|$)/.test(codecs);
  if (kind === 'audio') return /(?:^|[ ,])(?:mp3|mpga|mpeg)(?:[., ]|$)/.test(codecs);
  return true;
}

function podcastHlsHasVideo(value) {
  const codecs = cleanString(value, 256).toLowerCase();
  return /(?:^|[ ,])(?:avc1|avc3|h264)(?:[., ]|$)/.test(codecs);
}

export function selectPodcastEnclosure(values, { live = false } = {}) {
  if (!Array.isArray(values) || values.length > MAX_ENCLOSURES) return null;
  const candidates = [];
  for (const raw of values) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const url = safeHttpUrl(raw.url);
    if (!url) continue;
    const mime = enclosureMimeKind(raw.type);
    const extension = enclosureExtensionKind(url);
    if (mime.kind === 'unsupported' || extension === 'unsupported') continue;
    if (mime.kind && extension && mime.kind !== extension) continue;
    const kind = mime.kind || extension;
    if (!['audio', 'video', 'hls'].includes(kind)) continue;
    if (!podcastCodecCompatible(raw.codecs, kind)) continue;
    const mediaType = kind === 'hls'
      ? (mime.hint === 'video' || podcastHlsHasVideo(raw.codecs) ? 'video' : 'audio')
      : kind;
    const relation = raw.relation === 'alternate' ? 'alternate' : 'enclosure';
    const preferred = raw.default === true;
    let score = preferred ? 2_000 : (relation === 'enclosure' ? 1_500 : 0);
    if (live ? kind === 'hls' : kind !== 'hls') score += 300;
    if (mediaType === 'audio' && /\.mp3(?:$|[?#])/i.test(url)) score += 80;
    if (mediaType === 'video' && /\.mp4(?:$|[?#])/i.test(url)) score += 80;
    candidates.push({
      url,
      mediaType,
      streamKind: kind === 'hls' ? 'hls' : mediaType,
      relation,
      score,
    });
  }
  candidates.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  return candidates[0] || null;
}

export function isPodcastLiveNow(value, currentTime = Date.now()) {
  void currentTime;
  // Podcasting 2.0 defines status="live" as the canonical signal. Its start
  // and end values are schedules only and real broadcasts can begin early or
  // run late, so suppressing a status-live stream by the clock is incorrect.
  return value?.live === true && value.liveStatus === 'live';
}

function normalizeEpisode(raw, feed, show) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !STABLE_ID.test(raw.stable_id) || typeof raw.guid !== 'string'
      || !raw.guid.trim() || raw.guid.length > 1_024 || CONTROL_PATTERN.test(raw.guid)) return null;
  const live = raw.live === true;
  const selected = selectPodcastEnclosure(raw.enclosures, { live });
  if (!selected) return null;
  const contentRating = CONTENT_RATINGS.has(raw.content_rating)
    ? raw.content_rating
    : 'unrated';
  const type = live
    ? (selected.mediaType === 'video' ? 'tv' : 'radio')
    : selected.mediaType;
  const artworkUrl = safeArtworkUrl(raw.artwork_url)
    || safeArtworkUrl(feed.artworkUrl)
    || safeArtworkUrl(show.artworkUrl);
  const sourceUrl = safeHttpUrl(raw.homepage_url)
    || safeHttpUrl(feed.homepageUrl)
    || show.sourceUrl
    || feed.feedUrl;
  const title = cleanString(raw.title, 300) || feed.title || show.title || 'Podcast episode';
  const directDownload = !live && selected.streamKind !== 'hls';
  const license = cleanString(raw.license?.label, 240)
    || cleanString(feed.licenseLabel, 240)
    || 'See publisher';
  const published = cleanString(raw.published, 128);
  return makeItem({
    id: prefixId(id, raw.stable_id),
    title,
    description: boundedPlainText(raw.description || feed.description || show.description),
    source: id,
    type,
    stream_url: selected.url,
    stream_kind: selected.streamKind,
    delivery: live ? 'live' : 'on-demand',
    download_url: directDownload ? selected.url : '',
    download_name: directDownload
      ? safeDownloadName(filenameFromUrl(selected.url, ''), selected.url, selected.mediaType)
      : '',
    capture_headers: {},
    thumbnail: '',
    year: yearFromDate(published),
    country: '',
    language: languageToken(raw.language || feed.language),
    tags: ['podcast', ...(feed.title ? [feed.title] : [])].slice(0, 8),
    license,
    source_url: sourceUrl,
    content_rating: contentRating,
    _extra: {
      schemaVersion: 1,
      feedUrl: feed.feedUrl,
      resolvedFeedUrl: feed.resolvedFeedUrl,
      feedIdentityUrl: feed.feedIdentityUrl,
      feedAliases: [...feed.feedAliases],
      enclosureUrl: selected.url,
      artworkUrl,
      showTitle: feed.title || show.title,
      published,
      live,
      liveStatus: cleanString(raw.live_status, 32).toLowerCase(),
      start: cleanString(raw.start, 128),
      end: cleanString(raw.end, 128),
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: 'playable',
      snapshotItem: live,
      restartResolve: !live,
      needsArtwork: Boolean(artworkUrl),
      cacheState: feed.cacheState,
      cacheStale: feed.cacheStale,
    },
  });
}

function normalizeFeedPayload(payload, show) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.items) || payload.items.length > MAX_FEED_ITEMS) {
    throw new TypeError('Podcast resolver returned an invalid or oversized feed');
  }
  const feedUrl = safeHttpUrl(payload.feed_url);
  const resolvedFeedUrl = safeHttpUrl(payload.resolved_feed_url);
  const feedIdentityUrl = safeHttpUrl(payload.feed_identity_url);
  if (!feedUrl || !resolvedFeedUrl || !feedIdentityUrl) {
    throw new TypeError('Podcast resolver omitted canonical feed identities');
  }
  if (!Array.isArray(payload.feed_aliases) || payload.feed_aliases.length < 1
      || payload.feed_aliases.length > 8) {
    throw new TypeError('Podcast resolver returned invalid redirect aliases');
  }
  const feedAliases = [];
  for (const raw of payload.feed_aliases) {
    const alias = safeHttpUrl(raw);
    if (!alias) throw new TypeError('Podcast resolver returned an invalid redirect alias');
    if (!feedAliases.includes(alias)) feedAliases.push(alias);
  }
  if (!feedAliases.includes(show.feedUrl) || !feedAliases.includes(feedUrl)
      || !feedAliases.includes(resolvedFeedUrl) || !feedAliases.includes(feedIdentityUrl)) {
    throw new TypeError('Podcast resolver identity did not match the requested feed');
  }
  const cacheState = CACHE_STATES.has(payload.cache?.state) ? payload.cache.state : 'uncached';
  const cacheStale = payload.cache?.stale === true || cacheState === 'stale';
  const feed = {
    feedUrl,
    resolvedFeedUrl,
    feedIdentityUrl,
    feedAliases,
    title: cleanString(payload.title, 300) || show.title,
    description: boundedPlainText(payload.description || show.description),
    language: languageToken(payload.language),
    artworkUrl: safeArtworkUrl(payload.artwork_url) || show.artworkUrl,
    homepageUrl: safeHttpUrl(payload.homepage_url) || show.sourceUrl,
    licenseLabel: cleanString(payload.license?.label, 240),
    cacheState,
    cacheStale,
    items: [],
  };
  const seen = new Set();
  for (const raw of payload.items) {
    const item = normalizeEpisode(raw, feed, show);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    feed.items.push(item);
  }
  if (payload.items.length > 0 && feed.items.length === 0) {
    throw new TypeError('Podcast resolver returned no usable normalized episodes');
  }
  return feed;
}

function normalizeSearchText(value) {
  return cleanString(value, 300).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

function searchTokens(query) {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean).slice(0, 16);
}

function itemMatches(item, show, tokens) {
  if (tokens.length === 0) return true;
  const haystack = normalizeSearchText([
    item.title, item.description, item._extra?.showTitle,
    show.title, show.author, show.description,
  ].join(' '));
  return tokens.every((token) => haystack.includes(token));
}

function interleave(groups, limit = APP_PAGE_SIZE) {
  const out = [];
  const seen = new Set();
  for (let index = 0; out.length < limit && groups.some((group) => index < group.length); index++) {
    for (const group of groups) {
      if (index < group.length && !seen.has(group[index].id)) {
        seen.add(group[index].id);
        out.push(group[index]);
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function cloneCursor(value) {
  return {
    version: 1,
    snapshotId: value.snapshotId,
    feedIndex: value.feedIndex,
    revisitIndex: value.revisitIndex,
    positions: [...value.positions],
    attempted: [...value.attempted],
    dead: [...value.dead],
  };
}

function newBrowseCursor(snapshot) {
  return {
    version: 1,
    snapshotId: snapshot.id,
    feedIndex: 0,
    revisitIndex: 0,
    positions: Array(snapshot.shows.length).fill(0),
    attempted: Array(snapshot.shows.length).fill(false),
    dead: Array(snapshot.shows.length).fill(false),
  };
}

function normalizeBrowseCursor(value, snapshot) {
  if (value == null || value.snapshotId !== snapshot.id) return newBrowseCursor(snapshot);
  const length = snapshot.shows.length;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || !Number.isInteger(value.feedIndex) || value.feedIndex < 0 || value.feedIndex > length
      || !Number.isInteger(value.revisitIndex) || value.revisitIndex < 0 || value.revisitIndex > length
      || !Array.isArray(value.positions) || value.positions.length !== length
      || !Array.isArray(value.attempted) || value.attempted.length !== length
      || !Array.isArray(value.dead) || value.dead.length !== length) {
    throw new TypeError('Invalid gPodder browse cursor');
  }
  for (let index = 0; index < length; index++) {
    if (!Number.isInteger(value.positions[index]) || value.positions[index] < 0
        || value.positions[index] > MAX_EPISODES_PER_FEED
        || typeof value.attempted[index] !== 'boolean'
        || typeof value.dead[index] !== 'boolean'
        || value.dead[index] && !value.attempted[index]) {
      throw new TypeError('Malformed gPodder feed cursor state');
    }
  }
  return cloneCursor(value);
}

function normalizeSearchCursor(value, query, snapshotId) {
  if (value == null || value.query !== query || value.snapshotId !== snapshotId) {
    return { version: 1, query, snapshotId, offset: 0 };
  }
  if (!value || typeof value !== 'object' || value.version !== 1
      || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > MAX_SEARCH_RESULTS) {
    throw new TypeError('Invalid gPodder search cursor');
  }
  return { version: 1, query, snapshotId, offset: value.offset };
}

function feedFailureDelay(error) {
  const rawSeconds = error?.retryAfter;
  const rawMilliseconds = error?.retryAfterMs;
  const seconds = Number(rawSeconds);
  const milliseconds = Number(rawMilliseconds);
  if (rawSeconds != null && Number.isFinite(seconds)) {
    return Math.min(MAX_DEAD_FEED_COOLDOWN_MS, Math.max(1_000, seconds * 1_000));
  }
  if (rawMilliseconds != null && Number.isFinite(milliseconds)) {
    return Math.min(MAX_DEAD_FEED_COOLDOWN_MS, Math.max(1_000, milliseconds));
  }
  const status = Number(error?.status || 0);
  if (error?.code === 'CATALOG_UPSTREAM_STATUS' && error?.retryable !== true) {
    return MAX_DEAD_FEED_COOLDOWN_MS;
  }
  if (status === 404 || status === 410) return MAX_DEAD_FEED_COOLDOWN_MS;
  return DEAD_FEED_COOLDOWN_MS;
}

export function createGpodderAdapter(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const randomValue = dependencies.random || Math.random;
  const getJsonImpl = dependencies.getJson || getJson;
  const resolveFeedImpl = dependencies.resolvePodcastFeed || resolvePodcastFeed;
  const registerAssetImpl = dependencies.registerCatalogAsset || registerCatalogAsset;
  const hashText = dependencies.hashText || defaultSha256Hex;
  const directoryGate = dependencies.directoryGate || createGpodderDirectoryGate({
    now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    capacity: dependencies.directoryBurst,
    refillMs: dependencies.directoryRefillMs,
  });
  const feedScheduler = dependencies.feedScheduler || createPodcastFeedScheduler({
    maxConcurrent: dependencies.maxFeedConcurrent ?? 4,
    perHost: dependencies.maxFeedPerHost ?? 1,
  });
  const feedCache = new Map();
  const feedAliasKeys = new Map();
  const snapshots = new Map();
  const directorySearchCache = new Map();
  const searchResultsCache = new Map();
  const searchResultRuns = new Map();
  const reservoir = new Map();
  let toplistCache = null;
  let toplistLoad = null;
  let standaloneCursor = null;
  let standaloneExhausted = false;
  let standaloneExplicit = null;
  const standaloneBuffer = [];
  let snapshotSequence = 0;

  function showExplicit(opts = {}) {
    if (typeof opts.showExplicitContent === 'boolean') return opts.showExplicitContent;
    const supplied = typeof dependencies.showExplicitContent === 'function'
      ? dependencies.showExplicitContent()
      : dependencies.showExplicitContent;
    return supplied === true;
  }

  function directoryCooldown(error) {
    const status = Number(error?.status || 0);
    const rawMilliseconds = error?.retryAfterMs;
    const rawSeconds = error?.retryAfter;
    let delay = rawMilliseconds != null ? Number(rawMilliseconds) : NaN;
    if (!Number.isFinite(delay) && rawSeconds != null && Number.isFinite(Number(rawSeconds))) {
      delay = Number(error.retryAfter) * 1_000;
    }
    if (status === 429) delay = Math.max(60_000, delay || 0);
    else if (status >= 500) delay = Math.max(10_000, delay || 0);
    if (Number.isFinite(delay) && delay > 0) directoryGate.imposeCooldown(
      Math.min(60 * 60 * 1000, delay),
    );
  }

  function directoryRequest(url, opts = {}) {
    return directoryGate.run(async (signal) => {
      try {
        return await getJsonImpl(url, {
          signal,
          timeoutMs: opts.timeoutMs,
          maxBytes: DIRECTORY_JSON_MAX_BYTES,
          retries: 0,
        });
      } catch (error) {
        directoryCooldown(error);
        throw error;
      }
    }, opts.signal);
  }

  function rememberSnapshot(snapshot) {
    snapshots.delete(snapshot.id);
    snapshots.set(snapshot.id, snapshot);
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
  }

  async function makeSnapshot(shows, stale = false, error = null) {
    const sequence = ++snapshotSequence;
    const digest = await hashText(
      `gpodder-directory-v1\n${sequence}\n${shows.map((show) => show.feedUrl).join('\n')}`,
    );
    if (!STABLE_ID.test(digest)) throw new TypeError('gPodder snapshot hash is invalid');
    return {
      id: digest,
      shows,
      feedPages: new Map(),
      feedPageRuns: new Map(),
      stale,
      error: error ? cleanString(error.code || error.message, 120) : '',
      fetchedAt: now(),
    };
  }

  async function loadToplist(opts = {}) {
    const requestedId = opts.cursor?.snapshotId;
    if (typeof requestedId === 'string' && snapshots.has(requestedId)) {
      return snapshots.get(requestedId);
    }
    if (!opts.force && toplistCache
        && toplistCache.fetchedAt + (dependencies.directoryCacheTtlMs ?? DIRECTORY_CACHE_TTL_MS) > now()) {
      return toplistCache;
    }
    // `undefined === undefined` is true, so optional chaining alone would
    // mistake the absence of an in-flight load for a matching caller and then
    // dereference `null.promise` on every ordinary first browse.
    if (toplistLoad && toplistLoad.signal === opts.signal) return toplistLoad.promise;
    const load = { signal: opts.signal, promise: null };
    load.promise = directoryRequest(GPODDER_TOPLIST_URL, opts).then(async (payload) => {
      const snapshot = await makeSnapshot(normalizeDirectoryResponse(payload, 'browse'));
      if (toplistLoad === load) {
        toplistCache = snapshot;
        rememberSnapshot(snapshot);
      }
      return snapshot;
    }).catch((error) => {
      if (error?.name === 'AbortError') throw error;
      if (!toplistCache) throw error;
      const stale = { ...toplistCache, stale: true, error: cleanString(error.code || error.message, 120) };
      if (toplistLoad === load) rememberSnapshot(stale);
      return stale;
    }).finally(() => {
      if (toplistLoad === load) toplistLoad = null;
    });
    toplistLoad = load;
    return load.promise;
  }

  async function loadDirectorySearch(query, opts = {}) {
    const key = query;
    const existing = directorySearchCache.get(key);
    if (existing?.value && existing.expiresAt > now()) return existing.value;
    if (existing?.promise && existing.signal === opts.signal) return existing.promise;
    const target = new URL(GPODDER_SEARCH_URL);
    target.searchParams.set('q', query);
    const entry = { value: existing?.value || null, expiresAt: 0, promise: null, signal: opts.signal };
    entry.promise = directoryRequest(target.href, opts).then((payload) => {
      entry.value = normalizeDirectoryResponse(payload, 'search');
      entry.expiresAt = now() + (dependencies.searchCacheTtlMs ?? SEARCH_CACHE_TTL_MS);
      entry.promise = null;
      entry.signal = null;
      if (directorySearchCache.get(key) === entry) {
        directorySearchCache.delete(key);
        directorySearchCache.set(key, entry);
        while (directorySearchCache.size > MAX_SEARCH_CACHE) {
          directorySearchCache.delete(directorySearchCache.keys().next().value);
        }
      }
      return entry.value;
    }).catch((error) => {
      if (directorySearchCache.get(key) === entry) directorySearchCache.delete(key);
      if (error?.name !== 'AbortError' && existing?.value) return existing.value;
      throw error;
    });
    directorySearchCache.set(key, entry);
    return entry.promise;
  }

  function feedEntryFor(url) {
    const aliasKey = feedAliasKeys.get(url);
    const key = aliasKey && feedCache.has(aliasKey) ? aliasKey : url;
    const entry = feedCache.get(key);
    if (entry) {
      feedCache.delete(key);
      feedCache.set(key, entry);
    }
    return { key, entry };
  }

  function rememberFeedAliases(key, feed) {
    for (const alias of feed.feedAliases) {
      feedAliasKeys.delete(alias);
      feedAliasKeys.set(alias, key);
      while (feedAliasKeys.size > MAX_FEED_ALIASES) {
        feedAliasKeys.delete(feedAliasKeys.keys().next().value);
      }
    }
  }

  function trimFeedCache() {
    while (feedCache.size > MAX_FEED_CACHE) {
      const key = feedCache.keys().next().value;
      feedCache.delete(key);
      for (const [alias, target] of [...feedAliasKeys]) {
        if (target === key) feedAliasKeys.delete(alias);
      }
    }
  }

  function staleFeedValue(feed) {
    return {
      ...feed,
      cacheState: 'stale',
      cacheStale: true,
      items: feed.items.map((item) => ({
        ...cloneItem(item),
        _extra: {
          ...(item._extra || {}),
          feedAliases: [...(item._extra?.feedAliases || [])],
          cacheState: 'stale',
          cacheStale: true,
        },
      })),
    };
  }

  async function loadFeed(show, opts = {}) {
    const lookup = feedEntryFor(show.feedUrl);
    let entry = lookup.entry;
    if (entry?.value && entry.expiresAt > now()) return entry.value;
    if (entry?.deadUntil > now()) {
      if (entry.value) return staleFeedValue(entry.value);
      const error = new ProviderError('Podcast feed is cooling down', {
        code: 'PODCAST_FEED_COOLDOWN', retryAfterMs: entry.deadUntil - now(),
      });
      throw error;
    }
    if (entry?.promise && entry.signal === opts.signal) return entry.promise;
    const key = lookup.key;
    const previous = entry;
    entry = {
      value: previous?.value || null,
      expiresAt: 0,
      deadUntil: previous?.deadUntil || 0,
      promise: null,
      signal: opts.signal,
    };
    entry.promise = feedScheduler.run(show.host, async (signal) => {
      // Keep refreshing through the original cache key after a redirect move.
      // The native resolver associates the prior feed identity with that key,
      // which prevents episode/favorite IDs from changing across later moves.
      const payload = await resolveFeedImpl(key, { signal });
      return normalizeFeedPayload(payload, show);
    }, opts.signal).then((feed) => {
      entry.value = feed;
      entry.expiresAt = now() + (dependencies.feedCacheTtlMs ?? FEED_CACHE_TTL_MS);
      entry.deadUntil = 0;
      entry.promise = null;
      entry.signal = null;
      if (feedCache.get(key) === entry) {
        feedCache.delete(key);
        feedCache.set(key, entry);
        rememberFeedAliases(key, feed);
        trimFeedCache();
      }
      return feed;
    }).catch((error) => {
      if (error?.name === 'AbortError') {
        if (feedCache.get(key) === entry) {
          entry.promise = null;
          entry.signal = null;
        }
        throw error;
      }
      // A superseded in-flight generation may have completed successfully
      // while this newer refresh was queued. Preserve that validated value as
      // last-known-good if the newer publisher attempt then fails.
      if (!entry.value && previous?.value) entry.value = previous.value;
      entry.deadUntil = now() + feedFailureDelay(error);
      entry.promise = null;
      entry.signal = null;
      if (feedCache.get(key) === entry) {
        feedCache.delete(key);
        feedCache.set(key, entry);
        trimFeedCache();
      }
      if (entry.value) return staleFeedValue(entry.value);
      throw error;
    });
    feedCache.set(key, entry);
    trimFeedCache();
    return entry.promise;
  }

  function cachedFeed(show) {
    return feedEntryFor(show.feedUrl).entry?.value || null;
  }

  async function feedForSnapshot(snapshot, index, opts = {}) {
    const existing = snapshot.feedPages.get(index);
    if (existing) return existing;
    const run = {};
    snapshot.feedPageRuns.set(index, run);
    try {
      const feed = await loadFeed(snapshot.shows[index], opts);
      const frozen = {
        ...feed,
        feedAliases: [...feed.feedAliases],
        // The cursor deliberately exposes at most 14 episodes per show. Freeze
        // only that bounded prefix so feed prepends cannot shift a paused cursor.
        items: feed.items.slice(0, MAX_EPISODES_PER_FEED).map(cloneItem),
      };
      if (snapshot.feedPageRuns.get(index) === run) snapshot.feedPages.set(index, frozen);
      return frozen;
    } finally {
      if (snapshot.feedPageRuns.get(index) === run) snapshot.feedPageRuns.delete(index);
    }
  }

  function itemAllowed(item, explicit, currentTime) {
    if (!item || item.content_rating === 'explicit' && !explicit) return false;
    if (item._extra?.live) return isPodcastLiveNow({
      live: true,
      liveStatus: item._extra.liveStatus,
      start: item._extra.start,
      end: item._extra.end,
    }, currentTime);
    return true;
  }

  function addToReservoir(items) {
    for (const item of items) {
      reservoir.delete(item.id);
      reservoir.set(item.id, cloneItem(item));
      while (reservoir.size > MAX_RESERVOIR) reservoir.delete(reservoir.keys().next().value);
    }
  }

  async function processFeedIndices(snapshot, cursor, indices, opts = {}) {
    const results = await Promise.allSettled(indices.map((index) => (
      feedForSnapshot(snapshot, index, opts)
    )));
    const aborted = results.find((result) => result.status === 'rejected' && result.reason?.name === 'AbortError');
    if (aborted) throw aborted.reason;
    const explicit = showExplicit(opts);
    const currentTime = now();
    const groups = [];
    const reservoirEligible = new Set();
    for (let offset = 0; offset < indices.length; offset++) {
      const index = indices[offset];
      cursor.attempted[index] = true;
      const result = results[offset];
      if (result.status === 'rejected') {
        cursor.dead[index] = true;
        continue;
      }
      cursor.dead[index] = false;
      const feed = result.value;
      const start = cursor.positions[index];
      const end = Math.min(
        feed.items.length,
        MAX_EPISODES_PER_FEED,
        start + EPISODES_PER_FEED_BATCH,
      );
      cursor.positions[index] = end;
      const eligible = feed.items.slice(start, end)
        .filter((item) => itemAllowed(item, explicit, currentTime))
        .map(cloneItem);
      groups.push(eligible);
      if (snapshot.feedPages.get(index) === feed) {
        for (const item of eligible) reservoirEligible.add(item.id);
      }
    }
    const items = interleave(groups, APP_PAGE_SIZE);
    if (toplistCache === snapshot || snapshots.get(snapshot.id) === snapshot) {
      addToReservoir(items.filter((item) => reservoirEligible.has(item.id)));
    }
    return items;
  }

  function revisitIndices(snapshot, cursor) {
    const indices = [];
    const length = snapshot.shows.length;
    let scanned = 0;
    let index = cursor.revisitIndex >= length ? 0 : cursor.revisitIndex;
    while (scanned < length && indices.length < FEEDS_PER_BATCH) {
      if (cursor.attempted[index] && !cursor.dead[index]
          && cursor.positions[index] < MAX_EPISODES_PER_FEED) {
        const feed = snapshot.feedPages.get(index) || cachedFeed(snapshot.shows[index]);
        if (!feed || cursor.positions[index] < feed.items.length) indices.push(index);
      }
      index = (index + 1) % Math.max(1, length);
      scanned += 1;
    }
    cursor.revisitIndex = length ? index : 0;
    return indices;
  }

  function cursorHasRemaining(snapshot, cursor) {
    if (cursor.feedIndex < snapshot.shows.length) return true;
    for (let index = 0; index < snapshot.shows.length; index++) {
      if (!cursor.attempted[index] || cursor.dead[index]
          || cursor.positions[index] >= MAX_EPISODES_PER_FEED) continue;
      const feed = snapshot.feedPages.get(index) || cachedFeed(snapshot.shows[index]);
      if (!feed || cursor.positions[index] < feed.items.length) return true;
    }
    return false;
  }

  async function browsePage(opts = {}) {
    const snapshot = await loadToplist(opts);
    const cursor = normalizeBrowseCursor(opts.cursor, snapshot);
    const snapshotChanged = Boolean(opts.cursor && opts.cursor.snapshotId !== snapshot.id);
    let indices = [];
    if (cursor.feedIndex < snapshot.shows.length) {
      const end = Math.min(snapshot.shows.length, cursor.feedIndex + FEEDS_PER_BATCH);
      for (let index = cursor.feedIndex; index < end; index++) indices.push(index);
      cursor.feedIndex = end;
    } else {
      indices = revisitIndices(snapshot, cursor);
    }
    const items = indices.length ? await processFeedIndices(snapshot, cursor, indices, opts) : [];
    const exhausted = !cursorHasRemaining(snapshot, cursor);
    return {
      items,
      cursor: exhausted ? null : cursor,
      exhausted,
      snapshotId: snapshot.id,
      snapshotChanged,
      stale: snapshot.stale,
      attemptedFeeds: cursor.attempted.filter(Boolean).length,
      deadFeeds: cursor.dead.filter(Boolean).length,
    };
  }

  async function browse(opts = {}) {
    const explicit = showExplicit(opts);
    if (standaloneExplicit !== null && standaloneExplicit !== explicit) {
      standaloneCursor = null;
      standaloneExhausted = false;
      standaloneBuffer.length = 0;
    }
    standaloneExplicit = explicit;
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    let pages = 0;
    while (standaloneBuffer.length < limit && !standaloneExhausted && pages < 2) {
      pages += 1;
      const page = await browsePage({ ...opts, cursor: standaloneCursor });
      standaloneCursor = page.exhausted ? null : page.cursor;
      standaloneExhausted = page.exhausted;
      standaloneBuffer.push(...page.items.map(cloneItem));
    }
    const items = standaloneBuffer.splice(0, limit).map(cloneItem);
    if (standaloneExhausted && standaloneBuffer.length === 0) {
      standaloneExhausted = false;
      standaloneCursor = null;
    }
    return items;
  }

  async function performSearch(query, opts = {}) {
    const explicit = showExplicit(opts);
    const cacheKey = `${query}\u0000${explicit}`;
    const existing = searchResultsCache.get(cacheKey);
    if (existing && existing.expiresAt > now()) return existing;
    const searchRun = {};
    searchResultRuns.set(cacheKey, searchRun);
    try {
      const shows = (await loadDirectorySearch(query, opts)).slice(0, MAX_SEARCH_FEEDS);
      const settled = await Promise.allSettled(shows.map((show) => loadFeed(show, opts)));
      const aborted = settled.find((result) => (
        result.status === 'rejected' && result.reason?.name === 'AbortError'
      ));
      if (aborted) throw aborted.reason;
      const tokens = searchTokens(query);
      const currentTime = now();
      const groups = [];
      const failedFeeds = [];
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === 'rejected') {
          failedFeeds.push(shows[index].feedUrl);
          opts.onFeedError?.(shows[index], result.reason);
          continue;
        }
        groups.push(result.value.items.filter((item) => (
          itemAllowed(item, explicit, currentTime) && itemMatches(item, shows[index], tokens)
        )).slice(0, MAX_SEARCH_EPISODES_PER_FEED).map(cloneItem));
      }
      const items = interleave(groups, MAX_SEARCH_RESULTS);
      const snapshotId = await hashText([
        query,
        String(explicit),
        ...shows.map((show) => show.feedUrl),
        ...items.map((item) => item.id),
      ].join('\n'));
      if (!STABLE_ID.test(snapshotId)) {
        throw new TypeError('gPodder search snapshot hash is invalid');
      }
      const result = {
        items: items.map(cloneItem),
        snapshotId,
        partial: failedFeeds.length > 0,
        failedFeeds,
        expiresAt: now() + (failedFeeds.length ? PARTIAL_SEARCH_TTL_MS : SEARCH_CACHE_TTL_MS),
      };
      if (searchResultRuns.get(cacheKey) === searchRun) {
        addToReservoir(items);
        searchResultsCache.delete(cacheKey);
        searchResultsCache.set(cacheKey, result);
        searchResultRuns.delete(cacheKey);
        while (searchResultsCache.size > MAX_SEARCH_CACHE) {
          searchResultsCache.delete(searchResultsCache.keys().next().value);
        }
      }
      return result;
    } finally {
      if (searchResultRuns.get(cacheKey) === searchRun) searchResultRuns.delete(cacheKey);
    }
  }

  async function searchPage(query, opts = {}) {
    const normalized = cleanString(query, 200);
    if (!normalized) return { items: [], cursor: null, exhausted: true };
    const results = await performSearch(normalized, opts);
    const cursor = normalizeSearchCursor(opts.cursor, normalized, results.snapshotId);
    const items = results.items.slice(cursor.offset, cursor.offset + APP_PAGE_SIZE).map(cloneItem);
    cursor.offset += items.length;
    const exhausted = cursor.offset >= results.items.length;
    return {
      items,
      cursor: exhausted ? null : cursor,
      exhausted,
      partial: results.partial,
      failedFeeds: [...results.failedFeeds],
    };
  }

  async function search(query, opts = {}) {
    const normalized = cleanString(query, 200);
    if (!normalized) return [];
    const results = await performSearch(normalized, opts);
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    const items = results.items.slice(offset, offset + limit).map(cloneItem);
    Object.defineProperty(items, 'gpodderSearchState', {
      enumerable: false,
      configurable: false,
      value: Object.freeze({
        partial: results.partial,
        failedFeeds: Object.freeze([...results.failedFeeds]),
      }),
    });
    return items;
  }

  async function random(opts = {}) {
    const explicit = showExplicit(opts);
    const currentTime = now();
    const items = [...reservoir.values()]
      .filter((item) => itemAllowed(item, explicit, currentTime))
      .map(cloneItem);
    for (let index = items.length - 1; index > 0; index--) {
      const value = Number(randomValue());
      const other = Number.isFinite(value)
        ? Math.max(0, Math.min(index, Math.floor(value * (index + 1))))
        : 0;
      [items[index], items[other]] = [items[other], items[index]];
    }
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || 12));
    return items.slice(0, limit);
  }

  function favoriteShow(item) {
    const extra = item?._extra && typeof item._extra === 'object' ? item._extra : {};
    const candidates = [
      extra.feedUrl, extra.resolvedFeedUrl, extra.feedIdentityUrl,
      ...(Array.isArray(extra.feedAliases) ? extra.feedAliases : []),
    ];
    const feedUrl = candidates.map((value) => safeHttpUrl(value)).find(Boolean) || '';
    if (!feedUrl) return null;
    let host;
    try { host = new URL(feedUrl).hostname.toLowerCase(); } catch (_) { return null; }
    return {
      feedUrl,
      host,
      title: cleanString(extra.showTitle, 300) || cleanString(item.title, 300) || host,
      author: '',
      description: boundedPlainText(item.description),
      artworkUrl: safeArtworkUrl(extra.artworkUrl),
      sourceUrl: safeHttpUrl(item.source_url) || feedUrl,
      subscribers: 0,
    };
  }

  function markFavoriteUnavailable(item, reason) {
    const dynamic = item.delivery === 'live' || item._extra?.live === true;
    item.stream_url = '';
    item.download_url = '';
    item.download_name = '';
    item.capture_headers = {};
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: 'unavailable',
      validationError: reason,
      snapshotItem: dynamic,
    };
    return item;
  }

  async function resolveStream(item, opts = {}) {
    if (!item || item.source !== id) return item;
    const needsResolve = item._extra?.needsResolve === true
      || !item.stream_url || item.__snapshotOffline === true;
    if (!needsResolve) return item;
    const show = favoriteShow(item);
    if (!show) return markFavoriteUnavailable(item, 'PODCAST_IDENTITY_INVALID');
    if (opts.force === true || item.__snapshotOffline === true) {
      const cached = feedEntryFor(show.feedUrl).entry;
      if (cached && !cached.promise) cached.expiresAt = 0;
    }
    const feed = await loadFeed(show, opts);
    const resolved = feed.items.find((candidate) => candidate.id === item.id);
    if (!resolved || resolved.delivery === 'live'
        && !isPodcastLiveNow(resolved._extra, now())) {
      return markFavoriteUnavailable(item, 'PODCAST_EPISODE_UNAVAILABLE');
    }
    const explicit = showExplicit(opts);
    if (resolved.content_rating === 'explicit' && !explicit) {
      item.content_rating = 'explicit';
      item.stream_url = '';
      item.download_url = '';
      item.download_name = '';
      item._extra = {
        ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
        needsResolve: true,
        downloadResolved: true,
        resolutionStatus: 'hidden',
        snapshotItem: resolved.delivery === 'live',
      };
      throw new ProviderError('This podcast item is hidden by the content setting', {
        code: 'PODCAST_EXPLICIT_HIDDEN',
      });
    }
    Object.assign(item, cloneItem(resolved), { __snapshotOffline: false });
    return item;
  }

  async function resolveArtwork(item, opts = {}) {
    if (!item || item.source !== id) return item;
    if (assetRelayUrl(item.thumbnail)) return item;
    const artworkUrl = safeArtworkUrl(item._extra?.artworkUrl)
      || safeArtworkUrl(item.thumbnail);
    if (!artworkUrl) {
      item.thumbnail = '';
      return item;
    }
    item.thumbnail = '';
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
      artworkUrl,
      needsArtwork: true,
    };
    const registration = await registerAssetImpl({
      url: artworkUrl,
      sourceId: id,
      itemId: item.id,
    }, { signal: opts.signal });
    const relayUrl = assetRelayUrl(registration?.relay_url);
    if (!relayUrl) throw new TypeError('Artwork relay returned an invalid podcast registration');
    item.thumbnail = relayUrl;
    item._extra.needsArtwork = false;
    return item;
  }

  function dispose() {
    directoryGate.dispose?.('gPodder adapter disposed');
    feedScheduler.dispose?.('gPodder adapter disposed');
    toplistCache = null;
    toplistLoad = null;
    standaloneCursor = null;
    standaloneExhausted = false;
    standaloneExplicit = null;
    standaloneBuffer.length = 0;
    feedCache.clear();
    feedAliasKeys.clear();
    snapshots.clear();
    directorySearchCache.clear();
    searchResultsCache.clear();
    searchResultRuns.clear();
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

const defaultAdapter = createGpodderAdapter();

export const browse = (...args) => defaultAdapter.browse(...args);
export const browsePage = (...args) => defaultAdapter.browsePage(...args);
export const search = (...args) => defaultAdapter.search(...args);
export const searchPage = (...args) => defaultAdapter.searchPage(...args);
export const random = (...args) => defaultAdapter.random(...args);
export const resolveStream = (...args) => defaultAdapter.resolveStream(...args);
export const resolveArtwork = (...args) => defaultAdapter.resolveArtwork(...args);
export const dispose = (...args) => defaultAdapter.dispose(...args);
