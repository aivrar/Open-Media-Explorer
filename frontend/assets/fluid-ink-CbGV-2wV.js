function oe(w){var Q=w.Controls,Z=w.EffectRegistry,t=w.GpuSim,r=w.Math,j=w.PsyPalettes,k=w.Renderer;return(function(){"use strict";var u=null,$={warned:!1},y=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
`,q={advect:y+`uniform sampler2D u_vel; uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_dt; uniform float u_keep;
void main() { vec2 c = v_uv - u_dt * texture(u_vel, v_uv).xy * u_texel; o = u_keep * texture(u_src, c); }`,splat:y+`uniform sampler2D u_target; uniform vec2 u_point; uniform vec3 u_value; uniform float u_radius; uniform float u_aspect;
void main() { vec2 p = v_uv - u_point; p.x *= u_aspect; o = vec4(texture(u_target, v_uv).xyz + exp(-dot(p, p) / u_radius) * u_value, 1.0); }`,curl:y+`uniform sampler2D u_vel; uniform vec2 u_texel;
void main() {
    float L = texture(u_vel, v_uv - vec2(u_texel.x, 0.0)).y, R = texture(u_vel, v_uv + vec2(u_texel.x, 0.0)).y;
    float T = texture(u_vel, v_uv + vec2(0.0, u_texel.y)).x, B = texture(u_vel, v_uv - vec2(0.0, u_texel.y)).x;
    o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,vorticity:y+`uniform sampler2D u_vel; uniform sampler2D u_curl; uniform vec2 u_texel; uniform float u_strength; uniform float u_dt;
void main() {
    float L = texture(u_curl, v_uv - vec2(u_texel.x, 0.0)).x, R = texture(u_curl, v_uv + vec2(u_texel.x, 0.0)).x;
    float T = texture(u_curl, v_uv + vec2(0.0, u_texel.y)).x, B = texture(u_curl, v_uv - vec2(0.0, u_texel.y)).x;
    float C = texture(u_curl, v_uv).x;
    vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    f = f / (length(f) + 1e-4) * u_strength * C;
    f.y = -f.y;
    o = vec4(texture(u_vel, v_uv).xy + f * u_dt, 0.0, 1.0);
}`,divergence:y+`uniform sampler2D u_vel; uniform vec2 u_texel;
void main() {
    vec2 C = texture(u_vel, v_uv).xy;
    float L = texture(u_vel, v_uv - vec2(u_texel.x, 0.0)).x, R = texture(u_vel, v_uv + vec2(u_texel.x, 0.0)).x;
    float T = texture(u_vel, v_uv + vec2(0.0, u_texel.y)).y, B = texture(u_vel, v_uv - vec2(0.0, u_texel.y)).y;
    if (v_uv.x - u_texel.x < 0.0) L = -C.x;
    if (v_uv.x + u_texel.x > 1.0) R = -C.x;
    if (v_uv.y + u_texel.y > 1.0) T = -C.y;
    if (v_uv.y - u_texel.y < 0.0) B = -C.y;
    o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,scale:y+`uniform sampler2D u_src; uniform float u_scale;
void main() { o = texture(u_src, v_uv) * u_scale; }`,pressure:y+`uniform sampler2D u_p; uniform sampler2D u_div; uniform vec2 u_texel;
void main() {
    float L = texture(u_p, v_uv - vec2(u_texel.x, 0.0)).x, R = texture(u_p, v_uv + vec2(u_texel.x, 0.0)).x;
    float T = texture(u_p, v_uv + vec2(0.0, u_texel.y)).x, B = texture(u_p, v_uv - vec2(0.0, u_texel.y)).x;
    o = vec4((L + R + B + T - texture(u_div, v_uv).x) * 0.25, 0.0, 0.0, 1.0);
}`,gradient:y+`uniform sampler2D u_p; uniform sampler2D u_vel; uniform vec2 u_texel;
void main() {
    float L = texture(u_p, v_uv - vec2(u_texel.x, 0.0)).x, R = texture(u_p, v_uv + vec2(u_texel.x, 0.0)).x;
    float T = texture(u_p, v_uv + vec2(0.0, u_texel.y)).x, B = texture(u_p, v_uv - vec2(0.0, u_texel.y)).x;
    o = vec4(texture(u_vel, v_uv).xy - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}`,display:y+`uniform sampler2D u_dye; uniform vec2 u_texel; uniform float u_shading; uniform float u_brightness; uniform vec3 u_bg;
uniform sampler2D u_dye_prev; uniform float u_prev;
vec3 dye(vec2 p) { return mix(texture(u_dye, p).rgb, texture(u_dye_prev, p).rgb, u_prev); }
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
void main() {
    vec3 c = dye(v_uv);
    float dx = lum(dye(v_uv + vec2(u_texel.x, 0.0))) - lum(dye(v_uv - vec2(u_texel.x, 0.0)));
    float dy = lum(dye(v_uv + vec2(0.0, u_texel.y))) - lum(dye(v_uv - vec2(0.0, u_texel.y)));
    vec3 n = normalize(vec3(-dx * 6.0, -dy * 6.0, 1.0));
    vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
    float a = clamp(lum(c), 0.0, 1.0);
    c *= 1.0 - u_shading * 0.4 + u_shading * 0.55 * diff;
    c += vec3(spec) * u_shading * 0.5 * smoothstep(0.02, 0.3, a);
    vec3 col = 1.0 - exp(-c * u_brightness * 1.4);
    col += u_bg * (1.0 - smoothstep(0.0, 0.25, a));
    o = vec4(col, 1.0);
}`},g=[128,192,288],ee=10,J=2,C=["Rainbow Cycle","Ink & Gold","Neon","Pastel"];function L(e,l,o,v){if(e>=C.length&&typeof j<"u")return j.sample(e-C.length,l*.05+o/v);var n=l*.05+o/r.max(v,1);if(e===1)return[[.05,.12,.6],[1,.7,.15],[.75,.05,.15]][o%3];if(e===2)return[[1,.1,.8],[.1,1,.9],[.6,1,.1],[.4,.2,1]][o%4];var i=(n-r.floor(n))*6,f=function(s){var _=(s+i)%6;return 1-r.max(0,r.min(1,r.min(_,4-_)))},x=[f(5),f(3),f(1)];return e===3&&(x=x.map(function(s){return .55+s*.45})),x}function D(e){u&&t.release(e,[u.vel,u.dye,u.pres,u.div,u.curl]),u=null}function ue(e,l){if(!t.supported(e))return!1;var o=e.canvas.width/r.max(1,e.canvas.height),v=g[r.round(l.resolution!==void 0?l.resolution:1)]||192,n=r.round(v*o);if(u&&u.gl===e&&u.sw===n&&u.sh===v&&e.isTexture(u.vel.read.tex))return!0;var i=u&&u.gl===e?u:null;i?u=null:D(e),u={gl:e,sw:n,sh:v,dw:n*2,dh:v*2,p:{},prevMouse:null,kick:-1};for(var f in q)if(u.p[f]=t.cached(e,"Fluid Ink "+f,t.VS_QUAD,q[f]),!u.p[f])return D(e),!1;if(u.vel=t.pair(e,n,v),u.pres=t.pair(e,n,v),u.dye=t.pair(e,n*2,v*2),u.div=t.target(e,n,v),u.curl=t.target(e,n,v),!u.vel||!u.pres||!u.dye||!u.div||!u.curl)return D(e),u=i,D(e),!1;if(i){t.carry(e,i.vel,u.vel),t.carry(e,i.pres,u.pres),t.carry(e,i.dye,u.dye),t.carry(e,i.dye.write,u.dye.write),u.prevMouse=i.prevMouse,u.kick=i.kick,u.n=i.n,u.held=i.held,u.stepDt=i.stepDt;var x=u;u=i,D(e),u=x}return!0}function c(e,l,o,v){var n=u.p[l];e.useProgram(n.p),v(n.u),t.draw(e,n,o)}function T(e,l,o,v,n,i,f){var x=u.sw/u.sh;c(e,"splat",u.vel.write,function(s){t.bind(e,0,u.vel.read.tex,s.u_target),e.uniform2f(s.u_point,l,o),e.uniform3f(s.u_value,v,n,0),e.uniform1f(s.u_radius,f),e.uniform1f(s.u_aspect,x)}),u.vel.swap(),c(e,"splat",u.dye.write,function(s){t.bind(e,0,u.dye.read.tex,s.u_target),e.uniform2f(s.u_point,l,o),e.uniform3f(s.u_value,i[0],i[1],i[2]),e.uniform1f(s.u_radius,f),e.uniform1f(s.u_aspect,x)}),u.dye.swap()}function re(e,l,o,v){var n=Q.getValues?Q.getValues():{};if(!ue(e,n)){t.unsupportedFrame(e,"Fluid Ink",$);return}var i=n.audio_react!==void 0?n.audio_react:1,f=t.audio("kick")*i,x=t.audio("bass")*i,s=t.audio("hat")*i,_=r.min(1/30,r.max(0,v));_>0&&(u.held=(u.held||0)+_,u.n=(u.n||0)+1);var h=_>0?2-u.n%2:0;h===1&&(u.stepDt=r.min(1/15,u.held),u.held=0),_=h>0?u.stepDt:0,u.mid=h===2;var R=r.round(n.palette||0),S=r.max(1,r.round(n.emitters||3)),P=(n.force!==void 0?n.force:1)*(1+x*.8),B=9e-4*(n.splat_size||1),d=[1/u.sw,1/u.sh];if(e.disable(e.BLEND),e.disable(e.DEPTH_TEST),h===1){for(var te=(n.motion!==void 0?n.motion:1)*.35,p=0;p<S;p++){var E=p*2.1+k.getSeed()*.001,M=o*te,ne=.5+.36*r.sin(M*(.9+p*.13)+E),ae=.5+.34*r.sin(M*(1.17+p*.07)+E*1.7),K=.36*(.9+p*.13)*r.cos(M*(.9+p*.13)+E),O=.34*(1.17+p*.07)*r.cos(M*(1.17+p*.07)+E*1.7),W=r.hypot(K,O)||1,I=L(R,o,p,S),F=_*9;T(e,ne,ae,K/W*P*260,O/W*P*260,[I[0]*F,I[1]*F,I[2]*F],B)}if(f>.55&&u.kick<.55)for(var z=0;z<S;z++){var X=r.random()*r.PI*2,A=L(R,o+3,z,S);T(e,.2+r.random()*.6,.2+r.random()*.6,r.cos(X)*P*1400,r.sin(X)*P*1400,[A[0]*1.2,A[1]*1.2,A[2]*1.2],B*2.5)}if(u.kick=f,s>.5&&r.random()<.3){var U=L(R,o+7,r.floor(r.random()*S),S);T(e,r.random(),r.random(),(r.random()-.5)*300,(r.random()-.5)*300,[U[0]*.5,U[1]*.5,U[2]*.5],B*.4)}var m=k.getMouse?k.getMouse():null;if(m&&u.prevMouse&&(m.x!==.5||m.y!==.5)){var V=m.x-u.prevMouse.x,H=m.y-u.prevMouse.y;if(r.abs(V)+r.abs(H)>5e-4&&r.abs(V)+r.abs(H)<.2){var N=L(R,o+11,0,1);T(e,m.x,m.y,V/_*60*6,H/_*60*6,[N[0]*.6,N[1]*.6,N[2]*.6],B*1.2)}}m&&(u.prevMouse={x:m.x,y:m.y}),c(e,"curl",u.curl,function(a){t.bind(e,0,u.vel.read.tex,a.u_vel),e.uniform2f(a.u_texel,d[0],d[1])}),c(e,"vorticity",u.vel.write,function(a){t.bind(e,0,u.vel.read.tex,a.u_vel),t.bind(e,1,u.curl.tex,a.u_curl),e.uniform2f(a.u_texel,d[0],d[1]),e.uniform1f(a.u_strength,(n.swirl!==void 0?n.swirl:1)*30),e.uniform1f(a.u_dt,_)}),u.vel.swap(),c(e,"divergence",u.div,function(a){t.bind(e,0,u.vel.read.tex,a.u_vel),e.uniform2f(a.u_texel,d[0],d[1])}),c(e,"scale",u.pres.write,function(a){t.bind(e,0,u.pres.read.tex,a.u_src),e.uniform1f(a.u_scale,.8)}),u.pres.swap()}if(h>0)for(var Y=h===1?0:J;Y<(h===1?J:ee);Y++)c(e,"pressure",u.pres.write,function(a){t.bind(e,0,u.pres.read.tex,a.u_p),t.bind(e,1,u.div.tex,a.u_div),e.uniform2f(a.u_texel,d[0],d[1])}),u.pres.swap();if(h===2){c(e,"gradient",u.vel.write,function(a){t.bind(e,0,u.pres.read.tex,a.u_p),t.bind(e,1,u.vel.read.tex,a.u_vel),e.uniform2f(a.u_texel,d[0],d[1])}),u.vel.swap();var ie=r.pow(n.persistence!==void 0?n.persistence:.99,_*60);c(e,"advect",u.vel.write,function(a){t.bind(e,0,u.vel.read.tex,a.u_vel),t.bind(e,1,u.vel.read.tex,a.u_src),e.uniform2f(a.u_texel,d[0],d[1]),e.uniform1f(a.u_dt,_),e.uniform1f(a.u_keep,ie)}),u.vel.swap();var ve=r.pow(n.ink_fade!==void 0?n.ink_fade:.985,_*60);c(e,"advect",u.dye.write,function(a){t.bind(e,0,u.vel.read.tex,a.u_vel),t.bind(e,1,u.dye.read.tex,a.u_src),e.uniform2f(a.u_texel,d[0],d[1]),e.uniform1f(a.u_dt,_),e.uniform1f(a.u_keep,ve)}),u.dye.swap()}k.bindFramebuffer(-1),e.viewport(0,0,e.canvas.width,e.canvas.height);var b=u.p.display;e.useProgram(b.p),t.bind(e,0,u.dye.read.tex,b.u.u_dye),t.bind(e,1,u.dye.write.tex,b.u.u_dye_prev),e.uniform1f(b.u.u_prev,u.mid?.5:0),e.uniform2f(b.u.u_texel,1/u.dw,1/u.dh),e.uniform1f(b.u.u_shading,n.shading!==void 0?n.shading:.6),e.uniform1f(b.u.u_brightness,(n.brightness||1)*(1+f*.25));var G=R===3?[.92,.9,.86]:[.012,.01,.02];e.uniform3f(b.u.u_bg,G[0],G[1],G[2]),t.draw(e,b,null),t.unbind(e,2)}Z.register({name:"fluid_ink",label:"Fluid Ink",category:"Simulation",description:"A real fluid simulation: swirling coloured ink poured and pushed around in water. Stir it with the mouse.",params:[{name:"emitters",label:"Ink Sources",type:"int",min:1,max:6,default:3,step:1},{name:"force",label:"Push Force",min:0,max:3,default:1,step:.01},{name:"splat_size",label:"Stream Size",min:.2,max:3,default:1,step:.01},{name:"motion",label:"Source Motion",min:0,max:3,default:1,step:.01},{name:"swirl",label:"Swirl (Vorticity)",min:0,max:2,default:1,step:.01},{name:"persistence",label:"Flow Persistence",min:.9,max:1,default:.99,step:.001},{name:"ink_fade",label:"Ink Persistence",min:.9,max:1,default:.985,step:.001},{name:"shading",label:"Gloss",min:0,max:1,default:.6,step:.01},{name:"brightness",label:"Brightness",min:.3,max:2.5,default:1,step:.01},{name:"resolution",label:"Simulation Detail",type:"select",options:["Low","Medium","High"],default:1},{name:"palette",label:"Ink Colours",type:"select",palette:!0,options:C,default:0},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],render:re,cleanup:function(e){D(e||k.getGL&&k.getGL())}})})(),{}}export{oe as default};
