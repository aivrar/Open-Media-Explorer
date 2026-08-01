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

let cachedItemsPromise = null;
let cachedItems = null;
let cachedItemsById = new Map();
const FILTER_POOL_CACHE_MAX = 16;
const filteredPoolCache = new Map();
const MAX_STREAM_CANDIDATES = 8;

function normalizeStreamCandidate(stream) {
  const url = safeExternalUrl(stream?.url);
  if (!url) return null;
  const detected = detectStreamKind(url, 'video');
  return {
    url,
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
  return [...unique.values()]
    .sort((a, b) => candidateScore(b) - candidateScore(a) || a.index - b.index)
    .slice(0, MAX_STREAM_CANDIDATES)
    .map(({ index: _index, ...candidate }) => candidate);
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

async function ensureLoaded(opts = {}) {
  if (cachedItems) return cachedItems;
  if (!cachedItemsPromise) {
    const request = (async () => {
    // logos.json lives separately from channels.json — channels.json carries no
    // logo field. We join by channel id and prefer in-use, language-neutral logos.
    const [streams, channels, logos] = await Promise.all([
      getJson(`${API}/streams.json`),
      getJson(`${API}/channels.json`),
      getJson(`${API}/logos.json`).catch(() => []),
    ]);
    if (!Array.isArray(streams) || !Array.isArray(channels)) {
      throw new TypeError('iptv-org returned invalid streams or channels data');
    }
    const channelMap = new Map();
    for (const c of channels) channelMap.set(c.id, c);

    const logoMap = new Map();
    if (Array.isArray(logos)) {
      // Prefer in_use === true, square or near-square images, no tags (default variant).
      for (const lg of logos) {
        if (!lg?.channel || !lg?.url) continue;
        const existing = logoMap.get(lg.channel);
        const isPref = lg.in_use !== false && (!lg.tags || lg.tags.length === 0);
        if (!existing) { logoMap.set(lg.channel, { url: lg.url, pref: isPref }); continue; }
        if (!existing.pref && isPref) logoMap.set(lg.channel, { url: lg.url, pref: isPref });
      }
    }

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
      const candidates = selectCandidates(group.candidates);
      const primary = candidates[0];
      if (!primary) continue;
      const isNsfw = ch?.is_nsfw === true;
      const logo = s.channel ? (logoMap.get(s.channel)?.url || '') : '';
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
        language: (ch?.languages?.[0] || '').toLowerCase(),
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
    items.sort(compareItems);
    cachedItems = items;
    cachedItemsById = new Map(items.map((item) => [item.id, item]));
    filteredPoolCache.clear();
    return items;
    })();
    cachedItemsPromise = request;
    request.catch(() => {
      // A failed preload must not poison the adapter for the rest of the app
      // session. The next caller gets a clean retry.
      if (cachedItemsPromise === request) cachedItemsPromise = null;
    });
  }
  return awaitWithSignal(cachedItemsPromise, opts.signal);
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
  const filtered = filterAndPaginate(items, { ...opts, limit: items.length, offset: 0 }, '');
  const pool = [...filtered];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(opts.limit || 20, 60));
}
