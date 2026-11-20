function w(x){x.PostProcess;var m=x.PsyPalettes;return{PostFxLibrary:(function(){"use strict";var b=["Distort","Feedback","Colour","Stylize","Glow & Blur","Lens & Retro"],g=["Free Run","Kick","Snare","Beat","Bar","Drops (Studio)","Hi-hat"],_=`vec3 hueRot(vec3 c, float a) {
    vec3 k = vec3(0.57735);
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
`,l=`vec2 mirrorUV(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
`,v=`vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`,a=`float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`,y=`uniform sampler2D u_tex;
uniform vec2 u_resolution;
uniform float u_time;
`;function k(o,r){var c=y+(r||"");return Object.keys(o).forEach(function(s){c+="uniform float u_"+s+`;
`}),c}function n(o,r,c){return{label:o,type:"select",options:r,min:0,max:r.length-1,default:c||0,step:1}}function e(o,r,c,s,u,d){var h={label:o,min:r,max:c,default:s,step:u||.01};return d&&(h.type=d),h}function i(o){return o.center_x=e("Centre X",0,1,.5,.01),o.center_y=e("Centre Y",0,1,.5,.01),o}var p=[];function t(o){o.src=k(o.params,o.extraUniforms)+o.body,delete o.body,p.push(o)}t({name:"mirror",label:"Mirror",category:"Distort",params:i({mode:n("Mode",["Horizontal","Vertical","Quad","Kaleidoscope","Diagonal"]),segments:e("Segments",2,16,6,1,"int"),rotation:e("Rotation",0,1,0,.01),spin:e("Spin Speed",-1,1,0,.01),zoom:e("Zoom",.25,4,1,.01)}),react:{rotation:["lfo_4bar",.25]},body:l+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 c = vec2(u_center_x, u_center_y);
    vec2 p = v_uv - c;
    p.x *= aspect;
    float ang = (u_rotation + u_spin * u_time) * 6.28318;
    float cs = cos(ang), sn = sin(ang);
    p = mat2(cs, -sn, sn, cs) * p / max(u_zoom, 0.05);
    float m = floor(u_mode + 0.5);
    if (m < 0.5) p.x = -abs(p.x);
    else if (m < 1.5) p.y = -abs(p.y);
    else if (m < 2.5) p = -abs(p);
    else if (m < 3.5) {
        float a = atan(p.y, p.x);
        float r = length(p);
        float seg = 6.28318 / max(2.0, floor(u_segments + 0.5));
        a = mod(a, seg);
        if (a > seg * 0.5) a = seg - a;
        p = vec2(cos(a), sin(a)) * r;
    } else if (p.y > p.x) {
        p = p.yx;
    }
    p.x /= aspect;
    gl_FragColor = texture2D(u_tex, mirrorUV(p + c));
}`}),t({name:"droste",label:"Droste Tunnel",category:"Distort",hint:"Repeats the picture inside itself as an endless zooming spiral.",params:{zoom_speed:e("Zoom Speed",-2,2,.35,.01),scale:e("Repeat Scale",1.5,8,3,.05),twist:e("Spiral Arms",-3,3,1,1,"int"),spin:e("Spin Speed",-1,1,0,.01),mix:e("Mix",0,1,1,.01)},react:{scale:["kick",.12]},body:l+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = v_uv - 0.5;
    p.x *= aspect;
    float r = max(length(p), 1e-4);
    float a = atan(p.y, p.x);
    float period = log(max(u_scale, 1.05));
    float lr = log(r) + a / 6.28318 * period * floor(u_twist + 0.5);
    float top = log(0.5);
    lr = top - mod(top - lr + u_time * u_zoom_speed * period, period);
    a += u_time * u_spin * 6.28318;
    vec2 q = vec2(cos(a), sin(a)) * exp(lr);
    q.x /= aspect;
    vec3 col = texture2D(u_tex, mirrorUV(q + 0.5)).rgb;
    gl_FragColor = vec4(mix(texture2D(u_tex, v_uv).rgb, col, u_mix), 1.0);
}`}),t({name:"swirl",label:"Swirl",category:"Distort",params:i({strength:e("Strength",-2,2,.6,.01),radius:e("Radius",.05,1.5,.6,.01),wobble:e("Wobble",0,1,.3,.01),speed:e("Wobble Speed",0,4,1,.05)}),react:{strength:["bass",.2]},body:l+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 c = vec2(u_center_x, u_center_y);
    vec2 p = v_uv - c;
    p.x *= aspect;
    float k = 1.0 - smoothstep(0.0, max(u_radius, 0.01), length(p));
    float s = u_strength * (1.0 + u_wobble * sin(u_time * u_speed));
    float ang = s * k * k * 6.28318;
    float cs = cos(ang), sn = sin(ang);
    p = mat2(cs, -sn, sn, cs) * p;
    p.x /= aspect;
    gl_FragColor = texture2D(u_tex, mirrorUV(p + c));
}`}),t({name:"wave",label:"Wave Warp",category:"Distort",params:{mode:n("Mode",["Horizontal Waves","Vertical Waves","Ripples","Liquid"],3),amplitude:e("Amplitude",0,.1,.015,.001),frequency:e("Frequency",1,60,10,.5),speed:e("Speed",-5,5,1,.05),turbulence:e("Turbulence",0,1,.25,.01)},react:{amplitude:["bass",.35]},body:l+`void main() {
    vec2 uv = v_uv;
    float t = u_time * u_speed;
    float F = u_frequency;
    float m = floor(u_mode + 0.5);
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 d;
    if (m < 0.5) d = vec2(sin(uv.y * F + t), 0.0);
    else if (m < 1.5) d = vec2(0.0, sin(uv.x * F + t));
    else if (m < 2.5) {
        vec2 p = uv - 0.5;
        p.x *= aspect;
        float r = length(p);
        vec2 n = p / max(r, 1e-4);
        n.x /= aspect;
        d = n * sin(r * F * 2.0 - t * 2.0);
    } else {
        d = vec2(sin(uv.y * F + t + sin(uv.x * F * 0.7 - t * 0.6)),
                 cos(uv.x * F * 0.9 - t * 0.8 + sin(uv.y * F * 0.5 + t)));
    }
    d += u_turbulence * 0.5 * vec2(sin(uv.y * F * 2.3 - t * 1.7 + uv.x * 3.1), cos(uv.x * F * 2.1 + t * 1.3 - uv.y * 2.7));
    gl_FragColor = texture2D(u_tex, mirrorUV(uv + d * u_amplitude));
}`}),t({name:"fisheye",label:"Lens Bulge",category:"Distort",params:i({strength:e("Bulge / Pinch",-1,1,.45,.01),radius:e("Radius",.1,1.5,.7,.01)}),react:{strength:["kick",.3]},body:l+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 c = vec2(u_center_x, u_center_y);
    vec2 p = v_uv - c;
    p.x *= aspect;
    float rr = length(p) / max(u_radius, 0.01);
    if (rr < 1.0) p *= pow(max(rr, 1e-4), u_strength * 0.9);
    p.x /= aspect;
    gl_FragColor = texture2D(u_tex, mirrorUV(p + c));
}`}),t({name:"shockwave",label:"Shockwave",category:"Distort",hint:"A ripple ring fired by the beat. Without audio it uses the interval.",options:{trigger:!0},params:i({sync:n("Fire On",g,1),interval:e("Interval (sec)",.2,4,1,.05),strength:e("Strength",0,.15,.06,.001),width:e("Ring Width",.01,.3,.06,.005),speed:e("Ring Speed",.2,3,1.1,.05),glow:e("Ring Glow",0,1,.4,.01),chroma:e("Colour Fringe",0,1,.4,.01)}),extraUniforms:`uniform float u_age;
`,react:{strength:["bass",.2]},body:l+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = v_uv - vec2(u_center_x, u_center_y);
    p.x *= aspect;
    float r = length(p);
    float x = (r - u_age * u_speed) / max(u_width, 0.005);
    float env = exp(-u_age * 2.2);
    float ring = exp(-x * x);
    vec2 off = p / max(r, 1e-4) * (-x * ring * u_strength * env);
    off.x /= aspect;
    vec3 col;
    col.r = texture2D(u_tex, mirrorUV(v_uv + off * (1.0 + u_chroma))).r;
    col.g = texture2D(u_tex, mirrorUV(v_uv + off)).g;
    col.b = texture2D(u_tex, mirrorUV(v_uv + off * (1.0 - u_chroma))).b;
    col += ring * env * u_glow * 0.35;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`}),t({name:"zoom_blur",label:"Zoom Blur",category:"Distort",params:i({mode:n("Mode",["Zoom","Spin"]),strength:e("Strength",0,.6,.12,.005),quality:n("Quality",["Fast","Medium","High"],1),glow:e("Streak Glow",0,1.5,.3,.01)}),react:{strength:["kick",.45]},body:`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 c = vec2(u_center_x, u_center_y);
    vec2 d = v_uv - c;
    float n = u_quality < 0.5 ? 8.0 : (u_quality < 1.5 ? 16.0 : 28.0);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 28; i++) {
        float fi = float(i);
        if (fi >= n) break;
        float t = fi / max(n - 1.0, 1.0);
        vec2 uv;
        if (u_mode < 0.5) {
            uv = c + d * (1.0 - u_strength * t);
        } else {
            float a = (t - 0.5) * u_strength * 1.2;
            vec2 q = d;
            q.x *= aspect;
            float cs = cos(a), sn = sin(a);
            q = mat2(cs, -sn, sn, cs) * q;
            q.x /= aspect;
            uv = c + q;
        }
        vec3 s = texture2D(u_tex, uv).rgb;
        float w = 1.0 - t * 0.5;
        acc += s * w * (1.0 + u_glow * max(max(s.r, s.g), s.b));
        wsum += w;
    }
    gl_FragColor = vec4(clamp(acc / wsum, 0.0, 1.0), 1.0);
}`}),t({name:"pixelate",label:"Pixelate",category:"Distort",params:{size:e("Pixel Size",1,32,4,1,"int"),shape:n("Shape",["Square","Round Dots","Diamonds"]),gap:e("Gap",0,.8,0,.01)},react:{size:["kick",.25]},body:`void main() {
    float s = max(1.0, u_size);
    vec2 px = v_uv * u_resolution;
    vec2 cc = (floor(px / s) + 0.5) * s;
    vec3 col = texture2D(u_tex, cc / u_resolution).rgb;
    vec2 f = (px - cc) / s;
    float m = floor(u_shape + 0.5);
    float g = 0.5 - clamp(u_gap, 0.0, 0.9) * 0.5;
    float inside = 1.0;
    if (m < 0.5) { if (u_gap > 0.001) inside = step(max(abs(f.x), abs(f.y)), g); }
    else if (m < 1.5) inside = 1.0 - smoothstep(g - 0.06, g, length(f));
    else inside = 1.0 - smoothstep(g - 0.06, g, abs(f.x) + abs(f.y));
    gl_FragColor = vec4(col * inside, 1.0);
}`}),t({name:"heat_haze",label:"Heat Haze & Caustic Light",category:"Distort",hint:"Rising heat shimmer, dancing underwater light nets, or both.",params:{mode:n("Effect",["Heat Haze","Caustic Light","Both"],2),strength:e("Shimmer",0,2,.8,.01),scale:e("Pattern Size",.5,6,2,.05),speed:e("Speed",0,3,1,.01),caustic:e("Light Strength",0,2,.7,.01),hue:e("Light Hue",0,1,.5,.005),mix:e("Mix",0,1,1,.01)},react:{strength:["bass",.2],caustic:["kick",.3]},body:v+`vec2 ch(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float cn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = ch(i).x, b = ch(i + vec2(1.0, 0.0)).x, c = ch(i + vec2(0.0, 1.0)).x, d = ch(i + vec2(1.0, 1.0)).x;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
float net(vec2 p, float t) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 h = ch(i + g);
        vec2 o = 0.5 + 0.42 * sin(t * (0.6 + h * 0.5) + h * 6.28318);
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return 1.0 - smoothstep(0.0, 0.14, d2 - d1);
}
void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 q = vec2(v_uv.x * aspect, v_uv.y) * u_scale;
    float t = u_time * u_speed;
    float m = floor(u_mode + 0.5);
    vec2 uv = v_uv;
    if (m != 1.0) {
        vec2 hz = vec2(cn(q * vec2(1.0, 3.0) - vec2(0.0, t * 1.5)), cn(q * vec2(1.0, 3.0) + vec2(5.2, -t * 1.3))) - 0.5;
        uv += hz * u_strength * 0.012 * (1.25 - v_uv.y * 0.6);
    }
    vec3 col = texture2D(u_tex, uv).rgb;
    if (m != 0.0) {
        vec2 cq = q * 2.0 + vec2(sin(q.y * 0.9 + t * 0.7), cos(q.x * 0.8 - t * 0.6)) * 0.35;
        float light = net(cq, t * 1.2) * 0.7 + net(cq * 1.9 + 4.0, t * 1.5) * 0.4;
        col += hsv2rgb(vec3(u_hue, 0.35, 1.0)) * light * u_caustic * 0.35;
    }
    gl_FragColor = vec4(mix(texture2D(u_tex, v_uv).rgb, clamp(col, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"trails",label:"Feedback Trails",category:"Feedback",options:{history:!0},params:{amount:e("Trail Length",0,.98,.85,.01),zoom:e("Trail Zoom",.96,1.04,1.006,.001),rotate:e("Trail Twist",-.05,.05,.004,.001),hue:e("Hue Drift",-.03,.03,.003,.001),blend:n("Blend",["Lighten","Screen","Smear"]),drift_x:e("Drift X",-.01,.01,0,5e-4),drift_y:e("Drift Y",-.01,.01,0,5e-4)},extraUniforms:`uniform sampler2D u_prev;
uniform float u_fstep;
`,react:{zoom:["kick",.25],hue:["snare",.2]},body:_+`void main() {
    float k = u_fstep;
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 d = v_uv - 0.5;
    d.x *= aspect;
    float c = cos(u_rotate * k), s = sin(u_rotate * k);
    d = mat2(c, -s, s, c) * d / pow(max(u_zoom, 0.5), k);
    d.x /= aspect;
    vec3 prev = texture2D(u_prev, d + 0.5 - vec2(u_drift_x, u_drift_y) * k).rgb;
    if (abs(u_hue) > 0.0001) prev = max(hueRot(prev, u_hue * k * 6.28318), 0.0);
    vec3 cur = texture2D(u_tex, v_uv).rgb;
    float a = clamp(u_amount, 0.0, 0.999);
    vec3 outc;
    // Each blend is x' = m*x + c per 60 fps frame. k frames of it give
    // m^k*x + c*(1 - m^k)/(1 - m), so brightness and length match 60 fps.
    if (u_blend < 0.5) outc = max(cur, prev * pow(a, k));
    else if (u_blend < 1.5) {
        vec3 m = a * (1.0 - cur);
        vec3 mk = pow(m, vec3(k));
        outc = mk * prev + cur * (1.0 - mk) / max(1.0 - m, 1e-4);
    } else {
        float s = a * 0.85, m = s * a, mk = pow(m, k);
        outc = mk * prev + (1.0 - s) * cur * (1.0 - mk) / max(1.0 - m, 1e-4);
    }
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`}),t({name:"rgb_echo",label:"RGB Time Echo",category:"Feedback",hint:"Each colour channel lags behind by a different amount, so moving shapes leave rainbow echoes.",options:{history:!0},params:{mode:n("Echo Colours",["Green + Blue Lag","Red + Blue Lag","Cyan Lag","All Channels"],0),lag1:e("First Lag",0,.98,.65,.01),lag2:e("Second Lag",0,.98,.88,.01),drift:e("Echo Zoom",-.02,.03,.004,5e-4),twist:e("Echo Twist",-.03,.03,0,5e-4),mix:e("Mix",0,1,1,.01)},extraUniforms:`uniform sampler2D u_prev;
uniform float u_fstep;
`,react:{drift:["kick",.15],lag2:["bass",.08]},body:`void main() {
    float k = u_fstep;
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 d = v_uv - 0.5; d.x *= aspect;
    float c = cos(u_twist * k), s = sin(u_twist * k);
    d = mat2(c, -s, s, c) * d / pow(max(1.0 + u_drift, 0.5), k);
    d.x /= aspect;
    vec3 prev = texture2D(u_prev, d + 0.5).rgb;
    vec3 cur = texture2D(u_tex, v_uv).rgb;
    float m = floor(u_mode + 0.5);
    vec3 lag = m < 0.5 ? vec3(0.0, u_lag1, u_lag2) : (m < 1.5 ? vec3(u_lag1, 0.0, u_lag2) : (m < 2.5 ? vec3(0.0, u_lag2, u_lag2) : vec3(u_lag1 * 0.5, u_lag1, u_lag2)));
    // Per 60 fps frame the history weight is mix*lag; k frames give its k-th power.
    vec3 w = pow(clamp(lag * clamp(u_mix, 0.0, 1.0), 0.0, 1.0), vec3(k));
    gl_FragColor = vec4(mix(cur, prev, w), 1.0);
}`}),t({name:"slit_scan",label:"Slit-Scan Time Warp",category:"Feedback",hint:"Only a thin slit (or ring) shows the live picture; the past scrolls away from it, stretching time into space.",options:{history:!0},params:{mode:n("Scan",["Horizontal Slit","Vertical Slit","Time Tunnel Outward","Time Tunnel Inward"],0),speed:e("Scan Speed (px per 60 fps frame)",.5,12,2,.1),slit:e("Slit Position",0,1,.5,.01),width:e("Slit Width (px)",1,60,4,.5),mix:e("Mix",0,1,1,.01)},extraUniforms:`uniform sampler2D u_prev;
uniform float u_fstep;
`,react:{speed:["kick",.2]},body:`void main() {
    float spd = u_speed * u_fstep;
    vec2 px = 1.0 / u_resolution;
    vec3 cur = texture2D(u_tex, v_uv).rgb;
    float m = floor(u_mode + 0.5);
    vec3 outc;
    if (m < 1.5) {
        float pos = m < 0.5 ? v_uv.y : v_uv.x;
        float p1 = m < 0.5 ? px.y : px.x;
        float d = pos - u_slit;
        if (abs(d) < u_width * p1 * 0.5) outc = cur;
        else {
            vec2 shift = (m < 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) * sign(d) * spd * p1;
            outc = texture2D(u_prev, v_uv - shift).rgb;
        }
    } else {
        float aspect = u_resolution.x / max(u_resolution.y, 1.0);
        vec2 q = (v_uv - 0.5) * vec2(aspect, 1.0);
        float r = length(q);
        float ring = 0.04 + u_slit * 0.6;
        float s = spd * px.y / max(r, 1e-3);
        bool inner = r < ring;
        // Outward: live inside the ring, the past moves out. Inward: live outside, the past moves in.
        if (m < 2.5) outc = inner ? cur : texture2D(u_prev, q * (1.0 - s) / vec2(aspect, 1.0) + 0.5).rgb;
        else outc = inner ? texture2D(u_prev, q * (1.0 + s) / vec2(aspect, 1.0) + 0.5).rgb : cur;
    }
    gl_FragColor = vec4(mix(cur, outc, u_mix), 1.0);
}`}),t({name:"datamosh",label:"Datamosh",category:"Feedback",hint:"Broken-video smearing: blocks drag the old picture along, until a refresh on the beat snaps it back.",options:{history:!0,trigger:!0},params:{sync:n("Refresh On",g,4),interval:e("Refresh Every (free, sec)",.3,8,2,.05),smear:e("Smear",0,3,1,.01),block:e("Block Size",4,64,16,1,"int"),bleed:e("Live Bleed",0,1,.12,.01),jitter:e("Block Jitter",0,1,.3,.01),mix:e("Mix",0,1,1,.01)},extraUniforms:`uniform sampler2D u_prev;
uniform float u_age;
uniform float u_fstep;
`,react:{smear:["bass",.3]},body:a+`float dh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec2 px = 1.0 / u_resolution;
    float bs = max(u_block, 2.0);
    vec2 bid = floor(v_uv * u_resolution / bs);
    vec2 c = (bid + 0.5) * bs * px;
    vec3 cur = texture2D(u_tex, v_uv).rgb;
    float l0 = luma(texture2D(u_tex, c).rgb), l1 = luma(texture2D(u_prev, c).rgb);
    vec2 g = vec2(luma(texture2D(u_tex, c + vec2(bs * px.x, 0.0)).rgb) - luma(texture2D(u_tex, c - vec2(bs * px.x, 0.0)).rgb),
                  luma(texture2D(u_tex, c + vec2(0.0, bs * px.y)).rgb) - luma(texture2D(u_tex, c - vec2(0.0, bs * px.y)).rgb));
    vec2 jit = vec2(dh(bid + floor(u_time * 3.0)), dh(bid + 17.0 + floor(u_time * 3.0))) - 0.5;
    // Per 60 fps frame: drag and live bleed scale with the real frame time.
    vec2 mv = (-g * (l0 - l1) * 60.0 + jit * u_jitter * 0.6) * u_smear * bs * px * u_fstep;
    vec3 smeared = texture2D(u_prev, v_uv - mv).rgb;
    float refresh = 1.0 - smoothstep(0.0, 0.1, u_age);
    // History weight per 60 fps frame is (1 - bleed) * mix; k frames give its k-th power.
    float keep = pow((1.0 - clamp(u_bleed, 0.0, 1.0)) * clamp(u_mix, 0.0, 1.0), u_fstep) * (1.0 - refresh);
    gl_FragColor = vec4(mix(cur, smeared, keep), 1.0);
}`}),t({name:"color_grade",label:"Color Grading",category:"Colour",params:{brightness:e("Brightness",-.5,.5,0,.01),contrast:e("Contrast",.5,2,1,.05),saturation:e("Saturation",0,3,1,.05),hue_shift:e("Hue Shift",0,1,0,.01),gamma:e("Gamma",.4,2.5,1,.01),temperature:e("Temperature",-1,1,0,.01),tint:e("Tint",-1,1,0,.01),vibrance:e("Vibrance",-1,1,0,.01),invert:e("Invert",0,1,0,.01)},react:{saturation:["bass",.2],hue_shift:["lfo_4bar",.5]},body:_+`void main() {
    vec3 c = texture2D(u_tex, v_uv).rgb;
    c = pow(max(c, 0.0), vec3(1.0 / max(u_gamma, 0.05)));
    c += u_brightness;
    c = (c - 0.5) * u_contrast + 0.5;
    c *= vec3(1.0 + u_temperature * 0.25 - u_tint * 0.08, 1.0 + u_tint * 0.2, 1.0 - u_temperature * 0.25 - u_tint * 0.08);
    float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(gray), c, u_saturation);
    float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    c = mix(vec3(gray), c, 1.0 + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
    if (abs(u_hue_shift) > 0.001) c = hueRot(c, u_hue_shift * 6.28318);
    c = mix(c, 1.0 - c, u_invert);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`}),typeof m<"u"&&t({name:"palette_map",label:"Palette Map",category:"Colour",options:{lut:!0},params:{palette:{label:"Palette",min:0,max:m.count-1,default:0,step:1,type:"select",options:m.names()},mix:e("Mix",0,1,.85,.01),spread:e("Spread",.25,4,1,.05),cycle:e("Cycle Speed",-1,1,.05,.01),source:n("Map From",["Brightness","Hue","Both"]),offset:e("Offset",0,1,0,.01),posterize:e("Bands (0 = smooth)",0,16,0,1,"int")},extraUniforms:`uniform sampler2D u_lut;
`,react:{offset:["beat",.25]},body:`vec3 toHsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
void main() {
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float hue = 0.5 - 0.5 * cos(6.28318 * toHsv(c).x);
    float key = u_source < 0.5 ? lum : (u_source < 1.5 ? hue : lum * 0.5 + hue * 0.5);
    if (u_posterize >= 2.0) key = floor(key * u_posterize) / u_posterize;
    float at = key * u_spread + u_time * u_cycle + u_offset;
    vec3 m = texture2D(u_lut, vec2(1.0 - abs(1.0 - 2.0 * fract(at * 0.5)), 0.5)).rgb;
    if (u_source > 0.5) m *= smoothstep(0.0, 0.25, lum) * 0.85 + 0.15;
    gl_FragColor = vec4(mix(c, m, u_mix), 1.0);
}`}),t({name:"color_wash",label:"Acid Colours",category:"Colour",hint:"Rolls the hues across the picture in waves.",params:{mode:n("Pattern",["Radial","Diagonal","By Brightness","Liquid"]),amount:e("Amount",0,1,.6,.01),scale:e("Scale",.2,12,2,.05),speed:e("Speed",-3,3,.5,.01),saturation:e("Saturation",0,2,1.2,.01)},react:{amount:["bass",.35]},body:_+a+`void main() {
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 p = v_uv - 0.5;
    p.x *= aspect;
    float m = floor(u_mode + 0.5);
    float f;
    if (m < 0.5) f = length(p) * u_scale;
    else if (m < 1.5) f = (p.x + p.y) * u_scale * 0.7;
    else if (m < 2.5) f = luma(c) * u_scale;
    else f = (sin(p.x * u_scale * 3.0 + sin(p.y * u_scale * 2.0 + u_time * 0.7)) + cos(p.y * u_scale * 2.6 - u_time * 0.5)) * 0.5;
    vec3 w = max(hueRot(c, (f - u_time * u_speed * 0.2) * 6.28318), 0.0);
    w = max(mix(vec3(luma(w)), w, u_saturation), 0.0);
    gl_FragColor = vec4(clamp(mix(c, w, u_amount), 0.0, 1.0), 1.0);
}`}),t({name:"posterize",label:"Posterize / Toon",category:"Colour",params:{levels:e("Colour Levels",2,16,5,1,"int"),gamma:e("Gamma",.4,2.5,1,.01),ink:e("Ink Outlines",0,1,.6,.01),ink_threshold:e("Ink Threshold",.02,.5,.12,.01),mix:e("Mix",0,1,1,.01)},react:{ink:["snare",.5]},body:a+`void main() {
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float L = max(2.0, floor(u_levels + 0.5)) - 1.0;
    vec3 g = pow(max(c, 0.0), vec3(u_gamma));
    vec3 q = pow(floor(g * L + 0.5) / L, vec3(1.0 / u_gamma));
    vec2 px = 1.0 / u_resolution;
    float gx = luma(texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb) - luma(texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb);
    float gy = luma(texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb) - luma(texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb);
    float edge = length(vec2(gx, gy));
    q *= 1.0 - smoothstep(u_ink_threshold, u_ink_threshold * 1.5 + 0.02, edge) * u_ink;
    gl_FragColor = vec4(mix(c, q, u_mix), 1.0);
}`}),t({name:"vision",label:"Vision Modes",category:"Colour",hint:"See the scene through a thermal camera, night-vision goggles, an X-ray or infrared film.",params:{mode:n("Vision",["Thermal Camera","Night Vision","X-Ray","Infrared Film"],0),gain:e("Gain",.5,3,1.2,.01),noise:e("Sensor Noise",0,1,.25,.01),scanlines:e("Scanlines",0,1,.3,.01),vignette:e("Goggle Mask",0,1,.5,.01),mix:e("Mix",0,1,1,.01)},react:{noise:["hat",.35],gain:["kick",.15]},body:a+`float vh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 ironbow(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(0.0, 0.0, 0.05), vec3(0.2, 0.0, 0.55), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.85, 0.05, 0.35), smoothstep(0.2, 0.5, t));
    c = mix(c, vec3(1.0, 0.55, 0.0), smoothstep(0.45, 0.75, t));
    return mix(c, vec3(1.0, 1.0, 0.85), smoothstep(0.75, 1.0, t));
}
void main() {
    vec2 px = 1.5 / u_resolution;
    vec3 c = texture2D(u_tex, v_uv).rgb;
    vec3 soft = (c * 2.0 + texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb + texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb +
                texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb + texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb) / 6.0;
    float l = clamp(luma(soft) * u_gain, 0.0, 1.5);
    float m = floor(u_mode + 0.5);
    vec2 g = floor(v_uv * u_resolution * 0.5);
    float n = vh(g + floor(u_time * 30.0) * 7.0) - 0.5;
    float scan = 1.0 - u_scanlines * 0.35 * (0.5 + 0.5 * sin(v_uv.y * u_resolution.y * 1.6));
    vec3 outc;
    if (m < 0.5) {
        outc = ironbow(l * 0.95 + n * u_noise * 0.08);
    } else if (m < 1.5) {
        float v = pow(l, 0.8) + n * u_noise * 0.35;
        outc = vec3(0.12, 1.0, 0.3) * v + vec3(0.6, 1.0, 0.6) * smoothstep(0.8, 1.2, l) * 0.5;
        vec2 q = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
        float eye = min(length(q - vec2(0.3, 0.0)), length(q + vec2(0.3, 0.0)));
        outc *= mix(1.0, 1.0 - smoothstep(0.42, 0.5, eye), u_vignette);
    } else if (m < 2.5) {
        float lx = luma(texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb) - luma(texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb);
        float ly = luma(texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb) - luma(texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb);
        float edge = clamp(length(vec2(lx, ly)) * 4.0 * u_gain, 0.0, 1.0);
        float v = pow(clamp(1.0 - l, 0.0, 1.0), 1.4) * 0.85 + edge * 0.5 + n * u_noise * 0.12;
        outc = vec3(0.72, 0.86, 1.0) * v;
    } else {
        vec3 ir = vec3(c.g * 1.2 + c.r * 0.15, c.r * 0.85, c.b * 0.95) * u_gain;
        outc = max(mix(vec3(luma(ir)), ir, 1.35), 0.0) + n * u_noise * 0.08;
    }
    outc *= scan;
    if (m != 1.0) outc *= 1.0 - u_vignette * 0.45 * smoothstep(0.35, 0.8, length(v_uv - 0.5));
    gl_FragColor = vec4(mix(c, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"edge_glow",label:"Edge Glow",category:"Stylize",params:{intensity:e("Intensity",0,3,1,.1),threshold:e("Threshold",0,.5,.1,.01),color_speed:e("Color Speed",0,5,1,.1),mode:n("Mode",["Overlay","Edges Only"]),width:e("Line Width",.5,4,1,.1),color_mode:n("Edge Colour",["Rainbow","Original Colour","White"])},react:{intensity:["kick",.4]},body:`float lumAt(vec2 uv) { return dot(texture2D(u_tex, uv).rgb, vec3(0.333)); }
void main() {
    vec2 px = u_width / u_resolution;
    float tl = lumAt(v_uv + vec2(-px.x, px.y));
    float t  = lumAt(v_uv + vec2(0.0, px.y));
    float tr = lumAt(v_uv + vec2(px.x, px.y));
    float l  = lumAt(v_uv + vec2(-px.x, 0.0));
    float r  = lumAt(v_uv + vec2(px.x, 0.0));
    float bl = lumAt(v_uv + vec2(-px.x, -px.y));
    float b  = lumAt(v_uv + vec2(0.0, -px.y));
    float br = lumAt(v_uv + vec2(px.x, -px.y));
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float edge = sqrt(gx * gx + gy * gy);
    float strength = smoothstep(u_threshold, u_threshold + 0.15, edge);
    vec4 orig = texture2D(u_tex, v_uv);
    vec3 ec;
    if (u_color_mode < 0.5) {
        float hue = fract(edge * 3.0 + u_time * u_color_speed * 0.2);
        ec = clamp(vec3(abs(hue * 6.0 - 3.0) - 1.0, 2.0 - abs(hue * 6.0 - 2.0), 2.0 - abs(hue * 6.0 - 4.0)), 0.0, 1.0);
    } else if (u_color_mode < 1.5) {
        ec = orig.rgb / max(max(max(orig.r, orig.g), orig.b), 0.05);
    } else {
        ec = vec3(1.0);
    }
    if (u_mode < 0.5) gl_FragColor = vec4(orig.rgb + ec * strength * u_intensity, 1.0);
    else gl_FragColor = vec4(ec * strength * min(u_intensity, 1.0), 1.0);
}`}),t({name:"halftone",label:"Halftone",category:"Stylize",params:{size:e("Dot Size",3,40,8,.5),angle:e("Screen Angle",0,1,.125,.005),mode:n("Style",["Ink on Paper","Colour Dots","CMY Print"],1),contrast:e("Contrast",.5,2.5,1.2,.01),mix:e("Mix",0,1,1,.01)},react:{size:["bass",.2]},body:a+`vec3 sampleCell(vec2 px, float ang, float s, out vec2 f) {
    float cs = cos(ang), sn = sin(ang);
    vec2 q = vec2(cs * px.x + sn * px.y, -sn * px.x + cs * px.y) / s;
    vec2 cell = floor(q) + 0.5;
    f = q - cell;
    vec2 cc = cell * s;
    vec2 back = vec2(cs * cc.x - sn * cc.y, sn * cc.x + cs * cc.y);
    return texture2D(u_tex, back / u_resolution).rgb;
}
float dotShape(vec2 f, float v) {
    float r = sqrt(clamp(v, 0.0, 1.0)) * 0.72;
    return 1.0 - smoothstep(r - 0.06, r + 0.06, length(f));
}
void main() {
    vec2 px = v_uv * u_resolution;
    float s = max(2.0, u_size);
    float ang = u_angle * 6.28318;
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    float m = floor(u_mode + 0.5);
    vec3 outc;
    if (m < 1.5) {
        vec2 f;
        vec3 smp = clamp((sampleCell(px, ang, s, f) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
        float l = luma(smp);
        if (m < 0.5) outc = vec3(1.0 - dotShape(f, 1.0 - l)) * vec3(0.96, 0.94, 0.88);
        else outc = smp / max(max(max(smp.r, smp.g), smp.b), 0.001) * dotShape(f, l);
    } else {
        vec2 f1; vec2 f2; vec2 f3;
        vec3 s1 = sampleCell(px, ang + 0.2618, s, f1);
        vec3 s2 = sampleCell(px, ang + 1.309, s, f2);
        vec3 s3 = sampleCell(px, ang, s, f3);
        float cC = dotShape(f1, clamp((0.5 - s1.r) * u_contrast + 0.5, 0.0, 1.0));
        float cM = dotShape(f2, clamp((0.5 - s2.g) * u_contrast + 0.5, 0.0, 1.0));
        float cY = dotShape(f3, clamp((0.5 - s3.b) * u_contrast + 0.5, 0.0, 1.0));
        outc = vec3(1.0 - cC, 1.0 - cM, 1.0 - cY) * vec3(0.97, 0.95, 0.9);
    }
    gl_FragColor = vec4(mix(orig, outc, u_mix), 1.0);
}`}),t({name:"led_wall",label:"LED Wall",category:"Stylize",params:{cell:e("LED Size",3,40,9,.5),roundness:e("Roundness",0,1,1,.01),gap:e("Gap",0,.45,.12,.01),glow:e("Glow",0,1,.4,.01),brightness:e("Brightness",.5,3,1.3,.01)},react:{brightness:["kick",.25]},body:`void main() {
    float s = max(3.0, u_cell);
    vec2 px = v_uv * u_resolution;
    vec2 cc = (floor(px / s) + 0.5) * s;
    vec3 col = texture2D(u_tex, cc / u_resolution).rgb * u_brightness;
    vec2 f = (px - cc) / s;
    float r = 0.5 - clamp(u_gap, 0.0, 0.45);
    float d = mix(max(abs(f.x), abs(f.y)), length(f), u_roundness);
    float led = 1.0 - smoothstep(r - 0.05, r + 0.02, d);
    float halo = exp(-d * d * 18.0) * u_glow;
    gl_FragColor = vec4(clamp(col * (led + halo * 0.6), 0.0, 1.0), 1.0);
}`}),t({name:"sharpen",label:"Sharpen",category:"Stylize",params:{amount:e("Amount",0,4,1,.05),radius:e("Radius",.5,4,1,.05)},react:{amount:["hat",.35]},body:`void main() {
    vec2 px = u_radius / u_resolution;
    vec3 c = texture2D(u_tex, v_uv).rgb;
    vec3 blur = (texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb + texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb +
                 texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb + texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb) * 0.25;
    gl_FragColor = vec4(clamp(c + (c - blur) * u_amount, 0.0, 1.0), 1.0);
}`}),t({name:"oil_paint",label:"Oil Paint",category:"Stylize",hint:"Kuwahara filter: flattens colour into brush strokes, like a painting.",params:{radius:e("Brush Size",1,6,4,1,"int"),spacing:e("Brush Spread",1,3,1,1,"int"),saturation:e("Saturation",0,2,1.15,.01),canvas:e("Canvas Texture",0,1,.35,.01),mix:e("Mix",0,1,1,.01)},react:{radius:["bass",.3]},body:a+`void main() {
    vec2 px = max(u_spacing, 1.0) / u_resolution;
    vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
    vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
    float n0 = 0.0, n1 = 0.0, n2 = 0.0, n3 = 0.0;
    for (int j = -6; j <= 6; j++) {
        for (int i = -6; i <= 6; i++) {
            float fi = float(i), fj = float(j);
            if (abs(fi) > u_radius || abs(fj) > u_radius) continue;
            vec3 c = texture2D(u_tex, v_uv + vec2(fi, fj) * px).rgb;
            vec3 c2 = c * c;
            if (i <= 0 && j <= 0) { m0 += c; s0 += c2; n0 += 1.0; }
            if (i >= 0 && j <= 0) { m1 += c; s1 += c2; n1 += 1.0; }
            if (i <= 0 && j >= 0) { m2 += c; s2 += c2; n2 += 1.0; }
            if (i >= 0 && j >= 0) { m3 += c; s3 += c2; n3 += 1.0; }
        }
    }
    m0 /= n0; m1 /= n1; m2 /= n2; m3 /= n3;
    float v0 = dot(abs(s0 / n0 - m0 * m0), vec3(1.0));
    float v1 = dot(abs(s1 / n1 - m1 * m1), vec3(1.0));
    float v2 = dot(abs(s2 / n2 - m2 * m2), vec3(1.0));
    float v3 = dot(abs(s3 / n3 - m3 * m3), vec3(1.0));
    vec3 outc = m0; float best = v0;
    if (v1 < best) { best = v1; outc = m1; }
    if (v2 < best) { best = v2; outc = m2; }
    if (v3 < best) { best = v3; outc = m3; }
    outc = max(mix(vec3(luma(outc)), outc, u_saturation), 0.0);
    vec2 g = v_uv * u_resolution;
    float weave = (sin(g.x * 1.7) * sin(g.y * 1.7) * 0.5 + fract(sin(dot(floor(g * 0.5), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.06;
    outc *= 1.0 + weave * u_canvas;
    gl_FragColor = vec4(mix(texture2D(u_tex, v_uv).rgb, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"relief",label:"Relief Lighting",category:"Stylize",hint:"Treats brightness as height and lights it, so the image looks sculpted in clay, chrome or gold.",params:{material:n("Material",["Clay","Chrome","Gold","Emboss"],0),height:e("Height",0,8,2.5,.05),angle:e("Light Angle",0,1,.15,.005),elevation:e("Light Height",.1,1,.45,.01),shine:e("Shine",0,1,.5,.01),spread:e("Bump Width",.5,4,1.5,.05),mix:e("Mix",0,1,1,.01)},react:{angle:["lfo_bar",.5],height:["kick",.3]},body:a+`void main() {
    vec2 px = u_spread / u_resolution;
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float tl = luma(texture2D(u_tex, v_uv + vec2(-px.x, px.y)).rgb), t = luma(texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb), tr = luma(texture2D(u_tex, v_uv + px).rgb);
    float l = luma(texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb), r = luma(texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb);
    float bl = luma(texture2D(u_tex, v_uv - px).rgb), b = luma(texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb), br = luma(texture2D(u_tex, v_uv + vec2(px.x, -px.y)).rgb);
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    vec3 n = normalize(vec3(-gx * u_height, -gy * u_height, 1.0));
    float a = u_angle * 6.28318;
    vec3 L = normalize(vec3(cos(a), sin(a), u_elevation * 2.0));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
    vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
    float env = smoothstep(-0.6, 0.6, dot(R.xy, vec2(cos(a), sin(a)))) * 0.8 + 0.1;
    float m = floor(u_material + 0.5);
    vec3 outc;
    if (m < 0.5) outc = c * (0.3 + 0.95 * diff) + vec3(spec) * 0.25 * u_shine;
    else if (m < 1.5) outc = mix(vec3(env), c, 0.35) * (0.45 + 0.7 * diff) + vec3(spec) * 1.2 * u_shine;
    else if (m < 2.5) outc = vec3(1.0, 0.72, 0.28) * (env * 0.7 + luma(c) * 0.5) * (0.4 + 0.8 * diff) + vec3(1.0, 0.9, 0.6) * spec * 1.2 * u_shine;
    else outc = vec3(0.5 + dot(n.xy, L.xy) * 0.9);
    gl_FragColor = vec4(mix(c, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"holo_foil",label:"Holo Foil",category:"Stylize",hint:"Rainbow foil like a holographic card: colours shift with the slope of the image, with glints.",params:{amount:e("Foil Amount",0,1,.6,.01),scale:e("Rainbow Scale",.5,8,2.5,.05),tilt:e("Tilt",0,1,.5,.01),shimmer:e("Shimmer Speed",0,2,.4,.01),sparkle:e("Sparkle",0,1,.5,.01),mix:e("Mix",0,1,1,.01)},react:{amount:["bass",.3],sparkle:["hat",.4]},body:a+`float fh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec2 px = 1.5 / u_resolution;
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float lc = luma(c);
    float gx = luma(texture2D(u_tex, v_uv + vec2(px.x, 0.0)).rgb) - luma(texture2D(u_tex, v_uv - vec2(px.x, 0.0)).rgb);
    float gy = luma(texture2D(u_tex, v_uv + vec2(0.0, px.y)).rgb) - luma(texture2D(u_tex, v_uv - vec2(0.0, px.y)).rgb);
    float t = u_time * u_shimmer;
    vec2 view = vec2(sin(t * 0.7), cos(t * 0.53)) * (0.3 + u_tilt);
    float ph = lc * u_scale + dot(vec2(gx, gy), view) * 6.0 + dot(v_uv - 0.5, view) * u_scale + t * 0.15;
    vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (ph + vec3(0.0, 0.33, 0.67)));
    vec3 foil = 1.0 - (1.0 - c) * (1.0 - rainbow * (0.04 + 0.9 * pow(lc, 0.7)));
    vec3 outc = mix(c, foil, u_amount);
    vec2 cell = floor(v_uv * u_resolution / 3.0);
    float h = fh(cell);
    float glint = step(1.0 - u_sparkle * 0.012, h) * pow(0.5 + 0.5 * sin(u_time * 5.0 + h * 90.0), 6.0);
    outc += vec3(glint) * (0.4 + lc) * 1.5;
    gl_FragColor = vec4(mix(c, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"pixel_sort",label:"Pixel Sort",category:"Stylize",hint:"Glitch-art streaks: runs of pixels within the brightness band are sorted or smeared along a direction.",params:{direction:n("Direction",["Down","Up","Right","Left"],0),mode:n("Style",["Sort Bright to Dark","Sort Dark to Bright","Smear"],0),low:e("Band Low",0,1,.35,.01),high:e("Band High",0,1,1,.01),length:e("Max Streak (px)",8,480,180,1,"int"),mix:e("Mix",0,1,1,.01)},react:{length:["kick",.25],low:["bass",-.15]},body:a+`void main() {
    float m = floor(u_direction + 0.5);
    vec2 dir = m < 0.5 ? vec2(0.0, -1.0) : (m < 1.5 ? vec2(0.0, 1.0) : (m < 2.5 ? vec2(1.0, 0.0) : vec2(-1.0, 0.0)));
    vec3 c = texture2D(u_tex, v_uv).rgb;
    float l = luma(c);
    if (l < u_low || l > u_high) { gl_FragColor = vec4(c, 1.0); return; }
    float stepPx = max(1.0, u_length / 40.0);
    vec2 px = dir * stepPx / u_resolution;
    vec3 lo = c, hi = c; float loL = l, hiL = l;
    float back = 0.0, fwd = 0.0;
    for (int i = 1; i <= 40; i++) {
        if (float(i) * stepPx > u_length) break;
        vec2 q = v_uv - px * float(i);
        if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
        vec3 s = texture2D(u_tex, q).rgb; float sl = luma(s);
        if (sl < u_low || sl > u_high) break;
        back = float(i);
        if (sl < loL) { loL = sl; lo = s; }
        if (sl > hiL) { hiL = sl; hi = s; }
    }
    for (int i = 1; i <= 40; i++) {
        if (float(i) * stepPx > u_length) break;
        vec2 q = v_uv + px * float(i);
        if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
        vec3 s = texture2D(u_tex, q).rgb; float sl = luma(s);
        if (sl < u_low || sl > u_high) break;
        fwd = float(i);
        if (sl < loL) { loL = sl; lo = s; }
        if (sl > hiL) { hiL = sl; hi = s; }
    }
    float f = back / max(back + fwd, 1.0);
    float sm = floor(u_mode + 0.5);
    vec3 outc = sm < 0.5 ? mix(hi, lo, f) : (sm < 1.5 ? mix(lo, hi, f) : texture2D(u_tex, v_uv - px * back).rgb);
    gl_FragColor = vec4(mix(c, outc, u_mix), 1.0);
}`}),t({name:"stained_glass",label:"Stained Glass",category:"Stylize",hint:"Turns the image into a lit stained-glass window: irregular glass pieces with lead lines.",params:{cell:e("Piece Size",8,140,38,1),jitter:e("Irregularity",0,1,.9,.01),lead:e("Lead Width",0,1,.35,.01),saturation:e("Saturation",0,2,1.35,.01),glow:e("Light Glow",0,1.5,.6,.01),ripple:e("Glass Ripple",0,1,.4,.01),mix:e("Mix",0,1,1,.01)},react:{glow:["kick",.3]},body:a+`vec2 sh2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
void main() {
    vec2 g = v_uv * u_resolution / max(u_cell, 4.0);
    vec2 i = floor(g), f = fract(g);
    float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y));
            vec2 pt = o + 0.5 + (sh2(i + o) - 0.5) * u_jitter;
            float d = length(pt - f);
            if (d < d1) { d2 = d1; d1 = d; best = i + pt; } else if (d < d2) { d2 = d; }
        }
    }
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    vec3 glass = texture2D(u_tex, best * max(u_cell, 4.0) / u_resolution).rgb;
    glass = max(mix(vec3(luma(glass)), glass, u_saturation), 0.0);
    float h = sh2(floor(best * 3.0)).x;
    float rip = 1.0 + u_ripple * 0.25 * (sin(f.x * 9.0 + h * 6.0) * sin(f.y * 7.0 + h * 4.0));
    glass *= rip * (1.0 + u_glow * (1.0 - smoothstep(0.0, 0.9, d1)) * 0.6);
    float edge = d2 - d1;
    float w = 0.02 + u_lead * 0.16;
    float leadMask = smoothstep(w, w + 0.04, edge);
    vec3 leadCol = vec3(0.05, 0.05, 0.06) + vec3(0.12) * (1.0 - smoothstep(0.0, w * 0.2, abs(edge - w * 0.5)));
    vec3 outc = mix(leadCol, glass, leadMask);
    gl_FragColor = vec4(mix(orig, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"watercolour",label:"Watercolour",category:"Stylize",hint:"Paints the image in watercolour: colours bleed, pigment pools at edges, paper grain shows through.",params:{bleed:e("Colour Bleed",0,6,2.5,.05),levels:e("Wash Levels",2,12,6,1,"int"),edges:e("Edge Darkening",0,1.5,.7,.01),paper:e("Paper Texture",0,1,.5,.01),granulation:e("Granulation",0,1,.4,.01),mix:e("Mix",0,1,1,.01)},react:{bleed:["bass",.25]},body:a+`float wh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float wn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh(i), wh(i + vec2(1.0, 0.0)), f.x), mix(wh(i + vec2(0.0, 1.0)), wh(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
    vec2 px = 1.0 / u_resolution;
    vec2 g = v_uv * u_resolution;
    vec2 warp = (vec2(wn(g * 0.025), wn(g * 0.025 + 7.3)) - 0.5) * u_bleed * 8.0 * px;
    vec3 c = texture2D(u_tex, v_uv + warp).rgb * 2.0;
    for (int k = 0; k < 6; k++) {
        float a = float(k) * 1.0472 + wn(g * 0.05 + float(k)) * 1.5;
        c += texture2D(u_tex, v_uv + warp + vec2(cos(a), sin(a)) * u_bleed * 2.5 * px).rgb;
    }
    c /= 8.0;
    float L = max(u_levels, 2.0);
    vec3 washed = floor(c * L + 0.5) / L;
    c = mix(c, washed, 0.55);
    float lx = luma(texture2D(u_tex, v_uv + warp + vec2(px.x * 2.0, 0.0)).rgb) - luma(texture2D(u_tex, v_uv + warp - vec2(px.x * 2.0, 0.0)).rgb);
    float ly = luma(texture2D(u_tex, v_uv + warp + vec2(0.0, px.y * 2.0)).rgb) - luma(texture2D(u_tex, v_uv + warp - vec2(0.0, px.y * 2.0)).rgb);
    float e = length(vec2(lx, ly));
    c *= 1.0 - u_edges * 0.6 * smoothstep(0.03, 0.25, e);
    float paper = wn(g * 0.35) * 0.5 + wn(g * 0.9) * 0.3 + wn(g * 2.3) * 0.2;
    vec3 paperCol = vec3(0.98, 0.96, 0.91);
    c = 1.0 - (1.0 - c) * (1.0 - u_paper * 0.12 * paper);
    c *= mix(vec3(1.0), paperCol, u_paper * 0.6);
    c *= 1.0 - u_granulation * 0.3 * (1.0 - paper) * (1.0 - luma(c));
    gl_FragColor = vec4(mix(texture2D(u_tex, v_uv).rgb, clamp(c, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"bloom",label:"Bloom",category:"Glow & Blur",params:{intensity:e("Intensity",0,3,.8,.05),threshold:e("Threshold",0,1,.4,.05),radius:e("Radius",1,8,3,.5),softness:e("Softness",.01,1,.6,.01),tint_hue:e("Tint Hue",0,1,.8,.01),tint:e("Tint Amount",0,1,0,.01),blend:n("Blend",["Add","Screen"])},react:{intensity:["kick",.35]},body:v+`void main() {
    vec3 color = texture2D(u_tex, v_uv).rgb;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 24; i++) {
        float fi = float(i);
        float rr = sqrt((fi + 0.5) / 24.0) * u_radius * 4.0;
        float a = fi * 2.39996;
        vec3 s = texture2D(u_tex, v_uv + vec2(cos(a), sin(a)) * rr / u_resolution).rgb;
        float b = max(s.r, max(s.g, s.b));
        acc += s * smoothstep(u_threshold, u_threshold + max(u_softness, 0.01), b);
    }
    vec3 bloom = acc / 24.0;
    bloom = mix(bloom, hsv2rgb(vec3(u_tint_hue, 0.8, 1.0)) * dot(bloom, vec3(0.333)) * 1.5, u_tint);
    bloom *= u_intensity;
    vec3 outc = u_blend < 0.5 ? color + bloom : 1.0 - (1.0 - color) * (1.0 - clamp(bloom, 0.0, 1.0));
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`}),t({name:"tilt_shift",label:"Focus Blur",category:"Glow & Blur",hint:"Tilt-shift miniature look, or a radial focus spot.",params:{mode:n("Mode",["Band (tilt-shift)","Radial Spot"]),focus:e("Focus Position",0,1,.5,.01),width:e("Focus Width",0,1,.3,.01),blur:e("Blur",0,12,5,.1),saturation:e("Saturation",0,2,1.25,.01)},react:{blur:["bass",.35]},body:a+`void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    float d;
    if (u_mode < 0.5) d = abs(v_uv.y - u_focus);
    else { vec2 p = v_uv - vec2(0.5, u_focus); p.x *= aspect; d = length(p); }
    float amt = smoothstep(u_width * 0.5, u_width * 0.5 + 0.25, d) * u_blur;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
        float fi = float(i);
        float rr = sqrt((fi + 0.5) / 16.0) * amt;
        float a = fi * 2.39996;
        acc += texture2D(u_tex, v_uv + vec2(cos(a), sin(a)) * rr / u_resolution).rgb;
    }
    vec3 c = acc / 16.0;
    c = max(mix(vec3(luma(c)), c, u_saturation), 0.0);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`}),t({name:"god_rays",label:"God Rays",category:"Glow & Blur",hint:"Light shafts streaming from bright areas toward the light point.",params:{light_x:e("Light X",0,1,.5,.01),light_y:e("Light Y",0,1,.55,.01),length:e("Ray Length",.1,1.5,.8,.01),decay:e("Falloff",.9,1,.975,.001),threshold:e("Threshold",0,1,.35,.01),intensity:e("Intensity",0,3,1,.01),tint_hue:e("Tint Hue",0,1,.1,.01),tint:e("Tint Amount",0,1,.25,.01)},react:{intensity:["kick",.35]},body:v+`void main() {
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    vec2 delta = (v_uv - vec2(u_light_x, u_light_y)) * u_length / 48.0;
    vec2 uv = v_uv;
    float illum = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 48; i++) {
        uv -= delta;
        vec3 s = texture2D(u_tex, uv).rgb;
        float b = max(s.r, max(s.g, s.b));
        acc += s * smoothstep(u_threshold, u_threshold + 0.25, b) * illum;
        illum *= u_decay;
    }
    acc /= 48.0;
    acc = mix(acc, hsv2rgb(vec3(u_tint_hue, 0.6, 1.0)) * dot(acc, vec3(0.333)) * 1.4, u_tint);
    gl_FragColor = vec4(clamp(orig + acc * u_intensity * 2.0, 0.0, 1.0), 1.0);
}`}),t({name:"anamorphic",label:"Anamorphic Flare",category:"Lens & Retro",hint:"Cinematic horizontal lens streaks and ghosts from the highlights.",params:{threshold:e("Threshold",0,1,.55,.01),length:e("Streak Length",.05,1,.45,.01),intensity:e("Intensity",0,3,1,.01),tint_hue:e("Streak Hue",0,1,.58,.01),ghosts:e("Lens Ghosts",0,1,.3,.01)},react:{intensity:["kick",.4]},body:v+`vec3 bright(vec2 uv) {
    vec3 s = texture2D(u_tex, uv).rgb;
    return s * smoothstep(u_threshold, u_threshold + 0.2, max(s.r, max(s.g, s.b)));
}
void main() {
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -24; i <= 24; i++) {
        float fi = float(i) / 24.0;
        float w = exp(-abs(fi) * 3.0);
        acc += bright(v_uv + vec2(fi * u_length * 0.5, 0.0)) * w;
        wsum += w;
    }
    vec3 streak = acc / wsum;
    vec3 tint = hsv2rgb(vec3(u_tint_hue, 0.75, 1.0));
    streak = tint * dot(streak, vec3(0.333)) * 2.0 + streak * 0.3;
    vec2 g = vec2(1.0) - v_uv;
    vec3 ghost = bright(mix(v_uv, g, 0.85)) * vec3(0.6, 0.35, 1.0) + bright(mix(v_uv, g, 1.3)) * vec3(0.3, 0.9, 0.7);
    vec3 outc = orig + streak * u_intensity + ghost * u_ghosts * 0.35 * u_intensity;
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`}),t({name:"chromatic",label:"Chromatic Aberration",category:"Lens & Retro",params:i({amount:e("Amount",0,30,5,.5),falloff:e("Falloff",.5,3,1.5,.1),mode:n("Direction",["Radial","Fixed Angle"]),angle:e("Angle",0,1,0,.01)}),react:{amount:["snare",.4]},body:`void main() {
    vec2 dir = v_uv - vec2(u_center_x, u_center_y);
    vec2 offset;
    if (u_mode < 0.5) offset = dir * u_amount * 0.01 * pow(length(dir), u_falloff);
    else offset = vec2(cos(u_angle * 6.28318), sin(u_angle * 6.28318)) * u_amount * 0.0015;
    float r = texture2D(u_tex, v_uv + offset).r;
    float g = texture2D(u_tex, v_uv).g;
    float b = texture2D(u_tex, v_uv - offset).b;
    gl_FragColor = vec4(r, g, b, 1.0);
}`}),t({name:"glitch",label:"Glitch",category:"Lens & Retro",params:{intensity:e("Intensity",0,3,1,.1),speed:e("Speed",.1,5,1,.1),block_size:e("Block Size",5,100,30,1,"int"),rgb_shift:e("RGB Shift",0,3,1,.05),static:e("Static Lines",0,1,.3,.01),blocks:e("Block Glitches",0,1,0,.01),color_swap:e("Colour Swaps",0,1,0,.01)},react:{intensity:["snare",.45]},body:`float ghash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
    vec2 uv = v_uv;
    float t = floor(u_time * u_speed * 10.0);
    float line = floor(uv.y * u_block_size);
    float glitch = step(1.0 - u_intensity * 0.15, ghash(line + t));
    uv.x += (ghash(line + t * 1.7) - 0.5) * 0.2 * u_intensity * glitch;
    vec2 blk = floor(v_uv * vec2(u_block_size * 0.5, u_block_size * 0.3));
    float bh = ghash(blk.x * 7.13 + blk.y * 31.7 + t * 3.1);
    float bon = step(1.0 - u_blocks * 0.25, bh) * step(0.001, u_blocks);
    uv += bon * (vec2(ghash(bh + t), ghash(bh * 2.0 + t)) - 0.5) * 0.15;
    float rgbShift = (0.01 * u_intensity * glitch + bon * 0.01) * u_rgb_shift;
    float r = texture2D(u_tex, vec2(uv.x + rgbShift, uv.y)).r;
    float g = texture2D(u_tex, uv).g;
    float b = texture2D(u_tex, vec2(uv.x - rgbShift, uv.y)).b;
    vec3 color = vec3(r, g, b);
    if (ghash(line * 3.3 + t * 0.7) < u_color_swap * (0.3 * glitch + 0.5 * bon)) color = color.brg;
    float noise = ghash(uv.y * 100.0 + t * 3.0);
    float staticLine = step(0.995, ghash(uv.y * 200.0 + t)) * u_intensity * u_static;
    gl_FragColor = vec4(mix(color, vec3(noise), staticLine), 1.0);
}`}),t({name:"vhs",label:"VHS Tape",category:"Lens & Retro",params:{wobble:e("Wobble",0,1,.5,.01),jitter:e("Line Jitter",0,1,.4,.01),tracking:e("Tracking Bar",0,1,.35,.01),bleed:e("Colour Bleed",0,1,.5,.01),noise:e("Noise",0,1,.4,.01),saturation:e("Saturation",0,1.5,.85,.01)},react:{tracking:["snare",.4],wobble:["bass",.3]},body:a+`float vh(float n) { return fract(sin(n) * 43758.5453); }
float vh2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec2 uv = v_uv;
    float t = u_time;
    float frameT = floor(t * 24.0);
    uv.x += (sin(uv.y * 30.0 + t * 2.0) * 0.0015 + sin(uv.y * 7.0 - t * 1.3) * 0.002) * u_wobble;
    uv.x += (vh(floor(uv.y * 240.0) + frameT) - 0.5) * 0.002 * u_jitter;
    float tr = (1.0 - smoothstep(0.0, 0.06, abs(uv.y - fract(t * 0.07)))) * u_tracking;
    uv.x += tr * (vh(floor(uv.y * 120.0) + frameT) - 0.5) * 0.06;
    vec3 c = texture2D(u_tex, uv).rgb;
    vec3 smear = vec3(0.0);
    for (int i = 1; i <= 6; i++) smear += texture2D(u_tex, uv - vec2(float(i) * 0.0025 * u_bleed, 0.0)).rgb;
    smear /= 6.0;
    float y = luma(c);
    vec3 chroma = mix(c - y, smear - luma(smear), clamp(u_bleed * 1.5, 0.0, 1.0));
    vec3 col = y + chroma * u_saturation;
    col += (vh2(vec2(uv.y * 400.0, frameT) + floor(v_uv.x * u_resolution.x * 0.5)) - 0.5) * 0.12 * u_noise;
    col += tr * vh2(v_uv * u_resolution + frameT) * 0.5;
    col *= 0.96 + 0.04 * sin(v_uv.y * u_resolution.y * 1.5);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`}),t({name:"crt",label:"CRT",category:"Lens & Retro",params:{curvature:e("Curvature",0,5,1.5,.1),scan_intensity:e("Scanlines",0,.8,.25,.05),vignette:e("Vignette",0,1,.8,.05),mask:e("RGB Mask",0,1,.25,.01),flicker:e("Flicker",0,1,0,.01),brightness:e("Brightness",.8,1.6,1.1,.01)},react:{curvature:["kick",.15],flicker:["hat",.4]},body:`void main() {
    vec2 uv = v_uv * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    uv *= 1.0 + u_curvature * r2 * 0.1;
    uv = uv * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    vec3 color = texture2D(u_tex, uv).rgb;
    float scan = sin(uv.y * u_resolution.y * 3.14159) * 0.5 + 0.5;
    color *= mix(1.0, scan, u_scan_intensity);
    float col3 = mod(floor(v_uv.x * u_resolution.x), 3.0);
    vec3 mask = vec3(col3 < 0.5 ? 1.0 : 0.55, (col3 >= 0.5 && col3 < 1.5) ? 1.0 : 0.55, col3 >= 1.5 ? 1.0 : 0.55);
    color *= mix(vec3(1.0), mask * 1.25, u_mask);
    vec2 edge = smoothstep(0.0, 0.06, uv) * (1.0 - smoothstep(0.94, 1.0, uv));
    color *= mix(1.0, edge.x * edge.y, u_vignette);
    float fl = fract(sin(floor(u_time * 30.0) * 12.9898) * 43758.5453);
    color *= u_brightness * (1.0 - u_flicker * 0.18 * fl);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`});var f=[["....","....","....","....","...."],["....","....","....","....",".#.."],["....",".#..","....",".#..","...."],["....","....","####","....","...."],["....","####","....","####","...."],[".#..",".#..","####",".#..",".#.."],["....","#.#.",".#..","#.#.","...."],[".#.#","####",".#.#","####",".#.#"],["#..#","...#","..#.",".#..","#..#"],[".##.","#..#","#.##","#...",".###"]].map(function(o){var r=0;return o.forEach(function(c,s){for(var u=0;u<4;u++)c.charAt(u)==="#"&&(r+=Math.pow(2,s*4+u))}),r});return t({name:"ascii",label:"ASCII Text Mode",category:"Lens & Retro",hint:"Redraws the picture with text characters, like an old terminal.",params:{size:e("Character Size",4,32,10,1),mode:n("Colours",["Green Terminal","Original Colours","Amber","White on Black","Cyan Neon"],0),contrast:e("Contrast",.5,3,1.3,.01),background:e("Picture Behind",0,1,.08,.01),mix:e("Mix",0,1,1,.01)},react:{contrast:["kick",.15]},body:a+`float glyph(float i) {
`+f.map(function(o,r){return"    if (i < "+(r+.5).toFixed(1)+") return "+o+`.0;
`}).join("")+"    return "+f[f.length-1]+`.0;
}
void main() {
    float unit = max(u_size, 4.0) / 5.0;
    vec2 g = v_uv * u_resolution;
    vec2 cellSize = vec2(5.0, 6.0) * unit;
    vec2 cell = floor(g / cellSize);
    vec2 local = floor((g - cell * cellSize) / unit);
    vec3 src = texture2D(u_tex, (cell + 0.5) * cellSize / u_resolution).rgb;
    float l = clamp((luma(src) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
    float gi = floor(l * 9.999);
    float on = 0.0;
    if (local.x < 4.0 && local.y >= 1.0) {
        float row = 5.0 - local.y;
        float idx = row * 4.0 + local.x;
        on = mod(floor(glyph(gi) / exp2(idx) + 0.001), 2.0);
    }
    float m = floor(u_mode + 0.5);
    vec3 fg = m < 0.5 ? vec3(0.25, 1.0, 0.45) : (m < 1.5 ? src / max(max(src.r, max(src.g, src.b)), 0.15) : (m < 2.5 ? vec3(1.0, 0.7, 0.15) : (m < 3.5 ? vec3(0.95) : vec3(0.2, 0.95, 1.0))));
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    vec3 outc = fg * on * (0.55 + 0.45 * l) + orig * u_background;
    gl_FragColor = vec4(mix(orig, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"dither",label:"Retro Dither",category:"Lens & Retro",hint:"Ordered (Bayer) dithering with retro palettes: 1-bit Mac, Game Boy, CGA, amber monitor, Pico-8.",params:{mode:n("Palette",["1-Bit","Colour Levels","Game Boy","CGA","Amber Monitor","Pico-8"],2),pixel:e("Pixel Size",1,8,2,1,"int"),levels:e("Colour Levels",2,8,4,1,"int"),dither:e("Dither Strength",0,1.5,1,.01),contrast:e("Contrast",.5,2.5,1.15,.01),brightness:e("Brightness",-.5,.5,0,.01),mix:e("Mix",0,1,1,.01)},react:{brightness:["kick",.15]},body:a+`float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
vec3 ramp4(float i, vec3 a, vec3 b, vec3 c, vec3 d) { return i < 0.5 ? a : (i < 1.5 ? b : (i < 2.5 ? c : d)); }
vec3 pico(int i) {
    if (i == 0) return vec3(0.0); if (i == 1) return vec3(0.114, 0.169, 0.325); if (i == 2) return vec3(0.494, 0.145, 0.325); if (i == 3) return vec3(0.0, 0.529, 0.318);
    if (i == 4) return vec3(0.671, 0.322, 0.212); if (i == 5) return vec3(0.373, 0.341, 0.31); if (i == 6) return vec3(0.761, 0.765, 0.78); if (i == 7) return vec3(1.0, 0.945, 0.91);
    if (i == 8) return vec3(1.0, 0.0, 0.302); if (i == 9) return vec3(1.0, 0.639, 0.0); if (i == 10) return vec3(1.0, 0.925, 0.153); if (i == 11) return vec3(0.0, 0.894, 0.212);
    if (i == 12) return vec3(0.161, 0.678, 1.0); if (i == 13) return vec3(0.514, 0.463, 0.612); if (i == 14) return vec3(1.0, 0.467, 0.659); return vec3(1.0, 0.8, 0.667);
}
void main() {
    float ps = max(1.0, u_pixel);
    vec2 cell = floor(v_uv * u_resolution / ps);
    vec3 orig = texture2D(u_tex, v_uv).rgb;
    vec3 c = texture2D(u_tex, (cell + 0.5) * ps / u_resolution).rgb;
    c = clamp((c - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0);
    float d = (bayer8(cell) - 0.5) * u_dither;
    float m = floor(u_mode + 0.5);
    float l = luma(c);
    vec3 outc;
    if (m < 0.5) outc = vec3(step(0.5, l + d)) * vec3(0.95, 0.95, 0.9);
    else if (m < 1.5) { float L = max(u_levels - 1.0, 1.0); outc = floor(c * L + 0.5 + d) / L; }
    else if (m < 2.5) outc = ramp4(clamp(floor(l * 3.0 + 0.5 + d), 0.0, 3.0), vec3(0.059, 0.22, 0.059), vec3(0.188, 0.384, 0.188), vec3(0.545, 0.675, 0.059), vec3(0.608, 0.737, 0.059));
    else if (m < 3.5) outc = ramp4(clamp(floor(l * 3.0 + 0.5 + d), 0.0, 3.0), vec3(0.0), vec3(1.0, 0.33, 1.0), vec3(0.33, 1.0, 1.0), vec3(1.0));
    else if (m < 4.5) { float L = max(u_levels - 1.0, 1.0); outc = vec3(1.0, 0.68, 0.0) * floor(l * L + 0.5 + d) / L; }
    else {
        vec3 q = c + d * 0.25;
        float best = 1e9;
        outc = vec3(0.0);
        for (int i = 0; i < 16; i++) { vec3 p = pico(i); vec3 e = q - p; float dd = dot(e, e * vec3(0.9, 1.2, 0.7)); if (dd < best) { best = dd; outc = p; } }
    }
    gl_FragColor = vec4(mix(orig, clamp(outc, 0.0, 1.0), u_mix), 1.0);
}`}),t({name:"grain",label:"Film Grain",category:"Lens & Retro",params:{intensity:e("Intensity",0,.5,.12,.01),size:e("Grain Size",1,4,1.5,.5),colored:e("Colour Grain",0,1,0,.01),shadows:e("Shadow Weight",0,1,0,.01),fps:e("Grain FPS (0 = still)",0,60,60,1,"int")},react:{intensity:["hat",.35]},body:a+`float gh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec4 color = texture2D(u_tex, v_uv);
    vec2 g = floor(v_uv * u_resolution / u_size) + (u_fps > 0.5 ? floor(u_time * u_fps) : 0.0);
    float n = gh(g) - 0.5;
    vec3 nc = vec3(gh(g + 17.0), gh(g + 41.0), gh(g + 73.0)) - 0.5;
    vec3 noise = mix(vec3(n), nc, u_colored);
    float w = mix(1.0, 1.5 - luma(color.rgb), u_shadows);
    color.rgb += noise * u_intensity * w;
    gl_FragColor = vec4(clamp(color.rgb, 0.0, 1.0), 1.0);
}`}),{categories:b,syncTypes:["free","kick","snare","beat","bar","drop","hat"],list:function(){return p}}})()}}export{w as default};
