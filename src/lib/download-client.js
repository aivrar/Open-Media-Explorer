/** Finite-download client. Upstream URLs are exchanged for opaque registrations first. */

import {
  controlRequest, expireMedia, isDefinitiveRejection, registerDownloadMedia,
} from './capture-client.js';

export function startRegisteredDownload(mediaId, options = {}) {
  return controlRequest('/api/v1/jobs/download', {
    ...options, method: 'POST', body: { media_id: mediaId },
  });
}

export async function startItemDownload(item, options = {}) {
  const registration = await registerDownloadMedia(item, options);
  try {
    return await startRegisteredDownload(registration.media_id, options);
  } catch (error) {
    // Only a definite refusal proves no job took this registration. After a
    // lost reply the job may be running; the backend releases a job's root
    // when the job ends, and an unused root expires by itself.
    if (isDefinitiveRejection(error)) {
      expireMedia(registration.media_id, 0, { fetchImpl: options.fetchImpl }).catch(() => {});
    }
    throw error;
  }
}

export function getDownloadJob(jobId, options = {}) {
  return controlRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`, options);
}

export function cancelDownload(jobId, options = {}) {
  return controlRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    ...options, method: 'POST', body: {},
  });
}

export function openDownloadsFolder(options = {}) {
  return controlRequest('/api/v1/downloads/open-folder', {
    ...options, method: 'POST', body: {},
  });
}
