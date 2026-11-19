function t(e){return e.EffectRegistry.register({name:"moire",label:"Moire Patterns",category:"Demoscene",description:"Shimmering interference patterns from overlapping ring structures",params:[{name:"speed",label:"Speed",min:.1,max:3,default:.8,step:.1},{name:"ring_width",label:"Ring Width",min:.5,max:10,default:3,step:.5},{name:"centers",label:"Centers",min:2,max:6,default:3,step:1,type:"int"},{name:"color_speed",label:"Color Speed",min:0,max:2,default:.3,step:.05},{name:"mode",label:"Mode",type:"select",options:["Rings","Lines","Mixed"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_ring_width;
uniform float u_centers;
uniform float u_color_speed;
uniform float u_mode;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();

    float val = 0.0;
    int mode = int(u_mode);

    for (float i = 0.0; i < 6.0; i++) {
        if (i >= u_centers) break;

        float angle = i * 6.28318 / u_centers + t * (0.3 + i * 0.1);
        float r = 0.3 + 0.15 * sin(t * 0.5 + i * 2.0);
        vec2 center = vec2(cos(angle), sin(angle)) * r;

        if (mode == 0 || (mode == 2 && i < u_centers * 0.5)) {
            // Rings
            float d = length(uv - center) * u_ring_width * 10.0;
            val += sin(d) * 0.5 + 0.5;
        } else {
            // Lines
            float a = t * 0.3 + i;
            vec2 dir = vec2(cos(a), sin(a));
            float d = dot(uv - center, dir) * u_ring_width * 10.0;
            val += sin(d) * 0.5 + 0.5;
        }
    }

    val /= u_centers;

    float hue = fract(val + u_time * u_color_speed * 0.1);
    vec3 col = hsv2rgb(vec3(hue, 0.7, val));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
