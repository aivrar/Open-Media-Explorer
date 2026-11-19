function e(t){return t.EffectRegistry.register({name:"swirl",label:"Swirl Vortex",category:"Distortion",description:"Hypnotic vortices: classic spiral, op-art rings, spiral galaxy, liquid whirlpool, twin vortex and black-hole lensing",specialize:["style"],params:[{name:"style",label:"Style",type:"select",options:["Classic Spiral","Hypnotic Rings","Spiral Galaxy","Liquid Whirlpool","Twin Vortex","Black Hole"],default:0},{name:"speed",label:"Speed",min:.1,max:3,default:1,step:.1},{name:"twist",label:"Twist Amount",min:1,max:20,default:8,step:.5},{name:"arms",label:"Arms",min:1,max:8,default:3,step:1,type:"int"},{name:"radius",label:"Radius",min:.2,max:2,default:1,step:.1},{name:"color_speed",label:"Color Speed",min:0,max:2,default:.5,step:.05},{name:"palette",label:"Palette",type:"select",palette:!0,options:["Rainbow","Neon"],default:0},{name:"contrast",label:"Contrast",min:.5,max:2,default:1.1,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_style;
uniform float u_speed;
uniform float u_twist;
uniform float u_arms;
uniform float u_radius;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_contrast;

vec3 swirlPalette(float t) {
    t = fract(t);
    if (u_palette > 1.5) return psyLut(t);
    if (u_palette > 0.5) return neon(t);
    return hsv2rgb(vec3(t, 0.75, 1.0));
}

vec3 classicSwirl(vec2 uv, float t) {
    float r = length(uv);
    float a = atan(uv.y, uv.x) + u_twist * exp(-r / u_radius) + t;
    float arms = sin(a * u_arms + r * 10.0 - t * 3.0) * 0.5 + 0.5;
    float rings = sin(r * 20.0 - t * 2.0) * 0.5 + 0.5;
    float val = arms * 0.6 + rings * 0.4;
    val += snoise(vec3(fromPolar(vec2(r, a)) * 3.0, t * 0.3)) * 0.15;
    vec3 col = swirlPalette(val * 0.5 + a / 6.28318 + t * u_color_speed * 0.05) * (val * 0.8 + 0.2);
    return col + vec3(0.3, 0.1, 0.5) * exp(-r * 3.0);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();
    float style = floor(u_style + 0.5);
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    vec3 col;

    if (style < 0.5) {
        col = classicSwirl(uv, t);
    } else if (style < 1.5) {
        // Op-art: high-contrast spiral bands with a colour bleed.
        float spiral = a * u_arms / 6.28318 + log(max(r, 0.001)) * u_twist * 0.35 - t * 0.6;
        float band = smoothstep(0.42, 0.58, abs(fract(spiral) - 0.5) * 2.0);
        vec3 tint = swirlPalette(r * 0.6 - t * u_color_speed * 0.1);
        col = mix(vec3(0.02), mix(vec3(0.96), tint, 0.35), band);
        col *= smoothstep(0.0, 0.06, r);
    } else if (style < 2.5) {
        // Spiral galaxy: logarithmic arms of stars and dust.
        float lr = log(max(r, 0.002));
        float arm = cos(u_arms * (a - lr * u_twist * 0.18 - t * 0.15));
        float density = smoothstep(0.2, 1.0, arm) * exp(-r / max(u_radius, 0.2) * 1.6);
        vec2 sp = fromPolar(vec2(r, a - lr * u_twist * 0.18 - t * 0.15)) * 70.0;
        float star = step(0.985, hash2(floor(sp))) * smoothstep(0.6, 0.0, length(fract(sp) - 0.5));
        float dust = fbm(vec3(sp * 0.04, t * 0.05)) * 0.5 + 0.5;
        vec3 core = vec3(1.0, 0.85, 0.6) * exp(-r * 9.0) * 1.4;
        col = swirlPalette(0.55 + r * 0.4 + t * u_color_speed * 0.02) * density * (0.5 + dust) + core;
        col += vec3(0.9, 0.95, 1.0) * star * (0.3 + density);
        col += vec3(0.01, 0.01, 0.03);
    } else if (style < 3.5) {
        // Liquid whirlpool: noise-warped polar flow.
        float sw = u_twist * 0.6 * exp(-r / u_radius);
        vec2 p = rot2(sw + t * 0.4) * uv;
        float n = fbm(vec3(p * 2.5, t * 0.2));
        float m = fbm(vec3(p * 4.0 + n * 2.0, t * 0.15));
        float ink = sin((n + m) * 6.0 + r * 8.0 - t * 2.0) * 0.5 + 0.5;
        col = swirlPalette(n * 0.6 + m * 0.4 + t * u_color_speed * 0.05) * (0.25 + 0.85 * ink);
        col *= 0.4 + 0.6 * smoothstep(0.0, 0.25, r);
    } else if (style < 4.5) {
        // Twin vortex: two counter-rotating swirls with a shared field.
        vec2 c1 = vec2(-0.42, 0.0), c2 = vec2(0.42, 0.0);
        vec2 d1 = uv - c1, d2 = uv - c2;
        float a1 = u_twist * 0.5 * exp(-length(d1) / (u_radius * 0.6));
        float a2 = -u_twist * 0.5 * exp(-length(d2) / (u_radius * 0.6));
        vec2 p = c1 + rot2(a1 + t * 0.5) * d1;
        p = c2 + rot2(a2 - t * 0.5) * (p - c2);
        float v = sin(p.x * 9.0 + t) * sin(p.y * 9.0 - t * 0.7) + snoise(vec3(p * 2.0, t * 0.2)) * 0.5;
        col = swirlPalette(v * 0.3 + p.x * 0.2 + t * u_color_speed * 0.05) * (0.45 + 0.55 * abs(v));
    } else {
        // Black hole: lensed starfield, accretion disk and photon ring.
        float rs = 0.12 * u_radius;
        float bend = rs * rs / max(r, 0.001);
        vec2 lensed = uv * (1.0 + bend * 6.0 / max(r, 0.05));
        vec2 sp = rot2(t * 0.05) * lensed * 40.0;
        float stars = step(0.992, hash2(floor(sp))) * smoothstep(0.5, 0.0, length(fract(sp) - 0.5));
        float disk = exp(-pow((r - rs * 2.6) / (rs * 1.4), 2.0));
        float swirl = sin(a * u_arms - log(max(r, 0.01)) * u_twist * 0.7 + t * 3.0) * 0.5 + 0.5;
        float doppler = 0.6 + 0.4 * cos(a - 0.6);
        vec3 diskCol = swirlPalette(0.08 + swirl * 0.25 + t * u_color_speed * 0.03) * disk * (0.4 + swirl) * doppler * 1.6;
        float ring = exp(-pow((r - rs * 1.55) / (rs * 0.12), 2.0));
        col = vec3(0.8, 0.85, 1.0) * stars + diskCol + vec3(1.0, 0.9, 0.75) * ring * 1.2;
        col *= smoothstep(rs * 1.0, rs * 1.25, r);
    }

    col = (col - 0.5) * u_contrast + 0.5;
    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{e as default};
