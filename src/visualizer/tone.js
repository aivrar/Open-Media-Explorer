/**
 * The music's tone, beside its mood (mood.js): how bright or dark it sounds,
 * how bass-heavy, and how much it swells and drops over a few bars. Each is
 * 0..1, smoothed over seconds (TONE_SMOOTH_S).
 *
 * Read from the spectrum the reactor's adapter already holds for the frame
 * (reactor.js: analysis.spectrumDb, the float dB spectrum the signal read
 * once for this tick): no analyser of its own, no extra read, nothing
 * allocated per frame. It is worked out at most every TONE_EVERY_S, not
 * every frame.
 *
 *   brightness  the spectral centroid (power-weighted mean frequency) on a
 *               log scale: TONE_DARK_HZ reads 0, TONE_BRIGHT_HZ reads 1
 *   weight      the share of the power below TONE_BASS_HZ, TONE_BASS_FULL
 *               reading 1
 *   swell       how far the sound's level (dB) moves around its slow mean:
 *               the mean distance over about TONE_SWELL_S, TONE_SWELL_DB
 *               reading 1
 *
 * Music only: nothing here tells speech apart. Used by the shuffle as a
 * gentle weighting (shuffle.js toneWeight), held while MOOD_TONE_RELEASED is
 * false. It never reaches brightness limits, speed caps or the flash rules.
 */

/** Whether tone steers the shuffle (the tracker runs only then). */
export const MOOD_TONE_RELEASED = false;
export const TONE_EVERY_S = 0.25;
export const TONE_SMOOTH_S = 4;
export const TONE_DARK_HZ = 400;
export const TONE_BRIGHT_HZ = 4000;
export const TONE_BASS_HZ = 250;
export const TONE_BASS_FULL = 0.6;
export const TONE_SWELL_S = 10;
export const TONE_SWELL_DB = 6;
/** Bins under this (dB) count as nothing (the analyser's floor). */
const FLOOR_DB = -100;

const clamp01 = (value) => (value > 0 ? (value < 1 ? value : 1) : 0);

/**
 * The tone of one spectrum: { brightness, weight, levelDb } into `out`, or
 * false when there is no sound in it. `db`: dB per bin, bin i at
 * i x sampleRate / fftSize Hz.
 */
export function measureTone(db, sampleRate, fftSize, out) {
  if (!db || !db.length || !(sampleRate > 0) || !(fftSize > 0)) return false;
  const hzPerBin = sampleRate / fftSize;
  let total = 0;
  let weighted = 0;
  let low = 0;
  for (let i = 1; i < db.length; i += 1) {
    const value = db[i];
    if (!(value > FLOOR_DB)) continue;
    const power = 10 ** (value / 10);
    const hz = i * hzPerBin;
    total += power;
    weighted += power * hz;
    if (hz < TONE_BASS_HZ) low += power;
  }
  if (!(total > 0)) return false;
  const centroid = weighted / total;
  out.brightness = clamp01(Math.log(centroid / TONE_DARK_HZ) / Math.log(TONE_BRIGHT_HZ / TONE_DARK_HZ));
  out.weight = clamp01(low / total / TONE_BASS_FULL);
  out.levelDb = 10 * Math.log10(total);
  return true;
}

export function createToneTracker() {
  // What the shuffle reads: one object, filled in again.
  const tone = { brightness: 0.5, weight: 0.5, swell: 0, ready: false };
  const sample = { brightness: 0, weight: 0, levelDb: 0 };
  let lastAt = Number.NaN;
  let meanDb = Number.NaN;
  let distance = 0;
  const stats = { measured: 0 };
  return {
    tone,
    stats,
    /**
     * One step while sound plays: `now` (s) and the adapter's analysis for
     * this frame ({ active, spectrumDb, sampleRate, fftSize }).
     */
    step(now, analysis) {
      if (!Number.isFinite(now)) return tone;
      if (Number.isFinite(lastAt) && now >= lastAt && now - lastAt < TONE_EVERY_S) return tone;
      const dt = Number.isFinite(lastAt) && now > lastAt ? Math.min(1, now - lastAt) : 0;
      lastAt = now;
      if (!analysis?.active || !measureTone(analysis.spectrumDb, analysis.sampleRate, analysis.fftSize, sample)) {
        return tone;
      }
      stats.measured += 1;
      if (!tone.ready) {
        tone.brightness = sample.brightness;
        tone.weight = sample.weight;
        meanDb = sample.levelDb;
        tone.ready = true;
        return tone;
      }
      const follow = 1 - Math.exp(-dt / TONE_SMOOTH_S);
      tone.brightness += (sample.brightness - tone.brightness) * follow;
      tone.weight += (sample.weight - tone.weight) * follow;
      const slow = 1 - Math.exp(-dt / TONE_SWELL_S);
      meanDb += (sample.levelDb - meanDb) * slow;
      distance += (Math.abs(sample.levelDb - meanDb) - distance) * slow;
      tone.swell += (clamp01(distance / TONE_SWELL_DB) - tone.swell) * follow;
      return tone;
    },
    reset() {
      tone.brightness = 0.5;
      tone.weight = 0.5;
      tone.swell = 0;
      tone.ready = false;
      lastAt = Number.NaN;
      meanDb = Number.NaN;
      distance = 0;
    },
  };
}
