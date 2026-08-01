import test from 'node:test';
import assert from 'node:assert/strict';

import { initCaptureUi } from '../src/lib/capture-ui.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import {
  emit, saveSettings, setCurrentItem, setMode, setShowExplicitContent,
} from '../src/lib/state.js';
import { createPlayerDom } from './helpers/fake-dom.js';

const response = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for capture UI state');
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
}

test('polling keeps capture status attached to item identity across item and mode switches', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  let jobs = [{
    id: 'job_download_sync_123', kind: 'download', state: 'running', title: 'First item',
    item_id: 'archive:first', elapsed_seconds: 4, bytes_written: 2048, progress: 0.5,
  }];
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'capture-ui-token' });
    if (path === '/api/v1/jobs') return response({ jobs });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    throw new Error(`unexpected route ${path}`);
  };
  resetControlSession();
  setCurrentItem({
    id: 'archive:first', title: 'First item', delivery: 'on-demand',
    download_url: 'https://media.example/first.mp3', stream_kind: 'audio', type: 'audio',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  try {
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Cancel download');
    assert.match(elements['player-capture-status-text'].textContent, /50%/);

    jobs = [];
    setCurrentItem({
      id: 'archive:second', title: 'Second item', delivery: 'on-demand',
      download_url: 'https://media.example/second.mp3', stream_kind: 'audio', type: 'audio',
    });
    setMode('grid');
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Download');
    assert.match(elements['player-capture-status-text'].textContent, /Original media/);
    assert.equal(elements['player-eq-state'].textContent, 'Flat');
    emit('eq-engine-change', { state: 'unavailable', reason: 'Relay unavailable.' });
    assert.equal(elements['player-eq-state'].textContent, 'Unavailable');
    assert.equal(elements['player-eq'].classList.contains('is-unavailable'), true);
    assert.match(elements['player-eq'].title, /Relay unavailable/);
    emit('eq-engine-change', { state: 'ready', reason: '' });
    assert.equal(elements['player-eq-state'].textContent, 'Flat');
    emit('eq-preview', {
      itemId: 'archive:second',
      curve: { preamp: -3, bands: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0], bypassed: false },
    });
    assert.equal(elements['player-eq-state'].textContent, 'Active');
    emit('eq-preview', {
      itemId: 'archive:second',
      curve: { preamp: -3, bands: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0], bypassed: true },
    });
    assert.equal(elements['player-eq-state'].textContent, 'Bypassed');

    jobs = [{
      id: 'job_record_global_123', kind: 'record-video', state: 'running', title: 'Other TV',
      item_id: 'tv:other', elapsed_seconds: 8, bytes_written: 4096, progress: null,
    }];
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Stop recording');
    assert.match(elements['player-capture-status-text'].textContent, /Other TV/);

    setCurrentItem(null);
    await controller.refresh();
    assert.equal(elements['player-bar'].hidden, false);
    assert.equal(elements['player-bar'].classList.contains('is-capture-only'), true);
    assert.equal(elements.app.classList.contains('has-capture-only'), true);

    jobs = [];
    await controller.refresh();
    assert.equal(elements['player-bar'].hidden, true);
    assert.equal(elements.app.classList.contains('has-player'), false);
  } finally {
    controller.destroy();
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    resetControlSession();
  }
});

test('turning explicit content off stops a tracked recording after selection moved elsewhere', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  let jobs = [];
  let recordingStarted = false;
  let recordingStopped = false;
  let recordingEq = null;
  const activeJob = {
    id: 'job_explicit_recording_123', kind: 'record-video', state: 'running',
    title: 'Marked live channel', item_id: 'owncast:marked', elapsed_seconds: 1,
    bytes_written: 1024, progress: null,
  };
  const fetchImpl = async (path, options = {}) => {
    if (path === '/api/v1/session') return response({ token: 'capture-policy-token' });
    if (path === '/api/v1/jobs') return response({ jobs });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    if (path === '/api/v1/media/register') {
      return response({
        media_id: 'media_marked_123',
        relay_url: '/api/v1/media/media_marked_123',
      });
    }
    if (path === '/api/v1/media/media_marked_123') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/vnd.apple.mpegurl' },
        text: async () => '#EXTM3U\n#EXT-X-VERSION:3\n',
      };
    }
    if (path === '/api/v1/jobs/record') {
      recordingStarted = true;
      recordingEq = JSON.parse(options.body).eq;
      jobs = [activeJob];
      return response(activeJob);
    }
    if (path === `/api/v1/jobs/${activeJob.id}/stop`) {
      recordingStopped = true;
      jobs = [{ ...activeJob, state: 'complete' }];
      return response(jobs[0]);
    }
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  setShowExplicitContent(true);
  setCurrentItem({
    id: 'owncast:marked', title: 'Marked live channel', source: 'owncast',
    delivery: 'live', stream_url: 'https://marked.example/hls/stream.m3u8',
    stream_kind: 'hls', type: 'tv', content_rating: 'explicit',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  try {
    await controller.refresh();
    assert.equal(elements['player-capture'].dataset.action, 'record');
    const previewCurve = {
      preamp: -4, bands: [3, 2, 1, 0, -1, -2, -3, 0, 1, 2], bypassed: false,
    };
    emit('eq-preview', { itemId: 'owncast:marked', curve: previewCurve });
    elements['player-capture'].dispatchEvent(new Event('click'));
    await waitFor(() => recordingStarted);
    assert.deepEqual(recordingEq, previewCurve, 'the audible EQ preview is baked into recording');
    await controller.refresh();

    setCurrentItem({
      id: 'radio:safe', title: 'Safe station', source: 'radio-browser',
      delivery: 'live', stream_url: 'https://safe.example/live.mp3',
      stream_kind: 'audio', type: 'radio', content_rating: 'not-explicit',
    });
    setShowExplicitContent(false);
    await waitFor(() => recordingStopped);
    assert.equal(recordingStopped, true);
  } finally {
    controller.destroy();
    setShowExplicitContent(false);
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('Recorder off disables new recording and stops an active recording', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  let jobs = [];
  let recordingStopped = false;
  const activeJob = {
    id: 'job_recorder_switch_123', kind: 'record-video', state: 'running',
    title: 'Live TV', item_id: 'tv:recorder-switch', elapsed_seconds: 4,
    bytes_written: 4096, progress: null,
  };
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'recorder-switch-token' });
    if (path === '/api/v1/jobs') return response({ jobs });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    if (path === `/api/v1/jobs/${activeJob.id}/stop`) {
      recordingStopped = true;
      jobs = [{ ...activeJob, state: 'complete' }];
      return response(jobs[0]);
    }
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem({
    id: 'tv:recorder-switch', title: 'Live TV', source: 'iptv-org',
    delivery: 'live', stream_url: 'https://tv.example/live.m3u8',
    stream_kind: 'hls', type: 'tv', content_rating: 'not-explicit',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  try {
    await controller.refresh();
    assert.equal(elements['player-capture'].dataset.action, 'record');

    saveSettings({ recordingEnabled: false });
    assert.equal(elements['player-capture-label'].textContent, 'Recorder off');
    assert.equal(elements['player-capture'].disabled, true);
    assert.equal(elements['player-capture-secondary'].textContent, 'Open Settings');

    saveSettings({ recordingEnabled: true });
    jobs = [activeJob];
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Stop recording');
    saveSettings({ recordingEnabled: false });
    await waitFor(() => recordingStopped);
    assert.equal(recordingStopped, true);
  } finally {
    controller.destroy();
    saveSettings({ recordingEnabled: true });
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('Recorder off attempts automatic stop once and leaves manual retry available', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  const activeJob = {
    id: 'job_recorder_stop_retry_123', kind: 'record-video', state: 'running',
    title: 'Live TV', item_id: 'tv:stop-retry', elapsed_seconds: 4,
    bytes_written: 4096, progress: null,
  };
  let stopCalls = 0;
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'recorder-stop-retry-token' });
    if (path === '/api/v1/jobs') return response({ jobs: [activeJob] });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    if (path === `/api/v1/jobs/${activeJob.id}/stop`) {
      stopCalls += 1;
      return {
        ok: false, status: 503,
        json: async () => ({ ok: false, error: { code: 'STOP_FAILED', message: 'Temporary stop failure.' } }),
      };
    }
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem({
    id: 'tv:stop-retry', title: 'Live TV', source: 'iptv-org',
    delivery: 'live', stream_url: 'https://tv.example/live.m3u8',
    stream_kind: 'hls', type: 'tv', content_rating: 'not-explicit',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  try {
    await controller.refresh();
    saveSettings({ recordingEnabled: false });
    await waitFor(() => stopCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.refresh();
    await controller.refresh();
    assert.equal(stopCalls, 1, 'polling must not create an automatic stop retry storm');
    assert.equal(elements['player-capture-label'].textContent, 'Stop recording');
    elements['player-capture'].dispatchEvent(new Event('click'));
    await waitFor(() => stopCalls === 2);
  } finally {
    controller.destroy();
    saveSettings({ recordingEnabled: true });
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});
