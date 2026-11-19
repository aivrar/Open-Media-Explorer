function t(e){return e.EffectRegistry.register({name:"op_art",label:"Op Art",category:"Patterns",description:"Riley waves, Vasarely bulge, moire rings, zebra flow and kinetic squares in stark black and white or neon duotones",specialize:["style"],params:[{name:"style",label:"Style",type:"select",options:["Riley Waves","Vasarely Bulge","Moire Rings","Zebra Flow","Kinetic Squares"],default:0},{name:"density",label:"Density",min:4,max:60,default:22,step:1},{name:"amplitude",label:"Distortion",min:0,max:2,default:.8,step:.05},{name:"speed",label:"Speed",min:0,max:3,default:.6,step:.05},{name:"sharpness",label:"Sharpness",min:.1,max:1,default:.85,step:.05},{name:"palette",label:"Colors",type:"select",palette:!0,options:["Black & White","Neon Duotone"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_style;
uniform float u_density;
uniform float u_amplitude;
uniform float u_speed;
uniform float u_sharpness;
uniform float u_palette;

vec3 opColor(float v, float pos) {
    if (u_palette < 0.5) return vec3(v);
    if (u_palette < 1.5) return mix(vec3(0.05, 0.0, 0.18), vec3(0.2, 1.0, 0.9), v) + vec3(1.0, 0.1, 0.6) * v * (1.0 - v) * 2.0;
    return mix(psyLut(pos) * 0.12, psyLut(pos + 0.35), v);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed;
    float style = floor(u_style + 0.5);
    float soft = mix(0.6, 0.02, u_sharpness);
    float v;
    if (style < 0.5) {
        float phase = uv.y * u_density + sin(uv.x * 6.0 + t + uv.y * 3.0) * u_amplitude * 2.5 + sin(uv.x * 2.3 - t * 0.7) * u_amplitude;
        v = smoothstep(-soft, soft, sin(phase));
    } else if (style < 1.5) {
        vec2 c = vec2(sin(t * 0.5) * 0.3, cos(t * 0.37) * 0.15);
        vec2 d = uv - c;
        float r = length(d);
        float bulge = 1.0 + u_amplitude * 1.2 * exp(-r * r * 6.0);
        vec2 q = c + d / bulge;
        vec2 g = q * u_density * 0.5;
        float checker = sin(g.x * 3.14159) * sin(g.y * 3.14159);
        v = smoothstep(-soft, soft, checker);
    } else if (style < 2.5) {
        vec2 c1 = vec2(sin(t * 0.3) * 0.25, 0.0);
        vec2 c2 = vec2(-sin(t * 0.3) * 0.25, cos(t * 0.2) * 0.1);
        float a = sin(length(uv - c1) * u_density * 2.0);
        float b = sin(length(uv - c2) * u_density * 2.0 * (1.0 + u_amplitude * 0.05));
        v = smoothstep(-soft, soft, a * b);
    } else if (style < 3.5) {
        float n = snoise(vec3(uv * 1.6, t * 0.15)) * u_amplitude * 2.0 + snoise(vec3(uv * 3.2, t * 0.2)) * u_amplitude * 0.6;
        v = smoothstep(-soft, soft, sin((uv.x + uv.y * 0.3 + n) * u_density));
    } else {
        vec2 q = uv;
        float level = max(abs(q.x), abs(q.y));
        float twist = sin(level * 6.0 - t) * u_amplitude * 0.5;
        q = rot2(twist) * q;
        float sq = max(abs(q.x), abs(q.y));
        v = smoothstep(-soft, soft, sin(sq * u_density * 2.0 - t * 2.0));
    }
    FRAG_OUT = vec4(opColor(v, length(uv) * 0.4 + u_time * 0.02), 1.0);
}
`}),{}}export{t as default};
