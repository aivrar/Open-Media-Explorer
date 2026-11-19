/**
 * Our own overlay patterns (written for this app; not from Psychedelia or
 * anywhere else). Each draws onto the overlay canvas the same way
 * Psychedelia's overlays do (overlay-layer.js calls them after Psychedelia's,
 * on the same canvas), with two settings the shuffle varies:
 *
 *   size   how much of the picture it takes (or how dense it is), 0..1-ish
 *   speed  how fast it moves (1 = as designed)
 *
 * Rules every one keeps (the overlays' rules, overlay-catalog.js):
 *   - Real time, not frames: every motion is `time` (seconds) times a rate,
 *     or eased with exp(-dt / tau); the same at 15, 30 or 60 fps.
 *   - Cheap: no shadow blur (a canvas shadow is drawn again per shape);
 *     shapes batched into as few paths as the look needs; counts scaled by
 *     the quality (`env.detail`: 1 High, 0.75 Medium, 0.5 Low).
 *   - The music only through the shared reactor values (`env.sources`: the
 *     flash limiter's output) and the flash gate (`env.trigger`: a hit only
 *     when the limiter's one rolling second has room), and only as motion
 *     (size, spread, swing); light never pulses with it except through the
 *     gate (Triangle Grid's cells).
 *   - Nothing full-screen flashes: no fill covers more than a small share of
 *     the picture at once.
 *
 * Each: { params: { size, speed } ({ min, max, default }), create(), draw(ctx,
 * state, env) }. env: { w, h (the sheet), ph (the picture's height), time, dt,
 * values, sources, trigger(type), detail, hue }.
 */

const TAU = Math.PI * 2;
const clamp = (value, lo, hi) => (value < lo ? lo : (value > hi ? hi : value));
/** Eased towards `target` with time constant `tau` (s) over `dt` (s). */
const ease = (value, target, dt, tau) => value + (target - value) * (1 - Math.exp(-Math.max(0, dt) / tau));
const hsl = (hue, light, alpha) => `hsla(${(((hue % 360) + 360) % 360).toFixed(1)},90%,${light}%,${alpha.toFixed(3)})`;
/** A line's width unit on the sheet: 1 pixel per 720 lines of the picture
 *  (at least 1 at the picture's own size), as a share of the sheet, which may
 *  be drawn smaller than the picture (overlay-catalog.js OVERLAY_TOP_MAX_PIXELS).
 *  Lines look the same on the picture whatever the sheet's size; on a
 *  smaller sheet they are thinner in its pixels, and much cheaper to draw. */
const lineScale = (env) => env.h / Math.min(720, env.ph || env.h);

const SIZE = Object.freeze({ min: 0.2, max: 1.2, default: 0.75 });
const SPEED = Object.freeze({ min: 0, max: 2, default: 1 });
const PARAMS = Object.freeze({ size: SIZE, speed: SPEED });

/** Petal Mandala: rings of petals turning in opposite directions; the petals
 *  open a little with the bass. */
const petals = {
  params: PARAMS,
  create: () => ({ open: 0 }),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    st.open = ease(st.open, clamp(env.sources.bass || 0, 0, 1), env.dt, 0.5);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46 * values.size;
    const rings = env.detail < 0.6 ? 2 : 3;
    const t = time * values.speed;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    for (let ring = 0; ring < rings; ring += 1) {
      const count = 6 + ring * 4;
      const inner = R * (0.12 + ring * 0.24);
      const outer = R * (0.38 + ring * 0.3) * (1 + 0.08 * st.open);
      const turn = (ring % 2 ? -1 : 1) * t * (0.12 + ring * 0.05);
      const bulge = (outer - inner) * (0.32 + 0.1 * Math.sin(t * 0.6 + ring));
      ctx.beginPath();
      for (let k = 0; k < count; k += 1) {
        const a = turn + (k / count) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const x0 = cx + ca * inner;
        const y0 = cy + sa * inner;
        const x1 = cx + ca * outer;
        const y1 = cy + sa * outer;
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(mx - sa * bulge, my + ca * bulge, x1, y1);
        ctx.quadraticCurveTo(mx + sa * bulge, my - ca * bulge, x0, y0);
      }
      const hue = env.hue + time * 12 + ring * 50;
      // A faint fill for body (a wide soft stroke around them cost 2 ms a
      // frame on Medium: a wide line is outlined on the processor).
      ctx.fillStyle = hsl(hue, 55, 0.06);
      ctx.fill();
      ctx.lineWidth = Math.min(1, lineScale(env) * 1.6);
      ctx.strokeStyle = hsl(hue, 65, 0.7);
      ctx.stroke();
    }
  },
};

/** Ribbons: bands of three lines flowing across, their swing following the
 *  mids. */
const ribbons = {
  params: PARAMS,
  create: () => ({ swing: 0.3 }),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    st.swing = ease(st.swing, 0.25 + 0.75 * clamp(env.sources.mid || 0, 0, 1), env.dt, 0.6);
    const count = env.detail < 0.8 ? 3 : 4;
    const steps = Math.max(24, Math.round(64 * env.detail));
    const t = time * values.speed;
    const amp = h * 0.16 * values.size * st.swing;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let r = 0; r < count; r += 1) {
      const base = h * (0.2 + (0.6 * r) / Math.max(1, count - 1));
      const k1 = 1.5 + r * 0.7;
      const k2 = 3.1 + r * 0.4;
      const hue = env.hue + r * 70 + time * 8;
      for (let strand = 0; strand < 3; strand += 1) {
        const offset = (strand - 1) * h * 0.012 * (1 + values.size);
        ctx.beginPath();
        for (let i = 0; i <= steps; i += 1) {
          const u = i / steps;
          const y = base + offset
            + amp * Math.sin(u * k1 * TAU + t * (0.7 + r * 0.15) + r)
            + amp * 0.45 * Math.sin(u * k2 * TAU - t * 1.1 + strand * 0.4);
          if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(u * w, y);
        }
        ctx.lineWidth = lineScale(env) * (strand === 1 ? 2 : 1);
        ctx.strokeStyle = hsl(hue + strand * 12, 62, strand === 1 ? 0.6 : 0.3);
        ctx.stroke();
      }
    }
  },
};

/** Dot Spiral: dots at the golden angle, turning; the kick pushes the spiral
 *  out a little (motion only). */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const dotSpiral = {
  params: PARAMS,
  create: () => ({ push: 0 }),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    st.push = ease(st.push, clamp(env.sources.kick || 0, 0, 1), env.dt, 0.15);
    const n = Math.max(40, Math.round(160 * env.detail));
    const R = Math.min(w, h) * 0.48 * values.size * (1 + 0.06 * st.push);
    const spin = time * values.speed * 0.25;
    const bands = 4;
    ctx.globalCompositeOperation = 'lighter';
    for (let band = 0; band < bands; band += 1) {
      ctx.beginPath();
      for (let i = band; i < n; i += bands) {
        const f = Math.sqrt((i + 0.5) / n);
        const a = i * GOLDEN + spin;
        const x = w / 2 + Math.cos(a) * R * f;
        const y = h / 2 + Math.sin(a) * R * f;
        const r = lineScale(env) * (1 + 3 * f);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fillStyle = hsl(env.hue + band * 30 + time * 15, 65, 0.65);
      ctx.fill();
    }
  },
};

/** Contour Lines' strength (it was 0.42 as thin lines alone): with their
 *  halo (overlay-catalog.js OVERLAY_HALO_IDS) they read as glowing lines. */
export const CONTOUR_ALPHA = 0.6;
/** Contour Lines: rows of slow wavy lines, like a map's height lines. */
const contours = {
  params: PARAMS,
  create: () => ({}),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    const rows = Math.max(6, Math.round((8 + 12 * values.size) * env.detail));
    const steps = Math.max(24, Math.round(56 * env.detail));
    const t = time * values.speed * 0.35;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.min(1, lineScale(env) * 1.2); // up to a pixel: drawn directly
    for (let group = 0; group < 2; group += 1) {
      ctx.beginPath();
      for (let j = group; j < rows; j += 2) {
        const base = ((j + 0.5) / rows) * h;
        for (let i = 0; i <= steps; i += 1) {
          const u = i / steps;
          const y = base
            + h * 0.035 * Math.sin(u * 5.3 + t + j * 0.45)
            + h * 0.02 * Math.sin(u * 11.7 - t * 1.3 + j * 0.9)
            + h * 0.012 * Math.sin(u * 2.1 + t * 0.6 + Math.sin(j * 1.7 + t));
          if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(u * w, y);
        }
      }
      ctx.strokeStyle = hsl(env.hue + group * 40 + time * 6, 60, CONTOUR_ALPHA);
      ctx.stroke();
    }
  },
};

/** Starburst: slow rays from the centre, fading outwards; their reach
 *  breathes with the bass. One fill for all the rays. */
const starburst = {
  params: PARAMS,
  create: () => ({ reach: 0 }),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    st.reach = ease(st.reach, clamp(env.sources.bass || 0, 0, 1), env.dt, 0.8);
    const rays = env.detail < 0.6 ? 16 : 24;
    const R = Math.hypot(w, h) * 0.5 * (0.45 + 0.55 * values.size) * (0.9 + 0.1 * st.reach);
    const turn = time * values.speed * 0.05;
    const cx = w / 2;
    const cy = h / 2;
    const hue = env.hue + time * 5;
    const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    fill.addColorStop(0, hsl(hue, 75, 0.32));
    fill.addColorStop(0.35, hsl(hue + 30, 60, 0.14));
    fill.addColorStop(1, hsl(hue + 60, 50, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    for (let k = 0; k < rays; k += 1) {
      const a = turn + (k / rays) * TAU;
      const reach = R * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * values.speed * 0.4 + k * 2.3)));
      const half = (TAU / rays) * 0.18;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a - half) * reach, cy + Math.sin(a - half) * reach);
      ctx.lineTo(cx + Math.cos(a + half) * reach, cy + Math.sin(a + half) * reach);
      ctx.closePath();
    }
    ctx.fillStyle = fill;
    ctx.fill();
  },
};

/** Triangle Grid: a faint grid of triangles; on a beat the flash gate lets
 *  through, a short walk of cells lights and fades (time-based); without
 *  sound one dim cell wanders. */
const TRI_LIFE_S = 1.2;
const triGrid = {
  params: PARAMS,
  create: () => ({
    lit: [], count: -1, walk: 0, walkAt: 0, seed: 1,
  }),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    const side = Math.max(24, Math.min(w, h) * (0.06 + 0.1 * (1.2 - values.size)) / Math.max(0.5, env.detail));
    const rowH = side * Math.sqrt(3) / 2;
    const cols = Math.ceil(w / (side / 2)) + 2;
    const rows = Math.ceil(h / rowH) + 1;
    const random = () => { st.seed = (st.seed * 16807) % 2147483647; return st.seed / 2147483647; };
    const tr = env.trigger('beat');
    if (tr && tr.count !== st.count) {
      if (st.count >= 0) {
        let col = Math.floor(random() * cols);
        let row = Math.floor(random() * rows);
        for (let k = 0; k < 9; k += 1) {
          st.lit.push({ col, row, at: time });
          col = clamp(col + Math.floor(random() * 3) - 1, 0, cols - 1);
          row = clamp(row + Math.floor(random() * 3) - 1, 0, rows - 1);
        }
      }
      st.count = tr.count;
    }
    // Without the music, one dim cell wanders (twice a second at speed 1).
    // Stepped on real time (the same steps at any frame rate); after a gap
    // (hidden, paused) it starts again from now instead of catching up.
    const period = 0.5 / Math.max(0.1, values.speed);
    if (time < st.walkAt || time - st.walkAt > period * 8) st.walkAt = time;
    while (time - st.walkAt >= period) {
      st.walkAt += period;
      st.walk = (st.walk + 1 + Math.floor(random() * 3)) % (cols * rows);
    }
    st.lit = st.lit.filter((cell) => time - cell.at < TRI_LIFE_S && time >= cell.at);
    const corner = (col, row) => {
      const x = (col * side) / 2 - side / 2;
      const y = row * rowH;
      const up = (col + row) % 2 === 0;
      return up
        ? [x, y + rowH, x + side / 2, y, x + side, y + rowH]
        : [x, y, x + side, y, x + side / 2, y + rowH];
    };
    const tri = (col, row) => {
      const p = corner(col, row);
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]);
      ctx.closePath();
    };
    const hue = env.hue + time * 10;
    ctx.globalCompositeOperation = 'lighter';
    // The grid: two families of parallel lines and the rows, one stroke.
    ctx.beginPath();
    for (let row = 0; row <= rows; row += 1) { ctx.moveTo(0, row * rowH); ctx.lineTo(w, row * rowH); }
    const slope = rowH / (side / 2);
    for (let k = -rows; k <= cols; k += 1) {
      const x = k * side;
      ctx.moveTo(x, 0); ctx.lineTo(x + (rows * rowH) / slope, rows * rowH);
      ctx.moveTo(x + side, 0); ctx.lineTo(x + side - (rows * rowH) / slope, rows * rowH);
    }
    ctx.lineWidth = lineScale(env);
    ctx.strokeStyle = hsl(hue, 60, 0.13);
    ctx.stroke();
    ctx.beginPath();
    tri(st.walk % cols, Math.floor(st.walk / cols));
    ctx.fillStyle = hsl(hue + 40, 60, 0.12);
    ctx.fill();
    // Lit cells in three steps of brightness (three fills, not one per cell).
    for (let level = 0; level < 3; level += 1) {
      ctx.beginPath();
      let any = false;
      for (const cell of st.lit) {
        const k = 1 - (time - cell.at) / TRI_LIFE_S;
        if (Math.min(2, Math.floor(k * 3)) !== level) continue;
        tri(cell.col, cell.row);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = hsl(hue + 60, 60, 0.12 + level * 0.12);
      ctx.fill();
    }
  },
};

/** Harmonograph: one long curve of two slowly drifting pendulums. */
const harmonograph = {
  params: PARAMS,
  create: () => ({}),
  draw(ctx, st, env) {
    const { w, h, time, values } = env;
    // A long self-crossing stroke is the cost: fewer points on lower
    // qualities, and kept to a pixel wide (a wider line is outlined on the
    // processor first: 5 to 7 ms a frame on High with a soft halo).
    const points = Math.max(120, Math.round(360 * env.detail));
    const t = time * values.speed * 0.08;
    const A = Math.min(w, h) * 0.42 * values.size;
    const f1 = 2 + 0.02 * Math.sin(t);
    const f2 = 3 + 0.015 * Math.cos(t * 0.7);
    const p1 = t * 1.3;
    const p2 = t * 0.9;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'bevel';
    ctx.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const u = (i / points) * TAU * 6;
      const decay = Math.exp(-u * 0.035);
      const x = w / 2 + A * decay * (Math.sin(u * f1 + p1) * 0.75 + Math.sin(u * 1.01 + p2) * 0.25) * (w > h ? 1.3 : 1);
      const y = h / 2 + A * decay * (Math.sin(u * f2) * 0.75 + Math.sin(u * 0.99 + p1 * 0.5) * 0.25);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    const hue = env.hue + time * 9;
    ctx.lineWidth = Math.min(1, lineScale(env) * 1.3);
    ctx.strokeStyle = hsl(hue + 25, 68, 0.62);
    ctx.stroke();
  },
};

export const OVERLAY_PATTERNS = Object.freeze({
  petals,
  ribbons,
  dot_spiral: dotSpiral,
  contours,
  starburst,
  tri_grid: triGrid,
  harmonograph,
});

/** The values a pattern draws with: `values` kept to its params' ranges,
 *  the rest their defaults. */
export function patternValues(id, values) {
  const pattern = OVERLAY_PATTERNS[id];
  const out = {};
  if (!pattern) return out;
  for (const [name, p] of Object.entries(pattern.params)) {
    const value = Number(values?.[name]);
    out[name] = Number.isFinite(value) ? clamp(value, p.min, p.max) : p.default;
  }
  return out;
}
