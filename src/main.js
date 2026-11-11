import {
  initState, getState, setMode as setStateMode, subscribe,
} from './lib/state.js';
import { catalogScheduler } from './lib/catalog-scheduler.js';
import { setArtworkPlaybackPriority } from './lib/artwork.js';
import { SOURCE_IDS } from './lib/sources.js';
import { initPlayer } from './lib/player.js';
import { initCaptureUi } from './lib/capture-ui.js';
import { initSettings, openSettings } from './lib/settings.js';
import { initEqOverlay } from './lib/eq-overlay.js';
import { initSleepTimer } from './lib/sleep-timer.js';
import { initShutdownButton } from './lib/shutdown.js';
import { renderLibrary, showMyPlaylists, importLocalPlaylist } from './modes/library.js';
import { renderTuner, tunerBand } from './modes/tuner.js';
import { renderGrid } from './modes/grid.js';
import { renderDiscovery } from './modes/discovery.js';
import { renderAbout } from './modes/about.js';
import { initPersistenceNotice } from './lib/persistence-notice.js';
import { initPlaylistDrop } from './lib/playlist-drop.js';

const MODES = {
  library: renderLibrary,
  tuner: renderTuner,
  grid: renderGrid,
  discovery: renderDiscovery,
  about: renderAbout,
};

let unbindCatalogSettings = null;
let unbindMediaPriority = null;

function syncCatalogSourceSettings(settings) {
  for (const sourceId of SOURCE_IDS) {
    catalogScheduler.setSourceEnabled(
      sourceId, settings?.enabledSources?.[sourceId] !== false,
    );
  }
}

/** Simple vs. technical presentation is pure CSS keyed off this attribute. */
function syncTechnicalDetails(settings) {
  document.documentElement.dataset.techDetails = settings?.showTechnicalDetails === true ? 'on' : 'off';
}

function syncMediaPriority(active) {
  const enabled = active === true;
  catalogScheduler.setPlaybackPriority(enabled);
  setArtworkPlaybackPriority(enabled);
}

function setMode(mode) {
  if (!(mode in MODES)) return;
  setStateMode(mode);
  for (const btn of document.querySelectorAll('.mode-btn')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  const host = document.getElementById('view-host');
  host.innerHTML = '';
  host.dataset.mode = mode;
  try {
    MODES[mode](host);
  } catch (err) {
    console.error('Mode render failed:', err);
    host.innerHTML = `<div class="error-pane"><h2>Mode failed to load</h2><pre>${escape(err && err.stack || String(err))}</pre></div>`;
  }
}

// A playlist file dropped anywhere on the window goes to Library > My
// Playlists, where the import result is shown. Dropped on the Tuner, new
// channels default to the band the dial is on.
async function importDroppedPlaylist(file) {
  const type = getState().mode === 'tuner' ? tunerBand() : '';
  showMyPlaylists();
  if (getState().mode !== 'library') setMode('library');
  await importLocalPlaylist(file, type);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bindTopBar() {
  document.getElementById('modes-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });
  document.getElementById('settings-btn').addEventListener('click', () => openSettings());
}

async function boot() {
  initPersistenceNotice();
  await initState();
  initPlayer();
  initCaptureUi();
  initSettings();
  initEqOverlay();
  initSleepTimer();
  bindTopBar();
  initPlaylistDrop({ onPlaylist: importDroppedPlaylist });
  const state = getState();
  syncCatalogSourceSettings(state.settings);
  syncTechnicalDetails(state.settings);
  if (!unbindCatalogSettings) {
    unbindCatalogSettings = subscribe('settings-change', syncCatalogSourceSettings);
    subscribe('settings-change', syncTechnicalDetails);
  }
  if (!unbindMediaPriority) {
    syncMediaPriority(false);
    unbindMediaPriority = subscribe('media-priority-change', syncMediaPriority);
  }
  const startMode = state.settings.defaultMode || 'library';
  setMode(startMode);
}

window.addEventListener('DOMContentLoaded', () => {
  // The shutdown control must work even while persisted state or a source is
  // still starting. initShutdownButton is idempotent for tests/hot reloads.
  initShutdownButton();
  boot().catch((err) => {
    console.error('Boot failed:', err);
    const host = document.getElementById('view-host');
    if (host) {
      host.innerHTML = `<div class="error-pane"><h2>Failed to start</h2><pre>${escape(err && err.stack || String(err))}</pre></div>`;
    }
  });
});
