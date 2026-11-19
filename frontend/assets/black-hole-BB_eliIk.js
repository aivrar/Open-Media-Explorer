function a(e){return e.EffectRegistry.register({name:"black_hole",label:"Black Hole",category:"Cosmic",description:"Gravitationally lensed accretion disk, photon ring and bent starlight around a black hole",params:[{name:"distance",label:"Camera Distance",min:6,max:30,default:15,step:.1},{name:"inclination",label:"Camera Height",min:-.9,max:.9,default:.1,step:.01},{name:"orbit_speed",label:"Orbit Speed",min:-2,max:2,default:.3,step:.01},{name:"disk_speed",label:"Disk Spin",min:0,max:4,default:1,step:.01},{name:"disk_brightness",label:"Disk Brightness",min:.1,max:3,default:1.2,step:.01},{name:"disk_size",label:"Disk Size",min:5,max:20,default:11,step:.1},{name:"doppler",label:"Doppler Beaming",min:0,max:1.5,default:.8,step:.01},{name:"lensing",label:"Lensing",min:0,max:1.5,default:1,step:.01},{name:"stars",label:"Stars",min:0,max:2,default:1,step:.01},{name:"scheme",label:"Disk Colour",type:"select",options:["Interstellar Gold","Blue Giant","Neon Violet","Ember"],default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_distance;
uniform float u_inclination;
uniform float u_orbit_speed;
uniform float u_disk_speed;
uniform float u_disk_brightness;
uniform float u_disk_size;
uniform float u_doppler;
uniform float u_lensing;
uniform float u_stars;
uniform float u_scheme;
uniform float u_audio_react;
uniform vec4 u_audio;
uniform vec4 u_beat;

vec3 diskColor(float temp) {
    float s = floor(u_scheme + 0.5);
    vec3 cool, hot;
    if (s < 0.5) { cool = vec3(0.55, 0.12, 0.02); hot = vec3(1.0, 0.78, 0.45); }
    else if (s < 1.5) { cool = vec3(0.15, 0.25, 0.9); hot = vec3(0.85, 0.92, 1.0); }
    else if (s < 2.5) { cool = vec3(0.55, 0.05, 0.75); hot = vec3(0.3, 0.95, 1.0); }
    else { cool = vec3(0.35, 0.02, 0.0); hot = vec3(1.0, 0.45, 0.08); }
    return mix(cool, hot, temp) + vec3(1.0) * pow(temp, 6.0) * 0.6;
}

vec3 starfield(vec3 dir, float twinkle) {
    vec2 sph = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0)));
    vec3 col = vec3(0.0);
    for (int l = 0; l < 2; l++) {
        float sc = 90.0 + float(l) * 110.0;
        vec2 g = sph * sc / 3.14159;
        vec2 id = floor(g);
        float h = hash2(id + float(l) * 31.0);
        if (h > 0.985 - 0.01 * float(l)) {
            vec2 f = fract(g) - 0.5 - (hash3(id).xy - 0.5) * 0.6;
            float b = smoothstep(0.12, 0.0, length(f)) * (0.4 + 0.6 * hash(h * 13.0));
            b *= 0.7 + 0.3 * sin(u_time * (3.0 + h * 5.0) + h * 40.0) * twinkle;
            col += mix(vec3(1.0, 0.85, 0.7), vec3(0.7, 0.85, 1.0), fract(h * 7.0)) * b;
        }
    }
    float neb = clamp(snoise2(sph * 1.3 + 7.0) * 0.5 + 0.5, 0.0, 1.0);
    col += vec3(0.25, 0.08, 0.35) * pow(neb, 3.0) * 0.25 + vec3(0.05, 0.1, 0.2) * pow(1.0 - neb, 4.0) * 0.2;
    return col;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float react = u_audio_react;
    float bass = u_audio.x * react;
    float kick = u_beat.x * react;
    float hat = u_beat.z * react;
    float t = u_time;

    float camA = t * u_orbit_speed * 0.1;
    float inc = u_inclination;
    vec3 ro = u_distance * vec3(sin(camA) * cos(inc), sin(inc), cos(camA) * cos(inc));
    vec3 rd = psyLookAt(ro, vec3(0.0), 0.0) * normalize(vec3(uv, 1.7));

    vec3 pos = ro;
    vec3 vel = rd;
    vec3 hv = cross(pos, vel);
    float h2 = dot(hv, hv);
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    float inner = 2.6;
    float outer = u_disk_size;
    bool captured = false;
    float heat = 1.0 + bass * 0.8 + kick * 0.6;

    for (int i = 0; i < 220; i++) {
        float r = length(pos);
        float dt = clamp(0.06 * r, 0.025, 0.7);
        vec3 prev = pos;
        vel += -1.5 * h2 * pos / pow(r, 5.0) * u_lensing * dt;
        pos += vel * dt;
        // Photon ring: light skimming the photon sphere at r = 1.5
        col += (1.0 - alpha) * diskColor(0.9) * exp(-abs(r - 1.5) * 10.0) * dt * 0.05 * (1.0 + kick * 2.5);
        if (prev.y * pos.y < 0.0) {
            vec3 hit = mix(prev, pos, prev.y / (prev.y - pos.y));
            float hr = length(hit.xz);
            if (hr > inner && hr < outer) {
                float temp = clamp(pow(inner / hr, 0.9), 0.0, 1.0);
                float ang = atan(hit.z, hit.x);
                float rot = ang - t * u_disk_speed * 3.0 / pow(hr, 1.5);
                // Noise on a circle in the disk angle, so it joins up where atan wraps.
                vec2 ring = vec2(cos(rot), sin(rot));
                float tex = 0.55 + 0.45 * snoise(vec3(ring * 2.5, hr * 1.6)) + 0.25 * snoise(vec3(ring * 6.0, hr * 4.0));
                tex *= 0.75 + 0.25 * sin(hr * 7.0 + tex * 3.0);
                vec3 vd = normalize(vec3(-hit.z, 0.0, hit.x)) * sqrt(1.0 / hr);
                float dop = pow(max(1.0 + dot(vd, -normalize(vel)) * 1.4 * u_doppler, 0.05), 3.0);
                float edge = smoothstep(inner, inner + 0.6, hr) * smoothstep(outer, outer - 3.0, hr);
                float dens = clamp(tex, 0.0, 1.5) * edge;
                vec3 c = diskColor(temp) * dens * dop * u_disk_brightness * heat * (0.6 + temp * 1.4);
                float a = clamp(dens * 0.9, 0.0, 1.0);
                col += (1.0 - alpha) * c * a;
                alpha += (1.0 - alpha) * a;
                if (alpha > 0.98) break;
            }
        }
        if (r < 1.0) { captured = true; break; }
        if (r > u_distance * 2.5 && dot(pos, vel) > 0.0) break;
    }
    if (!captured) col += (1.0 - alpha) * starfield(normalize(vel), 1.0 + hat * 2.0) * u_stars;
    col = 1.0 - exp(-col * 1.4);
    FRAG_OUT = vec4(pow(col, vec3(0.92)), 1.0);
}
`}),{}}export{a as default};
