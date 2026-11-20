/**
 * Starred songs: songs the user starred in the song log or on the player bar.
 *
 * Kept apart from the song log, so they survive its size limit and Clear log:
 * in the native data folder (state/starred-songs.json, through
 * /api/v1/starred-songs), never in localStorage or the mirrored profile (World
 * Media 0.1.8 and older ignore a whole profile file that holds a key they do
 * not know). The file is copied into backups.
 *
 * Entries are plain data, oldest first:
 *   { starred, title, station, stationId, source }
 * At most STARRED_SONGS_LIMIT are kept; starring one more drops the oldest,
 * and the panel always shows the count so nothing goes unnoticed.
 *
 * Saving sends the whole list with a revision one higher than the last one
 * seen; the server applies only newer writes and answers a stale one with
 * what is stored. The page keeps what it changed since the list it last knew
 * as operations (star, unstar, clear). The list shown is always the last
 * known list with those operations applied, so after a stale answer the list
 * written again is what is stored now plus this page's own changes: songs
 * another window unstarred stay unstarred, songs this page unstarred stay
 * unstarred, and a clear stays a clear. One write is in flight at a time.
 * Nothing is written before the saved list was read; changes made meanwhile
 * are applied to it once it arrives.
 */

import { controlRequest } from './capture-client.js';
import { cleanSongLogText, SONG_LOG_FIELD_LIMITS } from './song-log.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';

export const STARRED_SONGS_ROUTE = '/api/v1/starred-songs';
export const STARRED_SONGS_EXPORT_ROUTE = '/api/v1/starred-songs/export';
export const STARRED_SONGS_LIMIT = 2000;
export const STARRED_SONGS_REQUEST_TIMEOUT_MS = 10_000;
export const STARRED_SAVE_FAILED = 'Your starred songs could not be saved. They stay in the list and are saved again with the next change.';
export const STARRED_UNREADABLE_NOTICE = 'The saved starred songs could not be read, so a new list was started. The old file was kept in the data folder.';
/** Why a title cannot be starred (a tooltip and a status line). */
export const NOT_A_SONG = 'This does not look like a song title, so it cannot be starred.';
/** Search pages a starred song can be looked up on: fixed https hosts; only
 *  the song text goes into the query. */
export const SONG_SEARCHES = Object.freeze([
  Object.freeze({ id: 'web', label: 'Web', name: 'the web', base: 'https://duckduckgo.com/?q=' }),
  Object.freeze({ id: 'youtube', label: 'YouTube', name: 'YouTube', base: 'https://www.youtube.com/results?search_query=' }),
]);
const MAX_TIME_MS = 32_503_680_000_000; // 3000-01-01, as in worldmedia_starred.py
const MAX_SAVE_ATTEMPTS = 5;

function validTime(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIME_MS;
}

function safeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Characters the starred songs never keep (as worldmedia_starred.py): the
 *  song log's cleaning also takes out controls, separators and the other
 *  invisible characters; U+061C (a bidi mark) is taken out here as well. */
const ARABIC_LETTER_MARK = /\u061C/g;

/** One plain line of at most `limit` characters, cleaned as the server cleans. */
export function cleanStarredText(value, limit) {
  return cleanSongLogText(typeof value === 'string' ? value.replace(ARABIC_LETTER_MARK, '') : value, limit);
}

/** Letters and digits only, lower case: for comparing a title with a name. */
function bare(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** '' when `title` can be starred, else NOT_A_SONG: an empty title, one with
 *  no letter or digit, or the station's own name. */
export function songStarBlock(title, station = '') {
  const text = cleanStarredText(title, SONG_LOG_FIELD_LIMITS.title);
  const plain = bare(text);
  if (!plain) return NOT_A_SONG;
  if (station && plain === bare(station)) return NOT_A_SONG;
  return '';
}

/** A frozen entry, or null when it is not a song that can be starred. */
export function makeStarredEntry({ starred, title, station, stationId, source } = {}) {
  const entry = {
    starred: Number.isFinite(starred) ? Math.round(starred) : NaN,
    title: cleanStarredText(title, SONG_LOG_FIELD_LIMITS.title),
    station: cleanStarredText(station, SONG_LOG_FIELD_LIMITS.station),
    stationId: cleanStarredText(stationId, SONG_LOG_FIELD_LIMITS.stationId),
    source: cleanStarredText(source, SONG_LOG_FIELD_LIMITS.source),
  };
  if (!validTime(entry.starred) || songStarBlock(entry.title, entry.station)) return null;
  return Object.freeze(entry);
}

/** Saved entries, oldest first; anything else is left out. */
export function parseStarredEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value.slice(-STARRED_SONGS_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = makeStarredEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The same song: the same title (ignoring case) from the same station.
 *  Two station ids decide alone: equal is the same station, different is
 *  not. Otherwise two station names that are both given decide (ignoring
 *  case). Two songs with neither an id nor a name are the same when their
 *  titles are; any other mix is two different stations. */
export function sameStarredSong(a, b) {
  if (!a || !b || a.title.toLowerCase() !== b.title.toLowerCase()) return false;
  if (a.stationId && b.stationId) return a.stationId === b.stationId;
  if (a.station && b.station) return a.station.toLowerCase() === b.station.toLowerCase();
  return !a.stationId && !b.stationId && !a.station && !b.station;
}

/** The search address for `title` on `search` (one of SONG_SEARCHES). */
export function songSearchUrl(search, title) {
  const text = cleanStarredText(title, SONG_LOG_FIELD_LIMITS.title);
  return `${search.base}${encodeURIComponent(text)}`;
}

function nativeAvailable() {
  return /^https?:/.test(globalThis.location?.protocol || '');
}

function sendWithTimeout(request, path, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = globalThis.setTimeout?.(() => {
      controller?.abort();
      reject(new Error('Saving the starred songs took too long.'));
    }, timeoutMs) ?? null;
  });
  const sent = Promise.resolve().then(() => request(path, {
    ...options, ...(controller ? { signal: controller.signal } : {}),
  }));
  return Promise.race([sent, timedOut]).finally(() => {
    if (timer !== null) globalThis.clearTimeout?.(timer);
  });
}

export function createStarredSongs({
  request = controlRequest,
  now = () => Date.now(),
  native,
  timeoutMs = STARRED_SONGS_REQUEST_TIMEOUT_MS,
  onSaveFailed = () => reportPersistenceFailure('starred-songs', STARRED_SAVE_FAILED),
  onSaved = () => clearPersistenceFailure('starred-songs'),
} = {}) {
  // The list as last known from the data folder, this page's changes since
  // then (oldest first: { kind: 'star', entry } | { kind: 'unstar', song } |
  // { kind: 'clear' }), and the two together, which is what is shown.
  let base = [];
  let ops = [];
  let entries = [];
  const listeners = new Set();
  let started = false;
  let readState = 'unread';
  let reading = null;
  let inFlight = null;
  let queued = null;
  // How many of the first ops the write in flight sent: those keep their
  // meaning and are never compacted.
  let sending = 0;
  let revision = 0;
  let unreadable = false;

  const useNative = () => started && (native ?? (request !== controlRequest || nativeAvailable()));

  function notify() {
    const snapshot = entries.slice();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (_) { /* one listener never stops another */ }
    }
  }

  /** `list` with `changes` applied, at most the limit (the oldest go
   *  first). Songs starred here follow the known list, in the order starred. */
  function applyOps(list, changes) {
    let next = list.slice();
    for (const op of changes) {
      if (op.kind === 'clear') next = [];
      else if (op.kind === 'unstar') next = next.filter((entry) => !sameStarredSong(entry, op.song));
      else if (op.kind === 'star' && !next.some((entry) => sameStarredSong(entry, op.entry))) next.push(op.entry);
    }
    return next.length > STARRED_SONGS_LIMIT ? next.slice(-STARRED_SONGS_LIMIT) : next;
  }

  function sameList(a, b) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }

  /** Show the known list with this page's changes; tell listeners when it changed. */
  function rebuild() {
    const next = applyOps(base, ops);
    if (sameList(next, entries)) return false;
    entries = next;
    notify();
    return true;
  }

  const songOf = (op) => (op.kind === 'star' ? op.entry : op.song);

  /** Merge the last change into the ones before it that are not being sent:
   *  a clear drops everything before it; a star and a later unstar of the
   *  same song cancel out (the unstar stays when the saved list has the song
   *  or is not read yet); of repeated changes to one song only the last
   *  counts; and the oldest stars beyond the limit, which would be dropped
   *  anyway, go. One pass over the waiting changes. */
  function mergeLast() {
    const op = ops[ops.length - 1];
    if (!op || ops.length - 1 < sending) return;
    if (op.kind === 'clear') {
      ops = ops.slice(0, sending).concat(op);
      return;
    }
    const song = songOf(op);
    let earlier = -1;
    let cleared = false;
    let stars = 0;
    for (let index = sending; index < ops.length - 1; index += 1) {
      const other = ops[index];
      if (other.kind === 'clear') { cleared = true; continue; }
      if (other.kind === 'star') stars += 1;
      if (earlier < 0 && sameStarredSong(songOf(other), song)) earlier = index;
    }
    const cancelled = earlier >= 0 && ops[earlier].kind === 'star' && op.kind === 'unstar';
    if (earlier >= 0) {
      if (ops[earlier].kind === 'star') stars -= 1;
      ops.splice(earlier, 1);
    }
    const known = readState === 'known';
    if (cancelled && (cleared || (known && !base.some((entry) => sameStarredSong(entry, song))))) {
      ops.pop();
      return;
    }
    if (op.kind === 'star' && stars + 1 > STARRED_SONGS_LIMIT) {
      const oldest = ops.findIndex((other, index) => index >= sending && other.kind === 'star');
      if (oldest >= 0 && oldest < ops.length - 1) ops.splice(oldest, 1);
    }
  }

  /** The same for every waiting change (after a write, when the ones it
   *  sent are no longer held back). So the list stays bounded however long
   *  saving fails. */
  function compact() {
    const waiting = ops.slice(sending);
    ops = ops.slice(0, sending);
    for (const op of waiting) {
      ops.push(op);
      mergeLast();
    }
  }

  function change(op) {
    ops.push(op);
    mergeLast();
    rebuild();
  }

  async function writeOnce() {
    try {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        const next = revision + 1;
        const sentOps = ops.length;
        const sent = applyOps(base, ops);
        sending = sentOps;
        let result;
        try {
          result = await sendWithTimeout(request, STARRED_SONGS_ROUTE, {
            method: 'POST', body: { revision: next, entries: sent.slice() },
          }, timeoutMs);
        } finally {
          sending = 0;
          // Changes made while it was on its way can now merge with it.
          compact();
        }
        if (result?.saved === true) {
          revision = Math.max(next, safeRevision(result.revision));
          // What was sent is what is stored; changes made since still wait.
          base = sent;
          ops = ops.slice(sentOps);
          rebuild();
          onSaved();
          return;
        }
        if (result?.stale !== true) throw new Error('The answer to saving the starred songs was not understood.');
        revision = safeRevision(result?.revision);
        // What is stored now, with this page's changes made again on top.
        base = parseStarredEntries(result?.entries);
        rebuild();
      }
      throw new Error('The starred songs kept changing in another window, so they were not saved.');
    } catch (error) {
      onSaveFailed(error);
      throw error;
    }
  }

  function persist() {
    if (!useNative()) return Promise.resolve(false);
    if (readState !== 'known') {
      return read().then(() => {
        if (readState === 'known') return persist();
        const error = new Error('The saved starred songs could not be read, so they were not changed.');
        onSaveFailed(error);
        throw error;
      });
    }
    if (!inFlight) {
      inFlight = writeOnce().then(() => true).finally(() => {
        inFlight = null;
        if (queued) {
          const next = queued;
          queued = null;
          persist().then(next.resolve, next.reject);
        }
      });
      return inFlight;
    }
    if (!queued) {
      let resolve;
      let reject;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      queued = { promise, resolve, reject };
    }
    return queued.promise;
  }

  function read() {
    if (!useNative() || readState === 'known') return Promise.resolve();
    if (reading) return reading;
    readState = 'reading';
    reading = sendWithTimeout(request, STARRED_SONGS_ROUTE, {}, timeoutMs).then((data) => {
      if (readState === 'known') return;
      revision = safeRevision(data?.revision);
      unreadable = unreadable || data?.unreadable === true;
      readState = 'known';
      // Stars, unstars and a clear made while reading apply to the saved list.
      base = parseStarredEntries(data?.entries);
      if (!rebuild()) notify();
    }, () => {
      if (readState === 'reading') readState = 'unread';
    }).finally(() => { reading = null; });
    return reading;
  }

  function find(song) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (sameStarredSong(entries[index], song)) return entries[index];
    }
    return null;
  }

  /** The starred entry for { title, station, stationId }, or null. */
  function starredFor(song) {
    const probe = {
      title: cleanStarredText(song?.title, SONG_LOG_FIELD_LIMITS.title),
      station: cleanStarredText(song?.station, SONG_LOG_FIELD_LIMITS.station),
      stationId: cleanStarredText(song?.stationId, SONG_LOG_FIELD_LIMITS.stationId),
    };
    return probe.title ? find(probe) : null;
  }

  /** Unstar a song shown in the list: every saved copy of the same song goes,
   *  here and, once written, in the data folder. */
  function remove(entry) {
    if (!entries.includes(entry)) return Promise.resolve(false);
    change({ kind: 'unstar', song: entry });
    return persist();
  }

  return {
    start() {
      if (started) return;
      started = true;
      void read();
    },
    load: () => read(),
    get readNotice() { return unreadable ? STARRED_UNREADABLE_NOTICE : ''; },
    /** Oldest first. */
    entries: () => entries.slice(),
    get size() { return entries.length; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    starredFor,
    /** Star a song ({ title, station, stationId, source }). Resolves to
     *  { entry, added, dropped } (dropped: the oldest song, when the list was
     *  full), or { entry: null, reason } when it cannot be starred. */
    star(song) {
      const entry = makeStarredEntry({ ...song, starred: now() });
      if (!entry) return { entry: null, added: false, reason: NOT_A_SONG, saved: Promise.resolve(false) };
      const existing = find(entry);
      if (existing) return { entry: existing, added: false, dropped: null, saved: Promise.resolve(true) };
      const dropped = entries.length >= STARRED_SONGS_LIMIT ? entries[0] : null;
      change({ kind: 'star', entry });
      const saved = persist();
      saved.catch(() => { /* reported through onSaveFailed; retried with the next change */ });
      return { entry, added: true, dropped, saved };
    },
    /** Unstar one entry (by identity). */
    unstar: remove,
    /** Star the song when it is not starred, else unstar it. */
    toggle(song) {
      const existing = starredFor(song);
      if (existing) {
        const saved = remove(existing);
        saved.catch(() => {});
        return { entry: existing, starred: false, saved };
      }
      const result = this.star(song);
      return { ...result, starred: Boolean(result.entry) };
    },
    /** Remove every starred song (Clear cache), here and in the data folder. */
    clear() {
      // A clear is an operation like the others, so a stale answer cannot
      // bring back songs saved elsewhere: the list written again is empty
      // apart from songs starred here after the clear.
      const op = { kind: 'clear' };
      change(op);
      return persist().then(() => true, (error) => {
        // Not saved: the songs come back, as Clear cache reports the failure.
        const at = ops.indexOf(op);
        if (at >= 0) {
          ops = ops.slice(0, at).concat(ops.slice(at + 1));
          rebuild();
        }
        throw error;
      });
    },
    flush: () => queued?.promise || inFlight || Promise.resolve(true),
    /** How many changes wait to be saved. */
    get pending() { return ops.length; },
  };
}

/** The app's starred songs. main.js starts them; Clear cache clears them. */
export const starredSongs = createStarredSongs();

/** Ask the backend to write the entries (newest first) as a .txt or .csv file
 *  in the downloads folder; resolves to { name, count }. */
export function exportStarredSongs(format, entriesNewestFirst, options = {}) {
  const body = {
    format,
    entries: entriesNewestFirst.map(({ starred, title, station, stationId, source }) => ({
      starred, title, station, stationId, source,
    })),
  };
  return controlRequest(STARRED_SONGS_EXPORT_ROUTE, { ...options, method: 'POST', body });
}
