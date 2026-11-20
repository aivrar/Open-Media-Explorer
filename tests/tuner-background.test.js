import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeSettings } from '../src/lib/state.js';
import {
  TUNER_BACKGROUND_FPS_MAX, TUNER_BACKGROUND_OPACITY, TUNER_BACKGROUND_QUALITY, TUNER_BACKGROUND_RELEASED,
  TUNER_BACKGROUND_STOP_GRACE_MS, tunerBackgroundSettings, tunerBackgroundWanted,
} from '../src/lib/tuner-background.js';
import { claimVisualizer, visualizerHolder } from '../src/lib/visualizer-slot.js';
import { attachTunerBackground } from '../src/modes/tuner-background.js';

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
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
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

test('held: not offered, nothing made, not even a listener', () => {
  assert.equal(TUNER_BACKGROUND_RELEASED, false);
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, { ...app.options, released: false });
  assert.equal(app.count(), 0);
  assert.equal(app.root.children.length, 0);
  assert.equal(app.loads, 0);
  detach();
  // The Settings row is only written when released.
  const settings = read('src/lib/settings.js');
  assert.match(settings, /\$\{TUNER_BACKGROUND_RELEASED \? `<div class="row">[\s\S]*data-field="tunerVisualizerBackground"[\s\S]*?` : ''\}/);
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

test('the narrowed settings: Low, 30 fps at most, no overlays, no effects, nothing extra shown; the rest as chosen', () => {
  const user = {
    visualizerQuality: 'high', visualizerQualityPicked: true, visualizerFps: 60, visualizerOverlays: true, visualizerFx: true,
    visualizerPanelOpen: true, visualizerShowFps: true, visualizerDebug: true, visualizerScene: 'aurora', visualizerBrightness: 70,
    visualizerShuffle: true, processorUse: 'balanced',
  };
  const narrowed = tunerBackgroundSettings(user);
  assert.equal(TUNER_BACKGROUND_QUALITY, 'low');
  assert.equal(TUNER_BACKGROUND_FPS_MAX, 30);
  assert.deepEqual(narrowed, {
    ...user, visualizerQuality: 'low', visualizerQualityPicked: false, visualizerFps: 30, visualizerOverlays: false, visualizerFx: false,
    visualizerPanelOpen: false, visualizerShowFps: false, visualizerDebug: false,
  });
  assert.equal(tunerBackgroundSettings({ visualizerFps: 15 }).visualizerFps, 15);
  assert.equal(tunerBackgroundSettings({}).visualizerFps, 30);
  assert.equal(user.visualizerFx, true, 'the user\'s own settings are not changed');
});

test('on: one layer behind the Tuner, the tab\'s Visualizer mounted in it with the narrowed settings and nothing saved', async () => {
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
  assert.equal(mount.options.getSettings().visualizerFps, 30);
  assert.equal(mount.options.getSettings().visualizerOverlays, false);
  assert.doesNotThrow(() => mount.options.saveSettings({ visualizerScene: 'x' }));
  assert.equal(app.state.settings.visualizerScene, undefined, 'nothing saved back');
  // Settings reach it narrowed.
  let seen = null;
  const unsubscribe = mount.options.subscribeSettings((s) => { seen = s; });
  app.settings({ visualizerFx: true });
  assert.equal(seen.visualizerFx, false);
  unsubscribe(); // the mount's own destroy does this
  assert.equal(visualizerHolder(), 'tuner');
  detach();
  assert.equal(mount.destroyed, 1);
  assert.equal(layerOf(app.root), null);
  assert.equal(app.root.classList.contains('has-viz-bg'), false);
  assert.equal(visualizerHolder(), null);
  assert.equal(app.count(), 0, 'every listener gone');
});

test('off, or the notice not accepted, or no sound: no layer and nothing loaded', async () => {
  for (const setup of [
    { settings: { tunerVisualizerBackground: false } },
    { settings: { visualizerNoticeSeen: false } },
    { isPlaying: false },
  ]) {
    const app = fakeApp(setup);
    const detach = attachTunerBackground(app.root, app.options);
    await settle();
    assert.equal(app.root.children.length, 0, JSON.stringify(setup));
    assert.equal(app.loads, 0);
    detach();
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
  app.set({ mode: 'visualizer' });
  app.emit('mode-change', 'visualizer');
  assert.equal(app.mounts[1].destroyed, 1);
  detach();
});

test('left before the Visualizer finished loading: nothing is mounted', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  detach();
  await settle();
  assert.equal(app.mounts.length, 0);
  assert.equal(visualizerHolder(), null);
});

test('one Visualizer in the app: the tab claiming the slot takes the background away first', async () => {
  const app = fakeApp();
  const detach = attachTunerBackground(app.root, app.options);
  await settle();
  const order = [];
  const tabRelease = claimVisualizer('tab', () => order.push('tab released'));
  assert.equal(app.mounts[0].destroyed, 1, 'destroyed before the tab mounts');
  assert.equal(visualizerHolder(), 'tab');
  tabRelease();
  assert.equal(visualizerHolder(), null);
  assert.deepEqual(order, []);
  detach();
});

test('the slot: another owner releases the one before; the same owner does not; letting go clears only its own claim', () => {
  const released = [];
  const a = claimVisualizer('a', () => released.push('a'));
  const a2 = claimVisualizer('a', () => released.push('a2'));
  assert.deepEqual(released, []);
  const b = claimVisualizer('b', () => released.push('b'));
  assert.deepEqual(released, ['a2']);
  a();
  assert.equal(visualizerHolder(), 'b', 'an old claim letting go changes nothing');
  a2();
  b();
  assert.equal(visualizerHolder(), null);
});

test('the Tuner gets only the layer; the tab claims the slot; the mount takes no keys behind the Tuner', () => {
  const tuner = read('src/modes/tuner.js');
  assert.equal(tuner.match(/attachTunerBackground\(/g).length, 1);
  assert.match(tuner, /host\.appendChild\(root\);\r?\n[^\n]*\r?\n  subs\.push\(attachTunerBackground\(root\)\);/);
  const tab = read('src/modes/visualizer.js');
  assert.match(tab, /unclaim = claimVisualizer\('tab', tearDown\);\r?\n    session = mountVisualizer\(/);
  const index = read('src/visualizer/index.js');
  assert.match(index, /if \(!background\) listen\(doc, 'keydown'/);
});

test('the dim: the stylesheet uses the designed opacity, and every theme\'s text keeps 4.5:1 over the worst picture', () => {
  const tunerCss = read('src/styles/tuner.css');
  const rule = tunerCss.match(/\.tuner-viz-bg \{([^}]*)\}/)[1];
  assert.match(rule, new RegExp(`opacity: ${TUNER_BACKGROUND_OPACITY};`));
  assert.match(rule, /z-index: -1;/);
  assert.match(rule, /pointer-events: none;/);
  assert.match(tunerCss, /\.tuner-root\.has-viz-bg \{\s*position: relative;\s*isolation: isolate;\s*\}/);
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
