"""Socket-level Phase 2 catalog/artwork fixture server."""
from __future__ import annotations

import gzip
import http.server
import json
import base64
import threading
import urllib.parse
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "five-new-sources"
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class CatalogFixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        del fmt, args

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        with self.server.state_lock:  # type: ignore[attr-defined]
            self.server.calls.append({  # type: ignore[attr-defined]
                "path": parsed.path,
                "host": self.headers.get("Host", ""),
                "headers": dict(self.headers.items()),
            })
        if parsed.path == "/feed.xml":
            if self.headers.get("If-None-Match") == '"fixture-feed"':
                return self._send(304, b"", "application/rss+xml", {"ETag": '"fixture-feed"'})
            return self._send(
                200,
                (FIXTURES / "podcast-rss.xml").read_bytes(),
                "application/rss+xml",
                {"ETag": '"fixture-feed"'},
            )
        if parsed.path == "/malicious.xml":
            return self._send(200, (FIXTURES / "podcast-malicious.xml").read_bytes(), "application/xml")
        if parsed.path == "/wrong-type":
            return self._send(200, b"<html>captcha</html>", "text/html")
        if parsed.path == "/gzip.xml":
            return self._send(
                200,
                gzip.compress((FIXTURES / "podcast-atom.xml").read_bytes()),
                "application/atom+xml",
                {"Content-Encoding": "gzip"},
            )
        if parsed.path == "/gzip-bomb.xml":
            return self._send(
                200,
                gzip.compress(b"x" * (9 * 1024 * 1024)),
                "application/xml",
                {"Content-Encoding": "gzip"},
            )
        if parsed.path == "/redirect-private":
            return self._redirect("http://10.0.0.1/private")
        if parsed.path == "/redirect-cross":
            return self._redirect(f"http://mirror-fixture.test:{self.server.server_port}/feed.xml")  # type: ignore[attr-defined]
        if parsed.path.startswith("/api/v1/videos/"):
            payload = json.loads((FIXTURES / "peertube.json").read_text(encoding="utf-8"))["originDetails"]["vod"]
            payload["url"] = f"http://{self.headers.get('Host')}/videos/watch/{payload['uuid']}"
            return self._send(200, json.dumps(payload).encode(), "application/json")
        if parsed.path == "/api/iptv":
            return self._send(200, (FIXTURES / "owncast-directory.m3u").read_bytes(), "application/vnd.apple.mpegurl")
        if parsed.path == "/api/home":
            return self._send(200, (FIXTURES / "owncast-home.json").read_bytes(), "application/json")
        if parsed.path == "/cover.png":
            return self._send(200, PNG_1X1, "image/png", {"ETag": '"fixture-image"'})
        if parsed.path == "/svg":
            return self._send(200, b'<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")
        if parsed.path == "/html-as-png":
            return self._send(200, b"<html>not an image</html>", "image/png")
        return self._send(404, b"not found", "text/plain")

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def _send(self, status: int, body: bytes, content_type: str, headers=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)


class CatalogFixtureServer:
    def __init__(self) -> None:
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), CatalogFixtureHandler)
        self.httpd.daemon_threads = True
        self.httpd.calls = []  # type: ignore[attr-defined]
        self.httpd.state_lock = threading.Lock()  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.httpd.server_port

    @property
    def base_url(self) -> str:
        return f"http://catalog-fixture.test:{self.port}"

    @property
    def calls(self):
        with self.httpd.state_lock:  # type: ignore[attr-defined]
            return list(self.httpd.calls)  # type: ignore[attr-defined]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, traceback):
        del exc_type, exc, traceback
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
