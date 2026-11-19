function o(e){var t=e.EffectRegistry,a=e.FractalFlight;return t.register({name:"fractal_flame_volume_flight",label:"3D Fractal Flame Volume Flight",category:"Fractals",description:"Volumetric IFS/flame-inspired clouds with nonlinear 3D transforms, density tonemapping, and fly-through motion",fractalFlight:a.metadata({family:"3D Fractal Flame Volume",familyKey:"fractal_flame_volume",modeParam:"flame_mode",modes:["Swirl Flame","Spherical Bloom","Curl Lattice","Bubble Nest"],depthParams:["flight_depth"],requiredParams:["flame_mode","iterations","affine_scale","swirl_strength","spherical_warp","density","detail","flight_depth","transform_morph","volume_twist","color_bleed"],animationParams:["flight_speed","flight_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","transform_morph","volume_twist","color_bleed","roll","roll_speed","fov","color_speed"],smokePresets:[{name:"Swirl Flame Dive",values:{flame_mode:0,iterations:17,affine_scale:1.42,swirl_strength:1.58,spherical_warp:.54,density:1.28,detail:2.35,flight_speed:2.3,flight_depth:1.36,orbit_radius:1.42,orbit_spin:1.72,motion_mode:2,motion_phase:.3,transform_morph:1.32,volume_twist:1.58,color_bleed:.7,roll:.34,roll_speed:1.58,fov:1.78,color_speed:.92,palette:0,shade_mode:2,fog:0,glow:1.36}},{name:"Spherical Bloom Cloud",values:{flame_mode:1,iterations:14,affine_scale:1.18,swirl_strength:.82,spherical_warp:1.24,density:1.48,detail:1.3,flight_speed:2.24,flight_depth:1.58,orbit_radius:1.28,orbit_spin:1.58,motion_mode:0,motion_phase:.28,transform_morph:.94,volume_twist:.74,color_bleed:.82,roll:.3,roll_speed:1.48,fov:1.04,color_speed:.84,palette:1,shade_mode:3,fog:.24,glow:1.94}},{name:"Curl Lattice Corridor",values:{flame_mode:2,iterations:15,affine_scale:1.34,swirl_strength:1.22,spherical_warp:.88,density:1.42,detail:1.35,flight_speed:2.42,flight_depth:1.72,orbit_radius:1.06,orbit_spin:1.76,motion_mode:2,motion_phase:.38,transform_morph:1.08,volume_twist:1.08,color_bleed:.92,roll:.36,roll_speed:1.62,fov:.94,color_speed:.92,palette:2,shade_mode:2,fog:.18,glow:2.06}},{name:"Bubble Nest Spiral",values:{flame_mode:3,iterations:16,affine_scale:1.12,swirl_strength:.86,spherical_warp:1.34,density:1.34,detail:1.42,flight_speed:2.34,flight_depth:1.66,orbit_radius:1.16,orbit_spin:1.66,motion_mode:1,motion_phase:.52,transform_morph:1.18,volume_twist:-.92,color_bleed:1.02,roll:-.32,roll_speed:1.54,fov:.98,color_speed:.88,palette:3,shade_mode:1,fog:.22,glow:2}}]}),params:[{name:"flame_mode",label:"Flame Mode",group:"Formula",type:"select",options:["Swirl Flame","Spherical Bloom","Curl Lattice","Bubble Nest"],default:0},{name:"iterations",label:"IFS Iterations",group:"Formula",min:5,max:22,default:12,step:1,type:"int"},{name:"affine_scale",label:"Affine Scale",group:"Formula",min:.65,max:2.2,default:1.22,step:.02},{name:"swirl_strength",label:"Swirl Strength",group:"Formula",min:0,max:2.4,default:.95,step:.02},{name:"spherical_warp",label:"Spherical Warp",group:"Formula",min:0,max:2.4,default:.82,step:.02},{name:"density",label:"Volume Density",group:"Formula",min:.3,max:3,default:1.22,step:.02},{name:"detail",label:"Volume Detail",group:"Formula",min:.5,max:2.5,default:1.15,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:8,default:.72,step:.05},{name:"flight_depth",label:"Dive Depth",group:"Flight",min:0,max:4.6,default:.95,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5.8,default:1.18,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-5,max:5,default:.58,step:.05},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Cloud Orbit","Figure Eight","Volume Tunnel","Surface Graze"],default:2},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"transform_morph",label:"Transform Morph",group:"Animation",min:0,max:1.8,default:.58,step:.05},{name:"volume_twist",label:"Volume Twist",group:"Animation",min:-2,max:2,default:.72,step:.02},{name:"color_bleed",label:"Color Bleed",group:"Animation",min:0,max:1.8,default:.62,step:.05},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.8,max:1.8,default:.24,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:6,default:.68,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.9,default:1,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.52,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Electric Sheep","Jade Smoke","Violet Ember","Solar Glass"],default:0},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Density Glow","Color Lineage","Hot Core","Soft Film"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.28,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:3,default:1.45,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_flame_mode;
uniform float u_iterations;
uniform float u_affine_scale;
uniform float u_swirl_strength;
uniform float u_spherical_warp;
uniform float u_density;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_flight_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_transform_morph;
uniform float u_volume_twist;
uniform float u_color_bleed;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

float flameMode() {
    return clamp(floor(u_flame_mode + 0.5), 0.0, 3.0);
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

vec3 paletteFlame(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    // The cosine palettes do not end on the colour they start with: run them
    // there and back so a wrap of t has no jump.
    t = 1.0 - abs(1.0 - 2.0 * t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.16, 0.10, 0.24), vec3(0.58, 0.28, 0.72), vec3(0.78, 0.48, 1.0), vec3(0.02, 0.18, 0.44));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.05, 0.22, 0.18), vec3(0.24, 0.62, 0.46), vec3(0.40, 0.95, 0.74), vec3(0.08, 0.36, 0.52));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.32, 0.08, 0.16), vec3(0.62, 0.24, 0.34), vec3(1.00, 0.45, 0.76), vec3(0.00, 0.22, 0.40));
    }
    return palette(t, vec3(0.36, 0.20, 0.06), vec3(0.62, 0.42, 0.18), vec3(1.00, 0.72, 0.32), vec3(0.04, 0.16, 0.38));
}

vec3 flameStep(vec3 z, float mode, float phase, float fi) {
    float twist = u_volume_twist * (0.24 + fi * 0.018) + phase * 0.075;
    z = rotY3(twist + mode * 0.33) * rotZ3(twist * 0.71 + fi * 0.09) * z;
    z.xy = rot2(u_swirl_strength * 0.32 + phase * 0.05 + fi * 0.11) * z.xy;
    float r2 = max(dot(z, z), 0.012);
    if (mode < 0.5) {
        z.xy = vec2(z.x * cos(z.y * u_swirl_strength) - z.y * sin(z.x * u_swirl_strength),
                    z.x * sin(z.y * u_swirl_strength) + z.y * cos(z.x * u_swirl_strength));
        z = z * (0.72 + 0.08 * sin(phase + fi)) + vec3(0.18, -0.06, 0.11) * sin(phase * 0.3 + fi);
    } else if (mode < 1.5) {
        z = z / (0.28 + r2 * (0.70 + 0.18 * u_spherical_warp));
        z += sin(z.yzx * 1.7 + phase + fi) * (0.035 + 0.020 * u_transform_morph);
    } else if (mode < 2.5) {
        z = abs(z) - vec3(0.42, 0.33, 0.28);
        z += sin(z.zxy * 2.2 + phase * 0.9) * (0.060 + 0.030 * u_spherical_warp);
    } else {
        z = z / (0.20 + r2);
        z = abs(z) - vec3(0.36 + 0.05 * sin(phase), 0.28, 0.31);
        z += cos(z.yzx * 2.0 - phase) * (0.040 + 0.025 * u_transform_morph);
    }
    z *= mix(0.64, 1.16, clamp(u_affine_scale / 2.2, 0.0, 1.0));
    return z;
}

vec3 flameStats(vec3 p, out float densityOut, out float hueOut) {
    float mode = flameMode();
    float phase = u_time * 0.19 + phaseOffset() + seedPhase() * 0.08 + mode;
    vec3 z = p;
    float density = 0.0;
    float trap = 10.0;
    float hue = 0.0;
    for (int i = 0; i < 24; i++) {
        if (float(i) >= u_iterations) break;
        float fi = float(i);
        z = flameStep(z, mode, phase, fi);
        float r = length(z);
        trap = min(trap, r);
        float pulse = exp(-r * r * (1.10 + u_density * 0.55));
        density += pulse * (0.70 + 0.30 * sin(fi * 1.7 + phase));
        hue += pulse * (fi / max(u_iterations, 1.0) + dot(z, vec3(0.13, 0.17, 0.11)));
    }
    float sheet = exp(-abs(sin(p.x * 2.1 + p.y * 1.6 + phase) + cos(p.z * 1.7 - phase * 0.8)) * (2.2 - 0.4 * clamp(u_detail, 0.5, 2.5)));
    float radiusGate = exp(-dot(p, p) * (0.075 + 0.035 * clamp(u_detail, 0.5, 2.5)));
    float foldRidge = abs(sin(z.x * 2.7 + phase) * sin(z.y * 3.1 - phase * 0.7) * cos(z.z * 2.4 + mode));
    float filament = smoothstep(0.42, 0.98, foldRidge);
    float cellularRidge = smoothstep(0.20, 0.95, foldRidge) * (0.54 + 0.46 * sheet);
    float radial = length(p.xy);
    float angle = atan(p.y, p.x);
    float tube = exp(-abs(radial - (0.58 + 0.16 * sin(p.z * 1.35 + phase + mode))) * (4.8 + u_detail * 1.7));
    float spiral = smoothstep(0.35, 1.0, abs(sin(angle * (3.0 + mode) + p.z * (2.1 + u_transform_morph * 0.3) + phase)));
    float vortex = tube * spiral * exp(-abs(p.z) * 0.18);
    float core = density / max(u_iterations, 1.0) * u_density;
    densityOut = max(0.0, core * radiusGate * (0.08 + 1.75 * cellularRidge) * (0.28 + 0.72 * filament) +
        sheet * 0.024 * u_spherical_warp * (0.25 + filament) +
        vortex * (0.08 + 0.05 * u_density + 0.035 * u_transform_morph));
    hueOut = hue / max(density + 0.001, 0.001) + trap * 0.08;
    return z;
}

vec3 targetOffset(float mode, float t) {
    if (mode < 0.5) return vec3(0.0, 0.03, 0.0);
    if (mode < 1.5) return vec3(0.12 * sin(t * 0.22), 0.05, 0.10 * cos(t * 0.19));
    if (mode < 2.5) return vec3(0.08 * sin(t * 0.24), -0.03, 0.14 * cos(t * 0.18));
    return vec3(-0.10 + 0.16 * sin(t * 0.20), 0.04, 0.12 * cos(t * 0.17));
}

vec3 backgroundFlame(vec3 rd, float t) {
    float haze = pow(max(0.0, 1.0 - abs(rd.y * 0.7 + rd.x * 0.2)), 5.0);
    return vec3(0.006, 0.008, 0.014) + paletteFlame(t * 0.018 + rd.z * 0.08, u_palette) * haze * 0.055;
}

void main() {
    float mode = flameMode();
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.10;
    float spinT = u_time * u_orbit_spin + phaseOffset() + mode * 0.78 + seedPhase() * 0.08;
    float rollT = u_time * u_roll_speed + phaseOffset() + mode;
    float dive = sin(t * 0.26 + mode * 0.4) * u_flight_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.18 + mode));
    vec3 target = targetOffset(mode, t);

    vec3 orbitPath = vec3(sin(spinT * 0.33 + mode) * radius, 0.24 + cos(t * 0.23 + mode) * 0.32, 2.88 - dive + cos(spinT * 0.33 + mode) * radius * 0.34);
    vec3 figurePath = vec3(sin(spinT * 0.40 + mode) * radius * 0.92, 0.24 + sin(t * 0.72 + mode) * 0.30, 2.60 - dive * 0.68 + sin(spinT * 0.40) * cos(spinT * 0.40) * radius * 0.68);
    vec3 tunnelPath = vec3(sin(spinT * 0.24 + mode) * radius * 0.48, 0.15 + cos(t * 0.33 + mode) * 0.22, 2.12 - dive * 1.24 + cos(spinT * 0.24 + mode) * radius * 0.20);
    vec3 grazePath = vec3(sin(spinT * 0.29 + mode) * radius * 0.64, 0.08 + cos(t * 0.46 + mode) * 0.18, 1.92 - dive * 0.60 + cos(spinT * 0.29 + mode) * radius * 0.24);
    vec3 ro = orbitPath;
    if (u_motion_mode >= 0.5 && u_motion_mode < 1.5) ro = figurePath;
    else if (u_motion_mode >= 1.5 && u_motion_mode < 2.5) ro = tunnelPath;
    else if (u_motion_mode >= 2.5) ro = grazePath;
    ro.xz = rot2(mode * 0.42 + spinT * 0.12) * ro.xz;

    float rollValue = u_roll * sin(rollT * 0.48 + mode) + u_global_rotation * 0.2;
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, u_fov, rollValue);

    vec3 col = backgroundFlame(rd, t);
    float alpha = 0.0;
    float totalGlow = 0.0;
    float travel = 0.0;
    float maxDist = 6.2 + u_flight_depth * 0.6;
    int maxSteps = int(42.0 + u_detail * 24.0);
    for (int i = 0; i < 96; i++) {
        if (i >= maxSteps) break;
        float fi = float(i);
        float stepSize = maxDist / float(maxSteps);
        travel = fi * stepSize;
        vec3 p = ro + rd * travel;
        p.xy = rot2(u_volume_twist * 0.13 * travel + t * 0.025) * p.xy;
        float d;
        float hue;
        vec3 z = flameStats(p, d, hue);
        float relief = 0.42 + 0.58 * smoothstep(0.03, 0.42, d);
        relief *= 0.70 + 0.30 * abs(sin(dot(p, vec3(2.1, 2.7, 3.3)) + t * 0.36));
        float local = clamp(pow(max(d * 2.15 - 0.006, 0.0), 1.08) * stepSize * (0.86 + u_density * 0.18) * relief, 0.0, 0.24);
        vec3 flameCol = paletteFlame(hue + t * u_color_speed * 0.045 + mode * 0.10, u_palette);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            flameCol = mix(flameCol, paletteFlame(length(z) * 0.12 + hue, u_palette), 0.52);
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            flameCol *= 0.72 + 0.70 * smoothstep(0.04, 0.55, d);
        } else if (u_shade_mode >= 2.5) {
            flameCol = mix(flameCol, vec3(1.0, 0.72, 0.46), 0.18 + 0.30 * smoothstep(0.08, 0.65, d));
        }
        col += (1.0 - alpha) * flameCol * local * (0.96 + u_glow * 0.24);
        alpha += (1.0 - alpha) * local * (0.44 + u_color_bleed * 0.14);
        totalGlow += d * 0.012;
    }

    vec2 screenUv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
    float weave = smoothstep(0.18, 1.0, abs(sin(screenUv.x * 34.0 + t * 0.58) * sin(screenUv.y * 41.0 - t * 0.43)));
    col += paletteFlame(t * 0.04 + weave * 0.24 + mode * 0.1, u_palette) * weave * (0.008 + 0.007 * u_glow);
    col += paletteFlame(t * 0.032, u_palette) * totalGlow * u_glow * 0.55;
    float fogAmount = 1.0 - exp(-travel * (0.042 + u_fog * 0.074));
    col = mix(col, backgroundFlame(rd, t) + paletteFlame(t * 0.02, u_palette) * 0.045, fogAmount * 0.55);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
