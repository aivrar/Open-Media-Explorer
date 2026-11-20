/**
 * What the last lookup of other directory entries of a radio station found
 * ("Also look for a better stream of the same radio station"), kept apart
 * from the favourites so that a favourite's saved record never changes
 * through playback. A found list is used for a day; a failed lookup (the
 * directory down or too slow) is not tried again for 30 minutes, so a
 * directory outage does not delay every start.
 *
 * Stored under STREAM_LOOKUPS_KEY: { version: 1, stations: { stationId:
 * { at, ok, streams: [{ url, kind, bitrate, codec }] } } }, at most
 * MAX_STREAM_LOOKUPS stations (the oldest go first). It is a cache: not
 * part of the profile backup, and Clear cache removes it.
 */

export const STREAM_LOOKUPS_KEY = 'worldmedia.streamlookups.v1';
export const MAX_STREAM_LOOKUPS = 200;
export const MAX_LOOKUP_STREAMS = 7;
export const LOOKUP_FOUND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LOOKUP_FAILED_RETRY_MS = 30 * 60 * 1000;

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function cleanStream(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || !value.url) return null;
  const stream = { url: value.url.slice(0, 2048), kind: typeof value.kind === 'string' ? value.kind.slice(0, 8) : '' };
  const bitrate = Number(value.bitrate);
  if (Number.isFinite(bitrate) && bitrate > 0) stream.bitrate = Math.round(bitrate);
  if (typeof value.codec === 'string' && value.codec) stream.codec = value.codec.slice(0, 12);
  // The directory's record of the entry, for Auto's checks (stream-verify.js).
  stream.lastCheckOk = value.lastCheckOk === true;
  stream.sslError = value.sslError !== false;
  for (const field of ['votes', 'clicks', 'changedAt']) {
    const number = Number(value[field]);
    stream[field] = Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }
  return stream;
}

function readAll() {
  try {
    const parsed = JSON.parse(storage()?.getItem(STREAM_LOOKUPS_KEY) || 'null');
    if (parsed?.version !== 1 || !parsed.stations || typeof parsed.stations !== 'object') return {};
    return parsed.stations;
  } catch (_) {
    return {};
  }
}

/** The stored lookup of station `stationId` that still counts at time
 *  `now`: { ok: true, streams } (found within a day), { ok: false } (failed
 *  within 30 minutes), or null (look it up). */
export function storedLookup(stationId, now = Date.now()) {
  const entry = stationId ? readAll()[stationId] : null;
  const at = Number(entry?.at);
  if (!entry || !Number.isFinite(at) || now < at) return null;
  if (entry.ok === true && now - at < LOOKUP_FOUND_MAX_AGE_MS) {
    const streams = (Array.isArray(entry.streams) ? entry.streams : []).map(cleanStream).filter(Boolean);
    return { ok: true, streams: streams.slice(0, MAX_LOOKUP_STREAMS) };
  }
  if (entry.ok === false && now - at < LOOKUP_FAILED_RETRY_MS) return { ok: false, streams: [] };
  return null;
}

/** Keep the result of a lookup of `stationId` (`streams` when it worked,
 *  null when it failed). Never throws. */
export function storeLookup(stationId, streams, now = Date.now()) {
  if (!stationId) return false;
  const all = readAll();
  delete all[stationId];
  all[stationId] = streams
    ? { at: now, ok: true, streams: streams.map(cleanStream).filter(Boolean).slice(0, MAX_LOOKUP_STREAMS) }
    : { at: now, ok: false };
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_STREAM_LOOKUPS))) delete all[id];
  try {
    storage()?.setItem(STREAM_LOOKUPS_KEY, JSON.stringify({ version: 1, stations: all }));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearStreamLookups() {
  try { storage()?.removeItem(STREAM_LOOKUPS_KEY); } catch (_) {}
}
