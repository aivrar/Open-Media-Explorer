function a(e){return e.EffectRegistry.register({name:"color_cycle",label:"Color Cycling",category:"Color",description:"Classic color palette rotation - static patterns appear to flow and shimmer",params:[{name:"speed",label:"Cycle Speed",min:.1,max:5,default:1,step:.1},{name:"pattern",label:"Pattern",type:"select",options:["Mandala","Landscape","Geometric","Organic","Fractal"],default:0},{name:"palette",label:"Palette",type:"select",options:["Rainbow","Sunset","Ocean","Neon","Pastel"],default:0},{name:"bands",label:"Color Bands",min:4,max:32,default:12,step:1,type:"int"}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_pattern;
uniform float u_palette;
uniform float u_bands;

vec3 getPalette(float t, int pal) {
    if (pal == 0) return rainbow(t);
    if (pal == 1) return palette(t, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(0.8,0.8,0.5), vec3(0.0,0.2,0.5));
    if (pal == 2) return palette(t, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(1.0,1.0,0.5), vec3(0.8,0.9,0.3));
    if (pal == 3) return neon(t);
    return palette(t, vec3(0.8,0.7,0.8), vec3(0.2,0.2,0.2), vec3(1.0,1.0,1.0), vec3(0.0,0.33,0.67));
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();

    float val = 0.0;
    int pat = int(u_pattern);

    if (pat == 0) {
        // Mandala
        float a = atan(uv.y, uv.x);
        float r = length(uv);
        val = sin(a * 6.0) * sin(r * 10.0) + sin(a * 3.0 + r * 5.0);
    } else if (pat == 1) {
        // Landscape
        val = uv.y * 5.0 + sin(uv.x * 3.0) * 2.0;
        val += snoise(vec3(uv * 3.0, 0.0)) * 2.0;
    } else if (pat == 2) {
        // Geometric
        vec2 p = uv * 5.0;
        val = sin(p.x) * sin(p.y) + sin(p.x + p.y) + sin(length(p));
    } else if (pat == 3) {
        // Organic
        val = fbm(vec3(uv * 3.0, 0.0)) * 5.0;
    } else {
        // Fractal
        vec2 z = uv * 2.0;
        vec2 c = vec2(-0.7, 0.27015);
        for (int i = 0; i < 50; i++) {
            z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
            if (dot(z,z) > 4.0) { val = float(i); break; }
        }
    }

    // Quantize to bands and cycle
    val = floor(mod(val * u_bands / 6.28318 + t, u_bands)) / u_bands;

    vec3 col = getPalette(val, int(u_palette));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
