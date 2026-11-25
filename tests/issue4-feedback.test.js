import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSettings } from '../src/lib/state.js';
import { bindTunerVideoHeight, dialTurn, tunerVideoLayout, wheelSteps } from '../src/modes/tuner.js';
import { FakeElement } from './helpers/fake-dom.js';

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
});

test('a visible video leaves room in the other tabs even in fullscreen', async () => {
  const [base, library, grid, about, visualizer] = await Promise.all([
    'src/styles/base.css', 'src/styles/library.css', 'src/styles/grid.css',
    'src/styles/about.css', 'src/visualizer/visualizer.css',
  ].map(read));

  assert.match(base, /--video-clearance: 0px;/);
  assert.match(base, /^#app\.has-video \{\s*--video-clearance: calc\(var\(--video-height, 0px\) \+ var\(--video-gap\)\);/m);
  assert.doesNotMatch(base, /:fullscreen[^{]*\{[^}]*--video-clearance:/);
  for (const [css, selector, inset] of [
    [library, 'results', 18], [library, 'results', 12],
    [grid, 'grid-tiles', 18], [grid, 'grid-tiles', 12],
    [visualizer, 'viz-panel', 16],
  ]) {
    assert.match(css, new RegExp('\\.' + selector + ' \\{[^}]*padding: [^;]+calc\\(' + inset + 'px \\+ var\\(--video-clearance\\)\\);'));
  }
  assert.match(library, /@media \(width > 980px\) \{\s*\.detail-panel \{\s*padding-bottom: calc\(18px \+ var\(--video-clearance\)\);/);
  assert.match(about, /\.about-root \{[^}]*overflow-y: auto;/);
  assert.match(about, /\.about-page \{[^}]*padding: 48px 32px calc\(80px \+ var\(--video-clearance\)\);/);
  const dockZ = Number(base.match(/\.video-dock \{[^}]*z-index: (\d+);/)[1]);
  const modalZ = Number(base.match(/\.modal-backdrop \{[^}]*z-index: (\d+);/)[1]);
  assert.ok(modalZ > dockZ, 'Settings and Song log are above the dock');
});

for (const { windowSize, size, width, stageHeight, normalWidth, dial, box } of [
  { windowSize: '1024x640', size: 'normal', width: 1024, stageHeight: 310, normalWidth: 320, dial: 189.5, box: [200, 112.5] },
  { windowSize: '1280x801', size: 'large', width: 1280, stageHeight: 471, normalWidth: 512, dial: 220, box: [432, 243] },
  { windowSize: '1280x801', size: 'normal', width: 1280, stageHeight: 471, normalWidth: 320, dial: 283, box: [320, 180] },
  { windowSize: '1921x1080', size: 'normal', width: 1921, stageHeight: 751, normalWidth: 320, dial: 540, box: [320, 180] },
]) {
  test(`the Tuner video fits a ${windowSize} window at ${size} size`, () => {
    const gap = 8;
    const { floating, heightLimit } = tunerVideoLayout(stageHeight, width, gap);
    assert.equal(floating, false);
    const height = Math.min(normalWidth * 9 / 16, heightLimit);
    assert.deepEqual([height * 16 / 9, height], box);
    assert.equal(Math.min(540, stageHeight - height - gap), dial);
  });
}

test('at 967x624 with a 168 px player bar the Tuner floats the floor-size box', () => {
  const windowHeight = 624;
  const playerBarHeight = 168;
  const fixedRowsHeight = 266.5;
  const stagePadding = 36;
  const stageHeight = windowHeight - playerBarHeight - fixedRowsHeight - stagePadding;
  const gap = 8;
  const { floating, heightLimit } = tunerVideoLayout(stageHeight, 967, gap);

  assert.equal(floating, true);
  assert.deepEqual([heightLimit * 16 / 9, heightLimit], [200, 112.5]);
  const reservedHeight = floating ? 0 : heightLimit + gap;
  assert.equal(reservedHeight, 0);
  assert.equal(Math.min(540, (967 - stagePadding) * 0.78, stageHeight - reservedHeight), 153.5);
});

test('the Tuner can reserve the band at exactly 150 px of dial space', () => {
  assert.equal(tunerVideoLayout(270.49, 967, 8).floating, true);
  assert.deepEqual(tunerVideoLayout(270.5, 967, 8), { floating: false, heightLimit: 112.5 });
});

test('the Tuner fit uses the existing dial width when it is less than 220 px', () => {
  assert.deepEqual(tunerVideoLayout(350, 225, 8), { floating: false, heightLimit: 135 });
});

test('the Tuner dock and reservation share one windowed height at both sizes', async () => {
  const css = await read('src/styles/tuner.css');
  assert.match(css, /--tuner-video-height: min\(calc\(var\(--video-w\) \* 9 \/ 16\),\s*var\(--tuner-video-height-limit,/);
  assert.match(css, /#view-host\[data-mode='tuner'\] ~ \.video-dock \{\s*display: grid;\s*width: calc\(var\(--tuner-video-height\) \* 16 \/ 9\);/);
  assert.match(css, /#app\.tuner-video-reserved:not\(\.tuner-video-floating\) > #view-host\[data-mode='tuner'\] ~ \.video-dock \{\s*inset-inline: 0;\s*margin-inline: auto;/);
  const base = await read('src/styles/base.css');
  assert.match(base, /\.video-dock \{[^}]*bottom: calc\(var\(--player-h\) \+ var\(--video-gap\)\);\s*right: 16px;/);
  assert.match(css, /#app\.tuner-video-floating:has\(> #view-host\[data-mode='tuner'\]\) \{\s*--tuner-video-height: var\(--tuner-video-height-limit\);/);
  assert.match(css, /\.video-dock video:where\(:not\(:fullscreen\)\) \{\s*height: var\(--tuner-video-height\);\s*object-fit: contain;\s*max-height: none;/);
  assert.doesNotMatch(css, /var\(--video-(?:height|clearance)\b/);
  assert.match(css, /--tuner-video-padding: calc\(\(var\(--tuner-video-height, 0px\) \+ var\(--video-gap\)\) \* var\(--tuner-video-space\)\);/);
  assert.match(css, /@property --tuner-video-space \{[^}]*syntax: "<number>";[^}]*initial-value: 0;/);
  assert.match(css, /#app\.tuner-video-reserved \.tuner-root \{\s*--tuner-video-space: 1;/);
  assert.match(css, /#app\.tuner-video-floating \.tuner-root \{\s*--tuner-video-padding: 0px;\s*transition: none;/);
  assert.match(css, /transition: --tuner-video-space 200ms ease;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tuner-root \{ transition: none; \}/);
});

test('the Tuner measures video only with a dock or reservation, and disconnects on exit', (t) => {
  const app = new FakeElement('app');
  const host = new FakeElement('view-host');
  const root = new FakeElement();
  host.parentElement = app;
  const rows = Array.from({ length: 4 }, () => root.appendChild(new FakeElement()));
  const bounds = t.mock.fn(() => ({ height: 60 }));
  for (const row of rows) row.getBoundingClientRect = bounds;
  host.getBoundingClientRect = t.mock.fn(() => ({ width: 1280, height: 690 }));
  const properties = new Map([['--player-h', '74px'], ['--video-gap', '8px']]);
  app.style.setProperty = (key, value) => properties.set(key, value);
  app.style.removeProperty = (key) => properties.delete(key);
  const getComputedStyle = t.mock.fn(() => ({
    getPropertyValue: (key) => properties.get(key), paddingTop: '0px', paddingBottom: '0px',
  }));
  const observers = [];
  let appChanged;
  const disconnectChanges = t.mock.fn();
  const globals = {
    window: { getComputedStyle },
    MutationObserver: class {
      constructor(callback) { appChanged = callback; }
      observe(target, options) {
        assert.equal(target, app);
        assert.deepEqual(options, { attributes: true, attributeFilter: ['class'] });
      }
      disconnect() { disconnectChanges(); }
    },
    ResizeObserver: class {
      constructor(callback) {
        this.resize = callback;
        this.elements = new Set();
        observers.push(this);
      }
      observe(element, options) {
        assert.equal(options.box, 'border-box');
        this.elements.add(element);
      }
      disconnect() { this.elements.clear(); }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }

  const close = bindTunerVideoHeight(host, root);
  const setClass = (name, enabled) => {
    app.classList.toggle(name, enabled);
    appChanged();
  };
  setClass('has-player', true);
  setClass('has-player', false);
  assert.equal(observers.length, 0);
  assert.equal(getComputedStyle.mock.callCount(), 0);
  assert.equal(bounds.mock.callCount(), 0);
  assert.equal(host.getBoundingClientRect.mock.callCount(), 0);

  setClass('has-video', true);
  assert.deepEqual([...observers[0].elements], [host, rows[0], rows[2], rows[3]]);
  assert.equal(properties.get('--tuner-video-height-limit'), '208px');
  observers[0].resize();
  assert.equal(getComputedStyle.mock.callCount(), 4);

  setClass('tuner-video-reserved', true);
  setClass('has-video', false);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].elements.size, 4);
  setClass('tuner-video-reserved', false);
  assert.equal(observers[0].elements.size, 0);
  assert.equal(properties.get('--tuner-video-height-limit'), '208px', 'release keeps its height while animating');
  setClass('has-player', true);
  assert.equal(getComputedStyle.mock.callCount(), 4);

  setClass('tuner-video-reserved', true);
  assert.equal(observers.length, 2);
  assert.equal(observers[1].elements.size, 4);
  close();
  assert.equal(observers[1].elements.size, 0);
  assert.equal(disconnectChanges.mock.callCount(), 1);
  assert.equal(properties.has('--tuner-video-height-limit'), false);
});
