function o(e){return e.EffectRegistry.register({name:"domain_colouring",label:"Complex Domain Colouring",category:"Math",description:"Glowing phase portraits of complex functions, with drifting zeros and poles",params:[{name:"func",label:"Function",type:"select",options:["Zeros and Poles","Roots of Unity","Complex Sine","Exponential Spiral","Möbius Morph","Blaschke Product"],default:0},{name:"order",label:"Order",type:"int",min:2,max:9,default:5,step:1},{name:"zoom",label:"Zoom",min:.3,max:4,default:1.2,step:.01},{name:"speed",label:"Morph Speed",min:0,max:2,default:.4,step:.01},{name:"contours",label:"Contour Rings",min:0,max:1,default:.6,step:.01},{name:"phase_lines",label:"Phase Lines",min:0,max:1,default:.35,step:.01},{name:"saturation",label:"Saturation",min:0,max:1,default:.85,step:.01},{name:"style",label:"Style",type:"select",options:["Classic","Neon Lines","Pastel","Dark Glow"],default:1},{name:"palette",label:"Hue Palette",type:"select",palette:!0,options:["Rainbow"],default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_func;
uniform float u_order;
uniform float u_zoom;
uniform float u_speed;
uniform float u_contours;
uniform float u_phase_lines;
uniform float u_saturation;
uniform float u_style;
uniform float u_palette;
uniform float u_audio_react;
uniform vec4 u_audio;
uniform vec4 u_beat;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { float d = dot(b, b) + 1e-9; return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / d; }
vec2 cexp(vec2 z) { return exp(z.x) * vec2(cos(z.y), sin(z.y)); }
vec2 csin(vec2 z) { float ep = exp(z.y), em = exp(-z.y); return vec2(sin(z.x) * (ep + em), cos(z.x) * (ep - em)) * 0.5; }
vec2 cpow(vec2 z, float n) { float r = length(z); float a = atan(z.y, z.x); return pow(r, n) * vec2(cos(a * n), sin(a * n)); }
vec2 cis(float a) { return vec2(cos(a), sin(a)); }

vec2 evalF(vec2 z, float t) {
    float f = floor(u_func + 0.5);
    float n = floor(u_order + 0.5);
    if (f < 0.5) {
        // Moving zeros (numerator) and poles (denominator).
        vec2 num = vec2(1.0, 0.0), den = vec2(1.0, 0.0);
        for (int i = 0; i < 9; i++) {
            if (float(i) >= n) break;
            float fi = float(i);
            vec2 zr = cis(t * (0.3 + fi * 0.07) + fi * 2.4) * (0.4 + 0.5 * fract(fi * 0.618));
            if (mod(fi, 2.0) < 0.5) num = cmul(num, z - zr);
            else den = cmul(den, z - zr * 1.2);
        }
        return cdiv(num, den);
    }
    if (f < 1.5) return cpow(z, n) - cis(t);
    if (f < 2.5) return csin(cmul(z, vec2(1.5 + 0.5 * sin(t * 0.5), 0.3 * cos(t * 0.3))) * n * 0.5);
    if (f < 3.5) return cexp(cmul(z, cis(t * 0.2) * n * 0.6)) - cpow(z, 2.0);
    if (f < 4.5) {
        vec2 a = cis(t) * 0.6, b = cis(-t * 0.7) * 0.4;
        vec2 m = cdiv(z - a, vec2(1.0, 0.0) - cmul(vec2(b.x, -b.y), z));
        return cpow(m, n);
    }
    // Blaschke product: zeros inside the unit disk, unit modulus on the circle.
    vec2 p = vec2(1.0, 0.0);
    for (int i = 0; i < 9; i++) {
        if (float(i) >= n) break;
        float fi = float(i);
        vec2 a = cis(t * (0.2 + fi * 0.05) + fi * 2.1) * (0.3 + 0.6 * fract(fi * 0.38));
        p = cmul(p, cdiv(z - a, vec2(1.0, 0.0) - cmul(vec2(a.x, -a.y), z)));
    }
    return p;
}

vec3 hueColor(float h) {
    if (floor(u_palette + 0.5) >= 0.5) return psyLut(h);
    return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float react = u_audio_react;
    float bass = u_audio.x * react;
    float kick = u_beat.x * react;
    float t = u_time * u_speed + seedPhase();
    vec2 z = uv * 2.6 / (u_zoom * (1.0 + bass * 0.12));
    vec2 w = evalF(z, t);

    float arg = atan(w.y, w.x) / 6.28318 + 0.5;
    float hue = arg + u_beat.w * 0.02 * react;
    float lm = log2(max(length(w), 1e-6));
    // Contours where |f| doubles, phase lines every 30 degrees; widths from screen derivatives.
    float cr = fract(lm);
    float cw = clamp(fwidth(lm) * 1.5, 0.002, 0.5);
    float ring = smoothstep(cw, 0.0, min(cr, 1.0 - cr));
    float ph = fract(arg * 12.0);
    float pw = clamp(fwidth(arg * 12.0) * 1.5, 0.002, 0.5);
    float pline = smoothstep(pw, 0.0, min(ph, 1.0 - ph));
    float shade = 0.6 + 0.4 * cr;

    vec3 base = mix(vec3(dot(hueColor(hue), vec3(0.333))), hueColor(hue), u_saturation);
    float s = floor(u_style + 0.5);
    vec3 col;
    if (s < 0.5) {
        col = base * shade;
        col *= 1.0 - ring * u_contours * 0.6;
        col *= 1.0 - pline * u_phase_lines * 0.5;
    } else if (s < 1.5) {
        col = base * 0.3 * shade;
        col += hueColor(hue + 0.1) * ring * u_contours * (1.4 + kick * 1.5);
        col += vec3(1.0) * pline * u_phase_lines * 0.5;
    } else if (s < 2.5) {
        col = mix(base, vec3(1.0), 0.45) * (0.85 + 0.15 * cr);
        col *= 1.0 - ring * u_contours * 0.3;
        col *= 1.0 - pline * u_phase_lines * 0.25;
    } else {
        col = base * pow(cr, 3.0) * 0.8;
        col += base * ring * u_contours * (1.0 + kick);
        col += base * pline * u_phase_lines * 0.4;
    }
    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{o as default};
