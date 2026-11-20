"""Draws the runs written by visualizer-fx-check.mjs through the app's own
fx-chain.js in Chromium and reports, per intensity, the mean luminance, the
largest frame-to-frame luminance step and the steps over 0.10 a second, with
the worst runs and the effects found in them.

    python tests/helpers/visualizer-fx-check.py runs.json [width height] [--gpu] [--readback] [--low] [--cores=2] [--progress=file]

--gpu draws on the graphics card (ANGLE on Direct3D 11) as the app does;
without it SwiftShader. Serves src/ and tests/helpers/ from a local port for
the page's modules. Needs Python Playwright with Chromium. Run by hand; not
part of npm test. Luminance is Rec. 709 luma of the 8-bit canvas, 0..1.

Overlay runs (visualizer-fx-check.mjs --overlays) are drawn the same way;
the top sheet is laid over the picture before the luminance is taken. Cost
runs (their own size) report the time per frame instead, with the overlays'
own drawing and the blended one's upload.

The mean luminance is added up on the graphics card (luma-meter.js) and only
a small float target read back; --readback reads every pixel back and adds
them up in the page instead (the old way, for comparing). --low, --cores and
--progress: check_limits.py; each row gives the processor time it took
(cpu_s)."""

import functools
import http.server
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

from check_limits import Limits, options

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = (b'<!doctype html><html><body>'
        b'<script type="module" src="/tests/helpers/visualizer-fx-check-page.js"></script>'
        b'</body></html>')


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/fx-check.html':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(PAGE)
            return
        if not (self.path.startswith('/src/') or self.path.startswith('/tests/helpers/')):
            self.send_error(404)
            return
        super().do_GET()

    def guess_type(self, path):
        return 'text/javascript' if str(path).endswith('.js') or str(path).endswith('.mjs') else super().guess_type(path)


def measure(lumas, fps):
    steps = [abs(b - a) for a, b in zip(lumas, lumas[1:])]
    seconds = len(lumas) / fps
    return {
        'mean': round(sum(lumas) / len(lumas), 4),
        'max_step': round(max(steps) if steps else 0, 4),
        'over_per_s': round(sum(1 for s in steps if s > 0.10) / seconds, 2),
    }


def main():
    limits, argv = options(sys.argv)
    gpu = '--gpu' in argv
    readback = '--readback' in argv
    argv = [arg for arg in argv if arg not in ('--gpu', '--readback')]
    path = argv[1] if len(argv) > 1 else 'visualizer-fx-frames.json'
    width = int(argv[2]) if len(argv) > 2 else 320
    height = int(argv[3]) if len(argv) > 3 else 180
    data = json.loads(pathlib.Path(path).read_text())
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    rows = []
    # What the runs draw at, first: a number is the app's only at the size
    # and quality the app draws. Runs with their own size or quality (overlay
    # cost runs) give theirs in their row; the rest are drawn at Medium.
    qualities = sorted({run.get('quality') or 'medium' for run in data['runs']})
    meter = Limits(limits, len(data['scenes']) + len(data['runs']))
    print(json.dumps({'size': [width, height], 'quality': qualities, 'gpu': gpu, 'readback': readback,
                      'note': 'scene values capped last at each run quality (scenes.js cappedValues), linked ones included'}), flush=True)
    with sync_playwright() as p:
        flags = (['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] if gpu
                 else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        browser = p.chromium.launch(args=flags)
        page = browser.new_page()
        page.goto(f'http://127.0.0.1:{port}/fx-check.html')
        page.wait_for_function('window.fxReady === true')
        if readback:
            page.evaluate('() => { window.lumaReadback = true; }')
        meter.apply_to_children()
        page.evaluate('(s) => window.setScenes(s)', data['scenes'])
        baseline = {}
        for index, scene in enumerate(data['scenes']):
            whole = {'scene': index, 'from': 0, 'fx': [], 'intensity': 'normal', 'flash': False}
            meter.begin(f"baseline {scene['id']}")
            result = page.evaluate('([r, c, W, H]) => window.runOne(r, c, W, H)',
                                   [whole, scene['frameCount'], width, height])
            baseline[index] = measure(result['lumas'], scene['fps'])
            baseline[index]['cpu_s'] = meter.end()
        for run in data['runs']:
            scene = data['scenes'][run['scene']]
            w, h = run.get('size') or (width, height)
            meter.begin(f"{run.get('group', '')} on {scene['id']}")
            result = page.evaluate('([r, c, W, H]) => window.runOne(r, c, W, H)', [run, run.get('clip') or data['clip'], w, h])
            row = measure(result['lumas'], scene['fps'])
            row['cpu_s'] = meter.end()
            if run.get('overlays') is not None:
                row.update({
                    'overlays': '+'.join(o['id'] + ('~' + o['blend']['mode'] + ('u' if o['blend']['under'] else '')
                                                    + ('/' + o['blend']['mask'] if o['blend']['mask'] != 'none' else '')
                                                    + ('/tint' if o['blend']['tint'] else '') + ('/bend' if o['blend']['bend'] else '')
                                                    if (o['blend']['mode'] != 'add' or o['blend']['under'] or o['blend']['mask'] != 'none'
                                                        or o['blend']['tint'] or o['blend']['bend']) else '')
                                         for o in run['overlays']) or '(none)',
                    'allowed': run.get('allowed', True), 'kind': run.get('kind', ''), 'size': [w, h],
                    'overlay_ms': round(result.get('overlayMs', 0), 3), 'sync_ms': round(result.get('syncMs', 0), 3), 'top_size': result.get('topSize'), 'upload_ms': round(result.get('uploadMs', 0), 3),
                    'uploads': result.get('uploads', 0), 'overlay_draws': result.get('overlayDraws', 0),
                    'hits': result.get('hits', 0), 'admitted': result.get('admitted', 0), 'refused': result.get('refused', 0),
                    'uncounted': result.get('uncounted', 0), 'blend_size': result.get('blendSize'),
                })
            row.update({
                'group': run.get('group') or (run['intensity'] + (' +flash' if run['flash'] else '')),
                'triggers': result.get('triggers', 0), 'triggers_refused': result.get('triggersRefused', 0),
                'most_per_s': result.get('mostPerSecond', 0),
                'intensity': run['intensity'], 'flash': run['flash'], 'scene': scene['id'],
                'fx': '+'.join(item['id'] for item in run['fx']) or '(none)',
                'ms': round(result['ms'], 2), 'failed': result['failed'],
                'quality': result.get('quality'), 'drawn_size': result.get('size'),
                'scene_max_step': baseline[run['scene']]['max_step'],
            })
            rows.append(row)
        browser.close()
    server.shutdown()
    report = {'size': [width, height], 'quality': qualities, 'gpu': gpu, 'readback': readback, 'baseline': {data['scenes'][i]['id']: v for i, v in baseline.items()},
              'summary': {}, 'worst': {}, 'rows': rows}
    for key in sorted({row['group'] for row in rows}):
        part = [row for row in rows if row['group'] == key]
        if part:
            report['summary'][key] = {
                'runs': len(part),
                'mean_luminance': round(sum(r['mean'] for r in part) / len(part), 4),
                'darkest_mean': min(r['mean'] for r in part),
                'brightest_mean': max(r['mean'] for r in part),
                'max_step': max(r['max_step'] for r in part),
                'runs_with_steps_over_10': sum(1 for r in part if r['over_per_s'] > 0),
                'steps_over_10_per_s_mean': round(sum(r['over_per_s'] for r in part) / len(part), 3),
                'ms_per_frame_mean': round(sum(r['ms'] for r in part) / len(part), 2),
                'failed_passes': sum(r['failed'] for r in part),
                'overlay_ms_mean': round(sum(r.get('overlay_ms', 0) for r in part) / len(part), 3),
                'upload_ms_mean': round(sum(r.get('upload_ms', 0) for r in part) / len(part), 3),
                'overlay_hits_admitted': sum(r.get('admitted', 0) for r in part),
                'overlay_hits_refused': sum(r.get('refused', 0) for r in part),
                'uncounted_steps': sum(r.get('uncounted', 0) for r in part),
                'runs_not_allowed': sum(1 for r in part if r.get('allowed') is False),
                'trigger_firings': sum(r['triggers'] for r in part),
                'trigger_firings_refused': sum(r['triggers_refused'] for r in part),
                'most_large_changes_per_s': max(r['most_per_s'] for r in part),
            }
            report['worst'][key] = sorted(part, key=lambda r: -r['max_step'])[:5]
    out = pathlib.Path(path).with_suffix('.report.json')
    out.write_text(json.dumps(report, indent=1))
    print(json.dumps({'baseline': report['baseline'], 'summary': report['summary']}, indent=1))
    for key, worst in report['worst'].items():
        for row in worst[:3]:
            print(key, json.dumps({k: row.get(k) for k in ('scene', 'fx', 'overlays', 'allowed', 'max_step', 'over_per_s', 'mean', 'scene_max_step', 'most_per_s', 'uncounted')}))
    print(f'report -> {out}')


if __name__ == '__main__':
    main()
