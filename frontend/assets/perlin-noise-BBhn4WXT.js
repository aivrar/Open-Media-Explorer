function o(e){return e.EffectRegistry.register({name:"perlin",label:"Perlin Noise",category:"Noise",description:"Smooth organic evolving cloud and smoke patterns",params:[{name:"speed",label:"Speed",min:.1,max:3,default:.5,step:.1},{name:"scale",label:"Scale",min:.5,max:10,default:3,step:.5},{name:"octaves",label:"Octaves",min:1,max:8,default:5,step:1,type:"int"},{name:"contrast",label:"Contrast",min:.5,max:3,default:1.5,step:.1},{name:"color_mode",label:"Color Mode",type:"select",options:["Rainbow","Smoke","Lava","Ocean","Aurora"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_scale;
uniform float u_octaves;
uniform float u_contrast;
uniform float u_color_mode;

float fbmN(vec3 p, float octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    for (float i = 0.0; i < 8.0; i++) {
        if (i >= octaves) break;
        value += amplitude * snoise(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec2 uv = v_uv * u_scale + seedOffset() * 0.1;
    float t = u_time * u_speed + seedPhase();

    float n = fbmN(vec3(uv, t), u_octaves);
    n = n * u_contrast;

    int mode = int(u_color_mode);
    vec3 col;

    if (mode == 0) {
        col = rainbow(n * 0.5 + 0.5 + t * 0.05);
    } else if (mode == 1) {
        float v = n * 0.5 + 0.5;
        col = vec3(v * v);
    } else if (mode == 2) {
        float v = n * 0.5 + 0.5;
        col = mix(vec3(0.1, 0.0, 0.0), mix(vec3(0.8, 0.2, 0.0), vec3(1.0, 0.9, 0.3), v), v);
    } else if (mode == 3) {
        float v = n * 0.5 + 0.5;
        col = mix(vec3(0.0, 0.05, 0.15), mix(vec3(0.0, 0.3, 0.6), vec3(0.3, 0.8, 1.0), v), v);
    } else {
        // Aurora
        float v = n * 0.5 + 0.5;
        vec3 c1 = vec3(0.0, 0.8, 0.4);
        vec3 c2 = vec3(0.1, 0.3, 0.8);
        vec3 c3 = vec3(0.8, 0.2, 0.8);
        col = mix(c1, mix(c2, c3, v), v) * (0.5 + v);
        col += vec3(0.05) * (1.0 - abs(uv.y / u_scale - 0.5));
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
