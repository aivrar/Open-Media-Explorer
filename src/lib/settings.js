/**
 * Settings modal. Mounted on demand.
 */

import {
  getState, saveSettings, setShowExplicitContent, setSourceEnabled, clearCache, subscribe,
} from './state.js';
import { SOURCES } from './sources.js';
import { openDownloadsFolder } from './download-client.js';
import { THEME_OPTIONS } from './themes.js';
import { saveProfileHandoff } from './profile-transfer.js';
import {
  FFMPEG_APPROX_SIZE,
  FFMPEG_PROVIDER,
  FFMPEG_VERSION_FAMILY,
  cancelFfmpegInstall,
  getFfmpegStatus,
  getRuntimeStatus,
  removeManagedFfmpeg,
  repairFfmpeg,
  saveServerPort,
  startFfmpegInstall,
} from './ffmpeg-client.js';

const VERSION = '0.1.2';

function buildModal() {
  const state = getState();
  const previousFocus = document.activeElement;

  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.dataset.settingsModal = 'true';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
      <div class="modal-header">
        <div><h2 id="settings-title">Settings</h2><span id="settings-description" class="sr-only">World Media preferences, capture storage, and recording tools.</span></div>
        <button class="icon-btn" type="button" data-act="close" aria-label="Close Settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <section>
          <h3>Appearance</h3>
          <div class="row">
            <div>
              <label for="settings-theme">Theme</label>
              <span class="description">Updates immediately. System follows Windows dark/light mode.</span>
            </div>
            <select id="settings-theme" data-field="theme">
              ${THEME_OPTIONS.map(({ id, label }) => `<option value="${id}">${label}</option>`).join('')}
            </select>
          </div>
          <div class="row">
            <div>
              <label for="settings-default-mode">Default mode on launch</label>
              <span class="description">Which screen World Media opens to.</span>
            </div>
            <select id="settings-default-mode" data-field="defaultMode">
              <option value="library">Library</option>
              <option value="tuner">Tuner</option>
              <option value="grid">Grid</option>
              <option value="discovery">Discovery</option>
            </select>
          </div>
        </section>
        <section data-content-settings>
          <h3>Content</h3>
          <div class="row">
            <div>
              <label for="settings-show-explicit">Show explicit/NSFW content</label>
              <span class="description">Off by default. Marked items stay hidden until you deliberately enable this setting.</span>
            </div>
            <input id="settings-show-explicit" type="checkbox" class="switch" data-field="showExplicitContent" />
          </div>
        </section>
        <section data-server-settings>
          <h3>Local server</h3>
          <div class="row">
            <div>
              <label for="settings-server-port">Local port</label>
              <span class="description">Used only by World Media's localhost server. Your profile follows a saved port change; common development ports are avoided by default.</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
              <input id="settings-server-port" type="number" min="1024" max="65535" step="1" inputmode="numeric" aria-describedby="settings-server-port-status" />
              <button class="btn" type="button" data-act="save-server-port">Save for next launch</button>
            </div>
          </div>
          <p id="settings-server-port-status" class="description" data-server-port-status role="status" aria-live="polite">Checking current port…</p>
        </section>
        <section data-capture-settings>
          <h3>Capture &amp; storage</h3>
          <p class="tool-disclosure">
            Finite originals download beside the app. Live recording uses a separate upstream connection;
            turn Recorder off to reserve network and CPU for smoother playback. The EQ curve active when a
            recording starts is baked into its audio. Stop recording finalizes MP3 audio or H.264/AAC MP4 video.
            A read-only portable folder disables media downloads; choose LocalAppData explicitly for managed
            FFmpeg tools. Capture only content you have permission to save.
          </p>
          <div class="row">
            <div>
              <label for="settings-recording-enabled">Recorder</label>
              <span class="description">Turn off to prevent new recordings and stop an active recording, giving playback more bandwidth and CPU while recording would otherwise be active. An idle recorder uses essentially none. Downloads remain available.</span>
            </div>
            <input id="settings-recording-enabled" type="checkbox" class="switch" data-field="recordingEnabled" />
          </div>
          <div class="row">
            <div>
              <label for="recording-quality">Recording quality</label>
              <span class="description">Applies immediately to the next audio or video recording.</span>
            </div>
            <select id="recording-quality" data-field="recordingQuality">
              <option value="compact">Compact — 96 kbps / 480p</option>
              <option value="balanced">Balanced — 160 kbps / 720p</option>
              <option value="high">High — 256 kbps / 1080p</option>
            </select>
          </div>
          <div class="runtime-card" data-runtime-card aria-live="polite">
            <div class="runtime-path"><span>Portable root</span><code data-runtime-portable>Checking…</code></div>
            <div class="runtime-path"><span>Downloads</span><code data-runtime-downloads>Checking…</code></div>
            <div class="runtime-path"><span>FFmpeg tools</span><code data-runtime-tools>Checking…</code></div>
            <div class="runtime-card-footer">
              <span class="tool-status" data-runtime-writable>Checking writability</span>
              <button class="btn" type="button" data-act="open-downloads">Open downloads</button>
            </div>
          </div>
        </section>
        <section data-ffmpeg-section>
          <h3>Recording tools</h3>
          <div class="tool-card">
            <div class="tool-card-head">
              <div>
                <label>FFmpeg</label>
                <span class="description" data-ffmpeg-summary>Checking for a capable installation...</span>
              </div>
              <span class="tool-status" data-ffmpeg-state role="status" aria-live="polite">Checking</span>
            </div>
            <div class="tool-detail" data-ffmpeg-detail></div>
            <div class="tool-progress" data-ffmpeg-progress hidden>
              <span data-ffmpeg-progress-bar></span>
            </div>
            <p class="tool-disclosure">
              Managed install: <strong>${FFMPEG_VERSION_FAMILY}</strong> from
              <a href="https://github.com/${FFMPEG_PROVIDER}" target="_blank" rel="noreferrer">${FFMPEG_PROVIDER}</a>
              (${FFMPEG_APPROX_SIZE}). This GPL build is downloaded only after confirmation, verified against
              GitHub's SHA-256 digest, and includes its license and source record.
              <a href="https://ffmpeg.org/legal.html" target="_blank" rel="noreferrer">FFmpeg legal information</a>.
            </p>
            <div class="tool-actions">
              <select data-ffmpeg-destination aria-label="FFmpeg installation destination">
                <option value="portable">Portable - next to this app</option>
                <option value="LocalAppData">LocalAppData - per-user fallback</option>
              </select>
              <button class="btn btn-primary" type="button" data-act="ffmpeg-install">Install managed copy</button>
              <button class="btn" type="button" data-act="ffmpeg-repair" hidden>Repair</button>
              <button class="btn" type="button" data-act="ffmpeg-cancel" hidden>Cancel</button>
              <button class="btn btn-danger" type="button" data-act="ffmpeg-remove" hidden>Remove managed copy</button>
            </div>
            <span class="description" data-ffmpeg-destination-note></span>
          </div>
        </section>
        <section>
          <h3>Sources</h3>
          ${SOURCES.map((s) => `
            <div class="row">
              <div>
                <label for="src-${s.id}">${s.displayName}</label>
                <span class="description">${s.description} ${s.capabilities.join(' · ')}.</span>
              </div>
              <input id="src-${s.id}" type="checkbox" class="switch" data-source="${s.id}" />
            </div>
          `).join('')}
        </section>
        <section>
          <h3>Storage</h3>
          <div class="row">
            <div>
              <label>Clear local cache</label>
              <span class="description">Removes favorites, preferences, equalizer settings, and job history. Downloaded media and FFmpeg tools are kept.</span>
            </div>
            <button class="btn btn-danger" type="button" data-act="clear-cache">Clear cache</button>
          </div>
        </section>
        <section>
          <h3>About</h3>
          <div style="font-size: 13px; color: var(--text-dim); line-height: 1.55;">
            <p style="margin: 0 0 8px;"><strong style="color: var(--text);">World Media</strong> v${VERSION} — A unified player for free, open media.</p>
            <p style="margin: 0 0 8px;">Built with sincere thanks to the open archives and directories whose data this app surfaces:</p>
            <ul style="margin: 0 0 8px 18px; padding: 0; color: var(--text-dim);">
              ${SOURCES.map((source) => `<li>${source.displayName} — ${source.description}</li>`).join('')}
            </ul>
            <p style="margin: 0;">No accounts. No telemetry. No API keys. App and third-party license notices are available in About and the packaged localhost runtime.</p>
          </div>
        </section>
      </div>
    </div>
  `;

  // Initialize current values
  const themeSel = root.querySelector('select[data-field="theme"]');
  themeSel.value = state.settings.theme;
  themeSel.addEventListener('change', () => saveSettings({ theme: themeSel.value }));

  const modeSel = root.querySelector('select[data-field="defaultMode"]');
  modeSel.value = state.settings.defaultMode;
  modeSel.addEventListener('change', () => saveSettings({ defaultMode: modeSel.value }));

  const explicitToggle = root.querySelector('input[data-field="showExplicitContent"]');
  explicitToggle.checked = state.settings.showExplicitContent === true;
  explicitToggle.addEventListener('change', () => setShowExplicitContent(explicitToggle.checked));

  const recorderToggle = root.querySelector('input[data-field="recordingEnabled"]');
  recorderToggle.checked = state.settings.recordingEnabled !== false;

  const qualitySel = root.querySelector('select[data-field="recordingQuality"]');
  qualitySel.value = state.settings.recordingQuality;
  qualitySel.disabled = !recorderToggle.checked;
  recorderToggle.addEventListener('change', () => {
    qualitySel.disabled = !recorderToggle.checked;
    saveSettings({ recordingEnabled: recorderToggle.checked });
  });
  qualitySel.addEventListener('change', () => saveSettings({ recordingQuality: qualitySel.value }));

  for (const cb of root.querySelectorAll('input[data-source]')) {
    cb.checked = state.settings.enabledSources[cb.dataset.source] !== false;
    cb.addEventListener('change', () => setSourceEnabled(cb.dataset.source, cb.checked));
  }

  const destination = root.querySelector('[data-ffmpeg-destination]');
  const summary = root.querySelector('[data-ffmpeg-summary]');
  const stateLabel = root.querySelector('[data-ffmpeg-state]');
  const detail = root.querySelector('[data-ffmpeg-detail]');
  const progress = root.querySelector('[data-ffmpeg-progress]');
  const progressBar = root.querySelector('[data-ffmpeg-progress-bar]');
  const installButton = root.querySelector('[data-act="ffmpeg-install"]');
  const repairButton = root.querySelector('[data-act="ffmpeg-repair"]');
  const cancelButton = root.querySelector('[data-act="ffmpeg-cancel"]');
  const removeButton = root.querySelector('[data-act="ffmpeg-remove"]');
  const destinationNote = root.querySelector('[data-ffmpeg-destination-note]');
  const runtimePortable = root.querySelector('[data-runtime-portable]');
  const runtimeDownloads = root.querySelector('[data-runtime-downloads]');
  const runtimeTools = root.querySelector('[data-runtime-tools]');
  const runtimeWritable = root.querySelector('[data-runtime-writable]');
  const openDownloads = root.querySelector('[data-act="open-downloads"]');
  const serverPortInput = root.querySelector('#settings-server-port');
  const saveServerPortButton = root.querySelector('[data-act="save-server-port"]');
  const serverPortStatus = root.querySelector('[data-server-port-status]');
  let ffmpegTimer = 0;
  let lastToolStatus = null;
  let disposed = false;

  function selectedDestination() { return destination.value; }

  function confirmationText(action) {
    const location = selectedDestination() === 'portable'
      ? 'the tools folder next to World Media'
      : 'your LocalAppData WorldMediaWindows tools folder';
    return `${action} ${FFMPEG_VERSION_FAMILY} from ${FFMPEG_PROVIDER}?\n\n`
      + `Download size: ${FFMPEG_APPROX_SIZE}.\nDestination: ${location}.\n`
      + 'License: GPL. The archive SHA-256 digest, required recording capabilities, and included license are verified before activation.';
  }

  function renderToolStatus(status) {
    if (disposed) return;
    lastToolStatus = status;
    const installing = status.state === 'installing';
    const nextStateLabel = status.state.charAt(0).toUpperCase() + status.state.slice(1);
    if (stateLabel.textContent !== nextStateLabel) stateLabel.textContent = nextStateLabel;
    stateLabel.dataset.state = status.state;
    summary.textContent = status.state === 'ready'
      ? `${status.source} toolchain is ready for recording.`
      : (status.actionable_reason || status.error?.message || 'A capable FFmpeg toolchain is not available.');
    detail.textContent = [status.version, status.ffmpeg_path].filter(Boolean).join(' | ');
    progress.hidden = !installing;
    progressBar.style.width = `${Math.round((status.progress || 0) * 100)}%`;
    installButton.disabled = installing;
    destination.disabled = installing;
    repairButton.hidden = installing || !['error', 'cancelled'].includes(status.state);
    cancelButton.hidden = !installing;
    removeButton.hidden = !(status.managed && ['portable', 'LocalAppData'].includes(status.source)) || installing;
    if (installing) scheduleToolRefresh();
  }

  function renderToolError(error) {
    if (disposed) return;
    stateLabel.textContent = 'Unavailable';
    stateLabel.dataset.state = 'error';
    summary.textContent = error?.message || 'FFmpeg status could not be checked.';
  }

  async function refreshToolStatus() {
    window.clearTimeout(ffmpegTimer);
    try {
      const status = await getFfmpegStatus();
      if (!disposed) renderToolStatus(status);
    } catch (error) {
      if (!disposed) renderToolError(error);
    }
  }

  function scheduleToolRefresh() {
    window.clearTimeout(ffmpegTimer);
    if (!disposed) ffmpegTimer = window.setTimeout(refreshToolStatus, 750);
  }

  async function runToolAction(action) {
    for (const button of [installButton, repairButton, cancelButton, removeButton]) button.disabled = true;
    try {
      const status = await action();
      if (!disposed) renderToolStatus(status);
    } catch (error) {
      if (!disposed) renderToolError(error);
    } finally {
      if (disposed) return;
      const installing = lastToolStatus?.state === 'installing';
      installButton.disabled = installing;
      destination.disabled = installing;
      repairButton.disabled = false;
      cancelButton.disabled = false;
      removeButton.disabled = false;
    }
  }

  installButton.addEventListener('click', () => {
    if (confirm(confirmationText('Install'))) {
      runToolAction(() => startFfmpegInstall(selectedDestination()));
    }
  });
  repairButton.addEventListener('click', () => {
    if (confirm(confirmationText('Repair'))) {
      runToolAction(() => repairFfmpeg(selectedDestination()));
    }
  });
  cancelButton.addEventListener('click', () => runToolAction(() => cancelFfmpegInstall()));
  removeButton.addEventListener('click', () => {
    const source = lastToolStatus?.source;
    if (['portable', 'LocalAppData'].includes(source)
        && confirm(`Remove only the managed FFmpeg copy from ${source}?`)) {
      destination.value = source;
      runToolAction(() => removeManagedFfmpeg(source));
    }
  });

  saveServerPortButton.addEventListener('click', async () => {
    const requested = Number(serverPortInput.value);
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
      serverPortStatus.textContent = 'Enter a whole port number from 1024 through 65535.';
      serverPortStatus.dataset.state = 'error';
      serverPortInput.focus();
      return;
    }
    saveServerPortButton.disabled = true;
    serverPortStatus.textContent = 'Saving your profile and local server port…';
    serverPortStatus.dataset.state = 'checking';
    try {
      await saveProfileHandoff();
      const saved = await saveServerPort(requested);
      const nextPort = Number(saved?.next_launch_port);
      serverPortInput.value = Number.isInteger(nextPort) ? String(nextPort) : String(requested);
      serverPortStatus.textContent = `Saved port ${serverPortInput.value}. Restart World Media to use it.`;
      serverPortStatus.dataset.state = 'ready';
    } catch (error) {
      serverPortStatus.textContent = error?.message || 'Local server port could not be saved.';
      serverPortStatus.dataset.state = 'error';
    } finally {
      if (!disposed) saveServerPortButton.disabled = false;
    }
  });

  getRuntimeStatus().then((runtime) => {
    if (disposed) return;
    runtimePortable.textContent = runtime.portable_root;
    runtimeDownloads.textContent = runtime.downloads_root;
    runtimeTools.textContent = runtime.tools_root;
    runtimeWritable.textContent = runtime.portable_writable ? 'Portable writable' : 'Portable read-only';
    runtimeWritable.dataset.state = runtime.portable_writable ? 'ready' : 'error';
    const activePort = Number.isInteger(runtime.server_port) ? runtime.server_port : null;
    const nextPort = Number.isInteger(runtime.next_launch_port) ? runtime.next_launch_port : null;
    if (nextPort) serverPortInput.value = String(nextPort);
    if (activePort && nextPort) {
      serverPortStatus.textContent = activePort === nextPort
        ? `Using local port ${activePort}.`
        : `Using local port ${activePort}; port ${nextPort} is saved for next launch.`;
      serverPortStatus.dataset.state = 'ready';
    } else {
      serverPortStatus.textContent = 'Local server port unavailable.';
      serverPortStatus.dataset.state = 'error';
    }
    if (!runtime.portable_writable) {
      destination.value = 'LocalAppData';
      destinationNote.textContent = 'The portable location is not writable; LocalAppData is selected explicitly.';
    } else {
      destinationNote.textContent = 'Portable is writable. You may explicitly choose LocalAppData instead.';
    }
  }).catch(() => {
    if (disposed) return;
    runtimePortable.textContent = 'Unavailable';
    runtimeDownloads.textContent = 'Unavailable';
    runtimeTools.textContent = 'Unavailable';
    runtimeWritable.textContent = 'Runtime status unavailable';
    runtimeWritable.dataset.state = 'error';
    destinationNote.textContent = 'Choose a destination; writability is verified before download.';
    serverPortStatus.textContent = 'Local server port unavailable.';
    serverPortStatus.dataset.state = 'error';
  });
  openDownloads.addEventListener('click', async () => {
    openDownloads.disabled = true;
    try {
      await openDownloadsFolder();
      if (disposed) return;
      runtimeWritable.textContent = 'Downloads folder opened';
      runtimeWritable.dataset.state = 'ready';
    } catch (error) {
      if (disposed) return;
      runtimeWritable.textContent = error?.message || 'Downloads folder could not be opened';
      runtimeWritable.dataset.state = 'error';
    } finally {
      if (!disposed) openDownloads.disabled = false;
    }
  });
  refreshToolStatus();

  root.querySelector('[data-act="clear-cache"]').addEventListener('click', () => {
    if (confirm('Clear favorites, preferences, equalizer settings, and job history? Downloaded media and FFmpeg tools will be kept.')) {
      clearCache();
      close();
    }
  });

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll(
      'button:not([disabled]):not([hidden]), select:not([disabled]), input:not([disabled]), a[href]',
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  function close() {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(ffmpegTimer);
    const app = document.getElementById('app');
    if (app) app.inert = false;
    root.remove();
    document.removeEventListener('keydown', onKeyDown);
    if (previousFocus?.focus) previousFocus.focus();
  }
  root.querySelector('[data-act="close"]').addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', onKeyDown);
  root._activate = () => {
    const app = document.getElementById('app');
    if (app) app.inert = true;
    const target = root.querySelector('[data-act="close"]');
    target?.focus();
  };

  return root;
}

export function openSettings() {
  const host = document.getElementById('modal-host') || document.body;
  const existing = host.querySelector?.('[data-settings-modal]');
  if (existing) {
    existing.querySelector?.('[data-act="close"]')?.focus();
    return;
  }
  const modal = buildModal();
  host.appendChild(modal);
  modal._activate?.();
}

export function initSettings() {
  // Listen for settings-driven changes that affect global UI
  subscribe('settings-change', (settings) => {
    // No-op for now; modes re-read on next render.
  });
}
