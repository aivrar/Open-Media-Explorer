function o(e){return e.EffectRegistry.register({name:"synthwave",label:"Synthwave Grid",category:"Retro",description:"Outrun horizon with a striped sun, mountains, stars and an endless neon grid",params:[{name:"speed",label:"Speed",min:0,max:4,default:1,step:.05},{name:"grid_density",label:"Grid Density",min:4,max:40,default:14,step:1},{name:"horizon",label:"Horizon",min:.3,max:.7,default:.48,step:.01},{name:"sun_size",label:"Sun Size",min:.08,max:.5,default:.26,step:.01},{name:"mountains",label:"Mountains",min:0,max:1,default:.8,step:.05},{name:"glow",label:"Glow",min:0,max:2,default:1,step:.05},{name:"curve",label:"Road Curve",min:-1,max:1,default:.2,step:.02},{name:"scheme",label:"Color Scheme",type:"select",options:["Outrun","Miami Vice","Toxic Night","Blood Moon","Ice Laser"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_grid_density;
uniform float u_horizon;
uniform float u_sun_size;
uniform float u_mountains;
uniform float u_glow;
uniform float u_curve;
uniform float u_scheme;

void scheme(out vec3 skyTop, out vec3 skyLow, out vec3 sunA, out vec3 sunB, out vec3 grid) {
    float s = floor(u_scheme + 0.5);
    if (s < 0.5) { skyTop = vec3(0.05, 0.0, 0.15); skyLow = vec3(0.55, 0.05, 0.45); sunA = vec3(1.0, 0.9, 0.2); sunB = vec3(1.0, 0.1, 0.5); grid = vec3(1.0, 0.2, 0.9); }
    else if (s < 1.5) { skyTop = vec3(0.0, 0.05, 0.2); skyLow = vec3(1.0, 0.45, 0.6); sunA = vec3(1.0, 0.95, 0.6); sunB = vec3(1.0, 0.35, 0.55); grid = vec3(0.1, 0.95, 1.0); }
    else if (s < 2.5) { skyTop = vec3(0.0, 0.03, 0.02); skyLow = vec3(0.1, 0.4, 0.1); sunA = vec3(0.8, 1.0, 0.2); sunB = vec3(0.1, 0.9, 0.4); grid = vec3(0.3, 1.0, 0.2); }
    else if (s < 3.5) { skyTop = vec3(0.04, 0.0, 0.0); skyLow = vec3(0.45, 0.02, 0.05); sunA = vec3(1.0, 0.5, 0.2); sunB = vec3(0.7, 0.0, 0.05); grid = vec3(1.0, 0.15, 0.1); }
    else { skyTop = vec3(0.0, 0.02, 0.08); skyLow = vec3(0.2, 0.5, 0.8); sunA = vec3(0.9, 1.0, 1.0); sunB = vec3(0.3, 0.6, 1.0); grid = vec3(0.4, 0.9, 1.0); }
}

float mountainHeight(float x, float layer) {
    float h = 0.0;
    float amp = 0.5;
    float f = 2.0 + layer * 1.7;
    for (int i = 0; i < 4; i++) {
        h += amp * abs(snoise(vec3(x * f, layer * 5.0, 0.0)));
        f *= 2.1;
        amp *= 0.5;
    }
    return h;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float aspect = u_resolution.x / u_resolution.y;
    vec3 skyTop, skyLow, sunA, sunB, gridCol;
    scheme(skyTop, skyLow, sunA, sunB, gridCol);
    float t = u_time * u_speed;
    float hz = u_horizon;
    vec3 col;

    if (uv.y > hz) {
        float sy = (uv.y - hz) / (1.0 - hz);
        col = mix(skyLow, skyTop, pow(sy, 0.6));
        // Stars
        vec2 sp = uv * vec2(aspect, 1.0) * 140.0;
        float star = step(0.993, hash2(floor(sp))) * smoothstep(0.5, 0.0, length(fract(sp) - 0.5)) * smoothstep(0.1, 0.6, sy);
        col += vec3(1.0) * star * (0.5 + 0.5 * sin(t * 3.0 + hash2(floor(sp)) * 20.0));
        // Sun with retro cut stripes
        vec2 sc = vec2((uv.x - 0.5) * aspect, uv.y - hz - u_sun_size * 0.55);
        float r = length(sc);
        float sun = 1.0 - smoothstep(u_sun_size - 0.004, u_sun_size + 0.004, r);
        float cutY = (sc.y + u_sun_size) / (2.0 * u_sun_size);
        float bands = step(0.5, fract(cutY * 9.0 - t * 0.15)) + step(0.45, cutY);
        sun *= clamp(bands, 0.0, 1.0);
        vec3 sunCol = mix(sunB, sunA, clamp(cutY, 0.0, 1.0));
        col = mix(col, sunCol, sun);
        col += sunCol * exp(-max(r - u_sun_size, 0.0) * 9.0) * 0.35 * u_glow;
        // Mountain layers
        for (int l = 0; l < 2; l++) {
            float fl = float(l);
            float mh = mountainHeight(uv.x * aspect * 0.35 + fl * 3.1 + t * 0.002 * (fl + 1.0), fl) * (0.16 - fl * 0.05) * u_mountains;
            if (uv.y - hz < mh) {
                vec3 mc = mix(vec3(0.02, 0.0, 0.05), skyLow * 0.35, fl * 0.5);
                float rim = smoothstep(0.004, 0.0, abs(uv.y - hz - mh));
                col = mc + gridCol * rim * 0.6 * u_glow;
            }
        }
    } else {
        // Ground plane: project the screen row back to depth.
        float y = (hz - uv.y);
        float z = 1.0 / max(y, 0.0008);
        float x = (uv.x - 0.5) * aspect * z;
        x += u_curve * z * z * 0.02 * sin(t * 0.2);
        vec2 g = vec2(x, z + t * 6.0) * (u_grid_density / 14.0);
        vec2 gf = abs(fract(g) - 0.5);
        float lw = 0.03 * z * 0.12 + 0.012;
        float line = max(1.0 - smoothstep(0.0, lw, gf.x * 2.0 / z * 4.0), 1.0 - smoothstep(0.0, lw * 2.0, gf.y));
        float fade = exp(-z * 0.035);
        col = vec3(0.01, 0.0, 0.03) + gridCol * line * fade * (1.2 + u_glow * 0.6);
        col += skyLow * 0.25 * exp(-y * 14.0);
    }
    col += skyLow * 0.15 * exp(-abs(uv.y - hz) * 60.0) * u_glow;
    FRAG_OUT = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`}),{}}export{o as default};
