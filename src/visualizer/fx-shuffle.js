/**
 * FX shuffle: which post effects (fx-catalog.js) are on, with which values,
 * and which of their parameters move with the music. Seedable, like the
 * scene shuffle (shuffle.js), and rebuilt from the shuffle audit's findings
 * on Psychedelia's look shuffle:
 *
 *   Stuck values   Psychedelia jittered each value around its default and
 *                  clamped, so many sat on one value (mix 0.8, opacity 0.65,
 *                  god rays threshold 0.5). Here every value is drawn
 *                  uniformly from a curated range (fx-catalog.js), integers
 *                  and choices uniformly from theirs; no range includes a
 *                  value that does nothing (pixelate 1, wave 0, grain 0).
 *   Repeats        58% of Psychedelia's "Preserve" shuffles kept the same FX.
 *                  Here no FX of the combination showing comes back in the
 *                  next one, no combination comes back within the last
 *                  FX_RECENT_COMBOS, and FX used in the last few
 *                  combinations count less.
 *   Mush           a combination's weights (how much each FX changes the
 *                  picture) add up to no more than the intensity's budget,
 *                  at most one FX per group (geometry, image-replacing,
 *                  feedback, glow, retro) and never a clashing pair; its
 *                  cost classes stay under the cost budget the quality allows.
 *   Links          Psychedelia linked cameras and formulas (32%), duplicated
 *                  links (7.2%) and forced its global reactions on. Here the
 *                  links are generated afresh per combination: at most one
 *                  per FX and the intensity's count in all, no duplicates,
 *                  only on the params fx-catalog.js marks, with the source
 *                  matched to the param (punch: kick or snare; size: bass or
 *                  loudness; detail: hats or treble), and every one has to
 *                  pass reactor.js linkRuleViolation (no light, rates, jumps
 *                  or clock-scaled params). Global reactions are a setting
 *                  of their own (fx-reactions.js), never switched on by this.
 *   Mood           FX tagged with the music's mood count FX_MOOD_WEIGHT
 *                  times (calm -> calm, energetic -> lively).
 *
 * The combination comes out in the chain's order (the library's), so the
 * same set always looks the same and has one key ("a+b+c").
 */

import { FX_COSTS, FX_COST_UNITS, fxClash } from './fx-catalog.js';
import { linkRuleViolation } from './reactor.js';
import { seededRandom } from './shuffle.js';

export const FX_INTENSITIES = Object.freeze(['subtle', 'normal', 'strong']);
export const DEFAULT_FX_INTENSITY = 'normal';

/** Per intensity: most FX, weight budget, most links, how far into a
 *  strength range values go, link amount scale, chance of a plain picture. */
export const FX_BUDGETS = Object.freeze({
  subtle: Object.freeze({
    count: 1, weight: 0.8, links: 1, strength: 0.55, amount: 0.7, none: 0.15,
  }),
  normal: Object.freeze({
    count: 2, weight: 1.4, links: 2, strength: 0.8, amount: 1, none: 0.08,
  }),
  strong: Object.freeze({
    count: 3, weight: 2.1, links: 3, strength: 1, amount: 1.25, none: 0.04,
  }),
});

/** Most FX at once on any computer, and per quality. */
export const FX_MAX_ACTIVE = 3;
export const FX_MAX_BY_QUALITY = Object.freeze({ high: 3, medium: 3, low: 2 });
/** Cost units (fx-catalog.js FX_COST_UNITS) a combination may use, per quality. */
export const FX_COST_BUDGET = Object.freeze({ high: 6, medium: 5, low: 3 });

export const FX_RECENT_COMBOS = 8;
/** FX used in the last FX_RECENT_FX combinations count this much. */
export const FX_RECENT_FX = 3;
export const FX_RECENT_FACTOR = 0.3;
export const FX_MOOD_WEIGHT = 2.5;

/** Link sources per kind of param, with their odds. */
export const FX_LINK_SOURCES = Object.freeze({
  punch: Object.freeze([['kick', 0.7], ['snare', 0.3]]),
  size: Object.freeze([['bass', 0.75], ['level', 0.25]]),
  detail: Object.freeze([['hat', 0.6], ['high', 0.4]]),
});
/** A link's amount (a share of its param's range per unit of source), before
 *  the intensity's scale. */
export const FX_LINK_AMOUNT = Object.freeze([0.08, 0.18]);

const MOOD_TAG = Object.freeze({ calm: 'calm', energetic: 'lively' });

export function normalizeFxIntensity(value) {
  return FX_INTENSITIES.includes(value) ? value : DEFAULT_FX_INTENSITY;
}

/** The key of a set of FX ids (in chain order): "a+b+c", '' for none. */
export function fxKey(ids) { return (ids || []).join('+'); }

/** A param definition shaped for linkRuleViolation (from the library's
 *  params map: name -> { min, max, default, type }). */
function paramRow(fx, name) {
  const p = fx.def.params[name];
  return p ? {
    name, min: p.min, max: p.max, type: p.type || 'float',
  } : null;
}

/** linkRuleViolation's view of an FX: its params and shader. */
export function fxRuleDef(fx) {
  return {
    name: fx.id,
    params: Object.keys(fx.def.params).map((name) => paramRow(fx, name)),
    shader: fx.def.src,
    specialize: [],
  };
}

/** Why `param` of `fx` may not move with the music (null: it may). */
export function fxLinkViolation(fx, param) {
  if (!fx?.links?.[param]) return 'not marked linkable';
  return linkRuleViolation(fxRuleDef(fx), paramRow(fx, param));
}

const pickWeighted = (pairs, random) => {
  let total = 0;
  for (const [, weight] of pairs) total += weight;
  let roll = random() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return pairs[pairs.length - 1][0];
};

/** The [lo, hi] a link on `name` may push within (its curated range). */
function rangeBounds(fx, name) {
  const spec = fx.ranges[name];
  const p = fx.def.params[name];
  if (Array.isArray(spec)) return [spec[0], spec[1]];
  if (spec && Array.isArray(spec.strength)) return [spec.strength[0], spec.strength[1]];
  return [p.min, p.max];
}

/** Values for `fx`: every param drawn from its curated range (strength
 *  ranges only as far as `strength` of the way), the rest its default. */
export function fxValues(fx, random, strength = 1) {
  const values = {};
  for (const [name, p] of Object.entries(fx.def.params)) {
    const spec = fx.ranges[name];
    let value = p.default;
    if (typeof spec === 'number') value = spec;
    else if (Array.isArray(spec)) {
      const [lo, hi, kind] = spec;
      value = kind === 'int' ? lo + Math.floor(random() * (hi - lo + 1)) : lo + random() * (hi - lo);
    } else if (spec && Array.isArray(spec.pick)) {
      value = spec.pick[Math.floor(random() * spec.pick.length)];
    } else if (spec && Array.isArray(spec.strength)) {
      const [lo, hi] = spec.strength;
      value = lo + random() * (hi - lo) * strength;
    }
    values[name] = value;
  }
  return values;
}

/** Links for a combination: `fxList` [{ fx, values }], at most `max`, one
 *  per FX, sources by kind; every one passes the link rule. Returns
 *  [{ fx: id, param, source, amount, min, max, span }]. */
export function fxLinks(fxList, random, { max = 2, amountScale = 1 } = {}) {
  const candidates = [];
  for (const { fx } of fxList) {
    const params = Object.keys(fx.links).filter((param) => !fxLinkViolation(fx, param));
    if (params.length) candidates.push({ fx, params });
  }
  // Shuffled (Fisher-Yates), then one each from the front.
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  const links = [];
  const sourcesUsed = new Set();
  for (const { fx, params } of candidates) {
    if (links.length >= max) break;
    const param = params[Math.floor(random() * params.length)];
    const kind = fx.links[param];
    // A different source from the links before where the kind has one.
    const choices = FX_LINK_SOURCES[kind].filter(([source]) => !sourcesUsed.has(source));
    const source = pickWeighted(choices.length ? choices : FX_LINK_SOURCES[kind], random);
    sourcesUsed.add(source);
    const [lo, hi] = rangeBounds(fx, param);
    const [aLo, aHi] = FX_LINK_AMOUNT;
    links.push({
      fx: fx.id, param, source, amount: (aLo + random() * (aHi - aLo)) * amountScale, min: lo, max: hi, span: hi - lo,
    });
  }
  return links;
}

/**
 * @param {object} options
 * @param {Array} options.catalog  fx-catalog.js fxCatalog()
 * @param {() => number} [options.random]
 */
export function createFxShuffle({ catalog, random = seededRandom(Date.now()) } = {}) {
  const byId = new Map(catalog.map((fx) => [fx.id, fx]));
  const recentCombos = []; // keys, newest last
  const recentFx = []; // sets of ids, newest last
  let last = null; // the combination showing now (ids)
  const stats = { rolls: 0, retries: 0, empty: 0 };

  function inRecentFx(id) {
    for (const set of recentFx) if (set.includes(id)) return true;
    return false;
  }

  /** One attempt at a set of ids. */
  function pickIds(context) {
    const budget = FX_BUDGETS[normalizeFxIntensity(context.intensity)];
    const most = Math.max(0, Math.min(budget.count, context.maxCount ?? FX_MAX_ACTIVE));
    if (!most) return [];
    // A plain picture now and then, never twice running.
    if (last?.length && random() < budget.none) return [];
    const count = 1 + Math.floor(random() * most);
    const chosen = [];
    let weight = 0;
    let cost = 0;
    const groups = new Set();
    const costMax = context.costBudget ?? Infinity;
    // The cost filter the scene shuffle uses (its 'light' or 'medium'): no
    // effect of a heavier class, whatever the budget left.
    const costMaxRank = FX_COSTS.includes(context.costMax) ? FX_COSTS.indexOf(context.costMax) : FX_COSTS.length - 1;
    const moodTag = MOOD_TAG[context.mood] || null;
    for (let slot = 0; slot < count; slot += 1) {
      const pool = [];
      for (const fx of catalog) {
        if (context.allowed && !context.allowed.has(fx.id)) continue;
        if (costMaxRank < FX_COSTS.length - 1 && FX_COSTS.indexOf(fx.cost) > costMaxRank) continue;
        if (last && last.includes(fx.id)) continue; // no FX twice running
        if (chosen.some((other) => fxClash(other.id, fx.id))) continue;
        if (fx.groups.some((group) => groups.has(group))) continue;
        if (weight + fx.weight > budget.weight + 1e-9) continue;
        if (cost + FX_COST_UNITS[fx.cost] > costMax) continue;
        let odds = 1;
        if (moodTag && fx.tags.includes(moodTag)) odds *= FX_MOOD_WEIGHT;
        if (inRecentFx(fx.id)) odds *= FX_RECENT_FACTOR;
        pool.push([fx, odds]);
      }
      if (!pool.length) break;
      const fx = pickWeighted(pool, random);
      chosen.push(fx);
      weight += fx.weight;
      cost += FX_COST_UNITS[fx.cost];
      for (const group of fx.groups) groups.add(group);
    }
    return catalog.filter((fx) => chosen.includes(fx)).map((fx) => fx.id);
  }

  /** Values and links for `ids` (in chain order). */
  function build(ids, intensity = DEFAULT_FX_INTENSITY, rnd = random) {
    const budget = FX_BUDGETS[normalizeFxIntensity(intensity)];
    const list = catalog.filter((fx) => ids.includes(fx.id)).map((fx) => ({ fx, values: fxValues(fx, rnd, budget.strength) }));
    const links = fxLinks(list, rnd, { max: budget.links, amountScale: budget.amount });
    const weight = list.reduce((sum, item) => sum + item.fx.weight, 0);
    const cost = list.reduce((sum, item) => sum + FX_COST_UNITS[item.fx.cost], 0);
    return {
      key: fxKey(list.map((item) => item.fx.id)),
      ids: list.map((item) => item.fx.id),
      fx: list.map((item) => ({ id: item.fx.id, values: item.values, links: links.filter((link) => link.fx === item.fx.id) })),
      links,
      weight,
      cost,
      intensity: normalizeFxIntensity(intensity),
    };
  }

  /**
   * The next combination (not yet counted as shown: shown() does that).
   * @param {object} context
   *   intensity  'subtle' | 'normal' | 'strong'
   *   mood       'calm' | 'steady' | 'energetic'
   *   maxCount   most FX now (quality, step-down)
   *   costBudget cost units allowed now
   *   costMax    heaviest cost class allowed ('light' | 'medium' | 'heavy';
   *              the scene shuffle's cost filter)
   *   allowed    Set of ids, or null for all
   */
  function next(context = {}) {
    stats.rolls += 1;
    let ids = pickIds(context);
    for (let tries = 0; tries < 12; tries += 1) {
      const key = fxKey(ids);
      const repeat = ids.length ? recentCombos.includes(key) : !last?.length;
      if (!repeat) break;
      stats.retries += 1;
      ids = pickIds(context);
    }
    if (!ids.length) stats.empty += 1;
    return build(ids, context.intensity);
  }

  /** `combo` is now showing: remembered against repeats. */
  function shown(combo) {
    const ids = combo?.ids || [];
    last = ids.slice();
    if (ids.length) {
      recentCombos.push(fxKey(ids));
      if (recentCombos.length > FX_RECENT_COMBOS) recentCombos.shift();
    }
    recentFx.push(ids.slice());
    if (recentFx.length > FX_RECENT_FX) recentFx.shift();
  }

  return {
    next,
    build,
    shown,
    byId,
    get last() { return last ? last.slice() : null; },
    get recent() { return recentCombos.slice(); },
    stats,
  };
}
