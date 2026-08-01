/** Data-driven download/record capability resolution. */

import { getText } from './http.js';

const FINITE_DIRECT_KINDS = new Set(['audio', 'video']);
const FINITE_FILE_PATTERN = /\.(?:aac|flac|m4a|mp3|oga|ogg|wav|m4v|mov|mp4|ogv|webm)(?:[?#]|$)/i;

/**
 * Repair pre-capability-contract items without consulting their source ID.
 * Adapter-declared on-demand direct media is a finite download; older saved
 * audio/video favorites can also be recognized by a finite filename suffix.
 */
export function repairFiniteMediaFields(item) {
  if (!item || typeof item !== 'object' || !item.stream_url
      || !FINITE_DIRECT_KINDS.has(item.stream_kind)) return item;
  const declaredFinite = item.delivery === 'on-demand';
  const legacyFinite = item.delivery === 'unknown'
    && ['audio', 'video'].includes(item.type)
    && FINITE_FILE_PATTERN.test(item.stream_url);
  if (legacyFinite) item.delivery = 'on-demand';
  // A lazy adapter may have inspected provider rights/resource metadata and
  // deliberately left download_url empty. Its completed decision must win
  // over the legacy finite-file inference used for old favorites.
  const downloadResolved = item._extra?.downloadResolved === true;
  if ((declaredFinite || legacyFinite) && !item.download_url && !downloadResolved) {
    item.download_url = item.stream_url;
  }
  return item;
}

function isVideoItem(item) {
  return item?.type === 'tv' || item?.type === 'video'
    || ['video', 'hls', 'dash'].includes(item?.stream_kind) && item?.type !== 'radio' && item?.type !== 'audio';
}

export function classifyHlsManifest(text) {
  if (typeof text !== 'string' || !/^\s*#EXTM3U\b/m.test(text)) return 'unknown';
  if (/^\s*#EXT-X-ENDLIST\s*$/mi.test(text)
      || /^\s*#EXT-X-PLAYLIST-TYPE\s*:\s*VOD\s*$/mi.test(text)) return 'on-demand';
  if (/^\s*#EXT-X-STREAM-INF\s*:/mi.test(text) || /^\s*#EXT-X-MEDIA\s*:/mi.test(text)) return 'unknown';
  if (/^\s*#EXTINF\s*:/mi.test(text) || /^\s*#EXT-X-PLAYLIST-TYPE\s*:\s*EVENT\s*$/mi.test(text)) {
    return 'live';
  }
  return 'unknown';
}

export function firstHlsVariantUrl(text, manifestUrl) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*#EXT-X-MEDIA\s*:/i.test(line)) {
      const uri = line.match(/\bURI\s*=\s*"([^"]+)"/i)?.[1]
        || line.match(/\bURI\s*=\s*([^,\s]+)/i)?.[1];
      if (uri) {
        try { return new URL(uri, manifestUrl).href; } catch (_) { return ''; }
      }
    }
    if (/^\s*#EXT-X-STREAM-INF\s*:/i.test(line)) {
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next].trim();
        if (!candidate || candidate.startsWith('#')) continue;
        try { return new URL(candidate, manifestUrl).href; } catch (_) { return ''; }
      }
    }
  }
  return '';
}

export function classifyDashManifest(text) {
  if (typeof text !== 'string' || !/<MPD\b/i.test(text)) return 'unknown';
  const match = text.match(/<MPD\b[^>]*\btype\s*=\s*["'](static|dynamic)["']/i);
  if (!match) return 'unknown';
  return match[1].toLowerCase() === 'static' ? 'on-demand' : 'live';
}

export function classifyManifest(kind, text) {
  if (kind === 'hls') return classifyHlsManifest(text);
  if (kind === 'dash') return classifyDashManifest(text);
  return 'unknown';
}

/** Inspect only unknown manifests. Adapter declarations always win. */
export async function inspectManifestDelivery(item, opts = {}) {
  if (!item || item.delivery !== 'unknown') return item?.delivery || 'unknown';
  if (!['hls', 'dash'].includes(item.stream_kind) || !item.stream_url) return 'unknown';
  const loadText = opts.loadText || ((url) => getText(url, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  }));
  const text = await loadText(item.stream_url);
  let delivery = classifyManifest(item.stream_kind, text);
  if (delivery === 'unknown' && item.stream_kind === 'hls') {
    const childUrl = firstHlsVariantUrl(text, item.stream_url);
    if (childUrl) delivery = classifyHlsManifest(await loadText(childUrl));
  }
  if (delivery !== 'unknown' && item.delivery === 'unknown') {
    item.delivery = delivery;
    if (delivery === 'on-demand' && !item.download_url
        && item._extra?.downloadResolved !== true) item.download_url = item.stream_url;
  }
  return item.delivery;
}

/** Pure action resolver. No source IDs are consulted. */
export function resolveMediaAction(item, evidence = {}) {
  if (!item || typeof item !== 'object') return 'unavailable';
  const delivery = item.delivery === 'unknown' && evidence.delivery
    ? evidence.delivery
    : item.delivery;
  if (delivery === 'live') {
    if (item.stream_url || evidence.streamUrl) {
      return isVideoItem(item) ? 'record-video' : 'record-audio';
    }
    return item._extra?.needsResolve ? 'checking' : 'unavailable';
  }
  if (delivery === 'on-demand') {
    if (item.download_url || evidence.downloadUrl) return 'download';
    return item._extra?.needsResolve ? 'checking' : 'unavailable';
  }
  if (item._extra?.needsResolve) return 'checking';
  if (item.download_url || evidence.downloadUrl) return 'download';
  // Legacy favorites saved before the delivery contract still retain their
  // semantic radio/TV type. Treat those channel types as live before the
  // generic unknown-manifest branch, otherwise old IPTV HLS favorites remain
  // stuck on "Checking media capability" forever.
  if (item.type === 'radio' || item.type === 'tv') {
    return isVideoItem(item) ? 'record-video' : 'record-audio';
  }
  if (['hls', 'dash'].includes(item.stream_kind) && !evidence.delivery) return 'checking';
  if ((evidence.contentLength > 0 || evidence.hasFilename) && item.stream_url) return 'download';
  return 'unavailable';
}
