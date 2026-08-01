/** Authenticated same-origin control client and opaque media relay lifecycle. */

let sessionPromise = null;

export class ControlApiError extends Error {
  constructor(code, message, status = 0, retryable = false, retryAfter = null) {
    super(message || 'Local control request failed.');
    this.name = 'ControlApiError';
    this.code = code || 'CONTROL_ERROR';
    this.status = status;
    this.retryable = !!retryable;
    this.retryAfter = retryAfter !== null && retryAfter !== '' && Number.isFinite(Number(retryAfter))
      ? Math.max(0, Math.min(Number(retryAfter), 24 * 60 * 60))
      : null;
  }
}

export async function getControlSession({ fetchImpl = fetch, signal } = {}) {
  if (!sessionPromise) {
    const options = {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    };
    if (signal) options.signal = signal;
    sessionPromise = fetchImpl('/api/v1/session', options).then(async (response) => {
      const envelope = await response.json();
      if (!response.ok || !envelope?.ok || !envelope.data?.token) {
        throw new ControlApiError(
          envelope?.error?.code, envelope?.error?.message, response.status, envelope?.error?.retryable,
        );
      }
      return envelope.data;
    }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function resetControlSession() { sessionPromise = null; }

export function listCaptureJobs(options = {}) {
  return controlRequest('/api/v1/jobs', options).then((data) => data?.jobs || []);
}

export async function controlRequest(path, {
  method = 'GET', body, fetchImpl = fetch, signal,
} = {}) {
  const session = await getControlSession({ fetchImpl, signal });
  const headers = { 'X-WorldMedia-Token': session.token };
  const options = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (signal) options.signal = signal;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetchImpl(path, options);
  let envelope = null;
  try { envelope = await response.json(); } catch (_) { /* normalized below */ }
  if (!response.ok || !envelope?.ok) {
    if (response.status === 403 && envelope?.error?.code === 'INVALID_TOKEN') resetControlSession();
    throw new ControlApiError(
      envelope?.error?.code,
      envelope?.error?.message,
      response.status,
      envelope?.error?.retryable,
      response.headers?.get?.('Retry-After'),
    );
  }
  return envelope.data;
}

export function mediaTypeForItem(item) {
  if (['audio', 'video', 'hls', 'dash'].includes(item?.stream_kind)) return item.stream_kind;
  return item?.type === 'tv' || item?.type === 'video' ? 'video' : 'audio';
}

export function recordingKindForItem(item) {
  return item?.type === 'tv' || item?.type === 'video' ? 'video' : 'audio';
}

export async function registerMedia(item, options = {}) {
  if (!item?.id || !item?.stream_url) throw new ControlApiError('INVALID_MEDIA_ITEM', 'Media is unresolved.');
  return controlRequest('/api/v1/media/register', {
    ...options,
    method: 'POST',
    body: {
      item_id: item.id,
      url: item.stream_url,
      delivery: item.delivery || 'unknown',
      media_type: mediaTypeForItem(item),
      recording_kind: recordingKindForItem(item),
      capture_headers: item.capture_headers || {},
      title: item.title,
      source: item.source,
      download_name: item.download_name || '',
    },
  });
}

export async function registerDownloadMedia(item, options = {}) {
  if (!item?.id || !item?.download_url) {
    throw new ControlApiError('DOWNLOAD_UNAVAILABLE', 'This item has no finite download URL.');
  }
  return controlRequest('/api/v1/media/register', {
    ...options,
    method: 'POST',
    body: {
      item_id: item.id,
      url: item.download_url,
      delivery: 'on-demand',
      media_type: mediaTypeForItem(item),
      capture_headers: item.capture_headers || {},
      title: item.title,
      source: item.source,
      download_name: item.download_name || '',
    },
  });
}

export async function expireMedia(mediaId, graceSeconds = 0, options = {}) {
  if (!mediaId) return null;
  return controlRequest(`/api/v1/media/${encodeURIComponent(mediaId)}/expire`, {
    ...options, method: 'POST', body: { grace_seconds: graceSeconds },
  });
}
