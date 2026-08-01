import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelRecordingPreparation, getRecordingJob, startItemRecording,
  startRegisteredRecording, stopRecording,
} from '../src/lib/recording-client.js';
import { resetControlSession } from '../src/lib/capture-client.js';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true, data }) };
}

test('recording exchanges live URL for opaque ID and sends a bounded EQ snapshot', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { token: 'record-token' });
    if (path === '/api/v1/media/register') return response(201, { media_id: 'opaque_live_media_1234567890' });
    return response(202, { id: 'job_record_1234567890', state: 'queued' });
  };
  await startItemRecording({
    id: 'radio:live', title: 'Live radio', source: 'radio-browser', type: 'radio',
    stream_kind: 'audio', stream_url: 'https://radio.example/live?token=secret',
    delivery: 'live', capture_headers: {}, download_name: '',
  }, 'balanced', {
    fetchImpl,
    eqCurve: { preamp: -3, bands: [1, 2, 3, 4, 5, 4, 3, 2, 1, 0], bypassed: false, presetId: 'not-sent' },
  });
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/v1/session', '/api/v1/media/register', '/api/v1/jobs/record',
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    media_id: 'opaque_live_media_1234567890', profile: 'balanced',
    eq: { preamp: -3, bands: [1, 2, 3, 4, 5, 4, 3, 2, 1, 0], bypassed: false },
  });
  assert.equal(calls[2].options.body.includes('radio.example'), false);
});

test('recording stop cancel status and direct registered start use fixed routes', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { token: 'token' });
    return response(200, { state: 'running' });
  };
  await startRegisteredRecording('opaque_live_media_1234567890', 'high', { fetchImpl });
  await getRecordingJob('job_record_1234567890', { fetchImpl });
  await stopRecording('job_record_1234567890', { fetchImpl });
  await cancelRecordingPreparation('job_record_1234567890', { fetchImpl });
  assert.deepEqual(calls.slice(1).map((call) => call.path), [
    '/api/v1/jobs/record', '/api/v1/jobs/job_record_1234567890',
    '/api/v1/jobs/job_record_1234567890/stop', '/api/v1/jobs/job_record_1234567890/cancel',
  ]);
});
