function a(e){return e.EffectRegistry.register({name:"spiral_galaxy",label:"Spiral Galaxy",category:"Cosmic",description:"A slowly turning spiral galaxy with dust lanes, star clusters and a glowing core",params:[{name:"arms",label:"Arms",type:"int",min:2,max:6,default:2,step:1},{name:"twist",label:"Arm Winding",min:.4,max:3,default:1.3,step:.01},{name:"speed",label:"Rotation Speed",min:-1,max:1,default:.12,step:.01},{name:"tilt",label:"Viewing Tilt",min:0,max:1.35,default:.85,step:.01},{name:"size",label:"Size",min:.3,max:2,default:1,step:.01},{name:"dust",label:"Dust Lanes",min:0,max:1,default:.6,step:.01},{name:"clusters",label:"Star Clusters",min:0,max:2,default:1,step:.01},{name:"core",label:"Core Glow",min:0,max:2,default:1,step:.01},{name:"stars",label:"Background Stars",min:0,max:2,default:1,step:.01},{name:"scheme",label:"Colours",type:"select",palette:!0,options:["Milky Way","Andromeda","Neon","Ember"],default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_arms;
uniform float u_twist;
uniform float u_speed;
uniform float u_tilt;
uniform float u_size;
uniform float u_dust;
uniform float u_clusters;
uniform float u_core;
uniform float u_stars;
uniform float u_scheme;
uniform float u_audio_react;
uniform vec4 u_audio;
uniform vec4 u_beat;

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm4(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return v;
}

// Arm colour (young blue stars) and core colour (old yellow stars)
void galaxyColors(out vec3 arm, out vec3 core, out vec3 knot) {
    float s = floor(u_scheme + 0.5);
    if (s >= 3.5) { arm = psyLut(0.25); core = psyLut(0.8); knot = psyLut(0.55); }
    else if (s < 0.5) { arm = vec3(0.55, 0.7, 1.0); core = vec3(1.0, 0.82, 0.55); knot = vec3(1.0, 0.45, 0.6); }
    else if (s < 1.5) { arm = vec3(0.7, 0.75, 1.0); core = vec3(1.0, 0.9, 0.75); knot = vec3(0.6, 0.8, 1.0); }
    else if (s < 2.5) { arm = vec3(0.2, 0.9, 1.0); core = vec3(1.0, 0.3, 0.9); knot = vec3(0.6, 1.0, 0.3); }
    else { arm = vec3(1.0, 0.5, 0.2); core = vec3(1.0, 0.9, 0.5); knot = vec3(1.0, 0.2, 0.1); }
}

vec3 backgroundStars(vec2 uv, float twinkle) {
    vec3 col = vec3(0.0);
    for (int l = 0; l < 2; l++) {
        vec2 g = uv * (90.0 + float(l) * 110.0);
        vec2 id = floor(g);
        float h = hash2(id + float(l) * 31.0);
        if (h > 0.985) {
            float d = length(fract(g) - 0.5);
            float b = smoothstep(0.3, 0.0, d) * (0.6 + 0.4 * sin(u_time * (1.5 + h * 5.0) + h * 40.0) * twinkle);
            col += mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), fract(h * 17.0)) * b;
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

    // Disk coordinates: undo the viewing tilt, then a gentle overall slant.
    vec2 p = uv * rot2(0.45);
    p.y /= max(cos(u_tilt), 0.2);
    p /= 0.42 * u_size;
    float r = length(p);
    float a = atan(p.y, p.x);

    // Differential rotation: the inner disk turns faster than the rim.
    float spin = u_time * u_speed * 2.2 / (0.35 + r) + seedPhase();
    float arms = floor(u_arms + 0.5);
    float lr = log(max(r, 0.02));
    float phase = arms * (a - spin - u_twist * lr * 2.0);
    float armWave = 0.5 + 0.5 * cos(phase);
    float arm = pow(armWave, 3.0);

    // Clumpy structure in co-rotating coordinates.
    vec2 q = vec2(a - spin, lr * 2.5);
    vec2 cq = vec2(cos(q.x), sin(q.x)) * (1.0 + q.y * 0.3);
    float clump = fbm4(cq * 3.0 + q.y * 2.0);
    float diskFade = exp(-r * 1.6) * smoothstep(0.0, 0.08, r);
    float disk = diskFade * (0.25 + 0.75 * arm) * (0.55 + 0.9 * clump);

    // Dust lanes run just inside each arm (trailing edge).
    float lane = pow(0.5 + 0.5 * cos(phase - 0.75), 10.0) * smoothstep(0.08, 0.3, r) * exp(-r * 0.9);
    float dust = 1.0 - u_dust * lane * (0.6 + 0.6 * fbm4(cq * 6.0 + 3.0));

    // Star-forming knots strung along the arms.
    vec2 kg = vec2(q.x * 9.0, q.y * 6.0);
    vec2 kid = floor(kg);
    float kh = hash2(kid + 5.0);
    float knot = 0.0;
    if (kh > 0.78) {
        vec2 kp = fract(kg) - 0.5 - (hash2(kid + 9.0) - 0.5) * 0.4;
        knot = smoothstep(0.22, 0.0, length(kp)) * arm * diskFade * 3.0;
    }

    vec3 armCol, coreCol, knotCol;
    galaxyColors(armCol, coreCol, knotCol);
    vec3 col = vec3(0.0);
    col += armCol * disk * 1.6 * dust * (1.0 + kick * 0.45 + bass * 0.2);
    col += knotCol * knot * u_clusters * (0.7 + kick * 1.5) * dust;
    float bulge = exp(-r * r * 9.0) * 1.6 + exp(-r * 3.2) * 0.35;
    col += coreCol * bulge * u_core * (1.0 + bass * 1.2 + kick * 0.3);
    col += armCol * exp(-r * 0.8) * 0.04;          // faint halo
    // Resolved stars within the disk
    vec2 sg = p * 70.0;
    float sh = hash2(floor(sg));
    if (sh > 0.97) col += vec3(1.0, 0.95, 0.9) * smoothstep(0.35, 0.0, length(fract(sg) - 0.5)) * diskFade * 2.0 * (0.6 + arm);

    col += backgroundStars(uv, 1.0 + hat * 2.0) * u_stars * (1.0 - clamp(disk * 3.0 + bulge, 0.0, 1.0));
    col = 1.0 - exp(-col * 1.3);
    FRAG_OUT = vec4(pow(col, vec3(0.95)), 1.0);
}
`}),{}}export{a as default};
