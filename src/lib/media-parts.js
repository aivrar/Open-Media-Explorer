import { loadAdapter } from './sources.js';
import { mediaAddressKey } from './item-model.js';

export function partKind(item) {
  if (item?.type !== 'audio') return '';
  if (item.source === 'librivox') return 'Chapter';
  if (item.source === 'internet-archive') return 'Track';
  return '';
}

export function hasPartsSource(item) {
  const kind = partKind(item);
  return Boolean((kind === 'Chapter' && item._extra?.rssUrl) || (kind === 'Track' && item._extra?.identifier));
}

export async function loadParts(item) {
  if (!hasPartsSource(item)) return [];
  const adapter = await loadAdapter(item.source);
  return adapter.resolveParts(item);
}

export function partLabel(item, selection) {
  if (!selection || selection.parts.length < 2) return '';
  const { index, parts } = selection;
  return partKind(item) + ' ' + (index + 1) + ' of ' + parts.length + ' \u00b7 ' + parts[index].title;
}

export function partDuration(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(text)) return null;
  const seconds = text.split(':').reduce((total, field) => total * 60 + Number(field), 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function partTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

export function resumablePart(item, parts, bookmark) {
  const index = bookmark ? parts.findIndex((part) => part.key === bookmark.partKey) : -1;
  if (index < 0 || (index === 0 && bookmark.position === 0)) return null;
  const duration = parts[index].duration;
  const position = duration && bookmark.position >= duration ? 0 : bookmark.position;
  if (index === 0 && position === 0) return null;
  return { index, position, label: 'Resume ' + partKind(item).toLowerCase() + ' ' + (index + 1) + ' at ' + partTime(position) };
}

export function itemForPart(item, selection) {
  if (!selection) {
    if (item?.source !== 'librivox' || !item.download_url) return item;
    return { ...item, download_part: mediaAddressKey(item.download_url) };
  }
  const { parts, index } = selection;
  const part = parts[index];
  // The first chapter keeps LibriVox's existing download target if supplied.
  const keepDownload = item.source === 'librivox' && index === 0 && item.download_url;
  const downloadUrl = keepDownload ? item.download_url : part.url;
  return {
    ...item,
    delivery: 'on-demand',
    stream_kind: 'audio',
    stream_url: part.url,
    download_url: downloadUrl,
    download_part: mediaAddressKey(downloadUrl),
    download_name: keepDownload ? item.download_name : part.downloadName,
  };
}
