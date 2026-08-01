import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createOwncastAdapter,
  normalizeInstanceUrl,
  normalizeOwncastStreamUrl,
  OWNCAST_REFRESH_AFTER_MS,
  OWNCAST_STALE_RETRY_MS,
} from '../src/adapters/owncast.js';
import { validateItem } from '../src/lib/item-model.js';
import { normalizeFavoriteItem } from '../src/lib/state.js';
import { SOURCES } from '../src/lib/sources.js';

const sha256Hex = async (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const execFileAsync = promisify(execFile);

async function snapshotThroughBackend(name = 'valid') {
  const bridge = new URL('../tests_python/owncast_adapter_bridge.py', import.meta.url);
  const { stdout } = await execFileAsync('python', [fileURLToPath(bridge), name], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) {
    const error = new Error(envelope.error?.message || 'Owncast backend rejected the fixture.');
    Object.assign(error, envelope.error);
    throw error;
  }
  return envelope.value;
}

function raw(origin, overrides = {}) {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return {
    instance_url: base,
    stream_url: `${base}hls/stream.m3u8`,
    name: `Name ${new URL(base).hostname}`,
    stream_title: `Live ${new URL(base).hostname}`,
    description: '<p>Independent &amp; verified</p>',
    content_rating: 'not-explicit',
    nsfw: false,
    tags: ['music', 'community'],
    logo_url: `${base}logo.png`,
    last_seen: '2026-07-14T12:00:00.000Z',
    streaming_since: '2026-07-14T11:00:00.000Z',
    delivery: 'live',
    media_type: 'hls',
    recording_kind: 'video',
    ...overrides,
  };
}

function response(items, cache = {}) {
  const state = cache.state || 'updated';
  return {
    provider: 'owncast',
    items,
    cache: {
      state,
      stale: state === 'stale',
      ...(cache.reason ? { reason: cache.reason } : {}),
    },
  };
}

function adapter(getOwncastSnapshot, extra = {}) {
  return createOwncastAdapter({ getOwncastSnapshot, sha256Hex, ...extra });
}

test('Owncast exports its bounded contract and is registered in Phase 8', async () => {
  assert.equal(SOURCES.some((source) => source.id === 'owncast'), true);
  const sourceText = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/lib/sources.js', import.meta.url), 'utf8',
  ));
  assert.match(sourceText, /adapters\/owncast/);
  assert.match(sourceText, /id:\s*['"]owncast/);
});

test('verified snapshot has exact SHA-256 instance IDs, live HLS semantics, and explicit default-off filtering', async () => {
  const safe = raw('https://safe.example.org/');
  const explicit = raw('https://explicit.example.org/', {
    content_rating: 'explicit', nsfw: true, tags: ['marked'],
  });
  let calls = 0;
  const source = adapter(async () => { calls += 1; return response([safe, explicit]); });

  const hidden = await source.refreshSnapshot();
  assert.equal(hidden.items.length, 1);
  assert.equal(hidden.refreshAfterMs, OWNCAST_REFRESH_AFTER_MS);
  assert.equal(hidden.stale, false);
  assert.equal(hidden.items[0].id, `owncast:${await sha256Hex('https://safe.example.org/')}`);
  assert.deepEqual(validateItem(hidden.items[0]), []);
  assert.equal(hidden.items[0].stream_url, 'https://safe.example.org/hls/stream.m3u8');
  assert.equal(hidden.items[0].stream_kind, 'hls');
  assert.equal(hidden.items[0].delivery, 'live');
  assert.equal(hidden.items[0].type, 'tv');
  assert.equal(hidden.items[0]._extra.needsResolve, false);
  assert.equal(hidden.items[0]._extra.downloadResolved, true);
  assert.equal(hidden.items[0]._extra.resolutionStatus, 'playable');
  assert.equal(hidden.items[0]._extra.snapshotItem, true);
  assert.equal(hidden.items[0].source_url, 'https://safe.example.org/');
  assert.equal(hidden.items[0].license, 'Independent broadcaster - see source');
  assert.equal(hidden.items[0].description, 'Independent & verified');

  const shown = await source.refreshSnapshot({ showExplicitContent: true });
  assert.equal(shown.items.length, 2);
  const marked = shown.items.find((item) => item.content_rating === 'explicit');
  assert.ok(marked.tags.includes('Explicit'), 'enabled explicit content remains visibly marked');
  assert.equal(calls, 1, 'changing the local safety view reuses the same verified snapshot');
  source.dispose();
});

test('optional unsafe artwork is suppressed, the explicit marker survives a full tag list, and favorites persist no live URI', async () => {
  const tags = Array.from({ length: 16 }, (_value, index) => `tag-${index}`);
  const source = adapter(async () => response([raw('https://privacy.example.org/', {
    nsfw: true,
    content_rating: 'explicit',
    tags,
    logo_url: 'https://privacy.example.org/logo.png?access_token=private-art-value',
    stream_url: 'https://privacy.example.org/hls/stream.m3u8?access_token=public-directory-value',
  })]));
  const item = (await source.refreshSnapshot({ showExplicitContent: true })).items[0];
  assert.equal(item._extra.artworkUrl, '');
  assert.equal(item.tags.length, 16);
  assert.equal(item.tags.at(-1), 'Explicit');
  const favorite = normalizeFavoriteItem(item);
  assert.equal(favorite.stream_url, '');
  assert.equal(favorite._extra.needsResolve, true);
  assert.equal(favorite._extra.resolutionStatus, 'unresolved');
  assert.doesNotMatch(JSON.stringify(favorite), /access_token|public-directory-value|private-art-value/);
  assert.equal(favorite.id, item.id);
  assert.equal(favorite.source_url, item.source_url);
  source.dispose();
});

test('the full defended M3U/rating gateway fixture crosses into the adapter without losing edge cases', async () => {
  const source = adapter(() => snapshotThroughBackend('valid'));
  const safe = await source.refreshSnapshot();
  assert.equal(safe.items.length, 4, 'the one verified explicit entry is hidden by default');
  assert.equal(safe.items.some((item) => item.source_url === 'https://unrated.example.org/'), false);
  assert.equal(safe.items.some((item) => item.source_url === 'https://malformed.example.org/'), false);
  assert.ok(safe.items.some((item) => item.source_url === 'https://comma.example.org/'));
  assert.ok(safe.items.some((item) => item.source_url === 'https://multiline.example.org/'));
  assert.ok(safe.items.some((item) => item.source_url === 'http://http-stream.example.org:8080/'));
  assert.equal(safe.items.every((item) => validateItem(item).length === 0), true);

  const all = await source.refreshSnapshot({ showExplicitContent: true });
  assert.equal(all.items.length, 5);
  assert.equal(all.items.filter((item) => item.content_rating === 'explicit').length, 1);
  source.dispose();

  const denied = adapter(() => snapshotThroughBackend('ratings-missing'));
  await assert.rejects(denied.refreshSnapshot(), /rating metadata is unavailable/i);
  await assert.rejects(
    denied.refreshSnapshot({ showExplicitContent: true }),
    /rating metadata is unavailable/i,
  );
  denied.dispose();
});

test('snapshot updates, exact duplicates, stale native state, local LKG, and recovery are deterministic', async () => {
  const one = raw('https://one.example.org/');
  const updated = raw('https://one.example.org/', { stream_title: 'Updated title' });
  const two = raw('https://two.example.org/');
  const replies = [
    response([one, { ...one }]),
    response([updated, two]),
    response([updated, two], { state: 'stale', reason: 'DIRECTORY_TIMEOUT' }),
    new Error('temporary transport failure'),
    response([two]),
  ];
  const source = adapter(async () => {
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return value;
  });

  const first = await source.refreshSnapshot();
  assert.equal(first.items.length, 1, 'an exact duplicate origin is collapsed');
  const second = await source.refreshSnapshot({ force: true });
  assert.equal(second.items.find((item) => item.source_url.includes('one.')).title, 'Updated title');
  const nativeStale = await source.refreshSnapshot({ force: true });
  assert.equal(nativeStale.stale, true);
  assert.equal(nativeStale.error, 'DIRECTORY_TIMEOUT');
  assert.equal(nativeStale.retryAfterMs, OWNCAST_STALE_RETRY_MS);
  const localStale = await source.refreshSnapshot({ force: true });
  assert.equal(localStale.stale, true);
  assert.match(localStale.error, /temporary transport failure/);
  assert.equal(localStale.items.length, 2);
  const recovered = await source.refreshSnapshot({ force: true });
  assert.equal(recovered.stale, false);
  assert.deepEqual(recovered.items.map((item) => item.source_url), ['https://two.example.org/']);
  source.dispose();
});

test('conflicting duplicate origins and missing, malformed, or inconsistent ratings fail closed even with an LKG', async () => {
  const safe = raw('https://safe.example.org/');
  const invalids = [
    { ...safe, nsfw: undefined },
    { ...safe, nsfw: 'false' },
    { ...safe, nsfw: true },
    { ...safe, content_rating: 'unrated' },
  ];
  for (const invalid of invalids) {
    const source = adapter(async () => response([invalid]));
    await assert.rejects(source.refreshSnapshot(), /rating|malformed/i);
    await assert.rejects(source.refreshSnapshot({ showExplicitContent: true }), /rating|malformed/i);
    source.dispose();
  }

  const replies = [
    response([safe]),
    response([safe, { ...safe, stream_url: 'https://safe.example.org/other.m3u8' }]),
  ];
  const source = adapter(async () => replies.shift());
  await source.refreshSnapshot();
  await assert.rejects(source.refreshSnapshot({ force: true }), /conflicting duplicate/i,
    'schema/safety failure must not be hidden by the frontend LKG');
  source.dispose();
});

test('only public HTTP(S), same-origin exact HLS playlist URLs are accepted', () => {
  assert.equal(normalizeInstanceUrl('https://Public.Example.org'), 'https://public.example.org/');
  assert.equal(normalizeInstanceUrl('http://public.example.org:8080/'), 'http://public.example.org:8080/');
  assert.equal(
    normalizeInstanceUrl('https://[2001:4860:4860::8888]/'),
    'https://[2001:4860:4860::8888]/',
  );
  for (const value of [
    'ftp://public.example.org/',
    'https://user:pass@public.example.org/',
    'http://127.0.0.1/',
    'http://10.2.3.4/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[2001:db8::1]/',
    'http://host.local/',
    'https://public.example.org/path',
    'https://public.example.org/?token=value',
  ]) assert.equal(normalizeInstanceUrl(value), '', value);

  const origin = 'https://public.example.org/';
  assert.equal(
    normalizeOwncastStreamUrl('https://public.example.org/hls/stream.m3u8?quality=source', origin),
    'https://public.example.org/hls/stream.m3u8?quality=source',
  );
  for (const value of [
    'https://other.example.org/hls/stream.m3u8',
    'https://public.example.org/video.mp4',
    'https://public.example.org/hls/stream.m3u8#fragment',
    'http://127.0.0.1/hls/stream.m3u8',
    'ftp://public.example.org/stream.m3u8',
  ]) assert.equal(normalizeOwncastStreamUrl(value, origin), '', value);
});

test('browse/search use one current snapshot locally while random never triggers a refresh', async () => {
  let calls = 0;
  const source = adapter(async () => {
    calls += 1;
    return response([
      raw('https://music.example.org/', { tags: ['techno', 'community'] }),
      raw('https://talk.example.org/', { stream_title: 'Open source discussion', tags: ['talk'] }),
    ]);
  }, { random: () => 0 });

  assert.deepEqual(await source.random(), []);
  assert.equal(calls, 0, 'random on an empty current snapshot does not fetch');
  assert.deepEqual(await source.browsePage(), {
    items: [], cursor: null, exhausted: true, snapshotOnly: true,
  });
  assert.equal(calls, 0, 'the finite browse lane remains empty');
  assert.equal((await source.browse()).length, 2);
  assert.equal(calls, 1);
  assert.deepEqual((await source.search('open discussion')).map((item) => item.source_url), [
    'https://talk.example.org/',
  ]);
  assert.equal((await source.search('techno')).length, 1);
  assert.equal((await source.random({ limit: 1 })).length, 1);
  assert.equal(calls, 1, 'local search and random never refetch the current snapshot');
  source.dispose();
});

test('local search and random reuse the filtered snapshot hash instead of rehashing every keystroke', async () => {
  let hashes = 0;
  const source = adapter(async () => response([
    raw('https://safe-cache.example.org/'),
    raw('https://explicit-cache.example.org/', { nsfw: true, content_rating: 'explicit' }),
  ]), {
    sha256Hex: async (value) => {
      hashes += 1;
      return sha256Hex(value);
    },
  });
  await source.refreshSnapshot();
  const afterRefresh = hashes;
  await source.search('safe');
  await source.search('safe cache');
  await source.random();
  await source.random({ limit: 1 });
  assert.equal(hashes, afterRefresh);
  source.dispose();
});

test('valid zero snapshot remains refreshable and is never converted to finite exhaustion data', async () => {
  let calls = 0;
  const source = adapter(async () => { calls += 1; return response([]); });
  const first = await source.refreshSnapshot();
  const second = await source.refreshSnapshot({ force: true });
  assert.deepEqual(first.items, []);
  assert.equal(first.snapshotId, 'owncast-snapshot:empty');
  assert.equal(first.refreshAfterMs, OWNCAST_REFRESH_AFTER_MS);
  assert.deepEqual(second.items, []);
  assert.equal(calls, 2, 'a valid zero remains a periodically refreshable snapshot');
  source.dispose();
});

test('the 5,000-entry snapshot ceiling is usable and one extra entry fails before hashing', async () => {
  const maximum = Array.from({ length: 5_000 }, (_value, index) => (
    raw(`https://stream-${index}.example.org/`, { logo_url: '' })
  ));
  const source = adapter(async () => response(maximum));
  const snapshot = await source.refreshSnapshot();
  assert.equal(snapshot.items.length, 5_000);
  assert.equal(new Set(snapshot.items.map((item) => item.id)).size, 5_000);
  source.dispose();

  let hashes = 0;
  const oversized = adapter(async () => response([...maximum, raw('https://overflow.example.org/')] ), {
    sha256Hex: async (value) => {
      hashes += 1;
      return sha256Hex(value);
    },
  });
  await assert.rejects(oversized.refreshSnapshot(), /snapshot response is malformed/i);
  assert.equal(hashes, 0, 'the envelope bound is checked before per-entry work');
  oversized.dispose();
});

test('a recent search snapshot is adopted without a duplicate fetch and an aged snapshot refreshes', async () => {
  let time = 0;
  let calls = 0;
  const source = adapter(async () => {
    calls += 1;
    return response([raw('https://cadence.example.org/', { stream_title: `Revision ${calls}` })]);
  }, { monotonicNow: () => time });
  assert.equal((await source.search('revision')).length, 1);
  assert.equal(calls, 1);
  const adopted = await source.refreshSnapshot();
  assert.equal(adopted.items[0].title, 'Revision 1');
  assert.equal(calls, 1);
  await source.refreshSnapshot();
  assert.equal(calls, 1);
  time = OWNCAST_REFRESH_AFTER_MS;
  const refreshed = await source.refreshSnapshot();
  assert.equal(calls, 2);
  assert.equal(refreshed.items[0].title, 'Revision 2');
  source.dispose();
});

test('an offline favorite is revalidated on selection, marked unavailable, and can recover in place', async () => {
  const live = raw('https://favorite.example.org/');
  const replies = [response([live]), response([]), response([{
    ...live, stream_title: 'Favorite is back', stream_url: 'https://favorite.example.org/live/index.m3u8',
  }])];
  const source = adapter(async () => replies.shift());
  const favorite = (await source.refreshSnapshot()).items[0];
  favorite.__snapshotOffline = true;
  await source.resolveStream(favorite);
  assert.equal(favorite.stream_url, '');
  assert.equal(favorite._extra.resolutionStatus, 'unavailable');
  assert.equal(favorite._extra.validationError, 'OWNCAST_STREAM_OFFLINE');

  favorite.__snapshotOffline = true;
  await source.resolveStream(favorite);
  assert.equal(favorite.title, 'Favorite is back');
  assert.equal(favorite.stream_url, 'https://favorite.example.org/live/index.m3u8');
  assert.equal(favorite.__snapshotOffline, false);
  source.dispose();
});

test('explicit offline favorites remain blocked until the deliberate preference is supplied', async () => {
  const marked = raw('https://marked.example.org/', { nsfw: true, content_rating: 'explicit' });
  const source = adapter(async () => response([marked]));
  const favorite = (await source.refreshSnapshot({ showExplicitContent: true })).items[0];
  favorite.__snapshotOffline = true;
  await source.resolveStream(favorite);
  assert.equal(favorite.stream_url, '');
  assert.equal(favorite._extra.resolutionStatus, 'blocked');
  favorite.__snapshotOffline = true;
  await source.resolveStream(favorite, { showExplicitContent: true });
  assert.equal(favorite.stream_url, 'https://marked.example.org/hls/stream.m3u8');
  source.dispose();
});

test('artwork uses only the opaque relay, and abort/dispose clean up pending work', async () => {
  let registration = null;
  const source = adapter(async () => response([raw('https://art.example.org/')]), {
    registerCatalogAsset: async (payload) => {
      registration = payload;
      return { relay_url: '/api/v1/assets/abcdefghijklmnop' };
    },
  });
  const item = (await source.refreshSnapshot()).items[0];
  await source.resolveArtwork(item);
  assert.deepEqual(registration, {
    url: 'https://art.example.org/logo.png', sourceId: 'owncast', itemId: item.id,
  });
  assert.equal(item.thumbnail, '/api/v1/assets/abcdefghijklmnop');
  source.dispose();

  let underlyingAborted = false;
  const blocked = adapter(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      underlyingAborted = true;
      reject(signal.reason);
    }, { once: true });
  }));
  const controller = new AbortController();
  const pending = blocked.refreshSnapshot({ signal: controller.signal });
  controller.abort(new DOMException('test abort', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(underlyingAborted, true, 'the sole cancelled waiter aborts the native request');
  blocked.dispose();

  let assetAborted = false;
  const artworkBlocked = adapter(async () => response([raw('https://pending-art.example.org/')]), {
    registerCatalogAsset: (_payload, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        assetAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const pendingItem = (await artworkBlocked.refreshSnapshot()).items[0];
  const pendingArtwork = artworkBlocked.resolveArtwork(pendingItem);
  artworkBlocked.dispose();
  await assert.rejects(pendingArtwork, { name: 'AbortError' });
  assert.equal(assetAborted, true);
  await assert.rejects(artworkBlocked.refreshSnapshot(), { name: 'AbortError' });
});
