"""Compiles and links scenes' shaders in Chromium, as the Visualizer tab
builds them, on WebGL 2 and WebGL 1, and prints the compile and link log of
any that fail. Draws and measures nothing: run it before a measuring run so a
shader that does not compile is found first.

    python tests/helpers/visualizer-compile-check.py [scene ids...] [--gpu]

With no ids: World Media's own scenes (own-scenes.js), held ones included.
Every look of each scene is built (held and left-out looks too). --gpu
compiles on the graphics card (ANGLE on Direct3D 11) as the app does;
without it SwiftShader. Serves src/ and tests/helpers/ from a local port for
the page's modules. Needs Python Playwright with Chromium. Run by hand; not
part of npm test. Exit code 1 when any shader fails."""

import functools
import http.server
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]

PAGE = (b'<!doctype html><html><body>'
        b'<script type="module" src="/tests/helpers/visualizer-compile-check-page.js"></script>'
        b'</body></html>')


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/compile-check.html':
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


def main():
    gpu = '--gpu' in sys.argv
    ids = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    failed = 0
    with sync_playwright() as p:
        flags = (['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] if gpu
                 else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        browser = p.chromium.launch(args=flags)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'http://127.0.0.1:{port}/compile-check.html')
        page.wait_for_function('window.compileReady === true', timeout=30_000)
        rows = page.evaluate('(ids) => window.checkCompile(ids)', ids)
        browser.close()
    server.shutdown()
    for row in rows:
        if not row.get('ok'):
            failed += 1
        print(json.dumps(row), flush=True)
    for error in errors:
        failed += 1
        print(json.dumps({'page_error': error}), flush=True)
    print(json.dumps({'checked': len(rows), 'failed': failed, 'gpu': gpu}), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
