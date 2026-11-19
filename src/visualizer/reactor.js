/**
 * Psychedelia's Beat Reactor (engine/audio-reactor.js, used unchanged) fed
 * from the app's shared sound signal (lib/audio-signal.js).
 *
 * The reactor asks a global `AudioAnalysis.getAnalysis({ time })` for one
 * reading per frame. createAudioAdapter() answers that from the signal frame
 * the Visualizer loop was handed (subscribed with floatSpectrum: true), so
 * there is no second analyser and no read beyond the signal's one shared
 * read per tick. No frame (paused, stopped, muted, idle, still): an inactive
 * reading, so the reactor gets silence (its bands fade, its beat clock runs
 * on at 120 BPM).
 *
 * Differences between the two analysers, and how they are bridged:
 *   - Psychedelia's analyser spans -100..-30 dB; the app's tap -85..-15 dB.
 *     The reactor's detector thresholds were tuned on its "unclipped" scale,
 *     where 1 = -30 dB absolute, computed from the float dB spectrum. The
 *     adapter always hands it a float dB spectrum (the signal's
 *     getFloatFrequencyData read; if that is ever missing, one converted from
 *     the byte spectrum with the tap's own -85..-15 span), and reports
 *     Psychedelia's -100 / -30, so that path sees exactly the scale it was
 *     tuned on (bins below -100 dB count as nothing, as there).
 *   - FFT size 2048 here, 1024 there: the reactor picks bins by Hz, so its
 *     bands are the same frequencies.
 *   - audio-reactor.js reads AudioSignal.bands while it loads: Psychedelia's
 *     audio-signal.js is loaded first and passed in.
 *   - signalVersion is the signal's `version` (a new item or element), so the
 *     reactor starts its tempo afresh on a new station, not on a pause.
 *
 * Every value that reaches a scene passes the flash limiter (flash-limiter.js)
 * first: u_audio, u_beat (with the beat clock), the parameter links (our
 * own table per scene in scenes.js, moving size, shape or colour; else
 * Psychedelia's conservative suggestions), the time surge and the zoom
 * punch.
 */

import loadAudioSignal from './vendor/psychedelia/engine/audio-signal.js';
import loadAudioReactor from './vendor/psychedelia/engine/audio-reactor.js';
import { createFlashLimiter } from './flash-limiter.js';

/** What Psychedelia's own analyser reports (audio-analysis.js). */
export const PSYCHEDELIA_DB = Object.freeze({ min: -100, max: -30 });
/** The reactor's clock pace with no tempo (its fallback without Studio Music). */
export const IDLE_BPM = 120;
/** Link sources the limiter gives values for. */
const LINK_SOURCES = new Set(['kick', 'snare', 'hat', 'beat', 'bass', 'mid', 'high', 'level']);

const EMPTY_SPECTRUM = new Uint8Array(0);

/** A float dB spectrum from a byte spectrum spanning minDb..maxDb (byte 0:
 *  -Infinity, nothing there). */
export function bytesToDb(bytes, minDb, maxDb, out) {
  const span = maxDb - minDb;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    out[index] = value > 0 ? minDb + (value / 255) * span : Number.NEGATIVE_INFINITY;
  }
  return out;
}

/** The most the adapter makes up for a turned-down volume, in dB: 40 dB is
 *  volume 0.01. Lower volumes get the same 40 dB, so near-silence (mostly
 *  noise and rounding) is not blown up into beats. */
export const MAX_VOLUME_GAIN_DB = 40;

/** dB to add back for the element's volume `volume` (0..1): -20 log10(volume),
 *  capped at MAX_VOLUME_GAIN_DB; 0 at full volume or when unknown. */
export function volumeGainDb(volume) {
  const value = Number(volume);
  if (!(value > 0) || value >= 1) return 0;
  const gain = -20 * Math.log10(value);
  return gain > MAX_VOLUME_GAIN_DB ? MAX_VOLUME_GAIN_DB : gain;
}

/** Psychedelia's AudioAnalysis, answered from the app's signal frames.
 *
 *  The app's analyser tap is after the media element's volume, and
 *  Psychedelia's reactor has fixed floors (its loudness gate and onset
 *  floors work on absolute levels), so at a low volume it hears too little
 *  and misses beats. Each frame is therefore brought back to full volume
 *  here: the float spectrum gets volumeGainDb(frame.volume) added and the
 *  waveform is scaled by the same factor (from the float samples, so no
 *  resolution is lost). Into the adapter's own arrays: the frame itself is
 *  shared (the player-bar meter reads it) and never changed. */
export function createAudioAdapter() {
  let frame = null;
  let converted = null;
  let boostedDb = null;
  let boostedWave = null;
  const analysis = {
    available: true,
    active: false,
    source: 'player',
    fft: EMPTY_SPECTRUM,
    spectrum: EMPTY_SPECTRUM,
    byteData: true,
    waveform: EMPTY_SPECTRUM,
    sampleRate: 0,
    fftSize: 0,
    fftScale: 'normalized-db',
    fftMinDecibels: PSYCHEDELIA_DB.min,
    fftMaxDecibels: PSYCHEDELIA_DB.max,
    spectrumDb: null,
    signalVersion: 0,
    time: 0,
  };
  const stats = { readings: 0, converted: 0, boosted: 0 };

  /** The frame's float spectrum (or its byte spectrum as dB). */
  function spectrumDbOf(source) {
    const db = source.spectrumDb;
    if (db && db.length === source.spectrum.length) return db;
    if (!converted || converted.length !== source.spectrum.length) converted = new Float32Array(source.spectrum.length);
    stats.converted += 1;
    return bytesToDb(source.spectrum, source.minDecibels, source.maxDecibels, converted);
  }

  /** `db` raised by `gainDb`, into the adapter's own array. */
  function boostSpectrum(db, gainDb) {
    if (!boostedDb || boostedDb.length !== db.length) boostedDb = new Float32Array(db.length);
    for (let index = 0; index < db.length; index += 1) boostedDb[index] = db[index] + gainDb;
    return boostedDb;
  }

  /** The byte waveform scaled by `factor` (as getByteTimeDomainData would
   *  give it at full volume), from the float samples when the frame has them. */
  function boostWaveform(source, factor) {
    const bytes = source.waveform;
    if (!boostedWave || boostedWave.length !== bytes.length) boostedWave = new Uint8Array(bytes.length);
    const samples = source.waveformFloat;
    const fromFloat = samples && samples.length === bytes.length;
    for (let index = 0; index < bytes.length; index += 1) {
      const value = fromFloat
        ? Math.floor(128 * (1 + samples[index] * factor))
        : Math.round(128 + (bytes[index] - 128) * factor);
      boostedWave[index] = value < 0 ? 0 : (value > 255 ? 255 : value);
    }
    return boostedWave;
  }
  return {
    /** The signal frame for this draw, or null (nothing to hear). */
    setFrame(next) { frame = next && next.active === true ? next : null; },
    /** dB being added back for the volume on the current frame. */
    get gainDb() { return frame ? volumeGainDb(frame.volume) : 0; },
    getAnalysis(options) {
      stats.readings += 1;
      const time = Number(options?.time);
      if (!frame) {
        analysis.active = false;
        analysis.time = Number.isFinite(time) ? time : analysis.time;
        return analysis;
      }
      analysis.active = true;
      analysis.fft = frame.spectrum;
      analysis.spectrum = frame.spectrum;
      analysis.sampleRate = frame.sampleRate;
      analysis.fftSize = frame.fftSize;
      analysis.signalVersion = frame.version;
      analysis.time = Number.isFinite(time) ? time : frame.time;
      const db = spectrumDbOf(frame);
      const gainDb = volumeGainDb(frame.volume);
      if (gainDb > 0) {
        stats.boosted += 1;
        analysis.spectrumDb = boostSpectrum(db, gainDb);
        analysis.waveform = boostWaveform(frame, 10 ** (gainDb / 20));
      } else {
        analysis.spectrumDb = db;
        analysis.waveform = frame.waveform;
      }
      return analysis;
    },
    get analysis() { return analysis; },
    /** What the make-up did on the current frame, for checking it in the real
     *  window (nothing is computed for it: the signal already measured the
     *  rms): the element volume, the dB added back, the sound's level as the
     *  tap heard it and after the make-up (dBFS of the rms), and whether the
     *  spectrum came as floats (exact) or from bytes (floored at the
     *  analyser's minDecibels before the make-up). At two volumes, madeUpDb
     *  should match within about 1 dB on the same music; if it does not, the
     *  tap is not hearing the volume the element reports. */
    get makeUp() {
      if (!frame) return null;
      const gainDb = volumeGainDb(frame.volume);
      const heardDb = frame.rms > 0 ? 20 * Math.log10(frame.rms) : Number.NEGATIVE_INFINITY;
      const db = frame.spectrumDb;
      return {
        volume: frame.volume,
        gainDb,
        heardDb,
        madeUpDb: heardDb + gainDb,
        spectrum: db && db.length === frame.spectrum.length ? 'float' : 'byte',
      };
    },
    stats,
  };
}

/** A scene's linked parameter values: `base` with each link pushing its
 *  param by amount x source x range (clamped to the range), into `out`. */
export function applyLinks(base, links, sources, out) {
  for (const key in base) out[key] = base[key];
  if (!sources) return out;
  for (const link of links) {
    const value = sources[link.source];
    if (!(value > 0)) continue;
    const pushed = base[link.param] + link.amount * value * link.span;
    out[link.param] = pushed < link.min ? link.min : (pushed > link.max ? link.max : pushed);
  }
  return out;
}

/** Links for a scene, kept only where the param is a plain float (or, from
 *  our own scene table, an 'int' the shader uses as a continuous number:
 *  `allowInt`) and the source is one the limiter covers. */
export function usableLinks(def, suggested, { allowInt = false } = {}) {
  const params = new Map((def?.params || []).map((param) => [param.name, param]));
  const links = [];
  for (const row of suggested || []) {
    const param = params.get(row?.param);
    if (!param || (param.type && param.type !== 'float' && !(allowInt && param.type === 'int'))) continue;
    if (!LINK_SOURCES.has(row.source) || !Number.isFinite(row.amount) || !row.amount) continue;
    const min = Number(param.min);
    const max = Number(param.max);
    if (!(max > min)) continue;
    links.push({ param: param.name, source: row.source, amount: row.amount, min, max, span: max - min });
  }
  return links;
}

/* ---------------- The link rule ---------------- */

/** Params whose change is a change of light: never linked (a pulse on them
 *  is a flash). */
export const LIGHT_PARAM = /(glow|bright|exposure|intensity|light|flash|gain|gamma|contrast|core|shine|sparkle|strobe|opacity|alpha|fade|vignette|bloom|haze|fog|caustic|shimmer|luminance|emission|white|black)/;
/** Params that are rates (a speed of something): changing one jumps through
 *  the scene's time instead of changing its pace, also where the shader
 *  multiplies it by the clock in a way the clock rule cannot see. */
export const RATE_PARAM = /(speed|rate|spin|drift|rotation|scroll|time|tempo|phase|evolution|morph|animate)/;
/** Params that move the view far or change the picture in steps: a fractal
 *  dive's loop depth (the dive position is the clock modulo the depth, so a
 *  change jumps along the dive), its target or centre (at depth a tiny move
 *  is a different picture), iteration and detail counts. */
export const JUMP_PARAM = /(^|_)(depth|target|center|centre|iter|iterations|warmup|detail|steps|octaves|seed)(_|$)/;

/** u_time and the shader's own clock variables (Psychedelia's clockNames,
 *  engine/audio-reactor.js). */
function clockNames(shader) {
  const names = ['u_time', 'u_unwrapped_time'];
  const re = /\bfloat\s+([A-Za-z_]\w*)\s*=\s*\(?\s*u_(?:unwrapped_)?time\b/g;
  let match;
  while ((match = re.exec(shader))) if (!names.includes(match[1])) names.push(match[1]);
  return names.join('|');
}

/** Psychedelia's paramLinkable rule: a param the shader multiplies by a clock
 *  is not linkable. */
export function clockScaled(shader, name) {
  const text = typeof shader === 'string' ? shader : '';
  const clocks = clockNames(text);
  const uniform = `u_${name}`;
  return new RegExp(`\\b(?:${clocks})\\s*[*/]\\s*\\(?\\s*${uniform}\\b|\\b${uniform}\\s*\\*\\s*\\(?\\s*(?:${clocks})\\b`).test(text);
}

/** Why `param` may not carry a link in `def` (null: it may). The one rule
 *  every link, ours or automatic, has to pass. */
export function linkRuleViolation(def, param) {
  if (!param?.name) return 'no such param';
  if (param.type && param.type !== 'float' && param.type !== 'int') return 'not a number';
  if (!(Number(param.max) > Number(param.min))) return 'no range';
  if ((def?.specialize || []).includes(param.name)) return 'compiled in';
  if (param.audioLink === false) return 'Psychedelia marks it not linkable';
  if (LIGHT_PARAM.test(param.name)) return 'changes light';
  if (RATE_PARAM.test(param.name)) return 'a rate';
  if (JUMP_PARAM.test(param.name)) return 'moves the view far or in steps';
  if (clockScaled(def?.shader, param.name)) return 'multiplied by the clock';
  return null;
}

/** The links a scene gets: only its own table (scenes.js `links`), and of
 *  that only rows that pass the link rule. Psychedelia's automatic
 *  suggestions are not used: without its post-process pass they mostly
 *  nudge glow or brightness, which the rule forbids. */
export function sceneLinks(def, entry) {
  if (!def || !Array.isArray(entry?.links)) return [];
  const params = new Map((def.params || []).map((param) => [param.name, param]));
  const allowed = entry.links.filter((row) => !linkRuleViolation(def, params.get(row?.param)));
  return usableLinks(def, allowed, { allowInt: true });
}

/**
 * @param {object} options
 * @param {object} [options.EffectRegistry]  the scene engine's registry (for
 *        the reactor's per-scene link suggestions)
 * @param {object} [options.ledger]  the flash budget's window to share
 *        (flash-limiter.js createFlashLedger; none: its own)
 */
export function createReactorBridge({ EffectRegistry = null, ledger = null, limiter = createFlashLimiter({ ledger }) } = {}) {
  const adapter = createAudioAdapter();
  const { AudioSignal } = loadAudioSignal({});
  const { AudioReactor } = loadAudioReactor({ AudioSignal, AudioAnalysis: adapter, EffectRegistry });
  const raw = {
    kick: 0, snare: 0, hat: 0, beat: 0, flash: 0, bass: 0, mid: 0, high: 0, level: 0, speed: 1,
  };
  const stats = { steps: 0, silent: 0 };
  // The mood's reaction strength (mood.js): the hits and the time surge are
  // scaled by it before the limiter, which caps them whatever it is.
  let strength = 1;

  /** One frame: the loop's `react` hook. Fills state.audio, state.beat,
   *  state.speed (the reactor's time surge, slew-limited) and state.sources
   *  (the limited values links read) and state.zoom (the zoom punch); all of
   *  it through the limiter. `frame` is the signal frame, or null for
   *  silence. */
  function react(state, frame, nowSec, dt) {
    adapter.setFrame(frame);
    if (!frame) stats.silent += 1;
    stats.steps += 1;
    AudioReactor.update(nowSec, dt);
    raw.kick = AudioReactor.getSource('kick');
    raw.snare = AudioReactor.getSource('snare');
    raw.hat = AudioReactor.getSource('hat');
    raw.beat = AudioReactor.getSource('beat');
    // Psychedelia's own global flash is not shown: the one global flash there
    // is (fx-reactions.js, off by default) is made from the hits the limiter
    // lets through, so it shares their budget instead of adding to it.
    raw.flash = 0;
    raw.bass = AudioReactor.getSource('bass');
    raw.mid = AudioReactor.getSource('mid');
    raw.high = AudioReactor.getSource('high');
    raw.level = AudioReactor.getSource('level');
    raw.speed = AudioReactor.getSpeed();
    if (strength !== 1) {
      raw.kick *= strength;
      raw.snare *= strength;
      raw.hat *= strength;
      raw.beat *= strength;
      raw.speed = 1 + (raw.speed - 1) * strength;
    }
    const out = limiter.step(nowSec, raw);
    state.audio.bass = out.bass;
    state.audio.mid = out.mid;
    state.audio.high = out.high;
    state.audio.level = out.level;
    state.beat.kick = out.kick;
    state.beat.snare = out.snare;
    state.beat.hat = out.hat;
    const st = AudioReactor.getState();
    state.beat.clock = limiter.beatClock(AudioReactor.getBeatClock(), AudioReactor.isLive() && st.bpm > 0 ? st.bpm : IDLE_BPM);
    state.speed = out.speed;
    state.zoom = out.zoom;
    state.sources = out;
  }

  /** Beat-clock cycles a second the scene gets now. */
  function clockRate() {
    const st = AudioReactor.getState();
    const bpm = AudioReactor.isLive() && st.bpm > 0 ? st.bpm : IDLE_BPM;
    return (bpm / 60) * limiter.clockFactor;
  }

  const music = {
    live: false, beats: 0, bpm: 0, confidence: 0,
  };

  return {
    react,
    adapter,
    limiter,
    reactor: AudioReactor,
    raw,
    stats,
    /** The scene being drawn shows the beat clock as a pulse (its shader
     *  wraps u_beat.w): the limiter reserves part of its budget for it. */
    setClockShown(shown) { limiter.setClockShown(shown); },
    /** A trigger effect is on: the same share is kept free for its firings. */
    setTriggersOn(on) { limiter.setTriggersOn(on); },
    /** A trigger effect fires now: true when the flash budget has room (and
     *  it is charged); false: it must not fire (flash-limiter.js charge). */
    charge() { return limiter.charge(); },
    /** The scene's cap on the time surge (scenes.js maxSpeed; none: the limiter's). */
    setSpeedCap(cap) { limiter.setSpeedCap(cap); },
    /** The links for a registered scene: the rows of its scenes.js entry
     *  (or of a bare table) that pass the link rule; none without one. */
    linksFor(def, entry = null) {
      if (!def?.name) return [];
      return sceneLinks(def, Array.isArray(entry) ? { links: entry } : entry);
    },
    clockRate,
    /** The reaction strength (mood.js MOOD_STRENGTH; 1 = as the reactor gives it). */
    setStrength(value) { strength = Number.isFinite(value) && value > 0 ? value : 1; },
    get strength() { return strength; },
    /** What the shuffle and the mood read each frame: the reactor's beat
     *  clock (beats, counting up), tempo and how sure it is of it. One
     *  object, filled in again on each call (nothing allocated per frame). */
    music() {
      const st = AudioReactor.getState();
      music.live = AudioReactor.isLive();
      music.beats = AudioReactor.getBeatClock();
      music.bpm = st.bpm || 0;
      music.confidence = st.tempoConfidence || 0;
      return music;
    },
    /** What the developer strip shows. */
    snapshot() {
      const st = AudioReactor.getState();
      return {
        active: st.active === true,
        bass: limiter.out.bass,
        mid: limiter.out.mid,
        treble: limiter.out.high,
        kick: limiter.out.kick,
        snare: limiter.out.snare,
        hat: limiter.out.hat,
        // The tempo the reactor detected, not the pace scenes are given:
        bpm: st.bpm || 0,
        confidence: st.tempoConfidence || 0,
        // the beat clock the scene gets (after the limiter), cycles a second.
        clock: clockRate(),
        zoom: limiter.out.zoom,
        held: limiter.stats.held,
      };
    },
  };
}
