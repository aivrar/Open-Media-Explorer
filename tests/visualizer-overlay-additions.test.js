import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HELD_OVERLAY_ROWS, OVERLAY_BLENDS, OVERLAY_BLEND_LABELS, OVERLAY_EXTRA_BLENDS, OVERLAY_EXTRA_BLENDS_RELEASED,
  OVERLAY_EXTRA_GLOW, OVERLAY_EXTRA_GLOW_RELEASED, OVERLAY_IDS, OVERLAY_LIVELY_BLENDS, OVERLAY_TOKEN, PLAIN_BLEND, extraGlowShare,
  overlayRow, parseOverlayToken,
} from '../src/visualizer/overlay-catalog.js';
import {
  HELD_OVERLAY_PATTERNS, OVERLAY_NEW_PATTERNS_RELEASED, OVERLAY_PATTERNS,
} from '../src/visualizer/overlay-patterns.js';
import {
  OVERLAY_BLEND_SRC, OVERLAY_MODE_INDEX, OVERLAY_MODE_STRENGTH, overlayBlendSource, overlayColourBlend,
} from '../src/visualizer/fx-chain.js';
import {
  OVERLAY_DRIFT_DEPTH, OVERLAY_DRIFT_PARAMS, OVERLAY_VALUE_DRIFT_RELEASED, overlayDriftPlan, overlayDriftScale,
} from '../src/visualizer/overlay-drift.js';
import { DRIFT_FAST_SHARE, DRIFT_PERIODS, DRIFT_SCALE_LOUD, applyDrift } from '../src/visualizer/drift.js';
import { MOOD_STRENGTH } from '../src/visualizer/mood.js';
import { createFlashGate, createOverlayLayer } from '../src/visualizer/overlay-layer.js';
import { Fake2D, FakeNodeEl } from './helpers/visualizer-fakes.js';
import { patternLight } from './helpers/overlay-light.js';

const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
let seed = 7;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const colour = () => [random(), random(), random()];

test('held: every addition is off, and what is offered and drawn is as before', () => {
  assert.equal(OVERLAY_EXTRA_BLENDS_RELEASED, false);
  assert.equal(OVERLAY_NEW_PATTERNS_RELEASED, false);
  assert.equal(OVERLAY_EXTRA_GLOW_RELEASED, false);
  assert.equal(OVERLAY_VALUE_DRIFT_RELEASED, false);
  assert.deepEqual(OVERLAY_BLENDS, ['add', 'screen', 'multiply', 'soft', 'difference']);
  assert.equal(OVERLAY_TOKEN, '[a-z][a-z0-9_]{0,23}(?:~[asmod]u?[bk]?t?n?)?');
  assert.equal(parseOverlayToken('petals~l'), null, 'a held mode is not read back');
  for (const id of Object.keys(HELD_OVERLAY_ROWS)) {
    assert.ok(!OVERLAY_IDS.includes(id), id);
    assert.equal(overlayRow(id), null);
    assert.ok(!(id in OVERLAY_PATTERNS));
  }
  assert.doesNotMatch(OVERLAY_BLEND_SRC, /colourBlend|u_mode > 4\.5/);
  assert.match(OVERLAY_BLEND_SRC, /\n {4}if \(u_mode > 3\.5\) b = abs\(s - c\);/);
  const index = readFileSync('src/visualizer/index.js', 'utf8');
  assert.match(index, /ovGlowField\.field\.hidden = !OVERLAY_EXTRA_GLOW_RELEASED;/);
  assert.match(index, /const extraGlowNow = \(\) => OVERLAY_EXTRA_GLOW_RELEASED && overlayGlowOn;/);
  assert.match(index, /if \(OVERLAY_VALUE_DRIFT_RELEASED\) overlayLayer\.drift\(driftState\.bars, overlayDepth\);/);
});

test('the new blend-ins: added after the others, nothing renumbered; calm (not lively); full strength', () => {
  assert.deepEqual(OVERLAY_EXTRA_BLENDS, ['lighten', 'colour']);
  assert.deepEqual(
    Object.entries(OVERLAY_MODE_INDEX),
    [['add', 0], ['screen', 1], ['multiply', 2], ['soft', 3], ['difference', 4], ['lighten', 5], ['colour', 6]],
  );
  assert.equal(OVERLAY_BLEND_LABELS.lighten, 'Lighten');
  assert.equal(OVERLAY_BLEND_LABELS.colour, 'Color');
  for (const mode of OVERLAY_EXTRA_BLENDS) {
    assert.equal(OVERLAY_LIVELY_BLENDS.has(mode), false);
    assert.equal(OVERLAY_MODE_STRENGTH[mode], 1);
  }
});

test('Lighten never adds more light than Screen; Colour keeps the scene\'s luma exactly, inside 0..1', () => {
  const screen = (s, c) => s.map((v, i) => 1 - (1 - v) * (1 - c[i]));
  const mix = (s, b, a) => s.map((v, i) => v + (b[i] - v) * a);
  for (let n = 0; n < 20000; n += 1) {
    const s = colour();
    const c = colour();
    const a = random();
    const lighten = s.map((v, i) => Math.max(v, c[i]));
    assert.ok(luma(mix(s, lighten, a)) <= luma(mix(s, screen(s, c), a)) + 1e-12);
    const col = overlayColourBlend(s, c);
    assert.ok(Math.abs(luma(col) - luma(s)) < 1e-9, `${s} ${c}`);
    for (const v of col) assert.ok(v >= -1e-9 && v <= 1 + 1e-9);
    assert.ok(Math.abs(luma(mix(s, col, a)) - luma(s)) < 1e-9);
  }
  // It does colour: a grey scene takes on a red overlay's hue.
  const red = overlayColourBlend([0.5, 0.5, 0.5], [1, 0, 0]);
  assert.ok(red[0] > red[1] + 0.1);
});

test('the shader takes the new modes only once released, the same steps as the CPU version', () => {
  const released = overlayBlendSource({ extraBlends: true });
  assert.equal(overlayBlendSource({ extraBlends: false }), OVERLAY_BLEND_SRC);
  assert.match(released, /vec3 colourBlend\(vec3 s, vec3 c\) \{\n {4}float y = luma\(s\);\n {4}vec3 d = c - vec3\(luma\(c\)\);/);
  assert.match(released, /return vec3\(y\) \+ d \* max\(k, 0\.0\);/);
  assert.match(released, / {4}if \(u_mode > 5\.5\) b = colourBlend\(s, c\);\n {4}else if \(u_mode > 4\.5\) b = max\(s, c\);\n {4}else if \(u_mode > 3\.5\) b = abs\(s - c\);/);
  // Only that changes.
  const strip = (src) => src.split('\n').filter((line) => !/colourBlend|u_mode > [345]\.5|float y = luma|vec3 d = c - |float k = 1|if \(d\.[rgb]|return vec3\(y\)|^\}$/.test(line));
  assert.deepEqual(strip(released), strip(OVERLAY_BLEND_SRC));
});

test('the new patterns follow our patterns\' rules: time-based, counts by quality, no shadow, nothing full-screen', () => {
  for (const [id, pattern] of Object.entries(HELD_OVERLAY_PATTERNS)) {
    const values = { size: 1, speed: 1 };
    const draws = {};
    for (const [fps, detail] of [[15, 1], [60, 1], [60, 0.5]]) {
      const ctx = new Fake2D(new FakeNodeEl('canvas'));
      const state = pattern.create();
      for (let frame = 0; frame <= fps * 2; frame += 1) {
        pattern.draw(ctx, state, {
          w: 1280, h: 720, ph: 720, time: frame / fps, dt: 1 / fps, values, sources: { bass: 0.5, mid: 0.5, kick: 0.5 }, trigger: () => ({ live: true, count: 0, age: 9 }), detail, hue: 0,
        });
        assert.equal(ctx.shadowBlur, 0);
      }
      assert.equal(ctx.count('fillRect'), 0, id);
      assert.equal(ctx.globalCompositeOperation, 'lighter');
      assert.ok(ctx.lineWidth <= 1, `${id}: lines up to a pixel`);
      draws[`${fps}/${detail}`] = { state: JSON.stringify(state), calls: ctx.total / (fps * 2 + 1) };
    }
    const a = JSON.parse(draws['15/1'].state);
    const b = JSON.parse(draws['60/1'].state);
    for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 0.05, `${id}.${key}`);
    assert.ok(draws['60/0.5'].calls <= draws['60/1'].calls, `${id}: fewer calls at Low`);
    const row = HELD_OVERLAY_ROWS[id];
    assert.equal(row.flash, 'steady');
    assert.equal(row.source, 'ours');
    assert.deepEqual(row.blends.filter((mode) => OVERLAY_LIVELY_BLENDS.has(mode)), [], `${id}: calm blends only`);
    assert.deepEqual(Object.keys(pattern.params).sort(), ['size', 'speed']);
  }
  const source = readFileSync('src/visualizer/overlay-patterns.js', 'utf8');
  const held = source.slice(source.indexOf('/* ---- Held: three more of ours'), source.indexOf('/** The held patterns'));
  assert.doesNotMatch(held, /Math\.random|trigger\(/, 'no randomness, nothing fired on hits');
});

test('the new patterns add less light than ours already do (the same estimate for all)', () => {
  const existing = {};
  for (const id of ['petals', 'ribbons', 'dot_spiral', 'contours', 'harmonograph']) existing[id] = patternLight(OVERLAY_PATTERNS[id], { size: 1, speed: 1 });
  // Starburst's gradient is sampled: fewer frames.
  existing.starburst = patternLight(OVERLAY_PATTERNS.starburst, { size: 1, speed: 1 }, { seconds: 10, fps: 1 });
  const most = Math.max(...Object.values(existing));
  assert.ok(most > 0.02, `the brightest of ours: ${most}`);
  for (const [id, pattern] of Object.entries(HELD_OVERLAY_PATTERNS)) {
    const light = patternLight(pattern, { size: 1, speed: 1 });
    assert.ok(light > 0.0003, `${id} draws something: ${light}`);
    // The cap used: 0.01 of the picture's mean luma, below the brightest of
    // ours (Starburst, about 0.03) and Petals, Ribbons and Contour Lines.
    assert.ok(light <= 0.01, `${id}: ${light}`);
    assert.ok(light < most);
  }
});

test('Extra glow: a share of the sheet\'s light, never more than all of it; none at Low', () => {
  assert.equal(OVERLAY_EXTRA_GLOW.low, null);
  for (const quality of ['medium', 'high']) {
    const share = extraGlowShare(OVERLAY_EXTRA_GLOW[quality]);
    assert.ok(share > 0 && share < 1, `${quality}: ${share}`);
  }
  assert.equal(extraGlowShare(null), 0);
});

function layerRig() {
  const top = new FakeNodeEl('canvas');
  top.width = 0;
  top.height = 0;
  const made = [];
  const gate = createFlashGate({ reactor: () => null, charge: () => true, sources: () => ({}) });
  const layer = createOverlayLayer({
    topCanvas: top,
    makeCanvas: () => { const canvas = new FakeNodeEl('canvas'); made.push(canvas); return canvas; },
    loadModule: async () => { throw new Error('not needed'); },
    gate,
  });
  return { top, made, layer };
}
const item = (id, values = {}) => ({ id, blend: { ...PLAIN_BLEND }, values });

test('Extra glow on the layer: off, nothing; on, one halo pass on a sheet without a line overlay, the sheet faded first', () => {
  const rig = layerRig();
  rig.layer.resize(1000, 500, 'high');
  rig.layer.set([item('petals')], { now: true });
  rig.layer.render(1, 0.03, {});
  assert.equal(rig.layer.stats.halos, 0);
  assert.equal(rig.made.length, 0);
  assert.equal(rig.layer.extraGlow, false);
  rig.layer.setExtraGlow(true);
  rig.layer.render(1.03, 0.03, {});
  assert.equal(rig.layer.stats.halos, 1);
  assert.equal(rig.made.length, 3);
  const top = rig.top.context2d;
  assert.equal(top.count('fillRect'), 1, 'the fade: one rectangle, destination-out');
  assert.equal(top.count('drawImage'), 2, 'the glow laid back twice');
  assert.equal(top.globalAlpha, OVERLAY_EXTRA_GLOW.high.near / 2);
  // Low: none.
  rig.layer.setQuality('low');
  rig.layer.render(1.06, 0.03, {});
  assert.equal(rig.layer.stats.halos, 1);
  // A line overlay's own halo stays as measured (no fade).
  rig.layer.setQuality('high');
  rig.layer.set([item('contours')], { now: true });
  const before = rig.top.context2d.count('fillRect');
  rig.layer.render(1.09, 0.03, {});
  assert.equal(rig.layer.stats.halos, 2);
  assert.equal(rig.top.context2d.count('fillRect'), before);
  rig.layer.destroy();
});

test('value drift: sizes and spreads only, inside the shuffle\'s range, small and slow', () => {
  for (const [id, names] of Object.entries(OVERLAY_DRIFT_PARAMS)) {
    for (const name of names) assert.doesNotMatch(name, /speed|rate|count|sync|opacity|intensity|color|style|thickness|glow/, `${id}.${name}`);
    const plan = overlayDriftPlan(id);
    assert.equal(plan.length, names.length, id);
    const row = overlayRow(id) || HELD_OVERLAY_ROWS[id];
    for (const wave of plan) {
      assert.deepEqual([wave.lo, wave.hi], row.ranges[wave.name].slice(0, 2));
      assert.ok(DRIFT_PERIODS.includes(wave.period));
    }
  }
  assert.deepEqual(overlayDriftPlan('lasers'), []);
  assert.equal(overlayDriftPlan('petals'), overlayDriftPlan('petals'), 'made once');
  assert.equal(overlayDriftScale(0), 0);
  // At the deepest scale, a wave moves at most OVERLAY_DRIFT_DEPTH of the span.
  const deepest = DRIFT_SCALE_LOUD * Math.max(...Object.values(MOOD_STRENGTH));
  const [wave] = overlayDriftPlan('sacred');
  const out = {};
  let far = 0;
  for (let bars = 0; bars < 32; bars += 0.05) {
    applyDrift({ sg_size: 0.6 }, [wave], bars, overlayDriftScale(deepest), out);
    far = Math.max(far, Math.abs(out.sg_size - 0.6));
    assert.ok(out.sg_size >= wave.lo && out.sg_size <= wave.hi);
  }
  const share = wave.period === DRIFT_PERIODS[0] ? DRIFT_FAST_SHARE : 1;
  assert.ok(far <= OVERLAY_DRIFT_DEPTH * share * deepest * wave.span + 1e-9, `${far}`);
  assert.ok(far > 0);
});

test('value drift on the layer: our pattern\'s values move around the chosen ones and come back at depth 0', () => {
  const rig = layerRig();
  rig.layer.resize(1000, 500, 'medium');
  rig.layer.set([item('petals', { size: 0.8, speed: 1 })], { now: true });
  const entry = rig.layer.top.patterns.get('petals');
  assert.deepEqual(entry.base, { size: 0.8, speed: 1 });
  const seen = new Set();
  for (let bars = 0; bars < 16; bars += 0.5) {
    rig.layer.drift(bars, 1);
    seen.add(entry.values.size.toFixed(4));
    assert.equal(entry.values.speed, 1, 'speed never drifts');
  }
  assert.ok(seen.size > 4, 'it moves');
  rig.layer.drift(3, 0);
  assert.deepEqual(entry.values, { size: 0.8, speed: 1 });
  rig.layer.destroy();
});
