/**
 * Central app state. The only place mutable globals live.
 *
 * State shape:
 * {
 *   mode: 'library' | 'tuner' | 'computer' | 'now-playing' | 'visualizer' | 'about',
 *   currentItem: Item | null,
 *   currentStream: the upstream candidate selected for currentItem, or null,
 *   isPlaying: bool,
 *   favorites: Item[],
 *   settings: {
 *     theme: 'system' | 'light' | 'dark' | 'midnight' | 'forest' | 'ember' | 'amethyst',
 *     defaultMode: string,
 *     tabsShown: Record<mode, bool>,
 *     recordingEnabled: bool,
 *     enabledSources: Record<adapterId, bool>,
 *     showExplicitContent: bool,
 *     tunerFavoritesOnly: bool,
 *     tunerToneKnobs: bool,
 *     tunerStations: bool,
 *     nowPlayingSurprise: bool,
 *     showTechnicalDetails: bool,
 *     videoSize: 'normal' | 'large',
 *     favoritesSort: 'manual' | 'name',   // "My order" (stored order) or "A-Z"
 *     tunerCardSize: 'small' | 'medium' | 'large',   // Tuner strip cards (tuner-card-size.js)
 *     nowPlayingBackgroundBlur: 'off' | 'light' | 'medium' | 'strong',
 *     soundMeter: bool,   // LED sound meter in the player bar (player-meter.js), default on
 *     bestStreamMode: 'off' | 'listed' | 'auto',   // "Pick the best stream" (best-stream.js), default 'listed'
 *     processorUse: 'light' | 'balanced' | 'high',   // Processor use (processor-budget.js), default 'light'
 *     processorLimit: number | null,   // its limit, 2-80 (%), null: the level's preset
 *     visualizerQuality: 'low' | 'medium' | 'high',   // Visualizer picture sharpness (visualizer-settings.js)
 *     visualizerFps: 15 | 30 | 60,   // Visualizer frames a second while sound plays, default 30
 *     visualizerBrightness: number,   // Visualizer brightness, 30-100 (%), default 100
 *     visualizerScene: string,   // last Visualizer scene id, default 'plasma'
 *     visualizerShowFps: bool,   // measured frame-rate readout in the Visualizer tab, default off
 *     visualizerQualityPicked: bool,   // a Visualizer quality was picked by hand, default off
 *     visualizerShuffleCostPicked: bool,   // the shuffle's cost filter was picked by hand, default off
 *     tunerVisualizerBackground: bool,   // the dimmed Visualizer behind the Tuner (lib/tuner-background.js), default off
 *     tunerVisualizerLevel: number,   // how strongly it shows, 1-100 (% opacity), kept while it is off, default 8
 *     visualizerDebug: bool,   // developer strip with the sound values, default off
 *     visualizerLooks: object,   // Visualizer look chosen per scene, { sceneId: number }, default {}
 *     visualizerPanelOpen, visualizerShuffle, visualizerShufflePool, visualizerShuffleCost,
 *     visualizerShuffleBars, visualizerFavourites, visualizerNoticeSeen: see normalizeVisualizerExtras
 *   },
 *   sleepTimer: { until: number | null }
 * }
 */

import { isRetiredSource, SOURCE_IDS } from './sources.js';
import { makeItem, rekeyComputerItem } from './item-model.js';
import { clearStreamLookups } from './stream-lookups.js';
import { DEFAULT_BEST_STREAM_MODE, bestStreamMode } from './best-stream.js';
import { levellingMode, levellingPreamp } from './computer-levelling.js';
import { DEFAULT_PROCESSOR_USE, normalizeProcessorLimit, normalizeProcessorUse } from './processor-budget.js';
import { clearStreamVerifications } from './stream-verify.js';
import { clearDidNotPlayCache } from './did-not-play.js';
import {
  EXTRA_SETTINGS_STORAGE_KEY, PICTURE_STORAGE_KEY, isComputerFavoriteId, portableProfileValue,
} from './profile-storage.js';
import { ControlApiError } from './capture-client.js';
import { listComputerStars, writeComputerStars } from './computer-client.js';
import { clearPlayedStreams } from './played-streams.js';
import {
  loadEqState, getEffectiveEq, persistFavoriteEq, deleteFavoriteEq, clearEqState,
  addFavoritesEq, EQ_EXTRA_STORAGE_KEY, EQ_STORAGE_KEY, isEqStation, saveEqState,
} from './eq-store.js';
import { DEFAULT_RECORDING_QUALITY, normalizeRecordingQuality } from './recording-profiles.js';
import { repairFiniteMediaFields } from './media-capabilities.js';
import { applyTheme, normalizeTheme } from './themes.js';
import { FAVORITES_SORT_MANUAL, favoritesInDisplayOrder, normalizeFavoritesSort } from './favorites-order.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';
import { TUNER_CARD_SMALL, normalizeTunerCardSize } from './tuner-card-size.js';
import { normalizeTabsShown, TOP_TABS } from './top-tabs.js';
import {
  DEFAULT_VISUALIZER_BRIGHTNESS, DEFAULT_VISUALIZER_DEBUG, DEFAULT_VISUALIZER_FPS, DEFAULT_VISUALIZER_QUALITY,
  DEFAULT_VISUALIZER_SCENE, DEFAULT_VISUALIZER_SHOW_FPS, normalizeVisualizerBrightness, normalizeVisualizerFps,
  normalizeVisualizerQuality, normalizeVisualizerScene, normalizeVisualizerLooks, normalizeVisualizerExtras,
} from './visualizer-settings.js';
import { TUNER_BACKGROUND_DEFAULT_LEVEL, normalizeTunerBackgroundLevel } from './tuner-background.js';
import { songLog } from './song-log.js';
import { FAVORITE_NAMES_KEY, withoutFavoriteName } from './favorite-names.js';
import { removeUnusedStationStreams, STATION_STREAMS_KEY } from './station-stream-addresses.js';
import { tidyStorageAtStart } from './startup-tidy.js';
import { starredSongs } from './starred-songs.js';
import { STREAM_QUALITY_FIELDS } from './stream-quality.js';
import {
  cancelScheduledProfileHandoff,
  clearProfileHandoff,
  restoreStartupProfileHandoff,
  scheduleProfileHandoff,
} from './profile-transfer.js';
import { clearPartResume, removeComputerResumePaths } from './part-resume.js';

export const STORAGE_KEYS = {
  favorites: 'worldmedia.favorites.v1',
  settings: 'worldmedia.settings.v1',
  volume:    'worldmedia.volume.v1',
  jobs:      'worldmedia.jobs.v1',
  // Favorites categories (lib/favorite-groups.js), kept apart from the list.
  favoriteGroups: 'worldmedia.favgroups.v1',
  // The user's own names for favorites (lib/favorite-names.js), the same.
  favoriteNames: FAVORITE_NAMES_KEY,
};

export const SETTINGS_VERSION = 1;

export const NOW_PLAYING_BACKGROUND_BLUR_LABELS = Object.freeze({
  off: 'Off', light: 'Light', medium: 'Medium', strong: 'Strong',
});
const DEFAULT_NOW_PLAYING_BACKGROUND_BLUR = 'medium';

export function normalizeNowPlayingBackgroundBlur(value) {
  return typeof value === 'string' && Object.hasOwn(NOW_PLAYING_BACKGROUND_BLUR_LABELS, value)
    ? value
    : DEFAULT_NOW_PLAYING_BACKGROUND_BLUR;
}

export function loadVolume() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.volume);
    if (raw == null) return null;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(100, v));
  } catch (_) { return null; }
}

export function saveVolume(pct) {
  try {
    localStorage.setItem(STORAGE_KEYS.volume, String(Math.round(pct)));
    scheduleProfileHandoff();
  } catch (_) {}
}

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  theme: 'system',
  defaultMode: 'library',
  recordingEnabled: true,
  recordingQuality: DEFAULT_RECORDING_QUALITY,
  showExplicitContent: false,
  tunerFavoritesOnly: false,
  tunerToneKnobs: false,
  tunerStations: true,
  nowPlayingSurprise: true,
  showTechnicalDetails: false,
  videoSize: 'normal',
  favoritesSort: FAVORITES_SORT_MANUAL,
  showFavoriteTitles: false,
  tunerCardSize: TUNER_CARD_SMALL,
  nowPlayingBackgroundBlur: DEFAULT_NOW_PLAYING_BACKGROUND_BLUR,
  soundMeter: true,
  volumeLevelling: 'off',
  levellingPreamp: 0,
  bestStreamMode: DEFAULT_BEST_STREAM_MODE,
  processorUse: DEFAULT_PROCESSOR_USE,
  processorLimit: null,
  visualizerQuality: DEFAULT_VISUALIZER_QUALITY,
  visualizerFps: DEFAULT_VISUALIZER_FPS,
  visualizerBrightness: DEFAULT_VISUALIZER_BRIGHTNESS,
  visualizerScene: DEFAULT_VISUALIZER_SCENE,
  visualizerShowFps: DEFAULT_VISUALIZER_SHOW_FPS,
  visualizerQualityPicked: false,
  visualizerShuffleCostPicked: false,
  tunerVisualizerBackground: false,
  tunerVisualizerLevel: TUNER_BACKGROUND_DEFAULT_LEVEL,
  visualizerDebug: DEFAULT_VISUALIZER_DEBUG,
  enabledSources: Object.fromEntries(SOURCE_IDS.map((id) => [id, true])),
};

// Enabling explicit content is intentionally a privileged user gesture. Other
// modules may call saveSettings for ordinary fields, but cannot accidentally
// reveal content by passing provider/favorite/URL-derived data into it.
const EXPLICIT_USER_GESTURE = Symbol('explicit-user-gesture');

function freshDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    tabsShown: normalizeTabsShown(),
    enabledSources: { ...DEFAULT_SETTINGS.enabledSources },
  };
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const enabledSources = { ...DEFAULT_SETTINGS.enabledSources };
  if (source.enabledSources && typeof source.enabledSources === 'object' && !Array.isArray(source.enabledSources)) {
    for (const [sourceId, enabled] of Object.entries(source.enabledSources)) {
      // A switch saved for a source the app no longer offers is dropped quietly.
      if (isRetiredSource(sourceId)) continue;
      if (typeof enabled === 'boolean') enabledSources[sourceId] = enabled;
    }
  }
  const version = Number.isInteger(source.version) && source.version > 0
    ? source.version
    : SETTINGS_VERSION;
  return {
    ...source,
    version,
    theme: normalizeTheme(source.theme),
    defaultMode: ['library', 'tuner', 'computer', 'about'].includes(source.defaultMode)
      ? source.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    tabsShown: normalizeTabsShown(source.tabsShown),
    recordingEnabled: source.recordingEnabled !== false,
    recordingQuality: normalizeRecordingQuality(source.recordingQuality),
    showExplicitContent: source.showExplicitContent === true,
    tunerFavoritesOnly: source.tunerFavoritesOnly === true,
    tunerToneKnobs: source.tunerToneKnobs === true,
    tunerStations: source.tunerStations !== false,
    nowPlayingSurprise: source.nowPlayingSurprise !== false,
    showTechnicalDetails: source.showTechnicalDetails === true,
    videoSize: source.videoSize === 'large' ? 'large' : 'normal',
    favoritesSort: normalizeFavoritesSort(source.favoritesSort),
    showFavoriteTitles: source.showFavoriteTitles === true,
    tunerCardSize: normalizeTunerCardSize(source.tunerCardSize),
    nowPlayingBackgroundBlur: normalizeNowPlayingBackgroundBlur(source.nowPlayingBackgroundBlur),
    // Only an explicit false turns it off; older builds keep the field as is.
    soundMeter: source.soundMeter !== false,
    volumeLevelling: levellingMode(source),
    levellingPreamp: levellingPreamp(source),
    bestStreamMode: bestStreamMode(source),
    processorUse: normalizeProcessorUse(source.processorUse),
    processorLimit: normalizeProcessorLimit(source.processorLimit),
    visualizerQuality: normalizeVisualizerQuality(source.visualizerQuality),
    visualizerFps: normalizeVisualizerFps(source.visualizerFps),
    visualizerBrightness: normalizeVisualizerBrightness(source.visualizerBrightness),
    visualizerScene: normalizeVisualizerScene(source.visualizerScene),
    visualizerLooks: normalizeVisualizerLooks(source.visualizerLooks),
    // Off unless turned on (an explicit true).
    visualizerShowFps: source.visualizerShowFps === true,
    visualizerQualityPicked: source.visualizerQualityPicked === true,
    visualizerShuffleCostPicked: source.visualizerShuffleCostPicked === true,
    tunerVisualizerBackground: source.tunerVisualizerBackground === true,
    // Settings saved before the level existed get the default: today's look.
    tunerVisualizerLevel: normalizeTunerBackgroundLevel(source.tunerVisualizerLevel),
    visualizerDebug: source.visualizerDebug === true,
    ...normalizeVisualizerExtras(source),
    enabledSources,
  };
}

export const isLocalFileFavorite = (item) => isComputerFavoriteId(item?.id);

function localFavoriteSnapshot(item) {
  const { artist, album, duration, format, kind, ext } = item._extra.computer;
  const fields = { title: item.title, artist, album, duration, kind: kind || item.type, ext, format };
  const snap = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value) snap[key] = Array.from(value).slice(0, 300).join('');
    else if (Number.isFinite(value)) snap[key] = value;
  }
  return { id: item._extra.computer.id, snap };
}

function localFavoriteFromRecord({ id, snap = {}, t, seq }) {
  const type = ['video', 'Movie', 'Episode'].includes(snap.kind) ? 'video' : 'audio';
  return normalizeFavoriteItem({
    id: 'computer:' + id, title: snap.title || 'Untitled', source: 'computer', type,
    _extra: { computer: { ...snap, kind: snap.kind === type ? '' : snap.kind, starredAt: t, starSequence: seq } },
  });
}

export function normalizeFavoriteItem(value, options = {}) {
  // A list's renamed copy (favorite-names.js) is saved with its own title.
  value = withoutFavoriteName(value);
  if (!value || typeof value !== 'object' || !value.id) return null;
  if (isLocalFileFavorite(value)) {
    const computer = { ...value._extra?.computer, id: value.id.slice('computer:'.length) };
    const type = value.type === 'video' ? 'video' : 'audio';
    value = {
      ...value, source: 'computer', type, stream_kind: type, delivery: 'on-demand',
      description: type === 'video' ? '' : [computer.artist, computer.album].filter(Boolean).join(' \u00b7 '),
      _extra: { ...value._extra, computer },
    };
  }
  const normalized = makeItem(value);
  const extra = normalized._extra && typeof normalized._extra === 'object'
    && !Array.isArray(normalized._extra)
    ? { ...normalized._extra }
    : normalized._extra;
  // Asset relay IDs are random, scoped to one app session, and expire. Keep
  // the adapter's canonical artwork URL in `_extra`, but never write a dead
  // local token into saved favorites. The visible-card hydrator will obtain a
  // fresh relay URL next session.
  if (/^\/api\/v1\/assets\/[A-Za-z0-9_-]{16,}$/.test(normalized.thumbnail)) {
    normalized.thumbnail = '';
    if (extra && typeof extra === 'object') extra.needsArtwork = true;
  }
  // Playback relay URLs have the same per-launch lifetime as asset relays.
  // They must never survive restart as if they were canonical provider URLs.
  // A capable adapter can resolve the stable metadata again; otherwise the
  // favorite remains present with an honest unavailable/checking state.
  const expiredMediaToken = [normalized.stream_url, normalized.download_url]
    .some((url) => /^\/api\/v1\/media\/[A-Za-z0-9_-]{16,}$/.test(url));
  if (expiredMediaToken) {
    normalized.stream_url = '';
    normalized.download_url = '';
    normalized.download_name = '';
    if (extra && typeof extra === 'object') {
      extra.needsResolve = true;
      extra.downloadResolved = false;
      extra.resolutionStatus = 'unresolved';
    }
  }
  // Some providers require a fresh semantic rights/availability check each
  // launch even when their canonical media URL itself is not an opaque local
  // token. Apply this only during startup migration, not on every in-session
  // metadata save, so a completed resolver remains stable until restart.
  if (options.restart === true && extra?.restartResolve === true) {
    normalized.stream_url = '';
    normalized.download_url = '';
    normalized.download_name = '';
    extra.needsResolve = true;
    extra.downloadResolved = false;
    extra.resolutionStatus = 'unresolved';
  }
  // A live snapshot URI is short-lived catalog state, not favorite identity.
  // Persist the stable instance ID/source/artwork metadata and force the
  // adapter to revalidate on selection. This also prevents a public directory
  // query string from being copied into long-lived browser storage.
  if (normalized.delivery === 'live' && extra?.snapshotItem === true) {
    normalized.stream_url = '';
    normalized.download_url = '';
    extra.needsResolve = true;
    extra.resolutionStatus = 'unresolved';
  }
  return repairFiniteMediaFields({ ...value, ...normalized, ...(extra ? { _extra: extra } : {}) });
}

const state = {
  mode: 'library',
  currentItem: null,
  currentStream: null,
  isPlaying: false,
  favorites: [],
  settings: freshDefaultSettings(),
  sleepTimer: { until: null },
};

let favoritesKnown = false;
const listeners = {};

/** Subscribe to a named event. Returns an unsubscribe function. */
export function subscribe(event, fn) {
  (listeners[event] ||= new Set()).add(fn);
  return () => listeners[event]?.delete(fn);
}

/** Emit a named event with optional payload. */
export function emit(event, payload) {
  const set = listeners[event];
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`listener for ${event} threw:`, e); }
  }
}

export function getState() { return state; }
export function favoritesLoaded() { return favoritesKnown; }

export function setMode(mode) {
  state.mode = Object.hasOwn(TOP_TABS, mode) ? mode : 'library';
  emit('mode-change', state.mode);
}

export function setCurrentItem(item, stream = null) {
  state.currentItem = item;
  state.currentStream = stream;
  emit('current-item', item);
}

export function setPlaying(playing) {
  state.isPlaying = playing;
  emit('playing-change', playing);
}

/* ============ Favorites ============ */

let indexedFavorites;
let indexedLength;
let favoriteIds = new Set();
let localFavoriteCount = 0;
const LEGACY_LOCAL_STARS = 'worldmedia.computer-stars-migration.v1';
const STAR_BATCH_SIZE = 2_000;
const STAR_BATCH_BYTES = 1024 * 1024;
const starEncoder = new TextEncoder();
let legacyLocalStars = [];
let migrationAttempted = false;
let localStarsStatus = 'idle';
let localStarsLoad = null;
let starWork = Promise.resolve();
let confirmedStars = new Map();
let localStarsReadMoves;
const pendingStars = [];
let changingFavoriteBatch = false;
let optimisticSequence = 0;

function queueStarWork(work) {
  const job = starWork.then(work);
  starWork = job.catch(() => {});
  return job;
}

function starChunks(items, field, serialize) {
  const chunks = [];
  const emptyBytes = JSON.stringify({ [field]: [] }).length;
  let bytes = emptyBytes;
  let chunk = [];
  for (const item of items) {
    const value = serialize(item);
    const size = starEncoder.encode(JSON.stringify(value)).byteLength;
    if (chunk.length && (chunk.length === STAR_BATCH_SIZE || bytes + 1 + size > STAR_BATCH_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = emptyBytes;
    }
    bytes += size + Number(chunk.length > 0);
    chunk.push({ item, value });
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function confirmStarBatch(data, add, remove) {
  const added = new Map(data.added.map((record) => [record.id, record]));
  const removed = new Set(data.removed.map((id) => 'computer:' + id));
  if (added.size !== add.length || add.some((item) => !added.has(item._extra.computer.id))) return false;
  if (localStarsStatus === 'loaded') {
    const newCount = add.filter((item) => !confirmedStars.has(item.id)).length;
    const expectedRemovals = remove.filter((id) => confirmedStars.has(id));
    if (removed.size !== expectedRemovals.length || expectedRemovals.some((id) => !removed.has(id))
        || data.count !== confirmedStars.size + newCount - removed.size) return false;
  }
  for (const item of add) {
    const record = added.get(item._extra.computer.id);
    Object.assign(item._extra.computer, { starredAt: record.t, starSequence: record.seq });
    confirmedStars.set(item.id, item);
  }
  for (const id of removed) confirmedStars.delete(id);
  return true;
}

function setLocalStarsStatus(status) {
  if (localStarsStatus === status) return;
  localStarsStatus = status;
  emit('computer-stars-status', status);
}

export const getComputerStarsStatus = () => localStarsStatus;

function moveStarRecords(stars, moves) {
  for (const [from, to] of moves) {
    const oldId = 'computer:' + from;
    const item = stars.get(oldId);
    if (!item) continue;
    stars.delete(oldId);
    const newId = 'computer:' + to;
    if (!stars.has(newId)) stars.set(newId, rekeyComputerItem({ ...item }, to));
  }
}

export function moveComputerStars(moves) {
  // The scan has already migrated the server records. Update the local copy
  // before any view draws the catalog, and carry over any in-flight read.
  localStarsReadMoves?.push(...moves);
  moveStarRecords(confirmedStars, moves);
  return publishLocalStars({ notify: null });
}

async function readLocalStars() {
  localStarsReadMoves = [];
  try {
    const data = await listComputerStars({ signal: AbortSignal.timeout(10_000) });
    confirmedStars = new Map(data.stars.map((record) => {
      const item = localFavoriteFromRecord(record);
      return [item.id, item];
    }));
    moveStarRecords(confirmedStars, localStarsReadMoves);
    publishLocalStars();
    setLocalStarsStatus('loaded');
    return true;
  } catch {
    setLocalStarsStatus('error');
    return false;
  } finally {
    localStarsReadMoves = undefined;
  }
}

async function writeStarBatches({ add, remove }, settle, { migrating = false } = {}) {
  // The first id in a request gets the highest sequence. Save the last
  // chunk first so the first track also wins across request boundaries.
  const additions = starChunks(add, 'add', localFavoriteSnapshot).reverse();
  const removals = starChunks(remove, 'remove', (id) => id.slice('computer:'.length));
  let failed = false;
  for (const [field, chunks] of [['add', additions], ['remove', removals]]) {
    for (const chunk of chunks) {
      if (!migrating && localStarsStatus !== 'loaded' && !await readLocalStars()) return false;
      const items = chunk.map(({ item }) => item);
      const body = { [field]: chunk.map(({ value }) => value) };
      let confirmed = false;
      let refused = false;
      try {
        const data = await writeComputerStars(body, { signal: AbortSignal.timeout(10_000) });
        confirmed = confirmStarBatch(data, field === 'add' ? items : [], field === 'remove' ? items : []);
      } catch (error) {
        refused = error instanceof ControlApiError && error.status >= 400 && error.status < 500
          && error.message !== 'Local control request failed.';
      }
      settle?.(field, items);
      if (confirmed) continue;
      failed = true;
      if (!refused && !await readLocalStars()) return false;
      publishLocalStars();
    }
  }
  return !failed;
}

export function compareLocalFileStars(a, b) {
  const left = a._extra.computer;
  const right = b._extra.computer;
  return (right.pendingStar || 0) - (left.pendingStar || 0)
    || (right.starSequence || 0) - (left.starSequence || 0)
    || (right.starredAt || 0) - (left.starredAt || 0) || a.id.localeCompare(b.id);
}

function publishLocalStars({ notify = true } = {}) {
  const local = new Map(confirmedStars);
  for (const { add, remove } of pendingStars) {
    for (const item of add) local.set(item.id, item);
    for (const id of remove) local.delete(id);
  }
  const ordered = [...local.values()].sort(compareLocalFileStars);
  const next = [...state.favorites.filter((item) => !isLocalFileFavorite(item)), ...ordered];
  if (next.length === state.favorites.length && next.every((item, index) => item === state.favorites[index])) return false;
  state.favorites = next;
  if (notify !== null) emit(notify ? 'favorites-change' : 'computer-stars-order', next);
  return true;
}

/** Get the machine's stars once. A failed read is retried when Computer opens. */
export function loadComputerStars() {
  if (localStarsLoad) return localStarsLoad;
  if (localStarsStatus === 'loaded') return Promise.resolve(true);
  localStarsLoad = queueStarWork(async () => {
    await readLocalStars();
    if (legacyLocalStars.length && !migrationAttempted) {
      migrationAttempted = true;
      if (await writeStarBatches({ add: legacyLocalStars, remove: [] }, null, { migrating: true })) {
        legacyLocalStars = [];
        persistFavorites();
        try { localStorage.removeItem(LEGACY_LOCAL_STARS); } catch { /* Storage is unavailable. */ }
      }
    }
    publishLocalStars();
    return localStarsStatus === 'loaded';
  }).finally(() => { localStarsLoad = null; });
  return localStarsLoad;
}

export function withComputerStars(change) {
  if (!localStarsLoad && localStarsStatus === 'loaded') return change();
  return loadComputerStars().then((loaded) => loaded && change());
}

function changeLocalStars(add, remove) {
  const job = { add, remove };
  for (const item of add.toReversed()) item._extra.computer.pendingStar = ++optimisticSequence;
  pendingStars.push(job);
  const settle = (field, items) => {
    const ids = new Set(items);
    job[field] = job[field].filter((item) => !ids.has(item));
    if (field === 'add') {
      for (const item of items) delete item._extra.computer.pendingStar;
    }
  };
  queueStarWork(async () => {
    const saved = await writeStarBatches(job, settle);
    pendingStars.shift();
    settle('add', job.add);
    publishLocalStars({ notify: !saved });
    if (saved) clearPersistenceFailure('computer-stars');
    else reportPersistenceFailure('computer-stars', 'The star could not be saved.');
  });
}

function indexFavorites() {
  if (indexedFavorites === state.favorites && indexedLength === state.favorites.length) return;
  // Favorite membership changes replace the list. Metadata edits keep the same IDs.
  indexedFavorites = state.favorites;
  indexedLength = indexedFavorites.length;
  favoriteIds = new Set();
  localFavoriteCount = 0;
  for (const item of indexedFavorites) {
    favoriteIds.add(item.id);
    if (isLocalFileFavorite(item)) localFavoriteCount += 1;
  }
}

function portableFavoriteCount() {
  indexFavorites();
  return state.favorites.length - localFavoriteCount;
}

export function addFavorite(item) {
  if (isLocalFileFavorite(item)) {
    if (localStarsStatus !== 'loaded') return withComputerStars(() => addFavorite(item));
    if (isFavorite(item.id)) return;
    return addFavorites([item], { allOrNothing: true }).added > 0;
  }
  // Same identity rule as the bulk path (planFavoriteAdds): the stored,
  // normalised id. An item whose id does not normalise to a non-empty string
  // is refused, so it can never be saved as '' and duplicated on every star.
  const normalized = normalizeFavoriteItem(item);
  if (!normalized?.id) return false;
  const itemId = normalized.id;
  if (isFavorite(itemId)) return;
  emit('eq-before-scope-change', { itemId, scope: 'favorite' });
  const next = [normalized, ...state.favorites];
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  if (!isEqStation(normalized)) {
    persistFavoriteEq(itemId, getEffectiveEq(loadEqState(), itemId, false));
  }
  emit('favorites-change', state.favorites);
  if (state.currentItem?.id === itemId) emit('eq-scope-change', { itemId, scope: 'favorite' });
  return true;
}

/** The most favorites a bulk add will build up to. The portable profile
 *  backup holds 2 MiB for favorites, equalizer curves and settings together
 *  (profile-transfer.js MAX_PROFILE_BYTES, worldmedia_runtime.py
 *  PROFILE_TRANSFER_MAX_BYTES). A playlist channel costs about 0.7 KB there
 *  (about 570 bytes of favorite plus 150 bytes of equalizer curve), so 1,000
 *  uses roughly a third of it and leaves room for larger items. */
export const BULK_FAVORITES_LIMIT = 1000;

function planFavoriteAdds(items) {
  const plan = { fresh: [], already: 0, refused: 0, leftOut: 0 };
  indexFavorites();
  const seen = new Set();
  let room = BULK_FAVORITES_LIMIT - portableFavoriteCount();
  for (const item of items || []) {
    // Identity is the stored (normalised) id; a non-string id normalises to ''.
    const normalized = normalizeFavoriteItem(item);
    if (!normalized?.id) { plan.refused += 1; continue; }
    if (favoriteIds.has(normalized.id) || seen.has(normalized.id)) { plan.already += 1; continue; }
    seen.add(normalized.id);
    if (!isLocalFileFavorite(normalized) && room-- <= 0) { plan.leftOut += 1; continue; }
    plan.fresh.push(normalized);
  }
  return plan;
}

/** How many of `items` addFavorites would add right now. */
export function countNewFavorites(items) {
  return planFavoriteAdds(items).fresh.length;
}

/** Add many favorites with one save, one favorites-change event and one
 *  profile backup. New items keep their given order at the front of the list
 *  (where addFavorite puts one); items already saved are left where they are. */
export function addFavorites(items, options = {}) {
  if (localStarsStatus !== 'loaded' && items?.some(isLocalFileFavorite)) {
    void withComputerStars(() => addFavorites(items, options));
    return { added: 0, already: 0, refused: 0, leftOut: 0, failed: false };
  }
  if (changingFavoriteBatch) return { added: 0, already: 0, refused: 0, leftOut: 0, failed: true };
  changingFavoriteBatch = true;
  try {
    return applyFavoriteAdds(items, options);
  } finally {
    changingFavoriteBatch = false;
  }
}

function applyFavoriteAdds(items, { allOrNothing = false }) {
  const { fresh, already, refused, leftOut } = planFavoriteAdds(items);
  const result = { added: 0, already, refused, leftOut, failed: false };
  if (fresh.length === 0 || (allOrNothing && (refused || leftOut))) return result;
  const local = fresh.filter(isLocalFileFavorite);
  const portable = fresh.filter((item) => !isLocalFileFavorite(item));
  const ids = portable.map((item) => item.id);
  for (const itemId of ids) emit('eq-before-scope-change', { itemId, scope: 'favorite' });
  const next = [...portable, ...state.favorites];
  const curveIds = portable.filter((item) => !isEqStation(item)).map((item) => item.id);
  const eq = curveIds.length ? addFavoritesEq(loadEqState(), curveIds) : null;
  if (portable.length && !persistFavorites(next)) return { ...result, failed: true };
  if (local.length) changeLocalStars(local, []);
  state.favorites = local.length
    ? [...next.filter((item) => !isLocalFileFavorite(item)), ...local, ...next.filter(isLocalFileFavorite)]
    : next;
  let eqFailed = false;
  if (eq) saveEqState(eq, undefined, () => { eqFailed = true; });
  emit('favorites-change', state.favorites);
  const current = ids.find((itemId) => itemId === state.currentItem?.id);
  if (current) emit('eq-scope-change', { itemId: current, scope: 'favorite' });
  return { ...result, added: fresh.length, eqFailed };
}

export function removeFavorite(itemId) {
  return removeFavorites([itemId]);
}

export function removeFavorites(itemIds) {
  if (localStarsStatus !== 'loaded' && itemIds.some(isComputerFavoriteId)) {
    void withComputerStars(() => removeFavorites(itemIds));
    return false;
  }
  if (changingFavoriteBatch) return false;
  changingFavoriteBatch = true;
  try {
    return applyFavoriteRemovals(itemIds);
  } finally {
    changingFavoriteBatch = false;
  }
}

function applyFavoriteRemovals(itemIds) {
  const ids = new Set(itemIds.filter(isFavorite));
  if (!ids.size) return true;
  const local = [...ids].filter(isComputerFavoriteId);
  const portable = [...ids].filter((id) => !isComputerFavoriteId(id));
  for (const itemId of portable) emit('eq-before-scope-change', { itemId, scope: 'global' });
  const next = state.favorites.filter((item) => !ids.has(item.id));
  if (portable.length && !persistFavorites(next)) return false;
  if (local.length) changeLocalStars([], local);
  state.favorites = next;
  if (portable.length === 1) deleteFavoriteEq(portable[0]);
  else if (portable.length) {
    const eq = loadEqState();
    for (const id of portable) delete eq.favorites[id];
    saveEqState(eq);
  }
  if (portable.length) removeUnusedStationStreams(portable);
  emit('favorites-change', state.favorites);
  const itemId = state.currentItem?.id;
  if (ids.has(itemId) && !isComputerFavoriteId(itemId)) emit('eq-scope-change', { itemId, scope: 'global' });
  return true;
}

/** Empty the favorites list with one save and one favorites-change event, and
 *  drop the favorites' own equalizer curves. Categories and every other
 *  setting stay. The caller asks first.
 *
 *  All or nothing: the curves are removed first; if that cannot be saved,
 *  nothing changes. If the empty list then cannot be saved, the curves are
 *  put back. Returns { removed, failed }: failed is '' on success, 'nothing'
 *  when nothing changed, or 'curves' in the one case that cannot be undone
 *  (the list could not be saved and the curves could not be put back: the
 *  favorites stay, without their own equalizer settings). */
export function removeAllFavorites() {
  if (changingFavoriteBatch) return { removed: 0, failed: 'nothing' };
  const removed = state.favorites;
  if (removed.length === 0) return { removed: 0, failed: '' };
  changingFavoriteBatch = true;
  try {
    if (portableFavoriteCount() > 0) return applyRemoveAllFavorites(removed);
    applyFavoriteRemovals(removed.map(({ id }) => id));
    return { removed: removed.length, failed: '' };
  } finally {
    changingFavoriteBatch = false;
  }
}

function applyRemoveAllFavorites(removed) {
  const currentId = state.currentItem?.id;
  const playingFavorite = !isComputerFavoriteId(currentId) && isFavorite(currentId);
  if (playingFavorite) emit('eq-before-scope-change', { itemId: currentId, scope: 'global' });
  const eq = loadEqState();
  const curves = { ...eq.favorites };
  let hadCurves = false;
  for (const favorite of removed) {
    if (Object.hasOwn(curves, favorite.id)) { delete curves[favorite.id]; hadCurves = true; }
  }
  const undoScope = () => { if (playingFavorite) emit('eq-scope-change', { itemId: currentId, scope: 'favorite' }); };
  const savedEq = [];
  let eqFailed = false;
  if (hadCurves) {
    try {
      for (const key of [EQ_STORAGE_KEY, EQ_EXTRA_STORAGE_KEY]) savedEq.push([key, localStorage.getItem(key)]);
      saveEqState({ ...eq, favorites: curves }, undefined, () => { eqFailed = true; });
    } catch (_) { eqFailed = true; }
  }
  if (eqFailed) { undoScope(); return { removed: 0, failed: 'nothing' }; }
  if (!persistFavorites([])) {
    let restoreFailed = false;
    for (const [key, value] of savedEq) {
      try {
        if (localStorage.getItem(key) === value) continue;
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (_) { restoreFailed = true; }
    }
    undoScope();
    return { removed: 0, failed: restoreFailed ? 'curves' : 'nothing' };
  }
  const local = removed.filter(isLocalFileFavorite);
  if (local.length) changeLocalStars([], local.map((item) => item.id));
  state.favorites = [];
  removeUnusedStationStreams(removed.filter((item) => !isLocalFileFavorite(item)).map((item) => item.id));
  emit('favorites-change', state.favorites);
  if (playingFavorite) emit('eq-scope-change', { itemId: currentId, scope: 'global' });
  return { removed: removed.length, failed: '' };
}

export function isFavorite(itemId) {
  indexFavorites();
  return favoriteIds.has(itemId);
}

/** Favorites in the order the user chose to see them ("My order" or A-Z).
 *  Every list of favorites uses this; see favorites-order.js. */
export function displayFavorites() {
  return favoritesInDisplayOrder(state.favorites, state.settings);
}

/** Where moveFavorite would put `itemId`, or -1 when it cannot move that way.
 *  With `visibleIds`, up and down skip favorites the user cannot see (another
 *  type, a search, a filter), so the item trades places with the neighbour it
 *  is shown next to. "top" needs a shown favorite above it and goes to the
 *  very start of the saved list; "bottom" needs one below it and goes to the
 *  very end. */
function favoriteMoveTarget(list, from, direction, visibleIds) {
  const visible = visibleIds ? new Set(visibleIds) : null;
  const shown = (index) => !visible || visible.has(list[index].id);
  if (direction === 'up' || direction === 'top') {
    for (let i = from - 1; i >= 0; i -= 1) if (shown(i)) return direction === 'top' ? 0 : i;
  } else if (direction === 'down' || direction === 'bottom') {
    for (let i = from + 1; i < list.length; i += 1) if (shown(i)) return direction === 'bottom' ? list.length - 1 : i;
  }
  return -1;
}

/** Rearrange "My order" by hand: 'up' or 'down' swaps the favorite with its
 *  nearest shown neighbour, 'top' moves it to the start and 'bottom' to the
 *  end. One save and one
 *  favorites-change event per move. Returns true when the order changed. */
export function moveFavorite(itemId, direction, { visibleIds = null } = {}) {
  if (isComputerFavoriteId(itemId)) return false;
  const portable = state.favorites.filter((item) => !isLocalFileFavorite(item));
  const from = portable.findIndex((favorite) => favorite.id === itemId);
  if (from < 0) return false;
  const to = favoriteMoveTarget(portable, from, direction, visibleIds);
  if (to < 0) return false;
  const next = [...portable];
  if (direction === 'top') next.unshift(...next.splice(from, 1));
  else if (direction === 'bottom') next.push(...next.splice(from, 1));
  else [next[from], next[to]] = [next[to], next[from]];
  next.push(...state.favorites.filter(isLocalFileFavorite));
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  emit('favorites-change', state.favorites);
  return true;
}

/** Drag and drop in "My order": put `itemId` just before or just after
 *  `targetId` (place 'before' | 'after') in the saved list. `visibleIds`
 *  (optional) are the favorites shown, with a filter or category: only they
 *  are reordered, back into the places they had, so hidden favorites keep
 *  their exact positions. One save and one favorites-change event. Returns
 *  true when the order changed. */
export function moveFavoriteTo(itemId, targetId, place = 'before', visibleIds = null) {
  if (!itemId || itemId === targetId || [itemId, targetId].some(isComputerFavoriteId)
      || (place !== 'before' && place !== 'after')) return false;
  const visible = visibleIds ? new Set(visibleIds) : null;
  if (visible && (!visible.has(itemId) || !visible.has(targetId))) return false;
  const slots = [];
  state.favorites.forEach((favorite, index) => {
    if (!isLocalFileFavorite(favorite) && (!visible || visible.has(favorite.id))) slots.push(index);
  });
  const shown = slots.map((index) => state.favorites[index]);
  const from = shown.findIndex((favorite) => favorite.id === itemId);
  if (from < 0 || !shown.some((favorite) => favorite.id === targetId)) return false;
  const moved = shown.filter((_, index) => index !== from);
  const at = moved.findIndex((favorite) => favorite.id === targetId) + (place === 'after' ? 1 : 0);
  moved.splice(at, 0, shown[from]);
  const next = state.favorites.slice();
  slots.forEach((slot, index) => { next[slot] = moved[index]; });
  if (next.every((favorite, index) => favorite === state.favorites[index])) return false;
  if (!persistFavorites(next)) return false;
  state.favorites = next;
  emit('favorites-change', state.favorites);
  return true;
}

/** The stream format and bitrate a favorite was saved with stay when the item
 *  that rewrites it does not carry them (an older copy of the same station);
 *  when it does carry them, its fresh values win. */
function keepStreamQuality(next, saved) {
  const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const savedExtra = saved?._extra;
  if (!next || !isPlain(savedExtra)) return;
  const kept = STREAM_QUALITY_FIELDS.filter((field) => field in savedExtra);
  if (kept.length === 0) return;
  // An incoming item without an `_extra` object lacks the fields too. `next`
  // is the normalized copy, so this never changes the caller's item.
  if (!isPlain(next._extra)) next._extra = {};
  for (const field of kept) {
    if (!(field in next._extra)) next._extra[field] = savedExtra[field];
  }
}

/** Persist adapter resolution/capability metadata without changing favorite order. */
export function persistFavoriteMetadata(item) {
  if (!isFavorite(item?.id)) return false;
  const index = state.favorites.findIndex((favorite) => favorite.id === item.id);
  if (index < 0) return false;
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return false;
  const saved = state.favorites[index];
  if (isLocalFileFavorite(normalized)) {
    const computer = normalized._extra.computer;
    const previous = saved._extra.computer;
    Object.assign(computer, { starredAt: previous.starredAt, starSequence: previous.starSequence });
    if (previous.pendingStar) computer.pendingStar = previous.pendingStar;
    if (normalized.title === saved.title && JSON.stringify(computer) === JSON.stringify(previous)) return true;
    Object.assign(saved, normalized, { __revision: (saved.__revision || 0) + 1 });
    state.favorites = [...state.favorites];
    emit('favorites-change', state.favorites);
    return true;
  }
  keepStreamQuality(normalized, saved);
  // Dynamic favorites deliberately persist without short-lived stream/asset
  // URLs. If the player is resolving the favorite object itself, mutating that
  // same object with the restart-safe copy would erase the fresh stream before
  // it can be attached. Detach the persisted copy while playback keeps owning
  // the resolved runtime object; stable IDs preserve favorite/EQ identity.
  const next = [...state.favorites];
  next[index] = normalized;
  if (!persistFavorites(next)) return false;
  if (state.favorites[index] === item) state.favorites[index] = normalized;
  else Object.assign(state.favorites[index], normalized);
  return true;
}

export function portableFavoritesText(favorites) {
  return JSON.stringify(favorites.filter((item) => !isLocalFileFavorite(item)));
}

export function preserveLegacyLocalStars(storage) {
  if (storage === globalThis.localStorage && legacyLocalStars.length) {
    // A portable edit can replace the legacy list while migration is pending.
    // Keep a retry copy separate from the portable profile in that case.
    storage.setItem(LEGACY_LOCAL_STARS, JSON.stringify(legacyLocalStars));
  }
}

function persistFavorites(favorites = state.favorites) {
  try {
    preserveLegacyLocalStars(localStorage);
    localStorage.setItem(STORAGE_KEYS.favorites, portableFavoritesText(favorites));
    clearPersistenceFailure('favorites');
    scheduleProfileHandoff();
    return true;
  } catch (e) {
    console.warn('Could not persist favorites:', e);
    reportPersistenceFailure('favorites', 'Favorites could not be saved. Your previous saved list is unchanged. Check available disk space and retry; do not delete your app data.');
    return false;
  }
}

/** True when the saved favorites are known (read, or none saved); false
 *  when they could not be read. */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.favorites);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const retry = JSON.parse(localStorage.getItem(LEGACY_LOCAL_STARS) || '[]');
      const items = parsed.map((item) => normalizeFavoriteItem(item, { restart: true })).filter(Boolean);
      const legacy = [...(Array.isArray(retry) ? retry : []), ...items].filter(isLocalFileFavorite);
      legacyLocalStars = [...new Map(legacy.map((item) => [item.id, normalizeFavoriteItem(item)])).values()];
      state.favorites = items.filter((item) => !isLocalFileFavorite(item));
      if (raw && !legacyLocalStars.length) persistFavorites();
      return true;
    }
  } catch (e) { console.warn('Could not load favorites:', e); }
  return false;
}

/* ============ Settings ============ */

// The last settings JSON seen by this window. Another window can update or
// clear it before this one saves a different preference.
let savedSettingsRaw;
let savedExtraSettingsRaw;

function readExtraSettings(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (_) {}
  return {};
}

function extraSettings(settings) {
  return {
    tunerToneKnobs: settings.tunerToneKnobs === true,
    tunerStations: settings.tunerStations !== false,
    nowPlayingSurprise: settings.nowPlayingSurprise !== false,
    volumeLevelling: levellingMode(settings),
    levellingPreamp: levellingPreamp(settings),
  };
}

export function saveSettings(partial, authorization = null) {
  const requested = partial && typeof partial === 'object' && !Array.isArray(partial)
    ? { ...partial }
    : {};
  if (requested.showExplicitContent === true && authorization !== EXPLICIT_USER_GESTURE) {
    delete requested.showExplicitContent;
  }
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  let currentSettings = state.settings;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (savedSettingsRaw !== undefined && raw !== savedSettingsRaw) {
      currentSettings = normalizeSettings({
        ...(raw ? JSON.parse(raw) : null),
        ...extraSettings(currentSettings),
      });
    }
    const extra = localStorage.getItem(EXTRA_SETTINGS_STORAGE_KEY);
    if (extra !== savedExtraSettingsRaw) {
      currentSettings = { ...currentSettings, ...extraSettings(readExtraSettings(extra)) };
      savedExtraSettingsRaw = extra;
    }
  } catch (_) { /* Keep the settings in use when storage cannot be read. */ }
  state.settings = normalizeSettings({ ...currentSettings, ...requested });
  try {
    const { tunerToneKnobs, tunerStations, nowPlayingSurprise, volumeLevelling, levellingPreamp, ...legacySettings } = state.settings;
    const raw = JSON.stringify(legacySettings);
    localStorage.setItem(STORAGE_KEYS.settings, raw);
    savedSettingsRaw = raw;
    const updates = Object.fromEntries(
      Object.entries({ tunerToneKnobs, tunerStations, nowPlayingSurprise, volumeLevelling, levellingPreamp })
        .filter(([key]) => Object.hasOwn(requested, key)),
    );
    if (Object.keys(updates).length) {
      const extra = JSON.stringify({ ...readExtraSettings(savedExtraSettingsRaw), ...updates });
      localStorage.setItem(EXTRA_SETTINGS_STORAGE_KEY, extra);
      savedExtraSettingsRaw = extra;
    }
    clearPersistenceFailure('settings');
    scheduleProfileHandoff();
  } catch (e) {
    console.warn('Could not persist settings:', e);
    reportPersistenceFailure('settings', 'Settings could not be saved and may revert after restart. Check available disk space and retry.');
  }
  const nextExplicit = state.settings.showExplicitContent === true;
  if (nextExplicit !== previousExplicit) {
    emit('content-policy-change', {
      previous: previousExplicit,
      current: nextExplicit,
      currentItem,
    });
  }
  emit('settings-change', state.settings);
  applyTheme(state.settings.theme);
}

/** The sole runtime path that can turn explicit-content visibility on. */
export function setShowExplicitContent(enabled) {
  saveSettings({ showExplicitContent: enabled === true }, EXPLICIT_USER_GESTURE);
}

export function setSourceEnabled(sourceId, enabled) {
  const next = { ...state.settings.enabledSources, [sourceId]: enabled };
  saveSettings({ enabledSources: next });
}

function loadSettings() {
  state.settings = freshDefaultSettings();
  savedSettingsRaw = undefined;
  savedExtraSettingsRaw = undefined;
  try {
    savedSettingsRaw = localStorage.getItem(STORAGE_KEYS.settings);
    if (savedSettingsRaw) state.settings = normalizeSettings(JSON.parse(savedSettingsRaw));
  } catch (e) { console.warn('Could not load settings:', e); }
  Object.assign(state.settings, extraSettings({}));
  try {
    savedExtraSettingsRaw = localStorage.getItem(EXTRA_SETTINGS_STORAGE_KEY);
    Object.assign(state.settings, extraSettings(readExtraSettings(savedExtraSettingsRaw)));
  } catch (e) { console.warn('Could not load extra settings:', e); }
}

/* ============ Init ============ */

export async function initState() {
  // A localhost port is part of the browser origin. Restore a saved handoff
  // before reading any local keys when Settings deliberately changed that port.
  await restoreStartupProfileHandoff();
  removeComputerResumePaths();
  legacyLocalStars = [];
  migrationAttempted = false;
  localStarsStatus = 'idle';
  confirmedStars = new Map();
  favoritesKnown = loadFavorites();
  loadSettings();
  // Tidy only after the restore, when the saved favorites are known.
  if (favoritesKnown) {
    try {
      tidyStorageAtStart(localStorage, state.favorites.map((favorite) => favorite?.id));
    } catch (_) { /* storage unavailable */ }
  }
  try {
    for (const key of [EQ_STORAGE_KEY, EQ_EXTRA_STORAGE_KEY, STORAGE_KEYS.favoriteGroups, STORAGE_KEYS.favoriteNames]) {
      const raw = localStorage.getItem(key);
      const clean = portableProfileValue(key, raw);
      if (raw !== clean) localStorage.setItem(key, clean);
    }
  } catch (_) { /* storage unavailable */ }
  applyTheme(state.settings.theme);
  scheduleProfileHandoff();
  if (legacyLocalStars.length || /^https?:/.test(globalThis.location?.protocol || '')) void loadComputerStars();
}

/** Clears this window's saved data at once and returns a promise that settles
 *  when the native copy has also been cleared (rejects if it was not), so the
 *  caller can wait before reporting done. Not awaiting it is safe. */
export function clearCache() {
  const previousExplicit = state.settings.showExplicitContent === true;
  const currentItem = state.currentItem;
  const local = state.favorites.filter(isLocalFileFavorite);
  if (local.length) changeLocalStars([], local.map((item) => item.id));
  legacyLocalStars = [];
  try {
    localStorage.removeItem(LEGACY_LOCAL_STARS);
    localStorage.removeItem(STORAGE_KEYS.favorites);
    localStorage.removeItem(STORAGE_KEYS.settings);
    savedSettingsRaw = null;
    localStorage.removeItem(EXTRA_SETTINGS_STORAGE_KEY);
    savedExtraSettingsRaw = null;
    localStorage.removeItem(STORAGE_KEYS.volume);
    localStorage.removeItem(STORAGE_KEYS.jobs);
    localStorage.removeItem(STORAGE_KEYS.favoriteGroups);
    localStorage.removeItem(STORAGE_KEYS.favoriteNames);
    clearStreamLookups();
    clearStreamVerifications();
    localStorage.removeItem(STATION_STREAMS_KEY);
    clearDidNotPlayCache(); // "Did not play last time" marks (a cache)
    clearPlayedStreams(); // the format and bitrate stations played with (a cache)
    clearEqState(localStorage);
    localStorage.removeItem(PICTURE_STORAGE_KEY);
  } catch (_) {}
  clearPartResume();
  emit('part-resume-cleared');
  emit('picture-settings-cleared');
  cancelScheduledProfileHandoff();
  // The song log and starred songs are kept apart from the profile (see
  // song-log.js, starred-songs.js); they are cleared with it, here and in the
  // data folder.
  const nativeCleared = Promise.all([clearProfileHandoff(), songLog.clear(), starredSongs.clear()])
    .then(([cleared]) => cleared);
  nativeCleared.catch(() => {}); // Callers that do not wait must not see an unhandled rejection.
  state.favorites = [];
  state.settings = freshDefaultSettings();
  applyTheme(state.settings.theme);
  emit('favorites-change', []);
  if (previousExplicit) {
    emit('content-policy-change', {
      previous: true,
      current: false,
      currentItem,
    });
  }
  emit('settings-change', state.settings);
  return nativeCleared;
}
