function t(e){return e.EffectRegistry.register({name:"tunnel",label:"Tunnel",category:"Demoscene",description:"Classic demoscene tunnel - flying through an infinite psychedelic tube",params:[{name:"speed",label:"Speed",min:.1,max:5,default:1.5,step:.1},{name:"twist",label:"Twist",min:0,max:5,default:1,step:.1},{name:"rings",label:"Ring Density",min:1,max:20,default:5,step:1,type:"int"},{name:"segments",label:"Segments",min:1,max:16,default:6,step:1,type:"int"},{name:"color_shift",label:"Color Shift",min:0,max:2,default:.5,step:.05},{name:"wobble",label:"Wobble",min:0,max:2,default:.5,step:.1}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_twist;
uniform float u_rings;
uniform float u_segments;
uniform float u_color_shift;
uniform float u_wobble;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t_base = u_time + seedPhase();

    // Wobble center
    vec2 center = vec2(
        sin(t_base * 0.7) * u_wobble * 0.3,
        cos(t_base * 0.9) * u_wobble * 0.3
    );
    uv -= center;

    float angle = atan(uv.y, uv.x);
    float dist = length(uv);

    // Tunnel mapping
    float depth = 1.0 / (dist + 0.001);
    float u = angle / 3.14159 * u_segments + t_base * u_twist * 0.5;
    float v = depth * u_rings + t_base * u_speed;

    // Checker-like pattern
    float pattern = sin(u * 3.14159) * sin(v * 3.14159);

    // Color
    float hue = fract(angle / 6.28318 + t_base * u_color_shift * 0.1 + depth * 0.05);
    float sat = 0.7 + 0.3 * pattern;
    float val = (0.5 + 0.5 * pattern) * smoothstep(0.0, 0.3, dist);

    // Depth fog
    val *= exp(-dist * 0.3);
    val *= 1.0 - exp(-depth * 2.5);

    vec3 col = hsv2rgb(vec3(hue, sat, val));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
