import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import {
  STATION_IMAGES_HINT, applyStationImageList, bindStationImageControls, isStationImageSource,
  loadStationImages, markStationImageFailed, normalizeStationName, onStationImagesChange,
  openStationImagesFolder, peekStationImageUrl, stationImageSourceFor, stationImageUrl,
  stationImagesSnapshot, stationImagesStatusText,
} from '../src/lib/station-images.js';
import { artworkSourceFor, loadArtworkImage } from '../src/lib/artwork.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const RELAY = '/api/v1/assets/opaque_token_long_enough';
const id = (n) => String(n).repeat(32).slice(0, 32);
const entry = (key, n, v = 'abc123') => ({ key, id: id(n), v });
const source = (n, v = 'abc123') => `station-image:${id(n)}:${v}`;

function list(...images) {
  return { folder: 'D:\\App\\WorldMediaWindows-data\\station-images', exists: true, version: 'v1', images };
}

class ImageDouble extends EventTarget {
  isConnected = true;
  naturalWidth = 0;
  complete = false;
  url = '';
  get src() { return this.url; }
  set src(value) { this.url = value; }
  getAttribute(name) { return name === 'src' ? this.url || null : null; }
  removeAttribute(name) { if (name === 'src') this.url = ''; }
}

/** A fake backend: the session route and one picture route per id. */
function backend(pictures = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/session') {
      return new Response(JSON.stringify({ ok: true, data: { token: 'T'.repeat(64) } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const match = /^\/api\/v1\/station-images\/([0-9a-f]{32})$/.exec(url);
    const picture = match && pictures[match[1]];
    if (!picture) return new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(picture.body, { status: 200, headers: { 'content-type': picture.type } });
  };
  return { fetchImpl, calls };
}

test.beforeEach(() => {
  resetControlSession();
  applyStationImageList({ images: [] });
});

test('names are matched the same way as the backend (shared cases)', async () => {
  const { cases } = JSON.parse(await read('tests/fixtures/station-image-names.json'));
  assert.ok(cases.length > 20);
  for (const [value, expected] of cases) assert.equal(normalizeStationName(value), expected, JSON.stringify(value));
  assert.equal(normalizeStationName('x'.repeat(1025)), '');
  assert.equal(normalizeStationName(null), '');
});

test('a picture named like an item takes priority over its relay artwork', () => {
  const changes = [];
  const off = onStationImagesChange(() => changes.push(1));
  try {
    assert.equal(applyStationImageList(list(entry('radio paradise', 'a'), entry('kexp', 'b'))), true);
    assert.equal(changes.length, 1);
    const paradise = { id: 'rb:1', source: 'radio-browser', title: 'Radio  PARADISE', thumbnail: RELAY };
    const kexp = { id: 'fav:2', source: 'playlist', title: 'KEXP.', thumbnail: '' };
    const other = { id: 'ia:3', source: 'internet-archive', title: 'Something else', thumbnail: RELAY };
    assert.equal(stationImageSourceFor(paradise), source('a'));
    assert.equal(artworkSourceFor(paradise), source('a'));
    assert.equal(artworkSourceFor(kexp), source('b'));
    assert.equal(artworkSourceFor(other), RELAY);
    assert.equal(artworkSourceFor({ title: 'Nothing' }), '');
    // Hidden (explicit) items show no picture of any kind.
    assert.equal(stationImageSourceFor({ ...paradise, __contentHidden: true }), '');
    assert.ok(isStationImageSource(source('a')));
    assert.ok(!isStationImageSource(RELAY));
    // The same list again is no change; a new stamp is.
    assert.equal(applyStationImageList(list(entry('radio paradise', 'a'), entry('kexp', 'b'))), false);
    assert.equal(changes.length, 1);
    assert.equal(applyStationImageList(list(entry('radio paradise', 'a', 'def456'), entry('kexp', 'b'))), true);
    assert.equal(artworkSourceFor(paradise), source('a', 'def456'));
    assert.equal(stationImagesSnapshot().count, 2);
  } finally {
    off();
  }
});

test('list entries that are not well formed are ignored', () => {
  applyStationImageList(list(
    { key: 'bad id', id: '../../etc', v: 'abc' },
    { key: 'bad stamp', id: id('c'), v: 'not hex!' },
    { key: '', id: id('d'), v: 'abc' },
    { key: 'good', id: id('e'), v: 'abc' },
    { key: 'good', id: id('f'), v: 'abc' },
    'nonsense', null,
  ));
  assert.equal(stationImagesSnapshot().count, 1);
  assert.equal(stationImageSourceFor({ title: 'Good' }), `station-image:${id('e')}:abc`);
  assert.equal(stationImageSourceFor({ title: 'bad id' }), '');
  applyStationImageList({ images: 'nope' });
  assert.equal(stationImagesSnapshot().count, 0);
});

test('a custom picture loads through the token-checked route and its object URL', async () => {
  applyStationImageList(list(entry('radio paradise', 'a')));
  const { fetchImpl, calls } = backend({ [id('a')]: { body: new Uint8Array([1, 2, 3]), type: 'image/png' } });
  const image = new ImageDouble();
  const item = { id: 'rb:1', source: 'radio-browser', title: 'Radio Paradise', thumbnail: RELAY };
  const loading = loadArtworkImage(image, artworkSourceFor(item), { fetchImpl, attempts: 1, imageTimeoutMs: 500 });
  for (let i = 0; i < 20 && !image.url; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.match(image.url, /^blob:/);
  image.naturalWidth = 64;
  image.dispatchEvent(new Event('load'));
  assert.equal(await loading, image);
  const pictureCall = calls.find((call) => call.url.startsWith('/api/v1/station-images/'));
  assert.equal(pictureCall.url, `/api/v1/station-images/${id('a')}`);
  assert.equal(pictureCall.options.headers['X-WorldMedia-Token'], 'T'.repeat(64));
  assert.equal(pictureCall.options.cache, 'no-cache');
  assert.equal(peekStationImageUrl(source('a')), image.url);
  // Shared: a second view does not fetch again.
  const before = calls.length;
  assert.equal(await stationImageUrl(source('a'), { fetchImpl }), image.url);
  assert.equal(calls.length, before);
});

test('a picture that will not load falls back to the item\'s own artwork, not a broken image', async () => {
  applyStationImageList(list(entry('radio paradise', 'a'), entry('jazz', 'b')));
  const item = { id: 'rb:1', source: 'radio-browser', title: 'Radio Paradise', thumbnail: RELAY };
  const changes = [];
  const off = onStationImagesChange(() => changes.push(artworkSourceFor(item)));
  try {
    // The server no longer has it.
    const { fetchImpl } = backend({});
    await assert.rejects(loadArtworkImage(new ImageDouble(), source('a'), { fetchImpl, attempts: 1 }));
    assert.deepEqual(changes, [RELAY]);
    assert.equal(artworkSourceFor(item), RELAY);
    // Bytes that do not decode: the image's error event.
    const decoding = backend({ [id('b')]: { body: new Uint8Array([9]), type: 'image/png' } });
    const image = new ImageDouble();
    const loading = loadArtworkImage(image, source('b'), { fetchImpl: decoding.fetchImpl, attempts: 1 });
    for (let i = 0; i < 20 && !image.url; i += 1) await new Promise((resolve) => setImmediate(resolve));
    image.dispatchEvent(new Event('error'));
    await assert.rejects(loading);
    assert.equal(artworkSourceFor({ title: 'Jazz' }), '');
    // A refreshed list with a new stamp tries the picture again.
    applyStationImageList(list(entry('radio paradise', 'a', 'f00d'), entry('jazz', 'b')));
    assert.equal(artworkSourceFor(item), source('a', 'f00d'));
  } finally {
    off();
  }
});

test('a response that is not a raster image is refused', async () => {
  applyStationImageList(list(entry('svg station', 'c')));
  const { fetchImpl } = backend({ [id('c')]: { body: '<svg/>', type: 'image/svg+xml' } });
  await assert.rejects(stationImageUrl(source('c'), { fetchImpl }), /not an image/);
  markStationImageFailed(source('c'));
  assert.equal(stationImageSourceFor({ title: 'SVG Station' }), '');
});

test('items without a match cost nothing extra', () => {
  let normalized = 0;
  const original = String.prototype.normalize;
  String.prototype.normalize = function patched(...args) { normalized += 1; return original.apply(this, args); };
  try {
    for (let i = 0; i < 500; i += 1) stationImageSourceFor({ title: `Station ${i}` });
  } finally {
    String.prototype.normalize = original;
  }
  assert.equal(normalized, 0, 'no list, no work');
});

test('the list is fetched from the read-only route and opening uses the mutating route', async () => {
  const requests = [];
  const request = async (path, options = {}) => {
    requests.push([path, options]);
    return list(entry('radio paradise', 'a'));
  };
  const data = await loadStationImages({ request });
  assert.equal(data.images.length, 1);
  assert.equal(stationImageSourceFor({ title: 'Radio Paradise' }), source('a'));
  await openStationImagesFolder({ request });
  assert.deepEqual(requests, [
    ['/api/v1/station-images', {}],
    ['/api/v1/station-images/open-folder', { method: 'POST', body: {} }],
  ]);
});

test('the status line says how many pictures were found and why others were ignored', () => {
  assert.equal(stationImagesStatusText({ exists: true, found: 12, ignored: 1,
    ignored_reasons: [{ reason: 'too_large', text: 'too large', count: 1 }] }),
  '12 pictures found. 1 ignored: too large.');
  assert.equal(stationImagesStatusText({ exists: true, found: 1, ignored: 0, ignored_reasons: [] }), '1 picture found.');
  assert.equal(stationImagesStatusText({ exists: true, found: 0, ignored: 3, ignored_reasons: [
    { reason: 'too_large', text: 'too large', count: 2 },
    { reason: 'not_image', text: 'not a picture', count: 1 },
  ] }), 'No pictures found. 3 ignored: 2 too large, 1 not a picture.');
  assert.equal(stationImagesStatusText({ exists: false, found: 0 }),
    'There is no station-images folder yet. Open folder makes it.');
  assert.equal(stationImagesStatusText({ problem: 'The station-images folder is a link.' }),
    'The station-images folder is a link.');
});

function settingsBlock() {
  return {
    path: new FakeElement('path', 'code'),
    status: new FakeElement('status', 'span'),
    openButton: new FakeElement('open', 'button'),
    refreshButton: new FakeElement('refresh', 'button'),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Settings block: folder path, Refresh status, Open folder and errors as plain text', async () => {
  const block = settingsBlock();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { ...list(entry('a', 'a')), found: 12, ignored: 1,
      ignored_reasons: [{ reason: 'too_large', text: 'too large', count: 1 }] };
  };
  let openResult = { opened: true, path: 'D:\\App\\WorldMediaWindows-data\\station-images' };
  const openFolder = async () => {
    if (openResult instanceof Error) throw openResult;
    return openResult;
  };
  bindStationImageControls({ ...block, load, openFolder });
  assert.equal(block.path.textContent, 'Checking\u2026');
  await settle();
  assert.equal(block.path.textContent, 'D:\\App\\WorldMediaWindows-data\\station-images');
  assert.equal(block.status.textContent, '', 'no status line before Refresh');
  block.refreshButton.dispatchEvent(new Event('click'));
  assert.equal(block.refreshButton.disabled, true);
  await settle();
  assert.equal(block.status.textContent, '12 pictures found. 1 ignored: too large.');
  assert.equal(block.status.dataset.state, 'ready');
  assert.equal(block.refreshButton.disabled, false);
  assert.equal(loads, 2);
  openResult = new Error('<b>Access</b> denied');
  block.openButton.dispatchEvent(new Event('click'));
  await settle();
  assert.equal(block.status.textContent, 'The folder could not be opened: <b>Access</b> denied');
  assert.equal(block.status.dataset.state, 'error');
  assert.equal(block.openButton.disabled, false);
});

test('Settings block: a known folder is shown without asking again; a failed check says so', async () => {
  applyStationImageList(list());
  const block = settingsBlock();
  let loads = 0;
  bindStationImageControls({
    ...block,
    load: async () => { loads += 1; throw new Error('Session token is missing or invalid.'); },
    openFolder: async () => ({}),
  });
  assert.equal(block.path.textContent, 'D:\\App\\WorldMediaWindows-data\\station-images');
  assert.equal(loads, 0);
  block.refreshButton.dispatchEvent(new Event('click'));
  await settle();
  assert.equal(block.status.textContent, 'The folder could not be checked: Session token is missing or invalid.');
  assert.equal(block.status.dataset.state, 'error');
});

test('Settings has a Station images block in Storage built from fixed text only', async () => {
  const settings = await read('src/lib/settings.js');
  const storage = settings.slice(settings.indexOf('<h3>Storage</h3>'), settings.indexOf('<h3>About</h3>'));
  assert.match(storage, /data-station-images>/);
  assert.match(storage, /<label>Station images<\/label>/);
  assert.match(storage, /\$\{STATION_IMAGES_HINT\}/);
  assert.match(storage, /data-act="station-images-open"[^>]*>Open folder</);
  assert.match(storage, /data-act="station-images-refresh"[^>]*>Refresh</);
  assert.match(storage, /data-station-images-status role="status" aria-live="polite"/);
  assert.equal(STATION_IMAGES_HINT, 'Put a picture in this folder named exactly like the station, for example '
    + 'Radio Paradise.png. PNG, JPG, WebP or GIF, up to 2 MB each.');
  assert.doesNotMatch(STATION_IMAGES_HINT, /[<>&"]/);
  assert.match(settings, /bindStationImageControls\(\{/);
  // The path and the status are only ever set as text.
  const module = await read('src/lib/station-images.js');
  assert.doesNotMatch(module, /innerHTML|insertAdjacentHTML/);
  // Long paths wrap instead of widening the 1024px-wide modal.
  const css = await read('src/styles/base.css');
  assert.match(css, /\.station-images-path \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.backup-row > div:first-child \{ min-width: 0; \}/);
});

test('every view takes its picture from artworkSourceFor and follows a change of the list', async () => {
  for (const path of ['src/modes/library/thumbnails.js', 'src/modes/library/detail.js', 'src/modes/grid.js',
    'src/modes/discovery.js']) {
    assert.match(await read(path), /artworkSourceFor\(/, path);
  }
  const player = await read('src/lib/player.js');
  assert.match(player, /const custom = stationImageSourceFor\(item\);/);
  assert.match(player, /onStationImagesChange\(syncPlayerStationImage\);/);
  assert.match(await read('src/modes/library/index.js'),
    /subs\.push\(onStationImagesChange\(\(\) => \{ renderResults\(\); refreshDetailArtwork\(\); refreshDetailPictureControls\(\); \}\)\);/);
  // Subscribed while the view is mounted; tearDown() unsubscribes with the rest.
  assert.match(await read('src/modes/grid.js'), /subs\.push\(onStationImagesChange\(\(\) => \{ syncTileStationImages\(\); \}\)\);/);
  const discovery = await read('src/modes/discovery.js');
  assert.match(discovery, /subs\.push\(onStationImagesChange\(\(\) => \{ syncDiscoveryStationImage\(\); \}\)\);/);
  // Discovery redraws the item on show only when its picture changed, and never replays it.
  const sync = discovery.slice(discovery.indexOf('export function syncDiscoveryStationImage'));
  const body = sync.slice(0, sync.indexOf('\n}'));
  assert.match(body, /if \(stationImageSourceFor\(item\) === \(ui\.now\.__stationImage \|\| ''\)\) return false;/);
  assert.match(body, /renderNow\(item\);/);
  assert.doesNotMatch(body, /playItem|focus/);
  assert.match(discovery, /ui\.now\.__stationImage = stationImageSourceFor\(item\);/);
  assert.match(await read('src/main.js'), /loadStationImages\(\)\.catch\(\(\) => \{\}\);/);
});

test('Refresh tries a picture again after it failed to load, even when the list is unchanged', async () => {
  const picture = list(entry('radio paradise', 'a'));
  applyStationImageList(picture);
  const item = { id: 'rb:1', source: 'radio-browser', title: 'Radio Paradise', thumbnail: RELAY };
  // A passing failure: the server was busy past its retries.
  const busy = async (url) => (url === '/api/v1/session'
    ? new Response(JSON.stringify({ ok: true, data: { token: 'T'.repeat(64) } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    : new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(loadArtworkImage(new ImageDouble(), source('a'), { fetchImpl: busy, attempts: 1 }));
  assert.equal(artworkSourceFor(item), RELAY);
  // The same list taken in without a fresh load keeps it suppressed.
  assert.equal(applyStationImageList(picture), false);
  assert.equal(artworkSourceFor(item), RELAY);

  const changes = [];
  const off = onStationImagesChange(() => changes.push(artworkSourceFor(item)));
  try {
    await loadStationImages({ request: async () => picture });
    assert.deepEqual(changes, [source('a')], 'views are told to show it again');
    assert.equal(artworkSourceFor(item), source('a'));
    const { fetchImpl, calls } = backend({ [id('a')]: { body: new Uint8Array([1, 2, 3]), type: 'image/png' } });
    assert.match(await stationImageUrl(source('a'), { fetchImpl }), /^blob:/);
    assert.ok(calls.some((call) => call.url === `/api/v1/station-images/${id('a')}`), 'fetched again');
    // A Refresh with nothing failed is no change.
    await loadStationImages({ request: async () => picture });
    assert.equal(changes.length, 1);
  } finally {
    off();
  }
});

test('no profile data is stored for station pictures', async () => {
  const module = await read('src/lib/station-images.js');
  assert.doesNotMatch(module, /localStorage|saveSettings|worldmedia\.[a-z]+\.v1/);
});
