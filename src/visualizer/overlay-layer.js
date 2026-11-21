/**
 * The overlays on the picture (overlay-catalog.js): Psychedelia's Canvas 2D
 * overlays (vendor/psychedelia/engine/overlays.js) and our own patterns
 * (overlay-patterns.js), drawn on up to two "sheets":
 *
 *   top    a canvas over the picture (the tab's .viz-overlay), the overlays
 *          drawn plain on top as in Psychedelia, at most
 *          OVERLAY_TOP_MAX_PIXELS (the browser stretches it over the picture). The compositor lays it over
 *          the WebGL canvas: nothing is uploaded, no pass is drawn for it.
 *   blend  the one overlay blended in (any blend-in: overlay-catalog.js
 *          isBlendIn): an offscreen canvas at OVERLAY_BLEND_SCALE of the
 *          picture's size (at most OVERLAY_BLEND_MAX_PIXELS), which fx-chain.js uploads to one texture (only on
 *          frames it was drawn) and blends with a pass of its own
 *          (OVERLAY_BLEND_SRC), under or over the effects.
 *
 * Zero cost when nothing is on: no sheet, no 2D context, no module. The
 * vendored module is loaded only when a Psychedelia overlay is chosen, and a
 * fresh instance (load(G)) is made per sheet, dropped with it. free() lets
 * everything go (the tab closing): canvases emptied, instances dropped.
 *
 * Flash gate: Psychedelia's overlays read the Beat Reactor (getTrigger,
 * getSource) through `G.AudioReactor`. They get the gate instead: a hit
 * (a trigger's count moving on) is passed on only when the flash limiter's
 * one rolling second has room for it (`charge`, the same share trigger
 * effects use); otherwise that hit never fires. Hits on several kinds in
 * one frame are one flash (charged once). A hit heard while the gate is
 * silent (no music) is never fired later. getSource gives the limiter's
 * output (`sources()`), never the raw reactor. Overlays always see the gate
 * as live, so they never fall back to Psychedelia's random free running
 * (overlay-catalog.js keeps their "Fire On" off Free Run).
 *
 * Changes: a new set fades the old one out (OVERLAY_FADE_OUT_S) and the new
 * one in (OVERLAY_FADE_IN_S), in real time; the top sheet by its CSS opacity
 * (the compositor's, nothing redrawn), the blend sheet by its pass's gain.
 *
 * Motion (overlay-motion.js, move()): each sheet turns, breathes and sways
 * slowly with slow drift, unless it holds an overlay anchored to the screen;
 * the top sheet by a CSS transform (will-change only while it moves), the
 * blend sheet by its texture coordinates (blendSheet.move). Removed when the
 * sheet empties or everything is let go.
 */

import {
  OVERLAY_BLEND_MAX_PIXELS, OVERLAY_BLEND_SCALE, OVERLAY_HALO, OVERLAY_HALO_IDS, OVERLAY_QUALITY_LIMITS, OVERLAY_TOP_MAX_PIXELS, OVERLAY_GLOW_PARAMS, OVERLAY_GLOW_SCALE, OVERLAY_IDS, isBlendIn, overlayRow, overlaysMove,
  OVERLAY_EXTRA_GLOW, extraGlowShare, overlaySizeUnit, overlaySizedParams,
} from './overlay-catalog.js';
import { OVERLAY_PATTERNS, patternValues } from './overlay-patterns.js';
import { applyDrift } from './drift.js';
import { overlayDriftPlan, overlayDriftScale } from './overlay-drift.js';
import {
  motionUv, overlayMotion, quantiseMotion,
} from './overlay-motion.js';

export const OVERLAY_FADE_OUT_S = 0.25;
export const OVERLAY_FADE_IN_S = 0.4;
/** Overlay detail per quality (counts in our patterns). */
export const OVERLAY_DETAIL = Object.freeze({ high: 1, medium: 0.75, low: 0.5 });

const TRIGGER_TYPES = Object.freeze(['kick', 'snare', 'hat', 'beat', 'bar', 'drop']);
/* (Bokeh's and Particles' sprite caches are bounded by Psychedelia itself
 * since its e2cc5c2: at most 48 of each, the oldest dropped. The sheet used
 * to get a fresh instance when one of them left, to let its cache go; no
 * longer needed.) */
/** How fast Spectrum's bars may rise: each bin of the analysis it reads
 *  (getAnalysis, its only reader) climbs at most this share of its full scale
 *  a second, in real time; falls pass as they come (its own smoothing slows
 *  them). Psychedelia raises a bar at once to the FFT, so a kick lifted the
 *  whole row of bars in one frame: steps of light up to 0.094 a frame
 *  (white mirrored bars on Starfield, Screen). With this a bar crosses its
 *  whole range in about a third of a second (overlay-catalog.js spectrum
 *  has the measured steps). */
export const OVERLAY_SPECTRUM_RISE_PER_S = 2.7;

/** Lasers as beams (Psychedelia's renderLasers calls laserBeam through
 *  setBeamSprite, an import PATCH): each beam a turned rectangle filled with
 *  a soft strip across it (its glow), and its core a narrower one on top,
 *  near white in the middle and the beam's colour at its edges, like a real
 *  beam. Sizes follow the picture (per 1080 lines of the sheet's height) and
 *  the Thickness setting (3 by default, so the shuffle varies them): the
 *  core `core` x Thickness pixels wide, the glow `glow` x Thickness (about
 *  8 and 45 at 1080 lines by default). A canvas line wider than a pixel and
 *  a shadow blur are drawn on the processor; filled rectangles are not, so
 *  the width costs nothing. A curved beam (Spiral Spokes) is `curveSteps`
 *  straight pieces. */
export const LASER_BEAM = Object.freeze({ core: 8 / 3, glow: 15, white: 0.8, curveSteps: 8 });
// The glow across the beam (offset from its edge, 0 to 0.5 -> strength).
const LASER_GLOW_STOPS = Object.freeze([[0, 0], [0.1, 0.12], [0.2, 0.28], [0.3, 0.46], [0.4, 0.66], [0.5, 0.85]]);
// The core across (offset -> how near white).
const LASER_CORE_STOPS = Object.freeze([[0, 0], [0.25, 0.45], [0.5, 1]]);
/** `color` ('rgba(...)' or 'hsla(...)', as Psychedelia's itemColor gives
 *  it) with its alpha replaced by `alpha`. */
const withAlpha = (color, alpha) => String(color).replace(/,\s*[\d.]+\s*\)\s*$/, `,${alpha})`);
/** `color` moved `share` of the way to white (alpha kept). */
function towardWhite(color, share) {
  const text = String(color);
  const parts = text.match(/^(rgba|hsla)\(([^)]*)\)$/);
  if (!parts) return text;
  const values = parts[2].split(',').map((part) => part.trim());
  if (parts[1] === 'rgba') {
    const [r, g, b] = values.slice(0, 3).map((value) => Math.round(Number(value) + (255 - Number(value)) * share));
    return `rgba(${r},${g},${b},${values[3]})`;
  }
  const light = parseFloat(values[2]);
  return `hsla(${values[0]},${values[1]},${(light + (100 - light) * share).toFixed(1)}%,${values[3]})`;
}

/** One laser beam from (x1, y1) to (x2, y2), through (xm, ym) when curved
 *  (xm null: straight), in `color` at the context's alpha and blend;
 *  `thickness` Psychedelia's Thickness setting. True: drawn (Psychedelia
 *  then draws no line of its own). */
export function laserBeam(ctx, x1, y1, xm, ym, x2, y2, color, thickness) {
  const unit = (Number(ctx.canvas?.height) || 1080) / 1080;
  const size = Math.max(0.5, Number(thickness) || 3) * unit;
  const core = Math.max(1, size * LASER_BEAM.core);
  const half = Math.max(core, size * LASER_BEAM.glow / 2);
  // In the beam's own frame (across it: y), so one strip serves each piece.
  const glow = ctx.createLinearGradient(0, -half, 0, half);
  for (const [at, strength] of LASER_GLOW_STOPS) {
    glow.addColorStop(at, withAlpha(color, strength));
    if (at < 0.5) glow.addColorStop(1 - at, withAlpha(color, strength));
  }
  const hot = ctx.createLinearGradient(0, -core / 2, 0, core / 2);
  for (const [at, white] of LASER_CORE_STOPS) {
    hot.addColorStop(at, towardWhite(color, white * LASER_BEAM.white));
    if (at < 0.5) hot.addColorStop(1 - at, towardWhite(color, white * LASER_BEAM.white));
  }
  const piece = (ax, ay, bx, by) => {
    const length = Math.hypot(bx - ax, by - ay);
    if (!(length > 0.25)) return;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(by - ay, bx - ax));
    ctx.fillStyle = glow;
    ctx.fillRect(0, -half, length, half * 2);
    ctx.fillStyle = hot;
    ctx.fillRect(0, -core / 2, length, core);
    ctx.restore();
  };
  if (xm === null || xm === undefined) {
    piece(x1, y1, x2, y2);
    return true;
  }
  let ax = x1;
  let ay = y1;
  for (let step = 1; step <= LASER_BEAM.curveSteps; step += 1) {
    const t = step / LASER_BEAM.curveSteps;
    const u = 1 - t;
    const bx = u * u * x1 + 2 * u * t * xm + t * t * x2;
    const by = u * u * y1 + 2 * u * t * ym + t * t * y2;
    piece(ax, ay, bx, by);
    ax = bx;
    ay = by;
  }
  return true;
}

/** One level of a sheet's halo ({ canvas, ctx }) made anew from `from`
 *  (cleared, then drawn: cheaper than a 'copy' draw here). */
function makeHaloLevel(level, from) {
  const c = level.ctx;
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.imageSmoothingEnabled = true;
  c.clearRect(0, 0, level.canvas.width, level.canvas.height);
  c.drawImage(from, 0, 0, level.canvas.width, level.canvas.height);
}

/**
 * The flash gate: the Beat Reactor as the overlays see it.
 * @param {object} deps
 * @param {() => object|null} deps.reactor  the Beat Reactor (reactor.js bridge.reactor)
 * @param {() => boolean} deps.charge  a trigger firing: true when the flash budget has room (and it is charged)
 * @param {() => object|null} deps.sources  the limiter's output (state.sources)
 */
export function createFlashGate({ reactor, charge, sources }) {
  const given = {};
  for (const type of TRIGGER_TYPES) {
    given[type] = {
      raw: null, count: 0, at: Number.NEGATIVE_INFINITY, out: { live: true, count: 0, age: Number.POSITIVE_INFINITY },
    };
  }
  let admittedAt = Number.NaN;
  const stats = { hits: 0, admitted: 0, shared: 0, refused: 0 };
  // The analysis as Spectrum gets it: its bins rise no faster than
  // OVERLAY_SPECTRUM_RISE_PER_S (one array and one object, reused).
  const slewed = { at: Number.NaN, source: null, bins: null, view: {} };
  function slewAnalysis(a) {
    const raw = a && a.active ? (a.spectrum || a.fft) : null;
    if (!raw || !raw.length) { slewed.bins = null; slewed.at = Number.NaN; return a; }
    const at = now();
    const scale = a.byteData ? 255 : 1;
    if (!slewed.bins || slewed.bins.length !== raw.length || slewed.scale !== scale) {
      slewed.bins = new Float32Array(raw.length);
      slewed.scale = scale;
      slewed.at = Number.NaN;
    }
    const bins = slewed.bins;
    if (!Number.isFinite(slewed.at)) {
      // From silence: the bars start at the floor and rise from there.
      bins.fill(0);
      slewed.at = at;
    }
    const dt = Math.max(0, Math.min(0.1, at - slewed.at));
    if (dt > 0 || slewed.source !== raw) {
      const rise = OVERLAY_SPECTRUM_RISE_PER_S * scale * dt;
      for (let i = 0; i < raw.length; i += 1) {
        const value = Number(raw[i]);
        const target = Number.isFinite(value) ? value : 0;
        bins[i] = target <= bins[i] ? target : Math.min(target, bins[i] + rise);
      }
      slewed.at = at;
      slewed.source = raw;
    }
    const view = Object.assign(slewed.view, a);
    view.spectrum = bins;
    return view;
  }
  const now = () => {
    const r = reactor();
    return r?.getClock ? r.getClock() : 0;
  };
  function admit(at) {
    if (at === admittedAt) { stats.shared += 1; return true; }
    if (charge && !charge()) { stats.refused += 1; return false; }
    admittedAt = at;
    stats.admitted += 1;
    return true;
  }
  const gate = {
    getTrigger(type) {
      const slot = given[type];
      if (!slot) return { live: false, count: 0, age: 99 };
      const r = reactor();
      const at = now();
      const raw = r?.getTrigger ? r.getTrigger(type) : null;
      if (raw) {
        if (slot.raw === null || !raw.live) slot.raw = raw.count;
        else if (raw.count !== slot.raw) {
          slot.raw = raw.count;
          stats.hits += 1;
          if (admit(at)) { slot.count += 1; slot.at = at; }
        }
      }
      slot.out.count = slot.count;
      slot.out.age = at - slot.at;
      return slot.out;
    },
    getSource(id) {
      const out = sources();
      const value = out ? Number(out[id]) : 0;
      return Number.isFinite(value) ? value : 0;
    },
    getClock: now,
    getBeatClock() {
      const r = reactor();
      return r?.getBeatClock ? r.getBeatClock() : now() * 2;
    },
    /** The analysis, its bins slew-limited (slewAnalysis): Spectrum reads it. */
    getAnalysis() {
      const r = reactor();
      return slewAnalysis(r?.getAnalysis ? r.getAnalysis() : null);
    },
    // No Beat Reactor links on overlay settings (Overlays.setMod refuses them).
    isSource: () => false,
    applyMod: (base) => base,
    stats,
  };
  return gate;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.topCanvas  the canvas over the picture
 * @param {() => HTMLCanvasElement} options.makeCanvas  an offscreen canvas (the blend sheet)
 * @param {() => Promise<object>} options.loadModule  the vendored overlays.js module
 * @param {object} options.gate  createFlashGate()
 * @param {(error: Error) => void} [options.onError]
 * @param {() => void} [options.onReady]  the module arrived (a held picture may redraw)
 * @param {object} [options.halos]  the halo per quality (overlay-catalog.js
 *        OVERLAY_HALO; the checks pass {} to time an overlay without it)
 * @param {boolean} [options.beams]  lasers as beams (laserBeam; the checks
 *        pass false to time Psychedelia's own lines)
 */
export function createOverlayLayer({
  topCanvas, makeCanvas, loadModule, gate, onError = null, onReady = null, halos = OVERLAY_HALO, beams = true,
}) {
  let moduleLoad = null; // the module's load(G), once it arrived
  let loading = null;
  let failed = false;
  let width = 0;
  let height = 0;
  let quality = 'medium';
  let brightness = 1;
  let hue = Math.random() * 360;
  // What is drawn now, and what comes next (after the fade out).
  let drawn = [];
  let pending = null;
  let fade = { phase: 'none', from: 0 }; // 'out' | 'in' | 'none'
  let gain = 1;
  let lastTime = Number.NaN;
  let freed = false;
  // "Extra glow" (overlay-catalog.js OVERLAY_EXTRA_GLOW): off unless
  // the tab turns it on.
  let extraGlow = false;
  let drifted = false; // the values were last drifted (not as chosen)
  // Overlays that threw while drawing here: not drawn again (failedIds).
  const broken = new Set();
  const stats = {
    frames: 0, topFrames: 0, blendFrames: 0, clears: 0, loads: 0, failed: 0, changes: 0, ms: 0, blendDrops: 0, halos: 0,
  };

  function newSheet(canvas, inDom) {
    return {
      canvas, inDom, ctx: null, psy: null, items: [], patterns: new Map(), drewLast: false, version: 0, psyIds: [], glowDefaults: {},
      chosen: {}, // per overlay, its limited and line settings as chosen (tune scales from these)
      halo: null, // its halo canvases (half and quarter size) while it has a line overlay
    };
  }
  const top = newSheet(topCanvas, true);
  let blend = null; // made when a blend-in is drawn
  // The sheets' motion now (one of each, filled in again).
  const motion = {
    angle: 0, scale: 1, dx: 0, dy: 0, moving: false,
  };
  const blendUvOut = { m: [1, 0, 0, 1], off: [0, 0] };
  let blendUv = null;
  // The top sheet's transform as shown (rounded: quantiseMotion), and the
  // one wanted now; it is written only when the two differ, so a sheet that
  // is still or barely moving writes nothing.
  const shown = {
    tx: 0, ty: 0, deg: 0, scale: 1,
  };
  const wanted = {
    tx: 0, ty: 0, deg: 0, scale: 1,
  };
  let topMoving = false;
  let topWrites = 0;
  // CSS Typed OM (WebView2 has it): one transform value made once, its
  // numbers changed in place; without it, a string.
  let typed;
  function typedTransform() {
    if (typed !== undefined) return typed;
    typed = null;
    try {
      const g = globalThis;
      if (top.canvas.attributeStyleMap && g.CSS?.percent && typeof g.CSSTransformValue === 'function') {
        const tx = g.CSS.percent(0);
        const ty = g.CSS.percent(0);
        const deg = g.CSS.deg(0);
        const sc = g.CSS.number(1);
        typed = {
          tx, ty, deg, sc,
          value: new g.CSSTransformValue([new g.CSSTranslate(tx, ty), new g.CSSRotate(deg), new g.CSSScale(sc, sc)]),
        };
      }
    } catch (_) {
      typed = null;
    }
    return typed;
  }
  const cssText = (q) => `translate(${q.tx.toFixed(4)}%,${q.ty.toFixed(4)}%) rotate(${q.deg.toFixed(2)}deg) scale(${q.scale.toFixed(5)})`;
  /** Show `m` (a motion) on the top sheet, or none (null): removed, and
   *  will-change with it. */
  function setTopMotion(m) {
    const style = top.canvas.style;
    if (!m) {
      if (!topMoving) return;
      topMoving = false;
      if (!style) return;
      try { top.canvas.attributeStyleMap?.delete?.('transform'); } catch (_) { /* the string below */ }
      style.transform = '';
      style.willChange = '';
      return;
    }
    quantiseMotion(m, width, height, wanted);
    if (topMoving && wanted.tx === shown.tx && wanted.ty === shown.ty && wanted.deg === shown.deg && wanted.scale === shown.scale) return;
    shown.tx = wanted.tx; shown.ty = wanted.ty; shown.deg = wanted.deg; shown.scale = wanted.scale;
    const first = !topMoving;
    topMoving = true;
    if (!style) return;
    if (first) style.willChange = 'transform';
    topWrites += 1;
    const t2 = typedTransform();
    if (t2) {
      try {
        t2.tx.value = shown.tx; t2.ty.value = shown.ty; t2.deg.value = shown.deg; t2.sc.value = shown.scale;
        top.canvas.attributeStyleMap.set('transform', t2.value);
        return;
      } catch (_) {
        typed = null; // the string from now on
      }
    }
    style.transform = cssText(shown);
  }

  const isPsy = (id) => overlayRow(id)?.source === 'psychedelia';
  const context = (sheet) => {
    if (!sheet.ctx) sheet.ctx = sheet.canvas.getContext?.('2d') || null;
    return sheet.ctx;
  };

  function ensureModule() {
    if (moduleLoad || loading || failed) return;
    stats.loads += 1;
    loading = Promise.resolve()
      .then(() => loadModule())
      .then((module) => {
        loading = null;
        if (freed) return;
        moduleLoad = module.default;
        install(top);
        if (blend) install(blend);
        onReady?.();
      })
      .catch((error) => {
        loading = null;
        failed = true;
        stats.failed += 1;
        onError?.(error);
      });
  }

  /** The sheet's Psychedelia instance (made when it has one of its
   *  overlays and the module is here), with exactly its overlays on. */
  function install(sheet) {
    const want = sheet.items.filter((item) => isPsy(item.id));
    if (!want.length) { sheet.psy = null; sheet.psyIds = []; return; }
    if (!moduleLoad) { ensureModule(); return; }
    const ids = want.map((item) => item.id);
    if (!sheet.psy) {
      const { Overlays } = moduleLoad({ AudioReactor: gate });
      Overlays.init(sheet.canvas);
      if (beams) Overlays.setBeamSprite?.(laserBeam);
      Overlays.resize(sheet.canvas.width, sheet.canvas.height);
      sheet.psy = Overlays;
      sheet.psyIds = [];
    }
    const psy = sheet.psy;
    for (const id of sheet.psyIds) if (!ids.includes(id)) psy.resetOverlay(id);
    sheet.valueKeys ||= {};
    for (const item of want) {
      const row = overlayRow(item.id);
      // Set up when it comes on, and again when it stays on with other values.
      const valueKey = JSON.stringify(item.values || {});
      if (!sheet.psyIds.includes(item.id) || sheet.valueKeys[item.id] !== valueKey) {
        sheet.valueKeys[item.id] = valueKey;
        psy.resetOverlay(item.id);
        const glow = OVERLAY_GLOW_PARAMS[item.id];
        if (glow) sheet.glowDefaults[item.id] = psy.getParam(glow);
        for (const [name, value] of Object.entries(row.auto || {})) psy.setParam(name, value);
        for (const [name, value] of Object.entries(item.values || {})) psy.setParam(name, value);
        for (const [name, value] of Object.entries(row.pins || {})) psy.setParam(name, value);
        const chosen = {};
        for (const name of [...Object.keys(OVERLAY_QUALITY_LIMITS[item.id] || {}), ...overlaySizedParams(item.id)]) {
          chosen[name] = psy.getParam(name);
        }
        sheet.chosen[item.id] = chosen;
      }
      psy.setEnabled(item.id, true);
    }
    sheet.psyIds = ids;
    tune(sheet);
  }

  /** Each overlay's settings as the quality and the sheet's size allow: its
   *  glow (OVERLAY_GLOW_SCALE, unless its row pins it), its limits
   *  (OVERLAY_QUALITY_LIMITS) and its line widths in canvas pixels scaled by
   *  the sheet's share of the picture (OVERLAY_LINE_PARAMS; overlay-catalog.js
   *  overlaySizeUnit, OVERLAY_SIZE_720_RELEASED). Always from the
   *  values as chosen, so a change of quality or size can be undone. */
  function tune(sheet) {
    if (!sheet?.psy) return;
    const scale = OVERLAY_GLOW_SCALE[quality] ?? 0;
    const lineScale = overlaySizeUnit(sheet.canvas.height, height);
    for (const id of sheet.psyIds) {
      const glow = OVERLAY_GLOW_PARAMS[id];
      if (glow && !Object.prototype.hasOwnProperty.call(overlayRow(id).pins || {}, glow)) {
        sheet.psy.setParam(glow, (Number(sheet.glowDefaults[id]) || 0) * scale);
      }
      const chosen = sheet.chosen[id] || {};
      const limits = OVERLAY_QUALITY_LIMITS[id] || {};
      const lines = overlaySizedParams(id);
      for (const name of Object.keys(chosen)) {
        let value = Number(chosen[name]);
        const limit = limits[name];
        if (limit?.max && Number.isFinite(limit.max[quality])) value = Math.min(value, limit.max[quality]);
        if (limit?.min && Number.isFinite(limit.min[quality])) value = Math.max(value, limit.min[quality]);
        if (lines.includes(name)) value *= lineScale;
        sheet.psy.setParam(name, value);
      }
    }
  }

  function fill(sheet, items) {
    sheet.items = items;
    if (!items.some((item) => OVERLAY_HALO_IDS.has(item.id))) dropHalo(sheet);
    const ours = items.filter((item) => OVERLAY_PATTERNS[item.id]);
    const keep = new Map();
    for (const item of ours) {
      const old = sheet.patterns.get(item.id);
      const values = patternValues(item.id, item.values);
      keep.set(item.id, {
        state: old ? old.state : OVERLAY_PATTERNS[item.id].create(),
        values,
        base: { ...values }, // as chosen (value drift moves `values` around it)
      });
    }
    sheet.patterns = keep;
    install(sheet);
  }

  function sizeSheet(sheet, w, h) {
    if (!sheet) return;
    if (sheet.canvas.width !== w || sheet.canvas.height !== h) {
      sheet.canvas.width = w;
      sheet.canvas.height = h;
      sheet.psy?.resize(w, h);
      sheet.drewLast = false;
      tune(sheet);
    }
  }
  function topSize() {
    const cap = OVERLAY_TOP_MAX_PIXELS[quality] ?? OVERLAY_TOP_MAX_PIXELS.medium;
    const scale = Math.min(1, Math.sqrt(cap / Math.max(1, width * height)));
    return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
  }
  function blendSize() {
    const cap = OVERLAY_BLEND_MAX_PIXELS[quality] ?? OVERLAY_BLEND_MAX_PIXELS.medium;
    const scale = Math.min(OVERLAY_BLEND_SCALE[quality] ?? 1, Math.sqrt(cap / Math.max(1, width * height)));
    return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
  }

  function emptySheet(sheet) {
    if (!sheet) return;
    if (sheet === top) setTopMotion(null);
    else blendUv = null;
    sheet.psy = null;
    sheet.psyIds = [];
    sheet.patterns = new Map();
    sheet.items = [];
    sheet.drewLast = false;
    sheet.ctx = null;
    dropHalo(sheet);
    sheet.canvas.width = 0;
    sheet.canvas.height = 0;
  }

  /** Make `list` ([{ id, values, blend }], as the scene draws them) what is
   *  drawn now. */
  function install2(list) {
    drawn = list;
    const plain = list.filter((item) => !isBlendIn(item.blend));
    const blended = list.find((item) => isBlendIn(item.blend)) || null;
    if (plain.length) {
      // At its own size whatever it held before (a new canvas is 300 x 150).
      if (width) sizeSheet(top, ...topSize());
      fill(top, plain);
    } else emptySheet(top);
    top.canvas.hidden = !plain.length;
    if (blended) {
      if (!blend) blend = newSheet(makeCanvas(), false);
      const [bw, bh] = blendSize();
      sizeSheet(blend, bw, bh);
      fill(blend, [blended]);
    } else if (blend) {
      emptySheet(blend);
      blend = null;
    }
    showOpacity();
  }

  function showOpacity() {
    const value = Math.max(0, Math.min(1, gain * brightness));
    const text = value >= 1 ? '' : String(Math.round(value * 1000) / 1000);
    if (top.canvas.style && top.canvas.style.opacity !== text) top.canvas.style.opacity = text;
  }

  function drawSheet(sheet, time, dt, env) {
    const ctx = context(sheet);
    if (!ctx || !sheet.canvas.width) return;
    const psyOn = Boolean(sheet.psy && sheet.psyIds.length);
    if (psyOn) {
      // Clears it, then its layers. A throw is reported once per sheet and
      // the frame goes on (our patterns still draw).
      try { sheet.psy.render(time); } catch (error) {
        ctx.clearRect(0, 0, sheet.canvas.width, sheet.canvas.height);
        for (const id of sheet.psyIds) broken.add(id);
        if (!sheet.reported) { sheet.reported = true; onError?.(error); }
      }
    } else {
      ctx.clearRect(0, 0, sheet.canvas.width, sheet.canvas.height);
      stats.clears += 1;
    }
    if (sheet.patterns.size) {
      env.w = sheet.canvas.width;
      env.h = sheet.canvas.height;
      env.ph = height || sheet.canvas.height;
      for (const [id, entry] of sheet.patterns) {
        if (broken.has(id)) continue;
        env.values = entry.values;
        ctx.save();
        try { OVERLAY_PATTERNS[id].draw(ctx, entry.state, env); } catch (error) { broken.add(id); onError?.(error); }
        ctx.restore();
      }
    }
    halo(sheet, ctx);
    sheet.drewLast = true;
    sheet.version += 1;
  }

  /** The sheet's soft halo (overlay-catalog.js OVERLAY_HALO): when it holds a
   *  line overlay, at Medium and High. The sheet is shrunk by halvings to a
   *  half, a quarter and an eighth (each step averages 2 x 2 pixels, so no
   *  line is skipped); the eighth (the wide glow, where the quality has it)
   *  is added into the quarter (the near glow), and the quarter is drawn
   *  back stretched over the sheet, adding light: twice at half strength,
   *  half a quarter's pixel each way, which softens it (stretched once, a
   *  slanted line's glow beads, twice as bright where the line meets one of
   *  the quarter's rows as where it falls between two). Image copies only,
   *  each on the graphics card and costing about the same whatever its size
   *  (about 0.2 ms here, so as few as this): no blur filter, no shadow, no
   *  wide line. */
  function halo(sheet, ctx) {
    // A line overlay's halo as measured; else, with Extra glow on, the same
    // pass at OVERLAY_EXTRA_GLOW, the sheet faded by the glow's share first.
    // Every frame: no array, closure or iterator is made on this path (the
    // three levels are made once per sheet).
    let lines = false;
    if (halos[quality]) {
      const items = sheet.items;
      for (let i = 0; i < items.length && !lines; i += 1) {
        lines = OVERLAY_HALO_IDS.has(items[i].id) && !broken.has(items[i].id);
      }
    }
    const extra = !lines && extraGlow && sheet.items.length ? OVERLAY_EXTRA_GLOW[quality] || null : null;
    const look = lines ? halos[quality] : extra;
    if (!look) return;
    const w = sheet.canvas.width;
    const h = sheet.canvas.height;
    if (!sheet.halo) sheet.halo = [makeCanvas(), makeCanvas(), makeCanvas()].map((canvas) => ({ canvas, ctx: null }));
    const half = sheet.halo[0];
    const quarter = sheet.halo[1];
    const eighth = sheet.halo[2];
    // Each level half the one before (rounded up, at least one pixel).
    let lw = w;
    let lh = h;
    for (let i = 0; i < 3; i += 1) {
      const level = sheet.halo[i];
      lw = Math.max(1, Math.ceil(lw / 2));
      lh = Math.max(1, Math.ceil(lh / 2));
      if (level.canvas.width !== lw || level.canvas.height !== lh) {
        level.canvas.width = lw;
        level.canvas.height = lh;
        level.ctx = null;
      }
      level.ctx ||= level.canvas.getContext?.('2d') || null;
      if (!level.ctx) return;
    }
    makeHaloLevel(half, sheet.canvas);
    makeHaloLevel(quarter, half.canvas);
    if (look.wide > 0) {
      makeHaloLevel(eighth, quarter.canvas);
      const q = quarter.ctx;
      q.globalCompositeOperation = 'lighter';
      q.globalAlpha = look.wide;
      q.drawImage(eighth.canvas, 0, 0, quarter.canvas.width, quarter.canvas.height);
    }
    if (extra) {
      // The sheet gives up the light the glow takes (its share of the sheet's
      // own: near, with the wide glow's part of it), so the mean stays.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = Math.min(1, extraGlowShare(extra));
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    // Stretched over the sheet twice, half a quarter's pixel each way (each
    // at half strength): the two copies soften it.
    const ox = 0.5 * (w / quarter.canvas.width);
    const oy = 0.5 * (h / quarter.canvas.height);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = look.near / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(quarter.canvas, -ox, -oy, w, h);
    ctx.drawImage(quarter.canvas, ox, oy, w, h);
    ctx.restore();
    stats.halos += 1;
  }
  /** Overlay value drift (overlay-drift.js) on one sheet: each
   *  overlay's planned settings moved around their chosen values, into the
   *  values it draws with (ours) or its Psychedelia instance. Nothing made
   *  per frame. */
  function driftSheet(sheet, bars, scale) {
    if (!sheet?.items?.length) return;
    for (const item of sheet.items) {
      const plan = overlayDriftPlan(item.id);
      if (!plan.length) continue;
      const pattern = sheet.patterns.get(item.id);
      if (pattern) {
        applyDrift(pattern.base, plan, bars, scale, pattern.values);
        continue;
      }
      if (!sheet.psy || !sheet.psyIds.includes(item.id) || !item.values) continue;
      sheet.driftOut ||= {};
      const out = (sheet.driftOut[item.id] ||= {});
      applyDrift(item.values, plan, bars, scale, out);
      for (const wave of plan) if (typeof out[wave.name] === 'number') sheet.psy.setParam(wave.name, out[wave.name]);
    }
  }
  /** The halo canvases let go (no line overlay on the sheet, or emptied). */
  function dropHalo(sheet) {
    if (!sheet.halo) return;
    for (const level of sheet.halo) { level.canvas.width = 0; level.canvas.height = 0; }
    sheet.halo = null;
  }

  const env = {
    w: 0, h: 0, ph: 0, time: 0, dt: 0, values: null, sources: null, trigger: (type) => gate.getTrigger(type), detail: 1, hue: 0,
  };

  const layer = {
    stats,
    gate,
    get drawn() { return drawn; },
    get pending() { return pending; },
    /** Something is drawn or about to be (a sheet has overlays). */
    get on() { return drawn.length > 0 || pending !== null; },
    get loading() { return Boolean(loading); },
    get failed() { return failed; },
    /** Overlays that cannot be drawn on this computer: every Psychedelia one
     *  when its module did not load, and any that threw while drawing. The
     *  tab lets them hold no slot and leave the choice on its next change. */
    get failedIds() {
      return OVERLAY_IDS.filter((id) => broken.has(id) || (failed && isPsy(id)));
    },
    get gain() { return gain; },
    get fadePhase() { return fade.phase; },
    /** An overlay drawn now fires on hits (the tab keeps the trigger share). */
    get usesTriggers() { return drawn.some((item) => overlayRow(item.id)?.flash === 'trigger'); },
    /** The blend sheet for fx-chain.js (null: nothing blended in). */
    get blendSheet() {
      if (!blend || !blend.items?.length) return null;
      const item = blend.items[0];
      return {
        canvas: blend.canvas, version: blend.version, blend: item.blend, gain, id: item.id, move: blendUv,
        tintFloor: overlayRow(item.id)?.tintFloor || 0,
      };
    },
    get top() { return top; },
    get blend() { return blend; },

    /** The picture's drawing size and quality (the sheets follow them). */
    resize(w, h, nextQuality = quality) {
      width = Math.max(0, Math.round(w));
      height = Math.max(0, Math.round(h));
      quality = nextQuality;
      if (drawn.length && top.items?.length) sizeSheet(top, ...topSize());
      if (blend) sizeSheet(blend, ...blendSize());
      // Glow and limits follow the quality, line widths the sheets' share of
      // the picture (which may change while a sheet keeps its size).
      tune(top);
      tune(blend);
    },
    setBrightness(value) { brightness = value; showOpacity(); },

    /** Overlays `list` ([{ id, values, blend }], already as the scene draws
     *  them: overlay-catalog.js overlaysDrawnFor). `now`: fade (the picture
     *  moves), else made at once. */
    set(list, { now = false } = {}) {
      stats.changes += 1;
      const next = Array.isArray(list) ? list : [];
      if (now || !drawn.length || !Number.isFinite(lastTime)) {
        pending = null;
        fade = next.length && !now && Number.isFinite(lastTime) ? { phase: 'in', from: lastTime } : { phase: 'none', from: 0 };
        gain = fade.phase === 'in' ? 0 : 1;
        install2(next);
        return;
      }
      pending = next;
      if (fade.phase !== 'out') fade = { phase: 'out', from: lastTime, start: gain };
    },

    /** The blended overlay taken off at once, with no fade (a new scene
     *  does not allow its blend-in: it is not blended over that scene even
     *  while fading out). The plain ones on top are left as they are. */
    dropBlend() {
      if (!blend) return false;
      emptySheet(blend);
      blend = null;
      drawn = drawn.filter((item) => !isBlendIn(item.blend));
      stats.blendDrops += 1;
      return true;
    },

    /** One drawn frame at `time` (s, real time), `dt` (s): both sheets, as
     *  their overlays are. Returns true when anything was drawn. */
    render(time, dt, sources) {
      if (freed) return false;
      lastTime = time;
      if (fade.phase === 'out') {
        const k = (time - fade.from) / OVERLAY_FADE_OUT_S;
        gain = Math.max(0, (fade.start ?? 1) * (1 - k));
        if (k >= 1 || time < fade.from) {
          const next = pending || [];
          pending = null;
          install2(next);
          fade = next.length ? { phase: 'in', from: time } : { phase: 'none', from: 0 };
          gain = next.length ? 0 : 1;
        }
      } else if (fade.phase === 'in') {
        const k = (time - fade.from) / OVERLAY_FADE_IN_S;
        gain = Math.min(1, Math.max(0, k));
        if (k >= 1 || time < fade.from) { fade = { phase: 'none', from: 0 }; gain = 1; }
      }
      showOpacity();
      const topOn = Boolean(top.items?.length);
      const blendOn = Boolean(blend?.items?.length);
      if (!topOn && !blendOn) return false;
      const t0 = globalThis.performance?.now?.() ?? 0;
      env.time = time;
      env.dt = dt > 0 && dt < 0.25 ? dt : 0;
      env.sources = sources || {};
      env.detail = OVERLAY_DETAIL[quality] ?? 1;
      env.hue = hue;
      if (topOn) { drawSheet(top, time, dt, env); stats.topFrames += 1; }
      if (blendOn) { drawSheet(blend, time, dt, env); stats.blendFrames += 1; }
      stats.frames += 1;
      stats.ms += (globalThis.performance?.now?.() ?? 0) - t0;
      return true;
    },

    /** The sheets' motion at drift clock `bars` and drift depth `depth`
     *  (drift.js; 0: none): a sheet holding an anchored overlay, or none,
     *  is held still. Called every drawn frame (a still picture's clock and
     *  depth do not move, so neither does the sheet). True: one moves. */
    move(bars, depth) {
      if (freed) return false;
      const aspect = width > 0 && height > 0 ? width / height : 1;
      const topMoves = Boolean(top.items?.length) && overlaysMove(top.items);
      const blendMoves = Boolean(blend?.items?.length) && overlaysMove(blend.items);
      overlayMotion(bars, topMoves || blendMoves ? depth : 0, aspect, motion);
      setTopMotion(topMoves && motion.moving ? motion : null);
      blendUv = blendMoves ? motionUv(motion, aspect, blendUvOut) : null;
      return motion.moving;
    },
    get motion() { return motion; },
    /** The top sheet's transform as shown ('' none), and how often it was
     *  written. */
    get topTransform() { return topMoving ? cssText(shown) : ''; },
    get topWrites() { return topWrites; },

    /** The quality changed (step-down or by hand). */
    setQuality(next) { layer.resize(width, height, next); },
    /** "Extra glow" on or off (the tab calls it while released). */
    setExtraGlow(on) { extraGlow = on === true; },
    get extraGlow() { return extraGlow; },
    /** Overlay value drift (overlay-drift.js) at drift clock `bars`
     *  and drift depth `depth` (0: the values as chosen). Called every drawn
     *  frame by the tab while released. */
    drift(bars, depth) {
      if (freed) return;
      const scale = overlayDriftScale(depth);
      if (!(scale > 0) && !drifted) return;
      drifted = scale > 0;
      driftSheet(top, bars, scale);
      driftSheet(blend, bars, scale);
    },
    /** Seeded colour start (tests and the checks). */
    setHue(value) { hue = Number(value) || 0; },

    /** Everything let go (the tab closing, or overlays switched off and
     *  faded): the sheets emptied, the instances dropped. */
    free() {
      drawn = [];
      pending = null;
      fade = { phase: 'none', from: 0 };
      gain = 1;
      emptySheet(top);
      top.canvas.hidden = true;
      if (blend) emptySheet(blend);
      blend = null;
      lastTime = Number.NaN;
      showOpacity();
    },
    destroy() {
      layer.free();
      freed = true;
      moduleLoad = null;
    },
  };
  return layer;
}
