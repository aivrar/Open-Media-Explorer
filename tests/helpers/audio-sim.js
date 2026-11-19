/** A software stand-in for a Web Audio AnalyserNode fed with synthesized
 *  music, so the Beat Reactor can be tried on something like real sound:
 *  Blackman window, FFT, magnitude / fftSize in dB (smoothing 0), byte
 *  spectrum on minDecibels..maxDecibels, float time-domain samples - as the
 *  Web Audio spec computes them. `gain` plays the media element's volume
 *  (the tap is after it). */

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** A kick: a sine sweeping 160 -> 50 Hz with a fast decay and a short click. */
export function kick(age) {
  if (age < 0 || age > 0.35) return 0;
  const phase = 2 * Math.PI * (50 * age + (110 / 18) * (1 - Math.exp(-18 * age)));
  const click = age < 0.004 ? (1 - age / 0.004) * 0.3 * Math.sin(2 * Math.PI * 3000 * age) : 0;
  return 0.9 * Math.exp(-age / 0.09) * Math.sin(phase) + click;
}

/** A hat: short bright noise. */
export function hat(age, noise) {
  if (age < 0 || age > 0.06) return 0;
  return 0.15 * Math.exp(-age / 0.015) * noise;
}

/** Four-on-the-floor at `bpm`, with off-beat hats and a quiet pad when
 *  `busy` is set. */
export function danceTrack({ bpm = 120, busy = false, seed = 1 } = {}) {
  const beat = 60 / bpm;
  let state = seed;
  const noise = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state / 1073741824) - 1; };
  return (t) => {
    const age = t % beat;
    let sample = kick(age);
    if (busy) {
      sample += hat((t + beat / 2) % beat, noise());
      sample += 0.05 * Math.sin(2 * Math.PI * 220 * t) + 0.04 * Math.sin(2 * Math.PI * 330 * t + 1);
    }
    return sample;
  };
}

/** The real-window tester's synthetic music: a kick on every beat over a
 *  loud, slowly swelling sub-bass line, chords and off-beat hats. */
export function bassLineTrack({ bpm = 120, seed = 3 } = {}) {
  const period = 60 / bpm;
  let state = seed;
  const noise = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state / 1073741824) - 1; };
  let last = 0;
  return (t) => {
    const beat = t % period;
    const kickPart = Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9 * (0.5 / period)) * 0.9;
    const note = Math.floor(t / 2) % 2 === 0 ? 55 : 73.4;
    const bass = Math.sin(2 * Math.PI * note * t) * 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t));
    let chord = 0;
    for (const f of [220, 277.2, 330, 440, 880]) chord += Math.sin(2 * Math.PI * f * t);
    chord *= 0.06 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t) ** 2);
    const hatRaw = noise() * 0.15 * Math.exp(-(t % (period / 2)) * 40);
    const hatPart = hatRaw - last;
    last = hatRaw;
    return (kickPart + bass + chord + hatPart) * 0.45;
  };
}

/** Calm music: soft, slowly swelling chords and no drums. */
export function padTrack() {
  return (t) => {
    let chord = 0;
    for (const f of [110, 164.8, 220, 277.2]) chord += Math.sin(2 * Math.PI * f * t);
    return chord * 0.05 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.1 * t));
  };
}

export function simulatedAnalyser({
  track, clock, gain = 1, sampleRate = 48000, fftSize = 2048, minDecibels = -85, maxDecibels = -15,
}) {
  const window = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    const x = i / fftSize;
    window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
  }
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const db = new Float32Array(fftSize / 2);
  const samples = new Float32Array(fftSize);
  let at = Number.NaN;
  const node = {
    context: { sampleRate },
    fftSize,
    minDecibels,
    maxDecibels,
    gain,
    floatCalls: 0,
    byteCalls: 0,
    refresh() {
      const now = clock() / 1000;
      if (now === at) return;
      at = now;
      for (let i = 0; i < fftSize; i += 1) samples[i] = track(now - (fftSize - i) / sampleRate) * node.gain;
      for (let i = 0; i < fftSize; i += 1) { re[i] = samples[i] * window[i]; im[i] = 0; }
      fftInPlace(re, im);
      for (let k = 0; k < fftSize / 2; k += 1) {
        const magnitude = Math.hypot(re[k], im[k]) / fftSize;
        db[k] = magnitude > 0 ? 20 * Math.log10(magnitude) : -Infinity;
      }
    },
    getFloatTimeDomainData(out) { node.refresh(); out.set(samples.subarray(0, out.length)); },
    getFloatFrequencyData(out) { node.floatCalls += 1; node.refresh(); out.set(db.subarray(0, out.length)); },
    getByteFrequencyData(out) {
      node.byteCalls += 1;
      node.refresh();
      const span = maxDecibels - minDecibels;
      for (let k = 0; k < out.length; k += 1) {
        const value = Math.floor((255 / span) * (db[k] - minDecibels));
        out[k] = value < 0 ? 0 : (value > 255 ? 255 : value);
      }
    },
  };
  return node;
}
