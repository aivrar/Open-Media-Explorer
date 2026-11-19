"""Renders the frames written by visualizer-flash-check.mjs in headless
Chromium (software WebGL, SwiftShader) and reports, per scene, the mean
luminance, the largest frame-to-frame luminance step, the number of steps
over 0.10 a second, and the time a frame took (a rough cost measure).

    python tests/helpers/visualizer-flash-check.py frames.json [width height] [--gpu]

--gpu renders on the graphics card (ANGLE on Direct3D 11) instead of
SwiftShader: the only way to check every scene at the real window's size
(about 1504 x 797 at Medium) in reasonable time. ms_per_frame then includes
reading the pixels back, so it is not a cost measure.

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

PAGE = r"""<!doctype html><html><body><canvas id="c"></canvas><script>
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
  const px = new Uint8Array(W * H * 4);
  const lumas = [];
  const t0 = performance.now();
  for (const f of scene.frames) {
    f1('u_time', f.t); f1('u_unwrapped_time', f.t); f1('u_view_zoom', f.zoom);
    if (L('u_audio')) gl.uniform4f(L('u_audio'), ...f.audio);
    if (L('u_beat')) gl.uniform4f(L('u_beat'), ...f.beat);
    for (const [k, v] of Object.entries(f.linked)) setValue(k, v);
    gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    lumas.push(s / (W * H * 255));
  }
  const ms = (performance.now() - t0) / scene.frames.length;
  return { lumas, ms };
};
</script></body></html>"""


WINDOW_S = 10
OSC_LOW_HZ = 3.0
OSC_PEAK_TO_PEAK = 0.10


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
            'max_step': round(float(steps.max()) if len(steps) else 0, 4),
            'steps_over_10': int((steps > 0.10).sum()),
            'dominant_hz': round(dominant, 2),
            'fast_p2p': round(p2p, 4),
            'oscillation': bool(dominant >= OSC_LOW_HZ and p2p > OSC_PEAK_TO_PEAK),
        })
    return out


def main():
    gpu = '--gpu' in sys.argv
    argv = [arg for arg in sys.argv if arg != '--gpu']
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
    page_file.write_text(PAGE)
    # What this run drew at, first in the output and the report: a number is
    # the app's only at the size and quality the app draws (the .mjs half's
    # --quality caps the values, linked ones included, as the renderer does).
    qualities = sorted({str(scene.get('quality')) for scene in scenes})
    header = {
        'id': '(run)', 'size': [width, height], 'quality': qualities[0] if len(qualities) == 1 else qualities,
        'renderer': 'graphics card (ANGLE D3D11)' if gpu else 'SwiftShader',
    }
    if qualities == ['None']:
        header['note'] = 'no quality caps (recorded without --quality): not what the app draws'
    print(json.dumps(header), flush=True)
    rows = [header]
    with sync_playwright() as p:
        flags = (['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] if gpu
                 else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        browser = p.chromium.launch(args=flags)
        page = browser.new_page()
        page.goto(page_file.resolve().as_uri())
        for scene in scenes:
            try:
                result = page.evaluate('([s, W, H]) => window.run(s, W, H)', [scene, width, height])
            except Exception as error:  # a shader that does not compile here
                rows.append({'id': scene['id'], 'error': str(error).splitlines()[0][:120]})
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
                'links': ', '.join(f"{l['param']}<-{l['source']}" for l in scene['links']),
                **({
                    'seconds': round(seconds, 1),
                    'windows_over_10': sum(1 for w in per_window if w['steps_over_10']),
                    'oscillations': sum(1 for w in per_window if w['oscillation']),
                    'most_fast_p2p': max((w['fast_p2p'] for w in per_window), default=0),
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
