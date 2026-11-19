function l(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"difs_tunnel_flight",label:"DIFS Tunnel Flight",category:"Fractals",description:"Raymarched distance-IFS tunnel structures with Koch folds, Mandalay boxes, torus tubes, octa shells, and twisted kaleido columns",fractalFlight:a.metadata({family:"DIFS Tunnel",familyKey:"difs_tunnel",modeParam:"family",modes:["Koch KIFS 3D","Mandalay Folded Box","Jerusalem Cube","Torus Tube DIFS","Octahedral Shell","Twisted Kaleido Column"],depthParams:["tunnel_depth"],requiredParams:["family","iterations","fold_scale","fold_offset","fold_bias","symmetry","twist","thickness","bailout","detail","tunnel_depth","structure_pulse","fold_rotation"],animationParams:["flight_speed","tunnel_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","structure_pulse","fold_rotation","twist","roll","roll_speed","fov","color_speed"],smokePresets:[{name:"Koch Vault Orbit",values:{family:0,iterations:9,fold_scale:2.72,fold_offset:.86,fold_bias:.12,symmetry:6,twist:.62,thickness:.76,bailout:4.2,detail:1.2,flight_speed:1.55,tunnel_depth:1.25,orbit_radius:1.18,orbit_spin:1.28,motion_mode:0,motion_phase:.14,structure_pulse:.66,fold_rotation:.66,roll:.22,roll_speed:1.2,color_speed:.72,palette:0,shade_mode:2,fog:.24,glow:1.78}},{name:"Mandalay Deep Box",values:{family:1,iterations:10,fold_scale:2.82,fold_offset:.72,fold_bias:.2,symmetry:5,twist:.74,thickness:.82,bailout:4.8,detail:1.24,flight_speed:2.25,tunnel_depth:1.74,orbit_radius:1.12,orbit_spin:1.62,motion_mode:2,motion_phase:.24,structure_pulse:.82,fold_rotation:.86,roll:.32,roll_speed:1.52,color_speed:.84,palette:1,shade_mode:3,fog:.2,glow:1.92}},{name:"Torus Tube Push",values:{family:3,iterations:10,fold_scale:2.85,fold_offset:.78,fold_bias:.18,symmetry:7,twist:.82,thickness:.72,bailout:4.6,detail:1.26,flight_speed:2.5,tunnel_depth:1.85,orbit_radius:1.05,orbit_spin:1.82,motion_mode:2,motion_phase:.29,structure_pulse:.88,fold_rotation:.92,roll:.36,roll_speed:1.72,color_speed:.88,palette:1,shade_mode:3,fog:.2,glow:2.05}},{name:"Kaleido Column Graze",values:{family:5,iterations:10,fold_scale:3.04,fold_offset:.72,fold_bias:.16,symmetry:9,twist:1.02,thickness:.62,bailout:4.8,detail:1.28,flight_speed:2.38,tunnel_depth:1.66,orbit_radius:1.08,orbit_spin:1.74,motion_mode:3,motion_phase:.46,structure_pulse:.86,fold_rotation:1.02,roll:.42,roll_speed:1.68,color_speed:.86,palette:2,shade_mode:2,fog:.18,glow:2}}]}),params:[{name:"family",label:"DIFS Mode",group:"Formula",type:"select",options:["Koch KIFS 3D","Mandalay Folded Box","Jerusalem Cube","Torus Tube DIFS","Octahedral Shell","Twisted Kaleido Column"],default:3},{name:"iterations",label:"Fold Iterations",group:"Formula",min:3,max:18,default:9,step:1,type:"int"},{name:"fold_scale",label:"Fold Scale",group:"Formula",min:1.4,max:4.5,default:2.72,step:.05},{name:"fold_offset",label:"Fold Offset",group:"Formula",min:.15,max:1.9,default:.82,step:.02},{name:"fold_bias",label:"Fold Bias",group:"Formula",min:-.9,max:.9,default:.08,step:.02},{name:"symmetry",label:"Symmetry",group:"Formula",min:3,max:12,default:6,step:1,type:"int"},{name:"twist",label:"Twist",group:"Formula",min:-2,max:2,default:.48,step:.02},{name:"thickness",label:"Core Thickness",group:"Formula",min:.12,max:2.2,default:.78,step:.02},{name:"bailout",label:"Bailout",group:"Formula",min:1.4,max:8,default:4.2,step:.1},{name:"detail",label:"Surface Detail",group:"Formula",min:.5,max:2.5,default:1.18,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:8,default:.78,step:.05},{name:"tunnel_depth",label:"Tunnel Depth",group:"Flight",min:0,max:4.2,default:.92,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5.8,default:1.05,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-5,max:5,default:.62,step:.05},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Vault Orbit","Figure Eight","Tunnel Push","Surface Graze"],default:2},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"structure_pulse",label:"Structure Pulse",group:"Animation",min:0,max:1.8,default:.55,step:.05},{name:"fold_rotation",label:"Fold Rotation",group:"Animation",min:-2,max:2,default:.64,step:.02},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.8,max:1.8,default:.28,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:6,default:.72,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.9,default:.98,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.56,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Cathedral Brass","Blue Circuit","Violet Glass","Lava Matrix"],default:1},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Trap Glow","Normal Glass","Iteration Bands","Cell Pulse"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.3,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:3,default:1.65,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_family;
uniform float u_iterations;
uniform float u_fold_scale;
uniform float u_fold_offset;
uniform float u_fold_bias;
uniform float u_symmetry;
uniform float u_twist;
uniform float u_thickness;
uniform float u_bailout;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_tunnel_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_structure_pulse;
uniform float u_fold_rotation;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

struct DifsHit {
    float dist;
    float iter;
    float trap;
    float cell;
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

float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735027;
}

float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}

float sdCross(vec3 p, float bar, float len) {
    vec3 q = abs(p);
    float xy = max(max(q.x, q.y) - bar, q.z - len);
    float xz = max(max(q.x, q.z) - bar, q.y - len);
    float yz = max(max(q.y, q.z) - bar, q.x - len);
    return min(xy, min(xz, yz));
}

vec3 sortFold(vec3 p) {
    p = abs(p);
    if (p.x < p.y) p.xy = p.yx;
    if (p.x < p.z) p.xz = p.zx;
    if (p.y < p.z) p.yz = p.zy;
    return p;
}

vec3 tetraFold(vec3 p) {
    if (p.x + p.y < 0.0) p.xy = -p.yx;
    if (p.x + p.z < 0.0) p.xz = -p.zx;
    if (p.y + p.z < 0.0) p.yz = -p.zy;
    return abs(p);
}

vec2 kaleido(vec2 p, float sectors) {
    float n = clamp(floor(sectors + 0.5), 3.0, 12.0);
    float a = 6.28318530718 / n;
    float ang = mod(atan(p.y, p.x) + a * 0.5, a) - a * 0.5;
    return vec2(cos(ang), sin(ang)) * length(p);
}

vec3 paletteDifs(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.34, 0.23, 0.10), vec3(0.56, 0.42, 0.20), vec3(0.94, 0.70, 0.34), vec3(0.03, 0.22, 0.45));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.07, 0.24, 0.40), vec3(0.22, 0.54, 0.66), vec3(0.48, 0.88, 1.00), vec3(0.08, 0.30, 0.58));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.27, 0.13, 0.42), vec3(0.48, 0.25, 0.62), vec3(0.82, 0.48, 1.00), vec3(0.45, 0.08, 0.20));
    }
    return palette(t, vec3(0.38, 0.12, 0.06), vec3(0.62, 0.25, 0.10), vec3(1.00, 0.50, 0.18), vec3(0.00, 0.16, 0.33));
}

DifsHit difsDE(vec3 p) {
    vec3 z = p;
    float mode = familyMode();
    float phase = u_time * 0.18 + phaseOffset() + mode * 0.81 + seedPhase() * 0.10;
    float pulse = sin(phase * 1.11 + length(p) * 0.28) * u_structure_pulse;
    float scaleValue = max(u_fold_scale + pulse * 0.16, 1.08);
    float offsetValue = max(u_fold_offset + pulse * 0.07, 0.001);
    float twistValue = u_twist + u_fold_rotation * 0.45 + pulse * 0.11;
    float scaleAccum = 1.0;
    float trap = 1000.0;
    float cell = 0.0;
    float iter = 0.0;

    for (int i = 0; i < 20; i++) {
        if (float(i) >= u_iterations) break;
        float fi = float(i);
        z = rotY3(twistValue * 0.22 + fi * 0.045) * rotZ3(u_fold_rotation * 0.18 + fi * 0.031) * z;

        if (mode < 0.5) {
            z = sortFold(z);
            z.xy = kaleido(z.xy, u_symmetry);
            z = rotY3(twistValue * 0.38 + fi * 0.07) * z;
            vec3 c = vec3(1.0 + u_fold_bias, 0.82 - u_fold_bias * 0.25, 0.34 + offsetValue * 0.24);
            z = vec3(
                scaleValue * (z.x - c.x) + c.x,
                scaleValue * (z.y - c.y) + c.y,
                scaleValue * z.z
            );
            float zCut = c.z * (scaleValue - 1.0) * 0.46;
            if (z.z < zCut) z.z -= c.z * (scaleValue - 1.0);
            cell += length(z.xy) * 0.025;
        } else if (mode < 1.5) {
            vec3 limit = vec3(offsetValue + 0.18, offsetValue, offsetValue * 0.86 + u_fold_bias * 0.15);
            z = clamp(z, -limit, limit) * 2.0 - z;
            z = rotX3(twistValue * 0.24 + fi * 0.06) * z;
            z = z * scaleValue + p * (0.62 + 0.05 * sin(phase));
            cell += abs(sdBox(z, limit)) * 0.035;
        } else if (mode < 2.5) {
            z = abs(z + vec3(u_fold_bias, -u_fold_bias * 0.5, u_fold_bias * 0.25));
            z.xy = kaleido(z.xy, u_symmetry);
            z.yz = abs(z.yz);
            z = z * scaleValue - vec3(offsetValue * 1.12, offsetValue * 0.82, offsetValue * 1.02) * (scaleValue - 1.0);
            cell += sdCross(z, 0.30 + offsetValue * 0.09, 1.22 + offsetValue) * 0.032;
        } else if (mode < 3.5) {
            z.xy = kaleido(z.xy, u_symmetry);
            z.xz = rot2(twistValue * 0.30 + fi * 0.08 + length(z.xy) * 0.07) * z.xz;
            z = abs(z) - vec3(offsetValue * 0.62, offsetValue * 0.28, offsetValue * 0.62);
            z = z * scaleValue - vec3(offsetValue * 0.42, offsetValue * 0.18 + u_fold_bias, offsetValue * 0.58) * (scaleValue - 1.0);
            cell += abs(length(z.xz) - offsetValue) * 0.026;
        } else if (mode < 4.5) {
            z = tetraFold(z);
            z = sortFold(z);
            z = rotX3(twistValue * 0.36 + fi * 0.09) * rotZ3(twistValue * 0.22) * z;
            z = z * scaleValue - vec3(offsetValue + u_fold_bias, offsetValue * 0.92, offsetValue - u_fold_bias * 0.35) * (scaleValue - 1.0);
            cell += abs(z.x + z.y + z.z) * 0.013;
        } else {
            z.xy = kaleido(z.xy, u_symmetry);
            z.xz = rot2(twistValue * 0.40 + z.y * 0.15 + fi * 0.05) * z.xz;
            z = abs(z + vec3(u_fold_bias * 0.25, -u_fold_bias * 0.3, u_fold_bias * 0.4)) - offsetValue * 0.42;
            z.yz = kaleido(z.yz, max(3.0, u_symmetry - 1.0));
            z = z * scaleValue - vec3(offsetValue * 0.72, offsetValue * 1.05, offsetValue * 0.84) * (scaleValue - 1.0);
            cell += length(z.xz) * 0.021 + abs(z.y) * 0.008;
        }

        scaleAccum *= scaleValue;
        trap = min(trap, length(z));
        iter = fi + 1.0;
        if (dot(z, z) > u_bailout * u_bailout) break;
    }

    float shell = 0.88 + u_thickness * 0.46 + pulse * 0.05;
    float boxDist = sdBox(z, vec3(shell));
    float sphereDist = length(z) - shell;
    float crossDist = sdCross(z, shell * 0.32, shell * 1.65);
    float octaDist = sdOctahedron(z, shell * 2.18);
    float torusDist = sdTorus(z.xzy, vec2(shell * 0.78, max(0.035, u_thickness * 0.12)));
    float columnDist = min(
        abs(length(z.xz) - shell * 0.62) - max(0.025, u_thickness * 0.045),
        abs(sdBox(z, vec3(shell * 0.55, shell * 1.22, shell * 0.55))) - max(0.018, u_thickness * 0.030)
    );
    float kochDist = max(boxDist, -crossDist);
    float mandalayDist = min(abs(sphereDist) - shell * 0.035, abs(boxDist) - shell * 0.030);
    float jerusalemDist = min(abs(boxDist) - shell * 0.026, abs(crossDist) - shell * 0.030);
    float octaShell = min(abs(octaDist) - shell * 0.034, abs(sdBox(z, vec3(shell * 0.68))) - shell * 0.024);

    float localDist = kochDist;
    if (mode >= 0.5 && mode < 1.5) localDist = mandalayDist;
    else if (mode >= 1.5 && mode < 2.5) localDist = jerusalemDist;
    else if (mode >= 2.5 && mode < 3.5) localDist = torusDist;
    else if (mode >= 3.5 && mode < 4.5) localDist = octaShell;
    else if (mode >= 4.5) localDist = columnDist;

    float dist = localDist / max(scaleAccum, 1.0);
    return DifsHit(max(abs(dist), 0.00001), iter, trap, cell);
}

// Clear bubble around the camera: the path can pass through the fractal,
// and a ray starting inside it filled the screen with one flat colour.
const float CAM_CLEAR = 0.05;
vec3 g_cam = vec3(1e5);
float camClear(vec3 p) { return CAM_CLEAR - length(p - g_cam); }

float mapScene(vec3 p) {
    return max(difsDE(p).dist, camClear(p));
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
        result = min(result, 10.0 * h / t);
        t += clamp(h, 0.025, 0.23);
    }
    return clamp(result, 0.12, 1.0);
}

vec3 background(vec3 rd, float t) {
    float vault = pow(max(0.0, 1.0 - abs(rd.x * 0.52 + rd.y * 0.22)), 8.0);
    float horizon = smoothstep(-0.62, 0.62, rd.y);
    float angle = atan(rd.y, rd.x);
    float ribs = 0.5 + 0.5 * sin(angle * 18.0 + rd.z * 9.0 + t * 0.38);
    float halo = pow(max(0.0, 1.0 - length(rd.xy * vec2(0.72, 1.12))), 2.4);
    vec3 base = mix(vec3(0.009, 0.011, 0.018), vec3(0.030, 0.040, 0.060), horizon);
    vec3 accent = paletteDifs(t * 0.026 + rd.z * 0.075 + ribs * 0.08, u_palette);
    return base + accent * (vault * 0.060 + halo * ribs * 0.045);
}

void main() {
    float mode = familyMode();
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.12;
    float motionMode = u_motion_mode;
    float familyPhase = mode * 0.94;
    float spinT = u_time * u_orbit_spin + phaseOffset() + familyPhase + seedPhase() * 0.09;
    float rollT = u_time * u_roll_speed + phaseOffset() + familyPhase;
    float tunnel = sin(t * 0.26 + familyPhase) * u_tunnel_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.19 + familyPhase));

    vec3 target = vec3(
        0.14 * sin(spinT * 0.28 + familyPhase),
        0.12 * cos(t * 0.27 + familyPhase),
        0.08 * sin(spinT * 0.21)
    );
    target += vec3(
        sin(spinT * 0.20 + familyPhase * 0.7),
        cos(t * 0.25 + 1.2),
        sin(spinT * 0.33 + familyPhase)
    ) * (0.075 * u_structure_pulse);

    vec3 orbitPath = vec3(
        sin(spinT * 0.35 + familyPhase) * radius,
        0.34 + cos(t * 0.24 + familyPhase) * 0.34,
        2.85 - tunnel + cos(spinT * 0.35 + familyPhase) * radius * 0.34
    );
    vec3 figurePath = vec3(
        sin(spinT * 0.42 + familyPhase) * radius * 0.94,
        0.26 + sin(t * 0.78 + familyPhase) * 0.32,
        2.62 - tunnel * 0.62 + sin(spinT * 0.42) * cos(spinT * 0.42) * radius * 0.78
    );
    vec3 tunnelPath = vec3(
        sin(spinT * 0.24 + familyPhase) * radius * 0.46,
        0.18 + cos(t * 0.32 + familyPhase) * 0.23,
        2.28 - tunnel * 1.35 + cos(spinT * 0.24 + familyPhase) * radius * 0.20
    );
    vec3 grazePath = vec3(
        sin(spinT * 0.29 + familyPhase) * radius * 0.66,
        0.08 + cos(t * 0.48 + familyPhase) * 0.20,
        1.96 - tunnel * 0.60 + cos(spinT * 0.29 + familyPhase) * radius * 0.24
    );

    vec3 ro = orbitPath;
    if (motionMode >= 0.5 && motionMode < 1.5) ro = figurePath;
    else if (motionMode >= 1.5 && motionMode < 2.5) ro = tunnelPath;
    else if (motionMode >= 2.5) ro = grazePath;
    if (mode >= 2.5 && mode < 3.5) ro = target + (ro - target) * 0.78;
    ro.xz = rot2(familyPhase * 0.42 + spinT * 0.10 + sin(spinT * 0.12) * 0.14) * ro.xz;

    float rollValue = u_roll * sin(rollT * (0.44 + motionMode * 0.05) + familyPhase) + u_global_rotation * 0.2;
    float fovBreath = u_fov * (1.0 + 0.07 * sin(t * 0.21 + familyPhase) + 0.02 * u_structure_pulse * sin(t * 0.58));
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, fovBreath, rollValue);

    g_cam = ro;
    float total = 0.0;
    float hitT = -1.0;
    DifsHit hitInfo = DifsHit(0.0, 0.0, 0.0, 0.0);
    float glowAccum = 0.0;
    float epsBase = mix(0.0046, 0.00125, clamp(u_detail / 2.5, 0.0, 1.0));

    for (int i = 0; i < 156; i++) {
        if (float(i) >= 84.0 + u_detail * 26.0) break;
        vec3 p = ro + rd * total;
        DifsHit h = difsDE(p);
        float dist = max(h.dist, camClear(p));
        glowAccum += exp(-dist * 36.0) * 0.014;
        if (dist < epsBase * max(1.0, total * 0.54)) {
            hitT = total;
            hitInfo = h;
            break;
        }
        total += max(dist, epsBase * 1.35) * 0.72;
        if (total > 10.0) break;
    }

    vec3 col = background(rd, t);
    if (hitT >= 0.0) {
        vec3 p = ro + rd * hitT;
        vec3 n = estimateNormal(p, epsBase * 2.15);
        vec3 lightDir = normalize(vec3(0.40, 0.78, 0.50));
        vec3 fillDir = normalize(vec3(-0.62, 0.30, -0.22));
        float diff = max(dot(n, lightDir), 0.0);
        float fill = max(dot(n, fillDir), 0.0) * 0.36;
        float rim = pow(max(0.0, 1.0 + dot(rd, n)), 2.08);
        float shadow = softShadow(p + n * epsBase * 3.0, lightDir, 0.04, 3.6);
        float iterTone = hitInfo.iter / max(u_iterations, 1.0);
        float trapTone = -log(max(hitInfo.trap, 0.0001)) * 0.16;
        float cellTone = hitInfo.cell * 0.18;
        float hue = trapTone + iterTone * 0.48 + cellTone + t * u_color_speed * 0.046 + mode * 0.095;
        vec3 base = paletteDifs(hue, u_palette);
        float cavity = clamp(1.24 - hitInfo.trap * 1.04, 0.0, 1.0);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            vec3 normalCol = n * 0.5 + 0.5;
            base = mix(base, normalCol, 0.34 + 0.22 * rim);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            float bands = 0.5 + 0.5 * sin(iterTone * 44.0 + cellTone * 7.0 + t * (0.58 + u_color_speed));
            base *= 0.66 + bands * 0.66;
        } else if (u_shade_mode >= 2.5) {
            float cellPulse = 0.5 + 0.5 * sin(hitInfo.cell * 2.2 + t * (0.48 + u_color_speed));
            base = mix(base, paletteDifs(cellPulse + trapTone + mode * 0.07, u_palette), 0.54);
        }
        float ao = 0.40 + 0.60 * smoothstep(0.0, 1.0, iterTone + clamp(hitInfo.trap * 0.25, 0.0, 0.7));
        vec3 light = base * (0.23 + diff * shadow * 1.55 + fill) * ao;
        light += paletteDifs(hue + 0.20, u_palette) * rim * (0.36 + u_glow * 0.50);
        light += vec3(0.78, 0.90, 1.0) * cavity * 0.22;
        col = light;
    }

    col += paletteDifs(t * 0.035 + total * 0.035, u_palette) * glowAccum * u_glow;
    float fogAmount = 1.0 - exp(-total * (0.050 + u_fog * 0.080));
    // Hits right at the bubble (camera grazing or inside the surface) fade
    // into the fog instead of popping in as a flat full-screen colour.
    if (hitT >= 0.0) fogAmount = max(fogAmount, 1.0 - smoothstep(CAM_CLEAR, 0.16, hitT));
    col = mix(col, background(rd, t) + paletteDifs(t * 0.02, u_palette) * 0.048, fogAmount);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{l as default};
