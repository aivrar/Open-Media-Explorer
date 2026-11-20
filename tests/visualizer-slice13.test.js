import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  ALL_SCENE_FILES, EXTRA_SCENE_FILES, FILES, HELPER_FILES, HOOK_GLOBALS, LAB_FILES, SCENE_GLOBALS, VENDOR_DIR,
} from '../scripts/import_psychedelia.mjs';
import {
  FX_CALM_SCENES, FX_NONE_SCENES, SCENES, SCENE_DRIFT, SPEED_CAPS, sceneById,
} from '../src/visualizer/scenes.js';
import { EXTRA_LOOK_FIRST, PRESETS_LEFT_OUT, sceneLooks } from '../src/visualizer/looks.js';

// The presets only (the labs' extra looks, numbered from 20, have their own
// test: tests/visualizer-extra-looks.test.js).
const presetLooks = (looks) => looks.filter((look) => look.number < EXTRA_LOOK_FIRST);
import { createSceneRenderer } from '../src/visualizer/scene-renderer.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { hookFrames } from './helpers/visualizer-flash-check.mjs';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 13 of the visualizer: the shader-only scenes that needed no new
   host: Robot Foundry (one more endless scene), Psychedelia's four Fractal
   Labs, and Cymatics, whose setUniforms hook follows the Beat Reactor the
   tab already runs. No GPU; fake clocks. */

const REPO = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));

const LABS = Object.freeze({
  escape_time_lab: { file: 'escape-time-lab', name: '2D Formula Lab', mode: 'formula', presets: 9 },
  analytic_field_lab: { file: 'analytic-field-lab', name: 'Analytic Field Lab', mode: 'field_mode', presets: 10 },
  procedural_field_lab: { file: 'procedural-field-lab', name: 'Procedural Field Lab', mode: 'proc_mode', presets: 10 },
  fractal_flame_lab: { file: 'fractal-flame-lab', name: 'Fractal Flame Lab', mode: 'flame_mode', presets: 11 },
});
const NEW_IDS = Object.freeze(['robot_foundry', ...Object.keys(LABS), 'cymatics']);

function newRenderer() {
  return createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
}

/* ---------------- The import ---------------- */

test('the import script vendors the labs, their helpers, Robot Foundry and Cymatics, each with its manifest entry', () => {
  assert.deepEqual(LAB_FILES, ['escape-time-lab', 'analytic-field-lab', 'procedural-field-lab', 'fractal-flame-lab']);
  assert.deepEqual(EXTRA_SCENE_FILES, ['robot-foundry', 'cymatics']);
  for (const name of [...LAB_FILES, ...EXTRA_SCENE_FILES]) assert.ok(ALL_SCENE_FILES.includes(name), name);
  assert.ok(HELPER_FILES.includes('fractal-lab-common'));
  assert.ok(SCENE_GLOBALS.includes('FractalLab'));
  // A hook's globals: read while it draws, given by the app as stand-ins.
  assert.deepEqual(HOOK_GLOBALS, ['AudioReactor', 'Renderer']);
  for (const name of [...LAB_FILES, ...EXTRA_SCENE_FILES, 'fractal-lab-common']) {
    const target = `effects/${name}.js`;
    assert.ok(FILES.some((file) => file.target === target), `${name}: imported`);
    const entry = manifest.files.find((file) => file.target === target);
    assert.ok(entry, `${name}: in the manifest`);
    // Cymatics alone is patched: each visit starts afresh (PATCHES).
    if (name === 'cymatics') assert.deepEqual(entry.patches.map((patch) => patch.why.split(' ')[0]), ['its', 'the', 'init']);
    else assert.equal(entry.patches, undefined, `${name}: unchanged on import`);
  }
  const needs = (name) => manifest.files.find((file) => file.target === `effects/${name}.js`).needs;
  for (const name of LAB_FILES) assert.ok(needs(name).includes('FractalLab'), name);
  assert.ok(needs('cymatics').includes('AudioReactor'));
  assert.ok(needs('robot-foundry').includes('EndlessScenes'));
});

test('Robot Foundry carries borrowed code (the endless engine\'s hash, a capsule and a capped cylinder) and is credited for it; the labs and Cymatics carry none', () => {
  const rows = manifest.borrowed.filter((row) => NEW_IDS.includes(row.scene));
  assert.deepEqual(rows.map((row) => `${row.scene}:${row.piece}`).sort(), ['robot_foundry:hoskins-hash', 'robot_foundry:iq-distance-functions']);
  const credits = readFileSync(join(REPO, 'CREDITS.md'), 'utf8').replace(/\s+/g, ' ');
  const notices = readFileSync(join(REPO, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8').replace(/\s+/g, ' ');
  for (const text of [credits, notices]) {
    // (Slice 14 adds Curl-Noise Silk after it.)
    assert.match(text, /Planet Sunrise, Robot Foundry(, Curl-Noise Silk)?\. Author: David Hoskins|Planet Sunrise, Robot Foundry(, Curl-Noise Silk)? Files:/);
    assert.match(text, /the capsule and the capped cylinder|capsule, capped cylinder/);
    assert.match(text, /Polyfold Flight, Robot Foundry/);
  }
  for (const name of [...LAB_FILES, ...EXTRA_SCENE_FILES, 'fractal-lab-common']) {
    assert.ok(credits.includes(`src/effects/${name}.js`), `CREDITS.md lists ${name}`);
    assert.ok(notices.includes(`src/effects/${name}.js`), `the notices list ${name}`);
  }
  // The methods behind two labs, credited as for the scenes they share them with.
  assert.match(credits, /Complex Domain Coloring and Analytic Field Lab follow the domain coloring method credited to Frank Farris/);
  assert.match(credits, /Fractal Flame Lab and 3D Fractal Flame Volume Flight use the variation/);
});

/* ---------------- The scenes ---------------- */

test('the six register, compile and draw in this renderer; the labs compile their formula mode in, as the flights do', async () => {
  const renderer = newRenderer();
  for (const id of NEW_IDS) {
    const entry = sceneById(id);
    assert.ok(entry, `${id} offered`);
    const def = renderer.register(await entry.load(), id);
    assert.ok(def, `${id} registered`);
    const prepared = renderer.prepare(def, entry.defaults);
    assert.ok(prepared.sources.frag.length > 1000, id);
    assert.ok(renderer.useSceneNow(def), `${id} compiled`);
    assert.ok(renderer.draw({ time: 1, audio: {}, beat: {}, zoom: 1 }), `${id} drawn`);
  }
  for (const [id, lab] of Object.entries(LABS)) {
    const entry = sceneById(id);
    assert.equal(entry.name, lab.name);
    assert.equal(entry.file, `effects/${lab.file}.js`);
    assert.equal(entry.audio, 'motion', `${id}: reads no sound`);
    const def = renderer.engine.EffectRegistry.getDefinition(id);
    assert.deepEqual(def.specialize, [lab.mode], `${id}: its mode compiled in`);
    assert.equal(def.fractalFlight.kind, 'fractal-lab');
  }
  assert.equal(sceneById('robot_foundry').category, 'Endless Scenes');
  assert.equal(sceneById('cymatics').category, 'Math');
  assert.equal(sceneById('cymatics').audio, 'shader');
  renderer.destroy();
});

test('looks: each lab offers Default and its presets, Robot Foundry its six, Cymatics its four colour schemes', async () => {
  const renderer = newRenderer();
  for (const [id, lab] of Object.entries(LABS)) {
    const def = renderer.register(await sceneById(id).load(), id);
    const looks = presetLooks(sceneLooks(def, { all: true }));
    assert.equal(looks.length, 1 + lab.presets, id);
    assert.equal(looks[0].name, 'Default');
    // A preset sets the mode (a new compile) with its other values.
    assert.ok(looks.slice(1).every((look) => Number.isFinite(look.values[lab.mode])), `${id}: presets set the mode`);
  }
  const robot = renderer.register(await sceneById('robot_foundry').load(), 'robot_foundry');
  assert.deepEqual(sceneLooks(robot, { all: true }).map((look) => look.name), [
    'Default', 'Copper Parade', 'Neon Night Shift', 'Retro Disco District', 'Cosmic Conductors', 'Mint Machine Carnival', 'Chrome Giants',
  ]);
  const plate = renderer.register(await sceneById('cymatics').load(), 'cymatics');
  assert.deepEqual(sceneLooks(plate).map((look) => look.name), ['Brass & Sand', 'Neon', 'Ice', 'Fire']);
  assert.ok(sceneLooks(plate).every((look) => Object.keys(look.values).join() === 'scheme'));
  renderer.destroy();
});

/* ---------------- Cymatics and the Beat Reactor ---------------- */

/** A Beat Reactor as the tab's (reactor.js bridge.reactor) is seen by
 *  scenes: a clock, its analysis, whether music plays. */
function fakeReactor({ live = false, peakHz = 440 } = {}) {
  const fft = new Uint8Array(1024);
  const binHz = 48000 / 2048;
  const reactor = {
    clock: 0,
    live,
    getClock() { return reactor.clock; },
    isLive() { return reactor.live; },
    getAnalysis() {
      fft.fill(0);
      fft[Math.round(reactor.peakHz / binHz)] = 255;
      return { active: true, fft, spectrum: fft, byteData: true, sampleRate: 48000, fftSize: 2048, fftScale: 'normalized-db' };
    },
    peakHz,
  };
  return reactor;
}

test('Cymatics: the renderer gives its hook a stand-in over the tab\'s reactor (clock, analysis, music or not); before one is given, the scene clock and no music; destroy lets it go', async () => {
  const renderer = newRenderer();
  const audio = renderer.sceneAudio;
  assert.equal(audio.isLive(), false);
  assert.equal(audio.getAnalysis(), null);
  const plate = renderer.register(await sceneById('cymatics').load(), 'cymatics');
  renderer.useSceneNow(plate);
  renderer.draw({ time: 7.5, audio: {}, beat: {}, zoom: 1 });
  assert.equal(audio.getClock(), 7.5, 'no reactor yet: the scene clock');
  const reactor = fakeReactor({ live: true });
  reactor.clock = 42;
  renderer.setAudioReactor(reactor);
  assert.equal(audio.getClock(), 42);
  assert.equal(audio.isLive(), true);
  assert.equal(audio.getAnalysis().sampleRate, 48000);
  renderer.destroy();
  assert.equal(audio.isLive(), false, 'let go on destroy');
});

test('Cymatics follows the strongest pitch the reactor hears (held a quarter second), cycles its patterns on the reactor clock without music, and fades between them', async () => {
  const renderer = newRenderer();
  const gl = renderer.context || null;
  const plate = renderer.register(await sceneById('cymatics').load(), 'cymatics');
  const reactor = fakeReactor({ live: true, peakHz: 440 });
  renderer.setAudioReactor(reactor);
  const out = {};
  const g = { uniform1f: (at, value) => { out[at.name] = value; } };
  const values = { ...renderer.prepare(plate).values };
  const set = (t) => { reactor.clock = t; plate.setUniforms(g, {}, values, (p, name) => ({ name }), t); return { ...out }; };
  // A held A4 (note 69): its pair, after 0.25 s, faded in over 0.6 s.
  set(0);
  set(0.1);
  const held = set(0.4);
  const pc = 69 % 12;
  const n = 1 + (pc % 6);
  const m = n + 2 + ((pc + Math.floor(69 / 12)) % 5);
  assert.deepEqual([held.u_n2, held.u_m2], [n, m], 'the pattern of the note heard');
  assert.ok(held.u_blend < 0.1, 'fading in');
  assert.equal(set(1.2).u_blend, 1, 'faded in');
  // Another note: another pattern.
  reactor.peakHz = 660;
  set(1.3);
  const next = set(1.7);
  assert.notDeepEqual([next.u_n2, next.u_m2], [n, m]);
  // No music: the Auto Cycle on the reactor's clock (cycle_time seconds).
  reactor.live = false;
  const before = set(2);
  const later = set(2 + values.cycle_time + 0.1);
  assert.notDeepEqual([later.u_n2, later.u_m2], [before.u_n2, before.u_m2], 'cycled on');
  assert.equal(gl, null);
  renderer.destroy();
});

test('Cymatics starts every visit afresh: a fade left half done is not carried into the next visit (init and cleanup restart it, patched on import)', async () => {
  const renderer = newRenderer();
  const plate = renderer.register(await sceneById('cymatics').load(), 'cymatics');
  const reactor = fakeReactor({ live: false });
  renderer.setAudioReactor(reactor);
  const frame = hookFrames(plate);
  const values = renderer.prepare(plate).values;
  const at = (t) => { reactor.clock = t; return frame(values, t); };
  const first = at(100);
  assert.deepEqual([first.u_n1, first.u_m1, first.u_n2, first.u_m2], [2, 5, 3, 7], 'a visit starts from 2,5 towards 3,7');
  at(100 + values.cycle_time + 0.1);
  // Follow Music (its default) fades over 0.6 s.
  const half = at(100 + values.cycle_time + 0.4);
  assert.ok(half.u_blend > 0 && half.u_blend < 1, 'half way through the next fade');
  // Away and back, through the renderer as the tab does it.
  const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
  renderer.useSceneNow(plate);
  renderer.useSceneNow(tunnel);
  renderer.useSceneNow(plate);
  const again = at(300);
  assert.deepEqual([again.u_n1, again.u_m1, again.u_n2, again.u_m2], [2, 5, 3, 7], 'the next visit starts the same way');
  assert.ok(again.u_blend < 0.1);
  renderer.destroy();
});

test('the flash check draws Cymatics\' hook frame by frame (hookFrames); a scene without a hook has none', async () => {
  const renderer = newRenderer();
  const plate = renderer.register(await sceneById('cymatics').load(), 'cymatics');
  const reactor = fakeReactor({ live: false });
  renderer.setAudioReactor(reactor);
  const frame = hookFrames(plate);
  const values = renderer.prepare(plate).values;
  const seen = new Set();
  for (let t = 0; t < 30; t += 0.5) {
    reactor.clock = t;
    const hook = frame(values, t);
    assert.deepEqual(Object.keys(hook).sort(), ['u_blend', 'u_m1', 'u_m2', 'u_n1', 'u_n2']);
    seen.add(`${hook.u_n2},${hook.u_m2}`);
  }
  assert.ok(seen.size >= 3, `the patterns move (${seen.size})`);
  const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
  assert.equal(hookFrames(tunnel), null);
  renderer.destroy();
});

/* ---------------- In the tab ---------------- */

const LAYOUT = { width: 1280, height: 720 };
async function mount(settings) {
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
  const gl = new FakeGL();
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
  assert.ok(session.switcher.current, 'first scene');
  return { gl, h, session, source, signal };
}

test('in the tab: Cymatics reads the tab\'s own reactor, makes no audio context of its own, and its pattern uniforms are drawn every frame', async () => {
  const made = [];
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { made.push(this); } resume() { made.push('resume'); } };
  try {
    const m = await mount({ visualizerScene: 'cymatics' });
    assert.equal(m.session.switcher.current, 'cymatics');
    const { renderer } = m.session;
    assert.equal(renderer.sceneAudio.getClock(), m.session.bridge.reactor.getClock(), 'the bridge\'s reactor');
    m.source.playing = true;
    m.signal.refresh();
    // No pitch strong enough here: it cycles its patterns (Auto Cycle, every
    // cycle_time seconds of the reactor clock), each faded in (0.6 s under
    // Follow Music, its default; 1.4 s under Auto Cycle).
    const PAIRS = [[1, 3], [2, 5], [3, 7], [1, 5], [4, 7], [2, 7], [3, 5], [5, 9], [1, 4], [4, 9], [3, 8], [6, 11], [2, 9], [5, 7]];
    const frames = [];
    for (let i = 0; i < 20 * 30; i += 1) {
      m.h.run(1000 / 30, 1000 / 30);
      if (i % 30 === 0) await settle(() => false, 1);
      for (const name of ['u_n1', 'u_m1', 'u_n2', 'u_m2', 'u_blend']) assert.ok(m.gl.uniforms.has(name), name);
      const at = (name) => m.gl.uniforms.get(name)[0];
      frames.push({ clock: renderer.sceneAudio.getClock(), to: `${at('u_n2')},${at('u_m2')}`, from: `${at('u_n1')},${at('u_m1')}`, blend: at('u_blend') });
    }
    const shown = frames.map((f) => f.to).filter((to, i, all) => i === 0 || to !== all[i - 1]);
    assert.ok(shown.length >= 3, `patterns: ${shown.join(' ')}`);
    // In Auto Cycle order from where a visit starts (2,5 shown, 3,7 next).
    const start = PAIRS.findIndex(([n, mm]) => `${n},${mm}` === shown[0]);
    assert.ok(start >= 2, shown[0]);
    shown.forEach((to, k) => assert.equal(to, PAIRS[(start + k) % PAIRS.length].join(','), `pattern ${k}`));
    // Each change: from the one before, the blend rising from near 0 to 1.
    for (let k = 1; k < shown.length; k += 1) {
      const run = frames.filter((f) => f.to === shown[k]);
      assert.equal(run[0].from, shown[k - 1]);
      assert.ok(run[0].blend < 0.1, `fade ${k} starts low (${run[0].blend})`);
      for (let j = 1; j < run.length; j += 1) assert.ok(run[j].blend >= run[j - 1].blend, `fade ${k} rises`);
      const done = run.find((f) => f.blend === 1);
      if (done) assert.ok(done.clock - run[0].clock <= 0.6 + 0.1, 'over 0.6 s');
    }
    assert.ok(frames.some((f) => f.blend > 0 && f.blend < 1), 'a fade drawn part way');
    assert.equal(made.length, 0, 'no AudioContext made or resumed');
    m.session.destroy();
    assert.equal(renderer.sceneAudio.getAnalysis(), null, 'let go when the tab closes');
  } finally {
    if (saved === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved;
  }
});

test('the six are offered (not held) and listed', () => {
  for (const id of NEW_IDS) assert.ok(SCENES.some((scene) => scene.id === id), id);
});

test('as measured: Analytic Field Lab capped at 1x, Root Solver Bloom left out, no drift for the two, both calm with effects; the other four as they come', async () => {
  assert.equal(SPEED_CAPS.analytic_field_lab, 1);
  for (const id of ['escape_time_lab', 'procedural_field_lab', 'fractal_flame_lab', 'robot_foundry', 'cymatics']) assert.equal(SPEED_CAPS[id], undefined, id);
  assert.equal(SCENE_DRIFT.analytic_field_lab, false);
  assert.equal(SCENE_DRIFT.escape_time_lab, false);
  for (const id of ['procedural_field_lab', 'fractal_flame_lab', 'robot_foundry', 'cymatics']) assert.equal(SCENE_DRIFT[id], undefined, `${id} drifts`);
  for (const id of ['escape_time_lab', 'analytic_field_lab']) assert.ok(FX_CALM_SCENES.has(id), `${id} calm`);
  for (const id of NEW_IDS) assert.ok(!FX_NONE_SCENES.has(id), `${id} keeps its effects (under 0.085)`);
  for (const id of ['procedural_field_lab', 'fractal_flame_lab', 'robot_foundry', 'cymatics']) assert.ok(!FX_CALM_SCENES.has(id), id);
  assert.deepEqual([...PRESETS_LEFT_OUT.escape_time_lab], ['Root Solver Bloom']);
  const renderer = newRenderer();
  const def = renderer.register(await sceneById('escape_time_lab').load(), 'escape_time_lab');
  const offered = presetLooks(sceneLooks(def));
  assert.equal(offered.length, 9);
  assert.ok(!offered.some((look) => look.name === 'Root Solver Bloom'));
  assert.equal(sceneLooks(def, { all: true }).find((look) => look.name === 'Root Solver Bloom').number, 8, 'numbered by its index upstream');
  assert.equal(offered.at(-1).number, 9, 'the look after it keeps its number');
  renderer.destroy();
});
