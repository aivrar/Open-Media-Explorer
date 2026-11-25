import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  assignFavoriteToGroup, createFavoriteGroup, deleteFavoriteGroup, FAVORITE_GROUPS_EVENT, favoriteGroupOf,
  getFavoriteGroups, UNCATEGORIZED,
} from '../src/lib/favorite-groups.js';
import { getState, normalizeSettings, persistFavoriteMetadata, removeFavorite, subscribe } from '../src/lib/state.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { buildShell } from '../src/modes/library/shell.js';
import { selectSource } from '../src/modes/library/sidebar.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { onMoveFavorite, renderResults } from '../src/modes/library/render.js';
import { setCategoryConfirm, syncFavoriteCategories } from '../src/modes/library/favorite-categories.js';
import { closeCategoryMenu, menuPosition, openCategoryMenuElement } from '../src/modes/library/card-category.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const KEY = 'worldmedia.favgroups.v1';
// __contentHidden keeps these cards from asking the artwork relay for logos.
const card = (id, title = id, type = 'radio') => ({ id, title, type, source: 'radio-browser', __contentHidden: true });

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
    const active = globalThis.document?.activeElement;
    for (let node = active; node; node = node.parentNode) {
      if (node === child) { globalThis.document.activeElement = null; break; }
    }
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...children);
  }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  focus() { globalThis.document.activeElement = this; }
  select() {}
  scrollIntoView() {}
  querySelector(selector) {
    if (selector === 'img') return this.children.find((node) => node.tagName === 'IMG') ?? null;
    return selector === '.empty-state' ? this.children.find((node) => node.className === 'empty-state') ?? null : null;
  }
  querySelectorAll(selector) {
    if (selector === '.card') return this.children.filter((node) => node.className?.startsWith?.('card'));
    return [];
  }
}

const all = (node) => [node, ...(node.children || []).flatMap(all)];
const key = (name) => Object.assign(new Event('keydown', { cancelable: true }), { key: name });
const click = (node) => node.dispatchEvent(new Event('click'));
const chips = () => ui.categoryChips.children;
const chipText = () => chips().map((node) => node.children.map((part) => part.textContent).join(' '));
const pressedChip = () => chips().find((node) => node.getAttribute('aria-pressed') === 'true')?.getAttribute('data-category');
const chipFor = (name) => chips().find((node) => node.children[0].textContent === name);
const shownIds = () => ui.resultsHost.children.filter((node) => node.dataset.id).map((node) => node.dataset.id);
const cardNode = (id) => ui.resultsHost.children.find((node) => node.dataset.id === id);

/** A Library shell on a fake page, showing Favorites, with the same
 *  subscriptions as index.js. */
function withLibrary(favorites, fn, { stored, settings = {} } = {}) {
  const state = getState();
  const previous = {
    favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage,
    document: globalThis.document, observer: globalThis.IntersectionObserver, fetch: globalThis.fetch,
    source: view.activeSource, filters: view.personalFilters.favorites, playlistFilters: view.personalFilters.playlists,
    query: view.query, items: view.items, start: view.renderStart, signature: view.renderSignature,
    observerRef: view.infiniteObserver, ui: { ...ui },
  };
  const values = new Map();
  if (stored !== undefined) values.set(KEY, stored);
  const storage = {
    writes: 0,
    getItem: (name) => values.get(name) ?? null,
    setItem(name, value) { if (name === KEY) storage.writes += 1; values.set(name, String(value)); },
    removeItem(name) { if (name === KEY) storage.writes += 1; values.delete(name); },
  };
  const body = new Node('', 'body');
  body.root = true;
  const page = new EventTarget();
  globalThis.document = Object.assign(page, {
    body,
    activeElement: null,
    documentElement: new Node('', 'html'),
    createElement: (tag) => new Node('', tag),
    createDocumentFragment: () => new Node('', 'fragment'),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  });
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.fetch = () => { assert.fail('Favorites categories must not fetch'); };
  globalThis.localStorage = storage;
  state.favorites = favorites.map((item) => ({ ...item }));
  state.settings = normalizeSettings(settings);
  view.personalFilters.favorites = { query: '', type: '', category: '' };
  view.personalFilters.playlists = { query: '', type: '' };
  view.activeSource = 'all';
  view.query = '';
  view.items = [card('catalog', 'Catalog item')];
  renderedIds.clear();
  const offs = [
    subscribe('favorites-change', () => { syncFavoriteCategories(); if (view.activeSource === 'favorites') renderResults(); }),
    subscribe(FAVORITE_GROUPS_EVENT, () => { syncFavoriteCategories(); if (view.activeSource === 'favorites') renderResults(); }),
  ];
  try {
    buildShell();
    ui.root.root = true;
    selectSource('favorites');
    return fn({ state, storage, values, body, page });
  } finally {
    closeCategoryMenu({ restoreFocus: false });
    setCategoryConfirm(null);
    offs.forEach((off) => off());
    view.searchDebounced?.cancel?.();
    view.searchDebounced = null;
    renderedIds.clear();
    Object.assign(ui, previous.ui);
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    globalThis.document = previous.document;
    globalThis.IntersectionObserver = previous.observer;
    globalThis.fetch = previous.fetch;
    view.activeSource = previous.source;
    view.personalFilters.favorites = previous.filters;
    view.personalFilters.playlists = previous.playlistFilters;
    view.query = previous.query;
    view.items = previous.items;
    view.renderStart = previous.start;
    view.renderSignature = previous.signature;
    view.infiniteObserver = previous.observerRef;
    clearPersistenceFailure('favorite-groups');
    clearPersistenceFailure('favorites');
  }
}

const four = () => [card('a', 'Alpha'), card('b', 'Beta', 'tv'), card('c', 'Charlie'), card('d', 'Delta')];

/** Rock holds a and c, Talk holds b; d is in none. */
function rockAndTalk() {
  const rock = createFavoriteGroup('Rock').group;
  const talk = createFavoriteGroup('Talk').group;
  assignFavoriteToGroup('a', rock.id);
  assignFavoriteToGroup('c', rock.id);
  assignFavoriteToGroup('b', talk.id);
  return { rock, talk };
}

test('Export sends the current Favorites view in M3U8 with one click', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const favorites = [
    { ...card('news', 'Evening News', 'tv'), __contentHidden: false, stream_url: 'https://tv.example.org/news' },
    { ...card('radio', 'News Radio'), __contentHidden: false, stream_url: 'https://radio.example.org/news' },
  ];
  const requests = [];
  const message = withLibrary(favorites, () => {
    const status = all(ui.favoritesActions).find((node) => node.getAttribute('role') === 'status');
    const format = all(ui.favoritesActions).find((node) => node.getAttribute('aria-label') === 'Export format');
    assert.equal(ui.favoritesExport.disabled, false);
    assert.equal(format.value, 'm3u8');
    globalThis.fetch = async (path, options) => {
      requests.push([path, options]);
      const data = path === '/api/v1/session' ? { token: 'export-test' } : { name: 'Favorites.m3u8', skipped: 0 };
      return new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } });
    };
    click(ui.personalType.children.find((node) => node.getAttribute('data-type') === 'tv'));
    click(ui.favoritesExport);
    ui.searchInput.value = 'no matching result';
    ui.searchInput.dispatchEvent(new Event('input'));
    assert.equal(ui.favoritesExport.disabled, true);
    selectSource('all');
    assert.equal(ui.personalControls.style.display, 'none');
    return status;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map(([path]) => path), ['/api/v1/session', '/api/v1/playlists/export']);
  const body = JSON.parse(requests[1][1].body);
  assert.deepEqual([body.format, body.type, body.stations.map(({ name }) => name)], ['m3u8', 'TV', ['Evening News']]);
  assert.equal(message.textContent, 'Saved Favorites.m3u8 in Downloads.');
});

/* ============ The chip row ============ */

test('the category row shows in Favorites only, under the type and sort buttons', () => {
  withLibrary(four(), () => {
    const controls = ui.personalControls.children;
    assert.ok(controls.indexOf(ui.favoriteCategories) > controls.indexOf(ui.favoritesSort));
    assert.equal(ui.favoriteCategories.style.display, '');
    assert.equal(ui.categoryChips.getAttribute('role'), 'group');
    // No categories yet: only "All categories", pressed, and no Uncategorized.
    assert.deepEqual(chips().map((node) => [node.tagName, node.getAttribute('type'), node.textContent || node.children[0].textContent]),
      [['BUTTON', 'button', 'All categories']]);
    assert.equal(pressedChip(), '');
    assert.equal(ui.categoryNew.textContent, '+ New category');
    assert.equal(ui.categoryRename.hidden, true);
    assert.equal(ui.categoryDelete.hidden, true);
    view.items = [card('x')];
    selectSource('playlists');
    assert.equal(ui.favoriteCategories.style.display, 'none');
    selectSource('favorites');
    assert.equal(ui.favoriteCategories.style.display, '');
  });
});

test('"+ New category" asks for a name inline, with plain messages, Enter to add and Escape to cancel', () => {
  withLibrary(four(), ({ storage }) => {
    click(ui.categoryNew);
    assert.equal(ui.categoryForm.hidden, false);
    assert.equal(ui.categoryNew.getAttribute('aria-expanded'), 'true');
    assert.equal(globalThis.document.activeElement, ui.categoryInput);
    // Enter submits the form.
    ui.categoryInput.value = '   ';
    ui.categoryForm.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(ui.categoryFormMessage.textContent, 'Type a name for the category.');
    assert.equal(ui.categoryInput.getAttribute('aria-invalid'), 'true');
    ui.categoryInput.value = ' Rock  ';
    ui.categoryForm.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(ui.categoryForm.hidden, true);
    assert.equal(globalThis.document.activeElement, ui.categoryNew);
    assert.match(ui.categoryStatus.textContent, /Category "Rock" added/);
    assert.equal(storage.writes, 1);
    assert.deepEqual(chipText(), ['All categories', 'Rock 0', 'Uncategorized 4']);
    // The new category is not chosen by itself; the view still shows everything.
    assert.equal(pressedChip(), '');
    assert.deepEqual(shownIds(), ['a', 'b', 'c', 'd']);
    // A name in use (any case) is refused with a message; Escape cancels.
    click(ui.categoryNew);
    ui.categoryInput.value = 'ROCK';
    ui.categoryForm.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(ui.categoryFormMessage.textContent, 'There is already a category called "Rock".');
    ui.categoryInput.dispatchEvent(key('Escape'));
    assert.equal(ui.categoryForm.hidden, true);
    assert.equal(ui.categoryFormMessage.textContent, '');
    assert.equal(globalThis.document.activeElement, ui.categoryNew);
    assert.equal(storage.writes, 1);
  });
});

test('a chip filters the view and combines with the type buttons, the search box and both sorts', () => {
  withLibrary(four(), ({ state }) => {
    const { rock } = rockAndTalk();
    assert.deepEqual(chipText(), ['All categories', 'Rock 2', 'Talk 1', 'Uncategorized 1']);
    assert.equal(chipFor('Rock').getAttribute('aria-label'), 'Rock, 2 favorites');
    assert.equal(chipFor('Rock').getAttribute('title'), 'Rock (2 favorites)');
    click(chipFor('Rock'));
    assert.equal(view.personalFilters.favorites.category, rock.id);
    assert.equal(pressedChip(), rock.id);
    assert.match(chipFor('Rock').className, /\bis-active\b/);
    assert.doesNotMatch(chipFor('Talk').className, /\bis-active\b/);
    assert.deepEqual(shownIds(), ['a', 'c']);
    // With a type: Rock radio only.
    view.personalFilters.favorites.type = 'tv';
    renderResults();
    assert.deepEqual(shownIds(), []);
    assert.match(ui.resultsHost.children[0].getAttribute('data-message'), /No favorites in this category match/);
    view.personalFilters.favorites.type = 'radio';
    view.personalFilters.favorites.query = 'char';
    renderResults();
    assert.deepEqual(shownIds(), ['c']);
    view.personalFilters.favorites.query = '';
    // A-Z keeps the category.
    state.favorites = [state.favorites[2], state.favorites[3], state.favorites[0], state.favorites[1]];
    renderResults();
    assert.deepEqual(shownIds(), ['c', 'a']);
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    renderResults();
    assert.deepEqual(shownIds(), ['a', 'c']);
    view.personalFilters.favorites.type = '';
    click(chipFor('Uncategorized'));
    assert.equal(pressedChip(), UNCATEGORIZED);
    assert.deepEqual(shownIds(), ['d']);
    click(chipFor('All categories'));
    assert.deepEqual(shownIds(), ['a', 'b', 'c', 'd']);
  });
});

test('in "My order" the move buttons work inside a category, trading places with the nearest shown favorite', () => {
  withLibrary(four(), ({ state }) => {
    rockAndTalk();
    click(chipFor('Rock'));
    const nodes = ui.resultsHost.children.slice();
    assert.equal(onMoveFavorite('c', 'up', cardNode('c').__orderControls.__buttons.up), true);
    assert.deepEqual(state.favorites.map((item) => item.id), ['c', 'b', 'a', 'd']);
    assert.deepEqual(shownIds(), ['c', 'a']);
    // Same card nodes, moved rather than rebuilt.
    assert.deepEqual(new Set(ui.resultsHost.children), new Set(nodes));
    assert.equal(cardNode('c').__orderControls.__buttons.up.getAttribute('aria-disabled'), 'true');
    assert.equal(cardNode('a').__orderControls.__buttons.down.getAttribute('aria-disabled'), 'true');
  });
});

test('the chosen chip offers Rename and Delete; deleting asks first and keeps the favorites', () => {
  withLibrary(four(), ({ state }) => {
    const { rock } = rockAndTalk();
    click(chipFor('Rock'));
    assert.equal(ui.categoryRename.hidden, false);
    assert.equal(ui.categoryRename.getAttribute('aria-label'), 'Rename the category Rock');
    assert.equal(ui.categoryDelete.getAttribute('aria-label'), 'Delete the category Rock');
    click(ui.categoryRename);
    assert.equal(ui.categoryForm.hidden, false);
    assert.equal(ui.categoryInput.value, 'Rock');
    assert.equal(ui.categorySubmit.textContent, 'Save');
    ui.categoryInput.value = 'talk';
    ui.categoryForm.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.match(ui.categoryFormMessage.textContent, /already a category called "Talk"/);
    ui.categoryInput.value = 'Classic   rock';
    ui.categoryForm.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(ui.categoryForm.hidden, true);
    assert.equal(globalThis.document.activeElement, ui.categoryRename);
    assert.deepEqual(chipText(), ['All categories', 'Classic rock 2', 'Talk 1', 'Uncategorized 1']);
    assert.equal(pressedChip(), rock.id);
    assert.deepEqual(shownIds(), ['a', 'c']);
    // Delete: a "no" changes nothing.
    const asked = [];
    setCategoryConfirm((text) => { asked.push(text); return false; });
    click(ui.categoryDelete);
    assert.deepEqual(asked, ['Delete the category "Classic rock"? Its 2 favorites stay in Favorites, without a category.']);
    assert.equal(getFavoriteGroups().length, 2);
    setCategoryConfirm(() => true);
    click(ui.categoryDelete);
    assert.deepEqual(getFavoriteGroups().map((group) => group.name), ['Talk']);
    assert.equal(view.personalFilters.favorites.category, '');
    assert.equal(pressedChip(), '');
    assert.equal(globalThis.document.activeElement, chips()[0]);
    assert.match(ui.categoryStatus.textContent, /deleted\. Its favorites were kept/);
    assert.deepEqual(state.favorites.map((item) => item.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(shownIds(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(chipText(), ['All categories', 'Talk 1', 'Uncategorized 3']);
  });
});

test('the delete question agrees with the number of favorites in the category', () => {
  withLibrary(four(), () => {
    rockAndTalk();
    createFavoriteGroup('Empty');
    const asked = [];
    setCategoryConfirm((text) => { asked.push(text); return false; });
    for (const name of ['Talk', 'Rock', 'Empty']) {
      click(chipFor(name));
      click(ui.categoryDelete);
    }
    assert.deepEqual(asked, [
      'Delete the category "Talk"? Its 1 favorite stays in Favorites, without a category.',
      'Delete the category "Rock"? Its 2 favorites stay in Favorites, without a category.',
      'Delete the category "Empty"? Your favorites are not changed.',
    ]);
    assert.equal(getFavoriteGroups().length, 3);
  });
});

test('a chosen category deleted anywhere falls back to All categories; Uncategorized goes with the last category', () => {
  withLibrary(four(), () => {
    const { rock, talk } = rockAndTalk();
    click(chipFor('Talk'));
    assert.deepEqual(shownIds(), ['b']);
    deleteFavoriteGroup(talk.id);
    assert.equal(pressedChip(), '');
    assert.deepEqual(shownIds(), ['a', 'b', 'c', 'd']);
    click(chipFor('Uncategorized'));
    assert.deepEqual(shownIds(), ['b', 'd']);
    deleteFavoriteGroup(rock.id);
    assert.deepEqual(chipText(), ['All categories']);
    assert.equal(pressedChip(), '');
    assert.deepEqual(shownIds(), ['a', 'b', 'c', 'd']);
  });
});

test('the chosen category is kept for the session, across leaving and coming back to Favorites', () => {
  withLibrary(four(), () => {
    const { rock } = rockAndTalk();
    click(chipFor('Rock'));
    view.items = [card('x')];
    selectSource('playlists');
    selectSource('favorites');
    assert.equal(pressedChip(), rock.id);
    assert.deepEqual(shownIds(), ['a', 'c']);
    // A Library built again (another visit) shows the same choice.
    buildShell();
    ui.root.root = true;
    selectSource('favorites');
    assert.equal(pressedChip(), rock.id);
  });
});

test('counts follow added and removed favorites', () => {
  withLibrary(four(), () => {
    const { rock } = rockAndTalk();
    removeFavorite('a');
    assert.deepEqual(chipText(), ['All categories', 'Rock 1', 'Talk 1', 'Uncategorized 1']);
    assert.equal(favoriteGroupOf('a'), '');
    assert.ok(rock.id);
  });
});

test('50 categories with long names: every chip is there, named in full on hover, and New category is off', () => {
  const groups = Array.from({ length: 50 }, (_, index) => ({ id: `g${index}`, name: `${'Long category name '.repeat(2).slice(0, 36)} ${index}` }));
  withLibrary(four(), () => {
    syncFavoriteCategories();
    assert.equal(chips().length, 52);
    const chip = chips()[50];
    assert.equal(chip.children[0].textContent, groups[49].name);
    assert.equal(chip.getAttribute('title'), `${groups[49].name} (0 favorites)`);
    assert.equal(chip.children[0].className, 'category-chip-name');
    assert.equal(ui.categoryNew.disabled, true);
    assert.match(ui.categoryNew.title, /50 categories/);
  }, { stored: JSON.stringify({ version: 1, groups, assign: {} }) });
});

test('category names are text, never markup', () => {
  withLibrary(four(), () => {
    const result = createFavoriteGroup('<img src=x onerror=alert(1)>');
    assert.equal(result.ok, true);
    const chip = chipFor('<img src=x onerror=alert(1)>');
    assert.equal(chip.children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.ok(all(ui.favoriteCategories).every((node) => !node.html));
  });
});

/* ============ The card button and its menu ============ */

test('each Favorites card gets a category button before its move buttons and star, named after its category', () => {
  withLibrary([card('a', 'Radio Paradise'), card('b', 'Beta')], () => {
    const paradise = cardNode('a');
    const button = paradise.__categoryButton;
    assert.ok(button);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Category for Radio Paradise: none');
    assert.equal(paradise.classList.contains('has-category-control'), true);
    // Not inside the card's own open button; before the move buttons and the star.
    assert.equal(button.parentNode, paradise);
    assert.deepEqual(paradise.children.map((node) => node.className.split(' ')[0]),
      ['card-open', 'card-category', 'card-order', 'card-star']);
    const rock = createFavoriteGroup('Rock').group;
    assignFavoriteToGroup('a', rock.id);
    assert.equal(cardNode('a').__categoryButton, button);
    assert.equal(button.getAttribute('aria-label'), 'Category for Radio Paradise: Rock');
    assert.equal(button.title, 'Category: Rock');
    assert.equal(button.classList.contains('is-set'), true);
    // A rename shows at once.
    assert.equal(cardNode('b').__categoryButton.getAttribute('aria-label'), 'Category for Beta: none');
  });
});

test('the category button is only in Favorites: a reused card loses it elsewhere and gets one back', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Beta')], ({ state }) => {
    const nodes = ui.resultsHost.children.slice();
    view.activeSource = 'all';
    view.items = [card('a', 'Alpha'), card('b', 'Beta')];
    renderResults();
    assert.deepEqual(ui.resultsHost.children, nodes);
    assert.ok(nodes.every((node) => !node.__categoryButton && !node.classList.contains('has-category-control')));
    assert.ok(nodes.every((node) => !node.children.some((child) => child.className === 'card-category')));
    view.activeSource = 'playlists';
    renderResults();
    assert.ok(ui.resultsHost.children.every((node) => !node.__categoryButton));
    view.activeSource = 'favorites';
    renderResults();
    for (const sort of ['name', 'manual', 'name', 'manual']) {
      state.settings = normalizeSettings({ favoritesSort: sort });
      renderResults();
      assert.ok(ui.resultsHost.children.every((node) => node.__categoryButton), sort);
    }
    // One button per card, not one per visit.
    assert.ok(ui.resultsHost.children.every((node) => node.children.filter((child) => child.className.startsWith('card-category')).length === 1));
    // In A-Z (no move buttons) it sits just before the star.
    state.settings = normalizeSettings({ favoritesSort: 'name' });
    renderResults();
    assert.deepEqual(cardNode('a').children.map((node) => node.className.split(' ')[0]), ['card-open', 'card-category', 'card-star']);
  });
});

test('a redrawn card gets a fresh button with the new name, and focus stays on it', () => {
  withLibrary([card('a', 'Alpha'), card('b', 'Beta')], ({ state }) => {
    const old = cardNode('b').__categoryButton;
    old.focus();
    persistFavoriteMetadata({ ...state.favorites[1], title: 'Bravo' });
    renderResults();
    const fresh = cardNode('b').__categoryButton;
    assert.notEqual(fresh, old);
    assert.equal(fresh.getAttribute('aria-label'), 'Category for Bravo: none');
    assert.equal(globalThis.document.activeElement, fresh);
  });
});

test('the menu lists each category (current one marked), None and New category, and opens on the page, not in the card', () => {
  withLibrary(four(), ({ body }) => {
    const { rock } = rockAndTalk();
    const button = cardNode('a').__categoryButton;
    const event = new Event('click');
    let stopped = false;
    event.stopPropagation = () => { stopped = true; };
    button.dispatchEvent(event);
    assert.equal(stopped, true);
    // The card's own click (open and play) did not happen.
    assert.notEqual(view.currentId, 'a');
    const menu = openCategoryMenuElement();
    assert.equal(menu.parentNode, body);
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(menu.getAttribute('aria-label'), 'Category for Alpha');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    const entries = menu.children.filter((node) => node.getAttribute('role') !== null);
    assert.deepEqual(entries.map((node) => [node.getAttribute('role'), node.textContent || node.children[0]?.textContent || '', node.getAttribute('aria-checked')]), [
      ['menuitemradio', 'Rock', 'true'], ['menuitemradio', 'Talk', 'false'], ['menuitemradio', 'None', 'false'],
      ['separator', '', null], ['menuitem', 'New category\u2026', null], ['status', '', null],
    ]);
    // Focus starts on the current category.
    assert.equal(globalThis.document.activeElement, entries[0]);
    assert.ok(rock.id);
  });
});

test('the menu works from the keyboard: arrows, Home, End, Escape back to the button', () => {
  withLibrary(four(), () => {
    rockAndTalk();
    const button = cardNode('d').__categoryButton;
    button.dispatchEvent(key('ArrowDown'));
    const menu = openCategoryMenuElement();
    const items = menu.children.filter((node) => ['menuitem', 'menuitemradio'].includes(node.getAttribute('role')));
    const focused = () => items.indexOf(globalThis.document.activeElement);
    assert.equal(focused(), 0);
    menu.dispatchEvent(key('ArrowDown'));
    assert.equal(focused(), 1);
    menu.dispatchEvent(key('ArrowUp'));
    menu.dispatchEvent(key('ArrowUp'));
    assert.equal(focused(), 3); // Wraps to the last entry.
    menu.dispatchEvent(key('Home'));
    assert.equal(focused(), 0);
    menu.dispatchEvent(key('End'));
    assert.equal(focused(), 3);
    menu.dispatchEvent(key('Escape'));
    assert.equal(openCategoryMenuElement(), null);
    assert.equal(menu.parentNode, null);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(globalThis.document.activeElement, button);
    // ArrowUp opens on the last entry; a click on the button again closes it.
    button.dispatchEvent(key('ArrowUp'));
    assert.equal(globalThis.document.activeElement.textContent || globalThis.document.activeElement.children[0].textContent, 'New category\u2026');
    click(button);
    assert.equal(openCategoryMenuElement(), null);
  });
});

test('a click outside closes the menu; a click inside does not', () => {
  withLibrary(four(), ({ page }) => {
    rockAndTalk();
    click(cardNode('a').__categoryButton);
    const menu = openCategoryMenuElement();
    const inside = new Event('pointerdown');
    Object.defineProperty(inside, 'target', { value: menu.children[1] });
    page.dispatchEvent(inside);
    assert.equal(openCategoryMenuElement(), menu);
    const outside = new Event('pointerdown');
    Object.defineProperty(outside, 'target', { value: ui.resultsHost });
    page.dispatchEvent(outside);
    assert.equal(openCategoryMenuElement(), null);
  });
});

test('choosing a category or None assigns it with one save', () => {
  withLibrary(four(), ({ storage }) => {
    const { talk } = rockAndTalk();
    const writes = storage.writes;
    const button = cardNode('d').__categoryButton;
    click(button);
    const talkItem = openCategoryMenuElement().children[1];
    click(talkItem);
    assert.equal(favoriteGroupOf('d'), talk.id);
    assert.equal(storage.writes, writes + 1);
    assert.equal(openCategoryMenuElement(), null);
    assert.equal(globalThis.document.activeElement, button);
    assert.equal(button.getAttribute('aria-label'), 'Category for Delta: Talk');
    click(button);
    const none = openCategoryMenuElement().children[2];
    assert.equal(none.children[0].textContent, 'None');
    click(none);
    assert.equal(favoriteGroupOf('d'), '');
    assert.equal(storage.writes, writes + 2);
  });
});

test('with a category chosen, a card put elsewhere leaves at once and the other cards are not redrawn', () => {
  withLibrary([...four(), card('e', 'Echo')], () => {
    const { rock, talk } = rockAndTalk();
    assignFavoriteToGroup('e', rock.id);
    click(chipFor('Rock'));
    assert.deepEqual(shownIds(), ['a', 'c', 'e']);
    const kept = { a: cardNode('a'), e: cardNode('e') };
    const thumbs = { a: kept.a.__thumb, e: kept.e.__thumb };
    click(cardNode('c').__categoryButton);
    click(openCategoryMenuElement().children[1]);
    assert.equal(favoriteGroupOf('c'), talk.id);
    assert.deepEqual(shownIds(), ['a', 'e']);
    // The same card nodes and artwork: nothing reloads.
    assert.equal(cardNode('a'), kept.a);
    assert.equal(cardNode('e'), kept.e);
    assert.equal(cardNode('a').__thumb, thumbs.a);
    assert.equal(cardNode('e').__thumb, thumbs.e);
    // Focus moves to the card now in its place.
    assert.equal(globalThis.document.activeElement, kept.e.__categoryButton);
    assert.deepEqual(chipText(), ['All categories', 'Rock 2', 'Talk 2', 'Uncategorized 1']);
  });
});

test('"New category..." in the menu makes a category and puts the favorite in it in one step', () => {
  withLibrary(four(), ({ storage }) => {
    rockAndTalk();
    const writes = storage.writes;
    const button = cardNode('d').__categoryButton;
    click(button);
    const menu = openCategoryMenuElement();
    const newItem = menu.children.find((node) => node.getAttribute('role') === 'menuitem');
    click(newItem);
    const form = menu.children.find((node) => node.tagName === 'FORM');
    const input = form.children[0];
    assert.equal(globalThis.document.activeElement, input);
    input.value = 'rock';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    const message = menu.children.find((node) => node.className === 'category-menu-message');
    assert.equal(message.textContent, 'There is already a category called "Rock".');
    assert.equal(message.hidden, false);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(storage.writes, writes);
    // Escape in the name box goes back to the list, not out of the menu.
    input.dispatchEvent(key('Escape'));
    assert.equal(openCategoryMenuElement(), menu);
    assert.equal(menu.children.some((node) => node.tagName === 'FORM'), false);
    assert.equal(globalThis.document.activeElement, newItem);
    click(newItem);
    const again = menu.children.find((node) => node.tagName === 'FORM');
    again.children[0].value = ' Jazz ';
    again.dispatchEvent(new Event('submit', { cancelable: true }));
    const jazz = getFavoriteGroups().find((group) => group.name === 'Jazz');
    assert.ok(jazz);
    assert.equal(favoriteGroupOf('d'), jazz.id);
    assert.equal(storage.writes, writes + 1);
    assert.equal(openCategoryMenuElement(), null);
    assert.equal(button.getAttribute('aria-label'), 'Category for Delta: Jazz');
    assert.deepEqual(chipText(), ['All categories', 'Rock 2', 'Talk 1', 'Jazz 1', 'Uncategorized 0']);
  });
});

/** Counts the page and window listeners the menu adds and has not removed. */
function trackListeners(page) {
  const live = new Set();
  const keyOf = (target, type, listener, options) => [target, type, listener, Boolean(options === true || options?.capture)];
  const find = (parts) => [...live].find((entry) => entry.every((part, index) => part === parts[index]));
  const wrap = (target, originalAdd, originalRemove) => {
    target.addEventListener = function add(type, listener, options) {
      if (!find(keyOf(target, type, listener, options))) live.add(keyOf(target, type, listener, options));
      return originalAdd?.call(this, type, listener, options);
    };
    target.removeEventListener = function remove(type, listener, options) {
      const entry = find(keyOf(target, type, listener, options));
      if (entry) live.delete(entry);
      return originalRemove?.call(this, type, listener, options);
    };
  };
  const pageAdd = page.addEventListener;
  const pageRemove = page.removeEventListener;
  wrap(page, pageAdd, pageRemove);
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'addEventListener');
  const windowAdd = globalThis.addEventListener;
  const windowRemove = globalThis.removeEventListener;
  wrap(globalThis, windowAdd, windowRemove);
  return {
    count: () => live.size,
    fire(type, event) {
      [...live].filter((entry) => entry[0] === globalThis && entry[1] === type).forEach((entry) => entry[2](event));
    },
    restore() {
      if (hadWindow) {
        globalThis.addEventListener = windowAdd;
        globalThis.removeEventListener = windowRemove;
      } else {
        delete globalThis.addEventListener;
        delete globalThis.removeEventListener;
      }
    },
  };
}

/** setTimeout and clearTimeout replaced so a test runs the timers itself. */
function manualTimers() {
  const saved = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const timers = new Map();
  let next = 1;
  globalThis.setTimeout = (fn) => { const id = next++; timers.set(id, fn); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  return {
    pending: () => timers.size,
    run() { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); },
    restore() { globalThis.setTimeout = saved.set; globalThis.clearTimeout = saved.clear; },
  };
}

const focusOut = (relatedTarget) => {
  const event = new Event('focusout');
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  return event;
};

test('Tab and Shift+Tab close the menu and let the browser move focus on from its button', () => {
  withLibrary(four(), ({ page }) => {
    rockAndTalk();
    const listeners = trackListeners(page);
    try {
      const button = cardNode('d').__categoryButton;
      for (const shift of [false, true]) {
        click(button);
        const menu = openCategoryMenuElement();
        assert.ok(listeners.count() > 0);
        menu.children[1].focus();
        const tab = Object.assign(key('Tab'), { shiftKey: shift });
        menu.dispatchEvent(tab);
        // Not prevented: the browser's own Tab moves on from the button.
        assert.equal(tab.defaultPrevented, false);
        assert.equal(globalThis.document.activeElement, button);
        assert.equal(openCategoryMenuElement(), null);
        assert.equal(menu.parentNode, null);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(listeners.count(), 0);
      }
    } finally {
      listeners.restore();
    }
  });
});

test('Tab from the new-category form closes the menu too', () => {
  withLibrary(four(), ({ page }) => {
    rockAndTalk();
    const listeners = trackListeners(page);
    try {
      const button = cardNode('d').__categoryButton;
      click(button);
      const menu = openCategoryMenuElement();
      click(menu.children.find((node) => node.getAttribute('role') === 'menuitem'));
      const input = menu.children.find((node) => node.tagName === 'FORM').children[0];
      assert.equal(globalThis.document.activeElement, input);
      const tab = Object.assign(key('Tab'), { shiftKey: true });
      // The name box leaves Tab alone; it reaches the menu.
      input.dispatchEvent(tab);
      assert.equal(tab.defaultPrevented, false);
      assert.equal(openCategoryMenuElement(), menu);
      menu.dispatchEvent(tab);
      assert.equal(tab.defaultPrevented, false);
      assert.equal(openCategoryMenuElement(), null);
      assert.equal(globalThis.document.activeElement, button);
      assert.equal(listeners.count(), 0);
    } finally {
      listeners.restore();
    }
  });
});

test('focus never stays outside an open menu: leaving it closes it, moving inside it does not', () => {
  withLibrary(four(), ({ page }) => {
    rockAndTalk();
    const timers = manualTimers();
    const listeners = trackListeners(page);
    try {
      const button = cardNode('d').__categoryButton;
      click(button);
      let menu = openCategoryMenuElement();
      // A menu with tabindex -1: a click on its blank parts keeps focus in it.
      assert.equal(menu.getAttribute('tabindex'), '-1');
      menu.dispatchEvent(focusOut(menu.children[1]));
      menu.dispatchEvent(focusOut(menu));
      assert.equal(openCategoryMenuElement(), menu);
      // To something outside: closed at once, focus left where it went.
      cardNode('a').__categoryButton.focus();
      menu.dispatchEvent(focusOut(cardNode('a').__categoryButton));
      assert.equal(openCategoryMenuElement(), null);
      assert.equal(globalThis.document.activeElement, cardNode('a').__categoryButton);
      assert.equal(listeners.count(), 0);

      // To nowhere: checked once focus settles.
      page.hasFocus = () => true;
      click(button);
      menu = openCategoryMenuElement();
      menu.children[0].focus();
      menu.dispatchEvent(focusOut(null));
      assert.equal(openCategoryMenuElement(), menu);
      timers.run();
      assert.equal(openCategoryMenuElement(), menu); // Focus was still inside.
      globalThis.document.activeElement = null;
      page.hasFocus = () => false;
      menu.dispatchEvent(focusOut(null));
      timers.run();
      assert.equal(openCategoryMenuElement(), menu); // Another app took focus.
      page.hasFocus = () => true;
      menu.dispatchEvent(focusOut(null));
      timers.run();
      assert.equal(openCategoryMenuElement(), null);
      assert.equal(listeners.count(), 0);

      // A pending check is dropped when the menu closes another way.
      click(button);
      menu = openCategoryMenuElement();
      menu.dispatchEvent(focusOut(null));
      assert.equal(timers.pending(), 1);
      menu.dispatchEvent(key('Escape'));
      assert.equal(timers.pending(), 0);
    } finally {
      listeners.restore();
      timers.restore();
      delete globalThis.document.hasFocus;
    }
  });
});

test('closing the new-category form moves focus to "New category..." before the form goes', () => {
  withLibrary(four(), () => {
    rockAndTalk();
    click(cardNode('d').__categoryButton);
    const menu = openCategoryMenuElement();
    const newItem = menu.children.find((node) => node.getAttribute('role') === 'menuitem');
    click(newItem);
    const form = menu.children.find((node) => node.tagName === 'FORM');
    let focusAtRemove = null;
    const remove = form.remove.bind(form);
    form.remove = () => { focusAtRemove = globalThis.document.activeElement; remove(); };
    form.children[0].dispatchEvent(key('Escape'));
    assert.equal(focusAtRemove, newItem);
    assert.equal(globalThis.document.activeElement, newItem);
    assert.equal(openCategoryMenuElement(), menu);
  });
});

test('every way the menu closes removes its page and window listeners', () => {
  withLibrary(four(), ({ page }) => {
    rockAndTalk();
    const listeners = trackListeners(page);
    try {
      const button = cardNode('d').__categoryButton;
      const viewportEvent = (type) => {
        const event = new Event(type);
        Object.defineProperty(event, 'target', { value: ui.resultsHost });
        return event;
      };
      const paths = {
        escape: (menu) => menu.dispatchEvent(key('Escape')),
        tab: (menu) => menu.dispatchEvent(key('Tab')),
        'button again': () => click(button),
        'click outside': () => page.dispatchEvent(viewportEvent('pointerdown')),
        scroll: () => page.dispatchEvent(viewportEvent('scroll')),
        resize: () => listeners.fire('resize', viewportEvent('resize')),
        'focus out': (menu) => menu.dispatchEvent(focusOut(ui.resultsHost)),
        choose: (menu) => click(menu.children[1]),
        'new category': (menu) => {
          click(menu.children.find((node) => node.getAttribute('role') === 'menuitem'));
          const form = menu.children.find((node) => node.tagName === 'FORM');
          form.children[0].value = 'Jazz';
          form.dispatchEvent(new Event('submit', { cancelable: true }));
        },
        'leaving the Library': () => closeCategoryMenu({ restoreFocus: false }),
      };
      for (const [name, close] of Object.entries(paths)) {
        click(button);
        const menu = openCategoryMenuElement();
        assert.ok(menu, name);
        assert.equal(listeners.count(), 3, name);
        close(menu);
        assert.equal(openCategoryMenuElement(), null, name);
        assert.equal(listeners.count(), 0, name);
      }
    } finally {
      listeners.restore();
    }
  });
});

test('the menu stays inside the window: below the button, above it near the bottom, never past an edge', () => {
  const viewport = { width: 1024, height: 640 };
  const menu = { width: 200, height: 160 };
  assert.deepEqual(menuPosition({ left: 500, right: 522, top: 100, bottom: 122 }, menu, viewport), { left: 322, top: 126 });
  // Near the bottom: above the button.
  assert.deepEqual(menuPosition({ left: 500, right: 522, top: 560, bottom: 582 }, menu, viewport), { left: 322, top: 396 });
  // Near the left edge: kept 8px in.
  assert.deepEqual(menuPosition({ left: 20, right: 42, top: 100, bottom: 122 }, menu, viewport), { left: 8, top: 126 });
  // Wider than the room on the right.
  assert.deepEqual(menuPosition({ left: 1000, right: 1030, top: 100, bottom: 122 }, menu, viewport), { left: 816, top: 126 });
  // No room above or below: as high as fits.
  assert.deepEqual(menuPosition({ left: 500, right: 522, top: 100, bottom: 122 }, { width: 200, height: 600 }, viewport), { left: 322, top: 32 });
});

test('the category styles: a wrapping chip row that scrolls, names cut with ellipsis, the card button and a fixed menu', async () => {
  const css = await read('src/styles/library.css');
  const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`))?.[0] || '';
  assert.match(rule('.category-chips'), /flex-wrap: wrap;/);
  assert.match(rule('.category-chips'), /max-height: 116px; overflow-y: auto;/);
  assert.match(rule('.category-chip'), /max-width: 16em;/);
  assert.match(rule('.category-chip-name'), /text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(rule('.favorite-categories'), /flex-basis: 100%;/);
  assert.match(rule('.card-category'), /right: 40px;/);
  assert.match(css, /\.card\.has-order-controls \.card-category \{ right: 96px; \}/);
  assert.match(css, /\.card\.has-category-control\.has-order-controls \.card-body \{ padding-right: 126px; \}/);
  assert.match(rule('.category-menu'), /position: fixed;/);
  assert.match(rule('.category-menu'), /max-height: min\(360px, calc\(100vh - 16px\)\);/);
  assert.match(css, /\.category-tool\[hidden\], \.category-form\[hidden\] \{ display: none; \}/);
  // Earlier rules the move buttons rely on are unchanged.
  assert.match(css, /\.library-root\.is-personal-view \.card\.has-order-controls \.card-body \{ padding-right: 100px; \}/);
});

test('compact cards with technical details on: the source badge gets the room there is, on one line; facts and a license wrap to the next line, and catalog cards keep their columns', async () => {
  const css = await read('src/styles/library.css');
  const on = ':root[data-tech-details="on"] .library-root.is-personal-view ';
  const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`))?.[0] || '';
  // A row that wraps, not the catalog's columns (kept even when empty).
  assert.match(rule(`${on}.card-meta`), /display: flex;\s+flex-wrap: wrap;/);
  assert.doesNotMatch(rule(`${on}.card-meta`), /grid-template-columns/);
  assert.match(rule(`${on}.source-badge`), /display: block;[\s\S]*max-width: 100%;[\s\S]*white-space: nowrap;\s+text-overflow: ellipsis;/);
  // With the move buttons ("My order") the cards start wider, so the badge
  // still fits whole: 318 px less the picture, the paddings and the buttons
  // leaves 110 px, and "Internet Archive" needs 109.
  assert.match(rule(`${on}.cards-grid:has(.card.has-order-controls)`), /grid-template-columns: repeat\(auto-fill, minmax\(318px, 1fr\)\);/);
  assert.match(rule('.library-root.is-personal-view .cards-grid'), /minmax\(280px, 1fr\)/);
  // Year and country get space together before the license is shortened.
  assert.match(rule('.card-meta'), /grid-template-columns: minmax\(0, 1fr\) max-content minmax\(62px, 0\.78fr\);/);
  assert.match(rule('.card-facts'), /display: flex;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(rule('.card-facts'), /flex-direction: column/);
  assert.match(rule('.card-license'), /white-space: nowrap;\s+overflow: hidden;\s+text-overflow: ellipsis;/);
});
