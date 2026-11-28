import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addComputerFolder,
  cancelComputerScan,
  computerHlsToken,
  computerMediaToken,
  keepComputerMedia,
  releaseComputerMedia,
  computerStatus,
  listComputerFolders,
  loadComputerLibrary,
  loadComputerSubtitle,
  openComputerMedia,
  pickComputerFolder,
  releaseComputerHls,
  relocateComputerFolder,
  removeComputerFolder,
  startComputerScan,
} from '../src/lib/computer-client.js';
import { resetControlSession } from '../src/lib/capture-client.js';

test('Computer folder requests send the session token and put paths only in JSON bodies', async () => {
  resetControlSession();
  const folder = { id: 'folder-id', path: 'D:\\Music & more', available: true, added: '2026-11-26T00:00:00+00:00' };
  const responses = [
    { token: 'computer-token' }, { folders: [] }, { folder, folders: [folder] }, { folders: [] },
  ];
  const calls = [];
  const options = {
    fetchImpl: async (path, request) => {
      calls.push([path, request]);
      const data = responses.shift();
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    },
  };
  assert.deepEqual(await listComputerFolders(options), { folders: [] });
  assert.deepEqual(await addComputerFolder(folder.path, options), { folder, folders: [folder] });
  assert.deepEqual(await removeComputerFolder(folder.id, options), { folders: [] });
  assert.deepEqual(calls.map(([path, request]) => [path, request.method]), [
    ['/api/v1/session', 'GET'],
    ['/api/v1/computer/folders', 'GET'],
    ['/api/v1/computer/folders/add', 'POST'],
    ['/api/v1/computer/folders/remove', 'POST'],
  ]);
  for (const [, request] of calls.slice(1)) {
    assert.equal(request.headers['X-WorldMedia-Token'], 'computer-token');
  }
  assert.equal(calls[1][1].body, undefined);
  for (const [, request] of calls.slice(2)) {
    assert.equal(request.headers['Content-Type'], 'application/json');
  }
  assert.deepEqual(JSON.parse(calls[2][1].body), { path: folder.path });
  assert.deepEqual(JSON.parse(calls[3][1].body), { id: folder.id });
});

test('Computer folder relocation posts the saved id and new path and surfaces a mismatch', async () => {
  resetControlSession();
  const path = 'E:\\New location';
  const folder = { id: 'drive-music', path, available: true };
  const message = 'That folder does not look like the same collection.';
  const fetchImpl = async (url, request) => {
    if (url === '/api/v1/session') return Response.json({ ok: true, data: { token: 'folder-token' } });
    assert.equal(url, '/api/v1/computer/folders/relocate');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['X-WorldMedia-Token'], 'folder-token');
    const body = JSON.parse(request.body);
    assert.equal(body.id, folder.id);
    if (body.path === path) return Response.json({ ok: true, data: { folder, folders: [folder] } });
    assert.equal(body.path, 'E:\\Other');
    return Response.json({ ok: false, error: { code: 'COMPUTER_FOLDER_MISMATCH', message } }, { status: 409 });
  };
  assert.deepEqual(await relocateComputerFolder(folder.id, path, { fetchImpl }), { folder, folders: [folder] });
  await assert.rejects(relocateComputerFolder(folder.id, 'E:\\Other', { fetchImpl }), {
    status: 409, code: 'COMPUTER_FOLDER_MISMATCH', message,
  });
});

test('Computer library requests use authenticated routes and preserve revision zero', async () => {
  resetControlSession();
  const calls = [];
  const status = { phase: 'walking', scanning: true, revision: 0 };
  const full = { revision: 0, items: [], folders: [] };
  const unchanged = { revision: 0, unchanged: true };
  const responses = [{ token: 'computer-token' }, status, status, status, full, unchanged];
  const options = {
    fetchImpl: async (path, request) => {
      calls.push([path, request]);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: responses.shift() }) };
    },
  };

  assert.deepEqual(await computerStatus(options), status);
  assert.deepEqual(await startComputerScan(options), status);
  assert.deepEqual(await cancelComputerScan(options), status);
  assert.deepEqual(await loadComputerLibrary(undefined, options), full);
  assert.deepEqual(await loadComputerLibrary(0, { ...options, generation: 'server & 1' }), unchanged);
  assert.deepEqual(calls.map(([path, request]) => [path, request.method]), [
    ['/api/v1/session', 'GET'],
    ['/api/v1/computer/status', 'GET'],
    ['/api/v1/computer/scan', 'POST'],
    ['/api/v1/computer/scan', 'POST'],
    ['/api/v1/computer/library', 'GET'],
    ['/api/v1/computer/library?since=0&gen=server%20%26%201', 'GET'],
  ]);
  for (const [, request] of calls.slice(1)) {
    assert.equal(request.headers['X-WorldMedia-Token'], 'computer-token');
  }
  assert.deepEqual(JSON.parse(calls[2][1].body), { action: 'start' });
  assert.deepEqual(JSON.parse(calls[3][1].body), { action: 'cancel' });
});

test('Computer playback posts the entry ID and returns the media details', async () => {
  resetControlSession();
  const id = 'a'.repeat(24);
  const media = {
    url: '/api/v1/computer/media/' + 'b'.repeat(64),
    mime: 'audio/wav', size: 100, kind: 'audio', container: 'wav',
    vcodec: null, acodec: 'pcm_s16le', duration: 1,
  };
  const responses = [{ token: 'computer-token' }, media];
  const calls = [];
  const options = {
    fetchImpl: async (path, request) => {
      calls.push([path, request]);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: responses.shift() }) };
    },
  };
  assert.deepEqual(await openComputerMedia(id, options), media);
  assert.equal(calls[1][0], '/api/v1/computer/play');
  const request = calls[1][1];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-WorldMedia-Token'], 'computer-token');
  assert.deepEqual(JSON.parse(request.body), { id });
});

test('Computer track requests send audio index zero and authenticate raw WebVTT', async () => {
  resetControlSession();
  const calls = [];
  const options = {
    fetchImpl: async (path, request) => {
      calls.push([path, request]);
      if (path === '/api/v1/session') return Response.json({ ok: true, data: { token: 'tracks-token' } });
      if (path === '/api/v1/computer/play') return Response.json({ ok: true, data: {} });
      if (path.endsWith('key=gone')) {
        return Response.json({ error: {
          code: 'COMPUTER_SUBTITLE_NOT_FOUND', message: 'That subtitle is no longer there.',
        } }, { status: 404 });
      }
      return new Response('WEBVTT\n', { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
    },
  };
  await openComputerMedia('film', { ...options, audio: 0, convert: true, standby: true });
  assert.deepEqual(JSON.parse(calls[1][1].body), { id: 'film', convert: true, audio: 0, standby: true });
  assert.equal(await loadComputerSubtitle('film & cut', 'key_1', options), 'WEBVTT\n');
  assert.equal(calls[2][0], '/api/v1/computer/subtitle?entry=film%20%26%20cut&key=key_1');
  assert.equal(calls[2][1].headers['X-WorldMedia-Token'], 'tracks-token');
  assert.equal(calls[2][1].cache, 'no-store');
  await assert.rejects(loadComputerSubtitle('film', 'gone', options), {
    status: 404, code: 'COMPUTER_SUBTITLE_NOT_FOUND', message: 'That subtitle is no longer there.',
  });
});

test('Computer subtitles can wait 300 seconds with the caller cancellation signal', async (t) => {
  resetControlSession();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const waiting = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const request = loadComputerSubtitle('film', 'e2', {
    signal: controller.signal,
    fetchImpl: async (path, options) => {
      if (path === '/api/v1/session') return Response.json({ ok: true, data: { token: 'tracks-token' } });
      waiting.resolve(options.signal);
      return reply.promise;
    },
  });
  const signal = await waiting.promise;
  let finished = false;
  request.then(() => { finished = true; }, () => { finished = true; });
  t.mock.timers.tick(300_000);
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.equal(signal, controller.signal);
  assert.equal(signal.aborted, false);
  reply.resolve(new Response('WEBVTT'));
  assert.equal(await request, 'WEBVTT');
});

test('Computer HLS release posts the playlist token using an authenticated keepalive request', async () => {
  resetControlSession();
  const calls = [];
  const token = computerHlsToken('/api/v1/computer/hls/session-token/index.m3u8?mode=local');
  assert.equal(token, 'session-token');
  assert.equal(computerHlsToken('/api/v1/computer/media/direct-token'), null);
  assert.equal(computerHlsToken('/api/v1/computer/hls/session-token/seg-0.ts'), null);
  await releaseComputerHls(token, {
    fetchImpl: async (path, request) => {
      calls.push([path, request]);
      return Response.json({ ok: true, data: { token: 'control-token' } });
    },
  });
  assert.deepEqual(calls[1], ['/api/v1/computer/hls/session-token/release', {
    method: 'POST', headers: { 'X-WorldMedia-Token': 'control-token' },
    keepalive: true, credentials: 'omit', cache: 'no-store',
  }]);
});

test('progressive promotion and both releases accept empty 204 replies', async () => {
  resetControlSession();
  const token = computerMediaToken('/api/v1/computer/media/abc?cache=1');
  assert.equal(token, 'abc');
  assert.equal(computerMediaToken('/api/v1/computer/hls/abc/index.m3u8'), null);
  const paths = [];
  const fetchImpl = async (path, request) => {
    if (path === '/api/v1/session') return Response.json({ ok: true, data: { token: 'local' } });
    paths.push(path);
    assert.equal(request.keepalive, true);
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers['X-WorldMedia-Token'], 'local');
    assert.equal(request.body, undefined);
    return new Response(null, { status: 204 });
  };
  for (const action of [keepComputerMedia, releaseComputerMedia, releaseComputerHls]) await action(token, { fetchImpl });
  assert.deepEqual(paths, ['media/abc/keep', 'media/abc/release', 'hls/abc/release'].map(path => '/api/v1/computer/' + path));
});

test('Computer folder picker uses the native API when available', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('The picker never uses HTTP.'));
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete globalThis.window;
  });
  assert.deepEqual(await pickComputerFolder(), { path: '', available: false });

  const chosen = 'D:\\Music';
  const api = {
    pick_media_folder: t.mock.fn(function (...args) {
      assert.equal(this, api);
      assert.deepEqual(args, []);
      return Promise.resolve({ path: chosen });
    }),
  };
  globalThis.window = { pywebview: { api } };
  assert.deepEqual(await pickComputerFolder(), { path: chosen, available: true });
  assert.equal(api.pick_media_folder.mock.callCount(), 1);
  api.pick_media_folder = async () => ({ path: '' });
  assert.deepEqual(await pickComputerFolder(), { path: '', available: true });
  api.pick_media_folder = async () => { throw new Error('WebView closed'); };
  assert.deepEqual(await pickComputerFolder(), { path: '', available: true, failed: true });
  api.pick_media_folder = async () => ({ path: '', error: 'The folder picker could not be opened.' });
  assert.deepEqual(await pickComputerFolder(), { path: '', available: true, failed: true });
  delete api.pick_media_folder;
  assert.deepEqual(await pickComputerFolder(), { path: '', available: false });
});
