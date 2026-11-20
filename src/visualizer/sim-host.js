/**
 * The host for scenes that own their passes: Psychedelia's GPU simulations
 * (Curl-Noise Silk, Fluid Ink, Lenia, Physarum) and its frame-feedback
 * scenes (through shadertoy-adapter.js). Such a scene keeps render targets
 * (ping-pong pairs, float textures) and programs of its own and draws them
 * in its render(gl, program, time, dt); upstream that runs on Psychedelia's
 * renderer and GpuSim. Here the scene renderer (scene-renderer.js) hands
 * them to this host, which gives them what they expect:
 *
 *   - a record of what the scene makes (createTexture, createFramebuffer,
 *     createProgram, createBuffer, ...; only its create calls are wrapped,
 *     every other call goes straight to the context): when the scene
 *     goes (a change of scene, the tab closing, the context lost) the
 *     scene's own cleanup runs first, then anything it left is deleted, so
 *     no texture, framebuffer, buffer or program outlives its visit
 *     (GpuSim's program cache finds them gone and builds them again on the
 *     next visit);
 *   - stand-ins for Psychedelia's Renderer (bindFramebuffer(-1) is the
 *     picture the tab draws into: the screen, or the FX chain's target), its
 *     Controls (the scene's values as drawn: drifted, linked, capped), the
 *     Beat Reactor's sources (getSource: the flash limiter's output, as the
 *     links read it) and a Math whose random() is seeded each visit (the
 *     flash check draws a visit exactly as the tab does);
 *   - a stand-in for the mouse that stirs Fluid Ink: a slow path round the
 *     middle, wider with the swell, quicker on kicks; deterministic, no
 *     pointer listeners;
 *   - at most SIM_MAX_DT of simulated time a frame: a stall, a hidden tab or
 *     the time surge never makes a burst of catch-up steps (each scene's
 *     own step loop is bounded by the time it is given). Nothing runs while
 *     the picture is still: a still frame (paused, reduced motion) is drawn
 *     with no time passed, so no step is taken, and nothing at all runs
 *     while the tab is closed or no such scene is shown.
 *
 * Float render targets: the simulations need WebGL 2 with
 * EXT_color_buffer_float (Psychedelia's GpuSim and Physarum check for it),
 * Reaction-Diffusion half floats at least; simSupport() asks once per
 * context (two getExtension calls) and the tab leaves the scenes out of the
 * list and the shuffle where they cannot be drawn.
 *
 * Nothing here makes anything on the graphics card until such a scene is
 * installed; with none shown it costs nothing.
 */

/** The most simulated time one frame may advance (seconds). */
export const SIM_MAX_DT = 1 / 30;
/** The time given to a visit's first frame (its seeding frame). */
export const SIM_FIRST_DT = 1 / 60;

/** The kinds of objects a scene can make, as WebGL names them
 *  (create<Kind>, is<Kind>, delete<Kind>). */
const KINDS = Object.freeze(['Texture', 'Framebuffer', 'Renderbuffer', 'Buffer', 'Program', 'Shader', 'VertexArray', 'Query', 'Sampler', 'TransformFeedback']);

/** What a scene's cleanup is given after a context loss: a context whose
 *  objects are all gone (is<Kind> false, delete<Kind> nothing), so the
 *  cleanup only drops its references and no call reaches the lost context. */
const LOST_CONTEXT = Object.freeze(Object.fromEntries([
  ['isContextLost', () => true],
  ...KINDS.flatMap((kind) => [[`is${kind}`, () => false], [`delete${kind}`, () => {}]]),
]));

/** What `gl` can draw: { webgl2, float, half }. Two getExtension calls,
 *  made once per context by the caller. */
export function simSupport(gl, mode) {
  const out = { webgl2: mode === 'webgl2' && Boolean(gl), float: false, half: false };
  if (!out.webgl2) return out;
  try { out.float = Boolean(gl.getExtension('EXT_color_buffer_float')); } catch (_) {}
  try { out.half = out.float || Boolean(gl.getExtension('EXT_color_buffer_half_float')); } catch (_) {}
  return out;
}

/** Can a scene that needs `needs` be drawn with `support`? */
export function simSupported(needs, support) {
  if (!support?.webgl2) return false;
  if (needs === 'float') return support.float;
  if (needs === 'half') return support.half;
  return true;
}

/** A small seeded generator (mulberry32): 0 <= x < 1. */
export function seededSim(seed) {
  let a = (Math.floor(seed * 4294967296) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Record on `made` ([kind, object]) every object made on `gl` by a create
 *  call while `recording()` is true (the scene's own calls: not the tab's
 *  FX chain or overlays, which share the context). Only the create calls
 *  are wrapped, on the context object itself; every other call is the
 *  context's own, at no cost. Returns a function that takes the wrappers
 *  off again. */
export function recordCreates(gl, made, recording) {
  const wrapped = [];
  for (const kind of KINDS) {
    const name = `create${kind}`;
    const original = gl[name];
    if (typeof original !== 'function') continue;
    const own = Object.prototype.hasOwnProperty.call(gl, name);
    gl[name] = function create(...args) {
      const object = original.apply(gl, args);
      if (object && recording()) made.push([kind, object]);
      return object;
    };
    wrapped.push([name, own, original]);
  }
  return () => {
    for (const [name, own, original] of wrapped) {
      if (own) gl[name] = original;
      else delete gl[name];
    }
  };
}

/**
 * @param {object} options
 * @param {WebGL2RenderingContext} options.gl
 * @param {HTMLCanvasElement} options.canvas
 * @param {string} options.mode
 * @param {function} options.random  the renderer's: seeds each visit
 */
export function createSimHost({
  gl, canvas, mode, random = Math.random,
}) {
  let context = gl;
  let support = null; // asked once per context (supportNow)
  const made = []; // [kind, object] made this visit
  let unwrap = null; // takes the create wrappers off (made with the first visit)
  let inScene = 0; // inside the scene's own init, render or cleanup
  let lostCleanup = false; // a cleanup after a loss: the scene sees LOST_CONTEXT
  let visit = null; // { def, rng, seed, seedVec, last, time, target, values, sources, mouse, phase }
  const stats = {
    visits: 0, frames: 0, steps: 0, released: 0, freed: 0, clamped: 0,
  };

  const mouse = { x: 0.5, y: 0.5 };
  const Renderer = Object.freeze({
    getGL: () => (lostCleanup ? LOST_CONTEXT : sceneGL()),
    getCanvas: () => canvas,
    getMode: () => mode,
    isContextLost: () => lostCleanup || !context || context.isContextLost?.() === true,
    /** -1: the picture the tab draws into (the screen or the FX chain's). */
    bindFramebuffer(index) {
      if (!context) return;
      context.bindFramebuffer(context.FRAMEBUFFER, index < 0 ? (visit?.target ?? null) : null);
    },
    getMouse: () => mouse,
    getSeed: () => visit?.seed ?? 0,
    getSeedVec: () => visit?.seedVec ?? [0.3, 0.6, 0.2, 0.8],
    getUnwrappedTime: () => visit?.time ?? 0,
    getViewZoom: () => visit?.zoom ?? 1,
    /** The zoom punch as the line-drawing scenes read it. */
    getEffectiveViewZoom: () => visit?.zoom ?? 1,
    getViewZoomSpeed: () => 0.7,
    getViewZoomDepth: () => 0,
    getRotation: () => 0,
    /** Steps a second for the frame-feedback scenes (scenes.js simRate). */
    getStepRate: () => visit?.rate ?? 60,
    /** The picture time this frame moved on by (0 on a still frame; at
     *  most SIM_MAX_DT): for the density host (density-host.js). */
    getFrameStep: () => visit?.step ?? 0,
  });
  const Controls = Object.freeze({ getValues: () => visit?.values || {} });
  const SimMath = Object.create(Math, {
    random: { value: () => (visit ? visit.rng() : Math.random()) },
  });

  function sceneGL() {
    if (!unwrap && context) unwrap = recordCreates(context, made, () => inScene > 0);
    return context;
  }

  /** Run one of the scene's own calls, recording what it makes. */
  function inside(call) {
    inScene += 1;
    try { return call(sceneGL()); } finally { inScene -= 1; }
  }

  /** The beat sources as Psychedelia's AudioReactor.getSource gives them. */
  function getSource(id) {
    const value = Number(visit?.sources?.[id]);
    return Number.isFinite(value) ? value : 0;
  }

  /** Free what the visit made: its cleanup, then anything left. `lost`: the
   *  context went, so its objects went with it (nothing is deleted). */
  function release(lost = false) {
    const ending = visit;
    visit = null;
    if (ending) {
      stats.released += 1;
      if (typeof ending.def.cleanup === 'function') {
        if (lost) {
          // Its references only: nothing reaches the lost context.
          lostCleanup = true;
          try { ending.def.cleanup(LOST_CONTEXT); } catch (_) {}
          lostCleanup = false;
        } else {
          try { inside((g) => ending.def.cleanup(g)); } catch (_) {}
        }
      }
    }
    const g = context;
    const gone = lost || !g || g.isContextLost?.() === true;
    if (lost) { made.length = 0; return; }
    const touched = Boolean(ending) || made.length > 0;
    for (const [kind, object] of made) {
      if (gone) continue;
      try {
        if (g[`is${kind}`](object)) { g[`delete${kind}`](object); stats.freed += 1; }
      } catch (_) {}
    }
    made.length = 0;
    if (!gone && touched) {
      try {
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.useProgram(null);
        g.disable(g.BLEND);
      } catch (_) {}
    }
  }

  /** Drop the record of objects already deleted (a scene that rebuilt its
   *  targets on a change of size), so the list stays short. */
  function prune() {
    if (made.length < 256 || !context) return;
    const live = made.filter(([kind, object]) => {
      try { return context[`is${kind}`](object); } catch (_) { return false; }
    });
    made.length = 0;
    made.push(...live);
  }

  /** Move the stand-in mouse: round the middle, its reach widening with the
   *  swell (0.1 to 0.32 of the picture), a turn every ~25 s, quicker for a
   *  moment on a kick. Only the clock and the sources move it. */
  function stir(dt, sources) {
    const kick = Number(sources?.kick) || 0;
    const swell = Number(sources?.swell) || 0;
    visit.phase += dt * (0.25 + 1.2 * Math.min(1, Math.max(0, kick)));
    const reach = 0.1 + 0.22 * Math.min(1, Math.max(0, swell));
    const aspect = canvas.width / Math.max(1, canvas.height);
    mouse.x = 0.5 + (reach * Math.cos(visit.phase)) / Math.max(1, aspect);
    mouse.y = 0.5 + reach * Math.sin(visit.phase * 1.3);
  }

  return {
    /** What scenes are given through G (with the registry): stand-ins for
     *  Renderer, Controls and Math; getSource joins the renderer's
     *  AudioReactor stand-in. */
    globals: { Renderer, Controls, Math: SimMath },
    getSource,
    stats,
    /** The context's float support (asked once; again after a restore). */
    support() {
      if (!support) support = simSupport(context, mode);
      return support;
    },
    get active() { return Boolean(visit); },
    /** Objects made this visit and not freed yet (for tests). */
    get made() { return made.length; },
    get mouse() { return { ...mouse }; },

    /** A scene that owns its passes starts: a fresh visit. `rate`: steps
     *  a second for a frame-feedback scene (60 when not given). */
    start(def, rate = null) {
      release();
      visit = {
        def,
        rng: seededSim(random()),
        seed: random() * 1000,
        seedVec: [random(), random(), random(), random()],
        last: null,
        time: 0,
        zoom: 1,
        target: null,
        values: null,
        sources: null,
        phase: 0,
        rate: Number(rate) > 0 ? Number(rate) : 60,
        step: 0,
      };
      mouse.x = 0.5;
      mouse.y = 0.5;
      stats.visits += 1;
      if (typeof def.init === 'function') inside((g) => def.init(g));
    },

    /** One frame of the scene: `values` as drawn, into `target` (null: the
     *  screen). The time given is what passed since its last frame, at most
     *  SIM_MAX_DT; none for a still picture (its first frame too). */
    draw(state, values, target) {
      if (!visit || !context) return false;
      const time = Number(state.time) || 0;
      let dt = visit.last === null ? SIM_FIRST_DT : time - visit.last;
      // A still picture (paused, reduced motion) takes no step, its first
      // frame included: that draws the scene's starting picture only.
      if (state.still) dt = 0;
      if (!(dt > 0)) dt = 0;
      if (dt > SIM_MAX_DT) { dt = SIM_MAX_DT; stats.clamped += 1; }
      visit.last = time;
      visit.time = time;
      visit.step = dt;
      visit.zoom = state.zoom > 0 ? state.zoom : 1;
      visit.target = target;
      visit.values = values;
      visit.sources = state.sources || null;
      if (dt > 0) { stir(dt, state.sources); stats.steps += 1; }
      const g = context;
      g.bindFramebuffer(g.FRAMEBUFFER, target);
      g.viewport(0, 0, canvas.width, canvas.height);
      inside((scene) => visit.def.render(scene, null, time, dt));
      // Back to what the rest of the tab expects.
      g.disable(g.BLEND);
      g.bindFramebuffer(g.FRAMEBUFFER, target);
      g.viewport(0, 0, canvas.width, canvas.height);
      stats.frames += 1;
      prune();
      return true;
    },

    /** The scene goes: everything its visit made is freed. */
    end() { release(false); },

    /** The context was lost: its objects went with it. */
    lost() { release(true); },

    /** After a restore: the extensions are asked again. */
    restored() {
      release(true);
      support = null;
    },

    destroy() {
      release(false);
      if (unwrap) unwrap();
      unwrap = null;
      context = null;
    },
  };
}
