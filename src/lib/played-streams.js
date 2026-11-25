/**
 * The stream format and bitrate a station said it had the last time it
 * played ("MP3 · 128 kbps" in its card's tooltip, in the details panel, and
 * on the card with "Show technical source details" on).
 *
 * When the relay opens a plain live audio stream it keeps what the station's
 * reply says (Content-Type and icy-br); the now-playing poll that runs anyway
 * while such a station plays brings it to the page (now-playing.js). Once that
 * start has played a second, it is remembered here per item. For HLS the
 * player uses the active hls.js level. A start that never plays records nothing.
 *
 * Kept in browser storage under PLAYED_STREAMS_KEY as a cache, like the "Did
 * not play last time" marks: at most MAX_PLAYED_STREAMS entries (the oldest
 * go first), written only when facts change, not in the profile files
 * or backups, and Clear cache removes it.
 */

import { cleanBitrate, cleanCodec, codecFromContentType, formatStreamBitrate, formatStreamQuality } from './stream-quality.js';
import { detectStreamKind, mediaAddressKey } from './item-model.js';
import { stationStreamAddresses } from './station-stream-addresses.js';

export const PLAYED_STREAMS_KEY = 'worldmedia.playedstreams.v1';
export const MAX_PLAYED_STREAMS = 1_000;
const MAX_ID_LENGTH = 512;

const VIDEO_CODECS = new Map([
  ['avc1', 'H.264'], ['avc3', 'H.264'], ['hvc1', 'HEVC'], ['hev1', 'HEVC'],
  ['dvh1', 'Dolby Vision'], ['dvhe', 'Dolby Vision'], ['av01', 'AV1'],
  ['vp09', 'VP9'], ['vp9', 'VP9'], ['vp08', 'VP8'], ['vp8', 'VP8'],
]);
const VIDEO_CODEC_LABELS = new Set(VIDEO_CODECS.values());
const HLS_AUDIO_CODECS = new Map([
  ['mp4a.40.2', 'AAC'], ['mp4a.40.5', 'AAC+'], ['mp4a.40.29', 'AAC+'],
  ['mp4a.40.34', 'MP3'], ['mp4a.69', 'MP3'], ['mp4a.6b', 'MP3'], ['mp3', 'MP3'],
  ['ac-3', 'AC-3'], ['ec-3', 'E-AC-3'], ['opus', 'OPUS'], ['flac', 'FLAC'], ['alac', 'ALAC'],
]);

let entries = null; // item and address -> stream facts, oldest first
const listeners = new Set();

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

/** Clean facts, or null when the format and bitrate are unknown. */
function cleanFacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const codec = cleanCodec(value.codec);
  const bitrate = cleanBitrate(value.bitrate);
  const hls = value.hls === true;
  const { width, height } = value;
  const hasSize = [width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 16384);
  const videoCodec = (hls || hasSize) && VIDEO_CODEC_LABELS.has(value.videoCodec) ? value.videoCodec : '';
  const frameRate = hasSize && Number.isFinite(value.frameRate) && value.frameRate > 0 && value.frameRate <= 1000
    ? Math.round(value.frameRate * 1000) / 1000 : 0;
  if (!codec && !bitrate && !hls && !hasSize) return null;
  return {
    codec, bitrate,
    ...(hls ? { hls: true } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(hasSize ? { width, height } : {}),
    ...(frameRate ? { frameRate } : {}),
  };
}

function singleCodec(value, labelFor) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const labels = new Set(value.toLowerCase().split(',').map((codec) => labelFor(codec.trim())));
  return labels.size === 1 ? labels.values().next().value || '' : '';
}

function videoCodecLabel(value) {
  return singleCodec(value, (codec) => VIDEO_CODECS.get(codec.split('.')[0]));
}

function dashFrameRate(value) {
  if (typeof value === 'string' && /^\d+\/\d+$/.test(value)) {
    const [frames, seconds] = value.split('/').map(Number);
    return frames / seconds;
  }
  return typeof value === 'string' || typeof value === 'number' ? Number(value) : 0;
}

/** The active HLS variant's declared codecs and total bandwidth, in kbps. */
export function streamFactsFromHlsLevel(level, { video = false, audioOnly = false } = {}) {
  if (!level) return null;
  const videoCodec = audioOnly ? '' : videoCodecLabel(level.videoCodec);
  // A variant with a picture has a combined bandwidth. Show the audio
  // codec beside the video codec, or just the bandwidth if video is unknown.
  const audioCodec = audioOnly || videoCodec || !(video || level.videoCodec || level.height)
    ? singleCodec(level.audioCodec, (codec) => HLS_AUDIO_CODECS.get(codec))
    : '';
  const bandwidth = Number(level.attrs?.BANDWIDTH);
  return cleanFacts({ codec: audioCodec, videoCodec, bitrate: bandwidth / 1000, hls: true });
}

/** { codec, bitrate } from the relay's stream facts ({ content_type,
 *  bitrate }), or null when they say nothing the app knows. */
export function streamFactsFromRelay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return cleanFacts({ codec: codecFromContentType(value.content_type), bitrate: value.bitrate });
}

/** True when two fact sets say the same. */
export function sameStreamFacts(a, b) {
  return Boolean(a && b && a.codec === b.codec && a.bitrate === b.bitrate
    && a.hls === b.hls && a.videoCodec === b.videoCodec
    && a.width === b.width && a.height === b.height && a.frameRate === b.frameRate);
}

function entryKey(id, address) {
  return JSON.stringify([id, address]);
}

function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const parsed = JSON.parse(storage()?.getItem(PLAYED_STREAMS_KEY) || 'null');
    if (parsed?.version === 1 && Array.isArray(parsed.items)) {
      for (const entry of parsed.items.slice(-MAX_PLAYED_STREAMS)) {
        const [id, codec, bitrate, hls, videoCodec, savedAddress, width, height, frameRate] = Array.isArray(entry) ? entry : [];
        const facts = cleanFacts({ codec, bitrate, hls, videoCodec, width, height, frameRate });
        if (validId(id) && facts) {
          const address = (facts.hls || facts.width) && /^[0-9a-f]{16}$/.test(savedAddress) ? savedAddress : '';
          const key = entryKey(id, address);
          entries.delete(key);
          entries.set(key, { id, facts, address });
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
    const items = Array.from(entries.values(), ({ id, facts, address }) => {
      const entry = [id, facts.codec, facts.bitrate];
      if (facts.width) {
        entry.push(facts.hls === true, facts.videoCodec || '', address, facts.width, facts.height);
        if (facts.frameRate) entry.push(facts.frameRate);
      } else if (facts.hls) {
        entry.push(true, facts.videoCodec || '');
        if (address) entry.push(address);
      }
      return entry;
    });
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

function latestEntry(all, id) {
  let latest;
  for (const entry of all.values()) {
    if (entry.id === id) latest = entry;
  }
  return latest;
}

/** What item `id` said its stream was when it last played, or null. */
export function playedStreamOf(id, url) {
  if (!validId(id)) return null;
  const all = load();
  let entry;
  if (url !== undefined) {
    const address = mediaAddressKey(url);
    if (address) entry = all.get(entryKey(id, address));
  } else {
    entry = latestEntry(all, id);
  }
  return entry ? { ...entry.facts } : null;
}

/** Remember what item `id` played with. Written only when it differs from
 *  what is kept; true when it did. A write that fails changes nothing, so
 *  the same values are tried again on a later play. */
export function rememberPlayedStream(id, facts, url) {
  const clean = cleanFacts(facts);
  if (!validId(id) || !clean) return false;
  const all = load();
  const address = clean.hls || clean.width ? mediaAddressKey(url) : '';
  const key = entryKey(id, address);
  const previous = all.get(key);
  if (sameStreamFacts(previous?.facts, clean) && latestEntry(all, id) === previous) return false;
  const before = new Map(all);
  all.delete(key);
  all.set(key, { id, facts: clean, address });
  while (all.size > MAX_PLAYED_STREAMS) all.delete(all.keys().next().value);
  if (!save()) {
    entries = before;
    return false;
  }
  notify(id);
  return true;
}

/** The address changed, so the old facts and the card's label are stale. */
export function clearPlayedStream(id) {
  if (validId(id)) {
    const all = load();
    const size = all.size;
    for (const [key, entry] of all) {
      if (entry.id === id) all.delete(key);
    }
    if (all.size !== size) save();
  }
  notify(id);
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
 * Ties stream facts to a start that really played. The player calls
 *   begin()            for every new start: anything heard before is dropped
 *   heard(id, facts)   the relay or playback engine reported stream facts
 *   played(id)         the start of item `id` played a second
 * The facts are remembered once both have happened for the same start, in
 * either order; a start that never plays records nothing.
 */
export function createPlayedStreamNote({ remember = rememberPlayedStream } = {}) {
  let playedId = '';
  let saved = null;
  let pending = null;
  let progress = 0;

  function previousFacts({ id, url }) {
    if (saved?.id === id && saved.url === url && saved.facts.hls) return saved.facts;
    const facts = load().get(entryKey(id, mediaAddressKey(url)))?.facts;
    return facts?.hls ? facts : null;
  }

  function needsStability(note) {
    if (note.facts.width) return true;
    const previous = note.facts.hls ? previousFacts(note) : null;
    return previous && !sameStreamFacts(previous, note.facts);
  }

  function commit(note) {
    pending = null;
    saved = note;
    return remember(note.id, note.facts, note.url) === true;
  }

  return {
    begin() {
      playedId = '';
      saved = null;
      pending = null;
      progress = 0;
    },
    heard(id, facts, url) {
      const clean = cleanFacts(facts);
      if (!validId(id) || !clean) return false;
      const note = { id, facts: clean, url };
      if ((clean.hls || clean.width) && saved?.id === id && saved.url === url && sameStreamFacts(saved.facts, clean)) {
        pending = null;
        return false;
      }
      if (playedId === id && !needsStability(note)) return commit(note);
      if (pending?.id === id && pending.url === url && sameStreamFacts(pending.facts, clean)) return false;
      pending = note;
      progress = 0;
      return false;
    },
    played(id) {
      if (!validId(id)) return false;
      playedId = id;
      if (pending?.id !== id) return false;
      if (needsStability(pending) && progress < 5_000) return false;
      return commit(pending);
    },
    videoProgress(id, url, video, kind, rendition, ms) {
      const { videoWidth: width, videoHeight: height } = video;
      if (!width || !height) {
        pending = null;
        return;
      }
      const hls = kind === 'hls';
      const variant = hls ? streamFactsFromHlsLevel(rendition, { video: true }) : null;
      const frameRate = hls ? Number(rendition?.attrs?.['FRAME-RATE']) : dashFrameRate(rendition?.frameRate);
      const videoCodec = kind === 'dash' ? videoCodecLabel(rendition?.codecs) : variant?.videoCodec;
      const facts = cleanFacts({ ...variant, hls, width, height, frameRate, videoCodec });
      if (!facts?.width) {
        pending = null;
        return;
      }
      const same = pending?.id === id && pending.url === url && sameStreamFacts(pending.facts, facts);
      this.heard(id, facts, url);
      // Credit only time between observations of the same facts.
      if (same) this.progress(ms);
    },
    renditionChanged() {
      pending = null;
    },
    progress(ms) {
      if (!pending || !(pending.facts.hls || pending.facts.width)) return;
      // Brief ABR switches should leave the saved label alone.
      progress += ms;
      if (pending.id === playedId && progress >= 5_000) commit(pending);
    },
  };
}

/**
 * The format and bitrate shown for an item. HLS uses the last played
 * variant. For plain audio, the played values fill gaps in the listing
 * when the values agree. '' when nothing is known.
 */
export function stationStreamLabel(item) {
  return formatStreamQuality(stationStreamFacts(item));
}

/** The parts behind stationStreamLabel, including the video codec when known. */
export function stationStreamFacts(item) {
  const extra = item?._extra && typeof item._extra === 'object' && !Array.isArray(item._extra) ? item._extra : {};
  const { main, ordered } = stationStreamAddresses(item);
  const listed = main
    ? { codec: '', bitrate: 0, hls: detectStreamKind(new URL(main).pathname) === 'hls' }
    : { codec: cleanCodec(extra.codec), bitrate: cleanBitrate(extra.bitrate), hls: extra.hls === true };
  const played = typeof item?.id === 'string' ? playedStreamOf(item.id) : null;
  // A variant's bandwidth applies to that variant alone.
  if (played?.hls || played?.width) return played;
  if (played && ordered) return { ...played, hls: false };
  if (!played) return listed;
  const agree = (!listed.codec || !played.codec || listed.codec === played.codec)
    && (!listed.bitrate || !played.bitrate || listed.bitrate === played.bitrate);
  if (!agree) return listed;
  return { codec: listed.codec || played.codec, bitrate: listed.bitrate || played.bitrate, hls: listed.hls };
}

/** The short form for a Tuner card's small line: "AAC 128k", "MP3", "128k",
 *  or '' when nothing is known. */
export function compactStreamLabel({ codec = '', bitrate = 0, hls = false, videoCodec = '' } = {}) {
  const bandwidth = formatStreamBitrate(bitrate, { hls, compact: true });
  return [hls ? 'HLS' : '', videoCodec, cleanCodec(codec), bandwidth].filter(Boolean).join(' ');
}

/** The tooltip line for a label: "Stream: MP3 · 128 kbps", or ''. */
export function streamTooltipLine(label) {
  return label ? `Stream: ${label}` : '';
}
