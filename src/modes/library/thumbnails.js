/**
 * Thumbnail rendering + lazy artwork hydration.
 *
 *  - Cards mount with a lightweight <img> shell, but its relay request does
 *    not begin until the card is current/nearby.  This avoids flooding the
 *    local artwork relay when a catalog page renders hundreds of cards.
 *  - Missing artwork is resolved through the same viewport-aware flow.
 *
 * The `__query` filtering on items lives in filter.js — we don't touch it
 * here; we only act on items that the renderer has already decided to mount.
 */

import { el } from './utils.js';
import { thumbHydration } from './state.js';
import { getState } from '../../lib/state.js';
import { isContentAllowed } from '../../lib/content-rating.js';
import {
  artworkNeedsResolution,
  createTaskQueue,
  isArtworkRelayUrl,
  loadArtworkImage,
  resolveArtworkRelay,
  retryArtworkLookup,
} from '../../lib/artwork.js';

export {
  ARTWORK_MAX_ATTEMPTS,
  ARTWORK_MAX_CONCURRENT,
  ARTWORK_IMAGE_MAX_CONCURRENT,
  ARTWORK_RETRY_BASE_MS,
  ARTWORK_TASK_TIMEOUT_MS,
  createTaskQueue,
  retryArtworkLookup,
} from '../../lib/artwork.js';

export const THUMBNAIL_EAGER_CARD_COUNT = 24;
export const THUMBNAIL_PREFETCH_MARGIN_PX = 1_800;

export function getThumbnailHydrationSignal() {
  if (!thumbHydration.abortController || thumbHydration.abortController.signal.aborted) {
    thumbHydration.abortController = new AbortController();
  }
  return thumbHydration.abortController.signal;
}

export function resetThumbnailHydrationScope() {
  if (thumbHydration.abortController && !thumbHydration.abortController.signal.aborted) {
    thumbHydration.abortController.abort();
  }
  thumbHydration.abortController = new AbortController();
  return thumbHydration.abortController.signal;
}

export function cancelThumbnailHydration() {
  if (thumbHydration.abortController && !thumbHydration.abortController.signal.aborted) {
    thumbHydration.abortController.abort();
  }
  thumbHydration.abortController = null;
}

/** Only an exact opaque local asset relay is safe to attach to an image.
 *  Provider HTTP(S) metadata must first pass through resolveArtworkRelay().
 *  Filters out null, undefined, '', the literal string "null", and any
 *  other garbage that occasionally slips through from upstream feeds. */
export function isValidThumbnailUrl(u) {
  return isArtworkRelayUrl(u);
}

function startThumbImage(img, opts = {}) {
  const src = img?.dataset?.artworkSrc;
  if (!img || !src || img.dataset.artworkStarted === 'true') return;
  img.dataset.artworkStarted = 'true';
  const signal = opts.signal || getThumbnailHydrationSignal();
  void loadArtworkImage(img, src, {
    signal,
    priority: opts.priority ?? (opts.eager === true ? 20 : 5),
  }).then(() => {
    if (img.naturalWidth > 0) {
      img.classList.remove('errored');
      img.classList.add('loaded');
    }
  }).catch((error) => {
    if (error?.name !== 'AbortError' && img.isConnected) img.classList.add('errored');
  });
}

export function createThumbImage(item, opts = {}) {
  if (!isContentAllowed(item, getState().settings) || item?.__contentHidden === true) return null;
  if (!isValidThumbnailUrl(item.thumbnail)) return null;
  const src = item.thumbnail.trim();
  const eager = opts.eager === true;
  const img = el('img', { attrs: {
    alt: '',
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    fetchpriority: eager ? 'high' : 'low',
    referrerpolicy: 'no-referrer',
  } });
  if (item.type === 'tv' || item.type === 'radio') img.classList.add('logo-art');
  img.dataset.artworkSrc = src;
  if (eager) {
    queueMicrotask(() => startThumbImage(img, {
      ...opts,
      signal: opts.signal || getThumbnailHydrationSignal(),
      priority: opts.priority ?? 20,
      eager: true,
    }));
  }
  return img;
}

export function insertThumbImage(thumb, item, beforeNode = null, opts = {}) {
  if (!isValidThumbnailUrl(item.thumbnail) || thumb.querySelector('img')) return;
  const img = createThumbImage(item, opts);
  if (!img) return;
  if (beforeNode?.parentNode === thumb) thumb.insertBefore(img, beforeNode);
  else thumb.appendChild(img);
}

/** Resolve missing artwork via the adapter's `resolveArtwork` (if exported).
 *  Promises are deduped by item id so concurrent callers share one request. */
export async function resolveItemArtwork(item, opts = {}) {
  if (!isContentAllowed(item, getState().settings) || item?.__contentHidden === true) return item;
  if (!item || isValidThumbnailUrl(item.thumbnail) || !artworkNeedsResolution(item)) return item;
  return resolveArtworkRelay(item, opts).catch((error) => {
    console.warn('thumbnail hydrate failed:', error);
    throw error;
  });
}

async function hydrateCardThumbnail(item, thumb, beforeNode, opts = {}) {
  if (!item) return;
  try {
    if (!isValidThumbnailUrl(item.thumbnail)) await resolveItemArtwork(item, opts);
    if (thumb && thumb.isConnected) {
      insertThumbImage(thumb, item, beforeNode, opts);
      startThumbImage(thumb.querySelector('img'), opts);
    }
  } catch (_) {
    // resolveItemArtwork logs the terminal error after its bounded retries.
    // Leave the source-branded placeholder visible.
  }
}

export function requestThumbnailHydration(card, item, thumb, beforeNode, opts = {}) {
  if (!isContentAllowed(item, getState().settings) || item?.__contentHidden === true) return;
  const hasRelayArtwork = isValidThumbnailUrl(item.thumbnail);
  if (!hasRelayArtwork && !artworkNeedsResolution(item)) return;
  const signal = opts.signal || getThumbnailHydrationSignal();
  const activate = (priority, eager) => {
    const activeOptions = { ...opts, signal, priority, eager };
    if (isValidThumbnailUrl(item.thumbnail)) {
      startThumbImage(thumb?.querySelector('img'), activeOptions);
    } else {
      hydrateCardThumbnail(item, thumb, beforeNode, activeOptions);
    }
  };
  if (opts.eager === true) {
    queueMicrotask(() => activate(20, true));
    return;
  }
  if (!('IntersectionObserver' in window)) {
    queueMicrotask(() => activate(20, true));
    return;
  }
  const observerRoot = card.closest?.('.results') || null;
  if (thumbHydration.observer && thumbHydration.observerRoot !== observerRoot) {
    thumbHydration.observer.disconnect();
    thumbHydration.observer = null;
  }
  if (!thumbHydration.observer) {
    thumbHydration.observerRoot = observerRoot;
    thumbHydration.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbHydration.observer.unobserve(entry.target);
        const cfg = entry.target.__thumbHydration;
        delete entry.target.__thumbHydration;
        if (!cfg) continue;
        const rootRect = observerRoot?.getBoundingClientRect?.()
          || { top: 0, bottom: globalThis.innerHeight || 0 };
        const visibleNow = entry.boundingClientRect.bottom >= rootRect.top
          && entry.boundingClientRect.top <= rootRect.bottom;
        const activeOptions = {
          ...cfg.opts,
          priority: visibleNow ? 20 : 5,
          eager: visibleNow,
        };
        if (isValidThumbnailUrl(cfg.item.thumbnail)) {
          startThumbImage(cfg.thumb?.querySelector('img'), activeOptions);
        } else {
          hydrateCardThumbnail(cfg.item, cfg.thumb, cfg.beforeNode, activeOptions);
        }
      }
    }, { root: observerRoot, rootMargin: `${THUMBNAIL_PREFETCH_MARGIN_PX}px 0px` });
  }
  card.__thumbHydration = { item, thumb, beforeNode, opts: { ...opts, signal } };
  thumbHydration.observer.observe(card);
}
