/** Live recording client using opaque media registration and fixed quality profiles. */

import { controlRequest } from './capture-client.js';
import { connectMediaRelay } from './media-failover.js';

export function startRegisteredRecording(mediaId, profile, options = {}) {
  const { eqCurve, ...requestOptions } = options;
  const eq = eqCurve && typeof eqCurve === 'object' ? {
    preamp: eqCurve.preamp,
    bands: Array.isArray(eqCurve.bands) ? [...eqCurve.bands] : eqCurve.bands,
    bypassed: eqCurve.bypassed,
  } : undefined;
  return controlRequest('/api/v1/jobs/record', {
    ...requestOptions, method: 'POST',
    body: { media_id: mediaId, profile, ...(eq ? { eq } : {}) },
  });
}

export async function startItemRecording(item, profile, options = {}) {
  const { eqCurve, ...requestOptions } = options;
  // Use the same verified endpoint selected by playback. If the current URL
  // has gone stale, bounded IPTV alternates are tried before a job is created.
  const registration = await connectMediaRelay(item, requestOptions);
  return startRegisteredRecording(registration.media_id, profile, { ...requestOptions, eqCurve });
}

export function stopRecording(jobId, options = {}) {
  return controlRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/stop`, {
    ...options, method: 'POST', body: {},
  });
}

export function cancelRecordingPreparation(jobId, options = {}) {
  return controlRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    ...options, method: 'POST', body: {},
  });
}

export function getRecordingJob(jobId, options = {}) {
  return controlRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`, options);
}
