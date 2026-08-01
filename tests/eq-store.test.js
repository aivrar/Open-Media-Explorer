import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EQ_STORAGE_KEY,
  addFavoriteEq,
  deleteFavoriteEq,
  freshEqState,
  getEffectiveEq,
  loadEqState,
  normalizeEqCurve,
  normalizeEqState,
  removeCustomEqPreset,
  saveEqState,
  setCustomEqPreset,
  setScopedEq,
} from '../src/lib/eq-store.js';
import { getRecordingProfile, normalizeRecordingQuality } from '../src/lib/recording-profiles.js';
import {
  STORAGE_KEYS,
  addFavorite,
  clearCache,
  getState,
  initState,
  normalizeFavoriteItem,
  normalizeSettings,
  persistFavoriteMetadata,
  removeFavorite,
  setCurrentItem,
  subscribe,
} from '../src/lib/state.js';
import { makeItem } from '../src/lib/item-model.js';
import { createFakeDocument } from './helpers/fake-dom.js';

class MemoryStorage {
  constructor(entries = {}) { this.data = new Map(Object.entries(entries)); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

test('EQ validation clamps curves and preserves future-version extensions', () => {
  const state = normalizeEqState({
    version: 99,
    futureFlag: true,
    global: { preamp: 50, bands: [-99, 3, 'bad'], presetId: '' },
    favorites: { 'source:item': { preamp: -50, bands: [2], presetId: 'custom' }, bad: null },
    customPresets: { one: { name: '  My preset  ', preamp: 2, bands: [1] } },
  });
  assert.equal(state.version, 99);
  assert.equal(state.futureFlag, true);
  assert.equal(state.global.preamp, 6);
  assert.equal(state.global.bypassed, false);
  assert.deepEqual(state.global.bands.slice(0, 3), [-12, 3, 0]);
  assert.equal(state.global.bands.length, 10);
  assert.equal(state.global.presetId, 'flat');
  assert.equal(state.favorites['source:item'].preamp, -12);
  assert.equal(state.customPresets.one.name, 'My preset');
});

test('EQ map normalization treats hostile object keys as data and rejects unsafe preset IDs', () => {
  const favorites = JSON.parse('{"__proto__":{"preamp":-2,"bands":[1]}}');
  const customPresets = JSON.parse('{"__proto__":{"name":"bad"},"safe-id":{"name":"Safe"}}');
  const state = normalizeEqState({ favorites, customPresets });
  assert.equal(Object.hasOwn(state.favorites, '__proto__'), true);
  assert.equal(state.favorites.__proto__.preamp, -2);
  assert.equal(Object.getPrototypeOf(state.favorites), Object.prototype);
  assert.equal(Object.hasOwn(state.customPresets, '__proto__'), false);
  assert.equal(state.customPresets['safe-id'].name, 'Safe');
});

test('corrupt EQ storage falls back safely and favorite transitions clone/delete curves', () => {
  const storage = new MemoryStorage({ [EQ_STORAGE_KEY]: '{broken' });
  assert.deepEqual(loadEqState(storage), freshEqState());

  const original = normalizeEqState({ global: { preamp: -2, bands: [4, 3], presetId: 'bass' } });
  const favorited = addFavoriteEq(original, 'source:item');
  assert.deepEqual(getEffectiveEq(favorited, 'source:item', true), normalizeEqCurve(original.global));
  assert.notEqual(favorited.favorites['source:item'].bands, favorited.global.bands);
  const staleOrphan = normalizeEqState({
    global: { preamp: -2, bands: [4, 3], presetId: 'bass' },
    favorites: { 'source:item': { preamp: 9, bands: [9], presetId: 'stale' } },
  });
  const repaired = addFavoriteEq(staleOrphan, 'source:item', staleOrphan.global);
  assert.deepEqual(repaired.favorites['source:item'], normalizeEqCurve(staleOrphan.global));
  const removed = deleteFavoriteEq('source:item', new MemoryStorage({
    [EQ_STORAGE_KEY]: JSON.stringify(saveEqState(favorited, new MemoryStorage())),
  }));
  assert.equal(removed.favorites['source:item'], undefined);
});

test('global, favorite, and custom preset snapshots remain independently scoped', () => {
  let state = freshEqState();
  const global = normalizeEqCurve({ preamp: -4, bands: [6, 3], presetId: 'bass-boost' });
  const favoriteOne = normalizeEqCurve({ preamp: -2, bands: [0, 5], presetId: 'manual' });
  const favoriteTwo = normalizeEqCurve({ preamp: -6, bands: [-3, 0, 7], presetId: 'custom:preset-two' });
  state = setScopedEq(state, 'ignored', false, global);
  state = setScopedEq(state, 'source:one', true, favoriteOne);
  state = setScopedEq(state, 'source:two', true, favoriteTwo);
  state = setCustomEqPreset(state, 'preset-one', 'First preset', favoriteOne);
  state = setCustomEqPreset(state, 'preset-two', '  Second preset  ', favoriteTwo);

  assert.deepEqual(getEffectiveEq(state, 'nonfavorite:a', false), global);
  assert.deepEqual(getEffectiveEq(state, 'nonfavorite:b', false), global);
  assert.deepEqual(getEffectiveEq(state, 'source:one', true), favoriteOne);
  assert.deepEqual(getEffectiveEq(state, 'source:two', true), favoriteTwo);
  assert.equal(state.customPresets['preset-two'].name, 'Second preset');
  assert.equal(state.customPresets['preset-one'].name, 'First preset');
  assert.notEqual(state.customPresets['preset-two'].bands, state.favorites['source:two'].bands);

  const storage = new MemoryStorage();
  saveEqState(state, storage);
  const restarted = loadEqState(storage);
  assert.deepEqual(getEffectiveEq(restarted, 'source:one', true), favoriteOne);
  assert.deepEqual(getEffectiveEq(restarted, 'source:two', true), favoriteTwo);
  assert.deepEqual(restarted.customPresets['preset-one'].bands, favoriteOne.bands);
  assert.deepEqual(restarted.customPresets['preset-two'].bands, favoriteTwo.bands);
  state = removeCustomEqPreset(restarted, 'preset-two');
  assert.equal(state.customPresets['preset-two'], undefined);
  assert.deepEqual(state.favorites['source:two'], favoriteTwo, 'deleting a template keeps scope snapshot');
});

test('favorite transition flush hook runs before the audible global curve is cloned', () => {
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  globalThis.document = createFakeDocument();
  try {
    clearCache();
    const item = makeItem({
      id: 'test:debounced-favorite', title: 'Debounced favorite', description: '',
      source: 'test', type: 'audio', stream_url: 'https://media.example/test.mp3',
      stream_kind: 'audio', delivery: 'on-demand', tags: [],
    });
    const audible = normalizeEqCurve({ preamp: -5, bands: [6, 4], presetId: 'manual' });
    const order = [];
    const before = subscribe('eq-before-scope-change', ({ itemId }) => {
      if (itemId !== item.id) return;
      order.push('flush');
      saveEqState(setScopedEq(loadEqState(storage), item.id, false, audible), storage);
    });
    const after = subscribe('eq-scope-change', () => order.push('scope'));
    setCurrentItem(item);
    addFavorite(item);
    assert.deepEqual(order, ['flush', 'scope']);
    assert.deepEqual(loadEqState(storage).favorites[item.id], audible);
    before(); after();
    removeFavorite(item.id);
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  }
});

test('settings/favorites migration validates known fields without deleting future data', () => {
  const settings = normalizeSettings({
    version: 8,
    futureFlag: 'keep',
    theme: 'neon',
    defaultMode: 'future-mode',
    recordingEnabled: false,
    recordingQuality: 'high',
    enabledSources: { 'radio-browser': false, 'future-source': true, nasa: 'bad' },
  });
  assert.equal(settings.version, 8);
  assert.equal(settings.futureFlag, 'keep');
  assert.equal(settings.theme, 'system');
  assert.equal(settings.defaultMode, 'library');
  assert.equal(settings.recordingEnabled, false);
  assert.equal(settings.recordingQuality, 'high');
  assert.equal(settings.enabledSources['radio-browser'], false);
  assert.equal(settings.enabledSources['future-source'], true);
  assert.equal(settings.enabledSources.nasa, true);

  const favorite = normalizeFavoriteItem({
    id: 'legacy:item', title: 'Legacy', description: '', source: 'legacy', type: 'audio',
    stream_url: 'https://media.example/legacy.mp3', stream_kind: 'audio', tags: [],
    futureField: { keep: true },
  });
  assert.equal(favorite.delivery, 'on-demand');
  assert.equal(favorite.download_url, favorite.stream_url);
  assert.deepEqual(favorite.capture_headers, {});
  assert.deepEqual(favorite.futureField, { keep: true });

  const expired = normalizeFavoriteItem({
    id: 'media-ccc:stable-event', title: 'Restart me', source: 'media-ccc', type: 'video',
    stream_url: '/api/v1/media/expired_media_token_1234567890',
    stream_kind: 'video', delivery: 'on-demand',
    download_url: '/api/v1/media/expired_download_token_123456',
    download_name: 'restart.mp4',
    thumbnail: '/api/v1/assets/expired_asset_token_1234567890',
    _extra: { guid: 'stable-event', needsResolve: false, downloadResolved: true },
  });
  assert.equal(expired.id, 'media-ccc:stable-event');
  assert.equal(expired.stream_url, '');
  assert.equal(expired.download_url, '');
  assert.equal(expired.download_name, '');
  assert.equal(expired.thumbnail, '');
  assert.equal(expired._extra.guid, 'stable-event');
  assert.equal(expired._extra.needsResolve, true);
  assert.equal(expired._extra.downloadResolved, false);
  assert.equal(expired._extra.needsArtwork, true);
  assert.equal(expired._extra.resolutionStatus, 'unresolved');

  const canonical = {
    id: 'peertube:stable-video', title: 'Revalidate me', source: 'peertube', type: 'video',
    stream_url: 'https://video.example/hls/master.m3u8', stream_kind: 'hls',
    delivery: 'on-demand', download_url: 'https://video.example/download.mp4',
    download_name: 'video.mp4',
    _extra: {
      uuid: 'stable-video', watchUrl: 'https://video.example/w/stable-video',
      needsResolve: false, downloadResolved: true, resolutionStatus: 'playable',
      restartResolve: true,
    },
  };
  assert.equal(normalizeFavoriteItem(canonical).stream_url, canonical.stream_url,
    'ordinary in-session persistence keeps the resolved runtime capability');
  const restarted = normalizeFavoriteItem(canonical, { restart: true });
  assert.equal(restarted.id, canonical.id);
  assert.equal(restarted.stream_url, '');
  assert.equal(restarted.download_url, '');
  assert.equal(restarted.download_name, '');
  assert.equal(restarted._extra.uuid, 'stable-video');
  assert.equal(restarted._extra.needsResolve, true);
  assert.equal(restarted._extra.downloadResolved, false);
  assert.equal(restarted._extra.resolutionStatus, 'unresolved');
});

test('recording profiles are versioned, validated, and match approved quality levels', () => {
  assert.equal(normalizeRecordingQuality('invalid'), 'balanced');
  assert.deepEqual(getRecordingProfile('compact'), {
    id: 'compact', audioBitrateKbps: 96, videoMaxHeight: 480, videoCrf: 27, videoAudioBitrateKbps: 96,
  });
  assert.deepEqual(getRecordingProfile('balanced'), {
    id: 'balanced', audioBitrateKbps: 160, videoMaxHeight: 720, videoCrf: 23, videoAudioBitrateKbps: 160,
  });
  assert.deepEqual(getRecordingProfile('high'), {
    id: 'high', audioBitrateKbps: 256, videoMaxHeight: 1080, videoCrf: 20, videoAudioBitrateKbps: 192,
  });
});

test('initState migrates corrupt, legacy, partial, and future-version localStorage safely', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const storage = new MemoryStorage({
    [STORAGE_KEYS.favorites]: '{broken',
    [STORAGE_KEYS.settings]: '{broken',
  });
  globalThis.localStorage = storage;
  globalThis.document = createFakeDocument();
  try {
    clearCache();
    storage.setItem(STORAGE_KEYS.favorites, '{broken');
    storage.setItem(STORAGE_KEYS.settings, '{broken');
    await initState();
    assert.deepEqual(getState().favorites, []);
    assert.equal(getState().settings.recordingQuality, 'balanced');

    storage.setItem(STORAGE_KEYS.favorites, JSON.stringify([{
      id: 'legacy:one', title: 'Legacy One', description: '', source: 'legacy', type: 'audio',
      stream_url: 'https://media.example/one.mp3', stream_kind: 'audio', tags: [], futureItemField: 7,
    }]));
    storage.setItem(STORAGE_KEYS.settings, JSON.stringify({
      version: 42, theme: 'dark', futureSetting: true,
      enabledSources: { 'radio-browser': false },
    }));
    await initState();
    assert.equal(getState().favorites[0].delivery, 'on-demand');
    assert.equal(getState().favorites[0].download_url, getState().favorites[0].stream_url);
    assert.equal(getState().favorites[0].futureItemField, 7);
    assert.equal(getState().settings.version, 42);
    assert.equal(getState().settings.futureSetting, true);
    assert.equal(getState().settings.theme, 'dark');
    assert.equal(getState().settings.recordingQuality, 'balanced');
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  }
});

test('state favorite transitions persist EQ scope and clear cache preserves media/tool sentinels', () => {
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  globalThis.document = createFakeDocument();
  try {
    clearCache();
    saveEqState(normalizeEqState({ global: { preamp: -3, bands: [5, 4], presetId: 'bass' } }), storage);
    const item = makeItem({
      id: 'test:favorite', title: 'Favorite', description: '', source: 'test', type: 'audio',
      stream_url: 'https://media.example/favorite.mp3', stream_kind: 'audio',
      delivery: 'on-demand', download_url: 'https://media.example/favorite.mp3', tags: [],
    });
    setCurrentItem(item);
    const scopes = [];
    const unsubscribe = subscribe('eq-scope-change', (value) => scopes.push(value.scope));
    addFavorite(item);
    const afterAdd = loadEqState(storage);
    assert.equal(getState().favorites.some((entry) => entry.id === item.id), true);
    assert.deepEqual(afterAdd.favorites[item.id], normalizeEqCurve(afterAdd.global));
    removeFavorite(item.id);
    assert.equal(loadEqState(storage).favorites[item.id], undefined);
    assert.deepEqual(scopes, ['favorite', 'global']);
    unsubscribe();

    for (const key of Object.values(STORAGE_KEYS)) storage.setItem(key, 'remove');
    storage.setItem(EQ_STORAGE_KEY, '{}');
    storage.setItem('worldmedia.downloads.keep', 'media');
    storage.setItem('worldmedia.ffmpeg.keep', 'tool');
    clearCache();
    for (const key of [...Object.values(STORAGE_KEYS), EQ_STORAGE_KEY]) assert.equal(storage.getItem(key), null);
    assert.equal(storage.getItem('worldmedia.downloads.keep'), 'media');
    assert.equal(storage.getItem('worldmedia.ffmpeg.keep'), 'tool');
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  }
});

test('dynamic favorite persistence cannot erase a freshly resolved runtime stream', () => {
  const originalStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  const item = makeItem({
    id: 'owncast:stable-instance', title: 'Live favorite', source: 'owncast', type: 'tv',
    stream_url: '', stream_kind: 'hls', delivery: 'live',
    _extra: { instanceUrl: 'https://live.example/', snapshotItem: true, needsResolve: true },
  });
  try {
    addFavorite(item);
    const runtimeFavorite = getState().favorites.find((favorite) => favorite.id === item.id);
    runtimeFavorite.stream_url = 'https://live.example/hls/stream.m3u8';
    runtimeFavorite._extra.needsResolve = false;
    runtimeFavorite._extra.resolutionStatus = 'playable';
    setCurrentItem(runtimeFavorite);
    assert.equal(persistFavoriteMetadata(runtimeFavorite), true);
    assert.equal(runtimeFavorite.stream_url, 'https://live.example/hls/stream.m3u8');
    assert.equal(getState().currentItem, runtimeFavorite);
    const persistedFavorite = getState().favorites.find((favorite) => favorite.id === item.id);
    assert.notEqual(persistedFavorite, runtimeFavorite);
    assert.equal(persistedFavorite.stream_url, '');
    assert.equal(persistedFavorite._extra.needsResolve, true);
    const disk = JSON.parse(storage.getItem(STORAGE_KEYS.favorites));
    assert.equal(disk[0].stream_url, '');
    assert.equal(disk[0].id, item.id);
  } finally {
    removeFavorite(item.id);
    setCurrentItem(null);
    globalThis.localStorage = originalStorage;
  }
});
