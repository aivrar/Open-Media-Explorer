import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelFfmpegInstall,
  getFfmpegStatus,
  getRuntimeStatus,
  installFfmpegAndResume,
  removeManagedFfmpeg,
  repairFfmpeg,
  saveServerPort,
  startFfmpegInstall,
  waitForFfmpeg,
} from '../src/lib/ffmpeg-client.js';
import { resetControlSession } from '../src/lib/capture-client.js';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function apiFetch(states = []) {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') {
      return response(200, { ok: true, data: { token: 'ffmpeg-token' } });
    }
    const state = states.length ? states.shift() : { state: 'ready', source: 'PATH' };
    return response(path.includes('/install') || path.includes('/repair') ? 202 : 200, {
      ok: true, data: state,
    });
  };
  return { calls, fetchImpl };
}

test('FFmpeg client sends only fixed routes, confirmation, and destinations', async () => {
  resetControlSession();
  const fixture = apiFetch([
    { state: 'ready' }, { state: 'installing' }, { state: 'installing' },
    { state: 'cancelled' }, { state: 'missing' },
  ]);
  await getFfmpegStatus({ fetchImpl: fixture.fetchImpl });
  await startFfmpegInstall('portable', { fetchImpl: fixture.fetchImpl });
  await repairFfmpeg('LocalAppData', { fetchImpl: fixture.fetchImpl });
  await cancelFfmpegInstall({ fetchImpl: fixture.fetchImpl });
  await removeManagedFfmpeg('portable', { fetchImpl: fixture.fetchImpl });

  const requests = fixture.calls.slice(1);
  assert.deepEqual(requests.map((call) => call.path), [
    '/api/v1/ffmpeg/status', '/api/v1/ffmpeg/install', '/api/v1/ffmpeg/repair',
    '/api/v1/ffmpeg/cancel', '/api/v1/ffmpeg/remove',
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { confirmed: true, destination: 'portable' });
  assert.deepEqual(JSON.parse(requests[2].options.body), { confirmed: true, destination: 'LocalAppData' });
  assert.deepEqual(JSON.parse(requests[3].options.body), {});
  assert.deepEqual(JSON.parse(requests[4].options.body), { confirmed: true, destination: 'portable' });
});

test('local server port is read and saved through fixed authenticated runtime routes', async () => {
  resetControlSession();
  const fixture = apiFetch([
    { server_port: 19124, next_launch_port: 19124 },
    { server_port: 19124, next_launch_port: 21345, restart_required: true },
  ]);
  const runtime = await getRuntimeStatus({ fetchImpl: fixture.fetchImpl });
  const saved = await saveServerPort(21345, { fetchImpl: fixture.fetchImpl });

  assert.equal(runtime.server_port, 19124);
  assert.equal(saved.next_launch_port, 21345);
  const requests = fixture.calls.slice(1);
  assert.deepEqual(requests.map((call) => call.path), [
    '/api/v1/runtime', '/api/v1/runtime/server-port',
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { port: 21345 });
});

test('install-and-resume polls until ready and invokes the initiating action once', async () => {
  resetControlSession();
  const fixture = apiFetch([
    { state: 'installing', source: 'portable' },
    { state: 'installing', source: 'portable', progress: 0.5 },
    { state: 'ready', source: 'portable' },
  ]);
  const resumed = [];
  const status = await installFfmpegAndResume('portable', (ready) => resumed.push(ready.source), {
    fetchImpl: fixture.fetchImpl, intervalMs: 0, timeoutMs: 1000,
  });
  assert.equal(status.state, 'ready');
  assert.deepEqual(resumed, ['portable']);
  assert.equal(fixture.calls.filter((call) => call.path === '/api/v1/ffmpeg/status').length, 2);
});

test('FFmpeg wait returns terminal failures and honors abort without polling', async () => {
  resetControlSession();
  const failed = apiFetch([{ state: 'error', error: { code: 'BAD_ASSET_DIGEST' } }]);
  assert.equal((await waitForFfmpeg({ fetchImpl: failed.fetchImpl })).state, 'error');

  resetControlSession();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForFfmpeg({ fetchImpl: apiFetch().fetchImpl, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});
