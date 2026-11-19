function a(e){return e.EffectRegistry.register({name:"fbm",label:"Fractal Brownian Motion",category:"Noise",description:"Multi-octave noise creating organic cloud and terrain textures",params:[{name:"speed",label:"Speed",min:.05,max:1,default:.3,step:.05},{name:"scale",label:"Scale",min:.5,max:6,default:2,step:.5},{name:"octaves",label:"Octaves",min:1,max:8,default:6,step:1,type:"int"},{name:"lacunarity",label:"Lacunarity",min:1.5,max:3,default:2,step:.1},{name:"gain",label:"Gain",min:.3,max:.7,default:.5,step:.05},{name:"ridged",label:"Ridged",min:0,max:1,default:0},{name:"color_mode",label:"Color",type:"select",options:["Psychedelic","Terrain","Clouds","Magma","Abstract"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_scale;
uniform float u_octaves;
uniform float u_lacunarity;
uniform float u_gain;
uniform float u_ridged;
uniform float u_color_mode;

float customFbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float freq = 1.0;
    for (float i = 0.0; i < 8.0; i++) {
        if (i >= u_octaves) break;
        float n = snoise(p * freq);
        if (u_ridged > 0.5) {
            n = 1.0 - abs(n); // Ridged
            n = n * n;
        }
        value += amplitude * n;
        freq *= u_lacunarity;
        amplitude *= u_gain;
    }
    return value;
}

void main() {
    vec2 uv = v_uv * u_scale + seedOffset() * 0.1;
    float t = u_time * u_speed + seedPhase();

    float n = customFbm(vec3(uv, t));

    int mode = int(u_color_mode);
    vec3 col;

    if (mode == 0) {
        col = rainbow(n * 0.5 + 0.5 + t * 0.03);
        col *= 0.7 + 0.3 * n;
    } else if (mode == 1) {
        float v = n * 0.5 + 0.5;
        if (v < 0.3) col = mix(vec3(0.0, 0.1, 0.4), vec3(0.0, 0.3, 0.6), v / 0.3);
        else if (v < 0.4) col = mix(vec3(0.0, 0.3, 0.6), vec3(0.8, 0.7, 0.4), (v-0.3)/0.1);
        else if (v < 0.6) col = mix(vec3(0.2, 0.5, 0.1), vec3(0.1, 0.3, 0.0), (v-0.4)/0.2);
        else if (v < 0.8) col = mix(vec3(0.4, 0.3, 0.2), vec3(0.6, 0.5, 0.4), (v-0.6)/0.2);
        else col = mix(vec3(0.7, 0.7, 0.7), vec3(1.0, 1.0, 1.0), (v-0.8)/0.2);
    } else if (mode == 2) {
        float v = n * 0.5 + 0.5;
        col = mix(vec3(0.3, 0.5, 0.85), vec3(1.0), pow(v, 2.0));
    } else if (mode == 3) {
        float v = n * 0.5 + 0.5;
        col = mix(vec3(0.1, 0.0, 0.0), mix(vec3(0.8, 0.2, 0.0), vec3(1.0, 0.9, 0.3), v), pow(v, 1.5));
    } else {
        float v = n;
        col = vec3(
            sin(v * 3.0 + t) * 0.5 + 0.5,
            sin(v * 5.0 + t * 1.3 + 2.0) * 0.5 + 0.5,
            sin(v * 7.0 + t * 0.7 + 4.0) * 0.5 + 0.5
        );
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
