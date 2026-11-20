/** A WebGL 2 double for the scenes that own their passes (sim-host.js): every
 *  object kind they make is counted alive (create / is / delete), framebuffers
 *  are complete, float extensions can be offered or not, and the calls the
 *  simulations make (points, blending, clears, sub-image uploads) are
 *  accepted. No GPU anywhere. As WebGL2RenderingContext (withWebgl2Global)
 *  the scenes' own "is this WebGL 2" checks pass. */

import { FakeGL } from './visualizer-fakes.js';

const KINDS = ['Texture', 'Framebuffer', 'Renderbuffer', 'Buffer', 'Program', 'Shader', 'VertexArray'];

export class SimGL extends FakeGL {
  constructor({ float = true, half = float, canvas = { width: 320, height: 180 }, ...options } = {}) {
    super(options);
    Object.assign(this, {
      RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8814, HALF_FLOAT: 0x140b, NEAREST: 0x2600, MIRRORED_REPEAT: 0x8370,
      FRAMEBUFFER_COMPLETE: 0x8cd5, ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89, POINTS: 0, TRIANGLES: 4,
      BLEND: 0x0be2, DEPTH_TEST: 0x0b71, ONE: 1, COLOR_BUFFER_BIT: 0x4000, TEXTURE7: 0x84c7,
    });
    this.canvas = canvas;
    this.float = float;
    this.half = half;
    this.alive = Object.fromEntries(KINDS.map((kind) => [kind, new Set()]));
    this.pointDraws = 0;
    this.blending = false;
    this.subImages = 0;
    this.clears = 0;
  }

  /** Objects of every kind alive now: { Texture: n, ... } (only those > 0). */
  aliveCounts() {
    const out = {};
    for (const kind of KINDS) {
      const n = this.alive[kind].size;
      if (n) out[kind] = n;
    }
    return out;
  }

  getExtension(name) {
    if (name === 'EXT_color_buffer_float') { super.getExtension(name); return this.float ? {} : null; }
    if (name === 'EXT_color_buffer_half_float') { super.getExtension(name); return this.half ? {} : null; }
    return super.getExtension(name);
  }

  createTexture() { const o = super.createTexture(); this.alive.Texture.add(o); return o; }
  deleteTexture(o) { super.deleteTexture(o); this.alive.Texture.delete(o); }
  isTexture(o) { return this.alive.Texture.has(o); }
  createFramebuffer() { const o = super.createFramebuffer(); this.alive.Framebuffer.add(o); return o; }
  deleteFramebuffer(o) { super.deleteFramebuffer(o); this.alive.Framebuffer.delete(o); }
  isFramebuffer(o) { return this.alive.Framebuffer.has(o); }
  createBuffer() { const o = super.createBuffer(); this.alive.Buffer.add(o); return o; }
  deleteBuffer(o) { super.deleteBuffer(o); this.alive.Buffer.delete(o); }
  isBuffer(o) { return this.alive.Buffer.has(o); }
  createProgram() { const o = super.createProgram(); this.alive.Program.add(o); return o; }
  deleteProgram(o) { super.deleteProgram(o); this.alive.Program.delete(o); }
  isProgram(o) { return this.alive.Program.has(o); }
  createShader(type) { const o = super.createShader(type); this.alive.Shader.add(o); return o; }
  deleteShader(o) { super.deleteShader(o); this.alive.Shader.delete(o); }
  isShader(o) { return this.alive.Shader.has(o); }
  createRenderbuffer() { const o = {}; this.alive.Renderbuffer.add(o); return o; }
  deleteRenderbuffer(o) { this.alive.Renderbuffer.delete(o); }
  isRenderbuffer(o) { return this.alive.Renderbuffer.has(o); }
  createVertexArray() { const o = {}; this.alive.VertexArray.add(o); return o; }
  deleteVertexArray(o) { this.alive.VertexArray.delete(o); }
  isVertexArray(o) { return this.alive.VertexArray.has(o); }

  // A program "uses" every uniform its fragment names, and those of a vertex
  // shader too (points read their state there).
  attachShader(program, shader) {
    if (shader.type === this.FRAGMENT_SHADER) program.fragment = shader.source;
    else program.vertex = shader.source;
  }
  getUniformLocation(program, name) {
    const base = name.replace(/\[0\]$/, '');
    const text = `${program.fragment || ''}\n${program.vertex || ''}`;
    return new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text) ? { name } : null;
  }
  // The uniforms and attributes its sources declare, as a driver lists them.
  declared(program, kind) {
    const text = `${program.vertex || ''}\n${program.fragment || ''}`;
    const pattern = kind === 'uniform'
      ? /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g
      : /^\s*(?:in|attribute)\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(a_\w+)/gm;
    return [...new Set([...text.matchAll(pattern)].map((m) => m[1]))];
  }
  getActiveUniform(program, index) { const name = this.declared(program, 'uniform')[index]; return name ? { name } : null; }
  getActiveAttrib(program, index) { const name = this.declared(program, 'attribute')[index]; return name ? { name } : null; }
  getProgramParameter(program, name) {
    if (name === this.ACTIVE_UNIFORMS) return this.declared(program, 'uniform').length;
    if (name === this.ACTIVE_ATTRIBUTES) return this.declared(program, 'attribute').length;
    return super.getProgramParameter(program, name);
  }
  checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; }
  texSubImage2D() { this.subImages += 1; }
  clearColor() {}
  clear() { this.clears += 1; }
  enable(cap) { if (cap === this.BLEND) this.blending = true; }
  disable(cap) { if (cap === this.BLEND) this.blending = false; }
  blendFunc() {}
  disableVertexAttribArray() {}
  // Like a real context: a missing location (null, undefined) is ignored.
  uniform1f(at, v) { if (at) super.uniform1f(at, v); }
  uniform1i(at, v) { if (at) super.uniform1i(at, v); }
  uniform2f(at, a, b) { if (at) super.uniform2f(at, a, b); }
  uniform4f(at, a, b, c, d) { if (at) super.uniform4f(at, a, b, c, d); }
  uniform2fv(at, v) { if (at) super.uniform2fv(at, v); }
  uniform3fv(at, v) { if (at) super.uniform3fv(at, v); }
  uniform4fv(at, v) { if (at) super.uniform4fv(at, v); }
  uniform1fv(at, v) { if (at) this.uniforms.set(at.name, [...v]); }
  uniform3f(at, a, b, c) { if (at) this.uniforms.set(at.name, [a, b, c]); }
  drawArrays(mode, first, count) {
    super.drawArrays(mode, first, count);
    if (mode === this.POINTS) this.pointDraws += 1;
  }
}

/** Make SimGL the page's WebGL2RenderingContext while `fn` runs (the scenes'
 *  own checks use instanceof), then put back what was there. */
export async function withWebgl2Global(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'WebGL2RenderingContext');
  const saved = globalThis.WebGL2RenderingContext;
  globalThis.WebGL2RenderingContext = SimGL;
  try {
    return await fn();
  } finally {
    if (had) globalThis.WebGL2RenderingContext = saved;
    else delete globalThis.WebGL2RenderingContext;
  }
}
