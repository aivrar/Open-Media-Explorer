import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  catalogPolicy,
  createGpodderAdapter,
  createGpodderDirectoryGate,
  createPodcastFeedScheduler,
  displayName,
  GPODDER_SEARCH_URL,
  GPODDER_TOPLIST_URL,
  id,
  isPodcastLiveNow,
  itemTypes,
  selectPodcastEnclosure,
} from '../src/adapters/gpodder.js';
import { HttpError, ProviderError } from '../src/lib/http.js';
import { validateItem } from '../src/lib/item-model.js';
import { resolveMediaAction } from '../src/lib/media-capabilities.js';
import { SOURCES } from '../src/lib/sources.js';
import { normalizeFavoriteItem } from '../src/lib/state.js';

const FIXED_NOW = Date.parse('2026-07-15T12:00:00Z');
const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
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
      await flush();
    }
    this.time = target;
    await flush();
  }
}

function show(number, overrides = {}) {
  const host = overrides.host || `feed-${number}.example.test`;
  const url = overrides.url || `https://${host}/show-${number}.xml`;
  return {
    url,
    title: overrides.title || `Fixture Show ${number}`,
    author: overrides.author || 'Fixture Publisher',
    description: overrides.description || `Show ${number} science and culture`,
    subscribers: 1_000 - number,
    logo_url: overrides.logo_url === undefined
      ? `https://images.example.test/show-${number}.jpg`
      : overrides.logo_url,
    scaled_logo_url: overrides.scaled_logo_url ?? null,
    website: overrides.website || `https://publisher.example.test/show-${number}`,
    mygpo_link: `https://gpodder.net/podcast/fixture-${number}`,
  };
}

function episode(identityUrl, number, overrides = {}) {
  const guid = overrides.guid || `episode-guid-${number}`;
  const type = overrides.type || 'audio/mpeg';
  const extension = overrides.extension || (type.startsWith('video/') ? 'mp4' : 'mp3');
  const mediaUrl = overrides.mediaUrl || `https://media.example.test/episode-${number}.${extension}`;
  return {
    stable_id: overrides.stable_id || sha256(`${identityUrl}\n${guid}`),
    guid,
    title: overrides.title || `Fixture science episode ${number}`,
    description: overrides.description || `<p>Episode ${number} &amp; useful notes.</p>`,
    published: overrides.published || `2025-05-${String((number % 27) + 1).padStart(2, '0')}T08:00:00Z`,
    language: overrides.language ?? 'en-US',
    content_rating: overrides.content_rating || 'not-explicit',
    artwork_url: overrides.artwork_url === undefined
      ? `https://images.example.test/episode-${number}.jpg`
      : overrides.artwork_url,
    homepage_url: overrides.homepage_url || `https://publisher.example.test/episodes/${number}`,
    ...(overrides.license ? { license: overrides.license } : {}),
    enclosures: overrides.enclosures || [{
      url: mediaUrl,
      type,
      relation: overrides.relation || 'enclosure',
    }],
    live: overrides.live === true,
    live_status: overrides.live_status || '',
    start: overrides.start || '',
    end: overrides.end || '',
  };
}

function feedFor(directoryShow, options = {}) {
  const requested = directoryShow.url;
  const resolved = options.resolvedFeedUrl || requested;
  const identity = options.identityUrl || resolved;
  const aliases = options.aliases || [...new Set([requested, resolved, identity])];
  const count = options.count ?? 9;
  const items = options.items || Array.from(
    { length: count },
    (_, index) => episode(identity, `${options.prefix || directoryShow.title}-${index + 1}`),
  );
  return {
    feed_url: options.feedUrl || requested,
    resolved_feed_url: resolved,
    feed_identity_url: identity,
    feed_aliases: aliases,
    title: options.title || directoryShow.title,
    description: options.description || '<p>Publisher description &amp; notes.</p>',
    language: options.language ?? 'en',
    artwork_url: options.artworkUrl === undefined
      ? directoryShow.logo_url
      : options.artworkUrl,
    homepage_url: options.homepageUrl || directoryShow.website,
    license: options.license || { label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    cache: options.cache || { state: 'updated', stale: false },
    items,
  };
}

function immediateDirectoryGate() {
  return {
    run: (task, signal) => task(signal),
    imposeCooldown() {},
    dispose() {},
  };
}

async function parseThroughBackend(fixtureName, requestedUrl) {
  const bridge = new URL('../tests_python/gpodder_adapter_bridge.py', import.meta.url);
  const { stdout } = await execFileAsync('python', [fileURLToPath(bridge), fixtureName, requestedUrl], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) {
    throw new ProviderError(envelope.error?.message || 'Podcast parser rejected the feed', {
      code: envelope.error?.code,
      status: envelope.error?.status,
    });
  }
  return envelope.value;
}

function adapter(options = {}) {
  return createGpodderAdapter({
    now: () => FIXED_NOW,
    hashText: async (value) => sha256(value),
    directoryGate: immediateDirectoryGate(),
    ...options,
  });
}

test('gPodder exports are registered in Phase 8', () => {
  assert.equal(id, 'gpodder');
  assert.equal(displayName, 'gPodder Podcasts');
  assert.deepEqual(itemTypes, ['audio', 'video', 'radio', 'tv']);
  assert.deepEqual(catalogPolicy, { maxConcurrent: 4, minIntervalMs: 0 });
  assert.equal(GPODDER_TOPLIST_URL, 'https://gpodder.net/toplist/100.json');
  assert.equal(GPODDER_SEARCH_URL, 'https://gpodder.net/search.json');
  assert.equal(SOURCES.some((source) => source.id === id), true);
});

test('the frozen cross-language stable identity vector is exact', async () => {
  const directoryShow = show(1, {
    url: 'https://feeds.example.invalid/open-show.xml',
  });
  const stable = 'ef126605d6aaef319471dedb122dfcb99c6e93749305ce447d73ae71147d9d41';
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, {
      items: [episode(directoryShow.url, 1, {
        guid: 'fixture-episode-guid-1',
        stable_id: stable,
      })],
    }),
  });
  const page = await source.browsePage();
  assert.equal(sha256(`${directoryShow.url}\nfixture-episode-guid-1`), stable);
  assert.equal(page.items[0].id, `gpodder:${stable}`);
  source.dispose();
});

test('directory gate enforces burst two, one-per-second refill, cooldown, abort, and disposal', async () => {
  const clock = new FakeClock();
  const gate = createGpodderDirectoryGate({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    capacity: 2,
    refillMs: 1_000,
  });
  const starts = [];
  const first = gate.run(async () => { starts.push(['first', clock.time]); return 1; });
  const second = gate.run(async () => { starts.push(['second', clock.time]); return 2; });
  const third = gate.run(async () => { starts.push(['third', clock.time]); return 3; });
  await flush();
  assert.deepEqual(starts, [['first', 0], ['second', 0]]);
  assert.equal(gate.pendingCount, 1);
  await clock.advance(999);
  assert.equal(starts.length, 2);
  await clock.advance(1);
  assert.deepEqual(starts[2], ['third', 1_000]);
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);

  gate.imposeCooldown(2_000);
  const controller = new AbortController();
  const cancelled = gate.run(async () => 4, controller.signal);
  controller.abort('generation changed');
  await assert.rejects(cancelled, { name: 'AbortError' });
  await clock.advance(2_000);
  assert.equal(gate.pendingCount, 0);
  gate.dispose();
  await assert.rejects(gate.run(async () => 5), { name: 'AbortError' });

  const disposable = createGpodderDirectoryGate({ capacity: 1, refillMs: 60_000 });
  const active = disposable.run((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const queued = disposable.run(async () => 'never');
  await flush();
  disposable.dispose('source disabled');
  await assert.rejects(active, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(disposable.pendingCount, 0);
  assert.equal(disposable.activeCount, 0);
});

test('publisher scheduler enforces global four/per-host one and aborts queued/active work', async () => {
  const scheduler = createPodcastFeedScheduler({ maxConcurrent: 4, perHost: 1 });
  const started = [];
  const controls = new Map();
  const work = (name, host) => scheduler.run(host, (signal) => {
    started.push(name);
    const hold = deferred();
    controls.set(name, hold);
    signal.addEventListener('abort', () => hold.reject(signal.reason), { once: true });
    return hold.promise;
  });
  const a1 = work('a1', 'same.example');
  const a2 = work('a2', 'same.example');
  const b = work('b', 'b.example');
  const c = work('c', 'c.example');
  const d = work('d', 'd.example');
  await flush();
  assert.deepEqual(new Set(started), new Set(['a1', 'b', 'c', 'd']));
  assert.equal(started.includes('a2'), false);
  assert.equal(scheduler.activeCount, 4);
  assert.equal(scheduler.activeHosts.get('same.example'), 1);
  controls.get('a1').resolve('a1');
  await a1;
  await flush();
  assert.equal(started.includes('a2'), true);
  controls.get('a2').resolve('a2');
  controls.get('b').resolve('b');
  controls.get('c').resolve('c');
  controls.get('d').resolve('d');
  assert.deepEqual(await Promise.all([a2, b, c, d]), ['a2', 'b', 'c', 'd']);
  await flush();
  assert.equal(scheduler.activeCount, 0);

  const active = work('active', 'active.example');
  const queued = work('queued', 'active.example');
  await flush();
  scheduler.dispose('source disabled');
  await assert.rejects(active, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(scheduler.run('new.example', async () => null), { name: 'AbortError' });
});

test('enclosure selection prefers standard/default media and rejects disagreement or unsupported codecs', () => {
  const selected = selectPodcastEnclosure([
    { url: 'https://media.example/alternate.mp3', type: 'audio/mpeg', relation: 'alternate' },
    { url: 'https://media.example/default.mp3', type: 'audio/mpeg', relation: 'enclosure' },
    { url: 'https://media.example/video.mp4', type: 'video/mp4', relation: 'alternate' },
  ]);
  assert.deepEqual(selected, {
    url: 'https://media.example/default.mp3',
    mediaType: 'audio',
    streamKind: 'audio',
    relation: 'enclosure',
    score: 1_880,
  });
  assert.equal(selectPodcastEnclosure([
    { url: 'https://media.example/wrong.mp4', type: 'audio/mpeg' },
    { url: 'https://media.example/file.webm', type: 'video/webm' },
  ]), null);
  assert.equal(selectPodcastEnclosure(Array.from({ length: 17 }, () => ({
    url: 'https://media.example/item.mp3', type: 'audio/mpeg',
  }))), null);
  assert.equal(selectPodcastEnclosure([
    { url: 'https://media.example/live.mp3', type: 'audio/mpeg' },
    { url: 'https://media.example/live.m3u8', type: 'audio/mpegurl' },
  ], { live: true }).streamKind, 'hls');
  assert.equal(selectPodcastEnclosure([
    { url: 'https://media.example/default.mp3', type: 'audio/mpeg', relation: 'enclosure' },
    { url: 'https://media.example/preferred.mp4', type: 'video/mp4', relation: 'alternate', default: true },
  ]).url, 'https://media.example/preferred.mp4');
  assert.equal(selectPodcastEnclosure([
    { url: 'https://media.example/file.mp4', type: 'video/mp4', codecs: 'hvc1.1.6.L93' },
    { url: 'https://media.example/file.torrent', type: 'application/x-bittorrent' },
  ]), null);
  assert.deepEqual(selectPodcastEnclosure([{
    url: 'https://media.example/live.m3u8',
    type: 'application/vnd.apple.mpegurl',
    codecs: 'avc1.4d401f,mp4a.40.2',
  }], { live: true }), {
    url: 'https://media.example/live.m3u8',
    mediaType: 'video',
    streamKind: 'hls',
    relation: 'enclosure',
    score: 1_800,
  });
  assert.equal(selectPodcastEnclosure([{
    url: 'https://media.example/episode.mp3?X-Amz-Signature=temporary',
    type: 'audio/mpeg',
  }]), null);
});

test('provider text decodes named entities and strips bidirectional controls', async () => {
  const directoryShow = show(1, { title: 'Directory &hellip; \u202eoverlay' });
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, {
      title: directoryShow.title,
      items: [episode(directoryShow.url, 'safe-text', {
        title: 'Episode &hellip; \u202eoverlay',
        description: '<p>Notes &mdash; safe \u2066overlay</p>',
      })],
    }),
  });
  const page = await source.browsePage();
  assert.equal(page.items[0].title, 'Episode … overlay');
  assert.equal(page.items[0].description, 'Notes — safe overlay');
  assert.equal(page.items[0].tags[1], 'Directory … overlay');
  assert.doesNotMatch(
    `${page.items[0].title}${page.items[0].description}`,
    /[\u202a-\u202e\u2066-\u2069]|â|Â/,
  );
  source.dispose();
});

test('browse interleaves four feeds, returns honest short pages, and exhausts only after revisits', async () => {
  const shows = Array.from({ length: 6 }, (_, index) => show(index + 1));
  const resolutions = [];
  const source = adapter({
    getJson: async (url) => {
      assert.equal(url, GPODDER_TOPLIST_URL);
      return shows;
    },
    resolvePodcastFeed: async (url) => {
      resolutions.push(url);
      const index = shows.findIndex((entry) => entry.url === url);
      return feedFor(shows[index], { count: 9 });
    },
  });
  const pages = [];
  let cursor = null;
  do {
    const page = await source.browsePage({ cursor });
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(pages.map((page) => page.items.length), [28, 14, 8, 4]);
  assert.deepEqual(pages.slice(0, -1).map((page) => page.exhausted), [false, false, false]);
  assert.equal(pages.at(-1).exhausted, true);
  assert.equal(pages[0].cursor.feedIndex, 4);
  assert.deepEqual(pages[0].cursor.positions.slice(0, 4), [7, 7, 7, 7]);
  const items = pages.flatMap((page) => page.items);
  assert.equal(items.length, 54);
  assert.equal(new Set(items.map((item) => item.id)).size, 54);
  assert.deepEqual(resolutions, shows.map((entry) => entry.url));
  assert.deepEqual(validateItem(items[0]), []);
  source.dispose();
});

test('array browse buffers a short caller limit without dropping episode positions', async () => {
  const directoryShow = show(1);
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { count: 9 }),
  });
  const first = await source.browse({ limit: 5 });
  const second = await source.browse({ limit: 5 });
  assert.equal(first.length, 5);
  assert.equal(second.length, 4);
  assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 9);
  source.dispose();
});

test('turning explicit content off clears any already-buffered explicit browse items', async () => {
  const directoryShow = show(1);
  const items = Array.from({ length: 9 }, (_, index) => episode(
    directoryShow.url,
    `rating-${index}`,
    { content_rating: index % 2 ? 'not-explicit' : 'explicit' },
  ));
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { items }),
  });
  const deliberatelyShown = await source.browse({ limit: 1, showExplicitContent: true });
  assert.equal(deliberatelyShown[0].content_rating, 'explicit');
  const hiddenAgain = await source.browse({ limit: 9, showExplicitContent: false });
  assert.ok(hiddenAgain.length > 0);
  assert.equal(hiddenAgain.every((item) => item.content_rating !== 'explicit'), true);
  source.dispose();
});

test('a dead or malicious feed cannot block good feeds and its cooldown prevents repeated fan-out', async () => {
  const shows = Array.from({ length: 5 }, (_, index) => show(index + 1));
  const calls = new Map();
  let time = FIXED_NOW;
  const source = adapter({
    now: () => time,
    getJson: async () => shows,
    resolvePodcastFeed: async (url) => {
      calls.set(url, (calls.get(url) || 0) + 1);
      if (url === shows[0].url) throw new HttpError('gone', { status: 404 });
      if (url === shows[1].url) return { items: 'hostile-not-an-array' };
      return feedFor(shows.find((entry) => entry.url === url), { count: 2 });
    },
  });
  const first = await source.browsePage();
  assert.equal(first.items.length, 4);
  assert.equal(first.deadFeeds, 2);
  assert.equal(first.exhausted, false, 'the unattempted fifth feed must keep the source nonterminal');
  const second = await source.browsePage({ cursor: first.cursor });
  assert.equal(second.items.length, 2);
  assert.equal(second.exhausted, true);
  time += 2_000;
  const restart = await source.browsePage();
  assert.equal(restart.items.length, 4);
  assert.equal(calls.get(shows[0].url), 1);
  assert.equal(calls.get(shows[1].url), 1);
  source.dispose();
});

test('native nonretryable publisher status failures retain the six-hour dead-feed cooldown', async () => {
  const directoryShow = show(1);
  let time = FIXED_NOW;
  let calls = 0;
  const source = adapter({
    now: () => time,
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => {
      calls += 1;
      throw Object.assign(new Error('publisher rejected the feed request'), {
        status: 502,
        code: 'CATALOG_UPSTREAM_STATUS',
        retryable: false,
      });
    },
  });
  assert.equal((await source.browsePage()).exhausted, true);
  time += 10 * 60 * 1000;
  assert.equal((await source.browsePage()).exhausted, true);
  assert.equal(calls, 1, 'native 4xx translation must not collapse to the five-minute cooldown');
  time += 6 * 60 * 60 * 1000;
  assert.equal((await source.browsePage()).exhausted, true);
  assert.equal(calls, 2);
  source.dispose();
});

test('last-known-good feed data survives a temporary refresh failure', async () => {
  const directoryShow = show(1);
  let time = FIXED_NOW;
  let feedCalls = 0;
  const source = adapter({
    now: () => time,
    feedCacheTtlMs: 0,
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => {
      feedCalls += 1;
      if (feedCalls > 1) throw new HttpError('temporary upstream', { status: 502 });
      return feedFor(directoryShow, { count: 2 });
    },
  });
  const first = await source.browsePage();
  time += 1;
  const second = await source.browsePage({ force: true });
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 2);
  assert.equal(feedCalls, 2);
  assert.deepEqual(second.items.map((item) => item.id), first.items.map((item) => item.id));
  assert.equal(second.items.every((item) => item._extra.cacheStale === true), true);
  assert.equal(second.items.every((item) => item._extra.cacheState === 'stale'), true);
  source.dispose();
});

test('a browse snapshot freezes its bounded feed prefix across a long pause and feed prepend', async () => {
  const directoryShow = show(1);
  let time = FIXED_NOW;
  let feedCalls = 0;
  const source = adapter({
    now: () => time,
    feedCacheTtlMs: 0,
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => {
      feedCalls += 1;
      const prefix = feedCalls === 1 ? 'original' : 'prepended';
      return feedFor(directoryShow, { count: 16, prefix });
    },
  });
  const first = await source.browsePage();
  time += 60 * 60 * 1000;
  const second = await source.browsePage({ cursor: first.cursor });
  assert.equal(feedCalls, 1, 'the in-progress snapshot must not refresh and shift episode positions');
  assert.equal(first.items.length, 7);
  assert.equal(second.items.length, 7);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 14);
  assert.equal([...first.items, ...second.items]
    .every((item) => item.title.includes('original')), true);
  assert.equal(second.exhausted, true);
  source.dispose();
});

test('browse cursor is transactional on abort and old snapshots reset only after eviction', async () => {
  const sets = Array.from({ length: 4 }, (_, generation) => (
    Array.from({ length: 5 }, (_, index) => show((generation * 10) + index + 1))
  ));
  let generation = 0;
  const source = adapter({
    getJson: async () => sets[generation],
    resolvePodcastFeed: async (url, { signal }) => {
      if (signal?.aborted) throw signal.reason;
      const directoryShow = sets.flat().find((entry) => entry.url === url);
      return feedFor(directoryShow, { count: 8 });
    },
  });
  const first = await source.browsePage();
  const preserved = structuredClone(first.cursor);
  const controller = new AbortController();
  controller.abort('generation changed');
  await assert.rejects(source.browsePage({ cursor: first.cursor, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(first.cursor, preserved);

  for (generation = 1; generation < 4; generation++) {
    await source.browsePage({ force: true });
  }
  const changed = await source.browsePage({ cursor: preserved });
  assert.equal(changed.snapshotChanged, true);
  assert.equal(changed.items.every((item) => item._extra.feedUrl.includes('show-3')), true);
  source.dispose();
});

test('out-of-order toplist and feed generations cannot replace newer cached data', async () => {
  const oldShow = show(1, { url: 'https://old-feed.example.test/show.xml' });
  const newShow = show(2, { url: 'https://new-feed.example.test/show.xml' });
  const directories = [deferred(), deferred()];
  let directoryCalls = 0;
  const source = adapter({
    getJson: async () => directories[directoryCalls++].promise,
    resolvePodcastFeed: async (url) => feedFor(url === oldShow.url ? oldShow : newShow),
  });
  const first = source.browsePage({ force: true, signal: new AbortController().signal });
  await flush();
  const second = source.browsePage({ force: true, signal: new AbortController().signal });
  await flush();
  directories[1].resolve([newShow]);
  const newest = await second;
  directories[0].resolve([oldShow]);
  await first;
  const cached = await source.browsePage();
  assert.equal(newest.items[0]._extra.feedUrl, newShow.url);
  assert.equal(cached.items[0]._extra.feedUrl, newShow.url);
  source.dispose();

  const failingDirectories = [deferred(), deferred()];
  let failingDirectoryCalls = 0;
  const failureSource = adapter({
    getJson: async () => failingDirectories[failingDirectoryCalls++].promise,
    resolvePodcastFeed: async () => feedFor(newShow),
  });
  const supersededFailure = failureSource.browsePage({
    force: true, signal: new AbortController().signal,
  });
  await flush();
  const successfulReplacement = failureSource.browsePage({
    force: true, signal: new AbortController().signal,
  });
  await flush();
  failingDirectories[1].resolve([newShow]);
  const replacementPage = await successfulReplacement;
  failingDirectories[0].reject(new HttpError('old request failed', { status: 503 }));
  await supersededFailure;
  const replacementCursorPage = await failureSource.browsePage({ cursor: replacementPage.cursor });
  assert.equal(replacementCursorPage.stale, false);
  failureSource.dispose();

  const directoryShow = show(3);
  const feeds = [deferred(), deferred()];
  let feedCalls = 0;
  const concurrent = adapter({
    getJson: async () => [directoryShow],
    feedScheduler: {
      run: (_host, task, signal) => task(signal),
      dispose() {},
    },
    resolvePodcastFeed: async () => feeds[feedCalls++].promise,
  });
  const olderFeed = concurrent.browsePage({ force: true, signal: new AbortController().signal });
  await flush();
  const newerFeed = concurrent.browsePage({ force: true, signal: new AbortController().signal });
  await flush();
  feeds[1].resolve(feedFor(directoryShow, {
    items: [episode(directoryShow.url, 'newer', { title: 'Newer science episode' })],
  }));
  assert.equal((await newerFeed).items[0].title, 'Newer science episode');
  feeds[0].resolve(feedFor(directoryShow, {
    items: [episode(directoryShow.url, 'older', { title: 'Older science episode' })],
  }));
  await olderFeed;
  const cachedFeed = await concurrent.browsePage({ force: true });
  assert.equal(cachedFeed.items[0].title, 'Newer science episode');
  assert.equal(feedCalls, 2);
  concurrent.dispose();
});

test('out-of-order identical searches retain only the newest directory and result snapshot', async () => {
  const oldShow = show(1, { url: 'https://old-search.example.test/show.xml' });
  const newShow = show(2, { url: 'https://new-search.example.test/show.xml' });
  const directories = [deferred(), deferred()];
  let directoryCalls = 0;
  const source = adapter({
    random: () => 0,
    getJson: async () => directories[directoryCalls++].promise,
    resolvePodcastFeed: async (url) => {
      const current = url === oldShow.url ? oldShow : newShow;
      return feedFor(current, {
        items: [episode(current.url, current === oldShow ? 'old' : 'new', {
          title: `${current === oldShow ? 'Old' : 'New'} science result`,
        })],
      });
    },
  });
  const older = source.searchPage('science', { signal: new AbortController().signal });
  await flush();
  const newer = source.searchPage('science', { signal: new AbortController().signal });
  await flush();
  directories[1].resolve([newShow]);
  assert.equal((await newer).items[0].title, 'New science result');
  directories[0].resolve([oldShow]);
  await older;
  const cached = await source.searchPage('science');
  assert.equal(cached.items[0].title, 'New science result');
  assert.deepEqual((await source.random({ limit: 10 })).map((item) => item.title), [
    'New science result',
  ]);
  assert.equal(directoryCalls, 2);
  source.dispose();
});

test('search encodes the query, resolves at most eight feeds, matches metadata, and reports partial failure', async () => {
  const shows = Array.from({ length: 10 }, (_, index) => show(index + 1, {
    title: `Space & science show ${index + 1}`,
  }));
  let directoryCalls = 0;
  const feedCalls = [];
  const failures = [];
  const source = adapter({
    getJson: async (input) => {
      directoryCalls += 1;
      const url = new URL(input);
      assert.equal(`${url.origin}${url.pathname}`, GPODDER_SEARCH_URL);
      assert.equal(url.searchParams.get('q'), 'space & science');
      return shows;
    },
    resolvePodcastFeed: async (url) => {
      feedCalls.push(url);
      const directoryShow = shows.find((entry) => entry.url === url);
      if (directoryShow === shows[2]) throw new HttpError('feed down', { status: 502 });
      return feedFor(directoryShow, {
        count: 6,
        items: Array.from({ length: 6 }, (_, index) => episode(directoryShow.url, `${url}-${index}`, {
          title: index < 5 ? `Space & science result ${index}` : 'Unrelated episode',
        })),
      });
    },
  });
  const results = await source.search('space & science', {
    onFeedError: (directoryShow) => failures.push(directoryShow.feedUrl),
  });
  assert.equal(directoryCalls, 1);
  assert.equal(feedCalls.length, 8);
  assert.equal(results.length, 30);
  assert.equal(results.every((item) => /space & science/i.test(item.title)), true);
  assert.equal(results.gpodderSearchState.partial, true);
  assert.deepEqual(results.gpodderSearchState.failedFeeds, [shows[2].url]);
  assert.deepEqual(failures, [shows[2].url]);
  const cached = await source.search('space & science');
  assert.equal(cached.length, 30);
  assert.equal(directoryCalls, 1);
  assert.equal(feedCalls.length, 8);
  const firstPage = await source.searchPage('space & science');
  const secondPage = await source.searchPage('space & science', { cursor: firstPage.cursor });
  assert.equal(firstPage.items.length, 30);
  assert.equal(firstPage.exhausted, false);
  assert.equal(secondPage.items.length, 5);
  assert.equal(secondPage.exhausted, true);
  await assert.rejects(source.searchPage('space & science', {
    cursor: { ...firstPage.cursor, offset: 41 },
  }), /Invalid gPodder search cursor/);
  source.dispose();
});

test('empty search is terminal while empty toplist and first directory failure stay visible as errors', async () => {
  const emptySearch = adapter({ getJson: async () => [] });
  assert.deepEqual(await emptySearch.searchPage('nothing'), {
    items: [], cursor: null, exhausted: true, partial: false, failedFeeds: [],
  });
  emptySearch.dispose();

  const emptyToplist = adapter({ getJson: async () => [] });
  await assert.rejects(emptyToplist.browsePage(), (error) => (
    error instanceof ProviderError && error.code === 'GPODDER_SUSPICIOUS_EMPTY'
  ));
  emptyToplist.dispose();

  const failed = adapter({ getJson: async () => { throw new Error('directory offline'); } });
  await assert.rejects(failed.browsePage(), /directory offline/);
  failed.dispose();

  const oversized = adapter({ getJson: async () => Array.from({ length: 101 }, (_, index) => show(index)) });
  await assert.rejects(oversized.browsePage(), /oversized directory response/);
  oversized.dispose();
});

test('directory Retry-After seconds are honored even when millisecond metadata is null', async () => {
  const cooldowns = [];
  const gate = {
    run: (task, signal) => task(signal),
    imposeCooldown: (delay) => cooldowns.push(delay),
    dispose() {},
  };
  const source = adapter({
    directoryGate: gate,
    getJson: async () => {
      const error = new HttpError('rate limited', { status: 429 });
      error.retryAfter = 120;
      throw error;
    },
  });
  await assert.rejects(source.browsePage(), /rate limited/);
  assert.deepEqual(cooldowns, [120_000]);
  source.dispose();
});

test('a cached toplist is last-known-good on a transient directory refresh failure', async () => {
  const directoryShow = show(1);
  let calls = 0;
  const source = adapter({
    getJson: async () => {
      calls += 1;
      if (calls > 1) throw new HttpError('temporary gPodder failure', { status: 502 });
      return [directoryShow];
    },
    resolvePodcastFeed: async () => feedFor(directoryShow, { count: 1 }),
  });
  const first = await source.browsePage();
  const stale = await source.browsePage({ force: true });
  assert.equal(first.items.length, 1);
  assert.equal(stale.items.length, 1);
  assert.equal(stale.stale, true);
  assert.equal(stale.snapshotId, first.snapshotId);
  assert.equal(calls, 2);
  source.dispose();
});

test('defended RSS/Atom/live/explicit/malicious fixtures cross the backend-to-adapter seam', async () => {
  const fixtureNames = [
    'podcast-rss.xml',
    'podcast-atom.xml',
    'podcast-live.xml',
    'podcast-malicious.xml',
    'podcast-explicit.xml',
    'podcast-malformed.xml',
  ];
  const shows = fixtureNames.map((name, index) => show(index + 1, {
    url: `https://feeds.example.test/${name}`,
    title: name,
  }));
  const failures = [];
  const source = adapter({
    getJson: async () => shows,
    resolvePodcastFeed: async (url) => {
      const index = shows.findIndex((entry) => entry.url === url);
      try {
        return await parseThroughBackend(fixtureNames[index], url);
      } catch (error) {
        failures.push(error.code);
        throw error;
      }
    },
  });
  const pages = [];
  let cursor = null;
  do {
    const page = await source.browsePage({ cursor });
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);
  const items = pages.flatMap((page) => page.items);
  assert.equal(items.length, 4, 'two RSS + one Atom + one status-live; explicit is hidden');
  assert.deepEqual(new Set(failures), new Set(['FEED_XML_UNSAFE', 'FEED_XML_INVALID']));
  assert.equal(items.every((item) => validateItem(item).length === 0), true);
  assert.equal(items.some((item) => /<\/?(?:strong|em)>/i.test(item.description)), false);
  assert.deepEqual(new Set(items.map((item) => resolveMediaAction(item))),
    new Set(['download', 'record-audio']));
  const explicit = await source.browsePage({ showExplicitContent: true });
  assert.equal(explicit.items.some((item) => item.content_rating === 'explicit'), false,
    'first feed batch does not contain the explicit sixth feed');
  source.dispose();

  const explicitOnly = adapter({
    getJson: async () => [shows[4]],
    resolvePodcastFeed: async (url) => parseThroughBackend('podcast-explicit.xml', url),
  });
  assert.equal((await explicitOnly.browsePage()).items.length, 0);
  const shown = await explicitOnly.browsePage({ showExplicitContent: true });
  assert.equal(shown.items.length, 1);
  assert.equal(shown.items[0].content_rating, 'explicit');
  explicitOnly.dispose();
});

test('finite audio/video download and only-current live audio/video record actions are explicit', async () => {
  const directoryShow = show(1);
  const identity = directoryShow.url;
  const items = [
    episode(identity, 'audio'),
    episode(identity, 'video', {
      type: 'video/mp4', extension: 'mp4',
      mediaUrl: 'https://media.example.test/movie.php',
      license: { label: 'CC BY-NC 4.0', url: 'https://license.example.test/episode' },
    }),
    episode(identity, 'live-audio', {
      live: true,
      live_status: 'live',
      start: '2026-07-15T11:00:00Z',
      end: '2026-07-15T13:00:00Z',
      mediaUrl: 'https://media.example.test/audio-live.m3u8',
      type: 'audio/mpegurl',
      extension: 'm3u8',
    }),
    episode(identity, 'live-video', {
      live: true,
      live_status: 'live',
      start: '2026-07-15T11:00:00Z',
      end: '2026-07-15T13:00:00Z',
      enclosures: [{
        url: 'https://media.example.test/video-live.m3u8',
        type: 'application/vnd.apple.mpegurl',
        codecs: 'avc1.4d401f,mp4a.40.2',
      }],
    }),
    episode(identity, 'pending', {
      live: true, live_status: 'pending',
      mediaUrl: 'https://media.example.test/pending.m3u8', type: 'audio/mpegurl', extension: 'm3u8',
    }),
    episode(identity, 'ended', {
      live: true, live_status: 'ended',
      start: '2026-07-15T09:00:00Z', end: '2026-07-15T10:00:00Z',
      mediaUrl: 'https://media.example.test/ended.m3u8', type: 'video/mpegurl', extension: 'm3u8',
    }),
  ];
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { items }),
  });
  const page = await source.browsePage();
  assert.deepEqual(page.items.map((item) => [item.type, item.delivery, resolveMediaAction(item)]), [
    ['audio', 'on-demand', 'download'],
    ['video', 'on-demand', 'download'],
    ['radio', 'live', 'record-audio'],
    ['tv', 'live', 'record-video'],
  ]);
  assert.equal(page.items.slice(0, 2).every((item) => item.download_url === item.stream_url), true);
  assert.equal(page.items.slice(2).every((item) => !item.download_url), true);
  assert.equal(page.items[1].download_name, 'movie.mp4');
  assert.equal(page.items[1].license, 'CC BY-NC 4.0');
  assert.equal(page.items.every((item) => item._extra.needsResolve === false), true);
  assert.equal(page.items.every((item) => item._extra.downloadResolved === true), true);
  assert.equal(page.items.every((item) => item._extra.resolutionStatus === 'playable'), true);
  assert.deepEqual(page.items.map((item) => item._extra.snapshotItem), [false, false, true, true]);
  assert.equal(isPodcastLiveNow({ live: true, liveStatus: 'live', start: items[2].start, end: items[2].end }, FIXED_NOW), true);
  assert.equal(isPodcastLiveNow({
    live: true, liveStatus: 'live',
    start: '2026-07-15T09:00:00Z', end: '2026-07-15T10:00:00Z',
  }, FIXED_NOW), true, 'status=live is authoritative even when a scheduled end has passed');
  const restartedFinite = normalizeFavoriteItem(page.items[0], { restart: true });
  assert.equal(restartedFinite.stream_url, '');
  assert.equal(restartedFinite._extra.needsResolve, true);
  await source.resolveStream(restartedFinite, { force: true });
  assert.equal(restartedFinite.stream_url, page.items[0].stream_url);
  assert.equal(resolveMediaAction(restartedFinite), 'download');
  source.dispose();
});

test('live podcast favorites re-resolve after restart and settle unavailable after the live item ends', async () => {
  const directoryShow = show(1);
  const identity = directoryShow.url;
  let episodes = [episode(identity, 'live-favorite', {
    live: true,
    live_status: 'live',
    mediaUrl: 'https://media.example.test/live-favorite.m3u8',
    type: 'application/vnd.apple.mpegurl',
    extension: 'm3u8',
  })];
  const source = adapter({
    feedCacheTtlMs: 0,
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { items: episodes }),
  });
  const live = (await source.browsePage()).items[0];
  const favorite = normalizeFavoriteItem(live);
  assert.equal(favorite.id, live.id);
  assert.equal(favorite.stream_url, '');
  assert.equal(favorite._extra.needsResolve, true);
  assert.equal(favorite.source_url, live.source_url);

  await source.resolveStream(favorite, { force: true });
  assert.equal(favorite.stream_url, live.stream_url);
  assert.equal(favorite._extra.needsResolve, false);
  assert.equal(favorite._extra.resolutionStatus, 'playable');
  assert.equal(resolveMediaAction(favorite), 'record-audio');

  episodes = [episode(identity, 'live-favorite', {
    live: true,
    live_status: 'ended',
    mediaUrl: 'https://media.example.test/live-favorite.m3u8',
    type: 'application/vnd.apple.mpegurl',
    extension: 'm3u8',
  })];
  const restarted = normalizeFavoriteItem(favorite);
  await source.resolveStream(restarted, { force: true });
  assert.equal(restarted.stream_url, '');
  assert.equal(restarted._extra.needsResolve, false);
  assert.equal(restarted._extra.resolutionStatus, 'unavailable');
  assert.equal(restarted._extra.validationError, 'PODCAST_EPISODE_UNAVAILABLE');
  assert.equal(restarted.source_url, live.source_url);
  assert.equal(resolveMediaAction(restarted), 'unavailable');
  source.dispose();
});

test('explicit episodes are hidden by default, deliberately shown when enabled, and unrated stays visible', async () => {
  const directoryShow = show(1);
  const items = [
    episode(directoryShow.url, 'clean', { content_rating: 'not-explicit' }),
    episode(directoryShow.url, 'explicit', { content_rating: 'explicit' }),
    episode(directoryShow.url, 'unrated', { content_rating: 'unrated' }),
  ];
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { items }),
  });
  const hidden = await source.browsePage();
  assert.deepEqual(hidden.items.map((item) => item.content_rating), ['not-explicit', 'unrated']);
  const shown = await source.browsePage({ showExplicitContent: true });
  assert.deepEqual(shown.items.map((item) => item.content_rating), ['not-explicit', 'explicit', 'unrated']);
  source.dispose();
});

test('redirect aliases keep episode/favorite identity stable when the directory feed URL moves', async () => {
  const oldShow = show(1, { url: 'https://feeds.example.test/old.xml' });
  const newShow = show(1, { url: 'https://feeds.example.test/new.xml' });
  const identity = 'https://feeds.example.test/canonical.xml';
  let current = oldShow;
  let time = FIXED_NOW;
  let feedCalls = 0;
  const requestedFeeds = [];
  const source = adapter({
    now: () => time,
    feedCacheTtlMs: 0,
    getJson: async () => [current],
    resolvePodcastFeed: async (url) => {
      feedCalls += 1;
      requestedFeeds.push(url);
      return feedFor(oldShow, {
        feedUrl: oldShow.url,
        resolvedFeedUrl: newShow.url,
        identityUrl: identity,
        aliases: [oldShow.url, newShow.url, identity],
        items: [episode(identity, 'stable-episode')],
      });
    },
  });
  const before = await source.browsePage();
  current = newShow;
  time += 1;
  const after = await source.browsePage({ force: true });
  assert.equal(feedCalls, 2);
  assert.deepEqual(requestedFeeds, [oldShow.url, oldShow.url],
    'refresh must use the original native cache key so the prior identity survives');
  assert.equal(after.items[0].id, before.items[0].id);
  assert.equal(normalizeFavoriteItem(after.items[0]).id, normalizeFavoriteItem(before.items[0]).id);
  assert.deepEqual(after.items[0]._extra.feedAliases, [oldShow.url, newShow.url, identity]);
  source.dispose();
});

test('duplicate directory aliases and duplicate GUIDs cannot emit duplicate cards', async () => {
  const first = show(1, { url: 'https://feeds.example.test/alias-one.xml' });
  const second = show(2, { url: 'https://feeds.example.test/alias-two.xml' });
  const identity = 'https://feeds.example.test/canonical.xml';
  const source = adapter({
    getJson: async () => [first, second],
    resolvePodcastFeed: async (url) => {
      const directoryShow = url === first.url ? first : second;
      return feedFor(directoryShow, {
        identityUrl: identity,
        aliases: [directoryShow.url, identity],
        items: [
          episode(identity, 'one', { guid: 'same-guid' }),
          episode(identity, 'two', { guid: 'same-guid' }),
          episode(identity, 'unique', { guid: 'unique-guid' }),
        ],
      });
    },
  });
  const page = await source.browsePage();
  assert.equal(page.items.length, 2);
  assert.equal(new Set(page.items.map((item) => item.id)).size, 2);
  source.dispose();
});

test('artwork is relayed opaquely and favorites retain only canonical rehydration metadata', async () => {
  const directoryShow = show(1);
  const registrations = [];
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async () => feedFor(directoryShow, { count: 1 }),
    registerCatalogAsset: async (request) => {
      registrations.push(request);
      return { relay_url: '/api/v1/assets/AbCdEfGhIjKlMnOp' };
    },
  });
  const page = await source.browsePage();
  const item = page.items[0];
  assert.equal(item.thumbnail, '');
  assert.match(item._extra.artworkUrl, /^https:\/\/images\.example\.test\//);
  await source.resolveArtwork(item);
  assert.equal(item.thumbnail, '/api/v1/assets/AbCdEfGhIjKlMnOp');
  assert.deepEqual(registrations, [{
    url: item._extra.artworkUrl,
    sourceId: 'gpodder',
    itemId: item.id,
  }]);
  const favorite = normalizeFavoriteItem({ ...item, futureItemField: 7 });
  assert.equal(favorite.thumbnail, '');
  assert.equal(favorite._extra.needsArtwork, true);
  assert.equal(favorite._extra.artworkUrl, item._extra.artworkUrl);
  assert.deepEqual(favorite._extra.feedAliases, item._extra.feedAliases);
  assert.equal(Object.hasOwn(favorite._extra, 'guid'), false);
  assert.equal(favorite.futureItemField, 7);
  assert.equal(favorite._extra.downloadResolved, true);
  const unrelated = { source: 'other', thumbnail: 'https://images.example/other.jpg' };
  assert.equal(await source.resolveArtwork(unrelated), unrelated);
  const noArtwork = { source: 'gpodder', thumbnail: '', _extra: {} };
  assert.equal(await source.resolveArtwork(noArtwork), noArtwork);
  assert.equal(noArtwork.thumbnail, '');
  source.dispose();
});

test('random uses only the eligible in-memory reservoir and never starts discovery', async () => {
  const directoryShow = show(1);
  let directoryCalls = 0;
  let feedCalls = 0;
  const source = adapter({
    random: () => 0.5,
    getJson: async () => { directoryCalls += 1; return [directoryShow]; },
    resolvePodcastFeed: async () => { feedCalls += 1; return feedFor(directoryShow, { count: 3 }); },
  });
  assert.deepEqual(await source.random(), []);
  assert.equal(directoryCalls, 0);
  assert.equal(feedCalls, 0);
  await source.browsePage();
  const randomItems = await source.random({ limit: 2 });
  assert.equal(randomItems.length, 2);
  assert.equal(directoryCalls, 1);
  assert.equal(feedCalls, 1);
  source.dispose();
});

test('generation abort and adapter disposal cancel publisher work without poisoning a later request', async () => {
  const directoryShow = show(1);
  let calls = 0;
  const source = adapter({
    getJson: async () => [directoryShow],
    resolvePodcastFeed: async (_url, { signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = source.browsePage({ signal: controller.signal });
  await flush();
  controller.abort('generation changed');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);

  const pendingDispose = source.browsePage();
  await flush();
  source.dispose();
  await assert.rejects(pendingDispose, { name: 'AbortError' });
  assert.equal(calls, 2);
  await assert.rejects(source.browsePage(), { name: 'AbortError' });
});
