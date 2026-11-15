import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement } from './helpers/fake-dom.js';
import { getState, normalizeSettings } from '../src/lib/state.js';
import {
  applyStationImageList, markStationImageFailed, onStationImagesChange,
} from '../src/lib/station-images.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { renderResults } from '../src/modes/library/render.js';
import { cancelThumbnailHydration } from '../src/modes/library/thumbnails.js';

/* A small DOM: enough for renderResults() to mount, reuse and replace cards. */
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

const id = (n) => String(n).repeat(32).slice(0, 32);
const picture = (key, n, v = 'aaa111') => ({ key, id: id(n), v });
const source = (n, v = 'aaa111') => `station-image:${id(n)}:${v}`;
// No source: these cards never ask the artwork relay for anything.
const fav = (itemId, title, extra = {}) => ({ id: itemId, title, type: 'radio', source: '', ...extra });

function withLibrary(favorites, fn) {
  const state = getState();
  const previous = {
    favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage,
    document: globalThis.document, fetch: globalThis.fetch, ui: { ...ui },
    source: view.activeSource, filters: { ...view.personalFilters.favorites },
  };
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  // Picture requests never answer here: these tests are about which cards are redrawn.
  globalThis.fetch = () => new Promise(() => {});
  state.favorites = favorites.map((item) => ({ ...item }));
  state.settings = normalizeSettings({});
  const scroller = new Node('', 'div');
  scroller.root = true;
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
  // As the Library does (index.js).
  const off = onStationImagesChange(() => renderResults());
  try {
    return fn({ state, host });
  } finally {
    off();
    // The fake images never load: stop their requests instead of waiting them out.
    cancelThumbnailHydration();
    applyStationImageList({ images: [] });
    renderedIds.clear();
    Object.assign(ui, previous.ui);
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.localStorage = previous.storage;
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    view.activeSource = previous.source;
    view.personalFilters.favorites = previous.filters;
  }
}

const cardImage = (card) => card.__thumb?.querySelector('img') ?? null;

test('a custom picture appearing or disappearing redraws only that card', () => {
  const list = [
    fav('a', 'Radio Paradise'),
    fav('b', 'KEXP', { thumbnail: 'https://example.org/kexp.png' }),
    fav('c', 'Jazz FM'),
  ];
  withLibrary(list, ({ host }) => {
    renderResults();
    const [a, b, c] = host.children;
    assert.equal(cardImage(a), null);

    // The list arrives (startup, or Refresh): only the matching card is redrawn.
    applyStationImageList({ images: [picture('radio paradise', '1')] });
    const [a2, b2, c2] = host.children;
    assert.notEqual(a2, a);
    assert.equal(a2.dataset.id, 'a');
    assert.equal(b2, b);
    assert.equal(c2, c);
    assert.equal(cardImage(a2).dataset.artworkSrc, source('1'));

    // Refresh with nothing new changes nothing.
    applyStationImageList({ images: [picture('radio paradise', '1')] });
    renderResults();
    assert.deepEqual(host.children, [a2, b2, c2]);

    // A picture for a card that has provider artwork replaces it; the file
    // replaced on disk (new stamp) redraws only its card.
    applyStationImageList({ images: [picture('radio paradise', '1', 'bbb222'), picture('kexp', '2')] });
    const [a3, b3, c3] = host.children;
    assert.notEqual(a3, a2);
    assert.notEqual(b3, b2);
    assert.equal(c3, c);
    assert.equal(cardImage(a3).dataset.artworkSrc, source('1', 'bbb222'));
    assert.equal(cardImage(b3).dataset.artworkSrc, source('2'));

    // Picture removed: back to the card's own artwork (KEXP's provider URL is
    // not a relay yet, so no image) or the initials tile; others untouched.
    applyStationImageList({ images: [picture('radio paradise', '1', 'bbb222')] });
    const [a4, b4, c4] = host.children;
    assert.equal(a4, a3);
    assert.notEqual(b4, b3);
    assert.equal(c4, c);
    assert.equal(cardImage(b4), null);

    // A picture that fails to load: its card goes back to the initials tile.
    markStationImageFailed(source('1', 'bbb222'));
    const [a5, b5, c5] = host.children;
    assert.notEqual(a5, a4);
    assert.equal(cardImage(a5), null);
    assert.equal(a5.__thumb.children[0].classList.contains('has-initials'), true);
    assert.deepEqual([b5, c5], [b4, c4]);
  });
});

test('a card with a session relay image keeps it until a picture is named like it', () => {
  const relay = '/api/v1/assets/abcdefghijklmnop1234';
  const list = [fav('x', 'Station X', { thumbnail: relay, _extra: { artworkUrl: 'https://example.org/x.png' } })];
  withLibrary(list, ({ host }) => {
    renderResults();
    const [x] = host.children;
    assert.equal(cardImage(x).dataset.artworkSrc, relay);
    applyStationImageList({ images: [picture('some other station', '3')] });
    assert.deepEqual(host.children, [x]);
    applyStationImageList({ images: [picture('station x', '4')] });
    const [x2] = host.children;
    assert.notEqual(x2, x);
    assert.equal(cardImage(x2).dataset.artworkSrc, source('4'));
    applyStationImageList({ images: [] });
    const [x3] = host.children;
    assert.notEqual(x3, x2);
    assert.equal(cardImage(x3).dataset.artworkSrc, relay);
  });
});
