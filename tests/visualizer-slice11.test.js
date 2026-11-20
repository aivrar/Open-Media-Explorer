import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STROBE_TINT_FLOOR, OVERLAY_EXCLUDED, OVERLAY_COST_BUDGET, PLAIN_BLEND, overlayRow, overlaysDrawnFor, overlaysMove, OVERLAY_TABLE,
} from '../src/visualizer/overlay-catalog.js';
import {
  OVERLAY_PATTERNS, STROBE_FALL_S, STROBE_HUES, STROBE_LIGHT, STROBE_PEAK, STROBE_RISE_S, patternValues, strobeColor, strobeLevel,
} from '../src/visualizer/overlay-patterns.js';
import { createOverlayShuffle, overlayModesFor } from '../src/visualizer/overlay-shuffle.js';
import { createFlashGate, createOverlayLayer } from '../src/visualizer/overlay-layer.js';
import {
  OVERLAY_MOTION_MOST, OVERLAY_MOTION_PERIODS, OVERLAY_MOTION_QUANTUM, OVERLAY_TURN_DEG, coverScale, motionCss, motionUv, overlayMotion, quantiseMotion, sheetPoint,
} from '../src/visualizer/overlay-motion.js';
import { OVERLAY_BLEND_SRC, createFxChain, overlayTint } from '../src/visualizer/fx-chain.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { MOODS } from '../src/visualizer/mood.js';
import { DRIFT_CHECK_SCALE } from './helpers/visualizer-flash-check.mjs';
import { FakeGL, FakeNodeEl } from './helpers/visualizer-fakes.js';

/* Slice 11 of the visualizer: the overlay sheets turn, breathe and sway with
   slow drift (the sheet moves, not its drawing; anchored overlays hold it
   still), and our Strobe: a soft coloured pulse on a hit, through the flash
   gate, picked by the shuffle only while the music is energetic. */

const calm = SCENES.find((scene) => scene.fxCalm && !scene.fxNone);
const lively = SCENES.find((scene) => !scene.fxCalm && !scene.fxNone);
const item = (id, blend = PLAIN_BLEND, values = {}) => ({ id, blend: { ...PLAIN_BLEND, ...blend }, values });

/* ---------------- Strobe: catalog, shuffle, calm rule ---------------- */

test('Strobe in the catalog: ours, a trigger overlay (through the gate), light, energetic only, plain on calm scenes; the Psychedelia Strobe stays out', () => {
  const row = overlayRow('color_strobe');
  assert.ok(row && OVERLAY_PATTERNS.color_strobe, 'listed, and one of our patterns');
  assert.equal(row.source, 'ours');
  assert.equal(row.flash, 'trigger');
  assert.equal(row.cost, 'light');
  assert.equal(row.category, 'Light show');
  assert.deepEqual([...row.moods], ['energetic']);
  assert.ok(row.moods.every((mood) => MOODS.includes(mood)));
  assert.ok(row.shuffle);
  assert.ok(OVERLAY_EXCLUDED.strobe && !OVERLAY_TABLE.strobe, 'Psychedelia\'s full-screen Strobe is not offered');
  // Fire on kick, snare, beat or bar.
  assert.deepEqual([...row.ranges.sync.pick].sort(), [1, 2, 4, 5]);
  // The calm rule: plain only on a calm scene, blended elsewhere as allowed.
  assert.deepEqual(overlayModesFor('color_strobe', calm), ['add']);
  assert.ok(overlayModesFor('color_strobe', lively).length > 1);
  const asked = item('color_strobe', { mode: 'screen', under: true, tint: true });
  assert.deepEqual(overlaysDrawnFor(calm, [asked])[0].blend, PLAIN_BLEND, 'drawn plain on a calm scene');
  assert.equal(overlaysDrawnFor(lively, [asked])[0].blend.mode, 'screen', 'blended where the scene allows it');
  // Another overlay keeps its calm blend (the rule is the Strobe's own).
  assert.equal(overlaysDrawnFor(calm, [item('rings', { mode: 'screen' })])[0].blend.mode, 'screen');
});

test('the overlay shuffle\'s mood filter: the Strobe only while the mood is energetic; others in any mood', () => {
  const picks = (mood) => {
    const shuffle = createOverlayShuffle({ random: seededRandom(11) });
    const seen = new Set();
    for (let roll = 0; roll < 400; roll += 1) {
      const combo = shuffle.next({
        maxCount: 3, costBudget: OVERLAY_COST_BUDGET.high, costMax: 'heavy', entry: lively, blendIns: true, bend: true, mood,
      });
      shuffle.shown(combo);
      for (const id of combo.ids) seen.add(id);
    }
    return seen;
  };
  assert.ok(picks('energetic').has('color_strobe'), 'picked when energetic');
  for (const mood of ['calm', 'steady', undefined]) {
    const seen = picks(mood);
    assert.ok(!seen.has('color_strobe'), `never when ${mood}`);
    assert.ok(seen.has('rings'), 'others still picked');
  }
  // By hand, any mood: what is drawn does not ask the mood.
  assert.equal(overlaysDrawnFor(lively, [item('color_strobe')]).length, 1);
});

/* ---------------- Strobe: envelope, colour, gate ---------------- */

test('the Strobe\'s pulse: rises over at least 3 frames at 30 a second, falls over 300 to 400 ms, never jumps on a hit during a pulse', () => {
  assert.ok(STROBE_RISE_S >= 3 / 30, 'rise of at least 100 ms');
  assert.ok(STROBE_FALL_S >= 0.3 && STROBE_FALL_S <= 0.4);
  assert.equal(strobeLevel(0), 0);
  assert.equal(strobeLevel(STROBE_RISE_S), 1);
  assert.equal(strobeLevel(STROBE_RISE_S + STROBE_FALL_S), 0);
  // No frame (at 60 a second, from anywhere) steps by more than its share.
  const most = (1 / 60) / STROBE_RISE_S + 1e-9;
  for (let t = 0; t < 0.6; t += 1 / 600) {
    assert.ok(Math.abs(strobeLevel(t + 1 / 60) - strobeLevel(t)) <= most, `at ${t.toFixed(3)} s`);
  }
  // A hit mid-pulse rises from where the light is.
  const mid = strobeLevel(STROBE_RISE_S + 0.1);
  assert.ok(Math.abs(strobeLevel(0, mid) - mid) < 1e-12);
});

test('the Strobe\'s colours: never white, at most STROBE_PEAK strong', () => {
  assert.ok(STROBE_PEAK <= 0.45);
  assert.ok(STROBE_LIGHT < 70, 'a colour, not white');
  for (let index = 0; index < STROBE_HUES.length; index += 1) {
    for (const other of [false, true]) {
      const text = strobeColor(index, 5, other);
      const [, , sat, light, alpha] = text.match(/^hsla\((\d+),(\d+)%,(\d+)%,([\d.]+)\)$/).map(Number);
      assert.ok(sat >= 60 && light === STROBE_LIGHT, text);
      assert.ok(alpha <= STROBE_PEAK, `${text}: capped`);
    }
  }
});

/** A 2D context that keeps its fills' gradients and their stops. */
function recordingCtx() {
  const fills = [];
  const gradient = (kind, args) => {
    const g = { kind, args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } };
    return g;
  };
  return {
    fills,
    globalCompositeOperation: 'source-over',
    fillStyle: null,
    shadowBlur: 0,
    createRadialGradient: (...args) => gradient('radial', args),
    createLinearGradient: (...args) => gradient('linear', args),
    fillRect(...rect) { fills.push({ style: this.fillStyle, rect, op: this.globalCompositeOperation }); },
    getImageData() { throw new Error('no per-pixel work'); },
  };
}

test('the Strobe draws only on hits the gate lets through: one soft gradient fill a frame while a pulse shows, every style, its strength following the envelope', () => {
  for (const style of [0, 1, 2, 3]) {
    const counts = { kick: 0 };
    let room = true;
    const reactor = { getClock: () => 0, getTrigger: (type) => ({ live: true, count: counts[type] ?? 0, age: 0 }), getAnalysis: () => null };
    const gate = createFlashGate({ reactor: () => reactor, charge: () => room, sources: () => ({}) });
    const pattern = OVERLAY_PATTERNS.color_strobe;
    const st = pattern.create();
    const values = patternValues('color_strobe', { style, sync: 1, size: 1, color: 2 });
    const ctx = recordingCtx();
    const frame = (time) => {
      ctx.fills.length = 0;
      pattern.draw(ctx, st, {
        w: 640, h: 360, ph: 360, time, dt: 1 / 30, values, sources: {}, trigger: (type) => gate.getTrigger(type), detail: 1, hue: 0,
      });
      return ctx.fills;
    };
    assert.equal(frame(0).length, 0, 'nothing before a hit');
    room = false;
    counts.kick += 1;
    assert.equal(frame(0.5).length, 0, 'a hit with no room never fires');
    assert.equal(frame(0.6).length, 0, 'nor later');
    room = true;
    counts.kick += 1;
    assert.equal(frame(1).length, 0, 'the first frame of a pulse is dark (it rises)');
    const peak = frame(1 + STROBE_RISE_S);
    assert.equal(peak.length, 1, `style ${style}: one fill`);
    assert.equal(peak[0].op, 'lighter');
    const stops = peak[0].style.stops;
    assert.ok(stops.length >= 2 && stops.some(([, color]) => /,0\.000\)$/.test(color)), `style ${style}: soft edges (a stop at nothing)`);
    const alphas = stops.map(([, color]) => Number(color.match(/([\d.]+)\)$/)[1]));
    assert.ok(Math.max(...alphas) <= STROBE_PEAK + 1e-9 && Math.max(...alphas) > STROBE_PEAK * 0.9);
    assert.equal(frame(1 + STROBE_RISE_S + STROBE_FALL_S + 0.01).length, 0, 'gone after its fall');
  }
});

/* ---------------- Sheet motion ---------------- */

test('sheet motion: drift off (depth 0) is exactly no transform; on, a slow turn, breath and sway on 8, 16 and 32 bars, deterministic', () => {
  const still = overlayMotion(12.3, 0, 16 / 9);
  assert.deepEqual(still, {
    angle: 0, scale: 1, dx: 0, dy: 0, moving: false,
  });
  assert.equal(motionCss(still), '');
  assert.equal(motionUv(still, 16 / 9), null);
  assert.deepEqual(Object.values(OVERLAY_MOTION_PERIODS).sort((a, b) => a - b), [8, 16, 16, 32]);
  const a = overlayMotion(5, 1, 16 / 9);
  assert.deepEqual(overlayMotion(5, 1, 16 / 9), a, 'the same at the same clock');
  assert.ok(a.moving && a.scale > 1);
  // One whole cycle comes back to where it started.
  const back = overlayMotion(5 + 32, 1, 16 / 9);
  for (const key of ['angle', 'scale', 'dx', 'dy']) assert.ok(Math.abs(back[key] - a[key]) < 1e-9, key);
  // Small angles: at most OVERLAY_TURN_DEG times the depth.
  let turn = 0;
  for (let bars = 0; bars < 32; bars += 0.05) turn = Math.max(turn, Math.abs(overlayMotion(bars, DRIFT_CHECK_SCALE, 16 / 9).angle));
  assert.ok(turn * 180 / Math.PI <= OVERLAY_TURN_DEG * DRIFT_CHECK_SCALE + 1e-9 && turn * 180 / Math.PI < 2.5);
  // Slow: no frame at 150 BPM, 60 a second, turns it by more than a hundredth of a degree.
  const perFrame = (150 / 60 / 4) / 60;
  for (let bars = 0; bars < 32; bars += perFrame) {
    const step = Math.abs(overlayMotion(bars + perFrame, DRIFT_CHECK_SCALE, 16 / 9).angle - overlayMotion(bars, DRIFT_CHECK_SCALE, 16 / 9).angle);
    assert.ok(step * 180 / Math.PI < 0.01);
  }
});

test('sheet motion covers the picture: every corner of the picture inside the moved sheet, all cycle, every shape; enlarged by no more than OVERLAY_MOTION_MOST on 16:9', () => {
  assert.equal(coverScale(0, 0, 0, 16 / 9), 1);
  let most = 0;
  for (const aspect of [16 / 9, 9 / 16, 4 / 3, 21 / 9, 1]) {
    for (let bars = 0; bars < 32; bars += 0.05) {
      const motion = overlayMotion(bars, DRIFT_CHECK_SCALE, aspect);
      if (aspect === 16 / 9) most = Math.max(most, motion.scale - 1);
      const uv = motionUv(motion, aspect);
      for (const [qx, qy] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
        const [sx, sy] = sheetPoint(uv, qx, qy);
        assert.ok(Math.abs(sx) <= 0.5 + 1e-9 && Math.abs(sy) <= 0.5 + 1e-9, `aspect ${aspect.toFixed(2)} bars ${bars.toFixed(2)}: corner ${qx},${qy} at ${sx},${sy}`);
      }
    }
  }
  assert.ok(most <= OVERLAY_MOTION_MOST && most > 0.05, `most ${most}`);
});

test('sheet motion: the blend pass\'s mapping is the top sheet\'s CSS transform (translate, rotate, scale about the centre)', () => {
  const aspect = 16 / 9;
  const motion = overlayMotion(9.7, 1.4, aspect);
  const uv = motionUv(motion, aspect);
  // Forward as CSS does it, in pixels of a 1600 x 900 picture.
  const W = 1600;
  const H = 900;
  for (const [sx, sy] of [[0.3, -0.2], [-0.45, 0.4], [0, 0]]) {
    const x = sx * W * motion.scale;
    const y = sy * H * motion.scale;
    const c = Math.cos(motion.angle);
    const s = Math.sin(motion.angle);
    const qx = (x * c - y * s) / W + motion.dx;
    const qy = (x * s + y * c) / H + motion.dy;
    const [bx, by] = sheetPoint(uv, qx, qy);
    assert.ok(Math.abs(bx - sx) < 1e-9 && Math.abs(by - sy) < 1e-9);
  }
  assert.match(motionCss(motion), /^translate\([-\d.]+%,[-\d.]+%\) rotate\([-\d.]+deg\) scale\([\d.]+\)$/);
  assert.match(OVERLAY_BLEND_SRC, /u_ovmove/);
});

test('anchored overlays: the edge and line ones hold their sheet still; a sheet moves only if every overlay on it may', () => {
  for (const id of ['vignette', 'scanlines', 'cinematic', 'frame', 'spectrum']) assert.equal(overlayRow(id).anchored, true, id);
  for (const id of ['rings', 'petals', 'color_strobe', 'fireworks', 'bokeh']) assert.ok(!overlayRow(id).anchored, id);
  assert.equal(overlaysMove([item('rings'), item('petals')]), true);
  assert.equal(overlaysMove([item('rings'), item('vignette')]), false);
  assert.equal(overlaysMove([]), false);
});

function layerRig() {
  const top = new FakeNodeEl('canvas');
  top.width = 0;
  top.height = 0;
  const reactor = { getClock: () => 0, getTrigger: () => ({ live: true, count: 0, age: 0 }), getAnalysis: () => null };
  const gate = createFlashGate({ reactor: () => reactor, charge: () => true, sources: () => ({}) });
  const layer = createOverlayLayer({
    topCanvas: top, makeCanvas: () => new FakeNodeEl('canvas'), loadModule: async () => { throw new Error('ours only'); }, gate,
  });
  layer.resize(1600, 900, 'medium');
  return { top, layer };
}

test('the layer moves its sheets: the top one by a CSS transform (will-change only while moving), the blend one by its mapping; anchored, drift off, emptied or freed: none', () => {
  const { top, layer } = layerRig();
  layer.set([item('rings')], { now: true });
  assert.equal(layer.move(4, 1.2), true);
  assert.match(top.style.transform, /rotate/);
  assert.equal(top.style.willChange, 'transform');
  assert.equal(layer.blendSheet, null);
  // Drift off: exactly as before.
  assert.equal(layer.move(4, 0), false);
  assert.equal(top.style.transform, '');
  assert.equal(top.style.willChange, '');
  // An anchored overlay on the sheet holds it.
  layer.set([item('rings'), item('vignette')], { now: true });
  layer.move(4, 1.2);
  assert.equal(top.style.transform, '');
  // The blend sheet: its own rule (Rings blended in moves, Vignette on top does not).
  layer.set([item('vignette'), item('petals', { mode: 'screen' })], { now: true });
  layer.move(4, 1.2);
  assert.equal(top.style.transform, '');
  assert.ok(layer.blendSheet.move && layer.blendSheet.move.m.length === 4);
  layer.move(4, 0);
  assert.equal(layer.blendSheet.move, null);
  // Emptied and freed: no transform left behind.
  layer.set([item('rings')], { now: true });
  layer.move(4, 1.2);
  assert.notEqual(top.style.transform, '');
  layer.set([], { now: true });
  assert.equal(top.style.transform, '');
  assert.equal(top.style.willChange, '');
  layer.set([item('rings')], { now: true });
  layer.move(4, 1.2);
  layer.free();
  assert.equal(top.style.transform, '');
});

test('the blend pass gets the sheet\'s mapping as uniforms, and none when it does not move', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2', charge: () => true });
  const canvas = new FakeNodeEl('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const uv = motionUv(overlayMotion(3, 1, 16 / 9), 16 / 9);
  let sheet = {
    canvas, version: 1, blend: { ...PLAIN_BLEND, mode: 'screen' }, gain: 1, move: uv,
  };
  chain.setOverlay(() => sheet);
  const frame = () => { assert.ok(chain.begin(640, 360)); gl.drawArrays(); return chain.finish({ time: 1, dt: 0.03 }); };
  frame();
  assert.equal(gl.uniforms.get('u_ovmove')[0], 1);
  assert.deepEqual(gl.uniforms.get('u_ovm'), uv.m);
  assert.deepEqual(gl.uniforms.get('u_ovoff'), uv.off);
  sheet = { ...sheet, version: 2, move: null };
  frame();
  assert.equal(gl.uniforms.get('u_ovmove')[0], 0);
  chain.destroy();
});

/* ---------------- Review of slice 11 ---------------- */

/** One Strobe drawn through a gate that always has room, frame by frame at
 *  `fps`; a hit at each time in `hits` (s). Returns, per frame, the fill's
 *  gradient (kind, args, stops) or null. */
function strobeFrames(style, fps, hits, seconds) {
  const counts = { kick: 0 };
  const reactor = { getClock: () => 0, getTrigger: (type) => ({ live: true, count: counts[type] ?? 0, age: 0 }), getAnalysis: () => null };
  const gate = createFlashGate({ reactor: () => reactor, charge: () => true, sources: () => ({}) });
  const pattern = OVERLAY_PATTERNS.color_strobe;
  const st = pattern.create();
  const values = patternValues('color_strobe', { style, sync: 1, size: 1, color: 1 });
  const ctx = recordingCtx();
  const out = [];
  const pending = hits.slice();
  for (let frame = 0; frame <= seconds * fps; frame += 1) {
    const time = frame / fps;
    while (pending.length && pending[0] <= time) { pending.shift(); counts.kick += 1; }
    ctx.fills.length = 0;
    pattern.draw(ctx, st, {
      w: 640, h: 360, ph: 360, time, dt: 1 / fps, values, sources: {}, trigger: (type) => gate.getTrigger(type), detail: 1, hue: 0,
    });
    out.push(ctx.fills[0]?.style || null);
  }
  return out;
}
const hueOf = (g) => g.stops.map(([, color]) => color.match(/^hsla\((\d+),/)[1]);

test('the Strobe: a hit during a pulse raises the light where it is, in its colour (no jump of the band, the lit half or the hue), at 15 and 60 fps; the next pulse from dark takes the other side', () => {
  for (const fps of [15, 60]) {
    // The first look notes the count; then a hit setting off the first
    // pulse, one during it, and one from dark.
    const hits = [0.0001, 0.05, 0.3, 2];
    // Style 3: the same half and hue all through the first pulse.
    const halves = strobeFrames(3, fps, hits, 3);
    const lit = halves.map((g, frame) => (g ? { frame, edge: g.args[0], hue: hueOf(g).join() } : null)).filter(Boolean);
    const first = lit.filter((x) => x.frame / fps < 1.5);
    assert.ok(first.length > 3);
    assert.ok(first.every((x) => x.edge === first[0].edge && x.hue === first[0].hue), `${fps} fps: one place and colour per pulse`);
    const second = lit.filter((x) => x.frame / fps >= 2);
    assert.ok(second.length && second[0].edge !== first[0].edge, 'the next pulse from dark: the other half');
    // Style 2: the band's centre moves on smoothly, one way, never back.
    const shown = strobeFrames(2, fps, hits, 1.5).map((g) => (g ? (g.args[0] + g.args[2]) / 2 : null)).filter((x) => x !== null);
    const most = (640 * 0.7 * (1 / fps)) / 0.48 + 1e-6;
    for (let i = 1; i < shown.length; i += 1) {
      const step = shown[i] - shown[i - 1];
      assert.ok(Math.abs(step) <= most, `${fps} fps: band step ${step}`);
      assert.ok(step === 0 || Math.sign(step) === Math.sign(shown[shown.length - 1] - shown[0]), 'one way only');
    }
  }
});

/** hsla(h, s%, l%) as straight RGB 0..1. */
function hslRgb(text) {
  const [h, s, l] = text.match(/^hsla\((\d+),(\d+)%,(\d+)%/).slice(1).map(Number);
  const k = (n) => (n + h / 30) % 12;
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  return [0, 8, 4].map((n) => l / 100 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
}
const saturation = (c) => { const hi = Math.max(...c); return hi > 0 ? (hi - Math.min(...c)) / hi : 0; };

test('"Scene colours" never turns the Strobe white: over a white or grey part of the scene it keeps STROBE_TINT_FLOOR of saturation; another overlay is tinted fully', () => {
  assert.equal(overlayRow('color_strobe').tintFloor, STROBE_TINT_FLOOR);
  assert.ok(STROBE_TINT_FLOOR >= 0.5);
  assert.match(OVERLAY_BLEND_SRC, /u_tintsat/);
  for (let index = 0; index < STROBE_HUES.length; index += 1) {
    for (const other of [false, true]) {
      const c = hslRgb(strobeColor(index, 1, other));
      for (const scene of [[1, 1, 1], [0.5, 0.5, 0.5], [0.9, 0.92, 0.95]]) {
        const out = overlayTint(c, scene, 1, STROBE_TINT_FLOOR);
        assert.ok(saturation(out) >= STROBE_TINT_FLOOR - 0.02, `${index} over ${scene}: saturation ${saturation(out)}`);
        assert.ok(Math.min(...out) / Math.max(...out) <= 0.45, 'far from white');
      }
      // Without the floor (as for other overlays): neutral light, what it prevents.
      assert.ok(saturation(overlayTint(c, [1, 1, 1], 1, 0)) < 0.01);
      // Over a coloured part the tint still takes the scene's colour.
      const red = overlayTint(c, [1, 0.1, 0.1], 1, STROBE_TINT_FLOOR);
      assert.ok(red[0] >= red[1] && red[0] >= red[2]);
    }
  }
  assert.ok(!overlayRow('rings').tintFloor);
});

test('the layer hands the chain the Strobe\'s tint floor, and the chain sets it (none for others)', () => {
  const { layer } = layerRig();
  layer.set([item('color_strobe', { mode: 'screen', tint: true })], { now: true });
  assert.equal(layer.blendSheet.tintFloor, STROBE_TINT_FLOOR);
  layer.set([item('petals', { mode: 'screen', tint: true })], { now: true });
  assert.equal(layer.blendSheet.tintFloor, 0);
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2', charge: () => true });
  const canvas = new FakeNodeEl('canvas');
  canvas.width = 320;
  canvas.height = 180;
  let sheet = {
    canvas, version: 1, blend: { ...PLAIN_BLEND, mode: 'screen', tint: true }, gain: 1, tintFloor: STROBE_TINT_FLOOR,
  };
  chain.setOverlay(() => sheet);
  const frame = () => { assert.ok(chain.begin(640, 360)); gl.drawArrays(); return chain.finish({ time: 1, dt: 0.03 }); };
  frame();
  assert.equal(gl.uniforms.get('u_tintsat')[0], STROBE_TINT_FLOOR);
  sheet = { ...sheet, version: 2, tintFloor: 0 };
  frame();
  assert.equal(gl.uniforms.get('u_tintsat')[0], 0);
  chain.destroy();
});

test('sheet motion writes the top sheet\'s transform only when it changes by a visible amount (a quarter pixel, a hundredth of a degree); still or barely moving: nothing written', () => {
  const { top, layer } = layerRig();
  layer.set([item('rings')], { now: true });
  layer.move(4, 1.2);
  const writes = layer.topWrites;
  assert.equal(writes, 1);
  // The same clock again, and steps far below what shows.
  for (let i = 0; i < 50; i += 1) layer.move(4 + i * 1e-7, 1.2);
  assert.equal(layer.topWrites, writes, 'nothing written');
  // A visible change: written once.
  layer.move(6, 1.2);
  assert.equal(layer.topWrites, writes + 1);
  assert.match(top.style.transform, /rotate/);
  // The rounding stays within the quantum and keeps the picture covered.
  const q = {};
  for (let bars = 0; bars < 32; bars += 0.37) {
    const m = overlayMotion(bars, DRIFT_CHECK_SCALE, 16 / 9);
    quantiseMotion(m, 1600, 900, q);
    assert.ok(Math.abs(q.deg - (m.angle * 180) / Math.PI) <= OVERLAY_MOTION_QUANTUM.deg / 2 + 1e-9);
    assert.ok(Math.abs((q.tx / 100) * 1600 - m.dx * 1600) <= OVERLAY_MOTION_QUANTUM.px / 2 + 1e-9);
    assert.ok(q.scale >= m.scale, 'never smaller than the cover needs');
    const shown = {
      angle: (q.deg * Math.PI) / 180, scale: q.scale, dx: q.tx / 100, dy: q.ty / 100, moving: true,
    };
    const uv = motionUv(shown, 16 / 9);
    for (const [qx, qy] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const [sx, sy] = sheetPoint(uv, qx, qy);
      assert.ok(Math.abs(sx) <= 0.5 && Math.abs(sy) <= 0.5, 'covered as shown');
    }
  }
});

test('sheet motion uses the CSS Typed OM where the browser has it: one transform value made once, its numbers changed in place', () => {
  const g = globalThis;
  const saved = {};
  for (const name of ['CSS', 'CSSTransformValue', 'CSSTranslate', 'CSSRotate', 'CSSScale']) saved[name] = g[name];
  let made = 0;
  const unit = (unitName) => (value) => { made += 1; return { value, unit: unitName }; };
  g.CSS = { percent: unit('percent'), deg: unit('deg'), number: unit('number') };
  g.CSSTranslate = class { constructor(x, y) { made += 1; this.x = x; this.y = y; } };
  g.CSSRotate = class { constructor(a) { made += 1; this.angle = a; } };
  g.CSSScale = class { constructor(x, y) { made += 1; this.x = x; this.y = y; } };
  g.CSSTransformValue = class { constructor(list) { made += 1; this.list = list; } };
  try {
    const { top, layer } = layerRig();
    const sets = [];
    top.attributeStyleMap = { set: (name, value) => sets.push([name, value]), delete: () => {} };
    layer.set([item('rings')], { now: true });
    for (let bars = 0; bars < 8; bars += 0.5) layer.move(bars, 1.4);
    const after = made;
    assert.ok(sets.length > 3 && sets.every(([name, value]) => name === 'transform' && value === sets[0][1]), 'the same value object each time');
    for (let bars = 8; bars < 16; bars += 0.5) layer.move(bars, 1.4);
    assert.equal(made, after, 'nothing made again');
    assert.equal(top.style.transform ?? '', '', 'no string written');
    const angle = sets[0][1].list[1].angle.value;
    assert.ok(Math.abs(angle) <= OVERLAY_TURN_DEG * 1.4 + 0.01);
    assert.equal(top.style.willChange, 'transform');
    layer.move(16, 0);
    assert.equal(top.style.willChange, '');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete g[name]; else g[name] = value; }
  }
});
