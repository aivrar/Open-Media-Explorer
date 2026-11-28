import { mountTunerStationList } from '../src/modes/tuner-station-list.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSettings } from '../src/lib/state.js';
import { applyTunerLayout, bindTunerLayout, paintTunerPlaceholder, dialTurn, wheelSteps } from '../src/modes/tuner.js';
import { tunerStageLayout } from '../src/modes/tuner-layout.js';
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
  const [base, library, computer, about, visualizer, player] = await Promise.all([
    'src/styles/base.css', 'src/styles/library.css', 'src/styles/computer.css',
    'src/styles/about.css', 'src/visualizer/visualizer.css', 'src/lib/player.js',
  ].map(read));

  assert.match(base, /--video-clearance: 0px;/);
  assert.match(base, /^#app\[data-video-clearance="reserved"\],\s*#app\.has-video \{\s*--video-clearance: calc\(var\(--video-height, 0px\) \+ var\(--video-gap\)\);/m);
  assert.match(base, /^#app\[data-video-clearance="released"\] \{\s*--video-clearance: 0px;/m);
  assert.doesNotMatch(base, /:fullscreen[^{]*\{[^}]*--video-clearance:/);
  for (const [css, selector, inset] of [
    [library, 'results', 18], [library, 'results', 12],
    [computer, 'computer-root', '[0-9]+'],
    [visualizer, 'viz-panel', 16],
  ]) {
    assert.match(css, new RegExp('\\.' + selector + ' \\{[^}]*padding: [^;]+calc\\(' + inset + 'px \\+ var\\(--video-clearance\\)\\);'));
  }
  // The wide scrollport ends at the dock's top edge, keeping all its content clear.
  assert.match(library, /\.detail-panel \{[^}]*overflow-y: auto;\s*padding: 18px;/);
  assert.match(library,
    /@media \(width > 980px\) \{\s*#app\.has-video \.library-root \{\s*--detail-dock-height: calc\(var\(--video-height, 0px\) \+ var\(--video-gap\)\);\s*\}\s*\.detail-panel \{\s*margin-bottom: max\(var\(--video-clearance\), var\(--detail-dock-height, 0px\)\);\s*padding-block: 0;/);
  assert.match(library, /\.detail-panel::before,\s*\.detail-panel::after \{\s*content: '';\s*flex: 0 0 4px;/);
  // Fullscreen video measurements leave the dock's windowed height in place.
  assert.match(player, /if \(document\.fullscreenElement \|\| !app\) return;\s*const height = entry\.borderBoxSize\[0\]\.blockSize;/);
  assert.match(about, /\.about-root \{[^}]*overflow-y: auto;/);
  assert.match(about, /\.about-page \{[^}]*padding: 48px 32px calc\(80px \+ var\(--video-clearance\)\);/);
  const dockZ = Number(base.match(/\.video-dock \{[^}]*z-index: (\d+);/)[1]);
  // The narrow detail overlay fills the view and sits in front of the dock.
  const narrow = library.match(/^@media \(max-width: 980px\) \{[\s\S]*?^\}/m)?.[0] ?? '';
  const overlay = narrow.match(/\.detail-panel \{\s*position: absolute;\s*inset: 0;\s*z-index: (\d+);/);
  assert.ok(overlay && Number(overlay[1]) > dockZ, 'narrow details are above the dock');
  const modalZ = Number(base.match(/\.modal-backdrop \{[^}]*z-index: (\d+);/)[1]);
  assert.ok(modalZ > dockZ, 'Settings and Song log are above the dock');
});

test('only the Tuner positions the original dock from the predicted picture', async () => {
  const css = await read('src/styles/tuner.css');
  const dock = css.match(/#view-host\[data-mode='tuner'\] ~ \.video-dock \{([^}]*)\}/)[1];
  for (const edge of ['left', 'bottom', 'width']) assert.ok(dock.includes('--tuner-picture-' + edge));
  assert.match(dock, /var\(--player-h\)/);
  assert.match(css, /video:where\(:not\(:fullscreen\)\) \{\s*height: var\(--tuner-picture-height\);/);
  assert.doesNotMatch(css, /var\(--video-(?:height|clearance)\b/);
});

test('the Tuner measures stable rows and cleans up its observers on exit', (t) => {
  const app = new FakeElement('app');
  const host = new FakeElement('view-host');
  const root = new FakeElement();
  host.parentElement = app;
  const stage = root.appendChild(new FakeElement());
  stage.getBoundingClientRect = () => ({ width: 1024, height: 447 });
  const properties = new Map([['--player-h', '74px'], ['--video-gap', '8px']]);
  app.style.setProperty = (key, value) => properties.set(key, value);
  app.style.removeProperty = (key) => properties.delete(key);
  const observers = [];
  let appChanged;
  const disconnectChanges = t.mock.fn();
  const video = new FakeElement();
  const globals = {
    document: { activeElement: null, getElementById: () => video },
    MutationObserver: class {
      constructor(callback) { appChanged = callback; }
      observe(target, options) {
        assert.equal(target, app);
        assert.deepEqual(options, { attributes: true, attributeFilter: ['class'] });
      }
      disconnect() { disconnectChanges(); }
    },
    ResizeObserver: class {
      constructor(callback) { this.resize = callback; this.elements = []; observers.push(this); }
      observe(element, options) { assert.equal(options.box, 'border-box'); this.elements.push(element); }
      disconnect() { this.elements = []; }
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

  const layouts = [];
  const parts = { stage };
  for (const key of ['placeholder', 'dialWrap', 'list', 'empty', 'status', 'listColumn', 'stationsToggle']) parts[key] = new FakeElement();
  parts.listColumn.contains = () => false;
  stage.style.setProperty = (key, value) => { stage.style[key] = value; };
  parts.tone = { setLayout(knobs) { this.knobs = knobs; }, column: { contains: () => false } };
  const stations = Array.from({ length: 17 }, (_, id) => ({ id }));
  const content = new FakeElement();
  content.replaceChildren = (...nodes) => { content.children = nodes; };
  parts.list.scrollTop = 0;
  const directory = mountTunerStationList(parts.list, content, {
    makeOption: () => new FakeElement(), tune() {}, onScroll() {}, onRender() {},
  });
  t.after(directory.destroy);
  const layout = bindTunerLayout(host, stage, result => {
    layouts.push(result);
    applyTunerLayout(parts, result);
    directory.update(stations, 15, parts.listHeight, 'small', true, result.columns);
  }, () => 'tv');
  layout.count(stations.length);
  layout.settings({ tunerStations: true, tunerToneKnobs: true });
  assert.deepEqual(observers[0].elements, [stage]);
  const radio = layouts.at(-1);
  parts.list.scrollTop = 0;
  parts.list.dispatchEvent(new Event('scroll'));
  app.classList.add('tuner-video-reserved');
  appChanged();
  const active = layouts.at(-1);
  assert.deepEqual(active, tunerStageLayout({ width: 1024, height: 447, tone: true, reserved: true, band: 'tv', count: 17 }));
  const { picture, list, caption, dial, knobs } = active;
  const y = parseFloat(content.children.find(node => node.id === 'tuner-station-15').style.top) - parts.list.scrollTop;
  assert.ok(y >= 0 && y + 56 <= list.height);
  assert.equal(parts.placeholder.hidden, false);
  const slot = { ...parts.placeholder.style };
  assert.deepEqual(slot, { left: picture.x + 'px', top: picture.y + 'px',
    width: picture.width + 'px', height: picture.height + 'px' });
  const loadingList = { ...parts.list.style };
  app.classList.add('has-video');
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.readyState = 2;
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(parts.placeholder.hidden, true);
  assert.deepEqual(layouts.at(-1).picture, picture);
  assert.deepEqual(parts.placeholder.style, slot);
  assert.deepEqual(parts.list.style, loadingList);
  app.classList.remove('has-video');
  appChanged();
  assert.equal(parts.placeholder.hidden, false);
  assert.deepEqual(parts.list.style, loadingList);
  assert.equal(properties.get('--tuner-picture-left'), picture.x + 'px');
  assert.equal(properties.get('--tuner-picture-width'), picture.width + 'px');
  assert.equal(properties.get('--tuner-picture-height'), picture.height + 'px');
  assert.equal(properties.get('--tuner-picture-bottom'), (447 - picture.y - picture.height) + 'px');
  for (const [node, rect] of [[parts.dialWrap, dial], [parts.list, list], [parts.empty, list], [parts.status, caption]]) {
    assert.equal(node.dataset.size, rect.sizeClass);
    assert.deepEqual(node.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  assert.equal(stage.style['--station-row-height'], '56px');
  layout.settings({ tunerStations: true, tunerToneKnobs: true, tunerCardSize: 'large' });
  assert.equal(stage.style['--station-row-height'], '84px');
  layout.settings({ tunerStations: true, tunerToneKnobs: true });
  assert.equal(parts.listHeight, list.height);
  layout.captionWidth(list.width + 1);
  assert.equal(parts.status.style.height, '32px');
  assert.equal(parts.listHeight, list.height);
  layout.captionWidth(0);
  assert.deepEqual(parts.list.style, loadingList);
  assert.deepEqual(parts.tone.knobs, knobs);
  const before = layouts.length;
  observers[0].resize();
  appChanged();
  assert.equal(layouts.length, before);
  app.classList.remove('tuner-video-reserved');
  appChanged();
  assert.deepEqual(layouts.at(-1), radio);
  layout.settings({ tunerStations: false, tunerToneKnobs: false });
  assert.equal(parts.listColumn.hidden, true);
  assert.equal(parts.listHeight, 0);
  assert.deepEqual(parts.tone.knobs, []);
  layout.destroy();
  assert.deepEqual(observers[0].elements, []);
  assert.equal(disconnectChanges.mock.callCount(), 1);
  assert.ok([...properties.keys()].every(key => !key.startsWith('--tuner-picture-')));
});

test('the TV placeholder paints decoded artwork for the tuned station and follows Stop', t => {
  const canvas = new FakeElement();
  canvas.width = canvas.height = 112;
  const ctx = { drawImage: t.mock.fn(), clearRect: t.mock.fn(), fillText: t.mock.fn() };
  canvas.getContext = () => ctx;
  const parts = { placeholderName: new FakeElement(), placeholderStatus: new FakeElement(),
    placeholderArt: canvas, list: new FakeElement() };
  const item = { id: 'fr24', title: 'France 24' };
  const image = new FakeElement();
  Object.assign(image, { complete: true, naturalWidth: 200, naturalHeight: 100 });
  image.dataset.stationId = item.id;
  paintTunerPlaceholder(parts, item, item, image);
  assert.equal(parts.placeholderName.textContent, 'France 24');
  assert.equal(parts.placeholderStatus.textContent, 'Loading…');
  const [drawn, ...coords] = ctx.drawImage.mock.calls[0].arguments;
  assert.equal(drawn, image);
  coords.forEach((value, i) => assert.ok(Math.abs(value - [0, 28, 112, 56][i]) < 1e-7));
  paintTunerPlaceholder(parts, item, null, image);
  assert.equal(parts.placeholderStatus.textContent, 'Stopped');
  assert.equal(ctx.drawImage.mock.callCount(), 2);

  const next = { id: 'bbc', title: 'BBC News' };
  const card = { complete: true, naturalWidth: 60, naturalHeight: 60 };
  parts.list.querySelector = () => card;
  paintTunerPlaceholder(parts, next, next, image);
  assert.deepEqual(ctx.drawImage.mock.calls[2].arguments, [card, 0, 0, 112, 112]);
  parts.list.querySelector = () => null;
  const oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  globalThis.getComputedStyle = () => ({ color: '#ccc' });
  t.after(() => {
    if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle);
    else delete globalThis.getComputedStyle;
  });
  paintTunerPlaceholder(parts, next, next, image);
  assert.equal(ctx.fillText.mock.calls[0].arguments[0], 'BBC');
  assert.equal(ctx.drawImage.mock.callCount(), 3);
});
