/**
 * Strict HTTP helpers for adapter metadata requests.
 *
 * Browser requests are rewritten through the fixed-host localhost proxy when
 * present. JSON and text are separate operations: HTML/CAPTCHA and malformed
 * JSON can never quietly become a successful empty adapter response.
 */

function rewriteForProxy(url) {
  const prefix = (typeof window !== 'undefined' && window.WORLDMEDIA_PROXY) || '';
  if (!prefix) return null;
  return prefix + encodeURIComponent(url);
}

const DEFAULT_HEADERS = {
  'User-Agent': 'WorldMediaWindows/0.1.2',
  Accept: 'application/json, text/plain, */*',
};

// The local proxy waits up to 20 seconds for an upstream response. Keep the
// browser timeout slightly longer so a successful proxy response is not
// abandoned just before it arrives.
export const DEFAULT_TIMEOUT_MS = 22_000;
export const DEFAULT_RESPONSE_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(message, statusOrOptions = 0) {
    super(message);
    const options = typeof statusOrOptions === 'number'
      ? { status: statusOrOptions }
      : (statusOrOptions || {});
    this.name = 'HttpError';
    this.code = options.code || 'HTTP_ERROR';
    this.status = Number(options.status || 0);
    this.url = options.url || '';
    this.contentType = options.contentType || '';
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class HttpContentTypeError extends HttpError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'UNEXPECTED_CONTENT_TYPE' });
    this.name = 'HttpContentTypeError';
  }
}

export class HttpParseError extends HttpError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'MALFORMED_RESPONSE' });
    this.name = 'HttpParseError';
  }
}

export class HttpResponseTooLargeError extends HttpError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'RESPONSE_TOO_LARGE' });
    this.name = 'HttpResponseTooLargeError';
  }
}

export class ProviderError extends HttpError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'PROVIDER_ERROR' });
    this.name = 'ProviderError';
    this.errors = Array.isArray(options.errors) ? options.errors : [];
  }
}

function makeAbortError(reason = null) {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') {
    return new DOMException(String(reason?.message || reason || 'Aborted'), 'AbortError');
  }
  const error = new Error(String(reason?.message || reason || 'Aborted'));
  error.name = 'AbortError';
  return error;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(Number(text) * 1000)));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Number(now || 0)));
}

function wait(ms, signal, timer = setTimeout, clearTimer = clearTimeout) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const finish = () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const handle = timer(finish, ms);
    if (!signal) return;
    onAbort = () => {
      clearTimer(handle);
      signal.removeEventListener('abort', onAbort);
      reject(makeAbortError(signal.reason));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error) {
  if (error?.name === 'AbortError') return false;
  const status = Number(error?.status || 0);
  return status === 408 || status === 429 || status >= 500 || status === 0;
}

function contentTypeOf(response) {
  return response?.headers?.get?.('content-type') || '';
}

function headerOf(response, name) {
  return response?.headers?.get?.(name) || '';
}

function metadataHeaderOf(response, name, maxLength) {
  const value = headerOf(response, name);
  return typeof value === 'string' && value.length <= maxLength && !/[\r\n\0]/.test(value)
    ? value
    : '';
}

function utf8Length(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
  // TextEncoder exists in supported WebView2/Node. This fallback remains a
  // conservative approximation for unusual test hosts.
  return unescape(encodeURIComponent(text)).length;
}

async function readTextBounded(response, maxBytes, url) {
  const budget = Math.max(1, Number(maxBytes) || DEFAULT_RESPONSE_MAX_BYTES);
  const declared = Number(headerOf(response, 'content-length'));
  if (Number.isFinite(declared) && declared > budget) {
    throw new HttpResponseTooLargeError(`Response exceeds ${budget} bytes for ${url}`, {
      status: response.status, url, contentType: contentTypeOf(response),
    });
  }

  if (response.body?.getReader && typeof TextDecoder === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const parts = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength || 0;
        if (total > budget) {
          try { await reader.cancel(); } catch (_) {}
          throw new HttpResponseTooLargeError(`Response exceeds ${budget} bytes for ${url}`, {
            status: response.status, url, contentType: contentTypeOf(response),
          });
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } finally {
      try { reader.releaseLock?.(); } catch (_) {}
    }
  }

  const text = await response.text();
  if (utf8Length(text) > budget) {
    throw new HttpResponseTooLargeError(`Response exceeds ${budget} bytes for ${url}`, {
      status: response.status, url, contentType: contentTypeOf(response),
    });
  }
  return text;
}

function looksLikeHtmlOrXml(text, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('text/html') || type.includes('application/xhtml') || type.includes('application/xml')) {
    return true;
  }
  return /^\s*(?:<!doctype\s+html|<html\b|<\?xml\b)/i.test(text);
}

function acceptsJsonContentType(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return !type || type === 'application/json' || type === 'text/json'
    || type.endsWith('+json') || type === 'application/javascript' || type === 'text/plain';
}

async function request(url, options = {}, responseKind = 'json') {
  if (typeof url !== 'string' || !url) throw new TypeError('HTTP request requires a URL');
  const method = options.method || 'GET';
  const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
  const target = rewriteForProxy(url) || url;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Number(options.retries || 0));
  const retryBaseMs = Math.max(0, Number(options.retryBaseMs ?? 400));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle = null;
    const onExternalAbort = () => controller.abort(makeAbortError(options.signal?.reason));
    if (options.signal?.aborted) controller.abort(makeAbortError(options.signal.reason));
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (timeoutMs > 0) {
      timeoutHandle = (options.setTimer || setTimeout)(() => {
        timedOut = true;
        controller.abort(makeAbortError('Timed out'));
      }, timeoutMs);
    }

    try {
      const response = await fetchImpl(target, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      const contentType = contentTypeOf(response);
      const retryAfterMs = parseRetryAfter(headerOf(response, 'retry-after'), (options.now || Date.now)());
      if (!response.ok) {
        const statusError = new HttpError(`HTTP ${response.status} ${response.statusText || ''} for ${url}`.trim(), {
          status: response.status,
          url,
          contentType,
          retryAfterMs,
          code: response.status === 429 ? 'RATE_LIMITED' : 'HTTP_STATUS',
        });
        // Failed metadata bodies are never consumed. Cancel them so an
        // erroring upstream cannot outlive the scheduler operation.
        try { await response.body?.cancel?.(); } catch (_) {}
        throw statusError;
      }

      const text = await readTextBounded(
        response, options.maxBytes ?? DEFAULT_RESPONSE_MAX_BYTES, url,
      );
      if (responseKind === 'text') {
        const allowed = options.contentTypes;
        if (Array.isArray(allowed) && allowed.length > 0
            && !allowed.some((type) => contentType.toLowerCase().includes(String(type).toLowerCase()))) {
          throw new HttpContentTypeError(`Unexpected ${contentType || 'unknown'} response for ${url}`, {
            status: response.status, url, contentType,
          });
        }
        return text;
      }

      if (looksLikeHtmlOrXml(text, contentType) || !acceptsJsonContentType(contentType)) {
        throw new HttpContentTypeError(`Expected JSON but received ${contentType || 'non-JSON content'} for ${url}`, {
          status: response.status, url, contentType,
        });
      }
      let payload;
      try {
        payload = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (cause) {
        throw new HttpParseError(`Malformed JSON for ${url}`, {
          status: response.status, url, contentType, cause,
        });
      }
      if (options.graphql === true && Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const first = payload.errors[0];
        throw new ProviderError(`GraphQL provider error for ${url}: ${String(first?.message || 'unknown error')}`, {
          status: response.status, url, contentType, errors: payload.errors, code: 'GRAPHQL_ERROR',
        });
      }
      if (responseKind === 'json-metadata') {
        return {
          data: payload,
          status: response.status,
          headers: {
            link: metadataHeaderOf(response, 'link', 16_384),
            etag: metadataHeaderOf(response, 'etag', 512),
            lastModified: metadataHeaderOf(response, 'last-modified', 128),
          },
        };
      }
      return payload;
    } catch (error) {
      const wrapped = timedOut
        ? new HttpError(`Timed out after ${timeoutMs} ms for ${url}`, {
          status: 0, url, code: 'TIMEOUT', cause: error,
        })
        : error;
      if (options.signal?.aborted) throw makeAbortError(options.signal.reason);
      if (attempt >= retries || !isRetryable(wrapped)) throw wrapped;
      const retryDelay = Number.isFinite(wrapped?.retryAfterMs)
        ? wrapped.retryAfterMs
        : Math.min(MAX_RETRY_AFTER_MS, retryBaseMs * (2 ** attempt));
      const sleep = options.sleep || ((ms, signal) => wait(
        ms, signal, options.setTimer || setTimeout, options.clearTimer || clearTimeout,
      ));
      await sleep(retryDelay, options.signal);
    } finally {
      if (timeoutHandle != null) (options.clearTimer || clearTimeout)(timeoutHandle);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw new HttpError(`Request failed for ${url}`, { url });
}

export function getJson(url, options = {}) {
  return request(url, { ...options, method: 'GET' }, 'json');
}

/**
 * Strict JSON request plus the small, explicit metadata subset needed by
 * cursor-based providers. Raw response headers are intentionally not exposed.
 */
export function getJsonWithMetadata(url, options = {}) {
  return request(url, { ...options, method: 'GET' }, 'json-metadata');
}

export function getText(url, options = {}) {
  return request(url, {
    ...options,
    method: 'GET',
    headers: { Accept: 'text/plain, application/xml, text/xml, */*', ...(options.headers || {}) },
  }, 'text');
}

export function postJson(url, value, options = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  return request(url, {
    ...options,
    method: 'POST',
    headers,
    body: JSON.stringify(value),
  }, 'json');
}

export async function postSilent(url, options = {}) {
  try {
    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    const init = { method: 'POST', headers };
    if (options.body !== undefined) init.body = options.body;
    await globalThis.fetch(rewriteForProxy(url) || url, init);
  } catch (_error) {
    /* ignore fire-and-forget failures */
  }
}
