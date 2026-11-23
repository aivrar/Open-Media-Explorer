/** Station-announced song titles for plain live audio (Shoutcast/Icecast).
 *
 * The relay removes a station's in-band metadata from the audio and keeps the
 * latest StreamTitle per playback relay token (worldmedia_icy.py). While a
 * plain live audio item plays, the player follows its current relay token
 * with createNowPlayingPoller(), which asks
 * GET /api/v1/media/<token>/now-playing about every 5 s.
 *
 * Other code (a future song log, for example) listens on the state.js bus:
 *   subscribe(NOW_PLAYING_EVENT, ({ itemId, mediaId, title, changedAt }) => {})
 * `title` is plain text (never markup), or null when the station announces
 * nothing or playback of it stopped; `changedAt` is milliseconds since the
 * epoch. The event fires only when the title changes.
 *
 * Pure apart from the injected request function and timers.
 */

import { controlRequest } from './capture-client.js';
import { sameStreamFacts, streamFactsFromRelay } from './played-streams.js';

export const NOW_PLAYING_EVENT = 'now-playing-change';
export const NOW_PLAYING_POLL_MS = 5_000;
// The first block arrives within a second or two of audio; ask a little sooner.
export const NOW_PLAYING_FIRST_POLL_MS = 2_000;
export const MAX_SONG_TITLE_CHARS = 200;
export const SONG_MARK = '\u266A';

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** The title as one plain line: no control or invisible characters, single
 *  spaces, at most 200 characters. The relay already does this; the page
 *  does not rely on it. */
export function normalizeSongTitle(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARACTERS, ' ').replace(INVISIBLE_CHARACTERS, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, MAX_SONG_TITLE_CHARS).join('').trim();
}

/** What the player's meta line shows for a song. */
export function songLine(title) {
  return `${SONG_MARK} ${title}`;
}

/** A poll timer that never keeps a process alive on its own (Node tests,
 *  tools); in the browser setTimeout returns a number and nothing changes. */
function backgroundTimer(fn, delay) {
  const timer = setTimeout(fn, delay);
  try { timer?.unref?.(); } catch (_) {}
  return timer;
}

export function fetchNowPlaying(mediaId, options = {}) {
  return controlRequest(`/api/v1/media/${encodeURIComponent(mediaId)}/now-playing`, options);
}

/**
 * Follows one relay token at a time. follow(token, info) starts (or keeps)
 * polling it; a different token first stops the previous one. stop() ends
 * polling, ignores any reply still on its way, and reports the title gone.
 * A failed poll keeps the last title; the next poll decides.
 *
 * @param {object} options
 * @param {(mediaId: string, options: object) => Promise<object>} [options.fetchTitle]
 * @param {(state: object) => void} [options.onChange]  called with
 *   { ...info, mediaId, title, changedAt } whenever the title changes
 * @param {(state: object) => void} [options.onStream]  called with
 *   { ...info, mediaId, stream: { codec, bitrate } } when a reply first says
 *   what the stream is, or says something else (played-streams.js)
 */
export function createNowPlayingPoller({
  fetchTitle = fetchNowPlaying,
  onChange = () => {},
  onStream = () => {},
  setTimer = backgroundTimer,
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  intervalMs = NOW_PLAYING_POLL_MS,
  firstDelayMs = NOW_PLAYING_FIRST_POLL_MS,
} = {}) {
  let current = null; // { info, mediaId, title, changedAt } while following
  let timer = null;
  let controller = null;
  let generation = 0;

  function snapshot(state = current) {
    return state ? { ...state.info, mediaId: state.mediaId, title: state.title, changedAt: state.changedAt } : null;
  }

  function report(state) {
    try { onChange(snapshot(state)); } catch (_) { /* a listener never stops polling */ }
  }

  function cancelWork() {
    generation += 1;
    if (timer != null) clearTimer(timer);
    timer = null;
    const request = controller;
    controller = null;
    try { request?.abort(); } catch (_) {}
  }

  function schedule(delay, myGeneration) {
    timer = setTimer(() => { poll(myGeneration); }, delay);
  }

  async function poll(myGeneration) {
    timer = null;
    if (myGeneration !== generation || !current) return;
    const mediaId = current.mediaId;
    const request = typeof AbortController === 'function' ? new AbortController() : null;
    controller = request;
    let data;
    try {
      data = await fetchTitle(mediaId, request ? { signal: request.signal } : {});
    } catch (_) {
      data = undefined;
    }
    // A late reply for a station that was stopped or switched away from.
    if (myGeneration !== generation || !current || current.mediaId !== mediaId) return;
    if (controller === request) controller = null;
    if (data !== undefined) {
      const stream = streamFactsFromRelay(data?.stream);
      if (stream && !sameStreamFacts(stream, current.stream)) {
        current = { ...current, stream };
        try { onStream({ ...current.info, mediaId, stream: { ...stream } }); } catch (_) { /* never stops polling */ }
        if (myGeneration !== generation || !current) return; // The listener stopped or switched.
      }
      const title = normalizeSongTitle(data?.title) || null;
      if (title !== current.title) {
        const changed = Number(data?.changed_at);
        current = {
          ...current,
          title,
          changedAt: title && Number.isFinite(changed) && changed > 0 ? Math.round(changed * 1000) : now(),
        };
        report(current);
        if (myGeneration !== generation) return; // The listener stopped or switched.
      }
    }
    schedule(intervalMs, myGeneration);
  }

  function stop() {
    cancelWork();
    const previous = current;
    current = null;
    if (previous?.title) report({ ...previous, title: null, changedAt: now() });
  }

  function follow(mediaId, info = {}) {
    if (typeof mediaId !== 'string' || !mediaId) {
      stop();
      return;
    }
    if (current?.mediaId === mediaId) return;
    stop();
    current = { info: { ...info }, mediaId, title: null, changedAt: null };
    schedule(firstDelayMs, generation);
  }

  return {
    follow,
    stop,
    /** { ...info, mediaId, title, changedAt } while following, else null. */
    get state() { return snapshot(); },
    get mediaId() { return current?.mediaId || ''; },
  };
}
