import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { wheelSteps } from '../src/modes/tuner.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the wheel over the strip of cards is bound to the dial\'s own wheel handler', async () => {
  const tuner = await read('src/modes/tuner.js');
  // The dial's handler is the one the strip gets, so a notch over the strip
  // tunes exactly as a notch over the dial: one station, tuned once it rests.
  assert.match(tuner, /wrap\.addEventListener\('wheel', onWheel, \{ passive: false \}\);\n[^\n]*\n\s+ui\.dialWheel = onWheel;/);
  assert.match(tuner, /ui\.strip\.addEventListener\('wheel', ui\.dialWheel, \{ passive: false \}\);/);
  // The dial is built (and its handler kept) before the strip is.
  assert.ok(tuner.indexOf('ui.unbindDial = bindDialEvents(dialWrap);')
    < tuner.indexOf("ui.strip.addEventListener('wheel', ui.dialWheel"));
  // The handler stops the page (and the strip) scrolling whenever there are
  // stations, except for Ctrl + wheel, the window's zoom, which it leaves alone.
  const onWheel = tuner.match(/function onWheel\(e\) \{[\s\S]*?\n {2}\}/)[0];
  assert.match(onWheel, /if \(state\.stations\.length === 0\) return;\n[^\n]*\n\s+if \(e\.ctrlKey\) return;\s+e\.preventDefault\(\);/);
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
