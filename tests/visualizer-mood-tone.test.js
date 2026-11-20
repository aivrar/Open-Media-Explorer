import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createMoodTracker, moodEnergy } from '../src/visualizer/mood.js';
import {
  MOOD_TONE_RELEASED, TONE_EVERY_S, createToneTracker, measureTone,
} from '../src/visualizer/tone.js';
import { TONE_WEIGHT, createShuffle, seededRandom, toneWeight } from '../src/visualizer/shuffle.js';

/* The mood's fault on a slow beat, and the tone beside it. */

/** Play a pattern through a tracker at 60 frames a second: `hits(t)` gives
 *  the channels struck in the frame at t (a stroke lasts 30 ms). */
function play(tracker, seconds, { bpm, confidence = 0.9, strokes }) {
  const sound = { kick: 0, snare: 0, hat: 0, level: 0.5, confidence, bpm };
  const hits = strokes(bpm);
  for (let frame = 0; frame <= seconds * 60; frame += 1) {
    const t = frame / 60;
    for (const name of ['kick', 'snare', 'hat']) {
      sound[name] = hits[name].some((at) => t >= at && t < at + 0.03) ? 1 : 0;
    }
    tracker.step(t, sound);
  }
  return tracker;
}

/** A steady beat: kicks on 1 and 3, snares on 2 and 4, hats `per` to the
 *  beat; every kick and snare also crosses the hat band (broadband). */
const beat = (seconds, per) => (bpm) => {
  const step = 60 / bpm;
  const kick = [];
  const snare = [];
  const hat = [];
  for (let b = 0; b * step < seconds; b += 1) {
    (b % 2 === 0 ? kick : snare).push(b * step);
    for (let s = 0; s < per; s += 1) hat.push(b * step + (s * step) / per);
  }
  // Broadband: the kick also lights the snare band.
  return { kick, snare: [...snare, ...kick], hat };
};

test('a slow steady beat reads calm or steady, not energetic (it used to)', () => {
  for (const per of [2, 4]) {
    for (const bpm of [60, 120]) { // 120: a reactor that heard double time
      const tracker = play(createMoodTracker(), 60, { bpm: 60, strokes: beat(60, per) });
      if (bpm === 120) play(tracker, 30, { bpm, strokes: beat(30, per) });
      assert.notEqual(tracker.mood, 'energetic', `hats ${per} a beat, bpm read ${bpm}: ${tracker.energy}`);
    }
  }
  const sparse = play(createMoodTracker(), 60, { bpm: 60, strokes: beat(60, 2) });
  assert.equal(sparse.mood, 'calm', String(sparse.energy));
});

test('a fast busy beat still reads energetic', () => {
  const tracker = play(createMoodTracker(), 60, { bpm: 128, strokes: beat(60, 4) });
  assert.equal(tracker.mood, 'energetic', String(tracker.energy));
  assert.ok(moodEnergy(6, 0.9, 128) > 0.65);
  assert.ok(moodEnergy(1, 1, 60) < 0.05, 'one hit a second at 60 bpm adds nothing');
});

test('one broadband stroke is one hit', () => {
  const all = (seconds) => () => {
    const times = Array.from({ length: seconds }, (_, i) => i);
    return { kick: times, snare: times, hat: times };
  };
  const kickOnly = (seconds) => () => ({ kick: Array.from({ length: seconds }, (_, i) => i), snare: [], hat: [] });
  const a = play(createMoodTracker(), 20, { bpm: 60, strokes: all(20) });
  const b = play(createMoodTracker(), 20, { bpm: 60, strokes: kickOnly(20) });
  assert.equal(a.energy, b.energy);
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
