/**
 * A small stand-in for Psychedelia's Shadertoy runtime, enough for the
 * frame-feedback scenes the app offers (Feedback Loop, Reaction-Diffusion).
 * Each of them registers through ShadertoyEffectRunner.make({ project }):
 * a project from ShadertoyPassGraph.makeDefaultProject(image) with Buffer A
 * switched on (reading its own last frame) and the Image pass reading
 * Buffer A. Psychedelia's runtime (pass graph, channels, uniforms: about
 * 2,300 lines, with keyboard, audio, video and webcam channels and editor
 * diagnostics) is not ported; this adapter runs that shape only:
 *
 *   - Buffers A to D, each a ping-pong pair at the pass's resolution scale
 *     of the picture, in the project's target format (rgba8, rgba16f or
 *     rgba32f); channels that read a buffer (itself or another) with its
 *     sampler; any other channel reads black;
 *   - each pass built by Psychedelia's own ShadertoyCompiler (its uniform
 *     block, Common source, mainImage wrapper and view zoom), so the GLSL is
 *     compiled exactly as there;
 *   - the Shadertoy uniforms (iResolution, iTime, iTimeDelta, iFrameRate,
 *     iFrame, iMouse, iDate, iChannelResolution, iChannelTime), the view
 *     zoom and rotation, and every value of the scene as u_<name> (with
 *     seed, seed_vec and mouse_norm), as Psychedelia's runner gives them.
 *
 * Differences, on purpose: the buffers step at a fixed rate (the host's
 * Renderer.getStepRate(), steps a second; at most two a frame), not once per
 * drawn frame, so a scene moves the same at 30 or 60 frames a second and can
 * be slowed; iFrame counts this visit's steps from 0 (a fresh visit seeds
 * again); iMouse is never pressed (z = w = 0: no brush strokes); iDate is 0.
 * Everything is made on the context the scene is given (the host's
 * recording one), and freed by cleanup().
 */

/** The most buffer steps one frame may run. */
export const FEEDBACK_MAX_STEPS = 2;

const BUFFER_IDS = Object.freeze(['bufferA', 'bufferB', 'bufferC', 'bufferD']);

function makePass(id, source, enabled) {
  return {
    id,
    type: id === 'image' ? 'image' : 'buffer',
    enabled,
    resolutionScale: 1,
    source: source || '',
    channels: [0, 1, 2, 3].map((slot) => ({ slot, kind: 'none' })),
  };
}

/** Psychedelia's ShadertoyPassGraph.makeDefaultProject: the same shape. */
function makeDefaultProject(imageSource) {
  return {
    name: 'Untitled Shadertoy',
    settings: { renderTargetFormat: 'rgba8', safeMode: false },
    common: { source: '' },
    passes: [...BUFFER_IDS.map((id) => makePass(id, '', false)), makePass('image', imageSource, true)],
  };
}

function lines(parts) { return parts.join('\n'); }

function pass(project, id) {
  return project.passes.find((row) => row.id === id) || null;
}

/**
 * @param {object} G  ShadertoyCompiler (vendored), and the host's Renderer
 *   and Controls stand-ins (sim-host.js)
 * @returns {{ ShadertoyEffectRunner, ShadertoyPassGraph }}
 */
export function createShadertoyAdapter({ ShadertoyCompiler, Renderer, Controls }) {
  function formatOf(gl, name) {
    if (name === 'rgba32f') return { internal: gl.RGBA32F, type: gl.FLOAT };
    if (name === 'rgba16f') return { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    return { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
  }

  function createGraph(gl, project) {
    const graph = {
      programs: new Map(), // pass id -> { program, locations: Map }
      buffers: new Map(), // pass id -> { targets: [a, b], writeIndex, width, height }
      quad: null,
      black: null,
      width: 0,
      height: 0,
      frame: 0,
      ok: true,
    };
    const passes = project.passes.filter((row) => row.enabled && (row.id === 'image' || BUFFER_IDS.includes(row.id)));
    const format = formatOf(gl, project.settings?.renderTargetFormat);

    function texture(width, height, data = null, kind = format) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, kind.internal, width, height, 0, gl.RGBA, kind.type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    function target(width, height) {
      const tex = texture(width, height);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (complete) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      return { tex, fb, width, height, complete };
    }

    function dropTargets(buffers = graph.buffers) {
      for (const record of buffers.values()) {
        for (const t of record.targets) {
          if (gl.isFramebuffer(t.fb)) gl.deleteFramebuffer(t.fb);
          if (gl.isTexture(t.tex)) gl.deleteTexture(t.tex);
        }
      }
      buffers.clear();
    }

    /** The last picture each buffer wrote, stretched into its new size
     *  (linear filtering; nearest for 32-bit floats, which cannot be
     *  filtered): a resize or a change of quality keeps the picture going. */
    function carryOver(before) {
      const filter = format.internal === gl.RGBA32F ? gl.NEAREST : gl.LINEAR;
      for (const [id, record] of graph.buffers) {
        const old = before.get(id);
        if (!old) continue;
        const from = old.targets[1 - old.writeIndex];
        const to = record.targets[1 - record.writeIndex];
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fb);
        gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.COLOR_BUFFER_BIT, filter);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    /** Buffers at the picture's size: `fresh` makes them afresh (cleared,
     *  from iFrame 0); otherwise the live ones are carried into the new size
     *  and the steps go on. */
    graph.resize = (width, height, fresh = false) => {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      if (!fresh && graph.width === w && graph.height === h && graph.buffers.size) return false;
      graph.width = w;
      graph.height = h;
      const before = new Map(graph.buffers);
      graph.buffers.clear();
      if (fresh) dropTargets(before);
      for (const row of passes) {
        if (row.id === 'image') continue;
        const scale = Number(row.resolutionScale) > 0 ? Math.max(0.125, Math.min(1, Number(row.resolutionScale))) : 1;
        const bw = Math.max(1, Math.floor(w * scale));
        const bh = Math.max(1, Math.floor(h * scale));
        const targets = [target(bw, bh), target(bw, bh)];
        if (!targets.every((t) => t.complete)) graph.ok = false;
        graph.buffers.set(row.id, { targets, writeIndex: 0, width: bw, height: bh });
      }
      const carried = before.size > 0 && graph.ok !== false;
      if (carried) carryOver(before);
      dropTargets(before);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!carried) graph.frame = 0;
      return true;
    };

    graph.compile = () => {
      for (const row of passes) {
        const result = ShadertoyCompiler.createProgram(gl, {
          isWebGL2: true, commonSource: project.common?.source || '', passSource: row.source, passId: row.id, passName: row.id,
        });
        if (!result.success) {
          console.error(`visualizer: ${project.name} ${row.id} did not compile:`, result.shaderLog);
          graph.ok = false;
          return false;
        }
        graph.programs.set(row.id, { program: result.program, locations: new Map(), position: gl.getAttribLocation(result.program, 'a_position') });
      }
      graph.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, graph.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      graph.black = texture(1, 1, new Uint8Array([0, 0, 0, 255]), { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
      return true;
    };

    function location(entry, name) {
      if (!entry.locations.has(name)) entry.locations.set(name, gl.getUniformLocation(entry.program, name));
      return entry.locations.get(name);
    }

    function sampler(tex, channel) {
      const filter = channel.sampler?.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      const wrapName = channel.sampler?.wrap;
      const wrap = wrapName === 'repeat' ? gl.REPEAT : (wrapName === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return tex;
    }

    /** One pass into `dest` (a target; null: the picture). */
    function run(row, dest, uniforms, written) {
      const entry = graph.programs.get(row.id);
      if (!entry) return;
      const width = dest ? dest.width : graph.width;
      const height = dest ? dest.height : graph.height;
      if (dest) gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
      else Renderer.bindFramebuffer(-1);
      gl.viewport(0, 0, width, height);
      gl.useProgram(entry.program);
      const resolutions = [];
      for (let slot = 0; slot < 4; slot += 1) {
        const channel = row.channels[slot] || { kind: 'none' };
        gl.activeTexture(gl.TEXTURE0 + slot);
        let tex = graph.black;
        let res = [1, 1, 1];
        const source = channel.kind === 'self' ? row.id : (channel.kind === 'buffer' ? channel.sourceId : null);
        const record = source ? graph.buffers.get(source) : null;
        if (record) {
          // Itself: its last frame; another buffer: what it wrote last.
          const t = source === row.id ? record.targets[1 - record.writeIndex] : (written.get(source) || record.targets[1 - record.writeIndex]);
          if (!dest || t.tex !== dest.tex) { tex = t.tex; res = [t.width, t.height, 1]; }
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (tex !== graph.black) sampler(tex, channel);
        resolutions.push(...res);
        const at = location(entry, `iChannel${slot}`);
        if (at) gl.uniform1i(at, slot);
      }
      const f1 = (name, value) => { const at = location(entry, name); if (at) gl.uniform1f(at, value); };
      const res = location(entry, 'iResolution');
      if (res) gl.uniform3f(res, width, height, 1);
      f1('iTime', uniforms.time);
      f1('iTimeDelta', uniforms.delta);
      f1('iFrameRate', uniforms.rate);
      const frameAt = location(entry, 'iFrame');
      if (frameAt) gl.uniform1i(frameAt, graph.frame);
      const mouseAt = location(entry, 'iMouse');
      if (mouseAt) gl.uniform4f(mouseAt, uniforms.mouse[0] * width, uniforms.mouse[1] * height, 0, 0);
      const dateAt = location(entry, 'iDate');
      if (dateAt) gl.uniform4f(dateAt, 0, 0, 0, 0);
      f1('iSampleRate', 44100);
      f1('u_view_zoom', Renderer.getViewZoom());
      f1('u_view_zoom_speed', Renderer.getViewZoomSpeed());
      f1('u_view_zoom_depth', Renderer.getViewZoomDepth());
      f1('u_global_rotation', Renderer.getRotation());
      const chanRes = location(entry, 'iChannelResolution[0]');
      if (chanRes) gl.uniform3fv(chanRes, resolutions);
      const chanTime = location(entry, 'iChannelTime[0]');
      if (chanTime) gl.uniform1fv(chanTime, [uniforms.time, uniforms.time, uniforms.time, uniforms.time]);
      for (const [name, value] of Object.entries(uniforms.values)) {
        const at = location(entry, `u_${name}`);
        if (!at) continue;
        if (typeof value === 'number') gl.uniform1f(at, value);
        else if (Array.isArray(value) && value.length === 2) gl.uniform2fv(at, value);
        else if (Array.isArray(value) && value.length === 3) gl.uniform3fv(at, value);
        else if (Array.isArray(value) && value.length === 4) gl.uniform4fv(at, value);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, graph.quad);
      if (entry.position >= 0) {
        gl.enableVertexAttribArray(entry.position);
        gl.vertexAttribPointer(entry.position, 2, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** `steps` buffer steps, then the Image pass. */
    graph.render = (steps, uniforms) => {
      const written = new Map();
      for (let step = 0; step < steps; step += 1) {
        for (const row of passes) {
          if (row.id === 'image') continue;
          const record = graph.buffers.get(row.id);
          const dest = record.targets[record.writeIndex];
          run(row, dest, uniforms, written);
          written.set(row.id, dest);
          record.writeIndex = 1 - record.writeIndex;
        }
        graph.frame += 1;
      }
      const image = passes.find((row) => row.id === 'image');
      if (image) run(image, null, uniforms, written);
      for (let slot = 3; slot >= 0; slot -= 1) {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    };

    graph.dispose = () => {
      dropTargets();
      for (const entry of graph.programs.values()) if (gl.isProgram(entry.program)) gl.deleteProgram(entry.program);
      graph.programs.clear();
      if (graph.quad && gl.isBuffer(graph.quad)) gl.deleteBuffer(graph.quad);
      if (graph.black && gl.isTexture(graph.black)) gl.deleteTexture(graph.black);
      graph.quad = null;
      graph.black = null;
    };
    return graph;
  }

  function make(options) {
    let graph = null;
    let glRef = null;
    let lastKey = null;
    let acc = 0;

    const keyOf = () => (options.resetKey ? String(options.resetKey(Controls.getValues())) : '');

    function dispose() {
      if (graph) { try { graph.dispose(); } catch (_) {} }
      graph = null;
      lastKey = null;
      acc = 0;
    }

    function build(gl) {
      dispose();
      glRef = gl || glRef;
      if (!glRef) return;
      graph = createGraph(glRef, options.project());
      if (!graph.compile()) return;
      const canvas = Renderer.getCanvas();
      graph.resize(canvas.width, canvas.height);
      lastKey = keyOf();
    }

    function clearPicture(gl) {
      Renderer.bindFramebuffer(-1);
      const canvas = Renderer.getCanvas();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    return {
      init(gl) { build(gl); },
      // After a context loss (the host's lost stand-in): references only.
      cleanup(gl) {
        if (gl?.isContextLost?.() === true) graph = null;
        dispose();
      },
      reset() {
        if (!graph) return;
        const canvas = Renderer.getCanvas();
        graph.resize(canvas.width, canvas.height, true); // afresh (cleared), from iFrame 0
        acc = 0;
      },
      render(gl, unusedProgram, time = 0, dt = 0) {
        if (!graph) build(gl);
        if (!graph || !graph.ok) { clearPicture(gl); return; }
        const canvas = Renderer.getCanvas();
        // A new size of picture (or a reset key) starts the buffers again.
        if (graph.resize(canvas.width, canvas.height)) acc = 0;
        const key = keyOf();
        if (key !== lastKey) { graph.resize(canvas.width, canvas.height, true); lastKey = key; acc = 0; }
        const rate = Math.max(1, Number(Renderer.getStepRate?.()) || 60);
        // The first frame of a visit seeds: one pass at iFrame 0, which
        // writes the scene's starting state (no time passes in it when the
        // picture is still: iTimeDelta 0). Then steps follow the time given,
        // at most FEEDBACK_MAX_STEPS a frame, the rest dropped.
        let steps = 0;
        if (graph.frame === 0) steps = 1;
        else if (dt > 0) {
          acc += dt * rate;
          steps = Math.min(FEEDBACK_MAX_STEPS, Math.floor(acc));
          acc = Math.min(acc - steps, 1);
        }
        const values = { ...Controls.getValues() };
        values.seed = Renderer.getSeed();
        values.seed_vec = Renderer.getSeedVec();
        const mouse = Renderer.getMouse();
        values.mouse_norm = [mouse.x || 0.5, mouse.y || 0.5];
        graph.render(steps, {
          time, delta: dt > 0 ? 1 / rate : 0, rate, values, mouse: [mouse.x || 0.5, mouse.y || 0.5],
        });
      },
      getStatus: () => ({ success: Boolean(graph?.ok) }),
      getDiagnostics: () => (graph ? { width: graph.width, height: graph.height, frame: graph.frame } : null),
      getGraph: () => graph,
    };
  }

  return {
    ShadertoyEffectRunner: Object.freeze({ make, lines, pass }),
    ShadertoyPassGraph: Object.freeze({ makeDefaultProject }),
  };
}
