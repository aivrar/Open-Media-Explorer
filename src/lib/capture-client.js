/** Authenticated same-origin control client and opaque media relay lifecycle. */

let sessionCache = { data: null, pending: new Map(), generation: 0, appliedGeneration: 0 };

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

/**
 * True only when the local server really answered and refused the request,
 * so it certainly did not act on it. Relies on ControlApiError.status, the
 * HTTP status of a received reply: transport failures, aborts and timeouts
 * reject with the raw fetch error (never a ControlApiError), and a 2xx reply
 * whose body could not be read keeps its 2xx status. 4xx replies are
 * validation/conflict refusals and 503 is a "busy/stopping" refusal. A 500
 * comes from an unexpected server exception that may have happened after
 * the work started, so it stays ambiguous.
 */
export function isDefinitiveRejection(error) {
  if (!(error instanceof ControlApiError)) return false;
  const status = Number(error.status) || 0;
  return (status >= 400 && status < 500) || status === 503;
}

export async function getControlSession({ fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted();
  const cache = sessionCache;
  if (cache.data) return cache.data;
  // Only share a pending lookup among callers with the same cancellation
  // signal. Cancelling one cold Play or stream candidate must not fail another.
  const pending = cache.pending.get(signal);
  if (pending) return pending.request;

  const generation = ++cache.generation;
  const controller = new AbortController();
  const lookupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(lookupSignal.reason);
    lookupSignal.addEventListener('abort', rejectAbort, { once: true });
  });

  // Cold Play needs its own connection for the session too.
  const lookup = (async () => {
    const response = await fetchImpl('/api/v1/session', {
      method: 'GET', credentials: 'omit', cache: 'no-store', signal: lookupSignal,
    });
    const envelope = await response.json();
    lookupSignal.throwIfAborted();
    if (!response.ok || !envelope?.ok || !envelope.data?.token) {
      throw new ControlApiError(
        envelope?.error?.code, envelope?.error?.message, response.status, envelope?.error?.retryable,
      );
    }
    // A slower lookup may have reached the previous server instance.
    if (generation > cache.appliedGeneration) {
      cache.appliedGeneration = generation;
      cache.data = envelope.data;
    }
  })();
  const request = Promise.race([lookup, cancelled]).finally(() => {
    lookupSignal.removeEventListener('abort', rejectAbort);
    cache.pending.delete(signal);
  }).then(() => {
    lookupSignal.throwIfAborted();
    // A newer token may already have been rejected. Retry with the same signal.
    return cache.data ?? getControlSession({ fetchImpl, signal });
  });
  cache.pending.set(signal, { request, controller });
  return request;
}

export function invalidateControlSession(token) {
  if (sessionCache.data && sessionCache.data.token === token) sessionCache.data = null;
}

export function resetControlSession() {
  const previous = sessionCache;
  sessionCache = { data: null, pending: new Map(), generation: 0, appliedGeneration: 0 };
  for (const { controller } of previous.pending.values()) controller.abort();
}

export function listCaptureJobs(options = {}) {
  return controlRequest('/api/v1/jobs', options).then((data) => data?.jobs || []);
}

/*
 * The browser opens at most six connections to the local server at a time
 * and queues every further request behind them, with no regard for what it
 * is. On a first catalogue load those six can all be held for many seconds
 * (podcast feeds, catalogue pages, artwork), so a small request that must not
 * wait (a profile save, which gives up after 10 s) could time out while it
 * was still in that queue, never having reached the app. A request sent
 * without credentials uses a separate set of connections; the control routes
 * never use cookies (the session token is a header), so `ownConnection: true`
 * sends it that way and it no longer waits behind the catalogue.
 */
export async function controlRequest(path, {
  method = 'GET', body, fetchImpl = fetch, signal, keepalive = false, headers: extraHeaders = null,
  ownConnection = false, beforeSend,
} = {}) {
  const session = await getControlSession({ fetchImpl, signal });
  // Extra headers (the profile write order, see profile-transfer.js) never
  // replace the session token.
  const headers = { ...(extraHeaders || {}), 'X-WorldMedia-Token': session.token };
  const options = {
    method, headers, credentials: ownConnection === true ? 'omit' : 'same-origin', cache: 'no-store',
  };
  if (signal) options.signal = signal;
  // Lets a small request outlive the page (release on pagehide).
  if (keepalive === true) options.keepalive = true;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  signal?.throwIfAborted();
  beforeSend?.();
  const response = await fetchImpl(path, options);
  let envelope = null;
  try { envelope = await response.json(); } catch (_) { /* normalized below */ }
  if (!response.ok || !envelope?.ok) {
    if (response.status === 403 && envelope?.error?.code === 'INVALID_TOKEN') {
      invalidateControlSession(session.token);
    }
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
    // Play was pressed and the user waits for this: it does not queue behind
    // catalogue pages and artwork for a free connection (controlRequest).
    ownConnection: true,
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
      // Only sent when set: a verified stream that must stay on https.
      ...(item.require_https === true ? { require_https: true } : {}),
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
      ...(item.download_part ? { download_part: item.download_part } : {}),
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
