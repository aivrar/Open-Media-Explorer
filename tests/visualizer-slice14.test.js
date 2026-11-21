import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  FEEDBACK_FILES, FILES, PASS_FILES, PASS_GLOBALS, SIM_FILES, VENDOR_DIR,
} from '../scripts/import_psychedelia.mjs';
import {
  ACCUMULATING_RELEASED_IDS, SCENES, SCENE_QUALITY_CAPS, drawableScenes, sceneById, sceneCaps, sceneSimRate,
} from '../src/visualizer/scenes.js';
import {
  COMPILE_POLL_MS, SIM_PROGRAM, createSceneRenderer, drawable, ownsPasses,
} from '../src/visualizer/scene-renderer.js';
import {
  SIM_FIRST_DT, SIM_MAX_DT, createSimHost, seededSim, simSupport, simSupported,
} from '../src/visualizer/sim-host.js';
import { FEEDBACK_MAX_STEPS } from '../src/visualizer/shadertoy-adapter.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';
import { SimGL, withWebgl2Global } from './helpers/sim-fakes.js';

/* Slice 14 of the visualizer: scenes that own their passes (render targets
   and programs of their own) on one host, sim-host.js: Psychedelia's four
   GPU simulations (Curl-Noise Silk, Fluid Ink, Lenia, Physarum) and two of
   its frame-feedback scenes (Feedback Loop, Reaction-Diffusion) through a
   small Shadertoy adapter. No GPU; fake clocks. */

const REPO = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));

const SIMS = Object.freeze(['curl_silk', 'fluid_ink', 'lenia', 'physarum']);
// The line-drawing scenes offered (slice 15) also need WebGL 2: tests/visualizer-lines.test.js.
const LINES = Object.freeze(['epicycles', 'hopf', 'knots', 'lissajous', 'lorenz', 'polytopes', 'spirograph']);
const FEEDBACK = Object.freeze(['feedback', 'reaction_diffusion']);
const NEW_IDS = Object.freeze([...SIMS, ...FEEDBACK]);
const SOURCES = Object.freeze({
  kick: 0.4, snare: 0.2, hat: 0.3, beat: 0.4, bass: 0.6, mid: 0.4, high: 0.2, level: 0.5, swell: 0.5,
});

function simRenderer(options = {}) {
  const canvas = { width: 160, height: 90 };
  const gl = options.gl || new SimGL({ canvas });
  const renderer = createSceneRenderer({
    canvas, gl, mode: 'webgl2', capsFor: sceneCaps, rateFor: sceneSimRate, random: seededRandom(5), ...options,
  });
  return { canvas, gl, renderer };
}

async function registered(renderer, id) {
  return renderer.register(await sceneById(id).load(), id);
}

/** Draw `n` frames 1/30 s apart from `t` (returns the time reached). */
function frames(renderer, n, t = 0, extra = {}) {
  let time = t;
  for (let i = 0; i < n; i += 1) {
    time += 1 / 30;
    renderer.draw({ time, sources: SOURCES, zoom: 1, ...extra });
  }
  return time;
}

/* ---------------- The import and the list ---------------- */

test('the import script vendors the six scenes that own their passes, GpuSim and the Shadertoy compiler, each in the manifest', () => {
  assert.deepEqual(SIM_FILES, ['curl-silk', 'fluid-ink', 'lenia', 'physarum']);
  assert.deepEqual(FEEDBACK_FILES, ['feedback-loop', 'reaction-diffusion']);
  // Game of Life is left out (its board thins out to near black), and not vendored.
  assert.equal(existsSync(join(VENDOR_DIR, 'effects', 'game-of-life.js')), false);
  assert.equal(sceneById('game_of_life'), null);
  assert.deepEqual(PASS_FILES, [...SIM_FILES, ...FEEDBACK_FILES]);
  for (const target of [...PASS_FILES.map((name) => `effects/${name}.js`), 'engine/gpu-sim.js', 'engine/shadertoy-compiler.js']) {
    assert.ok(FILES.some((file) => file.target === target), `${target}: imported`);
    assert.ok(manifest.files.some((file) => file.target === target), `${target}: in the manifest`);
  }
  // Each file asks only for what the host and the registry give.
  for (const name of PASS_FILES) {
    const text = readFileSync(join(VENDOR_DIR, 'effects', `${name}.js`), 'utf8');
    const needs = [...text.matchAll(/^var (\w+) = G\.\1;$/gm)].map((match) => match[1]);
    assert.ok(needs.every((global) => [...PASS_GLOBALS, 'Math'].includes(global)), `${name}: ${needs.join(', ')}`);
  }
});

test('Fluid Ink carries Pavel Dobryakov\'s fluid solver passes (MIT) and Curl-Noise Silk the Hash without Sine; both credited, the licence text shipped', () => {
  const rows = (scene) => manifest.borrowed.filter((row) => row.scene === scene).map((row) => row.piece);
  assert.deepEqual(rows('fluid_ink'), ['dobryakov-fluid']);
  assert.deepEqual(rows('curl_silk'), ['hoskins-hash']);
  for (const scene of ['lenia', 'physarum', ...FEEDBACK]) assert.deepEqual(rows(scene), [], scene);
  const fluid = manifest.borrowed.find((row) => row.piece === 'dobryakov-fluid');
  assert.equal(fluid.author, 'Pavel Dobryakov');
  assert.match(fluid.licence, /MIT/);
  const licence = readFileSync(join(VENDOR_DIR, 'WebGL-Fluid-Simulation-LICENSE.txt'), 'utf8');
  assert.match(licence, /Copyright \(c\) 2017 Pavel Dobryakov/);
  const credits = readFileSync(join(REPO, 'CREDITS.md'), 'utf8');
  const notices = readFileSync(join(REPO, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const text of [credits, notices]) {
    assert.match(text, /PavelDoGreat\/WebGL-Fluid-Simulation/);
    for (const method of ['Stam', 'Harris', 'Rafler', 'Jones', 'Gray-Scott']) assert.ok(text.includes(method), method);
  }
  assert.match(credits, /Robot Foundry, Curl-Noise Silk\. Author: David Hoskins/);
});

test('the six are offered (not held), as scenes that own their passes, each with the render targets it needs', () => {
  for (const id of NEW_IDS) {
    const entry = sceneById(id);
    assert.ok(entry, id);
    assert.ok(SCENES.includes(entry), `${id}: offered`);
    assert.equal(entry.cost, 'heavy', id);
  }
  for (const id of SIMS) assert.equal(sceneById(id).needs, 'float', id);
  assert.equal(sceneById('reaction_diffusion').needs, 'half');
  assert.equal(sceneById('feedback').needs, 'webgl2');
  // Every other scene needs nothing of the kind.
  for (const id of LINES) assert.equal(sceneById(id).needs, 'webgl2', id);
  // The accumulating labs released (accumulating-scenes.js) need WebGL 2 too.
  for (const id of ACCUMULATING_RELEASED_IDS) assert.equal(sceneById(id).needs, 'webgl2', id);
  for (const entry of SCENES) {
    if (!NEW_IDS.includes(entry.id) && !LINES.includes(entry.id) && !ACCUMULATING_RELEASED_IDS.includes(entry.id)) assert.equal(entry.needs, undefined, entry.id);
  }
});

/* ---------------- Float targets ---------------- */

test('support: two extension queries say what the context can draw into; scenes that need more are left out of the list', () => {
  const gl = new SimGL({ float: false, half: true });
  const support = simSupport(gl, 'webgl2');
  assert.deepEqual(support, { webgl2: true, float: false, half: true });
  assert.deepEqual([...gl.extensionAsks.keys()].sort(), ['EXT_color_buffer_float', 'EXT_color_buffer_half_float']);
  assert.deepEqual(simSupport(new SimGL(), 'webgl2'), { webgl2: true, float: true, half: true });
  // WebGL 1: none of them, and nothing asked.
  const old = new SimGL();
  assert.deepEqual(simSupport(old, 'webgl'), { webgl2: false, float: false, half: false });
  assert.equal(old.extensionAsks.size, 0);
  assert.equal(simSupported('webgl2', { webgl2: true }), true);
  assert.equal(simSupported('half', { webgl2: true, half: false }), false);
  const ids = (support2) => drawableScenes(SCENES, support2).map((entry) => entry.id);
  const all = SCENES.map((entry) => entry.id);
  assert.deepEqual(ids({ webgl2: true, float: true, half: true }), all);
  assert.deepEqual(ids({ webgl2: true, float: false, half: true }), all.filter((id) => !SIMS.includes(id)));
  assert.deepEqual(ids({ webgl2: true, float: false, half: false }), all.filter((id) => !SIMS.includes(id) && id !== 'reaction_diffusion'));
  assert.deepEqual(ids({ webgl2: false, float: false, half: false }), all.filter((id) => !NEW_IDS.includes(id) && !LINES.includes(id) && !ACCUMULATING_RELEASED_IDS.includes(id)));
});

const LAYOUT = {};

async function mount(settings, gl) {
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
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); },
    subscribeSettings: () => () => {},
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(3),
  });
  for (let round = 0; round < 400 && !session.switcher.current; round += 1) {
    await settle(() => Boolean(session.switcher.current), 20);
    h.run(COMPILE_POLL_MS);
  }
  return { gl, h, session, source, signal };
}

test('in the tab: without float targets the four simulations are not offered at all (list, saved scene, shuffle), with no error; the extensions are asked once', async () => {
  await withWebgl2Global(async () => {
    const gl = new SimGL({ float: false, half: true });
    // A saved simulation that cannot be drawn here: the tab starts elsewhere.
    const m = await mount({ visualizerScene: 'curl_silk', visualizerShuffle: 'all' }, gl);
    assert.ok(m.session.switcher.current, 'a scene is shown');
    assert.ok(!SIMS.includes(m.session.switcher.current), m.session.switcher.current);
    assert.equal(gl.extensionAsks.get('EXT_color_buffer_float'), 1, 'asked once');
    assert.equal(gl.extensionAsks.get('EXT_color_buffer_half_float'), 1, 'asked once');
    const listed = m.session.sceneList.shown;
    assert.ok(listed.length > 70, 'the list is shown');
    for (const id of SIMS) assert.ok(!listed.includes(id), `${id}: not listed`);
    assert.ok(listed.includes('reaction_diffusion'), 'half floats: listed');
    assert.ok(listed.includes('feedback'));
    assert.equal(m.session.message.hidden, true, 'no error shown');
    // The shuffle never reaches them either.
    const seen = new Set();
    for (let i = 0; i < 400; i += 1) seen.add(m.session.shuffle.next({ current: [...seen].at(-1) || null }));
    assert.ok(seen.size > 70, `the shuffle went round (${seen.size})`);
    for (const id of SIMS) assert.ok(!seen.has(id), `${id}: never shuffled to`);
    m.session.destroy();
  });
});

/* ---------------- The host ---------------- */

test('the renderer draws a scene that owns its passes through the host: no compile of its own, its values as drawn (capped) handed over', async () => {
  await withWebgl2Global(async () => {
    const { renderer } = simRenderer();
    for (const id of NEW_IDS) {
      const def = await registered(renderer, id);
      assert.ok(ownsPasses(def) && drawable(def), id);
      const prepared = renderer.prepare(def, null);
      assert.equal(prepared.sim, true);
      assert.equal(renderer.compileNow(prepared), SIM_PROGRAM, `${id}: nothing to compile here`);
    }
    // The quality caps reach the scene's own reading of its values.
    renderer.setQuality('low');
    const def = await registered(renderer, 'physarum');
    renderer.useSceneNow(def, [], { agents: 2, resolution: 2, steps: 4 });
    let seen = null;
    const render = def.render;
    def.render = (...args) => { seen = renderer.sim.globals.Controls.getValues(); return render(...args); };
    frames(renderer, 1);
    assert.equal(seen.agents, SCENE_QUALITY_CAPS.physarum.low.agents);
    assert.equal(seen.resolution, SCENE_QUALITY_CAPS.physarum.low.resolution);
    assert.equal(seen.steps, SCENE_QUALITY_CAPS.physarum.low.steps);
    renderer.setQuality('medium');
    frames(renderer, 1, 1);
    assert.equal(seen.agents, SCENE_QUALITY_CAPS.physarum.medium.agents, 'the step-down\'s quality reaches it');
    renderer.destroy();
  });
});

test('everything a visit makes is freed: on a change of scene, when the tab closes, and nothing is touched after a context loss', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    const tunnel = await registered(renderer, 'tunnel');
    renderer.useSceneNow(tunnel);
    frames(renderer, 2);
    const base = gl.aliveCounts();
    for (const id of NEW_IDS) {
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      frames(renderer, 12);
      const during = gl.aliveCounts();
      assert.ok(during.Texture > (base.Texture || 0) && during.Framebuffer > (base.Framebuffer || 0) && during.Program > base.Program, `${id} made its own: ${JSON.stringify(during)}`);
      renderer.useSceneNow(tunnel);
      assert.deepEqual(gl.aliveCounts(), base, `${id}: nothing left after a change of scene`);
      assert.equal(renderer.sim.active, false);
      assert.equal(renderer.sim.made, 0);
    }
    // The tab closes on a simulation.
    renderer.useSceneNow(await registered(renderer, 'lenia'));
    frames(renderer, 5);
    renderer.destroy();
    assert.deepEqual(gl.aliveCounts(), {}, 'nothing at all after destroy');

    // A context loss: the objects went with it. From the loss on, no call
    // at all reaches the context (the scene's cleanup only drops its
    // references), and the next visit makes its own again.
    for (const id of NEW_IDS) {
      const lost = simRenderer();
      lost.renderer.useSceneNow(await registered(lost.renderer, id));
      frames(lost.renderer, 4);
      const calls = [];
      const names = new Set();
      for (let at = lost.gl; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
        for (const name of Object.getOwnPropertyNames(at)) if (name !== 'constructor' && typeof lost.gl[name] === 'function') names.add(name);
      }
      for (const name of names) {
        const original = lost.gl[name];
        lost.gl[name] = (...args) => { calls.push(name); return original.apply(lost.gl, args); };
      }
      lost.gl.lost = true;
      lost.renderer.contextLost();
      assert.equal(lost.renderer.sim.active, false);
      assert.equal(lost.renderer.sim.made, 0);
      assert.deepEqual(calls, [], `${id}: no call to the lost context`);
    }
  });
});

test('the scene is given the context itself (only its create calls are recorded, and only its own), and the recording goes with the host', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    renderer.useSceneNow(await registered(renderer, 'fluid_ink'));
    frames(renderer, 3);
    const { Renderer } = renderer.sim.globals;
    assert.equal(Renderer.getGL(), gl, 'no wrapper object: every other call goes straight to the context');
    assert.equal(Object.prototype.hasOwnProperty.call(gl, 'bindFramebuffer'), false);
    assert.ok(renderer.sim.made > 0, 'what the scene made is recorded');
    // Made by the tab (an FX target) while the scene shows: not the scene's.
    const tabs = gl.createTexture();
    renderer.useSceneNow(await registered(renderer, 'plasma'));
    assert.equal(renderer.sim.made, 0);
    assert.ok(gl.isTexture(tabs), 'the texture the tab made is kept');
    renderer.destroy();
    assert.equal(Object.prototype.hasOwnProperty.call(gl, 'createTexture'), false, 'the wrappers are taken off');
  });
});

test('a later visit never uses what an earlier one freed (GpuSim\'s program cache and each scene\'s targets are made again)', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    const dead = [];
    for (const [name, kind] of [['bindTexture', 'Texture'], ['bindFramebuffer', 'Framebuffer'], ['useProgram', 'Program'], ['bindBuffer', 'Buffer']]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        const object = args[args.length - 1];
        if (object && !gl.alive[kind].has(object)) dead.push(`${name}`);
        return original(...args);
      };
    }
    const tunnel = await registered(renderer, 'tunnel');
    for (const id of NEW_IDS) {
      const def = await registered(renderer, id);
      for (let visit = 0; visit < 3; visit += 1) {
        renderer.useSceneNow(def);
        frames(renderer, 6);
        renderer.useSceneNow(tunnel);
      }
      assert.deepEqual(dead, [], `${id}: no freed object used`);
    }
    renderer.destroy();
  });
});

test('time given a frame is at most 1/30 s: a stall, a hidden tab or the time surge never makes a burst of catch-up steps; a still frame steps nothing', async () => {
  await withWebgl2Global(async () => {
    for (const id of NEW_IDS) {
      const { gl, renderer } = simRenderer();
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      const given = [];
      const render = def.render;
      def.render = (g, program, time, dt) => { given.push(dt); return render(g, program, time, dt); };
      let t = frames(renderer, 30);
      assert.equal(given[0], SIM_FIRST_DT, `${id}: the first frame seeds with a short step`);
      assert.ok(given.slice(1).every((dt) => Math.abs(dt - 1 / 30) < 1e-9), `${id}: 1/30 a frame`);
      // An ordinary frame's work, then a frame after a 20 s stall.
      let before = gl.draws;
      t = frames(renderer, 1, t);
      const ordinary = gl.draws - before;
      before = gl.draws;
      t += 20;
      renderer.draw({ time: t, sources: SOURCES, zoom: 1 });
      assert.equal(given.at(-1), SIM_MAX_DT, `${id}: clamped`);
      assert.ok(gl.draws - before <= ordinary + 1, `${id}: no burst after a stall (${gl.draws - before} draws, ordinary ${ordinary})`);
      // The surge at 3x: still one frame's time.
      before = gl.draws;
      renderer.draw({ time: t + 0.1, sources: SOURCES, zoom: 1 });
      assert.equal(given.at(-1), SIM_MAX_DT);
      assert.ok(gl.draws - before <= ordinary + 1, `${id}: no burst under the surge`);
      // A still picture drawn again: no time passes, so no step.
      const steps = renderer.sim.stats.steps;
      renderer.draw({ time: t + 5, still: true, sources: SOURCES, zoom: 1 });
      assert.equal(given.at(-1), 0, `${id}: a still frame gets no time`);
      assert.equal(renderer.sim.stats.steps, steps);
      renderer.destroy();
    }
  });
});

test('a visit whose first frame is still (paused, reduced motion) draws its starting picture and takes no step', async () => {
  await withWebgl2Global(async () => {
    for (const id of NEW_IDS) {
      const { gl, renderer } = simRenderer();
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      renderer.draw({ time: 5, still: true, sources: SOURCES, zoom: 1 });
      renderer.draw({ time: 6, still: true, sources: SOURCES, zoom: 1 });
      assert.equal(renderer.sim.stats.frames, 2, `${id}: drawn`);
      assert.equal(renderer.sim.stats.steps, 0, `${id}: no step`);
      if (FEEDBACK.includes(id)) {
        assert.equal(def.getDiagnostics().frame, 1, `${id}: seeded once (iFrame 0), nothing after`);
        assert.deepEqual(gl.uniforms.get('iTimeDelta'), [0], `${id}: no time in its seed`);
      }
      // Moving again: steps from there.
      frames(renderer, 3, 6);
      assert.equal(renderer.sim.stats.steps, 3, `${id}: steps once moving`);
      renderer.destroy();
    }
  });
});

test('a resize or a change of quality keeps the picture: the live state is carried into the new size (no restart, nothing left over)', async () => {
  await withWebgl2Global(async () => {
    for (const id of NEW_IDS) {
      const { canvas, gl, renderer } = simRenderer();
      renderer.setQuality('medium');
      const tunnel = await registered(renderer, 'tunnel');
      renderer.useSceneNow(tunnel);
      const base = gl.aliveCounts();
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      let t = frames(renderer, 10);
      const during = gl.aliveCounts();
      const frameBefore = def.getDiagnostics?.()?.frame;
      gl.blits = [];
      canvas.width = 120;
      canvas.height = 80;
      t = frames(renderer, 2, t);
      // Each live target once: Curl-Noise Silk's particles and trails, Fluid
      // Ink's flow, pressure and both sides of its ink, Lenia's world,
      // Physarum's two trail and two agent targets, each feedback buffer.
      const CARRIED = { curl_silk: 2, fluid_ink: 4, lenia: 1, physarum: 4, feedback: 1, reaction_diffusion: 1 };
      assert.equal(gl.blits.length, CARRIED[id], `${id}: carried over on a resize`);
      assert.ok(gl.blits.every((blit) => blit.from && blit.to && blit.from !== blit.to), `${id}: from the old targets into the new`);
      assert.ok(gl.blits.some((blit) => blit.source.join() !== blit.dest.join()), `${id}: stretched into the new size`);
      if (FEEDBACK.includes(id)) assert.ok(def.getDiagnostics().frame > frameBefore, `${id}: its steps go on (not seeded again)`);
      assert.deepEqual(gl.aliveCounts(), during, `${id}: the old targets freed`);
      // Medium to Low: the simulations' own size (caps) changes too.
      if (SIMS.includes(id)) {
        gl.blits = [];
        renderer.setQuality('low');
        frames(renderer, 2, t);
        assert.ok(gl.blits.length > 0, `${id}: carried over on a change of quality`);
      }
      renderer.useSceneNow(tunnel);
      assert.deepEqual(gl.aliveCounts(), base, `${id}: nothing left after`);
      renderer.destroy();
    }
  });
});

test('the frame-feedback scenes: the first frame seeds with one step, then steps follow their rate, at most two a frame; a still frame draws without a step', async () => {
  await withWebgl2Global(async () => {
    for (const id of FEEDBACK) {
      const { gl, renderer } = simRenderer();
      const def = await registered(renderer, id);
      renderer.useSceneNow(def);
      // The runner's own diagnostics: its buffers' size and steps (iFrame).
      const graph = () => def.getDiagnostics();
      renderer.draw({ time: 0.01, sources: SOURCES, zoom: 1 });
      assert.equal(graph().frame, 1, `${id}: seeded with one step`);
      const rate = sceneSimRate(id) || 60;
      let t = frames(renderer, 30, 0.01);
      const expected = 1 + Math.min(FEEDBACK_MAX_STEPS, Math.floor(rate / 30)) * 30;
      assert.ok(Math.abs(graph().frame - expected) <= 1, `${id}: ${graph().frame} steps, ${expected} expected`);
      const at = graph().frame;
      t += 10;
      renderer.draw({ time: t, sources: SOURCES, zoom: 1 });
      assert.ok(graph().frame - at <= FEEDBACK_MAX_STEPS, `${id}: at most ${FEEDBACK_MAX_STEPS} after a stall`);
      const still = graph().frame;
      renderer.draw({ time: t + 1, still: true, sources: SOURCES, zoom: 1 });
      assert.equal(graph().frame, still, `${id}: no step on a still frame`);
      // The adapter's own limit, whatever time it is handed (the host gives
      // at most SIM_MAX_DT): a whole second is still two steps.
      def.render(gl, null, t + 2, 1);
      assert.equal(graph().frame - still, FEEDBACK_MAX_STEPS, `${id}: ${FEEDBACK_MAX_STEPS} steps for a second handed at once`);
      renderer.destroy();
    }
  });
});

test('Fluid Ink, for the processor: each step (the time of two frames, 10 pressure passes) is spread over two frames, so no frame carries a whole step; its drift is off', async () => {
  const { SCENE_DRIFT } = await import('../src/visualizer/scenes.js');
  assert.equal(SCENE_DRIFT.fluid_ink, false);
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    renderer.useSceneNow(await registered(renderer, 'fluid_ink'));
    const perFrame = [];
    const blend = [];
    let t = 0;
    for (let i = 0; i < 8; i += 1) {
      const before = gl.draws;
      t += 1 / 30;
      renderer.draw({ time: t, sources: { ...SOURCES, kick: 0, hat: 0 }, zoom: 1 });
      perFrame.push(gl.draws - before);
      blend.push(gl.uniforms.get('u_prev')[0]);
    }
    // Its first half: 3 emitters' two splats, curl, vorticity, divergence,
    // scale, 2 pressure passes and the display (13; the stand-in mouse's two
    // splats once it has moved); its second: 8 pressure passes, gradient,
    // two advections and the display (12). The frame the ink is carried
    // shows it half way.
    assert.deepEqual(perFrame, [13, 12, 15, 12, 15, 12, 15, 12]);
    assert.deepEqual(blend, [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5]);
    renderer.destroy();
  });
});

test('Fluid Ink is stirred by a stand-in mouse: the clock and the music move it, the same way every visit with the same seed, never a pointer', async () => {
  await withWebgl2Global(async () => {
    const path = async () => {
      const { renderer, canvas } = simRenderer();
      canvas.addEventListener = () => { throw new Error('no listeners'); };
      const def = await registered(renderer, 'fluid_ink');
      renderer.useSceneNow(def);
      const out = [];
      let t = 0;
      for (let i = 0; i < 90; i += 1) {
        t += 1 / 30;
        renderer.draw({ time: t, sources: { ...SOURCES, kick: i % 15 === 0 ? 1 : 0, swell: i / 90 }, zoom: 1 });
        out.push(renderer.sim.mouse);
      }
      // Still: it does not move.
      const held = renderer.sim.mouse;
      renderer.draw({ time: t + 1, still: true, sources: SOURCES, zoom: 1 });
      assert.deepEqual(renderer.sim.mouse, held);
      renderer.destroy();
      return out;
    };
    const a = await path();
    const b = await path();
    assert.deepEqual(a, b, 'deterministic');
    const moved = a.filter((m, i) => i && (m.x !== a[i - 1].x || m.y !== a[i - 1].y)).length;
    assert.ok(moved > 80, 'it moves every frame');
    // Its reach widens with the swell (the far end of the run is wider).
    const reach = (m) => Math.hypot(m.x - 0.5, m.y - 0.5);
    assert.ok(Math.max(...a.slice(-20).map(reach)) > Math.max(...a.slice(0, 20).map(reach)));
    // Fluid Ink stirs only for a move between 0.0005 and 0.2 of the picture a frame.
    for (let i = 1; i < a.length; i += 1) {
      const step = Math.hypot(a[i].x - a[i - 1].x, a[i].y - a[i - 1].y);
      assert.ok(step > 0.0005 && step < 0.2, `step ${i}: ${step}`);
    }
  });
});

test('the host gives each visit its own seeded random, so a visit is drawn the same way again from the same seed', () => {
  const host = (seed) => createSimHost({
    gl: new SimGL(), canvas: { width: 8, height: 8 }, mode: 'webgl2', random: seededRandom(seed),
  });
  const take = (h) => {
    h.start({ render() {} });
    return [0, 1, 2].map(() => h.globals.Math.random());
  };
  assert.deepEqual(take(host(9)), take(host(9)));
  assert.notDeepEqual(take(host(9)), take(host(10)));
  const r = seededSim(0.25);
  for (let i = 0; i < 100; i += 1) { const v = r(); assert.ok(v >= 0 && v < 1); }
  // Other Math functions are Math's own.
  assert.equal(host(1).globals.Math.sin, Math.sin);
});

test('with no such scene shown the host costs nothing: no visit, nothing made, no frame of its own', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    const asks = new Map(gl.extensionAsks);
    const plasma = await registered(renderer, 'plasma');
    renderer.useSceneNow(plasma);
    const alive = gl.aliveCounts();
    frames(renderer, 300);
    assert.deepEqual(renderer.sim.stats, {
      visits: 0, frames: 0, steps: 0, released: 0, freed: 0, clamped: 0,
    });
    assert.equal(renderer.sim.made, 0);
    assert.deepEqual(gl.aliveCounts(), alive, 'nothing made while drawing');
    assert.deepEqual(gl.extensionAsks, asks, 'nothing asked of the context');
    // After a simulation, back to a plain scene: nothing of it runs on.
    renderer.useSceneNow(await registered(renderer, 'lenia'));
    frames(renderer, 3);
    renderer.useSceneNow(plasma);
    const after = { ...renderer.sim.stats };
    frames(renderer, 60);
    assert.deepEqual(renderer.sim.stats, after);
    renderer.destroy();
  });
});

test('as measured: their drift kept off what dims or starves them, Feedback Loop calm, the flickering Physarum palette left out', async () => {
  const { FX_CALM_SCENES, SCENE_DRIFT } = await import('../src/visualizer/scenes.js');
  const { sceneDriftPlan } = await import('../src/visualizer/drift.js');
  const { LOOKS_LEFT_OUT, sceneLooks: looksOf } = await import('../src/visualizer/looks.js');
  assert.equal(SCENE_DRIFT.lenia, false);
  assert.equal(SCENE_DRIFT.reaction_diffusion, false);
  assert.ok(FX_CALM_SCENES.has('feedback'));
  for (const id of SIMS) assert.equal(sceneById(id).fxCalm, false, id);
  await withWebgl2Global(async () => {
    const { renderer } = simRenderer();
    const drifted = async (id) => sceneDriftPlan(await registered(renderer, id), { override: SCENE_DRIFT[id] }).map((row) => row.name);
    assert.deepEqual(await drifted('lenia'), []);
    assert.deepEqual(await drifted('reaction_diffusion'), []);
    assert.ok(!(await drifted('physarum')).includes('deposit'));
    assert.ok((await drifted('physarum')).length > 0, 'its other params still drift');
    assert.ok(!(await drifted('curl_silk')).includes('trail'));
    assert.ok((await drifted('curl_silk')).length > 0);
    assert.deepEqual(LOOKS_LEFT_OUT.physarum, [1]);
    const physarum = await registered(renderer, 'physarum');
    assert.deepEqual(looksOf(physarum).map((look) => look.name), ['Slime Gold']);
    renderer.destroy();
  });
});

test('the zoom punch reaches them: the host hands it on, and the frame-feedback scenes draw it as u_view_zoom', async () => {
  await withWebgl2Global(async () => {
    for (const id of NEW_IDS) {
      const { gl, renderer } = simRenderer();
      renderer.useSceneNow(await registered(renderer, id));
      const { Renderer } = renderer.sim.globals;
      renderer.draw({ time: 0.1, sources: SOURCES, zoom: 1.04 });
      assert.equal(Renderer.getViewZoom(), 1.04, id);
      if (FEEDBACK.includes(id)) assert.equal(Math.fround(gl.uniforms.get('u_view_zoom')[0]), Math.fround(1.04), `${id} draws it`);
      renderer.draw({ time: 0.2, sources: SOURCES });
      assert.equal(Renderer.getViewZoom(), 1, `${id} at rest without one`);
      if (FEEDBACK.includes(id)) assert.deepEqual(gl.uniforms.get('u_view_zoom'), [1]);
      renderer.destroy();
    }
  });
});

test('a plain WebGL 1 renderer refuses them cleanly (they are never offered there)', async () => {
  const canvas = { width: 8, height: 8 };
  const renderer = createSceneRenderer({ canvas, gl: new FakeGL(), mode: 'webgl' });
  const def = renderer.register(await sceneById('feedback').load(), 'feedback');
  assert.throws(() => renderer.prepare(def, null), /needs WebGL 2/);
  renderer.destroy();
});

/* ---------------- Palette Map (a finding from the real window) ---------------- */

test('Palette Map: neighbouring values get neighbouring colours (no jump from the palette\'s last colour to its first, none at red for a hue key)', () => {
  const text = readFileSync(join(VENDOR_DIR, 'engine', 'post-fx-library.js'), 'utf8');
  const body = text.slice(text.indexOf("name: 'palette_map'"), text.indexOf("name: 'color_wash'"));
  assert.doesNotMatch(body, /fract\(key \* u_spread/, 'no wrap of the index');
  assert.match(body, /float hue = 0\.5 - 0\.5 \* cos\(6\.28318 \* toHsv\(c\)\.x\);/);
  assert.match(body, /vec2\(1\.0 - abs\(1\.0 - 2\.0 \* fract\(at \* 0\.5\)\), 0\.5\)/);
  // The index as the shader works it out, over every key, spread, cycle and
  // offset the FX shuffle uses: a small change of key never moves it far.
  const fract = (x) => x - Math.floor(x);
  const index = (key, spread, shift) => 1 - Math.abs(1 - 2 * fract(((key * spread) + shift) * 0.5));
  const hueKey = (h) => 0.5 - 0.5 * Math.cos(6.28318 * h);
  for (const spread of [0.6, 1, 1.6]) {
    for (const shift of [0, 0.37, 0.99, 1.5]) {
      for (let k = 0; k < 1000; k += 1) {
        const a = k / 1000;
        const b = (k + 1) / 1000;
        assert.ok(Math.abs(index(a, spread, shift) - index(b, spread, shift)) < 0.01, `brightness ${a}`);
        // Hue: 0.999 and 0.000 are the same colour, and get the same index.
        assert.ok(Math.abs(index(hueKey(a), spread, shift) - index(hueKey(b % 1), spread, shift)) < 0.02, `hue ${a}`);
      }
    }
  }
});

/* ---------------- Looks that sat near black ---------------- */

test('Fractal Flame Lab: the looks that went near black for long are held lit (colour cycling held) or left out', async () => {
  const { EXTRA_LOOK_FIRST, LOOK_ADJUSTED, PRESETS_LEFT_OUT: OUT, sceneLooks: looksOf } = await import('../src/visualizer/looks.js');
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const def = renderer.register(await sceneById('fractal_flame_lab').load(), 'fractal_flame_lab');
  const looks = looksOf(def);
  const byName = new Map(looks.map((look) => [look.name, look]));
  for (const name of ['Mandala Bloom Wheel', 'Lace Arch Lantern', 'Starburst Ray Choir', 'PDJ Chaos Silk', 'Rings Orbit Flame']) {
    assert.equal(LOOK_ADJUSTED.fractal_flame_lab[name].flame_color_speed, 0, name);
    assert.equal(byName.get(name)?.values.flame_color_speed, 0, `${name}: offered, its colours held`);
  }
  for (const name of ['Spherical Ember Cloud', 'Julia Veil Glass', 'Radial Streak Crown', 'Popcorn Texture Bloom']) {
    assert.ok(OUT.fractal_flame_lab.includes(name));
    assert.equal(byName.has(name), false, `${name}: left out`);
  }
  // The others as Psychedelia has them; with all, the adjusted values still apply.
  assert.equal(byName.get('Swirl Spiral Bloom').values.flame_color_speed, undefined);
  const all = looksOf(def, { all: true });
  // The presets (the extra looks, from 20, have their own test).
  assert.equal(all.filter((look) => look.number < EXTRA_LOOK_FIRST).length, 12);
  assert.equal(all.find((look) => look.name === 'Starburst Ray Choir').values.flame_color_speed, 0);
  renderer.destroy();
});

test('the simulations that sat near black start brighter or on a living rule, and the Fluid Ink colour schemes carry their brightness', async () => {
  const { lookOverrides, sceneLooks: looksOf, startLook } = await import('../src/visualizer/looks.js');
  const { sceneDefaults } = await import('../src/visualizer/scene-renderer.js');
  assert.equal(sceneById('curl_silk').defaults.brightness, 2.6);
  assert.equal(sceneById('lenia').defaults.rule, 1);
  assert.equal(sceneById('fluid_ink').defaults.brightness, 1.6);
  await withWebgl2Global(async () => {
    const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new SimGL(), mode: 'webgl2' });
    const entry = sceneById('fluid_ink');
    const def = renderer.register(await entry.load(), 'fluid_ink');
    const looks = looksOf(def);
    const brightness = Object.fromEntries(looks.map((look) => [look.name, look.values.brightness]));
    assert.deepEqual(brightness, { 'Rainbow Cycle': 1.6, 'Ink & Gold': 2.2, Neon: 1.6, Pastel: 1 });
    // Shown before any look is chosen, it is its first look.
    assert.equal(startLook(looks, sceneDefaults(def, entry.defaults)), looks[0].number);
    assert.equal(lookOverrides(entry, def, looks[1].number).brightness, 2.2);
    assert.equal(lookOverrides(entry, def, undefined).brightness, 1.6);
    renderer.destroy();
  });
});

/* ---------------- Steadier frames, kept pictures, a warm start ---------------- */

test('Physarum takes at most two steps a frame, however much time it is handed', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    renderer.setQuality('medium');
    const def = await registered(renderer, 'physarum');
    renderer.useSceneNow(def, [], sceneById('physarum').defaults);
    frames(renderer, 4);
    // Its render handed a quarter of a second at once (15 steps owed at
    // 60 a second): two of them, one deposit each.
    const before = gl.pointDraws;
    renderer.sim.globals.Renderer.bindFramebuffer(-1);
    def.render(gl, null, 1, 0.25);
    assert.equal(gl.pointDraws - before, 2);
    renderer.destroy();
  });
});

test('Physarum keeps its agents across a change of quality: resampled to the new count (every n-th going down, repeated going up), not seeded again', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = simRenderer();
    renderer.setQuality('medium');
    renderer.useSceneNow(await registered(renderer, 'physarum'), [], sceneById('physarum').defaults);
    let t = frames(renderer, 6);
    const resample = () => gl.sources.filter((shader) => shader.source.includes('u_fromSize')).length;
    assert.equal(resample(), 0, 'nothing to resample while the count stays');
    for (const [quality, from, to] of [['low', 512, 256], ['high', 256, 512]]) {
      const compiled = resample();
      renderer.setQuality(quality);
      t = frames(renderer, 1, t);
      assert.equal(resample(), compiled + 1, `${quality}: resampled`);
      assert.deepEqual([gl.uniforms.get('u_fromSize')[0], gl.uniforms.get('u_toSize')[0]], [from, to], quality);
      // Its program is freed once used: only the scene's own four live on.
      assert.equal(gl.aliveCounts().Program, 4, quality);
    }
    renderer.destroy();
  });
});

test('Physarum deposits by its trail field area: a smaller field (Low, a smaller window) is no brighter', async () => {
  await withWebgl2Global(async () => {
    const amount = async (width, height) => {
      const { gl, renderer, canvas } = simRenderer();
      canvas.width = width;
      canvas.height = height;
      renderer.setQuality('medium');
      renderer.useSceneNow(await registered(renderer, 'physarum'), [], sceneById('physarum').defaults);
      frames(renderer, 3, 0, { sources: { ...SOURCES, kick: 0 } });
      const out = gl.uniforms.get('u_amount')[0];
      renderer.destroy();
      return out;
    };
    // Half the trail field on each side (its field is half the picture): a
    // quarter of the deposit.
    const ratio = (await amount(800, 400)) / (await amount(1600, 800));
    assert.ok(Math.abs(ratio - 0.25) < 1e-6, String(ratio));
  });
});
