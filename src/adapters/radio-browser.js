/**
 * Radio Browser adapter.
 * API docs: https://api.radio-browser.info
 *
 * Resolves a working mirror at first call; falls back to de1.api.radio-browser.info.
 * Sends the User-Agent header per their guidelines.
 */

import { getJson } from '../lib/http.js';
import { makeItem, prefixId, detectStreamKind } from '../lib/item-model.js';
import { cleanBitrate, cleanCodec, isHlsFlag } from '../lib/stream-quality.js';
import {
  canFindOtherStreams, homepageHost, matchOtherStreams, otherStreamsQuery, registrableDomain, sameStreamSite, stationId,
  underOwnName,
} from '../lib/other-streams.js';
import { rankStreams } from '../lib/best-stream.js';
import { MAX_LOOKUP_STREAMS, storedLookup, storeLookup } from '../lib/stream-lookups.js';

export const id = 'radio-browser';
export const displayName = 'Radio Browser';
export const itemTypes = ['radio'];

const FALLBACK = 'https://de1.api.radio-browser.info';
let baseUrlPromise = null;
let cachedBase = null;

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

async function probeBase(base) {
  // Tiny liveness probe — /json/stats is ~150 bytes, returns in <500 ms
  // on a working mirror and times out (or DNS-fails) on a dead one.
  try {
    const r = await getJson(base + '/json/stats', { timeoutMs: 3000 });
    return r && typeof r === 'object' && r.status === 'OK';
  } catch (_e) {
    return false;
  }
}

async function resolveBase() {
  if (cachedBase) return cachedBase;
  if (baseUrlPromise) return baseUrlPromise;
  baseUrlPromise = (async () => {
    try {
      const servers = await getJson('https://all.api.radio-browser.info/json/servers', { timeoutMs: 5000 });
      if (Array.isArray(servers) && servers.length > 0) {
        // The servers list is known to include stale entries (Radio Browser's
        // dynamic DNS isn't always purged when a mirror retires). Walk the
        // list in random order and pick the first one that actually answers.
        const order = [...servers].sort(() => Math.random() - 0.5);
        // Bound startup discovery. A stale mirror list used to make one Radio
        // Browser page spend nearly a minute probing every dead entry.
        for (const pick of order.slice(0, 4)) {
          const host = pick.name || pick.ip;
          if (!host) continue;
          const candidate = `https://${host}`;
          if (await probeBase(candidate)) {
            cachedBase = candidate;
            return cachedBase;
          }
        }
      }
    } catch (_e) { /* fall through */ }
    // Last resort: the fallback is the de1 anchor; if even that is down,
    // every subsequent call will fail with a clear network error rather
    // than us silently returning empty results.
    cachedBase = FALLBACK;
    return cachedBase;
  })();
  return baseUrlPromise;
}

/** Invalidate the cached mirror so the next call re-resolves. Used when
 *  a request through cachedBase fails — the mirror may have gone down
 *  mid-session. */
function invalidateBase() {
  cachedBase = null;
  baseUrlPromise = null;
}

// A request the caller cut short after waiting this long on the mirror: the
// mirror is too slow to keep (the Tuner and the Grid give a source 20 s).
export const SLOW_MIRROR_MS = 10_000;

/** Whether a mirror asked at `askedAt` and still silent at `now` is dropped. */
export function mirrorTooSlow(askedAt, now = Date.now()) {
  return now - askedAt >= SLOW_MIRROR_MS;
}

function normalize(station) {
  if (!station || !station.stationuuid || !station.url_resolved) return null;
  const tags = (station.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  let lang = (station.languagecodes || station.language || '').split(',')[0].trim();
  const hls = isHlsFlag(station.hls);
  return makeItem({
    id: prefixId(id, station.stationuuid),
    title: station.name?.trim() || 'Unnamed Station',
    description: tags.join(', '),
    source: id,
    type: 'radio',
    stream_url: station.url_resolved,
    stream_kind: hls || Number(station.hls) === 1
      ? 'hls'
      : detectStreamKind(station.url_resolved, 'audio'),
    delivery: 'live',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: station.favicon || '',
    year: null,
    country: (station.countrycode || '').toUpperCase(),
    language: lang,
    tags,
    license: 'See source',
    source_url: station.homepage || `https://www.radio-browser.info/`,
    // Directory-reported format and bitrate (kbps, 0 = unknown), shown as a
    // short label; see lib/stream-quality.js.
    _extra: {
      stationuuid: station.stationuuid,
      clickcount: station.clickcount || 0,
      bitrate: cleanBitrate(station.bitrate),
      codec: cleanCodec(station.codec),
      hls,
    },
  });
}

/** Radio Browser marks a station whose last check failed with lastcheckok 0. */
function isBrokenStation(station) {
  const flag = station?.lastcheckok;
  return flag === false || flag === 0 || flag === '0' || flag === 'false';
}

async function fetchStations(path, opts = {}) {
  // Try the cached mirror first, then re-resolve once if that fails.
  // Returns the parsed JSON array and throws if both attempts fail.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await awaitWithSignal(resolveBase(), opts.signal);
    const askedAt = Date.now();
    try {
      const data = await getJson(base + path, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });
      if (Array.isArray(data)) return data;
      throw new TypeError('Radio Browser returned a non-array response');
    } catch (err) {
      lastError = err;
      // Cancelled by the caller (or its time limit): no new mirror search
      // starts now. A mirror cut short early is kept; one that stayed silent
      // for SLOW_MIRROR_MS is dropped, so the next request finds another.
      if (opts.signal?.aborted) {
        if (mirrorTooSlow(askedAt)) invalidateBase();
        throw err;
      }
      if (attempt === 0) {
        // Mirror probably died mid-session — drop it and re-resolve.
        invalidateBase();
        continue;
      }
      console.warn('Radio Browser fetch failed both attempts:', err);
    }
  }
  throw lastError || new Error('Radio Browser fetch failed');
}

async function stationPage(query, opts = {}, offsetOverride = null) {
  const limit = Math.min(opts.limit || 30, 100);
  const offset = offsetOverride ?? opts.offset ?? 0;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  });
  if (query) params.set('name', query);
  if (opts.country) params.set('countrycode', opts.country);
  if (opts.language) params.set('language', opts.language);
  if (opts.tag) params.set('tag', opts.tag);
  const data = await fetchStations(`/json/stations/search?${params.toString()}`, opts);
  return {
    items: data.map(normalize).filter(Boolean),
    rawCount: data.length,
    limit,
    offset,
  };
}

export async function search(query, opts = {}) {
  return (await stationPage(query, opts)).items;
}

export async function browse(opts = {}) {
  // Default browse: top-clicked stations, optionally filtered by country.
  return search('', { ...opts, limit: opts.limit || 30 });
}

export async function browsePage(opts = {}) {
  const offset = Number(opts.cursor?.offset ?? opts.offset ?? 0);
  const page = await stationPage('', opts, offset);
  return {
    items: page.items,
    cursor: { offset: offset + page.rawCount },
    exhausted: page.rawCount < page.limit,
  };
}

export async function random(opts = {}) {
  const limit = Math.min(opts.limit || 20, 50);
  const params = new URLSearchParams({
    limit: String(limit),
    order: 'random',
    hidebroken: 'true',
  });
  if (opts.country) params.set('countrycode', opts.country);
  if (opts.language) params.set('language', opts.language);
  if (opts.tag) params.set('tag', opts.tag);
  const data = await fetchStations(`/json/stations/search?${params.toString()}`, opts);
  return data.map(normalize).filter(Boolean);
}

/**
 * Other Radio Browser entries for the same station, for the user to pick by
 * hand. One name search (the directory's own search endpoint), then the
 * strict rule in lib/other-streams.js. Returns { streams, total, sameNameOnly }.
 */
export async function findOtherStreams(item, opts = {}) {
  item = underOwnName(item); // a renamed favorite is searched by its own name
  if (!canFindOtherStreams(item)) return matchOtherStreams(item, []);
  return matchOtherStreams(item, await searchSameName(item, opts), { limit: opts.limit });
}

/** The directory's entries named like `item` (one search, most played
 *  first), broken ones left out. */
async function searchSameName(item, opts = {}) {
  const params = new URLSearchParams({
    name: otherStreamsQuery(item.title),
    limit: '100',
    offset: '0',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  });
  const data = await fetchStations(`/json/stations/search?${params.toString()}`, opts);
  return data.filter((station) => !isBrokenStation(station)).map((station) => {
    const item = normalize(station);
    if (item) item._extra = { ...item._extra, health: healthOf(station) };
    return item;
  }).filter(Boolean);
}

// The default time limit of betterStationStreams (Auto's background check
// passes its own, best-stream-auto.js CHECK_LOOKUP_MS). It includes finding
// a working directory mirror when none was found yet in this run.
export const BETTER_STREAMS_LOOKUP_MS = 4_000;

function streamFacts(item) {
  const health = item._extra?.health || {};
  return {
    url: item.stream_url,
    kind: item.stream_kind,
    headers: {},
    bitrate: cleanBitrate(item._extra?.bitrate),
    codec: cleanCodec(item._extra?.codec),
    // The directory's own record of the entry (stream-verify.js sourceVeto).
    lastCheckOk: health.lastCheckOk === true,
    sslError: health.sslError !== false,
    votes: health.votes || 0,
    clicks: Number(item._extra?.clickcount) || 0,
    changedAt: health.changedAt || 0,
  };
}

/** What the directory says about an entry's health and age: its last check
 *  passed, a TLS error was found, votes, and when it last changed (ms, 0
 *  when unknown). Only for the entries a name search finds. */
function healthOf(station) {
  const flag = (value) => value === true || value === 1 || value === '1' || value === 'true';
  const changed = Date.parse(String(station?.lastchangetime_iso8601 || ''));
  return {
    lastCheckOk: flag(station?.lastcheckok),
    sslError: station?.ssl_error === undefined ? true : flag(station.ssl_error),
    votes: Math.max(0, Math.floor(Number(station?.votes) || 0)),
    changedAt: Number.isFinite(changed) ? changed : 0,
  };
}

/** Entries of the same station that may be used without asking: the strict
 *  rule of "Other streams" with the same homepage, plus the same country
 *  code (both must give one) and a stream address on the same site as the
 *  station's own stream (other-streams.js sameStreamSite). This is only the
 *  first layer; the content check (stream-verify.js) proves the programme.
 *  Anything else stays in the hand-picked "Other streams" list. */
export function trustedOtherStreams(item, candidates) {
  item = underOwnName(item);
  const host = homepageHost(item?.source_url);
  const ownDomain = registrableDomain(item?.stream_url);
  if (!host || !ownDomain) return [];
  const { streams, sameNameOnly } = matchOtherStreams(item, candidates, { limit: Number.MAX_SAFE_INTEGER });
  if (sameNameOnly) return [];
  const country = String(item.country || '').toUpperCase();
  if (!country) return [];
  return streams.filter((stream) => String(stream.country || '').toUpperCase() === country
    && sameStreamSite(stream.stream_url, item.stream_url));
}

/**
 * Other Radio Browser entries of the same station for the player to rank
 * and try (lib/best-stream.js), best first, at most MAX_LOOKUP_STREAMS;
 * see trustedOtherStreams for which ones. The station's own stream is not
 * in the list (the player always has it). Nothing is written to the item:
 * the result is kept in lib/stream-lookups.js, a found list for a day and a
 * failed lookup for 30 minutes. A slow or failed lookup (now, or within
 * those 30 minutes) throws an error with code LOOKUP_FAILED, so that it is
 * never taken for "no other entry"; a cancelled one throws the abort.
 */
function lookupFailed(cause = null) {
  const error = new Error('The station directory did not answer in time.');
  error.code = 'LOOKUP_FAILED';
  if (cause) error.cause = cause;
  return error;
}

export async function betterStationStreams(item, opts = {}) {
  item = underOwnName(item);
  if (!item?.id || item.source !== id || !canFindOtherStreams(item) || !homepageHost(item.source_url)) return [];
  const station = stationId(item);
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const stored = storedLookup(station, now);
  if (stored?.ok === false) throw lookupFailed();
  if (stored) return stored.streams;
  if (opts.signal?.aborted) throw opts.signal.reason || new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Looking up other streams took too long.')),
    Number(opts.timeoutMs) || BETTER_STREAMS_LOOKUP_MS);
  let candidates;
  try {
    candidates = await (opts.searchImpl || searchSameName)(item, { signal: controller.signal });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    storeLookup(station, null, now);
    throw lookupFailed(error);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  // Ranked before the limit, so lossless entries cannot push out better ones.
  const streams = rankStreams(trustedOtherStreams(item, candidates).map(streamFacts)).slice(0, MAX_LOOKUP_STREAMS);
  storeLookup(station, streams, now);
  return streams;
}

/**
 * Get the URL Radio Browser wants us to POST to when a station plays — so
 * the directory's "click count" ranking stays accurate. Player invokes this.
 */
export async function clickCountUrl(stationuuid) {
  const base = await resolveBase();
  return `${base}/json/url/${encodeURIComponent(stationuuid)}`;
}
