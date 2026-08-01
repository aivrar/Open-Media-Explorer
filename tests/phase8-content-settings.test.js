import test from 'node:test';
import assert from 'node:assert/strict';

import {
  favoriteForContentView, filterContentItems, isContentAllowed,
} from '../src/lib/content-rating.js';
import {
  STORAGE_KEYS, clearCache, getState, initState, normalizeSettings, saveSettings,
  setCurrentItem, setShowExplicitContent, setSourceEnabled, subscribe,
} from '../src/lib/state.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function fakeDocument() {
  return {
    documentElement: {
      setAttribute() {}, removeAttribute() {},
    },
  };
}

test('explicit-content migration is exact-true only and ordinary settings cannot enable it', (t) => {
  t.mock.method(console, 'warn', () => {});
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  globalThis.localStorage = new MemoryStorage();
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  });
  for (const value of [undefined, null, false, 1, 'true', [], {}, 'false']) {
    assert.equal(normalizeSettings({ showExplicitContent: value }).showExplicitContent, false);
  }
  assert.equal(normalizeSettings({ showExplicitContent: true }).showExplicitContent, true);

  clearCache();
  saveSettings({ showExplicitContent: true, theme: 'dark' });
  assert.equal(getState().settings.showExplicitContent, false);
  assert.equal(getState().settings.theme, 'dark');
  setShowExplicitContent(true);
  assert.equal(getState().settings.showExplicitContent, true);
  saveSettings({ recordingQuality: 'high' });
  assert.equal(getState().settings.showExplicitContent, true);
  setShowExplicitContent(false);
  assert.equal(getState().settings.showExplicitContent, false);
});

test('shared predicate hides only explicit items and derives a nonrevealing favorite view', () => {
  const safe = { id: 'safe', content_rating: 'not-explicit' };
  const unrated = { id: 'unrated', content_rating: 'unrated' };
  const explicit = {
    id: 'secret', source: 'peertube', type: 'video', title: 'Revealing title',
    description: 'Revealing description', thumbnail: 'https://example.test/revealing.jpg',
    stream_url: 'https://example.test/revealing.m3u8', source_url: 'https://example.test/watch',
    tags: ['revealing'], content_rating: 'explicit', futureField: { preserve: true },
  };
  assert.deepEqual(filterContentItems([safe, explicit, unrated], false), [safe, unrated]);
  assert.equal(isContentAllowed(explicit, false), false);
  assert.equal(isContentAllowed(explicit, { showExplicitContent: true }), true);
  const hidden = favoriteForContentView(explicit, false);
  assert.equal(hidden.id, explicit.id);
  assert.equal(hidden.source, explicit.source);
  assert.equal(hidden.__contentHidden, true);
  assert.equal(JSON.stringify(hidden).includes('Revealing'), false);
  assert.equal(JSON.stringify(hidden).includes('example.test'), false);
  assert.equal(favoriteForContentView(explicit, true), explicit);
  assert.equal(explicit.futureField.preserve, true, 'the persisted favorite is never mutated');
});

test('cache reset emits the same fail-closed policy transition with the active item', (t) => {
  t.mock.method(console, 'warn', () => {});
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  globalThis.localStorage = new MemoryStorage();
  globalThis.document = fakeDocument();
  const item = { id: 'owncast:marked', content_rating: 'explicit' };
  const events = [];
  const off = subscribe('content-policy-change', (event) => events.push(event));
  t.after(() => {
    off();
    setCurrentItem(null);
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  });

  clearCache();
  setCurrentItem(item);
  setShowExplicitContent(true);
  events.length = 0;
  clearCache();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { previous: true, current: false, currentItem: item });
  assert.equal(getState().settings.showExplicitContent, false);
});

test('isolated 58-favorite migration preserves IDs, unknown fields, settings, and source disablement', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const favorites = Array.from({ length: 58 }, (_, index) => ({
    id: `legacy:${index}`, title: `Favorite ${index}`, description: '', source: 'legacy-source',
    type: index % 2 ? 'audio' : 'video', stream_url: `https://media.example/${index}.mp3`,
    stream_kind: 'audio', tags: [], futureItemField: { index },
  }));
  const settings = {
    version: 77, theme: 'forest', defaultMode: 'grid', recordingQuality: 'high',
    enabledSources: { 'radio-browser': false, 'future-source': false },
    futureSetting: { preserve: true }, showExplicitContent: 'true',
  };
  const storage = new MemoryStorage({
    [STORAGE_KEYS.favorites]: JSON.stringify(favorites),
    [STORAGE_KEYS.settings]: JSON.stringify(settings),
    'worldmedia.eq.v1': JSON.stringify({ version: 1, favorite: { 'legacy:0': { preamp: 3 } } }),
  });
  globalThis.localStorage = storage;
  globalThis.document = fakeDocument();
  try {
    clearCache();
    storage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
    storage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    storage.setItem('worldmedia.eq.v1', JSON.stringify({ version: 1, favorite: { 'legacy:0': { preamp: 3 } } }));
    await initState();
    assert.equal(getState().favorites.length, 58);
    assert.deepEqual(getState().favorites.map(({ id }) => id), favorites.map(({ id }) => id));
    assert.deepEqual(getState().favorites[37].futureItemField, { index: 37 });
    assert.equal(getState().settings.version, 77);
    assert.equal(getState().settings.theme, 'forest');
    assert.equal(getState().settings.defaultMode, 'grid');
    assert.equal(getState().settings.recordingQuality, 'high');
    assert.deepEqual(getState().settings.futureSetting, { preserve: true });
    assert.equal(getState().settings.enabledSources['radio-browser'], false);
    assert.equal(getState().settings.enabledSources['future-source'], false);
    assert.equal(getState().settings.showExplicitContent, false);
    setSourceEnabled('radio-browser', true);
    assert.equal(getState().favorites.length, 58);
    assert.deepEqual(getState().favorites.map(({ id }) => id), favorites.map(({ id }) => id));
    assert.match(storage.getItem('worldmedia.eq.v1'), /legacy:0/);
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.document = originalDocument;
  }
});
