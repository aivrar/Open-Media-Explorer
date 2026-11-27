import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BEST_STREAM_MODES, BEST_STREAM_MODE_LABELS, LOSSY_BITRATE_LIMIT_KBPS, bestStreamAutoOn, bestStreamOn, compareStreams, isLossless, rankStreams, resolutionOf,
} from '../src/lib/best-stream.js';
import {
  BEST_STREAM_HEAD_START_MS, applyStreamCandidate, connectMediaRelay, playedStream, streamCandidatesForItem,
} from '../src/lib/media-failover.js';
import {
  STORAGE_KEYS, addFavorite, getState, normalizeFavoriteItem, normalizeSettings, persistFavoriteMetadata,
} from '../src/lib/state.js';
import { betterStationStreams, trustedOtherStreams } from '../src/adapters/radio-browser.js';
import { registrableDomain } from '../src/lib/other-streams.js';
import {
  LOOKUP_FAILED_RETRY_MS, LOOKUP_FOUND_MAX_AGE_MS, MAX_LOOKUP_STREAMS, MAX_STREAM_LOOKUPS, STREAM_LOOKUPS_KEY,
  clearStreamLookups, storeLookup, storedLookup,
} from '../src/lib/stream-lookups.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const urls = (list) => list.map((candidate) => candidate.url);

/* ============ What "best" means ============ */

test('picture size from quality labels', () => {
  assert.deepEqual(['1080p', '720p', '576i', ' 480P ', '2160p', '4K', 'UHD', '8k', '1080p HD'].map(resolutionOf),
    [1080, 720, 576, 480, 2160, 2160, 2160, 4320, 1080]);
  for (const label of ['', 'HD', 'SD', 'unknown', '99999p', null, 5]) assert.equal(resolutionOf(label), 0, String(label));
});

test('TV: the larger picture first; streams without a size after those with one', () => {
  const ranked = rankStreams([
    { url: 'a', quality: '' }, { url: 'b', quality: '720p' }, { url: 'c', quality: '1080p' }, { url: 'd', quality: '480p' },
  ]);
  assert.deepEqual(urls(ranked), ['c', 'b', 'd', 'a']);
});

test('radio: higher bitrate up to 320 kbps; lossless last; at equal bitrate the better format', () => {
  assert.equal(LOSSY_BITRATE_LIMIT_KBPS, 320);
  assert.equal(isLossless({ codec: 'FLAC', bitrate: 0 }), true);
  assert.equal(isLossless({ codec: 'MP3', bitrate: 1411 }), true);
  assert.equal(isLossless({ codec: 'MP3', bitrate: 320 }), false);
  const ranked = rankStreams([
    { url: 'mp3-128', codec: 'MP3', bitrate: 128 },
    { url: 'flac', codec: 'FLAC', bitrate: 1411 },
    { url: 'aac-128', codec: 'AAC', bitrate: 128 },
    { url: 'mp3-320', codec: 'MP3', bitrate: 320 },
    { url: 'unknown', codec: '', bitrate: 0 },
    { url: 'opus-96', codec: 'OPUS', bitrate: 96 },
  ]);
  assert.deepEqual(urls(ranked), ['mp3-320', 'aac-128', 'mp3-128', 'opus-96', 'unknown', 'flac']);
});

test('streams nothing tells apart keep the order the source gave', () => {
  const list = [{ url: 'x' }, { url: 'y' }, { url: 'z' }];
  assert.deepEqual(urls(rankStreams(list)), ['x', 'y', 'z']);
  assert.equal(compareStreams({ url: 'x' }, { url: 'y' }), 0);
  assert.deepEqual(rankStreams(null), []);
});

/* ============ The settings ============ */

test('one setting with three choices: Off, Listed streams (the default) and Auto (verified)', async () => {
  assert.deepEqual(BEST_STREAM_MODES, ['off', 'listed', 'auto']);
  assert.equal(normalizeSettings({}).bestStreamMode, 'listed');
  assert.equal(normalizeSettings({ bestStreamMode: 'auto' }).bestStreamMode, 'auto');
  assert.equal(normalizeSettings({ bestStreamMode: 'max' }).bestStreamMode, 'listed');
  // A setting saved by the earlier on/off switch keeps its meaning.
  assert.equal(normalizeSettings({ bestStream: false }).bestStreamMode, 'off');
  assert.equal(normalizeSettings({ bestStream: true }).bestStreamMode, 'listed');
  assert.equal(normalizeSettings({ bestStream: false, bestStreamMode: 'auto' }).bestStreamMode, 'auto', 'the new field wins');
  assert.equal(bestStreamOn({}), true);
  assert.equal(bestStreamOn(undefined), true);
  assert.equal(bestStreamOn({ bestStreamMode: 'off' }), false);
  assert.equal(bestStreamAutoOn({}), false);
  assert.equal(bestStreamAutoOn({ bestStreamMode: 'auto' }), true);
  const settings = await read('src/lib/settings.js');
  const content = settings.slice(settings.indexOf('<section data-content-settings>'), settings.indexOf('<section data-server-settings>'));
  assert.match(content, /<label for="settings-best-stream">Pick the best stream<\/label>/);
  assert.match(content, /<select id="settings-best-stream" data-field="bestStreamMode" aria-describedby="settings-best-stream-hint">/);
  const hint = content.match(/<div class="description" id="settings-best-stream-hint">([\s\S]*?)<\/div>/)?.[1];
  assert.match(hint, /When a station or channel lists several streams:\s+<ul>/);
  assert.match(hint, /\$\{BEST_STREAM_MODES\.map\(\(id\) => `<li><strong>\$\{BEST_STREAM_MODE_LABELS\[id\]\}<\/strong>: \$\{BEST_STREAM_DESCRIPTIONS\[id\]\}<\/li>`\)/);
  assert.match(content, /\$\{BEST_STREAM_MODES\.map\(\(id\) => `<option value="\$\{id\}">\$\{BEST_STREAM_MODE_LABELS\[id\]\}<\/option>`\)/);
  assert.doesNotMatch(content, /bestStreamRadio|as in earlier versions/);
  const css = await read('src/styles/base.css');
  assert.match(css, /#settings-best-stream-hint ul \{ margin: 3px 0 0; padding-inline-start: 16px; \}/);
  assert.match(css, /#settings-best-stream-hint li \+ li \{ margin-top: 3px; \}/);
  assert.deepEqual(Object.values(BEST_STREAM_MODE_LABELS), ['Off', 'Listed streams', 'Auto (verified)']);
  // The mode is a field of the saved settings, not a profile key of its own.
  const transfer = await read('src/lib/profile-transfer.js');
  assert.doesNotMatch(transfer, /bestStream|best-stream|streamlookups|streamverify/);
});

test('the player never looks anything up before a start; it offers only a stream verified before', async () => {
  const player = await read('src/lib/player.js');
  assert.match(player, /refreshStreamCandidates\(item, \{ signal: connectionController\.signal \}\)/);
  assert.doesNotMatch(player, /betterStationStreams|probeStreams|verifyStation/);
  assert.match(player, /const verified = partPlayback \|\| addresses\.ordered \? null : verifiedStreamFor\(item, getState\(\)\.settings\);/);
  assert.match(player, /const preferBest = !partPlayback && bestStreamOn\(getState\(\)\.settings\);/);
  assert.match(player, /const extraStreams = verified \? \[verified\] : \[\];/);
  assert.match(player, /const relayItem = itemForPart\(item, partPlayback\);/);
  assert.match(player, /connectMediaRelay\(relayItem, \{\s*signal: connectionController\.signal, preferBest, extraStreams, skipUrls: skipStreams, addresses,/);
  // A recording takes the stream that plays, as before.
  const recording = await read('src/lib/recording-client.js');
  assert.doesNotMatch(recording, /preferBest/);
});

/* ============ Which streams are tried ============ */

function tvItem() {
  return {
    id: 'iptv-org:fixture', title: 'Fixture TV', source: 'iptv-org', type: 'tv',
    stream_url: 'https://a.example/sd.m3u8', stream_kind: 'hls', capture_headers: {},
    _extra: {
      quality: '480p',
      streamCandidates: [
        { url: 'https://a.example/sd.m3u8', kind: 'hls', headers: {}, quality: '480p' },
        { url: 'https://b.example/hd.m3u8', kind: 'hls', headers: {}, quality: '1080p' },
        { url: 'https://c.example/mid.m3u8', kind: 'hls', headers: {}, quality: '720p' },
      ],
    },
  };
}

function radioItem(extra = {}, overrides = {}) {
  return {
    id: 'radio-browser:own', title: 'Jazz FM', source: 'radio-browser', type: 'radio',
    stream_url: 'https://stream.jazzfm.example/128.mp3', stream_kind: 'audio', capture_headers: {},
    source_url: 'https://www.jazzfm.example/', country: 'GB',
    _extra: { stationuuid: 'own', bitrate: 128, codec: 'MP3', ...extra },
    ...overrides,
  };
}

test('off or for a recording: the item\'s own order; on: best first', () => {
  assert.deepEqual(urls(streamCandidatesForItem(tvItem())),
    ['https://a.example/sd.m3u8', 'https://b.example/hd.m3u8', 'https://c.example/mid.m3u8']);
  assert.deepEqual(urls(streamCandidatesForItem(tvItem(), { preferBest: false })),
    ['https://a.example/sd.m3u8', 'https://b.example/hd.m3u8', 'https://c.example/mid.m3u8']);
  const best = streamCandidatesForItem(tvItem(), { preferBest: true });
  assert.deepEqual(urls(best), ['https://b.example/hd.m3u8', 'https://c.example/mid.m3u8', 'https://a.example/sd.m3u8']);
  assert.equal(best[0].quality, '1080p');
});

test('other radio entries are tried only when given and only with the setting on', () => {
  const extraStreams = [{ url: 'https://stream.jazzfm.example/320.mp3', kind: 'audio', headers: {}, bitrate: 320, codec: 'MP3' }];
  const item = radioItem();
  assert.deepEqual(urls(streamCandidatesForItem(item, { preferBest: true, extraStreams })),
    ['https://stream.jazzfm.example/320.mp3', 'https://stream.jazzfm.example/128.mp3']);
  assert.deepEqual(urls(streamCandidatesForItem(item, { preferBest: false, extraStreams })),
    ['https://stream.jazzfm.example/128.mp3']);
  // A recording records what plays; the item keeps its own address.
  applyStreamCandidate(item, streamCandidatesForItem(item, { preferBest: true, extraStreams })[0]);
  assert.equal(item.stream_url, 'https://stream.jazzfm.example/128.mp3');
  assert.equal(playedStream(item).url, 'https://stream.jazzfm.example/320.mp3');
  assert.equal(playedStream(item.id).bitrate, 320);
  assert.deepEqual(urls(streamCandidatesForItem(item)),
    ['https://stream.jazzfm.example/320.mp3', 'https://stream.jazzfm.example/128.mp3']);
  // A copy of the item (a renamed favourite is shown as one) records the same.
  assert.equal(urls(streamCandidatesForItem({ ...item, title: 'Morning' }))[0], 'https://stream.jazzfm.example/320.mp3');
});

test('the item\'s own stream always keeps a place, even behind nine better ones', async () => {
  const item = radioItem();
  const extraStreams = Array.from({ length: 9 }, (_, index) => ({
    url: `https://stream.jazzfm.example/alt${index}.aac`, kind: 'audio', headers: {}, bitrate: 256, codec: 'AAC',
  }));
  const tried = streamCandidatesForItem(item, { preferBest: true, extraStreams });
  assert.equal(tried.length, 8);
  assert.equal(tried.at(-1).url, item.stream_url);
  // All the better ones fail: the own stream still plays.
  const relay = await connectMediaRelay(item, {
    preferBest: true, extraStreams, timeoutMs: 1_000, headStartMs: 0,
    fetchImpl: async () => { throw new Error('not used'); },
    registerImpl: async (candidate) => {
      if (candidate.stream_url !== item.stream_url) throw new Error('down');
      return { media_id: 'own_media_1234567890', relay_url: '/api/v1/media/own' };
    },
    probeImpl: async () => true,
    expireImpl: async () => {},
  });
  assert.equal(relay.media_id, 'own_media_1234567890');
});

test('a favourite\'s saved record never changes when another stream plays, also after a restart', async () => {
  const values = new Map();
  const previous = { storage: globalThis.localStorage, favorites: getState().favorites };
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  try {
    getState().favorites = [];
    addFavorite(tvItem());
    const before = values.get(STORAGE_KEYS.favorites);
    // The player plays the saved favourite object itself.
    const item = getState().favorites[0];
    const relay = await connectMediaRelay(item, {
      preferBest: true, timeoutMs: 1_000, headStartMs: 0,
      fetchImpl: async () => { throw new Error('not used'); },
      registerImpl: async (candidate) => ({ media_id: `m_${candidate.stream_url.length}_1234567890`, relay_url: '/api/v1/media/x' }),
      probeImpl: async (_relay, candidate) => {
        if (candidate.url !== 'https://b.example/hd.m3u8') throw new Error('slow');
        return true;
      },
      expireImpl: async () => {},
    });
    assert.ok(relay.media_id);
    assert.equal(playedStream(item).url, 'https://b.example/hd.m3u8');
    // What player.js does after connecting.
    persistFavoriteMetadata(item);
    assert.equal(values.get(STORAGE_KEYS.favorites), before);
    // A later save of the whole list writes the same record.
    addFavorite(radioItem());
    const tv = (list) => JSON.stringify(list.find((saved) => saved.id === 'iptv-org:fixture'));
    assert.equal(tv(JSON.parse(values.get(STORAGE_KEYS.favorites))), tv(JSON.parse(before)));
    // Restart: the saved list read again is the same record.
    const reloaded = JSON.parse(values.get(STORAGE_KEYS.favorites)).map((saved) => normalizeFavoriteItem(saved, { restart: true }));
    assert.equal(tv(reloaded), tv(JSON.parse(before)));
  } finally {
    globalThis.localStorage = previous.storage;
    getState().favorites = previous.favorites;
  }
});

/* ============ Connecting ============ */

/** A relay whose streams connect after the given delays (ms), or fail ('fail').
 *  Timers are run by hand through `clock`. */
function relayFixture(plan) {
  const clock = { now: 0, timers: [] };
  clock.set = (fn, ms) => { const timer = { at: clock.now + ms, fn }; clock.timers.push(timer); return timer; };
  clock.clear = (timer) => { clock.timers = clock.timers.filter((other) => other !== timer); };
  clock.advance = async (ms) => {
    clock.now += ms;
    for (;;) {
      const due = clock.timers.filter((timer) => timer.at <= clock.now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.clear(due);
      due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  const expired = [];
  const aborted = [];
  const started = [];
  const options = {
    timeoutMs: 60_000,
    setTimer: clock.set,
    clearTimer: clock.clear,
    fetchImpl: async () => { throw new Error('not used'); },
    registerImpl: async (candidate, { signal }) => {
      started.push(candidate.stream_url);
      const step = plan[candidate.stream_url];
      return new Promise((resolve, reject) => {
        const done = () => (step === 'fail'
          ? reject(new Error(`no ${candidate.stream_url}`))
          : resolve({ media_id: `m_${candidate.stream_url}`, relay_url: '/api/v1/media/x' }));
        const timer = clock.set(done, step === 'fail' ? 1 : step);
        signal.addEventListener('abort', () => {
          clock.clear(timer);
          aborted.push(candidate.stream_url);
          reject(signal.reason);
        }, { once: true });
      });
    },
    probeImpl: async () => true,
    expireImpl: async (mediaId) => { expired.push(mediaId); },
  };
  return { clock, options, expired, aborted, started };
}

const HD = 'https://b.example/hd.m3u8';
const MID = 'https://c.example/mid.m3u8';
const SD = 'https://a.example/sd.m3u8';

test('on: the best stream starts alone; when it plays within the head start, the next is never asked', async () => {
  assert.equal(BEST_STREAM_HEAD_START_MS, 6_000);
  const { clock, options, expired, aborted, started } = relayFixture({ [HD]: 1_500, [MID]: 100, [SD]: 50 });
  const item = tvItem();
  const result = connectMediaRelay(item, { ...options, preferBest: true });
  await clock.advance(1_500);
  const relay = await result;
  assert.equal(relay.media_id, `m_${HD}`);
  assert.equal(item.stream_url, SD, 'the item keeps its own address');
  assert.equal(playedStream(item).url, HD);
  assert.equal(playedStream(item).quality, '1080p');
  assert.deepEqual(started, [HD], 'the 720p stream was never registered');
  assert.deepEqual(expired, []);
  assert.deepEqual(aborted, []);
  assert.equal(clock.timers.length, 0, 'no head-start timer left behind');
});

test('on: a best stream that is silent past the head start lets the next one start; whichever delivers then plays', async () => {
  {
    // Dead but not refusing: the 720p stream starts at 6 s and plays at 6.1 s.
    const { clock, options, aborted, started } = relayFixture({ [HD]: 50_000, [MID]: 100, [SD]: 50 });
    const item = tvItem();
    let settled = false;
    const result = connectMediaRelay(item, { ...options, preferBest: true });
    result.then(() => { settled = true; }, () => { settled = true; });
    await clock.advance(5_999);
    assert.equal(settled, false);
    assert.deepEqual(started, [HD]);
    await clock.advance(1);
    assert.deepEqual(started, [HD, MID]);
    await clock.advance(100);
    assert.equal((await result).media_id, `m_${MID}`);
    assert.deepEqual(aborted, [HD]);
  }
  {
    // Slow, but after the head start it still delivers first: it plays.
    const { clock, options, aborted } = relayFixture({ [HD]: 6_050, [MID]: 100, [SD]: 50 });
    const item = tvItem();
    const result = connectMediaRelay(item, { ...options, preferBest: true });
    await clock.advance(6_000);
    await clock.advance(50);
    assert.equal((await result).media_id, `m_${HD}`);
    assert.deepEqual(aborted, [MID]);
  }
});

test('on: an outright failure of the best stream starts the next at once', async () => {
  {
    const { clock, options, started } = relayFixture({ [HD]: 'fail', [MID]: 300, [SD]: 50 });
    const item = tvItem();
    const result = connectMediaRelay(item, { ...options, preferBest: true });
    await clock.advance(1);
    assert.deepEqual(started, [HD, MID]);
    await clock.advance(300);
    assert.equal((await result).media_id, `m_${MID}`);
  }
  {
    // Both of the better two fail: the next one is tried.
    const { clock, options } = relayFixture({ [HD]: 'fail', [MID]: 'fail', [SD]: 50 });
    const item = tvItem();
    const result = connectMediaRelay(item, { ...options, preferBest: true });
    await clock.advance(1);
    await clock.advance(1);
    await clock.advance(50);
    assert.equal((await result).media_id, `m_${SD}`);
  }
});

test('off: the first stream to connect wins, as before', async () => {
  const { clock, options } = relayFixture({ [HD]: 1_500, [MID]: 100, [SD]: 50 });
  const item = tvItem();
  const result = connectMediaRelay(item, { ...options, preferBest: false });
  await clock.advance(50);
  assert.equal((await result).media_id, `m_${SD}`);
});

/* ============ Radio Browser: other entries of the same station ============ */

function withStorage(fn) {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  return Promise.resolve().then(() => fn(values)).finally(() => { globalThis.localStorage = previous; });
}

function searcher(answer) {
  const calls = [];
  const searchImpl = async (item, opts) => {
    calls.push({ item, opts });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(opts) : answer;
  };
  return { calls, searchImpl };
}

let entryCount = 0;
const entry = (url, bitrate, codec = 'MP3', overrides = {}) => ({
  id: `radio-browser:e${++entryCount}`, title: 'Jazz FM', source: 'radio-browser', type: 'radio',
  stream_url: url, stream_kind: 'audio', source_url: 'https://jazzfm.example/', country: 'GB',
  _extra: { stationuuid: `e${entryCount}`, bitrate, codec }, ...overrides,
});

test('registrable domains, conservatively', () => {
  assert.equal(registrableDomain('https://a.b.example.com/x'), 'example.com');
  assert.equal(registrableDomain('http://radio.example.co.uk:8000/live'), 'example.co.uk');
  assert.equal(registrableDomain('http://cdn.example.com.au/'), 'example.com.au');
  assert.equal(registrableDomain('http://example.de./'), 'example.de');
  assert.equal(registrableDomain('http://1.2.3.4:8000/'), '1.2.3.4');
  assert.equal(registrableDomain('not a url'), '');
});

test('only entries with the same homepage, country and stream domain are used; a hostile copy is not', () => {
  const item = radioItem();
  const good = entry('https://stream2.jazzfm.example/320.mp3', 320);
  const hostile = entry('https://evil.example.net/jazz.mp3', 320);
  const otherCountry = entry('https://stream3.jazzfm.example/256.mp3', 256, 'MP3', { country: 'US' });
  const noCountry = entry('https://stream4.jazzfm.example/192.mp3', 192, 'MP3', { country: '' });
  const otherHome = entry('https://stream5.jazzfm.example/256.mp3', 256, 'MP3', { source_url: 'https://jazzfm.example.org/' });
  const used = trustedOtherStreams(item, [good, hostile, otherCountry, noCountry, otherHome]);
  // Both country codes must be given: an entry without one is not used.
  assert.deepEqual(used.map((stream) => stream.stream_url), [good.stream_url]);
  // A station without a homepage is never switched.
  assert.deepEqual(trustedOtherStreams(radioItem({}, { source_url: 'https://www.radio-browser.info/' }), [good]), []);
});

test('a lookup at most once a day, best first, lossless cannot push out the rest', async () => {
  await withStorage(async (values) => {
    const flac = Array.from({ length: 7 }, (_, index) => entry(`https://s${index}.jazzfm.example/flac`, 1411, 'FLAC'));
    const aac = entry('https://aac.jazzfm.example/320.aac', 320, 'AAC');
    const search = searcher([...flac, aac]);
    const T = 1_800_000_000_000;
    const item = radioItem();
    const streams = await betterStationStreams(item, { searchImpl: search.searchImpl, now: () => T });
    assert.equal(search.calls.length, 1);
    assert.equal(streams.length, MAX_LOOKUP_STREAMS);
    assert.equal(streams[0].url, 'https://aac.jazzfm.example/320.aac');
    // Nothing about it is written into the station.
    assert.deepEqual(item, radioItem());
    assert.ok(values.has(STREAM_LOOKUPS_KEY));
    await betterStationStreams(item, { searchImpl: search.searchImpl, now: () => T + 60_000 });
    assert.equal(search.calls.length, 1, 'kept for a day');
    await betterStationStreams(item, { searchImpl: search.searchImpl, now: () => T + LOOKUP_FOUND_MAX_AGE_MS });
    assert.equal(search.calls.length, 2);
  });
});

test('a failed or slow lookup is not repeated for 30 minutes; the store is bounded and Clear cache empties it', async () => {
  await withStorage(async (values) => {
    const T = 1_800_000_000_000;
    const failing = searcher(new Error('directory down'));
    const item = radioItem();
    // A failure is never an empty list (that would read as "no other entry").
    const failed = { code: 'LOOKUP_FAILED' };
    await assert.rejects(betterStationStreams(item, { searchImpl: failing.searchImpl, now: () => T }), failed);
    await assert.rejects(betterStationStreams(item, { searchImpl: failing.searchImpl, now: () => T + 60_000 }), failed);
    assert.equal(failing.calls.length, 1, 'not tried again at once');
    await assert.rejects(betterStationStreams(item, { searchImpl: failing.searchImpl, now: () => T + LOOKUP_FAILED_RETRY_MS }), failed);
    assert.equal(failing.calls.length, 2);
    // Slow: given up after the time limit, the search cancelled, remembered as failed.
    const slow = searcher((opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const other = radioItem({ stationuuid: 'slow' }, { id: 'radio-browser:slow' });
    await assert.rejects(betterStationStreams(other, { searchImpl: slow.searchImpl, timeoutMs: 5, now: () => T }), failed);
    assert.equal(slow.calls[0].opts.signal.aborted, true);
    assert.deepEqual(storedLookup('slow', T + 1), { ok: false, streams: [] });
    // The user moved on: cancelled, and nothing remembered.
    const controller = new AbortController();
    const third = radioItem({ stationuuid: 'left' }, { id: 'radio-browser:left' });
    const pending = betterStationStreams(third, { searchImpl: slow.searchImpl, signal: controller.signal, now: () => T });
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await assert.rejects(pending, /abort/i);
    assert.equal(storedLookup('left', T + 1), null);
    // Bounded: the oldest stations go.
    for (let index = 0; index < MAX_STREAM_LOOKUPS + 5; index += 1) storeLookup(`s${index}`, [], T);
    const stored = JSON.parse(values.get(STREAM_LOOKUPS_KEY)).stations;
    assert.equal(Object.keys(stored).length, MAX_STREAM_LOOKUPS);
    assert.equal(stored.s0, undefined);
    // Clear cache removes it.
    const state = await read('src/lib/state.js');
    assert.match(state, /localStorage\.removeItem\(STORAGE_KEYS\.favoriteNames\);\s*clearStreamLookups\(\);/);
    clearStreamLookups();
    assert.equal(values.has(STREAM_LOOKUPS_KEY), false);
  });
});
