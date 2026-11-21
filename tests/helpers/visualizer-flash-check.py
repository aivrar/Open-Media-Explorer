"""Renders the frames written by visualizer-flash-check.mjs in headless
Chromium (software WebGL, SwiftShader) and reports, per scene, the mean
luminance, the largest frame-to-frame luminance step, the number of steps
over 0.10 a second, and the time a frame took (a rough cost measure).

    python tests/helpers/visualizer-flash-check.py frames.json [width height] [--gpu] [--readback] [--low] [--cores=2] [--progress=file]

--gpu renders on the graphics card (ANGLE on Direct3D 11) instead of
SwiftShader: the only way to check every scene at the real window's size
(about 1504 x 797 at Medium) in reasonable time. ms_per_frame then includes
reading the pixels back, so it is not a cost measure.

The mean luminance is added up on the graphics card (luma-meter.js) and only
a small float target read back; --readback reads every pixel back and adds
them up in the page (the old way, for comparing). --low, --cores and
--progress: check_limits.py; each row gives its processor time (cpu_s).

A long recording (--seconds over 12 in the .mjs half) is also reported per
10-s window: its largest step, steps over 0.10, the dominant frequency of
the mean luminance (after its slow drift is taken out) and the peak to peak
of everything from 3 Hz up to half the frame rate; a window whose dominant
frequency is 3 Hz or more and whose 3 Hz+ peak to peak passes 0.10 is
flagged as an oscillation (the tester's Mandelbrot: 3.5 Hz, 0.12).

Needs Python Playwright with Chromium (and numpy). Run by hand; not part of
npm test.
Luminance is Rec. 709 luma of the 8-bit canvas, 0..1. Uniforms are set as
the app's renderer sets them (scene-renderer.js draw): the quality caps are
already applied last by the .mjs half (base and linked values). The first
line printed, and the report's first row, give the size, quality and
renderer the run drew at."""

import json
import pathlib
import sys
import tempfile

import numpy as np

from playwright.sync_api import sync_playwright

from check_limits import Limits, options

PAGE = r"""<!doctype html><html><body><canvas id="c"></canvas><script>%LUMA_METER%</script><script>
window.run = (scene, W, H) => {
  const c = document.getElementById('c'); c.width = W; c.height = H;
  const gl = c.getContext('webgl2', { preserveDrawingBuffer: false, antialias: false });
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, scene.vert)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, scene.frag));
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  const L = (n) => gl.getUniformLocation(p, n);
  const f1 = (n, v) => { const l = L(n); if (l) gl.uniform1f(l, v); };
  const setValue = (k, v) => { const l = L('u_' + k); if (!l) return; if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v.length === 2) gl.uniform2fv(l, v); else if (v.length === 3) gl.uniform3fv(l, v); else if (v.length === 4) gl.uniform4fv(l, v); };
  const pos = gl.getAttribLocation(p, 'a_position'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  if (L('u_resolution')) gl.uniform2f(L('u_resolution'), W, H);
  if (L('u_mouse')) gl.uniform2f(L('u_mouse'), 0.5, 0.5);
  f1('u_global_rotation', 0); f1('u_view_zoom_speed', 0.7); f1('u_view_zoom_depth', 0);
  f1('u_seed', scene.seed ?? 300.123);
  if (L('u_seed_vec')) gl.uniform4f(L('u_seed_vec'), ...(scene.seedVec || [0.3, 0.6, 0.2, 0.8]));
  for (const [k, v] of Object.entries(scene.values)) setValue(k, v);
  // What the scene's own setUniforms hook sets (the .mjs half: hookUniforms).
  for (const [k, v] of Object.entries(scene.uniforms || {})) {
    const l = L(k) || L(k + '[0]'); if (!l) continue;
    if (typeof v === 'number') gl.uniform1f(l, v); else gl.uniform3fv(l, new Float32Array(v));
  }
  // The mean luminance added up on the graphics card (luma-meter.js), or
  // every pixel read back and added up here (window.lumaReadback).
  if (c.meter === undefined) c.meter = window.lumaReadback ? null : window.createLumaMeter(gl);
  const meter = c.meter;
  const px = meter ? null : new Uint8Array(W * H * 4);
  const lumas = [];
  const t0 = performance.now();
  for (const f of scene.frames) {
    f1('u_time', f.t); f1('u_unwrapped_time', f.t); f1('u_view_zoom', f.zoom);
    if (L('u_audio')) gl.uniform4f(L('u_audio'), ...f.audio);
    if (L('u_beat')) gl.uniform4f(L('u_beat'), ...f.beat);
    for (const [k, v] of Object.entries(f.linked)) setValue(k, v);
    // What the scene's hook set this frame (the .mjs half: hookFrames).
    if (f.hook) for (const [k, v] of Object.entries(f.hook)) f1(k, v);
    gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (meter) {
      lumas.push(meter.measure(W, H));
      // The meter used its own program and quad: the scene's back.
      gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      continue;
    }
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    lumas.push(s / (W * H * 255));
  }
  const ms = (performance.now() - t0) / scene.frames.length;
  return { lumas, ms };
};
</script><script type="module">
// A scene that owns its passes (sim-host.js) is drawn by the app's own
// scene renderer and host, loaded from the repository: a fresh canvas and
// context (a cold start, its seeding frames included), the scene's links,
// drift plan and quality caps as the tab gives them, the frames' clock and
// sources one by one, each frame measured as drawn.
window.runSim = async (scene, W, H, timing) => {
  const [R, S, D, SH, P, LH] = await Promise.all([
    import('/src/visualizer/scene-renderer.js'), import('/src/visualizer/scenes.js'),
    import('/src/visualizer/drift.js'), import('/src/visualizer/shuffle.js'),
    import('/src/lib/processor-budget.js'), import('/src/visualizer/line-host.js'),
  ]);
  // The Processor use extras as the tab gives them (processor-budget.js):
  // extras.simUp draws the simulations one size up, as at the High level.
  const extras = scene.extras || {};
  const upLevel = extras.simUp ? 'high' : 'light';
  const capsFor = (sceneId, quality) => P.simCapsWithExtras(sceneId, quality, S.sceneCaps(sceneId, quality), upLevel, true);
  const id = scene.id.split('#')[0];
  const entry = S.sceneById(id)
    || [...S.LINE_SCENE_ENTRIES, ...S.OWN_SCENE_ENTRIES, ...S.ACCUMULATING_SCENE_ENTRIES].find((held) => held.id === id);
  const DH = await import('/src/visualizer/density-host.js');
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.append(c);
  const made = R.createWebglContext(c);
  if (!made) throw new Error('no context');
  const gl = made.gl;
  const renderer = R.createSceneRenderer({
    canvas: c, gl, mode: made.mode, random: SH.seededRandom(scene.seedNumber ?? 7),
    capsFor, rateFor: S.sceneSimRate,
    driftFor: (def) => (scene.driftOn
      ? D.sceneDriftPlan(def, { override: entry.drift, capped: S.sceneCappedParams(id) }) : []),
  });
  if (scene.quality && scene.quality !== 'None') renderer.setQuality(scene.quality);
  const def = renderer.register(await entry.load(), id);
  // One size up: the larger size set as it starts (unless its look sets it).
  const startValues = P.simStartWithExtras(id, scene.quality, scene.overrides || entry.defaults || null,
    (def.params || []).map((param) => param.name), upLevel, true);
  // scene.fadeFrom (a mean brightness): the change into this scene through
  // the tab's cross-fade, simulated. The outgoing picture is a still of that
  // mean; the app's transition.js runs on this page's clock (stretched into
  // a density lab as the tab asks it, index.js densityFadeFor), and each
  // frame measured is the snapshot's opacity a times that mean plus (1 - a)
  // times the scene's own (means add as the pictures do).
  let fadeSim = null;
  if (Number.isFinite(scene.fadeFrom)) {
    const [T, A] = await Promise.all([import('/src/visualizer/transition.js'), import('/src/visualizer/accumulating-scenes.js')]);
    const animations = [];
    const fadeEl = {
      hidden: true, width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, globalAlpha: 1, fillStyle: '' }),
      animate: (frames, options) => {
        const animation = { frames, options, at: performance.now(), cancel() {} };
        animations.push(animation);
        return animation;
      },
    };
    const transition = T.createTransition({
      canvas: { width: W, height: H, style: {} }, fade: fadeEl,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), clock: () => performance.now(),
      brightness: () => 1, enabled: () => true, drawOld: () => true, charge: () => true,
    });
    const after = DH.densityPictureCount();
    const stretched = A.DENSITY_LAB_IDS.includes(id);
    transition.begin(stretched ? { ready: () => DH.densityShownMean(after) >= A.DENSITY_READY_MEAN } : {});
    fadeSim = {
      transition, stretched,
      opacity() {
        const last = animations.at(-1);
        if (!last || fadeEl.hidden) return 0;
        const t = Math.min(1, (performance.now() - last.at) / last.options.duration);
        return last.frames[0].opacity + (last.frames[1].opacity - last.frames[0].opacity) * t;
      },
    };
  }
  renderer.useSceneNow(def, scene.links, startValues);
  // A lost context, as the tab handles one (index.js): the renderer told,
  // then made again on its return.
  const lose = gl.getExtension('WEBGL_lose_context');
  let lost = false;
  c.addEventListener('webglcontextlost', (event) => { event.preventDefault(); lost = true; renderer.contextLost(); });
  c.addEventListener('webglcontextrestored', () => {
    lost = false;
    renderer.restore();
    // The tab compiles the scene again (switcher.resume).
    renderer.useSceneNow(def, scene.links, startValues);
  });
  // The density host's counts at moments that matter: the frame its first
  // picture finished, and its workers left running.
  const density = () => DH.densityStatsNow();
  let finishedAt = null;
  const alive = () => (density() ? density().workers - density().ended : null);
  const aliveAt = {};
  const meter = timing ? null : window.createLumaMeter(gl);
  const lumas = [];
  const times = [];
  const one = new Uint8Array(4);
  const t0 = performance.now();
  // 'realtime': each frame at its own time (one every 1000 / fps ms), as
  // the tab's loop paces them, so the processor time is that of the tab
  // drawing the scene for that long.
  // scene.paced: measured frame by frame, but drawn at the tab's pace (a
  // scene whose work runs on a clock of its own, as the density labs').
  const paced = timing === 'realtime' || timing === 'raf' || (scene.paced === true && !timing);
  // 'raf': as the tab's loop draws (loop.js): on animation frames, a frame
  // drawn when 1000 / fps ms have passed less half a 60 Hz frame; the gaps
  // between frames drawn (starts) show an uneven or late frame.
  const raf = timing === 'raf';
  const starts = [];
  let lastDraw = -Infinity;
  // A change while it runs, as the tab makes one: { at: frame, quality,
  // size: [w, h] } (a window resize, or a quality step with its size).
  const changes = new Map((scene.changes || []).map((change) => [change.at, change]));
  let index = 0;
  for (const f of scene.frames) {
    const change = changes.get(index);
    if (change) {
      if (change.size) { c.width = change.size[0]; c.height = change.size[1]; }
      if (change.quality) renderer.setQuality(change.quality);
      // A change of look (its values), a new visit of the scene, a lost
      // context and its return.
      if (change.values) renderer.setValues(change.values);
      if (change.restart) renderer.useSceneNow(def, scene.links, startValues);
      if (change.lose && lose) { aliveAt.beforeLoss = alive(); lose.loseContext(); await new Promise((r) => setTimeout(r, 50)); aliveAt.lost = alive(); }
      if (change.restore && lose) { lose.restoreContext(); await new Promise((r) => setTimeout(r, 100)); aliveAt.restored = alive(); }
    }
    if (finishedAt === null && density()?.finished > 0) finishedAt = index;
    if (raf) {
      for (;;) {
        const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        if (now - lastDraw >= 1000 / scene.fps - 500 / 60) { lastDraw = now; break; }
      }
    } else if (paced) {
      const due = t0 + (index * 1000) / scene.fps;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    index += 1;
    const started = performance.now();
    starts.push(started);
    renderer.draw({
      time: f.t, dt: 1 / scene.fps, still: false, zoom: f.zoom, sources: f.sources,
      drift: f.bars !== undefined && f.bars !== null ? { bars: f.bars, scale: scene.driftScale } : null,
    });
    gl.bindVertexArray(null);
    if (meter) {
      const own = meter.measure(c.width, c.height);
      const a = fadeSim ? fadeSim.opacity() : 0;
      lumas.push(fadeSim ? a * scene.fadeFrom + (1 - a) * own : own);
    }
    else if (paced) times.push(performance.now() - started);
    else {
      // Waits for the frame to be drawn: its time on the graphics card
      // (with one tiny read back).
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      times.push(performance.now() - started);
    }
  }
  const ms = (performance.now() - t0) / scene.frames.length;
  const stats = {
    ...renderer.sim.stats, ...(LH.lineStatsNow() ? { lines: { ...LH.lineStatsNow() } } : {}),
    ...(density() ? { density: { ...density(), finishedAt, aliveAt, aliveAtEnd: alive(), lost } } : {}),
  };
  // What was in effect, read back after the run (not what was asked for):
  // the canvas size, the quality the renderer drew, the scene's values as
  // drawn (a scene that owns its passes: capped, as its Controls give them),
  // and the line segment limit.
  // (An accumulating lab gets its values through heldControls: as it gets them.)
  const AC = await import('/src/visualizer/accumulating-scenes.js');
  const rawValues = renderer.sim.active ? renderer.sim.globals.Controls.getValues() : (renderer.values || {});
  const drawn = AC.ACCUMULATING_HELD[id] ? { ...AC.heldControls({ getValues: () => rawValues }, AC.ACCUMULATING_HELD[id]).getValues() } : rawValues;
  stats.effective = {
    size: [c.width, c.height], quality: scene.quality || null, caps: renderer.caps ? { ...renderer.caps } : null,
    values: Object.fromEntries(Object.entries(drawn).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, +Number(v).toFixed(4)])),
    lineSegmentsMost: LH.LINE_MAX_SEGMENTS,
    ...(fadeSim ? {
      fade: {
        from: scene.fadeFrom, stretched: fadeSim.stretched, readyAfterMs: [...fadeSim.transition.stats.readyAfter],
        stretchedCount: fadeSim.transition.stats.stretched,
      },
    } : {}),
  };
  fadeSim?.transition.finishNow();
  renderer.destroy();
  // Closing: no worker left (the tab's destroy is the renderer's).
  if (stats.density) stats.density.aliveAfterClose = alive();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  c.remove();
  return { lumas, ms, times, stats, starts };
};
window.simReady = true;
</script></body></html>"""


REPO = pathlib.Path(__file__).resolve().parents[2]

WINDOW_S = 10
OSC_LOW_HZ = 3.0
OSC_PEAK_TO_PEAK = 0.10


def mean_of(values):
    """The mean of `values` (0 when there are none)."""
    return sum(values) / len(values) if values else 0


def longest_under(lumas, level):
    """The most frames in a row under `level`."""
    most = run = 0
    for value in lumas:
        run = run + 1 if value < level else 0
        most = max(most, run)
    return most


def windows(lumas, fps):
    """Per 10-s window: largest step, steps over 0.10, the dominant frequency
    of the mean luminance (its drift slower than 0.5 Hz taken out) and the
    peak to peak of its part from 3 Hz up; flagged as an oscillation when
    that dominant frequency is 3 Hz or more and the peak to peak over 0.10."""
    size = int(round(WINDOW_S * fps))
    out = []
    for start in range(0, len(lumas) - size + 1, size):
        part = np.asarray(lumas[start:start + size], dtype=float)
        steps = np.abs(np.diff(part))
        spectrum = np.fft.rfft((part - part.mean()) * np.hanning(len(part)))
        freqs = np.fft.rfftfreq(len(part), 1.0 / fps)
        power = np.abs(spectrum)
        power[freqs < 0.5] = 0
        dominant = float(freqs[int(np.argmax(power))]) if power.any() else 0.0
        # Mirrored, so the window's two ends meet: a slow drift from one end
        # to the other is not read as a jump (it put 0.4 of "fast" peak to
        # peak into scenes with no step over 0.02).
        mirrored = np.concatenate([part, part[::-1]]) - part.mean()
        full = np.fft.rfft(mirrored)
        full[np.fft.rfftfreq(len(mirrored), 1.0 / fps) < OSC_LOW_HZ] = 0
        fast = np.fft.irfft(full, len(mirrored))[:len(part)]
        p2p = float(fast.max() - fast.min())
        out.append({
            'from_s': round(start / fps, 1),
            'mean': round(float(part.mean()), 4),
            'max_step': round(float(steps.max()) if len(steps) else 0, 4),
            'steps_over_10': int((steps > 0.10).sum()),
            'dominant_hz': round(dominant, 2),
            'fast_p2p': round(p2p, 4),
            'oscillation': bool(dominant >= OSC_LOW_HZ and p2p > OSC_PEAK_TO_PEAK),
        })
    return out


def paced_late(starts, fps):
    """Frames drawn at their own time (paced): how late each frame's start
    was against the first frame's plus one frame time a frame, in ms: the
    most, at the end, and the share of frames more than one frame late."""
    if len(starts) < 2:
        return None
    frame = 1000 / fps
    late = [s - starts[0] - i * frame for i, s in enumerate(starts)]
    return {'most': round(max(late), 1), 'end': round(late[-1], 1),
            'over_one_frame': round(sum(1 for v in late if v > frame) / len(late), 4)}


def evenness(result):
    """Paced on animation frames: frames drawn a second, the share of gaps
    between frames over 50 ms and the longest, and the mean time to submit
    odd and even frames (an alternating cost shows as two different means)."""
    starts = result.get('starts') or []
    times = result.get('times') or []
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    if not gaps:
        return {}
    odd, even = times[0::2], times[1::2]
    return {
        'fps_drawn': round(1000 * len(gaps) / (starts[-1] - starts[0]), 1),
        'gaps_over_50ms': round(sum(1 for g in gaps if g > 50) / len(gaps), 4),
        'longest_gap_ms': round(max(gaps), 1),
        'submit_ms_odd_even': [round(sum(odd) / max(1, len(odd)), 2), round(sum(even) / max(1, len(even)), 2)],
    }


def main():
    limits, argv = options(sys.argv)
    gpu = '--gpu' in argv
    readback = '--readback' in argv
    argv = [arg for arg in argv if arg not in ('--gpu', '--readback', '--timing', '--realtime', '--raf')]
    frames_path = argv[1] if len(argv) > 1 else 'visualizer-flash-frames.json'
    width = int(argv[2]) if len(argv) > 2 else 320
    height = int(argv[3]) if len(argv) > 3 else 180
    scenes = json.loads(pathlib.Path(frames_path).read_text())
    # Looks share their scene's frames (framesOf).
    frames_of = {scene['id']: scene['frames'] for scene in scenes if 'frames' in scene}
    for scene in scenes:
        if 'frames' not in scene:
            scene['frames'] = frames_of[scene['framesOf']]
    page_file = pathlib.Path(tempfile.mkdtemp()) / 'flash-check.html'
    meter_js = (pathlib.Path(__file__).resolve().parent / 'luma-meter.js').read_text()
    page_file.write_text(PAGE.replace('%LUMA_METER%', meter_js))
    # What this run drew at, first in the output and the report: a number is
    # the app's only at the size and quality the app draws (the .mjs half's
    # --quality caps the values, linked ones included, as the renderer does).
    qualities = sorted({str(scene.get('quality')) for scene in scenes})
    header = {
        'id': '(run)', 'size': [width, height], 'quality': qualities[0] if len(qualities) == 1 else qualities,
        'renderer': 'graphics card (ANGLE D3D11)' if gpu else 'SwiftShader',
        'luminance': 'read back and added up in the page' if readback else 'added up on the graphics card',
    }
    if qualities == ['None']:
        header['note'] = 'no quality caps (recorded without --quality): not what the app draws'
    print(json.dumps(header), flush=True)
    rows = [header]
    timing = 'raf' if '--raf' in sys.argv else ('realtime' if '--realtime' in sys.argv else ('--timing' in sys.argv))
    with sync_playwright() as p:
        flags = (['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] if gpu
                 else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        browser = p.chromium.launch(args=flags)
        page = browser.new_page()
        # Served from the repository (the simulations load the app's own
        # modules): the page itself at /, everything else from the repo.
        page_html = page_file.read_text()

        def serve(route):
            path = route.request.url.split('check.test', 1)[1].split('?')[0]
            if path in ('/', '/index.html'):
                route.fulfill(body=page_html, content_type='text/html')
                return
            local = REPO / path.lstrip('/')
            if not local.is_file() or REPO not in local.resolve().parents:
                route.fulfill(status=404, body='')
                return
            route.fulfill(body=local.read_bytes(), content_type='text/javascript')

        page.route('http://check.test/**', serve)
        page.goto('http://check.test/')
        page.wait_for_function('window.simReady === true')
        if readback:
            page.evaluate('() => { window.lumaReadback = true; }')
        meter = Limits(limits, len(scenes))
        for scene in scenes:
            meter.begin(scene['id'])
            try:
                if scene.get('sim'):
                    result = page.evaluate('([s, W, H, t]) => window.runSim(s, W, H, t)', [scene, width, height, timing])
                else:
                    result = page.evaluate('([s, W, H]) => window.run(s, W, H)', [scene, width, height])
            except Exception as error:  # a shader that does not compile here
                meter.end()
                rows.append({'id': scene['id'], 'error': ' '.join(str(error).split())[:400]})
                print(json.dumps(rows[-1]), flush=True)
                continue
            cpu_s = meter.end()
            if timing:
                # Per frame on the graphics card (drawn, then waited for).
                times = sorted(result.get('times') or [0])
                rows.append({
                    'id': scene['id'], 'quality': scene.get('quality'), 'size': [width, height],
                    'gpu_ms_median': round(times[len(times) // 2], 2),
                    'gpu_ms_p95': round(times[min(len(times) - 1, int(len(times) * 0.95))], 2),
                    'gpu_ms_first': round((result.get('times') or [0])[0], 2),
                    'cpu_s': cpu_s, 'frames': len(times), 'host': result.get('stats'),
                    **({'seconds': round(len(times) / scene['fps'], 1),
                        'cpu_percent_of_one_core': round(100 * cpu_s / (len(times) / scene['fps']), 1) if cpu_s else None}
                       if timing in ('realtime', 'raf') else {}),
                    **(evenness(result) if timing == 'raf' else {}),
                })
                print(json.dumps(rows[-1]), flush=True)
                continue
            lumas = result['lumas']
            steps = [abs(b - a) for a, b in zip(lumas, lumas[1:])]
            seconds = len(lumas) / scene['fps']
            long = seconds > 12
            per_window = windows(lumas, scene['fps']) if long else []
            rows.append({
                'id': scene['id'],
                'cost': scene.get('cost'),
                'mean': round(sum(lumas) / len(lumas), 4),
                'max_step': round(max(steps) if steps else 0, 4),
                'steps_over_10_per_s': round(sum(1 for s in steps if s > 0.10) / seconds, 2),
                'ms_per_frame': round(result['ms'], 2),
                'cpu_s': cpu_s,
                'links': ', '.join(f"{l['param']}<-{l['source']}" for l in scene['links']),
                'host': result.get('stats'),
                # The first 3 s from a cold start, and the 3 s after each change.
                'start_max_step_3s': round(max(steps[:int(3 * scene['fps'])] or [0]), 4),
                **({'change_steps_3s': [round(max(steps[max(0, ch['at'] - 1):ch['at'] + int(3 * scene['fps'])] or [0]), 4)
                                        for ch in scene['changes']]} if scene.get('changes') else {}),
                # Around each change made while it ran (scene.changes): the
                # largest step from two frames before to three after.
                **({'change_steps': [round(max(steps[max(0, ch['at'] - 2):ch['at'] + 3] or [0]), 4) for ch in scene['changes']],
                    # The mean over the 2 s before each change and over the
                    # 6 s after it (a picture kept, or built again).
                    'change_means': [[round(mean_of(lumas[max(0, ch['at'] - int(2 * scene['fps'])):ch['at']]), 4),
                                      round(mean_of(lumas[ch['at']:ch['at'] + int(6 * scene['fps'])]), 4)] for ch in scene['changes']]}
                   if scene.get('changes') else {}),
                # From a cold start: the seconds until the picture first
                # reaches 0.05.
                'start_under_005': round(next((i for i, v in enumerate(lumas) if v >= 0.05), len(lumas)) / scene['fps'], 2),
                # A paced run (scene.paced): how far behind its due time a
                # frame was drawn, so the frame clock (1 / fps a frame) kept
                # to real time; a late frame gives a scene with a clock of
                # its own more time than the frame clock says.
                **({'paced_late_ms': paced_late(result.get('starts') or [], scene['fps'])} if scene.get('paced') is True else {}),
                **({
                    'seconds': round(seconds, 1),
                    'windows_over_10': sum(1 for w in per_window if w['steps_over_10']),
                    'oscillations': sum(1 for w in per_window if w['oscillation']),
                    'most_fast_p2p': max((w['fast_p2p'] for w in per_window), default=0),
                    # A picture near black for long reads as broken: the
                    # darkest 10-s window, the seconds spent under 0.05 in
                    # all, and the longest spell under 0.05 (seconds).
                    'darkest_window': min((w['mean'] for w in per_window), default=None),
                    'seconds_under_005': round(sum(1 for v in lumas if v < 0.05) / scene['fps'], 1),
                    'longest_under_005': round(longest_under(lumas, 0.05) / scene['fps'], 1),
                    'windows': per_window,
                } if long else {}),
            })
            print(json.dumps({k: v for k, v in rows[-1].items() if k != 'windows'}), flush=True)
        browser.close()
    out = pathlib.Path(frames_path).with_suffix('.report.json')
    out.write_text(json.dumps(rows, indent=1))
    print(f'report -> {out}')


if __name__ == '__main__':
    main()
