/**
 * Wikimedia Commons adapter.
 * API: https://commons.wikimedia.org/w/api.php
 */

import { getJson } from '../lib/http.js';
import { makeItem, prefixId, detectStreamKind } from '../lib/item-model.js';

export const id = 'wikimedia';
export const displayName = 'Wikimedia Commons';
export const itemTypes = ['video', 'audio'];

const BASE = 'https://commons.wikimedia.org/w/api.php';
const PLAYABLE_EXTS = ['webm', 'ogg', 'ogv', 'oga', 'mp4', 'mp3', 'wav'];

function pickItem(pageId, page) {
  const info = (page?.imageinfo || [])[0];
  if (!info || !info.url) return null;
  // Strip query string + fragment before reading the extension. Wikimedia
  // sometimes appends UTM params (`...webm?utm_source=...`) which would
  // otherwise leave us reading `org` as the extension.
  const cleanUrl = info.url.split('?')[0].split('#')[0];
  const ext = (cleanUrl.split('.').pop() || '').toLowerCase();
  if (!PLAYABLE_EXTS.includes(ext)) return null;
  const mime = info.mime || '';
  const isVideo = mime.startsWith('video/') || ['mp4', 'webm', 'ogv'].includes(ext);
  const isAudio = mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga'].includes(ext);
  if (!isVideo && !isAudio) return null;

  const ext2 = info.extmetadata || {};
  const title = (page.title || '').replace(/^File:/, '').replace(/_/g, ' ');
  const description = stripHtml(ext2.ImageDescription?.value || '');
  const license = ext2.LicenseShortName?.value || ext2.UsageTerms?.value || '';
  const date = ext2.DateTimeOriginal?.value || ext2.DateTime?.value || '';
  let year = null;
  const m = (date.match(/(\d{4})/) || [])[1];
  if (m) year = parseInt(m, 10);
  const langs = []; // not generally available; leave empty
  const tags = [];

  return makeItem({
    id: prefixId(id, pageId),
    title,
    description,
    source: id,
    type: isVideo ? 'video' : 'audio',
    stream_url: info.url,
    stream_kind: detectStreamKind(info.url, isVideo ? 'video' : 'audio'),
    delivery: 'on-demand',
    download_url: info.url,
    download_name: title,
    capture_headers: {},
    thumbnail: info.thumburl || '',
    year,
    country: '',
    language: '',
    tags,
    license: license || 'See source',
    source_url: page.canonicalurl || `https://commons.wikimedia.org/?curid=${pageId}`,
  });
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function _searchOneType(query, filetype, limit, offset, opts = {}) {
  // CirrusSearch (Wikimedia's search backend) doesn't support boolean OR
  // between filter keywords — `(filetype:video OR filetype:audio) X` is
  // parsed as a literal phrase, not as a compound filter, and returns
  // zero pages. So we hit the API once per filetype and merge.
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:${filetype} ${query}`,
    gsrlimit: String(limit),
    gsroffset: String(offset),
    gsrnamespace: '6',                  // File: namespace only
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|canonicaltitle',
    iiurlwidth: '480',
    format: 'json',
    origin: '*',
  });
  const url = `${BASE}?${params.toString()}`;
  const data = await getJson(url, {
    headers: { 'User-Agent': 'WorldMedia/1.0 (contact: project on GitHub)' },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (!data || typeof data !== 'object' || data.error) {
    throw new TypeError(`Wikimedia returned an invalid response${data?.error?.info ? `: ${data.error.info}` : ''}`);
  }
  return {
    pages: data?.query?.pages || {},
    nextOffset: Number.isFinite(Number(data?.continue?.gsroffset))
      ? Number(data.continue.gsroffset)
      : null,
  };
}

function itemsFromPages(pageSets) {
  const pages = {};
  for (const set of pageSets) Object.assign(pages, set || {});

  const out = [];
  for (const [pageId, page] of Object.entries(pages)) {
    const it = pickItem(pageId, page);
    if (it) out.push(it);
  }
  out.sort((a, b) => {
    const ai = pages[a.id.split(':').pop()]?.index ?? 0;
    const bi = pages[b.id.split(':').pop()]?.index ?? 0;
    return ai - bi;
  });
  return out;
}

export async function search(query, opts = {}) {
  const limit = Math.min(opts.limit || 20, 50);
  const offset = opts.offset || 0;
  const q = (query || '').trim() || 'documentary';
  const want = opts.filetype || 'both';

  // Fire video + audio searches in parallel — they hit the same API but
  // the user shouldn't wait 2× longer for both to return serially.
  const tasks = [];
  if (want === 'video' || want === 'both') tasks.push(_searchOneType(q, 'video', limit, offset, opts));
  if (want === 'audio' || want === 'both') tasks.push(_searchOneType(q, 'audio', limit, offset, opts));
  const responses = await Promise.all(tasks);
  return itemsFromPages(responses.map((r) => r.pages));
}

export async function browse(opts = {}) {
  // Curated seed list — Wikimedia search's results vary wildly by query.
  // Pre-tested to return ≥1 result for both video and audio filetypes.
  const seeds = [
    'nature', 'space', 'history', 'wildlife',
    'music', 'speech', 'lecture', 'animation',
    'orchestra', 'concert', 'documentary',
  ];
  // Try a few seeds; bail out as soon as one returns items. Avoids the
  // case where a single random pick happens to come back empty.
  const offset = opts.offset || 0;
  const tried = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    let seed;
    do { seed = seeds[Math.floor(Math.random() * seeds.length)]; } while (tried.has(seed));
    tried.add(seed);
    const items = await search(seed, opts);
    if (items.length > 0) return items;
    // If we got nothing AND this is a pagination request (offset>0), don't
    // try other seeds — the user is paging into a specific search.
    if (offset > 0) return items;
  }
  return [];
}

export async function browsePage(opts = {}) {
  const seeds = [
    'nature', 'space', 'history', 'wildlife',
    'music', 'speech', 'lecture', 'animation',
    'orchestra', 'concert', 'documentary',
  ];
  const cursor = opts.cursor || {};
  const seed = cursor.seed || opts.seed || seeds[Math.floor(Math.random() * seeds.length)];
  const limit = Math.min(opts.limit || 20, 50);
  const videoDone = cursor.videoDone === true;
  const audioDone = cursor.audioDone === true;
  const videoOffset = Number(cursor.videoOffset || 0);
  const audioOffset = Number(cursor.audioOffset || 0);

  const requests = [];
  if (!videoDone) requests.push({
    type: 'video',
    promise: _searchOneType(seed, 'video', limit, videoOffset, opts),
  });
  if (!audioDone) requests.push({
    type: 'audio',
    promise: _searchOneType(seed, 'audio', limit, audioOffset, opts),
  });

  const responses = await Promise.all(requests.map(async (request) => ({
    type: request.type,
    result: await request.promise,
  })));
  const next = {
    seed,
    videoOffset,
    audioOffset,
    videoDone,
    audioDone,
  };
  for (const { type, result } of responses) {
    next[`${type}Done`] = result.nextOffset == null;
    if (result.nextOffset != null) next[`${type}Offset`] = result.nextOffset;
  }

  return {
    items: itemsFromPages(responses.map(({ result }) => result.pages)),
    cursor: next,
    exhausted: next.videoDone && next.audioDone,
  };
}

export async function random(opts = {}) {
  return browse({ ...opts, limit: opts.limit || 12 });
}
