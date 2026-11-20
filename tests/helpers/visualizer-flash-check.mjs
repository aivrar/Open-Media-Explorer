#!/usr/bin/env node
/**
 * Flash and brightness check for every Visualizer scene, run by hand (it is
 * slow and needs a browser, so it is not part of `npm test`):
 *
 *   node tests/helpers/visualizer-flash-check.mjs [out.json] [--worst] [--looks]
 *        [--seconds=N] [--fps=N] [--seed=N] [--quality=low|medium|high] [sceneId ...]
 *   python tests/helpers/visualizer-flash-check.py out.json [width height]
 *
 * Run it as the real window draws: on the graphics card, at the tab's size
 * (Medium quality in a 1920 x 1080 window draws about 1504 x 797):
 *   python ... out.json 1504 797 --gpu
 * The size changes the figures little (Mandelbrot 0.088 at 1504 x 797 and
 * 0.089 at 320 x 180), but SwiftShader (the default, and the cost measure)
 * draws some scenes' sin-based noise differently from a real card: Aurora
 * came out at mean 0.09 there and 0.25 on the card, with steps of 0.125
 * only on the card. The check must pass on the card.
 *
 * --worst: the Beat Reactor's time surge is held at its most (3x) all the
 * time, as a bass-heavy stream does (the tester's real 120 BPM stream drove
 * Mandelbrot to 3 steps over 0.10 a second this way, while the synthetic
 * track barely surged). The limiter still caps it, at the scene's own
 * maxSpeed (scenes.js) where it has one: this is the case that must pass.
 *
 * --all-looks: as --looks, with the looks left out (looks.js LOOKS_LEFT_OUT,
 *   PRESETS_LEFT_OUT) too, to look at them again.
 * --looks: every look of each scene too (looks.js: its colour schemes), as
 * "id#n" entries (n the look's number, as saved) after the scene's own (the
 * sound path is the same; only the look's values differ; they share the
 * scene's frames, framesOf).
 *
 * --seconds=N: record N seconds (default 6). The long check is 120 or more:
 * a fractal's dive goes through whole cycles (Mandelbrot's in the real
 * window pulsed at 3.5 Hz only once deep in a dive), and the Python half
 * then reports every 10-s window, with the dominant frequency of the mean
 * luminance and any oscillation of 3 Hz or more (up to half the frame rate)
 * whose peak to peak passes 0.10. --fps=N: frames a second (default 30, the
 * tab's Medium; 60 sees oscillations up to 30 Hz). --seed=N: the scene's
 * random seeds (u_seed, u_seed_vec) as the tab draws them from a seeded
 * random (they pick where each dive goes); default the fixed ones before.
 * --speed-cap=N: the time surge capped at N instead of the scene's own
 * maxSpeed (to find the cap a new scene needs: 3, 2, 1.5, 1.25, 1).
 * --quality=Q: the values as the tab draws them at that quality (scenes.js
 * SCENE_QUALITY_CAPS: the heaviest scenes' own detail lowered); default
 * none applied (not what the tab draws: it always has a quality). Applied
 * last, as scene-renderer.js draw does each frame: to the base values and
 * to every frame's sound-linked values (scenes.js cappedValues), so a linked
 * value never goes past a cap. The setUniforms hook gets the values before
 * the caps, as in the renderer. The Python half prints the quality and size
 * it drew at.
 *
 * --drift: slow drift on (drift.js), at its deepest (the swell and the
 * mood at their most: DRIFT_CHECK_SCALE), its clock at its fastest (the
 * top of DRIFT_BPM_RANGE, whatever the track); each frame carries the
 * drifted params with the linked ones. The scene's own plan (scenes.js
 * SCENE_DRIFT, else the automatic choice; its waves are fixed by the ids,
 * as in the tab). A look's frames are worked out again around the look's
 * values. --looks-seconds=N: each look's frames only the first N
 * seconds (two full DRIFT_WRAP_BARS cycles at the fastest clock are
 * about 103 s), the scene's own the whole recording.
 * --clock-stretch=N: record N seconds of the scene's clock at its speed cap
 * (N / cap seconds; 360 is the stretch the speed caps were set over: 120 s
 * at 3x, 360 s at 1x), in place of --seconds.
 *
 * This half plays a synthetic 120 BPM dance track (tests/helpers/audio-sim.js)
 * through the app's real sound path for each scene - the shared signal, the
 * loop at 30 frames a second, Psychedelia's Beat Reactor and the flash
 * limiter - and records, frame by frame, every value the scene's shader gets:
 * time, u_audio, u_beat, the zoom punch and each linked param. It writes the
 * scene's final shader text with them. The Python half renders those frames
 * in headless Chromium (software WebGL) and reports per scene the mean
 * luminance, the largest frame-to-frame luminance step, steps over 0.10 per
 * second, and the time a frame took (a rough cost measure).
 *
 * Scenes are prepared exactly as the tab does: Psychedelia's defaults with
 * scenes.js `defaults` on top, and the links from scenes.js / the link rule.
 */

import { writeFileSync } from 'node:fs';

import { createAudioSignal } from '../../src/lib/audio-signal.js';
import { createVisualizerLoop } from '../../src/visualizer/loop.js';
import { applyLinks, createReactorBridge, sceneLinks } from '../../src/visualizer/reactor.js';
import { createSceneRenderer, readsBeatClock } from '../../src/visualizer/scene-renderer.js';
import {
  ACCUMULATING_SCENE_ENTRIES, HELD_SCENE_ENTRIES, LINE_SCENE_ENTRIES, OWN_SCENE_ENTRIES, SCENES, cappedValues, sceneCappedParams,
} from '../../src/visualizer/scenes.js';
import {
  DRIFT_BPM_RANGE, applyDrift, createDriftClock, driftScale, sceneDriftPlan,
} from '../../src/visualizer/drift.js';
import { MOOD_STRENGTH } from '../../src/visualizer/mood.js';
import { FLASH_LIMITS } from '../../src/visualizer/flash-limiter.js';
import { sceneLooks } from '../../src/visualizer/looks.js';
import { createClockHarness, fakeVisibilityDoc } from './signal-harness.js';
import { FakeGL } from './visualizer-fakes.js';
import { seededRandom } from '../../src/visualizer/shuffle.js';
import { danceTrack, simulatedAnalyser } from './audio-sim.js';

/** The uniforms a scene's own setUniforms hook sets (Strange Attractor
 *  Flight's trajectory table, u_attr_points and u_attr_count), as
 *  { name: number | number[] }, or null: the Python half sets them too, so it
 *  draws what the tab draws. They depend on the scene's values only. */
export function hookUniforms(def, values) {
  if (typeof def?.setUniforms !== 'function') return null;
  const out = {};
  const put = (where, value) => { if (where) out[where.name] = typeof value === 'number' ? value : Array.from(value); };
  const g = {
    uniform1f: put, uniform1i: put, uniform2fv: put, uniform3fv: put, uniform4fv: put,
  };
  def.setUniforms(g, {}, values, (program, name) => ({ name }), 0);
  return Object.keys(out).length ? out : null;
}

/** A per-frame reader of what scene `def`'s setUniforms hook sets: its
 *  plain numbers, called as scene-renderer.js draw calls it (after the
 *  values, with the frame's values and clock); null without a hook. A hook
 *  that follows the music (Cymatics) moves them from frame to frame; arrays
 *  (Strange Attractor's fed path) stay in hookUniforms. */
export function hookFrames(def) {
  if (typeof def?.setUniforms !== 'function') return null;
  let out = null;
  const put = (where, value) => { if (where && typeof value === 'number') out[where.name] = +value.toFixed(5); };
  const g = {
    uniform1f: put, uniform1i: put, uniform2fv() {}, uniform3fv() {}, uniform4fv() {},
  };
  return (values, time) => {
    out = {};
    def.setUniforms(g, {}, values, (program, name) => ({ name }), time);
    return Object.keys(out).length ? out : undefined;
  };
}

/** Drift at its deepest: the swell and the mood at their most. */
export const DRIFT_CHECK_SCALE = driftScale(1, Math.max(...Object.values(MOOD_STRENGTH)));

const WARM_UP_MS = 3000;
const RECORD_MS = 6000;
const FPS = 30;

/** The frames scene `entry` would get from a 120 BPM track. */
export function recordScene(renderer, entry, def, {
  recordMs = RECORD_MS, worst = false, fps = FPS, lean = false, speedCap = null, drift = false,
} = {}) {
  const prepared = renderer.prepare(def, entry.defaults || null);
  const links = sceneLinks(def, entry);
  // Slow drift: the scene's plan, its clock, and per frame what a look needs
  // to work its own values out again (the clock, and the sources its links read).
  const plan = drift ? sceneDriftPlan(def, { override: entry.drift, capped: sceneCappedParams(entry.id) }) : [];
  // At its fastest from the start: the top tempo it follows, as its idle.
  const driftClock = createDriftClock({ idleBpm: DRIFT_BPM_RANGE[1] });
  const driftBase = {};
  const frameBars = [];
  const frameSources = [];
  const shown = [...new Set([...links.map((link) => link.param), ...plan.map((item) => item.name)])];
  const h = createClockHarness();
  const vis = fakeVisibilityDoc();
  const node = simulatedAnalyser({ track: danceTrack({ bpm: 120, busy: true }), clock: h.io.clock });
  const source = {
    isPlaying: () => true, isAudible: () => true, getAnalyser: () => node, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const bridge = createReactorBridge();
  // A hook that reads the Beat Reactor reads this one, as in the tab.
  renderer.setAudioReactor?.(bridge.reactor);
  const hookFrame = hookFrames(def);
  // A visit starts as the tab starts it (install runs the scene's init:
  // Cymatics begins at its first pattern).
  if (hookFrame && typeof def.init === 'function') def.init(null);
  // A scene that owns its passes (sim-host.js) has no single shader: the
  // Python half draws it with the app's own renderer and host, frame by
  // frame from these frames' clock, sources and drift.
  const sim = Boolean(prepared.sim);
  bridge.setClockShown(sim ? false : readsBeatClock(prepared.sources.frag));
  bridge.setSpeedCap(speedCap || entry.maxSpeed);
  if (worst) bridge.reactor.getSpeed = () => 3;
  const frames = [];
  let pulsesBefore = 0;
  let wrapsBefore = 0;
  const scratch = {};
  const loop = createVisualizerLoop({
    signal,
    fps,
    react: bridge.react,
    draw: (state) => {
      const { pulses, clockWraps } = bridge.limiter.stats;
      const pulse = pulses > pulsesBefore ? 1 : 0;
      const wrap = clockWraps > wrapsBefore ? 1 : 0;
      pulsesBefore = pulses;
      wrapsBefore = clockWraps;
      // (Stepped for every simulation too: the line-drawing scenes take
      // their beats from it, at its fastest pace here.)
      if (plan.length || sim) driftClock.step(state.dt, 0);
      if (h.now < WARM_UP_MS) return;
      const base = plan.length ? applyDrift(prepared.values, plan, driftClock.bars, DRIFT_CHECK_SCALE, driftBase) : prepared.values;
      const values = applyLinks(base, links, state.sources, scratch);
      if (plan.length) {
        frameBars.push(driftClock.bars);
        frameSources.push(Object.fromEntries(links.map((link) => [link.source, Number(state.sources?.[link.source]) || 0])));
      }
      frames.push({
        // An envelope pulse let through, a shown clock's wrap charged, since the last frame.
        pulse,
        wrap,
        t: +state.time.toFixed(4),
        audio: [state.audio.bass, state.audio.mid, state.audio.high, state.audio.level].map((v) => +v.toFixed(4)),
        beat: [state.beat.kick, state.beat.snare, state.beat.hat, state.beat.clock].map((v) => +v.toFixed(4)),
        zoom: +state.zoom.toFixed(4),
        linked: Object.fromEntries(shown.map((param) => [param, +values[param].toFixed(5)])),
        // What the scene's hook sets this frame (hookFrames), drawn after the values.
        hook: hookFrame ? hookFrame(values, state.time) : undefined,
        // What links and post effects read (visualizer-fx-check.*); not
        // kept in a lean (long) recording, which draws scenes only.
        sources: sim
          ? Object.fromEntries(Object.entries(state.sources || {})
            .filter(([, value]) => Number.isFinite(Number(value)))
            .map(([name, value]) => [name, +Number(value).toFixed(4)]))
          : lean ? undefined : Object.fromEntries(['kick', 'snare', 'hat', 'beat', 'bass', 'mid', 'high', 'level']
            .map((name) => [name, +(Number(state.sources?.[name]) || 0).toFixed(4)])),
        // The drift clock's bars (a simulation's drift is worked out in the
        // page by the renderer itself, as in the tab, and the line-drawing
        // scenes read their beats from it, drift or not).
        bars: sim ? +driftClock.bars.toFixed(5) : undefined,
      });
    },
    doc: vis.doc,
    win: {},
    ...h.io,
  });
  loop.start();
  signal.refresh();
  h.run(WARM_UP_MS + recordMs);
  loop.destroy();
  renderer.setAudioReactor?.(null);
  return {
    id: entry.id,
    name: entry.name,
    cost: entry.cost,
    vert: sim ? null : prepared.sources.vert,
    frag: sim ? null : prepared.sources.frag,
    // Drawn by the app's renderer in the page: the scene's own overrides
    // (scenes.js defaults; a look's values on top), its drift on or off.
    ...(sim ? { sim: true, overrides: { ...(entry.defaults || {}) }, driftOn: plan.length > 0, driftScale: DRIFT_CHECK_SCALE } : {}),
    values: prepared.values,
    uniforms: hookUniforms(def, prepared.values),
    links: links.map(({ param, source, amount }) => ({ param, source, amount })),
    drift: plan.map(({ name, depth, period }) => ({ param: name, depth, period })),
    fps,
    frames,
    /** The frames' drifted and linked values worked out around `values`
     *  (a look's), or null with no drift (the scene's frames serve). */
    linkedFor(values) {
      if (!plan.length) return null;
      const out = {};
      const at = {};
      return frames.map((frame, index) => {
        const drifted = applyDrift(values, plan, frameBars[index], DRIFT_CHECK_SCALE, at);
        applyLinks(drifted, links, frameSources[index], out);
        return { ...frame, linked: Object.fromEntries(shown.map((param) => [param, +out[param].toFixed(5)])) };
      });
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const worst = args.includes('--worst');
  const allLooks = args.includes('--all-looks');
  // The held extra looks too (looks.js EXTRA_LOOKS).
  const heldLooks = args.includes('--held-looks');
  const looks = allLooks || heldLooks || args.includes('--looks');
  const option = (name) => { const arg = args.find((a) => a.startsWith(`--${name}=`)); return arg ? Number(arg.split('=')[1]) : null; };
  const seconds = option('seconds');
  const fps = option('fps') || FPS;
  const seed = option('seed');
  const drift = args.includes('--drift');
  const stretch = option('clock-stretch');
  const looksSeconds = option('looks-seconds');
  const qualityArg = args.find((a) => a.startsWith('--quality='));
  const quality = qualityArg ? qualityArg.split('=')[1] : null;
  const [out = 'visualizer-flash-frames.json', ...only] = args.filter((arg) => !arg.startsWith('--'));
  const long = Boolean((seconds && seconds > 12) || stretch);
  const renderer = createSceneRenderer({ canvas: { width: 8, height: 8 }, gl: new FakeGL(), mode: 'webgl2' });
  const scenes = [];
  // Held scenes (scenes.js HELD_SCENES, the line-drawing scenes until
  // released) only when named.
  const lineHeld = [...LINE_SCENE_ENTRIES, ...OWN_SCENE_ENTRIES, ...ACCUMULATING_SCENE_ENTRIES].filter((entry) => !SCENES.includes(entry));
  for (const entry of [...SCENES, ...HELD_SCENE_ENTRIES, ...lineHeld]) {
    if (only.length ? !only.includes(entry.id) : !SCENES.includes(entry)) continue;
    const def = renderer.register(await entry.load(), entry.id);
    const cap = option('speed-cap') || entry.maxSpeed || FLASH_LIMITS.maxSpeed;
    const recordSeconds = stretch ? stretch / cap : seconds;
    const recorded = recordScene(renderer, entry, def, {
      worst, fps, lean: long, speedCap: option('speed-cap'), drift, ...(recordSeconds ? { recordMs: recordSeconds * 1000 } : {}),
    });
    const { linkedFor } = recorded;
    delete recorded.linkedFor;
    // The caps last, over the linked values too (the renderer caps what it
    // sets each frame, linked or not); frames are shared with the looks.
    const base = recorded.values;
    recorded.quality = quality;
    if (quality) {
      recorded.values = cappedValues(entry.id, quality, recorded.values);
      for (const frame of recorded.frames) frame.linked = cappedValues(entry.id, quality, frame.linked);
    }
    if (seed !== null) {
      // As scene-renderer.js install(): random() * 1000 and four randoms.
      const random = seededRandom(seed);
      recorded.seed = random() * 1000;
      recorded.seedVec = [random(), random(), random(), random()];
    }
    scenes.push(recorded);
    if (looks) {
      sceneLooks(def, { all: allLooks, held: heldLooks }).forEach((look) => {
        if (!Object.keys(look.values).length) return;
        const uncapped = { ...base, ...look.values };
        const values = quality ? cappedValues(entry.id, quality, uncapped) : uncapped;
        if (Object.keys(look.values).every((name) => base[name] === look.values[name])) return;
        // The scene's own frames (the Python half looks them up): no copy;
        // with drift, frames of its own, drifted around the look's values.
        const { frames, ...rest } = recorded;
        // (A simulation's drift is worked out in the page: its frames serve.)
        let own = recorded.sim ? null : linkedFor(uncapped);
        if (looksSeconds) own = (own || frames).slice(0, Math.round(looksSeconds * fps));
        if (own && quality) own = own.map((frame) => ({ ...frame, linked: cappedValues(entry.id, quality, frame.linked) }));
        // A look that changes a param compiled into the shader (a 3D
        // flight's mode) has its own shader text.
        const compiled = (def.specialize || []).some((name) => name in look.values && look.values[name] !== base[name]);
        const shader = compiled ? renderer.prepare(def, { ...(entry.defaults || {}), ...look.values }).sources : null;
        scenes.push({
          ...rest,
          uniforms: hookUniforms(def, uncapped),
          ...(shader ? { vert: shader.vert, frag: shader.frag } : {}),
          ...(recorded.sim ? { overrides: { ...(entry.defaults || {}), ...look.values } } : {}),
          id: `${entry.id}#${look.number}`,
          name: `${entry.name}: ${look.name}`,
          values,
          ...(own ? { frames: own } : { framesOf: entry.id }),
        });
      });
    }
    process.stdout.write(`${entry.id} `);
  }
  writeFileSync(out, JSON.stringify(scenes));
  console.log(`\n${scenes.length} scenes -> ${out}`);
}

if (process.argv[1] && /visualizer-flash-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) await main();
