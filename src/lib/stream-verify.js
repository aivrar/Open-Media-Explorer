/**
 * "Pick the best stream: Auto (verified)": the checks another Radio Browser
 * entry of a station must pass before the app plays it instead of the
 * station's own stream, and what the app remembers about them. The rule is
 * to switch only on positive evidence: any check that cannot be made counts
 * as failed.
 *
 * Source checks (directory data only, sourceVeto):
 *  - the entry is one of trustedOtherStreams (radio-browser.js): same name,
 *    same homepage host, the same country code (both must give one), a
 *    stream on the same site as the station's own stream (other-streams.js
 *    sameStreamSite). The site rule is only one layer; what proves the
 *    programme is the content check below;
 *  - a plain audio stream (not HLS), https whenever the own stream is https;
 *  - the directory's last check of it passed and found no TLS error;
 *  - established: unchanged in the directory for ESTABLISHED_MIN_DAYS, and
 *    at least ESTABLISHED_MIN_VOTES votes or ESTABLISHED_MIN_CLICKS plays;
 *  - better than the own stream on what the directory says (best-stream.js).
 * Stream checks (a short probe of both streams by the app's local server,
 * streamVeto), each needing positive facts from BOTH streams:
 *  - both sent audio (an audio content type, at least MIN_PROBE_AUDIO_BYTES);
 *  - neither ended on plain http after starting on https (redirects), and
 *    the entry still ends on the same site as the own stream;
 *  - both state their format and bitrate (Content-Type, icy-br); the
 *    entry's are what the directory lists, and it is really better by the
 *    ranking;
 *  - both announce the same station name (icy-name; sameStationName: the
 *    same, or the same before a separator with the same trailing tag), and
 *    the same icy-url host when both give one;
 *  - both play the same SONG (songKey): a title of the form
 *    "Artist - Title", each part with at least MIN_SONG_PART_LETTERS
 *    letters, that is not the station's name nor an advert or ident word
 *    (NOT_SONG_WORDS). A station that sends no such titles cannot be
 *    verified.
 * Two matches are needed: the first is kept as pending; only a second one,
 * on a DIFFERENT song at least MIN_MATCH_GAP_MS later, verifies the entry.
 * At most MAX_PROBES_PER_WEEK probes run per station a week.
 *
 * Results are kept per station (STREAM_VERIFY_KEY, a cache: Clear cache
 * removes it): a verified entry for VERIFIED_MAX_AGE_MS, a pending match for
 * the same time, a failed check for FAILED_RETRY_MS. Stations the user chose
 * to keep on their own stream (OWN_STREAM_KEY) are part of the profile and
 * its backup, and survive Clear cache.
 */

import { compareStreams } from './best-stream.js';
import { homepageHost, sameStreamSite } from './other-streams.js';
import { scheduleProfileHandoff } from './profile-transfer.js';

export const STREAM_VERIFY_KEY = 'worldmedia.streamverify.v1';
export const OWN_STREAM_KEY = 'worldmedia.ownstream.v1';
export const VERIFIED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
// The directory did not answer the lookup (too slow, down, cancelled): the
// check is tried again after this, not after a day.
export const LOOKUP_FAILED_VERIFY_RETRY_MS = 30 * 60 * 1000;
export const MAX_VERIFIED_STATIONS = 200;
export const MAX_OWN_STREAM_STATIONS = 1000;
export const ESTABLISHED_MIN_DAYS = 30;
export const ESTABLISHED_MIN_VOTES = 3;
export const ESTABLISHED_MIN_CLICKS = 20;
export const MIN_PROBE_AUDIO_BYTES = 8 * 1024;
export const MIN_MATCH_GAP_MS = 4 * 60 * 1000;
export const MAX_PROBES_PER_WEEK = 2;
export const MIN_SONG_PART_LETTERS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Titles that are not a song, compared after plain() (lower case, no
 *  punctuation). A title that is one of these, or whose artist or title part
 *  is one of these, is no evidence. */
export const NOT_SONG_WORDS = Object.freeze([
  'advert', 'advertisement', 'adverts', 'ad break', 'commercial', 'commercials', 'werbung', 'publicidad',
  'publicite', 'pub', 'jingle', 'station id', 'ident', 'news', 'live', 'unknown', 'untitled', 'various',
  'various artists', 'on air', 'now playing', 'stream', 'radio', 'music', 'traffic', 'weather', 'sponsor',
]);

export const VERIFY_REASONS = Object.freeze({
  noCandidate: 'No other entry of this station passed the directory checks.',
  noTitles: 'Could not be verified: the station does not announce song titles.',
  differentTitle: 'Could not be verified: the two streams played different songs.',
  differentName: 'Could not be verified: the two streams give different station names.',
  notAudio: 'Could not be verified: a stream did not send audio.',
  notAsListed: 'Could not be verified: the stream is not what the directory lists.',
  unknownFormat: 'Could not be verified: a stream did not say its format and bitrate.',
  leftHttps: 'Could not be verified: a stream left https or the station\'s site.',
  notBetter: 'The other stream is not really better.',
  failed: 'Could not be verified: the check did not finish.',
  lookupFailed: 'Could not be verified: the station directory did not answer in time. It is tried again later.',
});

/* ---------------- Source checks ---------------- */

const isHttps = (url) => /^https:/i.test(String(url || '').trim());

/** null when `alt` (stream facts from the directory: url, kind, bitrate,
 *  codec, lastCheckOk, sslError, votes, clicks, changedAt) may be checked
 *  further against `own` (the station's own stream: url, bitrate, codec),
 *  else the name of the check that failed. */
export function sourceVeto(own, alt, now = Date.now()) {
  if (!alt || typeof alt.url !== 'string' || !alt.url) return 'missing';
  if (alt.kind !== 'audio' || own?.kind === 'hls') return 'kind';
  if (isHttps(own?.url) && !isHttps(alt.url)) return 'downgrade';
  if (alt.lastCheckOk !== true) return 'health';
  if (alt.sslError !== false) return 'tls';
  const changed = Number(alt.changedAt);
  if (!Number.isFinite(changed) || changed <= 0 || now - changed < ESTABLISHED_MIN_DAYS * DAY_MS) return 'new';
  if (!(Number(alt.votes) >= ESTABLISHED_MIN_VOTES || Number(alt.clicks) >= ESTABLISHED_MIN_CLICKS)) return 'unknown';
  if (!(compareStreams(alt, own) < 0)) return 'not-better';
  return null;
}

/* ---------------- Stream checks ---------------- */

const CODEC_TYPES = Object.freeze({
  MP3: ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg'],
  AAC: ['audio/aac', 'audio/aacp', 'audio/x-aac', 'audio/mp4'],
  'AAC+': ['audio/aac', 'audio/aacp', 'audio/x-aac', 'audio/mp4'],
  OGG: ['audio/ogg', 'application/ogg'],
  OPUS: ['audio/ogg', 'audio/opus', 'application/ogg'],
  FLAC: ['audio/flac', 'audio/x-flac', 'audio/ogg'],
});

function contentType(facts) {
  return String(facts?.content_type || '').split(';')[0].trim().toLowerCase();
}

/** The format a content type stands for ('MP3', 'AAC', ...), or ''. */
function codecOfType(type) {
  if (['audio/mpeg', 'audio/mp3', 'audio/x-mpeg'].includes(type)) return 'MP3';
  if (['audio/aac', 'audio/aacp', 'audio/x-aac', 'audio/mp4'].includes(type)) return 'AAC';
  if (['audio/flac', 'audio/x-flac'].includes(type)) return 'FLAC';
  if (['audio/ogg', 'application/ogg', 'audio/opus'].includes(type)) return 'OGG';
  return '';
}

function sentAudio(facts) {
  const type = contentType(facts);
  return facts?.ok === true && Number(facts.audio_bytes) >= MIN_PROBE_AUDIO_BYTES
    && (type.startsWith('audio/') || type === 'application/ogg');
}

function plain(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Station names compared without case, spacing or punctuation. */
export function sameText(a, b) {
  const left = plain(a);
  return left !== '' && left === plain(b);
}

const letters = (text) => (text.match(/\p{L}/gu) || []).length;

/** The fewest characters (letters and digits) the part of a name before a
 *  separator needs to count as the station's name. */
export const NAME_HEAD_MIN_CHARS = 4;
// A trailing tag in brackets ("Drone Zone [SomaFM]").
const NAME_TAG = /\s*\[([^\]]*)\]\s*$/u;
// The first separator: what follows is a description, not the name.
const NAME_SEPARATOR = /:|\s-\s|\s\|\s|\(/u;

/** `name` as { head, tag }: the part before the first separator (":",
 *  " - ", " | ", "("), without a trailing [tag], and that tag ('' if none),
 *  both in plain form. */
function nameParts(name) {
  let text = String(name ?? '').normalize('NFKC');
  let tag = '';
  const tagged = text.match(NAME_TAG);
  if (tagged) {
    tag = plain(tagged[1]);
    text = text.slice(0, tagged.index);
  }
  const cut = text.search(NAME_SEPARATOR);
  return { head: plain(cut >= 0 ? text.slice(0, cut) : text), tag, tagged: Boolean(tagged) };
}

/** Two announced station names that name the same station: equal (sameText),
 *  or equal before the first separator, with at least NAME_HEAD_MIN_CHARS
 *  letters or digits there, and the same trailing [tag] when both have one.
 *  ("Drone Zone [SomaFM]" and "Drone Zone: Atmospheric ambient space
 *  music... [SomaFM]" are; "Groove Salad [SomaFM]" and "Drone Zone [SomaFM]"
 *  are not.) */
export function sameStationName(a, b) {
  if (sameText(a, b)) return true;
  const left = nameParts(a);
  const right = nameParts(b);
  if (!left.head || left.head !== right.head) return false;
  if (left.head.replace(/\s+/g, '').length < NAME_HEAD_MIN_CHARS) return false;
  return !(left.tagged && right.tagged) || left.tag === right.tag;
}

/** The song a title names, as a key to compare ("artist title" in plain
 *  form), or '' when the title is no evidence of a song: not of the form
 *  "Artist - Title", a part with fewer than MIN_SONG_PART_LETTERS letters,
 *  an advert or ident word, or one of `names` (the station's names). */
export function songKey(title, names = []) {
  const text = String(title ?? '').normalize('NFKC').trim();
  const parts = text.split(/\s+[-\u2013\u2014]\s+/);
  if (parts.length < 2) return '';
  const artist = plain(parts[0]);
  const song = plain(parts.slice(1).join(' '));
  if (letters(artist) < MIN_SONG_PART_LETTERS || letters(song) < MIN_SONG_PART_LETTERS) return '';
  const whole = plain(text);
  const banned = new Set([...NOT_SONG_WORDS, ...names.map(plain).filter(Boolean)]);
  if (banned.has(whole) || banned.has(artist) || banned.has(song)) return '';
  return `${artist} ${song}`;
}

function finalSiteOk(startUrl, facts, siteUrl) {
  const scheme = String(facts?.final_scheme || '').toLowerCase();
  const host = String(facts?.final_host || '').toLowerCase();
  if (!['http', 'https'].includes(scheme) || !host) return false;
  if (isHttps(startUrl) && scheme !== 'https') return false;
  return siteUrl ? sameStreamSite(`${scheme}://${host}/`, siteUrl) : true;
}

/** The plain-form song both streams play (`{ song }`), or the
 *  VERIFY_REASONS key of the check that failed (`{ reason }`). `ownFacts`,
 *  `altFacts` come from the local server's probe: ok, content_type,
 *  bitrate, name, url, title, audio_bytes, final_scheme, final_host. */
export function streamCheck(own, alt, ownFacts, altFacts) {
  if (!sentAudio(ownFacts) || !sentAudio(altFacts)) return { reason: 'notAudio' };
  if (!finalSiteOk(own?.url, ownFacts, '') || !finalSiteOk(alt?.url, altFacts, own?.url)) return { reason: 'leftHttps' };
  const ownCodec = codecOfType(contentType(ownFacts));
  const ownBitrate = Number(ownFacts.bitrate);
  const altBitrate = Number(altFacts.bitrate);
  if (!ownCodec || !(ownBitrate > 0) || !codecOfType(contentType(altFacts)) || !(altBitrate > 0)) {
    return { reason: 'unknownFormat' };
  }
  const listed = CODEC_TYPES[String(alt?.codec || '').toUpperCase()];
  if (!listed || !listed.includes(contentType(altFacts))) return { reason: 'notAsListed' };
  if (Math.abs(altBitrate - Number(alt.bitrate)) > 1) return { reason: 'notAsListed' };
  if (!(compareStreams({ bitrate: altBitrate, codec: alt.codec }, { bitrate: ownBitrate, codec: ownCodec }) < 0)) {
    return { reason: 'notBetter' };
  }
  if (!sameStationName(ownFacts.name, altFacts.name)) return { reason: 'differentName' };
  const ownUrl = homepageHost(ownFacts.url);
  const altUrl = homepageHost(altFacts.url);
  if (ownUrl && altUrl && ownUrl !== altUrl) return { reason: 'differentName' };
  const names = [ownFacts.name, altFacts.name, own?.title].filter(Boolean);
  const ownSong = songKey(ownFacts.title, names);
  const altSong = songKey(altFacts.title, names);
  if (!ownSong || !altSong) return { reason: 'noTitles' };
  if (ownSong !== altSong) return { reason: 'differentTitle' };
  return { song: ownSong };
}

/** null when the probe shows the same station playing the same song on a
 *  really better stream, else the VERIFY_REASONS key of the check that
 *  failed (streamCheck). */
export function streamVeto(own, alt, ownFacts, altFacts) {
  return streamCheck(own, alt, ownFacts, altFacts).reason || null;
}

/* ---------------- What is remembered ---------------- */

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function readDoc(key, field) {
  try {
    const parsed = JSON.parse(storage()?.getItem(key) || 'null');
    if (parsed?.version === 1 && parsed[field] && typeof parsed[field] === 'object') return parsed[field];
  } catch (_) { /* unreadable: nothing remembered */ }
  return field === 'ids' ? [] : {};
}

function writeDoc(key, field, value) {
  try {
    storage()?.setItem(key, JSON.stringify({ version: 1, [field]: value }));
    return true;
  } catch (_) {
    return false;
  }
}

function cleanAlt(alt) {
  if (!alt || typeof alt.url !== 'string' || !alt.url) return null;
  const out = { url: alt.url.slice(0, 2048), kind: 'audio', headers: {} };
  if (Number(alt.bitrate) > 0) out.bitrate = Math.round(Number(alt.bitrate));
  if (typeof alt.codec === 'string' && alt.codec) out.codec = alt.codec.slice(0, 12);
  // Played through the relay with https required after redirects.
  if (isHttps(out.url)) out.requireHttps = true;
  return out;
}

function recentProbes(entry, now) {
  return (Array.isArray(entry?.probes) ? entry.probes : [])
    .map(Number).filter((at) => Number.isFinite(at) && at <= now && now - at < WEEK_MS);
}

/** What was found for station `stationId` that still counts at `now`:
 *  { ok: true, alt } (verified within a week), { ok: false, pending: true,
 *  alt, song, at } (one match so far), { ok: false, reason } (failed within
 *  a day), or null (check it). */
export function storedVerification(stationId, now = Date.now()) {
  const entry = stationId ? readDoc(STREAM_VERIFY_KEY, 'stations')[stationId] : null;
  const at = Number(entry?.at);
  if (!entry || !Number.isFinite(at) || now < at) return null;
  if (entry.ok === true && now - at < VERIFIED_MAX_AGE_MS) {
    const alt = cleanAlt(entry.alt);
    return alt ? { ok: true, alt } : null;
  }
  if (entry.pending === true && now - at < VERIFIED_MAX_AGE_MS) {
    const alt = cleanAlt(entry.alt);
    return alt && typeof entry.song === 'string' && entry.song
      ? { ok: false, pending: true, alt, song: entry.song, at } : null;
  }
  const retryMs = entry.reason === 'lookupFailed' ? LOOKUP_FAILED_VERIFY_RETRY_MS : FAILED_RETRY_MS;
  if (entry.ok === false && entry.pending !== true && now - at < retryMs) {
    return { ok: false, reason: VERIFY_REASONS[entry.reason] ? entry.reason : 'failed' };
  }
  return null;
}

/** Probes run for this station in the week before `now`. */
export function probesThisWeek(stationId, now = Date.now()) {
  return stationId ? recentProbes(readDoc(STREAM_VERIFY_KEY, 'stations')[stationId], now).length : 0;
}

function writeEntry(stationId, entry, now) {
  const all = readDoc(STREAM_VERIFY_KEY, 'stations');
  const probes = recentProbes(all[stationId], now);
  delete all[stationId];
  all[stationId] = { ...entry, probes: [...probes, ...(entry.probes || [])].slice(-MAX_PROBES_PER_WEEK) };
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_VERIFIED_STATIONS))) delete all[id];
  return writeDoc(STREAM_VERIFY_KEY, 'stations', all);
}

/** A probe of this station is starting now (counted against the weekly limit). */
export function noteProbe(stationId, now = Date.now()) {
  if (!stationId) return false;
  const all = readDoc(STREAM_VERIFY_KEY, 'stations');
  // No result yet: an entry that only counts probes (storedVerification: null).
  const entry = all[stationId] || { at: now, waiting: true };
  return writeEntry(stationId, { ...entry, probes: [now] }, now);
}

/** Remember a verified entry (`alt`), a first match (`pending` with `alt`
 *  and `song`) or a failed check (`reason`). */
export function storeVerification(stationId, {
  alt = null, reason = 'failed', pending = false, song = '',
} = {}, now = Date.now()) {
  if (!stationId) return false;
  const clean = cleanAlt(alt);
  let entry;
  if (clean && pending && song) entry = { at: now, ok: false, pending: true, alt: clean, song: String(song).slice(0, 400) };
  else if (clean && !pending) entry = { at: now, ok: true, alt: clean };
  else entry = { at: now, ok: false, reason };
  return writeEntry(stationId, entry, now);
}

/** A verified stream that did not play: it is not tried or checked again
 *  for FAILED_RETRY_MS (as after a failed check). */
export function failVerification(stationId, now = Date.now()) {
  return storeVerification(stationId, { reason: 'failed' }, now);
}

/** Forget what was found for a station. */
export function forgetVerification(stationId) {
  const all = readDoc(STREAM_VERIFY_KEY, 'stations');
  if (!stationId || !(stationId in all)) return false;
  delete all[stationId];
  return writeDoc(STREAM_VERIFY_KEY, 'stations', all);
}

export function clearStreamVerifications() {
  try { storage()?.removeItem(STREAM_VERIFY_KEY); } catch (_) {}
}

/** True when the user chose to keep this station on its own stream. */
export function keepsOwnStream(stationId) {
  const ids = readDoc(OWN_STREAM_KEY, 'ids');
  return Boolean(stationId) && Array.isArray(ids) && ids.includes(stationId);
}

/** "Use the station's own stream": remembered for good (part of the
 *  profile: the handoff to the data folder is scheduled, as for every
 *  profile key, so it survives a restart and a profile transfer). */
export function keepOwnStream(stationId, { handoff = scheduleProfileHandoff } = {}) {
  if (!stationId) return false;
  forgetVerification(stationId);
  const ids = readDoc(OWN_STREAM_KEY, 'ids').filter((id) => typeof id === 'string' && id !== stationId);
  ids.push(stationId);
  const written = writeDoc(OWN_STREAM_KEY, 'ids', ids.slice(-MAX_OWN_STREAM_STATIONS));
  if (written) {
    try { handoff(); } catch (_) { /* the next handoff carries it */ }
  }
  return written;
}

/** A short label for a verified stream, e.g. "Better stream: 320 kbps MP3, verified". */
export function verifiedLabel(alt) {
  const parts = [Number(alt?.bitrate) > 0 ? `${Math.round(alt.bitrate)} kbps` : '', alt?.codec || ''].filter(Boolean);
  return `Better stream: ${parts.join(' ')}${parts.length ? ', ' : ''}verified`;
}
