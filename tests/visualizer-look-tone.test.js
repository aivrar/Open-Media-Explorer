import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOOK_BRIGHT_MEAN, LOOK_DARK_MEAN, darknessOf, lookDarknessModule, readSweep,
} from '../scripts/look_darkness.mjs';
import { LOOK_DARKNESS, lookDarkness } from '../src/visualizer/look-darkness.js';
import {
  LOOK_TONE_WEIGHT, createShuffle, lookToneWeight, seededRandom, toneDarkness, toneWeight,
} from '../src/visualizer/shuffle.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { MOOD_TONE_RELEASED } from '../src/visualizer/tone.js';

const SAMPLE = [
  'name\tid\tmean\tmax_step',
  'Plasma\tplasma\t0.30\t0.01',
  'Plasma: Night\tplasma#1\t0.05\t0.01',
  'Plasma: Day\tplasma#2\t0.62\t0.01',
  'Warp: Marble\tdomainwarp#0\t0.275\t0.01',
  'Warp\tdomainwarp\t0.5\t0.01',
  'broken\tnot an id\t0.3\t0',
  'unfinished\tvoronoi\t\t',
  '',
].join('\r\n');

test('the generator: darkness from the mean (a straight line, PROPOSED ends), the table read, bad rows skipped', () => {
  assert.equal(LOOK_DARK_MEAN, 0.05);
  assert.equal(LOOK_BRIGHT_MEAN, 0.5);
  assert.equal(darknessOf(0.01), 1);
  assert.equal(darknessOf(0.05), 1);
  assert.equal(darknessOf(0.275), 0.5);
  assert.equal(darknessOf(0.5), 0);
  assert.equal(darknessOf(0.9), 0);
  const { table, skipped } = readSweep(SAMPLE);
  assert.deepEqual(table, { plasma: { d: 0.44, 1: 1, 2: 0 }, domainwarp: { 0: 0.5, d: 0 } });
  assert.equal(skipped.length, 2);
  assert.throws(() => readSweep('a\tb\n1\t2'), /id and mean/);
});

test('the generated module: ASCII with CRLF, sorted, and it reads back what it was given', async () => {
  const { table } = readSweep(SAMPLE);
  const text = lookDarknessModule(table, { rows: 5 });
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/);
  assert.match(text, /plasma: \{ d: 0\.44, 1: 1, 2: 0 \},/);
  assert.ok(text.indexOf('domainwarp:') < text.indexOf('plasma:'), 'sorted');
  const mod = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.equal(mod.lookDarkness('plasma', 0), 0.44, 'look 0 starts it: its own row');
  assert.equal(mod.lookDarkness('plasma', 2), 0);
  assert.equal(mod.lookDarkness('domainwarp', 1, 1), 0, 'starting in its option 1: its own row');
  assert.equal(mod.lookDarkness('domainwarp', 1), undefined, 'otherwise not measured');
  assert.equal(mod.lookDarkness('voronoi', 0), undefined);
  assert.equal(mod.lookDarkness('constructor', 0), undefined);
});

test('the module in the tree: made by the generator, every offered scene in it, every value 0..1', () => {
  const text = readFileSync('src/visualizer/look-darkness.js', 'utf8');
  assert.match(text, /Made by\r\n \* scripts\/look_darkness\.mjs/);
  const rows = Object.values(LOOK_DARKNESS);
  const count = rows.reduce((n, row) => n + Object.keys(row).length, 0);
  assert.equal(lookDarknessModule(LOOK_DARKNESS, { source: 'the brightness sweep', rows: count }), text, 'exactly as the generator writes it');
  for (const entry of SCENES) assert.ok(LOOK_DARKNESS[entry.id], entry.id);
  for (const row of rows) for (const value of Object.values(row)) assert.ok(value >= 0 && value <= 1);
  assert.equal(lookDarkness('no_such_scene', 0), undefined);
});

const DARK = { ready: true, brightness: 0.1, weight: 0.9, swell: 0.5 };
const BRIGHT = { ready: true, brightness: 0.95, weight: 0.2, swell: 0.5 };

test('lookToneWeight: as dark as the sound weighs most, the opposite least, never 0; no tone or no darkness: 1', () => {
  assert.equal(lookToneWeight(0.5, null), 1);
  assert.equal(lookToneWeight(0.5, { ...DARK, ready: false }), 1);
  assert.equal(lookToneWeight(undefined, DARK), 1);
  const dark = toneDarkness(DARK);
  const bright = toneDarkness(BRIGHT);
  assert.ok(dark > 0.8 && bright < 0.1, `${dark} ${bright}`);
  assert.ok(lookToneWeight(1, DARK) > lookToneWeight(0, DARK));
  assert.ok(lookToneWeight(0, BRIGHT) > lookToneWeight(1, BRIGHT));
  for (const d of [0, 0.25, 0.5, 0.75, 1]) {
    for (const tone of [DARK, BRIGHT]) {
      const w = lookToneWeight(d, tone);
      assert.ok(w >= 1 / (1 + LOOK_TONE_WEIGHT) - 1e-12 && w <= 1 + LOOK_TONE_WEIGHT + 1e-12);
    }
  }
  // The scene weighting reads the same darkness as before.
  assert.equal(toneWeight({ mood: 'calm', hue: 'cool' }, DARK) > 1, true);
});

test('the shuffle\'s look: weighted by the tone, every look still chosen; without weights the same picks as before', () => {
  const darkness = { 0: 0.1, 1: 0.9, 2: 0.5 };
  const counts = { 0: 0, 1: 0, 2: 0 };
  const weighted = createShuffle({ scenes: SCENES, random: seededRandom(5) });
  for (let n = 0; n < 3000; n += 1) {
    counts[weighted.look(`s${n}`, [0, 1, 2], null, (number) => lookToneWeight(darkness[number], DARK))] += 1;
  }
  assert.ok(counts[1] > counts[2] && counts[2] > counts[0], JSON.stringify(counts));
  assert.ok(counts[0] > 300, 'a weighting, never a filter');
  // Not the one it had last time still holds.
  const again = createShuffle({ scenes: SCENES, random: seededRandom(9) });
  let before = again.look('plasma', [0, 1, 2], null, () => 1);
  for (let n = 0; n < 50; n += 1) {
    const next = again.look('plasma', [0, 1, 2], null, (number) => lookToneWeight(darkness[number], DARK));
    assert.notEqual(next, before);
    before = next;
  }
  const a = createShuffle({ scenes: SCENES, random: seededRandom(3) });
  const b = createShuffle({ scenes: SCENES, random: seededRandom(3) });
  for (let n = 0; n < 40; n += 1) assert.equal(a.look(`x${n % 5}`, [0, 1, 2, 3]), b.look(`x${n % 5}`, [0, 1, 2, 3], null, null));
});

test('held with the tone: the tab weighs looks only when the tone is on and ready', () => {
  assert.equal(MOOD_TONE_RELEASED, false);
  const index = readFileSync('src/visualizer/index.js', 'utf8');
  assert.match(index, /const toneNow = tone \? tone\.tone : null;/);
  assert.match(index, /const weightOf = toneNow\?\.ready \? \(number\) => lookToneWeight\(lookDarkness\(id, number, lookStart\), toneNow\) : null;/);
  assert.match(index, /const tone = MOOD_TONE_RELEASED \? createToneTracker\(\) : null;/);
});
