import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSettings } from '../src/lib/state.js';
import { dialTurn, wheelSteps } from '../src/modes/tuner.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dragging the dial across 9 o\'clock is a small turn, not a full reverse turn', () => {
  assert.equal(dialTurn(170, -170), 20);
  assert.equal(dialTurn(-170, 170), -20);
  assert.equal(dialTurn(10, 40), 30);
  assert.equal(dialTurn(40, 10), -30);
  assert.equal(dialTurn(-90, 90), 180);
  assert.equal(dialTurn(0, 0), 0);

  // A full clockwise circle in 10-degree mouse moves adds up to exactly one
  // turn (30 stations at 12 degrees each), with no jump at the wrap point.
  let rotation = 0;
  let last = -90;
  for (let i = 1; i <= 36; i += 1) {
    let angle = -90 + i * 10;
    if (angle > 180) angle -= 360;
    rotation += dialTurn(last, angle);
    last = angle;
  }
  assert.equal(rotation, 360);
});

test('mouse wheel tunes one station per notch and pools small touchpad moves', () => {
  const pool = { px: 0 };
  assert.equal(wheelSteps(pool, { deltaY: 100, deltaMode: 0 }), 1);
  assert.equal(wheelSteps(pool, { deltaY: -100, deltaMode: 0 }), -1);
  assert.equal(wheelSteps(pool, { deltaY: 300, deltaMode: 0 }), 3);
  assert.equal(pool.px, 0);

  // Touchpad: many small deltas add up to one step, then start over.
  const steps = [30, 30, 30, 30].map((deltaY) => wheelSteps(pool, { deltaY, deltaMode: 0 }));
  assert.deepEqual(steps, [0, 0, 0, 1]);
  assert.equal(pool.px, 20);

  // Line-based wheels (deltaMode 1) send about 3 lines per notch.
  const lines = { px: 0 };
  assert.equal(wheelSteps(lines, { deltaY: 3, deltaMode: 1 }), 0);
  assert.equal(wheelSteps(lines, { deltaY: 1, deltaMode: 1 }), 1);
  assert.equal(wheelSteps({ px: 0 }, { deltaY: undefined }), 0);
});

test('the dial listens for the wheel and tunes once it rests', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.match(tuner, /wheelTuneTimer = setTimeout\(/);
  assert.match(tuner, /state\.rotationDeg \+= dialTurn\(lastAngle, a\)/);
});

test('sources switched off in Settings are left out of the Library sidebar', async () => {
  const css = await read('src/styles/library.css');
  assert.match(css, /\.source-item\.is-disabled \{ display: none; \}/);
  assert.doesNotMatch(css, /\.source-item\.is-disabled \{[^}]*not-allowed/);
  const sidebar = await read('src/modes/library/sidebar.js');
  assert.match(sidebar, /querySelectorAll\('\.source-item:not\(\.is-disabled\)'\)/);
});

test('video size is a saved setting that only accepts normal or large', () => {
  assert.equal(normalizeSettings({}).videoSize, 'normal');
  assert.equal(normalizeSettings({ videoSize: 'large' }).videoSize, 'large');
  assert.equal(normalizeSettings({ videoSize: 'huge' }).videoSize, 'normal');
  assert.equal(normalizeSettings({ videoSize: true }).videoSize, 'normal');
});

test('the floating video scales with the window and has a size button', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /--video-w: min\(32vw, clamp\(320px, calc\(100vw \/ 6\), 640px\)\);/);
  assert.match(css, /#app\.video-large \{\s*--video-w: min\(calc\(100vw - 32px\), clamp\(480px, 40vw, 1400px\)\);/);
  assert.match(css, /\.video-dock \{[^}]*width: var\(--video-w\);/);
  // The button must disappear with the video, and the video must not be
  // given a display value that would defeat its `hidden` attribute.
  assert.match(css, /\.video-dock video\[hidden\] \+ \.video-size-btn \{ display: none; \}/);
  assert.doesNotMatch(css.match(/\.video-dock video \{[^}]*\}/)[0], /display:/);

  const html = await read('src/index.html');
  assert.match(html, /<div id="video-dock" class="video-dock">\s*<video id="video-el" hidden[^>]*><\/video>\s*<button id="video-size-btn"/);

  const player = await read('src/lib/player.js');
  assert.doesNotMatch(player, /style\.width = '320px'/);
  assert.match(player, /saveSettings\(\{ videoSize: large \? 'normal' : 'large' \}\)/);

  const library = await read('src/styles/library.css');
  assert.match(library, /#app\.has-video \.detail-panel \{\s*padding-bottom: var\(--video-clearance\);/);
});
