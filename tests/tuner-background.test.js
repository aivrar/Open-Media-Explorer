import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  TUNER_BACKGROUND_FPS_MAX, TUNER_BACKGROUND_OPACITY, TUNER_BACKGROUND_RELEASED,
  TUNER_BACKGROUND_STOP_GRACE_MS, TUNER_BACKGROUND_TEXT, tunerBackgroundWanted,
} from '../src/lib/tuner-background.js';
import { visualizerHolder } from '../src/lib/visualizer-slot.js';
import { attachTunerBackground } from '../src/modes/tuner-background.js';
import { renderVisualizer } from '../src/modes/visualizer.js';
import { createDensityRenderer, liveDensityWorkers } from '../src/visualizer/density-host.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { sceneById } from '../src/visualizer/scenes.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle as settleUntil,
} from './helpers/visualizer-fakes.js';
import { SimGL } from './helpers/sim-fakes.js';

const read = (path) => readFileSync(path, 'utf8');

/* ---- A small DOM and app for the controller ---- */
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.className = '';
    const names = new Set();
    this.names = names;
    this.classList = {
      add: (n) => names.add(n),
      remove: (n) => names.delete(n),
      contains: (n) => names.has(n),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.parent = null; }
}

function fakeApp({ settings = {}, isPlaying = true, mode = 'tuner' } = {}) {
  const listeners = new Map();
  const app = {
    state: { settings: { tunerVisualizerBackground: true, visualizerNoticeSeen: true, visualizerFps: 60, ...settings }, isPlaying, mode },
    timers: [],
    mounts: [],
    loads: 0,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    emit(event, payload) { for (const fn of [...(listeners.get(event) || [])]) fn(payload); },
    count() { let n = 0; for (const set of listeners.values()) n += set.size; return n; },
    set(partial) { Object.assign(app.state, partial); },
    settings(partial) { app.state.settings = { ...app.state.settings, ...partial }; app.emit('settings-change', app.state.settings); },
  };
  app.root = new FakeEl('div');
  app.options = {
    released: true,
    state: () => app.state,
    on: app.on,
    save: app.settings,
    signal: () => 'the signal',
    doc: { createElement: (tag) => new FakeEl(tag) },
    load: async () => {
      app.loads += 1;
      return {
        mountVisualizer(host, options) {
          const mount = { host, options, destroyed: 0, destroy() { mount.destroyed += 1; } };
          app.mounts.push(mount);
          return mount;
        },
      };
    },
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; app.timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  };
  app.fire = () => { const live = app.timers.filter((t) => !t.cleared && !t.fired); for (const t of live) { t.fired = true; t.fn(); } };
  return app;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const layerOf = (root) => root.children.find((n) => n.className === 'tuner-viz-bg') || null;

test('released: offered in Settings (one plain sentence), off by default; held, nothing made, not even a listener', () => {
  assert.equal(TUNER_BACKGROUND_RELEASED, true);
  const settings = read('src/lib/settings.js');
  assert.match(settings, /\$\{TUNER_BACKGROUND_RELEASED \? `<div class="row">[\s\S]*data-field="tunerVisualizerBackground"[\s\S]*?` : ''\}/);
  assert.equal(TUNER_BACKGROUND_TEXT.description.split(/[.!?](\s|$)/).filter((part) => part && part.trim()).length, 1, 'one sentence');
  assert.ok(TUNER_BACKGROUND_TEXT.description.endsWith('.'));
  assert.doesNotMatch(`${TUNER_BACKGROUND_TEXT.label} ${TUNER_BACKGROUND_TEXT.description}`, /colour|behaviour|centre|grey/i, 'American spelling');
  assert.equal(normalizeSettings({}).tunerVisualizerBackground, false);
  // Held (as before release): nothing at all.
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, { ...app.options, released: false });
  assert.equal(app.count(), 0);
  assert.equal(app.root.children.length, 0);
  assert.equal(app.loads, 0);
  detach();
});

test('the Tuner loads nothing of the Visualizer until it is wanted: no static import reaches src/visualizer', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = read(file);
    // Static imports only (import ... from '...', import '...'); import() is dynamic.
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'|(?:^|\n)\s*import\s+'(\.[^']+)'/g)) {
      const spec = match[1] || match[2];
      if (!spec.endsWith('.js')) continue;
      walk(join(dirname(file), spec).replace(/\\/g, '/'));
    }
  };
  walk('src/modes/tuner.js');
  assert.ok(seen.has('src/modes/tuner-background.js'));
  assert.ok(seen.has('src/lib/tuner-background.js'));
  assert.deepEqual([...seen].filter((file) => file.startsWith('src/visualizer/')), []);
  // The one way in: the dynamic import, made only when the background starts.
  const controller = read('src/modes/visualizer.js');
  assert.equal(controller.match(/import\('\.\.\/visualizer\/visualizer\.js'\)/g).length, 1);
});

test('the setting: off by default, kept only when true', () => {
  assert.equal(normalizeSettings({}).tunerVisualizerBackground, false);
  assert.equal(normalizeSettings({ tunerVisualizerBackground: true }).tunerVisualizerBackground, true);
  assert.equal(normalizeSettings({ tunerVisualizerBackground: 1 }).tunerVisualizerBackground, false);
});

test('wanted only with the setting on, the notice accepted and sound playing', () => {
  const on = { settings: { tunerVisualizerBackground: true, visualizerNoticeSeen: true }, isPlaying: true };
  assert.equal(tunerBackgroundWanted(on), true);
  assert.equal(tunerBackgroundWanted({ ...on, isPlaying: false }), false);
  assert.equal(tunerBackgroundWanted({ ...on, settings: { ...on.settings, visualizerNoticeSeen: false } }), false);
  assert.equal(tunerBackgroundWanted({ ...on, settings: { ...on.settings, tunerVisualizerBackground: false } }), false);
  assert.equal(tunerBackgroundWanted(null), false);
});

test('on: one layer behind the Tuner, the tab\'s Visualizer mounted in it with the shared settings', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  const layer = layerOf(app.root);
  assert.ok(layer, 'the layer');
  assert.equal(layer.attrs['aria-hidden'], 'true');
  assert.equal(layer.inert, true);
  assert.equal(app.root.classList.contains('has-viz-bg'), true);
  assert.equal(app.root.children.at(-1), layer, 'after the Tuner\'s own content');
  await settle();
  assert.equal(app.mounts.length, 1);
  const [mount] = app.mounts;
  assert.equal(mount.options.background, true);
  assert.equal(mount.options.signal, 'the signal');
  assert.equal(mount.options.getSettings(), app.state.settings);
  mount.options.saveSettings({ visualizerScene: 'voronoi' });
  assert.equal(app.state.settings.visualizerScene, 'voronoi');
  let seen = null;
  const unsubscribe = mount.options.subscribeSettings((s) => { seen = s; });
  app.settings({ visualizerFx: true, tabsShown: { visualizer: false } });
  assert.equal(mount.destroyed, 0, 'hiding the Visualizer tab leaves the background running');
  assert.equal(seen.visualizerFx, true);
  unsubscribe(); // the mount's own destroy does this
  assert.equal(visualizerHolder(), 'tuner');
  detach();
  assert.equal(mount.destroyed, 1);
  assert.equal(layerOf(app.root), null);
  assert.equal(app.root.classList.contains('has-viz-bg'), false);
  assert.equal(visualizerHolder(), null);
  assert.equal(app.count(), 0, 'every listener gone');
});

test('the Tuner can start its background with the Visualizer tab hidden', async () => {
  const app = fakeApp({ settings: { tabsShown: { visualizer: false } } });
  const detach = attachTunerBackground(app.root, app.options);
  try {
    await settle();
    assert.equal(app.mounts.length, 1);
    assert.equal(visualizerHolder(), 'tuner');
  } finally {
    detach();
  }
});

test('off, or the notice not accepted, or no sound: no layer and nothing loaded', async () => {
  for (const setup of [
    { settings: { tunerVisualizerBackground: false } },
    { settings: { visualizerNoticeSeen: false } },
    { isPlaying: false },
  ]) {
    const app = fakeApp(setup);
    let made = 0;
    const detach = attachTunerBackground(app.root, {
      ...app.options, doc: { createElement: (tag) => { made += 1; return new FakeEl(tag); } },
    });
    await settle();
    assert.equal(app.root.children.length, 0, JSON.stringify(setup));
    assert.equal(app.loads, 0);
    assert.equal(made, 0, 'no element made');
    assert.equal(app.timers.length, 0, 'no timer');
    assert.equal(app.root.classList.contains('has-viz-bg'), false);
    // Only its own state listeners (settings, playing, item, mode), which
    // start nothing while it is not wanted.
    assert.equal(app.count(), 4);
    app.emit('mode-change', 'grid');
    app.emit('playing-change', true);
    await settle();
    assert.equal(app.loads, 0);
    detach();
    assert.equal(app.count(), 0);
  }
});

test('the sound stops: taken away after the wait, unless it plays again first', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  await settle();
  // A change of station: stops and plays again within the wait.
  app.set({ isPlaying: false });
  app.emit('playing-change', false);
  assert.equal(app.timers.at(-1).ms, TUNER_BACKGROUND_STOP_GRACE_MS);
  app.set({ isPlaying: true });
  app.emit('playing-change', true);
  app.fire();
  assert.equal(app.mounts[0].destroyed, 0);
  assert.ok(layerOf(app.root));
  // Stopped for good.
  app.set({ isPlaying: false });
  app.emit('playing-change', false);
  assert.equal(app.mounts[0].destroyed, 0, 'not at once');
  app.fire();
  assert.equal(app.mounts[0].destroyed, 1);
  assert.equal(layerOf(app.root), null);
  // Plays again: made again.
  app.set({ isPlaying: true });
  app.emit('playing-change', true);
  await settle();
  assert.equal(app.mounts.length, 2);
  detach();
});

test('the setting turned off, or another tab: taken away at once', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  await settle();
  app.settings({ tunerVisualizerBackground: false });
  assert.equal(app.mounts[0].destroyed, 1);
  assert.equal(layerOf(app.root), null);
  app.settings({ tunerVisualizerBackground: true });
  await settle();
  assert.equal(app.mounts.length, 2);
  app.set({ mode: 'library' });
  app.emit('mode-change', 'library');
  assert.equal(app.mounts[1].destroyed, 1);
  assert.equal(app.count(), 0, 'another tab: the controller detached itself');
  detach();
});

test('a visit, leaving, another visit: one import per visit that wants it, no listener left after leaving, nothing on the old root', async () => {
  const app = fakeApp();
  const rootA = app.root;
  const detachA = attachTunerBackground(rootA, app.options);
  await settle();
  assert.equal(app.loads, 1);
  assert.equal(app.count(), 4);
  // Left (main.js: the mode first, then the next tab is drawn).
  app.set({ mode: 'grid' });
  app.emit('mode-change', 'grid');
  assert.equal(app.mounts[0].destroyed, 1);
  assert.equal(app.count(), 0, 'no listener after leaving');
  assert.equal(layerOf(rootA), null);
  // Away: changes reach nothing.
  app.settings({ visualizerFps: 15 });
  app.emit('playing-change', true);
  // Back: the mode first, then the Tuner drawn anew (its tearDown, a new root).
  app.set({ mode: 'tuner' });
  app.emit('mode-change', 'tuner');
  await settle();
  assert.equal(app.loads, 1, 'nothing loaded for the old controller');
  assert.equal(layerOf(rootA), null, 'no layer on the old root');
  assert.equal(rootA.classList.contains('has-viz-bg'), false);
  detachA();
  const rootB = new FakeEl('div');
  const detachB = attachTunerBackground(rootB, app.options);
  await settle();
  assert.equal(app.loads, 2, 'one import for this visit');
  assert.equal(app.mounts.length, 2);
  assert.ok(layerOf(rootB));
  assert.equal(app.count(), 4);
  // A visit that does not want it (no sound): no import.
  app.set({ mode: 'grid' });
  app.emit('mode-change', 'grid');
  assert.equal(app.count(), 0);
  app.set({ mode: 'tuner', isPlaying: false });
  app.emit('mode-change', 'tuner');
  detachB();
  const detachC = attachTunerBackground(new FakeEl('div'), app.options);
  await settle();
  assert.equal(app.loads, 2);
  assert.equal(app.count(), 4);
  detachC();
  assert.equal(app.count(), 0);
});

test('left before the Visualizer finished loading: nothing is mounted', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  detach();
  await settle();
  assert.equal(app.mounts.length, 0);
  assert.equal(visualizerHolder(), null);
});

test('for TV, a pending tab import follows the picture to the Tuner without a second load', async () => {
  const app = fakeApp({ mode: 'visualizer' });
  app.set({ currentItem: { type: 'tv' } });
  renderVisualizer(new FakeEl('main'), app.options);
  app.set({ mode: 'tuner' });
  app.emit('mode-change', 'tuner');
  const detach = attachTunerBackground(app.root, app.options);
  await settle();
  assert.equal(app.loads, 1);
  assert.equal(app.mounts.length, 1);
  assert.equal(app.mounts[0].options.background, true);
  assert.equal(layerOf(app.root).children[0], app.mounts[0].host);
  detach();
  assert.equal(app.count(), 0);
});

test('an unclaimed handoff releases the mount at the end of the turn', async () => {
  const app = fakeApp();
  attachTunerBackground(app.root, app.options);
  await settle();
  app.set({ mode: 'visualizer' });
  app.emit('mode-change', 'visualizer');
  assert.equal(layerOf(app.root), null);
  await settle();
  assert.equal(app.mounts[0].destroyed, 1);
  assert.equal(app.count(), 0);
  assert.equal(visualizerHolder(), null);
});

test('the Tuner attaches one backdrop controller, and Visualizer keys are scoped to the tab', () => {
  const tuner = read('src/modes/tuner.js');
  assert.equal(tuner.match(/attachTunerBackground\(/g).length, 1);
  const index = read('src/visualizer/index.js');
  assert.match(index, /if \(background \|\| !isDebugKey\(event\)\) return;/);
});

test('known speech still removes the backdrop immediately during playback', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  for (const item of [
    { type: 'radio', tags: ['talk radio'] },
    { type: 'radio', tags: ['speech'] },
    { type: 'audio', tags: ['podcast'] },
    { type: 'audio', source: 'librivox' },
  ]) {
    await settle();
    const mount = app.mounts.at(-1);
    assert.ok(layerOf(app.root));
    app.set({ currentItem: item });
    app.emit('current-item', item);
    assert.equal(layerOf(app.root), null);
    assert.equal(mount.destroyed, 1);
    assert.equal(app.timers.length, 0);
    app.set({ currentItem: { type: 'radio', tags: ['jazz'] } });
    app.emit('current-item', app.state.currentItem);
  }
  detach();
});

test('TV and video qualify even with speech tags and keep the same backdrop as radio', async () => {
  const app = fakeApp();
  app.set({ currentItem: { type: 'tv', tags: ['talk radio'] } });
  assert.equal(tunerBackgroundWanted(app.state), true);
  const detach = attachTunerBackground(app.root, app.options);
  await settle();
  const layer = layerOf(app.root);
  assert.ok(layer);
  assert.equal(app.mounts.length, 1);
  for (const currentItem of [
    { type: 'video', tags: ['speech'], source: 'librivox' },
    { type: 'radio', tags: ['jazz'] },
  ]) {
    app.set({ currentItem });
    app.emit('current-item', currentItem);
    assert.equal(tunerBackgroundWanted(app.state), true);
    assert.equal(layerOf(app.root), layer);
    assert.equal(app.mounts[0].destroyed, 0);
  }
  assert.equal(app.loads, 1);
  detach();
});

test('the dim: the stylesheet uses the designed opacity, and every theme\'s text keeps 4.5:1 over the worst picture', () => {
  assert.equal(TUNER_BACKGROUND_OPACITY, 0.08);
  const tunerCss = read('src/styles/tuner.css');
  const rule = tunerCss.match(/\.tuner-viz-bg \{([^}]*)\}/)[1];
  assert.match(rule, new RegExp(`opacity: ${TUNER_BACKGROUND_OPACITY};`));
  assert.match(rule, /position: absolute;\s*inset: 0;/);
  assert.match(rule, /z-index: -1;/);
  assert.match(rule, /pointer-events: none;/);
  assert.match(tunerCss, /\.tuner-root\.has-viz-bg \{\s*position: relative;\s*isolation: isolate;\s*\}/);
  assert.match(tunerCss, /\.tuner-root\.has-viz-bg > \.tuner-controls \{ background: var\(--bg-elev-1\);/);
  assert.match(tunerCss, /\.tuner-tone-label,\s*\.tuner-empty \{[^}]*-webkit-text-stroke: 2px var\(--bg\);[^}]*paint-order: stroke fill;/);
  assert.doesNotMatch(tunerCss, /\.tuner-(?:stage|station-list|tone-label|tone-letter|empty)[^{]*\{[^}]*background:/);
  const videoDock = read('src/styles/base.css').match(/\.video-dock \{([^}]*)\}/)[1];
  assert.match(videoDock, /position: absolute;/);
  assert.match(videoDock, /z-index: 20;/);
  assert.match(read('src/index.html'), /id="view-host"[\s\S]*?<\/main>[\s\S]*?id="video-dock"/);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const base = read('src/styles/base.css');
  const themes = [...base.matchAll(/(:root[^{]*)\{([^}]*)\}/g)]
    .map(([, sel, body]) => [sel.trim(), Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))])
    .filter(([, v]) => v.bg && v['text-mute']);
  assert.ok(themes.length >= 6, 'every theme read');
  for (const [sel, v] of themes) {
    const worst = lum(hex(v.bg)) > 0.5 ? [0, 0, 0] : [1, 1, 1];
    for (const text of ['text', 'text-dim', 'text-mute']) {
      for (const back of ['bg', 'bg-elev-1']) {
        const under = hex(v[back]).map((c, i) => c * (1 - TUNER_BACKGROUND_OPACITY) + worst[i] * TUNER_BACKGROUND_OPACITY);
        const r = ratio(hex(v[text]), under);
        assert.ok(r >= 4.5, `${sel} ${text} on ${back}: ${r.toFixed(2)}`);
      }
    }
  }
});

/* ---- The real Visualizer behind the Tuner (no GPU, no real worker) ---- */

/** A fake element the controller can take out again (remove) and the
 *  Visualizer can mount into. */
class BgEl extends FakeNodeEl {
  constructor(tag) {
    super(tag);
    this.parent = null;
    this.inert = false;
  }

  append(...nodes) {
    for (const node of nodes) { node.remove?.(); node.parent = this; }
    super.append(...nodes);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
}

/** A density picture with its worker alive, as a density lab drawn behind
 *  the Tuner has one (the host keeps one worker for the whole app). */
function liveDensityWorker() {
  const workers = [];
  const canvas = { width: 640, height: 360 };
  const gl = new SimGL({ canvas });
  const Renderer = {
    getCanvas: () => canvas, bindFramebuffer() {}, getViewZoom: () => 1, getFrameStep: () => 1 / 60,
  };
  const factory = createDensityRenderer({ Renderer, sceneQuality: () => 'low' }, {
    startWorker: () => {
      const worker = {
        terminated: false, onmessage: null, onerror: null, postMessage() {}, terminate() { this.terminated = true; },
      };
      workers.push(worker);
      return worker;
    },
    now: () => 16,
  });
  const instance = factory.create({ name: 'behind the Tuner' });
  instance.render(gl, 0.016, {
    densityType: 'buddhabrot', resetKey: 'a', tonemapKey: 'a', params: { mode: 0 },
    tonemap: { exposure: 2, gamma: 0.82, gain: 1.15, glow: 1.1, curve: 0.86, palette: 1, colorPhase: 0 },
    batchSize: 16000, resolutionScale: 0.5, maxSide: 1280,
  });
  assert.equal(liveDensityWorkers(), 1, 'a worker running');
  return { workers, instance, gl };
}

/** The controller with the real mountVisualizer: the tab's own Visualizer
 *  on a fake clock, document, window and WebGL context. */
function realRig() {
  const h = createClockHarness();
  const vis = fakeDocWithElements();
  vis.doc.createElement = (tag) => Object.assign(new BgEl(tag), { rect: { width: 1280, height: 720 } });
  const motion = fakeMotion(false);
  const win = fakeResizeObserverWin(motion);
  const node = fakeAnalyser({ level: 230 });
  const source = {
    playing: true, isPlaying() { return this.playing; }, isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; }, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  // Each mount's canvas gets a context of its own, as a real canvas does.
  const contexts = [];
  const app = fakeApp();
  app.state.settings = normalizeSettings({ tunerVisualizerBackground: true, visualizerNoticeSeen: true, visualizerFps: 60 });
  app.root = new BgEl('div');
  const sessions = [];
  app.options.doc = { createElement: (tag) => new BgEl(tag) };
  app.options.signal = () => signal;
  app.options.load = async () => {
    app.loads += 1;
    return { mountVisualizer: (host, options) => { const session = mountVisualizer(host, options); sessions.push(session); return session; } };
  };
  app.options.mountOptions = {
    win, doc: vis.doc, createContext: () => { const gl = new FakeGL(); contexts.push(gl); return { gl, mode: 'webgl2' }; },
    loopOptions: h.io, flashLedger: createFlashLedger(),
  };
  return {
    h, vis, motion, win, source, signal, app, sessions,
    /** The newest mount's context. */
    get gl() { return contexts.at(-1); },
    /** WebGL contexts given back, over all mounts. */
    lost: () => contexts.reduce((n, gl) => n + gl.loseCount, 0),
  };
}

/** The next mount (the one after `before` mounts), once its scene is shown. */
async function shownScene(r, before = 0) {
  const current = () => r.sessions.length > before && Boolean(r.sessions.at(-1).switcher.current);
  for (let round = 0; round < 400 && !current(); round += 1) {
    await settleUntil(current, 20);
    r.h.run(COMPILE_POLL_MS);
  }
  assert.ok(current(), 'a scene drawn behind the Tuner');
  return r.sessions.at(-1);
}

/** Nothing of `session` is left: its layer, canvas, observers, listeners,
 *  sound subscription, timers, frames and density worker. */
function assertAllGone(r, session, label, appListeners = 4) {
  assert.equal(layerOf(r.app.root), null, `${label}: the layer`);
  assert.equal(r.app.root.classList.contains('has-viz-bg'), false, label);
  assert.equal(session.canvas.listenerCount, 0, `${label}: no canvas listeners`);
  assert.equal(session.canvas.width, 0, `${label}: the canvas emptied`);
  for (const [name, control] of Object.entries(session.controls)) {
    for (const element of [control].flat()) assert.equal(element.listenerCount, 0, `${label}: ${name} has no listeners left`);
  }
  assert.ok(r.win.observers.length > 0 && r.win.observers.every((observer) => observer.disconnected), `${label}: the resize observers`);
  assert.equal(r.signal.subscriberCount, 0, `${label}: no sound subscription`);
  assert.equal(r.motion.listeners.size, 0, `${label}: no motion listener`);
  assert.equal(r.vis.count(), 0, `${label}: no document listeners`);
  assert.equal(session.loop.pending, 0, `${label}: no frame or timer of the loop`);
  assert.equal(liveDensityWorkers(), 0, `${label}: no density worker`);
  assert.equal(visualizerHolder(), null, `${label}: the slot let go`);
  assert.equal(r.app.count(), appListeners, `${label}: only the controller's own state listeners (${appListeners})`);
  // Nothing left to run once the sound stops.
  r.source.playing = false;
  r.signal.refresh();
  assert.equal(r.h.pending(), 0, `${label}: not a single timer or animation frame left`);
}

test('the real Visualizer behind the Tuner for TV: chosen quality at 30 fps, every frame through the flash limiter, no AudioContext', async (t) => {
  t.mock.method(console, 'error', () => {});
  const made = [];
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { made.push('made'); } resume() { made.push('resume'); } };
  try {
    const r = realRig();
    r.app.set({ currentItem: { type: 'tv' } });
    r.app.settings({ visualizerQuality: 'high', visualizerQualityPicked: true });
    const detach = attachTunerBackground(r.app.root, r.app.options);
    const session = await shownScene(r);
    r.win.observers[0].fire(1600, 900);
    assert.deepEqual([session.canvas.width, session.canvas.height], [1600, 900], 'the chosen drawing quality');
    assert.equal(session.loop.targetFps, TUNER_BACKGROUND_FPS_MAX);
    assert.equal(session.stepDown.fps, 60, 'the saved frame rate remains 60');
    // Every frame's sound passes the flash limiter (the tab's own, on the
    // page's one ledger), as in the tab.
    const limiter = session.bridge.limiter;
    const step = limiter.step;
    let steps = 0;
    limiter.step = (...args) => { steps += 1; return step(...args); };
    r.signal.refresh();
    const draws = r.gl.draws;
    r.h.run(1000, 1000 / 30);
    assert.ok(r.gl.draws - draws >= 25, `drawn live (${r.gl.draws - draws} frames)`);
    assert.ok(steps >= r.gl.draws - draws - 1, `${steps} limiter steps for ${r.gl.draws - draws} frames`);
    assert.deepEqual(made, [], 'no AudioContext made or resumed');
    detach();
    assert.equal(r.lost(), 1, 'the WebGL context given back');
    // Detached (the Tuner taken down): not even the controller's listeners.
    assertAllGone(r, session, 'detached', 0);
    assert.deepEqual(made, []);
  } finally {
    if (saved === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved;
  }
});

test('TV without a readable signal draws in the existing idle mode', async () => {
  const r = realRig();
  r.app.set({ currentItem: { type: 'tv' } });
  r.source.getAnalyser = () => null;
  const detach = attachTunerBackground(r.app.root, r.app.options);
  try {
    const session = await shownScene(r);
    assert.equal(session.loop.mode, 'idle');
    const draws = session.loop.stats.idleDraws;
    r.h.run(1000);
    assert.ok(session.loop.stats.idleDraws > draws);
    assert.equal(session.loop.stats.liveDraws, 0);
  } finally {
    detach();
  }
});

test('the real Visualizer behind the Tuner: switching the setting off, or leaving the Tuner, takes everything away at once', async (t) => {
  t.mock.method(console, 'error', () => {});
  const r = realRig();
  const detach = attachTunerBackground(r.app.root, r.app.options);
  const first = await shownScene(r);
  r.win.observers.at(-1).fire(1600, 900);
  r.h.run(500, 1000 / 30);
  const lab = liveDensityWorker();
  // The setting switched off: at once, no wait.
  r.app.settings({ tunerVisualizerBackground: false });
  assert.equal(r.lost(), 1, 'setting off: the WebGL context given back');
  assert.equal(lab.workers[0].terminated, true, 'setting off: the density worker ended');
  assertAllGone(r, first, 'setting off');
  // On again (sound playing), then the Tuner left.
  r.source.playing = true;
  r.signal.refresh();
  r.app.settings({ tunerVisualizerBackground: true });
  const second = await shownScene(r, 1);
  assert.notEqual(second, first);
  r.win.observers.at(-1).fire(1600, 900);
  r.h.run(500, 1000 / 30);
  const lab2 = liveDensityWorker();
  r.app.set({ mode: 'grid' });
  r.app.emit('mode-change', 'grid');
  assert.equal(r.lost(), 2, 'Tuner left: the WebGL context given back');
  assert.equal(lab2.workers[0].terminated, true, 'Tuner left: the density worker ended');
  // Left: the controller detached itself, not even its listeners remain.
  assertAllGone(r, second, 'Tuner left', 0);
  assert.equal(r.app.loads, 2);
  detach();
  assert.equal(r.app.count(), 0);
  lab.instance.cleanup(lab.gl);
  lab2.instance.cleanup(lab2.gl);
});

test('20 Tuner, Visualizer and Library cycles keep the same number of nodes', async () => {
  const { app, sessions, signal, vis } = realRig();
  const tab = new BgEl('main');
  const counts = [];
  const countNodes = () => app.root.descendants().length + tab.descendants().length;
  const enter = (mode) => {
    app.set({ mode });
    app.emit('mode-change', mode);
  };

  for (let cycle = 1; cycle <= 20; cycle += 1) {
    enter('tuner');
    attachTunerBackground(app.root, app.options);
    await settle();
    const session = sessions.at(-1);
    const stage = session.canvas.parent;
    const picture = [session.canvas, session.fade, session.overlayCanvas];
    const holder = session.panel.parent;
    assert.ok(holder);
    assert.equal(holder.parent, null);
    assert.deepEqual(stage.children, picture);
    const inTuner = countNodes() + holder.descendants().length + 1;

    enter('visualizer');
    renderVisualizer(tab, app.options);
    assert.equal(sessions.length, cycle);
    assert.ok(tab.contains(session.panel));
    assert.equal(holder.children.length, 0);
    const inTab = countNodes();

    enter('tuner');
    attachTunerBackground(app.root, app.options);
    assert.deepEqual(stage.children, picture);
    assert.equal(session.panel.parent, holder);
    assert.equal(tab.children.length, 0);

    enter('visualizer');
    renderVisualizer(tab, app.options);
    enter('library');
    await settle();
    assert.equal(sessions.length, cycle);
    assert.equal(countNodes(), 0);
    assert.equal(holder.children.length, 0);
    assert.equal(app.count(), 0);
    assert.equal(vis.count(), 0);
    assert.equal(signal.subscriberCount, 0);
    assert.equal(visualizerHolder(), null);
    counts.push([inTuner, inTab]);
  }

  assert.deepEqual(counts[19], counts[1]);
});

test('the tab and Tuner share a scene pick, look, settings, shuffle clock, and in-progress dissolve', async () => {
  const r = realRig();
  const { app, h } = r;
  app.options.mountOptions.scenes = ['plasma', 'living_sun', 'waves'].map(sceneById);
  app.settings({
    visualizerScene: 'plasma', visualizerQuality: 'high', visualizerQualityPicked: true,
    visualizerBrightness: 70, visualizerColorTravel: true, visualizerFx: true, visualizerOverlays: true,
    visualizerShuffleCost: 'all', visualizerShuffleBars: 32, visualizerShufflePool: 'favourites',
    visualizerFavourites: ['living_sun', 'waves'], visualizerDrift: true,
  });
  function enter(mode) {
    app.set({ mode });
    app.emit('mode-change', mode);
  }
  async function until(done) {
    for (let attempt = 0; attempt < 40 && !done(); attempt += 1) {
      h.run(40);
      await settleUntil(done, 10);
    }
    assert.ok(done(), 'the pending scene operation finished');
  }

  try {
    enter('visualizer');
    const tab = new BgEl('main');
    renderVisualizer(tab, app.options);
    const session = await shownScene(r);
    const root = tab.children[0];
    r.gl.copyTexImage2D = () => {};
    session.controls.sceneButton.dispatchEvent(new Event('click'));
    const choice = root.descendants().find((node) => node.getAttribute('data-scene') === 'living_sun');
    const click = new Event('click');
    Object.defineProperty(click, 'target', { value: choice });
    session.controls.sceneOptions.dispatchEvent(click);
    await until(() => session.switcher.current === 'living_sun' && !session.transition.busy);
    assert.equal(app.state.settings.visualizerScene, 'living_sun');
    session.controls.shuffleButton.dispatchEvent(new Event('click'));
    const timer = session.shuffleTimer;
    await until(() => session.nextPick && session.switcher.staged(session.nextPick));
    const next = session.nextPick;
    const dwell = timer.dwell;
    const clock = session.drift.clock.bars;
    assert.ok(clock > 0);
    assert.equal(timer.bars, 32);
    const settings = app.state.settings;

    enter('tuner');
    attachTunerBackground(app.root, app.options);
    assert.equal(layerOf(app.root).children[0], root);
    assert.equal(tab.children.length, 0, 'the same root moves out of the tab');
    assert.equal(visualizerHolder(), 'tuner');
    assert.equal(session.switcher.current, 'living_sun');
    assert.equal(session.drift.clock.bars, clock);
    assert.equal(timer.dwell, dwell);
    assert.equal(session.nextPick, next);
    assert.equal(session.shuffleCostMax, 'heavy');
    assert.equal(session.fx.on, true);
    assert.equal(session.overlays.on, true);
    assert.equal(session.controls.colorTravel.checked, true);
    assert.equal(session.canvas.style.opacity, '0.7');
    assert.equal(session.hud.active, false);
    assert.equal(session.loop.targetFps, 30);
    assert.equal(app.state.settings, settings);
    app.settings({ tunerVisualizerLevel: 40 });
    assert.deepEqual(app.state.settings, { ...settings, tunerVisualizerLevel: 40 });
    assert.equal(layerOf(app.root).style.opacity, '0.4');
    assert.equal(session.canvas.style.opacity, '0.7', 'strength applies outside the picture');

    timer.step = () => true;
    await until(() => session.switcher.current === next);
    timer.step = () => false;
    assert.equal(session.shuffleStats.changes, 1);
    assert.equal(app.state.settings.visualizerScene, next);
    assert.equal(session.transition.phase, 'warping');

    enter('visualizer');
    renderVisualizer(tab, app.options);
    assert.equal(tab.children[0], root);
    assert.equal(session.switcher.current, next);
    assert.equal(session.transition.phase, 'warping');
    assert.equal(session.loop.targetFps, 60);
    assert.equal(session.hud.active, true);
    h.run(600);
    assert.equal(session.shuffleStats.changes, 1);
    assert.equal(app.loads, 1);
    assert.equal(r.sessions.length, 1);
    assert.equal(r.lost(), 0);
  } finally {
    enter('library');
  }
  assertAllGone(r, r.sessions[0], 'both closed', 0);
});

test('the controller makes no AudioContext and reaches the sound only through the shared signal', () => {
  for (const file of ['src/modes/tuner-background.js', 'src/lib/tuner-background.js', 'src/modes/visualizer.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /AudioContext|\.resume\(|createMediaElementSource|createAnalyser/, file);
  }
  assert.match(read('src/modes/visualizer.js'), /signal = getAudioSignal/);
});
