import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement } from './helpers/fake-dom.js';
import { buildShell } from '../src/modes/library/shell.js';
import { selectSource } from '../src/modes/library/sidebar.js';
import { view } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { getState } from '../src/lib/state.js';
import { normalizePersonalTypes, togglePersonalType } from '../src/modes/library/personal-types.js';

class Element extends FakeElement {
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = [...children]; }
}

test('media type toggles add, remove, and clear selections without changing the input', () => {
  const selected = Object.freeze(['radio', 'audio']);
  assert.deepEqual(togglePersonalType([], ''), []);
  assert.deepEqual(togglePersonalType([], 'radio'), ['radio']);
  assert.deepEqual(togglePersonalType(['radio'], 'radio'), []);
  assert.deepEqual(togglePersonalType(selected, 'audio'), ['radio']);
  assert.deepEqual(togglePersonalType(selected, 'tv'), ['radio', 'tv', 'audio']);
  assert.deepEqual(togglePersonalType(selected, ''), []);
  const allTypes = togglePersonalType(['radio', 'tv', 'audio'], 'video');
  assert.deepEqual(allTypes, ['radio', 'tv', 'audio', 'video']);
  assert.deepEqual(togglePersonalType(allTypes, 'tv'), ['radio', 'audio', 'video']);
  assert.deepEqual(togglePersonalType(allTypes, ''), []);
});

test('legacy session type values read as the same selection and can be toggled', () => {
  assert.deepEqual(normalizePersonalTypes(''), []);
  assert.deepEqual(normalizePersonalTypes(undefined), []);
  for (const type of ['radio', 'tv', 'audio', 'video']) {
    assert.deepEqual(normalizePersonalTypes(type), [type]);
    assert.deepEqual(togglePersonalType(type, type), []);
  }
  assert.deepEqual(togglePersonalType('audio', 'radio'), ['radio', 'audio']);
  assert.deepEqual(normalizePersonalTypes(['audio', '', 'radio', 'audio', 'other']), ['radio', 'audio']);
});

test('Library shell exposes local collection controls without triggering provider search', () => {
  const oldDocument = globalThis.document;
  const oldObserver = globalThis.IntersectionObserver;
  const oldFetch = globalThis.fetch;
  const oldUi = { ...ui };
  const oldSource = view.activeSource;
  const oldFavorites = getState().favorites;
  const oldQuery = view.query;
  const oldFilters = { ...view.personalFilters };
  const oldObserverRef = view.infiniteObserver;
  try {
    globalThis.document = { createElement: (tag) => new Element('', tag), createDocumentFragment: () => new Element('', 'fragment') };
    globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
    globalThis.fetch = () => { assert.fail('Local collection filtering must not fetch'); };
    getState().favorites = [];
    view.activeSource = 'all';
    view.query = 'public search';
    view.personalFilters.favorites = { query: '', type: [], category: '' };
    view.personalFilters.playlists = { query: '', type: [] };
    buildShell();
    selectSource('favorites');
    assert.equal(ui.personalControls.style.display, 'flex');
    assert.equal(ui.playlistActions.style.display, 'none');
    assert.equal(ui.personalControls.classList.contains('is-playlists'), false);
    assert.deepEqual(ui.favoritesActions.children.slice(0, 4), [
      ui.favoriteTitles, ui.favoritesRemoveAll, ui.favoritesActions.children[2], ui.favoritesExport,
    ]);
    assert.equal(ui.favoritesActions.children[2].getAttribute('aria-label'), 'Export format');
    assert.equal(ui.searchInput.value, '');
    ui.searchInput.value = 'saved radio';
    ui.searchInput.dispatchEvent(new Event('input'));
    assert.equal(view.personalFilters.favorites.query, 'saved radio');
    assert.equal(view.query, 'public search');
    // A group of buttons, one per type, with "All" first and pressed by default.
    const typeButtons = ui.personalType.children;
    const assertPressed = (...types) => {
      for (const node of typeButtons) {
        const active = types.includes(node.getAttribute('data-type'));
        assert.equal(node.getAttribute('aria-pressed'), String(active), node.textContent);
        assert.equal(node.classList.contains('is-active'), active, node.textContent);
      }
    };
    assert.equal(ui.personalType.tagName, 'DIV');
    assert.equal(ui.personalType.getAttribute('role'), 'group');
    assert.equal(ui.personalType.getAttribute('aria-label'), 'Filter saved items by media type');
    assert.deepEqual(typeButtons.map((node) => [node.tagName, node.getAttribute('type'), node.getAttribute('data-type'), node.textContent]), [
      ['BUTTON', 'button', '', 'All'], ['BUTTON', 'button', 'radio', 'Radio'], ['BUTTON', 'button', 'tv', 'TV'],
      ['BUTTON', 'button', 'audio', 'Audio'], ['BUTTON', 'button', 'video', 'Video'],
    ]);
    assertPressed('');
    const clickType = (type) => typeButtons.find((node) => node.getAttribute('data-type') === type)
      .dispatchEvent(new Event('click'));
    clickType('radio');
    assertPressed('radio');
    clickType('audio');
    assertPressed('radio', 'audio');
    clickType('tv');
    assertPressed('radio', 'tv', 'audio');
    clickType('video');
    assertPressed('radio', 'tv', 'audio', 'video');
    clickType('tv');
    clickType('video');
    assertPressed('radio', 'audio');
    assert.deepEqual(view.personalFilters.favorites.type, ['radio', 'audio']);
    selectSource('playlists');
    assert.equal(ui.playlistActions.style.display, 'flex');
    assert.equal(ui.playlistRemove.disabled, true);
    assert.equal(ui.personalControls.classList.contains('is-playlists'), true);
    const [picker, imports, end] = ui.playlistActions.children;
    assert.equal(picker.className, 'playlist-action-group playlist-picker');
    assert.equal(picker.children[0], ui.playlistSelect);
    assert.equal(picker.children[1].textContent.trim(), 'Add as');
    assert.equal(picker.children[1].children[0].tagName, 'SELECT');
    assert.equal(imports.className, 'playlist-action-group');
    assert.deepEqual(imports.children.map(node => node.textContent), ['Add link', 'Import playlist']);
    assert.equal(end.className, 'playlist-action-end');
    const [manage, exporting] = end.children;
    assert.equal(manage.className, 'playlist-action-group');
    assert.deepEqual(manage.children, [ui.playlistRemove, ui.playlistStarAll]);
    assert.equal(exporting.className, 'playlist-action-group');
    assert.equal(exporting.children.length, 2);
    assert.equal(exporting.children[0].getAttribute('aria-label'), 'Export format');
    assert.deepEqual(exporting.children[0].children.map(node => node.textContent), ['M3U8', 'JSON']);
    assert.equal(exporting.children[1], ui.playlistExport);
    // My Playlists keeps its own choice.
    assertPressed('');
    clickType('tv');
    clickType('video');
    assertPressed('tv', 'video');
    assert.deepEqual(view.personalFilters.playlists.type, ['tv', 'video']);
    assert.deepEqual(view.personalFilters.favorites.type, ['radio', 'audio']);
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
    assertPressed('radio', 'audio');
    assert.equal(ui.personalControls.classList.contains('is-playlists'), false);
    assert.equal(ui.searchInput.value, 'saved radio');
    selectSource('playlists');
    assertPressed('tv', 'video');
    clickType('');
    assert.deepEqual(view.personalFilters.playlists.type, []);
    assertPressed('');
    clickType('radio');
    clickType('radio');
    assert.deepEqual(view.personalFilters.playlists.type, []);
    assertPressed('');

    view.personalFilters.favorites.type = 'audio';
    selectSource('favorites');
    assertPressed('audio');
    clickType('radio');
    assert.deepEqual(view.personalFilters.favorites.type, ['radio', 'audio']);
    assertPressed('radio', 'audio');
  } finally {
    view.searchDebounced?.cancel?.();
    view.searchDebounced = null;
    view.infiniteObserver = oldObserverRef;
    getState().favorites = oldFavorites;
    view.activeSource = oldSource; view.query = oldQuery;
    Object.assign(view.personalFilters, oldFilters);
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    globalThis.IntersectionObserver = oldObserver;
    globalThis.fetch = oldFetch;
  }
});

test('the media type buttons wrap instead of squashing in a narrow Library', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  assert.match(css, /\.chip \{\s*appearance: none;/);
  assert.match(css, /\.personal-controls select \{\s*background-image: linear-gradient/);
  assert.match(css, /\.chip:hover:where\(:not\(:disabled\)\) \{[^}]*border-color: var\(--border-strong\);/);
  assert.match(css, /\.personal-type \{ display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; \}/);
  const controls = await readFile(new URL('../src/modes/library/personal-controls.js', import.meta.url), 'utf8');
  assert.doesNotMatch(controls, /'All media'/);
});

test('playlist groups stay together and the trailing actions wrap to the Favorites edge', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  assert.match(css, /\.playlist-action-group \{ flex: none; white-space: nowrap; \}/);
  assert.match(css, /\.playlist-picker > select \{[^}]*max-width: 148px;/);
  assert.match(css, /\.playlist-action-end \{\s*flex-wrap: wrap;\s*justify-content: flex-end;\s*margin-left: auto;/);
  assert.match(css, /\.favorites-actions \{[^}]*flex-wrap: wrap;[^}]*gap: 8px;[^}]*margin-left: auto;/);
});
