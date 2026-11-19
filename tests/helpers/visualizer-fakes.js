/** Doubles for the Visualizer tests: a WebGL context that records what it is
 *  asked (optionally with KHR_parallel_shader_compile), DOM elements, a
 *  ResizeObserver window and a reduced-motion query. No GPU anywhere. */

import { fakeVisibilityDoc } from './signal-harness.js';

export const COMPLETION_STATUS_KHR = 0x91b1;

export class FakeGL {
  constructor({ parallel = false } = {}) {
    Object.assign(this, {
      ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLE_STRIP: 5,
      VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
      MAX_VIEWPORT_DIMS: 0x0d3a, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_TEXTURE_SIZE: 0x0d33,
      TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, TEXTURE1: 0x84c1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, COLOR_ATTACHMENT0: 0x8ce0,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    });
    // Canvas uploads (the blended overlay): how many, and the last source.
    this.uploads = 0;
    this.lastUpload = null;
    this.pixelStore = new Map();
    // Post effects: framebuffers and textures alive now, and made in all;
    // draws into the screen (framebuffer null) apart from all draws.
    this.textures = new Set();
    this.framebuffers = new Set();
    this.framebuffersMade = 0;
    this.boundFramebuffer = null;
    this.screenDraws = 0;
    this.boundTextures = new Map();
    this.activeUnit = 0x84c0;
    // A roomy desktop GPU by default; tests lower these to play a small one.
    this.maxViewport = [16384, 16384];
    this.maxRenderbuffer = 16384;
    this.maxTexture = 16384;
    this.programs = new Set();
    this.shaders = new Set();
    this.buffers = new Set();
    this.sources = [];
    this.uniforms = new Map();
    this.lost = false;
    this.loseCount = 0;
    this.draws = 0;
    this.failCompile = false;
    // KHR_parallel_shader_compile: programs report "not finished" until the
    // test calls finishCompiles() (or `autoFinishAfter` status checks).
    this.parallel = parallel;
    this.autoFinishAfter = Infinity;
    this.statusChecks = 0;
    this.extensionAsks = new Map();
  }
  createShader(type) { const shader = { type }; this.shaders.add(shader); return shader; }
  shaderSource(shader, source) { shader.source = source; this.sources.push({ type: shader.type, source }); }
  compileShader() {}
  getShaderParameter() { return !this.failCompile; }
  getShaderInfoLog() { return 'fake failure'; }
  deleteShader(shader) { this.shaders.delete(shader); }
  createProgram() { const program = { fragment: '', done: false, checks: 0 }; this.programs.add(program); return program; }
  attachShader(program, shader) { if (shader.type === this.FRAGMENT_SHADER) program.fragment = shader.source; }
  linkProgram() {}
  getProgramParameter(program, name) {
    if (name === COMPLETION_STATUS_KHR) {
      this.statusChecks += 1;
      program.checks += 1;
      return program.done || program.checks >= this.autoFinishAfter;
    }
    return true;
  }
  getProgramInfoLog() { return ''; }
  deleteProgram(program) { this.programs.delete(program); }
  isProgram(program) { return this.programs.has(program); }
  finishCompiles() { for (const program of this.programs) program.done = true; }
  getExtension(name) {
    this.extensionAsks.set(name, (this.extensionAsks.get(name) || 0) + 1);
    if (name === 'WEBGL_lose_context') return { loseContext: () => { this.lost = true; this.loseCount += 1; } };
    if (name === 'KHR_parallel_shader_compile' && this.parallel) return { COMPLETION_STATUS_KHR };
    return null;
  }
  isContextLost() { return this.lost; }
  getParameter(name) {
    if (this.lost) return null; // as a real lost context answers
    if (name === this.MAX_VIEWPORT_DIMS) return new Int32Array(this.maxViewport);
    if (name === this.MAX_RENDERBUFFER_SIZE) return this.maxRenderbuffer;
    if (name === this.MAX_TEXTURE_SIZE) return this.maxTexture;
    return null;
  }
  createBuffer() { const buffer = {}; this.buffers.add(buffer); return buffer; }
  deleteBuffer(buffer) { this.buffers.delete(buffer); }
  bindBuffer() {}
  bufferData() {}
  getAttribLocation() { return 0; }
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  bindFramebuffer(target, fb) { this.boundFramebuffer = fb || null; }
  createTexture() { const texture = {}; this.textures.add(texture); return texture; }
  deleteTexture(texture) { this.textures.delete(texture); }
  texImage2D(...args) {
    // The 6-argument form uploads a canvas or image (the 9-argument one only
    // sizes a render target).
    if (args.length === 6) { this.uploads += 1; this.lastUpload = args[5]; }
  }
  pixelStorei(name, value) { this.pixelStore.set(name, value); }
  texParameteri() {}
  createFramebuffer() { const fb = {}; this.framebuffers.add(fb); this.framebuffersMade += 1; return fb; }
  deleteFramebuffer(fb) { this.framebuffers.delete(fb); }
  framebufferTexture2D() {}
  activeTexture(unit) { this.activeUnit = unit; }
  bindTexture(target, texture) { this.boundTextures.set(this.activeUnit, texture || null); }
  uniform1i(at, v) { this.uniforms.set(at.name, [v]); }
  viewport(x, y, w, h) { this.viewportSize = [w, h]; }
  useProgram(program) { this.current = program; }
  // Like a real driver: no location for a uniform the program does not use.
  getUniformLocation(program, name) { return new RegExp(`\\b${name}\\b`).test(program.fragment) ? { name } : null; }
  uniform1f(at, v) { this.uniforms.set(at.name, [v]); }
  uniform2f(at, a, b) { this.uniforms.set(at.name, [a, b]); }
  uniform4f(at, a, b, c, d) { this.uniforms.set(at.name, [a, b, c, d]); }
  uniform2fv(at, v) { this.uniforms.set(at.name, [...v]); }
  uniform3fv(at, v) { this.uniforms.set(at.name, [...v]); }
  uniform4fv(at, v) { this.uniforms.set(at.name, [...v]); }
  drawArrays() { this.draws += 1; if (!this.boundFramebuffer) this.screenDraws += 1; }
}

/** A FakeGL that records every call made with a deleted object or with an
 *  object of the wrong kind (a shader where a program is expected, and the
 *  other way round), and every program deleted while its parallel link is
 *  still running (what a real driver may still look up afterwards). */
export class StrictGL extends FakeGL {
  constructor(options) {
    super(options);
    this.misuse = [];
    this.deleted = new WeakSet();
    this.kind = new WeakMap();
  }
  check(method, object, kind) {
    if (object === null || object === undefined) return;
    if (this.deleted.has(object)) this.misuse.push(`${method}: deleted ${kind}`);
    else if (this.kind.get(object) !== kind) this.misuse.push(`${method}: ${this.kind.get(object) || 'unknown'} where a ${kind} is expected`);
  }
  createShader(type) { const shader = super.createShader(type); this.kind.set(shader, 'shader'); return shader; }
  createProgram() { const program = super.createProgram(); this.kind.set(program, 'program'); return program; }
  shaderSource(shader, source) { this.check('shaderSource', shader, 'shader'); super.shaderSource(shader, source); }
  compileShader(shader) { this.check('compileShader', shader, 'shader'); }
  getShaderParameter(shader, name) { this.check('getShaderParameter', shader, 'shader'); return super.getShaderParameter(shader, name); }
  getShaderInfoLog(shader) { this.check('getShaderInfoLog', shader, 'shader'); return super.getShaderInfoLog(shader); }
  deleteShader(shader) {
    if (shader && this.kind.get(shader) !== 'shader') this.misuse.push('deleteShader: not a shader');
    if (shader) this.deleted.add(shader);
    super.deleteShader(shader);
  }
  attachShader(program, shader) { this.check('attachShader', program, 'program'); this.check('attachShader', shader, 'shader'); super.attachShader(program, shader); }
  linkProgram(program) { this.check('linkProgram', program, 'program'); }
  getProgramParameter(program, name) { this.check('getProgramParameter', program, 'program'); return super.getProgramParameter(program, name); }
  getProgramInfoLog(program) { this.check('getProgramInfoLog', program, 'program'); return ''; }
  useProgram(program) { this.check('useProgram', program, 'program'); super.useProgram(program); }
  getUniformLocation(program, name) { this.check('getUniformLocation', program, 'program'); return super.getUniformLocation(program, name); }
  getAttribLocation(program) { this.check('getAttribLocation', program, 'program'); return 0; }
  deleteProgram(program) {
    if (program && this.kind.get(program) !== 'program') this.misuse.push('deleteProgram: not a program');
    else if (program && this.deleted.has(program)) this.misuse.push('deleteProgram: twice');
    else if (program && this.parallel && !program.done && program.checks < this.autoFinishAfter) this.misuse.push('deleteProgram: still linking');
    if (program) this.deleted.add(program);
    super.deleteProgram(program);
  }
}

/** Canvas 2D context double: every method is accepted and counted (by name),
 *  properties keep what is set; gradients and patterns are inert objects. */
export class Fake2D {
  constructor(canvas) {
    Object.assign(this, {
      canvas,
      calls: new Map(),
      total: 0,
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      shadowBlur: 0,
      shadowColor: 'rgba(0, 0, 0, 0)',
      filter: 'none',
      imageSmoothingEnabled: true,
    });
    return new Proxy(this, {
      get: (target, name) => {
        if (name in target || typeof name !== 'string') return target[name];
        return (...args) => target.record(name, args);
      },
    });
  }
  count(name) { return this.calls.get(name) || 0; }
  record(name) {
    this.total += 1;
    this.calls.set(name, (this.calls.get(name) || 0) + 1);
    if (name === 'createLinearGradient' || name === 'createRadialGradient' || name === 'createConicGradient') return { addColorStop() {} };
    if (name === 'createPattern') return {};
    if (name === 'measureText') return { width: 10 };
    if (name === 'getImageData' || name === 'createImageData') return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    if (name === 'isPointInPath' || name === 'isPointInStroke') return false;
    return undefined;
  }
}

export class FakeNodeEl extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.width = 300;
    this.height = 150;
    this.listenerCount = 0;
    this.style = {};
    this.parts = new Map();
    this.rect = null; // layout size in CSS pixels; none: not laid out
    const names = new Set();
    this.classList = {
      add: (name) => names.add(name), remove: (name) => names.delete(name), contains: (name) => names.has(name),
    };
  }
  addEventListener(name, fn, options) { this.listenerCount += 1; super.addEventListener(name, fn, options); }
  removeEventListener(name, fn, options) { this.listenerCount -= 1; super.removeEventListener(name, fn, options); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return this.rect || { width: 0, height: 0 }; }
  /** A canvas's 2D context (Fake2D, one per canvas); nothing else. */
  getContext(kind) {
    if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
    if (!this.context2d) this.context2d = new Fake2D(this);
    return this.context2d;
  }
  set innerHTML(html) { this.html = html; }
  get innerHTML() { return this.html || ''; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new FakeNodeEl('span'));
    return this.parts.get(selector);
  }
  /** This element or one below it. */
  contains(node) { return node === this || this.descendants().includes(node); }
  /** Every element below this one (depth first). */
  descendants() {
    const out = [];
    for (const child of this.children) {
      if (child instanceof FakeNodeEl) out.push(child, ...child.descendants());
    }
    return out;
  }
}

export function fakeMotion(initial = false) {
  const listeners = new Set();
  const query = {
    matches: initial,
    addEventListener: (name, fn) => listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
  };
  return {
    listeners,
    win: { matchMedia: (text) => (text.includes('reduced-motion') ? query : { matches: false, addEventListener() {}, removeEventListener() {} }) },
    set(value) { query.matches = value; for (const fn of [...listeners]) fn(); },
  };
}

export function fakeDocWithElements(layout = null) {
  const vis = fakeVisibilityDoc();
  vis.doc.createElement = (tag) => {
    const element = new FakeNodeEl(tag);
    if (layout) element.rect = { ...layout };
    return element;
  };
  vis.press = (init) => {
    const event = { preventDefault() { event.prevented = true; }, prevented: false, ...init };
    for (const fn of [...(vis.listeners.get('keydown') || [])]) fn(event);
    return event;
  };
  return vis;
}

export function fakeResizeObserverWin(motion) {
  const observers = [];
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.observed.push({ target, options }); }
    disconnect() { this.disconnected = true; }
    fire(width, height) { this.callback([{ devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }] }]); }
  }
  return { ...motion.win, ResizeObserver, devicePixelRatio: 1.25, observers };
}

/** Let promises (a scene module's dynamic import) settle: real macrotasks,
 *  until `done()` holds or `tries` run out. */
export async function settle(done = () => false, tries = 200) {
  for (let index = 0; index < tries; index += 1) {
    if (done()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return done();
}
