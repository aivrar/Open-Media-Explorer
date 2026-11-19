function o(t){return t.EffectRegistry.register({name:"tricorn",label:"Tricorn",category:"Fractals",description:"The Mandelbar fractal - uses complex conjugate creating 3-pointed crowns",params:[{name:"zoom_speed",label:"Zoom Speed",min:0,max:1.5,default:.6,step:.05},{name:"zoom_mode",label:"Zoom Mode",type:"select",options:["Infinite Dive","Classic One-Way"],default:0},{name:"zoom_depth",label:"Loop Depth",min:6,max:24,default:9,step:1},{name:"max_iter",label:"Iterations",min:50,max:500,default:200,step:10,type:"int"},{name:"target_x",label:"Target X",min:-2,max:2,default:-1,step:.01},{name:"target_y",label:"Target Y",min:-2,max:2,default:0,step:.01},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.4,step:.05},{name:"power",label:"Power",min:2,max:8,default:2,step:.5},{name:"palette_type",label:"Palette",type:"select",palette:!0,options:["Icy Crown","Ruby Ice","Toxic Violet","Gold Glass","Cyan Ink"],default:0}],diveTargets:{resolve:function(e){return{kind:"tricorn",power:Math.max(2,Number(e.power)||2),centerX:Number(e.target_x)||0,centerY:Number(e.target_y)||0}}},shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_zoom_speed;
uniform float u_zoom_mode;
uniform float u_zoom_depth;
uniform float u_max_iter;
uniform float u_target_x;
uniform float u_target_y;
uniform float u_color_speed;
uniform float u_power;
uniform float u_palette_type;

vec3 tricornPalette(float t) {
    t = fract(t);
    if (u_palette_type > 4.5) return psyLut(t);
    if (u_palette_type < 0.5) return palette(t, vec3(0.5,0.5,0.55), vec3(0.45), vec3(0.8,0.8,1.0), vec3(0.2,0.3,0.5));
    if (u_palette_type < 1.5) return palette(t, vec3(0.32,0.08,0.12), vec3(0.70,0.24,0.30), vec3(1.0,0.48,0.62), vec3(0.08,0.28,0.58));
    if (u_palette_type < 2.5) return palette(t, vec3(0.18,0.08,0.34), vec3(0.48,0.30,0.72), vec3(0.70,1.0,0.42), vec3(0.12,0.36,0.60));
    if (u_palette_type < 3.5) return palette(t, vec3(0.38,0.24,0.08), vec3(0.62,0.42,0.14), vec3(1.0,0.76,0.28), vec3(0.05,0.18,0.38));
    return palette(t, vec3(0.03,0.16,0.26), vec3(0.18,0.58,0.72), vec3(0.44,0.94,1.0), vec3(0.08,0.32,0.60));
}

vec2 cpow_conj(vec2 z, float n) {
    // Conjugate before power
    z.y = -z.y;
    float r = length(z);
    float a = atan(z.y, z.x);
    return pow(r, n) * vec2(cos(a * n), sin(a * n));
}

vec3 renderTricornView(vec2 uv, vec2 target, float dive, float effectTime) {
    float zoom = pow(2.0, -dive);
    vec2 c = target + uv * zoom * 3.0;

    vec2 z = vec2(0.0);
    float iter = 0.0;
    float maxI = psyDiveIterations(u_max_iter, dive, 500.0);
    float escaped = 0.0;
    // Orbit point closest to the origin: the inside of the set is coloured
    // from it, not from the last iterate, so it holds still as the dive's
    // iteration budget grows (the last iterate jumps with every extra step).
    vec2 zMin = vec2(1e3);

    for (float i = 0.0; i < 500.0; i++) {
        if (i >= maxI) break;
        z = cpow_conj(z, u_power) + c;
        iter = i + 1.0;
        if (dot(z, z) < dot(zMin, zMin)) zMin = z;
        if (dot(z, z) > 256.0) {
            escaped = 1.0;
            break;
        }
    }

    vec3 col = vec3(0.0);
    if (escaped > 0.5) {
        float sl = iter + 1.0 - log(log(max(length(z), 1.000001))) / log(max(u_power, 1.0001));
        float t = sl / u_max_iter;
        col = tricornPalette(t * 4.0 + effectTime * u_color_speed * 0.1);
    } else if (u_zoom_mode < 0.5) {
        float orbit = length(zMin);
        float angle = atan(zMin.y, zMin.x);
        float t = fract(orbit * 0.4 + angle * 0.15915 + length(uv) * 0.32 + effectTime * u_color_speed * 0.05);
        col = tricornPalette(t) * (0.30 + 0.70 * smoothstep(0.0, 1.25, orbit));
    }

    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float effectTime = u_unwrapped_time;
    float dive = psyZoomDive(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    vec2 baseTarget = vec2(u_target_x, u_target_y);
    vec2 target = psyZoomTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.030);
    vec3 col = renderTricornView(uv, target, dive, effectTime);

    float handoff = psyZoomHandoff(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    if (handoff > 0.0) {
        float nextDive = psyZoomNextDive(effectTime, u_zoom_speed, u_zoom_depth);
        vec2 nextTarget = psyZoomNextTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.030);
        vec3 nextCol = renderTricornView(uv, nextTarget, nextDive, effectTime);
        col = mix(col, nextCol, psyZoomPortal(uv, handoff));
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
