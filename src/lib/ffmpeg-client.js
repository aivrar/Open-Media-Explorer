/** Verified managed FFmpeg control client. */

import { controlRequest } from './capture-client.js';

export const FFMPEG_PROVIDER = 'BtbN/FFmpeg-Builds';
export const FFMPEG_VERSION_FAMILY = 'FFmpeg n8.1 win64 GPL 8.1';
export const FFMPEG_APPROX_SIZE = 'about 160 MB';

export function getFfmpegStatus(options = {}) {
  return controlRequest('/api/v1/ffmpeg/status', options);
}

export function getRuntimeStatus(options = {}) {
  return controlRequest('/api/v1/runtime', options);
}

/** Persist the localhost listener for the next native-app launch. */
export function saveServerPort(port, options = {}) {
  return controlRequest('/api/v1/runtime/server-port', {
    ...options, method: 'POST', body: { port },
  });
}

export function startFfmpegInstall(destination, options = {}) {
  return controlRequest('/api/v1/ffmpeg/install', {
    ...options, method: 'POST', body: { confirmed: true, destination },
  });
}

export function repairFfmpeg(destination, options = {}) {
  return controlRequest('/api/v1/ffmpeg/repair', {
    ...options, method: 'POST', body: { confirmed: true, destination },
  });
}

export function cancelFfmpegInstall(options = {}) {
  return controlRequest('/api/v1/ffmpeg/cancel', { ...options, method: 'POST', body: {} });
}

export function removeManagedFfmpeg(destination, options = {}) {
  return controlRequest('/api/v1/ffmpeg/remove', {
    ...options, method: 'POST', body: { confirmed: true, destination },
  });
}

export async function waitForFfmpeg({
  fetchImpl = fetch, intervalMs = 750, timeoutMs = 15 * 60 * 1000, signal,
} = {}) {
  const started = Date.now();
  while (true) {
    if (signal?.aborted) throw new DOMException('FFmpeg wait was cancelled.', 'AbortError');
    const status = await getFfmpegStatus({ fetchImpl });
    if (status.state === 'ready') return status;
    if (['error', 'cancelled', 'missing'].includes(status.state)) return status;
    if (Date.now() - started >= timeoutMs) throw new Error('FFmpeg installation status timed out.');
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('FFmpeg wait was cancelled.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, intervalMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Phase 8 can pass its original record callback so installation resumes it automatically. */
export async function installFfmpegAndResume(destination, resume, options = {}) {
  await startFfmpegInstall(destination, options);
  const status = await waitForFfmpeg(options);
  if (status.state === 'ready' && typeof resume === 'function') await resume(status);
  return status;
}
