import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { MIN_REACT_FPS, createVisualizerLoop } from '../src/visualizer/loop.js';
import { createSceneRenderer, defaultValue, ownsPasses, sceneDefaults } from '../src/visualizer/scene-renderer.js';
import { createSceneSwitcher } from '../src/visualizer/scene-switcher.js';
import { SCENES, stepScene } from '../src/visualizer/scenes.js';
import { FLASH_LIMITS, createFlashLimiter } from '../src/visualizer/flash-limiter.js';
import {
  MAX_VOLUME_GAIN_DB, createAudioAdapter, createReactorBridge, linkRuleViolation, volumeGainDb,
} from '../src/visualizer/reactor.js';
import { createClockHarness, fakeVisibilityDoc } from './helpers/signal-harness.js';
import { FakeGL, StrictGL } from './helpers/visualizer-fakes.js';
import { bassLineTrack, danceTrack, simulatedAnalyser } from './helpers/audio-sim.js';
import { sceneLuminance } from './helpers/scene-luminance.js';

/* Fixes from the first real-window test of slice 2: driver warnings on rapid
   scene switching, Psychedelia's defaults applied exactly, the tempo at 15
   frames a second, the clock rate on the strip, and scenes that move with
   the music (zoom punch and our own parameter links). */

const turn = () => new Promise((resolve) => { setImmediate(resolve); });

/* ---------------- Rapid switching: no use of a deleted or wrong object ---------------- */

test('StrictGL catches a program deleted mid-link (the check the next test relies on)', () => {
  const gl = new StrictGL({ parallel: true });
  const program = gl.createProgram();
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.linkProgram(program);
  gl.deleteProgram(program);
  gl.getProgramParameter(program, 0);
  gl.getProgramParameter(shader, 0);
  assert.deepEqual(gl.misuse, [
    'deleteProgram: still linking',
    'getProgramParameter: deleted program',
    'getProgramParameter: shader where a program is expected',
  ]);
});

test('rapid scene switching (40 clicks, 0-150 ms apart) never deletes a program mid-link or touches a deleted or wrong-typed object', async () => {
  for (const [parallel, autoFinish] of [[true, Infinity], [true, 2], [true, 5], [false, Infinity]]) {
    const label = parallel ? `parallel, links end after ${autoFinish} checks` : 'no parallel compile';
    const h = createClockHarness();
    const gl = new StrictGL({ parallel });
    gl.autoFinishAfter = autoFinish;
    const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl, mode: 'webgl2' });
    const switcher = createSceneSwitcher({ renderer, timers: h.io });
    let id = 'plasma';
    switcher.request(id);
    for (let click = 0; click < 40; click += 1) {
      for (let i = 0; i < 5; i += 1) await turn();
      h.run((click * 37) % 150);
      renderer.draw({ time: click, audio: {}, beat: {}, zoom: 1 });
      id = stepScene(id, 1);
      switcher.request(id);
    }
    for (let i = 0; i < 50; i += 1) { await turn(); h.run(30); }
    gl.finishCompiles();
    for (let i = 0; i < 50; i += 1) { await turn(); h.run(30); }
    assert.deepEqual(gl.misuse, [], label);
    assert.equal(switcher.current, id, `${label}: the last scene asked for is drawn`);
    assert.equal(renderer.buried, 0, `${label}: every abandoned program deleted once its link ended`);
    assert.equal(gl.programs.size, 1, `${label}: only the scene being drawn is left`);
    switcher.destroy?.();
    renderer.destroy();
    assert.equal(h.pending(), 0, `${label}: no timer left`);
  }
});

/* ---------------- Psychedelia's defaults, exactly ---------------- */

test('each param starts where Psychedelia\'s Controls starts it (defaultValueForParam), and every scene draws with all of them', async () => {
  // gui/controls.js defaultValueForParam, rule by rule.
  assert.deepEqual(defaultValue({ type: 'color', default: '#ff8000' }), [1, 128 / 255, 0]);
  assert.deepEqual(defaultValue({ type: 'color' }), [1, 0, 1]);
  assert.equal(defaultValue({ type: 'bool', default: true }), 1);
  assert.equal(defaultValue({ type: 'bool' }), 0);
  assert.equal(defaultValue({ type: 'select', default: '2' }), 2);
  assert.equal(defaultValue({ type: 'select', default: 'x' }), 0);
  assert.equal(defaultValue({ type: 'select' }), 0);
  assert.equal(defaultValue({ min: 3, max: 9 }), 3);
  assert.equal(defaultValue({ min: 0.5, max: 2, default: 1.25 }), 1.25);
  assert.equal(defaultValue({}), 0);
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 64, height: 36 }, gl, mode: 'webgl2' });
  for (const scene of SCENES) {
    const def = renderer.register(await scene.load(), scene.id);
    const values = sceneDefaults(def);
    assert.deepEqual(Object.keys(values), def.params.map((param) => param.name), `${scene.id}: every param`);
    // Scenes that own their passes draw through the host, which hands them
    // these values (tests/visualizer-slice14.test.js); their defaults here.
    if (ownsPasses(def)) {
      for (const param of def.params) assert.deepEqual(values[param.name], defaultValue(param), `${scene.id}.${param.name}`);
      continue;
    }
    renderer.useSceneNow(def);
    gl.uniforms.clear();
    renderer.draw({ time: 1, audio: {}, beat: {}, sources: null, zoom: 1 });
    const fragment = gl.current.fragment;
    for (const param of def.params) {
      const expected = defaultValue(param);
      if (param.type !== 'select') {
        assert.ok(expected >= param.min && expected <= param.max, `${scene.id}.${param.name} default in its range`);
      }
      if (!new RegExp(`\\bu_${param.name}\\b`).test(fragment)) continue; // compiled in as a constant
      assert.deepEqual(gl.uniforms.get(`u_${param.name}`), [expected], `${scene.id}.${param.name} drawn at its default`);
    }
    // The standard uniforms as Psychedelia's renderer sets them at rest.
    assert.deepEqual(gl.uniforms.get('u_resolution'), [64, 36]);
    if (gl.uniforms.has('u_view_zoom')) assert.deepEqual(gl.uniforms.get('u_view_zoom'), [1]);
  }
  renderer.destroy();
});

/* ---------------- Tempo and the clock rate ---------------- */

/** A loop with the real reactor on synthesized music through a software
 *  analyser; returns the bridge after `seconds`. */
function playTrack({
  fps, track, gain = 1, seconds = 15, clockShown = false, reportVolume = true, refresh = 60,
}) {
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const node = simulatedAnalyser({ track, clock: h.io.clock, gain });
  // The analyser hears the track at `gain` (the tap is after the element's
  // volume); the player's source reports that volume.
  const source = {
    playing: true,
    isPlaying() { return true; },
    isAudible() { return gain > 0; },
    getAnalyser() { return node; },
    getVolume() { return reportVolume ? gain : 1; },
    release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const bridge = createReactorBridge();
  bridge.setClockShown(clockShown);
  let draws = 0;
  // The tempo read at the end of each second.
  const bpmEachSecond = [];
  // Mean of the reactor's own band levels over the second half.
  const bands = { bass: 0, mid: 0, high: 0, n: 0 };
  const loop = createVisualizerLoop({
    signal,
    fps,
    react: (state, frame, now, dt) => {
      bridge.react(state, frame, now, dt);
      if (now >= bpmEachSecond.length + 1) bpmEachSecond.push(bridge.snapshot().bpm);
      if (now * 1000 < (seconds * 1000) / 2) return;
      for (const name of ['bass', 'mid', 'high']) bands[name] += bridge.raw[name];
      bands.n += 1;
    },
    draw: () => { draws += 1; },
    doc: vis.doc,
    win: {},
    ...h.io,
  });
  loop.start();
  signal.refresh();
  h.run(seconds * 1000, 1000 / refresh);
  for (const name of ['bass', 'mid', 'high']) bands[name] /= Math.max(1, bands.n);
  const result = {
    bridge, loop, draws, bands, bpmEachSecond, readings: bridge.adapter.stats.readings, snapshot: bridge.snapshot(),
  };
  loop.destroy();
  return result;
}

test('at 15 frames a second the reactor is still fed 30 times a second, so a 120 BPM kick reads as 120, not 60', () => {
  assert.equal(MIN_REACT_FPS, 30);
  for (const fps of [15, 30, 60]) {
    const run = playTrack({ fps, track: danceTrack({ bpm: 120, busy: true }) });
    assert.ok(Math.abs(run.draws / 15 - fps) <= 1, `${fps}: ${run.draws / 15} drawn a second`);
    assert.ok(Math.abs(run.readings / 15 - Math.max(fps, MIN_REACT_FPS)) <= 1, `${fps}: reactor fed ${run.readings / 15} a second`);
    assert.ok(Math.abs(run.snapshot.bpm - 120) <= 2, `${fps} fps: ${run.snapshot.bpm} BPM`);
    assert.ok(run.snapshot.confidence >= 0.5, `${fps} fps: confidence ${run.snapshot.confidence}`);
  }
});

test('a steady tempo settles on itself within 10 s and stays, whatever the frame rate and where in the beat the music starts: 120 is never read as 60', () => {
  // A display at 58.86 Hz (29.4 fps at a 30 cap, as in the real window):
  // frames that do not divide the beat, so kicks are timed a frame early or
  // late in turn. The vote in 2-BPM bins (Psychedelia before 30e3c1e) read
  // these 120 as 60, slid between, or held 122; 140 as 71; 174 as 176.
  const runs = [
    ...[15, 30, 60].flatMap((fps) => [0.13, 0.41].map((phase) => ({ bpm: 120, fps, phase }))),
    { bpm: 120, fps: 30, phase: 0, refresh: 60 },
    ...[60, 90, 140, 174].map((bpm, index) => ({ bpm, fps: [15, 30, 60, 30][index], phase: 0.29 })),
  ];
  for (const { bpm, fps, phase, refresh = 58.86 } of runs) {
    const base = bassLineTrack({ bpm });
    const run = playTrack({ fps, refresh, seconds: 25, track: (time) => base(time + phase) });
    const label = `${bpm} BPM at ${fps} fps (display ${refresh} Hz), ${phase} s into the beat`;
    const after = run.bpmEachSecond.slice(9);
    assert.ok(after.length >= 15, label);
    for (const [index, read] of after.entries()) {
      assert.ok(Math.abs(read - bpm) <= 2, `${label}: ${read.toFixed(1)} BPM at ${index + 10} s (${run.bpmEachSecond.map(Math.round).join(' ')})`);
    }
  }
});

test('the strip\'s clock rate is the beat clock the scene gets: the tempo, halved while a scene shows it as a pulse', () => {
  const run = playTrack({ fps: 30, track: danceTrack({ bpm: 120, busy: true }), seconds: 8 });
  assert.ok(Math.abs(run.snapshot.bpm - 120) <= 2);
  assert.ok(Math.abs(run.snapshot.clock - 2) < 0.1, `clock ${run.snapshot.clock}/s with no pulse shown`);
  const shown = playTrack({
    fps: 30, track: danceTrack({ bpm: 120, busy: true }), seconds: 8, clockShown: true,
  });
  assert.ok(Math.abs(shown.snapshot.clock - 1) < 0.05, `${shown.snapshot.clock}: one cycle a second when shown`);
  assert.ok(Math.abs(shown.snapshot.bpm - 120) <= 2, 'the tempo shown is still the tempo heard');
});

/* ---------------- The volume slider does not starve the reactor ---------------- */

test('volumeGainDb: -20 log10(volume), capped at +40 dB (volume 0.01) and clamped below it', () => {
  assert.equal(MAX_VOLUME_GAIN_DB, 40);
  assert.equal(volumeGainDb(1), 0);
  assert.ok(Math.abs(volumeGainDb(0.5) - 6.0206) < 1e-3);
  assert.ok(Math.abs(volumeGainDb(0.1) - 20) < 1e-9);
  assert.ok(Math.abs(volumeGainDb(0.01) - 40) < 1e-9);
  assert.equal(volumeGainDb(0.001), 40, 'no more than the cap: near-silence is not blown up');
  assert.equal(volumeGainDb(0), 0, 'volume 0 is silence, never boosted (the signal rests anyway)');
  for (const odd of [NaN, undefined, null, -1, 2, 'x']) assert.equal(volumeGainDb(odd), 0, String(odd));
});

test('the signal frame carries the element volume (read per frame, nothing else read), and the meter gets the same values as before', () => {
  const runMeter = (getVolume) => {
    const h = createClockHarness();
    const vis = fakeVisibilityDoc();
    const node = simulatedAnalyser({ track: danceTrack({ bpm: 120, busy: true }), clock: h.io.clock, gain: 0.1 });
    let volumeReads = 0;
    const source = {
      isPlaying: () => true, isAudible: () => true, getAnalyser: () => node, release() {},
    };
    if (getVolume) source.getVolume = () => { volumeReads += 1; return getVolume(); };
    const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
    const seen = [];
    signal.subscribe((frame) => {
      seen.push({
        volume: frame.volume, bass: frame.bass, mid: frame.mid, high: frame.high, level: frame.level, spectrum: frame.spectrum.join(','),
      });
    }, { fps: 15 });
    h.run(2000);
    return { seen, volumeReads, reads: signal.stats.reads, byteCalls: node.byteCalls, floatCalls: node.floatCalls };
  };
  const without = runMeter(null);
  const with10 = runMeter(() => 0.1);
  assert.ok(without.seen.length >= 25);
  assert.ok(without.seen.every((frame) => frame.volume === 1), 'no getVolume: 1');
  assert.ok(with10.seen.every((frame) => frame.volume === 0.1));
  assert.equal(with10.volumeReads, with10.reads, 'read once per analyser read');
  assert.equal(with10.byteCalls, without.byteCalls, 'no extra analyser reads');
  assert.equal(with10.floatCalls, without.floatCalls);
  // What the meter reads is untouched by the volume.
  assert.deepEqual(
    with10.seen.map(({ volume, ...rest }) => rest),
    without.seen.map(({ volume, ...rest }) => rest),
  );
  // Odd answers fall back to full volume.
  for (const odd of [() => NaN, () => -1, () => { throw new Error('gone'); }]) {
    assert.ok(runMeter(odd).seen.every((frame) => frame.volume === 1));
  }
  assert.equal(runMeter(() => 3).seen[0].volume, 1, 'never above 1');
});

test('the adapter brings each frame back to full volume in its own arrays; the shared frame is left as it is', () => {
  const adapter = createAudioAdapter();
  const spectrumDb = Float32Array.from([-60, -80, Number.NEGATIVE_INFINITY]);
  const waveformFloat = Float32Array.from([0, 0.01, -0.01, 0.5]);
  const frame = {
    active: true,
    version: 1,
    time: 1,
    sampleRate: 48000,
    fftSize: 6,
    minDecibels: -85,
    maxDecibels: -15,
    spectrum: Uint8Array.from([90, 20, 0]),
    spectrumDb,
    waveform: Uint8Array.from([128, 129, 126, 192]),
    waveformFloat,
    volume: 0.1,
  };
  const before = { db: [...spectrumDb], wave: [...frame.waveform] };
  adapter.setFrame(frame);
  assert.ok(Math.abs(adapter.gainDb - 20) < 1e-9);
  const analysis = adapter.getAnalysis({ time: 1 });
  assert.notEqual(analysis.spectrumDb, spectrumDb);
  assert.ok(Math.abs(analysis.spectrumDb[0] + 40) < 1e-4 && Math.abs(analysis.spectrumDb[1] + 60) < 1e-4);
  assert.equal(analysis.spectrumDb[2], Number.NEGATIVE_INFINITY);
  assert.deepEqual([...analysis.waveform], [128, 140, 115, 255], 'x10 from the float samples, clipped like the byte read');
  assert.deepEqual([...spectrumDb], before.db, 'the frame\'s spectrum untouched');
  assert.deepEqual([...frame.waveform], before.wave, 'the frame\'s waveform untouched');
  // Full volume: the frame's own arrays, nothing copied.
  frame.volume = 1;
  const full = adapter.getAnalysis({ time: 2 });
  assert.equal(full.spectrumDb, spectrumDb);
  assert.equal(full.waveform, frame.waveform);
  // Far below the cap: +40 dB, no more.
  frame.volume = 0.0001;
  assert.ok(Math.abs(adapter.getAnalysis({ time: 3 }).spectrumDb[0] + 20) < 1e-4);
  // No float samples: the bytes are scaled about 128.
  frame.volume = 0.5;
  frame.waveformFloat = null;
  assert.deepEqual([...adapter.getAnalysis({ time: 4 }).waveform], [128, 130, 124, 255]);
});

test('the tester\'s 120 BPM track reads as 120 at volume 1.0, 0.12 and 0.03, and the reactor\'s band levels at 0.1 match full volume', () => {
  const track = () => bassLineTrack({ bpm: 120 });
  // Without the make-up the quiet one fell to 60 (the real-window finding).
  const starved = playTrack({ fps: 30, track: track(), gain: 0.03, reportVolume: false });
  assert.ok(Math.abs(starved.snapshot.bpm - 60) <= 2, `without make-up: ${starved.snapshot.bpm} BPM`);
  for (const gain of [1, 0.12, 0.03]) {
    const run = playTrack({ fps: 30, track: track(), gain });
    assert.ok(Math.abs(run.snapshot.bpm - 120) <= 2, `volume ${gain}: ${run.snapshot.bpm} BPM`);
    assert.ok(run.snapshot.confidence >= 0.5, `volume ${gain}: confidence ${run.snapshot.confidence}`);
  }
  const loud = playTrack({ fps: 30, track: track(), gain: 1, seconds: 8 });
  const soft = playTrack({ fps: 30, track: track(), gain: 0.1, seconds: 8 });
  for (const name of ['bass', 'mid', 'high']) {
    assert.ok(Math.abs(loud.bands[name] - soft.bands[name]) <= 0.02, `${name}: ${loud.bands[name]} at 1.0, ${soft.bands[name]} at 0.1`);
  }
  assert.ok(soft.bridge.adapter.stats.boosted > 0);
  assert.equal(loud.bridge.adapter.stats.boosted, 0);
});

/* ---------------- Starfield and Tunnel brightness ---------------- */

test('Starfield is a dark sky with small stars and Tunnel shows its walls, at Psychedelia\'s own defaults since 410e10c (CPU recompute at 1504x797 and 1280x720)', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl, mode: 'webgl2' });
  const load = async (id) => {
    const scene = SCENES.find((entry) => entry.id === id);
    const def = renderer.register(await scene.load(), id);
    return { scene, def, ours: sceneDefaults(def, scene.defaults), theirs: sceneDefaults(def) };
  };
  const star = await load('starfield');
  const tunnel = await load('tunnel');
  // The recompute follows the shipped shaders: the lines it copies are there.
  assert.ok(star.def.shader.includes('brightness += 3.0 * s * s / (d * d + s * s);'));
  assert.ok(star.def.shader.includes('brightness += trail * s * 20.0;'));
  assert.ok(tunnel.def.shader.includes('float val = (0.5 + 0.5 * pattern) * smoothstep(0.0, 0.3, dist);'));
  const fade = Number(/val \*= 1\.0 - exp\(-depth \* ([\d.]+)\);/.exec(tunnel.def.shader)?.[1]);
  assert.equal(fade, 2.5, 'Psychedelia\'s own depth fade, no import patch');
  // No overrides of ours any more.
  assert.equal(star.scene.defaults, null);
  assert.equal(tunnel.scene.defaults, null);
  assert.equal(star.theirs.star_size, 1.5);
  assert.equal(tunnel.theirs.rings, 5);
  for (const [W, H] of [[1504, 797], [1280, 720]]) {
    const sky = sceneLuminance('starfield', star.ours, { W, H, stride: 4 });
    assert.ok(sky.mean >= 0.05 && sky.mean <= 0.15, `starfield ${W}x${H}: mean luminance ${sky.mean}`);
    assert.ok(sky.clipped < 0.02, `starfield ${W}x${H}: ${sky.clipped} clipped, stars not blobs`);
    assert.ok(sky.clipped > 0.001, `starfield ${W}x${H}: star cores still reach full brightness`);
    const walls = sceneLuminance('tunnel', tunnel.ours, { W, H, stride: 4, depthFade: fade });
    assert.ok(walls.mean >= 0.2 && walls.mean <= 0.35, `tunnel ${W}x${H}: mean luminance ${walls.mean}`);
  }
  // The old fade, for the record: near black.
  const before = { W: 1504, H: 797, stride: 6 };
  assert.ok(sceneLuminance('tunnel', { ...tunnel.theirs, rings: 8 }, { ...before, depthFade: 0.1 }).mean < 0.06);
  renderer.destroy();
});

/* ---------------- Moving with the music ---------------- */

test('the zoom punch: from the limited kick and bass, capped and eased, and back to 1 at rest', () => {
  const limiter = createFlashLimiter();
  const quiet = {
    kick: 0, snare: 0, hat: 0, beat: 0, flash: 0, bass: 0, mid: 0, high: 0, level: 0, speed: 1,
  };
  let now = 0;
  const step = (input) => { now += 1 / 30; return limiter.step(now, input); };
  for (let i = 0; i < 30; i += 1) step(quiet);
  assert.equal(limiter.out.zoom, 1, 'no zoom without sound');
  // A kick: the zoom swells within a few frames, never past the cap.
  let most = 1;
  for (let i = 0; i < 10; i += 1) most = Math.max(most, step({ ...quiet, kick: i === 0 ? 1 : 0.9 ** i, bass: 0.5 }).zoom);
  assert.ok(most > 1.02, `kick zoom ${most}`);
  assert.ok(most <= FLASH_LIMITS.maxZoom + 1e-9);
  // Eased: never more than maxZoomSlew a second from one frame to the next.
  const limited = createFlashLimiter({ zoomPunch: 50 });
  let t = 0;
  let previous = 1;
  for (let i = 0; i < 30; i += 1) {
    t += 1 / 30;
    const { zoom } = limited.step(t, { ...quiet, kick: i % 15 === 0 ? 1 : 0, bass: 1 });
    assert.ok(Math.abs(zoom - previous) <= FLASH_LIMITS.maxZoomSlew / 30 + 1e-9, `step ${zoom - previous}`);
    assert.ok(zoom <= FLASH_LIMITS.maxZoom + 1e-9);
    previous = zoom;
  }
  for (let i = 0; i < 60; i += 1) step(quiet);
  assert.ok(Math.abs(limiter.out.zoom - 1) < 1e-6, 'back to 1');
  limiter.reset();
  assert.equal(limiter.out.zoom, 1);
});

test('the zoom punch reaches every scene through u_view_zoom', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 16, height: 9 }, gl, mode: 'webgl2' });
  // (Scenes that own their passes get it from the host:
  // tests/visualizer-slice14.test.js.)
  for (const scene of SCENES.filter((entry) => !entry.needs)) {
    renderer.useSceneNow(renderer.register(await scene.load(), scene.id));
    renderer.draw({ time: 1, audio: {}, beat: {}, zoom: 1.04 });
    assert.deepEqual(gl.uniforms.get('u_view_zoom'), [1.04], `${scene.id} reads the view zoom`);
    renderer.draw({ time: 1, audio: {}, beat: {} });
    assert.deepEqual(gl.uniforms.get('u_view_zoom'), [1], `${scene.id} at rest without one`);
  }
  renderer.destroy();
});

/** Psychedelia's paramLinkable (engine/audio-reactor.js): a param the shader
 *  multiplies by its clock is not linkable. */
function clockScaled(shader, name) {
  const clocks = ['u_time', 'u_unwrapped_time'];
  const re = /\bfloat\s+([A-Za-z_]\w*)\s*=\s*\(?\s*u_(?:unwrapped_)?time\b/g;
  let match;
  while ((match = re.exec(shader))) if (!clocks.includes(match[1])) clocks.push(match[1]);
  const names = clocks.join('|');
  const uniform = `u_${name}`;
  return new RegExp(`\\b(?:${names})\\s*[*/]\\s*\\(?\\s*${uniform}\\b|\\b${uniform}\\s*\\*\\s*\\(?\\s*(?:${names})\\b`).test(shader);
}

test('our link table: every \'links\' scene moves shape, size or colour with the music - never brightness, never a clock-scaled param - and the pushed values reach the shader', async () => {
  const gl = new FakeGL();
  const renderer = createSceneRenderer({ canvas: { width: 16, height: 9 }, gl, mode: 'webgl2' });
  const bridge = createReactorBridge({ EffectRegistry: renderer.engine.EffectRegistry });
  const sources = {
    kick: 0.6, snare: 0, hat: 0, beat: 0, bass: 0.3, mid: 0, high: 0, level: 0,
  };
  let kicked = 0;
  let tables = 0;
  for (const scene of SCENES) {
    if (scene.audio !== 'links') {
      assert.equal(scene.links, null, `${scene.id} reads the sound itself, or moves only with the time surge and zoom punch`);
      continue;
    }
    const def = renderer.register(await scene.load(), scene.id);
    assert.ok(scene.links.length >= 1, `${scene.id} has links`);
    const links = bridge.linksFor(def, scene);
    tables += 1;
    assert.equal(links.length, scene.links.length, `${scene.id}: every link usable`);
    assert.equal(new Set(links.map((row) => row.param)).size, links.length, `${scene.id}: one link per param`);
    kicked += links.some((row) => row.source === 'kick') ? 1 : 0;
    for (const row of links) {
      assert.equal(linkRuleViolation(def, def.params.find((p) => p.name === row.param)), null, `${scene.id}.${row.param} passes the rule`);
      assert.ok(!/glow|bright|exposure|intensity|lights|flash|contrast|gain/.test(row.param), `${scene.id}.${row.param} is not a light param`);
      assert.ok(!/speed|rate|spin|drift|rotation|depth|target|iter/.test(row.param), `${scene.id}.${row.param} is not a rate or a jump`);
      assert.ok(!clockScaled(def.shader, row.param), `${scene.id}.${row.param} is not multiplied by the clock`);
      assert.ok(!(def.specialize || []).includes(row.param), `${scene.id}.${row.param} is a uniform`);
      assert.ok(['kick', 'bass'].includes(row.source));
    }
    renderer.useSceneNow(def, links);
    renderer.draw({ time: 1, audio: {}, beat: {}, sources: null });
    const rest = new Map(links.map((row) => [row.param, gl.uniforms.get(`u_${row.param}`)[0]]));
    renderer.draw({ time: 1, audio: {}, beat: {}, sources });
    for (const row of links) {
      const base = rest.get(row.param);
      const moved = gl.uniforms.get(`u_${row.param}`)[0];
      assert.ok(moved <= row.max && moved >= row.min, `${scene.id}.${row.param} within range`);
      assert.ok((moved - base) / Math.abs(base) >= 0.025, `${scene.id}.${row.param}: ${base} -> ${moved} on a limited ${row.source}`);
    }
  }
  // Most move on the kick; a few have only a colour link on the bass.
  assert.ok(kicked >= tables - 2, `${kicked} of ${tables} move on the kick`);
  renderer.destroy();
});
