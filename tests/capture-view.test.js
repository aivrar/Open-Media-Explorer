import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPTURE_VIEW_STATES, deriveCaptureView, isEqCurveActive } from '../src/lib/capture-view.js';

const item = { id: 'radio:one', title: 'Radio One' };
const job = (state, overrides = {}) => ({
  id: `job_${state}_1234567890`, kind: 'record-audio', state,
  title: 'Radio One', item_id: item.id, elapsed_seconds: 12,
  bytes_written: 2048, progress: null, output_path: null, error: null,
  ...overrides,
});

test('idle capability mapping exposes download, record, checking, installing, and unavailable states', () => {
  const download = deriveCaptureView({ item, capability: 'download' });
  assert.deepEqual([download.state, download.label, download.action], ['download', 'Download', 'download']);

  const audio = deriveCaptureView({ item, capability: 'record-audio' });
  assert.deepEqual([audio.state, audio.label, audio.action], ['record', 'Record audio', 'record']);
  assert.equal(deriveCaptureView({ item, capability: 'record-video' }).label, 'Record video');

  const checking = deriveCaptureView({ item, capability: 'checking' });
  assert.equal(checking.state, 'checking');
  assert.equal(checking.disabled, true);

  const installing = deriveCaptureView({ item, capability: 'record-audio', transient: 'installing' });
  assert.equal(installing.state, 'installing');
  assert.equal(installing.secondaryAction, 'cancel-install');

  const unavailable = deriveCaptureView({ item, capability: 'unavailable' });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.disabled, true);
  for (const state of [download.state, audio.state, checking.state, installing.state, unavailable.state]) {
    assert.ok(CAPTURE_VIEW_STATES.includes(state));
  }
});

test('every backend job state has an unmistakable action and recovery mapping', () => {
  const cases = [
    ['queued', 'checking', null, 'cancel'],
    ['preparing', 'checking', null, 'cancel'],
    ['running', 'stop-recording', 'stop', null],
    ['stopping', 'stop-recording', null, null],
    ['finalizing', 'finalizing', null, null],
    ['completed', 'completed', 'open-folder', 'again'],
    ['failed', 'failed', 'retry', null],
    ['cancelled', 'failed', 'retry', null],
  ];
  for (const [backendState, uiState, action, secondary] of cases) {
    const view = deriveCaptureView({ item, capability: 'record-audio', jobs: [job(backendState)] });
    assert.equal(view.state, uiState, backendState);
    assert.equal(view.action, action, backendState);
    assert.equal(view.secondaryAction, secondary, backendState);
    assert.ok(view.status, backendState);
    assert.ok(view.notice, backendState);
  }

  const download = deriveCaptureView({
    item, capability: 'download',
    jobs: [job('running', { kind: 'download', progress: 0.42, bytes_written: 5_000_000 })],
  });
  assert.equal(download.state, 'downloading');
  assert.equal(download.action, 'cancel');
  assert.match(download.status, /42%/);
});

test('recording notices keep the full status and shorten preparing and saved text', () => {
  for (const state of ['queued', 'preparing']) {
    const view = deriveCaptureView({ item, jobs: [job(state, {
      title: 'Other station', item_id: 'radio:other', elapsed_seconds: 0,
    })] });
    assert.equal(view.status, 'Preparing recording “Other station” • 0:00');
    assert.equal(view.notice, 'Preparing • 0:00');
  }

  const running = deriveCaptureView({ item, jobs: [job('running', {
    bytes_written: 512 * 1024, elapsed_seconds: 19,
  })] });
  assert.equal(running.notice, 'Recording • 0:19 • 512.0 KB');

  const completed = deriveCaptureView({ item, jobs: [job('completed', {
    bytes_written: Math.round(641.4 * 1024), elapsed_seconds: 21,
  })] });
  assert.equal(completed.status, 'Recording complete • 641.4 KB • 0:21');
  assert.equal(completed.notice, 'Saved • 641 KB • 0:21');

  const download = deriveCaptureView({ item, jobs: [job('completed', {
    kind: 'download', bytes_written: Math.round(641.4 * 1024), elapsed_seconds: 21,
  })] });
  assert.equal(download.notice, 'Saved • 641.4 KB • 0:21');
});

test('active recording remains global while downloads stay associated with the selected item', () => {
  const otherRecording = job('running', {
    id: 'job_other_recording_123', item_id: 'tv:other', title: 'Other channel', kind: 'record-video',
  });
  const view = deriveCaptureView({ item, capability: 'download', jobs: [otherRecording] });
  assert.equal(view.state, 'stop-recording');
  assert.match(view.status, /Other channel/);

  const backgroundDownload = job('running', {
    id: 'job_other_download_123', item_id: 'archive:other', kind: 'download', progress: 0.2,
  });
  const idle = deriveCaptureView({ item, capability: 'record-audio', jobs: [backgroundDownload] });
  assert.equal(idle.state, 'record');
  assert.match(idle.status, /1 download continues in the background/);
  assert.equal(idle.notice, '1 download in the background');

  const captureOnly = deriveCaptureView({ item: null, capability: 'unavailable', jobs: [backgroundDownload] });
  assert.equal(captureOnly.state, 'downloading');
  assert.equal(captureOnly.action, 'cancel');
});

test('running and completed downloads only match their selected chapter', () => {
  const jobs = ['running', 'completed'].map((state) => job(state, {
    kind: 'download', download_part: state === 'running' ? '0011223344556677' : '8899aabbccddeeff',
  }));
  const viewFor = (downloadPart) => deriveCaptureView({ item, capability: 'download', downloadPart, jobs });
  assert.equal(viewFor('0011223344556677').label, 'Cancel download');
  assert.equal(viewFor('8899aabbccddeeff').label, 'Open folder');
  assert.equal(viewFor('8899aabbccddeeff').secondaryLabel, 'Download again');
  assert.equal(viewFor('0123456789abcdef').label, 'Download');
  assert.equal(viewFor('').label, 'Download');
});

test('standing hints are hover text only; progress, results and errors are shown in the bar', () => {
  const hints = [
    deriveCaptureView({ item, capability: 'download' }),
    deriveCaptureView({ item, capability: 'record-audio' }),
    deriveCaptureView({ item, finite: true }),
    deriveCaptureView({ item, capability: 'record-video', unplayable: true }),
    deriveCaptureView({ item, capability: 'checking' }),
    deriveCaptureView({ item, capability: 'unavailable' }),
  ];
  for (const view of hints) {
    assert.ok(view.status, view.label);
    assert.equal(view.notice, '', view.status);
  }
  assert.equal(deriveCaptureView({ item: null, capability: 'unavailable' }).notice, '');
  const shown = [
    deriveCaptureView({ item, capability: 'download', transient: 'checking' }),
    deriveCaptureView({ item, capability: 'record-audio', transient: 'installing' }),
    deriveCaptureView({ item, capability: 'record-audio', jobs: [job('failed', { error: { message: 'Stream closed.' } })] }),
    deriveCaptureView({ item, capability: 'record-audio', jobs: [job('completed')] }),
  ];
  assert.deepEqual(shown.map((view) => view.notice), [
    'Preparing download…', 'Installing and verifying FFmpeg…', 'Stream closed.',
    'Saved • 2 KB • 0:12',
  ]);
  assert.equal(shown[3].status, 'Recording complete • 2.0 KB • 0:12');
  // Two downloads elsewhere: the hint keeps the full sentence; the bar a short note.
  const two = [1, 2].map((n) => job('running', { id: `job_bg_${n}_1234567890`, item_id: `archive:${n}`, kind: 'download' }));
  const view = deriveCaptureView({ item, capability: 'record-audio', jobs: two });
  assert.equal(view.status, 'Live media can be recorded. 2 downloads continue in the background.');
  assert.equal(view.notice, '2 downloads in the background');
});

test('ignored terminal jobs permit explicit repeat and EQ indication distinguishes flat from active', () => {
  const complete = job('completed');
  assert.equal(deriveCaptureView({ item, capability: 'record-audio', jobs: [complete] }).state, 'completed');
  assert.equal(deriveCaptureView({
    item, capability: 'record-audio', jobs: [complete], ignoredJobIds: new Set([complete.id]),
  }).state, 'record');
  assert.equal(isEqCurveActive({ preamp: 0, bands: Array(10).fill(0) }), false);
  assert.equal(isEqCurveActive({ preamp: 0, bands: [0, 0, 1, 0] }), true);
});
