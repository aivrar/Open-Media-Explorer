/**
 * Song log: the songs radio stations announced while you listened.
 *
 * Listens for NOW_PLAYING_EVENT (now-playing.js) and keeps the newest
 * SONG_LOG_LIMIT songs, oldest first, as plain data:
 *   { time, station, stationId, source, title }
 *
 * Where it is kept: in the native data folder (state/song-log.json, through
 * /api/v1/song-log), not in localStorage or the mirrored profile. World Media
 * 0.1.8 and older ignore a whole profile file (favorites included) when it
 * holds a key they do not know, so the log must never be a profile key; the
 * file also stays the same across a port change and is copied into backups.
 *
 * Every write sends the whole log (at most 500 short entries) with a revision
 * one higher than the last one this page saw. The server applies a write only
 * when its revision is newer than the stored one, so a request that arrives
 * late (after a timeout, say) can never undo a newer write or a clear. A write
 * that was not newer is answered with what is stored: songs this page has
 * never seen (logged by another window) are merged in and the write is sent
 * again. Songs this page removed or cleared stay removed. One write is in
 * flight at a time; changes made meanwhile are sent together by the next one.
 *
 * Nothing is written before the saved log has been read. When it cannot be
 * read right now, the read is tried again later. When it cannot be understood,
 * the server reports it and moves the file aside before the first write, and
 * readNotice says so.
 */

import { controlRequest } from './capture-client.js';
import { NOW_PLAYING_EVENT } from './now-playing.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';

export const SONG_LOG_ROUTE = '/api/v1/song-log';
export const SONG_LOG_EXPORT_ROUTE = '/api/v1/song-log/export';
export const SONG_LOG_LIMIT = 500;
/** Longest text per field, in characters; the backend enforces the same. */
export const SONG_LOG_FIELD_LIMITS = Object.freeze({ title: 200, station: 200, stationId: 300, source: 64 });
export const SONG_LOG_REQUEST_TIMEOUT_MS = 10_000;
export const SONG_LOG_SAVE_FAILED = 'The song log could not be saved. New songs stay in the list and are saved again with the next song.';
export const SONG_LOG_UNREADABLE_NOTICE = 'The saved song log could not be read, so a new one was started. The old file was kept in the data folder.';
const MAX_TIME_MS = 32_503_680_000_000; // 3000-01-01, as in worldmedia_songlog.py
// Merges in a row before a save gives up (another window keeps writing).
const MAX_SAVE_ATTEMPTS = 5;

function songKey(entry) {
  return JSON.stringify([entry.time, entry.stationId, entry.title]);
}

function safeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One plain line of at most `limit` characters (code points). */
export function cleanSongLogText(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.replace(LONE_SURROGATES, '\uFFFD').replace(CONTROL_CHARACTERS, ' ')
    .replace(INVISIBLE_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, limit).join('').trim();
}

function validTime(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIME_MS;
}

/** A frozen entry of plain strings, or null when there is no song title. */
export function makeSongLogEntry({ time, station, stationId, source, title } = {}) {
  const entry = {
    time: Number.isFinite(time) ? Math.round(time) : NaN,
    station: cleanSongLogText(station, SONG_LOG_FIELD_LIMITS.station),
    stationId: cleanSongLogText(stationId, SONG_LOG_FIELD_LIMITS.stationId),
    source: cleanSongLogText(source, SONG_LOG_FIELD_LIMITS.source),
    title: cleanSongLogText(title, SONG_LOG_FIELD_LIMITS.title),
  };
  if (!entry.title || !validTime(entry.time)) return null;
  return Object.freeze(entry);
}

/** Saved entries, oldest first; anything that is not a valid entry is left out. */
export function parseSongLogEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value.slice(-SONG_LOG_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = makeSongLogEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Same station: the same item id, or (when the station is played from
 *  somewhere else and so has another id, or has no id) the same name. */
function sameStation(a, b) {
  if (a.stationId && a.stationId === b.stationId) return true;
  return Boolean(a.station && a.station === b.station) || (!a.stationId && !b.stationId && !a.station && !b.station);
}

/** A song that is already the newest row: never logged twice in a row, also
 *  after stopping and starting the station or restarting the app. */
function sameSong(a, b) {
  return Boolean(a && b && a.title === b.title && sameStation(a, b));
}

function nativeAvailable() {
  return /^https?:/.test(globalThis.location?.protocol || '');
}

/** Send one request, giving up (and aborting it) after the timeout. */
function sendWithTimeout(request, path, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = globalThis.setTimeout?.(() => {
      controller?.abort();
      reject(new Error('The song log took too long to answer.'));
    }, timeoutMs) ?? null;
  });
  const sent = Promise.resolve().then(() => request(path, {
    ...options, ...(controller ? { signal: controller.signal } : {}),
  }));
  return Promise.race([sent, timedOut]).finally(() => {
    if (timer !== null) globalThis.clearTimeout?.(timer);
  });
}

/**
 * @param {object} options
 * @param {Function} [options.request] controlRequest-compatible
 * @param {(itemId: string) => object|null} [options.getItem] the playing item
 *   with this id ({ title, source }), or null
 * @param {boolean} [options.native] use the data folder (default: on http(s))
 */
export function createSongLog({
  request = controlRequest,
  getItem = () => null,
  now = () => Date.now(),
  native,
  timeoutMs = SONG_LOG_REQUEST_TIMEOUT_MS,
  onSaveFailed = () => reportPersistenceFailure('song-log', SONG_LOG_SAVE_FAILED),
  onSaved = () => clearPersistenceFailure('song-log'),
} = {}) {
  let entries = [];
  const listeners = new Set();
  let started = false;
  // 'unread' -> 'reading' -> 'known'. Writes wait until the saved log is known.
  let readState = 'unread';
  let reading = null;
  let generation = 0; // bumped by clear(): songs a read still on its way brings stay removed
  let inFlight = null;
  let queued = null;
  let revision = 0; // the newest revision this page knows the server has
  const seen = new Set(); // every song this page has had, so removed ones stay removed
  let unreadable = false;

  const useNative = () => started && (native ?? (request !== controlRequest || nativeAvailable()));

  function notify() {
    const snapshot = entries.slice();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (_) { /* one listener never stops another */ }
    }
  }

  function cap() {
    if (entries.length > SONG_LOG_LIMIT) entries = entries.slice(-SONG_LOG_LIMIT);
  }

  /** Merge in the stored songs this page has never had, after a stale write. */
  function reconcile(result) {
    revision = safeRevision(result?.revision);
    const theirs = parseSongLogEntries(result?.entries).filter((entry) => !seen.has(songKey(entry)));
    if (!theirs.length) return;
    for (const entry of theirs) seen.add(songKey(entry));
    entries = entries.concat(theirs).sort((a, b) => a.time - b.time);
    cap();
    notify();
  }

  async function writeOnce() {
    try {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        const next = revision + 1;
        const result = await sendWithTimeout(request, SONG_LOG_ROUTE, {
          method: 'POST', body: { revision: next, entries: entries.slice() },
        }, timeoutMs);
        if (result?.saved === true) {
          revision = Math.max(next, safeRevision(result.revision));
          onSaved();
          return;
        }
        if (result?.stale !== true) throw new Error('The answer to saving the song log was not understood.');
        reconcile(result);
      }
      throw new Error('The song log kept changing in another window, so it was not saved.');
    } catch (error) {
      // A request that timed out may still arrive; its revision is then not
      // newer than the next write's, so it cannot undo it.
      onSaveFailed(error);
      throw error;
    }
  }

  /** Resolves once a write that started after this call has finished. */
  function persist() {
    if (!useNative()) return Promise.resolve(false);
    if (readState !== 'known') {
      return read().then(() => {
        if (readState === 'known') return persist();
        const error = new Error('The saved song log could not be read, so it was not changed.');
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

  function persistQuietly() {
    persist().catch(() => { /* reported through onSaveFailed; retried with the next change */ });
  }

  /** Read the saved log once; songs added meanwhile follow it. */
  function read() {
    if (!useNative() || readState === 'known') return Promise.resolve();
    if (reading) return reading;
    readState = 'reading';
    const myGeneration = generation;
    reading = sendWithTimeout(request, SONG_LOG_ROUTE, {}, timeoutMs).then((data) => {
      if (readState === 'known') return;
      const saved = parseSongLogEntries(data?.entries);
      revision = safeRevision(data?.revision);
      unreadable = unreadable || data?.unreadable === true;
      for (const entry of saved) seen.add(songKey(entry));
      readState = 'known';
      if (myGeneration !== generation) { // cleared meanwhile: the saved songs stay removed
        notify();
        return;
      }
      // Songs logged while reading come after the saved ones; each of them
      // already has a write waiting for this read.
      const added = entries.slice();
      if (added.length && sameSong(saved[saved.length - 1], added[0])) added.shift();
      entries = saved.concat(added);
      cap();
      notify();
    }, () => {
      if (readState === 'reading') readState = 'unread'; // tried again with the next change
    }).finally(() => { reading = null; });
    return reading;
  }

  function add(entry) {
    if (!entry || sameSong(entries[entries.length - 1], entry)) return false;
    seen.add(songKey(entry));
    entries.push(entry);
    cap();
    notify();
    persistQuietly();
    return true;
  }

  /** Log the song in a NOW_PLAYING_EVENT payload. */
  function handleNowPlaying(change) {
    const itemId = typeof change?.itemId === 'string' ? change.itemId : '';
    let item = null;
    try { item = itemId ? getItem(itemId) : null; } catch (_) { item = null; }
    const time = validTime(change?.changedAt) ? change.changedAt : now();
    return add(makeSongLogEntry({
      time,
      station: typeof item?.title === 'string' ? item.title : '',
      stationId: itemId,
      source: typeof item?.source === 'string' ? item.source : '',
      title: change?.title,
    }));
  }

  return {
    /** Start listening on the state.js bus and read the saved log. */
    start(subscribe) {
      if (started) return;
      started = true;
      subscribe?.(NOW_PLAYING_EVENT, handleNowPlaying);
      void read();
    },
    handleNowPlaying,
    /** Read the saved log if it has not been read yet (e.g. it was busy). */
    load: () => read(),
    /** One plain line when the saved log could not be understood, else ''. */
    get readNotice() { return unreadable ? SONG_LOG_UNREADABLE_NOTICE : ''; },
    /** Entries oldest first (the same frozen objects until removed). */
    entries: () => entries.slice(),
    get size() { return entries.length; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Remove one entry (by identity) and save. */
    remove(entry) {
      const index = entries.indexOf(entry);
      if (index < 0) return Promise.resolve(false);
      entries = entries.slice(0, index).concat(entries.slice(index + 1));
      notify();
      return persist();
    },
    /** Empty the log here and in the data folder (a write like any other).
     *  When the saved copy could not be cleared, the songs come back into the
     *  list, so the clear can be tried again, and the promise rejects. */
    clear() {
      generation += 1;
      const myGeneration = generation;
      const removed = entries;
      entries = [];
      notify();
      return persist().then(() => true, (error) => {
        if (myGeneration === generation) {
          entries = removed.concat(entries); // songs logged since stay after them
          cap();
          notify();
        }
        throw error;
      });
    },
    /** Wait for any write still being sent. */
    flush: () => queued?.promise || inFlight || Promise.resolve(true),
  };
}

let songLogItemLookup = () => null;

/** The app's song log. main.js starts it; Clear cache clears it. */
export const songLog = createSongLog({ getItem: (itemId) => songLogItemLookup(itemId) });

/** Start the app's song log: `subscribe` is state.js's, and `getItem(itemId)`
 *  returns the playing item with that id (for its station name), or null. */
export function startSongLog(subscribe, getItem) {
  if (typeof getItem === 'function') songLogItemLookup = getItem;
  songLog.start(subscribe);
}

/** Ask the backend to write the entries (newest first) as a CSV file in the
 *  downloads folder; resolves to { name, count }. The server picks the name. */
export function exportSongLog(entriesNewestFirst, options = {}) {
  const body = {
    entries: entriesNewestFirst.map(({ time, station, stationId, source, title }) => ({
      time, station, stationId, source, title,
    })),
  };
  return controlRequest(SONG_LOG_EXPORT_ROUTE, { ...options, method: 'POST', body });
}
