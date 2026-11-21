import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACCUMULATING_FILES, ACCUMULATING_GLOBALS, ALL_SCENE_FILES, DENSITY_FILES, FILES, LINE_FILES, VENDOR_DIR,
} from '../scripts/import_psychedelia.mjs';
import {
  ACCUMULATING_RELEASED_IDS, ACCUMULATING_SCENE_ENTRIES, HELD_SCENE_ENTRIES, SCENES, sceneById, sceneCappedParams, sceneCaps, sceneSimRate,
} from '../src/visualizer/scenes.js';
import {
  ACCUMULATING_HELD, ACCUMULATING_QUALITY_CAPS, OFFERED_ACCUMULATING_SCENES, heldControls,
} from '../src/visualizer/accumulating-scenes.js';
import {
  DENSITY_FADE_AT, DENSITY_FADE_RATE, DENSITY_MAX_WAIT_MS, DENSITY_QUALITY, DENSITY_SAMPLES, createDensityRenderer, densityLimits, liveDensityWorkers,
} from '../src/visualizer/density-host.js';
import { createSceneRenderer, ownsPasses, drawable, SIM_PROGRAM } from '../src/visualizer/scene-renderer.js';
import { sceneDriftPlan } from '../src/visualizer/drift.js';
import { sceneLooks } from '../src/visualizer/looks.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import loadDensityWorker from '../src/visualizer/vendor/psychedelia/workers/progressive-density-worker.js';
import { SimGL, withWebgl2Global } from './helpers/sim-fakes.js';

/* Psychedelia's accumulating labs: Attractor Density Lab, Buddhabrot Lab and
   FLAM3 Density Lab on the density host (density-host.js: one throttled
   worker at most, ended when not needed, a picture that stops when finished
   and never jumps in brightness), and IFS / L-System Lab on the host for
   scenes that own their passes; all held out of the tab until released.
   No GPU and no real worker thread: fake clocks, a fake Worker, and the
   vendored worker's own code run in this process. */

const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));
const ROOT = join(import.meta.dirname, '..');
const IDS = Object.freeze(['attractor_density_lab', 'buddhabrot_lab', 'flam3_density_lab', 'ifs_lsystem_lab']);
const DENSITY_IDS = Object.freeze(['attractor_density_lab', 'buddhabrot_lab', 'flam3_density_lab']);
const SOURCES = Object.freeze({ kick: 0.4, bass: 0.6, level: 0.5, swell: 0.5 });
const entryOf = (id) => ACCUMULATING_SCENE_ENTRIES.find((entry) => entry.id === id);
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const lf = (text) => text.replace(/\r\n/g, '\n');

/** A stand-in for the browser's Worker: messages are copied as the browser
 *  copies them (structuredClone; a transferred buffer is detached on the
 *  sending side), and the test answers them (reply). */
class FakeWorker {
  static made = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.made.push(this);
  }

  postMessage(message, transfer = []) {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.posted.push(structuredClone(message, { transfer }));
  }

  terminate() { this.terminated = true; }

  /** Answer the last request as the density worker does. */
  reply(overrides = {}, handler = this.onmessage) {
    const request = this.posted.at(-1);
    const image = request.image || new ArrayBuffer(request.width * request.height * 4);
    const data = {
      type: 'frame',
      requestId: request.requestId,
      generation: request.generation,
      resetKey: request.resetKey,
      width: request.width,
      height: request.height,
      frameCount: 1,
      lastBatchSize: 1000,
      workMs: 8,
      image,
      ...overrides,
    };
    if (handler) handler({ data: structuredClone(data, { transfer: data.image ? [data.image] : [] }) });
    return data;
  }
}

/** A lab's config as Buddhabrot Lab sends it each frame. */
function labConfig(extra = {}) {
  return {
    densityType: 'buddhabrot',
    resetKey: 'look-a',
    tonemapKey: 'tone-a',
    params: { mode: 0, minIter: 8, maxIter: 180, seed: 0.3 },
    tonemap: { exposure: 2, gamma: 0.82, gain: 1.15, glow: 1.1, curve: 0.86, palette: 1, colorPhase: 0 },
    decay: 0.965,
    batchSize: 16000,
    resolutionScale: 0.72,
    maxSide: 1280,
    sharpness: 0.28,
    ...extra,
  };
}

/** The density host on its own: a fake context, clock and worker, the frame
 *  step and the quality set by the test. */
function densityRig({ quality = 'medium', canvas = { width: 1920, height: 1080 } } = {}) {
  const rig = {
    clock: 0, step: 1 / 60, quality, zoom: 1, workers: [],
  };
  rig.canvas = canvas;
  rig.gl = new SimGL({ canvas });
  const Renderer = {
    getCanvas: () => rig.canvas,
    bindFramebuffer() {},
    getViewZoom: () => rig.zoom,
    getFrameStep: () => rig.step,
  };
  rig.factory = createDensityRenderer({ Renderer, sceneQuality: () => rig.quality }, {
    startWorker: () => {
      const worker = new FakeWorker('density-worker.js', { type: 'module' });
      rig.workers.push(worker);
      return worker;
    },
    now: () => rig.clock,
  });
  rig.instance = rig.factory.create({ name: 'test' });
  rig.worker = () => rig.workers.at(-1) || null;
  /** One frame `ms` after the last (a still one with step 0). */
  rig.frame = (config = labConfig(), ms = 1000 / 60, step = ms / 1000) => {
    rig.clock += ms;
    rig.step = step;
    return rig.instance.render(rig.gl, rig.clock / 1000, config);
  };
  return rig;
}

/* ---------------- The import ---------------- */

test('the import script vendors the density worker and the four labs (kept apart from the other scene files), each in the manifest, asking only for what the hosts give', () => {
  assert.deepEqual(DENSITY_FILES, ['attractor-density-lab', 'buddhabrot-lab', 'flam3-density-lab']);
  assert.deepEqual(ACCUMULATING_FILES, [...DENSITY_FILES, 'ifs-lsystem-lab']);
  for (const name of ACCUMULATING_FILES) {
    assert.ok(!ALL_SCENE_FILES.includes(name) && !LINE_FILES.includes(name), `${name}: not among the other scene files`);
    const target = `effects/${name}.js`;
    assert.ok(FILES.some((file) => file.target === target), `${target}: imported`);
    assert.ok(manifest.files.some((file) => file.target === target), `${target}: in the manifest`);
    const text = read('src', 'visualizer', 'vendor', 'psychedelia', 'effects', `${name}.js`);
    const needs = [...text.matchAll(/^var (\w+) = G\.\1;\r?$/gm)].map((match) => match[1]);
    assert.ok(needs.every((global) => ACCUMULATING_GLOBALS.includes(global)), `${name}: ${needs.join(', ')}`);
    assert.equal(needs.includes('ProgressiveDensityRenderer'), DENSITY_FILES.includes(name), name);
  }
  const worker = manifest.files.find((file) => file.target === 'workers/progressive-density-worker.js');
  assert.ok(worker, 'the worker is in the manifest');
  assert.equal(worker.source, 'src/workers/progressive-density-worker.js');
  assert.deepEqual(worker.needs, [], 'the worker needs no Psychedelia module');
  // Psychedelia's own renderer for them is not imported: the app's host stands in.
  assert.ok(!FILES.some((file) => /progressive-density-renderer/.test(file.source)));
  assert.deepEqual(ACCUMULATING_SCENE_ENTRIES.map((entry) => entry.file.replace(/^effects[/]/, '').replace(/[.]js$/, '')), [...ACCUMULATING_FILES]);
  assert.deepEqual(ACCUMULATING_SCENE_ENTRIES.map((entry) => entry.id), [...IDS]);
});

test('patched only on import: the worker\'s slice limit, its timing, its pixel buffer and its white point; IFS / L-System Lab\'s geometry built only on a change; the density labs as Psychedelia has them', () => {
  const worker = lf(read('src', 'visualizer', 'vendor', 'psychedelia', 'workers', 'progressive-density-worker.js'));
  assert.match(worker, /state\.deadline = started \+ Math\.min\(80, Math\.max\(1, finite\(message\.deadlineMs, 80\)\)\);/);
  assert.match(worker, /workMs: Date\.now\(\) - started,/);
  assert.match(worker, /var image = frameImage\(message, state\.width \* state\.height \* 4\);/);
  assert.match(worker, /var offset = 0;/);
  assert.doesNotMatch(worker, /lit\.push\(v\)/);
  // Its white point: as a multiple of the mean lit pixel, the one the host
  // sends (tests/visualizer-density-steady.test.js), and the one it measured said.
  assert.match(worker, /litMean = count \? sum \/ count : 0;/);
  assert.match(worker, /var white = hostScale > 0 && litMean > 0 \? Math\.min\(max, Math\.max\(max \* 0\.015, litMean \* hostScale, 0\.0001\)\) : measured;/);
  assert.match(worker, /whiteScale: mapped\.whiteScale,/);
  assert.equal(manifest.files.find((file) => file.target === 'workers/progressive-density-worker.js').patches.length, 10);
  const ifs = lf(read('src', 'visualizer', 'vendor', 'psychedelia', 'effects', 'ifs-lsystem-lab.js'));
  assert.match(ifs, /if \(geometryChanged\(p\)\) \{\n\s+buildGeometry\(p, motionTime\);/);
  assert.match(ifs, /if \(state\.settled < SETTLE_FRAMES\) \{/);
  assert.equal(manifest.files.find((file) => file.target === 'effects/ifs-lsystem-lab.js').patches.length, 8);
  for (const name of DENSITY_FILES) {
    const text = read('src', 'visualizer', 'vendor', 'psychedelia', 'effects', `${name}.js`);
    assert.ok(!/PATCHED on import/.test(text), `${name}: as Psychedelia has it`);
  }
});

test('credited: every file named, and the methods behind them (Buddhabrot, fractal flames, strange attractors, L-systems)', () => {
  const credits = lf(read('CREDITS.md')).replace(/\s+/g, ' ');
  const notices = lf(read('public', 'THIRD_PARTY_NOTICES.txt')).replace(/\s+/g, ' ');
  for (const doc of [credits, notices]) {
    for (const source of ['src/workers/progressive-density-worker.js', ...ACCUMULATING_FILES.map((name) => `src/effects/${name}.js`)]) {
      assert.ok(doc.includes(source), source);
    }
    assert.ok(/Melinda Green/.test(doc), 'the Buddhabrot technique');
    assert.ok(/flam3-density-lab\.js[^.]*progressive-density-worker\.js[^.]*Draves|FLAM3 Density Lab[^.]*Draves/.test(doc), 'the flames of the density lab and worker');
    assert.ok(/attractor-density-lab\.js|Attractor Density Lab/.test(doc) && /Sprott/.test(doc), 'the attractors');
    assert.ok(/ifs-lsystem-lab\.js[^;]*Prusinkiewicz|IFS \/ L-System Lab[^;]*Prusinkiewicz/.test(doc), 'the L-systems');
  }
});

/* ---------------- The worker: how it starts ---------------- */

test('the worker is a module worker from the app\'s own files: no Blob address, no importScripts, no eval, nothing remote', () => {
  const host = read('src', 'visualizer', 'density-host.js');
  assert.match(host, /new Worker\(new URL\('\.\/density-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  const entry = read('src', 'visualizer', 'density-worker.js');
  assert.match(entry, /import load from '\.\/vendor\/psychedelia\/workers\/progressive-density-worker\.js';/);
  for (const [name, text] of [['density-host.js', host], ['density-worker.js', entry], ['accumulating-scenes.js', read('src', 'visualizer', 'accumulating-scenes.js')]]) {
    for (const banned of [/createObjectURL/, /new Blob/, /importScripts\(/, /\beval\(/, /new Function/, /https?:\/\//, /setTimeout|setInterval|requestAnimationFrame/]) {
      assert.doesNotMatch(text, banned, `${name}: ${banned}`);
    }
  }
});

/* ---------------- Held out of the tab ---------------- */

test('released one by one: Buddhabrot Lab offered; a held lab is not offered, held or found by id; their cautious settings stand', () => {
  assert.deepEqual([...ACCUMULATING_RELEASED_IDS], ['buddhabrot_lab']);
  assert.ok(Object.isFrozen(ACCUMULATING_RELEASED_IDS));
  assert.deepEqual(OFFERED_ACCUMULATING_SCENES.map((entry) => entry.id), ['buddhabrot_lab']);
  assert.deepEqual(SCENES.filter((entry) => IDS.includes(entry.id)).map((entry) => entry.id), ['buddhabrot_lab']);
  assert.equal(sceneById('buddhabrot_lab'), entryOf('buddhabrot_lab'));
  for (const id of IDS) {
    if (!ACCUMULATING_RELEASED_IDS.includes(id)) {
      assert.equal(sceneById(id), null, `${id}: not found`);
      assert.ok(!SCENES.some((entry) => entry.id === id), `${id}: not offered`);
    }
    assert.ok(!HELD_SCENE_ENTRIES.some((entry) => entry.id === id), `${id}: not among the held flights`);
    const entry = entryOf(id);
    assert.equal(entry.cost, 'heavy', id);
    assert.equal(entry.maxSpeed, 1, `${id}: the time surge capped at 1x`);
    assert.equal(entry.drift, false, `${id}: no drift`);
    assert.equal(entry.fxNone, true, `${id}: no post effects`);
    assert.equal(entry.needs, 'webgl2', id);
    assert.equal(entry.links, null, id);
    assert.equal(entry.audio, 'motion', id);
    assert.ok(Object.isFrozen(entry), id);
    assert.equal(sceneSimRate(id), null, id);
  }
  // The quality caps reach the renderer as any scene's do.
  assert.deepEqual(sceneCaps('attractor_density_lab', 'low'), { attractor_batch_size: 48, attractor_steps: 520 });
  assert.deepEqual(sceneCaps('ifs_lsystem_lab', 'high'), { ifs_point_count: 24000 });
  assert.deepEqual(sceneCappedParams('ifs_lsystem_lab'), ['ifs_point_count']);
  assert.deepEqual(Object.keys(ACCUMULATING_QUALITY_CAPS), ['attractor_density_lab', 'ifs_lsystem_lab']);
});

test('drawn still: each lab\'s motion, colour cycling and fading are held whatever the look sets, from one object filled again each call', () => {
  const motion = {
    attractor_density_lab: ['attractor_constant_motion', 'attractor_orbit_speed', 'attractor_projection_speed', 'attractor_constant_drift', 'attractor_camera_orbit', 'attractor_color_speed'],
    buddhabrot_lab: ['buddha_window_drift', 'buddha_window_zoom_speed', 'buddha_sample_motion', 'buddha_drift_speed', 'buddha_color_speed'],
    flam3_density_lab: ['flam3_motion_rate', 'flam3_color_speed'],
    ifs_lsystem_lab: ['ifs_motion_rate'],
  };
  const persistence = { attractor_density_lab: 'attractor_fade', buddhabrot_lab: 'buddha_accumulation_decay', flam3_density_lab: 'flam3_accumulation_decay' };
  for (const id of IDS) {
    const held = ACCUMULATING_HELD[id];
    for (const name of motion[id]) assert.equal(held.set[name], 0, `${id}: ${name}`);
    if (persistence[id]) assert.equal(held.set[persistence[id]], 1, `${id}: no fading`);
    let values = { [motion[id][0]]: 2.5, other: 7, ifs_background: 4 };
    const controls = heldControls({ getValues: () => values }, held);
    const first = controls.getValues();
    assert.equal(first[motion[id][0]], 0, id);
    assert.equal(first.other, 7, id);
    values = { other: 3, ifs_background: 4 };
    assert.equal(controls.getValues(), first, `${id}: the same object`);
    assert.equal(first.other, 3, id);
  }
  // IFS / L-System Lab's two brightest backgrounds (Palette Haze, Ink on Paper) are not drawn.
  const ifs = heldControls({ getValues: () => ({ ifs_background: 4 }) }, ACCUMULATING_HELD.ifs_lsystem_lab);
  assert.equal(ifs.getValues().ifs_background, 2);
});

/* ---------------- The density host ---------------- */

test('one slice at a time: the quality\'s slice and time limit, no fading, and the pixel buffer handed back and forth (transferred, never copied)', () => {
  const rig = densityRig();
  rig.frame();
  const worker = rig.worker();
  assert.ok(worker, 'started on the first moving frame');
  assert.deepEqual(worker.options, { type: 'module' });
  assert.equal(worker.posted.length, 1);
  const first = worker.posted[0];
  assert.equal(first.type, 'accumulate');
  assert.equal(first.budgetMs, DENSITY_QUALITY.medium.budgetMs);
  assert.equal(first.deadlineMs, DENSITY_QUALITY.medium.budgetMs);
  assert.equal(first.decay, 1, 'no fading, whatever the lab asks');
  assert.equal(first.image, null, 'no buffer to hand back yet');
  rig.frame();
  rig.frame();
  assert.equal(worker.posted.length, 1, 'nothing more asked while a slice is out');
  const sent = worker.reply();
  assert.ok(rig.instance.getDiagnostics().holding, 'held until the next frame');
  rig.clock += 1000;
  rig.frame();
  assert.equal(sent.image.byteLength, 0, 'the received buffer went back to the worker (detached here)');
  assert.equal(worker.posted.length, 2);
  const second = worker.posted[1];
  assert.ok(second.image instanceof ArrayBuffer, 'the buffer came back with the next request');
  assert.equal(second.image.byteLength, first.width * first.height * 4);
  rig.instance.cleanup(rig.gl);
});

test('the duty cycle: the worker is busy at most its share of one core at each quality (measured here with a fake clock)', (t) => {
  for (const quality of ['low', 'medium', 'high']) {
    for (const workMs of [1, 4, DENSITY_QUALITY[quality].budgetMs, 30]) {
      const rig = densityRig({ quality });
      let due = null;
      let busy = 0;
      for (let i = 0; i < 60 * 30; i += 1) {
        const worker = rig.worker();
        if (worker && due !== null && rig.clock >= due) {
          due = null;
          worker.reply({ workMs, lastBatchSize: 1 });
          busy += workMs;
        }
        const posted = worker ? worker.posted.length : 0;
        rig.frame();
        if (rig.worker() && rig.worker().posted.length > posted) due = rig.clock + workMs;
      }
      const share = busy / rig.clock;
      const limit = DENSITY_QUALITY[quality].share;
      assert.ok(share <= limit + 1e-9, `${quality}, ${workMs} ms slices: ${share.toFixed(3)} > ${limit}`);
      // Frames come every 16.7 ms, so a short slice waits for the next one.
      if (workMs >= DENSITY_QUALITY[quality].budgetMs) assert.ok(share > limit * 0.75, `${quality}, ${workMs} ms: ${share.toFixed(3)}`);
      t.diagnostic(`${quality}: ${workMs} ms slices, worker busy ${(share * 100).toFixed(1)}% (share ${limit * 100}%)`);
      rig.instance.cleanup(rig.gl);
    }
  }
});

test('a stall makes no burst: one slice after it, and the wait after a long slice is bounded', () => {
  const rig = densityRig();
  rig.frame();
  rig.worker().reply({ workMs: 10 });
  rig.frame(labConfig(), 10000, 1 / 30);
  assert.equal(rig.worker().posted.length, 2, 'one slice after a 10 s stall');
  const at = rig.clock;
  rig.frame();
  assert.equal(rig.worker().posted.length, 2, 'and still one at a time');
  rig.worker().reply({ workMs: 5000 });
  for (let i = 0; i < 400 && rig.worker().posted.length === 2; i += 1) rig.frame();
  assert.equal(rig.worker().posted.length, 3);
  const waited = rig.clock - at;
  assert.ok(waited >= DENSITY_MAX_WAIT_MS && waited <= DENSITY_MAX_WAIT_MS + 1000 / 60 + 1e-6, `waited ${waited} ms`);
  rig.instance.cleanup(rig.gl);
});

test('a finished picture stops the worker until something changes: by its sample budget or its work budget', () => {
  // Samples: Buddhabrot orbits.
  const rig = densityRig();
  const budget = DENSITY_SAMPLES.buddhabrot * DENSITY_QUALITY.medium.samples;
  rig.frame();
  for (let i = 0; i < 4; i += 1) {
    rig.clock += 1000;
    rig.worker().reply({ lastBatchSize: budget / 4 });
    rig.frame();
  }
  const done = rig.worker();
  assert.equal(done.terminated, true, 'ended once finished');
  assert.equal(done.onmessage, null);
  assert.equal(rig.instance.getDiagnostics().finished, true);
  assert.equal(liveDensityWorkers(), 0);
  const draws = rig.gl.draws;
  for (let i = 0; i < 120; i += 1) rig.frame();
  assert.equal(rig.workers.length, 1, 'no worker while nothing changes');
  assert.equal(rig.gl.draws - draws, 120, 'the finished picture is still drawn');
  assert.equal(rig.instance.getDiagnostics().holding, 0, 'no buffer kept once finished');
  rig.frame(labConfig({ resetKey: 'look-b' }));
  for (let i = 0; i < 200 && rig.instance.getDiagnostics().mix > 0; i += 1) rig.frame(labConfig({ resetKey: 'look-b' }));
  assert.equal(rig.workers.length, 2, 'a change starts a new picture');
  assert.equal(rig.worker().posted.at(-1).resetKey, 'look-b');
  rig.instance.cleanup(rig.gl);

  // Work: whatever the samples, a picture takes at most the quality's worker time.
  const slow = densityRig({ quality: 'low' });
  slow.frame();
  let replies = 0;
  for (let i = 0; i < 20000 && !slow.instance.getDiagnostics().finished; i += 1) {
    const worker = slow.worker();
    if (worker.posted.length > replies) {
      replies += 1;
      worker.reply({ lastBatchSize: 0, workMs: 500 });
    }
    slow.frame();
  }
  assert.equal(replies, DENSITY_QUALITY.low.workMs / 500);
  assert.equal(slow.worker().terminated, true);
  slow.instance.cleanup(slow.gl);
});

test('the attractor and the flames count their points: steps or plotted steps times what a slice did', () => {
  for (const [densityType, params, per] of [['attractor', { steps: 400 }, 400], ['flam3', { plotOrbit: 3 }, 3], ['buddhabrot', {}, 1]]) {
    const rig = densityRig();
    rig.frame(labConfig({ densityType, params }));
    rig.worker().reply({ lastBatchSize: 100 });
    assert.equal(rig.instance.getDiagnostics().samples, 100 * per, densityType);
    rig.instance.cleanup(rig.gl);
  }
});

test('a still picture asks nothing and changes nothing; no timer runs; the next moving frame picks up', () => {
  const rig = densityRig();
  rig.frame();
  rig.worker().reply();
  const before = rig.instance.getDiagnostics();
  const subImages = rig.gl.subImages;
  const textures = rig.gl.textures.size;
  for (let i = 0; i < 300; i += 1) rig.frame(labConfig({ resetKey: 'changed-while-still' }), 1000 / 60, 0);
  const after = rig.instance.getDiagnostics();
  assert.equal(rig.worker().posted.length, 1, 'nothing asked');
  assert.equal(after.mix, before.mix, 'the mix holds');
  assert.equal(after.generation, before.generation, 'a change waits for a moving frame');
  assert.equal(rig.gl.subImages, subImages);
  assert.equal(rig.gl.textures.size, textures);
  assert.ok(after.holding, 'the frame received waits');
  rig.frame(labConfig({ resetKey: 'changed-while-still' }));
  assert.equal(rig.instance.getDiagnostics().generation, before.generation + 1);
  rig.instance.cleanup(rig.gl);
});

test('late messages are dropped: from an ended worker, from a replaced one, and of an old picture', () => {
  const rig = densityRig();
  rig.frame();
  const first = rig.worker();
  const handler = first.onmessage;
  rig.instance.cleanup(rig.gl);
  assert.equal(first.terminated, true);
  assert.equal(first.onmessage, null);
  assert.equal(first.onerror, null);
  assert.doesNotThrow(() => first.reply({}, handler));
  assert.equal(rig.factory.stats.late, 1);
  assert.equal(rig.factory.stats.uploads, 0);
  assert.deepEqual(rig.gl.aliveCounts(), {}, 'nothing of the instance left');

  const again = densityRig();
  again.frame();
  const old = again.worker();
  const oldHandler = old.onmessage;
  // A second instance takes the one worker allowed.
  const other = again.factory.create({ name: 'other' });
  other.render(again.gl, 1, labConfig());
  assert.equal(old.terminated, true);
  assert.equal(liveDensityWorkers(), 1);
  old.reply({}, oldHandler);
  assert.equal(again.factory.stats.late, 1);
  other.cleanup(again.gl);
  again.instance.cleanup(again.gl);

  // An old picture's frame (the look changed while it was out): not shown.
  const stale = densityRig();
  stale.frame();
  stale.frame(labConfig({ resetKey: 'look-b' }));
  stale.worker().reply();
  assert.equal(stale.factory.stats.stale, 1);
  stale.frame(labConfig({ resetKey: 'look-b' }));
  assert.equal(stale.factory.stats.uploads, 0);
  assert.equal(stale.worker().posted.at(-1).resetKey, 'look-b');
  stale.instance.cleanup(stale.gl);
  assert.equal(liveDensityWorkers(), 0);
});

test('a worker that cannot start or fails leaves the lab drawing its background, with nothing alive', () => {
  const rig = densityRig();
  const failing = createDensityRenderer({ Renderer: { getCanvas: () => rig.canvas, getFrameStep: () => 1 / 60 } }, {
    startWorker: () => { throw new Error('no workers here'); },
    now: () => 0,
  });
  const lab = failing.create();
  assert.equal(lab.render(rig.gl, 0, labConfig()), true);
  assert.equal(lab.render(rig.gl, 0.1, labConfig()), true);
  assert.equal(failing.stats.failed, 1, 'tried once');
  assert.equal(liveDensityWorkers(), 0);
  lab.cleanup(rig.gl);
  rig.frame();
  rig.worker().onerror({ preventDefault() {} });
  assert.equal(rig.worker().terminated, true);
  assert.equal(liveDensityWorkers(), 0);
  rig.frame();
  assert.equal(rig.workers.length, 1, 'not started again');
  rig.instance.cleanup(rig.gl);
});

test('steady brightness: a new picture is mixed in as it fills, at most the fade rate a second; a change part way takes it back out first', () => {
  const rig = densityRig();
  const budget = DENSITY_SAMPLES.buddhabrot * DENSITY_QUALITY.medium.samples;
  let last = 0;
  const watch = (config) => {
    rig.frame(config);
    const { mix } = rig.instance.getDiagnostics();
    assert.ok(Math.abs(mix - last) <= DENSITY_FADE_RATE / 60 + 1e-9, `the mix moved ${mix - last} in one frame`);
    last = mix;
    return mix;
  };
  watch(labConfig());
  // A sparse first frame: shown only in part until DENSITY_FADE_AT of the budget.
  rig.worker().reply({ lastBatchSize: budget * DENSITY_FADE_AT * 0.5 });
  for (let i = 0; i < 240; i += 1) watch(labConfig());
  assert.ok(Math.abs(last - 0.5) < 1e-9, `half shown at half of DENSITY_FADE_AT (${last})`);
  rig.clock += 1000;
  rig.worker().reply({ lastBatchSize: budget });
  for (let i = 0; i < 240; i += 1) watch(labConfig());
  assert.equal(last, 1, 'all of it once filled');
  // A change once it is shown: it becomes the old picture (the same picture
  // on the screen), the new one comes in over it.
  rig.frame(labConfig({ resetKey: 'look-b' }));
  let d = rig.instance.getDiagnostics();
  assert.ok(d.hasBack && !d.hasFront && d.mix === 0, 'the old picture stays');
  last = 0;
  // A change part way in: the new picture goes back out at the fade rate first.
  rig.clock += 1000;
  watch(labConfig({ resetKey: 'look-b' }));
  rig.worker().reply({ lastBatchSize: budget });
  for (let i = 0; i < 30; i += 1) watch(labConfig({ resetKey: 'look-b' }));
  assert.ok(last > 0 && last < 1, `part way (${last})`);
  const generation = rig.instance.getDiagnostics().generation;
  watch(labConfig({ resetKey: 'look-c' }));
  d = rig.instance.getDiagnostics();
  assert.equal(d.leaving, true);
  assert.equal(d.generation, generation, 'not started until the old one is out');
  for (let i = 0; i < 240 && rig.instance.getDiagnostics().leaving; i += 1) watch(labConfig({ resetKey: 'look-c' }));
  d = rig.instance.getDiagnostics();
  assert.equal(d.generation, generation + 1);
  assert.equal(d.mix, 0);
  assert.ok(d.hasBack, 'the finished picture before it is still underneath');
  // A stall moves the mix by one frame's worth at most.
  rig.clock += 1000;
  rig.frame(labConfig({ resetKey: 'look-c' }));
  rig.worker().reply({ lastBatchSize: budget });
  const before = rig.instance.getDiagnostics().mix;
  rig.frame(labConfig({ resetKey: 'look-c' }), 30000, 1 / 30);
  assert.ok(rig.instance.getDiagnostics().mix - before <= DENSITY_FADE_RATE / 30 + 1e-9);
  rig.instance.cleanup(rig.gl);
});

test('the picture\'s size by quality, whatever the lab asks; a step-down starts a smaller picture; the buffers sent each way', (t) => {
  const sizes = {};
  for (const quality of ['low', 'medium', 'high']) {
    const rig = densityRig({ quality });
    rig.frame(labConfig({ resolutionScale: 1, maxSide: 4096 }));
    const request = rig.worker().posted[0];
    const q = densityLimits(quality);
    assert.ok(Math.max(request.width, request.height) <= q.maxSide, quality);
    assert.ok(request.width <= 1920 * q.scale, quality);
    sizes[quality] = [request.width, request.height, request.width * request.height * 4];
    t.diagnostic(`${quality}: ${request.width} x ${request.height}, ${request.width * request.height * 4} bytes each way at 1920 x 1080`);
    rig.instance.cleanup(rig.gl);
  }
  assert.deepEqual(sizes, {
    low: [512, 288, 589824], medium: [768, 432, 1327104], high: [1024, 576, 2359296],
  });
  assert.equal(densityLimits('unknown'), DENSITY_QUALITY.medium);
  for (const quality of ['low', 'medium', 'high']) assert.ok(DENSITY_QUALITY[quality].share <= 0.35);
  // A smaller lab scale is kept.
  const small = densityRig();
  small.frame(labConfig({ resolutionScale: 0.2 }));
  assert.equal(small.worker().posted[0].width, 384);
  small.instance.cleanup(small.gl);
  // The step-down: a new picture at Low's size, over the finished one.
  const step = densityRig();
  step.frame();
  assert.equal(step.worker().posted[0].width, 768);
  step.worker().reply({ lastBatchSize: 1e12 });
  for (let i = 0; i < 200; i += 1) step.frame();
  assert.equal(step.instance.getDiagnostics().mix, 1);
  step.quality = 'low';
  step.frame();
  assert.equal(step.instance.getDiagnostics().width, 512);
  assert.equal(step.worker().posted.at(-1).width, 512);
  assert.ok(step.instance.getDiagnostics().hasBack, 'the finished picture stays underneath');
  step.instance.cleanup(step.gl);
});

test('the density host makes nothing until a lab draws, and frees all it made: two textures, a buffer and a program', () => {
  const rig = densityRig();
  assert.deepEqual(rig.gl.aliveCounts(), {});
  assert.equal(rig.workers.length, 0);
  rig.frame();
  assert.deepEqual(rig.gl.aliveCounts(), { Texture: 2, Buffer: 1, Program: 1 });
  rig.instance.cleanup(rig.gl);
  assert.deepEqual(rig.gl.aliveCounts(), {});
  assert.equal(rig.worker().terminated, true);
  // After a context loss nothing is deleted.
  const lost = densityRig();
  lost.frame();
  lost.gl.lost = true;
  for (const kind of Object.keys(lost.gl.alive)) lost.gl.alive[kind].clear();
  const deletes = [];
  for (const name of ['deleteTexture', 'deleteBuffer', 'deleteProgram']) {
    const original = lost.gl[name].bind(lost.gl);
    lost.gl[name] = (...args) => { deletes.push(name); return original(...args); };
  }
  lost.instance.cleanup(lost.gl);
  assert.deepEqual(deletes, []);
  assert.equal(lost.worker().terminated, true);
});

/* ---------------- The worker's own code, run here ---------------- */

/** Psychedelia's density worker run in this process: `self` is a stand-in
 *  scope; messages go straight to its handler (no copy), so a buffer sent
 *  in can be told apart from a new one. */
function localWorker() {
  class Scope {}
  const scope = new Scope();
  const replies = [];
  scope.postMessage = (message) => replies.push(message);
  scope.close = () => {};
  // The worker names its scope as `self` while it loads and while it answers.
  const within = (fn) => {
    const saved = { self: globalThis.self, WorkerGlobalScope: globalThis.WorkerGlobalScope };
    globalThis.self = scope;
    globalThis.WorkerGlobalScope = Scope;
    try {
      return fn();
    } finally {
      if (saved.self === undefined) delete globalThis.self; else globalThis.self = saved.self;
      if (saved.WorkerGlobalScope === undefined) delete globalThis.WorkerGlobalScope; else globalThis.WorkerGlobalScope = saved.WorkerGlobalScope;
    }
  };
  within(() => loadDensityWorker({}));
  // Its clock (Date.now) is a counter here, a millisecond a look, so how long
  // a slice runs does not hang on how busy the machine is.
  const counted = (fn) => {
    const real = Date.now;
    let clock = 1e12;
    Date.now = () => (clock += 1);
    try {
      return fn();
    } finally {
      Date.now = real;
    }
  };
  return { scope, replies, send: (data) => within(() => counted(() => scope.onmessage({ data }))) };
}

const HELD_PARAMS = {
  buddhabrot: {
    mode: 0, sampleScale: 1, minIter: 8, maxIter: 180, xMin: -2.2, xMax: 1.15, yMin: -1.35, yMax: 1.35, windowDrift: 0, windowZoomSpeed: 0,
    slowBucket: 160, midBucket: 55, sampleMotion: 0, driftSpeed: 0, channelGain: 1.15, globalZoom: 1, seed: 0.3,
  },
  attractor: {
    mode: 0, steps: 420, dt: 1, constantMotion: 0, projection: 3, projectionMix: 0.36, depthMix: 0.22, scale: 1.12, rotation: 0, zoom: 1.1,
    globalZoom: 1, trailWidth: 0.82, orbitSpeed: 0, projectionSpeed: 0, constantDrift: 0, cameraOrbit: 0, seed: 0.3,
  },
  flam3: {
    mode: 1, xformCount: 4, variationWeights: 0.48, finalTransform: 0.34, symmetry: 4, scale: 0.94, rotate: 0, translateX: 0, translateY: 0.08,
    shearX: 0, shearY: 0, warmup: 10, plotOrbit: 3, motionRate: 0, splatRadius: 0.35, colorMix: 0.62, globalZoom: 1, seed: 0.3,
  },
};

test('the vendored worker: a slice stops at the host\'s time limit, says how long it took, and fills the buffer it was handed', () => {
  for (const densityType of ['buddhabrot', 'attractor', 'flam3']) {
    const { replies, send } = localWorker();
    const message = (image, requestId) => ({
      type: 'accumulate', requestId, generation: 1, resetKey: 'a', densityType, width: 64, height: 36, batchSize: densityType === 'attractor' ? 48 : 60000,
      decay: 1, params: { ...HELD_PARAMS[densityType] }, tonemap: { exposure: 2, gamma: 0.84, gain: 1, glow: 1, curve: 0.8, palette: 1, colorPhase: 0 },
      time: 0, budgetMs: 3, deadlineMs: 3, image,
    });
    send(message(null, 1));
    const first = replies.at(-1);
    assert.equal(first.type, 'frame', densityType);
    assert.ok(Number.isFinite(first.workMs) && first.workMs >= 0, `${densityType}: workMs ${first.workMs}`);
    assert.ok(first.workMs <= 8, `${densityType}: the slice stopped at its limit (${first.workMs} looks at the clock; upstream runs to 80)`);
    assert.ok(first.lastBatchSize > 0, densityType);
    const pixels = new Uint8ClampedArray(first.image);
    assert.ok(pixels.some((value, i) => i % 4 !== 3 && value > 0), `${densityType}: something drawn`);
    // Handed back: the same buffer is filled again (cleared first).
    new Uint8ClampedArray(first.image).fill(255);
    send(message(first.image, 2));
    const second = replies.at(-1);
    assert.equal(second.image, first.image, `${densityType}: the same buffer`);
    assert.ok(new Uint8ClampedArray(second.image).some((value, i) => i % 4 !== 3 && value === 0), `${densityType}: cleared before it was filled`);
    // A buffer of the wrong size is not used.
    send(message(new ArrayBuffer(16), 3));
    assert.equal(replies.at(-1).image.byteLength, 64 * 36 * 4);
  }
});

/* ---------------- In the tab: through the scene renderer ---------------- */

async function withFakeWorker(fn) {
  const saved = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  FakeWorker.made = [];
  try {
    await withWebgl2Global(fn);
  } finally {
    if (saved === undefined) delete globalThis.Worker; else globalThis.Worker = saved;
  }
}

function tabRenderer() {
  const canvas = { width: 320, height: 180 };
  const gl = new SimGL({ canvas });
  const renderer = createSceneRenderer({
    canvas, gl, mode: 'webgl2', capsFor: sceneCaps, rateFor: sceneSimRate, random: seededRandom(5),
  });
  return { canvas, gl, renderer };
}

async function registered(renderer, id) {
  return renderer.register(await entryOf(id).load(), id);
}

function frames(renderer, n, t = 0, extra = {}) {
  let time = t;
  for (let i = 0; i < n; i += 1) {
    time += 1 / 30;
    renderer.draw({ time, sources: SOURCES, zoom: 1, ...extra });
  }
  return time;
}

test('each lab is drawn through the host for scenes that own their passes, with Psychedelia\'s presets as its looks and nothing drifted', async () => {
  await withFakeWorker(async () => {
    const { renderer } = tabRenderer();
    for (const id of IDS) {
      const def = await registered(renderer, id);
      assert.ok(def, id);
      assert.ok(ownsPasses(def) && drawable(def), id);
      assert.equal(renderer.compileNow(renderer.prepare(def)), SIM_PROGRAM, id);
      assert.ok(sceneLooks(def).length >= 3, `${id}: its presets are its looks`);
      assert.deepEqual(sceneDriftPlan(def, { override: entryOf(id).drift, capped: sceneCappedParams(id) }), [], id);
    }
    renderer.destroy();
  });
});

test('in the tab the worker ends on a change of scene, when the tab closes and on a context loss; with no lab shown none starts', async () => {
  await withFakeWorker(async () => {
    const { gl, renderer } = tabRenderer();
    const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
    renderer.useSceneNow(tunnel);
    frames(renderer, 30);
    assert.equal(FakeWorker.made.length, 0, 'no worker for a shader scene');
    const base = gl.aliveCounts();
    for (const id of DENSITY_IDS) {
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      frames(renderer, 3);
      const worker = FakeWorker.made.at(-1);
      assert.ok(worker && !worker.terminated, `${id}: a worker`);
      assert.equal(worker.url.href.endsWith('/density-worker.js'), true, `${id}: the app's own worker file`);
      assert.equal(liveDensityWorkers(), 1);
      const request = worker.posted[0];
      assert.equal(request.decay, 1, id);
      // The lab's motion held still on its way to the worker.
      const still = {
        attractor_density_lab: ['constantMotion', 'orbitSpeed', 'projectionSpeed', 'constantDrift', 'cameraOrbit'],
        buddhabrot_lab: ['windowDrift', 'windowZoomSpeed', 'sampleMotion', 'driftSpeed'],
        flam3_density_lab: ['motionRate'],
      };
      for (const name of still[id]) assert.equal(request.params[name], 0, `${id}: ${name}`);
      renderer.useSceneNow(tunnel);
      assert.equal(worker.terminated, true, `${id}: ended with the scene`);
      assert.equal(worker.onmessage, null);
      assert.equal(liveDensityWorkers(), 0);
      assert.deepEqual(gl.aliveCounts(), base, `${id}: nothing left`);
    }
    renderer.useSceneNow(await registered(renderer, 'buddhabrot_lab'));
    frames(renderer, 3);
    const open = FakeWorker.made.at(-1);
    renderer.destroy();
    assert.equal(open.terminated, true, 'ended when the tab closes');
    assert.deepEqual(gl.aliveCounts(), {});

    const lost = tabRenderer();
    lost.renderer.useSceneNow(await registered(lost.renderer, 'flam3_density_lab'));
    frames(lost.renderer, 3);
    const worker = FakeWorker.made.at(-1);
    lost.gl.lost = true;
    lost.renderer.contextLost();
    assert.equal(worker.terminated, true, 'ended on a context loss');
    assert.equal(liveDensityWorkers(), 0);
    lost.renderer.destroy();
  });
});

test('in the tab a still picture asks the worker nothing', async () => {
  await withFakeWorker(async () => {
    const { renderer } = tabRenderer();
    renderer.useSceneNow(await registered(renderer, 'attractor_density_lab'));
    const t = frames(renderer, 2);
    const worker = FakeWorker.made.at(-1);
    worker.reply();
    const posted = worker.posted.length;
    for (let i = 0; i < 120; i += 1) renderer.draw({ time: t, still: true, sources: SOURCES, zoom: 1 });
    assert.equal(worker.posted.length, posted);
    renderer.destroy();
  });
});

test('IFS / L-System Lab builds and uploads its geometry once a look, stops drawing into its persistence target once settled, and frees what it made', async () => {
  await withFakeWorker(async () => {
    const { gl, renderer } = tabRenderer();
    let uploads = 0;
    const bufferData = gl.bufferData.bind(gl);
    gl.bufferData = (target, data, ...rest) => {
      if (data && data.length > 12) uploads += 1;
      return bufferData(target, data, ...rest);
    };
    const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
    renderer.useSceneNow(tunnel);
    frames(renderer, 2);
    const base = gl.aliveCounts();
    const def = await registered(renderer, 'ifs_lsystem_lab');
    const looks = sceneLooks(def);
    for (const look of [looks[0], looks.find((one) => one.values?.ifs_mode === 1) || looks[1]]) {
      renderer.useSceneNow(def, [], look.values || null);
      uploads = 0;
      const pointsBefore = gl.pointDraws;
      frames(renderer, 300);
      assert.ok(uploads >= 1 && uploads <= 2, `${look.name}: uploaded once (${uploads})`);
      const settled = gl.pointDraws;
      assert.ok(settled - pointsBefore <= 240, `${look.name}: points drawn only until settled (${settled - pointsBefore})`);
      frames(renderer, 60);
      assert.equal(gl.pointDraws, settled, `${look.name}: no more point passes`);
    }
    // Ink on Paper asked for: drawn on Nebula Glow at most.
    const paper = looks.find((one) => one.values?.ifs_background === 4);
    assert.ok(paper, 'a look asks for Ink on Paper');
    renderer.useSceneNow(def, [], paper.values);
    frames(renderer, 2);
    assert.deepEqual(gl.uniforms.get('u_background'), [2]);
    renderer.useSceneNow(tunnel);
    assert.deepEqual(gl.aliveCounts(), base, 'nothing of it left');
    assert.equal(FakeWorker.made.length, 0, 'no worker for it');
    renderer.destroy();
  });
});

test('the lab-wide lifts: FLAM3 Density Lab starts at gamma 1.8 (no look sets it); IFS / L-System Lab at least Nebula Glow, glow 1.8 and line width 2.6', () => {
  const flam3 = entryOf('flam3_density_lab');
  assert.deepEqual({ ...flam3.defaults }, { flam3_gamma: 1.8 });
  const presets = read('src', 'visualizer', 'vendor', 'psychedelia', 'effects', 'flam3-density-lab.js').split(/\r?\n/).filter((line) => /preset\('/.test(line));
  assert.ok(presets.length >= 20, String(presets.length));
  for (const line of presets) assert.doesNotMatch(line, /flam3_gamma/, 'no look sets its gamma');
  for (const id of ['buddhabrot_lab', 'ifs_lsystem_lab']) assert.equal(entryOf(id).defaults, null, id);
  // Attractor Density Lab: its density curve lifted (its own 0.72), and no
  // look sets it.
  assert.deepEqual({ ...entryOf('attractor_density_lab').defaults }, { attractor_density_curve: 0.45 });
  const attractorLooks = read('src', 'visualizer', 'vendor', 'psychedelia', 'effects', 'attractor-density-lab.js');
  assert.match(attractorLooks, /name: 'attractor_density_curve'[^}]*default: 0\.72/, 'its own curve');
  assert.equal((attractorLooks.match(/attractor_density_curve/g) || []).length, 2, 'read once and declared once: no look sets its curve');
  const held = ACCUMULATING_HELD.ifs_lsystem_lab;
  assert.deepEqual({ ...held.least }, { ifs_background: 2, ifs_glow: 1.8, ifs_thickness: 2.6 });
  let values = { ifs_background: 0, ifs_glow: 1.2, ifs_thickness: 1 };
  const controls = heldControls({ getValues: () => values }, held);
  assert.deepEqual({ ...controls.getValues() }, { ifs_background: 2, ifs_glow: 1.8, ifs_thickness: 2.6, ifs_motion_rate: 0 });
  values = { ifs_background: 5, ifs_glow: 2.2, ifs_thickness: 4 };
  assert.deepEqual({ ...controls.getValues() }, { ifs_background: 2, ifs_glow: 2.2, ifs_thickness: 4, ifs_motion_rate: 0 }, 'more is kept; the background no brighter than Nebula Glow');
  values = {};
  assert.equal(controls.getValues().ifs_glow, 1.8, 'missing: the least');
});
