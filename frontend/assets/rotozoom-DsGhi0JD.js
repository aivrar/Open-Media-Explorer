function o(e){return e.EffectRegistry.register({name:"rotozoom",label:"Rotozoom",category:"Demoscene",description:"Hypnotic rotating and zooming tiled pattern",params:[{name:"rot_speed",label:"Rotation Speed",min:.1,max:3,default:.5,step:.1},{name:"zoom_speed",label:"Zoom Speed",min:.1,max:3,default:.7,step:.1},{name:"pattern",label:"Pattern",type:"select",options:["Checkerboard","Circles","Diamonds","Waves","Noise"],default:0},{name:"scale",label:"Scale",min:1,max:20,default:8,step:.5},{name:"color_speed",label:"Color Speed",min:0,max:2,default:.5,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_rot_speed;
uniform float u_zoom_speed;
uniform float u_pattern;
uniform float u_scale;
uniform float u_color_speed;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);

    float angle = u_time * u_rot_speed + seedPhase();
    float zoom = 1.0 + 0.5 * sin(u_time * u_zoom_speed);

    // Rotate and zoom
    mat2 m = rot2(angle) * (1.0 / zoom);
    vec2 p = m * uv * u_scale;

    float val = 0.0;
    int pat = int(u_pattern);

    if (pat == 0) {
        // Checkerboard
        val = mod(floor(p.x) + floor(p.y), 2.0);
    } else if (pat == 1) {
        // Circles
        vec2 fp = fract(p) - 0.5;
        val = step(length(fp), 0.35);
    } else if (pat == 2) {
        // Diamonds
        vec2 fp = fract(p) - 0.5;
        val = step(abs(fp.x) + abs(fp.y), 0.4);
    } else if (pat == 3) {
        // Waves
        val = sin(p.x + sin(p.y * 2.0 + u_time)) * 0.5 + 0.5;
    } else {
        // Noise
        val = snoise(vec3(p * 0.5, u_time * 0.3)) * 0.5 + 0.5;
    }

    float hue = fract(val * 0.5 + u_time * u_color_speed * 0.1 + length(uv) * 0.2);
    vec3 col = hsv2rgb(vec3(hue, 0.7, 0.3 + val * 0.7));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
