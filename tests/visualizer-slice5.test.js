import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  normalizeVisualizerExtras, normalizeVisualizerFavourites, parseVisualizerFavourite,
} from '../src/lib/visualizer-settings.js';
import loadPostFx from '../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import loadPalettes from '../src/visualizer/vendor/psychedelia/engine/palettes.js';
import {
  FX_CALM_MAX, FX_COST_UNITS, FX_EXCLUDED, FX_LIVELY, FX_SYNC, FX_TABLE, fxCalmIds, fxCatalog, fxClash, fxDrawnFor, fxOrder, fxShuffleAllowed,
} from '../src/visualizer/fx-catalog.js';
import {
  FX_BUDGETS, FX_COST_BUDGET, FX_LINK_SOURCES, FX_RECENT_COMBOS, createFxShuffle, fxLinkViolation, fxValues,
} from '../src/visualizer/fx-shuffle.js';
import {
  FX_PROGRAM_CACHE, FX_TRIGGER_GAP_S, TRIGGER_IDLE_AGE, createFxChain, fxFrameStep, reactionsIdle,
} from '../src/visualizer/fx-chain.js';
import { GLOBAL_FLASH_MAX, GLOBAL_PUMP_MAX, REACTION_STYLES, createGlobalReactions } from '../src/visualizer/fx-reactions.js';
import { LIGHT_PARAM } from '../src/visualizer/reactor.js';
import { FLASH_KINDS, FLASH_LIMITS, createFlashLimiter } from '../src/visualizer/flash-limiter.js';
import { createReactorBridge } from '../src/visualizer/reactor.js';
import { createStepDown, STEP_DOWN_WINDOW_MS, STEP_DOWN_SETTLE_MS } from '../src/visualizer/step-down.js';
import {
  favouriteEntries, favouriteFx, favouriteKey, favouritesAsDrawn, isFavourite, withFavourite,
} from '../src/visualizer/favourites.js';
import {
  ACCUMULATING_RELEASED_IDS, FX_CALM_SCENES, FX_LEFT_OUT, FX_NONE_SCENES, SCENES, sceneById,
} from '../src/visualizer/scenes.js';
import { sceneLooks } from '../src/visualizer/looks.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { COMPILE_POLL_MS, sceneDefaults } from '../src/visualizer/scene-renderer.js';
import { CROSSFADE_SLOW_MS, NOTES, mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, StrictGL, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 5 of the visualizer: Psychedelia's post effects (the FX chain, its
   bypass and resources), the global reactions through the flash limiter, the
   FX shuffle (seeded, curated ranges, budgets, no repeats, rebuilt links),
   their controls, favourites with effects, and the step-down taking effects
   off before quality. No GPU; fake clocks. */

// The library as the tab loads it: with the palettes (its Palette Map pass).
const { PsyPalettes } = loadPalettes({});
const { PostFxLibrary } = loadPostFx({ PsyPalettes });
const CATALOG = fxCatalog(PostFxLibrary, PsyPalettes);
const byId = new Map(CATALOG.map((fx) => [fx.id, fx]));

/* ---------------- The catalog ---------------- */

test('the catalog: every library pass, each with a cost class, ranges inside its params', () => {
  const names = PostFxLibrary.list().map((def) => def.name);
  // Since slice 12 none is left out: Palette Map gets the palettes.
  assert.ok(names.includes('palette_map'));
  assert.deepEqual(Object.keys(FX_EXCLUDED), []);
  assert.equal(CATALOG.length, names.length);
  for (const name of names) assert.ok(FX_TABLE[name], `${name} has a row`);
  for (const id of Object.keys(FX_TABLE)) assert.ok(names.includes(id), `${id} is in the library`);
  for (const fx of CATALOG) {
    assert.ok(FX_COST_UNITS[fx.cost], `${fx.id} cost class`);
    assert.ok(fx.weight > 0 && fx.weight <= 1);
    assert.ok(fx.tags.length);
    for (const [name, spec] of Object.entries(fx.ranges)) {
      const p = fx.def.params[name];
      assert.ok(p, `${fx.id}.${name} is a param`);
      const values = typeof spec === 'number' ? [spec]
        : (Array.isArray(spec) ? spec.slice(0, 2) : (spec.pick || spec.strength));
      for (const value of values) assert.ok(value >= p.min && value <= p.max, `${fx.id}.${name} ${value} in ${p.min}..${p.max}`);
      if (Array.isArray(spec)) assert.ok(spec[1] > spec[0], `${fx.id}.${name} a real range`);
    }
  }
  // The heavy ones (many texture reads per pixel).
  assert.deepEqual(CATALOG.filter((fx) => fx.cost === 'heavy').map((fx) => fx.id).sort(), ['anamorphic', 'god_rays', 'oil_paint', 'pixel_sort']);
});

test('light rules: nothing inverts or strobes the picture, brightness-like params are pinned near neutral and never linked', () => {
  const range = (id, name) => FX_TABLE[id].ranges[name];
  assert.equal(range('color_grade', 'invert'), 0, 'no invert');
  assert.equal(range('crt', 'flicker'), 0, 'no 30 Hz flicker');
  assert.equal(range('glitch', 'color_swap'), 0);
  assert.ok(range('glitch', 'static')[1] <= 0.15);
  assert.ok(!range('vision', 'mode').pick.includes(2), 'no X-Ray (inverted)');
  assert.ok(!range('dither', 'mode').pick.includes(0), 'no 1-bit');
  assert.equal(range('dither', 'brightness'), 0);
  assert.ok(Math.abs(range('color_grade', 'brightness')[0]) <= 0.05 && range('color_grade', 'brightness')[1] <= 0.05);
  assert.ok(range('led_wall', 'brightness')[1] <= 1.2 && range('crt', 'brightness')[1] <= 1.15);
  assert.ok(range('vision', 'gain')[1] <= 1.25);
  assert.ok(range('shockwave', 'glow')[1] <= 0.2);
  assert.ok(!range('shockwave', 'sync').pick.includes(1), 'not on every kick');
  // No value that does nothing.
  assert.ok(range('pixelate', 'size')[0] >= 2);
  assert.ok(range('wave', 'amplitude').strength[0] > 0);
  assert.ok(range('chromatic', 'amount').strength[0] > 0);
  assert.ok(range('grain', 'intensity').strength[0] > 0);
  assert.ok(range('zoom_blur', 'strength').strength[0] > 0);
  assert.ok(range('glitch', 'intensity').strength[0] > 0);
  const lightLike = /(bright|exposure|invert|strobe|flash|flicker|white|bloom|gain|glow|intensity|mix|opacity|ink)/;
  for (const fx of CATALOG) {
    for (const param of Object.keys(fx.links)) {
      assert.equal(fxLinkViolation(fx, param), null, `${fx.id}.${param} passes the link rule`);
      assert.ok(!LIGHT_PARAM.test(param) && !lightLike.test(param), `${fx.id}.${param} is not light`);
    }
  }
  // The rule itself still says no to a light or rate param of an FX.
  const bloom = byId.get('bloom');
  assert.equal(fxLinkViolation({ ...bloom, links: { intensity: 'punch' } }, 'intensity'), 'changes light');
  const trails = byId.get('trails');
  assert.equal(fxLinkViolation({ ...trails, links: { drift_x: 'size' } }, 'drift_x'), 'a rate');
});

test('values are drawn across their curated ranges, not stuck on one (the audit: mix 0.8, opacity 0.65)', () => {
  const random = seededRandom(7);
  for (const fx of CATALOG) {
    const seen = new Map();
    for (let roll = 0; roll < 400; roll += 1) {
      const values = fxValues(fx, random, 1);
      for (const [name, value] of Object.entries(values)) {
        if (!seen.has(name)) seen.set(name, new Set());
        seen.get(name).add(value);
      }
    }
    for (const [name, spec] of Object.entries(fx.ranges)) {
      const distinct = seen.get(name).size;
      if (typeof spec === 'number') assert.equal(distinct, 1);
      else if (spec.pick) assert.equal(distinct, spec.pick.length, `${fx.id}.${name} every choice`);
      else if (Array.isArray(spec) && spec[2] === 'int') {
        const span = spec[1] - spec[0] + 1;
        if (span <= 40) assert.equal(distinct, span, `${fx.id}.${name} every integer`);
        // (Palette Map's 71 palettes: nearly all of them.)
        else assert.ok(distinct > Math.min(100, span * 0.9), `${fx.id}.${name} spread (${distinct} of ${span})`);
      }
      else assert.ok(distinct > 300, `${fx.id}.${name} spread (${distinct})`);
    }
  }
  // Strength ranges go only part of the way at lower intensities.
  const bloom = byId.get('bloom');
  const [lo, hi] = bloom.ranges.intensity.strength;
  const subtle = Array.from({ length: 200 }, () => fxValues(bloom, random, FX_BUDGETS.subtle.strength).intensity);
  assert.ok(Math.max(...subtle) <= lo + (hi - lo) * FX_BUDGETS.subtle.strength + 1e-9);
});

/* ---------------- The FX shuffle ---------------- */

function rolls(intensity, count, { seed = 2026, maxCount = 3, costBudget = 6, mood = null } = {}) {
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(seed) });
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const combo = shuffle.next({
      intensity, mood: mood || ['calm', 'steady', 'energetic'][index % 3], maxCount, costBudget,
    });
    shuffle.shown(combo);
    out.push(combo);
  }
  return { shuffle, out };
}

test('the FX shuffle over 5,000 rolls per intensity: spread, no repeats, budgets kept, no forbidden or duplicate links', () => {
  const report = {};
  for (const intensity of ['subtle', 'normal', 'strong']) {
    const budget = FX_BUDGETS[intensity];
    const { out } = rolls(intensity, 5000);
    const keys = new Set();
    const used = new Map();
    let repeats = 0;
    for (let index = 0; index < out.length; index += 1) {
      const combo = out[index];
      keys.add(combo.key);
      const before = out[index - 1];
      if (before && combo.ids.some((id) => before.ids.includes(id))) repeats += 1;
      if (combo.ids.length && out.slice(Math.max(0, index - FX_RECENT_COMBOS), index).some((other) => other.key === combo.key)) repeats += 1;
      if (before && !before.ids.length && !combo.ids.length) repeats += 1;
      assert.ok(combo.ids.length <= budget.count);
      assert.ok(combo.weight <= budget.weight + 1e-9, `${intensity} weight ${combo.weight}`);
      assert.ok(combo.cost <= 6);
      assert.deepEqual(combo.ids, fxOrder(CATALOG, combo.ids), 'chain order');
      const groups = combo.ids.flatMap((id) => byId.get(id).groups);
      assert.equal(new Set(groups).size, groups.length, 'one per group');
      for (const a of combo.ids) for (const b of combo.ids) if (a !== b) assert.ok(!fxClash(a, b), `${a} with ${b}`);
      assert.ok(combo.links.length <= budget.links);
      const linked = combo.links.map((link) => `${link.fx}.${link.param}`);
      assert.equal(new Set(linked).size, linked.length, 'no duplicate links');
      assert.equal(new Set(combo.links.map((link) => link.fx)).size, combo.links.length, 'one per FX');
      for (const link of combo.links) {
        const fx = byId.get(link.fx);
        assert.equal(fxLinkViolation(fx, link.param), null);
        assert.ok(FX_LINK_SOURCES[fx.links[link.param]].some(([source]) => source === link.source), 'source matches the kind');
        assert.ok(link.amount > 0 && link.amount <= 0.18 * budget.amount + 1e-9);
      }
      for (const id of combo.ids) used.set(id, (used.get(id) || 0) + 1);
    }
    assert.equal(repeats, 0, `${intensity}: no repeats`);
    report[intensity] = {
      distinct: keys.size, fx: used.size, min: Math.min(...used.values()), max: Math.max(...used.values()), empty: out.filter((c) => !c.ids.length).length,
    };
  }
  assert.ok(report.subtle.distinct >= 25 && report.normal.distinct >= 300 && report.strong.distinct >= 1000, JSON.stringify(report));
  assert.equal(report.strong.fx, CATALOG.length, 'every FX comes up');
  for (const row of Object.values(report)) assert.ok(row.max / row.min < 4, `no FX hogs the shuffle ${JSON.stringify(row)}`);
});

test('the FX shuffle: seeded, cost budget and caps followed, mood biases the tags', () => {
  const a = rolls('normal', 50, { seed: 9 }).out.map((c) => c.key);
  const b = rolls('normal', 50, { seed: 9 }).out.map((c) => c.key);
  assert.deepEqual(a, b, 'the same seed, the same effects');
  const low = rolls('strong', 2000, { maxCount: 2, costBudget: FX_COST_BUDGET.low }).out;
  for (const combo of low) {
    assert.ok(combo.ids.length <= 2);
    assert.ok(combo.cost <= FX_COST_BUDGET.low);
    assert.ok(!combo.ids.some((id) => byId.get(id).cost === 'heavy'), 'no heavy FX on Low');
  }
  assert.ok(rolls('strong', 200, { maxCount: 0 }).out.every((c) => !c.ids.length), 'none allowed: none');
  const share = (mood) => {
    let calm = 0;
    let all = 0;
    for (const combo of rolls('normal', 3000, { mood }).out) {
      for (const id of combo.ids) { all += 1; if (byId.get(id).tags.includes('calm') && !byId.get(id).tags.includes('lively')) calm += 1; }
    }
    return calm / all;
  };
  assert.ok(share('calm') > share('energetic') + 0.15, 'calm music, calm effects');
});

/* ---------------- The chain ---------------- */

function passesFor(ids, seed = 1) {
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(seed) });
  return shuffle.build(ids, 'normal').fx.map((item) => ({ ...item, fx: byId.get(item.id) }));
}
const STATE = {
  time: 1, beat: { clock: 0 }, sources: null,
};
/** STATE at the next frame's time (a draw at the time of the last one is a
 *  redraw: fx-chain.js moves no feedback history for it). */
let frameTime = 1;
const nextFrame = () => ({ ...STATE, time: (frameTime += 1 / 30), dt: 1 / 30 });

test('the chain is bypassed with no FX: no framebuffer, no texture, no draw of its own', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  for (let frame = 0; frame < 10; frame += 1) {
    assert.equal(chain.begin(640, 360), null);
    assert.equal(chain.finish(STATE), false);
  }
  chain.setPasses([]);
  assert.equal(chain.begin(640, 360), null);
  assert.equal(gl.framebuffersMade, 0);
  assert.equal(gl.textures.size, 0);
  assert.equal(gl.draws, 0);
  assert.equal(gl.programs.size, 0);
  assert.equal(chain.stats.compiles, 0);
});

test('the chain makes only the framebuffers it needs, the last pass draws to the screen, and all are freed when FX go off', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  chain.setPasses(passesFor(['bloom']));
  assert.equal(gl.framebuffersMade, 0, 'lazily: nothing until a frame');
  const fb = chain.begin(640, 360);
  assert.ok(fb);
  assert.equal(gl.framebuffers.size, 1, 'one FX: only the scene\'s framebuffer');
  gl.draws = 0;
  gl.screenDraws = 0;
  chain.finish(nextFrame());
  assert.equal(gl.draws, 1);
  assert.equal(gl.screenDraws, 1, 'straight to the screen');
  // Three, none with history: scene + ping + pong.
  chain.setPasses(passesFor(['chromatic', 'bloom', 'grain']));
  chain.begin(640, 360);
  gl.draws = 0;
  gl.screenDraws = 0;
  chain.finish(nextFrame());
  assert.equal(gl.draws, 3);
  assert.equal(gl.screenDraws, 1);
  assert.equal(gl.framebuffers.size, 3);
  assert.equal(chain.targets, 3);
  // A feedback pass last: its two frames, then a copy to the screen.
  chain.setPasses(passesFor(['trails']));
  chain.begin(640, 360);
  gl.draws = 0;
  gl.screenDraws = 0;
  chain.finish(nextFrame());
  assert.equal(gl.draws, 2, 'trails, copy');
  assert.equal(gl.screenDraws, 1);
  assert.equal(chain.passes.find((pass) => pass.id === 'trails').hist.targets.length, 2);
  // Off: everything freed at once.
  chain.setPasses([]);
  assert.equal(gl.framebuffers.size, 0);
  assert.equal(gl.textures.size, 0);
  assert.equal(chain.targets, 0);
  assert.equal(chain.stats.targetsMade, chain.stats.targetsFreed);
  // A new size: made again at it.
  chain.setPasses(passesFor(['bloom']));
  chain.begin(640, 360);
  chain.begin(320, 180);
  assert.deepEqual(chain.size, { width: 320, height: 180 });
  assert.equal(gl.framebuffers.size, 1);
  chain.destroy();
  assert.equal(gl.framebuffers.size, 0);
  assert.equal(gl.programs.size, 0, 'compiled passes deleted with the tab');
});

test('feedback starts from the picture coming in, never black: on a new scene, a new size and after a lost context; kept across a change of other FX', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  chain.setPasses(passesFor(['trails']));
  const prevUnit = () => gl.boundTextures.get(gl.TEXTURE1);
  // A draw records u_prev's texture: watch what is bound on unit 1 at the draw.
  const seenPrev = [];
  const draw = gl.drawArrays.bind(gl);
  gl.drawArrays = (...args) => { seenPrev.push(prevUnit()); draw(...args); };
  const frame = () => { chain.begin(640, 360); chain.finish(nextFrame()); };
  frame();
  const trails = () => chain.passes.find((pass) => pass.id === 'trails');
  // Frame 1: fresh, so u_prev is the scene's own picture (the capture texture).
  const captureTex = seenPrev[0];
  assert.ok(captureTex && !trails().hist.targets.some((target) => target.tex === captureTex));
  frame();
  assert.ok(trails().hist.targets.some((target) => target.tex === seenPrev.at(-2)), 'then its own last frame');
  chain.resetHistory();
  seenPrev.length = 0;
  frame();
  assert.ok(!trails().hist.targets.some((target) => target.tex === seenPrev[0]), 'a new scene: from the picture again');
  // Another FX added: trails keeps its frames.
  const before = trails().hist;
  chain.setPasses(passesFor(['chromatic', 'trails']));
  assert.equal(trails().hist, before);
  assert.equal(chain.stats.historyKept, 1);
  // A new size: new frames, fresh.
  chain.begin(320, 180);
  assert.equal(trails().hist, null);
  chain.finish(nextFrame());
  assert.equal(trails().hist.fresh, false);
  // Lost context: nothing deleted (it went with the context), made again after.
  const made = gl.framebuffersMade;
  gl.lost = true;
  chain.contextLost();
  assert.equal(trails().hist, null);
  gl.lost = false;
  chain.restore();
  frame();
  assert.ok(gl.framebuffersMade > made);
  assert.equal(chain.stats.failed, 0);
});

test('trigger passes fire on the limited beat clock\'s beat or bar, not on raw kicks', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  const [pass] = passesFor(['shockwave']);
  pass.values.sync = 3; // beat
  chain.setPasses([pass]);
  const ages = [];
  for (let frame = 0; frame < 90; frame += 1) {
    const t = frame / 30;
    chain.begin(64, 36);
    chain.finish({ time: t, dt: 1 / 30, beat: { clock: t * 2 }, sources: null }); // 2 beats a second
    ages.push(gl.uniforms.get('u_age')[0]);
  }
  const fired = ages.filter((age, index) => index > 0 && age < ages[index - 1]).length;
  // A clock this fast is what the limiter never gives while a trigger pass
  // is on (its reserve slows it to one cycle a second); the chain's own gate
  // holds it to one firing a second anyway.
  assert.ok(fired >= 2 && fired <= 3, `at most one a second over 3 s: ${fired}`);
  assert.ok(chain.stats.triggersHeld >= 2, 'the beats in between were held');
  assert.ok(ages[0] >= 29, 'nothing fired before the first beat');
});

/* ---------------- Global reactions ---------------- */

test('global reactions: flash off by default, at most GLOBAL_FLASH_MAX when on and only from let-through hits; Wild is not offered', () => {
  assert.deepEqual(Object.keys(REACTION_STYLES), ['subtle', 'normal', 'strong']);
  for (const style of Object.values(REACTION_STYLES)) assert.equal('flash' in style || 'shake' in style, false);
  const reactions = createGlobalReactions();
  const loud = {
    kick: 0.6, snare: 0.6, hat: 0.6, bass: 1,
  };
  assert.equal(reactions.step(loud, 'strong', false).flash, 0, 'flash off');
  assert.ok(reactions.step(loud, 'strong', true).flash <= GLOBAL_FLASH_MAX + 1e-9);
  assert.ok(reactions.values.pump <= GLOBAL_PUMP_MAX);
  // The pass: 1 + flash x 0.9 brighter at most (+ flash x 0.05).
  assert.ok((1 + GLOBAL_FLASH_MAX * 0.9) * (1 + GLOBAL_PUMP_MAX * 0.15) < 1.17, 'well below Psychedelia Wild\'s 45%');
  // Through the limiter: a burst of 10 hits a second gives at most 3 full flashes.
  const limiter = createFlashLimiter();
  let flashes = 0;
  let high = false;
  for (let frame = 0; frame < 60; frame += 1) {
    const now = frame / 60;
    const hit = frame % 6 === 0 ? 1 : 0;
    const out = limiter.step(now, { kick: hit, snare: 0, level: 0.5 });
    const { flash } = reactions.step(out, 'normal', true);
    const isHigh = flash > GLOBAL_FLASH_MAX * 0.5;
    if (isHigh && !high) flashes += 1;
    high = isHigh;
  }
  assert.ok(flashes <= FLASH_LIMITS.maxPulsesPerSecond, `${flashes} flashes in a second`);
  assert.ok(reactionsIdle(createGlobalReactions().step({}, 'normal', false)), 'silence: no reaction pass');
});

test('the reaction pass is drawn only when it has something to do', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  chain.setPasses(passesFor(['bloom']));
  const reactions = createGlobalReactions();
  chain.setReactions(reactions.step(null, 'normal', false));
  chain.begin(64, 36);
  gl.draws = 0;
  chain.finish(STATE);
  assert.equal(gl.draws, 1, 'silent: only the FX');
  chain.setReactions(reactions.step({ kick: 0.6, bass: 0.8, snare: 0.3 }, 'normal', false));
  chain.begin(64, 36);
  gl.draws = 0;
  gl.screenDraws = 0;
  chain.finish(STATE);
  assert.equal(gl.draws, 2, 'FX, then the reaction pass');
  assert.equal(gl.screenDraws, 1);
  assert.equal(gl.uniforms.get('u_flash')[0], 0);
  assert.equal(gl.uniforms.get('u_zoom')[0], 1, 'zoom stays the scene\'s own');
});

/* ---------------- Step-down ---------------- */

test('the step-down takes effects off before it lowers quality', () => {
  let inUse = 3;
  const steps = [];
  const stepDown = createStepDown({
    quality: 'high', fps: 60, fxInUse: () => inUse, onStep: (to) => { steps.push(to); inUse = Math.min(inUse, to.fx); },
  });
  let now = 0;
  for (; now < 4 * (STEP_DOWN_WINDOW_MS + STEP_DOWN_SETTLE_MS) * 3; now += 25) stepDown.frame(now); // 40 a second
  assert.deepEqual(steps.slice(0, 3).map((to) => `${to.quality}/${to.fx}`), ['high/1', 'high/0', 'medium/0']);
  assert.equal(stepDown.lowered, true);
  stepDown.choose('high', 60);
  assert.equal(stepDown.fx, Infinity, 'a choice by hand clears it');
  // No effects on: straight to quality.
  inUse = 0;
  const plain = [];
  const other = createStepDown({ quality: 'high', fps: 60, fxInUse: () => 0, onStep: (to) => plain.push(to) });
  for (now = 0; now < 2 * STEP_DOWN_WINDOW_MS + 2 * STEP_DOWN_SETTLE_MS; now += 25) other.frame(now);
  assert.equal(plain[0].quality, 'medium');
});

/* ---------------- Favourites ---------------- */

test('favourites keep scene + look + effects; slice 4 strings still read and match with no effects', () => {
  assert.equal(favouriteKey('plasma', 2, ['bloom', 'grain']), 'plasma:2|bloom+grain');
  assert.equal(favouriteKey('moire', null, ['trails']), 'moire|trails');
  assert.equal(favouriteKey('moire', null, []), 'moire', 'no effects: the old form');
  assert.deepEqual(parseVisualizerFavourite('plasma:2|bloom+grain'), {
    scene: 'plasma', look: 2, fx: ['bloom', 'grain'], overlays: [],
  });
  assert.deepEqual(parseVisualizerFavourite('tunnel'), {
    scene: 'tunnel', look: null, fx: [], overlays: [],
  });
  assert.equal(parseVisualizerFavourite('plasma|a+b+c+d'), null, 'at most three');
  assert.equal(parseVisualizerFavourite('plasma|bloom+bloom'), null);
  assert.equal(parseVisualizerFavourite('plasma|'), null);
  const old = ['plasma:1', 'moire'];
  assert.deepEqual(normalizeVisualizerFavourites(old), old, 'slice 4 strings kept as they are');
  assert.ok(isFavourite(old, 'plasma', 1, []));
  assert.ok(isFavourite(old, 'moire', null));
  let list = withFavourite(old, 'plasma', 1, true, null, ['bloom']);
  assert.deepEqual(list, ['plasma:1', 'moire', 'plasma:1|bloom']);
  assert.ok(isFavourite(list, 'plasma', 1, ['bloom']));
  assert.deepEqual(favouriteFx(list, 'plasma', 1), [[], ['bloom']]);
  assert.deepEqual(favouriteEntries(list).map((entry) => entry.scene), ['plasma', 'moire', 'plasma']);
  list = withFavourite(list, 'plasma', 1, false, null, []);
  assert.deepEqual(list, ['moire', 'plasma:1|bloom']);
});

/* ---------------- In the tab ---------------- */

const LAYOUT = { width: 1280, height: 720 };

async function mount({ settings = {}, seed = 3, gl: givenGl = null } = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = givenGl || new FakeGL();
  const saved = [];
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const root = new FakeNodeEl('div');
  let libraryLoads = 0;
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
    random: seededRandom(seed),
    loadFxLibrary: async () => { libraryLoads += 1; return import('../src/visualizer/vendor/psychedelia/engine/post-fx-library.js'); },
  });
  const m = {
    h, gl, saved, session, source, signal, controls: session.controls,
    get libraryLoads() { return libraryLoads; },
    get settings() { return current; },
    async until(done, label = 'condition') {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        h.run(COMPILE_POLL_MS);
      }
      assert.fail(`never reached: ${label}`);
    },
    async play(ms, frameMs = 1000 / 30) {
      for (let left = ms; left > 0; left -= 500) {
        h.run(Math.min(500, left), frameMs);
        await settle(() => false, 3);
      }
    },
    start() { source.playing = true; signal.refresh(); },
    /** Settings changed elsewhere (another window). */
    apply(partial) { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
  };
  await m.until(() => Boolean(session.switcher.current), 'first scene');
  return m;
}
const click = (node) => node.dispatchEvent(new Event('click'));
const change = (node, value) => {
  if (typeof value === 'boolean') node.checked = value;
  else if (value !== undefined) node.value = value;
  node.dispatchEvent(new Event('change'));
};

test('in the tab, effects off (the default): the library is never loaded and frames go straight to the screen', async () => {
  const m = await mount();
  m.start();
  await m.play(2000);
  assert.equal(m.session.fx.on, false);
  assert.equal(m.libraryLoads, 0, 'no FX chunk fetched');
  assert.equal(m.gl.framebuffersMade, 0);
  assert.equal(m.gl.textures.size, 0);
  assert.equal(m.gl.draws, m.gl.screenDraws, 'every draw is the scene\'s, to the screen');
  assert.equal(m.controls.fxShuffle.disabled, true);
  assert.equal(m.controls.fxLine.hidden, true);
  m.session.destroy();
});

test('in the tab: effects on load once, change under a transition, follow the bar timer only while sound plays, and are freed when switched off and on leaving', async () => {
  const m = await mount({ settings: { visualizerFxTiming: 4 } });
  const { session, controls, gl } = m;
  m.start();
  await m.play(500);
  change(controls.fxToggle, true);
  assert.deepEqual(m.saved.at(-1), { visualizerFx: true });
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(m.libraryLoads, 1);
  assert.ok(session.fx.combo || session.fx.chain.count === 0);
  // Keep rolling until some are on (the shuffle may give a plain picture).
  for (let tries = 0; tries < 6 && !session.fx.chain.count; tries += 1) {
    click(controls.fxNow);
    await m.play(CROSSFADE_SLOW_MS + 200);
  }
  assert.ok(session.fx.chain.count > 0);
  assert.ok(gl.framebuffers.size >= 1);
  assert.ok(session.transition.stats.fades + session.transition.stats.dips + session.transition.stats.cuts >= 1);
  assert.match(controls.fxLine.textContent, /^Effects: /);
  const shownBoxes = [...session.fx.boxes.values()].filter((box) => box.checked).length;
  assert.equal(shownBoxes, session.fx.chain.count, 'the list shows what is on');
  // The bar timer (4 bars at 120 BPM: 8 s) changes them while sound plays.
  const changes = session.fx.stats.changes;
  await m.play(20000);
  assert.ok(session.fx.stats.changes > changes, 'changed on the bar timer');
  // No sound: it rests.
  m.source.playing = false;
  m.signal.refresh();
  await m.play(2000);
  const resting = session.fx.stats.changes;
  await m.play(30000, 200);
  assert.equal(session.fx.stats.changes, resting, 'no changes without sound');
  // Switched off: the chain is bypassed and everything is freed.
  m.start();
  change(controls.fxToggle, false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.fx.chain.count, 0);
  assert.equal(gl.framebuffers.size, 0);
  assert.equal(gl.textures.size, 0);
  // On again, then leave the tab: freed.
  change(controls.fxToggle, true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  session.destroy();
  assert.equal(gl.framebuffers.size, 0);
  assert.equal(gl.textures.size, 0);
  assert.equal(m.libraryLoads, 1, 'loaded once per visit');
});

test('in the tab: effects by hand up to the cap, intensity, flash off by default, and favourites with effects', async () => {
  // Tunnel: not a calm scene (those draw fewer; see the calm-scene tests).
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom'] } });
  const { session, controls } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(session.fx.chain.ids, ['bloom'], 'the hand set');
  assert.equal(controls.fxFlash.checked, false);
  const boxes = session.fx.boxes;
  change(boxes.get('grain'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  change(boxes.get('chromatic'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(session.fx.chain.ids, ['bloom', 'chromatic', 'grain']);
  assert.deepEqual(m.settings.visualizerFxSet, ['bloom', 'chromatic', 'grain']);
  assert.equal(boxes.get('trails').disabled, true, `at most ${session.fx.maxNow}`);
  change(boxes.get('trails'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.fx.chain.count, 3);
  // Low quality allows two: the heaviest goes.
  change(controls.qualitySelect, 'low');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.fx.chain.count, 2);
  assert.ok(!session.fx.chain.ids.includes('bloom'), 'bloom (medium) went first');
  // The star saves scene + look + effects.
  click(controls.star);
  const fav = m.settings.visualizerFavourites.at(-1);
  assert.match(fav, /\|chromatic\+grain$/);
  assert.equal(controls.star.getAttribute('aria-pressed'), 'true');
  // Other effects: not the favourite.
  change(boxes.get('grain'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(controls.star.getAttribute('aria-pressed'), 'false');
  // Intensity is saved.
  change(controls.fxIntensity, 'subtle');
  assert.equal(m.settings.visualizerFxIntensity, 'subtle');
  session.destroy();
});

test('the settings for effects: defaults, checked values, kept by normalizeSettings', () => {
  const odd = normalizeVisualizerExtras({
    visualizerFx: 'yes', visualizerFxShuffle: 0, visualizerFxIntensity: 'wild', visualizerFxTiming: 5, visualizerFxFlash: 1, visualizerFxSet: ['bloom', 'bloom', 'Bad', 'a', 'b', 'c'],
  });
  assert.deepEqual([odd.visualizerFx, odd.visualizerFxShuffle, odd.visualizerFxIntensity, odd.visualizerFxTiming, odd.visualizerFxFlash, odd.visualizerFxSet],
    [false, true, 'normal', 'scene', false, ['bloom', 'a', 'b']]);
  const kept = normalizeSettings({
    visualizerFx: true, visualizerFxShuffle: false, visualizerFxIntensity: 'strong', visualizerFxTiming: '16', visualizerFxFlash: true, visualizerFxSet: ['trails'],
  });
  assert.deepEqual([kept.visualizerFx, kept.visualizerFxShuffle, kept.visualizerFxIntensity, kept.visualizerFxTiming, kept.visualizerFxFlash, kept.visualizerFxSet],
    [true, false, 'strong', 16, true, ['trails']]);
  assert.ok(NOTES.fewerFx);
  assert.ok(SCENES.length > 0);
});

/* ---------------- Calm scenes (the FX flash check) ---------------- */

test('a calm scene gets no lively effect from the shuffle and at most two; a lively set on is replaced when one comes in; other scenes get the full range', async () => {
  for (const id of FX_LIVELY) assert.ok(byId.has(id), `${id} is an effect`);
  const calmIds = fxCalmIds(CATALOG);
  assert.equal(calmIds.size, CATALOG.length - FX_LIVELY.size);
  // (The accumulating labs are calm by their own entries: accumulating-scenes.js.)
  assert.deepEqual(SCENES.filter((scene) => scene.fxCalm).map((scene) => scene.id).sort(), [...FX_CALM_SCENES, ...ACCUMULATING_RELEASED_IDS].sort());
  // The shuffle with a calm scene's context.
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(5) });
  for (let roll = 0; roll < 2000; roll += 1) {
    const combo = shuffle.next({ intensity: 'strong', maxCount: FX_CALM_MAX, costBudget: 6, allowed: calmIds });
    shuffle.shown(combo || { ids: [] });
    assert.ok(combo.ids.length <= FX_CALM_MAX);
    assert.ok(!combo.ids.some((fx) => FX_LIVELY.has(fx)), combo.key);
  }
  // In the tab: Plasma (calm) with effects shuffled with the scene.
  const m = await mount({ settings: { visualizerFx: true, visualizerFxIntensity: 'strong', visualizerFxTiming: 4 } });
  const { session, controls } = m;
  assert.equal(session.switcher.current, 'plasma');
  m.start();
  await m.play(500);
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  for (let roll = 0; roll < 12; roll += 1) {
    click(controls.fxNow);
    await m.play(CROSSFADE_SLOW_MS + 200);
    const ids = session.fx.chain.ids;
    assert.ok(ids.length <= FX_CALM_MAX && !ids.some((fx) => FX_LIVELY.has(fx)), ids.join('+'));
  }
  // A lively set on a non-calm scene...
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  let lively = false;
  for (let roll = 0; roll < 40 && !lively; roll += 1) {
    click(controls.fxNow);
    await m.play(CROSSFADE_SLOW_MS + 200);
    lively = session.fx.chain.ids.some((fx) => FX_LIVELY.has(fx)) || session.fx.chain.count > FX_CALM_MAX;
  }
  assert.ok(lively, 'non-calm scenes get the lively ones too');
  // ...is replaced when a calm scene comes in, though the timing is bars.
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  await m.play(CROSSFADE_SLOW_MS + 200);
  const ids = session.fx.chain.ids;
  assert.ok(ids.length <= FX_CALM_MAX && !ids.some((fx) => FX_LIVELY.has(fx)), `on aurora: ${ids.join('+')}`);
  // Mandelbrot, calm since Psychedelia b4739fa (it had none before): the calm ones.
  const mandelbrot = SCENES.find((scene) => scene.id === 'mandelbrot');
  assert.equal(mandelbrot.fxNone, false);
  assert.equal(mandelbrot.fxCalm, true);
  session.sceneList.pick('mandelbrot');
  await m.until(() => session.switcher.current === 'mandelbrot', 'mandelbrot');
  await m.play(CROSSFADE_SLOW_MS + 200);
  let drawnAny = 0;
  for (let roll = 0; roll < 4; roll += 1) {
    click(controls.fxNow);
    await m.play(CROSSFADE_SLOW_MS + 200);
    const onIt = session.fx.chain.ids;
    assert.ok(onIt.length <= FX_CALM_MAX && !onIt.some((fx) => FX_LIVELY.has(fx)), `on mandelbrot: ${onIt.join('+')}`);
    drawnAny += onIt.length;
  }
  assert.ok(drawnAny > 0, 'it gets effects now');
  session.destroy();
});

test('scenes with no room left get no effects at all: the ones whose own steps reach 0.085 are fxNone (and calm); nothing is drawn on them, the panel says so', async () => {
  const NONE = ['fractal_flame_volume_flight', 'glow_lab', 'multibrot', 'polyfold_flight', 'sierpinski'];
  assert.deepEqual([...FX_NONE_SCENES].sort(), NONE);
  // (The accumulating labs take no effects by their own entries.)
  assert.deepEqual(SCENES.filter((scene) => scene.fxNone).map((scene) => scene.id).sort(), [...NONE, ...ACCUMULATING_RELEASED_IDS].sort());
  for (const id of NONE) {
    const entry = SCENES.find((scene) => scene.id === id);
    assert.equal(entry.fxCalm, true, `${id} is calm too`);
    assert.deepEqual(fxDrawnFor(entry, ['bloom', 'chromatic']), [], `${id}: none drawn`);
  }
  // In the tab: a set chosen by hand on Sierpinski is kept, none of it drawn.
  const set = fxOrder(CATALOG, ['bloom', 'chromatic']);
  const m = await mount({ settings: { visualizerScene: 'sierpinski', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: set } });
  const { session } = m;
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  assert.equal(session.switcher.current, 'sierpinski');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(sorted(session.fx.combo.ids), sorted(set), 'the chosen set is kept');
  assert.deepEqual(session.fx.chain.ids, [], 'nothing drawn');
  assert.equal(session.fx.note.hidden, false);
  assert.equal(session.fx.note.textContent, 'No effects are shown with this scene: it would flicker.');
  for (const id of ['bloom', 'chromatic', 'trails']) assert.equal(session.fx.boxes.get(id).getAttribute('aria-disabled'), 'true', id);
  session.destroy();
});

test('a calm scene may leave out single effects (FX_LEFT_OUT): Plasma never gets Bloom or Watercolour, Nebula never Bloom, from the shuffle, by hand or in the tab', async () => {
  assert.deepEqual(FX_LEFT_OUT, {
    plasma: ['bloom', 'watercolour'], nebula: ['bloom'], aurora: ['palette_map'], sierpinski: ['palette_map'], voronoi: ['mirror'],
  });
  const nebula = SCENES.find((scene) => scene.id === 'nebula');
  assert.deepEqual(nebula.fxLeftOut, ['bloom']);
  assert.deepEqual(fxDrawnFor(nebula, ['color_grade', 'bloom']), ['color_grade']);
  assert.ok(!fxShuffleAllowed(nebula, CATALOG, fxCalmIds(CATALOG)).has('bloom'));
  const plasma = SCENES.find((scene) => scene.id === 'plasma');
  const aurora = SCENES.find((scene) => scene.id === 'aurora');
  assert.deepEqual(aurora.fxLeftOut, ['palette_map'], 'Palette Map past the margin on Aurora');
  assert.ok(!fxShuffleAllowed(aurora, CATALOG, fxCalmIds(CATALOG)).has('palette_map'));
  const fire = SCENES.find((scene) => scene.id === 'fire');
  assert.deepEqual(plasma.fxLeftOut, ['bloom', 'watercolour']);
  assert.deepEqual(fire.fxLeftOut, []);
  assert.deepEqual(fxDrawnFor(plasma, ['watercolour', 'bloom', 'wave']), ['wave']);
  assert.deepEqual(fxDrawnFor(fire, ['watercolour', 'bloom']), ['watercolour', 'bloom']);
  // The shuffle's choice: the calm ones less those left out.
  const calmIds = fxCalmIds(CATALOG);
  const allowed = fxShuffleAllowed(plasma, CATALOG, calmIds);
  assert.equal(allowed.size, calmIds.size - 2);
  assert.ok(!allowed.has('bloom') && !allowed.has('watercolour') && allowed.has('wave'));
  assert.equal(fxShuffleAllowed(fire, CATALOG, calmIds), calmIds, 'a calm scene without any: the calm set');
  assert.equal(fxShuffleAllowed(SCENES.find((scene) => scene.id === 'tunnel'), CATALOG, calmIds), null, 'not calm: any');
  // Not calm but leaving one out (Voronoi Cells, Mirror): every effect but that one.
  const voronoi = SCENES.find((scene) => scene.id === 'voronoi');
  const voronoiAllowed = fxShuffleAllowed(voronoi, CATALOG, calmIds);
  assert.equal(voronoiAllowed.size, CATALOG.length - 1);
  assert.ok(!voronoiAllowed.has('mirror') && voronoiAllowed.has('swirl'));
  assert.deepEqual(fxDrawnFor(voronoi, ['mirror', 'swirl']), ['swirl']);
  // A scene that is not calm but leaves one out: everything else.
  const notCalm = fxShuffleAllowed({ fxLeftOut: ['bloom'] }, CATALOG, calmIds);
  assert.equal(notCalm.size, CATALOG.length - 1);
  // In the tab: shuffled on Plasma, never either.
  const m = await mount({ settings: { visualizerScene: 'plasma', visualizerFx: true, visualizerFxIntensity: 'strong', visualizerFxTiming: 4 } });
  const { session, controls } = m;
  m.start();
  await m.play(500);
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  for (let roll = 0; roll < 30; roll += 1) {
    click(controls.fxNow);
    await m.play(CROSSFADE_SLOW_MS + 200);
    // Not even chosen (a shuffled set never carries what will not be drawn).
    const ids = [...session.fx.chain.ids, ...(session.fx.combo?.ids || [])];
    assert.ok(!ids.includes('bloom') && !ids.includes('watercolour'), ids.join('+'));
  }
  // By hand: kept as chosen, not drawn, marked unavailable.
  change(session.fx.boxes.get('watercolour'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.ok(session.fx.combo.ids.includes('watercolour'));
  assert.ok(!session.fx.chain.ids.includes('watercolour'));
  assert.equal(session.fx.boxes.get('watercolour').getAttribute('aria-disabled'), 'true');
  session.destroy();
});

/* ---------------- Review of slice 5 ---------------- */

const sorted = (ids) => [...ids].sort();
const entryById = (id) => SCENES.find((scene) => scene.id === id);
/** The tab draws exactly what the calm rule leaves of the chosen set. */
function assertCalmRule(session, label) {
  const scene = session.switcher.current;
  const entry = entryById(scene);
  const chosen = session.fx.combo ? session.fx.combo.ids : [];
  const drawn = session.fx.chain.ids;
  assert.deepEqual(drawn, fxDrawnFor(entry, chosen), `${label} (${scene}): drawn ${drawn.join('+')} of ${chosen.join('+')}`);
  if (entry.fxNone) assert.equal(drawn.length, 0, `${label}: none on ${scene}`);
  if (entry.fxCalm) {
    assert.ok(drawn.length <= FX_CALM_MAX, `${label}: at most ${FX_CALM_MAX} on ${scene}`);
    assert.ok(!drawn.some((fx) => FX_LIVELY.has(fx)), `${label}: nothing lively on ${scene}: ${drawn.join('+')}`);
  }
}

test('the calm rule on every path: start-up settings, by hand on a calm scene, scene changes by hand and by next; the chosen set is kept and comes back; the panel marks what is left out; the star saves what is drawn', async () => {
  // fxDrawnFor itself.
  assert.deepEqual(fxDrawnFor(entryById('tunnel'), ['glitch', 'bloom', 'grain']), ['glitch', 'bloom', 'grain']);
  assert.deepEqual(fxDrawnFor(entryById('plasma'), ['glitch', 'chromatic', 'grain']), ['chromatic']);
  assert.deepEqual(fxDrawnFor(entryById('plasma'), ['chromatic', 'wave', 'trails']), ['chromatic', 'wave']);
  assert.deepEqual(fxDrawnFor(entryById('plasma'), ['bloom', 'chromatic', 'watercolour', 'trails']), ['chromatic', 'trails'], 'Plasma leaves out Bloom and Watercolour');
  assert.deepEqual(fxDrawnFor(entryById('mandelbrot'), ['glitch', 'bloom']), ['bloom'], 'Mandelbrot: calm');
  assert.deepEqual(fxDrawnFor({ ...entryById('mandelbrot'), fxNone: true }, ['bloom']), [], 'an fxNone scene: none');
  assert.deepEqual(fxDrawnFor(undefined, ['glitch']), ['glitch'], 'no scene yet: nothing to leave out');

  // Start-up: a hand set with two lively effects, read back on Plasma (calm).
  const set = fxOrder(CATALOG, ['glitch', 'chromatic', 'grain']);
  const m = await mount({ settings: { visualizerScene: 'plasma', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: set } });
  const { session, controls } = m;
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  assert.equal(session.switcher.current, 'plasma');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(sorted(session.fx.combo.ids), sorted(set), 'the chosen set is kept whole');
  assert.deepEqual(session.fx.chain.ids, ['chromatic'], 'only chromatic is drawn on plasma');
  assertCalmRule(session, 'start-up');
  const boxes = session.fx.boxes;
  assert.equal(boxes.get('glitch').checked, true, 'glitch stays chosen');
  assert.equal(boxes.get('glitch').getAttribute('aria-disabled'), 'true', 'and is marked unavailable');
  assert.equal(boxes.get('vhs').getAttribute('aria-disabled'), 'true', 'a lively one not chosen too');
  assert.equal(boxes.get('bloom').getAttribute('aria-disabled'), 'true', 'Bloom: left out on plasma');
  assert.equal(boxes.get('wave').getAttribute('aria-disabled'), 'false');
  assert.equal(boxes.get('chromatic').getAttribute('aria-disabled'), 'false');
  assert.equal(session.fx.note.hidden, false);
  assert.equal(session.fx.note.textContent, 'Grayed effects are not shown with this scene: it would flicker.');
  assert.match(controls.fxLine.textContent, /^Effects: Chromatic Aberration$/i, 'the line says what is drawn');

  // By hand on the calm scene: a calm one joins, a lively one is kept but not drawn.
  change(boxes.get('grain'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  change(boxes.get('wave'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), ['chromatic', 'wave']);
  assertCalmRule(session, 'by hand');
  change(boxes.get('glitch'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  change(boxes.get('vhs'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.ok(m.settings.visualizerFxSet.includes('vhs'), 'vhs is chosen and saved');
  assert.ok(!session.fx.chain.ids.includes('vhs'), 'but not drawn on plasma');
  assert.equal(boxes.get('vhs').checked, true);
  assert.equal(boxes.get('vhs').getAttribute('aria-disabled'), 'true');
  assertCalmRule(session, 'lively by hand');
  // A third calm one by hand: chosen, but a calm scene draws two.
  change(boxes.get('vhs'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  change(boxes.get('trails'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.fx.combo.ids.length, 3);
  assert.equal(session.fx.chain.count, FX_CALM_MAX);
  assertCalmRule(session, 'three by hand');
  const leftOut = session.fx.combo.ids.find((fx) => !session.fx.chain.ids.includes(fx));
  assert.equal(boxes.get(leftOut).getAttribute('aria-disabled'), 'true', `${leftOut} is marked as left out`);
  // The star saves only what is drawn.
  click(controls.star);
  const fav = m.settings.visualizerFavourites.at(-1);
  assert.deepEqual(sorted(parseVisualizerFavourite(fav).fx), sorted(session.fx.chain.ids), `saved ${fav}`);
  assert.ok(!fav.includes(leftOut), `${leftOut} not in ${fav}`);
  // Back to a set with a lively one for the scene changes.
  change(boxes.get('trails'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  change(boxes.get('glitch'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  const chosen = sorted(session.fx.combo.ids);
  assert.ok(chosen.includes('glitch'));

  // Scene changes by hand: all of it back on tunnel; filtered on aurora and
  // on mandelbrot (calm).
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), chosen, 'all of the chosen set on tunnel');
  assert.equal(session.fx.note.hidden, true);
  assert.equal(boxes.get('glitch').getAttribute('aria-disabled'), 'false');
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  assertCalmRule(session, 'picked aurora');
  assert.ok(!session.fx.chain.ids.includes('glitch'));
  session.sceneList.pick('mandelbrot');
  await m.until(() => session.switcher.current === 'mandelbrot', 'mandelbrot');
  assertCalmRule(session, 'picked mandelbrot');
  assert.ok(!session.fx.chain.ids.includes('glitch'));
  assert.equal(boxes.get('glitch').getAttribute('aria-disabled'), 'true', 'the lively one unavailable on mandelbrot');
  assert.deepEqual(sorted(session.fx.combo.ids), chosen, 'still chosen on mandelbrot');
  // Through the whole list by next: the rule holds on every scene, from its first frame.
  const seen = new Set();
  for (let step = 0; step < SCENES.length + 2; step += 1) {
    const before = session.switcher.current;
    click(controls.next);
    await m.until(() => session.switcher.current !== before, 'next scene');
    assertCalmRule(session, `next ${step}`);
    seen.add(session.switcher.current);
    await m.play(CROSSFADE_SLOW_MS + 200);
  }
  for (const id of FX_CALM_SCENES) assert.ok(seen.has(id), `next reached ${id}`);
  assert.deepEqual(sorted(m.settings.visualizerFxSet), chosen, 'the hand set was never rewritten');
  session.destroy();
});

test('the calm rule on every path: a favourite carrying lively effects is drawn as the scene allows and whole on one that allows it', async () => {
  // A favourite starred (before this rule) with lively effects on Aurora.
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel',
      visualizerFx: true,
      visualizerFxShuffle: true,
      visualizerShuffle: true,
      visualizerShufflePool: 'favourites',
      // Whatever look each comes in with.
      visualizerFavourites: ['aurora', 'tunnel'].flatMap((scene) => [null, 0, 1, 2, 3, 4, 5].map((look) => `${scene}${look === null ? '' : `:${look}`}|glitch+vhs+bloom`)),
    },
  });
  const { session } = m;
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  const favourites = session.fx.stats.favourites;
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.fx.stats.favourites, favourites + 1, 'the favourite\'s effects were taken');
  // Read as the scene draws it (favouritesAsDrawn): Aurora's favourites
  // keep only bloom, Tunnel's all three.
  assert.ok(m.settings.visualizerFavourites.every((item) => !item.startsWith('aurora') || item.endsWith('|bloom')));
  assert.deepEqual(sorted(session.fx.combo.ids), ['bloom'], 'chosen as stored');
  assert.deepEqual(session.fx.chain.ids, ['bloom'], 'drawn as the scene allows');
  assertCalmRule(session, 'favourite');
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), ['bloom', 'glitch', 'vhs'], 'all of it on tunnel');
  session.destroy();
});

/* The beat clock's share of the flash budget with trigger effects. */

/** Large pulses at `times` (s): never more than `most` in a rolling second. */
function mostInASecond(times) {
  const list = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let start = 0; start < list.length; start += 1) {
    let end = start;
    while (end < list.length && list[end] - list[start] < 1 - 1e-9) end += 1;
    most = Math.max(most, end - start);
  }
  return most;
}

/** Every large change of light seen in a run, counted from what reaches the
 *  picture: envelope pulses (rising edges of the limited channels over
 *  pulseThreshold, re-armed under rearmLevel), wraps of the beat clock when
 *  the scene shows it, and trigger effects starting (u_age as each program
 *  gets it: falling, or a first value under the idle age). Changes in the
 *  same frame are one flash. */
function budgetRun({
  fx = [], values = {}, sceneReadsClock = false, parallel = false, seconds = 20, bpm = 180,
  shared = true, schedule = null,
} = {}) {
  const gl = new StrictGL({ parallel });
  const limiter = createFlashLimiter();
  const chain = createFxChain({ gl, mode: 'webgl2', charge: shared ? () => limiter.charge() : null });
  const ages = new Map(); // program -> last u_age
  const firstAges = [];
  let flashFrame = false;
  let frameNow = 0;
  const kinds = { pulse: [], wrap: [], fire: [] };
  const uniform1f = gl.uniform1f.bind(gl);
  gl.uniform1f = (at, value) => {
    if (at?.name === 'u_age') {
      const before = ages.get(gl.current);
      const fired = before === undefined ? value < TRIGGER_IDLE_AGE - 1 : value < before - 1e-9;
      if (before === undefined) firstAges.push(value);
      if (fired) { flashFrame = true; kinds.fire.push(frameNow); }
      ages.set(gl.current, value);
    }
    uniform1f(at, value);
  };
  const ctl = {
    gl,
    chain,
    limiter,
    set(ids) {
      const passes = passesFor(ids);
      for (const pass of passes) Object.assign(pass.values, values[pass.id] || {});
      chain.setPasses(passes);
      // As the tab does (index.js updateClockShown).
      limiter.setClockShown(sceneReadsClock);
      limiter.setTriggersOn(shared && chain.usesClock);
    },
  };
  ctl.set(fx);
  const times = [];
  const armed = { kick: true, snare: true, hat: true };
  let lastClock = Number.NaN;
  const families = ['kick', 'snare', 'hat'];
  for (let frame = 0; frame < seconds * 30; frame += 1) {
    const now = frame / 30;
    frameNow = now;
    schedule?.(frame, now, ctl);
    if (frame % 15 === 0) limiter.setTriggersOn(shared && chain.usesClock); // a link finished
    flashFrame = false;
    // Strong pulses: a hit every 4 frames (7.5 a second), the families in turn.
    const out = limiter.step(now, { [families[Math.floor(frame / 4) % 3]]: frame % 4 === 0 ? 1 : 0 });
    for (const name of families) {
      if (out[name] < FLASH_LIMITS.rearmLevel) armed[name] = true;
      else if (armed[name] && out[name] >= FLASH_LIMITS.pulseThreshold) { armed[name] = false; flashFrame = true; kinds.pulse.push(now); }
    }
    const clock = limiter.beatClock(now * bpm / 60, bpm);
    if (sceneReadsClock && Number.isFinite(lastClock) && Math.floor(clock) > Math.floor(lastClock)) { flashFrame = true; kinds.wrap.push(now); }
    lastClock = clock;
    chain.begin(64, 36);
    chain.finish({ time: now, dt: 1 / 30, beat: { clock }, sources: null });
    if (flashFrame) times.push(now);
  }
  return {
    ...ctl, times, kinds, firstAges, most: mostInASecond(times),
  };
}

test('one budget for everything: envelope pulses, a shown clock\'s wraps and trigger firings together never exceed 3 in a rolling second', () => {
  assert.equal(FX_TRIGGER_GAP_S, 1 / FLASH_LIMITS.clockReserve);
  const most = FLASH_LIMITS.maxPulsesPerSecond;
  const cases = [
    ['shockwave on the beat', { fx: ['shockwave'], values: { shockwave: { sync: FX_SYNC.beat } } }],
    ['shockwave on the bar', { fx: ['shockwave'], values: { shockwave: { sync: FX_SYNC.bar } } }],
    ['shockwave free running every 0.2 s', { fx: ['shockwave'], values: { shockwave: { sync: FX_SYNC.free, interval: 0.2 } } }],
    ['two triggers: shockwave free every 0.2 s + datamosh on the beat', {
      fx: ['shockwave', 'datamosh'], values: { shockwave: { sync: FX_SYNC.free, interval: 0.2 }, datamosh: { sync: FX_SYNC.beat } },
    }],
    ['a scene that shows the clock + shockwave free every 0.2 s', {
      fx: ['shockwave'], sceneReadsClock: true, values: { shockwave: { sync: FX_SYNC.free, interval: 0.2 } },
    }],
    ['a scene that shows the clock + shockwave free every 0.35 s + datamosh on the bar', {
      fx: ['shockwave', 'datamosh'], sceneReadsClock: true, values: { shockwave: { sync: FX_SYNC.free, interval: 0.35 }, datamosh: { sync: FX_SYNC.bar } },
    }],
  ];
  for (const [label, options] of cases) {
    const run = budgetRun(options);
    assert.ok(run.chain.stats.triggers >= 3, `${label}: it fired (${run.chain.stats.triggers})`);
    assert.ok(run.limiter.stats.pulses >= 15, `${label}: the envelope pulsed (${run.limiter.stats.pulses})`);
    if (options.sceneReadsClock) assert.ok(run.limiter.stats.clockWraps >= 5, `${label}: the clock wrapped (${run.limiter.stats.clockWraps})`);
    assert.ok(run.most <= most, `${label}: at most ${most} in a second, counted together (${run.most})`);
  }
  // The same runs without the shared budget go over: the count does test it.
  const loose = budgetRun({ fx: ['shockwave'], shared: false, values: { shockwave: { sync: FX_SYNC.free, interval: 0.2 } } });
  assert.ok(loose.most > most, `without the shared budget: ${loose.most}`);
  // No trigger effect: nothing kept free for it.
  const plain = createFxChain({ gl: new FakeGL(), mode: 'webgl2' });
  plain.setPasses(passesFor(['bloom']));
  assert.equal(plain.usesClock, false);
});

test('one budget: a trigger switched on and off within the second - its firings stay charged, and it fires only with room', () => {
  for (const [label, values] of [
    ['free every 0.15 s', { shockwave: { sync: FX_SYNC.free, interval: 0.15 } }],
    ['on the beat', { shockwave: { sync: FX_SYNC.beat } }],
  ]) {
    // On for 0.4 s, off for 0.3 s, over and over, at odd moments of the second.
    const run = budgetRun({
      fx: [],
      values,
      seconds: 30,
      schedule: (frame, now, ctl) => {
        const at = frame % 21;
        if (at === 0) ctl.set(['shockwave']);
        if (at === 12) ctl.set([]);
      },
    });
    assert.ok(run.chain.stats.triggers >= 5, `${label}: it fired (${run.chain.stats.triggers})`);
    assert.ok(run.most <= FLASH_LIMITS.maxPulsesPerSecond, `${label}: at most 3 in a second, counted together (${run.most})`);
  }
});

test('one budget: a trigger whose program links late starts spent, and shows a ring only on a charged firing', () => {
  for (const linkAt of [7, 23, 41, 58, 75, 96]) {
    const run = budgetRun({
      fx: ['shockwave'],
      parallel: true,
      values: { shockwave: { sync: FX_SYNC.free, interval: 0.3 } },
      seconds: 8,
      schedule: (frame, now, ctl) => { if (frame === linkAt) ctl.gl.finishCompiles(); },
    });
    assert.ok(run.firstAges.length >= 1, `linked at frame ${linkAt}: drawn`);
    assert.equal(run.firstAges[0], TRIGGER_IDLE_AGE, `linked at frame ${linkAt}: its first frame shows nothing (age ${run.firstAges[0]})`);
    assert.ok(run.chain.stats.triggers >= 2, `linked at frame ${linkAt}: it fired later`);
    assert.ok(run.most <= FLASH_LIMITS.maxPulsesPerSecond, `linked at frame ${linkAt}: at most 3 in a second (${run.most})`);
  }
  // On a new scene (resetHistory) a trigger starts spent again.
  const run = budgetRun({
    fx: ['shockwave'],
    values: { shockwave: { sync: FX_SYNC.free, interval: 0.3 } },
    seconds: 4,
    schedule: (frame, now, ctl) => { if (frame === 50) ctl.chain.resetHistory(); },
  });
  assert.ok(run.most <= FLASH_LIMITS.maxPulsesPerSecond, `after a new scene: ${run.most}`);
});

test('in the tab: a trigger effect on a scene that does not read the clock reserves the clock\'s share; off again with it', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom'] } });
  const { session } = m;
  await m.until(() => session.switcher.current === 'tunnel' && Boolean(session.fx.shuffle), 'tunnel and library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  const sceneReads = session.bridge.limiter.clockShown;
  assert.equal(sceneReads, false, 'tunnel does not show the clock (FakeGL scene)');
  change(session.fx.boxes.get('shockwave'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.ok(session.fx.chain.ids.includes('shockwave'));
  assert.equal(session.bridge.limiter.triggersOn, true, 'reserved for shockwave');
  assert.equal(session.bridge.limiter.clockShown, false, 'the scene still does not show the clock');
  assert.equal(session.bridge.limiter.pulseBudget, FLASH_LIMITS.maxPulsesPerSecond - FLASH_LIMITS.clockReserve);
  change(session.fx.boxes.get('shockwave'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.bridge.limiter.triggersOn, false, 'released');
  session.destroy();
});

/* The effects shuffle and the scene shuffle's cost filter. */

test('the effects shuffle keeps to the cost filter: light, medium and all, each on its own (unit and in the tab)', async () => {
  const rank = (cost) => ['light', 'medium', 'heavy'].indexOf(cost);
  for (const [filter, costMax] of [['light', 'light'], ['medium', 'medium'], ['all', 'heavy']]) {
    const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(11) });
    const classes = new Set();
    for (let roll = 0; roll < 600; roll += 1) {
      const combo = shuffle.next({ intensity: 'strong', maxCount: 3, costBudget: FX_COST_BUDGET.high, costMax });
      shuffle.shown(combo || { ids: [] });
      for (const id of combo.ids) {
        classes.add(byId.get(id).cost);
        assert.ok(rank(byId.get(id).cost) <= rank(costMax), `${filter}: ${id} is ${byId.get(id).cost}`);
      }
    }
    if (filter === 'light') assert.deepEqual([...classes], ['light']);
    if (filter === 'medium') assert.ok(classes.has('medium') && !classes.has('heavy'), [...classes].join());
    if (filter === 'all') assert.ok(classes.has('heavy'), 'all: heavy ones come up');
  }
  // In the tab: the scene shuffle's cost filter reaches the effects shuffle.
  for (const filter of ['light', 'medium', 'all']) {
    const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxIntensity: 'strong', visualizerShuffleCost: filter } });
    const { session, controls } = m;
    await m.until(() => session.switcher.current === 'tunnel' && Boolean(session.fx.shuffle), 'tunnel and library');
    m.start();
    await m.play(CROSSFADE_SLOW_MS + 200);
    const most = filter === 'light' ? 0 : (filter === 'medium' ? 1 : 2);
    const classes = new Set();
    for (let roll = 0; roll < 30; roll += 1) {
      click(controls.fxNow);
      await m.play(CROSSFADE_SLOW_MS + 200);
      for (const id of session.fx.chain.ids) {
        classes.add(byId.get(id).cost);
        assert.ok(rank(byId.get(id).cost) <= most, `${filter} in the tab: ${id} is ${byId.get(id).cost}`);
      }
    }
    if (filter !== 'light') assert.ok(classes.has('medium'), `${filter}: medium ones came up (${[...classes].join()})`);
    session.destroy();
  }
});

/* The chain's programs: compiled without blocking, a bounded cache. */

test('effect programs: the chain\'s and at most 6 others are kept while cycling through every effect; everything deleted on destroy', () => {
  assert.equal(FX_PROGRAM_CACHE, 6);
  const gl = new StrictGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  let most = 0;
  for (const fx of CATALOG) {
    chain.setPasses(passesFor([fx.id]));
    chain.begin(64, 36);
    chain.finish({ ...STATE, dt: 1 / 30 });
    const helpers = 2; // reactions and blit, kept while effects are on
    assert.ok(chain.stats.programs <= chain.count + FX_PROGRAM_CACHE, `${fx.id}: ${chain.stats.programs} held`);
    assert.ok(gl.programs.size <= chain.count + FX_PROGRAM_CACHE + helpers, `${fx.id}: ${gl.programs.size} GL programs`);
    assert.ok(gl.shaders.size <= 2 * (chain.count + FX_PROGRAM_CACHE + helpers), `${fx.id}: ${gl.shaders.size} GL shaders`);
    most = Math.max(most, chain.stats.programs);
  }
  assert.equal(most, 1 + FX_PROGRAM_CACHE, 'the cache fills up to its size');
  assert.ok(chain.stats.programsDeleted >= CATALOG.length - 1 - FX_PROGRAM_CACHE, `deleted ${chain.stats.programsDeleted}`);
  // Switching back to a recent one does not compile it again.
  const compiles = chain.stats.compiles;
  chain.setPasses(passesFor([CATALOG.at(-2).id]));
  assert.equal(chain.stats.compiles, compiles, 'a cached program is reused');
  chain.destroy();
  assert.equal(gl.programs.size, 0, 'every program deleted');
  assert.equal(gl.shaders.size, 0, 'and every shader');
  assert.deepEqual(gl.misuse, []);
});

test('effect programs compile without blocking a frame: the pass joins when its program is ready, the picture is drawn without it meanwhile; nothing still linking is deleted', () => {
  const gl = new StrictGL({ parallel: true });
  const chain = createFxChain({ gl, mode: 'webgl2' });
  let statusReads = 0;
  const shaderParameter = gl.getShaderParameter.bind(gl);
  gl.getShaderParameter = (...args) => { statusReads += 1; return shaderParameter(...args); };
  chain.setPasses(passesFor(['bloom']));
  // Linking: the chain is bypassed (the scene draws to the screen).
  for (let frame = 0; frame < 3; frame += 1) {
    assert.equal(chain.begin(64, 36), null, 'bypassed while linking');
    assert.equal(chain.finish({ ...STATE, dt: 1 / 30 }), false);
  }
  assert.deepEqual(chain.ids, ['bloom'], 'asked for');
  assert.deepEqual(chain.drawnIds, [], 'not drawn yet');
  assert.ok(chain.stats.waitedLink >= 3);
  assert.equal(chain.linking, 1);
  assert.ok(gl.statusChecks >= 3, 'polled once a frame');
  assert.equal(statusReads, 0, 'no compile or link status read before the driver says it finished');
  gl.finishCompiles();
  assert.ok(chain.begin(64, 36), 'drawn once ready');
  assert.ok(chain.finish({ ...STATE, dt: 1 / 30 }));
  assert.deepEqual(chain.drawnIds, ['bloom']);
  // A second one joins later; the first keeps drawing meanwhile.
  chain.setPasses(passesFor(['bloom', 'chromatic']));
  assert.ok(chain.begin(64, 36), 'bloom still drawn');
  chain.finish({ ...STATE, dt: 1 / 30 });
  assert.deepEqual(chain.drawnIds, ['bloom']);
  gl.finishCompiles();
  chain.begin(64, 36);
  chain.finish({ ...STATE, dt: 1 / 30 });
  assert.deepEqual(chain.drawnIds, ['bloom', 'chromatic']);
  // Cycling faster than links finish: nothing still linking is deleted.
  for (const fx of CATALOG.slice(0, 12)) {
    chain.setPasses(passesFor([fx.id]));
    chain.begin(64, 36);
    chain.finish({ ...STATE, dt: 1 / 30 });
  }
  assert.deepEqual(gl.misuse, [], 'nothing deleted mid-link');
  assert.ok(chain.linking > 1, 'several still linking');
  gl.finishCompiles();
  chain.begin(64, 36);
  assert.ok(chain.stats.programs <= chain.count + FX_PROGRAM_CACHE, `after the links: ${chain.stats.programs}`);
  // A program that fails leaves the chain once its link is read.
  gl.failCompile = true;
  chain.setPasses(passesFor(['grain']));
  gl.finishCompiles();
  chain.begin(64, 36);
  gl.failCompile = false;
  assert.deepEqual(chain.ids, [], 'the failed pass left');
  // Destroy with one still linking: that one is left to the context loss.
  chain.setPasses(passesFor(['wave']));
  chain.destroy();
  assert.deepEqual(gl.misuse, []);
  assert.equal(gl.programs.size, 1, 'only the one still linking');
});

test('the tab shows and stars only effects actually drawn: one still linking is not drawn, saved or reserved for; a late link or failure updates the panel, the star and the reservation', async () => {
  const gl = new StrictGL({ parallel: true });
  gl.autoFinishAfter = 1; // the scene compiles; effects are held back below
  const m = await mount({ gl, settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: [] } });
  const { session, controls } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(500);
  gl.autoFinishAfter = Infinity;
  change(session.fx.boxes.get('shockwave'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  // Shockwave asked for, still linking: not drawn, not shown as drawn, no share kept.
  assert.deepEqual(session.fx.combo.ids, ['shockwave']);
  assert.ok(session.fx.chain.linking >= 1, 'linking');
  assert.deepEqual(session.fx.drawn, []);
  assert.equal(controls.fxLine.textContent, 'Effects: none now');
  assert.equal(session.bridge.limiter.triggersOn, false, 'nothing kept free for a trigger not drawn');
  // Starring now saves the scene without it.
  click(controls.star);
  const fav = m.settings.visualizerFavourites.at(-1);
  assert.deepEqual(parseVisualizerFavourite(fav).fx, [], `saved ${fav}`);
  // The link finishes: the chain says so, and the tab follows.
  gl.finishCompiles();
  await m.play(300);
  assert.deepEqual(session.fx.drawn, ['shockwave']);
  assert.match(controls.fxLine.textContent, /Shockwave/i);
  assert.equal(session.bridge.limiter.triggersOn, true, 'kept free once it draws');
  assert.equal(controls.star.getAttribute('aria-pressed'), 'false', 'the starred set (none) is no longer what is shown');
  // A second effect whose link fails later: shown as failed, not as on.
  const before = session.fx.stats.changes;
  change(session.fx.boxes.get('chromatic'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.ok(session.fx.stats.changes > before);
  assert.deepEqual(session.fx.drawn, ['shockwave'], 'chromatic still linking');
  gl.failCompile = true;
  gl.finishCompiles();
  await m.play(300);
  gl.failCompile = false;
  assert.deepEqual(session.fx.drawn, ['shockwave']);
  assert.deepEqual(session.fx.failedIds, ['chromatic']);
  const box = session.fx.boxes.get('chromatic');
  assert.equal(box.checked, false, 'not shown as on');
  assert.equal(box.disabled, true);
  assert.equal(box.getAttribute('aria-disabled'), 'true');
  assert.equal(session.fx.note.hidden, false);
  assert.match(session.fx.note.textContent, /Could not be drawn on this computer: Chromatic/i);
  click(controls.star);
  const fav2 = m.settings.visualizerFavourites.at(-1);
  assert.deepEqual(parseVisualizerFavourite(fav2).fx, ['shockwave'], `saved ${fav2}`);
  // A failed effect holds no slot. The next tick leaves it out of the choice.
  change(session.fx.boxes.get('grain'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  gl.finishCompiles();
  await m.play(300);
  assert.deepEqual(sorted(session.fx.drawn), ['grain', 'shockwave']);
  assert.deepEqual(sorted(m.settings.visualizerFxSet), ['grain', 'shockwave'], 'the failed one left the hand set');
  // Three chosen and one of them fails: a third that draws can still be ticked.
  change(session.fx.boxes.get('vhs'), true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  gl.failCompile = true;
  gl.finishCompiles();
  await m.play(300);
  gl.failCompile = false;
  assert.deepEqual(session.fx.failedIds, ['vhs']);
  assert.match(session.fx.note.textContent, /Could not be drawn on this computer: VHS/i);
  const third = session.fx.boxes.get('dither');
  assert.equal(third.disabled, false, 'a third usable effect may be ticked');
  change(third, true);
  await m.play(CROSSFADE_SLOW_MS + 200);
  gl.finishCompiles();
  await m.play(300);
  assert.deepEqual(sorted(session.fx.drawn), ['dither', 'grain', 'shockwave']);
  assert.deepEqual(sorted(m.settings.visualizerFxSet), ['dither', 'grain', 'shockwave']);
  assert.equal(third.checked, true);
  change(session.fx.boxes.get('grain'), false);
  change(session.fx.boxes.get('dither'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  // Off: the share goes with it.
  change(session.fx.boxes.get('shockwave'), false);
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.equal(session.bridge.limiter.triggersOn, false);
  assert.deepEqual(gl.misuse, []);
  session.destroy();
});

test('the chain makes no garbage per frame once linked: one drawable list, polling only what is linking', () => {
  const gl = new FakeGL({ parallel: true });
  const chain = createFxChain({ gl, mode: 'webgl2' });
  chain.setPasses(passesFor(['bloom', 'trails', 'chromatic']));
  gl.finishCompiles();
  chain.begin(64, 36);
  chain.finish({ ...STATE, dt: 1 / 30 });
  assert.deepEqual(sorted(chain.drawnIds), ['bloom', 'chromatic', 'trails']);
  assert.equal(chain.linking, 0);
  // Nothing linking: no status query at all; begin and finish use the same list.
  const checks = gl.statusChecks;
  const polls = chain.stats.polls;
  const builds = chain.stats.drawListBuilds;
  let maps = 0;
  const realMap = Array.prototype.map;
  const realFilter = Array.prototype.filter;
  /* eslint-disable no-extend-native */
  Array.prototype.map = function map(...args) { maps += 1; return realMap.apply(this, args); };
  Array.prototype.filter = function filter(...args) { maps += 1; return realFilter.apply(this, args); };
  try {
    for (let frame = 0; frame < 30; frame += 1) {
      chain.begin(64, 36);
      chain.finish({ ...STATE, time: 1 + frame / 30, dt: 1 / 30 });
    }
  } finally {
    Array.prototype.map = realMap;
    Array.prototype.filter = realFilter;
  }
  assert.equal(gl.statusChecks, checks, 'no status queries with nothing linking');
  assert.equal(chain.stats.polls, polls, 'no look at the programs with nothing linking');
  assert.equal(chain.stats.drawListBuilds, builds, 'the drawn list is not made again per frame');
  assert.equal(maps, 0, 'no arrays made per frame');
  chain.destroy();
});

/* ---------------- The flash budget's shares (review round 3) ---------------- */

/** The longest gap between successive `times` (and from 0 to the first, and
 *  from the last to `end`). */
function longestGap(times, end) {
  let most = 0;
  let last = 0;
  for (const time of times) { most = Math.max(most, time - last); last = time; }
  return Math.max(most, end - last);
}

test('the shares: under the most traffic of all three kinds for 30 s the clock wraps and triggers fire at least every 2 s, envelopes still get through, and the total never passes 3 in a second', () => {
  const limiter = createFlashLimiter();
  assert.equal(limiter.pulseBudget, 3, 'no clock, no trigger: 3 for the envelopes');
  limiter.setClockShown(true);
  assert.equal(limiter.pulseBudget, 2, 'one of them: 2');
  limiter.setTriggersOn(true);
  assert.equal(limiter.pulseBudget, 1, 'both: 1');
  limiter.setClockShown(false);
  assert.equal(limiter.pulseBudget, 2);
  // The slots are each kind's own: a second trigger in the second may not
  // take the clock's, though the total has room; the clock's wrap then gets it.
  const slots = createFlashLimiter();
  slots.setClockShown(true);
  slots.setTriggersOn(true);
  slots.step(0, {});
  slots.beatClock(0.5, 60);
  assert.equal(slots.charge(0.1), true, 'the trigger slot');
  assert.equal(slots.charge(0.2), false, 'not the slot of the clock');
  slots.step(0.6, {});
  assert.equal(slots.beatClock(1.05, 60), 1.05, 'the wrap of the clock gets its slot');
  assert.equal(slots.stats.clockWraps, 1);
  assert.equal(slots.charge(0.7), false, 'and a trigger may not take a third');
  for (const [label, values] of [
    ['a trigger retrying every frame (free, every 0.05 s)', { shockwave: { sync: FX_SYNC.free, interval: 0.05 } }],
    ['a trigger on the beat', { shockwave: { sync: FX_SYNC.beat } }],
  ]) {
    const seconds = 30;
    // Envelope hits on every frame in turn (the most the limiter is asked),
    // a scene that shows the clock, at 180 BPM.
    const run = budgetRun({ fx: ['shockwave'], sceneReadsClock: true, values, seconds, bpm: 180 });
    const { pulse, wrap, fire } = run.kinds;
    assert.ok(longestGap(wrap, seconds) <= 2 + 1e-9, `${label}: the clock wraps at least every 2 s (longest gap ${longestGap(wrap, seconds).toFixed(2)} s)`);
    assert.ok(longestGap(fire, seconds) <= 2 + 1e-9, `${label}: triggers fire at least every 2 s (longest gap ${longestGap(fire, seconds).toFixed(2)} s)`);
    assert.ok(pulse.length >= seconds * 0.8, `${label}: envelopes get through (${pulse.length} in ${seconds} s)`);
    assert.ok(run.most <= FLASH_LIMITS.maxPulsesPerSecond, `${label}: at most 3 in a second (${run.most})`);
  }
});

test('the held clock: while a wrap is refused it waits just short of it; when admitted it takes the music\'s phase again, so no lag builds up', () => {
  const limiter = createFlashLimiter();
  const bpm = 60; // one beat a second: the clock's pace the same shown or not
  let most = 0;
  let given = 0;
  let wraps = 0;
  let held = 0;
  for (let frame = 0; frame < 60 * 60; frame += 1) {
    const now = frame / 60;
    // Every 3 s, a scene that does not show the clock for 1.75 s, back just
    // before a wrap: the envelopes had all 3 meanwhile, so the wrap meets a
    // full second. Envelope hits every 5 frames, the families in turn.
    limiter.setClockShown(!(frame % 180 >= 12 && frame % 180 < 117));
    limiter.step(now, { [['kick', 'snare', 'hat'][Math.floor(frame / 5) % 3]]: frame % 5 === 2 ? 1 : 0 });
    const music = now * bpm / 60; // the music's clock
    const before = given;
    given = limiter.beatClock(now * bpm / 60, bpm);
    assert.ok(given >= before - 1e-9, 'never goes back');
    const lag = music - given;
    assert.ok(lag > -1e-9 && lag < 1, `at ${now.toFixed(2)} s it is behind the music by under a cycle (${lag.toFixed(3)})`);
    if (limiter.clockShown && Math.floor(given) > Math.floor(before)) {
      wraps += 1;
      assert.ok(Math.abs(lag) < 1e-9, `a wrap lands on the music's phase (lag ${lag.toFixed(4)} at ${now.toFixed(2)} s)`);
    }
    if (lag > 1e-9) held += 1;
    most = Math.max(most, lag);
  }
  assert.ok(held > 0, 'it was held at times (the test does test it)');
  assert.ok(wraps >= 35, `it kept wrapping while shown (${wraps} in 60 s)`);
  // Behind only while held (up to the time a pulse takes to age out).
  assert.ok(most < 0.5, `the most it fell behind: ${most.toFixed(3)} cycles`);
  const music = (60 * 60 - 1) / 60 * bpm / 60;
  assert.ok(music - given < 0.1, `after a minute it is still with the music (${(music - given).toFixed(3)})`);
});

test('the window survives: reset() keeps it, and a bridge made again (the tab closed and opened) with the page\'s window starts no fresh second', () => {
  const ledger = createFlashLedger();
  const first = createFlashLimiter({ ledger });
  for (const [at, name] of [[0.1, 'kick'], [0.2, 'snare'], [0.3, 'hat']]) {
    first.step(at - 0.05, {});
    first.step(at, { [name]: 1 });
  }
  assert.equal(first.stats.pulses, 3);
  first.reset();
  first.step(0.45, {});
  first.step(0.5, { kick: 1 });
  assert.equal(first.stats.pulses, 3, 'after reset(): the second is still full');
  // The tab closed and opened again: a new bridge on the same window.
  const again = createReactorBridge({ ledger });
  again.limiter.step(0.55, {});
  again.limiter.step(0.6, { snare: 1 });
  assert.equal(again.limiter.stats.pulses, 0, 'a new limiter on the page\'s window: still full');
  assert.equal(again.limiter.charge(0.65), false, 'no trigger slot either');
  again.limiter.step(1.15, {});
  again.limiter.step(1.2, { hat: 1 });
  assert.equal(again.limiter.stats.pulses, 1, 'room again once the first pulse is a second old');
  // Without a shared window, each limiter has its own (tests, the checks).
  const own = createFlashLimiter();
  own.step(0.6, { kick: 1 });
  assert.equal(own.stats.pulses, 1);
});

test('a slow fade is never cut short nor restarted fast while it is seen: a pause lets it run on, and a change asked for meanwhile waits for its end', async () => {
  const { createTransition } = await import('../src/visualizer/transition.js');
  const h = createClockHarness();
  const build = ({ animate }) => {
    const canvas = { width: 8, height: 8, style: {} };
    const fade = {
      hidden: true, width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, globalAlpha: 1, fillStyle: '' }),
      ...(animate ? { animate: () => ({ cancel() { fade.cancelled = true; } }) } : {}),
    };
    let charges = 0;
    const transition = createTransition({
      canvas, fade, setTimer: h.io.setTimer, clearTimer: h.io.clearTimer, clock: h.io.clock,
      brightness: () => 1, enabled: () => true, drawOld: () => true,
      charge: () => { charges += 1; return false; }, // the budget is full
    });
    return { canvas, fade, transition, charges: () => charges };
  };
  // A cross-fade.
  const a = build({ animate: true });
  assert.equal(a.transition.begin(), 0);
  assert.equal(a.transition.duration, CROSSFADE_SLOW_MS, 'slow: the budget was full');
  h.run(300);
  a.transition.finishNow({ keepFade: true }); // the pause
  assert.equal(a.transition.phase, 'fading', 'runs on');
  assert.notEqual(a.fade.cancelled, true);
  assert.ok(a.transition.begin() > 0, 'a change asked for now waits');
  assert.equal(a.transition.stats.fades, 1);
  assert.equal(a.charges(), 1, 'and is not charged, nor started fast');
  h.run(CROSSFADE_SLOW_MS);
  assert.equal(a.transition.phase, 'idle');
  assert.equal(a.transition.begin(), 0, 'after its end it starts again');
  assert.equal(a.transition.duration, CROSSFADE_SLOW_MS, 'slow again while the budget is still full');
  assert.equal(a.charges(), 2);
  // A dip (no compositor fade): on its way down a pause takes it back up at
  // its own pace, on its way up it runs on.
  const b = build({ animate: false });
  const half = b.transition.begin();
  assert.equal(half, CROSSFADE_SLOW_MS / 2);
  h.run(200);
  b.transition.finishNow({ keepFade: true });
  assert.equal(b.canvas.style.transition, `opacity ${CROSSFADE_SLOW_MS / 2}ms linear`, 'back up, not a step');
  assert.equal(b.canvas.style.opacity, '');
  const c = build({ animate: false });
  c.transition.begin();
  h.run(CROSSFADE_SLOW_MS / 2 + 1);
  c.transition.applied();
  h.run(100);
  c.transition.finishNow({ keepFade: true });
  assert.equal(c.transition.phase, 'in', 'its way up runs on');
  h.run(CROSSFADE_SLOW_MS);
  assert.equal(c.transition.phase, 'idle');
});

test('feedback passes get u_fstep, the frame\'s length in 60 fps frames (Psychedelia b9f21de), so trails, echoes, scans and smears look the same at 15, 30 and 60 fps', () => {
  assert.equal(fxFrameStep(1 / 60), 1);
  assert.equal(fxFrameStep(1 / 30), 2);
  assert.equal(fxFrameStep(1 / 15), 4);
  assert.equal(fxFrameStep(1), 4, 'kept to 4 (a stall)');
  assert.equal(fxFrameStep(1 / 1000), 0.25);
  for (const odd of [0, -1, NaN, undefined, Infinity]) assert.equal(fxFrameStep(odd), 1, String(odd));
  for (const id of ['trails', 'rgb_echo', 'slit_scan', 'datamosh']) {
    const gl = new FakeGL();
    const chain = createFxChain({ gl, mode: 'webgl2' });
    chain.setPasses(passesFor([id]));
    for (const [dt, step] of [[1 / 60, 1], [1 / 30, 2], [1 / 15, 4]]) {
      chain.begin(64, 36);
      chain.finish({ time: step, dt, beat: { clock: 0 }, sources: null });
      assert.deepEqual(gl.uniforms.get('u_fstep'), [step], `${id} at dt ${dt.toFixed(4)}`);
    }
    chain.destroy();
  }
  // A pass without it (no history) is not given one.
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  chain.setPasses(passesFor(['grain']));
  chain.begin(64, 36);
  chain.finish({ time: 1, dt: 1 / 30, beat: { clock: 0 }, sources: null });
  assert.equal(gl.uniforms.has('u_fstep'), false);
});

test('the beat clock only ever takes its own slot: with every envelope slot free, a second wrap within a second is refused, so wraps reach the picture at least 1 s apart', () => {
  const lone = createFlashLimiter();
  lone.setClockShown(true);
  lone.step(0, {});
  assert.equal(lone.charge(0, FLASH_KINDS.clock), true);
  assert.equal(lone.ledger.total, 1);
  assert.equal(lone.charge(0.5, FLASH_KINDS.clock), false, 'the total has room (1 of 3), the clock\'s slot does not');
  assert.equal(lone.charge(1, FLASH_KINDS.clock), true, 'its slot again a second later');
  // Fuzzed: envelope traffic (some of it filling the second, so wraps are
  // held and then jump to the music's phase), tempo changes, the clock shown
  // and not, triggers on and off. Every wrap that reaches the picture is a
  // second or more after the last.
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = seededRandom(seed);
    const limiter = createFlashLimiter();
    let given = 0;
    let lastWrap = Number.NEGATIVE_INFINITY;
    let wraps = 0;
    let bpm = 180;
    let music = 0;
    for (let frame = 0; frame < 30 * 120; frame += 1) {
      const now = frame / 30;
      if (frame % 90 === 0) bpm = [60, 120, 175, 240, 300][Math.floor(random() * 5)];
      if (frame % 45 === 0) limiter.setClockShown(random() < 0.8);
      if (frame % 60 === 0) limiter.setTriggersOn(random() < 0.3);
      limiter.step(now, { [['kick', 'snare', 'hat'][Math.floor(random() * 3)]]: random() < 0.4 ? 1 : 0 });
      if (random() < 0.05) limiter.charge(now, FLASH_KINDS.trigger);
      music += bpm / 60 / 30;
      const before = given;
      const wrapsBefore = limiter.stats.clockWraps;
      given = limiter.beatClock(music, bpm);
      if (limiter.stats.clockWraps > wrapsBefore) {
        assert.ok(Math.floor(given) > Math.floor(before));
        assert.ok(now - lastWrap >= 1 - 1e-9, `seed ${seed}: wraps ${(now - lastWrap).toFixed(3)} s apart at ${now.toFixed(2)} s`);
        lastWrap = now;
        wraps += 1;
      }
    }
    assert.ok(wraps > 40, `seed ${seed}: it wrapped (${wraps})`);
    assert.ok(limiter.stats.clockHeld > 0, `seed ${seed}: and was held at times`);
  }
});

test('a redraw at the time of the last frame (a held picture, the cross-fade\'s capture, a resize) moves no feedback history and shows that frame again', () => {
  assert.equal(fxFrameStep(0), 1, 'no time known (the loop\'s first frame): one step');
  for (const id of ['trails', 'rgb_echo', 'slit_scan', 'datamosh']) {
    const gl = new FakeGL();
    const chain = createFxChain({ gl, mode: 'webgl2' });
    chain.setPasses(passesFor([id]));
    chain.begin(64, 36);
    chain.finish({ time: 0, dt: 0, beat: { clock: 0 }, sources: null });
    assert.deepEqual(gl.uniforms.get('u_fstep'), [1], `${id}: first frame`);
    chain.begin(64, 36);
    chain.finish({ time: 1 / 30, dt: 1 / 30, beat: { clock: 0 }, sources: null });
    assert.equal(chain.stats.historySteps, 2);
    const screen = gl.screenDraws;
    for (const dt of [0, 1 / 30, 0]) {
      chain.begin(64, 36);
      assert.equal(chain.finish({ time: 1 / 30, dt, beat: { clock: 0 }, sources: null }), true);
      assert.deepEqual(gl.uniforms.get('u_fstep'), [2], `${id}: the step of the frame it shows again`);
    }
    assert.equal(chain.stats.historySteps, 2, `${id}: no history moved`);
    assert.equal(chain.stats.redraws, 3);
    assert.equal(gl.screenDraws, screen + 3, `${id}: still drawn each time`);
    chain.begin(64, 36);
    chain.finish({ time: 2 / 30, dt: 1 / 30, beat: { clock: 0 }, sources: null });
    assert.equal(chain.stats.historySteps, 3, `${id}: the next frame moves it on`);
    chain.destroy();
  }
});

test('favourites as read: each one\'s effects as its scene draws them, duplicates dropped, stored so; the star then matches and takes it off', async () => {
  const list = ['aurora:1|glitch+bloom', 'aurora:1|bloom', 'tunnel|glitch+bloom', 'from_a_later_build|glitch'];
  const entryFor = (id) => SCENES.find((scene) => scene.id === id);
  const drawnFor = (id, fx) => fxDrawnFor(entryFor(id), fx);
  const drawn = favouritesAsDrawn(list, drawnFor);
  assert.deepEqual(drawn, ['aurora:1|bloom', 'tunnel|glitch+bloom', 'from_a_later_build|glitch']);
  assert.deepEqual(favouritesAsDrawn(drawn, drawnFor), drawn, 'the same when nothing changes');
  const m = await mount({
    settings: {
      visualizerScene: 'aurora', visualizerLooks: { aurora: 1 }, visualizerFx: true, visualizerFxShuffle: false,
      visualizerFxSet: ['glitch', 'bloom'], visualizerFavourites: ['aurora:1|glitch+bloom'],
    },
  });
  const { session, controls } = m;
  assert.deepEqual(m.settings.visualizerFavourites, ['aurora:1|bloom'], 'stored in the reduced form');
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(session.fx.chain.ids, ['bloom'], 'drawn as the scene allows');
  assert.equal(controls.star.getAttribute('aria-pressed'), 'true', 'the star matches what is drawn');
  click(controls.star);
  assert.deepEqual(m.settings.visualizerFavourites, [], 'and takes it off');
  // From another window: read the same way.
  m.apply({ visualizerFavourites: ['aurora:1|vhs+bloom', 'aurora:1|bloom'] });
  assert.equal(controls.star.getAttribute('aria-pressed'), 'true');
  session.destroy();
});

test('favourites shuffle: a favourite saved with no effects clears them; one favourite of the scene shown with other effects changes only the effects, no scene installed again', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'moire', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom'],
      visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerShuffleBars: 8,
      visualizerFavourites: ['moire|bloom', 'tunnel'],
    },
  });
  const { session } = m;
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(session.fx.chain.ids, ['bloom']);
  for (let round = 0; round < 20 && session.switcher.current !== 'tunnel'; round += 1) await m.play(5000);
  assert.equal(session.switcher.current, 'tunnel', 'shuffled to tunnel');
  await m.play(CROSSFADE_SLOW_MS + 200);
  assert.deepEqual(session.fx.chain.ids, [], 'its saved "no effects" applied');
  assert.equal(session.fx.combo, null);
  // One favourite: tunnel with grain; shown now with none.
  m.apply({ visualizerFavourites: ['tunnel|grain'] });
  const compiles = session.renderer.stats.compiles;
  const preloads = session.switcher.stats.preloads;
  const requests = session.switcher.stats.requests;
  await m.play(40000);
  assert.equal(session.switcher.current, 'tunnel');
  assert.deepEqual(session.fx.chain.ids, ['grain'], 'the favourite\'s effects');
  assert.ok(session.shuffleStats.fxOnly >= 1);
  assert.equal(session.renderer.stats.compiles, compiles, 'no scene compiled again');
  assert.equal(session.switcher.stats.preloads, preloads, 'nothing prepared ahead');
  assert.equal(session.switcher.stats.requests, requests, 'no scene asked for');
  // Then nothing new: not changed again and again.
  const fxOnly = session.shuffleStats.fxOnly;
  const changes = session.fx.stats.changes;
  await m.play(40000);
  assert.equal(session.shuffleStats.fxOnly, fxOnly);
  assert.equal(session.fx.stats.changes, changes);
  assert.ok(session.shuffleStats.nothingNew >= 1);
  session.destroy();
});

test('ticks in quick succession all count: the ticked set is the choice, made or waiting, and what is drawn never rewrites it', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: [] } });
  const { session } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS + 200);
  const boxes = session.fx.boxes;
  const ticked = () => [...boxes].filter(([, box]) => box.checked).map(([id]) => id).sort();
  // Three ticks 0.3 s apart: each made while the one before is still fading in.
  change(boxes.get('oil_paint'), true);
  await m.play(300);
  change(boxes.get('god_rays'), true);
  await m.play(300);
  change(boxes.get('bloom'), true);
  assert.deepEqual(ticked(), ['bloom', 'god_rays', 'oil_paint'], 'ticked at once');
  // The cap counts the choice, not what is drawn yet.
  assert.equal(boxes.get('grain').disabled, true, 'a fourth is refused');
  change(boxes.get('grain'), true);
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), ['bloom', 'god_rays', 'oil_paint'], 'all three drawn');
  assert.deepEqual(ticked(), ['bloom', 'god_rays', 'oil_paint'], 'and still ticked');
  assert.deepEqual(sorted(m.settings.visualizerFxSet), ['bloom', 'god_rays', 'oil_paint']);
  // Three in one go (one task), then two off in one go.
  change(boxes.get('oil_paint'), false);
  change(boxes.get('god_rays'), false);
  assert.deepEqual(ticked(), ['bloom']);
  change(boxes.get('grain'), true);
  change(boxes.get('chromatic'), true);
  assert.deepEqual(ticked(), ['bloom', 'chromatic', 'grain']);
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), ['bloom', 'chromatic', 'grain']);
  assert.deepEqual(ticked(), ['bloom', 'chromatic', 'grain']);
  // On a calm scene the ticks stay (greyed where not drawn).
  session.sceneList.pick('aurora');
  change(boxes.get('grain'), false);
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  assert.deepEqual(ticked(), ['bloom', 'chromatic']);
  assert.deepEqual(sorted(m.settings.visualizerFxSet), ['bloom', 'chromatic']);
  session.destroy();
});

test('a calm scene coming in under effect shuffle (bar timing) judges the latest choice, not the old drawn one: a calm hand choice still waiting is kept', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: true, visualizerFxTiming: 8 } });
  const { session } = m;
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  m.start();
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  const boxes = session.fx.boxes;
  const ticked = () => [...boxes].filter(([, box]) => box.checked).map(([id]) => id).sort();
  // A lively set drawn (glitch is too lively for a calm scene) ...
  for (const id of ticked()) change(boxes.get(id), false);
  change(boxes.get('glitch'), true);
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  assert.deepEqual(sorted(session.fx.chain.ids), ['glitch']);
  // ... then the calm scene is asked for and starts its fade (it waits for
  // the picture to dip); a calm choice by hand made meanwhile waits behind
  // it, so the scene comes in first.
  session.sceneList.pick('aurora');
  const held = session.switcher.stats.held;
  await m.until(() => session.switcher.stats.held > held, 'the scene waiting for its dip');
  change(boxes.get('glitch'), false);
  change(boxes.get('color_grade'), true);
  assert.deepEqual(ticked(), ['color_grade']);
  const changes = session.fx.stats.changes;
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  assert.equal(session.fx.stats.changes, changes, 'nothing made over the waiting hand choice as the scene came in');
  await m.play(CROSSFADE_SLOW_MS * 2 + 200);
  assert.deepEqual(ticked(), ['color_grade'], 'the calm choice by hand stands');
  assert.deepEqual(sorted(session.fx.chain.ids), ['color_grade']);
  session.destroy();
});

test('favourites shuffle: a favourite whose only look is left out now shows the start look, not the look picked by hand', async () => {
  // Mandelbulb Slice's colour scheme 5 is left out (looks.js
  // LOOKS_LEFT_OUT); its scheme 3 was picked by hand (visualizerLooks).
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerShuffleBars: 8,
      visualizerFavourites: ['tunnel', 'mandelbulb_slice:5'], visualizerLooks: { mandelbulb_slice: 3 },
    },
  });
  const { session } = m;
  m.start();
  for (let round = 0; round < 30 && session.switcher.current !== 'mandelbulb_slice'; round += 1) await m.play(5000);
  assert.equal(session.switcher.current, 'mandelbulb_slice', 'shuffled to it');
  await m.play(CROSSFADE_SLOW_MS + 200);
  const def = session.renderer.definition;
  const offered = sceneLooks(def);
  assert.ok(!offered.some((look) => look.number === 5), 'look 5 left out');
  const handPicked = offered.find((look) => look.number === 3);
  const [name] = Object.keys(handPicked.values);
  const start = sceneDefaults(def, sceneById('mandelbulb_slice').defaults || null)[name];
  assert.notEqual(handPicked.values[name], start);
  assert.equal(session.renderer.values[name], start, 'the start look');
  assert.equal(session.looks.mandelbulb_slice, 3, 'the look picked by hand stays saved');
  session.destroy();
});
