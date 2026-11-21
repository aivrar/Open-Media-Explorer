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
(cpu_s).

Each run is compared with the scene alone (no effects, no overlays) drawn at
the run's own quality, picture size and clip (scene_alone, scene_max_step,
scene_mean); each row names the effects asked for (fx) and those the chain
really drew (fx_drawn, read back from the page). An effect id the catalog
does not have stops the run.

--rows=F appends each run's row to F (one JSON line) as soon as it is done,
so a long run stopped part way keeps what it measured. A run of 10 s or more
is also reported per 10-s window as the flash check does (its oscillation
test: a dominant frequency of 3 Hz or more with a 3 Hz+ peak to peak over
0.10). A cost run gives its processor time as a share of one core at the
tab's 30 frames a second (cpu_s over the clip's length)."""

import functools
import http.server
import importlib.util
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

from check_limits import Limits, options

_flash = importlib.util.spec_from_file_location('visualizer_flash_check', pathlib.Path(__file__).with_name('visualizer-flash-check.py'))
_flash_module = importlib.util.module_from_spec(_flash)
_flash.loader.exec_module(_flash_module)
windows = _flash_module.windows

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
    rows_file = next((arg.split('=', 1)[1] for arg in argv if arg.startswith('--rows=')), None)
    argv = [arg for arg in argv if arg not in ('--gpu', '--readback') and not arg.startswith('--rows=')]
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
        # The scene alone (no effects, no overlays) as each run draws it: the
        # same scene, quality, picture size and clip (where it starts and how
        # long), measured once per such set the runs use, so "above the
        # scene's own" compares like with like.
        baseline = {}

        def scene_alone(run, clip, w, h):
            key = '%s|%s|%dx%d|%s+%s%s' % (data['scenes'][run['scene']]['id'], run.get('quality') or 'medium', w, h, run.get('from', 0), clip,
                                            '|drift' if run.get('drift') else '')
            if key not in baseline:
                # (A run with the scene's slow drift: the scene alone drifts too.)
                alone = {'scene': run['scene'], 'from': run.get('from', 0), 'fx': [], 'intensity': run['intensity'], 'flash': False,
                         'drift': bool(run.get('drift')), **({'quality': run['quality']} if run.get('quality') else {})}
                meter.begin('scene alone ' + key)
                found = page.evaluate('([r, c, W, H]) => window.runOne(r, c, W, H)', [alone, clip, w, h])
                baseline[key] = measure(found['lumas'], data['scenes'][run['scene']]['fps'])
                baseline[key]['cpu_s'] = meter.end()
            return key

        for run in data['runs']:
            scene = data['scenes'][run['scene']]
            w, h = run.get('size') or (width, height)
            clip = run.get('clip') or data['clip']
            alone_key = None if run.get('cost') else scene_alone(run, clip, w, h)
            meter.begin(f"{run.get('group', '')} on {scene['id']}")
            result = page.evaluate('([r, c, W, H]) => window.runOne(r, c, W, H)', [run, clip, w, h])
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
                # What the chain really drew (read back from the page).
                'fx_drawn': '+'.join(result.get('fxDrawn') or []) or '(none)',
                'fx_modes': {item['id']: item.get('values', {}).get('mode') for item in run['fx'] if 'mode' in item.get('values', {})},
                'ms': round(result['ms'], 2), 'failed': result['failed'],
                'quality': result.get('quality'), 'drawn_size': result.get('size'),
                'scene_alone': alone_key,
                'scene_max_step': baseline[alone_key]['max_step'] if alone_key else None,
                'scene_mean': baseline[alone_key]['mean'] if alone_key else None,
                'key': run.get('key'), 'frames': len(result['lumas']),
            })
            if run.get('overlays') is not None:
                row.update({'halos': result.get('halos', 0), 'effective': result.get('effective'),
                            'extra_glow': run.get('extraGlow', False), 'value_drift': run.get('valueDrift', False)})
                if run.get('valueDrift'):
                    row.update({'drift_most': result.get('driftMost'), 'drift_bound': result.get('driftBound'),
                                'drift_outside': result.get('driftOutside')})
            if run.get('cost'):
                seconds = len(result['lumas']) / scene['fps']
                row['cpu_share_one_core_30fps'] = round(row['cpu_s'] / seconds, 4) if row['cpu_s'] is not None and seconds else None
            elif len(result['lumas']) >= 10 * scene['fps']:
                per_window = windows(result['lumas'], scene['fps'])
                row.update({
                    'oscillations': sum(1 for w in per_window if w['oscillation']),
                    'most_fast_p2p': max((w['fast_p2p'] for w in per_window), default=0),
                    'dominant_hz': [w['dominant_hz'] for w in per_window],
                })
            rows.append(row)
            if rows_file:
                with open(rows_file, 'a') as f:
                    f.write(json.dumps(row) + '\n')
        browser.close()
    server.shutdown()
    report = {'size': [width, height], 'quality': qualities, 'gpu': gpu, 'readback': readback, 'baseline': baseline,
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
