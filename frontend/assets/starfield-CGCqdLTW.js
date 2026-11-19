function t(e){return e.EffectRegistry.register({name:"starfield",label:"Starfield",category:"Demoscene",description:"Flying through a 3D starfield at warp speed",params:[{name:"speed",label:"Speed",min:.5,max:10,default:3,step:.5},{name:"density",label:"Star Density",min:10,max:200,default:80,step:10,type:"int"},{name:"star_size",label:"Star Size",min:.5,max:5,default:1.5,step:.1},{name:"trail_length",label:"Trail Length",min:0,max:1,default:.5,step:.05},{name:"colorful",label:"Colorful",min:0,max:1,default:.3,step:.05}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_speed;
uniform float u_density;
uniform float u_star_size;
uniform float u_trail_length;
uniform float u_colorful;

float starLayer(vec2 uv, float t, float scale) {
    vec2 gv = fract(uv * scale) - 0.5;
    vec2 id = floor(uv * scale);

    float brightness = 0.0;

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offs = vec2(float(x), float(y));
            float n = hash2(id + offs);
            vec2 starPos = (vec2(n, fract(n * 34.56)) - 0.5);
            starPos.y -= fract(t * (0.3 + n * 0.7));
            starPos = fract(starPos + 0.5) - 0.5;

            float d = length(gv - offs - starPos);
            float s = u_star_size * 0.02 * (0.5 + n * 0.5);

            // Star glow: a bright core about s wide with a short halo, so
            // neighbouring stars and layers don't add up to a grey haze.
            brightness += 3.0 * s * s / (d * d + s * s);

            // Trail
            // Trail: as wide as the star, fading out above it, so it never
            // reaches the edge of the 3x3 neighbourhood and gets cut off.
            if (u_trail_length > 0.0) {
                float dy = gv.y - offs.y - starPos.y;
                float trail = smoothstep(s * 1.5, 0.0, abs(gv.x - offs.x - starPos.x))
                            * smoothstep(0.0, s, dy) * exp(-max(dy, 0.0) / (u_trail_length * 0.4));
                brightness += trail * s * 20.0;
            }
        }
    }

    return brightness;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);

    // Mouse offset
    uv += (u_mouse - 0.5) * 0.3;

    float t = u_time * u_speed * 0.3;

    vec3 col = vec3(0.0);

    // Multiple layers for depth
    for (float i = 0.0; i < 4.0; i++) {
        float depth = 1.0 + i * 0.5;
        float brightness = starLayer(uv, t, u_density * 0.1 * depth) * (1.0 / depth);

        if (u_colorful > 0.0) {
            vec3 starCol = hsv2rgb(vec3(fract(i * 0.25 + t * 0.05), u_colorful, 1.0));
            col += brightness * starCol;
        } else {
            col += brightness;
        }
    }

    col = min(col, vec3(1.0));

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{t as default};
