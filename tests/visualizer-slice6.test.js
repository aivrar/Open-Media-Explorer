import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  normalizeVisualizerExtras, normalizeVisualizerOverlaySet, parseVisualizerFavourite,
  normalizeVisualizerFolded,
} from '../src/lib/visualizer-settings.js';
import loadOverlays from '../src/visualizer/vendor/psychedelia/engine/overlays.js';
import loadPostFx from '../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import { FX_CLASHES, fxCatalog, fxClashedFor, fxDrawnFor, fxOrder } from '../src/visualizer/fx-catalog.js';
import loadPalettes from '../src/visualizer/vendor/psychedelia/engine/palettes.js';
import {
  OVERLAY_BLENDS, OVERLAY_BLEND_MAX_PIXELS, OVERLAY_COST_BUDGET, OVERLAY_GLOW_PARAMS, OVERLAY_GLOW_SCALE, OVERLAY_LINE_PARAMS, OVERLAY_QUALITY_LIMITS, OVERLAY_SHUFFLE_COST_MAX, OVERLAY_TOP_MAX_PIXELS, OVERLAY_COST_UNITS, OVERLAY_EXCLUDED, OVERLAY_IDS, OVERLAY_LIVELY_BLENDS,
  OVERLAY_MASKS, OVERLAY_TABLE, PLAIN_BLEND, isBlendIn, overlayOrder, overlayRow, overlayToken, overlaysDrawnFor, overlaysKey,
  OVERLAY_HALO, OVERLAY_HALO_IDS, parseOverlayToken, overlaySizeUnit,
} from '../src/visualizer/overlay-catalog.js';
import { CONTOUR_ALPHA, OVERLAY_PATTERNS, patternValues } from '../src/visualizer/overlay-patterns.js';
import {
  LASER_BEAM, OVERLAY_FADE_IN_S, OVERLAY_FADE_OUT_S, OVERLAY_SPECTRUM_RISE_PER_S, createFlashGate, createOverlayLayer, laserBeam,
} from '../src/visualizer/overlay-layer.js';
import {
  OVERLAY_BEND_CHANCE, OVERLAY_BLEND_CHANCE, OVERLAY_MASK_CHANCE, OVERLAY_TINT_CHANCE, OVERLAY_UNDER_CHANCE, createOverlayShuffle, overlayModesFor,
} from '../src/visualizer/overlay-shuffle.js';
import { createFxShuffle, fxKey } from '../src/visualizer/fx-shuffle.js';
import {
  OVERLAY_BLEND_SRC, OVERLAY_MODE_STRENGTH, REACTION_SRC, createFxChain, fxFragment,
} from '../src/visualizer/fx-chain.js';
import { createFlashLedger, createFlashLimiter } from '../src/visualizer/flash-limiter.js';
import { createStepDown, STEP_DOWN_WINDOW_MS } from '../src/visualizer/step-down.js';
import {
  favouriteCombos, favouriteEntries, favouriteKey, favouriteToRecall, favouritesAsDrawn, isFavourite, withFavourite,
} from '../src/visualizer/favourites.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { FAVOURITES_FILTER_TITLE } from '../src/visualizer/scene-list.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import {
  CROSSFADE_SLOW_MS, FX_TEXT, NOTES, OVERLAY_TEXT, mountVisualizer,
} from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  Fake2D, FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 6 of the visualizer: overlays (Psychedelia's Canvas 2D overlays and
   our own patterns), their flash gate, the two sheets (plain on top: no
   graphics work; one blended in: one texture, uploaded only when drawn), the
   calm-scene rule, shuffle, favourites, the panel and the step-down. No GPU;
   fake clocks and a fake 2D context. */

const PSY = loadOverlays({}).Overlays;
const FX_CATALOG = fxCatalog(loadPostFx({}).PostFxLibrary);
// With the palettes, as the tab loads it (Palette Map).
const PALETTES6 = loadPalettes({}).PsyPalettes;
const CATALOG6 = fxCatalog(loadPostFx({ PsyPalettes: PALETTES6 }).PostFxLibrary, PALETTES6);
const DEFS = PSY.getDefs();
const PARAM = new Map(DEFS.flatMap((def) => def.params.map((param) => [param.name, param])));
const calm = SCENES.find((scene) => scene.fxCalm);
// A scene with no effects at all (scenes.js FX_NONE_SCENES).
const none = SCENES.find((scene) => scene.id === 'sierpinski' && scene.fxNone);
const lively = SCENES.find((scene) => !scene.fxCalm && !scene.fxNone);

/* ---------------- The catalog ---------------- */

test('the catalog: every Psychedelia overlay is offered or left out with a reason; every setting named is a real one, in range', () => {
  for (const def of DEFS) assert.ok(OVERLAY_TABLE[def.id] || OVERLAY_EXCLUDED[def.id], `${def.id}: offered or left out`);
  assert.ok(OVERLAY_EXCLUDED.strobe, 'the Psychedelia Strobe stays out (strobes by design); ours is color_strobe');
  for (const [id, row] of Object.entries(OVERLAY_TABLE)) {
    assert.ok(['psychedelia', 'ours'].includes(row.source), id);
    assert.ok(OVERLAY_COST_UNITS[row.cost], `${id} cost`);
    assert.ok(row.blends.includes('add') && row.blends.every((mode) => OVERLAY_BLENDS.includes(mode)), `${id} blends`);
    if (row.source === 'ours') {
      assert.ok(OVERLAY_PATTERNS[id], `${id} is one of our patterns`);
      assert.ok(!DEFS.some((def) => def.id === id), `${id} is not a Psychedelia id`);
      for (const [name, spec] of Object.entries(row.ranges)) {
        const p = OVERLAY_PATTERNS[id].params[name];
        assert.ok(p, `${id}.${name}`);
        const values = Array.isArray(spec) ? spec.slice(0, 2) : spec.pick;
        for (const value of values) assert.ok(value >= p.min && value <= p.max, `${id}.${name} ${value}`);
      }
      continue;
    }
    assert.ok(DEFS.some((def) => def.id === id), `${id} is a Psychedelia overlay`);
    for (const group of [row.pins, row.auto, row.ranges]) {
      for (const [name, spec] of Object.entries(group || {})) {
        const p = PARAM.get(name);
        assert.ok(p, `${id}.${name} is a param`);
        assert.equal(p.overlay, id, `${id}.${name} belongs to it`);
        const values = typeof spec === 'number' ? [spec] : (Array.isArray(spec) ? spec.slice(0, 2) : (spec.pick || []));
        for (const value of values) {
          if (typeof value === 'string') { assert.equal(p.type, 'color', `${id}.${name}`); continue; }
          if (p.type === 'select') assert.ok(value >= 0 && value < p.options.length, `${id}.${name} ${value}`);
          else assert.ok(value >= p.min && value <= p.max, `${id}.${name} ${value} in ${p.min}..${p.max}`);
        }
      }
    }
  }
  // Eleven of our own (Strobe the eighth; Ripples, Fireflies and Orbits after it), marked so.
  assert.equal(OVERLAY_IDS.filter((id) => overlayRow(id).source === 'ours').length, 11);
});

test('flash rules of the catalog: no flicker, no free run, Lightning by hand only and low, full-screen ones only on top', () => {
  const sync = /_sync$/;
  for (const [id, row] of Object.entries(OVERLAY_TABLE)) {
    if (row.source !== 'psychedelia') continue;
    for (const [name, spec] of Object.entries({ ...row.auto, ...row.ranges })) {
      if (!sync.test(name)) continue;
      const values = typeof spec === 'number' ? [spec] : spec.pick;
      assert.ok(!values.includes(0), `${id}.${name}: never Free Run (random firing)`);
      assert.ok(!values.includes(6), `${id}.${name}: never on Drops`);
    }
    for (const [name, value] of Object.entries(row.pins)) {
      // Hexgrid's Random Cells: single small cells (about 0.6 % of them at
      // 0.15), not the picture; kept low. Every other flicker or dip: off.
      if (name === 'hx_flicker') assert.ok(value <= 0.15, `${id}.${name} low`);
      else if (/flicker|dip/.test(name)) assert.equal(value, 0, `${id}.${name} off`);
    }
  }
  assert.equal(OVERLAY_TABLE.lightning.shuffle, false);
  assert.ok(OVERLAY_TABLE.lightning.pins.bolt_flash <= 0.2);
  assert.deepEqual([...OVERLAY_TABLE.lightning.blends], ['add', 'screen']);
  assert.deepEqual([...OVERLAY_TABLE.cinematic.blends], ['add']);
  assert.equal(OVERLAY_TABLE.cinematic.under, false);
  for (const id of ['vignette', 'scanlines']) assert.deepEqual([...OVERLAY_TABLE[id].blends], ['add']);
  assert.equal(OVERLAY_TABLE.matrix.pins.mx_dim, 0, 'Matrix never darkens the whole picture');
  // Bokeh's flares on a dark scene: 0.065 at most at 32 lights and 0.45,
  // 0.093 at 40 and 0.5.
  assert.ok(OVERLAY_TABLE.bokeh.ranges.bk_count[1] <= 32 && OVERLAY_TABLE.bokeh.ranges.bk_opacity[1] <= 0.45, 'Bokeh stays dim enough');
});

test('saved tokens: every blend-in round-trips, plain overlays save as their id, and the settings take the same form', () => {
  assert.equal(overlayToken({ id: 'rings', blend: PLAIN_BLEND }), 'rings');
  for (const mode of OVERLAY_BLENDS) {
    for (const mask of OVERLAY_MASKS) {
      for (const under of [false, true]) {
        for (const tint of [false, true]) {
          for (const bend of [false, true]) {
            const item = { id: 'plexus', blend: { mode, under, mask, tint, bend } };
            const token = overlayToken(item);
            assert.deepEqual(parseOverlayToken(token), item, token);
            assert.deepEqual(normalizeVisualizerOverlaySet([token]), [token], `${token} kept by the settings`);
            assert.equal(isBlendIn(item.blend), token.includes('~'));
          }
        }
      }
    }
  }
  assert.equal(parseOverlayToken('rings~x'), null);
  assert.deepEqual(normalizeVisualizerOverlaySet(['rings', 'rings~s', 'Bad', 'a', 'b', 'c']), ['rings', 'a', 'b'], 'one per overlay, three at most');
  const extras = normalizeVisualizerExtras({ visualizerOverlays: 'yes', visualizerOverlayShuffle: 0, visualizerOverlaySet: 'rings' });
  assert.deepEqual([extras.visualizerOverlays, extras.visualizerOverlayShuffle, extras.visualizerOverlaySet], [false, true, []]);
  const kept = normalizeSettings({ visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['petals~mk'] });
  assert.deepEqual([kept.visualizerOverlays, kept.visualizerOverlayShuffle, kept.visualizerOverlaySet], [true, false, ['petals~mk']]);
});

test('the calm rule (overlaysDrawnFor): none blended in on fxNone, no lively blend, mask or bend on fxCalm, one blend-in at most, only allowed modes', () => {
  const list = [
    { id: 'rings', blend: { ...PLAIN_BLEND, mode: 'difference', mask: 'bright', bend: true } },
    { id: 'petals', blend: { ...PLAIN_BLEND, mode: 'screen', under: true } },
    { id: 'cinematic', blend: { ...PLAIN_BLEND, mode: 'multiply', under: true } },
    { id: 'nope', blend: PLAIN_BLEND },
  ];
  const free = overlaysDrawnFor(lively, list);
  assert.deepEqual(free.map((item) => item.id), ['rings', 'cinematic', 'petals'], 'table order, unknown dropped');
  assert.equal(free.filter((item) => isBlendIn(item.blend)).length, 1, 'one blended in');
  assert.deepEqual(free[0].blend, { ...PLAIN_BLEND, mode: 'difference', mask: 'bright', bend: true });
  assert.deepEqual(free[1].blend, PLAIN_BLEND, 'cinematic: Add on top only');
  assert.deepEqual(free[2].blend, PLAIN_BLEND, 'the second blend-in is drawn plain');
  const onCalm = overlaysDrawnFor(calm, list);
  assert.deepEqual(onCalm[0].blend, PLAIN_BLEND, 'difference, mask and bend dropped on a calm scene');
  assert.deepEqual(onCalm[2].blend, { ...PLAIN_BLEND, mode: 'screen', under: true }, 'screen under the effects kept');
  for (const item of overlaysDrawnFor(none, list)) assert.deepEqual(item.blend, PLAIN_BLEND, `${item.id} plain on fxNone`);
  for (const id of OVERLAY_IDS) {
    for (const mode of overlayModesFor(id, calm)) assert.ok(!OVERLAY_LIVELY_BLENDS.has(mode), `${id} ${mode} on calm`);
    assert.deepEqual(overlayModesFor(id, none), ['add']);
  }
});

/* ---------------- The flash gate ---------------- */

function fakeReactor() {
  const counts = {
    kick: 0, snare: 0, hat: 0, beat: 0, bar: 0, drop: 0,
  };
  let now = 0;
  return {
    counts,
    set now(value) { now = value; },
    reactor: {
      getClock: () => now,
      getTrigger: (type) => ({ live: true, count: counts[type], age: 0 }),
      getBeatClock: () => now * 2,
      getAnalysis: () => null,
    },
  };
}

test('the flash gate: a hit fires only when the limiter has room, hits of one frame are one flash, a refused hit never fires later, always live', () => {
  const r = fakeReactor();
  let room = true;
  let charged = 0;
  const gate = createFlashGate({ reactor: () => r.reactor, charge: () => { if (room) charged += 1; return room; }, sources: () => ({ bass: 0.5 }) });
  assert.equal(gate.getTrigger('kick').live, true, 'never Psychedelia\'s random free run');
  assert.equal(gate.getTrigger('kick').count, 0);
  assert.equal(gate.getTrigger('beat').count, 0, 'the first look only notes where the count is');
  r.counts.kick += 1;
  r.counts.beat += 1;
  r.now = 1;
  assert.equal(gate.getTrigger('kick').count, 1);
  assert.equal(gate.getTrigger('beat').count, 1);
  assert.equal(charged, 1, 'kick and beat in one frame: one charge');
  assert.equal(gate.stats.shared, 1);
  room = false;
  r.counts.kick += 1;
  r.now = 1.2;
  assert.equal(gate.getTrigger('kick').count, 1, 'refused: not fired');
  room = true;
  r.now = 2;
  assert.equal(gate.getTrigger('kick').count, 1, 'and not fired later either');
  assert.ok(gate.getTrigger('kick').age >= 1);
  assert.equal(gate.getSource('bass'), 0.5, 'the limiter\'s output');
  assert.equal(gate.isSource(), false, 'no Beat Reactor links on overlays');
});

test('the flash gate: Spectrum\'s analysis rises no faster than OVERLAY_SPECTRUM_RISE_PER_S in real time (the same at 15 and 60 fps), falls at once, and is one step per frame', () => {
  for (const fps of [15, 60]) {
    const r = fakeReactor();
    const fft = new Uint8Array(64);
    const analysis = { active: true, available: true, fft, byteData: true, fftScale: 'normalized-db' };
    r.reactor.getAnalysis = () => analysis;
    const gate = createFlashGate({ reactor: () => r.reactor, charge: () => true, sources: () => ({}) });
    r.now = 1;
    assert.equal(gate.getAnalysis().spectrum[0], 0);
    fft.fill(255); // a kick: every bin to the top at once
    const climb = [];
    for (let frame = 1; frame <= fps; frame += 1) {
      r.now = 1 + frame / fps;
      const a = gate.getAnalysis();
      const again = gate.getAnalysis(); // the second sheet, the same frame
      assert.equal(again.spectrum[0], a.spectrum[0], 'no extra step for a second reader');
      climb.push(a.spectrum[0]);
    }
    const perFrame = (OVERLAY_SPECTRUM_RISE_PER_S * 255) / fps;
    assert.ok(Math.abs(climb[0] - perFrame) < 1e-3, `${fps} fps: the first frame climbs ${climb[0]}, not to the top`);
    const k = Math.round(fps * 0.25);
    const quarter = climb[k - 1];
    assert.ok(Math.abs(quarter - Math.min(255, OVERLAY_SPECTRUM_RISE_PER_S * 255 * (k / fps))) < 1e-2, `${fps} fps: after ${k / fps} s ${quarter}`);
    assert.equal(climb.at(-1), 255, 'it gets there');
    assert.equal(gate.getAnalysis().fft, fft, 'the raw bins are still there');
    fft.fill(20);
    r.now = 2 + 1 / fps;
    assert.equal(gate.getAnalysis().spectrum[0], 20, 'falls pass at once');
  }
  // No analysis (no music): nothing made up.
  const quiet = createFlashGate({ reactor: () => fakeReactor().reactor, charge: () => true, sources: () => ({}) });
  assert.equal(quiet.getAnalysis(), null);
});

test('the flash gate with the real limiter: a kick every frame fires at most once a second, shared with trigger effects', () => {
  const ledger = createFlashLedger();
  const limiter = createFlashLimiter({ ledger });
  const r = fakeReactor();
  let now = 0;
  const gate = createFlashGate({ reactor: () => r.reactor, charge: () => limiter.charge(now), sources: () => null });
  const fired = [];
  let last = 0;
  for (let frame = 0; frame < 600; frame += 1) {
    now = frame / 60;
    r.now = now;
    r.counts.kick += 1;
    const count = gate.getTrigger('kick').count;
    if (count !== last) { fired.push(now); last = count; }
  }
  assert.ok(fired.length >= 8 && fired.length <= 11, `${fired.length} in 10 s`);
  for (let index = 1; index < fired.length; index += 1) assert.ok(fired[index] - fired[index - 1] >= 1 - 1e-9, 'a second apart');
});

/* ---------------- The layer ---------------- */

function layerRig() {
  const top = new FakeNodeEl('canvas');
  top.width = 0;
  top.height = 0;
  const made = [];
  let loads = 0;
  const r = fakeReactor();
  const gate = createFlashGate({ reactor: () => r.reactor, charge: () => true, sources: () => ({}) });
  const layer = createOverlayLayer({
    topCanvas: top,
    makeCanvas: () => { const canvas = new FakeNodeEl('canvas'); made.push(canvas); return canvas; },
    loadModule: async () => { loads += 1; return { default: loadOverlays }; },
    gate,
  });
  return {
    top, made, layer, r, get loads() { return loads; },
  };
}
const item = (id, blend = PLAIN_BLEND, values = {}) => ({ id, blend: { ...PLAIN_BLEND, ...blend }, values });

test('the layer: nothing made while empty; ours draw on the top sheet with no module; a blend-in gets its own small sheet whose version moves only when drawn', async () => {
  const rig = layerRig();
  rig.layer.resize(800, 400, 'low');
  assert.equal(rig.layer.render(1, 0.03, {}), false);
  assert.equal(rig.top.context2d, undefined, 'no 2D context while empty');
  assert.equal(rig.top.width, 0);
  rig.layer.set([item('petals')], { now: true });
  assert.equal(rig.layer.blendSheet, null, 'plain on top: nothing for the chain');
  assert.equal(rig.top.hidden, false);
  // The picture's shape, at most Low's pixels (800 x 400 is 320,000).
  assert.equal(rig.top.width, 707);
  assert.equal(rig.top.height, 353);
  rig.layer.resize(600, 300, 'low');
  assert.equal(rig.top.width, 600, 'under the cap: the picture\'s own size');
  rig.layer.resize(800, 400, 'low');
  rig.layer.render(1, 0.03, { bass: 0.4 });
  assert.ok(rig.top.context2d.total > 0, 'drawn');
  assert.equal(rig.loads, 0, 'our patterns need no Psychedelia module');
  // Blended in: its own sheet at the quality's share (Low: half).
  rig.layer.set([item('petals'), item('rings', { mode: 'screen' })], { now: true });
  const sheet = rig.layer.blendSheet;
  assert.ok(sheet);
  assert.equal(sheet.canvas.width, 400);
  assert.equal(sheet.canvas.height, 200);
  assert.deepEqual(sheet.blend, { ...PLAIN_BLEND, mode: 'screen' });
  await settle(() => !rig.layer.loading);
  assert.equal(rig.loads, 1, 'the module is loaded for a Psychedelia overlay');
  const v0 = rig.layer.blendSheet.version;
  rig.layer.render(1.1, 0.03, {});
  assert.equal(rig.layer.blendSheet.version, v0 + 1, 'drawn: a new version');
  assert.equal(rig.layer.blendSheet.version, v0 + 1, 'not drawn: the same');
  // Back to plain: the blend sheet goes.
  rig.layer.set([item('petals')], { now: true });
  assert.equal(rig.layer.blendSheet, null);
  assert.equal(rig.made[0].width, 0, 'its canvas emptied');
  rig.layer.free();
  assert.equal(rig.top.width, 0);
  assert.equal(rig.top.hidden, true);
  assert.equal(rig.layer.on, false);
});

test('the blend sheet stays within its pixel cap (the upload is ~10 ms per million pixels), and glow follows the quality', async () => {
  const rig = layerRig();
  for (const [quality, w, h] of [['high', 1920, 1080], ['medium', 1440, 810], ['low', 960, 540]]) {
    rig.layer.resize(w, h, quality);
    rig.layer.set([item('rings', { mode: 'screen' })], { now: true });
    const { canvas } = rig.layer.blendSheet;
    assert.ok(canvas.width * canvas.height <= OVERLAY_BLEND_MAX_PIXELS[quality], `${quality}: ${canvas.width} x ${canvas.height}`);
    assert.ok(Math.abs(canvas.width / canvas.height - w / h) < 0.01, 'the picture\'s shape');
  }
  // Glow: Pulse Rings' glow by quality; Plexus's pinned off.
  rig.layer.resize(1920, 1080, 'high');
  rig.layer.set([item('rings'), item('plexus')], { now: true });
  await settle(() => !rig.layer.loading);
  const psy = rig.layer.top.psy;
  const ringDefault = PARAM.get('ring_glow').default;
  assert.equal(psy.getParam('ring_glow'), ringDefault * OVERLAY_GLOW_SCALE.high);
  assert.equal(psy.getParam('px_glow'), 0);
  rig.layer.setQuality('medium');
  assert.equal(psy.getParam('ring_glow'), ringDefault * OVERLAY_GLOW_SCALE.medium);
  rig.layer.setQuality('high');
  assert.equal(psy.getParam('ring_glow'), ringDefault * OVERLAY_GLOW_SCALE.high, 'back up');
  for (const [id, name] of Object.entries(OVERLAY_GLOW_PARAMS)) assert.equal(PARAM.get(name)?.overlay, id, `${id}.${name}`);
  // No glow on any quality: a shadow blur is drawn again per shape (Sacred
  // Geometry 5.4 to 6.5 ms a frame on High even at a quarter of its glow).
  for (const quality of ['low', 'medium', 'high']) assert.equal(OVERLAY_GLOW_SCALE[quality], 0, quality);
  assert.equal(psy.getParam('ring_glow'), 0);
});

test('the top sheet: at most OVERLAY_TOP_MAX_PIXELS per quality in the picture\'s shape (the browser stretches it), the picture\'s own size when smaller', () => {
  const rig = layerRig();
  rig.layer.set([item('petals')], { now: true });
  for (const [quality, w, h] of [['high', 1920, 1080], ['medium', 1440, 810], ['low', 960, 540], ['medium', 2217, 1442], ['high', 1920, 1249]]) {
    rig.layer.resize(w, h, quality);
    assert.ok(rig.top.width * rig.top.height <= OVERLAY_TOP_MAX_PIXELS[quality], `${quality} ${w} x ${h}: ${rig.top.width} x ${rig.top.height}`);
    assert.ok(rig.top.width * rig.top.height > OVERLAY_TOP_MAX_PIXELS[quality] * 0.99, 'as large as the cap allows');
    assert.ok(Math.abs(rig.top.width / rig.top.height - w / h) < 0.01, 'the picture\'s shape');
  }
  rig.layer.resize(640, 360, 'high');
  assert.deepEqual([rig.top.width, rig.top.height], [640, 360]);
  rig.layer.destroy();
});

test('the layer: settings limited per quality (OVERLAY_QUALITY_LIMITS) and pixel line widths scaled by the sheet\'s size unit (overlaySizeUnit), always from the values as chosen', async () => {
  const rig = layerRig();
  rig.layer.resize(1920, 1080, 'medium');
  rig.layer.set([
    item('plexus', PLAIN_BLEND, { px_count: 80, px_line_width: 2 }),
    item('lasers', PLAIN_BLEND, { laser_count: 10, laser_thickness: 4 }),
    item('matrix', PLAIN_BLEND, { mx_size: 18, mx_trail: 18, mx_density: 0.6 }),
  ], { now: true });
  await settle(() => !rig.layer.loading);
  const psy = rig.layer.top.psy;
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a}, not ${b}`);
  const check = (quality) => {
    assert.ok(rig.top.height < 1080, `${quality}: the sheet is smaller than the picture`);
    // A 720th of the 1080-line picture, in the sheet's pixels.
    const unit = overlaySizeUnit(rig.top.height, 1080);
    assert.ok(Math.abs(unit - rig.top.height / 720) < 1e-9, `${quality}: the unit`);
    const L = OVERLAY_QUALITY_LIMITS;
    assert.equal(psy.getParam('px_count'), Math.min(80, L.plexus.px_count.max[quality]), `${quality} px_count`);
    near(psy.getParam('px_line_width'), Math.min(2, L.plexus.px_line_width.max[quality]) * unit, `${quality} px_line_width`);
    assert.equal(psy.getParam('laser_count'), Math.min(10, L.lasers.laser_count.max[quality]), `${quality} laser_count`);
    // Lasers are beams (laserBeam): their width costs nothing (not limited), and
    // they follow the sheet's height themselves (not scaled here).
    near(psy.getParam('laser_thickness'), 4, `${quality} laser_thickness`);
    assert.equal(psy.getParam('mx_size'), Math.max(18, L.matrix.mx_size.min[quality]), `${quality} mx_size`);
    assert.equal(psy.getParam('mx_trail'), Math.min(18, L.matrix.mx_trail.max[quality]), `${quality} mx_trail`);
    near(psy.getParam('mx_density'), Math.min(0.6, L.matrix.mx_density.max[quality]), `${quality} mx_density`);
  };
  check('medium');
  assert.equal(psy.getParam('px_count'), 50);
  near(psy.getParam('px_line_width'), 1.5 * (530 / 720), 'Medium on a 1920 x 1080 screen: a 530-line sheet');
  rig.layer.setQuality('high');
  check('high');
  rig.layer.setQuality('low');
  check('low');
  rig.layer.setQuality('high');
  check('high'); // back up: from the chosen values, not the limited ones
  assert.equal(psy.getParam('px_count'), 70);
  // A picture small enough for the sheet to be its own size: lines as chosen (within the limits).
  rig.layer.resize(640, 360, 'high');
  near(psy.getParam('px_line_width'), 1.5, 'no scaling at the picture\'s own size');
  near(psy.getParam('laser_thickness'), 4, 'as chosen');
  // The quality changes while the sheet keeps its size (under every cap): the limits follow.
  rig.layer.setQuality('medium');
  assert.deepEqual([rig.top.width, rig.top.height], [640, 360]);
  assert.equal(psy.getParam('px_count'), 50);
  rig.layer.setQuality('high');
  assert.equal(psy.getParam('px_count'), 70);
  // Pinned for cost: Hex Grid flat only, 3D Laser Room without haze.
  assert.equal(OVERLAY_TABLE.hexgrid.pins.hx_view, 0);
  assert.equal(OVERLAY_TABLE.hexgrid.ranges.hx_view, undefined);
  assert.equal(OVERLAY_TABLE.laser_room.pins.lr_haze, 0);
  assert.equal(OVERLAY_TABLE.laser_room.ranges.lr_haze, undefined);
  for (const [id, names] of Object.entries(OVERLAY_LINE_PARAMS)) for (const name of names) assert.equal(PARAM.get(name)?.overlay, id, `${id}.${name}`);
  for (const [id, limits] of Object.entries(OVERLAY_QUALITY_LIMITS)) for (const name of Object.keys(limits)) assert.equal(PARAM.get(name)?.overlay, id, `${id}.${name}`);
  rig.layer.destroy();
});

test('our patterns: their lines follow the picture (thinner on a sheet drawn smaller), and the long ones stay a pixel wide or less', () => {
  const widths = (id, env) => {
    const pattern = OVERLAY_PATTERNS[id];
    const ctx = new Fake2D(new FakeNodeEl('canvas'));
    const strokes = [];
    const stroke = ctx.stroke.bind(ctx);
    ctx.stroke = (...args) => { strokes.push(ctx.lineWidth); return stroke(...args); };
    pattern.draw(ctx, pattern.create(), {
      time: 1, dt: 1 / 30, values: patternValues(id, {}), sources: { bass: 0.5, mid: 0.5, kick: 0.5 }, trigger: () => ({ live: true, count: 0, age: 9 }), detail: 1, hue: 0, ...env,
    });
    return strokes;
  };
  // At the picture's own size (1080 lines): as designed (1.5 px per unit).
  assert.deepEqual(widths('contours', { w: 1920, h: 1080, ph: 1080 }), [1, 1]);
  assert.ok(widths('ribbons', { w: 1920, h: 1080, ph: 1080 }).includes(3), 'the middle strand 2 units');
  // On Medium's capped sheet (530 of 810 lines): thinner in the sheet's pixels.
  const ribbons = widths('ribbons', { w: 942, h: 530, ph: 810 });
  assert.ok(Math.abs(Math.max(...ribbons) - 2 * (530 / 720)) < 1e-9, `ribbons ${Math.max(...ribbons)}`);
  for (const id of ['contours', 'harmonograph', 'petals']) {
    for (const env of [{ w: 942, h: 530, ph: 810 }, { w: 1264, h: 711, ph: 1080 }, { w: 1920, h: 1080, ph: 1080 }]) {
      const list = widths(id, env);
      assert.ok(list.length > 0 && list.every((width) => width <= 1), `${id} at ${env.h} of ${env.ph}: ${list.join(', ')}`);
    }
  }
  assert.equal(widths('harmonograph', { w: 1920, h: 1080, ph: 1080 }).length, 1, 'harmonograph: one stroke, no halo');
  assert.equal(widths('petals', { w: 1920, h: 1080, ph: 1080 }).length, 3, 'petals: one stroke a ring, no wide halo');
  // Contour Lines are drawn stronger now that they have a halo.
  const ctx = new Fake2D(new FakeNodeEl('canvas'));
  OVERLAY_PATTERNS.contours.draw(ctx, OVERLAY_PATTERNS.contours.create(), {
    w: 1920, h: 1080, ph: 1080, time: 1, dt: 1 / 30, values: patternValues('contours', {}), sources: {}, detail: 1, hue: 0,
  });
  assert.equal(CONTOUR_ALPHA, 0.6);
  assert.match(ctx.strokeStyle, /,0\.600\)$/);
});

test('the halo: a sheet holding Tron Hex Grid or Contour Lines gets a soft halo at Medium and High (image copies only), none at Low or without them; its canvases go with them', async () => {
  assert.equal(OVERLAY_HALO.low, null);
  assert.ok(OVERLAY_HALO.medium && OVERLAY_HALO.high);
  assert.deepEqual([...OVERLAY_HALO_IDS].sort(), ['contours', 'hexgrid']);
  const rig = layerRig();
  rig.layer.resize(1000, 500, 'high');
  rig.layer.set([item('contours')], { now: true });
  rig.layer.render(1, 0.03, {});
  assert.equal(rig.layer.stats.halos, 1);
  assert.equal(rig.made.length, 3, 'a half, a quarter and an eighth');
  // Each a halving of the one before (rounded up).
  let [w, h] = [rig.top.width, rig.top.height];
  for (const canvas of rig.made) {
    [w, h] = [Math.ceil(w / 2), Math.ceil(h / 2)];
    assert.deepEqual([canvas.width, canvas.height], [w, h]);
  }
  const [half, quarter, eighth] = rig.made.map((canvas) => canvas.context2d);
  const top = rig.top.context2d;
  // The quarter: from the half, plus the eighth (the wide glow, High only);
  // stretched back over the sheet twice (softened); no blur or shadow.
  assert.deepEqual([half.count('drawImage'), quarter.count('drawImage'), eighth.count('drawImage'), top.count('drawImage')], [1, 2, 1, 2]);
  assert.equal(top.filter, 'none');
  assert.equal(top.shadowBlur, 0);
  // Medium: the near glow only (no eighth made).
  rig.layer.setQuality('medium');
  rig.layer.render(1.03, 0.03, {});
  assert.equal(rig.layer.stats.halos, 2);
  assert.deepEqual([quarter.count('drawImage'), eighth.count('drawImage')], [3, 1]);
  // Low: none.
  rig.layer.setQuality('low');
  rig.layer.render(1.06, 0.03, {});
  assert.equal(rig.layer.stats.halos, 2);
  // Not for other overlays: their sheet gets none, and the halo's canvases go.
  rig.layer.setQuality('high');
  rig.layer.set([item('petals')], { now: true });
  assert.ok(rig.made.every((canvas) => canvas.width === 0 && canvas.height === 0), 'emptied');
  rig.layer.render(1.09, 0.03, {});
  assert.equal(rig.layer.stats.halos, 2);
  // Tron Hex Grid too, and on the blended sheet as well.
  rig.layer.set([item('hexgrid', { mode: 'screen' })], { now: true });
  await settle(() => !rig.layer.loading);
  rig.layer.render(1.12, 0.03, {});
  assert.equal(rig.layer.stats.halos, 3);
  rig.layer.destroy();
});

test('laser beams: a turned rectangle filled with a soft strip and a white-hot core, sized by the picture and the Thickness setting; no stroke; curved beams in straight pieces', () => {
  const record = (height = 1080) => {
    const calls = [];
    const gradients = [];
    const ctx = new Proxy({ globalAlpha: 1, canvas: { height } }, {
      get: (target, name) => {
        if (name in target) return target[name];
        if (name === 'createLinearGradient') {
          return (...args) => {
            const stops = [];
            gradients.push({ args, stops });
            calls.push(['gradient', ...args]);
            return { addColorStop: (at, color) => stops.push([at, color]) };
          };
        }
        return (...args) => { calls.push([name, ...args]); };
      },
    });
    return { ctx, calls, gradients };
  };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // Default Thickness (3) at 1080 lines: a core 6 to 8 pixels, a glow 40 to 50.
  const straight = record();
  assert.equal(laserBeam(straight.ctx, 10, 20, null, null, 110, 20, 'rgba(255,0,0,1.0000)', 3), true);
  const fills = straight.calls.filter((call) => call[0] === 'fillRect');
  assert.equal(fills.length, 2);
  const [glowFill, coreFill] = fills;
  assert.ok(near(-glowFill[2] * 2, glowFill[4]) && near(glowFill[4], 3 * LASER_BEAM.glow) && glowFill[4] >= 40 && glowFill[4] <= 50, `glow ${glowFill[4]}`);
  assert.ok(near(coreFill[4], 3 * LASER_BEAM.core) && coreFill[4] >= 6 && coreFill[4] <= 8, `core ${coreFill[4]}`);
  assert.equal(glowFill[3], 100);
  assert.ok(!straight.calls.some((call) => ['stroke', 'lineTo', 'arc'].includes(call[0])), 'no line drawn');
  const [glow, core] = straight.gradients.map((g) => ({ ...g, stops: [...g.stops].sort((a, b) => a[0] - b[0]) }));
  // The glow: clear at its edges, the same both sides.
  assert.deepEqual(glow.stops[0], [0, 'rgba(255,0,0,0)']);
  assert.deepEqual(glow.stops.at(-1), [1, 'rgba(255,0,0,0)']);
  for (const [at, color] of glow.stops) assert.ok(glow.stops.some(([other, c]) => near(other, 1 - at) && c === color), `mirrored at ${at}`);
  // The core: the beam's colour at its edges, near white in the middle.
  assert.deepEqual(core.stops[0], [0, 'rgba(255,0,0,1.0000)']);
  assert.deepEqual(core.stops.find(([at]) => at === 0.5), [0.5, `rgba(255,${Math.round(255 * LASER_BEAM.white)},${Math.round(255 * LASER_BEAM.white)},1.0000)`]);
  // Half the picture's lines, or half the Thickness: half the size.
  for (const [height, thickness] of [[540, 3], [1080, 1.5]]) {
    const small = record(height);
    laserBeam(small.ctx, 0, 0, null, null, 100, 0, 'rgba(255,0,0,1.0000)', thickness);
    const [g, c] = small.calls.filter((call) => call[0] === 'fillRect');
    assert.ok(near(g[4], 1.5 * LASER_BEAM.glow) && near(c[4], 1.5 * LASER_BEAM.core), `${height} lines, Thickness ${thickness}: ${g[4]}, ${c[4]}`);
  }
  // Psychedelia's rainbow colours (hsla) too.
  const hue = record();
  laserBeam(hue.ctx, 0, 0, null, null, 50, 50, 'hsla(120.0,100%,60%,1.0000)', 3);
  assert.ok(hue.gradients[0].stops.some(([at, color]) => at === 0 && color === 'hsla(120.0,100%,60%,0)'));
  assert.ok(hue.gradients[1].stops.some(([at, color]) => at === 0.5 && color === `hsla(120.0,100%,${(60 + 40 * LASER_BEAM.white).toFixed(1)}%,1.0000)`));
  // Spiral Spokes: a curve in straight pieces.
  const curve = record();
  laserBeam(curve.ctx, 0, 0, 50, 0, 100, 50, 'rgba(0,255,0,1.0000)', 2);
  assert.equal(curve.calls.filter((call) => call[0] === 'fillRect').length, 2 * LASER_BEAM.curveSteps);
});

test('laser beams in the layer: Psychedelia\'s Lasers drawn through laserBeam (an import patch), with no line of their own; without it, stroked as before', async () => {
  for (const beams of [true, false]) {
    const top = new FakeNodeEl('canvas');
    const r = fakeReactor();
    const layer = createOverlayLayer({
      topCanvas: top,
      makeCanvas: () => new FakeNodeEl('canvas'),
      loadModule: async () => ({ default: loadOverlays }),
      gate: createFlashGate({ reactor: () => r.reactor, charge: () => true, sources: () => ({}) }),
      beams,
    });
    layer.resize(800, 400, 'high');
    layer.set([item('lasers', PLAIN_BLEND, { laser_count: 4, laser_mode: 0 })], { now: true });
    await settle(() => !layer.loading);
    layer.render(1, 0.03, {});
    const ctx = top.context2d;
    if (beams) {
      assert.equal(ctx.count('stroke'), 0, 'no stroked line');
      assert.equal(ctx.count('fillRect'), 4 * 2, 'a strip and a line per beam');
    } else {
      assert.equal(ctx.count('stroke'), 4);
      assert.equal(ctx.count('fillRect'), 0);
    }
    layer.destroy();
  }
});

test('the layer fades changes in real time: out, then in, the same at 15 and 60 frames a second', () => {
  for (const fps of [15, 60]) {
    const rig = layerRig();
    rig.layer.resize(640, 360, 'medium');
    rig.layer.set([item('ribbons')], { now: true });
    let time = 10;
    rig.layer.render(time, 0, {});
    rig.layer.set([item('dot_spiral')]);
    assert.equal(rig.layer.fadePhase, 'out');
    const step = 1 / fps;
    while (rig.layer.fadePhase === 'out') { time += step; rig.layer.render(time, step, {}); }
    assert.ok(Math.abs(time - 10 - OVERLAY_FADE_OUT_S) <= step + 1e-9, `${fps} fps: out in ${OVERLAY_FADE_OUT_S} s`);
    assert.deepEqual(rig.layer.drawn.map((x) => x.id), ['dot_spiral']);
    const inAt = time;
    while (rig.layer.fadePhase === 'in') { time += step; rig.layer.render(time, step, {}); }
    assert.ok(Math.abs(time - inAt - OVERLAY_FADE_IN_S) <= step + 1e-9, `${fps} fps: in in ${OVERLAY_FADE_IN_S} s`);
    assert.equal(rig.layer.gain, 1);
    // Off: fades out, then nothing is on.
    rig.layer.set([]);
    assert.equal(rig.layer.on, true, 'still fading out');
    for (let index = 0; index < fps; index += 1) { time += step; rig.layer.render(time, step, {}); }
    assert.equal(rig.layer.on, false);
    assert.equal(rig.top.hidden, true);
  }
});

test('our patterns: time-based (the same picture state at 15 and 60 fps), count scaled by quality, no shadow blur, nothing full-screen', () => {
  for (const [id, pattern] of Object.entries(OVERLAY_PATTERNS)) {
    const values = patternValues(id, {});
    const draws = {};
    for (const [fps, detail] of [[15, 1], [60, 1], [60, 0.5]]) {
      const canvas = new FakeNodeEl('canvas');
      const ctx = new Fake2D(canvas);
      const state = pattern.create();
      let shadow = 0;
      for (let frame = 0; frame <= fps * 2; frame += 1) {
        pattern.draw(ctx, state, {
          w: 1280, h: 720, time: frame / fps, dt: 1 / fps, values, sources: { bass: 0.5, mid: 0.5, kick: 0.5 }, trigger: () => ({ live: true, count: 0, age: 9 }), detail, hue: 0,
        });
        shadow = Math.max(shadow, ctx.shadowBlur || 0);
      }
      assert.equal(shadow, 0, `${id}: no shadow blur`);
      assert.equal(ctx.count('fillRect'), 0, `${id}: no rectangle fills (nothing full-screen)`);
      draws[`${fps}/${detail}`] = { state: JSON.stringify(state), calls: ctx.total / (fps * 2 + 1) };
    }
    const a = JSON.parse(draws['15/1'].state);
    const b = JSON.parse(draws['60/1'].state);
    for (const key of Object.keys(a)) {
      if (typeof a[key] === 'number') assert.ok(Math.abs(a[key] - b[key]) < 0.05, `${id}.${key}: ${a[key]} at 15 fps, ${b[key]} at 60`);
    }
    assert.ok(draws['60/0.5'].calls <= draws['60/1'].calls, `${id}: fewer calls at Low`);
  }
});

/* ---------------- The chain's blend pass ---------------- */

test('the chain: no blend-in, no pass, no texture, no upload; a blend-in is one texture, uploaded only on frames it was drawn, then released', () => {
  const gl = new FakeGL();
  const chain = createFxChain({ gl, mode: 'webgl2', charge: () => true });
  assert.equal(chain.active, false, 'nothing: bypassed');
  let sheet = null;
  chain.setOverlay(() => sheet);
  assert.equal(chain.active, false, 'a provider with no blended sheet is still bypassed');
  assert.equal(chain.begin(640, 360), null);
  assert.equal(gl.textures.size, 0);
  assert.equal(gl.uploads, 0);
  const canvas = new FakeNodeEl('canvas');
  canvas.width = 320;
  canvas.height = 180;
  sheet = {
    canvas, version: 1, blend: { ...PLAIN_BLEND, mode: 'difference' }, gain: 1,
  };
  assert.equal(chain.active, true);
  const frame = () => { const target = chain.begin(640, 360); assert.ok(target); gl.drawArrays(); return chain.finish({ time: 1, dt: 0.03 }); };
  assert.equal(frame(), true);
  assert.equal(gl.uploads, 1);
  assert.equal(gl.lastUpload, canvas);
  assert.equal(gl.pixelStore.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), false, 'premultiply set only around the upload');
  frame();
  assert.equal(gl.uploads, 1, 'same version: no upload');
  assert.equal(chain.stats.overlaySkipped, 1);
  sheet.version = 2;
  frame();
  assert.equal(gl.uploads, 2);
  assert.equal(chain.stats.overlayDraws, 3);
  assert.equal(gl.uniforms.get('u_mode')[0], 4, 'difference');
  assert.equal(gl.uniforms.get('u_strength')[0], OVERLAY_MODE_STRENGTH.difference);
  const texturesWhileOn = gl.textures.size;
  assert.ok(texturesWhileOn >= 2, 'the capture target and the overlay texture');
  // The blend-in ends: nothing draws through the chain; release frees it all.
  sheet = null;
  assert.equal(chain.active, false);
  assert.equal(chain.holding, true);
  chain.release();
  assert.equal(gl.textures.size, 0);
  assert.equal(gl.framebuffers.size, 0);
  chain.destroy();
});

test('the chain: under the effects the overlay is the first step, on top it is the last one, after the effect and the reactions', () => {
  const gl = new FakeGL();
  const order = [];
  const chain = createFxChain({ gl, mode: 'webgl2', charge: () => true });
  const realUse = gl.useProgram.bind(gl);
  gl.useProgram = (program) => { realUse(program); order.push(program?.fragment ?? ''); };
  const canvas = new FakeNodeEl('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const sheet = {
    canvas, version: 1, blend: { ...PLAIN_BLEND, mode: 'screen', under: true }, gain: 1,
  };
  chain.setOverlay(() => sheet);
  // A real effect pass in the chain (Psychedelia's Mirror), so the two
  // orders differ.
  const fx = FX_CATALOG.find((row) => row.id === 'mirror');
  assert.ok(fx, 'the Mirror effect');
  chain.setPasses([{ id: 'mirror', fx, values: {}, links: [] }]);
  const marker = fx.def.src.trim().split('\n').find((line) => line.trim().length > 20).trim();
  const isOverlay = (fragment) => fragment.includes('u_ovsize');
  const isEffect = (fragment) => !isOverlay(fragment) && fragment.includes(marker);
  const isReactions = (fragment) => fragment.includes(REACTION_SRC.trim().split('\n').find((line) => line.includes('uniform')));
  const run = () => {
    order.length = 0;
    chain.begin(64, 36);
    gl.drawArrays();
    chain.finish({
      time: 1, dt: 0.03, beat: { clock: 0 }, sources: null,
    });
    const at = (match) => order.findIndex(match);
    return {
      overlay: at(isOverlay), effect: at(isEffect), reactions: at(isReactions), last: order.length - 1,
    };
  };
  run(); // the programs link
  const under = run();
  assert.ok(under.overlay >= 0 && under.effect >= 0, `both drawn: ${JSON.stringify(under)}`);
  assert.ok(under.overlay < under.effect, 'under the effects: the overlay pass comes before the effect');
  sheet.blend = { ...PLAIN_BLEND, mode: 'screen', under: false };
  const over = run();
  assert.ok(over.overlay > over.effect, `on top: the overlay pass comes after the effect ${JSON.stringify(over)}`);
  assert.ok(over.reactions < 0 || over.overlay > over.reactions, 'and after the reactions');
  assert.equal(over.overlay, over.last, 'on top: the last program');
  assert.ok(OVERLAY_BLEND_SRC.includes('u_mask') && OVERLAY_BLEND_SRC.includes('u_tint') && OVERLAY_BLEND_SRC.includes('u_bend'));
  chain.destroy();
});

test('the layer: Bokeh and Particles leaving keep the sheet\'s instance (Psychedelia bounds their sprite caches itself)', async () => {
  // Psychedelia since e2cc5c2: at most 48 Bokeh and 48 Particles sprites,
  // the oldest dropped (the app used to replace the instance to free them).
  const vendored = readFileSync(new URL('../src/visualizer/vendor/psychedelia/engine/overlays.js', import.meta.url), 'utf8');
  assert.ok(vendored.includes('if (st.bkKeys.length >= 48) delete st.sprites[st.bkKeys.shift()];'), 'Bokeh sprites bounded upstream');
  assert.ok(vendored.includes('if (st.pxKeys.length >= 48) delete st.sprites[st.pxKeys.shift()];'), 'Particles sprites bounded upstream');
  const rig = layerRig();
  rig.layer.resize(640, 360, 'medium');
  rig.layer.set([item('rings'), item('bokeh'), item('lasers')], { now: true });
  await settle(() => !rig.layer.loading);
  rig.layer.render(1, 0.03, {});
  const first = rig.layer.top.psy;
  assert.ok(first, 'one Psychedelia instance for the sheet');
  rig.layer.set([item('lasers', PLAIN_BLEND, { laser_speed: 0.9 })], { now: true });
  assert.equal(rig.layer.top.psy, first, 'Bokeh left: the same instance');
  assert.equal(first.isEnabled('bokeh'), false);
  assert.equal(first.isEnabled('lasers'), true);
  assert.equal(first.getParam('laser_speed'), 0.9, 'Lasers stayed on with another speed: given');
  assert.equal(first.getParam('laser_flicker'), 0, 'and its pins');
  rig.layer.set([item('lasers'), item('particles')], { now: true });
  rig.layer.set([item('lasers')], { now: true });
  assert.equal(rig.layer.top.psy, first, 'Particles left: the same instance');
  assert.equal(rig.layer.stats.spriteDrops, undefined);
  rig.layer.destroy();
});

test('the layer: dropBlend takes the blended overlay off at once, mid fade, and leaves the plain ones', () => {
  const rig = layerRig();
  rig.layer.resize(640, 360, 'medium');
  rig.layer.render(0, 0, {});
  rig.layer.set([item('petals'), item('ribbons', { mode: 'difference' })], { now: true });
  rig.layer.render(0.1, 0.03, {});
  rig.layer.set([item('petals')]); // a fade out starts
  rig.layer.render(0.15, 0.03, {});
  assert.equal(rig.layer.fadePhase, 'out');
  assert.ok(rig.layer.blendSheet, 'still blended while it fades out');
  assert.equal(rig.layer.dropBlend(), true);
  assert.equal(rig.layer.blendSheet, null, 'gone at once');
  assert.deepEqual(rig.layer.drawn.map((x) => x.id), ['petals']);
  assert.equal(rig.made[0].width, 0, 'its canvas emptied');
  rig.layer.render(0.2, 0.03, {});
  assert.ok(rig.top.context2d.total > 0, 'the plain one still drawn');
  rig.layer.destroy();
});

test('the layer: the top sheet is drawn at the picture\'s size even when its canvas came with another (a new canvas is 300 x 150)', () => {
  const rig = layerRig();
  rig.top.width = 300;
  rig.top.height = 150;
  rig.layer.resize(800, 400, 'medium');
  rig.layer.set([item('petals')], { now: true });
  assert.equal(rig.top.width, 800);
  assert.equal(rig.top.height, 400);
  rig.layer.destroy();
});

/* ---------------- Shuffle ---------------- */

test('the overlay shuffle: seedable, within the cost budget, no immediate repeat, Lightning never, calm and fxNone rules for blend-ins', () => {
  const run = (seed, context) => {
    const shuffle = createOverlayShuffle({ random: seededRandom(seed) });
    const out = [];
    for (let roll = 0; roll < 300; roll += 1) {
      const combo = shuffle.next(context);
      shuffle.shown(combo);
      out.push(combo);
    }
    return out;
  };
  const context = {
    maxCount: 3, costBudget: OVERLAY_COST_BUDGET.medium, costMax: 'heavy', entry: lively, blendIns: true, bend: true,
  };
  const a = run(9, context);
  const b = run(9, context);
  assert.deepEqual(a.map((combo) => combo.key), b.map((combo) => combo.key), 'the same seed, the same sets');
  assert.notDeepEqual(a.map((combo) => combo.key), run(10, context).map((combo) => combo.key));
  let blended = 0;
  const modes = new Set();
  for (let index = 0; index < a.length; index += 1) {
    const combo = a[index];
    const cost = combo.items.reduce((sum, x) => sum + OVERLAY_COST_UNITS[overlayRow(x.id).cost], 0)
      + (combo.items.some((x) => isBlendIn(x.blend)) ? 1 : 0);
    assert.ok(cost <= OVERLAY_COST_BUDGET.medium, `${combo.key} costs ${cost}`);
    assert.ok(!combo.ids.includes('lightning'));
    assert.ok(combo.items.filter((x) => isBlendIn(x.blend)).length <= 1);
    for (const x of combo.items) assert.ok(overlayRow(x.id).blends.includes(x.blend.mode), `${x.id} ${x.blend.mode}`);
    if (index) for (const id of combo.ids) assert.ok(!a[index - 1].ids.includes(id), `${id} not twice running`);
    if (combo.items.some((x) => isBlendIn(x.blend))) blended += 1;
    for (const x of combo.items) modes.add(x.blend.mode);
  }
  assert.ok(blended > 60, `blend-ins picked (${blended})`);
  for (const mode of OVERLAY_BLENDS) assert.ok(modes.has(mode), `${mode} picked`);
  for (const combo of run(4, { ...context, entry: calm })) {
    for (const x of combo.items) {
      assert.ok(!OVERLAY_LIVELY_BLENDS.has(x.blend.mode) && x.blend.mask === 'none' && !x.blend.bend, `calm: ${overlaysKey(combo.items)}`);
    }
  }
  for (const combo of run(4, { ...context, entry: none })) assert.ok(!combo.items.some((x) => isBlendIn(x.blend)));
  for (const combo of run(5, { ...context, costMax: 'light', costBudget: OVERLAY_COST_BUDGET.low, maxCount: 2 })) {
    assert.ok(combo.items.length <= 2);
    for (const x of combo.items) assert.equal(overlayRow(x.id).cost, 'light');
  }
});

test('the overlay shuffle blends one overlay in about two sets in three at Medium, a mask in about one in three; still one per set, inside the budget', () => {
  assert.deepEqual(
    [OVERLAY_BLEND_CHANCE, OVERLAY_UNDER_CHANCE, OVERLAY_MASK_CHANCE, OVERLAY_TINT_CHANCE, OVERLAY_BEND_CHANCE],
    [0.75, 0.5, 0.5, 0.4, 0.3],
  );
  let sets = 0;
  let blended = 0;
  let masked = 0;
  for (let seed = 1; seed <= 5; seed += 1) {
    const shuffle = createOverlayShuffle({ random: seededRandom(seed) });
    for (let roll = 0; roll < 400; roll += 1) {
      const combo = shuffle.next({ maxCount: 3, costBudget: OVERLAY_COST_BUDGET.medium, costMax: 'heavy', entry: lively, blendIns: true, bend: true });
      shuffle.shown(combo);
      if (!combo.items.length) continue;
      sets += 1;
      const ins = combo.items.filter((x) => isBlendIn(x.blend));
      assert.ok(ins.length <= 1, 'one blended in at most');
      const cost = combo.items.reduce((sum, x) => sum + OVERLAY_COST_UNITS[overlayRow(x.id).cost], 0) + (ins.length ? 1 : 0);
      assert.ok(cost <= OVERLAY_COST_BUDGET.medium);
      if (ins.length) blended += 1;
      if (ins.some((x) => x.blend.mask !== 'none')) masked += 1;
    }
  }
  // Was about 0.41 and 0.13 at 0.5 / 0.3.
  assert.ok(blended / sets > 0.55 && blended / sets < 0.75, `blended in ${(blended / sets).toFixed(2)}`);
  assert.ok(masked / sets > 0.25 && masked / sets < 0.4, `masked ${(masked / sets).toFixed(2)}`);
});

test('the overlay shuffle offers no heavy overlay on Low (OVERLAY_SHUFFLE_COST_MAX), and the tab asks it so', () => {
  const heavy = OVERLAY_IDS.filter((id) => overlayRow(id).cost === 'heavy');
  assert.deepEqual(heavy, ['hexgrid'], 'measured heavy: Tron Hex Grid only');
  const picks = (costMax) => {
    const shuffle = createOverlayShuffle({ random: seededRandom(12) });
    const seen = new Set();
    for (let roll = 0; roll < 400; roll += 1) {
      // A budget that would fit it: only the class keeps it out.
      const combo = shuffle.next({ maxCount: 1, costBudget: 99, costMax, entry: lively, blendIns: false, bend: false });
      shuffle.shown(combo);
      for (const id of combo.ids) seen.add(id);
    }
    return seen;
  };
  assert.equal(OVERLAY_SHUFFLE_COST_MAX.low, 'medium');
  assert.equal(OVERLAY_SHUFFLE_COST_MAX.medium, 'heavy');
  assert.ok(!picks(OVERLAY_SHUFFLE_COST_MAX.low).has('hexgrid'), 'not on Low');
  assert.ok(picks(OVERLAY_SHUFFLE_COST_MAX.medium).has('hexgrid'), 'offered on Medium');
  // (Its 4 units are over Low's budget of 3 too.) The tab rolls with the cap for its quality.
  const tab = readFileSync(new URL('../src/visualizer/index.js', import.meta.url), 'utf8');
  const roll = tab.slice(tab.indexOf('function rollOverlays()'), tab.indexOf('function applyOverlays('));
  // (tq(): the quality whose table rows apply, High's at Very high.)
  assert.match(roll, /costMax: lighterCost\(shuffleCostMax\(\), OVERLAY_SHUFFLE_COST_MAX\[tq\(\)\]/);
  assert.match(tab, /const tq = \(\) => tableQuality\(stepDown\.quality\);/);
});

/* ---------------- Favourites ---------------- */

test('favourites save the exact overlays and blend-ins; older strings still load as no overlays', () => {
  const overlays = [{ id: 'rings', blend: { ...PLAIN_BLEND, mode: 'soft', under: true, mask: 'dark' } }, { id: 'petals', blend: PLAIN_BLEND }];
  const key = favouriteKey('tunnel', null, ['bloom'], overlays);
  assert.equal(key, 'tunnel|bloom/rings~ouk+petals');
  assert.deepEqual(parseVisualizerFavourite(key), {
    scene: 'tunnel', look: null, fx: ['bloom'], overlays: ['rings~ouk', 'petals'],
  });
  assert.equal(favouriteKey('tunnel', 2, [], overlays.slice(1)), 'tunnel:2/petals', 'overlays without effects');
  const old = ['plasma:1', 'moire|trails'];
  assert.deepEqual(favouriteEntries(old).map((entry) => entry.overlays), [[], []], 'old strings: no overlays');
  assert.ok(isFavourite(old, 'moire', null, ['trails'], []));
  let list = withFavourite(old, 'tunnel', null, true, null, ['bloom'], overlays);
  assert.equal(list.at(-1), key);
  assert.ok(isFavourite(list, 'tunnel', null, ['bloom'], overlays));
  assert.ok(!isFavourite(list, 'tunnel', null, ['bloom'], [overlays[1]]), 'other overlays: not this favourite');
  assert.deepEqual(favouriteCombos(list, 'tunnel', null), [{ fx: ['bloom'], overlays: overlayOrder(overlays).map((x) => ({ id: x.id, blend: { ...PLAIN_BLEND, ...x.blend } })) }]);
  list = withFavourite(list, 'tunnel', null, false, null, ['bloom'], overlays);
  assert.deepEqual(list, old);
  assert.equal(parseVisualizerFavourite('tunnel/rings+rings~s'), null, 'one per overlay');
  assert.equal(parseVisualizerFavourite('tunnel/a+b+c+d'), null, 'three at most');
  // As drawn: a calm scene's favourite keeps no lively blend.
  const drawn = favouritesAsDrawn([`${calm.id}/rings~d`], (id, fx) => fx, (id, x) => overlaysDrawnFor(SCENES.find((s) => s.id === id), x));
  assert.deepEqual(drawn, [`${calm.id}/rings`]);
});

/* ---------------- Step-down ---------------- */

test('the step-down takes overlays off after effects and before quality', () => {
  let fx = 1;
  let overlays = 2;
  const steps = [];
  const sd = createStepDown({
    quality: 'high', fps: 60, fxInUse: () => fx, overlaysInUse: () => overlays, onStep: (to) => steps.push(to),
  });
  let now = 0;
  const slowWindow = () => {
    for (let index = 0; index < 2; index += 1) {
      const end = now + STEP_DOWN_WINDOW_MS + 200;
      while (now < end) { now += 100; sd.tick(now - 84); sd.tick(now - 67); sd.frame(now); }
    }
    now += 1200;
  };
  slowWindow();
  assert.equal(sd.fx, 0, 'effects first');
  fx = 0;
  slowWindow();
  assert.equal(sd.overlays, 1, 'then overlays down to one');
  overlays = 1;
  slowWindow();
  assert.equal(sd.overlays, 0, 'then none');
  overlays = 0;
  assert.equal(sd.level, 0, 'quality untouched so far');
  slowWindow();
  assert.equal(sd.level, 1, 'then quality');
  assert.equal(steps.length, 4);
  sd.choose('high', 60);
  assert.equal(sd.overlays, Number.POSITIVE_INFINITY, 'a choice by hand clears it');
  assert.ok(NOTES.fewerOverlays);
});

/* ---------------- In the tab ---------------- */

const LAYOUT = { width: 1280, height: 720 };

async function mount({ settings = {}, seed = 3, failOverlays = false, gl: givenGl = null } = {}) {
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
  let overlayLoads = 0;
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(seed),
    loadFxLibrary: async () => import('../src/visualizer/vendor/psychedelia/engine/post-fx-library.js'),
    loadOverlays: async () => { overlayLoads += 1; if (failOverlays) throw new Error('no overlays module'); return { default: loadOverlays }; },
  });
  const m = {
    h, gl, saved, session, source, signal, controls: session.controls,
    get overlayLoads() { return overlayLoads; },
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
  };
  await m.until(() => Boolean(session.switcher.current), 'first scene');
  return m;
}
const click = (node) => node.dispatchEvent(new Event('click'));
/** A section title's words: its name, then what is set. */
const titleOf = (head) => [...head.children].map((part) => part.textContent || '').join(' ').trim();
const change = (node, value) => {
  if (typeof value === 'boolean') node.checked = value;
  else if (value !== undefined) node.value = value;
  node.dispatchEvent(new Event('change'));
};
const SETTLE_MS = CROSSFADE_SLOW_MS + 800;

test('in the tab, overlays off (the default): nothing made, loaded, uploaded or drawn for them', async () => {
  const m = await mount();
  m.start();
  await m.play(2000);
  const { session, controls } = m;
  assert.equal(session.overlays.on, false);
  assert.equal(session.overlays.layer, null, 'no layer');
  assert.equal(m.overlayLoads, 0);
  assert.equal(session.overlayCanvas.hidden, true);
  assert.equal(session.overlayCanvas.width, 0);
  assert.equal(session.overlayCanvas.context2d, undefined, 'no 2D context');
  assert.equal(m.gl.uploads, 0);
  assert.equal(m.gl.draws, m.gl.screenDraws, 'the scene straight to the screen');
  // The section is open and shows its switch; the rest waits for the switch.
  assert.equal(controls.overlaysBody.hidden, false, 'the section is open');
  assert.equal(controls.overlaysHead.getAttribute('aria-expanded'), 'true');
  assert.equal(controls.overlaysToggle.checked, false);
  assert.equal(controls.overlaysMore.hidden, true, 'only the switch while overlays are off');
  assert.equal(controls.overlaysShuffle.disabled, true);
  assert.equal(titleOf(controls.overlaysHead), 'Overlays Off', 'the title says Off');
  session.destroy();
});

test('the side panel: each section has a title button that folds it and says what is set; Effects and Overlays always show their switch; folded sections are saved', async () => {
  const m = await mount({ settings: { visualizerFolded: ['picture'] } });
  const { session, controls } = m;
  const heads = controls.sectionHeads;
  const bodies = controls.sectionBodies;
  for (const [index, name] of ['Scene', 'Shuffle', 'Effects', 'Overlays', 'Picture'].entries()) assert.ok(titleOf(heads[index]).startsWith(name), name);
  assert.equal(heads.length, 5);
  for (const [index, head] of heads.entries()) {
    assert.equal(head.getAttribute('aria-controls'), bodies[index].getAttribute('id'));
    assert.equal(head.getAttribute('aria-expanded'), index === 4 ? 'false' : 'true');
    assert.equal(bodies[index].hidden, index === 4, 'only the saved one is folded');
  }
  // What is set, at the right of the title (also while folded).
  assert.equal(titleOf(heads[1]), 'Shuffle Off');
  assert.equal(titleOf(heads[2]), 'Effects Off');
  assert.equal(titleOf(heads[3]), 'Overlays Off');
  assert.match(titleOf(heads[4]), /^Picture \S.*, \d+ fps$/);
  // Off: the switch alone. On: the rest too, and the title says On.
  assert.equal(controls.effectsMore.hidden, true);
  assert.equal(controls.overlaysMore.hidden, true);
  change(controls.overlaysToggle, true);
  assert.equal(controls.overlaysMore.hidden, false);
  assert.equal(titleOf(heads[3]), 'Overlays On');
  change(controls.fxToggle, true);
  assert.equal(controls.effectsMore.hidden, false);
  assert.equal(titleOf(heads[2]), 'Effects On');
  // Folding: the title button, saved in the panel's order.
  click(heads[3]);
  assert.equal(bodies[3].hidden, true);
  assert.equal(heads[3].getAttribute('aria-expanded'), 'false');
  assert.equal(titleOf(heads[3]), 'Overlays On', 'still says On while folded');
  assert.deepEqual(m.settings.visualizerFolded, ['ov', 'picture']);
  click(heads[4]);
  assert.equal(bodies[4].hidden, false);
  assert.deepEqual(m.settings.visualizerFolded, ['ov']);
  session.destroy();
  // The setting: known sections only, each once, in the panel's order.
  assert.deepEqual(normalizeVisualizerFolded(['picture', 'nonsense', 'ov', 'ov', 7]), ['ov', 'picture']);
  assert.deepEqual(normalizeVisualizerFolded('ov'), []);
});

test('in the tab: overlays by hand, quick ticks all count, plain ones cost the chain nothing, a blend-in uploads, star and leaving free everything', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false } });
  const { session, controls, gl } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  m.start();
  await m.play(500);
  const boxes = session.overlays.boxes;
  // Two ticks before anything is drawn: both count (the chosen set is the truth).
  change(boxes.get('petals'), true);
  change(boxes.get('rings'), true);
  assert.deepEqual(session.overlays.chosen.map((x) => x.id), ['rings', 'petals']);
  assert.deepEqual(m.settings.visualizerOverlaySet, ['rings', 'petals']);
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.drawn.map((x) => x.id), ['rings', 'petals']);
  await m.until(() => m.overlayLoads === 1 && !session.overlays.layer.loading, 'module');
  await m.play(1000);
  assert.ok(session.overlayCanvas.context2d.total > 0, 'drawn on the top sheet');
  assert.equal(session.overlayCanvas.hidden, false);
  assert.equal(gl.uploads, 0, 'plain on top: no upload');
  assert.equal(gl.draws, gl.screenDraws, 'and no extra pass');
  assert.equal(boxes.get('petals').checked, true);
  assert.match(controls.overlaysLine.textContent, /^Overlays: /);
  // Blend Rings in (Screen, under the effects).
  const row = session.overlays.rows[0];
  assert.equal(row.id, 'rings');
  change(row.mode, 'screen');
  change(row.under, true);
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.drawn.find((x) => x.id === 'rings').blend, { ...PLAIN_BLEND, mode: 'screen', under: true });
  assert.deepEqual(m.settings.visualizerOverlaySet, ['rings~su', 'petals']);
  await m.play(1000);
  assert.ok(gl.uploads > 0, 'uploaded');
  assert.ok(session.fx.chain.stats.overlayDraws > 0);
  const uploads = gl.uploads;
  const frames = session.fx.chain.stats.overlayDraws;
  assert.ok(uploads <= frames, 'at most one upload a frame');
  // A blend-in on the second makes the first plain again (one at a time).
  const row2 = session.overlays.rows[1];
  assert.equal(row.note.hidden, true);
  assert.equal(row2.note.hidden, true, 'nothing said before a choice takes the blend-in');
  change(row2.mode, 'soft');
  assert.deepEqual(session.overlays.chosen.map((x) => overlayToken(x)), ['rings', 'petals~o']);
  // Said in one line under the choice just made, not in the other row.
  assert.equal(row2.note.hidden, false);
  assert.equal(row2.note.textContent, 'Only one overlay can be blended in at a time.');
  assert.equal(row.note.hidden, true);
  const parts = [...row2.row.children];
  assert.equal(parts[parts.indexOf(row2.note) - 1]?.classList?.contains('viz-ov-mode-field'), true, 'right under the Blend choice');
  assert.doesNotMatch(session.overlays.note.textContent, /Only one overlay/, 'not repeated in the section\'s note');
  // A blend choice that takes nothing from another overlay says nothing.
  change(row2.mode, 'add');
  assert.equal(row2.note.hidden, true);
  change(row2.mode, 'soft');
  assert.equal(row2.note.hidden, true, 'the other overlay was already plain');
  await m.play(SETTLE_MS);
  // The star saves the exact combination.
  click(controls.star);
  assert.equal(m.settings.visualizerFavourites.at(-1), 'tunnel/rings+petals~o');
  assert.equal(controls.star.getAttribute('aria-pressed'), 'true');
  change(boxes.get('petals'), false);
  await m.play(SETTLE_MS);
  assert.equal(controls.star.getAttribute('aria-pressed'), 'false');
  // Off: faded, then the chain is released.
  change(controls.overlaysToggle, false);
  await m.play(SETTLE_MS + 1000);
  assert.equal(session.overlays.layer.on, false);
  assert.equal(session.overlayCanvas.hidden, true);
  assert.equal(gl.textures.size, 0, 'no texture held');
  change(controls.overlaysToggle, true);
  await m.play(SETTLE_MS);
  session.destroy();
  assert.equal(session.overlays.layer, null);
  assert.equal(session.overlayCanvas.width, 0);
  assert.equal(gl.textures.size, 0);
});

test('in the tab: an overlay that cannot go under the effects says why its box is grayed', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false } });
  const { session } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  m.start();
  await m.play(500);
  const boxes = session.overlays.boxes;
  change(boxes.get('fireworks'), true);
  change(boxes.get('rings'), true);
  await m.play(SETTLE_MS);
  const rowFor = (id) => session.overlays.rows.find((row) => row.id === id);
  const fireworks = rowFor('fireworks');
  assert.equal(fireworks.under.disabled, true);
  assert.equal(fireworks.under.title, OVERLAY_TEXT.underNone);
  assert.equal(fireworks.underField.title, 'Not available for this overlay.');
  const why = fireworks.under.getAttribute('aria-describedby');
  assert.ok(why, 'described for a screen reader');
  const whyNode = fireworks.underField.children.find((node) => (node.id || node.getAttribute?.('id')) === why);
  assert.equal(whyNode?.textContent, 'Not available for this overlay.');
  // One that can go under the effects says nothing extra.
  const rings = rowFor('rings');
  assert.equal(rings.underField.title, '');
  assert.equal(rings.under.getAttribute('aria-describedby'), null);
  // Lasers and Stage Lights, in the row Fireworks had: the same words.
  change(boxes.get('fireworks'), false);
  change(boxes.get('lasers'), true);
  await m.play(SETTLE_MS);
  assert.equal(rowFor('lasers').underField.title, OVERLAY_TEXT.underNone);
  change(boxes.get('lasers'), false);
  change(boxes.get('spotlights'), true);
  await m.play(SETTLE_MS);
  assert.equal(rowFor('spotlights').underField.title, OVERLAY_TEXT.underNone);
  assert.equal(rowFor('rings').underField.title, '');
  session.destroy();
});

test('in the tab: "Only one overlay can be blended in" goes with the next change of the overlays: one removed, or new overlays now', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false } });
  const { session, controls } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  m.start();
  await m.play(500);
  const boxes = session.overlays.boxes;
  const [first, second] = session.overlays.rows;
  /** Rings and Petals chosen, Rings blended in, then Petals takes the blend-in. */
  const noteOnSecond = async () => {
    change(boxes.get('petals'), true);
    change(boxes.get('rings'), true);
    await m.play(SETTLE_MS);
    change(first.mode, 'screen');
    change(second.mode, 'soft');
    assert.deepEqual(session.overlays.chosen.map((x) => overlayToken(x)), ['rings', 'petals~o']);
    assert.equal(second.note.hidden, false);
    assert.equal(first.note.hidden, true);
  };
  await noteOnSecond();
  // The overlay that was set back to plain is removed: the note goes.
  change(boxes.get('rings'), false);
  assert.deepEqual(session.overlays.chosen.map((x) => x.id), ['petals']);
  assert.equal(first.note.hidden, true);
  assert.equal(second.note.hidden, true);
  // A redraw with nothing changed keeps it; new overlays now take it away.
  change(boxes.get('petals'), false);
  await m.play(SETTLE_MS);
  await noteOnSecond();
  change(controls.overlaysToggle, true); // already on: no change
  assert.equal(second.note.hidden, false, 'kept while nothing changed');
  click(controls.overlaysNow);
  assert.equal(session.overlays.rows.every((row) => row.note.hidden), true);
  await m.play(SETTLE_MS);
  assert.equal(session.overlays.rows.every((row) => row.note.hidden), true, 'not back after the change is made');
  session.destroy();
});

test('in the tab: a lost context holds the overlay sheet still (no transform, no will-change) and it moves again once drawing resumes', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false } });
  const { session } = m;
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  m.start();
  await m.play(500);
  change(session.overlays.boxes.get('rings'), true);
  await m.play(SETTLE_MS);
  await m.until(() => !session.overlays.layer.loading, 'module');
  await m.play(3000);
  const style = session.overlayCanvas.style;
  assert.match(style.transform, /rotate/, 'moving with slow drift');
  assert.equal(style.willChange, 'transform');
  session.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(style.transform, '');
  assert.equal(style.willChange, '');
  await m.play(1000);
  assert.equal(style.transform, '', 'still held while lost');
  session.canvas.dispatchEvent(new Event('webglcontextrestored'));
  await m.until(() => Boolean(session.switcher.current), 'scene back');
  await m.play(1000);
  assert.match(style.transform, /rotate/, 'moving again');
  session.destroy();
  assert.equal(style.transform, '', 'gone with the tab');
});

test('in the tab: on a calm scene a lively blend chosen by hand is drawn plain and its option greyed', async () => {
  const m = await mount({ settings: { visualizerScene: calm.id, visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['rings~db'] } });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.chosen.map(overlayToken), ['rings~db'], 'the choice stays');
  assert.deepEqual(session.overlays.drawn.map(overlayToken), ['rings'], 'drawn plain');
  const row = session.overlays.rows[0];
  const difference = row.mode.children.find((option) => option.value === 'difference');
  assert.equal(difference.disabled, true);
  assert.equal(row.mask.disabled, true);
  assert.ok(session.overlays.note.textContent.length > 0);
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.drawn.map(overlayToken), ['rings~db'], 'back where it is allowed');
  session.destroy();
});

test('in the tab: the overlay shuffle picks a new set with each scene, and favourites shuffle restores the starred overlays', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: true,
      visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: ['tunnel/hexgrid~s+petals', 'starfield/ribbons'],
    },
  });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  assert.equal(session.switcher.current, 'tunnel');
  assert.deepEqual(session.overlays.drawn.map(overlayToken), ['hexgrid~s', 'petals'], 'the starred combination');
  assert.equal(m.session.controls.star.getAttribute('aria-pressed'), 'true');
  session.sceneList.pick('starfield');
  await m.until(() => session.switcher.current === 'starfield', 'starfield');
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.drawn.map(overlayToken), ['ribbons']);
  session.destroy();
});

test('in the tab: the step-down takes overlays off (fewest kept: the heaviest go) and says so', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['matrix', 'petals', 'rings'] } });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  assert.equal(session.overlays.drawn.length, 3);
  // Frames come at a third of the rate: slow windows.
  const start = session.stepDown.stats.overlaySteps;
  await m.play(12000, 100);
  assert.ok(session.stepDown.stats.overlaySteps > start, 'stepped overlays');
  await m.play(SETTLE_MS);
  assert.ok(session.overlays.drawn.length < 3);
  assert.ok(!session.overlays.drawn.some((x) => x.id === 'matrix'), 'the heavy one went first');
  // No effects on: what is held back is overlays (or, further down, quality).
  assert.equal(session.note.textContent, session.stepDown.level > 0 ? NOTES.lowered : NOTES.fewerOverlays);
  session.destroy();
});

test('in the tab: the step-down shortens only what one scene draws; the choice stays whole, comes back on another scene and with a quality chosen, and a favourite saves it', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom', 'glitch'],
      visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['matrix', 'rings'],
    },
  });
  const { session, controls } = m;
  const fxIds = () => session.fx.drawn.slice().sort();
  const ovIds = () => session.overlays.drawn.map((item) => item.id).sort();
  m.start();
  await m.until(() => session.fx.drawn.length === 2, 'both effects drawn');
  await m.play(SETTLE_MS);
  assert.deepEqual(fxIds(), ['bloom', 'glitch']);
  assert.deepEqual(ovIds(), ['matrix', 'rings']);
  // Slow frames on the tunnel: effects go (to one, then none), then overlays.
  for (let round = 0; round < 80 && session.stepDown.stats.overlaySteps === 0; round += 1) await m.play(500, 100);
  assert.ok(session.stepDown.stats.fxSteps > 0 && session.stepDown.stats.overlaySteps > 0, 'stepped both down');
  await m.play(SETTLE_MS);
  const fxOnA = fxIds();
  const ovOnA = ovIds();
  assert.ok(fxOnA.length < 2 && ovOnA.length < 2, `drawn on the tunnel: ${fxOnA} / ${ovOnA}`);
  assert.ok(!ovOnA.includes('matrix'), 'the heavier overlay left out first');
  // Overlays held back after effects already were: the note says both.
  assert.equal(session.stepDown.level, 0);
  assert.equal(session.note.textContent, NOTES.fewerBoth);
  assert.equal(NOTES.fewerBoth, 'Fewer effects and overlays to keep this scene smooth');
  // The choice is whole: the panel's ticks and the hand sets.
  assert.deepEqual(session.fx.combo.ids.slice().sort(), ['bloom', 'glitch']);
  assert.deepEqual(session.overlays.chosen.map((item) => item.id).sort(), ['matrix', 'rings']);
  for (const id of ['bloom', 'glitch']) assert.equal(session.fx.boxes.get(id).checked, true, `${id} still ticked`);
  // A favourite saves what was chosen, not the shortened drawn list.
  click(controls.star);
  const saved = favouriteEntries(m.settings.visualizerFavourites);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].fx.slice().sort(), ['bloom', 'glitch']);
  assert.deepEqual(saved[0].overlays.map((item) => item.id).sort(), ['matrix', 'rings']);
  // Another scene: no cap, all four drawn again.
  session.sceneList.pick('starfield');
  await m.until(() => session.switcher.current === 'starfield', 'starfield');
  await m.play(SETTLE_MS);
  assert.deepEqual(fxIds(), ['bloom', 'glitch'], 'both effects again on another scene');
  assert.deepEqual(ovIds(), ['matrix', 'rings'], 'both overlays again on another scene');
  // Back to the tunnel: its shortened set straight away, and no note.
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel again');
  await m.play(SETTLE_MS);
  assert.deepEqual(fxIds(), fxOnA);
  assert.deepEqual(ovIds(), ovOnA);
  assert.equal(session.note.textContent, '');
  // A quality chosen by hand clears the step-down: all four on the tunnel.
  change(controls.qualitySelect, controls.qualitySelect.value);
  await m.play(SETTLE_MS);
  assert.equal(session.stepDown.lowered, false);
  assert.deepEqual(fxIds(), ['bloom', 'glitch'], 'both effects back with a quality chosen');
  assert.deepEqual(ovIds(), ['matrix', 'rings'], 'both overlays back with a quality chosen');
  session.destroy();
});

test('in the tab: the same overlay with other values reaches the layer (favourites shuffle gives Lasers fresh values)', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false,
      visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: ['tunnel/lasers', 'starfield/lasers'],
    },
  });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  assert.equal(session.switcher.current, 'tunnel');
  assert.deepEqual(session.overlays.layer.drawn.map((item) => item.id), ['lasers']);
  const first = JSON.stringify(session.overlays.layer.drawn[0].values);
  session.sceneList.pick('starfield');
  await m.until(() => session.switcher.current === 'starfield', 'starfield');
  await m.play(SETTLE_MS);
  const made = session.overlays.combo.items[0].values;
  assert.notEqual(JSON.stringify(made), first, 'favourites shuffle built Lasers with other values');
  assert.deepEqual(session.overlays.layer.drawn.map((item) => item.id), ['lasers']);
  assert.deepEqual(session.overlays.layer.drawn[0].values, made, 'the layer holds the new values');
  assert.deepEqual(session.overlays.layer.failedIds, [], 'drawn, not failed');
  session.destroy();
});

/* Effects that cannot be drawn here: a GL whose shaders fail for the effects
   named in `failing` (their fragment source), now or when their link ends. */
const FX_SRC = new Map(fxCatalog(loadPostFx({}).PostFxLibrary).map((fx) => [fx.id, fxFragment(fx.def.src, 'webgl2')]));
class PickyGL extends FakeGL {
  constructor(options) {
    super(options);
    this.failing = new Set();
  }
  getShaderParameter(shader) {
    return ![...this.failing].some((id) => shader?.source === FX_SRC.get(id));
  }
}
/** Transitions charged to the flash budget (or begun slow, the budget full). */
const charged = (session) => session.bridge.limiter.stats.transitions + session.transition.stats.slow;
const FX_AND_CAP = {
  visualizerScene: 'tunnel', visualizerShuffle: false, visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom', 'glitch'],
};
/** Slow frames until the step-down takes effects to one, then frames at the rate again. */
async function stepFxToOne(m) {
  const { session } = m;
  await m.until(() => session.fx.drawn.length === 2, 'both effects drawn');
  await m.play(SETTLE_MS);
  for (let round = 0; round < 80 && session.stepDown.stats.fxSteps === 0; round += 1) await m.play(500, 100);
  assert.equal(session.stepDown.fx, 1, 'effects stepped to one');
  await m.play(SETTLE_MS);
  assert.equal(session.fx.drawn.length, 1);
}
/** The hand set replaced by `ids` at once (one change: the latest wins). */
function chooseFx(session, ids) {
  for (const [id, box] of session.fx.boxes) if (box.checked && !ids.includes(id)) change(box, false);
  for (const id of ids) change(session.fx.boxes.get(id), true);
}

test('in the tab, under a cap of one: kept effects that fail one after another all give their slot on (planned again until one draws)', async () => {
  const gl = new PickyGL();
  const m = await mount({ gl, settings: FX_AND_CAP });
  const { session } = m;
  m.start();
  await stepFxToOne(m);
  // VHS, CRT and Dither cost the same: kept in that order. VHS and CRT fail
  // the moment they are asked for.
  gl.failing = new Set(['vhs', 'crt']);
  chooseFx(session, ['vhs', 'crt', 'dither']);
  await m.play(SETTLE_MS);
  assert.deepEqual(session.fx.combo.ids, ['vhs', 'crt', 'dither']);
  assert.deepEqual([...session.fx.failedIds].sort(), ['crt', 'vhs']);
  assert.deepEqual(session.fx.drawn, ['dither'], 'the third took the slot');
  assert.deepEqual(session.fx.capped, []);
  assert.equal(session.fx.drawnCount, 1, 'counted: the one drawn');
  session.destroy();
});

test('in the tab: one held back by the cap taking the place of a kept effect that failed while linking comes in through the transition (charged); the count follows every failure', async () => {
  const gl = new PickyGL({ parallel: true });
  gl.autoFinishAfter = 1;
  const m = await mount({ gl, settings: FX_AND_CAP });
  const { session } = m;
  m.start();
  await stepFxToOne(m);
  // VHS kept (still linking), CRT held back by the cap.
  gl.autoFinishAfter = Infinity;
  gl.failing = new Set(['vhs']);
  chooseFx(session, ['vhs', 'crt']);
  await m.play(SETTLE_MS);
  assert.ok(session.fx.chain.linking >= 1, 'linking');
  assert.deepEqual(session.fx.capped, ['crt']);
  assert.equal(session.fx.drawnCount, 1);
  await m.play(2000); // the flash budget has room again
  const before = charged(session);
  const fadesBefore = session.transition.stats.fades + session.transition.stats.dips;
  gl.finishCompiles(); // VHS fails
  await m.play(300);
  assert.deepEqual(session.fx.failedIds, ['vhs']);
  assert.equal(charged(session), before + 1, 'the replacement charged to the flash budget');
  assert.equal(session.transition.stats.fades + session.transition.stats.dips, fadesBefore + 1, 'through the transition');
  await m.play(SETTLE_MS); // made when the transition lets it
  assert.deepEqual(session.fx.chain.passes.map((pass) => pass.id), ['crt']);
  gl.finishCompiles(); // CRT links
  await m.play(300);
  assert.deepEqual(session.fx.drawn, ['crt']);
  assert.equal(session.fx.drawnCount, 1);
  // Nothing held back: the only kept one failing while linking drops the
  // count at once (the next notch is not spent on it).
  gl.failing = new Set(['grain']);
  chooseFx(session, ['grain']);
  await m.play(SETTLE_MS);
  assert.equal(session.fx.drawnCount, 1, 'linking: counted');
  gl.finishCompiles();
  await m.play(300);
  assert.deepEqual(session.fx.failedIds, ['grain']);
  assert.deepEqual(session.fx.capped, []);
  assert.equal(session.fx.drawnCount, 0, 'failed: no longer counted');
  session.destroy();
});

test('in the tab: an overlay that fails while drawn leaves at once; one held back by the cap comes in through the transition (charged)', async () => {
  const pattern = OVERLAY_PATTERNS.harmonograph;
  const draw = pattern.draw;
  let broken = false;
  pattern.draw = (...args) => { if (broken) throw new Error('harmonograph broken here'); return draw.apply(pattern, args); };
  try {
    const m = await mount({
      settings: {
        visualizerScene: 'tunnel', visualizerShuffle: false, visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['harmonograph', 'hexgrid'],
      },
    });
    const { session } = m;
    m.start();
    await m.play(SETTLE_MS);
    assert.deepEqual(session.overlays.drawn.map((item) => item.id).sort(), ['harmonograph', 'hexgrid']);
    for (let round = 0; round < 80 && session.stepDown.stats.overlaySteps === 0; round += 1) await m.play(500, 100);
    await m.play(SETTLE_MS);
    assert.deepEqual(session.overlays.drawn.map((item) => item.id), ['harmonograph'], 'the light one kept');
    await m.play(2000);
    const before = charged(session);
    const fadesBefore = session.transition.stats.fades + session.transition.stats.dips;
    broken = true;
    await m.play(300);
    assert.ok(session.overlays.layer.failedIds.includes('harmonograph'));
    assert.ok(!session.overlays.drawn.some((item) => item.id === 'harmonograph'), 'the failed one left at once');
    await m.play(SETTLE_MS); // the held-back one, when the transition lets it
    assert.deepEqual(session.overlays.drawn.map((item) => item.id), ['hexgrid'], 'the held-back one took the slot');
    assert.equal(charged(session), before + 1, 'charged to the flash budget');
    assert.equal(session.transition.stats.fades + session.transition.stats.dips, fadesBefore + 1, 'through the transition');
    session.destroy();
  } finally {
    pattern.draw = draw;
  }
});

test('in the tab: a waiting change of what the caps draw that became moot is dropped, and charges no transition', async () => {
  const m = await mount({ settings: { ...FX_AND_CAP, visualizerOverlayShuffle: false, visualizerOverlaySet: [] } });
  const { session, controls } = m;
  m.start();
  await m.until(() => session.fx.drawn.length === 2, 'both effects drawn');
  await m.play(SETTLE_MS + 2000);
  // A change in progress (overlays on), then a notch while it runs: the
  // effects' change to one waits for it.
  change(controls.overlaysToggle, true);
  // Past its dark half (a change waiting for that is made in the dark, free):
  // one asked for now waits for the end, then would begin one of its own.
  for (let i = 0; i < 100 && !['in', 'fading'].includes(session.transition.phase); i += 1) m.h.run(10, 10);
  assert.ok(['in', 'fading'].includes(session.transition.phase), `a change in progress (${session.transition.phase})`);
  let t = m.h.now + 1;
  let stepped = false;
  for (let i = 0; i < 2000 && !stepped; i += 1) { t += 100; stepped = session.stepDown.frame(t); }
  assert.ok(stepped, 'a notch');
  assert.equal(session.stepDown.fx, 1);
  assert.equal(session.fx.drawn.length, 2, 'still both: the change waits');
  // A quality chosen before it is made: nothing left for it to change.
  change(controls.qualitySelect, controls.qualitySelect.value);
  const before = charged(session);
  const begun = session.transition.stats.fades + session.transition.stats.dips + session.transition.stats.waits;
  await m.play(SETTLE_MS);
  assert.equal(session.fx.drawn.length, 2);
  assert.equal(charged(session), before, 'nothing charged');
  assert.equal(session.transition.stats.fades + session.transition.stats.dips + session.transition.stats.waits, begun, 'no transition begun or waited for');
  session.destroy();
});

test('in the tab: a blend-in the new scene forbids is not blended over it, not even for the fade out (a calm scene)', async () => {
  for (const target of [calm]) {
    const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['petals', 'ribbons~db'] } });
    const { session } = m;
    m.start();
    await m.play(SETTLE_MS);
    assert.deepEqual(session.overlays.layer.blendSheet?.blend, { ...PLAIN_BLEND, mode: 'difference', mask: 'bright' }, 'blended on Tunnel');
    session.sceneList.pick(target.id);
    let checked = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      m.h.run(1000 / 30, 1000 / 30);
      await settle(() => false, 2);
      if (session.switcher.current !== target.id) continue;
      const shown = session.overlays.layer.blendSheet;
      if (shown) {
        const asShown = { id: shown.id, blend: shown.blend };
        assert.equal(overlayToken(overlaysDrawnFor(target, [asShown])[0]), overlayToken(asShown), `${target.id}: ${overlayToken(asShown)} blended over it`);
      }
      checked += 1;
    }
    assert.ok(checked > 20, `${target.id}: frames looked at after the cut (${checked})`);
    assert.ok(session.overlays.layer.stats.blendDrops >= 1, 'dropped at the cut');
    assert.ok(session.overlays.drawn.some((x) => x.id === 'petals'), 'the plain one stays');
    session.destroy();
  }
});

test('in the tab: switching the blend-in off while effects stay on frees the overlay texture at once', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: ['bloom'],
      visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['rings~s'],
    },
  });
  const { session, gl } = m;
  m.start();
  await m.until(() => session.fx.chain?.overlayHeld, 'overlay texture');
  await m.play(SETTLE_MS);
  const chain = session.fx.chain;
  assert.equal(chain.overlayHeld, true);
  assert.ok(chain.count > 0, 'an effect is on');
  const row = session.overlays.rows[0];
  change(row.mode, 'add');
  await m.play(SETTLE_MS);
  assert.deepEqual(session.overlays.drawn.map(overlayToken), ['rings']);
  assert.equal(chain.active, true, 'the effect still draws');
  assert.equal(chain.overlayHeld, false, 'no overlay texture held');
  const uploads = gl.uploads;
  await m.play(1000);
  assert.equal(gl.uploads, uploads, 'no upload either');
  session.destroy();
});

test('in the tab: overlays that cannot be drawn here hold no slot, leave the choice with the next change and say so', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    const m = await mount({
      failOverlays: true,
      settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['rings', 'lasers', 'petals'] },
    });
    const { session } = m;
    m.start();
    await m.until(() => session.overlays.layer?.failed, 'module failed');
    await m.play(SETTLE_MS);
    assert.deepEqual(session.overlays.drawn.map((x) => x.id), ['petals'], 'ours still drawn');
    const boxes = session.overlays.boxes;
    for (const id of ['rings', 'lasers']) {
      assert.equal(boxes.get(id).checked, false, id);
      assert.equal(boxes.get(id).disabled, true, id);
      assert.equal(session.overlays.fields.get(id).title, OVERLAY_TEXT.failedOne, id);
    }
    assert.match(session.overlays.note.textContent, /Could not be drawn on this computer: Lasers, Pulse Rings|Could not be drawn on this computer: Pulse Rings, Lasers/);
    // Three chosen, two of them broken: a working one can still be ticked.
    assert.equal(boxes.get('ribbons').disabled, false, 'the broken ones hold no slot');
    change(boxes.get('ribbons'), true);
    assert.deepEqual(session.overlays.chosen.map((x) => x.id), ['petals', 'ribbons'], 'the broken ones left the choice');
    assert.deepEqual(m.settings.visualizerOverlaySet, ['petals', 'ribbons']);
    change(boxes.get('rings'), true);
    assert.deepEqual(session.overlays.chosen.map((x) => x.id), ['petals', 'ribbons'], 'a broken one is not ticked back');
    await m.play(SETTLE_MS);
    assert.deepEqual(session.overlays.drawn.map((x) => x.id), ['petals', 'ribbons']);
    session.destroy();
    // A blend change is a change too: the broken ones leave the choice.
    const m2 = await mount({
      failOverlays: true,
      settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['rings', 'petals'] },
    });
    m2.start();
    await m2.until(() => m2.session.overlays.layer?.failed, 'module failed');
    await m2.play(500);
    const petalsRow = m2.session.overlays.rows.find((row) => row.id === 'petals');
    change(petalsRow.tint, true);
    assert.deepEqual(m2.session.overlays.chosen.map(overlayToken), ['petals~at'], 'the broken one left with the blend change');
    assert.deepEqual(m2.settings.visualizerOverlaySet, ['petals~at']);
    m2.session.destroy();
  } finally {
    console.error = error;
  }
});

test('in the tab: each blend row is a group named by its overlay, and each control names the overlay too', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['rings', 'petals'] } });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  const [first, second] = session.overlays.rows;
  for (const [row, label] of [[first, 'Pulse Rings'], [second, 'Petal Mandala']]) {
    assert.equal(row.row.getAttribute('role'), 'group');
    const nameId = row.row.getAttribute('aria-labelledby');
    assert.ok(nameId && row.name.getAttribute('id') === nameId, 'labelled by its name');
    assert.equal(row.name.textContent, label);
    for (const control of [row.mode, row.mask, row.under, row.tint, row.bend]) {
      assert.ok((control.getAttribute('aria-label') || '').endsWith(`: ${label}`), `${control.className}: ${control.getAttribute('aria-label')}`);
    }
  }
  assert.notEqual(first.mode.getAttribute('aria-label'), second.mode.getAttribute('aria-label'), 'the two Blend choices differ');
  session.destroy();
});

test('in the tab: Strobe\'s row has a Style choice that every set drawn keeps; overlays without styles show none', async () => {
  assert.deepEqual(overlayRow('color_strobe').styles.length, 4);
  assert.equal(overlayRow('rings').styles, undefined);
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: ['color_strobe', 'rings'] } });
  const { session } = m;
  m.start();
  await m.play(SETTLE_MS);
  const strobeRow = session.overlays.rows.find((row) => row.id === 'color_strobe');
  const ringsRow = session.overlays.rows.find((row) => row.id === 'rings');
  assert.ok(strobeRow && ringsRow);
  assert.equal(strobeRow.styleField.hidden, false);
  assert.equal(ringsRow.styleField.hidden, true);
  assert.equal(strobeRow.style.value, 'any');
  assert.equal(strobeRow.style.getAttribute('aria-label'), 'Style: Strobe');
  assert.deepEqual([...strobeRow.style.children].map((option) => option.value), ['any', '0', '1', '2', '3']);
  const before = session.overlays.stats.byHand;
  change(strobeRow.style, '2');
  await m.play(SETTLE_MS);
  const strobeValues = () => session.overlays.combo.items.find((item) => item.id === 'color_strobe').values;
  assert.equal(strobeValues().style, 2);
  assert.equal(strobeRow.style.value, '2');
  assert.equal(session.overlays.stats.byHand, before + 1);
  // A blend changed afterwards, and a fresh set: the style is kept.
  change(strobeRow.tint, true);
  await m.play(SETTLE_MS);
  assert.equal(strobeValues().style, 2);
  change(strobeRow.style, '0');
  await m.play(SETTLE_MS);
  assert.equal(strobeValues().style, 0);
  // Any: left as drawn until the next set.
  change(strobeRow.style, 'any');
  assert.equal(strobeRow.style.value, 'any');
  assert.equal(strobeValues().style, 0);
  session.destroy();
});

test('favouriteToRecall: the first favourite of the scene, then the one after what is shown, round again; none starred: null', () => {
  const list = ['tunnel|bloom/rings~su', 'aurora:2/petals', 'tunnel/petals', 'tunnel'];
  const keyOf = (entry) => favouriteKey(entry.scene, entry.look, entry.fx, entry.overlays);
  assert.equal(favouriteToRecall(list, 'plasma'), null);
  const first = favouriteToRecall(list, 'tunnel');
  assert.equal(keyOf(first), 'tunnel|bloom/rings~su');
  assert.equal(keyOf(favouriteToRecall(list, 'tunnel', 'tunnel|kaleido')), 'tunnel|bloom/rings~su', 'what is shown is none of them');
  assert.equal(keyOf(favouriteToRecall(list, 'tunnel', 'tunnel|bloom/rings~su')), 'tunnel/petals');
  assert.equal(keyOf(favouriteToRecall(list, 'tunnel', 'tunnel/petals')), 'tunnel');
  assert.equal(keyOf(favouriteToRecall(list, 'tunnel', 'tunnel')), 'tunnel|bloom/rings~su', 'round again');
  const aurora = favouriteToRecall(list, 'aurora');
  assert.deepEqual([aurora.look, aurora.fx, aurora.overlays], [2, [], [{ id: 'petals', blend: PLAIN_BLEND }]]);
});

test('in the tab: a scene picked from the list\'s favourites comes with its starred look, effects and overlays alike, whatever the shuffle, the next favourite each time; from the whole list, as before', async () => {
  const m = await mount({
    settings: {
      visualizerScene: 'starfield', visualizerShuffle: false,
      visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: [],
      visualizerOverlays: true, visualizerOverlayShuffle: false, visualizerOverlaySet: [],
      visualizerFavourites: ['tunnel|bloom/rings~su', 'aurora:2/petals', 'tunnel/petals'],
    },
  });
  const { session, controls } = m;
  const list = session.sceneList;
  const fxNow = () => session.fx.chain.ids.join('+');
  const drawn = () => session.overlays.drawn.map(overlayToken).join('+');
  const ticked = () => session.overlays.chosen.map(overlayToken).join('+');
  const starred = () => controls.star.getAttribute('aria-pressed');
  const savedKeys = () => new Set(m.saved.flatMap((partial) => Object.keys(partial)));
  m.start();
  await m.play(3000);
  // From the whole list: the scene with the hand sets (none here), as before.
  list.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.play(2000);
  assert.deepEqual([fxNow(), drawn(), starred()], ['', '', 'false']);
  // The Favourites filter's tooltip says what picking there does.
  assert.equal(controls.favouritesOnly.getAttribute('title'), FAVOURITES_FILTER_TITLE);
  // From the favourites: another scene comes with its look and overlays.
  controls.sceneButton.dispatchEvent(new Event('click'));
  click(controls.favouritesOnly);
  list.pick('aurora');
  await m.until(() => session.switcher.current === 'aurora', 'aurora');
  await m.play(2000);
  assert.deepEqual([fxNow(), drawn(), ticked(), starred()], ['', 'petals', 'petals', 'true'], 'its starred look too (the star)');
  // And the scene with effects and an overlay blended in.
  list.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel again');
  await m.play(2000);
  assert.deepEqual([fxNow(), drawn(), ticked(), starred()], ['bloom', 'rings~su', 'rings~su', 'true']);
  // Picked again while it is shown: its next favourite, in place.
  list.pick('tunnel');
  await m.play(3000);
  assert.deepEqual([fxNow(), drawn(), ticked(), starred()], ['', 'petals', 'petals', 'true']);
  list.pick('tunnel');
  await m.play(3000);
  assert.deepEqual([fxNow(), drawn(), starred()], ['bloom', 'rings~su', 'true'], 'round again');
  // Shown, not chosen: the hand sets and saved looks are left as they were.
  for (const name of ['visualizerFxSet', 'visualizerOverlaySet', 'visualizerLooks']) assert.ok(!savedKeys().has(name), name);
  // The filter off again: the whole list, the hand sets.
  click(controls.favouritesOnly);
  list.pick('starfield');
  await m.until(() => session.switcher.current === 'starfield', 'starfield');
  await m.play(2000);
  assert.deepEqual([fxNow(), drawn()], ['bloom', 'rings~su'], 'what was drawn stays (nothing recalled, nothing shuffled)');
  session.destroy();
});

/* The shuffle picks only what is drawn: a roll asks for no more than the
   step-down lets the picture draw, and a set the shuffle made is cut to what
   is drawn when a cap comes in, so no shuffled effect or overlay is ticked
   and struck through at once. Sets chosen by hand and favourites are never
   cut (the cap only shortens what they draw). */
const SHUFFLED_FX = {
  visualizerScene: 'tunnel', visualizerShuffle: false, visualizerFx: true, visualizerFxShuffle: true,
  visualizerFxTiming: 16, visualizerFxIntensity: 'strong',
};
/** Effects ticked in the panel that are also marked as not drawn here. */
const fxTickedAndStruck = (session) => [...session.fx.boxes]
  .filter(([, box]) => box.checked && box.getAttribute('aria-disabled') === 'true').map(([id]) => id);
const ovTickedAndStruck = (session) => [...session.overlays.boxes]
  .filter(([id, box]) => box.checked && session.overlays.fields.get(id).classList.contains('viz-fx-unavailable')).map(([id]) => id);
/** "New effects now" until at least `count` are drawn. */
async function rollFxUntil(m, count) {
  const { session } = m;
  for (let round = 0; round < 40 && session.fx.drawn.length < count; round += 1) {
    click(session.controls.fxNow);
    await m.play(SETTLE_MS);
  }
  assert.ok(session.fx.drawn.length >= count, `the shuffle drew ${count} or more`);
}

test('in the tab: a notch while a shuffled set of effects shows cuts the set to what is drawn; later rolls ask for no more than that', async () => {
  const m = await mount({ settings: SHUFFLED_FX });
  const { session } = m;
  m.start();
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  await rollFxUntil(m, 2);
  assert.equal(session.fx.combo.shuffled, true);
  for (let round = 0; round < 80 && session.stepDown.stats.fxSteps === 0; round += 1) await m.play(500, 100);
  await m.play(SETTLE_MS);
  const most = session.stepDown.fx;
  assert.ok(most < 2, `effects held back to ${most}`);
  assert.ok(session.fx.combo === null || session.fx.combo.ids.length <= most, 'the shuffled set cut to what is drawn');
  assert.deepEqual(fxTickedAndStruck(session), []);
  assert.ok(session.fx.stats.trimmed > 0);
  // Rolled again under the cap: never asked for more than it.
  const asked = [];
  const next = session.fx.shuffle.next;
  session.fx.shuffle.next = (context) => { asked.push(context.maxCount); return next(context); };
  for (let round = 0; round < 12; round += 1) {
    click(session.controls.fxNow);
    await m.play(SETTLE_MS);
    assert.ok((session.fx.combo?.ids.length || 0) <= session.stepDown.fx, `roll ${round}: ${session.fx.combo?.ids}`);
    assert.deepEqual(fxTickedAndStruck(session), []);
  }
  assert.equal(asked.length, 12);
  assert.ok(asked.every((count) => count <= most), `asked for ${asked}`);
  session.destroy();
});

test('in the tab: a shuffled set kept onto a scene that needed fewer effects before is cut there', async () => {
  const m = await mount({ settings: SHUFFLED_FX });
  const { session } = m;
  m.start();
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  await rollFxUntil(m, 2);
  for (let round = 0; round < 80 && session.stepDown.stats.fxSteps === 0; round += 1) await m.play(500, 100);
  await m.play(SETTLE_MS);
  const most = session.stepDown.fx;
  // Another scene (no cap): a larger set rolled there, kept (bar timing).
  session.sceneList.pick('starfield');
  await m.until(() => session.switcher.current === 'starfield', 'starfield');
  await m.play(SETTLE_MS);
  await rollFxUntil(m, 2);
  const there = session.fx.combo.ids.slice();
  // Back: the tunnel's remembered cap cuts it at once.
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  await m.play(SETTLE_MS);
  assert.equal(session.stepDown.fx, most);
  assert.ok((session.fx.combo?.ids.length || 0) <= most, `${there} cut to ${session.fx.combo?.ids}`);
  assert.ok((session.fx.combo?.ids || []).every((id) => there.includes(id)), 'from the same set');
  assert.deepEqual(fxTickedAndStruck(session), []);
  session.destroy();
});

test('in the tab: a shuffled set asked for while a change is in progress, with a notch before it is made, is cut when it is made', async () => {
  const m = await mount({ settings: { ...SHUFFLED_FX, visualizerOverlayShuffle: false, visualizerOverlaySet: [] } });
  const { session, controls } = m;
  m.start();
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  await rollFxUntil(m, 2);
  await m.play(2000);
  // A change in progress, past its dark half; then a roll (no cap yet) waits.
  change(controls.overlaysToggle, true);
  for (let i = 0; i < 100 && !['in', 'fading'].includes(session.transition.phase); i += 1) m.h.run(10, 10);
  let asked = 0;
  for (let tries = 0; tries < 20 && asked < 2; tries += 1) {
    click(controls.fxNow);
    asked = [...session.fx.boxes.values()].filter((box) => box.checked).length;
  }
  assert.ok(asked >= 2, `a roll of ${asked} waiting`);
  // A notch before it is made.
  let t = m.h.now + 1;
  let stepped = false;
  for (let i = 0; i < 2000 && !stepped; i += 1) { t += 100; stepped = session.stepDown.frame(t); }
  assert.ok(stepped, 'a notch');
  const most = session.stepDown.fx;
  assert.ok(most < asked);
  await m.play(SETTLE_MS);
  assert.ok((session.fx.combo?.ids.length || 0) <= most, `made and cut: ${session.fx.combo?.ids}`);
  assert.deepEqual(fxTickedAndStruck(session), []);
  session.destroy();
});

test('in the tab: overlays the shuffle picked are cut to what is drawn on a notch and rolled under the cap after; a favourite\'s effects are never cut', async () => {
  const m = await mount({
    settings: { visualizerScene: 'tunnel', visualizerShuffle: false, visualizerOverlays: true, visualizerOverlayShuffle: true },
  });
  const { session, controls } = m;
  m.start();
  await m.play(SETTLE_MS);
  for (let round = 0; round < 40 && session.overlays.drawn.length < 2; round += 1) {
    click(controls.overlaysNow);
    await m.play(SETTLE_MS);
  }
  assert.ok(session.overlays.drawn.length >= 2, 'the shuffle drew two or more');
  for (let round = 0; round < 80 && session.stepDown.stats.overlaySteps === 0; round += 1) await m.play(500, 100);
  await m.play(SETTLE_MS);
  const most = session.stepDown.overlays;
  assert.ok(most < 2);
  assert.ok(session.overlays.chosen.length <= most, 'cut to what is drawn');
  assert.deepEqual(ovTickedAndStruck(session), []);
  const asked = [];
  const next = session.overlays.shuffle.next;
  session.overlays.shuffle.next = (context) => { asked.push(context.maxCount); return next(context); };
  for (let round = 0; round < 12; round += 1) {
    click(controls.overlaysNow);
    await m.play(SETTLE_MS);
    assert.ok(session.overlays.chosen.length <= session.stepDown.overlays, `roll ${round}`);
    assert.deepEqual(ovTickedAndStruck(session), []);
  }
  assert.ok(asked.length === 12 && asked.every((count) => count <= most), `asked for ${asked}`);
  session.destroy();
  // A favourite's effects (favourites shuffle): what is drawn is shortened,
  // the set never.
  const f = await mount({
    settings: {
      visualizerScene: 'tunnel', visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: ['tunnel|bloom+glitch'],
      visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: [],
    },
  });
  f.start();
  await f.until(() => f.session.fx.drawn.length === 2, 'the favourite\'s two effects');
  await f.play(SETTLE_MS);
  assert.notEqual(f.session.fx.combo.shuffled, true);
  for (let round = 0; round < 80 && f.session.stepDown.stats.fxSteps === 0; round += 1) await f.play(500, 100);
  await f.play(SETTLE_MS);
  assert.equal(f.session.stepDown.fx, 1);
  assert.equal(f.session.fx.drawn.length, 1);
  assert.deepEqual(f.session.fx.combo.ids.slice().sort(), ['bloom', 'glitch'], 'the favourite stays whole');
  f.session.destroy();
});

test('the shuffles: a set cut to fewer or none takes the place of the rolled one in their history (no new entry); with nothing allowed a roll is empty at once, no retries', () => {
  const catalog = fxCatalog(loadPostFx({}).PostFxLibrary);
  const fx = createFxShuffle({ catalog, random: seededRandom(7) });
  const context = { intensity: 'strong', maxCount: 3, costBudget: 99, costMax: 'heavy' };
  let rolled = fx.next(context);
  for (let tries = 0; tries < 50 && rolled.ids.length < 2; tries += 1) rolled = fx.next(context);
  assert.ok(rolled.ids.length >= 2);
  fx.shown(rolled);
  const before = fx.recent.length;
  fx.cut({ ids: rolled.ids.slice(0, 1) });
  assert.deepEqual(fx.last, rolled.ids.slice(0, 1));
  assert.equal(fx.recent.length, before, 'no new entry');
  assert.equal(fx.recent.at(-1), fxKey(rolled.ids.slice(0, 1)));
  fx.cut({ ids: [] });
  assert.deepEqual(fx.last, []);
  assert.equal(fx.recent.length, before - 1, 'an empty set has no key');
  // Nothing showed: the next roll is not empty (no empty set twice running).
  for (let roll = 0; roll < 20; roll += 1) assert.ok(fx.next(context).ids.length > 0);
  // Nothing allowed: empty at once.
  const retries = fx.stats.retries;
  for (let roll = 0; roll < 5; roll += 1) assert.deepEqual(fx.next({ ...context, maxCount: 0 }).ids, []);
  assert.equal(fx.stats.retries, retries, 'no retries');

  const ov = createOverlayShuffle({ random: seededRandom(7) });
  const ovContext = { maxCount: 3, costBudget: 99, costMax: 'heavy', entry: lively, blendIns: false, bend: false };
  let set = ov.next(ovContext);
  for (let tries = 0; tries < 50 && set.items.length < 2; tries += 1) set = ov.next(ovContext);
  assert.ok(set.items.length >= 2);
  ov.shown(set);
  const ovBefore = ov.recent.length;
  ov.cut({ items: set.items.slice(0, 1) });
  assert.deepEqual(ov.last, [set.items[0].id]);
  assert.equal(ov.recent.length, ovBefore);
  assert.equal(ov.recent.at(-1), overlaysKey(set.items.slice(0, 1)));
  ov.cut({ items: [] });
  assert.deepEqual(ov.last, []);
  assert.equal(ov.recent.length, ovBefore - 1);
  for (let roll = 0; roll < 20; roll += 1) assert.ok(ov.next(ovContext).items.length > 0);
  const ovRetries = ov.stats.retries;
  for (let roll = 0; roll < 5; roll += 1) assert.deepEqual(ov.next({ ...ovContext, maxCount: 0 }).items, []);
  assert.equal(ov.stats.retries, ovRetries, 'no retries');
});

test('in the tab: a shuffled set trimmed by a lower quality stays the shuffle\'s (a later cap cuts it); a box ticked by hand makes it the hand\'s', async () => {
  const m = await mount({ settings: { ...SHUFFLED_FX, visualizerQuality: 'medium' } });
  const { session, controls } = m;
  m.start();
  await m.until(() => Boolean(session.fx.shuffle), 'library');
  await rollFxUntil(m, 3);
  change(controls.qualitySelect, 'low');
  await m.play(SETTLE_MS);
  assert.equal(session.fx.combo.ids.length, 2, 'trimmed to Low\'s two');
  assert.equal(session.fx.combo.shuffled, true, 'still the shuffle\'s');
  for (let round = 0; round < 80 && session.stepDown.stats.fxSteps === 0; round += 1) await m.play(500, 100);
  await m.play(SETTLE_MS);
  assert.ok((session.fx.combo?.ids.length || 0) <= session.stepDown.fx, 'cut by the cap');
  assert.deepEqual(fxTickedAndStruck(session), []);
  assert.deepEqual(session.fx.shuffle.last, session.fx.combo ? session.fx.combo.ids : [], 'the history holds what is shown');
  // A box ticked by hand: the hand's set, never cut.
  const free = [...session.fx.boxes].find(([id, box]) => !box.checked && !box.disabled)[0];
  change(session.fx.boxes.get(free), true);
  await m.play(SETTLE_MS);
  assert.notEqual(session.fx.combo.shuffled, true);
  session.destroy();
});

test('in the tab: overlays the shuffle picked, trimmed by a lower quality, stay the shuffle\'s; a blend row changed by hand makes them the hand\'s', async () => {
  const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerShuffle: false, visualizerQuality: 'medium', visualizerOverlays: true, visualizerOverlayShuffle: true } });
  const { session, controls } = m;
  m.start();
  await m.play(SETTLE_MS);
  // Three plain ones, as the shuffle gives them.
  const next = session.overlays.shuffle.next;
  session.overlays.shuffle.next = () => session.overlays.shuffle.build([{ id: 'rings' }, { id: 'petals' }, { id: 'ribbons' }]);
  click(controls.overlaysNow);
  session.overlays.shuffle.next = next;
  await m.play(SETTLE_MS);
  assert.equal(session.overlays.combo.items.length, 3);
  change(controls.qualitySelect, 'low');
  await m.play(SETTLE_MS);
  assert.equal(session.overlays.combo.items.length, 2, 'trimmed to Low\'s two');
  assert.equal(session.overlays.combo.shuffled, true, 'still the shuffle\'s');
  // A blend row changed by hand.
  const row = session.overlays.rows.find((r) => !r.row.hidden);
  change(row.tint, true);
  await m.play(SETTLE_MS);
  assert.notEqual(session.overlays.combo.shuffled, true);
  session.destroy();
});

test('in the tab: the cap cuts a shuffled set of overlays to what is drawn, but one that failed here stays in it (its note still shows)', async () => {
  const pattern = OVERLAY_PATTERNS.harmonograph;
  const draw = pattern.draw;
  pattern.draw = () => { throw new Error('harmonograph broken here'); };
  const errors = console.error;
  console.error = () => {};
  try {
    const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerShuffle: false, visualizerOverlays: true, visualizerOverlayShuffle: true } });
    const { session, controls } = m;
    m.start();
    await m.play(SETTLE_MS);
    const next = session.overlays.shuffle.next;
    session.overlays.shuffle.next = () => session.overlays.shuffle.build([{ id: 'harmonograph' }, { id: 'rings' }, { id: 'petals' }]);
    click(controls.overlaysNow);
    session.overlays.shuffle.next = next;
    await m.play(SETTLE_MS);
    assert.ok(session.overlays.layer.failedIds.includes('harmonograph'));
    assert.deepEqual(session.overlays.drawn.map((x) => x.id).sort(), ['petals', 'rings']);
    for (let round = 0; round < 80 && session.stepDown.stats.overlaySteps === 0; round += 1) await m.play(500, 100);
    await m.play(SETTLE_MS);
    assert.equal(session.stepDown.overlays, 1);
    const ids = session.overlays.combo.items.map((x) => x.id);
    assert.ok(ids.includes('harmonograph'), `the failed one stays: ${ids}`);
    assert.equal(ids.length, 2, 'one of the two drawn left out');
    assert.deepEqual(session.overlays.shuffle.last.sort(), ids.slice().sort(), 'the history holds the set as cut');
    assert.match(session.overlays.note.textContent, /Harmonograph/i);
    assert.deepEqual(ovTickedAndStruck(session), []);
    session.destroy();
  } finally {
    pattern.draw = draw;
    console.error = errors;
  }
});
/* ---------------- Pairs never drawn together ---------------- */

test('a pair never combined (FX_CLASHES): of two chosen only the first in the chain is drawn, on any scene; the other stays chosen; a scene that drops one draws the other', () => {
  const tunnel = SCENES.find((scene) => scene.id === 'tunnel');
  const plasma = SCENES.find((scene) => scene.id === 'plasma');
  // Palette Map's two (slice 12), in either order chosen: the chain's order decides.
  for (const ids of [['palette_map', 'halftone'], ['halftone', 'palette_map']]) {
    const ordered = fxOrder(CATALOG6, ids);
    assert.deepEqual(fxDrawnFor(tunnel, ordered), ['palette_map'], ids.join('+'));
    assert.deepEqual(fxClashedFor(tunnel, ordered), ['halftone']);
  }
  assert.deepEqual(fxDrawnFor(tunnel, fxOrder(CATALOG6, ['palette_map', 'fisheye'])), ['fisheye']);
  // Every older pair the same way, with a third one (in no pair) untouched.
  assert.ok(!FX_CLASHES.flat().includes('relief'));
  for (const [a, b] of FX_CLASHES) {
    const ordered = fxOrder(CATALOG6, [a, b, 'relief']);
    const drawn = fxDrawnFor(tunnel, ordered);
    assert.ok(!(drawn.includes(a) && drawn.includes(b)), `${a}+${b}: never both`);
    assert.ok(drawn.includes('relief') && drawn.length === 2, `${a}+${b}: ${drawn.join('+')}`);
  }
  // Plasma (calm) never draws Palette Map: Halftone is then drawn, not held back.
  assert.deepEqual(fxDrawnFor(plasma, fxOrder(CATALOG6, ['palette_map', 'halftone'])), ['halftone']);
  assert.deepEqual(fxClashedFor(plasma, ['palette_map', 'halftone']), []);
});

test('in the tab: a pair ticked by hand in either order, restored from the settings, recalled from a favourite or under the step-down\'s cap is never drawn together; the other is greyed with the "would flicker" note', async () => {
  const pairDrawn = (session) => ['palette_map', 'halftone'].every((id) => session.fx.chain.ids.includes(id))
    || ['palette_map', 'fisheye'].every((id) => session.fx.chain.ids.includes(id));
  // By hand, both orders.
  for (const order of [['palette_map', 'halftone'], ['halftone', 'palette_map']]) {
    const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerShuffle: false, visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: [] } });
    const { session } = m;
    await m.until(() => Boolean(session.fx.shuffle), 'library');
    m.start();
    for (const id of order) change(session.fx.boxes.get(id), true);
    await m.play(SETTLE_MS);
    assert.deepEqual(session.fx.combo.ids, ['palette_map', 'halftone'], `${order.join(' then ')}: both stay chosen`);
    assert.deepEqual(session.fx.chain.ids, ['palette_map'], `${order.join(' then ')}: one drawn`);
    assert.equal(session.fx.boxes.get('halftone').checked, true);
    assert.equal(session.fx.boxes.get('halftone').getAttribute('aria-disabled'), 'true');
    assert.equal(session.fx.boxes.get('palette_map').getAttribute('aria-disabled'), 'false');
    assert.ok(session.fx.note.textContent.includes(FX_TEXT.pairHere), session.fx.note.textContent);
    // Untick the drawn one: the other comes in.
    change(session.fx.boxes.get('palette_map'), false);
    await m.play(SETTLE_MS);
    assert.deepEqual(session.fx.chain.ids, ['halftone']);
    assert.equal(session.fx.boxes.get('halftone').getAttribute('aria-disabled'), 'false');
    assert.ok(!session.fx.note.textContent.includes(FX_TEXT.pairHere));
    session.destroy();
  }
  // Restored from the settings (a reload).
  for (const [set, drawn, greyed] of [[['palette_map', 'halftone'], ['palette_map'], 'halftone'], [['fisheye', 'palette_map'], ['fisheye'], 'palette_map']]) {
    const m = await mount({ settings: { visualizerScene: 'tunnel', visualizerShuffle: false, visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: set } });
    const { session } = m;
    await m.until(() => Boolean(session.fx.shuffle), 'library');
    m.start();
    await m.play(SETTLE_MS);
    assert.deepEqual(session.fx.chain.ids, drawn, `reload: ${set.join('+')}`);
    assert.equal(session.fx.boxes.get(greyed).getAttribute('aria-disabled'), 'true');
    session.destroy();
  }
  // Recalled from a favourite (the favourites shuffle).
  {
    const m = await mount({
      settings: {
        visualizerScene: 'plasma', visualizerFx: true, visualizerFxShuffle: true, visualizerShuffle: true, visualizerShufflePool: 'favourites',
        visualizerFavourites: ['tunnel|palette_map+halftone', 'starfield|fisheye+palette_map'],
      },
    });
    const { session } = m;
    await m.until(() => Boolean(session.fx.shuffle), 'library');
    m.start();
    for (const scene of ['tunnel', 'starfield']) {
      session.sceneList.pick(scene);
      await m.until(() => session.switcher.current === scene, scene);
      await m.play(SETTLE_MS);
      assert.equal(session.fx.chain.ids.length, 1, `${scene}: ${session.fx.chain.ids.join('+')}`);
      assert.ok(!pairDrawn(session), scene);
    }
    session.destroy();
  }
  // Under the step-down's cap.
  {
    const m = await mount({ settings: FX_AND_CAP });
    const { session } = m;
    m.start();
    await stepFxToOne(m);
    chooseFx(session, ['palette_map', 'halftone']);
    await m.play(SETTLE_MS);
    assert.deepEqual(session.fx.chain.ids, ['palette_map']);
    assert.deepEqual(session.fx.capped, [], 'the pair, not the cap, held Halftone back');
    chooseFx(session, ['fisheye', 'palette_map', 'bloom']);
    await m.play(SETTLE_MS);
    assert.equal(session.fx.chain.ids.length, 1);
    assert.ok(!pairDrawn(session));
    session.destroy();
  }
});

test('in the tab: the first of a pair failing here never holds its partner back; the partner is drawn and not greyed', async () => {
  const settings = (set) => ({ visualizerScene: 'tunnel', visualizerShuffle: false, visualizerFx: true, visualizerFxShuffle: false, visualizerFxSet: set });
  for (const pair of [['fisheye', 'palette_map'], ['posterize', 'dither'], ['crt', 'vision']]) {
    assert.ok(FX_CLASHES.some(([a, b]) => pair.includes(a) && pair.includes(b)), pair.join('+'));
    // Which one the pair rule keeps when both can be drawn.
    let first;
    {
      const m = await mount({ settings: settings(pair) });
      await m.until(() => Boolean(m.session.fx.shuffle), 'library');
      m.start();
      await m.play(SETTLE_MS);
      assert.equal(m.session.fx.drawn.length, 1);
      [first] = m.session.fx.drawn;
      m.session.destroy();
    }
    const second = pair.find((id) => id !== first);
    const gl = new PickyGL();
    gl.failing = new Set([first]);
    const m = await mount({ gl, settings: settings(pair) });
    const { session } = m;
    await m.until(() => Boolean(session.fx.shuffle), 'library');
    m.start();
    await m.play(SETTLE_MS);
    await m.play(SETTLE_MS);
    assert.deepEqual(session.fx.failedIds, [first]);
    assert.deepEqual(session.fx.drawn, [second], `${first} failed: ${second} drawn`);
    assert.equal(session.fx.boxes.get(second).getAttribute('aria-disabled'), 'false');
    assert.ok(!session.fx.note.textContent.includes(FX_TEXT.pairHere), session.fx.note.textContent);
    session.destroy();
  }
});
