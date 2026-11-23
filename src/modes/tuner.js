/**
 * Tuner Mode — skeuomorphic dial for live radio + live TV.
 *
 * v1 simplification: dial rotation maps linearly to a 1D index into the current
 * station array. Mouse-drag or the mouse wheel (over the dial or the strip of cards) rotates the dial. Arrow keys also work. Each station
 * shows its honest position in the current list ("12 of 80"), not a made-up
 * frequency that would change whenever the list reloads.
 *
 * Source "★ My favorites" puts only the user's starred stations for the band
 * on the dial (no network needed). That choice is remembered in settings.
 * Each favorites category with stations in it follows as its own entry
 * ("\u2605 Rock"), for this session; see lib/favorite-groups.js.
 */

import { browseLiveOne } from '../lib/search.js';
import { playItem } from '../lib/player.js';
import { subscribe, getState, saveSettings, isFavorite } from '../lib/state.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { contentBadgeText, filterContentItems, isContentAllowed } from '../lib/content-rating.js';
import { normalizeTunerCardSize, tunerCardsShowPictures } from '../lib/tuner-card-size.js';
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

/** True when a card's picture box is inside the visible part of the strip. */
function artInView(box) {
  const strip = ui.strip;
  if (!strip?.isConnected || !box?.isConnected) return false;
  const stripBox = strip.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  return boxRect.width > 0 && boxRect.right > stripBox.left && boxRect.left < stripBox.right;
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
  filter.appendChild(el('label', { text: 'Country:', style: { color: 'var(--text-dim)', fontSize: '12px' } }));
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
  filter.appendChild(el('label', { text: 'Source:', style: { color: 'var(--text-dim)', fontSize: '12px' } }));
  filter.appendChild(ui.sourceSel);
  if (TUNER_BACKGROUND_RELEASED) filter.appendChild(buildVizLevel());
  controls.appendChild(filter);
  root.appendChild(controls);

  // Stage with dial
  const stage = el('div', { className: 'tuner-stage' });
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

  stage.appendChild(dialWrap);
  root.appendChild(stage);

  // Bottom strip of nearby stations
  ui.strip = el('div', { className: 'tuner-strip' });
  // Scrolling the strip by hand waits again before pictures load.
  ui.strip.addEventListener('scroll', () => { if (cardPictures()) cardArt.poke(); }, { passive: true });
  // The wheel over the strip is the wheel over the dial: the same handler,
  // so the same station per notch and the same tune once it rests, and the
  // page and the strip do not scroll for it (the strip follows the station).
  ui.strip.addEventListener('wheel', ui.dialWheel, { passive: false });
  root.appendChild(ui.strip);
  ui.status = el('div', { className: 'tuner-source-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  root.appendChild(ui.status);

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
    ? 'shown while sound plays'
    : 'shown while sound plays, once its notice about flashing has been accepted in the Visualizer tab';
  ui.vizLevelGroup.title = level
    ? `Visualizer behind the Tuner: ${level} of 100 (0 turns it off), ${when}`
    : `Visualizer behind the Tuner: off. Up turns it on, ${when}`;
}

function buildDialSvg() {
  // Outer bezel + radial ticks + rotating inner disc with pointer.
  const ticks = [];
  for (let i = 0; i <= 100; i++) {
    const major = i % 10 === 0;
    const angle = (i / 100) * 360 - 90;
    const r1 = 158;
    const r2 = major ? 138 : 146;
    const x1 = 200 + r1 * Math.cos(angle * Math.PI / 180);
    const y1 = 200 + r1 * Math.sin(angle * Math.PI / 180);
    const x2 = 200 + r2 * Math.cos(angle * Math.PI / 180);
    const y2 = 200 + r2 * Math.sin(angle * Math.PI / 180);
    ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)'}" stroke-width="${major ? 2 : 1}" />`);
  }
  return `
    <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bezelGrad" cx="0.35" cy="0.35" r="0.8">
          <stop offset="0%" stop-color="#3a3f4d"/>
          <stop offset="55%" stop-color="#1a1c22"/>
          <stop offset="100%" stop-color="#0a0b0e"/>
        </radialGradient>
        <radialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0%" stop-color="#262a33"/>
          <stop offset="80%" stop-color="#101216"/>
        </radialGradient>
        <radialGradient id="knobGrad" cx="0.35" cy="0.3" r="0.7">
          <stop offset="0%" stop-color="#24464b"/>
          <stop offset="62%" stop-color="#14232a"/>
          <stop offset="100%" stop-color="#080d12"/>
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="190" class="tuner-bezel"/>
      <circle cx="200" cy="200" r="172" fill="url(#bodyGrad)" stroke="rgba(255,255,255,0.05)"/>
      ${ticks.join('')}
      <g class="dial-body" transform="rotate(0 200 200)">
        <circle cx="200" cy="200" r="100" fill="url(#knobGrad)" stroke="rgba(255,255,255,0.05)"/>
        <circle cx="200" cy="200" r="100" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="2"/>
        <line x1="200" y1="110" x2="200" y2="150" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
      </g>
      <polygon class="tuner-pointer" points="200,16 196,32 204,32" />
    </svg>
  `;
}

/** Shortest signed turn in degrees between two pointer angles. atan2 jumps
 *  from +180 to -180 at 9 o'clock; without this a drag across that point
 *  reads as a full reverse turn and skips 30 stations. */
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

export function dialTurn(fromDeg, toDeg) {
  let delta = (toDeg - fromDeg) % 360;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return delta;
}

const WHEEL_NOTCH_PX = 100;
const WHEEL_TUNE_DELAY_MS = 250;

/** Whole station steps for one wheel event. Mouse wheels send about 100 px
 *  per notch and touchpads send many small values, so movement is pooled in
 *  `pool.px` and one step is taken per notch-sized amount. A sideways
 *  gesture (tilt wheel, touchpad swipe) counts too: whichever of deltaX and
 *  deltaY is larger, right or down being the next station. */
export function wheelSteps(pool, event) {
  const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 100 : 1;
  const across = Number(event.deltaX) || 0;
  const down = Number(event.deltaY) || 0;
  pool.px += (Math.abs(across) > Math.abs(down) ? across : down) * unit;
  const steps = Math.trunc(pool.px / WHEEL_NOTCH_PX);
  pool.px -= steps * WHEEL_NOTCH_PX;
  return steps;
}

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
  // The strip of cards under the dial turns it the same way (buildUi).
  ui.dialWheel = onWheel;
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

function applyRotation() {
  if (!ui.dialBody) return;
  ui.dialBody.setAttribute('transform', `rotate(${state.rotationDeg} 200 200)`);
  if (state.stations.length === 0) return;
  const degPerStation = 12;
  let idx = Math.round(state.rotationDeg / degPerStation) % state.stations.length;
  if (idx < 0) idx += state.stations.length;
  state.index = idx;
  updateFrequencyDisplay();
  renderStrip();
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
    return;
  }
  ui.freqNum.textContent = String(state.index + 1);
  ui.freqUnit.textContent = `of ${state.stations.length}`;
  // Only the name: the knob has little room. The source stays on the
  // station's card in the strip below: its second line (so also the card's
  // accessible name) and its tooltip.
  ui.stationName.textContent = `${isFavorite(s.id) ? '\u2605 ' : ''}${s.title}`;
  // A long name ends in an ellipsis on the dial; the whole name on hover.
  ui.stationName.setAttribute('title', s.title || '');
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

function renderSourceStatus() {
  if (!ui.status) return;
  const count = state.stations.length;
  if (isFavoritesSource(state.sourceFilter)) {
    const groupName = favoriteGroupsSnapshot().nameOf(favoriteGroupSource());
    ui.status.textContent = `${count} favorite ${state.band === 'radio' ? 'stations' : 'channels'}`
      + (groupName ? ` in ${groupName}` : '')
      + otherBandFavoritesText(getState().favorites, {
        band: state.band, country: state.country, settings: getState().settings, groupId: favoriteGroupSource(),
      });
    return;
  }
  ui.status.textContent = liveStatusText({
    count,
    noun: state.band === 'radio' ? 'stations' : 'channels',
    sourceStates: state.sourceStates,
    loading: state.loading,
    sourceCount: chosenLiveSourceCount(),
  });
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
  renderSourceStatus();
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

function tuneCurrent({ restart = true } = {}) {
  const s = state.stations[state.index];
  if (!s) return;
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

/** What the empty strip says for the live sources: a source that did not
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

/** The favorites the dial leaves out because they are saved as the other
 *  band, as a note for the status line ('' when there are none). A playlist
 *  channel whose address does not say radio or TV is saved as the playlist's
 *  "Add as" type, so a radio station imported "as TV" is only on the TV dial;
 *  this says where it went. */
export function otherBandFavoritesText(favorites, { band, ...filters } = {}) {
  const other = band === 'radio' ? 'tv' : 'radio';
  const count = favoriteStations(favorites, { ...filters, band: other }).length;
  if (count === 0) return '';
  return ` \u00b7 ${count} more saved as ${other === 'tv' ? 'TV' : 'radio'} (switch to ${other === 'tv' ? 'TV' : 'Radio'} to see ${count === 1 ? 'it' : 'them'})`;
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
  renderStrip();
  renderSourceStatus();
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
  }
  renderStrip();
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
  renderSourceStatus();
  try {
    const opts = { limit: 80, type: state.band };
    if (state.country) opts.country = state.country;
    if (candidates.length === 0) {
      if (!preserve) setStations([]);
      state.loading = false;
      updateFrequencyDisplay();
      renderStrip();
      renderSourceStatus();
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
      renderSourceStatus();
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
        if (state.stations.length === 0) renderStrip();
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
  renderStrip();
  renderSourceStatus();
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
  renderStrip();
  renderSourceStatus();
}

function setBand(b) {
  state.band = b;
  // "My favorites" (and its categories) applies to both bands; a specific source may not.
  if (!isFavoritesSource(state.sourceFilter)) state.sourceFilter = 'all';
  for (const btn of document.querySelectorAll('.tuner-band-switch button')) {
    const active = btn.dataset.band === b;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  loadStations();
}

function renderStrip() {
  if (!ui.strip) return;
  const pictures = cardPictures();
  ui.strip.innerHTML = '';
  if (state.stations.length === 0) {
    if (pictures) cardArt.commit();
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
    ui.strip.appendChild(el('div', { className: 'tuner-empty', text }));
    return;
  }
  // Window of ~30 stations centered on current
  const span = 15;
  const start = Math.max(0, state.index - span);
  const end = Math.min(state.stations.length, state.index + span + 1);
  for (let i = start; i < end; i++) {
    const s = state.stations[i];
    const rating = contentBadgeText(s);
    const saved = isFavorite(s.id);
    const sourceLine = el('small', { text: getSourceLabel(s.source) });
    const pill = el('button', {
      className: 'station-pill' + (i === state.index ? ' is-active' : '') + (saved ? ' is-favorite' : '')
        + (pictures ? ' has-art' : ''),
      attrs: { 'aria-pressed': i === state.index ? 'true' : 'false' },
      on: { click: () => { state.index = i; state.rotationDeg = i * 12; applyRotation(); tuneCurrent(); } },
    },
    // Medium and large cards: the station's picture box (reused across steps).
    pictures ? cardArt.box(s) : null,
    el('span', { text: saved ? `★ ${s.title}` : s.title }),
    sourceLine,
    rating ? el('span', { className: 'content-rating-badge', text: rating }) : null);
    pill.__sourceLine = sourceLine;
    pill.__station = s;
    pill.__saved = saved;
    setPillTrouble(pill);
    ui.strip.appendChild(pill);
  }
  centerActivePill();
  if (pictures) cardArt.commit();
}

/** A card's "Did not play last time" mark (the user's own stations only),
 *  its tooltip and its accessible text, changed in place: the strip, its
 *  scroll position and the focused card stay as they are. */
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

/** With "Show technical source details" on, a card's second line reads
 *  "AAC 128k · Radio Browser" once the format or bitrate is known (a short
 *  form, so it fits in the width a source name gives; tuner.css); otherwise
 *  it is the plain source name. Changed in place. Returns the full label for
 *  the tooltip ("AAC · 128 kbps", '' when nothing is known). */
function setPillStream(pill) {
  const facts = stationStreamFacts(pill.__station);
  const label = formatStreamQuality(facts);
  let node = pill.__quality || null;
  if (!label || !pill.__sourceLine) {
    node?.remove();
    pill.__sourceLine?.classList?.remove('pill-with-quality');
    pill.__quality = null;
    return label;
  }
  if (!node) {
    // With technical details on it stands in for the plain source text,
    // which stays (unseen) only to size the card: never wider than before,
    // and cut short at its end, so the source goes first (tuner.css).
    node = el('span', { className: 'pill-quality' });
    pill.__sourceLine.classList?.add('pill-with-quality');
    pill.__sourceLine.appendChild(node);
    pill.__quality = node;
  }
  const text = `${compactStreamLabel(facts)} · ${getSourceLabel(pill.__station.source)}`;
  if (node.textContent !== text) node.textContent = text;
  return label;
}

/** The marks or stream labels changed: update the cards in the strip,
 *  nothing else. */
export function syncTunerMarks(strip = ui.strip) {
  for (const pill of Array.from(strip?.children || [])) setPillTrouble(pill);
}

/** Show the card size chosen in Settings, at once. */
function applyCardSize(size) {
  const next = normalizeTunerCardSize(size);
  if (next === state.cardSize) return;
  state.cardSize = next;
  ui.root?.setAttribute('data-card-size', next);
  if (!cardPictures()) cardArt.clear();
  renderStrip();
}

/** Scroll position that puts a pill in the middle of the strip. */
export function centeredScrollLeft({ stripLeft, stripWidth, scrollLeft, pillLeft, pillWidth }) {
  return Math.max(0, Math.round(pillLeft - stripLeft + scrollLeft - (stripWidth - pillWidth) / 2));
}

// The strip is rebuilt on every station change, and it holds up to 31 pills,
// which is wider than most windows. Without this the highlighted station was
// often scrolled out of sight.
function centerActivePill() {
  const strip = ui.strip;
  const active = strip?.querySelector?.('.station-pill.is-active');
  if (!active?.getBoundingClientRect || !strip.getBoundingClientRect) return;
  const stripBox = strip.getBoundingClientRect();
  const pillBox = active.getBoundingClientRect();
  if (!stripBox.width) return;
  strip.scrollLeft = centeredScrollLeft({
    stripLeft: stripBox.left, stripWidth: strip.clientWidth || stripBox.width,
    scrollLeft: strip.scrollLeft, pillLeft: pillBox.left, pillWidth: pillBox.width,
  });
}

/** The band the Tuner is on ('radio' or 'tv'); used for dropped playlists. */
export function tunerBand() { return state.band; }

const subs = [];
function tearDown() {
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  autoRetry.stop();
  sourceRetries.stop();
  cardArt.clear();
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
  loadStations();
  root.focus();
  subs.push(subscribe('settings-change', (settings) => {
    if (getState().mode !== 'tuner') return;
    syncVizLevel(settings);
    const nextSignature = enabledSignature(settings);
    const nextPreference = settings.showExplicitContent === true;
    const sourcesChanged = nextSignature !== state.enabledSignature;
    const contentChanged = nextPreference !== state.contentPreference;
    const nextSort = normalizeFavoritesSort(settings.favoritesSort);
    const sortChanged = nextSort !== state.favoritesSort;
    state.enabledSignature = nextSignature;
    state.contentPreference = nextPreference;
    state.favoritesSort = nextSort;
    applyCardSize(settings.tunerCardSize);
    if (isFavoritesSource(state.sourceFilter)) {
      if (sourcesChanged || contentChanged || sortChanged) loadFavoriteStations();
    } else if (sourcesChanged) loadStations();
    else if (contentChanged) applyContentPreference(nextPreference);
  }));
  subs.push(subscribe('favorites-change', () => {
    if (getState().mode !== 'tuner') return;
    if (isFavoritesSource(state.sourceFilter)) loadFavoriteStations();
    else { rebuildSourceSelect(); updateFrequencyDisplay(); renderStrip(); }
  }));
  subs.push(subscribe(FAVORITE_GROUPS_EVENT, () => {
    if (getState().mode !== 'tuner') return;
    if (isFavoritesSource(state.sourceFilter)) loadFavoriteStations();
    else rebuildSourceSelect();
  }));
  // A new or removed picture in the station-images folder (Refresh).
  subs.push(onStationImagesChange(() => {
    if (getState().mode === 'tuner' && cardPictures() && cardArt.stationImagesChanged()) renderStrip();
  }));
  // A station's "Did not play last time" mark came or went.
  subs.push(onDidNotPlayChange(() => {
    if (getState().mode === 'tuner') syncTunerMarks();
  }));
  // A station played with a new format or bitrate.
  subs.push(onPlayedStreamChange(() => {
    if (getState().mode === 'tuner') syncTunerMarks();
  }));
  // A wider window shows more cards: wait, then load the ones now in view.
  const onResize = () => { if (cardPictures()) cardArt.poke(); };
  window.addEventListener('resize', onResize);
  subs.push(() => window.removeEventListener('resize', onResize));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'tuner') step(1);
  }));
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'tuner') tearDown();
  }));
}
