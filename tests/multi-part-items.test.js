import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlayerDom, FakeElement } from './helpers/fake-dom.js';
import { closeDetail, openDetail } from '../src/modes/library/detail.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { emit, getState, subscribe } from '../src/lib/state.js';
import { buildParts as archiveParts, resolveParts as resolveArchiveParts, resolveStream as resolveArchiveStream }
  from '../src/adapters/internet-archive.js';
import { buildParts as librivoxParts } from '../src/adapters/librivox.js';
import { itemForPart, partLabel, resumablePart } from '../src/lib/media-parts.js';
import {
  PART_RESUME_KEY, clearPartResume, partResumeGeneration, readPartResume, rememberPartResume,
} from '../src/lib/part-resume.js';

import { MAX_PROFILE_BYTES, profileStorageSize } from '../src/lib/profile-storage.js';
import { RECONNECTING_TEXT, STALL_SAMPLE_MS, STALL_TIMEOUT_MS } from '../src/lib/live-resume.js';

const readFixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('LibriVox uses RSS section order and reads titles and durations', () => {
  const parts = librivoxParts(readFixture('librivox-parts.xml'));
  assert.deepEqual(parts.map(({ title, duration }) => [title, duration]), [
    ['1 - The Tale of the Peacock Trees', 2028],
    ['2 - The Wager of Squire Vane', 1970],
    ['3 - The Mystery of the Well', 2077],
  ]);
  assert.match(parts[0].url, /treesofpride_1_chesterton_64kb\.mp3$/);
  assert.equal(librivoxParts('<rss/>').length, 0);
});

test('Archive groups derivative files per track and keeps the item order', () => {
  const metadata = JSON.parse(readFixture('archive-audio-parts.json'));
  const parts = archiveParts(metadata, 'hamlet_0911_librivox');
  assert.deepEqual(parts.map(({ title, duration, downloadName }) => [title, duration, downloadName]), [
    ['Dramatis Personae', 162, 'hamlet_0_shakespeare_64kb.mp3'],
    ['Act 1', 3070, 'hamlet_act1_shakespeare_64kb.mp3'],
    ['Act 2', 2471, 'hamlet_act2_shakespeare_64kb.mp3'],
  ]);
  assert.deepEqual(archiveParts({ files: [...metadata.files].reverse() }, 'test').map(({ key }) => key),
    parts.map(({ key }) => key));
  const unnamed = archiveParts({ files: [{ name: 'z.ogg' }, { name: 'a.mp3' }, { name: 'z.mp3' }] }, 'test');
  assert.deepEqual(unnamed.map(({ title, downloadName }) => [title, downloadName]), [['z', 'z.mp3'], ['a', 'a.mp3']]);
});

test('Archive details and playback share one metadata request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const item = {
    type: 'audio',
    _extra: { identifier: 'hamlet_0911_librivox', needsResolve: true },
  };
  let requests = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://archive.org/metadata/hamlet_0911_librivox');
    requests++;
    return new Response(readFixture('archive-audio-parts.json'), { headers: { 'content-type': 'application/json' } });
  };
  const [parts] = await Promise.all([resolveArchiveParts(item), resolveArchiveStream(item)]);
  assert.equal(requests, 1);
  assert.equal(item.stream_url, parts[0].url);
  assert.equal(item.download_url, parts[0].url);
});

test('resume uses the saved part key after reordering, and downloads use the selected part', () => {
  const item = { type: 'audio', source: 'librivox', download_url: 'https://example.com/book.zip' };
  const parts = librivoxParts(readFixture('librivox-parts.xml'));
  const bookmark = { partKey: parts[2].key, position: 760 };
  const selection = resumablePart(item, parts, bookmark);
  assert.deepEqual(selection, { index: 2, position: 760, label: 'Resume chapter 3 at 12:40' });
  assert.equal(partLabel(item, { parts, ...selection }), 'Chapter 3 of 3 \u00b7 3 - The Mystery of the Well');
  assert.equal(resumablePart(item, [parts[2], ...parts.slice(0, 2)], bookmark).index, 0);
  assert.equal(resumablePart(item, parts.slice(0, 2), bookmark), null);
  const beforeResolution = itemForPart(item, null);
  const firstDownload = itemForPart(item, { parts, index: 0 });
  assert.equal(firstDownload.download_url, beforeResolution.download_url);
  assert.equal(firstDownload.download_part, beforeResolution.download_part);
  assert.match(beforeResolution.download_part, /^[0-9a-f]{16}$/);
  const lastDownload = itemForPart(item, { parts, index: 2 });
  assert.equal(lastDownload.download_url, parts[2].url);
  assert.match(lastDownload.download_part, /^[0-9a-f]{16}$/);
  assert.notEqual(lastDownload.download_part, itemForPart(item, { parts, index: 1 }).download_part);
  assert.equal(lastDownload.download_part, itemForPart(item, { parts: parts.slice(1), index: 1 }).download_part);
});

test('resume storage holds 200 most recent items and a cleared session cannot restore them', () => {
  const old = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  try {
    const epoch = partResumeGeneration();
    for (let index = 0; index <= 200; index++) rememberPartResume(`book-${index}`, 'chapter-3', 760.9, epoch);
    assert.equal(JSON.parse(storage.get(PART_RESUME_KEY)).length, 200);
    assert.equal(readPartResume('book-0'), null);
    assert.deepEqual(readPartResume('book-200'), { id: 'book-200', partKey: 'chapter-3', position: 760 });
    rememberPartResume('book-200', null, 0, epoch);
    assert.equal(readPartResume('book-200'), null);
    clearPartResume();
    rememberPartResume('book-199', 'chapter-4', 12, epoch);
    assert.equal(storage.has(PART_RESUME_KEY), false);
  } finally {
    if (old === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = old;
  }
});


test('resume bookmarks evict older entries to fit the profile budget and bound long keys', (t) => {
  const storage = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  t.after(() => { globalThis.localStorage = previous; });
  const epoch = partResumeGeneration();
  const partKey = 'https://example.com/' + 'é'.repeat(600);
  rememberPartResume('old', partKey, 12, epoch);
  storage.set('worldmedia.settings.v1', 'x'.repeat(MAX_PROFILE_BYTES - 1500));
  rememberPartResume('new', partKey, 42, epoch);
  assert.equal(readPartResume('old'), null);
  assert.equal(readPartResume('new').position, 42);
  assert.ok(profileStorageSize(Object.fromEntries(storage)) <= MAX_PROFILE_BYTES);
  rememberPartResume('oversized', partKey.repeat(100), 100, epoch);
  assert.equal(readPartResume('oversized'), null);
  assert.equal(readPartResume('new').position, 42);
});

test('the player advances, resumes at a chapter position, and stops at the end', async (t) => {
  const original = { document: globalThis.document, window: globalThis.window,
    fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const { document, elements } = createPlayerDom();
  for (const id of ['player-previous-part-slot', 'player-next-part-slot', 'player-previous-part', 'player-next-part',
    'player-resume-actions', 'player-resume-part', 'player-start-over']) {
    elements[id] = document.register(new FakeElement(id, 'button'));
  }
  globalThis.document = document;
  globalThis.window = {};
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const audio = elements['audio-el'];
  const normalLoad = audio.load.bind(audio);
  audio.load = () => {
    audio.currentTime = 0;
    audio.duration = Number.NaN;
    audio.ended = false;
    normalLoad();
  };
  const registrations = [];
  let feedRequests = 0;
  let waitBeforeRegister = null;
  function response(data) {
    return new Response(JSON.stringify({ ok: true, data, error: null }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  const book = {
    id: 'librivox:4441', type: 'audio', source: 'librivox', title: 'Trees of Pride',
    stream_kind: 'audio', delivery: 'on-demand', stream_url: '',
    download_url: 'https://archive.org/download/trees_of_pride_1007_librivox/trees_of_pride_1007_librivox.zip',
    _extra: { rssUrl: 'https://librivox.org/rss/4441', needsResolve: true },
  };
  globalThis.fetch = async (path, options = {}) => {
    if (String(path) === book._extra.rssUrl) {
      feedRequests += 1;
      return new Response(readFixture('librivox-parts.xml'), { headers: { 'content-type': 'application/rss+xml' } });
    }
    if (path === '/api/v1/session') return response({ token: 'part-player-test' });
    if (path === '/api/v1/media/register') {
      registrations.push(JSON.parse(options.body).url);
      if (waitBeforeRegister) await waitBeforeRegister();
      const media_id = 'parts_player_test_media_' + registrations.length;
      return response({ media_id, relay_url: '/api/v1/media/' + media_id });
    }
    if (String(path).endsWith('/expire')) return response({ state: 'expired' });
    throw new Error('Unexpected request ' + path);
  };
  const player = await import('../src/lib/player.js');
  player.initPlayer();
  t.after(() => {
    player.stop();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const nextPlaying = () => new Promise((resolve) => {
    const unsubscribe = subscribe('playing-change', (playing) => {
      if (!playing) return;
      unsubscribe();
      resolve();
    });
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const ended = () => {
    audio.currentTime = audio.duration;
    audio.paused = true;
    audio.ended = true;
    audio.emit('ended');
  };

  assert.equal(elements['player-next-part'].hidden, true);
  assert.equal(elements['player-previous-part-slot'].hidden, true);
  assert.equal(elements['player-next-part-slot'].hidden, true);
  await player.playItem(book);
  assert.equal(feedRequests, 1);
  assert.match(registrations.at(-1), /treesofpride_1_/);
  assert.match(elements['player-source'].textContent, /^Chapter 1 of 3/);
  assert.equal(elements['player-previous-part'].disabled, true);
  assert.equal(elements['player-next-part'].hidden, false);
  assert.equal(elements['player-previous-part-slot'].hidden, false);
  assert.equal(elements['player-next-part-slot'].hidden, false);
  assert.equal(player.getItemForDownload(book).download_url, book.download_url);

  audio.duration = 2028;
  const advance = nextPlaying();
  ended();
  audio.emit('ended'); // A late duplicate cannot change tracks twice.
  await advance;
  await settle();
  assert.match(registrations.at(-1), /treesofpride_2_/);
  assert.equal(registrations.length, 2);
  assert.equal(feedRequests, 1);
  assert.equal(player.getCurrentItem(), book);
  assert.match(elements['player-source'].textContent, /^Chapter 2 of 3/);
  assert.match(player.getItemForDownload(book).download_url, /treesofpride_2_/);
  assert.equal(player.getCurrentMediaAction(), 'download');
  audio.duration = 1970;
  audio.emit('loadedmetadata');
  audio.currentTime = 760;
  audio.pause();
  player.stop();

  await player.playItem(book);
  assert.equal(elements['player-resume-actions'].hidden, false);
  assert.equal(elements['player-resume-part'].textContent, 'Resume chapter 2 at 12:40');
  await t.test('the resume choice keeps the book title visible on the secondary line', () => {
    assert.equal(elements['player-source'].textContent, book.title);
  });
  assert.equal(registrations.length, 2);
  const resume = nextPlaying();
  elements['player-resume-part'].dispatchEvent(new Event('click'));
  await resume;
  await settle();
  audio.duration = 1970;
  audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 760);
  assert.equal(elements['player-seek'].value, '760');
  assert.equal(elements['player-seek'].max, '1970');

  const beforeRetry = registrations.length;
  audio.currentTime = 780;
  audio.emit('error');
  assert.equal(await player.togglePlay(), true);
  assert.equal(registrations.length, beforeRetry + 1);
  assert.equal(player.getCurrentPart(book.id).position, 780);
  assert.match(registrations.at(-1), /treesofpride_2_/);
  audio.duration = 1970;
  audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 780);

  let notifyRegister;
  let unblockRegister;
  const registering = new Promise((resolve) => { notifyRegister = resolve; });
  waitBeforeRegister = () => new Promise((resolve) => { unblockRegister = resolve; notifyRegister(); });
  ended();
  await registering;
  emit('sleep-fired');
  waitBeforeRegister = null;
  unblockRegister();
  await settle();
  assert.match(registrations.at(-1), /treesofpride_3_/);
  assert.equal(getState().isPlaying, false);
  assert.equal(elements['player-next-part'].disabled, true);
  assert.equal(await player.togglePlay(), true);
  const count = registrations.length;
  audio.duration = 2077;
  ended();
  await settle();
  assert.equal(registrations.length, count);
  assert.equal(readPartResume(book.id), null);

  await player.playItem(book);
  assert.match(registrations.at(-1), /treesofpride_1_/);
  assert.equal(elements['player-resume-actions'].hidden, true);

  audio.duration = 2028;
  audio.emit('loadedmetadata');
  audio.currentTime = 24;
  player.stop();
  await player.playItem(book);
  assert.equal(elements['player-resume-part'].textContent, 'Resume chapter 1 at 0:24');
  const restart = nextPlaying();
  elements['player-start-over'].dispatchEvent(new Event('click'));
  await restart;
  await settle();
  audio.duration = 2028;
  audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 0);
  assert.match(registrations.at(-1), /treesofpride_1_/);

  await t.test('a queued end cannot start the next chapter after sleep expires', async () => {
    audio.currentTime = audio.duration;
    audio.paused = true;
    audio.ended = true;
    const beforeSleep = registrations.length;
    emit('sleep-fired');
    audio.emit('ended');
    await settle();
    assert.equal(registrations.length, beforeSleep);
    assert.equal(player.getCurrentPart(book.id).index, 0);
    assert.equal(getState().isPlaying, false);
    assert.equal(await player.togglePlay(), true);
    assert.equal(player.getCurrentPart(book.id).index, 1);
  });

  await t.test('an overdue sleep deadline blocks chapter advance before the callback runs', async () => {
    audio.duration = 1970;
    const beforeSleep = registrations.length;
    const sleepTimer = getState().sleepTimer;
    sleepTimer.until = Date.now() - 1;
    try {
      ended();
      await settle();
      assert.equal(registrations.length, beforeSleep);
      assert.equal(player.getCurrentPart(book.id).index, 1);
    } finally {
      sleepTimer.until = null;
      await player.playItem(book, { parts: librivoxParts(readFixture('librivox-parts.xml')), index: 1 });
    }
  });

  await t.test('manual Play after a mid-part sleep restores normal auto-advance', async () => {
    audio.pause();
    emit('sleep-fired');
    assert.equal(await player.togglePlay(), true);
    audio.duration = 1970;
    ended();
    await settle();
    assert.equal(player.getCurrentPart(book.id).index, 2);
    assert.equal(getState().isPlaying, true);
  });

  await t.test('a silent chapter stall keeps its position and allows retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    await player.playItem(book, { parts: librivoxParts(readFixture('librivox-parts.xml')), index: 1 });
    audio.duration = 1970;
    audio.emit('loadedmetadata');
    audio.currentTime = 61;
    audio.emit('waiting');
    for (let at = 0; at <= STALL_TIMEOUT_MS; at += STALL_SAMPLE_MS) {
      t.mock.timers.tick(STALL_SAMPLE_MS);
    }
    assert.equal(getState().isPlaying, false);
    assert.match(elements['player-source'].textContent, /stopped loading/);
    assert.equal(readPartResume(book.id).position, 61);
    assert.equal(await player.togglePlay(), true);
    assert.equal(player.getCurrentPart(book.id).position, 61);
    player.stop();
  });

  await t.test('detail clicks switch chapters while playing, paused and stopped', async (t) => {
    const previousRoot = ui.root;
    ui.root = new FakeElement();
    t.after(() => {
      closeDetail();
      ui.root = previousRoot;
    });
    const parts = librivoxParts(readFixture('librivox-parts.xml'));
    const savedBook = { ...book, id: 'librivox:saved-book', stream_url: parts[0].url, delivery: 'live', _extra: {} };
    await player.playItem(savedBook);
    audio.currentTime = 1;
    audio.emit('timeupdate');
    audio.emit('error');
    await settle();
    assert.equal(elements['player-source'].textContent, RECONNECTING_TEXT);

    // The catalog details are available by the next attempt. Its first
    // chapter starts playing before the reconnect's play() promise settles.
    Object.assign(savedBook, { delivery: 'on-demand', _extra: book._extra });
    const play = audio.play;
    let finishReconnect;
    const pending = new Promise((resolve) => { finishReconnect = resolve; });
    audio.play = async () => {
      audio.play = play;
      await play.call(audio);
      await pending;
    };
    const reconnect = player.playItem(savedBook);
    t.after(async () => {
      audio.play = play;
      finishReconnect();
      await reconnect;
    });
    await settle();
    assert.equal(player.isMediaAdvancing(), true);
    assert.match(elements['player-source'].textContent, /^Chapter 1 of 3/);
    openDetail(savedBook);
    await settle();
    const section = ui.detailPanel.children.find((node) => node.className === 'detail-parts');
    const list = section.children.find((node) => node.tagName === 'OL');
    const buttons = list.children.map((row) => row.children[0]);
    const marked = () => buttons.map((button) => button.getAttribute('aria-current'));
    assert.deepEqual(marked(), ['true', null, null]);

    async function choose(index) {
      const count = registrations.length;
      buttons[index].dispatchEvent(new Event('click'));
      await settle();
      assert.deepEqual(registrations.slice(count), [parts[index].url]);
      assert.equal(audio.src, '/api/v1/media/parts_player_test_media_' + (count + 1));
      assert.match(elements['player-source'].textContent, new RegExp('^Chapter ' + (index + 1) + ' of 3'));
      assert.deepEqual(marked(), buttons.map((_, i) => i === index ? 'true' : null));
      assert.equal(getState().isPlaying, true);
    }

    assert.equal(getState().isPlaying, true);
    audio.duration = 2028;
    audio.currentTime = 10;
    await choose(1);
    finishReconnect();
    await reconnect;
    assert.equal(player.getCurrentPart(savedBook.id).index, 1);

    await player.togglePlay();
    assert.equal(getState().isPlaying, false);
    await choose(2);
    player.stop();
    assert.deepEqual(marked(), [null, null, null]);
    await choose(1);
  });
});
