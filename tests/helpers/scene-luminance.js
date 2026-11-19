/** CPU recomputes of two Psychedelia scene shaders (effects/starfield.js and
 *  effects/tunnel.js, as vendored), line for line, with the shader prelude's
 *  hash2 and hsv2rgb, so tests can check how bright a scene is at given
 *  params without a GPU. At view zoom 1 and no rotation the prelude's
 *  _rfrag is gl_FragCoord itself. Checked against renders of the real
 *  shaders in headless Chromium (SwiftShader): within about 0.01 of mean
 *  luminance. */

const fract = (x) => x - Math.floor(x);
const clamp01 = (x) => (x < 0 ? 0 : (x > 1 ? 1 : x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const hash2 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

function hsv2rgb(h, s, v) {
  const out = [0, 0, 0];
  const k = [1, 2 / 3, 1 / 3];
  for (let i = 0; i < 3; i += 1) {
    const p = Math.abs(fract(h + k[i]) * 6 - 3);
    out[i] = v * (1 + (clamp01(p - 1) - 1) * s);
  }
  return out;
}

/** Rec. 709 luma of a colour clamped to 0..1, as read back from the canvas. */
const luma = (c) => 0.2126 * clamp01(c[0]) + 0.7152 * clamp01(c[1]) + 0.0722 * clamp01(c[2]);

function starLayer(ux, uy, t, scale, P) {
  const sx = ux * scale;
  const sy = uy * scale;
  const gx = fract(sx) - 0.5;
  const gy = fract(sy) - 0.5;
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  let brightness = 0;
  for (let y = -1; y <= 1; y += 1) {
    for (let x = -1; x <= 1; x += 1) {
      const n = hash2(ix + x, iy + y);
      let px = n - 0.5;
      let py = fract(n * 34.56) - 0.5;
      py -= fract(t * (0.3 + n * 0.7));
      px = fract(px + 0.5) - 0.5;
      py = fract(py + 0.5) - 0.5;
      const dx = gx - x - px;
      const dy = gy - y - py;
      const d = Math.hypot(dx, dy);
      const s = P.star_size * 0.02 * (0.5 + n * 0.5);
      brightness += (3 * s * s) / (d * d + s * s);
      if (P.trail_length > 0) {
        const trail = smoothstep(s * 1.5, 0, Math.abs(dx)) * smoothstep(0, s, dy)
          * Math.exp(-Math.max(dy, 0) / (P.trail_length * 0.4));
        brightness += trail * s * 20;
      }
    }
  }
  return brightness;
}

function starfield(fx, fy, W, H, time, P) {
  const m = Math.min(W, H);
  const ux = (fx - W * 0.5) / m;
  const uy = (fy - H * 0.5) / m;
  const t = time * P.speed * 0.3;
  const col = [0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const depth = 1 + i * 0.5;
    const b = starLayer(ux, uy, t, P.density * 0.1 * depth, P) / depth;
    const c = P.colorful > 0 ? hsv2rgb(fract(i * 0.25 + t * 0.05), P.colorful, 1) : [1, 1, 1];
    for (let k = 0; k < 3; k += 1) col[k] += b * c[k];
  }
  return col;
}

function tunnel(fx, fy, W, H, time, P, seed, depthFade) {
  const m = Math.min(W, H);
  let ux = (fx - W * 0.5) / m;
  let uy = (fy - H * 0.5) / m;
  const tBase = time + seed * 6.28318;
  ux -= Math.sin(tBase * 0.7) * P.wobble * 0.3;
  uy -= Math.cos(tBase * 0.9) * P.wobble * 0.3;
  const angle = Math.atan2(uy, ux);
  const dist = Math.hypot(ux, uy);
  const depth = 1 / (dist + 0.001);
  const u = (angle / 3.14159) * P.segments + tBase * P.twist * 0.5;
  const v = depth * P.rings + tBase * P.speed;
  const pattern = Math.sin(u * 3.14159) * Math.sin(v * 3.14159);
  const hue = fract(angle / 6.28318 + tBase * P.color_shift * 0.1 + depth * 0.05);
  const sat = 0.7 + 0.3 * pattern;
  let val = (0.5 + 0.5 * pattern) * smoothstep(0, 0.3, dist);
  val *= Math.exp(-dist * 0.3);
  val *= 1 - Math.exp(-depth * depthFade);
  return hsv2rgb(hue, sat, val);
}

/** Mean luminance and the share of clipped pixels (any channel at full) of
 *  `scene` ('starfield' or 'tunnel') with params `P` at W x H, over `times`,
 *  sampling every `stride`-th pixel each way. `depthFade` is the tunnel's
 *  fade constant (the vendored shader's). */
export function sceneLuminance(scene, P, {
  W, H, times = [3.1, 7.4, 13.9, 21.3], stride = 3, seed = 300.123, depthFade = 2.5,
}) {
  let sum = 0;
  let clipped = 0;
  let count = 0;
  for (const time of times) {
    for (let y = 0.5; y < H; y += stride) {
      for (let x = 0.5; x < W; x += stride) {
        const c = scene === 'starfield' ? starfield(x, y, W, H, time, P) : tunnel(x, y, W, H, time, P, seed, depthFade);
        sum += luma(c);
        if (c[0] >= 1 || c[1] >= 1 || c[2] >= 1) clipped += 1;
        count += 1;
      }
    }
  }
  return { mean: sum / count, clipped: clipped / count };
}
