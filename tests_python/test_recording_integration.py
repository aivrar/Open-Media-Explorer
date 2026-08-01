from __future__ import annotations

import functools
import http.server
import json
import math
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import worldmedia_server
from worldmedia_ffmpeg import ToolStatus
from worldmedia_jobs import JobError, JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_recording import PROFILES, RecordingService
from worldmedia_runtime import get_runtime_paths


FFMPEG = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe.exe") or shutil.which("ffprobe")


class LiveFixtureHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/index.m3u8":
            session = parse_qs(parsed.query).get("session", ["default"])[0]
            with self.server.session_lock:
                started = self.server.sessions.setdefault(session, time.monotonic())
            visible = min(len(self.server.hls_entries), 3 + int(time.monotonic() - started))
            entries = self.server.hls_entries[:visible]
            target = max(1, math.ceil(max(duration for duration, _name in entries)))
            lines = [
                "#EXTM3U", "#EXT-X-VERSION:6", f"#EXT-X-TARGETDURATION:{target}",
                "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT",
                "#EXT-X-INDEPENDENT-SEGMENTS",
            ]
            for duration, name in entries:
                lines.extend((f"#EXTINF:{duration:.6f},", name))
            body = ("\n".join(lines) + "\n").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class ActualToolService:
    def status(self):
        return ToolStatus(
            state="ready", source="PATH", ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE, version="integration",
        )


@unittest.skipUnless(FFMPEG and FFPROBE, "real FFmpeg integration requires ffmpeg and ffprobe on PATH")
class RealRecordingIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="worldmedia-recording-fixture-")
        cls.root = Path(cls.temporary.name)
        cls.media = cls.root / "media"
        cls.media.mkdir()
        subprocess.run([
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "8", "-c:a", "pcm_s16le", str(cls.media / "tone.wav"),
        ], check=True, timeout=60)
        subprocess.run([
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            # Keep publishing long enough for a deliberately slow probe under
            # antivirus/build I/O pressure. A real live channel does not stop
            # producing segments after the probe consumes an eight-second clip.
            "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "128k", str(cls.media / "source.mp4"),
        ], check=True, timeout=120)
        subprocess.run([
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(cls.media / "source.mp4"),
            "-c", "copy", "-hls_time", "1", "-hls_list_size", "0",
            "-hls_playlist_type", "event", "-hls_flags", "independent_segments",
            str(cls.media / "index.m3u8"),
        ], check=True, timeout=120)
        playlist_lines = (cls.media / "index.m3u8").read_text(encoding="utf-8").splitlines()
        cls.hls_entries = []
        for index, line in enumerate(playlist_lines):
            if line.startswith("#EXTINF:"):
                cls.hls_entries.append((float(line.split(":", 1)[1].split(",", 1)[0]), playlist_lines[index + 1]))
        if len(cls.hls_entries) < 12:
            raise AssertionError("The rolling HLS fixture requires at least twelve media segments")

        handler = functools.partial(LiveFixtureHandler, directory=str(cls.media))
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.upstream.hls_entries = cls.hls_entries
        cls.upstream.sessions = {}
        cls.upstream.session_lock = threading.Lock()
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()

        cls.registry = MediaRegistry(
            SafeConnector(address_policy=lambda _address: True, idle_timeout=5), ttl_seconds=600,
        )
        cls.old_registry = worldmedia_server.MEDIA_REGISTRY
        worldmedia_server.MEDIA_REGISTRY = cls.registry
        cls.relay = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        cls.relay_thread = threading.Thread(target=cls.relay.serve_forever, daemon=True)
        cls.relay_thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.relay.shutdown(); cls.relay.server_close(); cls.relay_thread.join(timeout=2)
        worldmedia_server.MEDIA_REGISTRY = cls.old_registry
        cls.upstream.shutdown(); cls.upstream.server_close(); cls.upstream_thread.join(timeout=2)
        cls.temporary.cleanup()

    def setUp(self) -> None:
        self.case = tempfile.TemporaryDirectory(dir=self.root, prefix="case-")
        base = Path(self.case.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        self.jobs = JobRegistry()
        self.service = RecordingService(self.registry, self.jobs, ActualToolService(), self.paths)

    def tearDown(self) -> None:
        self.jobs.shutdown(timeout=10)
        self.case.cleanup()

    def register(self, kind: str, *, source: str | None = None):
        port = self.upstream.server_port
        source = source or ("iptv-org" if kind == "video" else "radio-browser")
        return self.registry.register({
            "item_id": f"{source}:integration:{kind}:{time.time_ns()}",
            "url": (
                f"http://127.0.0.1:{port}/index.m3u8?session={time.time_ns()}"
                if kind == "video" else f"http://127.0.0.1:{port}/tone.wav"
            ),
            "delivery": "live", "media_type": "hls" if kind == "video" else "audio",
            "capture_headers": {}, "title": f"Integration {kind}",
            "source": source, "download_name": "",
        })

    def run_recording(
        self,
        kind: str,
        profile: str,
        eq: object | None = None,
        *,
        source: str | None = None,
    ) -> dict:
        origin = f"http://127.0.0.1:{self.relay.server_port}"
        started = self.service.start(self.register(kind, source=source).token, profile, origin, eq)
        deadline = time.monotonic() + 30
        stopped = False
        while time.monotonic() < deadline:
            status = self.jobs.snapshot(started["id"])
            if status["state"] == "running" and not stopped:
                time.sleep(0.7)
                try:
                    self.jobs.request_stop(started["id"])
                except JobError:
                    pass
                stopped = True
            if status["state"] in {"completed", "failed", "cancelled"}:
                self.assertEqual(status["state"], "completed", status)
                return status
            time.sleep(0.05)
        self.fail(self.jobs.snapshot(started["id"]))

    def probe(self, output: Path) -> dict:
        completed = subprocess.run([
            FFPROBE, "-v", "error", "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name,width,height,bit_rate",
            "-of", "json", str(output),
        ], check=False, capture_output=True, text=True, timeout=20)
        if completed.returncode != 0:
            self.fail(f"ffprobe failed for {output} ({output.stat().st_size} bytes): {completed.stderr}")
        return json.loads(completed.stdout)

    def mean_volume(self, output: Path) -> float:
        completed = subprocess.run([
            FFMPEG, "-hide_banner", "-nostats", "-i", str(output),
            "-af", "volumedetect", "-f", "null", "-",
        ], check=False, capture_output=True, text=True, timeout=20)
        match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", completed.stderr)
        if completed.returncode != 0 or not match:
            self.fail(f"volume measurement failed for {output}: {completed.stderr}")
        return float(match.group(1))

    def test_audio_profiles_produce_valid_mp3_near_approved_bitrates(self) -> None:
        for name, profile in PROFILES.items():
            with self.subTest(profile=name):
                status = self.run_recording("audio", name)
                output = Path(status["output_path"])
                probe = self.probe(output)
                stream = next(value for value in probe["streams"] if value["codec_type"] == "audio")
                self.assertEqual(stream["codec_name"], "mp3")
                bitrate = int(stream.get("bit_rate") or 0) / 1000
                self.assertLessEqual(abs(bitrate - profile["audio"]), max(12, profile["audio"] * 0.12))
                self.assertGreater(float(probe["format"]["duration"]), 0)

    def test_recording_eq_preamp_is_measurably_baked_into_output(self) -> None:
        flat = {"preamp": 0, "bands": [0] * 10, "bypassed": False}
        cut = {"preamp": -12, "bands": [0] * 10, "bypassed": False}
        flat_output = Path(self.run_recording("audio", "balanced", flat)["output_path"])
        cut_output = Path(self.run_recording("audio", "balanced", cut)["output_path"])
        delta = self.mean_volume(flat_output) - self.mean_volume(cut_output)
        self.assertGreater(delta, 10.0)
        self.assertLess(delta, 14.0)

    def test_hls_video_profiles_finalize_h264_aac_mp4_without_upscaling(self) -> None:
        for name, profile in PROFILES.items():
            with self.subTest(profile=name):
                status = self.run_recording("video", name)
                output = Path(status["output_path"])
                probe = self.probe(output)
                video = next(value for value in probe["streams"] if value["codec_type"] == "video")
                audio = next(value for value in probe["streams"] if value["codec_type"] == "audio")
                self.assertEqual(video["codec_name"], "h264")
                self.assertEqual(audio["codec_name"], "aac")
                self.assertLessEqual(int(video["height"]), profile["height"])
                self.assertLessEqual(int(video["height"]), 720)
                self.assertEqual(int(video["height"]) % 2, 0)
                self.assertEqual(int(video["width"]) % 2, 0)
                self.assertGreater(float(probe["format"]["duration"]), 0)
                self.assertFalse(any(self.paths.downloads_root.glob("*.working.mp4")))
                self.assertFalse(any(self.paths.downloads_root.glob("*.finalizing.mp4")))

    def test_gpodder_live_audio_and_video_use_the_shared_recording_boundary(self) -> None:
        audio = Path(self.run_recording("audio", "balanced", source="gpodder")["output_path"])
        video = Path(self.run_recording("video", "balanced", source="gpodder")["output_path"])
        audio_probe = self.probe(audio)
        video_probe = self.probe(video)
        self.assertTrue(any(stream["codec_type"] == "audio" for stream in audio_probe["streams"]))
        self.assertTrue(any(stream["codec_type"] == "video" for stream in video_probe["streams"]))
        self.assertTrue(any(stream["codec_type"] == "audio" for stream in video_probe["streams"]))
        self.assertEqual(audio.suffix.lower(), ".mp3")
        self.assertEqual(video.suffix.lower(), ".mp4")

    def test_c3voc_and_owncast_live_media_use_the_shared_recording_boundary(self) -> None:
        c3voc_audio = Path(self.run_recording(
            "audio", "balanced", source="media-ccc",
        )["output_path"])
        c3voc_video = Path(self.run_recording(
            "video", "balanced", source="media-ccc",
        )["output_path"])
        owncast_video = Path(self.run_recording(
            "video", "balanced", source="owncast",
        )["output_path"])
        self.assertEqual(c3voc_audio.suffix.lower(), ".mp3")
        for output in (c3voc_video, owncast_video):
            probe = self.probe(output)
            self.assertEqual(output.suffix.lower(), ".mp4")
            self.assertTrue(any(stream["codec_type"] == "video" for stream in probe["streams"]))
            self.assertTrue(any(stream["codec_type"] == "audio" for stream in probe["streams"]))

    def test_peertube_live_video_uses_shared_recording_and_eq_boundary(self) -> None:
        flat = {"preamp": 0, "bands": [0] * 10, "bypassed": False}
        cut = {"preamp": -12, "bands": [0] * 10, "bypassed": False}
        flat_output = Path(self.run_recording(
            "video", "balanced", flat, source="peertube",
        )["output_path"])
        cut_output = Path(self.run_recording(
            "video", "balanced", cut, source="peertube",
        )["output_path"])
        probe = self.probe(flat_output)
        self.assertTrue(any(stream["codec_type"] == "video" for stream in probe["streams"]))
        self.assertTrue(any(stream["codec_type"] == "audio" for stream in probe["streams"]))
        self.assertEqual(flat_output.suffix.lower(), ".mp4")
        self.assertEqual(cut_output.suffix.lower(), ".mp4")
        delta = self.mean_volume(flat_output) - self.mean_volume(cut_output)
        self.assertGreater(delta, 10.0)
        self.assertLess(delta, 14.0)

    def test_interrupted_fragmented_mp4_is_preserved_and_probe_recoverable(self) -> None:
        origin = f"http://127.0.0.1:{self.relay.server_port}"
        started = self.service.start(self.register("video").token, "balanced", origin)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = self.jobs.snapshot(started["id"])
            if status["state"] == "running":
                break
            time.sleep(0.05)
        else:
            self.fail(self.jobs.snapshot(started["id"]))
        time.sleep(2)
        with self.service._lock:
            controller = self.service._controllers[started["id"]
            ]
        with controller._lock:
            process = controller._process
        self.assertIsNotNone(process)
        process.kill()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = self.jobs.snapshot(started["id"])
            if status["state"] == "failed":
                break
            time.sleep(0.05)
        self.assertEqual(status["state"], "failed", status)
        recoverable = Path(status["output_path"])
        self.assertTrue(recoverable.is_file())
        probe = self.probe(recoverable)
        self.assertTrue(any(stream["codec_type"] == "video" for stream in probe["streams"]))
        self.assertGreater(float(probe["format"]["duration"]), 0)


if __name__ == "__main__":
    unittest.main()
