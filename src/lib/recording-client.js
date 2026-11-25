/** Live recording client using opaque media registration and fixed quality profiles. */

import { controlRequest, expireMedia, isDefinitiveRejection, registerMedia } from './capture-client.js';
import { MEDIA_PROBE_TIMEOUT_MS } from './media-failover.js';

export function startRegisteredRecording(mediaId, profile, options = {}) {
  const { eqCurve, delivery, ...requestOptions } = options;
  const eq = eqCurve && typeof eqCurve === 'object' ? {
    preamp: eqCurve.preamp,
    bands: Array.isArray(eqCurve.bands) ? [...eqCurve.bands] : eqCurve.bands,
    bypassed: eqCurve.bypassed,
    ...(Array.isArray(eqCurve.q) ? { q: [...eqCurve.q] } : {}),
  } : undefined;
  return controlRequest('/api/v1/jobs/record', {
    ...requestOptions, method: 'POST',
    body: { media_id: mediaId, profile, ...(delivery ? { delivery } : {}), ...(eq ? { eq } : {}) },
  });
}

async function registerForRecording(item, { fetchImpl, signal } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('Media connection timed out.')), MEDIA_PROBE_TIMEOUT_MS);
  try {
    const registration = registerMedia(item, { fetchImpl, signal: controller.signal }).then((relay) => {
      if (controller.signal.aborted) {
        expireMedia(relay.media_id, 0, { fetchImpl }).catch(() => {});
        throw controller.signal.reason;
      }
      return relay;
    });
    return await Promise.race([registration, cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function startItemRecording(item, profile, options = {}) {
  const { eqCurve, revalidate, ...requestOptions } = options;
  const delivery = item?.delivery || 'unknown';
  const registration = await registerForRecording(item, requestOptions);
  let sent = false;
  try {
    return await startRegisteredRecording(registration.media_id, profile, {
      ...requestOptions, eqCurve, delivery,
      beforeSend: () => {
        requestOptions.signal?.throwIfAborted();
        revalidate?.();
        sent = true;
      },
    });
  } catch (error) {
    // Only a definite refusal proves no job took this registration. After a
    // lost reply the job may be running; the backend releases a job's root
    // when the job ends, and an unused root expires by itself.
    if (!sent || isDefinitiveRejection(error)) {
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
