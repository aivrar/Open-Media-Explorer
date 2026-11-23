/**
 * The stream format and bitrate a station said it had the last time it
 * played ("MP3 · 128 kbps" in its card's tooltip, in the details panel, and
 * on the card with "Show technical source details" on).
 *
 * When the relay opens a plain live audio stream it keeps what the station's
 * reply says (Content-Type and icy-br); the now-playing poll that runs anyway
 * while such a station plays brings it to the page (now-playing.js). Once that
 * start has played a second, it is remembered here per item. Nothing is
 * probed or asked for this, and a start that does not play records nothing.
 *
 * Kept in browser storage under PLAYED_STREAMS_KEY as a cache, like the "Did
 * not play last time" marks: at most MAX_PLAYED_STREAMS items (the oldest go
 * first), written only when an item's values change, not in the profile files
 * or backups, and Clear cache removes it.
 */

import { cleanBitrate, cleanCodec, codecFromContentType, formatStreamQuality } from './stream-quality.js';

export const PLAYED_STREAMS_KEY = 'worldmedia.playedstreams.v1';
export const MAX_PLAYED_STREAMS = 1_000;
const MAX_ID_LENGTH = 512;

let entries = null; // id -> { codec, bitrate }, oldest first
const listeners = new Set();

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

/** { codec, bitrate } with clean values, or null when it says nothing. */
function cleanFacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const codec = cleanCodec(value.codec);
  const bitrate = cleanBitrate(value.bitrate);
  return codec || bitrate ? { codec, bitrate } : null;
}

/** { codec, bitrate } from the relay's stream facts ({ content_type,
 *  bitrate }), or null when they say nothing the app knows. */
export function streamFactsFromRelay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return cleanFacts({ codec: codecFromContentType(value.content_type), bitrate: value.bitrate });
}

/** True when two fact sets say the same. */
export function sameStreamFacts(a, b) {
  return Boolean(a && b && a.codec === b.codec && a.bitrate === b.bitrate);
}

function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const parsed = JSON.parse(storage()?.getItem(PLAYED_STREAMS_KEY) || 'null');
    if (parsed?.version === 1 && Array.isArray(parsed.items)) {
      for (const entry of parsed.items.slice(-MAX_PLAYED_STREAMS)) {
        const [id, codec, bitrate] = Array.isArray(entry) ? entry : [];
        const facts = cleanFacts({ codec, bitrate });
        if (validId(id) && facts) {
          entries.delete(id);
          entries.set(id, facts);
        }
      }
    }
  } catch (_) { /* an unreadable cache is an empty one */ }
  return entries;
}

/** Write the cache; false when the storage is missing, full or refuses. */
function save() {
  try {
    const target = storage();
    if (!target) return false;
    const items = [...entries].map(([id, facts]) => [id, facts.codec, facts.bitrate]);
    target.setItem(PLAYED_STREAMS_KEY, JSON.stringify({ version: 1, items }));
    return true;
  } catch (_) {
    return false;
  }
}

function notify(id) {
  for (const listener of [...listeners]) {
    try { listener(id); } catch (error) { console.error('played-streams listener threw:', error); }
  }
}

/** What item `id` said its stream was when it last played, or null. */
export function playedStreamOf(id) {
  if (!validId(id)) return null;
  const facts = load().get(id);
  return facts ? { ...facts } : null;
}

/** Remember what item `id` played with. Written only when it differs from
 *  what is kept; true when it did. A write that fails changes nothing, so
 *  the same values are tried again on a later play. */
export function rememberPlayedStream(id, facts) {
  const clean = cleanFacts(facts);
  if (!validId(id) || !clean) return false;
  const all = load();
  if (sameStreamFacts(all.get(id), clean)) return false;
  const before = new Map(all);
  all.delete(id);
  all.set(id, clean);
  while (all.size > MAX_PLAYED_STREAMS) all.delete(all.keys().next().value);
  if (!save()) {
    entries = before;
    return false;
  }
  notify(id);
  return true;
}

/** Clear cache: every remembered stream goes. */
export function clearPlayedStreams() {
  const had = load().size > 0;
  entries = new Map();
  try { storage()?.removeItem(PLAYED_STREAMS_KEY); } catch (_) { /* nothing stored */ }
  if (had) notify('');
}

/** Called with the item id (or '' for all) whenever a remembered stream changes. */
export function onPlayedStreamChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests: read the stored values again. */
export function forgetLoadedPlayedStreams() {
  entries = null;
}

/**
 * Ties the relay's facts to a start that really played. The player calls
 *   begin()            for every new start: anything heard before is dropped
 *   heard(id, facts)   the relay said what item `id`'s stream is
 *   played(id)         the start of item `id` played a second
 * The facts are remembered once both have happened for the same start, in
 * either order; a start that never plays records nothing.
 */
export function createPlayedStreamNote({ remember = rememberPlayedStream } = {}) {
  let playedId = '';
  let pending = null; // { id, facts } heard before the start played
  return {
    begin() {
      playedId = '';
      pending = null;
    },
    heard(id, facts) {
      const clean = cleanFacts(facts);
      if (!validId(id) || !clean) return false;
      if (playedId === id) {
        pending = null;
        return remember(id, clean) === true;
      }
      pending = { id, facts: clean };
      return false;
    },
    played(id) {
      if (!validId(id)) return false;
      playedId = id;
      const waiting = pending;
      pending = null;
      return waiting?.id === id ? remember(id, waiting.facts) === true : false;
    },
  };
}

/**
 * The format and bitrate shown for an item: what its directory lists (Radio
 * Browser), as before; for a station without them, what it played with. A
 * played value only fills in what the directory leaves out, and only when
 * the two do not disagree. '' when nothing is known.
 */
export function stationStreamLabel(item) {
  return formatStreamQuality(stationStreamFacts(item));
}

/** The parts behind stationStreamLabel: { codec, bitrate, hls }. */
export function stationStreamFacts(item) {
  const extra = item?._extra && typeof item._extra === 'object' && !Array.isArray(item._extra) ? item._extra : {};
  const listed = { codec: cleanCodec(extra.codec), bitrate: cleanBitrate(extra.bitrate), hls: extra.hls === true };
  const played = typeof item?.id === 'string' ? playedStreamOf(item.id) : null;
  if (!played) return listed;
  const agree = (!listed.codec || !played.codec || listed.codec === played.codec)
    && (!listed.bitrate || !played.bitrate || listed.bitrate === played.bitrate);
  if (!agree) return listed;
  return { codec: listed.codec || played.codec, bitrate: listed.bitrate || played.bitrate, hls: listed.hls };
}

/** The short form for a Tuner card's small line: "AAC 128k", "MP3", "128k",
 *  or '' when nothing is known. */
export function compactStreamLabel({ codec = '', bitrate = 0, hls = false } = {}) {
  const kbps = cleanBitrate(bitrate);
  const format = cleanCodec(codec) || (hls === true ? 'HLS' : '');
  return [format, kbps ? `${kbps}k` : ''].filter(Boolean).join(' ');
}

/** The tooltip line for a label: "Stream: MP3 · 128 kbps", or ''. */
export function streamTooltipLine(label) {
  return label ? `Stream: ${label}` : '';
}
