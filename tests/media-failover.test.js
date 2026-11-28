import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectMediaRelay, playedStream, probeMediaRelay, streamCandidatesForItem,
} from '../src/lib/media-failover.js';
import { startFailureKind } from '../src/lib/did-not-play.js';

function tvItem() {
  return {
    id: 'iptv-org:fixture', title: 'Fixture TV', source: 'iptv-org', type: 'tv',
    stream_url: 'https://dead.example/live.m3u8', stream_kind: 'hls',
    delivery: 'live', capture_headers: {},
    _extra: {
      streamCandidates: [
        { url: 'https://dead.example/live.m3u8', kind: 'hls', headers: {} },
        { url: 'https://good.example/live.m3u8', kind: 'hls', headers: { userAgent: 'Fixture/1' } },
      ],
    },
  };
}

test('candidate selection is bounded, canonical, de-duplicated, and rejects unsafe URLs', () => {
  const item = tvItem();
  item._extra.streamCandidates.push(
    { url: 'file:///private', kind: 'hls', headers: {} },
    { url: 'https://user:secret@example.test/live.m3u8', kind: 'hls', headers: {} },
    ...Array.from({ length: 12 }, (_value, index) => ({
      url: `https://backup${index}.example/live.m3u8`, kind: 'hls', headers: {},
    })),
  );
  const candidates = streamCandidatesForItem(item);
  assert.equal(candidates.length, 8);
  assert.equal(candidates[0].url, 'https://dead.example/live.m3u8');
  assert.equal(candidates.some((candidate) => candidate.url.startsWith('file:')), false);
  assert.equal(candidates.some((candidate) => candidate.url.includes('secret')), false);
});

test('two endpoint attempts race and the reachable winner becomes the recording URL', async () => {
  const item = tvItem();
  const expired = [];
  const relay = await connectMediaRelay(item, {
    timeoutMs: 1_000,
    fetchImpl: async () => { throw new Error('probeImpl owns this fixture'); },
    registerImpl: async (candidate) => ({
      media_id: candidate.stream_url.includes('dead') ? 'dead_media_1234567890' : 'good_media_1234567890',
      relay_url: candidate.stream_url.includes('dead') ? '/api/v1/media/dead' : '/api/v1/media/good',
    }),
    probeImpl: async (_registration, candidate) => {
      if (candidate.url.includes('dead')) throw Object.assign(new Error('upstream 502'), { status: 502 });
      return true;
    },
    expireImpl: async (mediaId) => { expired.push(mediaId); },
  });
  assert.equal(relay.media_id, 'good_media_1234567890');
  // The item keeps its own address; the stream that plays is kept apart.
  assert.equal(item.stream_url, 'https://dead.example/live.m3u8');
  assert.equal(playedStream(item).url, 'https://good.example/live.m3u8');
  assert.equal(playedStream(item).headers.userAgent, 'Fixture/1');
  assert.equal(streamCandidatesForItem(item)[0].url, 'https://good.example/live.m3u8', 'a recording takes it');
  assert.deepEqual(expired, ['dead_media_1234567890']);
});

test('a lone TV backup uses audio only when its relay confirms plain audio', async () => {
  const item = tvItem();
  const backup = 'https://backup.example/live.mp3';
  item._extra.streamCandidates = [{ url: backup }];
  for (const [status, contentType, expectedKind] of [
    [206, 'audio/mpeg; charset=binary', 'audio'],
    [206, 'application/octet-stream', 'video'],
    [206, 'video/mp4', 'video'],
    [416, 'text/plain', 'video'],
  ]) {
    const relay = await connectMediaRelay(item, {
      skipUrls: [item.stream_url],
      registerImpl: async () => ({ relay_url: '/api/v1/media/backup' }),
      fetchImpl: async () => new Response(null, { status, headers: { 'Content-Type': contentType } }),
    });
    assert.equal(relay.relay_url, '/api/v1/media/backup');
    assert.equal(playedStream(item).url, backup);
    assert.equal(playedStream(item).kind, expectedKind, contentType);
  }
});

test('HLS preflight reaches a segment and rejects a playlist whose media is dead', async () => {
  const calls = [];
  const fetchImpl = async (path) => {
    calls.push(path);
    if (path === '/api/v1/media/root_opaque_1234567890') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/api/v1/media/child_opaque_1234567890.m3u8\n', {
        status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (path === '/api/v1/media/child_opaque_1234567890.m3u8') {
      return new Response('#EXTM3U\n#EXTINF:4,\n/api/v1/media/segment_opaque_1234567890.ts\n', {
        status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    return new Response(JSON.stringify({
      ok: false, error: { code: 'MEDIA_CONNECT_FAILED' },
    }), { status: 502, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(
    probeMediaRelay(
      { relay_url: '/api/v1/media/root_opaque_1234567890' },
      { kind: 'hls' },
      { fetchImpl },
    ),
    (error) => error.code === 'MEDIA_CONNECT_FAILED' && error.status === 502,
  );
  assert.deepEqual(calls, [
    '/api/v1/media/root_opaque_1234567890',
    '/api/v1/media/child_opaque_1234567890.m3u8',
    '/api/v1/media/segment_opaque_1234567890.ts',
  ]);
});

test('HLS preflight probes the newest live segment instead of an evicted oldest segment', async () => {
  const calls = [];
  const fetchImpl = async (path) => {
    calls.push(path);
    if (path === '/api/v1/media/root_newest_1234567890') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/api/v1/media/child_newest_1234567890.m3u8\n', {
        status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (path === '/api/v1/media/child_newest_1234567890.m3u8') {
      return new Response([
        '#EXTM3U',
        '#EXTINF:2,', '/api/v1/media/old_segment_1234567890.ts',
        '#EXTINF:2,', '/api/v1/media/middle_segment_1234567890.ts',
        '#EXTINF:2,', '/api/v1/media/newest_segment_1234567890.ts',
      ].join('\n'), {
        status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (path === '/api/v1/media/newest_segment_1234567890.ts') {
      return new Response(new Uint8Array([0x47]), {
        status: 200, headers: { 'content-type': 'video/mp2t' },
      });
    }
    return new Response(null, { status: 404 });
  };
  await probeMediaRelay(
    { relay_url: '/api/v1/media/root_newest_1234567890' },
    { kind: 'hls' },
    { fetchImpl },
  );
  assert.deepEqual(calls, [
    '/api/v1/media/root_newest_1234567890',
    '/api/v1/media/child_newest_1234567890.m3u8',
    '/api/v1/media/newest_segment_1234567890.ts',
  ]);
});

const HLS_HEADERS = { 'content-type': 'application/vnd.apple.mpegurl' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('header-only HLS waits twelve seconds, then expires and tries its listed backup', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const item = tvItem();
  const backup = 'https://good.example/live.m3u8';
  const registered = [];
  const expired = [];
  let emptyReads = 0;
  const connecting = connectMediaRelay(item, {
    addresses: { main: item.stream_url, backups: [backup], ordered: true },
    registerImpl: async ({ stream_url }) => {
      registered.push(stream_url);
      const id = stream_url === backup ? 'backup_manifest' : 'empty_manifest';
      return { media_id: id, relay_url: '/api/v1/media/' + id + '.m3u8' };
    },
    fetchImpl: async (path) => {
      if (path.includes('empty_manifest')) {
        emptyReads++;
        return new Response('#EXTM3U\n#EXT-X-MAP:URI="/api/v1/media/init_segment.mp4"\n', { headers: HLS_HEADERS });
      }
      if (path.endsWith('.m3u8')) {
        return new Response('#EXTM3U\n#EXTINF:4,\n/api/v1/media/backup_segment.ts', { headers: HLS_HEADERS });
      }
      return new Response(new Uint8Array([0x47]));
    },
    expireImpl: async (id) => { expired.push(id); },
  });
  await settle();
  for (let second = 0; second < 11; second++) {
    t.mock.timers.tick(1_000);
    await settle();
  }
  t.mock.timers.tick(999);
  assert.deepEqual(registered, [item.stream_url]);
  t.mock.timers.tick(1);
  assert.equal((await connecting).media_id, 'backup_manifest');
  assert.equal(emptyReads, 13);
  assert.deepEqual(registered, [item.stream_url, backup]);
  assert.deepEqual(expired, ['empty_manifest']);
});

test('an empty HLS media playlist can recover, cancel, or fail after twelve seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = '/api/v1/media/root_manifest.m3u8';
  const child = '/api/v1/media/child_manifest.m3u8';
  const segment = '/api/v1/media/first_segment.ts';
  let childReads = 0;
  let recover = true;
  const controller = new AbortController();
  const fetchImpl = async (path) => {
    if (path === root) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n' + child, { headers: HLS_HEADERS });
    if (path === segment) return new Response(new Uint8Array([0x47]));
    assert.equal(path, child);
    childReads++;
    if (recover && childReads === 2) {
      return new Response('#EXTM3U\n#EXT-X-PART:DURATION=1,URI="' + segment + '"', { headers: HLS_HEADERS });
    }
    const body = '#EXTM3U\n';
    return new Response(body, { headers: { ...HLS_HEADERS, 'content-length': String(body.length) } });
  };
  const probe = (signal) => probeMediaRelay({ relay_url: root }, { kind: 'hls' }, { fetchImpl, signal });
  const recovered = probe();
  await settle();
  t.mock.timers.tick(1_000);
  assert.equal(await recovered, true);
  recover = false;
  const cancelled = assert.rejects(probe(controller.signal), { name: 'AbortError' });
  await settle();
  controller.abort();
  await cancelled;
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(childReads, 3, 'the cancelled probe did not poll again');

  let failed = false;
  const outcome = assert.rejects(probe(), (error) => {
    failed = true;
    return error.code === 'EMPTY_HLS_MANIFEST' && startFailureKind(error) === 'refused';
  });
  await settle();
  for (let second = 0; second < 11; second++) {
    t.mock.timers.tick(1_000);
    await settle();
  }
  t.mock.timers.tick(999);
  await settle();
  assert.equal(failed, false);
  assert.equal(childReads, 15);
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(childReads, 16);
});
test('HLS preflight leaves inconclusive replies and ordinary starts on the immediate path', async () => {
  const root = '/api/v1/media/root_manifest.m3u8';
  const child = '/api/v1/media/child_manifest.m3u8';
  const part = '/api/v1/media/latest_part.m4s';
  const cases = [
    ['#EXTM3U\n#EXT-X-TARGETDURATION:6\n', []],
    ['#EXTM3U\n#EXT-X-ENDLIST\n', []],
    ['#EXTM3U\n#EXT-X-UNRECOGNIZED:VALUE\n', []],
    ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', []],
    ['#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="' + child + '"\n', [child, part]],
    ['#EXTM3U\n#EXT-X-PART:DURATION=1,URI="' + part + '"\n', [part]],
    ['#EXTM3U\n', [], 206],
  ];

  for (const [manifest, expected, status = 200] of cases) {
    const requests = [];
    const ready = await probeMediaRelay({ relay_url: root }, { kind: 'hls' }, {
      fetchImpl: async (path) => {
        requests.push(path);
        if (path === root) return new Response(manifest, { status, headers: HLS_HEADERS });
        if (path === child) return new Response('#EXTM3U\n#EXT-X-PART:DURATION=1,URI="' + part + '"\n', { headers: HLS_HEADERS });
        assert.equal(path, part);
        return new Response(new Uint8Array([0x47]));
      },
      onEmptyPlaylist: () => assert.fail('this response must not start polling'),
    });
    assert.equal(ready, true, manifest);
    assert.deepEqual(requests, [root, ...expected]);
  }
});

test('HLS preflight rejects refused, blank, and non-HLS replies without waiting or polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = '/api/v1/media/root_manifest.m3u8';
  const refused = Response.json({ error: { code: 'INVALID_HLS_MANIFEST' } }, { status: 502 });
  const blank = new Response('', { headers: HLS_HEADERS });
  const binary = new Response(new Uint8Array([0x47]), { headers: { 'content-type': 'application/octet-stream' } });
  for (const response of [refused, blank, binary]) {
    let reads = 0;
    await assert.rejects(probeMediaRelay({ relay_url: root }, { kind: 'hls' }, {
      fetchImpl: async () => {
        reads++;
        return response;
      },
      onEmptyPlaylist: () => assert.fail('this response must not start polling'),
    }), (error) => error.code === 'INVALID_HLS_MANIFEST' && (response.ok || error.status === 502));
    t.mock.timers.tick(12_000);
    await settle();
    assert.equal(reads, 1);
  }
});

test('a complete empty HLS response polls, even when it has an end marker and parts', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = '/api/v1/media/root_manifest.m3u8';
  const part = '/api/v1/media/latest_part.m4s';
  const cases = [
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n',
    '#EXTM3U\n#EXT-X-PART:DURATION=1,URI="' + part + '"\n#EXT-X-ENDLIST\n',
  ];
  for (const manifest of cases) {
    let polls = 0;
    const requests = [];
    const result = probeMediaRelay({ relay_url: root }, { kind: 'hls' }, {
      fetchImpl: async (path) => {
        requests.push(path);
        assert.equal(path, root);
        const body = requests.length === 1 ? manifest : '#EXTM3U\n#EXTINF:6,\nsegment.ts\n';
        return new Response(body, { headers: { ...HLS_HEADERS, 'content-length': String(body.length) } });
      },
      onEmptyPlaylist: () => { polls++; },
    });
    await settle();
    assert.equal(polls, 1);
    assert.deepEqual(requests, [root]);
    t.mock.timers.tick(1_000);
    assert.equal(await result, true);
    assert.deepEqual(requests, [root, root]);
  }
});
