import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  boundedPlainText,
  catalogPolicy,
  createMediaCccAdapter,
  id,
  itemTypes,
  MEDIA_CCC_GRAPHQL_URL,
  MEDIA_CCC_LIVE_URL,
  MEDIA_CCC_SEARCH_QUERY,
  parseLinkHeader,
} from '../src/adapters/media-ccc.js';
import { ProviderError } from '../src/lib/http.js';
import { validateItem } from '../src/lib/item-model.js';
import { resolveMediaAction } from '../src/lib/media-capabilities.js';
import { normalizeFavoriteItem } from '../src/lib/state.js';
import { SOURCES } from '../src/lib/sources.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/five-new-sources/media-ccc.json', import.meta.url),
  'utf8',
));

function event(number, overrides = {}) {
  return {
    guid: `event-${number}`,
    title: `Conference event ${number}`,
    slug: `conference-event-${number}`,
    description: `<p>Description <strong>${number}</strong></p>`,
    original_language: 'eng',
    release_date: '2026-07-10T00:00:00Z',
    tags: ['fixture'],
    persons: ['Speaker'],
    thumb_url: `https://static.media.ccc.de/media/events/${number}/thumb.jpg`,
    frontend_link: `https://media.ccc.de/v/conference-event-${number}`,
    ...overrides,
  };
}

function metadata(events, link) {
  return { data: { events }, status: 200, headers: { link, etag: '', lastModified: '' } };
}

function adapter(dependencies = {}) {
  return createMediaCccAdapter({
    minIntervalMs: 0,
    maxConcurrent: 2,
    ...dependencies,
  });
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
      for (let index = 0; index < 10; index++) await Promise.resolve();
    }
    this.time = target;
    for (let index = 0; index < 10; index++) await Promise.resolve();
  }
}

test('standard exports are registered in Phase 8 and declare provider limits', () => {
  assert.equal(id, 'media-ccc');
  assert.deepEqual(itemTypes, ['video', 'audio', 'tv', 'radio']);
  assert.deepEqual(catalogPolicy, { maxConcurrent: 2, minIntervalMs: 500 });
  assert.equal(SOURCES.some((source) => source.id === id), true);
});

test('RFC Link parsing follows rel names, quoted relation sets, and commas inside targets', () => {
  const parsed = parseLinkHeader(
    '<https://api.media.ccc.de/public/events/recent?page=168>; rel="last", '
    + '<https://api.media.ccc.de/public/events/recent?page=2&fixture=a,b>; title="next, page"; rel="next alternate"',
  );
  assert.equal(parsed.last, 'https://api.media.ccc.de/public/events/recent?page=168');
  assert.equal(parsed.next, 'https://api.media.ccc.de/public/events/recent?page=2&fixture=a,b');
  assert.equal(parsed.alternate, parsed.next);
  assert.deepEqual({ ...parseLinkHeader('not a valid link') }, {});
  assert.deepEqual({ ...parseLinkHeader('<https://evil.example/x>; rel="next\rbroken"') }, {});
});

test('100-event upstream pages become exact 30-item pages without refetches or duplicate GUIDs', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, (_, index) => event(index));
  const second = [event(99), ...Array.from({ length: 34 }, (_, index) => event(index + 100))];
  const source = adapter({
    getJsonWithMetadata: async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return metadata(first,
        '<https://api.media.ccc.de/public/events/recent?page=9>; rel="last", '
        + '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next"');
      if (page === 2) return metadata(second,
        '<https://api.media.ccc.de/public/events/recent?page=1>; rel="first prev"');
      throw new Error(`unexpected page ${page}`);
    },
  });

  const pages = [];
  let cursor = null;
  for (let index = 0; index < 5; index++) {
    const page = await source.browsePage({ limit: 30, cursor });
    pages.push(page);
    cursor = page.cursor;
  }
  assert.deepEqual(pages.map((page) => page.items.length), [30, 30, 30, 30, 14]);
  assert.deepEqual(pages.map((page) => page.exhausted), [false, false, false, false, true]);
  const ids = pages.flatMap((page) => page.items.map((item) => item.id));
  assert.equal(ids.length, 134);
  assert.equal(new Set(ids).size, 134);
  assert.equal(ids.filter((itemId) => itemId === 'media-ccc:event-99').length, 1);
  assert.deepEqual(calls, [
    'https://api.media.ccc.de/public/events/recent?page=1',
    'https://api.media.ccc.de/public/events/recent?page=2',
  ]);
});

test('failed page bridging is transactional and a retry cannot lose staged catalog items', async () => {
  const first = Array.from({ length: 100 }, (_, index) => event(index));
  const second = Array.from({ length: 40 }, (_, index) => event(index + 100));
  let secondPageCalls = 0;
  const source = adapter({
    getJsonWithMetadata: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return metadata(
        first,
        '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next"',
      );
      secondPageCalls += 1;
      if (secondPageCalls === 1) throw new Error('temporary page two failure');
      return metadata(
        second,
        '<https://api.media.ccc.de/public/events/recent?page=2>; rel="last"',
      );
    },
  });

  let cursor = null;
  for (let index = 0; index < 3; index++) {
    cursor = (await source.browsePage({ cursor })).cursor;
  }
  await assert.rejects(source.browsePage({ cursor }), /temporary page two failure/);
  const retried = await source.browsePage({ cursor });
  assert.deepEqual(
    retried.items.map((item) => item.id),
    Array.from({ length: 30 }, (_, index) => `media-ccc:event-${index + 90}`),
  );
  assert.equal(secondPageCalls, 2);
});

test('non-cursor browse calls do not allocate sessions or evict an active Library cursor', async () => {
  const source = adapter({
    getJsonWithMetadata: async () => metadata(
      Array.from({ length: 100 }, (_, index) => event(index)),
      '<https://api.media.ccc.de/public/events/recent?page=1>; rel="last"',
    ),
  });
  const first = await source.browsePage();
  for (let index = 0; index < 8; index++) {
    assert.equal((await source.browse()).length, 30);
  }
  const continued = await source.browsePage({ cursor: first.cursor });
  assert.equal(continued.items[0].id, 'media-ccc:event-30');
});

test('browse rejects missing, hostile, and nonadvancing pagination instead of claiming completion', async () => {
  for (const link of [
    '',
    '<https://evil.example/recent?page=2>; rel="next"',
    '<https://api.media.ccc.de/public/events/recent?page=1>; rel="next"',
  ]) {
    const source = adapter({
      getJsonWithMetadata: async () => metadata([event(1)], link),
    });
    await assert.rejects(source.browsePage({ limit: 1 }), /pagination|next-page/i);
  }
  const empty = adapter({
    getJsonWithMetadata: async () => metadata(
      [], '<https://api.media.ccc.de/public/events/recent?page=1>; rel="last"',
    ),
  });
  await assert.rejects(empty.browsePage(), /suspicious empty/i);

  const prematureCompletion = adapter({
    getJsonWithMetadata: async () => metadata(
      [event(1)], '<https://api.media.ccc.de/public/events/recent?page=2>; rel="last"',
    ),
  });
  await assert.rejects(prematureCompletion.browsePage({ limit: 1 }), /next-page/i);
});

test('provider gate spaces starts and never exceeds two active metadata requests', async () => {
  const clock = new FakeClock();
  const gates = [deferred(), deferred(), deferred()];
  const starts = [];
  let request = 0;
  const source = createMediaCccAdapter({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    minIntervalMs: 500,
    maxConcurrent: 2,
    postJson: async () => {
      const index = request++;
      starts.push({ index, at: clock.time });
      await gates[index].promise;
      return { data: { lectureSearch: [] } };
    },
    getJson: async () => {
      const index = request++;
      starts.push({ index, at: clock.time });
      await gates[index].promise;
      return [];
    },
  });
  const pending = [source.search('one'), source.search('two'), source.refreshSnapshot()];
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(starts, [{ index: 0, at: 0 }]);
  await clock.advance(499);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.deepEqual(starts, [{ index: 0, at: 0 }, { index: 1, at: 500 }]);
  await clock.advance(500);
  assert.equal(starts.length, 2, 'third request must wait for an active slot');
  gates[0].resolve();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(starts, [
    { index: 0, at: 0 }, { index: 1, at: 500 }, { index: 2, at: 1000 },
  ]);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(pending);
});

test('VOD summaries strip bounded HTML, tolerate null dates, skip bad IDs, and validate strictly', async () => {
  const valid = event(1, {
    description: '<p>Hello&nbsp;<strong>world</strong></p><script>doBadThing()</script><div>Next &amp; final</div>',
    release_date: null,
    date: null,
    tags: ['fixture', null, { name: 'Systems' }, 'fixture'],
    persons: [null, 'Speaker'],
  });
  const source = adapter({
    getJsonWithMetadata: async () => metadata(
      [valid, valid, { title: 'missing identity' }, null],
      '<https://api.media.ccc.de/public/events/recent?page=1>; rel="last"',
    ),
  });
  const page = await source.browsePage();
  assert.equal(page.exhausted, true);
  assert.equal(page.items.length, 1);
  const [item] = page.items;
  assert.equal(item.description, 'Hello world\nNext & final');
  assert.doesNotMatch(item.description, /script|doBadThing|<|>/i);
  assert.equal(item.year, null);
  assert.deepEqual(item.tags, ['fixture', 'Systems', 'Speaker']);
  assert.equal(item.thumbnail, '', 'dynamic image must not load directly');
  assert.equal(item._extra.artworkUrl, valid.thumb_url);
  assert.equal(item.license, 'See event license');
  assert.deepEqual(validateItem(item), []);
  assert.equal(boundedPlainText('x'.repeat(20_000)).length, 2_000);
});

test('GraphQL search is fixed and parameterized; success, empty, provider, schema, and transport states differ', async () => {
  const calls = [];
  const source = adapter({
    postJson: async (url, body) => {
      calls.push({ url, body });
      if (body.variables.query === 'linux') return structuredClone(fixture.graphqlSearch);
      if (body.variables.query === 'empty') return { data: { lectureSearch: [] } };
      if (body.variables.query === 'provider') return structuredClone(fixture.graphqlError);
      if (body.variables.query === 'schema') return { data: { lectureSearch: null } };
      throw new Error('transport fixture');
    },
    getJson: async () => { throw new Error('REST search must never run'); },
  });

  const found = await source.search('linux', { page: 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'media-ccc:fixture-ccc-search-1');
  assert.deepEqual(await source.search('empty'), []);
  await assert.rejects(source.search('provider'), ProviderError);
  await assert.rejects(source.search('schema'), /invalid schema/i);
  await assert.rejects(source.search('transport'), /transport fixture/);
  assert.equal(calls[0].url, MEDIA_CCC_GRAPHQL_URL);
  assert.equal(calls[0].body.query, MEDIA_CCC_SEARCH_QUERY);
  assert.deepEqual(calls[0].body.variables, { query: 'linux', page: 2 });
  assert.doesNotMatch(calls[0].body.query, /linux/);
});

test('an aborted search cache entry cannot poison a new identical search generation', async () => {
  let calls = 0;
  const source = adapter({
    postJson: async (_url, _body, options) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('cancelled generation'), { name: 'AbortError' }));
          if (options.signal?.aborted) fail();
          else options.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      return { data: { lectureSearch: [event(500)] } };
    },
  });
  const oldController = new AbortController();
  const oldSearch = source.search('same query', { signal: oldController.signal });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  oldController.abort();
  const newController = new AbortController();
  const fresh = source.search('same query', { signal: newController.signal });
  await assert.rejects(oldSearch, { name: 'AbortError' });
  const results = await fresh;
  assert.equal(calls, 2);
  assert.equal(results[0].id, 'media-ccc:event-500');
});

test('oversized provider collections fail within documented processing bounds', async () => {
  const searchSource = adapter({
    postJson: async () => ({
      data: { lectureSearch: Array.from({ length: 101 }, (_, index) => event(index)) },
    }),
  });
  await assert.rejects(searchSource.search('oversized'), /result bound/);

  const detailSource = adapter({
    postJson: async () => ({ data: { lectureSearch: [event(1)] } }),
    getJson: async () => ({
      guid: 'event-1',
      recordings: Array.from({ length: 257 }, () => ({
        mime_type: 'video/mp4', language: 'eng', recording_url: 'https://cdn.media.ccc.de/a.mp4',
      })),
    }),
  });
  const [detailItem] = await detailSource.search('detail');
  await assert.rejects(detailSource.resolveStream(detailItem), /recordings exceeded/);
  assert.equal(detailItem._extra.needsResolve, true);

  const livePayload = structuredClone(fixture.liveNonEmpty);
  livePayload[0].groups[0].rooms[0].streams = Array.from(
    { length: 65 },
    (_, index) => ({
      slug: `stream-${index}`,
      type: 'video',
      urls: { hls: { url: `https://cdn.c3voc.de/${index}.m3u8` } },
    }),
  );
  const liveSource = adapter({ getJson: async () => livePayload });
  await assert.rejects(liveSource.refreshSnapshot(), /stream collection exceeded/);
});

test('lazy VOD resolution selects one original-language MP4 and couples play/download fields', async () => {
  let details = 0;
  const source = adapter({
    postJson: async () => structuredClone(fixture.graphqlSearch),
    getJson: async (url) => {
      details += 1;
      assert.equal(url, 'https://api.media.ccc.de/public/events/fixture-ccc-search-1');
      return {
        ...structuredClone(fixture.detail),
        guid: 'fixture-ccc-search-1',
        license: 'CC BY 4.0',
      };
    },
  });
  const [item] = await source.search('linux');
  assert.equal(item.stream_url, '');
  assert.equal(item._extra.needsResolve, true);
  await source.resolveStream(item);
  assert.equal(details, 1);
  assert.equal(item.type, 'video');
  assert.equal(item.stream_kind, 'video');
  assert.equal(item.delivery, 'on-demand');
  assert.equal(item.stream_url, fixture.detail.recordings[0].recording_url);
  assert.equal(item.download_url, item.stream_url);
  assert.equal(item.download_name, 'fixture-open-systems-hd.mp4');
  assert.equal(item.license, 'CC BY 4.0');
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'playable');
  assert.equal(resolveMediaAction(item), 'download');
  await source.resolveStream(item);
  assert.equal(details, 1, 'resolved items and detail cache must not refetch');
  const restarted = normalizeFavoriteItem(item, { restart: true });
  assert.equal(restarted.stream_url, '');
  assert.equal(restarted._extra.needsResolve, true);
  await source.resolveStream(restarted);
  assert.equal(restarted.stream_url, item.stream_url);
  assert.equal(resolveMediaAction(restarted), 'download');
  assert.equal(details, 1, 'restart re-resolution may reuse validated adapter metadata');
  assert.deepEqual(validateItem(item), []);
});

test('lazy VOD resolution falls back to original MP3, suppresses translated encodings, and handles no resource', async () => {
  const searchPayload = { data: { lectureSearch: [
    { guid: 'audio-only', title: 'Audio only', slug: 'audio-only' },
    { guid: 'no-resource', title: 'No resource', slug: 'no-resource' },
  ] } };
  const source = adapter({
    postJson: async () => searchPayload,
    getJson: async (url) => {
      if (url.endsWith('/no-resource')) return { guid: 'no-resource', original_language: 'eng' };
      return {
        guid: 'audio-only',
        original_language: 'eng',
        recordings: [
          { mime_type: 'video/mp4', language: 'deu', filename: 'translated.mp4', recording_url: 'https://cdn.media.ccc.de/translated.mp4' },
          { mime_type: 'video/webm', language: 'eng', filename: 'native.webm', recording_url: 'https://cdn.media.ccc.de/native.webm' },
          { mime_type: 'audio/mpeg', language: 'eng', filename: 'official-native.mp3', recording_url: 'https://cdn.media.ccc.de/official-native.mp3' },
        ],
      };
    },
  });
  const [audio] = await source.search('audio');
  await source.resolveStream(audio);
  assert.equal(audio.type, 'audio');
  assert.equal(audio.stream_kind, 'audio');
  assert.equal(audio.stream_url, 'https://cdn.media.ccc.de/official-native.mp3');
  assert.equal(audio.download_name, 'official-native.mp3');

  const none = (await source.search('none', { page: 2 }))
    .find((item) => item.id === 'media-ccc:no-resource');
  assert.ok(none);
  await source.resolveStream(none);
  assert.equal(none.stream_url, '');
  assert.equal(none.download_url, '');
  assert.equal(none._extra.needsResolve, false);
  assert.equal(none._extra.downloadResolved, true);
  assert.equal(none._extra.resolutionStatus, 'unavailable');
  assert.equal(resolveMediaAction(none), 'unavailable');
});

test('invalid saved VOD identity settles unavailable instead of checking forever', async () => {
  const source = adapter();
  const item = {
    id: 'media-ccc:bad identity',
    source: 'media-ccc',
    delivery: 'on-demand',
    stream_url: '',
    download_url: '',
    download_name: '',
    capture_headers: {},
    _extra: { guid: 'bad identity', needsResolve: true },
  };
  await source.resolveStream(item);
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'unavailable');
  assert.equal(item._extra.validationError, 'MEDIA_CCC_IDENTITY_INVALID');
  assert.equal(resolveMediaAction(item), 'unavailable');
});

test('malformed recording collections remain retryable failures and unsupported files never masquerade as playable', async () => {
  const source = adapter({
    postJson: async () => ({ data: { lectureSearch: [{ guid: 'bad-recordings', title: 'Bad', slug: 'bad' }] } }),
    getJson: async () => ({ guid: 'bad-recordings', original_language: 'eng', recordings: {} }),
  });
  const [item] = await source.search('bad');
  await assert.rejects(source.resolveStream(item), /recordings are malformed/);
  assert.equal(item._extra.needsResolve, true);
  assert.equal(item.stream_url, '');
});

test('live snapshot prefers native HLS, emits deterministic room IDs, and does not duplicate its audio rendition', async () => {
  let calls = 0;
  const source = adapter({
    getJson: async (url) => {
      calls += 1;
      assert.equal(url, MEDIA_CCC_LIVE_URL);
      return structuredClone(fixture.liveNonEmpty);
    },
  });
  const first = await source.refreshSnapshot();
  const second = await source.refreshSnapshot();
  assert.equal(calls, 1, 'live TTL must coalesce/reuse an immediate refresh');
  assert.deepEqual(second, first);
  assert.equal(first.items.length, 1);
  const [item] = first.items;
  assert.equal(item.id, 'media-ccc:live:fixture-live/hall-a/native');
  assert.equal(item.type, 'tv');
  assert.equal(item.stream_kind, 'hls');
  assert.equal(item.stream_url, 'https://cdn.c3voc.de/hls/fixture-hall-a-native.m3u8');
  assert.equal(item.delivery, 'live');
  assert.equal(item.download_url, '');
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'playable');
  assert.equal(item._extra.snapshotItem, true);
  assert.equal(first.refreshAfterMs, 60_000);
  assert.match(first.snapshotId, /^media-ccc-v2:[0-9a-f]{8}$/);
  assert.deepEqual(validateItem(item), []);
});

test('live favorites revalidate after restart and settle honestly when the room is gone', async () => {
  let livePayload = structuredClone(fixture.liveNonEmpty);
  const source = adapter({
    liveCacheTtlMs: 0,
    getJson: async () => structuredClone(livePayload),
  });
  const live = (await source.refreshSnapshot()).items[0];
  const favorite = normalizeFavoriteItem(live);
  assert.equal(favorite.id, live.id);
  assert.equal(favorite.stream_url, '');
  assert.equal(favorite._extra.needsResolve, true);
  assert.equal(favorite.source_url, live.source_url);

  await source.resolveStream(favorite);
  assert.equal(favorite.stream_url, live.stream_url);
  assert.equal(favorite._extra.needsResolve, false);
  assert.equal(favorite._extra.resolutionStatus, 'playable');
  assert.equal(resolveMediaAction(favorite), 'record-video');

  livePayload = [];
  const restarted = normalizeFavoriteItem(favorite);
  await source.resolveStream(restarted);
  assert.equal(restarted.stream_url, '');
  assert.equal(restarted._extra.needsResolve, false);
  assert.equal(restarted._extra.resolutionStatus, 'unavailable');
  assert.equal(restarted._extra.validationError, 'C3VOC_STREAM_OFFLINE');
  assert.equal(restarted.source_url, live.source_url);
  assert.equal(resolveMediaAction(restarted), 'unavailable');
});

test('audio-only rooms become radio; valid empty is independent; malformed nonempty data fails for stale recovery', async () => {
  const audioPayload = structuredClone(fixture.liveNonEmpty);
  audioPayload[0].groups[0].rooms[0].streams = [
    audioPayload[0].groups[0].rooms[0].streams[1],
  ];
  const audioSource = adapter({ getJson: async () => audioPayload });
  const audio = await audioSource.refreshSnapshot();
  assert.equal(audio.items.length, 1);
  assert.equal(audio.items[0].id, 'media-ccc:live:fixture-live/hall-a/native');
  assert.equal(audio.items[0].type, 'radio');
  assert.equal(audio.items[0].stream_kind, 'audio');
  assert.equal(audio.items[0].stream_url, 'https://cdn.c3voc.de/fixture-hall-a.mp3');

  const emptySource = adapter({ getJson: async () => structuredClone(fixture.liveEmpty) });
  assert.deepEqual(await emptySource.refreshSnapshot(), {
    items: [], snapshotId: 'media-ccc-v2:empty', refreshAfterMs: 60_000,
  });

  const malformed = adapter({ getJson: async () => [{ slug: 'schema-drift', groups: [] }] });
  await assert.rejects(malformed.refreshSnapshot(), /no usable rooms/i);
});

test('translated and slides streams are suppressed when a lower native HLS stream exists', async () => {
  const payload = structuredClone(fixture.liveNonEmpty);
  const room = payload[0].groups[0].rooms[0];
  room.streams = [
    {
      slug: 'translated', type: 'video', isTranslated: true, videoSize: [1920, 1080],
      urls: { hls: { url: 'https://cdn.c3voc.de/translated.m3u8' } },
    },
    {
      slug: 'slides', type: 'slides', isTranslated: false, videoSize: [1920, 1080],
      urls: { hls: { url: 'https://cdn.c3voc.de/slides.m3u8' } },
    },
    {
      slug: 'sd-native', type: 'video', isTranslated: false, videoSize: [640, 360],
      urls: { hls: { url: 'https://cdn.c3voc.de/native-low.m3u8' } },
    },
  ];
  const source = adapter({ getJson: async () => payload });
  const snapshot = await source.refreshSnapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].stream_url, 'https://cdn.c3voc.de/native-low.m3u8');
  assert.equal(snapshot.items[0].id, 'media-ccc:live:fixture-live/hall-a/native');
});

test('native audio is preferred over translated video unless translation is the only usable rendition', async () => {
  const payload = structuredClone(fixture.liveNonEmpty);
  const room = payload[0].groups[0].rooms[0];
  room.streams = [
    {
      slug: 'translated-video', type: 'video', isTranslated: true, videoSize: [1920, 1080],
      urls: { hls: { url: 'https://cdn.c3voc.de/translated.m3u8' } },
    },
    {
      slug: 'native-audio', type: 'audio', isTranslated: false,
      urls: { mp3: { url: 'https://cdn.c3voc.de/native.mp3' } },
    },
  ];
  const source = adapter({ getJson: async () => payload });
  const snapshot = await source.refreshSnapshot();
  assert.equal(snapshot.items[0].type, 'radio');
  assert.equal(snapshot.items[0].stream_url, 'https://cdn.c3voc.de/native.mp3');
  assert.equal(snapshot.items[0].id, 'media-ccc:live:fixture-live/hall-a/native');

  room.streams = [room.streams[0]];
  const translationOnly = adapter({ getJson: async () => payload });
  const fallback = await translationOnly.refreshSnapshot();
  assert.equal(fallback.items[0].type, 'tv');
  assert.equal(fallback.items[0].stream_url, 'https://cdn.c3voc.de/translated.m3u8');
});

test('artwork uses only the opaque relay while favorites persist canonical rehydration metadata', async () => {
  const registrations = [];
  const source = adapter({
    getJsonWithMetadata: async () => metadata(
      [structuredClone(fixture.recent.body.events[0])],
      '<https://api.media.ccc.de/public/events/recent?page=1>; rel="last"',
    ),
    registerCatalogAsset: async (request) => {
      registrations.push(request);
      return {
        asset_id: `opaque_asset_${String(registrations.length).padStart(16, '0')}`,
        relay_url: `/api/v1/assets/opaque_asset_${String(registrations.length).padStart(16, '0')}`,
      };
    },
  });
  const page = await source.browsePage();
  const item = page.items[0];
  assert.equal(item.thumbnail, '');
  assert.equal(item._extra.artworkUrl, fixture.recent.body.events[0].thumb_url);
  await source.resolveArtwork(item);
  assert.match(item.thumbnail, /^\/api\/v1\/assets\/opaque_asset_/);
  assert.deepEqual(registrations[0], {
    url: fixture.recent.body.events[0].thumb_url,
    sourceId: 'media-ccc',
    itemId: 'media-ccc:fixture-ccc-event-1',
  });

  const saved = normalizeFavoriteItem({ futureField: { keep: true }, ...item });
  assert.equal(saved.thumbnail, '');
  assert.equal(saved._extra.artworkUrl, fixture.recent.body.events[0].thumb_url);
  assert.equal(saved._extra.needsArtwork, true);
  assert.deepEqual(saved.futureField, { keep: true });
  assert.doesNotMatch(JSON.stringify(saved), /opaque_asset_/);
  await source.resolveArtwork(saved);
  assert.match(saved.thumbnail, /opaque_asset_0+2$/);
  assert.equal(registrations.length, 2);
});

test('cached random uses the recent reservoir instead of issuing one request per render', async () => {
  let calls = 0;
  const source = adapter({
    random: () => 0.25,
    getJsonWithMetadata: async () => {
      calls += 1;
      return metadata(
        Array.from({ length: 100 }, (_, index) => event(index)),
        '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next last"',
      );
    },
  });
  const first = await source.random({ limit: 12 });
  const second = await source.random({ limit: 12 });
  assert.equal(first.length, 12);
  assert.equal(second.length, 12);
  assert.equal(calls, 1);
});
