import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUILD_DRIFT_BOOST, DROP_COOLDOWN_BARS, SONG_STRUCTURE_RELEASED, createStructureDetector, structureDriftScale,
} from '../src/visualizer/structure.js';
import { createShuffleTimer, SHUFFLE_MIN_DWELL_S } from '../src/visualizer/shuffle.js';
import { WARP_DISSOLVE_RELEASED, WARP_DISSOLVE_SHADER, warpWeight } from '../src/visualizer/warp-dissolve.js';
import { createMoodTracker } from '../src/visualizer/mood.js';
import { beatTrack, listen } from './helpers/mood-sim.js';

/* Song structure on synthetic level curves: 120 bpm, 60 frames a second,
   one level (dB) per bar, or a function of (bar, beat in bar). */

function run(levels, { detector = createStructureDetector(), wobble = null } = {}) {
  const level = typeof levels === 'function' ? levels : (bar) => levels[Math.min(levels.length - 1, bar)];
  const bars = typeof levels === 'function' ? 64 : levels.length;
  const drops = [];
  const building = [];
  for (let frame = 0; frame < bars * 2 * 60; frame += 1) {
    const beats = frame / 30; // 120 bpm
    const bar = Math.floor(beats / 4);
    const db = level(bar, beats - bar * 4) + (wobble ? wobble(frame) : 0);
    if (detector.step(beats, db) === 'drop') drops.push(beats);
    if (detector.building) building.push(bar);
  }
  return { detector, drops, building: [...new Set(building)] };
}

const flat = (n, db) => Array(n).fill(db);

test('a steady level, or one that only wobbles, is neither a build nor a drop', () => {
  assert.deepEqual(run(flat(40, -12)).drops, []);
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const wobbly = run(flat(200, -12), { wobble: () => (random() - 0.5) * 3 });
  assert.deepEqual(wobbly.drops, []);
  assert.deepEqual(wobbly.building, []);
});

test('a build over several bars, then the drop on the first beat of the bar it lands on', () => {
  // 8 bars at -18, rising 2 dB a bar for 6 bars, then the drop at -2.
  const levels = [...flat(8, -18), -16, -14, -12, -10, -8, -6, ...flat(10, -2)];
  const { drops, building, detector } = run(levels);
  assert.ok(building.length >= 2, 'noticed while it rises');
  assert.ok(Math.min(...building) <= 13);
  assert.equal(drops.length, 1);
  const dropBar = levels.indexOf(-2);
  // A drop no louder than the build's last bar by DROP_JUMP_DB is not told
  // from the build going on.
  assert.deepEqual(run([...flat(8, -18), -16, -14, -12, -10, -8, -6, ...flat(10, -5)]).drops, []);
  assert.ok(drops[0] >= dropBar * 4 + 1 && drops[0] < dropBar * 4 + 1.1, `judged as its first beat ends: ${drops[0]}`);
  assert.equal(detector.building, false);
  assert.equal(detector.stats.builds, 1);
});

test('a break, then the sudden full return is a drop; a gradual return is not', () => {
  const sudden = run([...flat(8, -10), ...flat(4, -26), ...flat(8, -10)]);
  assert.equal(sudden.drops.length, 1);
  assert.ok(sudden.drops[0] >= 12 * 4 && sudden.drops[0] < 12 * 4 + 1.1);
  const gradual = run([...flat(8, -10), ...flat(4, -26), -24, -22, -20, -18, -16, -14, -12, -10, ...flat(6, -10)]);
  assert.deepEqual(gradual.drops, []);
  // Back only half way: not a full return.
  assert.deepEqual(run([...flat(8, -10), ...flat(4, -26), ...flat(8, -19)]).drops, []);
});

test('a drop lands mid-bar is judged on the bar line only; none again within the cool-down', () => {
  // The return comes on the third beat: the bar's first beat is still quiet.
  const late = run((bar, beat) => (bar < 8 ? -10 : bar < 12 ? -26 : bar === 12 && beat < 2 ? -26 : -10));
  assert.ok(late.drops.every((at) => Math.abs(at / 4 - Math.round(at / 4)) < 0.3), 'on a bar line');
  // Two breaks close together: the second return is in the cool-down.
  const twice = run([...flat(8, -10), ...flat(2, -26), ...flat(2, -10), ...flat(2, -26), ...flat(10, -10)]);
  assert.equal(twice.drops.length, 1);
  assert.ok(DROP_COOLDOWN_BARS >= 4);
});

test('no sure tempo, or a clock that goes back, starts afresh', () => {
  const detector = createStructureDetector();
  run([...flat(8, -10), ...flat(3, -26)], { detector });
  assert.equal(detector.armed, true);
  detector.step(Number.NaN, -10);
  assert.equal(detector.armed, false);
  run([...flat(8, -10), ...flat(3, -26)], { detector });
  detector.step(2, -10); // the clock went back
  assert.equal(detector.armed, false);
  assert.equal(detector.step(Number.POSITIVE_INFINITY, -10), null);
});

test('the build deepens drift a little, never past the most measured', () => {
  assert.equal(structureDriftScale(1, 0, 1.6), 1);
  assert.equal(structureDriftScale(1, 1, 2), 1 + BUILD_DRIFT_BOOST);
  assert.equal(structureDriftScale(1.5, 1, 1.6), 1.6);
  assert.equal(structureDriftScale(1.7, 1, 1.6), 1.7, 'never lowered');
  assert.equal(structureDriftScale(1, 1, Number.NaN), 1);
});

test('a drop brings the shuffle change forward only after the minimum time, and never adds one', () => {
  const timer = createShuffleTimer({ bars: 32 });
  for (let t = 0; t < SHUFFLE_MIN_DWELL_S - 1; t += 0.25) timer.step(t, t * 2, 0.9);
  assert.equal(timer.bringForward(), false, 'too soon');
  assert.equal(timer.due, false);
  for (let t = SHUFFLE_MIN_DWELL_S - 1; t < SHUFFLE_MIN_DWELL_S + 1; t += 0.25) timer.step(t, t * 2, 0.9);
  assert.equal(timer.bringForward(), true);
  assert.equal(timer.due, true);
  assert.equal(timer.bringForward(), false, 'already due: nothing extra');
  timer.restart();
  assert.equal(timer.bringForward(), false, 'a new scene starts its minimum time again');
});

test('fed the mood\'s own beat count, a steady beat is neither a build nor a drop', () => {
  // A minute of a steady dance beat read as the page reads it; the bar clock
  // runs only while the mood's tempo reading is sure.
  const mood = createMoodTracker();
  const detector = createStructureDetector();
  const drops = [];
  let built = false;
  let counted = 0;
  listen(mood, beatTrack({ bpm: 128, hats: 4, kicks: [0, 1, 2, 3] }), 60, {
    each: (now, m, sound) => {
      if (Number.isFinite(m.beats)) counted += 1;
      if (detector.step(m.beats, sound.levelDb) === 'drop') drops.push(now);
      built ||= detector.building;
    },
  });
  assert.ok(counted > 30 * 40, `the clock ran ${counted} frames`);
  assert.deepEqual(drops, []);
  assert.equal(built, false);
});

test('the mood\'s beat count: none while its tempo is not sure, then beats at the tempo read', () => {
  const mood = createMoodTracker();
  assert.ok(Number.isNaN(mood.beats));
  let first = Number.NaN;
  let from = 0;
  listen(mood, beatTrack({ bpm: 120, hats: 2 }), 30, {
    each: (now, m) => {
      if (Number.isNaN(first) && Number.isFinite(m.beats)) { first = m.beats; from = now; }
    },
  });
  assert.equal(mood.tempo.sure, true);
  const rate = (mood.beats - first) / (30 - 1 / 30 - from);
  assert.ok(Math.abs(rate - mood.tempo.bpm / 60) < 0.05, `${rate} beats a second at ${mood.tempo.bpm}`);
  mood.reset();
  assert.ok(Number.isNaN(mood.beats));
});

test('held: nothing steers until released; the warped dissolve is a convex mix, held and not wired', () => {
  assert.equal(SONG_STRUCTURE_RELEASED, false);
  const viz = readFileSync('src/visualizer/index.js', 'utf8');
  assert.match(viz, /const structure = SONG_STRUCTURE_RELEASED \? createStructureDetector\(\) : null;/);
  assert.match(viz, /structure\.step\(mood\.beats, bridge\.adapter\.levelDb\)/, 'the bar clock is the mood\'s beat count');
  assert.match(viz, /if \(structureEvent === 'drop' && shuffleOn && started && !lost\) shuffleTimer\.bringForward\(\);/);
  assert.equal(WARP_DISSOLVE_RELEASED, false);
  assert.doesNotMatch(viz, /warp-dissolve/);
  assert.match(WARP_DISSOLVE_SHADER, /FRAG_OUT = vec4\(mix\(from, to, w\), 1\.0\);/);
  for (const n of [0.1, 0.5, 0.9]) {
    let before = 0;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const w = warpWeight(p, n);
      assert.ok(w >= before - 1e-12 && w >= 0 && w <= 1, `${n} ${p}`);
      before = w;
    }
    assert.equal(warpWeight(0, n), 0);
    assert.equal(warpWeight(1, n), 1);
  }
});
