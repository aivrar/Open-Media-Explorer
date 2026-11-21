import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';
import { getState, normalizeSettings } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { STATION_IMAGE_CLASS, loadArtworkImage } from '../src/lib/artwork.js';
import { applyStationImageList, markStationImageFailed } from '../src/lib/station-images.js';
import { createThumbImage } from '../src/modes/library/thumbnails.js';
import { openDetail, closeDetail, refreshDetailArtwork } from '../src/modes/library/detail.js';
import { ui } from '../src/modes/library/shell-refs.js';

/* Issue #6: a custom station picture that is not square was cut off (the
   player bar and the detail panel filled their box with object-fit: cover).
   A station picture is now always shown whole and centred; remote artwork
   keeps its own fit. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const id = (n) => String(n).repeat(32).slice(0, 32);
const picture = (key, n, v = 'aaa111') => ({ key, id: id(n), v });
const source = (n, v = 'aaa111') => `station-image:${id(n)}:${v}`;
const RELAY = '/api/v1/assets/abcdefghijklmnop1234';
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The body of the first rule whose selector is exactly `selector`. */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
}

test('every view shows a station picture whole and centred, and remote artwork as before', async () => {
  const base = await read('src/styles/base.css');
  const library = await read('src/styles/library.css');
  const discovery = await read('src/styles/discovery.css');
  const grid = await read('src/styles/grid.css');
  assert.equal(STATION_IMAGE_CLASS, 'is-station-image');

  // Remote artwork keeps exactly today's fit.
  assert.match(rule(base, '#player-art'), /object-fit: cover;/);
  assert.match(rule(library, '.card-thumb img'), /object-fit: cover;/);
  assert.match(rule(library, '.card-thumb img.logo-art'), /object-fit: contain;\s+padding: 28px;/);
  assert.match(library, /\.library-root\.is-personal-view \.card-thumb img\.logo-art \{ padding: 6px; \}/);
  assert.match(rule(library, '.detail-thumb'), /aspect-ratio: 16 \/ 9;\s+object-fit: cover;/);
  // A station's logo is shown whole in the details panel, as on the cards.
  assert.match(rule(library, '.detail-thumb.logo-art'), /object-fit: contain;/);
  assert.match(rule(discovery, '.discovery-now img'), /object-fit: cover;/);
  // The Grid's logo box already shows any picture whole, on its own surface.
  assert.match(rule(grid, '.channel-tile .channel-logo'), /background: var\(--bg-elev-3\);\s+object-fit: contain;/);

  // A station picture: never cropped, centred (contain centres by default).
  const player = rule(base, '#player-art.is-station-image');
  const card = rule(library, '.card-thumb img.is-station-image');
  const detail = rule(library, '.detail-thumb.is-station-image');
  const now = rule(discovery, '.discovery-now img.is-station-image');
  for (const body of [player, card, detail, now]) {
    assert.match(body, /object-fit: contain;/);
    assert.doesNotMatch(body, /object-position|cover|#000|black/);
  }
  // Around it, and through a transparent one: the surface it sits on, from the
  // theme, never a fixed colour, and never the initials tile behind it. In the
  // player bar the box and the initials step aside while a picture is shown,
  // so the bar itself shows.
  assert.match(player, /background: transparent;/);
  assert.match(base, /\.player-art-box:has\(> #player-art\.is-station-image\[src\]\) \{ background: transparent; \}/);
  assert.match(base, /\.player-art-box:has\(> #player-art\.is-station-image\[src\]\) > \.player-art-initials \{ visibility: hidden; \}/);
  // On cards the picture's own background is the picture area's surface
  // (opaque), and the placeholder is hidden behind a loaded picture.
  assert.match(library, /\.card-thumb:has\(> img\.is-station-image\.loaded\) > \.placeholder \{ visibility: hidden; \}/);
  assert.match(card, /background:\s+radial-gradient\(circle at center, rgba\(255,255,255,0\.04\), transparent 62%\),\s+linear-gradient\(135deg, var\(--bg-elev-2\), var\(--bg-elev-3\)\);/);
  // Same as a radio/TV logo's background, so a square picture there looks as before.
  assert.equal(card.match(/background:[^;]*;/)[0], rule(library, '.card-thumb img.logo-art').match(/background:[^;]*;/)[0]);
  // Nothing is behind the detail panel's or Discovery's picture: the panel or card shows.
  assert.match(detail, /background: transparent;/);
  assert.match(now, /background: transparent;/);
  // The station-picture rule follows the logo rule, so it applies to radio cards too.
  assert.ok(library.indexOf('.card-thumb img.is-station-image') > library.indexOf('.card-thumb img.logo-art'));
  assert.ok(base.indexOf('#player-art.is-station-image') > base.indexOf('#player-art {'));
});

/** An <img> whose loads the test finishes by hand. */
class FakeImage extends FakeElement {
  constructor() {
    super('', 'img');
    this.complete = false;
    this.naturalWidth = 0;
  }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) {
    this.setAttribute('src', String(value));
    this.complete = false;
    this.naturalWidth = 0;
  }
  land(ok = true) {
    this.complete = true;
    this.naturalWidth = ok ? 10 : 0;
    this.dispatchEvent(new Event(ok ? 'load' : 'error'));
  }
}

/** Station-picture requests the test answers when it wants. */
function pictureServer() {
  const waiting = new Map();
  let urls = 0;
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, data: { token: 't' }, error: null }) };
    }
    const pictureId = String(path).split('/').pop();
    return new Promise((resolve) => waiting.set(pictureId, resolve));
  };
  const answer = (n, ok = true) => {
    const resolve = waiting.get(id(n));
    waiting.delete(id(n));
    resolve(ok
      ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
      : new Response('', { status: 404 }));
  };
  const createUrl = () => `blob:fit-${urls += 1}`;
  return { fetchImpl, createUrl, answer, pending: (n) => waiting.has(id(n)) };
}

test('an image is marked as a station picture only once one has loaded into it', async () => {
  resetControlSession();
  const server = pictureServer();
  const img = new FakeImage();
  const opts = {
    requireConnected: false, fetchImpl: server.fetchImpl, createUrl: server.createUrl, imageTimeoutMs: 1500, attempts: 1,
  };
  const whole = () => img.classList.contains(STATION_IMAGE_CLASS);
  try {
    // A station picture: not marked while it is fetched or decoding, marked once on screen.
    const first = loadArtworkImage(img, source('a'), opts);
    await settle();
    assert.equal(server.pending('a'), true);
    assert.equal(whole(), false);
    server.answer('a');
    await settle();
    assert.match(img.src, /^blob:fit-/);
    assert.equal(whole(), false, 'not marked before it has loaded');
    img.land();
    await first;
    assert.equal(whole(), true);

    // The same element given remote artwork: unmarked as soon as the new
    // picture starts, and still unmarked once it is shown.
    const remote = loadArtworkImage(img, RELAY, opts);
    await settle();
    assert.equal(img.src, RELAY);
    assert.equal(whole(), false);
    img.land();
    await remote;
    assert.equal(whole(), false);

    // An older station-picture load that finishes after a newer one started
    // does not touch the class.
    const older = loadArtworkImage(img, source('b'), opts);
    await settle();
    server.answer('b');
    await settle();
    const olderSrc = img.src;
    assert.match(olderSrc, /^blob:fit-/);
    const newer = loadArtworkImage(img, RELAY.replace('1234', '5678'), opts);
    await settle();
    assert.notEqual(img.src, olderSrc);
    img.land();
    await newer;
    assert.equal(whole(), false);
    // Its own load would have been for the src it no longer owns; it times out unmarked.
    void older.catch(() => {});

    // A station picture that fails to decode: unmarked.
    const broken = loadArtworkImage(img, source('c'), opts);
    await settle();
    server.answer('c');
    await settle();
    img.land(false);
    await assert.rejects(broken, { name: 'ArtworkImageError' });
    assert.equal(whole(), false);

    // A station picture that loads, then a fetch for another that fails:
    // the element is not emptied by the failed fetch, and stays as it was.
    const good = loadArtworkImage(img, source('d'), opts);
    await settle();
    server.answer('d');
    await settle();
    img.land();
    await good;
    assert.equal(whole(), true);
    const failing = loadArtworkImage(img, source('e'), opts);
    await settle();
    server.answer('e', false);
    await assert.rejects(failing);
    assert.equal(whole(), true, 'still showing the picture that loaded');
    // Aborted before it started: nothing changes either.
    await assert.rejects(loadArtworkImage(img, RELAY, { ...opts, signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(whole(), true);
  } finally {
    applyStationImageList({ images: [] });
    resetControlSession();
  }
});

test('Library cards: the picture to load is the station picture, for any item type', () => {
  const state = getState();
  const previous = { settings: state.settings, document: globalThis.document };
  state.settings = normalizeSettings({});
  globalThis.document = { createElement: (tag) => new FakeElement('', tag) };
  try {
    applyStationImageList({ images: [picture('dkfm', '1'), picture('a talk show', '2')] });
    // Marked as a station picture only once it has loaded (loadArtworkImage).
    const radio = createThumbImage({ id: 'r', title: 'DKFM', type: 'radio', source: '', thumbnail: RELAY });
    assert.equal(radio.dataset.artworkSrc, source('1'));
    assert.deepEqual([...radio.classList.values], ['logo-art']);
    const video = createThumbImage({ id: 'v', title: 'A Talk Show', type: 'video', source: '', thumbnail: RELAY });
    assert.equal(video.dataset.artworkSrc, source('2'));
    assert.deepEqual([...video.classList.values], []);
    // Remote artwork: exactly as before.
    const remoteVideo = createThumbImage({ id: 'w', title: 'Other', type: 'video', source: '', thumbnail: RELAY });
    assert.equal(remoteVideo.dataset.artworkSrc, RELAY);
    assert.deepEqual([...remoteVideo.classList.values], []);
    const remoteRadio = createThumbImage({ id: 's', title: 'Other FM', type: 'radio', source: '', thumbnail: RELAY });
    assert.deepEqual([...remoteRadio.classList.values], ['logo-art']);
  } finally {
    applyStationImageList({ images: [] });
    globalThis.document = previous.document;
    state.settings = previous.settings;
  }
});

/* Enough DOM for the detail panel to mount and swap its picture. */
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
}

test('detail panel: a picture still on its way, or replaced by remote artwork, is not marked', () => {
  const state = getState();
  const previous = {
    settings: state.settings, root: ui.root, panel: ui.detailPanel,
    document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window,
  };
  state.settings = normalizeSettings({});
  // Picture requests never answer: this is about the fit, not about loading.
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
  try {
    applyStationImageList({ images: [picture('dkfm', '1')] });
    openDetail({ id: 'fav:dkfm', title: 'DKFM', type: 'radio', source: '', thumbnail: RELAY });
    const panel = ui.detailPanel;
    const thumbOf = () => panel.children.find((node) => node.className === 'detail-thumb');
    const custom = thumbOf();
    // Its request never answers: nothing on screen yet, so not marked.
    assert.equal(custom.classList.contains(STATION_IMAGE_CLASS), false);

    // The picture would not load: the station's own artwork, with its own fit.
    markStationImageFailed(source('1'));
    assert.equal(refreshDetailArtwork(), true);
    const remote = thumbOf();
    assert.notEqual(remote, custom);
    assert.equal(remote.classList.contains(STATION_IMAGE_CLASS), false);

    // Refresh brings a new file: a new picture, unmarked until it has loaded
    // (loading and marking are covered with a loading image above).
    applyStationImageList({ images: [picture('dkfm', '1', 'bbb222')] });
    assert.equal(refreshDetailArtwork(), true);
    assert.notEqual(thumbOf(), remote);
    assert.equal(thumbOf().classList.contains(STATION_IMAGE_CLASS), false);
  } finally {
    closeDetail();
    applyStationImageList({ images: [] });
    ui.root = previous.root;
    ui.detailPanel = previous.panel;
    state.settings = previous.settings;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
});

test('detail panel finds its picture to swap even when it carries the station-picture class', async () => {
  // In a browser the class name of a station picture is "detail-thumb is-station-image".
  const detail = await read('src/modes/library/detail.js');
  assert.match(detail, /String\(node\.className \|\| ''\)\.split\(\/\\s\+\/\)\.includes\('detail-thumb'\)/);
  assert.doesNotMatch(detail, /className === 'detail-thumb'/);
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

/** The player with a fake page. The bar's <img> "loads" whatever it is given
 *  on the next microtask; `pictures(id)` answers a station-picture request
 *  (return a promise to hold it). */
async function playerRig(t, pictures) {
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
  let registrations = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'fit-token' });
    if (path === '/api/v1/media/register') {
      registrations += 1;
      const mediaId = `fit_media_${String(registrations).padStart(12, '0')}`;
      return envelope(201, { media_id: mediaId, relay_url: `/api/v1/media/${mediaId}` });
    }
    if (/^\/api\/v1\/station-images\/[0-9a-f]{32}$/.test(path)) return pictures(String(path).split('/').pop());
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
  const art = elements['player-art'];
  const initials = document.register(new FakeElement('player-art-initials', 'span'));
  const shown = { src: '' };
  art.complete = true;
  art.naturalWidth = 10;
  Object.defineProperty(art, 'src', {
    configurable: true,
    get: () => shown.src,
    set: (value) => {
      shown.src = String(value);
      queueMicrotask(() => { if (shown.src === String(value)) art.onload?.(); });
    },
  });
  art.getAttribute = (name) => (name === 'src' ? shown.src || null : FakeElement.prototype.getAttribute.call(art, name));
  art.removeAttribute = (name) => { if (name === 'src') shown.src = ''; };

  player = await import(`../src/lib/player.js?stationImageFit=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const play = async (title, thumbnail = '', type = 'radio') => {
    await player.playItem({
      id: `fit:${title}`, title, description: '', source: 'radio-browser', type,
      stream_kind: 'audio', stream_url: `https://radio.example/${title.replace(/\W/g, '')}`,
      delivery: type === 'radio' || type === 'tv' ? 'live' : 'on-demand',
      capture_headers: {}, thumbnail, country: '', language: '', _extra: { streamCandidates: [] },
    });
    await settle();
  };
  return {
    art, initials, play,
    get src() { return shown.src; },
    whole: () => art.classList.contains(STATION_IMAGE_CLASS),
  };
}

const jpeg = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });

test('player bar: a station picture is shown whole, remote artwork keeps its own fit, on every change', async (t) => {
  const bar = await playerRig(t, jpeg);
  await bar.play('DKFM', RELAY);
  assert.equal(bar.src, RELAY);
  assert.equal(bar.whole(), false, 'remote artwork keeps its own fit');

  // Refresh finds DKFM.jpg: shown whole.
  applyStationImageList({ images: [picture('dkfm', '1')] });
  await settle();
  assert.match(bar.src, /^blob:/);
  assert.equal(bar.whole(), true);

  // Removed again: the station's own artwork, with its own fit.
  applyStationImageList({ images: [] });
  await settle();
  assert.equal(bar.src, RELAY);
  assert.equal(bar.whole(), false);

  // Back, and then a picture that will not load: own artwork, own fit.
  applyStationImageList({ images: [picture('dkfm', '1', 'ccc333')] });
  await settle();
  assert.equal(bar.whole(), true);
  bar.art.onerror();
  await settle();
  assert.equal(bar.src, RELAY);
  assert.equal(bar.whole(), false);
});

test('player bar: a radio or TV logo is shown whole in the square, other artwork fills it', async (t) => {
  const base = await read('src/styles/base.css');
  const logo = rule(base, '#player-art.is-logo');
  assert.match(logo, /object-fit: contain;/);
  // On the plain surface #player-art already has: no other colour, no padding.
  assert.doesNotMatch(logo, /background|padding|object-position/);
  assert.match(rule(base, '#player-art'), /background: var\(--bg-elev-3\);/);
  // The station-picture rule follows it, so a station picture keeps its own surface.
  assert.ok(base.indexOf('#player-art.is-logo') > base.indexOf('#player-art {'));
  assert.ok(base.indexOf('#player-art.is-station-image') > base.indexOf('#player-art.is-logo'));

  const bar = await playerRig(t, jpeg);
  const isLogo = () => bar.art.classList.contains('is-logo');
  await bar.play('Almere TV', RELAY, 'tv');
  assert.equal(bar.src, RELAY);
  assert.equal(isLogo(), true, 'a TV channel logo is shown whole');
  await bar.play('Golf FM', RELAY, 'radio');
  assert.equal(isLogo(), true, 'a radio logo is shown whole');
  await bar.play('A Film', RELAY, 'video');
  assert.equal(bar.src, RELAY);
  assert.equal(isLogo(), false, 'film artwork fills the square as before');
  await bar.play('An Episode', RELAY, 'audio');
  assert.equal(isLogo(), false, 'episode artwork fills the square as before');
});

test('player bar: the station-picture class follows what is on screen while stations change', async (t) => {
  // Alpha's picture answers at once, Bravo's is held, Charlie's is missing.
  let releaseBravo = null;
  const bar = await playerRig(t, (pictureId) => {
    if (pictureId === id(6)) return new Promise((resolve) => { releaseBravo = () => resolve(jpeg()); });
    if (pictureId === id(7)) return new Response('', { status: 404 });
    return jpeg();
  });
  applyStationImageList({ images: [picture('alpha fm', '5'), picture('bravo fm', '6'), picture('charlie fm', '7')] });
  const relay = '/api/v1/assets/deltadeltadelta0001';

  // A station whose picture loads: on screen, marked.
  await bar.play('Alpha FM');
  assert.match(bar.src, /^blob:/);
  assert.equal(bar.whole(), true);
  assert.equal(bar.art.style.opacity, '1');

  // A station whose picture is slow: the box is emptied and unmarked, so its
  // initials show while it waits.
  await bar.play('Bravo FM');
  assert.equal(typeof releaseBravo, 'function', 'its picture was asked for');
  assert.equal(bar.src, '');
  assert.equal(bar.whole(), false);
  assert.equal(bar.initials.hidden, false);
  assert.equal(bar.initials.textContent, 'BF');
  // ... and marked when it arrives.
  releaseBravo();
  await settle();
  assert.match(bar.src, /^blob:/);
  assert.equal(bar.whole(), true);

  // A station whose picture cannot be fetched: unmarked, initials shown.
  await bar.play('Charlie FM');
  await settle();
  assert.equal(bar.src, '');
  assert.equal(bar.whole(), false);
  assert.equal(bar.initials.hidden, false);
  assert.equal(bar.initials.textContent, 'CF');

  // A station with remote artwork: unmarked, the artwork has its own fit.
  await bar.play('Delta FM', relay);
  assert.equal(bar.src, relay);
  assert.equal(bar.whole(), false);
  assert.equal(bar.art.style.opacity, '1');
});

test('player bar: a late picture for a station no longer playing changes nothing', async (t) => {
  let releaseEcho = null;
  const bar = await playerRig(t, (pictureId) => (pictureId === id(8)
    ? new Promise((resolve) => { releaseEcho = () => resolve(jpeg()); })
    : jpeg()));
  applyStationImageList({ images: [picture('echo fm', '8')] });
  const relay = '/api/v1/assets/foxtrotfoxtrot00001';
  await bar.play('Echo FM');
  assert.equal(bar.whole(), false);
  await bar.play('Foxtrot FM', relay);
  assert.equal(bar.src, relay);
  releaseEcho();
  await settle();
  assert.equal(bar.src, relay, 'the old station picture is not put on the bar');
  assert.equal(bar.whole(), false);
  // A stale load event from an older station picture does not mark the bar either.
  await bar.play('Echo FM');
  assert.match(bar.src, /^blob:/);
  assert.equal(bar.whole(), true);
  const staleOnload = bar.art.onload;
  await bar.play('Foxtrot FM', relay);
  assert.equal(bar.whole(), false);
  staleOnload?.call(bar.art);
  assert.equal(bar.whole(), false);
});

