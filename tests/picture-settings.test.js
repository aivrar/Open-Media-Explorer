import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeElement } from './helpers/fake-dom.js';
import { bindPicturePanel } from '../src/lib/picture-panel.js';
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
  const picture = { main: { brightness: 124, fit: 'fill' }, channels: { 'tv:one': { hue: 20, fit: 'zoom-110' } } };
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
    'picture-hue', 'picture-reset',
  ];
  const nodes = new Map(ids.map((id) => [id, new FakeElement(id)]));
  nodes.get('player-picture-slot').setAttribute('inert', '');
  const video = videoElement();
  const setItem = bindPicturePanel(video, (id) => nodes.get(id));
  const panel = nodes.get('picture-panel');
  const toggle = (newState) => panel.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState }));
  panel.hidePopover = () => toggle('closed');
  const change = (id, value, event = 'change') => {
    const element = nodes.get(`picture-${id}`);
    element.value = value;
    element.dispatchEvent(new Event(event));
  };

  setItem(favorite);
  assert.equal(nodes.get('player-picture-slot').hasAttribute('inert'), false);
  toggle('open');
  change('brightness', '125', 'input');
  assert.equal(video.style.filter, 'brightness(125%)');
  assert.equal(storage.getItem(PICTURE_STORAGE_KEY), null);
  change('brightness', '125');
  change('fit', 'zoom-125');
  change('scope', 'all');
  change('brightness', '110');
  toggle('closed');
  assert.equal(video.style.filter, 'brightness(125%)');
  assert.equal(video.classList.contains('video-fit-zoom-125'), true);
  setItem(playlistOnly);
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
  const hiddenSlot = [...css.matchAll(/\.player-picture-slot\[inert\] \{([^}]*)\}/g)];
  assert.deepEqual(hiddenSlot.map((rule) => rule[1].trim()), ['visibility: hidden;']);
  assert.match(html, /id="picture-panel"[^>]* popover="auto" role="dialog" aria-labelledby="picture-heading"/);
  for (const name of ['scope', 'fit', 'brightness', 'contrast', 'saturation', 'hue']) {
    assert.match(html, new RegExp(`<label for="picture-${name}">[^<]+</label>`));
  }
  assert.match(css, /video\.video-fit-fill \{ object-fit: cover; \}/);
  for (const zoom of [110, 125, 133]) {
    assert.match(css, new RegExp(`video\\.video-fit-zoom-${zoom} \\{ object-view-box: inset\\(`));
  }
  assert.deepEqual([...css.matchAll(/\.is-live-video::-webkit-media-controls-([\w-]+)/g)].map((match) => match[1]),
    ['timeline', 'current-time-display', 'time-remaining-display']);
});
