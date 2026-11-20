/**
 * "Pick the best stream: Auto (verified)" in use (stream-verify.js has the
 * checks). It never delays a start and never cuts what is playing:
 *  - A station always starts on its own stream, unless a better entry of it
 *    was verified before (then that entry is offered first, and the own
 *    stream stays the fallback; if the entry does not play, it is not tried
 *    or checked again for a day).
 *  - Once a station has played for VERIFY_AFTER_MS with a song title, one
 *    check runs in the background. A first match is only pending; a second
 *    check, MIN_MATCH_GAP_MS later in the same listening (or at a later
 *    play), must match again on a different song. At most
 *    MAX_PROBES_PER_WEEK checks per station a week, one at a time. The
 *    result is used from the next start of that station.
 * Everything belongs to one playback session (scheduleCheck, planned at the
 * first `playing` of a start and again after a pause): pause, stop, another
 * station, the setting changed to Listed streams or Off, and closing the app
 * cancel its timer and abort a check on its way (the local server closes its
 * sockets); a result that arrives for an ended session is dropped, not
 * remembered. Nothing polls, and nothing here touches the audio.
 */

import { bestStreamAutoOn } from './best-stream.js';
import { controlRequest } from './capture-client.js';
import { playedStream } from './media-failover.js';
import { stationId, underOwnName } from './other-streams.js';
import { loadAdapter } from './sources.js';
import {
  MAX_PROBES_PER_WEEK, MIN_MATCH_GAP_MS, failVerification, keepsOwnStream, noteProbe, probesThisWeek,
  sourceVeto, storedVerification, storeVerification, streamCheck,
} from './stream-verify.js';

// The directory search of a background check (betterStationStreams): it never
// delays a start, so it may take longer than a lookup before playing would.
export const CHECK_LOOKUP_MS = 20_000;

export const VERIFY_AFTER_MS = 45_000;
export const STREAM_PROBE_ROUTE = '/api/v1/streams/probe';
const RADIO_BROWSER = 'radio-browser';

let session = null; // { itemId, controller, timer, clear }
let running = false;
const listeners = new Set();

/** Call `fn` whenever what Auto knows or plans may have changed (a check
 *  planned, ended or finished; a verified stream that did not play).
 *  Returns the function that stops it. Nothing polls. */
export function onBestStreamChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  for (const fn of [...listeners]) {
    try { fn(); } catch (_) { /* one listener does not stop the rest */ }
  }
}

/** True while a check of the station with item id `itemId` is planned or
 *  running in the current playback session. */
export function checkPlannedFor(itemId) {
  return Boolean(itemId) && session?.itemId === itemId;
}

/** The station id Auto works with, or '' (not a Radio Browser station, or
 *  the user chose its own stream, or Auto is off). */
function autoStation(item, settings) {
  if (!bestStreamAutoOn(settings) || item?.source !== RADIO_BROWSER) return '';
  const id = stationId(item);
  return id && !keepsOwnStream(id) ? id : '';
}

/** The verified better stream to offer first when `item` starts, or null. */
export function verifiedStreamFor(item, settings, now = Date.now()) {
  const id = autoStation(item, settings);
  const found = id ? storedVerification(id, now) : null;
  return found?.ok ? found.alt : null;
}

/** After a start: true when it plays on the verified stream `alt`. When
 *  that was offered and something else plays, it failed: it is not tried or
 *  checked again for a day. */
export function afterStart(item, alt, now = Date.now()) {
  if (!alt) return false;
  if (playedStream(item)?.url === alt.url) return true;
  failVerification(stationId(item), now);
  changed();
  return false;
}

/** End the current session: its timer is cleared and a check on its way is
 *  aborted (pause, stop, another station, the app closing). */
export function cancelScheduledCheck() {
  const ending = session;
  session = null;
  if (!ending) return;
  // Called on its own, never as a method of the session: a browser's
  // clearTimeout throws "Illegal invocation" when `this` is another object.
  const { clear, timer } = ending;
  ending.timer = null;
  if (timer !== null) clear(timer);
  if (!ending.controller.signal.aborted) ending.controller.abort();
  changed();
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', cancelScheduledCheck);
}

/** The settings changed: with Auto no longer chosen, the session ends.
 *  Returns true when one was ended. */
export function followBestStreamSetting(settings) {
  if (bestStreamAutoOn(settings) || !session) return false;
  cancelScheduledCheck();
  return true;
}

/** A verified stream connected but never played: it is not offered or
 *  checked again for a day (as when it does not connect). */
export function verifiedDidNotPlay(item, now = Date.now()) {
  const done = failVerification(stationId(item), now);
  changed();
  return done;
}

/** When the next check of station `id` may run (ms from now), or -1 when
 *  none should. */
function nextCheckIn(id, now) {
  if (probesThisWeek(id, now) >= MAX_PROBES_PER_WEEK) return -1;
  const found = storedVerification(id, now);
  if (found === null) return VERIFY_AFTER_MS;
  if (found.pending) return Math.max(VERIFY_AFTER_MS, found.at + MIN_MATCH_GAP_MS - now);
  return -1;
}

/** Plan the background check for `item`, which has just started; a new
 *  playback session. Returns true when a check is planned. */
export function scheduleCheck(item, {
  settings, current, nowPlaying, setTimer = setTimeout, clear = clearTimeout, run = verifyStation, now = Date.now,
} = {}) {
  cancelScheduledCheck();
  const id = autoStation(item, settings);
  if (!id) return false;
  const mine = { itemId: item.id, controller: new AbortController(), timer: null, clear };
  const plan = () => {
    const wait = nextCheckIn(id, now());
    if (wait < 0 || session !== mine) return false;
    mine.timer = setTimer(fire, wait);
    return true;
  };
  const fire = () => {
    mine.timer = null;
    if (session !== mine || current?.()?.id !== item.id) return;
    const song = nowPlaying?.();
    const title = song?.itemId === item.id ? song.title : '';
    if (!title) {
      // No song title on the station's own stream: nothing to compare.
      storeVerification(id, { reason: 'noTitles' }, now());
      changed();
      return;
    }
    Promise.resolve(run(item, { signal: mine.controller.signal, now })).then((result) => {
      // A first match: check again on another song, in this session.
      if (result?.pending) plan();
    }).catch(() => {}).then(() => { if (session === mine) changed(); });
  };
  session = mine;
  if (plan()) {
    changed();
    return true;
  }
  session = null;
  return false;
}

/** Playback of `item` resumed (or started playing): a new session with its
 *  own wait, unless one is already planned for it. A pause ended the last
 *  one, so after a resume the check again waits VERIFY_AFTER_MS of play. */
export function resumeCheck(item, options = {}) {
  if (!item?.id || session?.itemId === item.id) return false;
  return scheduleCheck(item, options);
}

/** Ask the local server to probe both streams briefly (one probe at a time). */
export function probeStreams(ownUrl, altUrl, options = {}) {
  return controlRequest(STREAM_PROBE_ROUTE, { ...options, method: 'POST', body: { own_url: ownUrl, alt_url: altUrl } });
}

/** Check `item`'s best other entry and remember the result. Resolves to
 *  { ok: true, alt }, { pending: true } (a first match), { ok: false,
 *  reason }, or null when nothing was done (a check already running, the
 *  weekly limit, or the session ended: then nothing is remembered). */
export async function verifyStation(item, {
  adapter = null, probe = probeStreams, now = Date.now, signal = null,
} = {}) {
  if (running) return null;
  // A renamed favorite is checked under the station's own name (the probe
  // compares station names; the user's name is only shown).
  item = underOwnName(item);
  const id = stationId(item);
  if (!id || probesThisWeek(id, now()) >= MAX_PROBES_PER_WEEK) return null;
  running = true;
  const ended = () => signal?.aborted === true;
  try {
    const source = adapter || await loadAdapter(RADIO_BROWSER);
    if (ended()) return null;
    const own = {
      url: item.stream_url, kind: item.stream_kind, bitrate: item._extra?.bitrate, codec: item._extra?.codec,
      title: item.title,
    };
    let candidates;
    try {
      candidates = await source.betterStationStreams(item, { timeoutMs: CHECK_LOOKUP_MS, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (ended()) return null;
      // The directory did not answer (too slow, down, cancelled): not a
      // finding about the station. Tried again after a short wait.
      storeVerification(id, { reason: 'lookupFailed' }, now());
      return { ok: false, reason: 'lookupFailed' };
    }
    if (ended()) return null;
    const passing = (Array.isArray(candidates) ? candidates : []).filter((stream) => sourceVeto(own, stream, now()) === null);
    const before = storedVerification(id, now());
    const pending = before?.pending ? before : null;
    const alt = (pending && passing.find((stream) => stream.url === pending.alt.url)) || passing[0];
    if (!alt) {
      storeVerification(id, { reason: 'noCandidate' }, now());
      return { ok: false, reason: 'noCandidate' };
    }
    noteProbe(id, now());
    const facts = await probe(own.url, alt.url, signal ? { signal } : {});
    if (ended()) return null;
    const { song, reason } = streamCheck(own, alt, facts?.own, facts?.alt);
    if (reason) {
      storeVerification(id, { reason }, now());
      return { ok: false, reason };
    }
    if (pending && pending.alt.url === alt.url && pending.song !== song && now() - pending.at >= MIN_MATCH_GAP_MS) {
      storeVerification(id, { alt }, now());
      return { ok: true, alt };
    }
    // The first match, or the same song again: still pending.
    if (!pending || pending.alt.url !== alt.url) storeVerification(id, { alt, pending: true, song }, now());
    return { ok: false, pending: true };
  } catch (_) {
    if (ended()) return null;
    storeVerification(id, { reason: 'failed' }, now());
    return { ok: false, reason: 'failed' };
  } finally {
    running = false;
  }
}
