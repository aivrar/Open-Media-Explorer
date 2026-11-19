function t(e){return e.EffectRegistry.register({name:"julia",label:"Julia Set",category:"Fractals",description:"Morphing Julia set fractals that smoothly transform between organic shapes",params:[{name:"morph_speed",label:"Morph Speed",min:.05,max:2,default:.3,step:.05},{name:"zoom",label:"Zoom",min:.5,max:5,default:1.5,step:.1},{name:"max_iter",label:"Max Iterations",min:50,max:400,default:200,step:10,type:"int"},{name:"color_speed",label:"Color Cycle",min:0,max:8,default:.5,step:.05},{name:"orbit_radius",label:"Orbit Radius",min:.1,max:1.2,default:.7885,step:.01},{name:"palette_type",label:"Palette",type:"select",palette:!0,options:["Rainbow Veil","Electric Orchid","Deep Ocean","Amber Glass","Mint Ruby","Mono Plasma"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_morph_speed;
uniform float u_zoom;
uniform float u_max_iter;
uniform float u_color_speed;
uniform float u_orbit_radius;
uniform float u_palette_type;

vec3 juliaPalette(float t) {
    t = fract(t);
    if (u_palette_type > 5.5) return psyLut(t);
    if (u_palette_type < 0.5) return rainbow(t);
    if (u_palette_type < 1.5) return palette(t, vec3(0.28,0.08,0.42), vec3(0.60,0.22,0.68), vec3(0.95,0.38,1.0), vec3(0.08,0.42,0.62));
    if (u_palette_type < 2.5) return palette(t, vec3(0.02,0.12,0.26), vec3(0.20,0.48,0.72), vec3(0.42,0.84,1.0), vec3(0.56,0.24,0.04));
    if (u_palette_type < 3.5) return palette(t, vec3(0.34,0.18,0.06), vec3(0.66,0.42,0.16), vec3(1.0,0.72,0.32), vec3(0.04,0.20,0.42));
    if (u_palette_type < 4.5) return palette(t, vec3(0.10,0.26,0.18), vec3(0.54,0.34,0.40), vec3(0.50,1.0,0.72), vec3(0.92,0.12,0.28));
    return palette(t, vec3(0.28), vec3(0.58), vec3(0.88,0.92,1.0), vec3(0.0,0.08,0.18));
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    // Larger values consistently mean a closer view across fractal effects.
    uv *= 4.5 / max(u_zoom, 0.05);

    float t = u_time * u_morph_speed + seedPhase();
    vec2 c = vec2(u_orbit_radius * cos(t), u_orbit_radius * sin(t));

    vec2 z = uv;
    float iter = 0.0;
    float maxI = u_max_iter;
    float escaped = 0.0;

    for (float i = 0.0; i < 400.0; i++) {
        if (i >= maxI) break;
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
        iter = i + 1.0;
        if (dot(z, z) > 256.0) {
            escaped = 1.0;
            break;
        }
    }

    vec3 col = vec3(0.0);
    if (escaped > 0.5) {
        float sl = iter + 1.0 - log(log(max(length(z), 1.000001))) / log(2.0);
        // Log scaling spreads the palette over the fast-escaping outer region,
        // which used to collapse into one flat background colour.
        float val = log(sl + 1.0) / log(maxI + 1.0);
        col = juliaPalette(val * 2.6 + u_time * u_color_speed * 0.1);
        col *= 0.55 + 0.45 * smoothstep(0.05, 0.6, val);
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
