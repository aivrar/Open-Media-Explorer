/**
 * Right-side detail panel for the currently selected item. Opens when a
 * card is clicked, closes via its own Close button or when the user
 * navigates source/mode. The panel is mounted on demand and removed
 * when closed — no persistent DOM cost when nothing is selected.
 */

import { getState, isFavorite, addFavorite, removeFavorite } from '../../lib/state.js';
import { getSourceLabel } from '../../lib/sources.js';
import { safeExternalUrl } from '../../lib/item-model.js';
import { isArtworkRelayUrl, loadArtworkImage } from '../../lib/artwork.js';
import { playItem } from '../../lib/player.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { resolveItemArtwork } from './thumbnails.js';
import {
  contentBadgeText, favoriteForContentView, isContentAllowed,
} from '../../lib/content-rating.js';

let detailReturnFocus = null;
let detailKeyHandler = null;
let detailArtworkAbort = null;

function bindDetailKeys() {
  if (detailKeyHandler || !globalThis.document?.addEventListener) return;
  detailKeyHandler = (event) => {
    if (event.key !== 'Escape' || !ui.detailPanel) return;
    // The detail panel is non-modal.  Do not let its Escape shortcut close
    // content behind a focused EQ/settings dialog or another app control.
    if (!ui.detailPanel.contains(document.activeElement)) return;
    event.preventDefault();
    closeDetail();
  };
  document.addEventListener('keydown', detailKeyHandler);
}

function unbindDetailKeys() {
  if (!detailKeyHandler) return;
  document.removeEventListener('keydown', detailKeyHandler);
  detailKeyHandler = null;
}

export function openDetail(item, options = {}) {
  if (!item?.id) return;
  if (!isContentAllowed(item, getState().settings) && !isFavorite(item.id)) {
    closeDetail();
    return;
  }
  if (detailArtworkAbort && !detailArtworkAbort.signal.aborted) detailArtworkAbort.abort();
  detailArtworkAbort = new AbortController();
  const detailArtworkSignal = detailArtworkAbort.signal;
  item = favoriteForContentView(item, getState().settings);
  view.detailItemId = item.id;
  if (!ui.detailPanel) {
    ui.detailPanel = el('aside', {
      className: 'detail-panel',
      attrs: { 'aria-labelledby': 'library-detail-title' },
    });
    ui.root.appendChild(ui.detailPanel);
    ui.root.classList.add('has-detail');
  }
  if (options.focus === true && !ui.detailPanel.contains(document.activeElement)) {
    detailReturnFocus = document.activeElement;
  }
  bindDetailKeys();
  ui.detailPanel.innerHTML = '';
  const closeBtn = el('button', {
    className: 'btn detail-close',
    attrs: { 'aria-label': 'Close media details' },
    on: { click: () => closeDetail() },
    text: 'Close',
  });
  ui.detailPanel.appendChild(closeBtn);

  const detailThumb = el('img', {
    className: 'detail-thumb',
    attrs: { alt: '', referrerpolicy: 'no-referrer' },
  });
  const loadDetailArtwork = () => {
    if (!isArtworkRelayUrl(item.thumbnail) || !detailThumb.isConnected) return;
    detailThumb.style.display = '';
    void loadArtworkImage(detailThumb, item.thumbnail.trim(), {
      priority: 30,
      signal: detailArtworkSignal,
    }).catch((error) => {
      if (error?.name !== 'AbortError') detailThumb.style.display = 'none';
    });
  };
  if (isArtworkRelayUrl(item.thumbnail) && isContentAllowed(item, getState().settings)) {
    ui.detailPanel.appendChild(detailThumb);
    loadDetailArtwork();
  } else {
    // Artwork may still be hydrating — append (hidden) and fill in once resolved.
    detailThumb.style.display = 'none';
    ui.detailPanel.appendChild(detailThumb);
    if (item.__contentHidden !== true) {
      resolveItemArtwork(item, { priority: 30, signal: detailArtworkSignal }).then(() => {
        if (isArtworkRelayUrl(item.thumbnail) && detailThumb.isConnected) {
          loadDetailArtwork();
        }
      }).catch(() => {});
    }
  }

  ui.detailPanel.appendChild(el('h2', {
    className: 'detail-title',
    text: item.title,
    attrs: { id: 'library-detail-title' },
  }));
  const meta = el('div', { className: 'detail-meta' });
  meta.appendChild(el('span', { className: 'source-badge', text: getSourceLabel(item.source) }));
  if (item.year) meta.appendChild(el('span', { text: String(item.year) }));
  if (item.country) meta.appendChild(el('span', { text: item.country }));
  if (item.language) meta.appendChild(el('span', { text: item.language }));
  if (item.license) meta.appendChild(el('span', { text: item.license }));
  const ratingLabel = contentBadgeText(item);
  if (ratingLabel && item.__contentHidden !== true) {
    meta.appendChild(el('span', { className: 'content-rating-badge', text: ratingLabel }));
  }
  ui.detailPanel.appendChild(meta);
  if (item.tags && item.tags.length) {
    const tagsHost = el('div', { className: 'detail-meta' });
    for (const t of item.tags.slice(0, 12)) tagsHost.appendChild(el('span', { className: 'chip', text: t }));
    ui.detailPanel.appendChild(tagsHost);
  }
  ui.detailPanel.appendChild(el('p', { className: 'detail-description', text: item.description || '' }));

  const actions = el('div', { className: 'detail-actions' });
  if (item.__contentHidden !== true) {
    actions.appendChild(el('button', { className: 'btn btn-primary', text: 'Play', on: { click: () => playItem(item) } }));
  }
  if (item.__contentHidden !== true || isFavorite(item.id)) {
    const favBtn = el('button', {
      className: 'btn',
      text: isFavorite(item.id) ? '★ Favorited' : '☆ Favorite',
      attrs: { 'aria-pressed': isFavorite(item.id) ? 'true' : 'false' },
      on: { click: () => {
        if (isFavorite(item.id)) {
          removeFavorite(item.id);
          favBtn.textContent = '☆ Favorite';
          favBtn.setAttribute('aria-pressed', 'false');
        } else if (item.__contentHidden !== true) {
          addFavorite(item);
          favBtn.textContent = '★ Favorited';
          favBtn.setAttribute('aria-pressed', 'true');
        }
      } },
    });
    actions.appendChild(favBtn);
  }
  const sourceUrl = safeExternalUrl(item.source_url);
  if (sourceUrl && item.__contentHidden !== true) {
    actions.appendChild(el('a', { className: 'btn', attrs: { href: sourceUrl, target: '_blank', rel: 'noopener' }, text: 'Source ↗' }));
  }
  ui.detailPanel.appendChild(actions);
  if (options.focus === true) queueMicrotask(() => closeBtn.isConnected && closeBtn.focus());
}

export function closeDetail({ preserveSelection = false } = {}) {
  if (detailArtworkAbort && !detailArtworkAbort.signal.aborted) detailArtworkAbort.abort();
  detailArtworkAbort = null;
  if (ui.detailPanel) {
    ui.detailPanel.remove();
    ui.detailPanel = null;
    ui.root?.classList.remove('has-detail');
  }
  unbindDetailKeys();
  if (!preserveSelection && detailReturnFocus?.isConnected) detailReturnFocus.focus?.();
  detailReturnFocus = null;
  if (!preserveSelection) view.detailItemId = null;
}

/** Resolve the item to remount after mode navigation without conflating a
 * deliberately closed panel with a panel removed only for teardown. */
export function getRestorableDetailItem(currentItem, itemIndex, favorites = []) {
  if (!view.detailItemId) return null;
  if (currentItem?.id === view.detailItemId) return currentItem;
  return itemIndex?.get?.(view.detailItemId)
    || favorites.find?.((item) => item?.id === view.detailItemId)
    || null;
}
