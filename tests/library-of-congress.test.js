import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  catalogPolicy,
  createLibraryOfCongressAdapter,
  createLocRateGate,
  displayName,
  id,
  itemTypes,
  LOC_AUDIO_URL,
  LOC_VIDEO_URL,
} from '../src/adapters/library-of-congress.js';
import {
  HttpContentTypeError, HttpError,
} from '../src/lib/http.js';
import { validateItem } from '../src/lib/item-model.js';
import {
  repairFiniteMediaFields, resolveMediaAction,
} from '../src/lib/media-capabilities.js';
import { normalizeFavoriteItem } from '../src/lib/state.js';
import { SOURCES } from '../src/lib/sources.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/five-new-sources/loc.json', import.meta.url),
  'utf8',
));

function summary(lane, number, overrides = {}) {
  const type = lane === 'audio' ? 'audio' : 'video';
  return {
    access_restricted: false,
    id: `http://www.loc.gov/item/${lane}-${number}/`,
    url: `https://www.loc.gov/item/${lane}-${number}/`,
    title: `${lane} item ${number}`,
    date: '1942-06-01',
    language: ['english'],
    online_format: [type],
    mime_type: [type === 'audio' ? 'audio/mpeg' : 'video/mp4'],
    image_url: [`https://tile.loc.gov/storage-services/service/${lane}-${number}.jpg`],
    ...overrides,
  };
}

function page(lane, pageNumber, options = {}) {
  const results = options.results ?? [summary(lane, `${pageNumber}-1`)];
  const from = results.length ? ((pageNumber - 1) * 30) + 1 : 0;
  const to = results.length ? from + results.length - 1 : 0;
  const total = options.total ?? to;
  let next = null;
  if (options.hasNext) {
    const base = lane === 'audio' ? LOC_AUDIO_URL : LOC_VIDEO_URL;
    const target = new URL(base);
    target.searchParams.set('fo', 'json');
    target.searchParams.set('at', 'results,pagination');
    target.searchParams.set('c', '30');
    target.searchParams.set('sp', String(pageNumber + 1));
    if (options.query) target.searchParams.set('q', options.query);
    next = target.href;
  }
  return {
    pagination: {
      current: pageNumber,
      from: options.from ?? from,
      to: options.to ?? to,
      total,
      next: options.next ?? next,
    },
    results,
  };
}

function adapter(dependencies = {}) {
  return createLibraryOfCongressAdapter({ minIntervalMs: 0, ...dependencies });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  async flush() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
  }
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

function unresolvedItem(key, type = 'audio') {
  return {
    ...summary(type === 'audio' ? 'audio' : 'video', key),
    id: `library-of-congress:${key}`,
    source: 'library-of-congress',
    type,
    stream_url: '',
    stream_kind: type,
    delivery: 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    thumbnail: '',
    year: null,
    country: '',
    language: '',
    tags: [],
    license: 'See LOC rights',
    source_url: `https://www.loc.gov/item/${key}/`,
    content_rating: 'unrated',
    _extra: { locKey: key, expectedType: type, needsResolve: true },
  };
}

test('standard LOC exports are registered in Phase 8', () => {
  assert.equal(id, 'library-of-congress');
  assert.equal(displayName, 'Library of Congress');
  assert.deepEqual(itemTypes, ['audio', 'video']);
  assert.deepEqual(catalogPolicy, { maxConcurrent: 1, minIntervalMs: 6_000 });
  assert.equal(SOURCES.some((source) => source.id === id), true);
});

test('browse alternates audio/video lanes, uses minimum fields, and advances each lane independently', async () => {
  const urls = [];
  const source = adapter({
    getJson: async (input) => {
      const url = new URL(input);
      urls.push(url);
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      const pageNumber = Number(url.searchParams.get('sp'));
      if (lane === 'audio' && pageNumber === 1) {
        return page('audio', 1, { total: 31, hasNext: true });
      }
      if (lane === 'audio' && pageNumber === 2) {
        return page('audio', 2, { total: 31, results: [summary('audio', 'last')] });
      }
      return page('video', 1, { total: 1 });
    },
  });

  const first = await source.browsePage();
  const second = await source.browsePage({ cursor: first.cursor });
  const third = await source.browsePage({ cursor: second.cursor });
  assert.deepEqual([first.lane, second.lane, third.lane], ['audio', 'video', 'audio']);
  assert.equal(first.exhausted, false);
  assert.equal(second.exhausted, false);
  assert.equal(third.exhausted, true);
  assert.equal(third.cursor, null);
  assert.equal(first.items[0].type, 'audio');
  assert.equal(second.items[0].type, 'video');
  assert.deepEqual(validateItem(first.items[0]), []);
  assert.deepEqual(urls.map((url) => ({
    path: url.pathname,
    at: url.searchParams.get('at'),
    count: url.searchParams.get('c'),
    page: url.searchParams.get('sp'),
  })), [
    { path: '/audio/', at: 'results,pagination', count: '30', page: '1' },
    { path: '/film-and-videos/', at: 'results,pagination', count: '30', page: '1' },
    { path: '/audio/', at: 'results,pagination', count: '30', page: '2' },
  ]);
});

test('a failed lane leaves its exact cursor retryable and cannot falsely exhaust the other lane', async () => {
  let audioPageTwoCalls = 0;
  const source = adapter({
    getJson: async (input) => {
      const url = new URL(input);
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      const pageNumber = Number(url.searchParams.get('sp'));
      if (lane === 'audio' && pageNumber === 1) return page('audio', 1, { total: 31, hasNext: true });
      if (lane === 'video') return page('video', 1, { total: 1 });
      audioPageTwoCalls += 1;
      if (audioPageTwoCalls === 1) throw new Error('temporary LOC transport failure');
      return page('audio', 2, { total: 31, results: [summary('audio', 'recovered')] });
    },
  });
  const first = await source.browsePage();
  const second = await source.browsePage({ cursor: first.cursor });
  const retryCursor = structuredClone(second.cursor);
  await assert.rejects(source.browsePage({ cursor: retryCursor }), /temporary LOC/);
  assert.deepEqual(second.cursor, retryCursor, 'adapter must not mutate the caller cursor on failure');
  const recovered = await source.browsePage({ cursor: retryCursor });
  assert.equal(recovered.items[0].id, 'library-of-congress:audio-recovered');
  assert.equal(recovered.exhausted, true);
});

test('search lanes encode queries, reset together on query change, and preserve alternating fairness', async () => {
  const calls = [];
  const source = adapter({
    getJson: async (input) => {
      const url = new URL(input);
      calls.push(url);
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      return page(lane, 1, {
        query: url.searchParams.get('q'),
        total: 31,
        hasNext: true,
      });
    },
  });
  const first = await source.searchPage('cats & jazz');
  const second = await source.searchPage('cats & jazz', { cursor: first.cursor });
  const reset = await source.searchPage('dogs / film', { cursor: second.cursor });
  assert.deepEqual([first.lane, second.lane, reset.lane], ['audio', 'video', 'audio']);
  assert.deepEqual(calls.map((url) => url.searchParams.get('q')), [
    'cats & jazz', 'cats & jazz', 'dogs / film',
  ]);
  assert.match(calls[0].href, /q=cats(?:\+|%20)%26(?:\+|%20)jazz/);
  assert.equal(reset.cursor.query, 'dogs / film');
  assert.equal(reset.cursor.lanes.video.page, 1);
});

test('ordinary search interleaves both types and returns a marked partial result when one lane fails', async () => {
  let audioCalls = 0;
  let videoCalls = 0;
  const laneErrors = [];
  const source = adapter({
    getJson: async (input) => {
      const url = new URL(input);
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      if (lane === 'audio') {
        audioCalls += 1;
        if (audioCalls === 1) throw new Error('audio lane temporarily failed');
      } else videoCalls += 1;
      return page(lane, 1, { query: url.searchParams.get('q'), total: 2, results: [
        summary(lane, 1), summary(lane, 2),
      ] });
    },
  });
  const partial = await source.search('history', {
    onLaneError: (lane) => laneErrors.push(lane),
  });
  assert.deepEqual(partial.map((item) => item.type), ['video', 'video']);
  assert.deepEqual(partial.locSearchState, { partial: true, failedLanes: ['audio'] });
  assert.deepEqual(laneErrors, ['audio']);

  const recovered = await source.search('history', { limit: 4 });
  assert.deepEqual(recovered.map((item) => item.type), ['audio', 'video', 'audio', 'video']);
  assert.equal(recovered.locSearchState.partial, false);
  assert.equal(audioCalls, 2);
  assert.equal(videoCalls, 1, 'successful video lane is served from cache on retry');
});

test('fake clock proves browse, search, and detail share one burst-1 six-second gate', async () => {
  const clock = new FakeClock();
  const starts = [];
  const source = createLibraryOfCongressAdapter({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    minIntervalMs: 6_000,
    getJson: async (input) => {
      const url = new URL(input);
      starts.push({ at: clock.time, path: url.pathname, query: url.searchParams.get('q') || '' });
      if (url.pathname.startsWith('/item/')) {
        return {
          item: { id: 'http://www.loc.gov/item/rate-detail/', access_restricted: true },
          resources: [],
        };
      }
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      return page(lane, 1, {
        query: url.searchParams.get('q') || '', total: 1,
        results: [summary(lane, lane === 'audio' ? 1 : 2)],
      });
    },
  });
  const browse = source.browsePage();
  const search = source.searchPage('rate test');
  const detailItem = unresolvedItem('rate-detail');
  const resolve = source.resolveStream(detailItem);
  await clock.flush();
  assert.deepEqual(starts.map(({ at }) => at), [0]);
  await clock.advance(5_999);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.deepEqual(starts.map(({ at }) => at), [0, 6_000]);
  await clock.advance(6_000);
  assert.deepEqual(starts.map(({ at }) => at), [0, 6_000, 12_000]);
  await Promise.all([browse, search, resolve]);
  assert.equal(detailItem._extra.resolutionStatus, 'unavailable');
});

test('rate gate enforces cooldown, aborts queued work, and disposes every pending timer/job', async () => {
  const clock = new FakeClock();
  const gate = createLocRateGate({
    minIntervalMs: 6_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const starts = [];
  const first = gate.run(async () => { starts.push(clock.time); return 'first'; });
  const controller = new AbortController();
  const cancelled = gate.run(async () => 'never', controller.signal);
  const last = gate.run(async () => { starts.push(clock.time); return 'last'; });
  await clock.flush();
  assert.equal(await first, 'first');
  gate.imposeCooldown(60_000);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await clock.advance(59_999);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  assert.equal(await last, 'last');
  assert.deepEqual(starts, [0, 60_000]);

  const pending = gate.run(async () => 'not run');
  gate.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(gate.pendingCount, 0);
  assert.equal(clock.timers.size, 0);
});

test('429 and CAPTCHA/HTML impose bounded one-hour provider cooldowns without becoming empty success', async () => {
  for (const error of [
    new HttpError('rate limited', { status: 429, retryAfterMs: 3_600_000 }),
    new HttpError('rate limited with unsafe zero delay', { status: 429, retryAfterMs: 0 }),
    new HttpContentTypeError('captcha html', { status: 200, contentType: 'text/html' }),
  ]) {
    const clock = new FakeClock();
    let calls = 0;
    const source = createLibraryOfCongressAdapter({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      minIntervalMs: 0,
      getJson: async (input) => {
        calls += 1;
        if (calls === 1) throw error;
        const url = new URL(input);
        const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
        return page(lane, 1, {
          query: url.searchParams.get('q') || '', total: 1,
        });
      },
    });
    const failed = source.browsePage();
    const queued = source.searchPage('after block');
    await clock.flush();
    await assert.rejects(failed, (caught) => {
      assert.equal(caught.retryAfterMs, 3_600_000);
      return true;
    });
    await clock.advance(3_599_999);
    assert.equal(calls, 1);
    await clock.advance(1);
    assert.equal((await queued).items.length, 1);
    assert.equal(calls, 2);
  }
});

test('pagination, provider, suspicious-zero, and malformed schema failures remain distinct from exhaustion', async () => {
  const cases = [
    { payload: { results: [], pagination: { current: 1, from: 0, to: 0, total: 1, next: null } }, pattern: /suspicious empty/i },
    { payload: { error: 'heavy load' }, pattern: /provider error/i },
    { payload: { results: [summary('audio', 1)] }, pattern: /pagination/i },
    { payload: page('audio', 1, { total: 31, hasNext: false }), pattern: /disagreed/i },
    { payload: page('audio', 1, { total: 31, hasNext: true, next: 'https://evil.example/?sp=2' }), pattern: /next-page/i },
    { payload: page('audio', 1, { results: [summary('audio', 1, {
      id: 'https://www.loc.gov:444/item/nonstandard-port/',
      url: 'https://www.loc.gov:444/item/nonstandard-port/',
    })] }), pattern: /no usable canonical items/i },
    { payload: page('audio', 1, { results: [summary('audio', 1, {
      id: 'https://www.loc.gov.evil.example/item/hostile/',
      url: 'https://www.loc.gov.evil.example/item/hostile/',
    })] }), pattern: /no usable canonical items/i },
  ];
  for (const fixtureCase of cases) {
    const source = adapter({ getJson: async () => fixtureCase.payload });
    await assert.rejects(source.browsePage(), fixtureCase.pattern);
  }

  const emptySearch = adapter({ getJson: async () => ({
    results: [], pagination: { current: 1, from: 0, to: 0, total: 0, next: null },
  }) });
  const result = await emptySearch.searchPage('no matching item');
  assert.equal(result.items.length, 0);
  assert.equal(result.lane, 'audio');
  assert.equal(result.exhausted, false, 'video lane remains independently searchable');

  const restrictedOnly = adapter({ getJson: async () => page('audio', 1, {
    total: 1,
    results: [summary('audio', 'onsite-summary', { access_restricted: true })],
  }) });
  const restrictedPage = await restrictedOnly.browsePage();
  assert.deepEqual(restrictedPage.items, []);
  assert.equal(restrictedPage.exhausted, false, 'audio exhausted, but untouched video lane remains');
  assert.equal(restrictedPage.cursor.lanes.audio.exhausted, true);
});

test('summary normalization canonicalizes historical HTTP IDs and keeps rights unknown', async () => {
  const source = adapter({ getJson: async () => structuredClone(fixture.audioPage) });
  const result = await source.browsePage();
  const item = result.items[0];
  assert.equal(item.id, 'library-of-congress:fixture-audio-1');
  assert.equal(item.source_url, 'https://www.loc.gov/item/fixture-audio-1/');
  assert.equal(item.year, 1952);
  assert.equal(item.language, 'en');
  assert.equal(item.thumbnail, '');
  assert.equal(item._extra.artworkUrl, '', 'unsupported SVG placeholder is not registered');
  assert.equal(item.license, 'See LOC rights');
  assert.equal(item._extra.needsResolve, true);
  assert.deepEqual(validateItem(item), []);
});

test('downloadable audio couples public playback with an explicitly allowed file and bounded rights', async () => {
  const source = adapter({
    getJson: async (input) => {
      if (new URL(input).pathname.startsWith('/item/')) return structuredClone(fixture.downloadableItem);
      return structuredClone(fixture.audioPage);
    },
  });
  const item = (await source.browsePage()).items[0];
  await source.resolveStream(item);
  assert.equal(item.stream_url, 'https://tile.loc.gov/storage-services/service/fixture/audio.mp3');
  assert.equal(item.stream_kind, 'audio');
  assert.equal(item.type, 'audio');
  assert.equal(item.download_url, item.stream_url);
  assert.equal(item.download_name, 'audio.mp3');
  assert.equal(item.license, 'Fixture rights statement');
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'playable');
  repairFiniteMediaFields(item);
  assert.equal(resolveMediaAction(item), 'download');
  assert.deepEqual(validateItem(item), []);
  const restarted = normalizeFavoriteItem(item, { restart: true });
  assert.equal(restarted.stream_url, '');
  assert.equal(restarted._extra.needsResolve, true);
  await source.resolveStream(restarted);
  assert.equal(restarted.stream_url, item.stream_url);
  assert.equal(resolveMediaAction(restarted), 'download');
});

test('invalid saved LOC identity settles unavailable instead of checking forever', async () => {
  const item = unresolvedItem('../invalid');
  const source = adapter();
  await source.resolveStream(item);
  assert.equal(item.stream_url, '');
  assert.equal(item.download_url, '');
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'unavailable');
  assert.equal(item._extra.validationError, 'LOC_IDENTITY_INVALID');
  assert.equal(resolveMediaAction(item), 'unavailable');
});

test('rights-restricted stream stays playable while every download path remains suppressed', async () => {
  const item = unresolvedItem('fixture-video-restricted', 'video');
  const source = adapter({ getJson: async () => structuredClone(fixture.restrictedItem) });
  await source.resolveStream(item);
  assert.equal(item.stream_url, 'https://tile.loc.gov/streaming-services/fixture/master.m3u8');
  assert.equal(item.stream_kind, 'hls');
  assert.equal(item.type, 'video');
  assert.equal(item.download_url, '');
  assert.equal(item.download_name, '');
  assert.equal(item.license, 'Streaming access only');
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'playable');
  assert.equal(resolveMediaAction(item), 'unavailable');
});

test('multi-resource selection prefers adaptive playback but only explicitly allowed MP4 download', async () => {
  const item = unresolvedItem('multi-video', 'video');
  const source = adapter({
    getJson: async () => ({
      item: {
        id: 'http://www.loc.gov/item/multi-video/',
        access_restricted: false,
        rights_restricted: false,
      },
      resources: [{
        type: 'video',
        video_stream: 'https://tile.loc.gov/streaming-services/multi/master.m3u8',
        download_restricted: false,
        canDownload: true,
        files: [[{
          url: 'https://tile.loc.gov/storage-services/service/multi/movie.mp4',
          mimetype: 'video/mp4',
          canDownload: true,
          download_restricted: false,
        }]],
      }],
    }),
  });
  await source.resolveStream(item);
  assert.equal(item.stream_url, 'https://tile.loc.gov/streaming-services/multi/master.m3u8');
  assert.equal(item.download_url, 'https://tile.loc.gov/storage-services/service/multi/movie.mp4');
  assert.equal(item.download_name, 'movie.mp4');
  assert.equal(item.license, 'See LOC rights');
});

test('nested derivatives inherit explicit parent-file download policy', async () => {
  const item = unresolvedItem('derivative-audio', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/derivative-audio/',
      access_restricted: false,
      rights_restricted: false,
    },
    resources: [{
      type: 'audio',
      download_restricted: false,
      files: [[{
        canDownload: true,
        download_restricted: false,
        derivatives: [{
          derivativeUrl: 'https://tile.loc.gov/storage-services/service/derived.mp3',
        }],
      }]],
    }],
  }) });
  await source.resolveStream(item);
  assert.equal(item.stream_url, 'https://tile.loc.gov/storage-services/service/derived.mp3');
  assert.equal(item.download_url, item.stream_url);
  assert.equal(item.download_name, 'derived.mp3');
});

test('a nested file can explicitly revoke a parent resource download grant', async () => {
  const item = unresolvedItem('child-revokes-download', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/child-revokes-download/',
      access_restricted: false,
      rights_restricted: false,
    },
    resources: [{
      type: 'audio',
      audio: 'https://tile.loc.gov/storage-services/service/child-revoked.mp3',
      canDownload: true,
      download_restricted: false,
      files: [[{
        url: 'https://tile.loc.gov/storage-services/service/child-revoked.mp3',
        mimetype: 'audio/mpeg',
        canDownload: false,
      }]],
    }],
  }) });
  await source.resolveStream(item);
  assert.ok(item.stream_url, 'explicitly public playback remains usable');
  repairFiniteMediaFields(item);
  assert.equal(item.download_url, '');
  assert.equal(resolveMediaAction(item), 'unavailable');
  const saved = normalizeFavoriteItem(item);
  assert.equal(saved.download_url, '');
  assert.equal(saved._extra.downloadResolved, true);
});

test('download-only advisory wording suppresses download without blocking playback', async () => {
  const item = unresolvedItem('advisory-stream-only', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/advisory-stream-only/',
      access_restricted: false,
      access_advisory: ['No known restrictions on access. Streaming only; not available for download.'],
    },
    resources: [{
      type: 'audio',
      audio: 'https://tile.loc.gov/storage-services/service/advisory-stream.mp3',
      canDownload: true,
      download_restricted: false,
    }],
  }) });
  await source.resolveStream(item);
  assert.ok(item.stream_url);
  repairFiniteMediaFields(item);
  assert.equal(item.download_url, '');
  assert.equal(resolveMediaAction(item), 'unavailable');
});

test('detail identity falls back from a noncanonical id to its canonical item URL', async () => {
  const item = unresolvedItem('detail-url-fallback', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'detail-url-fallback',
      url: 'http://www.loc.gov/item/detail-url-fallback/',
      access_restricted: false,
    },
    resources: [],
  }) });
  await source.resolveStream(item);
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.resolutionStatus, 'unavailable');
});

test('explicit resource grants cannot override restrictive item rights text', async () => {
  const item = unresolvedItem('rights-text-block', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/rights-text-block/',
      access_restricted: false,
      rights: 'Use restricted; permission required for reproduction.',
    },
    resources: [{
      type: 'audio',
      audio: 'https://tile.loc.gov/storage-services/service/rights-text.mp3',
      canDownload: true,
      download_restricted: false,
    }],
  }) });
  await source.resolveStream(item);
  assert.ok(item.stream_url);
  repairFiniteMediaFields(item);
  assert.equal(item.download_url, '');
});

test('a bare filename never becomes a fabricated LOC playback URL', async () => {
  const item = unresolvedItem('bare-filename', 'audio');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/bare-filename/',
      access_restricted: false,
    },
    resources: [{
      type: 'audio',
      files: [{ filename: 'recording.mp3', mimetype: 'audio/mpeg' }],
    }],
  }) });
  await source.resolveStream(item);
  assert.equal(item.stream_url, '');
  assert.equal(item._extra.resolutionStatus, 'unavailable');
});

test('onsite items settle unavailable; malformed resources stay retryable; traversal is bounded', async () => {
  const onsite = unresolvedItem('onsite');
  const onsiteSource = adapter({ getJson: async () => ({
    item: { id: 'http://www.loc.gov/item/onsite/', access_restricted: true },
    resources: [{ audio: 'https://tile.loc.gov/onsite.mp3' }],
  }) });
  await onsiteSource.resolveStream(onsite);
  assert.equal(onsite.stream_url, '');
  assert.equal(onsite._extra.needsResolve, false);
  assert.equal(onsite._extra.resolutionStatus, 'unavailable');

  const advisory = unresolvedItem('advisory');
  const advisorySource = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/advisory/',
      access_advisory: ['Access to this item is currently restricted.'],
    },
    resources: [{ audio: 'https://tile.loc.gov/advisory.mp3' }],
  }) });
  await advisorySource.resolveStream(advisory);
  assert.equal(advisory.stream_url, '');
  assert.equal(advisory._extra.resolutionStatus, 'unavailable');

  const malformed = unresolvedItem('malformed');
  const malformedSource = adapter({ getJson: async () => ({
    item: { id: 'http://www.loc.gov/item/malformed/' }, resources: {},
  }) });
  await assert.rejects(malformedSource.resolveStream(malformed), /item\/resource response/);
  assert.equal(malformed._extra.needsResolve, true);

  const oversized = unresolvedItem('oversized');
  const oversizedSource = adapter({ getJson: async () => ({
    item: { id: 'http://www.loc.gov/item/oversized/' },
    resources: Array.from({ length: 129 }, () => ({})),
  }) });
  await assert.rejects(oversizedSource.resolveStream(oversized), /resource bound/);
  assert.equal(oversized._extra.needsResolve, true);
});

test('download requires explicit false restriction plus true canDownload at the applicable level', async () => {
  for (const resourceFlags of [
    { canDownload: true },
    { download_restricted: false },
    { canDownload: false, download_restricted: false },
    { canDownload: true, download_restricted: true },
  ]) {
    const key = `flags-${JSON.stringify(resourceFlags).length}`;
    const item = unresolvedItem(key);
    const source = adapter({ getJson: async () => ({
      item: { id: `http://www.loc.gov/item/${key}/`, access_restricted: false },
      resources: [{
        type: 'audio', audio: `https://tile.loc.gov/${key}.mp3`, ...resourceFlags,
      }],
    }) });
    await source.resolveStream(item);
    assert.ok(item.stream_url, 'public playback remains available');
    assert.equal(item.download_url, '');
  }
});

test('rights labels are bounded and never invent Public Domain', async () => {
  const longRights = 'Copyright holder statement. '.repeat(30);
  const item = unresolvedItem('rights');
  const source = adapter({ getJson: async () => ({
    item: {
      id: 'http://www.loc.gov/item/rights/',
      access_restricted: false,
      rights: [longRights],
    },
    resources: [],
  }) });
  await source.resolveStream(item);
  assert.ok(item.license.length <= 240);
  assert.doesNotMatch(item.license, /public domain/i);

  const unknown = unresolvedItem('unknown-rights');
  const unknownSource = adapter({ getJson: async () => ({
    item: { id: 'http://www.loc.gov/item/unknown-rights/' }, resources: [],
  }) });
  await unknownSource.resolveStream(unknown);
  assert.equal(unknown.license, 'See LOC rights');
});

test('deep-page boundary returns a truthful refine state without an unsupported request loop', async () => {
  let calls = 0;
  const source = adapter({ getJson: async () => { calls += 1; throw new Error('must not request'); } });
  const boundaryCursor = {
    version: 1,
    query: '',
    nextLane: 'audio',
    lanes: {
      audio: { page: 3_334, exhausted: false, refineRequired: false },
      video: { page: 3_334, exhausted: false, refineRequired: false },
    },
  };
  const stopped = await source.browsePage({ cursor: boundaryCursor });
  assert.equal(stopped.exhausted, true);
  assert.equal(stopped.cursor, null);
  assert.deepEqual(stopped.refineRequired, ['audio', 'video']);
  assert.equal(calls, 0);

  const results = Array.from({ length: 30 }, (_, index) => summary('audio', `deep-${index}`));
  const edge = adapter({ getJson: async () => page('audio', 3_333, {
    from: 99_961,
    to: 99_990,
    total: 100_001,
    results,
    hasNext: true,
  }) });
  const cursor = {
    version: 1,
    query: '',
    nextLane: 'audio',
    lanes: {
      audio: { page: 3_333, exhausted: false, refineRequired: false },
      video: { page: 1, exhausted: false, refineRequired: false },
    },
  };
  const edgePage = await edge.browsePage({ cursor });
  assert.deepEqual(edgePage.refineRequired, ['audio']);
  assert.equal(edgePage.cursor.lanes.audio.exhausted, true);
  assert.equal(edgePage.cursor.nextLane, 'video');
});

test('catalog/detail caching and random reservoir avoid uncontrolled repeated LOC requests', async () => {
  let catalogCalls = 0;
  let detailCalls = 0;
  const source = adapter({
    random: () => 0.25,
    getJson: async (input) => {
      const url = new URL(input);
      if (url.pathname.startsWith('/item/')) {
        detailCalls += 1;
        const key = url.pathname.split('/').filter(Boolean).at(-1);
        return {
          item: { id: `http://www.loc.gov/item/${key}/`, access_restricted: true },
          resources: [],
        };
      }
      catalogCalls += 1;
      const lane = url.pathname.startsWith('/audio') ? 'audio' : 'video';
      return page(lane, 1, { total: 12, results: Array.from(
        { length: 12 }, (_, index) => summary(lane, index),
      ) });
    },
  });
  assert.equal((await source.browsePage()).items.length, 12);
  assert.equal((await source.browsePage()).items.length, 12);
  assert.equal(catalogCalls, 1);
  assert.equal((await source.random({ limit: 5 })).length, 5);
  assert.equal((await source.random({ limit: 5 })).length, 5);
  assert.equal(catalogCalls, 1);
  assert.equal(detailCalls, 0, 'random returns summaries and resolves no unselected item');

  const first = unresolvedItem('cached-detail');
  const second = unresolvedItem('cached-detail');
  await source.resolveStream(first);
  await source.resolveStream(second);
  assert.equal(detailCalls, 1);
});

test('artwork uses only a scoped opaque relay and favorites persist canonical rehydration metadata', async () => {
  const registrations = [];
  const source = adapter({
    registerCatalogAsset: async (request) => {
      registrations.push(request);
      return { relay_url: `/api/v1/assets/loc_asset_${String(registrations.length).padStart(16, '0')}` };
    },
    getJson: async () => structuredClone(fixture.videoPage),
  });
  const item = (await source.browsePage({ cursor: {
    version: 1,
    query: '',
    nextLane: 'video',
    lanes: {
      audio: { page: 1, exhausted: false, refineRequired: false },
      video: { page: 1, exhausted: false, refineRequired: false },
    },
  } })).items[0];
  assert.equal(item.thumbnail, '');
  assert.equal(item._extra.artworkUrl, fixture.videoPage.results[0].image_url[0]);
  await source.resolveArtwork(item);
  assert.match(item.thumbnail, /^\/api\/v1\/assets\/loc_asset_/);
  assert.deepEqual(registrations[0], {
    url: fixture.videoPage.results[0].image_url[0],
    sourceId: id,
    itemId: 'library-of-congress:fixture-video-1',
  });
  const saved = normalizeFavoriteItem({ futureField: { keep: true }, ...item });
  assert.equal(saved.thumbnail, '');
  assert.equal(saved._extra.artworkUrl, fixture.videoPage.results[0].image_url[0]);
  assert.equal(saved._extra.needsArtwork, true);
  assert.deepEqual(saved.futureField, { keep: true });
  assert.doesNotMatch(JSON.stringify(saved), /loc_asset_/);
});

test('aborted in-flight cache generations are isolated and queued callers recover cleanly', async () => {
  let calls = 0;
  const source = adapter({
    getJson: async (input, options) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          if (options.signal?.aborted) cancel();
          else options.signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      return page('audio', 1, { total: 1 });
    },
  });
  const oldController = new AbortController();
  const old = source.browsePage({ signal: oldController.signal });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  oldController.abort();
  const fresh = source.browsePage({ signal: new AbortController().signal });
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal((await fresh).items.length, 1);
  assert.equal(calls, 2);
});
