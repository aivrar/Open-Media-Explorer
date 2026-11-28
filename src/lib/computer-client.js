import { controlRequest } from './capture-client.js';

const COMPUTER_ROUTE = '/api/v1/computer';
const FOLDERS_ROUTE = COMPUTER_ROUTE + '/folders';

export function listComputerFolders(options = {}) {
  return controlRequest(FOLDERS_ROUTE, options);
}

export function addComputerFolder(path, options = {}) {
  return controlRequest(FOLDERS_ROUTE + '/add', {
    ...options, method: 'POST', body: { path },
  });
}

export function relocateComputerFolder(id, path, options = {}) {
  return controlRequest(FOLDERS_ROUTE + '/relocate', {
    ...options, method: 'POST', body: { id, path },
  });
}

export function removeComputerFolder(id, options = {}) {
  return controlRequest(FOLDERS_ROUTE + '/remove', {
    ...options, method: 'POST', body: { id },
  });
}

export function computerStatus(options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/status', options);
}

export function startComputerScan(options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/scan', {
    ...options, method: 'POST', body: { action: 'start' },
  });
}

export function cancelComputerScan(options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/scan', {
    ...options, method: 'POST', body: { action: 'cancel' },
  });
}

export function loadComputerLibrary(sinceRevision, { generation, ...options } = {}) {
  const query = sinceRevision == null ? '' : '?since=' + encodeURIComponent(sinceRevision)
    + (generation == null ? '' : '&gen=' + encodeURIComponent(generation));
  return controlRequest(COMPUTER_ROUTE + '/library' + query, options);
}

export function listComputerStars(options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/stars', options);
}

export function writeComputerStars({ add, remove }, options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/stars', {
    ...options, method: 'POST', body: { ...(add?.length && { add }), ...(remove?.length && { remove }) },
  });
}

export function openComputerMedia(id, { convert = false, audio, standby = false, ...options } = {}) {
  return controlRequest(COMPUTER_ROUTE + '/play', {
    ...options, method: 'POST', body: { id, ...(standby && { standby: true }), ...(convert && { convert }), ...(audio != null && { audio }) },
  });
}

export function measureComputerLoudness(id, options = {}) {
  return controlRequest(COMPUTER_ROUTE + '/loudness', { ...options, method: 'POST', body: { id } });
}

export function loadComputerSubtitle(id, key, options = {}) {
  const query = '?entry=' + encodeURIComponent(id) + '&key=' + encodeURIComponent(key);
  return controlRequest(COMPUTER_ROUTE + '/subtitle' + query, { ...options, responseType: 'text' });
}

export function computerHlsToken(playlistUrl) {
  const hlsRoute = COMPUTER_ROUTE + '/hls/';
  if (typeof playlistUrl !== 'string' || !playlistUrl.startsWith(hlsRoute)) return null;
  return /^([^/?#]+)\/[^/?#]+\.m3u8(?:[?#]|$)/.exec(playlistUrl.slice(hlsRoute.length))?.[1] ?? null;
}

export function computerMediaToken(url) {
  if (typeof url !== 'string') return null;
  return /^\/api\/v1\/computer\/media\/([^/?#]+)(?:[?#]|$)/.exec(url)?.[1] ?? null;
}

function sessionAction(route, options) {
  return controlRequest(COMPUTER_ROUTE + route, {
    ...options, method: 'POST', keepalive: true, ownConnection: true, responseType: 'text',
  });
}

export function releaseComputerHls(token, options = {}) {
  return sessionAction('/hls/' + token + '/release', options);
}

export function releaseComputerMedia(token, options = {}) {
  return sessionAction('/media/' + token + '/release', options);
}

export function keepComputerMedia(token, options = {}) {
  return sessionAction('/media/' + token + '/keep', options);
}

export async function pickComputerFolder() {
  const api = globalThis.window?.pywebview?.api;
  if (typeof api?.pick_media_folder !== 'function') return { path: '', available: false };
  try {
    const result = await api.pick_media_folder();
    if (!result?.error) return { path: result?.path || '', available: true };
  } catch {
    // Use the manual path entry when the bridge rejects.
  }
  return { path: '', available: true, failed: true };
}
