/* The browser half of visualizer-fx-check.py: draws each scene live from the
   app's own sound path and flash limiter, through the app's own fx-chain.js
   (charging its trigger firings to that limiter) and fx-reactions.js, and
   measures the luminance of every frame on the screen. Loaded as a module from the
   check's local server; not part of the app.
   Overlays (run.overlays): the app's own overlay-layer.js with its flash gate
   on the same limiter; the top sheet is laid over the picture as the
   compositor does (source-over) before the luminance is measured, the blended
   one goes through the chain. Cost runs (run.cost) time each frame instead.
   run.motion: the sheets move (overlay-motion.js) at the drift check's depth,
   the drift clock at the top of its range; the top sheet is laid over with
   its CSS transform, as the compositor would. */

import loadPostFx from '../../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import loadPalettes from '../../src/visualizer/vendor/psychedelia/engine/palettes.js';
import { fxCatalog } from '../../src/visualizer/fx-catalog.js';
import { createFxChain } from '../../src/visualizer/fx-chain.js';
import { createGlobalReactions } from '../../src/visualizer/fx-reactions.js';
import { TRIGGER_IDLE_AGE } from '../../src/visualizer/fx-chain.js';
import { FLASH_LIMITS } from '../../src/visualizer/flash-limiter.js';
import { createAudioSignal } from '../../src/lib/audio-signal.js';
import { createVisualizerLoop } from '../../src/visualizer/loop.js';
import { applyLinks, createReactorBridge } from '../../src/visualizer/reactor.js';
import {
  DRIFT_BPM_RANGE, applyDrift, createDriftClock, driftScale,
} from '../../src/visualizer/drift.js';
import { MOOD_STRENGTH } from '../../src/visualizer/mood.js';
import { readsBeatClock } from '../../src/visualizer/scene-renderer.js';
import { cappedValues } from '../../src/visualizer/scenes.js';
import { createClockHarness, fakeVisibilityDoc } from './signal-harness.js';
import loadOverlays from '../../src/visualizer/vendor/psychedelia/engine/overlays.js';
import { createFlashGate, createOverlayLayer } from '../../src/visualizer/overlay-layer.js';
import { overlayRow } from '../../src/visualizer/overlay-catalog.js';
import { danceTrack, simulatedAnalyser } from './audio-sim.js';
import './luma-meter.js';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: false, antialias: false });
let syncTex = null; // cost runs: the top sheet copied here to wait for its drawing
let topFull = null; // flash runs: the top sheet stretched to the picture's size
let topFullCtx = null;
// The mean luminance summed on the graphics card (luma-meter.js); the old
// read-back path when window.lumaReadback is set or float targets are missing.
let meterMade = null;
const lumaMeter = () => {
  if (window.lumaReadback) return null;
  if (meterMade === null) meterMade = window.createLumaMeter(gl) || false;
  return meterMade || null;
};
// The palettes as the tab gives them (the Palette Map pass).
const { PsyPalettes } = loadPalettes({});
const { PostFxLibrary } = loadPostFx({ PsyPalettes });
const byId = new Map(fxCatalog(PostFxLibrary, PsyPalettes).map((fx) => [fx.id, fx]));
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

let scenes = [];
const programs = new Map();

function program(scene) {
  if (programs.has(scene.id)) return programs.get(scene.id);
  const shader = (type, src) => {
    const made = gl.createShader(type);
    gl.shaderSource(made, src);
    gl.compileShader(made);
    if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made));
    return made;
  };
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, scene.vert));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, scene.frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const made = { p, pos: gl.getAttribLocation(p, 'a_position'), at: new Map() };
  programs.set(scene.id, made);
  return made;
}

/** One frame of `scene` into the bound framebuffer, set as the renderer does. */
function drawScene(scene, made, frame, W, H) {
  gl.useProgram(made.p);
  const L = (name) => {
    if (!made.at.has(name)) made.at.set(name, gl.getUniformLocation(made.p, name));
    return made.at.get(name);
  };
  const f1 = (name, v) => { const at = L(name); if (at) gl.uniform1f(at, v); };
  const setValue = (k, v) => {
    const at = L(`u_${k}`);
    if (!at) return;
    if (typeof v === 'number') gl.uniform1f(at, v);
    else if (v.length === 2) gl.uniform2fv(at, v);
    else if (v.length === 3) gl.uniform3fv(at, v);
    else if (v.length === 4) gl.uniform4fv(at, v);
  };
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  if (made.pos >= 0) {
    gl.enableVertexAttribArray(made.pos);
    gl.vertexAttribPointer(made.pos, 2, gl.FLOAT, false, 0, 0);
  }
  if (L('u_resolution')) gl.uniform2f(L('u_resolution'), W, H);
  if (L('u_mouse')) gl.uniform2f(L('u_mouse'), 0.5, 0.5);
  f1('u_global_rotation', 0); f1('u_view_zoom_speed', 0.7); f1('u_view_zoom_depth', 0); f1('u_seed', 300.123);
  if (L('u_seed_vec')) gl.uniform4f(L('u_seed_vec'), 0.3, 0.6, 0.2, 0.8);
  f1('u_time', frame.t); f1('u_unwrapped_time', frame.t); f1('u_view_zoom', frame.zoom);
  if (L('u_audio')) gl.uniform4f(L('u_audio'), ...frame.audio);
  if (L('u_beat')) gl.uniform4f(L('u_beat'), ...frame.beat);
  // Every value as the renderer sets it: the sound-linked ones in, the
  // quality's caps applied last (frame.values, built in the draw below).
  for (const [k, v] of Object.entries(frame.values)) setValue(k, v);
  // Then what the scene's own setUniforms hook sets (visualizer-flash-check.mjs
  // hookUniforms; Strange Attractor's fed path), arrays included, as
  // scene-renderer.js draw calls it after the values.
  for (const [k, v] of Object.entries(scene.uniforms || {})) {
    const at = L(k) || L(`${k}[0]`);
    if (!at) continue;
    if (typeof v === 'number') gl.uniform1f(at, v);
    else if (v.length === 2) gl.uniform2fv(at, v);
    else if (v.length === 4) gl.uniform4fv(at, v);
    else gl.uniform3fv(at, new Float32Array(v));
  }
  gl.viewport(0, 0, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

window.setScenes = (list) => { scenes = list; return scenes.length; };

/* The sound, live: the app's own path (the simulated 120 BPM track ->
   audio-signal.js -> loop.js -> the Beat Reactor -> the flash limiter) on a
   fake clock, as visualizer-flash-check.mjs records it, but here in the same
   page as the FX chain, which charges its trigger firings to that same
   limiter. Every large change is counted from what is drawn. */
const WARM_UP_MS = 3000;
const FPS = 30;
const FAMILY = { kick: 'low', beat: 'low', snare: 'mid', hat: 'high', flash: 'flash' };

// What the GPU is given: u_age per program. A trigger fired when its age
// drops (or first comes in below idle).
let ages = new Map();
let firedSeen = false;
let usedProgram = null;
const uniformNames = new WeakMap();
// The blended overlay's uploads: their count and time (CPU, the call itself).
const upload = { count: 0, ms: 0 };
{
  const texImage2D = gl.texImage2D.bind(gl);
  gl.texImage2D = (...args) => {
    if (args.length !== 6) return texImage2D(...args);
    const t0 = performance.now();
    texImage2D(...args);
    upload.ms += performance.now() - t0;
    upload.count += 1;
    return undefined;
  };
}
{
  const useProgram = gl.useProgram.bind(gl);
  const getUniformLocation = gl.getUniformLocation.bind(gl);
  const uniform1f = gl.uniform1f.bind(gl);
  gl.useProgram = (p) => { usedProgram = p; useProgram(p); };
  gl.getUniformLocation = (p, name) => {
    const at = getUniformLocation(p, name);
    if (at) uniformNames.set(at, name);
    return at;
  };
  gl.uniform1f = (at, value) => {
    if (at && uniformNames.get(at) === 'u_age') {
      const before = ages.get(usedProgram);
      if (before === undefined ? value < TRIGGER_IDLE_AGE - 1 : value < before - 1e-9) firedSeen = true;
      ages.set(usedProgram, value);
    }
    uniform1f(at, value);
  };
}

/** One run: the scene's clip with the run's effects. Returns the luminance of
 *  every frame, the time a frame took to draw, and the most large changes of
 *  light (envelope pulses, shown clock wraps, trigger firings) in a rolling
 *  second. */
window.runOne = async (run, clip, W, H) => {
  // Overlays that place things at random (Bokeh, Particles, ...) draw the
  // same in every run: Math.random seeded afresh for each one.
  let seed = 0x2f6b1a3d;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  canvas.width = W;
  canvas.height = H;
  const scene = scenes[run.scene];
  const made = program(scene);
  // The quality drawn: the run's, or Medium (the app's default), as for the
  // overlay layer below; reported with each run.
  const quality = run.quality || 'medium';
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const node = simulatedAnalyser({ track: danceTrack({ bpm: 120, busy: true }), clock: h.io.clock });
  const source = {
    isPlaying: () => true, isAudible: () => true, getAnalyser: () => node, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const bridge = createReactorBridge();
  const clockShown = readsBeatClock(scene.frag);
  bridge.setClockShown(clockShown);
  bridge.setSpeedCap(scene.maxSpeed);
  bridge.reactor.getSpeed = () => 3; // the time surge at its most (the recordings' "worst")
  const chain = createFxChain({ gl, mode: 'webgl2', charge: () => bridge.charge() });
  const passes = run.fx.map((item) => ({ ...item, fx: byId.get(item.id) })).filter((item) => item.fx);
  chain.setPasses(passes);
  // Overlays, as the tab draws them (index.js syncOverlays).
  const overlays = run.overlays || [];
  let layer = null;
  let gate = null;
  let top = null;
  let topCtx = null;
  let lastSources = null;
  if (overlays.length) {
    top = document.createElement('canvas');
    // Empty until drawn, as the tab makes it (index.js overlayCanvas).
    top.width = 0;
    top.height = 0;
    gate = createFlashGate({ reactor: () => bridge.reactor, charge: () => bridge.charge(), sources: () => lastSources });
    layer = createOverlayLayer({
      topCanvas: top,
      makeCanvas: () => {
        // run.cpuSheet: the blend sheet drawn in memory (willReadFrequently), for
        // comparing its upload with the default (drawn on the graphics card).
        const sheet = document.createElement('canvas');
        if (run.cpuSheet) sheet.getContext('2d', { willReadFrequently: true });
        return sheet;
      },
      loadModule: async () => ({ default: loadOverlays }), gate,
      // run.noHalo: timed without the line overlays' halo and the laser beams
      // (Psychedelia's own lines): their share of the cost.
      ...(run.noHalo ? { halos: {}, beams: false } : {}),
    });
    layer.setHue(run.hue ?? 200);
    layer.resize(W, H, quality);
    layer.set(overlays, { now: true });
    while (layer.loading) await new Promise((resolve) => { setTimeout(resolve, 5); });
    chain.setOverlay(() => layer.blendSheet);
    topCtx = top.getContext('2d');
  }
  // Programs link without blocking (KHR_parallel_shader_compile): the sound
  // starts once every pass is ready.
  const linkStart = performance.now();
  while (chain.linking && performance.now() - linkStart < 20000) {
    chain.poll();
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  chain.poll();
  // As the tab does (index.js updateClockShown).
  bridge.setTriggersOn(chain.usesClock || overlays.some((item) => overlayRow(item.id)?.flash === 'trigger'));
  upload.count = 0;
  upload.ms = 0;
  let overlayMs = 0;
  let syncMs = 0; // cost runs: the same wait again with nothing new drawn (the measuring's own share)
  let admittedSeen = 0;
  let uncounted = 0; // luminance steps over 0.10 on frames with no charged change
  const px1 = new Uint8Array(4);
  const reactions = createGlobalReactions();
  const meter = run.cost ? null : lumaMeter();
  const px = meter ? null : new Uint8Array(W * H * 4);
  const lumas = [];
  const changes = [];
  const armed = {};
  const familyAt = {};
  for (const name of Object.keys(FAMILY)) armed[name] = true;
  let lastClock = Number.NaN;
  const scratch = {};
  // Slow drift (run.drift): at its deepest, its clock at its fastest; the
  // chain reads state.drift, the scene's values are drifted here, and links
  // get the whole swell (as in the tab with drift faded in).
  const driftClock = createDriftClock({ idleBpm: DRIFT_BPM_RANGE[1] });
  bridge.setSwellShare(run.drift ? 1 : 0);
  const drift = { bars: 0, scale: run.drift ? driftScale(1, Math.max(...Object.values(MOOD_STRENGTH))) : 0 };
  const motionDepth = run.motion ? driftScale(1, Math.max(...Object.values(MOOD_STRENGTH))) : 0;
  let motionClock = 0;
  const drifted = {};
  const from = WARM_UP_MS + (run.from * 1000) / FPS;
  let drawMs = 0;
  // Envelope pulses: the limiter's limited output, as the picture gets it (a
  // family's edges within the coincidence window are one hit, as the limiter
  // counts them); seen on the frame drawn with it.
  let pulseSeen = false;
  const step = bridge.limiter.step;
  bridge.limiter.step = (now, input) => {
    const out = step(now, input);
    for (const name of Object.keys(FAMILY)) {
      if (out[name] < FLASH_LIMITS.rearmLevel) armed[name] = true;
      else if (armed[name] && out[name] >= FLASH_LIMITS.pulseThreshold) {
        armed[name] = false;
        if (!(now - (familyAt[FAMILY[name]] ?? -Infinity) <= FLASH_LIMITS.coincidenceSeconds)) { familyAt[FAMILY[name]] = now; pulseSeen = true; }
      }
    }
    return out;
  };
  // Trigger firings: the u_age each effect program is given (watchAges).
  firedSeen = false;
  ages = new Map();
  const loop = createVisualizerLoop({
    signal,
    fps: FPS,
    react: bridge.react,
    draw: (state) => {
      if (run.drift || run.motion) motionClock = driftClock.step(state.dt, 0);
      if (run.drift) drift.bars = motionClock;
      state.drift = drift;
      if (h.now < from || lumas.length >= clip) { pulseSeen = false; return true; }
      const t = h.now / 1000;
      let changed = pulseSeen;
      pulseSeen = false;
      // The beat clock's wraps, as the scene is given it, when it shows it.
      const clock = state.beat.clock;
      if (clockShown && Number.isFinite(lastClock) && Math.floor(clock) > Math.floor(lastClock)) changed = true;
      lastClock = clock;
      const t0 = performance.now();
      if (layer) {
        // Once a frame, in real time (the fake clock is the check's real time).
        lastSources = state.sources;
        const o0 = performance.now();
        layer.render(t, state.dt, state.sources);
        // The sheets' motion, as the tab moves them after drawing (index.js).
        layer.move(motionClock, motionDepth);
        if (run.cost && top.width) {
          // Its drawing done, read without getImageData (Chrome moves a 2D
          // canvas read back often off the graphics card, which the tab never
          // does): the sheet copied on the card into a texture, then one pixel
          // of the WebGL canvas read, which waits for that copy and so for the
          // sheet's drawing.
          const sync = () => {
            if (!syncTex) syncTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, syncTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, top);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
          };
          sync();
          overlayMs += performance.now() - o0;
          const s0 = performance.now();
          sync();
          syncMs += performance.now() - s0;
        } else overlayMs += performance.now() - o0;
        if (gate.stats.admitted !== admittedSeen) { admittedSeen = gate.stats.admitted; changed = true; }
      }
      // As scene-renderer.js draw: the values with the sound's links, then
      // the caps of the quality drawn last (scenes.js cappedValues), so a
      // linked value never draws more detail than the app would.
      const base = run.drift && scene.drift?.length ? applyDrift(scene.values, scene.drift, drift.bars, drift.scale, drifted) : scene.values;
      const linked = scene.links.length ? applyLinks(base, scene.links, state.sources, scratch) : base;
      const frame = {
        t: state.time,
        audio: [state.audio.bass, state.audio.mid, state.audio.high, state.audio.level],
        beat: [state.beat.kick, state.beat.snare, state.beat.hat, state.beat.clock],
        zoom: state.zoom,
        values: cappedValues(scene.id, quality, linked),
      };
      const target = chain.active ? chain.begin(W, H) : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      drawScene(scene, made, frame, W, H);
      if (target) {
        chain.setReactions(reactions.step(state.sources, run.intensity, run.flash, state.dt));
        chain.finish(state);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (run.cost) {
        // Timing only: one pixel read waits for the frame's drawing.
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
        drawMs += performance.now() - t0;
        lumas.push(0);
        return true;
      }
      // The top sheet over the picture, as the compositor lays it
      // (source-over, its opacity the layer's fade), at the picture's size
      // as the browser stretches it (it may be drawn smaller:
      // OVERLAY_TOP_MAX_PIXELS), with its CSS transform when it moves.
      let sheet = null;
      let k = 1;
      if (layer && !top.hidden && top.width) {
        const m = layer.motion;
        k = Math.max(0, Math.min(1, Number(top.style.opacity === '' ? 1 : top.style.opacity)));
        if (top.width === W && top.height === H && !m.moving) sheet = top;
        else {
          // Read back only on the old path (getImageData); kept on the
          // graphics card otherwise.
          if (!topFull) { topFull = document.createElement('canvas'); topFullCtx = topFull.getContext('2d', meter ? {} : { willReadFrequently: true }); }
          if (topFull.width !== W || topFull.height !== H) { topFull.width = W; topFull.height = H; }
          topFullCtx.clearRect(0, 0, W, H);
          topFullCtx.imageSmoothingEnabled = true;
          if (m.moving) {
            // As the CSS transform lays it: about the centre, moved, turned, scaled.
            topFullCtx.translate(W / 2 + m.dx * W, H / 2 + m.dy * H);
            topFullCtx.rotate(m.angle);
            topFullCtx.scale(m.scale, m.scale);
            topFullCtx.drawImage(top, -W / 2, -H / 2, W, H);
            topFullCtx.setTransform(1, 0, 0, 1, 0, 0);
          } else topFullCtx.drawImage(top, 0, 0, W, H);
          sheet = topFull;
        }
      }
      let luma;
      if (meter) {
        // Summed on the graphics card; a small float target read back.
        luma = meter.measure(W, H, sheet, k);
        drawMs += performance.now() - t0;
      } else {
        // The old path (window.lumaReadback): every pixel read back and
        // added up here.
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        drawMs += performance.now() - t0;
        let s = 0;
        if (sheet) {
          const over = (sheet === top ? topCtx : topFullCtx).getImageData(0, 0, W, H).data;
          for (let y = 0; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
              const i = (y * W + x) * 4;
              const j = ((H - 1 - y) * W + x) * 4;
              const a = (over[j + 3] / 255) * k;
              const r = px[i] * (1 - a) + over[j] * a;
              const g = px[i + 1] * (1 - a) + over[j + 1] * a;
              const b = px[i + 2] * (1 - a) + over[j + 2] * a;
              s += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }
          }
        } else {
          for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        }
        luma = s / (W * H * 255);
      }
      if (firedSeen) changed = true;
      firedSeen = false;
      if (changed) changes.push(t);
      if (lumas.length && Math.abs(luma - lumas[lumas.length - 1]) > 0.10 && !changed) uncounted += 1;
      lumas.push(luma);
      return true;
    },
    doc: vis.doc,
    win: {},
    ...h.io,
  });
  loop.start();
  signal.refresh();
  for (let guard = 0; lumas.length < clip && guard < 2000; guard += 1) h.run(100);
  loop.destroy();
  const ms = drawMs / Math.max(1, lumas.length);
  const failed = chain.stats.failed;
  const drawnCount = chain.drawnIds.length;
  const { triggers, triggersRefused } = chain.stats;
  let most = 0;
  for (let at = 0; at < changes.length; at += 1) {
    let end = at;
    while (end < changes.length && changes[end] - changes[at] < 1 - 1e-9) end += 1;
    most = Math.max(most, end - at);
  }
  const { overlayUploads, overlaySkipped, overlayDraws } = chain.stats;
  const overlayStats = layer ? {
    overlayMs: overlayMs / Math.max(1, lumas.length),
    syncMs: syncMs / Math.max(1, lumas.length),
    topSize: top ? [top.width, top.height] : null,
    uploadMs: upload.ms / Math.max(1, upload.count),
    uploads: upload.count,
    overlayUploads,
    overlaySkipped,
    overlayDraws,
    hits: gate.stats.hits,
    admitted: gate.stats.admitted,
    refused: gate.stats.refused,
    uncounted,
    blendSize: layer.blendSheet ? [layer.blendSheet.canvas.width, layer.blendSheet.canvas.height] : null,
  } : {};
  layer?.destroy();
  chain.destroy();
  return {
    lumas, ms, failed, drawn: drawnCount, asked: passes.length, triggers, triggersRefused, mostPerSecond: most, ...overlayStats,
    quality, size: [W, H],
  };
};

window.fxReady = true;
