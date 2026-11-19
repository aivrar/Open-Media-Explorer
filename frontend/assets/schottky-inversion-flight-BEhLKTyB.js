function i(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"schottky_inversion_flight",label:"Schottky Inversion Flight",category:"Fractals",description:"Raymarched Schottky sphere inversions with bubble caves, ring limits, and Apollonian-like shell motion",fractalFlight:a.metadata({family:"Schottky Inversion",familyKey:"schottky_inversion",modeParam:"family",modes:["Tetra Bubbles","Octa Bubbles","Cube Bubbles","Apollonian Shell","Ring Limit Set"],depthParams:["tunnel_depth"],requiredParams:["family","iterations","sphere_radius","sphere_gap","center_radius","inversion_factor","bailout","detail","tunnel_depth","sphere_pulse","limit_twist"],animationParams:["flight_speed","tunnel_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","sphere_pulse","limit_twist","roll","roll_speed","fov","color_speed"]}),params:[{name:"family",label:"Sphere Family",group:"Formula",type:"select",options:["Tetra Bubbles","Octa Bubbles","Cube Bubbles","Apollonian Shell","Ring Limit Set"],default:0},{name:"iterations",label:"Inversion Iterations",group:"Formula",min:3,max:18,default:9,step:1,type:"int"},{name:"sphere_radius",label:"Sphere Radius",group:"Formula",min:.25,max:1.4,default:.72,step:.02},{name:"sphere_gap",label:"Sphere Gap",group:"Formula",min:.05,max:1.6,default:.42,step:.02},{name:"center_radius",label:"Center Radius",group:"Formula",min:.25,max:2.2,default:1.08,step:.02},{name:"inversion_factor",label:"Inversion Factor",group:"Formula",min:.55,max:1.45,default:1,step:.01},{name:"bailout",label:"Bailout",group:"Formula",min:2,max:18,default:9,step:.25},{name:"detail",label:"Surface Detail",group:"Formula",min:.5,max:2.5,default:1.1,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:6,default:.62,step:.05},{name:"tunnel_depth",label:"Tunnel Depth",group:"Flight",min:0,max:3.2,default:.78,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5,default:1.2,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-4,max:4,default:.42,step:.05},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Bubble Orbit","Figure Eight","Limit Tunnel","Surface Graze"],default:0},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"sphere_pulse",label:"Sphere Pulse",group:"Animation",min:0,max:1.5,default:.36,step:.05},{name:"limit_twist",label:"Limit Twist",group:"Animation",min:-1.5,max:1.5,default:.45,step:.02},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.5,max:1.5,default:.22,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:5,default:.52,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.8,default:1,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.42,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Pearl Void","Gold Bubbles","Cyan Glass","Violet Shell"],default:2},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Trap Glow","Normal Glass","Inversion Bands","Bubble Cavity"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.32,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:2.5,default:1.4,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_family;
uniform float u_iterations;
uniform float u_sphere_radius;
uniform float u_sphere_gap;
uniform float u_center_radius;
uniform float u_inversion_factor;
uniform float u_bailout;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_tunnel_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_sphere_pulse;
uniform float u_limit_twist;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

struct SchottkyHit {
    float dist;
    float iter;
    float trap;
    float inversions;
};

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

mat3 rotX3(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

mat3 rotY3(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotZ3(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}

vec3 sphereCenter(int index, float familyMode, float spread, float t) {
    if (familyMode < 0.5) {
        vec3 p = vec3(1.0);
        if (index == 1) p = vec3(1.0, -1.0, -1.0);
        else if (index == 2) p = vec3(-1.0, 1.0, -1.0);
        else if (index == 3) p = vec3(-1.0, -1.0, 1.0);
        return normalize(p) * spread;
    } else if (familyMode < 1.5) {
        if (index == 0) return vec3(spread, 0.0, 0.0);
        if (index == 1) return vec3(-spread, 0.0, 0.0);
        if (index == 2) return vec3(0.0, spread, 0.0);
        if (index == 3) return vec3(0.0, -spread, 0.0);
        if (index == 4) return vec3(0.0, 0.0, spread);
        return vec3(0.0, 0.0, -spread);
    } else if (familyMode < 2.5) {
        float x = index == 0 || index == 1 || index == 2 || index == 3 ? 1.0 : -1.0;
        float y = index == 0 || index == 1 || index == 4 || index == 5 ? 1.0 : -1.0;
        float z = index == 0 || index == 2 || index == 4 || index == 6 ? 1.0 : -1.0;
        return normalize(vec3(x, y, z)) * spread;
    } else if (familyMode < 3.5) {
        if (index == 0) return vec3(spread, 0.0, 0.0);
        if (index == 1) return vec3(-spread, 0.0, 0.0);
        if (index == 2) return vec3(0.0, spread, 0.0);
        if (index == 3) return vec3(0.0, -spread, 0.0);
        if (index == 4) return normalize(vec3(1.0, 1.0, 1.0)) * spread * 0.92;
        if (index == 5) return normalize(vec3(-1.0, -1.0, 1.0)) * spread * 0.92;
        if (index == 6) return normalize(vec3(-1.0, 1.0, -1.0)) * spread * 0.92;
        return normalize(vec3(1.0, -1.0, -1.0)) * spread * 0.92;
    }
    float fi = float(index);
    float a = fi * 0.78539816339 + t * 0.08;
    float wobble = 0.22 * sin(t * 0.23 + fi * 1.7);
    return vec3(cos(a) * spread, wobble, sin(a) * spread);
}

int sphereCount(float familyMode) {
    if (familyMode < 0.5) return 4;
    if (familyMode < 1.5) return 6;
    return 8;
}

vec3 paletteSchottky(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.26, 0.25, 0.32), vec3(0.46, 0.44, 0.52), vec3(0.82, 0.84, 1.00), vec3(0.04, 0.16, 0.35));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.38, 0.25, 0.10), vec3(0.56, 0.43, 0.22), vec3(1.00, 0.74, 0.35), vec3(0.03, 0.20, 0.42));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.08, 0.30, 0.42), vec3(0.22, 0.56, 0.64), vec3(0.50, 0.92, 1.00), vec3(0.06, 0.30, 0.56));
    }
    return palette(t, vec3(0.32, 0.17, 0.44), vec3(0.50, 0.30, 0.58), vec3(0.84, 0.52, 1.00), vec3(0.48, 0.08, 0.22));
}

SchottkyHit schottkyDE(vec3 p) {
    vec3 z = p;
    float t = u_time + phaseOffset() + seedPhase() * 0.09;
    float familyMode = u_family;
    float pulse = sin(t * 0.35 + familyMode) * u_sphere_pulse;
    float radius = max(u_sphere_radius + pulse * 0.06, 0.04);
    float spread = radius * 1.45 + u_sphere_gap + 0.18 * familyMode;
    float centerRadius = max(u_center_radius + pulse * 0.04, 0.05);
    float dr = 1.0;
    float trap = 1000.0;
    float inversions = 0.0;
    float iter = 0.0;
    int count = sphereCount(familyMode);

    for (int i = 0; i < 20; i++) {
        if (float(i) >= u_iterations) break;
        float fi = float(i);
        float twist = u_limit_twist * (0.20 + 0.035 * fi) + pulse * 0.05;
        z = rotY3(twist + familyMode * 0.16) * rotZ3(twist * 0.7) * z;

        for (int j = 0; j < 8; j++) {
            if (j >= count) break;
            vec3 c = sphereCenter(j, familyMode, spread, t);
            vec3 q = z - c;
            float d2 = max(dot(q, q), 0.00001);
            float localR = radius * (1.0 + 0.08 * sin(t * 0.29 + float(j) * 1.31 + familyMode));
            if (familyMode >= 3.5) localR *= 0.82 + 0.10 * sin(float(j) + t * 0.17);
            float r2 = localR * localR * u_inversion_factor;
            trap = min(trap, abs(sqrt(d2) - localR));
            if (d2 < r2) {
                float k = r2 / d2;
                z = c + q * k;
                dr *= abs(k);
                dr = min(dr, 1000000.0);
                inversions += 1.0;
            }
        }

        iter = fi + 1.0;
        if (length(z) > u_bailout) break;
    }

    float centerShell = abs(length(z) - centerRadius);
    float ringPlane = abs(z.y) * 0.35 + abs(length(z.xz) - centerRadius) * 0.65;
    float shell = centerShell;
    if (familyMode >= 3.5) shell = min(centerShell, ringPlane);
    if (familyMode >= 2.5 && familyMode < 3.5) shell = min(centerShell, trap * 0.72);
    float dist = min(shell, trap * 0.85) / max(dr, 1.0);
    return SchottkyHit(max(dist, 0.00001), iter, trap, inversions);
}

// Clear bubble around the camera: the path can pass through the fractal,
// and a ray starting inside it filled the screen with one flat colour.
const float CAM_CLEAR = 0.05;
vec3 g_cam = vec3(1e5);
float camClear(vec3 p) { return CAM_CLEAR - length(p - g_cam); }

float mapScene(vec3 p) {
    return max(schottkyDE(p).dist, camClear(p));
}

// Tetrahedral normal from a single mapScene() call site inside a loop.
// Six separate calls inlined six copies of the whole distance estimator,
// which made shader compiles take tens of seconds on Windows (D3D).
vec3 estimateNormal(vec3 p, float eps) {
    vec3 n = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        vec3 e = i == 0 ? vec3(1.0, -1.0, -1.0) :
            (i == 1 ? vec3(-1.0, -1.0, 1.0) :
            (i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0)));
        n += e * mapScene(p + e * eps);
    }
    return normalize(n);
}

float softShadow(vec3 ro, vec3 rd, float minT, float maxT) {
    float result = 1.0;
    float t = minT;
    for (int i = 0; i < 30; i++) {
        if (t >= maxT) break;
        float h = max(mapScene(ro + rd * t), 0.001);
        result = min(result, 8.0 * h / t);
        t += clamp(h, 0.025, 0.24);
    }
    return clamp(result, 0.14, 1.0);
}

vec3 background(vec3 rd, float t) {
    float halo = pow(max(0.0, 1.0 - abs(rd.x * 0.56 + rd.y * 0.20)), 8.0);
    vec3 base = mix(vec3(0.010, 0.012, 0.022), vec3(0.030, 0.043, 0.064), smoothstep(-0.56, 0.66, rd.y));
    return base + paletteSchottky(t * 0.026 + rd.z * 0.08, u_palette) * halo * 0.052;
}

void main() {
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.12;
    float familyMode = u_family;
    float familyPhase = familyMode * 1.11;
    float motionMode = u_motion_mode;
    float spinT = u_time * u_orbit_spin + phaseOffset() + familyPhase + seedPhase() * 0.08;
    float rollT = u_time * u_roll_speed + phaseOffset() + familyPhase;
    float crawl = sin(t * 0.28 + familyPhase) * u_tunnel_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.17 + familyMode));
    vec3 target = vec3(
        0.12 * sin(spinT * 0.20 + familyPhase),
        0.10 * cos(t * 0.24 + familyPhase),
        0.10 * sin(spinT * 0.30 + familyMode)
    );
    target += vec3(
        sin(spinT * 0.19 + familyPhase),
        cos(t * 0.23 + 1.2),
        sin(spinT * 0.31 + familyMode)
    ) * (0.07 * u_sphere_pulse);

    vec3 orbitPath = vec3(
        sin(spinT * 0.34 + familyPhase) * radius,
        0.30 + cos(t * 0.24 + familyPhase) * 0.34,
        3.00 - crawl + cos(spinT * 0.34 + familyPhase) * radius * 0.34
    );
    vec3 figurePath = vec3(
        sin(spinT * 0.40 + familyPhase) * radius * 0.92,
        0.24 + sin(t * 0.72 + familyPhase) * 0.30,
        2.72 - crawl * 0.64 + sin(spinT * 0.40) * cos(spinT * 0.40) * radius * 0.70
    );
    vec3 tunnelPath = vec3(
        sin(spinT * 0.23 + familyPhase) * radius * 0.48,
        0.16 + cos(t * 0.32 + familyPhase) * 0.22,
        2.35 - crawl * 1.25 + cos(spinT * 0.23 + familyPhase) * radius * 0.20
    );
    vec3 grazePath = vec3(
        sin(spinT * 0.28 + familyPhase) * radius * 0.64,
        0.10 + cos(t * 0.43 + familyPhase) * 0.18,
        2.02 - crawl * 0.58 + cos(spinT * 0.28 + familyPhase) * radius * 0.24
    );

    vec3 ro = orbitPath;
    if (motionMode >= 0.5 && motionMode < 1.5) ro = figurePath;
    else if (motionMode >= 1.5 && motionMode < 2.5) ro = tunnelPath;
    else if (motionMode >= 2.5) ro = grazePath;
    ro.xz = rot2(familyMode * 0.52 + spinT * 0.12 + sin(spinT * 0.11) * 0.16) * ro.xz;

    float rollValue = u_roll * sin(rollT * (0.44 + motionMode * 0.05) + familyPhase) + u_global_rotation * 0.2;
    float fovBreath = u_fov * (1.0 + 0.07 * sin(t * 0.21 + familyMode) + 0.02 * u_sphere_pulse * sin(t * 0.53));
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, fovBreath, rollValue);

    g_cam = ro;
    float total = 0.0;
    float hitT = -1.0;
    SchottkyHit hitInfo = SchottkyHit(0.0, 0.0, 0.0, 0.0);
    float glowAccum = 0.0;
    float epsBase = mix(0.0048, 0.0013, clamp(u_detail / 2.5, 0.0, 1.0));

    for (int i = 0; i < 130; i++) {
        if (float(i) >= 70.0 + u_detail * 24.0) break;
        vec3 p = ro + rd * total;
        SchottkyHit h = schottkyDE(p);
        float dist = max(h.dist, camClear(p));
        glowAccum += exp(-dist * 38.0) * 0.014;
        if (dist < epsBase * max(1.0, total * 0.48)) {
            hitT = total;
            hitInfo = h;
            break;
        }
        total += max(dist, epsBase * 1.25) * 0.58;
        if (total > 10.0) break;
    }

    vec3 col = background(rd, t);
    if (hitT >= 0.0) {
        vec3 p = ro + rd * hitT;
        vec3 n = estimateNormal(p, epsBase * 2.2);
        vec3 lightDir = normalize(vec3(0.42, 0.78, 0.48));
        vec3 fillDir = normalize(vec3(-0.62, 0.26, -0.22));
        float diff = max(dot(n, lightDir), 0.0);
        float fill = max(dot(n, fillDir), 0.0) * 0.36;
        float rim = pow(max(0.0, 1.0 + dot(rd, n)), 2.1);
        float shadow = softShadow(p + n * epsBase * 3.0, lightDir, 0.04, 3.6);
        float iterTone = hitInfo.iter / max(u_iterations, 1.0);
        float trapTone = -log(max(hitInfo.trap, 0.0001)) * 0.12;
        float invTone = hitInfo.inversions * 0.035;
        float hue = trapTone + invTone + iterTone * 0.42 + t * u_color_speed * 0.045 + familyMode * 0.10;
        vec3 base = paletteSchottky(hue, u_palette);
        float cavity = clamp(hitInfo.inversions / max(u_iterations * 3.0, 1.0), 0.0, 1.0);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            vec3 normalCol = n * 0.5 + 0.5;
            base = mix(base, normalCol, 0.34 + rim * 0.24);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            float bands = 0.5 + 0.5 * sin(iterTone * 38.0 + hitInfo.inversions * 0.7 + t * (0.58 + u_color_speed));
            base *= 0.68 + bands * 0.64;
        } else if (u_shade_mode >= 2.5) {
            base = mix(base, paletteSchottky(cavity + trapTone + t * u_color_speed * 0.055, u_palette), 0.56);
        }
        float ao = 0.44 + 0.56 * smoothstep(0.0, 1.0, iterTone + cavity * 0.6);
        vec3 light = base * (0.22 + diff * shadow * 1.48 + fill) * ao;
        light += paletteSchottky(hue + 0.18, u_palette) * rim * (0.34 + u_glow * 0.50);
        light += vec3(0.80, 0.94, 1.0) * cavity * 0.22;
        col = light;
    }

    col += paletteSchottky(t * 0.035 + total * 0.032, u_palette) * glowAccum * u_glow;
    float fogAmount = 1.0 - exp(-total * (0.048 + u_fog * 0.078));
    // Hits right at the bubble (camera grazing or inside the surface) fade
    // into the fog instead of popping in as a flat full-screen colour.
    if (hitT >= 0.0) fogAmount = max(fogAmount, 1.0 - smoothstep(CAM_CLEAR, 0.16, hitT));
    col = mix(col, background(rd, t) + paletteSchottky(t * 0.02, u_palette) * 0.044, fogAmount);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{i as default};
