/**
 * Tuner Mode — skeuomorphic dial for live radio + live TV.
 *
 * v1 simplification: dial rotation maps linearly to a 1D index into the current
 * station array. Mouse-drag or the mouse wheel over the dial rotates it. Arrow keys also work. Each station
 * shows its honest position in the current list ("12 of 80"), not a made-up
 * frequency that would change whenever the list reloads.
 *
 * Source "★ My favorites" puts only the user's starred stations for the band
 * on the dial (no network needed). That choice is remembered in settings.
 * Each favorites category with stations in it follows as its own entry
 * ("\u2605 Rock"), for this session; see lib/favorite-groups.js.
 */

import { browseLiveOne } from '../lib/search.js';
import { playItem, setTunerVideoBand } from '../lib/player.js';
import { subscribe, getState, saveSettings, isFavorite } from '../lib/state.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { contentBadgeText, filterContentItems, isContentAllowed } from '../lib/content-rating.js';
import { normalizeTunerCardSize, tunerCardsShowPictures } from '../lib/tuner-card-size.js';
import { artworkInitials } from '../lib/initials.js';
import { hasPicture } from '../lib/video-picture.js';
import { createTunerCardArt } from '../lib/tuner-card-art.js';
import { onStationImagesChange } from '../lib/station-images.js';
import {
  mergeSourceItems, failedSourceState, liveStatusText, refreshKeepsList, createLiveRetry, createSourceRetries,
  runLiveLoad,
} from '../lib/live-load.js';
import { favoritesInDisplayOrder, normalizeFavoritesSort } from '../lib/favorites-order.js';
import { favoriteNamesSnapshot, withFavoriteName } from '../lib/favorite-names.js';
import { FAVORITE_GROUPS_EVENT, favoriteGroupCounts, favoriteGroupsSnapshot } from '../lib/favorite-groups.js';
import { attachTunerBackground } from './tuner-background.js';
import { buildDialSvg, dialTurn, fitDialReadout, setDialStationName, wheelSteps } from './tuner-dial.js';
import { mountToneKnobs } from './tuner-tone-knobs.js';
import { placeTunerPart, tunerStageLayout } from './tuner-layout.js';
import { mountTunerStationList } from './tuner-station-list.js';
import {
  TUNER_BACKGROUND_RELEASED, tunerBackgroundLevelPatch, tunerBackgroundShownLevel,
} from '../lib/tuner-background.js';
import { bindVolumeStepper } from '../lib/volume-stepper.js';
import { onDidNotPlayChange } from '../lib/did-not-play.js';
import { didNotPlayNote } from '../lib/did-not-play-view.js';
import {
  compactStreamLabel, onPlayedStreamChange, stationStreamFacts, streamTooltipLine,
} from '../lib/played-streams.js';
import { formatStreamQuality } from '../lib/stream-quality.js';
import { lastOutsideAnswerAt, onOutsideAnswer } from '../lib/connection-evidence.js';

export { dialTurn, wheelSteps } from './tuner-dial.js';

const COUNTRIES = [
  { code: '', label: 'All countries' },
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'JP', label: 'Japan' },
  { code: 'BR', label: 'Brazil' },
  { code: 'AU', label: 'Australia' },
  { code: 'CA', label: 'Canada' },
  { code: 'IN', label: 'India' },
  { code: 'MX', label: 'Mexico' },
  { code: 'ZA', label: 'South Africa' },
];

const state = {
  band: 'radio',
  country: '',
  stations: [],
  index: 0,
  loading: false,
  loadGen: 0,
  rotationDeg: 0,
  requestAbort: null,
  sourceFilter: 'all', // 'all' | 'favorites' | 'favgroup:<category id>' | source id
  sourceStates: new Map(),
  enabledSignature: '',
  contentPreference: false,
  favoritesSort: '',
  cardSize: 'small', // Settings > Appearance > Tuner card size
  listKey: '', // band, country, source and settings the live list on the dial was loaded for
};

const ui = {};

// A dial left empty because a source failed tries again by itself (twice),
// only while the Tuner is on screen; any reload the user asks for cancels it.
const autoRetry = createLiveRetry({
  run: () => { loadStations({ automatic: true }); },
  // A try due while the window is hidden waits until it is shown again.
  isShown: () => getState().mode === 'tuner' && Boolean(ui.root?.isConnected),
});

// A source that failed while others answered is asked again by itself
// (after 15 s, 60 s, then every 5 minutes, and at once when the line seems
// back) while the Tuner stays open; any new load and leaving the Tuner
// cancel it (see lib/live-load.js).
const sourceRetries = createSourceRetries({
  isShown: () => getState().mode === 'tuner' && Boolean(ui.root?.isConnected),
  onAnswer: onOutsideAnswer,
  lastAnswerAt: lastOutsideAnswerAt,
});

/** Only load artwork for options in the visible part of the list. */
function artInView(box) {
  if (!ui.list?.isConnected || !box?.isConnected) return false;
  const view = ui.list.getBoundingClientRect();
  const rect = box.getBoundingClientRect();
  return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
}

// Pictures on medium and large cards; see lib/tuner-card-art.js for how they
// wait for the dial to rest and load only for cards in view.
const cardArt = createTunerCardArt({
  isInView: artInView,
  allowed: (item) => item?.__contentHidden !== true && isContentAllowed(item, getState().settings),
});

function cardPictures() {
  return tunerCardsShowPictures(state.cardSize);
}

function el(tag, opts = {}, ...children) {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  if (opts.style) Object.assign(e.style, opts.style);
  if (opts.text != null) e.textContent = opts.text;
  if (opts.html != null) e.innerHTML = opts.html;
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) e.addEventListener(k, v);
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function buildShell() {
  const root = el('div', {
    className: 'tuner-root',
    attrs: {
      tabindex: '0',
      'aria-label': 'Tuner dial. Use arrow keys to change station and Enter or Space to play.',
      'data-card-size': state.cardSize,
    },
  });
  ui.root = root;
  // Controls
  const controls = el('div', { className: 'tuner-controls' });
  const band = el('div', { className: 'tuner-band-switch' });
  for (const b of [{ id: 'radio', label: 'Radio' }, { id: 'tv', label: 'TV' }]) {
    const btn = el('button', {
      className: state.band === b.id ? 'is-active' : '',
      attrs: { 'data-band': b.id, 'aria-pressed': state.band === b.id ? 'true' : 'false' },
      on: { click: () => setBand(b.id) },
      text: b.label,
    });
    band.appendChild(btn);
  }
  controls.appendChild(band);
  const filter = el('div', { className: 'tuner-filter' });
  filter.appendChild(el('label', { text: 'Country:' }));
  ui.countrySel = el('select');
  for (const c of COUNTRIES) {
    const opt = el('option', { attrs: { value: c.code }, text: c.label });
    ui.countrySel.appendChild(opt);
  }
  ui.countrySel.value = state.country;
  ui.countrySel.addEventListener('change', () => { state.country = ui.countrySel.value; loadStations(); });
  filter.appendChild(ui.countrySel);
  ui.sourceSel = el('select', {
    attrs: { 'aria-label': 'Live media source' },
    on: { change: () => {
      state.sourceFilter = ui.sourceSel.value;
      const favoritesOnly = isFavoritesSource(state.sourceFilter);
      if ((getState().settings.tunerFavoritesOnly === true) !== favoritesOnly) {
        saveSettings({ tunerFavoritesOnly: favoritesOnly });
      }
      loadStations();
    } },
  });
  filter.appendChild(el('label', { text: 'Source:' }));
  filter.appendChild(ui.sourceSel);
  controls.appendChild(filter);
  const tools = el('div', { className: 'tuner-tools' });
  if (TUNER_BACKGROUND_RELEASED) tools.appendChild(buildVizLevel());
  ui.stationsToggle = el('button', {
    className: 'icon-btn tuner-toggle',
    attrs: {
      type: 'button', 'aria-pressed': 'true', 'aria-label': 'Stations',
      title: 'Show or hide the station list', 'aria-controls': 'tuner-stations',
    },
    html: `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M7 5h10M7 10h10M7 15h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="3" cy="5" r="1" fill="currentColor"/>
      <circle cx="3" cy="10" r="1" fill="currentColor"/>
      <circle cx="3" cy="15" r="1" fill="currentColor"/>
    </svg>`,
    on: {
      click: () => saveSettings({ tunerStations: getState().settings.tunerStations === false }),
      keydown: (event) => event.stopPropagation(),
    },
  });
  tools.appendChild(ui.stationsToggle);
  ui.toneToggle = el('button', {
    className: 'icon-btn tuner-toggle tuner-tone-toggle',
    attrs: {
      type: 'button', 'aria-pressed': 'false', 'aria-label': 'Tone knobs',
      title: 'Show Bass, Treble and Loudness knobs',
    },
    html: `<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M13.34 5.63l-1.27 1.27 1.03 1.03 1.27-1.27A5.5 5.5 0 1 1 13.34 5.63Z"/>
      <circle cx="3" cy="15" r="0.9"/><circle cx="1.6" cy="9" r="0.9"/>
      <circle cx="4.3" cy="3.7" r="0.9"/><circle cx="10" cy="1.5" r="0.9"/>
      <circle cx="15.7" cy="3.7" r="0.9"/><circle cx="18.4" cy="9" r="0.9"/>
      <circle cx="17" cy="15" r="0.9"/>
    </svg>`,
    on: {
      click: () => saveSettings({ tunerToneKnobs: !getState().settings.tunerToneKnobs }),
      keydown: (event) => event.stopPropagation(),
    },
  });
  tools.appendChild(ui.toneToggle);
  controls.appendChild(tools);
  root.appendChild(controls);

  const stage = el('div', { className: 'tuner-stage' });
  ui.stage = stage;
  ui.placeholderArt = el('canvas', { attrs: { width: 112, height: 112, 'aria-hidden': 'true' } });
  ui.placeholderName = el('strong');
  ui.placeholderStatus = el('small');
  ui.placeholder = el('div', { className: 'tuner-picture-placeholder' },
    ui.placeholderArt, ui.placeholderName, ui.placeholderStatus);
  ui.placeholder.hidden = true;
  stage.appendChild(ui.placeholder);
  const content = el('div', { className: 'tuner-list-content', attrs: { role: 'presentation' } });
  ui.list = el('div', {
    className: 'tuner-station-list',
    attrs: { id: 'tuner-stations', tabindex: '-1', role: 'listbox', 'aria-label': 'Stations' },
  }, content);
  ui.empty = el('div', { className: 'tuner-empty', attrs: { role: 'status' } });
  ui.status = el('div', { className: 'tuner-list-caption', attrs: { role: 'status', 'aria-live': 'polite' } });
  ui.listColumn = el('div', { className: 'tuner-station-column' }, ui.list, ui.empty, ui.status);
  ui.listColumn.hidden = true;
  ui.listHeight = 0;
  ui.stationList = mountTunerStationList(ui.list, content, {
    makeOption: makeStationOption,
    tune(index, { pointer = false } = {}) {
      state.rotationDeg = restingRotation(index);
      applyRotation({ pointer });
      tuneCurrent({ pointer });
    },
    onRender: () => { if (cardPictures()) cardArt.commit(); },
    onScroll: () => { if (cardPictures()) cardArt.poke(); },
  });
  ui.listContent = content;
  stage.appendChild(ui.listColumn);
  const dialWrap = el('div', { className: 'tuner-dial' });
  ui.dialWrap = dialWrap;
  dialWrap.innerHTML = buildDialSvg();
  ui.dialSvg = dialWrap.querySelector('svg');
  ui.dialPointer = dialWrap.querySelector('.tuner-pointer');
  ui.dialBody = dialWrap.querySelector('.dial-body');
  ui.unbindDial = bindDialEvents(dialWrap);

  const freq = el('div', { className: 'tuner-frequency' });
  ui.freqNum = el('div', { className: 'freq-num', text: '—' });
  ui.freqUnit = el('div', { className: 'freq-unit', text: '' });
  ui.stationName = el('div', { className: 'station-name', text: state.loading ? 'Loading…' : 'No station' });
  freq.appendChild(ui.freqNum);
  freq.appendChild(ui.freqUnit);
  freq.appendChild(ui.stationName);
  dialWrap.appendChild(freq);
  const needle = dialWrap.querySelector('.tuner-dial-needle');
  ui.fitReadout = () => fitDialReadout(dialWrap, freq, needle);

  stage.appendChild(dialWrap);
  root.appendChild(stage);

  // Keyboard
  root.addEventListener('keydown', (e) => {
    // The Visualizer strength stepper has its own arrow keys, Enter and Space.
    if (ui.vizLevel?.contains?.(e.target)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tuneCurrent(); }
  });

  return root;
}

/** How strongly the Visualizer shows behind the Tuner: down, the level
 *  (0-100, the layer's opacity in percent) and up, the player bar's volume
 *  stepper in a row (lib/volume-stepper.js: a click 1, held repeats, the
 *  wheel 2 a notch, arrow keys). 0 is the Settings switch off; up from 0
 *  turns it on (lib/tuner-background.js tunerBackgroundLevelPatch). */
function buildVizLevel() {
  const chevron = (d) => `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const down = el('button', {
    className: 'volume-step',
    attrs: { type: 'button', 'aria-label': 'Visualizer behind the Tuner fainter', title: 'Fainter' },
    html: chevron('M2 3.5 5 6.5 8 3.5'),
  });
  const readout = el('output', { className: 'volume-led', attrs: { 'aria-live': 'polite' } });
  const up = el('button', {
    className: 'volume-step',
    attrs: { type: 'button', 'aria-label': 'Visualizer behind the Tuner stronger', title: 'Stronger' },
    html: chevron('M2 6.5 5 3.5 8 6.5'),
  });
  const group = el('div', {
    className: 'volume-stepper is-row',
    attrs: { role: 'group', 'aria-label': 'Visualizer behind the Tuner' },
  }, down, readout, up);
  // It can take focus (not in the Tab order; the buttons are): a click on
  // the label or the number leaves the keys here. Without it the click put
  // focus on the Tuner itself, and the arrow keys then changed the station
  // instead of the level.
  const wrap = el('div', { className: 'tuner-viz-level', attrs: { tabindex: '-1' } },
    el('span', { className: 'tuner-viz-level-label', text: 'Visualizer:', attrs: { 'aria-hidden': 'true' } }),
    group);
  ui.vizLevel = wrap;
  ui.vizLevelGroup = group;
  ui.vizLevelReadout = readout;
  // Keys and the wheel anywhere on it, the label too.
  subs.push(bindVolumeStepper({
    group: wrap, down, up,
    getVolume: () => tunerBackgroundShownLevel(getState().settings),
    setVolume: (level) => {
      const patch = tunerBackgroundLevelPatch(getState().settings, level);
      if (patch) saveSettings(patch);
    },
  }));
  syncVizLevel();
  return wrap;
}

/** The stepper shows the saved state (it changes here or in Settings). */
function syncVizLevel(settings = getState().settings) {
  if (!ui.vizLevelReadout) return;
  const level = tunerBackgroundShownLevel(settings);
  const text = String(level);
  if (ui.vizLevelReadout.textContent !== text) ui.vizLevelReadout.textContent = text;
  ui.vizLevelReadout.setAttribute('aria-label', level ? `Visualizer behind the Tuner ${level}` : 'Visualizer behind the Tuner off');
  ui.vizLevel.classList.toggle('is-off', level === 0);
  const when = settings.visualizerNoticeSeen === true
    ? 'shown during music, TV, or video playback'
    : 'shown during music, TV, or video playback after accepting the flashing notice in the Visualizer tab';
  ui.vizLevelGroup.title = level
    ? `Visualizer behind the Tuner: ${level} of 100 (0 turns it off), ${when}`
    : `Visualizer behind the Tuner: off. Up turns it on, ${when}`;
}

/** Angle the knob rests at for a place in the list: 12 degrees per station,
 *  so the first station is always back at the top. Without this, going
 *  round a list whose length is not a multiple of 30, or letting go of a
 *  drag between two stations, left the marker at an arbitrary angle. */
export function restingRotation(index) {
  return index * 12;
}

/** A dial holding one station (or none) has nowhere to turn to. */
export function dialCanTurn(count) {
  return count > 1;
}

const WHEEL_TUNE_DELAY_MS = 250;

function bindDialEvents(wrap) {
  let dragging = false;
  let lastAngle = 0;
  let downIndex = 0;
  const wheelPool = { px: 0 };
  let wheelTuneTimer = null;

  function angleFromEvent(e) {
    const rect = wrap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX ?? e.touches?.[0]?.clientX) - cx;
    const dy = (e.clientY ?? e.touches?.[0]?.clientY) - cy;
    return Math.atan2(dy, dx) * 180 / Math.PI;
  }

  function onDown(e) {
    if (state.stations.length === 0) return;
    dragging = true;
    downIndex = state.index;
    wrap.classList.add('dragging');
    lastAngle = angleFromEvent(e);
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging || !dialCanTurn(state.stations.length)) return;
    const a = angleFromEvent(e);
    state.rotationDeg += dialTurn(lastAngle, a);
    lastAngle = a;
    applyRotation();
  }
  // Mouse wheel: one station per notch. The dial moves at once, but the
  // station is only tuned when the wheel rests, so a fast scroll does not
  // start and abandon a stream for every station it passes.
  function onWheel(e) {
    if (state.stations.length === 0) return;
    // Ctrl + wheel (or a touchpad pinch) is the window's zoom: left alone.
    if (e.ctrlKey) return;
    e.preventDefault();
    if (!dialCanTurn(state.stations.length)) return;
    const steps = wheelSteps(wheelPool, e);
    if (steps === 0) return;
    state.rotationDeg = (state.index + steps) * 12;
    applyRotation();
    settleDial();
    clearTimeout(wheelTuneTimer);
    wheelTuneTimer = setTimeout(() => { wheelTuneTimer = null; tuneCurrent(); }, WHEEL_TUNE_DELAY_MS);
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    settleDial();
    // Letting go on the station that is already playing must not restart it.
    tuneCurrent({ restart: state.index !== downIndex });
  }

  wrap.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);

  // Return cleanup so the mode tear-down can detach.
  return () => {
    clearTimeout(wheelTuneTimer);
    wheelTuneTimer = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };
}

function applyRotation({ pointer = false } = {}) {
  if (!ui.dialBody) return;
  if (!pointer) ui.stationList?.clearPointerSelection();
  ui.dialBody.setAttribute('transform', `rotate(${state.rotationDeg} 200 200)`);
  if (state.stations.length === 0) return;
  const degPerStation = 12;
  let idx = Math.round(state.rotationDeg / degPerStation) % state.stations.length;
  if (idx < 0) idx += state.stations.length;
  state.index = idx;
  updateFrequencyDisplay();
  renderStationList();
}

/** Bring the knob to its resting angle for the current station. */
function settleDial() {
  if (state.stations.length === 0) return;
  state.rotationDeg = restingRotation(state.index);
  ui.dialBody?.setAttribute('transform', `rotate(${state.rotationDeg} 200 200)`);
}

function updateFrequencyDisplay() {
  const s = state.stations[state.index];
  if (!s) {
    ui.freqNum.textContent = '—';
    ui.freqUnit.textContent = '';
    ui.stationName.textContent = state.loading ? 'Loading…' : 'No station';
    ui.stationName.removeAttribute('title');
    ui.fitReadout();
    return;
  }
  ui.freqNum.textContent = String(state.index + 1);
  ui.freqUnit.textContent = `of ${state.stations.length}`;
  // Only the name: the knob has little room. The source stays on the
  // station's option in the list: its second line (so also the option's
  // accessible name) and its tooltip.
  setDialStationName(ui.stationName, `${isFavorite(s.id) ? '\u2605\u00a0' : ''}${s.title}`);
  // A long name ends in an ellipsis on the dial; the whole name on hover.
  ui.stationName.setAttribute('title', s.title || '');
  ui.fitReadout();
}

function liveSources() {
  return SOURCES.filter((source) => (
    source.types.includes(state.band)
    && source.capabilities.some((capability) => capability === 'live' || capability.startsWith('live '))
    && getState().settings.enabledSources[source.id] !== false
  ));
}

function enabledSignature(settings = getState().settings) {
  return SOURCES.map((source) => (
    settings.enabledSources[source.id] === false ? '0' : '1'
  )).join('');
}

function contentAwareLiveSourceIds() {
  return new Set(liveSources()
    .filter((source) => source.capabilities.includes('content ratings'))
    .map((source) => source.id));
}

const FAVORITES = 'favorites';
const FAVORITE_GROUP_PREFIX = 'favgroup:';

/** "My favorites" or one of its categories: starred stations only, no network. */
function isFavoritesSource(value) {
  return value === FAVORITES || String(value || '').startsWith(FAVORITE_GROUP_PREFIX);
}

function favoriteGroupSource(value = state.sourceFilter) {
  return String(value || '').startsWith(FAVORITE_GROUP_PREFIX) ? value.slice(FAVORITE_GROUP_PREFIX.length) : '';
}

/** The categories offered on the Source list: those holding at least one
 *  favorite (of any band), in the order they were made. */
export function tunerFavoriteGroups(favorites = getState().favorites) {
  const { counts } = favoriteGroupCounts(favorites);
  return favoriteGroupsSnapshot().groups.filter((group) => (counts.get(group.id) || 0) > 0);
}

/** The Source choice to keep: a category that was deleted or has no
 *  favorites left falls back to "My favorites"; anything else stays. */
export function keptFavoriteSource(value, favorites = getState().favorites) {
  const groupId = favoriteGroupSource(value);
  if (!groupId) return value;
  return tunerFavoriteGroups(favorites).some((group) => group.id === groupId) ? value : FAVORITES;
}

function reconcileFavoriteGroupSource() {
  state.sourceFilter = keptFavoriteSource(state.sourceFilter);
}

function rebuildSourceSelect() {
  const sources = liveSources();
  reconcileFavoriteGroupSource();
  if (state.sourceFilter !== 'all' && !isFavoritesSource(state.sourceFilter)
      && !sources.some(({ id }) => id === state.sourceFilter)) {
    state.sourceFilter = 'all';
  }
  ui.sourceSel.innerHTML = '';
  ui.sourceSel.appendChild(el('option', { attrs: { value: 'all' }, text: 'All live sources' }));
  ui.sourceSel.appendChild(el('option', { attrs: { value: FAVORITES }, text: '★ My favorites' }));
  for (const group of tunerFavoriteGroups()) {
    ui.sourceSel.appendChild(el('option', {
      attrs: { value: FAVORITE_GROUP_PREFIX + group.id, title: group.name }, text: `\u2605 ${group.name}`,
    }));
  }
  for (const source of sources) {
    ui.sourceSel.appendChild(el('option', { attrs: { value: source.id }, text: source.displayName }));
  }
  ui.sourceSel.value = state.sourceFilter;
}

function renderStationCaption() {
  if (!ui.status) return;
  const count = state.stations.length;
  if (isFavoritesSource(state.sourceFilter)) {
    const groupName = favoriteGroupsSnapshot().nameOf(favoriteGroupSource());
    const { text, title } = favoriteStationCaption(count, getState().favorites, {
      band: state.band, country: state.country, settings: getState().settings, groupId: favoriteGroupSource(), groupName,
    });
    setStationCaption(text, title);
    return;
  }
  const status = {
    count,
    noun: state.band === 'radio' ? 'stations' : 'channels',
    sourceStates: state.sourceStates,
    loading: state.loading,
    sourceCount: chosenLiveSourceCount(),
  };
  setStationCaption(liveStatusText({ ...status, compact: true }), liveStatusText(status));
}

function setStationCaption(text, title) {
  ui.status.title = title;
  if (ui.status.textContent === text) return;
  ui.status.textContent = text;
  ui.captionMeasure ||= document.createElement('canvas').getContext('2d');
  const font = getComputedStyle(ui.status);
  ui.captionMeasure.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
  ui.layout?.captionWidth(Math.ceil(ui.captionMeasure.measureText(text).width));
}

/** How many live sources the chosen source filter asks. */
function chosenLiveSourceCount() {
  return liveSources().filter((source) => state.sourceFilter === 'all' || source.id === state.sourceFilter).length;
}

/** The only way the station list changes, so the dial's hover glow
 *  (`can-turn`) always matches whether the wheel can turn it. */
function setStations(stations) {
  state.stations = stations;
  ui.dialWrap?.classList.toggle('can-turn', dialCanTurn(stations.length));
}

/** Put one source's stations on the dial without moving the user's place. */
function publishStations(sourceId, items, fallbackId = '') {
  const keepId = state.stations[state.index]?.id || fallbackId;
  setStations(mergeSourceItems(state.stations, sourceId, items, state.band));
  const kept = keepId ? state.stations.findIndex((item) => item.id === keepId) : -1;
  state.index = kept >= 0 ? kept : Math.min(state.index, Math.max(0, state.stations.length - 1));
  // Re-anchor the dial: the station count changed, so the old angle would
  // map to a different station.
  state.rotationDeg = state.index * 12;
  applyRotation();
  renderStationCaption();
}

/** True when `station` is the item the player is playing right now. */
export function alreadyPlaying(station, appState) {
  return Boolean(station?.id && appState?.isPlaying && appState.currentItem?.id === station.id);
}

function step(dir) {
  if (state.stations.length === 0) return;
  // One station: the dial stays put. Start it if it is not playing, but
  // never spin the dial or restart the stream for a "change" to itself.
  if (!dialCanTurn(state.stations.length)) {
    tuneCurrent({ restart: false });
    return;
  }
  state.rotationDeg += dir * 12;
  applyRotation();
  settleDial();
  tuneCurrent();
}

function tuneCurrent({ restart = true, pointer = false } = {}) {
  const s = state.stations[state.index];
  if (!s) return;
  if (!pointer) ui.stationList?.clearPointerSelection();
  renderStationList(true);
  if (!restart && alreadyPlaying(s, getState())) return;
  playItem(s).catch((err) => console.warn('play failed:', err));
}

/** Starred stations for the current band (and country, when one is chosen),
 *  in the order the Library shows favorites ("My order" or A-Z, from
 *  settings.favoritesSort). With `groupId`, only that category's stations.
 *  Purely local: no source requests. */
export function favoriteStations(favorites, { band, country = '', settings = {}, groupId = '' } = {}) {
  const seen = new Set();
  const groups = groupId ? favoriteGroupsSnapshot() : null;
  const matches = favoritesInDisplayOrder(favorites, settings).filter((item) => (
    item?.id && item.type === band
    && (!country || String(item.country || '').toUpperCase() === country)
    && (!groups || groups.groupOf(item.id) === groupId)
    && !seen.has(item.id) && seen.add(item.id)
  ));
  // A renamed favorite is shown on the dial and the cards under its new name.
  const { names } = favoriteNamesSnapshot();
  return filterContentItems(matches, settings).map((item) => withFavoriteName(item, names));
}

/** What the empty list says for the live sources: a source that did not
 *  answer is not "no stations". `retry` tells whether an automatic try is
 *  waiting (`waiting`) and how many were made (`tries`). */
export function emptyLiveText(loading, sourceStates, retry = {}) {
  if (loading) return 'Loading stations…';
  const failed = [...(sourceStates?.values?.() || [])].some((status) => status?.state === 'error');
  if (!failed) return 'No stations found for this country.';
  if (retry.waiting) {
    return 'The stations could not be loaded. Trying again by itself in a few seconds, or press Radio or TV above to try now.';
  }
  if (retry.tries > 0) {
    return 'The stations could not be loaded, also after trying again. Press Radio or TV above to try again.';
  }
  return 'The stations could not be loaded. Press Radio or TV above to try again.';
}

/** What the live list on the dial depends on; a reload with the same key
 *  keeps the list (see refreshKeepsList in lib/live-load.js). */
export function tunerListKey({ band, country = '', sourceFilter = 'all', enabled = '', showExplicit = false } = {}) {
  return [band, country, sourceFilter, enabled, showExplicit ? 'explicit' : 'filtered'].join('|');
}

function currentListKey() {
  return tunerListKey({
    band: state.band, country: state.country, sourceFilter: state.sourceFilter,
    enabled: enabledSignature(), showExplicit: getState().settings.showExplicitContent === true,
  });
}

/** The tooltip also explains where to find favorites saved in the other band. */
export function favoriteStationCaption(count, favorites, { band, groupName, ...filters }) {
  const other = band === 'radio' ? 'tv' : 'radio';
  const otherName = other === 'tv' ? 'TV' : 'Radio';
  const otherCount = favoriteStations(favorites, { ...filters, band: other }).length;
  const noun = band === 'radio' ? 'station' : 'channel';
  const base = `${count} favorite ${noun}${count === 1 ? '' : 's'}${groupName ? ` in ${groupName}` : ''}`;
  if (!otherCount) return { text: base, title: base };
  return {
    text: `${base} · ${otherCount} more in ${otherName}`,
    title: `${base} · ${otherCount} more saved as ${other === 'tv' ? 'TV' : 'radio'} (switch to ${otherName} to see ${otherCount === 1 ? 'it' : 'them'})`,
  };
}

/** Where the dial lands after its list is rebuilt: on the selected station
 *  when it is still listed, otherwise on the first station. */
export function keptStationIndex(stations, selectedId) {
  const kept = selectedId ? (stations || []).findIndex((item) => item?.id === selectedId) : -1;
  return kept >= 0 ? kept : 0;
}

function loadFavoriteStations() {
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  state.sourceStates = new Map();
  state.listKey = '';
  autoRetry.reset();
  sourceRetries.stop();
  const selectedId = state.stations[state.index]?.id || getState().currentItem?.id || '';
  reconcileFavoriteGroupSource();
  setStations(favoriteStations(getState().favorites, {
    band: state.band, country: state.country, settings: getState().settings,
    groupId: favoriteGroupSource(),
  }));
  // A reorder or a new sort keeps the dial on the same station, and nothing
  // here tunes, so the stream playing now is not restarted.
  state.index = keptStationIndex(state.stations, selectedId);
  state.rotationDeg = state.index * 12;
  rebuildSourceSelect();
  applyRotation();
  updateFrequencyDisplay();
  renderStationList();
  renderStationCaption();
}

async function loadStations({ onlySourceIds = null, preserve = false, automatic = false } = {}) {
  if (isFavoritesSource(state.sourceFilter)) {
    loadFavoriteStations();
    return;
  }
  // Any reload the user asks for (band, country, source, opening the Tuner)
  // cancels a waiting automatic try and starts its count again.
  if (!automatic) autoRetry.reset();
  const gen = ++state.loadGen;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = true;
  const selectedId = state.stations[state.index]?.id || '';
  rebuildSourceSelect();
  const key = currentListKey();
  // The same view asked again keeps its list: each source's stations are
  // replaced when it answers, and a source that fails keeps its earlier ones.
  const refresh = !preserve && refreshKeepsList(state.listKey, key, state.stations);
  state.listKey = key;
  if (!preserve && !refresh) {
    setStations([]);
    state.index = 0;
    state.rotationDeg = 0;
  }
  applyRotation();
  if (refresh) {
    updateFrequencyDisplay();
  } else {
    ui.stationName.textContent = 'Loading…';
    ui.stationName.removeAttribute('title');
    ui.fitReadout();
  }
  renderStationList();
  // The sources this load asks, each marked as loading before the status
  // line is drawn: it counts only those, and a kept list is never shown as
  // coming "from 0 sources".
  const candidates = liveSources().filter((source) => (
    (state.sourceFilter === 'all' || source.id === state.sourceFilter)
    && (!onlySourceIds || onlySourceIds.has(source.id))
  ));
  // This load asks its sources itself: their automatic tries end (all of
  // them, unless it only asks some again: see applyContentPreference).
  sourceRetries.stop(preserve ? candidates.map((source) => source.id) : null);
  if (!preserve) state.sourceStates = new Map();
  for (const source of candidates) {
    state.sourceStates.set(source.id, refresh
      ? { state: 'loading', count: state.stations.filter((item) => item.source === source.id).length, refreshing: true }
      : { state: 'loading', count: 0 });
  }
  renderStationCaption();
  try {
    const opts = { limit: 80, type: state.band };
    if (state.country) opts.country = state.country;
    if (candidates.length === 0) {
      if (!preserve) setStations([]);
      state.loading = false;
      updateFrequencyDisplay();
      renderStationList();
      renderStationCaption();
      return;
    }
    const controller = new AbortController();
    state.requestAbort = controller;
    // An automatic try of one source is a job of its own (`attempt`), never
    // joined to the request that failed.
    const ask = (source, signal, attempt = 0) => catalogScheduler.enqueue({
      sourceId: source.id,
      key: `tuner:${gen}:${state.band}${attempt ? `:retry${attempt}` : ''}`,
      priority: CATALOG_PRIORITY.USER,
      signal,
      task: ({ signal: taskSignal }) => browseLiveOne(source.id, { ...opts, signal: taskSignal }),
    });
    const onItems = (source, items) => {
      state.sourceStates.set(source.id, { state: 'ready', count: items.length });
      sourceRetries.succeeded(source.id);
      publishStations(source.id, items, selectedId);
    };
    const onFailed = (source, message, error) => {
      // Its stations from the previous load stay on the dial, and it is
      // asked again by itself while the Tuner stays open.
      state.sourceStates.set(source.id, failedSourceState(state.stations, source.id, message));
      renderStationCaption();
      sourceRetries.fail(source, retrySource, {
        error, declaredMs: catalogScheduler.declaredCooldownRemainingMs(source.id),
      });
    };
    // One source asked again: it arrives on the dial as a late answer does.
    const retrySource = (source, signal, isCurrent, attempt) => runLiveLoad({
      candidates: [source],
      signal,
      ask: (one, oneSignal) => ask(one, oneSignal, attempt),
      isCurrent,
      onItems: (one, items) => {
        onItems(one, items);
        // An empty dial's line no longer blames this source.
        if (state.stations.length === 0) renderStationList();
      },
      onFailed,
      onDone() {},
    });
    // Each source goes on the dial as soon as it answers; a slow or stalled
    // source no longer holds the others back, and a load overtaken by a newer
    // one changes nothing (see lib/live-load.js).
    await runLiveLoad({
      candidates,
      signal: controller.signal,
      ask,
      isCurrent: () => gen === state.loadGen,
      onItems,
      onFailed,
      onDone: finishLoad,
    });
    return;
  } catch (err) {
    if (gen !== state.loadGen) return;
    if (err?.name !== 'AbortError') console.warn('Tuner load failed:', err);
    if (!preserve && !refresh) setStations([]);
  }
  if (gen === state.loadGen) finishLoad();
}

/** The end of a live load that is still the current one. */
function finishLoad() {
  state.requestAbort = null;
  state.loading = false;
  // While the whole dial is tried again, single sources are not.
  if (autoRetry.settle(state.stations.length === 0
    && [...state.sourceStates.values()].some((status) => status.state === 'error'))) sourceRetries.stop();
  updateFrequencyDisplay();
  renderStationList();
  renderStationCaption();
}

function applyContentPreference(showExplicit) {
  // A policy change owns the active generation. If the initial/all-source
  // load has not settled, restart that generation under the new policy so
  // aborting its shared controller cannot strand unrelated live sources.
  if (state.loading) {
    loadStations();
    return;
  }
  if (showExplicit) {
    loadStations({ onlySourceIds: contentAwareLiveSourceIds(), preserve: true });
    return;
  }
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  const selectedId = state.stations[state.index]?.id || '';
  setStations(filterContentItems(state.stations, false));
  // The list now matches the new setting, so a later reload keeps it.
  state.listKey = currentListKey();
  const restoredIndex = selectedId
    ? state.stations.findIndex((item) => item.id === selectedId)
    : -1;
  state.index = restoredIndex >= 0
    ? restoredIndex
    : Math.min(state.index, Math.max(0, state.stations.length - 1));
  state.rotationDeg = state.index * 12;
  for (const [sourceId, status] of state.sourceStates) {
    if (status.state === 'ready') {
      state.sourceStates.set(sourceId, {
        ...status,
        count: state.stations.filter((item) => item.source === sourceId).length,
      });
    }
  }
  applyRotation();
  updateFrequencyDisplay();
  renderStationList();
  renderStationCaption();
}

function setBand(b) {
  state.band = b;
  setTunerVideoBand(b);
  ui.layout?.sync();
  // "My favorites" (and its categories) applies to both bands; a specific source may not.
  if (!isFavoritesSource(state.sourceFilter)) state.sourceFilter = 'all';
  for (const btn of document.querySelectorAll('.tuner-band-switch button')) {
    const active = btn.dataset.band === b;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  loadStations();
}

// Copy decoded pixels only. Drawing an existing image never resolves a URL.
export function paintTunerPlaceholder(parts, station, currentItem, playerArt) {
  parts.placeholderName.textContent = station?.title || '';
  parts.placeholderStatus.textContent = currentItem ? 'Loading…' : 'Stopped';
  const cardImage = parts.list.querySelector('.is-active .pill-art-img');
  const img = station?.id && playerArt?.dataset.stationId === station.id && playerArt.complete && playerArt.naturalWidth
    ? playerArt : cardImage;
  const canvas = parts.placeholderArt;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img?.complete && img.naturalWidth && img.naturalHeight) {
    const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  } else {
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(artworkInitials(station?.title || ''), canvas.width / 2, canvas.height / 2, canvas.width);
  }
}

function syncPlaceholder() {
  if (ui.placeholder.hidden) return;
  paintTunerPlaceholder(ui, state.stations[state.index], getState().currentItem, document.getElementById('player-art'));
}

function renderStationList(force = false) {
  if (!ui.stationList) return;
  const empty = state.stations.length === 0;
  ui.list.hidden = empty;
  ui.empty.hidden = !empty;
  if (ui.layout?.count(state.stations.length)) return;
  ui.stationList.update(state.stations, state.index, ui.listHeight, state.cardSize, force, ui.columns);
  syncPlaceholder();
  if (!empty || !ui.emptyHeight) return;
  let text = emptyLiveText(state.loading, state.sourceStates,
    { waiting: autoRetry.waiting(), tries: autoRetry.tries() });
  const groupName = favoriteGroupsSnapshot().nameOf(favoriteGroupSource());
  if (groupName) {
    const what = state.band === 'radio' ? 'radio stations' : 'TV channels';
    text = state.country
      ? `No favorite ${what} in ${groupName} for this country.`
      : `No favorite ${what} in ${groupName}.`;
  } else if (state.sourceFilter === FAVORITES) {
    const what = state.band === 'radio' ? 'radio stations' : 'TV channels';
    text = state.country
      ? `No favorite ${what} for this country.`
      : `No favorite ${what} yet. Choose All live sources, tune around, and star (☆) the ones you like.`;
  }
  if (ui.empty.textContent !== text) ui.empty.textContent = text;
}

export function makeStationOption(station, selected) {
  const saved = isFavorite(station.id);
  const rating = contentBadgeText(station);
  const sourceLine = el('small', { className: 'tuner-station-details' });
  const picture = cardPictures() ? cardArt.box(station) : null;
  const title = station.title || '';
  const pill = el('div', {
    className: 'station-pill' + (selected ? ' is-active' : '') + (saved ? ' is-favorite' : '')
      + (picture ? ' has-art' : ''),
  },
  picture,
  el('div', { className: 'tuner-station-text' },
    el('span', { className: 'tuner-station-name', attrs: { title }, text: saved ? `★ ${title}` : title }),
    sourceLine),
  rating ? el('span', { className: 'content-rating-badge', text: rating }) : null);
  pill.__sourceLine = sourceLine;
  pill.__station = station;
  pill.__saved = saved;
  setPillTrouble(pill);
  return pill;
}

/** A card's "Did not play last time" mark (the user's own stations only),
 *  its tooltip and its accessible text, updated in place. */
function setPillTrouble(pill) {
  const s = pill.__station;
  if (!s) return;
  const trouble = didNotPlayNote(s);
  const stream = streamTooltipLine(setPillStream(pill));
  pill.classList.toggle('has-trouble', Boolean(trouble));
  pill.setAttribute('title',
    `${pill.__saved ? '★ Favorite · ' : ''}${s.title} · ${getSourceLabel(s.source)}${stream ? `\n${stream}` : ''}`
    + `${trouble ? `\n${trouble}` : ''}`);
  let mark = pill.__trouble || null;
  if (!trouble) {
    mark?.remove();
    pill.__trouble = null;
    return;
  }
  if (!mark) {
    // Last, laid over the card's corner: it takes no place in the card's grid.
    mark = el('span', { className: 'pill-trouble', text: '!', attrs: { role: 'img' } });
    pill.appendChild(mark);
    pill.__trouble = mark;
  }
  if (mark.getAttribute('aria-label') !== trouble) mark.setAttribute('aria-label', trouble);
}

/** Update the second line and return the full stream label for the tooltip. */
function setPillStream(pill) {
  const station = pill.__station;
  const facts = stationStreamFacts(station);
  const source = getSourceLabel(station.source);
  const country = String(station.country || '').toUpperCase();
  const radio = station.type === 'radio';
  // Directory facts are already on the item, even before its first play.
  const radioFacts = radio ? {
    codec: facts.codec || station._extra?.codec,
    bitrate: facts.bitrate || station._extra?.bitrate,
  } : null;
  const quality = radio ? compactStreamLabel(radioFacts) : '';
  const text = [source, country, quality].filter(Boolean).join(' · ');
  if (pill.__sourceLine && pill.__sourceLine.textContent !== text) pill.__sourceLine.textContent = text;
  return formatStreamQuality(radio ? { ...facts, ...radioFacts } : facts);
}

/** A mark or a stream label changes in place without moving the list. */
export function syncTunerMarks(content = ui.listContent) {
  for (const pill of Array.from(content?.children || [])) setPillTrouble(pill);
}

/** Show the card size chosen in Settings, at once. */
function applyCardSize(size) {
  const next = normalizeTunerCardSize(size);
  if (next === state.cardSize) return;
  state.cardSize = next;
  ui.root?.setAttribute('data-card-size', next);
  if (!cardPictures()) cardArt.clear();
}

/** The band the Tuner is on ('radio' or 'tv'); used for dropped playlists. */
export function tunerBand() { return state.band; }

export function bindTunerLayout(host, stage, onLayout, band = () => state.band) {
  const app = host.parentElement;
  let settings = getState().settings;
  let lastInputs;
  let count = state.stations.length;
  let captionWidth = 0;
  const video = document.getElementById('video-el');
  const events = new AbortController();
  for (const name of ['loadeddata', 'resize', 'emptied', 'playing']) {
    video.addEventListener(name, sync, { signal: events.signal });
  }
  const dockProperties = ['left', 'bottom', 'width', 'height'].map(key => '--tuner-picture-' + key);

  function sync() {
    const { width, height } = stage.getBoundingClientRect();
    const inputs = {
      width, height, count, captionWidth, band: band(), cardSize: settings.tunerCardSize, stations: settings.tunerStations !== false,
      tone: settings.tunerToneKnobs === true, large: app.classList.contains('video-large'),
      reserved: app.classList.contains('tuner-video-reserved') || app.classList.contains('has-video'),
      hasVideo: app.classList.contains('has-video') && hasPicture(video) && video.readyState >= 2,
    };
    if (lastInputs && Object.keys(inputs).every(key => inputs[key] === lastInputs[key])) return;
    lastInputs = inputs;
    const result = tunerStageLayout(inputs);
    const p = result.picture;
    if (p) {
      const values = [p.x, height - p.y - p.height, p.width, p.height];
      dockProperties.forEach((property, i) => app.style.setProperty(property, values[i] + 'px'));
    } else {
      for (const property of dockProperties) app.style.removeProperty(property);
    }
    onLayout(result);
  }

  const observer = new ResizeObserver(sync);
  observer.observe(stage, { box: 'border-box' });
  const changes = new MutationObserver(sync);
  changes.observe(app, { attributes: true, attributeFilter: ['class'] });
  sync();
  return {
    sync,
    captionWidth(next) {
      captionWidth = next;
      sync();
    },
    count(next) {
      if (count === next) return false;
      count = next;
      sync();
      return true;
    },
    settings(next) {
      const changed = next.tunerStations !== settings.tunerStations || next.tunerToneKnobs !== settings.tunerToneKnobs
        || next.tunerCardSize !== settings.tunerCardSize;
      settings = next;
      if (changed) sync();
    },
    destroy() {
      events.abort();
      changes.disconnect();
      observer.disconnect();
      for (const property of dockProperties) app.style.removeProperty(property);
    },
  };
}

export function applyTunerLayout(parts, { band, dial, list, empty, columns, placeholder, rowHeight, caption, knobs, labelFont }) {
  parts.stage.style.setProperty('--station-row-height', rowHeight + 'px');
  parts.columns = columns;
  parts.stage.dataset.band = band;
  parts.placeholder.hidden = !placeholder;
  if (placeholder) placeTunerPart(parts.placeholder, placeholder);
  placeTunerPart(parts.dialWrap, dial);
  parts.fitReadout?.();
  if (!list && parts.listColumn.contains(document.activeElement)) parts.stationsToggle.focus();
  parts.listColumn.hidden = !list;
  if (list) {
    placeTunerPart(parts.list, list);
    placeTunerPart(parts.empty, empty || list);
    placeTunerPart(parts.status, caption);
  }
  parts.listHeight = list?.height || 0;
  parts.emptyHeight = empty?.height || 0;
  if (knobs.length) {
    parts.stage.style.setProperty('--tone-label-font', labelFont + 'px');
    parts.stage.style.setProperty('--tone-glow-scale', knobs[0].knob.width / dial.width);
  } else if (parts.tone?.column.contains(document.activeElement)) parts.toneToggle.focus();
  parts.tone?.setLayout(knobs);
}

function syncTunerToggles(settings) {
  ui.stationsToggle.setAttribute('aria-pressed', String(settings.tunerStations !== false));
  const shown = settings.tunerToneKnobs === true;
  ui.toneToggle.setAttribute('aria-pressed', String(shown));
  if (shown) ui.tone ||= mountToneKnobs(ui.stage);
  else if (ui.tone) {
    if (ui.tone.column.contains(document.activeElement)) ui.toneToggle.focus();
    ui.tone.destroy();
    ui.tone = null;
  }
}

const subs = [];
function tearDown() {
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  autoRetry.stop();
  sourceRetries.stop();
  cardArt.clear();
  ui.tone?.destroy();
  ui.tone = null;
  ui.stationList?.destroy();
  ui.stationList = null;
  ui.layout = null;
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
  if (ui.unbindDial) { try { ui.unbindDial(); } catch (_) {} ui.unbindDial = null; }
}

export function renderTuner(host) {
  tearDown();
  // A category chosen earlier this session stays chosen; otherwise the saved
  // "My favorites" choice decides.
  if (getState().settings.tunerFavoritesOnly === true) {
    if (!favoriteGroupSource()) state.sourceFilter = FAVORITES;
  } else if (isFavoritesSource(state.sourceFilter)) state.sourceFilter = 'all';
  state.cardSize = normalizeTunerCardSize(getState().settings.tunerCardSize);
  const root = buildShell();
  host.appendChild(root);
  // The dimmed Visualizer behind it, while its setting asks for it.
  subs.push(attachTunerBackground(root));
  state.enabledSignature = enabledSignature();
  state.contentPreference = getState().settings.showExplicitContent === true;
  state.favoritesSort = normalizeFavoritesSort(getState().settings.favoritesSort);
  syncTunerToggles(getState().settings);
  const layout = bindTunerLayout(host, ui.stage, (result) => {
    applyTunerLayout(ui, result);
    renderStationList(true);
  });
  ui.layout = layout;
  subs.push(layout.destroy);
  const artEvents = new AbortController();
  for (const target of [ui.list, document.getElementById('player-art')]) {
    target.addEventListener('load', syncPlaceholder, { capture: true, signal: artEvents.signal });
  }
  subs.push(() => artEvents.abort(), subscribe('current-item', syncPlaceholder));
  loadStations();
  root.focus();
  subs.push(subscribe('settings-change', (settings) => {
    if (getState().mode !== 'tuner') return;
    syncVizLevel(settings);
    syncTunerToggles(settings);
    applyCardSize(settings.tunerCardSize);
    layout.settings(settings);
    const nextSignature = enabledSignature(settings);
    const nextPreference = settings.showExplicitContent === true;
    const sourcesChanged = nextSignature !== state.enabledSignature;
    const contentChanged = nextPreference !== state.contentPreference;
    const nextSort = normalizeFavoritesSort(settings.favoritesSort);
    const sortChanged = nextSort !== state.favoritesSort;
    state.enabledSignature = nextSignature;
    state.contentPreference = nextPreference;
    state.favoritesSort = nextSort;
    if (isFavoritesSource(state.sourceFilter)) {
      if (sourcesChanged || contentChanged || sortChanged) loadFavoriteStations();
    } else if (sourcesChanged) loadStations();
    else if (contentChanged) applyContentPreference(nextPreference);
  }));
  subs.push(subscribe('favorites-change', () => {
    if (getState().mode !== 'tuner') return;
    if (isFavoritesSource(state.sourceFilter)) loadFavoriteStations();
    else { rebuildSourceSelect(); updateFrequencyDisplay(); renderStationList(true); }
  }));
  subs.push(subscribe(FAVORITE_GROUPS_EVENT, () => {
    if (getState().mode !== 'tuner') return;
    if (isFavoritesSource(state.sourceFilter)) loadFavoriteStations();
    else rebuildSourceSelect();
  }));
  // A new or removed picture in the station-images folder (Refresh).
  subs.push(onStationImagesChange(() => {
    if (getState().mode === 'tuner' && cardPictures() && cardArt.stationImagesChanged()) renderStationList(true);
  }));
  // A station's "Did not play last time" mark came or went.
  subs.push(onDidNotPlayChange(() => {
    if (getState().mode === 'tuner') syncTunerMarks();
  }));
  // A station played with a new format or bitrate.
  subs.push(onPlayedStreamChange(() => {
    if (getState().mode === 'tuner') syncTunerMarks();
  }));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'tuner') step(1);
  }));
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'tuner') tearDown();
  }));
}
