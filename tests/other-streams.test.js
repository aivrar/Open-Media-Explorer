import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  cleanBitrate, cleanCodec, formatStreamQuality, streamQualityLabel,
} from '../src/lib/stream-quality.js';
import {
  OTHER_STREAMS_LIMIT, canFindOtherStreams, homepageHost, matchOtherStreams,
  normalizeStationName, otherStreamsQuery, streamKey,
} from '../src/lib/other-streams.js';
import {
  addFavorite, getState, normalizeSettings, persistFavoriteMetadata, STORAGE_KEYS,
} from '../src/lib/state.js';
import { clearPersistenceFailure } from '../src/lib/persistence-notice.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../src/lib/catalog-scheduler.js';
import {
  createOtherStreams, findOtherStreamsQueued, OTHER_STREAMS_TEXT, revealInScroller, scrollContainerOf,
} from '../src/modes/library/other-streams.js';
import { FakeElement } from './helpers/fake-dom.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
const DOT = ' \u00B7 ';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch(handler, fn) {
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

async function loadAdapter() {
  return import(`../src/adapters/radio-browser.js?otherStreams=${Date.now()}-${Math.random()}`);
}

/** A Radio Browser station as the directory API returns it. */
const station = (uuid, extra = {}) => ({
  stationuuid: uuid,
  name: 'Fixture Radio',
  url_resolved: `https://stream.example/${uuid}`,
  homepage: 'https://www.fixture.example/',
  favicon: '', countrycode: 'us', languagecodes: 'eng', tags: 'music',
  lastcheckok: 1,
  ...extra,
});

/** A normalized Radio Browser item, as the adapter would make it. */
const rb = (uuid, extra = {}, more = {}) => ({
  id: `radio-browser:${uuid}`,
  source: 'radio-browser',
  type: 'radio',
  title: 'Fixture Radio',
  stream_url: `https://stream.example/${uuid}`,
  source_url: 'https://www.fixture.example/',
  country: '',
  _extra: { stationuuid: uuid, bitrate: 0, codec: '', hls: false, ...extra },
  ...more,
});

/* ============ A. Bitrate and format ============ */

test('the adapter keeps bitrate, a cleaned codec and the HLS flag for every station', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/json/servers')) return json([]);
    return json([
      station('mp3', { bitrate: 128, codec: 'MP3' }),
      station('aacp', { bitrate: '64', codec: 'aac+' }),
      station('he', { bitrate: 48, codec: 'HE-AAC' }),
      station('video', { bitrate: 0, codec: 'AAC,H.264' }),
      station('unknown', { bitrate: -5, codec: 'UNKNOWN' }),
      station('odd', { bitrate: 'abc', codec: '<b>x</b>weird"codec;name' }),
      station('hls', { codec: '', hls: '1', url_resolved: 'https://stream.example/live' }),
      station('flac', { bitrate: 1411, codec: 'flac' }),
      // An older mirror without the fields at all.
      { stationuuid: 'bare', name: 'Bare', url_resolved: 'https://stream.example/bare' },
    ]);
  }, async () => {
    const adapter = await loadAdapter();
    const items = await adapter.search('fixture', { limit: 20 });
    const byId = Object.fromEntries(items.map((item) => [item._extra.stationuuid, item._extra]));
    assert.deepEqual(byId.mp3, { stationuuid: 'mp3', clickcount: 0, bitrate: 128, codec: 'MP3', hls: false });
    assert.equal(byId.aacp.bitrate, 64);
    assert.equal(byId.aacp.codec, 'AAC+');
    assert.equal(byId.he.codec, 'AAC+');
    assert.equal(byId.video.codec, 'AAC', 'the video codec is not the audio format');
    assert.equal(byId.unknown.bitrate, 0);
    assert.equal(byId.unknown.codec, '');
    assert.equal(byId.odd.bitrate, 0);
    assert.match(byId.odd.codec, /^[A-Z0-9+.\- ]{1,12}$/, 'unknown values are kept but cleaned and capped');
    assert.equal(byId.hls.hls, true);
    assert.equal(items.find((item) => item._extra.stationuuid === 'hls').stream_kind, 'hls');
    assert.equal(byId.flac.bitrate, 1411);
    assert.equal(byId.flac.codec, 'FLAC');
    assert.deepEqual(byId.bare, { stationuuid: 'bare', clickcount: 0, bitrate: 0, codec: '', hls: false });
    // Browse goes through the same mapping.
    const [browsed] = await adapter.browse({ limit: 1 });
    assert.equal(browsed._extra.bitrate, 128);
  });
});

test('codec and bitrate cleaning', () => {
  assert.equal(cleanCodec('mp3'), 'MP3');
  assert.equal(cleanCodec(' Ogg Vorbis '), 'OGG');
  assert.equal(cleanCodec('OPUS'), 'OPUS');
  assert.equal(cleanCodec('AACP'), 'AAC+');
  assert.equal(cleanCodec('UNKNOWN,H.264'), '');
  assert.equal(cleanCodec('H.264'), '');
  assert.equal(cleanCodec(42), '');
  assert.equal(cleanCodec(null), '');
  assert.equal(cleanCodec('Some Very Long Codec Name 2000'), 'SOME VERY LO');
  assert.equal(cleanCodec('\u202Eevil\u0000'), 'EVIL');
  assert.equal(cleanBitrate(128), 128);
  assert.equal(cleanBitrate('96'), 96);
  assert.equal(cleanBitrate(127.6), 128);
  assert.equal(cleanBitrate(0), 0);
  assert.equal(cleanBitrate(''), 0);
  assert.equal(cleanBitrate(true), 0);
  assert.equal(cleanBitrate(Infinity), 0);
  assert.equal(cleanBitrate(5_000_000), 0);
});

test('the label is one short line, or nothing when nothing is known', () => {
  assert.equal(formatStreamQuality({ bitrate: 128, codec: 'MP3' }), `MP3${DOT}128 kbps`);
  assert.equal(formatStreamQuality({ codec: 'MP3' }), 'MP3');
  assert.equal(formatStreamQuality({ bitrate: 128 }), '128 kbps');
  assert.equal(formatStreamQuality({}), '');
  assert.equal(formatStreamQuality({ hls: true }), 'HLS');
  assert.equal(formatStreamQuality({ hls: true, codec: 'AAC', bitrate: 64 }), `AAC${DOT}64 kbps`);
  assert.equal(streamQualityLabel(rb('a', { bitrate: 320, codec: 'MP3' })), `MP3${DOT}320 kbps`);
  // An older favourite without the fields, and other sources, show nothing.
  assert.equal(streamQualityLabel({ id: 'radio-browser:old', _extra: { stationuuid: 'old', clickcount: 9 } }), '');
  assert.equal(streamQualityLabel({ id: 'nasa:x' }), '');
  assert.equal(streamQualityLabel({ _extra: [] }), '');
});

function withFavorites(list, fn) {
  const state = getState();
  const previous = { favorites: state.favorites, settings: state.settings, storage: globalThis.localStorage };
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  state.favorites = list.map((item) => ({ ...item }));
  state.settings = normalizeSettings({});
  try {
    return fn({ state, saved: () => JSON.parse(values.get(STORAGE_KEYS.favorites) || '[]') });
  } finally {
    state.favorites = previous.favorites;
    state.settings = previous.settings;
    globalThis.localStorage = previous.storage;
    clearPersistenceFailure('favorites');
  }
}

test('favourites keep the format and bitrate, and a fresh copy of the station refreshes them', () => {
  withFavorites([], ({ state, saved }) => {
    assert.equal(addFavorite(rb('fav', { bitrate: 128, codec: 'MP3' })), true);
    assert.equal(saved()[0]._extra.bitrate, 128);
    assert.equal(streamQualityLabel(state.favorites[0]), `MP3${DOT}128 kbps`);

    // An older copy of the same station without the fields does not wipe them.
    const older = rb('fav');
    delete older._extra.bitrate; delete older._extra.codec; delete older._extra.hls;
    assert.equal(persistFavoriteMetadata(older), true);
    assert.equal(saved()[0]._extra.bitrate, 128);
    assert.equal(saved()[0]._extra.codec, 'MP3');
    assert.equal(state.favorites[0]._extra.codec, 'MP3');
    assert.equal('bitrate' in older._extra, false, 'the playing item itself is not changed');

    // So does a copy with no `_extra` object at all, or a broken one.
    for (const bareExtra of [undefined, null, 'x', []]) {
      const bare = rb('fav');
      if (bareExtra === undefined) delete bare._extra; else bare._extra = bareExtra;
      assert.equal(persistFavoriteMetadata(bare), true);
      assert.deepEqual(
        [saved()[0]._extra?.bitrate, saved()[0]._extra?.codec, saved()[0]._extra?.hls],
        [128, 'MP3', false],
        `incoming _extra ${JSON.stringify(bareExtra)}`,
      );
      assert.equal(streamQualityLabel(state.favorites[0]), `MP3${DOT}128 kbps`);
      assert.deepEqual(bare._extra ?? null, bareExtra ?? null, 'the playing item itself is not changed');
    }

    // A fresh directory copy wins.
    assert.equal(persistFavoriteMetadata(rb('fav', { bitrate: 256, codec: 'AAC' })), true);
    assert.equal(saved()[0]._extra.bitrate, 256);
    assert.equal(streamQualityLabel(state.favorites[0]), `AAC${DOT}256 kbps`);

    // Playing the saved favourite object itself keeps everything.
    assert.equal(persistFavoriteMetadata(state.favorites[0]), true);
    assert.equal(saved()[0]._extra.codec, 'AAC');
  });
  // A favourite saved before this feature keeps working and shows nothing.
  const legacy = { ...rb('legacy'), _extra: { stationuuid: 'legacy', clickcount: 3 } };
  withFavorites([legacy], ({ state, saved }) => {
    assert.equal(persistFavoriteMetadata(state.favorites[0]), true);
    assert.equal(streamQualityLabel(saved()[0]), '');
    assert.equal(saved()[0].stream_url, legacy.stream_url);
  });
});

test('the label shows in the detail panel, on technical cards, and only on hover in the player', async () => {
  const [detail, render, player, css] = await Promise.all([
    read('src/modes/library/detail.js'), read('src/modes/library/render.js'),
    read('src/lib/player.js'), read('src/styles/library.css'),
  ]);
  assert.match(detail, /const qualityLabel = streamQualityLabel\(item\);[\s\S]*?className: 'detail-quality', text: qualityLabel/);
  // Cards: inside the technical column, which the simple view hides.
  assert.match(render, /const quality = streamQualityLabel\(item\);[\s\S]*?className: 'card-license has-quality'[\s\S]*?className: 'card-quality', text: quality/);
  assert.match(css, /:root:not\(\[data-tech-details="on"\]\) \.card-license \{ display: none; \}/);
  // Player: in the hover title after the normal line, never in the visible meta line.
  // The player bar shows the format and bitrate of the stream that plays.
  // (stream-quality.js playedQualityLabel, shared with the Now Playing tab.)
  assert.match(player, /const listed = playedQualityLabel\(item, playedStream\(item\)\);[\s\S]*?const quality = \[listed, [\s\S]*?setSourceLine\(line, \{ itemLine: true, hover: quality \? \[line, quality\]/);
  assert.match(player, /hover: \[text, line, quality\]\.filter\(Boolean\)\.join\('\\n'\)/);
  assert.doesNotMatch(player, /setSourceLine\(\[[^\]]*quality/);
});

/* ============ B. Matching rule ============ */

test('station names are compared without case, spacing, punctuation or a trailing quality hint', () => {
  const same = [
    'SomaFM: Indie Pop Rocks!', 'somafm indie pop rocks 128k', 'SomaFM - Indie  Pop Rocks (AAC)',
    'SomaFM Indie Pop Rocks [MP3]', 'SomaFM Indie Pop Rocks HD', 'SomaFM Indie Pop Rocks (AAC+ 64 kbps)',
    'SomaFM Indie Pop Rocks - 128 kbps', 'SOMAFM INDIE POP ROCKS [320]', 'SomaFM Indie Pop Rocks HE-AAC',
    'SomaFM Indie Pop Rocks (128k) (MP3)',
  ];
  for (const name of same) assert.equal(normalizeStationName(name), 'somafm indie pop rocks', name);
  // A trailing number without a unit is part of the name.
  assert.equal(normalizeStationName('Hot 97'), 'hot 97');
  assert.equal(normalizeStationName('Radio 538'), 'radio 538');
  // A bracket that is not a quality hint stays.
  assert.equal(normalizeStationName('Radio Paradise (Mellow Mix)'), 'radio paradise mellow mix');
  assert.notEqual(normalizeStationName('Radio Paradise'), normalizeStationName('Radio Paradise Mellow Mix'));
  // A name that is only a hint is not stripped to nothing.
  assert.equal(normalizeStationName('MP3'), 'mp3');
  assert.equal(normalizeStationName('(128k)'), '128k');
  assert.equal(normalizeStationName(''), '');
  assert.equal(normalizeStationName(null), '');
});

test('the search text is the longest punctuation-free part of the station name', () => {
  assert.equal(otherStreamsQuery('SomaFM: Indie Pop Rocks (128k)'), 'indie pop rocks');
  assert.equal(otherStreamsQuery('SomaFM Indie Pop Rocks 128k'), 'somafm indie pop rocks');
  assert.equal(otherStreamsQuery('Radio Paradise'), 'radio paradise');
  assert.equal(otherStreamsQuery('FM4 | ORF'), 'fm4');
  assert.equal(otherStreamsQuery('A-1'), 'a 1');
});

test('homepage hosts ignore a leading www and the directory fallback link', () => {
  assert.equal(homepageHost('https://www.SomaFM.com/indiepop/'), 'somafm.com');
  assert.equal(homepageHost('http://somafm.com'), 'somafm.com');
  assert.equal(homepageHost('https://www.radio-browser.info/'), '');
  assert.equal(homepageHost('javascript:alert(1)'), '');
  assert.equal(homepageHost(''), '');
  assert.equal(homepageHost(undefined), '');
  assert.equal(streamKey('HTTP://Ice.Example/live/'), streamKey('https://ice.example/live'));
});

test('only entries with the same homepage host and the same name are listed', () => {
  const original = rb('self', { bitrate: 128, codec: 'MP3' }, { title: 'Radio Paradise', source_url: 'https://radioparadise.com/' });
  const candidates = [
    original,
    rb('aac', { bitrate: 320, codec: 'AAC' }, { title: 'Radio Paradise (AAC)', source_url: 'https://www.radioparadise.com' }),
    rb('flac', { bitrate: 1400, codec: 'FLAC' }, { title: 'Radio Paradise FLAC', source_url: 'https://radioparadise.com/listen' }),
    rb('mellow', { bitrate: 320 }, { title: 'Radio Paradise Mellow Mix', source_url: 'https://radioparadise.com/' }),
    rb('other-site', { bitrate: 128 }, { title: 'Radio Paradise', source_url: 'https://paradise-fm.example/' }),
    rb('no-home', {}, { title: 'Radio Paradise', source_url: 'https://www.radio-browser.info/' }),
    rb('broken', {}, { title: 'Radio Paradise', source_url: 'https://radioparadise.com/', _extra: { stationuuid: 'broken', lastcheckok: false } }),
    rb('same-url', {}, { title: 'Radio Paradise', source_url: 'https://radioparadise.com/', stream_url: original.stream_url }),
    rb('dup-a', { bitrate: 64 }, { title: 'Radio Paradise 64k', source_url: 'https://radioparadise.com/', stream_url: 'https://ice.example/rp64' }),
    rb('dup-b', { bitrate: 64 }, { title: 'Radio Paradise', source_url: 'https://radioparadise.com/', stream_url: 'http://ICE.example/rp64/' }),
    { ...rb('iptv'), source: 'iptv-org', id: 'iptv-org:x' },
  ];
  const result = matchOtherStreams(original, candidates);
  assert.equal(result.sameNameOnly, false);
  // Sorted by bitrate, highest first; nothing is marked or picked.
  assert.deepEqual(result.streams.map((item) => item._extra.stationuuid), ['flac', 'aac', 'dup-a']);
  assert.equal(result.total, 3);
});

test('without a homepage the exact name decides, and the list says so', () => {
  const original = rb('self', {}, { title: 'Jazz Radio', source_url: 'https://www.radio-browser.info/' });
  const result = matchOtherStreams(original, [
    rb('a', { bitrate: 96 }, { title: 'Jazz Radio [MP3]', source_url: 'https://jazzradio.example/' }),
    rb('b', {}, { title: 'Jazz Radio', source_url: '' }),
    rb('c', {}, { title: 'Jazz Radio Blues', source_url: '' }),
  ]);
  assert.equal(result.sameNameOnly, true);
  assert.deepEqual(result.streams.map((item) => item._extra.stationuuid), ['a', 'b']);
});

test('at most twenty are listed, with the full count kept', () => {
  const original = rb('self', {}, { title: 'Big Station' });
  const many = Array.from({ length: 25 }, (_, i) => rb(`s${i}`, { bitrate: i }, { title: 'Big Station' }));
  const result = matchOtherStreams(original, many);
  assert.equal(OTHER_STREAMS_LIMIT, 20);
  assert.equal(result.streams.length, 20);
  assert.equal(result.total, 25);
  assert.equal(result.streams[0]._extra.stationuuid, 's24');
});

test('only items with a Radio Browser station id qualify', () => {
  assert.equal(canFindOtherStreams(rb('x')), true);
  assert.equal(canFindOtherStreams({ ...rb('x'), _extra: undefined }), true, 'the id alone is enough');
  assert.equal(canFindOtherStreams({ id: 'playlist:abc', source: 'playlist', type: 'radio', title: 'Fixture Radio' }), false);
  assert.equal(canFindOtherStreams({ id: 'iptv-org:x', source: 'iptv-org', title: 'X' }), false);
  assert.equal(canFindOtherStreams({ id: 'radio-browser:', source: 'radio-browser', title: 'X' }), false);
  assert.equal(canFindOtherStreams(null), false);
});

test('the adapter sends one name search and applies the rule to the answer', async () => {
  const requests = [];
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/json/servers')) return json([]);
    requests.push(new URL(url));
    return json([
      station('self', { name: 'SomaFM: Indie Pop Rocks!', homepage: 'https://somafm.com/indiepop/', bitrate: 128, codec: 'MP3' }),
      station('aac', { name: 'SomaFM - Indie Pop Rocks (AAC)', homepage: 'http://www.somafm.com', bitrate: 64, codec: 'AAC+' }),
      station('hq', { name: 'SomaFM Indie Pop Rocks 256k', homepage: 'https://somafm.com/', bitrate: 256, codec: 'MP3' }),
      station('broken', { name: 'SomaFM Indie Pop Rocks', homepage: 'https://somafm.com/', lastcheckok: 0 }),
      station('elsewhere', { name: 'SomaFM Indie Pop Rocks', homepage: 'https://fan-site.example/' }),
      station('mix', { name: 'SomaFM Indie Pop Rocks Mix', homepage: 'https://somafm.com/' }),
    ]);
  }, async () => {
    const adapter = await loadAdapter();
    const original = rb('self', { bitrate: 128, codec: 'MP3' }, {
      title: 'SomaFM: Indie Pop Rocks!', source_url: 'https://somafm.com/indiepop/', stream_url: 'https://stream.example/self',
    });
    const result = await adapter.findOtherStreams(original);
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.pathname, '/json/stations/search');
    assert.equal(request.searchParams.get('name'), 'indie pop rocks');
    assert.equal(request.searchParams.get('hidebroken'), 'true');
    assert.equal(request.searchParams.get('limit'), '100');
    assert.deepEqual(result.streams.map((item) => item.id), ['radio-browser:hq', 'radio-browser:aac']);
    assert.equal(result.sameNameOnly, false);
    assert.equal(streamQualityLabel(result.streams[1]), `AAC+${DOT}64 kbps`);
    // A source the rule does not cover sends nothing.
    const none = await adapter.findOtherStreams({ id: 'playlist:x', source: 'playlist', title: 'X' });
    assert.deepEqual(none.streams, []);
    assert.equal(requests.length, 1);
  });
});

test('the lookup goes through the catalog queue at user priority', async () => {
  const calls = [];
  catalogScheduler.enqueue = (job) => { calls.push(job); return Promise.resolve({ streams: [], total: 0 }); };
  try {
    const signal = new AbortController().signal;
    await findOtherStreamsQueued(rb('q'), { signal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sourceId, 'radio-browser');
    assert.equal(calls[0].priority, CATALOG_PRIORITY.USER);
    assert.equal(calls[0].key, 'other-streams:radio-browser:q');
    assert.equal(calls[0].signal, signal);
    assert.equal(typeof calls[0].task, 'function');
  } finally {
    delete catalogScheduler.enqueue;
  }
});

/* ============ B. The panel ============ */

class Node extends FakeElement {
  constructor(tag) {
    super('', tag);
    this.parentNode = null;
    this.focused = false;
  }
  set className(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.values].join(' '); }
  get innerHTML() { return ''; }
  set innerHTML(_value) { throw new Error('markup must not be used'); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); }
  focus() { globalThis.document.activeElement = this; this.focused = true; }
  click() { this.dispatchEvent(new Event('click')); }
}

function withDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => Object.assign(new Node('#text'), { textContent: text }),
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.document = previous; });
}

const find = (node, className) => {
  if (node.classList?.contains(className)) return node;
  for (const child of node.children || []) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return null;
};
const findAll = (node, className, out = []) => {
  if (node.classList?.contains(className)) out.push(node);
  for (const child of node.children || []) findAll(child, className, out);
  return out;
};
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the panel shows loading, then the list, and Play hands over that entry', () => withDocument(async () => {
  const pending = deferred();
  const lookups = [];
  const played = [];
  const original = rb('self', {}, { title: 'Fixture Radio' });
  const panel = createOtherStreams(original, {
    find: (item, { signal }) => { lookups.push({ item, signal }); return pending.promise; },
    onPlay: (stream) => played.push(stream),
  });
  const { button, section } = panel;
  assert.equal(button.textContent, OTHER_STREAMS_TEXT.button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-controls'), section.getAttribute('id'));
  assert.equal(section.hidden, true);
  assert.equal(lookups.length, 0, 'nothing is fetched until asked');

  button.click();
  assert.equal(section.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].item, original);
  const status = find(section, 'other-streams-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, OTHER_STREAMS_TEXT.loading);
  assert.equal(section.getAttribute('aria-busy'), 'true');

  const hostile = '<img src=x onerror="alert(1)">Evil & Co';
  const streams = [
    rb('a', { bitrate: 320, codec: 'AAC' }, { title: hostile, country: 'DE' }),
    rb('b', {}, { title: 'Fixture Radio' }),
  ];
  pending.resolve({ streams, total: 2, sameNameOnly: false });
  await settle();
  assert.equal(section.getAttribute('aria-busy'), null);
  assert.equal(find(section, 'other-streams-header').textContent, OTHER_STREAMS_TEXT.sameStation);
  assert.equal(find(section, 'other-streams-header').hidden, false);
  assert.equal(status.textContent, '2 found.');
  const rows = findAll(section, 'other-stream');
  assert.equal(rows.length, 2);
  assert.equal(find(rows[0], 'other-stream-name').textContent, hostile, 'names are plain text');
  assert.equal(find(rows[0], 'other-stream-name').getAttribute('title'), hostile);
  assert.equal(find(rows[0], 'other-stream-facts').textContent, `AAC${DOT}320 kbps${DOT}DE`);
  assert.equal(find(rows[1], 'other-stream-facts').textContent, 'Format not listed');
  // Nothing is marked as the best or selected.
  assert.equal(findAll(section, 'is-best').length + findAll(section, 'is-selected').length, 0);
  const playButton = rows[0].children.at(-1);
  assert.equal(playButton.tagName, 'BUTTON');
  assert.equal(playButton.textContent, 'Play');
  assert.equal(playButton.getAttribute('aria-label'), `Play ${hostile}`);
  playButton.click();
  assert.equal(played.length, 1);
  assert.equal(played[0], streams[0], 'the entry itself, with its own id');
  assert.equal(original.id, 'radio-browser:self');

  // Collapsing hides the list; opening again asks again.
  button.click();
  assert.equal(section.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
}));

test('the panel says when nothing was found, and when the names may be different stations', () => withDocument(async () => {
  let answer = { streams: [], total: 0, sameNameOnly: false };
  const panel = createOtherStreams(rb('self'), { find: async () => answer });
  panel.button.click();
  await settle();
  const status = find(panel.section, 'other-streams-status');
  assert.equal(status.textContent, OTHER_STREAMS_TEXT.empty);
  assert.equal(find(panel.section, 'other-streams-header').hidden, true);
  assert.equal(find(panel.section, 'other-streams-list').hidden, true);

  panel.button.click();
  answer = { streams: Array.from({ length: 25 }, (_, i) => rb(`n${i}`)), total: 31, sameNameOnly: true };
  panel.button.click();
  await settle();
  assert.equal(find(panel.section, 'other-streams-header').textContent, OTHER_STREAMS_TEXT.sameName);
  assert.equal(findAll(panel.section, 'other-stream').length, 20);
  assert.equal(status.textContent, 'Showing 20 of 31.');
}));

test('a failed lookup shows a plain line and Retry asks again', () => withDocument(async () => {
  let fail = true;
  let calls = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const panel = createOtherStreams(rb('self'), {
      find: async () => { calls += 1; if (fail) throw new Error('<b>network</b>'); return { streams: [rb('x')], total: 1 }; },
    });
    panel.button.click();
    await settle();
    const status = find(panel.section, 'other-streams-status');
    const retry = find(panel.section, 'other-streams-retry');
    assert.equal(status.textContent, OTHER_STREAMS_TEXT.failed);
    assert.equal(retry.hidden, false);
    assert.equal(retry.textContent, 'Retry');

    fail = false;
    retry.click();
    assert.equal(retry.hidden, true);
    assert.equal(status.textContent, OTHER_STREAMS_TEXT.loading);
    assert.equal(globalThis.document.activeElement, status, 'focus stays in the panel');
    await settle();
    assert.equal(calls, 2);
    assert.equal(status.textContent, '1 found.');
    assert.equal(findAll(panel.section, 'other-stream').length, 1);
  } finally {
    console.warn = warn;
  }
}));

test('closing the panel drops a late answer', () => withDocument(async () => {
  const pending = deferred();
  let signal = null;
  const panel = createOtherStreams(rb('self'), { find: (_item, opts) => { signal = opts.signal; return pending.promise; } });
  panel.button.click();
  panel.abort();
  assert.equal(signal.aborted, true);
  pending.resolve({ streams: [rb('late')], total: 1 });
  await settle();
  assert.equal(findAll(panel.section, 'other-stream').length, 0);
  assert.equal(find(panel.section, 'other-streams-status').textContent, OTHER_STREAMS_TEXT.loading);
}));

test('other sources get no button; a playlist radio item gets one line saying why', () => withDocument(async () => {
  const playlist = createOtherStreams({ id: 'playlist:1', source: 'playlist', type: 'radio', title: 'My station' });
  assert.equal(playlist.button, null);
  assert.equal(playlist.section, null);
  assert.equal(playlist.note.textContent, OTHER_STREAMS_TEXT.playlistNote);
  for (const item of [
    { id: 'iptv-org:x', source: 'iptv-org', type: 'tv', title: 'X' },
    { id: 'playlist:2', source: 'playlist', type: 'tv', title: 'Y' },
    { ...rb('hidden'), __contentHidden: true },
    null,
  ]) {
    const none = createOtherStreams(item);
    assert.equal(none.button, null);
    assert.equal(none.note, null);
  }
}));

test('the detail panel wires the button, plays an entry as its own item and stops the lookup on close', async () => {
  const detail = await read('src/modes/library/detail.js');
  assert.match(detail, /createOtherStreams\(item, \{ onPlay: playOtherStream \}\)/);
  assert.match(detail, /function playOtherStream\(stream\) \{\s*openDetail\(stream, \{ focus: true \}\);\s*playItem\(stream\)/);
  assert.match(detail, /export function closeDetail[\s\S]*?stopOtherStreams\(\);/);
  assert.match(detail, /export function openDetail[\s\S]*?stopOtherStreams\(\);/);
  const panel = await read('src/modes/library/other-streams.js');
  assert.doesNotMatch(panel, /innerHTML|insertAdjacentHTML|html:/);
});

/* ============ C. Bringing the section into view ============ */

/** The detail panel as a scroll container: its visible part is `top` to
 *  `top + height` on screen; scrollBy calls are recorded. */
function fakeScroller({ top = 100, height = 400 } = {}) {
  const calls = [];
  return {
    calls,
    clientTop: 0,
    clientHeight: height,
    getBoundingClientRect: () => ({ top, bottom: top + height }),
    scrollBy: (options) => calls.push(options),
  };
}

/** A panel whose section sits at `box` (changeable) inside `scroller`. */
function revealPanel({ scroller = fakeScroller(), find: lookup, reducedMotion = () => false } = {}) {
  const asked = [];
  const panel = createOtherStreams(rb('self'), {
    find: lookup || (() => new Promise(() => {})),
    getScroller: (node) => { asked.push(node); return scroller; },
    reducedMotion,
  });
  const place = { box: { top: 480, bottom: 540 } };
  panel.section.getBoundingClientRect = () => place.box;
  return { panel, scroller, place, asked };
}

test('opening Other streams below the visible part scrolls only the detail panel, smoothly, without moving focus', () => withDocument(async () => {
  const { panel, scroller, asked } = revealPanel();
  const before = globalThis.document.createElement('button');
  globalThis.document.activeElement = before;
  panel.section.scrollIntoView = () => { throw new Error('the page must not scroll'); };
  panel.button.click();
  assert.deepEqual(asked, [panel.section], 'the container is looked up from the section');
  // Visible part ends at 500; the section ends at 540: 40 down, the least it takes.
  assert.deepEqual(scroller.calls, [{ top: 40, behavior: 'smooth' }]);
  assert.equal(globalThis.document.activeElement, before, 'keyboard focus is not moved');
}));

test('with reduced motion the panel jumps instead of animating', () => withDocument(async () => {
  const { panel, scroller } = revealPanel({ reducedMotion: () => true });
  panel.button.click();
  assert.deepEqual(scroller.calls, [{ top: 40, behavior: 'auto' }]);

  // The default reads the reduced-motion preference of the system.
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  try {
    const plain = createOtherStreams(rb('self'), { find: () => new Promise(() => {}), getScroller: () => scroller });
    plain.section.getBoundingClientRect = () => ({ top: 480, bottom: 540 });
    plain.button.click();
    assert.deepEqual(scroller.calls.at(-1), { top: 40, behavior: 'auto' });
  } finally {
    if (previous === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = previous;
  }
}));

test('a section that is already fully visible is left where it is', () => withDocument(async () => {
  const { panel, scroller, place } = revealPanel();
  place.box = { top: 200, bottom: 260 };
  panel.button.click();
  assert.deepEqual(scroller.calls, []);
  // Exactly touching the edges is still fully visible.
  assert.equal(revealInScroller({ getBoundingClientRect: () => ({ top: 100, bottom: 500 }) }, scroller), false);
  assert.deepEqual(scroller.calls, []);
}));

test('the section is brought into view again when the list or the message arrives', () => withDocument(async () => {
  const pending = deferred();
  const { panel, scroller, place } = revealPanel({ find: () => pending.promise });
  place.box = { top: 200, bottom: 260 };
  panel.button.click();
  assert.equal(scroller.calls.length, 0);
  // The list makes the section taller than what is left below it.
  place.box = { top: 200, bottom: 560 };
  pending.resolve({ streams: [rb('a'), rb('b'), rb('c')], total: 3 });
  await settle();
  assert.deepEqual(scroller.calls, [{ top: 60, behavior: 'smooth' }]);

  // A section taller than the panel shows its top rather than its end.
  place.box = { top: 300, bottom: 1300 };
  assert.equal(revealInScroller(panel.section, scroller, { reducedMotion: false }), true);
  assert.deepEqual(scroller.calls.at(-1), { top: 200, behavior: 'smooth' });
  // One above the visible part scrolls up to it.
  place.box = { top: 40, bottom: 90 };
  assert.equal(revealInScroller(panel.section, scroller, { reducedMotion: false }), true);
  assert.deepEqual(scroller.calls.at(-1), { top: -60, behavior: 'smooth' });

  // The failure message (and the Retry button) is brought into view too.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failing = revealPanel({ find: async () => { throw new Error('offline'); } });
    failing.place.box = { top: 200, bottom: 260 };
    failing.panel.button.click();
    assert.equal(failing.scroller.calls.length, 0);
    failing.place.box = { top: 450, bottom: 530 };
    await settle();
    assert.equal(find(failing.panel.section, 'other-streams-status').textContent, OTHER_STREAMS_TEXT.failed);
    assert.deepEqual(failing.scroller.calls, [{ top: 30, behavior: 'smooth' }]);
  } finally {
    console.warn = warn;
  }
}));

test('nothing scrolls once the section is collapsed, the panel changed, or it left the page', () => withDocument(async () => {
  // Collapsed before the answer came.
  const collapsed = deferred();
  const first = revealPanel({ find: () => collapsed.promise });
  first.place.box = { top: 200, bottom: 260 };
  first.panel.button.click();
  first.panel.button.click();
  assert.equal(first.panel.section.hidden, true);
  first.place.box = { top: 480, bottom: 900 };
  collapsed.resolve({ streams: [rb('a')], total: 1 });
  await settle();
  assert.deepEqual(first.scroller.calls, []);

  // The detail panel moved on to another item (it aborts the lookup).
  const changed = deferred();
  const second = revealPanel({ find: () => changed.promise });
  second.place.box = { top: 200, bottom: 260 };
  second.panel.button.click();
  second.panel.abort();
  second.place.box = { top: 480, bottom: 900 };
  changed.resolve({ streams: [rb('a')], total: 1 });
  await settle();
  assert.deepEqual(second.scroller.calls, []);

  // The section is no longer in the page.
  const gone = deferred();
  const third = revealPanel({ find: () => gone.promise });
  third.place.box = { top: 200, bottom: 260 };
  third.panel.button.click();
  third.panel.section.isConnected = false;
  third.place.box = { top: 480, bottom: 900 };
  gone.resolve({ streams: [rb('a')], total: 1 });
  await settle();
  assert.deepEqual(third.scroller.calls, []);

  // No scroll container found: nothing scrolls and nothing breaks.
  const none = createOtherStreams(rb('self'), { find: () => new Promise(() => {}), getScroller: () => null });
  none.section.getBoundingClientRect = () => ({ top: 480, bottom: 900 });
  assert.doesNotThrow(() => none.button.click());
  assert.equal(none.section.hidden, false);
}));

test('the scroll container is the nearest scrolling ancestor, never the page itself', () => {
  const styles = new Map();
  const body = { nodeType: 1, parentNode: null };
  const documentElement = { nodeType: 1, parentNode: null };
  body.parentNode = documentElement;
  const doc = {
    body, documentElement,
    defaultView: { getComputedStyle: (node) => ({ overflowY: styles.get(node) || 'visible' }) },
  };
  const panel = { nodeType: 1, parentNode: body };
  const wrapper = { nodeType: 1, parentNode: panel };
  const section = { nodeType: 1, parentNode: wrapper, ownerDocument: doc };
  styles.set(panel, 'auto');
  assert.equal(scrollContainerOf(section), panel);
  styles.set(wrapper, 'scroll');
  assert.equal(scrollContainerOf(section), wrapper);
  styles.clear();
  styles.set(body, 'auto');
  styles.set(documentElement, 'scroll');
  assert.equal(scrollContainerOf(section), null, 'the page is never scrolled for this');
  assert.equal(scrollContainerOf({ nodeType: 1, parentNode: null, ownerDocument: doc }), null);
  assert.equal(scrollContainerOf(null), null);
});

test('the detail panel stays the scroll container at every size and the page is never scrolled by code', async () => {
  const [css, panel] = await Promise.all([read('src/styles/library.css'), read('src/modes/library/other-streams.js')]);
  assert.match(css, /\.detail-panel \{[^}]*overflow-y: auto;/);
  assert.doesNotMatch(panel, /\.scrollIntoView\(|window\.scroll/);
});
