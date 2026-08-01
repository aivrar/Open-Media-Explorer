"""Reusable localhost fixtures for media, redirects, headers, and failures."""
from __future__ import annotations

import contextlib
import http.server
import io
import json
import re
import socket
import threading
import time
import urllib.parse
import wave
import math
import struct
from dataclasses import dataclass, field


AUDIO_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x15WorldMediaAudioFixture"
VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42WorldMediaVideoFixture"
ZIP_BYTES = b"PK\x03\x04WorldMediaFullAudiobookFixture"
SEGMENT_BYTES = b"G" * 188 * 3
LARGE_BYTES = bytes(range(256)) * 4096
DASH_FILES: dict[str, tuple[bytes, str]] = {}


def _tone_wav() -> bytes:
    output = io.BytesIO()
    sample_rate = 8_000
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate):
            sample = int(12_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wav.writeframes(frames)
    return output.getvalue()


TONE_WAV = _tone_wav()


@dataclass
class FixtureState:
    requests: list[dict[str, object]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stream_cancelled: threading.Event = field(default_factory=threading.Event)
    counters: dict[str, int] = field(default_factory=dict)

    def record(self, path: str, headers: http.client.HTTPMessage) -> None:
        with self.lock:
            self.requests.append({"path": path, "headers": dict(headers.items())})
            self.counters[path] = self.counters.get(path, 0) + 1


class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        del request, client_address


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> FixtureState:
        return self.server.fixture_state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: object) -> None:
        del fmt, args

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        self.state.record(parsed.path, self.headers)

        if parsed.path == "/media/audio.mp3":
            return self._send_rangeable(AUDIO_BYTES, "audio/mpeg")
        if parsed.path == "/media/video.mp4":
            return self._send_rangeable(VIDEO_BYTES, "video/mp4")
        if parsed.path == "/media/book.zip":
            return self._send_rangeable(ZIP_BYTES, "application/zip")
        if parsed.path == "/media/unknown.mp3":
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(AUDIO_BYTES)
            self.close_connection = True
            return None
        if parsed.path == "/media/html.mp3":
            return self._send(200, b"<!doctype html><html>error</html>", "text/html")
        if parsed.path == "/media/empty.mp3":
            return self._send(200, b"", "audio/mpeg")
        if parsed.path == "/resume/stable.mp3":
            if self.headers.get("Range"):
                return self._send_rangeable(AUDIO_BYTES, "audio/mpeg", extra={"ETag": '"stable"'})
            return self._send_interrupted(AUDIO_BYTES, "audio/mpeg", '"stable"')
        if parsed.path == "/resume/changed.mp3":
            with self.state.lock:
                count = self.state.counters.get(parsed.path, 0)
            if count == 1:
                return self._send_interrupted(AUDIO_BYTES, "audio/mpeg", '"old"')
            return self._send_rangeable(AUDIO_BYTES, "audio/mpeg", extra={"ETag": '"new"'}, ignore_range=count == 2)
        if parsed.path == "/resume/weak.mp3":
            with self.state.lock:
                count = self.state.counters.get(parsed.path, 0)
            if count == 1:
                return self._send_interrupted(AUDIO_BYTES, "audio/mpeg", 'W/"weak"')
            return self._send_rangeable(AUDIO_BYTES, "audio/mpeg")
        if parsed.path == "/media/tone.wav":
            return self._send_rangeable(TONE_WAV, "audio/wav")
        if parsed.path == "/media/large.bin":
            return self._send_rangeable(LARGE_BYTES, "application/octet-stream")
        if parsed.path in DASH_FILES:
            body, content_type = DASH_FILES[parsed.path]
            return self._send_rangeable(body, content_type)
        if parsed.path.startswith("/hls/segment"):
            return self._send(200, SEGMENT_BYTES, "video/mp2t")
        if parsed.path == "/hls/key.bin":
            return self._send(200, b"0123456789abcdef", "application/octet-stream")
        if parsed.path == "/hls/init.mp4":
            return self._send(200, VIDEO_BYTES, "video/mp4")
        if parsed.path == "/hls/master.m3u8":
            body = (
                b'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8?secret=audio"\n'
                b'#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"\nvideo.m3u8?secret=video\n'
            )
            return self._send(200, body, "application/vnd.apple.mpegurl")
        if parsed.path in {"/hls/audio.m3u8", "/hls/video.m3u8"}:
            body = (
                b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=key"\n'
                b'#EXT-X-MAP:URI="init.mp4?secret=map"\n#EXTINF:4,\nsegment0.ts?secret=segment\n#EXT-X-ENDLIST\n'
            )
            return self._send(200, body, "application/vnd.apple.mpegurl")
        if parsed.path == "/hls/vod/index.m3u8":
            body = b"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n../segment0.ts\n#EXT-X-ENDLIST\n"
            return self._send(200, body, "application/vnd.apple.mpegurl")
        if parsed.path == "/hls/live/index.m3u8":
            body = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n../segment7.ts\n"
            return self._send(200, body, "application/vnd.apple.mpegurl")
        if parsed.path == "/dash/manifest.mpd":
            body = b'''<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e" segmentAlignment="true">
      <BaseURL>assets/</BaseURL>
      <SegmentTemplate timescale="1" duration="2" startNumber="1"
        initialization="init-$RepresentationID$.mp4?secret=init"
        media="segment-$RepresentationID$-$Number%05d$.m4s?secret=segment" />
      <Representation id="v1" bandwidth="1000" width="320" height="180" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" segmentAlignment="true">
      <SegmentList timescale="1" duration="2">
        <Initialization sourceURL="assets/audio-init.mp4?secret=audio-init" />
        <SegmentURL media="assets/audio-1.m4s?secret=audio-segment" />
      </SegmentList>
      <Representation id="a1" bandwidth="128000" />
    </AdaptationSet>
  </Period>
</MPD>'''
            return self._send(200, body, "application/dash+xml")
        if parsed.path == "/dash/drm.mpd":
            body = b'''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period><AdaptationSet>
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
<Representation id="v1" bandwidth="1000" /></AdaptationSet></Period></MPD>'''
            return self._send(200, body, "application/dash+xml")
        if parsed.path == "/dash/unsafe.mpd":
            body = b'''<?xml version="1.0"?><!DOCTYPE MPD [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>&xxe;</Period></MPD>'''
            return self._send(200, body, "application/dash+xml")
        if parsed.path in {
            "/dash/assets/init-v1.mp4", "/dash/assets/audio-init.mp4",
        }:
            return self._send_rangeable(VIDEO_BYTES, "video/mp4")
        if parsed.path in {
            "/dash/assets/segment-v1-00001.m4s", "/dash/assets/audio-1.m4s",
        }:
            return self._send_rangeable(SEGMENT_BYTES, "video/iso.segment")
        if parsed.path == "/redirect/public":
            return self._redirect("/media/audio.mp3")
        if parsed.path == "/redirect/private":
            return self._redirect("http://127.0.0.1:1/private")
        if parsed.path == "/protected":
            valid = (
                self.headers.get("Referer") == "https://catalog.example/item"
                and self.headers.get("User-Agent") == "WorldMediaFixture/1"
            )
            return self._send(200 if valid else 403, b"allowed" if valid else b"forbidden", "text/plain")
        if parsed.path == "/slow":
            delay = min(float(urllib.parse.parse_qs(parsed.query).get("seconds", ["0.05"])[0]), 0.5)
            time.sleep(max(0.0, delay))
            return self._send(200, b"slow", "text/plain")
        if parsed.path == "/interrupted":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"partial")
            self.wfile.flush()
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.shutdown(socket.SHUT_RDWR)
            return None
        if parsed.path == "/malformed.json":
            return self._send(200, b'{"broken":', "application/json")
        if parsed.path == "/malformed.m3u8":
            return self._send(200, b"this is not an HLS manifest", "application/vnd.apple.mpegurl")
        if parsed.path == "/stream/endless":
            return self._send_endless()
        if parsed.path == "/requests":
            with self.state.lock:
                body = json.dumps(self.state.requests).encode("utf-8")
            return self._send(200, body, "application/json")
        return self._send(404, b"not found", "text/plain")

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        self.state.record(parsed.path, self.headers)
        if parsed.path == "/media/audio.mp3":
            return self._send_rangeable(AUDIO_BYTES, "audio/mpeg", head=True)
        if parsed.path == "/media/video.mp4":
            return self._send_rangeable(VIDEO_BYTES, "video/mp4", head=True)
        return self._send(404, b"", "text/plain", head=True)

    def _send_rangeable(self, body: bytes, content_type: str, *, head: bool = False,
                        extra: dict[str, str] | None = None, ignore_range: bool = False) -> None:
        start, end = 0, len(body) - 1
        status = 200
        header = None if ignore_range else self.headers.get("Range")
        if header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
            if not match:
                return self._send(416, b"", content_type, {"Content-Range": f"bytes */{len(body)}"})
            first, last = match.groups()
            if not first and last:
                length = min(int(last), len(body))
                start = len(body) - length
            else:
                start = int(first or 0)
                end = min(int(last), end) if last else end
            if start >= len(body) or end < start:
                return self._send(416, b"", content_type, {"Content-Range": f"bytes */{len(body)}"})
            status = 206
        payload = body[start : end + 1]
        headers = {"Accept-Ranges": "bytes", **(extra or {})}
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{len(body)}"
        self._send(status, payload, content_type, headers, head=head)

    def _send_interrupted(self, body: bytes, content_type: str, etag: str) -> None:
        partial = body[: max(1, len(body) // 2)]
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(partial)
        self.wfile.flush()
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, status: int, body: bytes, content_type: str,
              extra: dict[str, str] | None = None, *, head: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body and not head:
            self.wfile.write(body)

    def _send_endless(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        chunk = b"stream-fixture" * 32
        try:
            while True:
                self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
                self.wfile.flush()
                time.sleep(0.002)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.state.stream_cancelled.set()
        return None


class MediaFixtureServer:
    def __init__(self, port: int = 0) -> None:
        self.state = FixtureState()
        self.httpd = QuietThreadingHTTPServer(("127.0.0.1", port), FixtureHandler)
        self.httpd.fixture_state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "MediaFixtureServer":
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:  # noqa: ANN001
        del exc_type, exc, traceback
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
