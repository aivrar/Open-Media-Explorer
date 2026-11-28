import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import { SOURCES } from '../src/lib/sources.js';
import { getState, normalizeSettings } from '../src/lib/state.js';
import { buildSidebar, syncComputerSource, syncSidebarSources } from '../src/modes/library/sidebar.js';
import { effectiveStatusSources, updateSidebarCounts } from '../src/modes/library/render.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { view } from '../src/modes/library/state.js';

class Element extends FakeElement {
  constructor(tag) {
    super('', tag);
    this.moves = 0;
  }

  set className(value) {
    this.classList.values = new Set(value.split(' '));
  }

  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name === 'data-source') this.dataset.source = value;
  }

  appendChild(child) {
    if (this.children.includes(child)) {
      this.moves += 1;
      this.children.splice(this.children.indexOf(child), 1);
    }
    return super.appendChild(child);
  }

  querySelectorAll(selector) {
    const matches = (child) => {
      if (selector.startsWith('.')) {
        return selector.slice(1).split('.').every((name) => child.classList.contains(name));
      }
      const [, role] = selector.match(/^\[data-role="([^"]+)"\]$/);
      return child.getAttribute('data-role') === role;
    };
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { document.activeElement = this; }
}

test('Library groups sources by their switch, preserves order within groups, and can select a source that is off', async (t) => {
  const state = getState();
  const savedSettings = state.settings;
  const savedDocument = globalThis.document;
  const savedUi = { ...ui };
  const savedView = { ...view, filters: { ...view.filters }, sourceStatus: new Map(view.sourceStatus) };
  t.after(() => {
    state.settings = savedSettings;
    Object.assign(ui, savedUi);
    Object.assign(view, savedView);
    if (savedDocument) globalThis.document = savedDocument;
    else delete globalThis.document;
  });

  globalThis.document = { createElement: (tag) => new Element(tag), activeElement: null };
  ui.sidebar = new Element('aside');
  ui.resultsHost = new Element('section');
  view.activeSource = 'all';
  view.catalogActive = false;
  const usual = SOURCES.map(({ id }) => id);
  const [first, second, third] = usual;
  state.settings = normalizeSettings({ enabledSources: { [first]: false, [third]: false } });
  buildSidebar();
  const list = ui.sidebar.querySelector('.source-list');
  const archiveRows = () => list.children.filter((row) => usual.includes(row.dataset.source));
  const archiveIds = () => archiveRows().map((row) => row.dataset.source);
  const firstRow = archiveRows().find((row) => row.dataset.source === first);
  assert.deepEqual(list.children.slice(0, 10).map((row) => row.dataset.source), [
    undefined, 'all', 'favorites', 'playlists', undefined, 'type:radio', 'type:tv', 'type:video', 'type:audio', undefined,
  ]);
  assert.deepEqual(archiveIds(), [second, ...usual.slice(3), first, third]);
  assert.equal(firstRow.getAttribute('aria-disabled'), null);
  assert.match(firstRow.getAttribute('aria-label'), /\(off\)$/);
  assert.equal(firstRow.classList.contains('is-disabled'), true);

  const beforeLoading = list.moves;
  for (const state of ['loading', 'retrying', 'complete']) {
    view.sourceStatus.set(second, { state });
    updateSidebarCounts();
  }
  assert.equal(list.moves, beforeLoading);
  assert.deepEqual(archiveIds(), [second, ...usual.slice(3), first, third]);

  firstRow.dispatchEvent(new Event('click'));
  assert.equal(view.activeSource, first);
  assert.equal(firstRow.getAttribute('aria-selected'), 'true');
  assert.deepEqual(effectiveStatusSources(), []);
  assert.equal(ui.resultsHost.querySelector('.empty-state').children[0].textContent, 'Source is off');

  const end = Object.assign(new Event('keydown', { cancelable: true }), { key: 'End' });
  firstRow.dispatchEvent(end);
  assert.equal(document.activeElement.dataset.source, third);

  state.settings = normalizeSettings({ enabledSources: { [second]: false } });
  syncSidebarSources(state.settings.enabledSources);
  assert.deepEqual(archiveIds(), [first, ...usual.slice(2), second]);
  assert.equal(archiveRows()[0], firstRow);
  assert.equal(firstRow.classList.contains('is-disabled'), false);
  assert.equal(firstRow.getAttribute('aria-label'), null);
  assert.equal(document.activeElement.dataset.source, third);
  await Promise.resolve();
});

test('Computer is a search-only source choice with Audio and Video counts', (t) => {
  const savedUi = { ...ui };
  const savedView = { ...view, filters: { ...view.filters } };
  const savedDocument = globalThis.document;
  t.after(() => {
    Object.assign(ui, savedUi);
    Object.assign(view, savedView);
    globalThis.document = savedDocument;
  });
  globalThis.document = { createElement: (tag) => new Element(tag), activeElement: null };
  ui.sidebar = new Element('aside');
  view.activeSource = 'all';
  view.computerHits = [];
  buildSidebar();
  const list = ui.sidebar.querySelector('.source-list');
  const find = (id) => list.children.find((node) => node.dataset.source === id && !node.removed);
  syncComputerSource();
  assert.equal(find('computer'), undefined);

  view.computerHits = [{ type: 'audio' }, { type: 'audio' }, { type: 'video' }];
  syncComputerSource();
  updateSidebarCounts();
  assert.equal(find('computer').querySelector('.source-label').textContent, 'Computer');
  const count = (id) => find(id).querySelector('[data-role="count"]').textContent;
  assert.equal(count('computer'), '3');
  assert.equal(count('type:audio'), '2');
  assert.equal(count('type:video'), '1');
  assert.equal(count('type:radio'), '0');
  assert.equal(find('computer').querySelector('.source-health'), null);

  view.activeSource = 'computer';
  view.computerHits = [];
  syncComputerSource();
  assert.equal(find('computer'), undefined);
  assert.equal(view.activeSource, 'all');
});

test('muted source rows remain visible and the wait marker has a reserved slot', async () => {
  const css = await readFile(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  assert.match(css, /\.source-item\.is-disabled\s*\{\s*color: var\(--text-mute\);\s*\}/);
  assert.doesNotMatch(css, /\.source-item\.is-disabled[^\{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.source-health\s*\{\s*visibility: hidden;\s*flex: 0 0 7px;/);
  assert.match(css, /\.source-health\.is-wait\s*\{\s*visibility: visible;/);
});
