import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import {
  ALL_SCENE_FILES, BORROWED, FILES, LINE_FILES, LINE_GLOBALS, VENDOR_DIR, borrowedHeader,
} from '../scripts/import_psychedelia.mjs';
import {
  HELD_SCENE_ENTRIES, LINE_SCENE_ENTRIES, LINE_SCENES_RELEASED, SCENES, sceneById, sceneCappedParams, sceneCaps, sceneSimRate,
} from '../src/visualizer/scenes.js';
import { LINE_QUALITY_CAPS, LINE_SCENES_HELD, OFFERED_LINE_SCENES } from '../src/visualizer/line-scenes.js';
import {
  LINE_BACKGROUND_MOST, LINE_MAX_SEGMENTS, LINE_QUALITY, createLineGlowLines, lineLimits,
} from '../src/visualizer/line-host.js';
import {
  COMPILE_POLL_MS, SIM_PROGRAM, createSceneRenderer, drawable, ownsPasses,
} from '../src/visualizer/scene-renderer.js';
import { SIM_FIRST_DT, SIM_MAX_DT } from '../src/visualizer/sim-host.js';
import { sceneDriftPlan } from '../src/visualizer/drift.js';
import { sceneLooks } from '../src/visualizer/looks.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import loadGlowLines from '../src/visualizer/vendor/psychedelia/engine/glow-lines.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';
import { SimGL, withWebgl2Global } from './helpers/sim-fakes.js';

/* Psychedelia's seven line-drawing scenes (Fourier Epicycles, Hopf
   Fibration, Knots & Surfaces, Lissajous, Attractor Ribbons, 4D Polytopes,
   Spirograph) on the line host (line-host.js, over sim-host.js): what a
   visit makes is freed, the work a frame is limited by quality, nothing is
   made per frame, and the scenes are held out of the tab until released.
   No GPU; fake clocks. */

const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'manifest.json'), 'utf8'));
const IDS = Object.freeze(['epicycles', 'hopf', 'knots', 'lissajous', 'lorenz', 'polytopes', 'spirograph']);
// Offered since slice 15; the other two held (near black).
const RELEASED = Object.freeze(['hopf', 'knots', 'lissajous', 'lorenz', 'spirograph']);
const HELD = Object.freeze(['epicycles', 'polytopes']);
const SOURCES = Object.freeze({
  kick: 0.4, snare: 0.2, hat: 0.3, beat: 0.4, bass: 0.6, mid: 0.4, high: 0.2, level: 0.5, swell: 0.5,
});
const lineEntry = (id) => LINE_SCENE_ENTRIES.find((entry) => entry.id === id);

/** A WebGL 2 double that also records the segment uploads (the 5-argument
 *  bufferData: the array, and how many floats of it), the persistence
 *  target's size, and the clear colours. */
class LineGL extends SimGL {
  constructor(options) {
    super(options);
    this.uploads5 = [];
    this.targetSizes = [];
    this.clearColors = [];
  }

  bufferData(...args) {
    if (args.length === 5) this.uploads5.push({ data: args[1], length: args[4] });
    return super.bufferData(...args);
  }

  texImage2D(...args) {
    if (args.length === 9) this.targetSizes.push([args[3], args[4]]);
    return super.texImage2D(...args);
  }

  clearColor(...rgba) { this.clearColors.push(rgba); }
}

function lineRenderer(options = {}) {
  const canvas = { width: 160, height: 90 };
  const gl = options.gl || new LineGL({ canvas });
  const renderer = createSceneRenderer({
    canvas, gl, mode: 'webgl2', capsFor: sceneCaps, rateFor: sceneSimRate, random: seededRandom(5), ...options,
  });
  return { canvas, gl, renderer };
}

async function registered(renderer, id) {
  return renderer.register(await lineEntry(id).load(), id);
}

/** A line scene registered as the tab registers it, with the GlowLines the
 *  line host gave it (to read its stats). */
async function registeredWithLines(renderer, id) {
  const entry = lineEntry(id);
  const file = await import(`../src/visualizer/vendor/psychedelia/${entry.file}`);
  let lines = null;
  const def = renderer.register({
    default: (G) => {
      lines = createLineGlowLines(G, loadGlowLines);
      return file.default({ ...G, GlowLines: lines });
    },
  }, id);
  return { def, lines };
}

/** Draw `n` frames 1/30 s apart from `t` (returns the time reached). */
function frames(renderer, n, t = 0, extra = {}) {
  let time = t;
  for (let i = 0; i < n; i += 1) {
    time += 1 / 30;
    renderer.draw({ time, sources: SOURCES, zoom: 1, ...extra });
  }
  return time;
}

/* ---------------- The import ---------------- */

test('the import script vendors GlowLines and the seven line scenes (kept apart from the other scene files), each in the manifest, asking only for what the line host gives', () => {
  assert.deepEqual(LINE_FILES, ['epicycles', 'hopf', 'knots', 'lissajous', 'lorenz-attractor', 'polytopes', 'spirograph']);
  for (const name of LINE_FILES) assert.ok(!ALL_SCENE_FILES.includes(name), `${name}: not among the other scene files`);
  for (const target of [...LINE_FILES.map((name) => `effects/${name}.js`), 'engine/glow-lines.js']) {
    assert.ok(FILES.some((file) => file.target === target), `${target}: imported`);
    assert.ok(manifest.files.some((file) => file.target === target), `${target}: in the manifest`);
  }
  for (const name of LINE_FILES) {
    const text = readFileSync(join(VENDOR_DIR, 'effects', `${name}.js`), 'utf8');
    const needs = [...text.matchAll(/^var (\w+) = G\.\1;$/gm)].map((match) => match[1]);
    assert.ok(needs.includes('GlowLines'), name);
    assert.ok(needs.every((global) => LINE_GLOBALS.includes(global)), `${name}: ${needs.join(', ')}`);
    // Four took their own time step from the clock: they take the host's
    // (two patches each); the others are as Psychedelia has them.
    const patched = manifest.files.find((file) => file.target === `effects/${name}.js`).patches?.length || 0;
    assert.equal(patched, ['epicycles', 'hopf', 'knots', 'polytopes'].includes(name) ? 2 : 0, name);
    if (!patched) assert.ok(!/PATCHED on import/.test(text), `${name}: as Psychedelia has it`);
  }
  // Each line scene file is one entry, its file the vendored one.
  assert.deepEqual(LINE_SCENE_ENTRIES.map((entry) => entry.file.replace(/^effects[/]/, '').replace(/[.]js$/, '')).sort(), [...LINE_FILES].sort());
  assert.deepEqual(LINE_SCENE_ENTRIES.map((entry) => entry.id).sort(), [...IDS].sort());
});

test('GlowLines is patched only on import: its persistence target sized by the host, no array made per frame, its trails carried across a new size; its cosine palette credited', () => {
  const text = readFileSync(join(VENDOR_DIR, 'engine', 'glow-lines.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(text.includes('if (!ensureFbo(gl, TW, TH)) { if (!st.fbo) return; TW = st.w; TH = st.h; }'), 'on a failed new target it draws on at the old size');
  assert.match(text, /gl\.bindFramebuffer\(gl\.FRAMEBUFFER, st\.fbo\);\n\s+gl\.viewport\(0, 0, TW, TH\);/);
  assert.match(text, /gl\.bufferData\(gl\.ARRAY_BUFFER, v, gl\.DYNAMIC_DRAW, 0, count \* 24\);/);
  assert.doesNotMatch(text, /subarray/);
  const entry = manifest.files.find((file) => file.target === 'engine/glow-lines.js');
  assert.equal(entry.patches.length, 6);
  assert.ok(text.includes('gl.blitFramebuffer(0, 0, st.w, st.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);'), 'the trails are carried to a new size');
  const palette = BORROWED.find((piece) => piece.id === 'iq-palette');
  assert.ok(palette.files.includes('src/engine/glow-lines.js'));
  for (const line of borrowedHeader('src/engine/glow-lines.js')) assert.ok(text.includes(line), line);
  const credits = readFileSync(join(import.meta.dirname, '..', 'CREDITS.md'), 'utf8');
  const notices = readFileSync(join(import.meta.dirname, '..', 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const doc of [credits, notices].map((text) => text.replace(/\s+/g, ' '))) {
    assert.ok(doc.includes('src/engine/glow-lines.js'), 'the palette credit names GlowLines');
    assert.ok(/(lorenz-attractor\.js|Attractor Ribbons) follow Edward Lorenz/.test(doc), 'the attractors\' method is credited');
  }
});

/* ---------------- Held out of the tab ---------------- */

test('released: five offered with their measured settings; Fourier Epicycles and 4D Polytopes held (near black), offered nowhere', () => {
  assert.equal(LINE_SCENES_RELEASED, true);
  assert.deepEqual(OFFERED_LINE_SCENES.map((entry) => entry.id), RELEASED);
  assert.deepEqual(Object.keys(LINE_SCENES_HELD).sort(), HELD);
  for (const id of RELEASED) {
    assert.equal(sceneById(id), lineEntry(id), `${id}: found`);
    assert.ok(SCENES.includes(lineEntry(id)), `${id}: offered`);
  }
  for (const id of HELD) {
    assert.equal(sceneById(id), null, `${id}: not found`);
    assert.ok(!SCENES.some((entry) => entry.id === id), `${id}: not offered`);
  }
  // The speed caps measured (1.5x for Hopf and Knots), the usual effects
  // (0.024 a frame at most), drift only where it kept them over 0.05.
  const caps = Object.fromEntries(IDS.map((id) => [id, lineEntry(id).maxSpeed]));
  assert.deepEqual(caps, { epicycles: 1, hopf: 1.5, knots: 1.5, lissajous: 1, lorenz: 1, polytopes: 1, spirograph: 1 });
  assert.deepEqual(IDS.filter((id) => lineEntry(id).drift !== false), ['epicycles', 'knots', 'lissajous', 'polytopes']);
  // Lit: on the Nebula Glow background, with wider lines and more glow.
  for (const id of ['knots', 'lissajous', 'lorenz', 'spirograph']) assert.equal(lineEntry(id).defaults.background, 2, id);
  assert.equal(lineEntry('lorenz').defaults.width, 3.9);
  assert.equal(lineEntry('spirograph').defaults.trail_fade, 0.75);
  // Lifted so no stretch under 0.05 lasts more than about 2 s: Knots drawn
  // larger, Spirograph a little closer.
  assert.equal(lineEntry('knots').defaults.size, 1.25);
  assert.equal(lineEntry('spirograph').defaults.zoom, 1.2);
  for (const id of IDS) {
    assert.ok(!HELD_SCENE_ENTRIES.some((entry) => entry.id === id), `${id}: not among the held flights`);
    const entry = lineEntry(id);
    assert.equal(entry.cost, 'heavy', id);
    assert.equal(entry.fxNone, false, id);
    assert.equal(entry.fxCalm, false, id);
    assert.equal(entry.needs, 'webgl2', id);
    assert.equal(entry.links, null, id);
    assert.equal(entry.audio, 'shader', id);
    assert.ok(['calm', 'lively'].includes(entry.mood) && entry.hue === 'rainbow', id);
    assert.ok(Object.isFrozen(entry), id);
  }
  // The beat reaction at half where kicks flash the glow; 4D Polytopes keeps
  // one rotation (its own start swaps planes every 12 s, a jump of the whole figure).
  for (const id of ['epicycles', 'hopf', 'knots', 'polytopes']) assert.equal(lineEntry(id).defaults.audio_react, 0.5, id);
  assert.equal(lineEntry('polytopes').defaults.rotation_style, 0);
});

test('in the tab: a saved held line scene opens another; the list and the shuffle reach the released ones, never the held', async () => {
  await withWebgl2Global(async () => {
    const h = createClockHarness();
    const vis = fakeDocWithElements({});
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
    let current = normalizeSettings({ visualizerNoticeSeen: true, visualizerScene: 'epicycles', visualizerShuffle: 'all' });
    const gl = new LineGL();
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
    assert.ok(session.switcher.current, 'a scene is shown');
    assert.ok(!HELD.includes(session.switcher.current), session.switcher.current);
    const listed = session.sceneList.shown;
    assert.ok(listed.length > 70, 'the list is shown');
    for (const id of HELD) assert.ok(!listed.includes(id), `${id}: not listed`);
    for (const id of RELEASED) assert.ok(listed.includes(id), `${id}: listed`);
    const seen = new Set();
    for (let i = 0; i < 400; i += 1) seen.add(session.shuffle.next({ current: [...seen].at(-1) || null }));
    assert.ok(seen.size > 70, `the shuffle went round (${seen.size})`);
    for (const id of HELD) assert.ok(!seen.has(id), `${id}: never shuffled to`);
    session.destroy();
  });
});

test('their looks are their three palettes, all offered; drift moves shape and camera only, never brightness, speed or the attractor chaos', async () => {
  await withWebgl2Global(async () => {
    const { renderer } = lineRenderer();
    for (const id of IDS) {
      const def = await registered(renderer, id);
      assert.deepEqual(sceneLooks(def).map((look) => look.name), ['Rainbow', 'Neon', 'Ember'], id);
      const plan = sceneDriftPlan(def, { override: lineEntry(id).drift, capped: sceneCappedParams(id) });
      if (lineEntry(id).drift === false) assert.deepEqual(plan, [], id);
      else assert.ok(plan.length > 0, id);
      for (const wave of plan) {
        assert.ok(!['thickness', 'width', 'glow', 'trails', 'trail_fade', 'circles', 'chaos', 'speed', 'audio_react', 'background', 'palette'].includes(wave.name), `${id}: ${wave.name}`);
      }
      // A capped param is never drifted, should drift be turned on.
      for (const name of sceneCappedParams(id)) {
        assert.ok(!sceneDriftPlan(def, { capped: sceneCappedParams(id) }).some((wave) => wave.name === name), `${id}: ${name}`);
      }
    }
    renderer.destroy();
  });
});

/* ---------------- The host: what a visit makes ---------------- */

test('each line scene is drawn through the host: no compile of its own; its first frame draws into a target cleared to black', async () => {
  await withWebgl2Global(async () => {
    for (const id of IDS) {
      const { gl, renderer } = lineRenderer();
      const def = await registered(renderer, id);
      assert.ok(ownsPasses(def) && drawable(def), id);
      const prepared = renderer.prepare(def, lineEntry(id).defaults);
      assert.equal(renderer.compileNow(prepared), SIM_PROGRAM, id);
      renderer.useSceneNow(def, [], lineEntry(id).defaults);
      frames(renderer, 1);
      // The persistence target: made empty (no data) and cleared once, to black.
      assert.equal(gl.targetSizes.length, 1, `${id}: one target`);
      assert.deepEqual(gl.clearColors, [[0, 0, 0, 1]], `${id}: cleared to black, nothing brighter`);
      assert.equal(gl.clears, 1, id);
      assert.ok(gl.uploads5.length === 1 && gl.uploads5[0].length > 0, `${id}: drew its segments on the first frame`);
      renderer.destroy();
    }
  });
});

test('everything a visit makes is freed: on a change of scene, when the tab closes, and nothing is touched after a context loss', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = lineRenderer();
    const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
    renderer.useSceneNow(tunnel);
    frames(renderer, 2);
    const base = gl.aliveCounts();
    for (const id of IDS) {
      const def = await registered(renderer, id);
      renderer.useSceneNow(def, [], lineEntry(id).defaults);
      frames(renderer, 10);
      const during = gl.aliveCounts();
      // GlowLines: two programs, two buffers, the persistence texture and
      // framebuffer (the tunnel's program went when it did).
      assert.deepEqual(during, {
        Program: 2, Buffer: base.Buffer + 2, Texture: 1, Framebuffer: 1,
      }, id);
      renderer.useSceneNow(tunnel);
      assert.deepEqual(gl.aliveCounts(), base, `${id}: nothing left after a change of scene`);
      assert.equal(renderer.sim.active, false);
      assert.equal(renderer.sim.made, 0);
    }
    renderer.useSceneNow(await registered(renderer, 'lorenz'));
    frames(renderer, 5);
    renderer.destroy();
    assert.deepEqual(gl.aliveCounts(), {}, 'nothing at all after the tab closes');

    // A context loss: from the loss on, no call at all reaches the context
    // (GlowLines' cleanup is given the host's lost stand-in), nothing drawn.
    for (const id of IDS) {
      const lost = lineRenderer();
      lost.renderer.useSceneNow(await registered(lost.renderer, id));
      frames(lost.renderer, 4);
      const calls = [];
      const names = new Set();
      for (let at = lost.gl; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
        for (const name of Object.getOwnPropertyNames(at)) if (name !== 'constructor' && typeof lost.gl[name] === 'function') names.add(name);
      }
      for (const name of names) {
        const original = lost.gl[name];
        lost.gl[name] = (...args) => { calls.push(name); return original.apply(lost.gl, args); };
      }
      lost.gl.lost = true;
      lost.renderer.contextLost();
      assert.equal(lost.renderer.draw({ time: 9, sources: SOURCES, zoom: 1 }), false, 'nothing drawn while lost');
      assert.equal(lost.renderer.sim.active, false);
      assert.equal(lost.renderer.sim.made, 0);
      assert.deepEqual(calls.filter((name) => name !== 'isContextLost'), [], `${id}: no call to the lost context`);
    }
  });
});

test('after a context restore the next visit makes its own again and draws; no freed object is ever used', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = lineRenderer();
    const dead = [];
    for (const [name, kind] of [['bindTexture', 'Texture'], ['bindFramebuffer', 'Framebuffer'], ['useProgram', 'Program'], ['bindBuffer', 'Buffer']]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        const object = args[args.length - 1];
        if (object && !gl.alive[kind].has(object)) dead.push(name);
        return original(...args);
      };
    }
    const tunnel = renderer.register(await sceneById('tunnel').load(), 'tunnel');
    for (const id of IDS) {
      const def = await registered(renderer, id);
      for (let visit = 0; visit < 3; visit += 1) {
        renderer.useSceneNow(def);
        frames(renderer, 4);
        renderer.useSceneNow(tunnel);
      }
      assert.deepEqual(dead, [], `${id}: no freed object used`);
    }
    // Lost on a line scene, then restored: a fresh context's objects.
    const def = await registered(renderer, 'lorenz');
    renderer.useSceneNow(def);
    frames(renderer, 3);
    gl.lost = true;
    renderer.contextLost();
    for (const kind of Object.keys(gl.alive)) gl.alive[kind].clear(); // they went with the context
    gl.lost = false;
    assert.equal(renderer.restore(), 'lorenz');
    renderer.useSceneNow(def);
    const before = gl.uploads5.length;
    frames(renderer, 3);
    assert.equal(gl.uploads5.length - before, 3, 'it draws again');
    assert.deepEqual(dead, [], 'nothing of the lost context used');
    // GlowLines' two programs and two buffers, the renderer's new quad.
    assert.deepEqual(gl.aliveCounts(), {
      Program: 2, Buffer: 3, Texture: 1, Framebuffer: 1,
    });
    renderer.destroy();
    assert.deepEqual(gl.aliveCounts(), {});
  });
});

/* ---------------- Limits ---------------- */

test('the limits: the persistence target and the segments a frame by quality, never more than the ceiling; the step-down acts from the next frame', async () => {
  assert.deepEqual(Object.keys(LINE_QUALITY), ['low', 'medium', 'high']);
  for (const quality of ['low', 'medium', 'high']) {
    assert.ok(LINE_QUALITY[quality].segments <= LINE_MAX_SEGMENTS);
    assert.ok(LINE_QUALITY[quality].trailScale > 0 && LINE_QUALITY[quality].trailScale <= 1);
  }
  assert.ok(LINE_QUALITY.low.segments < LINE_QUALITY.medium.segments && LINE_QUALITY.medium.segments <= LINE_QUALITY.high.segments);
  assert.equal(lineLimits(null), LINE_QUALITY.medium, 'Medium before a quality is known');
  await withWebgl2Global(async () => {
    const { gl, renderer, canvas } = lineRenderer();
    renderer.setQuality('high');
    const def = await registered(renderer, 'lorenz');
    renderer.useSceneNow(def);
    let t = frames(renderer, 2);
    assert.deepEqual(gl.targetSizes.at(-1), [canvas.width, canvas.height]);
    // Its ribbon (6000 points by default) at High's cap.
    assert.equal(gl.uploads5.at(-1).length / 24, LINE_QUALITY_CAPS.lorenz.high.trail_length - 1);
    renderer.setQuality('low');
    t = frames(renderer, 1, t);
    assert.deepEqual(gl.targetSizes.at(-1), [Math.round(canvas.width * LINE_QUALITY.low.trailScale), Math.round(canvas.height * LINE_QUALITY.low.trailScale)]);
    assert.ok(gl.uploads5.at(-1).length / 24 <= LINE_QUALITY_CAPS.lorenz.low.trail_length);
    assert.ok(gl.uploads5.at(-1).length / 24 <= LINE_QUALITY.low.segments);
    // The target is resized, not added to.
    assert.equal(gl.aliveCounts().Texture, 1);
    renderer.destroy();
  });
});

test('a resize or a change of quality keeps the trails: the persistence picture is stretched into the new target before the old is freed', async () => {
  await withWebgl2Global(async () => {
    for (const id of IDS) {
      const { gl, renderer, canvas } = lineRenderer();
      renderer.setQuality('medium');
      renderer.useSceneNow(await registered(renderer, id), [], lineEntry(id).defaults);
      let t = frames(renderer, 4);
      gl.blits = [];
      canvas.width = 120;
      canvas.height = 70;
      t = frames(renderer, 1, t);
      const scale = LINE_QUALITY.medium.trailScale;
      assert.deepEqual(gl.blits.map((blit) => [blit.source, blit.dest]), [
        [[Math.round(160 * scale), Math.round(90 * scale)], [Math.round(120 * scale), Math.round(70 * scale)]],
      ], `${id}: carried on a resize`);
      gl.blits = [];
      renderer.setQuality('low');
      frames(renderer, 1, t);
      assert.equal(gl.blits.length, 1, `${id}: carried on a change of quality`);
      assert.equal(gl.aliveCounts().Texture, 1, `${id}: the old target freed`);
      assert.equal(gl.aliveCounts().Framebuffer, 1);
      renderer.destroy();
    }
  });
});

test('a new persistence target that cannot be made: the old one and its trails are kept, drawn on at the old size; nothing cleared on the screen; not tried again every frame', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer, canvas } = lineRenderer();
    renderer.setQuality('high');
    renderer.useSceneNow(await registered(renderer, 'lorenz'), [], lineEntry('lorenz').defaults);
    let t = frames(renderer, 4);
    const kept = { width: canvas.width, height: canvas.height };
    // From here a new framebuffer is incomplete (a failed allocation).
    gl.checkFramebufferStatus = () => 0;
    const clears = [];
    const clear = gl.clear.bind(gl);
    gl.clear = (mask) => { clears.push(gl.boundFramebuffer); return clear(mask); };
    const made = [];
    const createTexture = gl.createTexture.bind(gl);
    gl.createTexture = () => { const texture = createTexture(); made.push(texture); return texture; };
    gl.blits = [];
    const drawsBefore = gl.draws;
    canvas.width = 120;
    canvas.height = 70;
    t = frames(renderer, 3, t);
    assert.equal(made.length, 1, 'tried once, not every frame');
    assert.deepEqual(gl.aliveCounts().Texture, 1, 'the failed target freed, the old one kept');
    assert.equal(gl.aliveCounts().Framebuffer, 1);
    assert.deepEqual(gl.blits, [], 'nothing carried into a target that cannot be drawn into');
    assert.ok(!clears.includes(null), 'no clear reaches the screen');
    assert.ok(gl.draws > drawsBefore, 'the lines are still drawn');
    assert.deepEqual(gl.targetSizes.at(-1), [120, 70], 'the size tried');
    // Once a target can be made again, the next new size carries the trails.
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_COMPLETE;
    canvas.width = 100;
    canvas.height = 60;
    frames(renderer, 1, t);
    assert.deepEqual(gl.blits.map((blit) => [blit.source, blit.dest]), [[[kept.width, kept.height], [100, 60]]]);
    assert.equal(gl.aliveCounts().Texture, 1);
    renderer.destroy();
  });
});

test('they follow the music: the beat clock is the drift clock (bars x 4), the zoom punch reaches them', async () => {
  await withWebgl2Global(async () => {
    const { renderer } = lineRenderer();
    const def = await registered(renderer, 'hopf');
    renderer.useSceneNow(def);
    renderer.draw({ time: 1, sources: SOURCES, zoom: 1.04, drift: { bars: 7.5, scale: 0 } });
    assert.equal(renderer.sceneAudio.getBeatClock(), 30);
    assert.equal(renderer.sim.globals.Renderer.getEffectiveViewZoom(1), 1.04);
    renderer.draw({ time: 2, sources: SOURCES });
    assert.equal(renderer.sceneAudio.getBeatClock(), 4, 'without a drift clock: two a second of the scene clock');
    assert.equal(renderer.sim.globals.Renderer.getEffectiveViewZoom(2), 1);
    renderer.destroy();
  });
});

test('every scene stays within the segment limit at each quality, whatever its own settings ask', async () => {
  await withWebgl2Global(async () => {
    // Each scene's settings at their most (sizes, counts, lengths).
    for (const id of IDS) {
      for (const quality of ['low', 'medium', 'high']) {
        const { gl, renderer } = lineRenderer();
        renderer.setQuality(quality);
        const def = await registered(renderer, id);
        const most = {};
        for (const param of def.params) {
          if (Number.isFinite(param.max) && param.type !== 'select') most[param.name] = param.max;
        }
        renderer.useSceneNow(def, [], most);
        frames(renderer, 3);
        for (const upload of gl.uploads5) {
          assert.ok(upload.length / 24 <= LINE_QUALITY[quality].segments, `${id} at ${quality}: ${upload.length / 24}`);
        }
        renderer.destroy();
      }
    }
  });
});

test('with their own settings and every look, the quality caps keep each scene under the limit (nothing cut)', async () => {
  await withWebgl2Global(async () => {
    for (const id of IDS) {
      for (const quality of ['low', 'medium', 'high']) {
        const { renderer } = lineRenderer();
        renderer.setQuality(quality);
        const { def, lines } = await registeredWithLines(renderer, id);
        for (const look of sceneLooks(def)) {
          renderer.useSceneNow(def, [], { ...lineEntry(id).defaults, ...look.values });
          frames(renderer, 3);
        }
        assert.equal(lines.stats.cut, 0, `${id} at ${quality}`);
        assert.ok(lines.stats.segments > 0, `${id} at ${quality}: drawn`);
        renderer.destroy();
      }
    }
  });
});

test('the ceiling and the background: past the limit the rest is not drawn; no near-white background', () => {
  const made = [];
  const fake = (G) => ({
    GlowLines: {
      NATIVE_PALETTES: ['a'],
      BACKGROUNDS: ['b'],
      create: () => ({
        init() {}, cleanup() {}, getSegments: () => 0, hasResources: () => false,
        render: (gl, segs, count, opts) => made.push({ count, background: opts.background, scale: G.Renderer.getTrailScale() }),
      }),
    },
  });
  let quality = 'high';
  const lines = createLineGlowLines({ Renderer: { getCanvas: () => ({}), bindFramebuffer() {} }, sceneQuality: () => quality }, fake);
  const drawer = lines.create();
  const segs = new Float32Array(6);
  drawer.render(null, segs, 50000, { background: 3 });
  assert.deepEqual(made.at(-1), { count: LINE_MAX_SEGMENTS, background: LINE_BACKGROUND_MOST, scale: 1 });
  quality = 'low';
  drawer.render(null, segs, 50000, { background: 1 });
  assert.deepEqual(made.at(-1), { count: LINE_QUALITY.low.segments, background: 1, scale: LINE_QUALITY.low.trailScale });
  drawer.render(null, segs, 120, { background: 0 });
  assert.equal(made.at(-1).count, 120, 'under the limit: all of it');
  assert.deepEqual(lines.stats, { frames: 3, segments: 120, cut: 2 });
});

test('nothing is made per frame: each scene uploads from the same array frame after frame', async () => {
  await withWebgl2Global(async () => {
    for (const id of IDS) {
      const { gl, renderer } = lineRenderer();
      renderer.setQuality('high');
      const def = await registered(renderer, id);
      renderer.useSceneNow(def, [], lineEntry(id).defaults);
      frames(renderer, 90);
      const arrays = new Set(gl.uploads5.slice(5).map((upload) => upload.data));
      assert.equal(arrays.size, 1, `${id}: one vertex array (${arrays.size})`);
      assert.equal(gl.aliveCounts().Buffer, 3, `${id}: no buffer added (the quad and GlowLines' two)`);
      renderer.destroy();
    }
  });
});

test('time: at most 1/30 s a frame, so a stall or a hidden tab never makes a burst; a still frame draws the same picture', async () => {
  await withWebgl2Global(async () => {
    for (const id of IDS) {
      const { gl, renderer } = lineRenderer();
      const def = await registered(renderer, id);
      renderer.useSceneNow(def, [], lineEntry(id).defaults);
      const given = [];
      const render = def.render;
      def.render = (g, program, time, dt) => { given.push(dt); return render(g, program, time, dt); };
      let t = frames(renderer, 20);
      assert.equal(given[0], SIM_FIRST_DT, id);
      t += 20;
      renderer.draw({ time: t, sources: SOURCES, zoom: 1 });
      assert.equal(given.at(-1), SIM_MAX_DT, `${id}: clamped after a stall`);
      // A still frame: no time passes; the segments are the same as before.
      const last = gl.uploads5.at(-1);
      const before = Array.from(last.data.subarray(0, last.length));
      renderer.draw({ time: t, still: true, sources: SOURCES, zoom: 1 });
      assert.equal(given.at(-1), 0, id);
      const now = gl.uploads5.at(-1);
      assert.deepEqual(Array.from(now.data.subarray(0, now.length)), before, `${id}: the same picture`);
      renderer.destroy();
    }
  });
});

test('the scenes move by the host time step, not their own: a paused first frame turns nothing, a frame after a stall turns as far as a 1/30 s frame', async () => {
  await withWebgl2Global(async () => {
    const quiet = { ...SOURCES, kick: 0, bass: 0 };
    /** The segments the scene draws on its frames at `times` (still on the
     *  first when asked), with `overrides`: the last frame's, copied. */
    const drawn = async (id, times, { still = false, overrides = {} } = {}) => {
      const { gl, renderer } = lineRenderer();
      renderer.useSceneNow(await registered(renderer, id), [], { ...lineEntry(id).defaults, ...overrides });
      times.forEach((time, i) => renderer.draw({
        time, still: still && i === 0, sources: quiet, zoom: 1,
      }));
      const last = gl.uploads5.at(-1);
      const out = Array.from(last.data.subarray(0, last.length));
      renderer.destroy();
      return out;
    };
    const stopped = {
      epicycles: { speed: 0 }, hopf: { speed: 0, tumble: 0 }, knots: { speed: 0 }, polytopes: { speed: 0 },
    };
    const same = (a, b) => a.length > 0 && a.length === b.length && a.every((value, i) => value === b[i]);
    for (const id of ['epicycles', 'hopf', 'knots', 'polytopes']) {
      // A paused first frame: the same as the scene with its motion stopped.
      assert.ok(same(await drawn(id, [1], { still: true }), await drawn(id, [1], { still: true, overrides: stopped[id] })), `${id}: nothing turned`);
    }
    // After a 20 s stall: as far as one 1/30 s frame (the host's limit).
    // Hopf turns by the time step alone; Knots too once its tube strands
    // (which also wind round with the clock itself) are drawn as one line.
    // (Fourier Epicycles and 4D Polytopes also follow the clock itself, a
    // bar or a slow tilt.)
    for (const [id, overrides] of [['hopf', {}], ['knots', { tube: 0 }]]) {
      const stalled = await drawn(id, [1 / 30, 1 / 30 + 20], { overrides });
      assert.ok(same(stalled, await drawn(id, [1 / 30, 2 / 30], { overrides })), `${id}: one frame's turn`);
      // (A shorter frame turns less: the picture does show the step.)
      assert.ok(!same(stalled, await drawn(id, [1 / 30, 1 / 30 + 1 / 60], { overrides })), `${id}: a shorter step shows`);
    }
  });
});

test('Attractor Ribbons integrates a bounded number of steps a frame, however long the stall', async () => {
  await withWebgl2Global(async () => {
    const { renderer } = lineRenderer();
    renderer.setQuality('high');
    const def = await registered(renderer, 'lorenz');
    // Its trace speed at its most (4).
    renderer.useSceneNow(def, [], { speed: 4 });
    let t = frames(renderer, 3);
    // Each integration step takes one square root (its speed), and GlowLines
    // one a segment (the same each frame): an ordinary frame's count, then
    // one after a 60 s stall.
    const real = Math.sqrt;
    const counted = (time) => {
      let count = 0;
      Math.sqrt = (x) => { count += 1; return real(x); };
      try {
        renderer.draw({ time, sources: SOURCES, zoom: 1 });
      } finally {
        Math.sqrt = real;
      }
      return count;
    };
    t += 1 / 30;
    const ordinary = counted(t);
    t += 60;
    const stalled = counted(t);
    // 1/30 s x 60 x 20 x speed 4: 160 steps either way (one more or less
    // as the fraction carried over rounds).
    assert.ok(Math.abs(stalled - ordinary) <= 1, `ordinary ${ordinary}, after a stall ${stalled}`);
    assert.ok(ordinary > 160 && ordinary < 160 + LINE_QUALITY_CAPS.lorenz.high.trail_length + 2, String(ordinary));
    renderer.destroy();
  });
});

test('with no line scene shown nothing of the line host runs: a shader scene draws without it, and after a line scene nothing of it is left', async () => {
  await withWebgl2Global(async () => {
    const { gl, renderer } = lineRenderer();
    const plasma = renderer.register(await sceneById('plasma').load(), 'plasma');
    renderer.useSceneNow(plasma);
    const alive = gl.aliveCounts();
    frames(renderer, 60);
    assert.equal(gl.uploads5.length, 0);
    assert.deepEqual(gl.targetSizes, []);
    assert.deepEqual(gl.aliveCounts(), alive);
    const { def, lines } = await registeredWithLines(renderer, 'spirograph');
    renderer.useSceneNow(def);
    frames(renderer, 5);
    assert.equal(lines.stats.frames, 5);
    renderer.useSceneNow(plasma);
    const uploads = gl.uploads5.length;
    frames(renderer, 60);
    assert.equal(lines.stats.frames, 5, 'not drawn again');
    assert.equal(gl.uploads5.length, uploads);
    assert.deepEqual(gl.aliveCounts(), alive, 'nothing of it left');
    renderer.destroy();
  });
});
