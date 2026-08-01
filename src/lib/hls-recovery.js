/** Bounded recovery for fatal errors, explicit stalls, and silent HLS freezes.
 *
 * hls.js retries ordinary playlist/fragment failures internally. This layer
 * handles fatal events emitted after those retries are exhausted and media
 * elements that stop advancing without emitting a useful error. It deliberately
 * limits retries so a dead channel eventually exposes Try next instead of
 * looping forever.
 */

const NETWORK_DELAYS_MS = Object.freeze([1200, 3500]);
const MEDIA_DELAYS_MS = Object.freeze([0, 5000]);
const STABLE_RESET_MS = 30_000;
const RECOVERY_WATCHDOG_MS = 20_000;
const STALL_WATCHDOG_MS = 8_000;
const PROGRESS_WATCHDOG_MS = 8_000;
const REPEATED_STALL_LIMIT = 3;
const PROGRESS_EPSILON_SECONDS = 0.05;
export const HLS_STARTUP_BUFFER_SECONDS = 6;
export const HLS_STARTUP_BUFFER_TIMEOUT_MS = 30_000;

/** WebView2 may return "maybe" for native HLS while never decoding it.
 * Prefer the bundled, observable hls.js pipeline whenever MSE supports it.
 */
export function selectHlsPlaybackEngine({ hlsSupported = false, nativeSupport = '' } = {}) {
  if (hlsSupported) return 'hlsjs';
  if (typeof nativeSupport === 'string' && nativeSupport.length > 0) return 'native';
  return 'unavailable';
}

function bufferedSecondsAhead(media) {
  const ranges = media?.buffered;
  if (!ranges || !Number.isInteger(ranges.length)) return 0;
  const rawTime = Number(media?.currentTime);
  const currentTime = Number.isFinite(rawTime) ? Math.max(0, rawTime) : 0;
  let ahead = 0;
  for (let index = 0; index < ranges.length; index++) {
    try {
      const start = Number(ranges.start(index));
      const end = Number(ranges.end(index));
      // MSE can retain old, disconnected ranges after a live-window jump.
      // Only count the range that can actually feed the current playhead.
      if (currentTime >= start - 0.25 && currentTime <= end) {
        ahead = Math.max(ahead, end - Math.max(currentTime, start));
      }
    } catch (_) { /* a concurrently-changing TimeRanges is checked again */ }
  }
  return Math.max(0, ahead);
}

/** Let public HLS build a small cushion before playback starts.
 *
 * Many community IPTV origins deliver a two-second fragment in nearly two
 * seconds. Starting after the first fragment makes normal TLS jitter visible
 * as repeated pauses; a bounded six-second cushion absorbs that jitter without
 * turning an unreachable stream into an indefinite spinner.
 */
export function waitForHlsStartupBuffer(media, {
  targetSeconds = HLS_STARTUP_BUFFER_SECONDS,
  timeoutMs = HLS_STARTUP_BUFFER_TIMEOUT_MS,
  owns = () => true,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (!media?.buffered || typeof media.addEventListener !== 'function') {
    return Promise.resolve(false);
  }
  const target = Math.max(0, Number(targetSeconds) || 0);
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  if (bufferedSecondsAhead(media) >= target) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const events = [
      'progress', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'durationchange', 'seeking', 'seeked', 'timeupdate', 'error',
    ];
    const finish = (buffered) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      for (const event of events) media.removeEventListener(event, check);
      resolve(buffered);
    };
    const check = (event) => {
      if (!owns() || event?.type === 'error') return finish(false);
      if (bufferedSecondsAhead(media) >= target) return finish(true);
      return undefined;
    };
    for (const event of events) media.addEventListener(event, check);
    timer = setTimer(() => finish(false), timeout);
    check();
  });
}

export function hlsPlaybackConfig() {
  return {
    enableWorker: true,
    capLevelToPlayerSize: true,
    // Wait until the manifest has been inspected and a safe <=720p ceiling
    // has been installed. player.js starts loading immediately afterward.
    autoStartLoad: false,
    startLevel: -1,
    // IPTV stability is more important than being within one segment of the
    // live edge. The vendored hls.js defaults to low-latency mode and only a
    // one-segment startup window, which makes irregular public channels much
    // more sensitive to relay/TLS jitter.
    lowLatencyMode: false,
    // Three published fragments are enough for short-window public playlists;
    // stability comes from the deeper live offset and larger buffer ceiling.
    initialLiveManifestSize: 3,
    // Starting at the oldest entry of a five-fragment public playlist makes
    // that entry likely to expire while it is still being fetched. Stay three
    // fragments behind live: enough cushion without chasing evicted media.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 12,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 45,
    maxBufferHole: 0.5,
    nudgeMaxRetry: 5,
    // Leave extra bandwidth headroom when a recording is also consuming the
    // same upstream channel.
    // hls.js measures completed fragment throughput. Keep ample headroom,
    // especially while FFmpeg may independently record the same channel.
    abrEwmaDefaultEstimate: 700_000,
    abrBandWidthFactor: 0.72,
    abrBandWidthUpFactor: 0.5,
    abrMaxWithRealBitrate: true,
    maxStarvationDelay: 2,
    maxLoadingDelay: 4,
  };
}

/** Rank HLS levels for stable public-IPTV playback.
 *
 * Start with the best rendition no taller than the recording-quality default
 * (720p), then walk downward before trying oversized or undeclared levels.
 * Returning source indexes lets player.js install a downward-only ceiling
 * while leaving hls.js automatic bandwidth selection enabled underneath it.
 */
export function stableHlsLevelOrder(levels, targetHeight = 720) {
  if (!Array.isArray(levels)) return [];
  const target = Math.max(1, Number(targetHeight) || 720);
  const normalized = levels.map((level, index) => ({
    index,
    height: Math.max(0, Number(level?.height) || 0),
    width: Math.max(0, Number(level?.width) || 0),
    bitrate: Math.max(0, Number(level?.bitrate) || 0),
  }));
  const descending = (left, right) => (
    right.height - left.height || right.bitrate - left.bitrate || right.width - left.width || left.index - right.index
  );
  const within = normalized.filter((level) => level.height > 0 && level.height <= target).sort(descending);
  if (within.length) return within.map((level) => level.index);
  const oversized = normalized.filter((level) => level.height > target).sort((left, right) => (
    left.height - right.height || left.bitrate - right.bitrate || left.width - right.width || left.index - right.index
  ));
  // If every declared video rendition exceeds the target, choose only the
  // smallest one. A later "fallback" must never upshift to a larger stream.
  if (oversized.length) return [oversized[0].index];
  const unsized = normalized.filter((level) => level.height === 0).sort((left, right) => (
    right.bitrate - left.bitrate || left.index - right.index
  ));
  return unsized.map((level) => level.index);
}

export function createHlsRecoveryController({
  hls,
  errorTypes = {},
  owns = () => true,
  onRecovering = () => {},
  onRecovered = () => {},
  onTerminal = () => {},
  selectLowerRendition = () => false,
  getCurrentTime = () => Number.NaN,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (!hls) throw new TypeError('hls instance is required');
  let stopped = false;
  let networkAttempts = 0;
  let mediaAttempts = 0;
  let recoveryTimer = null;
  let recoveryWatchdog = null;
  let stableTimer = null;
  let stallTimer = null;
  let progressTimer = null;
  let recovering = false;
  let activelyPlaying = false;
  let stallEpisode = false;
  let lastProgressTime = null;
  let recentStalls = 0;

  const networkType = errorTypes.NETWORK_ERROR || 'networkError';
  const mediaType = errorTypes.MEDIA_ERROR || 'mediaError';

  function cancelTimer(timer) {
    if (timer != null) clearTimer(timer);
  }

  function terminal(message) {
    if (stopped || !owns()) return false;
    recovering = false;
    activelyPlaying = false;
    cancelTimer(recoveryTimer);
    cancelTimer(recoveryWatchdog);
    cancelTimer(stableTimer);
    cancelTimer(stallTimer);
    cancelTimer(progressTimer);
    recoveryTimer = null;
    recoveryWatchdog = null;
    stableTimer = null;
    stallTimer = null;
    progressTimer = null;
    onTerminal(message);
    return false;
  }

  function schedule(delay, action) {
    cancelTimer(recoveryTimer);
    recoveryTimer = setTimer(() => {
      recoveryTimer = null;
      if (stopped || !owns()) return;
      try {
        action();
        cancelTimer(recoveryWatchdog);
        recoveryWatchdog = setTimer(() => {
          recoveryWatchdog = null;
          terminal('Live stream did not resume after recovery.');
        }, RECOVERY_WATCHDOG_MS);
        onRecovered();
      } catch (error) {
        terminal(error?.message || 'HLS recovery failed.');
      }
    }, delay);
  }

  function restartNetworkLoad() {
    // startLoad() can be a no-op while hls.js still considers its loaders
    // active. A stop/start pair also clears a playlist request that has become
    // wedged without producing a fatal ERROR event.
    try { hls.stopLoad?.(); } catch (_) {}
    hls.startLoad(-1);
  }

  function handleFatal(data = {}) {
    if (stopped || !owns() || !data.fatal) return false;
    // hls.js and the media element can surface the same underlying failure
    // more than once. Do not let duplicates consume every retry before the
    // already-scheduled recovery has even run.
    if (recovering) return true;
    cancelTimer(stableTimer);
    cancelTimer(recoveryWatchdog);
    cancelTimer(stallTimer);
    cancelTimer(progressTimer);
    stableTimer = null;
    recoveryWatchdog = null;
    stallTimer = null;
    progressTimer = null;

    if (data.type === mediaType) {
      if (mediaAttempts >= MEDIA_DELAYS_MS.length) {
        return terminal('HLS media recovery was exhausted.');
      }
      const delay = MEDIA_DELAYS_MS[mediaAttempts++];
      recovering = true;
      onRecovering('Recovering stream audio/video…');
      schedule(delay, () => hls.recoverMediaError());
      return true;
    }

    if (data.type === networkType) {
      if (networkAttempts >= NETWORK_DELAYS_MS.length) {
        return terminal('HLS network recovery was exhausted.');
      }
      const delay = NETWORK_DELAYS_MS[networkAttempts++];
      recovering = true;
      onRecovering('Reconnecting live stream…');
      schedule(delay, () => {
        selectLowerRendition();
        restartNetworkLoad();
      });
      return true;
    }

    return terminal(`HLS fatal: ${data.type || 'unknown'}`);
  }

  function startStableWindow() {
    cancelTimer(stableTimer);
    stableTimer = setTimer(() => {
      stableTimer = null;
      if (stopped || !owns() || !activelyPlaying) return;
      networkAttempts = 0;
      mediaAttempts = 0;
      recentStalls = 0;
    }, STABLE_RESET_MS);
  }

  function recoverStall({ message, terminalMessage, errorMessage }) {
    if (stopped || !owns() || recovering || recoveryTimer != null) return false;
    cancelTimer(stableTimer);
    cancelTimer(stallTimer);
    cancelTimer(progressTimer);
    stableTimer = null;
    stallTimer = null;
    progressTimer = null;
    if (networkAttempts >= NETWORK_DELAYS_MS.length) return terminal(terminalMessage);
    networkAttempts++;
    recovering = true;
    try {
      const lowered = selectLowerRendition();
      onRecovering(lowered ? 'Reducing live quality to stabilize playback…' : message);
      restartNetworkLoad();
      cancelTimer(recoveryWatchdog);
      recoveryWatchdog = setTimer(() => {
        recoveryWatchdog = null;
        terminal(terminalMessage);
      }, RECOVERY_WATCHDOG_MS);
      onRecovered();
      return true;
    } catch (error) {
      return terminal(error?.message || errorMessage);
    }
  }

  function armProgressWatchdog() {
    cancelTimer(progressTimer);
    progressTimer = null;
    if (stopped || !owns() || !activelyPlaying || recovering) return;
    progressTimer = setTimer(() => {
      progressTimer = null;
      if (stopped || !owns() || !activelyPlaying) return;
      const observedTime = Number(getCurrentTime());
      if (Number.isFinite(observedTime)
          && (lastProgressTime == null
            || Math.abs(observedTime - lastProgressTime) >= PROGRESS_EPSILON_SECONDS)) {
        noteProgress(observedTime);
        return;
      }
      recoverStall({
        message: 'Reconnecting frozen live stream…',
        terminalMessage: 'Live stream stopped advancing after recovery.',
        errorMessage: 'HLS frozen-playback recovery failed.',
      });
    }, PROGRESS_WATCHDOG_MS);
  }

  function notePlaying() {
    if (stopped || !owns()) return;
    activelyPlaying = true;
    recovering = false;
    stallEpisode = false;
    cancelTimer(recoveryWatchdog);
    recoveryWatchdog = null;
    cancelTimer(stallTimer);
    stallTimer = null;
    startStableWindow();
    armProgressWatchdog();
  }

  function notePaused() {
    activelyPlaying = false;
    recovering = false;
    cancelTimer(recoveryTimer);
    cancelTimer(recoveryWatchdog);
    cancelTimer(stableTimer);
    cancelTimer(stallTimer);
    cancelTimer(progressTimer);
    recoveryTimer = null;
    recoveryWatchdog = null;
    stableTimer = null;
    stallTimer = null;
    progressTimer = null;
  }

  function noteProgress(currentTime) {
    if (stopped || !owns()) return;
    const time = Number(currentTime);
    if (!Number.isFinite(time)) return;
    if (lastProgressTime == null || Math.abs(time - lastProgressTime) >= PROGRESS_EPSILON_SECONDS) {
      lastProgressTime = time;
      cancelTimer(stallTimer);
      stallTimer = null;
      if (recovering) {
        notePlaying();
      } else if (activelyPlaying) {
        armProgressWatchdog();
        if (stallEpisode) {
          stallEpisode = false;
          startStableWindow();
        }
      }
    }
  }

  function noteStalled() {
    if (stopped || !owns() || recovering || stallTimer != null || recoveryTimer != null) return false;
    // A buffering episode is not stable playback. Cancel the pending reset so
    // intermittent stalls cannot age out merely because 30 wall-clock seconds
    // elapsed since the previous playing event.
    cancelTimer(stableTimer);
    stableTimer = null;
    stallEpisode = true;
    recentStalls++;
    // Short rebuffer/play/rebuffer cycles used to cancel the eight-second
    // watchdog forever. After three distinct stalls without a 30-second
    // stable interval, lower the quality ceiling immediately. A duplicate
    // waiting/stalled event in the same episode is still coalesced by the
    // active timer/recovery state above.
    if (recentStalls >= REPEATED_STALL_LIMIT) {
      recentStalls = 0;
      // Brief waiting/playing cycles are common on public two-second HLS
      // fragments. They may justify a lower rendition, but restarting the
      // loader for each cycle creates holes and eventually pauses an otherwise
      // healthy stream. Only the persistent-stall timer below may reconnect.
      if (selectLowerRendition()) {
        onRecovering('Reducing live quality to stabilize playback…');
      }
    }
    stallTimer = setTimer(() => {
      stallTimer = null;
      recoverStall({
        message: 'Reconnecting stalled live stream…',
        terminalMessage: 'Live stream remained stalled after recovery.',
        errorMessage: 'HLS stall recovery failed.',
      });
    }, STALL_WATCHDOG_MS);
    return true;
  }

  function destroy() {
    stopped = true;
    recovering = false;
    cancelTimer(recoveryTimer);
    cancelTimer(recoveryWatchdog);
    cancelTimer(stableTimer);
    cancelTimer(stallTimer);
    cancelTimer(progressTimer);
    recoveryTimer = null;
    recoveryWatchdog = null;
    stableTimer = null;
    stallTimer = null;
    progressTimer = null;
  }

  return {
    handleFatal,
    notePlaying,
    notePaused,
    noteProgress,
    noteStalled,
    destroy,
    get isRecovering() { return recovering; },
    get attempts() { return { network: networkAttempts, media: mediaAttempts }; },
  };
}
