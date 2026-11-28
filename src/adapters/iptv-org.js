/**
 * iptv-org adapter.
 * Pulls streams + channel metadata JSONs at startup and joins them into Items.
 * Source: https://github.com/iptv-org/api
 */

import { getJson } from '../lib/http.js';
import {
  makeItem, prefixId, detectStreamKind, safeExternalUrl, sanitizeCaptureHeaders,
} from '../lib/item-model.js';

export const id = 'iptv-org';
export const displayName = 'iptv-org';
export const itemTypes = ['tv'];

const API = 'https://iptv-org.github.io/api';

// A good channel list is used for this long; the next load after it fetches
// the list again while the old one stays in use (a failed refresh keeps it).
export const IPTV_FRESH_MS = 6 * 60 * 60 * 1000;
// After a failed refresh or logo download, the next try waits this long.
const RETRY_GAP_MS = 10 * 60 * 1000;
// Logos are optional: once streams and channels are in, the list waits at
// most this long for them (not at all when their download already failed).
export const LOGO_WAIT_MS = 6_000;

let cachedItemsPromise = null;
let cachedItems = null;
let cachedItemsById = new Map();
let cachedWithLogos = false;
let refreshAt = 0;
let logoMap = null;
let logosRequest = null;
let logosRetryAt = 0;
const FILTER_POOL_CACHE_MAX = 16;
const filteredPoolCache = new Map();
const MAX_STREAM_CANDIDATES = 8;

function normalizeStreamCandidate(stream) {
  const url = safeExternalUrl(stream?.url);
  if (!url) return null;
  const detected = detectStreamKind(url, 'video');
  return {
    url,
    feed: stream.feed,
    kind: detected === 'audio' ? 'video' : detected,
    headers: sanitizeCaptureHeaders({
      referer: stream.http_referrer || stream.referrer || '',
      userAgent: stream.user_agent || '',
    }),
    quality: typeof stream.quality === 'string' ? stream.quality.slice(0, 32) : '',
  };
}

function candidateScore(candidate) {
  const kind = candidate.kind === 'hls' ? 300 : candidate.kind === 'video' ? 200 : 100;
  const secure = candidate.url.startsWith('https://') ? 10 : 0;
  return kind + secure;
}

function selectCandidates(candidates) {
  const unique = new Map();
  candidates.forEach((candidate, index) => {
    if (!candidate) return;
    const key = JSON.stringify([candidate.url, candidate.kind, candidate.headers]);
    if (!unique.has(key)) unique.set(key, { ...candidate, index });
  });
  const selected = [...unique.values()]
    .sort((a, b) => candidateScore(b) - candidateScore(a) || a.index - b.index)
    .slice(0, MAX_STREAM_CANDIDATES);
  return {
    feed: selected[0]?.feed,
    candidates: selected.map(({ index: _index, feed: _feed, ...candidate }) => candidate),
  };
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function metadataScore(item) {
  return (item.thumbnail ? 100 : 0)
    + (item._extra?.hasChannel ? 40 : 0)
    + (item.country ? 10 : 0)
    + ((item.tags || []).length ? 6 : 0)
    + (item.language ? 3 : 0);
}

function compareItems(a, b) {
  return metadataScore(b) - metadataScore(a);
}

// logos.json lives separately from channels.json — channels.json carries no
// logo field. We join by channel id and prefer in-use, language-neutral logos.
function buildLogoMap(logos) {
  if (!Array.isArray(logos) || logos.length === 0) throw new TypeError('iptv-org returned no logos');
  const map = new Map();
  // Prefer in_use === true, square or near-square images, no tags (default variant).
  for (const lg of logos) {
    if (!lg?.channel || !lg?.url) continue;
    const existing = map.get(lg.channel);
    const isPref = lg.in_use !== false && (!lg.tags || lg.tags.length === 0);
    if (!existing) { map.set(lg.channel, { url: lg.url, pref: isPref }); continue; }
    if (!existing.pref && isPref) map.set(lg.channel, { url: lg.url, pref: isPref });
  }
  return map;
}

function keepList(items, withLogos) {
  cachedItems = items;
  cachedItemsById = new Map(items.map((item) => [item.id, item]));
  cachedWithLogos = withLogos;
  filteredPoolCache.clear();
}

/** Logos that arrived after the list was built: added in the same order, so
 *  pages already shown keep their places. */
function addLogos() {
  keepList(cachedItems.map((item) => {
    const channel = item._extra?.hasChannel ? item.id.slice(id.length + 1) : '';
    const logo = channel ? (logoMap.get(channel)?.url || '') : '';
    return logo && !item.thumbnail ? { ...item, thumbnail: logo } : item;
  }), true);
}

/** One logos.json download at a time; once in, it is kept for the session. */
function loadLogos() {
  if (logoMap) return Promise.resolve(logoMap);
  if (!logosRequest) {
    const request = getJson(`${API}/logos.json`).then((logos) => {
      logoMap = buildLogoMap(logos);
      if (cachedItems && !cachedWithLogos) addLogos();
      return logoMap;
    });
    const settle = () => { if (logosRequest === request) logosRequest = null; };
    request.then(settle, () => { logosRetryAt = Date.now() + RETRY_GAP_MS; settle(); });
    logosRequest = request;
  }
  return logosRequest;
}

function feedLanguageMap(feeds) {
  const exact = new Map();
  const main = new Map();
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (!feed?.channel || !Array.isArray(feed.languages)) continue;
    const language = feed.languages.find((value) => typeof value === 'string' && value.trim());
    if (!language) continue;
    exact.set(JSON.stringify([feed.channel, feed.id]), language);
    if (feed.is_main) main.set(feed.channel, language);
  }
  return { exact, main };
}

async function metadataWithin(pending, ms) {
  let timer = null;
  try {
    return await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLoaded(opts = {}) {
  if (cachedItems) {
    // The kept list answers at once; a stale one is fetched again (and
    // missing logos asked for again) in the background.
    const now = Date.now();
    if (now >= refreshAt) loadList().catch(() => {});
    else if (!cachedWithLogos && now >= logosRetryAt) loadLogos().catch(() => {});
    return cachedItems;
  }
  return awaitWithSignal(loadList(), opts.signal);
}

function loadList() {
  if (!cachedItemsPromise) {
    const request = (async () => {
    const pendingLogos = loadLogos().catch(() => null);
    const pendingFeeds = getJson(`${API}/feeds.json`).catch(() => null);
    const [streams, channels] = await Promise.all([
      getJson(`${API}/streams.json`),
      getJson(`${API}/channels.json`),
    ]);
    if (!Array.isArray(streams) || !Array.isArray(channels)) {
      throw new TypeError('iptv-org returned invalid streams or channels data');
    }
    // An empty answer is a failed load: never kept, and a previous good list stays.
    if (streams.length === 0 || channels.length === 0) {
      throw new TypeError('iptv-org returned no streams or no channels');
    }
    const [logos, feeds] = await Promise.all([
      logoMap || metadataWithin(pendingLogos, LOGO_WAIT_MS),
      metadataWithin(pendingFeeds, LOGO_WAIT_MS),
    ]);
    const { exact, main } = feedLanguageMap(feeds);
    const channelMap = new Map();
    for (const c of channels) channelMap.set(c.id, c);

    const groups = new Map();
    for (const s of streams) {
      const candidate = normalizeStreamCandidate(s);
      if (!candidate) continue;
      const ch = channelMap.get(s.channel);
      const rawId = s.channel || `${s.title || 'stream'}:${candidate.url}`;
      const itemId = prefixId(id, rawId);
      const existing = groups.get(itemId);
      if (existing) {
        existing.candidates.push(candidate);
        continue;
      }
      groups.set(itemId, { stream: s, channel: ch, candidates: [candidate] });
    }

    const items = [];
    for (const [itemId, group] of groups) {
      const { stream: s, channel: ch } = group;
      const { feed, candidates } = selectCandidates(group.candidates);
      const primary = candidates[0];
      if (!primary) continue;
      const isNsfw = ch?.is_nsfw === true;
      const logo = s.channel && logos ? (logos.get(s.channel)?.url || '') : '';
      // Languages moved from channels to feeds. Older data can still supply a channel language.
      const language = exact.get(JSON.stringify([s.channel, feed])) || main.get(s.channel) || ch?.languages?.[0]
        || (feeds == null ? cachedItemsById.get(itemId)?.language : '') || '';
      const item = makeItem({
        id: itemId,
        title: ch?.name || s.title || s.channel || 'Channel',
        description: (ch?.categories || []).join(', '),
        source: id,
        type: 'tv',
        stream_url: primary.url,
        stream_kind: primary.kind,
        delivery: 'live',
        download_url: '',
        download_name: '',
        capture_headers: primary.headers,
        thumbnail: logo,
        year: null,
        country: (ch?.country || '').toUpperCase(),
        language: language.trim().toLowerCase(),
        tags: [
          ...(ch?.categories || []).map((c) => String(c).toLowerCase()),
          ...(isNsfw ? ['Explicit'] : []),
        ],
        license: 'See source',
        source_url: ch?.website || (ch?.id ? `https://iptv-org.github.io/?ch=${ch.id}` : 'https://iptv-org.github.io/'),
        content_rating: isNsfw
          ? 'explicit'
          : (ch?.is_nsfw === false ? 'not-explicit' : 'unrated'),
        _extra: {
          hasChannel: !!s.channel,
          quality: primary.quality,
          streamCandidates: candidates,
        },
      });
      items.push(item);
    }
    // The upstream streams feed starts with thousands of unlinked streams whose
    // channel is null, which means no country/category/logo join is possible.
    // Keep them as fallback inventory, but surface fully joined channels first.
    if (items.length === 0) throw new TypeError('iptv-org returned no playable streams');
    items.sort(compareItems);
    keepList(items, !!logos);
    refreshAt = Date.now() + IPTV_FRESH_MS;
    return items;
    })();
    cachedItemsPromise = request;
    const settle = () => { if (cachedItemsPromise === request) cachedItemsPromise = null; };
    request.then(settle, () => {
      // A failed load must not poison the adapter for the rest of the app
      // session: the next caller gets a clean retry, and a failed refresh
      // keeps the old list for a while before trying again.
      if (cachedItems) refreshAt = Date.now() + RETRY_GAP_MS;
      settle();
    });
  }
  return cachedItemsPromise;
}

/** Refresh alternates for an older favorite before giving up on its saved URL. */
export async function refreshStreamCandidates(item, opts = {}) {
  if (!item?.id || item.source !== id) return item;
  await ensureLoaded(opts);
  const fresh = cachedItemsById.get(item.id);
  if (!fresh) return item;
  const candidates = Array.isArray(fresh._extra?.streamCandidates)
    ? fresh._extra.streamCandidates.map((candidate) => ({
      url: candidate.url,
      kind: candidate.kind,
      headers: { ...(candidate.headers || {}) },
      quality: candidate.quality || '',
    }))
    : [];
  item._extra = {
    ...(item._extra || {}),
    streamCandidates: candidates,
    streamCandidatesRefreshed: true,
  };
  if (!item.stream_url && candidates[0]) {
    item.stream_url = candidates[0].url;
    item.stream_kind = candidates[0].kind;
    item.capture_headers = { ...candidates[0].headers };
  }
  return item;
}

function filteredPool(items, opts, query) {
  const key = JSON.stringify([
    query || '',
    opts.showExplicitContent === true,
    String(opts.country || '').toUpperCase(),
    String(opts.language || '').toLowerCase(),
    String(opts.tag || '').toLowerCase(),
  ]);
  if (items === cachedItems && filteredPoolCache.has(key)) {
    const cached = filteredPoolCache.get(key);
    filteredPoolCache.delete(key);
    filteredPoolCache.set(key, cached);
    return cached;
  }
  let pool = items;
  if (opts.showExplicitContent !== true) {
    pool = pool.filter((item) => item.content_rating !== 'explicit');
  }
  if (query) {
    const q = query.toLowerCase();
    pool = pool.filter((it) =>
      (it.title && it.title.toLowerCase().includes(q)) ||
      (it.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }
  if (opts.country) pool = pool.filter((it) => it.country === opts.country.toUpperCase());
  if (opts.language) pool = pool.filter((it) => it.language === opts.language.toLowerCase());
  if (opts.tag) {
    const t = String(opts.tag).toLowerCase();
    pool = pool.filter((it) => (it.tags || []).some((x) => x.includes(t)));
  }
  if (items === cachedItems) {
    filteredPoolCache.set(key, pool);
    while (filteredPoolCache.size > FILTER_POOL_CACHE_MAX) {
      filteredPoolCache.delete(filteredPoolCache.keys().next().value);
    }
  }
  return pool;
}

function filterAndPaginate(items, opts, query) {
  const pool = filteredPool(items, opts, query);
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.min(opts.limit || 30, 240);
  return pool.slice(offset, offset + limit);
}

export async function search(query, opts = {}) {
  const items = await ensureLoaded(opts);
  return filterAndPaginate(items, opts, query || '');
}

export async function browse(opts = {}) {
  const items = await ensureLoaded(opts);
  return filterAndPaginate(items, opts, '');
}

export async function browsePage(opts = {}) {
  const items = await ensureLoaded(opts);
  const offset = Number(opts.cursor?.offset ?? opts.offset ?? 0);
  const limit = Math.min(opts.limit || 30, 240);
  const pool = filteredPool(items, opts, '');
  const pageItems = pool.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    cursor: { offset: nextOffset },
    exhausted: nextOffset >= pool.length || pageItems.length < limit,
  };
}

export async function random(opts = {}) {
  const items = await ensureLoaded(opts);
  // Picked from the whole filtered pool, not only its first page.
  const pool = [...filteredPool(items, opts, '')];
  const count = Math.min(opts.limit || 20, 60, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
