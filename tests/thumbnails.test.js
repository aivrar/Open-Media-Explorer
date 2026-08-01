import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTWORK_IMAGE_MAX_CONCURRENT,
  ARTWORK_MAX_CONCURRENT,
  ARTWORK_TASK_TIMEOUT_MS,
  createTaskQueue,
  isValidThumbnailUrl,
  resolveItemArtwork,
  retryArtworkLookup,
  THUMBNAIL_EAGER_CARD_COUNT,
  THUMBNAIL_PREFETCH_MARGIN_PX,
} from '../src/modes/library/thumbnails.js';
import {
  artworkRequests, canonicalArtworkUrl, isArtworkRelayUrl, resolveArtworkRelay,
} from '../src/lib/artwork.js';
import { thumbHydration } from '../src/modes/library/state.js';

const realFetch = globalThis.fetch;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('LibriVox requests and maps catalog cover art without an RSS lookup', async () => {
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return json({
      books: [{
        id: '52',
        title: 'Letters of Two Brides',
        url_rss: 'https://librivox.org/rss/52',
        coverart_thumbnail: 'https://archive.org/download/covers/book_thumb.jpg',
        coverart_jpg: 'https://archive.org/download/covers/book.jpg',
      }],
    });
  };

  const librivox = await import(`../src/adapters/librivox.js?covers=${Date.now()}`);
  const page = await librivox.browsePage({ limit: 30 });
  const searched = await librivox.search('Letters', { limit: 10 });

  assert.equal(page.items[0].thumbnail, 'https://archive.org/download/covers/book_thumb.jpg');
  assert.equal(searched[0].thumbnail, 'https://archive.org/download/covers/book_thumb.jpg');
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.searchParams.get('coverart') === '1'));
  assert.ok(urls.every((url) => !url.pathname.startsWith('/rss/')));
});

test('artwork queue caps concurrency and lets visible work jump queued prefetches', async () => {
  const queue = createTaskQueue(2);
  const started = [];
  const releases = new Map();
  let active = 0;
  let peak = 0;

  const makeTask = (name) => () => new Promise((resolve) => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(name);
    releases.set(name, () => {
      active -= 1;
      resolve(name);
    });
  });

  const first = queue.enqueue(makeTask('first'), 0);
  const second = queue.enqueue(makeTask('second'), 0);
  const prefetched = queue.enqueue(makeTask('prefetched'), 0);
  const visible = queue.enqueue(makeTask('visible'), 10);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ['first', 'second']);
  releases.get('first')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second', 'visible']);
  assert.equal(peak, 2);

  releases.get('visible')();
  await new Promise((resolve) => setImmediate(resolve));
  releases.get('prefetched')();
  releases.get('second')();
  await Promise.all([first, second, prefetched, visible]);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
});

test('artwork queue lowers its live limit during playback and restores it immediately', async () => {
  const queue = createTaskQueue(2);
  const started = [];
  const releases = new Map();
  const task = (name) => () => new Promise((resolve) => {
    started.push(name);
    releases.set(name, resolve);
  });
  const jobs = ['one', 'two', 'three', 'four'].map((name) => queue.enqueue(task(name)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two']);

  queue.setLimit(1);
  releases.get('one')('one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two']);
  releases.get('two')('two');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two', 'three']);

  queue.setLimit(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two', 'three', 'four']);
  releases.get('three')('three');
  releases.get('four')('four');
  await Promise.all(jobs);
});

test('aborting a view removes its queued artwork work immediately', async () => {
  const queue = createTaskQueue(1);
  let release;
  const active = queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const queued = queue.enqueue(() => 'should never start', 0, { signal: controller.signal });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.pendingCount, 1);

  controller.abort('view changed');
  await assert.rejects(queued, (error) => error?.name === 'AbortError');
  assert.equal(queue.pendingCount, 0);

  release();
  await active;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.activeCount, 0);
});

test('production artwork lanes are wider, prefetch ahead, and cannot hang forever', async () => {
  assert.equal(ARTWORK_MAX_CONCURRENT, 12);
  assert.equal(ARTWORK_IMAGE_MAX_CONCURRENT, 8);
  assert.equal(ARTWORK_TASK_TIMEOUT_MS, 25_000);
  assert.equal(THUMBNAIL_EAGER_CARD_COUNT, 24);
  assert.equal(THUMBNAIL_PREFETCH_MARGIN_PX, 1_800);

  let aborted = false;
  const item = {
    id: `nasa:hung-art-${Date.now()}`,
    source: 'nasa',
    thumbnail: 'https://images.example.test/hung.jpg',
    _extra: {},
  };
  await assert.rejects(() => resolveArtworkRelay(item, {
    taskTimeoutMs: 5,
    registerAssetImpl: async (_scope, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  }), (error) => error?.name === 'TimeoutError');
  assert.equal(aborted, true);
  assert.equal(artworkRequests.size, 0);
});

test('a new view does not inherit an aborted artwork registration', async () => {
  const sourceId = `nasa:aborted-scope-${Date.now()}`;
  const first = {
    id: sourceId,
    source: 'nasa',
    thumbnail: 'https://images.example.test/aborted-scope.jpg',
    _extra: {},
  };
  const next = {
    id: sourceId,
    source: 'nasa',
    thumbnail: 'https://images.example.test/aborted-scope.jpg',
    _extra: {},
  };
  const controller = new AbortController();
  let firstStarted;
  const oldWork = resolveArtworkRelay(first, {
    signal: controller.signal,
    registerAssetImpl: async (_scope, { signal }) => new Promise((_resolve, reject) => {
      firstStarted = true;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstStarted, true);

  controller.abort('old view closed');
  const newWork = resolveArtworkRelay(next, {
    registerAssetImpl: async () => ({
      relay_url: '/api/v1/assets/opaque_asset_000000000099',
    }),
  });

  await assert.rejects(oldWork, (error) => error?.name === 'AbortError');
  await newWork;
  assert.equal(next.thumbnail, '/api/v1/assets/opaque_asset_000000000099');
  assert.equal(artworkRequests.size, 0);
});

test('artwork retry uses bounded backoff for transient errors only', async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await retryArtworkLookup(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('temporary'), { status: 502 });
    return 'ok';
  }, {
    baseMs: 10,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);

  let permanentAttempts = 0;
  await assert.rejects(() => retryArtworkLookup(async () => {
    permanentAttempts += 1;
    throw Object.assign(new Error('missing'), { status: 404 });
  }, { sleep: async () => {} }), /missing/);
  assert.equal(permanentAttempts, 1);
});

test('invalid thumbnail values do not suppress fallback and in-flight entries are cleaned', async () => {
  assert.equal(isValidThumbnailUrl('null'), false);
  assert.equal(isValidThumbnailUrl('undefined'), false);
  assert.equal(isValidThumbnailUrl('data:image/png;base64,abc'), false);
  assert.equal(isValidThumbnailUrl('/api/v1/assets/opaque_asset_000000000001'), true);
  assert.equal(isValidThumbnailUrl('/api/v1/assets/too-short'), false);
  assert.equal(isValidThumbnailUrl('/api/v1/other/opaque_asset_000000000001'), false);
  assert.equal(isValidThumbnailUrl('/relative/provider/image.jpg'), false);
  assert.equal(isValidThumbnailUrl('https://example.com/art.jpg'), false);

  const item = {
    id: 'nasa:invalid-thumb',
    source: 'nasa',
    thumbnail: 'null',
  };
  await resolveItemArtwork(item);
  assert.equal(item.thumbnail, '');
  assert.equal(thumbHydration.requests.size, 0);
});

test('failed hydration is retried, rejected, and removed from the in-flight map', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return json({ error: 'temporary' }, 502);
  };
  const item = {
    id: `librivox:failed-${Date.now()}`,
    source: 'librivox',
    thumbnail: '',
    _extra: { rssUrl: `https://librivox.org/rss/failed-${Date.now()}` },
  };

  await assert.rejects(() => resolveItemArtwork(item, {
    retry: { sleep: async () => {} },
  }), /HTTP 502/);
  assert.equal(calls, 3);
  assert.equal(thumbHydration.requests.size, 0);
});

test('remote artwork becomes an opaque relay before it is displayable', async () => {
  const calls = [];
  const item = {
    id: 'radio-browser:relay-art',
    source: 'radio-browser',
    thumbnail: '//cdn.example.test/logo.png',
    _extra: {},
  };

  assert.equal(isArtworkRelayUrl(item.thumbnail), false);
  await resolveArtworkRelay(item, {
    registerAssetImpl: async (scope) => {
      calls.push(scope);
      return { relay_url: '/api/v1/assets/opaque_asset_000000000002' };
    },
  });

  assert.deepEqual(calls, [{
    url: 'https://cdn.example.test/logo.png',
    sourceId: item.source,
    itemId: item.id,
  }]);
  assert.equal(item.thumbnail, '/api/v1/assets/opaque_asset_000000000002');
  assert.equal(item._extra.artworkUrl, 'https://cdn.example.test/logo.png');
  assert.equal(isValidThumbnailUrl(item.thumbnail), true);
  assert.equal(artworkRequests.size, 0);
});

test('rejected artwork is never persisted or displayed and remains retryable', async () => {
  const item = {
    id: 'iptv-org:private-art',
    source: 'iptv-org',
    thumbnail: 'http://127.0.0.1/private.png',
    _extra: {},
  };
  await assert.rejects(() => resolveArtworkRelay(item, {
    registerAssetImpl: async () => {
      throw Object.assign(new Error('private target rejected'), { status: 400 });
    },
  }), /private target rejected/);
  assert.equal(item.thumbnail, '');
  assert.equal(item._extra.artworkUrl, undefined);
  assert.equal(artworkRequests.size, 0);

  await resolveArtworkRelay(item, {
    registerAssetImpl: async () => ({
      relay_url: '/api/v1/assets/opaque_asset_000000000003',
    }),
  });
  assert.equal(item.thumbnail, '/api/v1/assets/opaque_asset_000000000003');
  assert.equal(artworkRequests.size, 0);
});

test('same item consumers share one artwork registration and receive the relay', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const make = () => ({
    id: 'nasa:shared-art', source: 'nasa',
    thumbnail: 'https://images.example.test/shared.jpg', _extra: {},
  });
  const first = make();
  const second = make();
  const registerAssetImpl = async () => {
    calls += 1;
    await gate;
    return { relay_url: '/api/v1/assets/opaque_asset_000000000004' };
  };
  const one = resolveArtworkRelay(first, { registerAssetImpl });
  const two = resolveArtworkRelay(second, { registerAssetImpl });
  release();
  await Promise.all([one, two]);

  assert.equal(calls, 1);
  assert.equal(first.thumbnail, '/api/v1/assets/opaque_asset_000000000004');
  assert.equal(second.thumbnail, '/api/v1/assets/opaque_asset_000000000004');
  assert.equal(artworkRequests.size, 0);
});

test('artwork URL canonicalization rejects non-web and credentialed metadata', () => {
  assert.equal(canonicalArtworkUrl('javascript:alert(1)'), '');
  assert.equal(canonicalArtworkUrl('data:image/png;base64,abc'), '');
  assert.equal(canonicalArtworkUrl('https://user:pass@example.test/a.png'), '');
  assert.equal(canonicalArtworkUrl('https://example.test\\evil.test/a.png'), '');
  assert.equal(canonicalArtworkUrl('https://example.test/a.png'), 'https://example.test/a.png');
});
