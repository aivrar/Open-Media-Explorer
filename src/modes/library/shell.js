/**
 * Top-level layout for the library mode. Builds the three-column grid
 * (sidebar / main area / detail-on-demand), wires the search input,
 * the country/language/year filter chips, and the sentinel
 * IntersectionObserver. Returns the root element ready to mount.
 */

import { debounce } from '../../lib/search.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import {
  renderResults, renderStatus, updateSentinelStatus, rewindRenderWindow,
} from './render.js';
import {
  runSearch, onSentinelVisible, retrySources, loadMoreNow,
} from './chain.js';
import { buildSidebar } from './sidebar.js';

export function buildShell() {
  ui.root = el('div', { className: 'library-root' });

  ui.sidebar = el('aside', { className: 'library-sidebar' });
  buildSidebar();

  const searchBar = el('div', { className: 'library-search-bar' });
  const wrap = el('div', { className: 'search-input-wrap' });
  wrap.appendChild(el('span', {
    className: 'search-icon',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  }));
  ui.searchInput = el('input', {
    className: 'search-input',
    attrs: { type: 'search', placeholder: 'Search radio, TV, archives… try "news", "BBC", "Prelinger"', autocomplete: 'off' },
  });
  ui.searchInput.value = view.query || '';
  wrap.appendChild(ui.searchInput);
  searchBar.appendChild(wrap);

  ui.chipsHost = el('div', { className: 'filter-chips' });
  // Country / language / year filters (spec §4.1). Source-type filtering
  // lives in the sidebar; these chips refine within the chosen source/type.
  ui.countryInput = el('input', {
    className: 'chip',
    attrs: { type: 'text', placeholder: 'Country (e.g. US)', maxlength: '2', size: '6' },
    style: { width: '120px', padding: '4px 10px' },
    on: { input: (e) => {
      view.filters.country = e.target.value.trim().toUpperCase();
      renderResults(); renderStatus(); updateSentinelStatus();
    } },
  });
  ui.countryInput.value = view.filters.country || '';
  ui.languageInput = el('input', {
    className: 'chip',
    attrs: { type: 'text', placeholder: 'Lang (e.g. en)', maxlength: '3', size: '6' },
    style: { width: '110px', padding: '4px 10px' },
    on: { input: (e) => {
      view.filters.language = e.target.value.trim().toLowerCase();
      renderResults(); renderStatus(); updateSentinelStatus();
    } },
  });
  ui.languageInput.value = view.filters.language || '';
  ui.yearMinInput = el('input', {
    className: 'chip',
    attrs: { type: 'number', placeholder: 'Year ≥', min: '1800', max: '2100' },
    style: { width: '90px', padding: '4px 10px' },
    on: { input: (e) => {
      view.filters.yearMin = parseInt(e.target.value, 10) || null;
      renderResults(); renderStatus(); updateSentinelStatus();
    } },
  });
  ui.yearMinInput.value = view.filters.yearMin ?? '';
  ui.yearMaxInput = el('input', {
    className: 'chip',
    attrs: { type: 'number', placeholder: 'Year ≤', min: '1800', max: '2100' },
    style: { width: '90px', padding: '4px 10px' },
    on: { input: (e) => {
      view.filters.yearMax = parseInt(e.target.value, 10) || null;
      renderResults(); renderStatus(); updateSentinelStatus();
    } },
  });
  ui.yearMaxInput.value = view.filters.yearMax ?? '';
  ui.chipsHost.appendChild(ui.countryInput);
  ui.chipsHost.appendChild(ui.languageInput);
  ui.chipsHost.appendChild(ui.yearMinInput);
  ui.chipsHost.appendChild(ui.yearMaxInput);
  searchBar.appendChild(ui.chipsHost);

  const main = el('section', { className: 'library-main' }, searchBar);
  const resultsArea = el('div', { className: 'results', attrs: { 'data-role': 'results' } });
  ui.statusHost = el('div', {
    className: 'results-status',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': 'Source loading status' },
  });
  ui.windowBack = el('button', {
    className: 'btn results-window-back',
    text: 'Show earlier items',
    style: { display: 'none' },
    on: { click: () => rewindRenderWindow() },
  });
  ui.resultsHost = el('div', { className: 'cards-grid' });
  // Sentinel at the bottom of the results: when it intersects (within
  // 1000 px of) the results scroller, fire the chain. Doubles as a
  // status row + Load-more affordance.
  ui.sentinel = el('div', {
    className: 'results-loadmore',
    attrs: { 'data-role': 'sentinel' },
    text: '',
  });
  ui.sentinelStatus = el('span', { className: 'sentinel-status', text: '' });
  ui.sentinelButton = el('button', {
    className: 'btn sentinel-loadmore-btn',
    text: 'Load more',
    style: { display: 'none', marginLeft: '12px' },
    on: { click: () => {
      if (ui.sentinelButton.dataset.action === 'more') {
        loadMoreNow();
        return;
      }
      retrySources({
        restartExhausted: ui.sentinelButton.dataset.restartExhausted === 'true',
      });
    } },
  });
  ui.sentinel.appendChild(ui.sentinelStatus);
  ui.sentinel.appendChild(ui.sentinelButton);
  resultsArea.appendChild(ui.statusHost);
  resultsArea.appendChild(ui.windowBack);
  resultsArea.appendChild(ui.resultsHost);
  resultsArea.appendChild(ui.sentinel);
  main.appendChild(resultsArea);
  main.style.display = 'grid';
  main.style.gridTemplateRows = 'auto minmax(0, 1fr)';
  main.style.overflow = 'hidden';

  ui.root.appendChild(ui.sidebar);
  ui.root.appendChild(main);

  ui.detailPanel = null;

  // Debounced search.
  const debounced = debounce(() => runSearch(), 300);
  view.searchDebounced = debounced;
  ui.searchInput.addEventListener('input', (e) => {
    view.query = e.target.value;
    debounced();
  });

  // Infinite-scroll observer. Fires when the sentinel is within 1000 px
  // of the visible region of the results scroller, even if the user
  // didn't generate a fresh scroll event (covers "user scrolled while
  // initial load was in flight").
  if (view.infiniteObserver) {
    try { view.infiniteObserver.disconnect(); } catch (_) {}
  }
  view.infiniteObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onSentinelVisible();
    }
  }, { root: resultsArea, rootMargin: '1000px 0px 1000px 0px' });
  view.infiniteObserver.observe(ui.sentinel);

  return ui.root;
}
