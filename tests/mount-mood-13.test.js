import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { claimVisualizer, visualizerHolder } from '../src/lib/visualizer-slot.js';
import { attachTunerBackground } from '../src/modes/tuner-background.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { MOOD_HOLD_S, createMoodTracker } from '../src/visualizer/mood.js';
import { BLOCKING_COMPILE_DELAY_MS, createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { createToneTracker } from '../src/visualizer/tone.js';
import { createStructureDetector } from '../src/visualizer/structure.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

function playingSource() {
  return {
    playing: false,
    audible: true,
    key: 'station-1',
    node: fakeAnalyser({ level: 230 }),
    isPlaying() { return this.playing; },
    isAudible() { return this.audible; },
    getAnalyser() { return this.playing ? this.node : null; },
    getSourceKey() { return this.key; },
    release() {},
  };
}

/** A mount with everything it touches counted. `fail` names a step that
 *  throws: a function (options) => options changed. */
function harness() {
  const h = createClockHarness();
  const vis = fakeDocWithElements();
  const motion = fakeMotion(false);
  const win = fakeResizeObserverWin(motion);
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  const settingsListeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true });
  const root = new FakeNodeEl('div');
  let contexts = 0;
  let made = 0;
  const realCreate = vis.doc.createElement;
  const m = {
    h, vis, motion, win, source, signal, gl, settingsListeners, root, failAtElement: 0,
    get contexts() { return contexts; },
    get made() { return made; },
  };
  vis.doc.createElement = (tag) => {
    made += 1;
    if (m.failAtElement && made >= m.failAtElement) throw new Error('panel build failed');
    return realCreate(tag);
  };
  m.options = {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); for (const fn of settingsListeners) fn(current); },
    subscribeSettings: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => { contexts += 1; return { gl, mode: 'webgl2' }; },
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
  };
  return m;
}

async function untilScene(m, session) {
  for (let round = 0; round < 10 && !session.switcher.current; round += 1) {
    await settle(() => Boolean(session.switcher.current), 40);
    if (!session.switcher.current) m.h.run(BLOCKING_COMPILE_DELAY_MS);
  }
  assert.ok(session.switcher.current, 'the scene is shown');
}

/** Nothing left of a mount: no listener, timer, frame, sound subscription,
 *  observer or GL object, and the context given back once if it was made. */
function assertNothingLeft(m, label) {
  assert.equal(m.vis.count(), 0, `${label}: no document listeners`);
  assert.equal(m.motion.listeners.size, 0, `${label}: no reduced-motion listener`);
  assert.equal(m.settingsListeners.size, 0, `${label}: no settings subscription`);
  assert.equal(m.signal.subscriberCount, 0, `${label}: no sound subscription`);
  for (const observer of m.win.observers) assert.equal(observer.disconnected, true, `${label}: observer disconnected`);
  assert.equal(m.h.pending(), 0, `${label}: not a timer or an animation frame`);
  assert.equal(m.gl.programs.size, 0, `${label}: no program`);
  assert.equal(m.gl.buffers.size, 0, `${label}: no buffer`);
  assert.equal(m.gl.textures.size, 0, `${label}: no texture`);
  assert.equal(m.gl.framebuffers.size, 0, `${label}: no framebuffer`);
  assert.equal(m.gl.loseCount, m.contexts ? 1 : 0, `${label}: the context given back`);
  assert.equal(m.root.children.length, 0, `${label}: the root emptied`);
  assert.equal(m.root.classList.contains('viz-root'), false, `${label}: no visualizer class left`);
}

/* ---- A mount that throws part-way leaves nothing behind ---- */

test('a mount that throws just after the renderer is made gives everything back, and a second mount works', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = harness();
  let renderers = 0;
  const failing = {
    ...m.options,
    createRenderer: (options) => {
      const renderer = createSceneRenderer(options);
      renderers += 1;
      renderer.setAudioReactor = () => { throw new Error('reactor failed'); };
      return renderer;
    },
  };
  m.source.playing = true;
  assert.throws(() => mountVisualizer(m.root, failing), /reactor failed/);
  assert.equal(renderers, 1);
  m.signal.refresh();
  m.h.run(2000);
  await settle(() => false, 20);
  assertNothingLeft(m, 'after the renderer');
  // The same root, the same signal: a working mount.
  const again = harness();
  const session = mountVisualizer(m.root, { ...m.options, createContext: again.options.createContext, loopOptions: m.h.io });
  await untilScene(m, session);
  assert.equal(m.root.classList.contains('viz-root'), true);
  session.destroy();
  m.source.playing = false;
  m.signal.refresh();
  assert.equal(m.h.pending(), 0);
  assert.equal(again.gl.loseCount, 1);
});

test('a mount that throws once the first scene is loading abandons it, stops the loop and gives the context back', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = harness();
  let loads = 0;
  // The first scene is on its way when the settings subscription (the last
  // thing the mount does) throws.
  const failing = {
    ...m.options,
    scenes: undefined,
    subscribeSettings: () => { throw new Error('subscription failed'); },
  };
  const realLoad = m.options.createContext;
  failing.createContext = (canvas) => { loads += 1; return realLoad(canvas); };
  m.source.playing = true;
  m.signal.refresh();
  assert.throws(() => mountVisualizer(m.root, failing), /subscription failed/);
  assert.equal(loads, 1);
  // The scene's chunk arriving later installs nothing.
  for (let round = 0; round < 6; round += 1) {
    await settle(() => false, 20);
    m.h.run(BLOCKING_COMPILE_DELAY_MS);
  }
  assertNothingLeft(m, 'with a scene loading');
  assert.equal(m.gl.draws, 0, 'nothing drawn');
});

test('a mount that throws at any point of building its panel leaves nothing behind', async (t) => {
  t.mock.method(console, 'error', () => {});
  // How many elements a whole mount makes.
  const whole = harness();
  const session = mountVisualizer(whole.root, whole.options);
  const total = whole.made;
  session.destroy();
  assert.ok(total > 40, `a whole mount makes many elements (${total})`);
  const points = new Set([1, 2, 3, 5, 8, Math.floor(total / 4), Math.floor(total / 2), Math.floor((3 * total) / 4), total - 1, total]);
  for (const at of points) {
    const m = harness();
    m.failAtElement = at;
    m.source.playing = true;
    m.signal.refresh();
    assert.throws(() => mountVisualizer(m.root, m.options), /panel build failed/, `element ${at}`);
    m.failAtElement = 0;
    m.h.run(1000);
    await settle(() => false, 10);
    assertNothingLeft(m, `element ${at} of ${total}`);
  }
});

/* ---- The one-Visualizer slot after a failed mount ---- */

test('a tab mount that throws frees the slot: the Tuner background can claim it, and the other way round', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNodeEl(tag) };
  try {
    const shell = await import('../src/modes/visualizer.js');
    const state = await import('../src/lib/state.js');
    shell.setVisualizerLoaderForTests(async () => ({
      mountVisualizer: () => { throw new Error('mount failed'); },
    }));
    const host = new FakeNodeEl('main');
    state.setMode('visualizer');
    shell.renderVisualizer(host);
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(shell.visualizerMounted(), false);
    assert.equal(visualizerHolder(), null, 'the failed tab does not keep the slot');
    assert.match(host.children[0].innerHTML, /could not be loaded/);
    // The Tuner's background claims it, and keeps it.
    let released = 0;
    const unclaim = claimVisualizer('tuner', () => { released += 1; });
    assert.equal(visualizerHolder(), 'tuner');
    state.setMode('tuner');
    assert.equal(visualizerHolder(), 'tuner', 'leaving the failed tab does not take the Tuner\'s claim');
    assert.equal(released, 0);
    unclaim();
    assert.equal(visualizerHolder(), null);

    // The other way round: the Tuner background's mount throws; the tab then
    // mounts and holds the slot.
    const app = { listeners: new Map() };
    const appState = {
      mode: 'tuner', isPlaying: true,
      settings: { tunerVisualizerBackground: true, visualizerNoticeSeen: true },
    };
    const tunerRoot = new FakeNodeEl('div');
    tunerRoot.remove = () => {};
    let tunerMounts = 0;
    const detach = attachTunerBackground(tunerRoot, {
      released: true,
      state: () => appState,
      on: (event, fn) => {
        if (!app.listeners.has(event)) app.listeners.set(event, new Set());
        app.listeners.get(event).add(fn);
        return () => app.listeners.get(event).delete(fn);
      },
      signal: () => null,
      doc: { createElement: (tag) => Object.assign(new FakeNodeEl(tag), { remove() {} }) },
      load: async () => ({ mountVisualizer: () => { tunerMounts += 1; throw new Error('mount failed'); } }),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(tunerMounts, 1);
    assert.equal(visualizerHolder(), null, 'the failed background does not keep the slot');
    let mounts = 0;
    shell.setVisualizerLoaderForTests(async () => ({
      mountVisualizer: () => { mounts += 1; return { destroy() {} }; },
    }));
    state.setMode('visualizer');
    shell.renderVisualizer(new FakeNodeEl('main'));
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(mounts, 1);
    assert.equal(visualizerHolder(), 'tab');
    state.setMode('library');
    assert.equal(visualizerHolder(), null);
    detach();
    shell.setVisualizerLoaderForTests(null);
  } finally {
    globalThis.document = previousDocument;
  }
});

/* ---- The music's readings start afresh ---- */

test('the mood tracker\'s reset arms every channel again, so the first hit after it counts', () => {
  const steps = (tracker, from) => {
    // A kick every quarter second for a second, the first at the start.
    for (let index = 0; index <= 20; index += 1) {
      const kick = index % 5 === 0 ? 1 : 0;
      tracker.step(from + index * 0.05, { kick, snare: 0, hat: 0, level: 0.5, confidence: 0, bpm: 0 });
    }
  };
  const fresh = createMoodTracker();
  steps(fresh, 100);
  const reset = createMoodTracker();
  // Before the reset: the kick held high (its channel not armed).
  for (let index = 0; index < 10; index += 1) reset.step(index * 0.1, { kick: 1, snare: 0, hat: 0, level: 0.5 });
  reset.reset();
  assert.equal(reset.ready, false, 'not ready after a reset');
  assert.equal(reset.mood, 'steady');
  assert.equal(reset.energy, 0);
  steps(reset, 100);
  assert.equal(reset.energy, fresh.energy, 'the same reading as a fresh tracker: the first kick counted');
  assert.ok(fresh.energy > 0);
  // Ready once it has heard MOOD_HOLD_S of sound again.
  for (let at = 101; at <= 100 + MOOD_HOLD_S + 0.5; at += 0.1) reset.step(at, { level: 0.5 });
  assert.equal(reset.ready, true);
});

test('tone and structure start afresh on reset', () => {
  const tone = createToneTracker();
  const db = new Float32Array(1024).fill(-30);
  tone.step(1, { active: true, spectrumDb: db, sampleRate: 48000, fftSize: 2048 });
  assert.equal(tone.tone.ready, true);
  tone.reset();
  assert.equal(tone.tone.ready, false);
  assert.equal(tone.tone.swell, 0);
  const structure = createStructureDetector();
  for (let beat = 0; beat < 24; beat += 0.25) structure.step(beat, -20 + beat);
  assert.equal(structure.building, true);
  structure.reset();
  assert.equal(structure.building, false);
  assert.equal(structure.armed, false);
});

async function playingMount() {
  const m = harness();
  const session = mountVisualizer(m.root, m.options);
  await untilScene(m, session);
  m.source.playing = true;
  m.signal.refresh();
  m.h.run(MOOD_HOLD_S * 1000 + 1500);
  assert.equal(session.started, true);
  assert.equal(session.mood.ready, true, 'a reading of its own');
  return { m, session };
}

test('a station or item change starts the mood afresh; a scene change does not', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { m, session } = await playingMount();
  const resets = session.musicStats.resets;
  // Another scene: the music is the same.
  const before = session.switcher.current;
  session.controls.next.dispatchEvent(new Event('click'));
  for (let round = 0; round < 10 && session.switcher.current === before; round += 1) {
    await settle(() => session.switcher.current !== before, 40);
    m.h.run(BLOCKING_COMPILE_DELAY_MS);
  }
  assert.notEqual(session.switcher.current, before, 'the scene changed');
  m.h.run(500);
  assert.equal(session.musicStats.resets, resets, 'no reset on a scene change');
  assert.equal(session.mood.ready, true);
  // Another station (the signal's source key): afresh.
  m.source.key = 'station-2';
  m.h.run(100);
  assert.equal(session.musicStats.resets, resets + 1, 'reset on another station');
  assert.equal(session.mood.ready, false);
  m.h.run(MOOD_HOLD_S * 1000 + 500);
  assert.equal(session.mood.ready, true, 'a new reading after the hold');
  assert.equal(session.musicStats.resets, resets + 1, 'once');
  session.destroy();
});

test('a resume after a pause, or after the window was hidden, starts the mood afresh', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { m, session } = await playingMount();
  let resets = session.musicStats.resets;
  // Paused and resumed.
  m.source.playing = false;
  m.signal.refresh();
  m.h.run(2000);
  m.source.playing = true;
  m.signal.refresh();
  m.h.run(100);
  assert.ok(session.musicStats.resets > resets, 'reset on resume after a pause');
  assert.equal(session.mood.ready, false, 'old hits do not count');
  m.h.run(MOOD_HOLD_S * 1000 + 500);
  assert.equal(session.mood.ready, true);
  // Hidden and shown again.
  resets = session.musicStats.resets;
  m.vis.setVisible(false);
  m.h.run(2000);
  m.vis.setVisible(true);
  m.h.run(100);
  assert.ok(session.musicStats.resets > resets, 'reset when the window is shown again');
  assert.equal(session.mood.ready, false);
  session.destroy();
});

test('after a reset the mood line keeps its last word until the new reading is ready', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { m, session } = await playingMount();
  const line = session.controls.moodLine;
  // Stand in for a reading: energetic, ready.
  const reading = { mood: 'energetic', ready: true };
  Object.defineProperty(session.mood, 'mood', { get: () => reading.mood });
  Object.defineProperty(session.mood, 'ready', { get: () => reading.ready });
  m.h.run(100);
  assert.equal(line.textContent, 'Music: energetic');
  // Afresh: the tracker starts at steady but has no reading yet.
  reading.mood = 'steady';
  reading.ready = false;
  m.h.run(1000);
  assert.equal(line.textContent, 'Music: energetic', 'no flash to the starting word');
  reading.ready = true;
  m.h.run(100);
  assert.equal(line.textContent, 'Music: steady', 'the new reading once ready');
  session.destroy();
});
