import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectMediaRelay, probeMediaRelay, streamCandidatesForItem,
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
  assert.equal(item.stream_url, 'https://good.example/live.m3u8');
  assert.equal(item.capture_headers.userAgent, 'Fixture/1');
  assert.deepEqual(expired, ['dead_media_1234567890']);
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
