function x(u){var p=u.EffectRegistry,n=u.FractalFlight;return{EndlessScenes:(function(){"use strict";var h=["Dawn Gold","Glacial Blue","Amethyst","Emerald","Ember","Pearl"],f=[];function e(t,r,s,a,i,c,l,y){return n.range(t,r,s,a,i,c,l,y)}function m(){return[e("speed","Flight Speed","Flight",0,3,1,.01),e("altitude","Flight Height","Flight",.3,2,1,.01),e("sway","Path Sway","Flight",0,1,.45,.01),e("bank","Gentle Banking","Flight",0,1,.3,.01),e("fov","Wide-Angle View","Flight",.75,1.8,1.35,.01),e("view_distance","View Distance","Flight",35,160,110,1,"int")]}function d(t){return[{name:"palette",label:"Color Palette",group:"Color",type:"select",palette:!0,options:(t||h).slice(),default:0},e("color_phase","Palette Phase","Color",0,1,0,.01),e("hue_shift","Hue Shift","Color",0,1,0,.01),e("saturation","Saturation","Color",0,2,1,.01),e("color_spread","Color Spread","Color",0,2,1,.01),e("color_drift","Color Drift","Color",0,1,0,.01),e("fog","Atmospheric Haze","Light",0,2.5,.65,.01),e("glow","Luminous Edges","Light",0,2,.5,.01),e("exposure","Exposure","Light",.5,2,1,.01),e("audio_react","Beat Light","Light",0,2,.65,.01),e("detail","Ray Detail","Light",80,220,150,1,"int")]}var v=`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform vec4 u_beat;

float esHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

float esNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(esHash(i), esHash(i + vec2(1.0, 0.0)), f.x),
               mix(esHash(i + vec2(0.0, 1.0)), esHash(i + 1.0), f.x), f.y);
}

float esBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// At each scale remove the three intersecting middle-third tunnels.
// Stretching the cube uses the smallest axis scale for a safe lower bound.
float esMenger(vec3 p, float depth) {
    float d = esBox(p, vec3(1.0));
    float s = 1.0;
    for (int i = 0; i < 4; i++) {
        if (float(i) >= depth) break;
        vec3 a = abs(mod(p * s + 1.0, 2.0) - 1.0);
        vec3 holes = 1.0 / 3.0 - a;
        float crossCut = max(min(holes.x, holes.y), max(min(holes.y, holes.z), min(holes.z, holes.x))) / s;
        d = max(d, crossCut);
        s *= 3.0;
    }
    return d;
}

vec3 esPaletteBase(float t) {
    float w = 0.5 + 0.5 * cos(t * 6.283185);
    float m = floor(u_palette + 0.5);
    if (m >= 5.5) return psyLutLinear(t);
    if (m < 0.5) return mix(vec3(0.025, 0.095, 0.23), vec3(1.0, 0.57, 0.17), w);
    if (m < 1.5) return mix(vec3(0.035, 0.12, 0.28), vec3(0.42, 0.88, 1.0), w);
    if (m < 2.5) return mix(vec3(0.13, 0.05, 0.28), vec3(0.90, 0.46, 0.91), w);
    if (m < 3.5) return mix(vec3(0.025, 0.12, 0.15), vec3(0.38, 0.94, 0.63), w);
    if (m < 4.5) return mix(vec3(0.12, 0.025, 0.04), vec3(1.0, 0.38, 0.12), w);
    return mix(vec3(0.045, 0.14, 0.30), vec3(0.96, 0.89, 0.73), w);
}

vec3 esPalette(float t) {
    vec3 c = esPaletteBase(t * u_color_spread + u_color_phase + u_time * u_color_drift * 0.025);
    // Rotate around the neutral RGB axis, then control saturation separately.
    const vec3 axis = vec3(0.577350269);
    float a = u_hue_shift * 6.283185;
    c = c * cos(a) + cross(axis, c) * sin(a) + axis * dot(axis, c) * (1.0 - cos(a));
    float grey = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return max(mix(vec3(grey), c, u_saturation), vec3(0.0));
}

vec3 esSky(vec3 rd, vec3 sunDir) {
    float horizon = exp(-abs(rd.y) * 3.0);
    vec3 sky = mix(esPalette(0.46) * 0.12, esPalette(0.04) * 0.30, horizon);
    float sun = max(dot(rd, sunDir), 0.0);
    sky += vec3(1.0, 0.76, 0.48) * (pow(sun, 350.0) * 3.5 + pow(sun, 12.0) * 0.28);
    // Fixed direction-space stars: translation does not make the sky jitter.
    vec2 starCell = floor(rd.xy / max(abs(rd.z), 0.2) * 240.0);
    float stars = step(0.9985, esHash(starCell + u_seed_vec.xy * 10.0));
    return sky * mix(1.0, 0.07, ES_INTERIOR) + vec3(stars * 0.35 * ES_INTERIOR);
}
`,g=`
// One call site per loop keeps ANGLE from inlining four copies of the scene.
vec3 esNormal(vec3 p, float eps) {
    vec3 n = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        vec3 e = i == 0 ? vec3(1.0, -1.0, -1.0) :
            (i == 1 ? vec3(-1.0, -1.0, 1.0) :
            (i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0)));
        n += e * esMap(p + e * eps).x;
    }
    return normalize(n + vec3(0.0, 0.00001, 0.0));
}

float esShadow(vec3 p, vec3 direction) {
    float shade = 1.0, t = 0.12;
    for (int i = 0; i < 12; i++) {
        float d = esMap(p + direction * t).x;
        shade = min(shade, 7.0 * d / t);
        t += clamp(min(d, esStrideLimit(p + direction * t)), 0.012, 2.5);
        if (d < 0.002 || t > 15.0) break;
    }
    return clamp(shade, 0.16, 1.0);
}

void main() {
    // Respect an explicitly enabled preview loop, otherwise time is unbounded.
    float z = u_time * u_speed * ES_SPEED + seedPhase() * 4.0;
    vec3 ro = esPath(z);
    vec3 target = esPath(z + 6.0) - vec3(0.0, ES_LOOK_DROP, 0.0);
    float roll = u_bank * (sin(z * 0.037) * 0.11 + sin(z * 0.071) * 0.035);
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, u_fov, roll);
    vec3 sunDir = normalize(vec3(-0.42, 0.54, 0.73));
    vec3 sky = esSky(rd, sunDir);
    float t = 0.025, hit = 0.0, proximity = 0.0, material = 0.0;
    for (int i = 0; i < 220; i++) {
        if (float(i) >= u_detail || t > u_view_distance) break;
        vec3 samplePoint = ro + rd * t;
        vec2 h = esMap(samplePoint);
        float eps = 0.0018 + t * 0.00055;
        if (h.x < eps) { hit = 1.0; material = h.y; break; }
        float stride = clamp(min(h.x * 0.72, esStrideLimit(samplePoint)), 0.002, 4.0);
        // Weighted by distance, not iteration count, so changing Ray Detail
        // does not artificially brighten slow-converging surfaces.
        proximity += exp(-h.x * 5.0) * stride;
        t += stride;
    }

    vec3 col = sky;
    if (hit > 0.5) {
        vec3 p = ro + rd * t;
        float eps = 0.003 + t * 0.0006;
        vec3 n = esNormal(p, eps);
        vec3 toCamera = normalize(ro - p);
        float diffuse = max(dot(n, sunDir), 0.0);
        float lamp = max(dot(n, toCamera), 0.0) / (1.0 + t * t * 0.0015);
        float facing = clamp(dot(n, -rd), 0.0, 1.0);
        float rim = pow(1.0 - facing, 3.0);
        float ao = 1.0;
        for (int j = 0; j < 3; j++) {
            float off = 0.18 + float(j) * 0.38;
            ao -= max(off - esMap(p + n * off).x, 0.0) * 0.16;
        }
        ao = clamp(ao, 0.35, 1.0);
        float tone = esTone(p, n, material);
        vec3 base = esPalette(tone);
        vec3 warm = mix(vec3(1.0, 0.79, 0.58), esPalette(0.04), 0.3);
        float shadow = esShadow(p + n * eps * 3.0, sunDir);
        vec3 ambient = vec3(0.075, 0.13, 0.22) * (0.45 + 0.55 * (n.y * 0.5 + 0.5));
        col = base * (ambient + warm * diffuse * shadow * 1.25 + vec3(0.62, 0.78, 1.0) * lamp * ES_INTERIOR * 0.5) * ao;
        float spec = pow(max(dot(reflect(-sunDir, n), -rd), 0.0), 48.0);
        col += warm * spec * 0.4 + esPalette(tone + 0.14) * rim * 0.2;
        if (material < 1.5) {
            // A calm reflective floor/river, using the analytic environment.
            vec3 reflection = esSky(reflect(rd, n), sunDir);
            col = mix(col * 0.16, reflection * 0.55, 0.12 + 0.5 * pow(1.0 - facing, 4.0));
            col += warm * spec * 0.65;
        }
        float beatLight = 1.0 + u_audio_react * (u_beat.x * 0.65 + u_audio.x * 0.3);
        col += esEmission(p, n, material) * u_glow * beatLight;
    }
    float fog = 1.0 - exp(-min(t, u_view_distance) * u_fog * 0.018);
    vec3 fogColor = sky + esPalette(0.06) * mix(0.05, 0.015, ES_INTERIOR);
    col = mix(col, fogColor, fog);
    col += esPalette(0.16 + z * 0.0008) * min(proximity, 3.0) * u_glow * 0.06;
    // A smooth fade near the draw limit prevents a hard pop of distant bays.
    col = mix(col, fogColor, smoothstep(u_view_distance * 0.78, u_view_distance, t));
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / u_resolution;
    col *= 1.0 - 0.18 * dot(uv, uv);
    FRAG_OUT = vec4(psyGamma(psyTonemap(col * u_exposure)), 1.0);
}
`;function o(t){var r=t.params.concat(m(),d(t.palettes));r.forEach(function(l){t.defaults&&Object.prototype.hasOwnProperty.call(t.defaults,l.name)&&(l.default=t.defaults[l.name])});var s=r.map(function(l){return"uniform float u_"+l.name+";"}).join(`
`),a=v;if(t.paletteShader){var i=a.indexOf("vec3 esPaletteBase("),c=a.indexOf("vec3 esPalette(",i);a=a.slice(0,i)+t.paletteShader+`
`+a.slice(c)}p.register({name:t.name,label:t.label,category:"Endless Scenes",description:t.description,params:r,specialize:t.specialize||[],endlessScene:{cameraProbe:t.cameraProbe!==!1,renderKind:t.renderKind||"surface"},fractalFlight:n.metadata({kind:"endless-scene",family:t.label,familyKey:t.name,requiredGroups:["Structure","Flight","Color","Light"],commonParams:["speed","altitude","sway","bank","fov","view_distance","palette","fog","glow"],depthParams:["view_distance"],animationParams:["speed","sway","bank"],smokePresets:t.presets}),shader:s+`
`+t.constants+`
`+a+`
`+t.shader+`
`+(t.stride||"float esStrideLimit(vec3 p) { return 4.0; }")+`
`+(t.renderShader||g)}),f.push(t.name)}function _(t){function r(a){return"vec3("+a.map(function(i){return Number(i).toFixed(5)}).join(",")+")"}var s=`vec3 esPaletteBase(float t) {
float m = floor(u_palette + 0.5);
`;return s+="if (m >= "+(t.length-.5).toFixed(1)+`) return psyLutLinear(t);
`,s+=`float w = 0.5 + 0.5 * cos(t * 6.283185);
vec3 a, b, c;
`,t.forEach(function(a,i){s+=(i?"else ":"")+"if (m < "+(i+.5).toFixed(1)+") {",s+="a="+r(a[0])+";b="+r(a[1])+";c="+r(a[2])+`;}
`}),s+=`else {a=vec3(0.1);b=vec3(0.5);c=vec3(1.0);}
`,s+`return mix(mix(a,b,smoothstep(0.0,0.55,w)),c,smoothstep(0.55,1.0,w));
}
`}return o({name:"menger_citadel",label:"Menger Citadel",description:"An endless city of recursive Menger towers: fly along winding avenues between monumental porous spires",constants:"const float ES_INTERIOR = 0.0; const float ES_SPEED = 4.5; const float ES_LOOK_DROP = 0.9;",stride:`
float esStrideLimit(vec3 p) {
    vec2 cell = mod(p.xz + u_spacing * 0.5, u_spacing) - u_spacing * 0.5;
    // Cross empty cell borders in small steps without treating them as walls.
    return u_spacing * 0.5 - max(abs(cell.x), abs(cell.y)) + 0.012;
}
`,params:[e("recursion","Menger Depth","Structure",1,4,3,1,"int"),e("tower_height","Skyline Height","Structure",6,24,16,.1),e("spacing","Tower Spacing","Structure",8,14,10,.1),e("avenue","Avenue Width","Structure",2.2,5,3.2,.1)],presets:[{name:"Titan Dawn",values:{tower_height:20,recursion:3,altitude:1.1,palette:0,fog:.55,speed:.8}},{name:"Glacial Megacity",values:{tower_height:24,spacing:9,altitude:.65,palette:1,fog:.45,glow:.7}},{name:"Pearl Labyrinth",values:{recursion:4,tower_height:14,spacing:8,avenue:2.6,palette:5,altitude:.55,speed:.7}},{name:"Amethyst Spires",values:{tower_height:22,spacing:12,palette:2,altitude:1.6,speed:1.2,glow:1.1,fog:.75}}],shader:`
float esCenter(float z) { return sin(z * 0.025) * 5.0 + sin(z * 0.067) * 1.5; }
vec3 esPath(float z) {
    return vec3(esCenter(z) + sin(z * 0.044) * u_sway * 0.55, 3.0 + u_altitude * 4.0 + sin(z * 0.018) * 0.55, z);
}
vec2 esMap(vec3 p) {
    float space = u_spacing;
    vec2 id = floor((p.xz + space * 0.5) / space);
    vec2 cell = p.xz - id * space;
    float height = u_tower_height * (0.45 + 0.55 * esHash(id + u_seed_vec.xy));
    vec3 size = vec3(space * 0.34, height * 0.5, space * 0.34);
    vec3 q = vec3(cell.x, p.y - size.y, cell.y) / size;
    float tower = esMenger(q, u_recursion) * min(size.x, size.y);
    tower = max(tower, (u_avenue - abs(p.x - esCenter(p.z))) * 0.85);
    float floorD = p.y + 0.18;
    return floorD < tower ? vec2(floorD, 1.0) : vec2(tower, 2.0);
}
float esTone(vec3 p, vec3 n, float material) { return 0.12 + p.y * 0.022 + abs(n.y) * 0.13; }
vec3 esEmission(vec3 p, vec3 n, float material) {
    float bands = pow(0.5 + 0.5 * cos(p.y * 2.0), 24.0);
    return esPalette(p.y * 0.024) * bands * 0.14 * step(1.5, material);
}
`}),o({name:"recursive_cathedral",label:"Recursive Cathedral",description:"An unending procession of immense elliptical vaults, recursive pillars, illuminated ribs and a mirror-dark nave",constants:"const float ES_INTERIOR = 1.0; const float ES_SPEED = 3.2; const float ES_LOOK_DROP = -0.45;",params:[e("vault_height","Vault Height","Structure",12,28,21,.1),e("span","Nave Width","Structure",5,9,6.8,.1),e("bay_length","Bay Length","Structure",6,14,9,.1),e("recursion","Pillar Recursion","Structure",1,3,2,1,"int"),e("ribs","Vault Rib Width","Structure",.18,.7,.32,.01)],presets:[{name:"Sanctuary of Light",values:{palette:5,vault_height:24,glow:1.2,fog:.45,speed:.7,fov:1.55}},{name:"Golden Infinity",values:{palette:0,vault_height:21,bay_length:7,glow:.8,altitude:.75,fog:.65}},{name:"Violet Reliquary",values:{palette:2,recursion:3,span:6,vault_height:18,speed:.8,glow:1.3}},{name:"Frozen Basilica",values:{palette:1,vault_height:28,span:8.5,bay_length:12,fov:1.65,glow:.65,fog:.35}}],shader:`
vec3 esPath(float z) { return vec3(sin(z * 0.043) * u_sway * 1.4, 2.0 + u_altitude * 2.5, z); }
vec2 esMap(vec3 p) {
    float zz = mod(p.z + u_bay_length * 0.5, u_bay_length) - u_bay_length * 0.5;
    vec3 size = vec3(0.9, 3.2, 0.9);
    vec3 q = vec3(abs(p.x) - u_span, p.y - size.y, zz) / size;
    float columns = esMenger(q, u_recursion) * 0.9;
    float stretch = u_span / (u_vault_height - 6.0);
    float arch = abs(length(vec2(p.x, (p.y - 6.0) * stretch)) - u_span) - u_ribs;
    arch = max(max(arch, 6.0 - p.y), abs(zz) - u_ribs * 1.2);
    // Smaller vaults branch along both side aisles (a one-third construction).
    vec2 side = vec2(abs(p.x) - u_span, (p.y - 3.2) * 0.7);
    float smallArch = abs(length(side) - 2.3) - u_ribs * 0.5;
    smallArch = max(max(smallArch, 3.2 - p.y), abs(zz) - u_ribs * 0.7);
    float rib = min(arch * min(stretch, 1.0), smallArch * 0.7);
    float d = min(columns, rib);
    // Continuous golden-ratio-height side rails establish perspective.
    float rail = length(vec2(abs(p.x) - u_span, p.y - 1.618)) - 0.055;
    if (rail < d) { d = rail; }
    float floorD = p.y + 0.06;
    return floorD < d ? vec2(floorD, 1.0) : vec2(d, rib < columns || rail < columns ? 3.0 : 2.0);
}
float esTone(vec3 p, vec3 n, float material) { return 0.04 + p.y * 0.015 + abs(n.x) * 0.18; }
vec3 esEmission(vec3 p, vec3 n, float material) {
    float ribLight = material > 2.5 ? 0.6 : 0.04;
    return esPalette(p.y * 0.014) * ribLight;
}
`}),o({name:"fractal_canyon",label:"Fractal Canyon",description:"Follow an endless river between towering ridged fractal cliffs and natural mathematical arches, lit by an alien dawn",constants:"const float ES_INTERIOR = 0.0; const float ES_SPEED = 5.0; const float ES_LOOK_DROP = 0.4;",params:[e("cliff_height","Cliff Height","Structure",10,36,24,.1),e("width","River Gorge Width","Structure",3.5,9,5,.1),e("roughness","Fractal Roughness","Structure",.3,.65,.48,.01),e("terraces","Stone Terraces","Structure",0,1,.55,.01),e("arches","Natural Arches","Structure",0,1,.65,.01)],presets:[{name:"Valley of Titans",values:{cliff_height:32,width:5,palette:0,altitude:.65,fog:.4,speed:.9}},{name:"Emerald River",values:{cliff_height:22,width:7,palette:3,terraces:.25,arches:.4,altitude:.5,fog:.65}},{name:"Ember Chasm",values:{cliff_height:30,width:4,palette:4,roughness:.6,glow:.8,fog:.8,speed:1.2}},{name:"Glacier Gates",values:{cliff_height:28,width:6,palette:1,terraces:.85,arches:1,altitude:1.2,fog:.3,fov:1.6}}],shader:`
float esCenter(float z) { return sin(z * 0.026) * 9.0 + sin(z * 0.064) * 2.0; }
float esRidges(vec2 p) {
    float sum = 0.0, amp = 0.55, norm = 0.0;
    for (int i = 0; i < 5; i++) {
        float n = 1.0 - abs(esNoise(p) * 2.0 - 1.0);
        sum += n * n * amp;
        norm += amp;
        p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.07 + 7.1;
        amp *= u_roughness;
    }
    return sum / norm;
}
vec3 esPath(float z) {
    return vec3(esCenter(z) + sin(z * 0.041) * u_sway * 0.8, 2.0 + u_altitude * 4.0 + sin(z * 0.023) * 0.5, z);
}
vec2 esMap(vec3 p) {
    float x = p.x - esCenter(p.z);
    float relief = esRidges(p.yz * 0.095 + u_seed_vec.xy * 3.0);
    float channel = u_width + relief * 3.5;
    float height = u_cliff_height * (0.55 + 0.45 * esRidges(p.xz * 0.032 + 2.0));
    float stepped = (floor(height * 0.4) + smoothstep(0.15, 0.85, fract(height * 0.4))) * 2.5;
    height = mix(height, stepped, u_terraces);
    // Intersection of the outside of the winding gorge and a ridged cap.
    // Small conservative factors cover both noise slope and path curvature.
    float wall = max((channel - abs(x)) * 0.18, (p.y - height) * 0.14);
    if (u_arches > 0.001) {
        float az = mod(p.z + 24.0, 48.0) - 24.0;
        float arch = abs(length(vec2(x * 0.65, p.y - 5.5)) - u_cliff_height * 0.52) - u_arches * 1.2;
        arch = max(max(arch, 5.5 - p.y), abs(az) - u_arches * 2.3);
        wall = min(wall, arch * 0.5);
    }
    // This clearance stays positive on every supported camera path.
    wall = max(wall, (1.4 - length(p.xy - esPath(p.z).xy)) * 0.6);
    float river = p.y + 0.15;
    return river < wall ? vec2(river, 1.0) : vec2(wall, 2.0);
}
float esTone(vec3 p, vec3 n, float material) { return 0.06 + p.y * 0.014 + esNoise(p.yz * 0.25) * 0.10; }
vec3 esEmission(vec3 p, vec3 n, float material) {
    float strata = pow(0.5 + 0.5 * sin(p.y * 1.9 + esNoise(p.xz * 0.04) * 4.0), 32.0);
    return esPalette(p.y * 0.014) * strata * 0.12 * step(1.5, material);
}
`}),o({name:"infinite_lattice",label:"Infinite Lattice",description:"Drift through colossal connected mathematical membranes: Schwarz P, diamond and Neovius nodal surfaces stretching in every direction",constants:"const float ES_INTERIOR = 1.0; const float ES_SPEED = 3.8; const float ES_LOOK_DROP = 0.0;",specialize:["surface"],params:[n.select("surface","Surface Family","Structure",["Schwarz P","Diamond","Neovius"],0),e("cell_size","Structure Scale","Structure",5,16,10,.1),e("thickness","Membrane Thickness","Structure",.04,.45,.16,.01),e("iridescence","Iridescence","Structure",0,1,.75,.01),e("passage","Open Passage","Structure",1.2,3,1.6,.1)],presets:[{name:"Pearl Multiverse",values:{surface:0,cell_size:12,palette:5,thickness:.13,glow:.7,fog:.45,speed:.7}},{name:"Diamond Expanse",values:{surface:1,cell_size:14,palette:1,thickness:.1,glow:.8,fog:.35,detail:190}},{name:"Neovius Dream",values:{surface:2,cell_size:10,palette:2,thickness:.25,glow:1.1,detail:220,fog:.55}},{name:"Emerald Continuum",values:{surface:0,cell_size:8,palette:3,thickness:.3,passage:2,speed:1.25,iridescence:1}}],shader:`
vec3 esPath(float z) {
    float invFreq = u_cell_size / 6.283185;
    vec3 phase = u_seed_vec.xyz * 1.2;
    vec2 q = vec2(sin(z * 0.055) * u_sway * 0.32,
                  (u_altitude - 1.0) * 0.35 + cos(z * 0.037) * u_sway * 0.16);
    // Follow the natural connected chambers rather than continually boring
    // a circular tunnel through their walls. Clearance is a fallback only.
    // Diamond: x+z = pi/2, y=0 gives a field value of exactly one.
    if (u_surface >= 0.5 && u_surface < 1.5) {
        q = vec2(1.570796 - z / invFreq - phase.z,
                 (u_altitude - 1.0) * 0.18 + sin(z * 0.037) * u_sway * 0.07);
    } else if (u_surface >= 1.5) {
        // Neovius: x=z, y=0 gives 4*cos(z)^2+6*cos(z)+3 >= 3/4.
        q = vec2(z / invFreq + phase.z,
                 (u_altitude - 1.0) * 0.15 + sin(z * 0.037) * u_sway * 0.06);
    }
    return vec3((q - phase.xy) * invFreq, z);
}
vec2 esMap(vec3 p) {
    float freq = 6.283185 / u_cell_size;
    vec3 q = p * freq + u_seed_vec.xyz * 1.2;
    vec3 c = cos(q), s = sin(q);
    float field = c.x + c.y + c.z;
    float bound = 1.733;
    if (u_surface >= 0.5 && u_surface < 1.5) {
        field = s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z;
        bound = 3.465;
    } else if (u_surface >= 1.5) {
        field = 3.0 * (c.x + c.y + c.z) + 4.0 * c.x * c.y * c.z;
        bound = 12.125;
    }
    // These are nodal approximations, with global gradient bounds; not an
    // assertion that a cosine level set is an exact minimal surface.
    float membrane = (abs(field) - u_thickness * (u_surface > 1.5 ? 1.5 : 1.0)) / (bound * freq);
    float clear = u_passage - length(p.xy - esPath(p.z).xy);
    return vec2(max(membrane, clear * 0.8), 2.0);
}
float esTone(vec3 p, vec3 n, float material) {
    return 0.1 + (dot(n, vec3(0.3, 0.4, 0.5)) + p.y * 0.04) * u_iridescence;
}
vec3 esEmission(vec3 p, vec3 n, float material) {
    float edges = pow(1.0 - abs(n.y), 4.0);
    return esPalette(0.1 + dot(n, vec3(0.2, 0.3, 0.5))) * (0.08 + edges * 0.35);
}
`}),{names:f,register:o,range:e,paletteShader:_}})()}}export{x as default};
