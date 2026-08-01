/**
 * Discovery Mode — random item from random enabled source.
 */

import { randomOne } from '../lib/search.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { playItem } from '../lib/player.js';
import { getState, subscribe } from '../lib/state.js';
import { isArtworkRelayUrl, loadArtworkImage, resolveArtworkRelay } from '../lib/artwork.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import {
  DISCOVERY_ATTEMPT_DEADLINE_MS, withDiscoveryAttemptDeadline,
} from './discovery-attempt.js';
import { contentBadgeText, isContentAllowed } from '../lib/content-rating.js';

const ui = {};
const state = {
  current: null,
  filter: { type: '', country: '', tag: '', source: 'all' },
  loading: false,
  requestAbort: null,
  artworkAbort: null,
  requestGen: 0,
};

const DISCOVERY_DEADLINE_MS = 20_000;

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
  const root = el('div', { className: 'discovery-root' });

  const filters = el('div', { className: 'discovery-filters' });
  const TYPES = [
    { v: '', label: 'Any type' },
    { v: 'radio', label: 'Radio only' },
    { v: 'tv', label: 'TV only' },
    { v: 'video', label: 'Video only' },
    { v: 'audio', label: 'Audio only' },
  ];
  for (const t of TYPES) {
    const c = el('button', {
      className: 'chip' + (state.filter.type === t.v ? ' is-active' : ''),
      attrs: { 'data-type': t.v, 'aria-pressed': state.filter.type === t.v ? 'true' : 'false' },
      on: { click: () => {
        state.filter.type = t.v;
        for (const x of filters.querySelectorAll('.chip[data-type]')) {
          const active = x.dataset.type === t.v;
          x.classList.toggle('is-active', active);
          x.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      } },
      text: t.label,
    });
    filters.appendChild(c);
  }
  // Country and tag — spec §4.4 calls these out explicitly.
  const country = el('input', {
    className: 'chip',
    attrs: { type: 'text', placeholder: 'Country (e.g. US)', maxlength: '2', size: '6', value: state.filter.country || '' },
    style: { width: '130px', padding: '4px 10px' },
    on: { input: (e) => { state.filter.country = e.target.value.trim().toUpperCase(); } },
  });
  const tag = el('input', {
    className: 'chip',
    attrs: { type: 'text', placeholder: 'Tagged (e.g. jazz)', size: '10', value: state.filter.tag || '' },
    style: { width: '140px', padding: '4px 10px' },
    on: { input: (e) => { state.filter.tag = e.target.value.trim().toLowerCase(); } },
  });
  filters.appendChild(country);
  filters.appendChild(tag);
  ui.sourceSel = el('select', {
    className: 'chip',
    attrs: { 'aria-label': 'Discovery source' },
    on: { change: () => { state.filter.source = ui.sourceSel.value; } },
  });
  filters.appendChild(ui.sourceSel);
  root.appendChild(filters);

  const stage = el('div', { className: 'discovery-stage' });
  ui.btn = el('button', { className: 'surprise-btn', text: 'Surprise Me', on: { click: () => surprise() } });
  stage.appendChild(ui.btn);
  ui.now = el('div', { className: 'discovery-now', attrs: { hidden: '' } });
  stage.appendChild(ui.now);

  const actions = el('div', { className: 'discovery-actions' });
  ui.nextBtn = el('button', { className: 'btn', text: 'Next', on: { click: () => surprise() } });
  ui.nextBtn.style.display = 'none';
  actions.appendChild(ui.nextBtn);
  stage.appendChild(actions);
  ui.status = el('div', { className: 'discovery-source-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  stage.appendChild(ui.status);

  root.appendChild(stage);
  return root;
}

function rebuildSourceSelect() {
  if (!ui.sourceSel) return;
  const enabled = SOURCES.filter((source) => getState().settings.enabledSources[source.id] !== false);
  if (state.filter.source !== 'all' && !enabled.some(({ id }) => id === state.filter.source)) {
    state.filter.source = 'all';
  }
  ui.sourceSel.innerHTML = '';
  ui.sourceSel.appendChild(el('option', { attrs: { value: 'all' }, text: 'Any source' }));
  for (const source of enabled) {
    ui.sourceSel.appendChild(el('option', { attrs: { value: source.id }, text: source.displayName }));
  }
  ui.sourceSel.value = state.filter.source;
}

function renderNow(item) {
  if (state.artworkAbort && !state.artworkAbort.signal.aborted) state.artworkAbort.abort();
  state.artworkAbort = new AbortController();
  const artworkSignal = state.artworkAbort.signal;
  ui.now.innerHTML = '';
  ui.now.removeAttribute('hidden');
  const artworkToken = Symbol('discovery-artwork');
  ui.now.__artworkToken = artworkToken;
  const appendArtwork = () => {
    if (!isArtworkRelayUrl(item.thumbnail) || ui.now.__artworkToken !== artworkToken) return;
    const img = el('img', { attrs: { alt: '', referrerpolicy: 'no-referrer' } });
    ui.now.insertBefore(img, ui.now.firstChild);
    void loadArtworkImage(img, item.thumbnail.trim(), {
      priority: 20,
      signal: artworkSignal,
    }).catch((error) => {
      if (error?.name !== 'AbortError') img.remove();
    });
  };
  if (isArtworkRelayUrl(item.thumbnail)) {
    appendArtwork();
  } else {
    resolveArtworkRelay(item, { priority: 20, signal: artworkSignal })
      .then(appendArtwork).catch(() => {});
  }

  const text = el('div', { className: 'now-text' });
  text.appendChild(el('div', { className: 'now-source', text: getSourceLabel(item.source) }));
  const rating = contentBadgeText(item);
  if (rating) text.appendChild(el('span', { className: 'content-rating-badge', text: rating }));
  text.appendChild(el('h2', { text: item.title }));
  text.appendChild(el('p', { text: item.description || '' }));
  ui.now.appendChild(text);
}

async function surprise() {
  if (state.loading) return;
  const requestGen = ++state.requestGen;
  state.loading = true;
  ui.btn.textContent = 'Searching…';
  ui.btn.disabled = true;

  try {
    const enabled = SOURCES.filter((s) => getState().settings.enabledSources[s.id] !== false);
    const filterType = state.filter.type;
    const filterCountry = state.filter.country;
    const filterTag = state.filter.tag;
    let candidatePool = enabled;
    if (state.filter.source !== 'all') {
      candidatePool = candidatePool.filter((source) => source.id === state.filter.source);
    }
    if (filterType) {
      candidatePool = candidatePool.filter((s) => s.types.includes(filterType));
    }
    ui.status.textContent = `Searching ${candidatePool.length} ${candidatePool.length === 1 ? 'source' : 'sources'}…`;
    const shuffled = [...candidatePool].sort(() => Math.random() - 0.5);

    const passes = (i) => {
      if (filterType && i.type !== filterType) return false;
      if (filterCountry && (!i.country || i.country.toUpperCase() !== filterCountry)) return false;
      if (filterTag && !(i.tags || []).some((t) => String(t).toLowerCase().includes(filterTag))) return false;
      return true;
    };

    const controller = new AbortController();
    state.requestAbort = controller;
    const deadline = setTimeout(() => controller.abort(), DISCOVERY_DEADLINE_MS);
    let chosen = null;
    try {
      // Queue every eligible provider together and use the first real match.
      // The shared scheduler starts at most four operations at once, fairly
      // rotates sources, and cancels both queued and active losers.
      const attempts = shuffled.map((source) => catalogScheduler.enqueue({
        sourceId: source.id,
        key: `discovery:${requestGen}`,
        priority: CATALOG_PRIORITY.USER,
        signal: controller.signal,
        task: ({ signal }) => withDiscoveryAttemptDeadline(signal, async (attemptSignal) => {
          // Give every group of sources a bounded chance within the overall
          // deadline. Otherwise four hung providers could occupy every slot
          // until the whole Discovery request expires.
          const opts = { limit: 20, signal: attemptSignal, throwOnError: true };
          if (filterCountry) opts.country = filterCountry;
          if (filterTag) opts.tag = filterTag;
          const items = await randomOne(source.id, opts);
          const pool = items.filter(passes);
          return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
        }, { timeoutMs: DISCOVERY_ATTEMPT_DEADLINE_MS }),
      }).then((item) => {
        // An honest empty result is a successful provider response, not a
        // transport failure/cooldown. Reject only outside the scheduler so
        // Promise.any can continue waiting for another source.
        if (!item) throw new Error(`${source.id} returned no matching items`);
        return item;
      }));
      if (attempts.length > 0) chosen = await Promise.any(attempts).catch(() => null);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (state.requestAbort === controller) state.requestAbort = null;
    }
    if (requestGen !== state.requestGen || getState().mode !== 'discovery') return;
    if (chosen) {
      state.current = chosen;
      renderNow(chosen);
      playItem(chosen).catch(() => {});
      ui.btn.textContent = 'Surprise Me Again';
      ui.nextBtn.style.display = 'inline-flex';
      ui.status.textContent = `Selected from ${getSourceLabel(chosen.source)}.`;
    } else {
      ui.btn.textContent = 'No results — try again';
      ui.status.textContent = 'No matching item was returned by the selected sources.';
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.warn('Discovery failed:', err);
    if (requestGen === state.requestGen && getState().mode === 'discovery') {
      ui.btn.textContent = 'Surprise Me';
    }
  } finally {
    if (requestGen === state.requestGen) {
      state.loading = false;
      if (getState().mode === 'discovery') ui.btn.disabled = false;
    }
  }
}

const subs = [];
function tearDown() {
  state.requestGen += 1;
  if (state.requestAbort) state.requestAbort.abort();
  state.requestAbort = null;
  if (state.artworkAbort && !state.artworkAbort.signal.aborted) state.artworkAbort.abort();
  state.artworkAbort = null;
  state.loading = false;
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
}

export function renderDiscovery(host) {
  tearDown();
  host.appendChild(buildShell());
  rebuildSourceSelect();
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'discovery') tearDown();
  }));
  subs.push(subscribe('player-broken-next', () => {
    if (getState().mode === 'discovery') surprise();
  }));
  subs.push(subscribe('settings-change', (settings) => {
    rebuildSourceSelect();
    if (state.current && (!isContentAllowed(state.current, settings)
        || settings.enabledSources[state.current.source] === false)) {
      state.current = null;
      ui.now.innerHTML = '';
      ui.now.setAttribute('hidden', '');
      ui.nextBtn.style.display = 'none';
      ui.btn.textContent = 'Surprise Me';
    }
  }));
}
