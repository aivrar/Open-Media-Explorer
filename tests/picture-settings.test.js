import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeElement } from './helpers/fake-dom.js';
import { createVideoQuality, videoQualityLevel } from '../src/lib/video-quality.js';
import { bindPicturePanel, choosePicturePanelLeft } from '../src/lib/picture-panel.js';
import {
  applyVideoPicture, effectivePicture, loadPictureSettings, normalizePicture, pictureFilter, savePictureSettings,
} from '../src/lib/picture-settings.js';
import { MAX_PROFILE_BYTES, PICTURE_STORAGE_KEY, ProfileStorageBudgetError } from '../src/lib/profile-storage.js';
import { cancelScheduledProfileHandoff, captureProfileStorage, restoreProfileStorageValues } from '../src/lib/profile-transfer.js';
import { loadPlaylists, removePlaylist } from '../src/lib/playlists.js';
import { clearCache, initState, removeFavorite, STORAGE_KEYS } from '../src/lib/state.js';

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function videoElement() {
  const video = new FakeElement('video-el', 'video');
  video.style.removeProperty = (name) => { delete video.style[name]; };
  return video;
}

const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

test('Picture chooses the edge with the smallest overlap with docked video', () => {
  const panel = rect(612, 300, 320, 418);
  assert.equal(choosePicturePanelLeft(panel, rect(578, 144, 589, 331), 1280), 12);
  assert.equal(choosePicturePanelLeft(panel, rect(0, 270, 1000, 430), 1280), 948);
});

test('Picture keeps its CSS position on a tie or when there is no picture in its row', () => {
  const panel = rect(612, 300, 320, 418);
  assert.equal(choosePicturePanelLeft(panel, rect(944, 538, 320, 180), 1280), 612);
  assert.equal(choosePicturePanelLeft(panel, rect(0, 270, 1280, 430), 1280), 612);
  assert.equal(choosePicturePanelLeft(panel, rect(612, 0, 320, 300), 1280), 612);
  assert.equal(choosePicturePanelLeft(panel, null, 1280), 612);
});

test('neutral picture uses no filter and only changed settings contribute to the filter', () => {
  assert.equal(pictureFilter(), '');
  assert.equal(pictureFilter({ fit: 'fill' }), '');
  assert.equal(pictureFilter({ brightness: 110, contrast: 80, saturation: 130, hue: -20 }),
    'brightness(110%) contrast(80%) saturate(130%) hue-rotate(-20deg)');
  assert.equal(pictureFilter({ brightness: 500, contrast: NaN, saturation: -2, hue: 180.5 }),
    'brightness(200%) saturate(0%) hue-rotate(180deg)');
});

test('fit classes are exclusive and resetting removes the filter property', () => {
  const video = videoElement();
  const modes = ['fill', 'zoom-110', 'zoom-125', 'zoom-133', 'whole'];
  for (const fit of modes) {
    applyVideoPicture(video, { fit, hue: 45 });
    assert.deepEqual([...video.classList.values], fit === 'whole' ? [] : [`video-fit-${fit}`]);
  }
  assert.equal(video.style.filter, 'hue-rotate(45deg)');
  applyVideoPicture(video, normalizePicture(null));
  assert.equal(Object.hasOwn(video.style, 'filter'), false);
  assert.deepEqual([...video.classList.values], []);
});

test('picture settings follow a profile restore and respect the shared size limit', () => {
  const storage = memoryStorage([[STORAGE_KEYS.favorites, '[]']]);
  const picture = {
    main: { brightness: 124, fit: 'fill', quality: 'best' },
    channels: { 'tv:one': { hue: 20, fit: 'zoom-110', quality: { height: 720, frameRate: 60 } } },
  };
  savePictureSettings(picture, storage);
  const restored = memoryStorage();
  assert.equal(restoreProfileStorageValues(captureProfileStorage(storage), restored), true);
  const state = loadPictureSettings(restored);
  assert.deepEqual(effectivePicture(state, 'tv:one'), normalizePicture(picture.channels['tv:one']));
  assert.deepEqual(effectivePicture(state, 'tv:two'), normalizePicture(picture.main));
  assert.deepEqual(effectivePicture(state, 'constructor'), normalizePicture(picture.main));
  assert.deepEqual(effectivePicture(state, ''), normalizePicture(picture.main));

  const full = memoryStorage([[STORAGE_KEYS.favorites, ' '.repeat(MAX_PROFILE_BYTES)]]);
  assert.throws(() => savePictureSettings(picture, full), ProfileStorageBudgetError);
  assert.equal(full.getItem(PICTURE_STORAGE_KEY), null);
});

test('older channel picture settings inherit the saved all-video quality', () => {
  const storage = memoryStorage([[PICTURE_STORAGE_KEY, JSON.stringify({
    main: { quality: { height: 1080 } },
    channels: { legacy: { hue: 20 }, override: { quality: 'auto' } },
  })]]);
  const state = loadPictureSettings(storage);
  assert.deepEqual(effectivePicture(state, 'legacy').quality, { height: 1080 });
  assert.equal(effectivePicture(state, 'legacy').hue, 20);
  assert.equal(effectivePicture(state, 'override').quality, 'auto');
});

test('channel values survive removal from one list, are pruned on the last removal, and clear with session edits', async (t) => {
  const favorite = { id: 'tv:one', type: 'tv', title: 'One' };
  const playlistOnly = { id: 'tv:two', type: 'tv', title: 'Two' };
  const unsaved = { id: 'tv:three', type: 'tv', title: 'Three' };
  const storage = memoryStorage([[STORAGE_KEYS.favorites, JSON.stringify([favorite])]]);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    cancelScheduledProfileHandoff();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  await initState();
  await loadPlaylists(async () => ({ playlists: [
    { id: 'mine', name: 'Mine', items: [favorite, playlistOnly] },
  ] }));

  const ids = [
    'player-picture-slot', 'picture-panel', 'picture-scope', 'picture-scope-channel', 'picture-fit',
    'picture-session-note', 'picture-feedback', 'picture-brightness', 'picture-contrast', 'picture-saturation',
    'picture-hue', 'picture-reset', 'picture-quality', 'picture-quality-label', 'picture-quality-row',
    'picture-quality-now', 'picture-quality-hint',
  ];
  const nodes = new Map(ids.map((id) => [id, new FakeElement(id)]));
  nodes.get('player-picture-slot').setAttribute('inert', '');
  const video = videoElement();
  const panel = nodes.get('picture-panel');
  const view = new EventTarget();
  view.innerWidth = 1280;
  let afterResize;
  view.setTimeout = (callback) => { afterResize = callback; return 1; };
  view.clearTimeout = () => { afterResize = null; };
  const finishResize = () => {
    const callback = afterResize;
    afterResize = null;
    callback?.();
  };
  view.getComputedStyle = () => ({
    visibility: 'visible', objectFit: 'contain',
    borderLeftWidth: '1px', borderRightWidth: '1px', borderTopWidth: '1px', borderBottomWidth: '1px',
  });
  panel.ownerDocument = { defaultView: view };
  let panelReads = 0;
  panel.getBoundingClientRect = () => {
    panelReads++;
    return rect(parseFloat(panel.style.left) || view.innerWidth - 668, 300, 320, 418);
  };
  let videoBounds = rect(578, 144, 589, 331);
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.getBoundingClientRect = () => videoBounds;
  const select = nodes.get('picture-quality');
  select.ownerDocument = { createElement: (tag) => new FakeElement('', tag) };
  select.replaceChildren = (...children) => { select.children = children; };
  const quality = createVideoQuality(video, () => setItem.renderQuality());
  const setItem = bindPicturePanel(video, (id) => nodes.get(id), quality);
  const source = { apply() {} };
  const low = { width: 640, height: 360, bitrate: 600_000 };
  const high = { width: 1280, height: 720, bitrate: 2_800_000 };
  quality.setSource(source);
  const toggle = (newState) => {
    panel.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState }));
    panel.dispatchEvent(Object.assign(new Event('toggle'), { newState }));
  };
  panel.hidePopover = () => toggle('closed');
  const change = (id, value, event = 'change') => {
    const element = nodes.get(`picture-${id}`);
    element.value = value;
    element.dispatchEvent(new Event(event));
  };

  setItem(favorite);
  assert.equal(nodes.get('player-picture-slot').hasAttribute('inert'), false);
  view.dispatchEvent(new Event('resize'));
  assert.equal(afterResize, undefined);
  assert.equal(panelReads, 0);
  toggle('open');
  assert.equal(panel.style.left, '12px');
  assert.equal(panelReads, 1);
  view.innerWidth = 1000;
  view.dispatchEvent(new Event('resize'));
  videoBounds = rect(190, 180, 500, 400);
  finishResize();
  assert.equal(panel.style.left, '668px');
  assert.equal(panelReads, 2);
  // The contained picture ends above the panel, even though the video element overlaps it.
  videoBounds = rect(300, 0, 420, 316);
  view.dispatchEvent(new Event('resize'));
  finishResize();
  assert.equal(panel.style.left, '');
  assert.equal(panelReads, 3);
  videoBounds = rect(190, 180, 500, 400);
  view.dispatchEvent(new Event('resize'));
  finishResize();
  assert.equal(panel.style.left, '668px');
  change('brightness', '125', 'input');
  assert.equal(video.style.filter, 'brightness(125%)');
  assert.equal(storage.getItem(PICTURE_STORAGE_KEY), null);
  change('brightness', '125');
  change('fit', 'zoom-125');
  quality.setLevels(source, [videoQualityLevel(low, 0)]);
  assert.equal(nodes.get('picture-quality-row').hidden, true);
  quality.setLevels(source, [videoQualityLevel(low, 0), videoQualityLevel(high, 1)]);
  assert.equal(nodes.get('picture-quality-row').hidden, false);
  assert.deepEqual(select.children.map((child) => child.textContent), [
    'Auto', 'Best available', '720p \u00b7 2.8 Mbps', '360p \u00b7 600 kbps',
  ]);
  view.dispatchEvent(new Event('resize'));
  toggle('closed');
  assert.equal(panel.style.left, '');
  view.dispatchEvent(new Event('resize'));
  assert.equal(afterResize, null);
  finishResize();
  assert.equal(panelReads, 4);
  const lowUnknown = { bitrate: 600_000 };
  const highUnknown = { bitrate: 5_000_000 };
  quality.setLevels(source, [videoQualityLevel(lowUnknown, 0), videoQualityLevel(highUnknown, 1)]);
  video.videoHeight = 1080;
  quality.rendered(source, { height: 1080 });
  toggle('open');
  assert.equal(nodes.get('picture-quality-row').hidden, false);
  assert.deepEqual(select.children.map((child) => child.textContent), [
    'Auto', 'Best available', '5 Mbps', '600 kbps',
  ]);
  assert.equal(nodes.get('picture-quality-now').textContent, 'Now 1080p');
  video.videoHeight = 720;
  video.dispatchEvent(new Event('resize'));
  assert.equal(nodes.get('picture-quality-now').textContent, 'Now 720p');
  change('quality', '1');
  assert.deepEqual(loadPictureSettings().channels[favorite.id].quality, { bitrate: 600_000 });
  quality.setLevels(source, [videoQualityLevel(low, 0), videoQualityLevel(high, 1)]);
  change('quality', '0');
  assert.deepEqual(loadPictureSettings().channels[favorite.id].quality, { height: 720 });
  video.videoHeight = 0;
  quality.rendered(source, low);
  assert.equal(nodes.get('picture-quality-now').textContent, 'Now 360p');
  assert.equal(quality.fallBack(source), true);
  assert.equal(select.value, 'auto');
  assert.match(nodes.get('picture-feedback').textContent, /Using Auto for this session/);
  assert.deepEqual(loadPictureSettings().channels[favorite.id].quality, { height: 720 });
  change('scope', 'all');
  change('quality', 'best');
  assert.equal(nodes.get('picture-quality-hint').hidden, false);
  assert.equal(loadPictureSettings().main.quality, 'best');
  change('brightness', '110');
  quality.setLevels(source, [videoQualityLevel(low, 0)]);
  assert.equal(nodes.get('picture-quality-row').hidden, true);
  assert.equal(nodes.get('picture-quality-now').textContent, '');
  assert.deepEqual(select.children, []);
  quality.setLevels(source, [videoQualityLevel(low, 0), videoQualityLevel(high, 1)]);
  assert.equal(select.children.length, 4);
  toggle('closed');
  assert.equal(video.style.filter, 'brightness(125%)');
  assert.equal(video.classList.contains('video-fit-zoom-125'), true);
  toggle('open');
  video.videoHeight = 540;
  toggle('closed');
  video.videoHeight = 720;
  toggle('open');
  assert.equal(nodes.get('picture-quality-now').textContent, 'Now 720p');
  setItem(playlistOnly);
  assert.equal(nodes.get('picture-quality-row').hidden, true);
  assert.equal(nodes.get('picture-quality-now').textContent, '');
  assert.deepEqual(select.children, []);
  assert.equal(video.style.filter, 'brightness(110%)');
  toggle('open');
  change('fit', 'fill');
  toggle('closed');
  assert.deepEqual(Object.keys(loadPictureSettings().channels).sort(), [favorite.id, playlistOnly.id]);

  removeFavorite(favorite.id);
  assert.deepEqual(Object.keys(loadPictureSettings().channels).sort(), [favorite.id, playlistOnly.id]);
  await removePlaylist('mine', async () => ({}));
  assert.deepEqual(Object.keys(loadPictureSettings().channels), []);
  assert.equal(video.classList.contains('video-fit-fill'), false);

  setItem(unsaved);
  toggle('open');
  assert.equal(nodes.get('picture-session-note').hidden, false);
  change('hue', '30');
  assert.equal(video.style.filter, 'brightness(110%) hue-rotate(30deg)');
  assert.deepEqual(Object.keys(loadPictureSettings().channels), []);
  setItem(null);
  assert.equal(nodes.get('player-picture-slot').hasAttribute('inert'), true);
  setItem(unsaved);
  assert.equal(video.style.filter, 'brightness(110%) hue-rotate(30deg)');
  await clearCache();
  assert.equal(storage.getItem(PICTURE_STORAGE_KEY), null);
  assert.equal(Object.hasOwn(video.style, 'filter'), false);
  toggle('open');
  assert.equal(select.value, 'auto');
  change('fit', 'zoom-133');
  nodes.get('picture-reset').dispatchEvent(new Event('click'));
  assert.deepEqual([...video.classList.values], []);

  setItem({ id: 'video:film', type: 'video' });
  toggle('open');
  assert.equal(nodes.get('picture-scope-channel').disabled, true);
  assert.equal(nodes.get('picture-scope').value, 'all');
});

test('the Picture controls are labelled, and live CSS hides only the three timeline controls', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  assert.match(html, /id="player-picture-slot" class="player-picture-slot" inert>\s*<button[^>]* popovertarget="picture-panel">Picture<\/button>/);
  assert.match(css, /\.player-picture-slot \{ display: flex; flex: none; \}/);
  assert.match(html, /<video id="video-el"[^>]*\bcontrols controlslist="nodownload"/);
  assert.match(css, /\.video-size-btn \{\s*position: absolute;\s*top: 8px;\s*right: 8px;/);
  const hiddenSlot = [...css.matchAll(/\.player-picture-slot\[inert\] \{([^}]*)\}/g)];
  assert.deepEqual(hiddenSlot.map((rule) => rule[1].trim()), ['display: none;']);
  assert.match(html, /id="picture-panel"[^>]* popover="auto" role="dialog" aria-labelledby="picture-heading"/);
  for (const name of ['scope', 'fit', 'brightness', 'contrast', 'saturation', 'hue']) {
    assert.match(html, new RegExp(`<label for="picture-${name}">[^<]+</label>`));
  }
  assert.match(html, /<label for="picture-quality"[^>]*>Quality<\/label>/);
  assert.match(html, /<select id="picture-quality" aria-describedby="picture-quality-now picture-quality-hint"/);
  assert.match(css, /\.picture-panel select \{[^}]*appearance: none;[^}]*border: 1px solid var\(--border\);[^}]*background-image:/);
  assert.match(css, /\.picture-panel select:enabled:hover,[^{]*\{\s*background-color: var\(--bg-elev-3\);\s*border-color: var\(--border-strong\);\s*\}/);
  assert.match(css, /video\.video-fit-fill \{ object-fit: cover; \}/);
  for (const zoom of [110, 125, 133]) {
    assert.match(css, new RegExp(`video\\.video-fit-zoom-${zoom} \\{ object-view-box: inset\\(`));
  }
  assert.deepEqual([...css.matchAll(/\.is-live-video::-webkit-media-controls-([\w-]+)/g)].map((match) => match[1]),
    ['timeline', 'current-time-display', 'time-remaining-display']);
});

test('native controls use a short scrim and keep the play and fullscreen buttons shadow-free', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  assert.match(html, /<video id="video-el"[^>]*\scontrols\b/);
  assert.match(css, /#video-el::-webkit-media-controls-panel \{[^}]*rgb\(0 0 0 \/ 55%\), transparent 48px/);
  assert.match(css, /#video-el:fullscreen::-webkit-media-controls-panel \{[^}]*transparent 64px/);
  assert.match(css, /#video-el::-webkit-media-controls-timeline \{[^}]*filter: drop-shadow/);
  const shadowRules = [...css.matchAll(/([^{}]+)\{[^{}]*filter:\s*drop-shadow[^{}]*\}/g)];
  for (const [, selectors] of shadowRules) {
    assert.doesNotMatch(selectors, /::-webkit-media-controls-(?:play|fullscreen|overlay-play)-button/);
  }
  assert.match(css, /\.is-live-video::-webkit-media-controls-timeline,[^}]*display: none !important/);
});
