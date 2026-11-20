/**
 * Global player controller. Single player instance for the whole app —
 * survives mode switches. Supports audio, direct video, HLS (via vendored hls.js).
 */

import { getState, setCurrentItem, setPlaying, emit, subscribe, loadVolume, saveVolume,
         addFavorite, removeFavorite, isFavorite, persistFavoriteMetadata,
         saveSettings } from './state.js';
import { getSourceLabel, loadAdapter } from './sources.js';
import { postSilent } from './http.js';
import { STATION_IMAGE_CLASS, isArtworkRelayUrl, resolveArtworkRelay } from './artwork.js';
import {
  markStationImageFailed, onStationImagesChange, peekStationImageUrl, stationImageSourceFor, stationImageUrl,
} from './station-images.js';
import { artworkInitials, initialsHue } from './initials.js';
import { createPlaybackState } from './player-state.js';
import { repairFiniteMediaFields, resolveMediaAction } from './media-capabilities.js';
import { expireMedia } from './capture-client.js';
import {
  connectMediaRelay, MediaConnectionError, MEDIA_REGISTRY_FULL, MEDIA_REGISTRY_FULL_MESSAGE, playedStream,
} from './media-failover.js';
import {
  createLiveResume, createStallWatchdog, isLiveMedia, RECONNECTING_TEXT, RECONNECT_GAVE_UP_TEXT, RECONNECT_STOPPED_TEXT,
} from './live-resume.js';
import { createRelayMemory } from './relay-memory.js';
import { resolveFailureMessage } from './resolve-message.js';
import { createAudioEngine } from './audio-engine.js';
import { createAudioSignal } from './audio-signal.js';
import { getEffectiveEq, loadEqState } from './eq-store.js';
import { createDashPlayback } from './dash-player.js';
import {
  createHlsRecoveryController, hlsPlaybackConfig, stableHlsLevelOrder,
  selectHlsPlaybackEngine, waitForHlsStartupBuffer,
} from './hls-recovery.js';
import { isContentAllowed } from './content-rating.js';
import { expectsPicture, hasPicture } from './video-picture.js';
import { createNowPlayingPoller, NOW_PLAYING_EVENT, songLine } from './now-playing.js';
import { streamQualityLabel } from './stream-quality.js';
import { favoriteName } from './favorite-names.js';
import { bestStreamOn } from './best-stream.js';
import {
  afterStart as afterBestStreamStart, cancelScheduledCheck, followBestStreamSetting, resumeCheck, verifiedDidNotPlay,
  verifiedStreamFor,
} from './best-stream-auto.js';
import { createStartWatch, untriedStreams } from './start-failover.js';
import { verifiedLabel } from './stream-verify.js';

let Hls = null;
let hlsInstance = null;
let hlsRecoverySession = null;
let dashSession = null;
let currentItem = null;
let bar = null;
let elements = null;
let playbackProblem = null;
let pendingPlay = null;
let mediaPriorityActive = false;
let playAttemptToken = 0;
const playback = createPlaybackState();
const mediaEventBindings = new Map();
let playToken = 0; // monotonic counter — guards against rapid item switches
// Auto (verified): the verified better stream the current station plays on.
let verifiedPlaying = null;
// Listed and Auto: a stream that connected but did not play releases the
// streams not tried yet (start-failover.js).
const startWatch = createStartWatch({
  onNext: (item, tried, token) => {
    // Never inside the callback that reported the failure (hls.js, dash.js).
    queueMicrotask(() => {
      if (token === playToken && currentItem?.id === item.id) playNextStreams(item, tried);
    });
  },
});

/** The verified better stream the current station plays on, or null. */
export function getVerifiedStream() {
  return verifiedPlaying && currentItem ? { itemId: currentItem.id, ...verifiedPlaying } : null;
}
let resolutionController = null;
let eqSignalMonitorToken = 0; // cancels stale/duplicate analyser checks
let activeRelayId = '';
let activePlaybackRelayed = false;
let metadataArtworkToken = 0;
const audioEngine = createAudioEngine({
  onStatus: (status) => emit('eq-engine-change', status),
});

// The sound for visuals (the player-bar meter), read from the engine's side
// tap. Only an element that is playing through the relay and is attached to
// a running graph is read; nothing here creates or resumes the context.
const audioSignal = createAudioSignal({
  source: {
    isPlaying: () => getState().isPlaying === true,
    // Muted or turned all the way down (by hand or a sleep-timer fade): the
    // meter rests. Both elements are muted and set together (setMuted,
    // setVolume); a volumechange on either calls refresh() (initPlayer).
    isAudible: () => {
      const el = playback.activeElement || elements?.audio;
      return !el || (!el.muted && el.volume > 0);
    },
    // The volume the tap hears the sound at (it is after the element's
    // volume); read once per frame, so the visualizer can make up for it.
    getVolume: () => {
      const el = playback.activeElement || elements?.audio;
      const volume = Number(el?.volume);
      return Number.isFinite(volume) ? volume : 1;
    },
    getAnalyser: () => {
      const el = playback.activeElement;
      if (!el || !activePlaybackRelayed || playbackProblem || el.paused || el.ended) return null;
      return audioEngine.visualTapFor(el);
    },
    release: () => audioEngine.releaseVisualTap(),
    // Changes with every new item (playToken) and every element switch or
    // reconnect (playback.generation), so visuals can reset beat tracking.
    getSourceKey: () => `${playToken}:${playback.generation}`,
  },
});

/** The shared sound signal for visuals (audio-signal.js). */
export function getAudioSignal() { return audioSignal; }

function effectiveEqCurve(item = currentItem) {
  if (!item?.id) return getEffectiveEq(loadEqState(), '', false);
  return getEffectiveEq(loadEqState(), item.id, isFavorite(item.id));
}

// Survives a page reload so the next page can release a leftover registration.
const relayMemory = createRelayMemory({ release: (mediaId) => expireMedia(mediaId, 0) });

function setActiveRelay(mediaId) {
  activeRelayId = mediaId || '';
  if (activeRelayId) relayMemory.remember(activeRelayId);
}

function releaseRelay(graceSeconds = 0) {
  const relayId = activeRelayId;
  activeRelayId = '';
  if (!relayId) return;
  // The remembered id is cleared only once the release succeeded, and only if
  // no newer id was stored meanwhile; otherwise the next page start retries.
  expireMedia(relayId, graceSeconds)
    .then(() => { relayMemory.forgetIf(relayId); })
    .catch(() => {});
}

// What this play session has shown so far. A new one starts with every
// playItem() call, including each automatic reconnect attempt.
function newPlaySession(token) {
  return {
    token,
    played: false, // the playhead really moved forward 1 s after a `playing` event
    lastTime: null, // playhead at the last sample; null until `playing`
    lastSampleAt: 0, // wall-clock time of that sample
    progressed: 0,
    seeking: false,
    duration: undefined, // last known duration; NaN (unknown) is never stored
    unbounded: false, // the duration was Infinity at some point of this start
    hlsLive: null, // hls.js playlist type, once known
    stopReason: '', // a failure that must end an auto-reconnect episode
    userPaused: false, // the user paused while the first play() was pending
  };
}
let playSession = newPlaySession(0);

// Auto-reconnect for live streams that drop after playing (see live-resume.js).
let reconnectItem = null;
let reconnectStatus = '';
let reconnectEpoch = 0; // bumped by every cancel, so queued work can tell
let queuedFailureToken = 0; // the play session whose failure is being queued
const liveResume = createLiveResume({
  runAttempt: () => runReconnectAttempt(),
  abortAttempt: () => abandonReconnectAttempt(),
  onWaiting: () => showReconnecting(),
  onGiveUp: () => {
    reconnectItem = null;
    reconnectStatus = '';
    if (currentItem) showBrokenState(RECONNECT_GAVE_UP_TEXT, { showNext: true, retry: true });
  },
  onRecovered: () => {
    reconnectItem = null;
    reconnectStatus = '';
    // A stream that froze silently during the episode emits no timeupdate.
    watchForStall();
  },
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
});

// A plain live stream can freeze with no error, `ended` or `waiting`. While it
// should be playing, a playhead that stands still for 20 s counts as a lost
// connection. HLS has its own progress watchdog in hls-recovery.js.
let stallWatchToken = 0;
const stallWatchdog = createStallWatchdog({
  read: () => stallWatchState(),
  onStall: () => {
    if (stallWatchToken !== playToken || !stallWatchState().eligible) return;
    failPlayback('Playback error');
  },
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
});

function plainLiveStream() {
  const kind = currentItem?.stream_kind;
  return (kind === 'audio' || kind === 'video') && !hlsInstance && !dashSession
    && playSession.played && isLiveMedia({
      delivery: currentItem.delivery,
      hlsLive: playSession.hlsLive,
      duration: playSession.duration,
    });
}

// The song a Shoutcast/Icecast station announces (see now-playing.js). Only
// plain live audio that is sounding through the relay is followed; anything
// else, a pause, an error or a reconnect wait stops it. A reconnect plays a
// new relay token, which is followed from then on.
const nowPlaying = createNowPlayingPoller({
  onChange: (state) => onSongChange(state),
  now: () => Date.now(),
});
let metaLineShowsItem = false; // the meta line shows the item's own line, not a status
let songMetadataSaved = false; // Media Session metadata was replaced by a song
let metadataBeforeSong = null;

function songTitleEligible() {
  const el = playback.activeElement;
  return Boolean(elements && currentItem && activeRelayId && activePlaybackRelayed
    && el === elements.audio && currentItem.stream_kind === 'audio'
    && !hlsInstance && !dashSession && !el.paused && !el.ended && !playbackProblem
    && playSession.token === playToken && !reconnectPending()
    && isLiveMedia({
      delivery: currentItem.delivery,
      hlsLive: playSession.hlsLive,
      duration: playSession.duration,
    }));
}

function syncNowPlaying() {
  if (songTitleEligible()) nowPlaying.follow(activeRelayId, { itemId: currentItem.id });
  else nowPlaying.stop();
}

/** The song to show for this item now, or ''. */
function currentSongTitle(item) {
  const state = nowPlaying.state;
  return state?.title && activeRelayId && state.mediaId === activeRelayId && state.itemId === item?.id
    ? state.title : '';
}

/** Song title as Media Session metadata (title = song, artist = station);
 *  whatever was there before comes back when the song goes away. */
/** The name the player bar shows for an item: the user's own name for a
 *  saved favorite (favorite-names.js), else its title. */
function shownTitle(item) {
  if (!item) return '';
  return (isFavorite(item.id) && favoriteName(item.id)) || item.title || '';
}

function syncSongMediaSession(title) {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession) return;
  if (title && currentItem && typeof globalThis.MediaMetadata === 'function') {
    try {
      if (!songMetadataSaved) {
        metadataBeforeSong = mediaSession.metadata ?? null;
        songMetadataSaved = true;
      }
      mediaSession.metadata = new globalThis.MediaMetadata({ title, artist: shownTitle(currentItem) });
    } catch (_) {}
    return;
  }
  if (!songMetadataSaved) return;
  songMetadataSaved = false;
  try { mediaSession.metadata = metadataBeforeSong; } catch (_) {}
  metadataBeforeSong = null;
}

function onSongChange(state) {
  const title = state?.title || null;
  // Never pair one station's song with another station's name.
  syncSongMediaSession(title && state?.itemId === currentItem?.id ? title : null);
  // A status (reconnecting, an error, resolving) keeps the line; the song
  // comes back with the item's line once the status is gone.
  if (currentItem && elements && metaLineShowsItem) setMetaText(currentItem);
  emit(NOW_PLAYING_EVENT, {
    itemId: state?.itemId || '',
    mediaId: state?.mediaId || '',
    title,
    changedAt: Number.isFinite(state?.changedAt) ? state.changedAt : Date.now(),
  });
}

function stallWatchState() {
  const el = getActiveEl();
  const eligible = Boolean(el && currentItem && stallWatchToken === playToken
    && playSession.token === playToken && !el.paused && !el.ended
    && !playSession.seeking && !playbackProblem && !liveResume.active
    && plainLiveStream());
  return { eligible, position: el ? Number(el.currentTime) : Number.NaN };
}

/** Start watching the current session (no-op if already watching or not eligible). */
function watchForStall() {
  if (stallWatchToken !== playToken) {
    stallWatchdog.stop();
    stallWatchToken = playToken;
  }
  stallWatchdog.start();
}

function cancelPendingResolution(reason = 'Playback selection changed') {
  const controller = resolutionController;
  resolutionController = null;
  if (controller && !controller.signal.aborted) {
    controller.abort(new DOMException(reason, 'AbortError'));
  }
}

function $(id) { return document.getElementById(id); }
function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function bindElements() {
  bar = $('player-bar');
  elements = {
    audio:    $('audio-el'),
    video:    $('video-el'),
    title:    $('player-title'),
    source:   $('player-source'),
    art:      $('player-art'),
    artInitials: $('player-art-initials'),
    play:     $('player-play'),
    iconPlay: $('icon-play'),
    iconPause:$('icon-pause'),
    stop:     $('player-stop'),
    seek:     $('player-seek'),
    time:     $('player-time'),
    dur:      $('player-dur'),
    vol:      $('player-volume'),
    mute:     $('player-mute'),
    nextBroken: $('player-next-broken'),
    fav:      $('player-fav'),
  };
}

async function loadHlsIfNeeded() {
  if (Hls) return Hls;
  try {
    const mod = await import('../vendor/hls.js');
    Hls = mod.default || mod.Hls || window.Hls;
    return Hls;
  } catch (err) {
    console.warn('hls.js could not be loaded:', err);
    return null;
  }
}

// The floating video's position and size live in base.css (.video-dock).
// Its width follows the window, and the corner button switches between the
// normal and large size; the choice is a saved setting.
function syncVideoSize() {
  const large = getState().settings.videoSize === 'large';
  document.getElementById('app')?.classList.toggle('video-large', large);
  const button = document.getElementById('video-size-btn');
  if (!button) return;
  const label = large ? 'Smaller video' : 'Larger video';
  button.setAttribute('aria-pressed', large ? 'true' : 'false');
  button.setAttribute('aria-label', label);
  button.title = label;
}

function bindVideoSizeButton() {
  document.getElementById('video-size-btn')?.addEventListener('click', () => {
    const large = getState().settings.videoSize === 'large';
    saveSettings({ videoSize: large ? 'normal' : 'large' });
  });
  subscribe('settings-change', syncVideoSize);
  syncVideoSize();
}

// True while a stream is playing through the <video> element. Audio-only
// HLS/DASH (some radio stations) also plays there, so the square is only shown
// for radio and audio items once the stream reports a picture.
let pictureStream = false;

function syncVideoPicture() {
  if (pictureStream && hasPicture(elements.video)) showVideo(true);
}

function bindVideoPicture() {
  elements.video.addEventListener?.('loadedmetadata', syncVideoPicture);
  elements.video.addEventListener?.('resize', syncVideoPicture);
}

function showVideo(show) {
  elements.video.hidden = !show;
  // Tell the rest of the UI a video overlay is on-screen, so anything that
  // ends near the bottom-right (the library detail panel, mainly) can
  // reserve some bottom padding so its text doesn't slide under the video.
  const app = document.getElementById('app');
  if (app) app.classList.toggle('has-video', !!show);
}

function getActiveEl() {
  return playback.activeElement;
}

function setMediaPriority(active) {
  const next = active === true;
  if (mediaPriorityActive === next) return;
  mediaPriorityActive = next;
  emit('media-priority-change', next);
}

function destroyHls() {
  hlsRecoverySession?.destroy();
  hlsRecoverySession = null;
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (_) {}
    hlsInstance = null;
  }
}

function destroyDash() {
  if (!dashSession) return;
  try { dashSession.destroy(); } catch (_) {}
  dashSession = null;
}

/** The only writer of global playback state, play/pause affordances, and seek UI. */
function syncPlaybackUi(reason = 'sync') {
  if (!elements) return;
  const el = playback.activeElement;
  const hasSource = Boolean(el && (el.src || el.currentSrc || hlsInstance || dashSession));
  const isPlaying = Boolean(
    el && hasSource && !playbackProblem && !el.paused && !el.ended
  );

  if (getState().isPlaying !== isPlaying) setPlaying(isPlaying);
  elements.iconPlay.toggleAttribute('hidden', isPlaying);
  elements.iconPause.toggleAttribute('hidden', !isPlaying);
  const action = isPlaying ? 'Pause' : 'Play';
  elements.play.title = action;
  elements.play.setAttribute('aria-label', action);
  elements.play.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  // A reconnecting or given-up live stream keeps Play available even after its
  // media was torn down: pressing it runs the full rebuild.
  const canRetry = Boolean(currentItem && playbackProblem?.retry);
  // While the next item connects (no source yet, no problem) Play stays in
  // place, only disabled: hiding it for that moment narrowed the controls
  // column, so the whole bar (title, sound meter, times) jumped sideways and
  // back on every station change, for example each step of the Tuner dial.
  const switching = Boolean(currentItem && !hasSource && !playbackProblem);
  elements.play.hidden = !currentItem || (!hasSource && !canRetry && !switching);
  elements.play.disabled = !hasSource && !canRetry;

  if (el) {
    elements.time.textContent = fmtTime(el.currentTime);
    if (Number.isFinite(el.duration) && el.duration > 0) {
      elements.seek.disabled = false;
      elements.dur.textContent = fmtTime(el.duration);
      elements.seek.max = String(Math.floor(el.duration));
      if (!el.__seeking) elements.seek.value = String(Math.floor(el.currentTime));
    } else {
      elements.seek.disabled = true;
      elements.dur.textContent = '--:--';
      elements.seek.value = '0';
    }
  } else {
    elements.time.textContent = '--:--';
    elements.dur.textContent = '--:--';
    elements.seek.disabled = true;
    elements.seek.value = '0';
  }

  const mediaSession = globalThis.navigator?.mediaSession;
  if (mediaSession && 'playbackState' in mediaSession) {
    try {
      mediaSession.playbackState = !el ? 'none' : (isPlaying ? 'playing' : 'paused');
    } catch (_) {}
  }
  syncNowPlaying();
  return reason;
}

/** The line under the title. A status or error message is also put in the
 *  tooltip, so a text cut off by the narrow column can be read in full; the
 *  normal source line clears it again (or sets `hover`, for a song). Text
 *  only, never markup. Only setMetaText() writes the item's own line. */
function setSourceLine(text, { status = false, hover = '', itemLine = false } = {}) {
  elements.source.textContent = text;
  elements.source.title = status ? text : hover;
  metaLineShowsItem = itemLine && !status;
}

/** Play failed before there was any playable stream. The capture controls
 *  stop showing "Checking…" for it until the next Play of an item starts. */
function reportUnplayable(item) {
  emit('media-unplayable', { itemId: item?.id || '' });
}

function showBrokenState(msg, { showNext = true, retry = false } = {}) {
  stallWatchdog.stop();
  elements.title.textContent = shownTitle(currentItem) || 'Stream unavailable';
  // While a reconnect episode runs, a failed attempt keeps saying so.
  setSourceLine(reconnectStatus || msg || 'This stream could not be played', { status: true });
  playbackProblem = { message: msg, showNext, retry: retry === true };
  setMediaPriority(false);
  elements.nextBroken.hidden = !showNext;
  const active = getActiveEl();
  if (active && !active.paused) {
    try { active.pause(); } catch (_) {}
  }
  syncPlaybackUi('error');
}

function hideBrokenState() {
  playbackProblem = null;
  // Try next stays offered while a reconnect attempt is still connecting.
  elements.nextBroken.hidden = !reconnectStatus;
}

function reconnectingCurrentItem() {
  return Boolean(currentItem && reconnectItem && reconnectItem.id === currentItem.id
    && liveResume.active);
}

/** Waiting for, or running, an automatic reconnect attempt for this item. */
function reconnectPending(item = currentItem) {
  return Boolean(item && currentItem && item.id === currentItem.id && reconnectingCurrentItem()
    && (liveResume.waiting || liveResume.inFlight));
}

/** Auto-reconnect only a live stream that really played in this session, or
 *  one that is already inside an episode. A station that never started keeps
 *  today's immediate broken state. */
function shouldReconnect() {
  if (!currentItem) return false;
  if (reconnectingCurrentItem()) return true;
  return playSession.token === playToken && playSession.played && isLiveMedia({
    delivery: currentItem.delivery,
    hlsLive: playSession.hlsLive,
    duration: playSession.unbounded ? Number.POSITIVE_INFINITY : playSession.duration,
  });
}

/** A network-ish end of playback: reconnect a live stream, else show the error. */
function failPlayback(msg, options = {}) {
  if (!shouldReconnect()) {
    // Listed and Auto: a stream that never played; the next streams get a turn.
    if (startWatch.failed(playToken)) return;
    showBrokenState(msg, options);
    return;
  }
  // Inside a running attempt the failure belongs to that attempt: record it so
  // the attempt settles as failed even if its play() already resolved.
  if (liveResume.inFlight && reconnectingCurrentItem()) {
    if (playSession.token === playToken) liveResume.failed();
    return;
  }
  // This may run inside an hls.js error callback. Tear down and switch to the
  // reconnecting state only after the current dispatch has finished. Further
  // errors from the same failure are coalesced into this one transition.
  if (queuedFailureToken === playToken) return;
  const token = playToken;
  const epoch = reconnectEpoch;
  queuedFailureToken = token;
  queueMicrotask(() => {
    if (queuedFailureToken === token) queuedFailureToken = 0;
    if (token !== playToken || !currentItem) return;
    // Sleep timer or a pause arrived first: no episode, just the plain error.
    if (epoch !== reconnectEpoch) {
      showBrokenState(msg, options);
      return;
    }
    if (!reconnectingCurrentItem()) {
      liveResume.cancel();
      reconnectItem = currentItem;
    }
    liveResume.failed();
  });
}

function showReconnecting() {
  if (!currentItem) return;
  reconnectStatus = RECONNECTING_TEXT;
  // The dead session must not keep loading, or recover on its own, while the
  // episode waits; the next attempt rebuilds everything.
  hlsRecoverySession?.destroy();
  try { hlsInstance?.stopLoad?.(); } catch (_) {}
  showBrokenState(RECONNECTING_TEXT, { showNext: true, retry: true });
}

function cancelReconnect({ keepAttempt = false } = {}) {
  reconnectEpoch++;
  reconnectItem = null;
  reconnectStatus = '';
  liveResume.cancel({ keepAttempt });
}

/** A user pause (the Play/Pause button, Media Session pause). */
function pauseFromUser() {
  startWatch.end();
  const el = getActiveEl();
  if (el && !playbackProblem && !el.paused && !el.ended) {
    // Already sounding, even while a reconnect attempt is still settling its
    // play(): end the episode but keep that stream, just paused, so Play
    // resumes it. The play() this pause interrupts is not a failure.
    if (playSession.token === playToken) playSession.userPaused = true;
    cancelReconnect({ keepAttempt: true });
    hideBrokenState();
    // The status may still read "Reconnecting…" if `playing` has not yet
    // rewritten it; show the station's normal line again.
    if (currentItem) setMetaText(currentItem);
    el.pause();
    return true;
  }
  if (!stopReconnecting()) el?.pause();
  return true;
}

/** True when this rejection is only the user's pause interrupting this
 *  session's first play(); any other start failure is still reported. */
function pausedDuringStart(error, token) {
  return error?.name === 'AbortError'
    && playSession.token === token && playSession.userPaused === true;
}

/** Stop a waiting or running reconnect (sleep timer, user pause). */
function stopReconnecting() {
  // Also drop a failure queued just before this stop, even with no episode yet.
  reconnectEpoch++;
  if (!liveResume.active) return false;
  const interrupted = liveResume.waiting || liveResume.inFlight;
  cancelReconnect();
  if (interrupted && currentItem) {
    showBrokenState(RECONNECT_STOPPED_TEXT, { showNext: true, retry: true });
  }
  return interrupted;
}

/** One attempt: exactly what pressing Play on the broken item does. */
async function runReconnectAttempt() {
  const item = reconnectItem;
  if (!item || currentItem?.id !== item.id) return 'stop';
  try {
    await startPlayback(item);
  } catch (error) {
    if (error?.code === 'CONTENT_RATING_BLOCKED') {
      stop();
      return 'stop';
    }
    return 'retry';
  }
  if (playSession.stopReason) {
    // A full relay or a blocked play() will not clear by retrying.
    reconnectItem = null;
    reconnectStatus = '';
    return 'stop';
  }
  const el = getActiveEl();
  return el && !playbackProblem && !el.paused && !el.ended ? 'ok' : 'retry';
}

/** Invalidate an attempt that is still running, so a late finish cannot start
 *  playback after a cancel or a timeout. */
function abandonReconnectAttempt() {
  playToken++;
  cancelPendingResolution('Reconnect attempt abandoned');
  releaseRelay(0);
  invalidatePlaybackOwnership();
  destroyHls();
  destroyDash();
  if (!elements) return;
  clearMedia(elements.audio);
  clearMedia(elements.video);
  activePlaybackRelayed = false;
  showVideo(false);
  syncPlaybackUi('reconnect-abandoned');
}

// Playback cannot move the playhead faster than real time; this much slack
// covers timer jitter. A larger advance is a jump (a live-edge correction or a
// seek that fired no events), not playback.
const PROGRESS_SLACK_SECONDS = 1;

function startProgressSample(el) {
  const time = Number(el.currentTime);
  playSession.lastTime = Number.isFinite(time) ? time : 0;
  playSession.lastSampleAt = Date.now();
}

/** Credit only forward, unseeked playhead movement after `playing`, judged
 *  against the wall-clock time since the previous sample, so throttled
 *  timeupdate events (a minimised window) still count. */
function notePlaybackProgress(el) {
  if (playSession.played || playSession.lastTime == null || playSession.seeking) return;
  const time = Number(el.currentTime);
  if (!Number.isFinite(time)) return;
  const sampledAt = Date.now();
  const step = time - playSession.lastTime;
  const elapsed = Math.max(0, sampledAt - playSession.lastSampleAt) / 1000;
  playSession.lastTime = time;
  playSession.lastSampleAt = sampledAt;
  if (step > 0 && step <= elapsed + PROGRESS_SLACK_SECONDS) {
    playSession.progressed += step;
    // Listed and Auto: it began; the start watch's confirm window runs.
    startWatch.moved(playToken);
  }
  if (playSession.progressed >= 1) {
    playSession.played = true;
    startWatch.end();
  }
}

function noteSeeking(el, seeking) {
  playSession.seeking = seeking;
  if (seeking) stallWatchdog.stop();
  // A seek's jump is never progress: continue counting from where it landed.
  if (!seeking && playSession.lastTime != null) startProgressSample(el);
  // Watch again from where it landed: a stream frozen there sends no further
  // timeupdate or playing. A no-op unless the usual conditions hold.
  if (!seeking) watchForStall();
}

function noteDuration(el) {
  const duration = Number(el.duration);
  if (Number.isNaN(duration)) return;
  playSession.duration = duration;
  // A plain live stream has no length while it plays. When its connection
  // closes, the element reports the time played as the length just before
  // `ended`; the start stays known as unbounded so that end is still a drop.
  if (duration === Number.POSITIVE_INFINITY) playSession.unbounded = true;
}

function noteStartFailure(error, token) {
  if (error?.name !== 'NotAllowedError' || playSession.token !== token) return;
  // Autoplay policy: never loop on play(); end any episode with the normal message.
  playSession.stopReason = 'NotAllowedError';
  reconnectStatus = '';
}

async function attemptMediaPlay(el) {
  const attempt = ++playAttemptToken;
  pendingPlay = { element: el, attempt };
  try {
    await el.play();
  } finally {
    if (pendingPlay?.attempt === attempt) pendingPlay = null;
  }
}

function unbindMediaEvents(el) {
  const bindings = mediaEventBindings.get(el);
  if (!bindings) return;
  for (const [name, handler] of bindings) el.removeEventListener(name, handler);
  mediaEventBindings.delete(el);
}

function bindMediaEvents(el, generation) {
  unbindMediaEvents(el);
  const owned = (handler) => (event) => {
    if (playback.owns(el, generation)) handler(event);
  };
  const onTimeUpdate = owned(() => {
    hlsRecoverySession?.noteProgress(el.currentTime);
    notePlaybackProgress(el);
    watchForStall();
    syncPlaybackUi('timeupdate');
  });
  const onDurationChange = owned(() => {
    noteDuration(el);
    syncPlaybackUi('durationchange');
  });
  const onStalled = owned(() => {
    if (!el.paused && !el.ended) hlsRecoverySession?.noteStalled();
    syncPlaybackUi('stalled');
  });
  // `waiting` means playback really stopped for lack of data. `stalled` alone
  // only means fetching paused while buffered media may keep playing, so it
  // does not count as an interruption of a reconnected stream.
  const onWaiting = owned(() => {
    if (!el.paused && !el.ended) hlsRecoverySession?.noteStalled();
    liveResume.noteInterrupted();
    syncPlaybackUi('waiting');
  });
  const onPlay = owned(() => {
    setMediaPriority(true);
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    syncPlaybackUi('play');
  });
  const onPlaying = owned(() => {
    setMediaPriority(true);
    // Listed and Auto: the first `playing` of this start (start-failover.js).
    startWatch.playing(playToken);
    hlsRecoverySession?.notePlaying();
    if (playSession.lastTime == null) startProgressSample(el);
    noteDuration(el);
    if (reconnectingCurrentItem()) {
      reconnectStatus = '';
      liveResume.notePlaying();
    }
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    watchForStall();
    syncPlaybackUi('playing');
    // Auto (verified): the check waits VERIFY_AFTER_MS of play from the first
    // `playing` of a start, and again after a pause; nothing new when one is
    // already planned for this station.
    if (currentItem) {
      resumeCheck(currentItem, { settings: getState().settings, current: () => currentItem, nowPlaying: getNowPlaying });
    }
  });
  const pausedNow = () => {
    // Auto (verified): a pause ends the background check's session.
    cancelScheduledCheck();
    stallWatchdog.stop();
    setMediaPriority(false);
    hlsRecoverySession?.notePaused();
    liveResume.noteInterrupted();
    syncPlaybackUi('pause');
  };
  const onPaused = owned(pausedNow);
  const onEnded = owned(() => {
    pausedNow();
    // A plain live stream (Icecast/MP3) "ends" when its connection closes.
    const progressive = currentItem?.stream_kind === 'audio' || currentItem?.stream_kind === 'video';
    if (progressive && playSession.unbounded && shouldReconnect()) {
      failPlayback('Playback error');
    }
  });
  const onError = owned(() => {
    // The play() promise is the authoritative result while an attempt is
    // pending. Some streams emit an interim error while negotiating a redirect
    // or codec; pausing here aborts an attempt that may otherwise succeed.
    if (pendingPlay?.element === el) return;
    if (hlsRecoverySession?.isRecovering) return;
    failPlayback('Playback error');
  });
  const bindings = [
    ['timeupdate', onTimeUpdate],
    ['loadedmetadata', onDurationChange],
    ['durationchange', onDurationChange],
    ['play', onPlay],
    ['playing', onPlaying],
    ['pause', onPaused],
    ['ended', onEnded],
    ['seeking', owned(() => noteSeeking(el, true))],
    ['seeked', owned(() => noteSeeking(el, false))],
    ['emptied', onPaused],
    ['waiting', onWaiting],
    ['stalled', onStalled],
    ['error', onError],
  ];
  for (const [name, handler] of bindings) el.addEventListener(name, handler);
  mediaEventBindings.set(el, bindings);
}

function invalidatePlaybackOwnership() {
  eqSignalMonitorToken++;
  playback.invalidate();
  if (!elements) return;
  unbindMediaEvents(elements.audio);
  unbindMediaEvents(elements.video);
}

function clearMedia(el) {
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch (_) {}
}

function setMetaText(item) {
  elements.title.textContent = shownTitle(item) || 'Untitled';
  // A reconnect attempt rebuilds the player bar; keep the status visible.
  if (reconnectStatus) {
    setSourceLine(reconnectStatus, { status: true });
    return;
  }
  const line = [getSourceLabel(item.source), item.country, item.language].filter(Boolean).join(' \u00B7 ');
  const song = currentSongTitle(item);
  // Stream format and bitrate go on hover only, after the normal line: the
  // visible column is too narrow for them.
  // The format and bitrate of the stream that plays, when they are known.
  const played = playedStream(item);
  const listed = streamQualityLabel(played && (played.bitrate || played.codec)
    ? { _extra: { ...(item._extra || {}), bitrate: played.bitrate || 0, codec: played.codec || '' } }
    : item);
  // Auto (verified): said plainly when a verified better stream plays.
  const quality = [listed, verifiedPlaying && currentItem === item ? verifiedLabel(verifiedPlaying) : '']
    .filter(Boolean).join('\n');
  if (!song) {
    setSourceLine(line, { itemLine: true, hover: quality ? [line, quality].filter(Boolean).join('\n') : '' });
    return;
  }
  // The song replaces the line; its full text and the normal line stay readable on hover.
  const text = songLine(song);
  setSourceLine(text, { hover: [text, line, quality].filter(Boolean).join('\n'), itemLine: true });
}

/** Initials on a coloured square behind the artwork, the same as on the
 *  cards, so an item without artwork is not an empty box. */
function setArtInitials(item) {
  const node = elements.artInitials;
  if (!node) return;
  const name = shownTitle(item);
  const initials = artworkInitials(name);
  node.textContent = initials;
  node.hidden = !initials;
  node.style?.setProperty?.('--ph-hue', String(initialsHue(name)));
}

function setMeta(item) {
  bar.hidden = false;
  document.getElementById('app')?.classList.add('has-player');
  setMetaText(item);
  setArtInitials(item);
  setPlayerArtwork(item);
  syncFavButton();
}

// The station picture the player bar was last drawn with ('' for none).
let playerStationImage = '';

/** The station pictures changed (startup list, Refresh, or one would not
 *  load): redraw the player bar's picture, which the Tuner shows too, only
 *  when the playing item's picture is a different one now. Playback and the
 *  rest of the bar are left alone. Returns true when it was redrawn. */
export function syncPlayerStationImage() {
  if (!currentItem || !bar || bar.hidden) return false;
  if (stationImageSourceFor(currentItem) === playerStationImage) return false;
  setPlayerArtwork(currentItem);
  return true;
}

/** The player bar's picture (also what the Tuner shows): the user's own
 *  station picture first, then the item's relay artwork. A station picture
 *  that will not load falls back to the item's own artwork. */
function setPlayerArtwork(item) {
  const artworkToken = ++metadataArtworkToken;
  playerStationImage = stationImageSourceFor(item);
  const current = () => artworkToken === metadataArtworkToken && currentItem === item;
  const latest = () => artworkToken === metadataArtworkToken;
  // The class follows what the bar shows: on only while a station picture is
  // on screen (shown whole on the bar, base.css), off while the box is empty,
  // loading, or showing remote artwork (which fills the square).
  const setFit = (custom) => elements.art.classList?.toggle?.(STATION_IMAGE_CLASS, custom);
  const clearArt = () => {
    setFit(false);
    elements.art.removeAttribute('src');
    elements.art.style.opacity = '0';
  };
  const showSource = (src, onFail = null, custom = false) => {
    elements.art.referrerPolicy = 'no-referrer';
    // A newer picture replaces these handlers; a stale event changes nothing.
    elements.art.onload = () => {
      if (!latest()) return;
      setFit(custom);
      elements.art.style.opacity = '1';
    };
    elements.art.onerror = () => {
      if (!latest()) return;
      clearArt();
      if (current()) onFail?.();
    };
    if (elements.art.getAttribute('src') !== src) {
      setFit(false);
      elements.art.style.opacity = '0';
      elements.art.src = src;
    } else if (elements.art.complete && elements.art.naturalWidth > 0) {
      setFit(custom);
      elements.art.style.opacity = '1';
    }
  };
  const attachArtwork = () => {
    if (!current() || !isArtworkRelayUrl(item.thumbnail)) return;
    showSource(item.thumbnail.trim());
  };
  const showOwnArtwork = () => {
    if (isArtworkRelayUrl(item.thumbnail)) {
      attachArtwork();
    } else {
      clearArt();
      resolveArtworkRelay(item, { priority: 20 }).then(attachArtwork).catch(() => {});
    }
  };
  const custom = stationImageSourceFor(item);
  if (!custom) {
    showOwnArtwork();
    return;
  }
  // Marking it failed redraws every view, this one included (initPlayer).
  const failed = () => {
    markStationImageFailed(custom);
    if (current()) showOwnArtwork();
  };
  const ready = peekStationImageUrl(custom);
  if (ready) {
    showSource(ready, failed, true);
    return;
  }
  // Initials while the picture is fetched; a fetch that stalls or fails
  // leaves the box empty and unmarked.
  clearArt();
  stationImageUrl(custom).then((url) => { if (current()) showSource(url, failed, true); }, failed);
}

/** Reflect the favorited state of the currently-playing item on the player
 *  bar's star. Called from setMeta() and from the favorites-change subscription
 *  so the star stays in sync even if the user toggles via a Library card. */
function syncFavButton() {
  if (!elements.fav) return;
  if (!currentItem) {
    elements.fav.hidden = true;
    return;
  }
  elements.fav.hidden = false;
  const fav = isFavorite(currentItem.id);
  elements.fav.classList.toggle('is-fav', fav);
  elements.fav.setAttribute('aria-pressed', fav ? 'true' : 'false');
  elements.fav.title = fav ? 'Remove from favorites' : 'Add to favorites';
  elements.fav.setAttribute('aria-label', elements.fav.title);
}

async function prepareEqualizer(target, item, relayAvailable) {
  const curve = effectiveEqCurve(item);
  audioEngine.applyCurve(curve);
  if (!relayAvailable) {
    const reason = 'Equalizer unavailable because same-origin media relay failed.';
    audioEngine.setExternalUnavailable(reason);
    if (audioEngine.isAttached(target)) {
      return {
        safe: false,
        reason: 'Playback stopped because direct cross-origin media would be silent through the equalizer.',
      };
    }
    return { safe: true, processed: false };
  }
  audioEngine.clearExternalUnavailable();
  const result = await audioEngine.attachElement(target, { curve });
  return { safe: true, ...result };
}

function verifyEqualizerSignal(target, token, generation) {
  if (!audioEngine.isAttached(target)) return;
  const monitorToken = ++eqSignalMonitorToken;
  const isCurrent = () => monitorToken === eqSignalMonitorToken
    && token === playToken && playback.owns(target, generation);
  audioEngine.verifySignal(target, {
    isCurrent,
  }).then((audible) => {
    if (audible !== false || !isCurrent()) return;
    // A video may legitimately have no audio track; keep its picture playing
    // while exposing the EQ error. Audio/radio silence is a playback failure.
    if (target === elements.audio) {
      showBrokenState('Equalizer received silent audio. Playback stopped to avoid a muted stream.', {
        showNext: false,
      });
    }
  }).catch(() => {});
}

async function resumeEqualizerFromGesture() {
  const target = getActiveEl();
  if (!target || !currentItem) return audioEngine.resume();
  if (!activePlaybackRelayed) {
    audioEngine.setExternalUnavailable('Equalizer unavailable for direct cross-origin playback.');
    return false;
  }
  const generation = playback.generation;
  const result = await audioEngine.attachElement(target, { curve: effectiveEqCurve(currentItem) });
  if (result.processed && playback.owns(target, generation) && !target.paused) {
    verifyEqualizerSignal(target, playToken, generation);
  }
  return result.processed;
}

async function attachStream(item, token, { relayAvailable = false } = {}) {
  invalidatePlaybackOwnership();
  destroyHls();
  destroyDash();
  hideBrokenState();
  const stale = () => token != null && token !== playToken;
  if (stale()) return;
  const kind = item.stream_kind;
  const videoKind = kind === 'video' || kind === 'hls' || kind === 'dash';
  const target = videoKind ? elements.video : elements.audio;
  const inactive = videoKind ? elements.audio : elements.video;
  clearMedia(inactive);
  // Explicit anonymous mode keeps MediaElementAudioSourceNode origin-clean for
  // HLS/MSE and redirected media served by our same-origin relay. Remove it for
  // the direct-playback fallback, whose upstream may not publish CORS headers.
  if (relayAvailable) {
    target.crossOrigin = 'anonymous';
    target.setAttribute('crossorigin', 'anonymous');
  } else {
    target.removeAttribute('crossorigin');
    target.crossOrigin = null;
  }
  activePlaybackRelayed = relayAvailable;
  const generation = playback.activate(target);
  bindMediaEvents(target, generation);
  const eqPreparation = await prepareEqualizer(target, currentItem || item, relayAvailable);
  if (stale() || !playback.owns(target, generation)) return;
  if (!eqPreparation.safe) {
    showBrokenState(eqPreparation.reason, { showNext: false });
    return;
  }
  let playbackStarted = false;
  if (videoKind) {
    pictureStream = true;
    showVideo(expectsPicture(item) || hasPicture(elements.video));
    if (kind === 'hls') {
      const HlsLib = await loadHlsIfNeeded();
      if (stale() || !playback.owns(target, generation)) return;
      const engine = selectHlsPlaybackEngine({
        hlsSupported: Boolean(HlsLib?.isSupported?.()),
        nativeSupport: elements.video.canPlayType('application/vnd.apple.mpegurl'),
      });
      if (engine === 'hlsjs') {
          const instance = new HlsLib(hlsPlaybackConfig());
          let stableLevels = [];
          let stableLevelPosition = -1;
          hlsInstance = instance;
          hlsRecoverySession = createHlsRecoveryController({
            hls: instance,
            errorTypes: HlsLib.ErrorTypes,
            owns: () => hlsInstance === instance && playback.owns(target, generation),
            getCurrentTime: () => target.currentTime,
            onRecovering: (message) => {
              if (currentItem) elements.title.textContent = shownTitle(currentItem) || 'Live stream';
              setSourceLine(message, { status: true });
            },
            onRecovered: () => {
              if (!playback.owns(target, generation)) return;
              attemptMediaPlay(target).catch(() => {});
            },
            selectLowerRendition: () => {
              if (stableLevelPosition < 0 || stableLevelPosition + 1 >= stableLevels.length) return false;
              stableLevelPosition++;
              const lowerLevel = stableLevels[stableLevelPosition];
              // Keep automatic throughput selection enabled beneath a ceiling
              // that only moves downward during this channel session.
              // nextAutoLevel forces one lower fragment and then resets itself;
              // unlike nextLevel it does not switch hls.js into manual mode.
              // Only force it when the loaded rendition is actually higher;
              // ABR may already have chosen an even safer lower level.
              instance.autoLevelCapping = lowerLevel;
              const currentLevel = Number(instance.currentLevel);
              if (Number.isInteger(currentLevel) && currentLevel > lowerLevel) {
                instance.nextAutoLevel = lowerLevel;
              }
              return true;
            },
            onTerminal: (message) => failPlayback(message, { showNext: true }),
          });
          instance.on(HlsLib.Events.LEVEL_LOADED, (_evt, data) => {
            if (!playback.owns(target, generation) || playSession.token !== token) return;
            if (typeof data?.details?.live === 'boolean') playSession.hlsLive = data.details.live;
          });
          instance.on(HlsLib.Events.MANIFEST_PARSED, (_evt, data) => {
            if (!playback.owns(target, generation)) return;
            stableLevels = stableHlsLevelOrder(data?.levels || instance.levels, 720);
            stableLevelPosition = stableLevels.length ? 0 : -1;
            if (stableLevelPosition >= 0) {
              // Cap automatic ABR at the best declared rendition no taller
              // than 720p. Beneath that ceiling hls.js uses real fragment
              // throughput and buffer starvation to choose a sustainable
              // level; repeated stalls can lower the ceiling but never raise
              // it again during this viewing session.
              instance.autoLevelCapping = stableLevels[stableLevelPosition];
            }
            instance.startLoad(-1);
          });
          instance.loadSource(item.stream_url);
          instance.attachMedia(elements.video);
          instance.on(HlsLib.Events.ERROR, (_evt, data) => {
            if (data?.fatal && playback.owns(target, generation)) {
              hlsRecoverySession?.handleFatal(data);
            }
          });
      } else if (engine === 'native') {
        elements.video.src = item.stream_url;
      } else {
        showBrokenState('HLS playback is unavailable in this browser.', { showNext: false });
        return;
      }
    } else if (kind === 'dash') {
      try {
        const session = await createDashPlayback(elements.video, item.stream_url, {
          autoplay: false,
          onError: () => {
            if (playback.owns(target, generation)) {
              failPlayback('DASH playback failed.', { showNext: true });
            }
          },
        });
        if (stale() || !playback.owns(target, generation)) {
          session.destroy();
          return;
        }
        dashSession = session;
      } catch (error) {
        if (playback.owns(target, generation)) {
          console.warn('dash.js could not start:', error);
          showBrokenState(
            error?.message === 'DASH_MSE_UNAVAILABLE'
              ? 'DASH playback requires Media Source Extensions.'
              : 'DASH playback could not be initialized.',
            { showNext: false },
          );
        }
        return;
      }
    } else {
      elements.video.src = item.stream_url;
    }
    elements.audio.hidden = true;
    if (stale() || !playback.owns(target, generation)) return;
    if (kind === 'hls') {
      await waitForHlsStartupBuffer(target, {
        owns: () => !stale() && playback.owns(target, generation),
      });
      if (stale() || !playback.owns(target, generation)) return;
    }
    try {
      await attemptMediaPlay(elements.video);
      playbackStarted = playback.owns(target, generation) && !stale();
    } catch (e) {
      if (pausedDuringStart(e, token)) {
        syncPlaybackUi('paused-during-start');
      } else if (playback.owns(target, generation)) {
        console.warn('video play() rejected:', e);
        noteStartFailure(e, token);
        if (e?.name === 'NotAllowedError' || !startWatch.failed(token)) {
          showBrokenState('Playback did not start. Press Play to retry.', { showNext: false, retry: true });
        }
      }
    }
  } else {
    pictureStream = false;
    showVideo(false);
    elements.audio.src = item.stream_url;
    elements.video.hidden = true;
    if (stale() || !playback.owns(target, generation)) return;
    try {
      await attemptMediaPlay(elements.audio);
      playbackStarted = playback.owns(target, generation) && !stale();
    } catch (e) {
      if (pausedDuringStart(e, token)) {
        syncPlaybackUi('paused-during-start');
      } else if (playback.owns(target, generation)) {
        console.warn('audio play() rejected:', e);
        noteStartFailure(e, token);
        if (e?.name === 'NotAllowedError' || !startWatch.failed(token)) {
          showBrokenState('Playback did not start. Press Play to retry.', { showNext: false, retry: true });
        }
      }
    }
  }

  if (!playbackStarted || stale() || !playback.owns(target, generation)) return;
  verifyEqualizerSignal(target, token, generation);

  // Radio Browser click-tracking: fire-and-forget against the resolved mirror.
  if (item.source === 'radio-browser' && item._extra?.stationuuid) {
    try {
      const mod = await loadAdapter('radio-browser');
      if (typeof mod.clickCountUrl === 'function') {
        const url = await mod.clickCountUrl(item._extra.stationuuid);
        postSilent(url);
      }
    } catch (_e) { /* swallow */ }
  }
}

/**
 * Play the given Item. If the item carries `_extra.needsResolve`, defer to
 * the adapter's `resolveStream()` to populate stream_url just-in-time.
 *
 * Guarded against rapid switches: each call increments `playToken`. Async work
 * checks the token and returns early if the user has since selected something else.
 *
 * Choosing the item that is waiting to reconnect tries it at once inside the
 * same episode; anything else ends the episode and plays normally.
 */
export async function playItem(item) {
  if (reconnectPending(item)) {
    await liveResume.attemptNow();
    return;
  }
  cancelReconnect();
  startsInFlight += 1;
  try {
    await startPlayback(item);
  } finally {
    startsInFlight -= 1;
  }
}

/** The stream that connected for `item` did not play: start it again on
 *  the streams not tried yet (`tried` are left out), in the usual order. */
async function playNextStreams(item, tried) {
  // Auto: a verified stream that connected but did not play is not offered
  // again for a day.
  if (verifiedPlaying && tried.includes(verifiedPlaying.url)) verifiedDidNotPlay(item);
  startsInFlight += 1;
  try {
    await startPlayback(item, { skipStreams: tried });
  } catch (_) {
    // A blocked item: startPlayback already said so.
  } finally {
    startsInFlight -= 1;
  }
}

// Starts still on their way (setting up audio, registering the relay). Its
// media element is still empty then, which is not an ended stream: Play
// pressed meanwhile does nothing (playFromUser), so a second press never
// opens a second relay connection.
let startsInFlight = 0;

async function startPlayback(item, { skipStreams = [] } = {}) {
  if (!item) {
    showBrokenState('No item');
    return;
  }
  if (!isContentAllowed(item, getState().settings) || item.__contentHidden === true) {
    const error = new Error('This item is hidden by the explicit-content setting.');
    error.code = 'CONTENT_RATING_BLOCKED';
    emit('content-blocked', { itemId: item.id, source: item.source });
    throw error;
  }
  const myToken = ++playToken;
  startWatch.end();
  cancelScheduledCheck();
  verifiedPlaying = null;
  // Before any await: a poll still on its way for the previous station must
  // not show its song (or put it in Media Session) under the new station.
  nowPlaying.stop();
  playSession = newPlaySession(myToken);
  stallWatchdog.stop();
  setMediaPriority(true);
  cancelPendingResolution();
  repairFiniteMediaFields(item);
  persistFavoriteMetadata(item);
  activePlaybackRelayed = false;
  releaseRelay(5);
  invalidatePlaybackOwnership();
  destroyHls();
  destroyDash();
  clearMedia(elements.audio);
  clearMedia(elements.video);
  showVideo(false);
  currentItem = item;
  setCurrentItem(item);
  audioEngine.applyCurve(effectiveEqCurve(item));
  // This is intentionally the first awaited operation: AudioContext.resume()
  // must begin inside the Play/card-click user activation, before stream
  // resolution or relay registration yields back to the event loop.
  await audioEngine.resume({ create: true });
  // A switch or Stop during that await owns the player bar now.
  if (myToken !== playToken) return;
  hideBrokenState();
  setMeta(item);
  syncPlaybackUi('source-switch');

  let resolveMessage = '';
  if (item._extra?.needsResolve && !item.stream_url) {
    elements.title.textContent = shownTitle(item) || 'Loading…';
    setSourceLine(reconnectStatus || 'Resolving stream…', { status: Boolean(reconnectStatus) });
    const controller = new AbortController();
    resolutionController = controller;
    try {
      const mod = await loadAdapter(item.source);
      if (myToken !== playToken || controller.signal.aborted) return;
      if (typeof mod.resolveStream === 'function') {
        await mod.resolveStream(item, {
          signal: controller.signal,
          showExplicitContent: getState().settings.showExplicitContent === true,
        });
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && myToken === playToken) {
        console.warn('Lazy resolve failed:', err);
        resolveMessage = resolveFailureMessage(err);
      }
    } finally {
      if (resolutionController === controller) resolutionController = null;
    }
    if (myToken !== playToken) return;
    repairFiniteMediaFields(item);
    persistFavoriteMetadata(item);
    if (!isContentAllowed(item, getState().settings)) {
      emit('content-blocked', { itemId: item.id, source: item.source });
      stop();
      return;
    }
    setMeta(item);
    setCurrentItem(item);
  }

  if (myToken !== playToken) return;
  if (!item.stream_url) {
    showBrokenState(resolveMessage || 'No stream URL');
    reportUnplayable(item);
    return;
  }
  let playbackItem = item;
  let relayAvailable = false;
  const connectionController = new AbortController();
  resolutionController = connectionController;
  try {
    // Current IPTV catalog entries carry alternates. Older saved favorites do
    // not, so let an adapter refresh its bounded candidates before connecting.
    if (!Array.isArray(item._extra?.streamCandidates)) {
      try {
        const mod = await loadAdapter(item.source);
        if (myToken !== playToken) return;
        if (typeof mod.refreshStreamCandidates === 'function') {
          await mod.refreshStreamCandidates(item, { signal: connectionController.signal });
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // The saved URL is still worth one bounded attempt.
      }
      // No relay registration for a station the user already left.
      if (myToken !== playToken) return;
    }
    // Auto (verified): a better entry of this station verified before is
    // offered first; nothing is looked up or checked before a start.
    const verified = verifiedStreamFor(item, getState().settings);
    const preferBest = bestStreamOn(getState().settings);
    const extraStreams = verified ? [verified] : [];
    const relay = await connectMediaRelay(item, {
      signal: connectionController.signal, preferBest, extraStreams, skipUrls: skipStreams,
    });
    if (myToken !== playToken) {
      expireMedia(relay.media_id, 0).catch(() => {});
      return;
    }
    setActiveRelay(relay.media_id);
    playbackItem = { ...item, stream_url: relay.relay_url };
    relayAvailable = true;
    verifiedPlaying = afterBestStreamStart(item, verified) ? verified : null;
    persistFavoriteMetadata(item);
    setMeta(item);
    setCurrentItem(item);
    emit('media-relay', { available: true, mediaId: relay.media_id });
    // Auto (verified): a new playback session. The background check of this
    // station is planned at its first `playing` (onPlaying), so its wait
    // counts time with sound, not time spent connecting.
    cancelScheduledCheck();
    // Listed and Auto: should this stream connect but not play, the streams
    // not tried yet get their turn (start-failover.js). Not inside a
    // reconnect, which has its own rules.
    if (preferBest && !reconnectingCurrentItem()) {
      const tried = [...skipStreams, playedStream(item)?.url].filter(Boolean);
      if (untriedStreams(item, { extraStreams, tried }).length) startWatch.arm(myToken, item, tried);
    }
  } catch (error) {
    // Remote media is never attached directly. Besides enforcing the network
    // boundary, this keeps Web Audio/EQ behavior identical for every source.
    console.warn('Same-origin media relay unavailable; playback was not attached:', error);
    emit('media-relay', { available: false, error });
    if (myToken === playToken) {
      const registryFull = error?.code === MEDIA_REGISTRY_FULL;
      if (registryFull) {
        // Retrying cannot help until the app restarts; end any reconnect episode.
        playSession.stopReason = MEDIA_REGISTRY_FULL;
        reconnectStatus = '';
      }
      const message = registryFull
        ? MEDIA_REGISTRY_FULL_MESSAGE
        : error instanceof MediaConnectionError
          ? 'No working stream endpoint answered for this channel. Press Play to retry.'
          : 'Secure media relay unavailable. Press Play on the item to retry.';
      showBrokenState(message, {
        showNext: false,
        // Media was already torn down; keep Play so the user can retry by hand.
        retry: registryFull,
      });
      reportUnplayable(item);
    }
    return;
  } finally {
    if (resolutionController === connectionController) resolutionController = null;
  }
  await attachStream(playbackItem, myToken, { relayAvailable });
}

async function playActive() {
  const el = getActiveEl();
  if (!el) return false;
  // HLS streams attach via MediaSource so el.src may be empty even when active.
  const hasSource = !!el.src || !!hlsInstance || !!dashSession;
  if (!hasSource) return false;
  setMediaPriority(true);
  if (activePlaybackRelayed && !audioEngine.isAttached(el)) {
    await resumeEqualizerFromGesture();
  }
  if (audioEngine.isAttached(el) && !await audioEngine.resume()) {
    showBrokenState('Equalizer audio could not resume. Press Play to retry.', { showNext: false });
    return false;
  }
  try {
    await attemptMediaPlay(el);
    if (el === getActiveEl()) {
      hideBrokenState();
      if (currentItem) setMetaText(currentItem);
      syncPlaybackUi('play-resolved');
      if (audioEngine.isAttached(el)) {
        verifyEqualizerSignal(el, playToken, playback.generation);
      }
    }
    return true;
  } catch (error) {
    if (el === getActiveEl()) {
      console.warn('play() rejected:', error);
      showBrokenState('Playback did not start. Press Play to retry.', { showNext: false });
    }
    return false;
  }
}

/** Every user "play" (the Play button, Media Session, media keys) goes here,
 *  so a broken, reconnecting or given-up stream is rebuilt the same way. */
async function playFromUser() {
  // A start on its way: let it finish (the first press is being answered).
  if (startsInFlight > 0) return false;
  if (currentItem && !isContentAllowed(currentItem, getState().settings)) {
    stop();
    return false;
  }
  // Waiting to reconnect: try now, inside the same episode (one at a time).
  if (reconnectPending()) {
    await liveResume.attemptNow();
    const target = getActiveEl();
    return Boolean(target && !playbackProblem && !target.paused);
  }
  // A media element that has entered an error state cannot reliably recover
  // from another play() call. Re-register the endpoint and rebuild HLS/DASH so
  // the visible Play-to-retry promise is real.
  if (playbackProblem && currentItem) {
    const retryItem = currentItem;
    await playItem(retryItem);
    const retryTarget = getActiveEl();
    return Boolean(retryTarget && !playbackProblem && !retryTarget.paused);
  }
  // Nothing left to resume: the stream ended (a live stream whose connection
  // closed without a reconnect), the element is in an error state, or its
  // media was torn down. play() on that does nothing useful, so the item
  // starts afresh with a new connection, as after Stop.
  const active = getActiveEl();
  if (currentItem && (!active || active.ended || active.error
      || (!active.src && !hlsInstance && !dashSession))) {
    const freshItem = currentItem;
    await playItem(freshItem);
    const freshTarget = getActiveEl();
    return Boolean(freshTarget && !playbackProblem && !freshTarget.paused);
  }
  if (!active) return false;
  return playActive();
}

export async function togglePlay() {
  const el = getActiveEl();
  const playing = Boolean(el && !playbackProblem && !el.paused && !el.ended);
  // Sounding means Pause, also while a reconnect attempt is still settling.
  if (!playing || (currentItem && !isContentAllowed(currentItem, getState().settings))) {
    return playFromUser();
  }
  // A user pause ends any reconnect episode.
  return pauseFromUser();
}

export function stop() {
  cancelReconnect();
  startWatch.end();
  nowPlaying.stop(); // at once: the song and its Media Session entry go with the station
  stallWatchdog.stop();
  // Bump the token so any in-flight playItem aborts.
  playToken++;
  cancelScheduledCheck();
  verifiedPlaying = null;
  setMediaPriority(false);
  cancelPendingResolution('Playback stopped');
  releaseRelay(0);
  invalidatePlaybackOwnership();
  destroyHls();
  destroyDash();
  clearMedia(elements.audio);
  clearMedia(elements.video);
  activePlaybackRelayed = false;
  metadataArtworkToken += 1;
  hideBrokenState();
  bar.hidden = true;
  document.getElementById('app')?.classList.remove('has-player');
  showVideo(false);
  currentItem = null;
  setCurrentItem(null);
  syncPlaybackUi('stop');
}

export function setVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  elements.audio.volume = v;
  elements.video.volume = v;
  elements.vol.value = String(Math.round(v * 100));
  saveVolume(v * 100);
  syncVolumeUi();
}

// Silent means nothing can be heard: muted, or the volume turned all the way down.
export function isSilent(muted, volumePct) {
  return !!muted || Math.round(volumePct) <= 0;
}

export function volumeText(volumePct) {
  return `${Math.round(Math.max(0, Math.min(100, volumePct)))}%`;
}

function syncVolumeUi() {
  // The slider holds the user's volume; a sleep-timer fade only changes the media elements.
  const pct = Number(elements.vol.value);
  const text = volumeText(pct);
  elements.vol.title = `Volume ${text}`;
  elements.vol.setAttribute('aria-valuetext', text);
  elements.mute.dataset.silent = isSilent(elements.audio.muted, pct) ? 'true' : 'false';
}

export function getCurrentItem() { return currentItem; }
/** The song the current station announces: { itemId, mediaId, title,
 *  changedAt } or null. Changes are emitted as NOW_PLAYING_EVENT. */
export function getNowPlaying() {
  const state = nowPlaying.state;
  return state?.title ? {
    itemId: state.itemId, mediaId: state.mediaId, title: state.title, changedAt: state.changedAt,
  } : null;
}
export function getAudioEngineStatus() { return audioEngine.getStatus(); }
export function getAudioFrequencyResponse(frequencies) {
  return audioEngine.getFrequencyResponse(frequencies);
}
export function applyCurrentEq({ immediate = false } = {}) {
  if (!currentItem) return audioEngine.getStatus();
  return audioEngine.applyCurve(effectiveEqCurve(currentItem), { immediate });
}
export function previewEqCurve(curve, { immediate = false } = {}) {
  return audioEngine.applyCurve(curve, { immediate });
}
export function getCurrentMediaAction(evidence = {}) {
  return resolveMediaAction(currentItem, evidence);
}

export function isMuted() { return elements.audio.muted; }
export function setMuted(m) {
  const muted = !!m;
  elements.audio.muted = muted;
  elements.video.muted = muted;
  elements.mute.title = muted ? 'Unmute' : 'Mute';
  elements.mute.setAttribute('aria-label', elements.mute.title);
  elements.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  syncVolumeUi();
}

function bindControls() {
  elements.play.addEventListener('click', () => togglePlay());
  elements.stop.addEventListener('click', () => stop());
  elements.mute.addEventListener('click', () => setMuted(!isMuted()));
  elements.vol.addEventListener('input', (e) => setVolume(+e.target.value));
  elements.seek.addEventListener('input', (e) => {
    const el = getActiveEl();
    if (!el) return;
    el.__seeking = true;
    el.currentTime = +e.target.value;
  });
  elements.seek.addEventListener('change', () => {
    const el = getActiveEl();
    if (!el) return;
    el.__seeking = false;
  });
  elements.nextBroken.addEventListener('click', () => {
    emit('player-broken-next');
  });
  elements.fav.addEventListener('click', () => {
    if (!currentItem) return;
    if (isFavorite(currentItem.id)) {
      removeFavorite(currentItem.id);
    } else {
      addFavorite(currentItem);
    }
    syncFavButton();
  });

  // Restore persisted volume, or fall back to 80%.
  const persisted = loadVolume();
  const startVol = persisted != null ? persisted : 80;
  elements.audio.volume = startVol / 100;
  elements.video.volume = startVol / 100;
  elements.vol.value = String(startVol);
  setMuted(false);
}

function bindMediaSession() {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession?.setActionHandler) return;
  try {
    // Same retry logic as the Play button: with no source left (after giving
    // up, or a stopped reconnect) it rebuilds the stream.
    mediaSession.setActionHandler('play', () => { playFromUser().catch(() => {}); });
    mediaSession.setActionHandler('pause', () => { pauseFromUser(); });
    mediaSession.setActionHandler('stop', () => { stop(); });
  } catch (error) {
    console.warn('Media Session handlers unavailable:', error);
  }
}

export function initPlayer() {
  bindElements();
  bindControls();
  bindMediaSession();
  bindVideoSizeButton();
  bindVideoPicture();
  syncPlaybackUi('init');
  // Keep the player-bar star in sync if a Library card toggles favorites
  // for the currently-playing item.
  subscribe('favorites-change', () => {
    syncFavButton();
    applyCurrentEq();
    // A favorite renamed (or the name taken back) while it plays.
    if (currentItem && elements?.title) {
      if (metaLineShowsItem) setMetaText(currentItem);
      setArtInitials(currentItem);
      if (songMetadataSaved) syncSongMediaSession(currentSongTitle(currentItem) || null);
    }
  });
  subscribe('eq-change', () => applyCurrentEq());
  subscribe('eq-scope-change', () => applyCurrentEq());
  subscribe('eq-user-gesture', () => { resumeEqualizerFromGesture().catch(() => {}); });
  // The visual signal runs only while something plays (and someone listens).
  subscribe('playing-change', () => audioSignal.refresh());
  // ...and only while it can be heard: muting or volume 0 rests it.
  for (const el of [elements.audio, elements.video]) {
    el?.addEventListener?.('volumechange', () => audioSignal.refresh());
  }
  subscribe('content-policy-change', ({ current, currentItem: changedItem } = {}) => {
    if (current !== true && changedItem?.id === currentItem?.id
        && !isContentAllowed(currentItem, false)) stop();
  });
  // The sleep timer pauses the media itself; it must also stop reconnecting.
  subscribe('sleep-fired', () => { stopReconnecting(); });
  // "Pick the best stream" changed away from Auto: its check's session ends
  // (timer cleared, check aborted, nothing remembered from a late answer).
  subscribe('settings-change', (settings) => { followBestStreamSetting(settings); });
  // Station pictures listed, refreshed or failed: redraw the bar's picture.
  onStationImagesChange(syncPlayerStationImage);
  bindPageLifecycle();
}

/** Reload safety for the playback relay, and network-back retries. */
function bindPageLifecycle() {
  // A registration the previous page (before a reload) left behind.
  relayMemory.releaseLeftover().catch(() => {});
  const win = globalThis.window;
  if (typeof win?.addEventListener !== 'function') return;
  // Rate-limited in live-resume.js; an explicit Play still tries at once.
  win.addEventListener('online', () => { liveResume.networkBack(); });
  win.addEventListener('pagehide', (event) => {
    // A page kept in the back/forward cache may come back and keep playing.
    if (event?.persisted) return;
    const relayId = activeRelayId;
    cancelReconnect();
    if (!relayId) return;
    // Best effort. The id stays remembered, so the next page start releases
    // it again if this request is lost with the page.
    expireMedia(relayId, 0, { keepalive: true }).catch(() => {});
    relayMemory.remember(relayId);
  });
}
