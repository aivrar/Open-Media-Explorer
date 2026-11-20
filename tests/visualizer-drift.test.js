import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { normalizeVisualizerExtras } from '../src/lib/visualizer-settings.js';
import loadPostFx from '../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import {
  DRIFT_AVOID, DRIFT_BPM_RANGE, DRIFT_BPM_RETURN, DRIFT_DEPTH, DRIFT_FADE_S, DRIFT_FAST_SHARE, DRIFT_FX_MAX, DRIFT_PERIODS, DRIFT_SCALE_LOUD,
  DRIFT_SCALE_QUIET, DRIFT_SCENE_MAX, applyDrift, createDriftClock, driftScale, driftTempo, sceneDriftPlan, sceneDriftViolation,
} from '../src/visualizer/drift.js';
import { SWELL_DOWN_S, SWELL_UP_S, createSwell } from '../src/visualizer/swell.js';
import {
  IDLE_BPM, LINK_SOURCES, applyLinks, createReactorBridge, linkRuleViolation, usableLinks,
} from '../src/visualizer/reactor.js';
import { fxCatalog } from '../src/visualizer/fx-catalog.js';
import {
  FX_LINK_SOURCES, FX_LINK_SOURCES_SWELL, createFxShuffle, fxDriftFor, fxLinkViolation, fxRangeBounds,
} from '../src/visualizer/fx-shuffle.js';
import { createFxChain } from '../src/visualizer/fx-chain.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { MOOD_STRENGTH } from '../src/visualizer/mood.js';
import { SCENES, sceneCappedParams } from '../src/visualizer/scenes.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slow drift and swell: the drift clock, which params drift and how far,
   the swell as a link source, the effects' drift, and the tab's switch. No
   GPU; fake clocks. */

const CATALOG = fxCatalog(loadPostFx({}).PostFxLibrary);
const FX = new Map(CATALOG.map((fx) => [fx.id, fx]));

/** Every offered scene's definition, registered as the tab does. */
let defsCache = null;
async function sceneDefs() {
  if (defsCache) return defsCache;
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  defsCache = [];
  for (const entry of SCENES) defsCache.push({ entry, def: renderer.register(await entry.load(), entry.id) });
  return defsCache;
}

/* ---------------- The drift clock ---------------- */

test('the drift clock: the tempo integrated over drawn frames, 4 beats to a bar; a new tempo eases its pace, never jumps it; no time step, no move', () => {
  const clock = createDriftClock();
  for (let frame = 0; frame < 60; frame += 1) clock.step(1 / 30, 120);
  assert.ok(Math.abs(clock.bars - 1) < 1e-9, `120 BPM: a bar in 2 s (${clock.bars})`);
  // Idle (no tempo): IDLE_BPM.
  const idle = createDriftClock();
  for (let frame = 0; frame < 30; frame += 1) idle.step(1 / 30, 0);
  assert.ok(Math.abs(idle.bars - IDLE_BPM / 240) < 1e-9);
  // A new tempo: the pace eases, 95% of the way in about DRIFT_PACE_EASE_S;
  // each frame's move stays within the two paces.
  let before = clock.bars;
  let pace = clock.pace;
  for (let frame = 0; frame < 60; frame += 1) {
    clock.step(1 / 30, 144);
    const moved = clock.bars - before < 0 ? clock.bars - before + 32 : clock.bars - before;
    assert.ok(moved >= (120 / 240) / 30 - 1e-12 && moved <= (144 / 240) / 30 + 1e-12, `frame ${frame}: ${moved}`);
    assert.ok(clock.pace >= pace - 1e-12, 'the pace only rises toward the new tempo');
    pace = clock.pace;
    before = clock.bars;
  }
  assert.ok(Math.abs(clock.pace - 0.6) < 0.1 * 0.06, `nearly there after 2 s: ${clock.pace}`);
  // A pause or a redraw (no time step): nothing moves.
  const held = clock.bars;
  clock.step(0, 90);
  clock.step(Number.NaN, 90);
  assert.equal(clock.bars, held);
});

test('the drift clock never runs faster than at the top of its range: a faster tempo is followed at half (again until inside), a slower one at double, eased the same, never a jump', () => {
  const [lowest, highest] = DRIFT_BPM_RANGE;
  assert.equal(highest, 150);
  assert.equal(driftTempo(120), 120);
  assert.equal(driftTempo(150), 150);
  assert.equal(driftTempo(174), 87);
  assert.equal(driftTempo(320), 80);
  assert.equal(driftTempo(50), 100);
  assert.equal(driftTempo(lowest), lowest);
  assert.equal(driftTempo(0), IDLE_BPM);
  for (let bpm = 20; bpm <= 400; bpm += 0.5) assert.ok(driftTempo(bpm) >= lowest && driftTempo(bpm) <= highest, String(bpm));
  // 149 BPM to 152: the pace eases down to 76's, each frame between the two.
  const clock = createDriftClock();
  for (let frame = 0; frame < 200; frame += 1) clock.step(1 / 30, 149);
  let before = clock.bars;
  for (let frame = 0; frame < 300; frame += 1) {
    clock.step(1 / 30, 152);
    assert.ok(clock.pace <= highest / 240 + 1e-12);
    const moved = clock.bars - before < 0 ? clock.bars - before + 32 : clock.bars - before;
    assert.ok(moved <= (149 / 240) / 30 + 1e-12 && moved >= (76 / 240) / 30 - 1e-12, `frame ${frame}: ${moved}`);
    before = clock.bars;
  }
  assert.ok(Math.abs(clock.pace - 76 / 240) < 1e-3);
});

test('the drift clock keeps its octave while a tempo estimate hovers at an edge of its range, and comes back only well inside; never above the top', () => {
  const [lowest, highest] = DRIFT_BPM_RANGE;
  const [up, down] = DRIFT_BPM_RETURN;
  assert.ok(up > lowest && down < highest);
  // Hovering at 150: folded down once, then steady at half.
  const top = createDriftClock();
  for (let frame = 0; frame < 300; frame += 1) top.step(1 / 30, frame % 2 ? 150.1 : 150);
  let low = Infinity;
  let high = -Infinity;
  for (let frame = 0; frame < 300; frame += 1) {
    top.step(1 / 30, frame % 2 ? 150.1 : 150);
    assert.equal(top.fold, 0.5, `frame ${frame}`);
    low = Math.min(low, top.pace);
    high = Math.max(high, top.pace);
  }
  assert.ok(high - low < 0.06 / 240 && high <= 75.05 / 240 + 1e-9, `steady near 75: ${low * 240} to ${high * 240}`);
  // Back as heard only below DRIFT_BPM_RETURN's top.
  top.step(1 / 30, down + 1);
  assert.equal(top.fold, 0.5);
  top.step(1 / 30, down - 1);
  assert.equal(top.fold, 1);
  // Hovering at 60: folded up once, then steady at double; back above 66.
  const bottom = createDriftClock();
  for (let frame = 0; frame < 300; frame += 1) {
    bottom.step(1 / 30, frame % 2 ? 59.9 : 60);
    if (frame > 0) assert.equal(bottom.fold, 2, `frame ${frame}`);
  }
  bottom.step(1 / 30, up - 1);
  assert.equal(bottom.fold, 2);
  bottom.step(1 / 30, up + 1);
  assert.equal(bottom.fold, 1);
  // A wandering estimate: the tempo followed always inside the range.
  const wander = createDriftClock();
  const random = seededRandom(7);
  for (let frame = 0; frame < 5000; frame += 1) {
    const bpm = 30 + random() * 370;
    wander.step(1 / 30, bpm);
    const followed = bpm * wander.fold;
    assert.ok(followed >= lowest - 1e-9 && followed <= highest + 1e-9, `${bpm} at ${wander.fold}`);
    assert.ok(wander.pace <= highest / 240 + 1e-12);
  }
});

test('the drift clock wraps at 32 bars, where every wave period ends, so the waves go on without a jump', () => {
  const clock = createDriftClock();
  let last = null;
  for (let frame = 0; frame < 30 * 70; frame += 1) {
    clock.step(1 / 30, 120);
    assert.ok(clock.bars >= 0 && clock.bars < 32);
    const waves = DRIFT_PERIODS.map((period) => Math.sin(2 * Math.PI * (clock.bars / period + 0.3)));
    if (last) {
      // A wave moves by at most 2 pi x pace / period a second.
      waves.forEach((value, index) => assert.ok(Math.abs(value - last[index]) <= (2 * Math.PI * 0.5) / DRIFT_PERIODS[index] / 30 + 1e-9));
    }
    last = waves;
  }
});

/* ---------------- Which params, how far ---------------- */

test('scene drift: up to three params per scene, each passing the link rule and a plain float, never the beat reaction, a camera, a hue, a power or a detail setting; every visit the same waves, offsets too, each on its own period, the fastest at half depth', async () => {
  const offsets = new Set();
  for (const { entry, def } of await sceneDefs()) {
    const plan = sceneDriftPlan(def, { override: entry.drift, capped: sceneCappedParams(entry.id) });
    const again = sceneDriftPlan(def, { override: entry.drift, capped: sceneCappedParams(entry.id) });
    assert.ok(plan.length <= DRIFT_SCENE_MAX, entry.id);
    assert.deepEqual(again, plan, `${entry.id}: the same waves each visit`);
    for (const item of plan) {
      offsets.add(item.offset);
      const own = entry.drift?.params?.[item.name];
      const depth = Number.isFinite(own) ? own : (Number.isFinite(entry.drift?.depth) ? entry.drift.depth : DRIFT_DEPTH);
      assert.equal(item.depth, item.period === 4 ? depth * DRIFT_FAST_SHARE : depth, `${entry.id}.${item.name}`);
      assert.ok(!/(^|_)power(_|$)/.test(item.name), `${entry.id}: no power`);
    }
    assert.equal(new Set(plan.map((item) => item.period)).size, plan.length, `${entry.id}: periods differ`);
    const params = new Map(def.params.map((param) => [param.name, param]));
    for (const item of plan) {
      const param = params.get(item.name);
      assert.equal(linkRuleViolation(def, param), null, `${entry.id}.${item.name}`);
      assert.ok(DRIFT_PERIODS.includes(item.period));
      assert.ok(item.offset >= 0 && item.offset < 1);
      assert.equal(item.span, Number(param.max) - Number(param.min));
      if (!entry.drift?.params) {
        assert.equal(sceneDriftViolation(def, param, sceneCappedParams(entry.id)), null, `${entry.id}.${item.name}`);
        assert.ok(!param.type || param.type === 'float');
        assert.ok(!DRIFT_AVOID.test(item.name));
      }
    }
    if (entry.drift === false) assert.deepEqual(plan, [], `${entry.id}: drift off`);
  }
  assert.ok(offsets.size > 20, 'offsets differ between params');
  // The rule's own refusals.
  const def = { name: 'x', shader: '', params: [
    { name: 'audio_react', min: 0, max: 2 }, { name: 'altitude', min: 0, max: 2 }, { name: 'hue_shift', min: 0, max: 1 },
    { name: 'detail_level', min: 0, max: 1 }, { name: 'count', type: 'int', min: 1, max: 9 }, { name: 'glow', min: 0, max: 1 },
    { name: 'twist', min: 0, max: 3 }, { name: 'power', min: 2, max: 12 }, { name: 'exponent', min: 1, max: 4 },
  ] };
  assert.deepEqual(sceneDriftPlan(def).map((item) => item.name), ['twist']);
  assert.match(sceneDriftViolation(def, def.params[4]), /float/);
  assert.equal(sceneDriftViolation(def, def.params[6], ['twist']), 'a detail setting');
});

test('scene drift overrides: off, params left out, a depth of its own, or a curated list (an int too) that must still pass the link rule', () => {
  const def = { name: 'y', shader: '', params: [
    { name: 'a', min: 0, max: 1 }, { name: 'b', min: 0, max: 1 }, { name: 'c', min: 0, max: 1 }, { name: 'd', min: 0, max: 1 },
    { name: 'tiles', type: 'int', min: 2, max: 20 }, { name: 'brightness', min: 0, max: 1 },
  ] };
  assert.deepEqual(sceneDriftPlan(def, { override: false }), []);
  const auto = sceneDriftPlan(def).map((item) => item.name);
  assert.equal(auto.length, 3);
  assert.ok(!sceneDriftPlan(def, { override: { exclude: [auto[0]] } }).some((item) => item.name === auto[0]));
  assert.ok(sceneDriftPlan(def, { override: { depth: 0.04 } }).every((item) => item.depth === (item.period === 4 ? 0.02 : 0.04)));
  const curated = sceneDriftPlan(def, { override: { params: { tiles: 0.05, brightness: 0.1, b: true } } });
  assert.deepEqual(curated.map((item) => [item.name, item.depth / (item.period === 4 ? DRIFT_FAST_SHARE : 1)]), [['tiles', 0.05], ['b', DRIFT_DEPTH]], 'light refused, an int allowed');
});

test('applyDrift: base + depth x scale x span x wave, inside the range; a base outside it brought in first, so a link on top clamps to the same bounds without a step; scale 0 leaves the base as it is; into the given object', () => {
  const plan = [{ name: 'a', lo: 0, hi: 10, span: 10, depth: 0.1, period: 4, offset: 0.25 }];
  const out = {};
  const base = { a: 5, other: 7 };
  // At bars 0 the wave is sin(pi / 2) = 1.
  assert.equal(applyDrift(base, plan, 0, 1, out), out);
  assert.ok(Math.abs(out.a - 6) < 1e-12);
  assert.equal(out.other, 7);
  applyDrift(base, plan, 2, 1.5, out);
  assert.ok(Math.abs(out.a - 3.5) < 1e-12, 'half a period on: the other way');
  assert.equal(applyDrift({ a: 9.8 }, plan, 0, 1, out).a, 10, 'held at the top');
  assert.equal(applyDrift({ a: 12 }, plan, 0, 1, out).a, 10, 'a base above the range: from the top of it');
  assert.ok(Math.abs(applyDrift({ a: 12 }, plan, 2, 1, out).a - 9) < 1e-12, '...and down from there');
  assert.ok(Math.abs(applyDrift({ a: -4 }, plan, 2, 1, out).a) < 1e-12, 'a base below: held at the bottom');
  assert.deepEqual(applyDrift({ a: 12 }, plan, 1.3, 0, {}), { a: 12 }, 'scale 0: as given');
  assert.deepEqual(applyDrift(base, plan, 1.3, 0, {}), base);
  // Links push on top of the drifted base, clamped to the same range.
  const links = usableLinks({ params: [{ name: 'a', min: 0, max: 10 }] }, [{ param: 'a', source: 'kick', amount: 0.2 }]);
  const drifted = applyDrift(base, plan, 0, 1, {});
  assert.ok(Math.abs(applyLinks(drifted, links, { kick: 0.5 }, {}).a - 7) < 1e-12);
  // A base outside the range, the wave near its trough: the smallest hit
  // moves the value by the hit alone, not into the range at once.
  const low = applyDrift({ a: 12 }, plan, 2, 0.2, {});
  const quiet = applyLinks(low, links, { kick: 0 }, {}).a;
  const hit = applyLinks(low, links, { kick: 0.01 }, {}).a;
  assert.ok(Math.abs(hit - quiet) <= 0.2 * 0.01 * 10 + 1e-12, `${quiet} -> ${hit}`);
});

test('the depth scale: about 0.6 in a quiet passage or silence, about 1.4 in a loud one, times the mood\'s reaction strength', () => {
  assert.equal(driftScale(0), DRIFT_SCALE_QUIET);
  assert.equal(driftScale(1), DRIFT_SCALE_LOUD);
  assert.ok(driftScale(0.5) > DRIFT_SCALE_QUIET && driftScale(0.5) < DRIFT_SCALE_LOUD);
  assert.ok(Math.abs(driftScale(1, MOOD_STRENGTH.energetic) - DRIFT_SCALE_LOUD * MOOD_STRENGTH.energetic) < 1e-12);
  assert.ok(Math.abs(driftScale(0, MOOD_STRENGTH.calm) - DRIFT_SCALE_QUIET * MOOD_STRENGTH.calm) < 1e-12);
});

/* ---------------- The swell ---------------- */

test('the swell: the limiter\'s output level and bass low-passed, about 2 s up and 3 s down; never faster than that; silence lets it fall', () => {
  const swell = createSwell();
  const dt = 1 / 60;
  for (let step = 0; step < SWELL_UP_S * 60; step += 1) swell.step(dt, { level: 1, bass: 0.5 });
  assert.ok(Math.abs(swell.level - (1 - Math.exp(-1))) < 0.01, `one time constant up: ${swell.level}`);
  assert.ok(Math.abs(swell.bass - 0.5 * (1 - Math.exp(-1))) < 0.01);
  const top = swell.level;
  for (let step = 0; step < SWELL_DOWN_S * 60; step += 1) swell.step(dt, { level: 0, bass: 0 });
  assert.ok(Math.abs(swell.level - top * Math.exp(-1)) < 0.01, `one time constant down: ${swell.level}`);
  // Hits every half second (the limiter's level jumping 0 <-> 1): the swell
  // moves by at most dt / SWELL_UP_S a step.
  const beat = createSwell();
  let last = 0;
  for (let step = 0; step < 600; step += 1) {
    beat.step(dt, { level: step % 30 < 6 ? 1 : 0, bass: 0 });
    assert.ok(Math.abs(beat.level - last) <= dt / SWELL_UP_S + 1e-12);
    last = beat.level;
  }
  beat.step(0, { level: 1 });
  assert.equal(beat.level, last, 'no time step, no move');
});

test('swell and bassSwell are link sources: a scene link may read them', () => {
  assert.ok(LINK_SOURCES.has('swell') && LINK_SOURCES.has('bassSwell'));
  const def = { params: [{ name: 'size', min: 0, max: 1 }] };
  assert.equal(usableLinks(def, [{ param: 'size', source: 'bassSwell', amount: 0.1 }]).length, 1);
  assert.equal(usableLinks(def, [{ param: 'size', source: 'wobble', amount: 0.1 }]).length, 0);
});

test('effect links breathe with the swell only while slow drift is on: size and detail params may take it, a punch keeps its hits', () => {
  assert.deepEqual(FX_LINK_SOURCES_SWELL.punch, FX_LINK_SOURCES.punch);
  for (const kind of ['size', 'detail']) assert.ok(FX_LINK_SOURCES_SWELL[kind].some(([source]) => source === 'swell' || source === 'bassSwell'), kind);
  const ids = ['swirl', 'grain', 'chromatic', 'vhs', 'sharpen', 'holo_foil', 'tilt_shift', 'crt'];
  const sources = (on) => {
    const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(4) });
    shuffle.setSwellLinks(on);
    const seen = new Map();
    for (let roll = 0; roll < 300; roll += 1) {
      const pick = ids.filter((id, index) => (roll >> (index % 4)) % 2 === index % 2).slice(0, 2);
      for (const link of shuffle.build(pick.length ? pick : ['swirl'], 'strong').links) {
        const kind = FX.get(link.fx).links[link.param];
        if (!seen.has(kind)) seen.set(kind, new Set());
        seen.get(kind).add(link.source);
      }
    }
    return seen;
  };
  const off = sources(false);
  for (const set of off.values()) assert.ok(![...set].some((source) => /swell/i.test(source)), 'off: never the swell');
  const on = sources(true);
  assert.ok([...on.get('size')].some((source) => /swell/i.test(source)), 'on: a size may breathe');
  assert.ok(![...on.get('punch')].some((source) => /swell/i.test(source)), 'a punch keeps its hits');
});

/* ---------------- Effects ---------------- */

test('effect drift: only params marked linkable that the link rule allows, at most two, inside the range the shuffle draws from, links and all; a pass kept on keeps its waves', () => {
  for (const fx of CATALOG) {
    const plan = fxDriftFor(fx);
    assert.ok(plan.length <= DRIFT_FX_MAX, fx.id);
    assert.deepEqual(fxDriftFor(fx), plan, `${fx.id}: the same waves each time`);
    for (const item of plan) {
      assert.ok(fx.links[item.name], `${fx.id}.${item.name} marked`);
      assert.equal(fxLinkViolation(fx, item.name), null);
      assert.deepEqual([item.lo, item.hi], fxRangeBounds(fx, item.name));
    }
  }
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2' });
  const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(6) });
  const passes = (ids) => shuffle.build(ids, 'strong').fx.map((item) => ({ ...item, fx: FX.get(item.id) }));
  chain.setPasses(passes(['swirl']));
  const [swirl] = chain.passes;
  assert.deepEqual(swirl.drift.map((item) => item.name), ['strength']);
  const [lo, hi] = fxRangeBounds(FX.get('swirl'), 'strength');
  const drift = { bars: 0, scale: driftScale(1, MOOD_STRENGTH.energetic) };
  let time = 1;
  const seen = [];
  for (let frame = 0; frame < 32 * 15; frame += 1) {
    drift.bars = (frame / 15) % 32;
    chain.begin(320, 180);
    chain.finish({ time: (time += 1 / 30), dt: 1 / 30, beat: { clock: 0 }, sources: { bass: 1, level: 1, swell: 1, bassSwell: 1 }, drift });
    const value = gl.uniforms.get('u_strength')[0];
    assert.ok(value >= lo - 1e-9 && value <= hi + 1e-9, `${value} inside ${lo}..${hi}`);
    seen.push(value);
  }
  assert.ok(Math.max(...seen) - Math.min(...seen) > 0.05 * (hi - lo), 'it moves');
  // Another effect joins: Swirl keeps its waves.
  chain.setPasses([...passes(['grain']), { ...swirl }]);
  assert.equal(chain.passes.find((pass) => pass.id === 'swirl').drift, swirl.drift);
});

/* ---------------- The renderer ---------------- */

test('the renderer drifts the scene\'s planned params first and pushes its links on top; at scale 0 it draws the values as they are', async () => {
  const { entry, def } = (await sceneDefs()).find((row) => row.entry.id === 'starfield');
  const gl = new FakeGL();
  let asked = 0;
  const renderer = createSceneRenderer({
    canvas: { width: 64, height: 36 }, gl, mode: 'webgl2', driftFor: (given) => { asked += 1; return sceneDriftPlan(given); },
  });
  renderer.register(await entry.load(), entry.id);
  const links = usableLinks(def, entry.links, { allowInt: true });
  renderer.useSceneNow(def, links, entry.defaults);
  assert.equal(asked, 1, 'asked once, when installed');
  const plan = renderer.drift;
  assert.ok(plan.length > 0);
  const base = renderer.values;
  const sources = { kick: 0.4, bass: 0.3 };
  for (const bars of [0, 3.3, 11.7, 25]) {
    const drift = { bars, scale: 1.2 };
    renderer.draw({ time: 1, audio: {}, beat: {}, sources, drift, zoom: 1 });
    const expected = applyLinks(applyDrift(base, plan, bars, 1.2, {}), links, sources, {});
    for (const name of new Set([...plan.map((item) => item.name), ...links.map((link) => link.param)])) {
      assert.ok(Math.abs(gl.uniforms.get(`u_${name}`)[0] - expected[name]) < 1e-5, `${name} at bar ${bars}`);
    }
  }
  renderer.draw({ time: 1, audio: {}, beat: {}, sources, drift: { bars: 7, scale: 0 }, zoom: 1 });
  const still = applyLinks(base, links, sources, {});
  for (const item of plan) assert.ok(Math.abs(gl.uniforms.get(`u_${item.name}`)[0] - still[item.name]) < 1e-6, `${item.name} as it is`);
});

/* ---------------- The tab ---------------- */

const LAYOUT = { width: 1280, height: 720 };
async function mount(settings = {}, { reduced = false, random = seededRandom(3) } = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false, isPlaying() { return this.playing; }, isAudible: () => true, getAnalyser() { return this.playing ? node : null; }, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  const saved = [];
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win: fakeResizeObserverWin(fakeMotion(reduced)),
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random,
  });
  for (let round = 0; round < 200 && !session.switcher.current; round += 1) { await settle(() => session.switcher.current, 20); h.run(30); }
  assert.ok(session.switcher.current, 'first scene');
  // Each draw: what the renderer was given and drew, worked out again.
  const draws = [];
  const draw = session.renderer.draw;
  session.renderer.draw = (state, target) => {
    const done = draw(state, target);
    const base = session.renderer.values;
    const plan = session.renderer.drift;
    const drifted = state.drift && state.drift.scale > 0 ? applyDrift(base, plan, state.drift.bars, state.drift.scale, {}) : base;
    const expected = applyLinks(drifted, session.renderer.links, state.sources, {});
    draws.push({
      scale: state.drift?.scale ?? 0,
      bars: state.drift?.bars ?? 0,
      time: state.time,
      still: state.still,
      swell: state.sources ? [state.sources.swell, state.sources.bassSwell] : null,
      drawn: Object.fromEntries(plan.map((item) => [item.name, gl.uniforms.get(`u_${item.name}`)?.[0]])),
      plain: Object.fromEntries(plan.map((item) => [item.name, applyLinks(base, session.renderer.links, state.sources, {})[item.name]])),
      expected: Object.fromEntries(plan.map((item) => [item.name, expected[item.name]])),
    });
    return done;
  };
  return {
    h, vis, gl, saved, session, draws, source, signal,
    play(ms) { h.run(ms, 1000 / 30); },
    start() { source.playing = true; signal.refresh(); },
  };
}
const change = (node, value) => { node.checked = value; node.dispatchEvent(new Event('change')); };

test('in the tab, slow drift is on by default: the scene\'s params wander around their base as planned, the clock moving only while frames are drawn', async () => {
  assert.equal(normalizeVisualizerExtras({}).visualizerDrift, true);
  assert.equal(normalizeVisualizerExtras({ visualizerDrift: false }).visualizerDrift, false);
  const m = await mount();
  const { session } = m;
  assert.equal(session.controls.drift.checked, true);
  assert.ok(session.renderer.drift.length > 0, 'Plasma has params that drift');
  m.start();
  m.play(6000);
  const live = m.draws.filter((row) => row.scale > 0);
  assert.ok(live.length > 100);
  for (const row of live) {
    for (const [name, value] of Object.entries(row.drawn)) assert.ok(Math.abs(value - row.expected[name]) < 1e-5, `${name}: drawn as planned`);
  }
  const name = session.renderer.drift[0].name;
  const values = live.map((row) => row.drawn[name]);
  assert.ok(Math.max(...values) - Math.min(...values) > 0.01, `${name} moves`);
  // Hidden: nothing drawn, the clock holds; shown again: it carries on.
  const bars = session.drift.clock.bars;
  m.vis.setVisible(false);
  m.play(3000);
  assert.equal(session.drift.clock.bars, bars, 'not moved while hidden');
  m.vis.setVisible(true);
  m.play(500);
  const after = session.drift.clock.bars;
  assert.ok(after > bars && after - bars < 0.5, `carried on from where it was: ${bars} -> ${after}`);
  session.destroy();
});

test('in the tab, "Slow drift" off fades it out over about 2 s, saved; from then on every value is drawn exactly as without drift; on again, it fades in', async () => {
  const m = await mount();
  const { session } = m;
  m.start();
  m.play(3000);
  const full = m.draws.at(-1).swell;
  assert.ok(full[0] > 0.05, `links read the swell while drift is on: ${full}`);
  change(session.controls.drift, false);
  assert.deepEqual(m.saved.at(-1), { visualizerDrift: false });
  m.play(1000);
  assert.ok(session.drift.fade > 0.3 && session.drift.fade < 0.7, `fading out: ${session.drift.fade}`);
  const half = m.draws.at(-1).swell;
  assert.ok(half[0] > 0 && half[0] < session.bridge.swell.level, `links get the swell as far as drift is faded in: ${half}`);
  m.play(DRIFT_FADE_S * 1000);
  assert.equal(session.drift.fade, 0);
  const from = m.draws.length;
  m.play(4000);
  const rows = m.draws.slice(from);
  assert.ok(rows.length > 50);
  for (const row of rows) {
    assert.equal(row.scale, 0);
    assert.deepEqual(row.swell, [0, 0], 'off: links read no swell at all');
    for (const [name, value] of Object.entries(row.drawn)) assert.ok(Math.abs(value - row.plain[name]) < 1e-6, `${name}: as without drift`);
  }
  assert.ok(session.bridge.swell.level > 0.05, 'the swell itself goes on (for when drift comes back)');
  // Off from the start: never drifted at all, no swell for links.
  const off = await mount({ visualizerDrift: false });
  assert.equal(off.session.controls.drift.checked, false);
  off.start();
  off.play(3000);
  assert.ok(off.draws.length > 30 && off.draws.every((row) => row.scale === 0));
  assert.ok(off.draws.every((row) => !row.swell || (row.swell[0] === 0 && row.swell[1] === 0)));
  // On again: it fades in, no jump.
  change(off.session.controls.drift, true);
  off.play(1000);
  assert.ok(off.session.drift.fade > 0.3 && off.session.drift.fade < 0.7, `fading in: ${off.session.drift.fade}`);
  const scales = off.draws.slice(-25).map((row) => row.scale);
  for (let index = 1; index < scales.length; index += 1) assert.ok(scales[index] >= scales[index - 1] - 0.05, 'rising smoothly');
  m.session.destroy();
  off.session.destroy();
});

test('the bridge gives links the swell only as far as slow drift is faded in: none at all at 0, at once', () => {
  const bridge = createReactorBridge();
  for (let step = 0; step < 240; step += 1) bridge.swell.step(1 / 60, { level: 1, bass: 1 });
  assert.equal(bridge.swellShare, 0, 'none until drift says so');
  bridge.setSwellShare(1);
  const state = { audio: {}, beat: {} };
  bridge.react(state, null, 1, 1 / 60);
  assert.ok(state.sources.swell > 0.5 && state.sources.swell === bridge.swell.level);
  bridge.setSwellShare(0.5);
  assert.ok(Math.abs(state.sources.swell - bridge.swell.level / 2) < 1e-12, 'the values already given too');
  bridge.setSwellShare(0);
  assert.equal(state.sources.swell, 0);
  assert.equal(state.sources.bassSwell, 0);
  bridge.react(state, null, 1.02, 1 / 60);
  assert.equal(state.sources.swell, 0);
  assert.ok(bridge.swell.level > 0.5, 'the swell itself goes on');
});

test('slow drift draws no random numbers: the tab\'s other choices come out the same with it on or off', async () => {
  const counted = async (on) => {
    const inner = seededRandom(11);
    let calls = 0;
    const m = await mount({ visualizerDrift: on, visualizerFx: true }, { random: () => { calls += 1; return inner(); } });
    m.start();
    m.play(20000);
    const names = m.session.fx?.chain?.passes?.map((pass) => pass.id) ?? [];
    m.session.destroy();
    return { calls, names, scene: m.session.switcher.current };
  };
  const on = await counted(true);
  const off = await counted(false);
  assert.ok(on.calls > 0);
  assert.equal(on.calls, off.calls);
  assert.deepEqual(on.names, off.names);
  // The plans alone: no random at all, from Math.random either.
  const random = Math.random;
  const defs = await sceneDefs();
  let used = 0;
  let planning = -1;
  let passing = -1;
  Math.random = () => { used += 1; return random(); };
  try {
    for (const { entry, def } of defs) sceneDriftPlan(def, { override: entry.drift });
    for (const fx of CATALOG) fxDriftFor(fx);
    planning = used;
    const chain = createFxChain({ gl: new FakeGL(), mode: 'webgl2' });
    const shuffle = createFxShuffle({ catalog: CATALOG, random: seededRandom(2) });
    const passes = shuffle.build(['swirl', 'grain'], 'normal').fx.map((item) => ({ ...item, fx: FX.get(item.id) }));
    // Counted from here: the chain and the shuffle are made with their own.
    used = 0;
    chain.setPasses(passes);
    passing = used;
  } finally {
    Math.random = random;
  }
  assert.equal(planning, 0, 'the scene and effect plans');
  assert.equal(passing, 0, 'the chain planning its passes\' drift');
});

test('a still picture (reduced motion) is drawn again at once when slow drift is switched, with the new setting', async () => {
  const m = await mount({}, { reduced: true });
  const { session } = m;
  m.start();
  m.play(1000);
  assert.equal(m.draws.length, 0, 'the still picture is drawn and then held');
  change(session.controls.drift, false);
  assert.equal(m.draws.length, 1, 'drawn again at once');
  const off = m.draws[0];
  assert.ok(off.still);
  assert.equal(off.scale, 0, 'without drift at once, no fade on a still picture');
  for (const [name, value] of Object.entries(off.drawn)) assert.ok(Math.abs(value - off.plain[name]) < 1e-6, `${name}: as without drift`);
  change(session.controls.drift, true);
  assert.equal(m.draws.length, 2, 'drawn again at once');
  const on = m.draws[1];
  assert.equal(on.time, off.time, 'time did not move');
  assert.ok(on.scale > 0, `with drift at once: ${on.scale}`);
  for (const [name, value] of Object.entries(on.drawn)) assert.ok(Math.abs(value - on.expected[name]) < 1e-5, `${name}: drifted as planned`);
  assert.ok(Object.keys(on.drawn).some((name) => Math.abs(on.drawn[name] - off.drawn[name]) > 1e-4), 'the picture changed');
  session.destroy();
});
