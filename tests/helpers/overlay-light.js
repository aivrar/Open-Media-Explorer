/**
 * How much light an overlay pattern adds, worked out from its drawing calls
 * (no browser): a 2D context that records paths and adds up, for each fill
 * and stroke drawn 'lighter', its area times its colour's alpha and luma
 * (Rec. 709 weights on the sRGB values, as the flash check's meter). The
 * picture's mean is that sum over its area.
 *
 *   stroke  the path's length x the line width (a thin line's area)
 *   fill    a flat colour: the subpaths' areas added (overlaps counted
 *           twice: an upper bound); a gradient: sampled every SAMPLE_PX
 *           pixels inside the path (nonzero rule), each sample its
 *           gradient's alpha x luma there
 *
 * Arcs and curves are cut into short straight pieces first. The same count
 * for every pattern, so they can be compared: our own patterns only (the
 * Psychedelia ones draw through code not run here).
 */

const SAMPLE_PX = 6;
const ARC_PIECES = 48;
const CURVE_PIECES = 12;
const LUMA = [0.2126, 0.7152, 0.0722];

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** [alpha x luma] of a colour string ('hsla(h,s%,l%,a)', '#rgb', '#rrggbb'). */
export function colourLight(style) {
  if (typeof style !== 'string') return 0;
  const m = /^hsla?\(\s*([-\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)$/.exec(style);
  if (m) {
    const rgb = hslToRgb(((Number(m[1]) % 360) + 360) % 360, Number(m[2]) / 100, Number(m[3]) / 100);
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    return alpha * (LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(style);
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].split('').map((c) => parseInt(c + c, 16) / 255) : [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
    return LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
  }
  return 0;
}

function gradient(kind, args) {
  const stops = [];
  return {
    kind, args, stops,
    addColorStop(at, colour) { stops.push([at, colourLight(colour)]); stops.sort((p, q) => p[0] - q[0]); },
    at(x, y) {
      let u;
      if (kind === 'radial') {
        const [x0, y0, r0, , , r1] = args;
        u = (Math.hypot(x - x0, y - y0) - r0) / Math.max(1e-9, r1 - r0);
      } else {
        const [x0, y0, x1, y1] = args;
        const dx = x1 - x0;
        const dy = y1 - y0;
        u = ((x - x0) * dx + (y - y0) * dy) / Math.max(1e-9, dx * dx + dy * dy);
      }
      u = Math.max(0, Math.min(1, u));
      if (!stops.length) return 0;
      if (u <= stops[0][0]) return stops[0][1];
      for (let i = 1; i < stops.length; i += 1) {
        if (u <= stops[i][0]) {
          const [a0, v0] = stops[i - 1];
          const [a1, v1] = stops[i];
          return v0 + ((v1 - v0) * (u - a0)) / Math.max(1e-9, a1 - a0);
        }
      }
      return stops[stops.length - 1][1];
    },
  };
}

export function createLightContext(w, h) {
  let subpaths = [];
  let current = null;
  const stack = [];
  const ctx = {
    canvas: { width: w, height: h },
    light: 0, // the sum (area x alpha x luma) since reset
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowBlur: 0,
    reset() { ctx.light = 0; },
    save() { stack.push({ g: ctx.globalCompositeOperation, a: ctx.globalAlpha, f: ctx.fillStyle, s: ctx.strokeStyle, w: ctx.lineWidth }); },
    restore() {
      const s = stack.pop();
      if (s) Object.assign(ctx, { globalCompositeOperation: s.g, globalAlpha: s.a, fillStyle: s.f, strokeStyle: s.s, lineWidth: s.w });
    },
    beginPath() { subpaths = []; current = null; },
    moveTo(x, y) { current = [[x, y]]; subpaths.push(current); },
    lineTo(x, y) { if (!current) ctx.moveTo(x, y); else current.push([x, y]); },
    closePath() { if (current && current.length) current.closed = true; },
    quadraticCurveTo(cx, cy, x, y) {
      const [x0, y0] = current ? current[current.length - 1] : [x, y];
      for (let i = 1; i <= CURVE_PIECES; i += 1) {
        const t = i / CURVE_PIECES;
        const u = 1 - t;
        ctx.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
      }
    },
    arc(x, y, r, a0, a1, ccw = false) { ctx.ellipse(x, y, r, r, 0, a0, a1, ccw); },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
      let span = a1 - a0;
      if (ccw) span = -((a0 - a1) % (2 * Math.PI) || 2 * Math.PI);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      for (let i = 0; i <= ARC_PIECES; i += 1) {
        const a = a0 + (span * i) / ARC_PIECES;
        const ex = Math.cos(a) * rx;
        const ey = Math.sin(a) * ry;
        const px = x + ex * cos - ey * sin;
        const py = y + ex * sin + ey * cos;
        if (i === 0 && current && current.length === 1 && current[0][0] !== px) current[0] = [px, py];
        else if (i === 0 && !current) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    },
    createRadialGradient(...args) { return gradient('radial', args); },
    createLinearGradient(...args) { return gradient('linear', args); },
    stroke() {
      if (ctx.globalCompositeOperation !== 'lighter') return;
      let length = 0;
      for (const path of subpaths) {
        for (let i = 1; i < path.length; i += 1) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
        if (path.closed && path.length > 1) length += Math.hypot(path[0][0] - path.at(-1)[0], path[0][1] - path.at(-1)[1]);
      }
      ctx.light += length * ctx.lineWidth * ctx.globalAlpha * colourLight(ctx.strokeStyle);
    },
    fill() {
      if (ctx.globalCompositeOperation !== 'lighter') return;
      const style = ctx.fillStyle;
      if (typeof style === 'string') {
        let area = 0;
        for (const path of subpaths) {
          let twice = 0;
          for (let i = 0; i < path.length; i += 1) {
            const [x0, y0] = path[i];
            const [x1, y1] = path[(i + 1) % path.length];
            twice += x0 * y1 - x1 * y0;
          }
          area += Math.abs(twice) / 2;
        }
        ctx.light += area * ctx.globalAlpha * colourLight(style);
        return;
      }
      ctx.light += sampled(style) * ctx.globalAlpha;
    },
    fillRect(x, y, rw, rh) {
      if (ctx.globalCompositeOperation !== 'lighter') return;
      const style = ctx.fillStyle;
      if (typeof style === 'string') { ctx.light += rw * rh * ctx.globalAlpha * colourLight(style); return; }
      let sum = 0;
      for (let sy = y + SAMPLE_PX / 2; sy < y + rh; sy += SAMPLE_PX) {
        for (let sx = x + SAMPLE_PX / 2; sx < x + rw; sx += SAMPLE_PX) sum += style.at(sx, sy);
      }
      ctx.light += sum * SAMPLE_PX * SAMPLE_PX * ctx.globalAlpha;
    },
  };
  // A gradient fill: samples inside the path (nonzero winding).
  function sampled(style) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const path of subpaths) for (const [x, y] of path) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    minX = Math.max(0, minX); minY = Math.max(0, minY); maxX = Math.min(w, maxX); maxY = Math.min(h, maxY);
    let sum = 0;
    for (let sy = minY + SAMPLE_PX / 2; sy < maxY; sy += SAMPLE_PX) {
      for (let sx = minX + SAMPLE_PX / 2; sx < maxX; sx += SAMPLE_PX) {
        let winding = 0;
        for (const path of subpaths) {
          for (let i = 0; i < path.length; i += 1) {
            const [x0, y0] = path[i];
            const [x1, y1] = path[(i + 1) % path.length];
            if (y0 <= sy) { if (y1 > sy && (x1 - x0) * (sy - y0) - (sx - x0) * (y1 - y0) > 0) winding += 1; }
            else if (y1 <= sy && (x1 - x0) * (sy - y0) - (sx - x0) * (y1 - y0) < 0) winding -= 1;
          }
        }
        if (winding !== 0) sum += style.at(sx, sy);
      }
    }
    return sum * SAMPLE_PX * SAMPLE_PX;
  }
  return ctx;
}

/** The most mean light (0..1 of the picture's luma) pattern `pattern` adds
 *  in any frame, drawn at `values` on a w x h picture for `seconds`, the
 *  music strongest. */
export function patternLight(pattern, values, { w = 1280, h = 720, seconds = 20, fps = 5 } = {}) {
  const ctx = createLightContext(w, h);
  const state = pattern.create();
  let most = 0;
  for (let frame = 0; frame <= seconds * fps; frame += 1) {
    ctx.reset();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    pattern.draw(ctx, state, {
      w, h, ph: h, time: frame / fps, dt: 1 / fps, values,
      sources: { bass: 1, mid: 1, kick: 1, high: 1, level: 1 }, trigger: () => ({ live: false, count: 0, age: 99 }), detail: 1, hue: (frame * 7) % 360,
    });
    most = Math.max(most, ctx.light / (w * h));
  }
  return most;
}
