import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOOD_CALM_BELOW, MOOD_ENERGETIC_ABOVE, MOOD_ENERGETIC_LEAVE, moodEnergy,
} from '../src/visualizer/mood.js';

/* The mood's readings on real music, as numbers: for each class of music,
   the median of each reading over three minutes of a radio stream playing
   it (8 s windows, read every half second at 30 frames a second, the first
   8 s left out), and for the calm ones the 10th to 90th percentile of each.
   Taken from the streams the rule was chosen on (one stream a class); they
   pin the rule, so that a change to it that moves one of these to another
   word shows here. They do not say every stream of a class reads its word:
   a second trance stream (a darker mix at a house tempo) and a second metal
   stream (a darker mix) read mostly steady. */

const word = (energy) => {
  if (energy < MOOD_CALM_BELOW) return 'calm';
  return energy > MOOD_ENERGETIC_ABOVE ? 'energetic' : 'steady';
};

const CLASSES = [
  ['ambient drone', 'calm', {
    onset: 0.99, busy: 0.41, pulse: 0.05, bright: -59.63, sway: 4.74,
  }],
  ['orchestral classical', 'calm', {
    onset: 1.25, busy: 1.09, pulse: 0.18, bright: -53.26, sway: 4.43,
  }],
  ['smooth jazz', 'steady', {
    onset: 1.75, busy: 2.45, pulse: 0.54, bright: -48.69, sway: 6.35,
  }],
  ['chart pop', 'steady', {
    onset: 1.58, busy: 2.72, pulse: 0.23, bright: -42.18, sway: 6.11,
  }],
  ['eclectic rock', 'steady', {
    onset: 2.4, busy: 4.89, pulse: 0.3, bright: -50.02, sway: 8.66,
  }],
  ['deep house', 'steady', {
    onset: 2.03, busy: 4.21, pulse: 0.72, bright: -40.56, sway: 5.56,
  }],
  ['hip hop', 'steady', {
    onset: 2.21, busy: 4.76, pulse: 0.25, bright: -46.41, sway: 6.38,
  }],
  ['trance', 'energetic', {
    onset: 1.29, busy: 0.95, pulse: 0.3, bright: -38.9, sway: 2.19,
  }],
  ['drum and bass', 'energetic', {
    onset: 1.8, busy: 7.2, pulse: 0.62, bright: -45.19, sway: 6.57,
  }],
  ['metal', 'energetic', {
    onset: 1.25, busy: 1.5, pulse: 0.24, bright: -38.5, sway: 2.32,
  }],
  ['hard techno', 'energetic', {
    onset: 1.54, busy: 2.45, pulse: 0.15, bright: -37.62, sway: 4.4,
  }],
];

/** The calm classes' 10th and 90th percentiles of each reading. */
const CALM_RANGES = [
  ['ambient drone', {
    onset: [0.86, 1.16], busy: [0.14, 1.36], pulse: [0, 0.12], bright: [-66.57, -55.53], sway: [2.94, 8.33],
  }],
  ['orchestral classical', {
    onset: [1.08, 1.58], busy: [0.14, 2.17], pulse: [0.05, 0.56], bright: [-56.71, -50.12], sway: [3.36, 8.33],
  }],
];

test('the streams the rule was chosen on read their class\'s word at their median reading', () => {
  for (const [name, expected, reading] of CLASSES) {
    const energy = moodEnergy(reading);
    assert.equal(word(energy), expected, `${name}: energy ${energy.toFixed(2)}`);
  }
});

test('calm music is never energetic anywhere in its usual range', () => {
  for (const [name, ranges] of CALM_RANGES) {
    const keys = Object.keys(ranges);
    // Every corner of the ranges (each reading at its low or its high end).
    for (let corner = 0; corner < 2 ** keys.length; corner += 1) {
      const reading = {};
      keys.forEach((key, index) => { reading[key] = ranges[key][(corner >> index) & 1]; });
      const energy = moodEnergy(reading);
      assert.ok(energy < MOOD_ENERGETIC_LEAVE, `${name} ${JSON.stringify(reading)}: ${energy.toFixed(2)}`);
    }
  }
});

test('those streams keep their order: calm under steady under energetic', () => {
  const by = { calm: [], steady: [], energetic: [] };
  for (const [, expected, reading] of CLASSES) by[expected].push(moodEnergy(reading));
  assert.ok(Math.max(...by.calm) < Math.min(...by.steady));
  assert.ok(Math.max(...by.steady) < Math.min(...by.energetic));
});
