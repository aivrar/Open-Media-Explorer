function t(e){return e.EffectRegistry.register({name:"domainwarp",label:"Domain Warp",category:"Noise",description:"Nested noise creates alien landscapes and marbled paint effects",params:[{name:"speed",label:"Speed",min:.05,max:1,default:.2,step:.05},{name:"scale",label:"Scale",min:.5,max:5,default:2,step:.5},{name:"warp_strength",label:"Warp Strength",min:.5,max:5,default:2,step:.1},{name:"iterations",label:"Warp Depth",min:1,max:4,default:2,step:1,type:"int"},{name:"color_mode",label:"Color",type:"select",options:["Marble","Psychedelic","Earth","Alien","Neon"],default:1}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_scale;
uniform float u_warp_strength;
uniform float u_iterations;
uniform float u_color_mode;

void main() {
    vec2 uv = v_uv * u_scale + seedOffset() * 0.1;
    float t = u_time * u_speed + seedPhase();

    vec2 p = uv;

    // Nested domain warping
    vec2 q = vec2(
        fbm(vec3(p, t)),
        fbm(vec3(p + vec2(5.2, 1.3), t))
    );

    vec2 r = p;
    if (u_iterations >= 2.0) {
        r = vec2(
            fbm(vec3(p + u_warp_strength * q + vec2(1.7, 9.2), t * 0.8)),
            fbm(vec3(p + u_warp_strength * q + vec2(8.3, 2.8), t * 0.8))
        );
    }

    vec2 s = r;
    if (u_iterations >= 3.0) {
        s = vec2(
            fbm(vec3(p + u_warp_strength * r + vec2(3.1, 7.4), t * 0.6)),
            fbm(vec3(p + u_warp_strength * r + vec2(6.7, 4.1), t * 0.6))
        );
    }

    if (u_iterations >= 4.0) {
        s = vec2(
            fbm(vec3(p + u_warp_strength * s + vec2(2.3, 8.1), t * 0.4)),
            fbm(vec3(p + u_warp_strength * s + vec2(9.1, 3.5), t * 0.4))
        );
    }

    float f = fbm(vec3(p + u_warp_strength * s, t));

    int mode = int(u_color_mode);
    vec3 col;

    if (mode == 0) {
        // Marble
        float v = f * 0.5 + 0.5;
        col = mix(vec3(0.9, 0.85, 0.8), vec3(0.2, 0.15, 0.1), pow(v, 2.0));
        col = mix(col, vec3(0.4, 0.3, 0.25), length(q) * 0.5);
    } else if (mode == 1) {
        // Psychedelic
        col = rainbow(f * 0.3 + length(q) * 0.3 + length(r) * 0.2 + t * 0.03);
        col *= 0.7 + 0.3 * f;
    } else if (mode == 2) {
        // Earth
        float v = f * 0.5 + 0.5;
        col = mix(vec3(0.1, 0.3, 0.1), mix(vec3(0.6, 0.5, 0.3), vec3(0.9, 0.85, 0.7), v), v);
    } else if (mode == 3) {
        // Alien
        col = mix(vec3(0.0, 0.1, 0.2), vec3(0.0, 0.8, 0.4), f * 0.5 + 0.5);
        col += vec3(0.4, 0.0, 0.6) * length(q) * 0.5;
    } else {
        // Neon
        col = neon(f * 0.5 + 0.5 + t * 0.05);
        col *= 1.0 + length(q) * 0.3;
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
