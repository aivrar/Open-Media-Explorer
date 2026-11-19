/**
 * The post effects stage: scene -> framebuffer -> FX passes -> screen.
 *
 * The passes are Psychedelia's (engine/post-fx-library.js, unchanged); this
 * runs them the way its post-process.js does, without its Renderer:
 *
 *   - Bypass: with no FX on, begin() returns null and the scene draws
 *     straight to the screen as before: no framebuffer, no texture, no extra
 *     draw call, nothing bound. The global reactions ride on the chain, so
 *     they are off then too.
 *   - Lazily made, freed when done: the scene's framebuffer and the two
 *     ping-pong targets are made on the first frame that needs them, at the
 *     drawing buffer's size (so the quality setting sizes them), and only as
 *     many as the passes need (one FX: just the scene's; the last pass draws
 *     to the screen itself). setPasses([]) frees them all, as does free()
 *     (the tab closing).
 *   - Programs: compiled without blocking a frame where the context offers
 *     KHR_parallel_shader_compile (a pass joins when its program is ready;
 *     the picture is drawn without it meanwhile). The chain's programs and
 *     at most FX_PROGRAM_CACHE others (most recently used) are kept; the rest
 *     are deleted with their shaders, never one in use or still linking.
 *   - Feedback passes (history: trails, RGB echo, slit scan, datamosh) keep
 *     their own two frames, and get u_fstep (fxFrameStep: the frame's length
 *     in 60 fps frames), so they look the same at 15, 30 or 60 fps. A draw
 *     at the time of the last one (a held picture, the cross-fade's picture
 *     of the outgoing scene, a redraw after a resize) is a redraw: it shows
 *     that frame again, from the same two frames and step, and moves no
 *     history (it draws through a spare target). They start from the picture coming in, never
 *     from black, and start again cleanly on resetHistory() (a new scene), a
 *     new size and after a lost context. A pass that stays on across a change
 *     of FX keeps its history.
 *   - Trigger passes (shockwave, datamosh) get u_age, the seconds since they
 *     last fired: on the limited beat clock's beat or bar (state.beat.clock,
 *     so no more often than the flash limiter lets the clock run), or every
 *     `interval` seconds. Every firing is charged to the flash limiter's one
 *     rolling second (`charge`, shared with the envelope pulses, the scene's
 *     clock wraps and scene changes); with no room it does not fire. All
 *     trigger passes together also fire at most once every FX_TRIGGER_GAP_S
 *     (1 s, the share the tab keeps free while one draws: usesClock). A pass
 *     starts spent (TRIGGER_IDLE_AGE) whenever it first draws.
 *   - Param links (fx-shuffle.js) push params from the limiter's output
 *     (state.sources), as the scenes' links do (reactor.js applyLinks).
 *   - The global reactions pass (fx-reactions.js; Psychedelia's audio pass,
 *     below) is the last pass when it has anything to do.
 *   - A lost context: every object went with it; nothing is deleted, all is
 *     made again on the next frame after restore().
 */

import { applyLinks } from './reactor.js';
import { FX_SYNC } from './fx-catalog.js';
import { FLASH_LIMITS } from './flash-limiter.js';

/** Psychedelia's post-process.js audio pass (its AUDIO_PASS_SRC), as there. */
export const REACTION_SRC = [
  'uniform sampler2D u_tex;',
  'uniform vec2 u_resolution;',
  'uniform float u_zoom;',
  'uniform float u_rot;',
  'uniform float u_flash;',
  'uniform float u_hue;',
  'uniform float u_chroma;',
  'uniform float u_pump;',
  'uniform vec2 u_shake;',
  'vec3 hueRot(vec3 c, float a) {',
  '    vec3 k = vec3(0.57735);',
  '    float ca = cos(a);',
  '    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);',
  '}',
  'vec2 mirrorUV(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }',
  'void main() {',
  '    float aspect = u_resolution.x / max(u_resolution.y, 1.0);',
  '    vec2 d = v_uv - 0.5;',
  '    d.x *= aspect;',
  '    float c = cos(u_rot), s = sin(u_rot);',
  '    d = mat2(c, -s, s, c) * d / max(u_zoom, 0.2);',
  '    d.x /= aspect;',
  '    vec2 uv = d + 0.5 + u_shake;',
  '    vec2 off = (v_uv - 0.5) * u_chroma * 2.0;',
  '    vec3 col;',
  '    col.r = texture2D(u_tex, mirrorUV(uv + off)).r;',
  '    col.g = texture2D(u_tex, mirrorUV(uv)).g;',
  '    col.b = texture2D(u_tex, mirrorUV(uv - off)).b;',
  '    if (abs(u_hue) > 0.0005) col = max(hueRot(col, u_hue * 6.28318), 0.0);',
  '    float l = dot(col, vec3(0.299, 0.587, 0.114));',
  '    col = max(mix(vec3(l), col, 1.0 + u_pump * 0.7), 0.0);',
  '    col = col * (1.0 + u_pump * 0.15) * (1.0 + u_flash * 0.9) + u_flash * 0.05;',
  '    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}',
].join('\n');

const BLIT_SRC = 'uniform sampler2D u_tex;\nvoid main() { gl_FragColor = texture2D(u_tex, v_uv); }';

/** The blend modes' numbers in OVERLAY_BLEND_SRC (overlay-catalog.js OVERLAY_BLENDS). */
export const OVERLAY_MODE_INDEX = Object.freeze({
  add: 0, screen: 1, multiply: 2, soft: 3, difference: 4,
});
/** How far each blend mode may go (its share of the overlay's own alpha):
 *  Difference and Multiply can turn a bright overlay over a bright scene into
 *  a large step of light, so they are held lower (measured, the overlay
 *  flash check). */
export const OVERLAY_MODE_STRENGTH = Object.freeze({
  add: 1, screen: 1, multiply: 0.8, soft: 1, difference: 0.6,
});
/** The most the overlay bends the scene: uv offset per unit of the overlay's
 *  luminance slope (a share of the picture). */
export const OVERLAY_BEND_MAX = 0.012;
/** Mask from the scene's luminance: shown where it is between these. */
export const OVERLAY_MASK_EDGES = Object.freeze([0.12, 0.55]);

/** One blended overlay (overlay-layer.js blend sheet, uploaded to u_ov,
 *  premultiplied, its top row first) on the picture so far (u_tex). */
export const OVERLAY_BLEND_SRC = [
  'uniform sampler2D u_tex;',
  'uniform sampler2D u_ov;',
  'uniform vec2 u_ovsize;',
  'uniform float u_mode;',
  'uniform float u_strength;',
  'uniform float u_mask;',
  'uniform float u_tint;',
  'uniform float u_bend;',
  'uniform float u_gain;',
  'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
  'vec3 softLight(vec3 b, vec3 s) {',
  '    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));',
  '    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(vec3(0.5), s));',
  '}',
  'void main() {',
  '    vec2 ouv = vec2(v_uv.x, 1.0 - v_uv.y);',
  '    vec4 o = texture2D(u_ov, ouv);',
  '    vec2 uv = v_uv;',
  '    if (u_bend > 0.0) {',
  '        vec2 px = 2.0 / max(u_ovsize, vec2(1.0));',
  '        float gx = luma(texture2D(u_ov, ouv + vec2(px.x, 0.0)).rgb) - luma(texture2D(u_ov, ouv - vec2(px.x, 0.0)).rgb);',
  '        float gy = luma(texture2D(u_ov, ouv + vec2(0.0, px.y)).rgb) - luma(texture2D(u_ov, ouv - vec2(0.0, px.y)).rgb);',
  '        uv = clamp(uv + vec2(gx, -gy) * u_bend, 0.0, 1.0);',
  '    }',
  '    vec3 s = texture2D(u_tex, uv).rgb;',
  '    float a = o.a;',
  '    vec3 c = a > 0.0001 ? clamp(o.rgb / a, 0.0, 1.0) : vec3(0.0);',
  '    if (u_tint > 0.0) {',
  '        vec3 sc = clamp(s / max(max(s.r, max(s.g, s.b)), 0.08), 0.0, 1.0);',
  '        c = mix(c, sc * max(c.r, max(c.g, c.b)), u_tint);',
  '    }',
  '    if (u_mask > 0.5) {',
  `        float m = smoothstep(${OVERLAY_MASK_EDGES[0].toFixed(2)}, ${OVERLAY_MASK_EDGES[1].toFixed(2)}, luma(s));`,
  '        a *= u_mask > 1.5 ? 1.0 - m : m;',
  '    }',
  '    a *= u_gain * u_strength;',
  '    vec3 b = c;',
  '    if (u_mode > 3.5) b = abs(s - c);',
  '    else if (u_mode > 2.5) b = softLight(s, c);',
  '    else if (u_mode > 1.5) b = s * c;',
  '    else if (u_mode > 0.5) b = 1.0 - (1.0 - s) * (1.0 - c);',
  '    gl_FragColor = vec4(mix(s, b, a), 1.0);',
  '}',
].join('\n');

/** Vertex shader of every pass (post-process.js getVertexSrc). */
export function fxVertex(mode) {
  return mode === 'webgl2'
    ? '#version 300 es\nin vec2 a_position;\nout vec2 v_uv;\nvoid main(){v_uv=a_position*0.5+0.5;gl_Position=vec4(a_position,0.0,1.0);}'
    : 'attribute vec2 a_position;\nvarying vec2 v_uv;\nvoid main(){v_uv=a_position*0.5+0.5;gl_Position=vec4(a_position,0.0,1.0);}';
}

/** A pass's fragment shader for the context (post-process.js adaptFrag). */
export function fxFragment(src, mode) {
  if (mode === 'webgl2') {
    const text = src.replace(/\btexture2D\b/g, 'texture').replace(/\bgl_FragColor\b/g, 'fragColor');
    return `#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\n${text}`;
  }
  return `precision highp float;\nvarying vec2 v_uv;\n${src}`;
}

/** The trigger period in beats for a sync choice (0: free running). */
function syncBeats(sync) {
  const value = Math.round(Number(sync) || 0);
  if (value === FX_SYNC.beat) return 1;
  if (value === FX_SYNC.bar) return 4;
  return 0;
}

/** Reactions that would change nothing this frame. */
export function reactionsIdle(values) {
  return !values || (Math.abs(values.rot) < 1e-4 && Math.abs(values.hue) < 1e-4 && values.chroma < 1e-5
    && values.pump < 1e-4 && values.flash < 1e-4 && Math.abs(values.shakeX) < 1e-5 && Math.abs(values.shakeY) < 1e-5);
}

/** Compiled effect programs kept for effects no longer in the chain (most
 *  recently used first), so switching one off and on again does not compile
 *  it again; the rest are deleted with their shaders. */
export const FX_PROGRAM_CACHE = 6;
/** Trigger passes together fire at most once in this many seconds: the
 *  flash limiter's clock reserve (1 of its 3 pulses a second), kept free for
 *  them while one draws (usesClock). What keeps the total is the charge. */
export const FX_TRIGGER_GAP_S = 1 / FLASH_LIMITS.clockReserve;
/** u_age of a trigger pass that has not fired (s): its ring or smear long
 *  gone, nothing shows. */
export const TRIGGER_IDLE_AGE = 30;
/** u_fstep for a frame of `dt` seconds: the frame's length in 60 fps frames
 *  (Psychedelia's post-process.js apply(): 1 at 60 fps, 2 at 30, 4 at 15),
 *  kept to 0.25..4; 1 when dt is unknown (the loop's first frame gives 0:
 *  a draw with no time passed at all is a redraw, told apart by finish()
 *  from its time, which moves nothing). Feedback passes scale their per
 *  frame change by it, so trails, echoes, scans and smears run the same at
 *  any frame rate the tab picks. */
export function fxFrameStep(dt) {
  const value = Number(dt);
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const step = value * 60;
  return step < 0.25 ? 0.25 : (step > 4 ? 4 : step);
}

const INTERNAL = new Set(['reactions', 'blit', 'overlay']);

/**
 * `charge`: asks the flash budget for a trigger firing (reactor.js charge:
 * true when the rolling second has room, and it is charged); none: no
 * budget (tests). `onChange`: called when a pass becomes drawable or fails
 * after setPasses() returned (a link finished), so the tab can show what is
 * drawn.
 */
export function createFxChain({
  gl, mode, charge = null, onChange = null,
}) {
  let context = gl;
  let width = 0;
  let height = 0;
  let quad = null;
  let capture = null; // { fb, tex }
  let ping = null;
  let pong = null;
  let passes = []; // { id, fx, values, links, drawValues, hist, beat, firedAt }
  let reactions = null; // this frame's global reaction values, or null
  // The blended overlay (overlay-layer.js blendSheet getter: () => sheet or
  // null), its texture (one, reused) and the sheet version last uploaded.
  let overlay = null;
  let overlayTex = null;
  let overlayVersion = -1;
  let overlayW = 0;
  let overlayH = 0;
  let overlayFailed = false;
  // key -> { state: 'linking' | 'ready' | 'failed', program, vs, fs,
  //          position, locations, used }
  const programs = new Map();
  const linking = []; // entries still linking (each has its key)
  let useTick = 0;
  // The passes drawn now (ready, and the copy to the screen a feedback pass
  // needs ready too): rebuilt only when passes or program states change.
  const drawList = [];
  let drawDirty = true;
  let failedAsked = []; // ids asked for whose programs failed
  let parallel; // KHR_parallel_shader_compile of the context (null: none); undefined: not asked yet
  // Trigger firing, shared by every trigger pass (wall-clock seconds).
  let wall = 0;
  let lastTime = Number.NaN;
  let lastStep = 1; // u_fstep of the frame drawn at lastTime
  let frame = 0;
  let firedWall = Number.NEGATIVE_INFINITY;
  let firedFrame = -1;
  const stats = {
    frames: 0,
    draws: 0,
    targetsMade: 0,
    targetsFreed: 0,
    compiles: 0,
    failed: 0,
    resets: 0,
    historyKept: 0,
    historySteps: 0, // feedback frames written (a pass's history moved on)
    redraws: 0, // draws at the time of the last one (no history moved)
    programs: 0, // effect programs held now (in the chain, cached or linking)
    programsDeleted: 0,
    waitedLink: 0, // frames drawn without a pass whose program was still linking
    triggers: 0, // trigger firings (passes firing on the same frame count once)
    triggersHeld: 0, // firings skipped: less than FX_TRIGGER_GAP_S since the last
    triggersRefused: 0, // firings the flash budget had no room for
    polls: 0, // looks at programs still linking (none while nothing links)
    drawListBuilds: 0, // the drawn passes listed again (after a change only)
    overlayUploads: 0, // the blended overlay's canvas uploaded (frames it was drawn)
    overlaySkipped: 0, // frames its upload was skipped (not drawn again)
    overlayDraws: 0, // its blend pass drawn
  };

  const alive = () => Boolean(context) && context.isContextLost?.() !== true;

  /* ---- Programs ----
     Compiled without waiting where the context can (KHR_parallel_shader_
     compile, as scene-renderer.js): the link is only looked at once the
     driver says it has finished, polled once a frame, and a pass joins the
     chain when its program is ready; the picture is drawn without it
     meanwhile. Without the extension the status is read at once (a driver
     without it compiles before returning anyway). */
  function parallelExtension() {
    if (parallel === undefined) {
      try { parallel = context.getExtension('KHR_parallel_shader_compile') || null; } catch (_) { parallel = null; }
    }
    return parallel;
  }
  function countPrograms() {
    let held = 0;
    for (const entry of programs.values()) if (!INTERNAL.has(entry.key) && entry.state !== 'failed') held += 1;
    stats.programs = held;
  }
  function dropEntry(entry) {
    if (alive()) {
      try { if (entry.program) context.deleteProgram(entry.program); } catch (_) {}
      try { if (entry.vs) context.deleteShader(entry.vs); } catch (_) {}
      try { if (entry.fs) context.deleteShader(entry.fs); } catch (_) {}
    }
    entry.program = null;
    entry.vs = null;
    entry.fs = null;
  }
  /** Read a finished link: ready, or failed (and deleted). */
  function settle(key, entry) {
    const g = context;
    const ok = g.getShaderParameter(entry.vs, g.COMPILE_STATUS) && g.getShaderParameter(entry.fs, g.COMPILE_STATUS)
      && g.getProgramParameter(entry.program, g.LINK_STATUS);
    if (ok) {
      entry.state = 'ready';
      entry.position = g.getAttribLocation(entry.program, 'a_position');
      entry.locations = new Map();
      return;
    }
    if (!g.isContextLost?.()) console.error(`visualizer: FX ${key} did not compile:`, g.getShaderInfoLog(entry.fs) || g.getProgramInfoLog(entry.program));
    dropEntry(entry);
    entry.state = 'failed';
    stats.failed += 1;
  }
  /** Start compiling `src` under `key` (once); returns its entry. */
  function start(key, src) {
    if (programs.has(key)) return programs.get(key);
    const g = context;
    stats.compiles += 1;
    const entry = {
      key, state: 'linking', program: null, vs: null, fs: null, position: -1, locations: null, used: useTick,
    };
    programs.set(key, entry);
    drawDirty = true;
    try {
      entry.vs = g.createShader(g.VERTEX_SHADER);
      g.shaderSource(entry.vs, fxVertex(mode));
      g.compileShader(entry.vs);
      entry.fs = g.createShader(g.FRAGMENT_SHADER);
      g.shaderSource(entry.fs, fxFragment(src, mode));
      g.compileShader(entry.fs);
      entry.program = g.createProgram();
      g.attachShader(entry.program, entry.vs);
      g.attachShader(entry.program, entry.fs);
      g.linkProgram(entry.program);
      if (!parallelExtension()) settle(key, entry);
      else linking.push(entry);
    } catch (error) {
      console.error(`visualizer: FX ${key} did not compile:`, error);
      dropEntry(entry);
      entry.state = 'failed';
      stats.failed += 1;
    }
    countPrograms();
    return entry;
  }
  /** Look at the programs still linking (cheap: one query each). */
  function poll() {
    if (!linking.length) return false;
    const ext = parallelExtension();
    if (!ext || !alive()) return false;
    stats.polls += 1;
    let changed = false;
    for (let index = linking.length - 1; index >= 0; index -= 1) {
      const entry = linking[index];
      if (entry.state !== 'linking') { linking.splice(index, 1); continue; }
      let done = true;
      try { done = context.getProgramParameter(entry.program, ext.COMPLETION_STATUS_KHR) !== false; } catch (_) {}
      if (!done) continue;
      linking.splice(index, 1);
      settle(entry.key, entry);
      changed = true;
    }
    if (!changed) return false;
    // A pass whose program failed leaves the chain (and is reported).
    const gone = passes.filter((pass) => programs.get(pass.id)?.state === 'failed');
    if (overlay && programs.get('overlay')?.state === 'failed') overlayFailed = true;
    if (gone.length) {
      for (const pass of gone) { freeHistory(pass); if (!failedAsked.includes(pass.id)) failedAsked.push(pass.id); }
      passes = passes.filter((pass) => !gone.includes(pass));
    }
    if (!passes.length && !overlayOn()) freeTargets();
    drawDirty = true;
    evict();
    return true;
  }
  /** Keep the chain's programs and at most FX_PROGRAM_CACHE others (most
   *  recently used); delete the rest. Never one in use or still linking. */
  function evict() {
    const inChain = new Set(passes.map((pass) => pass.id));
    const spare = [];
    for (const [key, entry] of programs) {
      if (INTERNAL.has(key) || inChain.has(key) || entry.state === 'linking') continue;
      if (entry.state === 'failed') continue; // nothing held; kept so it is not tried again
      spare.push([key, entry]);
    }
    spare.sort((a, b) => b[1].used - a[1].used);
    for (const [key, entry] of spare.slice(FX_PROGRAM_CACHE)) {
      dropEntry(entry);
      programs.delete(key);
      stats.programsDeleted += 1;
    }
    drawDirty = true;
    countPrograms();
  }
  /** The ready program for `key`, or null (still linking, or failed). */
  function ready(key, src) {
    const entry = start(key, src);
    return entry.state === 'ready' ? entry : null;
  }

  function location(made, name) {
    if (!made.locations.has(name)) made.locations.set(name, context.getUniformLocation(made.program, name));
    return made.locations.get(name);
  }
  function set1f(made, name, value) {
    const at = location(made, name);
    if (at !== null && at !== undefined) context.uniform1f(at, value);
  }
  function set1i(made, name, value) {
    const at = location(made, name);
    if (at !== null && at !== undefined) context.uniform1i(at, value);
  }

  /* ---- Targets ---- */
  function makeTarget() {
    const g = context;
    const tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, width, height, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    const fb = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fb);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    g.bindTexture(g.TEXTURE_2D, null);
    stats.targetsMade += 1;
    return { fb, tex };
  }
  function freeTarget(target) {
    if (!target) return null;
    stats.targetsFreed += 1;
    if (alive()) {
      try { context.deleteFramebuffer(target.fb); } catch (_) {}
      try { context.deleteTexture(target.tex); } catch (_) {}
    }
    return null;
  }
  function freeHistory(pass) {
    if (!pass.hist) return;
    pass.hist.targets.forEach(freeTarget);
    pass.hist = null;
  }
  /** Every framebuffer and texture (the passes stay chosen). */
  function freeTargets() {
    capture = freeTarget(capture);
    ping = freeTarget(ping);
    pong = freeTarget(pong);
    freeOverlayTexture();
    for (const pass of passes) freeHistory(pass);
    if (quad && alive()) { try { context.deleteBuffer(quad); } catch (_) {} }
    quad = null;
  }

  /* ---- The blended overlay ---- */
  const overlaySheet = () => (overlay && !overlayFailed ? overlay() : null);
  const overlayOn = () => Boolean(overlaySheet());
  const overlayReady = () => overlayOn() && programs.get('overlay')?.state === 'ready';
  function freeOverlayTexture() {
    if (overlayTex && alive()) { try { context.deleteTexture(overlayTex); } catch (_) {} }
    overlayTex = null;
    overlayVersion = -1;
    overlayW = 0;
    overlayH = 0;
  }
  /** The sheet's canvas into the one texture, only when it was drawn since
   *  the last upload (premultiplied, as the canvas holds it). */
  function uploadOverlay(sheet) {
    const g = context;
    const canvas = sheet.canvas;
    if (!overlayTex) {
      overlayTex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, overlayTex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      overlayVersion = -1;
    } else g.bindTexture(g.TEXTURE_2D, overlayTex);
    if (sheet.version === overlayVersion && canvas.width === overlayW && canvas.height === overlayH) {
      stats.overlaySkipped += 1;
      return;
    }
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, canvas);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    overlayVersion = sheet.version;
    overlayW = canvas.width;
    overlayH = canvas.height;
    stats.overlayUploads += 1;
  }
  /** The blend pass: the overlay on `readTex`, into `writeFb` (null: the screen). */
  function drawOverlay(made, sheet, readTex, writeFb) {
    const g = context;
    g.bindFramebuffer(g.FRAMEBUFFER, writeFb);
    g.viewport(0, 0, width, height);
    g.useProgram(made.program);
    g.activeTexture(g.TEXTURE1);
    uploadOverlay(sheet);
    set1i(made, 'u_ov', 1);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, readTex);
    set1i(made, 'u_tex', 0);
    const size = location(made, 'u_ovsize');
    if (size !== null && size !== undefined) g.uniform2f(size, sheet.canvas.width, sheet.canvas.height);
    const blend = sheet.blend || {};
    set1f(made, 'u_mode', OVERLAY_MODE_INDEX[blend.mode] ?? 0);
    set1f(made, 'u_strength', OVERLAY_MODE_STRENGTH[blend.mode] ?? 1);
    set1f(made, 'u_mask', blend.mask === 'bright' ? 1 : (blend.mask === 'dark' ? 2 : 0));
    set1f(made, 'u_tint', blend.tint ? 1 : 0);
    set1f(made, 'u_bend', blend.bend ? OVERLAY_BEND_MAX : 0);
    set1f(made, 'u_gain', Math.max(0, Math.min(1, Number(sheet.gain ?? 1))));
    drawQuad(made);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, null);
    g.activeTexture(g.TEXTURE0);
    stats.overlayDraws += 1;
  }

  function drawQuad(made) {
    const g = context;
    if (!quad) {
      quad = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, quad);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    }
    g.bindBuffer(g.ARRAY_BUFFER, quad);
    if (made.position >= 0) {
      g.enableVertexAttribArray(made.position);
      g.vertexAttribPointer(made.position, 2, g.FLOAT, false, 0, 0);
    }
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    stats.draws += 1;
  }

  /** A trigger pass may fire now (true), sharing one firing per frame and
   *  at most one every FX_TRIGGER_GAP_S whatever its sync. */
  function mayFire() {
    if (firedFrame === frame) return true;
    if (wall - firedWall < FX_TRIGGER_GAP_S - 1e-9) { stats.triggersHeld += 1; return false; }
    // The flash budget's rolling second, shared with the envelope pulses,
    // the scene's clock wraps and scene changes: no room, no firing.
    if (charge && !charge()) { stats.triggersRefused += 1; return false; }
    firedWall = wall;
    firedFrame = frame;
    stats.triggers += 1;
    return true;
  }

  /** u_age of a trigger pass this frame: the seconds since it last fired, on
   *  the limited beat clock's beat or bar, or every `interval` seconds when
   *  free running; either way only through mayFire(). A pass starts spent
   *  (age TRIGGER_IDLE_AGE: nothing shows) whenever it first draws. */
  function triggerAge(pass, state) {
    const time = Number(state.time) || 0;
    const period = syncBeats(pass.values.sync);
    const clock = Number(state.beat?.clock);
    if (pass.beat === null) pass.firedAt = time - TRIGGER_IDLE_AGE; // nothing fired yet
    if (period && Number.isFinite(clock)) {
      const count = Math.floor(clock / period);
      if (pass.beat !== null && count !== pass.beat && mayFire()) pass.firedAt = time;
      pass.beat = count;
    } else {
      const interval = Math.max(0.05, Number(pass.values.interval) || 1);
      // Free running: fires once `interval` has passed and the budget lets
      // it (tried again each frame until it does).
      if (pass.beat === null) pass.beat = -1;
      else if (time - pass.firedAt >= interval && mayFire()) pass.firedAt = time;
    }
    return Math.max(0, Math.min(TRIGGER_IDLE_AGE, time - pass.firedAt));
  }

  /** The passes whose programs are ready (the others wait for theirs); a
   *  feedback pass also needs the plain copy to the screen ready. The same
   *  array, rebuilt only after a change. */
  function drawable() {
    if (!drawDirty) return drawList;
    drawDirty = false;
    stats.drawListBuilds += 1;
    drawList.length = 0;
    let history = false;
    for (const pass of passes) {
      if (programs.get(pass.id)?.state !== 'ready') continue;
      drawList.push(pass);
      if (pass.fx.def.options?.history) history = true;
    }
    if (history && programs.get('blit')?.state !== 'ready') drawList.length = 0;
    return drawList;
  }

  const chain = {
    stats,
    /** FX passes asked for now (0: the chain is bypassed); some may still be
     *  linking (drawnIds: those drawn). */
    get count() { return passes.length; },
    /** Anything to draw through the chain: FX passes, or a blended overlay. */
    get active() { return passes.length > 0 || overlayOn(); },
    /** A blended overlay is set and its pass can draw. */
    get overlayOn() { return overlayReady(); },
    get overlayFailed() { return overlayFailed; },
    /** Targets or the overlay's texture are held while nothing draws
     *  through the chain (a blended overlay just went): release() frees them. */
    get holding() { return Boolean(capture || ping || pong || overlayTex); },
    /** The blended overlay's texture is held. */
    get overlayHeld() { return Boolean(overlayTex); },
    release() {
      if (!passes.length && !overlayOn()) freeTargets();
    },
    get ids() { return passes.map((pass) => pass.id); },
    get drawnIds() { return drawable().map((pass) => pass.id); },
    /** Ids asked for whose programs failed (setPasses or a later link). */
    get failedIds() { return failedAsked.slice(); },
    get passes() { return passes; },
    /** A pass fires on the beat clock or its own interval: the tab then
     *  reserves the clock's share of the flash budget (flash-limiter.js). */
    get usesClock() { return drawable().some((pass) => Boolean(pass.fx.def.options?.trigger)); },
    /** Effect programs still linking. */
    get linking() {
      let count = 0;
      for (const entry of linking) if (!INTERNAL.has(entry.key) && entry.state === 'linking') count += 1;
      return count;
    },
    /** Framebuffers and textures held now. */
    get targets() {
      return (capture ? 1 : 0) + (ping ? 1 : 0) + (pong ? 1 : 0)
        + passes.reduce((sum, pass) => sum + (pass.hist ? 2 : 0), 0);
    },
    get size() { return { width, height }; },

    /** The FX to draw, in chain order: [{ id, fx (catalog row), values,
     *  links }]. A pass already on keeps its history. Their programs start
     *  compiling now; a pass whose program fails leaves the chain
     *  (stats.failed). Returns the ids asked for and not failed. */
    setPasses(list) {
      const before = new Map(passes.map((pass) => [pass.id, pass]));
      const next = [];
      useTick += 1;
      failedAsked = [];
      drawDirty = true;
      for (const item of list || []) {
        if (!item?.fx?.def?.src) continue;
        if (alive()) {
          const entry = start(item.id, item.fx.def.src);
          if (entry.state === 'failed') { failedAsked.push(item.id); continue; }
          entry.used = useTick;
        }
        const kept = before.get(item.id);
        before.delete(item.id);
        if (kept?.hist) stats.historyKept += 1;
        next.push({
          id: item.id,
          fx: item.fx,
          values: { ...item.values },
          links: item.links || [],
          drawValues: {},
          hist: kept ? kept.hist : null,
          beat: kept ? kept.beat : null,
          firedAt: kept ? kept.firedAt : 0,
        });
      }
      for (const gone of before.values()) freeHistory(gone);
      passes = next;
      if (!passes.length && !overlayOn()) freeTargets();
      else if (passes.length && alive()) {
        // The helpers, ahead of their first use.
        start('reactions', REACTION_SRC);
        start('blit', BLIT_SRC);
      }
      if (alive()) evict();
      return chain.ids;
    },

    /** Look at programs still linking now (also done by begin()). */
    poll() { if (poll()) onChange?.(); },

    /** The blended overlay: `sheet` is a getter (overlay-layer.js
     *  blendSheet: { canvas, version, blend, gain } or null), read each frame;
     *  null: none (its texture is freed). Its program starts compiling now. */
    setOverlay(sheet) {
      overlay = typeof sheet === 'function' ? sheet : null;
      overlayFailed = false;
      if (overlay && alive()) {
        const entry = start('overlay', OVERLAY_BLEND_SRC);
        if (entry.state === 'failed') overlayFailed = true;
        start('blit', BLIT_SRC);
      }
      if (!overlay) {
        freeOverlayTexture();
        if (!passes.length) freeTargets();
      }
    },

    /** No blended overlay on the picture now (the getter gives null): its
     *  texture is freed at once, whether effects stay on or not. */
    freeOverlay() {
      if (overlayTex && !overlayOn()) freeOverlayTexture();
    },

    /** This frame's global reaction values (fx-reactions.js), or null. */
    setReactions(values) { reactions = values || null; },

    /** Feedback passes start again from the picture coming in (a new scene). */
    resetHistory() {
      let any = false;
      for (const pass of passes) {
        if (pass.hist) { pass.hist.fresh = true; pass.hist.written = 0; any = true; }
        pass.beat = null;
      }
      if (any) stats.resets += 1;
    },

    /** Before the scene draws: the framebuffer it should draw into, at
     *  `w` x `h`, or null to draw to the screen (no FX, or none ready yet:
     *  bypassed). */
    begin(w, h) {
      // A blended overlay just went while effects stay on: its texture goes.
      if (overlayTex && !overlayOn()) freeOverlayTexture();
      if ((!passes.length && !overlayOn()) || !alive()) return null;
      if (poll()) onChange?.();
      if (!passes.length && !overlayOn()) return null;
      const list = drawable();
      if (list.length < passes.length) stats.waitedLink += 1;
      if (!list.length && !overlayReady()) return null;
      if (w !== width || h !== height) {
        const had = capture || passes.some((pass) => pass.hist);
        freeTargets();
        width = w;
        height = h;
        if (had) stats.resets += 1;
      }
      if (!capture) capture = makeTarget();
      return capture.fb;
    },

    /** After the scene drew into begin()'s framebuffer: every ready pass,
     *  the last one to the screen. `state` is the loop's. */
    finish(state) {
      if ((!passes.length && !overlayOn()) || !capture || !alive()) return false;
      const g = context;
      // The wall clock for trigger firing: once per frame (a frame drawn
      // twice under a cross-fade moves it once).
      const time = Number(state?.time) || 0;
      // Drawn already at this time: the same frame again, history kept.
      const repeat = time === lastTime;
      if (!repeat) {
        lastTime = time;
        frame += 1;
        const dt = Number(state?.dt);
        wall += dt > 0 ? Math.min(dt, 0.25) : 0;
        lastStep = fxFrameStep(dt);
      } else stats.redraws += 1;
      const list = drawable();
      const sheet = overlayReady() ? overlaySheet() : null;
      const overlayMade = sheet ? programs.get('overlay') : null;
      if (!list.length && !overlayMade) return false;
      const under = Boolean(overlayMade && sheet.blend?.under);
      const over = Boolean(overlayMade && !under);
      const reactionsMade = list.length && reactions && !reactionsIdle(reactions) ? ready('reactions', REACTION_SRC) : null;
      const total = (under ? 1 : 0) + list.length + (reactionsMade ? 1 : 0) + (over ? 1 : 0);
      let readTex = capture.tex;
      let usePing = true;
      let onScreen = false;
      let step = 0; // steps drawn so far (the last one draws to the screen)
      const fstep = lastStep;
      stats.frames += 1;
      /** The next ping-pong target. */
      const spare = () => {
        if (usePing) { if (!ping) ping = makeTarget(); return ping; }
        if (!pong) pong = makeTarget();
        return pong;
      };
      if (under) {
        // Under the effects: blended into the scene before the first pass.
        const last = step === total - 1;
        const target = last ? null : spare();
        drawOverlay(overlayMade, sheet, readTex, target ? target.fb : null);
        step += 1;
        if (target) { readTex = target.tex; usePing = !usePing; } else onScreen = true;
      }
      for (let index = 0; index < list.length; index += 1) {
        const pass = list[index];
        const made = programs.get(pass.id);
        const last = step === total - 1;
        step += 1;
        let writeFb = null;
        let writeTex = null;
        let prevTex = null;
        const history = Boolean(pass.fx.def.options?.history);
        const feeds = history && !repeat; // this draw moves its history on
        if (history && !pass.hist) pass.hist = { targets: [makeTarget(), makeTarget()], index: 0, fresh: true, written: 0 };
        if (feeds) {
          const { hist } = pass;
          writeFb = hist.targets[hist.index].fb;
          writeTex = hist.targets[hist.index].tex;
          // A fresh history starts from the picture coming in, not black.
          prevTex = hist.fresh ? readTex : hist.targets[1 - hist.index].tex;
        } else if (history) {
          // A redraw: the last frame's own u_prev (the frame before it, or
          // the picture coming in when it was the first), drawn through a
          // spare target; its two frames stay as they are.
          const { hist } = pass;
          prevTex = hist.written < 2 ? readTex : hist.targets[hist.index].tex;
        }
        if (!feeds && !last) {
          if (usePing) { if (!ping) ping = makeTarget(); writeFb = ping.fb; writeTex = ping.tex; } else {
            if (!pong) pong = makeTarget();
            writeFb = pong.fb;
            writeTex = pong.tex;
          }
        }
        g.bindFramebuffer(g.FRAMEBUFFER, writeFb);
        g.viewport(0, 0, width, height);
        g.useProgram(made.program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, readTex);
        set1i(made, 'u_tex', 0);
        if (prevTex) {
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, prevTex);
          set1i(made, 'u_prev', 1);
          g.activeTexture(g.TEXTURE0);
        }
        const res = location(made, 'u_resolution');
        if (res !== null && res !== undefined) g.uniform2f(res, width, height);
        set1f(made, 'u_time', Number(state?.time) || 0);
        set1f(made, 'u_fstep', fstep);
        if (pass.fx.def.options?.trigger) set1f(made, 'u_age', triggerAge(pass, state || {}));
        const values = pass.links.length ? applyLinks(pass.values, pass.links, state?.sources, pass.drawValues) : pass.values;
        for (const name in values) set1f(made, `u_${name}`, values[name]);
        drawQuad(made);
        if (prevTex) {
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, null);
          g.activeTexture(g.TEXTURE0);
        }
        if (feeds) {
          pass.hist.fresh = false;
          pass.hist.written += 1;
          pass.hist.index = 1 - pass.hist.index;
          stats.historySteps += 1;
          readTex = writeTex;
        } else if (writeFb) {
          readTex = writeTex;
          usePing = !usePing;
        } else {
          onScreen = true;
        }
      }
      if (reactionsMade) {
        const made = reactionsMade;
        const target = over ? spare() : null;
        g.bindFramebuffer(g.FRAMEBUFFER, target ? target.fb : null);
        g.viewport(0, 0, width, height);
        g.useProgram(made.program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, readTex);
        set1i(made, 'u_tex', 0);
        const res = location(made, 'u_resolution');
        if (res !== null && res !== undefined) g.uniform2f(res, width, height);
        set1f(made, 'u_zoom', 1);
        set1f(made, 'u_rot', reactions.rot);
        set1f(made, 'u_flash', reactions.flash);
        set1f(made, 'u_hue', reactions.hue);
        set1f(made, 'u_chroma', reactions.chroma);
        set1f(made, 'u_pump', reactions.pump);
        const shake = location(made, 'u_shake');
        if (shake !== null && shake !== undefined) g.uniform2f(shake, reactions.shakeX, reactions.shakeY);
        drawQuad(made);
        step += 1;
        if (target) { readTex = target.tex; usePing = !usePing; } else onScreen = true;
      }
      if (over) {
        // On top of the effects (and their reactions): the last step.
        drawOverlay(overlayMade, sheet, readTex, null);
        step += 1;
        onScreen = true;
      }
      if (!onScreen) {
        // The last pass was a feedback pass (it draws into its own frames).
        const made = programs.get('blit');
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.viewport(0, 0, width, height);
        if (made?.state === 'ready') {
          g.useProgram(made.program);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, readTex);
          set1i(made, 'u_tex', 0);
          drawQuad(made);
        }
      }
      g.bindTexture(g.TEXTURE_2D, null);
      return true;
    },

    /** Free the framebuffers and textures (they are made again when needed). */
    free() { freeTargets(); },

    /** The context was lost: everything went with it. */
    contextLost() {
      capture = null;
      ping = null;
      pong = null;
      quad = null;
      overlayTex = null;
      overlayVersion = -1;
      overlayW = 0;
      overlayH = 0;
      for (const pass of passes) { pass.hist = null; pass.beat = null; }
      programs.clear();
      linking.length = 0;
      drawDirty = true;
      parallel = undefined;
      countPrograms();
      width = 0;
      height = 0;
    },

    /** After the context came back (`next`: the context, if a new object):
     *  the passes' programs compile again. */
    restore(next = context) {
      context = next;
      chain.contextLost();
      stats.resets += 1;
      if (passes.length && alive()) chain.setPasses(passes.map((pass) => ({ ...pass })));
      if (overlay && alive()) chain.setOverlay(overlay);
    },

    /** Everything deleted, but a program still linking: deleting one mid-link
     *  is what made drivers warn (scene-renderer.js); the context is lost next
     *  (the renderer's destroy), which frees it. */
    destroy() {
      freeTargets();
      poll(); // links finished by now are deleted below
      for (const entry of programs.values()) {
        if (entry.state === 'linking') continue;
        if (entry.program || entry.vs || entry.fs) stats.programsDeleted += 1;
        dropEntry(entry);
      }
      programs.clear();
      linking.length = 0;
      countPrograms();
      passes = [];
      overlay = null;
      drawList.length = 0;
      context = null;
    },
  };
  return chain;
}
