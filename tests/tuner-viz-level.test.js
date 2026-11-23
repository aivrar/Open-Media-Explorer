import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSettings, saveSettings, getState, STORAGE_KEYS } from '../src/lib/state.js';
import {
  TUNER_BACKGROUND_DEFAULT_LEVEL, TUNER_BACKGROUND_LEVEL_MAX, TUNER_BACKGROUND_OPACITY, normalizeTunerBackgroundLevel,
  tunerBackgroundLevelPatch, tunerBackgroundOpacity, tunerBackgroundShownLevel,
} from '../src/lib/tuner-background.js';
import { attachTunerBackground } from '../src/modes/tuner-background.js';
import { bindVolumeStepper } from '../src/lib/volume-stepper.js';
import { sceneCost } from '../src/visualizer/scenes.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the level is the layer\'s opacity in percent: 8 is exactly today\'s 0.08, 100 no dimming, 0 nothing', () => {
  assert.equal(TUNER_BACKGROUND_DEFAULT_LEVEL, 8);
  assert.equal(TUNER_BACKGROUND_LEVEL_MAX, 100);
  assert.equal(tunerBackgroundOpacity(TUNER_BACKGROUND_DEFAULT_LEVEL), TUNER_BACKGROUND_OPACITY);
  assert.equal(tunerBackgroundOpacity(100), 1);
  assert.equal(tunerBackgroundOpacity(0), 0);
  assert.equal(tunerBackgroundOpacity(50), 0.5);
  assert.equal(tunerBackgroundOpacity(140), 1);
  assert.equal(tunerBackgroundOpacity(-3), 0);
  // Smooth: every step up shows a little more, by the same amount.
  for (let level = 1; level <= 100; level += 1) {
    const step = tunerBackgroundOpacity(level) - tunerBackgroundOpacity(level - 1);
    assert.ok(Math.abs(step - 0.01) < 1e-12, `level ${level}`);
  }
});

test('the saved level: a whole number from 1 to 100, the default for anything else', () => {
  for (const [given, kept] of [
    [undefined, 8], [null, 8], [0, 8], [-5, 8], ['x', 8], [Number.NaN, 8],
    [1, 1], [55.4, 55], ['30', 30], [100, 100], [140, 100],
    // Only a number or plain digits: anything else Number() could convert is not a level.
    [true, 8], [false, 8], [[100], 8], [{}, 8], ['', 8], ['50', 50], [' 50 ', 50], ['5e1', 8], ['0x20', 8], ['-3', 8],
    [50.4, 50], [-3, 8], [101, 100], [Infinity, 8],
  ]) {
    assert.equal(normalizeTunerBackgroundLevel(given), kept, String(given));
  }
});

test('settings: new users and users from before the level keep their switch and get the default level', () => {
  const fresh = normalizeSettings({});
  assert.equal(fresh.tunerVisualizerBackground, false);
  assert.equal(fresh.tunerVisualizerLevel, 8);
  const wasOn = normalizeSettings({ tunerVisualizerBackground: true });
  assert.equal(wasOn.tunerVisualizerBackground, true);
  assert.equal(wasOn.tunerVisualizerLevel, 8);
  assert.equal(tunerBackgroundShownLevel(wasOn), 8, 'the same look as before');
  const wasOff = normalizeSettings({ tunerVisualizerBackground: false, tunerVisualizerLevel: 40 });
  assert.equal(tunerBackgroundShownLevel(wasOff), 0);
  assert.equal(wasOff.tunerVisualizerLevel, 40, 'kept while off');
  assert.equal(normalizeSettings({ tunerVisualizerLevel: 0 }).tunerVisualizerLevel, 8);
});

test('the stepper and the switch: 0 is off, up from 0 is on at 1, a level while on only changes the level', () => {
  const on = (level) => ({ tunerVisualizerBackground: true, tunerVisualizerLevel: level });
  const off = (level) => ({ tunerVisualizerBackground: false, tunerVisualizerLevel: level });
  assert.equal(tunerBackgroundShownLevel(on(30)), 30);
  assert.equal(tunerBackgroundShownLevel(off(30)), 0);
  assert.equal(tunerBackgroundShownLevel({}), 0);
  assert.deepEqual(tunerBackgroundLevelPatch(on(8), 9), { tunerVisualizerLevel: 9 });
  assert.deepEqual(tunerBackgroundLevelPatch(on(8), 7), { tunerVisualizerLevel: 7 });
  assert.deepEqual(tunerBackgroundLevelPatch(on(1), 0), { tunerVisualizerBackground: false, tunerVisualizerLevel: 8 });
  assert.deepEqual(tunerBackgroundLevelPatch(off(30), 1), { tunerVisualizerBackground: true, tunerVisualizerLevel: 1 });
  assert.deepEqual(tunerBackgroundLevelPatch(on(99), 120), { tunerVisualizerLevel: 100 });
  assert.equal(tunerBackgroundLevelPatch(on(30), 30), null);
  assert.equal(tunerBackgroundLevelPatch(off(30), 0), null);
  assert.equal(tunerBackgroundLevelPatch(off(30), -4), null);
});

test('saved where the switch is saved: inside the one settings key, no new key of its own', () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  try {
    saveSettings(tunerBackgroundLevelPatch(getState().settings, 1));
    saveSettings(tunerBackgroundLevelPatch(getState().settings, 35));
    assert.deepEqual([...values.keys()], [STORAGE_KEYS.settings]);
    const saved = JSON.parse(values.get(STORAGE_KEYS.settings));
    assert.equal(saved.tunerVisualizerBackground, true);
    assert.equal(saved.tunerVisualizerLevel, 35);
    // Off in Settings: the stepper shows 0; on again: the 35 comes back.
    saveSettings({ tunerVisualizerBackground: false });
    assert.equal(tunerBackgroundShownLevel(getState().settings), 0);
    assert.equal(JSON.parse(values.get(STORAGE_KEYS.settings)).tunerVisualizerLevel, 35);
    saveSettings({ tunerVisualizerBackground: true });
    assert.equal(tunerBackgroundShownLevel(getState().settings), 35);
  } finally {
    saveSettings({ tunerVisualizerBackground: false, tunerVisualizerLevel: 8 });
    globalThis.localStorage = previous;
  }
});

/** The background's controller with a stepper driving the settings, as the
 *  Tuner wires them (modes/tuner.js buildVizLevel). */
function rig({ settings = {}, isPlaying = true } = {}) {
  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  };
  const app = {
    state: {
      mode: 'tuner', isPlaying,
      settings: normalizeSettings({ tunerVisualizerBackground: true, visualizerNoticeSeen: true, ...settings }),
    },
    mounts: [],
    saves: 0,
  };
  app.save = (patch) => {
    app.saves += 1;
    app.state.settings = normalizeSettings({ ...app.state.settings, ...patch });
    for (const fn of [...(listeners.get('settings-change') || [])]) fn(app.state.settings);
  };
  const makeEl = (tag) => {
    const node = {
      tag, children: [], parent: null, attrs: {}, style: {}, className: '',
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      append(...nodes) { for (const n of nodes) { n.parent = node; node.children.push(n); } },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node); node.parent = null; },
    };
    return node;
  };
  app.root = makeEl('div');
  app.detach = attachTunerBackground(app.root, {
    released: true,
    state: () => app.state,
    on,
    signal: () => 'the signal',
    doc: { createElement: makeEl },
    load: async () => ({
      mountVisualizer(host) {
        const mount = { host, destroyed: 0, destroy() { mount.destroyed += 1; } };
        app.mounts.push(mount);
        return mount;
      },
      sceneCost,
    }),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  app.layer = () => app.root.children.find((n) => n.className === 'tuner-viz-bg') || null;
  app.live = () => app.mounts.filter((m) => m.destroyed === 0).length;
  // The stepper, with a clock of its own.
  const timers = new Map();
  let id = 0;
  let now = 0;
  app.clock = {
    setTimeout(fn, ms) { id += 1; timers.set(id, { fn, at: now + ms, every: 0 }); return id; },
    setInterval(fn, ms) { id += 1; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearTimeout(handle) { timers.delete(handle); },
    clearInterval(handle) { timers.delete(handle); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let key = null;
        let task = null;
        for (const [k, t] of timers) if (t.at <= end && (!task || t.at < task.at)) { key = k; task = t; }
        if (!task) break;
        now = task.at;
        if (task.every) task.at += task.every; else timers.delete(key);
        task.fn();
      }
      now = end;
    },
  };
  app.group = new EventTarget();
  app.down = new EventTarget();
  app.up = new EventTarget();
  app.unbind = bindVolumeStepper({
    group: app.group, down: app.down, up: app.up, win: new EventTarget(), timers: app.clock,
    getVolume: () => tunerBackgroundShownLevel(app.state.settings),
    setVolume: (level) => { const patch = tunerBackgroundLevelPatch(app.state.settings, level); if (patch) app.save(patch); },
  });
  app.press = (button, type = 'pointerdown') => button.dispatchEvent(Object.assign(new Event(type), { button: 0 }));
  return app;
}

test('a level only changes the layer\'s opacity; the Visualizer in it is not started again', async () => {
  const app = rig();
  await settle();
  assert.equal(app.mounts.length, 1);
  assert.equal(app.layer().style.opacity, '0.08', 'the default: today\'s look');
  app.up.dispatchEvent(new Event('click'));
  assert.equal(app.layer().style.opacity, '0.09');
  app.press(app.up);
  app.clock.advance(400 + 50 * 89);
  app.press(app.up, 'pointerup');
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 100);
  assert.equal(app.layer().style.opacity, '1', 'no dimming at all');
  await settle();
  assert.equal(app.mounts.length, 1, 'one mount the whole way up');
  assert.equal(app.mounts[0].destroyed, 0);
  app.unbind();
  app.detach();
});

test('held down through 0 and back up: it stops once at 0 and starts once from 0, no more', async () => {
  const app = rig({ settings: { tunerVisualizerLevel: 5 } });
  await settle();
  assert.equal(app.live(), 1);
  // Held down: 4, 3, 2, 1, 0, then the hold ends by itself at 0.
  app.press(app.down);
  app.clock.advance(400 + 50 * 20);
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 0);
  assert.equal(app.state.settings.tunerVisualizerBackground, false, 'the Settings switch is off');
  assert.equal(app.mounts[0].destroyed, 1, 'stopped once');
  assert.equal(app.layer(), null, 'nothing left: no layer, no mount');
  const savesAtZero = app.saves;
  app.clock.advance(1000);
  assert.equal(app.saves, savesAtZero, 'the hold ended at 0');
  app.press(app.down, 'pointerup');
  // Up from 0: on at 1, one new mount, then more levels on the same mount.
  app.press(app.up);
  assert.equal(app.state.settings.tunerVisualizerBackground, true);
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 1);
  app.clock.advance(400 + 50 * 9);
  app.press(app.up, 'pointerup');
  await settle();
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 11);
  assert.equal(app.mounts.length, 2, 'started once');
  assert.equal(app.live(), 1);
  assert.equal(app.layer().style.opacity, '0.11');
  app.unbind();
  app.detach();
});

test('the Settings switch and the stepper keep in step: off shows 0, on brings the level back', async () => {
  const app = rig({ settings: { tunerVisualizerLevel: 40 } });
  await settle();
  assert.equal(app.layer().style.opacity, '0.4');
  // The Settings switch off: the stepper reads 0, nothing drawn.
  app.save({ tunerVisualizerBackground: false });
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 0);
  assert.equal(app.layer(), null);
  // On again in Settings: 40, as it was.
  app.save({ tunerVisualizerBackground: true });
  await settle();
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 40);
  assert.equal(app.layer().style.opacity, '0.4');
  // Turned down to 0 on the Tuner (Page Down four times): off; Settings
  // on again comes back at the default, not at the 1 passed on the way.
  for (let i = 0; i < 4; i += 1) app.group.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'PageDown' }));
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 0);
  assert.equal(app.state.settings.tunerVisualizerBackground, false);
  app.save({ tunerVisualizerBackground: true });
  await settle();
  assert.equal(tunerBackgroundShownLevel(app.state.settings), 8);
  assert.equal(app.layer().style.opacity, '0.08');
  app.unbind();
  app.detach();
});

test('without the notice accepted or without sound, a level above 0 turns the setting on but draws nothing', async () => {
  const app = rig({ settings: { tunerVisualizerBackground: false, visualizerNoticeSeen: false } });
  app.up.dispatchEvent(new Event('click'));
  await settle();
  assert.equal(app.state.settings.tunerVisualizerBackground, true);
  assert.equal(app.mounts.length, 0, 'the same gate as the Settings switch: the notice first');
  assert.equal(app.layer(), null);
  app.unbind();
  app.detach();
  const quiet = rig({ isPlaying: false });
  await settle();
  assert.equal(quiet.mounts.length, 0);
  quiet.unbind();
  quiet.detach();
});

test('the Tuner shows the stepper in its bar, and the Settings switch follows it while Settings is open', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /if \(TUNER_BACKGROUND_RELEASED\) filter\.appendChild\(buildVizLevel\(\)\);/);
  assert.match(tuner, /className: 'volume-stepper is-row',\s+attrs: \{ role: 'group', 'aria-label': 'Visualizer behind the Tuner' \},\s+\}, down, readout, up\);/);
  assert.match(tuner, /el\('output', \{ className: 'volume-led', attrs: \{ 'aria-live': 'polite' \} \}\)/);
  assert.match(tuner, /getVolume: \(\) => tunerBackgroundShownLevel\(getState\(\)\.settings\),/);
  // A click on the label or the number keeps the keys with the stepper: the
  // whole of it can take focus and listens for keys and the wheel (without
  // that, the click focused the Tuner and the arrows changed the station).
  assert.match(tuner, /const wrap = el\('div', \{ className: 'tuner-viz-level', attrs: \{ tabindex: '-1' \} \},/);
  assert.match(tuner, /subs\.push\(bindVolumeStepper\(\{\s+group: wrap, down, up,/);
  // Bound once per Tuner shell, and the shell is built only by renderTuner.
  assert.equal(tuner.match(/bindVolumeStepper\(/g).length, 1);
  assert.equal(tuner.match(/[^ ]buildVizLevel\(\)/g).length, 1, 'called once, from buildShell');
  assert.equal(tuner.match(/= buildShell\(\)/g).length, 1);
  assert.match(tuner, /const patch = tunerBackgroundLevelPatch\(getState\(\)\.settings, level\);\s+if \(patch\) saveSettings\(patch\);/);
  // Kept in step with Settings, and its keys are its own (not the dial's).
  assert.match(tuner, /if \(getState\(\)\.mode !== 'tuner'\) return;\n\s+syncVizLevel\(settings\);/);
  assert.match(tuner, /if \(ui\.vizLevel\?\.contains\?\.\(e\.target\)\) return;\n\s+if \(e\.key === 'ArrowRight'/);
  const settings = await read('src/lib/settings.js');
  assert.match(settings, /unsubscribeTunerVisualizer = subscribe\('settings-change', \(settings\) => \{\n\s+tunerVisualizerToggle\.checked = settings\.tunerVisualizerBackground === true;/);
  assert.match(settings, /function close\(\) \{[\s\S]*?unsubscribeTunerVisualizer\?\.\(\);[\s\S]*?\n {2}\}/);
  // A row of the same stepper, 24 px tall.
  const css = await read('src/styles/base.css');
  assert.match(css, /\.volume-stepper\.is-row \{\s+flex-direction: row;\s+height: 24px;/);
  // The player bar's own row rules on the stacked bar do not reach it.
  assert.doesNotMatch(css, /\n {2}\.volume-stepper \{ flex-direction: row-reverse/);
});
