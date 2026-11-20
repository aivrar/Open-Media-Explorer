function M(c){var D=c.Controls,z=c.EffectRegistry,a=c.GpuSim,u=c.Math,h=c.Renderer;return(function(){"use strict";var t=null,k={warned:!1},b=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
`,P=b+`float hh(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hh(i), hh(i + vec3(1,0,0)), f.x), mix(hh(i + vec3(0,1,0)), hh(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hh(i + vec3(0,0,1)), hh(i + vec3(1,0,1)), f.x), mix(hh(i + vec3(0,1,1)), hh(i + vec3(1,1,1)), f.x), f.y), f.z); }
float field(vec2 p, float t, float turb) { return vn(vec3(p, t)) + turb * 0.5 * vn(vec3(p * 2.3 + 7.1, t * 1.3)) + turb * 0.25 * vn(vec3(p * 5.1 - 3.3, t * 1.7)); }
vec2 curl(vec2 p, float t, float turb) {
    float e = 0.01;
    float a = field(p + vec2(0.0, e), t, turb), b = field(p - vec2(0.0, e), t, turb);
    float c = field(p + vec2(e, 0.0), t, turb), d = field(p - vec2(e, 0.0), t, turb);
    return vec2(a - b, -(c - d)) / (2.0 * e);
}
uniform sampler2D u_state; uniform float u_time; uniform float u_dt; uniform float u_speed; uniform float u_scale; uniform float u_turb;
uniform float u_evolve; uniform float u_life; uniform float u_aspect; uniform float u_spawn; uniform float u_spin;
float h2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec4 s = texture(u_state, v_uv);
    float seed = h2(v_uv * 911.7);
    vec2 pos = s.xy;
    vec2 q = vec2(pos.x * u_aspect, pos.y) * u_scale;
    vec2 vel = curl(q, u_time * u_evolve, u_turb);
    pos += vel * vec2(1.0 / u_aspect, 1.0) * u_speed * u_dt * 0.16;
    float age = s.z + u_dt;
    float life = u_life * (0.5 + seed);
    if (age > life || pos.x < -0.02 || pos.x > 1.02 || pos.y < -0.02 || pos.y > 1.02) {
        float r = u_time * 0.37 + seed * 17.0;
        float ha = h2(v_uv * 37.1 + r), hb = h2(v_uv * 53.7 - r);
        if (u_spawn < 0.5) pos = vec2(ha, hb);
        else if (u_spawn < 1.5) { float a = ha * 6.28318 + u_spin; pos = 0.5 + vec2(cos(a) / u_aspect, sin(a)) * (0.18 + hb * 0.03); }
        else if (u_spawn < 2.5) pos = vec2(0.15 + ha * 0.7, 0.5 + (hb - 0.5) * 0.03);
        else pos = ha < 0.5 ? vec2(hb * 0.02, ha * 2.0) : vec2(1.0 - hb * 0.02, ha * 2.0 - 1.0);
        age = 0.0;
    }
    o = vec4(pos, age, atan(vel.y, vel.x));
}`,A=`#version 300 es
precision highp float;
uniform sampler2D u_state; uniform int u_size; uniform float u_life; uniform float u_colorBy; uniform float u_phase;
out float v_t; out float v_a;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
    ivec2 c = ivec2(gl_VertexID % u_size, gl_VertexID / u_size);
    vec4 s = texelFetch(u_state, c, 0);
    float seed = h1(float(gl_VertexID) * 0.618);
    float life = u_life * 0.75;
    v_a = smoothstep(0.0, 0.4, s.z) * (1.0 - smoothstep(life * 0.7, life * 1.2, s.z));
    v_t = u_colorBy < 0.5 ? s.w / 6.28318 + 0.5 : (u_colorBy < 1.5 ? seed : s.x * 0.6 + s.y * 0.4);
    v_t += u_phase;
    gl_Position = vec4(s.xy * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`,L=`#version 300 es
precision highp float;
in float v_t; in float v_a; out vec4 o;
uniform sampler2D u_lut; uniform float u_useLut; uniform float u_scheme; uniform float u_amount;
vec3 scheme(float t) {
    if (u_scheme < 0.5) return mix(vec3(0.95, 0.55, 0.75), vec3(0.55, 0.75, 1.0), 0.5 + 0.5 * sin(t * 6.28318)) + 0.15;
    if (u_scheme < 1.5) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.6, 0.85, 0.1)));
    if (u_scheme < 2.5) return mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.85, 0.3), 0.5 + 0.5 * sin(t * 6.28318));
    return mix(vec3(0.2, 0.5, 1.0), vec3(0.85, 0.97, 1.0), 0.5 + 0.5 * sin(t * 6.28318));
}
void main() { vec3 c = u_useLut > 0.5 ? texture(u_lut, vec2(fract(v_t), 0.5)).rgb : scheme(fract(v_t)); o = vec4(c * v_a * u_amount, 1.0); }`,B=b+`uniform sampler2D u_src; uniform float u_keep;
void main() { o = texture(u_src, v_uv) * u_keep; }`,R=b+`uniform sampler2D u_src; uniform float u_exposure;
void main() { vec3 c = texture(u_src, v_uv).rgb; o = vec4(pow(1.0 - exp(-c * u_exposure * 1.6), vec3(1.25)), 1.0); }`,V=[256,512,1024],x=["Silk","Neon","Fire","Ice"];function p(e){t&&a.release(e,[t.state,t.light]),t=null}function N(e,w){if(!a.supported(e))return!1;var i=V[u.round(w.particles!==void 0?w.particles:1)]||512,_=e.canvas.width,r=e.canvas.height;if(t&&t.gl===e&&t.size===i&&t.w===_&&t.h===r&&e.isTexture(t.state.read.tex))return!0;var o=t&&t.gl===e?t:null;o?t=null:p(e),t={gl:e,size:i,w:_,h:r,warm:45},t.pMove=a.cached(e,"Silk move",a.VS_QUAD,P),t.pDot=a.cached(e,"Silk dots",A,L),t.pFade=a.cached(e,"Silk fade",a.VS_QUAD,B),t.pDisplay=a.cached(e,"Silk display",a.VS_QUAD,R);for(var f=new Float32Array(i*i*4),l=0;l<i*i;l++)f[l*4]=u.random(),f[l*4+1]=u.random(),f[l*4+2]=u.random()*4,f[l*4+3]=0;var y={internal:e.RGBA32F,type:e.FLOAT,filter:e.NEAREST};if(t.state=a.pair(e,i,i,y),t.state&&(e.bindTexture(e.TEXTURE_2D,t.state.read.tex),e.texSubImage2D(e.TEXTURE_2D,0,0,0,i,i,e.RGBA,e.FLOAT,f),e.bindTexture(e.TEXTURE_2D,null)),t.light=a.pair(e,_,r),!t.pMove||!t.pDot||!t.pFade||!t.pDisplay||!t.state||!t.light)return p(e),t=o,p(e),!1;if(o){a.carry(e,o.state,t.state,!0),a.carry(e,o.light,t.light),t.warm=0;var v=t;t=o,p(e),t=v}return!0}function I(e,w,i,_){var r=D.getValues?D.getValues():{};if(!N(e,r)){a.unsupportedFrame(e,"Curl-Noise Silk",k);return}var o=r.audio_react!==void 0?r.audio_react:1,f=a.audio("kick")*o,l=a.audio("bass")*o,y=a.audio("hat")*o,v=u.min(1/20,u.max(0,_)),S=r.life||6;e.disable(e.DEPTH_TEST),e.disable(e.BLEND);var E=v>0?1+u.min(t.warm,2):0;t.warm=u.max(0,t.warm-(E-1));for(var T=0;T<E;T++){t.evolveT=(t.evolveT||0)+v*(r.evolve!==void 0?r.evolve:.3)*(1+l*1.5);var n=t.pMove;e.useProgram(n.p),a.bind(e,0,t.state.read.tex,n.u.u_state),e.uniform1f(n.u.u_time,t.evolveT),e.uniform1f(n.u.u_dt,v),e.uniform1f(n.u.u_speed,(r.speed!==void 0?r.speed:1)*(1+f*1.2)),e.uniform1f(n.u.u_scale,r.flow_scale||2),e.uniform1f(n.u.u_turb,r.turbulence!==void 0?r.turbulence:.5),e.uniform1f(n.u.u_evolve,1),e.uniform1f(n.u.u_life,S),e.uniform1f(n.u.u_aspect,t.w/u.max(1,t.h)),e.uniform1f(n.u.u_spawn,u.round(r.spawn!==void 0?r.spawn:1)),e.uniform1f(n.u.u_spin,i*.1),a.draw(e,n,t.state.write),t.state.swap();var m=t.pFade;e.useProgram(m.p),a.bind(e,0,t.light.read.tex,m.u.u_src),e.uniform1f(m.u.u_keep,u.pow(r.trail!==void 0?r.trail:.96,v*60)),a.draw(e,m,t.light.write),t.light.swap();var s=t.pDot;e.useProgram(s.p),a.bind(e,0,t.state.read.tex,s.u.u_state),e.uniform1i(s.u.u_size,t.size),e.uniform1f(s.u.u_life,S),e.uniform1f(s.u.u_colorBy,u.round(r.color_by||0)),e.uniform1f(s.u.u_phase,i*.02);var F=u.round(r.palette||0);a.bindPalette(e,7,F,x.length,s.u.u_lut,s.u.u_useLut),e.uniform1f(s.u.u_scheme,u.min(F,x.length-1));var C=262144/(t.size*t.size);e.uniform1f(s.u.u_amount,.012*C*(1+y*.6)),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),a.points(e,t.size*t.size,t.light.read),e.disable(e.BLEND)}h.bindFramebuffer(-1),e.viewport(0,0,e.canvas.width,e.canvas.height);var d=t.pDisplay;e.useProgram(d.p),a.bind(e,0,t.light.read.tex,d.u.u_src),e.uniform1f(d.u.u_exposure,(r.brightness||1)*(1+f*.5)),a.draw(e,d,null),a.unbind(e,8)}z.register({name:"curl_silk",label:"Curl-Noise Silk",category:"Simulation",description:"Hundreds of thousands of particles flowing through swirling curl noise, leaving silky long-exposure trails",params:[{name:"particles",label:"Particles",type:"select",options:["65K","262K","1M"],default:1},{name:"spawn",label:"Particles Start From",type:"select",options:["Everywhere","A Circle","A Line","The Sides"],default:1},{name:"flow_scale",label:"Swirl Size",min:.5,max:8,default:2,step:.05},{name:"speed",label:"Flow Speed",min:0,max:3,default:1,step:.01},{name:"turbulence",label:"Turbulence",min:0,max:1.5,default:.5,step:.01},{name:"evolve",label:"Field Change",min:0,max:2,default:.3,step:.01},{name:"trail",label:"Exposure Length",min:.8,max:.998,default:.985,step:.001},{name:"life",label:"Particle Life (sec)",min:1,max:20,default:6,step:.5},{name:"brightness",label:"Brightness",min:.2,max:4,default:1,step:.01},{name:"color_by",label:"Colour By",type:"select",options:["Direction","Particle","Position"],default:0},{name:"palette",label:"Palette",type:"select",palette:!0,options:x,default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],render:I,cleanup:function(e){p(e||h.getGL&&h.getGL())}})})(),{}}export{M as default};
