function o(t){return t.EffectRegistry.register({name:"mandelbrot_deep",label:"Mandelbrot Deep",category:"Fractals",description:"Ultra-detailed Mandelbrot with distance estimation, orbit coloring, and stripe patterns",specialize:["coloring"],params:[{name:"zoom_speed",label:"Zoom Speed",min:0,max:1.5,default:.5,step:.05},{name:"zoom_mode",label:"Zoom Mode",type:"select",options:["Infinite Dive","Classic One-Way"],default:0},{name:"zoom_depth",label:"Loop Depth",min:8,max:28,default:10,step:1},{name:"max_iter",label:"Iterations",min:100,max:1e3,default:300,step:50,type:"int"},{name:"target_x",label:"Target X",min:-2,max:1,default:-.7491,step:1e-4},{name:"target_y",label:"Target Y",min:-1.5,max:1.5,default:.1003,step:1e-4},{name:"coloring",label:"Coloring",type:"select",options:["Smooth","Stripe","Orbit Avg","Distance Est","Triangle Ineq","Curvature"],default:1},{name:"stripe_density",label:"Stripe/Detail Density",min:1,max:20,default:5,step:.5},{name:"color_speed",label:"Color Speed",min:0,max:8,default:.3,step:.05},{name:"palette_type",label:"Palette",type:"select",palette:!0,options:["Ultra Fractal","Electric","Twilight","Acid","Monochrome","Fire Ice"],default:0}],diveTargets:{resolve:function(e){return{kind:"mandelbrot",power:2,centerX:Number(e.target_x)||0,centerY:Number(e.target_y)||0}}},shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_zoom_speed;
uniform float u_zoom_mode;
uniform float u_zoom_depth;
uniform float u_max_iter;
uniform float u_target_x;
uniform float u_target_y;
uniform float u_coloring;
uniform float u_stripe_density;
uniform float u_color_speed;
uniform float u_palette_type;

vec3 getPal(float t) {
    int p = int(u_palette_type);
    t = fract(t);
    if (u_palette_type > 5.5) return psyLut(t);
    if (p == 0) return palette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.1, 0.2));
    if (p == 1) return palette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3));
    if (p == 2) return palette(t, vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(0.8, 0.8, 0.5), vec3(0.0, 0.2, 0.5));
    if (p == 3) return palette(t, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.2, 0.25));
    if (p == 4) {
        float v = sin(t * 6.28318) * 0.5 + 0.5;
        return vec3(v);
    }
    // Fire Ice
    return palette(t, vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(1.0, 0.5, 0.0), vec3(0.0, 0.5, 0.8));
}

vec3 renderDeepMandelbrotView(vec2 uv, vec2 target, float dive, float effectTime) {
    float zoom = pow(2.0, -dive);
    vec2 c = target + uv * zoom * 3.0;

    vec2 z = vec2(0.0);
    vec2 dz = vec2(1.0, 0.0); // For distance estimation
    float iter = 0.0;
    float maxI = psyDiveIterations(u_max_iter, dive, 600.0);
    float escaped = 0.0;

    // Orbit statistics
    float orbitSum = 0.0;
    float stripeSum = 0.0;
    float lastOrbit = 0.0;
    float minOrbit = 1e10;
    vec2 zMin = vec2(1e3); // orbit point closest to the origin (interior colour)
    float avgAngle = 0.0;
    float triSum = 0.0;
    float orbitSamples = 0.0;
    float prevAng = 0.0;

    vec2 zPrev = vec2(0.0);

    for (float i = 0.0; i < 1000.0; i++) {
        if (i >= maxI) break;

        // Distance estimation derivative
        dz = 2.0 * vec2(z.x*dz.x - z.y*dz.y, z.x*dz.y + z.y*dz.x) + vec2(1.0, 0.0);

        zPrev = z;
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;

        float r2 = dot(z, z);
        iter = i + 1.0;
        if (r2 > 65536.0) {
            escaped = 1.0;
            break;
        }

        // Collect only the orbit data the selected colouring (and the
        // interior shading) uses. u_coloring is compiled
        // in as a constant, so the unused sums drop out of the loop.
        float r = sqrt(r2);
        orbitSamples += 1.0;
        minOrbit = min(minOrbit, r);
        if (r2 < dot(zMin, zMin)) zMin = z;
        if (u_coloring > 1.5 && u_coloring < 2.5) orbitSum += r;
        if (u_coloring > 3.5 && u_coloring < 4.5) {
            // Triangle inequality avg
            float prevR = length(zPrev);
            float diffR = length(z - zPrev);
            triSum += abs(prevR - diffR) / (prevR + diffR + 0.001);
        }
        bool wantCurve = u_coloring > 4.5;
        if ((u_coloring > 0.5 && u_coloring < 1.5) || wantCurve) {
            float ang = atan(z.y, z.x);
            if (u_coloring > 0.5 && u_coloring < 1.5) stripeSum += sin(u_stripe_density * ang) * 0.5 + 0.5;
            // Curvature: the previous step's angle is reused, one atan per step.
            if (wantCurve && i > 0.0) avgAngle += abs(ang - prevAng);
            prevAng = ang;
        }
    }

    vec3 col = vec3(0.0);

    if (escaped > 0.5) {
        float frac = 1.0 + log2(log2(65536.0)) - log2(log2(dot(z,z)));
        float smoothIter = iter + frac;

        float t_color = 0.0;
        int coloring = int(u_coloring);

        if (coloring == 0) {
            // Smooth iteration count
            t_color = smoothIter / maxI * 5.0;
        } else if (coloring == 1) {
            // Stripe average
            float stripeVal = stripeSum / max(orbitSamples, 1.0);
            t_color = stripeVal * 3.0 + smoothIter / maxI * 2.0;
        } else if (coloring == 2) {
            // Orbit average
            t_color = orbitSum / max(orbitSamples, 1.0) * 0.5;
        } else if (coloring == 3) {
            // Distance estimation
            float r = length(z);
            float dr = length(dz);
            float dist = 2.0 * r * log(r) / dr;
            dist = dist / zoom;
            t_color = pow(clamp(dist * 500.0, 0.0, 1.0), 0.2) * 5.0;
        } else if (coloring == 4) {
            // Triangle inequality
            t_color = triSum / max(orbitSamples, 1.0) * 5.0;
        } else {
            // Curvature
            t_color = avgAngle / max(orbitSamples, 1.0) * 3.0;
        }

        col = getPal(t_color + effectTime * u_color_speed * 0.05);
    } else if (u_zoom_mode < 0.5) {
        float orbit = minOrbit < 1e9 ? minOrbit : length(z);
        // From the closest orbit point, not the last iterate, so the colour
        // holds still as the dive's iteration budget grows.
        float angle = atan(zMin.y, zMin.x);
        float t_color = fract(orbit * 0.55 + angle * 0.15915494 + length(uv) * 0.25 + effectTime * u_color_speed * 0.04);
        col = getPal(t_color * 4.0) * (0.32 + 0.68 * smoothstep(0.0, 0.9, orbit));
    }

    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float effectTime = u_unwrapped_time;
    float dive = psyZoomDive(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    vec2 baseTarget = vec2(u_target_x, u_target_y);
    vec2 target = psyZoomTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.010);
    vec3 col = renderDeepMandelbrotView(uv, target, dive, effectTime);

    float handoff = psyZoomHandoff(effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth);
    if (handoff > 0.0) {
        float nextDive = psyZoomNextDive(effectTime, u_zoom_speed, u_zoom_depth);
        vec2 nextTarget = psyZoomNextTarget(baseTarget, effectTime, u_zoom_speed, u_zoom_mode, u_zoom_depth, 0.010);
        vec3 nextCol = renderDeepMandelbrotView(uv, nextTarget, nextDive, effectTime);
        col = mix(col, nextCol, psyZoomPortal(uv, handoff));
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{o as default};
