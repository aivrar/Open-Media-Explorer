/**
 * Owncast live-directory adapter.
 *
 * The browser never downloads or joins Owncast directory data itself. The
 * authenticated native gateway fetches the two fixed public-directory URLs,
 * parses the M3U, joins every entry to an exact boolean NSFW rating, and emits
 * one bounded snapshot. Dynamic stream and logo origins can then cross only
 * the native media and opaque asset registries.
 */

import { makeItem, prefixId } from '../lib/item-model.js';
import { getOwncastSnapshot, registerCatalogAsset } from '../lib/catalog-client.js';

export const id = 'owncast';
export const displayName = 'Owncast';
export const itemTypes = ['tv'];
export const catalogPolicy = Object.freeze({ maxConcurrent: 1, minIntervalMs: 0 });

export const OWNCAST_REFRESH_AFTER_MS = 2 * 60 * 1000;
export const OWNCAST_STALE_RETRY_MS = 30 * 1000;

const APP_PAGE_SIZE = 30;
const MAX_SNAPSHOT_ITEMS = 5_000;
const MAX_TAGS = 16;
const MAX_DESCRIPTION = 2_000;
const MAX_INPUT_TEXT = 16_000;
const CACHE_STATES = new Set(['fresh', 'updated', 'revalidated', 'stale', 'uncached']);
const CONTENT_RATINGS = new Set(['explicit', 'not-explicit']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const DISPLAY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:access|apikey|auth|authorization|credential|key|pass|password|secret|sig|signature|token)(?:$|[_-])/i;

export class OwncastSchemaError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'OwncastSchemaError';
    this.code = 'OWNCAST_SCHEMA_INVALID';
  }
}

function schema(message) {
  throw new OwncastSchemaError(message);
}

function abortError(reason = 'Cancelled') {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
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

function boundedPlainText(value, maxLength = MAX_DESCRIPTION) {
  if (typeof value !== 'string' || !value) return '';
  const bounded = value.slice(0, MAX_INPUT_TEXT)
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

function privateIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function publicIpv6Literal(host) {
  if (!host.includes(':') || host.includes('%')) return false;
  const pieces = host.toLowerCase().split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (pieces.length === 1 && left.length !== 8) return false;
  const missing = 8 - left.length - right.length;
  if (missing < (pieces.length === 2 ? 1 : 0)) return false;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(`0x${group}`);
  // Current public IPv6 unicast space is 2000::/3. Exclude the documentation
  // range explicitly; mapped, local, link-local, multicast, and unspecified
  // literals all fall outside this conservative public range.
  const publicUnicast = (value >> 125n) === 1n;
  const documentation = (value >> 96n) === 0x20010db8n;
  return publicUnicast && !documentation;
}

function obviouslyPrivateHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (privateIpv4(host)) return true;
  if (!host.includes(':')) return false;
  return !publicIpv6Literal(host);
}

function parsePublicUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192
      || CONTROL_PATTERN.test(value) || value.includes('\\')) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || !parsed.hostname || parsed.port === '0' || obviouslyPrivateHost(parsed.hostname)) return null;
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return parsed;
  } catch (_) {
    return null;
  }
}

export function normalizeInstanceUrl(value) {
  const parsed = parsePublicUrl(value);
  if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
  return `${parsed.origin}/`;
}

export function normalizeOwncastStreamUrl(value, instanceUrl) {
  const parsed = parsePublicUrl(value);
  if (!parsed || parsed.hash || !parsed.pathname.toLowerCase().endsWith('.m3u8')) return '';
  try {
    if (parsed.origin !== new URL(instanceUrl).origin) return '';
  } catch (_) {
    return '';
  }
  return parsed.href;
}

function safeArtworkUrl(value) {
  const parsed = parsePublicUrl(value);
  if (!parsed || parsed.hash || /\.(?:svg|ico)$/i.test(parsed.pathname)) return '';
  for (const key of parsed.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return '';
  return parsed.href;
}

function assetRelayUrl(value) {
  return typeof value === 'string' && /^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(value)
    ? value
    : '';
}

function exactDate(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 128) schema('Owncast date metadata is malformed.');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) schema('Owncast date metadata is malformed.');
  const year = new Date(time).getUTCFullYear();
  if (year < 1900 || year > 3000) schema('Owncast date metadata is malformed.');
  return new Date(time).toISOString();
}

function normalizedTags(value, explicit) {
  if (!Array.isArray(value) || value.length > MAX_TAGS) schema('Owncast tags are malformed.');
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') schema('Owncast tags are malformed.');
    const tag = cleanString(raw, 64);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  // Existing detail views already render tags. Keeping this explicit marker in
  // the item makes deliberately enabled adult entries visibly identifiable
  // even before Phase 8 adds its compact card badge.
  if (explicit && !seen.has('explicit')) {
    if (result.length >= MAX_TAGS) result.pop();
    result.push('Explicit');
  }
  return result;
}

function cloneItem(item) {
  return {
    ...item,
    tags: [...(item.tags || [])],
    capture_headers: { ...(item.capture_headers || {}) },
    ...(isPlainObject(item._extra) ? { _extra: { ...item._extra } } : {}),
  };
}

async function defaultSha256Hex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
    throw new Error('SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function showExplicit(opts, fallback) {
  if (Object.hasOwn(opts || {}, 'showExplicitContent')) return opts.showExplicitContent === true;
  return fallback() === true;
}

function retryDelay(error) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(30_000, Number(error.retryAfterMs));
  if (Number.isFinite(error?.retryAfter)) return Math.max(30_000, Number(error.retryAfter) * 1_000);
  return OWNCAST_STALE_RETRY_MS;
}

function canUseLocalLastGood(error) {
  if (!error || error.name === 'AbortError' || error instanceof OwncastSchemaError) return false;
  const status = Number(error.status || 0);
  if (status >= 400 && status < 500 && error.retryable !== true) return false;
  return true;
}

export function createOwncastAdapter(dependencies = {}) {
  const getSnapshotImpl = dependencies.getOwncastSnapshot || getOwncastSnapshot;
  const registerAssetImpl = dependencies.registerCatalogAsset || registerCatalogAsset;
  const hashText = dependencies.sha256Hex || defaultSha256Hex;
  const randomValue = dependencies.random || Math.random;
  const monotonicNow = dependencies.monotonicNow || (() => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  ));
  const explicitFallback = dependencies.getShowExplicitContent || (() => false);
  const assetControllers = new Set();
  const idCache = new Map();
  let current = null;
  let activeLoad = null;
  let disposed = false;

  function ensureOpen() {
    if (disposed) throw abortError('Owncast adapter disposed');
  }

  async function stableId(instanceUrl) {
    let digest = idCache.get(instanceUrl);
    if (!digest) {
      digest = String(await hashText(instanceUrl)).toLowerCase();
      if (!SHA256_HEX.test(digest)) schema('Owncast identity hash is invalid.');
      idCache.set(instanceUrl, digest);
      while (idCache.size > MAX_SNAPSHOT_ITEMS) idCache.delete(idCache.keys().next().value);
    }
    return prefixId(id, digest);
  }

  async function normalizeRawItem(raw) {
    if (!isPlainObject(raw)) schema('Owncast snapshot item is malformed.');
    if (typeof raw.nsfw !== 'boolean' || !CONTENT_RATINGS.has(raw.content_rating)
        || (raw.nsfw ? 'explicit' : 'not-explicit') !== raw.content_rating) {
      schema('Owncast content rating is missing or inconsistent.');
    }
    if (raw.delivery !== 'live' || raw.media_type !== 'hls' || raw.recording_kind !== 'video') {
      schema('Owncast delivery metadata is malformed.');
    }
    const instanceUrl = normalizeInstanceUrl(raw.instance_url);
    const streamUrl = normalizeOwncastStreamUrl(raw.stream_url, instanceUrl);
    if (!instanceUrl || !streamUrl) schema('Owncast stream origin or playlist URL is unsafe.');
    for (const field of ['name', 'stream_title', 'description', 'logo_url', 'last_seen', 'streaming_since']) {
      if (typeof raw[field] !== 'string') schema(`Owncast ${field} metadata is malformed.`);
    }
    const name = cleanString(raw.name, 300);
    const streamTitle = cleanString(raw.stream_title, 300);
    const description = boundedPlainText(raw.description);
    // Artwork is optional. A broken/private logo must not suppress an otherwise
    // verified live stream; discarding it is safe because later hydration can
    // only occur through the native asset registry.
    const artworkUrl = raw.logo_url ? safeArtworkUrl(raw.logo_url) : '';
    const lastSeen = exactDate(raw.last_seen);
    const streamingSince = exactDate(raw.streaming_since);
    const explicit = raw.content_rating === 'explicit';
    const title = streamTitle || name || new URL(instanceUrl).hostname;
    if (!title) schema('Owncast title is missing.');
    return makeItem({
      id: await stableId(instanceUrl),
      title,
      description,
      source: id,
      type: 'tv',
      stream_url: streamUrl,
      stream_kind: 'hls',
      delivery: 'live',
      download_url: '',
      download_name: '',
      thumbnail: '',
      year: null,
      country: '',
      language: '',
      tags: normalizedTags(raw.tags, explicit),
      license: 'Independent broadcaster - see source',
      source_url: instanceUrl,
      content_rating: raw.content_rating,
      _extra: {
        instanceUrl,
        artworkUrl,
        nsfw: raw.nsfw,
        lastSeen,
        streamingSince,
        needsResolve: false,
        downloadResolved: true,
        resolutionStatus: 'playable',
        snapshotItem: true,
      },
    });
  }

  async function snapshotDigest(items) {
    if (items.length === 0) return 'empty';
    const serialized = items
      .map((item) => JSON.stringify([
        item.id, item.title, item.description, item.stream_url, item.thumbnail,
        item.content_rating, item.tags, item._extra?.artworkUrl,
        item._extra?.lastSeen, item._extra?.streamingSince,
      ]))
      .sort().join('\n');
    const digest = String(await hashText(serialized)).toLowerCase();
    if (!SHA256_HEX.test(digest)) schema('Owncast snapshot hash is invalid.');
    return digest;
  }

  async function normalizePayload(payload) {
    if (!isPlainObject(payload) || payload.provider !== id || !Array.isArray(payload.items)
        || payload.items.length > MAX_SNAPSHOT_ITEMS || !isPlainObject(payload.cache)
        || !CACHE_STATES.has(payload.cache.state) || typeof payload.cache.stale !== 'boolean'
        || payload.cache.stale !== (payload.cache.state === 'stale')) {
      schema('Owncast snapshot response is malformed.');
    }
    if (payload.cache.reason != null && typeof payload.cache.reason !== 'string') {
      schema('Owncast cache status is malformed.');
    }
    const items = [];
    const byInstance = new Map();
    // Bound concurrent WebCrypto jobs so a maximally sized directory cannot
    // monopolize either the renderer or its crypto worker queue.
    for (let start = 0; start < payload.items.length; start += 32) {
      const batch = await Promise.all(payload.items.slice(start, start + 32).map(normalizeRawItem));
      for (const item of batch) {
        const previous = byInstance.get(item._extra.instanceUrl);
        if (previous) {
          if (previous.stream_url !== item.stream_url
              || previous.content_rating !== item.content_rating) {
            schema('Owncast snapshot contains a conflicting duplicate origin.');
          }
          continue;
        }
        byInstance.set(item._extra.instanceUrl, item);
        items.push(item);
      }
    }
    const allSnapshotId = `owncast-snapshot:${await snapshotDigest(items)}`;
    for (const item of items) item._extra.snapshotId = allSnapshotId;
    return {
      items,
      byId: new Map(items.map((item) => [item.id, item])),
      snapshotId: allSnapshotId,
      stale: payload.cache.stale,
      cacheState: payload.cache.state,
      error: cleanString(payload.cache.reason, 128),
      retryAfterMs: OWNCAST_STALE_RETRY_MS,
      loadedAt: monotonicNow(),
      filteredViews: new Map(),
    };
  }

  function startSnapshotLoad() {
    const load = {
      controller: new AbortController(), promise: null, waiters: 0, settled: false,
    };
    load.promise = (async () => {
      try {
        const payload = await getSnapshotImpl({ signal: load.controller.signal });
        const normalized = await normalizePayload(payload);
        if (disposed || load.controller.signal.aborted) {
          throw abortError(load.controller.signal.reason || 'Owncast adapter disposed');
        }
        current = normalized;
        return normalized;
      } catch (error) {
        if (error?.name === 'AbortError' || load.controller.signal.aborted || disposed) {
          throw abortError(error || load.controller.signal.reason);
        }
        if (current && canUseLocalLastGood(error)) {
          current = {
            ...current,
            stale: true,
            cacheState: 'stale',
            error: cleanString(error.code || error.message || 'OWNCAST_REFRESH_FAILED', 128),
            retryAfterMs: retryDelay(error),
            loadedAt: monotonicNow(),
          };
          return current;
        }
        throw error;
      } finally {
        load.settled = true;
        if (activeLoad === load) activeLoad = null;
      }
    })();
    // An already-aborted sole waiter can leave before attaching its forwarding
    // handler. Keep the shared operation's terminal rejection observed while
    // each live waiter still receives the original result through `.then`.
    void load.promise.catch(() => {});
    activeLoad = load;
    return load;
  }

  function joinSnapshotLoad(signal) {
    ensureOpen();
    const load = activeLoad || startSnapshotLoad();
    load.waiters += 1;
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (callback, value) => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener?.('abort', onAbort);
        load.waiters = Math.max(0, load.waiters - 1);
        callback(value);
      };
      const onAbort = () => {
        finish(reject, abortError(signal.reason));
        if (load.waiters === 0 && !load.settled) {
          load.controller.abort(abortError(signal.reason || 'Owncast refresh cancelled'));
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      load.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async function filteredSnapshot(base, opts = {}) {
    const explicit = showExplicit(opts, explicitFallback);
    const cacheKey = explicit ? 'all' : 'safe';
    let view = base.filteredViews.get(cacheKey);
    if (!view) {
      const items = base.items.filter((item) => explicit || item.content_rating !== 'explicit');
      const snapshotId = items.length === base.items.length
        ? base.snapshotId
        : `owncast-snapshot:${await snapshotDigest(items)}`;
      view = { items, snapshotId };
      base.filteredViews.set(cacheKey, view);
    }
    return {
      items: view.items,
      snapshotId: view.snapshotId,
      refreshAfterMs: OWNCAST_REFRESH_AFTER_MS,
      stale: base.stale,
      error: base.error,
      retryAfterMs: base.retryAfterMs,
    };
  }

  async function refreshSnapshot(opts = {}) {
    // Search can populate the adapter immediately before the central snapshot
    // manager adopts it. Reuse that still-current verified result so adoption
    // starts exactly one timer rather than issuing a duplicate native request.
    const base = current && opts.force !== true
      && monotonicNow() - current.loadedAt < OWNCAST_REFRESH_AFTER_MS
      ? current
      : await joinSnapshotLoad(opts.signal);
    const snapshot = await filteredSnapshot(base, opts);
    return { ...snapshot, items: snapshot.items.map(cloneItem) };
  }

  async function ensureSnapshot(opts = {}) {
    ensureOpen();
    return current || joinSnapshotLoad(opts.signal);
  }

  async function browsePage() {
    ensureOpen();
    return {
      items: [], cursor: null, exhausted: true, snapshotOnly: true,
    };
  }

  async function browse(opts = {}) {
    const snapshot = await filteredSnapshot(await ensureSnapshot(opts), opts);
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    return snapshot.items.slice(offset, offset + limit).map(cloneItem);
  }

  function searchHaystack(item) {
    return [
      item.title, item.description, item.source_url,
      ...(item.tags || []),
    ].join(' ').toLocaleLowerCase();
  }

  async function search(query, opts = {}) {
    const normalized = cleanString(query, 200).toLocaleLowerCase();
    if (!normalized) return [];
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const snapshot = await filteredSnapshot(await ensureSnapshot(opts), opts);
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    const limit = Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || APP_PAGE_SIZE));
    return snapshot.items.filter((item) => {
      const haystack = searchHaystack(item);
      return tokens.every((token) => haystack.includes(token));
    }).slice(offset, offset + limit).map(cloneItem);
  }

  async function random(opts = {}) {
    ensureOpen();
    if (!current) return [];
    const snapshot = await filteredSnapshot(current, opts);
    const items = snapshot.items.map(cloneItem);
    for (let index = items.length - 1; index > 0; index--) {
      const value = Number(randomValue());
      const other = Number.isFinite(value)
        ? Math.max(0, Math.min(index, Math.floor(value * (index + 1))))
        : 0;
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items.slice(0, Math.max(1, Math.min(APP_PAGE_SIZE, Number(opts.limit) || 12)));
  }

  function markUnavailable(item, reason) {
    item.stream_url = '';
    item.download_url = '';
    item.download_name = '';
    item.capture_headers = {};
    item._extra = {
      ...(isPlainObject(item._extra) ? item._extra : {}),
      needsResolve: false,
      downloadResolved: true,
      resolutionStatus: reason === 'EXPLICIT_DISABLED' ? 'blocked' : 'unavailable',
      validationError: reason,
      snapshotItem: true,
    };
    return item;
  }

  async function resolveStream(item, opts = {}) {
    if (!item || item.source !== id) return item;
    ensureOpen();
    if (item.content_rating === 'explicit' && !showExplicit(opts, explicitFallback)) {
      return markUnavailable(item, 'EXPLICIT_DISABLED');
    }
    let base = current;
    let match = base?.byId.get(item.id) || null;
    // A current verified snapshot is already the authoritative revalidation
    // for an older persisted favorite. Only an absent/offline entry needs an
    // immediate native retry instead of another redundant directory request.
    const mustRevalidate = !base || !match || item.__snapshotOffline === true;
    if (mustRevalidate) {
      base = await joinSnapshotLoad(opts.signal);
      match = base.byId.get(item.id) || null;
    }
    if (!match || match.content_rating === 'explicit' && !showExplicit(opts, explicitFallback)) {
      return markUnavailable(item, match ? 'EXPLICIT_DISABLED' : 'OWNCAST_STREAM_OFFLINE');
    }
    const preserved = {
      __query: item.__query,
      __queries: Array.isArray(item.__queries) ? [...item.__queries] : [],
      __revision: item.__revision,
      __snapshotOffline: false,
    };
    Object.assign(item, cloneItem(match), preserved);
    return item;
  }

  async function resolveArtwork(item, opts = {}) {
    if (!item || item.source !== id) return item;
    ensureOpen();
    if (assetRelayUrl(item.thumbnail)) return item;
    const artworkUrl = safeArtworkUrl(item._extra?.artworkUrl);
    item.thumbnail = '';
    item._extra = {
      ...(isPlainObject(item._extra) ? item._extra : {}),
      artworkUrl,
      needsArtwork: !!artworkUrl,
    };
    if (!artworkUrl) return item;
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(opts.signal.reason));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener?.('abort', onAbort, { once: true });
    assetControllers.add(controller);
    try {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const registration = await registerAssetImpl({
        url: artworkUrl,
        sourceId: id,
        itemId: item.id,
      }, { signal: controller.signal });
      if (disposed || controller.signal.aborted) {
        throw abortError(controller.signal.reason || 'Owncast adapter disposed');
      }
      const relayUrl = assetRelayUrl(registration?.relay_url);
      if (!relayUrl) schema('Artwork relay returned an invalid Owncast registration.');
      item.thumbnail = relayUrl;
      item._extra.needsArtwork = false;
      return item;
    } finally {
      opts.signal?.removeEventListener?.('abort', onAbort);
      assetControllers.delete(controller);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    activeLoad?.controller.abort(abortError('Owncast adapter disposed'));
    for (const controller of assetControllers) {
      controller.abort(abortError('Owncast adapter disposed'));
    }
    assetControllers.clear();
    activeLoad = null;
    current = null;
    idCache.clear();
  }

  return {
    browse,
    browsePage,
    search,
    random,
    resolveStream,
    resolveArtwork,
    refreshSnapshot,
    dispose,
  };
}

const defaultAdapter = createOwncastAdapter();

export const browse = (...args) => defaultAdapter.browse(...args);
export const browsePage = (...args) => defaultAdapter.browsePage(...args);
export const search = (...args) => defaultAdapter.search(...args);
export const random = (...args) => defaultAdapter.random(...args);
export const resolveStream = (...args) => defaultAdapter.resolveStream(...args);
export const resolveArtwork = (...args) => defaultAdapter.resolveArtwork(...args);
export const refreshSnapshot = (...args) => defaultAdapter.refreshSnapshot(...args);
export const dispose = (...args) => defaultAdapter.dispose(...args);
