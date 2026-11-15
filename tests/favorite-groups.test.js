import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assignFavoriteToGroup, checkGroupName, cleanGroupName, createFavoriteGroup, deleteFavoriteGroup,
  FAVORITE_GROUPS_EVENT, favoriteGroupCounts, favoriteGroupOf, favoriteGroupsSnapshot, getFavoriteGroups,
  MAX_FAVORITE_GROUPS, pruneFavoriteGroups, renameFavoriteGroup,
} from '../src/lib/favorite-groups.js';
import {
  clearCache, getState, normalizeSettings, persistFavoriteMetadata, removeFavorite, STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { favoriteStations, keptFavoriteSource, tunerFavoriteGroups } from '../src/modes/tuner.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const KEY = 'worldmedia.favgroups.v1';
const fav = (id, title = id, extra = {}) => ({ id, title, type: 'radio', source: 'radio-browser', ...extra });

/** A fake localStorage that counts category writes and can refuse them,
 *  plus a count of category events. */
function withStore(favorites, fn, { stored = undefined, settings = {} } = {}) {
  const state = getState();
  const previous = { favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage };
  const values = new Map();
  if (stored !== undefined) values.set(KEY, stored);
  const storage = {
    fail: false,
    failRead: false,
    writes: 0,
    getItem(key) {
      if (storage.failRead) throw new Error('Storage unavailable');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (key === KEY) {
        if (storage.fail) throw new Error('Quota exceeded');
        storage.writes += 1;
      }
      values.set(key, String(value));
    },
    removeItem(key) {
      if (key === KEY) storage.writes += 1;
      values.delete(key);
    },
  };
  const events = [];
  const off = subscribe(FAVORITE_GROUPS_EVENT, (detail) => events.push(detail));
  globalThis.localStorage = storage;
  state.favorites = favorites.map((item) => ({ ...item }));
  state.settings = normalizeSettings(settings);
  try {
    return fn({ state, storage, values, events, saved: () => JSON.parse(values.get(KEY)) });
  } finally {
    off();
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    clearPersistenceFailure('favorite-groups');
    clearPersistenceFailure('favorites');
  }
}

/* ============ The store ============ */

test('no saved categories means none, without writing anything', () => {
  withStore([fav('a')], ({ storage, events }) => {
    assert.deepEqual(getFavoriteGroups(), []);
    assert.equal(favoriteGroupOf('a'), '');
    assert.deepEqual(favoriteGroupCounts().none, 1);
    assert.equal(pruneFavoriteGroups(), false);
    assert.equal(storage.writes, 0);
    assert.equal(events.length, 0);
  });
});

test('creating a category saves once, sends one event and keeps the stored layout', () => {
  withStore([fav('a')], ({ storage, events, saved }) => {
    const result = createFavoriteGroup('  Rock  ');
    assert.equal(result.ok, true);
    assert.equal(result.group.name, 'Rock');
    assert.match(result.group.id, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(storage.writes, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(saved(), { version: 1, groups: [{ id: result.group.id, name: 'Rock' }], assign: {} });
    assert.deepEqual(getFavoriteGroups(), [{ id: result.group.id, name: 'Rock' }]);
  });
});

test('names are trimmed, spaces collapsed, invisible characters removed, 1 to 40 characters, unique ignoring case', () => {
  withStore([], ({ storage }) => {
    assert.equal(cleanGroupName('  Talk \t\n  radio  '), 'Talk radio');
    assert.equal(cleanGroupName('\u200bRo\u202eck\u0007'), 'Rock');
    assert.equal(cleanGroupName(42), '');
    assert.equal(createFavoriteGroup('Talk   radio').group.name, 'Talk radio');
    assert.match(createFavoriteGroup('   ').error, /Type a name/);
    assert.match(createFavoriteGroup('TALK RADIO').error, /already a category called "Talk radio"/);
    assert.match(createFavoriteGroup('talk\u200b radio').error, /already/);
    assert.match(createFavoriteGroup('x'.repeat(41)).error, /40 characters or fewer \(this name has 41\)/);
    assert.equal(createFavoriteGroup('x'.repeat(40)).ok, true);
    // Characters, not UTF-16 units: forty guitars fit.
    assert.equal(createFavoriteGroup('\u{1F3B8}'.repeat(40)).ok, true);
    assert.equal(checkGroupName('Talk Radio').ok, false);
    assert.equal(storage.writes, 3);
  });
});

test('at most 50 categories; the 51st is refused without saving', () => {
  withStore([], ({ storage, events }) => {
    for (let index = 1; index <= MAX_FAVORITE_GROUPS; index += 1) assert.equal(createFavoriteGroup(`Group ${index}`).ok, true);
    const ids = new Set(getFavoriteGroups().map((group) => group.id));
    assert.equal(ids.size, 50);
    const refused = createFavoriteGroup('One more');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /up to 50 categories/);
    assert.equal(storage.writes, 50);
    assert.equal(events.length, 50);
  });
});

test('rename checks the same rules, allows a change of case, and saves nothing for the same name', () => {
  withStore([], ({ storage, events }) => {
    const rock = createFavoriteGroup('Rock').group;
    createFavoriteGroup('Talk');
    assert.match(renameFavoriteGroup(rock.id, 'talk').error, /already a category called "Talk"/);
    assert.equal(renameFavoriteGroup(rock.id, ' Rock ').changed, false);
    assert.equal(storage.writes, 2);
    assert.equal(renameFavoriteGroup(rock.id, 'ROCK').ok, true);
    assert.equal(renameFavoriteGroup(rock.id, 'Classic   rock').ok, true);
    assert.equal(getFavoriteGroups()[0].name, 'Classic rock');
    assert.equal(renameFavoriteGroup('missing', 'X').ok, false);
    assert.equal(storage.writes, 4);
    assert.equal(events.length, 4);
  });
});

test('a favorite is in at most one category, or none; unchanged choices save nothing', () => {
  withStore([fav('a'), fav('b')], ({ storage, events, saved }) => {
    const rock = createFavoriteGroup('Rock').group;
    const talk = createFavoriteGroup('Talk').group;
    assert.equal(assignFavoriteToGroup('a', rock.id).ok, true);
    assert.equal(favoriteGroupOf('a'), rock.id);
    assert.equal(assignFavoriteToGroup('a', talk.id).ok, true);
    assert.equal(favoriteGroupOf('a'), talk.id);
    assert.deepEqual(saved().assign, { a: talk.id });
    assert.equal(assignFavoriteToGroup('a', talk.id).changed, false);
    assert.equal(assignFavoriteToGroup('a', '').ok, true);
    assert.equal(favoriteGroupOf('a'), '');
    assert.deepEqual(saved().assign, {});
    assert.equal(assignFavoriteToGroup('not-saved', rock.id).ok, false);
    assert.equal(assignFavoriteToGroup('b', 'missing').ok, false);
    assert.equal(storage.writes, 5);
    assert.equal(events.length, 5);
    assert.deepEqual(events.map((detail) => detail.action), ['create', 'create', 'assign', 'assign', 'assign']);
  });
});

test('"New category" can make a category and put a favorite in it with one save', () => {
  withStore([fav('a')], ({ storage, events }) => {
    const result = createFavoriteGroup('Jazz', { assign: 'a' });
    assert.equal(result.ok, true);
    assert.equal(favoriteGroupOf('a'), result.group.id);
    assert.equal(storage.writes, 1);
    assert.equal(events.length, 1);
    // A favorite that is not saved is not assigned, but the category is still made.
    assert.equal(createFavoriteGroup('Blues', { assign: 'gone' }).ok, true);
    assert.equal(favoriteGroupOf('gone'), '');
  });
});

test('deleting a category keeps its favorites, now in no category', () => {
  withStore([fav('a'), fav('b'), fav('c')], ({ state, values }) => {
    const rock = createFavoriteGroup('Rock').group;
    const talk = createFavoriteGroup('Talk').group;
    assignFavoriteToGroup('a', rock.id);
    assignFavoriteToGroup('b', rock.id);
    assignFavoriteToGroup('c', talk.id);
    const before = state.favorites;
    assert.equal(deleteFavoriteGroup(rock.id).ok, true);
    assert.equal(state.favorites, before);
    assert.deepEqual(state.favorites.map((item) => item.id), ['a', 'b', 'c']);
    assert.deepEqual([favoriteGroupOf('a'), favoriteGroupOf('b'), favoriteGroupOf('c')], ['', '', talk.id]);
    assert.deepEqual(favoriteGroupCounts().none, 2);
    assert.equal(deleteFavoriteGroup(rock.id).ok, false);
    // The last category gone: nothing is left stored.
    assert.equal(deleteFavoriteGroup(talk.id).ok, true);
    assert.equal(values.has(KEY), false);
    assert.deepEqual(getFavoriteGroups(), []);
  });
});

test('counts per category and for favorites in none', () => {
  withStore([fav('a'), fav('b'), fav('c'), fav('d')], () => {
    const rock = createFavoriteGroup('Rock').group;
    const talk = createFavoriteGroup('Talk').group;
    assignFavoriteToGroup('a', rock.id);
    assignFavoriteToGroup('b', rock.id);
    assignFavoriteToGroup('c', talk.id);
    const { counts, none } = favoriteGroupCounts();
    assert.deepEqual([...counts], [[rock.id, 2], [talk.id, 1]]);
    assert.equal(none, 1);
  });
});

test('removing a favorite drops its assignment (one save, one event); a metadata save keeps it', () => {
  withStore([fav('a'), fav('b')], ({ storage, events, saved }) => {
    const rock = createFavoriteGroup('Rock').group;
    assignFavoriteToGroup('a', rock.id);
    assignFavoriteToGroup('b', rock.id);
    const writes = storage.writes;
    // persistFavoriteMetadata rewrites the stored favorite: the category lives elsewhere.
    assert.equal(persistFavoriteMetadata({ ...getState().favorites[0], title: 'Renamed' }), true);
    assert.equal(favoriteGroupOf('a'), rock.id);
    assert.equal(storage.writes, writes);
    const before = events.length;
    assert.equal(removeFavorite('a'), true);
    assert.equal(storage.writes, writes + 1);
    assert.equal(events.length, before + 1);
    assert.deepEqual(saved().assign, { b: rock.id });
    // Nothing stale left: no more writes.
    assert.equal(pruneFavoriteGroups(), false);
    assert.equal(storage.writes, writes + 1);
  });
});

test('stale assignments are pruned on the next change and never counted', () => {
  const stored = JSON.stringify({
    version: 1, groups: [{ id: 'g1', name: 'Rock' }], assign: { a: 'g1', gone: 'g1' },
  });
  withStore([fav('a')], ({ saved }) => {
    assert.deepEqual([...favoriteGroupCounts().counts], [['g1', 1]]);
    createFavoriteGroup('Talk');
    assert.deepEqual(saved().assign, { a: 'g1' });
  }, { stored });
});

test('corrupt or unknown stored data is ignored safely and never blocks favorites', () => {
  const cases = [
    'not json', '[]', 'null', '"text"', '{"version":1,"groups":"x","assign":[]}', '{"groups":[]}',
    JSON.stringify({ version: 1, groups: [null, 5, { id: 'bad id!', name: 'X' }, { id: 'g1', name: '' }], assign: { a: 'g1' } }),
  ];
  for (const stored of cases) {
    withStore([fav('a')], ({ state }) => {
      assert.deepEqual(getFavoriteGroups(), [], stored);
      assert.equal(favoriteGroupOf('a'), '', stored);
      assert.equal(removeFavorite('a'), true, stored);
      assert.deepEqual(state.favorites, []);
      // A fresh category replaces data that could not be read.
      assert.equal(createFavoriteGroup('Rock').ok, true, stored);
    }, { stored });
  }
});

test('bad entries are dropped one by one: repeated ids or names, long names, unknown categories, odd ids', () => {
  const groups = JSON.stringify([
    { id: 'g1', name: '  Rock ' }, { id: 'g1', name: 'Again' }, { id: 'g2', name: 'ROCK' },
    { id: 'g3', name: 'y'.repeat(41) }, { id: 'g4', name: 'Talk' }, { id: 'g5', name: 7 },
  ]);
  // Written as text so that "__proto__" is an ordinary key, as JSON.parse reads it.
  const stored = `{"version":1,"groups":${groups},"assign":{"a":"g1","b":"g9","c":4,"__proto__":"g4","constructor":"g4","":"g1"}}`;
  withStore([fav('a'), fav('b'), fav('__proto__'), fav('constructor')], ({ saved }) => {
    assert.deepEqual(getFavoriteGroups(), [{ id: 'g1', name: 'Rock' }, { id: 'g4', name: 'Talk' }]);
    assert.equal(favoriteGroupOf('a'), 'g1');
    assert.equal(favoriteGroupOf('b'), '');
    assert.equal(favoriteGroupOf('__proto__'), 'g4');
    assert.equal(favoriteGroupOf('constructor'), 'g4');
    assert.equal(favoriteGroupOf('toString'), '');
    // Saved back as plain keys, not as an object prototype.
    createFavoriteGroup('Jazz');
    assert.equal(Object.getPrototypeOf(saved().assign), Object.prototype);
    assert.deepEqual(Object.keys(saved().assign).sort(), ['__proto__', 'a', 'constructor']);
  }, { stored });
});

test('more than 50 stored categories keep only the first 50', () => {
  const groups = Array.from({ length: 60 }, (_, index) => ({ id: `g${index}`, name: `Group ${index}` }));
  withStore([], () => {
    assert.equal(getFavoriteGroups().length, 50);
    assert.equal(getFavoriteGroups().at(-1).name, 'Group 49');
  }, { stored: JSON.stringify({ version: 1, groups, assign: {} }) });
});

test('categories saved by a newer layout are shown as none and never written over', () => {
  const stored = JSON.stringify({ version: 2, lists: [{ id: 'x', title: 'Future' }] });
  withStore([fav('a')], ({ storage, values, events }) => {
    assert.deepEqual(getFavoriteGroups(), []);
    assert.equal(favoriteGroupsSnapshot().locked, true);
    assert.match(createFavoriteGroup('Rock').error, /newer version/);
    assert.equal(assignFavoriteToGroup('a', '').ok, false);
    assert.equal(removeFavorite('a'), true);
    assert.equal(values.get(KEY), stored);
    assert.equal(storage.writes, 0);
    assert.equal(events.length, 0);
  }, { stored });
});

test('a save that fails changes nothing and sends no event', () => {
  withStore([fav('a')], ({ storage, events }) => {
    const rock = createFavoriteGroup('Rock').group;
    storage.fail = true;
    const result = assignFavoriteToGroup('a', rock.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be saved/);
    assert.equal(favoriteGroupOf('a'), '');
    assert.equal(events.length, 1);
    assert.equal(createFavoriteGroup('Talk').ok, false);
    assert.equal(getFavoriteGroups().length, 1);
  });
});

test('storage that cannot be read means no categories, without throwing', () => {
  withStore([fav('a')], ({ storage }) => {
    storage.failRead = true;
    assert.deepEqual(getFavoriteGroups(), []);
    assert.equal(favoriteGroupOf('a'), '');
    assert.equal(pruneFavoriteGroups(), false);
  });
});

test('Clear cache removes the categories with the rest of the profile', () => {
  withStore([fav('a')], ({ values }) => {
    const rock = createFavoriteGroup('Rock').group;
    assignFavoriteToGroup('a', rock.id);
    void clearCache();
    assert.equal(values.has(KEY), false);
    assert.deepEqual(getFavoriteGroups(), []);
  });
});

/* ============ Profile keys ============ */

test('the categories key is mirrored: the same key in state.js, the profile list, the backend and the backup', async () => {
  assert.equal(STORAGE_KEYS.favoriteGroups, KEY);
  assert.ok(PROFILE_STORAGE_KEYS.includes(KEY));
  const runtime = await read('worldmedia_runtime.py');
  const block = runtime.match(/PROFILE_TRANSFER_KEYS = frozenset\(\{([\s\S]*?)\}\)/)[1];
  const backend = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  // Every key the frontend mirrors is accepted by the backend, and the other way round.
  assert.deepEqual([...backend].sort(), [...PROFILE_STORAGE_KEYS].sort());
  // Releases up to 0.1.8 know only these; the new key must not be among them.
  const legacy = runtime.match(/LEGACY_PROFILE_TRANSFER_KEYS = frozenset\(\{([\s\S]*?)\}\)/)[1];
  assert.doesNotMatch(legacy, /favgroups/);
  const backup = await read('worldmedia_backup.py');
  assert.match(backup, /FAVORITE_GROUPS_KEY = "worldmedia\.favgroups\.v1"/);
});

/* ============ Tuner ============ */

test('the Tuner lists one entry per category with favorites, and a category dial keeps the favorites order', () => {
  const list = [fav('a', 'Alpha'), fav('b', 'Beta'), fav('t', 'TV', { type: 'tv' }), fav('c', 'Charlie'), fav('z', 'Zulu')];
  withStore(list, ({ state }) => {
    const rock = createFavoriteGroup('Rock').group;
    const talk = createFavoriteGroup('Talk').group;
    const empty = createFavoriteGroup('Empty').group;
    for (const id of ['z', 'a', 't']) assignFavoriteToGroup(id, rock.id);
    assignFavoriteToGroup('b', talk.id);
    assert.deepEqual(tunerFavoriteGroups().map((group) => group.name), ['Rock', 'Talk']);
    const ids = (items) => items.map((item) => item.id);
    // My order: stored order.
    assert.deepEqual(ids(favoriteStations(state.favorites, { band: 'radio', groupId: rock.id, settings: state.settings })), ['a', 'z']);
    assert.deepEqual(ids(favoriteStations(state.favorites, { band: 'tv', groupId: rock.id, settings: state.settings })), ['t']);
    assert.deepEqual(ids(favoriteStations(state.favorites, { band: 'radio', settings: state.settings })), ['a', 'b', 'c', 'z']);
    // A-Z follows the same sort as the Library.
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    state.favorites = [state.favorites[4], ...state.favorites.slice(0, 4)];
    assert.deepEqual(ids(favoriteStations(state.favorites, { band: 'radio', groupId: rock.id, settings: state.settings })), ['a', 'z']);
    // Fallbacks: an empty or deleted category goes back to "My favorites".
    assert.equal(keptFavoriteSource(`favgroup:${rock.id}`), `favgroup:${rock.id}`);
    assert.equal(keptFavoriteSource(`favgroup:${empty.id}`), 'favorites');
    assert.equal(keptFavoriteSource('favgroup:missing'), 'favorites');
    assert.equal(keptFavoriteSource('radio-browser'), 'radio-browser');
    assert.equal(keptFavoriteSource('all'), 'all');
    assignFavoriteToGroup('b', '');
    assert.equal(keptFavoriteSource(`favgroup:${talk.id}`), 'favorites');
    deleteFavoriteGroup(rock.id);
    assert.equal(keptFavoriteSource(`favgroup:${rock.id}`), 'favorites');
    assert.deepEqual(tunerFavoriteGroups(), []);
  });
});

test('the Tuner Source list adds the categories after My favorites and falls back when one goes', async () => {
  const tuner = await read('src/modes/tuner.js');
  const rebuild = tuner.match(/function rebuildSourceSelect\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(rebuild, /reconcileFavoriteGroupSource\(\);/);
  assert.ok(rebuild.indexOf("text: '\u2605 My favorites'") < rebuild.indexOf('tunerFavoriteGroups()'));
  assert.match(rebuild, /text: `\\u2605 \$\{group\.name\}`/);
  const reload = tuner.match(/function loadFavoriteStations\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(reload, /reconcileFavoriteGroupSource\(\);\s+setStations\(favoriteStations\(/);
  assert.match(reload, /groupId: favoriteGroupSource\(\),/);
  assert.match(tuner, /subs\.push\(subscribe\(FAVORITE_GROUPS_EVENT, \(\) => \{/);
  assert.match(tuner, /const favoritesOnly = isFavoritesSource\(state\.sourceFilter\);/);
});
