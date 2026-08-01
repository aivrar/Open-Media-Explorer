/**
 * Unified Item Model — every adapter MUST return items conforming to this shape.
 *
 * @typedef {Object} Item
 * @property {string}      id           Adapter-prefixed unique ID, e.g. "internet-archive:prelinger_001"
 * @property {string}      title
 * @property {string}      description  May be empty string, never null
 * @property {string}      source       Adapter id
 * @property {string}      type         "radio" | "tv" | "video" | "audio"
 * @property {string}      stream_url   Direct playable URL (may be empty if resolution is deferred)
 * @property {string}      stream_kind  "audio" | "video" | "hls" | "dash"
 * @property {string}      delivery     "live" | "on-demand" | "unknown"
 * @property {string}      download_url Original finite media URL or empty string
 * @property {string}      download_name Optional source-suggested filename
 * @property {Object}      capture_headers Sanitized optional {referer, userAgent}
 * @property {string}      thumbnail    Image URL or empty string
 * @property {?number}     year
 * @property {string}      country      ISO code or empty string
 * @property {string}      language     ISO code or empty string
 * @property {string[]}    tags
 * @property {string}      license      Human-readable, e.g. "Public Domain", "CC-BY-4.0", "Unknown"
 * @property {string}      source_url   Canonical page on the origin archive
 * @property {string}      content_rating "explicit" | "not-explicit" | "unrated"
 * @property {?Object}     [_extra]     Adapter-specific lazy-resolve data, NOT part of the public contract.
 */

const STR_FIELDS = [
  'id', 'title', 'description', 'source', 'type',
  'stream_url', 'stream_kind', 'thumbnail',
  'country', 'language', 'license', 'source_url',
  'delivery', 'download_url', 'download_name', 'content_rating',
];

export const CONTENT_RATINGS = Object.freeze(['explicit', 'not-explicit', 'unrated']);

const MAX_EXTERNAL_URL_LENGTH = 4096;

/**
 * Return a canonical public web URL suitable for a user-clickable external
 * link. Provider metadata is untrusted: never allow script/data schemes,
 * credentials, control characters, or backslash URL ambiguities into href.
 */
export function safeExternalUrl(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_EXTERNAL_URL_LENGTH
      || /[\u0000-\u001f\u007f\\]/.test(candidate)) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || !parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

export function normalizeContentRating(value) {
  return CONTENT_RATINGS.includes(value) ? value : 'unrated';
}

const CAPTURE_HEADER_KEYS = new Set(['referer', 'userAgent']);
const MAX_CAPTURE_HEADER_LENGTH = 1024;

/** Keep only safe public capture headers. Catalog data cannot inject raw lines. */
export function sanitizeCaptureHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of CAPTURE_HEADER_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_CAPTURE_HEADER_LENGTH || /[\r\n\0]/.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

/**
 * Normalize an in-progress item to the strict shape with sensible defaults.
 * Never returns undefined for required fields.
 *
 * @param {Partial<Item>} p
 * @returns {Item}
 */
export function makeItem(p) {
  const out = {};
  for (const f of STR_FIELDS) out[f] = typeof p[f] === 'string' ? p[f] : '';
  out.source_url = safeExternalUrl(out.source_url);
  out.year = typeof p.year === 'number' && Number.isFinite(p.year) ? p.year : null;
  out.tags = Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : [];
  if (!['live', 'on-demand', 'unknown'].includes(out.delivery)) out.delivery = 'unknown';
  out.content_rating = normalizeContentRating(out.content_rating);
  out.capture_headers = sanitizeCaptureHeaders(p.capture_headers);
  if (p._extra) out._extra = p._extra;
  return out;
}

/**
 * Validate at runtime — used by the test harness.
 * @returns {string[]} Array of complaints. Empty array = valid.
 */
export function validateItem(item) {
  const errs = [];
  if (!item || typeof item !== 'object') return ['not an object'];
  if (!item.id || typeof item.id !== 'string') errs.push('missing id');
  if (!item.title || typeof item.title !== 'string') errs.push('missing title');
  if (typeof item.description !== 'string') errs.push('description must be string');
  if (!item.source) errs.push('missing source');
  if (!['radio', 'tv', 'video', 'audio'].includes(item.type)) errs.push(`bad type "${item.type}"`);
  if (!['audio', 'video', 'hls', 'dash'].includes(item.stream_kind)) errs.push(`bad stream_kind "${item.stream_kind}"`);
  if (!['live', 'on-demand', 'unknown'].includes(item.delivery)) errs.push(`bad delivery "${item.delivery}"`);
  if (!CONTENT_RATINGS.includes(item.content_rating)) errs.push(`bad content_rating "${item.content_rating}"`);
  if (typeof item.download_url !== 'string') errs.push('download_url must be string');
  if (typeof item.download_name !== 'string') errs.push('download_name must be string');
  if (typeof item.source_url !== 'string') {
    errs.push('source_url must be string');
  } else if (item.source_url && safeExternalUrl(item.source_url) !== item.source_url) {
    errs.push('source_url must be a canonical public HTTP(S) URL');
  }
  const safeHeaders = sanitizeCaptureHeaders(item.capture_headers);
  if (!item.capture_headers || typeof item.capture_headers !== 'object' || Array.isArray(item.capture_headers)) {
    errs.push('capture_headers must be object');
  } else if (Object.keys(item.capture_headers).some((key) => !CAPTURE_HEADER_KEYS.has(key))
             || Object.keys(safeHeaders).length !== Object.keys(item.capture_headers).length) {
    errs.push('capture_headers contains unsafe values');
  }
  if (typeof item.tags !== 'object' || !Array.isArray(item.tags)) errs.push('tags must be array');
  if (item.year !== null && typeof item.year !== 'number') errs.push('year must be number or null');
  return errs;
}

/** Build an adapter-prefixed ID. */
export function prefixId(adapterId, raw) {
  return `${adapterId}:${raw}`;
}

/** Best-effort source filename suggestion. The backend still sanitizes it. */
export function filenameFromUrl(url, fallback = '') {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(segment) || fallback;
  } catch (_) {
    return fallback;
  }
}

/** Heuristic kind detector for stream URLs. */
export function detectStreamKind(url, hint) {
  const u = (url || '').toLowerCase();
  if (u.endsWith('.m3u8') || u.includes('.m3u8?')) return 'hls';
  if (u.endsWith('.mpd') || u.includes('.mpd?')) return 'dash';
  if (hint === 'audio') return 'audio';
  if (/\.(mp4|webm|ogv|mov|mkv|ts)(\?|$)/.test(u)) return 'video';
  if (/\.(mp3|ogg|oga|wav|flac|m4a|aac)(\?|$)/.test(u)) return 'audio';
  return hint || 'audio';
}
