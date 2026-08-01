/**
 * Clean shutdown for the Windows-native app.
 *
 * POST /api/shutdown asks the local Python process to exit. The WebView closes
 * with that process; window.close() is only a final browser-preview fallback.
 */

import { controlRequest, resetControlSession } from './capture-client.js';
import { flushEqPersistence } from './eq-overlay.js';

let shuttingDown = false;

async function postShutdown(fetchImpl) {
  const signal = globalThis.AbortSignal?.timeout
    ? globalThis.AbortSignal.timeout(5000)
    : undefined;
  const options = { method: 'POST', body: {}, fetchImpl, signal };
  try {
    await controlRequest('/api/shutdown', options);
  } catch (error) {
    // A WebView can retain the previous local control token across a fast
    // backend restart. Recover within the same click instead of making the
    // user discover that a second click is required.
    if (error?.status !== 403 || error?.code !== 'INVALID_TOKEN') throw error;
    resetControlSession();
    await controlRequest('/api/shutdown', options);
  }
  return true;
}

function closeWindow() {
  if (typeof globalThis.window?.closeApp === 'function') {
    try { globalThis.window.closeApp(); return true; } catch (_) {}
  }
  try { globalThis.window?.close(); } catch (_) {}
  return false;
}

function renderGoodbye() {
  const host = document.getElementById('view-host');
  if (host) {
    host.innerHTML = `
      <div class="boot-state" style="gap:18px;">
        <div class="boot-spinner" aria-hidden="true"></div>
        <p style="font-size:14px;">Shutting down World Media...</p>
        <p style="font-size:12px;color:var(--text-mute);max-width:340px;text-align:center;">
          If this window stays open, close it from the title bar. The local
          server has already been asked to stop.
        </p>
      </div>
    `;
  }
  for (const id of ['audio-el', 'video-el']) {
    const el = document.getElementById(id);
    if (el) {
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) {}
    }
  }
  for (const el of document.querySelectorAll('.topbar button, .topbar select')) {
    el.disabled = true;
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.5';
  }
}

export async function requestShutdown({
  fetchImpl = fetch,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  closeImpl = closeWindow,
  flushEqImpl = flushEqPersistence,
} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  // localStorage is synchronous. Commit any edit that is still inside the EQ
  // debounce window before the backend is allowed to tear down the WebView.
  try { flushEqImpl(); } catch (_) {}
  const button = document.getElementById('shutdown-btn');
  if (button) {
    button.disabled = true;
    button.textContent = 'Shutting down…';
    button.setAttribute('aria-label', 'Shutting down World Media');
  }
  try {
    await postShutdown(fetchImpl);
    renderGoodbye();
    await delayImpl(250);
    closeImpl();
  } catch (error) {
    shuttingDown = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Retry shutdown';
      const message = error?.message || 'The local service could not shut down safely.';
      button.title = `${message} Try again.`;
      button.setAttribute('aria-label', `Retry shutdown. ${message}`);
    }
  }
}

export function initShutdownButton() {
  const btn = document.getElementById('shutdown-btn');
  if (!btn) return;
  if (btn.dataset.shutdownBound === 'true') return;
  btn.dataset.shutdownBound = 'true';
  btn.addEventListener('click', () => requestShutdown());
  // Pointer-up gives the native WebView a second, independent activation
  // path. The in-flight guard in requestShutdown prevents a following click
  // event from issuing a duplicate request.
  btn.addEventListener('pointerup', (event) => {
    if (event.button == null || event.button === 0) requestShutdown();
  });
  if (document.documentElement?.dataset.shutdownShortcutBound === 'true') return;
  if (document.documentElement?.dataset) {
    document.documentElement.dataset.shutdownShortcutBound = 'true';
  }
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'q' || e.key === 'Q')) {
      e.preventDefault();
      requestShutdown();
    }
  });
}
