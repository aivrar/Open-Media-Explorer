/** Finite-download client. Upstream URLs are exchanged for opaque registrations first. */

import { controlRequest, registerDownloadMedia } from './capture-client.js';

export function startRegisteredDownload(mediaId, options = {}) {
  return controlRequest('/api/v1/jobs/download', {
    ...options, method: 'POST', body: { media_id: mediaId },
  });
}

export async function startItemDownload(item, options = {}) {
  const registration = await registerDownloadMedia(item, options);
  return startRegisteredDownload(registration.media_id, options);
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
