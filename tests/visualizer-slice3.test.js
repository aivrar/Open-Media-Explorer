import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import {
  VISUALIZER_LOOK_MAX, VISUALIZER_LOOKS_MAX_SCENES, normalizeVisualizerLooks,
} from '../src/lib/visualizer-settings.js';
import { normalizeSettings } from '../src/lib/state.js';
import { LOOP_MODES } from '../src/visualizer/loop.js';
import {
  BLOCKING_COMPILE_DELAY_MS, COMPILE_POLL_MS, createSceneRenderer, sceneDefaults,
} from '../src/visualizer/scene-renderer.js';
import {
  ACCUMULATING_SCENE_ENTRIES, COST_CLASSES, HELD_SCENE_ENTRIES, LINE_SCENE_ENTRIES, OWN_SCENE_ENTRIES, SCENES, drawableScenes, orderedScenes, sceneById,
} from '../src/visualizer/scenes.js';
import { COST_LABELS, filterScenes } from '../src/visualizer/scene-list.js';
import {
  STEP_DOWN_GRACE_MS, STEP_DOWN_MAX_GAP_MS, STEP_DOWN_NOTE, STEP_DOWN_SETTLE_MS, STEP_DOWN_WINDOW_MS, createStepDown, stepDownLevels,
} from '../src/visualizer/step-down.js';
import {
  DEFAULT_LOOK_NAME, currentLook, lookOverrides, sceneLooks, startLook, withLook,
} from '../src/visualizer/looks.js';
import {
  CROSSFADE_SLOW_MS, NOTES, PREPARING_DELAY_MS, mountVisualizer,
} from '../src/visualizer/index.js';
import { createFlashLimiter } from '../src/visualizer/flash-limiter.js';
import {
  ACCUMULATING_FILES, ALL_SCENE_FILES, FLIGHT_FILES, HELPER_FILES, LINE_FILES, SCENE_FILES,
} from '../scripts/import_psychedelia.mjs';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 3 of the visualizer: every other simple Psychedelia scene (each its
   own chunk) with a cost class, the searchable scene list with cost badges,
   the automatic step-down for computers that cannot keep up, "Preparing
   scene...", and the per-scene Look chooser. No GPU; fake clocks. */

const LAYOUT = { width: 1280, height: 720 };

/* ---------------- Which scenes ---------------- */

test('the scene set: one vendored file per scene file, every scene of each in scenes.js (new upstream scene files are found by import_psychedelia.mjs --check-drift)', () => {
  const vendored = readdirSync(join('src', 'visualizer', 'vendor', 'psychedelia', 'effects')).filter((file) => file !== 'registry.js').map((file) => file.replace(/[.]js$/, ''));
  // (The line-drawing scenes, LINE_FILES, and the accumulating labs,
  // ACCUMULATING_FILES, are listed apart: line-scenes.js,
  // accumulating-scenes.js.)
  assert.deepEqual(vendored.sort(), [...ALL_SCENE_FILES, ...LINE_FILES, ...ACCUMULATING_FILES, ...HELPER_FILES].sort());
  assert.deepEqual([...new Set([...SCENES, ...HELD_SCENE_ENTRIES].filter((scene) => !LINE_SCENE_ENTRIES.includes(scene) && !OWN_SCENE_ENTRIES.includes(scene)
    && !ACCUMULATING_SCENE_ENTRIES.includes(scene)).map((scene) => scene.file.replace(/^effects[/]/, '').replace(/[.]js$/, '')))].sort(), [...ALL_SCENE_FILES].sort());
  assert.equal(SCENE_FILES.length, 57);
  // Slice 7: the fifteen 3D flights and the seven endless scenes (two files).
  assert.equal(FLIGHT_FILES.length, 15);
  // Slice 13: the four labs, Robot Foundry and Cymatics; slice 14: the four
  // simulations and two frame-feedback scenes.
  assert.equal(ALL_SCENE_FILES.length, 86);
  assert.equal(SCENES.filter((scene) => scene.category === 'Endless Scenes').length, 8);
  assert.equal(SCENES.filter((scene) => /_flight$/.test(scene.id)).length + HELD_SCENE_ENTRIES.length, 15);
});

test('every scene has a cost class; the counts are as measured', () => {
  const count = Object.fromEntries(COST_CLASSES.map((cost) => [cost, SCENES.filter((scene) => scene.cost === cost).length]));
  // (Seven of them the line-drawing scenes; five World Media's own;
  // Buddhabrot Lab heavy; DIFS Tunnel and Quaternion Julia, back from the
  // held list, heavy.)
  assert.deepEqual(count, { light: 32, medium: 23, heavy: 48 });
  for (const id of ['black_hole', 'nebula', 'endless_terrain', 'mandelbrot_deep', 'orbit_trap', 'seascape', 'gyroid_tunnels', 'liquid_chrome']) {
    assert.equal(sceneById(id).cost, 'heavy', id);
  }
  for (const id of ['plasma', 'tunnel', 'moire', 'rotozoom', 'op_art']) assert.equal(sceneById(id).cost, 'light', id);
});

test('the list order: by category, then by name; search by name, category or cost word', () => {
  const ordered = orderedScenes(SCENES);
  assert.equal(ordered.length, SCENES.length);
  for (let at = 1; at < ordered.length; at += 1) {
    const a = ordered[at - 1];
    const b = ordered[at];
    assert.ok(a.category < b.category || (a.category === b.category && a.name.localeCompare(b.name) <= 0), `${a.id} before ${b.id}`);
  }
  assert.deepEqual(filterScenes(ordered, 'mandel').map((s) => s.id), ['mandelbox_flight', 'mandelbrot', 'mandelbrot_deep', 'mandelbulb_flight', 'mandelbulb_slice']);
  assert.deepEqual(filterScenes(ordered, 'HEAVY').map((s) => s.id), ordered.filter((s) => s.cost === 'heavy').map((s) => s.id));
  assert.deepEqual(filterScenes(ordered, 'cosmic light').map((s) => s.id), ['spiral_galaxy']);
  assert.deepEqual(filterScenes(ordered, '  ').length, ordered.length);
  assert.deepEqual(filterScenes(ordered, 'zzz'), []);
});

/* ---------------- Mounting ---------------- */

function playingSource() {
  const node = fakeAnalyser({ level: 60, db: -60 });
  return {
    node,
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
}

async function mount({ settings = {}, scenes = SCENES, parallel = false } = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const motion = fakeMotion(false);
  const win = fakeResizeObserverWin(motion);
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL({ parallel });
  const saved = [];
  const listeners = new Set();
  // (the photosensitivity notice accepted: its own tests are in visualizer-slice4)
  let current = normalizeSettings({ visualizerNoticeSeen: true, ...settings });
  const root = new FakeNodeEl('div');
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    scenes,
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
  });
  const m = {
    h, vis, gl, saved, root, session, source, signal,
    controls: session.controls,
    get settings() { return current; },
    apply(partial) { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    async until(done, label = 'condition') {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        h.run(COMPILE_POLL_MS);
      }
      assert.fail(`never reached: ${label}`);
    },
    play() { source.playing = true; signal.refresh(); },
  };
  if (parallel) {
    await m.until(() => session.switcher.compiling || Boolean(session.switcher.current), 'compiling');
    gl.finishCompiles();
  }
  await m.until(() => Boolean(session.switcher.current), 'first scene');
  return m;
}

/* ---------------- The scene list ---------------- */

test('the scene list: a button with the name and cost badge opens a searchable, grouped list', async () => {
  const m = await mount();
  const { session, controls, vis } = m;
  const list = session.sceneList;
  // Grouped: one heading per category, in order, each scene with its badge.
  const groups = controls.sceneOptions.children;
  // (The fake context has WebGL 2 but no float targets: the scenes that
  // need them are not listed.)
  const categories = [...new Set(orderedScenes(drawableScenes(SCENES, { webgl2: true, float: false, half: false })).map((s) => s.category))];
  assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), categories);
  const heavy = list.options.get('nebula');
  assert.equal(heavy.getAttribute('role'), 'option');
  assert.equal(heavy.children[1].textContent, COST_LABELS.heavy);
  assert.equal(heavy.children[1].className, 'viz-cost viz-cost-heavy');
  assert.match(controls.sceneButton.getAttribute('aria-label'), /^Scene: Plasma, Light$/);
  // Open: the search field gets the keys.
  assert.equal(list.open, false);
  controls.sceneButton.dispatchEvent(new Event('click'));
  assert.equal(list.open, true);
  assert.equal(controls.sceneButton.getAttribute('aria-expanded'), 'true');
  assert.equal(list.active, 'plasma', 'starts on the scene shown');
  controls.sceneSearch.value = 'neb';
  controls.sceneSearch.dispatchEvent(new Event('input'));
  assert.deepEqual(list.shown, ['nebula']);
  assert.equal(list.options.get('plasma').hidden, true);
  assert.equal(groups.find((group) => group.getAttribute('aria-label') === 'Demoscene').hidden, true, 'an empty group is hidden');
  controls.sceneSearch.value = 'fractals';
  controls.sceneSearch.dispatchEvent(new Event('input'));
  const fractals = list.shown;
  assert.ok(fractals.length >= 15);
  const press = (key) => {
    const event = new Event('keydown');
    event.key = key;
    controls.sceneSearch.dispatchEvent(event);
  };
  press('ArrowDown');
  press('ArrowDown');
  press('ArrowUp');
  assert.equal(list.active, fractals[1]);
  assert.equal(controls.sceneSearch.getAttribute('aria-activedescendant'), `viz-scene-${fractals[1]}`);
  press('Enter');
  assert.equal(list.open, false);
  assert.deepEqual(m.saved.at(-1), { visualizerScene: fractals[1] });
  await m.until(() => session.switcher.current === fractals[1]);
  assert.equal(list.value, fractals[1]);
  // Escape closes without choosing; a click outside closes; a click inside does not.
  controls.sceneButton.dispatchEvent(new Event('click'));
  const escape = new Event('keydown');
  escape.key = 'Escape';
  list.panel.dispatchEvent(escape); // (a key in the search box bubbles to the panel)
  assert.equal(list.open, false);
  const savedBefore = m.saved.length;
  controls.sceneButton.dispatchEvent(new Event('click'));
  const pointer = (target) => { for (const fn of [...(vis.listeners.get('pointerdown') || [])]) fn({ target }); };
  pointer(controls.sceneSearch);
  assert.equal(list.open, true, 'inside the panel');
  pointer(session.canvas);
  assert.equal(list.open, false, 'outside it');
  assert.equal(m.saved.length, savedBefore);
  // Nothing matches: a plain line.
  controls.sceneButton.dispatchEvent(new Event('click'));
  controls.sceneSearch.value = 'no such scene';
  controls.sceneSearch.dispatchEvent(new Event('input'));
  assert.deepEqual(list.shown, []);
  assert.equal(list.panel.children[2].hidden, false);
  press('Enter');
  assert.equal(m.saved.length, savedBefore, 'Enter with nothing shown picks nothing');
  session.destroy();
  assert.equal(vis.count(), 0, 'no document listeners left');
});

/* ---------------- Step-down ---------------- */

test('step-down levels: quality notch by notch, then the frame rate at Low', () => {
  assert.deepEqual(stepDownLevels('high', 60), [
    { quality: 'high', fps: 60 }, { quality: 'medium', fps: 60 }, { quality: 'low', fps: 60 },
    { quality: 'low', fps: 30 }, { quality: 'low', fps: 15 },
  ]);
  assert.deepEqual(stepDownLevels('medium', 30), [{ quality: 'medium', fps: 30 }, { quality: 'low', fps: 30 }, { quality: 'low', fps: 15 }]);
  assert.deepEqual(stepDownLevels('low', 15), [{ quality: 'low', fps: 15 }]);
});

/** Frames every `interval` ms for `ms`, from `start`. */
function feed(stepDown, start, ms, interval) {
  let now = start;
  for (; now < start + ms; now += interval) stepDown.frame(now);
  return now;
}

test('step-down: a few slow seconds take one notch off, it settles, never steps back up, and a choice clears it', () => {
  const steps = [];
  let clock = 0;
  const stepDown = createStepDown({ quality: 'high', fps: 60, onStep: (to) => steps.push({ ...to, at: clock }) });
  const run = (start, ms, interval) => {
    for (clock = start; clock < start + ms; clock += interval) stepDown.frame(clock);
    return clock;
  };
  // 58 frames a second at 60: fine.
  let now = run(0, 10000, 1000 / 58);
  assert.equal(stepDown.lowered, false);
  // 40 a second (under 80 % of 60): one slow window is not enough (a hitch);
  // one notch after two in a row.
  const slowFrom = now;
  now = run(now, STEP_DOWN_WINDOW_MS + 200, 25);
  assert.equal(steps.length, 0, 'one slow window: not yet');
  now = run(now, STEP_DOWN_WINDOW_MS, 25);
  assert.equal(steps.length, 1);
  assert.deepEqual({ quality: steps[0].quality, fps: steps[0].fps }, { quality: 'medium', fps: 60 });
  assert.ok(steps[0].at - slowFrom >= 1000, 'not on a moment: the average of a whole window');
  assert.equal(stepDown.quality, 'medium');
  // Still slow: then Low, then (at Low) 60 -> 30, each after the settle time
  // and a whole window; 40 a second holds 30.
  now = run(now, 30000, 25);
  assert.deepEqual(steps.map(({ quality, fps }) => `${quality}/${fps}`), ['medium/60', 'low/60', 'low/30']);
  for (let at = 1; at < steps.length; at += 1) {
    assert.ok(steps[at].at - steps[at - 1].at >= STEP_DOWN_SETTLE_MS + 2 * STEP_DOWN_WINDOW_MS - 25, 'settle, then two whole windows');
  }
  assert.equal(stepDown.fps, 30);
  // Fast frames again: it never steps back up by itself.
  run(now, 30000, 1000 / 60);
  assert.equal(stepDown.level, 3);
  assert.equal(stepDown.lowered, true);
  // A long gap (minimised window) is not a slow frame.
  const fresh = createStepDown({ quality: 'medium', fps: 30 });
  let t = feed(fresh, 0, 2000, 1000 / 30);
  t += STEP_DOWN_MAX_GAP_MS + 500;
  t = feed(fresh, t, 2000, 1000 / 30);
  assert.equal(fresh.lowered, false);
  // Very slow to the end: it stops at the last notch.
  feed(fresh, t, 60000, 200);
  assert.deepEqual({ quality: fresh.quality, fps: fresh.fps, level: fresh.level }, { quality: 'low', fps: 15, level: 2 });
  // A choice clears it.
  stepDown.choose('high', 60);
  assert.equal(stepDown.lowered, false);
  assert.equal(stepDown.quality, 'high');
  assert.equal(stepDown.fps, 60);
});

test('step-down belongs to the scene: another scene starts at what was chosen; a scene shown again starts at what it needed, saying nothing', () => {
  let fxOn = 2;
  const sd = createStepDown({ quality: 'high', fps: 60, fxInUse: () => fxOn });
  assert.equal(sd.newScene('heavy'), false, 'the first scene: nothing to change');
  // Slow (40 frames a second at 60): until the next notch is taken.
  const slowUntilStep = (from) => {
    const steps = sd.stats.steps;
    let at = from;
    while (sd.stats.steps === steps && at < from + 60000) { at += 25; sd.frame(at); }
    return at;
  };
  // Effects first (two to one, then none), then High to Medium.
  let now = slowUntilStep(0);
  assert.equal(sd.fx, 1);
  assert.equal(sd.stepped, true);
  fxOn = 1;
  now = slowUntilStep(now);
  assert.equal(sd.fx, 0);
  fxOn = 0;
  now = slowUntilStep(now);
  assert.equal(sd.quality, 'medium');
  assert.deepEqual(sd.neededBy('heavy'), { quality: 'medium', fps: 60, fx: 0, overlays: Infinity });
  // Another scene: the chosen quality and all its effects, nothing said.
  assert.equal(sd.newScene('light'), true, 'the quality to draw with changed');
  assert.deepEqual({ quality: sd.quality, fps: sd.fps, fx: sd.fx, lowered: sd.lowered, stepped: sd.stepped }, {
    quality: 'high', fps: 60, fx: Infinity, lowered: false, stepped: false,
  });
  assert.equal(sd.neededBy('light'), null);
  now = feed(sd, now, 20000, 1000 / 60);
  assert.equal(sd.lowered, false, 'it keeps up');
  // Back to the heavy one: where it needed to be, at once; no note again.
  assert.equal(sd.newScene('heavy'), true);
  assert.deepEqual({ quality: sd.quality, fx: sd.fx, lowered: sd.lowered, stepped: sd.stepped }, {
    quality: 'medium', fx: 0, lowered: true, stepped: false,
  });
  const steps = sd.stats.steps;
  feed(sd, now, 20000, 1000 / 60);
  assert.equal(sd.stats.steps, steps, 'holding at that level: no hitching down again');
  // A quality or frame rate chosen by hand forgets what the scenes needed.
  sd.choose('high', 60);
  assert.equal(sd.neededBy('heavy'), null);
  assert.equal(sd.newScene('heavy'), false);
  assert.equal(sd.quality, 'high');
});

test('step-down in the tab: per scene, the note only when a notch is taken while it shows', async () => {
  const m = await mount({ settings: { visualizerQuality: 'high', visualizerFps: 60 } });
  const { session, h } = m;
  const canvas = session.canvas;
  const first = session.switcher.current;
  m.play();
  h.run(500, 1000 / 60);
  h.run(2 * STEP_DOWN_WINDOW_MS + STEP_DOWN_GRACE_MS + 500, 40);
  assert.equal(session.stepDown.quality, 'medium');
  assert.equal(session.note.textContent, STEP_DOWN_NOTE);
  assert.deepEqual([canvas.width, canvas.height], [1200, 675]);
  // Another scene: the chosen High, no note.
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel');
  assert.equal(session.stepDown.quality, 'high');
  assert.deepEqual([canvas.width, canvas.height], [1600, 900]);
  assert.equal(session.note.hidden, true);
  h.run(10000, 1000 / 60);
  assert.equal(session.stepDown.lowered, false);
  // The first scene again: at Medium straight away, and the note is not shown again.
  session.sceneList.pick(first);
  await m.until(() => session.switcher.current === first);
  assert.equal(session.stepDown.quality, 'medium');
  assert.deepEqual([canvas.width, canvas.height], [1200, 675]);
  assert.equal(session.note.hidden, true);
  assert.equal(session.note.textContent, '');
  session.destroy();
});

test('step-down in the tab: measured from live frames only, applied to size and rate, a note shown, settings untouched, a hand-picked setting clears it', async () => {
  const m = await mount({ settings: { visualizerQuality: 'high', visualizerFps: 60 } });
  const { session, controls, h } = m;
  const canvas = session.canvas;
  assert.deepEqual([canvas.width, canvas.height], [1600, 900], 'High: the full device size');
  // No sound: idle frames are not measured.
  h.run(8000, 1000 / 20);
  assert.equal(session.stepDown.lowered, false);
  // Sound on a 60 Hz display, then a GPU that gets only 25 of its frames out.
  m.play();
  h.run(500, 1000 / 60);
  h.run(500, 40);
  assert.equal(session.loop.mode, LOOP_MODES.live);
  h.run(2 * STEP_DOWN_WINDOW_MS + STEP_DOWN_GRACE_MS + 500, 40);
  assert.equal(session.stepDown.quality, 'medium');
  assert.deepEqual([canvas.width, canvas.height], [1200, 675], 'drawn at Medium');
  assert.equal(session.note.hidden, false);
  assert.equal(session.note.textContent, STEP_DOWN_NOTE);
  assert.equal(NOTES.lowered, 'Lowered quality to keep this scene smooth');
  h.run(20000, 40);
  assert.deepEqual({ quality: session.stepDown.quality, fps: session.stepDown.fps }, { quality: 'low', fps: 30 });
  assert.equal(session.loop.targetFps ?? session.stepDown.fps, 30);
  assert.deepEqual([canvas.width, canvas.height], [800, 450]);
  // The saved settings and the controls still say what was chosen.
  assert.deepEqual(m.saved, [], 'nothing saved');
  assert.equal(m.settings.visualizerQuality, 'high');
  assert.equal(m.settings.visualizerFps, 60);
  assert.equal(controls.qualitySelect.value, 'high');
  assert.equal(controls.fpsButtons.find((b) => b.getAttribute('aria-pressed') === 'true').textContent, '60');
  // Picking a frame rate by hand (even the same one) clears the step-down.
  controls.fpsButtons.find((b) => b.textContent === '60').dispatchEvent(new Event('click'));
  assert.equal(session.stepDown.lowered, false);
  assert.equal(session.note.hidden, true);
  assert.deepEqual([canvas.width, canvas.height], [1600, 900]);
  // Lowered again, then another scene: it starts at what was chosen (the
  // step-down is the scene's).
  h.run(2 * STEP_DOWN_WINDOW_MS + STEP_DOWN_GRACE_MS + 500, 40);
  assert.equal(session.stepDown.lowered, true);
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel');
  assert.equal(session.stepDown.lowered, false);
  assert.deepEqual([canvas.width, canvas.height], [1600, 900]);
  // And a quality picked by hand.
  h.run(2 * STEP_DOWN_WINDOW_MS + STEP_DOWN_GRACE_MS + 500, 40);
  assert.equal(session.stepDown.lowered, true);
  controls.qualitySelect.value = 'medium';
  controls.qualitySelect.dispatchEvent(new Event('change'));
  assert.equal(session.stepDown.lowered, false);
  assert.deepEqual(m.saved.at(-1), { visualizerQuality: 'medium', visualizerQualityPicked: true });
  assert.deepEqual([canvas.width, canvas.height], [1200, 675]);
  session.destroy();
  assert.equal(h.pending(), 0);
});

/* ---------------- Preparing ---------------- */

test('"Preparing scene..." shows while a slow scene compiles (the old one keeps moving), and goes when it is ready', async () => {
  const m = await mount({ parallel: true });
  const { session, gl, h } = m;
  session.sceneList.pick('black_hole');
  await m.until(() => session.switcher.compiling, 'compiling');
  assert.equal(session.note.hidden, true, 'not for a quick switch');
  h.run(PREPARING_DELAY_MS + COMPILE_POLL_MS);
  assert.equal(session.note.textContent, NOTES.preparing);
  assert.equal(NOTES.preparing, 'Preparing scene...');
  assert.equal(session.switcher.current, 'plasma');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'black_hole');
  assert.equal(session.note.hidden, true);
  // A quick one never shows it.
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.compiling, 'compiling');
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'tunnel');
  assert.equal(session.note.hidden, true);
  h.run(PREPARING_DELAY_MS * 2);
  assert.equal(session.note.hidden, true, 'its timer was stopped');
  session.destroy();
  assert.equal(h.pending(), 0);
});

test('without parallel compile (it blocks the page): "Preparing scene..." at once, the compile a moment later, the old picture up meanwhile', async () => {
  const m = await mount();
  const { session, h } = m;
  assert.equal(session.renderer.compileBlocks, true);
  const before = session.renderer.stats.compiles;
  session.sceneList.pick('black_hole');
  assert.ok(await settle(() => session.switcher.compiling, 200), 'its chunk arrived; the compile waits');
  assert.equal(session.note.hidden, false, 'the note at once, not after PREPARING_DELAY_MS');
  assert.equal(session.note.textContent, NOTES.preparing);
  assert.equal(session.renderer.stats.compiles, before, 'not compiled yet: the note is painted first');
  assert.equal(session.switcher.current, 'plasma', 'the old picture stays up');
  // Another pick before it starts: the first is never compiled.
  session.sceneList.pick('tunnel');
  assert.ok(await settle(() => session.switcher.compiling, 200));
  h.run(BLOCKING_COMPILE_DELAY_MS);
  await m.until(() => session.switcher.current === 'tunnel');
  assert.equal(session.renderer.stats.compiles, before + 1, 'only the scene asked for last');
  assert.equal(session.note.hidden, true);
  session.destroy();
  assert.equal(h.pending(), 0);
  // With parallel compile the note still waits PREPARING_DELAY_MS.
  const quick = await mount({ parallel: true });
  assert.equal(quick.session.renderer.compileBlocks, false);
  quick.session.sceneList.pick('black_hole');
  await quick.until(() => quick.session.switcher.compiling, 'compiling');
  assert.equal(quick.session.note.hidden, true);
  quick.session.destroy();
});

/* ---------------- Looks ---------------- */

async function registered(id) {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  return { renderer, def: renderer.register(await sceneById(id).load(), id) };
}

test('looks: a scene\'s colour-scheme list (a plain uniform), or Psychedelia\'s presets after a Default look', async () => {
  const { def: aurora } = await registered('aurora');
  assert.deepEqual(sceneLooks(aurora).map((look) => look.name), ['Classic Green', 'Magenta Storm', 'Polar Blue', 'Rainbow Veil']);
  assert.deepEqual(sceneLooks(aurora)[2].values, { scheme: 2 });
  const { def: kleinian } = await registered('kleinian');
  assert.deepEqual(sceneLooks(kleinian), [], 'no colour list: no looks');
  // Flow Field's style is compiled in; its palette is the look.
  const { def: flow } = await registered('flowfield');
  assert.ok(flow.specialize.includes('style'));
  assert.deepEqual(sceneLooks(flow).map((look) => Object.keys(look.values)[0]), ['palette', 'palette']);
  // Burning Ship starts on the Solar Ash palette (our default).
  const { def: ship } = await registered('burning_ship');
  const shipLooks = sceneLooks(ship);
  assert.equal(startLook(shipLooks, sceneDefaults(ship, sceneById('burning_ship').defaults)), 5);
  assert.equal(currentLook(shipLooks, 2, 5), 2);
  assert.equal(currentLook(shipLooks, 99, 5), 5, 'out of range: the start');
  assert.deepEqual(lookOverrides(sceneById('burning_ship'), ship, 1), { palette_type: 1 });
  assert.deepEqual(lookOverrides(sceneById('nebula'), ship, null), { audio_react: 0.25 });
  // Presets (Psychedelia's smokePresets, on the scene or its metadata).
  const presetDef = {
    params: [{ name: 'size', min: 0, max: 2, default: 1 }, { name: 'style', type: 'select', options: ['A', 'B'], default: 0 }],
    meta: { smokePresets: [{ name: 'Big', values: { size: 1.8, nope: 3 } }, { values: { style: 1 } }, { name: 'Empty', values: { nope: 1 } }] },
  };
  assert.deepEqual(sceneLooks(presetDef).map((look) => look.name), [DEFAULT_LOOK_NAME, 'Big', 'Look 2']);
  assert.deepEqual(sceneLooks(presetDef)[1].values, { size: 1.8 }, 'only the scene\'s params');
  // The setting keeps only looks that differ from the start.
  assert.deepEqual(withLook({ a: 1 }, 'b', 2, 0), { a: 1, b: 2 });
  assert.deepEqual(withLook({ a: 1, b: 2 }, 'b', 0, 0), { a: 1 });
});

test('the looks setting: compact, checked for shape, kept by normalizeSettings', () => {
  assert.deepEqual(normalizeVisualizerLooks(undefined), {});
  assert.deepEqual(normalizeVisualizerLooks([1]), {});
  assert.deepEqual(normalizeVisualizerLooks({
    aurora: 2, Bad: 1, nebula: -1, seascape: 1.5, fire: VISUALIZER_LOOK_MAX + 1, from_a_later_build: 3,
  }), { aurora: 2, from_a_later_build: 3 });
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, 1]));
  assert.equal(Object.keys(normalizeVisualizerLooks(many)).length, VISUALIZER_LOOKS_MAX_SCENES);
  assert.deepEqual(normalizeSettings({ visualizerLooks: { aurora: 1 } }).visualizerLooks, { aurora: 1 });
  assert.deepEqual(normalizeSettings({}).visualizerLooks, {});
});

test('the Look chooser: previous / next change a uniform with no new compile, remembered per scene, hidden where a scene has none', async () => {
  const m = await mount({ settings: { visualizerScene: 'aurora' } });
  const { session, controls, gl } = m;
  assert.equal(controls.lookGroup.hidden, false);
  assert.equal(controls.lookName.textContent, 'Classic Green');
  const compiles = gl.compiledPrograms ?? session.renderer.stats.compiles;
  // (A change of look goes through a transition: shown once it has run.)
  const settleLook = () => m.h.run(CROSSFADE_SLOW_MS + 50);
  controls.lookNext.dispatchEvent(new Event('click'));
  assert.equal(controls.lookName.textContent, 'Magenta Storm');
  settleLook();
  assert.equal(session.renderer.values.scheme, 1);
  assert.equal(session.renderer.stats.compiles, compiles, 'no new compile');
  assert.deepEqual(m.saved.at(-1), { visualizerLooks: { aurora: 1 } });
  session.renderer.draw({ time: 1, audio: {}, beat: {} });
  assert.deepEqual(gl.uniforms.get('u_scheme'), [1], 'the shader gets it');
  // Previous from the start wraps to the last; back to the start drops the entry.
  controls.lookPrev.dispatchEvent(new Event('click'));
  assert.deepEqual(m.saved.at(-1), { visualizerLooks: {} });
  controls.lookPrev.dispatchEvent(new Event('click'));
  assert.equal(controls.lookName.textContent, 'Rainbow Veil');
  assert.deepEqual(m.saved.at(-1), { visualizerLooks: { aurora: 3 } });
  // Another scene keeps its own; one without looks hides the chooser.
  session.sceneList.pick('kleinian');
  await m.until(() => session.switcher.current === 'kleinian');
  assert.equal(controls.lookGroup.hidden, true);
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.current === 'aurora');
  assert.equal(controls.lookName.textContent, 'Rainbow Veil');
  assert.equal(session.renderer.values.scheme, 3, 'prepared with the saved look');
  // Changed elsewhere (another window): followed.
  m.apply({ visualizerLooks: { aurora: 2 } });
  assert.equal(controls.lookName.textContent, 'Polar Blue');
  settleLook();
  assert.equal(session.renderer.values.scheme, 2);
  session.destroy();
  // Opening the tab again: the first scene is prepared with its look.
  const again = await mount({ settings: { visualizerScene: 'aurora', visualizerLooks: { aurora: 1 } } });
  assert.equal(again.session.renderer.values.scheme, 1);
  assert.equal(again.controls.lookName.textContent, 'Magenta Storm');
  again.session.destroy();
});

test('a look that changes a compiled-in param prepares the scene again (the old picture stays meanwhile)', async () => {
  // A scene with presets, one of which sets a param compiled into the shader.
  const { def: plasma } = await registered('plasma');
  const presetScene = {
    id: 'preset_test', name: 'Preset Test', category: 'Test', file: 'effects/plasma.js', cost: 'light', audio: 'motion', links: null, defaults: null,
    load: async () => ({
      default: (G) => {
        G.EffectRegistry.register({
          ...plasma,
          name: 'preset_test',
          params: [...plasma.params, { name: 'style', type: 'select', options: ['A', 'B'], default: 0 }],
          specialize: ['style'],
          smokePresets: [{ name: 'Wide', values: { scale: 2 } }, { name: 'B style', values: { style: 1, scale: 1.5 } }],
        });
        return {};
      },
    }),
  };
  const m = await mount({ settings: { visualizerScene: 'preset_test' }, scenes: [...SCENES, presetScene] });
  const { session, controls } = m;
  assert.equal(controls.lookName.textContent, DEFAULT_LOOK_NAME);
  const compiles = session.renderer.stats.compiles;
  controls.lookNext.dispatchEvent(new Event('click'));
  m.h.run(CROSSFADE_SLOW_MS + 50); // (through a transition)
  assert.equal(session.renderer.values.scale, 2, 'uniform only');
  assert.equal(session.renderer.stats.compiles, compiles);
  const requests = session.switcher.stats.requests;
  controls.lookNext.dispatchEvent(new Event('click'));
  assert.equal(session.switcher.stats.requests, requests + 1, 'prepared and compiled again');
  assert.equal(session.renderer.values.scale, 2, 'the old picture stays meanwhile');
  await m.until(() => session.renderer.values.style === 1, 'B style');
  assert.equal(session.renderer.values.scale, 1.5);
  assert.equal(controls.lookName.textContent, 'B style');
  // Back to Default puts every preset value back to the start.
  controls.lookNext.dispatchEvent(new Event('click'));
  await m.until(() => session.renderer.values.style === 0, 'Default');
  assert.equal(session.renderer.values.scale, sceneDefaults(plasma).scale);
  assert.deepEqual(m.saved.at(-1), { visualizerLooks: {} });
  session.destroy();
});

/* ---------------- Review fixes (slice 3) ---------------- */

test('flash limiter: only edges in one frame, or a follow-on of the same family within 50 ms of a charged edge, are one pulse', () => {
  const limiter = createFlashLimiter();
  const frame = 1 / 30;
  // Three kick + snare pairs, the snare 40 ms after the kick (another frame).
  for (const start of [0, 0.3, 0.6]) {
    limiter.step(start, { kick: 0.5 });
    limiter.step(start + 0.02, { kick: 0 });
    limiter.step(start + 0.04, { snare: 0.5 });
    limiter.step(start + 0.04 + frame, { snare: 0 });
  }
  assert.equal(limiter.stats.pulses, 3, 'three let through');
  assert.equal(limiter.stats.held, 3, 'and the other three charged, so held');
  // The same frame: one pulse whatever the channels.
  const same = createFlashLimiter();
  same.step(0, { kick: 0.5, snare: 0.5, hat: 0.5 });
  assert.equal(same.stats.pulses, 1);
  // The predicted beat a frame before the kick it predicts: one pulse.
  const family = createFlashLimiter();
  family.step(0, { beat: 0.5 });
  family.step(frame, { beat: 0.5, kick: 0.5 });
  assert.equal(family.stats.pulses, 1);
  // Merges do not chain: measured from the charged edge, not the follow-on.
  const chain = createFlashLimiter();
  chain.step(0, { beat: 0.5 });
  chain.step(0.04, { beat: 0.5, kick: 0.5 });
  chain.step(0.06, { beat: 0, kick: 0 });
  chain.step(0.08, { beat: 0.5 });
  assert.equal(chain.stats.pulses, 2);
});

test('flash limiter: a scene that shows the beat clock, chosen just after three pulses, holds the clock short of its wrap until the budget frees', () => {
  const limiter = createFlashLimiter();
  const frame = 1 / 30;
  let t = 0;
  let last = Number.NEGATIVE_INFINITY;
  const clockAt = (time) => {
    const value = limiter.beatClock(time * 2, 120); // 120 BPM: two beats a second
    assert.ok(value >= last - 1e-9, 'the clock never goes back');
    last = value;
    return value;
  };
  for (const at of [0, 0.2, 0.4]) {
    while (t < at - 1e-9) { limiter.step(t, {}); clockAt(t); t += frame; }
    limiter.step(t, { kick: 0.5 });
    clockAt(t);
    t += frame;
  }
  assert.equal(limiter.stats.pulses, 3);
  limiter.setClockShown(true);
  const startCycle = Math.floor(clockAt(t));
  for (; t < 0.95; t += frame) {
    limiter.step(t, {});
    assert.equal(Math.floor(clockAt(t)), startCycle, `no wrap at ${t.toFixed(2)} s: three pulses are still in the second`);
  }
  assert.ok(limiter.stats.clockHeld > 0, 'it waited');
  for (; t < 2.5; t += frame) { limiter.step(t, {}); clockAt(t); }
  assert.ok(Math.floor(last) > startCycle, 'it goes on once a pulse has aged out');
  // When the second has room, showing it changes nothing.
  const roomy = createFlashLimiter();
  roomy.step(0, { kick: 0.5 });
  roomy.beatClock(0.9, 120);
  roomy.setClockShown(true);
  roomy.step(0.1, {});
  roomy.beatClock(1.3, 120);
  assert.equal(roomy.stats.clockHeld, 0);
});

test('step-down: compares with the frames the display offers (60 chosen on a 40 Hz display does not step down; dropped frames do)', async () => {
  const display40 = createStepDown({ quality: 'high', fps: 60 });
  for (let now = 0; now < 12000; now += 25) { display40.tick(now); display40.frame(now); }
  assert.equal(Math.round(display40.displayFps), 40);
  assert.equal(display40.lowered, false, '40 Hz offered, 40 drawn');
  // On a 60 Hz display, frames only every 40 ms are late ones.
  const display60 = createStepDown({ quality: 'high', fps: 60 });
  display60.tick(0);
  display60.tick(1000 / 60);
  for (let now = 100; now < 7000; now += 40) { display60.tick(now); display60.frame(now); }
  assert.equal(display60.lowered, true);
  // In the tab: a 40 Hz display with 60 chosen.
  const m = await mount({ settings: { visualizerQuality: 'high', visualizerFps: 60 } });
  m.play();
  m.h.run(12000, 25);
  assert.equal(m.session.loop.mode, LOOP_MODES.live);
  assert.ok(m.session.stepDown.stats.windows >= 2, 'it was measuring');
  assert.equal(m.session.stepDown.lowered, false);
  m.session.destroy();
});

test('step-down: restarts when a scene is asked for and again when it is installed, and does not measure while it is being prepared', async () => {
  const m = await mount({ parallel: true, settings: { visualizerQuality: 'high', visualizerFps: 60 } });
  const { session, gl, h } = m;
  m.play();
  h.run(500, 1000 / 60);
  h.run(STEP_DOWN_WINDOW_MS - 500, 40); // nearly a slow window on the old scene
  assert.equal(session.stepDown.lowered, false);
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.compiling, 'compiling');
  const windows = session.stepDown.stats.windows;
  h.run(STEP_DOWN_WINDOW_MS * 2, 40);
  assert.equal(session.switcher.busy, true);
  assert.equal(session.stepDown.stats.windows, windows, 'nothing measured while preparing');
  assert.equal(session.stepDown.lowered, false);
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'aurora');
  // A warm-up after its first frame, then two slow windows.
  h.run(STEP_DOWN_GRACE_MS + 2 * STEP_DOWN_WINDOW_MS - 1000, 40);
  assert.equal(session.stepDown.lowered, false, 'measured afresh from the install, after its warm-up');
  assert.equal(session.stepDown.stats.graces >= 1, true);
  h.run(2000, 40);
  assert.equal(session.stepDown.lowered, true, 'and the new scene is measured');
  session.destroy();
});

test('a look chosen while the incoming scene compiles is the one it is installed with', async () => {
  const m = await mount({ parallel: true });
  const { session, gl, controls } = m;
  session.sceneList.pick('aurora');
  await m.until(() => session.switcher.compiling, 'compiling');
  m.apply({ visualizerLooks: { aurora: 2 } });
  gl.finishCompiles();
  await m.until(() => session.switcher.current === 'aurora');
  assert.equal(controls.lookName.textContent, 'Polar Blue');
  assert.equal(session.renderer.values.scheme, 2, 'installed with the new look');
  session.destroy();
  // A look that changes a compiled-in param: prepared again before install.
  const { def: plasma } = await registered('plasma');
  const presetScene = {
    id: 'preset_test', name: 'Preset Test', category: 'Test', file: 'effects/plasma.js', cost: 'light', audio: 'motion', links: null, defaults: null,
    load: async () => ({
      default: (G) => {
        G.EffectRegistry.register({
          ...plasma,
          name: 'preset_test',
          params: [...plasma.params, { name: 'style', type: 'select', options: ['A', 'B'], default: 0 }],
          specialize: ['style'],
          smokePresets: [{ name: 'B style', values: { style: 1, scale: 1.5 } }],
        });
        return {};
      },
    }),
  };
  const again = await mount({ parallel: true, scenes: [...SCENES, presetScene] });
  again.session.sceneList.pick('preset_test');
  await again.until(() => again.session.switcher.compiling, 'compiling');
  again.apply({ visualizerLooks: { preset_test: 1 } });
  const requests = again.session.switcher.stats.requests;
  again.gl.finishCompiles();
  await again.until(() => again.session.switcher.stats.requests > requests, 'prepared again');
  assert.notEqual(again.session.switcher.current, 'preset_test', 'the stale program was not installed');
  await again.until(() => again.session.switcher.compiling, 'compiling again');
  again.gl.finishCompiles();
  await again.until(() => again.session.switcher.current === 'preset_test');
  assert.equal(again.session.renderer.values.style, 1);
  assert.equal(again.session.renderer.values.scale, 1.5);
  assert.equal(again.controls.lookName.textContent, 'B style');
  again.session.destroy();
});

test('the looks setting: a new choice is always kept; unknown scenes go first, then the oldest', () => {
  const full = {};
  for (let i = 0; i < 10; i += 1) full[`gone_${i}`] = 1;
  for (let i = 0; Object.keys(full).length < VISUALIZER_LOOKS_MAX_SCENES; i += 1) full[`known_${i}`] = 1;
  const known = Object.keys(full).filter((key) => key.startsWith('known_'));
  const unknownFirst = withLook(full, 'nebula', 2, 0, [...known, 'nebula']);
  assert.equal(unknownFirst.nebula, 2, 'kept');
  assert.equal(Object.keys(unknownFirst).at(-1), 'nebula', 'latest last');
  assert.equal('gone_0' in unknownFirst, false, 'an unknown scene made room');
  assert.equal('gone_1' in unknownFirst, true, 'only as much as needed');
  assert.equal(Object.keys(unknownFirst).length, VISUALIZER_LOOKS_MAX_SCENES);
  assert.deepEqual(normalizeVisualizerLooks(unknownFirst), unknownFirst, 'and normalisation keeps it');
  // Every entry known: the oldest goes.
  const allKnown = withLook(full, 'nebula', 2, 0, [...Object.keys(full), 'nebula']);
  assert.equal(allKnown.nebula, 2);
  assert.equal('gone_0' in allKnown, false, 'the oldest made room');
  assert.equal('known_0' in allKnown, true);
  // A changed choice moves to the end; one back at the start is dropped.
  const moved = withLook({ aurora: 1, fire: 2 }, 'aurora', 3, 0, ['aurora', 'fire']);
  assert.deepEqual(Object.keys(moved), ['fire', 'aurora']);
  assert.deepEqual(withLook(moved, 'aurora', 0, 0, ['aurora', 'fire']), { fire: 2 });
});

test('the scene list: one highlighted row after filtering; focus leaving or Escape anywhere closes it; the button names a dialog', async () => {
  const m = await mount();
  const { session, controls } = m;
  const list = session.sceneList;
  const lit = () => [...list.options.values()].filter((node) => node.classList.contains('viz-active')).length;
  const press = (key, target = controls.sceneSearch) => {
    const event = new Event('keydown');
    event.key = key;
    target.dispatchEvent(event);
  };
  controls.sceneButton.dispatchEvent(new Event('click'));
  for (let i = 0; i < 5; i += 1) press('ArrowDown');
  assert.equal(lit(), 1);
  controls.sceneSearch.value = 'fractals';
  controls.sceneSearch.dispatchEvent(new Event('input'));
  assert.equal(lit(), 1, 'the row lit before the filter is cleared');
  controls.sceneSearch.value = 'no such scene';
  controls.sceneSearch.dispatchEvent(new Event('input'));
  assert.equal(lit(), 0);
  // ARIA: the button opens a dialog (which holds the search box and listbox).
  assert.equal(controls.sceneButton.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(controls.sceneButton.getAttribute('aria-controls'), list.panel.getAttribute('id'));
  assert.equal(list.panel.getAttribute('role'), 'dialog');
  assert.equal(list.list.getAttribute('role'), 'listbox');
  // Focus moving out (Tab) closes it; moving inside, or to nowhere, does not.
  const focusOut = (relatedTarget) => {
    const event = new Event('focusout');
    event.relatedTarget = relatedTarget;
    list.panel.dispatchEvent(event);
  };
  focusOut(list.search);
  assert.equal(list.open, true);
  focusOut(null);
  assert.equal(list.open, true);
  focusOut(controls.next);
  assert.equal(list.open, false);
  // Escape from anywhere inside it (it bubbles to the panel) closes it and
  // gives focus back to the button.
  let focused = 0;
  controls.sceneButton.focus = () => { focused += 1; };
  controls.sceneButton.dispatchEvent(new Event('click'));
  press('Escape', list.panel);
  assert.equal(list.open, false);
  assert.equal(focused, 1);
  session.destroy();
});
