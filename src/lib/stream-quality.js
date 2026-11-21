/**
 * Stream format and bitrate, as a station directory reports them.
 *
 * Radio Browser lists a bitrate (kbps, 0 when unknown), a codec name and an
 * HLS flag for each station. The adapter keeps cleaned copies in the item's
 * `_extra`; this module cleans them and turns them into one short label such
 * as "MP3 \u00B7 128 kbps". The values are directory data, not a measurement,
 * and an item without them (an older saved favourite) simply has no label.
 */

const MAX_BITRATE_KBPS = 100_000;
const MAX_CODEC_LENGTH = 12;

// Directory spellings for the common audio formats, mapped to one label.
const CODEC_ALIASES = new Map([
  ['MP3', 'MP3'], ['MPEG', 'MP3'], ['MPEG3', 'MP3'], ['MPG', 'MP3'],
  ['AAC', 'AAC'], ['AAC-LC', 'AAC'], ['M4A', 'AAC'],
  ['AAC+', 'AAC+'], ['AACP', 'AAC+'], ['AACPLUS', 'AAC+'], ['HE-AAC', 'AAC+'],
  ['HEAAC', 'AAC+'], ['HE-AACV2', 'AAC+'], ['HE-AAC V2', 'AAC+'],
  ['OGG', 'OGG'], ['VORBIS', 'OGG'], ['OGG VORBIS', 'OGG'],
  ['OPUS', 'OPUS'], ['OGG OPUS', 'OPUS'],
  ['FLAC', 'FLAC'], ['WAV', 'WAV'], ['WMA', 'WMA'],
]);

// Video codecs and placeholders that say nothing about the audio format.
const NOT_AUDIO_CODEC = /^(?:UNKNOWN|NONE|NULL|N\/A|-|0|H\.?26[45]|AVC1?|HEVC|VP[89]|AV1|MPEG-?[24]? ?VIDEO|THEORA)$/;

/** Bitrate in kbps as a whole number, or 0 when it is missing or makes no sense. */
export function cleanBitrate(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_BITRATE_KBPS) return 0;
  return Math.round(number);
}

/** A short upper-case format label ("MP3", "AAC+", ...), or '' when unknown.
 *  A value the app does not know is kept as given, upper-cased, stripped of
 *  anything but letters, digits and a few joiners, and cut to a short length. */
export function cleanCodec(value) {
  if (typeof value !== 'string') return '';
  const parts = value.toUpperCase().split(/[,;/|]/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part && !NOT_AUDIO_CODEC.test(part));
  for (const part of parts) {
    const known = CODEC_ALIASES.get(part);
    if (known) return known;
  }
  const first = parts[0] || '';
  return first.replace(/[^A-Z0-9+.\- ]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CODEC_LENGTH).trim();
}

/** Radio Browser sends the HLS flag as 1, "1" or true depending on the mirror. */
export function isHlsFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** One short label from cleaned parts: "MP3 \u00B7 128 kbps", "MP3",
 *  "128 kbps", or '' when nothing is known. HLS stands in for an unknown format. */
export function formatStreamQuality({ bitrate = 0, codec = '', hls = false } = {}) {
  const kbps = cleanBitrate(bitrate);
  const format = cleanCodec(codec) || (hls === true ? 'HLS' : '');
  return [format, kbps ? `${kbps} kbps` : ''].filter(Boolean).join(' \u00B7 ');
}

/** The label for an item, from what its adapter kept in `_extra`. */
export function streamQualityLabel(item) {
  const extra = item?._extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return '';
  return formatStreamQuality({ bitrate: extra.bitrate, codec: extra.codec, hls: extra.hls === true });
}

/** The label for the stream an item plays now: the format and bitrate the
 *  played stream (media-failover.js playedStream) was listed with when it
 *  has them, else the item's own. */
export function playedQualityLabel(item, played) {
  if (played && (played.bitrate || played.codec)) {
    const extra = item?._extra && typeof item._extra === 'object' && !Array.isArray(item._extra) ? item._extra : {};
    return streamQualityLabel({ _extra: { ...extra, bitrate: played.bitrate || 0, codec: played.codec || '' } });
  }
  return streamQualityLabel(item);
}

/** The `_extra` fields that carry the label, so a favourite rewrite can keep them. */
export const STREAM_QUALITY_FIELDS = Object.freeze(['bitrate', 'codec', 'hls']);
