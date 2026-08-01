/**
 * Tuner Mode — skeuomorphic dial for live radio + live TV.
 *
 * v1 simplification: dial rotation maps linearly to a 1D index into the current
 * station array. Mouse-drag rotates the dial. Arrow keys also work. Each station
 * is given a cosmetic frequency: 87.5 + (index * 0.1) MHz.
 */

import { browseLiveOne } from '../lib/search.js';
import { playItem } from '../lib/player.js';
import { subscribe, getState } from '../lib/state.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { contentBadgeText, filterContentItems } from '../lib/content-rating.js';

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
  sourceFilter: 'all',
  sourceStates: new Map(),
  enabledSignature: '',
  contentPreference: false,
};

const ui = {};

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
    },
  });
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
      loadStations();
    } },
  });
  filter.appendChild(el('label', { text: 'Source:', style: { color: 'var(--text-dim)', fontSize: '12px' } }));
  filter.appendChild(ui.sourceSel);
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
  ui.freqUnit = el('div', { className: 'freq-unit', text: 'MHz' });
  ui.stationName = el('div', { className: 'station-name', text: state.loading ? 'Loading…' : 'No station' });
  freq.appendChild(ui.freqNum);
  freq.appendChild(ui.freqUnit);
  freq.appendChild(ui.stationName);
  dialWrap.appendChild(freq);

  stage.appendChild(dialWrap);
  root.appendChild(stage);

  // Bottom strip of nearby stations
  ui.strip = el('div', { className: 'tuner-strip' });
  root.appendChild(ui.strip);
  ui.status = el('div', { className: 'tuner-source-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  root.appendChild(ui.status);

  // Keyboard
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tuneCurrent(); }
  });

  return root;
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
        <circle cx="200" cy="200" r="6" fill="rgba(255,255,255,0.2)"/>
      </g>
      <polygon class="tuner-pointer" points="200,16 196,32 204,32" />
    </svg>
  `;
}

function bindDialEvents(wrap) {
  let dragging = false;
  let startAngle = 0;
  let baseRotation = 0;

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
    wrap.classList.add('dragging');
    startAngle = angleFromEvent(e);
    baseRotation = state.rotationDeg;
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const a = angleFromEvent(e);
    let delta = a - startAngle;
    state.rotationDeg = baseRotation + delta;
    applyRotation();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    tuneCurrent();
  }

  wrap.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  wrap.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);

  // Return cleanup so the mode tear-down can detach.
  return () => {
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

function updateFrequencyDisplay() {
  const s = state.stations[state.index];
  if (!s) {
    ui.freqNum.textContent = '—';
    ui.stationName.textContent = state.loading ? 'Loading…' : 'No station';
    return;
  }
  if (state.band === 'radio') {
    ui.freqNum.textContent = (87.5 + state.index * 0.1).toFixed(1);
    ui.freqUnit.textContent = 'MHz';
  } else {
    ui.freqNum.textContent = String(state.index + 1);
    ui.freqUnit.textContent = 'CH';
  }
  ui.stationName.textContent = `${s.title} · ${getSourceLabel(s.source)}`;
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

function rebuildSourceSelect() {
  const sources = liveSources();
  if (state.sourceFilter !== 'all' && !sources.some(({ id }) => id === state.sourceFilter)) {
    state.sourceFilter = 'all';
  }
  ui.sourceSel.innerHTML = '';
  ui.sourceSel.appendChild(el('option', { attrs: { value: 'all' }, text: 'All live sources' }));
  for (const source of sources) {
    ui.sourceSel.appendChild(el('option', { attrs: { value: source.id }, text: source.displayName }));
  }
  ui.sourceSel.value = state.sourceFilter;
}

function renderSourceStatus() {
  if (!ui.status) return;
  const states = [...state.sourceStates.values()];
  const failures = states.filter(({ state: value }) => value === 'error').length;
  const completed = states.filter(({ state: value }) => value === 'ready').length;
  const count = state.stations.length;
  ui.status.textContent = state.loading
    ? `Loading ${states.length || liveSources().length} live sources…`
    : `${count} ${state.band === 'radio' ? 'stations' : 'channels'} from ${completed} sources`
      + (failures ? ` · ${failures} unavailable` : '');
}

function step(dir) {
  if (state.stations.length === 0) return;
  state.rotationDeg += dir * 12;
  applyRotation();
  tuneCurrent();
}

function tuneCurrent() {
  const s = state.stations[state.index];
  if (!s) return;
  playItem(s).catch((err) => console.warn('play failed:', err));
}

async function loadStations({ onlySourceIds = null, preserve = false } = {}) {
  const gen = ++state.loadGen;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = true;
  const selectedId = state.stations[state.index]?.id || '';
  if (!preserve) {
    state.stations = [];
    state.index = 0;
    state.rotationDeg = 0;
  }
  applyRotation();
  ui.stationName.textContent = 'Loading…';
  renderStrip();
  rebuildSourceSelect();
  if (!preserve) state.sourceStates = new Map();
  renderSourceStatus();
  try {
    const opts = { limit: 80, type: state.band };
    if (state.country) opts.country = state.country;
    const candidates = liveSources().filter((source) => (
      (state.sourceFilter === 'all' || source.id === state.sourceFilter)
      && (!onlySourceIds || onlySourceIds.has(source.id))
    ));
    if (candidates.length === 0) {
      if (!preserve) state.stations = [];
      state.loading = false;
      updateFrequencyDisplay();
      renderStrip();
      renderSourceStatus();
      return;
    }
    const controller = new AbortController();
    state.requestAbort = controller;
    for (const source of candidates) state.sourceStates.set(source.id, { state: 'loading', count: 0 });
    const settled = await Promise.allSettled(candidates.map((source) => catalogScheduler.enqueue({
      sourceId: source.id,
      key: `tuner:${gen}:${state.band}`,
      priority: CATALOG_PRIORITY.USER,
      signal: controller.signal,
      task: ({ signal }) => browseLiveOne(source.id, { ...opts, signal }),
    }).then((items) => {
      if (gen === state.loadGen) state.sourceStates.set(source.id, { state: 'ready', count: items.length });
      return items;
    }, (error) => {
      if (gen === state.loadGen && error?.name !== 'AbortError') {
        state.sourceStates.set(source.id, { state: 'error', count: 0, error: String(error?.message || error) });
      }
      throw error;
    })));
    if (gen !== state.loadGen) return;
    const refreshedIds = new Set(candidates
      .filter((_source, index) => settled[index]?.status === 'fulfilled')
      .map((source) => source.id));
    const preserved = preserve
      ? state.stations.filter((item) => !refreshedIds.has(item.source))
      : [];
    const seen = new Set();
    state.stations = [...preserved, ...settled.flatMap(
      (result) => result.status === 'fulfilled' ? result.value : [],
    )]
      .filter((item) => item.type === state.band && !seen.has(item.id) && seen.add(item.id));
    const restoredIndex = selectedId
      ? state.stations.findIndex((item) => item.id === selectedId)
      : -1;
    state.index = restoredIndex >= 0
      ? restoredIndex
      : Math.min(state.index, Math.max(0, state.stations.length - 1));
    state.rotationDeg = state.index * 12;
  } catch (err) {
    if (gen !== state.loadGen) return;
    if (err?.name !== 'AbortError') console.warn('Tuner load failed:', err);
    if (!preserve) state.stations = [];
  }
  if (gen !== state.loadGen) return;
  state.requestAbort = null;
  state.loading = false;
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
  state.stations = filterContentItems(state.stations, false);
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
  state.sourceFilter = 'all';
  for (const btn of document.querySelectorAll('.tuner-band-switch button')) {
    const active = btn.dataset.band === b;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  loadStations();
}

function renderStrip() {
  if (!ui.strip) return;
  ui.strip.innerHTML = '';
  if (state.stations.length === 0) {
    ui.strip.appendChild(el('div', { className: 'tuner-empty', text: state.loading ? 'Loading stations…' : 'No stations found for this country.' }));
    return;
  }
  // Window of ~30 stations centered on current
  const span = 15;
  const start = Math.max(0, state.index - span);
  const end = Math.min(state.stations.length, state.index + span + 1);
  for (let i = start; i < end; i++) {
    const s = state.stations[i];
    const rating = contentBadgeText(s);
    const pill = el('button', {
      className: 'station-pill' + (i === state.index ? ' is-active' : ''),
      attrs: {
        title: `${s.title} · ${getSourceLabel(s.source)}`,
        'aria-pressed': i === state.index ? 'true' : 'false',
      },
      on: { click: () => { state.index = i; state.rotationDeg = i * 12; applyRotation(); tuneCurrent(); } },
    },
    el('span', { text: s.title }),
    el('small', { text: getSourceLabel(s.source) }),
    rating ? el('span', { className: 'content-rating-badge', text: rating }) : null);
    ui.strip.appendChild(pill);
  }
}

const subs = [];
function tearDown() {
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
  if (ui.unbindDial) { try { ui.unbindDial(); } catch (_) {} ui.unbindDial = null; }
}

export function renderTuner(host) {
  tearDown();
  const root = buildShell();
  host.appendChild(root);
  state.enabledSignature = enabledSignature();
  state.contentPreference = getState().settings.showExplicitContent === true;
  loadStations();
  root.focus();
  subs.push(subscribe('settings-change', (settings) => {
    if (getState().mode !== 'tuner') return;
    const nextSignature = enabledSignature(settings);
    const nextPreference = settings.showExplicitContent === true;
    const sourcesChanged = nextSignature !== state.enabledSignature;
    const contentChanged = nextPreference !== state.contentPreference;
    state.enabledSignature = nextSignature;
    state.contentPreference = nextPreference;
    if (sourcesChanged) loadStations();
    else if (contentChanged) applyContentPreference(nextPreference);
  }));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'tuner') step(1);
  }));
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'tuner') tearDown();
  }));
}
