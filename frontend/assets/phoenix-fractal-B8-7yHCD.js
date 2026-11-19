function a(e){return e.EffectRegistry.register({name:"phoenix",label:"Phoenix Fractal",category:"Fractals",description:"Uses previous iteration memory - creates bird-like and feathered structures",params:[{name:"c_real",label:"C Real",min:-1,max:1,default:.5667,step:.001},{name:"c_imag",label:"C Imag",min:-1,max:1,default:0,step:.001},{name:"p_real",label:"Phoenix Real",min:-1,max:1,default:-.5,step:.01},{name:"p_imag",label:"Phoenix Imag",min:-1,max:1,default:0,step:.01},{name:"max_iter",label:"Iterations",min:50,max:500,default:200,step:10,type:"int"},{name:"zoom",label:"Zoom",min:.3,max:5,default:1.5,step:.1},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"morph",label:"Auto Morph",min:0,max:1,default:.3,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_c_real;
uniform float u_c_imag;
uniform float u_p_real;
uniform float u_p_imag;
uniform float u_max_iter;
uniform float u_zoom;
uniform float u_color_speed;
uniform float u_morph;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    uv *= 4.5 / max(u_zoom, 0.05);

    float t = u_time;
    vec2 c = vec2(u_c_real, u_c_imag);
    vec2 p = vec2(u_p_real, u_p_imag);

    if (u_morph > 0.0) {
        // Small swing: the default C sits on the edge between a solid shape and
        // scattered dust, and a wide swing spent most of each cycle in the dust.
        c += vec2(sin(t * 0.2), cos(t * 0.3)) * u_morph * 0.1;
        p += vec2(sin(t * 0.15), cos(t * 0.25)) * u_morph * 0.2;
    }

    // Phoenix iteration: z_{n+1} = z_n^2 + c + p * z_{n-1}
    vec2 z = uv;
    vec2 zPrev = vec2(0.0);
    float iter = 0.0;
    float maxI = u_max_iter;
    float escaped = 0.0;

    for (float i = 0.0; i < 500.0; i++) {
        if (i >= maxI) break;
        vec2 zNew = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c
                   + vec2(p.x*zPrev.x - p.y*zPrev.y, p.x*zPrev.y + p.y*zPrev.x);
        zPrev = z;
        z = zNew;
        iter = i + 1.0;
        if (dot(z, z) > 256.0) {
            escaped = 1.0;
            break;
        }
    }

    vec3 col = vec3(0.0);
    if (escaped > 0.5) {
        float sl = iter + 1.0 - log(log(max(length(z), 1.000001))) / log(2.0);
        float val = sl / maxI;
        col = palette(fract(val * 5.0 + t * u_color_speed * 0.1),
            vec3(0.5), vec3(0.5), vec3(1.0, 0.8, 0.6), vec3(0.3, 0.15, 0.05));
        // Add extra detail glow
        col *= 1.0 + 0.5 * sin(val * 50.0);
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
