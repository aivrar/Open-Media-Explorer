import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';
import { getState, normalizeSettings } from '../src/lib/state.js';
import { makeComputerItem } from '../src/lib/computer-play.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import {
  applyStationImageList, markStationImageFailed, onStationImagesChange,
} from '../src/lib/station-images.js';
import { openDetail, closeDetail, detailPictureControls, refreshDetailArtwork } from '../src/modes/library/detail.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { dropStationPicture, pictureDropTarget } from '../src/modes/library/picture-drop.js';

/* Just enough DOM for the views to mount, swap and remove pictures. */
class Node extends FakeElement {
  constructor(id = '', tag = 'div') {
    super(id, tag);
    this.parentNode = null;
    this.className = '';
    this.html = '';
  }
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
  querySelector(selector) {
    return selector === 'img' ? this.children.find((node) => node.tagName === 'IMG') ?? null : null;
  }
}

const id = (n) => String(n).repeat(32).slice(0, 32);
const picture = (key, n, v = 'aaa111') => ({ key, id: id(n), v });
const source = (n, v = 'aaa111') => `station-image:${id(n)}:${v}`;
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A fake page: picture requests never answer (these tests are about what is
 *  redrawn, not about loading), no IntersectionObserver. */
function withPage(fn) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window };
  globalThis.fetch = () => new Promise(() => {});
  globalThis.window = {};
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node('', tag),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  try {
    return fn();
  } finally {
    applyStationImageList({ images: [] });
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
}

const images = (node) => node.children.filter((child) => child.tagName === 'IMG');

test('Library detail panel: only its picture is swapped when the list changes', () => withPage(() => {
  const state = getState();
  const previous = { settings: state.settings, root: ui.root, panel: ui.detailPanel };
  state.settings = normalizeSettings({});
  const root = new Node('', 'div');
  root.root = true;
  ui.root = root;
  ui.detailPanel = null;
  try {
    openDetail({ id: 'fav:x', title: 'Station X', type: 'radio', source: '', thumbnail: '' });
    const panel = ui.detailPanel;
    const thumbOf = () => panel.children.find((node) => node.className === 'detail-thumb');
    const before = thumbOf();
    const others = panel.children.filter((node) => node !== before);
    const position = panel.children.indexOf(before);
    assert.equal(before.style.display, 'none', 'no artwork of its own');
    assert.equal(refreshDetailArtwork(), false, 'nothing changed');

    applyStationImageList({ images: [picture('station x', '1')] });
    assert.equal(refreshDetailArtwork(), true);
    const shown = thumbOf();
    assert.notEqual(shown, before);
    assert.equal(before.parentNode, null);
    assert.equal(panel.children.indexOf(shown), position);
    assert.deepEqual(panel.children.filter((node) => node !== shown), others, 'the rest of the panel stays');
    assert.equal(shown.style.display, '');
    assert.equal(refreshDetailArtwork(), false);

    // A picture for another station leaves it alone.
    applyStationImageList({ images: [picture('station x', '1'), picture('other', '2')] });
    assert.equal(refreshDetailArtwork(), false);
    assert.equal(thumbOf(), shown);

    // The picture would not load: back to the item's own artwork (none here).
    markStationImageFailed(source('1'));
    assert.equal(refreshDetailArtwork(), true);
    assert.equal(thumbOf().style.display, 'none');

    closeDetail();
    applyStationImageList({ images: [picture('station x', '1', 'ccc333')] });
    assert.equal(refreshDetailArtwork(), false, 'a closed panel has nothing to update');
  } finally {
    closeDetail();
    ui.root = previous.root;
    ui.detailPanel = previous.panel;
    state.settings = previous.settings;
  }
}));

test('Library Computer favorites refuse station picture selection and drops without an error', async () => {
  const result = withPage(() => {
    const state = getState();
    const { favorites, mode } = state;
    const previous = { ...ui };
    const item = makeComputerItem({ id: 'local-picture', kind: 'audio', title: 'Local album track' });
    const root = new Node('', 'div');
    const card = new Node('', 'article');
    card.__item = item;
    root.appendChild(card);
    try {
      Object.assign(state, { mode: 'library', favorites: [item] });
      Object.assign(ui, { root, resultsHost: root, detailPanel: null });
      openDetail(item);
      assert.equal(detailPictureControls(), null);
      const target = { closest: () => card };
      assert.equal(pictureDropTarget(target), null);
      return dropStationPicture(new File(['image'], 'cover.jpg'), target, {
        validate: () => assert.fail('a Computer picture drop must be ignored'),
      });
    } finally {
      closeDetail();
      Object.assign(ui, previous);
      Object.assign(state, { favorites, mode });
    }
  });
  assert.equal(await result, null);
});

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const envelope = (status, data) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => ({ ok: true, data, error: null }),
});

test('player bar (and so the Tuner): the playing item follows its picture without restarting playback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const net = { registrations: 0, pictures: 0 };
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'picture-token' });
    if (path === '/api/v1/media/register') {
      net.registrations += 1;
      const mediaId = `pic_media_${String(net.registrations).padStart(12, '0')}`;
      return envelope(201, { media_id: mediaId, relay_url: `/api/v1/media/${mediaId}` });
    }
    if (/^\/api\/v1\/station-images\/[0-9a-f]{32}$/.test(path)) {
      net.pictures += 1;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    if (String(path).endsWith('/now-playing')) return envelope(200, { title: null, changed_at: null });
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  let player = null;
  t.after(() => {
    try { player?.stop(); } catch (_) {}
    applyStationImageList({ images: [] });
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  // Every picture the bar is given, in order.
  const art = elements['player-art'];
  const shown = [];
  let current = '';
  Object.defineProperty(art, 'src', {
    configurable: true,
    get: () => current,
    set: (value) => { current = String(value); shown.push(current); },
  });
  art.getAttribute = (name) => (name === 'src' ? current || null : FakeElement.prototype.getAttribute.call(art, name));
  art.removeAttribute = (name) => { if (name === 'src') current = ''; };

  player = await import(`../src/lib/player.js?stationImages=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const relay = '/api/v1/assets/station_art_0001';
  await player.playItem({
    id: 'test-pic:a', title: 'Radio Paradise', description: '', source: 'radio-browser', type: 'radio',
    stream_kind: 'audio', stream_url: 'https://radio.example/a', delivery: 'live', capture_headers: {},
    thumbnail: relay, country: '', language: '', _extra: { streamCandidates: [] },
  });
  await settle();
  const audio = elements['audio-el'];
  const stream = audio.src;
  assert.ok(stream, 'playing');
  assert.equal(net.registrations, 1);
  assert.equal(shown.at(-1), relay);

  // A list without this station: the bar is not touched.
  const count = shown.length;
  applyStationImageList({ images: [picture('kexp', '2')] });
  await settle();
  assert.equal(shown.length, count);
  assert.equal(player.syncPlayerStationImage(), false);

  // Its picture appears: the bar shows it.
  applyStationImageList({ images: [picture('kexp', '2'), picture('radio paradise', '1')] });
  await settle();
  assert.match(shown.at(-1), /^blob:/);
  assert.equal(net.pictures, 1);
  const pictureUrl = shown.at(-1);

  // The file replaced on disk: fetched and shown again.
  applyStationImageList({ images: [picture('kexp', '2'), picture('radio paradise', '1', 'bbb222')] });
  await settle();
  assert.equal(net.pictures, 2);
  assert.match(shown.at(-1), /^blob:/);
  assert.notEqual(shown.at(-1), pictureUrl);

  // Removed: back to the station's own artwork.
  applyStationImageList({ images: [picture('kexp', '2')] });
  await settle();
  assert.equal(shown.at(-1), relay);

  // Playback was never restarted.
  assert.equal(audio.src, stream);
  assert.equal(net.registrations, 1);
});
