function t(e){return e.EffectRegistry.register({name:"flowfield",label:"Flow Field",category:"Noise",description:"Noise-driven currents: turbulent colour, curl streamlines, marbled paper, topographic contours, aurora curtains and silk threads",specialize:["style"],params:[{name:"style",label:"Style",type:"select",options:["Turbulent Color","Curl Streamlines","Marbled Paper","Topographic Contours","Aurora Currents","Silk Threads"],default:0},{name:"speed",label:"Speed",min:.1,max:3,default:.6,step:.1},{name:"scale",label:"Scale",min:.5,max:8,default:3,step:.5},{name:"turbulence",label:"Turbulence",min:.1,max:3,default:1.5,step:.1},{name:"color_spread",label:"Color Spread",min:.1,max:3,default:1,step:.1},{name:"brightness",label:"Brightness",min:.3,max:2,default:1,step:.1},{name:"palette",label:"Palette",type:"select",palette:!0,options:["Rainbow","Neon"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_style;
uniform float u_speed;
uniform float u_scale;
uniform float u_turbulence;
uniform float u_color_spread;
uniform float u_brightness;
uniform float u_palette;

vec3 flowPalette(float t) {
    t = fract(t);
    if (u_palette > 1.5) return psyLut(t);
    if (u_palette > 0.5) return neon(t);
    return hsv2rgb(vec3(t, 0.8, 1.0));
}

vec2 flowAt(vec2 p, float t) {
    vec2 flow = vec2(0.0);
    float amp = 1.0;
    vec2 q = p;
    for (int i = 0; i < 4; i++) {
        float n1 = snoise(vec3(q, t + float(i) * 1.7));
        float n2 = snoise(vec3(q + vec2(5.2, 1.3), t + float(i) * 1.7));
        flow += vec2(n1, n2) * amp;
        q = p + flow * u_turbulence * 0.5;
        amp *= 0.5;
    }
    return flow;
}

// Curl of a noise potential: divergence-free, so streamlines swirl.
vec2 curl(vec2 p, float t) {
    float e = 0.02;
    float n1 = snoise(vec3(p + vec2(0.0, e), t));
    float n2 = snoise(vec3(p - vec2(0.0, e), t));
    float n3 = snoise(vec3(p + vec2(e, 0.0), t));
    float n4 = snoise(vec3(p - vec2(e, 0.0), t));
    return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

void main() {
    vec2 uv = v_uv + seedOffset() * 0.01;
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y) * u_scale;
    float t = u_time * u_speed + seedPhase();
    float style = floor(u_style + 0.5);
    vec3 col;

    if (style < 0.5) {
        vec2 flow = flowAt(p, t);
        float angle = atan(flow.y, flow.x);
        float mag = length(flow);
        float hue = angle / 6.28318 + 0.5 + t * 0.05;
        float val = (0.5 + 0.5 * sin(mag * 3.0 - t)) * u_brightness;
        col = flowPalette(hue) * val * (0.6 + 0.4 * (1.0 - exp(-mag * u_color_spread)));
        col += vec3(0.1) * smoothstep(0.8, 1.0, sin(flow.x * 10.0) * sin(flow.y * 10.0));
    } else if (style < 1.5) {
        // Advect the sample point backwards along the curl field and read
        // stripes there: a cheap line-integral-convolution look.
        vec2 q = p;
        float acc = 0.0;
        for (int i = 0; i < 10; i++) {
            q -= curl(q * 0.6, t * 0.2) * 0.035 * u_turbulence;
            acc += sin(q.x * 6.0 + q.y * 1.5) * 0.5 + 0.5;
        }
        acc /= 10.0;
        float lines = smoothstep(0.35, 0.95, acc);
        col = flowPalette(length(q - p) * u_color_spread * 0.6 + t * 0.03) * (0.15 + lines) * u_brightness;
    } else if (style < 2.5) {
        // Marbled paper: iterated domain warp of a sine field.
        vec2 q = p * 0.6;
        for (int i = 0; i < 3; i++) {
            q += vec2(snoise(vec3(q, t * 0.1 + float(i))), snoise(vec3(q + 4.1, t * 0.1 + float(i)))) * u_turbulence * 0.35;
        }
        float v = sin(q.x * 3.0 + q.y * 2.0) * 0.5 + 0.5;
        float veins = smoothstep(0.02, 0.0, abs(fract(v * 4.0 * u_color_spread) - 0.5) - 0.46);
        col = flowPalette(v * 0.7 + t * 0.02) * (0.55 + 0.45 * v) * u_brightness;
        col = mix(col, vec3(1.0), veins * 0.5);
    } else if (style < 3.5) {
        // Topographic map of a moving height field.
        vec2 w = flowAt(p * 0.35, t * 0.4) * 0.3;
        float h = fbm(vec3((p + w) * 0.5, t * 0.08)) * 0.5 + 0.5;
        float levels = 14.0 * u_color_spread;
        float f = fract(h * levels);
        float line = smoothstep(0.08, 0.0, min(f, 1.0 - f));
        float major = smoothstep(0.05, 0.0, abs(fract(h * levels / 5.0) - 0.5) - 0.49);
        col = flowPalette(h * 0.9 + t * 0.01) * (0.18 + 0.25 * h) + vec3(1.0) * line * 0.45 + vec3(1.0) * major * 0.35;
        col *= u_brightness;
    } else if (style < 4.5) {
        // Aurora: vertical curtains waving in a slow current.
        float x = uv.x * aspect * u_scale * 0.5;
        float curtain = 0.0;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 4; i++) {
            float fi = float(i);
            float wave = snoise(vec3(x * (0.6 + fi * 0.3) + fi * 3.0, t * 0.15, fi)) * u_turbulence * 0.25;
            float band = exp(-pow((uv.y - 0.55 - wave - fi * 0.06) * (6.0 + fi * 2.0), 2.0));
            float rays = 0.6 + 0.4 * sin(x * 40.0 + snoise(vec3(x * 3.0, t * 0.3, fi)) * 4.0);
            acc += flowPalette(0.35 + fi * 0.12 * u_color_spread + x * 0.05 + t * 0.01) * band * rays;
        }
        vec3 sky = mix(vec3(0.0, 0.01, 0.04), vec3(0.02, 0.0, 0.06), uv.y);
        col = sky + acc * u_brightness;
    } else {
        // Silk: fine threads that follow the flow direction.
        vec2 flow = flowAt(p * 0.5, t * 0.6);
        float ang = atan(flow.y, flow.x);
        vec2 dir = vec2(cos(ang), sin(ang));
        float threads = sin(dot(p, vec2(-dir.y, dir.x)) * 60.0 / u_scale + length(flow) * 4.0);
        float sheen = pow(0.5 + 0.5 * threads, 6.0);
        col = flowPalette(ang / 6.28318 * u_color_spread + t * 0.03) * (0.25 + 0.75 * sheen) * u_brightness;
    }

    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{t as default};
