import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsVideoQuality, createVideoQuality, matchVideoQuality, observePictureSize,
  pictureSizeLevel, videoQualityLevel, videoQualityOptions,
} from '../src/lib/video-quality.js';

function level(id, height, bitrate, frameRate = 30) {
  return videoQualityLevel({ width: Math.round(height * 16 / 9), height, bitrate, frameRate }, id);
}

test('level labels sort highest first, distinguish FPS, and keep duplicates selectable', () => {
  const options = videoQualityOptions([
    level(0, 360, 600_000), level(1, 720, 2_800_000), level(2, 720, 2_800_000),
    level(3, 720, 3_000_000, '60000/1000'), level(4, 1080, 6_220_000),
  ]);
  assert.deepEqual(options.map(({ label }) => label), [
    '1080p \u00b7 6.22 Mbps', '720p \u00b7 60 fps \u00b7 3 Mbps', '720p \u00b7 30 fps \u00b7 2.8 Mbps',
    '720p \u00b7 30 fps \u00b7 2.8 Mbps (2)', '360p \u00b7 600 kbps',
  ]);
  assert.deepEqual(options.map(({ quality }) => quality), [
    { height: 1080 }, { height: 720, frameRate: 60 }, { height: 720, frameRate: 30 },
    { height: 720, frameRate: 30 }, { height: 360 },
  ]);
  assert.equal(videoQualityOptions([level(0, 720, 2_800_000)]).length, 1);
});

test('bitrate-only HLS levels stay selectable and saved height choices still use sized levels', () => {
  const options = videoQualityOptions([
    videoQualityLevel({ attrs: { BANDWIDTH: 500_000 } }, 0),
    videoQualityLevel({ attrs: { BANDWIDTH: 2_000_000 } }, 1),
    level(2, 720, 1_600_000),
  ]);
  assert.deepEqual(options.map(({ label }) => label), ['720p \u00b7 1.6 Mbps', '2 Mbps', '500 kbps']);
  assert.equal(matchVideoQuality(options, { height: 360 }).level.id, 2);
  assert.equal(matchVideoQuality(options, { bitrate: 600_000 }).level.id, 0);
  assert.equal(matchVideoQuality(options, { bitrate: 2_000_000 }).level.id, 1);
  assert.equal(matchVideoQuality(options.slice(0, 1), { bitrate: 2_000_000 }), null);
  assert.equal(matchVideoQuality(options.slice(1), { height: 720 }), null);
});

test('saved heights choose closest below first and match frame rate within that height', () => {
  const options = videoQualityOptions([
    level(7, 540, 1_800_000), level(8, 540, 2_100_000, 60), level(3, 1080, 6_500_000),
  ]);
  assert.equal(matchVideoQuality(options, { height: 720, frameRate: 30 }).level.id, 7);
  assert.equal(matchVideoQuality(options, { height: 720 }).level.id, 8);
  assert.equal(matchVideoQuality(options, { height: 360 }).level.id, 8);
  assert.equal(matchVideoQuality(options, { height: 1080 }).level.id, 3);
});

const levels = [level(0, 360, 600_000), level(1, 540, 3_000_000), level(2, 1080, 6_220_000)];
const small = { width: 490, height: 275 };
const large = { width: 1600, height: 900 };

function hlsFixture() {
  const switches = [];
  const hls = {
    levels,
    config: { abrBandWidthUpFactor: 0.5 },
    bandwidthEstimate: 15_000_000,
    autoLevelCapping: -1,
    playingLevel: 0,
    minAutoLevel: 0,
    loadLevel: -1,
    nextAutoLevel: 0,
    get autoLevelEnabled() { return this.loadLevel === -1; },
    get maxAutoLevel() { return this.autoLevelCapping < 0 ? this.levels.length - 1 : this.autoLevelCapping; },
    get currentLevel() { return this.playingLevel; },
    set currentLevel(id) { this.loadLevel = id; switches.push(['immediate', id]); },
    get nextLevel() { return -1; },
    set nextLevel(id) { this.loadLevel = id; switches.push(['after current fragment', id]); },
  };
  const video = new EventTarget();
  video.getBoundingClientRect = () => small;
  const quality = createVideoQuality(video, () => {});
  const source = createHlsVideoQuality(hls);
  quality.setSource(source);
  quality.setLevels(source, levels);
  return { video, hls, quality, source, switches };
}

test('picture size uses physical pixels and allows all bitrates at the covering size', () => {
  const ladder = [levels[0], level(1, 360, 900_000), levels[1], levels[2]];
  assert.equal(pictureSizeLevel(ladder, small, 1), ladder[1]);
  assert.equal(pictureSizeLevel(ladder, { width: 470, height: 265 }, 2), levels[1]);
  assert.equal(pictureSizeLevel(ladder, large, 1), levels[2]);
  assert.equal(pictureSizeLevel(ladder, { width: 0, height: 0 }, 2), null);
});

test('size changes use device pixels and switch after the current fragment, then resume Auto', (t) => {
  const dpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1.75 });
  t.after(() => {
    if (dpr) Object.defineProperty(globalThis, 'devicePixelRatio', dpr);
    else delete globalThis.devicePixelRatio;
  });
  const { video, hls, quality, source, switches } = hlsFixture();
  const smallBox = { width: 320, height: 180 };
  const largeBox = { width: 512, height: 288 };
  let rect = smallBox;
  let resizeElement;
  let disconnected = false;
  video.getBoundingClientRect = () => rect;
  const page = new EventTarget();
  const window = new EventTarget();
  const stop = observePictureSize(video, quality.sync, {
    page, window,
    Observer: class {
      constructor(callback) { resizeElement = callback; }
      observe(element) { assert.equal(element, video); }
      disconnect() { disconnected = true; }
    },
  });
  quality.sync();
  assert.equal(hls.autoLevelCapping, 0);
  rect = largeBox;
  page.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(hls.autoLevelCapping, 1);
  assert.deepEqual(switches, [['after current fragment', 1]]);
  source.fragmentReady(0);
  assert.equal(hls.autoLevelEnabled, false);
  source.fragmentReady(1);
  assert.equal(hls.autoLevelEnabled, true);
  hls.playingLevel = 1;
  rect = smallBox;
  window.dispatchEvent(new Event('resize'));
  assert.equal(hls.autoLevelCapping, 0);
  assert.deepEqual(switches.at(-1), ['after current fragment', 0]);
  source.fragmentReady(0);
  hls.playingLevel = 0;
  assert.equal(hls.autoLevelEnabled, true);

  rect = largeBox;
  hls.bandwidthEstimate = 5_000_000;
  resizeElement();
  assert.equal(hls.autoLevelCapping, 1);
  assert.equal(switches.length, 2);
  stop();
  assert.equal(disconnected, true);
  rect = smallBox;
  page.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(hls.autoLevelCapping, 1);
});

test('Best removes the size cap, keeps the recovery ceiling, and fixed overrides it until fallback', () => {
  const { video, hls, quality, source, switches } = hlsFixture();
  assert.equal(hls.autoLevelCapping, 0);
  quality.setPreference('best');
  assert.equal(hls.autoLevelCapping, -1);
  assert.equal(hls.autoLevelEnabled, true);
  assert.equal(source.lower(), true);
  assert.equal(hls.autoLevelCapping, 1);

  const fixed = { height: 1080 };
  quality.setPreference(fixed, null, true);
  assert.deepEqual(switches, [['immediate', 2]]);
  assert.equal(hls.loadLevel, 2);
  assert.equal(source.lower(), false);
  assert.equal(hls.loadLevel, 2);
  assert.equal(quality.fallBack(source), true);
  assert.equal(hls.autoLevelEnabled, true);
  assert.equal(hls.startLevel, -1);
  assert.equal(hls.autoLevelCapping, 0);
  assert.equal(quality.view(fixed).fellBack, true);
  quality.setPreference(fixed);
  assert.equal(hls.autoLevelEnabled, true);
  video.getBoundingClientRect = () => large;
  quality.sync();
  assert.equal(hls.autoLevelCapping, 1);
  quality.setPreference('best', null, true);
  assert.equal(hls.autoLevelCapping, 1);
  assert.equal(quality.view('best').fellBack, false);
});

test('Auto restores the small cap after Best, and a fixed pick takes over a pending Auto switch', () => {
  const { hls, quality, source, switches } = hlsFixture();
  quality.setPreference('best');
  hls.playingLevel = 2;
  quality.setPreference('auto');
  assert.equal(hls.autoLevelCapping, 0);
  assert.deepEqual(switches.at(-1), ['after current fragment', 0]);
  quality.setPreference({ height: 540 }, null, true);
  source.fragmentReady(0);
  assert.deepEqual(switches.at(-1), ['immediate', 1]);
  assert.equal(hls.loadLevel, 1);
});

test('a same-height rendition is exact for this ladder and recalled by height on the next ladder', () => {
  const { hls, quality, source } = hlsFixture();
  const sameHeight = [levels[0], level(1, 720, 1_600_000), level(2, 720, 2_800_000)];
  quality.setLevels(source, sameHeight);
  const view = quality.view('auto');
  const option = view.options[1];
  const pick = view.pick(option);
  quality.setPreference(option.quality, pick, true);
  assert.equal(hls.loadLevel, 1);
  quality.setSource(null);
  quality.setSource(source);
  quality.setLevels(source, sameHeight);
  assert.equal(hls.loadLevel, 2);
});
