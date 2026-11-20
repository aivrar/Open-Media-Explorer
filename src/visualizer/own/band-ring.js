/* World Media's own scene: Sound Ring.
 * Glowing rings round the middle, each a little behind the one inside it.
 * The bass bends them in broad lobes, the mids in smaller ones, the highs
 * in fine ripples: shape only, the light stays as it is. No borrowed code.
 */
export default function load(G) {
  G.EffectRegistry.register({
    name: 'band_ring',
    label: 'Sound Ring',
    category: 'Sound Shapes',
    description: 'Glowing rings bent into lobes by the bass, mids and highs',
    params: [
      { name: 'speed', label: 'Speed', min: 0.1, max: 2, default: 0.6, step: 0.05 },
      { name: 'rings', label: 'Rings', min: 2, max: 8, default: 5, step: 1, type: 'int' },
      { name: 'size', label: 'Size', min: 0.5, max: 1.6, default: 1, step: 0.05 },
      { name: 'react', label: 'Sound Response', min: 0, max: 1, default: 0.5, step: 0.05 },
      { name: 'brightness', label: 'Brightness', min: 0.3, max: 1.2, default: 0.8, step: 0.05 },
      { name: 'palette', label: 'Palette', type: 'select', options: ['Neon', 'Ember', 'Glacier', 'Moss'], default: 0 },
    ],
    shader: `
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform float u_speed;
uniform float u_rings;
uniform float u_size;
uniform float u_react;
uniform float u_brightness;
uniform float u_palette;

vec3 ringStops(float t, vec3 a, vec3 b, vec3 c) {
    float x = fract(t) * 3.0;
    if (x < 1.0) return mix(a, b, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(b, c, smoothstep(0.0, 1.0, x - 1.0));
    return mix(c, a, smoothstep(0.0, 1.0, x - 2.0));
}

vec3 ringPalette(float t) {
    if (u_palette < 0.5) return ringStops(t, vec3(1.00, 0.25, 0.75), vec3(0.20, 0.95, 1.00), vec3(0.60, 0.35, 1.00));
    if (u_palette < 1.5) return ringStops(t, vec3(0.95, 0.35, 0.10), vec3(1.00, 0.70, 0.20), vec3(0.85, 0.15, 0.20));
    if (u_palette < 2.5) return ringStops(t, vec3(0.30, 0.75, 1.00), vec3(0.75, 0.95, 1.00), vec3(0.25, 0.45, 0.95));
    return ringStops(t, vec3(0.30, 0.85, 0.35), vec3(0.75, 0.95, 0.30), vec3(0.15, 0.70, 0.65));
}

void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0);
    float r = length(p);
    float a = atan(p.y, p.x);
    float t = u_time * u_speed + seedPhase();
    float react = clamp(u_react, 0.0, 1.0);
    float bass = clamp(u_audio.x, 0.0, 1.0) * react;
    float mid = clamp(u_audio.y, 0.0, 1.0) * react;
    float high = clamp(u_audio.z, 0.0, 1.0) * react;
    float size = clamp(u_size, 0.5, 1.6);
    float n = clamp(floor(u_rings + 0.5), 2.0, 8.0);

    // A soft light in the middle and wide halos: thin rings alone left the
    // picture near black (mean 0.02).
    vec3 col = ringPalette(0.5) * 0.09 * exp(-r * r * 4.0);
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        if (fi >= n) break;
        // The outer rings follow the inner ones a little later.
        float tt = t - fi * 0.35;
        float bend = 0.012 * sin(3.0 * a + tt * 0.5)
            + bass * 0.060 * sin(2.0 * a + tt * 0.7)
            + mid * 0.035 * sin(5.0 * a - tt * 1.1)
            + high * 0.016 * sin(11.0 * a + tt * 1.7);
        float radius = size * (0.16 + fi * 0.042 + bend);
        float d = r - radius;
        float width = 0.008 + fi * 0.001;
        float glow = exp(-d * d / (width * width)) + 0.45 * exp(-abs(d) / (width * 7.0));
        float fade = 1.0 - fi / n * 0.6;
        col += ringPalette(fi / n * 0.8 + t * 0.015) * glow * fade * 0.6;
    }
    col *= clamp(u_brightness, 0.3, 1.2);
    // Soft shoulder: overlapping rings never clip to white at once.
    col = col / (1.0 + col * 0.6);
    FRAG_OUT = vec4(col, 1.0);
}
`,
  });
  return {};
}
