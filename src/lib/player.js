/**
 * Global player controller. Single player instance for the whole app —
 * survives mode switches. Supports audio, direct video, HLS (via vendored hls.js).
 */

import { getState, setCurrentItem, setPlaying, emit, subscribe, loadVolume, saveVolume,
         addFavorite, removeFavorite, isFavorite, persistFavoriteMetadata,
         saveSettings, withComputerStars } from './state.js';
import { getSourceLabel, loadAdapter } from './sources.js';
import { postSilent } from './http.js';
import {
  artworkSourceFor, STATION_IMAGE_CLASS, isArtworkRelayUrl, loadArtworkImage, resolveArtworkRelay,
} from './artwork.js';
import { isComputerItem, rekeyComputerItem } from './item-model.js';
import {
  computerHlsToken, computerMediaToken, keepComputerMedia, measureComputerLoudness,
  openComputerMedia, releaseComputerHls, releaseComputerMedia,
} from './computer-client.js';
import { isAudiobook } from './computer-catalog.js';
import {
  computerLevelling, createLoudnessRequests, hasTrackGain, isComputerMusic, levellingMode, levellingPreamp,
  LEVELLING_RAMP_SECONDS, loudnessFields, sameLoudnessFile,
} from './computer-levelling.js';
import { computerLibrary } from './computer-library.js';
import { bindComputerTracks } from './computer-tracks.js';
import {
  computerTrackFileKey, loadComputerTrackPrefs, preferredComputerAudio, rekeyComputerTrackFile, rememberComputerTracks,
} from './computer-track-prefs.js';
import { chapterSteps } from '../modes/computer-chapters.js';
import {
  cancelComputerAdvance, clearComputerQueue, setComputerQueue, computerOpenMessage, computerQueueState, computerSubtitle,
  computerTrackFailed, resetComputerTrackFailures, createComputerResume, isComputerFormatError, moveComputerQueue,
  computerHlsConfig, computerHlsErrorMessage, isComputerFolderRefusal, makeComputerItem, moveComputerQueueEntries,
} from './computer-play.js';
import {
  markStationImageFailed, onStationImagesChange, peekStationImageUrl, stationImageSourceFor, stationImageUrl,
} from './station-images.js';
import { artworkInitials, initialsHue } from './initials.js';
import { createPlaybackState } from './player-state.js';
import { repairFiniteMediaFields, resolveMediaAction } from './media-capabilities.js';
import { expireMedia } from './capture-client.js';
import {
  connectMediaRelay, hostLookupFailureMessage, MediaConnectionError, MEDIA_REGISTRY_FULL, MEDIA_REGISTRY_FULL_MESSAGE,
  playedStream, relayWasProbed,
} from './media-failover.js';
import {
  createLiveResume, createStallWatchdog, isLiveMedia, RECONNECTING_TEXT, RECONNECT_GAVE_UP_TEXT, RECONNECT_STOPPED_TEXT,
} from './live-resume.js';
import { createRelayMemory } from './relay-memory.js';
import { resolveFailureMessage } from './resolve-message.js';
import { createAudioEngine } from './audio-engine.js';
import { createAudioSignal } from './audio-signal.js';
import { bindVolumeStepper, clampVolume, elementVolumeChange } from './volume-stepper.js';
import { getEffectiveEq, loadEqState } from './eq-store.js';
import { createDashPlayback } from './dash-player.js';
import { createHlsVideoQuality, createVideoQuality, observePictureSize, videoQualityLevel } from './video-quality.js';
import {
  createHlsRecoveryController, hlsPlaybackConfig,
  selectHlsPlaybackEngine, waitForHlsStartupBuffer,
} from './hls-recovery.js';
import { isContentAllowed } from './content-rating.js';
import { expectsPicture, hasPicture } from './video-picture.js';
import { bindPicturePanel } from './picture-panel.js';
import { createNowPlayingPoller, NOW_PLAYING_EVENT, songLine } from './now-playing.js';
import { formatStreamQuality, playedQualityLabel } from './stream-quality.js';
import { stationStreamAddresses } from './station-stream-addresses.js';
import { createPlayedStreamNote, streamFactsFromHlsLevel } from './played-streams.js';
import { favoriteName } from './favorite-names.js';
import { bestStreamOn } from './best-stream.js';
import {
  afterStart as afterBestStreamStart, cancelScheduledCheck, followBestStreamSetting, resumeCheck, verifiedDidNotPlay,
  verifiedStreamFor,
} from './best-stream-auto.js';
import { createStartWatch, START_FAILOVER_MS, untriedStreams } from './start-failover.js';
import { verifiedLabel } from './stream-verify.js';
import { MEDIA_ADVANCING_EVENT, playClock } from './play-clock.js';
import { createStartOutcome, startFailureKind } from './did-not-play.js';
import { hasPartsSource, itemForPart, loadParts, partLabel, resumablePart } from './media-parts.js';
import { partResumeGeneration, readPartResume, rememberPartResume } from './part-resume.js';

export const PLAYER_SILENT_CHANGE = 'player-silent-change';
export const COMPUTER_CONVERTED_CHANGE = 'computer-converted-change';
export const COMPUTER_LEVELLING_CHANGE = 'computer-levelling-change';

let Hls = null;
let hlsLoader = loadHlsIfNeeded;
let hlsInstance = null;
let hlsRecoverySession = null;
let hlsVideoQuality = null;
let videoQuality = null;
let stopObservingPictureSize = null;
let dashSession = null;
let currentItem = null;
let partPlayback = null;
let computerPlayback = null;
let computerStandby = null;
let standbyOpening = false;
let pendingComputerStart = null;
const COMPUTER_PREPARING_MS = 400;
// Only promote a recent buffer, within the server's 120-second standby lease.
const STANDBY_MAX_AGE_MS = 60_000;
let computerTracks = null;
let restoreComputerAudioPoster = null;
let computerTrackMessage = '';
let computerTrackMessageTimer;
let computerOpenRetryable = false;
let computerStartAt;
let computerRetryConvert = false;
let pendingPartResume = null;
let bar = null;
let elements = null;
let playerSilent = false;
let playbackProblem = null;
let pendingPlay = null;
let mediaPriorityActive = false;
let playAttemptToken = 0;
const playback = createPlaybackState();
const mediaEventBindings = new Map();
let playbackActions = 0;
let playToken = 0; // monotonic counter — guards against rapid item switches
// Auto (verified): the verified better stream the current station plays on.
let verifiedPlaying = null;
// Listed and Auto: a stream that connected but did not play releases the
// streams not tried yet (start-failover.js).
const startWatch = createStartWatch({
  onNext: (item, tried, token) => {
    // Not this start's result yet: the next stream has its own time limit.
    startOutcome.handOver(item.id);
    // Never inside the callback that reported the failure (hls.js, dash.js).
    queueMicrotask(() => {
      if (token === playToken && currentItem?.id === item.id && streamAddressesCurrent()) playNextStreams(item, tried);
    });
  },
});

// "Did not play last time" (did-not-play.js): the result of each start the
// user asked for. It only listens: a play is never held up or stopped by it.
// Past the start time limit, a stream that another stream is about to take
// over from (start-failover.js) is not the result yet.
const startOutcome = createStartOutcome({ limitMs: START_FAILOVER_MS, handingOver: () => startWatch.active });

/** The verified better stream the current station plays on, or null. */
export function getVerifiedStream() {
  return verifiedPlaying && currentItem ? { itemId: currentItem.id, ...verifiedPlaying } : null;
}
let resolutionController = null;
let eqSignalMonitorToken = 0; // cancels stale/duplicate analyser checks
let activeRelayId = '';
let activePlaybackRelayed = false;
let metadataArtworkToken = 0;
const audioStarts = new Set();
const audioEngine = createAudioEngine({
  isPlaybackPending: () => audioStarts.size > 0 || Boolean(pendingComputerStart)
    || (pendingPlay && playback.owns(pendingPlay.element, pendingPlay.generation)),
  onStatus: (status) => emit('eq-engine-change', status),
});

async function duringAudioStart(start) {
  const pending = {};
  audioStarts.add(pending);
  audioEngine.updateIdle();
  try {
    return await start();
  } finally {
    audioStarts.delete(pending);
    audioEngine.updateIdle();
  }
}

function clearAudioStarts() {
  audioStarts.clear();
  audioEngine.updateIdle();
}

let levellingDetails = null;
const loudnessRequests = createLoudnessRequests({
  measure: measureComputerLoudness,
  onResult(file, fields) {
    computerLibrary.acceptLoudness(file, fields);
    const entry = computerPlayback?.loudnessEntry;
    if (!entry || !sameLoudnessFile(entry, file) || hasTrackGain(entry)) return;
    computerPlayback.loudnessEntry = { ...entry, ...fields };
    Object.assign(currentItem._extra.computer, fields);
    applyComputerLevelling();
  },
});

// The sound for visuals (the player-bar meter), read from the engine's side
// tap. Only same-origin playback attached to a running graph is read.
// Nothing here creates or resumes the context.
let gaplessSignalSource;
const signalSourceKey = () => gaplessSignalSource?.generation === playback.generation
  ? gaplessSignalSource.key : `${playToken}:${playback.generation}`;

const audioSignal = createAudioSignal({
  source: {
    isPlaying: () => getState().isPlaying === true,
    // Muted or turned all the way down (by hand or a sleep-timer fade): the
    // meter rests. Both elements are muted and set together (setMuted,
    // setVolume); a volumechange on either calls refresh() (initPlayer).
    isAudible: () => !isPlayerSilent(),
    // The volume the tap hears the sound at (it is after the element's
    // volume); read once per frame, so the visualizer can make up for it.
    getVolume: () => {
      const el = playback.activeElement || elements?.audio;
      const volume = Number(el?.volume);
      return Number.isFinite(volume) ? volume : 1;
    },
    getAnalyser: () => {
      const el = playback.activeElement;
      if (!el || !activePlaybackRelayed || playbackProblem || ((el.paused || el.ended) && !readyComputerStandby(el))) return null;
      return audioEngine.visualTapFor(el);
    },
    release: () => audioEngine.releaseVisualTap(),
    // A gapless handoff keeps reading the same post-EQ tap.
    getSourceKey: signalSourceKey,
    getHandoffTime: () => gaplessSignalSource?.generation === playback.generation
      ? gaplessSignalSource.time : undefined,
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
    addressSignature: '',
    orderedAddresses: false,
    candidate: null,
    played: false, // the playhead really moved forward 1 s after a `playing` event
    lastTime: null, // playhead at the last sample; null until `playing`
    lastSampleAt: 0, // wall-clock time of that sample
    progressed: 0,
    seeking: false,
    duration: undefined, // last known duration; NaN (unknown) is never stored
    lengthGrowth: null, // the lengths reported in this start (trackLengthGrowth)
    unbounded: false, // the duration was Infinity at some point of this start
    hlsLevel: null,
    hasVideoTrack: null,
    hlsLive: null, // hls.js playlist type, once known
    stopReason: '', // a failure that must end an auto-reconnect episode
    userPaused: false, // the user paused while the first play() was pending
    sleepExpired: false,
  };
}
let playSession = newPlaySession(0);

function streamAddressesCurrent() {
  return !isComputerItem(currentItem)
    && JSON.stringify(stationStreamAddresses(currentItem)) === playSession.addressSignature;
}

function activeStreamKind() {
  return computerPlayback?.kind || playSession.candidate?.kind || currentItem?.stream_kind;
}

// Auto-reconnect for live streams that drop after playing (see live-resume.js).
let reconnectItem = null;
let reconnectTried = new Set();
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
    // The ordinary stall watchdog resumes after reconnect probation.
    watchForStall();
  },
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
});

// Watch started chapters and plain live streams for a frozen playhead.
// HLS has its own progress watchdog in hls-recovery.js.
let stallWatchToken = 0;
const stallWatchdog = createStallWatchdog({
  read: () => stallWatchState(),
  onStall: () => {
    if (stallWatchToken !== playToken || !stallWatchState().eligible) return;
    if (partPlayback) failPlayback('This part stopped loading. Press Play to retry.', { showNext: false, retry: true });
    else failPlayback('Playback error');
  },
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
});

function plainLiveStream() {
  const kind = activeStreamKind();
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
// The format and bitrate the relay read from the station's reply come with
// the same poll; they are remembered once the start has played
// (played-streams.js).
const playedStreamNote = createPlayedStreamNote();
const nowPlaying = createNowPlayingPoller({
  onChange: (state) => onSongChange(state),
  onStream: ({ itemId, stream }) => {
    if (itemId && itemId === currentItem?.id && streamAddressesCurrent()) playedStreamNote.heard(itemId, stream);
  },
  now: () => Date.now(),
});
let metaLineShowsItem = false; // the meta line shows the item's own line, not a status
let songMetadataSaved = false; // Media Session metadata was replaced by a song
let metadataBeforeSong = null;
let computerMediaMetadata = null;

function syncComputerMediaSession(item, artwork = elements?.art.getAttribute('src') || '') {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession || typeof globalThis.MediaMetadata !== 'function') return;
  try {
    if (isComputerItem(item)) {
      const { artist, album, episodeTitle } = item._extra?.computer || {};
      computerMediaMetadata ??= { previous: mediaSession.metadata ?? null };
      mediaSession.metadata = new globalThis.MediaMetadata({
        title: shownTitle(item), artist: episodeTitle ?? artist ?? '', album: album || '',
        artwork: artwork ? [{ src: artwork }] : [],
      });
    } else if (computerMediaMetadata) {
      mediaSession.metadata = computerMediaMetadata.previous;
      computerMediaMetadata = null;
    }
  } catch (_) {}
}

function songTitleEligible() {
  const el = playback.activeElement;
  return Boolean(elements && currentItem && !isComputerItem(currentItem) && activeRelayId && activePlaybackRelayed
    && el === elements.audio && activeStreamKind() === 'audio'
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
  const eligible = Boolean(el && currentItem && !isComputerItem(currentItem) && stallWatchToken === playToken
    && playSession.token === playToken && !el.paused && !el.ended
    && !playSession.seeking && !playbackProblem && !liveResume.active
    && (partPlayback ? partPlayback.started : plainLiveStream()));
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
    standby:  $('computer-audio-el'),
    video:    $('video-el'),
    title:    $('player-title'),
    source:   $('player-source'),
    art:      $('player-art'),
    artInitials: $('player-art-initials'),
    play:     $('player-play'),
    iconPlay: $('icon-play'),
    iconPause:$('icon-pause'),
    stop:     $('player-stop'),
    previousPartSlot: $('player-previous-part-slot'),
    nextPartSlot: $('player-next-part-slot'),
    previousPart: $('player-previous-part'),
    nextPart: $('player-next-part'),
    resumeActions: $('player-resume-actions'),
    resumePart: $('player-resume-part'),
    startOver: $('player-start-over'),
    seek:     $('player-seek'),
    time:     $('player-time'),
    dur:      $('player-dur'),
    vol:      $('player-volume'),
    volControl: $('player-volume-control'),
    volDown:  $('player-volume-down'),
    volUp:    $('player-volume-up'),
    volReadout: $('player-volume-readout'),
    mute:     $('player-mute'),
    nextBroken: $('player-next-broken'),
    capture: $('player-capture'),
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
  videoQuality?.sync();
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

let setPictureItem = () => {};
let videoClearanceTimer = null;

function setVideoClearance(state) {
  clearTimeout(videoClearanceTimer);
  videoClearanceTimer = null;
  const app = $('app');
  if (!app) return;
  if (state) app.dataset.videoClearance = state;
  else delete app.dataset.videoClearance;
}

function releaseVideoClearance() {
  if (videoClearanceTimer !== null) setVideoClearance('released');
}

function reserveVideoClearance(item) {
  const expected = expectsPicture(item);
  if (expected && videoClearanceTimer !== null) return;
  if (!expected || elements.video.hidden || !hasPicture(elements.video)) {
    setVideoClearance();
    return;
  }
  setVideoClearance('reserved');
  videoClearanceTimer = setTimeout(releaseVideoClearance, START_FAILOVER_MS);
}

function syncVideoClearance(height) {
  const app = $('app');
  const video = elements.video;
  if (!app?.dataset.videoClearance || getActiveEl() !== video || !(video.readyState >= 2)) return;
  if (!hasPicture(video)) {
    releaseVideoClearance();
    return;
  }
  if (video.hidden) return;
  if (!document.fullscreenElement) {
    // The first real picture can have the same box size as the loading box,
    // so there may be no new ResizeObserver notification.
    const measuredHeight = height ?? video.getBoundingClientRect().height;
    if (!(measuredHeight > 0)) return;
    app.style.setProperty('--video-height', `${measuredHeight}px`);
  }
  setVideoClearance();
}

function syncVideoPicture() {
  const pictureStream = getActiveEl() === elements.video;
  if (pictureStream && hasPicture(elements.video)) showVideo(true);
  syncVideoClearance();
}

// A visible box counts once, even if metadata or a fullscreen change
// reports the picture again. The reservation itself survives the gaps.
let tunerVideoHandled = false;
// An explicit Radio selection takes precedence over a TV stream still open.
let tunerRadioSelected = false;

function reserveTunerVideoSpace() {
  if (tunerVideoHandled || elements.video.hidden || getState().mode !== 'tuner') return;
  tunerVideoHandled = true;
  if (!tunerRadioSelected && expectsPicture(currentItem)) $('app')?.classList.add('tuner-video-reserved');
}

function releaseTunerVideoSpace() {
  tunerVideoHandled = !elements.video.hidden;
  $('app')?.classList.remove('tuner-video-reserved');
}

export function setTunerVideoBand(band) {
  tunerRadioSelected = band === 'radio';
  if (tunerRadioSelected) releaseTunerVideoSpace();
}

function bindVideoPicture() {
  subscribe('mode-change', reserveTunerVideoSpace);
  subscribe(MEDIA_ADVANCING_EVENT, (advancing) => {
    if (advancing && currentItem && (getActiveEl() === elements.audio || !expectsPicture(currentItem))) {
      releaseTunerVideoSpace();
    }
  });
  elements.video.addEventListener?.('loadedmetadata', syncVideoPicture);
  elements.video.addEventListener?.('loadeddata', () => syncVideoClearance());
  elements.video.addEventListener?.('resize', syncVideoPicture);
  const app = $('app');
  stopObservingPictureSize?.();
  stopObservingPictureSize = observePictureSize(elements.video, videoQuality.sync, {
    onObserved: ([entry]) => {
      // Keep the windowed height so the page keeps its scroll position.
      if (document.fullscreenElement || !app) return;
      const height = entry.borderBoxSize[0].blockSize;
      // Keep the old height through the hidden and provisional video boxes.
      if (app.dataset.videoClearance) syncVideoClearance(height);
      else app.style.setProperty('--video-height', `${height}px`);
    },
  });
}

function noteHlsAudio() {
  if (!streamAddressesCurrent()) return;
  const facts = hlsInstance ? streamFactsFromHlsLevel(playSession.hlsLevel, { audioOnly: true }) : { hls: true };
  if (facts) playedStreamNote.heard(currentItem?.id, facts, playSession.candidate?.url);
}

function syncVideoTrack(video) {
  if (isComputerItem(currentItem)) return;
  const hasVideoTrack = hasPicture(video);
  if (hasVideoTrack || hasVideoTrack !== playSession.hasVideoTrack) {
    playedStreamNote.renditionChanged();
    playSession.hasVideoTrack = hasVideoTrack;
    if (!hasVideoTrack && activeStreamKind() === 'hls') noteHlsAudio();
  }
}

function showVideo(show) {
  elements.video.hidden = !show;
  setPictureItem(show ? currentItem : null);
  if (!show) elements.video.classList.remove('is-live-video');
  $('app')?.classList.toggle('has-video', !!show);
  if (show) reserveTunerVideoSpace();
  else tunerVideoHandled = false;
  if (show) videoQuality?.sync();
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
  if (hlsVideoQuality) videoQuality?.clearSource(hlsVideoQuality);
  hlsVideoQuality = null;
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

/** True for media with a finite length (a file, a podcast episode), which the
 *  seek bar can move along; false for a live stream. */
export function hasSeekableLength(duration) {
  return Number.isFinite(duration) && duration > 0;
}

/**
 * When a reported length counts as growing like a live stream's (for items
 * listed neither as live nor as on demand): it grew on at least `steps`
 * separate updates (each by `minStepSeconds` or more), the first of the
 * lengths and the latest growth are `spanMs` or more apart, and it grew by
 * about the time that passed (between `minPace` and `maxPace` times it). A
 * file whose length is corrected once or twice while it downloads is not
 * growing; a live HLS list whose end moves on with each segment is.
 */
export const LIVE_GROWTH = Object.freeze({ steps: 3, spanMs: 10_000, minStepSeconds: 0.5, minPace: 0.5, maxPace: 2 });

function lengthTrack(length, at) {
  return { firstLength: length, firstAt: at, lastLength: length, steps: 0, growing: false };
}

/**
 * Follows the lengths one start of an item reports (`at`: a clock in ms);
 * returns the next track. Once growing, it stays so for that start. A length
 * that gets shorter starts the watch again from there.
 */
export function trackLengthGrowth(track, duration, at) {
  if (!(Number.isFinite(duration) && duration > 0) || !Number.isFinite(at)) return track || null;
  if (!track) return lengthTrack(duration, at);
  if (track.growing) return track;
  if (duration <= track.lastLength - LIVE_GROWTH.minStepSeconds) return lengthTrack(duration, at);
  if (duration < track.lastLength + LIVE_GROWTH.minStepSeconds) return track;
  const steps = track.steps + 1;
  const span = (at - track.firstAt) / 1000;
  const grown = duration - track.firstLength;
  const growing = steps >= LIVE_GROWTH.steps && span * 1000 >= LIVE_GROWTH.spanMs
    && grown >= span * LIVE_GROWTH.minPace && grown <= span * LIVE_GROWTH.maxPace;
  return { ...track, lastLength: duration, steps, growing };
}

/** An item listed as live media: a radio or TV station, or a live delivery. */
function listedLive(delivery, type) {
  return delivery === 'live' || (delivery !== 'on-demand' && (type === 'radio' || type === 'tv'));
}

/**
 * What the player bar shows for the media playing now. `live`: no seek bar
 * and no length, and the time label shows the time played (play-clock.js),
 * because a live stream's own position means nothing to the listener (a
 * sliding live window, or a broadcast clock: "498673:51:06"). `seekable`:
 * a seek bar and the length.
 *
 * In this order:
 * 1. An item listed as on demand (a film, a podcast episode) is never live,
 *    whatever hls.js or dash.js report.
 * 2. An item listed as live (a radio or TV station, a live delivery) is live
 *    from the start, while the player is still finding out, so its seek bar
 *    never shows and then goes. The player's word that the stream is a
 *    complete recording gives it a seek bar: hls.js (`details.live` false: a
 *    VOD or ended list) or dash.js (static). Played directly (`direct`: no
 *    hls.js, no dash.js; a playlist entry listed as a station may point at a
 *    plain MP3), it is a recording once the element reports a finite length
 *    that is not growing. Native HLS can report a complete recording once
 *    it offers a seekable range with a finite duration.
 * 3. Any other item: what the HLS or DASH player reports, else an endless
 *    length or a length that keeps growing with the clock (LIVE_GROWTH).
 * A length not known yet gives no seek bar in any case.
 */
export function mediaTimeline({
  duration, delivery = '', type = '', hlsLive = null, dashLive = null, durationGrowing = false,
  direct = false,
} = {}) {
  let live;
  if (delivery === 'on-demand') live = false;
  else if (typeof hlsLive === 'boolean') live = hlsLive;
  else if (typeof dashLive === 'boolean') live = dashLive;
  else if (listedLive(delivery, type)) live = !direct || !hasSeekableLength(duration) || durationGrowing;
  else live = duration === Number.POSITIVE_INFINITY || durationGrowing;
  return { live, seekable: !live && hasSeekableLength(duration) };
}

/** Whether dash.js says the stream is live; null while it cannot tell. */
function dashLiveNow() {
  try {
    const value = dashSession?.isLive?.();
    return typeof value === 'boolean' ? value : null;
  } catch (_) {
    return null;
  }
}

/** Seconds the current item has played (play-clock.js); 0 before it has. */
function playedSeconds() {
  const played = playClock.played(currentItem?.id);
  return played == null ? 0 : played / 1000;
}

// Whether the media really advances now: true from the element's `playing`
// event until `waiting` (out of data), a pause, the end, an error, a switch
// or Stop. `play` alone (isPlaying) can come long before any sound. Published
// as MEDIA_ADVANCING_EVENT for the play clock (play-clock.js).
let mediaAdvancing = false;

function setMediaAdvancing(next) {
  const value = next === true;
  if (value === mediaAdvancing) return;
  mediaAdvancing = value;
  emit(MEDIA_ADVANCING_EVENT, value);
}

/** Whether the media advances now (see setMediaAdvancing). */
export function isMediaAdvancing() { return mediaAdvancing; }

// Only observed evidence changes delivery. In particular, an unknown
// duration can look live in the controls while capture is still checking.
let timelineNote = null;

function noteTimeline(delivery = 'unknown') {
  if (isComputerItem(currentItem)) return;
  const itemId = currentItem?.id || '';
  const session = playToken;
  const stream = playSession.candidate;
  if (timelineNote?.session === session && timelineNote.stream === stream
      && timelineNote.delivery === delivery) return;
  timelineNote = { session, stream, delivery };
  emit('media-timeline', { itemId, delivery });
}

/** The only writer of global playback state, play/pause affordances, and seek UI. */
function syncPlaybackUi(reason = 'sync') {
  if (!elements) return;
  const el = playback.activeElement;
  if (el?.ended && getState().isPlaying && readyComputerStandby(el)) return;
  const hasSource = Boolean(el && (el.src || el.currentSrc || hlsInstance || dashSession));
  const isPlaying = Boolean(
    el && hasSource && !playbackProblem && !el.paused && !el.ended
  );

  if (getState().isPlaying !== isPlaying) setPlaying(isPlaying);
  // Not playing is never advancing; only `playing` sets it (bindMediaEvents).
  if (!isPlaying) setMediaAdvancing(false);
  elements.iconPlay.toggleAttribute('hidden', isPlaying);
  elements.iconPause.toggleAttribute('hidden', !isPlaying);
  const action = isPlaying ? 'Pause' : 'Play';
  elements.play.title = action;
  elements.play.setAttribute('aria-label', action);
  elements.play.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  // A reconnecting or given-up live stream keeps Play available even after its
  // media was torn down: pressing it runs the full rebuild.
  const canRetry = Boolean(currentItem && (playbackProblem?.retry || canRestartComputerSession()));
  // While the next item connects (no source yet, no problem) Play stays in
  // place, only disabled: hiding it for that moment narrowed the controls
  // column, so the whole bar (title, sound meter, times) jumped sideways and
  // back on every station change, for example each step of the Tuner dial.
  const switching = Boolean(currentItem && !hasSource && !playbackProblem);
  elements.play.hidden = !currentItem || (!hasSource && !canRetry && !switching);
  elements.play.disabled = Boolean(pendingPartResume || (!hasSource && !canRetry));
  syncPartControls();

  let liveVideo = false;
  if (el) {
    const duration = computerDuration(el);
    const position = computerPlayback?.finished && hasSeekableLength(duration)
      ? duration : computerPosition(el);
    const dashLive = dashLiveNow();
    const nativeHls = !hlsInstance && activeStreamKind() === 'hls';
    const hlsLive = nativeHls && hasSeekableLength(el.duration)
      ? !el.seekable?.length : playSession.hlsLive;
    const timeline = mediaTimeline({
      duration,
      delivery: currentItem?.delivery,
      type: currentItem?.type,
      hlsLive,
      dashLive,
      durationGrowing: playSession.lengthGrowth?.growing === true,
      // Played by the element itself: no hls.js or dash.js to say live or not.
      direct: !hlsInstance && !dashSession,
    });
    liveVideo = el === elements.video && !el.hidden && timeline.live;
    const manifestLive = hlsLive ?? dashLive;
    if (manifestLive != null) noteTimeline(manifestLive ? 'live' : 'on-demand');
    else if (el.duration === Infinity || playSession.lengthGrowth?.growing) noteTimeline('live');
    else if (!hlsInstance && !dashSession && (hasSeekableLength(el.duration) || hasSeekableLength(playSession.duration))) {
      noteTimeline('on-demand');
    } else noteTimeline();
    // Live: the time played, never the stream's own position.
    elements.time.textContent = fmtTime(timeline.live ? playedSeconds() : position);
    const withLength = timeline.seekable;
    // A live stream (internet radio, live TV) cannot be moved along: its
    // seek bar and the empty length beside it are not shown. They keep their
    // space (visibility only), so nothing in the bar moves. An item listed as
    // on demand keeps its seek bar from the press of Play on, disabled until
    // its length is known, so the bar does not show, go and come back. Not
    // when its length turns out to be endless: that bar could never be used.
    const showSeek = withLength
      || (currentItem?.delivery === 'on-demand' && el.duration !== Infinity);
    elements.seek.classList.toggle('is-no-length', !showSeek);
    elements.dur.classList.toggle('is-no-length', !showSeek);
    // Live: on a wide bar the name column takes the seek bar's room (base.css).
    elements.seek.classList.toggle('is-live', timeline.live);
    if (withLength) {
      elements.seek.disabled = false;
      elements.dur.textContent = fmtTime(duration);
      elements.seek.max = String(Math.floor(duration));
      if (!el.__seeking) elements.seek.value = String(Math.floor(position));
    } else {
      elements.seek.disabled = true;
      elements.dur.textContent = '--:--';
      elements.seek.value = '0';
    }
  } else if (currentItem && listedLive(currentItem.delivery, currentItem.type)) {
    // No media yet (connecting, switching, reconnecting, or a start that
    // failed) for an item listed as live: the bar looks as it will once the
    // stream plays, so no seek bar shows and then goes.
    elements.seek.classList.add('is-no-length');
    elements.dur.classList.add('is-no-length');
    elements.seek.classList.add('is-live');
    elements.time.textContent = fmtTime(playedSeconds());
    elements.dur.textContent = '--:--';
    elements.seek.disabled = true;
    elements.seek.value = '0';
  } else {
    elements.seek.classList.remove('is-no-length');
    elements.dur.classList.remove('is-no-length');
    elements.seek.classList.remove('is-live');
    elements.time.textContent = '--:--';
    elements.dur.textContent = '--:--';
    elements.seek.disabled = true;
    elements.seek.value = '0';
  }
  if (!el) noteTimeline();
  elements.video.classList.toggle('is-live-video', liveVideo);

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
function setSourceLine(text, { status = false, hover = '', itemLine = false, song = false } = {}) {
  elements.source.textContent = text;
  elements.source.title = status ? text : hover;
  metaLineShowsItem = itemLine && !status;
  // The song stands out (larger, brighter; base.css .player-source.is-song).
  elements.source.classList?.toggle?.('is-song', song === true && !status);
}

function clearComputerTrackMessage() {
  clearTimeout(computerTrackMessageTimer);
  computerTrackMessage = '';
}

export function showComputerPlayMessage(message, { transient = false, duration = 4_000 } = {}) {
  if (!currentItem || !elements || bar.hidden) return false;
  clearComputerTrackMessage();
  setSourceLine(message, { status: true });
  if (transient) {
    computerTrackMessage = message;
    computerTrackMessageTimer = setTimeout(() => {
      computerTrackMessage = '';
      if (elements.source.textContent !== message) return;
      if (playbackProblem) {
        setSourceLine(reconnectStatus || playbackProblem.message || 'This stream could not be played', { status: true });
      } else setMetaText(currentItem);
    }, duration);
  }
  return true;
}

export function showComputerSelectionMessage(message) {
  clearPendingComputerStart();
  return showComputerPlayMessage(message, { transient: true, duration: 5_000 });
}

/** Play failed before there was any playable stream. The capture controls
 *  stop showing "Checking…" for it, and offer no recording, until the next
 *  Play of an item starts. */
function reportUnplayable(item) {
  emit('media-unplayable', { itemId: item?.id || '' });
}

function showBrokenState(msg, { showNext = true, retry = false } = {}) {
  releaseVideoClearance();
  stallWatchdog.stop();
  setTitleLine(shownTitle(currentItem) || 'Stream unavailable');
  // While a reconnect episode runs, a failed attempt keeps saying so.
  setSourceLine(reconnectStatus || msg || 'This stream could not be played', { status: true });
  playbackProblem = { message: msg, showNext, retry: retry === true };
  setMediaPriority(false);
  elements.nextBroken.hidden = isComputerItem(currentItem) || !showNext;
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
  if (!currentItem || partPlayback || isComputerItem(currentItem)) return false;
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
    rememberCurrentPosition();
    showBrokenState(msg, options);
    // A start that never played (a stream that played already ended its
    // start's watch, so this changes nothing for it). Unreachable unless its
    // stream had answered.
    startOutcome.failed(currentItem?.id, 'stream');
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
      reconnectTried = new Set();
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
  playbackActions++;
  startWatch.end();
  playAttemptToken++;
  // A pause during a start is no result for "Did not play last time".
  startOutcome.cancel();
  const el = getActiveEl();
  if (isComputerItem(currentItem)) playSession.userPaused = true;
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
  clearAudioStarts();
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
  releaseVideoClearance();
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
  if (playSession.lastTime == null || playSession.seeking || el.paused || el.ended) return;
  const reconnecting = reconnectingCurrentItem();
  const videoFacts = el === elements.video && hasPicture(el);
  if (playSession.played && !reconnecting && !hlsInstance && !videoFacts) return;
  const time = Number(el.currentTime);
  if (!Number.isFinite(time)) return;
  const sampledAt = Date.now();
  const step = time - playSession.lastTime;
  const elapsed = Math.max(0, sampledAt - playSession.lastSampleAt) / 1000;
  playSession.lastTime = time;
  playSession.lastSampleAt = sampledAt;
  if (step <= 0 || step > elapsed + PROGRESS_SLACK_SECONDS) return;
  if (reconnecting) liveResume.noteProgress(step * 1000);
  if (videoFacts && streamAddressesCurrent()) {
    const rendition = dashSession ? dashSession.videoRepresentation() : playSession.hlsLevel;
    playedStreamNote.videoProgress(currentItem?.id, playSession.candidate?.url, el, activeStreamKind(),
      rendition, Math.min(step, elapsed) * 1000);
  } else if (hlsInstance && !videoFacts) playedStreamNote.progress(step * 1000);
  if (playSession.played) return;
  playSession.progressed += step;
  // Listed and Auto: it began; the start watch's confirm window runs.
  startWatch.moved(playToken);
  if (playSession.progressed >= 1) {
    playSession.played = true;
    startWatch.end();
    if (streamAddressesCurrent()) {
      // It plays: forget an earlier failure and remember the stream facts.
      startOutcome.played(currentItem?.id);
      playedStreamNote.played(currentItem?.id);
    }
  }
}

function noteSeeking(el, seeking) {
  playSession.seeking = seeking;
  if (seeking) stallWatchdog.stop();
  // A seek's jump is never progress: continue counting from where it landed.
  if (!seeking && playSession.lastTime != null) startProgressSample(el);
  // Watch again from where it landed: a stream frozen there sends no further
  // timeupdate or playing. A no-op unless the usual conditions hold.
  if (!seeking && !computerPlayback) watchForStall();
}

function noteDuration(el) {
  const duration = Number(el.duration);
  if (Number.isNaN(duration)) return;
  playSession.duration = duration;
  // A plain live stream has no length while it plays. When its connection
  // closes, the element reports the time played as the length just before
  // `ended`; the start stays known as unbounded so that end is still a drop.
  if (duration === Number.POSITIVE_INFINITY) playSession.unbounded = true;
  playSession.lengthGrowth = trackLengthGrowth(playSession.lengthGrowth, duration, Date.now());
}

function noteStartFailure(error, token) {
  if (error?.name !== 'NotAllowedError' || playSession.token !== token) return;
  // Autoplay policy: never loop on play(); end any episode with the normal message.
  playSession.stopReason = 'NotAllowedError';
  reconnectStatus = '';
}

async function attemptMediaPlay(el) {
  const attempt = ++playAttemptToken;
  const generation = playback.generation;
  pendingPlay = { element: el, attempt, generation };
  audioEngine.updateIdle();
  try {
    // The running path reaches play() synchronously, including gapless handoffs.
    if (audioEngine.isAttached(el) && !audioEngine.isRunning()) {
      const ready = await audioEngine.resume();
      if (attempt !== playAttemptToken || !playback.owns(el, generation)) return false;
      if (!ready) {
        const message = 'Equalizer audio could not resume. Press Play to retry.';
        if (computerPlayback?.hls) failComputerPlayback(message, { countFailure: false });
        else showBrokenState(message, { showNext: false });
        return false;
      }
    }
    await el.play();
    return true;
  } finally {
    if (pendingPlay?.attempt === attempt) pendingPlay = null;
    audioEngine.updateIdle();
  }
}

function unbindMediaEvents(el) {
  const bindings = mediaEventBindings.get(el);
  if (!bindings) return;
  for (const [name, handler] of bindings) el.removeEventListener(name, handler);
  mediaEventBindings.delete(el);
}

function selectPart(parts, index, position, epoch) {
  partPlayback = {
    parts, index, position, epoch, seekPending: position > 0,
    started: false, finished: false, savedAt: -Infinity,
  };
}

function remembersPart(item, parts) {
  return parts.length > 1 || item.source === 'librivox';
}

function rememberCurrentPosition(el = getActiveEl(), { force = true } = {}) {
  const local = computerPlayback;
  if (local) {
    if (local.started && !local.seekPending && !local.finished && !playbackProblem && el && !el.ended
        && (force || !el.paused)) local.resume.save(el, force, computerAdvanced(local, el));
    return;
  }
  const part = partPlayback;
  if (!part?.started || part.seekPending || part.finished || playbackProblem || !el
      || !remembersPart(currentItem, part.parts)) return;
  const seconds = el.currentTime;
  if (!Number.isFinite(seconds) || seconds < 0) return;
  part.position = seconds;
  const now = Date.now();
  if (!force && now - part.savedAt < 15_000) return;
  part.savedAt = now;
  rememberPartResume(currentItem.id, part.parts[part.index].key, seconds, part.epoch);
}

function sleepAllowsPlayback() {
  const deadline = getState().sleepTimer.until;
  return !playSession.sleepExpired && (deadline == null || Date.now() < deadline);
}

function canAdvanceAfterTrack() {
  return !pendingComputerStart && sleepAllowsPlayback();
}

function computerAdvanced(local, el) {
  return local.advanced || (local.started && !el.seeking && !playSession.seeking && el.currentTime > local.resumeOrigin);
}

function discardComputerStandby() {
  const slot = computerStandby;
  if (!slot) return;
  computerStandby = null;
  slot.controller.abort();
  slot.unbind?.();
  if (slot.src) clearMedia(slot.el);
  releaseComputerAnswer(slot.media);
}

export function followComputerPlaybackMoves(moves, entriesById) {
  const destinations = moveComputerQueueEntries(moves, entriesById);
  const slot = computerStandby;
  if (slot && slot.queue.entries[slot.index + 1] !== slot.entry) {
    discardComputerStandby();
    if (computerPlayback) computerPlayback.standbyAttempted = false;
  }
  if (!isComputerItem(currentItem)) return;
  const from = currentItem._extra?.computer?.id;
  const to = destinations.get(from);
  if (!to || to === from) return;
  const oldItemId = currentItem.id;
  rekeyComputerItem(currentItem, to);
  const local = computerPlayback;
  if (local) {
    if (local.loudnessEntry) local.loudnessEntry = { ...local.loudnessEntry, id: to };
    local.trackFile = rekeyComputerTrackFile(local.trackFile, to);
    computerTracks?.rekey(to, local.trackFile);
  }
  playClock.rekey(oldItemId, currentItem.id);
  setCurrentItem(currentItem, getState().currentStream);
}

function matchesComputerQueue(slot, active) {
  const queue = computerQueueState();
  return queue === slot.queue && queue.index === slot.index && queue.entries[queue.index + 1] === slot.entry
    && !active.loop && queue.bookKey == null;
}

async function prepareComputerStandby(active) {
  const local = computerPlayback;
  if (!local?.started || local.finished || local.kind !== 'audio' || !isComputerMusic(currentItem)) return;
  const eligible = canAdvanceAfterTrack() && !active.loop && hasSeekableLength(active.duration)
    && (active.duration < 40 || active.duration - active.currentTime <= 20);
  if (computerStandby && (!eligible || !matchesComputerQueue(computerStandby, active))) {
    discardComputerStandby();
    local.standbyAttempted = false;
  }
  if (!eligible || standbyOpening || active.paused || active.ended || local.standbyAttempted) return;
  const queue = computerQueueState();
  const entry = queue?.entries[queue.index + 1];
  const el = elements.standby;
  if (!el || !entry || entry.kind !== 'audio' || entry.error || isAudiobook(entry) || queue.bookKey != null
      || (entry.source && entry.source !== 'computer') || queue.entries[queue.index]?.id !== currentItem._extra.computer.id) return;
  local.standbyAttempted = true;
  const slot = { el, queue, index: queue.index, entry, controller: new AbortController(), opened: Date.now() };
  computerStandby = slot;
  standbyOpening = true;
  const discard = () => { if (computerStandby === slot) discardComputerStandby(); };
  let preparing;
  try {
    const media = await openComputerMedia(entry.id, {
      signal: slot.controller.signal, standby: true,
      beforeSend() { preparing = setTimeout(discard, COMPUTER_PREPARING_MS); },
    });
    if (computerStandby !== slot) {
      releaseComputerAnswer(media);
      return;
    }
    slot.media = media;
    if (!matchesComputerQueue(slot, active) || !media?.url || media.hls || media.kind !== 'audio'
        || (media.entry && (media.entry.kind !== 'audio' || isAudiobook(media.entry)))
        || (media.mime && el.canPlayType?.(media.mime) === '')) return discard();
    if (audioEngine.isAttached(active)) {
      if (!audioEngine.connectElement(el, true).processed) return discard();
      audioEngine.setLevellingGain(el, computerLevelling(media.entry, getState().settings).gain);
    }
    const ready = () => { slot.canPlayThrough = true; };
    slot.unbind = () => {
      el.removeEventListener('canplaythrough', ready);
      el.removeEventListener('error', discard);
    };
    el.addEventListener('canplaythrough', ready);
    el.addEventListener('error', discard);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = media.url;
    slot.src = el.src;
  } catch {
    discard();
  } finally {
    clearTimeout(preparing);
    standbyOpening = false;
    const current = getActiveEl();
    if (current && computerPlayback && !computerPlayback.standbyAttempted) prepareComputerStandby(current);
  }
}

function readyComputerStandby(active) {
  const slot = computerStandby;
  if (!slot) return;
  const { el } = slot;
  const ready = el.readyState >= 3 && (slot.canPlayThrough || computerBufferedRangeEnd(el.buffered, 0) != null);
  const graphReady = !audioEngine.isAttached(active) || audioEngine.isAttached(el);
  if (active.ended && canAdvanceAfterTrack() && matchesComputerQueue(slot, active) && slot.media && el.src === slot.src && !el.error && graphReady
      && Date.now() - slot.opened < STANDBY_MAX_AGE_MS && ready) {
    return slot;
  }
}

function finishComputerTrack(el, prepared) {
  const local = computerPlayback;
  if (local.finished) return;
  local.finished = true;
  const queue = computerQueueState();
  local.resume.clear(computerAdvanced(local, el));
  if (local.hls) {
    completeComputerSeek(local);
    setMediaPriority(false);
    // Both a natural end and the server's 416 end-of-file reply leave the
    // MediaSource attached so the last frame and timeline stay visible.
    if (local.bufferedEnd == null) stopComputerHlsLoad();
    releaseComputerSession();
    if (!el.ended && !el.paused) {
      try { el.pause(); } catch (_e) {}
    }
    hideBrokenState();
    setMetaText(currentItem);
    syncPlaybackUi('computer-end');
  }
  resetComputerTrackFailures();
  if (!prepared) discardComputerStandby();
  if (canAdvanceAfterTrack() && queue?.entries[queue.index + 1]) {
    moveComputerQueue(1, { automatic: true, prepared })?.catch(() => {});
  } else {
    loudnessRequests.retain();
    if (pendingComputerStart) showPendingComputerHint(pendingComputerStart);
  }
}

function finishPart(el) {
  const part = partPlayback;
  if (!part || part.finished || !el.ended || !part.started) return;
  part.finished = true;
  const index = part.index + 1;
  const next = part.parts[index];
  if (remembersPart(currentItem, part.parts)) {
    rememberPartResume(currentItem.id, next?.key, 0, part.epoch);
  }
  if (next && canAdvanceAfterTrack()) {
    playItem(currentItem, { parts: part.parts, index, epoch: part.epoch }).catch(() => {});
  }
}

function syncPartControls() {
  const local = isComputerItem(currentItem);
  const selection = local ? computerQueueState() : partPlayback;
  const count = selection?.parts?.length ?? selection?.entries?.length ?? 0;
  const multi = count > 1;
  const localQueue = local && multi;
  const chapters = local && currentItem._extra?.computer?.chapters;
  const active = local ? getActiveEl() : null;
  const steps = chapters?.length && chapterSteps(chapters, active && computerPosition(active));
  const chapterControls = Boolean(steps && !multi);
  const show = multi || chapterControls;
  if (steps && computerPlayback && computerPlayback.chapterIndex !== steps.index) {
    computerPlayback.chapterIndex = steps.index;
    if (metaLineShowsItem) setMetaText(currentItem);
  }
  if (elements.previousPartSlot) elements.previousPartSlot.hidden = !show;
  if (elements.nextPartSlot) elements.nextPartSlot.hidden = !show;
  if (elements.previousPart) {
    elements.previousPart.hidden = !show;
    const previousDisabled = chapterControls ? active?.error || steps.previous == null
      : !multi || (selection.index === 0 && !(active && computerPosition(active) > 3 && !active.error));
    if (elements.previousPart.disabled !== Boolean(previousDisabled)) elements.previousPart.disabled = Boolean(previousDisabled);
    elements.nextPart.hidden = !show;
    elements.nextPart.disabled = chapterControls ? Boolean(active?.error || steps.next == null) : !multi || selection.index === count - 1;
    const suffix = chapterControls ? ' chapter' : localQueue ? '' : ' part';
    if (elements.previousPart.title !== `Previous${suffix}`) {
      for (const [button, label] of [[elements.previousPart, 'Previous'], [elements.nextPart, 'Next']]) {
        button.title = label + suffix;
        button.setAttribute('aria-label', button.title);
      }
    }
  }
  if (elements.resumeActions) {
    const wasHidden = elements.resumeActions.hidden;
    elements.resumeActions.hidden = !pendingPartResume;
    if (pendingPartResume) {
      elements.resumePart.textContent = pendingPartResume.label;
      if (wasHidden) elements.resumePart.focus?.();
    }
  }
}

function computerDuration(el) {
  const local = computerPlayback;
  return local?.bufferedEnd ?? (local?.hls && !hasSeekableLength(el.duration) ? local.duration : el.duration);
}

function computerPosition(el) {
  const local = computerPlayback;
  return (local?.hls && local.refreshPosition != null) ? local.refreshPosition : el.currentTime;
}

function armComputerHlsSeek(local) {
  if (local.seekTimer != null) return;
  local.seekTimer = setTimeout(() => {
    if (computerPlayback === local) failComputerPlayback('This file could not be prepared in time.');
  }, 45_000);
}

function computerBufferedRangeEnd(ranges, position) {
  for (let i = 0; i < (ranges?.length ?? 0); i++) {
    if (position >= ranges.start(i) && position < ranges.end(i)) return ranges.end(i);
  }
}

function finishComputerBufferedEnd(el, position = el.currentTime) {
  const local = computerPlayback;
  if (local?.bufferedEnd == null || local.finished || playSession.userPaused) return false;
  const end = computerBufferedRangeEnd(el.buffered, position);
  if (end != null && end - position > 0.3) return false;
  finishComputerTrack(el);
  return true;
}

function noteComputerHlsSeek(el, position) {
  const local = computerPlayback;
  if (local.finished || local.bufferedEnd != null) return false;
  const buffered = computerBufferedRangeEnd(el.buffered, position) != null;
  if (position !== local.refreshPosition) {
    clearTimeout(local.seekTimer);
    local.seekTimer = null;
  }
  local.seekPending = true;
  local.refreshPosition = position;
  local.preparing = !buffered;
  armComputerHlsSeek(local);
  if (buffered) setMetaText(currentItem);
  else setSourceLine('Preparing...', { status: true });
  return !buffered;
}

function seekFromControls(el, position) {
  const local = computerPlayback;
  if (local?.hls) {
    if (local.finished) {
      playItem(currentItem, {
        computerQueue: computerQueueState(),
        startAt: computerHlsStart(position, computerDuration(el)),
        convertComputer: computerRetryConvert, keepComputerTracks: true,
      }).catch(() => {});
      return;
    }
    if (local.bufferedEnd != null) {
      el.currentTime = Math.min(position, local.bufferedEnd);
      return;
    }
    position = computerHlsStart(position, computerDuration(el));
    noteComputerHlsSeek(el, position);
    if (el.readyState < 1 || !hlsInstance) {
      // Before metadata, let hls.js pick its first fragment at the new target.
      if (hlsInstance) {
        hlsInstance.config.startPosition = position;
        if (hlsInstance.levels?.length) hlsInstance.startLoad(position);
      }
      syncPlaybackUi('computer-seek');
      return;
    }
  }
  el.currentTime = position;
}

function noteComputerHlsFrame(el) {
  const local = computerPlayback;
  if (!local?.hls || !local.seekPending || el.seeking || el.readyState < 2
      || Math.abs(el.currentTime - local.refreshPosition) >= 0.5) return;
  completeComputerSeek(local);
  setMetaText(currentItem);
}

function seekComputerPosition(el, canPlay = false) {
  const local = computerPlayback;
  if (local?.hls || !local?.seekPending || local.explicitSeekIssued) return;
  const finite = hasSeekableLength(el.duration);
  const position = local.refreshPosition ?? local.resume.startPosition(el.duration);
  if (position == null) return;
  if (position > 0) {
    if (!finite) {
      const ranges = el.seekable;
      let seekable = false;
      for (let i = 0; i < (ranges?.length ?? 0); i++) {
        if (position >= ranges.start(i) && position <= ranges.end(i)) {
          seekable = true;
          break;
        }
      }
      if (!seekable && (!canPlay || ranges?.length)) return;
    }
    if (!finite || position < el.duration) {
      try { el.currentTime = position; }
      catch (_) { return; }
    } else if (computerStartAt != null) return;
  } else if (computerStartAt != null) {
    if (!finite && !canPlay && !(el.readyState >= 1)) return;
    if (el.currentTime !== 0) {
      try { el.currentTime = 0; }
      catch (_) { return; }
    }
  }
  local.resumeOrigin = el.currentTime;
  local.videoTime = el.currentTime;
  if (computerStartAt != null) {
    if (el.seeking) {
      local.explicitSeekIssued = true;
      return;
    }
    if (Math.abs(el.currentTime - position) >= 0.25) return;
  }
  completeComputerSeek(local);
}

function completeComputerSeek(local) {
  clearTimeout(local.seekTimer);
  local.seekTimer = null;
  computerStartAt = undefined;
  local.seekPending = false;
  local.preparing = false;
  local.explicitSeekIssued = false;
  local.refreshPosition = null;
}

function updateComputerProgress(local, el) {
  if (!local.started || el.seeking || playSession.seeking) return false;
  if (!local.hls && computerStartAt == null && el.currentTime > 0) local.seekPending = false;
  local.advanced = computerAdvanced(local, el);
  if (!local.checkVideo || typeof el.getVideoPlaybackQuality !== 'function') return false;
  const elapsed = Math.max(0, el.currentTime - (local.videoTime ?? el.currentTime));
  local.videoTime = el.currentTime;
  if (el.paused || document.visibilityState !== 'visible') return false;
  const frames = el.getVideoPlaybackQuality()?.totalVideoFrames;
  if (frames > 0) local.checkVideo = false;
  if (frames !== 0) return false;
  local.noPictureTime += elapsed;
  return local.noPictureTime >= 3;
}

function bindMediaEvents(el, generation) {
  unbindMediaEvents(el);
  const owned = (handler) => (event) => {
    if (playback.owns(el, generation)) handler(event);
  };
  const onTimeUpdate = owned(() => {
    hlsRecoverySession?.noteProgress(el.currentTime);
    if (!computerPlayback) {
      notePlaybackProgress(el);
      watchForStall();
    } else if (updateComputerProgress(computerPlayback, el)) {
      handleComputerMediaError(el, null, { noFrames: true }).catch(() => {});
      return;
    }
    noteComputerHlsFrame(el);
    if (finishComputerBufferedEnd(el)) return;
    rememberCurrentPosition(el, { force: false });
    if (computerPlayback) prepareComputerStandby(el);
    syncPlaybackUi('timeupdate');
  });
  const onDurationChange = owned(() => {
    noteDuration(el);
    seekComputerPosition(el);
    const part = partPlayback;
    if (part?.seekPending && hasSeekableLength(el.duration)) {
      part.seekPending = false;
      if (part.position < el.duration) el.currentTime = part.position;
    }
    if (computerPlayback) prepareComputerStandby(el);
    syncPlaybackUi('durationchange');
  });
  // The stream delivered data: it answered ("Did not play last time").
  const onData = owned((event) => {
    if (event.type === 'loadeddata' && el === elements.video) clearComputerAudioPoster();
    if (!computerPlayback) startOutcome.answered(currentItem?.id);
  });
  const onComputerFrame = owned(() => {
    noteComputerHlsFrame(el);
    if (computerPlayback?.hls) syncPlaybackUi('computer-frame');
  });
  const onStalled = owned(() => {
    if (!el.paused && !el.ended) hlsRecoverySession?.noteStalled();
    syncPlaybackUi('stalled');
  });
  // `waiting` means playback really stopped for lack of data. `stalled` alone
  // only means fetching paused while buffered media may keep playing, so it
  // does not count as an interruption of a reconnected stream.
  const onWaiting = owned(() => {
    if (finishComputerBufferedEnd(el)) return;
    if (!el.paused && !el.ended) hlsRecoverySession?.noteStalled();
    syncPlaybackUi('waiting');
    // Buffering: still "playing" for the controls, but no time passes in it.
    setMediaAdvancing(false);
  });
  const onPlay = owned(() => {
    if (computerPlayback?.hls && computerPlayback.finished) {
      playFromUser().catch(() => {});
      return;
    }
    if (computerPlayback?.bufferedEnd != null) {
      playSession.userPaused = false;
      if (finishComputerBufferedEnd(el)) return;
    }
    setMediaPriority(true);
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    syncPlaybackUi('play');
  });
  const onComputerPlaying = () => {
    if (el.ended || (computerPlayback.hls && computerPlayback.finished)) return;
    setMediaPriority(true);
    noteComputerHlsFrame(el);
    computerPlayback.started = true;
    computerPlayback.finished = false;
    prepareComputerStandby(el);
    syncLoudnessRequests();
    computerPlayback.resumeOrigin = el.currentTime;
    computerPlayback.videoTime = el.currentTime;
    playSession.userPaused = false;
    noteDuration(el);
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    syncPlaybackUi('playing');
    setMediaAdvancing(getState().isPlaying === true);
  };
  const onPlaying = owned(() => {
    if (el === elements.video) clearComputerAudioPoster();
    if (el === elements.video) syncVideoClearance();
    if (computerPlayback) return onComputerPlaying();
    if (partPlayback) partPlayback.started = true;
    setMediaPriority(true);
    // Listed and Auto: the first `playing` of this start (start-failover.js).
    startWatch.playing(playToken);
    startOutcome.answered(currentItem?.id);
    hlsRecoverySession?.notePlaying();
    if (playSession.lastTime == null) startProgressSample(el);
    noteDuration(el);
    if (reconnectingCurrentItem()) reconnectStatus = '';
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    watchForStall();
    syncPlaybackUi('playing');
    setMediaAdvancing(getState().isPlaying === true);
    // Auto (verified): the check waits VERIFY_AFTER_MS of play from the first
    // `playing` of a start, and again after a pause; nothing new when one is
    // already planned for this station.
    if (currentItem && streamAddressesCurrent()) {
      resumeCheck(currentItem, { settings: getState().settings, current: () => currentItem, nowPlaying: getNowPlaying });
    }
  });
  const pausedNow = () => {
    // Auto (verified): a pause ends the background check's session.
    cancelScheduledCheck();
    stallWatchdog.stop();
    setMediaPriority(false);
    hlsRecoverySession?.notePaused();
    syncPlaybackUi('pause');
  };
  const onPaused = owned(() => {
    if (computerPlayback && !el.error && !el.ended) playSession.userPaused = true;
    rememberCurrentPosition(el);
    pausedNow();
  });
  const onEnded = owned(() => {
    const prepared = readyComputerStandby(el);
    if (prepared) {
      prepared.unbind();
      computerStandby = null;
    } else pausedNow();
    if (computerPlayback) {
      finishComputerTrack(el, prepared);
      return;
    }
    if (pendingComputerStart) showPendingComputerHint(pendingComputerStart);
    if (partPlayback) {
      finishPart(el);
      return;
    }
    // A plain live stream (Icecast/MP3) "ends" when its connection closes.
    const kind = activeStreamKind();
    const progressive = kind === 'audio' || kind === 'video';
    if (progressive && playSession.unbounded && shouldReconnect()) {
      failPlayback('Playback error');
    }
  });
  const onError = owned(() => {
    discardComputerStandby();
    if (el === elements.video) clearComputerAudioPoster();
    if (computerPlayback) {
      const formatError = isComputerFormatError(el.error);
      if (pendingPlay?.element !== el || formatError) {
        handleComputerMediaError(el).catch(() => {});
      }
      return;
    }
    // The play() promise is the authoritative result while an attempt is
    // pending. Some streams emit an interim error while negotiating a redirect
    // or codec; pausing here aborts an attempt that may otherwise succeed.
    if (hlsRecoverySession?.isRecovering) return;
    if ((el.error || pendingPlay?.element !== el) && el === elements.video) {
      if (dashSession?.recoverFixed()) return;
      if (hlsVideoQuality && !hlsInstance.autoLevelEnabled) {
        hlsVideoQuality.resumeAuto();
        hlsRecoverySession?.handleFatal({ fatal: true, type: 'mediaError' });
        return;
      }
    }
    if (pendingPlay?.element !== el) failPlayback('Playback error');
  });
  const bindings = [
    ['timeupdate', onTimeUpdate],
    ['resize', owned(() => {
      if (el === elements.video) {
        syncVideoTrack(el);
        syncPlaybackUi('video-resize');
      }
    })],
    ['loadedmetadata', owned(() => {
      if (el === elements.video) syncVideoTrack(el);
      onDurationChange();
    })],
    ['durationchange', onDurationChange],
    ...(computerPlayback?.hls ? [['canplay', onComputerFrame], ['loadeddata', onComputerFrame]]
      : computerPlayback ? [['canplay', owned(() => seekComputerPosition(el, true))]] : []),
    ['loadedmetadata', onData],
    ['loadeddata', onData],
    ['progress', onData],
    ['play', onPlay],
    ['playing', onPlaying],
    ['pause', onPaused],
    ['ended', onEnded],
    ['seeking', owned(() => {
      if (computerPlayback?.hls && computerPlayback.finished) {
        seekFromControls(el, el.currentTime);
        return;
      }
      noteSeeking(el, true);
      if (computerStandby) prepareComputerStandby(el);
      const end = computerPlayback?.bufferedEnd;
      if (end != null && el.currentTime > end) {
        el.currentTime = end;
      } else if (computerPlayback?.hls && noteComputerHlsSeek(el, el.currentTime)) {
        // hls.js cancels a pending forward load on its own. Restart loading
        // here so a backward seek also drops an obsolete segment request.
        hlsInstance?.startLoad(el.currentTime);
      }
    })],
    ['seeked', owned(() => {
      noteSeeking(el, false);
      if (computerPlayback) {
        computerPlayback.resumeOrigin = computerPlayback.videoTime = el.currentTime;
        if (computerPlayback.explicitSeekIssued) {
          if (Math.abs(el.currentTime - computerStartAt) < 0.25) completeComputerSeek(computerPlayback);
          else computerPlayback.explicitSeekIssued = false;
        }
      }
      noteComputerHlsFrame(el);
      if (finishComputerBufferedEnd(el)) return;
      rememberCurrentPosition(el);
      if (computerPlayback) syncPlaybackUi('computer-seeked');
    })],
    ['emptied', owned(pausedNow)],
    ['waiting', onWaiting],
    ['stalled', onStalled],
    ['error', onError],
  ];
  for (const [name, handler] of bindings) el.addEventListener(name, handler);
  mediaEventBindings.set(el, bindings);
}

function invalidatePlaybackOwnership() {
  discardComputerStandby();
  eqSignalMonitorToken++;
  playback.invalidate();
  // The old element's events no longer count, including its `pause`.
  setMediaAdvancing(false);
  syncPlayerSilence();
  if (!elements) return;
  unbindMediaEvents(elements.audio);
  unbindMediaEvents(elements.video);
}

function clearMedia(el) {
  try {
    el.pause();
    audioEngine.setLevellingGain(el, 1);
    el.__seeking = false;
    el.removeAttribute('src');
    if (el.tagName === 'AUDIO' && el.preload === 'auto') el.removeAttribute('preload');
    el.load();
  } catch (_) {}
  audioEngine.updateIdle();
}

/** The player bar's name line; a long name ends in an ellipsis, so the whole
 *  of it is on hover. */
function setTitleLine(text) {
  elements.title.textContent = text;
  elements.title.title = text;
}

function setMetaText(item) {
  setTitleLine(shownTitle(item) || 'Untitled');
  if (pendingPartResume) {
    const title = elements.title.textContent;
    setSourceLine(title, { hover: title, itemLine: true });
    return;
  }
  // A reconnect attempt rebuilds the player bar; keep the status visible.
  if (reconnectStatus) {
    setSourceLine(reconnectStatus, { status: true });
    return;
  }
  const message = computerTrackMessage || playbackProblem?.message || pendingComputerStart?.hint;
  if (message) {
    setSourceLine(message, { status: true });
    return;
  }
  if (isComputerItem(item)) {
    if (computerPlayback?.preparing || computerPlayback?.audioPreparing) {
      setSourceLine('Preparing...', { status: true });
      return;
    }
    const { chapters, format, formatDetails } = item._extra?.computer || {};
    const originalFormat = computerPlayback?.converted ? formatDetails || format : format;
    const index = computerPlayback?.chapterIndex;
    const chapter = chapters?.[index];
    const line = [computerSubtitle(item), chapter && `Chapter ${index + 1} of ${chapters.length}`, chapter?.title]
      .filter(Boolean).join(' · ');
    const levelling = getComputerLevellingDetails(item.id);
    const hover = [chapter && line, getState().settings.showTechnicalDetails && originalFormat, levelling?.title].filter(Boolean);
    if (!chapter && hover.length && line) hover.unshift(line);
    setSourceLine([line, levelling?.text].filter(Boolean).join(' \u00b7 '), { itemLine: true, hover: hover.join('\n') });
    return;
  }
  const line = [getSourceLabel(item.source), item.country, item.language].filter(Boolean).join(' \u00B7 ');
  const song = currentSongTitle(item);
  // Stream format and bitrate go on hover only, after the normal line: the
  // visible column is too narrow for them.
  // The format and bitrate of the stream that plays, when they are known.
  const candidate = playSession.candidate;
  const listed = playSession.orderedAddresses
    ? formatStreamQuality({ ...candidate, hls: candidate?.kind === 'hls' })
    : playedQualityLabel(item, playedStream(item));
  // Auto (verified): said plainly when a verified better stream plays.
  const quality = [listed, verifiedPlaying && currentItem === item ? verifiedLabel(verifiedPlaying) : '']
    .filter(Boolean).join('\n');
  if (!song) {
    const part = partLabel(item, partPlayback);
    setSourceLine(part || line, {
      itemLine: true, hover: part || quality ? [part, line, quality].filter(Boolean).join('\n') : '',
    });
    return;
  }
  // The song replaces the line; its full text and the normal line stay readable on hover.
  const text = songLine(song);
  setSourceLine(text, { hover: [text, line, quality].filter(Boolean).join('\n'), itemLine: true, song: true });
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
  syncComputerMediaSession(item);
  syncFavButton();
}

// The station picture the player bar was last drawn with ('' for none).
let playerStationImage = '';
let computerArtworkLoad = null;
let computerArtworkUrl = '';

function clearComputerArtwork() {
  computerArtworkLoad?.abort();
  computerArtworkLoad = null;
  if (computerArtworkUrl) {
    syncComputerMediaSession(currentItem, '');
    URL.revokeObjectURL(computerArtworkUrl);
    if (elements.art.getAttribute('src') === computerArtworkUrl) elements.art.removeAttribute('src');
    computerArtworkUrl = '';
  }
}

/** The station pictures changed (startup list, Refresh, or one would not
 *  load): redraw the player bar's picture, which the Tuner shows too, only
 *  when the playing item's picture is a different one now. Playback and the
 *  rest of the bar are left alone. Returns true when it was redrawn. */
export function syncPlayerStationImage() {
  if (!currentItem || !bar || bar.hidden || isComputerItem(currentItem)) return false;
  if (stationImageSourceFor(currentItem) === playerStationImage) return false;
  setPlayerArtwork(currentItem);
  return true;
}

/** The player bar's picture (also what the Tuner shows): the user's own
 *  station picture first, then the item's relay artwork. A station picture
 *  that will not load falls back to the item's own artwork. */
function setPlayerArtwork(item) {
  clearComputerArtwork();
  elements.art.dataset.stationId = item.id;
  const artworkToken = ++metadataArtworkToken;
  playerStationImage = isComputerItem(item) ? '' : stationImageSourceFor(item);
  const current = () => artworkToken === metadataArtworkToken && currentItem === item;
  const latest = () => artworkToken === metadataArtworkToken;
  // The class follows what the bar shows: on only while a station picture is
  // on screen (shown whole on the bar, base.css), off while the box is empty,
  // loading, or showing remote artwork (which has its own fit).
  const setFit = (custom) => elements.art.classList?.toggle?.(STATION_IMAGE_CLASS, custom);
  // A radio or TV station's own artwork is its logo, often a wide wordmark:
  // shown whole in the square (base.css), as on the Library and Tuner cards.
  elements.art.classList?.toggle?.('is-logo', item?.type === 'radio' || item?.type === 'tv');
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
      if (isComputerItem(item)) syncComputerMediaSession(item, src);
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
      elements.art.onload();
    }
  };
  const attachArtwork = () => {
    if (!current() || !isArtworkRelayUrl(item.thumbnail)) return;
    showSource(item.thumbnail.trim());
  };
  const showOwnArtwork = () => {
    if (isComputerItem(item)) {
      clearArt();
      elements.art.onload = elements.art.onerror = null;
      const source = artworkSourceFor(item);
      if (!source) return;
      const controller = new AbortController();
      computerArtworkLoad = controller;
      loadArtworkImage(elements.art, source, {
        priority: 20, signal: controller.signal,
        keepObjectUrl: (url) => {
          if (!current() || !globalThis.navigator?.mediaSession) return false;
          computerArtworkUrl = url;
          syncComputerMediaSession(item, url);
          return true;
        },
      }).then(() => {
        if (current()) elements.art.style.opacity = '1';
      }, () => { if (current()) clearArt(); });
    } else if (isArtworkRelayUrl(item.thumbnail)) {
      attachArtwork();
    } else {
      clearArt();
      resolveArtworkRelay(item, { priority: 20 }).then(attachArtwork).catch(() => {});
    }
  };
  const custom = playerStationImage;
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

function applyComputerLevelling(entry = computerPlayback?.loudnessEntry, { immediate = false } = {}) {
  const target = getActiveEl();
  const attached = target === elements?.audio && audioEngine.isAttached(target);
  const info = computerLevelling(attached ? entry : null, getState().settings);
  if (immediate || info.gain !== (levellingDetails?.gain ?? 1)) {
    const sounding = !immediate && computerPlayback?.started && target && !target.paused && !target.ended;
    audioEngine.setLevellingGain(target, info.gain, { rampSeconds: sounding ? LEVELLING_RAMP_SECONDS : 0 });
  }
  const next = info.text ? info : null;
  const changed = levellingDetails?.text !== next?.text || levellingDetails?.title !== next?.title;
  levellingDetails = next;
  if (changed) {
    if (currentItem && metaLineShowsItem) setMetaText(currentItem);
    emit(COMPUTER_LEVELLING_CHANGE);
  }
}

function syncLoudnessRequests() {
  const entry = computerPlayback?.loudnessEntry;
  const active = getActiveEl();
  if (levellingMode(getState().settings) === 'off' || !entry || !computerPlayback.started
      || computerPlayback.finished || !active || active.ended || active.paused) return loudnessRequests.retain();
  const queue = computerQueueState();
  const queued = queue?.entries[queue.index + 1];
  const next = queued && (computerLibrary.getComputerLibrary().items.find(({ id }) => id === queued.id) ?? queued);
  loudnessRequests.retain(entry.id, next?.id);
  if (!hasTrackGain(entry)) loudnessRequests.request(entry);
  if (next?.kind === 'audio' && !next.error && !isAudiobook(next) && !hasTrackGain(next)) loudnessRequests.request(next);
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
  const result = await audioEngine.attachElement(target, { curve, levelledInput: target === elements.audio });
  return { safe: true, ...result };
}

function verifyEqualizerSignal(target, token, generation) {
  if (isComputerItem(currentItem) || !audioEngine.isAttached(target)) return;
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
  const result = await audioEngine.attachElement(target, {
    curve: effectiveEqCurve(currentItem), levelledInput: target === elements.audio,
  });
  if (result.processed && playback.owns(target, generation)) {
    applyComputerLevelling();
    if (!target.paused) verifyEqualizerSignal(target, playToken, generation);
  }
  return result.processed;
}

function setComputerSourceAttached(attached) {
  const local = computerPlayback;
  if (!local?.converted || Boolean(local.convertedAttached) === attached) return;
  local.convertedAttached = attached;
  emit(COMPUTER_CONVERTED_CHANGE);
}

function releaseComputerSession() {
  if (!computerPlayback) return;
  releaseComputerTokens(computerPlayback);
  computerPlayback.hlsToken = computerPlayback.mediaToken = null;
}

function canRestartComputerSession() {
  return (computerPlayback?.hls || computerPlayback?.hidden) && !getActiveEl() && !computerPlayback.seekPending;
}

function failComputerPlayback(message, { countFailure = true } = {}) {
  clearComputerAudioPoster();
  clearComputerTrackMessage();
  computerTracks?.detach();
  computerOpenRetryable = !countFailure;
  rememberCurrentPosition();
  const local = computerPlayback;
  if (local?.hls) {
    const retryPosition = local.seekPending ? local.refreshPosition : computerStartAt;
    cancelPendingResolution('Computer playback failed');
    completeComputerSeek(local);
    computerStartAt = retryPosition ?? undefined;
  }
  invalidatePlaybackOwnership();
  destroyHls();
  releaseComputerSession();
  clearMedia(elements.audio);
  clearMedia(elements.video);
  loudnessRequests.retain();
  if (local) local.loudnessEntry = null;
  applyComputerLevelling(null, { immediate: true });
  setComputerSourceAttached(false);
  showVideo(false);
  showBrokenState(message, { showNext: false, retry: true });
  if (countFailure) computerTrackFailed(() => !playSession.userPaused && canAdvanceAfterTrack());
}

function failComputerFormat() {
  failComputerPlayback('This format cannot be played yet.');
}

function computerMediaFileKey(item, media) {
  const { id } = item._extra.computer;
  return computerTrackFileKey(id, media.entry) || computerTrackFileKey(id, item._extra.computer);
}

function computerPlaylistToken(media) {
  return media?.hls === true ? computerHlsToken(media.url) : null;
}

function computerTokens(media) {
  return { hlsToken: computerPlaylistToken(media), mediaToken: computerMediaToken(media?.url) };
}

function releaseComputerTokens({ hlsToken, mediaToken }, keep) {
  if (hlsToken && hlsToken !== keep?.hlsToken) releaseComputerHls(hlsToken).catch(() => {});
  if (mediaToken && mediaToken !== keep?.mediaToken) releaseComputerMedia(mediaToken).catch(() => {});
}

function releaseComputerAnswer(media, keep = computerPlayback) {
  if (media) releaseComputerTokens(computerTokens(media), keep);
}

async function requestComputerMedia(item, { controller, stale, convert, requestedAudio, preferAudio, standby, showPreparing }) {
  let preparing;
  const clearPreparing = () => clearTimeout(preparing);
  controller.signal.addEventListener('abort', clearPreparing, { once: true });
  const request = async (index) => {
    const id = item._extra?.computer?.id;
    let answer;
    try {
      answer = await openComputerMedia(id, {
        signal: controller.signal, convert, audio: index, standby,
        beforeSend() {
          if (stale()) throw new Error('Computer play request superseded');
          if (!showPreparing) return;
          clearPreparing();
          preparing = setTimeout(() => { if (!stale()) showPreparing(); }, COMPUTER_PREPARING_MS);
        },
      });
    } catch (error) {
      if (!stale() && id !== item._extra?.computer?.id) return request(index);
      throw error;
    }
    if (!answer?.url || (answer.hls !== true && !['audio', 'video'].includes(answer.kind))) {
      releaseComputerAnswer(answer);
      throw new Error('Invalid Computer media');
    }
    return answer;
  };
  try {
    let media = await request(requestedAudio);
    if (!stale() && preferAudio && item.type === 'video' && media.audio_tracks?.length) {
      const preferred = preferredComputerAudio(loadComputerTrackPrefs(), computerMediaFileKey(item, media), media.audio_tracks);
      if (preferred != null) {
        const releaseDefault = () => {
          releaseComputerAnswer(media);
          media = null;
        };
        controller.signal.addEventListener('abort', releaseDefault, { once: true });
        try {
          const alternative = await request(preferred);
          releaseComputerAnswer(media, computerTokens(alternative));
          media = alternative;
          requestedAudio = preferred;
        } catch {
          // The server's default answer is still usable if the preference fails.
        } finally {
          controller.signal.removeEventListener('abort', releaseDefault);
        }
      }
    }
    return { media, requestedAudio };
  } finally {
    clearPreparing();
    controller.signal.removeEventListener('abort', clearPreparing);
  }
}

function markMissingComputerFile(item, error) {
  if (error?.code === 'COMPUTER_FILE_GONE') computerLibrary.markFileMissing(item._extra?.computer?.id);
  else if (error?.code === 'COMPUTER_FOLDER_OFFLINE') void computerLibrary.refreshAvailability();
}

function handleComputerOpenError(item, error, recovery) {
  markMissingComputerFile(item, error);
  const message = computerOpenMessage(error);
  const el = getActiveEl();
  if (recovery?.change && el && !el.error && !recovery.session.audioSourceFailed) {
    showComputerPlayMessage(message, { transient: true });
    return;
  }
  const countFailure = !recovery?.change && error?.retryable !== true && !isComputerFolderRefusal(error);
  if (!countFailure && recovery?.position != null) computerStartAt = recovery.position;
  failComputerPlayback(message, { countFailure });
}

function attachComputerFile(item, token, recovery = null, convert = false) {
  return duringAudioStart(() => openComputerSource(item, token, recovery, convert));
}

async function openComputerSource(item, token, recovery, convert) {
  const controller = new AbortController();
  resolutionController = controller;
  const { session, change } = recovery ?? {};
  const stale = () => token !== playToken || controller.signal.aborted || (change && session.audioChange !== change);
  if (!change) computerRetryConvert = convert;
  if (!change && (item.type === 'audio' || convert || session?.hls)) setSourceLine('Connecting...', { status: true });
  let opened;
  try {
    opened = await requestComputerMedia(item, {
      controller, stale, convert, requestedAudio: change?.index ?? session?.requestedAudio, preferAudio: !recovery,
      showPreparing() {
        if (change) session.audioPreparing = true;
        setSourceLine('Preparing...', { status: true });
      },
    });
  } catch (error) {
    if (!stale()) handleComputerOpenError(item, error, recovery);
    return;
  } finally {
    if (resolutionController === controller) resolutionController = null;
  }
  const { media, requestedAudio } = opened;
  if (stale()) {
    releaseComputerAnswer(media);
    return;
  }
  if (change) {
    const el = getActiveEl();
    const position = session.refreshPosition ?? el?.currentTime;
    recovery.position = computerHlsStart(position, media.duration);
    if (el) playSession.userPaused ||= el.paused && (session.started || el.ended);
    completeComputerSeek(session);
    clearComputerSource(el ?? elements.video, {
      keepFrame: el === elements.video && (media.hls === true || (media.entry?.kind ?? media.kind) === 'video'),
    });
    Object.assign(session, {
      started: false, finished: false, refreshed: false, bufferedEnd: undefined,
      hlsRefreshedAt: undefined, hlsMediaRecovered: false, audioSourceFailed: false, audioPreparing: false,
    });
    computerStartAt = recovery.position;
    computerRetryConvert = convert;
    const selected = media.audio_tracks?.find((track) => track.selected);
    if (selected) rememberComputerTracks(computerMediaFileKey(item, media), { audio: selected.index }, { audio: selected.language || '' });
  }
  return startComputerMedia(item, token, media, { recovery, requestedAudio, convert });
}

function needsComputerAudioConversion(media) {
  return media.hls !== true && (media.entry?.kind ?? media.kind) === 'audio'
    && !media.converted && media.mime && elements.audio.canPlayType?.(media.mime) === '';
}

async function startComputerMedia(item, token, media, {
  recovery, requestedAudio, convert, promote, prepared, sourceKey,
} = {}) {
  const { change, session } = recovery ?? {};
  const id = item._extra.computer.id;
  const trackFile = computerMediaFileKey(item, media);
  const length = media.duration_estimated == null ? null : {
    ...(media.duration != null && { duration: media.duration }),
    duration_estimated: media.duration_estimated,
  };
  const freshEntry = media.entry && { ...media.entry, ...length, id };
  if (!media.entry?.id || media.entry.id === id) computerLibrary.acceptPlayedEntry(id, freshEntry);
  const loudnessFile = freshEntry ?? { id };
  const measured = !hasTrackGain(loudnessFile) && loudnessRequests.resultFor(loudnessFile);
  const staleLoudness = freshEntry ? [] : Object.keys(loudnessFields(item._extra.computer));
  const replaceLoudness = !freshEntry && (Boolean(measured) || staleLoudness.length > 0);
  if (freshEntry) {
    if (freshEntry.kind === 'audio') setVideoClearance();
    const hydrated = makeComputerItem({ ...freshEntry, ...measured });
    currentItem = item = { ...item, ...hydrated, _extra: { ...item._extra, ...hydrated._extra } };
    persistFavoriteMetadata(item);
  } else if (length || replaceLoudness) {
    const computer = { ...item._extra.computer, ...length };
    for (const key of staleLoudness) delete computer[key];
    Object.assign(computer, measured);
    currentItem = item = { ...item, _extra: { ...item._extra, computer } };
  }
  const hls = media.hls === true;
  const kind = hls ? 'video' : freshEntry?.kind ?? media.kind;
  computerPlayback = recovery?.session ?? {
    started: false, finished: false, refreshed: false, advanced: false,
    resume: createComputerResume(item, kind, media.duration ?? freshEntry?.duration ?? item._extra.computer.duration),
  };
  if (!hls && computerPlayback.hls && !change) completeComputerSeek(computerPlayback);
  const tokens = computerTokens(media);
  releaseComputerTokens(computerPlayback, tokens);
  if ((prepared || promote) && tokens.mediaToken) keepComputerMedia(tokens.mediaToken).catch(() => {});
  Object.assign(computerPlayback, {
    kind, hls, ...tokens, duration: media.duration, converted: hls || media.converted === true,
    loudnessEntry: kind === 'audio' && isComputerMusic(item) && computerQueueState()?.bookKey == null
      ? { ...loudnessFile, ...measured } : null,
    requestedAudio, selectedAudio: media.audio_tracks?.find((track) => track.selected),
    trackFile,
    seekPending: true, explicitSeekIssued: false, preparing: hls,
    refreshPosition: recovery?.position ?? computerStartAt,
    checkVideo: kind === 'video' && !hls && Boolean(freshEntry?.vcodec ?? media.vcodec),
    noPictureTime: 0,
  });
  if (!computerPlayback.loudnessEntry) loudnessRequests.retain();
  if (hls) {
    computerPlayback.refreshPosition = computerHlsStart(
      computerPlayback.refreshPosition ?? computerPlayback.resume.startPosition(media.duration), media.duration,
    );
    armComputerHlsSeek(computerPlayback);
  }
  if (kind === 'video') computerTracks?.update(id, computerPlayback.trackFile, media);
  else computerTracks?.reset();
  setCurrentItem(item);
  if (prepared || freshEntry || replaceLoudness) setMeta(item);
  else if (item.type === 'audio' || hls || change) setMetaText(item);
  syncPartControls();
  if (needsComputerAudioConversion(media)) {
    if (!convert) {
      releaseComputerSession();
      return attachComputerFile(item, token, recovery, true);
    }
    failComputerFormat();
    return;
  }
  if (change) {
    session.audioChange = null;
    const attachment = attachComputerSource(media.url, token);
    const generation = playback.generation;
    attachment.catch(() => {
      if (token === playToken && playback.generation === generation) {
        failComputerPlayback('This file could not be opened.', { countFailure: false });
      }
    });
    return;
  }
  if (prepared) {
    computerPlayback.promoted = true;
    const target = prepared.el;
    const generation = playback.activate(target);
    gaplessSignalSource = { key: sourceKey, generation, time: performance.now() / 1000 };
    activePlaybackRelayed = true;
    bindMediaEvents(target, generation);
    applyComputerLevelling(computerPlayback.loudnessEntry, { immediate: true });
    setComputerSourceAttached(true);
    seekComputerPosition(target, true);
    try {
      await attemptMediaPlay(target);
    } catch (error) {
      if (playback.owns(target, generation) && !pausedDuringStart(error, token)) return handleComputerMediaError(target, error);
    }
  } else await attachComputerSource(media.url, token);
}

async function chooseComputerAudio(index) {
  const session = computerPlayback;
  if (session?.kind !== 'video') return;
  if (!session.audioChanging && session.selectedAudio?.index === index) {
    rememberComputerTracks(session.trackFile, { audio: index }, { audio: session.selectedAudio.language || '' });
    return;
  }

  const token = playToken;
  session.audioChange = { index };
  if (session.audioChanging) return;
  session.audioChanging = true;
  try {
    // Drain the earlier answer before opening the latest audio choice.
    while (token === playToken && session.audioChange) {
      const change = session.audioChange;
      await attachComputerFile(currentItem, token, { session, change }, computerRetryConvert);
      if (session.audioChange === change) session.audioChange = null;
    }
  } finally {
    session.audioChanging = session.audioPreparing = false;
    if (token === playToken && !playbackProblem && currentItem) setMetaText(currentItem);
  }
}

function attachComputerSource(url, token) {
  const { hls, kind } = computerPlayback;
  // Local bytes and the hls.js MediaSource are eligible for the same-origin audio graph.
  return attachStream({ ...currentItem, stream_url: url, stream_kind: hls ? 'hls' : kind }, token, {
    relayAvailable: true,
  });
}

function computerHlsStart(position, duration) {
  // The endpoint is exclusive. Starting at it would skip the last fragment.
  return hasSeekableLength(duration)
    ? Math.min(position ?? 0, Math.max(0, duration - 0.001)) : position ?? 0;
}

function keepComputerAudioFrame(video) {
  if (!(video.readyState >= 2) || !hasPicture(video)) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, 1280);
    canvas.height = Math.max(1, Math.round(video.videoHeight * canvas.width / video.videoWidth));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = canvas.toDataURL('image/jpeg', 0.8);
    if (poster === 'data:,') return;
    const original = video.getAttribute('poster');
    video.setAttribute('poster', poster);
    restoreComputerAudioPoster ??= () => {
      if (original === null) video.removeAttribute('poster');
      else video.setAttribute('poster', original);
    };
  } catch {
    // A frame is optional. The source can still be changed.
  }
}

function clearComputerAudioPoster() {
  restoreComputerAudioPoster?.();
  restoreComputerAudioPoster = null;
}

function clearComputerSource(el, { release = false, keepFrame = false } = {}) {
  if (keepFrame) keepComputerAudioFrame(el);
  else clearComputerAudioPoster();
  computerTracks?.detach();
  playSession.seeking = false;
  invalidatePlaybackOwnership();
  destroyHls();
  if (release) releaseComputerSession();
  clearMedia(el);
  setComputerSourceAttached(false);
  syncPlaybackUi('computer-refresh');
}

function stopComputerHlsLoad() {
  // stopLoad clears the stream controllers' tick and next tick. ABR owns a
  // separate fragment-monitor interval, outside Hls.networkControllers.
  hlsInstance?.stopLoad();
  hlsInstance?.abrController?.clearTimer();
}

async function handleComputerHlsError(el, url, data, { mediaError = false } = {}) {
  const session = computerPlayback;
  if (session.finished || session.bufferedEnd != null) return;
  clearComputerAudioPoster();
  const status = data.response?.code;
  if (session.audioChange && status !== 416) {
    session.audioSourceFailed = true;
    return;
  }
  if (status === 416) {
    const position = session.refreshPosition ?? el.currentTime;
    const ranges = el.buffered;
    // Stop fetching and keep the media attached while the buffered ending plays.
    session.bufferedEnd = ranges?.length ? ranges.end(ranges.length - 1) : el.currentTime;
    stopComputerHlsLoad();
    completeComputerSeek(session);
    if (!finishComputerBufferedEnd(el, position)) {
      setMetaText(currentItem);
      syncPlaybackUi('computer-buffered-end');
    }
    return;
  }
  if (status === 500) {
    failComputerPlayback(computerHlsErrorMessage(data, 'This file could not be converted.'));
    return;
  }
  const now = Date.now();
  const refresh = status === 410 && !playSession.userPaused && sleepAllowsPlayback()
    && now - (session.hlsRefreshedAt ?? -Infinity) >= 60_000;
  const recover = !status && mediaError && !session.hlsMediaRecovered;
  if (refresh || recover) {
    const position = computerHlsStart(computerPosition(el), session.duration);
    rememberCurrentPosition(el);
    session.refreshPosition = position;
    session.seekPending = session.preparing = true;
    armComputerHlsSeek(session);
    clearComputerSource(el, { release: refresh });
    if (refresh) {
      session.hlsRefreshedAt = now;
      return attachComputerFile(currentItem, playToken, { session, position }, computerRetryConvert);
    }
    session.hlsMediaRecovered = true;
    setMetaText(currentItem);
    return attachComputerSource(url, playToken);
  }
  failComputerPlayback(computerHlsErrorMessage(data));
}

async function attachComputerHls(url, target, owns) {
  const HlsLib = await hlsLoader();
  if (!owns()) return false;
  if (!HlsLib?.isSupported?.()) {
    failComputerPlayback('Video conversion playback is unavailable.');
    return false;
  }
  const instance = new HlsLib(computerHlsConfig(HlsLib, computerPlayback.refreshPosition));
  hlsInstance = instance;
  instance.on(HlsLib.Events.ERROR, (_event, data) => {
    const status = data?.response?.code;
    if (!data || (!data.fatal && !(status >= 400 && status !== 503))) return;
    // hls.js completes error dispatch before recovery detaches the media.
    queueMicrotask(() => {
      if (owns() && hlsInstance === instance) {
        handleComputerHlsError(target, url, data, {
          mediaError: data.fatal && data.type === HlsLib.ErrorTypes.MEDIA_ERROR,
        }).catch(() => {});
      }
    });
  });
  instance.loadSource(url);
  instance.attachMedia(target);
  setComputerSourceAttached(true);
  return true;
}

async function handleComputerMediaError(el, error, { noFrames = false } = {}) {
  if (el === elements.video) clearComputerAudioPoster();
  const session = computerPlayback;
  if (session.hls && (session.finished || session.bufferedEnd != null)) return;
  if (error?.name === 'NotAllowedError') {
    applyComputerLevelling(null, { immediate: true });
    setMediaPriority(false);
    setSourceLine('Press Play to start.', { status: true });
    syncPlaybackUi('computer-autoplay-refused');
    return;
  }
  if (session.audioChange) {
    session.audioSourceFailed = true;
    return;
  }
  if (session.promoted && !session.started) {
    // A prefetched range may have become unusable just as play() consumed it.
    clearComputerSource(el, { release: true });
    return attachComputerFile(currentItem, playToken);
  }
  const formatError = noFrames || isComputerFormatError(el.error, error);
  if (session.hls) {
    // A format error from the element may precede the equivalent hls.js event.
    if (formatError) {
      return handleComputerHlsError(el, hlsInstance?.url, {}, { mediaError: true });
    }
    failComputerPlayback('This file could not be opened.');
    return;
  }
  const localAudio = session.kind === 'audio' && currentItem?.type === 'audio';
  const convert = formatError && (localAudio || session.kind === 'video') && !session.converted
    && !computerRetryConvert && !session.finished && !playSession.sleepExpired;
  if (formatError && !convert && localAudio) {
    failComputerFormat();
    return;
  }
  if (!convert && (formatError || !session.started || session.refreshed || session.finished || playSession.sleepExpired)) {
    failComputerPlayback('This file could not be opened.');
    return;
  }
  const position = session.seekPending
    ? session.refreshPosition ?? session.resume.startPosition(el.duration) : el.currentTime;
  if (!convert) session.refreshed = true;
  rememberCurrentPosition(el);
  clearComputerSource(el, { release: true });
  return attachComputerFile(currentItem, playToken, { session, position }, convert || computerRetryConvert);
}

function attachStream(item, token, options) {
  return duringAudioStart(() => loadStream(item, token, options));
}

async function loadStream(item, token, { relayAvailable = false, dashStart } = {}) {
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
  syncPlayerSilence();
  const eqPreparation = await prepareEqualizer(target, currentItem || item, relayAvailable);
  if (stale() || !playback.owns(target, generation)) return;
  if (!eqPreparation.safe) {
    if (computerPlayback?.hls) {
      failComputerPlayback(eqPreparation.reason, { countFailure: false });
      return;
    }
    showBrokenState(eqPreparation.reason, { showNext: false });
    // The app's equalizer, not the station: no result.
    startOutcome.cancel(item.id);
    return;
  }
  applyComputerLevelling(computerPlayback?.loudnessEntry, { immediate: true });
  let playbackStarted = false;
  if (videoKind) {
    showVideo(expectsPicture(item) || hasPicture(elements.video));
    syncPlaybackUi('video-start');
    if (computerPlayback?.hls) {
      const owns = () => !stale() && playback.owns(target, generation);
      try {
        if (!await attachComputerHls(item.stream_url, target, owns) || !owns()) return;
      } catch {
        if (owns()) failComputerPlayback('Video conversion playback is unavailable.');
        return;
      }
    } else if (kind === 'hls') {
      const HlsLib = await hlsLoader();
      if (stale() || !playback.owns(target, generation)) return;
      const engine = selectHlsPlaybackEngine({
        hlsSupported: Boolean(HlsLib?.isSupported?.()),
        nativeSupport: elements.video.canPlayType('application/vnd.apple.mpegurl'),
      });
      if (engine === 'hlsjs') {
          const instance = new HlsLib(hlsPlaybackConfig());
          const qualitySource = createHlsVideoQuality(instance);
          hlsVideoQuality = qualitySource;
          hlsInstance = instance;
          videoQuality?.setSource(qualitySource);
          hlsRecoverySession = createHlsRecoveryController({
            hls: instance,
            errorTypes: HlsLib.ErrorTypes,
            owns: () => hlsInstance === instance && playback.owns(target, generation),
            getCurrentTime: () => target.currentTime,
            onRecovering: (message) => {
              if (currentItem) setTitleLine(shownTitle(currentItem) || 'Live stream');
              setSourceLine(message, { status: true });
            },
            onRecovered: () => {
              if (!playback.owns(target, generation)) return;
              attemptMediaPlay(target).catch(() => {});
            },
            selectLowerRendition: qualitySource.lower,
            fallBackToAuto: () => videoQuality?.fallBack(qualitySource),
            onTerminal: (message) => failPlayback(message, { showNext: true }),
          });
          instance.on(HlsLib.Events.LEVEL_LOADED, (_evt, data) => {
            if (!playback.owns(target, generation) || playSession.token !== token) return;
            if (typeof data?.details?.live === 'boolean') {
              playSession.hlsLive = data.details.live;
              syncPlaybackUi('hls-delivery');
            }
          });
          instance.on(HlsLib.Events.FRAG_BUFFERED, (_evt, { frag }) => {
            if (frag.type === 'main' && playback.owns(target, generation)) {
              qualitySource.fragmentReady(frag.level);
            }
          });
          instance.on(HlsLib.Events.LEVEL_SWITCHED, (_evt, data) => {
            if (stale() || !playback.owns(target, generation) || !streamAddressesCurrent()) return;
            qualitySource.fragmentReady(data.level);
            const level = instance.levels[data.level];
            const videoTrack = playSession.hasVideoTrack ?? expectsPicture(item);
            if (videoTrack && playSession.hlsLevel !== level) playedStreamNote.renditionChanged();
            playSession.hlsLevel = level;
            videoQuality?.rendered(qualitySource, level);
            if (!videoTrack) noteHlsAudio();
          });
          const refreshLevels = () => {
            if (!playback.owns(target, generation)) return;
            videoQuality?.setLevels(qualitySource, instance.levels
              .map((level, index) => videoQualityLevel(level, index)));
          };
          instance.on(HlsLib.Events.MANIFEST_PARSED, () => {
            if (!playback.owns(target, generation)) return;
            refreshLevels();
            instance.startLoad(-1);
          });
          instance.on(HlsLib.Events.LEVELS_UPDATED, refreshLevels);
          instance.loadSource(item.stream_url);
          instance.attachMedia(elements.video);
          instance.on(HlsLib.Events.ERROR, (_evt, data) => {
            if (data?.fatal && playback.owns(target, generation)) {
              qualitySource.resumeAuto();
              hlsRecoverySession?.handleFatal(data);
            }
          });
      } else if (engine === 'native') {
        if (!expectsPicture(item)) noteHlsAudio();
        elements.video.src = item.stream_url;
      } else {
        showBrokenState('HLS playback is unavailable in this browser.', { showNext: false });
        startOutcome.cancel(item.id);
        return;
      }
    } else if (kind === 'dash') {
      try {
        const session = await createDashPlayback(elements.video, item.stream_url, {
          autoplay: false,
          startTime: dashStart,
          quality: videoQuality,
          owns: () => !stale() && playback.owns(target, generation),
          onError: (_error, { retryInAuto = false } = {}) => {
            if (stale() || !playback.owns(target, generation)) return;
            if (!retryInAuto) {
              failPlayback('DASH playback failed.', { showNext: true });
              return;
            }
            const position = dashLiveNow() === false && target.currentTime > 0 ? target.currentTime : undefined;
            queueMicrotask(() => {
              if (stale() || !playback.owns(target, generation)) return;
              playedStreamNote.renditionChanged();
              attachStream(item, token, { relayAvailable, dashStart: position }).catch(() => {
                if (!stale()) failPlayback('DASH playback failed.', { showNext: true });
              });
            });
          },
        });
        if (stale() || !playback.owns(target, generation)) {
          session.destroy();
          return;
        }
        dashSession = session;
        syncPlaybackUi('dash-delivery');
      } catch (error) {
        if (playback.owns(target, generation)) {
          console.warn('dash.js could not start:', error);
          showBrokenState(
            error?.message === 'DASH_MSE_UNAVAILABLE'
              ? 'DASH playback requires Media Source Extensions.'
              : 'DASH playback could not be initialized.',
            { showNext: false },
          );
          // This browser's playback, not the station: no result.
          startOutcome.cancel(item.id);
        }
        return;
      }
    } else {
      elements.video.src = item.stream_url;
      setComputerSourceAttached(true);
    }
    elements.audio.hidden = true;
    if (stale() || !playback.owns(target, generation)) return;
    if (computerPlayback?.kind === 'video') computerTracks?.attach();
    if (kind === 'hls' && !computerPlayback?.hls) {
      await waitForHlsStartupBuffer(target, {
        owns: () => !stale() && playback.owns(target, generation),
      });
      if (stale() || !playback.owns(target, generation)) return;
    }
    if (computerPlayback && playSession.userPaused) {
      setMediaPriority(false);
      syncPlaybackUi('computer-paused');
      return;
    }
    try {
      playbackStarted = await attemptMediaPlay(target);
    } catch (e) {
      if (pausedDuringStart(e, token)) {
        syncPlaybackUi('paused-during-start');
      } else if (playback.owns(target, generation) && !hlsRecoverySession?.isRecovering) {
        if (computerPlayback) return handleComputerMediaError(target, e);
        console.warn('video play() rejected:', e);
        noteStartFailure(e, token);
        if (e?.name === 'NotAllowedError' || !startWatch.failed(token)) {
          showBrokenState('Playback did not start. Press Play to retry.', { showNext: false, retry: true });
          // Autoplay rules are the browser's, not the station's: no result.
          if (e?.name === 'NotAllowedError') startOutcome.cancel(item.id);
          else startOutcome.failed(currentItem?.id, 'stream');
        }
      }
    }
  } else {
    releaseVideoClearance();
    showVideo(false);
    elements.audio.src = item.stream_url;
    setComputerSourceAttached(true);
    elements.video.hidden = true;
    if (stale() || !playback.owns(target, generation)) return;
    if ((partPlayback || computerPlayback) && playSession.userPaused) {
      setMediaPriority(false);
      syncPlaybackUi('sleep');
      return;
    }
    try {
      playbackStarted = await attemptMediaPlay(target);
    } catch (e) {
      if (pausedDuringStart(e, token)) {
        syncPlaybackUi('paused-during-start');
      } else if (playback.owns(target, generation)) {
        if (computerPlayback) return handleComputerMediaError(target, e);
        console.warn('audio play() rejected:', e);
        noteStartFailure(e, token);
        if (e?.name === 'NotAllowedError' || !startWatch.failed(token)) {
          showBrokenState('Playback did not start. Press Play to retry.', { showNext: false, retry: true });
          if (e?.name === 'NotAllowedError') startOutcome.cancel(item.id);
          else startOutcome.failed(currentItem?.id, 'stream');
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

function playbackAllowed(item) {
  return item.__contentHidden !== true && isContentAllowed(item, getState().settings);
}

function clearPendingComputerStart({ abort = true } = {}) {
  const pending = pendingComputerStart;
  if (!pending) return;
  pendingComputerStart = null;
  audioEngine.updateIdle();
  clearTimeout(pending.timer);
  if (abort) pending.controller.abort();
  if (pending.hint && elements.source.textContent === pending.hint && !playbackProblem) setMetaText(currentItem);
}

function protectComputerStart(item, options) {
  const active = getActiveEl();
  return isComputerItem(item) && playbackAllowed(item) && currentItem?.id !== item.id
    && !options.automatic && !options.prepared && !options.computerRowError
    && currentItem && active && !active.error && !active.ended && !playbackProblem && !computerPlayback?.finished
    && (!active.paused || active.currentTime > 0);
}

async function requestPendingComputerStart(pending, item, convert = false) {
  const stale = () => pendingComputerStart !== pending;
  const { controller } = pending;
  const request = () => requestComputerMedia(item, { controller, stale, convert, preferAudio: true, standby: true });
  let retried = false;
  async function open() {
    try {
      return await request();
    } catch (error) {
      if (stale() || retried || error?.status !== 503 || !error.retryable) throw error;
      retried = true;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 1_500);
        controller.signal.addEventListener('abort', done, { once: true });
      });
      controller.signal.throwIfAborted();
      return request();
    }
  }
  try {
    let opened = await open();
    if (!stale() && !convert && needsComputerAudioConversion(opened.media)) {
      releaseComputerAnswer(opened.media);
      convert = true;
      opened = await open();
    }
    return { ...opened, convert };
  } catch (error) {
    return { error, convert };
  }
}

function showPendingComputerHint(pending) {
  if (pendingComputerStart !== pending || playbackProblem) return;
  clearComputerTrackMessage();
  pending.hint = 'Preparing ' + (shownTitle(pending.item) || 'file') + '...';
  setSourceLine(pending.hint, { status: true });
}

// Open a selected Computer file while the previous item still owns playback.
// When a start commits, playToken guards its media work against later switches.
// Choosing a station that's waiting to reconnect tries it in the same episode.
export async function playItem(item, options = {}) {
  playbackActions++;
  clearPendingComputerStart();
  if (options.parts && !options.parts[options.index]) return;
  if (protectComputerStart(item, options)) {
    discardComputerStandby();
    if (computerPlayback) computerPlayback.standbyAttempted = false;
    cancelComputerAdvance();
    const pending = { item, controller: new AbortController(), hint: '' };
    pendingComputerStart = pending;
    audioEngine.updateIdle();
    pending.timer = setTimeout(() => showPendingComputerHint(pending), COMPUTER_PREPARING_MS);
    const computerOpen = await requestPendingComputerStart(pending, item, options.convertComputer);
    if (pendingComputerStart !== pending) {
      releaseComputerAnswer(computerOpen.media);
      return;
    }
    clearPendingComputerStart({ abort: false });
    if ('error' in computerOpen) {
      markMissingComputerFile(item, computerOpen.error);
      showComputerSelectionMessage(computerOpenMessage(computerOpen.error, shownTitle(item) || 'file'));
      return;
    }
    options = { ...options, computerOpen };
  }
  if (!options.parts && reconnectPending(item) && streamAddressesCurrent()) {
    await liveResume.attemptNow();
    return;
  }
  videoQuality?.resetSession();
  cancelReconnect();
  // A start the user asked for: its result is remembered (did-not-play.js).
  if (isComputerItem(item)) startOutcome.cancel();
  else startOutcome.begin(item?.id);
  startsInFlight += 1;
  try {
    await startPlayback(item, options);
  } catch (error) {
    // Blocked before it began (the explicit-content setting): no result.
    startOutcome.cancel(item?.id);
    throw error;
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

async function startPlayback(item, options = {}) {
  if (!item) {
    showBrokenState('No item');
    return;
  }
  if (!playbackAllowed(item)) {
    releaseComputerAnswer(options.computerOpen?.media ?? options.prepared?.media);
    const error = new Error('This item is hidden by the explicit-content setting.');
    error.code = 'CONTENT_RATING_BLOCKED';
    emit('content-blocked', { itemId: item.id, source: item.source });
    throw error;
  }
  rememberCurrentPosition();
  const sourceKey = options.prepared ? signalSourceKey() : undefined;
  const myToken = ++playToken;
  startWatch.end();
  clearAudioStarts();
  return duringAudioStart(() => startPlaybackSession(item, myToken, sourceKey, options));
}

async function startPlaybackSession(item, myToken, sourceKey, {
  skipStreams = [], parts = null, index = 0, position = 0, epoch = partResumeGeneration(),
  computerQueue = null, startAt, convertComputer = false, computerRowError = null, keepComputerTracks = false,
  prepared, computerOpen,
}) {
  const local = isComputerItem(item);
  setComputerQueue(local ? computerQueue : null);
  const measureId = isComputerMusic(item) && levellingMode(getState().settings) !== 'off'
    ? item._extra?.computer?.id : null;
  loudnessRequests.retain(measureId);
  reserveVideoClearance(item);
  cancelScheduledCheck();
  verifiedPlaying = null;
  // Before any await: a poll still on its way for the previous station must
  // not show its song (or put it in Media Session) under the new station.
  nowPlaying.stop();
  playSession = newPlaySession(myToken);
  const addresses = local ? null : stationStreamAddresses(item);
  if (addresses) {
    playedStreamNote.begin();
    playSession.addressSignature = JSON.stringify(addresses);
    playSession.orderedAddresses = addresses.ordered;
  }
  stallWatchdog.stop();
  setMediaPriority(true);
  cancelPendingResolution();
  repairFiniteMediaFields(item);
  if (!local) persistFavoriteMetadata(item);
  activePlaybackRelayed = false;
  releaseRelay(5);
  if (computerPlayback?.hls) completeComputerSeek(computerPlayback);
  clearComputerTrackMessage();
  clearComputerAudioPoster();
  if (local && keepComputerTracks && currentItem?.id === item.id) computerTracks?.detach();
  else computerTracks?.reset();
  invalidatePlaybackOwnership();
  destroyHls();
  releaseComputerSession();
  destroyDash();
  clearMedia(elements.audio);
  clearMedia(elements.video);
  // Ordinary starts always use the original radio element and its relay/CORS path.
  if (prepared || elements.audio.id !== 'audio-el') {
    [elements.audio, elements.standby] = [elements.standby, elements.audio];
  }
  applyComputerLevelling(null, { immediate: true });
  showVideo(false);
  currentItem = item;
  computerStartAt = local && Number.isFinite(startAt) && startAt >= 0 ? startAt : undefined;
  computerPlayback = null;
  computerOpenRetryable = false;
  partPlayback = null;
  pendingPartResume = null;
  if (!local && parts?.length) selectPart(parts, index, position, epoch);
  syncPartControls();
  if (elements.capture) elements.capture.hidden = local;
  if (!prepared) setCurrentItem(item);
  const curve = effectiveEqCurve(item);
  audioEngine.applyCurve(curve);
  // This is intentionally the first awaited operation: AudioContext.resume()
  // must begin inside the Play/card-click user activation, before stream
  // resolution or relay registration yields back to the event loop.
  if (prepared) {
    computerRetryConvert = false;
    return startComputerMedia(item, myToken, prepared.media, { prepared, sourceKey });
  }
  // An open answer takes ownership before any await. Its source attachment
  // resumes the audio graph and Stop can already release its token.
  if (computerOpen) {
    const { media, requestedAudio, convert } = computerOpen;
    computerRetryConvert = convert;
    hideBrokenState();
    setMeta(item);
    return startComputerMedia(item, myToken, media, { requestedAudio, convert, promote: true });
  }
  await audioEngine.resume({ create: true });
  // A switch or Stop during that await owns the player bar now.
  if (myToken !== playToken) return;
  hideBrokenState();
  setMeta(item);
  syncPlaybackUi('source-switch');
  if (local) {
    if (computerRowError) {
      showBrokenState(computerRowError, { showNext: false });
      return;
    }
    await attachComputerFile(item, myToken, null, convertComputer);
    return;
  }

  let resolveMessage = '';
  let resolveError = null;
  const needsStream = !addresses.main && item._extra?.needsResolve && !item.stream_url;
  const needsParts = !parts && hasPartsSource(item);
  if (needsStream || needsParts) {
    setTitleLine(shownTitle(item) || 'Loading…');
    setSourceLine(reconnectStatus || 'Resolving stream…', { status: Boolean(reconnectStatus) });
    const controller = new AbortController();
    resolutionController = controller;
    try {
      const mod = await loadAdapter(item.source);
      if (myToken !== playToken || controller.signal.aborted) return;
      if (needsParts) parts = await loadParts(item);
      if (myToken !== playToken || controller.signal.aborted) return;
      if (needsStream && typeof mod.resolveStream === 'function') {
        await mod.resolveStream(item, {
          signal: controller.signal,
          showExplicitContent: getState().settings.showExplicitContent === true,
        });
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && myToken === playToken) {
        console.warn('Lazy resolve failed:', err);
        resolveMessage = resolveFailureMessage(err);
        resolveError = err;
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
    if (parts?.length && !partPlayback) {
      const resume = remembersPart(item, parts) ? resumablePart(item, parts, readPartResume(item.id)) : null;
      if (resume) {
        pendingPartResume = { ...resume, parts };
        setMediaPriority(false);
        startOutcome.cancel(item.id);
      } else {
        selectPart(parts, index, position, epoch);
      }
    }
    setMeta(item);
    setCurrentItem(item);
    syncPlaybackUi('resolved');
  }

  if (myToken !== playToken || pendingPartResume) return;
  const relayItem = itemForPart(item, partPlayback);
  if (!relayItem.stream_url && !addresses.ordered) {
    showBrokenState(resolveMessage || 'No stream URL');
    reportUnplayable(item);
    startOutcome.failed(item.id, startFailureKind(resolveError));
    return;
  }
  let playbackItem = item;
  let relayAvailable = false;
  const connectionController = new AbortController();
  resolutionController = connectionController;
  try {
    // Current IPTV catalog entries carry alternates. Older saved favorites do
    // not, so let an adapter refresh its bounded candidates before connecting.
    if (!partPlayback && !addresses.ordered && !Array.isArray(item._extra?.streamCandidates)) {
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
    // A part is a specific file. Station failover must not substitute the
    // parent item's first file if the selected chapter needs a retry.
    const verified = partPlayback || addresses.ordered ? null : verifiedStreamFor(item, getState().settings);
    const preferBest = !partPlayback && bestStreamOn(getState().settings);
    const extraStreams = verified ? [verified] : [];
    const rotating = addresses.ordered && reconnectingCurrentItem();
    const attempted = rotating ? reconnectTried : new Set(skipStreams);
    if (rotating) {
      // After a full pass, the reconnect backoff still governs the next try.
      if (!untriedStreams(item, { addresses, tried: attempted }).length) attempted.clear();
      skipStreams = [...attempted];
    }
    const relay = await connectMediaRelay(relayItem, {
      signal: connectionController.signal, preferBest, extraStreams, skipUrls: skipStreams, addresses,
      onAttempt: addresses.ordered ? (url) => attempted.add(url) : undefined,
    });
    if (myToken !== playToken) {
      expireMedia(relay.media_id, 0).catch(() => {});
      return;
    }
    setActiveRelay(relay.media_id);
    // The stream is set up: the start time limit runs from here. It answered
    // only if the relay tested it; otherwise its first data says so.
    startOutcome.streamSetUp(item.id);
    if (relayWasProbed(relay)) startOutcome.answered(item.id);
    playSession.candidate = playedStream(relayItem);
    playbackItem = { ...relayItem, stream_url: relay.relay_url, stream_kind: activeStreamKind() };
    relayAvailable = true;
    verifiedPlaying = afterBestStreamStart(item, verified) ? verified : null;
    persistFavoriteMetadata(item);
    setMeta(item);
    setCurrentItem(item, playSession.candidate);
    emit('media-relay', { available: true, mediaId: relay.media_id });
    // Auto (verified): a new playback session. The background check of this
    // station is planned at its first `playing` (onPlaying), so its wait
    // counts time with sound, not time spent connecting.
    cancelScheduledCheck();
    // Listed and Auto: should this stream connect but not play, the streams
    // not tried yet get their turn (start-failover.js). Not inside a
    // reconnect, which has its own rules.
    if (!partPlayback && (addresses.ordered || preferBest) && !reconnectingCurrentItem() && streamAddressesCurrent()) {
      const tried = addresses.ordered ? attempted : [...skipStreams, playSession.candidate?.url].filter(Boolean);
      if (untriedStreams(item, { addresses, extraStreams, tried }).length) startWatch.arm(myToken, item, tried);
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
        // Only when no stream of this start failed for another reason first.
        : (skipStreams.length ? '' : hostLookupFailureMessage(error, item)) || (error instanceof MediaConnectionError
          ? 'No working stream endpoint answered for this channel. Press Play to retry.'
          : 'Secure media relay unavailable. Press Play on the item to retry.');
      showBrokenState(message, {
        showNext: false,
        // Media was already torn down; Play stays in the bar and starts the
        // item again, as the message says (playFromUser).
        retry: true,
      });
      reportUnplayable(item);
      // Every stream failed (a full relay is the app's limit, not the station's).
      startOutcome.failed(item.id, registryFull ? 'app' : startFailureKind(error));
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
  const generation = playback.generation;
  // HLS streams attach via MediaSource so el.src may be empty even when active.
  const hasSource = !!el.src || !!hlsInstance || !!dashSession;
  if (!hasSource) return false;
  setMediaPriority(true);
  if (activePlaybackRelayed && !audioEngine.isAttached(el)) {
    await resumeEqualizerFromGesture();
  }
  if (!playback.owns(el, generation)) return false;
  applyComputerLevelling();
  try {
    if (!await attemptMediaPlay(el)) return false;
    if (playback.owns(el, generation)) {
      hideBrokenState();
      if (currentItem) setMetaText(currentItem);
      syncPlaybackUi('play-resolved');
      if (audioEngine.isAttached(el)) {
        verifyEqualizerSignal(el, playToken, playback.generation);
      }
    }
    return true;
  } catch (error) {
    if (playback.owns(el, generation)) {
      if (computerPlayback) {
        if (!pausedDuringStart(error, playToken)) await handleComputerMediaError(el, error);
        return false;
      }
      console.warn('play() rejected:', error);
      showBrokenState('Playback did not start. Press Play to retry.', { showNext: false });
    }
    return false;
  }
}

/** Every user "play" (the Play button, Media Session, media keys) goes here,
 *  so a broken, reconnecting or given-up stream is rebuilt the same way. */
async function playFromUser() {
  playbackActions++;
  // A start on its way: let it finish (the first press is being answered).
  if ((startsInFlight > 0 && !canRestartComputerSession()) || pendingPartResume
      || (isComputerItem(currentItem) && resolutionController && !computerPlayback?.audioChange)) return false;
  if (currentItem && !isContentAllowed(currentItem, getState().settings)) {
    stop();
    return false;
  }
  const local = isComputerItem(currentItem);
  if (currentItem && !local && !streamAddressesCurrent()) {
    await playItem(currentItem);
    const target = getActiveEl();
    return Boolean(target && !playbackProblem && !target.paused);
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
    const part = partPlayback;
    if (local && !computerOpenRetryable) resetComputerTrackFailures();
    await playItem(retryItem, part ? {
      parts: part.parts, index: part.index, position: part.position, epoch: part.epoch,
    } : local ? {
      computerQueue: computerQueueState(), startAt: computerStartAt,
      convertComputer: computerRetryConvert, keepComputerTracks: true,
    } : {});
    const retryTarget = getActiveEl();
    return Boolean(retryTarget && !playbackProblem && !retryTarget.paused);
  }
  // Nothing left to resume: the stream ended (a live stream whose connection
  // closed without a reconnect), the element is in an error state, or its
  // media was torn down. play() on that does nothing useful, so the item
  // starts afresh with a new connection, as after Stop.
  const active = getActiveEl();
  if (partPlayback?.finished && partPlayback.parts[partPlayback.index + 1]) {
    const { parts, index, epoch } = partPlayback;
    await playItem(currentItem, { parts, index: index + 1, epoch });
    return Boolean(getActiveEl() && !playbackProblem && !getActiveEl().paused);
  }
  if (currentItem && (!active || active.ended || active.error
      || (computerPlayback?.hls && computerPlayback.finished)
      || (!active.src && !hlsInstance && !dashSession))) {
    const freshItem = currentItem;
    await playItem(freshItem, local ? {
      computerQueue: computerQueueState(), startAt: computerPlayback?.finished ? 0 : computerStartAt,
      convertComputer: computerPlayback?.hls && computerRetryConvert, keepComputerTracks: true,
    } : {});
    const freshTarget = getActiveEl();
    return Boolean(freshTarget && !playbackProblem && !freshTarget.paused);
  }
  if (!active) return false;
  playSession.sleepExpired = false;
  if (local) playSession.userPaused = false;
  if (finishComputerBufferedEnd(active)) return false;
  return duringAudioStart(playActive);
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
  clearPendingComputerStart();
  playbackActions++;
  rememberCurrentPosition();
  clearComputerQueue();
  loudnessRequests.retain();
  if (computerPlayback?.hls) completeComputerSeek(computerPlayback);
  computerStartAt = undefined;
  clearComputerTrackMessage();
  clearComputerAudioPoster();
  computerTracks?.reset();
  clearComputerArtwork();
  syncComputerMediaSession(null);
  partPlayback = null;
  pendingPartResume = null;
  startWatch.end();
  // Stopped by the user before a result: no result.
  startOutcome.cancel();
  nowPlaying.stop(); // at once: the song and its Media Session entry go with the station
  stallWatchdog.stop();
  // Bump the token so any in-flight playItem aborts.
  playToken++;
  clearAudioStarts();
  cancelScheduledCheck();
  verifiedPlaying = null;
  setMediaPriority(false);
  cancelPendingResolution('Playback stopped');
  if (isComputerItem(currentItem)) setSourceLine('');
  releaseRelay(0);
  invalidatePlaybackOwnership();
  destroyHls();
  releaseComputerSession();
  computerPlayback = null;
  destroyDash();
  clearMedia(elements.audio);
  clearMedia(elements.video);
  applyComputerLevelling(null, { immediate: true });
  activePlaybackRelayed = false;
  metadataArtworkToken += 1;
  hideBrokenState();
  bar.hidden = true;
  document.getElementById('app')?.classList.remove('has-player');
  showVideo(false);
  setVideoClearance();
  currentItem = null;
  if (elements.capture) elements.capture.hidden = false;
  setCurrentItem(null);
  syncPlaybackUi('stop');
}

export function setVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  const level = Math.round(v * 100);
  for (const el of [elements.audio, elements.standby, elements.video].filter(Boolean)) {
    // A sleep-timer fade is running (lib/sleep-timer.js): it lowers the
    // element from the level it started at and, when it ends or is
    // cancelled, puts back the level in data-pre-fade-vol. The new level goes
    // there, so that is what comes back; the fade keeps the live volume.
    if (el.dataset?.preFadeVol) { el.dataset.preFadeVol = String(v); continue; }
    // An element already at this level (the video whose own control was just
    // moved) is left as it is: no write back, no rounding drift, no loop.
    if (clampVolume(Number(el.volume) * 100) !== level) el.volume = v;
  }
  elements.vol.value = String(level);
  saveVolume(v * 100);
  syncVolumeUi();
}

/** A media element's volume or mute changed (its volumechange event). Our
 *  own setVolume and setMuted leave it matching the store, so they change
 *  nothing here; the video's native controls do. A sleep-timer fade (the
 *  elements carry data-pre-fade-vol while it runs) is not the user's volume. */
function adoptElementVolume(el) {
  const change = elementVolumeChange({
    volume: el.volume,
    muted: el.muted,
    storedPct: elements.vol.value,
    storedMuted: elements.mute.getAttribute('aria-pressed') === 'true',
    fading: [elements.audio, elements.standby, elements.video].filter(Boolean).some((media) => media?.dataset?.preFadeVol),
  });
  if (change) {
    if (change.muted !== null) setMuted(change.muted);
    if (change.pct !== null) setVolume(change.pct);
  }
  // Native changes can be finer than the bar's whole-percent scale.
  if (el !== elements.video && elements.standby) {
    const other = el === elements.audio ? elements.standby : elements.audio;
    if (other.volume !== el.volume) other.volume = el.volume;
  }
}

// The bar shows mute and the saved volume rounded to a whole percent.
export function isSilent(muted, volumePct) {
  return !!muted || Math.round(volumePct) <= 0;
}

export function volumeText(volumePct) {
  return `${Math.round(Math.max(0, Math.min(100, volumePct)))}%`;
}

export function isPlayerSilent() {
  const el = getActiveEl();
  return Boolean(el && (el.muted || el.volume === 0));
}

function syncPlayerSilence() {
  const silent = isPlayerSilent();
  if (silent === playerSilent) return;
  playerSilent = silent;
  emit(PLAYER_SILENT_CHANGE, silent);
}

function syncVolumeUi() {
  // The slider holds the user's volume; a sleep-timer fade only changes the media elements.
  // (It is hidden: the stepper's buttons, wheel and keys set it through setVolume.)
  const pct = Number(elements.vol.value);
  const text = volumeText(pct);
  elements.vol.title = `Volume ${text}`;
  elements.vol.setAttribute('aria-valuetext', text);
  elements.mute.dataset.silent = String(isSilent(elements.audio.muted, pct));
  if (elements.volReadout) {
    const level = String(clampVolume(pct));
    elements.volReadout.textContent = level;
    elements.volReadout.setAttribute('aria-label', `Volume ${level}`);
  }
  if (elements.volControl) elements.volControl.title = `Volume ${text}`;
  syncPlayerSilence();
}

export function getPlaybackActionCount() { return playbackActions; }

export function getCurrentItem() { return currentItem; }
export function getComputerLevellingDetails(itemId) {
  return currentItem?.id === itemId ? levellingDetails : null;
}
export function isComputerPlaybackConverted(itemId) {
  return currentItem?.id === itemId && computerPlayback?.convertedAttached === true;
}
export function getCurrentPart(itemId) {
  return partPlayback && currentItem?.id === itemId ? partPlayback : null;
}
export function getItemForDownload(item) {
  return itemForPart(item, getCurrentPart(item?.id));
}
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
  return resolveMediaAction(getItemForDownload(currentItem), evidence);
}

export function isMuted() { return elements.audio.muted; }
export function setMuted(m) {
  const muted = !!m;
  elements.audio.muted = muted;
  if (elements.standby) elements.standby.muted = muted;
  elements.video.muted = muted;
  elements.mute.title = muted ? 'Unmute' : 'Mute';
  elements.mute.setAttribute('aria-label', elements.mute.title);
  elements.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  syncVolumeUi();
}

function bindControls() {
  elements.play.addEventListener('click', () => togglePlay());
  elements.stop.addEventListener('click', () => stop());
  function movePart(offset) {
    if (isComputerItem(currentItem)) {
      const button = offset < 0 ? elements.previousPart : elements.nextPart;
      if (button?.disabled) return;
      const el = getActiveEl();
      if ((computerQueueState()?.entries.length ?? 0) < 2) {
        const chapters = currentItem._extra?.computer?.chapters;
        if (!chapters?.length || !el || el.error) return;
        const steps = chapterSteps(chapters, computerPosition(el));
        const position = offset < 0 ? steps.previous : steps.next;
        if (position != null) {
          seekFromControls(el, position);
          rememberCurrentPosition(el);
          syncPartControls();
        }
        return;
      }
      if (offset < 0 && el && computerPosition(el) > 3 && !el.error) {
        seekFromControls(el, 0);
        rememberCurrentPosition(el);
        syncPartControls();
      } else moveComputerQueue(offset)?.catch(() => {});
      return;
    }
    const part = partPlayback;
    if (part) playItem(currentItem, { parts: part.parts, index: part.index + offset }).catch(() => {});
  }
  function chooseResume(resume) {
    const offer = pendingPartResume;
    if (!offer) return;
    const { parts, index, position } = offer;
    playItem(currentItem, { parts, index: resume ? index : 0, position: resume ? position : 0 }).catch(() => {});
  }
  elements.previousPart?.addEventListener('click', () => movePart(-1));
  elements.nextPart?.addEventListener('click', () => movePart(1));
  elements.resumePart?.addEventListener('click', () => chooseResume(true));
  elements.startOver?.addEventListener('click', () => chooseResume(false));
  elements.mute.addEventListener('click', () => setMuted(!isMuted()));
  elements.vol.addEventListener('input', (e) => setVolume(+e.target.value));
  // Down, the level and up: a click is one step, a held button repeats, the
  // wheel and the arrow keys work over the whole control.
  if (elements.volControl && elements.volDown && elements.volUp) {
    bindVolumeStepper({
      group: elements.volControl, down: elements.volDown, up: elements.volUp,
      getVolume: () => Number(elements.vol.value), setVolume,
    });
  }
  elements.seek.addEventListener('input', (e) => {
    const el = getActiveEl();
    if (!el) return;
    el.__seeking = true;
    seekFromControls(el, +e.target.value);
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
    const item = currentItem;
    if (!item) return;
    const toggle = () => {
      if (isFavorite(item.id)) removeFavorite(item.id);
      else addFavorite(item);
      syncFavButton();
    };
    if (isComputerItem(item)) void withComputerStars(toggle);
    else toggle();
  });

  // Restore persisted volume, or fall back to 80%.
  const persisted = loadVolume();
  const startVol = persisted != null ? persisted : 80;
  elements.audio.volume = startVol / 100;
  if (elements.standby) elements.standby.volume = startVol / 100;
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

export function initPlayer({ loadHls = loadHlsIfNeeded } = {}) {
  hlsLoader = loadHls;
  bindElements();
  computerTracks = bindComputerTracks(elements.video, $, {
    chooseAudio: (index) => chooseComputerAudio(index).catch(() => {}),
    showMessage: (message) => showComputerPlayMessage(message, { transient: true }),
  });
  bindControls();
  bindMediaSession();
  bindVideoSizeButton();
  videoQuality = createVideoQuality(elements.video, () => setPictureItem.renderQuality?.());
  setPictureItem = bindPicturePanel(elements.video, $, videoQuality);
  bindVideoPicture();
  document.addEventListener('visibilitychange', () => {
    if (computerPlayback?.checkVideo) computerPlayback.videoTime = getActiveEl()?.currentTime;
  });
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
      if (isComputerItem(currentItem)) syncComputerMediaSession(currentItem);
    }
  });
  subscribe('eq-change', () => applyCurrentEq());
  subscribe('eq-scope-change', () => applyCurrentEq());
  subscribe('eq-user-gesture', () => {
    const el = getActiveEl();
    if (el && audioEngine.isAttached(el) && (el.paused || el.ended)) return;
    resumeEqualizerFromGesture().catch(() => {});
  });
  // The visual signal runs only while something plays (and someone listens).
  subscribe('playing-change', () => audioSignal.refresh());
  // ...and only while it can be heard: muting or volume 0 rests it.
  for (const el of [elements.audio, elements.standby, elements.video].filter(Boolean)) {
    el?.addEventListener?.('volumechange', () => {
      // The video's own controls can update the saved volume and mute.
      adoptElementVolume(el);
      syncPlayerSilence();
      audioSignal.refresh();
    });
  }
  subscribe('content-policy-change', ({ current, currentItem: changedItem } = {}) => {
    if (current !== true && changedItem?.id === currentItem?.id
        && !isContentAllowed(currentItem, false)) stop();
  });
  // The sleep timer pauses the media itself; it must also stop reconnecting.
  subscribe('part-resume-cleared', () => { if (pendingPartResume) stop(); });
  subscribe('sleep-fired', () => {
    clearPendingComputerStart();
    discardComputerStandby();
    if (currentItem) playbackActions++;
    if (isComputerItem(currentItem)) {
      cancelComputerAdvance();
      playSession.sleepExpired = true;
      playSession.userPaused = true;
    } else if (partPlayback || hasPartsSource(currentItem)) playSession.sleepExpired = true;
    if (startsInFlight > 0 && playSession.sleepExpired) {
      playSession.userPaused = true;
      startOutcome.cancel(currentItem?.id);
    }
    stopReconnecting();
  });
  subscribe('station-streams-change', (id) => {
    startOutcome.invalidate(id);
    if (currentItem?.id !== id) return;
    reconnectTried = new Set();
    startWatch.end();
    cancelScheduledCheck();
  });
  // "Pick the best stream" changed away from Auto: its check's session ends
  // (timer cleared, check aborted, nothing remembered from a late answer).
  let previousSettings = getState().settings;
  subscribe('settings-change', (settings) => {
    followBestStreamSetting(settings);
    const levellingChanged = levellingMode(previousSettings) !== levellingMode(settings)
      || levellingPreamp(previousSettings) !== levellingPreamp(settings);
    previousSettings = settings;
    if (levellingChanged) {
      applyComputerLevelling();
      syncLoudnessRequests();
    }
    if (isComputerItem(currentItem) && metaLineShowsItem) setMetaText(currentItem);
  });
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
    clearPendingComputerStart();
    discardComputerStandby();
    rememberCurrentPosition();
    loudnessRequests.retain();
    if (isComputerItem(currentItem) && !computerPlayback) stop();
    if (isComputerItem(currentItem)) {
      playToken++;
      clearAudioStarts();
      cancelPendingResolution('Page hidden');
    }
    const local = computerPlayback;
    if (local && (local.mediaToken || local.hlsToken || local.seekPending)) {
      const el = getActiveEl();
      const position = el ? computerPosition(el) : local.refreshPosition;
      completeComputerSeek(local);
      local.hidden = true;
      computerStartAt = position ?? undefined;
      clearComputerSource(el ?? elements.video, { release: true });
      setMediaPriority(false);
      setMetaText(currentItem);
    }
    // A page kept in the back/forward cache can keep its remote relay.
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
