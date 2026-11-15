/** Live recording client using opaque media registration and fixed quality profiles. */

import { controlRequest, expireMedia, isDefinitiveRejection } from './capture-client.js';
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
  try {
    return await startRegisteredRecording(registration.media_id, profile, { ...requestOptions, eqCurve });
  } catch (error) {
    // Only a definite refusal proves no job took this registration. After a
    // lost reply the job may be running; the backend releases a job's root
    // when the job ends, and an unused root expires by itself.
    if (isDefinitiveRejection(error)) {
      expireMedia(registration.media_id, 0, { fetchImpl: requestOptions.fetchImpl }).catch(() => {});
    }
    throw error;
  }
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
