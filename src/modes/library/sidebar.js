/**
 * Sidebar: three sections (Browse, By type, By archive). Builds the
 * markup once; `selectSource` mutates state + re-renders on click.
 *
 * `selectSource` is the only place that handles sidebar-tab transitions.
 * It deliberately does NOT trigger a fresh fetch — the chain runs from
 * all enabled sources regardless of the active tab, and refetching on
 * tab click was the cause of a rapid-click race that wiped the pool.
 * The only case that needs `runSearch` is when the pool is still empty
 * (e.g. an enabled-source toggle hasn't had its first batch yet).
 */

import { SOURCES } from '../../lib/sources.js';
import { getState } from '../../lib/state.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { renderResults, renderStatus, updateSentinelStatus } from './render.js';
import { runSearch } from './chain.js';
import { closeDetail } from './detail.js';

export function buildSidebar() {
  const sections = [
    { header: 'Browse', items: [
      { id: 'all',       name: 'All Sources', color: 'var(--text-mute)' },
      { id: 'favorites', name: 'Favorites',   color: 'var(--accent)'    },
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
      const isDirectSource = SOURCES.some((source) => source.id === s.id);
      const disabled = isDirectSource && getState().settings.enabledSources[s.id] === false;
      const li = el('li', {
        className: 'source-item'
          + (view.activeSource === s.id ? ' is-active' : '')
          + (disabled ? ' is-disabled' : ''),
        attrs: {
          'data-source': s.id,
          role: 'option',
          tabindex: '0',
          'aria-selected': view.activeSource === s.id ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : 'false',
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
      list.appendChild(li);
    }
  }
  ui.sidebar.appendChild(list);
  queueMicrotask(() => list.querySelector('.source-item.is-active')
    ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
}

export function selectSource(sourceId) {
  if (SOURCES.some((source) => source.id === sourceId)
      && getState().settings.enabledSources[sourceId] === false) return;
  view.activeSource = sourceId;
  if (sourceId && sourceId.startsWith('type:')) {
    view.filters.type = sourceId.slice('type:'.length);
  } else {
    view.filters.type = '';
  }
  for (const li of ui.sidebar.querySelectorAll('.source-item')) {
    const active = li.dataset.source === sourceId;
    li.classList.toggle('is-active', active);
    li.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) li.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  closeDetail();

  // Just re-render with the new filter. No refetch — the chain keeps going
  // regardless of which tab is active. Edge case: if we've never started
  // the chain (view.items is empty AND we're not entering favorites where
  // the pool is irrelevant), kick off a fresh runSearch.
  const poolIsEmpty = view.items.length === 0;
  const headingNonFav = sourceId !== 'favorites';
  if (poolIsEmpty && headingNonFav) {
    runSearch();
    return;
  }
  renderResults();
  renderStatus();
  updateSentinelStatus();
}
