/**
 * The one place that reads the sound for visuals (the player-bar meter now,
 * a full-screen visualizer later). It reads the engine's visual side tap
 * (audio-engine.js, VISUAL_ANALYSER_SETTINGS) once per frame and hands the
 * same frame object to every subscriber, so no two consumers ever read or
 * advance the analyser on their own.
 *
 * The frame loop runs only while all of these hold:
 *   - at least one subscriber,
 *   - something is playing (source.isPlaying()),
 *   - it can be heard (source.isAudible(): not muted, volume above 0),
 *   - the document is visible.
 * Otherwise nothing is scheduled at all (no requestAnimationFrame, no timer)
 * and the side tap is released, so the audio thread stops feeding it too.
 * While playing with no readable tap (direct-playback fallback, a context that
 * Windows suspended, the moment before the element is attached) the frame is
 * marked inactive and the tap is looked for again every PROBE_MS, without
 * animation frames.
 *
 * Cadence: there is no free-running requestAnimationFrame loop. A timer runs
 * at the fastest rate any subscriber asks for; each tick asks for ONE
 * animation frame, the read and every callback run inside it, and only then
 * is the next timer set. So the page gets at most that many main frames a
 * second from here (not one per display refresh, which would make every other
 * animation and observer on the page tick at 60 Hz too), and the host's own
 * frame throttling (a minimised or occluded window gets about 1 frame a
 * second) still applies, without timers piling up behind it.
 *
 * Frame object (one object, rewritten in place every frame; copy what you
 * need to keep):
 *   time        seconds (the animation-frame clock)
 *   dt          seconds since the previous frame; 0 on the first frame after
 *               a (re)start, never more than MAX_DT
 *   active      true when the arrays hold real data from the playing media
 *   running     false only on the last frame sent when the loop stops
 *   sampleRate  Hz of the audio context (0 until known)
 *   fftSize     analyser FFT size (bins = fftSize / 2)
 *   binHz       sampleRate / fftSize
 *   minDecibels, maxDecibels   the dB span the byte spectrum covers
 *   spectrum    Uint8Array(fftSize / 2): byte frequency data, 0..255 maps
 *               linearly onto minDecibels..maxDecibels; all 0 when inactive
 *   waveform    Uint8Array(fftSize): byte time-domain data, 128 = silence
 *   rms         0..1 linear RMS of the waveform (a full-scale sine is ~0.707)
 *   level       0..1, that RMS in dBFS mapped from -60 dB (0) to 0 dB (1)
 *   bass        0..1 energy-mean level of 30..300 Hz on the spectrum's scale
 *   mid         0..1, 300..4000 Hz
 *   high        0..1, 4000..20000 Hz (capped at Nyquist)
 *   bars(count, out, options)  N log-spaced bars 0..1 into `out` (see
 *               barsFromSpectrum); returns `out`
 *
 * Room left for later, deliberately not built now: a float spectrum
 * (getFloatFrequencyData into a Float32Array kept beside `spectrum`, read only
 * when a subscriber asks for it) and beat detection (kick / snare / hat onsets,
 * tempo, beat phase), which belongs in readFrame() below so every consumer
 * shares one detector.
 *
 * Pure helpers (bin maths, band levels, auto-gain) are exported for tests.
 */

export const SIGNAL_BANDS = Object.freeze({
  bass: Object.freeze([30, 300]),
  mid: Object.freeze([300, 4000]),
  high: Object.freeze([4000, 20000]),
});

export const DEFAULT_FPS = 30;
export const MAX_DT = 0.1; // s; a longer gap (a slow frame, a restart) counts as this
export const PROBE_MS = 250;
const LEVEL_FLOOR_DB = -60;
const DEFAULT_FFT = 2048;
const NO_OPTIONS = Object.freeze({});

/* ---------------- Pure maths ---------------- */

/** Hz per FFT bin. */
export function binWidthHz(sampleRate, fftSize) {
  const rate = Number(sampleRate);
  const size = Number(fftSize);
  return rate > 0 && size > 0 ? rate / size : 0;
}

/** Inclusive bin range [first, last] for frequencies [lowHz, highHz). Bin k
 *  is centred on k * binHz. Bin 0 (DC) is never used; ranges are capped below
 *  Nyquist and always hold at least one bin. */
export function binRange(lowHz, highHz, sampleRate, fftSize) {
  const width = binWidthHz(sampleRate, fftSize);
  const count = Math.floor(Number(fftSize) / 2);
  if (!(width > 0) || count < 2) return [1, 1];
  const top = count - 1;
  let first = Math.round(Number(lowHz) / width);
  let last = Math.round(Number(highHz) / width) - 1;
  first = Math.min(top, Math.max(1, first));
  last = Math.min(top, Math.max(first, last));
  return [first, last];
}

/** Bin ranges for `count` log-spaced bars from minHz to maxHz, as a flat
 *  Int32Array [first0, last0, first1, last1, ...]. Each bar starts after the
 *  previous one ends, so no two bars share a bin (low bars are one bin wide
 *  at small FFT sizes); the last bars are squeezed only if Nyquist is reached. */
export function logBarRanges(count, sampleRate, fftSize, minHz = 40, maxHz = 16000, out = null) {
  const bars = Math.max(1, Math.floor(Number(count) || 1));
  const ranges = out && out.length >= bars * 2 ? out : new Int32Array(bars * 2);
  const width = binWidthHz(sampleRate, fftSize);
  const top = Math.max(1, Math.floor(Number(fftSize) / 2) - 1);
  const low = Math.max(1, Number(minHz) || 40);
  const nyquist = width > 0 ? width * (top + 0.5) : low * 2;
  const high = Math.max(low * 1.01, Math.min(Number(maxHz) || 16000, nyquist));
  const ratio = (high / low) ** (1 / bars);
  let previousLast = 0;
  for (let index = 0; index < bars; index += 1) {
    const from = low * ratio ** index;
    const to = low * ratio ** (index + 1);
    let [first, last] = binRange(from, to, sampleRate, fftSize);
    first = Math.min(top, Math.max(first, previousLast + 1));
    last = Math.min(top, Math.max(last, first));
    ranges[index * 2] = first;
    ranges[index * 2 + 1] = last;
    previousLast = last;
  }
  return ranges;
}

/** Linear power for each byte value of a spectrum spanning minDb..maxDb.
 *  Byte 0 means "at or below the floor" and counts as no energy. */
export function bytePowerTable(minDb, maxDb, out = null) {
  const table = out && out.length === 256 ? out : new Float64Array(256);
  const span = Number(maxDb) - Number(minDb);
  table[0] = 0;
  for (let value = 1; value < 256; value += 1) {
    table[value] = 10 ** ((Number(minDb) + (value / 255) * span) / 10);
  }
  return table;
}

/** Energy-mean level of spectrum[first..last] on the spectrum's own 0..1
 *  scale (0 = minDb or below, 1 = maxDb). `offsetDb` shifts the result (a
 *  tilt); a band with no energy stays exactly 0 whatever the offset. */
export function bandLevel(spectrum, first, last, powerTable, minDb, maxDb, offsetDb = 0) {
  let sum = 0;
  let bins = 0;
  for (let bin = first; bin <= last && bin < spectrum.length; bin += 1) {
    sum += powerTable[spectrum[bin]];
    bins += 1;
  }
  if (!bins || !(sum > 0)) return 0;
  const db = 10 * Math.log10(sum / bins) + offsetDb;
  const value = (db - minDb) / (maxDb - minDb);
  return value <= 0 ? 0 : (value >= 1 ? 1 : value);
}

/** Bars from a byte spectrum into `out` (0..1 each). `tiltDbPerOctave` lifts
 *  bars above `tiltPivotHz` and lowers those below, to offset music's natural
 *  fall-off towards the treble. */
export function barsFromSpectrum(spectrum, ranges, out, {
  powerTable, minDb, maxDb, binHz = 0, tiltDbPerOctave = 0, tiltPivotHz = 1000,
} = {}) {
  const count = Math.min(out.length, Math.floor(ranges.length / 2));
  for (let index = 0; index < count; index += 1) {
    const first = ranges[index * 2];
    const last = ranges[index * 2 + 1];
    let offset = 0;
    if (tiltDbPerOctave && binHz > 0) {
      const centre = ((first + last) / 2) * binHz;
      offset = tiltDbPerOctave * Math.log2(Math.max(1, centre) / tiltPivotHz);
    }
    out[index] = bandLevel(spectrum, first, last, powerTable, minDb, maxDb, offset);
  }
  return out;
}

/** RMS of float samples (-1..1) and a byte copy (Web Audio's own mapping,
 *  128 * (1 + x), clamped) written into `bytes`. */
export function waveformStats(samples, bytes) {
  let sum = 0;
  const length = samples.length;
  for (let index = 0; index < length; index += 1) {
    const sample = samples[index];
    sum += sample * sample;
    const byte = Math.floor(128 * (1 + sample));
    if (bytes) bytes[index] = byte < 0 ? 0 : (byte > 255 ? 255 : byte);
  }
  const rms = length ? Math.sqrt(sum / length) : 0;
  return rms > 1 ? 1 : rms;
}

/** RMS (linear) as 0..1 on a -60..0 dBFS scale. */
export function levelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const value = (20 * Math.log10(rms) - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return value <= 0 ? 0 : (value >= 1 ? 1 : value);
}

/** dt in seconds between two clock readings (ms), clamped to 0..MAX_DT. */
export function frameDt(previousMs, nowMs) {
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) return 0;
  const dt = (nowMs - previousMs) / 1000;
  return dt <= 0 ? 0 : (dt >= MAX_DT ? MAX_DT : dt);
}

/** A 0..1 value on a spectrum scale back to dB (-Infinity for 0: no energy). */
export function valueToDb(value, minDb, maxDb) {
  return value > 0 ? minDb + value * (maxDb - minDb) : Number.NEGATIVE_INFINITY;
}

/** Gentle auto-gain in dB, time based, boost only (never a cut).
 *  `trackedDb` holds each band's recent peak: it jumps up with the signal at
 *  once and sinks by `fallDbPerSecond` (never below `floorDb`, so silence
 *  cannot ask for endless gain). The whole set is lifted so its loudest
 *  tracked band reaches `targetDb` (at most `maxBoostDb`), and each band that
 *  sits below the loudest gets half that difference on top (at most
 *  `bandBoostDb`), so a quiet station and a thin treble both use more of the
 *  range while the spectrum keeps its shape. A band with no energy stays at
 *  -Infinity. Writes into `outDb`. */
export function autoGainDbStep(levelsDb, trackedDb, dt, outDb, {
  targetDb = -19, maxBoostDb = 18, bandBoostDb = 6, fallDbPerSecond = 3, floorDb = -75,
} = {}) {
  const fall = dt > 0 ? fallDbPerSecond * dt : 0;
  let loudest = floorDb;
  for (let index = 0; index < levelsDb.length; index += 1) {
    let peak = trackedDb[index] - fall;
    if (levelsDb[index] > peak) peak = levelsDb[index];
    if (!(peak >= floorDb)) peak = floorDb;
    trackedDb[index] = peak;
    if (peak > loudest) loudest = peak;
  }
  let boost = targetDb - loudest;
  boost = boost < 0 ? 0 : (boost > maxBoostDb ? maxBoostDb : boost);
  for (let index = 0; index < levelsDb.length; index += 1) {
    let band = (loudest - trackedDb[index]) * 0.5;
    band = band < 0 ? 0 : (band > bandBoostDb ? bandBoostDb : band);
    outDb[index] = levelsDb[index] + boost + band;
  }
  return outDb;
}

/* ---------------- The shared loop ---------------- */

/**
 * @param {object} options
 * @param {{ isPlaying(): boolean, isAudible?(): boolean, getAnalyser(): AnalyserNode|null, release?(): void }} options.source
 *        getAnalyser() must return null unless a running graph already has the
 *        current element attached; it must never create or resume a context.
 *        isAudible() false (muted, volume 0) rests the loop like a pause; call
 *        refresh() when it may have changed.
 */
export function createAudioSignal({
  source,
  doc = globalThis.document,
  requestFrame = (fn) => globalThis.requestAnimationFrame(fn),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const subscribers = new Map(); // listener -> { fps }
  const dispatchLists = []; // listener snapshots, one per dispatch nesting depth
  let dispatchDepth = 0;
  const threw = new WeakSet(); // listeners whose error was already logged
  // At most one of these is pending at a time: the tick timer (or the probe
  // timer) waits, then asks for one animation frame, which reads and
  // dispatches, then sets the next timer.
  let frameHandle = 0;
  let timerHandle = 0;
  let probing = false; // timerHandle is the probe, not a tick
  let dueMs = 0; // clock time the current tick was due (the pacing anchor)
  let running = false;
  let generation = 0; // bumped by every start and stop; stale callbacks see a different one
  let lastFrameMs = Number.NaN;
  let interval = 1000 / DEFAULT_FPS;
  let visibilityBound = false;
  let analyser = null;
  let floatWave = new Float32Array(DEFAULT_FFT);
  const powerTable = new Float64Array(256);
  let tableMin = Number.NaN; // the dB span powerTable was built for
  let tableMax = Number.NaN;
  let rangesRate = 0; // the rate / size bandRanges were built for
  let rangesFft = 0;
  const bandRanges = { bass: [1, 1], mid: [1, 1], high: [1, 1] };
  const barCache = []; // { count, minHz, maxHz, rate, fft, ranges }
  let idleAnnounced = false; // the inactive state was already sent once
  const barOptions = {
    powerTable: null, minDb: -100, maxDb: -30, binHz: 0, tiltDbPerOctave: 0, tiltPivotHz: 1000,
  };
  const stats = { frames: 0, reads: 0, starts: 0, stops: 0 };

  function barRanges(count, minHz, maxHz) {
    const rate = frame.sampleRate;
    const fft = frame.fftSize;
    for (const entry of barCache) {
      if (entry.count === count && entry.minHz === minHz && entry.maxHz === maxHz
        && entry.rate === rate && entry.fft === fft) return entry.ranges;
    }
    if (barCache.length >= 8) barCache.length = 0;
    const ranges = logBarRanges(count, rate, fft, minHz, maxHz);
    barCache.push({ count, minHz, maxHz, rate, fft, ranges });
    return ranges;
  }

  const frame = {
    time: 0,
    dt: 0,
    active: false,
    running: false,
    sampleRate: 0,
    fftSize: DEFAULT_FFT,
    binHz: 0,
    minDecibels: -100,
    maxDecibels: -30,
    spectrum: new Uint8Array(DEFAULT_FFT / 2),
    waveform: new Uint8Array(DEFAULT_FFT).fill(128),
    rms: 0,
    level: 0,
    bass: 0,
    mid: 0,
    high: 0,
    /** `count` log-spaced bars (0..1) into `out` (pass a reused
     *  Float32Array; one is made only when none is given). Options:
     *  minHz (40), maxHz (16000), tiltDbPerOctave (0). Pass a constant
     *  options object to keep the frame loop allocation-free. */
    bars(count, out, options = NO_OPTIONS) {
      const target = out || new Float32Array(count);
      if (!frame.active) return target.fill(0);
      const ranges = barRanges(count, options.minHz ?? 40, options.maxHz ?? 16000);
      barOptions.powerTable = powerTable;
      barOptions.minDb = frame.minDecibels;
      barOptions.maxDb = frame.maxDecibels;
      barOptions.binHz = frame.binHz;
      barOptions.tiltDbPerOctave = options.tiltDbPerOctave ?? 0;
      return barsFromSpectrum(frame.spectrum, ranges, target, barOptions);
    },
  };

  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const audible = () => typeof source?.isAudible !== 'function' || source.isAudible() !== false;
  const wanted = () => subscribers.size > 0 && visible() && Boolean(source?.isPlaying?.()) && audible();

  function bindVisibility(on) {
    if (!doc?.addEventListener || visibilityBound === on) return;
    visibilityBound = on;
    if (on) doc.addEventListener('visibilitychange', refresh);
    else doc.removeEventListener('visibilitychange', refresh);
  }

  /** Returns the interval it replaced. */
  function recomputeInterval() {
    const before = interval;
    let fps = 0;
    for (const { fps: wantedFps } of subscribers.values()) fps = Math.max(fps, wantedFps);
    interval = 1000 / (fps || DEFAULT_FPS);
    return before;
  }

  /** Hand the frame to every subscriber, from a snapshot of the listeners
   *  (one reused array per nesting depth, so no allocation per frame).
   *  - A listener removed during the pass is skipped; one added waits for the
   *    next frame.
   *  - If a callback stops or restarts the loop (pauses, unsubscribes the
   *    last other listener), the stop has already sent everyone the resting
   *    frame through a nested dispatch, and the shared frame object now holds
   *    it; this pass ends there, so nobody gets the old frame after it, nor
   *    the resting frame twice.
   *  - A listener that throws is logged once and skipped this frame; the
   *    others and the loop carry on. */
  function dispatch() {
    stats.frames += 1;
    const loop = generation;
    const depth = dispatchDepth;
    const list = dispatchLists[depth] || (dispatchLists[depth] = []);
    let count = 0;
    for (const listener of subscribers.keys()) list[count++] = listener;
    dispatchDepth += 1;
    try {
      for (let index = 0; index < count; index += 1) {
        const listener = list[index];
        list[index] = null;
        if (loop !== generation) continue; // clears the rest of the snapshot
        if (!subscribers.has(listener)) continue;
        try {
          listener(frame);
        } catch (error) {
          if (!threw.has(listener)) {
            threw.add(listener);
            console.error('audio signal listener threw:', error);
          }
        }
      }
    } finally {
      dispatchDepth -= 1;
    }
  }

  function clearFrame() {
    frame.active = false;
    frame.spectrum.fill(0);
    frame.waveform.fill(128);
    frame.rms = 0;
    frame.level = 0;
    frame.bass = 0;
    frame.mid = 0;
    frame.high = 0;
  }

  function cancelScheduled() {
    if (frameHandle) cancelFrame(frameHandle);
    if (timerHandle) clearTimer(timerHandle);
    frameHandle = 0;
    timerHandle = 0;
    probing = false;
  }

  function releaseTap() {
    analyser = null;
    try { source?.release?.(); } catch (_) {}
  }

  function prepareFor(node) {
    const fftSize = Number(node.fftSize) || DEFAULT_FFT;
    if (frame.fftSize !== fftSize || frame.spectrum.length !== fftSize / 2) {
      // Only when the analyser's size changes, never per frame.
      frame.fftSize = fftSize;
      frame.spectrum = new Uint8Array(fftSize / 2);
      frame.waveform = new Uint8Array(fftSize).fill(128);
      floatWave = new Float32Array(fftSize);
    }
    const minDb = Number(node.minDecibels);
    const maxDb = Number(node.maxDecibels);
    frame.minDecibels = Number.isFinite(minDb) ? minDb : -100;
    frame.maxDecibels = Number.isFinite(maxDb) && maxDb > frame.minDecibels ? maxDb : frame.minDecibels + 70;
    if (frame.minDecibels !== tableMin || frame.maxDecibels !== tableMax) {
      bytePowerTable(frame.minDecibels, frame.maxDecibels, powerTable);
      tableMin = frame.minDecibels;
      tableMax = frame.maxDecibels;
    }
    const rate = Number(node.context?.sampleRate) || frame.sampleRate || 48000;
    frame.sampleRate = rate;
    frame.binHz = binWidthHz(rate, fftSize);
    if (rate !== rangesRate || fftSize !== rangesFft) {
      for (const [name, [low, high]] of Object.entries(SIGNAL_BANDS)) {
        bandRanges[name] = binRange(low, high, rate, fftSize);
      }
      rangesRate = rate;
      rangesFft = fftSize;
    }
  }

  /** One read of the analyser into the shared frame. Beat detection, when it
   *  comes, goes here so every consumer shares it. */
  function readFrame(node) {
    stats.reads += 1;
    prepareFor(node);
    node.getByteFrequencyData(frame.spectrum);
    node.getFloatTimeDomainData(floatWave);
    frame.rms = waveformStats(floatWave, frame.waveform);
    frame.level = levelFromRms(frame.rms);
    frame.bass = rangeLevel(bandRanges.bass);
    frame.mid = rangeLevel(bandRanges.mid);
    frame.high = rangeLevel(bandRanges.high);
    frame.active = true;
  }

  function rangeLevel(range) {
    return bandLevel(frame.spectrum, range[0], range[1], powerTable, frame.minDecibels, frame.maxDecibels);
  }

  /** The pacing timer: one tick asks for exactly one animation frame, and
   *  never while one is still pending (a minimised or occluded window, where
   *  the host throttles frames to about 1/s, cannot pile up requests). */
  function onTick() {
    timerHandle = 0;
    if (!running) return;
    if (!wanted()) { stop(); return; }
    if (frameHandle) return;
    frameHandle = requestFrame(onFrame);
  }

  /** After a frame: the next tick is due one interval after this one was.
   *  A tick that fell more than an interval behind (frames throttled, a long
   *  task) starts a fresh schedule instead of firing a burst to catch up. */
  function scheduleTick() {
    const now = clock();
    dueMs += interval;
    if (!(dueMs >= now - interval)) dueMs = now;
    const delay = dueMs - now;
    timerHandle = setTimer(onTick, delay > 0 ? delay : 0);
  }

  /** Read and dispatch inside an animation frame (asked for by onTick, start
   *  or probe), then set the timer for the next tick. Never re-requests a
   *  frame itself, so the page gets at most `fps` main frames a second from
   *  here instead of one per display refresh. */
  function onFrame(timestamp) {
    frameHandle = 0;
    if (!running) return;
    if (!wanted()) { stop(); return; }
    const loop = generation;
    const now = Number.isFinite(timestamp) ? timestamp : clock();
    let node = null;
    try { node = source.getAnalyser(); } catch (_) { node = null; }
    if (!node) {
      // No readable tap (context suspended, element detached, engine not
      // ready): let go of the tap so the graph stops feeding it, say so once,
      // then look again without animating. probe() takes it again through the
      // normal path.
      releaseTap();
      clearFrame();
      frame.dt = 0;
      frame.time = now / 1000;
      frame.running = true;
      lastFrameMs = Number.NaN;
      if (!idleAnnounced) {
        idleAnnounced = true;
        dispatch();
        // A listener may have stopped (or stopped and restarted) the loop.
        if (!running || loop !== generation) return;
      }
      probing = true;
      timerHandle = setTimer(probe, PROBE_MS);
      return;
    }
    analyser = node;
    idleAnnounced = false;
    frame.dt = frameDt(lastFrameMs, now);
    frame.time = now / 1000;
    frame.running = true;
    lastFrameMs = now;
    try {
      readFrame(node);
    } catch (_) {
      clearFrame();
    }
    dispatch();
    // A listener may have stopped (or stopped and restarted) the loop, or a
    // subscriber change may already have scheduled the next tick.
    if (!running || loop !== generation || timerHandle || frameHandle) return;
    scheduleTick();
  }

  /** No readable tap: look again every PROBE_MS on a plain timer, without
   *  animation frames; once there is one, go back to frames at once. */
  function probe() {
    timerHandle = 0;
    probing = false;
    if (!running) return;
    if (!wanted()) { stop(); return; }
    let node = null;
    try { node = source.getAnalyser(); } catch (_) { node = null; }
    if (node) {
      lastFrameMs = Number.NaN;
      dueMs = clock();
      if (!frameHandle) frameHandle = requestFrame(onFrame);
    } else {
      probing = true;
      timerHandle = setTimer(probe, PROBE_MS);
    }
  }

  function start() {
    if (running) return;
    // Never two loops: anything still scheduled from before is dropped.
    cancelScheduled();
    generation += 1;
    running = true;
    stats.starts += 1;
    idleAnnounced = false;
    lastFrameMs = Number.NaN;
    // The first frame comes at once; ticks follow at the subscribers' rate.
    dueMs = clock();
    frameHandle = requestFrame(onFrame);
  }

  /** A subscriber asked for a different rate: a tick already waiting on the
   *  old interval is moved to the new one (never a second timer). */
  function retime(before) {
    if (interval === before || !running || !timerHandle || probing) return;
    clearTimer(timerHandle);
    timerHandle = 0;
    dueMs += interval - before;
    const delay = dueMs - clock();
    timerHandle = setTimer(onTick, delay > 0 ? delay : 0);
  }

  function stop() {
    cancelScheduled();
    if (!running) return;
    running = false;
    generation += 1;
    stats.stops += 1;
    releaseTap();
    lastFrameMs = Number.NaN;
    // One last frame so consumers can show their resting state.
    clearFrame();
    frame.dt = 0;
    frame.running = false;
    if (subscribers.size) dispatch();
  }

  /** Re-check whether the loop should run (playing state or visibility changed). */
  function refresh() {
    if (wanted()) start();
    else stop();
  }

  /** Receive every frame while the loop runs. `fps` caps how often (the loop
   *  runs at the highest rate any subscriber asks for). Returns unsubscribe. */
  function subscribe(listener, { fps = DEFAULT_FPS } = {}) {
    if (typeof listener !== 'function') return () => {};
    const rate = Math.max(1, Math.min(240, Number(fps) || DEFAULT_FPS));
    subscribers.set(listener, { fps: rate });
    retime(recomputeInterval());
    bindVisibility(true);
    refresh();
    return () => {
      if (!subscribers.delete(listener)) return;
      retime(recomputeInterval());
      if (!subscribers.size) {
        bindVisibility(false);
        stop();
      } else {
        refresh();
      }
    };
  }

  return {
    subscribe,
    refresh,
    get running() { return running; },
    get scheduled() { return Boolean(frameHandle || timerHandle); },
    get subscriberCount() { return subscribers.size; },
    get hasAnalyser() { return Boolean(analyser); },
    get frame() { return frame; },
    stats,
  };
}
