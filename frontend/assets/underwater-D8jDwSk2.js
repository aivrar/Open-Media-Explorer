function t(e){return e.EffectRegistry.register({name:"underwater",label:"Underwater",category:"Nature",description:"Sun shafts, dancing caustics on the sand and drifting plankton under the sea",params:[{name:"look",label:"Look Up / Down",min:-.5,max:.6,default:.05,step:.01},{name:"caustics",label:"Caustics",min:0,max:2,default:1,step:.01},{name:"caustic_scale",label:"Caustic Size",min:.3,max:3,default:1,step:.01},{name:"rays",label:"Light Shafts",min:0,max:2,default:1,step:.01},{name:"plankton",label:"Plankton",min:0,max:2,default:1,step:.01},{name:"current",label:"Current",min:0,max:3,default:.6,step:.01},{name:"depth",label:"Murkiness",min:0,max:1,default:.45,step:.01},{name:"scheme",label:"Water",type:"select",options:["Tropical","Deep Blue","Kelp Green","Night Dive"],default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_look;
uniform float u_caustics;
uniform float u_caustic_scale;
uniform float u_rays;
uniform float u_plankton;
uniform float u_current;
uniform float u_depth;
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

// Caustic net: distance between the two nearest moving cell points, so the
// cell borders form bright, wobbling lines.
float causticNet(vec2 p, float t) {
    p += vec2(sin(p.y * 0.9 + t * 0.7), cos(p.x * 0.8 - t * 0.6)) * 0.35;
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 h = hash3(i + g).xy;
            vec2 o = 0.5 + 0.42 * sin(t * (0.6 + h * 0.5) + h * 6.28318);
            float d = length(g + o - f);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
    }
    return smoothstep(0.16, 0.0, d2 - d1);
}

void waterColors(out vec3 shallow, out vec3 deep, out vec3 sand, out vec3 sun) {
    float s = floor(u_scheme + 0.5);
    if (s < 0.5) { shallow = vec3(0.1, 0.65, 0.75); deep = vec3(0.0, 0.18, 0.32); sand = vec3(0.85, 0.75, 0.55); sun = vec3(1.0, 0.98, 0.85); }
    else if (s < 1.5) { shallow = vec3(0.05, 0.35, 0.7); deep = vec3(0.0, 0.05, 0.18); sand = vec3(0.55, 0.6, 0.65); sun = vec3(0.8, 0.9, 1.0); }
    else if (s < 2.5) { shallow = vec3(0.2, 0.55, 0.35); deep = vec3(0.02, 0.12, 0.08); sand = vec3(0.55, 0.55, 0.35); sun = vec3(0.95, 1.0, 0.75); }
    else { shallow = vec3(0.03, 0.12, 0.3); deep = vec3(0.0, 0.01, 0.05); sand = vec3(0.3, 0.32, 0.4); sun = vec3(0.6, 0.75, 1.0); }
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float react = u_audio_react;
    float bass = u_audio.x * react;
    float kick = u_beat.x * react;
    float hat = u_beat.z * react;
    float t = u_time;
    vec3 shallow, deep, sand, sun;
    waterColors(shallow, deep, sand, sun);

    vec3 rd = normalize(vec3(uv.x, uv.y + u_look, 1.2));
    float sway = sin(t * 0.3) * 0.05;
    rd.xz *= rot2(sway);
    float drift = t * u_current;
    float camH = 2.2;

    // Water colour: brighter towards the surface.
    float up = clamp(rd.y * 0.8 + 0.5, 0.0, 1.0);
    vec3 col = mix(deep, shallow, pow(up, 1.4));

    if (rd.y < -0.02) {
        // Sand floor with caustics, fading into the fog.
        float tt = camH / -rd.y;
        vec2 fp = vec2(rd.x, rd.z) * tt + vec2(0.0, drift * 0.6);
        float ripples = 0.85 + 0.15 * vnoise(fp * 1.5) + 0.06 * sin(fp.x * 6.0 + vnoise(fp * 0.7) * 6.0);
        vec3 floorCol = sand * ripples * 0.55;
        float cs = 1.6 / u_caustic_scale;
        float c = causticNet(fp * cs, t * 1.2) * 0.7 + causticNet(fp * cs * 1.9 + 4.0, t * 1.5) * 0.4;
        floorCol += sun * c * u_caustics * (0.8 + bass * 0.8) * 0.9;
        float fog = 1.0 - exp(-tt * (0.05 + u_depth * 0.12));
        col = mix(floorCol, col, fog);
    } else {
        // The surface overhead: a rippling bright sheet with the sun window.
        float tt = (3.0 - 0.0) / max(rd.y, 0.02);
        vec2 sp = vec2(rd.x, rd.z) * tt * 0.4 + vec2(drift * 0.3, t * 0.2);
        float wave = vnoise(sp * 2.0 + t * 0.4) * 0.6 + vnoise(sp * 5.0 - t * 0.6) * 0.4;
        float surf = smoothstep(0.15, 0.6, rd.y) * (0.35 + 0.65 * wave);
        float window = pow(max(dot(rd, normalize(vec3(0.15, 1.0, 0.4))), 0.0), 18.0);
        col += sun * (surf * 0.35 + window * (1.2 + 0.6 * wave));
    }

    // Light shafts: slanted bands that fade with depth.
    float shafts = 0.0;
    vec2 sd = vec2(uv.x + uv.y * 0.35, uv.y);
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float band = sd.x * (4.0 + fi * 3.0) + sin(t * (0.2 + fi * 0.13) + fi * 2.0) * 1.5 + vnoise(vec2(sd.x * 3.0, t * 0.15 + fi)) * 2.0;
        shafts += pow(0.5 + 0.5 * sin(band), 6.0 + fi * 4.0) * (0.6 - fi * 0.15);
    }
    shafts *= smoothstep(-0.6, 0.5, uv.y) * u_rays * (0.6 + kick * 1.2);
    col += sun * shafts * 0.35;

    // Plankton drifting in three layers (parallax by depth).
    for (int l = 0; l < 3; l++) {
        float fl = float(l);
        float scale = 14.0 + fl * 12.0;
        vec2 pp = uv * scale + vec2(drift * (0.6 + fl * 0.4), t * 0.15 * (1.0 + fl)) + fl * 13.7;
        vec2 id = floor(pp);
        float h = hash2(id + fl * 7.0);
        if (h > 0.9) {
            vec2 o = vec2(hash2(id + 3.0), hash2(id + 5.0)) - 0.5;
            o += vec2(sin(t * 0.7 + h * 20.0), cos(t * 0.5 + h * 30.0)) * 0.15;
            float d = length(fract(pp) - 0.5 - o * 0.6);
            float tw = 0.6 + 0.4 * sin(t * 3.0 + h * 50.0) + hat * 0.8;
            col += mix(shallow, vec3(1.0), 0.6) * smoothstep(0.09 - fl * 0.02, 0.0, d) * u_plankton * tw * (0.5 - fl * 0.12);
        }
    }

    // Vignette towards the murk at the edges.
    col *= 1.0 - 0.35 * dot(uv, uv);
    col = 1.0 - exp(-col * 1.4);
    FRAG_OUT = vec4(pow(col, vec3(0.95)), 1.0);
}
`}),{}}export{t as default};
