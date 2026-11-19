function o(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"lsystem_tube_flight",label:"L-System Tube Flight",category:"Fractals",description:"Procedural turtle-branch tube fields inspired by 3D L-systems, with fly-through growth and branch sway animation",fractalFlight:a.metadata({family:"3D L-System Tubes",familyKey:"lsystem_tube",modeParam:"system_mode",modes:["Branch Grove","Crystal Fern","Coral Fork","Root Cathedral"],depthParams:["flight_depth"],requiredParams:["system_mode","iterations","branch_angle","branch_scale","tube_radius","fork_density","curl","detail","quality","flight_depth","growth_phase","branch_sway"],animationParams:["flight_speed","flight_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","growth_phase","branch_sway","curl","roll","roll_speed","fov","color_speed"],smokePresets:[{name:"Branch Grove Dive",values:{system_mode:0,iterations:9,branch_angle:.82,branch_scale:.76,tube_radius:.07,fork_density:.88,curl:.62,detail:1.18,flight_speed:2.06,flight_depth:1.48,orbit_radius:1.18,orbit_spin:1.42,motion_mode:2,motion_phase:.18,growth_phase:.74,branch_sway:.72,roll:.26,roll_speed:1.34,fov:.98,color_speed:.76,palette:0,shade_mode:1,fog:.28,glow:1.78}},{name:"Crystal Fern Cathedral",values:{system_mode:1,iterations:10,branch_angle:.68,branch_scale:.82,tube_radius:.055,fork_density:1.04,curl:.9,detail:1.32,flight_speed:2.24,flight_depth:1.64,orbit_radius:1.08,orbit_spin:1.62,motion_mode:2,motion_phase:.32,growth_phase:.92,branch_sway:.88,roll:.34,roll_speed:1.48,fov:.92,color_speed:.88,palette:1,shade_mode:2,fog:.22,glow:1.96}},{name:"Coral Fork Drift",values:{system_mode:2,iterations:11,branch_angle:1.08,branch_scale:.72,tube_radius:.078,fork_density:1.18,curl:1.06,detail:1.38,flight_speed:2.42,flight_depth:1.76,orbit_radius:1.22,orbit_spin:1.78,motion_mode:0,motion_phase:.44,growth_phase:1.1,branch_sway:1.02,roll:.4,roll_speed:1.62,fov:.96,color_speed:.96,palette:2,shade_mode:3,fog:.2,glow:2.08}},{name:"Root Cathedral Descent",values:{system_mode:3,iterations:12,branch_angle:.92,branch_scale:.78,tube_radius:.086,fork_density:.96,curl:-.88,detail:1.42,flight_speed:2.28,flight_depth:1.7,orbit_radius:1.12,orbit_spin:1.56,motion_mode:3,motion_phase:.58,growth_phase:1.2,branch_sway:.86,roll:-.38,roll_speed:1.56,fov:.94,color_speed:.88,palette:3,shade_mode:1,fog:.24,glow:2.02}}]}),params:[{name:"system_mode",label:"System Mode",group:"Formula",type:"select",options:["Branch Grove","Crystal Fern","Coral Fork","Root Cathedral"],default:0},{name:"iterations",label:"Branch Iterations",group:"Formula",min:4,max:12,default:9,step:1,type:"int"},{name:"branch_angle",label:"Branch Angle",group:"Formula",min:.15,max:1.45,default:.78,step:.02},{name:"branch_scale",label:"Branch Scale",group:"Formula",min:.45,max:.94,default:.76,step:.01},{name:"tube_radius",label:"Tube Radius",group:"Formula",min:.025,max:.16,default:.066,step:.005},{name:"fork_density",label:"Fork Density",group:"Formula",min:.2,max:1.8,default:.92,step:.02},{name:"curl",label:"Branch Curl",group:"Formula",min:-1.8,max:1.8,default:.62,step:.02},{name:"detail",label:"Branch Detail",group:"Formula",min:.5,max:2.5,default:1.15,step:.05},{name:"quality",label:"Preview Quality",group:"Formula",min:.35,max:1.5,default:.75,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:8,default:.72,step:.05},{name:"flight_depth",label:"Dive Depth",group:"Flight",min:0,max:4.6,default:.95,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5.8,default:1.18,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-5,max:5,default:.58,step:.05},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Canopy Orbit","Figure Eight","Branch Tunnel","Root Graze"],default:2},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"growth_phase",label:"Growth Phase",group:"Animation",min:0,max:1.8,default:.7,step:.05},{name:"branch_sway",label:"Branch Sway",group:"Animation",min:0,max:1.8,default:.7,step:.05},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.8,max:1.8,default:.24,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:6,default:.68,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.9,default:.98,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.52,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Viridian Bark","Ice Fern","Coral Glow","Root Ember"],default:0},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Tube Normals","Growth Rings","Crystal Tips","Filament Glow"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.32,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:3,default:1.4,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_system_mode;
uniform float u_iterations;
uniform float u_branch_angle;
uniform float u_branch_scale;
uniform float u_tube_radius;
uniform float u_fork_density;
uniform float u_curl;
uniform float u_detail;
uniform float u_quality;
uniform float u_flight_speed;
uniform float u_flight_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_growth_phase;
uniform float u_branch_sway;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

struct TubeHit {
    float dist;
    float age;
    float branch;
    float core;
};

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

float systemMode() {
    return clamp(floor(u_system_mode + 0.5), 0.0, 3.0);
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

vec3 paletteTube(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.05, 0.22, 0.16), vec3(0.26, 0.58, 0.40), vec3(0.48, 0.88, 0.62), vec3(0.04, 0.24, 0.44));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.10, 0.18, 0.30), vec3(0.34, 0.58, 0.74), vec3(0.70, 0.96, 1.00), vec3(0.08, 0.25, 0.52));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.34, 0.12, 0.10), vec3(0.68, 0.28, 0.22), vec3(1.00, 0.54, 0.38), vec3(0.00, 0.20, 0.42));
    }
    return palette(t, vec3(0.28, 0.11, 0.06), vec3(0.56, 0.28, 0.14), vec3(0.95, 0.62, 0.30), vec3(0.04, 0.14, 0.35));
}

float sdSegment(vec3 p, vec3 a, vec3 b) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
    return length(pa - ba * h);
}

vec3 branchDirection(float mode, float i, float side, float phase) {
    float fork = u_branch_angle * (0.82 + 0.12 * sin(i + phase));
    if (mode < 0.5) {
        return normalize(rotZ3(side * fork + u_curl * 0.22) * rotY3(0.24 * sin(i * 1.31 + phase)) * vec3(0.0, 1.0, 0.18 + 0.04 * i));
    } else if (mode < 1.5) {
        return normalize(rotY3(side * fork * 0.72 + u_curl * 0.18) * rotX3(0.32 + 0.08 * sin(i + phase)) * vec3(0.12 * side, 1.0, 0.26));
    } else if (mode < 2.5) {
        return normalize(rotZ3(side * fork * 1.12 + sin(i * 2.1) * 0.22) * rotX3(u_curl * 0.28 + 0.22) * vec3(0.16 * side, 0.82, 0.36));
    }
    return normalize(rotY3(side * fork * 0.95 + u_curl * 0.32) * rotZ3(0.38 * sin(i + phase)) * vec3(0.12 * side, -0.86, 0.44));
}

TubeHit mapTubes(vec3 p) {
    float mode = systemMode();
    float phase = u_time * (0.16 + u_growth_phase * 0.08) + phaseOffset() + seedPhase() * 0.09;
    vec3 q = p;
    q.xz = rot2(u_curl * 0.08 * q.y + phase * 0.04) * q.xz;
    if (mode >= 2.5) q.y = -q.y + 0.32;

    TubeHit best = TubeHit(1000.0, 0.0, 0.0, 0.0);
    float activeIterations = min(u_iterations, floor(3.0 + u_quality * 9.0));
    float len = 0.92;
    float scale = clamp(u_branch_scale, 0.45, 0.94);
    vec3 a = vec3(0.0, -0.82, 0.0);
    vec3 trunkDir = normalize(vec3(0.0, 1.0, 0.14 * sin(phase)));
    for (int i = 0; i < 18; i++) {
        if (float(i) >= activeIterations) break;
        float fi = float(i);
        vec3 b = a + trunkDir * len;
        float growth = smoothstep(fi / max(activeIterations, 1.0), (fi + 1.4) / max(activeIterations, 1.0), fract(phase * 0.10 + u_growth_phase * 0.17));
        float radius = u_tube_radius * pow(scale, fi * 0.52) * (1.0 + 0.16 * sin(phase + fi));
        float trunkD = sdSegment(q, a, mix(a, b, max(growth, 0.35))) - radius;
        if (trunkD < best.dist) best = TubeHit(trunkD, fi / max(activeIterations, 1.0), 0.0, radius);

        float forks = 1.0 + floor(clamp(u_fork_density * u_quality * 1.5, 0.0, 3.0));
        for (int j = 0; j < 5; j++) {
            if (float(j) >= forks) break;
            float side = float(j) - (forks - 1.0) * 0.5;
            float sideSign = sign(side + 0.01);
            float spawn = 0.24 + 0.14 * fract(sin(fi * 12.31 + float(j) * 4.17 + mode) * 43758.5453);
            vec3 root = mix(a, b, spawn);
            vec3 dir = branchDirection(mode, fi + float(j) * 0.37, sideSign, phase);
            float sway = sin(phase * 1.2 + fi * 1.7 + float(j) * 2.3) * u_branch_sway * 0.10;
            dir.xz = rot2(sway + side * 0.10) * dir.xz;
            float branchLen = len * (0.46 + 0.22 * u_fork_density) * pow(scale, float(j) * 0.18);
            vec3 tip = root + dir * branchLen;
            float branchGrowth = smoothstep(fi / max(activeIterations, 1.0), (fi + 2.2) / max(activeIterations, 1.0), fract(phase * 0.10 + u_growth_phase * 0.17));
            float d = sdSegment(q, root, mix(root, tip, max(branchGrowth, 0.30))) - radius * (0.62 + 0.12 * sin(float(j) + phase));
            if (d < best.dist) best = TubeHit(d, fi / max(activeIterations, 1.0), float(j) + 1.0, radius);

            if (u_quality > 0.85) {
                vec3 subDir = normalize(mix(dir, branchDirection(mode, fi + float(j) + 2.0, -sideSign, phase), 0.62));
                vec3 subRoot = mix(root, tip, 0.58 + 0.10 * sin(fi + float(j)));
                vec3 subTip = subRoot + subDir * branchLen * 0.58;
                float subD = sdSegment(q, subRoot, mix(subRoot, subTip, max(branchGrowth, 0.22))) - radius * 0.45;
                if (subD < best.dist) best = TubeHit(subD, fi / max(activeIterations, 1.0), float(j) + 5.0, radius * 0.45);
            }
        }

        a = b;
        trunkDir = normalize(mix(trunkDir, branchDirection(mode, fi, sin(fi * 2.0 + mode), phase), 0.20 + 0.10 * u_fork_density));
        len *= scale;
    }

    return best;
}

float mapScene(vec3 p) {
    return mapTubes(p).dist;
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
    float travel = minT;
    for (int i = 0; i < 16; i++) {
        if (float(i) >= 4.0 + 8.0 * u_quality) break;
        if (travel >= maxT) break;
        float h = mapScene(ro + rd * travel);
        result = min(result, 10.0 * h / max(travel, 0.03));
        travel += clamp(h, 0.025, 0.20);
    }
    return clamp(result, 0.18, 1.0);
}

vec3 targetOffset(float mode, float t) {
    if (mode < 0.5) return vec3(0.0, 0.10, 0.0);
    if (mode < 1.5) return vec3(0.08 * sin(t * 0.20), 0.22, 0.10 * cos(t * 0.17));
    if (mode < 2.5) return vec3(0.12 * sin(t * 0.22), 0.03, 0.12 * cos(t * 0.19));
    return vec3(-0.06 + 0.12 * sin(t * 0.18), -0.22, 0.12 * cos(t * 0.16));
}

vec3 backgroundTube(vec3 rd, float t) {
    float shaft = pow(max(0.0, 1.0 - abs(rd.x * 0.45 + rd.y * 0.28)), 7.0);
    return vec3(0.006, 0.009, 0.014) + paletteTube(t * 0.020 + rd.z * 0.08, u_palette) * shaft * 0.055;
}

void main() {
    float mode = systemMode();
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.08;
    float spinT = u_time * u_orbit_spin + phaseOffset() + mode * 0.82 + seedPhase() * 0.07;
    float rollT = u_time * u_roll_speed + phaseOffset() + mode;
    float dive = sin(t * 0.27 + mode) * u_flight_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.17 + mode));
    vec3 target = targetOffset(mode, t);

    vec3 orbitPath = vec3(sin(spinT * 0.32 + mode) * radius, 0.26 + cos(t * 0.24 + mode) * 0.34, 2.86 - dive + cos(spinT * 0.32 + mode) * radius * 0.34);
    vec3 figurePath = vec3(sin(spinT * 0.39 + mode) * radius * 0.92, 0.22 + sin(t * 0.70 + mode) * 0.32, 2.58 - dive * 0.70 + sin(spinT * 0.39) * cos(spinT * 0.39) * radius * 0.68);
    vec3 tunnelPath = vec3(sin(spinT * 0.23 + mode) * radius * 0.50, 0.12 + cos(t * 0.35 + mode) * 0.24, 2.10 - dive * 1.22 + cos(spinT * 0.23 + mode) * radius * 0.20);
    vec3 grazePath = vec3(sin(spinT * 0.28 + mode) * radius * 0.64, -0.02 + cos(t * 0.46 + mode) * 0.20, 1.88 - dive * 0.58 + cos(spinT * 0.28 + mode) * radius * 0.24);
    vec3 ro = orbitPath;
    if (u_motion_mode >= 0.5 && u_motion_mode < 1.5) ro = figurePath;
    else if (u_motion_mode >= 1.5 && u_motion_mode < 2.5) ro = tunnelPath;
    else if (u_motion_mode >= 2.5) ro = grazePath;
    ro.xz = rot2(mode * 0.42 + spinT * 0.12) * ro.xz;

    float rollValue = u_roll * sin(rollT * 0.48 + mode) + u_global_rotation * 0.2;
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, u_fov, rollValue);

    float travel = 0.0;
    float hitT = -1.0;
    TubeHit hit = TubeHit(0.0, 0.0, 0.0, 0.0);
    float glowAccum = 0.0;
    int maxSteps = int(30.0 + u_detail * 18.0 * u_quality);
    for (int i = 0; i < 96; i++) {
        if (i >= maxSteps) break;
        vec3 p = ro + rd * travel;
        TubeHit h = mapTubes(p);
        // Clear bubble around the camera (distance from it is just travel): a
        // camera inside a tube used to hit at once and show a dark frame.
        glowAccum += exp(-abs(h.dist) * 26.0) * 0.010; // glow from the real tubes
        h.dist = max(h.dist, 0.05 - travel);
        if (h.dist < 0.0015) {
            hitT = travel;
            hit = h;
            break;
        }
        travel += clamp(h.dist * 0.78, 0.012, 0.18);
        if (travel > 7.0 + u_flight_depth * 0.65) break;
    }

    vec3 col = backgroundTube(rd, t);
    if (hitT > 0.0) {
        vec3 p = ro + rd * hitT;
        vec3 n = estimateNormal(p, 0.004 + hit.core * 0.18);
        vec3 lightDir = normalize(vec3(-0.42, 0.64, 0.55));
        float diff = max(dot(n, lightDir), 0.0);
        float sh = softShadow(p + n * 0.018, lightDir, 0.035, 2.4);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.4);
        float ring = 0.5 + 0.5 * sin((hit.age * 16.0 + hit.branch * 0.63 + t * u_color_speed * 0.42) * 6.28318530718);
        vec3 base = paletteTube(hit.age + t * u_color_speed * 0.045 + hit.branch * 0.05, u_palette);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            base = mix(base, paletteTube(ring + hit.core * 2.0, u_palette), 0.50);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            base = mix(base, vec3(0.80, 0.96, 1.0), smoothstep(0.0, 0.8, hit.age) * 0.45);
        } else if (u_shade_mode >= 2.5) {
            base *= 0.72 + 0.80 * rim;
        }
        col = base * (0.18 + diff * sh * 0.92);
        col += base * rim * (0.35 + u_glow * 0.26);
        col += paletteTube(ring + t * 0.035, u_palette) * glowAccum * u_glow;
        float fogAmount = 1.0 - exp(-hitT * (0.052 + u_fog * 0.082));
        fogAmount = max(fogAmount, 1.0 - smoothstep(0.05, 0.16, hitT)); // grazing hits fade into fog
        col = mix(col, backgroundTube(rd, t) + paletteTube(t * 0.025, u_palette) * 0.050, fogAmount);
    } else {
        col += paletteTube(t * 0.03 + glowAccum, u_palette) * glowAccum * (0.6 + u_glow * 0.45);
    }

    vec2 screenUv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
    float weave = smoothstep(0.20, 1.0, abs(sin(screenUv.x * 34.0 + t * 0.50) * sin(screenUv.y * 39.0 - t * 0.42)));
    col += paletteTube(t * 0.04 + weave * 0.18 + mode * 0.1, u_palette) * weave * (0.008 + 0.006 * u_glow);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
