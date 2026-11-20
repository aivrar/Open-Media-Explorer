/**
 * PROPOSED, held, not wired: a warped dissolve between scenes in place of
 * the plain cross-fade (transition.js), for song structure (I9). Nothing
 * imports this module yet; WARP_DISSOLVE_RELEASED stays false until every
 * transition's brightness steps have been measured with it.
 *
 * Design
 *   The outgoing frame is kept as a texture (u_from) and the incoming scene
 *   draws into another (u_to); one pass mixes them over the transition's
 *   time (u_progress 0..1, eased):
 *     - a soft noise threshold decides where the new picture shows first
 *       (blobs that open out), with a feathered edge of WARP_FEATHER;
 *     - the old picture is pulled slightly toward the centre and swirled
 *       (at most WARP_AMOUNT of the screen) as it goes, the new one starts
 *       slightly pushed out and settles;
 *     - each pixel is a convex mix of one old and one new sample (weights
 *       sum to 1, no added light), so a pixel is never brighter than the
 *       brighter of the two samples it mixes.
 *   The warp moves where samples come from, so the frame's mean can still
 *   move differently from a plain fade: that is what needs measuring (the
 *   largest step of the mean per frame over every scene pair the shuffle
 *   can make, at CROSSFADE_MS and CROSSFADE_SLOW_MS).
 *   Cost: one full-screen pass, two texture reads and a little noise a
 *   pixel, for the 600 ms of a change only.
 *
 * Numbers (all PROPOSED): WARP_AMOUNT 0.04, WARP_SWIRL 0.6 rad, WARP_FEATHER
 * 0.12, noise scale 3.
 */

export const WARP_DISSOLVE_RELEASED = false;
export const WARP_AMOUNT = 0.04;
export const WARP_SWIRL = 0.6;
export const WARP_FEATHER = 0.12;

/** The pass's fragment shader (GLSL ES 1.00 / 3.00 through the scene
 *  renderer's FRAG_OUT and v_uv). */
export const WARP_DISSOLVE_SHADER = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform float u_amount;
uniform float u_swirl;
uniform float u_feather;

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
    float eased = t * t * (3.0 - 2.0 * t);
    vec2 fromUv = warpSwirl(v_uv, u_swirl * eased, u_amount * eased);
    vec2 toUv = warpSwirl(v_uv, -u_swirl * (1.0 - eased), -u_amount * (1.0 - eased));
    // Where the new picture shows: a noise threshold that sweeps 0 -> 1.
    float n = warpNoise(v_uv * 3.0) * 0.8 + 0.1;
    float edge = eased * (1.0 + 2.0 * u_feather) - u_feather;
    float w = smoothstep(n - u_feather, n + u_feather, edge);
    if (t >= 1.0) w = 1.0;
    if (t <= 0.0) w = 0.0;
    vec3 from = texture2D(u_from, clamp(fromUv, 0.0, 1.0)).rgb;
    vec3 to = texture2D(u_to, clamp(toUv, 0.0, 1.0)).rgb;
    // Convex: weights 1 - w and w, nothing added.
    FRAG_OUT = vec4(mix(from, to, w), 1.0);
}
`;

/** The new picture's weight at `progress` for a pixel with noise `n`
 *  (0.1..0.9), as the shader computes it (for tests and the measuring
 *  page). */
export function warpWeight(progress, n, feather = WARP_FEATHER) {
  const t = Math.max(0, Math.min(1, progress));
  if (t >= 1) return 1;
  if (t <= 0) return 0;
  const eased = t * t * (3 - 2 * t);
  const edge = eased * (1 + 2 * feather) - feather;
  const x = Math.max(0, Math.min(1, (edge - (n - feather)) / (2 * feather)));
  return x * x * (3 - 2 * x);
}
