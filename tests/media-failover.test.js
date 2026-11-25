import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectMediaRelay, playedStream, probeMediaRelay, streamCandidatesForItem,
} from '../src/lib/media-failover.js';

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
