import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MOOD_ENERGETIC_ABOVE, createMoodTracker, moodEnergy } from '../src/visualizer/mood.js';
import {
  MOOD_TONE_RELEASED, TONE_EVERY_S, createToneTracker, measureTone,
} from '../src/visualizer/tone.js';
import { TONE_WEIGHT, createShuffle, seededRandom, toneWeight } from '../src/visualizer/shuffle.js';
import {
  beatTrack, hatStroke, kickStroke, listen, snareStroke,
} from './helpers/mood-sim.js';

/* The mood's fault on a slow beat, and the tone beside it. The music is
   synthetic, put through a software analyser as the page's tap reads it
   (helpers/mood-sim.js). */

/** The tracker after `seconds` of `track`, and its highest energy over the
 *  second half. */
function play(track, seconds) {
  const tracker = createMoodTracker();
  let highest = 0;
  listen(tracker, track, seconds, { each: (now, m) => { if (now >= seconds / 2) highest = Math.max(highest, m.energy); } });
  return { tracker, highest };
}

test('a slow steady beat reads calm or steady, not energetic (it used to)', () => {
  // 60 bpm, kick and snare in turn, hats on the sixteenths or the eighths:
  // the hats subdivide the beat, they do not make it fast.
  for (const hats of [4, 2]) {
    const { tracker, highest } = play(beatTrack({ bpm: 60, hats }), 40);
    assert.notEqual(tracker.mood, 'energetic', `hats ${hats} a beat: ${tracker.energy}`);
    assert.ok(highest <= MOOD_ENERGETIC_ABOVE, `hats ${hats} a beat: up to ${highest}`);
  }
});

test('a fast busy beat still reads energetic: four to the floor at 128 and 140 bpm, a breakbeat at 174', () => {
  // Four to the floor with hats on the sixteenths, at a house tempo (128)
  // and faster (140), and a breakbeat with hats on the sixteenths.
  for (const bpm of [128, 140]) {
    const dance = play(beatTrack({ bpm, hats: 4, kicks: [0, 1, 2, 3] }), 40).tracker;
    assert.equal(dance.mood, 'energetic', `${bpm} bpm: ${dance.energy}`);
  }
  const breaks = play(beatTrack({ bpm: 174, hats: 4, kicks: [0, 2.5] }), 40).tracker;
  assert.equal(breaks.mood, 'energetic', String(breaks.energy));
  assert.ok(moodEnergy({ onset: 4, busy: 9, pulse: 0.6, bright: -57, sway: 11 }) > MOOD_ENERGETIC_ABOVE);
  assert.ok(moodEnergy({ onset: 0, busy: 0, pulse: 0 }) === 0, 'nothing starting: no energy');
});

test('one broadband stroke is one busy onset', () => {
  // Once a second, a stroke on every band at once (kick, snare and hat
  // together): one onset in the high bands a second, not three.
  let state = 9;
  let last = 0;
  const stroke = (t) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 1073741824 - 1;
    const bright = noise - last;
    last = noise;
    const age = t % 1;
    return 0.6 * (kickStroke(age) + snareStroke(age, bright) + hatStroke(age, bright) + 0.12 * Math.sin(2 * Math.PI * 55 * t));
  };
  const { tracker } = play(stroke, 20);
  assert.ok(Math.abs(tracker.reading.busy - 1) < 0.3, String(tracker.reading.busy));
});

/* ---- Tone ---- */

/** A dB spectrum (1024 bins at 48 kHz / 2048) with power falling off from
 *  `peakHz`. */
function spectrum(peakHz, { levelDb = -30 } = {}) {
  const db = new Float32Array(1024);
  for (let i = 0; i < db.length; i += 1) {
    const hz = (i * 48000) / 2048;
    db[i] = levelDb - 20 * Math.abs(Math.log2((hz + 1) / peakHz));
  }
  return db;
}

test('tone: bright, dark and bass-heavy spectra', () => {
  const out = {};
  assert.equal(measureTone(spectrum(6000), 48000, 2048, out), true);
  const bright = { ...out };
  measureTone(spectrum(150), 48000, 2048, out);
  const dark = { ...out };
  assert.ok(bright.brightness > 0.7, String(bright.brightness));
  assert.ok(dark.brightness < 0.3, String(dark.brightness));
  assert.ok(dark.weight > 0.8 && bright.weight < 0.1);
  assert.equal(measureTone(new Float32Array(1024).fill(-120), 48000, 2048, out), false, 'silence: no tone');
  assert.equal(measureTone(null, 48000, 2048, out), false);
});

test('tone: smoothed over seconds, worked out a few times a second, swell from level moving over bars', () => {
  const steady = createToneTracker();
  const swelling = createToneTracker();
  const analysis = (db) => ({ active: true, spectrumDb: db, sampleRate: 48000, fftSize: 2048 });
  const loud = spectrum(800, { levelDb: -20 });
  const soft = spectrum(800, { levelDb: -34 });
  for (let frame = 0; frame < 60 * 60; frame += 1) {
    const t = frame / 60;
    steady.step(t, analysis(loud));
    // Swells and drops every four seconds.
    swelling.step(t, analysis(Math.floor(t / 4) % 2 ? soft : loud));
  }
  assert.ok(steady.stats.measured <= 60 / TONE_EVERY_S + 1);
  assert.ok(steady.tone.swell < 0.05, String(steady.tone.swell));
  assert.ok(swelling.tone.swell > 0.5, String(swelling.tone.swell));
  // A sudden change of tone is followed over seconds, not at once.
  const tracker = createToneTracker();
  for (let t = 0; t < 20; t += 1 / 60) tracker.step(t, analysis(spectrum(150)));
  const before = tracker.tone.brightness;
  const object = tracker.tone;
  for (let t = 20; t < 21; t += 1 / 60) tracker.step(t, analysis(spectrum(6000)));
  assert.ok(tracker.tone.brightness - before < 0.25, 'one second moves it only a little');
  assert.equal(tracker.tone, object, 'the same object, filled in again');
  // Nothing heard: nothing changes.
  const held = { ...tracker.tone };
  tracker.step(30, { active: false });
  assert.deepEqual({ ...tracker.tone }, held);
});

/* ---- The shuffle's lean ---- */

const SCENES = [
  { id: 'calm_cool', category: 'A', cost: 'light', mood: 'calm', hue: 'cool' },
  { id: 'lively_warm', category: 'B', cost: 'light', mood: 'lively', hue: 'warm' },
  { id: 'calm_warm', category: 'C', cost: 'light', mood: 'calm', hue: 'warm' },
  { id: 'lively_cool', category: 'D', cost: 'light', mood: 'lively', hue: 'cool' },
];
const DARK = { brightness: 0.1, weight: 0.9, swell: 0.3, ready: true };
const BRIGHT = { brightness: 0.9, weight: 0.2, swell: 0.6, ready: true };

test('the tone leans the weights gently, never to nothing', () => {
  for (const scene of SCENES) {
    for (const tone of [DARK, BRIGHT, { brightness: 0.5, weight: 0.5, swell: 0.5, ready: true }]) {
      const w = toneWeight(scene, tone);
      assert.ok(w >= 1 / (1 + TONE_WEIGHT) - 1e-9 && w <= 1 + TONE_WEIGHT + 1e-9, `${scene.id}: ${w}`);
    }
    assert.equal(toneWeight(scene, null), 1);
    assert.equal(toneWeight(scene, { ...DARK, ready: false }), 1);
  }
  assert.ok(toneWeight(SCENES[0], DARK) > 1 && toneWeight(SCENES[1], DARK) < 1);
  assert.ok(toneWeight(SCENES[1], BRIGHT) > 1 && toneWeight(SCENES[0], BRIGHT) < 1);
});

test('over many first picks, dark sound favours calm cool scenes and bright sound lively warm ones; every scene still comes up', () => {
  const count = (tone) => {
    const seen = new Map();
    for (let seed = 1; seed <= 2000; seed += 1) {
      const id = createShuffle({ scenes: SCENES, random: seededRandom(seed) }).next({ mood: 'steady', tone });
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    return seen;
  };
  const dark = count(DARK);
  const bright = count(BRIGHT);
  const none = count(null);
  assert.ok(dark.get('calm_cool') > none.get('calm_cool') * 1.2);
  assert.ok(bright.get('lively_warm') > none.get('lively_warm') * 1.2);
  for (const id of SCENES.map((s) => s.id)) assert.ok(dark.get(id) > 0 && bright.get(id) > 0, id);
});

test('held: tone is not tracked or used until released', () => {
  assert.equal(MOOD_TONE_RELEASED, false);
  const viz = readFileSync('src/visualizer/index.js', 'utf8');
  assert.match(viz, /const tone = MOOD_TONE_RELEASED \? createToneTracker\(\) : null;/);
  assert.match(viz, /tone\?\.step\(nowSec, bridge\.adapter\.analysis\);/);
  assert.match(viz, /poolContext\.tone = tone \? tone\.tone : null;/);
});
