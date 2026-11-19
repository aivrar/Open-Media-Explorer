function o(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"triplex_mutation_flight",label:"Triplex Mutation Flight",category:"Fractals",description:"Raymarched Mandelbulb-family mutations with burning ship, tricorn, generalized bulb, beam, and spud folds",fractalFlight:a.metadata({family:"Triplex Mutation",familyKey:"triplex_mutation",modeParam:"family",modes:["Mandelbulb Abs","Burning Ship 3D","Tricorn 3D","Generalized Bulb","DarkBeam Talis","Spudsville Fold"],depthParams:["flight_depth"],requiredParams:["family","power","iterations","march_steps","bailout","phase_twist","abs_mix","detail","flight_depth","target_mode","structure_pulse","formula_morph"],animationParams:["flight_speed","flight_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","phase_twist","abs_mix","structure_pulse","formula_morph","roll","roll_speed","fov","color_speed"],smokePresets:[{name:"Abs Crown Orbit",values:{family:0,power:7.5,iterations:18,march_steps:112,bailout:5.8,phase_twist:.52,abs_mix:.82,flight_speed:1.45,flight_depth:1.35,orbit_radius:1.36,orbit_spin:1.25,target_mode:0,motion_mode:0,motion_phase:.12,structure_pulse:.66,formula_morph:.62,roll:.24,roll_speed:1.15,color_speed:.68,palette:1,shade_mode:2,fog:.24,glow:1.65}},{name:"Burning Tunnel Push",values:{family:1,power:8.4,iterations:18,march_steps:120,bailout:5.5,phase_twist:.72,abs_mix:.96,flight_speed:2.35,flight_depth:1.82,orbit_radius:1.22,orbit_spin:1.72,target_mode:1,motion_mode:3,motion_phase:.28,structure_pulse:.88,formula_morph:.84,roll:.36,roll_speed:1.65,color_speed:.86,palette:2,shade_mode:3,fog:.2,glow:1.85}},{name:"DarkBeam Spiral",values:{family:4,power:6.6,iterations:20,march_steps:124,bailout:6.2,phase_twist:1.1,abs_mix:.54,flight_speed:2.15,flight_depth:1.58,orbit_radius:1.08,orbit_spin:1.86,target_mode:2,motion_mode:2,motion_phase:.42,structure_pulse:.92,formula_morph:1.12,roll:.42,roll_speed:1.72,color_speed:.88,palette:3,shade_mode:2,fog:.18,glow:1.95}},{name:"Spudsville Fold Dive",values:{family:5,power:5.8,iterations:19,march_steps:116,bailout:6,phase_twist:.86,abs_mix:.74,flight_speed:2.45,flight_depth:1.74,orbit_radius:1.18,orbit_spin:1.76,target_mode:3,motion_mode:3,motion_phase:.55,structure_pulse:.94,formula_morph:1.04,roll:.34,roll_speed:1.68,color_speed:.9,palette:0,shade_mode:3,fog:.2,glow:1.9}}]}),params:[{name:"family",label:"Triplex Mode",group:"Formula",type:"select",options:["Mandelbulb Abs","Burning Ship 3D","Tricorn 3D","Generalized Bulb","DarkBeam Talis","Spudsville Fold"],default:1},{name:"power",label:"Power",group:"Formula",min:2,max:12,default:8,step:.25},{name:"iterations",label:"Formula Iterations",group:"Formula",min:6,max:30,default:17,step:1,type:"int"},{name:"march_steps",label:"Ray Steps",group:"Formula",min:52,max:156,default:104,step:4,type:"int"},{name:"bailout",label:"Bailout",group:"Formula",min:2,max:12,default:5.5,step:.25},{name:"phase_twist",label:"Phase Twist",group:"Formula",min:-2,max:2,default:.38,step:.02},{name:"abs_mix",label:"Abs Mix",group:"Formula",min:0,max:1.5,default:.62,step:.02},{name:"detail",label:"Surface Detail",group:"Formula",min:.5,max:2.5,default:1.18,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:8,default:.72,step:.05},{name:"flight_depth",label:"Dive Depth",group:"Flight",min:0,max:4,default:.92,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5.5,default:1.28,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-5,max:5,default:.52,step:.05},{name:"target_mode",label:"Flight Target",group:"Flight",type:"select",options:["Fold Cathedral","Burning Crown","Mirror Needle","Root Tunnel"],default:1},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Orbit Dive","Figure Eight","Surface Graze","Spiral Descent"],default:0},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"structure_pulse",label:"Structure Pulse",group:"Animation",min:0,max:1.8,default:.42,step:.05},{name:"formula_morph",label:"Formula Morph",group:"Animation",min:0,max:1.8,default:.55,step:.05},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.8,max:1.8,default:.28,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:6,default:.64,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.9,default:1.02,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.48,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Molten Crown","Toxic Orchid","Ice Electric","Bone Fire"],default:1},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Trap Glow","Normal Fresnel","Iteration Bands","Mutation Cavity"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.36,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:2.8,default:1.15,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_family;
uniform float u_power;
uniform float u_iterations;
uniform float u_march_steps;
uniform float u_bailout;
uniform float u_phase_twist;
uniform float u_abs_mix;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_flight_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_target_mode;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_structure_pulse;
uniform float u_formula_morph;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

struct TriplexHit {
    float dist;
    float iter;
    float trap;
    float cavity;
};

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

float familyMode() {
    return clamp(floor(u_family + 0.5), 0.0, 5.0);
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

vec3 paletteTriplex(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.40, 0.22, 0.08), vec3(0.58, 0.32, 0.12), vec3(1.00, 0.62, 0.24), vec3(0.02, 0.18, 0.40));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.28, 0.10, 0.42), vec3(0.54, 0.22, 0.62), vec3(0.90, 0.36, 1.00), vec3(0.15, 0.46, 0.62));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.07, 0.26, 0.42), vec3(0.22, 0.58, 0.68), vec3(0.48, 0.92, 1.00), vec3(0.58, 0.26, 0.06));
    }
    return palette(t, vec3(0.36, 0.18, 0.10), vec3(0.58, 0.34, 0.18), vec3(1.00, 0.78, 0.52), vec3(0.60, 0.10, 0.26));
}

vec3 targetOffset(float targetMode, float mode, float t) {
    if (targetMode < 0.5) {
        return vec3(0.02 * sin(t * 0.24), 0.02 + 0.08 * mode / 5.0, 0.02);
    } else if (targetMode < 1.5) {
        return vec3(0.12 * sin(t * 0.31 + mode), 0.20, 0.06 * cos(t * 0.27));
    } else if (targetMode < 2.5) {
        return vec3(0.18 * sin(t * 0.43), -0.02 + 0.08 * cos(t * 0.22), 0.16 * sin(t * 0.19 + mode));
    }
    return vec3(-0.08 + 0.14 * sin(t * 0.23 + mode), -0.20, 0.12 * cos(t * 0.33));
}

vec3 mutateOrbit(vec3 z, vec3 p, float mode, float iterValue, float phase, float morph) {
    float absAmount = clamp(u_abs_mix, 0.0, 1.5);
    float twist = u_phase_twist + morph * 0.42 + iterValue * 0.025;
    vec3 q = z;

    if (mode < 0.5) {
        q = mix(q, abs(q), min(absAmount, 1.0));
        q.xy = rot2(twist * 0.24) * q.xy;
    } else if (mode < 1.5) {
        q = abs(q);
        q.yz = rot2(twist * 0.36 + phase * 0.08) * q.yz;
        q.xz = mix(q.xz, abs(q.xz), 0.35 + 0.35 * min(absAmount, 1.0));
    } else if (mode < 2.5) {
        q = vec3(q.x, -q.y, q.z);
        q.xy = rot2(-twist * 0.32 - phase * 0.05) * q.xy;
        q.z = mix(q.z, -q.z, 0.25 + 0.35 * min(absAmount, 1.0));
    } else if (mode < 3.5) {
        q += sin(q.yzx * (1.25 + absAmount * 0.35) + phase + iterValue) * (0.065 + 0.075 * u_formula_morph);
        q = rotY3(twist * 0.15) * rotZ3(twist * 0.18) * q;
    } else if (mode < 4.5) {
        q = abs(q);
        q.xy = rot2(twist * 0.44 + length(p) * 0.16) * q.xy;
        q.yz = rot2(twist * 0.22 + iterValue * 0.045) * q.yz;
        float beam = sin(q.z * 2.15 + phase + iterValue * 0.37) * (0.045 + 0.045 * u_formula_morph);
        q.x -= 0.16 * min(absAmount, 1.2) + beam;
        q.y -= 0.10 * min(absAmount, 1.2) - beam * 0.55;
        q.z = abs(q.z + beam) - (0.12 + 0.07 * min(absAmount, 1.2));
        q += normalize(p + vec3(0.17, -0.11, 0.09)) * (0.028 * u_formula_morph);
    } else {
        vec3 s = sign(q);
        q = mix(q, abs(q.yzx) * s, 0.28 + 0.38 * min(absAmount, 1.0));
        q.xy = rot2(twist * 0.30 + q.z * 0.10) * q.xy;
        q += sin(q.zxy * 1.9 + phase) * (0.04 + 0.05 * u_formula_morph);
    }

    return q;
}

vec3 cOffset(vec3 p, float mode, float phase) {
    vec3 c = p;
    if (mode < 0.5) {
        c = mix(c, abs(c), 0.20 * min(u_abs_mix, 1.0));
    } else if (mode < 1.5) {
        c = abs(c) * vec3(1.0, 0.92, 1.05);
    } else if (mode < 2.5) {
        c = vec3(c.x, -c.y, c.z);
    } else if (mode < 3.5) {
        c += vec3(sin(phase * 0.7), cos(phase * 0.5), sin(phase * 0.37)) * (0.035 * u_formula_morph);
    } else if (mode < 4.5) {
        c = p * (0.92 + 0.07 * sin(phase)) + vec3(0.05, -0.03, 0.04) * u_abs_mix;
    } else {
        c = mix(p, p.zxy, 0.18 + 0.12 * sin(phase * 0.5)) + vec3(-0.04, 0.03, 0.02) * u_abs_mix;
    }
    return c;
}

TriplexHit triplexDE(vec3 p) {
    vec3 z = p;
    float mode = familyMode();
    float phase = u_time * 0.17 + phaseOffset() + mode * 0.91 + seedPhase() * 0.12;
    float pulse = sin(phase * 1.17 + length(p) * 0.31) * u_structure_pulse;
    float morph = sin(phase * 0.73 + mode * 1.9) * u_formula_morph;
    float powerValue = max(u_power + morph * 0.55 + pulse * 0.18, 2.0);
    float bailoutValue = max(u_bailout + pulse * 0.28, 1.35);
    float trap = 1000.0;
    float cavity = 0.0;
    float iter = 0.0;
    float dr = 1.0;
    float r = max(length(z), 0.000001);

    for (int i = 0; i < 34; i++) {
        if (float(i) >= u_iterations) break;
        float fi = float(i);
        vec3 q = mutateOrbit(z, p, mode, fi, phase, morph);
        r = max(length(q), 0.000001);
        trap = min(trap, r);
        cavity += 1.0 / (1.0 + r * r * 7.0);
        if (r > bailoutValue) break;

        float theta = acos(clamp(q.z / r, -1.0, 1.0));
        float phi = atan(q.y, q.x);
        float twist = u_phase_twist * (0.32 + mode * 0.035) + morph * 0.18 + pulse * 0.05;
        if (mode >= 1.5 && mode < 2.5) {
            phi = -phi + twist;
            theta = 3.14159265359 - theta * (0.92 + 0.04 * min(u_abs_mix, 1.0));
        } else if (mode >= 3.5 && mode < 4.5) {
            theta += sin(phi * 2.0 + phase) * twist * 0.22;
            phi += cos(theta * 3.0 + phase) * twist * 0.18;
        } else if (mode >= 4.5) {
            theta += sin(phi * 3.0 + fi * 0.31 + phase) * twist * 0.16;
            phi += sin(theta * 2.0 + phase) * twist * 0.22;
        } else {
            phi += twist;
        }

        float zr = pow(r, powerValue);
        dr = max(pow(r, powerValue - 1.0) * powerValue * dr + 1.0, 1.0);
        theta *= powerValue;
        phi *= powerValue;
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + cOffset(p, mode, phase);
        iter = fi + 1.0;
    }

    r = max(length(z), 0.000001);
    float de = abs(0.5 * log(r) * r / max(dr, 0.000001));
    float modeScale = mix(0.92, 0.68, smoothstep(3.5, 5.0, mode));
    return TriplexHit(max(de * modeScale, 0.00001), iter, trap, cavity);
}

// Clear bubble around the camera: the path can pass through the fractal,
// and a ray starting inside it filled the screen with one flat colour.
const float CAM_CLEAR = 0.05;
vec3 g_cam = vec3(1e5);
float camClear(vec3 p) { return CAM_CLEAR - length(p - g_cam); }

float mapScene(vec3 p) {
    return max(triplexDE(p).dist, camClear(p));
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
    for (int i = 0; i < 34; i++) {
        if (t >= maxT) break;
        float h = max(mapScene(ro + rd * t), 0.001);
        result = min(result, 9.5 * h / t);
        t += clamp(h, 0.025, 0.24);
    }
    return clamp(result, 0.12, 1.0);
}

vec3 background(vec3 rd, float t) {
    float shaft = pow(max(0.0, 1.0 - abs(rd.x * 0.55 + rd.y * 0.24)), 8.0);
    vec3 base = mix(vec3(0.010, 0.010, 0.020), vec3(0.032, 0.040, 0.064), smoothstep(-0.58, 0.68, rd.y));
    return base + paletteTriplex(t * 0.025 + rd.z * 0.08, u_palette) * shaft * 0.055;
}

void main() {
    float mode = familyMode();
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.12;
    float targetMode = u_target_mode;
    float motionMode = u_motion_mode;
    float familyPhase = mode * 0.83 + targetMode * 0.36;
    float spinT = u_time * u_orbit_spin + phaseOffset() + familyPhase + seedPhase() * 0.09;
    float rollT = u_time * u_roll_speed + phaseOffset() + familyPhase;
    float dive = sin(t * 0.28 + familyPhase) * u_flight_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.18 + mode));

    vec3 target = targetOffset(targetMode, mode, t);
    target += vec3(
        sin(spinT * 0.19 + familyPhase),
        cos(t * 0.23 + 1.3),
        sin(spinT * 0.31 + mode * 0.6)
    ) * (0.070 * (u_structure_pulse + u_formula_morph) * 0.5);

    vec3 orbitPath = vec3(
        sin(spinT * 0.34 + familyPhase) * radius,
        0.34 + cos(t * 0.24 + familyPhase) * 0.36 + mode * 0.025,
        3.08 - dive + cos(spinT * 0.34 + familyPhase) * radius * 0.38
    );
    vec3 figurePath = vec3(
        sin(spinT * 0.40 + familyPhase) * radius * 0.94,
        0.28 + sin(t * 0.74 + familyPhase) * 0.34,
        2.86 - dive * 0.70 + sin(spinT * 0.40) * cos(spinT * 0.40) * radius * 0.74
    );
    vec3 grazePath = vec3(
        sin(spinT * 0.28 + familyPhase) * radius * 0.62,
        0.12 + cos(t * 0.46 + familyPhase) * 0.20,
        2.06 - dive * 0.58 + cos(spinT * 0.28 + familyPhase) * radius * 0.25
    );
    vec3 spiralPath = vec3(
        sin(spinT * 0.48 + familyPhase) * radius * (0.78 + 0.18 * sin(t * 0.13)),
        0.30 + cos(t * 0.37 + familyPhase) * 0.46,
        3.20 - dive * 1.16 + cos(spinT * 0.48 + familyPhase) * radius * 0.58
    );

    vec3 ro = orbitPath;
    if (motionMode >= 0.5 && motionMode < 1.5) ro = figurePath;
    else if (motionMode >= 1.5 && motionMode < 2.5) ro = grazePath;
    else if (motionMode >= 2.5) ro = spiralPath;
    ro.xz = rot2(mode * 0.50 + spinT * 0.12 + sin(spinT * 0.10) * 0.18) * ro.xz;
    // Keep the camera outside the bulb body. Inside it every ray hits at
    // once and the frame turns into flat colour (Abs / DarkBeam presets).
    float camR = length(ro);
    float minCam = mode < 0.5 ? 2.2 : 1.45;
    if (camR < minCam) ro *= minCam / max(camR, 0.001);

    float rollValue = u_roll * sin(rollT * (0.43 + motionMode * 0.05) + familyPhase) + u_global_rotation * 0.2;
    float fovBreath = u_fov;
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, fovBreath, rollValue);

    g_cam = ro;
    float total = 0.0;
    float hitT = -1.0;
    TriplexHit hitInfo = TriplexHit(0.0, 0.0, 0.0, 0.0);
    float glowAccum = 0.0;
    float epsBase = mix(0.0048, 0.00115, clamp(u_detail / 2.5, 0.0, 1.0));

    for (int i = 0; i < 164; i++) {
        if (float(i) >= u_march_steps) break;
        vec3 p = ro + rd * total;
        TriplexHit h = triplexDE(p);
        float dist = max(h.dist, camClear(p));
        glowAccum += exp(-dist * 40.0) * 0.013;
        if (dist < epsBase * max(1.0, total * 0.48)) {
            hitT = total;
            hitInfo = h;
            break;
        }
        total += max(dist, epsBase * 1.15) * 0.70;
        if (total > 10.2) break;
    }

    vec3 col = background(rd, t);
    if (hitT >= 0.0) {
        vec3 p = ro + rd * hitT;
        vec3 n = estimateNormal(p, epsBase * 2.0);
        vec3 lightDir = normalize(vec3(0.42, 0.78, 0.48));
        vec3 fillDir = normalize(vec3(-0.62, 0.26, -0.24));
        float diff = max(dot(n, lightDir), 0.0);
        float fill = max(dot(n, fillDir), 0.0) * 0.35;
        float rim = pow(max(0.0, 1.0 + dot(rd, n)), 2.12);
        float shadow = softShadow(p + n * epsBase * 3.0, lightDir, 0.04, 3.7);
        float iterTone = hitInfo.iter / max(u_iterations, 1.0);
        float trapTone = -log(max(hitInfo.trap, 0.0001)) * 0.15;
        float cavity = clamp(hitInfo.cavity / max(u_iterations, 1.0), 0.0, 1.0);
        float hue = trapTone + iterTone * 0.50 + cavity * 0.40 + t * u_color_speed * 0.045 + mode * 0.085;
        vec3 base = paletteTriplex(hue, u_palette);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            vec3 normalCol = n * 0.5 + 0.5;
            base = mix(base, normalCol, 0.36 + rim * 0.22);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            float bands = 0.5 + 0.5 * sin(iterTone * 44.0 + cavity * 6.0 + t * (0.60 + u_color_speed));
            base *= 0.68 + bands * 0.64;
        } else if (u_shade_mode >= 2.5) {
            base = mix(base, paletteTriplex(cavity + trapTone + t * u_color_speed * 0.055, u_palette), 0.56);
        }
        float ao = 0.40 + 0.60 * smoothstep(0.0, 1.0, iterTone + clamp(hitInfo.trap * 0.24, 0.0, 0.7));
        vec3 light = base * (0.22 + diff * shadow * 1.55 + fill) * ao;
        light += paletteTriplex(hue + 0.18, u_palette) * rim * (0.36 + u_glow * 0.48);
        light += vec3(0.95, 0.78, 0.55) * cavity * 0.22;
        col = light;
    }

    col += paletteTriplex(t * 0.036 + total * 0.034, u_palette) * glowAccum * u_glow;
    float fogAmount = 1.0 - exp(-total * (0.048 + u_fog * 0.080));
    // Hits right at the bubble (camera grazing or inside the surface) fade
    // into the fog instead of popping in as a flat full-screen colour.
    if (hitT >= 0.0) fogAmount = max(fogAmount, 1.0 - smoothstep(CAM_CLEAR, 0.16, hitT));
    col = mix(col, background(rd, t) + paletteTriplex(t * 0.02, u_palette) * 0.046, fogAmount);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
