/** Pure player capture-action state mapping. */

export const CAPTURE_VIEW_STATES = Object.freeze([
  'download', 'record', 'stop-recording', 'checking', 'installing',
  'downloading', 'finalizing', 'completed', 'failed', 'unavailable',
]);

const RECORD_KINDS = new Set(['record-audio', 'record-video']);
const ACTIVE_STATES = new Set(['queued', 'preparing', 'running', 'stopping', 'finalizing']);

function elapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function bytes(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${Math.floor(size)} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function base(state, label, options = {}) {
  return {
    state, label, action: options.action || null, disabled: Boolean(options.disabled),
    disabledReason: options.disabledReason || '', status: options.status || '',
    tone: options.tone || 'neutral', progress: options.progress ?? null,
    indeterminate: Boolean(options.indeterminate), jobId: options.jobId || '',
    secondaryAction: options.secondaryAction || null,
    secondaryLabel: options.secondaryLabel || '',
  };
}

function jobStatus(job, currentItemId) {
  const isRecording = RECORD_KINDS.has(job.kind);
  const ownsCurrent = Boolean(currentItemId && job.item_id === currentItemId);
  const otherTitle = !ownsCurrent && job.title ? ` “${job.title}”` : '';
  const timing = elapsed(job.elapsed_seconds);

  if (job.state === 'queued' || job.state === 'preparing') {
    if (isRecording) {
      return base('checking', 'Preparing…', {
        disabled: true, disabledReason: 'Recording is being prepared.',
        status: `Preparing recording${otherTitle} • ${timing}`,
        indeterminate: true, jobId: job.id,
        secondaryAction: 'cancel', secondaryLabel: 'Cancel',
      });
    }
    return base('downloading', 'Cancel download', {
      action: 'cancel', status: `Preparing download • ${timing}`,
      indeterminate: true, jobId: job.id,
    });
  }
  if (job.state === 'running') {
    if (isRecording) {
      return base('stop-recording', 'Stop recording', {
        action: 'stop', tone: 'recording',
        status: `Recording${otherTitle} • ${timing} • ${bytes(job.bytes_written)}`,
        indeterminate: true, jobId: job.id,
      });
    }
    const percent = Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
    return base('downloading', 'Cancel download', {
      action: 'cancel', tone: 'active',
      status: `Downloading • ${percent == null ? bytes(job.bytes_written) : `${percent}% • ${bytes(job.bytes_written)}`} • ${timing}`,
      progress: Number.isFinite(job.progress) ? job.progress : null,
      indeterminate: !Number.isFinite(job.progress), jobId: job.id,
    });
  }
  if (job.state === 'stopping') {
    return base('stop-recording', 'Stopping…', {
      disabled: true, disabledReason: 'FFmpeg is stopping and flushing the recording.',
      status: `Stopping recording${otherTitle} • ${timing}`,
      indeterminate: true, tone: 'recording', jobId: job.id,
    });
  }
  if (job.state === 'finalizing') {
    return base('finalizing', 'Finalizing…', {
      disabled: true, disabledReason: 'The media file is being validated and finalized.',
      status: `${isRecording ? 'Finalizing recording' : 'Finalizing download'}${otherTitle} • ${timing}`,
      indeterminate: true, tone: 'active', jobId: job.id,
    });
  }
  if (job.state === 'completed') {
    return base('completed', 'Open folder', {
      action: 'open-folder', tone: 'success', jobId: job.id,
      status: `${isRecording ? 'Recording' : 'Download'} complete • ${bytes(job.bytes_written)} • ${timing}`,
      secondaryAction: 'again', secondaryLabel: isRecording ? 'Record again' : 'Download again',
    });
  }
  const cancelled = job.state === 'cancelled';
  return base('failed', 'Retry', {
    action: 'retry', tone: cancelled ? 'neutral' : 'danger', jobId: job.id,
    status: cancelled ? 'Capture cancelled.' : (job.error?.message || 'Capture failed.'),
    secondaryAction: job.output_path ? 'open-folder' : null,
    secondaryLabel: job.output_path ? 'Open recoverable file folder' : '',
  });
}

export function deriveCaptureView({
  item = null, capability = 'unavailable', jobs = [], toolState = null,
  transient = null, ignoredJobIds = new Set(),
} = {}) {
  const visibleJobs = Array.isArray(jobs)
    ? jobs.filter((job) => job && !ignoredJobIds.has(job.id))
    : [];
  if (transient === 'checking') {
    const operation = capability === 'download' ? 'download' : 'recording';
    return base('checking', 'Preparing…', {
      disabled: true, disabledReason: 'The capture action is being prepared.',
      status: `Preparing ${operation}…`, indeterminate: true,
    });
  }
  if (transient === 'installing' || toolState === 'installing') {
    return base('installing', 'Installing FFmpeg…', {
      disabled: true, disabledReason: 'FFmpeg is being installed and verified.',
      status: 'Installing and verifying FFmpeg…', indeterminate: true,
      secondaryAction: 'cancel-install', secondaryLabel: 'Cancel install',
    });
  }

  const activeRecording = visibleJobs.find(
    (job) => RECORD_KINDS.has(job.kind) && ACTIVE_STATES.has(job.state),
  );
  if (activeRecording) return jobStatus(activeRecording, item?.id || '');

  const relevant = item?.id
    ? visibleJobs.find((job) => job.item_id === item.id && job.kind !== 'ffmpeg-install')
    : visibleJobs.find((job) => job.kind === 'download' && ACTIVE_STATES.has(job.state));
  if (relevant) return jobStatus(relevant, item?.id || '');

  let view;
  if (capability === 'download') {
    view = base('download', 'Download', {
      action: 'download', status: 'Original media can be downloaded.',
    });
  } else if (capability === 'record-audio' || capability === 'record-video') {
    view = base('record', capability === 'record-video' ? 'Record video' : 'Record audio', {
      action: 'record', status: 'Live media can be recorded.',
    });
  } else if (capability === 'checking') {
    view = base('checking', 'Checking…', {
      disabled: true, disabledReason: 'The media source is still being resolved.',
      status: 'Checking media capability…', indeterminate: true,
    });
  } else {
    view = base('unavailable', 'Unavailable', {
      disabled: true, disabledReason: 'This item has no downloadable original or recordable stream.',
      status: item ? 'Download and recording are unavailable for this item.' : '',
    });
  }

  const backgroundDownloads = visibleJobs.filter(
    (job) => job.kind === 'download' && ACTIVE_STATES.has(job.state),
  ).length;
  if (backgroundDownloads) {
    view.status += `${view.status ? ' ' : ''}${backgroundDownloads} download${backgroundDownloads === 1 ? '' : 's'} ${backgroundDownloads === 1 ? 'continues' : 'continue'} in the background.`;
  }
  return view;
}

export function isEqCurveActive(curve) {
  if (!curve || typeof curve !== 'object') return false;
  if (curve.bypassed === true) return false;
  return Math.abs(Number(curve.preamp) || 0) > 0.01
    || Array.isArray(curve.bands) && curve.bands.some((value) => Math.abs(Number(value) || 0) > 0.01);
}
