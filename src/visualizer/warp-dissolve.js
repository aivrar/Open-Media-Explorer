/**
 * A single compositing pass for a flash-budgeted scene change. The old
 * scene is one frozen texture. Most of each intermediate frame is a
 * linear cross-fade. A small warped layer adds motion and noise.
 */

export const WARP_DISSOLVE_RELEASED = true;
export const WARP_AMOUNT = 0.012;
export const WARP_SWIRL = 0.08;
export const WARP_FEATHER = 0.3;
export const WARP_LAYER_MIX = 0.22;

/** The pass's fragment shader (GLSL ES 1.00 / 3.00 through the scene
 *  renderer's FRAG_OUT and v_uv). */
export const WARP_DISSOLVE_SHADER = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform float u_amount;
uniform float u_swirl;
uniform float u_feather;
uniform float u_layer_mix;

float warpHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

float warpNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = warpHash(i);
    float b = warpHash(i + vec2(1.0, 0.0));
    float c = warpHash(i + vec2(0.0, 1.0));
    float d = warpHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 warpSwirl(vec2 uv, float angle, float pull) {
    vec2 d = uv - 0.5;
    float r = length(d);
    float a = angle * (1.0 - smoothstep(0.0, 0.7, r));
    float c = cos(a);
    float s = sin(a);
    return 0.5 + vec2(d.x * c - d.y * s, d.x * s + d.y * c) * (1.0 - pull);
}

void main() {
    float t = clamp(u_progress, 0.0, 1.0);
    if (t <= 0.0) {
        FRAG_OUT = vec4(texture2D(u_from, v_uv).rgb, 1.0);
        return;
    }
    if (t >= 1.0) {
        FRAG_OUT = vec4(texture2D(u_to, v_uv).rgb, 1.0);
        return;
    }
    float warp = 4.0 * t * (1.0 - t);
    vec2 fromUv = warpSwirl(v_uv, u_swirl * warp, u_amount * warp);
    vec2 toUv = warpSwirl(v_uv, -u_swirl * warp, -u_amount * warp);
    // Where the new picture shows: a noise threshold that sweeps 0 -> 1.
    float n = warpNoise(v_uv * 3.0) * 0.8 + 0.1;
    float edge = t * (1.0 + 2.0 * u_feather) - u_feather;
    float w = smoothstep(n - u_feather, n + u_feather, edge);
    vec3 from = texture2D(u_from, clamp(fromUv, 0.0, 1.0)).rgb;
    vec3 to = texture2D(u_to, clamp(toUv, 0.0, 1.0)).rgb;
    vec3 base = mix(texture2D(u_from, v_uv).rgb, texture2D(u_to, v_uv).rgb, t);
    // At least 78% of the linear fade's light survives even if the
    // warped layer samples black in both pictures.
    FRAG_OUT = vec4(mix(base, mix(from, to, w), u_layer_mix), 1.0);
}
`;

/** The total weight of the incoming samples for noise `n` (0.1..0.9). */
export function warpWeight(progress, n, feather = WARP_FEATHER) {
  const t = Math.max(0, Math.min(1, progress));
  if (t >= 1) return 1;
  if (t <= 0) return 0;
  const edge = t * (1 + 2 * feather) - feather;
  const x = Math.max(0, Math.min(1, (edge - (n - feather)) / (2 * feather)));
  return t * (1 - WARP_LAYER_MIX) + x * x * (3 - 2 * x) * WARP_LAYER_MIX;
}
