import test from 'node:test';
import assert from 'node:assert/strict';
import { computerTrackFileKey, loadComputerTrackPrefs, rememberComputerTracks } from '../src/lib/computer-track-prefs.js';
import { PART_RESUME_KEY, readPartResume } from '../src/lib/part-resume.js';
import { createComputerLibrary } from '../src/lib/computer-library.js';
import { rankedComputerEntries } from '../src/lib/computer-catalog.js';
import { createComputerSearch, movedComputerDetail } from '../src/modes/library/computer.js';

const idle = (revision = 0) => ({ scanning: false, phase: 'idle', revision });
const scanning = (revision = 0) => ({ scanning: true, phase: 'reading', revision });
const settle = () => new Promise(setImmediate);

function setup(t, overrides = {}) {
  let time = 0;
  let status = idle();
  let id = 0;
  const timers = new Map();
  const calls = [];
  const deps = {
    loadComputerLibrary: t.mock.fn(async (since) => {
      calls.push('library');
      return since === status.revision ? { revision: since, unchanged: true }
        : { revision: status.revision, items: [{ id: 'song' + status.revision }], folders: [] };
    }),
    computerStatus: t.mock.fn(async () => { calls.push('status'); return status; }),
    startComputerScan: t.mock.fn(async () => { calls.push('start'); return status; }),
    cancelComputerScan: t.mock.fn(async () => { calls.push('cancel'); return status; }),
    now: () => time,
    setTimeout: (fn, delay) => {
      timers.set(++id, { fn, at: time + delay, delay });
      return id;
    },
    clearTimeout: (key) => timers.delete(key),
    ...overrides,
  };
  const store = createComputerLibrary(deps);
  t.after(store.closeComputerLibrary);
  return {
    ...store, timers, calls, deps,
    delay: () => [...timers.values()][0]?.delay,
    status(next) { status = next; },
    async tick() {
      assert.equal(timers.size, 1);
      const [[key, { fn, at }]] = timers;
      timers.delete(key);
      time = at;
      fn();
      await settle();
    },
  };
}

test('Library can preload one snapshot without opening Computer or starting a scan', async (t) => {
  const load = Promise.withResolvers();
  const app = setup(t, { loadComputerLibrary: t.mock.fn(() => load.promise) });
  const preloaded = app.ensureComputerLibrary();
  assert.equal(app.ensureComputerLibrary(), preloaded);
  assert.equal(app.getComputerLibrary().loaded, false);
  assert.deepEqual(app.calls, []);
  assert.equal(app.timers.size, 0);

  const opened = app.openComputerLibrary();
  await settle();
  assert.deepEqual(app.calls, ['start']);
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 1);
  const entry = { id: 'music', title: 'Song' };
  load.resolve({ revision: 0, items: [entry], folders: [] });
  await Promise.all([preloaded, opened]);
  assert.equal(app.getComputerLibrary().items[0], entry);
  assert.equal(app.ensureComputerLibrary(), undefined);
  assert.equal(app.timers.size, 0);
});

test('Library resumes a cold snapshot if Computer closes while the download is in flight', async (t) => {
  const late = Promise.withResolvers();
  const current = { id: 'current' };
  const read = t.mock.fn(async () => ({ revision: 2, items: [current], folders: [] }));
  read.mock.mockImplementationOnce(() => late.promise);
  const app = setup(t, { loadComputerLibrary: read });
  const opened = app.openComputerLibrary();
  await settle();
  app.closeComputerLibrary();
  assert.equal(read.mock.calls[0].arguments[1].signal.aborted, true);
  await app.ensureComputerLibrary();
  late.resolve({ revision: 1, items: [{ id: 'old' }], folders: [] });
  await opened;
  assert.equal(app.getComputerLibrary().items[0], current);
  assert.equal(read.mock.callCount(), 2);
  assert.equal(app.timers.size, 0);
});

test('warm Library searches rank and normalize at most 200 of 10,576 Computer files', async (t) => {
  let normalized = 0;
  const items = Array.from({ length: 10_576 }, (_, index) => ({
    id: String(index), folder: 'drive', kind: 'audio', artist: 'Beyoncé',
    album: 'Live album', title: 'Track ' + index, rel: 'Music/' + index + '.flac',
    get chapters() { normalized++; return []; },
  }));
  Object.assign(items.at(-1), { title: 'Beyoncé Live', kind: 'video', rel: 'Concerts/show.mp4' });
  items.at(-2).title = 'With Beyoncé';
  const app = setup(t, { loadComputerLibrary: async () => ({ revision: 1, items, folders: [{ id: 'drive' }] }) });
  await app.ensureComputerLibrary();
  const snapshot = app.getComputerLibrary();
  const find = t.mock.fn(rankedComputerEntries);
  const search = createComputerSearch(find);
  const started = performance.now();
  const hits = search('beyonce', snapshot);
  const duration = performance.now() - started;

  t.diagnostic('Warm search of 10,576 entries: ' + duration.toFixed(2) + ' ms');
  assert.ok(duration < 30, 'warm search must finish in under 30 ms');
  assert.equal(hits.length, 200);
  assert.equal(normalized, 200);
  assert.deepEqual(hits.slice(0, 3).map(({ id, type }) => [id, type]), [
    ['computer:10575', 'video'], ['computer:10574', 'audio'], ['computer:0', 'audio'],
  ]);
  assert.equal(hits[0].__computerSubtitle, 'Concerts');
  assert.equal(hits[1].__computerSubtitle, 'Beyoncé - Live album');
  assert.equal(search(' beyonce ', { ...snapshot, status: idle() }), hits);
  assert.equal(find.mock.callCount(), 1);

  const next = { ...snapshot, revision: 2, missingFiles: new Set(['10575']) };
  assert.equal(search('beyonce', next)[0].id, 'computer:10574');
  assert.equal(find.mock.callCount(), 2);
  assert.equal(search('live music', snapshot).length, 0, 'the directory alone does not match');
  assert.equal(search('show.mp4', snapshot).length, 1, 'the file name matches');
  assert.equal(search('live album beyonce', snapshot).length, 200, 'words may match across tags');
  assert.deepEqual(search('beyonce', { ...snapshot, folders: [] }), []);
  assert.deepEqual(search('', snapshot), []);
});

test('first open loads and scans once; later opens read status and only changed revisions', async (t) => {
  const app = setup(t);
  const revisions = [];
  const off = app.subscribeComputerLibrary((state) => revisions.push(state.revision));
  await app.openComputerLibrary();
  assert.deepEqual(app.calls, ['library', 'start']);
  assert.deepEqual(revisions, [0, 0]);
  assert.equal(app.getComputerLibrary().loaded, true);
  const items = app.getComputerLibrary().items;
  off();
  app.closeComputerLibrary();
  await app.openComputerLibrary();
  assert.deepEqual(app.calls, ['library', 'start', 'status']);
  assert.equal(app.getComputerLibrary().items, items);
  assert.deepEqual(revisions, [0, 0]);

  app.closeComputerLibrary();
  app.status(idle(2));
  await app.openComputerLibrary();
  assert.deepEqual(app.calls, ['library', 'start', 'status', 'status', 'library']);
  assert.equal(app.deps.loadComputerLibrary.mock.calls[1].arguments[0], 0);
  assert.equal(app.getComputerLibrary().revision, 2);
  assert.equal(app.timers.size, 0);
});

test('polling checks status every 1.5 s, waits at least 5 s between scan downloads, and checks once on completion', async (t) => {
  const app = setup(t);
  app.status(scanning());
  await app.openComputerLibrary();
  for (let n = 0; n < 4; n++) await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 1, 'unchanged revision after 6 seconds');
  app.status(scanning(1));
  await app.tick();
  assert.equal(app.getComputerLibrary().revision, 1);
  app.status(scanning(2));
  for (let n = 0; n < 3; n++) await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 2, '4.5 seconds since last fetch');
  await app.tick();
  assert.equal(app.getComputerLibrary().revision, 2);
  const items = app.getComputerLibrary().items;
  app.status(idle(2));
  await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 4, 'completion refresh even at the same revision');
  assert.equal(app.deps.loadComputerLibrary.mock.calls.at(-1).arguments[0], null, 'completion requests a full snapshot');
  assert.equal(app.getComputerLibrary().items, items, 'same rows keep the existing array');
  assert.equal(app.timers.size, 0);
  assert.equal(app.deps.computerStatus.mock.callCount(), 10);
});

test('changed snapshots keep objects whose revisions or nested fields still match', async (t) => {
  const original = [
    { id: 'stamped', revision: 7, title: 'Title' },
    { id: 'same', chapters: [{ start: 1, title: 'Intro' }], subs: ['a.srt'] },
    { id: 'changed', chapters: [{ start: 1, title: 'Intro' }] },
  ];
  const next = [
    { ...original[0], title: 'Same revision' },
    { subs: ['a.srt'], chapters: [{ title: 'Intro', start: 1 }], id: 'same' },
    { id: 'changed', chapters: [{ start: 2, title: 'Intro' }] },
  ];
  const read = t.mock.fn(async (since) => ({
    revision: since == null ? 0 : 1, items: since == null ? original : next, folders: [],
  }));
  const app = setup(t, { loadComputerLibrary: read });
  await app.openComputerLibrary();
  app.status(idle(1));
  await app.retry();
  const items = app.getComputerLibrary().items;
  assert.equal(items[0], original[0]);
  assert.equal(items[1], original[1]);
  assert.equal(items[2], next[2]);
});

test('scan updates back off to twenty times the measured rebuild', async (t) => {
  let rebuildTime = 0;
  const app = setup(t);
  const clock = app.deps.now;
  // Model time spent by a synchronous catalog subscriber with the same clock
  // that drives the scan timers.
  const timed = createComputerLibrary({ ...app.deps, now: () => clock() + rebuildTime });
  t.after(timed.closeComputerLibrary);
  timed.subscribeComputerLibrary((state) => {
    if (state.loaded && !rebuildTime) rebuildTime = 600;
  });
  app.status(scanning());
  await timed.openComputerLibrary();
  app.status(scanning(1));
  for (let n = 0; n < 7; n++) await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 1);
  await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 2);
  assert.equal(timed.getComputerLibrary().revision, 1);
});

test('closing clears scheduled polling and aborts an active request; late answers cannot write after reopen', async (t) => {
  const app = setup(t);
  app.status(scanning(1));
  await app.openComputerLibrary();
  app.closeComputerLibrary();
  assert.equal(app.timers.size, 0);
  const late = Promise.withResolvers();
  app.deps.computerStatus.mock.mockImplementationOnce(() => late.promise);
  app.openComputerLibrary();
  await settle();
  const old = app.deps.computerStatus.mock.calls[0].arguments[0].signal;
  app.closeComputerLibrary();
  assert.equal(old.aborted, true);
  app.status(idle(2));
  await app.openComputerLibrary();
  late.resolve(scanning(99));
  await settle();
  assert.equal(app.getComputerLibrary().status.revision, 2);
  assert.equal(app.timers.size, 0);
  assert.equal(app.deps.startComputerScan.mock.callCount(), 1);
});

test('the first scan starts while the initial download is pending and closing aborts both requests', async (t) => {
  const app = setup(t);
  const late = Promise.withResolvers();
  const scan = Promise.withResolvers();
  app.deps.loadComputerLibrary.mock.mockImplementationOnce(() => late.promise);
  app.deps.startComputerScan.mock.mockImplementationOnce(() => scan.promise);
  const opened = app.openComputerLibrary();
  await settle();
  assert.equal(app.deps.startComputerScan.mock.callCount(), 1);
  app.closeComputerLibrary();
  assert.equal(app.deps.loadComputerLibrary.mock.calls[0].arguments[1].signal.aborted, true);
  assert.equal(app.deps.startComputerScan.mock.calls[0].arguments[0].signal.aborted, true);
  late.resolve({ revision: 10, items: [], folders: [] });
  scan.resolve(scanning(10));
  await opened;
  assert.equal(app.getComputerLibrary().loaded, false);
  assert.equal(app.getComputerLibrary().status, null);
});

test('a failed download still starts the first scan, and Retry can recover both requests', async (t) => {
  const app = setup(t);
  app.deps.loadComputerLibrary.mock.mockImplementationOnce(async () => { throw new Error('Library offline'); });
  app.deps.startComputerScan.mock.mockImplementationOnce(async () => { throw new Error('Scan offline'); });
  await app.openComputerLibrary();
  assert.equal(app.getComputerLibrary().error, 'Library offline');
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 1);
  assert.equal(app.deps.startComputerScan.mock.callCount(), 1);
  assert.equal(app.timers.size, 0);

  app.status(scanning(1));
  await app.retry();
  assert.equal(app.deps.startComputerScan.mock.callCount(), 2);
  assert.equal(app.getComputerLibrary().error, '');
  assert.equal(app.getComputerLibrary().loaded, true);
  assert.equal(app.getComputerLibrary().status.scanning, true);
});

test('status failures back off, clear stale progress, and retry through to the final refresh', async (t) => {
  const app = setup(t);
  app.status(scanning());
  await app.openComputerLibrary();
  assert.equal(app.delay(), 1_500);
  for (const [index, delay] of [1_500, 3_000, 6_000, 12_000, 12_000].entries()) {
    app.deps.computerStatus.mock.mockImplementationOnce(async () => { throw new Error('Status offline'); });
    await app.tick();
    assert.equal(app.delay(), delay);
    const { status, error } = app.getComputerLibrary();
    if (index < 2) {
      assert.equal(status.scanning, true);
      assert.equal(error, 'Status offline');
    } else {
      assert.equal(status, null);
      assert.equal(error, 'Scan status is not available.');
    }
  }

  app.status(scanning());
  await app.retry();
  assert.equal(app.getComputerLibrary().error, '');
  assert.equal(app.delay(), 1_500);
  for (let n = 0; n < 3; n++) {
    app.deps.computerStatus.mock.mockImplementationOnce(async () => { throw new Error('Status offline'); });
    await app.tick();
  }
  assert.equal(app.getComputerLibrary().status, null);
  app.status(idle());
  await app.tick();
  assert.equal(app.getComputerLibrary().status.scanning, false);
  assert.equal(app.getComputerLibrary().error, '');
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 2, 'finish refresh even after status was unknown');
  assert.equal(app.timers.size, 0);
});

test('scan and cancel commands coalesce while in flight; a failed final refresh can be retried', async (t) => {
  const app = setup(t);
  await app.openComputerLibrary();
  const start = Promise.withResolvers();
  app.deps.startComputerScan.mock.mockImplementationOnce(() => start.promise);
  const pending = app.rescan();
  assert.equal(app.rescan(), pending);
  app.status(scanning(1));
  start.resolve(scanning(1));
  await pending;
  assert.equal(app.deps.startComputerScan.mock.callCount(), 2);
  app.status(idle(1));
  app.deps.loadComputerLibrary.mock.mockImplementationOnce(async () => { throw new Error('Could not refresh'); });
  await app.cancel();
  assert.equal(app.deps.cancelComputerScan.mock.callCount(), 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.getComputerLibrary().error, 'Could not refresh');
  await app.retry();
  assert.equal(app.getComputerLibrary().revision, 1);
  assert.equal(app.getComputerLibrary().error, '');
});

test('status and Cancel remain responsive during a slow library download', async (t) => {
  const app = setup(t);
  app.status(scanning());
  await app.openComputerLibrary();
  const late = Promise.withResolvers();
  app.deps.loadComputerLibrary.mock.mockImplementationOnce(() => late.promise);
  app.status(scanning(1));

  for (let n = 0; n < 4; n++) await app.tick();
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 2);
  assert.equal(app.getComputerLibrary().revision, 0);
  await app.tick();
  assert.equal(app.deps.computerStatus.mock.callCount(), 5);
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 2);

  app.status(idle(2));
  const cancelled = app.cancel();
  await settle();
  assert.equal(app.deps.cancelComputerScan.mock.callCount(), 1);
  assert.equal(app.getComputerLibrary().status.scanning, false);
  assert.equal(app.timers.size, 0);
  late.resolve({ revision: 1, items: [], folders: [] });
  await cancelled;
  assert.equal(app.deps.loadComputerLibrary.mock.callCount(), 3, 'a final fetch follows the in-flight download');
  assert.equal(app.getComputerLibrary().revision, 2);
});

test('commands that acknowledge without a status trigger a status read', async (t) => {
  const app = setup(t);
  app.status(scanning());
  app.deps.startComputerScan.mock.mockImplementationOnce(async () => ({ ok: true }));
  await app.openComputerLibrary();
  assert.equal(app.deps.computerStatus.mock.callCount(), 1);
  assert.equal(app.timers.size, 1);
});

test('deltas replace changed entries, drop removed ids and preserve unchanged objects', async (t) => {
  const unchanged = { id: 'kept', title: 'Unchanged' };
  const changed = { id: 'changed', title: 'Original' };
  const removed = { id: 'removed', title: 'Removed' };
  const replacement = { ...changed, title: 'Updated' };
  const fresh = { id: 'fresh', title: 'Added' };
  const read = t.mock.fn(async (since) => since == null
    ? { revision: 4, items: [unchanged, changed, removed], folders: [] }
    : { revision: 5, delta: true, items: [replacement, fresh], removed: [removed.id], folders: [] });
  const app = setup(t, { loadComputerLibrary: read });
  app.status(idle(4));
  await app.openComputerLibrary();
  app.status(idle(5));
  await app.retry();
  assert.deepEqual(read.mock.calls.map(({ arguments: [since] }) => since), [null, 4]);
  const { revision, items } = app.getComputerLibrary();
  assert.equal(revision, 5);
  assert.deepEqual(items, [unchanged, replacement, fresh]);
  assert.equal(items[0], unchanged);
  assert.equal(items[1], replacement);
});

test('one catalog answer resolves chains, swaps and stale collisions from the original bookmarks and choices', async (t) => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const originals = ['a', 'b', 'left', 'right', 'old', 'stale'];
  const file = id => computerTrackFileKey(id, { size: 20, mtime: 1 });
  storage.setItem(PART_RESUME_KEY, JSON.stringify(originals.map((id, index) =>
    ({ id: 'computer:' + id, partKey: 'file', position: index + 1 }))));
  for (const [index, id] of originals.entries()) rememberComputerTracks(file(id), { audio: index + 1 }, {}, storage);
  const replies = [
    { revision: 1, items: originals.filter(id => id !== 'stale').map(id => ({ id })), folders: [] },
    { revision: 2, items: ['c', 'left', 'right'].map(id => ({ id })), folders: [],
      moved: [['b', 'c'], ['left', 'right'], ['old', 'stale'], ['a', 'b'], ['right', 'left']] },
  ];
  const store = setup(t, { loadComputerLibrary: async () => replies.shift() });
  await store.openComputerLibrary();
  await store.refreshAvailability();
  const prefs = loadComputerTrackPrefs(storage);
  for (const [id, value] of [['c', 1], ['right', 3], ['left', 4], ['stale', 5]]) {
    assert.equal(readPartResume('computer:' + id)?.position, value, id);
    assert.equal(prefs.files.get(file(id))?.audio, value, id);
  }
  for (const id of ['a', 'b', 'old']) {
    assert.equal(readPartResume('computer:' + id), null, id);
    assert.equal(prefs.files.has(file(id)), false, id);
  }
});

test('a move carries file and audiobook bookmarks and track choices once, preserving destination data', async (t) => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: t.mock.fn((key, value) => values.set(key, value)),
    removeItem: (key) => values.delete(key),
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const file = (id) => computerTrackFileKey(id, { size: 300, mtime: 123 });
  const bookmark = (id, position, partKey = 'file') => ({ id: 'computer:' + id, partKey, position });
  const albumBook = 'book:["book","reader"]';
  const oldBook = 'book:["book-old"]';
  const newBook = 'book:["book-new"]';
  storage.setItem(PART_RESUME_KEY, JSON.stringify([
    bookmark('old', 400), bookmark('other-old', 500), bookmark('other-new', 600),
    bookmark(albumBook, 70, JSON.stringify(['computer:old', 'computer:other-old'])),
    bookmark(oldBook, 42, 'computer:book-old'),
  ]));
  rememberComputerTracks(file('old'), { audio: 1, subtitle: 'english' }, { subtitle: 'en' }, storage);
  rememberComputerTracks(file('other-old'), { audio: 2, subtitle: 'french' }, {}, storage);
  rememberComputerTracks(file('other-new'), { audio: 0, subtitle: '' }, {}, storage);

  const folders = [{ id: 'music', available: true }];
  const moves = [['old', 'new'], ['other-old', 'other-new'], ['book-old', 'book-new']];
  const catalog = (...ids) => ids.map((id) => ({ id, folder: 'music', kind: 'audio', title: 'Track ' + id }));
  const oldItems = catalog('old', 'other-old', 'book-old');
  const newItems = catalog('new', 'other-new', 'book-new');
  const replies = [
    { revision: 1, items: oldItems, folders },
    { revision: 2, delta: true, items: newItems, folders, removed: oldItems.map(({ id }) => id), moved: moves },
    { revision: 2, items: newItems, folders, moved: moves },
  ];
  const store = setup(t, { loadComputerLibrary: async () => replies.shift() });
  store.status(idle(1));
  await store.openComputerLibrary();
  await store.refreshAvailability();
  assert.deepEqual(readPartResume('computer:new'), bookmark('new', 400));
  assert.equal(readPartResume('computer:old'), null);
  assert.deepEqual(readPartResume('computer:other-new'), bookmark('other-new', 600));
  assert.deepEqual(readPartResume('computer:other-old'), bookmark('other-old', 500));
  assert.deepEqual(readPartResume('computer:' + albumBook),
    bookmark(albumBook, 70, JSON.stringify(['computer:new', 'computer:other-new'])));
  assert.equal(readPartResume('computer:' + oldBook), null);
  assert.deepEqual(readPartResume('computer:' + newBook), bookmark(newBook, 42, 'computer:book-new'));
  const prefs = loadComputerTrackPrefs(storage);
  assert.deepEqual(prefs.files.get(file('new')), { audio: 1, subtitle: 'english' });
  assert.equal(prefs.files.has(file('old')), false);
  assert.deepEqual(prefs.files.get(file('other-new')), { audio: 0, subtitle: '' });
  assert.deepEqual(prefs.files.get(file('other-old')), { audio: 2, subtitle: 'french' });
  assert.equal(prefs.subtitleLanguage, 'en');

  // Reuse an old id after the move, with the same fingerprint. A repeated
  // full answer must leave the new data at that id alone.
  const marks = JSON.parse(storage.getItem(PART_RESUME_KEY)).filter((mark) => mark.id !== 'computer:new');
  values.clear();
  storage.setItem(PART_RESUME_KEY, JSON.stringify([...marks, bookmark('old', 800)]));
  rememberComputerTracks(file('old'), { audio: 3 }, {}, storage);
  const writes = storage.setItem.mock.callCount();
  await store.foldersChanged(folders);
  assert.equal(replies.length, 0);
  const snapshot = store.getComputerLibrary();
  assert.equal(movedComputerDetail('computer:old', snapshot)?.id, 'computer:new');
  assert.equal(movedComputerDetail('computer:old', { ...snapshot, items: [...snapshot.items, oldItems[0]] }), null);
  assert.equal(storage.setItem.mock.callCount(), writes);
  assert.equal(readPartResume('computer:old').position, 800);
  assert.deepEqual(loadComputerTrackPrefs(storage).files.get(file('old')), { audio: 3 });
});

test('a delta from an invalidated base is discarded and followed by a full download', async (t) => {
  let resolveDelta;
  let fulls = 0;
  const read = t.mock.fn((since) => {
    if (since != null) return new Promise((resolve) => { resolveDelta = resolve; });
    return Promise.resolve(++fulls === 1
      ? { revision: 1, items: [{ id: 'first' }], folders: [] }
      : { revision: 3, items: [{ id: 'full' }], folders: [] });
  });
  const app = setup(t, { loadComputerLibrary: read });
  app.status(idle(1));
  await app.openComputerLibrary();
  const refresh = app.refreshAvailability();
  const folders = app.foldersChanged([{ id: 'new' }]);
  await settle();
  resolveDelta({ revision: 2, delta: true, items: [{ id: 'stale' }], removed: ['first'] });
  await Promise.all([refresh, folders]);
  assert.deepEqual(read.mock.calls.map(({ arguments: [since] }) => since), [null, 1, null]);
  assert.equal(app.getComputerLibrary().revision, 3);
  assert.deepEqual(app.getComputerLibrary().items, [{ id: 'full' }]);
});

test('a missing play immediately dims the file and asks for updated availability', async (t) => {
  const read = t.mock.fn(async (since) => since == null
    ? { revision: 1, items: [{ id: 'song', folder: 'drive' }], folders: [{ id: 'drive', available: true }] }
    : { revision: 1, unchanged: true, folders: [{ id: 'drive', available: false }] });
  const app = setup(t, { loadComputerLibrary: read });
  await app.openComputerLibrary();
  app.markFileMissing('song');
  assert.equal(app.getComputerLibrary().missingFiles.has('song'), true);
  await settle();
  assert.equal(read.mock.calls.at(-1).arguments[0], 1);
  assert.equal(app.getComputerLibrary().folders[0].available, false);
  assert.equal(app.getComputerLibrary().missingFiles.has('song'), false, 'the refresh still lists the row');
  read.mock.mockImplementationOnce(async () => ({
    revision: 1, unchanged: true, folders: [{ id: 'drive', available: true }],
  }));
  await app.refreshAvailability();
  assert.equal(app.getComputerLibrary().missingFiles.has('song'), false);
  assert.equal(app.getComputerLibrary().folders[0].available, true);
});

test('a restarted server requires a full snapshot even at the same revision', async (t) => {
  const first = { id: 'song', revision: 1, error: 'Unreadable' };
  const repaired = { id: 'song', revision: 1, title: 'Repaired' };
  const read = t.mock.fn(async () => ({ generation: 'first', revision: 1, items: [first], folders: [] }));
  const app = setup(t, { loadComputerLibrary: read });
  app.status({ ...idle(1), generation: 'first' });
  await app.openComputerLibrary();
  app.status({ ...idle(1), generation: 'second' });
  read.mock.mockImplementationOnce(async () => ({ generation: 'second', revision: 1, items: [repaired], folders: [] }));
  await app.retry();
  assert.deepEqual(read.mock.calls.map(({ arguments: [since] }) => since), [null, null]);
  assert.equal(app.getComputerLibrary().generation, 'second');
  assert.deepEqual(app.getComputerLibrary().items, [repaired]);
});

test('a changed generation in a partial library answer discards the partial result', async (t) => {
  for (const partial of [{ unchanged: true }, { delta: true, items: [{ id: 'invalid' }] }]) {
    const replies = [
      { generation: 'first', revision: 2, items: [{ id: 'old' }], folders: [] },
      { generation: 'second', revision: 2, ...partial },
      { generation: 'second', revision: 2, items: [{ id: 'new' }], folders: [] },
    ];
    const read = t.mock.fn(async () => replies.shift());
    const app = setup(t, { loadComputerLibrary: read });
    await app.openComputerLibrary();
    await app.refreshAvailability();
    assert.deepEqual(read.mock.calls.map(({ arguments: [since, { generation }] }) => [since, generation]),
      [[null, null], [2, 'first'], [null, 'first']]);
    assert.equal(app.getComputerLibrary().generation, 'second');
    assert.deepEqual(app.getComputerLibrary().items, [{ id: 'new' }]);
  }
});

test('fresh play metadata replaces an unreadable row and clears its missing mark', async (t) => {
  const old = { id: 'song', revision: 1, kind: 'video', error: 'Unreadable' };
  const read = async () => ({ generation: 'first', revision: 1, items: [old], folders: [] });
  const app = setup(t, { loadComputerLibrary: read });
  await app.openComputerLibrary();
  app.closeComputerLibrary();
  app.markFileMissing('song');
  const fresh = { id: 'song', revision: 1, kind: 'audio', title: 'Repaired', chapters: [{ start: 0, title: 'Intro' }] };
  app.acceptPlayedEntry('song', fresh);
  assert.equal(app.getComputerLibrary().items[0], fresh);
  assert.equal(app.getComputerLibrary().missingFiles.has('song'), false);
});
