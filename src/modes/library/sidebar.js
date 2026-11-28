/**
 * Sidebar: three sections (Browse, By type, By archive). Builds the
 * markup once; `selectSource` mutates state + re-renders on click.
 *
 * `selectSource` is the only place that handles sidebar-tab transitions.
 * It normally does NOT trigger a fresh fetch — the chain runs from
 * all enabled sources regardless of the active tab, and refetching on
 * tab click was the cause of a rapid-click race that wiped the pool.
 * Public tabs resume an unsubmitted query or start an empty pool. Personal
 * collection filters never start a provider search.
 */

import { SOURCES, SOURCE_IDS, getSourceLabel } from '../../lib/sources.js';
import { getState } from '../../lib/state.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import {
  effectiveStatusSources, renderResults, renderStatus, updateSentinelStatus,
} from './render.js';
import { focusViewSources, runSearch, syncSnapshotVisibility } from './chain.js';
import { closeDetail } from './detail.js';
import { isPersonalSource } from './personal.js';
import { ensurePlaylistsLoaded, syncPersonalControls } from './personal-controls.js';

export function buildSidebar() {
  const sections = [
    { header: 'Browse', items: [
      { id: 'all',       name: 'All Sources', color: 'var(--text-mute)' },
      { id: 'favorites', name: 'Favorites',   color: 'var(--accent)'    },
      { id: 'playlists', name: 'My Playlists', color: 'var(--accent)' },
    ]},
    { header: 'By type', items: [
      { id: 'type:radio', name: 'Radio',  color: '#42a5f5' },
      { id: 'type:tv',    name: 'TV',     color: '#ef5350' },
      { id: 'type:video', name: 'Video',  color: '#f5a524' },
      { id: 'type:audio', name: 'Audio',  color: '#9c27b0' },
    ]},
    { header: 'By archive', items: SOURCES.map((s) => ({ id: s.id, name: s.displayName, color: s.color })) },
  ];

  const list = el('ul', {
    className: 'source-list',
    attrs: { role: 'listbox', 'aria-label': 'Browse media sources' },
  });
  for (const sec of sections) {
    list.appendChild(el('li', { className: 'source-section-header', attrs: { 'aria-hidden': 'true' }, text: sec.header }));
    for (const s of sec.items) {
      list.appendChild(sourceRow(s, list));
    }
  }
  syncSidebarSources(getState().settings.enabledSources, list);
  ui.sidebar.appendChild(list);
  queueMicrotask(() => list.querySelector('.source-item.is-active')
    ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
}

function sourceRow(s, list) {
  const isDirectSource = SOURCE_IDS.includes(s.id);
  const li = el('li', {
    className: 'source-item' + (view.activeSource === s.id ? ' is-active' : ''),
    attrs: {
      'data-source': s.id,
      role: 'option',
      tabindex: '0',
      'aria-selected': view.activeSource === s.id ? 'true' : 'false',
    },
    on: {
      click: () => selectSource(s.id),
      keydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectSource(s.id);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = [...list.querySelectorAll('.source-item')];
        const index = options.indexOf(event.currentTarget);
        const next = event.key === 'Home' ? options[0]
          : event.key === 'End' ? options.at(-1)
            : options[index + (event.key === 'ArrowDown' ? 1 : -1)];
        next?.focus();
        next?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      },
    },
  });
  li.appendChild(el('span', { className: 'source-name' },
    el('span', { className: 'source-dot', style: { background: s.color } }),
    el('span', { className: 'source-label', text: s.name }),
  ));
  li.appendChild(el('span', { className: 'source-count', attrs: { 'data-role': 'count' } }));
  if (isDirectSource) {
    li.appendChild(el('span', {
      className: 'source-health is-pull',
      text: 'Pull',
      attrs: { 'data-role': 'source-health', title: 'Collecting' },
    }));
  }
  return li;
}

export function syncComputerSource() {
  const list = ui.sidebar?.querySelector?.('.source-list');
  if (!list) return;
  const row = [...list.children].find((child) => child.dataset.source === 'computer');
  if (view.computerHits.length) {
    if (!row) list.appendChild(sourceRow({ id: 'computer', name: getSourceLabel('computer'), color: 'var(--accent)' }, list));
    return;
  }
  if (view.activeSource === 'computer') {
    view.activeSource = 'all';
    markSelectedSource('all');
    closeDetail();
  }
  row?.remove();
}

function markSelectedSource(sourceId) {
  for (const li of ui.sidebar.querySelectorAll('.source-item')) {
    const active = li.dataset.source === sourceId;
    li.classList.toggle('is-active', active);
    li.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) li.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

// Only the source switches drive this order. Status and count updates leave rows in place.
export function syncSidebarSources(enabledSources, list = ui.sidebar?.querySelector('.source-list')) {
  if (!list) return;
  const archiveRows = [...list.children].filter((row) => SOURCE_IDS.includes(row.dataset.source));
  const rowsById = new Map(archiveRows.map((row) => [row.dataset.source, row]));
  const on = [];
  const off = [];
  for (const { id, displayName } of SOURCES) {
    const row = rowsById.get(id);
    if (!row) continue;
    const disabled = enabledSources[id] === false;
    row.classList.toggle('is-disabled', disabled);
    if (disabled) {
      row.setAttribute('aria-label', `${displayName} (off)`);
      off.push(row);
    } else {
      row.removeAttribute('aria-label');
      on.push(row);
    }
  }
  const wanted = [...on, ...off];
  if (wanted.every((row, index) => row === archiveRows[index])) return;
  const focused = document.activeElement;
  for (const row of wanted) list.appendChild(row);
  if (wanted.includes(focused)) focused.focus({ preventScroll: true });
}

export function selectSource(sourceId) {
  const sourceOff = getState().settings.enabledSources[sourceId] === false;
  view.activeSource = sourceId;
  view.searchDebounced?.cancel?.();
  syncPersonalControls();
  // The first read may have failed (the playlists-change event redraws).
  if (sourceId === 'playlists') void ensurePlaylistsLoaded();
  if (sourceId && sourceId.startsWith('type:')) {
    view.filters.type = sourceId.slice('type:'.length);
  } else {
    view.filters.type = '';
  }
  markSelectedSource(sourceId);
  closeDetail();

  // Just re-render with the new filter. No refetch — the chain keeps going
  // regardless of which tab is active. Edge case: if we've never started
  // the chain (view.items is empty AND we're not entering favorites where
  // the pool is irrelevant), kick off a fresh runSearch. An empty pool while
  // the first pages are still on their way is not that case: starting over
  // would cancel and repeat every source's first request.
  const poolIsEmpty = view.items.length === 0;
  const chainIdle = !view.catalogActive || view.sourceProgress.size === 0;
  const headingNonFav = !sourceOff && !isPersonalSource(sourceId);
  const pendingQuery = (view.query || '').trim() !== (view.lastQuery || '').trim();
  if (headingNonFav && ((poolIsEmpty && chainIdle) || pendingQuery)) {
    runSearch();
    return;
  }
  // The selected sources' pending work goes ahead of background prefetch.
  if (headingNonFav && sourceId !== 'all') focusViewSources(effectiveStatusSources());
  // Live lists refresh only while shown (chain.js).
  syncSnapshotVisibility();
  renderResults();
  renderStatus();
  updateSentinelStatus();
}
