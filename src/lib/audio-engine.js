/**
 * One reusable Web Audio equalizer for the app's audio and video elements.
 * MediaElementSource nodes are permanent by platform contract, so this module
 * owns their complete lifetime and never creates a second node for an element.
 */

import {
  EQ_MAX_DB, EQ_MIN_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB, normalizeEqCurve,
} from './eq-store.js';

export const EQ_FREQUENCIES = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
export const EQ_FILTER_TYPES = Object.freeze([
  'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking',
  'peaking', 'peaking', 'peaking', 'peaking', 'highshelf',
]);
export const EQ_FILTER_Q = Math.SQRT2;
export const EQ_SMOOTHING_SECONDS = 0.015;
export const EQ_SIGNAL_RMS_FLOOR = 1e-5;

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(minimum, Math.min(maximum, number));
}

export function dbToGain(db) { return 10 ** (Number(db) / 20); }

function setImmediate(param, value, now = 0) {
  if (!param) return;
  if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
  if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, now);
  else param.value = value;
}

function setSmooth(param, value, now = 0) {
  if (!param) return;
  if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, now, EQ_SMOOTHING_SECONDS);
  } else {
    param.value = value;
  }
}

function defaultContextFactory() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) {
    const error = new Error('Web Audio is unavailable in this Windows WebView.');
    error.code = 'AUDIO_CONTEXT_UNAVAILABLE';
    throw error;
  }
  return new Context({ latencyHint: 'interactive' });
}

function configureParam(param, value, now) {
  if (param) setImmediate(param, value, now);
}

export class AudioEngine {
  constructor({ contextFactory = defaultContextFactory, onStatus = null } = {}) {
    this.contextFactory = contextFactory;
    this.onStatus = typeof onStatus === 'function' ? onStatus : null;
    this.context = null;
    this.graph = null;
    this.sourceNodes = new Map();
    this.curve = normalizeEqCurve(null);
    this.bypassed = this.curve.bypassed;
    this.state = 'idle';
    this.error = null;
    this.fatal = false;
    this.externalReason = '';
    this._report();
  }

  getStatus() {
    const external = Boolean(this.externalReason);
    return {
      state: external ? 'unavailable' : this.state,
      reason: external ? this.externalReason : (this.error?.message || ''),
      bypassed: this.bypassed,
      sourceCount: this.sourceNodes.size,
      contextState: this.context?.state || 'none',
      curve: { ...this.curve, bands: [...this.curve.bands] },
    };
  }

  _report() {
    const status = this.getStatus();
    try { this.onStatus?.(status); } catch (_) {}
    return status;
  }

  setExternalUnavailable(reason) {
    this.externalReason = String(reason || 'Equalizer processing is unavailable.');
    return this._report();
  }

  clearExternalUnavailable() {
    if (!this.externalReason) return this.getStatus();
    this.externalReason = '';
    return this._report();
  }

  isAttached(element) { return this.sourceNodes.has(element); }

  _ensureGraph() {
    if (this.graph) return true;
    if (this.fatal) return false;
    try {
      const context = this.contextFactory();
      if (!context) throw new Error('Web Audio context creation returned no context.');
      this.context = context;
      const now = context.currentTime || 0;
      const input = context.createGain();
      const dry = context.createGain();
      const preamp = context.createGain();
      const bands = EQ_FREQUENCIES.map((frequency, index) => {
        const filter = context.createBiquadFilter();
        filter.type = EQ_FILTER_TYPES[index];
        configureParam(filter.frequency, frequency, now);
        configureParam(filter.Q, EQ_FILTER_TYPES[index] === 'peaking' ? EQ_FILTER_Q : 1, now);
        configureParam(filter.gain, 0, now);
        return filter;
      });
      const compressor = context.createDynamicsCompressor();
      configureParam(compressor.threshold, -3, now);
      configureParam(compressor.knee, 0, now);
      configureParam(compressor.ratio, 20, now);
      configureParam(compressor.attack, 0.003, now);
      configureParam(compressor.release, 0.25, now);
      const wet = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.1;

      input.connect(dry);
      input.connect(preamp);
      let previous = preamp;
      for (const filter of bands) {
        previous.connect(filter);
        previous = filter;
      }
      previous.connect(compressor);
      compressor.connect(wet);
      dry.connect(analyser);
      wet.connect(analyser);
      analyser.connect(context.destination);

      this.graph = { input, dry, preamp, bands, compressor, wet, analyser };
      this.state = context.state === 'running' ? 'ready' : 'suspended';
      this.error = null;
      this._applyParameters(true);
      this._report();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = error?.code === 'AUDIO_CONTEXT_UNAVAILABLE' ? 'unavailable' : 'error';
      this.fatal = true;
      this._report();
      return false;
    }
  }

  async resume({ create = false } = {}) {
    if (!this.context && create && !this._ensureGraph()) return false;
    if (!this.context) return true;
    if (this.context.state === 'closed') {
      this.error = new Error('The Web Audio context is closed. Restart World Media to use EQ.');
      this.state = 'error';
      this.fatal = true;
      this._report();
      return false;
    }
    try {
      if (this.context.state !== 'running' && typeof this.context.resume === 'function') {
        await this.context.resume();
      }
      if (this.context.state !== 'running') {
        throw new Error('Windows did not allow the equalizer audio context to resume.');
      }
      this.state = 'ready';
      this.error = null;
      this._report();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = 'suspended';
      this._report();
      return false;
    }
  }

  applyCurve(value, { immediate = false } = {}) {
    this.curve = normalizeEqCurve(value);
    this.bypassed = this.curve.bypassed;
    if (this.graph) this._applyParameters(immediate);
    this._report();
    return this.getStatus();
  }

  setBypassed(value, { immediate = false } = {}) {
    this.bypassed = Boolean(value);
    this.curve = { ...this.curve, bypassed: this.bypassed };
    if (this.graph) this._applyParameters(immediate);
    this._report();
    return this.getStatus();
  }

  _applyParameters(immediate = false) {
    if (!this.graph || !this.context) return;
    const setter = immediate ? setImmediate : setSmooth;
    const now = this.context.currentTime || 0;
    const preampDb = clamp(this.curve.preamp, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB);
    setter(this.graph.preamp.gain, dbToGain(preampDb), now);
    this.graph.bands.forEach((filter, index) => {
      setter(filter.gain, clamp(this.curve.bands[index], EQ_MIN_DB, EQ_MAX_DB), now);
    });
    setter(this.graph.dry.gain, this.bypassed ? 1 : 0, now);
    setter(this.graph.wet.gain, this.bypassed ? 0 : 1, now);
  }

  async attachElement(element, { curve = this.curve } = {}) {
    if (!element) return { processed: false, attached: false, reason: 'No media element was provided.' };
    this.clearExternalUnavailable();
    this.applyCurve(curve, { immediate: !this.graph });
    if (!this._ensureGraph()) {
      return { processed: false, attached: false, reason: this.getStatus().reason };
    }
    if (!await this.resume()) {
      return { processed: false, attached: false, reason: this.getStatus().reason };
    }
    if (this.sourceNodes.has(element)) {
      this.error = null;
      this.state = 'ready';
      this._report();
      return { processed: true, attached: true, sourceCreated: false };
    }
    let source = null;
    try {
      source = this.context.createMediaElementSource(element);
      source.connect(this.graph.input);
      this.sourceNodes.set(element, source);
      this.error = null;
      this.state = 'ready';
      this._report();
      return { processed: true, attached: true, sourceCreated: true };
    } catch (error) {
      // If node creation succeeded but graph connection failed, keep the media
      // audible through the context destination rather than leaving it silent.
      if (source) {
        try {
          source.connect(this.context.destination);
          this.sourceNodes.set(element, source);
        } catch (_) {}
      }
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = 'error';
      this._report();
      return {
        processed: false, attached: Boolean(source), sourceCreated: Boolean(source),
        reason: this.error.message,
      };
    }
  }

  getAnalyserData(target = null) {
    if (!this.graph?.analyser) return null;
    const data = target || new Float32Array(this.graph.analyser.fftSize || 2048);
    this.graph.analyser.getFloatTimeDomainData(data);
    return data;
  }

  signalRms() {
    const data = this.getAnalyserData();
    if (!data?.length) return 0;
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    return Math.sqrt(sum / data.length);
  }

  async verifySignal(element, {
    isCurrent = () => true,
    attempts = 24,
    intervalMs = 250,
    minimumRms = EQ_SIGNAL_RMS_FLOOR,
    sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (!this.isAttached(element) || !this.graph?.analyser) return null;
    // A live stream can spend long enough buffering for Windows/WebView2 to
    // suspend an otherwise valid context. Resume at the point media is really
    // playing so buffering is not misreported as a broken EQ signal.
    if (!await this.resume()) return null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!isCurrent() || element.paused || element.ended) return null;
      if (element.muted || Number(element.volume) === 0) return null;
      if (this.context?.state !== 'running' && !await this.resume()) return null;
      if (this.signalRms() >= minimumRms) return true;
      if (attempt + 1 < attempts) await sleepImpl(intervalMs);
    }
    // Silence is media evidence, not an equalizer-engine failure. Live HLS can
    // legitimately begin with silent segments, switch audio renditions late,
    // or carry no audio track at all. Keep the attached/running graph ready and
    // let the player decide whether silence is actionable for that media kind.
    return false;
  }

  getFrequencyResponse(frequencies) {
    return computeEqResponseDb(this.curve, frequencies, this.context?.sampleRate || 48000);
  }

  async destroy() {
    for (const source of this.sourceNodes.values()) {
      try { source.disconnect(); } catch (_) {}
    }
    this.sourceNodes.clear();
    if (this.context && this.context.state !== 'closed' && typeof this.context.close === 'function') {
      try { await this.context.close(); } catch (_) {}
    }
    this.context = null;
    this.graph = null;
    this.state = 'idle';
    this.error = null;
    this.fatal = false;
    this.externalReason = '';
    this._report();
  }
}

export function createAudioEngine(options) { return new AudioEngine(options); }

function biquadCoefficients(type, frequency, gainDb, sampleRate, q = EQ_FILTER_Q) {
  const nyquistSafe = Math.max(1, Math.min(sampleRate * 0.499, frequency));
  const w0 = 2 * Math.PI * nyquistSafe / sampleRate;
  const cosine = Math.cos(w0);
  const sine = Math.sin(w0);
  const A = 10 ** (gainDb / 40);
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (type === 'peaking') {
    const alpha = sine / (2 * q);
    b0 = 1 + alpha * A; b1 = -2 * cosine; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cosine; a2 = 1 - alpha / A;
  } else {
    const alpha = sine / 2 * Math.sqrt(2);
    const beta = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cosine + beta);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosine);
      b2 = A * ((A + 1) - (A - 1) * cosine - beta);
      a0 = (A + 1) + (A - 1) * cosine + beta;
      a1 = -2 * ((A - 1) + (A + 1) * cosine);
      a2 = (A + 1) + (A - 1) * cosine - beta;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cosine + beta);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosine);
      b2 = A * ((A + 1) + (A - 1) * cosine - beta);
      a0 = (A + 1) - (A - 1) * cosine + beta;
      a1 = 2 * ((A - 1) - (A + 1) * cosine);
      a2 = (A + 1) - (A - 1) * cosine - beta;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function coefficientMagnitude(coefficients, frequency, sampleRate) {
  const w = 2 * Math.PI * Math.max(0, Math.min(sampleRate * 0.499, frequency)) / sampleRate;
  const c1 = Math.cos(w); const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w); const s2 = -Math.sin(2 * w);
  const nr = coefficients.b0 + coefficients.b1 * c1 + coefficients.b2 * c2;
  const ni = coefficients.b1 * s1 + coefficients.b2 * s2;
  const dr = 1 + coefficients.a1 * c1 + coefficients.a2 * c2;
  const di = coefficients.a1 * s1 + coefficients.a2 * s2;
  return Math.sqrt((nr * nr + ni * ni) / Math.max(1e-24, dr * dr + di * di));
}

export function computeEqResponseDb(value, frequencies, sampleRate = 48000) {
  const curve = normalizeEqCurve(value);
  const targets = Array.from(frequencies || [], (frequency) => Number(frequency));
  if (curve.bypassed) return Float32Array.from(targets, () => 0);
  return Float32Array.from(targets, (target) => {
    let magnitude = dbToGain(clamp(curve.preamp, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB));
    for (let index = 0; index < EQ_FREQUENCIES.length; index++) {
      const gain = clamp(curve.bands[index], EQ_MIN_DB, EQ_MAX_DB);
      const coefficients = biquadCoefficients(
        EQ_FILTER_TYPES[index], EQ_FREQUENCIES[index], gain, sampleRate,
      );
      magnitude *= coefficientMagnitude(coefficients, target, sampleRate);
    }
    return 20 * Math.log10(Math.max(1e-12, magnitude));
  });
}
