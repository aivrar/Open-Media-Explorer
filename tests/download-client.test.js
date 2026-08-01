import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelDownload, getDownloadJob, openDownloadsFolder,
  startItemDownload, startRegisteredDownload,
} from '../src/lib/download-client.js';
import { resetControlSession } from '../src/lib/capture-client.js';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true, data }) };
}

test('finite download exchanges the original URL for an opaque ID before start', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { token: 'download-token' });
    if (path === '/api/v1/media/register') return response(201, { media_id: 'opaque_media_id_1234567890' });
    return response(202, { id: 'job_download_1234567890', state: 'queued' });
  };
  await startItemDownload({
    id: 'nasa:item', title: 'NASA clip', source: 'nasa', type: 'video', stream_kind: 'video',
    download_url: 'https://media.example/private/original.mp4?token=secret',
    download_name: 'original.mp4', capture_headers: {},
  }, { fetchImpl });
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/v1/session', '/api/v1/media/register', '/api/v1/jobs/download',
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { media_id: 'opaque_media_id_1234567890' });
  assert.equal(calls[2].options.body.includes('media.example'), false);
});

test('download status cancel and open-folder use fixed authenticated routes', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { token: 'token' });
    return response(200, { state: 'running' });
  };
  await startRegisteredDownload('opaque_media_id_1234567890', { fetchImpl });
  await getDownloadJob('job_download_1234567890', { fetchImpl });
  await cancelDownload('job_download_1234567890', { fetchImpl });
  await openDownloadsFolder({ fetchImpl });
  assert.deepEqual(calls.slice(1).map((call) => call.path), [
    '/api/v1/jobs/download', '/api/v1/jobs/job_download_1234567890',
    '/api/v1/jobs/job_download_1234567890/cancel', '/api/v1/downloads/open-folder',
  ]);
  assert.deepEqual(JSON.parse(calls[3].options.body), {});
  assert.deepEqual(JSON.parse(calls[4].options.body), {});
});
