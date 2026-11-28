import test from 'node:test';
import assert from 'node:assert/strict';

import { RECORDER_OFF_HINT, initCaptureUi } from '../src/lib/capture-ui.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { loadEqState, saveEqState, setEqBypassed } from '../src/lib/eq-store.js';
import {
  emit, saveSettings, setCurrentItem, setMode, setShowExplicitContent,
} from '../src/lib/state.js';
import { TUNER_TONES, turnTunerTone } from '../src/lib/tuner-tone.js';
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
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
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
    // Progress is shown in the bar's row, beside the button.
    assert.equal(elements['player-capture-status'].hidden, false);

    jobs = [];
    setCurrentItem({
      id: 'archive:second', title: 'Second item', delivery: 'on-demand',
      download_url: 'https://media.example/second.mp3', stream_kind: 'audio', type: 'audio',
    });
    setMode('computer');
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Download');
    // A standing hint: on the button's hover and description, not in the bar.
    assert.equal(elements['player-capture-status'].hidden, true);
    assert.equal(elements['player-capture-status-text'].textContent, '');
    assert.match(elements['player-capture'].title, /Original media/);
    assert.match(elements['player-capture-hint'].textContent, /Original media/);
    assert.match(elements['player-capture-announcement'].textContent, /Original media/);
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
    saveEqState(setEqBypassed(loadEqState(), 'archive:second', false, true));
    assert.equal(turnTunerTone(TUNER_TONES.bass, 2), true);
    assert.equal(elements['player-eq-state'].textContent, 'Active');
    assert.equal(elements['player-eq'].getAttribute('aria-pressed'), 'true');

    jobs = [{
      id: 'job_record_global_123', kind: 'record-video', state: 'running', title: 'Other TV',
      item_id: 'tv:other', elapsed_seconds: 8, bytes_written: 4096, progress: null,
    }];
    await controller.refresh();
    assert.equal(elements['player-capture-label'].textContent, 'Stop recording');
    assert.match(elements['player-capture-status-text'].textContent, /Other TV/);

    jobs = [{ ...jobs[0], state: 'preparing', title: 'Second item', item_id: 'archive:second', elapsed_seconds: 0 }];
    await controller.refresh();
    const status = elements['player-capture-status'];
    assert.equal(elements['player-capture-status-text'].textContent, 'Preparing • 0:00');
    assert.equal(status.title, 'Preparing recording • 0:00');
    assert.equal(status.getAttribute('aria-label'), status.title);

    jobs = [{ ...jobs[0], state: 'completed', elapsed_seconds: 21, bytes_written: Math.round(641.4 * 1024) }];
    await controller.refresh();
    assert.equal(elements['player-capture-status-text'].textContent, 'Saved • 641 KB • 0:21');
    assert.equal(status.title, 'Recording complete • 641.4 KB • 0:21');
    assert.equal(status.getAttribute('aria-label'), status.title);

    const completedRecording = jobs[0];
    jobs = [{ ...completedRecording, kind: 'download' }];
    await controller.refresh();
    assert.equal(elements['player-capture-status-text'].textContent, 'Saved • 641.4 KB • 0:21');
    assert.equal(status.title, 'Download complete • 641.4 KB • 0:21');
    assert.equal(status.getAttribute('aria-label'), status.title);

    jobs = [{ ...completedRecording, state: 'running' }];
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
    globalThis.localStorage = originalStorage;
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
    // Inactive but focusable, so a keyboard user reaches its hint.
    assert.equal(elements['player-capture'].disabled, false);
    assert.equal(elements['player-capture'].getAttribute('aria-disabled'), 'true');
    assert.equal(elements['player-capture'].getAttribute('tabindex'), null);
    // A click (or Enter / Space, which click a button) does nothing.
    elements['player-capture'].dispatchEvent(new Event('click'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(elements['player-capture-label'].textContent, 'Recorder off');
    assert.equal(elements['player-capture-status'].hidden, true);
    // No Open Settings button and no line under the buttons: the hover text
    // (and the button's description) says where to switch the Recorder on.
    assert.equal(elements['player-capture-secondary'].hidden, true);
    assert.equal(elements['player-capture-secondary'].textContent, '');
    assert.equal(elements['player-capture-status'].hidden, true);
    assert.equal(elements['player-capture'].title, RECORDER_OFF_HINT);
    assert.equal(elements['player-capture-hint'].textContent, RECORDER_OFF_HINT);
    assert.match(RECORDER_OFF_HINT, /turn on Recorder in Settings \(the gear at the top\), under Capture & storage/);
    assert.match(elements['player-capture'].getAttribute('aria-label'), /^Recorder off\. Turn on Recorder in Settings \(the gear at the top\)/);
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

test('a changed hint is announced once; an inactive Record button ignores a press but keeps the focus', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  const routes = [];
  const fetchImpl = async (path) => {
    routes.push(path);
    if (path === '/api/v1/session') return response({ token: 'hint-announce-token' });
    if (path === '/api/v1/jobs') return response({ jobs: [] });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  saveSettings({ recordingEnabled: true });
  const itemId = 'radio:hint-announce';
  setCurrentItem({
    id: itemId, title: 'Live Radio', source: 'radio-browser',
    delivery: 'live', stream_url: 'https://radio.example/live.mp3',
    stream_kind: 'audio', type: 'radio', content_rating: 'not-explicit',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  const record = elements['player-capture'];
  const announcement = elements['player-capture-announcement'];
  try {
    await controller.refresh();
    assert.equal(record.dataset.action, 'record');
    assert.equal(announcement.textContent, 'Live media can be recorded.');
    // Refreshes in the same state do not announce it again.
    announcement.textContent = '';
    await controller.refresh();
    assert.equal(announcement.textContent, '');

    // Not playable: same state and job, a new hint, announced once.
    emit('media-unplayable', { itemId });
    assert.equal(record.dataset.state, 'record');
    assert.equal(announcement.textContent, 'Recording is available once this item plays.');
    assert.equal(record.disabled, false, 'focusable for its hint');
    assert.equal(record.getAttribute('aria-disabled'), 'true');
    announcement.textContent = '';
    await controller.refresh();
    await controller.refresh();
    assert.equal(announcement.textContent, '', 'not on every refresh');

    // A press on an aria-disabled button does nothing, even with an action set.
    record.dataset.action = 'record';
    const before = routes.length;
    record.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(routes.slice(before).includes('/api/v1/ffmpeg/status'), false);
    assert.notEqual(elements['player-capture-label'].textContent, 'Preparing…');
  } finally {
    controller.destroy();
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('while a press is handled the Record button is disabled outright (no hint state)', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  let statusCalls = 0;
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'busy-token' });
    if (path === '/api/v1/jobs') return response({ jobs: [] });
    if (path === '/api/v1/ffmpeg/status') {
      statusCalls += 1;
      if (statusCalls > 1) await statusGate;
      return response({ state: 'missing' });
    }
    if (path === '/api/v1/runtime') return response({ portable_writable: true });
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem({
    id: 'tv:busy', title: 'Live TV', source: 'iptv-org',
    delivery: 'live', stream_url: 'https://tv.example/live.m3u8',
    stream_kind: 'hls', type: 'tv', content_rating: 'not-explicit',
  });
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  const record = elements['player-capture'];
  try {
    await controller.refresh();
    assert.equal(record.dataset.action, 'record');
    record.dispatchEvent(new Event('click'));
    await waitFor(() => elements['player-capture-label'].textContent === 'Preparing…');
    assert.equal(record.disabled, true);
    assert.equal(record.getAttribute('aria-disabled'), 'true');
    releaseStatus();
    await waitFor(() => elements['player-capture-label'].textContent === 'Retry');
    assert.equal(record.disabled, false);
    assert.equal(record.getAttribute('aria-disabled'), 'false');
  } finally {
    releaseStatus();
    controller.destroy();
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('Record again clears the saved actions as soon as preparation starts', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  const item = {
    id: 'tv:repeat', title: 'Live TV', source: 'iptv-org', delivery: 'live',
    stream_url: 'https://tv.example/live.m3u8', stream_kind: 'hls', type: 'tv',
  };
  const saved = { id: 'first', item_id: item.id, kind: 'record-video', state: 'completed' };
  const next = { ...saved, id: 'second', state: 'preparing' };
  let jobs = [saved];
  let releaseRecording;
  const recordingGate = new Promise((resolve) => { releaseRecording = resolve; });
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'repeat-token' });
    if (path === '/api/v1/jobs') return response({ jobs });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'ready' });
    if (path === '/api/v1/media/register') return response({ media_id: 'repeat_media_001' });
    if (path === '/api/v1/jobs/record') {
      await recordingGate;
      jobs = [next, saved];
      return response(next);
    }
    throw new Error('unexpected route ' + path);
  };
  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem(item);
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  const primary = elements['player-capture'];
  const secondary = elements['player-capture-secondary'];
  try {
    await controller.refresh();
    assert.equal(primary.dataset.state, 'completed');
    assert.equal(secondary.textContent, 'Record again');
    secondary.dispatchEvent(new Event('click'));
    assert.equal(primary.dataset.state, 'checking');
    assert.equal(secondary.hidden, true);

    releaseRecording();
    await waitFor(() => secondary.dataset.action === 'cancel');
    assert.equal(primary.dataset.state, 'checking');
    jobs = [{ ...next, state: 'running' }, saved];
    await controller.refresh();
    assert.equal(primary.dataset.state, 'stop-recording');
    assert.equal(secondary.hidden, true);
  } finally {
    releaseRecording();
    controller.destroy();
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('an error after Record is shown in the bar beside Retry, with no Open Settings button', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.localStorage = memoryStorage();
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return response({ token: 'record-error-token' });
    if (path === '/api/v1/jobs') return response({ jobs: [] });
    if (path === '/api/v1/ffmpeg/status') return response({ state: 'missing' });
    if (path === '/api/v1/runtime') return response({ portable_writable: true });
    throw new Error(`unexpected route ${path}`);
  };

  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem({
    id: 'tv:record-error', title: 'Live TV', source: 'iptv-org',
    delivery: 'live', stream_url: 'https://tv.example/live.m3u8',
    stream_kind: 'hls', type: 'tv', content_rating: 'not-explicit',
  });
  // The FFmpeg install is declined, so the start fails with a message.
  const controller = initCaptureUi({ fetchImpl, confirmImpl: () => false });
  try {
    await controller.refresh();
    assert.equal(elements['player-capture'].dataset.action, 'record');
    assert.equal(elements['player-capture-status'].hidden, true, 'the hint is not shown in the bar');
    elements['player-capture'].dispatchEvent(new Event('click'));
    await waitFor(() => elements['player-capture-label'].textContent === 'Retry');
    const message = 'Recording needs FFmpeg. Install it from Settings to continue.';
    assert.equal(elements['player-capture-status'].hidden, false);
    assert.equal(elements['player-capture-status'].dataset.tone, 'danger');
    assert.equal(elements['player-capture-status-text'].textContent, message);
    assert.equal(elements['player-capture-status'].title, message);
    assert.equal(elements['player-capture-announcement'].textContent, message);
    assert.equal(elements['player-capture-secondary'].hidden, true);
    assert.equal(elements['player-capture-secondary'].dataset.action, '');
  } finally {
    controller.destroy();
    setCurrentItem(null);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
    resetControlSession();
  }
});

test('a pending recording is cancelled if its same-station endpoint or delivery changes', async () => {
  const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  const { elements, document } = createPlayerDom();
  document.visibilityState = 'visible';
  Object.assign(globalThis, { document, window: { setTimeout, clearTimeout }, localStorage: memoryStorage() });
  const item = { id: 'radio:pending', type: 'radio', stream_kind: 'audio',
    stream_url: 'https://radio.example/live', delivery: 'live', content_rating: 'not-explicit' };
  const main = { url: item.stream_url, kind: 'audio' };
  const registrations = [];
  let gate;
  const fetchImpl = async (path, options) => {
    if (path === '/api/v1/session') return response({ token: 'pending-token' });
    if (path === '/api/v1/jobs') return response({ jobs: [] });
    if (path === '/api/v1/ffmpeg/status') {
      if (gate) await gate;
      return response({ state: 'ready' });
    }
    if (path === '/api/v1/media/register') {
      registrations.push(JSON.parse(options.body));
      return response({ media_id: 'unexpected' });
    }
    if (path === '/api/v1/jobs/record') return response({ id: 'unexpected' });
    throw new Error(`unexpected route ${path}`);
  };
  resetControlSession();
  saveSettings({ recordingEnabled: true });
  setCurrentItem(item, main);
  const controller = initCaptureUi({ fetchImpl });
  try {
    await controller.refresh();
    const record = elements['player-capture'];
    for (const change of [
      () => setCurrentItem(item, { url: 'https://backup.example/live', kind: 'audio' }),
      () => emit('media-timeline', { itemId: item.id, delivery: 'on-demand' }),
    ]) {
      setCurrentItem(item, main);
      emit('media-timeline', { itemId: item.id, delivery: 'unknown' });
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      assert.equal(record.dataset.action, 'record');
      record.dispatchEvent(new Event('click'));
      await waitFor(() => record.disabled);
      change();
      release();
      await waitFor(() => elements['player-capture-label'].textContent !== 'Preparing…');
      assert.deepEqual(registrations, []);
    }
  } finally {
    controller.destroy();
    setCurrentItem(null);
    Object.assign(globalThis, previous);
    resetControlSession();
  }
});
