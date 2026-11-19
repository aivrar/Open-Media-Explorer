function l(e){return e.EffectRegistry.register({name:"voronoi",label:"Voronoi Cells",category:"Math",description:"Organic cell patterns like soap bubbles or stained glass",params:[{name:"speed",label:"Speed",min:.1,max:3,default:.8,step:.1},{name:"cell_count",label:"Cell Density",min:2,max:15,default:5,step:1,type:"int"},{name:"border_width",label:"Border Width",min:0,max:.15,default:.03,step:.005},{name:"color_speed",label:"Color Speed",min:0,max:2,default:.5,step:.05},{name:"style",label:"Style",type:"select",options:["Flat Cells","Distance Gradient","Edges Only","Stained Glass"],default:3}],shader:`
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_cell_count;
uniform float u_border_width;
uniform float u_color_speed;
uniform float u_style;

void main() {
    vec2 uv = v_uv * u_cell_count;
    float t = u_time * u_speed + seedPhase();

    vec2 cellId = vec2(0.0);
    float minDist = 10.0;
    float secondDist = 10.0;

    // Find closest and second-closest cell
    vec2 ip = floor(uv);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 cell = ip + neighbor;
            vec2 point = hash3(cell).xy;

            // Animate point positions
            point = 0.5 + 0.4 * sin(t * 0.5 + point * 6.28318);

            float d = length(uv - cell - point);
            if (d < minDist) {
                secondDist = minDist;
                minDist = d;
                cellId = cell;
            } else if (d < secondDist) {
                secondDist = d;
            }
        }
    }

    float edge = secondDist - minDist;
    float border = 1.0 - smoothstep(0.0, u_border_width + 0.001, edge);

    float hue = fract(hash2(cellId) + u_time * u_color_speed * 0.05);
    vec3 cellColor = hsv2rgb(vec3(hue, 0.7, 0.8));

    int style = int(u_style);
    vec3 col = vec3(0.0);

    if (style == 0) {
        col = cellColor * (1.0 - border) + vec3(0.1) * border;
    } else if (style == 1) {
        col = cellColor * (1.0 - minDist * 0.5);
    } else if (style == 2) {
        col = vec3(border) * rainbow(hue);
    } else {
        // Stained glass
        col = cellColor * (0.6 + 0.4 * (1.0 - minDist));
        col = mix(col, vec3(0.05), border);
        col += vec3(0.1) * (1.0 - minDist * 0.3); // Glow
    }

    FRAG_OUT = vec4(col, 1.0);
}
`}),{}}export{l as default};
