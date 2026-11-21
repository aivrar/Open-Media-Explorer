/** Synthetic music for the mood's tests, put through the software analyser
 *  (audio-sim.js: Blackman window, FFT, dB, as the page's tap computes
 *  them) and read frame by frame as the page reads it. */

import { simulatedAnalyser } from './audio-sim.js';

export const RATE = 48000;

/** Strokes, as in a drum machine: each a function of the time since it
 *  was struck. */
export function kickStroke(age) {
  if (age < 0 || age > 0.35) return 0;
  const phase = 2 * Math.PI * (50 * age + (110 / 18) * (1 - Math.exp(-18 * age)));
  return 0.9 * Math.exp(-age / 0.09) * Math.sin(phase);
}
export function snareStroke(age, noise) {
  if (age < 0 || age > 0.25) return 0;
  return 0.35 * Math.exp(-age / 0.06) * noise + 0.25 * Math.exp(-age / 0.04) * Math.sin(2 * Math.PI * 190 * age);
}
export function hatStroke(age, noise) {
  if (age < 0 || age > 0.06) return 0;
  return 0.18 * Math.exp(-age / 0.015) * noise;
}

/**
 * A drum pattern at `bpm`: kicks and snares on the given beats of a bar of
 * four, `hats` hats a beat (0: none), over a quiet bass and chord so there
 * is never silence between the strokes.
 */
export function beatTrack({ bpm, hats = 0, kicks = [0, 2], snares = [1, 3], seed = 5 }) {
  const beat = 60 / bpm;
  let state = seed;
  let last = 0;
  return (t) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 1073741824 - 1;
    const bright = noise - last; // high-passed: hats and snares are bright
    last = noise;
    const inBar = t % (4 * beat);
    let sample = 0;
    for (const at of kicks) sample += kickStroke(inBar - at * beat);
    for (const at of snares) sample += snareStroke(inBar - at * beat, bright);
    if (hats) sample += hatStroke(t % (beat / hats), bright);
    sample += 0.12 * Math.sin(2 * Math.PI * 55 * t);
    for (const f of [220, 277.2, 330]) sample += 0.03 * Math.sin(2 * Math.PI * f * t);
    return 0.6 * sample;
  };
}

/** Soft, slowly swelling chords and no drums. */
export function padTrack() {
  return (t) => {
    let chord = 0;
    for (const f of [110, 164.8, 220, 277.2]) chord += Math.sin(2 * Math.PI * f * t);
    return chord * 0.05 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.1 * t));
  };
}

/** Steps `tracker` through `seconds` of `track` from `from` at `fps` frames
 *  a second, each frame read as the page reads it: the analyser's float dB
 *  spectrum and the level (dBFS) of its float samples. `jitter` (0..1):
 *  each frame's time step is 1 / fps moved by up to that share either way
 *  (a fixed pseudo-random sequence). `offsetDb` is added to every spectrum
 *  value (another analyser scale; the level is not changed). `each(now,
 *  tracker, sound)` after every step. Returns the time reached. */
export function listen(tracker, track, seconds, {
  from = 0, fps = 30, gain = 1, jitter = 0, offsetDb = 0, each = null,
} = {}) {
  let now = from;
  const node = simulatedAnalyser({ track, clock: () => now * 1000, gain });
  const db = new Float32Array(1024);
  const wave = new Float32Array(2048);
  const sound = {
    analysis: { active: true, spectrumDb: db, sampleRate: RATE, fftSize: 2048 },
    levelDb: Number.NEGATIVE_INFINITY,
  };
  let seed = 12345;
  const end = from + seconds - 0.5 / fps;
  for (let frame = 0; now < end; frame += 1) {
    if (!jitter) now = from + frame / fps;
    node.getFloatFrequencyData(db);
    if (offsetDb) for (let i = 0; i < db.length; i += 1) db[i] += offsetDb;
    node.getFloatTimeDomainData(wave);
    let sum = 0;
    for (const sample of wave) sum += sample * sample;
    const rms = Math.sqrt(sum / wave.length);
    sound.levelDb = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    tracker.step(now, sound);
    each?.(now, tracker, sound);
    if (jitter) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      now += (1 + jitter * (2 * (seed / 2147483648) - 1)) / fps;
    } else {
      now = from + (frame + 1) / fps;
    }
  }
  return jitter ? now : from + Math.round(seconds * fps) / fps;
}
