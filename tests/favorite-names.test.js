import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  FAVORITE_NAMES_KEY, MAX_FAVORITE_NAME_LENGTH, cleanFavoriteName, favoriteName, favoriteNamesTextWithNewIds,
  parseFavoriteNames, withFavoriteName, withoutFavoriteName,
} from '../src/lib/favorite-names.js';
import {
  FAVORITE_NAMES_EVENT, onFavoriteNamesStorage, pruneFavoriteNames, renameFavorite, resetFavoriteName,
  watchFavoriteNamesInOtherWindows,
} from '../src/lib/favorite-rename.js';
import {
  clearCache, getState, normalizeFavoriteItem, normalizeSettings, persistFavoriteMetadata, removeFavorite,
  STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { sortFavoritesByName, favoritesInDisplayOrder, FAVORITES_SORT_NAME } from '../src/lib/favorites-order.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { moveFavoritesToNewIds } from '../src/lib/favorite-migration.js';
import { favoriteStations } from '../src/modes/tuner.js';
import { libraryPool } from '../src/modes/library/personal.js';
import { itemPassesFilters } from '../src/modes/library/filter.js';
import { view } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { openDetail, closeDetail } from '../src/modes/library/detail.js';
import { applyStationImageList, markStationImageFailed, stationImageSourceFor } from '../src/lib/station-images.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const fav = (id, title = id, extra = {}) => ({
  id, title, type: 'radio', source: 'radio-browser', stream_url: `https://radio.example.org/${id}.mp3`, ...extra,
});
const stored = (names) => JSON.stringify({ version: 1, names });

/** A fake localStorage with the given favorites and names, plus counts of
 *  name writes and events. */
function withStore(favorites, fn, { names = undefined, settings = {} } = {}) {
  const state = getState();
  const previous = { favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage };
  const values = new Map();
  if (names !== undefined) values.set(FAVORITE_NAMES_KEY, typeof names === 'string' ? names : stored(names));
  const storage = {
    fail: false,
    writes: 0,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === FAVORITE_NAMES_KEY) {
        if (storage.fail) throw new Error('Quota exceeded');
        storage.writes += 1;
      }
      values.set(key, String(value));
    },
    removeItem(key) {
      if (key === FAVORITE_NAMES_KEY) storage.writes += 1;
      values.delete(key);
    },
  };
  const events = { names: [], favorites: 0 };
  const offNames = subscribe(FAVORITE_NAMES_EVENT, (detail) => events.names.push(detail));
  const offFavorites = subscribe('favorites-change', () => { events.favorites += 1; });
  globalThis.localStorage = storage;
  state.favorites = favorites.map((item) => ({ ...item }));
  state.settings = normalizeSettings(settings);
  try {
    return fn({
      state, storage, values, events,
      saved: () => (values.has(FAVORITE_NAMES_KEY) ? JSON.parse(values.get(FAVORITE_NAMES_KEY)).names : null),
    });
  } finally {
    offNames();
    offFavorites();
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    clearPersistenceFailure('favorite-names');
    clearPersistenceFailure('favorites');
  }
}

/* ============ The store ============ */

test('a name is saved as one plain line of at most 80 characters', () => {
  assert.equal(MAX_FAVORITE_NAME_LENGTH, 80);
  assert.equal(cleanFavoriteName('  Morning\n\tradio  '), 'Morning radio');
  assert.equal(cleanFavoriteName('A\u200BB\u202EC\u0000D'), 'ABC D');
  assert.equal(cleanFavoriteName('x'.repeat(200)).length, 80);
  for (const value of [null, 5, {}, '   ', '\u200B']) assert.equal(cleanFavoriteName(value), '');
});

test('unreadable names are no names; a newer layout is kept and never written over', () => {
  for (const raw of [null, 'not json', '[]', '{"version":1}', '{"version":1,"names":[]}', '{"version":0,"names":{}}']) {
    const doc = parseFavoriteNames(raw);
    assert.equal(doc.names.size, 0);
    assert.equal(doc.locked, false);
  }
  const doc = parseFavoriteNames(stored({ a: '  Mine ', b: '', c: 5 }));
  assert.deepEqual([...doc.names], [['a', 'Mine']]);
  assert.equal(parseFavoriteNames('{"version":2,"names":{}}').locked, true);
  withStore([fav('a')], ({ storage, values }) => {
    const raw = values.get(FAVORITE_NAMES_KEY);
    const result = renameFavorite('a', 'Mine');
    assert.equal(result.ok, false);
    assert.match(result.error, /newer version/);
    assert.equal(storage.writes, 0);
    assert.equal(values.get(FAVORITE_NAMES_KEY), raw);
  }, { names: '{"version":2,"names":{"a":"Theirs"}}' });
});

test('a list shows a renamed favorite under its name and keeps the original; nothing else is copied', () => {
  withStore([fav('a', 'Radio One'), fav('b', 'Radio Two')], ({ state }) => {
    const [one, two] = state.favorites;
    const shown = withFavoriteName(one);
    assert.notEqual(shown, one);
    assert.equal(shown.title, 'Morning');
    assert.equal(shown.originalTitle, 'Radio One');
    assert.equal(shown.stream_url, one.stream_url);
    assert.equal(withFavoriteName(one), shown, 'the same copy while the name stays');
    assert.equal(withFavoriteName(shown), shown);
    assert.equal(withFavoriteName(two), two);
    assert.equal(favoriteName('a'), 'Morning');
    assert.equal(favoriteName('b'), '');
    // Back to the favorite as saved.
    assert.deepEqual(withoutFavoriteName(shown), one);
    assert.equal(withoutFavoriteName(two), two);
  }, { names: { a: 'Morning' } });
});

/* ============ Renaming ============ */

test('renaming saves once, tells every list, and the favorite keeps the station name', () => {
  withStore([fav('a', 'Radio One'), fav('b')], ({ state, storage, events, saved }) => {
    const before = JSON.stringify(state.favorites);
    assert.deepEqual(renameFavorite('a', '  Morning  '), { ok: true, error: '', changed: true });
    assert.deepEqual(saved(), { a: 'Morning' });
    assert.equal(storage.writes, 1);
    assert.deepEqual(events.names, [{ action: 'rename', favoriteId: 'a' }]);
    assert.equal(events.favorites, 1);
    assert.equal(JSON.stringify(state.favorites), before);
    // The same name again changes nothing.
    assert.deepEqual(renameFavorite('a', 'Morning'), { ok: true, error: '', changed: false });
    assert.equal(storage.writes, 1);
  });
});

test('an empty name, the station name or "Use original name" goes back to the original', () => {
  withStore([fav('a', 'Radio One'), fav('b', 'Radio Two')], ({ storage, values, saved }) => {
    assert.equal(renameFavorite('a', '   ').changed, true);
    assert.deepEqual(saved(), { b: 'Two' });
    assert.equal(renameFavorite('b', ' Radio Two ').changed, true);
    assert.equal(values.has(FAVORITE_NAMES_KEY), false, 'no names left: the key is removed');
    assert.equal(storage.writes, 2);
    renameFavorite('a', 'Mine');
    assert.equal(resetFavoriteName('a').changed, true);
    assert.equal(favoriteName('a'), '');
  }, { names: { a: 'One', b: 'Two' } });
});

test('only saved favorites can be renamed, and a failed save changes nothing', () => {
  withStore([fav('a')], ({ storage, events, values }) => {
    assert.equal(renameFavorite('gone', 'Mine').ok, false);
    storage.fail = true;
    const result = renameFavorite('a', 'Mine');
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be saved/);
    assert.equal(values.has(FAVORITE_NAMES_KEY), false);
    assert.equal(favoriteName('a'), '');
    assert.equal(events.favorites, 0);
  });
});

test('a removed favorite loses its name; metadata saves never store the name in the favorite', () => {
  withStore([fav('a', 'Radio One'), fav('b')], ({ state, saved, events }) => {
    // The playing item may be the list's renamed copy.
    persistFavoriteMetadata({ ...withFavoriteName(state.favorites[0]), description: 'News' });
    assert.equal(state.favorites[0].title, 'Radio One');
    assert.equal(state.favorites[0].description, 'News');
    assert.equal('originalTitle' in state.favorites[0], false);
    assert.equal(normalizeFavoriteItem(withFavoriteName(state.favorites[0])).title, 'Radio One');
    assert.equal(favoriteName('a'), 'Morning');
    removeFavorite('a');
    assert.equal(saved(), null);
    assert.ok(events.names.some((detail) => detail.action === 'prune'));
    assert.equal(pruneFavoriteNames(), false);
  }, { names: { a: 'Morning' } });
});

test('a favorite given a new id keeps its name', () => {
  withStore([fav('rb:a', 'Radio One')], ({ saved }) => {
    const result = moveFavoritesToNewIds(new Map([['rb:a', fav('tv:a', 'Radio One', { type: 'tv' })]]));
    assert.equal(result.moved, 1);
    assert.deepEqual(saved(), { 'tv:a': 'Morning' });
  }, { names: { 'rb:a': 'Morning' } });
  assert.equal(favoriteNamesTextWithNewIds(null, new Map()), null);
  assert.equal(favoriteNamesTextWithNewIds('junk', new Map([['a', 'b']])), 'junk');
});

/* ============ Shown everywhere ============ */

test('A-Z sorts by the shown name; the order is redone when a name changes', () => {
  withStore([fav('a', 'Zulu'), fav('b', 'Mike'), fav('c', 'Alpha')], ({ state }) => {
    assert.deepEqual(sortFavoritesByName(state.favorites).map((item) => item.id), ['a', 'c', 'b']);
    const settings = normalizeSettings({ favoritesSort: FAVORITES_SORT_NAME });
    assert.deepEqual(favoritesInDisplayOrder(state.favorites, settings).map((item) => item.id), ['a', 'c', 'b']);
    renameFavorite('a', 'Yankee');
    assert.deepEqual(favoritesInDisplayOrder(state.favorites, settings).map((item) => item.id), ['c', 'b', 'a']);
  }, { names: { a: 'Aardvark' } });
});

test('the Library and the Tuner show the name; search finds both names', () => {
  withStore([fav('a', 'Radio One'), fav('b', 'Radio Two')], () => {
    const before = { source: view.activeSource, filters: { ...view.personalFilters.favorites } };
    try {
      view.activeSource = 'favorites';
      const pool = libraryPool();
      assert.deepEqual(pool.map((item) => item.title), ['Morning', 'Radio Two']);
      assert.equal(pool[0].originalTitle, 'Radio One');
      const dial = favoriteStations(getState().favorites, { band: 'radio', settings: getState().settings });
      assert.deepEqual(dial.map((item) => item.title), ['Morning', 'Radio Two']);
      for (const [query, ids] of [['morning', ['a']], ['radio one', ['a']], ['radio', ['a', 'b']], ['two', ['b']]]) {
        view.personalFilters.favorites = { query, type: '' };
        assert.deepEqual(pool.filter((item) => itemPassesFilters(item, null)).map((item) => item.id), ids, query);
      }
    } finally {
      view.activeSource = before.source;
      view.personalFilters.favorites = before.filters;
    }
  }, { names: { a: 'Morning' } });
});

test('the player bar, the song log and the cards follow the name', async () => {
  const player = await read('src/lib/player.js');
  // Every place the player bar writes the station name uses the shown name.
  assert.doesNotMatch(player, /elements\.title\.textContent = (currentItem\?*|item)\.title/);
  assert.equal(player.match(/elements\.title\.textContent = shownTitle\(/g).length, 4);
  assert.match(player, /artist: shownTitle\(currentItem\)/);
  assert.match(player, /subscribe\('favorites-change', \(\) => \{[\s\S]*?setMetaText\(currentItem\);[\s\S]*?\}\);/);
  const main = await read('src/main.js');
  assert.match(main, /startSongLog\(subscribe, \(itemId\) => \{\s*const item = shownCurrentItem\(\);/);
  assert.match(main, /getCurrentItem: shownCurrentItem,/);
  // A card's title is part of what decides it is redrawn.
  const render = await read('src/modes/library/render.js');
  assert.match(render, /item\.title \|\| '', item\.originalTitle \|\| ''/);
});

test('a renamed favorite keeps its station picture; a picture named after the new name also works', () => {
  const id = (n) => String(n).repeat(32).slice(0, 32);
  const images = [{ key: 'radio one', id: id(1), v: 'abc123' }, { key: 'evening', id: id(2), v: 'abc123' }];
  withStore([fav('a', 'Radio One'), fav('b', 'Radio Two')], ({ state }) => {
    try {
      applyStationImageList({ folder: 'pictures', exists: true, version: 'v1', images });
      const [one, two] = state.favorites.map((item) => withFavoriteName(item));
      assert.equal(one.title, 'Morning');
      assert.equal(stationImageSourceFor(one), `station-image:${id(1)}:abc123`);
      assert.equal(two.title, 'Evening');
      assert.equal(stationImageSourceFor(two), `station-image:${id(2)}:abc123`);
    } finally {
      applyStationImageList({ images: [] });
    }
  }, { names: { a: 'Morning', b: 'Evening' } });
});

test('a renamed favorite whose own picture will not load uses a picture named after the new name', () => {
  const id = (n) => String(n).repeat(32).slice(0, 32);
  const images = [{ key: 'radio one', id: id(1), v: 'abc123' }, { key: 'morning', id: id(2), v: 'abc123' }];
  withStore([fav('a', 'Radio One')], ({ state }) => {
    try {
      applyStationImageList({ folder: 'pictures', exists: true, version: 'v1', images });
      const one = withFavoriteName(state.favorites[0]);
      assert.equal(stationImageSourceFor(one), `station-image:${id(1)}:abc123`);
      markStationImageFailed(`station-image:${id(1)}:abc123`);
      assert.equal(stationImageSourceFor(one), `station-image:${id(2)}:abc123`);
    } finally {
      applyStationImageList({ images: [] });
    }
  }, { names: { a: 'Morning' } });
});

/* ============ Other windows ============ */

test('a rename in another window reaches this one at once, and is never pruned here', () => {
  withStore([fav('a', 'Radio One')], ({ values, events, storage }) => {
    // The other window saved names, including one for a favorite this
    // window has not loaded.
    values.set(FAVORITE_NAMES_KEY, stored({ a: 'Morning', other: 'Late' }));
    assert.equal(onFavoriteNamesStorage({ key: 'worldmedia.favorites.v1' }), false);
    assert.equal(events.favorites, 0);
    assert.equal(onFavoriteNamesStorage({ key: FAVORITE_NAMES_KEY }), true);
    assert.deepEqual(events.names, [{ action: 'other-window' }]);
    assert.equal(events.favorites, 1);
    assert.equal(favoriteName('a'), 'Morning');
    assert.equal(storage.writes, 0, 'nothing written back');
    assert.match(values.get(FAVORITE_NAMES_KEY), /"other":"Late"/);
    // Storage cleared in the other window.
    values.delete(FAVORITE_NAMES_KEY);
    assert.equal(onFavoriteNamesStorage({ key: null }), true);
    assert.equal(favoriteName('a'), '');
  });
  // The page listens for it on its window, once.
  const target = new EventTarget();
  assert.equal(watchFavoriteNamesInOtherWindows(target), true);
  assert.equal(watchFavoriteNamesInOtherWindows(target), false);
  withStore([fav('a', 'Radio One')], ({ values, events }) => {
    values.set(FAVORITE_NAMES_KEY, stored({ a: 'Evening' }));
    const event = new Event('storage');
    event.key = FAVORITE_NAMES_KEY;
    target.dispatchEvent(event);
    assert.equal(events.favorites, 1);
    assert.equal(favoriteName('a'), 'Evening');
  });
});

/* ============ Saved data ============ */

test('the names travel with the profile and Clear cache removes them', async () => {
  assert.equal(STORAGE_KEYS.favoriteNames, 'worldmedia.favnames.v1');
  assert.ok(PROFILE_STORAGE_KEYS.includes('worldmedia.favnames.v1'));
  const runtime = await read('worldmedia_runtime.py');
  const legacy = runtime.match(/LEGACY_PROFILE_TRANSFER_KEYS[^=]*=[^)]*\)/)[0];
  assert.doesNotMatch(legacy, /favnames/);
  assert.match(runtime, /"worldmedia\.favnames\.v1",/);
  withStore([fav('a')], ({ values }) => {
    clearCache();
    assert.equal(values.has(FAVORITE_NAMES_KEY), false);
    assert.equal(favoriteName('a'), '');
  }, { names: { a: 'Mine' } });
});

/* ============ The details panel ============ */

class Node extends FakeElement {
  constructor(nodeId = '', tag = 'div') {
    super(nodeId, tag);
    this.parentNode = null;
    this.className = '';
  }
  get isConnected() {
    let node = this;
    while (node) { if (node.root) return true; node = node.parentNode; }
    return false;
  }
  set innerHTML(value) { if (value === '') for (const child of [...this.children]) this.removeChild(child); }
  get innerHTML() { return ''; }
  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  focus() { globalThis.document.activeElement = this; }
  select() {}
  all() { return this.children.flatMap((child) => [child, ...(child.all?.() || [])]); }
  querySelector(selector) {
    const act = selector.match(/^\[data-act="([^"]+)"\]$/)?.[1];
    return act ? this.all().find((node) => node.getAttribute?.('data-act') === act) || null : null;
  }
}

function withPanel(favorites, fn, names) {
  return withStore(favorites, (context) => {
    const previous = {
      root: ui.root, panel: ui.detailPanel, document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window,
    };
    globalThis.fetch = () => new Promise(() => {});
    globalThis.window = {};
    globalThis.document = {
      activeElement: null,
      createElement: (tag) => new Node('', tag),
      createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
    };
    const root = new Node('', 'div');
    root.root = true;
    ui.root = root;
    ui.detailPanel = null;
    const find = (cls) => ui.detailPanel.all().find((node) => node.className === cls) || null;
    const act = (name) => ui.detailPanel.querySelector(`[data-act="${name}"]`);
    try {
      return fn({ ...context, find, act });
    } finally {
      closeDetail();
      ui.root = previous.root;
      ui.detailPanel = previous.panel;
      globalThis.document = previous.document;
      globalThis.fetch = previous.fetch;
      globalThis.window = previous.window;
    }
  }, { names });
}

test('details: Rename opens a form; Save renames, Escape and Cancel close it, focus stays on Rename', () => {
  withPanel([fav('a', 'Radio One')], ({ find, act, saved }) => {
    openDetail(getState().favorites[0]);
    assert.equal(find('detail-title').textContent, 'Radio One');
    assert.equal(find('detail-original-name'), null);
    assert.equal(act('reset-favorite-name'), null);
    const rename = act('rename-favorite');
    const form = find('detail-rename');
    assert.equal(form.hidden, true);
    rename.dispatchEvent(new Event('click'));
    assert.equal(form.hidden, false);
    assert.equal(rename.getAttribute('aria-expanded'), 'true');
    const input = find('detail-rename-input');
    assert.equal(input.value, 'Radio One');
    assert.equal(globalThis.document.activeElement, input);
    assert.equal(input.getAttribute('maxlength'), '80');
    // Escape closes the form and leaves the panel open.
    const escape = Object.assign(new Event('keydown'), { key: 'Escape' });
    input.dispatchEvent(escape);
    assert.equal(form.hidden, true);
    assert.equal(globalThis.document.activeElement, rename);
    assert.ok(ui.detailPanel);

    rename.dispatchEvent(new Event('click'));
    input.value = 'Morning';
    form.dispatchEvent(new Event('submit'));
    assert.deepEqual(saved(), { a: 'Morning' });
    // Drawn again under the new name, with the original shown and focus on Rename.
    assert.equal(find('detail-title').textContent, 'Morning');
    assert.equal(find('detail-original-name').textContent, 'Original name: Radio One');
    assert.equal(globalThis.document.activeElement, act('rename-favorite'));
    act('reset-favorite-name').dispatchEvent(new Event('click'));
    assert.equal(saved(), null);
    assert.equal(find('detail-title').textContent, 'Radio One');
    assert.equal(act('reset-favorite-name'), null);
  });
});

test('details: Rename names the form it opens, the name field is described by its hint, and Escape on Save or Cancel closes the form too', () => {
  withPanel([fav('a', 'Radio One')], ({ find, act }) => {
    openDetail(getState().favorites[0]);
    const rename = act('rename-favorite');
    const form = find('detail-rename');
    assert.equal(rename.getAttribute('aria-controls'), form.getAttribute('id'));
    assert.equal(find('detail-rename-input').getAttribute('aria-describedby'), find('detail-rename-hint').getAttribute('id'));
    const buttons = form.all().filter((node) => node.tagName?.toUpperCase?.() === 'BUTTON');
    assert.deepEqual(buttons.map((node) => node.textContent), ['Save', 'Cancel']);
    for (const button of buttons) {
      rename.dispatchEvent(new Event('click'));
      assert.equal(form.hidden, false);
      button.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      assert.equal(form.hidden, true, `Escape on ${button.textContent}`);
      assert.equal(rename.getAttribute('aria-expanded'), 'false');
      assert.equal(globalThis.document.activeElement, rename);
      assert.ok(ui.detailPanel, 'the panel stays open');
    }
  });
});

test('details: a failed save says so in the form; non-favorites have no Rename', () => {
  withPanel([fav('a', 'Radio One')], ({ find, act, storage }) => {
    openDetail(getState().favorites[0]);
    act('rename-favorite').dispatchEvent(new Event('click'));
    find('detail-rename-input').value = 'Morning';
    storage.fail = true;
    find('detail-rename').dispatchEvent(new Event('submit'));
    const message = find('detail-rename-message');
    assert.equal(message.hidden, false);
    assert.match(message.textContent, /could not be saved/);
    assert.equal(find('detail-title').textContent, 'Radio One');
    openDetail(fav('x', 'Not saved'));
    assert.equal(act('rename-favorite'), null);
  });
});

test('details: opened from anywhere, a renamed favorite shows its name', () => {
  withPanel([fav('a', 'Radio One')], ({ find }) => {
    // Opened from a catalog card, with the station's own title.
    openDetail(fav('a', 'Radio One (new title)'));
    assert.equal(find('detail-title').textContent, 'Morning');
    assert.equal(find('detail-original-name').textContent, 'Original name: Radio One (new title)');
  }, { a: 'Morning' });
});

test('the rename form fits narrow panels and uses theme colours', async () => {
  const css = await read('src/styles/library.css');
  const input = css.match(/\.detail-rename-input \{([^}]*)\}/)[1];
  assert.match(input, /flex: 1 1 160px;/);
  assert.match(input, /min-width: 0;/);
  assert.doesNotMatch(input, /(^|\s)width:/);
  assert.match(css, /\.detail-rename-row \{[^}]*flex-wrap: wrap;/);
  const block = css.slice(css.indexOf('.detail-original-name'), css.indexOf('.detail-rename-hint'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgb\(/i);
});
