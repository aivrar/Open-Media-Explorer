/**
 * The music's mood: calm, steady or energetic. It biases the shuffle (calm
 * prefers scenes tagged calm, energetic lively ones) and the strength of the
 * reaction (always inside the flash limiter, which caps depth and rate
 * whatever the strength).
 *
 * Read from what the page already has each frame: the float dB spectrum the
 * reactor's adapter holds for the frame (reactor.js, analysis.spectrumDb)
 * and the sound's level (adapter.levelDb), both with the volume made up. No
 * analyser of its own, no extra read, nothing allocated per frame (every
 * array is made when the tracker is).
 *
 * Each frame: one pass over the spectrum up to 12.8 kHz gives the mean power
 * of MOOD_BAND_EDGES' eight bands (dB; nothing counts from further than
 * MOOD_RANGE_DB under the loudest band, so the readings do not depend on the
 * volume). Each band also has a followed level, which moves toward the band
 * over MOOD_FOLLOW_S (the top two over MOOD_HIGH_FOLLOW_S), stepped by the
 * real time since the last frame with sound. How far a band stands above its
 * followed level (dB, at most MOOD_RISE_CAP_DB; under it counts nothing) is
 * its rise: the mean over all bands is the onset envelope, the mean of the
 * top two (the hats and cymbals) the high envelope. Both are drawn as
 * straight lines between the frames that arrived and kept on a MOOD_GRID_HZ
 * grid for the last MOOD_WINDOW_S (each step: the onset's mean over it, the
 * high envelope's most over the frames in it), with the top bands' level and
 * that level against the whole spectrum's power.
 *
 * Frame rate. The grid is a fixed time grid, but what lands on it depends on
 * the frames: the followed levels and the lines between frames make a rise
 * last as long in time at any spacing, and busy is made up for the hits that
 * fall between two frames (hitsSeen). On music this keeps the word within a
 * few points from 20 to 60 frames a second and with uneven frames. It cannot
 * make up for what no frame saw: below about 25 frames a second the
 * analyser's window (2048 samples, 43 ms at 48 kHz) no longer covers the
 * time between frames, and at 15 a second hats closer together than two
 * frames (sixteenths from about 110 bpm up) are not counted apart, so busy
 * and pulse read lower there and a fast, dense beat can read steady.
 *
 * Every MOOD_EVAL_S, over that window:
 *
 *   onset   the onset envelope's mean (dB): how much the sound keeps
 *           starting anew. Pads, drones and strings glide: low.
 *   busy    strong high onsets a second: peaks of the high envelope at least
 *           MOOD_BUSY_RISE_DB and above the window's own spread, made up for
 *           the hits that fall between frames (hitsSeen).
 *   pulse   how regular the onsets are: the onset envelope's
 *           autocorrelation at the best beat period (0..1).
 *   bright  the top two bands' level (3.2 to 12.8 kHz, the mean of their
 *           dB) against the whole spectrum's power (dB): measured against
 *           the spectrum's own total, so it does not depend on the
 *           analyser's scale or on the level.
 *   sway    how far the top bands' level moves (dB, its spread): a wall of
 *           distorted guitars or held synths moves little, a drum kit with
 *           room between the hits a lot.
 *
 *   drive  = clamp((onset - MOOD_ONSET_FROM) / MOOD_ONSET_SPAN)
 *   pace   = clamp((busy - MOOD_BUSY_FROM) / MOOD_BUSY_SPAN) x
 *            (MOOD_PULSE_BASE + (1 - MOOD_PULSE_BASE) x min(1, pulse / MOOD_PULSE_FULL))
 *   wall   = clamp((bright - MOOD_WALL_FROM) / MOOD_WALL_SPAN) x
 *            clamp((MOOD_SWAY_BELOW - sway) / MOOD_SWAY_SPAN) x
 *            clamp((onset - MOOD_WALL_ONSET_FROM) / MOOD_WALL_ONSET_SPAN)
 *   shine  = clamp((bright - MOOD_BRIGHT_FROM) / MOOD_BRIGHT_SPAN)
 *   beat   = clamp((pulse - MOOD_BEAT_FROM) / MOOD_BEAT_SPAN)
 *   energy = clamp(the sum of each part times its MOOD_WEIGHTS)
 *
 * (clamp: to 0..1.) Busy only counts from MOOD_BUSY_FROM up, so a slow beat
 * with hats on the sixteenths gets little or nothing from it; a loud, bright
 * and even sound (metal, trance) is energetic by its wall even when little
 * in it starts anew, but only while something in it still moves (onset):
 * steady noise, as even and bright as it is, is no wall.
 *
 * The hits the reactor counts are not used: its detectors adapt to the last
 * 0.7 s, so they fire two to three times a second on almost any music. The
 * tempo is not part of the energy either: a reading is often an octave out,
 * and a slow beat with busy hats read in double time must not count as fast.
 *
 * Tempo (createTempoReader): every MOOD_EVAL_S the onset envelope (smoothed
 * 1-2-1) is autocorrelated; a comb over each candidate's first four periods
 * from TEMPO_MIN to TEMPO_MAX bpm with a gentle lean to 120 picks a beat,
 * then of its half, itself and its double (in range) the strongest own
 * period after a lean to 120 (TEMPO_LEAN_OCTAVES wide). A candidate an
 * octave (or a half or third more) from the reading keeps the reading's
 * octave and nudges it; another tempo takes over only after TEMPO_SWITCH
 * readings in a row agree on it. `sure` once TEMPO_SURE_SHARE of the last
 * TEMPO_KEEP readings agree, the pulse is at least TEMPO_SURE_PULSE and the
 * onset at least TEMPO_SURE_ONSET; it stays sure down to TEMPO_STAY_SHARE
 * and TEMPO_STAY_PULSE. Else "not sure" (bpm reads 0 for the panel).
 *
 * The word. Hysteresis: calm below MOOD_CALM_BELOW (left above
 * MOOD_CALM_LEAVE), energetic above MOOD_ENERGETIC_ABOVE (left below
 * MOOD_ENERGETIC_LEAVE). A new word must hold for MOOD_HOLD_S, and the word
 * changes at most once every MOOD_MIN_CHANGE_S. The first reading after a
 * start (MOOD_HOLD_S of sound and a full first window: `ready`) decides at
 * once; until then the word from before stays, so a change of station shows
 * no passing "steady", and the line, the shuffle and the strength all use
 * this one word.
 *
 * Quiet. A frame whose level is under MOOD_QUIET_DB (silence, or a sound
 * dying away) has no rise and is not what the next frame with sound is
 * compared with. The spaces between the hits of a beat are short; quiet for
 * MOOD_GAP_S or more is a gap: the word stays, and is calm at once after
 * MOOD_SILENT_CALM_S, even within MOOD_MIN_CHANGE_S of the last change
 * (silence comes first). Sound after MOOD_GAP_S under the far lower
 * MOOD_SILENCE_DB (the stream stopped, not quiet music or a fade) starts the
 * reading afresh (the word stays until the new first reading). Only stepped
 * while sound plays.
 * reset() starts it afresh (another station, a resume after a pause): no
 * level, onset or tempo from before counts; the word stays until the first
 * new reading.
 */

export const MOODS = Object.freeze(['calm', 'steady', 'energetic']);
export const MOOD_WINDOW_S = 8;
export const MOOD_HOLD_S = 3;
export const MOOD_MIN_CHANGE_S = 10;
export const MOOD_STRENGTH = Object.freeze({ calm: 0.8, steady: 1, energetic: 1.15 });
/** How fast the reaction strength follows the mood (per second). */
export const STRENGTH_SLEW = 0.25;
/** The grid the envelopes are kept on (steps a second), and how often the
 *  window is read (s). */
export const MOOD_GRID_HZ = 30;
export const MOOD_EVAL_S = 0.5;
/** Band edges (Hz): eight bands, an octave or so each. */
export const MOOD_BAND_EDGES = Object.freeze([40, 100, 200, 400, 800, 1600, 3200, 6400, 12800]);
/** How fast a band's followed level follows the band (s). */
export const MOOD_FOLLOW_S = 0.15;
/** The same for the top two bands' own envelope, which counts the hats
 *  (s): short, so hats close together stay apart. */
export const MOOD_HIGH_FOLLOW_S = 0.04;
/** The most a band's rise counts on one frame (dB). */
export const MOOD_RISE_CAP_DB = 30;
/** How long a high hit stays visible to the analyser's frames (s): busy is
 *  made up by hitsSeen() for the share that falls between frames. Fitted to
 *  how busy falls with the frame rate on music, 15 to 60 frames a second. */
export const MOOD_HIT_SEEN_S = 0.084;
/** Frames further apart than this (s) are not compared. */
export const MOOD_FRAME_GAP_S = 0.25;
/** Quiet longer than this (s) inside a stream is a gap: the word is held.
 *  Silence (under MOOD_SILENCE_DB) this long: the reading starts afresh when
 *  sound returns. */
export const MOOD_GAP_S = 2;
/** Quiet this long (s) is calm at once. */
export const MOOD_SILENT_CALM_S = 5;
/** The energy's parts (see above). */
export const MOOD_BUSY_RISE_DB = 4;
export const MOOD_ONSET_FROM = 0.7;
export const MOOD_ONSET_SPAN = 0.8;
export const MOOD_BUSY_FROM = 4.5;
export const MOOD_BUSY_SPAN = 4;
export const MOOD_PULSE_BASE = 0.9;
export const MOOD_PULSE_FULL = 0.4;
export const MOOD_WALL_FROM = -41.7;
export const MOOD_WALL_SPAN = 3;
export const MOOD_SWAY_BELOW = 5.5;
export const MOOD_SWAY_SPAN = 2.5;
export const MOOD_WALL_ONSET_FROM = 0.7;
export const MOOD_WALL_ONSET_SPAN = 0.5;
export const MOOD_BRIGHT_FROM = -51.7;
export const MOOD_BRIGHT_SPAN = 4;
export const MOOD_BEAT_FROM = 0.25;
export const MOOD_BEAT_SPAN = 1.3;
export const MOOD_WEIGHTS = Object.freeze({
  drive: 0.2, pace: 0.65, wall: 0.7, shine: 0.15, beat: 0.1,
});
/** Energy below which the mood turns calm (left above MOOD_CALM_LEAVE), and
 *  above which energetic (left below MOOD_ENERGETIC_LEAVE). */
export const MOOD_CALM_BELOW = 0.2;
export const MOOD_CALM_LEAVE = 0.27;
export const MOOD_ENERGETIC_ABOVE = 0.65;
export const MOOD_ENERGETIC_LEAVE = 0.57;
/** How far under the frame's loudest band a band still counts (dB). */
export const MOOD_RANGE_DB = 60;
/** The sound's level (dBFS, the volume made up) under which it is quiet. */
export const MOOD_QUIET_DB = -55;
/** The level under which there is no sound at all (dBFS): far under the
 *  quiet line, so quiet music and slow fades stay over it. Only this starts
 *  the reading afresh after MOOD_GAP_S. */
export const MOOD_SILENCE_DB = MOOD_QUIET_DB - 20;
/** The tempo reading. */
export const TEMPO_MIN = 60;
export const TEMPO_MAX = 200;
export const TEMPO_LEAN_OCTAVES = 1;
export const TEMPO_SWITCH = 4;
export const TEMPO_KEEP = 8;
export const TEMPO_SURE_SHARE = 0.75;
export const TEMPO_STAY_SHARE = 0.5;
export const TEMPO_SURE_PULSE = 0.3;
export const TEMPO_STAY_PULSE = 0.15;
export const TEMPO_SURE_ONSET = 0.7;

const BANDS = MOOD_BAND_EDGES.length - 1;
const CELLS = MOOD_GRID_HZ * MOOD_WINDOW_S;
const CELL_S = 1 / MOOD_GRID_HZ;
/** Longest beat period looked at, in grid steps, with room for four. */
const MAX_LAG = Math.ceil((60 * MOOD_GRID_HZ * 4) / TEMPO_MIN) + 2;
/** Bins at or under this (dB) count as nothing: far under anything the
 *  analyser reports for sound (its byte floor is -85 dB). */
const FLOOR_DB = -200;
/** The brightness of a window with no sound in it (dB). */
const SILENT_BRIGHT_DB = -100;
/** The octaves bestBeat weighs against each other. */
const OCTAVES = Object.freeze([0.5, 1, 2]);

/** The share of the high hits seen with frames `spacing` (s) apart: a hit
 *  is seen while it is in the analyser's window and still ringing, about
 *  MOOD_HIT_SEEN_S, so with frames further apart some fall between two. */
export function hitsSeen(spacing) {
  return spacing > 0 ? 1 - Math.exp(-MOOD_HIT_SEEN_S / spacing) : 1;
}

const clamp01 = (value) => (value > 0 ? (value < 1 ? value : 1) : 0);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** The energy's parts (each 0..1) from a window's reading { onset, busy,
 *  pulse, bright, sway }, into `out`. */
export function moodParts(reading, out = {}) {
  const pulse = num(reading?.pulse);
  const bright = Number.isFinite(Number(reading?.bright)) ? Number(reading.bright) : -Infinity;
  const sway = Number.isFinite(Number(reading?.sway)) ? Number(reading.sway) : Infinity;
  out.drive = clamp01((num(reading?.onset) - MOOD_ONSET_FROM) / MOOD_ONSET_SPAN);
  out.pace = clamp01((num(reading?.busy) - MOOD_BUSY_FROM) / MOOD_BUSY_SPAN)
    * (MOOD_PULSE_BASE + (1 - MOOD_PULSE_BASE) * Math.min(1, clamp01(pulse) / MOOD_PULSE_FULL));
  out.wall = clamp01((bright - MOOD_WALL_FROM) / MOOD_WALL_SPAN) * clamp01((MOOD_SWAY_BELOW - sway) / MOOD_SWAY_SPAN)
    * clamp01((num(reading?.onset) - MOOD_WALL_ONSET_FROM) / MOOD_WALL_ONSET_SPAN);
  out.shine = clamp01((bright - MOOD_BRIGHT_FROM) / MOOD_BRIGHT_SPAN);
  out.beat = clamp01((pulse - MOOD_BEAT_FROM) / MOOD_BEAT_SPAN);
  return out;
}

const partsScratch = {};
/** Energy (0..1) from a window's reading { onset, busy, pulse, bright, sway }. */
export function moodEnergy(reading) {
  const p = moodParts(reading, partsScratch);
  return clamp01(MOOD_WEIGHTS.drive * p.drive + MOOD_WEIGHTS.pace * p.pace + MOOD_WEIGHTS.wall * p.wall
    + MOOD_WEIGHTS.shine * p.shine + MOOD_WEIGHTS.beat * p.beat);
}

/** The value at fractional lag `lag` of `acf` (linear between steps). */
function acfAt(acf, lag) {
  const index = Math.floor(lag);
  if (index < 0 || index + 1 >= acf.length) return 0;
  const part = lag - index;
  return acf[index] * (1 - part) + acf[index + 1] * part;
}

/**
 * The autocorrelation of `env` (oldest first) for lags 0..acf.length - 1,
 * mean removed, each lag scaled to the full length and divided by the
 * variance (1 at lag 0; 0 when the envelope is flat). Into `acf`.
 */
export function autocorrelate(env, count, acf) {
  let mean = 0;
  for (let i = 0; i < count; i += 1) mean += env[i];
  mean /= count || 1;
  let power = 0;
  for (let i = 0; i < count; i += 1) power += (env[i] - mean) * (env[i] - mean);
  for (let lag = 0; lag < acf.length; lag += 1) {
    if (!(power > 0) || lag >= count) { acf[lag] = 0; continue; }
    let sum = 0;
    for (let i = lag; i < count; i += 1) sum += (env[i] - mean) * (env[i - lag] - mean);
    acf[lag] = (sum / power) * (count / (count - lag));
  }
  return acf;
}

/**
 * The best beat in an onset envelope's autocorrelation (steps of 1 /
 * `rate` s): { bpm, pulse } into `out`. pulse: the mean autocorrelation at
 * the beat's first four periods (0 when nothing repeats). bpm: the comb's
 * best from TEMPO_MIN to TEMPO_MAX (half-bpm steps, a gentle lean to 120),
 * then of its half, itself and its double (in range) the one whose own
 * period is strongest after a lean to 120 (TEMPO_LEAN_OCTAVES wide).
 */
export function bestBeat(acf, rate, out) {
  let best = 0;
  let bestScore = -Infinity;
  let bestPulse = 0;
  for (let bpm = TEMPO_MIN; bpm <= TEMPO_MAX; bpm += 0.5) {
    const lag = (60 * rate) / bpm;
    let sum = 0;
    let count = 0;
    for (let m = 1; m <= 4; m += 1) {
      if (lag * m < acf.length - 1) { sum += acfAt(acf, lag * m); count += 1; }
    }
    const pulse = count ? sum / count : 0;
    const lean = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = pulse * (0.6 + 0.4 * lean);
    if (score > bestScore) { bestScore = score; best = bpm; bestPulse = pulse; }
  }
  // The octave: of half, the same and double (in range), the strongest own
  // period after a lean to 120 bpm (TEMPO_LEAN_OCTAVES wide), so a backbeat
  // or a half-time feel does not halve the reading and busy hats do not
  // double it.
  let pick = best;
  if (best > 0) {
    let pickScore = -Infinity;
    for (let i = 0; i < OCTAVES.length; i += 1) {
      const bpm = best * OCTAVES[i];
      if (bpm < TEMPO_MIN || bpm > TEMPO_MAX) continue;
      const score = acfAt(acf, (60 * rate) / bpm) * Math.exp(-0.5 * (Math.log2(bpm / 120) / TEMPO_LEAN_OCTAVES) ** 2);
      if (score > pickScore) { pickScore = score; pick = bpm; }
    }
  }
  out.bpm = pick;
  out.pulse = bestPulse > 0 ? (bestPulse < 1 ? bestPulse : 1) : 0;
  return out;
}

/** Whether `a` is within 4% of `b` x one of the related ratios. */
const RELATED = Object.freeze([1, 2, 0.5, 1.5, 2 / 3]);
function relatedRatio(a, b) {
  for (let i = 0; i < RELATED.length; i += 1) if (Math.abs(a / (b * RELATED[i]) - 1) < 0.04) return RELATED[i];
  return 0;
}

/** The tempo reading over successive beats (bestBeat): steady, with its
 *  octave kept, and honest about being sure. */
export function createTempoReader() {
  let bpm = 0;
  let sure = false;
  let pending = 0;
  let pendingCount = 0;
  let lastCandidate = 0;
  const agreed = new Uint8Array(TEMPO_KEEP);
  let seen = 0;
  const agreeing = () => {
    let sum = 0;
    for (let i = 0; i < TEMPO_KEEP; i += 1) sum += agreed[i];
    return sum;
  };
  const reading = {
    get bpm() { return bpm; },
    get sure() { return sure; },
    /** The last window's own beat (bpm; 0: none). */
    get candidate() { return lastCandidate; },
    /** How many of the last TEMPO_KEEP readings agreed with the tempo, as a
     *  share of TEMPO_KEEP (0..1). */
    get confidence() { return agreeing() / TEMPO_KEEP; },
    /** One beat reading ({ bpm, pulse }) and the window's onset (dB): under
     *  TEMPO_SURE_ONSET nothing starts often enough to be a beat. */
    update(beat, onset = Infinity) {
      let agree = 0;
      const candidate = beat.pulse > 0 && onset >= TEMPO_SURE_ONSET ? beat.bpm : 0;
      lastCandidate = candidate;
      if (!candidate) {
        pendingCount = 0;
      } else if (!bpm) {
        bpm = candidate;
        agree = 1;
      } else {
        const ratio = relatedRatio(candidate, bpm);
        if (ratio) {
          bpm += (candidate / ratio - bpm) * 0.3;
          pendingCount = 0;
          agree = 1;
        } else {
          if (pendingCount && relatedRatio(candidate, pending) === 1) pendingCount += 1;
          else { pending = candidate; pendingCount = 1; }
          if (pendingCount >= TEMPO_SWITCH) { bpm = pending; pendingCount = 0; agree = 1; }
        }
      }
      agreed[seen % TEMPO_KEEP] = agree;
      seen += 1;
      // Sure once most of the last readings agree; it stays sure while half
      // of them still do (so one odd window does not flip it).
      const share = sure ? TEMPO_STAY_SHARE : TEMPO_SURE_SHARE;
      const pulse = sure ? TEMPO_STAY_PULSE : TEMPO_SURE_PULSE;
      sure = candidate > 0 && seen >= TEMPO_KEEP / 2 && agreeing() >= share * Math.min(seen, TEMPO_KEEP)
        && beat.pulse >= pulse;
      return reading;
    },
    reset() {
      bpm = 0;
      sure = false;
      pending = 0;
      pendingCount = 0;
      lastCandidate = 0;
      seen = 0;
      agreed.fill(0);
    },
  };
  return reading;
}

/** The `k`-th smallest of values[0..count) (moved about in place). */
function selectInPlace(values, count, k) {
  let lo = 0;
  let hi = count - 1;
  while (hi > lo) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i += 1;
      while (values[j] > pivot) j -= 1;
      if (i <= j) {
        const swap = values[i];
        values[i] = values[j];
        values[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

/**
 * Peaks a second in `values` (count of them, `rate` steps a second): a step
 * higher than the one before and not lower than the one after, at least
 * `floor` and above the values' median plus their mean distance from it, and
 * at least two steps after the last peak counted. `scratch`: an array at
 * least as long (its contents are overwritten).
 */
export function peaksPerSecond(values, count, rate, floor, scratch) {
  if (count < 3) return 0;
  for (let i = 0; i < count; i += 1) scratch[i] = values[i];
  const median = selectInPlace(scratch, count, count >> 1);
  let spread = 0;
  for (let i = 0; i < count; i += 1) spread += Math.abs(values[i] - median);
  spread /= count;
  const line = Math.max(floor, median + spread);
  let peaks = 0;
  let last = -2;
  for (let i = 1; i < count - 1; i += 1) {
    const value = values[i];
    if (value > line && value > values[i - 1] && value >= values[i + 1] && i - last >= 2) {
      peaks += 1;
      last = i;
    }
  }
  return (peaks * rate) / count;
}

export function createMoodTracker() {
  let mood = 'steady';
  let candidate = 'steady';
  let candidateSince = 0;
  let lastChange = Number.NEGATIVE_INFINITY;
  let fresh = true; // the first reading decides at once
  let heard = 0; // seconds stepped since the start
  let lastNow = Number.NaN;
  let quietFor = 0;
  let silentFor = 0;
  let energy = 0;
  let strength = 1;
  let evaluated = false;
  let nextEval = Number.NaN;
  let beats = Number.NaN;
  // This frame's bands, their followed levels, and the frame before.
  const levels = new Float64Array(BANDS);
  const followed = new Float64Array(BANDS);
  let haveBefore = false;
  let frameAt = Number.NaN; // the last frame read
  let soundAt = Number.NaN; // the last frame with sound
  const followedHigh = new Float64Array(2);
  let totalPower = 0;
  let allPower = 0;
  let frameTop = FLOOR_DB;
  let frameBright = SILENT_BRIGHT_DB;
  // The grid: filled up to `filledTo` (the envelopes there `fillOnset`,
  // `fillHigh`); the open step's sum, most and whether sound was in it.
  let filledTo = Number.NaN;
  let fillOnset = 0;
  let fillHigh = 0;
  let cellEnd = Number.NaN;
  let cellSum = 0;
  let cellMost = 0;
  let cellHeard = false;
  let cellFrames = 0; // frames that came in the open step
  let cells = 0;
  const onsetRing = new Float64Array(CELLS);
  const highRing = new Float64Array(CELLS);
  const topRing = new Float64Array(CELLS); // the top bands' level (dB)
  const brightRing = new Float64Array(CELLS); // that against the whole (dB)
  const heardRing = new Uint8Array(CELLS); // 1: sound in the step
  const framesRing = new Uint8Array(CELLS); // frames that came in the step
  // Window work arrays (oldest first) and the band bins for this spectrum.
  const onsetWindow = new Float64Array(CELLS);
  const highWindow = new Float64Array(CELLS);
  const scratch = new Float64Array(CELLS);
  const smooth = new Float64Array(CELLS);
  const acf = new Float64Array(MAX_LAG + 1);
  const firstBin = new Int32Array(BANDS);
  const lastBin = new Int32Array(BANDS);
  let binsRate = 0;
  let binsSize = 0;
  let binsLength = 0;
  const beat = { bpm: 0, pulse: 0 };
  const tempo = createTempoReader();
  // What the panel and tests read: the last window's numbers.
  const reading = { onset: 0, busy: 0, pulse: 0, bright: 0, sway: 0 };
  const stats = { changes: 0, evaluations: 0, restarts: 0 };

  function prepareBins(sampleRate, fftSize, length) {
    if (sampleRate === binsRate && fftSize === binsSize && length === binsLength) return;
    binsRate = sampleRate;
    binsSize = fftSize;
    binsLength = length;
    const hz = sampleRate / fftSize;
    for (let band = 0; band < BANDS; band += 1) {
      const first = Math.max(1, Math.ceil(MOOD_BAND_EDGES[band] / hz));
      const last = Math.min(length - 1, Math.ceil(MOOD_BAND_EDGES[band + 1] / hz) - 1);
      firstBin[band] = first;
      lastBin[band] = Math.max(first, last);
    }
  }

  /** The bands' mean power (dB) from this frame's spectrum, and the power
   *  in the bands and in the whole spectrum. False: nothing to read. */
  function readBands(analysis) {
    const db = analysis.spectrumDb;
    if (!analysis.active || !db || !db.length || !(analysis.sampleRate > 0) || !(analysis.fftSize > 0)) return false;
    prepareBins(analysis.sampleRate, analysis.fftSize, db.length);
    totalPower = 0;
    for (let band = 0; band < BANDS; band += 1) {
      let power = 0;
      for (let i = firstBin[band]; i <= lastBin[band]; i += 1) {
        const value = db[i];
        if (value > FLOOR_DB) power += 10 ** (value / 10);
      }
      totalPower += power;
      const mean = power / (lastBin[band] - firstBin[band] + 1);
      levels[band] = mean > 0 ? 10 * Math.log10(mean) : FLOOR_DB;
    }
    // The whole spectrum's power (the bins under and over the bands too):
    // what the top bands are measured against.
    allPower = totalPower;
    for (let i = 1; i < firstBin[0]; i += 1) if (db[i] > FLOOR_DB) allPower += 10 ** (db[i] / 10);
    for (let i = lastBin[BANDS - 1] + 1; i < db.length; i += 1) if (db[i] > FLOOR_DB) allPower += 10 ** (db[i] / 10);
    // Nothing counts from further than MOOD_RANGE_DB under the loudest band:
    // a band rising out of near nothing rises by the same at any loudness.
    let loudest = FLOOR_DB;
    for (let band = 0; band < BANDS; band += 1) if (levels[band] > loudest) loudest = levels[band];
    const floor = loudest - MOOD_RANGE_DB;
    for (let band = 0; band < BANDS; band += 1) if (levels[band] < floor) levels[band] = floor;
    return true;
  }

  /** The grid step that is open is full: into the rings. */
  function closeCell() {
    const at = cells % CELLS;
    onsetRing[at] = cellSum / CELL_S;
    highRing[at] = cellMost;
    topRing[at] = frameTop;
    brightRing[at] = frameBright;
    heardRing[at] = cellHeard ? 1 : 0;
    framesRing[at] = cellFrames;
    cells += 1;
    cellEnd += CELL_S;
    cellSum = 0;
    cellMost = 0;
    cellHeard = false;
    cellFrames = 0;
  }

  /** The envelopes drawn as a straight line from where the grid is filled
   *  up to `time` (onset `onset`, high `high` there), into the steps it
   *  crosses; `sound`: whether the stretch had sound. */
  function fillTo(time, onset, high, sound) {
    if (!Number.isFinite(filledTo)) {
      // Steps end half a step after a frame: at 30 frames a second each
      // step then holds one frame, however the clock rounds.
      filledTo = time;
      cellEnd = time + CELL_S / 2;
      cellFrames = 0;
    } else if (time > filledTo) {
      const start = filledTo;
      const span = time - start;
      let from = start;
      let onsetFrom = fillOnset;
      let highFrom = fillHigh;
      while (from < time) {
        const to = cellEnd < time ? cellEnd : time;
        const part = (to - start) / span;
        const onsetTo = fillOnset + (onset - fillOnset) * part;
        cellSum += (onsetFrom + onsetTo) * 0.5 * (to - from);
        if (sound) cellHeard = true;
        // The high envelope: the most of the frames in the step, or where
        // the line is at the step's end when no frame came in it.
        if (to >= time) {
          if (!cellFrames || high > cellMost) cellMost = high;
          cellFrames += 1;
        }
        if (to >= cellEnd) {
          if (!cellFrames) cellMost = fillHigh + (high - fillHigh) * part;
          closeCell();
        }
        from = to;
        onsetFrom = onsetTo;
      }
      filledTo = time;
    }
    fillOnset = onset;
    fillHigh = high;
  }

  /** This frame into the envelopes. */
  function measure(now, analysis, levelDb) {
    if (!analysis || !readBands(analysis)) return;
    if (Number.isFinite(frameAt) && !(now > frameAt)) return;
    if (!Number.isFinite(frameAt) || now - frameAt > MOOD_FRAME_GAP_S) {
      // Too long since the last frame: the grid starts again here.
      filledTo = Number.NaN;
      cellSum = 0;
      cellMost = 0;
      cellHeard = false;
      haveBefore = false;
    }
    if (!(totalPower > 0) || !(levelDb >= MOOD_QUIET_DB)) {
      // Silence, or a sound dying away under the quiet line: no rise, and
      // not what the next frame with sound is compared with (that is the
      // last frame with sound).
      fillTo(now, 0, 0, false);
      frameAt = now;
      return;
    }
    let all = 0;
    let high = 0;
    if (haveBefore) {
      const dt = now - soundAt;
      const follow = 1 - Math.exp(-dt / MOOD_FOLLOW_S);
      const followHigh = 1 - Math.exp(-dt / MOOD_HIGH_FOLLOW_S);
      for (let band = 0; band < BANDS; band += 1) {
        const over = levels[band] - followed[band];
        all += over > 0 ? (over < MOOD_RISE_CAP_DB ? over : MOOD_RISE_CAP_DB) : 0;
        followed[band] += (levels[band] - followed[band]) * follow;
      }
      for (let k = 0; k < 2; k += 1) {
        const band = BANDS - 2 + k;
        const over = levels[band] - followedHigh[k];
        high += over > 0 ? (over < MOOD_RISE_CAP_DB ? over : MOOD_RISE_CAP_DB) : 0;
        followedHigh[k] += (levels[band] - followedHigh[k]) * followHigh;
      }
    } else {
      for (let band = 0; band < BANDS; band += 1) followed[band] = levels[band];
      followedHigh[0] = levels[BANDS - 2];
      followedHigh[1] = levels[BANDS - 1];
      haveBefore = true;
    }
    frameTop = (levels[BANDS - 1] + levels[BANDS - 2]) / 2;
    frameBright = frameTop - 10 * Math.log10(allPower);
    fillTo(now, all / BANDS, high / 2, true);
    frameAt = now;
    soundAt = now;
  }

  /** The window's numbers and the energy from them. */
  function evaluate() {
    const count = Math.min(cells, CELLS);
    let sum = 0;
    let top = 0;
    let topSquares = 0;
    let bright = 0;
    let heardCells = 0;
    let frames = 0;
    for (let i = 0; i < count; i += 1) {
      const at = (cells - count + i) % CELLS;
      onsetWindow[i] = onsetRing[at];
      highWindow[i] = highRing[at];
      frames += framesRing[at];
      sum += onsetRing[at];
      if (!heardRing[at]) continue; // silence: no brightness or sway
      heardCells += 1;
      top += topRing[at];
      topSquares += topRing[at] * topRing[at];
      bright += brightRing[at];
    }
    reading.onset = count ? sum / count : 0;
    const topMean = heardCells ? top / heardCells : 0;
    reading.bright = heardCells ? bright / heardCells : SILENT_BRIGHT_DB;
    reading.sway = heardCells ? Math.sqrt(Math.max(0, topSquares / heardCells - topMean * topMean)) : 0;
    // Busy, made up for the hits that fall between two frames and are not
    // seen (more of them the further apart the frames come).
    const spacing = frames > 0 ? (count * CELL_S) / frames : CELL_S;
    reading.busy = peaksPerSecond(highWindow, count, MOOD_GRID_HZ, MOOD_BUSY_RISE_DB, scratch) / hitsSeen(spacing);
    // For the beat, the envelope smoothed (1, 2, 1): onsets faster than the
    // grid can hold evenly (sixteenths at 170 bpm and up) would otherwise
    // fall on it in a pattern of their own and look like another tempo.
    for (let i = 0; i < count; i += 1) {
      const a = onsetWindow[i > 0 ? i - 1 : i];
      const c = onsetWindow[i < count - 1 ? i + 1 : i];
      smooth[i] = (a + 2 * onsetWindow[i] + c) / 4;
    }
    autocorrelate(smooth, count, acf);
    bestBeat(acf, MOOD_GRID_HZ, beat);
    reading.pulse = beat.pulse;
    tempo.update(beat, reading.onset);
    energy = moodEnergy(reading);
    evaluated = true;
    stats.evaluations += 1;
  }

  function wanted(value) {
    if (mood === 'calm') {
      if (value > MOOD_ENERGETIC_ABOVE) return 'energetic';
      return value > MOOD_CALM_LEAVE ? 'steady' : 'calm';
    }
    if (mood === 'energetic') {
      if (value < MOOD_CALM_BELOW) return 'calm';
      return value < MOOD_ENERGETIC_LEAVE ? 'steady' : 'energetic';
    }
    if (value < MOOD_CALM_BELOW) return 'calm';
    if (value > MOOD_ENERGETIC_ABOVE) return 'energetic';
    return 'steady';
  }

  function change(next, now) {
    if (next === mood) return;
    mood = next;
    lastChange = now;
    stats.changes += 1;
  }

  /** Everything heard so far forgotten; the word and the strength stay
   *  until the first new reading decides. */
  function restart() {
    fresh = true;
    candidate = mood;
    candidateSince = 0;
    lastChange = Number.NEGATIVE_INFINITY;
    heard = 0;
    energy = 0;
    evaluated = false;
    nextEval = Number.NaN;
    beats = Number.NaN;
    haveBefore = false;
    frameAt = Number.NaN;
    soundAt = Number.NaN;
    frameTop = FLOOR_DB;
    frameBright = SILENT_BRIGHT_DB;
    filledTo = Number.NaN;
    fillOnset = 0;
    fillHigh = 0;
    cellEnd = Number.NaN;
    cellSum = 0;
    cellMost = 0;
    cellHeard = false;
    cells = 0;
    onsetRing.fill(0);
    highRing.fill(0);
    topRing.fill(0);
    brightRing.fill(0);
    heardRing.fill(0);
    framesRing.fill(0);
    reading.onset = 0;
    reading.busy = 0;
    reading.pulse = 0;
    reading.bright = 0;
    reading.sway = 0;
    tempo.reset();
  }

  return {
    get mood() { return mood; },
    get energy() { return energy; },
    get strength() { return strength; },
    /** The last window's onset, busy and pulse (one object, filled in again). */
    reading,
    /** The tempo reading (createTempoReader). */
    tempo,
    /** Beats counted at the tempo read since it became sure; NaN while it
     *  is not sure (song structure's bar clock). */
    get beats() { return beats; },
    /** A reading of its own: MOOD_HOLD_S of sound and a first full window. */
    get ready() { return heard >= MOOD_HOLD_S && evaluated; },
    /** Whether the sound is in a gap: under the quiet line for MOOD_GAP_S
     *  or more. */
    get quiet() { return quietFor >= MOOD_GAP_S; },
    stats,
    /**
     * One step while sound plays.
     * @param {number} now seconds
     * @param {object} sound  { analysis, levelDb }: the reactor adapter's
     *        analysis for this frame (spectrumDb, sampleRate, fftSize,
     *        active) and the sound's level in dBFS (adapter.levelDb)
     */
    step(now, sound) {
      const dt = Number.isFinite(lastNow) && now > lastNow ? Math.min(0.5, now - lastNow) : 0;
      lastNow = now;
      // How long since the level was last at the quiet line or over it: the
      // spaces between the hits of a beat are far shorter than MOOD_GAP_S.
      const levelDb = Number(sound?.levelDb);
      if (levelDb >= MOOD_QUIET_DB) quietFor = 0;
      else quietFor += dt;
      // How long since it was last over the far lower silence line: only a
      // stream that stopped (no sound at all), not quiet music or a fade.
      if (levelDb >= MOOD_SILENCE_DB) {
        // Sound again after MOOD_GAP_S of silence: what was heard before it
        // does not count.
        if (silentFor >= MOOD_GAP_S) { restart(); stats.restarts += 1; }
        silentFor = 0;
      } else {
        silentFor += dt;
      }
      const gap = quietFor >= MOOD_GAP_S;
      heard += dt;
      measure(now, sound?.analysis, Number(sound?.levelDb));
      if (!Number.isFinite(nextEval)) nextEval = now + MOOD_EVAL_S;
      if (now >= nextEval) {
        nextEval = Math.max(nextEval + MOOD_EVAL_S, now - MOOD_EVAL_S);
        if (cells >= MOOD_GRID_HZ * MOOD_HOLD_S) evaluate();
      }
      // The beat count at the tempo read, while it is sure.
      if (!tempo.sure) beats = Number.NaN;
      else beats = (Number.isFinite(beats) ? beats : 0) + (dt * tempo.bpm) / 60;
      if (gap) {
        // A gap keeps the word; quiet long enough is calm at once. This is
        // the one change that does not wait for MOOD_MIN_CHANGE_S since the
        // last: nothing is playing, so the word must not stay lively.
        if (quietFor >= MOOD_SILENT_CALM_S) change('calm', now);
        candidate = mood;
        candidateSince = now;
      } else if (!(heard >= MOOD_HOLD_S && evaluated)) {
        // Not ready: the word from before stays.
        candidate = mood;
        candidateSince = now;
      } else if (fresh) {
        // The first reading after a start decides at once.
        fresh = false;
        change(wanted(energy), now);
        candidate = mood;
        candidateSince = now;
      } else {
        const next = wanted(energy);
        if (next !== candidate) { candidate = next; candidateSince = now; }
        if (candidate !== mood && now - candidateSince >= MOOD_HOLD_S && now - lastChange >= MOOD_MIN_CHANGE_S) {
          change(candidate, now);
        }
      }
      const target = MOOD_STRENGTH[mood];
      const most = STRENGTH_SLEW * dt;
      strength += Math.max(-most, Math.min(most, target - strength));
      return mood;
    },
    /** Another station or a resume: start afresh (the word stays until the
     *  first new reading). */
    reset() {
      restart();
      quietFor = 0;
      silentFor = 0;
      lastNow = Number.NaN;
    },
  };
}
