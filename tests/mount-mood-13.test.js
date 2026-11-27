import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { visualizerHolder } from '../src/lib/visualizer-slot.js';
import { attachTunerBackground } from '../src/modes/tuner-background.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { MOOD_GAP_S, MOOD_HOLD_S, createMoodTracker } from '../src/visualizer/mood.js';
import { BLOCKING_COMPILE_DELAY_MS, createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { createToneTracker } from '../src/visualizer/tone.js';
import { createStructureDetector } from '../src/visualizer/structure.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import { beatTrack, listen, padTrack } from './helpers/mood-sim.js';
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

/* ---- The shared Visualizer after a failed mount ---- */

test('failed tab and Tuner mounts release the shared Visualizer', async (t) => {
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
    state.setMode('tuner');
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

test('the mood tracker\'s reset forgets the levels it heard, so the first onset after it counts', () => {
  // Each run its own copy of the beat (the beat's noise has a state).
  const beat = () => beatTrack({ bpm: 120, hats: 2 });
  const fresh = createMoodTracker();
  listen(fresh, beat(), 4, { from: 100 });
  const reset = createMoodTracker();
  // Before the reset: a loud held chord (its levels would make the beat's
  // first strokes rise from somewhere else).
  listen(reset, padTrack(), 4, { gain: 8 });
  const word = reset.mood;
  reset.reset();
  assert.equal(reset.ready, false, 'not ready after a reset');
  assert.equal(reset.mood, word, 'the word stays until the new reading');
  assert.equal(reset.energy, 0);
  listen(reset, beat(), 4, { from: 100 });
  assert.equal(reset.energy, fresh.energy, 'the same reading as a fresh tracker');
  assert.equal(reset.reading.onset, fresh.reading.onset);
  assert.ok(fresh.energy > 0);
  // Ready once it has heard MOOD_HOLD_S of sound again.
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

test('sound back after a gap of a few seconds starts the mood afresh and the other readings with it; a short gap does not', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { m, session } = await playingMount();
  const node = m.source.node;
  const sounding = node.getFloatTimeDomainData;
  const quiet = (ms) => {
    node.getFloatTimeDomainData = (data) => data.fill(0);
    m.h.run(ms);
    node.getFloatTimeDomainData = sounding;
  };
  const resets = session.musicStats.resets;
  const restarts = session.mood.stats.restarts;
  // Half a second of silence: nothing starts afresh.
  quiet(500);
  m.h.run(500);
  assert.equal(session.mood.stats.restarts, restarts);
  assert.equal(session.musicStats.resets, resets);
  assert.equal(session.mood.ready, true);
  // Three seconds (longer than MOOD_GAP_S): afresh once the sound is back.
  assert.ok(MOOD_GAP_S < 3);
  const word = session.mood.mood;
  quiet(3000);
  assert.equal(session.mood.stats.restarts, restarts, 'not while it is quiet');
  m.h.run(100);
  assert.equal(session.mood.stats.restarts, restarts + 1);
  assert.equal(session.musicStats.resets, resets + 1, 'the other readings too');
  assert.equal(session.mood.ready, false);
  assert.equal(session.mood.mood, word, 'the word stays');
  m.h.run(MOOD_HOLD_S * 1000 + 500);
  assert.equal(session.mood.ready, true);
  session.destroy();
});

test('the mood line shows the tracker\'s own word, the one the shuffle and the strength use, ready or not', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { m, session } = await playingMount();
  const line = session.controls.moodLine;
  // Stand in for the tracker: energetic, ready.
  const reading = { mood: 'energetic', ready: true };
  Object.defineProperty(session.mood, 'mood', { get: () => reading.mood });
  Object.defineProperty(session.mood, 'ready', { get: () => reading.ready });
  m.h.run(100);
  assert.equal(line.textContent, 'Music: energetic');
  // After a fresh start the tracker keeps its word until its new reading
  // (visualizer-mood-measure.test.js); the line holds no word of its own,
  // so it can never show another word than the shuffle and the strength.
  reading.ready = false;
  m.h.run(1000);
  assert.equal(line.textContent, 'Music: energetic');
  reading.mood = 'calm';
  m.h.run(100);
  assert.equal(line.textContent, 'Music: calm');
  session.destroy();
  const viz = readFileSync('src/visualizer/index.js', 'utf8');
  assert.match(viz, /const name = started \? mood\.mood : '';/);
  assert.match(viz, /poolContext\.mood = mood\.mood;/);
  assert.match(viz, /bridge\.setStrength\(mood\.strength\);/);
});
