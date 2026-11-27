import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { wheelSteps } from '../src/modes/tuner.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the wheel scrolls the list and turns the dial only over its rim', async () => {
  const tuner = await read('src/modes/tuner.js');
  const list = await read('src/modes/tuner-station-list.js');
  assert.match(tuner, /wrap\.addEventListener\('wheel', onWheel, \{ passive: false \}\);/);
  assert.match(list, /list\.addEventListener\('scroll'/);
  assert.doesNotMatch(list, /addEventListener\('wheel'/);
  const onWheel = tuner.match(/function onWheel\(e\) \{[\s\S]*?\n {2}\}/)[0];
  assert.match(onWheel, /if \(e\.ctrlKey\) return;\s+e\.preventDefault\(\);/);
  assert.match(onWheel, /wheelTuneTimer = setTimeout\(\(\) => \{ wheelTuneTimer = null; tuneCurrent\(\); \}, WHEEL_TUNE_DELAY_MS\);/);
});

test('a sideways wheel or touchpad swipe moves through the stations too', () => {
  const pool = { px: 0 };
  // Right is the next station, left the one before, as down and up are.
  assert.equal(wheelSteps(pool, { deltaX: 100, deltaY: 0, deltaMode: 0 }), 1);
  assert.equal(wheelSteps(pool, { deltaX: -100, deltaY: 0, deltaMode: 0 }), -1);
  assert.equal(wheelSteps(pool, { deltaX: -200 }), -2);
  // A swipe that is mostly sideways counts only its sideways part.
  assert.equal(wheelSteps(pool, { deltaX: 100, deltaY: 30, deltaMode: 0 }), 1);
  assert.equal(pool.px, 0);
  // A mostly vertical wheel ignores a little sideways drift.
  assert.equal(wheelSteps(pool, { deltaX: -20, deltaY: 100, deltaMode: 0 }), 1);
  // Small swipes add up like small touchpad scrolls.
  const steps = [40, 40, 40].map((deltaX) => wheelSteps(pool, { deltaX, deltaY: 5, deltaMode: 0 }));
  assert.deepEqual(steps, [0, 0, 1]);
  assert.equal(pool.px, 20);
  // Line-based tilt wheels.
  assert.equal(wheelSteps({ px: 0 }, { deltaX: 3, deltaY: 0, deltaMode: 1 }), 0);
  assert.equal(wheelSteps({ px: 0 }, { deltaX: 4, deltaY: 0, deltaMode: 1 }), 1);
});

test('five single detents in each direction visit every station, including 19 at the wrap', () => {
  for (const delta of [100, 120]) {
    const pool = { px: 0 };
    let index = 18;
    const seen = [-1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1].map(direction => {
      const steps = wheelSteps(pool, { deltaY: direction * delta });
      index = (19 + index + steps) % 19;
      return index + 1;
    });
    assert.deepEqual(seen, [18, 17, 16, 15, 14, 15, 16, 17, 18, 19, 1]);
  }
});
