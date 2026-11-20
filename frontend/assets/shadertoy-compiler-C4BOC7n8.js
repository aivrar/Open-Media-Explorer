function E(b){return{ShadertoyCompiler:(function(){"use strict";var g=`attribute vec2 a_position;
varying vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`,_=`#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;function m(r){return r?r.split(`
`).length:0}function p(r){return r?r.split(`
`).length-1:0}function S(r,o,e,s){return r&&String(r).replace(/\b(ERROR|WARNING):\s*(\d+):(\d+)(?=:)/g,function(a,i,n,u){var t=Number(u);return t>=e&&t<e+s?i+": "+n+":"+(t-e+1):t>=o&&t<e?i+": Common "+n+":"+(t-o+1):i+": host "+n+":"+t})}function c(r,o,e){var s=[],a=String(r||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,`
`);return a=a.replace(/^[ \t]*#version[^\n]*(?:\n|$)/gm,function(i){return s.push(i.trim()),`
`}),s.length>1?e.push(o+" contained multiple #version directives; host wrapper normalized them."):s.length===1&&e.push(o+" #version directive was removed; host wrapper owns GLSL version."),{source:a,versions:s}}function x(r){return/void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(r)||/void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*vec2\s+\w+\s*\)/.test(r)}function L(r,o){var e=r.length,s=m(r),a=r.match(/\bfor\s*\(/g)||[];(e>15e4||s>4500)&&o.push("Shader source is very large and may compile slowly or stall the browser."),a.length>80&&o.push("Shader contains many loops; use Safe Mode for imported shaders if compile time is a concern.")}function C(r,o){var e=[];return o=o||{},r?(e.push("#version 300 es"),e.push("precision highp float;"),e.push("precision highp int;"),e.push("in vec2 v_uv;"),e.push("out vec4 fragColor;")):(o.derivatives&&e.push("#extension GL_OES_standard_derivatives : enable"),o.textureLod&&e.push("#extension GL_EXT_shader_texture_lod : enable"),e.push("precision highp float;"),e.push("precision highp int;"),e.push("varying vec2 v_uv;")),e.push("uniform vec3 iResolution;"),e.push("uniform float iTime;"),e.push("uniform float iTimeDelta;"),e.push("uniform float iFrameRate;"),e.push("uniform int iFrame;"),e.push("uniform vec4 iMouse;"),e.push("uniform vec4 iDate;"),e.push("uniform float iSampleRate;"),e.push("uniform float u_view_zoom;"),e.push("uniform float u_view_zoom_speed;"),e.push("uniform float u_view_zoom_depth;"),e.push("uniform float u_global_rotation;"),e.push("uniform float iChannelTime[4];"),e.push("uniform vec3 iChannelResolution[4];"),e.push("uniform vec4 iChannelDate[4];"),e.push("uniform sampler2D iChannel0;"),e.push("uniform sampler2D iChannel1;"),e.push("uniform sampler2D iChannel2;"),e.push("uniform sampler2D iChannel3;"),e.push("#define iGlobalTime iTime"),r?(e.push("#define texture2D texture"),e.push("#define gl_FragColor fragColor")):(e.push("#define texture texture2D"),o.textureLod&&(e.push("#define textureLod texture2DLodEXT"),e.push("#define textureGrad texture2DGradEXT"))),e.push("float psyViewZoom(float time) {"),e.push("    float base = u_view_zoom > 0.0 ? u_view_zoom : 1.0;"),e.push("    float motion = 1.0;"),e.push("    if (u_view_zoom_depth > 0.0 && abs(u_view_zoom_speed) > 0.0001) {"),e.push("        motion = exp(sin(time * u_view_zoom_speed) * min(u_view_zoom_depth, 2.5) * 0.45);"),e.push("    }"),e.push("    return clamp(base * motion, 0.05, 24.0);"),e.push("}"),e.push("vec2 psyViewFragCoord(vec2 fragCoord) {"),e.push("    vec2 uv = fragCoord / iResolution.xy;"),e.push("    vec2 p = uv - vec2(0.5);"),e.push("    float aspect = iResolution.x / max(iResolution.y, 1.0);"),e.push("    p.x *= aspect;"),e.push("    float cr = cos(u_global_rotation);"),e.push("    float sr = sin(u_global_rotation);"),e.push("    p = mat2(cr, -sr, sr, cr) * p / psyViewZoom(iTime);"),e.push("    p.x /= aspect;"),e.push("    uv = p + vec2(0.5);"),e.push("    return uv * iResolution.xy;"),e.push("}"),e.join(`
`)+`
`}function v(r){r=r||{};var o=[],e=!!r.isWebGL2,s=c(r.commonSource||"","Common source",o),a=c(r.passSource||"",r.passName||"Pass source",o),i=s.source+`
`+a.source,n=[];L(i,o),x(i)||n.push("Shadertoy pass must define void mainImage(out vec4 fragColor, in vec2 fragCoord).");var u=C(e,r.webgl1Extensions),t=p(u)+1,h=t+p(s.source)+1,f=(r.passId||"image")==="image"?"psyViewFragCoord(gl_FragCoord.xy)":"gl_FragCoord.xy",l=e?`
void main() {
    vec4 color = vec4(0.0);
    mainImage(color, `+f+`);
    fragColor = color;
}
`:`
void main() {
    vec4 color = vec4(0.0);
    mainImage(color, `+f+`);
    gl_FragColor = color;
}
`;return{source:u+s.source+`
`+a.source+l,warnings:o,errors:n,sections:[{name:"host-prefix",generated:!0,startLine:1,lineCount:m(u)},{name:"common",generated:!1,startLine:t,lineCount:m(s.source)},{name:r.passName||"pass",generated:!1,startLine:h,lineCount:m(a.source)},{name:"host-suffix",generated:!0,startLine:h+m(a.source),lineCount:m(l)}],versions:s.versions.concat(a.versions)}}function d(r,o,e){var s=r.createShader(o);if(r.shaderSource(s,e),r.compileShader(s),!r.getShaderParameter(s,r.COMPILE_STATUS)){var a=r.getShaderInfoLog(s)||"Unknown shader compile error";return r.deleteShader(s),{shader:null,log:a}}return{shader:s,log:""}}function w(r,o){o=o||{};var e=o.passId||o.passName||"image",s=o.isWebGL2;s===void 0&&(s=typeof WebGL2RenderingContext<"u"&&r instanceof WebGL2RenderingContext);var a=o.webgl1Extensions||{};!s&&r&&(a={derivatives:!!r.getExtension("OES_standard_derivatives"),textureLod:!!r.getExtension("EXT_shader_texture_lod")});var i=v({isWebGL2:s,webgl1Extensions:a,commonSource:o.commonSource||"",passSource:o.passSource||"",passName:o.passName||e,passId:e}),n={passId:e,passName:o.passName||e,shaderType:"fragment",success:!1,program:null,shaderLog:"",vertexLog:"",linkLog:"",warnings:i.warnings.slice(),errors:i.errors.slice(),finalSource:i.source,vertexSource:s?_:g,isWebGL2:s,lineOffset:{commonStart:i.sections[1].startLine,passStart:i.sections[2].startLine},sections:i.sections};if(!r)return n.errors.push("No WebGL context available."),n.shaderLog=n.errors.join(`
`),n;if(n.errors.length)return n.shaderLog=n.errors.join(`
`),n;var u=d(r,r.VERTEX_SHADER,n.vertexSource);if(!u.shader)return n.vertexLog=u.log,n.shaderLog=u.log,n;var t=d(r,r.FRAGMENT_SHADER,i.source);if(!t.shader)return n.rawShaderLog=t.log,n.shaderLog=S(t.log,n.lineOffset.commonStart,n.lineOffset.passStart,Math.max(1,i.sections[2].lineCount)),r.deleteShader(u.shader),n;var h=r.createProgram();return r.attachShader(h,u.shader),r.attachShader(h,t.shader),r.linkProgram(h),r.deleteShader(u.shader),r.deleteShader(t.shader),r.getProgramParameter(h,r.LINK_STATUS)?(n.success=!0,n.program=h,n):(n.linkLog=r.getProgramInfoLog(h)||"Unknown program link error",n.shaderLog=n.linkLog,r.deleteProgram(h),n)}return{createProgram:w,buildFragmentSource:v}})()}}export{E as default};
