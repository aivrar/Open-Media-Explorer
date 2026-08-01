/**
 * Unified search fan-out. Queues all enabled adapters through the shared
 * catalog scheduler and streams partial results as each source resolves.
 */

import { getState } from './state.js';
import { loadAdapter } from './sources.js';
import { filterContentItems } from './content-rating.js';

function policyOptions(opts = {}) {
  return {
    ...opts,
    // Provider data and caller-supplied options cannot reveal content. The
    // persisted preference is the sole authority for every app search path.
    showExplicitContent: getState().settings.showExplicitContent === true,
  };
}

function allowed(items) {
  return filterContentItems(items, getState().settings);
}

export async function searchOne(adapterId, query, opts = {}) {
  try {
    const mod = await loadAdapter(adapterId);
    const items = allowed(await mod.search(query, policyOptions(opts)) || []);
    if (opts.onPartial) opts.onPartial(adapterId, items);
    return items;
  } catch (err) {
    console.warn(`[${adapterId}] search failed:`, err);
    if (opts.onError) opts.onError(adapterId, err);
    if (opts.throwOnError) throw err;
    return [];
  }
}

/** Browse only currently live items. Hybrid snapshot adapters use their
 * refresh contract; finite/live-mixed adapters use ordinary browse. */
export async function browseLiveOne(adapterId, opts = {}) {
  const mod = await loadAdapter(adapterId);
  const next = policyOptions(opts);
  let items;
  if (typeof mod.refreshSnapshot === 'function') {
    const snapshot = await mod.refreshSnapshot(next);
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw new TypeError(`[${adapterId}] refreshSnapshot returned an invalid snapshot`);
    }
    items = snapshot.items;
  } else {
    items = (await mod.browse?.(next)) || (await mod.search?.('', next)) || [];
  }
  const country = String(next.country || '').trim().toUpperCase();
  const tag = String(next.tag || '').trim().toLowerCase();
  return allowed(items).filter((item) => {
    if (item?.delivery !== 'live' || (next.type && item.type !== next.type)) return false;
    if (country && String(item.country || '').toUpperCase() !== country) return false;
    if (tag && !(item.tags || []).some((value) => String(value).toLowerCase().includes(tag))) {
      return false;
    }
    return true;
  });
}

/**
 * Fetch one cursor-based browse page. Unlike the old array-only contract,
 * transport failures throw and only an explicit `exhausted: true` means that
 * the source has reached its real end.
 *
 * @returns {Promise<{items: Array, cursor: any, exhausted: boolean}>}
 */
export async function browsePageOne(adapterId, opts = {}) {
  const mod = await loadAdapter(adapterId);
  try {
    if (typeof mod.browsePage === 'function') {
      const page = await mod.browsePage(policyOptions(opts));
      if (!page || !Array.isArray(page.items)) {
        throw new TypeError(`[${adapterId}] browsePage returned an invalid page`);
      }
      return {
        items: allowed(page.items),
        cursor: page.cursor ?? null,
        exhausted: page.exhausted === true,
      };
    }

    // A short array is not authoritative exhaustion. Requiring an explicit
    // page contract keeps partial provider responses retryable.
    throw new TypeError(`[${adapterId}] catalog adapter requires browsePage()`);
  } catch (err) {
    console.warn(`[${adapterId}] browse page failed:`, err);
    if (opts.onError) opts.onError(adapterId, err);
    throw err;
  }
}

export async function randomOne(adapterId, opts = {}) {
  try {
    const mod = await loadAdapter(adapterId);
    return allowed((await mod.random?.(policyOptions(opts))) || []);
  } catch (err) {
    if (err?.name !== 'AbortError') console.warn(`[${adapterId}] random failed:`, err);
    if (opts.throwOnError) throw err;
    return [];
  }
}

/** Debounce helper for the search bar. */
export function debounce(fn, ms = 300) {
  let t = null;
  function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn.apply(this, args);
    }, ms);
  }
  debounced.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return debounced;
}
