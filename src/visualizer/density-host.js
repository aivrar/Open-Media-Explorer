/**
 * The host for Psychedelia's progressive density labs (Attractor Density
 * Lab, Buddhabrot Lab, Flame Density Lab): it stands in for Psychedelia's
 * ProgressiveDensityRenderer (engine/progressive-density-renderer.js, not
 * imported) with the same create(options) -> { init, render, cleanup,
 * getDiagnostics } the labs call. Each lab builds its picture point by point
 * in Psychedelia's density worker (workers/progressive-density-worker.js,
 * vendored; started from visualizer/density-worker.js), which sends back the
 * picture so far as RGBA pixels; here they are drawn as a texture.
 *
 * What it adds to keep the app light:
 *
 *   - a duty cycle: each message asks the worker for one bounded slice of
 *     work (budgetMs, with deadlineMs as its hard limit), then nothing is
 *     asked until the worker has been idle long enough that its busy time is
 *     at most the quality's share of one core (DENSITY_QUALITY share). The
 *     wait is counted from when the slice was asked for, so a slow frame or
 *     a stall never makes a burst of catch-up work. No timers: the next
 *     slice is asked for from a drawn frame;
 *   - a stop: a picture is finished when it has the quality's sample budget
 *     (DENSITY_SAMPLES) or its worker has spent the quality's work budget
 *     (workMs), whichever comes first; the worker is then ended. A change
 *     of look or of any value starts a new picture (no drift: the labs'
 *     motion is held still, accumulating-scenes.js);
 *   - one worker at most, in the whole app (starting one ends any other);
 *   - nothing left behind: the worker ends (its message handlers removed
 *     first) when the scene goes, the tab closes or the context is lost, and
 *     a message that still arrives from it is dropped. A still picture
 *     (paused, reduced motion) or a hidden tab asks for nothing more, and no
 *     timer runs: the worker stays idle until the picture moves again;
 *   - no worker while nothing is drawn: when the tab is hidden, the window
 *     minimised or its frames throttled (wherever the loop goes idle), the
 *     app ends the worker (suspendDensityWorker). The picture so far stays
 *     on screen; when frames are drawn again a new picture is started and
 *     mixed in over it as it fills, as after a change;
 *   - no allocation per frame here: the worker's pixel buffer goes back to
 *     it with the next request (transferred, not copied) and is filled again
 *     in place;
 *   - steady brightness: a new picture never replaces the old one at once.
 *     The old picture (or the plain background on a first visit) stays and
 *     the new one is mixed in as it fills (DENSITY_FADE_AT of its budget for
 *     all of it), at most DENSITY_FADE_RATE a second of the picture's time;
 *     a change in the middle of a mix first takes the new picture back out
 *     at that rate. The worker itself scales each picture to a white point
 *     taken from its brightest pixels, so a picture is as bright from its
 *     first frames as when it is finished (it only fills in). That white
 *     point is eased here from reply to reply (easeWhiteScale): it changes by
 *     at most DENSITY_WHITE_STEP a reply and DENSITY_WHITE_RATE a second as
 *     a multiple of the mean lit pixel (which grows with the picture as it
 *     fills evenly), so the pixels already there never change brightness at
 *     once (the worker's own measure jumps when it first has enough lit
 *     pixels to take a percentile instead of the brightest pixel, and when a
 *     pixel grows hot).
 */

/** Per quality: share (of one core the worker may be busy), budgetMs (one
 *  slice of work), scale and maxSide (the picture's size: a share of the
 *  canvas, and its longest side), samples (times the lab's sample budget,
 *  DENSITY_SAMPLES) and workMs (the most worker time one picture may take). */
export const DENSITY_QUALITY = Object.freeze({
  low: Object.freeze({ share: 0.15, budgetMs: 6, scale: 0.35, maxSide: 512, samples: 0.5, workMs: 6000 }),
  medium: Object.freeze({ share: 0.25, budgetMs: 8, scale: 0.45, maxSide: 768, samples: 1, workMs: 10000 }),
  high: Object.freeze({ share: 0.35, budgetMs: 10, scale: 0.6, maxSide: 1024, samples: 2, workMs: 15000 }),
});

/** A picture's sample budget at quality samples 1, by the worker's density
 *  type: Buddhabrot orbits; attractor points (particles or orbits times
 *  their steps); flame points plotted (samples times their plotted steps). */
export const DENSITY_SAMPLES = Object.freeze({ buddhabrot: 4e6, attractor: 4e7, flam3: 6e6 });

/** How much of a new picture is in the mix, at most, by how far it has
 *  filled (its share of its budget): all of it from DENSITY_FADE_AT. */
export const DENSITY_FADE_AT = 0.1;
/** The most the mix moves in one second of the picture's time. */
export const DENSITY_FADE_RATE = 0.5;
/** The white point (a multiple of the mean lit pixel) changes by at most this
 *  factor from one reply to the next... */
export const DENSITY_WHITE_STEP = 1.1;
/** ...and by at most this factor in a second. */
export const DENSITY_WHITE_RATE = 1.5;
/** The longest idle wait between slices (ms), whatever a slice took. */
export const DENSITY_MAX_WAIT_MS = 2000;
/** The most picture time one frame may count (seconds), without the host's
 *  own frame step. */
const MAX_STEP = 1 / 30;

/** The limits at `quality` (Medium's for an unknown one). */
export function densityLimits(quality) {
  return DENSITY_QUALITY[quality] || DENSITY_QUALITY.medium;
}

/** `last` (the white point shown, a multiple of the mean lit pixel, or null:
 *  none yet) moved toward `measured` by at most DENSITY_WHITE_STEP, and at
 *  most DENSITY_WHITE_RATE a second over `seconds`. */
export function easeWhiteScale(last, measured, seconds) {
  const want = Number(measured);
  if (!(want > 0) || !Number.isFinite(want)) return last;
  if (!(last > 0)) return want;
  const s = Math.max(0, Number(seconds) || 0);
  const most = Math.min(DENSITY_WHITE_STEP, DENSITY_WHITE_RATE ** s);
  return Math.min(last * most, Math.max(last / most, want));
}

/** The worker's share of one core is the quality's share times this
 *  (processor-budget.js densityShareScale: 1 at Light). */
let shareScale = 1;
export function setDensityShareScale(scale) {
  const n = Number(scale);
  shareScale = n > 0 && Number.isFinite(n) ? Math.min(n, 4) : 1;
}
/** The share of one core the worker may be busy at `quality`. */
export function densityShare(quality) {
  return Math.min(0.9, densityLimits(quality).share * shareScale);
}

// The stats of the density host made last (for the measuring page).
let lastStats = null;

// Each picture made gets a number; the latest one's mean brightness as
// shown (the stretched cross-fade into a density lab: transition.js).
let pictureCount = 0;
let latestPicture = null;
/** How many density pictures were made so far. */
export function densityPictureCount() {
  return pictureCount;
}
/** The mean brightness (0 to 1, Rec. 709 luma) of the density picture shown
 *  now, as far as it has faded in: of the latest picture made after
 *  `after` (a densityPictureCount() value), else 0. Sampled from the pixels
 *  received (DENSITY_MEAN_SAMPLES of them). */
export function densityShownMean(after = 0) {
  const picture = latestPicture;
  if (!picture || picture.number <= after || picture.cleaned) return 0;
  return picture.front.has ? (picture.front.mean || 0) * picture.mix : 0;
}
/** About how many pixels the mean brightness is sampled from. */
export const DENSITY_MEAN_SAMPLES = 4096;
/** The mean luma of RGBA `view` (bytes), sampled. */
export function sampledMean(view, samples = DENSITY_MEAN_SAMPLES) {
  const pixels = Math.floor(view.length / 4);
  if (!pixels) return 0;
  const step = Math.max(1, Math.floor(pixels / samples));
  let sum = 0;
  let count = 0;
  for (let at = 0; at < pixels; at += step) {
    const i = at * 4;
    sum += 0.2126 * view[i] + 0.7152 * view[i + 1] + 0.0722 * view[i + 2];
    count += 1;
  }
  return sum / count / 255;
}

/** What the density host made last counted (its stats object), or null. */
export function densityStatsNow() {
  return lastStats;
}

/** The app's density worker (a module worker bundled with the app). */
export function startDensityWorker() {
  return new Worker(new URL('./density-worker.js', import.meta.url), { type: 'module' });
}

const VERTEX = [
  'attribute vec2 a_position;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = a_position * 0.5 + 0.5;',
  '  gl_Position = vec4(a_position, 0.0, 1.0);',
  '}',
].join('\n');

const FRAGMENT = [
  'precision highp float;',
  'uniform sampler2D u_front;',
  'uniform sampler2D u_back;',
  'uniform vec2 u_front_texel;',
  'uniform vec2 u_back_texel;',
  'uniform float u_has_front;',
  'uniform float u_has_back;',
  'uniform float u_mix;',
  'uniform float u_sharpness;',
  'uniform float u_zoom;',
  'varying vec2 v_uv;',
  'const vec3 BACKGROUND = vec3(0.004, 0.005, 0.010);',
  'vec3 picture(sampler2D tex, vec2 uv, vec2 texel) {',
  '  vec3 c = texture2D(tex, uv).rgb;',
  '  if (u_sharpness > 0.001) {',
  '    vec3 blur = (texture2D(tex, uv + vec2(0.0, texel.y)).rgb + texture2D(tex, uv - vec2(0.0, texel.y)).rgb',
  '      + texture2D(tex, uv + vec2(texel.x, 0.0)).rgb + texture2D(tex, uv - vec2(texel.x, 0.0)).rgb) * 0.25;',
  '    c = clamp(c + (c - blur) * u_sharpness, 0.0, 1.0);',
  '  }',
  '  return c;',
  '}',
  'void main() {',
  '  vec2 uv = (v_uv - 0.5) / max(u_zoom, 1.0) + 0.5;',
  '  vec3 back = u_has_back > 0.5 ? picture(u_back, uv, u_back_texel) : BACKGROUND;',
  '  vec3 front = u_has_front > 0.5 ? picture(u_front, uv, u_front_texel) : BACKGROUND;',
  '  gl_FragColor = vec4(mix(back, front, u_mix), 1.0);',
  '}',
].join('\n');

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
};

/** Delete `object` if it is alive in `gl` (after a loss it is only dropped). */
function drop(gl, kind, object) {
  try { if (object && gl[`is${kind}`](object)) gl[`delete${kind}`](object); } catch (_) {}
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function makeProgram(gl, fragment) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) {
    drop(gl, 'Shader', vs);
    drop(gl, 'Shader', fs);
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function makeTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** The instance whose worker is alive (one at most, in the whole app). */
let working = null;

/** Workers alive now (0 or 1). */
export function liveDensityWorkers() {
  return working ? 1 : 0;
}

/** Nothing is drawn now (hidden, minimised, throttled, at rest): the worker
 *  ends. The picture so far stays; a new one starts when frames come again.
 *  True when a worker was ended. */
export function suspendDensityWorker() {
  return working ? working.suspend() : false;
}

/**
 * A stand-in for Psychedelia's ProgressiveDensityRenderer, given to the
 * density labs through G (accumulating-scenes.js).
 *
 * @param {object} G  what the scene renderer gives scenes: Renderer (the
 *   host's stand-in: getCanvas, bindFramebuffer, getViewZoom, getFrameStep)
 *   and sceneQuality (the quality drawn now)
 * @param {object} [options]
 * @param {function} [options.startWorker]  makes the worker (tests give a fake)
 * @param {function} [options.now]  a clock in milliseconds
 */
export function createDensityRenderer(G, {
  startWorker: makeWorker = startDensityWorker, now = () => globalThis.performance?.now?.() ?? Date.now(),
  backingLift = 0,
} = {}) {
  const backdrop = [0.004, 0.005, 0.010].map((channel) => backingLift + (1 - backingLift) * channel);
  const fragment = backingLift ? FRAGMENT.replace('mix(back, front, u_mix)',
    'mix(mix(back, front, u_mix), vec3(1.0), ' + backingLift + ')') : FRAGMENT;
  const Renderer = G.Renderer || {};
  const qualityNow = () => densityLimits(typeof G.sceneQuality === 'function' ? G.sceneQuality() : null);
  const stats = {
    instances: 0, workers: 0, ended: 0, posted: 0, frames: 0, stale: 0, late: 0, uploads: 0, finished: 0, failed: 0, busyMs: 0, suspended: 0,
  };
  lastStats = stats;

  function DensityInstance(options = {}) {
    stats.instances += 1;
    pictureCount += 1;
    this.number = pictureCount;
    latestPicture = this;
    this.name = options.name || 'progressive-density';
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.loc = null;
    this.maxTextureSize = 0;
    // The new picture (front) and the one it replaces (back).
    this.front = { texture: null, width: 0, height: 0, has: false };
    this.back = { texture: null, width: 0, height: 0, has: false };
    this.mix = 0;
    this.leaving = false; // the front picture goes out before a new one starts
    this.worker = null;
    this.failed = false;
    this.cleaned = false;
    this.inFlight = false;
    this.sentAt = 0;
    this.nextAt = 0;
    this.ready = null; // pixels received, not yet uploaded
    this.readyWidth = 0;
    this.readyHeight = 0;
    this.spare = null; // pixels uploaded, to go back to the worker
    this.generation = 0;
    this.requestId = 0;
    this.resetKey = null;
    this.tonemapKey = null;
    this.width = 0;
    this.height = 0;
    this.samples = 0;
    this.workMs = 0;
    this.finished = false;
    this.lastTime = null;
    this.sharpness = 0;
    this.transfer = [];
    // The white point shown (easeWhiteScale), and when it was last eased.
    this.whiteScale = null;
    this.whiteAt = 0;
    // Its worker was ended while nothing was drawn: a new picture next.
    this.suspended = false;
    this.tonemap = {
      exposure: 1.4, gamma: 0.9, gain: 1, glow: 0.7, curve: 1, palette: -1, colorPhase: 0,
    };
    this.message = {
      type: 'accumulate',
      requestId: 0,
      generation: 0,
      resetKey: '',
      densityType: 'test_spiral',
      width: 1,
      height: 1,
      batchSize: 12000,
      decay: 1,
      params: null,
      tonemap: this.tonemap,
      time: 0,
      budgetMs: 8,
      deadlineMs: 8,
      whiteScale: 0,
      image: null,
    };
  }

  const proto = DensityInstance.prototype;

  proto.init = function init(gl) {
    if (!gl) return false;
    if (this.gl === gl && this.program && gl.isProgram(this.program)) return true;
    this.release(this.gl);
    this.cleaned = false;
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.program = makeProgram(gl, fragment);
    if (!this.program) return false;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.front.texture = makeTexture(gl);
    this.back.texture = makeTexture(gl);
    const p = this.program;
    this.loc = {
      position: gl.getAttribLocation(p, 'a_position'),
      front: gl.getUniformLocation(p, 'u_front'),
      back: gl.getUniformLocation(p, 'u_back'),
      frontTexel: gl.getUniformLocation(p, 'u_front_texel'),
      backTexel: gl.getUniformLocation(p, 'u_back_texel'),
      hasFront: gl.getUniformLocation(p, 'u_has_front'),
      hasBack: gl.getUniformLocation(p, 'u_has_back'),
      mix: gl.getUniformLocation(p, 'u_mix'),
      sharpness: gl.getUniformLocation(p, 'u_sharpness'),
      zoom: gl.getUniformLocation(p, 'u_zoom'),
    };
    return true;
  };

  /** The size the picture should have now (wantWidth, wantHeight), from the
   *  canvas, the lab's own scale and the quality's limits. */
  proto.sizeFor = function sizeFor(config, q) {
    const canvas = Renderer.getCanvas ? Renderer.getCanvas() : this.gl.canvas;
    const scale = Math.min(clamp(config.resolutionScale, 0.05, 1, q.scale), q.scale);
    const maxSide = Math.max(64, Math.min(clamp(config.maxSide, 64, 4096, q.maxSide), q.maxSide, this.maxTextureSize || 4096));
    let width = Math.max(1, Math.floor((canvas?.width || 1) * scale));
    let height = Math.max(1, Math.floor((canvas?.height || 1) * scale));
    const ratio = Math.min(1, maxSide / Math.max(width, height));
    width = Math.max(1, Math.floor(width * ratio));
    height = Math.max(1, Math.floor(height * ratio));
    this.wantWidth = width;
    this.wantHeight = height;
  };

  /** The picture time this frame moves on by (0: a still frame). */
  proto.frameStep = function frameStep(time) {
    if (typeof Renderer.getFrameStep === 'function') {
      const step = Number(Renderer.getFrameStep());
      return step > 0 ? Math.min(step, MAX_STEP) : 0;
    }
    const t = Number(time) || 0;
    const step = this.lastTime === null ? 1 / 60 : t - this.lastTime;
    this.lastTime = t;
    return step > 0 ? Math.min(step, MAX_STEP) : 0;
  };

  proto.render = function render(gl, time, config = {}) {
    if (!this.init(gl)) return false;
    const q = qualityNow();
    this.sizeFor(config, q);
    this.sharpness = clamp(config.sharpness, 0, 1.5, 0);
    const resetKey = String(config.resetKey ?? '');
    const tonemapKey = String(config.tonemapKey ?? '');
    const step = this.frameStep(time);
    if (step > 0) {
      if (this.suspended || resetKey !== this.resetKey || tonemapKey !== this.tonemapKey
        || this.wantWidth !== this.width || this.wantHeight !== this.height) {
        this.suspended = false;
        this.change(resetKey, tonemapKey);
      }
      this.upload();
      this.fade(step, config, q);
      this.ask(config, time, q);
    }
    this.draw(gl);
    return true;
  };

  /** Something the picture is made from changed: a new picture. */
  proto.change = function change(resetKey, tonemapKey) {
    this.resetKey = resetKey;
    this.tonemapKey = tonemapKey;
    if (this.front.has && this.mix >= 1) {
      // The finished (or fully shown) picture becomes the old one.
      const old = this.back;
      this.back = this.front;
      this.front = old;
      this.front.has = false;
      this.mix = 0;
      this.leaving = false;
      this.restart();
    } else if (this.front.has) {
      // Part way in: it goes back out first (fade), then the new one starts.
      this.leaving = true;
    } else {
      this.mix = 0;
      this.leaving = false;
      this.restart();
    }
  };

  /** A new picture starts accumulating (its worker messages are new). */
  proto.restart = function restart() {
    this.generation += 1;
    this.width = this.wantWidth;
    this.height = this.wantHeight;
    this.samples = 0;
    this.workMs = 0;
    this.finished = false;
    // Pixels of the old picture not shown yet: their buffer is used again.
    if (this.ready && !this.spare) this.spare = this.ready;
    // (The duty cycle's wait stands: a new picture asks no sooner.)
    this.ready = null;
  };

  /** How far the new picture has filled (0 to 1). */
  proto.progress = function progress(config, q) {
    if (this.finished) return 1;
    const budget = (DENSITY_SAMPLES[config.densityType] || DENSITY_SAMPLES.buddhabrot) * q.samples;
    return Math.min(1, Math.max(this.samples / budget, this.workMs / q.workMs));
  };

  proto.fade = function fade(step, config, q) {
    const most = DENSITY_FADE_RATE * step;
    if (this.leaving) {
      this.mix = Math.max(0, this.mix - most);
      if (this.mix === 0) {
        this.front.has = false;
        this.leaving = false;
        this.restart();
      }
      return;
    }
    const target = this.front.has ? Math.min(1, this.progress(config, q) / DENSITY_FADE_AT) : 0;
    if (this.mix < target) this.mix = Math.min(target, this.mix + most);
  };

  /** Pixels received go into the front picture's texture. */
  proto.upload = function upload() {
    const pixels = this.ready;
    if (!pixels || !this.gl || !this.front.texture) return;
    this.ready = null;
    const gl = this.gl;
    const width = this.readyWidth;
    const height = this.readyHeight;
    const view = new Uint8Array(pixels);
    gl.bindTexture(gl.TEXTURE_2D, this.front.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.front.width === width && this.front.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, view);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
      this.front.width = width;
      this.front.height = height;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.front.has = true;
    this.front.mean = sampledMean(view);
    stats.uploads += 1;
    // Back to the worker with the next request; not kept once finished.
    this.spare = this.finished ? null : pixels;
  };

  /** Ask the worker for one more slice, if the duty cycle allows it. */
  proto.ask = function ask(config, time, q) {
    if (this.finished || this.leaving || this.inFlight || this.failed || this.cleaned) return;
    const t = now();
    if (t < this.nextAt) return;
    if (!this.worker && !this.startWorker()) return;
    const m = this.message;
    const tone = config.tonemap || {};
    this.requestId += 1;
    m.requestId = this.requestId;
    m.generation = this.generation;
    m.resetKey = this.resetKey;
    m.densityType = String(config.densityType || 'test_spiral');
    m.width = this.width;
    m.height = this.height;
    m.batchSize = Math.floor(clamp(config.batchSize, 1, 200000, 12000));
    // No fading: every picture is built to a finished one.
    m.decay = 1;
    m.params = config.params || null;
    m.time = Number(time) || 0;
    m.budgetMs = q.budgetMs;
    m.deadlineMs = q.budgetMs;
    m.whiteScale = this.whiteScale > 0 ? this.whiteScale : 0;
    this.tonemap.exposure = clamp(tone.exposure, 0.01, 12, 1.4);
    this.tonemap.gamma = clamp(tone.gamma, 0.2, 4, 0.9);
    this.tonemap.gain = clamp(tone.gain, 0.05, 8, 1);
    this.tonemap.glow = clamp(tone.glow, 0, 4, 0.7);
    this.tonemap.curve = clamp(tone.curve, 0.25, 3, 1);
    this.tonemap.palette = Math.floor(clamp(tone.palette, -1, 12, -1));
    this.tonemap.colorPhase = clamp(tone.colorPhase, -100000, 100000, 0);
    this.transfer.length = 0;
    const spare = this.spare;
    this.spare = null;
    if (spare && spare.byteLength === this.width * this.height * 4) {
      m.image = spare;
      this.transfer.push(spare);
    } else {
      m.image = null;
    }
    this.unit = m.densityType === 'attractor' ? Math.max(1, Number(m.params?.steps) || 1)
      : (m.densityType === 'flam3' ? Math.max(1, Number(m.params?.plotOrbit) || 1) : 1);
    try {
      this.worker.postMessage(m, this.transfer);
    } catch (_) {
      this.fail();
      return;
    }
    m.image = null;
    m.params = null;
    this.transfer.length = 0;
    this.inFlight = true;
    this.sentAt = t;
    stats.posted += 1;
  };

  proto.startWorker = function startWorker() {
    if (working && working !== this) working.endWorker();
    let worker;
    try {
      worker = makeWorker();
    } catch (_) {
      this.fail();
      return false;
    }
    if (!worker) {
      this.fail();
      return false;
    }
    this.worker = worker;
    working = this;
    stats.workers += 1;
    worker.onmessage = (event) => this.receive(worker, event);
    worker.onerror = (event) => {
      if (worker !== this.worker) return;
      try { event?.preventDefault?.(); } catch (_) {}
      this.fail();
    };
    return true;
  };

  /** Nothing is drawn: the worker ends, the picture so far stays. A finished
   *  picture has no worker and stays as it is. */
  proto.suspend = function suspend() {
    if (!this.worker) return false;
    this.endWorker();
    this.suspended = true;
    stats.suspended += 1;
    return true;
  };

  /** The worker cannot run here: the lab shows what it has (or nothing). */
  proto.fail = function fail() {
    this.failed = true;
    stats.failed += 1;
    this.endWorker();
  };

  /** End the worker (its handlers first: nothing it still sends arrives). */
  proto.endWorker = function endWorker() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.inFlight = false;
    if (working === this) working = null;
    worker.onmessage = null;
    worker.onerror = null;
    try { worker.terminate(); } catch (_) {}
    stats.ended += 1;
  };

  /** A message from `worker`: a frame of the picture, or one too late. */
  proto.receive = function receive(worker, event) {
    if (worker !== this.worker || this.cleaned) {
      stats.late += 1;
      return;
    }
    const data = event?.data;
    if (!data || data.type !== 'frame') return;
    this.inFlight = false;
    const busy = Number.isFinite(data.workMs) ? Math.max(1, data.workMs) : Math.max(1, now() - this.sentAt);
    stats.busyMs += busy;
    const q = qualityNow();
    this.nextAt = this.sentAt + Math.min(DENSITY_MAX_WAIT_MS, busy / densityShare(G.sceneQuality?.()));
    const image = data.image;
    if (data.generation !== this.generation) {
      stats.stale += 1;
      if (image && image.byteLength === this.width * this.height * 4) this.spare = image;
      return;
    }
    stats.frames += 1;
    // The white point these pixels were drawn with was the one sent; the
    // next is eased toward what the worker measured.
    const t = now();
    this.whiteScale = easeWhiteScale(this.whiteScale, Number(data.whiteScale), this.whiteAt ? (t - this.whiteAt) / 1000 : 0);
    this.whiteAt = t;
    this.samples += (Number(data.lastBatchSize) || 0) * (this.unit || 1);
    this.workMs += busy;
    const width = Math.floor(Number(data.width) || 0);
    const height = Math.floor(Number(data.height) || 0);
    if (image && width > 0 && height > 0 && width <= this.maxTextureSize && height <= this.maxTextureSize
      && image.byteLength === width * height * 4) {
      this.ready = image;
      this.readyWidth = width;
      this.readyHeight = height;
    }
    if (this.samples >= this.budget(q) || this.workMs >= q.workMs) {
      // Finished: the worker ends; its last picture is the one kept.
      this.finished = true;
      stats.finished += 1;
      this.spare = null;
      this.endWorker();
    }
  };

  proto.budget = function budget(q) {
    return (DENSITY_SAMPLES[this.message.densityType] || DENSITY_SAMPLES.buddhabrot) * q.samples;
  };

  proto.draw = function draw(gl) {
    const canvas = Renderer.getCanvas ? Renderer.getCanvas() : gl.canvas;
    if (Renderer.bindFramebuffer) Renderer.bindFramebuffer(-1);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const front = this.front;
    const back = this.back;
    const showFront = front.has && this.mix > 0;
    if (!this.program || (!showFront && !back.has)) {
      gl.clearColor(backdrop[0], backdrop[1], backdrop[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const loc = this.loc;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front.texture);
    gl.uniform1i(loc.front, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, back.texture);
    gl.uniform1i(loc.back, 1);
    gl.uniform2f(loc.frontTexel, 1 / Math.max(front.width, 1), 1 / Math.max(front.height, 1));
    gl.uniform2f(loc.backTexel, 1 / Math.max(back.width, 1), 1 / Math.max(back.height, 1));
    gl.uniform1f(loc.hasFront, showFront ? 1 : 0);
    gl.uniform1f(loc.hasBack, back.has ? 1 : 0);
    gl.uniform1f(loc.mix, showFront ? this.mix : 0);
    gl.uniform1f(loc.sharpness, this.sharpness);
    gl.uniform1f(loc.zoom, Math.max(1, Number(Renderer.getViewZoom ? Renderer.getViewZoom() : 1) || 1));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(loc.position);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  };

  /** Free the graphics objects and end the worker. */
  proto.release = function release(gl) {
    this.endWorker();
    const g = gl || this.gl;
    if (g) {
      drop(g, 'Texture', this.front.texture);
      drop(g, 'Texture', this.back.texture);
      drop(g, 'Buffer', this.buffer);
      drop(g, 'Program', this.program);
    }
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.loc = null;
    this.front = { texture: null, width: 0, height: 0, has: false };
    this.back = { texture: null, width: 0, height: 0, has: false };
    this.mix = 0;
    this.leaving = false;
    this.ready = null;
    this.spare = null;
    this.resetKey = null;
    this.tonemapKey = null;
    this.width = 0;
    this.height = 0;
    this.lastTime = null;
    this.whiteScale = null;
    this.whiteAt = 0;
    this.suspended = false;
  };

  proto.cleanup = function cleanup(gl) {
    this.cleaned = true;
    this.release(gl);
  };

  proto.getDiagnostics = function getDiagnostics() {
    return {
      name: this.name,
      generation: this.generation,
      width: this.width,
      height: this.height,
      samples: this.samples,
      workMs: this.workMs,
      finished: this.finished,
      mix: this.mix,
      leaving: this.leaving,
      inFlight: this.inFlight,
      worker: Boolean(this.worker),
      failed: this.failed,
      hasFront: this.front.has,
      hasBack: this.back.has,
      whiteScale: this.whiteScale,
      suspended: this.suspended,
      holding: Boolean(this.ready) + Boolean(this.spare),
    };
  };

  return Object.freeze({
    create: (options) => new DensityInstance(options),
    stats,
  });
}
