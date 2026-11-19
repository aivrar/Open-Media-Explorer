function t(e){return e.EffectRegistry.register({name:"kaleidoscope",label:"Kaleidoscope",category:"Distortion",description:"Mirror-chamber kaleidoscope: wedge, three-mirror tube, square, hex, recursive and spiral folds over animated source patterns",specialize:["fold_style","source_mode"],params:[{name:"fold_style",label:"Mirror Style",type:"select",options:["Polar Wedge","Three-Mirror Tube","Square Mirrors","Hex Mirrors","Recursive Fold","Spiral Tunnel"],default:1},{name:"segments",label:"Segments",min:2,max:16,default:6,step:1,type:"int"},{name:"source_mode",label:"Source Pattern",type:"select",options:["Wave Glass","Voronoi Shards","Fractal Ink","Star Lattice","Bubble Cells","Flame Wisps","Bent Blades","Concentric Bloom","Cosine Lace","Smoke Petals","Ribbon Fans","Neuron Web"],default:1},{name:"speed",label:"Speed",min:.1,max:3,default:.8,step:.1},{name:"zoom",label:"Zoom",min:.5,max:5,default:2,step:.1},{name:"chamber",label:"Mirror Size",min:.15,max:1.5,default:.55,step:.01},{name:"rotation",label:"Rotation Speed",min:-2,max:2,default:.2,step:.05},{name:"drift",label:"Object Drift",min:0,max:2,default:.6,step:.05},{name:"complexity",label:"Complexity",min:1,max:5,default:3,step:.5},{name:"edge_glow",label:"Edge Glow",min:0,max:2,default:.8,step:.05},{name:"seam_glow",label:"Mirror Seams",min:0,max:2,default:.5,step:.05},{name:"palette",label:"Palette",type:"select",palette:!0,options:["Rainbow Glass","Neon Prism"],default:0},{name:"color_speed",label:"Color Speed",min:0,max:3,default:.4,step:.05},{name:"vividness",label:"Vividness",min:0,max:2,default:1.25,step:.05},{name:"contrast",label:"Contrast",min:.5,max:2.5,default:1.3,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_fold_style;
uniform float u_segments;
uniform float u_source_mode;
uniform float u_speed;
uniform float u_zoom;
uniform float u_chamber;
uniform float u_rotation;
uniform float u_drift;
uniform float u_complexity;
uniform float u_edge_glow;
uniform float u_seam_glow;
uniform float u_palette;
uniform float u_color_speed;
uniform float u_vividness;
uniform float u_contrast;

vec3 kaleidoPalette(float t) {
    t = fract(t);
    if (u_palette > 1.5) return psyLut(t);
    if (u_palette > 0.5) return neon(t);
    return rainbow(t);
}

// Reflect p into the half-plane dot(p, n) >= d; tracks distance to the
// nearest mirror so seams can glow.
vec2 mirrorLine(vec2 p, vec2 n, float d, inout float seam) {
    float side = dot(p, n) - d;
    p -= 2.0 * min(side, 0.0) * n;
    seam = min(seam, abs(side));
    return p;
}

// Fold the plane into a triangular mirror chamber by repeated reflection.
// kind 0: equilateral (three-mirror tube), 1: 45-45-90 (square), 2: 30-60-90 (hex).
vec2 triangleChamber(vec2 p, int kind, out float seam) {
    seam = 10.0;
    vec2 n2 = kind == 0 ? vec2(0.8660254, -0.5) : (kind == 1 ? vec2(0.7071068, -0.7071068) : vec2(0.5, -0.8660254));
    vec2 n3 = kind == 0 ? vec2(-0.8660254, -0.5) : vec2(-1.0, 0.0);
    float d3 = kind == 0 ? -0.8660254 : -1.0;
    for (int i = 0; i < 28; i++) {
        float s = 10.0;
        p = mirrorLine(p, vec2(0.0, 1.0), 0.0, s);
        p = mirrorLine(p, n2, 0.0, s);
        p = mirrorLine(p, n3, d3, s);
    }
    // Final pass only to measure the seam distance inside the chamber.
    seam = min(min(abs(p.y), abs(dot(p, n2))), abs(dot(p, n3) - d3));
    return p;
}

vec2 jitterCell(vec2 id, float t) {
    return vec2(hash2(id + 13.7), hash2(id + 91.3)) * 0.68 + 0.16 +
        0.10 * vec2(sin(t + hash2(id) * 6.28318), cos(t * 0.7 + hash2(id + 4.0) * 6.28318));
}

vec2 voronoiEdges(vec2 p, float t) {
    vec2 g = floor(p);
    vec2 f = fract(p);
    float closest = 9.0;
    float second = 9.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y));
            vec2 r = o + jitterCell(g + o, t) - f;
            float d = dot(r, r);
            if (d < closest) {
                second = closest;
                closest = d;
            } else if (d < second) {
                second = d;
            }
        }
    }
    return vec2(sqrt(closest), sqrt(second) - sqrt(closest));
}

// Source pattern seen through the mirrors. Returns (value, edge).
vec2 sourcePattern(vec2 p, float t) {
    float mode = floor(u_source_mode + 0.5);
    float val = 0.0;
    float edge = 0.0;
    if (mode < 0.5) {
        val += sin(p.x * 3.0 + t) * 0.5;
        val += sin(p.y * 4.0 - t * 1.3) * 0.5;
        val += sin(length(p) * 5.0 - t * 0.7) * 0.3;
        edge = abs(sin(val * 3.14159));
    } else if (mode < 1.5) {
        vec2 v = voronoiEdges(p * (1.8 + u_complexity * 0.45), t * 0.45);
        edge = exp(-v.y * (12.0 + u_complexity * 3.0));
        val = v.x * 1.7 + edge * 0.8 + fbm(vec3(p * 1.4, t * 0.16)) * 0.35;
    } else if (mode < 2.5) {
        float n = fbm(vec3(p * (1.4 + u_complexity * 0.45), t * 0.18));
        float ink = fbm(vec3(p * 2.8 + n * 1.6, t * 0.12));
        edge = smoothstep(0.22, 0.95, abs(sin((n + ink) * 5.0)));
        val = n * 0.65 + ink * 0.55 + edge * 0.28;
    } else if (mode < 3.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p);
        float spokes = abs(sin(pa * (u_segments * 0.5 + u_complexity) + t));
        float rings = abs(sin(pr * (8.0 + u_complexity * 2.0) - t * 0.8));
        edge = smoothstep(0.58, 1.0, max(spokes, rings));
        val = spokes * 0.42 + rings * 0.46 + pr * 0.24;
    } else if (mode < 4.5) {
        vec2 q = p * (1.45 + u_complexity * 0.42);
        vec2 id = floor(q);
        vec2 f = fract(q) - 0.5;
        vec2 c = vec2(hash2(id + 2.7), hash2(id + 8.9)) - 0.5;
        c += 0.18 * vec2(sin(t * 0.8 + hash2(id) * 6.28318), cos(t * 0.6 + hash2(id + 5.0) * 6.28318));
        float d = length(f - c * 0.58);
        float rings = abs(sin(d * (24.0 + u_complexity * 6.0) - t * 1.4));
        edge = smoothstep(0.78, 1.0, 1.0 - rings) * (1.0 - smoothstep(0.08, 0.58, d));
        val = d * 2.4 + rings * 0.56 + fbm(vec3(q * 0.8, t * 0.12)) * 0.38;
    } else if (mode < 5.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p) + 0.035;
        float fold = sin(pa * (3.0 + u_complexity) + log(pr) * (5.0 + u_complexity) - t * 1.35);
        float smoke = fbm(vec3(p * (2.0 + u_complexity * 0.35), t * 0.22));
        edge = smoothstep(0.46, 0.96, abs(fold + smoke * 0.72));
        val = fold * 0.72 + smoke * 0.86 + 1.0 / (1.0 + pr * 3.0);
    } else if (mode < 6.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p);
        float blades = abs(sin(pa * (4.0 + u_segments * 0.42) + pr * (7.0 + u_complexity) - t * 1.2));
        float sweep = abs(sin((p.x * 1.25 - p.y * 0.85) * (5.0 + u_complexity) + sin(p.y * 2.4 + t) * 1.5));
        edge = smoothstep(0.68, 1.0, max(blades, sweep));
        val = blades * 0.62 + sweep * 0.48 + pr * 0.22;
    } else if (mode < 7.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p);
        float petals = 0.5 + 0.5 * sin(pa * (5.0 + u_complexity * 1.5) + t * 0.75);
        float rings = abs(sin(pr * (10.0 + u_complexity * 3.5) + petals * 2.5 - t * 0.9));
        edge = smoothstep(0.70, 1.0, max(1.0 - rings, petals));
        val = rings * 0.50 + petals * 0.72 + pr * 0.20;
    } else if (mode < 8.5) {
        float lace = cos(p.x * (5.0 + u_complexity) + t) +
            cos(p.y * (6.0 + u_complexity * 0.8) - t * 1.2) +
            cos((p.x + p.y) * (4.0 + u_complexity * 0.6) + t * 0.7);
        float cross = cos((p.x - p.y) * (7.0 + u_complexity) - t * 0.55);
        edge = smoothstep(1.35, 2.85, abs(lace) + abs(cross) * 0.55);
        val = lace * 0.38 + cross * 0.28;
    } else if (mode < 9.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p);
        float n = fbm(vec3(p * (1.8 + u_complexity * 0.38), t * 0.18));
        float petals = sin(pa * (5.0 + u_complexity) + n * 5.5 + t * 0.9);
        float haze = fbm(vec3(p * 3.2 + n, t * 0.10));
        edge = smoothstep(0.34, 0.92, abs(petals) * (0.7 + haze * 0.45));
        val = petals * 0.46 + haze * 0.82 + pr * 0.18;
    } else if (mode < 10.5) {
        float pa = atan(p.y, p.x);
        float pr = length(p);
        float fan = abs(sin((pa + sin(pr * 3.0 - t) * 0.34) * (u_segments + u_complexity) + t * 0.4));
        float ribbon = abs(fract(pr * (3.2 + u_complexity * 0.72) - t * 0.16) - 0.5);
        edge = smoothstep(0.68, 1.0, fan) * (1.0 - smoothstep(0.02, 0.36, ribbon));
        val = fan * 0.58 + (0.5 - ribbon) * 0.92 + pr * 0.22;
    } else {
        vec2 flow = p + 0.16 * vec2(sin(p.y * 3.0 + t), cos(p.x * 2.6 - t * 0.8));
        vec2 v = voronoiEdges(flow * (2.2 + u_complexity * 0.48), t * 0.36);
        float fibers = abs(sin((p.x + p.y) * (5.0 + u_complexity) + t * 1.1));
        edge = exp(-v.y * (14.0 + u_complexity * 3.0)) + smoothstep(0.82, 1.0, fibers) * 0.42;
        val = v.x * 1.3 + edge * 0.65 + fibers * 0.22;
    }
    return vec2(val, edge);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();
    float spin = u_time * u_rotation;
    float r = length(uv);
    float style = floor(u_fold_style + 0.5);
    float seam = 10.0;
    float seamScale = 1.0;
    vec2 p;
    vec2 pB = vec2(0.0);
    float wB = 0.0;

    if (style < 0.5) {
        // Polar wedge: N-fold mirror symmetry around the centre.
        float a = atan(uv.y, uv.x) + spin;
        float seg = 6.28318530718 / max(u_segments, 2.0);
        a = mod(a, seg);
        a = min(a, seg - a);
        seam = a * r;
        p = vec2(cos(a), sin(a)) * r;
    } else if (style < 3.5) {
        // Mirror chambers: three-mirror tube, square, hex.
        int kind = style < 1.5 ? 0 : (style < 2.5 ? 1 : 2);
        float size = max(u_chamber, 0.05);
        vec2 q = rot2(spin) * uv / size;
        p = triangleChamber(q, kind, seam) * size;
        seamScale = size;
    } else if (style < 4.5) {
        // Recursive fold: a kaleidoscope inside a kaleidoscope.
        p = rot2(spin) * uv;
        float sc = 1.0;
        int levels = int(2.0 + u_complexity);
        for (int i = 0; i < 7; i++) {
            if (i >= levels) break;
            p = abs(p);
            if (p.y > p.x) p = p.yx;
            p = rot2(0.35 + 0.15 * sin(t * 0.2 + float(i))) * p;
            p = p * 1.55 - vec2(0.42, 0.18) * u_chamber * 1.6;
            sc *= 1.55;
            seam = min(seam, min(abs(p.x), abs(p.y)) / sc);
        }
        p /= sc * 0.55;
    } else {
        // Spiral tunnel: log-polar wedge that flows inward forever.
        float lr = log(max(r, 0.0005));
        float a = atan(uv.y, uv.x) + spin + lr * 0.6;
        float seg = 6.28318530718 / max(u_segments, 2.0);
        a = mod(a, seg);
        a = min(a, seg - a);
        // Two depth layers half a period apart, crossfaded, so the inward
        // flow never shows the wrap-around ring.
        float flow = (lr - t * 0.25) / 1.2;
        float fA = fract(flow);
        float fB = fract(flow + 0.5);
        vec2 dir = vec2(cos(a), sin(a));
        seam = a * 0.6;
        p = dir * exp(fA * 1.2) * 0.6;
        pB = dir * exp(fB * 1.2) * 0.6;
        wB = 1.0 - abs(fA * 2.0 - 1.0);
    }

    // The object drifts through the mirror chamber.
    vec2 drift = vec2(sin(t * 0.21), cos(t * 0.17)) * u_drift * 0.8 + vec2(t * 0.05 * u_drift, 0.0);
    vec2 src = sourcePattern(p * u_zoom + drift, t);
    if (wB > 0.0) src = mix(src, sourcePattern(pB * u_zoom + drift, t), wB);
    float val = src.x;
    float edge = src.y;

    if (u_complexity > 2.0) {
        val += sin(p.x * p.y * 2.0 + t) * 0.3;
        val += snoise(vec3(p * 2.0, t * 0.5)) * 0.4;
    }

    float hueT = val * 0.3 + u_time * u_color_speed * 0.08 + r * 0.2;
    vec3 col = kaleidoPalette(hueT);
    col *= 0.62 + 0.42 * sin(val * 3.14159);
    col += kaleidoPalette(hueT + 0.35) * edge * (0.10 + u_edge_glow * 0.30);

    // Bright mirror seams, like light catching the mirror edges.
    float seamGlow = exp(-seam / max(seamScale, 0.05) * 60.0);
    col += vec3(1.0, 0.95, 1.0) * seamGlow * u_seam_glow * 0.35;

    // Vividness and contrast act on display colours directly.
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, u_vividness);
    col = (col - 0.5) * u_contrast + 0.5;
    col *= smoothstep(1.6, 0.3, r) * 0.35 + 0.65;

    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{t as default};
