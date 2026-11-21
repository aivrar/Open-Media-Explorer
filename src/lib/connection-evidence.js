/**
 * Does the connection to the internet work? Asked by "Did not play last time"
 * (did-not-play.js) when a station could not be reached at all: that is the
 * station's fault only while the connection works.
 *
 * The page notes the outside answers it gets anyway: a catalog request
 * answered through the local proxy (http.js), a station's stream that
 * delivered data (player.js). When none came within ANSWER_FRESH_MS,
 * confirmConnection() asks Radio Browser's small stats page (about 150 bytes)
 * through the local proxy, at most once every CONFIRM_EVERY_MS; its answer is
 * reused until then. Nothing here waits in the way of a play.
 */

import { getJson } from './http.js';

export const ANSWER_FRESH_MS = 60_000;
export const CONFIRM_EVERY_MS = 30_000;
export const CONFIRM_URL = 'https://all.api.radio-browser.info/json/stats';
const CONFIRM_TIMEOUT_MS = 5_000;

let lastAnswerAt = 0;
let lastConfirm = null; // { at, ok }
let pending = null;
const listeners = new Set();

/** Something outside the app answered at `at` (ms since 1970). */
export function noteOutsideAnswer(at = Date.now()) {
  if (!Number.isFinite(at) || at <= lastAnswerAt) return;
  lastAnswerAt = at;
  for (const listener of [...listeners]) {
    try { listener(at); } catch (error) { console.error('connection listener threw:', error); }
  }
}

/** When something outside last answered, or 0. */
export function lastOutsideAnswerAt() {
  return lastAnswerAt;
}

/** Called with the time whenever something outside answers. */
export function onOutsideAnswer(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when the last check, less than CONFIRM_EVERY_MS ago, found no
 *  connection and nothing outside has answered since. */
export function connectionKnownDown(now = Date.now()) {
  return Boolean(lastConfirm && !lastConfirm.ok && now - lastConfirm.at < CONFIRM_EVERY_MS
    && lastAnswerAt <= lastConfirm.at);
}

function askOutside() {
  return getJson(CONFIRM_URL, { timeoutMs: CONFIRM_TIMEOUT_MS, retries: 0 });
}

/** Resolves to true when the connection works (one small request at most
 *  every CONFIRM_EVERY_MS; a check on its way is shared). */
export function confirmConnection({ now = () => Date.now(), request = askOutside } = {}) {
  if (pending) return pending;
  if (lastConfirm && now() - lastConfirm.at < CONFIRM_EVERY_MS) return Promise.resolve(lastConfirm.ok);
  pending = Promise.resolve()
    .then(() => request())
    .then(() => true, () => false)
    .then((ok) => {
      lastConfirm = { at: now(), ok };
      pending = null;
      if (ok) noteOutsideAnswer(now());
      return ok;
    });
  return pending;
}

/** Tests: forget every answer and check. */
export function forgetConnectionEvidence() {
  lastAnswerAt = 0;
  lastConfirm = null;
  pending = null;
}
