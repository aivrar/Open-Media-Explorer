function t(e){return e.EffectRegistry.register({name:"contour_lines",label:"Contour Lines",category:"Patterns",description:"A drifting landscape drawn as height lines on a map",params:[{name:"speed",label:"Speed",min:.1,max:2,default:.5,step:.05},{name:"scale",label:"Scale",min:.5,max:4,default:1.6,step:.05},{name:"levels",label:"Lines",min:6,max:30,default:14,step:1,type:"int"},{name:"react",label:"Sound Response",min:0,max:1,default:.5,step:.05},{name:"brightness",label:"Brightness",min:.3,max:1.2,default:.85,step:.05},{name:"palette",label:"Palette",type:"select",options:["Glacier","Ember","Moss","Neon"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_audio;
uniform float u_speed;
uniform float u_scale;
uniform float u_levels;
uniform float u_react;
uniform float u_brightness;
uniform float u_palette;

vec3 contourStops(float t, vec3 a, vec3 b, vec3 c) {
    float x = fract(t) * 3.0;
    if (x < 1.0) return mix(a, b, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(b, c, smoothstep(0.0, 1.0, x - 1.0));
    return mix(c, a, smoothstep(0.0, 1.0, x - 2.0));
}

vec3 contourPalette(float t) {
    if (u_palette < 0.5) return contourStops(t, vec3(0.30, 0.75, 1.00), vec3(0.75, 0.95, 1.00), vec3(0.25, 0.45, 0.95));
    if (u_palette < 1.5) return contourStops(t, vec3(0.95, 0.35, 0.10), vec3(1.00, 0.70, 0.20), vec3(0.85, 0.15, 0.20));
    if (u_palette < 2.5) return contourStops(t, vec3(0.30, 0.85, 0.35), vec3(0.75, 0.95, 0.30), vec3(0.15, 0.70, 0.65));
    return contourStops(t, vec3(1.00, 0.25, 0.75), vec3(0.20, 0.95, 1.00), vec3(0.60, 0.35, 1.00));
}

float contourField(vec2 p, float t) {
    return snoise(vec3(p * 0.9, t * 0.05)) * 0.65 + snoise(vec3(p * 2.1 + 7.3, t * 0.08)) * 0.35;
}

void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    float scale = clamp(u_scale, 0.5, 4.0);
    vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0) * scale + seedOffset() * 0.01;
    float px = scale / max(u_resolution.y, 1.0);
    float t = u_time * u_speed + seedPhase();
    float react = clamp(u_react, 0.0, 1.0);
    float bass = clamp(u_audio.x, 0.0, 1.0) * react;
    float mid = clamp(u_audio.y, 0.0, 1.0) * react;
    float levels = clamp(floor(u_levels + 0.5), 6.0, 30.0);

    float steep = 1.0 + 0.25 * bass;
    float h = contourField(p, t) * steep;
    // The slope, for lines of an even width however steep the land.
    float e = px * 1.5;
    float hx = contourField(p + vec2(e, 0.0), t) * steep;
    float hy = contourField(p + vec2(0.0, e), t) * steep;
    float slope = max(length(vec2(hx - h, hy - h)) / e, 0.0001);

    float v = h * levels * 0.5 + mid * 0.3;
    float q = abs(fract(v + 0.5) - 0.5);
    float dist = q / (levels * 0.5 * slope);
    float major = 1.0 - step(0.5, abs(mod(floor(v + 0.5), 5.0)));
    float width = mix(0.7, 1.4, major) * px;
    float line = 1.0 - smoothstep(width, width + px * 1.2, dist);

    float band = floor(v) / levels;
    vec3 fill = contourPalette(band * 0.5 + t * 0.01) * 0.07;
    vec3 lineCol = contourPalette(band * 0.5 + 0.2 + t * 0.01) * mix(0.75, 1.0, major);
    vec3 col = mix(fill, lineCol, line) * clamp(u_brightness, 0.3, 1.2);
    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
