/**
 * Global player controller. Single player instance for the whole app —
 * survives mode switches. Supports audio, direct video, HLS (via vendored hls.js).
 */

import { getState, setCurrentItem, setPlaying, emit, subscribe, loadVolume, saveVolume,
         addFavorite, removeFavorite, isFavorite, persistFavoriteMetadata } from './state.js';
import { getSourceLabel, loadAdapter } from './sources.js';
import { postSilent } from './http.js';
import { isArtworkRelayUrl, resolveArtworkRelay } from './artwork.js';
import { createPlaybackState } from './player-state.js';
import { repairFiniteMediaFields, resolveMediaAction } from './media-capabilities.js';
import { expireMedia } from './capture-client.js';
import { connectMediaRelay, MediaConnectionError } from './media-failover.js';
import { createAudioEngine } from './audio-engine.js';
import { getEffectiveEq, loadEqState } from './eq-store.js';
import { createDashPlayback } from './dash-player.js';
import {
  createHlsRecoveryController, hlsPlaybackConfig, stableHlsLevelOrder,
  selectHlsPlaybackEngine, waitForHlsStartupBuffer,
} from './hls-recovery.js';
import { isContentAllowed } from './content-rating.js';

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
let resolutionController = null;
let eqSignalMonitorToken = 0; // cancels stale/duplicate analyser checks
let activeRelayId = '';
let activePlaybackRelayed = false;
let metadataArtworkToken = 0;
const audioEngine = createAudioEngine({
  onStatus: (status) => emit('eq-engine-change', status),
});

function effectiveEqCurve(item = currentItem) {
  if (!item?.id) return getEffectiveEq(loadEqState(), '', false);
  return getEffectiveEq(loadEqState(), item.id, isFavorite(item.id));
}

function releaseRelay(graceSeconds = 0) {
  const relayId = activeRelayId;
  activeRelayId = '';
  if (relayId) expireMedia(relayId, graceSeconds).catch(() => {});
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

function syncMediaSizing() {
  // Video shows large; audio is hidden but functional.
  const v = elements.video;
  v.style.position = 'absolute';
  v.style.bottom = 'calc(var(--player-h) + 8px)';
  v.style.right = '16px';
  v.style.width = '320px';
  v.style.maxWidth = '32vw';
  v.style.height = 'auto';
  v.style.background = 'black';
  v.style.borderRadius = '10px';
  v.style.border = '1px solid var(--border)';
  v.style.boxShadow = 'var(--shadow-2)';
  v.style.zIndex = '20';
}

function showVideo(show) {
  syncMediaSizing();
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
  elements.play.hidden = !currentItem || !hasSource;
  elements.play.disabled = !hasSource;

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
  return reason;
}

function showBrokenState(msg, { showNext = true } = {}) {
  elements.title.textContent = currentItem?.title || 'Stream unavailable';
  elements.source.textContent = msg || 'This stream could not be played';
  playbackProblem = { message: msg, showNext };
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
  elements.nextBroken.hidden = true;
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
  const sync = (reason) => owned(() => syncPlaybackUi(reason));
  const onTimeUpdate = owned(() => {
    hlsRecoverySession?.noteProgress(el.currentTime);
    syncPlaybackUi('timeupdate');
  });
  const onStalled = owned(() => {
    if (!el.paused && !el.ended) hlsRecoverySession?.noteStalled();
    syncPlaybackUi('stalled');
  });
  const onPlay = owned(() => {
    setMediaPriority(true);
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    syncPlaybackUi('play');
  });
  const onPlaying = owned(() => {
    setMediaPriority(true);
    hlsRecoverySession?.notePlaying();
    hideBrokenState();
    if (currentItem) setMetaText(currentItem);
    syncPlaybackUi('playing');
  });
  const onPaused = owned(() => {
    setMediaPriority(false);
    hlsRecoverySession?.notePaused();
    syncPlaybackUi('pause');
  });
  const onError = owned(() => {
    // The play() promise is the authoritative result while an attempt is
    // pending. Some streams emit an interim error while negotiating a redirect
    // or codec; pausing here aborts an attempt that may otherwise succeed.
    if (pendingPlay?.element === el) return;
    if (hlsRecoverySession?.isRecovering) return;
    showBrokenState('Playback error');
  });
  const bindings = [
    ['timeupdate', onTimeUpdate],
    ['loadedmetadata', sync('loadedmetadata')],
    ['durationchange', sync('durationchange')],
    ['play', onPlay],
    ['playing', onPlaying],
    ['pause', onPaused],
    ['ended', onPaused],
    ['emptied', onPaused],
    ['waiting', onStalled],
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
  elements.title.textContent = item.title || 'Untitled';
  elements.source.textContent = [getSourceLabel(item.source), item.country, item.language]
    .filter(Boolean).join(' · ');
}

function setMeta(item) {
  bar.hidden = false;
  document.getElementById('app')?.classList.add('has-player');
  setMetaText(item);
  const artworkToken = ++metadataArtworkToken;
  const attachArtwork = () => {
    if (artworkToken !== metadataArtworkToken || currentItem !== item
        || !isArtworkRelayUrl(item.thumbnail)) return;
    const src = item.thumbnail.trim();
    elements.art.referrerPolicy = 'no-referrer';
    elements.art.onload = () => { elements.art.style.opacity = '1'; };
    elements.art.onerror = () => { elements.art.removeAttribute('src'); elements.art.style.opacity = '0.2'; };
    if (elements.art.getAttribute('src') !== src) {
      elements.art.style.opacity = '0';
      elements.art.src = src;
    } else if (elements.art.complete && elements.art.naturalWidth > 0) {
      elements.art.style.opacity = '1';
    }
  };
  if (isArtworkRelayUrl(item.thumbnail)) {
    attachArtwork();
  } else {
    elements.art.removeAttribute('src');
    elements.art.style.opacity = '0.2';
    resolveArtworkRelay(item, { priority: 20 }).then(attachArtwork).catch(() => {});
  }
  syncFavButton();
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
    showVideo(true);
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
              if (currentItem) elements.title.textContent = currentItem.title || 'Live stream';
              elements.source.textContent = message;
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
            onTerminal: (message) => showBrokenState(message, { showNext: true }),
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
              showBrokenState('DASH playback failed.', { showNext: true });
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
      if (playback.owns(target, generation)) {
        console.warn('video play() rejected:', e);
        showBrokenState('Playback did not start. Press Play to retry.', { showNext: false });
      }
    }
  } else {
    showVideo(false);
    elements.audio.src = item.stream_url;
    elements.video.hidden = true;
    if (stale() || !playback.owns(target, generation)) return;
    try {
      await attemptMediaPlay(elements.audio);
      playbackStarted = playback.owns(target, generation) && !stale();
    } catch (e) {
      if (playback.owns(target, generation)) {
        console.warn('audio play() rejected:', e);
        showBrokenState('Playback did not start. Press Play to retry.', { showNext: false });
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
 */
export async function playItem(item) {
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
  hideBrokenState();
  setMeta(item);
  syncPlaybackUi('source-switch');

  if (item._extra?.needsResolve && !item.stream_url) {
    elements.title.textContent = item.title || 'Loading…';
    elements.source.textContent = 'Resolving stream…';
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
    showBrokenState('No stream URL');
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
        if (typeof mod.refreshStreamCandidates === 'function') {
          await mod.refreshStreamCandidates(item, { signal: connectionController.signal });
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // The saved URL is still worth one bounded attempt.
      }
    }
    const relay = await connectMediaRelay(item, { signal: connectionController.signal });
    if (myToken !== playToken) {
      expireMedia(relay.media_id, 0).catch(() => {});
      return;
    }
    activeRelayId = relay.media_id;
    playbackItem = { ...item, stream_url: relay.relay_url };
    relayAvailable = true;
    persistFavoriteMetadata(item);
    setMeta(item);
    setCurrentItem(item);
    emit('media-relay', { available: true, mediaId: relay.media_id });
  } catch (error) {
    // Remote media is never attached directly. Besides enforcing the network
    // boundary, this keeps Web Audio/EQ behavior identical for every source.
    console.warn('Same-origin media relay unavailable; playback was not attached:', error);
    emit('media-relay', { available: false, error });
    if (myToken === playToken) {
      const message = error instanceof MediaConnectionError
        ? 'No working stream endpoint answered for this channel. Press Play to retry.'
        : 'Secure media relay unavailable. Press Play on the item to retry.';
      showBrokenState(message, {
        showNext: false,
      });
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

export async function togglePlay() {
  if (currentItem && !isContentAllowed(currentItem, getState().settings)) {
    stop();
    return false;
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
  const el = getActiveEl();
  if (!el) return false;
  if (playbackProblem || el.paused || el.ended) return playActive();
  el.pause();
  return true;
}

export function stop() {
  // Bump the token so any in-flight playItem aborts.
  playToken++;
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
}

export function getCurrentItem() { return currentItem; }
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
  elements.seek.addEventListener('change', (e) => {
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
    mediaSession.setActionHandler('play', () => { playActive(); });
    mediaSession.setActionHandler('pause', () => { getActiveEl()?.pause(); });
    mediaSession.setActionHandler('stop', () => { stop(); });
  } catch (error) {
    console.warn('Media Session handlers unavailable:', error);
  }
}

export function initPlayer() {
  bindElements();
  bindControls();
  bindMediaSession();
  syncPlaybackUi('init');
  // Keep the player-bar star in sync if a Library card toggles favorites
  // for the currently-playing item.
  subscribe('favorites-change', () => {
    syncFavButton();
    applyCurrentEq();
  });
  subscribe('eq-change', () => applyCurrentEq());
  subscribe('eq-scope-change', () => applyCurrentEq());
  subscribe('eq-user-gesture', () => { resumeEqualizerFromGesture().catch(() => {}); });
  subscribe('content-policy-change', ({ current, currentItem: changedItem } = {}) => {
    if (current !== true && changedItem?.id === currentItem?.id
        && !isContentAllowed(currentItem, false)) stop();
  });
}
