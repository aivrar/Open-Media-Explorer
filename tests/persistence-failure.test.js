import test from 'node:test';
import assert from 'node:assert/strict';
import { addFavorite, removeFavorite, getState, STORAGE_KEYS, subscribe, persistFavoriteMetadata } from '../src/lib/state.js';
import { getPersistenceWarnings, clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { scheduleProfileHandoff, cancelScheduledProfileHandoff } from '../src/lib/profile-transfer.js';

test('failed favorites writes preserve saved/in-memory list, EQ and UI events; retry succeeds', () => {
  const previousStorage = globalThis.localStorage;
  const state = getState();
  const previousFavorites = state.favorites;
  const values = new Map();
  let fail = false;
  let events = 0;
  const off = subscribe('favorites-change', () => events++);
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (fail && key === STORAGE_KEYS.favorites) throw new Error('Quota exceeded');
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  state.favorites = [];
  try {
    const first = { id: 'test:first', title: 'First', type: 'radio', source: 'radio-browser' };
    assert.equal(addFavorite(first), true);
    const saved = new Map(values);
    fail = true;
    assert.equal(addFavorite({ ...first, id: 'test:second' }), false);
    assert.equal(removeFavorite(first.id), false);
    assert.equal(persistFavoriteMetadata({ ...first, title: 'Changed' }), false);
    assert.deepEqual(values, saved);
    assert.equal(state.favorites.length, 1);
    assert.equal(state.favorites[0].title, 'First');
    assert.equal(events, 1);
    assert.match(getPersistenceWarnings().join(' '), /Favorites could not be saved/);
    fail = false;
    assert.equal(removeFavorite(first.id), true);
    assert.equal(state.favorites.length, 0);
    assert.equal(events, 2);
    assert.equal(getPersistenceWarnings().length, 0);
  } finally {
    off();
    state.favorites = previousFavorites;
    globalThis.localStorage = previousStorage;
    clearPersistenceFailure('favorites');
  }
});

test('background native-backup failures stay visible until a successful retry', async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:' };
  const storage = { getItem: () => null };
  try {
    scheduleProfileHandoff({ delayMs: 0, storage, requestImpl: async () => { throw new Error('Disk full'); } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(getPersistenceWarnings().join(' '), /portable profile backup could not be updated/);
    scheduleProfileHandoff({ delayMs: 0, storage, requestImpl: async () => ({}) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getPersistenceWarnings().length, 0);
  } finally {
    cancelScheduledProfileHandoff();
    clearPersistenceFailure('profile-backup');
    globalThis.location = previousLocation;
  }
});
