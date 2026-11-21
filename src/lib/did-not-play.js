/**
 * "Did not play last time": for each item, when the last start the user asked
 * for did not play. A start fails when every stream it tried failed, or when
 * it never began within the start time limit (the player's limit for a live
 * stream, START_FAILOVER_MS, counted from the moment its stream was set up),
 * once no other stream of the station is left to try. One result per start.
 * A start that plays for a second clears the mark. A Stop, a pause, another
 * station chosen before the result, the browser refusing to start sound
 * without a click, or the app closing is no result at all.
 *
 * A station is marked unless the connection, not the station, is at fault:
 *  - nothing is marked while the browser says it is offline;
 *  - a name lookup that could not be carried out at all is the connection's
 *    fault;
 *  - a station that could not be reached at all (no answer, no data, or a
 *    host name that does not exist) is
 *    marked when something outside answered within the last minute, or when
 *    a small check says the connection works (connection-evidence.js). Until
 *    the check answers the result waits; when the check fails, or the browser
 *    goes offline first, it is dropped unmarked. A waiting result is also
 *    dropped when that station answers or plays, when the cache is cleared,
 *    or after HELD_MAX_MS (at most MAX_HELD wait). Choosing another station
 *    or Stop after the failure leaves it waiting.
 *
 * Kept in browser storage under DID_NOT_PLAY_KEY as a cache: at most
 * MAX_DID_NOT_PLAY items (the oldest go first), not in the profile files or
 * backups, and Clear cache removes it. Marking never delays or blocks a play.
 */

import {
  ANSWER_FRESH_MS, confirmConnection, connectionKnownDown, lastOutsideAnswerAt, noteOutsideAnswer, onOutsideAnswer,
} from './connection-evidence.js';

export const DID_NOT_PLAY_KEY = 'worldmedia.didnotplay.v1';
export const MAX_DID_NOT_PLAY = 2_000;
// Results waiting for word on the connection: at most this many, for at most
// this long; then they are dropped unmarked.
export const MAX_HELD = 50;
export const HELD_MAX_MS = 2 * 60_000;
const MAX_ID_LENGTH = 512;

// Failures where no server answered at all (a connection refused or cut, no
// data in time): the station, or the connection, may be at fault.
const NETWORK_CODES = new Set(['MEDIA_CONNECT_FAILED', 'MEDIA_IDLE_TIMEOUT']);
// The name lookup itself could not be carried out: the connection's fault.
const LOOKUP_CODES = new Set(['MEDIA_DNS_FAILED']);
// The name server said the station's host name does not exist (the station's
// fault, unless every name is said not to exist because the system is offline).
const MISSING_NAME = 'MEDIA_HOST_NOT_FOUND';
// Refusals by the app itself (its relay is full, its session ended): never
// the station's fault.
const APP_CODES = new Set([
  'MEDIA_REGISTRY_FULL', 'INVALID_TOKEN', 'RATE_LIMITED', 'INVALID_ORIGIN', 'ORIGIN_REQUIRED', 'INVALID_HOST',
  'CONTENT_RATING_BLOCKED',
]);

let entries = null; // id -> time it did not play, oldest first
const listeners = new Set();

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const parsed = JSON.parse(storage()?.getItem(DID_NOT_PLAY_KEY) || 'null');
    if (parsed?.version === 1 && Array.isArray(parsed.items)) {
      for (const entry of parsed.items.slice(-MAX_DID_NOT_PLAY)) {
        const [id, at] = Array.isArray(entry) ? entry : [];
        if (validId(id) && Number.isFinite(at) && at > 0) {
          entries.delete(id);
          entries.set(id, at);
        }
      }
    }
  } catch (_) { /* an unreadable cache is an empty one */ }
  return entries;
}

function save() {
  try {
    storage()?.setItem(DID_NOT_PLAY_KEY, JSON.stringify({ version: 1, items: [...entries] }));
  } catch (_) { /* a cache that cannot be written is simply not kept */ }
}

function notify(id) {
  for (const listener of [...listeners]) {
    try { listener(id); } catch (error) { console.error('did-not-play listener threw:', error); }
  }
}

/** When the last start of item `id` did not play (ms since 1970), or 0. */
export function didNotPlayAt(id) {
  return validId(id) ? load().get(id) || 0 : 0;
}

/** Remember that item `id` did not play at time `at`. */
export function markDidNotPlay(id, at = Date.now()) {
  if (!validId(id) || !Number.isFinite(at) || at <= 0) return false;
  const all = load();
  if (all.get(id) === at) return false;
  all.delete(id);
  all.set(id, at);
  while (all.size > MAX_DID_NOT_PLAY) all.delete(all.keys().next().value);
  save();
  notify(id);
  return true;
}

/** Forget the mark of item `id` (it played). */
export function clearDidNotPlay(id) {
  if (!validId(id) || !load().has(id)) return false;
  entries.delete(id);
  save();
  notify(id);
  return true;
}

// Counts Clear cache: a result decided from a start or a check from before it
// is never written after it.
let cacheGeneration = 0;
const cacheClearHooks = new Set();

/** Clear cache: every mark goes, and so does every result still waiting. */
export function clearDidNotPlayCache() {
  cacheGeneration += 1;
  for (const hook of [...cacheClearHooks]) {
    try { hook(); } catch (error) { console.error('did-not-play cache hook threw:', error); }
  }
  const had = load().size > 0;
  entries = new Map();
  try { storage()?.removeItem(DID_NOT_PLAY_KEY); } catch (_) { /* nothing stored */ }
  if (had) notify('');
}

/** Called with the item id (or '' for all) whenever a mark changes. */
export function onDidNotPlayChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests: read the stored marks again. */
export function forgetLoadedDidNotPlay() {
  entries = null;
}

function shownDate(at) {
  try {
    return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The sentence shown on the mark, its tooltip and the details panel. */
export function didNotPlayText(at, { formatDate = shownDate } = {}) {
  if (!Number.isFinite(at) || at <= 0) return '';
  return `Did not play last time (${formatDate(at)}). It is tried again when you play it.`;
}

/** What kind of failure ended a start:
 *   'app'          the app's own limit, a stop, or the app's local server not
 *                  answering: never marked;
 *   'lookup'       a name lookup could not be carried out: the connection's
 *                  fault, never marked;
 *   'unreachable'  no server answered at all, or the station's host name
 *                  does not exist: marked when the connection is shown to
 *                  work;
 *   'refused'      a server answered, or the station's data has no usable
 *                  stream: marked. */
export function startFailureKind(error) {
  if (!error) return 'refused';
  if (error.name === 'AbortError') return 'app';
  const nested = Array.isArray(error.errors) && error.errors.length > 0 ? error.errors : [error];
  const codes = nested.map((entry) => (typeof entry?.code === 'string' ? entry.code : ''));
  if (codes.some((code) => APP_CODES.has(code)) || APP_CODES.has(error.code)) return 'app';
  const aborted = (entry) => entry?.name === 'AbortError';
  // No code and no time limit: the request never reached the app's server.
  if (nested.every((entry, index) => !codes[index] && !aborted(entry))) return 'app';
  // A directory request through the local proxy that timed out or got the
  // proxy's own error status heard nothing from outside either.
  // A host name that does not exist is the station's fault, but some systems
  // say so for every name while offline: it is judged like no answer.
  const silent = (entry, code) => NETWORK_CODES.has(code) || LOOKUP_CODES.has(code) || code === MISSING_NAME
    || code === 'TIMEOUT' || (code === 'HTTP_STATUS' && Number(entry?.status) >= 500);
  const answered = nested.some((entry, index) => codes[index] && !aborted(entry) && !silent(entry, codes[index]));
  if (answered) return 'refused';
  return codes.some((code) => LOOKUP_CODES.has(code)) ? 'lookup' : 'unreachable';
}

function backgroundTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  try { timer?.unref?.(); } catch (_) { /* a browser timer is a number */ }
  return timer;
}

const defaultConnection = {
  lastAnswerAt: lastOutsideAnswerAt,
  knownDown: connectionKnownDown,
  confirm: () => confirmConnection(),
  noteAnswer: noteOutsideAnswer,
  onAnswer: onOutsideAnswer,
};

function windowOffline(listener) {
  const target = globalThis.window;
  if (typeof target?.addEventListener !== 'function') return () => {};
  target.addEventListener('offline', listener);
  return () => target.removeEventListener?.('offline', listener);
}

/**
 * The result of the start the user asked for, one at a time.
 *   begin(id)          a start of item `id` (another start before ends it)
 *   streamSetUp(id)    a stream of it was set up: the start time limit
 *                      (`limitMs`) runs from now. Past it, once no other
 *                      stream is left to hand over to (`handingOver`), that
 *                      is its result; it is cleared again if it then plays
 *   answered(id)       its stream really answered (the relay tested it, or
 *                      the media element received data)
 *   played(id)         item `id` played a second: its mark goes
 *   failed(id, kind)   every stream failed or the player gave up; `kind` from
 *                      startFailureKind, or 'stream' for a stream the player
 *                      gave up on (unreachable unless it had answered)
 *   cancel(id)         no result (Stop, a pause, the start was blocked)
 * `connection` says whether the connection works (connection-evidence.js).
 */
export function createStartOutcome({
  store = { mark: markDidNotPlay, clear: clearDidNotPlay, get: didNotPlayAt },
  isOffline = () => globalThis.navigator?.onLine === false,
  onOffline = windowOffline,
  now = () => Date.now(),
  setTimer = backgroundTimer,
  clearTimer = (handle) => clearTimeout(handle),
  limitMs = 30_000,
  handingOver = () => false,
  connection = defaultConnection,
  freshMs = ANSWER_FRESH_MS,
  heldMax = MAX_HELD,
  heldMaxMs = HELD_MAX_MS,
} = {}) {
  let attempt = null;
  // Stations that could not be reached, waiting for word on the connection:
  // { id, at, generation }, oldest first, at most heldMax, none older than
  // heldMaxMs. While any wait, the outcome listens for an outside answer,
  // going offline and Clear cache, and a timer drops the ones too old.
  let held = [];
  let stopListening = null;
  let ageTimer = null;

  const stopTimer = () => {
    if (attempt?.timer != null) clearTimer(attempt.timer);
    if (attempt) attempt.timer = null;
  };
  const end = () => {
    stopTimer();
    attempt = null;
  };
  const mine = (id) => Boolean(attempt && id && attempt.id === id);
  const current = (entry) => entry.generation === cacheGeneration && now() - entry.at < heldMaxMs;
  const write = (id, at, generation) => (generation === cacheGeneration ? store.mark(id, at) !== false : false);

  /** Nothing waits any more: no listener and no timer is left behind. */
  function detachIfEmpty() {
    if (held.length) return;
    stopListening?.();
    stopListening = null;
    if (ageTimer != null) clearTimer(ageTimer);
    ageTimer = null;
  }

  function dropHeld(predicate) {
    held = held.filter((entry) => !predicate(entry));
    detachIfEmpty();
  }

  /** Drop the results that waited too long, and look again when the next
   *  one would be. */
  function scheduleAge() {
    if (ageTimer != null) clearTimer(ageTimer);
    ageTimer = null;
    if (!held.length) return;
    const wait = Math.max(0, held[0].at + heldMaxMs - now());
    ageTimer = setTimer(() => {
      ageTimer = null;
      dropHeld((entry) => !current(entry));
      scheduleAge();
    }, wait);
  }

  function settleHeld(connectionWorks) {
    const waiting = held.filter(current);
    held = [];
    detachIfEmpty();
    if (!connectionWorks || isOffline()) return;
    for (const entry of waiting) write(entry.id, entry.at, entry.generation);
  }

  function hold(id, at, generation) {
    held = held.filter((entry) => entry.id !== id && current(entry));
    held.push({ id, at, generation });
    while (held.length > heldMax) held.shift();
    if (!stopListening) {
      const offAnswer = connection.onAnswer(() => settleHeld(true));
      const offOffline = onOffline(() => settleHeld(false));
      const offClear = () => dropHeld(() => true);
      cacheClearHooks.add(offClear);
      stopListening = () => { offAnswer(); offOffline(); cacheClearHooks.delete(offClear); };
    }
    scheduleAge();
    Promise.resolve()
      .then(() => connection.confirm())
      .then((works) => { if (held.length) settleHeld(works === true); }, () => settleHeld(false));
  }

  /** Mark `id` unless the connection, not the station, is at fault, or the
   *  cache was cleared since the start (`generation`). */
  function decide(id, kind, generation) {
    if (kind === 'app' || kind === 'lookup' || isOffline() || generation !== cacheGeneration) return false;
    const at = now();
    if (kind === 'refused') return write(id, at, generation);
    if (connection.knownDown(at)) return false;
    if (at - connection.lastAnswerAt() <= freshMs) return write(id, at, generation);
    hold(id, at, generation);
    return false;
  }

  return {
    begin(id) {
      end();
      if (typeof id === 'string' && id) {
        attempt = { id, timer: null, answered: false, decided: false, generation: cacheGeneration };
      }
    },
    streamSetUp(id) {
      if (!mine(id) || attempt.decided) return;
      const running = attempt;
      stopTimer();
      running.timer = setTimer(() => {
        if (attempt !== running) return;
        running.timer = null;
        // Another stream gets its turn now; its own start time limit follows.
        if (handingOver()) return;
        running.decided = true;
        decide(running.id, running.answered ? 'refused' : 'unreachable', running.generation);
      }, limitMs);
    },
    /** Another stream of the start takes over: no result until it is set up. */
    handOver(id) {
      if (mine(id)) stopTimer();
    },
    answered(id) {
      // The station answers now: an earlier failure of it is out of date.
      if (id) dropHeld((entry) => entry.id === id);
      connection.noteAnswer(now());
      if (mine(id)) attempt.answered = true;
    },
    played(id) {
      if (!id) return;
      // Before the answer is noted, so its own earlier failure is not marked.
      dropHeld((entry) => entry.id === id);
      connection.noteAnswer(now());
      if (store.get(id)) store.clear(id);
      if (mine(id)) end();
    },
    failed(id, kind = 'refused') {
      if (!mine(id)) return false;
      const { answered, decided, generation } = attempt;
      end();
      // One result per start: a start already judged at its time limit.
      if (decided) return false;
      let shown = kind;
      if (kind === 'stream') shown = answered ? 'refused' : 'unreachable';
      else if (answered && kind === 'unreachable') shown = 'refused';
      return decide(id, shown, generation);
    },
    /** No result for the start in progress. A result already waiting for
     *  the check stays: Stop after a failure, or another station, does not
     *  undo it. */
    cancel(id = '') {
      if (!id || mine(id)) end();
    },
    get active() { return attempt !== null; },
    /** Tests: the stations waiting for word on the connection. */
    get held() { return held.map((entry) => entry.id); },
    /** Tests: something still listens or waits for the held results. */
    get listening() { return stopListening !== null || ageTimer != null; },
  };
}
