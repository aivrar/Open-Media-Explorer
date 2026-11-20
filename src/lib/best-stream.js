/**
 * "Pick the best stream" (Settings > Content, on by default): when a station
 * or channel has several streams, the best one that plays is used, and the
 * next best is tried when it fails. Its Auto (verified) choice also uses
 * another Radio Browser entry of the same station once it passed every
 * check (stream-verify.js).
 *
 * What "best" means, in order:
 *  1. For TV: the higher picture size the directory gives ("1080p" before
 *     "720p"; a stream with no size given comes after those with one).
 *  2. For radio: a higher bitrate, up to 320 kbps. A lossless stream (FLAC or
 *     WAV, or anything over 320 kbps) is used only when no other stream
 *     plays: it needs several times the bandwidth for a difference few can
 *     hear, and some do not play smoothly over a slow connection.
 *  3. At the same bitrate, the more efficient format: Opus, AAC+ and AAC
 *     before Ogg Vorbis, before MP3.
 *  4. Otherwise the order the source gave.
 * The values are what the directory reports (iptv-org's quality label, Radio
 * Browser's bitrate and codec), not a measurement.
 *
 * Pure functions only; media-failover.js orders and connects the streams.
 */

export const LOSSY_BITRATE_LIMIT_KBPS = 320;

const LOSSLESS_CODECS = new Set(['FLAC', 'WAV', 'ALAC']);
const CODEC_ORDER = new Map([['OPUS', 4], ['AAC+', 4], ['AAC', 3], ['OGG', 2], ['MP3', 1]]);

/** The choices of "Pick the best stream" (`bestStreamMode` in the settings):
 *  off as before the feature; the best of the streams a station or channel
 *  lists (the default); or that and, for a radio station, another directory
 *  entry of it once verified (stream-verify.js, best-stream-auto.js). */
export const BEST_STREAM_MODES = Object.freeze(['off', 'listed', 'auto']);
export const BEST_STREAM_MODE_LABELS = Object.freeze({
  off: 'Off', listed: 'Listed streams', auto: 'Auto (verified)',
});
export const DEFAULT_BEST_STREAM_MODE = 'listed';

/** The mode in `settings`; an older `bestStream: false` reads as off. */
export function bestStreamMode(settings) {
  const mode = settings?.bestStreamMode;
  if (BEST_STREAM_MODES.includes(mode)) return mode;
  return settings?.bestStream === false ? 'off' : DEFAULT_BEST_STREAM_MODE;
}

/** True unless the setting is off. */
export function bestStreamOn(settings) {
  return bestStreamMode(settings) !== 'off';
}

/** True only for Auto (verified). */
export function bestStreamAutoOn(settings) {
  return bestStreamMode(settings) === 'auto';
}

/** Picture height from a quality label such as "1080p", "576i" or "4K"; 0
 *  when the label says nothing usable. */
export function resolutionOf(label) {
  if (typeof label !== 'string') return 0;
  const text = label.trim().toLowerCase();
  const lines = text.match(/^(\d{3,4})\s*[pi]?$/) || text.match(/(\d{3,4})\s*[pi]\b/);
  if (lines) {
    const value = Number(lines[1]);
    return value >= 144 && value <= 4320 ? value : 0;
  }
  if (/\b8k\b/.test(text)) return 4320;
  if (/\b4k\b|\buhd\b/.test(text)) return 2160;
  return 0;
}

function bitrateOf(candidate) {
  const value = Number(candidate?.bitrate);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function codecOf(candidate) {
  return typeof candidate?.codec === 'string' ? candidate.codec.toUpperCase() : '';
}

/** True for a lossless stream, or one above LOSSY_BITRATE_LIMIT_KBPS. */
export function isLossless(candidate) {
  return LOSSLESS_CODECS.has(codecOf(candidate)) || bitrateOf(candidate) > LOSSY_BITRATE_LIMIT_KBPS;
}

/** Negative when `a` is the better stream, positive when `b` is, 0 when
 *  nothing tells them apart. */
export function compareStreams(a, b) {
  const height = resolutionOf(b?.quality) - resolutionOf(a?.quality);
  if (height) return height;
  const lossless = Number(isLossless(a)) - Number(isLossless(b));
  if (lossless) return lossless;
  const bitrate = bitrateOf(b) - bitrateOf(a);
  if (bitrate) return bitrate;
  return (CODEC_ORDER.get(codecOf(b)) || 0) - (CODEC_ORDER.get(codecOf(a)) || 0);
}

/** A new array, best first; streams nothing tells apart keep their order. */
export function rankStreams(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => compareStreams(a.candidate, b.candidate) || a.index - b.index)
    .map(({ candidate }) => candidate);
}
