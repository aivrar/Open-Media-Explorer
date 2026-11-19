/**
 * Draws Psychedelia scenes on a canvas the Visualizer tab owns.
 *
 * Psychedelia's own renderer is not used: it draws a fixed 1280 x 720 output,
 * runs a requestAnimationFrame loop that never stops and has no way to tear
 * down. This small renderer keeps Psychedelia's contract instead, so scene
 * files work unchanged:
 *   - each scene's shader is built by Psychedelia's ShaderManager (its shared
 *     GLSL prelude, GLSL 100 / 300 wrapping, per-mode variants), given a
 *     stand-in for the `Renderer` it asks for the context;
 *   - scenes register through Psychedelia's EffectRegistry; the 3D flights
 *     and endless scenes also get its flight helpers (FractalFlight: param
 *     builders and metadata only);
 *   - the standard uniforms are fed as Psychedelia's renderer feeds them
 *     (renderer.js renderGPU): u_time, u_unwrapped_time, u_resolution,
 *     u_mouse, u_global_rotation, u_view_zoom*, u_seed, u_seed_vec, every
 *     param as u_<name> (pushed by the scene's parameter links), and
 *     u_audio = (bass, mid, high, level), u_beat = (kick, snare, hat, beat
 *     clock).
 *
 * Compiling is done here, not by ShaderManager's own async compile (which
 * polls on free-running timers that cannot be stopped): ShaderManager builds
 * the shader text against a recording stand-in context (captureSources), and
 * the real compile then runs on this renderer's context. Where the browser
 * offers KHR_parallel_shader_compile the compile is waited for on a single
 * timer that cancel() stops at once (and the half-made program is deleted);
 * elsewhere it is compiled on the spot. The renderer holds one scene at a
 * time: installing the next deletes the previous scene's program and runs its
 * cleanup. Each mount makes fresh copies of the Psychedelia modules, so
 * nothing (programs, a context) outlives the tab. Only single-pass shader
 * scenes are supported so far; scenes with their own render() come later.
 */

import loadShaderManager from './vendor/psychedelia/engine/shader-manager.js';
import loadRegistry from './vendor/psychedelia/effects/registry.js';
import loadFlightHelpers from './vendor/psychedelia/effects/fractal-flight-common.js';
import { applyLinks } from './reactor.js';

/** How often a background compile is checked, and how long it may take. */
export const COMPILE_POLL_MS = 30;
export const COMPILE_LIMIT_MS = 30000;
/** Without KHR_parallel_shader_compile a compile blocks the page (seconds
 *  for the biggest 3D flights): it starts this long after it is asked for,
 *  so the tab's "Preparing scene..." note, shown at once for such a compile
 *  (compileBlocks), is painted first and the picture before keeps moving
 *  until then. */
export const BLOCKING_COMPILE_DELAY_MS = 50;

/** No antialiasing, depth or stencil (a full-screen quad needs none); no
 *  preserved drawing buffer (that is only for snapshots and costs a copy). */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'default',
  failIfMajorPerformanceCaveat: false,
});

/** WebGL 2 where available, else WebGL 1; null when neither can be had. */
export function createWebglContext(canvas) {
  for (const [kind, mode] of [['webgl2', 'webgl2'], ['webgl', 'webgl'], ['experimental-webgl', 'webgl']]) {
    try {
      const gl = canvas.getContext(kind, CONTEXT_ATTRIBUTES);
      if (gl) return { gl, mode };
    } catch (_) {}
  }
  return null;
}

/**
 * The largest drawing buffer this context can make, per side. The canvas is
 * drawn to straight (its default framebuffer), which is bounded by the
 * viewport limit and, as browsers back it with a renderbuffer or texture, by
 * those sizes too; the smallest of them applies. Unknown (or a lost context):
 * no limit, as before.
 */
export function contextLimits(gl) {
  const read = (name) => {
    try {
      return gl && gl[name] !== undefined ? gl.getParameter(gl[name]) : null;
    } catch (_) {
      return null;
    }
  };
  const positive = (value) => (Number(value) > 0 ? Number(value) : Number.POSITIVE_INFINITY);
  const viewport = read('MAX_VIEWPORT_DIMS');
  const side = Math.min(positive(read('MAX_RENDERBUFFER_SIZE')), positive(read('MAX_TEXTURE_SIZE')));
  return {
    maxWidth: Math.min(positive(viewport?.[0]), side),
    maxHeight: Math.min(positive(viewport?.[1]), side),
  };
}

/** Fresh Psychedelia engine modules bound to `host` (the Renderer stand-in). */
export function loadPsychedelia(host) {
  const { ShaderManager } = loadShaderManager({ Renderer: host });
  const { FractalFlight } = loadFlightHelpers({});
  const { EffectRegistry } = loadRegistry({ Renderer: host, ShaderManager, FractalFlight });
  return { ShaderManager, EffectRegistry, FractalFlight };
}

/** A param's starting value exactly as Psychedelia's Controls gives it
 *  (gui/controls.js defaultValueForParam). */
export function defaultValue(param) {
  if (param.type === 'color') {
    const hex = typeof param.default === 'string' && /^#[0-9a-f]{6}$/i.test(param.default) ? param.default : '#ff00ff';
    return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  }
  if (param.type === 'bool') return param.default ? 1 : 0;
  if (param.type === 'select') {
    const value = parseFloat(param.default !== undefined ? param.default : 0);
    return Number.isFinite(value) ? value : 0;
  }
  if (param.default !== undefined) return param.default;
  return param.min !== undefined ? param.min : 0;
}

/** Every param's starting value: Psychedelia's default, or ours from
 *  `overrides` ({ name: number }, scenes.js `defaults`) for a param the scene
 *  has. An override is used as given (it may lie outside the param's
 *  slider range; Psychedelia's shader takes any number). */
export function sceneDefaults(def, overrides = null) {
  const values = {};
  for (const param of def?.params || []) {
    if (!param || !param.name) continue;
    const own = overrides && Object.prototype.hasOwnProperty.call(overrides, param.name) ? Number(overrides[param.name]) : Number.NaN;
    values[param.name] = Number.isFinite(own) ? own : defaultValue(param);
  }
  return values;
}

export class SceneError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
  }
}

/** Can this renderer draw `def`? (A single-pass shader scene.) */
export function drawable(def) {
  return Boolean(def && typeof def.shader === 'string' && def.shader && !def.render);
}

/**
 * The vertex and fragment text ShaderManager builds for `source` with the
 * per-mode constants `spec`, captured from a stand-in context that only
 * records (nothing is compiled, nothing is cached). `real` answers extension
 * requests (WebGL 1 derivatives must be enabled on the real context).
 */
export function captureSources(ShaderManager, host, real, source, spec) {
  const out = { vert: '', frag: '' };
  const VERTEX = real.VERTEX_SHADER;
  const recorder = {
    VERTEX_SHADER: VERTEX,
    FRAGMENT_SHADER: real.FRAGMENT_SHADER,
    COMPILE_STATUS: real.COMPILE_STATUS,
    LINK_STATUS: real.LINK_STATUS,
    createShader: (type) => ({ type }),
    shaderSource: (shader, text) => {
      if (shader.type === VERTEX) out.vert = text;
      else out.frag = text;
    },
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram() {},
    getExtension: (name) => {
      try { return real.getExtension(name); } catch (_) { return null; }
    },
  };
  host.capture = recorder;
  try {
    // No name: ShaderManager neither caches nor remembers a failure.
    ShaderManager.createProgram(source, '', spec);
  } finally {
    host.capture = null;
  }
  return out;
}

/** Start compiling and linking. Null when the context could not make a
 *  shader or the program (whatever was made is deleted again) or threw. */
function startCompile(g, sources) {
  const parts = { program: null, vs: null, fs: null };
  try {
    parts.vs = g.createShader(g.VERTEX_SHADER);
    parts.fs = g.createShader(g.FRAGMENT_SHADER);
    if (!parts.vs || !parts.fs) { dropParts(g, parts); return null; }
    g.shaderSource(parts.vs, sources.vert);
    g.shaderSource(parts.fs, sources.frag);
    g.compileShader(parts.vs);
    g.compileShader(parts.fs);
    parts.program = g.createProgram();
    if (!parts.program) { dropParts(g, parts); return null; }
    g.attachShader(parts.program, parts.vs);
    g.attachShader(parts.program, parts.fs);
    g.linkProgram(parts.program);
    return parts;
  } catch (_) {
    dropParts(g, parts);
    return null;
  }
}

function dropParts(g, parts) {
  if (parts.program) { try { g.deleteProgram(parts.program); } catch (_) {} }
  if (parts.vs) { try { g.deleteShader(parts.vs); } catch (_) {} }
  if (parts.fs) { try { g.deleteShader(parts.fs); } catch (_) {} }
}

/** Whether a scene's shader can show the beat clock (u_beat.w) as a pulse:
 *  it reads the w component, or passes u_beat on whole. */
export function readsBeatClock(source) {
  const text = String(source || '').replace(/uniform\s+vec4\s+u_beat\s*;/g, '');
  const uses = [...text.matchAll(/\bu_beat\b(\s*\.\s*([xyzwrgba]+))?/g)];
  return uses.some((use) => !use[2] || /[wa]/.test(use[2]));
}

/** The finished program, or null (and everything deleted) when it failed. */
function finishCompile(g, parts, label) {
  if (!parts) return null;
  const ok = g.getProgramParameter(parts.program, g.LINK_STATUS)
    && g.getShaderParameter(parts.vs, g.COMPILE_STATUS)
    && g.getShaderParameter(parts.fs, g.COMPILE_STATUS);
  if (!ok) {
    console.error(`visualizer: ${label} did not compile:`, g.getShaderInfoLog(parts.fs) || g.getProgramInfoLog(parts.program));
    dropParts(g, parts);
    return null;
  }
  try { g.deleteShader(parts.vs); } catch (_) {}
  try { g.deleteShader(parts.fs); } catch (_) {}
  return parts.program;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {WebGLRenderingContext|WebGL2RenderingContext} options.gl
 * @param {'webgl'|'webgl2'} options.mode
 * @param {function} [options.capsFor]  (sceneId, quality) => { param: most }
 *   or null: the most some params may be at the quality drawn now
 *   (scenes.js sceneCaps), applied to what is drawn, not to the values
 */
export function createSceneRenderer({ canvas, gl, mode, random = Math.random, capsFor = null }) {
  let context = gl;
  let quality = null; // the quality drawn now (setQuality), for capsFor
  const host = {
    capture: null,
    getGL: () => host.capture || context,
    getMode: () => mode,
    isContextLost: () => !context || context.isContextLost?.() === true,
  };
  const { ShaderManager, EffectRegistry, FractalFlight } = loadPsychedelia(host);
  let buffer = null;
  let parallel; // KHR_parallel_shader_compile, or null; asked once per context
  let scene = null; // { def, prepared, program, links, seed, seedVec, position, locations, drawValues }
  const stats = {
    draws: 0, builds: 0, installs: 0, compiles: 0, abandoned: 0, deleted: 0, buried: 0,
  };
  let limits = contextLimits(context);
  // Abandoned programs whose parallel link is still running. A program is
  // never deleted mid-link: the driver keeps looking it up until the link
  // ends, and once its name is reused (by the next scene's shaders) that
  // shows as GL_INVALID_VALUE / INVALID_OPERATION glGetProgramiv warnings.
  // They are deleted when the link has finished, on one shared timer.
  const graveyard = []; // { parts, since }
  let grave = null; // { timer, clearTimer } while the graveyard timer is set

  function clearGraveyard() {
    if (grave?.timer) grave.clearTimer(grave.timer);
    grave = null;
    graveyard.length = 0;
  }

  /** Delete `parts` once its link has finished (at once if it has). */
  function bury(g, parts, ext, timers) {
    if (context !== g || host.isContextLost()) return; // freed with the context
    let done = true;
    try { done = g.getProgramParameter(parts.program, ext.COMPLETION_STATUS_KHR) !== false; } catch (_) {}
    if (done) { dropParts(g, parts); stats.deleted += 1; return; }
    graveyard.push({ parts, since: timers.clock() });
    stats.buried += 1;
    if (!grave) armGraveyard(g, ext, timers);
  }

  function armGraveyard(g, ext, timers) {
    const sweep = () => {
      if (grave) grave.timer = 0;
      if (context !== g || host.isContextLost()) { clearGraveyard(); return; }
      const now = timers.clock();
      for (let index = graveyard.length - 1; index >= 0; index -= 1) {
        const { parts, since } = graveyard[index];
        let done = true;
        try { done = g.getProgramParameter(parts.program, ext.COMPLETION_STATUS_KHR) !== false; } catch (_) {}
        if (done || now - since >= timers.limitMs) {
          dropParts(g, parts);
          stats.deleted += 1;
          graveyard.splice(index, 1);
        }
      }
      if (graveyard.length) grave.timer = timers.setTimer(sweep, timers.pollMs);
      else grave = null;
    };
    grave = { timer: timers.setTimer(sweep, timers.pollMs), clearTimer: timers.clearTimer };
  }

  function buildQuad() {
    const g = context;
    buffer = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    stats.builds += 1;
  }

  function parallelExtension() {
    if (parallel === undefined) {
      try { parallel = context.getExtension('KHR_parallel_shader_compile') || null; } catch (_) { parallel = null; }
    }
    return parallel;
  }

  function deleteProgram(program) {
    if (!program || !context || host.isContextLost()) return;
    try { context.deleteProgram(program); stats.deleted += 1; } catch (_) {}
  }

  function location(name) {
    const { locations } = scene;
    if (!locations.has(name)) locations.set(name, context.getUniformLocation(scene.program, name));
    return locations.get(name);
  }

  function set1f(name, value) {
    const at = location(name);
    if (at !== null && at !== undefined) context.uniform1f(at, value);
  }

  function setValue(name, value) {
    const at = location(`u_${name}`);
    if (at === null || at === undefined) return;
    if (typeof value === 'number') context.uniform1f(at, value);
    else if (Array.isArray(value)) {
      if (value.length === 2) context.uniform2fv?.(at, value);
      else if (value.length === 3) context.uniform3fv?.(at, value);
      else if (value.length === 4) context.uniform4fv?.(at, value);
    }
  }

  /** The caps for `def` at the quality drawn now, or null. */
  function capsOf(def) {
    if (!capsFor || !def) return null;
    try { return capsFor(def.name, quality) || null; } catch (_) { return null; }
  }

  buildQuad();

  const renderer = {
    /** Psychedelia's ShaderManager, EffectRegistry and flight helpers for this mount. */
    engine: { ShaderManager, EffectRegistry, FractalFlight },
    get width() { return canvas.width; },
    get height() { return canvas.height; },
    /** The scene being drawn (its definition), or null before the first. */
    get definition() { return scene?.def || null; },
    get program() { return scene?.program || null; },
    get values() { return scene?.prepared.values || null; },
    get links() { return scene?.links || []; },
    /** The scene being drawn can show the beat clock as a pulse. */
    get readsBeatClock() { return scene ? readsBeatClock(scene.prepared.sources.frag) : false; },
    /** { maxWidth, maxHeight }: the drawing-buffer size this context allows. */
    get limits() { return limits; },
    get lost() { return host.isContextLost(); },
    /** A compile here blocks the page (no KHR_parallel_shader_compile). */
    get compileBlocks() { return Boolean(context) && !parallelExtension(); },
    /** Abandoned programs waiting for their link to end before deletion. */
    get buried() { return graveyard.length; },
    stats,

    /** Register a loaded scene module (its default export is the wrapped
     *  Psychedelia file, given the registry and the flight helpers) and
     *  return its definition, or null. */
    register(module, id) {
      let def = EffectRegistry.getDefinition(id);
      if (!def && typeof module?.default === 'function') {
        module.default({ EffectRegistry, FractalFlight });
        def = EffectRegistry.getDefinition(id);
      }
      return def || null;
    },

    /** Everything about `def` that does not need the GPU: default values,
     *  per-mode constants and the shader text. */
    prepare(def, overrides = null) {
      if (!drawable(def)) throw new SceneError(`Scene ${def?.name} cannot be drawn here.`, 'UNSUPPORTED');
      const values = sceneDefaults(def, overrides);
      const spec = EffectRegistry.specFor(def, values);
      const sources = captureSources(ShaderManager, host, context, def.shader, spec);
      if (!sources.vert || !sources.frag) throw new SceneError(`Scene ${def.name} has no shader.`, 'COMPILE');
      return { def, values, spec, sources };
    },

    /** Compile on the spot. Returns the program or null. */
    compileNow(prepared) {
      if (!context || host.isContextLost()) return null;
      stats.compiles += 1;
      return finishCompile(context, startCompile(context, prepared.sources), prepared.def.name);
    },

    /**
     * Compile without blocking where the browser can, then call
     * done(program | null) once. Returns a job whose cancel() stops the wait
     * at once (done is then never called) and has the half-made program
     * deleted as soon as its link has finished, or null when it finished on
     * the spot.
     */
    compile(prepared, done, {
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (handle) => clearTimeout(handle),
      clock = () => globalThis.performance?.now?.() ?? Date.now(),
      pollMs = COMPILE_POLL_MS,
      limitMs = COMPILE_LIMIT_MS,
    } = {}) {
      const timers = {
        setTimer, clearTimer, clock, pollMs, limitMs,
      };
      const g = context;
      if (!g || host.isContextLost()) { done(null); return null; }
      const ext = parallelExtension();
      if (!ext) {
        // It will block: a moment first, for the note to be painted.
        let ran = false;
        let waiting = 0;
        waiting = setTimer(() => {
          ran = true;
          waiting = 0;
          done(renderer.compileNow(prepared));
        }, BLOCKING_COMPILE_DELAY_MS);
        if (ran) waiting = 0; // a timer that ran on the spot
        return {
          get pending() { return Boolean(waiting); },
          cancel() {
            if (!waiting) return;
            clearTimer(waiting);
            waiting = 0;
            stats.abandoned += 1;
          },
        };
      }
      stats.compiles += 1;
      const parts = startCompile(g, prepared.sources);
      if (!parts) { done(null); return null; }
      const started = clock();
      let timer = 0;
      let finished = false;
      const poll = () => {
        timer = 0;
        if (finished) return;
        if (context !== g || host.isContextLost()) { finished = true; done(null); return; }
        let ready = null;
        try { ready = g.getProgramParameter(parts.program, ext.COMPLETION_STATUS_KHR); } catch (_) { ready = null; }
        if (ready === false) {
          if (clock() - started < limitMs) { timer = setTimer(poll, pollMs); return; }
          // Far too long for a light scene: give up rather than block.
          finished = true;
          console.error(`visualizer: ${prepared.def.name} took too long to compile`);
          bury(g, parts, ext, timers);
          done(null);
          return;
        }
        finished = true;
        done(finishCompile(g, parts, prepared.def.name));
      };
      timer = setTimer(poll, pollMs);
      return {
        get pending() { return !finished; },
        cancel() {
          if (finished) return;
          finished = true;
          if (timer) clearTimer(timer);
          timer = 0;
          stats.abandoned += 1;
          bury(g, parts, ext, timers);
        },
      };
    },

    /** Start drawing `prepared` with `program`; the previous scene's program
     *  is deleted and its cleanup run. */
    install(prepared, program, links = []) {
      const g = context;
      const previous = scene;
      scene = {
        def: prepared.def,
        prepared,
        program,
        links,
        seed: random() * 1000,
        seedVec: [random(), random(), random(), random()],
        position: g.getAttribLocation(program, 'a_position'),
        locations: new Map(),
        drawValues: { ...prepared.values },
        caps: capsOf(prepared.def),
      };
      if (previous) {
        try { if (typeof previous.def.cleanup === 'function') previous.def.cleanup(g); } catch (_) {}
        if (previous.program !== program) deleteProgram(previous.program);
      }
      if (typeof prepared.def.init === 'function') prepared.def.init(g);
      stats.installs += 1;
    },

    /** Delete a program that was compiled but is not wanted any more. */
    discard(program) {
      if (program && program !== scene?.program) deleteProgram(program);
    },

    /** Register (if needed), compile on the spot and install. Throws a
     *  SceneError when that cannot be done. */
    useSceneNow(def, links = [], overrides = null) {
      const prepared = renderer.prepare(def, overrides);
      const program = renderer.compileNow(prepared);
      if (!program) throw new SceneError(`Scene ${def.name} could not be compiled.`, 'COMPILE');
      renderer.install(prepared, program, links);
      return prepared;
    },

    setLinks(links) { if (scene) scene.links = links || []; },

    /** The quality drawn now ('low', 'medium', 'high'): the scene's caps
     *  (capsFor) follow it from the next frame. */
    setQuality(next) {
      quality = next || null;
      if (scene) scene.caps = capsOf(scene.def);
    },
    get caps() { return scene?.caps || null; },

    /** Change some param values of the scene being drawn, from its next
     *  frame. Only params that are plain uniforms: false (and nothing
     *  changed) when one is compiled into the shader (`specialize`) or is not
     *  the scene's, so it has to be prepared and compiled again instead. */
    setValues(partial) {
      if (!scene || !partial) return false;
      const fixed = new Set(scene.def.specialize || []);
      const known = new Set((scene.def.params || []).map((param) => param.name));
      const names = Object.keys(partial);
      if (names.some((name) => fixed.has(name) || !known.has(name) || !Number.isFinite(partial[name]))) return false;
      const values = { ...scene.prepared.values };
      for (const name of names) values[name] = partial[name];
      scene.prepared = { ...scene.prepared, values };
      scene.drawValues = { ...values };
      return true;
    },

    /** Set the drawing-buffer size. Returns true when it changed. */
    resize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      return true;
    },

    /** One frame. `state` is the loop's: { time, audio, beat, sources }.
     *  `target`: the framebuffer to draw into (the FX chain's), or null for
     *  the screen. False when nothing could be drawn (no scene yet, no
     *  context). */
    draw(state, target = null) {
      const g = context;
      if (!g || !scene || !scene.program || host.isContextLost()) return false;
      const { program, def } = scene;
      const w = canvas.width;
      const h = canvas.height;
      g.bindFramebuffer(g.FRAMEBUFFER, target);
      g.viewport(0, 0, w, h);
      g.useProgram(program);
      set1f('u_time', state.time);
      set1f('u_unwrapped_time', state.time);
      const resolution = location('u_resolution');
      if (resolution !== null && resolution !== undefined) g.uniform2f(resolution, w, h);
      const mouse = location('u_mouse');
      if (mouse !== null && mouse !== undefined) g.uniform2f(mouse, 0.5, 0.5);
      set1f('u_global_rotation', 0);
      // The zoom punch goes through the view zoom ShaderManager builds into
      // every scene (psyViewUV), as Psychedelia's post pass would apply it.
      set1f('u_view_zoom', state.zoom > 0 ? state.zoom : 1);
      set1f('u_view_zoom_speed', 0.7);
      set1f('u_view_zoom_depth', 0);
      set1f('u_seed', scene.seed);
      const seedAt = location('u_seed_vec');
      if (seedAt !== null && seedAt !== undefined) g.uniform4fv(seedAt, scene.seedVec);
      const audio = state.audio || {};
      const audioAt = location('u_audio');
      if (audioAt !== null && audioAt !== undefined) {
        g.uniform4f(audioAt, audio.bass || 0, audio.mid || 0, audio.high || 0, audio.level || 0);
      }
      const beat = state.beat || {};
      const beatAt = location('u_beat');
      if (beatAt !== null && beatAt !== undefined) {
        g.uniform4f(beatAt, beat.kick || 0, beat.snare || 0, beat.hat || 0, beat.clock || 0);
      }
      const values = scene.links.length
        ? applyLinks(scene.prepared.values, scene.links, state.sources, scene.drawValues)
        : scene.prepared.values;
      const { caps } = scene;
      for (const name in values) {
        const most = caps ? caps[name] : undefined;
        setValue(name, most !== undefined && values[name] > most ? most : values[name]);
      }
      if (typeof def.setUniforms === 'function') def.setUniforms(g, program, values, (p, n) => location(n), state.time);
      g.bindBuffer(g.ARRAY_BUFFER, buffer);
      if (scene.position >= 0) {
        g.enableVertexAttribArray(scene.position);
        g.vertexAttribPointer(scene.position, 2, g.FLOAT, false, 0, 0);
      }
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      stats.draws += 1;
      return true;
    },

    /** On webglcontextlost: the programs waiting to be deleted went with the
     *  context, so their timer stops (nothing runs while lost). */
    contextLost() { clearGraveyard(); },

    /** After webglcontextrestored: every old object belonged to the lost
     *  context. The scene being drawn went with it (nothing is drawn until a
     *  scene is installed again): it is compiled again like any change of
     *  scene, through compile() (scene-switcher.js resume), so a big shader
     *  never blocks here. Returns the id of the scene that was drawn, or
     *  null. */
    restore() {
      clearGraveyard(); // those belonged to the lost context
      parallel = undefined;
      buffer = null;
      limits = contextLimits(context);
      buildQuad();
      const id = scene ? scene.def.name : null;
      scene = null;
      return id;
    },

    /** Free everything and give the context back to the browser at once. */
    destroy() {
      const g = context;
      if (!g) return;
      if (scene) {
        try { if (typeof scene.def.cleanup === 'function') scene.def.cleanup(g); } catch (_) {}
        deleteProgram(scene.program);
      }
      // Abandoned programs whose link has finished are deleted now (with
      // their shaders). Those still linking are not (a driver may still look
      // them up): losing the context below frees them with everything else.
      if (graveyard.length && !host.isContextLost()) {
        const ext = parallelExtension();
        for (const { parts } of graveyard) {
          let done = true;
          try { done = !ext || g.getProgramParameter(parts.program, ext.COMPLETION_STATUS_KHR) !== false; } catch (_) {}
          if (done) { dropParts(g, parts); stats.deleted += 1; }
        }
      }
      clearGraveyard();
      try { ShaderManager.clearCache(); } catch (_) {}
      try { if (buffer && !host.isContextLost()) g.deleteBuffer(buffer); } catch (_) {}
      try { g.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
      scene = null;
      buffer = null;
      context = null;
    },
  };
  return renderer;
}
