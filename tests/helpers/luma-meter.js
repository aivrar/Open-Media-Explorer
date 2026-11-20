/* The mean luminance of what was just drawn, measured on the graphics card
   for the flash and effect checks (visualizer-flash-check.py,
   visualizer-fx-check-page.js); not part of the app.

   The checks used to read every pixel of every frame back and add them up in
   JavaScript (and, with overlays, read the top sheet back as well, which
   moves that canvas's drawing off the graphics card). Here the frame is
   copied into a texture, the top sheet (when there is one) uploaded from its
   canvas, and one pass adds up blocks of BLOCK x BLOCK pixels into a small
   float target: the same sum (Rec. 709 luma of the 8-bit picture, the top
   sheet laid over it source-over at opacity k), with only that small target
   read back. Loaded as a plain script: defines window.createLumaMeter. */

(function defineLumaMeter() {
  const BLOCK = 16;
  const VERT = '#version 300 es\nin vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }\n';
  const FRAG = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_frame;',
    'uniform sampler2D u_top;',
    'uniform int u_hasTop;',
    'uniform float u_k;',
    'uniform ivec2 u_size;',
    'out vec4 o;',
    'void main() {',
    `  ivec2 base = ivec2(gl_FragCoord.xy) * ${BLOCK};`,
    '  float s = 0.0;',
    `  for (int y = 0; y < ${BLOCK}; y++) {`,
    `    for (int x = 0; x < ${BLOCK}; x++) {`,
    '      ivec2 p = base + ivec2(x, y);',
    '      if (p.x >= u_size.x || p.y >= u_size.y) continue;',
    '      vec3 c = floor(texelFetch(u_frame, p, 0).rgb * 255.0 + 0.5);',
    '      if (u_hasTop == 1) {',
    '        vec4 t = texelFetch(u_top, ivec2(p.x, u_size.y - 1 - p.y), 0);',
    '        float a = (floor(t.a * 255.0 + 0.5) / 255.0) * u_k;',
    '        c = c * (1.0 - a) + floor(t.rgb * 255.0 + 0.5) * a;',
    '      }',
    '      s += 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;',
    '    }',
    '  }',
    '  o = vec4(s, 0.0, 0.0, 1.0);',
    '}',
  ].join('\n');

  window.createLumaMeter = function createLumaMeter(gl) {
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    const shader = (type, src) => {
      const made = gl.createShader(type);
      gl.shaderSource(made, src);
      gl.compileShader(made);
      if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made));
      return made;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const at = (name) => gl.getUniformLocation(program, name);
    const where = {
      frame: at('u_frame'), top: at('u_top'), hasTop: at('u_hasTop'), k: at('u_k'), size: at('u_size'),
    };
    const pos = gl.getAttribLocation(program, 'a_position');
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const frameTex = gl.createTexture();
    const frameFb = gl.createFramebuffer();
    const topTex = gl.createTexture();
    const sumTex = gl.createTexture();
    const sumFb = gl.createFramebuffer();
    let size = [0, 0];
    let cells = [0, 0];
    let out = null;
    const setup = (texture, filter) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    function resize(W, H) {
      if (size[0] === W && size[1] === H) return;
      size = [W, H];
      cells = [Math.ceil(W / BLOCK), Math.ceil(H / BLOCK)];
      setup(frameTex, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, frameFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frameTex, 0);
      setup(sumTex, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cells[0], cells[1], 0, gl.RGBA, gl.FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sumFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sumTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      out = new Float32Array(cells[0] * cells[1] * 4);
    }
    return {
      /** The mean luma (0..1) of the default framebuffer's W x H picture,
       *  with `top` (a canvas, or null) laid over it at opacity `k`. */
      measure(W, H, top = null, k = 1) {
        resize(W, H);
        // The picture as drawn (the canvas's own buffer) into a texture.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameFb);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sumFb);
        gl.viewport(0, 0, cells[0], cells[1]);
        gl.disable(gl.BLEND);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frameTex);
        gl.uniform1i(where.frame, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, topTex);
        if (top) {
          // Straight (not premultiplied) colour, as getImageData gives it.
          setup(topTex, gl.NEAREST);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, top);
        }
        gl.uniform1i(where.top, 1);
        gl.uniform1i(where.hasTop, top ? 1 : 0);
        gl.uniform1f(where.k, k);
        gl.uniform2i(where.size, W, H);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0, 0, cells[0], cells[1], gl.RGBA, gl.FLOAT, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        let s = 0;
        for (let i = 0; i < out.length; i += 4) s += out[i];
        return s / (W * H * 255);
      },
    };
  };
}());
