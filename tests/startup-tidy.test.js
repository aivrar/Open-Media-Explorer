import test from 'node:test';
import assert from 'node:assert/strict';

import { resetControlSession } from '../src/lib/capture-client.js';
import { FAVORITE_NAMES_KEY, favoriteName, resetFavoriteNamesCache, withFavoriteName } from '../src/lib/favorite-names.js';
import { FAVORITE_GROUPS_VERSION } from '../src/lib/favorite-groups.js';
import { cancelScheduledProfileHandoff, captureProfileStorage, scheduleProfileHandoff } from '../src/lib/profile-transfer.js';
import { FAVORITE_GROUPS_KEY, groupsKeptFor, namesKeptFor, tidyStorageAtStart } from '../src/lib/startup-tidy.js';
import { STORAGE_KEYS, addFavorite, getState, initState } from '../src/lib/state.js';
import { createFakeDocument } from './helpers/fake-dom.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function station(id, title) {
  return {
    id, title, description: '', source: 'radio-browser', type: 'radio', delivery: 'live',
    stream_url: `https://radio.example/${id.replace(/\W/g, '-')}`, stream_kind: 'audio', tags: [],
  };
}

const KEPT = 'radio-browser:kept';
const LEFT = 'radio-browser:left';
const names = (entries) => JSON.stringify({ version: 1, names: entries });
const groups = (assign) => JSON.stringify({ version: 1, groups: [{ id: 'g1', name: 'Rock' }], assign });

/** initState with this page storage and, when given, a data folder answering
 *  GET /api/v1/profile/preferences with `folderValues`, or failing
 *  until recover() is called. */
function beginWith(t, storage, folderValues = null, failure = '') {
  const previous = {
    localStorage: globalThis.localStorage, document: globalThis.document,
    location: globalThis.location, fetch: globalThis.fetch,
  };
  t.mock.method(console, 'warn', () => {});
  globalThis.localStorage = storage;
  globalThis.document = createFakeDocument();
  globalThis.location = { protocol: folderValues ? 'http:' : 'file:' };
  const asked = [];
  const writes = [];
  globalThis.fetch = async (path, options = {}) => {
    asked.push(`${options.method || 'GET'} ${path}`);
    const reply = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, data }) });
    if (path === '/api/v1/session') {
      if (failure === 'session') {
        failure = '';
        throw new TypeError('Failed to fetch');
      }
      return reply({ token: 'tidy-token' });
    }
    if (path === '/api/v1/profile/preferences' && (options.method || 'GET') === 'GET') {
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'status') {
        return {
          ok: false, status: 503, headers: { get: () => null },
          json: async () => ({ ok: false, error: { code: 'PROFILE_UNAVAILABLE', message: 'Not now.', retryable: true } }),
        };
      }
      if (failure === 'unreadable') return reply({ unexpected: true });
      return reply({ values: folderValues || {} });
    }
    if (path === '/api/v1/profile/preferences') writes.push(JSON.parse(options.body).values);
    return reply({ saved: true, keys: [] });
  };
  resetControlSession();
  resetFavoriteNamesCache();
  t.after(() => {
    cancelScheduledProfileHandoff();
    resetControlSession();
    resetFavoriteNamesCache();
    Object.assign(globalThis, previous);
  });
  getState().favorites = [];
  return { asked, writes, init: initState(), recover: () => { failure = ''; } };
}

async function startWith(t, storage, folderValues) {
  const { asked, init } = beginWith(t, storage, folderValues);
  await init;
  cancelScheduledProfileHandoff();
  return asked;
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

test('the tidy keeps exactly the names and category assignments of saved favorites', () => {
  assert.equal(FAVORITE_GROUPS_KEY, STORAGE_KEYS.favoriteGroups);
  assert.equal(FAVORITE_GROUPS_VERSION, 1);
  const saved = new Set([KEPT]);
  assert.equal(namesKeptFor(names({ [KEPT]: 'Mine', [LEFT]: 'Old name' }), saved), names({ [KEPT]: 'Mine' }));
  const same = names({ [KEPT]: 'Mine' });
  assert.equal(namesKeptFor(same, saved), same, 'nothing to drop: the stored text as it was');
  assert.equal(namesKeptFor(names({ [LEFT]: 'Old name' }), saved), null, 'none left: the key goes');
  // A newer layout, unreadable text, or none: left alone.
  for (const raw of [JSON.stringify({ version: 2, names: { [LEFT]: 'x' } }), '{broken', null]) {
    assert.equal(namesKeptFor(raw, saved), raw);
  }
  assert.equal(groupsKeptFor(groups({ [KEPT]: 'g1', [LEFT]: 'g1' }), saved), groups({ [KEPT]: 'g1' }));
  assert.equal(groupsKeptFor(groups({ [LEFT]: 'g1' }), saved), groups({}), 'the categories themselves stay');
  const kept = groups({ [KEPT]: 'g1' });
  assert.equal(groupsKeptFor(kept, saved), kept);
  for (const raw of [JSON.stringify({ version: 2, groups: [], assign: { [LEFT]: 'g1' } }), '{broken', null]) {
    assert.equal(groupsKeptFor(raw, saved), raw);
  }
  const storage = new MemoryStorage({ [FAVORITE_NAMES_KEY]: names({ [LEFT]: 'Old name' }), [FAVORITE_GROUPS_KEY]: kept });
  assert.deepEqual(tidyStorageAtStart(storage, [KEPT]), [FAVORITE_NAMES_KEY]);
  assert.equal(storage.getItem(FAVORITE_NAMES_KEY), null);
  assert.equal(storage.getItem(FAVORITE_GROUPS_KEY), kept);
});

test('at start-up a leftover name of a station that is no favorite goes, and starring it again shows its own name', async (t) => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.favorites]: JSON.stringify([station(KEPT, 'Kept FM')]),
    [FAVORITE_NAMES_KEY]: names({ [KEPT]: 'My station', [LEFT]: 'An old name' }),
    [FAVORITE_GROUPS_KEY]: groups({ [KEPT]: 'g1', [LEFT]: 'g1' }),
  });
  await startWith(t, storage);
  assert.deepEqual(JSON.parse(storage.getItem(FAVORITE_NAMES_KEY)).names, { [KEPT]: 'My station' });
  assert.deepEqual(JSON.parse(storage.getItem(FAVORITE_GROUPS_KEY)), JSON.parse(groups({ [KEPT]: 'g1' })));
  // What the first profile save sends to the data folder (main, extra and copy files).
  assert.deepEqual(JSON.parse(captureProfileStorage(storage)[FAVORITE_NAMES_KEY]).names, { [KEPT]: 'My station' });
  assert.equal(favoriteName(KEPT), 'My station');
  addFavorite(station(LEFT, 'Left Radio'));
  const starred = getState().favorites.find((favorite) => favorite.id === LEFT);
  assert.equal(withFavoriteName(starred).title, 'Left Radio', 'its own name, not the old one');
  assert.equal(favoriteName(LEFT), '');
});

test('on a new port the names come from the data folder first, then only the leftovers go', async (t) => {
  const storage = new MemoryStorage(); // a new port: empty page storage
  const asked = await startWith(t, storage, {
    [STORAGE_KEYS.favorites]: JSON.stringify([station(KEPT, 'Kept FM')]),
    [FAVORITE_NAMES_KEY]: names({ [KEPT]: 'My station', [LEFT]: 'An old name' }),
    [FAVORITE_GROUPS_KEY]: groups({ [KEPT]: 'g1', [LEFT]: 'g1' }),
  });
  assert.ok(asked.includes('GET /api/v1/profile/preferences'), 'restored from the data folder');
  assert.deepEqual(getState().favorites.map((favorite) => favorite.id), [KEPT]);
  // Kept: the favorite's name, restored just now (a tidy before the restore
  // would have found nothing and left the old name behind).
  assert.deepEqual(JSON.parse(storage.getItem(FAVORITE_NAMES_KEY)).names, { [KEPT]: 'My station' });
  assert.deepEqual(JSON.parse(storage.getItem(FAVORITE_GROUPS_KEY)).assign, { [KEPT]: 'g1' });
  assert.equal(favoriteName(KEPT), 'My station');
});

test('a failed restore leaves saved names and categories alone and retries the restore', async (t) => {
  for (const failure of ['network', 'status', 'unreadable']) {
    await t.test(failure, async (st) => {
      // Leftover names and categories, no profile keys: the data folder is asked.
      const storedNames = names({ [KEPT]: 'My station', [LEFT]: 'An old name' });
      const storedGroups = groups({ [KEPT]: 'g1', [LEFT]: 'g1' });
      const storage = new MemoryStorage({ [FAVORITE_NAMES_KEY]: storedNames, [FAVORITE_GROUPS_KEY]: storedGroups });
      st.mock.timers.enable({ apis: ['setTimeout'] });
      const { asked, writes, init, recover } = beginWith(st, storage, {}, failure);
      await drain();
      assert.deepEqual(asked, ['GET /api/v1/session', 'GET /api/v1/profile/preferences']);
      assert.equal(scheduleProfileHandoff(), false);
      st.mock.timers.tick(999);
      assert.equal(storage.getItem(FAVORITE_NAMES_KEY), storedNames);
      assert.equal(storage.getItem(FAVORITE_GROUPS_KEY), storedGroups);
      assert.deepEqual(writes, []);
      recover();
      st.mock.timers.tick(1);
      await init;
      assert.equal(asked.filter((call) => call === 'GET /api/v1/profile/preferences').length, 2);
      st.mock.timers.tick(350);
      await drain();
      assert.equal(writes.length, 1, 'saving resumes once the server confirms there is no profile');
    });
  }
});

test('a failed first session lookup never writes an empty startup profile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = new MemoryStorage();
  const expected = {
    [STORAGE_KEYS.favorites]: JSON.stringify([station(KEPT, 'Kept FM')]),
    [STORAGE_KEYS.settings]: '{"theme":"forest"}',
  };
  const { asked, writes, init } = beginWith(t, storage, expected, 'session');
  await drain();
  assert.deepEqual(asked, ['GET /api/v1/session']);
  assert.equal(scheduleProfileHandoff(), false);
  t.mock.timers.tick(999);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  await init;
  assert.equal(getState().settings.theme, 'forest');
  t.mock.timers.tick(350);
  await drain();
  assert.deepEqual(asked, [
    'GET /api/v1/session', 'GET /api/v1/session',
    'GET /api/v1/profile/preferences', 'POST /api/v1/profile/preferences',
  ]);
  assert.deepEqual(writes, [captureProfileStorage(storage)]);
  assert.deepEqual(JSON.parse(writes[0][STORAGE_KEYS.favorites]).map(({ id }) => id), [KEPT]);
  assert.equal(writes[0][STORAGE_KEYS.settings], expected[STORAGE_KEYS.settings]);
});

test('a restore that answers with nothing to restore is followed by the tidy', async (t) => {
  const storage = new MemoryStorage({
    [FAVORITE_NAMES_KEY]: names({ [LEFT]: 'An old name' }),
    [FAVORITE_GROUPS_KEY]: groups({ [LEFT]: 'g1' }),
  });
  const asked = await startWith(t, storage, {});
  assert.ok(asked.includes('GET /api/v1/profile/preferences'));
  assert.equal(storage.getItem(FAVORITE_NAMES_KEY), null);
  assert.deepEqual(JSON.parse(storage.getItem(FAVORITE_GROUPS_KEY)).assign, {});
});

test('favorites that cannot be read leave every name alone', async (t) => {
  const stored = names({ [KEPT]: 'My station', [LEFT]: 'An old name' });
  const storage = new MemoryStorage({ [STORAGE_KEYS.favorites]: '{broken', [FAVORITE_NAMES_KEY]: stored });
  await startWith(t, storage);
  assert.equal(storage.getItem(FAVORITE_NAMES_KEY), stored);
});
