/** Lazy dash.js lifecycle isolated from the global player controller. */

let libraryPromise = null;

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
  const errorEvent = dash.MediaPlayer.events?.ERROR || 'error';
  const errorHandler = (event) => onError({
    code: Number(event?.error?.code ?? event?.code ?? 0) || 0,
    message: String(event?.error?.message ?? event?.message ?? 'DASH playback failed.').slice(0, 240),
  });
  let destroyed = false;
  try {
    player.updateSettings?.({
      debug: { logLevel: dash.Debug?.LOG_LEVEL_WARNING ?? 3 },
    });
    player.on?.(errorEvent, errorHandler);
    player.initialize(video, url, autoplay);
  } catch (error) {
    try { player.off?.(errorEvent, errorHandler); } catch (_) {}
    try { player.destroy?.(); } catch (_) {}
    throw error;
  }
  return {
    player,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { player.off?.(errorEvent, errorHandler); } catch (_) {}
      try { player.destroy?.(); } catch (_) {}
    },
  };
}
