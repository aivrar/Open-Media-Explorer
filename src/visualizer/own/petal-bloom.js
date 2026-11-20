/* World Media's own scene: Petal Bloom.
 * Layers of rounded petals round the middle, the smaller ones in front,
 * each layer turning slowly its own way. The bass lengthens the petals a
 * little, the highs ruffle their tips: shape only, the light stays as it
 * is. No borrowed code.
 */
export default function load(G) {
  G.EffectRegistry.register({
    name: 'petal_bloom',
    label: 'Petal Bloom',
    category: 'Sound Shapes',
    description: 'Layers of petals turning slowly, stretching with the bass',
    params: [
      { name: 'speed', label: 'Speed', min: 0.1, max: 2, default: 0.5, step: 0.05 },
      { name: 'petals', label: 'Petals', min: 3, max: 12, default: 6, step: 1, type: 'int' },
      { name: 'layers', label: 'Layers', min: 2, max: 5, default: 4, step: 1, type: 'int' },
      { name: 'react', label: 'Sound Response', min: 0, max: 1, default: 0.5, step: 0.05 },
      { name: 'brightness', label: 'Brightness', min: 0.3, max: 1.2, default: 0.75, step: 0.05 },
      { name: 'palette', label: 'Palette', type: 'select', options: ['Ember', 'Neon', 'Moss', 'Glacier'], default: 0 },
    ],
    shader: `
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform float u_speed;
uniform float u_petals;
uniform float u_layers;
uniform float u_react;
uniform float u_brightness;
uniform float u_palette;

vec3 petalStops(float t, vec3 a, vec3 b, vec3 c) {
    float x = fract(t) * 3.0;
    if (x < 1.0) return mix(a, b, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(b, c, smoothstep(0.0, 1.0, x - 1.0));
    return mix(c, a, smoothstep(0.0, 1.0, x - 2.0));
}

vec3 petalPalette(float t) {
    if (u_palette < 0.5) return petalStops(t, vec3(0.95, 0.35, 0.10), vec3(1.00, 0.70, 0.20), vec3(0.85, 0.15, 0.20));
    if (u_palette < 1.5) return petalStops(t, vec3(1.00, 0.25, 0.75), vec3(0.20, 0.95, 1.00), vec3(0.60, 0.35, 1.00));
    if (u_palette < 2.5) return petalStops(t, vec3(0.30, 0.85, 0.35), vec3(0.75, 0.95, 0.30), vec3(0.15, 0.70, 0.65));
    return petalStops(t, vec3(0.30, 0.75, 1.00), vec3(0.75, 0.95, 1.00), vec3(0.25, 0.45, 0.95));
}

void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0);
    float r = length(p);
    float a = atan(p.y, p.x);
    float px = 1.0 / max(u_resolution.y, 1.0);
    float t = u_time * u_speed + seedPhase();
    float react = clamp(u_react, 0.0, 1.0);
    float bass = clamp(u_audio.x, 0.0, 1.0) * react;
    float high = clamp(u_audio.z, 0.0, 1.0) * react;
    float petals = clamp(floor(u_petals + 0.5), 3.0, 12.0);
    float n = clamp(floor(u_layers + 0.5), 2.0, 5.0);

    vec3 col = petalPalette(0.6) * 0.04 * (1.0 - r);
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        if (fi >= n) break;
        // Back (largest) to front (smallest), turning alternate ways.
        float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
        float a2 = a + dir * t * 0.08 * (1.0 + fi * 0.3) + fi * 0.35;
        float lobe = abs(cos(petals * 0.5 * a2));
        float reach = (0.44 - fi * 0.07 * (4.0 / n)) * (1.0 + 0.08 * bass);
        float edge = reach * (0.45 + 0.55 * lobe) + high * 0.008 * sin(a2 * petals * 3.0 + t * 2.0);
        float inside = 1.0 - smoothstep(edge - 1.5 * px, edge + 1.5 * px, r);
        // Lighter toward the tips, a dark seam at the petal edge.
        float shade = 0.45 + 0.45 * clamp(r / max(edge, 0.001), 0.0, 1.0);
        float seam = smoothstep(edge - 6.0 * px, edge - 1.5 * px, r) * 0.35;
        vec3 petalCol = petalPalette(fi / n * 0.6 + t * 0.012) * shade * (1.0 - seam);
        col = mix(col, petalCol, inside * 0.9);
    }
    col *= clamp(u_brightness, 0.3, 1.2);
    FRAG_OUT = vec4(col, 1.0);
}
`,
  });
  return {};
}
