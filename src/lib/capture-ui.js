/** Player-bar download/record controls and backend job synchronization. */

import { listCaptureJobs } from './capture-client.js';
import { startItemDownload, cancelDownload, openDownloadsFolder } from './download-client.js';
import {
  startItemRecording, stopRecording, cancelRecordingPreparation,
} from './recording-client.js';
import {
  FFMPEG_APPROX_SIZE, FFMPEG_PROVIDER, FFMPEG_VERSION_FAMILY,
  cancelFfmpegInstall, getFfmpegStatus, getRuntimeStatus, installFfmpegAndResume,
  waitForFfmpeg,
} from './ffmpeg-client.js';
import { resolveMediaAction } from './media-capabilities.js';
import { deriveCaptureView, isEqCurveActive } from './capture-view.js';
import { getEffectiveEq, loadEqState } from './eq-store.js';
import { emit, getState, isFavorite, subscribe } from './state.js';
import { isContentAllowed } from './content-rating.js';

const ACTIVE_JOB_STATES = new Set(['queued', 'preparing', 'running', 'stopping', 'finalizing']);

function byId(id) { return document.getElementById(id); }

function installConfirmation(destination) {
  const location = destination === 'portable'
    ? 'the tools folder next to World Media'
    : 'your LocalAppData WorldMediaWindows tools folder';
  return `Recording requires FFmpeg. Install ${FFMPEG_VERSION_FAMILY} from ${FFMPEG_PROVIDER}?\n\n`
    + `Download size: ${FFMPEG_APPROX_SIZE}.\nDestination: ${location}.\n`
    + 'The GPL build, SHA-256 digest, license, and recording capabilities are verified before activation.';
}

export function initCaptureUi({ fetchImpl = fetch, confirmImpl = null } = {}) {
  const elements = {
    primary: byId('player-capture'), label: byId('player-capture-label'),
    secondary: byId('player-capture-secondary'), status: byId('player-capture-status'),
    statusText: byId('player-capture-status-text'), progress: byId('player-capture-progress'),
    progressBar: byId('player-capture-progress-bar'), eq: byId('player-eq'),
    eqState: byId('player-eq-state'), bar: byId('player-bar'), app: byId('app'),
    announcement: byId('player-capture-announcement'),
  };
  if (Object.values(elements).some((element) => !element)) return null;

  let jobs = [];
  let toolState = null;
  let transient = null;
  let actionError = null;
  let timer = 0;
  let busy = false;
  let installWait = null;
  let toolStatusRequest = null;
  let stopped = false;
  let ignoredJobIds = new Set();
  const jobContentRatings = new Map();
  let refreshVersion = 0;
  let actionGeneration = 0;
  let observedItemId = currentItem()?.id || '';
  let lastAnnouncementKey = '';
  let eqEngineStatus = { state: 'idle', reason: '' };
  let eqPreview = null;
  let recorderEnabled = getState().settings.recordingEnabled !== false;
  let recorderShutdown = null;
  const recorderAutoStopAttempted = new Set();
  let recorderInstallCancelAttempted = false;
  const askConfirmation = confirmImpl || ((message) => globalThis.confirm?.(message));
  const unsubscribers = [];

  function currentItem() { return getState().currentItem; }

  function effectiveUiCurve() {
    const item = currentItem();
    if (!item) return null;
    if (eqPreview?.itemId === item.id) return eqPreview.curve;
    return getEffectiveEq(loadEqState(), item.id, isFavorite(item.id));
  }

  function renderEq() {
    const item = currentItem();
    const engineBlocked = ['unavailable', 'error', 'suspended'].includes(eqEngineStatus.state);
    const curve = effectiveUiCurve();
    const active = !engineBlocked && isEqCurveActive(curve);
    const bypassed = curve?.bypassed === true;
    elements.eq.disabled = !item;
    elements.eq.classList.toggle('is-active', active);
    elements.eq.classList.toggle('is-unavailable', engineBlocked);
    elements.eq.dataset.engineState = eqEngineStatus.state || 'idle';
    elements.eq.setAttribute('aria-pressed', active ? 'true' : 'false');
    elements.eqState.textContent = engineBlocked
      ? (eqEngineStatus.state === 'suspended' ? 'Suspended' : 'Unavailable')
      : (bypassed ? 'Bypassed' : (active ? 'Active' : 'Flat'));
    const title = !item
      ? 'Select media to use the equalizer'
      : (engineBlocked
        ? `Equalizer unavailable. ${eqEngineStatus.reason || 'Audio processing could not start.'}`
        : `Equalizer ${bypassed ? 'bypassed' : (active ? 'active' : 'flat')}`);
    elements.eq.title = title;
    elements.eq.setAttribute('aria-label', title);
  }

  function viewForCurrent() {
    const item = currentItem();
    const capability = resolveMediaAction(item);
    let view = deriveCaptureView({ item, capability, jobs, toolState, transient, ignoredJobIds });
    const activeRecording = jobs.some(
      (job) => job.kind?.startsWith('record-') && ACTIVE_JOB_STATES.has(job.state),
    );
    const relevantActive = jobs.some(
      (job) => job.item_id === item?.id && ACTIVE_JOB_STATES.has(job.state),
    );
    if (!recorderEnabled && capability.startsWith('record-') && !activeRecording) {
      view = {
        state: 'unavailable', label: 'Recorder off', action: '', disabled: true,
        disabledReason: 'Turn Recorder on in Settings to record live media.',
        status: 'Recorder is off so playback has priority.', tone: 'muted',
        progress: null, indeterminate: false, jobId: '',
        secondaryAction: 'settings', secondaryLabel: 'Open Settings',
      };
    }
    if (actionError && actionError.itemId === (item?.id || '') && !activeRecording && !relevantActive) {
      const labels = {
        'open-folder': 'Retry folder', stop: 'Retry stop', cancel: 'Retry cancel',
        'cancel-install': 'Retry cancel', retry: 'Retry',
      };
      view = {
        state: 'failed', label: labels[actionError.retryAction] || 'Retry',
        action: actionError.retryAction || 'retry', disabled: false,
        disabledReason: '', status: actionError.message, tone: 'danger',
        progress: null, indeterminate: false, jobId: actionError.jobId || '',
        secondaryAction: 'settings', secondaryLabel: 'Open Settings',
      };
    }
    return view;
  }

  function render() {
    const view = viewForCurrent();
    const hasActiveCapture = jobs.some(
      (job) => job.kind !== 'ffmpeg-install' && ACTIVE_JOB_STATES.has(job.state),
    );
    const captureOnly = !currentItem() && hasActiveCapture;
    elements.bar.classList.toggle('is-capture-only', captureOnly);
    elements.app.classList.toggle('has-capture-only', captureOnly);
    if (captureOnly) {
      elements.bar.hidden = false;
      elements.app.classList.add('has-player');
    } else if (!currentItem() && elements.bar.classList.contains('was-capture-only')) {
      elements.bar.hidden = true;
      elements.app.classList.remove('has-player');
    }
    elements.bar.classList.toggle('was-capture-only', captureOnly);
    elements.primary.dataset.state = view.state;
    elements.primary.dataset.action = view.action || '';
    elements.primary.disabled = busy || view.disabled || !view.action;
    elements.label.textContent = view.label;
    const reason = view.disabledReason || view.label;
    elements.primary.title = view.status || reason;
    elements.primary.setAttribute(
      'aria-label', view.disabledReason ? `${view.label}. ${view.disabledReason}` : view.label,
    );
    elements.primary.setAttribute('aria-disabled', elements.primary.disabled ? 'true' : 'false');

    elements.secondary.hidden = !view.secondaryAction;
    elements.secondary.dataset.action = view.secondaryAction || '';
    elements.secondary.textContent = view.secondaryLabel || '';
    elements.secondary.title = view.secondaryLabel || '';
    elements.secondary.setAttribute('aria-label', view.secondaryLabel || 'Secondary capture action');
    elements.secondary.disabled = busy && view.secondaryAction !== 'cancel-install';

    elements.status.hidden = !view.status;
    elements.status.dataset.tone = view.tone;
    elements.statusText.textContent = view.status;
    const showProgress = view.indeterminate || Number.isFinite(view.progress);
    elements.progress.hidden = !showProgress;
    elements.progress.classList.toggle('is-indeterminate', view.indeterminate);
    elements.progress.removeAttribute('value');
    elements.progress.removeAttribute('aria-valuenow');
    elements.progress.setAttribute('aria-valuetext', view.indeterminate ? 'In progress' : '');
    if (Number.isFinite(view.progress)) {
      elements.progress.value = Math.round(view.progress * 100);
      elements.progress.setAttribute('value', String(elements.progress.value));
      elements.progress.setAttribute('aria-valuenow', String(elements.progress.value));
      elements.progress.setAttribute('aria-valuetext', `${elements.progress.value}%`);
      elements.progressBar.style.width = `${elements.progress.value}%`;
    } else {
      elements.progressBar.style.width = '36%';
    }
    // The visual progressbar can update frequently, but the polite live region
    // announces only state transitions. Screen readers can inspect the
    // progressbar value on demand without hearing download/recording chatter.
    const announcementKey = `${view.state}:${view.jobId}:${view.status ? 'status' : 'empty'}`;
    if (view.status && announcementKey !== lastAnnouncementKey) {
      elements.announcement.textContent = view.status;
      lastAnnouncementKey = announcementKey;
    } else if (!view.status) {
      elements.announcement.textContent = '';
      lastAnnouncementKey = '';
    }
    renderEq();
  }

  function schedule(delay) {
    window.clearTimeout(timer);
    if (!stopped) timer = window.setTimeout(refresh, delay);
  }

  function loadToolStatus() {
    if (!toolStatusRequest) {
      toolStatusRequest = getFfmpegStatus({ fetchImpl }).finally(() => {
        toolStatusRequest = null;
      });
    }
    return toolStatusRequest;
  }

  function stopRecorderWork() {
    if (recorderShutdown || recorderEnabled || stopped) return recorderShutdown;
    const operations = jobs.flatMap((job) => {
      if (!job.kind?.startsWith('record-')) return [];
      if (recorderAutoStopAttempted.has(job.id)) return [];
      if (job.state === 'running') {
        recorderAutoStopAttempted.add(job.id);
        return [stopRecording(job.id, { fetchImpl })];
      }
      if (['queued', 'preparing'].includes(job.state)) {
        recorderAutoStopAttempted.add(job.id);
        return [cancelRecordingPreparation(job.id, { fetchImpl })];
      }
      return [];
    });
    if (toolState === 'installing' && !recorderInstallCancelAttempted) {
      recorderInstallCancelAttempted = true;
      operations.push(cancelFfmpegInstall({ fetchImpl }));
    }
    if (!operations.length) return null;
    recorderShutdown = Promise.allSettled(operations).finally(() => {
      recorderShutdown = null;
      if (!stopped) refresh();
    });
    return recorderShutdown;
  }

  async function refresh() {
    window.clearTimeout(timer);
    const version = ++refreshVersion;
    try {
      const item = currentItem();
      const needsTool = recorderEnabled && toolState == null
        && resolveMediaAction(item).startsWith('record-');
      const requests = [listCaptureJobs({ fetchImpl })];
      if (needsTool || toolState === 'installing') requests.push(loadToolStatus());
      const values = await Promise.all(requests);
      if (stopped || version !== refreshVersion) return;
      jobs = values[0];
      if (values[1]) toolState = values[1].state;
      const presentIds = new Set(jobs.map((job) => job.id));
      ignoredJobIds = new Set([...ignoredJobIds].filter((id) => presentIds.has(id)));
      for (const jobId of recorderAutoStopAttempted) {
        if (!presentIds.has(jobId)) recorderAutoStopAttempted.delete(jobId);
      }
      for (const jobId of jobContentRatings.keys()) {
        if (!presentIds.has(jobId)) jobContentRatings.delete(jobId);
      }
      if (actionError && jobs.some((job) => job.item_id === actionError.itemId)) actionError = null;
      stopRecorderWork();
      render();
      const active = jobs.some((job) => ACTIVE_JOB_STATES.has(job.state)) || toolState === 'installing';
      schedule(document.visibilityState === 'hidden' ? 5000 : (active ? 750 : 3000));
    } catch (_error) {
      if (stopped || version !== refreshVersion) return;
      render();
      schedule(document.visibilityState === 'hidden' ? 8000 : 3000);
    }
  }

  function rememberStarted(job, item = null) {
    if (job?.id) {
      jobs = [job, ...jobs.filter((candidate) => candidate.id !== job.id)];
      if (item?.content_rating) jobContentRatings.set(job.id, item.content_rating);
    }
    transient = null;
    actionError = null;
    render();
    refresh();
  }

  async function startNewCapture() {
    const item = currentItem();
    if (!item) return;
    if (!isContentAllowed(item, getState().settings) || item.__contentHidden === true) {
      throw new Error('This item is hidden by the explicit-content setting.');
    }
    const capability = resolveMediaAction(item);
    actionError = null;
    if (capability === 'download') {
      transient = 'checking';
      render();
      const job = await startItemDownload(item, { fetchImpl });
      if (!isContentAllowed(item, getState().settings)) {
        if (job?.id) await cancelDownload(job.id, { fetchImpl }).catch(() => {});
        throw new DOMException('The pending download was cancelled by the content setting.', 'AbortError');
      }
      rememberStarted(job, item);
      return;
    }
    if (!capability.startsWith('record-')) throw new Error('Capture is unavailable for this item.');
    if (!recorderEnabled) throw new Error('Recorder is turned off in Settings.');
    const attempt = ++actionGeneration;
    transient = 'checking';
    render();
    const status = await loadToolStatus();
    toolState = status.state;
    const begin = async () => {
      const latest = currentItem();
      if (attempt !== actionGeneration || !latest || latest.id !== item.id) {
        throw new DOMException('The pending recording was cancelled.', 'AbortError');
      }
      // Record the curve that is actually audible, including an in-progress
      // EQ preview that may not have reached persistent storage yet.
      const eqCurve = effectiveUiCurve();
      const job = await startItemRecording(
        latest, getState().settings.recordingQuality, { fetchImpl, eqCurve },
      );
      if (attempt !== actionGeneration || !isContentAllowed(latest, getState().settings)) {
        if (job?.id) await cancelRecordingPreparation(job.id, { fetchImpl }).catch(() => {});
        throw new DOMException('The pending recording was cancelled by the content setting.', 'AbortError');
      }
      rememberStarted(job, latest);
    };
    if (status.state === 'ready') {
      await begin();
      return;
    }
    if (status.state === 'installing') {
      transient = 'installing';
      render();
      installWait = new AbortController();
      const installed = await waitForFfmpeg({ fetchImpl, signal: installWait.signal });
      toolState = installed.state;
      installWait = null;
      if (installed.state === 'ready') await begin();
      else throw new Error(installed.actionable_reason || installed.error?.message || 'FFmpeg installation did not complete.');
      return;
    }
    const runtime = await getRuntimeStatus({ fetchImpl });
    const destination = runtime.portable_writable ? 'portable' : 'LocalAppData';
    if (!askConfirmation(installConfirmation(destination))) {
      throw new Error('Recording needs FFmpeg. Install it from Settings to continue.');
    }
    transient = 'installing';
    render();
    installWait = new AbortController();
    const installed = await installFfmpegAndResume(
      destination, begin, { fetchImpl, signal: installWait.signal },
    );
    installWait = null;
    toolState = installed.state;
    if (installed.state !== 'ready') {
      throw new Error(installed.actionable_reason || installed.error?.message || 'FFmpeg installation did not complete.');
    }
  }

  async function perform(action) {
    if (!action || (busy && action !== 'cancel-install')) return;
    const actionItemId = currentItem()?.id || '';
    busy = true;
    render();
    try {
      const view = viewForCurrent();
      if (action === 'download' || action === 'record') {
        await startNewCapture();
      } else if (action === 'stop') {
        rememberStarted(await stopRecording(view.jobId, { fetchImpl }));
      } else if (action === 'cancel') {
        const job = jobs.find((candidate) => candidate.id === view.jobId);
        const updated = job?.kind?.startsWith('record-')
          ? await cancelRecordingPreparation(view.jobId, { fetchImpl })
          : await cancelDownload(view.jobId, { fetchImpl });
        rememberStarted(updated);
      } else if (action === 'cancel-install') {
        actionGeneration++;
        installWait?.abort();
        installWait = null;
        const status = await cancelFfmpegInstall({ fetchImpl });
        toolState = status.state;
        transient = null;
        actionError = null;
      } else if (action === 'open-folder') {
        await openDownloadsFolder({ fetchImpl });
      } else if (action === 'retry' || action === 'again') {
        if (view.jobId) ignoredJobIds.add(view.jobId);
        transient = null;
        actionError = null;
        await startNewCapture();
      } else if (action === 'settings') {
        byId('settings-btn')?.click();
      }
    } catch (error) {
      transient = null;
      if (error?.name !== 'AbortError') {
        const retryAction = ['open-folder', 'stop', 'cancel', 'cancel-install'].includes(action)
          ? action
          : 'retry';
        actionError = {
          itemId: actionItemId,
          message: error?.message || 'Capture could not start.',
          retryAction,
          jobId: viewForCurrent().jobId,
        };
      }
    } finally {
      busy = false;
      render();
      refresh();
    }
  }

  elements.primary.addEventListener('click', () => perform(elements.primary.dataset.action));
  elements.secondary.addEventListener('click', () => perform(elements.secondary.dataset.action));
  elements.eq.addEventListener('click', () => {
    const item = currentItem();
    if (item) {
      emit('eq-user-gesture', { item });
      emit('eq-open', { item });
    }
  });
  unsubscribers.push(subscribe('content-policy-change', ({ current, currentItem: changedItem } = {}) => {
    if (current === true) return;
    const hasTrackedExplicitJob = jobs.some((job) => (
      ACTIVE_JOB_STATES.has(job.state) && jobContentRatings.get(job.id) === 'explicit'
    ));
    const changedItemIsExplicit = Boolean(changedItem?.id)
      && !isContentAllowed(changedItem, false);
    if (!changedItemIsExplicit && !hasTrackedExplicitJob) return;
    actionGeneration++;
    installWait?.abort();
    installWait = null;
    transient = null;
    actionError = null;
    const blockedJobs = jobs.filter((job) => (
      ACTIVE_JOB_STATES.has(job.state)
      && (jobContentRatings.get(job.id) === 'explicit' || job.item_id === changedItem?.id)
    ));
    Promise.allSettled(blockedJobs.map((job) => {
      if (job.kind?.startsWith('record-')) {
        if (job.state === 'running') return stopRecording(job.id, { fetchImpl });
        if (['queued', 'preparing'].includes(job.state)) {
          return cancelRecordingPreparation(job.id, { fetchImpl });
        }
        return Promise.resolve(job);
      }
      return cancelDownload(job.id, { fetchImpl });
    })).finally(() => {
      if (!stopped) refresh();
    });
    render();
  }));
  unsubscribers.push(subscribe('current-item', (nextItem) => {
    const nextItemId = nextItem?.id || '';
    if (nextItemId !== observedItemId) {
      actionGeneration++;
      installWait?.abort();
      installWait = null;
      transient = null;
      actionError = null;
      observedItemId = nextItemId;
      eqPreview = null;
    }
    render();
    refresh();
  }));
  unsubscribers.push(subscribe('mode-change', () => { render(); refresh(); }));
  unsubscribers.push(subscribe('settings-change', (settings) => {
    const next = settings?.recordingEnabled !== false;
    if (next === recorderEnabled) return;
    recorderEnabled = next;
    if (!recorderEnabled) {
      actionGeneration++;
      installWait?.abort();
      installWait = null;
      transient = null;
      actionError = null;
      stopRecorderWork();
    } else {
      recorderAutoStopAttempted.clear();
      recorderInstallCancelAttempted = false;
    }
    render();
  }));
  unsubscribers.push(subscribe('favorites-change', () => { eqPreview = null; renderEq(); }));
  unsubscribers.push(subscribe('eq-preview', (value) => {
    if (value?.itemId === currentItem()?.id && value.curve) eqPreview = value;
    renderEq();
  }));
  unsubscribers.push(subscribe('eq-change', (value) => {
    if (!value?.itemId || value.itemId === currentItem()?.id) eqPreview = null;
    renderEq();
  }));
  unsubscribers.push(subscribe('eq-engine-change', (status) => {
    eqEngineStatus = status || { state: 'error', reason: 'Audio processing state was lost.' };
    renderEq();
  }));
  const onFocus = () => refresh();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  globalThis.addEventListener?.('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  render();
  refresh();

  return {
    refresh,
    destroy() {
      stopped = true;
      refreshVersion++;
      actionGeneration++;
      installWait?.abort();
      window.clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      globalThis.removeEventListener?.('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
