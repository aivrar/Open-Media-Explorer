import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MOOD_BUSY_FROM, MOOD_BUSY_RISE_DB, MOOD_CALM_BELOW, MOOD_CALM_LEAVE, MOOD_ENERGETIC_ABOVE, MOOD_ENERGETIC_LEAVE,
  MOOD_GAP_S, MOOD_GRID_HZ, MOOD_HOLD_S, MOOD_MIN_CHANGE_S, MOOD_QUIET_DB, MOOD_SILENCE_DB, MOOD_SILENT_CALM_S,
  MOOD_STRENGTH, MOOD_SWAY_BELOW,
  MOOD_WALL_FROM, MOOD_WALL_ONSET_FROM, MOOD_WEIGHTS, TEMPO_KEEP, TEMPO_SWITCH,
  autocorrelate, bestBeat, createMoodTracker, createTempoReader, hitsSeen, moodEnergy, moodParts, peaksPerSecond,
} from '../src/visualizer/mood.js';
import {
  beatTrack, hatStroke, kickStroke, listen, padTrack, snareStroke,
} from './helpers/mood-sim.js';

/* The mood's measure, on synthetic music put through a software analyser
   (Blackman window, FFT, dB, as the page's tap computes them). */

/** The energy's spread over the second half of a run of `track`. */
function energies(track, seconds, options = {}) {
  const tracker = createMoodTracker();
  const seen = [];
  listen(tracker, track, seconds, { ...options, each: (now, t) => { if (now >= seconds / 2) seen.push(t.energy); } });
  seen.sort((a, b) => a - b);
  return { tracker, low: seen[0], median: seen[seen.length >> 1], high: seen[seen.length - 1] };
}

/* A slow beat with hats on the sixteenths and on the eighths; busy four to
   the floor at 128 and 140 bpm with hats on the sixteenths; a fast
   breakbeat; and a beat whose energy wobbles about the energetic line but
   stays above the line it is left at (four to the floor at 110). */
const SLOW_SIXTEENTHS = { bpm: 60, hats: 4 };
const SLOW_EIGHTHS = { bpm: 60, hats: 2 };
const HOUSE = { bpm: 128, hats: 4, kicks: [0, 1, 2, 3] };
const DANCE = { bpm: 140, hats: 4, kicks: [0, 1, 2, 3] };
const BREAKS = { bpm: 174, hats: 4, kicks: [0, 2.5] };
const BETWEEN = { bpm: 110, hats: 4, kicks: [0, 1, 2, 3] };
/** Digital silence, and a soft tone at -60 dBFS (under the quiet line,
 *  far over the silence line): very quiet music or the end of a fade. */
const silence = () => 0;
const faint = (t) => Math.SQRT2 * 1e-3 * Math.sin(2 * Math.PI * 220 * t);

/* ---- The guard: a slow beat with busy hats is not energetic ---- */

test('a slow 60 bpm beat with hats on the sixteenths or eighths is not energetic at 15, 30 or 60 frames a second, with uneven frames or with the spectrum 6 dB up', () => {
  for (const hats of [SLOW_SIXTEENTHS, SLOW_EIGHTHS]) {
    for (const [label, options] of [
      ['30 fps', {}], ['15 fps', { fps: 15 }], ['60 fps', { fps: 60 }],
      ['uneven frames', { jitter: 0.3 }], ['+6 dB', { offsetDb: 6 }],
    ]) {
      const run = energies(beatTrack(hats), 40, options);
      const name = `hats ${hats.hats} a beat, ${label}`;
      assert.notEqual(run.tracker.mood, 'energetic', `${name}: energy ${run.median}`);
      assert.ok(run.high <= MOOD_ENERGETIC_ABOVE, `${name}: energy up to ${run.high}`);
    }
  }
});

/* ---- Fast busy beats ---- */

test('busy four to the floor at 128 and at 140 bpm and a 174 bpm breakbeat read energetic', () => {
  // Hats on the sixteenths: eight or more strong high onsets a second.
  for (const beat of [HOUSE, DANCE, BREAKS]) {
    const run = energies(beatTrack(beat), 40);
    assert.equal(run.tracker.mood, 'energetic', `${beat.bpm} bpm: ${run.median}`);
  }
});

/* ---- Frame rate, uneven frames, volume and the analyser's scale ---- */

test('the reading is about the same from 20 to 60 frames a second and with uneven frames', () => {
  for (const [name, track, near] of [
    ['slow beat', SLOW_SIXTEENTHS, 0.1],
    ['fast breakbeat', BREAKS, 0.25],
    ['four to the floor at 140', DANCE, 0.2],
  ]) {
    const at30 = energies(beatTrack(track), 30);
    for (const [label, options] of [
      ['20 fps', { fps: 20 }], ['25 fps', { fps: 25 }], ['60 fps', { fps: 60 }], ['uneven frames', { jitter: 0.3 }],
    ]) {
      const run = energies(beatTrack(track), 30, options);
      assert.equal(run.tracker.mood, at30.tracker.mood, `${name}, ${label}: ${run.median} against ${at30.median} at 30 fps`);
      assert.ok(Math.abs(run.median - at30.median) < near, `${name}, ${label}: ${run.median} against ${at30.median} at 30 fps`);
    }
  }
  const pad30 = energies(padTrack(), 30);
  for (const fps of [15, 20, 25, 60]) {
    const pad = energies(padTrack(), 30, { fps });
    assert.equal(pad.tracker.mood, 'calm', `pad at ${fps} fps`);
    assert.ok(Math.abs(pad.median - pad30.median) < 0.05);
  }
});

test('at 15 frames a second the slow beat and the pad read as at 30; hats closer than two frames are not counted, so a fast breakbeat reads steady there, never calm', () => {
  for (const track of [SLOW_SIXTEENTHS, SLOW_EIGHTHS]) {
    const at30 = energies(beatTrack(track), 30);
    const at15 = energies(beatTrack(track), 30, { fps: 15 });
    assert.equal(at15.tracker.mood, at30.tracker.mood);
    assert.ok(Math.abs(at15.median - at30.median) < 0.2, `${at15.median} against ${at30.median}`);
  }
  // Sixteenths at 174 bpm come every 86 ms, frames at 15 a second every
  // 67 ms: most hats fall between two frames or share one.
  const breaks = energies(beatTrack(BREAKS), 30, { fps: 15 });
  assert.notEqual(breaks.tracker.mood, 'calm', String(breaks.median));
  assert.ok(breaks.low > MOOD_CALM_LEAVE, String(breaks.low));
});

test('the reading does not depend on the volume, and the spectrum 6 dB up or down changes nothing', () => {
  for (const track of [SLOW_SIXTEENTHS, DANCE]) {
    const at = energies(beatTrack(track), 30);
    const quieter = energies(beatTrack(track), 30, { gain: 0.25 });
    assert.ok(Math.abs(at.median - quieter.median) < 0.05, `full ${at.median}, -12 dB ${quieter.median}`);
    for (const offsetDb of [6, -6]) {
      const shifted = createMoodTracker();
      const plain = createMoodTracker();
      listen(plain, beatTrack(track), 20);
      listen(shifted, beatTrack(track), 20, { offsetDb });
      for (const key of ['onset', 'busy', 'pulse', 'bright', 'sway']) {
        assert.ok(Math.abs(shifted.reading[key] - plain.reading[key]) < 1e-6, `${offsetDb} dB, ${key}`);
      }
      assert.ok(Math.abs(shifted.energy - plain.energy) < 1e-9);
      assert.equal(shifted.mood, plain.mood);
    }
  }
});

/* ---- What the energy is made of ---- */

/** Noise from a small fixed generator (xorshift), bright and even. */
function noiseTrack(level) {
  let state = 2463534242;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return level * (state / 2147483648 - 1);
  };
}

test('steady noise, however bright and even, is not energetic and gives no sure tempo', () => {
  const noise = energies(noiseTrack(0.3), 30);
  assert.notEqual(noise.tracker.mood, 'energetic', String(noise.median));
  assert.ok(noise.high < MOOD_ENERGETIC_LEAVE, String(noise.high));
  assert.equal(noise.tracker.tempo.sure, false);
});

test('a bright, even wall of sound with something moving in it is energetic, a swaying one is not', () => {
  // Readings as metal and held synths give them: little starts anew and
  // the hats are not busy, but the top bands are loud and hardly move.
  const wall = { onset: 1.25, busy: 1.5, pulse: 0.24, bright: -38.5, sway: 2.3 };
  assert.ok(moodEnergy(wall) > MOOD_ENERGETIC_ABOVE, String(moodEnergy(wall)));
  const parts = moodParts(wall);
  assert.equal(parts.wall, 1);
  // The same brightness with a drum kit's sway, or the wall with nothing
  // moving in it (steady noise): no wall.
  assert.equal(moodParts({ ...wall, sway: MOOD_SWAY_BELOW + 0.5 }).wall, 0);
  assert.equal(moodParts({ ...wall, onset: MOOD_WALL_ONSET_FROM }).wall, 0);
  assert.ok(moodEnergy({ ...wall, sway: 8 }) < MOOD_ENERGETIC_LEAVE);
  // Darker than MOOD_WALL_FROM: no wall either.
  assert.equal(moodParts({ ...wall, bright: MOOD_WALL_FROM - 1 }).wall, 0);
});

test('a pad with no drums reads calm, and so does near silence', () => {
  const pad = energies(padTrack(), 30);
  assert.equal(pad.tracker.mood, 'calm', String(pad.median));
  assert.ok(pad.high < MOOD_CALM_BELOW);
  // The busy dance beat at a whisper (-70 dB): calm, whatever its onsets.
  const whisper = energies(beatTrack(DANCE), 30, { gain: 10 ** (-70 / 20) });
  assert.equal(whisper.tracker.mood, 'calm');
});

/* ---- When the word may change ---- */

/** Steps `tracker` through `track` from `from` until its word changes (at
 *  most `seconds`); the time of the change (NaN: none), the time the
 *  energy first asked for `word`, and the time reached. */
function untilChange(tracker, track, seconds, from, word) {
  const before = tracker.stats.changes;
  let changedAt = Number.NaN;
  let askedAt = Number.NaN;
  const each = (now, m) => {
    if (Number.isNaN(changedAt) && m.stats.changes > before) changedAt = now;
    const asks = word === 'calm' ? m.energy < MOOD_CALM_BELOW : m.energy > MOOD_ENERGETIC_ABOVE;
    if (Number.isNaN(askedAt) && m.ready && asks) askedAt = now;
  };
  let t = from;
  while (Number.isNaN(changedAt) && t < from + seconds) t = listen(tracker, track, 0.1, { from: t, each });
  return { changedAt, askedAt, t };
}

test('on sounding music the word changes at most once in MOOD_MIN_CHANGE_S, a new word holds MOOD_HOLD_S first, and the strength follows slowly', () => {
  const tracker = createMoodTracker();
  // The first decision (at once, when the reading is ready): energetic.
  const first = untilChange(tracker, beatTrack(BREAKS), 15, 0, 'energetic');
  assert.equal(tracker.mood, 'energetic');
  assert.ok(first.changedAt >= MOOD_HOLD_S, `first word at ${first.changedAt}`);
  // Straight after that decision, a pad: the energy asks for calm well
  // before ten seconds are up, but the word waits for MOOD_MIN_CHANGE_S
  // since the last change.
  const toCalm = untilChange(tracker, padTrack(), 30, first.t, 'calm');
  assert.equal(tracker.mood, 'calm');
  assert.ok(toCalm.askedAt - first.changedAt < MOOD_MIN_CHANGE_S - MOOD_HOLD_S,
    `calm asked for ${(toCalm.askedAt - first.changedAt).toFixed(1)} s after the last change`);
  assert.ok(toCalm.changedAt - first.changedAt >= MOOD_MIN_CHANGE_S - 1e-6,
    `calm ${(toCalm.changedAt - first.changedAt).toFixed(2)} s after the last change`);
  assert.ok(toCalm.changedAt - first.changedAt < MOOD_MIN_CHANGE_S + 0.6, 'and then at once');
  // Straight after that, the busy beat again: energetic, again not within
  // MOOD_MIN_CHANGE_S of the last change, and only once the new word has
  // held MOOD_HOLD_S.
  const back = untilChange(tracker, beatTrack({ ...BREAKS, seed: 7 }), 30, toCalm.t, 'energetic');
  assert.equal(tracker.mood, 'energetic');
  assert.ok(back.changedAt - toCalm.changedAt >= MOOD_MIN_CHANGE_S - 1e-6,
    `energetic ${(back.changedAt - toCalm.changedAt).toFixed(2)} s after the last change`);
  assert.ok(back.changedAt - back.askedAt >= MOOD_HOLD_S - 0.6, 'held first');
  assert.equal(tracker.stats.changes, 3);
  // The strength follows at STRENGTH_SLEW a second: after a calm stretch
  // it has reached calm's.
  const calm = createMoodTracker();
  listen(calm, padTrack(), 30);
  assert.ok(Math.abs(calm.strength - MOOD_STRENGTH.calm) < 0.05, 'the strength has followed');
});

test('silence comes before the ten-second limit: silent for MOOD_SILENT_CALM_S is calm even right after a change', () => {
  const tracker = createMoodTracker();
  const first = untilChange(tracker, beatTrack(BREAKS), 15, 0, 'energetic');
  assert.equal(tracker.mood, 'energetic');
  // Straight after the decision, silence.
  const quiet = untilChange(tracker, silence, 8, first.t, 'calm');
  assert.equal(tracker.mood, 'calm');
  assert.ok(quiet.changedAt - first.t >= MOOD_SILENT_CALM_S - 0.05 && quiet.changedAt - first.t < MOOD_SILENT_CALM_S + 0.2,
    `calm ${(quiet.changedAt - first.t).toFixed(2)} s into the silence`);
  assert.ok(quiet.changedAt - first.changedAt < MOOD_MIN_CHANGE_S,
    `${(quiet.changedAt - first.changedAt).toFixed(2)} s after the last change`);
});

test('the hysteresis: energy wobbling about a line does not flip the word', () => {
  assert.ok(MOOD_CALM_LEAVE > MOOD_CALM_BELOW && MOOD_ENERGETIC_LEAVE < MOOD_ENERGETIC_ABOVE);
  const tracker = createMoodTracker();
  const busy = beatTrack(BREAKS);
  let t = listen(tracker, busy, 20);
  assert.equal(tracker.mood, 'energetic');
  const changes = tracker.stats.changes;
  // A beat whose energy is about the energetic line but above the line it
  // is left at, and the busy one again, in turns: the word stays.
  const between = beatTrack(BETWEEN);
  for (let round = 0; round < 3; round += 1) {
    t = listen(tracker, between, 6, { from: t });
    t = listen(tracker, busy, 6, { from: t });
  }
  assert.equal(tracker.stats.changes, changes, 'no flip');
});

test('reset starts afresh: nothing from before counts, the word stays until it is ready again after MOOD_HOLD_S', () => {
  // Each run its own copy of the beat (the beat's noise has a state).
  const fresh = createMoodTracker();
  listen(fresh, beatTrack(BREAKS), 12, { from: 100 });
  const reset = createMoodTracker();
  listen(reset, padTrack(), 12);
  assert.equal(reset.mood, 'calm');
  reset.reset();
  assert.equal(reset.ready, false);
  assert.equal(reset.mood, 'calm', 'the word stays');
  assert.equal(reset.energy, 0);
  assert.equal(reset.tempo.bpm, 0);
  listen(reset, beatTrack(BREAKS), 12, { from: 100 });
  assert.equal(reset.ready, true);
  assert.ok(Math.abs(reset.energy - fresh.energy) < 1e-9, `${reset.energy} vs ${fresh.energy}`);
  assert.equal(reset.mood, fresh.mood);
});

test('a change of station between two energetic beats never shows "steady": the first reading decides at once', () => {
  const tracker = createMoodTracker();
  listen(tracker, beatTrack(BREAKS), 20);
  assert.equal(tracker.mood, 'energetic');
  tracker.reset();
  const words = new Set();
  let readyAt = Number.NaN;
  listen(tracker, beatTrack({ ...DANCE, seed: 11 }), 15, {
    from: 50,
    each: (now, m) => {
      words.add(m.mood);
      if (Number.isNaN(readyAt) && m.ready) readyAt = now;
    },
  });
  assert.deepEqual([...words], ['energetic']);
  // From calm to a busy beat: energetic as soon as the reading is ready,
  // not MOOD_HOLD_S later.
  const calm = createMoodTracker();
  listen(calm, padTrack(), 20);
  assert.equal(calm.mood, 'calm');
  calm.reset();
  let energeticAt = Number.NaN;
  readyAt = Number.NaN;
  listen(calm, beatTrack(BREAKS), 10, {
    from: 50,
    each: (now, m) => {
      if (Number.isNaN(readyAt) && m.ready) readyAt = now;
      if (Number.isNaN(energeticAt) && m.mood === 'energetic') energeticAt = now;
      if (Number.isNaN(readyAt)) assert.equal(m.mood, 'calm', 'the word stays until ready');
    },
  });
  assert.equal(energeticAt, readyAt);
  assert.ok(readyAt - 50 < MOOD_HOLD_S + 0.6, `ready ${readyAt - 50} s after the reset`);
});

/* ---- Silence ---- */

test('silence: the word stays, then turns calm after MOOD_SILENT_CALM_S; sound after a gap starts the reading afresh', () => {
  const tracker = createMoodTracker();
  let t = listen(tracker, beatTrack(BREAKS), 20);
  assert.equal(tracker.mood, 'energetic');
  const quietFrom = t;
  let calmAt = Number.NaN;
  t = listen(tracker, silence, 8, {
    from: t,
    each: (now, m) => {
      if (Number.isNaN(calmAt) && m.mood === 'calm') calmAt = now;
      if (Number.isNaN(calmAt)) assert.equal(m.mood, 'energetic', `${(now - quietFrom).toFixed(2)} s into the silence`);
    },
  });
  assert.ok(calmAt - quietFrom >= MOOD_SILENT_CALM_S - 0.05 && calmAt - quietFrom < MOOD_SILENT_CALM_S + 0.2,
    `calm ${(calmAt - quietFrom).toFixed(2)} s into the silence`);
  assert.equal(tracker.stats.restarts, 0);
  // Sound again: the reading starts afresh (calm stays until it is ready,
  // then the beat decides at once).
  t = listen(tracker, beatTrack(BREAKS), 12, { from: t });
  assert.equal(tracker.stats.restarts, 1);
  assert.equal(tracker.mood, 'energetic');
});

test('a very quiet passage of a few seconds keeps the word and does not start the reading afresh', () => {
  assert.ok(MOOD_SILENCE_DB <= MOOD_QUIET_DB - 20);
  const tracker = createMoodTracker();
  let t = listen(tracker, beatTrack(BREAKS), 20);
  assert.equal(tracker.mood, 'energetic');
  // Three seconds at -60 dBFS: quiet (a gap, the word held), but not silence.
  let wasQuiet = false;
  t = listen(tracker, faint, 3, {
    from: t,
    each: (now, m, sound) => {
      assert.ok(sound.levelDb < MOOD_QUIET_DB && sound.levelDb > MOOD_SILENCE_DB, String(sound.levelDb));
      assert.equal(m.mood, 'energetic');
      wasQuiet ||= m.quiet;
    },
  });
  assert.equal(wasQuiet, true, 'a gap: the word is held');
  t = listen(tracker, beatTrack(BREAKS), 10, { from: t, each: (now, m) => assert.equal(m.mood, 'energetic') });
  assert.equal(tracker.stats.restarts, 0, 'no restart');
  assert.equal(tracker.ready, true);
});

test('silence of a few seconds inside a stream keeps the word and starts the reading afresh; a short one does neither', () => {
  const tracker = createMoodTracker();
  let t = listen(tracker, beatTrack(BREAKS), 20);
  assert.equal(tracker.mood, 'energetic');
  // One second of silence: no restart, the word stays.
  t = listen(tracker, silence, 1, { from: t });
  t = listen(tracker, beatTrack(BREAKS), 10, { from: t, each: (now, m) => assert.equal(m.mood, 'energetic') });
  assert.equal(tracker.stats.restarts, 0);
  // Three seconds (longer than MOOD_GAP_S, shorter than the calm one).
  assert.ok(MOOD_GAP_S < 3 && MOOD_SILENT_CALM_S > 3);
  t = listen(tracker, silence, 3, { from: t, each: (now, m) => assert.equal(m.mood, 'energetic') });
  const back = t;
  t = listen(tracker, beatTrack(BREAKS), 10, { from: t, each: (now, m) => assert.equal(m.mood, 'energetic') });
  assert.equal(tracker.stats.restarts, 1);
  assert.equal(tracker.ready, true);
  assert.ok(t - back >= MOOD_HOLD_S);
});

test('silence is not what the next sound rises from: no burst of onsets when the sound comes back', () => {
  const plain = createMoodTracker();
  listen(plain, beatTrack(BREAKS), 12);
  const gapped = createMoodTracker();
  let t = listen(gapped, beatTrack(BREAKS), 4);
  t = listen(gapped, silence, 0.5, { from: t });
  listen(gapped, beatTrack({ ...BREAKS, seed: 5 }), 7.5, { from: t });
  assert.ok(gapped.reading.onset < plain.reading.onset * 1.25, `${gapped.reading.onset} against ${plain.reading.onset}`);
  // The silent steps are not part of the top bands' spread either.
  assert.ok(Math.abs(gapped.reading.sway - plain.reading.sway) < 1.5, `${gapped.reading.sway} against ${plain.reading.sway}`);
  assert.equal(gapped.stats.restarts, 0);
});

test('the spaces between the hits of a sparse beat with nothing under it are no gap', () => {
  // Kick, snare and hats only: the sound falls to nothing between hits.
  let state = 3;
  let last = 0;
  const sparse = (t) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 1073741824 - 1;
    const bright = noise - last;
    last = noise;
    const beat = t % 1;
    return 0.6 * (kickStroke(beat) + snareStroke((t + 0.5) % 1, bright) + hatStroke(t % 0.5, bright));
  };
  const tracker = createMoodTracker();
  listen(tracker, sparse, 20);
  assert.equal(tracker.stats.restarts, 0);
  assert.equal(tracker.quiet, false);
  assert.notEqual(tracker.mood, 'calm');
});

/* ---- The parts ---- */

test('autocorrelation and the best beat: a beat every half second reads 120, one a second 60', () => {
  const env = new Float64Array(240);
  const acf = new Float64Array(124);
  const beat = { bpm: 0, pulse: 0 };
  for (let i = 0; i < env.length; i += 1) env[i] = i % 15 === 0 ? 4 : 0;
  autocorrelate(env, env.length, acf);
  assert.ok(Math.abs(acf[0] - 1) < 1e-9);
  assert.ok(acf[15] > 0.9 && acf[7] < 0.1, `${acf[15]} ${acf[7]}`);
  bestBeat(acf, MOOD_GRID_HZ, beat);
  assert.ok(Math.abs(beat.bpm - 120) < 1, String(beat.bpm));
  assert.ok(beat.pulse > 0.9);
  for (let i = 0; i < env.length; i += 1) env[i] = i % 30 === 0 ? 4 : 0;
  bestBeat(autocorrelate(env, env.length, acf), MOOD_GRID_HZ, beat);
  assert.ok(Math.abs(beat.bpm - 60) < 1, `one a second: ${beat.bpm}`);
  // A strong beat with a weaker one between (kick and snare): the faster
  // pulse, not half of it.
  for (let i = 0; i < env.length; i += 1) env[i] = i % 30 === 0 ? 4 : (i % 30 === 15 ? 3 : 0);
  bestBeat(autocorrelate(env, env.length, acf), MOOD_GRID_HZ, beat);
  assert.ok(Math.abs(beat.bpm - 120) < 1, `kick and snare: ${beat.bpm}`);
  // Nothing repeats: no pulse.
  env.fill(1);
  bestBeat(autocorrelate(env, env.length, acf), MOOD_GRID_HZ, beat);
  assert.equal(beat.pulse, 0);
});

test('the tempo reading keeps its octave, switches only after several readings agree, and says when it is not sure', () => {
  const reader = createTempoReader();
  const feed = (bpm, pulse = 0.5) => reader.update({ bpm, pulse }, 2);
  for (let i = 0; i < TEMPO_KEEP; i += 1) feed(120);
  assert.equal(reader.sure, true);
  assert.ok(Math.abs(reader.bpm - 120) < 0.5);
  // Octave readings (double, half, a third more) keep 120.
  for (const bpm of [240, 60, 180, 120, 60]) feed(bpm);
  assert.ok(Math.abs(reader.bpm - 120) < 1, String(reader.bpm));
  assert.equal(reader.sure, true);
  // A new tempo takes over only after TEMPO_SWITCH readings in a row.
  for (let i = 0; i < TEMPO_SWITCH - 1; i += 1) feed(100);
  assert.ok(Math.abs(reader.bpm - 120) < 1, 'not yet');
  feed(100);
  assert.ok(Math.abs(reader.bpm - 100) < 1, 'now');
  // Readings all over the place: not sure.
  const wild = createTempoReader();
  for (const bpm of [70, 133, 91, 157, 104, 77, 141, 112, 86, 166]) wild.update({ bpm, pulse: 0.5 }, 2);
  assert.equal(wild.sure, false);
  // A weak pulse or no onsets: not sure.
  const weak = createTempoReader();
  for (let i = 0; i < TEMPO_KEEP; i += 1) weak.update({ bpm: 120, pulse: 0.05 }, 2);
  assert.equal(weak.sure, false);
  const still = createTempoReader();
  for (let i = 0; i < TEMPO_KEEP; i += 1) still.update({ bpm: 120, pulse: 0.9 }, 0.1);
  assert.equal(still.sure, false);
  reader.reset();
  assert.equal(reader.bpm, 0);
  assert.equal(reader.sure, false);
});

test('the tempo reading on synthetic beats: sure, steady, and in one octave throughout', () => {
  // [track, its beat, the octaves it may be read in]: hats on the eighths of
  // a slow beat are a pulse of their own at twice the tempo.
  for (const [track, bpm, octaves] of [
    [beatTrack({ bpm: 120, hats: 2 }), 120, [1]],
    [beatTrack(HOUSE), 128, [1]],
    [beatTrack(BREAKS), 174, [1, 0.5]],
    [beatTrack({ bpm: 90, hats: 2 }), 90, [1, 2]],
  ]) {
    const tracker = createMoodTracker();
    let sureFrames = 0;
    let frames = 0;
    const read = new Set();
    listen(tracker, track, 40, {
      each: (now, m) => {
        if (now < 15) return;
        frames += 1;
        if (!m.tempo.sure) return;
        sureFrames += 1;
        const octave = octaves.find((factor) => Math.abs(m.tempo.bpm / (bpm * factor) - 1) < 0.03);
        read.add(octave ?? m.tempo.bpm);
      },
    });
    assert.ok(sureFrames / frames > 0.9, `${bpm}: sure ${sureFrames} of ${frames}`);
    assert.equal(read.size, 1, `${bpm}: read as ${[...read].join(', ')}`);
    assert.ok(octaves.includes([...read][0]), `${bpm}: read ${tracker.tempo.bpm}`);
  }
  const pad = createMoodTracker();
  listen(pad, padTrack(), 30);
  assert.equal(pad.tempo.sure, false, 'no drums: not sure');
});

test('peaks a second: over the floor and over the window\'s own spread, two steps apart', () => {
  const values = new Float64Array(60);
  const scratch = new Float64Array(60);
  for (let i = 0; i < 60; i += 1) values[i] = i % 6 === 3 ? MOOD_BUSY_RISE_DB + 1 : 0.2;
  assert.equal(peaksPerSecond(values, 60, 30, MOOD_BUSY_RISE_DB, scratch), 5);
  // The same shape, under the floor: none.
  for (let i = 0; i < 60; i += 1) values[i] = i % 6 === 3 ? MOOD_BUSY_RISE_DB - 1 : 0.2;
  assert.equal(peaksPerSecond(values, 60, 30, MOOD_BUSY_RISE_DB, scratch), 0);
  assert.equal(peaksPerSecond(values, 2, 30, 0, scratch), 0);
  // The median does not depend on the order (it is found in place).
  for (let i = 0; i < 60; i += 1) values[i] = ((i * 37) % 60) / 10;
  const median = [...values].sort((a, b) => a - b)[30];
  const line = median + values.reduce((sum, value) => sum + Math.abs(value - median), 0) / 60;
  let expected = 0;
  let last = -2;
  for (let i = 1; i < 59; i += 1) {
    if (values[i] > line && values[i] > values[i - 1] && values[i] >= values[i + 1] && i - last >= 2) { expected += 1; last = i; }
  }
  assert.equal(peaksPerSecond(values, 60, 30, 0, scratch), (expected * 30) / 60);
});

test('busy is made up for the hits that fall between frames: nearly none at 60 frames a second, more the further apart they come', () => {
  assert.ok(hitsSeen(1 / 60) > 0.99);
  assert.ok(hitsSeen(1 / 30) > hitsSeen(1 / 20) && hitsSeen(1 / 20) > hitsSeen(1 / 15));
  assert.ok(hitsSeen(1 / 15) > 0.6 && hitsSeen(1 / 15) < 0.8, String(hitsSeen(1 / 15)));
  assert.equal(hitsSeen(0), 1);
});

test('the energy rises with each part and is never outside 0..1', () => {
  const base = { onset: 1, busy: 6, pulse: 0.4, bright: -60, sway: 7 };
  assert.equal(moodEnergy({ onset: 0, busy: 0, pulse: 0, bright: -90, sway: 20 }), 0);
  assert.equal(moodEnergy({}), 0, 'no reading: no energy');
  assert.ok(moodEnergy({ onset: 10, busy: 20, pulse: 1, bright: -30, sway: 0 }) <= 1);
  assert.ok(moodEnergy({ ...base, onset: 1.3 }) > moodEnergy(base), 'onset');
  assert.ok(moodEnergy({ ...base, busy: 8 }) > moodEnergy(base), 'busy');
  assert.ok(moodEnergy({ ...base, pulse: 0.6 }) > moodEnergy(base), 'pulse');
  assert.ok(moodEnergy({ ...base, bright: -50 }) > moodEnergy(base), 'bright');
  assert.ok(moodEnergy({ ...base, bright: -40, sway: 3 }) > moodEnergy({ ...base, bright: -40 }), 'less sway');
  // Busy under MOOD_BUSY_FROM adds nothing: hats on the sixteenths of a slow
  // beat are not pace.
  assert.equal(moodParts({ ...base, busy: MOOD_BUSY_FROM }).pace, 0);
  // The weights: a full wall alone is energetic, full drive and shine alone
  // are not.
  assert.ok(MOOD_WEIGHTS.wall > MOOD_ENERGETIC_ABOVE);
  assert.ok(MOOD_WEIGHTS.drive + MOOD_WEIGHTS.shine < MOOD_ENERGETIC_LEAVE);
});

test('the frame path builds no strings and no arrays: no template strings, subarray or sort in the mood', () => {
  const source = readFileSync('src/visualizer/mood.js', 'utf8');
  assert.equal(source.includes('${'), false, 'no template strings');
  assert.equal(source.includes('.subarray('), false);
  assert.equal(source.includes('.sort('), false);
  // The tracker's arrays are all made when it is created; nothing from its
  // first function on (the frame path and the window's evaluation) makes one.
  const tracker = source.slice(source.indexOf('export function createMoodTracker'));
  const body = tracker.slice(tracker.indexOf('function prepareBins'));
  assert.equal(/new [A-Z]|\[\]|\{\s*\}/.test(body), false, 'nothing made on the frame path');
});
