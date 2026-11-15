import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement } from './helpers/fake-dom.js';
import { buildShell } from '../src/modes/library/shell.js';
import { selectSource } from '../src/modes/library/sidebar.js';
import { view } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { getState } from '../src/lib/state.js';

class Element extends FakeElement {
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = [...children]; }
}

test('Library shell exposes local collection controls without triggering provider search', () => {
  const oldDocument = globalThis.document;
  const oldObserver = globalThis.IntersectionObserver;
  const oldFetch = globalThis.fetch;
  const oldUi = { ...ui };
  const oldSource = view.activeSource;
  const oldFavorites = getState().favorites;
  const oldQuery = view.query;
  const oldObserverRef = view.infiniteObserver;
  try {
    globalThis.document = { createElement: (tag) => new Element('', tag), createDocumentFragment: () => new Element('', 'fragment') };
    globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
    globalThis.fetch = () => { assert.fail('Local collection filtering must not fetch'); };
    getState().favorites = [];
    view.activeSource = 'all';
    view.query = 'public search';
    buildShell();
    selectSource('favorites');
    assert.equal(ui.personalControls.style.display, 'flex');
    assert.equal(ui.playlistActions.style.display, 'none');
    assert.equal(ui.searchInput.value, '');
    ui.searchInput.value = 'saved radio';
    ui.searchInput.dispatchEvent(new Event('input'));
    assert.equal(view.personalFilters.favorites.query, 'saved radio');
    assert.equal(view.query, 'public search');
    // A group of buttons, one per type, with "All" first and pressed by default.
    const typeButtons = ui.personalType.children;
    const pressed = () => typeButtons.filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.getAttribute('data-type'));
    assert.equal(ui.personalType.tagName, 'DIV');
    assert.equal(ui.personalType.getAttribute('role'), 'group');
    assert.equal(ui.personalType.getAttribute('aria-label'), 'Filter saved items by media type');
    assert.deepEqual(typeButtons.map((node) => [node.tagName, node.getAttribute('type'), node.getAttribute('data-type'), node.textContent]), [
      ['BUTTON', 'button', '', 'All'], ['BUTTON', 'button', 'radio', 'Radio'], ['BUTTON', 'button', 'tv', 'TV'],
      ['BUTTON', 'button', 'audio', 'Audio'], ['BUTTON', 'button', 'video', 'Video'],
    ]);
    assert.deepEqual(pressed(), ['']);
    const typeButton = (type) => typeButtons.find((node) => node.getAttribute('data-type') === type);
    for (const type of ['tv', 'audio', 'video', 'radio']) {
      typeButton(type).dispatchEvent(new Event('click'));
      assert.equal(view.personalFilters.favorites.type, type);
      assert.deepEqual(pressed(), [type]);
      assert.equal(typeButton(type).classList.contains('is-active'), true);
      assert.equal(typeButtons.filter((node) => node.classList.contains('is-active')).length, 1);
    }
    selectSource('playlists');
    assert.equal(ui.playlistActions.style.display, 'flex');
    assert.equal(ui.playlistRemove.disabled, true);
    // My Playlists keeps its own choice.
    assert.deepEqual(pressed(), ['']);
    typeButton('tv').dispatchEvent(new Event('click'));
    assert.equal(view.personalFilters.playlists.type, 'tv');
    assert.equal(view.personalFilters.favorites.type, 'radio');
    const allNodes = (node) => [node, ...node.children.flatMap(allNodes)];
    const addLink = allNodes(ui.playlistActions).find((node) => node.textContent === 'Add link');
    const cancel = allNodes(ui.playlistActions).find((node) => node.textContent === 'Cancel');
    assert.equal(ui.playlistLinkForm.hidden, true);
    addLink.dispatchEvent(new Event('click'));
    assert.equal(ui.playlistLinkForm.hidden, false);
    assert.equal(addLink.getAttribute('aria-expanded'), 'true');
    const url = allNodes(ui.playlistLinkForm).find((node) => node.getAttribute('type') === 'url');
    assert.ok(url.hasAttribute('required'));
    const kind = allNodes(ui.playlistLinkForm).find((node) => node.getAttribute('aria-label') === 'Link type');
    assert.equal(kind.value, 'stream');
    assert.deepEqual(kind.children.map((node) => node.textContent), ['Single channel', 'Online playlist']);
    cancel.dispatchEvent(new Event('click'));
    assert.equal(ui.playlistLinkForm.hidden, true);
    selectSource('favorites');
    assert.deepEqual(pressed(), ['radio']);
    assert.equal(ui.searchInput.value, 'saved radio');
    selectSource('playlists');
    assert.deepEqual(pressed(), ['tv']);
    typeButton('').dispatchEvent(new Event('click'));
    assert.equal(view.personalFilters.playlists.type, '');
    assert.deepEqual(pressed(), ['']);
  } finally {
    view.searchDebounced?.cancel?.();
    view.searchDebounced = null;
    view.infiniteObserver = oldObserverRef;
    getState().favorites = oldFavorites;
    view.activeSource = oldSource; view.query = oldQuery;
    view.personalFilters.favorites = { query: '', type: '' };
    view.personalFilters.playlists = { query: '', type: '' };
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    globalThis.IntersectionObserver = oldObserver;
    globalThis.fetch = oldFetch;
  }
});

test('the media type buttons wrap instead of squashing in a narrow Library', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  assert.match(css, /\.personal-type \{ display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; \}/);
  const controls = await readFile(new URL('../src/modes/library/personal-controls.js', import.meta.url), 'utf8');
  assert.doesNotMatch(controls, /'All media'/);
});
