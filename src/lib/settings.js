/**
 * Settings modal. Mounted on demand.
 */

import {
  getState, saveSettings, setShowExplicitContent, setSourceEnabled, clearCache, subscribe,
  NOW_PLAYING_BACKGROUND_BLUR_LABELS,
} from './state.js';
import { SOURCES } from './sources.js';
import { openDownloadsFolder } from './download-client.js';
import { THEME_OPTIONS } from './themes.js';
import { saveProfileHandoff, suspendProfileRetries } from './profile-transfer.js';
import { bindBackupControls } from './backup.js';
import { STATION_IMAGES_HINT, bindStationImageControls } from './station-images.js';
import { getPlaylistItems, playlistsLoaded } from './playlists.js';
import { TUNER_CARD_SIZES, TUNER_CARD_SIZE_LABELS, normalizeTunerCardSize } from './tuner-card-size.js';
import { TOP_TABS, isTabShown } from './top-tabs.js';
import { TUNER_BACKGROUND_RELEASED, TUNER_BACKGROUND_TEXT } from './tuner-background.js';
import { BEST_STREAM_MODES, BEST_STREAM_MODE_LABELS, bestStreamMode } from './best-stream.js';
import {
  PROCESSOR_LIMIT_MAX, PROCESSOR_LIMIT_MIN, PROCESSOR_LIMIT_STEP, PROCESSOR_USE_LABELS, PROCESSOR_USE_LEVELS,
  normalizeProcessorLimit, normalizeProcessorUse, processorBudget,
} from './processor-budget.js';
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

const BEST_STREAM_DESCRIPTIONS = {
  listed: 'starts with the best listed stream and tries the next if it fails or is slow to start.',
  auto: 'does the same and looks for a better stream in other radio directory entries. It can use one on a later start if both streams match on two different songs.',
  off: 'tries the first two listed streams together and plays whichever answers first.',
};

const VERSION = '0.1.18';

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
              <span class="description">If the chosen tab is hidden, World Media opens Library.</span>
            </div>
            <select id="settings-default-mode" data-field="defaultMode">
              <option value="library">Library</option>
              <option value="tuner">Tuner</option>
              <option value="grid">Grid</option>
              <option value="discovery">Discovery</option>
            </select>
          </div>
          <div class="row">
            <div>
              <label for="settings-tuner-card-size">Tuner card size</label>
              <span class="description">The rows of the Tuner's station list. Medium and Large show bigger names and each station's picture. Updates immediately.</span>
            </div>
            <select id="settings-tuner-card-size" data-field="tunerCardSize">
              ${TUNER_CARD_SIZES.map((id) => `<option value="${id}">${TUNER_CARD_SIZE_LABELS[id]}</option>`).join('')}
            </select>
          </div>
          ${TUNER_BACKGROUND_RELEASED ? `<div class="row">
            <div>
              <label for="settings-tuner-visualizer">${TUNER_BACKGROUND_TEXT.label}</label>
              <span class="description">${TUNER_BACKGROUND_TEXT.description}</span>
            </div>
            <input id="settings-tuner-visualizer" type="checkbox" class="switch" data-field="tunerVisualizerBackground" />
          </div>` : ''}
          <div class="row">
            <label for="settings-now-playing-background-blur">Now Playing background blur</label>
            <select id="settings-now-playing-background-blur" data-field="nowPlayingBackgroundBlur">
              ${Object.entries(NOW_PLAYING_BACKGROUND_BLUR_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
            </select>
          </div>
          <div class="row">
            <div>
              <label for="settings-sound-meter">Sound meter in the player bar</label>
              <span class="description">Small bars beside EQ that move with the sound, so you can see a station is really playing. They rest while nothing plays. Updates immediately.</span>
            </div>
            <input id="settings-sound-meter" type="checkbox" class="switch" data-field="soundMeter" />
          </div>
          <div class="row">
            <div>
              <label for="settings-tech-details">Show technical source details</label>
              <span class="description">Shows per-source status labels (Pull, Wait, Done, Live, Stale), boxed source names and license notes, and on station cards the stream format and bitrate (such as MP3 · 128 kbps) once a station has played or its directory lists them. Off keeps the screen simpler; a source's status and a station's format and bitrate still show on hover.</span>
            </div>
            <input id="settings-tech-details" type="checkbox" class="switch" data-field="showTechnicalDetails" />
          </div>
          <fieldset class="settings-tabs-shown">
            <legend>Tabs shown</legend>
            ${Object.entries(TOP_TABS).map(([mode, label]) => `
              <div class="row">
                <label for="settings-tab-${mode}">${label}</label>
                <input id="settings-tab-${mode}" type="checkbox" role="switch" class="switch" data-show-tab="${mode}"${mode === 'library' ? ' disabled' : ''} />
              </div>
            `).join('')}
          </fieldset>
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
          <div class="row">
            <div>
              <label for="settings-best-stream">Pick the best stream</label>
              <div class="description" id="settings-best-stream-hint">
                When a station or channel lists several streams:
                <ul>
                  ${BEST_STREAM_MODES.map((id) => `<li><strong>${BEST_STREAM_MODE_LABELS[id]}</strong>: ${BEST_STREAM_DESCRIPTIONS[id]}</li>`).join('')}
                </ul>
              </div>
            </div>
            <select id="settings-best-stream" data-field="bestStreamMode" aria-describedby="settings-best-stream-hint">
              ${BEST_STREAM_MODES.map((id) => `<option value="${id}">${BEST_STREAM_MODE_LABELS[id]}</option>`).join('')}
            </select>
          </div>
        </section>
        <section data-processor-settings>
          <h3>Processor use</h3>
          <div class="row">
            <div>
              <label for="settings-processor-use">Processor use</label>
              <span class="description" id="settings-processor-use-hint">${PROCESSOR_USE_HINT}
                <a href="#about-processor-use" data-act="processor-about">What this means</a></span>
            </div>
            <select id="settings-processor-use" data-field="processorUse" aria-describedby="settings-processor-use-hint">
              ${PROCESSOR_USE_LEVELS.map((id) => `<option value="${id}">${PROCESSOR_USE_LABELS[id]}</option>`).join('')}
            </select>
          </div>
          <div class="row">
            <div>
              <label for="settings-processor-limit">Limit (% of the whole processor)</label>
              <span class="processor-limit-hints" data-processor-limit-hints><span class="description" id="settings-processor-limit-hint" data-processor-limit-hint></span><span class="description processor-limit-note" role="status" data-processor-limit-note></span></span>
            </div>
            <input id="settings-processor-limit" type="number" data-field="processorLimit" aria-describedby="settings-processor-limit-hint"
              min="${PROCESSOR_LIMIT_MIN}" max="${PROCESSOR_LIMIT_MAX}" step="${PROCESSOR_LIMIT_STEP}" inputmode="numeric" />
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
            turn Recorder off to reserve network and processor for smoother playback. The EQ curve active when a
            recording starts is baked into its audio. Stop recording finalizes MP3 audio or H.264/AAC MP4 video.
            A read-only portable folder disables media downloads; choose LocalAppData explicitly for managed
            FFmpeg tools. Capture only content you have permission to save.
          </p>
          <div class="row">
            <div>
              <label for="settings-recording-enabled">Recorder</label>
              <span class="description">Turn off to prevent new recordings and stop an active recording, giving playback more bandwidth and processor while recording would otherwise be active. An idle recorder uses essentially none. Downloads remain available.</span>
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
          <div class="row backup-row">
            <div>
              <label>Back up my data</label>
              <span id="settings-backup-note" class="description">Saves a .zip in the downloads folder with a copy of your favorites, settings, equalizer curves, song log and imported playlists, plus .m3u8 playlist files that other players can open. Playlist addresses can contain private links or account tokens, so share the backup only with people you trust.</span>
              <span id="settings-backup-status" class="description backup-status" data-backup-status role="status" aria-live="polite"></span>
            </div>
            <div class="backup-actions">
              <button class="btn" type="button" data-act="create-backup" aria-describedby="settings-backup-note settings-backup-status">Back up my data</button>
              <button class="btn" type="button" data-act="backup-open-folder" hidden>Open folder</button>
            </div>
          </div>
          <div class="row backup-row station-images-row" data-station-images>
            <div>
              <label>Station images</label>
              <span id="settings-station-images-note" class="description">${STATION_IMAGES_HINT}</span>
              <span id="settings-station-images-rule" class="description" data-station-images-rule></span>
              <code class="station-images-path" data-station-images-path></code>
              <span id="settings-station-images-status" class="description backup-status" data-station-images-status role="status" aria-live="polite"></span>
              <div class="station-images-problems" data-station-images-problems hidden></div>
            </div>
            <div class="backup-actions">
              <button class="btn" type="button" data-act="station-images-open" aria-describedby="settings-station-images-note">Open folder</button>
              <button class="btn" type="button" data-act="station-images-refresh" aria-describedby="settings-station-images-status">Refresh</button>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Clear local cache</label>
              <span class="description">Removes favorites, stream address edits, preferences, equalizer and picture settings, the song log, starred songs, and job history. My Playlists, downloaded media, and FFmpeg tools are kept.</span>
            </div>
            <button class="btn btn-danger" type="button" data-act="clear-cache">Clear cache</button>
          </div>
          <p class="clear-cache-status" data-clear-cache-status role="status" aria-live="polite" hidden></p>
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

  const cardSizeSel = root.querySelector('select[data-field="tunerCardSize"]');
  cardSizeSel.value = normalizeTunerCardSize(state.settings.tunerCardSize);
  cardSizeSel.addEventListener('change', () => saveSettings({ tunerCardSize: cardSizeSel.value }));

  const tabToggles = root.querySelectorAll('input[data-show-tab]');
  const processorAbout = root.querySelector('[data-act="processor-about"]');
  function syncTabControls(settings) {
    for (const toggle of tabToggles) toggle.checked = isTabShown(toggle.dataset.showTab, settings);
    processorAbout.hidden = !isTabShown('about', settings);
  }
  syncTabControls(state.settings);
  for (const toggle of tabToggles) {
    if (toggle.disabled) continue;
    toggle.addEventListener('change', () => saveSettings({
      tabsShown: { ...getState().settings.tabsShown, [toggle.dataset.showTab]: toggle.checked },
    }));
  }
  const unsubscribeTabControls = subscribe('settings-change', syncTabControls);

  const tunerVisualizerToggle = root.querySelector('input[data-field="tunerVisualizerBackground"]');
  let unsubscribeTunerVisualizer = null;
  if (tunerVisualizerToggle) {
    tunerVisualizerToggle.checked = state.settings.tunerVisualizerBackground === true;
    // On again brings back its last level (tunerVisualizerLevel is kept).
    tunerVisualizerToggle.addEventListener('change', () => saveSettings({ tunerVisualizerBackground: tunerVisualizerToggle.checked }));
    // The Tuner's stepper turns it off at 0 and on from 0: the switch follows.
    unsubscribeTunerVisualizer = subscribe('settings-change', (settings) => {
      tunerVisualizerToggle.checked = settings.tunerVisualizerBackground === true;
    });
  }

  const blurSel = root.querySelector('select[data-field="nowPlayingBackgroundBlur"]');
  blurSel.value = state.settings.nowPlayingBackgroundBlur;
  blurSel.addEventListener('change', () => saveSettings({ nowPlayingBackgroundBlur: blurSel.value }));

  const meterToggle = root.querySelector('input[data-field="soundMeter"]');
  meterToggle.checked = state.settings.soundMeter !== false;
  meterToggle.addEventListener('change', () => saveSettings({ soundMeter: meterToggle.checked }));

  const bestSel = root.querySelector('select[data-field="bestStreamMode"]');
  bestSel.value = bestStreamMode(state.settings);
  bestSel.addEventListener('change', () => saveSettings({ bestStreamMode: bestStreamMode({ bestStreamMode: bestSel.value }) }));

  bindProcessorUse(root, state.settings);

  const techToggle = root.querySelector('input[data-field="showTechnicalDetails"]');
  techToggle.checked = state.settings.showTechnicalDetails === true;
  techToggle.addEventListener('change', () => saveSettings({ showTechnicalDetails: techToggle.checked }));

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
    // No automatic retry starts while the port change writes the profile.
    const resumeRetries = suspendProfileRetries();
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
      resumeRetries();
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
  bindBackupControls({
    button: root.querySelector('[data-act="create-backup"]'),
    status: root.querySelector('[data-backup-status]'),
    openButton: root.querySelector('[data-act="backup-open-folder"]'),
    isDisposed: () => disposed,
  });
  bindStationImageControls({
    path: root.querySelector('[data-station-images-path]'),
    status: root.querySelector('[data-station-images-status]'),
    openButton: root.querySelector('[data-act="station-images-open"]'),
    refreshButton: root.querySelector('[data-act="station-images-refresh"]'),
    rule: root.querySelector('[data-station-images-rule]'),
    problems: root.querySelector('[data-station-images-problems]'),
    // "Matches no station" is only judged once the playlists are known.
    knownTitles: () => (playlistsLoaded()
      ? [...getState().favorites, ...getPlaylistItems()].map((item) => item?.title)
      : null),
    isDisposed: () => disposed,
  });
  refreshToolStatus();

  bindClearCache({
    button: root.querySelector('[data-act="clear-cache"]'),
    status: root.querySelector('[data-clear-cache-status]'),
    confirmClear: () => confirm('Clear favorites, stream address edits, preferences, equalizer and picture settings, the song log, starred songs, and job history? My Playlists, downloaded media, and FFmpeg tools will be kept.'),
    clear: clearCache,
    onDone: () => close(),
    isDisposed: () => disposed,
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
    unsubscribeTunerVisualizer?.();
    unsubscribeTabControls();
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

export const CLEAR_CACHE_FAILED = 'Cleared in this window, but the saved copy in your data folder could not be cleared, so your favorites and settings could come back. Try Clear cache again before closing World Media.';

/**
 * Clear cache waits until the saved copy in the data folder is cleared too
 * (or the request fails or times out) before it reports done by closing
 * Settings; a failure stays visible as one plain line.
 */
export function bindClearCache({ button, status, confirmClear, clear, onDone, isDisposed = () => false }) {
  const label = button.textContent;
  let running = false;
  async function run() {
    if (running || !confirmClear()) return;
    running = true;
    button.disabled = true;
    button.textContent = 'Clearing…';
    status.hidden = true;
    status.textContent = '';
    try {
      await clear();
      if (!isDisposed()) onDone();
    } catch (_) {
      if (isDisposed()) return;
      status.textContent = CLEAR_CACHE_FAILED;
      status.dataset.state = 'error';
      status.hidden = false;
    } finally {
      running = false;
      if (!isDisposed()) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }
  button.addEventListener('click', () => { void run(); });
  return { run };
}

/** The line under "Processor use". */
export const PROCESSOR_USE_HINT = 'Low keeps the app easy on the computer and is the default. Balanced and '
  + 'High let the Visualizer use more of the processor, up to the limit below; a picture drawn without a '
  + 'graphics card starts at Low quality, or at the quality chosen when the level is Balanced or High. '
  + 'With a graphics card the Visualizer usually needs only a small share of the processor, so the limit matters most on computers without one or with few cores.';
/** Said in place of the limit's hint for a moment when a typed limit was
 *  out of range and corrected. */
export const PROCESSOR_LIMIT_RANGE_TEXT = `The limit is from ${PROCESSOR_LIMIT_MIN}% to ${PROCESSOR_LIMIT_MAX}%.`;
export const PROCESSOR_LIMIT_NOTE_MS = 5_000;
export const PROCESSOR_LIMIT_HINTS = Object.freeze({
  light: 'Used at Balanced and High. Low steers by smoothness only, as always.',
  balanced: 'The app steers the Visualizer to stay under this share; it is a target, not a hard cap.',
  high: 'The app steers the Visualizer to stay under this share; it is a target, not a hard cap. '
    + 'High can make the fans louder and the battery last less.',
});

/** Wire the Processor use choice and its limit. */
export function bindProcessorUse(root, settings, {
  save = saveSettings, openAbout = openProcessorAbout,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  const levelSel = root.querySelector('select[data-field="processorUse"]');
  const limitInput = root.querySelector('input[data-field="processorLimit"]');
  const limitHint = root.querySelector('[data-processor-limit-hint]');
  // The range, said in the hint's place (the hint keeps its room, hidden,
  // so nothing below moves) for a moment after a typed value was corrected.
  const limitHints = root.querySelector('[data-processor-limit-hints]');
  const limitNote = root.querySelector('[data-processor-limit-note]');
  let noteTimer = null;
  const endNote = () => {
    if (noteTimer !== null) clearTimer(noteTimer);
    noteTimer = null;
    limitHints?.classList?.remove('is-noting');
    if (limitNote) limitNote.textContent = '';
  };
  const sayRange = () => {
    if (!limitNote) return;
    if (noteTimer !== null) clearTimer(noteTimer);
    limitHints?.classList?.add('is-noting');
    limitNote.textContent = PROCESSOR_LIMIT_RANGE_TEXT;
    noteTimer = setTimer(() => { noteTimer = null; endNote(); }, PROCESSOR_LIMIT_NOTE_MS);
  };
  if (!levelSel || !limitInput) return;
  let current = { processorUse: normalizeProcessorUse(settings?.processorUse),
    processorLimit: normalizeProcessorLimit(settings?.processorLimit) };
  const show = () => {
    const budget = processorBudget(current);
    levelSel.value = budget.level;
    limitInput.value = String(budget.limit);
    limitInput.disabled = !budget.readsUse;
    if (limitHint) limitHint.textContent = PROCESSOR_LIMIT_HINTS[budget.level];
  };
  show();
  levelSel.addEventListener('change', () => {
    // A new level starts at its own preset limit.
    current = { processorUse: normalizeProcessorUse(levelSel.value), processorLimit: null };
    endNote();
    save(current);
    show();
  });
  limitInput.addEventListener('change', () => {
    const typed = String(limitInput.value ?? '').trim() === '' ? Number.NaN : Number(limitInput.value);
    // Out of range: kept to the range, and the range is said.
    if (Number.isFinite(typed) && (typed < PROCESSOR_LIMIT_MIN || typed > PROCESSOR_LIMIT_MAX)) sayRange();
    else endNote();
    current = { ...current, processorLimit: normalizeProcessorLimit(limitInput.value) };
    save({ processorLimit: current.processorLimit });
    show();
  });
  root.querySelector('[data-act="processor-about"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    openAbout(root);
  });
}

/** Close Settings and show the About tab's "Processor use" section. */
export function openProcessorAbout(root) {
  if (!isTabShown('about', getState().settings)) return;
  (root.closest?.('[data-settings-modal]') || root).querySelector?.('[data-act="close"]')?.click();
  document.querySelector('.mode-btn[data-mode="about"]')?.click();
  const section = document.getElementById('about-processor-use');
  section?.scrollIntoView?.({ block: 'start' });
  section?.focus?.({ preventScroll: true });
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
