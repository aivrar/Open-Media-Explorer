function C(c){var L=c.Controls,M=c.EffectRegistry,t=c.GpuSim,n=c.Math,x=c.Renderer;return(function(){"use strict";var e=null,N={warned:!1},p=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
`,y=`uniform sampler2D u_world;
uniform vec2 u_cellTexel;
float cell(ivec2 d) { return textureLod(u_world, v_uv + vec2(d) / vec2(textureSize(u_world, 0)), 0.0).r; }
`,P=p+y+`uniform vec2 u_texel; uniform float u_radius;
const float B1 = 0.278, B2 = 0.365, D1 = 0.267, D2 = 0.445, AN = 0.028, AM = 0.147;
float s1(float x, float a, float al) { return 1.0 / (1.0 + exp(-(x - a) * 4.0 / al)); }
float s2(float x, float a, float b) { return s1(x, a, AN) * (1.0 - s1(x, b, AN)); }
float sm(float x, float y, float m) { float w = s1(m, 0.5, AM); return x * (1.0 - w) + y * w; }
void main() {
    float ra = u_radius, ri = u_radius / 3.0;
    float M = 0.0, MW = 0.0, N = 0.0, NW = 0.0;
    int R = int(ceil(ra + 0.5));
    for (int y = -R; y <= R; y++) {
        for (int x = -R; x <= R; x++) {
            float r = length(vec2(float(x), float(y)));
            if (r > ra + 0.5) continue;
            float v = cell(ivec2(x, y));
            float wi = clamp(ri + 0.5 - r, 0.0, 1.0);
            float wo = clamp(ra + 0.5 - r, 0.0, 1.0) * (1.0 - wi);
            M += v * wi; MW += wi;
            N += v * wo; NW += wo;
        }
    }
    float m = M / max(MW, 1.0), n = N / max(NW, 1.0);
    float next = s2(n, sm(B1, D1, m), sm(B2, D2, m));
    o = vec4(next, m, 0.0, 1.0);
}`,U=p+y+`uniform vec2 u_texel; uniform float u_radius; uniform float u_mu; uniform float u_sigma; uniform float u_dt;
void main() {
    float sum = 0.0, wsum = 0.0;
    int R = int(ceil(u_radius));
    for (int y = -R; y <= R; y++) {
        for (int x = -R; x <= R; x++) {
            float r = length(vec2(float(x), float(y))) / u_radius;
            if (r >= 1.0 || r <= 0.0) continue;
            float k = exp(4.0 - 1.0 / (r * (1.0 - r)));
            sum += k * cell(ivec2(x, y));
            wsum += k;
        }
    }
    float U = sum / max(wsum, 1e-6);
    float d = (U - u_mu) / u_sigma;
    float g = 2.0 * exp(-0.5 * d * d) - 1.0;
    o = vec4(clamp(cell(ivec2(0)) + u_dt * g, 0.0, 1.0), U, 0.0, 1.0);
}`,T=p+`uniform sampler2D u_world; uniform vec2 u_point; uniform float u_size; uniform float u_aspect; uniform float u_salt; uniform float u_solid;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + u_salt) * 43758.5453); }
void main() {
    vec4 w = texture(u_world, v_uv);
    vec2 p = v_uv - u_point; p.x *= u_aspect;
    float m = smoothstep(u_size, u_size * 0.8, length(p));
    float n = u_solid > 0.5 ? 1.0 : h(floor(v_uv * 220.0));
    o = vec4(max(w.r, m * n), w.gba);
}`,B=p+`uniform sampler2D u_world; uniform sampler2D u_lut; uniform float u_useLut; uniform float u_scheme; uniform float u_brightness; uniform float u_glow; uniform vec2 u_texel;
vec3 scheme(float x) {
    if (u_scheme < 0.5) return mix(mix(vec3(0.0, 0.02, 0.05), vec3(0.05, 0.6, 0.75), smoothstep(0.0, 0.5, x)), vec3(0.85, 1.0, 0.9), smoothstep(0.5, 1.0, x));
    if (u_scheme < 1.5) return mix(mix(vec3(0.02, 0.0, 0.04), vec3(0.85, 0.15, 0.3), smoothstep(0.0, 0.45, x)), vec3(1.0, 0.9, 0.35), smoothstep(0.45, 1.0, x));
    return mix(vec3(0.94, 0.92, 0.86), vec3(0.08, 0.06, 0.12), smoothstep(0.0, 0.7, x));
}
void main() {
    vec4 w = texture(u_world, v_uv);
    float halo = 0.0;
    for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.785398;
        halo += textureLod(u_world, v_uv + vec2(cos(ang), sin(ang)) * u_texel * 3.0, 0.0).r;
    }
    halo /= 8.0;
    float x = clamp(w.r * u_brightness, 0.0, 1.0);
    vec3 col = u_useLut > 0.5 ? texture(u_lut, vec2(0.03 + x * 0.94, 0.5)).rgb : scheme(x);
    if (u_scheme < 1.5 || u_useLut > 0.5) col += (u_useLut > 0.5 ? texture(u_lut, vec2(0.7, 0.5)).rgb : scheme(0.65)) * halo * u_glow * 0.5 * (1.0 - x);
    o = vec4(col, 1.0);
}`,W=[160,224,288],w=["Bioluminescent","Ember","Ink on Paper"];function v(a){e&&t.release(a,[e.world]),e=null}function z(a,f){if(!t.supported(a))return!1;var d=a.canvas.width/n.max(1,a.canvas.height),i=W[n.round(f.resolution!==void 0?f.resolution:1)]||224,r=n.round(i*d),u=n.round(f.rule||0);if(e&&e.gl===a&&e.w===r&&e.h===i&&e.rule===u&&a.isTexture(e.world.read.tex))return!0;var o=e&&e.gl===a?e:null;if(o?e=null:v(a),e={gl:a,w:r,h:i,rule:u,kick:0,nextRain:0,reset:!0,acc:0},e.pUpdate=u===0?t.cached(a,"SmoothLife update",t.VS_QUAD,P):t.cached(a,"Lenia update",t.VS_QUAD,U),e.pSeed=t.cached(a,"Lenia seed",t.VS_QUAD,T),e.pDisplay=t.cached(a,"Lenia display",t.VS_QUAD,B),e.world=t.pair(a,r,i,{wrap:a.REPEAT}),!e.pUpdate||!e.pSeed||!e.pDisplay||!e.world)return v(a),e=o,v(a),!1;if(o){t.carry(a,o.world,e.world),e.reset=!1,e.kick=o.kick,e.nextRain=o.nextRain,e.acc=o.acc;var b=e;e=o,v(a),e=b}return!0}function h(a,f,d,i,r){var u=e.pSeed;a.useProgram(u.p),t.bind(a,0,e.world.read.tex,u.u.u_world),a.uniform2f(u.u.u_point,f,d),a.uniform1f(u.u.u_size,i),a.uniform1f(u.u.u_aspect,e.w/e.h),a.uniform1f(u.u.u_salt,n.random()*100),a.uniform1f(u.u.u_solid,r?1:0),t.draw(a,u,e.world.write),e.world.swap()}function F(a,f,d,i){var r=L.getValues?L.getValues():{};if(!z(a,r)){t.unsupportedFrame(a,"Lenia",N);return}var u=r.audio_react!==void 0?r.audio_react:1,o=t.audio("kick")*u,b=t.audio("bass")*u,m=e.rule===0,_=m?n.max(6,n.min(24,r.radius||15)):n.max(4,n.min(16,r.radius||13)),S=(m?_*1.1:_*1.6)/e.h;if(a.disable(a.BLEND),a.disable(a.DEPTH_TEST),e.reset){t.clear(a,e.world.read);for(var V=m?n.round(e.w*e.h/(_*_*18)):9,R=0;R<V;R++)h(a,n.random(),n.random(),S*(.6+n.random()*.6),m);e.reset=!1}if(i>0){var D=r.seed_rain!==void 0?r.seed_rain:1;D>0&&d>=e.nextRain&&(e.nextRain>0&&h(a,n.random(),n.random(),S,m),e.nextRain=d+6/D*(.6+n.random()*.8)),o>.6&&e.kick<=.6&&n.random()<.5*u&&h(a,n.random(),n.random(),S,m),e.kick=o,e.acc+=n.min(.1,i)*n.max(1,r.speed||24);var k=n.min(4,n.floor(e.acc));e.acc-=k;for(var s=e.pUpdate,E=0;E<k;E++)a.useProgram(s.p),t.bind(a,0,e.world.read.tex,s.u.u_world),a.uniform2f(s.u.u_texel,1/e.w,1/e.h),a.uniform1f(s.u.u_radius,_),m||(a.uniform1f(s.u.u_mu,r.mu!==void 0?r.mu:.15),a.uniform1f(s.u.u_sigma,r.sigma!==void 0?r.sigma:.017),a.uniform1f(s.u.u_dt,r.time_step!==void 0?r.time_step:.1)),t.draw(a,s,e.world.write),e.world.swap()}x.bindFramebuffer(-1),a.viewport(0,0,a.canvas.width,a.canvas.height);var l=e.pDisplay;a.useProgram(l.p),t.bind(a,0,e.world.read.tex,l.u.u_world);var A=n.round(r.palette||0);t.bindPalette(a,7,A,w.length,l.u.u_lut,l.u.u_useLut),a.uniform1f(l.u.u_scheme,n.min(A,w.length-1)),a.uniform1f(l.u.u_brightness,r.brightness||1.2),a.uniform1f(l.u.u_glow,(r.glow!==void 0?r.glow:1)*(1+b*1.2)),a.uniform2f(l.u.u_texel,1/e.w,1/e.h),t.draw(a,l,null),t.unbind(a,8)}M.register({name:"lenia",label:"Lenia",category:"Simulation",description:"Continuous cellular automata: smooth, organic creatures that glide, pulse and divide",params:[{name:"rule",label:"Rule",type:"select",options:["SmoothLife (gliders)","Lenia (smooth ring)"],default:0},{name:"radius",label:"Creature Size",type:"int",min:6,max:24,default:15,step:1},{name:"speed",label:"Steps / Second",min:4,max:60,default:24,step:1},{name:"mu",label:"Lenia Sweet Spot",min:.05,max:.4,default:.15,step:.001},{name:"sigma",label:"Lenia Growth Width",min:.005,max:.08,default:.017,step:5e-4},{name:"time_step",label:"Lenia Time Step",min:.02,max:.3,default:.1,step:.005},{name:"seed_rain",label:"Seed Rain",min:0,max:3,default:1,step:.05},{name:"resolution",label:"World Size",type:"select",options:["Small","Medium","Large"],default:1},{name:"brightness",label:"Brightness",min:.5,max:3,default:1.2,step:.01},{name:"glow",label:"Glow",min:0,max:2,default:1,step:.01},{name:"palette",label:"Palette",type:"select",palette:!0,options:w,default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],render:F,cleanup:function(a){v(a||x.getGL&&x.getGL())}})})(),{}}export{C as default};
