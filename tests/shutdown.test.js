import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement, FakeMediaElement, createFakeDocument } from './helpers/fake-dom.js';
import { resetControlSession } from '../src/lib/capture-client.js';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function shutdownDom() {
  const button = new FakeElement('shutdown-btn', 'button');
  const host = new FakeElement('view-host');
  const audio = new FakeMediaElement('audio-el', 'audio');
  const video = new FakeMediaElement('video-el', 'video');
  const document = createFakeDocument([button, host, audio, video]);
  document.querySelectorAll = () => [button];
  return { button, host, audio, video, document };
}

test('Shutdown uses authenticated JSON control and closes only after backend acceptance', async () => {
  resetControlSession();
  const previousDocument = globalThis.document;
  const { button, host, document } = shutdownDom();
  globalThis.document = document;
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') {
      return response(200, { ok: true, data: { token: 'shutdown-token' }, error: null });
    }
    return response(202, { ok: true, data: { shutdown: 'in_progress' }, error: null });
  };
  let closed = 0;
  const order = [];
  try {
    const shutdown = await import(`../src/lib/shutdown.js?accepted=${Date.now()}`);
    await shutdown.requestShutdown({
      fetchImpl: async (...args) => { order.push(`fetch:${args[0]}`); return fetchImpl(...args); },
      delayImpl: async () => {},
      closeImpl: () => { closed++; },
      flushEqImpl: () => order.push('flush-eq'),
    });
    assert.deepEqual(order.slice(0, 2), ['flush-eq', 'fetch:/api/v1/session']);
    assert.deepEqual(calls.map((call) => call.path), ['/api/v1/session', '/api/shutdown']);
    assert.ok(calls[0].options.signal, 'session acquisition must share the shutdown timeout');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.signal, calls[0].options.signal);
    assert.equal(calls[1].options.headers['X-WorldMedia-Token'], 'shutdown-token');
    assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[1].options.body, '{}');
    assert.equal(closed, 1);
    assert.match(host.innerHTML, /Shutting down World Media/);
    assert.equal(button.disabled, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('Rejected shutdown keeps the app open and exposes a retry action', async () => {
  resetControlSession();
  const previousDocument = globalThis.document;
  const { button, host, document } = shutdownDom();
  globalThis.document = document;
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') {
      return response(200, { ok: true, data: { token: 'shutdown-token' }, error: null });
    }
    return response(503, {
      ok: false, data: null,
      error: { code: 'SHUTDOWN_INCOMPLETE', message: 'Recording is still finalizing.', retryable: true },
    });
  };
  let closed = 0;
  try {
    const shutdown = await import(`../src/lib/shutdown.js?rejected=${Date.now()}`);
    await shutdown.requestShutdown({ fetchImpl, delayImpl: async () => {}, closeImpl: () => { closed++; } });
    assert.equal(closed, 0);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Retry shutdown');
    assert.match(button.title, /Recording is still finalizing/);
    assert.equal(host.innerHTML || '', '');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('Shutdown refreshes a stale control session within the same click', async () => {
  resetControlSession();
  const previousDocument = globalThis.document;
  const { document } = shutdownDom();
  globalThis.document = document;
  const calls = [];
  let sessionNumber = 0;
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') {
      sessionNumber++;
      return response(200, {
        ok: true, data: { token: `shutdown-token-${sessionNumber}` }, error: null,
      });
    }
    if (options.headers['X-WorldMedia-Token'] === 'shutdown-token-1') {
      return response(403, {
        ok: false, data: null,
        error: { code: 'INVALID_TOKEN', message: 'The control token expired.', retryable: true },
      });
    }
    return response(202, { ok: true, data: { shutdown: 'in_progress' }, error: null });
  };
  let closed = 0;
  try {
    const shutdown = await import(`../src/lib/shutdown.js?stale=${Date.now()}`);
    await shutdown.requestShutdown({ fetchImpl, delayImpl: async () => {}, closeImpl: () => { closed++; } });
    assert.deepEqual(calls.map((call) => call.path), [
      '/api/v1/session', '/api/shutdown', '/api/v1/session', '/api/shutdown',
    ]);
    assert.equal(calls[3].options.headers['X-WorldMedia-Token'], 'shutdown-token-2');
    assert.equal(closed, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('Shutdown button binding is idempotent and supports native pointer activation', async () => {
  resetControlSession();
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const { button, document } = shutdownDom();
  document.documentElement = new FakeElement('document-root', 'html');
  globalThis.document = document;
  let shutdownPosts = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/v1/session') {
      return response(200, { ok: true, data: { token: 'pointer-token' }, error: null });
    }
    shutdownPosts++;
    return response(202, { ok: true, data: { shutdown: 'in_progress' }, error: null });
  };
  try {
    const shutdown = await import(`../src/lib/shutdown.js?binding=${Date.now()}`);
    shutdown.initShutdownButton();
    shutdown.initShutdownButton();
    const secondaryPointer = new Event('pointerup');
    Object.defineProperty(secondaryPointer, 'button', { value: 2 });
    button.dispatchEvent(secondaryPointer);
    button.dispatchEvent(new Event('pointerup'));
    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shutdownPosts, 1, 'pointerup plus click and duplicate initialization must issue one request');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
  }
});
