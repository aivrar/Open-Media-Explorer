/**
 * Overlay shuffle: which overlays are on (overlay-catalog.js), with which
 * settings, and how one of them is blended in. Seedable, like the scene and
 * FX shuffles (shuffle.js, fx-shuffle.js), and with their rules:
 *
 *   Values      every setting the table names is drawn uniformly from its
 *               range (or one of its picks); the rest keep their default.
 *   Repeats     no overlay of the set showing comes back in the next one; no
 *               set comes back within the last OVERLAY_RECENT_SETS; overlays
 *               used in the last few sets count less.
 *   Cost        the set's cost units (plus OVERLAY_BLEND_COST for a blend-in)
 *               stay under the quality's budget, and no overlay heavier than
 *               the scene shuffle's cost filter is picked.
 *   Blend-ins   now and then (OVERLAY_BLEND_CHANCE) one overlay of the set is
 *               blended in: a mode it allows, perhaps under the effects,
 *               perhaps masked by the scene or tinted from it, perhaps
 *               bending it (only when `bend` is allowed). On a calm scene
 *               (scenes.js fxCalm) no lively blend, mask or bending; on one
 *               marked fxNone none at all (overlaysDrawnFor applies the same).
 *   By hand     Lightning is never picked (overlay-catalog.js shuffle: false).
 */

import {
  OVERLAY_BLEND_COST, OVERLAY_COSTS, OVERLAY_COST_UNITS, OVERLAY_IDS, OVERLAY_LIVELY_BLENDS, OVERLAY_MAX,
  PLAIN_BLEND, isBlendIn, overlayOrder, overlayRow, overlaysKey,
} from './overlay-catalog.js';
import { seededRandom } from './shuffle.js';

export const OVERLAY_RECENT_SETS = 6;
export const OVERLAY_RECENT_FACTOR = 0.3;
/** Chance of a set with nothing in it (never twice running). */
export const OVERLAY_NONE_CHANCE = 0.1;
/** Chance that one overlay of a set is blended in, and of each part of it. */
export const OVERLAY_BLEND_CHANCE = 0.5;
export const OVERLAY_UNDER_CHANCE = 0.4;
export const OVERLAY_MASK_CHANCE = 0.3;
export const OVERLAY_TINT_CHANCE = 0.25;
export const OVERLAY_BEND_CHANCE = 0.2;

/** Settings drawn for overlay `id` from its ranges. */
export function overlayValues(id, random) {
  const row = overlayRow(id);
  const values = {};
  if (!row) return values;
  for (const [name, spec] of Object.entries(row.ranges || {})) {
    if (typeof spec === 'number') values[name] = spec;
    else if (Array.isArray(spec)) {
      const [lo, hi, kind] = spec;
      values[name] = kind === 'int' ? lo + Math.floor(random() * (hi - lo + 1)) : lo + random() * (hi - lo);
    } else if (spec && Array.isArray(spec.pick)) {
      values[name] = spec.pick[Math.floor(random() * spec.pick.length)];
    }
  }
  return values;
}

/** The blend modes overlay `id` may take on scene `entry`. */
export function overlayModesFor(id, entry) {
  const row = overlayRow(id);
  if (!row || entry?.fxNone) return ['add'];
  return row.blends.filter((mode) => !(entry?.fxCalm && OVERLAY_LIVELY_BLENDS.has(mode)));
}

/**
 * @param {object} options
 * @param {() => number} [options.random]
 */
export function createOverlayShuffle({ random = seededRandom(Date.now()) } = {}) {
  const recentSets = [];
  const recentIds = [];
  let last = null;
  const stats = { rolls: 0, retries: 0, empty: 0, blended: 0 };

  function pickWeighted(pool) {
    let total = 0;
    for (const [, weight] of pool) total += weight;
    let roll = random() * total;
    for (const [value, weight] of pool) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return pool[pool.length - 1][0];
  }

  /** A blend-in for one of `ids`, or none. */
  function pickBlend(ids, context) {
    const entry = context.entry || null;
    if (!context.blendIns || entry?.fxNone || random() >= OVERLAY_BLEND_CHANCE) return null;
    const able = ids.filter((id) => overlayModesFor(id, entry).length > 1 || overlayRow(id).under);
    if (!able.length) return null;
    const id = able[Math.floor(random() * able.length)];
    const row = overlayRow(id);
    const modes = overlayModesFor(id, entry);
    const blend = {
      ...PLAIN_BLEND,
      mode: modes[Math.floor(random() * modes.length)],
      under: row.under && random() < OVERLAY_UNDER_CHANCE,
    };
    if (!entry?.fxCalm) {
      if (random() < OVERLAY_MASK_CHANCE) blend.mask = random() < 0.5 ? 'bright' : 'dark';
      if (context.bend && random() < OVERLAY_BEND_CHANCE) blend.bend = true;
    }
    if (random() < OVERLAY_TINT_CHANCE) blend.tint = true;
    return isBlendIn(blend) ? { id, blend } : null;
  }

  function pickSet(context) {
    const most = Math.max(0, Math.min(OVERLAY_MAX, context.maxCount ?? OVERLAY_MAX));
    if (!most) return [];
    if (last?.length && random() < OVERLAY_NONE_CHANCE) return [];
    // One or two mostly; three now and then.
    const count = Math.min(most, random() < 0.5 ? 1 : (random() < 0.75 ? 2 : 3));
    const budget = context.costBudget ?? Infinity;
    const maxRank = OVERLAY_COSTS.includes(context.costMax) ? OVERLAY_COSTS.indexOf(context.costMax) : OVERLAY_COSTS.length - 1;
    const chosen = [];
    let cost = 0;
    for (let slot = 0; slot < count; slot += 1) {
      const pool = [];
      for (const id of OVERLAY_IDS) {
        const row = overlayRow(id);
        if (!row.shuffle || chosen.includes(id)) continue;
        if (context.allowed && !context.allowed.has(id)) continue;
        if (OVERLAY_COSTS.indexOf(row.cost) > maxRank) continue;
        if (last && last.includes(id)) continue;
        if (cost + OVERLAY_COST_UNITS[row.cost] > budget) continue;
        pool.push([id, recentIds.some((set) => set.includes(id)) ? OVERLAY_RECENT_FACTOR : 1]);
      }
      if (!pool.length) break;
      const id = pickWeighted(pool);
      chosen.push(id);
      cost += OVERLAY_COST_UNITS[overlayRow(id).cost];
    }
    const blendRoom = cost + OVERLAY_BLEND_COST <= budget;
    const blended = blendRoom ? pickBlend(chosen, context) : null;
    if (blended) stats.blended += 1;
    return overlayOrder(chosen.map((id) => ({ id, blend: blended?.id === id ? blended.blend : { ...PLAIN_BLEND } })));
  }

  /** Settings for each of `list` ([{ id, blend }]), freshly drawn. */
  function build(list, rnd = random) {
    const items = overlayOrder(list).map((item) => ({
      id: item.id, blend: { ...PLAIN_BLEND, ...(item.blend || {}) }, values: overlayValues(item.id, rnd),
    }));
    return { key: overlaysKey(items), ids: items.map((item) => item.id), items };
  }

  /**
   * The next set (not counted as shown: shown() does that).
   * @param {object} context
   *   maxCount    most overlays now (quality, step-down)
   *   costBudget  cost units allowed now
   *   costMax     the heaviest cost class ('light' | 'medium' | 'heavy')
   *   entry       the scene's scenes.js row (calm rule)
   *   blendIns    a blend-in may be picked
   *   bend        bending may be picked
   *   allowed     Set of ids, or null
   */
  function next(context = {}) {
    stats.rolls += 1;
    let list = pickSet(context);
    for (let tries = 0; tries < 12; tries += 1) {
      const key = overlaysKey(list);
      const repeat = list.length ? recentSets.includes(key) : !last?.length;
      if (!repeat) break;
      stats.retries += 1;
      list = pickSet(context);
    }
    if (!list.length) stats.empty += 1;
    return build(list);
  }

  function shown(combo) {
    const ids = combo?.items ? combo.items.map((item) => item.id) : [];
    last = ids.slice();
    if (ids.length) {
      recentSets.push(overlaysKey(combo.items));
      if (recentSets.length > OVERLAY_RECENT_SETS) recentSets.shift();
    }
    recentIds.push(ids);
    if (recentIds.length > 3) recentIds.shift();
  }

  return {
    next,
    build,
    shown,
    get last() { return last ? last.slice() : null; },
    stats,
  };
}
