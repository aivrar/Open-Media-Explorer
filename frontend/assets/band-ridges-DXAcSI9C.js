function t(e){return e.EffectRegistry.register({name:"band_ridges",label:"Band Ridgelines",category:"Sound Shapes",description:"Stacked ridgelines that rise with the bass, mids and highs",params:[{name:"speed",label:"Speed",min:.1,max:2,default:.6,step:.05},{name:"lines",label:"Lines",min:8,max:48,default:28,step:1,type:"int"},{name:"height",label:"Ridge Height",min:.2,max:2,default:1,step:.05},{name:"react",label:"Sound Response",min:0,max:1,default:.5,step:.05},{name:"brightness",label:"Brightness",min:.3,max:1.2,default:.85,step:.05},{name:"palette",label:"Palette",type:"select",options:["Paper","Ember","Glacier","Neon"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform float u_speed;
uniform float u_lines;
uniform float u_height;
uniform float u_react;
uniform float u_brightness;
uniform float u_palette;

float ridgeHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

// Smooth 1D value noise: 0..1.
float ridgeNoise(float x, float seed) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(ridgeHash(i + seed * 57.0), ridgeHash(i + 1.0 + seed * 57.0), u);
}

// Three colour stops, round the circle.
vec3 ridgeStops(float t, vec3 a, vec3 b, vec3 c) {
    float x = fract(t) * 3.0;
    if (x < 1.0) return mix(a, b, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(b, c, smoothstep(0.0, 1.0, x - 1.0));
    return mix(c, a, smoothstep(0.0, 1.0, x - 2.0));
}

vec3 ridgePalette(float t) {
    if (u_palette < 0.5) return ridgeStops(t, vec3(0.92, 0.90, 0.85), vec3(0.80, 0.82, 0.86), vec3(0.95, 0.88, 0.78));
    if (u_palette < 1.5) return ridgeStops(t, vec3(0.95, 0.35, 0.10), vec3(1.00, 0.70, 0.20), vec3(0.85, 0.15, 0.20));
    if (u_palette < 2.5) return ridgeStops(t, vec3(0.30, 0.75, 1.00), vec3(0.75, 0.95, 1.00), vec3(0.25, 0.45, 0.95));
    return ridgeStops(t, vec3(1.00, 0.25, 0.75), vec3(0.20, 0.95, 1.00), vec3(0.60, 0.35, 1.00));
}

void main() {
    vec2 uv = v_uv;
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    float px = 1.0 / max(u_resolution.y, 1.0);
    float t = u_time * u_speed + seedPhase();
    float react = clamp(u_react, 0.0, 1.0);
    float bass = clamp(u_audio.x, 0.0, 1.0) * react;
    float mid = clamp(u_audio.y, 0.0, 1.0) * react;
    float high = clamp(u_audio.z, 0.0, 1.0) * react;

    float n = clamp(floor(u_lines + 0.5), 8.0, 48.0);
    float top = 0.84;
    float bottom = 0.10;
    float spacing = (top - bottom) / n;
    float x = (uv.x - 0.5) * aspect;
    // The ridges rise in the middle and lie flat at the sides.
    float envelope = exp(-x * x * 5.0);
    // Where each band lifts them.
    float wBass = exp(-x * x * 40.0);
    float wMid = exp(-(abs(x) - 0.25) * (abs(x) - 0.25) * 60.0);
    float wHigh = exp(-(abs(x) - 0.45) * (abs(x) - 0.45) * 60.0);
    float lift = 0.7 + 0.6 * (bass * wBass + mid * wMid + high * wHigh);
    float amp = clamp(u_height, 0.2, 2.0) * spacing * 5.0 * envelope * lift;

    vec3 background = ridgePalette(0.15) * 0.035;
    vec3 col = background;
    for (int i = 0; i < 48; i++) {
        float fi = float(i);
        if (fi >= n) break;
        // Back (top) to front (bottom): each ridge hides what is behind it.
        float base = top - fi * spacing;
        float shape = ridgeNoise(x * 7.0 + t * 0.6, fi) * 0.65 + ridgeNoise(x * 16.0 - t * 0.4, fi + 40.0) * 0.35;
        float curve = base + amp * shape;
        if (uv.y < curve) col = background;
        float d = abs(uv.y - curve);
        float line = 1.0 - smoothstep(0.6 * px, 1.8 * px, d);
        float glow = exp(-d / (5.0 * px)) * 0.18;
        vec3 lineCol = ridgePalette(fi / n * 0.7 + t * 0.01) * clamp(u_brightness, 0.3, 1.2);
        col = mix(col, lineCol, line);
        if (uv.y >= curve) col += lineCol * glow;
    }
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
