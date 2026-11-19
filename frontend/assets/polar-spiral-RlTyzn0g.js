function a(t){return t.EffectRegistry.register({name:"polar_spiral",label:"Polar Spiral",category:"Math",description:"Hypnotic spiraling tunnel patterns in polar coordinates",params:[{name:"speed",label:"Speed",min:.1,max:5,default:1.5,step:.1},{name:"arms",label:"Arms",min:1,max:12,default:5,step:1,type:"int"},{name:"twist",label:"Twist",min:1,max:20,default:8,step:.5},{name:"zoom",label:"Radial Frequency",min:0,max:3,default:1,step:.1},{name:"style",label:"Style",type:"select",options:["Spiral","Log Spiral","Double Spiral","Vortex"],default:0}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_arms;
uniform float u_twist;
uniform float u_zoom;
uniform float u_style;

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed + seedPhase();

    float r = length(uv);
    float a = atan(uv.y, uv.x);

    float val = 0.0;
    int style = int(u_style);

    if (style == 0) {
        val = sin(a * u_arms + r * u_twist - t * 2.0) * 0.5 + 0.5;
    } else if (style == 1) {
        val = sin(a * u_arms + log(r + 0.001) * u_twist - t * 2.0) * 0.5 + 0.5;
    } else if (style == 2) {
        val = sin(a * u_arms + r * u_twist - t * 2.0) * 0.5 + 0.5;
        val *= sin(a * u_arms - r * u_twist + t * 1.5) * 0.5 + 0.5;
    } else {
        float distort = u_twist * exp(-r * 2.0);
        val = sin((a + distort) * u_arms - t * 2.0 + r * 5.0) * 0.5 + 0.5;
    }

    // Zoom animation
    val = sin(val * 3.14159 + r * u_zoom * 5.0 - t) * 0.5 + 0.5;

    // One whole hue turn per revolution, so no seam where atan wraps.
    float hue = fract(val * 0.3 + a / 6.28318 + t * 0.03);
    float sat = 0.7 + 0.3 * val;
    float bri = 0.3 + 0.7 * val;

    vec3 col = hsv2rgb(vec3(hue, sat, bri));

    // Center glow
    col += vec3(0.2, 0.05, 0.3) * (1.0 / (r * 5.0 + 1.0));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{a as default};
