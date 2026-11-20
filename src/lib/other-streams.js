/**
 * "Other streams" for a Radio Browser station: other directory entries that
 * are the same station, so the user can pick one by hand.
 *
 * The rule is strict on purpose. One station name can cover many different
 * channels ("Radio Paradise" has a main mix, a mellow mix, a rock mix, ...)
 * and unrelated stations share names, so this only decides which entries
 * are listed. "Also look for a better stream of the same radio station"
 * (off by default) uses some on its own only under a stricter rule
 * (radio-browser.js trustedOtherStreams).
 *
 *  - Same name after normalising: case, spacing and punctuation are ignored,
 *    and so is a trailing quality hint such as "128k", "(AAC)", "HD", "[MP3]".
 *  - Same homepage host, ignoring a leading "www.". When the station has no
 *    homepage, the name alone decides and the list says these are stations
 *    with the same name, which may be different stations.
 *  - Never the station itself, and never a second copy of a stream URL that
 *    is already listed (or that the station itself uses).
 *
 * Pure functions only; the adapter fetches and the Library panel renders.
 */

export const OTHER_STREAMS_SOURCE = 'radio-browser';
/** At most this many entries are shown. */
export const OTHER_STREAMS_LIMIT = 20;

const ID_PREFIX = `${OTHER_STREAMS_SOURCE}:`;
// The adapter's link when a station gives no homepage of its own.
const DIRECTORY_HOST = 'radio-browser.info';

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const NOT_WORD_OR_SPACE = /[^\p{L}\p{M}\p{N}\s]+/u;

// Format and quality words that only describe the stream, not the station.
const HINT_WORDS = new Set([
  'mp3', 'aac', 'aacp', 'aacplus', 'heaac', 'ogg', 'vorbis', 'opus', 'flac',
  'hls', 'hd', 'hq', 'lq', 'lossless',
]);
const BITRATE_UNITS = new Set(['k', 'kb', 'kbs', 'kbps', 'kbit', 'kbits']);
const BITRATE_TOKEN = /^\d{2,4}(?:k|kb|kbs|kbps|kbit|kbits)$/;
const BARE_NUMBER = /^\d{2,4}$/;
const TRAILING_GROUP = /[([{]([^()[\]{}]*)[)\]}]\s*$/;

function words(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().match(WORD) || [];
}

/** True when every word inside a trailing (...) / [...] group is a quality hint.
 *  Inside brackets a bare number counts too: "[320]", "(AAC 128)". */
function isHintGroup(content) {
  const tokens = words(content);
  if (tokens.length === 0) return false;
  return tokens.every((token, index) => HINT_WORDS.has(token)
    || BITRATE_TOKEN.test(token)
    || BARE_NUMBER.test(token)
    || BITRATE_UNITS.has(token)
    || (token === 'he' && tokens[index + 1] === 'aac'));
}

/** How many leading words of the title name the station, once trailing
 *  quality hints are dropped. Hints are only ever stripped from the end, so
 *  the station's name is always a prefix of the title's words. */
function stationWordCount(title) {
  let text = String(title ?? '').normalize('NFKC').toLowerCase();
  for (;;) {
    const match = text.match(TRAILING_GROUP);
    if (!match || !isHintGroup(match[1])) break;
    const shorter = text.slice(0, match.index);
    if (words(shorter).length === 0) break;
    text = shorter;
  }
  const tokens = words(text);
  let count = tokens.length;
  while (count > 1) {
    const last = tokens[count - 1];
    if (HINT_WORDS.has(last) || BITRATE_TOKEN.test(last)) {
      count -= 1;
      if (last === 'aac' && count > 1 && tokens[count - 1] === 'he') count -= 1;
      continue;
    }
    // "128 kbps": a number only goes together with its unit. A bare number
    // at the end stays, because it is often part of the name ("Hot 97").
    if (BITRATE_UNITS.has(last) && count > 2 && BARE_NUMBER.test(tokens[count - 2])) {
      count -= 2;
      continue;
    }
    break;
  }
  return count;
}

/** Station name for matching: lower case, words joined by single spaces,
 *  punctuation gone, trailing quality hints gone. */
export function normalizeStationName(title) {
  return words(title).slice(0, stationWordCount(title)).join(' ');
}

/** The search text sent to Radio Browser. Its name search matches a part of
 *  the name, so this is the longest stretch of the station's name that has no
 *  punctuation in it: "SomaFM: Indie Pop Rocks (128k)" searches "indie pop
 *  rocks", which also finds "SomaFM - Indie Pop Rocks". */
export function otherStreamsQuery(title) {
  const keep = stationWordCount(title);
  const text = String(title ?? '').normalize('NFKC').toLowerCase();
  let used = 0;
  let best = [];
  for (const run of text.split(NOT_WORD_OR_SPACE)) {
    const runWords = words(run);
    const start = used;
    used += runWords.length;
    const kept = runWords.slice(0, Math.max(0, keep - start));
    if (kept.join(' ').length > best.join(' ').length) best = kept;
  }
  const query = best.join(' ');
  return query.length >= 3 ? query : normalizeStationName(title);
}

/** Homepage host without a leading "www.", or '' when there is none. */
export function homepageHost(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const parsed = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    return host === DIRECTORY_HOST ? '' : host;
  } catch (_) {
    return '';
  }
}

// Two-part public suffixes under a country code ("co.uk", "com.au", ...):
// with one of these second labels the registrable domain has three labels.
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gob', 'gov', 'gv', 'go', 'ltd', 'ne', 'net', 'nic', 'or', 'org', 'plc', 'sch']);

/**
 * The registrable domain of a web address's host, conservatively: the last
 * two labels ("example.com" for "stream.example.com"), or the last three
 * when the top label is a two-letter country code and the second one is a
 * usual second level such as "co" or "com" ("example.co.uk"). An IP address
 * is kept whole, so only the same address matches. '' when there is no host.
 * Being stricter than the public suffix list only means fewer matches.
 */
export function registrableDomain(url) {
  let host = '';
  try {
    host = new URL(String(url ?? '').trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) {
    return '';
  }
  if (!host) return '';
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const take = labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Hosting and dynamic-DNS suffixes shared by many unrelated owners: under
 *  them the registrable domain proves nothing, so the full host must match.
 *  A short built-in list, not the public suffix list. */
export const SHARED_HOST_SUFFIXES = Object.freeze([
  'github.io', 'gitlab.io', 'pages.dev', 'netlify.app', 'vercel.app', 'herokuapp.com', 'web.app',
  'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'blogspot.com',
  'duckdns.org', 'no-ip.org', 'no-ip.com', 'ddns.net', 'dyndns.org', 'hopto.org', 'zapto.org',
  'freeddns.org', 'mooo.com', 'servebeer.com', 'sytes.net', 'myftp.org',
]);

function hostOf(url) {
  try {
    return new URL(String(url ?? '').trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) {
    return '';
  }
}

/** True when two stream addresses are on the same site: the same registrable
 *  domain, or, under a shared hosting suffix, the very same host. This is
 *  only one layer of the "same station" rule; what proves the programme is
 *  the content check (stream-verify.js). */
export function sameStreamSite(a, b) {
  const hostA = hostOf(a);
  const hostB = hostOf(b);
  if (!hostA || !hostB) return false;
  const shared = (host) => SHARED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (shared(hostA) || shared(hostB)) return hostA === hostB;
  const domain = registrableDomain(a);
  return domain !== '' && domain === registrableDomain(b);
}

/** The Radio Browser station id of an item, or '' for anything else. */
export function stationId(item) {
  if (!item || item.source !== OTHER_STREAMS_SOURCE || typeof item.id !== 'string') return '';
  const saved = item._extra?.stationuuid;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return item.id.startsWith(ID_PREFIX) ? item.id.slice(ID_PREFIX.length) : '';
}

/** `item` under the station's own name. A renamed favorite (favorite-names.js
 *  gives a copy whose title is the user's name and whose originalTitle is the
 *  station's) is searched for, matched and checked by its original name; the
 *  user's name is only shown. */
export function underOwnName(item) {
  return item?.__favoriteName === true && typeof item.originalTitle === 'string'
    ? { ...item, title: item.originalTitle } : item;
}

/** Only items with a Radio Browser station id qualify. */
export function canFindOtherStreams(item) {
  return Boolean(stationId(item)) && normalizeStationName(underOwnName(item).title) !== '';
}

/** One key per stream address: scheme, letter case of the host, a default
 *  port and a trailing slash do not make a different stream. */
export function streamKey(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase()}:${parsed.port}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch (_) {
    return value.toLowerCase();
  }
}

function bitrateOf(item) {
  const value = Number(item?._extra?.bitrate);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pick the entries that are the same station as `original`.
 * Candidates are Radio Browser items in the order the directory gave them
 * (most played first). Returns `{ streams, total, sameNameOnly }`: at most
 * `limit` streams, sorted by bitrate (highest first, unknown last, otherwise
 * in directory order), and how many matched in all.
 */
export function matchOtherStreams(original, candidates, { limit = OTHER_STREAMS_LIMIT } = {}) {
  const name = normalizeStationName(underOwnName(original)?.title);
  const host = homepageHost(original?.source_url);
  const ownId = typeof original?.id === 'string' ? original.id : '';
  const ownStation = stationId(original);
  const seen = new Set();
  const ownStream = streamKey(original?.stream_url);
  if (ownStream) seen.add(ownStream);
  const matches = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!name || !candidate || typeof candidate !== 'object') continue;
    const candidateStation = stationId(candidate);
    if (!candidateStation || candidate.id === ownId || candidateStation === ownStation) continue;
    if (candidate._extra?.lastcheckok === false) continue;
    if (normalizeStationName(candidate.title) !== name) continue;
    if (host && homepageHost(candidate.source_url) !== host) continue;
    const key = streamKey(candidate.stream_url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    matches.push(candidate);
  }
  const sorted = matches
    .map((item, index) => ({ item, index, bitrate: bitrateOf(item) }))
    .sort((a, b) => b.bitrate - a.bitrate || a.index - b.index)
    .map(({ item }) => item);
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  return { streams: sorted.slice(0, cap), total: sorted.length, sameNameOnly: !host };
}
