import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  FAVORITES_SORT_MANUAL, FAVORITES_SORT_NAME, favoritesInDisplayOrder, normalizeFavoritesSort, sortFavoritesByName,
} from '../src/lib/favorites-order.js';
import {
  addFavorite, addFavorites, displayFavorites, getState, moveFavorite, normalizeSettings, persistFavoriteMetadata,
  removeFavorite, STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { favoriteStations, keptStationIndex } from '../src/modes/tuner.js';
import { buildShell } from '../src/modes/library/shell.js';
import { selectSource } from '../src/modes/library/sidebar.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { libraryPool } from '../src/modes/library/personal.js';
import { favoritesManualOrder, onMoveFavorite, renderResults } from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ids = (items) => items.map((item) => item.id);
const fav = (id, title = id, extra = {}) => ({ id, title, type: 'radio', source: 'radio-browser', ...extra });

/** Fake localStorage that counts favorites writes and can refuse them. */
function withFavorites(list, fn, settings = {}) {
  const state = getState();
  const previous = { favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage };
  const values = new Map();
  const storage = {
    fail: false,
    writes: 0,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === STORAGE_KEYS.favorites) {
        if (storage.fail) throw new Error('Quota exceeded');
        storage.writes += 1;
      }
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  let events = 0;
  const off = subscribe('favorites-change', () => { events += 1; });
  globalThis.localStorage = storage;
  state.favorites = list.map((item) => ({ ...item }));
  state.settings = normalizeSettings(settings);
  try {
    return fn({ state, storage, values, events: () => events });
  } finally {
    off();
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    clearPersistenceFailure('favorites');
  }
}

/* ============ Sort helper ============ */

test('A-Z sorts by name, case-insensitively and with numbers in numeric order', () => {
  const list = [fav('a', 'radio 10'), fav('b', 'Radio 2'), fav('c', 'abc'), fav('d', 'ABD'), fav('e', 'Zed'), fav('f', 'Ärger')];
  assert.deepEqual(ids(sortFavoritesByName(list)), ['c', 'd', 'f', 'b', 'a', 'e']);
  // The stored list is never touched.
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('equal names keep their stored order; untitled and hidden favorites go last', () => {
  const list = [
    fav('untitled', ''), fav('jazz-2', 'jazz'), fav('rock', 'Rock'), fav('jazz-1', 'Jazz'), fav('blank', '   '),
    fav('secret', 'Aaa secret', { content_rating: 'explicit' }),
  ];
  assert.deepEqual(ids(sortFavoritesByName(list)), ['jazz-2', 'jazz-1', 'rock', 'untitled', 'blank', 'secret']);
  // With explicit content shown, its real name counts.
  assert.deepEqual(ids(sortFavoritesByName(list, { showExplicitContent: true })),
    ['secret', 'jazz-2', 'jazz-1', 'rock', 'untitled', 'blank']);
});

test('"My order" and any unknown sort value return the stored list itself', () => {
  const list = [fav('b', 'B'), fav('a', 'A')];
  for (const sort of [undefined, null, '', 'manual', 'NAME', 'az', 1, true, {}]) {
    assert.equal(favoritesInDisplayOrder(list, { favoritesSort: sort }), list);
    assert.equal(normalizeFavoritesSort(sort), FAVORITES_SORT_MANUAL);
  }
  assert.equal(normalizeFavoritesSort('name'), FAVORITES_SORT_NAME);
  assert.deepEqual(favoritesInDisplayOrder(undefined, { favoritesSort: 'name' }), []);
  assert.deepEqual(ids(favoritesInDisplayOrder(list, { favoritesSort: 'name' })), ['a', 'b']);
});

test('the A-Z order is remembered until the list, a title or the explicit setting changes', () => {
  const list = Array.from({ length: 2000 }, (_, i) => fav(`id${i}`, `Station ${(i * 7919) % 2000}`));
  const settings = { favoritesSort: 'name' };
  const first = favoritesInDisplayOrder(list, settings);
  assert.equal(first.length, 2000);
  assert.equal(first[0].title, 'Station 0');
  assert.equal(first[1].title, 'Station 1');
  // Same input: the same array, not a fresh sort.
  assert.equal(favoritesInDisplayOrder(list, settings), first);
  assert.equal(favoritesInDisplayOrder([...list], settings), first);
  // A title rewritten in place (metadata update) re-sorts.
  list[0].title = 'AAA first';
  const renamed = favoritesInDisplayOrder(list, settings);
  assert.notEqual(renamed, first);
  assert.equal(renamed[0].id, 'id0');
  // A moved or removed favorite re-sorts.
  assert.notEqual(favoritesInDisplayOrder(list.slice(1), settings), renamed);
  // Showing explicit content can change where a hidden favorite sorts.
  const shown = favoritesInDisplayOrder(list, settings);
  assert.notEqual(favoritesInDisplayOrder(list, { ...settings, showExplicitContent: true }), shown);
});

/* ============ Settings ============ */

test('favoritesSort is a settings field: missing or unknown means "My order"', () => {
  assert.equal(normalizeSettings({}).favoritesSort, 'manual');
  assert.equal(normalizeSettings(null).favoritesSort, 'manual');
  assert.equal(normalizeSettings({ favoritesSort: 'name' }).favoritesSort, 'name');
  assert.equal(normalizeSettings({ favoritesSort: 'size' }).favoritesSort, 'manual');
  assert.equal(normalizeSettings({ favoritesSort: ['name'] }).favoritesSort, 'manual');
  // Fields from a newer build survive a save, so going back and forth between
  // builds does not lose them (older builds already keep unknown fields).
  const stored = normalizeSettings({ favoritesSort: 'name', theme: 'forest', laterField: 3 });
  assert.equal(stored.laterField, 3);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(stored))), stored);
});

test('the profile mirror and the backend need no new key for the sort choice', async () => {
  const [transfer, runtime] = await Promise.all([read('src/lib/profile-transfer.js'), read('worldmedia_runtime.py')]);
  // It lives inside worldmedia.settings.v1, which both sides already allow
  // and pass through as an opaque string.
  assert.match(transfer, /'worldmedia\.settings\.v1'/);
  assert.match(runtime, /"worldmedia\.settings\.v1"/);
  assert.doesNotMatch(transfer, /favoritesSort/);
  assert.doesNotMatch(runtime, /favoritesSort/);
});

test('displayFavorites follows the saved sort choice', () => {
  withFavorites([fav('b', 'Beta'), fav('a', 'alpha'), fav('c', 'Gamma')], ({ state }) => {
    assert.equal(displayFavorites(), state.favorites);
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    assert.deepEqual(ids(displayFavorites()), ['a', 'b', 'c']);
    assert.deepEqual(ids(state.favorites), ['b', 'a', 'c']);
  });
});

/* ============ moveFavorite ============ */

test('moveFavorite moves up, down and to the top with one save and one event each', () => {
  withFavorites([fav('a'), fav('b'), fav('c'), fav('d')], ({ state, storage, values, events }) => {
    assert.equal(moveFavorite('c', 'up'), true);
    assert.deepEqual(ids(state.favorites), ['a', 'c', 'b', 'd']);
    assert.equal(storage.writes, 1);
    assert.equal(events(), 1);
    assert.equal(moveFavorite('a', 'down'), true);
    assert.deepEqual(ids(state.favorites), ['c', 'a', 'b', 'd']);
    assert.equal(moveFavorite('d', 'top'), true);
    assert.deepEqual(ids(state.favorites), ['d', 'c', 'a', 'b']);
    assert.equal(storage.writes, 3);
    assert.equal(events(), 3);
    assert.deepEqual(ids(JSON.parse(values.get(STORAGE_KEYS.favorites))), ['d', 'c', 'a', 'b']);
  });
});

test('moveFavorite does nothing at the ends or for an unknown item', () => {
  withFavorites([fav('a'), fav('b')], ({ state, storage, events }) => {
    const before = state.favorites;
    assert.equal(moveFavorite('a', 'up'), false);
    assert.equal(moveFavorite('a', 'top'), false);
    assert.equal(moveFavorite('b', 'down'), false);
    assert.equal(moveFavorite('nope', 'up'), false);
    assert.equal(moveFavorite('b', 'sideways'), false);
    assert.equal(state.favorites, before);
    assert.equal(storage.writes, 0);
    assert.equal(events(), 0);
  });
});

test('with a filter, a move trades places with the nearest shown favorite only', () => {
  const list = [fav('r1'), fav('t1'), fav('r2'), fav('t2'), fav('t3'), fav('r3')];
  withFavorites(list, ({ state, events }) => {
    const radios = ['r1', 'r2', 'r3'];
    assert.equal(moveFavorite('r3', 'up', { visibleIds: radios }), true);
    assert.deepEqual(ids(state.favorites), ['r1', 't1', 'r3', 't2', 't3', 'r2']);
    assert.equal(moveFavorite('r1', 'down', { visibleIds: new Set(radios) }), true);
    assert.deepEqual(ids(state.favorites), ['r3', 't1', 'r1', 't2', 't3', 'r2']);
    // First shown item: nothing to pass, even though a hidden one may be above.
    state.favorites = [fav('t0'), ...state.favorites];
    assert.equal(moveFavorite('r3', 'up', { visibleIds: radios }), false);
    assert.equal(moveFavorite('r3', 'top', { visibleIds: radios }), false);
    // Top goes to the very start of the saved list.
    assert.equal(moveFavorite('r2', 'top', { visibleIds: radios }), true);
    assert.deepEqual(ids(state.favorites), ['r2', 't0', 'r3', 't1', 'r1', 't2', 't3']);
    assert.equal(moveFavorite('r2', 'down', { visibleIds: ['r2'] }), false);
    assert.equal(events(), 3);
  });
});

test('a move that cannot be saved leaves the order as it was', () => {
  withFavorites([fav('a'), fav('b')], ({ state, storage, events }) => {
    storage.fail = true;
    assert.equal(moveFavorite('b', 'up'), false);
    assert.deepEqual(ids(state.favorites), ['a', 'b']);
    assert.equal(events(), 0);
  });
});

test('metadata updates keep position; new favorites still go on top; bulk add and remove still work', () => {
  withFavorites([fav('a'), fav('b'), fav('c')], ({ state }) => {
    assert.equal(moveFavorite('c', 'top'), true);
    assert.equal(persistFavoriteMetadata({ ...state.favorites[2], title: 'Renamed b' }), true);
    assert.deepEqual(ids(state.favorites), ['c', 'a', 'b']);
    assert.equal(state.favorites[2].title, 'Renamed b');
    assert.equal(addFavorite(fav('new')), true);
    assert.deepEqual(ids(state.favorites), ['new', 'c', 'a', 'b']);
    assert.equal(addFavorites([fav('x'), fav('y'), fav('a')]).added, 2);
    assert.deepEqual(ids(state.favorites), ['x', 'y', 'new', 'c', 'a', 'b']);
    assert.equal(removeFavorite('new'), true);
    assert.deepEqual(ids(state.favorites), ['x', 'y', 'c', 'a', 'b']);
    // A rename in A-Z shows at its new place without touching the saved order.
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    assert.deepEqual(ids(displayFavorites()), ['a', 'c', 'b', 'x', 'y']);
    persistFavoriteMetadata({ ...state.favorites[4], title: 'zzz' });
    assert.deepEqual(ids(displayFavorites()), ['a', 'c', 'x', 'y', 'b']);
    assert.deepEqual(ids(state.favorites), ['x', 'y', 'c', 'a', 'b']);
  });
});

/* ============ Tuner ============ */

test('the Tuner "My favorites" dial follows the same order', () => {
  const list = [fav('k', 'KEXP'), fav('tv', 'News', { type: 'tv' }), fav('b', 'BBC'), fav('r', 'Radio 1')];
  assert.deepEqual(ids(favoriteStations(list, { band: 'radio' })), ['k', 'b', 'r']);
  assert.deepEqual(ids(favoriteStations(list, { band: 'radio', settings: { favoritesSort: 'name' } })), ['b', 'k', 'r']);
  assert.deepEqual(ids(favoriteStations(list, { band: 'radio', settings: { favoritesSort: 'bogus' } })), ['k', 'b', 'r']);
});

test('after a reorder or a new sort the dial stays on the playing station without retuning', async () => {
  const list = [fav('k', 'KEXP'), fav('b', 'BBC'), fav('r', 'Radio 1')];
  const before = favoriteStations(list, { band: 'radio' });
  const playing = before[0].id;
  const sorted = favoriteStations(list, { band: 'radio', settings: { favoritesSort: 'name' } });
  assert.equal(sorted[keptStationIndex(sorted, playing)].id, playing);
  const moved = favoriteStations([list[1], list[0], list[2]], { band: 'radio' });
  assert.equal(keptStationIndex(moved, playing), 1);
  assert.equal(keptStationIndex(moved, 'gone'), 0);
  assert.equal(keptStationIndex([], playing), 0);
  const tuner = await read('src/modes/tuner.js');
  const reload = tuner.match(/function loadFavoriteStations\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(reload, /state\.index = keptStationIndex\(state\.stations, selectedId\);/);
  assert.doesNotMatch(reload, /tuneCurrent|playItem/);
  // A new sort reloads the favorites dial live.
  assert.match(tuner, /if \(sourcesChanged \|\| contentChanged \|\| sortChanged\) loadFavoriteStations\(\);/);
});

/* ============ Library toolbar and cards ============ */

class Node extends FakeElement {
  constructor(id = '', tag = 'div') {
    super(id, tag);
    this.parentNode = null;
    this.html = '';
  }
  get childNodes() { return this.children; }
  get isConnected() {
    let node = this;
    while (node) { if (node.root) return true; node = node.parentNode; }
    return false;
  }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = value;
    if (value === '') for (const child of [...this.children]) this.removeChild(child);
  }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') {
      for (const node of [...child.children]) this.appendChild(node);
      return child;
    }
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
    // Like a browser: a node leaving the page takes focus with it.
    const active = globalThis.document?.activeElement;
    for (let node = active; node; node = node.parentNode) {
      if (node === child) { globalThis.document.activeElement = null; break; }
    }
    this.moves = (this.moves || 0) + 1;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...children);
  }
  focus() { globalThis.document.activeElement = this; }
  querySelector(selector) {
    if (selector === 'img') return this.children.find((node) => node.tagName === 'IMG') ?? null;
    return selector === '.empty-state' ? this.children.find((node) => node.className === 'empty-state') ?? null : null;
  }
  querySelectorAll(selector) {
    return selector === '.card' ? this.children.filter((node) => node.className?.startsWith('card')) : [];
  }
}

function withLibrary(favorites, fn, settings = {}) {
  return withFavorites(favorites, (context) => {
    const oldDocument = globalThis.document;
    const oldUi = { ...ui };
    const before = {
      source: view.activeSource, filters: { ...view.personalFilters.favorites }, start: view.renderStart,
      signature: view.renderSignature, items: view.items,
    };
    const scroller = new Node('', 'div');
    scroller.root = true;
    scroller.scrollTop = 480;
    const host = new Node('', 'div');
    scroller.appendChild(host);
    globalThis.document = {
      activeElement: null,
      createElement: (tag) => new Node('', tag),
      createDocumentFragment: () => new Node('', 'fragment'),
      createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
    };
    ui.resultsHost = host;
    ui.windowBack = null;
    ui.sentinelStatus = null;
    renderedIds.clear();
    view.activeSource = 'favorites';
    view.personalFilters.favorites = { query: '', type: '' };
    // Library re-renders on favorites-change (index.js); do the same here.
    const off = subscribe('favorites-change', () => renderResults());
    try {
      return fn({ ...context, host, scroller });
    } finally {
      off();
      renderedIds.clear();
      Object.assign(ui, oldUi);
      globalThis.document = oldDocument;
      view.activeSource = before.source;
      view.personalFilters.favorites = before.filters;
      view.renderStart = before.start;
      view.renderSignature = before.signature;
      view.items = before.items;
    }
  }, settings);
}

// __contentHidden keeps these cards from asking the artwork relay for logos.
const card = (id, title, type = 'radio') => fav(id, title, { type, __contentHidden: true });
const shownIds = (host) => host.children.map((node) => node.dataset.id);
const moveButton = (host, id, direction) => host.children.find((node) => node.dataset.id === id)
  ?.__orderControls?.__buttons[direction] ?? null;

test('Favorites cards get Move up / Move down / Move to top buttons named after the item', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Radio Paradise'), card('c', 'Gamma')], ({ host }) => {
    renderResults();
    assert.deepEqual(shownIds(host), ['a', 'b', 'c']);
    const paradise = host.children[1];
    assert.equal(paradise.classList.contains('has-order-controls'), true);
    const buttons = paradise.__orderControls.children;
    assert.deepEqual(buttons.map((button) => [button.tagName, button.getAttribute('type'), button.getAttribute('aria-label')]), [
      ['BUTTON', 'button', 'Move Radio Paradise to top'],
      ['BUTTON', 'button', 'Move Radio Paradise up'],
      ['BUTTON', 'button', 'Move Radio Paradise down'],
    ]);
    // The buttons sit before the star, so tab order follows the layout.
    const star = paradise.children.at(-1);
    assert.equal(star.className.startsWith('card-star'), true);
    assert.equal(paradise.children.at(-2), paradise.__orderControls);
    const disabled = (id, direction) => moveButton(host, id, direction).getAttribute('aria-disabled') === 'true';
    assert.deepEqual([disabled('a', 'top'), disabled('a', 'up'), disabled('a', 'down')], [true, true, false]);
    assert.deepEqual([disabled('b', 'top'), disabled('b', 'up'), disabled('b', 'down')], [false, false, false]);
    assert.deepEqual([disabled('c', 'top'), disabled('c', 'up'), disabled('c', 'down')], [false, false, true]);
  });
});

test('a move updates the cards in place and keeps focus on the pressed button', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Beta'), card('c', 'Gamma'), card('d', 'Delta')], ({ state, host, scroller, events }) => {
    renderResults();
    const nodes = new Map(host.children.map((node) => [node.dataset.id, node]));
    const up = moveButton(host, 'c', 'up');
    up.focus();
    up.dispatchEvent(new Event('click'));
    assert.deepEqual(ids(state.favorites), ['a', 'c', 'b', 'd']);
    assert.deepEqual(shownIds(host), ['a', 'c', 'b', 'd']);
    assert.equal(events(), 1);
    // Same card nodes (no rebuild, so artwork does not flash), same scroll.
    for (const node of host.children) assert.equal(node, nodes.get(node.dataset.id));
    assert.equal(scroller.scrollTop, 480);
    assert.equal(globalThis.document.activeElement, up);
    // To the top: the pressed button is now disabled but keeps focus.
    const top = moveButton(host, 'd', 'top');
    top.focus();
    top.dispatchEvent(new Event('click'));
    assert.deepEqual(shownIds(host), ['d', 'a', 'c', 'b']);
    assert.equal(globalThis.document.activeElement, top);
    assert.equal(top.getAttribute('aria-disabled'), 'true');
    assert.equal(moveButton(host, 'a', 'up').getAttribute('aria-disabled'), null);
    assert.equal(moveButton(host, 'b', 'down').getAttribute('aria-disabled'), 'true');
    // A disabled button does nothing.
    top.dispatchEvent(new Event('click'));
    assert.equal(events(), 2);
    assert.deepEqual(ids(state.favorites), ['d', 'a', 'c', 'b']);
  });
});

test('with a type filter, the move swaps with the nearest shown card', () => {
  const list = [card('r1', 'One'), card('t1', 'TV one', 'tv'), card('r2', 'Two'), card('t2', 'TV two', 'tv'), card('r3', 'Three')];
  withLibrary(list, ({ state, host }) => {
    view.personalFilters.favorites.type = 'radio';
    renderResults();
    assert.deepEqual(shownIds(host), ['r1', 'r2', 'r3']);
    assert.equal(onMoveFavorite('r3', 'up', moveButton(host, 'r3', 'up')), true);
    assert.deepEqual(ids(state.favorites), ['r1', 't1', 'r3', 't2', 'r2']);
    assert.deepEqual(shownIds(host), ['r1', 'r3', 'r2']);
    assert.equal(moveButton(host, 'r1', 'up').getAttribute('aria-disabled'), 'true');
    assert.equal(moveButton(host, 'r2', 'down').getAttribute('aria-disabled'), 'true');
  });
});

test('A-Z shows no move buttons, and switching back to My order brings them back in place', () => {
  withLibrary([card('b', 'Beta'), card('a', 'Alpha'), card('c', 'Gamma')], ({ state, host }) => {
    renderResults();
    const nodes = new Map(host.children.map((node) => [node.dataset.id, node]));
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    assert.equal(favoritesManualOrder(), false);
    renderResults();
    assert.deepEqual(shownIds(host), ['a', 'b', 'c']);
    for (const node of host.children) {
      assert.equal(node, nodes.get(node.dataset.id));
      assert.equal(node.__orderControls, null);
      assert.equal(node.classList.contains('has-order-controls'), false);
    }
    assert.equal(onMoveFavorite('c', 'up'), false);
    assert.deepEqual(ids(state.favorites), ['b', 'a', 'c']);
    state.settings = normalizeSettings({ favoritesSort: 'manual' });
    renderResults();
    assert.deepEqual(shownIds(host), ['b', 'a', 'c']);
    assert.ok(host.children.every((node) => node.__orderControls));
  });
});

test('move buttons never appear outside Favorites', () => {
  withLibrary([card('a', 'Alpha')], ({ host }) => {
    view.activeSource = 'all';
    view.items = [card('x', 'Catalog item'), card('a', 'Alpha')];
    renderResults();
    assert.deepEqual(shownIds(host), ['x', 'a']);
    assert.ok(host.children.every((node) => !node.__orderControls));
    assert.equal(favoritesManualOrder(), false);
    view.activeSource = 'playlists';
    assert.equal(favoritesManualOrder(), false);
  });
});

test('a card reused by another view loses its move buttons, and gets them back in Favorites "My order"', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Beta')], ({ state, host }) => {
    const hasControls = () => host.children.map((node) => Boolean(node.__orderControls)
      && node.classList.contains('has-order-controls'));
    renderResults();
    const nodes = [...host.children];
    assert.deepEqual(hasControls(), [true, true]);
    // The same items in the same order elsewhere: the cards are reused...
    view.activeSource = 'all';
    view.items = [card('a', 'Alpha'), card('b', 'Beta')];
    renderResults();
    assert.deepEqual(host.children, nodes);
    // ...but carry no move buttons there.
    assert.deepEqual(hasControls(), [false, false]);
    view.activeSource = 'favorites';
    renderResults();
    assert.deepEqual(host.children, nodes);
    assert.deepEqual(hasControls(), [true, true]);
    for (const [sort, expected] of [['name', [false, false]], ['manual', [true, true]], ['name', [false, false]], ['manual', [true, true]]]) {
      state.settings = normalizeSettings({ favoritesSort: sort });
      renderResults();
      assert.deepEqual(hasControls(), expected, sort);
    }
    // Each card has one set of move buttons, not one per visit.
    assert.ok(host.children.every((node) => node.children.filter((child) => child.className === 'card-order').length === 1));
  });
});

test('a favorite renamed by a metadata save is redrawn; unchanged cards are only moved', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Beta'), card('c', 'Gamma')], ({ state, host }) => {
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    renderResults();
    const before = new Map(host.children.map((node) => [node.dataset.id, node]));
    // Saved again with a new title but no new __revision.
    assert.equal(persistFavoriteMetadata({ ...state.favorites[2], title: 'Aardvark' }), true);
    renderResults();
    assert.deepEqual(shownIds(host), ['c', 'a', 'b']);
    const title = (id) => host.children.find((node) => node.dataset.id === id).children[0].children[1].children[0].textContent;
    assert.equal(title('c'), 'Aardvark');
    assert.notEqual(host.children[0], before.get('c'));
    assert.equal(host.children[1], before.get('a'));
    assert.equal(host.children[2], before.get('b'));
    // In "My order" the redrawn card's move buttons carry the new name, and
    // focus stays on the pressed button when its card is redrawn.
    state.settings = normalizeSettings({ favoritesSort: 'manual' });
    renderResults();
    assert.equal(moveButton(host, 'c', 'up').getAttribute('aria-label'), 'Move Aardvark up');
    const up = moveButton(host, 'b', 'up');
    up.focus();
    persistFavoriteMetadata({ ...state.favorites[1], title: 'Bravo' });
    up.dispatchEvent(new Event('click'));
    assert.deepEqual(ids(state.favorites), ['b', 'a', 'c']);
    const fresh = moveButton(host, 'b', 'up');
    assert.notEqual(fresh, up);
    assert.equal(fresh.getAttribute('aria-label'), 'Move Bravo up');
    assert.equal(globalThis.document.activeElement, fresh);
  });
});

test('new artwork redraws a card, but its own artwork lookup does not', () => {
  // No source and no relay URL: these cards never start an artwork request.
  const art = (id, url) => fav(id, id.toUpperCase(), { source: '', thumbnail: url });
  withLibrary([art('x', 'https://example.org/x.png'), art('y', 'https://example.org/y.png')], ({ state, host }) => {
    renderResults();
    const [x, y] = host.children;
    // Hydration on the card's own item: blanked while it works, then a relay.
    const item = state.favorites[0];
    item.thumbnail = '';
    renderResults();
    item.thumbnail = '/api/v1/assets/abcdefghijklmnop1234';
    item._extra = { artworkUrl: 'https://example.org/x.png' };
    renderResults();
    assert.deepEqual(host.children, [x, y]);
    // A metadata save with different artwork redraws only that card.
    persistFavoriteMetadata({ ...state.favorites[1], thumbnail: 'https://example.org/y2.png' });
    renderResults();
    assert.equal(host.children[0], x);
    assert.notEqual(host.children[1], y);
    assert.equal(host.children[1].dataset.id, 'y');
  });
});

test('artwork that is really gone redraws the card to its initials; a blank lookup does not', () => {
  // As saved favorites are: a metadata save changes nothing else they show.
  const art = (id, url) => fav(id, id.toUpperCase(), { source: '', thumbnail: url, content_rating: 'unrated' });
  const list = [art('x', 'https://example.org/x.png'), art('y', 'https://example.org/y.png'), art('z', 'https://example.org/z.png')];
  withLibrary(list, ({ state, host }) => {
    renderResults();
    const [x, y, z] = host.children;
    // x and y show a loaded image; z's lookup has not finished.
    for (const node of [x, y]) node.__thumb.appendChild(new Node('', 'img'));
    // y: a saved favorite's session image is stripped and will be fetched again.
    persistFavoriteMetadata({ ...state.favorites[1], thumbnail: '/api/v1/assets/abcdefghijklmnop1234', _extra: {} });
    assert.equal(state.favorites[1]._extra.needsArtwork, true);
    // z: blank while its lookup runs.
    state.favorites[2].thumbnail = '';
    renderResults();
    assert.deepEqual(host.children, [x, y, z]);
    // x: replaced by the same item without artwork.
    persistFavoriteMetadata({ ...state.favorites[0], thumbnail: '', _extra: {} });
    renderResults();
    const redrawn = host.children[0];
    assert.notEqual(redrawn, x);
    assert.equal(redrawn.dataset.id, 'x');
    assert.equal(redrawn.__thumb.querySelector('img'), null);
    assert.equal(redrawn.__thumb.children[0].classList.contains('has-initials'), true);
    assert.deepEqual(host.children.slice(1), [y, z]);
  });
});

test('a reused card opens, plays, stars and moves the current item, not the one it was drawn for', async () => {
  withLibrary([], ({ state, host }) => {
    view.activeSource = 'all';
    const first = { ...card('a', 'Alpha'), stream_url: 'https://example.org/old.m3u8' };
    view.items = [first];
    renderResults();
    const node = host.children[0];
    // Same shown data, new stream URL: the card is kept but takes the new item.
    const replacement = { ...first, stream_url: 'https://example.org/new.m3u8' };
    view.items = [replacement];
    renderResults();
    assert.equal(host.children[0], node);
    assert.equal(node.__item, replacement);
    node.__star.dispatchEvent(new Event('click'));
    assert.deepEqual(ids(state.favorites), ['a']);
    assert.equal(state.favorites[0].stream_url, 'https://example.org/new.m3u8');
  });
  withLibrary([card('a', 'Alpha'), card('b', 'Beta')], ({ state, host }) => {
    renderResults();
    const node = host.children[1];
    state.favorites = [state.favorites[0], { ...state.favorites[1], stream_url: 'https://example.org/b2.m3u8' }];
    renderResults();
    assert.equal(host.children[1], node);
    assert.equal(node.__item, state.favorites[1]);
    moveButton(host, 'b', 'up').dispatchEvent(new Event('click'));
    assert.deepEqual(ids(state.favorites), ['b', 'a']);
  });
  // The card click hands over the card's current item as well.
  const render = await read('src/modes/library/render.js');
  assert.match(render, /on: \{ click: \(\) => onCardClick\(card\.__item \|\| item\) \}/);
  assert.match(render, /toggleFav\(card\.__item \|\| item, star\)/);
  assert.match(render, /onMoveFavorite\(\(card\?\.__item \|\| item\)\.id, action\.direction, button\)/);
});

test('the Library Favorites pool follows the sort choice', () => {
  withLibrary([card('b', 'Beta'), card('a', 'alpha')], ({ state }) => {
    assert.deepEqual(ids(libraryPool()), ['b', 'a']);
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    assert.deepEqual(ids(libraryPool()), ['a', 'b']);
  });
});

class ShellElement extends FakeElement {
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = [...children]; }
}

test('the Sort favorites control shows only in Favorites and saves the choice', () => {
  withFavorites([], ({ state, values }) => {
    const oldDocument = globalThis.document;
    const oldObserver = globalThis.IntersectionObserver;
    const oldUi = { ...ui };
    const oldSource = view.activeSource;
    const oldObserverRef = view.infiniteObserver;
    try {
      globalThis.document = { createElement: (tag) => new ShellElement('', tag), createDocumentFragment: () => new ShellElement('', 'fragment') };
      globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
      view.activeSource = 'all';
      buildShell();
      assert.equal(ui.favoritesSort.style.display, 'none');
      selectSource('favorites');
      const group = ui.favoritesSort;
      assert.equal(group.style.display, '');
      assert.equal(group.getAttribute('role'), 'group');
      assert.equal(group.getAttribute('aria-label'), 'Sort favorites');
      const buttons = group.children.filter((node) => node.tagName === 'BUTTON');
      assert.deepEqual(buttons.map((node) => [node.getAttribute('type'), node.textContent, node.getAttribute('aria-pressed')]),
        [['button', 'My order', 'true'], ['button', 'A–Z', 'false']]);
      assert.ok(buttons.every((node) => node.className === 'chip'));
      buttons[1].dispatchEvent(new Event('click'));
      assert.equal(state.settings.favoritesSort, 'name');
      assert.equal(JSON.parse(values.get(STORAGE_KEYS.settings)).favoritesSort, 'name');
      assert.deepEqual(buttons.map((node) => node.getAttribute('aria-pressed')), ['false', 'true']);
      selectSource('playlists');
      assert.equal(group.style.display, 'none');
      selectSource('favorites');
      assert.equal(group.style.display, '');
      buttons[0].dispatchEvent(new Event('click'));
      assert.equal(state.settings.favoritesSort, 'manual');
    } finally {
      view.searchDebounced?.cancel?.();
      view.searchDebounced = null;
      view.infiniteObserver = oldObserverRef;
      view.activeSource = oldSource;
      view.personalFilters.favorites = { query: '', type: '' };
      view.personalFilters.playlists = { query: '', type: '' };
      Object.assign(ui, oldUi);
      globalThis.document = oldDocument;
      globalThis.IntersectionObserver = oldObserver;
    }
  });
});

test('the move buttons fit beside the star in the compact Favorites card', async () => {
  const css = await read('src/styles/library.css');
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`))?.[0] || '';
  // The star keeps its place; the move column sits just left of it.
  assert.match(rule('.library-root.is-personal-view .card-star'), /right: 10px;/);
  assert.match(rule('.card-order'), /right: 40px;/);
  assert.match(rule('.card-order-btn'), /width: 22px;/);
  // The card text makes room for both, so the title is cut short, not covered.
  assert.match(css, /\.library-root\.is-personal-view \.card\.has-order-controls \.card-body \{ padding-right: 72px; \}/);
  assert.match(css, /\.card-order-btn\[aria-disabled="true"\]/);
});
