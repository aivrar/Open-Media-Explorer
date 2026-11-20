function S(d){var r=d.AudioReactor,b=d.EffectRegistry;d.Music;var w=d.Renderer;return(function(){"use strict";var m=[[1,3],[2,5],[3,7],[1,5],[4,7],[2,7],[3,5],[5,9],[1,4],[4,9],[3,8],[6,11],[2,9],[5,7]],e={n1:2,m1:5,n2:2,m2:5,blend:1,fadeStart:0,nextAt:0,idx:1,note:-1,noteSince:0,lastPeak:0},y=JSON.stringify(e);function v(){e=JSON.parse(y)}function s(a,t,l,i,o){var n=l(t,i);n!==null&&a.uniform1f(n,o)}function _(){return typeof r<"u"?r.getClock():w.getUnwrappedTime()}function p(a,t){a===e.n2&&t===e.m2||(e.n1=e.n2,e.m1=e.m2,e.n2=a,e.m2=t,e.blend=0,e.fadeStart=_())}function g(){if(typeof r>"u"||!r.getAnalysis||!r.isLive||!r.isLive())return-1;var a=r.getAnalysis();if(!a||!a.fft||!a.active)return-1;for(var t=a.spectrum||a.fft,l=(a.sampleRate||48e3)/(a.fftSize||t.length*2),i=0,o=-1,n=Math.max(1,Math.ceil(130/l));n<=Math.min(t.length-1,Math.floor(6500/l));n++){var f=a.byteData?t[n]/255:t[n];f>i&&(i=f,o=n)}if(o<0||i<(a.fftScale==="linear"?.02:.35))return-1;var u=o*l;return Math.round(12*Math.log(u/440)/Math.LN2)+69}function M(a,t,l,i){var o=_(),n=Math.round(l.mode_control||0);if(n===2){var f=Math.max(1,Math.round(l.n||2)),u=Math.max(1,Math.round(l.m||5));u===f&&(u=f+1),p(f,u)}else{var c=n===1?g():-1;if(c>=0){if(c!==e.note&&(e.note=c,e.noteSince=o),o-e.noteSince>.25){var h=(c%12+12)%12,k=Math.floor(c/12),x=1+h%6;p(x,x+2+(h+k)%5)}e.nextAt=o+Math.max(1,l.cycle_time||6)}else o>=e.nextAt&&(e.idx=(e.idx+1)%m.length,p(m[e.idx][0],m[e.idx][1]),e.nextAt=o+Math.max(1,l.cycle_time||6))}var A=n===1?.6:1.4;e.blend=Math.min(1,(o-e.fadeStart)/A);var C=e.blend*e.blend*(3-2*e.blend);s(a,t,i,"u_n1",e.n1),s(a,t,i,"u_m1",e.m1),s(a,t,i,"u_n2",e.n2),s(a,t,i,"u_m2",e.m2),s(a,t,i,"u_blend",C)}b.register({name:"cymatics",label:"Cymatics",category:"Math",description:"Chladni plate patterns: sand gathers on the still lines of a vibrating plate, following the music",setUniforms:M,init:v,cleanup:v,params:[{name:"plate",label:"Plate",type:"select",options:["Square","Circle","Hexagon"],default:0},{name:"mode_control",label:"Pattern From",type:"select",options:["Auto Cycle","Follow Music","Manual"],default:1},{name:"n",label:"Mode n (manual)",type:"int",min:1,max:12,default:3,step:1},{name:"m",label:"Mode m (manual)",type:"int",min:1,max:14,default:7,step:1},{name:"cycle_time",label:"Cycle Time (sec)",min:1,max:20,default:6,step:.5},{name:"sand_width",label:"Line Width",min:.02,max:.4,default:.11,step:.005},{name:"grain",label:"Sand Grain",min:0,max:1,default:.6,step:.01},{name:"field_glow",label:"Wave Glow",min:0,max:1,default:.35,step:.01},{name:"scheme",label:"Colours",type:"select",options:["Brass & Sand","Neon","Ice","Fire"],default:0},{name:"zoom",label:"Zoom",min:.5,max:2,default:1,step:.01},{name:"audio_react",label:"Beat Reaction",min:0,max:2,default:1,step:.01}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_plate;
uniform float u_mode_control;
uniform float u_n;
uniform float u_m;
uniform float u_cycle_time;
uniform float u_sand_width;
uniform float u_grain;
uniform float u_field_glow;
uniform float u_scheme;
uniform float u_zoom;
uniform float u_audio_react;
uniform float u_n1;
uniform float u_m1;
uniform float u_n2;
uniform float u_m2;
uniform float u_blend;
uniform vec4 u_audio;
uniform vec4 u_beat;

const float PI = 3.14159265;

float plateField(vec2 p, float n, float m) {
    float s = floor(u_plate + 0.5);
    if (s < 0.5) return cos(n * PI * p.x) * cos(m * PI * p.y) - cos(m * PI * p.x) * cos(n * PI * p.y);
    if (s < 1.5) {
        float r = length(p);
        float a = atan(p.y, p.x);
        return cos(m * PI * r * 0.5) * cos(n * a) / sqrt(0.25 + r);
    }
    vec2 d1 = vec2(1.0, 0.0), d2 = vec2(0.5, 0.8660254), d3 = vec2(-0.5, 0.8660254);
    float k = n * PI * 0.75, k2 = m * PI * 0.75;
    return (cos(k * dot(p, d1)) + cos(k * dot(p, d2)) + cos(k * dot(p, d3))) -
           (cos(k2 * dot(p, d1)) + cos(k2 * dot(p, d2)) + cos(k2 * dot(p, d3)));
}

float plateMask(vec2 p) {
    float s = floor(u_plate + 0.5);
    if (s < 0.5) return step(max(abs(p.x), abs(p.y)), 1.0);
    if (s < 1.5) return step(length(p), 1.0);
    vec2 q = abs(p);
    return step(max(q.x * 0.8660254 + q.y * 0.5, q.y), 0.95);
}

void schemeColors(out vec3 plate, out vec3 sand, out vec3 waveA, out vec3 waveB) {
    float s = floor(u_scheme + 0.5);
    if (s < 0.5) { plate = vec3(0.16, 0.11, 0.06); sand = vec3(1.0, 0.92, 0.75); waveA = vec3(0.9, 0.55, 0.2); waveB = vec3(0.3, 0.2, 0.6); }
    else if (s < 1.5) { plate = vec3(0.03, 0.02, 0.06); sand = vec3(0.6, 1.0, 0.95); waveA = vec3(1.0, 0.2, 0.8); waveB = vec3(0.2, 0.5, 1.0); }
    else if (s < 2.5) { plate = vec3(0.05, 0.08, 0.12); sand = vec3(0.92, 0.97, 1.0); waveA = vec3(0.3, 0.7, 1.0); waveB = vec3(0.6, 0.3, 1.0); }
    else { plate = vec3(0.08, 0.02, 0.01); sand = vec3(1.0, 0.85, 0.45); waveA = vec3(1.0, 0.3, 0.05); waveB = vec3(0.6, 0.0, 0.15); }
}

void main() {
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y * 2.3 / u_zoom;
    float react = u_audio_react;
    float kick = u_beat.x * react;
    float bass = u_audio.x * react;
    vec3 plateCol, sandCol, waveA, waveB;
    schemeColors(plateCol, sandCol, waveA, waveB);
    float inside = plateMask(p);

    // Sand jumps on kicks: the lookup point jitters.
    vec2 jitter = (hash3(floor(gl_FragCoord.xy * 0.5) + floor(u_time * 30.0)).xy - 0.5) * 0.03 * kick;
    vec2 q = p + jitter;
    float f1 = plateField(q, u_n1, u_m1);
    float f2 = plateField(q, u_n2, u_m2);
    float f = mix(f1, f2, u_blend);
    float w = u_sand_width * (1.0 + bass * 0.6) * (1.0 + 0.5 * (1.0 - abs(u_blend * 2.0 - 1.0)));
    float sand = exp(-(f * f) / (w * w));
    float grains = step(0.45, hash2(floor(gl_FragCoord.xy * 0.75)));
    sand = mix(sand, sand * (0.35 + 0.65 * grains), u_grain);

    // Brushed plate with a soft highlight, plus a faint view of the standing wave.
    float sheen = 0.6 + 0.4 * smoothstep(-1.2, 1.2, p.x + p.y * 0.3);
    vec3 col = plateCol * sheen;
    col += mix(waveB, waveA, step(0.0, f)) * abs(f) * 0.25 * u_field_glow * (0.6 + 0.4 * sin(u_time * 6.0 + bass * 3.0));
    col = mix(col, sandCol, clamp(sand, 0.0, 1.0));
    col += sandCol * sand * kick * 0.3;
    // Outside the plate: dark backdrop with a rim glow.
    vec3 outside = vec3(0.01, 0.01, 0.015) + plateCol * 0.15 * (1.0 - smoothstep(1.0, 1.6, length(p)));
    col = mix(outside, col, inside);
    FRAG_OUT = vec4(col, 1.0);
}
`})})(),{}}export{S as default};
