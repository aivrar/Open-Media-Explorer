/**
 * media.ccc.de / C3VOC adapter.
 *
 * The archive and live directory are deliberately separate lanes: recent VOD
 * pages have a finite RFC-Link cursor, while C3VOC rooms form a refreshable
 * snapshot. Event recordings and dynamic artwork resolve only when needed.
 */

import {
  getJson, getJsonWithMetadata, postJson, ProviderError,
} from '../lib/http.js';
import {
  detectStreamKind, filenameFromUrl, makeItem, prefixId,
} from '../lib/item-model.js';
import { registerCatalogAsset } from '../lib/catalog-client.js';

export const id = 'media-ccc';
export const displayName = 'media.ccc.de';
export const itemTypes = ['video', 'audio', 'tv', 'radio'];
export const catalogPolicy = Object.freeze({ maxConcurrent: 2, minIntervalMs: 500 });

export const MEDIA_CCC_RECENT_URL = 'https://api.media.ccc.de/public/events/recent';
export const MEDIA_CCC_DETAIL_URL = 'https://api.media.ccc.de/public/events';
export const MEDIA_CCC_GRAPHQL_URL = 'https://media.ccc.de/graphql';
export const MEDIA_CCC_LIVE_URL = 'https://streaming.media.ccc.de/streams/v2.json';
export const MEDIA_CCC_SEARCH_QUERY = `
query WorldMediaLectureSearch($query: String!, $page: Int!) {
  lectureSearch(query: $query, page: $page) {
    guid
    title
    slug
  }
}`.trim();

const APP_PAGE_SIZE = 30;
const UPSTREAM_PAGE_SIZE = 100;
const MAX_UPSTREAM_PAGE = 100_000;
const MAX_BROWSE_SCAN_PAGES = 10;
const MAX_BROWSE_SEEN = 50_000;
const MAX_RECENT_CACHE_PAGES = 8;
const MAX_DETAIL_CACHE_ITEMS = 128;
const MAX_SEARCH_CACHE_ITEMS = 32;
const MAX_RESERVOIR_ITEMS = 300;
const RECENT_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 10 * 1000;
const LIVE_REFRESH_AFTER_MS = 60 * 1000;
const MAX_DESCRIPTION_INPUT = 16_000;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_TAG_VALUES_INSPECTED = 128;
const MAX_RECORDINGS = 256;
const MAX_SEARCH_RESULTS = 100;
const MAX_LIVE_CONFERENCES = 64;
const MAX_LIVE_GROUPS_PER_CONFERENCE = 64;
const MAX_LIVE_ROOMS = 2_048;
const MAX_LIVE_STREAMS_PER_ROOM = 64;
const MAX_LIVE_URLS_PER_STREAM = 32;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|key|password|signature|token)$/i;

const LANGUAGE_CODES = Object.freeze({
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it',
  por: 'pt', rus: 'ru', nld: 'nl', dut: 'nl', pol: 'pl', ces: 'cs', cze: 'cs',
  swe: 'sv', fin: 'fi', nor: 'no', dan: 'da', jpn: 'ja', zho: 'zh', chi: 'zh',
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

/** Convert provider HTML to bounded plain text before it reaches app state. */
export function boundedPlainText(value, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (typeof value !== 'string' || !value) return '';
  const bounded = value.slice(0, MAX_DESCRIPTION_INPUT)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlEntities(bounded)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || MAX_DESCRIPTION_LENGTH));
}

function identifier(value, maxLength = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength || CONTROL_PATTERN.test(text)) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(text) ? text : '';
}

function languageToken(value) {
  const text = cleanString(value, 24).toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(text) ? text : '';
}

function itemLanguage(value) {
  const token = languageToken(value);
  return LANGUAGE_CODES[token] || token.slice(0, 8);
}

function yearFromDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const year = new Date(timestamp).getUTCFullYear();
  return year >= 1900 && year <= 3000 ? year : null;
}

function safeHttpUrl(value, options = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return '';
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (options.httpsOnly && parsed.protocol !== 'https:') return '';
    if (options.hosts && !options.hosts.has(parsed.hostname.toLowerCase())) return '';
    if (options.rejectSensitiveQuery) {
      for (const key of parsed.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return '';
    }
    parsed.hash = '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function canonicalArtworkUrl(value) {
  const url = safeHttpUrl(value, { httpsOnly: true, rejectSensitiveQuery: true });
  if (!url) return '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'static.media.ccc.de'
      || host === 'streaming.media.ccc.de'
      || host.endsWith('.media.ccc.de')
      || host.endsWith('.c3voc.de') ? url : '';
  } catch (_) {
    return '';
  }
}

function canonicalSourceUrl(value, fallback = '') {
  const url = safeHttpUrl(value, { httpsOnly: true });
  if (url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'media.ccc.de' || host === 'streaming.media.ccc.de') return url;
  }
  return fallback;
}

function normalizeTags(...values) {
  const result = [];
  const seen = new Set();
  const stack = values.slice(0, MAX_TAG_VALUES_INSPECTED).reverse();
  let inspected = 0;
  while (stack.length > 0 && inspected < MAX_TAG_VALUES_INSPECTED) {
    const value = stack.pop();
    inspected += 1;
    if (Array.isArray(value)) {
      const remaining = Math.max(0, MAX_TAG_VALUES_INSPECTED - inspected - stack.length);
      for (let index = Math.min(value.length, remaining) - 1; index >= 0; index--) {
        stack.push(value[index]);
      }
      continue;
    }
    const text = cleanString(typeof value === 'object' ? value?.name : value, 64);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= 16) break;
  }
  return result;
}

function explicitLicense(...values) {
  for (const value of values) {
    const candidate = typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value.name || value.label || value.title)
        : '';
    const text = boundedPlainText(candidate, 160);
    if (text) return text;
  }
  return 'See event license';
}

function safeDownloadName(value, url, type) {
  const candidate = typeof value === 'string'
    ? value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim()
    : '';
  if (candidate && candidate !== '.' && candidate !== '..') return candidate.slice(0, 240);
  return filenameFromUrl(url, `media-ccc-recording.${type === 'video' ? 'mp4' : 'mp3'}`);
}

function relationSegments(value) {
  const segments = [];
  let start = 0;
  let angleDepth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === ',' && angleDepth === 0) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

/** Parse RFC Link relations by their rel parameter, independent of ordering. */
export function parseLinkHeader(value) {
  const relations = Object.create(null);
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384
      || /[\r\n\0]/.test(value)) return relations;
  for (const segment of relationSegments(value)) {
    const target = segment.match(/^\s*<([^<>]+)>/);
    if (!target) continue;
    const url = safeHttpUrl(target[1], { httpsOnly: true });
    if (!url) continue;
    const parameters = segment.slice(target[0].length);
    const rel = parameters.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i);
    const names = (rel?.[1] || rel?.[2] || '').split(/\s+/).filter(Boolean);
    for (const name of names) {
      const key = name.toLowerCase();
      if (!relations[key]) relations[key] = url;
    }
  }
  return relations;
}

function recentPageNumber(value, currentPage, options = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.media.ccc.de'
        || url.pathname.replace(/\/+$/, '') !== '/public/events/recent') return null;
    const page = Number(url.searchParams.get('page'));
    const isAdvancing = options.allowCurrent ? page >= currentPage : page > currentPage;
    if (!Number.isInteger(page) || !isAdvancing || page > MAX_UPSTREAM_PAGE) return null;
    return page;
  } catch (_) {
    return null;
  }
}

function createRequestGate(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 1);
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
  const queue = [];
  let active = 0;
  let nextStartAt = 0;
  let timer = null;

  function clearWake() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function drain() {
    if (timer !== null) return;
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue[0];
      if (job.signal?.aborted) {
        queue.shift();
        job.signal.removeEventListener('abort', job.onAbort);
        job.reject(abortError(job.signal.reason));
        continue;
      }
      const waitMs = nextStartAt - now();
      if (waitMs > 0) {
        timer = setTimer(() => { timer = null; drain(); }, waitMs);
        return;
      }
      queue.shift();
      job.signal?.removeEventListener('abort', job.onAbort);
      active += 1;
      nextStartAt = now() + minIntervalMs;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        active = Math.max(0, active - 1);
        drain();
      });
    }
  }

  return (task, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const job = { task, signal, resolve, reject, onAbort: null };
    job.onAbort = () => {
      const index = queue.indexOf(job);
      if (index >= 0) {
        queue.splice(index, 1);
        signal.removeEventListener('abort', job.onAbort);
        reject(abortError(signal.reason));
        if (queue.length === 0) clearWake();
        drain();
      }
    };
    signal?.addEventListener('abort', job.onAbort, { once: true });
    queue.push(job);
    drain();
  });
}

function cachedLoad(cache, key, options, loader) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
  const now = options.now();
  const existing = cache.get(key);
  if (existing?.promise && existing.signal === options.signal) return existing.promise;
  if (existing && existing.expiresAt > now) {
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
  while (cache.size > options.maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === key && cache.size === 1) break;
    cache.delete(oldest);
  }
  return promise;
}

function vodItem(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const guid = identifier(event.guid);
  if (!guid) return null;
  const slug = identifier(event.slug) || guid;
  const title = cleanString(event.title, 300) || 'media.ccc.de event';
  const artworkUrl = canonicalArtworkUrl(event.thumb_url)
    || canonicalArtworkUrl(event.poster_url);
  const sourceUrl = canonicalSourceUrl(
    event.frontend_link,
    `https://media.ccc.de/v/${encodeURIComponent(slug)}`,
  );
  const originalLanguage = languageToken(event.original_language);
  return makeItem({
    id: prefixId(id, guid),
    title,
    description: boundedPlainText(event.description || event.subtitle || ''),
    source: id,
    type: 'video',
    stream_url: '',
    stream_kind: 'video',
    delivery: 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: '',
    year: yearFromDate(event.release_date || event.date),
    country: '',
    language: itemLanguage(originalLanguage),
    tags: normalizeTags(event.tags, event.persons, event.conference_title),
    license: explicitLicense(event.license, event.recording_license),
    source_url: sourceUrl,
    content_rating: 'unrated',
    _extra: {
      schemaVersion: 1,
      guid,
      slug,
      detailUrl: `${MEDIA_CCC_DETAIL_URL}/${encodeURIComponent(guid)}`,
      originalLanguage,
      artworkUrl,
      needsResolve: true,
      restartResolve: true,
    },
  });
}

function selectedRecording(detail, originalLanguage) {
  if (!Object.hasOwn(detail, 'recordings') || detail.recordings == null) return null;
  if (!Array.isArray(detail.recordings)) throw new TypeError('media.ccc.de event recordings are malformed');
  if (detail.recordings.length > MAX_RECORDINGS) {
    throw new TypeError('media.ccc.de event recordings exceeded the supported bound');
  }
  const language = languageToken(detail.original_language) || originalLanguage;
  const candidates = detail.recordings.map((recording, index) => {
    if (!recording || typeof recording !== 'object' || Array.isArray(recording)) return null;
    const url = safeHttpUrl(recording.recording_url);
    if (!url) return null;
    const recordingLanguage = languageToken(recording.language);
    if (language && recordingLanguage !== language) return null;
    const mime = cleanString(recording.mime_type, 80).toLowerCase();
    const isMp4 = mime === 'video/mp4' && /\.mp4(?:[?#]|$)/i.test(url);
    const isMp3 = (mime === 'audio/mpeg' || mime === 'audio/mp3')
      && /\.mp3(?:[?#]|$)/i.test(url);
    if (!isMp4 && !isMp3) return null;
    const width = Math.max(0, Number(recording.width) || 0);
    const height = Math.max(0, Number(recording.height) || 0);
    return {
      recording,
      url,
      type: isMp4 ? 'video' : 'audio',
      index,
      score: (recording.high_quality === true ? 10 ** 12 : 0) + width * height,
    };
  }).filter(Boolean);
  const videos = candidates.filter((candidate) => candidate.type === 'video')
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (videos.length) return videos[0];
  return candidates.filter((candidate) => candidate.type === 'audio')
    .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
}

function streamUrl(stream, kind) {
  const entries = [];
  if (stream?.urls && typeof stream.urls === 'object' && !Array.isArray(stream.urls)) {
    for (const key in stream.urls) {
      if (!Object.hasOwn(stream.urls, key)) continue;
      if (entries.length >= MAX_LIVE_URLS_PER_STREAM) {
        throw new TypeError('C3VOC live stream URL collection exceeded the supported bound');
      }
      entries.push([key, stream.urls[key]]);
    }
  }
  const preferred = kind === 'video'
    ? entries.filter(([key]) => key.toLowerCase() === 'hls')
    : [
        ...entries.filter(([key]) => key.toLowerCase() === 'mp3'),
        ...entries.filter(([key]) => ['opus', 'ogg', 'audio'].includes(key.toLowerCase())),
      ];
  const fallback = kind === 'video'
    ? entries.filter(([, value]) => /\.m3u8(?:[?#]|$)/i.test(value?.url || ''))
    : entries.filter(([, value]) => /\.(?:mp3|ogg|opus|aac)(?:[?#]|$)/i.test(value?.url || ''));
  for (const [, value] of [...preferred, ...fallback]) {
    const url = safeHttpUrl(value?.url);
    if (url) return url;
  }
  return '';
}

function liveCandidate(room) {
  if (!Array.isArray(room?.streams)) return null;
  if (room.streams.length > MAX_LIVE_STREAMS_PER_ROOM) {
    throw new TypeError('C3VOC live room stream collection exceeded the supported bound');
  }
  const candidates = [];
  for (let index = 0; index < room.streams.length; index++) {
    const stream = room.streams[index];
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) continue;
    const label = `${stream.slug || ''} ${stream.display || ''}`.toLowerCase();
    const slides = stream.type === 'slides' || /\b(?:slides?|presentation)\b/.test(label);
    const translated = stream.isTranslated === true || /\btranslat(?:ed|ion)\b/.test(label);
    const videoUrl = streamUrl(stream, 'video');
    const audioUrl = streamUrl(stream, 'audio');
    const size = Array.isArray(stream.videoSize) ? stream.videoSize : [];
    const pixels = Math.max(0, Number(size[0]) || 0) * Math.max(0, Number(size[1]) || 0);
    if (videoUrl) {
      candidates.push({
        stream, url: videoUrl, kind: 'video', slides, translated, pixels, index,
        priority: slides ? 4 : translated ? 2 : 0,
      });
    } else if (audioUrl) {
      candidates.push({
        stream, url: audioUrl, kind: 'audio', slides, translated, pixels: 0, index,
        priority: slides ? 4 : translated ? 3 : 1,
      });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority
    || right.pixels - left.pixels || left.index - right.index);
  return candidates[0] || null;
}

function snapshotHash(items) {
  let hash = 0x811c9dc5;
  const text = items.map((item) => `${item.id}\n${item.stream_url}`).sort().join('\n');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function cloneItem(item) {
  return {
    ...item,
    tags: Array.isArray(item?.tags) ? [...item.tags] : [],
    capture_headers: { ...(item?.capture_headers || {}) },
    ...(item?._extra && typeof item._extra === 'object'
      ? { _extra: { ...item._extra } }
      : {}),
  };
}

function liveItems(payload) {
  if (!Array.isArray(payload)) throw new TypeError('C3VOC returned an invalid live snapshot');
  if (payload.length > MAX_LIVE_CONFERENCES) {
    throw new TypeError('C3VOC live conference collection exceeded the supported bound');
  }
  const items = [];
  const seen = new Set();
  let roomCount = 0;
  for (const conference of payload) {
    if (!conference || typeof conference !== 'object' || Array.isArray(conference)) continue;
    const conferenceSlug = identifier(conference.slug);
    if (!conferenceSlug || !Array.isArray(conference.groups)) continue;
    if (conference.groups.length > MAX_LIVE_GROUPS_PER_CONFERENCE) {
      throw new TypeError('C3VOC live group collection exceeded the supported bound');
    }
    const conferenceTitle = cleanString(conference.conference, 200) || conferenceSlug;
    for (const group of conference.groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.rooms)) continue;
      roomCount += group.rooms.length;
      if (roomCount > MAX_LIVE_ROOMS) {
        throw new TypeError('C3VOC live room collection exceeded the supported bound');
      }
      for (const room of group.rooms) {
        const roomSlug = identifier(room?.slug);
        if (!roomSlug) continue;
        const selected = liveCandidate(room);
        if (!selected) continue;
        const languageKey = selected.slides ? 'slides' : selected.translated ? 'translated' : 'native';
        const itemId = prefixId(id, `live:${conferenceSlug}/${roomSlug}/${languageKey}`);
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        const isVideo = selected.kind === 'video';
        const roomTitle = cleanString(room.display, 200)
          || cleanString(selected.stream.display, 200)
          || roomSlug;
        const fallbackUrl = `https://streaming.media.ccc.de/${encodeURIComponent(conferenceSlug)}/${encodeURIComponent(roomSlug)}`;
        const artworkUrl = canonicalArtworkUrl(room.thumb);
        items.push(makeItem({
          id: itemId,
          title: cleanString(`${conferenceTitle} — ${roomTitle}`, 300),
          description: boundedPlainText(conference.description || ''),
          source: id,
          type: isVideo ? 'tv' : 'radio',
          stream_url: selected.url,
          stream_kind: isVideo ? 'hls' : detectStreamKind(selected.url, 'audio'),
          delivery: 'live',
          download_url: '',
          download_name: '',
          capture_headers: {},
          thumbnail: '',
          year: yearFromDate(conference.startsAt),
          country: '',
          language: itemLanguage(selected.stream.language || selected.stream.lang),
          tags: normalizeTags(group.group, conference.author, isVideo ? 'live video' : 'live audio'),
          license: explicitLicense(selected.stream.license, room.license, conference.license),
          source_url: canonicalSourceUrl(room.link, fallbackUrl),
          content_rating: 'unrated',
          _extra: {
            schemaVersion: 1,
            conferenceSlug,
            roomSlug,
            languageKey,
            artworkUrl,
            needsResolve: false,
            downloadResolved: true,
            resolutionStatus: 'playable',
            snapshotItem: true,
          },
        }));
      }
    }
  }
  if (payload.length > 0 && items.length === 0) {
    throw new TypeError('C3VOC live snapshot contained no usable rooms');
  }
  return items;
}

function assetRelayUrl(value) {
  return typeof value === 'string' && /^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(value)
    ? value
    : '';
}

export function createMediaCccAdapter(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const randomValue = dependencies.random || Math.random;
  const requestGate = createRequestGate({
    maxConcurrent: dependencies.maxConcurrent ?? catalogPolicy.maxConcurrent,
    minIntervalMs: dependencies.minIntervalMs ?? catalogPolicy.minIntervalMs,
    now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
  });
  const getJsonImpl = dependencies.getJson || getJson;
  const getJsonWithMetadataImpl = dependencies.getJsonWithMetadata || getJsonWithMetadata;
  const postJsonImpl = dependencies.postJson || postJson;
  const registerAssetImpl = dependencies.registerCatalogAsset || registerCatalogAsset;
  const recentCache = new Map();
  const detailCache = new Map();
  const searchCache = new Map();
  const liveCache = new Map();
  const reservoir = new Map();
  const browseSessions = new Map();
  let browseSessionSequence = 0;

  const gated = (task, signal) => requestGate(task, signal);

  function addToReservoir(items) {
    for (const item of items) {
      if (!item?.id || item.delivery !== 'on-demand') continue;
      reservoir.delete(item.id);
      reservoir.set(item.id, item);
      while (reservoir.size > MAX_RESERVOIR_ITEMS) reservoir.delete(reservoir.keys().next().value);
    }
  }

  async function recentPage(page, opts = {}) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_UPSTREAM_PAGE) {
      throw new TypeError('Invalid media.ccc.de browse page');
    }
    return cachedLoad(recentCache, page, {
      now,
      signal: opts.signal,
      ttlMs: dependencies.recentCacheTtlMs ?? RECENT_CACHE_TTL_MS,
      maxEntries: MAX_RECENT_CACHE_PAGES,
    }, async () => {
      const metadata = await gated(() => getJsonWithMetadataImpl(
        `${MEDIA_CCC_RECENT_URL}?page=${page}`,
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      ), opts.signal);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
          || !metadata.data || typeof metadata.data !== 'object'
          || !Array.isArray(metadata.data.events)) {
        throw new TypeError('media.ccc.de returned an invalid recent-events response');
      }
      if (metadata.data.events.length > UPSTREAM_PAGE_SIZE) {
        throw new TypeError('media.ccc.de recent-events page exceeded its documented size');
      }
      if (metadata.data.events.length === 0) {
        throw new TypeError('media.ccc.de returned a suspicious empty recent-events page');
      }
      const linkHeader = metadata.headers?.link;
      if (typeof linkHeader !== 'string' || !linkHeader.trim()) {
        throw new TypeError('media.ccc.de recent-events response omitted RFC Link pagination');
      }
      const relations = parseLinkHeader(linkHeader);
      const lastPage = relations.last
        ? recentPageNumber(relations.last, page, { allowCurrent: true })
        : null;
      if (relations.last && !lastPage) {
        throw new TypeError('media.ccc.de returned an invalid last-page link');
      }
      let nextPage = null;
      if (relations.next) {
        nextPage = recentPageNumber(relations.next, page);
        if (!nextPage) throw new TypeError('media.ccc.de returned an invalid next-page link');
        if (lastPage && nextPage > lastPage) {
          throw new TypeError('media.ccc.de next-page link exceeded the last page');
        }
      } else if (lastPage && lastPage > page) {
        throw new TypeError('media.ccc.de pagination omitted an expected next-page link');
      }
      return { events: metadata.data.events, nextPage };
    });
  }

  function newBrowseSession() {
    const sessionId = `ccc-${(++browseSessionSequence).toString(36)}`;
    const session = { sessionId, seen: new Set() };
    browseSessions.set(sessionId, session);
    while (browseSessions.size > 4) browseSessions.delete(browseSessions.keys().next().value);
    return session;
  }

  function browseSession(cursor) {
    if (cursor == null) return {
      session: newBrowseSession(), page: 1, offset: 0, created: true,
    };
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
        || !/^ccc-[a-z0-9]+$/.test(cursor.sessionId || '')) {
      throw new TypeError('Invalid media.ccc.de browse cursor');
    }
    const session = browseSessions.get(cursor.sessionId);
    const page = Number(cursor.upstreamPage);
    const offset = Number(cursor.upstreamOffset);
    if (!session || !Number.isInteger(page) || page < 1 || page > MAX_UPSTREAM_PAGE
        || !Number.isInteger(offset) || offset < 0 || offset > UPSTREAM_PAGE_SIZE) {
      throw new TypeError('Expired or malformed media.ccc.de browse cursor');
    }
    browseSessions.delete(session.sessionId);
    browseSessions.set(session.sessionId, session);
    return {
      session, page, offset, created: false,
    };
  }

  async function browsePage(opts = {}) {
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    const position = browseSession(opts.cursor);
    const items = [];
    const stagedSeen = new Set();
    let { page, offset } = position;
    let exhausted = false;
    let scannedPages = 0;
    try {
      while (items.length < limit && !exhausted) {
        if (++scannedPages > MAX_BROWSE_SCAN_PAGES) {
          throw new TypeError('media.ccc.de browse page produced too many unusable entries');
        }
        const upstream = await recentPage(page, opts);
        while (offset < upstream.events.length && items.length < limit) {
          const item = vodItem(upstream.events[offset++]);
          if (!item || position.session.seen.has(item.id) || stagedSeen.has(item.id)) continue;
          stagedSeen.add(item.id);
          if (position.session.seen.size + stagedSeen.size > MAX_BROWSE_SEEN) {
            throw new TypeError('media.ccc.de browse session exceeded its identity bound');
          }
          items.push(item);
        }
        if (offset >= upstream.events.length) {
          if (upstream.nextPage == null) exhausted = true;
          else if (items.length < limit) {
            page = upstream.nextPage;
            offset = 0;
          }
        }
      }
    } catch (error) {
      if (position.created) browseSessions.delete(position.session.sessionId);
      throw error;
    }
    for (const itemId of stagedSeen) position.session.seen.add(itemId);
    addToReservoir(items);
    if (exhausted) browseSessions.delete(position.session.sessionId);
    return {
      items,
      cursor: exhausted ? null : {
        sessionId: position.session.sessionId,
        upstreamPage: page,
        upstreamOffset: offset,
      },
      exhausted,
    };
  }

  async function browse(opts = {}) {
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    const items = [];
    const seen = new Set();
    let page = 1;
    let scannedPages = 0;
    while (items.length < limit) {
      if (++scannedPages > MAX_BROWSE_SCAN_PAGES) {
        throw new TypeError('media.ccc.de browse produced too many unusable entries');
      }
      const upstream = await recentPage(page, opts);
      for (const event of upstream.events) {
        const item = vodItem(event);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        if (items.length >= limit) break;
      }
      if (items.length >= limit || upstream.nextPage == null) break;
      page = upstream.nextPage;
    }
    addToReservoir(items);
    return items;
  }

  async function search(query, opts = {}) {
    const normalizedQuery = cleanString(query, 200);
    if (!normalizedQuery) return [];
    const requestedPage = Number(opts.page)
      || Math.floor(Math.max(0, Number(opts.offset) || 0) / 25) + 1;
    const page = Math.max(1, Math.min(MAX_UPSTREAM_PAGE, Math.trunc(requestedPage)));
    const key = `${normalizedQuery}\u0000${page}`;
    const items = await cachedLoad(searchCache, key, {
      now,
      signal: opts.signal,
      ttlMs: dependencies.searchCacheTtlMs ?? SEARCH_CACHE_TTL_MS,
      maxEntries: MAX_SEARCH_CACHE_ITEMS,
    }, async () => {
      const payload = await gated(() => postJsonImpl(MEDIA_CCC_GRAPHQL_URL, {
        operationName: 'WorldMediaLectureSearch',
        query: MEDIA_CCC_SEARCH_QUERY,
        variables: { query: normalizedQuery, page },
      }, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        graphql: true,
      }), opts.signal);
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        throw new ProviderError('media.ccc.de GraphQL search failed', {
          code: 'GRAPHQL_ERROR', errors: payload.errors,
        });
      }
      if (!payload || typeof payload !== 'object' || !payload.data
          || !Array.isArray(payload.data.lectureSearch)) {
        throw new TypeError('media.ccc.de GraphQL search returned an invalid schema');
      }
      if (payload.data.lectureSearch.length > MAX_SEARCH_RESULTS) {
        throw new TypeError('media.ccc.de GraphQL search exceeded the supported result bound');
      }
      return payload.data.lectureSearch.map(vodItem).filter(Boolean);
    });
    addToReservoir(items);
    return items.slice(0, Math.max(1, Math.min(25, Number(opts.limit) || 25)));
  }

  async function eventDetail(guid, opts = {}) {
    return cachedLoad(detailCache, guid, {
      now,
      signal: opts.signal,
      ttlMs: dependencies.detailCacheTtlMs ?? DETAIL_CACHE_TTL_MS,
      maxEntries: MAX_DETAIL_CACHE_ITEMS,
    }, async () => {
      const payload = await gated(() => getJsonImpl(
        `${MEDIA_CCC_DETAIL_URL}/${encodeURIComponent(guid)}`,
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      ), opts.signal);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('media.ccc.de returned an invalid event detail');
      }
      const returnedGuid = identifier(payload.guid);
      if (returnedGuid && returnedGuid !== guid) {
        throw new TypeError('media.ccc.de event detail identity changed');
      }
      return payload;
    });
  }

  async function resolveStream(item, opts = {}) {
    if (!item || item.source !== id) return item;
    if (item.delivery === 'live') {
      if (item.stream_url && item._extra?.needsResolve === false) return item;
      const snapshot = await refreshSnapshot({ ...opts, force: true });
      const resolved = snapshot.items.find((candidate) => candidate.id === item.id);
      if (!resolved) {
        item.stream_url = '';
        item.download_url = '';
        item.download_name = '';
        item.capture_headers = {};
        item._extra = {
          ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
          needsResolve: false,
          downloadResolved: true,
          resolutionStatus: 'unavailable',
          validationError: 'C3VOC_STREAM_OFFLINE',
          snapshotItem: true,
        };
        return item;
      }
      Object.assign(item, cloneItem(resolved), { __snapshotOffline: false });
      return item;
    }
    if (item.stream_url) return item;
    if (item._extra?.needsResolve === false) return item;
    const guid = identifier(item._extra?.guid)
      || identifier(String(item.id || '').startsWith(`${id}:`) ? String(item.id).slice(id.length + 1) : '');
    if (!guid) {
      item.stream_url = '';
      item.download_url = '';
      item.download_name = '';
      item.capture_headers = {};
      item._extra = {
        ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
        needsResolve: false,
        downloadResolved: true,
        resolutionStatus: 'unavailable',
        validationError: 'MEDIA_CCC_IDENTITY_INVALID',
      };
      return item;
    }
    const detail = await eventDetail(guid, opts);
    const selected = selectedRecording(detail, languageToken(
      detail.original_language || item._extra?.originalLanguage,
    ));
    item._extra = {
      ...(item._extra && typeof item._extra === 'object' ? item._extra : {}),
      guid,
      originalLanguage: languageToken(detail.original_language || item._extra?.originalLanguage),
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: selected ? 'playable' : 'unavailable',
    };
    const detailArtwork = canonicalArtworkUrl(detail.thumb_url)
      || canonicalArtworkUrl(detail.poster_url);
    if (detailArtwork) item._extra.artworkUrl = detailArtwork;
    const detailDescription = boundedPlainText(detail.description || detail.subtitle || '');
    if (detailDescription) item.description = detailDescription;
    const detailSource = canonicalSourceUrl(detail.frontend_link);
    if (detailSource) item.source_url = detailSource;
    item.license = explicitLicense(selected?.recording?.license, detail.license, item.license === 'See event license' ? '' : item.license);
    item.stream_url = '';
    item.download_url = '';
    item.download_name = '';
    item.capture_headers = {};
    if (!selected) return item;
    item.type = selected.type;
    item.stream_kind = selected.type;
    item.stream_url = selected.url;
    item.delivery = 'on-demand';
    item.download_url = selected.url;
    item.download_name = safeDownloadName(
      selected.recording.filename,
      selected.url,
      selected.type,
    );
    return item;
  }

  async function resolveArtwork(item, opts = {}) {
    if (!item || item.source !== id) return item;
    if (assetRelayUrl(item.thumbnail)) return item;
    const directThumbnail = canonicalArtworkUrl(item.thumbnail);
    const artworkUrl = canonicalArtworkUrl(item._extra?.artworkUrl) || directThumbnail;
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
    if (!relayUrl) throw new TypeError('Artwork relay returned an invalid media.ccc.de registration');
    item.thumbnail = relayUrl;
    return item;
  }

  async function refreshSnapshot(opts = {}) {
    if (opts.force === true && !liveCache.get('v2')?.promise) liveCache.delete('v2');
    return cachedLoad(liveCache, 'v2', {
      now,
      signal: opts.signal,
      ttlMs: dependencies.liveCacheTtlMs ?? LIVE_CACHE_TTL_MS,
      maxEntries: 1,
    }, async () => {
      const payload = await gated(() => getJsonImpl(MEDIA_CCC_LIVE_URL, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      }), opts.signal);
      const items = liveItems(payload);
      return {
        items,
        snapshotId: items.length ? `media-ccc-v2:${snapshotHash(items)}` : 'media-ccc-v2:empty',
        refreshAfterMs: LIVE_REFRESH_AFTER_MS,
      };
    });
  }

  async function random(opts = {}) {
    if (reservoir.size === 0) {
      const upstream = await recentPage(1, opts);
      addToReservoir(upstream.events.map(vodItem).filter(Boolean));
    }
    const items = [...reservoir.values()];
    for (let index = items.length - 1; index > 0; index--) {
      const other = Math.max(0, Math.min(index, Math.floor(randomValue() * (index + 1))));
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items.slice(0, Math.max(1, Math.min(30, Number(opts.limit) || 12)));
  }

  return {
    search,
    browse,
    browsePage,
    random,
    resolveStream,
    resolveArtwork,
    refreshSnapshot,
  };
}

const defaultAdapter = createMediaCccAdapter();

export const search = (...args) => defaultAdapter.search(...args);
export const browse = (...args) => defaultAdapter.browse(...args);
export const browsePage = (...args) => defaultAdapter.browsePage(...args);
export const random = (...args) => defaultAdapter.random(...args);
export const resolveStream = (...args) => defaultAdapter.resolveStream(...args);
export const resolveArtwork = (...args) => defaultAdapter.resolveArtwork(...args);
export const refreshSnapshot = (...args) => defaultAdapter.refreshSnapshot(...args);
