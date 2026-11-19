function t(e){return e.EffectRegistry.register({name:"lyapunov",label:"Lyapunov Fractal",category:"Fractals",description:"Stability map of logistic sequences - creates wild organic boundaries between order and chaos",params:[{name:"sequence_len",label:"Sequence",type:"select",options:["AB","AABB","AAB","AAABB","ABBA","AABAB","ABBAAB","AABABB","ABBABA"],default:1},{name:"max_iter",label:"Iterations",min:20,max:200,default:80,step:10,type:"int"},{name:"warmup",label:"Warmup",min:10,max:100,default:30,step:5,type:"int"},{name:"zoom",label:"Zoom",min:0,max:10,default:1,step:.05},{name:"center_x",label:"Center X",min:0,max:4,default:2.5,step:.05},{name:"center_y",label:"Center Y",min:0,max:4,default:3,step:.05},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"animate",label:"Animate",min:0,max:1,default:.2,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_sequence_len;
uniform float u_max_iter;
uniform float u_warmup;
uniform float u_zoom;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_color_speed;
uniform float u_animate;

// Sequences encoded as bit patterns
bool getSeqBit(int seqId, int idx) {
    // AB=01, AABB=0011, AAB=001, AAABB=00011, ABBA=0110,
    // AABAB=00101, ABBAAB=011001, AABABB=001011, ABBABA=011010
    if (seqId == 0) return mod(float(idx), 2.0) > 0.5; // AB
    if (seqId == 1) return mod(float(idx), 4.0) > 1.5; // AABB
    if (seqId == 2) { int m = int(mod(float(idx), 3.0)); return m == 2; } // AAB
    if (seqId == 3) { int m = int(mod(float(idx), 5.0)); return m >= 3; } // AAABB
    if (seqId == 4) { int m = int(mod(float(idx), 4.0)); return m == 1 || m == 2; } // ABBA
    if (seqId == 5) { int m = int(mod(float(idx), 5.0)); return m == 2 || m == 4; } // AABAB
    if (seqId == 6) { int m = int(mod(float(idx), 6.0)); return m == 1 || m == 2 || m == 5; } // ABBAAB
    if (seqId == 7) { int m = int(mod(float(idx), 6.0)); return m == 2 || m == 4 || m == 5; } // AABABB
    int m = int(mod(float(idx), 6.0)); return m == 1 || m == 2 || m == 4; // ABBABA
}

void main() {
    vec2 centered = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float zoomValue = max(u_zoom, 0.0);
    float span = 4.0 / exp2(zoomValue * 0.80);
    float centerBlend = smoothstep(0.0, 0.35, zoomValue);
    vec2 center = mix(vec2(2.0), vec2(u_center_x, u_center_y), centerBlend);
    vec2 uv = center + centered * span;

    // Animation
    uv += vec2(sin(u_time * 0.2), cos(u_time * 0.15)) * u_animate * span * 0.08;

    float domainMask =
        smoothstep(-0.12, 0.02, uv.x) *
        smoothstep(-0.12, 0.02, uv.y) *
        (1.0 - smoothstep(4.02, 4.16, uv.x)) *
        (1.0 - smoothstep(4.02, 4.16, uv.y));
    uv = clamp(uv, vec2(0.0), vec2(4.0));

    float a = uv.x;
    float b = uv.y;

    int seqId = int(u_sequence_len);

    // Logistic map iteration
    float x = 0.5;
    float lyap = 0.0;

    // Warmup
    for (float i = 0.0; i < 100.0; i++) {
        if (i >= u_warmup) break;
        float r = getSeqBit(seqId, int(i)) ? b : a;
        x = r * x * (1.0 - x);
    }

    // Compute Lyapunov exponent
    for (float i = 0.0; i < 200.0; i++) {
        if (i >= u_max_iter) break;
        float r = getSeqBit(seqId, int(i + u_warmup)) ? b : a;
        x = r * x * (1.0 - x);
        float deriv = abs(r * (1.0 - 2.0 * x));
        if (deriv > 0.0) lyap += log(deriv);
    }

    lyap /= u_max_iter;

    vec3 col;
    if (lyap < 0.0) {
        // Stable (negative exponent) - color by magnitude
        float v = clamp(-lyap * 0.5, 0.0, 1.0);
        float hue = fract(v * 0.6 + 0.55 + u_time * u_color_speed * 0.05);
        col = hsv2rgb(vec3(hue, 0.8, v));
    } else {
        // Chaotic (positive exponent)
        float v = clamp(lyap * 0.3, 0.0, 1.0);
        float hue = fract(v * 0.3 + u_time * u_color_speed * 0.05);
        col = hsv2rgb(vec3(hue, 0.5, v * 0.8));
    }

    vec3 bg = vec3(0.006, 0.008, 0.014) + hsv2rgb(vec3(0.58 + u_time * 0.01, 0.35, 0.10)) * 0.16;
    col = mix(bg, col, domainMask);

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
