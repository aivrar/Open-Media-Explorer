// Adapt the local shader when it registers, leaving the vendored import intact.
export function withFlightShader(module, shade) {
  return {
    default: (G) => module.default({
      ...G,
      EffectRegistry: { register: (def) => G.EffectRegistry.register({ ...def, shader: shade(def.shader) }) },
    }),
  };
}

// The Koch look's rays usually escape the compact fractal. Give them a
// continuous tunnel wall around the flight axis, with the DIFS surfaces
// still shaded in front of it wherever the march finds one.
const DIFS_TUNNEL_GLSL = `
vec3 tunnelWall(vec2 uv, float t, out float ring) {
    uv -= vec2(sin(t * 0.34), cos(t * 0.26)) * 0.085;
    float radius = max(length(uv), 0.025);
    float depth = 0.82 / radius;
    float angle = atan(uv.y, uv.x + 0.00001);
    float ribs = 0.5 + 0.5 * cos(angle * 8.0 + depth * 0.34);
    float bands = 0.5 + 0.5 * cos(depth * 7.0 + t * u_flight_speed * 2.3);
    float nearWall = smoothstep(0.09, 0.33, radius);
    ring = smoothstep(0.52, 0.96, bands) * nearWall;
    float wall = 0.62 + 0.38 * ribs * nearWall + 0.75 * ring;
    float exitLight = 1.0 - smoothstep(0.03, 0.26, radius);
    float hue = 0.5 - 0.5 * cos(t * 0.3141593 * (u_color_speed / 0.72));
    vec3 tint = mix(vec3(0.020, 0.079, 0.125), vec3(0.157, 0.043, 0.075), hue);
    // Lift the wall before the existing filmic tonemap and gamma.
    return 1.25 * (tint * wall + vec3(0.135, 0.15, 0.16) * exitLight);
}
`;

export function difsTunnelShading(shader) {
  return shader
    .replace('struct DifsHit {', [
      'uniform vec4 u_audio;',
      'uniform vec4 u_beat;',
      DIFS_TUNNEL_GLSL,
      'struct DifsHit {',
    ].join('\n'))
    .replace('vec3 col = background(rd, t);', [
      'vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / u_resolution.y;',
      'float ring;',
      'vec3 wall = tunnelWall(uv, u_time, ring);',
      'vec3 col = wall;',
    ].join('\n    '))
    .replace('col = light;', 'col = mix(wall, light, 0.42);')
    .replace('col += paletteDifs(t * 0.035 + total * 0.035, u_palette) * glowAccum * u_glow;',
      'if (hitT >= 0.0) col += paletteDifs(t * 0.035 + total * 0.035, u_palette) * glowAccum * u_glow * 0.3;')
    .replace('background(rd, t) + paletteDifs(t * 0.02, u_palette) * 0.048', 'wall')
    .replace('FRAG_OUT = vec4(col, 1.0);', [
      // The renderer passes the limiter's bass and hit envelopes.
      'float bass = clamp(u_audio.x, 0.0, 1.0);',
      'float hit = clamp(max(u_beat.x, u_beat.y), 0.0, 1.0);',
      'col += (1.0 - col) * (0.045 * bass * (0.25 + 0.75 * ring) + 0.035 * hit * ring);',
      'FRAG_OUT = vec4(col, 1.0);',
    ].join('\n    '));
}

export function hypercomplexPreviewShading(shader) {
  // The distance estimator can still pop at the camera. Bound the preview's
  // entire output range so even that worst-case step is at most 0.07.
  return shader.replace('FRAG_OUT = vec4(col, 1.0);',
    'FRAG_OUT = vec4(vec3(0.055, 0.060, 0.075) + 0.07 * clamp(col, 0.0, 1.0), 1.0);');
}
