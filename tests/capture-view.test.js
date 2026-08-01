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
  }

  const download = deriveCaptureView({
    item, capability: 'download',
    jobs: [job('running', { kind: 'download', progress: 0.42, bytes_written: 5_000_000 })],
  });
  assert.equal(download.state, 'downloading');
  assert.equal(download.action, 'cancel');
  assert.match(download.status, /42%/);
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

  const captureOnly = deriveCaptureView({ item: null, capability: 'unavailable', jobs: [backgroundDownload] });
  assert.equal(captureOnly.state, 'downloading');
  assert.equal(captureOnly.action, 'cancel');
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
