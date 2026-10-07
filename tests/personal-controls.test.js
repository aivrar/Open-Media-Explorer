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
    ui.personalType.value = 'radio';
    ui.personalType.dispatchEvent(new Event('change'));
    assert.equal(view.personalFilters.favorites.type, 'radio');
    selectSource('playlists');
    assert.equal(ui.playlistActions.style.display, 'flex');
    assert.equal(ui.playlistRemove.disabled, true);
    assert.equal(ui.personalType.value, '');
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
    assert.deepEqual(kind.children.map((node) => node.textContent), ['Single channel', 'Online M3U playlist']);
    cancel.dispatchEvent(new Event('click'));
    assert.equal(ui.playlistLinkForm.hidden, true);
    selectSource('favorites');
    assert.equal(ui.personalType.value, 'radio');
    assert.equal(ui.searchInput.value, 'saved radio');
  } finally {
    view.searchDebounced?.cancel?.();
    view.searchDebounced = null;
    view.infiniteObserver = oldObserverRef;
    getState().favorites = oldFavorites;
    view.activeSource = oldSource; view.query = oldQuery;
    view.personalFilters.favorites = { query: '', type: '' };
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    globalThis.IntersectionObserver = oldObserver;
    globalThis.fetch = oldFetch;
  }
});
