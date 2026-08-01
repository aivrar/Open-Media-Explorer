/**
 * Internet Archive adapter.
 * Uses advancedsearch + per-identifier metadata to resolve playable streams.
 */

import { getJson } from '../lib/http.js';
import { makeItem, prefixId } from '../lib/item-model.js';

export const id = 'internet-archive';
export const displayName = 'Internet Archive';
export const itemTypes = ['video', 'audio'];

const BASE = 'https://archive.org';
const DEFAULT_FILTER = '(mediatype:movies OR mediatype:audio) AND -access-restricted-item:true';
const TRANSPORT_RETRIES = 2;
const TRANSPORT_RETRY_BASE_MS = 400;

// Curated starter collections used by browse + filtering UI.
export const COLLECTIONS = [
  { id: 'prelinger',     label: 'Prelinger Archives',  type: 'video' },
  { id: 'feature_films', label: 'Feature Films',       type: 'video' },
  { id: 'classic_tv',    label: 'Classic TV',          type: 'video' },
  { id: 'fedflix',       label: 'FedFlix',             type: 'video' },
  { id: 'classic_cartoons', label: 'Classic Cartoons', type: 'video' },
  { id: 'tvnews',        label: 'TV News',             type: 'video' },
  { id: 'librivoxaudio', label: 'LibriVox Audio',      type: 'audio' },
];

const COLLECTION_ID_SET = new Set(COLLECTIONS.map(({ id: collectionId }) => collectionId));
// These two curated buckets currently return a valid zero inventory for the
// playable-media filter. A zero first page from the other well-known nonempty
// buckets is treated as transient so a brownout can never retire the source.
const ALLOW_EMPTY_COLLECTIONS = new Set(['fedflix', 'tvnews']);

const metaCache = new Map(); // identifier -> metadata response

// Token-bucket rate limit — spec §3.2.3 asks for max 5 requests/sec.
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 5;
const rateWindow = [];
async function rateLimit() {
  const now = Date.now();
  while (rateWindow.length && rateWindow[0] < now - RATE_WINDOW_MS) rateWindow.shift();
  if (rateWindow.length >= RATE_MAX) {
    const wait = RATE_WINDOW_MS - (now - rateWindow[0]) + 5;
    await new Promise((r) => setTimeout(r, wait));
  }
  rateWindow.push(Date.now());
}

async function fetchMetadata(identifier) {
  if (metaCache.has(identifier)) return metaCache.get(identifier);
  await rateLimit();
  const data = await getJson(`${BASE}/metadata/${encodeURIComponent(identifier)}`);
  metaCache.set(identifier, data);
  return data;
}

const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];
const AUDIO_EXTS = ['mp3', 'ogg', 'oga', 'm4a', 'flac', 'wav'];

function pickPlayable(metadata, isVideo) {
  if (!metadata || !Array.isArray(metadata.files)) return null;
  const wantExts = isVideo ? VIDEO_EXTS : AUDIO_EXTS;
  // Prefer derivative for quick streaming, then original.
  const candidates = metadata.files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    return wantExts.some((ext) => name.endsWith('.' + ext));
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aDer = a.source === 'derivative' ? 0 : 1;
    const bDer = b.source === 'derivative' ? 0 : 1;
    if (aDer !== bDer) return aDer - bDer;
    // Prefer mp4 over webm over others for compatibility
    const order = ['mp4', 'mp3', 'm4a', 'm4v', 'webm', 'ogg', 'oga', 'ogv', 'flac', 'wav', 'mov'];
    const aExt = (a.name || '').split('.').pop().toLowerCase();
    const bExt = (b.name || '').split('.').pop().toLowerCase();
    return order.indexOf(aExt) - order.indexOf(bExt);
  });
  return candidates[0];
}

function licenseFromUrl(urlOrText, collections = []) {
  if (!urlOrText) {
    if (collections.includes('prelinger') || collections.includes('feature_films')) return 'Public Domain';
    return 'See source';
  }
  const u = String(urlOrText).toLowerCase();
  if (u.includes('publicdomain')) return 'Public Domain';
  if (u.includes('cc0')) return 'CC0';
  if (u.includes('by-sa')) return 'CC BY-SA';
  if (u.includes('by-nc-sa')) return 'CC BY-NC-SA';
  if (u.includes('by-nc')) return 'CC BY-NC';
  if (u.includes('by-nd')) return 'CC BY-ND';
  if (u.includes('by')) return 'CC BY';
  return 'See source';
}

function toItemFromDoc(doc) {
  if (!doc || !doc.identifier) return null;
  const mediatype = String(doc.mediatype || '').toLowerCase();
  const isVideo = mediatype === 'movies';
  const collections = Array.isArray(doc.collection) ? doc.collection.map((c) => String(c).toLowerCase()) : (doc.collection ? [String(doc.collection).toLowerCase()] : []);
  let year = null;
  if (doc.year) {
    const y = parseInt(String(doc.year), 10);
    if (Number.isFinite(y)) year = y;
  }
  return makeItem({
    id: prefixId(id, doc.identifier),
    title: doc.title || doc.identifier,
    description: Array.isArray(doc.description) ? doc.description.join('\n') : (doc.description || ''),
    source: id,
    type: isVideo ? 'video' : 'audio',
    stream_url: '', // resolved lazily via fetchMetadata on play
    stream_kind: isVideo ? 'video' : 'audio',
    delivery: 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: `${BASE}/services/img/${encodeURIComponent(doc.identifier)}`,
    year,
    country: '',
    language: Array.isArray(doc.language) ? (doc.language[0] || '') : (doc.language || ''),
    tags: Array.isArray(doc.subject) ? doc.subject.slice(0, 10).map(String) : (doc.subject ? [String(doc.subject)] : []),
    license: licenseFromUrl(doc.licenseurl, collections),
    source_url: `${BASE}/details/${encodeURIComponent(doc.identifier)}`,
    _extra: { identifier: doc.identifier, mediatype, collections, needsResolve: true },
  });
}

/**
 * Lazy resolver — fetches the per-identifier metadata to discover the playable
 * file, then sets stream_url. Spec §3.2.3 prescribes fetching metadata "once"
 * per item; we cache by identifier so concurrent resolves dedupe naturally.
 */
export async function resolveStream(item) {
  if (!item || !item._extra?.needsResolve) return item;
  try {
    const meta = await fetchMetadata(item._extra.identifier);
    const file = pickPlayable(meta, item.type === 'video');
    if (file) {
      item.stream_url = `${BASE}/download/${encodeURIComponent(item._extra.identifier)}/${encodeURIComponent(file.name)}`;
      item.download_url = item.stream_url;
      item.download_name = file.name || '';
      item._extra.needsResolve = false;
    }
  } catch (err) {
    console.warn('IA resolve failed:', err);
  }
  return item;
}

function buildQuery(query, collection) {
  const parts = [DEFAULT_FILTER];
  if (query) parts.push(`(${query})`);
  if (collection) parts.push(`collection:${collection}`);
  return parts.join(' AND ');
}

async function advancedSearchPage(query, opts) {
  const rows = Math.min(opts.limit || 20, 50);
  const page = opts.page || Math.floor((opts.offset || 0) / rows) + 1;
  const fl = ['identifier', 'title', 'description', 'year', 'mediatype', 'licenseurl', 'subject', 'language', 'collection'];
  const params = new URLSearchParams();
  params.set('q', buildQuery(query, opts.collection));
  for (const f of fl) params.append('fl[]', f);
  if (opts.sort === 'random') params.append('sort[]', 'random');
  else params.append('sort[]', '-downloads');
  params.set('output', 'json');
  params.set('rows', String(rows));
  params.set('page', String(page));
  const url = `${BASE}/advancedsearch.php?${params.toString()}`;
  await rateLimit();
  // Archive can briefly refuse a new HTTPS connection while its search API is
  // otherwise healthy. Absorb two short transport failures here so the
  // library-level retry state is reserved for a genuine outage.
  const data = await getJson(url, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries ?? TRANSPORT_RETRIES,
    retryBaseMs: opts.retryBaseMs ?? TRANSPORT_RETRY_BASE_MS,
  });
  if (!data || typeof data !== 'object' || !Array.isArray(data?.response?.docs)) {
    throw new TypeError('Internet Archive returned an invalid search response');
  }
  const docs = data.response.docs;
  const total = Number(data?.response?.numFound || 0);
  return {
    items: docs.map(toItemFromDoc).filter(Boolean),
    rawCount: docs.length,
    total,
    page,
    rows,
  };
}

async function advancedSearch(query, opts) {
  return (await advancedSearchPage(query, opts)).items;
}

function rotatedCollectionIds(initialCollection) {
  const startIndex = COLLECTIONS.findIndex(({ id: collectionId }) => collectionId === initialCollection);
  if (startIndex < 0) return [initialCollection];
  return COLLECTIONS.map((_, offset) => COLLECTIONS[(startIndex + offset) % COLLECTIONS.length].id);
}

function positivePage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function pageStart(result) {
  return (result.page - 1) * result.rows;
}

function assertCompleteSearchPage(result) {
  // A short/empty page before numFound says the collection ends is an
  // inconsistent Archive response, not exhaustion. Retrying the same cursor
  // avoids silently skipping items or completing a source during a brownout.
  if (result.total > 0
      && result.rawCount < result.rows
      && pageStart(result) + result.rawCount < result.total) {
    const label = result.page === 1 && result.rawCount === 0
      ? 'empty first'
      : 'incomplete';
    throw new Error(`Internet Archive returned a transient ${label} page`);
  }
}

function searchPageExhausted(result) {
  if (result.total > 0) {
    return pageStart(result) + result.rawCount >= result.total;
  }
  return result.rawCount < result.rows;
}

function nextRemainingCollection(order, remaining, current) {
  if (remaining.length === 0) return null;
  const start = Math.max(0, order.indexOf(current));
  for (let offset = 1; offset <= order.length; offset++) {
    const candidate = order[(start + offset) % order.length];
    if (remaining.includes(candidate)) return candidate;
  }
  return remaining[0];
}

function automaticBrowseState(cursor, initialCollection) {
  const source = cursor && typeof cursor === 'object' ? cursor : {};
  const legacyCollection = COLLECTION_ID_SET.has(source.collection) ? source.collection : null;
  const startCollection = COLLECTION_ID_SET.has(source.startCollection)
    ? source.startCollection
    : (legacyCollection || initialCollection);
  const order = rotatedCollectionIds(startCollection);
  const hasSavedRemaining = source.mode === 'automatic'
    && Array.isArray(source.remainingCollections);
  const savedRemaining = new Set(hasSavedRemaining ? source.remainingCollections : order);
  const remaining = order.filter((collection) => savedRemaining.has(collection));
  const savedPages = source.pages && typeof source.pages === 'object' ? source.pages : {};
  const pages = Object.fromEntries(order.map((collection) => [
    collection,
    positivePage(savedPages[collection]),
  ]));
  if (source.mode !== 'automatic' && legacyCollection) {
    pages[legacyCollection] = positivePage(source.page);
  }
  const requestedNext = COLLECTION_ID_SET.has(source.nextCollection)
    ? source.nextCollection
    : legacyCollection;
  const nextCollection = remaining.includes(requestedNext)
    ? requestedNext
    : (remaining[0] || null);
  return { startCollection, order, remaining, pages, nextCollection };
}

function automaticCursor(state) {
  const nextCollection = state.remaining.includes(state.nextCollection)
    ? state.nextCollection
    : (state.remaining[0] || null);
  return {
    mode: 'automatic',
    startCollection: state.startCollection,
    nextCollection,
    // Keep the legacy fields readable for diagnostics and hot-reload
    // compatibility; mode/pages remain authoritative.
    collection: nextCollection,
    page: nextCollection ? state.pages[nextCollection] : 1,
    pages: { ...state.pages },
    remainingCollections: [...state.remaining],
  };
}

async function automaticBrowsePage(opts, cursor) {
  const initialCollection = COLLECTIONS[Math.floor(Date.now() / 600000) % COLLECTIONS.length].id;
  const state = automaticBrowseState(cursor, initialCollection);
  if (state.remaining.length === 0) {
    return { items: [], cursor: automaticCursor(state), exhausted: true };
  }

  // At most one request per currently active collection in one call. Empty
  // allowed buckets are skipped immediately; suspicious zero pages remain in
  // the cursor and trigger the library's bounded retry rather than completion.
  const attemptLimit = state.remaining.length;
  let sawTransientEmpty = false;
  for (let attempt = 0; attempt < attemptLimit && state.remaining.length > 0; attempt++) {
    const collection = state.remaining.includes(state.nextCollection)
      ? state.nextCollection
      : state.remaining[0];
    const page = state.pages[collection];
    const result = await advancedSearchPage('', { ...opts, collection, page });
    assertCompleteSearchPage(result);

    if (result.rawCount === 0 && result.total === 0) {
      if (page === 1 && ALLOW_EMPTY_COLLECTIONS.has(collection)) {
        state.remaining = state.remaining.filter((candidate) => candidate !== collection);
      } else {
        sawTransientEmpty = true;
      }
      state.nextCollection = nextRemainingCollection(
        state.order, state.remaining, collection,
      );
      continue;
    }

    if (result.rawCount > 0 && result.items.length === 0) {
      throw new TypeError('Internet Archive returned a page with no usable items');
    }

    state.pages[collection] = page + 1;
    if (searchPageExhausted(result)) {
      state.remaining = state.remaining.filter((candidate) => candidate !== collection);
    }
    state.nextCollection = nextRemainingCollection(
      state.order, state.remaining, collection,
    );

    if (result.items.length > 0) {
      return {
        items: result.items,
        cursor: automaticCursor(state),
        exhausted: state.remaining.length === 0,
      };
    }
  }

  if (sawTransientEmpty) {
    throw new Error('Internet Archive returned transient empty collection pages');
  }
  return {
    items: [],
    cursor: automaticCursor(state),
    exhausted: state.remaining.length === 0,
  };
}

async function firstNonemptyCollectionPage(query, opts, initialCollection, allowFallback) {
  const candidates = allowFallback ? rotatedCollectionIds(initialCollection) : [initialCollection];
  let collection = initialCollection;
  let result = null;
  for (const candidate of candidates) {
    collection = candidate;
    result = await advancedSearchPage(query, { ...opts, collection });
    if (result.rawCount > 0) break;
  }
  return { collection, result };
}

export async function search(query, opts = {}) {
  const q = (query || '').trim();
  const collection = opts.collection || (opts.tag && COLLECTIONS.find((c) => c.id === opts.tag)?.id);
  return advancedSearch(q, { ...opts, collection });
}

export async function browse(opts = {}) {
  const initialCollection = opts.collection
    || COLLECTIONS[Math.floor(Date.now() / 600000) % COLLECTIONS.length].id;
  const { result } = await firstNonemptyCollectionPage(
    '', opts, initialCollection, !opts.collection,
  );
  return result.items;
}

export async function browsePage(opts = {}) {
  const cursor = opts.cursor || {};
  if (!opts.collection) return automaticBrowsePage(opts, cursor);

  // An explicit collection remains exact and never rotates into another one.
  const collection = opts.collection;
  const pageNumber = positivePage(cursor.page);
  const result = await advancedSearchPage('', { ...opts, collection, page: pageNumber });
  assertCompleteSearchPage(result);
  if (pageNumber === 1 && result.rawCount === 0) {
    throw new Error('Internet Archive returned a transient empty first page');
  }
  return {
    items: result.items,
    cursor: { collection, page: pageNumber + 1 },
    exhausted: searchPageExhausted(result),
  };
}

export async function random(opts = {}) {
  const initialCollection = opts.collection
    || COLLECTIONS[Math.floor(Math.random() * COLLECTIONS.length)].id;
  const { result } = await firstNonemptyCollectionPage('', {
    ...opts,
    sort: 'random',
    limit: opts.limit || 12,
  }, initialCollection, !opts.collection);
  return result.items;
}
