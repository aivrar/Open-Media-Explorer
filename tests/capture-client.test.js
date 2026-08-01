import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ControlApiError, expireMedia, listCaptureJobs, mediaTypeForItem, recordingKindForItem,
  registerMedia, resetControlSession,
} from '../src/lib/capture-client.js';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('capture client registers only normalized media fields with session auth', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, {
      ok: true, data: { token: 'session-token', origin: 'http://127.0.0.1:9124' }, error: null,
    });
    return response(201, { ok: true, data: {
      media_id: 'opaque_media_token_1234567890',
      relay_url: '/api/v1/media/opaque_media_token_1234567890',
    }, error: null });
  };
  const data = await registerMedia({
    id: 'source:item', source: 'source', stream_url: 'https://media.example/live.m3u8?secret=yes',
    stream_kind: 'hls', delivery: 'live', capture_headers: { referer: 'https://catalog.example/' },
    download_url: 'https://must-not-be-sent.example/file', _extra: { private: true },
  }, { fetchImpl });
  assert.equal(data.relay_url.startsWith('/api/v1/media/'), true);
  assert.equal(calls.length, 2);
  const request = calls[1];
  assert.equal(request.options.headers['X-WorldMedia-Token'], 'session-token');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {
    item_id: 'source:item', url: 'https://media.example/live.m3u8?secret=yes',
    delivery: 'live', media_type: 'hls', recording_kind: 'audio',
    capture_headers: { referer: 'https://catalog.example/' },
    source: 'source', download_name: '',
  });
});

test('job synchronization uses the fixed authenticated list route', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'jobs-token' } });
    return response(200, { ok: true, data: { jobs: [{ id: 'job_sync_1234567890', item_id: 'radio:one' }] } });
  };
  const jobs = await listCaptureJobs({ fetchImpl });
  assert.equal(jobs[0].item_id, 'radio:one');
  assert.equal(calls[1].path, '/api/v1/jobs');
  assert.equal(calls[1].options.headers['X-WorldMedia-Token'], 'jobs-token');
});

test('media expiry is authenticated and API errors remain structured', async () => {
  resetControlSession();
  let count = 0;
  const fetchImpl = async (path, options) => {
    count++;
    if (count === 1) return response(200, { ok: true, data: { token: 'token' } });
    assert.equal(path, '/api/v1/media/opaque_id_1234567890123456/expire');
    assert.deepEqual(JSON.parse(options.body), { grace_seconds: 5 });
    return response(403, { ok: false, error: {
      code: 'INVALID_TOKEN', message: 'Session expired.', retryable: true,
    } });
  };
  await assert.rejects(
    expireMedia('opaque_id_1234567890123456', 5, { fetchImpl }),
    (error) => error instanceof ControlApiError && error.code === 'INVALID_TOKEN' && error.retryable,
  );
  assert.equal(mediaTypeForItem({ type: 'tv', stream_kind: '' }), 'video');
  assert.equal(mediaTypeForItem({ type: 'radio', stream_kind: '' }), 'audio');
  assert.equal(recordingKindForItem({ type: 'tv', stream_kind: 'hls' }), 'video');
  assert.equal(recordingKindForItem({ type: 'radio', stream_kind: 'hls' }), 'audio');
});
