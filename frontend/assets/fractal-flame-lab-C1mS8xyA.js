function _(l){var f=l.EffectRegistry,e=l.FractalLab;return(function(){"use strict";var t=["Swirl Spiral","Spherical Cloud","Julia Veil","Mandala Bloom","Lace Arches","Starburst Rays","PDJ Chaos","Gaussian Cloud","Radial Streaks","Rings","Popcorn Texture"],m=["MODE_FLAME_SWIRL_SPIRAL","MODE_FLAME_SPHERICAL_CLOUD","MODE_FLAME_JULIA_VEIL","MODE_FLAME_MANDALA_BLOOM","MODE_FLAME_LACE_ARCHES","MODE_FLAME_STARBURST_RAYS","MODE_FLAME_PDJ_CHAOS","MODE_FLAME_GAUSSIAN_CLOUD","MODE_FLAME_RADIAL_STREAKS","MODE_FLAME_RINGS","MODE_FLAME_POPCORN_TEXTURE"],a=["Linear","Sinusoidal","Spherical","Swirl","Horseshoe","Polar","Handkerchief","Heart","Disc","Spiral","Julia","Popcorn","Rings","PDJ"];f.register({name:"fractal_flame_lab",label:"Fractal Flame Lab",category:"Fractals",description:"Stateless fractal-flame variation lab with swirl, spherical, Julia, PDJ, rings, popcorn, and mandala modes",fractalFlight:e.metadata({family:"Fractal Flame Lab",familyKey:"fractal_flame_lab",modeParam:"flame_mode",modes:t,modeTokens:m,renderCost:"medium",requiredGroups:["Formula","Shape","Animation","Color"],requiredParams:["flame_mode","flame_variation_a","flame_variation_b","flame_variation_blend","flame_symmetry","flame_plot_scale","flame_density","flame_palette"],structuralParams:["flame_mode","flame_variation_a","flame_variation_b","flame_variation_blend","flame_symmetry","flame_plot_scale","flame_plot_rotate","flame_plot_offset_x","flame_plot_offset_y","flame_struct_scale","flame_struct_shear"],animationParams:["flame_orbit_speed","flame_variation_speed","flame_symmetry_pulse","flame_final_blend","flame_color_speed"],smokePresets:[e.preset("Swirl Spiral Bloom",{flame_mode:0,flame_variation_a:3,flame_variation_b:9,flame_variation_blend:.42,flame_symmetry:5,flame_plot_scale:1.68,flame_struct_scale:1.16,flame_struct_shear:.18,flame_orbit_speed:1.1,flame_variation_speed:.72,flame_symmetry_pulse:.44,flame_final_blend:.36,flame_palette:0,flame_density:1.26,flame_exposure:1.36,flame_glow:1.18}),e.preset("Spherical Ember Cloud",{flame_mode:1,flame_variation_a:2,flame_variation_b:1,flame_variation_blend:.56,flame_symmetry:4,flame_plot_scale:1.92,flame_struct_scale:.94,flame_struct_shear:-.1,flame_orbit_speed:.86,flame_variation_speed:.62,flame_symmetry_pulse:.24,flame_final_blend:.48,flame_palette:1,flame_density:1.42,flame_gamma:.92,flame_exposure:1.48,flame_glow:1.24}),e.preset("Julia Veil Glass",{flame_mode:2,flame_variation_a:10,flame_variation_b:3,flame_variation_blend:.34,flame_symmetry:6,flame_plot_scale:1.58,flame_plot_rotate:.24,flame_struct_scale:1.08,flame_orbit_speed:.94,flame_variation_speed:.88,flame_symmetry_pulse:.52,flame_final_blend:.62,flame_palette:4,flame_density:1.18,flame_exposure:1.42,flame_color_speed:.88,flame_glow:1.08}),e.preset("Mandala Bloom Wheel",{flame_mode:3,flame_variation_a:8,flame_variation_b:7,flame_variation_blend:.46,flame_symmetry:9,flame_plot_scale:1.74,flame_struct_scale:1.2,flame_struct_shear:.05,flame_orbit_speed:.72,flame_variation_speed:.78,flame_symmetry_pulse:.78,flame_final_blend:.42,flame_palette:3,flame_density:1.34,flame_exposure:1.3,flame_glow:1.2}),e.preset("Lace Arch Lantern",{flame_mode:4,flame_variation_a:4,flame_variation_b:5,flame_variation_blend:.52,flame_symmetry:7,flame_plot_scale:1.86,flame_plot_offset_y:-.08,flame_struct_scale:1.1,flame_struct_shear:.28,flame_orbit_speed:.82,flame_variation_speed:.58,flame_symmetry_pulse:.36,flame_final_blend:.54,flame_palette:2,flame_density:1.3,flame_exposure:1.44,flame_glow:1.16}),e.preset("Starburst Ray Choir",{flame_mode:5,flame_variation_a:8,flame_variation_b:12,flame_variation_blend:.38,flame_symmetry:11,flame_plot_scale:1.62,flame_struct_scale:1.26,flame_struct_shear:-.06,flame_orbit_speed:1.18,flame_variation_speed:.92,flame_symmetry_pulse:.62,flame_final_blend:.34,flame_palette:1,flame_density:1.24,flame_exposure:1.38,flame_color_speed:.76,flame_glow:1.3}),e.preset("PDJ Chaos Silk",{flame_mode:6,flame_variation_a:13,flame_variation_b:3,flame_variation_blend:.5,flame_symmetry:5,flame_plot_scale:1.46,flame_plot_rotate:-.16,flame_struct_scale:1.18,flame_struct_shear:.12,flame_orbit_speed:.96,flame_variation_speed:1.04,flame_symmetry_pulse:.42,flame_final_blend:.58,flame_palette:4,flame_density:1.36,flame_exposure:1.52,flame_color_speed:.82,flame_glow:1.22}),e.preset("Gaussian Mist Flame",{flame_mode:7,flame_variation_a:1,flame_variation_b:2,flame_variation_blend:.44,flame_symmetry:6,flame_plot_scale:1.72,flame_struct_scale:.98,flame_struct_shear:.16,flame_orbit_speed:.68,flame_variation_speed:.74,flame_symmetry_pulse:.3,flame_final_blend:.66,flame_palette:0,flame_density:1.54,flame_gamma:.86,flame_exposure:1.58,flame_glow:1.36}),e.preset("Radial Streak Crown",{flame_mode:8,flame_variation_a:8,flame_variation_b:9,flame_variation_blend:.48,flame_symmetry:12,flame_plot_scale:1.58,flame_struct_scale:1.22,flame_struct_shear:-.18,flame_orbit_speed:1.08,flame_variation_speed:.86,flame_symmetry_pulse:.74,flame_final_blend:.4,flame_palette:3,flame_density:1.26,flame_exposure:1.4,flame_glow:1.24}),e.preset("Rings Orbit Flame",{flame_mode:9,flame_variation_a:12,flame_variation_b:6,flame_variation_blend:.54,flame_symmetry:8,flame_plot_scale:1.76,flame_struct_scale:1.12,flame_struct_shear:.1,flame_orbit_speed:.88,flame_variation_speed:.68,flame_symmetry_pulse:.54,flame_final_blend:.5,flame_palette:2,flame_density:1.32,flame_exposure:1.46,flame_color_speed:.7,flame_glow:1.18}),e.preset("Popcorn Texture Bloom",{flame_mode:10,flame_variation_a:11,flame_variation_b:13,flame_variation_blend:.46,flame_symmetry:6,flame_plot_scale:1.52,flame_struct_scale:1.1,flame_struct_shear:.2,flame_orbit_speed:.98,flame_variation_speed:1.1,flame_symmetry_pulse:.48,flame_final_blend:.56,flame_palette:1,flame_density:1.38,flame_gamma:.9,flame_exposure:1.5,flame_color_speed:.88,flame_glow:1.28})]}),params:[{name:"flame_mode",label:"Flame Mode",group:"Formula",type:"select",options:t,default:0},{name:"flame_variation_a",label:"Variation A",group:"Formula",type:"select",options:a,default:3},{name:"flame_variation_b",label:"Variation B",group:"Formula",type:"select",options:a,default:2},{name:"flame_variation_blend",label:"Variation Blend",group:"Formula",min:0,max:1,default:.44,step:.02},{name:"flame_symmetry",label:"Symmetry",group:"Formula",min:1,max:16,default:6,step:1,type:"int"},{name:"flame_plot_scale",label:"Plot Scale",group:"Shape",min:.2,max:6,default:1.68,step:.05},{name:"flame_plot_rotate",label:"Plot Rotate",group:"Shape",min:-3.14159,max:3.14159,default:0,step:.02},{name:"flame_plot_offset_x",label:"Plot Offset X",group:"Shape",min:-2,max:2,default:0,step:.02},{name:"flame_plot_offset_y",label:"Plot Offset Y",group:"Shape",min:-2,max:2,default:0,step:.02},{name:"flame_struct_scale",label:"Structure Scale",group:"Shape",min:.25,max:4,default:1.12,step:.03},{name:"flame_struct_shear",label:"Structure Shear",group:"Shape",min:-1.5,max:1.5,default:.1,step:.02},{name:"flame_orbit_speed",label:"Orbit Speed",group:"Animation",min:-8,max:8,default:.92,step:.05},{name:"flame_variation_speed",label:"Variation Speed",group:"Animation",min:-8,max:8,default:.74,step:.05},{name:"flame_symmetry_pulse",label:"Symmetry Pulse",group:"Animation",min:0,max:3,default:.44,step:.05},{name:"flame_final_blend",label:"Final Blend",group:"Animation",min:0,max:1,default:.48,step:.02},{name:"flame_palette",label:"Palette",group:"Color",type:"select",palette:!0,options:["Neon Flame","Amber Opal","Cobalt Rose","Violet Gold","Aqua Coral"],default:0},{name:"flame_density",label:"Density",group:"Color",min:.1,max:4,default:1.28,step:.05},{name:"flame_gamma",label:"Gamma",group:"Color",min:.45,max:2.5,default:.95,step:.03},{name:"flame_exposure",label:"Exposure",group:"Color",min:.2,max:5,default:1.4,step:.05},{name:"flame_color_speed",label:"Color Speed",group:"Color",min:-8,max:8,default:.72,step:.05},{name:"flame_glow",label:"Glow",group:"Color",min:0,max:3,default:1.16,step:.05}],_modeTokens:m.slice(),_variationOptions:a.slice(),shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_flame_mode;
uniform float u_flame_variation_a;
uniform float u_flame_variation_b;
uniform float u_flame_variation_blend;
uniform float u_flame_symmetry;
uniform float u_flame_plot_scale;
uniform float u_flame_plot_rotate;
uniform float u_flame_plot_offset_x;
uniform float u_flame_plot_offset_y;
uniform float u_flame_struct_scale;
uniform float u_flame_struct_shear;
uniform float u_flame_orbit_speed;
uniform float u_flame_variation_speed;
uniform float u_flame_symmetry_pulse;
uniform float u_flame_final_blend;
uniform float u_flame_palette;
uniform float u_flame_density;
uniform float u_flame_gamma;
uniform float u_flame_exposure;
uniform float u_flame_color_speed;
uniform float u_flame_glow;

// MODE_FLAME_SWIRL_SPIRAL MODE_FLAME_SPHERICAL_CLOUD MODE_FLAME_JULIA_VEIL
// MODE_FLAME_MANDALA_BLOOM MODE_FLAME_LACE_ARCHES MODE_FLAME_STARBURST_RAYS
// MODE_FLAME_PDJ_CHAOS MODE_FLAME_GAUSSIAN_CLOUD MODE_FLAME_RADIAL_STREAKS
// MODE_FLAME_RINGS MODE_FLAME_POPCORN_TEXTURE

struct FlameHit {
    float value;
    float edge;
    float phaseValue;
    float mask;
};

float flameTau() { return 6.28318530718; }

float flameMode() {
    return clamp(floor(u_flame_mode + 0.5), 0.0, 10.0);
}

float flameVariationId(float raw) {
    return clamp(floor(raw + 0.5), 0.0, 13.0);
}

float flameHash(float n) {
    return fract(sin(n * 127.1 + u_seed * 19.73) * 43758.5453123);
}

vec2 flameLimit(vec2 p) {
    float len = length(p);
    if (len > 7.5) p *= 7.5 / len;
    return p;
}

float flameTan(float x) {
    return tan(clamp(x, -1.32, 1.32));
}

vec2 flameLinear(vec2 p) { return p; }
vec2 flameSinusoidal(vec2 p) { return sin(p); }
vec2 flameSpherical(vec2 p) { return p / max(dot(p, p), 0.012); }

vec2 flameSwirl(vec2 p) {
    float r2 = dot(p, p);
    float s = sin(r2);
    float c = cos(r2);
    return vec2(p.x * s - p.y * c, p.x * c + p.y * s);
}

vec2 flameHorseshoe(vec2 p) {
    float r = max(length(p), 0.006);
    return vec2((p.x - p.y) * (p.x + p.y), 2.0 * p.x * p.y) / r;
}

vec2 flamePolar(vec2 p) {
    return vec2(atan(p.y, p.x) / 3.14159265, length(p) - 1.0);
}

vec2 flameHandkerchief(vec2 p) {
    float r = length(p);
    float a = atan(p.y, p.x);
    return r * vec2(sin(a + r), cos(a - r));
}

vec2 flameHeart(vec2 p) {
    float r = length(p);
    float a = atan(p.y, p.x);
    return r * vec2(sin(a * r), -cos(a * r));
}

vec2 flameDisc(vec2 p) {
    float a = atan(p.y, p.x) / 3.14159265;
    float r = length(p) * 3.14159265;
    return a * vec2(sin(r), cos(r));
}

vec2 flameSpiral(vec2 p) {
    float r = max(length(p), 0.018);
    float a = atan(p.y, p.x);
    return vec2(cos(a) + sin(r), sin(a) - cos(r)) / r;
}

vec2 flameJulia(vec2 p, float salt) {
    float r = sqrt(max(length(p), 0.0001));
    float a = atan(p.y, p.x) * 0.5;
    float omega = 3.14159265 * step(0.5, flameHash(dot(p, vec2(13.7, 41.2)) + salt));
    return sqrt(r) * vec2(cos(a + omega), sin(a + omega));
}

vec2 flamePopcorn(vec2 p, float amount) {
    float c = 0.18 + 0.22 * amount;
    float f = 0.16 + 0.18 * (1.0 - amount);
    return p + vec2(c * sin(flameTan(3.0 * p.y)), f * sin(flameTan(3.0 * p.x)));
}

vec2 flameRings(vec2 p, float salt) {
    float r = max(length(p), 0.0001);
    float a = atan(p.y, p.x);
    float c = 0.22 + 0.20 * flameHash(salt + 4.0);
    float nr = mod(r + c * c, 2.0 * c) - c + r * (1.0 - c);
    return vec2(cos(a), sin(a)) * nr;
}

vec2 flamePDJ(vec2 p, float salt) {
    float t = u_time * u_flame_variation_speed;
    float a = 1.35 + 0.72 * sin(salt * 0.41 + t * 0.13 + u_seed_vec.x);
    float b = 1.78 + 0.66 * cos(salt * 0.37 - t * 0.11 + u_seed_vec.y);
    float c = 1.22 + 0.78 * sin(salt * 0.29 + t * 0.17 + u_seed_vec.z);
    float d = 1.64 + 0.58 * cos(salt * 0.33 - t * 0.19 + u_seed_vec.w);
    return vec2(sin(a * p.y) - cos(b * p.x), sin(c * p.x) - cos(d * p.y));
}

vec2 flameVariation(vec2 p, float id, float salt) {
    if (id < 0.5) return flameLinear(p);
    if (id < 1.5) return flameSinusoidal(p);
    if (id < 2.5) return flameSpherical(p);
    if (id < 3.5) return flameSwirl(p);
    if (id < 4.5) return flameHorseshoe(p);
    if (id < 5.5) return flamePolar(p);
    if (id < 6.5) return flameHandkerchief(p);
    if (id < 7.5) return flameHeart(p);
    if (id < 8.5) return flameDisc(p);
    if (id < 9.5) return flameSpiral(p);
    if (id < 10.5) return flameJulia(p, salt);
    if (id < 11.5) return flamePopcorn(p, flameHash(salt + 2.0));
    if (id < 12.5) return flameRings(p, salt);
    return flamePDJ(p, salt);
}

vec2 flameBlendVariation(vec2 p, float t, float salt) {
    float a = flameVariationId(u_flame_variation_a);
    float b = flameVariationId(u_flame_variation_b);
    float motion = sin(t * u_flame_variation_speed + salt * 0.71) * 0.18;
    float blendValue = clamp(u_flame_variation_blend + motion, 0.0, 1.0);
    vec2 va = flameVariation(p, a, salt);
    vec2 vb = flameVariation(p, b, salt + 17.0);
    return flameLimit(mix(va, vb, blendValue));
}

vec2 flameModeWarp(vec2 p, float mode, float t, float salt) {
    float r = max(length(p), 0.0001);
    float a = atan(p.y, p.x);
    if (mode < 0.5) {
        return flameSwirl(p * (1.08 + 0.08 * sin(t * 0.19 + salt)));
    }
    if (mode < 1.5) {
        vec2 inv = flameSpherical(p * (0.82 + 0.08 * sin(t * 0.13)));
        return mix(p * 0.56, inv * 0.38, 0.72);
    }
    if (mode < 2.5) {
        return flameJulia(p + 0.10 * vec2(sin(t * 0.17 + salt), cos(t * 0.14 - salt)), salt);
    }
    if (mode < 3.5) {
        float petals = cos(a * max(u_flame_symmetry, 1.0) + t * 0.38) * 0.22;
        return vec2(cos(a + petals), sin(a + petals)) * (r + petals * 0.44);
    }
    if (mode < 4.5) {
        vec2 h = flameHorseshoe(p);
        h.y += sin(p.x * 2.7 + t * 0.24 + salt) * 0.12;
        return h;
    }
    if (mode < 5.5) {
        float rays = pow(abs(cos(a * max(u_flame_symmetry, 1.0) * 0.5 + t * 0.28)), 2.0);
        return vec2(cos(a), sin(a)) * (r * (0.64 + rays * 0.48));
    }
    if (mode < 6.5) {
        return flamePDJ(p * (0.92 + 0.10 * sin(t * 0.21)), salt);
    }
    if (mode < 7.5) {
        float n = snoise(vec3(p * (1.2 + u_flame_struct_scale), t * 0.08 + salt));
        return p * (0.74 + 0.20 * n) + vec2(n, snoise(vec3(p.yx * 1.31, t * 0.07 - salt))) * 0.20;
    }
    if (mode < 8.5) {
        float spoke = sin(a * max(u_flame_symmetry, 1.0) + log(r + 0.08) * 2.0 - t * 0.34);
        return vec2(cos(a + spoke * 0.10), sin(a + spoke * 0.10)) * (r + spoke * 0.18);
    }
    if (mode < 9.5) {
        return flameRings(p, salt + t * 0.05);
    }
    return flamePopcorn(p, 0.5 + 0.5 * sin(t * 0.17 + salt));
}

vec2 flameFinalTransform(vec2 p, float t, float salt) {
    vec2 q = p;
    q = rot2(0.18 * sin(t * 0.22 + salt)) * q;
    q.x += q.y * u_flame_struct_shear * 0.10;
    q += vec2(sin(q.y * 1.7 + t * 0.21 + salt), cos(q.x * 1.4 - t * 0.18 - salt)) * 0.035;
    return flameLimit(q);
}

FlameHit flamePack(float value, float edge, float phaseValue, float mask) {
    return FlameHit(value, edge, phaseValue, mask);
}

FlameHit flameField(vec2 p, float t) {
    float mode = flameMode();
    float symPulse = u_flame_symmetry_pulse * (0.5 + 0.5 * sin(t * 0.44 + mode));
    float sym = clamp(floor(u_flame_symmetry + symPulse), 1.0, 16.0);
    vec2 base = flameModeWarp(p, mode, t, 0.0);
    float acc = 0.0;
    float edge = 0.0;
    float phaseValue = 0.0;
    float weightTotal = 0.0;

    for (int i = 0; i < 16; i++) {
        float fi = float(i);
        if (fi >= sym) break;
        float sector = flameTau() * fi / max(sym, 1.0);
        float spin = t * u_flame_orbit_speed * (0.035 + 0.006 * fi);
        vec2 q = rot2(sector + spin) * base;
        q.x += q.y * u_flame_struct_shear * 0.26;
        q += vec2(u_flame_plot_offset_x, u_flame_plot_offset_y) * 0.32;
        float localWeight = 1.0;

        for (int j = 0; j < 5; j++) {
            float fj = float(j);
            float salt = fi * 11.7 + fj * 5.3 + mode * 23.1;
            vec2 pre = q * (u_flame_struct_scale * (0.86 + 0.035 * fj));
            pre = rot2(0.37 * fj + spin * 0.55 + sin(t * 0.09 + salt) * 0.10) * pre;
            pre += 0.12 * vec2(sin(salt + t * 0.13), cos(salt * 0.7 - t * 0.11));

            vec2 z = flameBlendVariation(pre, t, salt);
            z = flameModeWarp(z, mode, t, salt + 3.0);
            z = mix(z, flameFinalTransform(z, t, salt), clamp(u_flame_final_blend, 0.0, 1.0));
            z = flameLimit(z);

            float r = length(z);
            float a = atan(z.y, z.x);
            float filament = exp(-r * (1.18 + 0.13 * fj)) * localWeight;
            float ring = exp(-abs(fract(r * (1.18 + 0.16 * u_flame_struct_scale + 0.04 * fj) - t * 0.035 * u_flame_orbit_speed + salt * 0.013) - 0.5) * 12.0) * localWeight;
            float ray = exp(-abs(sin(a * sym + t * 0.22 + salt)) * (4.0 + 2.0 * u_flame_density)) * localWeight * 0.35;

            acc += filament * (0.76 + 0.24 * sin(r * 5.0 + t * 0.33 + salt));
            edge += ring + ray;
            phaseValue += (a * 0.15915494 + r * 0.09 + salt * 0.003) * localWeight;
            weightTotal += localWeight;
            q = z + 0.055 * vec2(cos(t * 0.18 + salt), sin(t * 0.15 - salt));
            localWeight *= 0.70;
        }
    }

    float norm = max(weightTotal, 0.001);
    float value = acc / norm;
    float edgeValue = edge / norm;
    if (mode > 7.5 && mode < 8.5) {
        float rayBoost = exp(-abs(sin(atan(base.y, base.x) * sym + t * 0.36)) * 3.6);
        value += rayBoost * 0.18;
        edgeValue = edgeValue * 1.45 + rayBoost * 0.22;
    }
    float mask = value * 1.25 + edgeValue * 0.70;
    return flamePack(value, edgeValue, phaseValue / norm, mask);
}

vec3 flamePalette(float x, float pal) {
    x = fract(x);
    if (pal > 4.5) return psyLut(x);
    if (pal < 0.5) return neon(x);
    if (pal < 1.5) return palette(x, vec3(0.16,0.07,0.02), vec3(0.78,0.38,0.12), vec3(0.98,0.65,0.24), vec3(0.03,0.18,0.42));
    if (pal < 2.5) return palette(x, vec3(0.03,0.10,0.24), vec3(0.24,0.46,0.84), vec3(0.96,0.34,0.58), vec3(0.12,0.36,0.62));
    if (pal < 3.5) return palette(x, vec3(0.18,0.05,0.30), vec3(0.58,0.32,0.70), vec3(0.96,0.72,0.22), vec3(0.10,0.30,0.60));
    return palette(x, vec3(0.04,0.18,0.20), vec3(0.24,0.72,0.68), vec3(1.00,0.43,0.34), vec3(0.08,0.36,0.66));
}

vec3 flameColorize(FlameHit hit, vec2 p, float t) {
    float density = max(u_flame_density, 0.02);
    float light = log(1.0 + hit.mask * density * max(u_flame_exposure, 0.05) * 2.4);
    float hue = hit.phaseValue + hit.edge * 0.18 + t * u_flame_color_speed * 0.032 + flameMode() * 0.061;
    vec3 base = flamePalette(hue, u_flame_palette);
    vec3 accent = flamePalette(hue + 0.18 + hit.value * 0.12, u_flame_palette);
    vec3 col = base * light;
    col += accent * hit.edge * u_flame_glow * 0.72;
    col += flamePalette(length(p) * 0.10 - t * 0.014, u_flame_palette) * u_flame_glow * 0.035;
    col *= 0.84 + smoothstep(0.0, 0.9, hit.value) * 0.36;
    col = psyTonemap(col);
    return pow(max(col, vec3(0.0)), vec3(1.0 / max(u_flame_gamma, 0.2)));
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time;
    vec2 p = uv * max(u_flame_plot_scale, 0.05);
    p = rot2(u_flame_plot_rotate + t * u_flame_orbit_speed * 0.018) * p;
    p += vec2(u_flame_plot_offset_x, u_flame_plot_offset_y) * 0.45;

    FlameHit hit = flameField(p, t);
    vec3 col = flameColorize(hit, p, t);
    float vignette = smoothstep(1.82, 0.12, length(uv));
    vec3 bg = flamePalette(length(uv) * 0.10 - t * 0.01, u_flame_palette) * (0.010 + 0.020 * u_flame_glow) * vignette;
    FRAG_OUT = vec4(col * (0.70 + 0.30 * vignette) + bg, 1.0);
}
`})})(),{}}export{_ as default};
