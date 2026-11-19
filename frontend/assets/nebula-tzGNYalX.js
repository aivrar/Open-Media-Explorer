function a(e){return e.EffectRegistry.register({name:"nebula",label:"Nebula Flythrough",category:"Cosmic",description:"Fly through glowing volumetric gas clouds and dark dust lanes of a star nursery",params:[{name:"speed",label:"Flight Speed",min:0,max:3,default:.6,step:.01},{name:"density",label:"Gas Density",min:.2,max:3,default:1,step:.01},{name:"glow",label:"Emission",min:.2,max:3,default:1,step:.01},{name:"turbulence",label:"Turbulence",min:0,max:2,default:.8,step:.01},{name:"dust",label:"Dark Dust",min:0,max:1,default:.5,step:.01},{name:"stars",label:"Stars",min:0,max:2,default:1,step:.01},{name:"sway",label:"Camera Sway",min:0,max:1,default:.5,step:.01},{name:"detail",label:"Detail (steps)",type:"int",min:24,max:80,default:48,step:1},{name:"scheme",label:"Nebula",type:"select",options:["Orion","Carina","Eagle Pillars","Neon Dream"],default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_density;
uniform float u_glow;
uniform float u_turbulence;
uniform float u_dust;
uniform float u_stars;
uniform float u_sway;
uniform float u_detail;
uniform float u_scheme;
uniform float u_audio_react;
uniform vec4 u_audio;
uniform vec4 u_beat;

float h31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

float vn3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

float fbm3(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * vn3(p);
        p = p * 2.02 + vec3(3.1, 1.7, 5.3);
        a *= 0.5;
    }
    return v;
}

void nebulaColors(out vec3 a, out vec3 b, out vec3 core) {
    float s = floor(u_scheme + 0.5);
    if (s < 0.5) { a = vec3(1.0, 0.25, 0.55); b = vec3(0.15, 0.6, 0.9); core = vec3(1.0, 0.85, 0.95); }
    else if (s < 1.5) { a = vec3(1.0, 0.6, 0.2); b = vec3(0.2, 0.35, 1.0); core = vec3(1.0, 0.95, 0.8); }
    else if (s < 2.5) { a = vec3(0.35, 0.75, 0.35); b = vec3(0.75, 0.45, 0.2); core = vec3(0.95, 1.0, 0.85); }
    else { a = vec3(1.0, 0.1, 0.9); b = vec3(0.1, 1.0, 0.85); core = vec3(1.0, 1.0, 1.0); }
}

vec3 starfield(vec3 rd, float twinkle) {
    vec3 col = vec3(0.0);
    for (int l = 0; l < 2; l++) {
        vec3 p = rd * (120.0 + float(l) * 160.0);
        vec3 id = floor(p);
        float h = h31(id + float(l) * 17.0);
        if (h > 0.992) {
            float d = length(fract(p) - 0.5);
            float b = smoothstep(0.35, 0.0, d) * (0.5 + 0.5 * sin(u_time * (2.0 + h * 6.0) + h * 50.0) * twinkle);
            col += mix(vec3(1.0, 0.85, 0.7), vec3(0.7, 0.85, 1.0), fract(h * 13.0)) * b;
        }
    }
    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float react = u_audio_react;
    float bass = u_audio.x * react;
    float kick = u_beat.x * react;
    float hat = u_beat.z * react;
    float t = u_time;
    float swayT = t * 0.15 + sin(u_beat.w * 1.5708) * 0.15 * react;
    vec3 ro = vec3(sin(swayT) * 2.0 * u_sway, cos(swayT * 0.7) * 1.2 * u_sway, t * u_speed * 3.0);
    vec3 rd = normalize(vec3(uv, 1.2));
    rd.xy *= rot2(sin(t * 0.05) * 0.3 * u_sway);
    rd.xz *= rot2(sin(swayT * 0.8) * 0.25 * u_sway);

    vec3 ca, cb, core;
    nebulaColors(ca, cb, core);
    float dens = u_density * (1.0 + bass * 0.6);
    float glow = u_glow * (1.0 + kick * 0.4 + bass * 0.3); // kick boost halved: less of a flash at the default
    vec3 col = vec3(0.0);
    float T = 1.0;
    float z = 0.2;
    for (int i = 0; i < 80; i++) {
        if (float(i) >= u_detail || T < 0.02) break;
        vec3 p = ro + rd * z;
        vec3 q = p * 0.35;
        q.xy += sin(q.zx * 0.7 + t * 0.05) * u_turbulence * 0.6;
        float n = fbm3(q);
        float d = smoothstep(0.5, 0.88, n) * dens;
        float stp = 0.32 + float(i) * 0.012;
        if (d > 0.001) {
            float hueMix = vn3(q * 0.4 + 11.0);
            vec3 em = mix(ca, cb, hueMix);
            em = mix(em, core, smoothstep(0.75, 0.95, n));
            float dustAmt = u_dust * smoothstep(0.3, 0.7, vn3(q * 1.7 + 4.0));
            col += T * em * d * glow * stp * (1.0 - dustAmt * 0.85) * 1.6;
            T *= exp(-d * stp * (0.6 + dustAmt * 2.4));
        }
        z += stp;
    }
    col += T * starfield(rd, 1.0 + hat * 2.0) * u_stars;
    col = 1.0 - exp(-col * 1.2);
    FRAG_OUT = vec4(pow(col, vec3(1.08)), 1.0);
}
`}),{}}export{a as default};
