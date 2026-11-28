import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { createComputerLibrary } from '../src/lib/computer-library.js';
import { clearComputerQueue, computerQueueState, makeComputerItem, moveComputerQueue, playComputerEntries, setComputerQueue } from '../src/lib/computer-play.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { fakeComputerStars } from './helpers/fake-computer-stars.js';
import {
  addFavorite, getState, initState, isFavorite, loadComputerStars, moveFavorite,
  removeFavorite, STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { renderComputer } from '../src/modes/computer.js';
import { computerWindow } from '../src/modes/computer-window.js';
import { FakeElement } from './helpers/fake-dom.js';

const saved = [{ id: 'music', path: 'D:\\Music', available: true }];
const idle = { scanning: false, phase: 'idle', ffprobe: true, revision: 1 };
const settle = () => new Promise(setImmediate);

class Node extends FakeElement {
  dataset = {};
  scrollTop = 0;
  scrollLeft = 0;
  clientWidth = 1024;
  clientHeight = 396;

  get textContent() {
    return this.tagName === 'TD' && this.children.length ? this.children.map((child) => child.textContent).join('') : this.text;
  }
  set textContent(value) { this.text = value; }

  get nextElementSibling() {
    const siblings = this.parentElement?.children;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }

  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, next) {
    node.remove();
    node.parentElement = this;
    this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node);
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  focus() {
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new Event('focus'));
  }
}

function event(node, name = 'click', fields = {}) {
  const evt = new Event(name, { cancelable: true, bubbles: name === 'dblclick' });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(evt, key, { value, configurable: true });
  if (evt.bubbles) Object.defineProperty(evt, 'target', { value: fields.target ?? node, configurable: true });
  for (let current = node; current; current = evt.bubbles && !evt.cancelBubble ? current.parentElement : null) {
    current.dispatchEvent(evt);
  }
  return evt;
}
const children = (node) => node.children.flatMap((child) => [child, ...children(child)]);
const text = (node, value) => children(node).find((child) => child.textContent === value);
const klass = (node, name) => children(node).find((child) => child.className?.split(' ').includes(name));
const labelled = (node, label) => children(node).find((child) => child.getAttribute('aria-label') === label);
const tag = (node, name) => children(node).find((child) => child.tagName === name.toUpperCase());
const isVisible = (node) => Boolean(node && !node.hidden && (!node.parentElement || isVisible(node.parentElement)));
const tableRows = (host) => tag(host, 'tbody').children.filter((row) => row.getAttribute('aria-hidden') !== 'true'
  && row.className !== 'computer-inline-header');
const dataCells = (row) => row.children.filter((cell) => cell.className !== 'computer-star-column');

function fakeLibrary(t, initial) {
  let state = {
    revision: 1, loaded: true, folders: saved, items: [], error: '', status: idle, ...initial,
  };
  const listeners = new Set();
  function change(next) {
    state = { ...state, ...next };
    for (const fn of listeners) fn(state);
  }
  return {
    change, listeners,
    getComputerLibrary: () => state,
    subscribeComputerLibrary(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    openComputerLibrary: t.mock.fn(),
    closeComputerLibrary: t.mock.fn(),
    foldersChanged: t.mock.fn((folders) => change({ folders })),
    rescan: t.mock.fn(),
    cancel: t.mock.fn(),
    retry: t.mock.fn(),
    refreshAvailability: t.mock.fn(),
  };
}

function setup(t, initial, options = {}) {
  const doc = new EventTarget();
  doc.createElement = (tag) => Object.assign(new Node('', tag), { ownerDocument: doc });
  doc.body = doc.createElement('body');
  const host = doc.createElement('main');
  doc.body.append(host);
  doc.body.focus();
  const win = new EventTarget();
  const frames = new Map();
  const observers = new Set();
  let frameId = 0;
  win.matchMedia = options.matchMedia;
  win.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  win.cancelAnimationFrame = (key) => frames.delete(key);
  win.ResizeObserver = class {
    constructor(callback) { this.resize = callback; }
    observe(node) { this.node = node; observers.add(this); }
    disconnect() { observers.delete(this); }
  };
  const listeners = new Map();
  function onState(name, fn) {
    if (options.appState && ['favorites-change', 'computer-stars-order', 'computer-stars-status'].includes(name)) return subscribe(name, fn);
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }
  const emit = (name, value) => { for (const fn of listeners.get(name) || []) fn(value); };
  const app = { currentItem: null, settings: {} };
  const library = options.library || fakeLibrary(t, initial);
  const play = options.play || t.mock.fn(async () => {});
  const deps = { doc, win, library, appState: () => app, onState, play, ...options };
  const mount = () => renderComputer(host, deps);
  mount();
  t.after(() => emit('mode-change', 'library'));

  return {
    doc, win, host, library, play, listeners, emit, app, frames, observers, mount,
    flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn();
    },
  };
}

const audio = (id, fields = {}) => ({
  id, kind: 'audio', folder: 'music', title: id, album: 'Record', artist: 'Artist',
  rel: `Record/${id}.flac`, duration: 180, ext: 'flac', probed: true,
  ...fields,
});

function select(host, label, value) {
  const field = labelled(host, label);
  field.value = value;
  event(field, 'change');
}

test('window geometry handles partial rows, column changes, empty views and the bottom of 50,000 entries', () => {
  assert.deepEqual(computerWindow(50_000, 36, 360, 0), { start: 0, end: 11, total: 1_800_000 });
  assert.deepEqual(computerWindow(50_000, 36, 360, 365), { start: 9, end: 22, total: 1_800_000 });
  assert.deepEqual(computerWindow(50_000, 36, 360, 5_000_000), { start: 49_989, end: 50_000, total: 1_800_000 });
  assert.deepEqual(computerWindow(13, 242, 200, 0, 3), { start: 0, end: 6, total: 1210 });
  assert.deepEqual(computerWindow(10, 36, 0, 5), { start: 0, end: 0, total: 360 });
  assert.deepEqual(computerWindow(0, 36, 400, 5), { start: 0, end: 0, total: 0 });
});

test('empty state, folder toggle, scan phases, Retry and FFmpeg hint', async (t) => {
  const { host, library } = setup(t, { folders: [] }, {
    pickComputerFolder: async () => ({ available: true, path: saved[0].path }),
    addComputerFolder: async () => ({ folders: saved }),
  });
  assert.ok(isVisible(text(host, 'Add folder...')));
  assert.ok(isVisible(text(host, 'No folders added yet.')));
  assert.equal(klass(host, 'computer-folders').getAttribute('data-empty-state'), 'true');
  assert.equal(isVisible(klass(host, 'computer-kinds')), false);
  assert.equal(isVisible(klass(host, 'computer-toolbar')), false);
  event(text(host, 'Add folder...'));
  await settle();
  assert.equal(library.foldersChanged.mock.callCount(), 1);
  assert.ok(isVisible(text(host, 'No music or videos were found in your folders.')));
  const folders = klass(host, 'computer-folders');
  assert.equal(folders.hidden, false);
  const toggle = klass(host, 'computer-toolbar').children.find((node) => node.textContent === 'Folders (1)');
  event(toggle);
  assert.equal(folders.hidden, true);
  event(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(folders.hidden, false);
  assert.equal(folders.getAttribute('data-empty-state'), 'false');
  event(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(folders.hidden, true);

  const items = [audio('Song', { probed: false }), audio('Book', { ext: 'm4b' }), { id: 'video', kind: 'video' }];
  library.change({ items, status: { ...idle, ffprobe: false, scanning: true, phase: 'walking', files_found: 1240 } });
  assert.ok(isVisible(text(host, 'Music 1')));
  assert.ok(isVisible(text(host, 'Videos 1')));
  assert.equal(text(host, 'Music 1').getAttribute('aria-pressed'), 'true');
  assert.ok(isVisible(text(host, `Looking for files... ${(1240).toLocaleString()} found`)));
  const hint = text(host, 'Install FFmpeg in Settings to read tags, covers and lengths.');
  assert.ok(isVisible(hint));
  assert.equal(isVisible(tag(host, 'progress')), false);

  library.change({ status: { ...idle, scanning: true, phase: 'reading', files_read: 1240, files_to_read: 5300 } });
  assert.equal(isVisible(hint), false);
  assert.ok(isVisible(text(host, `Reading tags ${(1240).toLocaleString()} of ${(5300).toLocaleString()}`)));
  const progress = tag(host, 'progress');
  assert.equal(progress.max, 5300);
  assert.equal(progress.value, 1240);
  event(klass(host, 'computer-scan').children.find((node) => node.textContent === 'Cancel'));
  assert.equal(library.cancel.mock.callCount(), 1);

  library.change({ status: { ...idle, scanning: true, phase: 'cancelling' } });
  assert.ok(isVisible(text(host, 'Stopping...')));
  assert.equal(isVisible(progress), false);
  library.change({ status: null, error: 'Scan status is not available.' });
  assert.equal(isVisible(progress), false);
  assert.equal(isVisible(klass(host, 'computer-scan-progress')), false);
  assert.ok(isVisible(text(host, 'Scan status is not available.')));
  assert.ok(isVisible(text(host, 'Retry')));
  library.change({ status: { ...idle, last_error: 'One folder was offline.' }, error: 'Connection lost.' });
  assert.ok(isVisible(text(host, 'One folder was offline.')));
  assert.ok(isVisible(text(host, 'Connection lost.')));
  event(text(host, 'Retry'));
  assert.equal(library.retry.mock.callCount(), 1);
  const rescan = text(host, 'Rescan');
  assert.equal(rescan.title, 'Look for new, changed and removed files');
  event(rescan);
  assert.equal(library.rescan.mock.callCount(), 1);
});

test('locating an offline folder refreshes its row and shows the usual scan progress', async (t) => {
  const offline = { ...saved[0], available: false };
  const relocated = { ...offline, path: 'E:\\Relocated Music', available: true };
  let folders = [offline];
  let status = idle;
  const library = createComputerLibrary({
    computerStatus: async () => status,
    startComputerScan: async () => status,
    loadComputerLibrary: async () => ({ revision: status.revision, folders, items: [] }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  const relocate = t.mock.fn(async () => {
    folders = [relocated];
    status = { ...idle, revision: 2, scanning: true, phase: 'walking', files_found: 40 };
    return { folder: relocated, folders };
  });
  const { host } = setup(t, {}, {
    library, listComputerFolders: async () => ({ folders }),
    pickComputerFolder: async () => ({ available: true, path: relocated.path }),
    relocateComputerFolder: relocate,
  });
  await settle();
  event(text(host, 'Folders (1)'));
  event(text(host, 'Locate...'));
  await settle();
  assert.deepEqual(relocate.mock.calls[0].arguments.slice(0, 2), [offline.id, relocated.path]);
  assert.ok(isVisible(text(host, relocated.path)));
  assert.equal(text(host, 'Locate...'), undefined);
  assert.ok(isVisible(text(host, 'Looking for files... 40 found')));
});

test('albums use a window, cancel scrolled-off covers, and open tracks with disc headings and playing state', async (t) => {
  const items = Array.from({ length: 110 }, (_, index) => audio(`song-${index}`, {
    rel: `Artist/${index}/file.flac`, album: `Album ${index}`, has_cover: true,
  }));
  Object.assign(items[48], {
    rel: 'Artist/48/CD1/file.flac', track: 1, album_artist: 'Artist', year: 2019, genre: 'Rock',
    acodec: 'flac', lossless: true, bits: 24, sample_rate: 96000,
  });
  items.push(audio('Track two', {
    rel: 'Artist/48/CD2/file.mp3', album: 'Album 48', album_artist: 'Artist', artist: 'Guest',
    track: 1, acodec: 'mp3', bitrate: 320000, error: 'Cannot read tags',
  }));
  const artwork = [];
  const loadImage = async (image, source, { signal }) => {
    artwork.push({ image, source, signal });
    image.setAttribute('src', 'blob:decoded-cover');
  };
  const ui = setup(t, { items }, { loadImage });
  const { host, doc } = ui;
  const viewport = klass(host, 'computer-album-scroll');
  const grid = klass(host, 'computer-album-grid');
  assert.equal(grid.children.length, 18);
  await settle();
  assert.equal(artwork.length, 18);
  viewport.scrollTop = 8 * 242;
  event(viewport, 'scroll');
  event(viewport, 'scroll');
  assert.equal(ui.frames.size, 1);
  ui.flushFrame();
  assert.equal(artwork[0].signal.aborted, true);
  assert.equal(artwork[0].image.getAttribute('src'), null);
  assert.equal(artwork[0].image.loading, 'lazy');
  assert.equal(artwork[0].image.decoding, 'async');
  assert.ok(grid.children.length <= 24);
  const card = text(grid, 'Album 48').parentElement.parentElement;
  card.focus();
  event(viewport, 'keydown', { target: card, key: 'ArrowRight' });
  assert.equal(doc.activeElement.title, 'Album 49 · Artist');
  event(card); // Native buttons activate on Enter as well as click.
  assert.equal(doc.activeElement.textContent, 'Back');
  assert.ok(isVisible(text(host, 'Disc 1')));
  assert.ok(isVisible(text(host, 'Disc 2')));
  assert.ok(isVisible(text(host, 'Mixed formats')));
  assert.ok(isVisible(text(host, '2019 · Rock · 2 songs · 6 min')));
  assert.ok(isVisible(text(host, 'FLAC 24/96')));
  assert.ok(isVisible(text(host, 'MP3 320 kbps')));
  assert.ok(isVisible(text(host, 'Guest')));
  const row = tableRows(host).find((item) => text(item, 'Track two'));
  assert.equal(row.title, 'Cannot read tags');
  assert.ok(row.classList.contains('has-error'));
  assert.ok(klass(row, 'placeholder'));
  assert.equal(tag(row, 'img'), undefined);
  ui.app.currentItem = { id: 'computer:Track two' };
  ui.emit('current-item', ui.app.currentItem);
  assert.equal(row.getAttribute('aria-current'), 'true');
  event(row, 'keydown', { key: 'Enter' });
  assert.equal(ui.play.mock.calls[0].arguments[1], 1);
  const random = t.mock.method(Math, 'random', () => 0.75);
  event(text(host, 'Shuffle'));
  random.mock.restore();
  assert.equal(ui.play.mock.calls[1].arguments[1], 1);
  assert.deepEqual(ui.play.mock.calls[1].arguments[2], { shuffle: true });
  event(text(host, 'Play'));
  assert.equal(ui.play.mock.calls[2].arguments[1], 0);

  assert.ok(event(doc, 'keydown', { key: 'Escape' }).defaultPrevented);
  const restored = klass(host, 'computer-album-scroll');
  assert.equal(restored.scrollTop, 8 * 242);
  assert.ok(doc.activeElement.classList.contains('has-error'));
  assert.equal(doc.activeElement.title, 'Cannot read tags');
  assert.ok(text(doc.activeElement, 'Album 48'));
  event(doc.activeElement);
  event(ui.win, 'mouseup', { button: 3 });
  assert.equal(klass(host, 'computer-album-scroll').scrollTop, 8 * 242);
  event(doc.activeElement);
  event(text(host, 'Back'));
  const resized = klass(host, 'computer-album-scroll');
  resized.clientWidth = 322;
  [...ui.observers][0].resize();
  assert.equal(klass(host, 'computer-album-grid').style.gridTemplateColumns, 'repeat(1, minmax(0, 156px))');
});

test('song headers sort and report aria-sort, search survives remounts, and 50,000 songs keep a bounded DOM', async (t) => {
  const items = Array.from({ length: 50_000 }, (_, index) => audio(`Song ${index}`, {
    artist: index % 2 === 0 ? 'Café' : 'Björk', duration: 80,
  }));
  const play = t.mock.fn(async () => { throw new Error('File route not installed'); });
  const ui = setup(t, { items }, { play });
  const { host, doc } = ui;
  const state = getState();
  const previous = state.favorites;
  state.favorites = [makeComputerItem(items[0])];
  t.after(() => { state.favorites = previous; });
  let lookups = 0;
  const has = Set.prototype.has;
  const lookup = t.mock.method(Set.prototype, 'has', function (id) {
    if (typeof id === 'string' && id.startsWith('computer:')) lookups += 1;
    return has.call(this, id);
  });
  select(host, 'Music view', 'songs');
  const viewport = klass(host, 'computer-table-scroll');
  const table = tag(host, 'table');
  assert.equal(table.getAttribute('aria-label'), 'Songs');
  assert.equal(table.getAttribute('aria-rowcount'), '50001');
  assert.equal(text(tag(table, 'thead'), 'Title').parentElement.getAttribute('aria-sort'), 'ascending');
  assert.equal(tableRows(host).length, 11);
  assert.equal(lookups, 11, 'one set lookup per visible file');
  assert.equal(dataCells(tableRows(host)[0])[0].textContent, 'Song 0');
  assert.equal(klass(tableRows(host)[0], 'computer-star').getAttribute('aria-pressed'), 'true');

  const first = tableRows(host)[0];
  viewport.scrollTop = 36;
  event(viewport, 'scroll');
  ui.flushFrame();
  assert.equal(tableRows(host)[0], first, 'overlapping rows are reused');
  viewport.scrollTop = 1_800_000;
  event(viewport, 'scroll');
  ui.flushFrame();
  assert.equal(dataCells(tableRows(host).at(-1))[0].textContent, 'Song 49999');
  assert.ok(tableRows(host).length <= 12);
  assert.equal(lookups, 23, 'one bind for the first scroll and 11 at the end');
  assert.ok(tableRows(host).includes(first), 'non-overlapping windows recycle existing rows');
  lookup.mock.restore();

  const artist = text(tag(table, 'thead'), 'Artist');
  event(artist);
  assert.equal(artist.parentElement.getAttribute('aria-sort'), 'ascending');
  assert.equal(text(tag(table, 'thead'), 'Title').parentElement.getAttribute('aria-sort'), null);
  assert.equal(dataCells(tableRows(host)[0])[1].textContent, 'Björk');
  event(artist);
  assert.equal(artist.parentElement.getAttribute('aria-sort'), 'descending');
  assert.equal(dataCells(tableRows(host)[0])[1].textContent, 'Café');

  assert.ok(event(doc, 'keydown', { key: 'f', ctrlKey: true }).defaultPrevented);
  const search = labelled(host, 'Search music');
  assert.equal(doc.activeElement, search);
  assert.equal(event(doc, 'keydown', { key: '/' }).defaultPrevented, false);
  search.value = 'cafe song 4999';
  event(search, 'input');
  const rows = tableRows(host);
  assert.equal(rows.length, 5);
  assert.ok(isVisible(text(host, '5 songs · 6 min')));
  event(rows[1], 'dblclick');
  await settle();
  assert.equal(play.mock.calls[0].arguments[1], 1);
  assert.deepEqual(play.mock.calls[0].arguments[0].map(({ title }) => title),
    ['Song 49990', 'Song 49992', 'Song 49994', 'Song 49996', 'Song 49998']);
  assert.ok(isVisible(text(host, 'This file could not be played.')));
  ui.app.currentItem = { id: 'computer:Song 49992' };
  ui.emit('current-item', ui.app.currentItem);
  assert.ok(rows[1].classList.contains('is-playing'));
  ui.app.currentItem = { id: 'computer:Song 49994' };
  ui.emit('current-item', ui.app.currentItem);
  assert.equal(rows[1].classList.contains('is-playing'), false);
  assert.equal(rows[1].getAttribute('aria-current'), null);
  assert.equal(rows[2].getAttribute('aria-current'), 'true');
  ui.emit('mode-change', 'library');
  assert.equal(getEventListeners(doc, 'keydown').length, 0);
  ui.mount();
  assert.equal(labelled(host, 'Search music').value, 'cafe song 4999');
  assert.ok(isVisible(text(host, '5 songs · 6 min')));
  event(labelled(host, 'Clear search'));
  assert.equal(labelled(host, 'Search music').value, '');
});

test('videos show episodes, lengths, sizes and quality including the optional codec', (t) => {
  const video = {
    id: 'v1', kind: 'video', title: 'Show Name', season: 2, episode: 5, height: 2160,
    duration: 3765, size: 1_500_000_000, year: 2025, vcodec: 'hevc',
  };
  const ui = setup(t, { items: [video] });
  event(text(ui.host, 'Videos 1'));
  assert.equal(text(ui.host, 'Videos 1').getAttribute('aria-pressed'), 'true');
  assert.equal(isVisible(labelled(ui.host, 'Music view')), false);
  select(ui.host, 'Video view', 'videos');
  const row = tableRows(ui.host)[0];
  assert.deepEqual(dataCells(row).map(({ textContent }) => textContent), [
    'Show Name · S02E05', '2025', '1:02:45', `${(1.4).toLocaleString()} GB`, '4K',
  ]);
  ui.app.settings.showTechnicalDetails = true;
  ui.emit('settings-change');
  const updated = tableRows(ui.host)[0];
  assert.equal(updated.children.at(-1).textContent, '4K · HEVC');
  event(updated, 'keydown', { key: 'Enter' });
  assert.deepEqual(ui.play.mock.calls[0].arguments.slice(0, 2), [[video], 0]);
  searchFor(ui.host, 'Search videos', 'missing');
  assert.ok(text(ui.host, 'No matching videos.'));
  searchFor(ui.host, 'Search videos', '');
  ui.emit('mode-change', 'library');
  ui.mount();
  assert.ok(isVisible(labelled(ui.host, 'Search videos')));
});

test('All videos, Movies and Folders pass a dimmed row and its error to playback', (t) => {
  const message = 'This file is too short to play.';
  const still = video('Still', { rel: 'Still.vob', duration: null, error: message });
  const { host, play } = setup(t, { items: [still] });
  event(text(host, 'Videos 1'));
  for (const view of ['videos', 'movies', 'folders']) {
    select(host, 'Video view', view);
    if (view === 'folders') event(tableRows(host)[0]);
    const row = view === 'movies' ? cardsOf(host)[0] : tableRows(host)[0];
    assert.equal(row.title, message);
    assert.ok(row.classList.contains('has-error'));
    event(row, 'dblclick');
    assert.equal(play.mock.callCount(), 1);
    const [entries, index] = play.mock.calls[0].arguments;
    assert.equal(entries[index], still);
    play.mock.resetCalls();
  }
});

test('Computer shortcuts leave overlays and outside Escape alone', (t) => {
  const { doc, host, win } = setup(t, { items: [audio('Song')] });
  event(text(host, 'Music 1'));
  select(host, 'Music view', 'albums');
  const app = doc.createElement('div');
  const picture = doc.createElement('div');
  const panelButton = doc.createElement('button');
  picture.append(panelButton);
  doc.getElementById = (id) => ({ app, 'picture-panel': picture })[id];
  let pictureOpen = false;
  picture.matches = (selector) => selector === ':popover-open' && pictureOpen;
  const card = klass(host, 'computer-album-card');
  const search = labelled(host, 'Search music');
  const back = () => text(host, 'Back');

  for (const panel of ['Settings', 'Equalizer', 'Song log']) {
    app.inert = true;
    const overlay = doc.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.focus();
    for (const keys of [{ key: '/' }, { key: 'f', ctrlKey: true }]) {
      assert.equal(event(doc, 'keydown', keys).defaultPrevented, false, panel);
      assert.equal(doc.activeElement, overlay);
    }
    app.inert = false;
  }
  pictureOpen = true;
  doc.body.focus();
  assert.equal(event(doc, 'keydown', { key: '/' }).defaultPrevented, false);
  panelButton.focus();
  for (const keys of [{ key: '/' }, { key: 'f', ctrlKey: true }]) {
    assert.equal(event(doc, 'keydown', keys).defaultPrevented, false);
    assert.equal(doc.activeElement, panelButton);
  }
  pictureOpen = false;
  doc.body.focus();
  assert.equal(event(doc, 'keydown', { key: '/' }).defaultPrevented, true);
  assert.equal(doc.activeElement, search);
  event(card);

  for (const panel of ['Settings', 'Equalizer', 'Song log', 'Picture']) {
    const isPicture = panel === 'Picture';
    app.inert = !isPicture;
    pictureOpen = isPicture;
    (isPicture ? panelButton : doc.createElement('button')).focus();
    const close = (e) => {
      if (e.key === 'Escape') {
        app.inert = pictureOpen = false;
        back().focus();
      }
    };
    assert.equal(event(doc, 'keydown', { key: 'BrowserBack' }).defaultPrevented, false, panel);
    doc.addEventListener('keydown', close, { once: true });
    assert.equal(event(win, 'mouseup', { button: 3 }).defaultPrevented, false, panel);
    assert.equal(event(doc, 'keydown', { key: 'Escape' }).defaultPrevented, false, panel);
    assert.ok(back(), panel);
  }

  const outside = doc.createElement('button');
  outside.focus();
  assert.equal(event(doc, 'keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.ok(back());
  doc.body.focus();
  assert.equal(event(doc, 'keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(back(), undefined);
});

test('replacement keeps the same focused song and Enter plays the visible fallback when it is gone or offscreen', (t) => {
  const original = Array.from({ length: 30 }, (_, i) => audio('Song ' + i));
  const { doc, host, library, play } = setup(t, { items: original });
  event(text(host, 'Music 30'));
  select(host, 'Music view', 'songs');
  const titleHeader = text(tag(host, 'thead'), 'Title');
  if (titleHeader.parentElement.getAttribute('aria-sort') !== 'ascending') event(titleHeader);
  text(host, 'Song 3').parentElement.focus();
  const activate = (expected) => {
    const row = doc.activeElement;
    assert.equal(dataCells(row)[0].textContent, expected);
    assert.equal(row.tabIndex, 0);
    event(row, 'keydown', { key: 'Enter' });
    const [entries, index] = play.mock.calls.at(-1).arguments;
    assert.equal(entries[index].title, expected);
  };

  const revised = [audio('First'), ...original];
  library.change({ items: revised });
  activate('Song 3');
  const removed = revised.filter(({ id }) => id !== 'Song 3');
  library.change({ items: removed });
  activate('Song 4');
  library.change({ items: removed.map((item) => item.id === 'Song 4' ? { ...item, title: 'Zebra' } : item) });
  activate('Song 10');
});

test('a scan restores album cards and open album tracks by identity', (t) => {
  const first = audio('first', { album: 'B', track: 1 });
  const second = audio('second', { album: 'B', track: 2 });
  const last = audio('last', { album: 'C', rel: 'C/last.flac' });
  const { doc, host, library, play } = setup(t, { items: [first, second, last] });
  event(text(host, 'Music 3'));
  select(host, 'Music view', 'albums');
  children(host).find((node) => node.title === 'B \u00b7 Artist').focus();
  const earlier = audio('earlier', { album: 'A', rel: 'A/song.flac' });
  library.change({ items: [earlier, first, second, last] });
  assert.equal(doc.activeElement.title, 'B \u00b7 Artist');
  event(doc.activeElement);
  text(host, 'second').parentElement.focus();
  const inserted = audio('added', { album: 'B', track: 1 });
  library.change({ items: [first, second, inserted, last] });
  const row = doc.activeElement;
  assert.equal(dataCells(row)[1].textContent, 'second');
  event(row, 'keydown', { key: 'Enter' });
  const [entries, index] = play.mock.calls[0].arguments;
  assert.equal(entries[index].id, 'second');
  event(text(host, 'Back'));
  assert.equal(doc.activeElement.title, 'B \u00b7 Artist');
  event(doc.activeElement);
  text(host, 'second').parentElement.focus();
  library.change({ items: [last] });
  assert.equal(doc.activeElement.title, 'C \u00b7 Artist');
});

test('a changed snapshot invalidates cached Songs even while an album is open', (t) => {
  const { host, library } = setup(t, { items: [audio('Original')] });
  event(text(host, 'Music 1'));
  select(host, 'Music view', 'songs');
  searchFor(host, 'Search music', 'original');
  assert.equal(dataCells(tableRows(host)[0])[0].textContent, 'Original');
  select(host, 'Music view', 'albums');
  event(cardsOf(host)[0]);
  library.change({ items: [audio('Replacement')], revision: 2 });
  select(host, 'Music view', 'songs');
  assert.ok(text(host, 'No matching songs.'));
  searchFor(host, 'Search music', '');
  assert.equal(dataCells(tableRows(host)[0])[0].textContent, 'Replacement');
});

test('leaving Computer removes listeners and observers and cancels frames, cover work and scanning work', async (t) => {
  const timers = new Map();
  const signals = [];
  const currentPoll = Promise.withResolvers();
  const library = createComputerLibrary({
    loadComputerLibrary: async (_since, { signal }) => {
      signals.push(signal);
      return { items: [audio('Song', { has_cover: true })], folders: saved, revision: 1 };
    },
    computerStatus: ({ signal }) => { signals.push(signal); return currentPoll.promise; },
    startComputerScan: async () => ({ ...idle, scanning: true, phase: 'reading' }),
    setTimeout: (fn) => { timers.set(1, fn); return 1; },
    clearTimeout: (id) => timers.delete(id),
  });
  const loadImage = t.mock.fn((_image, _source, { signal }) => {
    signals.push(signal);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const ui = setup(t, {}, { library, loadImage, listComputerFolders: async () => ({ folders: saved }) });
  await settle();
  event(text(ui.host, 'Music 1'));
  select(ui.host, 'Music view', 'albums');
  await settle();
  assert.equal(loadImage.mock.callCount(), 1);
  assert.equal(timers.size, 1);
  const viewport = klass(ui.host, 'computer-album-scroll');
  event(viewport, 'scroll');
  assert.equal(ui.frames.size, 1);
  const tick = timers.get(1);
  timers.delete(1);
  tick();
  await settle();
  assert.equal(signals.length, 3);
  ui.emit('mode-change', 'library');
  assert.equal(ui.host.children.length, 0);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(getEventListeners(viewport, 'scroll').length, 0);
  assert.equal(getEventListeners(ui.doc, 'keydown').length, 0);
  assert.equal(getEventListeners(ui.win, 'mouseup').length, 0);
  assert.ok([...ui.listeners.values()].every((subscribers) => subscribers.size === 0));
  assert.equal(ui.frames.size, 0);
  assert.equal(ui.observers.size, 0);
  currentPoll.resolve(idle);
  await settle();
  assert.equal(timers.size, 0);
});

function searchFor(host, label, value) {
  const field = labelled(host, label);
  field.value = value;
  event(field, 'input');
}
const cardsOf = (host) => children(host).filter((node) => node.className?.split(' ').includes('computer-album-card'));
const regions = (host, label) => children(host).find((node) => node.getAttribute('role') === 'region' && node.getAttribute('aria-label') === label);
const video = (id, fields = {}) => ({
  id, kind: 'video', title: id, folder: 'music', rel: `Films/${id}.mkv`, duration: 2520, ...fields,
});

test('known offline files in Songs, Albums, Folders and Videos use the transient path before playback', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const songs = [audio('Offline song'), audio('Next song')];
  const film = video('Offline film');
  const { host, library, play } = setup(t, {
    items: [...songs, film], folders: saved.map((folder) => ({ ...folder, available: false })),
  });
  event(text(host, 'Music 2'));
  searchFor(host, 'Search music', '');
  function refuse(row) {
    assert.ok(row.classList.contains('has-error'));
    assert.equal(row.title, 'The folder is not connected.');
    event(row, 'dblclick');
    assert.ok(isVisible(text(host, 'That folder is not connected.')));
    assert.equal(play.mock.callCount(), 0);
  }
  select(host, 'Music view', 'songs');
  refuse(tableRows(host).find((row) => text(row, 'Offline song')));
  select(host, 'Music view', 'albums');
  event(cardsOf(host)[0]);
  refuse(tableRows(host).find((row) => text(row, 'Offline song')));
  select(host, 'Music view', 'folders');
  event(tableRows(host)[0]);
  event(tableRows(host)[0]);
  refuse(tableRows(host).find((row) => text(row, 'Offline song')));
  event(text(host, 'Videos 1'));
  searchFor(host, 'Search videos', '');
  select(host, 'Video view', 'movies');
  refuse(cardsOf(host)[0]);
  select(host, 'Video view', 'videos');
  refuse(tableRows(host)[0]);
  t.mock.timers.tick(5_000);
  assert.equal(text(host, 'That folder is not connected.'), undefined);
  library.change({ folders: saved });
  const row = tableRows(host)[0];
  assert.equal(row.classList.contains('has-error'), false);
  event(row, 'dblclick');
  assert.equal(play.mock.callCount(), 1);
  event(text(host, 'Music 2'));
  select(host, 'Music view', 'albums');
});

test('50 cycles through every Computer view release observers, listeners, frames, artwork and polling', async (t) => {
  const items = [
    audio('Song', { genre: 'Rock', has_cover: true }),
    audio('Book', { ext: 'm4b', album: 'Book', has_cover: true }),
    video('Film'), video('Episode', { season: 1, episode: 1 }),
  ];
  const timers = new Set();
  const scanning = { ...idle, scanning: true, phase: 'reading' };
  const library = createComputerLibrary({
    startComputerScan: async () => scanning,
    computerStatus: async () => scanning,
    loadComputerLibrary: async () => ({ items, folders: saved, revision: 1 }),
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  });
  await library.ensureComputerLibrary();
  const images = new Set();
  const ui = setup(t, {}, {
    library,
    loadImage(image, _source, { signal }) {
      images.add(image);
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        images.delete(image);
        reject(signal.reason);
      }, { once: true }));
    },
  });
  const { host, doc, win, frames, observers, listeners } = ui;
  const viewports = () => [...observers].map(({ node }) => node);
  function assertReleased(viewport) {
    assert.equal(getEventListeners(viewport, 'scroll').length, 0);
    assert.equal(getEventListeners(viewport, 'keydown').length, 0);
  }
  async function visit(action, label) {
    const old = viewports();
    for (const viewport of old) event(viewport, 'scroll');
    action();
    await Promise.resolve();
    for (const viewport of old) assertReleased(viewport);
    assert.equal(frames.size, 0);
    assert.ok(regions(host, label), label);
    assert.ok(viewports().every((viewport) => host.contains(viewport)));
    assert.ok([...images].every((image) => host.contains(image)));
  }
  const choice = (label, value) => () => select(host, label, value);
  const clickText = (name) => () => event(text(host, name));
  const openCard = () => event(cardsOf(host)[0]);
  const openFolder = () => event(tableRows(host)[0]);
  for (let cycle = 0; cycle < 50; cycle++) {
    if (cycle) ui.mount();
    if (!regions(host, 'Albums')) {
      event(text(host, 'Music 1'));
      searchFor(host, 'Search music', '');
      select(host, 'Music view', 'albums');
    }
    await settle();
    assert.equal(timers.size, 1);
    assert.ok(regions(host, 'Albums'));
    await visit(openCard, 'Album tracks');
    await visit(choice('Music view', 'artists'), 'Artists');
    await visit(openCard, 'Artist songs');
    await visit(openCard, 'Album tracks');
    await visit(choice('Music view', 'songs'), 'Songs');
    await visit(choice('Music view', 'genres'), 'Genres');
    await visit(() => event(tableRows(host)[0]), 'Albums');
    await visit(choice('Music view', 'folders'), 'Folders');
    await visit(openFolder, 'Music');
    await visit(openFolder, 'Record');
    event(text(host, 'Videos 2'));
    select(host, 'Video view', 'movies');
    assert.ok(regions(host, 'Movies'));
    openCard();
    assert.ok(labelled(host, 'Movie details'));
    await visit(choice('Video view', 'shows'), 'Shows');
    await visit(openCard, 'Show episodes');
    await visit(choice('Video view', 'videos'), 'Videos');
    await visit(choice('Video view', 'folders'), 'Folders');
    await visit(openFolder, 'Music');
    await visit(openFolder, 'Films');
    await visit(clickText('Audiobooks 1'), 'Audiobooks');
    await visit(openCard, 'Book files');
    await visit(clickText('Favorites 0'), 'Favorites');
    const last = viewports();
    for (const viewport of last) event(viewport, 'scroll');
    ui.emit('mode-change', 'now-playing');
    assert.equal(host.children.length, 0);
    for (const viewport of last) assertReleased(viewport);
    assert.equal(getEventListeners(doc, 'keydown').length, 0);
    assert.equal(getEventListeners(win, 'mouseup').length, 0);
    assert.ok([...listeners.values()].every((subscribers) => subscribers.size === 0));
    for (const resources of [observers, frames, images, timers]) assert.equal(resources.size, 0);
  }
});

test('Songs keeps the latest sort and reuses it across many query changes', (t) => {
  const items = Array.from({ length: 60 }, (_, index) => audio(`Song ${index}`));
  const { host } = setup(t, { items });
  event(text(host, 'Music 60'));
  searchFor(host, 'Search music', '');
  const sort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (...args) {
    if (this.length === items.length) sorts++;
    return sort.apply(this, args);
  };
  t.after(() => { Array.prototype.sort = sort; });
  select(host, 'Music view', 'songs');
  const header = tag(host, 'thead');
  event(text(header, 'Artist'));
  event(text(header, 'Title'));
  assert.equal(sorts, 3);
  for (let query = 0; query < 60; query++) searchFor(host, 'Search music', String(query));
  assert.equal(sorts, 3);
  Array.prototype.sort = sort;
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'albums');
});

test('Artists search names, open albums and songs, and restore both levels of navigation', async (t) => {
  const many = Array.from({ length: 65 }, (_, i) => audio(`Track ${i}`, { artist: `Band ${i}` }));
  const featured = [
    audio('Old song', { artist: 'Guest', album_artist: 'Band 48', album: 'Old', year: 1985 }),
    audio('New song', { artist: 'Band 48', album: 'New', year: 2022, has_cover: true, id: 'new' }),
  ];
  const loadImage = t.mock.fn(async () => {});
  const { host, doc, win, flushFrame, play } = setup(t, { items: [...many, ...featured] }, { loadImage });
  event(text(host, 'Music 67'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'artists');
  searchFor(host, 'Search music', 'guest');
  assert.ok(text(host, 'No matching artists.'));
  searchFor(host, 'Search music', 'band 48');
  assert.equal(cardsOf(host).length, 1);
  assert.ok(text(cardsOf(host)[0], '3 albums · 3 songs'));
  await settle();
  assert.ok(loadImage.mock.calls.some(({ arguments: [, url] }) => url === '/api/v1/computer/art/new'));
  searchFor(host, 'Search music', 'band');
  const artists = regions(host, 'Artists');
  artists.scrollTop = 8 * 242;
  event(artists, 'scroll');
  flushFrame();
  const card = cardsOf(host).find((node) => node.title === 'Band 48');
  card.focus();
  event(card, 'click');
  assert.equal(doc.activeElement.textContent, 'Back');
  assert.deepEqual(cardsOf(host).slice(0, 2).map((node) => klass(node, 'computer-card-title').textContent), ['New', 'Old']);
  assert.deepEqual(tableRows(host).map((row) => dataCells(row)[0].textContent), ['New song', 'Old song', 'Track 48']);
  event(text(host, 'Play all'));
  event(text(host, 'Shuffle'));
  assert.equal(play.mock.calls[0].arguments[0].length, 3);
  assert.deepEqual(play.mock.calls[1].arguments[2], { shuffle: true });
  searchFor(host, 'Search music', 'new song');
  assert.equal(cardsOf(host).length, 1);
  assert.equal(tableRows(host).length, 1);
  regions(host, 'Albums').scrollTop = 12;
  regions(host, 'Artist songs').scrollTop = 7;
  event(cardsOf(host)[0]);
  assert.ok(regions(host, 'Album tracks'));
  event(doc, 'keydown', { key: 'Escape' });
  assert.equal(regions(host, 'Albums').scrollTop, 12);
  assert.equal(regions(host, 'Artist songs').scrollTop, 7);
  assert.equal(klass(doc.activeElement, 'computer-card-title').textContent, 'New');
  assert.equal(labelled(host, 'Search music').value, 'new song');
  event(win, 'mouseup', { button: 3 });
  assert.equal(doc.activeElement.title, 'Band 48');
  assert.equal(regions(host, 'Artists').scrollTop, 8 * 242);
  assert.equal(labelled(host, 'Search music').value, 'band');
});

test('artist songs restore a short scroll range in both layouts when returning from an album', async (t) => {
  for (const compact of [false, true]) {
    await t.test(compact ? 'compact with Back' : 'regular with Escape', (subtest) => {
      const items = Array.from({ length: 12 }, (_, index) => audio(`Song ${index}`));
      const { host, doc, app } = setup(subtest, { items }, {
        matchMedia: () => ({ matches: compact }),
      });
      app.currentItem = makeComputerItem(items[0]);
      const rowHeight = 36;
      const scrollRange = compact ? 52 : 36;
      const createElement = doc.createElement;
      doc.createElement = (tagName) => {
        const node = createElement(tagName);
        if (tagName !== 'div') return node;
        const setAttribute = node.setAttribute.bind(node);
        node.setAttribute = (name, value) => {
          setAttribute(name, value);
          if (name !== 'aria-label' || value !== 'Artist songs') return;
          let top = 0;
          Object.defineProperties(node, {
            clientHeight: { get() {
              // The regular strip takes its height from the grid space.
              const grid = klass(node.parentElement, 'computer-grid-space');
              const extraHeight = compact ? 0 : 74 - (parseInt(grid?.style.height, 10) || 0);
              return (items.length + 1) * rowHeight - scrollRange + extraHeight;
            } },
            scrollTop: {
              get: () => top,
              set(value) {
                const height = tag(node, 'tbody').children.reduce((sum, row) => sum
                  + (row.className === 'computer-spacer' ? parseInt(row.children[0].style.height, 10) : rowHeight), rowHeight);
                top = Math.max(0, Math.min(value, height - node.clientHeight));
              },
            },
          });
        };
        return node;
      };

      searchFor(host, 'Search music', '');
      select(host, 'Music view', 'artists');
      event(cardsOf(host)[0]);
      const songs = regions(host, 'Artist songs');
      songs.scrollTop = 1_000;
      assert.equal(songs.scrollTop, scrollRange);
      assert.ok(tableRows(songs).some((row) => row.getAttribute('aria-current') === 'true'));
      event(cardsOf(host)[0]);
      assert.ok(regions(host, 'Album tracks'));
      if (compact) event(text(host, 'Back'));
      else event(doc, 'keydown', { key: 'Escape' });
      assert.equal(regions(host, 'Artist songs').scrollTop, scrollRange);
      assert.equal(klass(doc.activeElement, 'computer-card-title').textContent, 'Record');
    });
  }
});

test('Genres list multi-tag counts, filter by name, and reopen the filtered position after Back', (t) => {
  const items = Array.from({ length: 30 }, (_, i) => audio(`Song ${i}`, { genre: `Genre ${i}`, album: `Album ${i}` }));
  items[18].genre += ' ; Folk/Pop';
  const { host, doc, flushFrame } = setup(t, { items });
  event(text(host, 'Music 30'));
  searchFor(host, 'Search music', 'pop');
  select(host, 'Music view', 'genres');
  assert.deepEqual(tableRows(host)[0].children.map((cell) => cell.textContent), ['Pop', '1 song']);
  searchFor(host, 'Search music', 'genre');
  const viewport = regions(host, 'Genres');
  viewport.scrollTop = 15 * 36;
  event(viewport, 'scroll');
  flushFrame();
  const row = tableRows(host).find((row) => row.children[0].textContent === 'Genre 18');
  row.focus();
  event(row, 'keydown', { key: 'Enter' });
  assert.equal(doc.activeElement.textContent, 'Back');
  assert.ok(text(host, 'Album 18'));
  searchFor(host, 'Search music', 'absent');
  assert.ok(text(host, 'No matching albums.'));
  event(text(host, 'Back'));
  assert.equal(regions(host, 'Genres').scrollTop, 15 * 36);
  assert.equal(doc.activeElement.children[0].textContent, 'Genre 18');
  assert.equal(labelled(host, 'Search music').value, 'genre');
});

test('Music and video Folders browse direct files, search descendants and keep breadcrumbs and return focus', (t) => {
  const folders = [...saved, { id: 'backup', path: 'E:\\Backup\\Music' }];
  const items = [
    ...Array.from({ length: 30 }, (_, i) => audio(`Track ${i}`, { rel: `Set ${i}/Track ${i}.flac` })),
    audio('Deep track', { rel: 'Set 18/Disc 2/Deep track.flac' }),
    audio('Root track', { rel: 'Root track.flac' }),
    audio('Backup track', { folder: 'backup', rel: 'Backup track.flac' }),
    video('Film'),
  ];
  const { host, doc, win, flushFrame, play } = setup(t, { items, folders });
  event(text(host, 'Music 33'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'folders');
  const roots = tableRows(host);
  assert.equal(klass(host, 'computer-inline-header'), undefined);
  assert.deepEqual(roots.map((row) => row.title), folders.map(({ path }) => path));
  assert.notEqual(klass(roots[0], 'computer-cell-wrap').textContent, klass(roots[1], 'computer-cell-wrap').textContent);
  event(roots[0]);
  assert.equal(doc.activeElement.textContent, 'Back');
  assert.equal(labelled(host, 'Folder path').children.at(-1).getAttribute('aria-current'), 'location');
  searchFor(host, 'Search music', 'disc 2 deep');
  assert.deepEqual(tableRows(host).map((row) => dataCells(row)[0].textContent), ['Deep track']);
  searchFor(host, 'Search music', 'backup');
  assert.ok(text(host, 'No matching songs.'));
  searchFor(host, 'Search music', '');
  const sub = regions(host, 'Music (D:\\Music)');
  sub.scrollTop = 16 * 36;
  event(sub, 'scroll');
  flushFrame();
  const set = tableRows(host).find((row) => row.title.endsWith('Set 18'));
  set.focus();
  assert.ok(text(set, '2 songs'));
  event(set, 'keydown', { key: 'Enter' });
  const [folder, song] = tableRows(host);
  assert.ok(folder.title.endsWith('Disc 2'));
  assert.equal(dataCells(song)[0].textContent, 'Track 18');
  const header = klass(host, 'computer-inline-header');
  assert.deepEqual(header.children.slice(1).map((cell) => cell.textContent),
    ['Title', 'Artist', 'Album', 'Year', 'Length', 'Format']);
  assert.equal(folder.nextElementSibling, header);
  assert.equal(header.nextElementSibling, song);
  folder.focus();
  event(regions(host, 'Set 18'), 'keydown', { key: 'ArrowDown', target: folder });
  assert.equal(doc.activeElement, song, 'arrow navigation skips the file header');
  event(text(host, 'Play folder'));
  assert.deepEqual(play.mock.calls[0].arguments[0].map(({ id }) => id), ['Deep track', 'Track 18']);
  event(folder);
  assert.equal(dataCells(tableRows(host)[0])[0].textContent, 'Deep track');
  assert.equal(klass(host, 'computer-inline-header').nextElementSibling, tableRows(host)[0]);
  event(labelled(host, 'Folder path').children.find((node) => node.textContent === 'Music (D:\\Music)'));
  assert.equal(regions(host, 'Music (D:\\Music)').scrollTop, 16 * 36);
  assert.ok(doc.activeElement.title.endsWith('Set 18'));
  event(win, 'mouseup', { button: 3 });
  assert.equal(doc.activeElement.title, 'D:\\Music');
  event(text(host, 'Videos 1'));
  select(host, 'Video view', 'folders');
  assert.equal(klass(host, 'computer-inline-header'), undefined);
  event(tableRows(host)[0]);
  assert.equal(klass(host, 'computer-inline-header'), undefined);
  searchFor(host, 'Search videos', 'film');
  assert.equal(klass(host, 'computer-inline-header').nextElementSibling, tableRows(host)[0]);
  assert.equal(dataCells(tableRows(host)[0])[0].textContent, 'Film');
  event(text(host, 'Back'));
  assert.equal(doc.activeElement.title, 'D:\\Music');
});

test('Movies sort and search posters, expose details and both play actions, and keep grid focus and scroll', async (t) => {
  const items = Array.from({ length: 42 }, (_, i) => video(`film-${i}`, {
    title: `Film ${i}`, rel: `Films/Film ${i}.mkv`, year: 1970, mtime: i,
  }));
  Object.assign(items[18], {
    year: 2019, duration: 6720, size: 1024, width: 3840, height: 1600, pix_fmt: 'yuv420p10le',
    vcodec: 'hevc', acodec: 'eac3', channels: 6, error: 'Some tags failed',
    audio_tracks: [{ language: 'eng', codec: 'eac3', default: true }, { title: 'Commentary', codec: 'aac', layout: 'Stereo' }],
    subtitle_tracks: [{ language: 'spa' }], subs: ['Films/Film 18.en.srt'],
  });
  items[5].year = 2024;
  const loadImage = t.mock.fn(async () => {});
  const { host, doc, flushFrame, play, app, emit } = setup(t, { items }, { loadImage });
  event(text(host, 'Music 0'));
  searchFor(host, 'Search music', '');
  assert.equal(isVisible(text(host, 'Audiobooks 0')), false);
  event(text(host, 'Videos 42'));
  select(host, 'Video view', 'movies');
  select(host, 'Sort movies', '0');
  assert.equal(klass(cardsOf(host)[0], 'computer-card-title').textContent, 'Film 0');
  for (const [option, title] of [['1', 'Film 5'], ['2', 'Film 41'], ['3', 'Film 18']]) {
    select(host, 'Sort movies', option);
    assert.equal(klass(cardsOf(host)[0], 'computer-card-title').textContent, title);
  }
  searchFor(host, 'Search videos', 'film 18');
  assert.equal(cardsOf(host).length, 1);
  assert.ok(text(cardsOf(host)[0], '2019 · 1 h 52 min'));
  assert.deepEqual(klass(cardsOf(host)[0], 'computer-badges').children.map((node) => node.textContent), ['4K', '10-bit', '5.1']);
  app.settings.showTechnicalDetails = true;
  emit('settings-change');
  assert.ok(text(cardsOf(host)[0], 'HEVC · E-AC-3'));
  select(host, 'Sort movies', '0');
  searchFor(host, 'Search videos', '');
  const viewport = regions(host, 'Movies');
  viewport.scrollTop = 3 * 322;
  event(viewport, 'scroll');
  flushFrame();
  const card = cardsOf(host).find((node) => text(node, 'Film 18'));
  card.focus();
  assert.ok(card.classList.contains('has-error'));
  assert.equal(card.title, 'Some tags failed');
  event(card);
  assert.equal(card.getAttribute('aria-pressed'), 'true');
  const side = labelled(host, 'Movie details');
  for (const value of ['1 KB', '3840 × 1600 · 4K', 'HEVC · E-AC-3', 'eng · E-AC-3 · 5.1',
    'Commentary · AAC · Stereo', 'spa', 'Film 18.en.srt', 'Films/Film 18.mkv']) {
    assert.ok(text(side, value), value);
  }
  await settle();
  assert.ok(loadImage.mock.callCount() > 0, 'the surrounding movies still load artwork');
  assert.ok(loadImage.mock.calls.every(({ arguments: [, url] }) => !url.startsWith('/api/v1/computer/art/film-18')));
  assert.ok(klass(card, 'placeholder'));
  assert.ok(klass(side, 'placeholder'));
  assert.equal(tag(card, 'img'), undefined);
  assert.equal(tag(side, 'img'), undefined);
  event(card, 'dblclick');
  event(card, 'keydown', { key: 'Enter' });
  event(text(side, 'Play'));
  event(text(side, 'Play from the beginning'));
  assert.deepEqual(play.mock.calls.map(({ arguments: [entries, index, options] }) =>
    [entries[index].title, options]), [
    ['Film 18', undefined], ['Film 18', undefined], ['Film 18', undefined], ['Film 18', { startAt: 0 }],
  ]);
  text(side, 'Back').focus();
  doc.querySelector = () => side;
  assert.equal(event(doc, 'keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.ok(text(side, 'Back'));
  doc.querySelector = () => null;
  event(doc, 'keydown', { key: 'Escape' });
  assert.equal(doc.activeElement.title, 'Some tags failed');
  assert.equal(regions(host, 'Movies').scrollTop, 3 * 322);
  assert.equal(doc.activeElement.getAttribute('aria-pressed'), 'false');
  assert.ok(text(side, 'Select a movie.'));
});

test('Shows search cleaned names and episode titles, and play through the following seasons', (t) => {
  const episodes = [
    video('s2', { title: 'Test Show', episode_title: '', rel: 'Test.Show.S02E01.720p.mkv', season: 2, episode: 1 }),
    video('s1e3', { title: 'Later', rel: 'Test.Show.S01E03.mkv', season: 1, episode: 3 }),
    video('s1e2', { title: 'E03 Pilot', episode_title: 'Pilot', rel: 'Test.Show.S01E02E03.Pilot.mkv', season: 1, episode: 2 }),
  ];
  const filler = Array.from({ length: 30 }, (_, i) => video(`show-${i}`, { title: `Extra Show ${i}`, season: 1, episode: 1 }));
  const { host, doc, play, library, flushFrame } = setup(t, { items: [...episodes, ...filler, video('Film')] });
  event(text(host, 'Videos 34'));
  searchFor(host, 'Search videos', '');
  select(host, 'Video view', 'shows');
  searchFor(host, 'Search videos', 'pilot');
  assert.ok(text(host, 'No matching shows.'));
  searchFor(host, 'Search videos', 'test show');
  assert.equal(cardsOf(host).length, 1);
  assert.ok(text(cardsOf(host)[0], '2 seasons · 3 episodes'));
  searchFor(host, 'Search videos', 'show');
  const shows = regions(host, 'Shows');
  shows.scrollTop = 4 * 302;
  event(shows, 'scroll');
  flushFrame();
  event(cardsOf(host).find((card) => card.title === 'Test Show'));
  assert.ok(text(host, 'Season 1'));
  assert.ok(text(host, 'Season 2'));
  assert.equal(doc.activeElement.textContent, 'Back');
  const pilot = tableRows(host).find((row) => dataCells(row)[0].textContent === 'S01E02-E03');
  assert.equal(dataCells(pilot)[1].textContent, 'Pilot');
  assert.equal(dataCells(pilot)[2].textContent, '42 min');
  const untitled = tableRows(host).find((row) => dataCells(row)[0].textContent === 'S02E01');
  assert.equal(dataCells(untitled)[1].textContent, '');
  assert.ok(labelled(untitled, 'Play Test Show · S02E01'));
  event(labelled(host, 'Play Later'));
  assert.deepEqual(play.mock.calls[0].arguments.slice(0, 2), [[episodes[2], episodes[1], episodes[0]], 1]);
  searchFor(host, 'Search videos', 'pilot');
  assert.equal(tableRows(host).length, 2, 'one season heading and one episode');
  event(labelled(host, 'Play Pilot'));
  assert.deepEqual(play.mock.calls[1].arguments.slice(0, 2), [[episodes[2], episodes[1], episodes[0]], 0]);
  event(text(host, 'Back'));
  assert.equal(doc.activeElement.title, 'Test Show');
  assert.equal(labelled(host, 'Search videos').value, 'show');
  assert.equal(regions(host, 'Shows').scrollTop, 4 * 302);
  searchFor(host, 'Search videos', '');
  library.change({ items: [video('Film')] });
  assert.ok(text(host, 'No shows found.'));
});

test('Audiobooks search by title and author, show chapter and part lists, and hide their empty chip', (t) => {
  const book = audio('book', {
    title: 'Book file', album: 'A Book', artist: 'The Author', ext: 'm4b', composer: 'The Narrator',
    duration: 29520, chapters: [{ start: 180, title: 'Second' }, { start: 0, title: 'First' }],
  });
  const parts = [audio('Part 2', { album: 'Other Book', genre: 'Audiobook', track: 2 }),
    audio('Part 1', { album: 'Other Book', genre: 'Audiobook', track: 1 })];
  const filler = Array.from({ length: 30 }, (_, i) => audio(`book-${i}`, { album: `Background Book ${i}`, ext: 'm4b' }));
  const { host, doc, play, library, flushFrame } = setup(t, { items: [book, ...parts, ...filler] });
  event(text(host, 'Audiobooks 33'));
  searchFor(host, 'Search audiobooks', 'the author');
  assert.equal(cardsOf(host).length, 1);
  assert.ok(text(cardsOf(host)[0], '8 h 12 min'));
  event(cardsOf(host)[0]);
  assert.equal(doc.activeElement.textContent, 'Back');
  assert.ok(text(host, 'Narrator The Narrator'));
  assert.deepEqual(tableRows(host).map((row) => row.children.slice(0, 3).map((cell) => cell.textContent)), [
    ['1', 'First', '0:00'], ['2', 'Second', '3:00'],
  ]);
  event(text(host, 'Play'));
  searchFor(host, 'Search audiobooks', 'second');
  assert.equal(tableRows(host).length, 1);
  event(tableRows(host)[0], 'keydown', { key: 'Enter' });
  const bookKey = '["a book","the author"]';
  assert.deepEqual(play.mock.calls[0].arguments, [[book], 0, { bookKey }]);
  assert.deepEqual(play.mock.calls[1].arguments, [[book], 0, { bookKey, startAt: 180 }]);
  event(text(host, 'Back'));
  assert.equal(doc.activeElement.title, 'A Book · The Author');
  assert.equal(labelled(host, 'Search audiobooks').value, 'the author');
  searchFor(host, 'Search audiobooks', 'book');
  const books = regions(host, 'Audiobooks');
  books.scrollTop = 4 * 242;
  event(books, 'scroll');
  flushFrame();
  event(cardsOf(host).find((card) => text(card, 'Other Book')));
  assert.ok(regions(host, 'Book files'));
  assert.deepEqual(tableRows(host).map((row) => dataCells(row)[0].textContent), ['Part 1', 'Part 2']);
  event(tableRows(host)[1], 'dblclick');
  assert.deepEqual(play.mock.calls[2].arguments.slice(0, 2), [[parts[1], parts[0]], 1]);
  event(text(host, 'Back'));
  assert.ok(text(doc.activeElement, 'Other Book'));
  assert.equal(regions(host, 'Audiobooks').scrollTop, 4 * 242);
  searchFor(host, 'Search audiobooks', '');
  library.change({ items: [audio('Only music')] });
  assert.ok(text(host, 'No audiobooks found.'));
  assert.equal(isVisible(text(host, 'Audiobooks 0')), false);
  assert.equal(isVisible(text(host, 'Videos 0')), false);
  assert.equal(isVisible(text(host, 'Music 1')), true);
  event(text(host, 'Music 1'));
  select(host, 'Music view', 'albums');
});

test('a short artist page windows one sideways row of albums and keeps 36px song rows', (t) => {
  const items = Array.from({ length: 100 }, (_, index) => audio(`Song ${index}`, {
    album: `Record ${index}`, duration: 240, year: 2021,
  }));
  const compact = { matches: true };
  const { host, doc, observers } = setup(t, { items }, {
    matchMedia(query) {
      assert.equal(query, '(height < 760px)');
      return compact;
    },
  });
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'artists');
  event(cardsOf(host)[0]);
  const albums = regions(host, 'Albums');
  const row = klass(albums, 'computer-album-grid');
  assert.equal(row.style.gridTemplateColumns, '');
  assert.equal(row.style.gridAutoColumns, '170px');
  assert.ok(cardsOf(albums).length < 12);
  cardsOf(albums)[0].focus();
  event(albums, 'keydown', { key: 'ArrowRight', target: doc.activeElement });
  assert.equal(klass(doc.activeElement, 'computer-card-title').textContent, 'Record 1');
  event(albums, 'keydown', { key: 'End', target: doc.activeElement });
  assert.ok(albums.scrollLeft > 0);
  assert.equal(albums.scrollTop, 0);
  assert.equal(klass(doc.activeElement, 'computer-card-title').textContent, 'Record 99');
  const left = albums.scrollLeft;
  event(doc.activeElement);
  event(text(host, 'Back'));
  const restored = regions(host, 'Albums');
  assert.equal(restored.scrollLeft, left);
  assert.equal(klass(doc.activeElement, 'computer-card-title').textContent, 'Record 99');

  const css = readFileSync(new URL('../src/styles/computer.css', import.meta.url), 'utf8');
  assert.match(css, /\.computer-card-facts\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*white-space:\s*normal;/);
  assert.match(css, /\.computer-artist-albums\s*\{[^}]*max-height: calc\(var\(--computer-artist-card-height\) \* 2 \+ 12px\);[^}]*overflow-y: auto;/);
  assert.match(css, /@media \(height < 760px\)[\s\S]*\.computer-artist-albums \.computer-album-grid \{ grid-auto-flow: column; \}/);
  assert.match(css, /\.computer-artist-page \.computer-artist-albums \{\s*--computer-artist-card-height: 52px;\s*flex-basis: calc\(var\(--computer-artist-card-height\) \+ 8px\);/);
  const songs = regions(host, 'Artist songs');
  assert.match(css, /\.computer-table :is\(th, td\)\s*\{[^}]*height: 36px;/);
  assert.doesNotMatch(css, /@media \(height < 760px\)[\s\S]*\.computer-artist-page \.computer-table[^\n]*height:/);
  songs.clientHeight = 36 * 7; // Column header and six complete song rows.
  [...observers].find(({ node }) => node === songs).resize();
  assert.equal(tableRows(host)[5].getAttribute('aria-rowindex'), '7');
  assert.equal(tag(songs, 'tbody').children.at(-1).children[0].style.height, `${93 * 36}px`);

  compact.matches = false;
  [...observers].find(({ node }) => node === restored).resize();
  assert.match(klass(restored, 'computer-album-grid').style.gridTemplateColumns, /^repeat\(\d+, minmax\(0, 224px\)\)$/);
});

test('50,000 files in Artists and Folders create only visible cards and rows, including at the end', (t) => {
  const items = Array.from({ length: 50_000 }, (_, index) => audio(`Song ${index}`, {
    rel: `All/Song ${index}.flac`, artist: 'One Artist', album: `Record ${index}`,
  }));
  const { host, doc, flushFrame, library } = setup(t, { items: [] });
  // Mount the large fixture only after choosing Artists so the album view does not precompute it.
  event(text(host, 'Music 0'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'artists');
  const create = t.mock.method(doc, 'createElement');
  library.change({ items });
  assert.ok(create.mock.callCount() < 400);
  event(cardsOf(host)[0]);
  assert.ok(cardsOf(host).length <= 36);
  assert.ok(tableRows(host).length < 15);
  const artistSongs = regions(host, 'Artist songs');
  artistSongs.scrollTop = 1_800_000;
  event(artistSongs, 'scroll');
  flushFrame();
  assert.equal(dataCells(tableRows(host).at(-1))[0].textContent, 'Song 49999');
  assert.ok(tableRows(host).length < 15);
  select(host, 'Music view', 'folders');
  event(tableRows(host)[0]);
  event(tableRows(host)[0]);
  assert.equal(tag(host, 'table').getAttribute('aria-rowcount'), '50001');
  assert.ok(tableRows(host).length < 15);
  const folder = regions(host, 'All');
  folder.scrollTop = 1_800_000;
  event(folder, 'scroll');
  flushFrame();
  assert.equal(dataCells(tableRows(host).at(-1))[0].textContent, 'Song 49999');
  assert.ok(tableRows(host).length < 15);
  assert.ok(create.mock.callCount() < 1600);
});

test('typing five characters reuses sort orders and search keys in 50,000-file views', (t) => {
  const items = Array.from({ length: 50_000 }, (_, index) => audio(`Track ${index}`, {
    artist: 'Track Artist', album: `Record ${index % 25}`, rel: `Tracks/Track ${index}.flac`,
  }));
  const { host, library } = setup(t, { items: [] });
  event(text(host, 'Music 0'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'songs');
  library.change({ items });
  const nativeNormalize = String.prototype.normalize;
  let keyBuilds = 0;
  let sorts = 0;
  const nativeSort = Array.prototype.sort;

  function type() {
    const input = labelled(host, 'Search music');
    input.focus();
    searchFor(host, 'Search music', 't');
    keyBuilds = sorts = 0;
    for (const query of ['tr', 'tra', 'trac', 'track']) searchFor(host, 'Search music', query);
    assert.equal(sorts, 0);
    assert.equal(keyBuilds, 0);
    searchFor(host, 'Search music', '');
  }

  t.mock.method(String.prototype, 'normalize', function (...args) {
    if (this.length > 5) keyBuilds++;
    return nativeNormalize.apply(this, args);
  });
  Array.prototype.sort = function (...args) {
    sorts++;
    return nativeSort.apply(this, args);
  };
  t.after(() => { Array.prototype.sort = nativeSort; });
  type();
  select(host, 'Music view', 'artists');
  type();
  event(cardsOf(host)[0]);
  type();
  select(host, 'Music view', 'folders');
  type();
});

test('opening from Library goes directly to an album, video folder or audiobook', (t) => {
  const song = audio('Deep track', { album: 'Deep record', rel: 'Deep record/CD 1/Track.flac' });
  const video = { id: 'film', title: 'Deep film', kind: 'video', folder: 'music', rel: 'Deep folder/Film.mp4' };
  const book = audio('Deep part', { album: 'Deep book', rel: 'Books/Part.m4b', ext: 'm4b' });
  const items = [song, video, book];
  const albumPage = setup(t, { items }, { entry: song });
  assert.ok(text(albumPage.host, 'Deep record'));
  assert.ok(text(albumPage.host, 'Deep track'));
  const folderPage = setup(t, { items }, { entry: video });
  assert.ok(text(folderPage.host, 'Deep folder'));
  assert.ok(text(folderPage.host, 'Deep film'));
  event(text(folderPage.host, 'Music'));
  assert.ok(text(folderPage.host, 'Deep folder'), 'the parent breadcrumb opens the approved root');
  const bookPage = setup(t, { items }, { entry: book });
  assert.ok(text(bookPage.host, 'Deep book'));
  assert.ok(text(bookPage.host, 'Deep part'));
});

test('reopening Computer restores the artist detail search and scroll, then falls back when it is gone', (t) => {
  const tracks = Array.from({ length: 30 }, (_, index) => audio(`A song ${index}`));
  const { host, mount, emit, library } = setup(t, { items: tracks });
  event(text(host, 'Music 30'));
  select(host, 'Music view', 'artists');
  searchFor(host, 'Search music', 'artist');
  event(cardsOf(host)[0]);
  searchFor(host, 'Search music', 'song');
  regions(host, 'Artist songs').scrollTop = 300;
  emit('mode-change', 'now-playing');
  mount();
  assert.equal(regions(host, 'Artist songs').scrollTop, 300);
  assert.equal(labelled(host, 'Search music').value, 'song');
  emit('mode-change', 'now-playing');
  library.change({ items: [audio('Replacement', { artist: 'New artist' })] });
  mount();
  assert.ok(regions(host, 'Artists'));
  assert.equal(labelled(host, 'Search music').value, 'artist');
  searchFor(host, 'Search music', '');
});

test('album cards reserve two title lines and Library uses one high-contrast starred style', () => {
  const computer = readFileSync(new URL('../src/styles/computer.css', import.meta.url), 'utf8');
  const library = readFileSync(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  assert.match(computer, /\.computer-card-body\s*\{[^}]*grid-template-rows: 32px 14px 26px;/);
  assert.match(computer, /\.computer-album-grid[^\n]*\.computer-card-body\s*\{[^}]*row-gap: 1px;/);
  assert.match(library, /\.card-star\.is-fav\s*\{[^}]*color: var\(--accent\);[^}]*background: var\(--bg-elev-1\);/);
});

test('short albums share duration formatting, omit varying bitrate and hide the redundant artist', (t) => {
  const items = [101, 106, 108].map((rate) => audio('Long track title ' + rate, {
    acodec: 'mp3', bitrate: rate * 1000, sample_rate: 44100, channels: 2, duration: 13,
    error: 'Tags could not be read.',
  }));
  const { host } = setup(t, { items });
  event(text(host, 'Music 3'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'albums');
  const [card] = cardsOf(host);
  assert.equal(card.title, 'Tags could not be read.');
  assert.equal(klass(card, 'computer-card-title').title, 'Record');
  assert.equal(klass(card, 'computer-card-facts').title, '3 songs · 39 s');
  event(card);
  assert.ok(text(host, '3 songs · 39 s'));
  assert.ok(text(host, 'MP3 · 44.1 kHz · Stereo'));
  assert.deepEqual(tag(host, 'thead').children[0].children.map((cell) => cell.textContent).filter(Boolean), ['Track', 'Title', 'Length']);
  const row = tableRows(host)[0];
  assert.equal(row.title, 'Tags could not be read.');
  assert.equal(klass(row, 'computer-cell-wrap').title, items[0].title);
});

async function favoriteStorage(t, records, { failRead = false } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const favorites = getState().favorites;
  const settings = getState().settings;
  const values = new Map();
  const writes = new Map();
  const server = fakeComputerStars(records);
  server.failRead = failRead;
  resetControlSession();
  globalThis.fetch = server.fetch;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      writes.set(key, (writes.get(key) || 0) + 1);
    },
    removeItem: (key) => values.delete(key),
  } });
  await initState();
  await loadComputerStars();
  t.after(async () => {
    await settle();
    getState().favorites = favorites;
    getState().settings = settings;
    resetControlSession();
    globalThis.fetch = originalFetch;
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    clearPersistenceFailure('computer-stars');
    clearPersistenceFailure('favorites');
  });
  return { values, writes, server };
}

function rowStar(region, title) {
  const row = tableRows(region).find((candidate) => dataCells(candidate).some((cell) => cell.textContent === title));
  const star = klass(row.children[0], 'computer-star');
  assert.equal(star.tagName, 'BUTTON');
  assert.equal(star.title, 'Favorite (F)');
  return star;
}

test('file stars work in Computer rows and cards without opening or playing them', async (t) => {
  await favoriteStorage(t);
  const song = audio('Song', { rel: 'Song.flac' });
  const film = video('Film', { ext: 'mkv' });
  const episode = video('Pilot', { rel: 'Series.S01E02.Pilot.mkv', season: 1, episode: 2 });
  const solo = audio('Solo book', { album: 'Solo book', ext: 'm4b' });
  const parts = [1, 2].map((track) => audio(`Part ${track}`, { album: 'Parts', ext: 'm4b', track }));
  const { host, doc, play } = setup(t, { items: [song, film, episode, solo, ...parts] }, { appState: getState });
  event(text(host, 'Music 1'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'songs');

  const row = tableRows(host)[0];
  const star = rowStar(host, 'Song');
  const viewport = regions(host, 'Songs');
  const pressed = (button) => button.getAttribute('aria-pressed');
  assert.equal(star.getAttribute('aria-label'), 'Add Song to favorites');
  star.focus();
  viewport.scrollTop = 6;
  assert.equal(event(star).cancelBubble, true);
  const bubbled = t.mock.fn();
  row.addEventListener('dblclick', bubbled);
  const icon = doc.createElement('svg');
  star.append(icon);
  assert.equal(event(icon, 'dblclick').cancelBubble, true);
  assert.equal(bubbled.mock.callCount(), 0);
  assert.equal(play.mock.callCount(), 0);
  event(dataCells(row)[0], 'dblclick');
  assert.equal(bubbled.mock.callCount(), 1);
  assert.equal(play.mock.callCount(), 1);
  play.mock.resetCalls();
  assert.equal(pressed(star), 'true');
  assert.equal(isFavorite('computer:Song'), true);
  assert.equal(getState().favorites[0]._extra.computer.id, 'Song');
  assert.equal(star.getAttribute('aria-label'), 'Remove Song from favorites');
  assert.equal(tableRows(host)[0], row);
  assert.equal(doc.activeElement, star);
  assert.equal(viewport.scrollTop, 6);
  assert.ok(text(host, 'Favorites 1'));
  removeFavorite('computer:Song');
  assert.equal(pressed(star), 'false');
  assert.equal(tableRows(host)[0], row);
  assert.equal(doc.activeElement, star);

  row.focus();
  doc.querySelector = (selector) => selector === 'dialog[open]' ? {} : null;
  assert.equal(event(doc, 'keydown', { key: 'F' }).defaultPrevented, false);
  doc.querySelector = () => null;
  assert.equal(event(doc, 'keydown', { key: 'F', isComposing: true }).defaultPrevented, false);
  assert.equal(event(doc, 'keydown', { key: 'F', repeat: true }).defaultPrevented, false);
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    row.focus();
    event(doc, 'keydown', { key: 'F', [modifier]: true });
    assert.equal(pressed(star), 'false', modifier);
  }
  labelled(host, 'Search music').focus();
  assert.equal(event(doc, 'keydown', { key: 'F' }).defaultPrevented, false);
  row.focus();
  assert.equal(event(doc, 'keydown', { key: 'F' }).defaultPrevented, true);
  assert.equal(pressed(star), 'true');

  select(host, 'Music view', 'albums');
  event(cardsOf(host)[0]);
  assert.equal(pressed(rowStar(regions(host, 'Album tracks'), 'Song')), 'true');
  event(text(host, 'Back'));
  select(host, 'Music view', 'artists');
  event(cardsOf(host)[0]);
  const artistStar = labelled(host, 'Remove artist from favorites');
  event(artistStar);
  assert.equal(pressed(rowStar(regions(host, 'Artist songs'), 'Song')), 'false');
  event(artistStar);
  assert.equal(pressed(rowStar(regions(host, 'Artist songs'), 'Song')), 'true');

  select(host, 'Music view', 'folders');
  const rootFolder = tableRows(host)[0];
  assert.equal(klass(rootFolder, 'computer-star'), undefined);
  event(rootFolder);
  assert.equal(pressed(rowStar(host, 'Song')), 'true');

  event(text(host, 'Videos 2'));
  select(host, 'Video view', 'movies');
  const [movie] = cardsOf(host);
  const movieStar = klass(movie.parentElement, 'computer-star');
  assert.equal(movie.parentElement, movieStar.parentElement, 'the star is a sibling of the card button');
  movie.focus();
  assert.equal(event(doc, 'keydown', { key: 'f' }).defaultPrevented, true);
  assert.equal(pressed(movieStar), 'true');
  assert.equal(movie.getAttribute('aria-pressed'), 'false');
  event(movieStar);
  assert.equal(pressed(movieStar), 'false');
  assert.equal(event(movieStar, 'dblclick').cancelBubble, true);
  assert.equal(movie.getAttribute('aria-pressed'), 'false');

  select(host, 'Video view', 'videos');
  event(rowStar(host, 'Film'));
  assert.equal(isFavorite('computer:Film'), true);
  select(host, 'Video view', 'shows');
  event(cardsOf(host)[0]);
  const showStar = labelled(host, 'Add show to favorites');
  const episodeStar = rowStar(host, 'Pilot');
  event(showStar);
  assert.equal(pressed(episodeStar), 'true');
  event(episodeStar);
  assert.equal(pressed(showStar), 'false');
  select(host, 'Video view', 'folders');
  event(tableRows(host)[0]);
  searchFor(host, 'Search videos', 'Film');
  assert.equal(pressed(rowStar(host, 'Film')), 'true');

  event(text(host, 'Audiobooks 3'));
  searchFor(host, 'Search audiobooks', '');
  const soloCard = cardsOf(host).find((card) => text(card, 'Solo book'));
  const soloStar = klass(soloCard.parentElement, 'computer-star');
  event(soloStar);
  assert.equal(isFavorite('computer:Solo book'), true);
  event(soloCard);
  assert.equal(pressed(rowStar(host, 'Solo book')), 'true');
  event(text(host, 'Back'));
  event(cardsOf(host).find((card) => text(card, 'Parts')));
  event(rowStar(host, 'Part 2'));
  assert.equal(isFavorite('computer:Part 2'), true);
  assert.equal(play.mock.callCount(), 0);
});

test('an album star adds and removes all 200 tracks with one server call and event per action', async (t) => {
  const { writes, server } = await favoriteStorage(t);
  const tracks = Array.from({ length: 200 }, (_, index) => audio(`Track ${index + 1}`, { track: index + 1 }));
  const { host, doc } = setup(t, { items: tracks }, { appState: getState });
  event(text(host, 'Music 200'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'albums');
  event(cardsOf(host)[0]);
  const star = labelled(host, 'Add album to favorites');
  const row = tableRows(host)[0];
  const first = rowStar(host, 'Track 1');
  const change = t.mock.fn();
  t.after(subscribe('favorites-change', change));
  star.focus();
  event(star);
  assert.ok(doc.activeElement === star, 'the album star retains focus');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(event(first, 'dblclick').cancelBubble, true);
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  assert.ok(tableRows(host)[0] === row, 'the first row is reused');
  assert.ok(text(host, 'Favorites 200'));
  await settle();
  assert.equal(server.requests.at(-1).add.length, 200);
  assert.equal(writes.get(STORAGE_KEYS.favorites), undefined);
  assert.equal(change.mock.callCount(), 1);
  event(star);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(first.getAttribute('aria-pressed'), 'false');
  assert.ok(tableRows(host)[0] === row, 'the first row is reused');
  assert.ok(text(host, 'Favorites 0'));
  assert.equal(getState().favorites.length, 0);
  await settle();
  assert.equal(server.requests.at(-1).remove.length, 200);
  assert.equal(writes.get(STORAGE_KEYS.favorites), undefined);
  assert.equal(change.mock.callCount(), 2);
});

test('Favorites shows the same album track order before and after the star write', async (t) => {
  const { server } = await favoriteStorage(t);
  const tracks = [1, 2, 3].map((track) => audio('Track ' + track, { track }));
  const { host } = setup(t, { items: tracks }, { appState: getState });
  event(text(host, 'Music 3'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'albums');
  event(cardsOf(host)[0]);
  event(labelled(host, 'Add album to favorites'));
  event(text(host, 'Favorites 3'));
  const order = () => tableRows(host).map((row) =>
    dataCells(row).map((cell) => cell.textContent).find((label) => label.startsWith('Track ')));
  assert.deepEqual(order(), tracks.map(({ title }) => title));
  assert.deepEqual(server.requests, [{ method: 'GET' }]);
  await settle();
  assert.equal(server.requests.at(-1).method, 'POST');
  assert.deepEqual(order(), tracks.map(({ title }) => title));
});

test('Favorites uses star order, searches, queues playable files and keeps missing favorites removable', async (t) => {
  const { values, server } = await favoriteStorage(t);
  t.after(clearComputerQueue);
  const song = audio('Song');
  const film = video('Film', { ext: 'mkv' });
  const offline = audio('Drive track', { folder: 'drive', album: 'Old record', artist: 'Old artist' });
  const removed = audio('Deleted track');
  for (const entry of [song, film, offline, removed]) assert.equal(addFavorite(makeComputerItem(entry)), true);
  assert.equal(moveFavorite('computer:Song', 'top'), false);
  addFavorite({ id: 'radio:test', source: 'radio', title: 'Station', type: 'radio' });

  const play = t.mock.fn(async (_item, { computerQueue }) => setComputerQueue(computerQueue));
  const { host, doc, library } = setup(t, {
    items: [song, film, { ...offline, duration: 222, duration_estimated: true }],
    folders: [...saved, { id: 'drive', path: 'E:\\Music', available: false }],
  }, {
    appState: getState,
    play: (entries, index, opts) => playComputerEntries(entries, index, { ...opts, play, random: () => 0 }),
  });
  event(text(host, 'Favorites 4'));
  searchFor(host, 'Search favorites', '');
  const titles = () => tableRows(host).map((row) => klass(row, 'computer-cell-wrap').textContent);
  assert.deepEqual(titles(), ['Deleted track', 'Drive track', 'Film', 'Song']);
  assert.equal(tableRows(host)[0].classList.contains('has-error'), true);
  assert.ok(text(tableRows(host)[0], 'Not found'));
  assert.equal(text(tableRows(host)[1], 'Not connected').title, 'The folder is not connected.');
  assert.equal(tableRows(host)[1].title, 'The folder is not connected.');
  event(tableRows(host)[1], 'dblclick');
  assert.ok(isVisible(text(host, 'That folder is not connected.')));
  assert.equal(play.mock.callCount(), 0);
  assert.equal(dataCells(tableRows(host)[1])[1].textContent, 'Old artist');
  assert.equal(dataCells(tableRows(host)[1])[2].textContent, 'Old record');
  assert.equal(dataCells(tableRows(host)[1])[3].textContent, '~3:42');
  assert.equal(dataCells(tableRows(host)[1])[4].textContent, 'FLAC');
  assert.equal(dataCells(tableRows(host)[2])[4].textContent, 'Movie \u00b7 MKV');
  const missing = tableRows(host)[0];
  for (const activate of [
    () => event(missing, 'keydown', { key: 'Enter' }),
    () => event(missing, 'dblclick'),
    () => event(labelled(missing, 'Play Deleted track')),
  ]) {
    activate();
    const message = text(host, 'That file is no longer there.');
    assert.ok(isVisible(message));
    message.textContent = '';
    assert.equal(play.mock.callCount(), 0);
    assert.equal(computerQueueState(), null);
  }

  event(text(host, 'Play all'));
  assert.deepEqual(computerQueueState().entries, [film, song]);
  assert.equal(play.mock.calls.at(-1).arguments[0].id, 'computer:Film');
  event(tableRows(host)[2], 'dblclick');
  await moveComputerQueue(1);
  assert.equal(play.mock.calls.at(-1).arguments[0].id, 'computer:Song');
  event(tableRows(host)[3], 'keydown', { key: 'Enter' });
  assert.equal(computerQueueState().index, 1);

  const rng = t.mock.method(Math, 'random', () => 0.99);
  event(text(host, 'Shuffle'));
  rng.mock.restore();
  assert.deepEqual(computerQueueState().entries, [song, film]);
  assert.equal(computerQueueState().index, 0);
  searchFor(host, 'Search favorites', 'old artist');
  assert.deepEqual(titles(), ['Drive track']);
  assert.equal(text(host, 'Play all').disabled, true);
  assert.equal(text(host, 'Shuffle').disabled, true);
  searchFor(host, 'Search favorites', '');
  const [deletedRow, driveRow, filmRow] = tableRows(host);
  assert.equal(deletedRow.title, 'Not found');
  assert.equal(klass(deletedRow, 'computer-cell-wrap').title, 'Deleted track');
  const deletedStar = labelled(deletedRow, 'Remove Deleted track from favorites');
  const driveStar = labelled(driveRow, 'Remove Drive track from favorites');
  deletedStar.focus();
  event(deletedStar);
  assert.deepEqual(titles(), ['Drive track', 'Film', 'Song']);
  assert.ok(tableRows(host)[0] === driveRow, 'expected the same row or focused control');
  assert.ok(tableRows(host)[1] === filmRow, 'expected the same row or focused control');
  assert.ok(doc.activeElement === driveStar, 'expected the same row or focused control');
  assert.equal(filmRow.getAttribute('aria-rowindex'), '3');
  assert.ok(text(host, 'Favorites 3'));

  library.change({ items: [song, film, { ...offline, duration: 210 }], folders: [] });
  assert.equal(tableRows(host).every((row) => row.classList.contains('has-error')), true);
  assert.equal(dataCells(tableRows(host)[0])[3].textContent, '3:30');

  library.change({ items: [song, film] });
  assert.equal(dataCells(tableRows(host)[0])[3].textContent, '3:00');
  assert.ok(isVisible(text(host, 'Favorites 3')));
  const diskItems = JSON.parse(values.get(STORAGE_KEYS.favorites));
  assert.deepEqual(diskItems.map(({ id }) => id), ['radio:test']);
  await settle();
  const { snap } = server.stars.get('Drive track');
  assert.equal(snap.format, 'FLAC');
  assert.equal(snap.formatDetails, undefined);
  assert.equal(snap.title, 'Drive track');
});

test('Favorites search reuses the resolved order for 10,000 stars', async (t) => {
  const records = Array.from({ length: 10_000 }, (_, seq) => ({
    id: `song-${seq}`, seq, t: 10, snap: { title: `Song ${seq}`, kind: 'audio' },
  }));
  await favoriteStorage(t, records);
  const { host } = setup(t, {}, { appState: getState });
  event(text(host, 'Favorites 10,000'));
  searchFor(host, 'Search favorites', '');
  assert.equal(tag(host, 'table').getAttribute('aria-rowcount'), '10001');
  assert.ok(tableRows(host).length < 30);
  const sort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (...args) { sorts++; return sort.apply(this, args); };
  try {
    for (const query of ['s', 'so', 'son', 'song', 'song 9999']) searchFor(host, 'Search favorites', query);
  } finally {
    Array.prototype.sort = sort;
  }
  assert.equal(sorts, 0);
  assert.equal(tableRows(host).length, 1);
  assert.ok(text(tableRows(host)[0], 'Song 9999'));
});

test('Favorites moves focus to search or the chip when the focused last result is unstarred', async (t) => {
  await favoriteStorage(t);
  const item = audio('One');
  const another = audio('Two');
  addFavorite(makeComputerItem(item));
  addFavorite(makeComputerItem(another));
  const { host, doc, library } = setup(t, { items: [item, another] }, { appState: getState });
  event(text(host, 'Music 2'));
  library.refreshAvailability.mock.resetCalls();
  const chip = text(host, 'Favorites 2');
  event(chip);
  assert.equal(library.refreshAvailability.mock.callCount(), 1);
  searchFor(host, 'Search favorites', 'One');
  const one = rowStar(host, 'One');
  one.focus();
  event(one);
  assert.ok(doc.activeElement === labelled(host, 'Search favorites'), 'expected the same row or focused control');
  searchFor(host, 'Search favorites', '');
  const two = rowStar(host, 'Two');
  two.focus();
  event(two);
  assert.ok(doc.activeElement === chip, 'expected the same row or focused control');
  assert.equal(chip.textContent, 'Favorites 0');
});

test('Favorites shows failed loads, retries on reopen, and loads before a file star toggle', async (t) => {
  const song = audio('Already starred', { rel: 'Song.flac' });
  const { server } = await favoriteStorage(t, [
    { id: song.id, t: 1, seq: 1, snap: { kind: 'audio', title: song.title } },
  ], { failRead: true });
  const { host, mount, emit } = setup(t, { items: [song] }, { appState: getState });
  event(text(host, 'Favorites 0'));
  await settle();
  assert.ok(isVisible(text(host, 'Starred files could not be loaded.')));
  const retry = children(host).find((node) => node.textContent === 'Retry' && isVisible(node));
  assert.ok(retry);
  const attempts = server.requests.length;
  event(retry);
  await settle();
  assert.equal(server.requests.length, attempts + 1);

  emit('mode-change', 'library');
  mount();
  await settle();
  assert.equal(server.requests.length, attempts + 2);
  assert.ok(isVisible(text(host, 'Starred files could not be loaded.')));
  event(text(host, 'Music 1'));
  searchFor(host, 'Search music', '');
  select(host, 'Music view', 'songs');
  server.failRead = false;
  event(rowStar(host, song.title));
  await settle();
  assert.deepEqual(server.requests.slice(-2), [
    { method: 'GET' }, { method: 'POST', add: [], remove: [song.id] },
  ]);
  assert.equal(rowStar(host, song.title).getAttribute('aria-pressed'), 'false');
});
