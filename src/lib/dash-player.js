/** Lazy dash.js lifecycle isolated from the global player controller. */

import { videoQualityLevel } from './video-quality.js';

let libraryPromise = null;

function dashVideoQuality(player) {
  return {
    apply({ fixed, cap }, previous, levels, chosen = false) {
      const allowed = cap ? levels.slice(0, levels.indexOf(cap) + 1) : levels;
      let maxBitrate = -1;
      if (cap && allowed.length < levels.length) {
        const maxAllowed = Math.max(...allowed.map((level) => level.bitrate)) / 1000;
        const firstExcluded = Math.min(...levels.slice(allowed.length).map((level) => level.bitrate)) / 1000;
        // Keep a conservative ceiling for ladders with overlapping bitrates.
        const minAllowed = Math.min(...allowed.map((level) => level.bitrate)) / 1000;
        maxBitrate = firstExcluded > minAllowed
          ? Math.min(maxAllowed, firstExcluded - 0.001) : minAllowed;
      }
      player.updateSettings({
        streaming: { abr: { autoSwitchBitrate: { video: !fixed }, maxBitrate: { video: maxBitrate } } },
      });
      if (fixed) {
        player.setRepresentationForTypeById('video', fixed.id, chosen);
        return;
      }
      if (!cap || previous?.fixed) return;
      const current = player.getCurrentRepresentationForType('video');
      if (current && maxBitrate >= 0 && current.bandwidth > maxBitrate * 1000) {
        const next = allowed.findLast((level) => level.bitrate <= maxBitrate * 1000);
        if (next) player.setRepresentationForTypeById('video', next.id, true);
        return;
      }
      if (!previous?.cap || allowed.indexOf(previous.cap) < 0
          || cap === previous.cap) return;
      const budget = player.getSafeAverageThroughput('video') * 1000;
      const next = current && allowed.findLast((level) => {
        const higher = level.height > current.height ||
          (level.height === current.height && level.bitrate > current.bandwidth);
        return higher && level.bitrate <= budget && (maxBitrate < 0 || level.bitrate <= maxBitrate * 1000);
      });
      if (next) player.setRepresentationForTypeById('video', next.id, true);
    },
  };
}

export async function loadDashLibrary({ importer = () => import('dashjs') } = {}) {
  if (!libraryPromise) {
    // dash.js' distribution includes optional data-attribute auto-discovery.
    // This app owns the lifecycle explicitly, so disable that scan before the
    // module evaluates (and avoid its fallback polling interval).
    if (globalThis.window) {
      globalThis.window.dashjs = {
        ...(globalThis.window.dashjs || {}),
        skipAutoCreate: true,
      };
    }
    libraryPromise = Promise.resolve().then(importer).then((module) => {
      const library = module?.MediaPlayer ? module : module?.default;
      if (!library?.MediaPlayer || typeof library.MediaPlayer !== 'function') {
        throw new Error('DASH_LIBRARY_INVALID');
      }
      return library;
    }).catch((error) => {
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

export function resetDashLibraryForTests() {
  libraryPromise = null;
}

export async function createDashPlayback(video, url, {
  library = null,
  onError = () => {},
  autoplay = false,
  startTime,
  quality = null,
  owns = () => true,
} = {}) {
  if (!video || typeof url !== 'string' || !url.startsWith('/api/v1/media/')) {
    throw new Error('DASH_RELAY_REQUIRED');
  }
  const dash = library || await loadDashLibrary();
  if (typeof dash.supportsMediaSource === 'function' && !dash.supportsMediaSource()) {
    throw new Error('DASH_MSE_UNAVAILABLE');
  }
  const player = dash.MediaPlayer().create();
  if (!player || typeof player.initialize !== 'function') {
    throw new Error('DASH_PLAYER_INVALID');
  }
  const events = dash.MediaPlayer.events;
  const errorEvent = events?.ERROR || 'error';
  const qualityEvent = events?.QUALITY_CHANGE_RENDERED || 'qualityChangeRendered';
  const refreshEvents = ['STREAM_INITIALIZED', 'STREAM_UPDATED', 'PERIOD_SWITCH_COMPLETED', 'TRACK_CHANGE_RENDERED']
    .map((name) => events?.[name]).filter(Boolean);
  const source = quality && dashVideoQuality(player);
  let renderedVideo = null;
  let destroyed = false;
  let retrying = false;

  function refreshLevels() {
    if (!source || destroyed || !owns()) return;
    const offered = player.getRepresentationsByTypeUnfiltered?.('video') ?? [];
    const levels = offered.map((raw) => videoQualityLevel(raw, raw.id)).sort((a, b) =>
      a.height - b.height || a.width - b.width || a.bitrate - b.bitrate);
    quality.setLevels(source, levels);
  }

  function recoverFixed() {
    if (retrying) return true;
    if (!source || destroyed || !owns() || !quality.fallBack(source)) return false;
    retrying = true;
    onError(null, { retryInAuto: true });
    return true;
  }

  const qualityHandler = (event) => {
    if (event?.mediaType !== 'video' || destroyed || !owns()) return;
    renderedVideo = event.newRepresentation ?? null;
    if (source) {
      refreshLevels();
      quality.rendered(source, renderedVideo);
    }
  };
  const errorHandler = (event) => {
    if (destroyed || !owns() || recoverFixed()) return;
    onError({
      code: Number(event?.error?.code ?? event?.code ?? 0) || 0,
      message: String(event?.error?.message ?? event?.message ?? 'DASH playback failed.').slice(0, 240),
    });
  };
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    renderedVideo = null;
    if (source) quality.clearSource(source);
    try { player.off?.(errorEvent, errorHandler); } catch (_) {}
    try { player.off?.(qualityEvent, qualityHandler); } catch (_) {}
    for (const event of refreshEvents) {
      try { player.off?.(event, refreshLevels); } catch (_) {}
    }
    try { player.destroy?.(); } catch (_) {}
  }

  try {
    if (source && owns()) quality.setSource(source);
    player.updateSettings?.({
      debug: { logLevel: dash.Debug?.LOG_LEVEL_WARNING ?? 3 },
    });
    player.on?.(errorEvent, errorHandler);
    player.on?.(qualityEvent, qualityHandler);
    for (const event of refreshEvents) player.on?.(event, refreshLevels);
    if (startTime == null) player.initialize(video, url, autoplay);
    else player.initialize(video, url, autoplay, startTime);
  } catch (error) {
    destroy();
    throw error;
  }
  return {
    player,
    /** True for a live (dynamic) stream, false for a recording; null while
     *  dash.js cannot tell yet (it throws before the stream is set up). */
    isLive() {
      if (destroyed) return null;
      try {
        const dynamic = player.isDynamic?.();
        return typeof dynamic === 'boolean' ? dynamic : null;
      } catch (_) {
        return null;
      }
    },
    videoRepresentation() {
      return destroyed ? null : renderedVideo;
    },
    recoverFixed,
    destroy,
  };
}
