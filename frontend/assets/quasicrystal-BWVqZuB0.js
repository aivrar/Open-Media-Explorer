function t(e){return e.EffectRegistry.register({name:"quasicrystal",label:"Quasicrystal",category:"Patterns",description:"Quasi-periodic wave interference with N-fold symmetry: smooth waves, interference stripes, polar rosettes and Penrose-like contours",specialize:["style"],params:[{name:"style",label:"Style",type:"select",options:["Smooth Waves","Interference Stripes","Polar Rosette","Contour Glow"],default:0},{name:"symmetry",label:"Symmetry",min:3,max:15,default:7,step:1,type:"int"},{name:"frequency",label:"Frequency",min:2,max:60,default:18,step:.5},{name:"speed",label:"Speed",min:0,max:3,default:.8,step:.05},{name:"rotation",label:"Rotation",min:-1,max:1,default:.05,step:.01},{name:"contrast",label:"Contrast",min:.5,max:3,default:1.4,step:.05},{name:"color_speed",label:"Color Speed",min:0,max:3,default:.25,step:.05},{name:"palette",label:"Palette",type:"select",palette:!0,options:["Rainbow","Neon"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_style;
uniform float u_symmetry;
uniform float u_frequency;
uniform float u_speed;
uniform float u_rotation;
uniform float u_contrast;
uniform float u_color_speed;
uniform float u_palette;

vec3 qPalette(float t) {
    t = fract(t);
    if (u_palette > 1.5) return psyLut(t);
    if (u_palette > 0.5) return neon(t);
    return rainbow(t);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed;
    float style = floor(u_style + 0.5);
    vec2 p = rot2(u_time * u_rotation) * uv;
    if (style > 1.5 && style < 2.5) {
        // Polar rosette: waves in log-polar space.
        // abs() mirrors the angle so both sides of the atan wrap meet (a
        // mirror line instead of a seam on the left).
        p = vec2(log(max(length(uv), 0.001)) * 0.5, abs(atan(uv.y, uv.x)) / 3.14159265 * 2.0);
    }
    float n = floor(u_symmetry + 0.5);
    float v = 0.0;
    for (int k = 0; k < 15; k++) {
        float fk = float(k);
        if (fk >= n) break;
        float a = fk * 3.14159265 / n;
        float dir = mod(fk, 2.0) < 0.5 ? 1.0 : -1.0;
        v += cos(dot(p, vec2(cos(a), sin(a))) * u_frequency + t * dir);
    }
    v /= n;
    float hueBase = u_time * u_color_speed * 0.05;
    vec3 col;
    if (style < 0.5 || (style > 1.5 && style < 2.5)) {
        float s = 0.5 + 0.5 * v;
        s = clamp((s - 0.5) * u_contrast + 0.5, 0.0, 1.0);
        col = qPalette(s * 0.6 + hueBase) * (0.25 + 0.75 * s);
    } else if (style < 1.5) {
        float stripes = 0.5 + 0.5 * cos(v * 3.14159 * 6.0 * u_contrast + t);
        col = qPalette(v * 0.5 + hueBase) * stripes;
    } else {
        float level = fract(v * 4.0 + t * 0.1);
        float line = smoothstep(0.08, 0.0, min(level, 1.0 - level));
        col = qPalette(v + hueBase) * (0.12 + 0.2 * (0.5 + 0.5 * v)) + qPalette(v * 2.0 + hueBase + 0.3) * line * u_contrast;
    }
    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{t as default};
