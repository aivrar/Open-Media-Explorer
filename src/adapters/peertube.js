/**
 * PeerTube discovery through the fixed SepiaSearch index.
 *
 * SepiaSearch supplies bounded public summaries only. Every dynamic PeerTube
 * origin remains untrusted: playback detail crosses the authenticated native
 * semantic resolver, and artwork crosses the opaque native asset relay.
 */

import {
  getJson, ProviderError,
} from '../lib/http.js';
import {
  filenameFromUrl, makeItem, prefixId,
} from '../lib/item-model.js';
import {
  registerCatalogAsset, resolvePeerTubeVideo,
} from '../lib/catalog-client.js';
import {
  CatalogScheduler, CATALOG_PRIORITY,
} from '../lib/catalog-scheduler.js';

export const id = 'peertube';
export const displayName = 'PeerTube';
export const itemTypes = ['video', 'tv'];
export const catalogPolicy = Object.freeze({ maxConcurrent: 2, minIntervalMs: 500 });

export const SEPIASEARCH_URL = 'https://sepiasearch.org/api/v1/search/videos';

const APP_PAGE_SIZE = 30;
const MAX_PROVIDER_TOTAL = 1_000_000_000;
const MAX_PROVIDER_START = MAX_PROVIDER_TOTAL;
const MAX_INDEX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_CACHE = 64;
const MAX_DETAIL_CACHE = 256;
const MAX_RESERVOIR = 300;
const MAX_TAGS = 16;
const MAX_INPUT_TAGS = 64;
const MAX_THUMBNAILS = 16;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const STALE_RETRY_TTL_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_TEXT_INPUT = 16_000;
const MAX_DESCRIPTION = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_UUID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const CONTENT_RATINGS = new Set(['explicit', 'not-explicit']);
const CACHE_STATES = new Set(['fresh', 'updated', 'revalidated', 'stale', 'uncached']);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const DISPLAY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:access|apikey|auth|authorization|credential|key|pass|password|secret|sig|signature|token)(?:$|[_-])/i;

function abortError(reason = 'Cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

function linkSignal(signal, controller) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  const abort = () => controller.abort(abortError(signal.reason || 'Cancelled'));
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function fail(code, message, options = {}) {
  return new ProviderError(message, {
    code,
    status: Number(options.status || 0),
    retryAfterMs: Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null,
    cause: options.cause,
  });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeHtmlEntities(value) {
  const names = {
    amp: '&', apos: "'", gt: '>', hellip: '\u2026', laquo: '\u00ab', lt: '<', nbsp: ' ',
    ndash: '\u2013', quot: '"', raquo: '\u00bb', rsquo: '\u2019', lsquo: '\u2018', mdash: '\u2014',
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

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(value).replace(DISPLAY_CONTROL_PATTERN, '')
    .replace(/\s+/g, ' ').trim().slice(0, Math.max(0, Number(maxLength) || 0));
}

export function boundedPlainText(value, maxLength = MAX_DESCRIPTION) {
  if (typeof value !== 'string' || !value) return '';
  const bounded = value.slice(0, MAX_TEXT_INPUT)
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
    .trim().slice(0, Math.max(0, Number(maxLength) || MAX_DESCRIPTION));
}

function isObviouslyPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] >= 224;
}

function normalizeHttpUrl(value, options = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192
      || CONTROL_PATTERN.test(value) || value.includes('\\')) return '';
  try {
    const parsed = new URL(value.trim(), options.base || undefined);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (!parsed.hostname || isObviouslyPrivateHost(parsed.hostname)) return '';
    if (parsed.port === '0') return '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (options.noQuery && parsed.search) return '';
    if (options.noFragment && parsed.hash) return '';
    if (options.rejectSensitiveQuery !== false) {
      for (const key of parsed.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return '';
    }
    parsed.hash = '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function safeArtworkUrl(value, base) {
  const url = normalizeHttpUrl(value, { base });
  if (!url) return '';
  try {
    return /\.(?:svg|ico)(?:$|[?#])/i.test(new URL(url).pathname) ? '' : url;
  } catch (_) {
    return '';
  }
}

function safeMediaUrl(value) {
  return normalizeHttpUrl(value, { rejectSensitiveQuery: false });
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

function dateValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) return '';
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return '';
  const year = new Date(stamp).getUTCFullYear();
  return year >= 1900 && year <= 3000 ? new Date(stamp).toISOString() : '';
}

function yearFromDate(value) {
  const normalized = dateValue(value);
  return normalized ? new Date(normalized).getUTCFullYear() : null;
}

function normalizeTags(value, category = '') {
  if (value != null && (!Array.isArray(value) || value.length > MAX_INPUT_TAGS)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube tags are malformed.');
  }
  const out = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(value) ? value : []), category]) {
    const tag = cleanString(raw, 64);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeLicense(value) {
  if (value == null) return { id: null, label: 'See PeerTube license' };
  if (!isPlainObject(value)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube license metadata is malformed.');
  }
  // Current PeerTube origins may serialize their documented Unknown license as
  // `{ id: null, label: "Unknown" }`. Keep that honest and nonauthoritative;
  // only numeric 1..9 values are concrete license declarations.
  if (value.id === null) {
    if (value.label != null && typeof value.label !== 'string') {
      throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube license metadata is malformed.');
    }
    return { id: null, label: 'See PeerTube license' };
  }
  if (!Number.isInteger(value.id) || value.id < 1 || value.id > 9) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube license metadata is malformed.');
  }
  const label = cleanString(value.label, 256);
  if (value.id === 9) return { id: 9, label: 'All Rights Reserved' };
  return { id: value.id, label: label || 'See PeerTube license' };
}

function normalizeLanguage(value) {
  if (value == null) return '';
  if (!isPlainObject(value)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube language metadata is malformed.');
  }
  // Like licenses, PeerTube's Unknown enum is represented as a real object
  // with a null ID. Do not invent a language token for it.
  if (value.id === null) {
    if (value.label != null && typeof value.label !== 'string') {
      throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube language metadata is malformed.');
    }
    return '';
  }
  if (typeof value.id !== 'string') {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube language metadata is malformed.');
  }
  return languageToken(value.id);
}

function normalizeActor(value, field) {
  if (value == null) return { name: '', host: '' };
  if (!isPlainObject(value)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', `PeerTube ${field} metadata is malformed.`);
  }
  const name = cleanString(value.displayName || value.name, 160);
  const host = cleanString(value.host, 253).toLowerCase();
  if (host && (CONTROL_PATTERN.test(host) || isObviouslyPrivateHost(host))) {
    throw fail('PEERTUBE_SCHEMA_INVALID', `PeerTube ${field} host is malformed.`);
  }
  return { name, host };
}

export function peerTubeIdentity(watchValue, uuidValue) {
  const uuid = typeof uuidValue === 'string' ? uuidValue.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(uuid)) return null;
  const watchUrl = normalizeHttpUrl(watchValue, { noQuery: true, noFragment: true });
  if (!watchUrl) return null;
  try {
    const parsed = new URL(watchUrl);
    let decoded;
    try { decoded = decodeURIComponent(parsed.pathname); } catch (_) { return null; }
    const match = decoded.match(/^\/(videos\/watch|w)\/([A-Za-z0-9_-]{8,64})\/?$/);
    if (!match) return null;
    const [route, identifier] = match.slice(1);
    if (route === 'videos/watch' && identifier.toLowerCase() !== uuid) return null;
    if (route === 'w' && UUID_PATTERN.test(identifier) && identifier.toLowerCase() !== uuid) return null;
    if (route === 'w' && !SHORT_UUID_PATTERN.test(identifier)) return null;
    const originHost = parsed.host.toLowerCase();
    if (!originHost || originHost.length > 320) return null;
    return {
      uuid,
      watchUrl: parsed.href,
      origin: parsed.origin,
      originHost,
      id: prefixId(id, `${originHost}:${uuid}`),
    };
  } catch (_) {
    return null;
  }
}

function cloneItem(item) {
  if (!item || typeof item !== 'object') return item;
  const extra = isPlainObject(item._extra) ? {
    ...item._extra,
    ...(Array.isArray(item._extra.thumbnails) ? { thumbnails: [...item._extra.thumbnails] } : {}),
  } : item._extra;
  return {
    ...item,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    capture_headers: { ...(item.capture_headers || {}) },
    ...(extra ? { _extra: extra } : {}),
  };
}

function safeDownloadName(title, url) {
  const fallback = 'peertube-video.mp4';
  const fromUrl = filenameFromUrl(url, fallback);
  const stem = cleanString(title, 180) || fromUrl.replace(/\.mp4$/i, '') || 'peertube-video';
  let candidate = `${stem.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180)}.mp4`;
  if (!candidate || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)) {
    candidate = fallback;
  }
  return candidate;
}

export function normalizeSepiaSummary(raw, options = {}) {
  if (!isPlainObject(raw)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube summary is malformed.');
  }
  const privacy = raw.privacy;
  if (!isPlainObject(privacy) || !Number.isInteger(privacy.id)) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube privacy metadata is malformed.');
  }
  if (privacy.id !== 1) return null;
  if (raw.state != null) {
    if (!isPlainObject(raw.state) || !Number.isInteger(raw.state.id)) {
      throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube publication state is malformed.');
    }
    if (raw.state.id !== 1) return null;
  }
  if (typeof raw.isLive !== 'boolean') {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube live state is malformed.');
  }
  if (typeof raw.nsfw !== 'boolean' || !Number.isInteger(raw.nsfwFlags)
      || raw.nsfwFlags < 0 || raw.nsfwFlags > 7
      || (!raw.nsfw && raw.nsfwFlags !== 0)) {
    throw fail('PEERTUBE_RATING_INVALID', 'PeerTube content rating is malformed.');
  }
  const identity = peerTubeIdentity(raw.url, raw.uuid);
  if (!identity) {
    throw fail('PEERTUBE_IDENTITY_INVALID', 'PeerTube summary identity is malformed.');
  }
  const title = cleanString(raw.name, 300);
  if (!title) throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube summary title is missing.');
  const publishedAt = dateValue(raw.publishedAt);
  if (!publishedAt) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube publication date is malformed.');
  }
  const duration = raw.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration)
      || duration < 0 || duration > 20 * 365 * 24 * 60 * 60) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube duration is malformed.');
  }
  const category = raw.category == null ? '' : (
    isPlainObject(raw.category) ? cleanString(raw.category.label, 80) : null
  );
  if (category === null) throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube category is malformed.');
  const license = normalizeLicense(raw.licence);
  const language = normalizeLanguage(raw.language);
  const channel = normalizeActor(raw.channel, 'channel');
  const account = normalizeActor(raw.account, 'account');
  const contentRating = raw.nsfw || raw.nsfwFlags > 0 ? 'explicit' : 'not-explicit';
  if (contentRating === 'explicit' && options.showExplicitContent !== true) return null;

  const thumbnailCandidates = [];
  for (const candidate of [raw.thumbnailUrl, raw.previewUrl]) {
    const normalized = safeArtworkUrl(candidate, identity.origin);
    if (normalized && !thumbnailCandidates.includes(normalized)) thumbnailCandidates.push(normalized);
  }
  if (Array.isArray(raw.thumbnails)) {
    if (raw.thumbnails.length > MAX_THUMBNAILS) {
      throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube thumbnail metadata is too large.');
    }
    for (const candidate of raw.thumbnails) {
      const normalized = safeArtworkUrl(
        isPlainObject(candidate) ? (candidate.url || candidate.path) : candidate,
        identity.origin,
      );
      if (normalized && !thumbnailCandidates.includes(normalized)) thumbnailCandidates.push(normalized);
    }
  } else if (raw.thumbnails != null) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'PeerTube thumbnail metadata is malformed.');
  }

  const description = boundedPlainText(raw.description || raw.truncatedDescription || '');
  return makeItem({
    id: identity.id,
    title,
    description,
    source: id,
    type: raw.isLive ? 'tv' : 'video',
    stream_url: '',
    stream_kind: raw.isLive ? 'hls' : 'video',
    delivery: raw.isLive ? 'live' : 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: '',
    year: yearFromDate(publishedAt),
    country: '',
    language,
    tags: normalizeTags(raw.tags, category),
    license: license.label,
    source_url: identity.watchUrl,
    content_rating: contentRating,
    _extra: {
      schemaVersion: 1,
      uuid: identity.uuid,
      watchUrl: identity.watchUrl,
      origin: identity.origin,
      originHost: identity.originHost,
      artworkUrl: thumbnailCandidates[0] || '',
      previewUrl: thumbnailCandidates[1] || '',
      thumbnails: thumbnailCandidates.slice(0, MAX_THUMBNAILS),
      publishedAt,
      updatedAt: dateValue(raw.updatedAt),
      duration: Math.trunc(duration),
      channel: channel.name,
      channelHost: channel.host,
      account: account.name,
      accountHost: account.host,
      licenseId: license.id,
      nsfwFlags: raw.nsfwFlags,
      needsResolve: true,
      downloadResolved: false,
      restartResolve: true,
    },
  });
}

function preferredDuplicate(left, right) {
  const score = (item) => {
    let value = 0;
    if (item?._extra?.watchUrl?.startsWith('https://')) value += 2;
    if (/\/videos\/watch\/[0-9a-f-]{36}\/?$/i.test(item?._extra?.watchUrl || '')) value += 1;
    return value;
  };
  return score(right) > score(left) ? right : left;
}

export function normalizeSepiaResponse(payload, options = {}) {
  const start = Number(options.start || 0);
  const count = Number(options.count || APP_PAGE_SIZE);
  const query = cleanString(options.query, 200);
  if (!Number.isInteger(start) || start < 0 || start > MAX_PROVIDER_START
      || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new TypeError('Invalid PeerTube page bounds');
  }
  if (!isPlainObject(payload) || !Number.isInteger(payload.total)
      || payload.total < 0 || payload.total > MAX_PROVIDER_TOTAL
      || !Array.isArray(payload.data) || payload.data.length > count) {
    throw fail('PEERTUBE_SCHEMA_INVALID', 'SepiaSearch returned an invalid page.');
  }
  if (!query && start === 0 && payload.total === 0) {
    throw fail('PEERTUBE_SUSPICIOUS_ZERO', 'SepiaSearch unexpectedly returned an empty global catalog.');
  }
  if (payload.data.length > payload.total || (payload.data.length === 0 && start < payload.total)) {
    throw fail('PEERTUBE_PAGINATION_INVALID', 'SepiaSearch pagination is inconsistent.');
  }

  const byId = new Map();
  let filtered = 0;
  let malformed = 0;
  for (const raw of payload.data) {
    try {
      const item = normalizeSepiaSummary(raw, options);
      if (!item) {
        filtered += 1;
        continue;
      }
      const existing = byId.get(item.id);
      byId.set(item.id, existing ? preferredDuplicate(existing, item) : item);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      malformed += 1;
    }
  }
  if (payload.data.length > 0 && byId.size === 0 && filtered === 0 && malformed > 0) {
    throw fail('PEERTUBE_SCHEMA_DRIFT', 'SepiaSearch returned no structurally valid summaries.');
  }
  const rawCount = payload.data.length;
  const nextStart = start + rawCount;
  // `total` is the authoritative offset boundary. A short nonempty index page
  // may reflect concurrent federation/index updates and must not silently drop
  // the remaining advertised results.
  const exhausted = rawCount === 0 || nextStart >= payload.total;
  return {
    items: [...byId.values()].map(cloneItem),
    total: payload.total,
    rawCount,
    filtered,
    malformed,
    partial: malformed > 0,
    nextStart: exhausted ? null : nextStart,
    exhausted,
  };
}

function cacheState(value) {
  const state = cleanString(value?.cache?.state, 32).toLowerCase();
  return CACHE_STATES.has(state) ? state : '';
}

export function normalizeResolvedPeerTube(value, expectedIdentity) {
  if (!isPlainObject(value) || value.provider !== 'peertube' || !expectedIdentity) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver returned malformed data.');
  }
  const identity = peerTubeIdentity(value.watch_url, value.uuid);
  const origin = normalizeHttpUrl(`${value.origin}/`, { noQuery: true, noFragment: true });
  if (!identity || identity.id !== expectedIdentity.id || !origin
      || new URL(origin).origin !== expectedIdentity.origin) {
    throw fail('PEERTUBE_ID_MISMATCH', 'PeerTube resolver identity changed.');
  }
  if (!CONTENT_RATINGS.has(value.content_rating) || typeof value.is_live !== 'boolean') {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver content state is malformed.');
  }
  if (!Number.isInteger(value.nsfw_flags) || value.nsfw_flags < 0 || value.nsfw_flags > 7
      || (value.content_rating === 'not-explicit' && value.nsfw_flags !== 0)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver rating flags are malformed.');
  }
  const expectedDelivery = value.is_live ? 'live' : 'on-demand';
  if (value.delivery !== expectedDelivery || value.recording_kind !== 'video'
      || !['hls', 'video'].includes(value.media_type)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver media state is malformed.');
  }
  for (const field of ['hls_choices', 'file_choices', 'download_choices']) {
    if (!Array.isArray(value[field]) || value[field].length > 64) {
      throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver media choices are malformed.');
    }
  }
  const playbackUrl = safeMediaUrl(value.playback_url);
  const downloadUrl = safeMediaUrl(value.download_url);
  if (typeof value.playback_url !== 'string' || (value.playback_url && !playbackUrl)
      || typeof value.download_url !== 'string' || (value.download_url && !downloadUrl)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver media URL is malformed.');
  }
  if (playbackUrl && value.media_type === 'hls' && !/\.m3u8(?:$|[?#])/i.test(playbackUrl)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube HLS URL is malformed.');
  }
  if (playbackUrl && value.media_type === 'video' && !/\.mp4(?:$|[?#])/i.test(playbackUrl)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube MP4 URL is malformed.');
  }
  if (value.is_live && playbackUrl && value.media_type !== 'hls') {
    throw fail('PEERTUBE_LIVE_MEDIA_INVALID', 'PeerTube live media is not an HLS stream.');
  }
  if (typeof value.download_permission !== 'boolean'
      || typeof value.download_enabled !== 'boolean'
      || (value.download_enabled && !value.download_permission)
      || (value.download_enabled && (!downloadUrl || value.is_live))
      || (!value.download_enabled && downloadUrl)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube download permission is malformed.');
  }
  if (value.license_id !== null
      && (!Number.isInteger(value.license_id) || value.license_id < 1 || value.license_id > 9)) {
    throw fail('PEERTUBE_RESOLVER_INVALID', 'PeerTube resolver license metadata is malformed.');
  }
  return {
    identity,
    title: cleanString(value.title, 300),
    description: boundedPlainText(value.description),
    contentRating: value.content_rating,
    isLive: value.is_live,
    delivery: expectedDelivery,
    streamKind: value.media_type === 'hls' ? 'hls' : 'video',
    playbackUrl,
    downloadUrl: value.download_enabled ? downloadUrl : '',
    downloadEnabled: value.download_enabled,
    license: value.license_id === 9
      ? 'All Rights Reserved'
      : (cleanString(value.license, 256) || 'See PeerTube license'),
    licenseId: value.license_id,
    nsfwFlags: value.nsfw_flags,
    cacheState: cacheState(value),
    cacheStale: value?.cache?.stale === true || cacheState(value) === 'stale',
  };
}

function retryAfterMs(error) {
  if (error?.retryAfterMs != null && Number.isFinite(Number(error.retryAfterMs))) {
    return Math.max(0, Math.min(MAX_COOLDOWN_MS, Number(error.retryAfterMs)));
  }
  if (error?.retryAfter != null && Number.isFinite(Number(error.retryAfter))) {
    return Math.max(0, Math.min(MAX_COOLDOWN_MS, Number(error.retryAfter) * 1000));
  }
  return null;
}

function retryable(error) {
  if (!error || error.name === 'AbortError') return false;
  if (error.retryable === true) return true;
  if (error.retryable === false) return Number(error.status) === 429;
  const status = Number(error.status || 0);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function schedulerFailure(error) {
  const normalized = new Error(String(error?.message || 'PeerTube request failed'));
  normalized.status = Number(error?.status || (retryable(error) ? 0 : 400));
  normalized.retryAfterMs = retryAfterMs(error);
  return normalized;
}

/** Global-four/per-origin-two queue for untrusted PeerTube detail origins. */
export function createPeerTubeOriginScheduler(options = {}) {
  const scheduler = options.scheduler || new CatalogScheduler({
    maxConcurrent: options.maxConcurrent ?? 4,
    defaultSourceConcurrency: options.perHostConcurrent ?? 2,
    maxQueue: options.maxQueue ?? 256,
    cooldownBaseMs: options.cooldownBaseMs ?? 1_500,
    cooldownMaxMs: options.cooldownMaxMs ?? 30_000,
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    enqueueMicrotask: options.enqueueMicrotask,
  });
  let sequence = 0;
  let closed = false;

  function hostKey(origin) {
    const normalized = normalizeHttpUrl(`${origin}/`, { noQuery: true, noFragment: true });
    if (!normalized) throw new TypeError('Invalid PeerTube origin');
    return new URL(normalized).host.toLowerCase();
  }

  function run(origin, task, signal) {
    if (closed) return Promise.reject(abortError('PeerTube origin scheduler disposed'));
    if (typeof task !== 'function') return Promise.reject(new TypeError('PeerTube origin task is missing'));
    const host = hostKey(origin);
    scheduler.setPolicy(host, {
      maxConcurrent: options.perHostConcurrent ?? 2,
      minIntervalMs: 0,
    });
    return scheduler.enqueue({
      sourceId: host,
      key: `resolve:${++sequence}`,
      priority: CATALOG_PRIORITY.USER,
      signal,
      task: ({ signal: ownedSignal }) => task(ownedSignal),
    });
  }

  function recordFailure(origin, error) {
    if (!retryable(error)) return 0;
    return scheduler.recordFailure(hostKey(origin), schedulerFailure(error));
  }

  function recordSuccess(origin) {
    scheduler.recordSuccess(hostKey(origin));
  }

  function imposeCooldown(origin, delayMs) {
    return scheduler.setCooldown(hostKey(origin), Math.min(MAX_COOLDOWN_MS, Math.max(0, Number(delayMs) || 0)));
  }

  function dispose(reason = 'PeerTube origin scheduler disposed') {
    if (closed) return;
    closed = true;
    scheduler.destroy(abortError(reason));
  }

  return {
    run,
    recordFailure,
    recordSuccess,
    imposeCooldown,
    stats: () => scheduler.stats(),
    dispose,
  };
}

function createIndexScheduler(options = {}) {
  const scheduler = options.scheduler || new CatalogScheduler({
    maxConcurrent: 2,
    defaultSourceConcurrency: 2,
    maxQueue: 128,
    cooldownBaseMs: 1_500,
    cooldownMaxMs: 30_000,
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    enqueueMicrotask: options.enqueueMicrotask,
  });
  const sourceId = 'sepiasearch.org';
  scheduler.setPolicy(sourceId, catalogPolicy);
  let sequence = 0;
  let closed = false;
  return {
    run(task, signal, priority = CATALOG_PRIORITY.INITIAL) {
      if (closed) return Promise.reject(abortError('PeerTube index scheduler disposed'));
      return scheduler.enqueue({
        sourceId,
        key: `index:${++sequence}`,
        priority,
        signal,
        task: ({ signal: ownedSignal }) => task(ownedSignal),
      });
    },
    recordFailure(error) {
      return retryable(error) ? scheduler.recordFailure(sourceId, schedulerFailure(error)) : 0;
    },
    recordSuccess() { scheduler.recordSuccess(sourceId); },
    dispose(reason = 'PeerTube index scheduler disposed') {
      if (closed) return;
      closed = true;
      scheduler.destroy(abortError(reason));
    },
    stats: () => scheduler.stats(),
  };
}

function buildSepiaUrl({ start, query, showExplicitContent }) {
  const target = new URL(SEPIASEARCH_URL);
  target.searchParams.set('start', String(start));
  target.searchParams.set('count', String(APP_PAGE_SIZE));
  target.searchParams.set('sort', '-publishedAt');
  target.searchParams.set('includeScheduledLive', 'false');
  if (showExplicitContent !== true) target.searchParams.set('nsfw', 'false');
  if (query) target.searchParams.set('search', query);
  return target.href;
}

function normalizeCursor(value, query, explicit) {
  if (value == null) return { version: 1, query, explicit, start: 0 };
  if (!isPlainObject(value) || value.version !== 1 || value.query !== query
      || value.explicit !== explicit || !Number.isInteger(value.start)
      || value.start < 0 || value.start > MAX_PROVIDER_START) {
    return { version: 1, query, explicit, start: 0 };
  }
  return { version: 1, query, explicit, start: value.start };
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function clonePage(value) {
  return {
    ...value,
    items: Array.isArray(value?.items) ? value.items.map(cloneItem) : [],
  };
}

export function createPeerTubeAdapter(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const randomValue = dependencies.random || Math.random;
  const getJsonImpl = dependencies.getJson || getJson;
  const resolveVideoImpl = dependencies.resolvePeerTubeVideo || resolvePeerTubeVideo;
  const registerAssetImpl = dependencies.registerCatalogAsset || registerCatalogAsset;
  const indexScheduler = dependencies.indexScheduler || createIndexScheduler({
    now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    enqueueMicrotask: dependencies.enqueueMicrotask,
  });
  const originScheduler = dependencies.originScheduler || createPeerTubeOriginScheduler({
    now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    enqueueMicrotask: dependencies.enqueueMicrotask,
  });
  const indexCache = new Map();
  const detailCache = new Map();
  const reservoir = new Map();
  const assetControllers = new Set();
  const standaloneBuffer = [];
  let standaloneCursor = null;
  let standaloneExhausted = false;
  let standaloneExplicit = null;
  let disposed = false;

  function ensureOpen() {
    if (disposed) throw abortError('PeerTube adapter disposed');
  }

  function showExplicit(opts = {}) {
    if (typeof opts.showExplicitContent === 'boolean') return opts.showExplicitContent;
    const supplied = typeof dependencies.showExplicitContent === 'function'
      ? dependencies.showExplicitContent()
      : dependencies.showExplicitContent;
    return supplied === true;
  }

  function touch(cache, key, entry) {
    if (cache.get(key) !== entry) return;
    cache.delete(key);
    cache.set(key, entry);
  }

  async function cachedLoad(cache, key, options, loader) {
    const existing = cache.get(key);
    if (existing?.value && existing.expiresAt > now()) {
      touch(cache, key, existing);
      return {
        value: existing.value,
        stale: existing.stale === true,
        error: existing.error || '',
        current: true,
      };
    }
    if (existing?.promise && existing.signal === options.signal) return existing.promise;
    const previous = existing;
    const entry = {
      value: existing?.value || null,
      expiresAt: 0,
      stale: false,
      error: '',
      promise: null,
      signal: options.signal,
    };
    entry.promise = Promise.resolve().then(loader).then((value) => {
      entry.value = value;
      entry.expiresAt = now() + options.ttlMs;
      entry.stale = options.isStale?.(value) === true;
      entry.error = '';
      entry.promise = null;
      entry.signal = null;
      const current = cache.get(key) === entry;
      if (current) {
        touch(cache, key, entry);
        trimCache(cache, options.maxEntries);
      }
      return { value, stale: entry.stale, error: '', current };
    }).catch((error) => {
      if (error?.name === 'AbortError') {
        if (cache.get(key) === entry) {
          entry.promise = null;
          entry.signal = null;
          if (!entry.value) cache.delete(key);
        }
        throw error;
      }
      if (!entry.value && previous?.value) entry.value = previous.value;
      entry.promise = null;
      entry.signal = null;
      const staleAllowed = typeof options.allowStale === 'function'
        ? options.allowStale(error)
        : options.allowStale !== false;
      if (!entry.value || !staleAllowed) {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
      entry.stale = true;
      entry.error = cleanString(error.code || error.message, 120);
      entry.expiresAt = now() + (options.staleTtlMs ?? STALE_RETRY_TTL_MS);
      const current = cache.get(key) === entry;
      if (current) {
        touch(cache, key, entry);
        trimCache(cache, options.maxEntries);
      }
      return { value: entry.value, stale: true, error: entry.error, current };
    });
    cache.set(key, entry);
    trimCache(cache, options.maxEntries);
    return entry.promise;
  }

  function rememberItems(items) {
    for (const item of items) {
      if (!item?.id) continue;
      const clone = cloneItem(item);
      reservoir.delete(item.id);
      reservoir.set(item.id, cloneItem(clone));
      trimCache(reservoir, MAX_RESERVOIR);
    }
  }

  async function indexPage(start, query, explicit, opts = {}) {
    const key = `${query}\u0000${explicit}\u0000${start}`;
    const loaded = await cachedLoad(indexCache, key, {
      signal: opts.signal,
      ttlMs: dependencies.indexCacheTtlMs ?? INDEX_CACHE_TTL_MS,
      maxEntries: MAX_INDEX_CACHE,
      allowStale: (error) => retryable(error),
    }, () => indexScheduler.run(async (signal) => {
      try {
        const payload = await getJsonImpl(buildSepiaUrl({
          start, query, showExplicitContent: explicit,
        }), {
          signal,
          timeoutMs: opts.timeoutMs,
          maxBytes: MAX_INDEX_RESPONSE_BYTES,
        });
        const page = normalizeSepiaResponse(payload, {
          start,
          count: APP_PAGE_SIZE,
          query,
          showExplicitContent: explicit,
        });
        indexScheduler.recordSuccess?.();
        return page;
      } catch (error) {
        if (error?.name !== 'AbortError') indexScheduler.recordFailure?.(error);
        throw error;
      }
    }, opts.signal, query ? CATALOG_PRIORITY.SEARCH : CATALOG_PRIORITY.INITIAL));
    const page = clonePage(loaded.value);
    if (loaded.current) rememberItems(page.items);
    return {
      ...page,
      stale: loaded.stale,
      error: loaded.error,
    };
  }

  async function pageFor(query, opts = {}) {
    const explicit = showExplicit(opts);
    const cursor = normalizeCursor(opts.cursor, query, explicit);
    const page = await indexPage(cursor.start, query, explicit, opts);
    const nextCursor = page.exhausted || page.nextStart == null
      ? null
      : { version: 1, query, explicit, start: page.nextStart };
    return {
      items: page.items.map(cloneItem),
      cursor: nextCursor,
      exhausted: page.exhausted,
      total: page.total,
      partial: page.partial,
      malformed: page.malformed,
      filtered: page.filtered,
      stale: page.stale,
      error: page.error,
    };
  }

  function browsePage(opts = {}) {
    try { ensureOpen(); } catch (error) { return Promise.reject(error); }
    return pageFor('', opts);
  }

  function searchPage(query, opts = {}) {
    try { ensureOpen(); } catch (error) { return Promise.reject(error); }
    const normalized = cleanString(query, 200);
    if (!normalized) return Promise.resolve({
      items: [], cursor: null, exhausted: true, total: 0, partial: false,
    });
    return pageFor(normalized, opts);
  }

  async function browse(opts = {}) {
    ensureOpen();
    const explicit = showExplicit(opts);
    if (standaloneExplicit !== null && standaloneExplicit !== explicit) {
      standaloneCursor = null;
      standaloneExhausted = false;
      standaloneBuffer.length = 0;
    }
    standaloneExplicit = explicit;
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    let attempts = 0;
    while (standaloneBuffer.length < limit && !standaloneExhausted && attempts < 3) {
      attempts += 1;
      const page = await browsePage({ ...opts, cursor: standaloneCursor });
      standaloneCursor = page.cursor;
      standaloneExhausted = page.exhausted;
      standaloneBuffer.push(...page.items.map(cloneItem));
    }
    const items = standaloneBuffer.splice(0, limit).map(cloneItem);
    if (standaloneExhausted && standaloneBuffer.length === 0) {
      standaloneCursor = null;
      standaloneExhausted = false;
    }
    return items;
  }

  async function search(query, opts = {}) {
    ensureOpen();
    const normalized = cleanString(query, 200);
    if (!normalized) return [];
    const explicit = showExplicit(opts);
    const offset = Math.max(0, Math.min(MAX_PROVIDER_START, Math.trunc(Number(opts.offset) || 0)));
    const page = await searchPage(normalized, {
      ...opts,
      cursor: { version: 1, query: normalized, explicit, start: offset },
    });
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    const items = page.items.slice(0, limit).map(cloneItem);
    Object.defineProperty(items, 'peerTubeSearchState', {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        partial: page.partial,
        malformed: page.malformed,
        filtered: page.filtered,
        stale: page.stale,
      }),
    });
    return items;
  }

  function identityFromItem(item) {
    if (!item || item.source !== id) return null;
    const uuid = cleanString(item._extra?.uuid, 64).toLowerCase();
    const watchUrl = item._extra?.watchUrl || item.source_url;
    const identity = peerTubeIdentity(watchUrl, uuid);
    if (!identity || item.id !== identity.id) return null;
    return identity;
  }

  async function resolvedDetail(identity, opts = {}) {
    const loaded = await cachedLoad(detailCache, identity.id, {
      signal: opts.signal,
      ttlMs: dependencies.detailCacheTtlMs ?? DETAIL_CACHE_TTL_MS,
      staleTtlMs: STALE_RETRY_TTL_MS,
      maxEntries: MAX_DETAIL_CACHE,
      allowStale: (error) => retryable(error),
      isStale: (value) => value.cacheStale === true,
    }, () => originScheduler.run(identity.origin, async (signal) => {
      try {
        const payload = await resolveVideoImpl(identity.watchUrl, identity.uuid, { signal });
        const value = normalizeResolvedPeerTube(payload, identity);
        originScheduler.recordSuccess?.(identity.origin);
        return value;
      } catch (error) {
        if (error?.name !== 'AbortError') originScheduler.recordFailure?.(identity.origin, error);
        throw error;
      }
    }, opts.signal));
    return {
      ...loaded.value,
      cacheStale: loaded.stale || loaded.value.cacheStale,
      cacheError: loaded.error,
    };
  }

  async function resolveStream(item, opts = {}) {
    if (!item || item.source !== id) return item;
    ensureOpen();
    const explicit = showExplicit(opts);
    if (item.content_rating === 'explicit' && !explicit) {
      item.stream_url = '';
      item.download_url = '';
      item.download_name = '';
      item._extra = {
        ...(isPlainObject(item._extra) ? item._extra : {}),
        needsResolve: true,
        downloadResolved: true,
        resolutionStatus: 'hidden',
      };
      throw fail('PEERTUBE_EXPLICIT_HIDDEN', 'This PeerTube item is hidden by the content setting.');
    }
    if (item.stream_url && item._extra?.needsResolve === false) return item;
    const identity = identityFromItem(item);
    if (!identity) {
      item.stream_url = '';
      item.download_url = '';
      item.download_name = '';
      item.capture_headers = {};
      item._extra = {
        ...(isPlainObject(item._extra) ? item._extra : {}),
        needsResolve: false,
        downloadResolved: true,
        resolutionStatus: 'unavailable',
        validationError: 'PEERTUBE_IDENTITY_INVALID',
      };
      throw fail('PEERTUBE_IDENTITY_INVALID', 'Saved PeerTube identity is invalid.');
    }
    let detail;
    try {
      detail = await resolvedDetail(identity, opts);
    } catch (error) {
      if (['PEERTUBE_NOT_PUBLIC', 'PEERTUBE_NOT_PUBLISHED'].includes(error?.code)) {
        item.stream_url = '';
        item.download_url = '';
        item.download_name = '';
        item.capture_headers = {};
        item._extra = {
          ...(isPlainObject(item._extra) ? item._extra : {}),
          needsResolve: false,
          downloadResolved: true,
          resolutionStatus: 'unavailable',
          validationError: error.code,
        };
      }
      throw error;
    }
    const conservativeRating = item.content_rating === 'explicit' || detail.contentRating === 'explicit'
      ? 'explicit'
      : 'not-explicit';
    item.content_rating = conservativeRating;
    if (conservativeRating === 'explicit' && !explicit) {
      item.stream_url = '';
      item.download_url = '';
      item._extra = {
        ...(isPlainObject(item._extra) ? item._extra : {}),
        needsResolve: true,
        downloadResolved: true,
        resolutionStatus: 'hidden',
      };
      throw fail('PEERTUBE_EXPLICIT_HIDDEN', 'This PeerTube item is hidden by the content setting.');
    }

    item.title = detail.title || item.title;
    item.description = detail.description || item.description;
    item.type = detail.isLive ? 'tv' : 'video';
    item.stream_kind = detail.streamKind;
    item.delivery = detail.delivery;
    item.stream_url = detail.playbackUrl;
    item.download_url = detail.downloadEnabled ? detail.downloadUrl : '';
    item.download_name = item.download_url ? safeDownloadName(item.title, item.download_url) : '';
    item.capture_headers = {};
    item.license = detail.license || item.license;
    item.source_url = detail.identity.watchUrl;
    item._extra = {
      ...(isPlainObject(item._extra) ? item._extra : {}),
      uuid: detail.identity.uuid,
      watchUrl: detail.identity.watchUrl,
      origin: detail.identity.origin,
      originHost: detail.identity.originHost,
      // The origin answered authoritatively. A detail with no compatible media
      // is unavailable for this card rather than an endless "Checking" state;
      // a later catalog refresh creates a fresh unresolved summary.
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: detail.playbackUrl ? 'playable' : 'unavailable',
      cacheState: detail.cacheState,
      cacheStale: detail.cacheStale,
      cacheError: detail.cacheError || '',
    };
    return item;
  }

  async function resolveArtwork(item, opts = {}) {
    if (!item || item.source !== id) return item;
    ensureOpen();
    if (assetRelayUrl(item.thumbnail)) return item;
    const identity = identityFromItem(item);
    if (!identity) return item;
    const artworkUrl = safeArtworkUrl(item._extra?.artworkUrl, identity.origin)
      || safeArtworkUrl(item._extra?.previewUrl, identity.origin)
      || safeArtworkUrl(item.thumbnail, identity.origin);
    item.thumbnail = '';
    item._extra = {
      ...(isPlainObject(item._extra) ? item._extra : {}),
      artworkUrl,
      needsArtwork: !!artworkUrl,
    };
    if (!artworkUrl) return item;
    const controller = new AbortController();
    const unlink = linkSignal(opts.signal, controller);
    assetControllers.add(controller);
    try {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const registration = await registerAssetImpl({
        url: artworkUrl,
        sourceId: id,
        itemId: item.id,
      }, { signal: controller.signal });
      if (controller.signal.aborted || disposed) {
        throw abortError(controller.signal.reason || 'PeerTube adapter disposed');
      }
      const relayUrl = assetRelayUrl(registration?.relay_url);
      if (!relayUrl) throw fail('PEERTUBE_ASSET_INVALID', 'Artwork relay returned an invalid PeerTube registration.');
      item.thumbnail = relayUrl;
      item._extra.needsArtwork = false;
      return item;
    } finally {
      unlink();
      assetControllers.delete(controller);
    }
  }

  async function random(opts = {}) {
    ensureOpen();
    const explicit = showExplicit(opts);
    let items = [...reservoir.values()]
      .filter((item) => explicit || item.content_rating !== 'explicit')
      .map(cloneItem);
    if (items.length === 0) {
      await browse({ ...opts, showExplicitContent: explicit, limit: APP_PAGE_SIZE });
      items = [...reservoir.values()]
        .filter((item) => explicit || item.content_rating !== 'explicit')
        .map(cloneItem);
    }
    for (let index = items.length - 1; index > 0; index--) {
      const value = Number(randomValue());
      const other = Number.isFinite(value)
        ? Math.max(0, Math.min(index, Math.floor(value * (index + 1))))
        : 0;
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items.slice(0, Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || 12)));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of assetControllers) {
      controller.abort(abortError('PeerTube adapter disposed'));
    }
    assetControllers.clear();
    indexScheduler.dispose?.('PeerTube adapter disposed');
    originScheduler.dispose?.('PeerTube adapter disposed');
    indexCache.clear();
    detailCache.clear();
    reservoir.clear();
    standaloneBuffer.length = 0;
    standaloneCursor = null;
    standaloneExhausted = false;
    standaloneExplicit = null;
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

const defaultAdapter = createPeerTubeAdapter();

export const browse = (...args) => defaultAdapter.browse(...args);
export const browsePage = (...args) => defaultAdapter.browsePage(...args);
export const search = (...args) => defaultAdapter.search(...args);
export const searchPage = (...args) => defaultAdapter.searchPage(...args);
export const random = (...args) => defaultAdapter.random(...args);
export const resolveStream = (...args) => defaultAdapter.resolveStream(...args);
export const resolveArtwork = (...args) => defaultAdapter.resolveArtwork(...args);
export const dispose = (...args) => defaultAdapter.dispose(...args);
