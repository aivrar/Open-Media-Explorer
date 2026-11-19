function t(e){return e.EffectRegistry.register({name:"fire",label:"Fire",category:"Demoscene",description:"Realistic procedural flames with customizable palette",params:[{name:"speed",label:"Speed",min:.5,max:5,default:2,step:.1},{name:"intensity",label:"Intensity",min:.5,max:3,default:1.5,step:.1},{name:"detail",label:"Detail",min:1,max:8,default:5,step:1,type:"int"},{name:"wind",label:"Wind",min:-2,max:2,default:0,step:.1},{name:"palette_mode",label:"Palette",type:"select",options:["Classic Fire","Blue Fire","Green Toxic","Purple Magic","Rainbow"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_intensity;
uniform float u_detail;
uniform float u_wind;
uniform float u_palette_mode;

// Heat ramp: black -> a (embers) -> b (flame) -> c (hot core). Piecewise so
// the middle stays a saturated flame colour instead of going brown.
vec3 heatRamp(float t, vec3 a, vec3 b, vec3 c) {
    if (t < 0.35) return a * smoothstep(0.0, 0.35, t);
    if (t < 0.7) return mix(a, b, (t - 0.35) / 0.35);
    return mix(b, c, (t - 0.7) / 0.3);
}

vec3 fireColor(float t, int mode) {
    t = clamp(t, 0.0, 1.0);
    if (mode == 0) return heatRamp(t, vec3(0.75, 0.08, 0.0), vec3(1.0, 0.5, 0.02), vec3(1.0, 0.92, 0.55));
    if (mode == 1) return heatRamp(t, vec3(0.02, 0.12, 0.75), vec3(0.05, 0.55, 1.0), vec3(0.75, 0.92, 1.0));
    if (mode == 2) return heatRamp(t, vec3(0.05, 0.45, 0.0), vec3(0.3, 0.9, 0.1), vec3(0.85, 1.0, 0.5));
    if (mode == 3) return heatRamp(t, vec3(0.35, 0.0, 0.55), vec3(0.75, 0.2, 1.0), vec3(1.0, 0.75, 1.0));
    return rainbow(t) * smoothstep(0.0, 0.35, t);
}

void main() {
    vec2 uv = v_uv;
    vec2 noiseUV = uv + seedOffset() * 0.01;
    float t = u_time * u_speed + seedPhase();

    // Fire noise
    // Stretched vertically so the noise forms rising tongues, not blobs.
    vec2 p = noiseUV * vec2(4.5, 1.7);
    p.x += u_wind * sin(uv.y * 3.0 + t);
    p.y -= t * 0.5;

    float noise = 0.0;
    float amp = 1.0;
    float freq = 1.0;
    for (float i = 0.0; i < 8.0; i++) {
        if (i >= u_detail) break;
        noise += amp * snoise(vec3(p * freq, t * 0.3 * freq));
        freq *= 2.0;
        amp *= 0.5;
    }

    // Flame tongues: heat falls off with height and the noise decides how
    // far each tongue reaches, so the top breaks into separate licks and
    // the base flickers instead of being one flat hot band.
    float n01 = clamp(noise * 0.5 + 0.5, 0.0, 1.0);
    float base = 1.0 - uv.y;
    float fire = n01 * u_intensity * 0.75 + 0.35 * base * base * base + 0.02 - uv.y * 1.05;
    fire = clamp(fire, 0.0, 1.0);
    fire = fire * fire * (3.0 - 2.0 * fire);

    vec3 col = fireColor(fire, int(u_palette_mode));
    col += vec3(0.02, 0.01, 0.0) * (1.0 - uv.y); // Ambient glow

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
