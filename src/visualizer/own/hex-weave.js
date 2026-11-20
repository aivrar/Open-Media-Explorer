/* World Media's own scene: Hex Weave.
 * A hexagon tiling where each tile holds three arcs that join the middles of
 * its sides, turned one way or the other at random: the arcs link up into
 * endless woven ribbons. The colour flows slowly across them; the bass
 * thickens the ribbons a little. No borrowed code (the hexagon grid is the
 * usual axial-coordinate rounding).
 */
export default function load(G) {
  G.EffectRegistry.register({
    name: 'hex_weave',
    label: 'Hex Weave',
    category: 'Patterns',
    description: 'Woven ribbons on a hexagon tiling, linking without end',
    params: [
      { name: 'speed', label: 'Speed', min: 0.1, max: 2, default: 0.5, step: 0.05 },
      { name: 'tiles', label: 'Tile Count', min: 3, max: 14, default: 7, step: 0.5 },
      { name: 'width', label: 'Ribbon Width', min: 0.05, max: 0.3, default: 0.16, step: 0.01 },
      { name: 'react', label: 'Sound Response', min: 0, max: 1, default: 0.5, step: 0.05 },
      { name: 'brightness', label: 'Brightness', min: 0.3, max: 1.2, default: 0.8, step: 0.05 },
      { name: 'palette', label: 'Palette', type: 'select', options: ['Ember', 'Glacier', 'Neon', 'Moss'], default: 0 },
    ],
    shader: `
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform float u_speed;
uniform float u_tiles;
uniform float u_width;
uniform float u_react;
uniform float u_brightness;
uniform float u_palette;

vec3 weaveStops(float t, vec3 a, vec3 b, vec3 c) {
    float x = fract(t) * 3.0;
    if (x < 1.0) return mix(a, b, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(b, c, smoothstep(0.0, 1.0, x - 1.0));
    return mix(c, a, smoothstep(0.0, 1.0, x - 2.0));
}

vec3 weavePalette(float t) {
    if (u_palette < 0.5) return weaveStops(t, vec3(0.95, 0.35, 0.10), vec3(1.00, 0.70, 0.20), vec3(0.85, 0.15, 0.20));
    if (u_palette < 1.5) return weaveStops(t, vec3(0.30, 0.75, 1.00), vec3(0.75, 0.95, 1.00), vec3(0.25, 0.45, 0.95));
    if (u_palette < 2.5) return weaveStops(t, vec3(1.00, 0.25, 0.75), vec3(0.20, 0.95, 1.00), vec3(0.60, 0.35, 1.00));
    return weaveStops(t, vec3(0.30, 0.85, 0.35), vec3(0.75, 0.95, 0.30), vec3(0.15, 0.70, 0.65));
}

float weaveHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed) * 43758.5453); }

// The nearest hexagon centre (pointy top, centre to corner 1) in axial
// coordinates.
vec2 weaveCell(vec2 p) {
    float q = 0.57735027 * p.x - 0.33333333 * p.y;
    float r = 0.66666667 * p.y;
    vec3 c = vec3(q, r, -q - r);
    vec3 rc = floor(c + 0.5);
    vec3 d = abs(rc - c);
    if (d.x > d.y && d.x > d.z) rc.x = -rc.y - rc.z;
    else if (d.y > d.z) rc.y = -rc.x - rc.z;
    return rc.xy;
}

void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    float tiles = clamp(u_tiles, 3.0, 14.0);
    vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0) * tiles + seedOffset() * 0.01;
    float px = tiles / max(u_resolution.y, 1.0);
    float t = u_time * u_speed + seedPhase();
    float bass = clamp(u_audio.x, 0.0, 1.0) * clamp(u_react, 0.0, 1.0);

    vec2 cell = weaveCell(p);
    vec2 centre = vec2(1.7320508 * (cell.x + cell.y * 0.5), 1.5 * cell.y);
    vec2 local = p - centre;
    // Arcs round every other corner (radius half a side): which three, by
    // the tile's own coin.
    float turn = weaveHash(cell) < 0.5 ? 0.0 : 1.0;
    float best = 10.0;
    for (int k = 0; k < 3; k++) {
        float ang = 0.52359878 + (float(k) * 2.0 + turn) * 1.04719755;
        vec2 corner = vec2(cos(ang), sin(ang));
        best = min(best, abs(length(local - corner) - 0.5));
    }
    float width = clamp(u_width, 0.05, 0.3) * (1.0 + 0.15 * bass);
    float ribbon = 1.0 - smoothstep(width - px, width + px, best);
    // A soft roll across the ribbon, darker at its edges.
    float roll = 0.65 + 0.35 * cos(clamp(best / width, 0.0, 1.0) * 1.5707963);
    float flow = dot(centre, vec2(0.05, 0.03)) + t * 0.03;
    vec3 ribbonCol = weavePalette(flow) * roll;
    vec3 background = weavePalette(flow + 0.5) * 0.05;
    vec3 col = mix(background, ribbonCol, ribbon) * clamp(u_brightness, 0.3, 1.2);
    FRAG_OUT = vec4(col, 1.0);
}
`,
  });
  return {};
}
