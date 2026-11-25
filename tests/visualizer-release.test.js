import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../src/lib/state.js';
import { createAudioSignal } from '../src/lib/audio-signal.js';
import { createFlashLedger, FLASH_LIMITS } from '../src/visualizer/flash-limiter.js';
import { readVisualizerDevFlags } from '../src/visualizer/dev-flags.js';
import { createFxChain } from '../src/visualizer/fx-chain.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { SCENES, sceneById, scenesForVisualizer } from '../src/visualizer/scenes.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import {
  CROSSFADE_MS, CROSSFADE_SLOW_MS, WARP_DISSOLVE_MS, WARP_FALLBACK_MS, WARP_MAX_FRAME_STEP, createTransition,
} from '../src/visualizer/transition.js';
import { warpWeight } from '../src/visualizer/warp-dissolve.js';
import { FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle } from './helpers/visualizer-fakes.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';

const withStorage = (values) => ({ localStorage: { getItem: (key) => values[key] ?? null } });

test('measurement flags default on, parse independently, and tolerate unavailable storage', () => {
  const defaults = { tryHeld: false, structure: true, colorTravel: true, warpDissolve: true, debug: false };
  assert.deepEqual(readVisualizerDevFlags(withStorage({})), defaults);
  assert.deepEqual(readVisualizerDevFlags({ get localStorage() { throw new Error('blocked'); } }), defaults);
  assert.deepEqual(readVisualizerDevFlags(withStorage({
    'worldmedia.viz.tryHeld': '1',
    'worldmedia.viz.devFlags': ' noStructure, , unknown, noColorTravel ',
  })), { ...defaults, tryHeld: true, structure: false, colorTravel: false });
  assert.deepEqual(readVisualizerDevFlags(withStorage({
    'worldmedia.viz.tryHeld': 'true', 'worldmedia.viz.devFlags': 'noWarpDissolve,debug',
  })), { ...defaults, warpDissolve: false, debug: true });
});

test('held previews are added only to the developer list and keep cautious scene caps', () => {
  assert.equal(scenesForVisualizer(false), SCENES);
  const preview = scenesForVisualizer(true).filter((scene) => scene.devOnly);
  assert.deepEqual(preview.map(({ id }) => id).sort(), [
    'attractor_density_lab', 'flam3_density_lab', 'hypercomplex_slice_flight', 'ifs_lsystem_lab',
  ]);
  for (const scene of preview) {
    assert.equal(sceneById(scene.id), null);
    assert.equal(scene.fxNone, true);
    assert.equal(scene.maxSpeed, 1);
    assert.equal(scene.drift, false);
  }
  assert.ok(sceneById('epicycles'));
  assert.ok(sceneById('polytopes'));
});

test('the tab reads flags once and saves the color travel setting across mounts', () => {
  const flags = {};
  let stored = '{}';
  const win = { ...fakeMotion(false).win, ...withStorage(flags) };
  const build = () => {
    const root = new FakeNodeEl('div');
    const h = createClockHarness();
    const session = mountVisualizer(root, {
      win, doc: fakeDocWithElements().doc, loopOptions: h.io,
      getSettings: () => normalizeSettings(JSON.parse(stored)),
      saveSettings: (patch) => { stored = JSON.stringify(normalizeSettings({ ...JSON.parse(stored), ...patch })); },
      createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
    });
    return { root, h, session };
  };
  const first = build();
  assert.ok(first.root.contains(first.session.controls.colorTravel));
  assert.equal(first.session.controls.colorTravel.checked, true);
  assert.ok(first.session.structure);
  assert.ok(!first.session.sceneList.shown.includes('flam3_density_lab'));

  flags['worldmedia.viz.devFlags'] = 'noStructure,noColorTravel';
  flags['worldmedia.viz.tryHeld'] = '1';
  assert.ok(first.session.structure, 'saved flags take effect on the next mount');
  assert.equal(win.__worldmediaVizDebug, undefined);
  first.session.controls.colorTravel.checked = false;
  first.session.controls.colorTravel.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(stored).visualizerColorTravel, false);
  first.session.destroy();
  assert.equal(first.h.pending(), 0);

  const flagged = build();
  assert.equal(flagged.session.structure, null);
  assert.ok(!flagged.root.contains(flagged.session.controls.colorTravel));
  assert.ok(flagged.session.sceneList.shown.includes('flam3_density_lab'));
  flagged.session.destroy();

  delete flags['worldmedia.viz.devFlags'];
  const reopened = build();
  assert.ok(reopened.root.contains(reopened.session.controls.colorTravel));
  assert.equal(reopened.session.controls.colorTravel.checked, false);
  reopened.session.controls.colorTravel.checked = true;
  reopened.session.controls.colorTravel.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(stored).visualizerColorTravel, true);
  reopened.session.destroy();
});

test('reduced motion cancels a shuffle scene still waiting for its fallback dip', async () => {
  const h = createClockHarness();
  const motion = fakeMotion(false);
  const { doc } = fakeDocWithElements({ width: 800, height: 600 });
  const analyser = fakeAnalyser({ level: 80, db: -55 });
  const signal = createAudioSignal({
    source: { isPlaying: () => true, getAnalyser: () => analyser }, doc, ...h.io,
  });
  const settings = { visualizerNoticeSeen: true, visualizerScene: 'plasma', visualizerShuffle: true };
  const session = mountVisualizer(new FakeNodeEl('div'), {
    win: motion.win, doc, signal, loopOptions: h.io, flashLedger: createFlashLedger(),
    scenes: ['plasma', 'tunnel'].map(sceneById),
    getSettings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
  });
  try {
    let due = false;
    session.shuffleTimer.step = () => due;
    for (let attempt = 0; attempt < 10 && !session.switcher.staged('tunnel'); attempt += 1) {
      h.run(150);
      await settle(() => session.switcher.staged('tunnel'), 40);
    }
    assert.equal(session.switcher.current, 'plasma');
    assert.ok(session.switcher.staged('tunnel'));
    due = true;
    h.run(60);
    assert.equal(session.transition.phase, 'out');
    assert.equal(session.switcher.wanted, 'tunnel');
    assert.equal(settings.visualizerScene, 'plasma');
    motion.set(true);
    h.run(CROSSFADE_MS);
    assert.equal(session.transition.phase, 'idle');
    assert.equal(session.switcher.current, 'plasma');
    assert.equal(settings.visualizerScene, 'plasma');
  } finally {
    session.destroy();
  }
  assert.equal(h.pending(), 0);
});

test('an automatic shuffle change starts and completes a warped dissolve', async () => {
  const h = createClockHarness();
  const { doc } = fakeDocWithElements({ width: 320, height: 200 });
  const analyser = fakeAnalyser({ level: 80, db: -55 });
  const signal = createAudioSignal({
    source: { isPlaying: () => true, getAnalyser: () => analyser }, doc, ...h.io,
  });
  const gl = new FakeGL();
  gl.copyTexImage2D = () => {};
  const win = fakeMotion(false).win;
  const session = mountVisualizer(new FakeNodeEl('div'), {
    win, doc, signal, loopOptions: h.io, flashLedger: createFlashLedger(),
    scenes: ['living_sun', 'waves'].map(sceneById),
    getSettings: () => ({
      visualizerNoticeSeen: true, visualizerScene: 'living_sun', visualizerShuffle: true, visualizerFps: 60,
    }),
    createContext: () => ({ gl, mode: 'webgl2' }),
  });
  try {
    let due = false;
    session.shuffleTimer.step = () => due;
    for (let attempt = 0; attempt < 20 && !session.switcher.staged('waves'); attempt += 1) {
      h.run(100);
      await settle(() => session.switcher.staged('waves'), 15);
    }
    assert.equal(session.switcher.current, 'living_sun');
    assert.ok(session.switcher.staged('waves'));
    const charges = session.bridge.limiter.stats.transitions;
    due = true;
    h.run(100);
    due = false;
    assert.equal(session.switcher.current, 'waves');
    assert.equal(session.shuffleStats.changes, 1);
    assert.equal(session.transition.phase, 'warping');
    assert.equal('dissolveStats' in session, false);
    assert.equal('dissolveStats' in session.transition, false);
    assert.equal('warps' in session.transition.stats, false);
    assert.equal('__worldmediaVizDebug' in win, false);
    assert.equal(session.bridge.limiter.stats.transitions, charges + 1);
    h.run(WARP_DISSOLVE_MS / 2);
    assert.ok(session.transition.warpProgress > 0.3 && session.transition.warpProgress < 0.8);
    h.run(WARP_DISSOLVE_MS / 2);
    assert.equal(session.transition.phase, 'idle');
  } finally {
    session.destroy();
  }
  assert.equal(h.pending(), 0);
});

function dissolve({ charged = true, enabled = true, animate = true, copyError = false } = {}) {
  const h = createClockHarness();
  const gl = new FakeGL({ parallel: true });
  let copied = 0;
  let outgoingDraws = 0;
  let redraws = 0;
  gl.NO_ERROR = 0;
  gl.getError = () => copyError ? 0x0502 : gl.NO_ERROR;
  gl.copyTexImage2D = () => {
    assert.equal(gl.boundFramebuffer, null);
    copied += 1;
  };
  const chain = createFxChain({ gl, mode: 'webgl2' });
  const canvas = { width: 8, height: 8, style: {} };
  const fadeCopies = [];
  const fade = {
    hidden: true, animate: animate ? () => ({ cancel() {} }) : undefined,
    getContext: () => ({
      fillRect() {},
      drawImage: () => fadeCopies.push(gl.uniforms.get('u_progress')?.[0]),
    }),
  };
  const transition = createTransition({
    canvas, fade, ...h.io, brightness: () => 1,
    enabled: () => enabled, charge: () => charged, debug: true,
    drawOld: () => { outgoingDraws += 1; return true; },
    warp: {
      capture: (drawOld) => chain.captureWarp(canvas.width, canvas.height, drawOld),
      release: () => chain.endWarp(),
      redraw: () => { redraws += 1; },
    },
  });
  const drawIncoming = () => {
    const progress = transition.nextWarpProgress();
    chain.setWarpProgress(progress);
    assert.ok(chain.begin(canvas.width, canvas.height));
    assert.ok(chain.finish({ time: h.io.clock() / 1000 }));
    transition.presentWarp(progress);
    return gl.uniforms.get('u_progress')[0];
  };
  return { h, gl, chain, transition, drawIncoming, canvas, fade, fadeCopies,
    counts: () => ({ copied, outgoingDraws, redraws }) };
}

test('all dissolve shader outputs are adapted for WebGL 1 and 2', () => {
  for (const [mode, output] of [['webgl', 'gl_FragColor'], ['webgl2', 'fragColor']]) {
    const gl = new FakeGL();
    gl.copyTexImage2D = () => {};
    const chain = createFxChain({ gl, mode });
    try {
      chain.captureWarp(8, 8, () => true);
      const shader = gl.sources.find(({ source }) => source.includes('uniform sampler2D u_from;')).source;
      assert.doesNotMatch(shader, /FRAG_OUT/);
      assert.equal(shader.match(new RegExp(output + ' =', 'g')).length, 3);
    } finally {
      chain.destroy();
    }
  }
});

test('a WebGL copy error releases the invalid snapshot and uses a compositor fade', () => {
  const { gl, chain, transition, fade, counts } = dissolve({ copyError: true });
  assert.equal(transition.begin({ dissolve: true }), 0);
  assert.equal(transition.phase, 'fading');
  assert.equal(fade.hidden, false);
  assert.equal(transition.stats.dips, 0);
  assert.equal(counts().copied, 1);
  assert.equal(transition.dissolveStats.skipped, 1);
  assert.deepEqual(transition.dissolveStats.skipReasons, { 'snapshot-copy': 1 });
  assert.equal(gl.textures.size, 0);
  transition.finishNow();
  chain.destroy();
});

test('a dissolve runs for its nominal length at 60 fps and finishes at lower frame rates', () => {
  for (const fps of [60, 30, 15, 5]) {
    const { h, gl, chain, transition, drawIncoming } = dissolve();
    assert.equal(transition.begin({ dissolve: true }), 0);
    assert.equal(transition.duration, 1000);
    assert.equal(transition.dissolveStats.slow, 0);
    transition.applied();
    assert.equal(drawIncoming(), 0);
    const levels = [0.14, 0.54];
    let previous = 0;
    for (let frame = 0; frame < 120 && transition.busy; frame += 1) {
      h.run(1000 / fps);
      const progress = drawIncoming();
      assert.ok(progress > previous && progress - previous <= WARP_MAX_FRAME_STEP + 1e-9);
      for (const noise of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const delta = (levels[1] - levels[0]) * (warpWeight(progress, noise) - warpWeight(previous, noise));
        assert.ok(delta >= 0 && delta <= 0.12);
      }
      previous = progress;
    }
    assert.equal(previous, 1);
    const { completed, fallbacks, last } = transition.dissolveStats;
    assert.equal(completed, 1);
    assert.equal(fallbacks, 0);
    if (fps === 60) {
      assert.ok(Math.abs(last.durationMs - WARP_DISSOLVE_MS) <= WARP_DISSOLVE_MS * 0.15);
      assert.ok(last.drawnFrames >= 52 && last.drawnFrames <= 70);
    }
    assert.equal(gl.textures.size, 0);
    h.run(WARP_FALLBACK_MS);
    assert.equal(transition.dissolveStats.fallbacks, 0);
    assert.equal(h.pending(), 0);
    chain.destroy();
  }
});

test('an uncharged dissolve keeps full-frame brightness steps small and completes', () => {
  const duration = 2500;
  // The Visualizer flash check flags full-frame luma steps over 0.10.
  const frameMean = (progress) => {
    const noise = [0.1, 0.3, 0.5, 0.7, 0.9];
    // Dissolve from a black frame to a white one, including 8-bit rounding.
    return noise.reduce((sum, n) => sum + Math.round(255 * warpWeight(progress, n)), 0) / (255 * noise.length);
  };
  for (const fps of [60, 5]) {
    const { h, gl, chain, transition, drawIncoming } = dissolve({ charged: false });
    assert.equal(transition.begin({ dissolve: true }), 0);
    assert.equal(transition.phase, 'warping');
    assert.equal(transition.duration, duration);
    assert.equal(transition.begin({ dissolve: true }), duration);
    transition.applied();
    assert.equal(drawIncoming(), 0);
    let previous = 0;
    let largestStep = 0;
    for (let frame = 0; frame < 200 && transition.busy; frame += 1) {
      // At 5 fps, also check the first draw after a gap just short of fallback.
      h.run(fps === 5 && frame === 1 ? WARP_FALLBACK_MS - 1 : 1000 / fps);
      const progress = drawIncoming();
      assert.ok(progress > previous);
      assert.ok(progress - previous <= WARP_MAX_FRAME_STEP * WARP_DISSOLVE_MS / duration + 1e-9);
      largestStep = Math.max(largestStep, Math.abs(frameMean(progress) - frameMean(previous)));
      previous = progress;
    }
    assert.equal(previous, 1);
    assert.ok(largestStep < 0.10, `largest full-frame brightness step: ${largestStep}`);
    if (fps === 60) assert.ok(Math.abs(h.now - duration) <= 1000 / fps + 1e-9);
    const { started, slow, skipped, completed, fallbacks } = transition.dissolveStats;
    assert.deepEqual({ started, slow, skipped, completed, fallbacks },
      { started: 1, slow: 1, skipped: 0, completed: 1, fallbacks: 0 });
    assert.equal(gl.textures.size, 0);
    assert.equal(h.pending(), 0);
    chain.destroy();
  }
});

test('a long stall mid-dissolve cannot jump from dark to bright in a frame', () => {
  const { h, gl, chain, transition, drawIncoming, counts } = dissolve();
  assert.equal(chain.active, false);
  assert.equal(transition.begin({ dissolve: true }), 0);
  transition.applied();
  let previous = 0;
  for (let frame = 0; frame < 6; frame += 1) {
    h.run(1000 / 30);
    previous = drawIncoming();
  }
  assert.ok(previous > 0 && previous < 0.5);
  h.run(WARP_FALLBACK_MS - 1);
  assert.equal(transition.warpProgress, previous);
  assert.equal(transition.phase, 'warping');
  assert.equal(gl.textures.size, 2);
  assert.ok(transition.begin({ dissolve: true }) > 0);
  transition.nextWarpProgress(); // A frame was requested but never drawn.
  assert.equal(transition.warpProgress, previous);
  for (let frame = 0; frame < 30 && transition.busy; frame += 1) {
    const progress = drawIncoming();
    assert.ok(progress > previous && progress - previous <= WARP_MAX_FRAME_STEP + 1e-9);
    for (const noise of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      // For a black-to-white dissolve, the blend weight is the pixel's value.
      assert.ok(warpWeight(progress, noise) - warpWeight(previous, noise) < 0.1);
    }
    previous = progress;
    h.run(1000 / 30);
  }
  assert.equal(previous, 1);
  assert.equal(transition.phase, 'idle');
  assert.equal(chain.active, false);
  assert.equal(gl.textures.size, 0);
  assert.deepEqual(counts(), { copied: 1, outgoingDraws: 1, redraws: 0 });
  chain.destroy();
});

test('a slow dissolve with no new frames hands the last composite to a slow compositor fade', () => {
  const { h, gl, chain, transition, drawIncoming, fade, fadeCopies, counts } = dissolve({ charged: false });
  assert.equal(transition.begin({ dissolve: true }), 0);
  transition.applied();
  h.run(1000 / 30);
  assert.equal(drawIncoming(), 0);
  h.run(1000 / 30);
  const lastDrawn = drawIncoming();
  assert.ok(lastDrawn > 0);
  h.run(WARP_FALLBACK_MS - 1);
  assert.equal(transition.phase, 'warping');
  assert.equal(transition.warpProgress, lastDrawn);
  assert.equal(gl.textures.size, 2);
  h.run(1);
  assert.equal(transition.phase, 'fading');
  assert.equal(fade.hidden, false);
  assert.deepEqual(fadeCopies, [lastDrawn]);
  assert.equal(transition.dissolveStats.completed, 0);
  assert.equal(transition.dissolveStats.fallbacks, 1);
  assert.deepEqual(transition.dissolveStats.last, { outcome: 'fallbacks', drawnFrames: 2, durationMs: h.now });
  assert.equal(gl.textures.size, 0);
  assert.equal(counts().redraws, 1);
  assert.equal(transition.duration, CROSSFADE_SLOW_MS);
  h.run(CROSSFADE_SLOW_MS);
  assert.equal(transition.busy, false);
  assert.equal(fade.hidden, true);
  assert.equal(transition.begin({ dissolve: true }), 0, 'later changes can start');
  transition.finishNow();
  assert.equal(h.pending(), 0);
  chain.destroy();
});

test('a hand pick starts a slow dissolve at once with a full limiter and a new resolution', async () => {
  const h = createClockHarness();
  const { doc } = fakeDocWithElements({ width: 2560, height: 1440 });
  const analyser = fakeAnalyser({ level: 80, db: -55 });
  const signal = createAudioSignal({
    source: { isPlaying: () => true, getAnalyser: () => analyser }, doc, ...h.io,
  });
  const gl = new FakeGL();
  const drawArrays = gl.drawArrays.bind(gl);
  const deleteProgram = gl.deleteProgram.bind(gl);
  let oldProgram;
  let lastPicture;
  let snapshot;
  let screen;
  const steps = [];
  const frames = [];
  const incoming = [140, 20, 105, 55];
  gl.RGB = 0x1907;
  gl.NO_ERROR = 0;
  gl.getError = () => gl.NO_ERROR;
  gl.getContextAttributes = () => ({ alpha: false, preserveDrawingBuffer: true });
  gl.copyTexImage2D = (_target, _level, format, x, y, w, height) => {
    assert.equal(gl.boundFramebuffer, null);
    assert.equal(format, gl.RGB, 'an opaque framebuffer has no alpha to copy');
    assert.deepEqual([x, y, w, height], [0, 0, session.canvas.width, session.canvas.height]);
    assert.ok(gl.programs.has(oldProgram));
    snapshot = gl.boundTextures.get(gl.TEXTURE0);
    snapshot.pixels = [...screen];
    steps.push('snapshot');
  };
  gl.deleteProgram = (program) => {
    if (program === oldProgram) steps.push('release');
    deleteProgram(program);
  };
  gl.drawArrays = () => {
    drawArrays();
    if (gl.current.fragment.includes('uniform sampler2D u_from;')) {
      const [progress] = gl.uniforms.get('u_progress');
      const from = gl.boundTextures.get(gl.TEXTURE1).pixels;
      const to = gl.boundTextures.get(gl.TEXTURE0).pixels;
      const [layer] = gl.uniforms.get('u_layer_mix');
      // Give the warped layer the darkest possible sample in both inputs.
      screen = from.map((value, i) => {
        const linear = value * (1 - progress) + to[i] * progress;
        return progress === 0 || progress === 1 ? linear : linear * (1 - layer);
      });
      frames.push({ progress, pixels: screen });
      return;
    }
    if (gl.boundFramebuffer) {
      gl.boundFramebuffer.texture.pixels = incoming;
    } else {
      if (lastPicture && !snapshot) steps.push('redraw');
      screen = [20, 110, 50, 140];
    }
  };
  gl.framebufferTexture2D = (_target, _attach, _kind, texture) => {
    gl.boundFramebuffer.texture = texture;
  };
  const win = { ...fakeMotion(false).win, ...withStorage({ 'worldmedia.viz.devFlags': 'debug' }) };
  const session = mountVisualizer(new FakeNodeEl('div'), {
    win, doc, signal, loopOptions: h.io, flashLedger: createFlashLedger(),
    scenes: ['color_cycle', 'black_hole'].map(sceneById),
    getSettings: () => ({
      visualizerNoticeSeen: true, visualizerScene: 'color_cycle', visualizerColorTravel: false,
      visualizerFps: 60, processorUse: 'high', visualizerQuality: 'very_high',
    }),
    readProcessorUse: async () => ({ available: true, share: 0.1 }),
    createContext: (_canvas, attributes) => {
      assert.equal(attributes.preserveDrawingBuffer, true);
      return { gl, mode: 'webgl2' };
    },
  });
  try {
    const waitForScene = async (id) => {
      for (let step = 0; step < 30 && session.switcher.current !== id; step += 1) {
        await settle(() => false, 10);
        h.run(30);
      }
      assert.equal(session.switcher.current, id);
    };
    await waitForScene('color_cycle');
    h.run(250);
    oldProgram = gl.current;
    lastPicture = screen;
    session.switcher.preload('black_hole');
    await settle(() => session.switcher.staged('black_hole'));
    h.run(60);
    steps.length = 0;
    lastPicture = screen;
    const oldSize = [session.canvas.width, session.canvas.height];
    const drawIncoming = session.renderer.draw.bind(session.renderer);
    session.renderer.draw = () => false; // The incoming scene has no frame yet.
    const limiter = session.bridge.limiter;
    const now = h.now / 1000;
    for (let i = 0; i < FLASH_LIMITS.maxPulsesPerSecond && limiter.room(now); i += 1) limiter.transition(now);
    assert.equal(limiter.room(now), false);
    const charges = limiter.stats.transitions;
    session.sceneList.pick('black_hole');
    assert.equal(limiter.stats.transitions, charges);
    assert.equal(session.switcher.current, 'black_hole');
    assert.notDeepEqual([session.canvas.width, session.canvas.height], oldSize);
    assert.equal(session.transition.phase, 'warping');
    assert.deepEqual(steps, ['snapshot', 'release']);
    const debug = win.__worldmediaVizDebug;
    assert.equal(debug, session.dissolveStats);
    assert.equal(debug.started, 1);
    assert.equal(session.transition.stats.warps, 1);
    assert.equal(debug.slow, 1);
    assert.equal(debug.skipped, 0);
    assert.deepEqual(snapshot.pixels, lastPicture);
    const frozenFrame = { progress: 0, pixels: lastPicture };
    assert.deepEqual(frames, [frozenFrame], 'the resize immediately restores the frozen picture');
    h.run(120);
    assert.deepEqual(frames, [frozenFrame]);
    assert.deepEqual(screen, lastPicture);
    session.renderer.draw = drawIncoming;
    h.run(120);
    assert.deepEqual(frames[1], frozenFrame);
    assert.ok(frames.at(-1).progress > 0);
    h.run(session.transition.duration + 100);
    assert.deepEqual(frames.at(-1), { progress: 1, pixels: incoming });
    const mean = (pixels) => pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    const floor = 0.75 * Math.min(mean(lastPicture), mean(incoming));
    assert.ok(frames.every(({ pixels }) => mean(pixels) >= floor));
    assert.ok(!gl.textures.has(snapshot), 'the outgoing texture is freed at the end');
    assert.equal(debug.completed, 1);
    assert.equal(debug.fallbacks, 0);
    assert.equal(debug.last.drawnFrames, frames.length);
  } finally {
    session.destroy();
  }
  assert.equal(win.__worldmediaVizDebug, undefined);
  assert.equal(h.pending(), 0);
});

test('a mounted dissolve advances on a new frame, then hands off to a fade before resizing', async () => {
  const h = createClockHarness();
  const win = fakeResizeObserverWin(fakeMotion(false));
  const { doc } = fakeDocWithElements({ width: 320, height: 200 });
  const gl = new FakeGL();
  let snapshot;
  gl.copyTexImage2D = () => { snapshot = gl.boundTextures.get(gl.TEXTURE0); };
  const session = mountVisualizer(new FakeNodeEl('div'), {
    win, doc, loopOptions: h.io, flashLedger: createFlashLedger(),
    scenes: ['plasma', 'tunnel'].map(sceneById),
    getSettings: () => ({ visualizerNoticeSeen: true }),
    createContext: () => ({ gl, mode: 'webgl2' }),
  });
  try {
    let duration;
    session.fade.animate = (frames, options) => {
      assert.deepEqual(frames, [{ opacity: 1 }, { opacity: 0 }]);
      duration = options.duration;
      return { cancel() {} };
    };
    const copied = [];
    session.fade.getContext = () => ({
      fillRect() {},
      drawImage(canvas) { copied.push([canvas.width, canvas.height, ...gl.uniforms.get('u_progress')]); },
    });
    const waitForScene = async (id) => {
      for (let step = 0; step < 30 && session.switcher.current !== id; step += 1) {
        await settle(() => false, 10);
        h.run(30);
      }
      assert.equal(session.switcher.current, id);
    };
    await waitForScene('plasma');
    h.run(250);
    const charges = session.bridge.limiter.stats.transitions;
    session.sceneList.pick('tunnel');
    await waitForScene('tunnel');
    assert.equal(session.transition.phase, 'warping');
    assert.equal(session.bridge.limiter.stats.transitions, charges + 1);
    h.run(250);
    const before = session.transition.warpProgress;
    assert.ok(before > 0);
    h.run(CROSSFADE_MS * 2, 10000);
    session.loop.redraw();
    assert.equal(session.transition.warpProgress, before);
    assert.deepEqual(gl.uniforms.get('u_progress'), [before]);
    h.run(20);
    const resumed = session.transition.warpProgress;
    assert.ok(resumed > before && resumed - before <= WARP_MAX_FRAME_STEP + 1e-9);
    const oldSize = [session.canvas.width, session.canvas.height];
    assert.ok(gl.textures.has(snapshot));
    win.observers[0].fire(500, 400);
    assert.notDeepEqual([session.canvas.width, session.canvas.height], oldSize);
    assert.deepEqual(copied, [[...oldSize, resumed]]);
    assert.equal(gl.textures.has(snapshot), false);
    assert.equal(session.transition.phase, 'fading');
    assert.equal(session.fade.hidden, false);
    assert.equal(duration, CROSSFADE_MS);
    h.run(CROSSFADE_MS);
    assert.equal(session.transition.phase, 'idle');
    assert.equal(session.fade.width, 0);
  } finally {
    session.destroy();
  }
  assert.equal(h.pending(), 0);
});

test('a resize without compositor animation dips before freeing the frozen frame', () => {
  const { h, gl, chain, transition, drawIncoming, canvas } = dissolve({ animate: false });
  transition.begin({ dissolve: true });
  transition.applied();
  drawIncoming();
  assert.equal(transition.beforeResize(() => { canvas.width = 10; }), false);
  assert.equal(transition.phase, 'warp-out');
  assert.equal(canvas.style.opacity, '0');
  assert.equal(canvas.width, 8);
  assert.equal(gl.textures.size, 2);
  h.run(CROSSFADE_MS / 2);
  assert.equal(canvas.width, 10);
  assert.equal(gl.textures.size, 0);
  assert.equal(transition.phase, 'in');
  h.run(CROSSFADE_MS / 2);
  assert.equal(transition.phase, 'idle');
  chain.destroy();
});

test('dissolve over color travel frees its extra target and keeps the regular pass', () => {
  const { h, gl, chain, transition, drawIncoming } = dissolve();
  transition.begin({ dissolve: true });
  transition.applied();
  chain.setColourTravel(0.2);
  gl.finishCompiles();
  drawIncoming();
  assert.equal(gl.textures.size, 3, 'scene target, translated source, and frozen outgoing frame');
  for (let frame = 0; frame < 35 && transition.busy; frame += 1) {
    h.run(1000 / 30);
    drawIncoming();
  }
  assert.equal(transition.busy, false);
  assert.equal(gl.textures.size, 1, 'only the regular color pass target remains');
  const before = chain.stats.draws;
  drawIncoming();
  assert.equal(chain.stats.draws - before, 1);
  chain.destroy();
});

test('dissolve cleans up on pause or cancellation and skips when disabled', () => {
  for (const keepFade of [true, false]) {
    const { h, gl, chain, transition, drawIncoming, counts } = dissolve();
    transition.begin({ dissolve: true });
    transition.applied();
    drawIncoming();
    h.run(200);
    transition.finishNow({ keepFade });
    assert.equal(gl.textures.size, 0);
    assert.equal(transition.phase, keepFade ? 'fading' : 'idle');
    h.run(CROSSFADE_MS);
    assert.equal(transition.busy, false);
    assert.equal(counts().redraws, Number(keepFade));
    chain.destroy();
  }
  const { gl, chain, transition, counts } = dissolve({ enabled: false });
  transition.begin({ dissolve: true });
  transition.applied();
  assert.equal(counts().copied, 0);
  assert.equal(gl.textures.size, 0);
  assert.equal(transition.phase, 'idle');
  assert.deepEqual(transition.dissolveStats.skipReasons, { 'not-moving-or-visible': 1 });
  transition.finishNow();
  chain.destroy();
});

test('the shipped DIFS shader reads limited envelopes and preserves the raymarch loop', async () => {
  const scene = sceneById('difs_tunnel_flight');
  assert.equal(scene.name, 'DIFS Tunnel Flight');
  assert.equal(scene.maxSpeed, 1);
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl, mode: 'webgl2' });
  const def = renderer.register(await scene.load(), scene.id);
  assert.match(def.shader, /u_audio\.x/);
  assert.match(def.shader, /max\(u_beat\.x, u_beat\.y\)/);
  assert.match(def.shader, /vec3 wall = tunnelWall\(uv, u_time, ring\)/);
  assert.match(def.shader, /col = mix\(col, wall, fogAmount\)/);
  assert.match(def.shader, /col = psyGamma\(psyTonemap\(col\)\)/);
  assert.match(def.shader, /i < 156/);
  assert.match(def.shader, /84\.0 \+ u_detail \* 26\.0/);
  assert.match(def.shader, /if \(total > 10\.0\) break/);
  assert.match(def.shader, /smoothstep\(CAM_CLEAR, 0\.16, hitT\)/);
  assert.doesNotMatch(def.shader, /u_beat\.w/);
  renderer.destroy();
});

const clamp = (x) => Math.max(0, Math.min(1, x));
const mix = (a, b, t) => a * (1 - t) + b * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const luma = ([r, g, b]) => 255 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
const tone = (x) => clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14)) ** (1 / 2.2);

// The missed-ray path: the projected wall is both the surface colour and
// the fog destination. The Koch look's escaped rays dominate its canvas.
function wallPixel(u, v, t, { flight_speed, color_speed }, bass, hit) {
  const x = u - Math.sin(t * 0.34) * 0.085;
  const y = v - Math.cos(t * 0.26) * 0.085;
  const radius = Math.max(Math.hypot(x, y), 0.025);
  const depth = 0.82 / radius;
  const angle = Math.atan2(y, x + 0.00001);
  const ribs = 0.5 + 0.5 * Math.cos(angle * 8 + depth * 0.34);
  const bands = 0.5 + 0.5 * Math.cos(depth * 7 + t * flight_speed * 2.3);
  const near = smoothstep(0.09, 0.33, radius);
  const ring = smoothstep(0.52, 0.96, bands) * near;
  const wall = 0.62 + 0.38 * ribs * near + 0.75 * ring;
  const exit = 1 - smoothstep(0.03, 0.26, radius);
  const hue = 0.5 - 0.5 * Math.cos(t * 0.3141593 * (color_speed / 0.72));
  const cool = [0.020, 0.079, 0.125];
  const warm = [0.157, 0.043, 0.075];
  const exitTint = [0.135, 0.15, 0.16];
  const glow = 0.045 * clamp(bass) * (0.25 + 0.75 * ring) + 0.035 * clamp(hit) * ring;
  const rgb = cool.map((channel, i) => mix(tone(1.25 * (mix(channel, warm[i], hue) * wall + exitTint[i] * exit)), 1, glow));
  return { rgb, radius, ring };
}

test('the DIFS flight wall stays bright and structured through a warm and cool cycle', () => {
  const { defaults } = sceneById('difs_tunnel_flight');
  const means = [];
  for (const time of [0, 5, 10, 15, 20]) {
    let total = 0, red = 0, blue = 0, exit = 0, exitPixels = 0, strongestBass = 0, strongestHit = 0;
    const width = 64, height = 36;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5 - width / 2) / height;
        const v = (y + 0.5 - height / 2) / height;
        const { rgb, radius } = wallPixel(u, v, time, defaults, 0.25, 0.07);
        const level = luma(rgb);
        total += level;
        red += rgb[0];
        blue += rgb[2];
        if (radius < 0.10) {
          exit += level;
          exitPixels += 1;
        }
        const quiet = luma(wallPixel(u, v, time, defaults, 0, 0).rgb);
        const bass = luma(wallPixel(u, v, time, defaults, 1, 0).rgb) - quiet;
        const hit = luma(wallPixel(u, v, time, defaults, 0, 1).rgb) - quiet;
        strongestBass = Math.max(strongestBass, bass);
        strongestHit = Math.max(strongestHit, hit);
        assert.ok(bass + hit < 0.08 * 255, 'sound alone cannot make a full flash');
      }
    }
    const mean = total / (width * height);
    means.push(mean);
    assert.ok(exit / exitPixels > mean + 35, `the vanishing point is lit at ${time}s`);
    assert.ok(strongestBass > 5 && strongestHit > 4, 'both envelopes visibly lift the rings');
    if (time === 0) assert.ok(blue > red * 1.5, 'starts cool');
    if (time === 10) assert.ok(red > blue * 1.2, 'passes through a warm hue');
  }
  assert.ok(means.every((mean) => mean >= 80 && mean <= 110), `0–255 frame means: ${means.map(Math.round).join(', ')}`);
  // Away from the pale exit, changing radius crosses bright and dark rings.
  const rings = Array.from({ length: 30 }, (_, i) => wallPixel(0.4 + i * 0.01, 0.085, 0, defaults, 0, 0).ring);
  assert.ok(Math.min(...rings) < 0.05 && Math.max(...rings) > 0.95);
});

