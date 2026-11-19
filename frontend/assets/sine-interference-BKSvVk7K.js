function o(e){return e.EffectRegistry.register({name:"sine_interference",label:"Sine Interference",category:"Math",description:"Pulsating concentric rings and beating interference patterns",params:[{name:"speed",label:"Speed",min:.1,max:5,default:1.5,step:.1},{name:"sources",label:"Sources",min:2,max:8,default:4,step:1,type:"int"},{name:"frequency",label:"Frequency",min:5,max:50,default:20,step:1,type:"int"},{name:"color_mode",label:"Color",type:"select",options:["Rainbow","BW","Neon","Thermal"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_sources;
uniform float u_frequency;
uniform float u_color_mode;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();

    float val = 0.0;
    for (float i = 0.0; i < 8.0; i++) {
        if (i >= u_sources) break;
        float angle = i / u_sources * 6.28318 + t * 0.2;
        float r = 0.3 + 0.1 * sin(t * 0.5 + i * 2.0);
        vec2 center = vec2(cos(angle), sin(angle)) * r;
        float d = length(uv - center);
        val += sin(d * u_frequency - t * 2.0 + i * 0.5);
    }

    val = val / u_sources * 0.5 + 0.5;

    int mode = int(u_color_mode);
    vec3 col;
    if (mode == 0) col = rainbow(val + t * 0.02);
    else if (mode == 1) col = vec3(val);
    else if (mode == 2) col = neon(val);
    else col = mix(vec3(0.0, 0.0, 0.2), mix(vec3(1.0, 0.3, 0.0), vec3(1.0, 1.0, 0.5), val), val);

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
