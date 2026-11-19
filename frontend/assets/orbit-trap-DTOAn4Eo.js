function o(t){return t.EffectRegistry.register({name:"orbit_trap",label:"Orbit Trap",category:"Fractals",description:"Colors fractals by closest approach to geometric shapes - creates stunning detailed structures",params:[{name:"trap_type",label:"Trap Shape",type:"select",options:["Cross","Ring","Point","Line","Square","Rose"],default:0},{name:"trap_size",label:"Trap Size",min:.01,max:2,default:.5,step:.01},{name:"fractal_type",label:"Fractal",type:"select",options:["Mandelbrot","Julia","Burning Ship"],default:0},{name:"zoom_speed",label:"Zoom Speed",min:0,max:1.5,default:.5,step:.05},{name:"zoom_mode",label:"Zoom Mode",type:"select",options:["Infinite Dive","Classic One-Way"],default:0},{name:"zoom_depth",label:"Loop Depth",min:6,max:24,default:9,step:1},{name:"max_iter",label:"Iterations",min:50,max:500,default:200,step:10,type:"int"},{name:"julia_r",label:"Julia Real",min:-1.5,max:1.5,default:-.4,step:.01},{name:"julia_i",label:"Julia Imag",min:-1.5,max:1.5,default:.6,step:.01},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"morph",label:"Auto Morph",min:0,max:1,default:.3,step:.05},{name:"palette_type",label:"Palette",type:"select",palette:!0,options:["Trap Rainbow","Neon Glass","Amber Lines","Blue Orchid","Green Fire"],default:0}],diveTargets:{resolve:function(a){var e=Math.round(Number(a.fractal_type)||0);return e===1?null:e===2?{kind:"burning_ship",power:2,centerX:-1.75,centerY:-.03,offsetX:-1.75,offsetY:-.03,radii:[.25,.7]}:{kind:"mandelbrot",power:2,centerX:-.5,centerY:0,offsetX:-.5,offsetY:0,radii:[.9,1.6]}}},shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_trap_type;
uniform float u_trap_size;
uniform float u_fractal_type;
uniform float u_zoom_speed;
uniform float u_zoom_mode;
uniform float u_zoom_depth;
uniform float u_max_iter;
uniform float u_julia_r;
uniform float u_julia_i;
uniform float u_color_speed;
uniform float u_morph;
uniform float u_palette_type;

vec3 trapPalette(float t) {
    t = fract(t);
    if (u_palette_type > 4.5) return psyLut(t);
    if (u_palette_type < 0.5) return rainbow(t);
    if (u_palette_type < 1.5) return neon(t);
    // These cosine palettes do not end on the colour they start with, so
    // they run there and back; otherwise every hue wrap shows a hard edge.
    t = 1.0 - abs(1.0 - 2.0 * t);
    if (u_palette_type < 2.5) return palette(t, vec3(0.34,0.18,0.06), vec3(0.62,0.38,0.16), vec3(1.0,0.70,0.28), vec3(0.04,0.18,0.38));
    if (u_palette_type < 3.5) return palette(t, vec3(0.05,0.14,0.32), vec3(0.30,0.46,0.78), vec3(0.95,0.38,0.72), vec3(0.10,0.36,0.58));
    return palette(t, vec3(0.08,0.24,0.10), vec3(0.42,0.76,0.28), vec3(0.82,1.0,0.36), vec3(0.52,0.08,0.20));
}

float trapDistance(vec2 z, int trap, float effectTime) {
    if (trap == 0) {
        // Cross
        return min(abs(z.x), abs(z.y));
    }
    if (trap == 1) {
        // Ring
        return abs(length(z) - u_trap_size);
    }
    if (trap == 2) {
        // Point
        return length(z);
    }
    if (trap == 3) {
        // Line
        return abs(z.y - z.x * 0.5);
    }
    if (trap == 4) {
        // Square
        return max(abs(z.x), abs(z.y)) - u_trap_size * 0.5;
    }
    // Rose
    float a = atan(z.y, z.x);
    float r = length(z);
    float rose = u_trap_size * cos(a * 3.0 + effectTime);
    return abs(r - abs(rose));
}

vec3 renderOrbitTrapView(vec2 screenUv, vec2 trapFollow, float dive, float t) {
    float zoom = pow(2.0, -dive);
    vec2 uv = screenUv * zoom * 3.0 + trapFollow;

    int fracType = int(u_fractal_type);
    int trap = int(u_trap_type);

    vec2 z, c;
    if (fracType == 0) {
        // Mandelbrot
        c = uv + vec2(-0.5, 0.0);
        z = vec2(0.0);
    } else if (fracType == 1) {
        // Julia
        z = uv;
        c = vec2(u_julia_r, u_julia_i);
        if (u_morph > 0.0) {
            c += vec2(sin(t * 0.3), cos(t * 0.4)) * u_morph * 0.3;
        }
    } else {
        // Burning Ship
        c = uv + vec2(-1.75, -0.03);
        z = vec2(0.0);
    }

    float minTrap = 1e10;
    vec2 trapZ = vec2(0.0);
    float trapIter = 0.0;
    float iter = 0.0;
    float maxI = psyDiveIterations(u_max_iter, dive, 500.0);
    float escaped = 0.0;

    for (float i = 0.0; i < 500.0; i++) {
        if (i >= maxI) break;

        if (fracType == 2) z = vec2(abs(z.x), abs(z.y));
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;

        float td = trapDistance(z, trap, t);
        if (td < minTrap) {
            minTrap = td;
            trapZ = z;
            trapIter = i;
        }

        iter = i + 1.0;
        if (dot(z, z) > 256.0) {
            escaped = 1.0;
            break;
        }
    }

    vec3 col;
    if (escaped < 0.5) {
        // Inside the set - use trap coloring
        float ti = trapIter / maxI;
        col = trapPalette(ti * 3.0 + t * u_color_speed * 0.05);
        float trapGlow = exp(-minTrap * 5.0);
        if (u_zoom_mode < 0.5) {
            float screenAngle = atan(screenUv.y, screenUv.x);
            // Angle enters as a whole hue turn, so there is no seam where atan wraps.
            float screenDetail = length(screenUv) * 0.35 + screenAngle * 0.15915494;
            float orbitHue = fract(length(trapZ) * 0.18 + atan(trapZ.y, trapZ.x) * 0.15915494 + screenDetail + t * u_color_speed * 0.04);
            float orbitShade = 0.72 + 0.28 * sin(dot(screenUv, vec2(9.0, -6.0)) + length(trapZ) * 2.0 + t * 0.7);
            vec3 orbitCol = trapPalette(orbitHue) * 0.75;
            orbitCol *= orbitShade;
            col = mix(col * max(trapGlow, 0.18), orbitCol, 0.35);
        } else {
            col *= trapGlow;
        }
    } else {
        // Outside - blend trap and escape coloring
        float td = exp(-minTrap * 3.0);
        float hue = fract(atan(trapZ.y, trapZ.x) * 0.15915494 + minTrap * 2.0 + t * u_color_speed * 0.05);
        col = hsv2rgb(vec3(hue, 0.7 + 0.3 * td, td));

        // Add escape time coloring
        float sl = iter + 1.0 - log(log(max(length(z), 1.000001))) / log(2.0);
        vec3 escapeCol = trapPalette(sl / maxI * 3.0 + t * 0.02);
        col = mix(escapeCol * 0.3, col, td);
    }

    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float effectTime = u_unwrapped_time;
    float dive = psyZoomDive(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    vec2 trapFollow = psyZoomTarget(vec2(0.0), effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.040);
    vec3 col = renderOrbitTrapView(uv, trapFollow, dive, effectTime);

    float handoff = psyZoomHandoff(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    if (handoff > 0.0) {
        float nextDive = psyZoomNextDive(effectTime, u_zoom_speed, u_zoom_depth);
        vec2 nextTarget = psyZoomNextTarget(vec2(0.0), effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.040);
        vec3 nextCol = renderOrbitTrapView(uv, nextTarget, nextDive, effectTime);
        col = mix(col, nextCol, psyZoomPortal(uv, handoff));
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
