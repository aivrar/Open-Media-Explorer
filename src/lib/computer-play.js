import { normalizeChapters } from '../modes/computer-chapters.js';
import {
  audioLayout, bitrateText, computerFileFormat, computerFileKind, computerItemId,
  episodeTitle, fileName, formatDetails, movieCodec, movieResolution, videoTitle,
} from './computer-catalog.js';
import { loudnessFields } from './computer-levelling.js';
import { makeItem } from './item-model.js';
import { applyComputerMoves, partResumeGeneration, readPartResume, rememberPartResume } from './part-resume.js';
import { playItem, showComputerSelectionMessage } from './player.js';

export const COMPUTER_OFFLINE_TOOLTIP = 'The folder is not connected.';
const OFFLINE_MESSAGE = 'That folder is not connected.';
// The play route also returns ENTRY_NOT_FOUND when the folder is no longer approved.
const folderRefusals = new Set(['COMPUTER_FOLDER_OFFLINE', 'COMPUTER_ENTRY_NOT_FOUND']);

export function isComputerFolderRefusal(error) {
  return folderRefusals.has(error?.code);
}

export function reportOfflineComputerFolder() {
  return showComputerSelectionMessage(OFFLINE_MESSAGE);
}

const FILE_PART = 'file';
const RESUME_SAVE_MS = 15_000;
const SKIP_DELAY_MS = 2_000;
const FAILURE_LIMIT = 3;
let queue = null;
let skipTimer = null;

function computerVideoFormat(entry) {
  const resolution = entry.height === 480 ? '480p' : movieResolution(entry);
  const video = entry.vcodec === 'mpeg2video' ? 'MPEG-2' : movieCodec(entry.vcodec);
  const audio = movieCodec(entry.acodec);
  const layout = entry.channels > 2 ? audioLayout(entry.channels) : '';
  const audioFormat = [audio, layout].filter(Boolean).join(entry.acodec === 'ac3' ? ' ' : ' \u00b7 ');
  return [resolution, video, audioFormat].filter(Boolean).join(' \u00b7 ');
}

export function makeComputerItem(entry) {
  const type = entry.kind === 'video' ? 'video' : 'audio';
  const { id, artist = '', album = '', duration = null } = entry;
  const chapters = normalizeChapters(entry.chapters);
  const kind = computerFileKind(entry);
  const format = (type === 'video' && computerVideoFormat(entry)) || computerFileFormat(entry);
  return makeItem({
    id: computerItemId(entry), source: 'computer', type, stream_kind: type,
    delivery: 'on-demand', title: type === 'video' ? videoTitle(entry) : entry.title || fileName(entry), year: entry.year,
    description: type === 'video' ? '' : [artist, album].filter(Boolean).join(' \u00B7 '),
    _extra: { computer: {
      id, artist, album, duration, format,
      ...loudnessFields(entry),
      ...(entry.duration_estimated === true && { duration_estimated: true }),
      ...(type === 'video' && Number.isFinite(entry.size) && Number.isFinite(entry.mtime)
        && { size: entry.size, mtime: entry.mtime }),
      ...(entry.ext && { ext: entry.ext }), ...(entry.error && { unreadable: true }),
      formatDetails: type === 'video' ? format : formatDetails(entry, { includeBitrate: false }),
      ...(type === 'audio' && entry.bitrate && { bitrate: bitrateText(entry) }),
      ...((entry.art || entry.has_cover) && { hasCover: true }), ...(kind && { kind }),
      ...(kind === 'Episode' && { episodeTitle: episodeTitle(entry) }),
      ...(chapters.length ? { chapters } : {}),
    } },
  });
}

export function computerSubtitle(item) {
  if (item.type !== 'video') return item.description;
  const computer = item._extra?.computer;
  return computer?.kind === 'Episode' ? computer.episodeTitle || '' : 'Video';
}

const computerPlayMessages = new Set([
  'Install FFmpeg in Settings to play this format.',
  'This file could not be converted.',
  'There is not enough disk space to prepare this file.',
  'This file takes too long to prepare.',
  'This file cannot be read.',
  'That file is not in the library.',
  'Playback is unavailable during shutdown.',
  'This format cannot be played yet.',
]);

const computerRefusalMessages = new Map([
  ['COMPUTER_FILE_GONE', 'That file is no longer there.'],
  ['COMPUTER_FOLDER_OFFLINE', OFFLINE_MESSAGE],
  ['COMPUTER_ENTRY_NOT_FOUND', 'That file is not in the library.'],
  ['COMPUTER_VIDEO_TOO_SHORT', 'This file is too short to play.'],
  ['COMPUTER_FILE_UNREADABLE', 'This file cannot be read.'],
  ['COMPUTER_PLAY_PROPERTIES_UNAVAILABLE', 'This file cannot be read.'],
  ['COMPUTER_CONVERT_FAILED', 'This file could not be converted.'],
  ['COMPUTER_CONVERT_PROCESS_TIMEOUT', 'This file could not be converted.'],
  ['COMPUTER_CONVERT_FFMPEG', 'Install FFmpeg in Settings to play this format.'],
  ['COMPUTER_CONVERT_DISK', 'There is not enough disk space to prepare this file.'],
]);

export function reportMissingComputerFile() {
  return showComputerSelectionMessage(computerOpenMessage({ code: 'COMPUTER_FILE_GONE' }));
}

export function computerOpenMessage(error, selectionTitle) {
  if (error?.retryable && error.message && error.message !== 'Local control request failed.') return error.message;
  if (computerPlayMessages.has(error?.message)) return error.message;
  if (error?.code === 'COMPUTER_MEDIA_EXPIRED') return 'This play link has expired.';
  const refusal = computerRefusalMessages.get(error?.code);
  if (refusal) return refusal;
  if (selectionTitle) {
    if (error?.status && error.message && error.message !== 'Local control request failed.') return error.message;
    return 'Could not open ' + selectionTitle + '.';
  }
  return 'This file could not be opened.';
}

export function computerHlsConfig(HlsLib, startPosition) {
  const errorRetry = {
    maxNumRetry: 5, // Six requests including the first.
    retryDelayMs: 400,
    maxRetryDelayMs: 400,
    shouldRetry: (_config, _count, _timeout, response, retry) => retry && response?.code === 503,
  };
  const loadPolicy = (timeout, retry) => ({
    default: { maxTimeToFirstByteMs: timeout, maxLoadTimeMs: timeout, timeoutRetry: null, errorRetry: retry },
  });
  // The stream controller skips its retry delay while the element is seeking.
  // Give fragment retries to the vendored XHR loader so they wait even then.
  class ComputerFragmentLoader extends HlsLib.DefaultConfig.loader {
    load(context, config, callbacks) {
      return super.load(context, { ...config, loadPolicy: { ...config.loadPolicy, errorRetry } }, callbacks);
    }
  }
  return {
    startPosition,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    lowLatencyMode: false,
    maxFragLookUpTolerance: 0, // The server playlist has an exact six-second grid.
    manifestLoadPolicy: loadPolicy(20_000, errorRetry),
    playlistLoadPolicy: loadPolicy(20_000, errorRetry),
    fragLoadPolicy: loadPolicy(40_000, null),
    fLoader: ComputerFragmentLoader,
  };
}

export function computerHlsErrorMessage(data, fallback) {
  // The default hls.js XHR loader keeps the server response on networkDetails.
  const body = data.networkDetails?.response;
  try {
    const text = body instanceof ArrayBuffer ? new TextDecoder().decode(body) : body;
    const error = JSON.parse(text)?.error;
    return error?.message || fallback || computerOpenMessage(error);
  } catch {
    return fallback || computerOpenMessage();
  }
}

export function isComputerFormatError(mediaError, playError) {
  return mediaError?.code === 3 || mediaError?.code === 4
    || (!mediaError?.code && playError?.name === 'NotSupportedError');
}

export function cancelComputerAdvance() {
  clearTimeout(skipTimer);
  skipTimer = null;
}

export function setComputerQueue(next) {
  cancelComputerAdvance();
  queue = next;
}

export function clearComputerQueue() {
  setComputerQueue(null);
}

export function computerQueueState() {
  return queue;
}

export function moveComputerQueueEntries(moves, entriesById) {
  const destinations = applyComputerMoves(moves, entriesById);
  if (queue) {
    for (const [index, entry] of queue.entries.entries()) {
      const id = destinations.get(entry.id);
      if (id && id !== entry.id) queue.entries[index] = entriesById.get(id) ?? { ...entry, id };
    }
    for (const [from, to] of destinations) {
      if (queue.bookKey === JSON.stringify([from])) {
        queue.bookKey = JSON.stringify([to]);
        break;
      }
    }
  }
  return destinations;
}

function playQueuedEntry(selection, { startAt, prepared, automatic = false } = {}) {
  const options = { computerQueue: selection, automatic };
  if (prepared) options.prepared = prepared;
  if (Number.isFinite(startAt) && startAt >= 0) options.startAt = startAt;
  return selection.play(makeComputerItem(selection.entries[selection.index]), options);
}

export async function playComputerEntries(entries, startIndex, {
  shuffle = false, play = playItem, random = Math.random, startAt, bookKey,
} = {}) {
  const chosen = entries[startIndex];
  if (!chosen) return;
  if (chosen.error) {
    if (!showComputerSelectionMessage(chosen.error)) {
      return play(makeComputerItem(chosen), { computerRowError: chosen.error });
    }
    return;
  }
  const order = [...entries];
  let index = startIndex;
  if (shuffle) {
    order.splice(startIndex, 1);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.unshift(chosen);
    index = 0;
  }
  return playQueuedEntry({ entries: order, index, play, failures: 0, bookKey }, { startAt });
}

export function moveComputerQueue(offset, { automatic = false, prepared } = {}) {
  if (!queue) return;
  const index = queue.index + offset;
  if (!queue.entries[index]) return;
  if (!automatic) return playQueuedEntry({ ...queue, index, failures: 0 }, { prepared });
  cancelComputerAdvance();
  queue.index = index;
  return playQueuedEntry(queue, { automatic, prepared });
}

export function resetComputerTrackFailures() {
  if (queue) queue.failures = 0;
}

export function computerTrackFailed(canAdvance) {
  if (!queue) return;
  queue.failures++;
  cancelComputerAdvance();
  if (queue.failures >= FAILURE_LIMIT || !queue.entries[queue.index + 1] || !canAdvance()) return;
  skipTimer = setTimeout(() => {
    skipTimer = null;
    if (canAdvance()) Promise.resolve(moveComputerQueue(1, { automatic: true })).catch(() => {});
  }, SKIP_DELAY_MS);
}

const bookResumeId = (key) => `computer:book:${key}`;

// Keep the active file and its successors by id so a rescan can remove
// a part without sending the book back to its beginning.
function readBookBookmark(key) {
  const saved = readPartResume(bookResumeId(key));
  if (!saved) return null;
  const [fileId, ...laterIds] = saved.partKey.startsWith('[') ? JSON.parse(saved.partKey) : [saved.partKey];
  return { position: saved.position, fileId, laterIds };
}

function bookPartKey(entries, index) {
  const ids = entries.slice(index, index + 200).map(computerItemId);
  return ids.length === 1 ? ids[0] : JSON.stringify(ids);
}

export function bookResumeIndex(book) {
  const bookmark = readBookBookmark(book.key);
  if (!bookmark) return 0;
  const indexById = new Map(book.entries.map((entry, index) => [computerItemId(entry), index]));
  for (const id of [bookmark.fileId, ...bookmark.laterIds]) {
    if (indexById.has(id)) return indexById.get(id);
  }
  return book.entries.length === 1 ? 0 : -1;
}

export function bookPlaybackOptions(book) {
  const bookmark = readBookBookmark(book.key);
  return book.entries.length > 1 || book.entries[0]?.album?.trim() || bookmark ? { bookKey: book.key } : {};
}

export function createComputerResume(item, kind, reportedDuration) {
  const epoch = partResumeGeneration();
  const bookQueue = queue?.bookKey != null && computerItemId(queue.entries[queue.index]) === item.id ? queue : null;
  const book = Boolean(bookQueue);
  const bookIndex = bookQueue?.index;
  const bookmarkId = () => book ? bookResumeId(bookQueue.bookKey) : item.id;
  const partKey = () => book ? bookPartKey(bookQueue.entries, bookIndex) : FILE_PART;
  const bookmark = book ? readBookBookmark(bookQueue.bookKey) : readPartResume(bookmarkId());
  const replacingPart = book && bookmark && bookmark.fileId !== item.id;
  const fileBookmark = book && !bookmark ? readPartResume(item.id) : null;
  const saved = book ? (bookmark?.fileId === item.id ? bookmark.position : fileBookmark?.position || 0)
    : bookmark?.partKey === FILE_PART ? bookmark.position : 0;
  let savedAt = -Infinity;
  const fileDuration = (duration) => Number.isFinite(duration) && duration > 0 ? duration : reportedDuration;
  const longEnough = (duration) => Number.isFinite(duration) && duration > (kind === 'video' ? 600 : 1_200);
  const finished = (position, duration) => duration - position <= 30 || position / duration > 0.97;
  const clear = () => rememberPartResume(bookmarkId(), null, 0, epoch);

  return {
    startPosition(elementDuration) {
      if (!saved) return 0;
      if (book) return Math.max(0, saved - 3);
      const duration = fileDuration(elementDuration);
      if (!Number.isFinite(duration)) return null;
      if (!longEnough(duration) || finished(saved, duration)) {
        clear();
        return 0;
      }
      return Math.max(0, saved - 3);
    },
    save(media, force, advanced) {
      if (replacingPart && !advanced) return;
      const duration = fileDuration(media.duration);
      if ((!book && !longEnough(duration)) || !Number.isFinite(media.currentTime) || media.currentTime < 0) return;
      const now = Date.now();
      if (!force && now - savedAt < RESUME_SAVE_MS) return;
      savedAt = now;
      rememberPartResume(bookmarkId(), book || media.currentTime > 0 ? partKey() : null, media.currentTime, epoch);
    },
    clear(advanced) {
      if (replacingPart && !advanced) return;
      if (bookQueue?.entries[bookIndex + 1]) {
        rememberPartResume(bookmarkId(), bookPartKey(bookQueue.entries, bookIndex + 1), 0, epoch);
      }
      else clear();
    },
  };
}
