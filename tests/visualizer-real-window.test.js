import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createSceneList } from '../src/visualizer/scene-list.js';
import { MAX_SCENE_STEP_S, createVisualizerLoop } from '../src/visualizer/loop.js';
import { createFlashLimiter, FLASH_LIMITS } from '../src/visualizer/flash-limiter.js';
import {
  FLASH_SLEW, GLOBAL_FLASH_MAX, PUMP_SLEW, createGlobalReactions,
} from '../src/visualizer/fx-reactions.js';
import { MAX_VOLUME_GAIN_DB, createReactorBridge } from '../src/visualizer/reactor.js';
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { createSceneSwitcher } from '../src/visualizer/scene-switcher.js';
import { LOOKS_LEFT_OUT, sceneLooks } from '../src/visualizer/looks.js';
import { SCENES, SPEED_CAPS } from '../src/visualizer/scenes.js';
import {
  STEP_DOWN_GRACE_MS, STEP_DOWN_LONG_GAP, STEP_DOWN_WINDOWS_NEEDED, STEP_DOWN_WINDOW_MS, createStepDown,
} from '../src/visualizer/step-down.js';
import { createClockHarness, fakeVisibilityDoc } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, StrictGL, fakeDocWithElements, fakeMotion, fakeResizeObserverWin,
} from './helpers/visualizer-fakes.js';
import { bassLineTrack, simulatedAnalyser } from './helpers/audio-sim.js';

/* Findings from the real-window test of slice 5 (the tester's 120 BPM
   stream at Medium / 30 in a 1920 x 1080 window): luminance steps from late
   frames and a fast clock, a step-down set off by short hitches, the volume
   make-up, programs left when the tab closes mid-compile, and the panel at
   the smallest window. No GPU; fake clocks. */

const turn = () => new Promise((resolve) => { setImmediate(resolve); });

/** The visualizer loop on the Beat Reactor fed by `track` at `volume`. */
function liveLoop({ track = bassLineTrack({ bpm: 120 }), volume = 1, onDraw = () => {} } = {}) {
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const node = simulatedAnalyser({ track, clock: h.io.clock, gain: volume });
  const source = {
    isPlaying: () => true, isAudible: () => true, getAnalyser: () => node, getVolume: () => volume, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const bridge = createReactorBridge();
  const loop = createVisualizerLoop({
    signal, fps: 30, react: bridge.react, draw: (state) => { onDraw(state, h.now, bridge); return true; }, doc: vis.doc, win: {}, ...h.io,
  });
  loop.start();
  signal.refresh();
  return { h, loop, bridge, signal };
}

/* ---------------- 1. Luminance steps in the real window ---------------- */

test('late frames slow the picture down instead of jumping it: the scene clock moves at most one 30th of a second (times the surge) per drawn frame', () => {
  assert.equal(MAX_SCENE_STEP_S, 1 / 30);
  for (const frameMs of [1000 / 30, 50, 80]) {
    let last = Number.NaN;
    let most = 0;
    let draws = 0;
    const run = liveLoop({
      onDraw: (state, now) => {
        if (now < 3000) { last = state.time; return; }
        if (state.live && Number.isFinite(last)) {
          most = Math.max(most, (state.time - last) / state.speed);
          draws += 1;
        }
        last = state.time;
      },
    });
    run.h.run(6000, frameMs);
    assert.ok(draws > 30, `${frameMs} ms: drew live frames`);
    assert.ok(most <= MAX_SCENE_STEP_S + 1e-9, `${frameMs} ms frames: at most ${MAX_SCENE_STEP_S} s of scene time per frame (was ${most})`);
    if (frameMs > 40) assert.ok(most > MAX_SCENE_STEP_S * 0.99, `and the cap is what holds it (${frameMs} ms: ${most})`);
    run.loop.destroy();
  }
  // Idle (no sound: about 5 drawn frames a second): the same cap per drawn
  // frame, so an idle draw is no bigger a step than a live one.
  {
    const h = createClockHarness();
    const vis = fakeVisibilityDoc();
    const source = {
      isPlaying: () => false, isAudible: () => false, getAnalyser: () => null, getVolume: () => 1, release() {},
    };
    const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
    let last = Number.NaN;
    let most = 0;
    let idleDraws = 0;
    const loop = createVisualizerLoop({
      signal,
      fps: 30,
      draw: (state) => {
        if (!state.live && Number.isFinite(last)) {
          most = Math.max(most, state.time - last);
          idleDraws += 1;
        }
        last = state.time;
        return true;
      },
      doc: vis.doc,
      win: {},
      ...h.io,
    });
    loop.start();
    signal.refresh();
    h.run(8000, 1000 / 30);
    assert.ok(idleDraws >= 20, `idle frames were drawn (${idleDraws})`);
    assert.ok(most <= MAX_SCENE_STEP_S + 1e-9, `idle: at most ${MAX_SCENE_STEP_S} s of scene time per drawn frame (was ${most})`);
    assert.ok(most > 0, 'and the picture still moves');
    loop.destroy();
  }
});

test('a scene\'s own cap on the time surge: the limiter keeps to it, the tab sets it per scene, and the caps are where the check put them', () => {
  const limiter = createFlashLimiter();
  assert.equal(limiter.speedCap, FLASH_LIMITS.maxSpeed);
  limiter.setSpeedCap(1.25);
  let out;
  for (let t = 0; t < 10; t += 1 / 30) out = limiter.step(t, { speed: 3 });
  assert.ok(Math.abs(out.speed - 1.25) < 1e-9, `held at the cap (${out.speed})`);
  for (const odd of [undefined, null, NaN, 'x']) {
    limiter.setSpeedCap(odd);
    assert.equal(limiter.speedCap, FLASH_LIMITS.maxSpeed, String(odd));
  }
  limiter.setSpeedCap(0);
  assert.equal(limiter.speedCap, FLASH_LIMITS.maxSpeed, 'none');
  limiter.setSpeedCap(0.2);
  assert.equal(limiter.speedCap, 1, 'never below 1 (the music never slows it)');
  limiter.setSpeedCap(9);
  assert.equal(limiter.speedCap, FLASH_LIMITS.maxSpeed, 'never above the limiter\'s own');
  // The table: real scenes, caps between 1 and the limiter's 3, on the entries.
  assert.deepEqual(Object.keys(SPEED_CAPS).sort(), ['analytic_field_lab', 'apollonian_foam_flight', 'aurora', 'endless_terrain', 'folded_box_variants_flight', 'fractal_flame_volume_flight', 'infinite_lattice', 'lsystem_tube_flight', 'mandelbox_flight', 'mandelbrot', 'path_traced_fractal_flight', 'polyfold_flight', 'schottky_inversion_flight', 'strange_attractor_flight', 'tricorn', 'triplex_mutation_flight']);
  for (const [id, cap] of Object.entries(SPEED_CAPS)) {
    const entry = SCENES.find((scene) => scene.id === id);
    assert.ok(entry, id);
    assert.equal(entry.maxSpeed, cap);
    assert.ok(cap >= 1 && cap < FLASH_LIMITS.maxSpeed);
  }
  assert.equal(SCENES.find((scene) => scene.id === 'plasma').maxSpeed, undefined, 'others keep the limiter\'s');
  // Aurora's own beat reaction is turned down (its mids and kicks light the curtains).
  assert.equal(SCENES.find((scene) => scene.id === 'aurora').defaults.audio_react, 0.5);
  // Since Psychedelia b4739fa (steady dive interiors, a terrain camera that
  // glides, half the kick glow on Nebula and Gyroid Tunnels) the overrides it
  // covers are gone; the ones it does not cover stay (scenes.js says why).
  const defaultsOf = (id) => SCENES.find((scene) => scene.id === id).defaults || {};
  assert.equal(defaultsOf('mandelbrot').zoom_speed, undefined, 'Mandelbrot dives at its own speed');
  assert.equal(defaultsOf('tricorn').target_x, undefined, 'Tricorn dives to its own target');
  assert.equal(defaultsOf('endless_terrain').altitude, undefined, 'Endless Terrain flies at its own height');
  assert.equal(SPEED_CAPS.burning_ship, undefined, 'Burning Ship has no speed cap');
  assert.equal(defaultsOf('nebula').audio_react, 0.25, 'Nebula: still lowered (0.16 a frame at its own 1)');
  assert.equal(defaultsOf('gyroid_tunnels').audio_react, 0.5, 'Gyroid Tunnels: still lowered (0.073 at its own 1)');
  // The bridge passes it on.
  const bridge = createReactorBridge();
  bridge.setSpeedCap(1.5);
  assert.equal(bridge.limiter.speedCap, 1.5);
});

/* ---------------- 2. Step-down and short hitches ---------------- */

const feed = (stepDown, from, ms, interval, gaps = []) => {
  let now = from;
  const end = from + ms;
  while (now < end) {
    stepDown.tick(now);
    stepDown.frame(now);
    now += gaps.includes(Math.round(now)) ? STEP_DOWN_LONG_GAP * 2 * interval : interval;
  }
  return now;
};

test('step-down needs a sustained shortfall: one slow window is not enough, two in a row are, a good window between clears the count', () => {
  assert.equal(STEP_DOWN_WINDOWS_NEEDED, 2);
  const steps = [];
  const sd = createStepDown({ quality: 'medium', fps: 30, onStep: (to) => steps.push(to) });
  let now = feed(sd, 0, 4000, 1000 / 30);
  now = feed(sd, now, STEP_DOWN_WINDOW_MS + 100, 50); // 20 a second: slow
  assert.equal(steps.length, 0);
  assert.equal(sd.stats.slowWindows, 1);
  now = feed(sd, now, STEP_DOWN_WINDOW_MS + 100, 1000 / 30); // fine again
  now = feed(sd, now, STEP_DOWN_WINDOW_MS + 100, 50); // slow, but not in a row
  assert.equal(steps.length, 0, 'a good window cleared the count');
  feed(sd, now, STEP_DOWN_WINDOW_MS + 100, 50);
  assert.equal(steps.length, 1, 'two slow windows in a row');
  assert.equal(sd.quality, 'low');
});

test('step-down ignores a window whose shortfall is one or two isolated long gaps (a screenshot), but not a slow cadence', () => {
  const steps = [];
  const sd = createStepDown({ quality: 'medium', fps: 30, onStep: (to) => steps.push(to) });
  // 30 a second with two 400 ms stalls in every window: 30 % fewer frames,
  // but the cadence apart from them is fine.
  let now = feed(sd, 0, 2000, 1000 / 30);
  for (let window = 0; window < 6; window += 1) {
    const start = now;
    now += 400; // a stall
    now = feed(sd, now, 1000, 1000 / 30);
    now += 400; // another
    now = feed(sd, now, STEP_DOWN_WINDOW_MS - (now - start) + 100, 1000 / 30);
  }
  assert.equal(steps.length, 0, 'isolated gaps are not a slow computer');
  assert.ok(sd.stats.forgiven >= 4, `forgiven ${sd.stats.forgiven}`);
  // Many long gaps (every fourth frame late) are a slow computer.
  const slow = createStepDown({ quality: 'medium', fps: 30 });
  now = feed(slow, 0, 2000, 1000 / 30);
  for (let i = 0; i < 400; i += 1) {
    now += i % 4 === 3 ? 200 : 1000 / 30;
    slow.tick(now);
    slow.frame(now);
  }
  assert.equal(slow.lowered, true);
});

test('step-down gives a scene just installed a short warm-up from its first drawn frame', () => {
  const sd = createStepDown({ quality: 'medium', fps: 30 });
  let now = feed(sd, 0, 2000, 1000 / 30);
  sd.newScene();
  assert.equal(sd.stats.graces, 0, 'armed, not started: the grace starts at the first frame drawn');
  now += 600; // compiling: nothing drawn
  // Its first frames are slow (shaders warming up), then it keeps up.
  const firstFrame = now;
  now = feed(sd, now, STEP_DOWN_GRACE_MS - 100, 120);
  assert.equal(sd.stats.graces, 1);
  assert.equal(sd.stats.windows, 0, 'nothing measured in the warm-up');
  now = feed(sd, now, 3 * STEP_DOWN_WINDOW_MS, 1000 / 30);
  assert.ok(now - firstFrame > STEP_DOWN_GRACE_MS);
  assert.ok(sd.stats.windows >= 2);
  assert.equal(sd.lowered, false);
});

/* ---------------- 3. Volume make-up ---------------- */

test('volume make-up on the tester\'s bass-line music: the reactor hears the same at 1, 0.3, 0.1, 0.05 and 0.01; below 0.01 it hears less, and the readout says so', () => {
  const measure = (volume) => {
    const sums = { bass: 0, mid: 0, high: 0, n: 0, madeUp: 0, gain: 0, floats: 0 };
    const run = liveLoop({
      volume,
      onDraw: (state, now, bridge) => {
        if (now < 4000 || !state.live) return;
        sums.bass += state.audio.bass; sums.mid += state.audio.mid; sums.high += state.audio.high; sums.n += 1;
        const made = bridge.adapter.makeUp;
        sums.madeUp += made.madeUpDb; sums.gain += made.gainDb;
        if (made.spectrum === 'float') sums.floats += 1;
      },
    });
    run.h.run(10000);
    run.loop.destroy();
    const n = sums.n;
    return {
      bass: sums.bass / n, mid: sums.mid / n, high: sums.high / n, madeUpDb: sums.madeUp / n, gainDb: sums.gain / n, floats: sums.floats / n,
    };
  };
  const full = measure(1);
  assert.ok(full.bass > 0.3 && full.mid > 0.03 && full.high > 0.03, JSON.stringify(full));
  for (const volume of [0.3, 0.1, 0.05, 0.01]) {
    const quiet = measure(volume);
    assert.equal(quiet.floats, 1, 'the float spectrum, every frame');
    for (const band of ['bass', 'mid', 'high']) {
      assert.ok(Math.abs(quiet[band] - full[band]) < 0.01, `${volume}: ${band} ${quiet[band].toFixed(3)} vs ${full[band].toFixed(3)}`);
    }
    assert.ok(Math.abs(quiet.madeUpDb - full.madeUpDb) < 0.1, `${volume}: made-up level ${quiet.madeUpDb} vs ${full.madeUpDb}`);
  }
  // Below 0.01 the make-up stops at 40 dB: the reactor hears the music that
  // much quieter (and the readout shows it), rather than noise blown up.
  const faint = measure(0.003);
  assert.equal(faint.gainDb, MAX_VOLUME_GAIN_DB);
  const short = 20 * Math.log10(0.003 / 0.01);
  assert.ok(Math.abs(faint.madeUpDb - full.madeUpDb - short) < 0.1, `${faint.madeUpDb - full.madeUpDb} dB vs ${short}`);
  assert.ok(faint.mid < full.mid, 'less to react to');
});

/* ---------------- 4. Leaving the tab mid-compile ---------------- */

test('closing mid-compile: an abandoned program whose link has finished is deleted with its shaders; one still linking is left to the context loss', async () => {
  const h = createClockHarness();
  const gl = new StrictGL({ parallel: true });
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl, mode: 'webgl2' });
  const switcher = createSceneSwitcher({ renderer, timers: h.io });
  switcher.request('plasma');
  for (let i = 0; i < 20 && !switcher.compiling; i += 1) await turn();
  gl.finishCompiles();
  for (let i = 0; i < 20 && switcher.current !== 'plasma'; i += 1) { await turn(); h.run(30); }
  assert.equal(switcher.current, 'plasma');
  // Tunnel starts compiling and is given up (its link still running).
  switcher.request('tunnel');
  for (let i = 0; i < 20 && !switcher.compiling; i += 1) await turn();
  assert.equal(switcher.compiling, true);
  const tunnelProgram = [...gl.programs].find((program) => !program.done);
  switcher.request('starfield');
  assert.equal(renderer.buried, 1);
  // Its link ends, but no poll has seen it yet (no timer has run).
  tunnelProgram.done = true;
  for (let i = 0; i < 20 && renderer.buried < 2; i += 1) {
    await turn();
    if (switcher.compiling) switcher.request('metaballs'); // starfield given up mid-link
  }
  assert.equal(renderer.buried, 2, 'tunnel (link ended) and starfield (still linking)');
  const starfieldProgram = [...gl.programs].find((program) => !program.done);
  const shadersBefore = gl.shaders.size;
  const deletedBefore = renderer.stats.deleted;
  switcher.destroy?.();
  renderer.destroy();
  assert.equal(gl.programs.has(tunnelProgram), false, 'link ended: deleted on teardown');
  assert.equal(renderer.stats.deleted - deletedBefore >= 1, true);
  assert.ok(gl.shaders.size <= shadersBefore - 2, 'with its two shaders');
  // Still linking: deleting it now is what made drivers warn, so it is left;
  // the renderer loses the context next, which frees it with everything else.
  assert.equal(gl.programs.has(starfieldProgram), true, 'still linking: left to the context loss');
  assert.deepEqual(gl.misuse, [], 'nothing deleted mid-link, nothing used after delete');
  assert.equal(h.pending(), 0);
});

/* ---------------- 5 and 6. The smallest window and Tab stops ---------------- */

const CSS = readFileSync(new URL('../src/visualizer/visualizer.css', import.meta.url), 'utf8');
/** The declarations of the first rule for `selector` inside `scope` (the
 *  whole sheet, or a @media block's text). */
function rule(scope, selector) {
  const at = scope.indexOf(`${selector} {`);
  assert.ok(at >= 0, `a rule for ${selector}`);
  return scope.slice(at, scope.indexOf('}', at));
}

test('the smallest tab (967 x 320): the panel and the notice scroll inside the tab, the effects list is two columns, and a short window tightens them', () => {
  // The panel fills the tab's height and scrolls as a whole.
  const panel = rule(CSS, '.viz-panel');
  for (const part of ['top: 0', 'bottom: 0', 'overflow-y: auto', 'max-width: calc(100% - 48px)']) assert.ok(panel.includes(part), part);
  // The notice: its box never taller than the tab, and scrolls.
  const box = rule(CSS, '.viz-notice-box');
  assert.ok(box.includes('max-height: 100%') && box.includes('overflow-y: auto'));
  assert.ok(rule(CSS, '.viz-notice').includes('inset: 0'));
  // The fading buttons: one row, at the top right, clear of the open panel.
  assert.ok(rule(CSS, '.viz-hud').includes('top: 10px'));
  assert.ok(CSS.includes('.viz-panel-open .viz-hud { right: calc(var(--viz-panel-width) + 12px); }'));
  // Effects: two columns; a long name wraps, nothing is cut (the tester saw
  // "Heat Haze & Caustic ..." cut with an ellipsis).
  assert.ok(rule(CSS, '.viz-fx-list').includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
  const name = rule(CSS, '.viz-fx-item span');
  assert.ok(name.includes('white-space: normal') && name.includes('overflow-wrap: break-word'));
  assert.ok(!name.includes('ellipsis') && !name.includes('nowrap'));
  // A short window: no scroll box inside the scrolling panel.
  const short = CSS.slice(CSS.indexOf('@media (max-height: 480px)'));
  assert.ok(short.length > 30, 'a rule for short windows');
  assert.ok(rule(short, '.viz-scene-options').includes('max-height: none'));
  assert.ok(rule(short, '.viz-notice').includes('padding: 8px'));
  // At 967 wide the panel (300) leaves 655 px for the picture and the buttons.
  assert.ok(CSS.includes('--viz-panel-width: 300px'));
});

test('no stray Tab stop: the scene list (a scroller with nothing focusable) is taken out of the Tab order, and nothing else in the tab carries a tabindex', async () => {
  const vis = fakeDocWithElements({ width: 967, height: 320 });
  const list = createSceneList({ doc: vis.doc, scenes: SCENES, onPick() {}, listen() {} });
  const nodes = [];
  const walk = (node) => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children || []) walk(child); };
  for (const part of Object.values(list)) if (part && part.tagName) walk(part);
  const listbox = nodes.find((node) => node.getAttribute?.('role') === 'listbox');
  assert.ok(listbox, 'the list');
  assert.equal(listbox.getAttribute('tabindex'), '-1');
  // The whole tab: the only tabindex anywhere is that one.
  const h = createClockHarness();
  const root = new FakeNodeEl('div');
  const tab = fakeDocWithElements({ width: 967, height: 320 });
  const signal = createAudioSignal({ source: { isPlaying: () => false, isAudible: () => true, getAnalyser: () => null, release() {} }, doc: tab.doc, ...h.io });
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => normalizeSettings({ visualizerNoticeSeen: true }),
    saveSettings() {},
    subscribeSettings: () => () => {},
    win: fakeResizeObserverWin(fakeMotion(false)),
    doc: tab.doc,
    createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
  });
  const all = [];
  const walkAll = (node) => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children || []) walkAll(child); };
  walkAll(root);
  const withIndex = all.filter((node) => node.getAttribute?.('tabindex') !== null && node.getAttribute?.('tabindex') !== undefined);
  assert.deepEqual(withIndex.map((node) => `${node.className}:${node.getAttribute('tabindex')}`), ['viz-scene-options:-1']);
  session.destroy();
});

/* ---------------- The FX flash check's finding ---------------- */

test('the global flash and pump never jump: each moves at most its slew a second, and only once for a frame drawn twice', () => {
  const reactions = createGlobalReactions();
  const hit = { kick: FLASH_LIMITS.maxPulseDepth, snare: 0, bass: 1, hat: 0 };
  const quiet = { kick: 0, snare: 0, bass: 0, hat: 0 };
  let last = { flash: 0, pump: 0 };
  let peak = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    const values = reactions.step(frame % 15 < 3 ? hit : quiet, 'strong', true, 1 / 30);
    assert.ok(Math.abs(values.flash - last.flash) <= FLASH_SLEW / 30 + 1e-12, `flash step ${values.flash - last.flash}`);
    assert.ok(Math.abs(values.pump - last.pump) <= PUMP_SLEW / 30 + 1e-12, `pump step ${values.pump - last.pump}`);
    assert.ok(values.flash <= GLOBAL_FLASH_MAX);
    peak = Math.max(peak, values.flash);
    last = { flash: values.flash, pump: values.pump };
  }
  assert.ok(peak > 0.02, 'it still answers the hits');
  // dt 0 (the same frame again): nothing moves.
  const before = { ...reactions.values };
  reactions.step(hit, 'strong', true, 0);
  assert.equal(reactions.values.flash, before.flash);
  assert.equal(reactions.values.pump, before.pump);
  // Off: it falls back at the same rate, never drops in one frame.
  const was = reactions.values.flash;
  const off = reactions.step(quiet, 'strong', false, 1 / 30);
  assert.ok(was - off.flash <= FLASH_SLEW / 30 + 1e-12);
});

test('looks the flash check found stepping over 0.10 on their own are left out (Mandelbrot Neon and Ocean); the others keep their option index as their value', async () => {
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new StrictGL(), mode: 'webgl2' });
  const entry = SCENES.find((scene) => scene.id === 'mandelbrot');
  const def = renderer.register(await entry.load(), entry.id);
  const list = sceneLooks(def);
  assert.deepEqual(LOOKS_LEFT_OUT.mandelbrot, [1, 3]);
  assert.deepEqual(list.map((look) => look.name), ['Rainbow', 'Fire', 'Psychedelic']);
  assert.deepEqual(list.map((look) => look.values.palette_type), [0, 2, 4]);
  renderer.destroy();
});
