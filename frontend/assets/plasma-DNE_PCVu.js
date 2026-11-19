function R(b){return b.EffectRegistry.register({name:"plasma",label:"Plasma",category:"Demoscene",description:"Classic lava lamp plasma with flowing, pulsing color blobs",params:[{name:"speed",label:"Speed",min:.1,max:5,default:1,step:.1},{name:"scale",label:"Scale",min:1,max:20,default:6,step:.5},{name:"complexity",label:"Complexity",min:1,max:8,default:4,step:1,type:"int"},{name:"saturation",label:"Saturation",min:0,max:1,default:.85},{name:"brightness",label:"Brightness",min:.2,max:1.5,default:.9}],cpuRender:function(l,h,f,y,N,e){for(var g=Number(e.speed)||1,s=Math.max(1,Number(e.scale)||6),M=Math.max(1,Number(e.complexity)||4),p=Number(e.saturation),m=isFinite(p)?Math.max(0,Math.min(1,p)):.85,v=Math.max(.2,Math.min(1.5,Number(e.brightness)||.9)),a=y*g,r=0,i=0;r<f;r++)for(var u=r/Math.max(f-1,1)*s,c=0;c<h;c++,i+=4){var o=c/Math.max(h-1,1)*s,n=Math.sin(o*1.1+a)+Math.sin(u*1.3+a*.7)+Math.sin((o+u)*.7+a*1.3)+Math.sin(Math.hypot(o-s*.5,u-s*.5)*1.2-a);M>2&&(n+=Math.sin(o*2.1-a*.5)*.5),M>4&&(n+=Math.sin(u*1.8+a*.8)*.4);var x=.5+.5*Math.cos(n*.63+a*.2),_=.5+.5*Math.cos(n*.63+a*.2+2.0944),d=.5+.5*Math.cos(n*.63+a*.2+4.1888),t=(x+_+d)/3;l[i]=Math.round(Math.min(1,(t+(x-t)*m)*v)*255),l[i+1]=Math.round(Math.min(1,(t+(_-t)*m)*v)*255),l[i+2]=Math.round(Math.min(1,(t+(d-t)*m)*v)*255),l[i+3]=255}},shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_scale;
uniform float u_complexity;
uniform float u_saturation;
uniform float u_brightness;

void main() {
    vec2 uv = v_uv * u_scale + seedOffset() * 0.01;
    float t = u_time * u_speed + seedPhase();

    float v1 = sin(uv.x * 1.1 + t);
    float v2 = sin(uv.y * 1.3 + t * 0.7);
    float v3 = sin((uv.x + uv.y) * 0.7 + t * 1.3);
    float v4 = sin(length(uv - vec2(u_scale * 0.5)) * 1.2 - t);

    float val = v1 + v2 + v3 + v4;

    if (u_complexity > 2.0) {
        val += sin(uv.x * 2.1 - t * 0.5) * 0.5;
        val += sin(uv.y * 1.8 + t * 0.8) * 0.5;
    }
    if (u_complexity > 4.0) {
        val += sin(length(uv - vec2(u_scale * 0.3, u_scale * 0.7)) * 1.5 + t * 1.1) * 0.4;
        val += sin(dot(uv, vec2(0.7, 1.3)) + t * 0.6) * 0.3;
    }
    if (u_complexity > 6.0) {
        val += sin(uv.x * uv.y * 0.1 + t) * 0.3;
        val += sin(atan(uv.y - u_scale*0.5, uv.x - u_scale*0.5) * 3.0 + t) * 0.3;
    }

    vec3 col = hsv2rgb(vec3(val * 0.1 + t * 0.05, u_saturation, u_brightness));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{R as default};
