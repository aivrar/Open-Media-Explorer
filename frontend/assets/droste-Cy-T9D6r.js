function a(e){return e.EffectRegistry.register({name:"droste",label:"Droste Effect",category:"Distortion",description:"Recursive infinite zoom - an image contains itself at every scale",params:[{name:"speed",label:"Zoom Speed",min:.1,max:3,default:.5,step:.1},{name:"branches",label:"Branches",min:1,max:6,default:1,step:1,type:"int"},{name:"rotation",label:"Twist",min:0,max:3,default:.5,step:.1},{name:"pattern",label:"Pattern",type:"select",options:["Spiral","Squares","Mandala","Noise"],default:0},{name:"color_speed",label:"Color Speed",min:0,max:2,default:.5,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_branches;
uniform float u_rotation;
uniform float u_pattern;
uniform float u_color_speed;

#define PI 3.14159265

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);

    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float t = u_time * u_speed;

    // Log-polar transform for Droste
    float logr = log(r + 0.001);
    float scale = 2.0 * PI / log(2.0);

    // Droste spiral mapping
    float dr = logr * scale - t * 2.0;
    float da = a * u_branches + u_rotation * logr * scale;

    // Periodic in log-r space
    dr = mod(dr, 2.0 * PI);

    // Back to cartesian-like coords for pattern
    vec2 p = vec2(
        cos(da) * dr / PI,
        sin(da) * dr / PI
    );

    int pat = int(u_pattern);
    float val = 0.0;

    if (pat == 0) {
        val = sin(p.x * 5.0 + t) + sin(p.y * 5.0 + t * 0.7);
        val += sin(length(p) * 8.0 - t * 2.0);
    } else if (pat == 1) {
        vec2 g = fract(p * 3.0) - 0.5;
        val = step(max(abs(g.x), abs(g.y)), 0.3) * 2.0 - 1.0;
    } else if (pat == 2) {
        val = sin(da * 6.0) + sin(dr * 3.0);
        val += sin(da * 3.0 + dr * 2.0) * 0.5;
    } else {
        val = snoise(vec3(p * 2.0, t * 0.5)) * 2.0;
    }

    float hue = fract(val * 0.15 + logr * 0.1 + t * u_color_speed * 0.05);
    float sat = 0.7;
    float bri = 0.5 + 0.5 * sin(val);

    vec3 col = hsv2rgb(vec3(hue, sat, bri));

    // Depth fade
    col *= smoothstep(0.0, 0.1, r);

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
