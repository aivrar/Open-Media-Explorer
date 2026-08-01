/**
 * Grid Mode — TV-channel-guide tiles. Works for live radio and live TV.
 */

import { browseLiveOne } from '../lib/search.js';
import { playItem } from '../lib/player.js';
import { subscribe, getState } from '../lib/state.js';
import { isArtworkRelayUrl, loadArtworkImage, resolveArtworkRelay } from '../lib/artwork.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { contentBadgeText, filterContentItems } from '../lib/content-rating.js';

const ui = {};
const state = {
  band: 'tv',
  category: '',
  country: '',
  tiles: [],
  currentId: null,
  loading: false,
  loadGen: 0,
  requestAbort: null,
  sourceFilter: 'all',
  sourceStates: new Map(),
  enabledSignature: '',
  contentPreference: false,
};

const CATEGORIES = ['', 'news', 'music', 'sports', 'movies', 'documentary', 'kids', 'entertainment', 'education'];

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

let artworkObserver = null;
let artworkAbort = null;

function resetArtworkObserver() {
  artworkObserver?.disconnect();
  artworkObserver = null;
}

function cancelArtworkWork() {
  resetArtworkObserver();
  if (artworkAbort && !artworkAbort.signal.aborted) artworkAbort.abort();
  artworkAbort = null;
}

function beginArtworkWork() {
  cancelArtworkWork();
  artworkAbort = new AbortController();
  return artworkAbort.signal;
}

function hydrateTileArtwork(tile, logoWrap, item) {
  const appendImage = () => {
    if (!tile.isConnected || !isArtworkRelayUrl(item.thumbnail)
        || logoWrap.querySelector('img')) return;
    const img = el('img', {
      className: 'channel-logo',
      attrs: {
        alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      },
      style: {
        position: 'absolute', inset: '0', opacity: '0', transition: 'opacity 0.18s ease',
      },
    });
    logoWrap.appendChild(img);
    void loadArtworkImage(img, item.thumbnail.trim(), {
      priority: 10,
      signal: artworkAbort?.signal,
    }).then(() => {
      if (img.naturalWidth > 0) img.style.opacity = '1';
    }).catch((error) => {
      if (error?.name !== 'AbortError') img.style.display = 'none';
    });
  };
  if (isArtworkRelayUrl(item.thumbnail)) {
    appendImage();
    return;
  }
  resolveArtworkRelay(item, { priority: 10, signal: artworkAbort?.signal })
    .then(appendImage).catch(() => {});
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
  const root = el('div', { className: 'grid-root' });
  const controls = el('div', { className: 'grid-controls' });

  // Band
  const band = el('div', { className: 'tuner-band-switch' });
  for (const b of [{ id: 'tv', label: 'Live TV' }, { id: 'radio', label: 'Radio' }]) {
    band.appendChild(el('button', {
      className: state.band === b.id ? 'is-active' : '',
      attrs: { 'data-band': b.id, 'aria-pressed': state.band === b.id ? 'true' : 'false' },
      on: { click: () => setBand(b.id) },
      text: b.label,
    }));
  }
  controls.appendChild(band);

  // Category
  const catLabel = el('label', { text: 'Category:', style: { color: 'var(--text-dim)', fontSize: '12px' } });
  ui.catSel = el('select');
  for (const c of CATEGORIES) {
    ui.catSel.appendChild(el('option', { attrs: { value: c }, text: c ? c[0].toUpperCase() + c.slice(1) : 'All categories' }));
  }
  ui.catSel.value = state.category;
  ui.catSel.addEventListener('change', () => { state.category = ui.catSel.value; load(); });
  controls.appendChild(catLabel);
  controls.appendChild(ui.catSel);

  // Country
  const cntLabel = el('label', { text: 'Country:', style: { color: 'var(--text-dim)', fontSize: '12px' } });
  ui.countrySel = el('select');
  for (const c of COUNTRIES) ui.countrySel.appendChild(el('option', { attrs: { value: c.code }, text: c.label }));
  ui.countrySel.value = state.country;
  ui.countrySel.addEventListener('change', () => { state.country = ui.countrySel.value; load(); });
  controls.appendChild(cntLabel);
  controls.appendChild(ui.countrySel);

  const sourceLabel = el('label', { text: 'Source:', style: { color: 'var(--text-dim)', fontSize: '12px' } });
  ui.sourceSel = el('select', {
    attrs: { 'aria-label': 'Live media source' },
    on: { change: () => { state.sourceFilter = ui.sourceSel.value; load(); } },
  });
  controls.appendChild(sourceLabel);
  controls.appendChild(ui.sourceSel);

  // Search within grid
  ui.search = el('input', {
    className: 'search-input',
    attrs: { type: 'search', placeholder: 'Filter…', style: 'max-width: 200px; margin-left:auto;' },
    on: { input: () => renderTiles() },
  });
  ui.search.style.maxWidth = '200px';
  ui.search.style.marginLeft = 'auto';
  controls.appendChild(ui.search);

  root.appendChild(controls);

  ui.tilesHost = el('div', { className: 'grid-tiles' });
  root.appendChild(ui.tilesHost);
  ui.status = el('div', { className: 'grid-source-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  root.appendChild(ui.status);
  return root;
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
  const statuses = [...state.sourceStates.values()];
  const ready = statuses.filter(({ state: value }) => value === 'ready').length;
  const failed = statuses.filter(({ state: value }) => value === 'error').length;
  ui.status.textContent = state.loading
    ? `Loading ${statuses.length || liveSources().length} live sources…`
    : `${state.tiles.length} live items from ${ready} sources${failed ? ` · ${failed} unavailable` : ''}`;
}

function setBand(b) {
  state.band = b;
  state.sourceFilter = 'all';
  for (const btn of document.querySelectorAll('.grid-root .tuner-band-switch button')) {
    const active = btn.dataset.band === b;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  load();
}

async function load({ onlySourceIds = null, preserve = false } = {}) {
  const gen = ++state.loadGen;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = true;
  if (!preserve) {
    state.tiles = [];
    state.sourceStates = new Map();
  }
  renderTiles();
  rebuildSourceSelect();
  renderSourceStatus();
  try {
    const candidates = liveSources().filter((source) => (
      (state.sourceFilter === 'all' || source.id === state.sourceFilter)
      && (!onlySourceIds || onlySourceIds.has(source.id))
    ));
    if (candidates.length === 0) {
      if (!preserve) state.tiles = [];
      state.loading = false;
      renderTiles();
      renderSourceStatus();
      return;
    }
    const opts = { limit: 100, type: state.band };
    if (state.country) opts.country = state.country;
    if (state.category) opts.tag = state.category;
    const controller = new AbortController();
    state.requestAbort = controller;
    for (const source of candidates) state.sourceStates.set(source.id, { state: 'loading', count: 0 });
    const settled = await Promise.allSettled(candidates.map((source) => catalogScheduler.enqueue({
      sourceId: source.id,
      key: `grid:${gen}:${state.band}`,
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
      ? state.tiles.filter((item) => !refreshedIds.has(item.source))
      : [];
    const seen = new Set();
    state.tiles = [...preserved, ...settled.flatMap(
      (result) => result.status === 'fulfilled' ? result.value : [],
    )]
      .filter((item) => item.type === state.band && !seen.has(item.id) && seen.add(item.id));
  } catch (err) {
    if (gen !== state.loadGen) return;
    if (err?.name !== 'AbortError') console.warn('Grid load failed:', err);
    if (!preserve) state.tiles = [];
  }
  if (gen !== state.loadGen) return;
  state.requestAbort = null;
  state.loading = false;
  renderTiles();
  renderSourceStatus();
}

function applyContentPreference(showExplicit) {
  if (state.loading) {
    load();
    return;
  }
  if (showExplicit) {
    load({ onlySourceIds: contentAwareLiveSourceIds(), preserve: true });
    return;
  }
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  state.tiles = filterContentItems(state.tiles, false);
  for (const [sourceId, status] of state.sourceStates) {
    if (status.state === 'ready') {
      state.sourceStates.set(sourceId, {
        ...status,
        count: state.tiles.filter((item) => item.source === sourceId).length,
      });
    }
  }
  renderTiles();
  renderSourceStatus();
}

function renderTiles() {
  beginArtworkWork();
  ui.tilesHost.innerHTML = '';
  const filter = (ui.search?.value || '').toLowerCase();
  let tiles = state.tiles;
  if (filter) tiles = tiles.filter((t) => (t.title || '').toLowerCase().includes(filter));
  if (state.category && state.band === 'tv') {
    tiles = tiles.filter((t) => (t.tags || []).some((tag) => tag.toLowerCase().includes(state.category)));
  }
  if (tiles.length === 0) {
    ui.tilesHost.appendChild(el('div', { className: 'empty-state', style: { gridColumn: '1 / -1' } },
      el('h3', { text: state.loading ? 'Loading…' : 'No channels' }),
      el('p', { text: state.loading ? 'Fetching from source…' : 'Try changing filters or country.' }),
    ));
    return;
  }
  for (const t of tiles) {
    const tile = el('div', {
      className: 'channel-tile' + (state.currentId === t.id ? ' is-playing' : ''),
      attrs: {
        'data-id': t.id,
        role: 'button',
        tabindex: '0',
        'aria-label': `Play ${t.title || 'Channel'} from ${getSourceLabel(t.source)}`,
      },
      on: {
        click: () => activateTile(t),
        keydown: (event) => {
          if (!['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          activateTile(t, { restoreFocus: true });
        },
      },
    });
    // Placeholder always in place; image fades over it on successful load.
    const logoWrap = el('div', { className: 'channel-logo-wrap', style: { position: 'relative', width: '64px', height: '64px' } });
    const placeholder = el('div', { className: 'channel-logo-placeholder', style: { position: 'absolute', inset: '0', borderRadius: 'var(--radius)', background: 'var(--bg-elev-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }, html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg>' });
    logoWrap.appendChild(placeholder);
    tile.appendChild(logoWrap);
    tile.appendChild(el('div', { className: 'channel-name', text: t.title || 'Channel' }));
    tile.appendChild(el('div', {
      className: 'channel-meta',
      text: [getSourceLabel(t.source), t.country].filter(Boolean).join(' · '),
    }));
    const rating = contentBadgeText(t);
    if (rating) tile.appendChild(el('span', { className: 'content-rating-badge', text: rating }));
    // WebView2 can miss the initial IntersectionObserver notification when a
    // target is observed while detached. Mount first so every visible Grid
    // tile either starts immediately or receives a reliable observer event.
    ui.tilesHost.appendChild(tile);
    if (isArtworkRelayUrl(t.thumbnail)) hydrateTileArtwork(tile, logoWrap, t);
    else if ('IntersectionObserver' in window) {
      artworkObserver ||= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          artworkObserver?.unobserve(entry.target);
          const cfg = entry.target.__artworkHydration;
          delete entry.target.__artworkHydration;
          if (cfg) hydrateTileArtwork(entry.target, cfg.logoWrap, cfg.item);
        }
      }, { rootMargin: '480px 0px' });
      tile.__artworkHydration = { logoWrap, item: t };
      artworkObserver.observe(tile);
    } else {
      hydrateTileArtwork(tile, logoWrap, t);
    }
  }
}

function activateTile(item, options = {}) {
  state.currentId = item.id;
  renderTiles();
  if (options.restoreFocus === true) {
    queueMicrotask(() => [...ui.tilesHost.querySelectorAll('[data-id]')]
      .find((tile) => tile.dataset.id === item.id)?.focus());
  }
  playItem(item).catch(() => {});
}

function tryNextTile() {
  if (!state.tiles.length) return;
  const idx = state.tiles.findIndex((t) => t.id === state.currentId);
  const next = state.tiles[(idx + 1) % state.tiles.length] || state.tiles[0];
  if (next) {
    state.currentId = next.id;
    renderTiles();
    playItem(next).catch(() => {});
  }
}

const subs = [];
function tearDown() {
  cancelArtworkWork();
  state.loadGen += 1;
  state.requestAbort?.abort();
  state.requestAbort = null;
  state.loading = false;
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
}

export function renderGrid(host) {
  tearDown();
  host.appendChild(buildShell());
  state.enabledSignature = enabledSignature();
  state.contentPreference = getState().settings.showExplicitContent === true;
  load();
  subs.push(subscribe('current-item', (item) => { state.currentId = item?.id || null; renderTiles(); }));
  subs.push(subscribe('settings-change', (settings) => {
    if (getState().mode !== 'grid') return;
    const nextSignature = enabledSignature(settings);
    const nextPreference = settings.showExplicitContent === true;
    const sourcesChanged = nextSignature !== state.enabledSignature;
    const contentChanged = nextPreference !== state.contentPreference;
    state.enabledSignature = nextSignature;
    state.contentPreference = nextPreference;
    if (sourcesChanged) load();
    else if (contentChanged) applyContentPreference(nextPreference);
  }));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'grid') tryNextTile();
  }));
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'grid') tearDown();
  }));
}
