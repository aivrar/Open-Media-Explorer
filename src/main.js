import {
  initState, getState, isFavorite, setMode as setStateMode, subscribe,
} from './lib/state.js';
import { catalogScheduler } from './lib/catalog-scheduler.js';
import { setArtworkPlaybackPriority } from './lib/artwork.js';
import { SOURCE_IDS } from './lib/sources.js';
import { initPlayer, getCurrentItem, getAudioSignal, getNowPlaying, isMediaAdvancing } from './lib/player.js';
import { bindPlayerBarFit } from './lib/player-bar-fit.js';
import { initPlayerMeter } from './lib/player-meter.js';
import { startSongLog } from './lib/song-log.js';
import { openSongLog } from './lib/song-log-panel.js';
import { starredSongs } from './lib/starred-songs.js';
import { bindSongStar } from './lib/song-star.js';
import { favoriteNamesSnapshot, withFavoriteName } from './lib/favorite-names.js';
import './lib/favorite-rename.js'; // drops names of favorites no longer saved
import { initCaptureUi } from './lib/capture-ui.js';
import { openSettings } from './lib/settings.js';
import { initEqOverlay } from './lib/eq-overlay.js';
import { initSleepTimer } from './lib/sleep-timer.js';
import { initShutdownButton } from './lib/shutdown.js';
import {
  renderLibrary, showMyPlaylists, importLocalPlaylist, dropStationPicture, pictureDropTarget,
} from './modes/library.js';
import { renderTuner, tunerBand } from './modes/tuner.js';
import { renderGrid } from './modes/grid.js';
import { renderDiscovery } from './modes/discovery.js';
import { renderAbout } from './modes/about.js';
import { renderNowPlaying } from './modes/now-playing.js';
import { renderVisualizer } from './modes/visualizer.js';
import { playClock } from './lib/play-clock.js';
import { initPersistenceNotice } from './lib/persistence-notice.js';
import { initPlaylistDrop } from './lib/playlist-drop.js';
import { loadStationImages } from './lib/station-images.js';
import { selectTopTab, syncTopTabs } from './lib/top-tabs.js';

const MODES = {
  library: renderLibrary,
  tuner: renderTuner,
  grid: renderGrid,
  discovery: renderDiscovery,
  'now-playing': renderNowPlaying,
  // A thin shell; the visualizer itself is a separate chunk loaded on first open.
  visualizer: renderVisualizer,
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
  if (!selectTopTab(mode, getState().settings, document.querySelectorAll('.mode-btn'))) return;
  setStateMode(mode);
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

/** The playing item under the name the user gave it, if it is a renamed
 *  favorite (the song log and starred songs name the station this way). */
function shownCurrentItem() {
  const item = getCurrentItem();
  return item && isFavorite(item.id) ? withFavoriteName(item, favoriteNamesSnapshot().names) : item;
}

function bindTopBar() {
  document.getElementById('modes-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });
  document.getElementById('settings-btn').addEventListener('click', () => openSettings());
  document.getElementById('song-log-btn')?.addEventListener('click', () => { openSongLog(); });
}

async function boot() {
  initPersistenceNotice();
  await initState();
  initPlayer();
  bindPlayerBarFit(document.getElementById('player-bar'));
  // How long the loaded item has played, for the Now Playing tab (two
  // numbers kept on the player's events; nothing runs on its own).
  playClock.start(subscribe, getCurrentItem, isMediaAdvancing);
  // The LED sound meter after EQ; Settings > Appearance switches it.
  initPlayerMeter({
    signal: getAudioSignal(),
    getSettings: () => getState().settings,
    subscribeSettings: (fn) => subscribe('settings-change', fn),
  });
  // The song log names the station from the item that is playing.
  startSongLog(subscribe, (itemId) => {
    const item = shownCurrentItem();
    return item?.id === itemId ? item : null;
  });
  // Starred songs (their list is in the Song log panel) and the player bar's
  // star for the song playing now.
  starredSongs.start();
  bindSongStar({
    button: document.getElementById('player-song-star'),
    starred: starredSongs,
    getNowPlaying,
    getCurrentItem: shownCurrentItem,
    subscribe,
  });
  initCaptureUi();
  initEqOverlay();
  initSleepTimer();
  bindTopBar();
  // Import playlist files anywhere and set station pictures on Library
  // cards and in the details panel.
  initPlaylistDrop({
    onPlaylist: importDroppedPlaylist, onPicture: dropStationPicture, getPictureTarget: pictureDropTarget,
  });
  // The user's own station pictures: listed once now, again on Refresh in Settings.
  loadStationImages().catch(() => {});
  const state = getState();
  syncCatalogSourceSettings(state.settings);
  syncTechnicalDetails(state.settings);
  const modeButtons = document.querySelectorAll('.mode-btn');
  const startMode = syncTopTabs(state.settings, modeButtons, state.settings.defaultMode);
  if (!unbindCatalogSettings) {
    unbindCatalogSettings = subscribe('settings-change', syncCatalogSourceSettings);
    subscribe('settings-change', syncTechnicalDetails);
    subscribe('settings-change', (settings) => {
      const { mode } = getState();
      const visible = syncTopTabs(settings, modeButtons, mode);
      if (visible !== mode) setMode(visible);
    });
  }
  if (!unbindMediaPriority) {
    syncMediaPriority(false);
    unbindMediaPriority = subscribe('media-priority-change', syncMediaPriority);
  }
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
