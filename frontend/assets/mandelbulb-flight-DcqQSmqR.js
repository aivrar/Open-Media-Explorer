function o(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"mandelbulb_flight",label:"Mandelbulb Flight",category:"Fractals",description:"Raymarched 3D Mandelbulb with fold-dive camera motion and animated polar unfolding",fractalFlight:a.metadata({family:"Mandelbulb",familyKey:"mandelbulb",modeParam:"fold_target",modes:["Cathedral","Crown","Spiral Gate","Root Cavern"],depthParams:["flight_depth"],requiredParams:["power","max_iter","march_steps","bailout","detail","flight_depth","fold_target","polar_anim","structure_pulse"],animationParams:["flight_speed","flight_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","polar_anim","structure_pulse","roll","roll_speed","fov","color_speed"]}),params:[{name:"power",label:"Power",group:"Formula",min:2,max:12,default:8,step:.25},{name:"max_iter",label:"Formula Iterations",group:"Formula",min:6,max:28,default:16,step:1,type:"int"},{name:"march_steps",label:"Ray Steps",group:"Formula",min:48,max:140,default:92,step:4,type:"int"},{name:"bailout",label:"Bailout",group:"Formula",min:2,max:8,default:4,step:.25},{name:"detail",label:"Surface Detail",group:"Formula",min:.5,max:2.5,default:1.15,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:6,default:.55,step:.05},{name:"flight_depth",label:"Dive Depth",group:"Flight",min:0,max:3,default:.75,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5,default:1.35,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-4,max:4,default:.35,step:.05},{name:"fold_target",label:"Flight Target",group:"Flight",type:"select",options:["Cathedral","Crown","Spiral Gate","Root Cavern"],default:1},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Orbit Dive","Figure Eight","Surface Graze","Spiral Descent"],default:0},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"polar_anim",label:"Unfold Motion",group:"Animation",min:0,max:1.5,default:.35,step:.05},{name:"structure_pulse",label:"Structure Pulse",group:"Animation",min:0,max:1.5,default:.28,step:.05},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.5,max:1.5,default:.25,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:5,default:.45,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.8,default:1.05,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.35,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Deep Gold","Ion Orchid","Crystal Cyan","Lava Organics"],default:0},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Trap Glow","Normal Fresnel","Iteration Bands","Cavity Pulse"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.45,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:2.5,default:.85,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_power;
uniform float u_max_iter;
uniform float u_march_steps;
uniform float u_bailout;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_flight_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_fold_target;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_polar_anim;
uniform float u_structure_pulse;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

struct BulbHit {
    float dist;
    float iter;
    float trap;
};

float targetBias() {
    return u_fold_target / 3.0;
}

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

vec3 targetOffset(float targetMode, float t) {
    if (targetMode < 0.5) {
        return vec3(0.0, -0.08, 0.02);
    } else if (targetMode < 1.5) {
        return vec3(0.12 * sin(t * 0.31), 0.18, 0.05 * cos(t * 0.27));
    } else if (targetMode < 2.5) {
        return vec3(0.22 * sin(t * 0.43), 0.12 * cos(t * 0.37), 0.16 * sin(t * 0.19));
    }
    return vec3(-0.10 + 0.12 * sin(t * 0.22), -0.22, 0.10 * cos(t * 0.33));
}

vec3 paletteFlight(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.42, 0.30, 0.12), vec3(0.54, 0.42, 0.25), vec3(0.90, 0.65, 0.35), vec3(0.02, 0.20, 0.42));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.34, 0.16, 0.48), vec3(0.48, 0.25, 0.58), vec3(0.80, 0.50, 1.00), vec3(0.50, 0.08, 0.20));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.12, 0.34, 0.46), vec3(0.26, 0.54, 0.62), vec3(0.65, 0.90, 1.00), vec3(0.06, 0.30, 0.54));
    }
    return palette(t, vec3(0.40, 0.18, 0.08), vec3(0.55, 0.24, 0.11), vec3(1.00, 0.52, 0.20), vec3(0.00, 0.12, 0.26));
}

BulbHit mandelbulbDE(vec3 p) {
    vec3 z = p;
    float dr = 1.0;
    float r = length(z);
    float iter = 0.0;
    float trap = 1000.0;
    float morphPhase = u_time * (0.18 + 0.12 * targetBias()) + phaseOffset() + seedPhase();
    float morph = sin(morphPhase * 1.35 + targetBias() * 2.0) * u_structure_pulse;
    float powerValue = max(u_power + morph * 0.55, 2.0);
    float bailoutValue = max(u_bailout + morph * 0.25, 1.1);
    float polarOffset = sin(morphPhase) * u_polar_anim * (0.20 + u_structure_pulse * 0.06);

    for (int i = 0; i < 32; i++) {
        if (float(i) >= u_max_iter) break;
        r = max(length(z), 0.000001);
        trap = min(trap, r);
        if (r > bailoutValue) break;

        float theta = acos(clamp(z.z / r, -1.0, 1.0));
        float phi = atan(z.y, z.x) + polarOffset;
        float zr = pow(r, powerValue);
        dr = pow(r, powerValue - 1.0) * powerValue * dr + 1.0;

        theta = theta * powerValue;
        phi = phi * powerValue;
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + p;
        iter = float(i) + 1.0;
    }

    r = max(length(z), 0.000001);
    float de = 0.5 * log(r) * r / max(dr, 0.000001);
    return BulbHit(max(de, 0.00001), iter, trap);
}

float mapScene(vec3 p) {
    return mandelbulbDE(p).dist;
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
    for (int i = 0; i < 36; i++) {
        if (t >= maxT) break;
        float h = mapScene(ro + rd * t);
        result = min(result, 12.0 * h / t);
        t += clamp(h, 0.025, 0.22);
    }
    return clamp(result, 0.15, 1.0);
}

vec3 background(vec3 rd, float t) {
    float horizon = smoothstep(-0.55, 0.65, rd.y);
    float rays = pow(max(0.0, 1.0 - abs(rd.x * 0.7 + rd.y * 0.25)), 8.0);
    vec3 base = mix(vec3(0.015, 0.012, 0.025), vec3(0.035, 0.045, 0.070), horizon);
    vec3 accent = paletteFlight(t * 0.03 + rd.z * 0.1, u_palette) * rays * 0.06;
    return base + accent;
}

void main() {
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.17;
    float targetMode = u_fold_target;
    float motionMode = u_motion_mode;
    float spinT = u_time * u_orbit_spin + phaseOffset() + targetMode * 0.71 + seedPhase() * 0.11;
    float rollT = u_time * u_roll_speed + phaseOffset() + targetMode;
    float dive = sin(t * 0.29) * u_flight_depth;
    float sidePhase = spinT * (0.34 + targetBias() * 0.09);
    float heightPhase = t * (0.21 + targetBias() * 0.05);
    float radius = u_orbit_radius * (1.0 + 0.12 * sin(spinT * 0.17 + targetMode));
    vec3 target = targetOffset(targetMode, t);
    target += vec3(
        sin(spinT * 0.17 + 1.7),
        cos(t * 0.23 + targetMode),
        sin(spinT * 0.31 + 0.4)
    ) * (0.075 * u_structure_pulse);

    vec3 orbitPath = vec3(
        sin(sidePhase) * radius,
        0.42 + cos(heightPhase) * 0.42 + targetBias() * 0.20,
        3.05 - dive + cos(sidePhase) * radius * 0.42
    );
    vec3 figurePath = vec3(
        sin(spinT * 0.36) * radius * 0.95,
        0.34 + sin(t * 0.72 + targetMode) * 0.34 + targetBias() * 0.18,
        2.88 - dive * 0.72 + sin(spinT * 0.36) * cos(spinT * 0.36) * radius * 0.72
    );
    vec3 grazePath = vec3(
        sin(spinT * 0.27 + targetMode) * radius * 0.62,
        0.18 + cos(t * 0.41) * 0.24 + targetBias() * 0.16,
        2.18 - dive * 0.58 + cos(spinT * 0.22) * radius * 0.26
    );
    vec3 spiralPath = vec3(
        sin(spinT * 0.48 + targetMode) * radius * (0.80 + 0.18 * sin(t * 0.13)),
        0.35 + cos(t * 0.37) * 0.48 + targetBias() * 0.20,
        3.20 - dive * 1.15 + cos(spinT * 0.48 + targetMode) * radius * 0.58
    );

    vec3 ro = orbitPath;
    if (motionMode >= 0.5 && motionMode < 1.5) ro = figurePath;
    else if (motionMode >= 1.5 && motionMode < 2.5) ro = grazePath;
    else if (motionMode >= 2.5) ro = spiralPath;
    ro.xz = rot2(targetMode * 0.85 + spinT * 0.18 + sin(spinT * 0.11) * 0.22) * ro.xz;

    float rollValue = u_roll * sin(rollT * (0.45 + motionMode * 0.05) + targetMode) + u_global_rotation * 0.2;
    float fovBreath = u_fov;
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, fovBreath, rollValue);

    float total = 0.0;
    float hitT = -1.0;
    BulbHit hitInfo = BulbHit(0.0, 0.0, 0.0);
    float glowAccum = 0.0;
    float epsBase = mix(0.0045, 0.0012, clamp(u_detail / 2.5, 0.0, 1.0));

    for (int i = 0; i < 150; i++) {
        if (float(i) >= u_march_steps) break;
        vec3 p = ro + rd * total;
        BulbHit h = mandelbulbDE(p);
        float dist = h.dist;
        glowAccum += exp(-dist * 42.0) * 0.012;
        if (dist < epsBase * max(1.0, total * 0.45)) {
            hitT = total;
            hitInfo = h;
            break;
        }
        total += dist * 0.72;
        if (total > 9.0) break;
    }

    vec3 col = background(rd, t);
    if (hitT >= 0.0) {
        vec3 p = ro + rd * hitT;
        vec3 n = estimateNormal(p, epsBase * 1.8);
        vec3 lightDir = normalize(vec3(0.45, 0.75, 0.55));
        vec3 fillDir = normalize(vec3(-0.55, 0.20, -0.30));
        float diff = max(dot(n, lightDir), 0.0);
        float fill = max(dot(n, fillDir), 0.0) * 0.35;
        float rim = pow(max(0.0, 1.0 + dot(rd, n)), 2.2);
        float shadow = softShadow(p + n * epsBase * 3.0, lightDir, 0.04, 3.8);
        float iterTone = hitInfo.iter / max(u_max_iter, 1.0);
        float trapTone = -log(max(hitInfo.trap, 0.0001)) * 0.18;
        float hue = trapTone + iterTone * 0.55 + t * u_color_speed * 0.045 + targetBias() * 0.13;
        vec3 base = paletteFlight(hue, u_palette);
        float cavity = clamp(1.0 - hitInfo.trap * 1.45, 0.0, 1.0);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            vec3 normalCol = n * 0.5 + 0.5;
            base = mix(base, normalCol, 0.42 + 0.18 * rim);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            float bands = 0.5 + 0.5 * sin(iterTone * 42.0 + t * (0.65 + u_color_speed));
            base *= 0.72 + bands * 0.58;
        } else if (u_shade_mode >= 2.5) {
            base = mix(base, paletteFlight(cavity + t * u_color_speed * 0.06, u_palette), 0.55);
        }
        vec3 light = base * (0.20 + diff * shadow * 1.45 + fill);
        light += paletteFlight(hue + 0.18, u_palette) * rim * (0.35 + u_glow * 0.45);
        light += vec3(1.0, 0.82, 0.50) * cavity * 0.25;
        col = light;
    }

    col += paletteFlight(t * 0.04 + total * 0.03, u_palette) * glowAccum * u_glow;
    float fogAmount = 1.0 - exp(-total * (0.045 + u_fog * 0.075));
    col = mix(col, background(rd, t) + paletteFlight(t * 0.02, u_palette) * 0.05, fogAmount);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
