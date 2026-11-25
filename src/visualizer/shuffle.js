/**
 * Scene shuffle: which scene (and look) comes next, and when.
 *
 * Psychedelia's own shuffle changes post effects and overlays, never the main
 * effect, cuts on a bar count that is not aligned to anything, has no seed and
 * no memory, so looks repeat (see the shuffle audit). This one picks the main
 * scene, from a seedable random source so tests (and a look) can be repeated,
 * with these rules, in this order:
 *
 *   Pool        every scene, or the favourites only; then only scenes no
 *               heavier than the cost filter (light; light and medium; all)
 *               and the step-down's cap (shuffleCostCap).
 *   Never       the scene showing now (unless it is the only one).
 *   Bag         every scene in the pool is shown once before any is shown
 *               again; an empty bag is filled again with the whole pool.
 *   Recent      none of the last `recentCount(pool)` scenes (about half the
 *               pool, at most 12), which matters where one bag ends and the
 *               next begins.
 *   Category    not the same category three times running.
 *   Weights     the music's mood: calm prefers scenes tagged calm, energetic
 *               prefers lively ones (x3); a scene of the same colour family
 *               as the one before counts half; and a scene counts as many
 *               times as its category has scenes left in the bag, so big
 *               categories are spread out and a bag rarely ends on scenes of
 *               one category only (the one case where the category rule has
 *               to give: about 1 pick in 100,000). With the tone
 *               (tone.js, while MOOD_TONE_RELEASED), toneWeight leans
 *               gently: dark and bass-heavy sound toward calm, cool scenes,
 *               bright sound toward lively, warm or rainbow ones (at most
 *               x(1 + TONE_WEIGHT) either way; never a filter).
 * When the rules leave nothing, they are let go one at a time from the
 * bottom: category, then recent, then the bag - never "not the one showing".
 *
 * Looks follow the same idea per scene: not the look it had last time, and
 * in favourites mode one of the looks starred for it.
 *
 * Timing (createShuffleTimer): every N bars (8, 16 or 32) of the reactor's
 * beat clock while it is sure of the tempo, on a bar line; else after the
 * time N bars take at 120 BPM. Never sooner than SHUFFLE_MIN_DWELL_S, never
 * later than SHUFFLE_MAX_DWELL_S. The timer only counts while it is stepped,
 * which is only while sound plays: with nothing playing the shuffle rests and
 * schedules nothing.
 */

import { COST_CLASSES } from './scenes.js';

export const SHUFFLE_MIN_DWELL_S = 20;
export const SHUFFLE_MAX_DWELL_S = 120;
/** Tempo confidence from which bars are counted on the beat clock. */
export const SHUFFLE_TEMPO_CONFIDENCE = 0.5;
/** The pace bars are counted at without a sure tempo (BPM). */
export const SHUFFLE_FALLBACK_BPM = 120;
export const MOOD_WEIGHT = 3;
export const SAME_HUE_WEIGHT = 0.5;
/** The most the tone moves a scene's weight, either way (PROPOSED). */
export const TONE_WEIGHT = 0.6;

/**
 * How the tone ({ brightness, weight, swell }, 0..1; tone.js) weighs scene
 * `scene` (its mood and hue tags): a factor from 1 / (1 + TONE_WEIGHT) to
 * 1 + TONE_WEIGHT, 1 without a tone. The sound leans from dark (low
 * brightness, heavy bass) to bright (a swelling sound a little toward
 * lively); a scene leans from calm and cool to lively and warm or rainbow.
 * The tags stand in for how dark and how fast a scene looks.
 */
export function toneWeight(scene, tone) {
  if (!tone || !tone.ready || !scene) return 1;
  const dark = toneDarkness(tone);
  let lean = 1 - 2 * dark + (tone.swell - 0.5) * 0.3;
  lean = Math.max(-1, Math.min(1, lean));
  const sceneLean = (scene.mood === 'lively' ? 0.5 : -0.5) + (scene.hue === 'cool' ? -0.5 : 0.5);
  const factor = 1 + TONE_WEIGHT * lean * sceneLean;
  return Math.max(1 / (1 + TONE_WEIGHT), Math.min(1 + TONE_WEIGHT, factor));
}

/** How dark the sound is (0..1): low brightness and heavy bass. */
export function toneDarkness(tone) {
  return Math.max(0, Math.min(1, (1 - tone.brightness) * 0.7 + Math.max(0, tone.weight - 0.5) * 0.6));
}

/** How much the tone leans a look's choice (as TONE_WEIGHT for scenes). */
export const LOOK_TONE_WEIGHT = 0.6;

/**
 * How the tone weighs a look of `darkness` (0 bright to 1 dark;
 * look-darkness.js): x(1 + LOOK_TONE_WEIGHT) for a look as dark as the
 * sound, down to / (1 + LOOK_TONE_WEIGHT) for the opposite; 1 without a tone
 * or a darkness. A weighting, never a filter.
 */
export function lookToneWeight(darkness, tone) {
  if (!tone || !tone.ready || !Number.isFinite(darkness)) return 1;
  const lean = 1 - 2 * Math.abs(darkness - toneDarkness(tone));
  const factor = 1 + LOOK_TONE_WEIGHT * lean;
  return Math.max(1 / (1 + LOOK_TONE_WEIGHT), Math.min(1 + LOOK_TONE_WEIGHT, factor));
}

/** A small, fast seeded random source (mulberry32): () => [0, 1). */
export function seededRandom(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many of the last scenes are kept out: about half the pool, 1 to 12. */
export function recentCount(poolSize) {
  if (poolSize < 3) return poolSize > 1 ? 1 : 0;
  return Math.min(12, Math.floor(poolSize / 2));
}

const costRank = (cost) => {
  const at = COST_CLASSES.indexOf(cost);
  return at < 0 ? COST_CLASSES.length : at;
};

/** The heaviest cost class a filter setting ('light', 'medium', 'all') lets in. */
export function costFilterMax(filter) {
  if (filter === 'light') return 'light';
  if (filter === 'medium') return 'medium';
  return 'heavy';
}

/** The lighter of two cost classes. */
export function lighterCost(a, b) {
  return costRank(a) <= costRank(b) ? a : b;
}

/** The cost cap after the step-down lowered the picture while a scene of
 *  cost `cost` was drawn: one class lighter (light stays light). */
export function shuffleCostCap(cost) {
  const at = costRank(cost);
  return COST_CLASSES[Math.max(0, Math.min(COST_CLASSES.length - 1, at - 1))];
}

/**
 * @param {object} options
 * @param {Array} options.scenes  scenes.js entries (id, category, cost, mood, hue)
 * @param {() => number} [options.random]  seeded source (seededRandom)
 */
export function createShuffle({ scenes, random = seededRandom(Date.now()) } = {}) {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  let bag = new Set();
  let bagKey = '';
  const history = []; // ids picked or shown, oldest first (bounded)
  const lastLook = new Map(); // id -> look index it had last
  const stats = { picks: 0, relaxed: { category: 0, recent: 0, bag: 0 }, refills: 0 };

  /** The ids a pick may come from now. */
  function poolOf({ pool = 'all', favourites = [], costMax = 'heavy' } = {}) {
    const max = costRank(costMax);
    const wanted = pool === 'favourites' ? new Set(favourites.map((f) => f.scene)) : null;
    return scenes.filter((scene) => (!wanted || wanted.has(scene.id)) && costRank(scene.cost) <= max).map((scene) => scene.id);
  }

  function weightOf(id, mood, previous, left, tone) {
    const scene = byId.get(id);
    // Categories with more scenes left in the bag go sooner, so the bag does
    // not end on a run of one category.
    let weight = left?.get(scene.category) || 1;
    if (mood === 'calm' && scene.mood === 'calm') weight *= MOOD_WEIGHT;
    if (mood === 'energetic' && scene.mood === 'lively') weight *= MOOD_WEIGHT;
    if (previous && scene.hue === previous.hue) weight *= SAME_HUE_WEIGHT;
    if (tone) weight *= toneWeight(scene, tone);
    return weight;
  }

  function weighted(ids, mood, previous, left, tone) {
    let total = 0;
    const weights = ids.map((id) => { const w = weightOf(id, mood, previous, left, tone); total += w; return w; });
    let r = random() * total;
    for (let i = 0; i < ids.length; i += 1) {
      r -= weights[i];
      if (r < 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  /** Note that `id` is now shown (picked here or chosen by hand): out of the
   *  bag, into the last scenes. The tab calls it when a scene is installed. */
  function shown(id) {
    if (!byId.has(id)) return;
    if (history[history.length - 1] !== id) history.push(id);
    if (history.length > 64) history.splice(0, history.length - 64);
    bag.delete(id);
  }

  /**
   * The next scene id, or null when the pool is empty.
   * @param {object} context
   *   current    id showing now
   *   pool       'all' | 'favourites'; favourites: [{ scene, look }]
   *   costMax    heaviest cost class allowed
   *   mood       'calm' | 'steady' | 'energetic'
   *   tone       (optional) tone.js { brightness, weight, swell, ready }
   */
  function next(context = {}) {
    const ids = poolOf(context);
    if (!ids.length) return null;
    const key = ids.join(',');
    if (key !== bagKey) {
      // Another pool (filter, favourites): a fresh bag of it, less what was
      // shown lately.
      bagKey = key;
      bag = new Set(ids);
    }
    const current = context.current || history[history.length - 1] || null;
    const notCurrent = ids.filter((id) => id !== current || ids.length === 1);
    let inBag = notCurrent.filter((id) => bag.has(id));
    if (!inBag.length) {
      bag = new Set(ids);
      stats.refills += 1;
      inBag = notCurrent.filter((id) => bag.has(id));
    }
    const recent = new Set(history.slice(-recentCount(ids.length)));
    const lastTwo = history.slice(-2).map((id) => byId.get(id)?.category);
    const blockedCategory = lastTwo.length === 2 && lastTwo[0] === lastTwo[1] ? lastTwo[0] : null;
    const tiers = [
      inBag.filter((id) => !recent.has(id) && byId.get(id).category !== blockedCategory),
      inBag.filter((id) => !recent.has(id)),
      inBag,
      notCurrent,
    ];
    let level = tiers.findIndex((tier) => tier.length > 0);
    if (level < 0) level = tiers.length - 1;
    if (level >= 1) stats.relaxed.category += 1;
    if (level >= 2) stats.relaxed.recent += 1;
    if (level >= 3) stats.relaxed.bag += 1;
    const left = new Map();
    for (const bagId of bag) {
      const category = byId.get(bagId)?.category;
      if (ids.includes(bagId)) left.set(category, (left.get(category) || 0) + 1);
    }
    const id = weighted(tiers[level], context.mood, byId.get(current), left, context.tone || null);
    stats.picks += 1;
    // Nothing is remembered yet: the bag, the last scenes and categories
    // change only when it is shown (shown()), so a pick dropped before then
    // (prepared ahead, then not wanted) is still in the bag.
    return id;
  }

  /**
   * A look for scene `id`: not the one it had last time (when it has more
   * than one). `offered`: the look numbers it offers (looks.js: a left-out
   * look has none), or a count for the numbers 0 to count - 1. `allowed`:
   * the look numbers to choose from (favourites), or null for any.
   * `weightOf` (number -> weight; the tone, lookToneWeight): how likely each
   * is, or null for all alike. Returns a look number, or null (no looks).
   */
  function look(id, offered, allowed = null, weightOf = null) {
    const numbers = Array.isArray(offered) ? offered : Array.from({ length: Math.max(0, offered || 0) }, (_, n) => n);
    let options = Array.isArray(allowed) && allowed.length
      ? allowed.filter((n) => Number.isInteger(n) && numbers.includes(n))
      : numbers.slice();
    if (!options.length) return null;
    const before = lastLook.get(id);
    if (options.length > 1 && before !== undefined) options = options.filter((n) => n !== before);
    let pick;
    if (typeof weightOf === 'function' && options.length > 1) {
      const weights = options.map((n) => { const w = Number(weightOf(n)); return w > 0 ? w : 0; });
      const total = weights.reduce((sum, w) => sum + w, 0);
      let at = random() * total;
      pick = options[options.length - 1];
      if (total > 0) {
        for (let index = 0; index < options.length; index += 1) {
          at -= weights[index];
          if (at < 0) { pick = options[index]; break; }
        }
      } else pick = options[0];
    } else pick = options[Math.floor(random() * options.length) % options.length];
    lastLook.set(id, pick);
    return pick;
  }

  return {
    next,
    look,
    shown,
    poolOf,
    get history() { return history.slice(); },
    get bag() { return [...bag]; },
    stats,
  };
}

/**
 * When the next change is due.
 * @param {object} options
 *   bars        8 | 16 | 32
 *   minDwell, maxDwell  seconds
 */
export function createShuffleTimer({
  bars = 16, minDwell = SHUFFLE_MIN_DWELL_S, maxDwell = SHUFFLE_MAX_DWELL_S,
} = {}) {
  let barsWanted = bars;
  let dwell = 0; // seconds of sound since the last change
  let startBeats = Number.NaN;
  let lastBar = 0;
  let lastNow = Number.NaN;
  let byClock = false;
  let due = false;
  let holdForInterval = false;

  function fallbackSeconds() {
    return Math.min(maxDwell, Math.max(minDwell, (barsWanted * 4 * 60) / SHUFFLE_FALLBACK_BPM));
  }

  // Keep the manual hold when the scene installs and restarts the clock.
  function restart({ hold = holdForInterval } = {}) {
    holdForInterval = hold;
    due = false;
    dwell = 0;
    startBeats = Number.NaN;
    lastBar = 0;
    lastNow = Number.NaN;
  }

  return {
    restart,
    setBars(next) { barsWanted = next; },
    get bars() { return barsWanted; },
    get dwell() { return dwell; },
    /** Bars were counted on the beat clock at the last step. */
    get byClock() { return byClock; },
    /** Seconds the fallback waits for `bars` (N bars at 120 BPM). */
    fallbackSeconds,
    /**
     * One step while sound plays: `now` (s), the reactor's beat clock
     * (`beats`, counting up) and tempo `confidence` (0..1). Returns true when
     * the change is due (it stays due until restart()).
     */
    step(now, beats, confidence) {
      due = due || check(now, beats, confidence);
      return due;
    },
    /** A drop (structure.js): the change is due now, when the scene has
     *  shown for minDwell. Manual picks wait for the full timer interval.
     *  Returns true when the drop replaced the scheduled change. */
    bringForward() {
      if (holdForInterval || due || dwell < minDwell) return false;
      due = true;
      return true;
    },
    get due() { return due; },
  };

  function check(now, beats, confidence) {
    const dt = Number.isFinite(lastNow) && now > lastNow ? Math.min(0.5, now - lastNow) : 0;
    lastNow = now;
    dwell += dt;
    if (dwell >= maxDwell) return true;
    const sure = confidence >= SHUFFLE_TEMPO_CONFIDENCE && Number.isFinite(beats);
    byClock = sure;
    if (sure) {
      if (!Number.isFinite(startBeats) || beats < startBeats) {
        // First beat, or the clock started again (another track).
        startBeats = beats;
        lastBar = 0;
      }
      const bar = Math.floor((beats - startBeats) / 4);
      const crossed = bar > lastBar;
      lastBar = bar;
      if (dwell < minDwell) return false;
      return bar >= barsWanted && crossed;
    }
    return dwell >= fallbackSeconds();
  }
}
