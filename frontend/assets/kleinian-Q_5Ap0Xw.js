function a(e){return e.EffectRegistry.register({name:"kleinian",label:"Kleinian Group",category:"Fractals",description:"Limit sets of Kleinian groups - intricate lacework of circles and gaskets",params:[{name:"max_iter",label:"Iterations",min:20,max:300,default:30,step:10,type:"int"},{name:"zoom",label:"Zoom",min:.3,max:5,default:1,step:.1},{name:"param_a",label:"Parameter A",min:1.5,max:2.5,default:1.96,step:.01},{name:"param_b",label:"Parameter B",min:0,max:2,default:.5,step:.01},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"animate",label:"Animate",min:0,max:1,default:.1,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_max_iter;
uniform float u_zoom;
uniform float u_param_a;
uniform float u_param_b;
uniform float u_color_speed;
uniform float u_animate;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b) { float d = dot(b,b); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d; }

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    uv = rot2(u_global_rotation * 0.25 + u_time * u_animate * 0.018) * uv;
    uv *= 2.65 / max(u_zoom, 0.05);

    float a = u_param_a + sin(u_time * 0.2) * u_animate * 0.1;
    float b = u_param_b + cos(u_time * 0.15) * u_animate * 0.1;
    a = max(a, 0.35);

    // Strip-folded circle inversions approximate a Kleinian limit-set field.
    vec2 z = uv;
    float lineTrap = 1e10;
    float circleTrap = 1e10;
    float foldTrap = 1e10;
    float trap = 1e10;
    float orbitLength = 0.0;

    for (float i = 0.0; i < 300.0; i++) {
        if (i >= u_max_iter) break;
        float fi = i + 1.0;
        float drift = sin(u_time * (0.08 + u_animate * 0.08) + fi * 0.37) * u_animate * 0.035;
        float trapScale = 1.0 + fi * 0.085;

        // Mirrored repeat (unchanged inside [-a/2, a/2]): the side circle is
        // not symmetric, so a plain wrap left a hard vertical seam.
        z.x = abs(mod(z.x - a * 0.5, a * 2.0) - a) - a * 0.5;
        z.y = abs(z.y);

        vec2 upperCenter = vec2(0.0, 0.64 + b * 0.12 + drift);
        float upperRadius = 0.72 + b * 0.06;
        vec2 upper = z - upperCenter;
        float upperLen = length(upper);
        circleTrap = min(circleTrap, abs(upperLen - upperRadius) * trapScale);
        if (upperLen < upperRadius && upperLen > 0.00001) {
            z = upperCenter + upper * ((upperRadius * upperRadius) / max(dot(upper, upper), 0.00001));
            orbitLength += 1.0;
        }

        vec2 sideCenter = vec2(a * (0.28 + 0.08 * sin(fi * 0.41)), 0.16 + b * 0.18);
        vec2 side = z - sideCenter;
        float sideRadius = 0.46 + b * 0.08;
        float sideLen = length(side);
        circleTrap = min(circleTrap, abs(sideLen - sideRadius) * trapScale);
        if (sideLen < sideRadius && sideLen > 0.00001) {
            z = sideCenter + side * ((sideRadius * sideRadius) / max(dot(side, side), 0.00001));
            orbitLength += 0.72;
        }

        float baseLine = abs(z.y - (0.10 + 0.04 * sin(fi * 0.31 + b)));
        float mirrorLine = abs(z.y - (0.72 + 0.08 * cos(fi * 0.27 + b)));
        lineTrap = min(lineTrap, min(baseLine, mirrorLine) * trapScale);
        foldTrap = min(foldTrap, (abs(abs(z.x) - a * 0.32) + abs(z.y) * 0.18) * trapScale);

        float r2 = dot(z, z);
        trap = min(trap, sqrt(max(r2, 0.0)));
        if (r2 > 0.00001) {
            float invRadius = 0.92 + b * 0.10;
            float k = (invRadius * invRadius) / r2;
            if (r2 < invRadius * invRadius * 1.35) {
                z *= clamp(k, 0.35, 3.20);
                orbitLength += smoothstep(0.45, 2.5, k) * 0.45;
            }
        }

        z = rot2(drift * 0.75 + fi * 0.006 * u_animate) * z;
        z = mix(z, uv, 0.018);
        trap = min(trap, length(z));
    }

    // Coloring
    float circleEdge = smoothstep(0.014, 0.0, circleTrap);
    float lineEdge = smoothstep(0.006, 0.0, lineTrap);
    float foldEdge = smoothstep(0.010, 0.0, foldTrap);
    float edge = pow(clamp(circleEdge + lineEdge * 0.16 + foldEdge * 0.12, 0.0, 1.0), 2.35);
    // Detail from the inversion count and the orbit trap, which form bands;
    // the summed angle used before changed chaotically pixel to pixel (grain).
    float detail = sin(orbitLength * 0.72 + trap * 3.0) * 0.5 + 0.5;
    float dust = exp(-trap * 1.65) * 0.012;

    float hue = fract(trap * 0.2 + orbitLength * 0.05 + u_time * u_color_speed * 0.05);
    float sat = 0.58 + 0.38 * edge;
    float val = clamp(edge * (0.32 + 0.68 * detail) + dust, 0.0, 1.0);

    vec3 col = hsv2rgb(vec3(hue, sat, val));
    col += rainbow(orbitLength * 0.03 + u_time * 0.02) * edge * 0.12;
    col += hsv2rgb(vec3(hue + 0.18, 0.55, dust)) * dust;
    col = mix(vec3(0.002, 0.003, 0.008), col, smoothstep(0.006, 0.18, val));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
