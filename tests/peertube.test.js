import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  catalogPolicy,
  createPeerTubeAdapter,
  createPeerTubeOriginScheduler,
  displayName,
  id,
  itemTypes,
  normalizeResolvedPeerTube,
  normalizeSepiaResponse,
  normalizeSepiaSummary,
  peerTubeIdentity,
  SEPIASEARCH_URL,
} from '../src/adapters/peertube.js';
import { HttpError } from '../src/lib/http.js';
import { validateItem } from '../src/lib/item-model.js';
import { resolveMediaAction } from '../src/lib/media-capabilities.js';
import { SOURCES } from '../src/lib/sources.js';
import { normalizeFavoriteItem } from '../src/lib/state.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/five-new-sources/peertube.json', import.meta.url),
  'utf8',
));

const FIXED_NOW = Date.parse('2026-07-15T12:00:00Z');
const execFileAsync = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, Number(delay) || 0), callback });
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

function immediateIndexScheduler() {
  return {
    run: (task, signal) => task(signal),
    recordFailure() {},
    recordSuccess() {},
    dispose() {},
  };
}

function immediateOriginScheduler() {
  return {
    run: (_origin, task, signal) => task(signal),
    recordFailure() {},
    recordSuccess() {},
    dispose() {},
  };
}

async function resolveThroughBackend(watchUrl, videoUuid) {
  const entry = Object.entries(fixture.originDetails).find(([, detail]) => (
    detail.uuid === videoUuid && detail.url === watchUrl
  ));
  if (!entry) {
    const error = new Error('No exact PeerTube fixture identity exists.');
    error.code = 'PEERTUBE_IDENTITY_INVALID';
    throw error;
  }
  const bridge = new URL('../tests_python/peertube_adapter_bridge.py', import.meta.url);
  const { stdout } = await execFileAsync('python', [fileURLToPath(bridge), entry[0]], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) {
    const error = new Error(envelope.error?.message || 'PeerTube backend rejected the detail.');
    Object.assign(error, envelope.error);
    throw error;
  }
  return envelope.value;
}

function uuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function summary(number, overrides = {}) {
  const value = uuid(number);
  const host = overrides.host || `video-${(number % 4) + 1}.example.org`;
  return {
    id: 10_000 + number,
    uuid: value,
    shortUUID: `Fixture${String(number).padStart(12, '0')}`,
    url: `https://${host}/videos/watch/${value}`,
    name: `PeerTube fixture ${number}`,
    description: `<p>Federated fixture ${number} &amp; notes.</p>`,
    duration: 120 + number,
    publishedAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-11T12:00:00.000Z',
    privacy: { id: 1, label: 'Public' },
    category: { id: 15, label: 'Science & Technology' },
    licence: { id: 1, label: 'CC BY 4.0' },
    language: { id: 'en', label: 'English' },
    isLive: false,
    nsfw: false,
    nsfwFlags: 0,
    tags: ['science', `fixture-${number}`],
    thumbnailUrl: `https://${host}/lazy-static/thumbnails/${value}.jpg`,
    previewUrl: `https://${host}/lazy-static/previews/${value}.jpg`,
    account: { displayName: `Publisher ${number}`, host },
    channel: { displayName: `Channel ${number}`, host },
    ...overrides,
  };
}

function page(values, options = {}) {
  return {
    total: options.total ?? values.length,
    data: values,
  };
}

function resolved(raw, overrides = {}) {
  const identity = peerTubeIdentity(raw.url, raw.uuid);
  const isLive = overrides.is_live ?? raw.isLive;
  const mediaType = overrides.media_type || (isLive ? 'hls' : 'hls');
  const playback = overrides.playback_url === undefined
    ? `${identity.origin}/static/streaming-playlists/hls/${raw.uuid}/master.m3u8`
    : overrides.playback_url;
  const download = overrides.download_url === undefined && !isLive
    ? `${identity.origin}/download/videos/${raw.uuid}.mp4`
    : (overrides.download_url || '');
  const downloadEnabled = overrides.download_enabled ?? (!!download && !isLive);
  return {
    provider: 'peertube',
    origin: identity.origin,
    uuid: identity.uuid,
    watch_url: identity.watchUrl,
    title: overrides.title || raw.name,
    description: overrides.description || raw.description,
    content_rating: overrides.content_rating || (raw.nsfw ? 'explicit' : 'not-explicit'),
    nsfw_flags: overrides.nsfw_flags ?? raw.nsfwFlags ?? 0,
    is_live: isLive,
    delivery: isLive ? 'live' : 'on-demand',
    media_type: mediaType,
    recording_kind: 'video',
    playback_url: playback,
    download_url: downloadEnabled ? download : '',
    download_enabled: downloadEnabled,
    download_permission: overrides.download_permission ?? downloadEnabled,
    hls_choices: mediaType === 'hls' && playback ? [{ url: playback, relation: 'hls' }] : [],
    file_choices: mediaType === 'video' && playback
      ? [{ url: playback, relation: 'play', height: 720, size: 10 }]
      : [],
    download_choices: downloadEnabled
      ? [{ url: download, relation: 'download', height: 720, size: 10 }]
      : [],
    license: overrides.license || raw.licence?.label || 'See PeerTube license',
    license_id: overrides.license_id ?? raw.licence?.id ?? null,
    cache: overrides.cache || { state: 'updated', stale: false },
    ...overrides,
  };
}

function adapter(options = {}) {
  return createPeerTubeAdapter({
    now: () => FIXED_NOW,
    indexScheduler: immediateIndexScheduler(),
    originScheduler: immediateOriginScheduler(),
    ...options,
  });
}

test('PeerTube exports and stable identity are registered in Phase 8', () => {
  assert.equal(id, 'peertube');
  assert.equal(displayName, 'PeerTube');
  assert.deepEqual(itemTypes, ['video', 'tv']);
  assert.deepEqual(catalogPolicy, { maxConcurrent: 2, minIntervalMs: 500 });
  assert.equal(SEPIASEARCH_URL, 'https://sepiasearch.org/api/v1/search/videos');
  assert.equal(SOURCES.some((source) => source.id === id), true);

  const identity = peerTubeIdentity(
    'HTTPS://VIDEO.EXAMPLE.ORG:443/videos/watch/11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(identity.id, 'peertube:video.example.org:11111111-1111-4111-8111-111111111111');
  assert.equal(identity.origin, 'https://video.example.org');
  assert.equal(peerTubeIdentity(`${identity.watchUrl}?token=secret`, identity.uuid), null);
  assert.equal(peerTubeIdentity(`${identity.watchUrl}#fragment`, identity.uuid), null);
  assert.equal(peerTubeIdentity(identity.watchUrl, uuid(99)), null);
  assert.equal(peerTubeIdentity(`https://localhost/videos/watch/${identity.uuid}`, identity.uuid), null);
});

test('Sepia browse validates summaries, filters policy states, and controls the explicit query', async () => {
  const safe = structuredClone(fixture.index.data[0]);
  const marked = structuredClone(fixture.index.data[2]);
  const privateItem = structuredClone(fixture.index.data[3]);
  const malformed = structuredClone(fixture.index.data[4]);
  const scheduled = summary(10, { state: { id: 4, label: 'Waiting for live stream' }, isLive: true });
  const calls = [];
  const source = adapter({
    getJson: async (input) => {
      calls.push(new URL(input));
      return page([safe, marked, privateItem, malformed, scheduled]);
    },
  });
  const hidden = await source.browsePage();
  assert.equal(hidden.items.length, 1);
  assert.equal(hidden.items[0].title, 'Public fixture VOD');
  assert.equal(hidden.partial, true);
  assert.equal(hidden.malformed, 1);
  assert.equal(hidden.filtered, 3);
  assert.deepEqual(validateItem(hidden.items[0]), []);
  assert.equal(calls[0].origin + calls[0].pathname, SEPIASEARCH_URL);
  assert.equal(calls[0].searchParams.get('start'), '0');
  assert.equal(calls[0].searchParams.get('count'), '30');
  assert.equal(calls[0].searchParams.get('sort'), '-publishedAt');
  assert.equal(calls[0].searchParams.get('includeScheduledLive'), 'false');
  assert.equal(calls[0].searchParams.get('nsfw'), 'false');

  const shown = await source.browsePage({ showExplicitContent: true });
  assert.deepEqual(shown.items.map((item) => item.content_rating).sort(), [
    'explicit', 'not-explicit',
  ]);
  assert.equal(calls[1].searchParams.has('nsfw'), false);
  source.dispose();
});

test('Sepia pagination follows authoritative totals, preserves short nonterminal pages, and resets query cursors', async () => {
  const starts = [];
  const source = adapter({
    getJson: async (input) => {
      const url = new URL(input);
      const start = Number(url.searchParams.get('start'));
      starts.push([url.searchParams.get('search') || '', start]);
      if (start === 0) return page([summary(1), summary(2)], { total: 5 });
      if (start === 2) return page([summary(3), summary(4), summary(5)], { total: 5 });
      return page([], { total: 0 });
    },
  });
  const first = await source.browsePage();
  assert.equal(first.items.length, 2);
  assert.equal(first.exhausted, false);
  assert.equal(first.cursor.start, 2);
  const second = await source.browsePage({ cursor: first.cursor });
  assert.equal(second.items.length, 3);
  assert.equal(second.exhausted, true);

  const search = await source.searchPage('climate', { cursor: first.cursor });
  assert.equal(search.items.length, 2);
  assert.deepEqual(starts, [['', 0], ['', 2], ['climate', 0]]);
  source.dispose();
});

test('duplicate summaries keep one stable origin-plus-UUID identity deterministically', () => {
  const long = summary(7, { host: 'duplicate.example.org' });
  const short = {
    ...structuredClone(long),
    url: 'https://duplicate.example.org/w/FixtureShort_7',
  };
  const normalized = normalizeSepiaResponse({ total: 2, data: [short, long] }, {
    start: 0, count: 30, query: '', showExplicitContent: false,
  });
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].id, `peertube:duplicate.example.org:${long.uuid}`);
  assert.equal(normalized.items[0].source_url, long.url);
  assert.equal(normalized.rawCount, 2);
});

test('validated search zero is empty while global zero, page gaps, and total schema drift remain retryable failures', () => {
  assert.deepEqual(normalizeSepiaResponse({ total: 0, data: [] }, {
    start: 0, count: 30, query: 'no matches', showExplicitContent: false,
  }).items, []);
  assert.throws(() => normalizeSepiaResponse({ total: 0, data: [] }, {
    start: 0, count: 30, query: '', showExplicitContent: false,
  }), { code: 'PEERTUBE_SUSPICIOUS_ZERO' });
  assert.throws(() => normalizeSepiaResponse({ total: 5, data: [] }, {
    start: 0, count: 30, query: 'x', showExplicitContent: false,
  }), { code: 'PEERTUBE_PAGINATION_INVALID' });
  assert.throws(() => normalizeSepiaResponse({ total: '5', data: [] }, {
    start: 0, count: 30, query: 'x', showExplicitContent: false,
  }), { code: 'PEERTUBE_SCHEMA_INVALID' });
  assert.throws(() => normalizeSepiaResponse({ total: 1, data: [fixture.index.data[4]] }, {
    start: 0, count: 30, query: 'x', showExplicitContent: false,
  }), { code: 'PEERTUBE_SCHEMA_DRIFT' });
});

test('summary validation rejects malformed ratings and keeps all nine license labels distinct from capability', () => {
  assert.throws(() => normalizeSepiaSummary(summary(1, { nsfw: 'false' })), {
    code: 'PEERTUBE_RATING_INVALID',
  });
  assert.throws(() => normalizeSepiaSummary(summary(1, { nsfw: false, nsfwFlags: 1 })), {
    code: 'PEERTUBE_RATING_INVALID',
  });
  for (const duration of [null, '120', false, Number.NaN]) {
    assert.throws(() => normalizeSepiaSummary(summary(20, { duration })), {
      code: 'PEERTUBE_SCHEMA_INVALID',
    });
  }
  for (let value = 1; value <= 9; value++) {
    const item = normalizeSepiaSummary(summary(value, {
      licence: { id: value, label: `License ${value}` },
    }), { showExplicitContent: true });
    assert.equal(item.license, value === 9 ? 'All Rights Reserved' : `License ${value}`);
    assert.equal(item.download_url, '');
    assert.equal(item._extra.downloadResolved, false);
  }
  const unknownLicense = normalizeSepiaSummary(summary(10, {
    licence: { id: null, label: 'Unknown' },
    language: { id: null, label: 'Unknown' },
  }));
  assert.equal(unknownLicense.license, 'See PeerTube license');
  assert.equal(unknownLicense.language, '');
  assert.equal(unknownLicense._extra.licenseId, null);
  assert.throws(() => normalizeSepiaSummary(summary(11, {
    licence: { id: null, label: 42 },
  })), { code: 'PEERTUBE_SCHEMA_INVALID' });
  assert.throws(() => normalizeSepiaSummary(summary(12, {
    language: { id: null, label: 42 },
  })), { code: 'PEERTUBE_SCHEMA_INVALID' });
});

test('VOD and live lazy resolution prefer HLS and expose only provider-authorized actions', async () => {
  const vodRaw = structuredClone(fixture.index.data[0]);
  const liveRaw = structuredClone(fixture.index.data[1]);
  const source = adapter({
    getJson: async () => page([vodRaw, liveRaw]),
    resolvePeerTubeVideo: async (watchUrl) => (
      watchUrl.includes(vodRaw.uuid)
        ? resolved(vodRaw)
        : resolved(liveRaw, { download_enabled: false, download_url: '' })
    ),
  });
  const listed = await source.browsePage();
  const vod = listed.items.find((item) => item.type === 'video');
  const live = listed.items.find((item) => item.type === 'tv');
  await source.resolveStream(vod);
  await source.resolveStream(live);
  assert.equal(vod.stream_kind, 'hls');
  assert.equal(vod.delivery, 'on-demand');
  assert.match(vod.download_url, /\.mp4$/);
  assert.match(vod.download_name, /\.mp4$/);
  assert.equal(vod._extra.downloadResolved, true);
  assert.equal(resolveMediaAction(vod), 'download');
  assert.equal(live.stream_kind, 'hls');
  assert.equal(live.delivery, 'live');
  assert.equal(live.download_url, '');
  assert.equal(resolveMediaAction(live), 'record-video');
  const restartedVod = normalizeFavoriteItem(vod, { restart: true });
  assert.equal(restartedVod.stream_url, '');
  assert.equal(restartedVod._extra.needsResolve, true);
  await source.resolveStream(restartedVod);
  assert.equal(restartedVod.stream_url, vod.stream_url);
  assert.equal(resolveMediaAction(restartedVod), 'download');
  source.dispose();
});

test('defended origin details cross the Python backend-to-adapter seam', async () => {
  const vodRaw = structuredClone(fixture.index.data[0]);
  const liveRaw = structuredClone(fixture.index.data[1]);
  const source = adapter({
    getJson: async () => page([vodRaw, liveRaw]),
    resolvePeerTubeVideo: resolveThroughBackend,
  });
  const listed = await source.browsePage();
  const vod = listed.items.find((item) => item.type === 'video');
  const live = listed.items.find((item) => item.type === 'tv');
  await source.resolveStream(vod);
  await source.resolveStream(live);
  assert.equal(vod.stream_kind, 'hls');
  assert.equal(resolveMediaAction(vod), 'download');
  assert.equal(vod.license, 'CC BY 4.0');
  assert.equal(live.stream_kind, 'hls');
  assert.equal(resolveMediaAction(live), 'record-video');
  assert.equal(live.license, 'All Rights Reserved');
  source.dispose();

  const privateDetail = fixture.originDetails.private;
  const unpublishedDetail = fixture.originDetails.unpublished;
  const hiddenSource = adapter({
    getJson: async () => page([
      {
        ...summary(41),
        uuid: privateDetail.uuid,
        url: privateDetail.url,
      },
      {
        ...summary(42),
        uuid: unpublishedDetail.uuid,
        url: unpublishedDetail.url,
      },
    ]),
    resolvePeerTubeVideo: resolveThroughBackend,
  });
  const hidden = await hiddenSource.browsePage();
  await assert.rejects(hiddenSource.resolveStream(hidden.items[0]), { code: 'PEERTUBE_NOT_PUBLIC' });
  await assert.rejects(hiddenSource.resolveStream(hidden.items[1]), { code: 'PEERTUBE_NOT_PUBLISHED' });
  for (const [index, code] of ['PEERTUBE_NOT_PUBLIC', 'PEERTUBE_NOT_PUBLISHED'].entries()) {
    assert.equal(hidden.items[index].stream_url, '');
    assert.equal(hidden.items[index].download_url, '');
    assert.equal(hidden.items[index]._extra.needsResolve, false);
    assert.equal(hidden.items[index]._extra.downloadResolved, true);
    assert.equal(hidden.items[index]._extra.resolutionStatus, 'unavailable');
    assert.equal(hidden.items[index]._extra.validationError, code);
    assert.equal(resolveMediaAction(hidden.items[index]), 'unavailable');
  }
  hiddenSource.dispose();
});

test('invalid saved PeerTube identity settles unavailable even though resolution reports the error', async () => {
  const source = adapter();
  const item = {
    id: 'peertube:invalid',
    source: 'peertube',
    delivery: 'on-demand',
    stream_url: '',
    download_url: '',
    download_name: '',
    capture_headers: {},
    _extra: { uuid: 'invalid', watchUrl: 'https://example.com/w/invalid', needsResolve: true },
  };
  await assert.rejects(source.resolveStream(item), { code: 'PEERTUBE_IDENTITY_INVALID' });
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.downloadResolved, true);
  assert.equal(item._extra.resolutionStatus, 'unavailable');
  assert.equal(item._extra.validationError, 'PEERTUBE_IDENTITY_INVALID');
  assert.equal(resolveMediaAction(item), 'unavailable');
  source.dispose();
});

test('VOD falls back to compatible MP4, active live refuses MP4, and absent media stays retryable', async () => {
  const vodRaw = summary(1);
  const liveRaw = summary(2, { isLive: true, duration: 0 });
  const identity = peerTubeIdentity(vodRaw.url, vodRaw.uuid);
  const mp4 = `${identity.origin}/static/web-videos/${vodRaw.uuid}.mp4`;
  const normalized = normalizeResolvedPeerTube(resolved(vodRaw, {
    media_type: 'video', playback_url: mp4,
  }), identity);
  assert.equal(normalized.streamKind, 'video');
  assert.equal(normalized.playbackUrl, mp4);
  assert.throws(() => normalizeResolvedPeerTube(resolved(vodRaw, {
    playback_url: 'javascript:alert(1)',
  }), identity), { code: 'PEERTUBE_RESOLVER_INVALID' });
  assert.throws(() => normalizeResolvedPeerTube(resolved(liveRaw, {
    is_live: true,
    delivery: 'live',
    media_type: 'video',
    playback_url: `${peerTubeIdentity(liveRaw.url, liveRaw.uuid).origin}/live.mp4`,
    download_enabled: false,
    download_url: '',
  }), peerTubeIdentity(liveRaw.url, liveRaw.uuid)), { code: 'PEERTUBE_LIVE_MEDIA_INVALID' });

  const source = adapter({
    getJson: async () => page([vodRaw]),
    resolvePeerTubeVideo: async () => resolved(vodRaw, {
      playback_url: '', download_url: '', download_enabled: false,
    }),
  });
  const item = (await source.browsePage()).items[0];
  await source.resolveStream(item);
  assert.equal(item.stream_url, '');
  assert.equal(item._extra.needsResolve, false);
  assert.equal(item._extra.resolutionStatus, 'unavailable');
  assert.equal(resolveMediaAction(item), 'unavailable');
  source.dispose();

  const liveSource = adapter({
    getJson: async () => page([liveRaw]),
    resolvePeerTubeVideo: async () => resolved(liveRaw, {
      is_live: true,
      delivery: 'live',
      media_type: 'hls',
      playback_url: '',
      download_permission: false,
      download_url: '',
      download_enabled: false,
    }),
  });
  const liveItem = (await liveSource.browsePage()).items[0];
  assert.equal(resolveMediaAction(liveItem), 'checking');
  await liveSource.resolveStream(liveItem);
  assert.equal(liveItem._extra.resolutionStatus, 'unavailable');
  assert.equal(resolveMediaAction(liveItem), 'unavailable');
  liveSource.dispose();
});

test('explicit resolution is blocked before or after origin revalidation unless deliberately enabled', async () => {
  const markedRaw = structuredClone(fixture.index.data[2]);
  const safeRaw = structuredClone(fixture.index.data[0]);
  let calls = 0;
  const source = adapter({
    getJson: async () => page([markedRaw, safeRaw]),
    resolvePeerTubeVideo: async (_watch, videoUuid) => {
      calls += 1;
      const raw = videoUuid === markedRaw.uuid ? markedRaw : safeRaw;
      return resolved(raw, { content_rating: 'explicit' });
    },
  });
  const explicit = (await source.browsePage({ showExplicitContent: true })).items
    .find((item) => item.content_rating === 'explicit');
  await assert.rejects(source.resolveStream(explicit, { showExplicitContent: false }), {
    code: 'PEERTUBE_EXPLICIT_HIDDEN',
  });
  assert.equal(calls, 0);
  await source.resolveStream(explicit, { showExplicitContent: true });
  assert.equal(calls, 1);
  assert.match(explicit.stream_url, /^https:/);
  await assert.rejects(source.resolveStream(explicit, { showExplicitContent: false }), {
    code: 'PEERTUBE_EXPLICIT_HIDDEN',
  });
  assert.equal(explicit.stream_url, '');
  assert.equal(explicit.download_url, '');
  assert.equal(explicit._extra.resolutionStatus, 'hidden');
  await source.resolveStream(explicit, { showExplicitContent: true });
  assert.equal(calls, 1, 're-enabling can reuse the still-current validated detail cache');

  const safe = (await source.browsePage()).items[0];
  await assert.rejects(source.resolveStream(safe), { code: 'PEERTUBE_EXPLICIT_HIDDEN' });
  assert.equal(safe.content_rating, 'explicit');
  assert.equal(safe.stream_url, '');
  source.dispose();
});

test('detail cache coalesces same-generation work, retains stale LKG, and rejects older generation publication', async () => {
  const raw = summary(1);
  let calls = 0;
  let fail = false;
  const source = adapter({
    detailCacheTtlMs: 0,
    getJson: async () => page([raw]),
    resolvePeerTubeVideo: async () => {
      calls += 1;
      if (fail) throw new HttpError('temporary origin failure', { status: 502 });
      return resolved(raw, { title: 'First detail' });
    },
  });
  const original = (await source.browsePage()).items[0];
  const left = structuredClone(original);
  const right = structuredClone(original);
  const controller = new AbortController();
  await Promise.all([
    source.resolveStream(left, { signal: controller.signal }),
    source.resolveStream(right, { signal: controller.signal }),
  ]);
  assert.equal(calls, 1);
  fail = true;
  const stale = structuredClone(original);
  await source.resolveStream(stale, { signal: new AbortController().signal });
  assert.equal(calls, 2);
  assert.equal(stale.title, 'First detail');
  assert.equal(stale._extra.cacheStale, true);
  source.dispose();

  const authoritative = adapter({
    detailCacheTtlMs: 0,
    getJson: async () => page([raw]),
    resolvePeerTubeVideo: async () => {
      if (!authoritative.called) {
        authoritative.called = true;
        return resolved(raw, { title: 'Public detail' });
      }
      const error = new Error('video became private');
      Object.assign(error, { code: 'PEERTUBE_NOT_PUBLIC', status: 422, retryable: false });
      throw error;
    },
  });
  const authoritativeSummary = (await authoritative.browsePage()).items[0];
  await authoritative.resolveStream(structuredClone(authoritativeSummary));
  const nowPrivate = structuredClone(authoritativeSummary);
  await assert.rejects(
    authoritative.resolveStream(nowPrivate),
    { code: 'PEERTUBE_NOT_PUBLIC' },
  );
  assert.equal(nowPrivate._extra.needsResolve, false);
  assert.equal(nowPrivate._extra.resolutionStatus, 'unavailable');
  assert.equal(resolveMediaAction(nowPrivate), 'unavailable');
  authoritative.dispose();

  const generations = [deferred(), deferred()];
  let generationCalls = 0;
  const race = adapter({
    getJson: async () => page([raw]),
    resolvePeerTubeVideo: async () => generations[generationCalls++].promise,
  });
  const raceItem = (await race.browsePage()).items[0];
  const older = race.resolveStream(structuredClone(raceItem), {
    signal: new AbortController().signal,
  });
  await flush();
  const newerItem = structuredClone(raceItem);
  const newer = race.resolveStream(newerItem, { signal: new AbortController().signal });
  await flush();
  generations[1].resolve(resolved(raw, { title: 'New detail' }));
  await newer;
  generations[0].resolve(resolved(raw, { title: 'Old detail' }));
  await older;
  const cached = structuredClone(raceItem);
  await race.resolveStream(cached);
  assert.equal(cached.title, 'New detail');
  assert.equal(generationCalls, 2);
  race.dispose();
});

test('out-of-order index generations cannot replace newer pages or contaminate random', async () => {
  const generations = [deferred(), deferred()];
  let calls = 0;
  const source = adapter({ getJson: async () => generations[calls++].promise, random: () => 0 });
  const older = source.browsePage({ signal: new AbortController().signal });
  await flush();
  const newer = source.browsePage({ signal: new AbortController().signal });
  await flush();
  generations[1].resolve(page([summary(2, { name: 'New page' })]));
  assert.equal((await newer).items[0].title, 'New page');
  generations[0].resolve(page([summary(1, { name: 'Old page' })]));
  await older;
  assert.equal((await source.browsePage()).items[0].title, 'New page');
  assert.deepEqual((await source.random({ limit: 5 })).map((item) => item.title), ['New page']);
  source.dispose();
});

test('index 429 honors Retry-After without turning a failure into exhaustion', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const source = createPeerTubeAdapter({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    getJson: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new HttpError('rate limited', { status: 429 });
        error.retryAfterMs = null;
        error.retryAfter = 30;
        throw error;
      }
      return page([summary(1)]);
    },
    originScheduler: immediateOriginScheduler(),
  });
  await assert.rejects(source.browsePage(), { status: 429 });
  const pending = source.browsePage();
  await flush();
  assert.equal(calls, 1);
  await clock.advance(29_999);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal((await pending).items.length, 1);
  assert.equal(calls, 2);
  source.dispose();
});

test('origin scheduler caps global four/per-host two and isolates a host cooldown', async () => {
  const clock = new FakeClock();
  const scheduler = createPeerTubeOriginScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const releases = [];
  const active = new Map();
  let global = 0;
  let maxGlobal = 0;
  const maxByHost = new Map();
  function task(origin) {
    return scheduler.run(origin, async () => {
      const host = new URL(origin).host;
      global += 1;
      active.set(host, (active.get(host) || 0) + 1);
      maxGlobal = Math.max(maxGlobal, global);
      maxByHost.set(host, Math.max(maxByHost.get(host) || 0, active.get(host)));
      const release = deferred();
      releases.push({ host, release });
      await release.promise;
      active.set(host, active.get(host) - 1);
      global -= 1;
      return host;
    });
  }
  const jobs = [
    task('https://a.example.org'), task('https://a.example.org'), task('https://a.example.org'),
    task('https://b.example.org'), task('https://b.example.org'), task('https://c.example.org'),
  ];
  await flush();
  assert.equal(releases.length, 4);
  assert.equal(maxGlobal, 4);
  assert.equal(maxByHost.get('a.example.org'), 2);
  while (releases.length < jobs.length) {
    const pending = releases.find((entry) => !entry.done);
    pending.done = true;
    pending.release.resolve();
    await flush();
  }
  for (const entry of releases) if (!entry.done) entry.release.resolve();
  await Promise.all(jobs);

  scheduler.imposeCooldown('https://a.example.org', 1_000);
  let aStarted = false;
  let bStarted = false;
  const delayedA = scheduler.run('https://a.example.org', async () => { aStarted = true; });
  const independentB = scheduler.run('https://b.example.org', async () => { bStarted = true; });
  await flush();
  assert.equal(aStarted, false);
  assert.equal(bStarted, true);
  await independentB;
  await clock.advance(999);
  assert.equal(aStarted, false);
  await clock.advance(1);
  await delayedA;
  assert.equal(aStarted, true);
  scheduler.dispose();
});

test('artwork uses only the opaque relay and favorite normalization preserves identity and future fields', async () => {
  const raw = summary(1);
  const registrations = [];
  const source = adapter({
    getJson: async () => page([raw]),
    registerCatalogAsset: async (request) => {
      registrations.push(request);
      return { relay_url: '/api/v1/assets/abcdefghijklmnopQRSTUV' };
    },
  });
  const item = (await source.browsePage()).items[0];
  assert.equal(item.thumbnail, '');
  item.futureItemField = 7;
  await source.resolveArtwork(item);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].url, raw.thumbnailUrl);
  assert.equal(registrations[0].sourceId, id);
  assert.match(item.thumbnail, /^\/api\/v1\/assets\//);
  const favorite = normalizeFavoriteItem(item);
  assert.equal(favorite.thumbnail, '');
  assert.equal(favorite._extra.needsArtwork, true);
  assert.equal(favorite._extra.artworkUrl, raw.thumbnailUrl);
  assert.equal(favorite._extra.uuid, raw.uuid);
  assert.equal(favorite.futureItemField, 7);
  source.dispose();

  const restarted = adapter({
    getJson: async () => { throw new Error('favorite resolution must not reload Sepia'); },
    resolvePeerTubeVideo: async () => resolved(raw),
  });
  await restarted.resolveStream(favorite);
  assert.equal(favorite.id, peerTubeIdentity(raw.url, raw.uuid).id);
  assert.equal(resolveMediaAction(favorite), 'download');
  assert.match(favorite.stream_url, /\.m3u8$/);
  restarted.dispose();
});

test('random seeds from one bounded Sepia page and never fans out to an origin', async () => {
  let indexCalls = 0;
  let originCalls = 0;
  const source = adapter({
    random: () => 0.5,
    getJson: async () => { indexCalls += 1; return page([summary(1), summary(2), summary(3)]); },
    resolvePeerTubeVideo: async () => { originCalls += 1; throw new Error('must not resolve'); },
  });
  const items = await source.random({ limit: 2 });
  assert.equal(items.length, 2);
  assert.equal(indexCalls, 1);
  assert.equal(originCalls, 0);
  source.dispose();
});

test('random refreshes a safe bounded page when the cache contains only explicit items', async () => {
  let calls = 0;
  const explicitRaw = structuredClone(fixture.index.data[2]);
  const safeRaw = structuredClone(fixture.index.data[0]);
  const source = adapter({
    getJson: async () => {
      calls += 1;
      return calls === 1 ? page([explicitRaw]) : page([safeRaw]);
    },
  });
  await source.browsePage({ showExplicitContent: true });
  const items = await source.random({ showExplicitContent: false, limit: 1 });
  assert.equal(items.length, 1);
  assert.equal(items[0].content_rating, 'not-explicit');
  assert.equal(calls, 2);
  source.dispose();
});

test('abort and disposal cancel queued/in-flight index work and clear later use', async () => {
  let calls = 0;
  const source = createPeerTubeAdapter({
    getJson: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    originScheduler: immediateOriginScheduler(),
  });
  const controller = new AbortController();
  const cancelled = source.browsePage({ signal: controller.signal });
  await flush();
  controller.abort('generation changed');
  await assert.rejects(cancelled, { name: 'AbortError' });
  const disposing = source.browsePage();
  await flush();
  source.dispose();
  await assert.rejects(disposing, { name: 'AbortError' });
  assert.equal(calls, 1, 'the second request stayed queued behind the index interval and was cancelled');
  await assert.rejects(source.browsePage(), { name: 'AbortError' });

  const assetStarted = deferred();
  const assetSource = adapter({
    getJson: async () => page([summary(1)]),
    registerCatalogAsset: async (_request, { signal }) => {
      assetStarted.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const artworkItem = (await assetSource.browsePage()).items[0];
  const artwork = assetSource.resolveArtwork(artworkItem);
  await assetStarted.promise;
  assetSource.dispose();
  await assert.rejects(artwork, { name: 'AbortError' });
  assert.equal(artworkItem.thumbnail, '');
  await assert.rejects(assetSource.random(), { name: 'AbortError' });
});
