function w(c){var b=c.EffectRegistry,g=c.FractalFlight,_=(function(){var p=120,d={key:"",data:null};function h(l,e,t,a,r,o){var i=r-.78;if(l===0)o[0]=10*(t-e),o[1]=e*(28+i*3.5-a)-t,o[2]=e*t-2.6666666667*a;else if(l===1){var s=Math.max(.14,Math.min(.3,.208186-i*.028));o[0]=Math.sin(t)-s*e,o[1]=Math.sin(a)-s*t,o[2]=Math.sin(e)-s*a}else if(l===2){var n=.95+i*.045,m=3.5+i*.3;o[0]=(a-.7)*e-m*t,o[1]=m*e+(a-.7)*t,o[2]=.6+n*a-a*a*a/3-(e*e+t*t)*(1+.25*a)+.1*a*e*e*e}else o[0]=-t-a,o[1]=e+.2*t,o[2]=.2+a*(e-(5.7+i*.75))}function y(l,e){var t=[.004,.03,.01,.02][l],a=[18,120,40,60][l],r=[[-8,8,27],[1.1,.05,0],[.1,.02,0],[.1,.04,0]][l].slice(),o=[0,0,0],i=[0,0,0];function s(){h(l,r[0],r[1],r[2],e,o),h(l,r[0]+o[0]*t*.5,r[1]+o[1]*t*.5,r[2]+o[2]*t*.5,e,i),r[0]+=i[0]*t,r[1]+=i[1]*t,r[2]+=i[2]*t}for(var n=0;n<3e3;n++)s();for(var m=Math.max(1,Math.round(a/t/p)),f=new Float32Array(p*3),u=0;u<p;u++){for(var v=0;v<m;v++)s();f[u*3]=r[0],f[u*3+1]=r[1],f[u*3+2]=r[2]}return f}function x(l,e,t,a){var r=a(e,"u_attr_count");if(r!==null){var o=Math.max(0,Math.min(3,Math.round(Number(t.attractor_mode)||0))),i=Number(t.chaos);(t.chaos===null||t.chaos===void 0||t.chaos===""||!isFinite(i))&&(i=.78);var s=o+"|"+i.toFixed(3);d.key!==s&&(d={key:s,data:y(o,i)});var n=a(e,"u_attr_points[0]");n===null&&(n=a(e,"u_attr_points")),n!==null&&(d.program!==e||d.uploaded!==s)&&(l.uniform3fv(n,d.data),d.program=e,d.uploaded=s),l.uniform1f(r,n!==null?p:0)}}return{setUniforms:x,COUNT:p}})();return b.register({name:"strange_attractor_flight",label:"Strange Attractor Flight",category:"Fractals",description:"Volumetric fly-throughs built from integrated Lorenz, Thomas, Aizawa, and Rossler phase-space trajectories",fractalFlight:g.metadata({family:"Strange Attractor",familyKey:"strange_attractor",modeParam:"attractor_mode",modes:["Lorenz Wings","Thomas Knot","Aizawa Bloom","Rossler Spiral"],depthParams:["flight_depth"],requiredParams:["attractor_mode","orbit_steps","curve_scale","trail_width","lobe_spread","chaos","density","detail","flight_depth","ribbon_twist","phase_drift"],animationParams:["flight_speed","flight_depth","orbit_radius","orbit_spin","motion_mode","motion_phase","ribbon_twist","phase_drift","roll","roll_speed","fov","color_speed"],smokePresets:[{name:"Lorenz Wing Dive",values:{attractor_mode:0,orbit_steps:28,curve_scale:1.1,trail_width:.105,lobe_spread:.86,chaos:.76,density:1.42,detail:1.18,flight_speed:2.08,flight_depth:1.48,orbit_radius:1.2,orbit_spin:1.44,motion_mode:2,motion_phase:.18,ribbon_twist:.74,phase_drift:.82,roll:.28,roll_speed:1.34,fov:1,color_speed:.78,palette:0,shade_mode:2,fog:.2,glow:1.8}},{name:"Thomas Knot Orbit",values:{attractor_mode:1,orbit_steps:30,curve_scale:1.18,trail_width:.092,lobe_spread:.72,chaos:1.02,density:1.55,detail:1.3,flight_speed:2.24,flight_depth:1.56,orbit_radius:1.14,orbit_spin:1.62,motion_mode:0,motion_phase:.3,ribbon_twist:1.04,phase_drift:.96,roll:.34,roll_speed:1.48,fov:.96,color_speed:.86,palette:1,shade_mode:3,fog:.18,glow:1.92}},{name:"Aizawa Bloom Tunnel",values:{attractor_mode:2,orbit_steps:32,curve_scale:1.08,trail_width:.115,lobe_spread:.94,chaos:.88,density:1.5,detail:1.36,flight_speed:2.42,flight_depth:1.7,orbit_radius:1.05,orbit_spin:1.78,motion_mode:2,motion_phase:.42,ribbon_twist:1.12,phase_drift:1.08,roll:.4,roll_speed:1.62,fov:.92,color_speed:.94,palette:2,shade_mode:1,fog:.16,glow:2.04}},{name:"Rossler Spiral Graze",values:{attractor_mode:3,orbit_steps:34,curve_scale:1.22,trail_width:.1,lobe_spread:1.12,chaos:1.18,density:1.46,detail:1.4,flight_speed:2.3,flight_depth:1.62,orbit_radius:1.24,orbit_spin:1.52,motion_mode:3,motion_phase:.56,ribbon_twist:-.88,phase_drift:1.14,roll:-.36,roll_speed:1.5,fov:.98,color_speed:.9,palette:3,shade_mode:2,fog:.2,glow:1.96}}]}),params:[{name:"attractor_mode",label:"Attractor Mode",group:"Formula",type:"select",options:["Lorenz Wings","Thomas Knot","Aizawa Bloom","Rossler Spiral"],default:0},{name:"orbit_steps",label:"Orbit Steps",group:"Formula",min:8,max:48,default:28,step:1,type:"int"},{name:"curve_scale",label:"Curve Scale",group:"Formula",min:.45,max:2.2,default:1.05,step:.02},{name:"trail_width",label:"Trail Width",group:"Formula",min:.035,max:.26,default:.1,step:.005},{name:"lobe_spread",label:"Lobe Spread",group:"Formula",min:.2,max:1.8,default:.82,step:.02},{name:"chaos",label:"Chaos",group:"Formula",min:0,max:1.8,default:.78,step:.02},{name:"density",label:"Trail Density",group:"Formula",min:.3,max:3,default:1.3,step:.02},{name:"detail",label:"Trail Detail",group:"Formula",min:.5,max:2.5,default:1.15,step:.05},{name:"flight_speed",label:"Flight Speed",group:"Flight",min:0,max:8,default:.72,step:.05},{name:"flight_depth",label:"Dive Depth",group:"Flight",min:0,max:4.6,default:.95,step:.05},{name:"orbit_radius",label:"Orbit Radius",group:"Flight",min:.2,max:5.8,default:1.18,step:.05},{name:"orbit_spin",label:"Orbit Spin Speed",group:"Flight",min:-5,max:5,default:.58,step:.05},{name:"motion_mode",label:"Motion Path",group:"Animation",type:"select",options:["Attractor Orbit","Figure Eight","Ribbon Tunnel","Surface Graze"],default:2},{name:"motion_phase",label:"Motion Phase",group:"Animation",min:0,max:1,default:0,step:.01},{name:"ribbon_twist",label:"Ribbon Twist",group:"Animation",min:-2,max:2,default:.72,step:.02},{name:"phase_drift",label:"Phase Drift",group:"Animation",min:0,max:1.8,default:.72,step:.05},{name:"roll",label:"Roll Drift",group:"Animation",min:-1.8,max:1.8,default:.24,step:.05},{name:"roll_speed",label:"Roll Speed",group:"Animation",min:0,max:6,default:.68,step:.05},{name:"fov",label:"Field of View",group:"Animation",min:.55,max:1.9,default:1,step:.05},{name:"color_speed",label:"Color Speed",group:"Visual",min:0,max:8,default:.52,step:.05},{name:"palette",label:"Palette",group:"Visual",type:"select",palette:!0,options:["Phase Neon","Amber Orbit","Blue Silk","Rose Copper"],default:0},{name:"shade_mode",label:"Shade Mode",group:"Visual",type:"select",options:["Trail Glow","Phase Bands","Ribbon Core","Point Cloud"],default:0},{name:"fog",label:"Depth Fog",group:"Visual",min:0,max:1.5,default:.26,step:.05},{name:"glow",label:"Edge Glow",group:"Visual",min:0,max:3,default:1.45,step:.05}],setUniforms:_.setUniforms,shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_attr_points[120];
uniform float u_attr_count;
uniform float u_attractor_mode;
uniform float u_orbit_steps;
uniform float u_curve_scale;
uniform float u_trail_width;
uniform float u_lobe_spread;
uniform float u_chaos;
uniform float u_density;
uniform float u_detail;
uniform float u_flight_speed;
uniform float u_flight_depth;
uniform float u_orbit_radius;
uniform float u_orbit_spin;
uniform float u_motion_mode;
uniform float u_motion_phase;
uniform float u_ribbon_twist;
uniform float u_phase_drift;
uniform float u_roll;
uniform float u_roll_speed;
uniform float u_fov;
uniform float u_color_speed;
uniform float u_palette;
uniform float u_shade_mode;
uniform float u_fog;
uniform float u_glow;

float phaseOffset() {
    return u_motion_phase * 6.28318530718;
}

float attractorMode() {
    return clamp(floor(u_attractor_mode + 0.5), 0.0, 3.0);
}

vec3 paletteAttractor(float t, float paletteMode) {
    t = fract(t);
    if (paletteMode > 3.5) return psyLutLinear(t);
    // The cosine palettes do not end on the colour they start with: run them
    // there and back so a wrap of t has no jump.
    t = 1.0 - abs(1.0 - 2.0 * t);
    if (paletteMode < 0.5) {
        return palette(t, vec3(0.10, 0.12, 0.30), vec3(0.38, 0.42, 0.68), vec3(0.60, 0.90, 1.0), vec3(0.02, 0.22, 0.44));
    } else if (paletteMode < 1.5) {
        return palette(t, vec3(0.34, 0.18, 0.08), vec3(0.58, 0.36, 0.16), vec3(1.00, 0.70, 0.32), vec3(0.04, 0.18, 0.38));
    } else if (paletteMode < 2.5) {
        return palette(t, vec3(0.05, 0.20, 0.38), vec3(0.22, 0.52, 0.70), vec3(0.42, 0.82, 1.00), vec3(0.08, 0.32, 0.58));
    }
    return palette(t, vec3(0.36, 0.12, 0.24), vec3(0.60, 0.28, 0.42), vec3(1.00, 0.46, 0.72), vec3(0.00, 0.18, 0.40));
}

float sdSegment(vec3 p, vec3 a, vec3 b) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
    return length(pa - ba * h);
}

vec3 attractorDerivative(vec3 p, float mode) {
    float chaosBias = u_chaos - 0.78;
    if (mode < 0.5) {
        float sigma = 10.0;
        float rho = 28.0 + chaosBias * 3.5;
        float beta = 2.6666666667;
        return vec3(sigma * (p.y - p.x), p.x * (rho - p.z) - p.y, p.x * p.y - beta * p.z);
    }
    if (mode < 1.5) {
        float b = clamp(0.208186 - chaosBias * 0.028, 0.14, 0.30);
        return vec3(sin(p.y) - b * p.x, sin(p.z) - b * p.y, sin(p.x) - b * p.z);
    }
    if (mode < 2.5) {
        float a = 0.95 + chaosBias * 0.045;
        float b = 0.70;
        float c = 0.60;
        float d = 3.50 + chaosBias * 0.30;
        float e = 0.25;
        float f = 0.10;
        float radius2 = p.x * p.x + p.y * p.y;
        return vec3(
            (p.z - b) * p.x - d * p.y,
            d * p.x + (p.z - b) * p.y,
            c + a * p.z - p.z * p.z * p.z / 3.0 - radius2 * (1.0 + e * p.z) + f * p.z * p.x * p.x * p.x
        );
    }
    float a = 0.20;
    float b = 0.20;
    float c = 5.70 + chaosBias * 0.75;
    return vec3(-p.y - p.z, p.x + a * p.y, b + p.z * (p.x - c));
}

float attractorDt(float mode) {
    if (mode < 0.5) return 0.012;
    if (mode < 1.5) return 0.060;
    if (mode < 2.5) return 0.030;
    return 0.060;
}

vec3 attractorAdvance(vec3 p, float mode) {
    float dt = attractorDt(mode);
    // Midpoint integration is stable enough for the raymarch while retaining
    // the named continuous systems' trajectories.
    vec3 k1 = attractorDerivative(p, mode);
    vec3 k2 = attractorDerivative(p + k1 * (dt * 0.5), mode);
    return clamp(p + k2 * dt, vec3(-120.0), vec3(120.0));
}

vec3 attractorSeed(float mode, float phase) {
    if (mode < 0.5) return vec3(-8.0 + 0.18 * sin(phase), 8.0, 27.0);
    if (mode < 1.5) return vec3(1.10, 0.05 * sin(phase), 0.0);
    if (mode < 2.5) return vec3(0.10, 0.02 * cos(phase), 0.0);
    return vec3(0.10, 0.04 * sin(phase), 0.0);
}

vec3 attractorView(vec3 p, float mode, float phase) {
    vec3 q;
    if (mode < 0.5) q = vec3(p.x / 9.0, (p.z - 25.0) / 12.0, p.y / 9.0);
    else if (mode < 1.5) q = p / 1.4;
    else if (mode < 2.5) q = p / 1.1;
    else q = vec3(p.x / 4.5, (p.z - 5.0) / 6.0, p.y / 4.5);
    q.xz *= u_lobe_spread;
    q.xy = rot2(u_ribbon_twist * 0.18 + phase * 0.03) * q.xy;
    q.yz = rot2(u_ribbon_twist * 0.11 + u_chaos * 0.08) * q.yz;
    return q * u_curve_scale;
}

// Glow volume around the CPU-fed trajectory (u_attr_points).
vec2 fedDensity(vec3 p, float phase) {
    float mode = attractorMode();
    float width = max(u_trail_width, 0.01) * 0.75;
    float density = 0.0;
    float hue = 0.0;
    float n = clamp(u_attr_count, 2.0, 120.0);
    vec3 prev = attractorView(u_attr_points[0], mode, phase);
    for (int i = 1; i < 120; i++) {
        float fi = float(i);
        if (fi >= n) break;
        vec3 cur = attractorView(u_attr_points[i], mode, phase);
        float d = sdSegment(p, prev, cur);
        float line = exp(-d * d / max(width * width, 0.00001));
        float s = fi / n;
        density += line * (0.8 + 0.2 * sin(s * 30.0 + phase));
        hue += line * (s + mode * 0.12);
        prev = cur;
    }
    return vec2(density * u_density * 0.55, hue / max(density + 0.001, 0.001));
}

vec2 attractorDensity(vec3 p, float phase) {
    if (u_attr_count > 1.5) return fedDensity(p, phase);
    float mode = attractorMode();
    float steps = clamp(u_orbit_steps, 8.0, 48.0);
    float width = max(u_trail_width, 0.01);
    float density = 0.0;
    float hue = 0.0;
    vec3 orbit = attractorSeed(mode, phase);
    for (int warm = 0; warm < 14; warm++) orbit = attractorAdvance(orbit, mode);
    vec3 prev = attractorView(orbit, mode, phase);
    for (int i = 1; i < 50; i++) {
        if (float(i) > steps) break;
        float s = float(i) / steps;
        orbit = attractorAdvance(attractorAdvance(orbit, mode), mode);
        vec3 cur = attractorView(orbit, mode, phase);
        float d = sdSegment(p, prev, cur);
        float line = exp(-d * d / max(width * width, 0.00001));
        float bead = exp(-length(p - cur) * length(p - cur) / max(width * width * 2.8, 0.00001));
        density += line * (0.75 + 0.25 * sin(s * 24.0 + phase)) + bead * 0.25;
        hue += (line + bead) * (s + mode * 0.12);
        prev = cur;
    }
    float filaments = abs(sin(p.x * 8.0 + phase) * sin(p.y * 7.0 - phase * 0.7) * sin(p.z * 6.0 + mode));
    density += smoothstep(0.86, 1.0, filaments) * 0.08 * u_detail;
    return vec2(density * u_density / steps, hue / max(density + 0.001, 0.001));
}

vec3 targetOffset(float mode, float t) {
    if (mode < 0.5) return vec3(0.0, 0.05, 0.0);
    if (mode < 1.5) return vec3(0.10 * sin(t * 0.20), 0.02, 0.12 * cos(t * 0.18));
    if (mode < 2.5) return vec3(-0.06 + 0.16 * sin(t * 0.22), 0.06, 0.10 * cos(t * 0.17));
    return vec3(0.08 * sin(t * 0.18), -0.02, 0.14 * cos(t * 0.16));
}

vec3 backgroundAttractor(vec3 rd, float t) {
    float halo = pow(max(0.0, 1.0 - abs(rd.x * 0.55 + rd.y * 0.26)), 6.0);
    return vec3(0.006, 0.008, 0.015) + paletteAttractor(t * 0.022 + rd.z * 0.08, u_palette) * halo * 0.050;
}

void main() {
    float mode = attractorMode();
    float t = u_time * u_flight_speed + phaseOffset() + seedPhase() * 0.08;
    float phase = t * (0.08 + u_phase_drift * 0.10) + mode * 0.74;
    float spinT = u_time * u_orbit_spin + phaseOffset() + mode * 0.84 + seedPhase() * 0.08;
    float rollT = u_time * u_roll_speed + phaseOffset() + mode;
    float dive = sin(t * 0.27 + mode) * u_flight_depth;
    float radius = u_orbit_radius * (1.0 + 0.10 * sin(spinT * 0.17 + mode));
    vec3 target = targetOffset(mode, t);

    vec3 orbitPath = vec3(sin(spinT * 0.34 + mode) * radius, 0.28 + cos(t * 0.24 + mode) * 0.32, 2.78 - dive + cos(spinT * 0.34 + mode) * radius * 0.34);
    vec3 figurePath = vec3(sin(spinT * 0.40 + mode) * radius * 0.92, 0.20 + sin(t * 0.72 + mode) * 0.30, 2.56 - dive * 0.68 + sin(spinT * 0.40) * cos(spinT * 0.40) * radius * 0.68);
    vec3 tunnelPath = vec3(sin(spinT * 0.24 + mode) * radius * 0.50, 0.14 + cos(t * 0.33 + mode) * 0.22, 2.08 - dive * 1.18 + cos(spinT * 0.24 + mode) * radius * 0.20);
    vec3 grazePath = vec3(sin(spinT * 0.29 + mode) * radius * 0.64, 0.07 + cos(t * 0.46 + mode) * 0.18, 1.86 - dive * 0.56 + cos(spinT * 0.29 + mode) * radius * 0.24);
    vec3 ro = orbitPath;
    if (u_motion_mode >= 0.5 && u_motion_mode < 1.5) ro = figurePath;
    else if (u_motion_mode >= 1.5 && u_motion_mode < 2.5) ro = tunnelPath;
    else if (u_motion_mode >= 2.5) ro = grazePath;
    ro.xz = rot2(mode * 0.38 + spinT * 0.11) * ro.xz;

    float rollValue = u_roll * sin(rollT * 0.48 + mode) + u_global_rotation * 0.2;
    vec3 rd = psyRayDirection(gl_FragCoord.xy, u_resolution, ro, target, u_fov, rollValue);
    vec3 col = backgroundAttractor(rd, t);
    float alpha = 0.0;
    float travel = 0.0;
    float maxDist = 5.8 + u_flight_depth * 0.55;
    int maxSteps = int(40.0 + u_detail * 22.0);
    for (int i = 0; i < 92; i++) {
        if (i >= maxSteps) break;
        float fi = float(i);
        float stepSize = maxDist / float(maxSteps);
        travel = fi * stepSize;
        vec3 p = ro + rd * travel;
        p.xy = rot2(u_ribbon_twist * 0.08 * travel + t * 0.018) * p.xy;
        vec2 d = attractorDensity(p, phase);
        float local = clamp(d.x * stepSize * 3.65, 0.0, 0.46);
        vec3 lineCol = paletteAttractor(d.y + t * u_color_speed * 0.044 + mode * 0.12, u_palette);
        if (u_shade_mode >= 0.5 && u_shade_mode < 1.5) {
            lineCol *= 0.66 + 0.72 * sin(d.y * 24.0 + t * 0.7) * 0.5 + 0.36;
        } else if (u_shade_mode >= 1.5 && u_shade_mode < 2.5) {
            lineCol = mix(lineCol, vec3(1.0, 0.82, 0.55), smoothstep(0.05, 0.35, d.x) * 0.48);
        } else if (u_shade_mode >= 2.5) {
            lineCol = mix(lineCol, paletteAttractor(fract(fi * 0.037 + d.y), u_palette), 0.58);
        }
        col += (1.0 - alpha) * lineCol * local * (1.12 + u_glow * 0.34);
        alpha += (1.0 - alpha) * local * 0.60;
    }

    float fogAmount = 1.0 - exp(-travel * (0.042 + u_fog * 0.074));
    col = mix(col, backgroundAttractor(rd, t) + paletteAttractor(t * 0.02, u_palette) * 0.044, fogAmount * 0.62);
    col = psyGamma(psyTonemap(col));
    FRAG_OUT = vec4(col, 1.0);
}
`}),{StrangeAttractorFeed:_}}export{w as default};
