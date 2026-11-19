function o(t){return t.EffectRegistry.register({name:"mandelbrot",label:"Mandelbrot",category:"Fractals",description:"Infinite fractal zoom into the Mandelbrot set with smooth coloring",params:[{name:"zoom_speed",label:"Zoom Speed",min:0,max:2,default:.75,step:.05},{name:"zoom_mode",label:"Zoom Mode",type:"select",options:["Infinite Dive","Classic One-Way"],default:0},{name:"zoom_depth",label:"Loop Depth",min:6,max:24,default:9,step:1},{name:"max_iter",label:"Max Iterations",min:50,max:500,default:150,step:10,type:"int"},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"target_x",label:"Target X",min:-2,max:1,default:-.7435,step:1e-4},{name:"target_y",label:"Target Y",min:-1.5,max:1.5,default:.1314,step:1e-4},{name:"palette_type",label:"Palette",type:"select",palette:!0,options:["Rainbow","Neon","Fire","Ocean","Psychedelic"],default:0}],diveTargets:{resolve:function(e){return{kind:"mandelbrot",power:2,centerX:Number(e.target_x)||0,centerY:Number(e.target_y)||0}}},shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_zoom_speed;
uniform float u_zoom_mode;
uniform float u_zoom_depth;
uniform float u_max_iter;
uniform float u_color_speed;
uniform float u_target_x;
uniform float u_target_y;
uniform float u_palette_type;

vec3 getColor(float t, float time) {
    t = fract(t + time * 0.1);
    if (u_palette_type > 4.5) return psyLut(t);
    int pal = int(u_palette_type);
    if (pal == 0) return rainbow(t);
    if (pal == 1) return neon(t);
    if (pal == 2) return palette(t, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(1.0,0.7,0.4), vec3(0.0,0.15,0.2));
    if (pal == 3) return palette(t, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(1.0,1.0,0.5), vec3(0.8,0.9,0.3));
    return palette(t, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(2.0,1.0,0.0), vec3(0.5,0.2,0.25));
}

vec3 renderMandelbrotView(vec2 uv, vec2 target, float dive, float effectTime) {
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
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
        iter = i + 1.0;
        if (dot(z, z) < dot(zMin, zMin)) zMin = z;
        if (dot(z, z) > 256.0) {
            escaped = 1.0;
            break;
        }
    }

    vec3 col = vec3(0.0);
    if (escaped > 0.5) {
        float sl = iter + 1.0 - log(log(max(length(z), 1.000001))) / log(2.0);
        float t = sl / u_max_iter;
        col = getColor(t * 5.0, effectTime * u_color_speed);
    } else if (u_zoom_mode < 0.5) {
        float orbit = length(zMin);
        float angle = atan(zMin.y, zMin.x);
        float t = fract(orbit * 0.45 + angle * 0.15915 + length(uv) * 0.35 + effectTime * u_color_speed * 0.04);
        col = getColor(t * 3.0, effectTime * u_color_speed) * (0.28 + 0.72 * smoothstep(0.0, 1.2, orbit));
    }

    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float effectTime = u_unwrapped_time;
    float dive = psyZoomDive(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    vec2 baseTarget = vec2(u_target_x, u_target_y);
    vec2 target = psyZoomTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.026);
    vec3 col = renderMandelbrotView(uv, target, dive, effectTime);

    float handoff = psyZoomHandoff(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    if (handoff > 0.0) {
        float nextDive = psyZoomNextDive(effectTime, u_zoom_speed, u_zoom_depth);
        vec2 nextTarget = psyZoomNextTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.026);
        vec3 nextCol = renderMandelbrotView(uv, nextTarget, nextDive, effectTime);
        col = mix(col, nextCol, psyZoomPortal(uv, handoff));
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
