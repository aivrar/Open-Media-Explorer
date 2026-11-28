from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from email.message import Message
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

import worldmedia_server
from tests_python.test_computer_convert import FLAC_AUDIO
from worldmedia_computer import ComputerFolders
from worldmedia_computer_art import ComputerArt
from worldmedia_computer_convert import ComputerConvert
from worldmedia_computer_library import _absolute_disk_path, _file_id
from worldmedia_computer_probe import ProbeError, UNREADABLE_AUDIO
from worldmedia_computer_media import (
    MAX_TOKENS, MEDIA_CHUNK_SIZE, TOKEN_TTL, ComputerMedia, _audio_choices, media_mime, media_range,
)


def link_directory(link, target):
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


class AudioTrackLabelTests(unittest.TestCase):
    audio = {"codec_type": "audio", "index": 6, "channels": 2, "sample_rate": "48000"}

    def test_codec_names(self):
        for codec, profile, label in (
            ("pcm_dvd", "", "PCM"), ("pcm_bluray", "", "PCM"), ("pcm_s16le", "", "PCM"),
            ("ac3", "", "AC-3"), ("eac3", "", "E-AC-3"), ("dts", "DTS", "DTS"),
            ("dts", "DTS-HD MA", "DTS-HD MA"), ("dts", "DTS-HD HRA", "DTS-HD HRA"),
            ("truehd", "", "TrueHD"), ("mlp", "", "MLP"), ("aac", "", "AAC"),
            ("mp3", "", "MP3"), ("mp2", "", "MP2"), ("flac", "", "FLAC"), ("alac", "", "ALAC"),
            ("opus", "", "Opus"), ("vorbis", "", "Vorbis"), ("wmav2", "", "WMA"),
            ("wmapro", "", "WMA"), ("wmalossless", "", "WMA Lossless"),
            ("some_codec", "", "SOME CODEC"),
        ):
            with self.subTest(codec=codec, profile=profile):
                data = {"streams": [{**self.audio, "codec_name": codec, "profile": profile}]}
                [track], _, _ = _audio_choices(data, None)
                self.assertEqual(track["label"], f"Track 1 (Stereo {label})")
                self.assertEqual(track["codec"], codec)

    def test_label_counts_only_playable_tracks_and_keeps_the_original_index(self):
        data = {"streams": [
            {**self.audio, "index": 3, "sample_rate": "0"},
            {**self.audio, "codec_name": "pcm_dvd"},
        ]}
        [track], selected, changed = _audio_choices(data, 1)
        self.assertEqual((track["index"], track["label"]), (1, "Track 1 (Stereo PCM)"))
        self.assertEqual((selected, changed), (6, False))


class ComputerMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        cls.addClassCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        cls.addClassCleanup(thread.join, 5)
        cls.addClassCleanup(server.shutdown)
        cls.port = server.server_port
        cls.origin = f"http://127.0.0.1:{cls.port}"

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.folder = self.root / "Private Collection"
        self.folder.mkdir()
        self.folders = ComputerFolders(self.root / "state" / "computer-folders.json")
        self.saved = self.folders.add(str(self.folder))
        self.track = self.folder / "Björk ♫.wav"
        self.data = bytes(range(10))
        self.track.write_bytes(self.data)
        self.identity = self.index(self.track, container="wav", acodec="pcm_s16le", duration=12.5)
        self.now = 0
        self.flac = FLAC_AUDIO
        self.convert_runner = mock.Mock(side_effect=self.convert_to_flac)
        self.converter = ComputerConvert(self.root / "cache" / "computer-convert",
                                         ffmpeg=lambda: "fake-ffmpeg", runner=self.convert_runner,
                                         clock=lambda: self.now)
        self.media = ComputerMedia(self.converter, clock=lambda: self.now)
        self.addCleanup(self.media.shutdown, 5)
        self.ffmpeg = mock.Mock(side_effect=self.render)
        self.art = ComputerArt(self.root / "cache" / "computer-art", ffmpeg=lambda: "ffmpeg", runner=self.ffmpeg)
        self.enterContext(mock.patch.multiple(worldmedia_server, COMPUTER_FOLDERS=self.folders,
                                              COMPUTER_ART=self.art, COMPUTER_MEDIA=self.media))
        self.enterContext(mock.patch.object(worldmedia_server, "rate_limit", return_value=True))
        self.addCleanup(self.art.shutdown)
        self.auth = {"X-WorldMedia-Token": worldmedia_server.SESSION_TOKEN}
        self.mutation = {**self.auth, "Origin": self.origin, "Content-Type": "application/json"}

    def index(self, path, **fields):
        identity = _file_id(str(path))
        info = path.stat()
        entry = {"id": identity, "folder": self.saved["id"], "rel": path.relative_to(self.folder).as_posix(),
                 "ext": "wav", "kind": "audio", "size": info.st_size, "mtime": info.st_mtime_ns,
                 "probed": True, **fields}
        self.folders.library.load()
        with self.folders.library._lock:
            self.folders.library._items[identity] = entry
        return identity

    @staticmethod
    def render(command, **kwargs):
        Path(command[-1]).write_bytes(b"\xff\xd8\xff\xd9")
        return True

    def convert_to_flac(self, command, **_):
        Path(command[-1]).write_bytes(self.flac)
        return True

    def request(self, method, url, headers=None, body=None):
        with closing(http.client.HTTPConnection("127.0.0.1", self.port, timeout=getattr(self, "request_timeout", 5))) as connection:
            if isinstance(headers, list):
                connection.putrequest(method, url)
                for key, value in headers:
                    connection.putheader(key, value)
                connection.endheaders()
            else:
                connection.request(method, url, body, headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()

    def play(self, identity=None, headers=None, **fields):
        status, _, body = self.request("POST", "/api/v1/computer/play",
                                       self.mutation if headers is None else headers,
                                       json.dumps({"id": self.identity if identity is None else identity, **fields}))
        return status, json.loads(body)

    @unittest.skipUnless(os.environ.get("WORLDMEDIA_INDEX_BENCH") == "1", "Set WORLDMEDIA_INDEX_BENCH=1.")
    def test_one_gb_index_and_play_latency(self):
        import shutil
        import worldmedia_computer_video as video
        from tests_python.test_computer_video import ff, FFMPEG

        part = self.folder / "part.vob"
        ff("-f", "lavfi", "-i", "testsrc2=s=160x120:r=25", "-t", "20", "-c:v", "mpeg2video",
           "-b:v", "8M", "-minrate", "8M", "-maxrate", "8M", "-bufsize", "1M", "-f", "vob", part)
        joined = self.folder / "large.vob"
        copies = (10**9 + part.stat().st_size - 1) // part.stat().st_size
        with joined.open("wb") as out, part.open("rb") as src:
            for _ in range(copies):
                src.seek(0)
                shutil.copyfileobj(src, out, 1 << 20)
        with joined.open("rb") as src:
            while src.read(1 << 20):
                pass
        identity = self.index(joined, kind="video", ext="vob", container="mpeg", vcodec="mpeg2video")
        self.media._video = video.ComputerVideo(self.root / "cache" / "video", ffmpeg=lambda: FFMPEG, clock=self.media._clock)
        self.request_timeout = 75
        passes = []
        probe = video._probe_timeline
        def timed(*args):
            begin = time.monotonic()
            result = probe(*args)
            passes.append(time.monotonic() - begin)
            return result
        with mock.patch.object(video, "_probe_timeline", side_effect=timed):
            begin = time.monotonic()
            status, answer = self.play(identity)
            self.assertEqual(status, 200, answer)
            data = answer["data"]
            self.assertAlmostEqual(data["duration"], 20 * copies, delta=.04)
            self.assertNotIn("duration_estimated", data)
            base = data["url"].rsplit("/", 1)[0]
            self.assertEqual(self.request("GET", base + "/seg/0.ts")[0], 200)
            elapsed = time.monotonic() - begin
        self.assertEqual(len(passes), 1)
        print(f"{joined.stat().st_size:,} bytes, warm index {passes[0]:.3f}s, HTTP play through segment 0 {elapsed:.3f}s")

    def test_play_publishes_estimate_and_replaces_it_with_measured_duration(self):
        path = self.folder / "film.vob"
        path.write_bytes(bytes(1024))
        identity = self.index(path, kind="video", ext="vob", container="mpeg", vcodec="mpeg2video")
        self.media._video = mock.Mock()
        for estimated, duration in ((True, 57.5), (False, 55)):
            self.media._video.prepare.return_value = SimpleNamespace(duration=duration, duration_estimated=estimated, timeline=None)
            status, response = self.play(identity)
            self.assertEqual(status, 200)
            answer = response["data"]
            row = self.folders.library.entry(identity)
            self.assertEqual(answer["entry"], row)
            for item in (answer, row):
                self.assertEqual(item["duration"], duration)
                if estimated:
                    self.assertIs(item["duration_estimated"], True)
                else:
                    self.assertNotIn("duration_estimated", item)

    def test_play_rejects_silent_menu_stills_before_conversion_or_registration(self):
        import worldmedia_computer_video as video
        worker = video.ComputerVideo(self.root / "video", ffmpeg=lambda: "ffmpeg")
        self.media._video = worker
        path = self.folder / "menu.vob"
        path.write_bytes(bytes(254_000))
        for duration, ext in ((.033367, "vob"), (.1001, "vob"), (.5, "mp4")):
            identity = self.index(path, kind="video", ext=ext, container="mpeg" if ext == "vob" else "mp4",
                                  vcodec="mpeg2video" if ext == "vob" else "h264", pix_fmt="yuv420p", duration=duration)
            worker.probe = mock.Mock(return_value={"format": {"format_name": "mpeg", "duration": duration},
                                     "streams": [dict(index=0, codec_type="video", width=720, height=480)]})
            with (mock.patch.object(video, "_packet_sample", return_value=[(0, 0, duration)]),
                  mock.patch.object(video, "_timeline", return_value=video.Timeline(duration, (), 1)) as index,
                  mock.patch.object(video, "_run_ffmpeg") as decode, mock.patch.object(worker, "launch") as launch):
                status, answer = self.play(identity)
                self.assertEqual(index.call_count, int(ext == "vob"))
                decode.assert_not_called()
                launch.assert_not_called()
            self.assertEqual((status, answer["error"]["code"], answer["error"]["message"], answer["error"]["retryable"]),
                             (422, "COMPUTER_VIDEO_TOO_SHORT", "This file is too short to play.", False))
            self.assertEqual((worker.sessions, len(self.media._tokens)), ({}, 0))

    def test_active_hls_survives_token_cap_and_ended_urls_remain_gone(self):
        from fractions import Fraction
        import worldmedia_computer_video as video
        path = self.folder / "movie.vob"
        path.write_bytes(b"source")
        identity = self.index(path, kind="video", ext="vob", container="mpeg", vcodec="mpeg2video", duration=50)
        worker = video.ComputerVideo(self.root / "video", ffmpeg=lambda: "fake", clock=lambda: self.now,
                                     encoder_probe=lambda *args: False)
        self.media._video = worker
        movie = video.Movie("fake", str(path), 30, 0, None, 2, Fraction(30), "setsar=1")
        with mock.patch.object(worker, "prepare", return_value=movie):
            for stale in (50, 10):
                self.folders.library._items[identity]["duration"] = stale
                status, response = self.play(identity)
                self.assertEqual((status, response["data"]["duration"]), (200, 30))
            url = response["data"]["url"]
            base = url.rsplit("/", 1)[0]
            self.assertEqual(self.request("GET", base + "/seg/99.ts")[0], 416)
            self.assertEqual(self.request("HEAD", base + "/seg/0.ts")[0], 503)
            self.assertIsNone(worker.run)
            failed = mock.Mock(stderr=None, stdout=None)
            failed.poll.return_value = 1
            with mock.patch.object(worker, "launch", return_value=failed):
                for expected in (503, 503, 500):
                    status, _, body = self.request("GET", base + "/seg/0.ts")
                    self.assertEqual(status, expected)
                    self.assertNotIn(str(path).encode(), body)
            url = self.url(identity)
            base = url.rsplit("/", 1)[0]
            self.assertEqual(self.request("GET", url)[0], 200)
            for _ in range(MAX_TOKENS + 1):
                self.assertEqual(self.play()[0], 200)
            self.assertEqual(self.request("GET", url)[0], 200)
            self.assertEqual(self.request("POST", base + "/release", self.mutation)[0], 204)
            self.assertEqual(self.request("GET", url)[0], 410)
            self.assertEqual(self.request("GET", base + "/seg/0.ts")[0], 410)
            self.assertEqual(self.request("GET", base + "/nonesuch")[0], 404)
            unknown = "/api/v1/computer/hls/" + "0" * 64
            self.assertEqual(self.request("POST", unknown + "/release", self.mutation)[0], 204)
            self.assertEqual(self.request("GET", unknown + "/index.m3u8")[0], 404)
            url = self.url(identity)
            self.now += TOKEN_TTL + 1
            self.assertEqual(self.request("GET", url)[0], 410)
            url = self.url(identity)
            path.unlink()
            self.assertEqual(self.request("GET", url)[0], 410)
            worker.free_space = lambda _: 0
            path.write_bytes(b"source")
            self.index(path, kind="video", ext="vob", container="mpeg", vcodec="mpeg2video")
            status, response = self.play(identity)
            self.assertEqual((status, response["error"]["message"]),
                             (500, "There is not enough disk space to prepare this file."))

    def test_four_hls_sessions_protect_recent_requests_and_promote_standby(self):
        from fractions import Fraction
        import worldmedia_computer_video as video
        path = self.folder / "movie.vob"
        path.write_bytes(b"film")
        identity = self.index(path, kind="video", ext="vob", vcodec="mpeg2video", duration=60)
        worker = video.ComputerVideo(self.root / "hls", ffmpeg=lambda: None, clock=lambda: self.now)
        self.media._video = worker
        movie = video.Movie("unused", str(path), 60, 0, None, 2, Fraction(30), "setsar=1")
        with mock.patch.object(worker, "prepare", return_value=movie):
            first, idle, third, fourth = [self.play(identity, standby=True)[1]["data"]["url"] for _ in range(4)]
            self.assertEqual(self.request("GET", first)[0], 200)
            fifth = self.url(identity)
            self.assertEqual(self.request("GET", idle)[0], 410)
            for url in (third, fourth, fifth):
                self.assertEqual(self.request("GET", url)[0], 200)
            status, payload = self.play(identity)
            self.assertEqual((status, payload["error"]["retryable"]), (503, True))
            self.now = 30
            sixth = self.play(identity, standby=True)[1]["data"]["url"]
            self.assertEqual(self.request("GET", first)[0], 410)
            self.now += 120
            self.assertEqual(self.request("GET", sixth)[0], 410)
            self.assertEqual(self.request("GET", third)[0], 200)
            self.assertIsNone(worker.run)

    def url(self, identity=None):
        status, result = self.play(identity)
        self.assertEqual(status, 200, result)
        return result["data"]["url"]

    def test_play_url_binding_metadata_and_separate_tokens(self):
        status, payload = self.play()
        self.assertEqual(status, 200)
        answer = payload["data"]
        self.assertRegex(answer["url"], r"^/api/v1/computer/media/[0-9a-f]{64}$")
        self.assertEqual(answer, {"url": answer["url"], "mime": "audio/wav", "size": 10, "kind": "audio",
                                  "container": "wav", "vcodec": None, "acodec": "pcm_s16le", "duration": 12.5,
                                  "entry": self.folders.library.entry(self.identity)})
        another_url = self.url(self.identity.upper())
        self.assertNotEqual(another_url, answer["url"])
        other = self.folder / "Other.wav"
        other.write_bytes(b"other track")
        other_url = self.url(self.index(other))
        for url, data in ((answer["url"], self.data), (another_url, self.data), (other_url, b"other track")):
            status, _, content = self.request("GET", url)
            self.assertEqual((status, content), (200, data))

    def test_loudness_route_resolves_files_and_publishes_measured_fields(self):
        route = "/api/v1/computer/loudness"

        self.addCleanup(self.folders.library.shutdown)

        def request(identity):
            status, _, content = self.request("POST", route, self.mutation, json.dumps({"id": identity}))
            return status, json.loads(content)

        missing = "f" * 24
        self.assertEqual(request(missing)[1]["error"]["code"], "COMPUTER_ENTRY_NOT_FOUND")
        self.index(self.track, kind="video", duration=20)
        status, payload = request(self.identity)
        self.assertEqual((status, payload["error"]["code"], payload["error"]["retryable"]),
                         (422, "COMPUTER_LOUDNESS_UNAVAILABLE", False))
        for duration in (None, 10801):
            self.index(self.track, duration=duration)
            status, payload = request(self.identity)
            self.assertEqual((status, payload["error"]["message"]),
                             (422, "The loudness of this file cannot be measured."))
        self.index(self.track, duration=30, rg_track_gain=-3)
        self.assertEqual(request(self.identity)[1]["data"],
                         {"id": self.identity, "rg_track_gain": -3, "rg_track_peak": None, "rg_measured": False})
        self.index(self.track, container="wav", acodec="pcm_s16le", duration=30)
        with mock.patch.object(self.media._loudness, "_ffmpeg", return_value="ffmpeg"), \
                mock.patch.object(self.media._loudness, "_runner", return_value=(5.0, 0.1)) as runner:
            expected = {"id": self.identity, "rg_track_gain": 5.0, "rg_track_peak": 0.1, "rg_measured": True}
            for _ in range(2):
                status, payload = request(self.identity)
                self.assertEqual((status, payload["data"]), (200, expected))
            runner.assert_called_once()
        played = self.media.register(self.folders, self.identity)
        self.assertEqual({key: played["entry"][key] for key in expected}, expected)
        self.track.unlink()
        status, payload = request(self.identity)
        self.assertEqual((status, payload["error"]["code"]), (404, "COMPUTER_FILE_GONE"))

    def test_converted_play_token_serves_flac_ranges_and_rechecks_original(self):
        source = self.folder / "source.aiff"
        source.write_bytes(b"original data")
        identity = self.index(source, ext="aiff", container="aiff", acodec="pcm_s16be", duration=12.5)
        status, payload = self.play(identity)
        self.assertEqual(status, 200, payload)
        answer = payload["data"]
        url = answer["url"]
        self.assertEqual(answer, {"url": url, "mime": "audio/flac", "size": len(self.flac), "kind": "audio",
                                  "container": "flac", "vcodec": None, "acodec": "flac", "duration": 12.5,
                                  "converted": True, "format": "flac",
                                  "entry": self.folders.library.entry(identity)})
        status, headers, body = self.request("GET", url, {"Range": "bytes=2-6"})
        self.assertEqual((status, body, headers["Content-Type"]), (206, self.flac[2:7], "audio/flac"))
        self.assertEqual(headers["Content-Range"], f"bytes 2-6/{len(self.flac)}")
        self.assertEqual(self.request("HEAD", url)[1]["Content-Length"], str(len(self.flac)))
        self.assertNotEqual(self.url(identity), url)
        self.convert_runner.assert_called_once()
        source.unlink()
        self.assertEqual(self.request("GET", url)[0], 404)
        self.assertEqual(self.play(identity)[0], 404)
        self.convert_runner.assert_called_once()

    def test_force_convert_native_audio_and_leave_video_native(self):
        status, result = self.play(convert=True)
        self.assertEqual(status, 200)
        self.assertTrue(result["data"]["converted"])
        self.assertEqual(result["data"]["entry"]["acodec"], "pcm_s16le")
        video = self.folder / "Video.mp4"
        video.write_bytes(b"video")
        identity = self.index(video, kind="video", ext="mp4", container="mp4", vcodec="h264")
        status, result = self.play(identity, convert=True)
        self.assertEqual(status, 200)
        self.assertEqual(result["data"]["mime"], "video/mp4")
        self.assertNotIn("converted", result["data"])
        self.assertEqual(self.play(convert="true")[0], 400)
        self.convert_runner.assert_called_once()

    def test_unprobed_and_stale_fingerprints_use_current_audio_streams(self):
        for ext, stale in (("webm", False), ("mka", False), ("mp4", True)):
            with self.subTest(ext=ext):
                source = self.folder / ("Song." + ext)
                source.write_bytes(b"original")
                identity = self.index(source, kind="video", ext=ext, probed=stale,
                                      vcodec="h264", acodec="aac", audio_tracks=[{"default": True, "index": 6}])
                if stale:
                    source.write_bytes(b"replacement")
                sample = {"format": {"format_name": "matroska,webm", "duration": "1"},
                          "streams": [{"codec_type": "audio", "codec_name": "aac", "index": 0},
                                      {"codec_type": "audio", "codec_name": "ac3", "index": 3,
                                       "sample_rate": "48000", "channels": 6, "disposition": {"default": 1}}]}
                scanner = self.folders.library
                with (mock.patch.object(scanner, "_ffprobe", return_value="ffprobe"),
                      mock.patch.object(scanner, "_runner", return_value=sample) as runner):
                    status, result = self.play(identity)
                    runner.assert_called_once()
                self.assertEqual(status, 200, result)
                self.assertTrue(result["data"]["converted"])
                self.assertEqual(result["data"]["kind"], "audio")
                row = result["data"]["entry"]
                self.assertEqual(row, scanner.entry(identity))
                self.assertEqual(row["kind"], "audio")
                self.assertEqual(row["acodec"], "ac3")
                self.assertTrue(row["probed"])
                self.assertNotIn("vcodec", row)
                self.assertEqual((row["size"], row["mtime"]), (source.stat().st_size, source.stat().st_mtime_ns))
                command = self.convert_runner.call_args.args[0]
                self.assertEqual(command[command.index("-map") + 1], "0:3")

    def test_unavailable_probe_uses_original_and_never_converts_using_stale_streams(self):
        source = self.folder / "Unknown.aiff"
        source.write_bytes(b"replacement")
        identity = self.index(source, ext="aiff", acodec="pcm_s16be",
                              audio_tracks=[{"default": True, "index": 6}])
        source.write_bytes(b"another replacement")
        scanner = self.folders.library
        with mock.patch.object(scanner, "_ffprobe", return_value=None):
            status, response = self.play(identity)
            refused, error = self.play(identity, convert=True)
        self.assertEqual(status, 200, response)
        self.assertIsNone(response["data"]["acodec"])
        row = response["data"]["entry"]
        self.assertEqual(row, scanner.entry(identity))
        self.assertEqual(row["size"], source.stat().st_size)
        self.assertFalse(row["probed"])
        self.assertNotIn("audio_tracks", row)
        self.assertEqual(refused, 503, error)
        self.assertEqual(error["error"], {"code": "COMPUTER_PLAY_PROPERTIES_UNAVAILABLE",
                                          "message": "This file cannot be read.", "retryable": False})
        self.convert_runner.assert_not_called()

    def test_error_row_is_rechecked_with_same_fingerprint_then_published(self):
        self.index(self.track, error=UNREADABLE_AUDIO)
        scanner = self.folders.library
        view = scanner.snapshot()
        repaired = {"format": {"format_name": "wav"},
                    "streams": [{"codec_type": "audio", "codec_name": "pcm_s16le", "duration": "4"}]}
        with (mock.patch.object(scanner, "_ffprobe", return_value="ffprobe"),
              mock.patch.object(scanner, "_runner", side_effect=[ProbeError("bad read"), repaired]) as runner):
            status, payload = self.play()
            self.assertEqual(status, 422)
            self.assertEqual(payload["error"], {"code": "COMPUTER_FILE_UNREADABLE",
                                                  "message": "This file cannot be read.", "retryable": False})
            status, payload = self.play()
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(status, 200, payload)
        row = payload["data"]["entry"]
        self.assertEqual(row, scanner.entry(self.identity))
        self.assertEqual(row["duration"], 4)
        self.assertNotIn("error", row)
        self.assertEqual(scanner.snapshot(view["revision"], view["generation"])["items"], [row])
        persisted = json.loads(scanner.path.read_bytes())
        self.assertEqual(persisted["items"], [row])

    def test_disconnect_cancels_property_read_and_keeps_old_row(self):
        self.index(self.track, probed=False)
        scanner = self.folders.library
        old = scanner.entry(self.identity)
        entered, finished = threading.Event(), threading.Event()
        observed = []

        def runner(tool, path, cancel):
            entered.set()
            observed.append(cancel.wait(3))
            finished.set()
            return {"streams": [{"codec_type": "audio", "codec_name": "pcm_s16le"}]}

        with (mock.patch.object(scanner, "_ffprobe", return_value="ffprobe"),
              mock.patch.object(scanner, "_runner", side_effect=runner),
              closing(http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)) as connection):
            connection.request("POST", "/api/v1/computer/play", json.dumps({"id": self.identity}), self.mutation)
            self.assertTrue(entered.wait(2))
            connection.close()
            self.assertTrue(finished.wait(2))
        self.assertEqual(observed, [True])
        self.assertEqual(scanner.entry(self.identity), old)

    def test_converted_token_stays_protected_when_recently_used(self):
        self.converter._limit = 256
        self.enterContext(mock.patch("worldmedia_computer_convert._estimate", return_value=128))
        status, result = self.play(convert=True)
        self.assertEqual(status, 200, result)
        url = result["data"]["url"]
        (cached,) = self.converter.cache.iterdir()

        def pressure(name):
            filler = self.converter.cache / ((name * 64) + ".flac")
            filler.write_bytes(b"fLaC" + bytes(160))
            os.utime(cached, (1, 1))
            other = self.folder / (name + ".aiff")
            other.write_bytes(b"audio")
            self.url(self.index(other, ext="aiff", acodec="pcm_s16be"))
            self.assertFalse(filler.exists())
            self.assertTrue(cached.exists())

        pressure("a")
        self.now = 599
        self.assertEqual(self.request("GET", url, {"Range": "bytes=0-3"})[2], b"fLaC")
        self.assertGreater(cached.stat().st_mtime, 1)
        self.now = 600
        pressure("b")
        self.assertEqual(self.request("GET", url, {"Range": "bytes=4-8"})[2], self.flac[4:9])
        # The handler closes its stream after the client can read the last byte.
        deadline = time.monotonic() + 2
        token = url.rsplit("/", 1)[1]
        while True:
            with self.media._lock:
                if self.media._tokens[token].active == 0:
                    self.now = 2 * TOKEN_TTL + 1
                    break
            if time.monotonic() >= deadline:
                self.fail("The last range did not close")
            threading.Event().wait(0.005)
        self.assertEqual(self.request("GET", url)[0], 404)
        self.assertNotIn(cached, self.converter._pins)

    def test_two_buffered_tracks_keep_their_converted_ranges_under_cache_pressure(self):
        self.converter._limit = len(self.flac) * 2
        self.enterContext(mock.patch("worldmedia_computer_convert._estimate", return_value=len(self.flac)))

        def converted(name):
            path = self.folder / (name + ".aiff")
            path.write_bytes(name.encode())
            return self.index(path, ext="aiff", acodec="pcm_s16be", duration=1800)

        first, third = converted("active"), converted("other")
        unknown = self.folder / "standby.aiff"
        unknown.write_bytes(b"no indexed duration")
        second = self.index(unknown, ext="aiff", acodec="pcm_s16be")
        # The mock converter writes 1800 seconds in the output STREAMINFO.
        stream_info = int.from_bytes(self.flac[18:26], "big")
        sample_mask = (1 << 36) - 1
        stream_info = (stream_info & ~sample_mask) | ((stream_info >> 44) * 1800)
        self.flac = self.flac[:18] + stream_info.to_bytes(8, "big") + self.flac[26:]
        active = self.url(first).rsplit("/", 1)[1]
        with self.media.open(self.folders, active) as (stream, _, _):
            self.now = 1780
            standby = self.url(second).rsplit("/", 1)[1]
            with self.media.open(self.folders, standby) as (preload, _, _):
                self.assertEqual((stream.read(4), preload.read(4)), (b"fLaC", b"fLaC"))
        self.now += 20
        # Both GETs are closed. Opening another file cannot evict either track.
        self.assertEqual(self.play(third)[0], 507)
        with self.media.open(self.folders, standby) as (promoted, _, _):
            self.assertEqual(promoted.read(4), b"fLaC")
        self.now += 1799
        os.utime(self.media._tokens[standby].converted, (1, 1))
        # The ordinary ten-minute idle lease has elapsed. Only the old track can go.
        self.url(third)
        with self.media.open(self.folders, standby) as (stream, _, _):
            self.assertEqual(stream.read(), self.flac)

    def test_inactive_converted_token_expires_when_evicted(self):
        self.converter._limit = len(self.flac)
        self.enterContext(mock.patch("worldmedia_computer_convert._estimate", return_value=len(self.flac)))
        status, payload = self.play(convert=True)
        self.assertEqual(status, 200, payload)
        url = payload["data"]["url"]
        other = self.folder / "Other.aiff"
        other.write_bytes(b"audio")
        identity = self.index(other, ext="aiff", acodec="pcm_s16be")
        self.now = 599
        status, payload = self.play(identity)
        self.assertEqual((status, payload["error"]["code"]), (507, "COMPUTER_CONVERT_DISK"))
        self.now = 600
        self.url(identity)
        status, _, body = self.request("GET", url)
        self.assertEqual((status, json.loads(body)["error"]["code"]), (404, "COMPUTER_MEDIA_EXPIRED"))
        self.now = 1200
        status, payload = self.play(convert=True)
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.request("GET", url)[0], 404)
        self.assertEqual(self.request("GET", payload["data"]["url"])[2], self.flac)

    def test_standby_fixed_expiry_keep_and_per_session_conversion_leases(self):
        def standby():
            status, payload = self.play(standby=True, convert=True)
            self.assertEqual(status, 200, payload)
            return payload["data"]["url"]
        expired = standby()
        self.now = 119
        self.assertEqual(self.request("GET", expired, {"Range": "bytes=0-1"})[0], 206)
        self.now = 120
        self.assertEqual(self.request("POST", expired + "/keep", self.mutation)[0], 204)
        self.assertEqual(self.request("GET", expired)[0], 404)
        self.assertFalse(self.converter._leases)
        promoted, discarded = standby(), standby()
        self.now += 119
        self.assertEqual(self.request("POST", promoted + "/keep", self.mutation)[0], 204)
        self.assertEqual(self.request("POST", discarded + "/release", self.mutation)[0], 204)
        self.now += 120
        self.assertEqual(self.request("GET", discarded)[0], 404)
        self.assertEqual(self.request("GET", promoted)[2], self.flac)
        self.assertEqual(self.request("POST", promoted + "/release", self.mutation)[0], 204)
        self.assertFalse(self.converter._leases)

    def test_start_header_promotes_only_a_later_range(self):
        early, late = [self.play(standby=True)[1]["data"]["url"] for _ in range(2)]
        headers = {"X-Computer-Start": "1", "Range": "bytes=0-0"}
        self.assertEqual(self.request("GET", early, headers)[0], 206)
        self.now += 1
        self.assertEqual(self.request("GET", late, headers)[0], 206)
        self.now = 120
        self.assertEqual(self.request("GET", early)[0], 404)
        self.assertEqual(self.request("GET", late)[0], 200)

    def test_releasing_thirty_converted_standbys_reclaims_one_file_cache(self):
        self.converter._limit = len(self.flac)
        self.enterContext(mock.patch("worldmedia_computer_convert._estimate", return_value=len(self.flac)))
        for i in range(31):
            path = self.folder / f"{i}.aiff"
            path.write_bytes(b"track")
            status, payload = self.play(self.index(path, ext="aiff", acodec="pcm_s16be"), standby=i < 30)
            self.assertEqual(status, 200, payload)
            url = payload["data"]["url"]
            if i < 30:
                self.assertEqual(self.request("POST", url + "/release", self.mutation)[0], 204)
        self.assertEqual(self.request("GET", url)[2], self.flac)
        unknown = "/api/v1/computer/media/" + "0" * 64
        for action in ("release", "keep"):
            self.assertEqual(self.request("POST", unknown + "/" + action, self.mutation)[0], 204)

    def test_file_replaced_during_job_converts_new_fingerprint(self):
        source = self.folder / "Changing.aiff"
        source.write_bytes(b"original")
        identity = self.index(source, ext="aiff", acodec="pcm_s16be")
        entered, release = threading.Event(), threading.Event()
        finished_parts = []

        def convert(command, **kwargs):
            finished_parts.append(command[-1])
            if len(finished_parts) == 1:
                entered.set()
                self.assertTrue(release.wait(3))
            return self.convert_to_flac(command, **kwargs)

        fresh = {"kind": "audio", "acodec": "pcm_s24be", "container": "aiff", "bits": 24,
                 "sample_rate": 48000, "duration": 1, "channels": 2}
        self.convert_runner.side_effect = convert
        with (mock.patch.object(self.folders.library, "play_properties", return_value=fresh) as probe,
              ThreadPoolExecutor(2) as workers):
            first = workers.submit(self.play, identity)
            try:
                self.assertTrue(entered.wait(2))
                source.write_bytes(b"replaced source")
                second = workers.submit(self.play, identity)
            finally:
                release.set()
            self.assertEqual(first.result(4)[0], 404)
            status, result = second.result(4)
        probe.assert_called_once()
        self.assertEqual(status, 200, result)
        self.assertEqual(len(finished_parts), 2)
        self.assertEqual(len(list(self.converter.cache.iterdir())), 1)
        self.assertEqual(self.request("GET", result["data"]["url"])[2], self.flac)

    def test_convert_error_uses_control_envelope(self):
        source = self.folder / "broken.aiff"
        source.write_bytes(b"broken data")
        identity = self.index(source, ext="aiff", acodec="pcm_s16be")
        self.convert_runner.side_effect = None
        self.convert_runner.return_value = False
        status, payload = self.play(identity)
        self.assertEqual(status, 422)
        self.assertEqual(payload["error"]["code"], "COMPUTER_CONVERT_FAILED")
        self.assertEqual(payload["error"]["message"], "This file could not be converted.")
        self.assertIs(payload["error"]["retryable"], False)

    def test_folder_removal_cancels_conversion(self):
        source = self.folder / "slow.aiff"
        source.write_bytes(b"fake audio")
        identity = self.index(source, ext="aiff", acodec="pcm_s16be")
        started = threading.Event()
        stopped = threading.Event()

        def wait_for_cancel(command, *, cancelled, **_):
            self.convert_to_flac(command)
            started.set()
            for _ in range(200):
                if cancelled():
                    stopped.set()
                    break
                stopped.wait(0.02)
            return False

        self.convert_runner.side_effect = wait_for_cancel
        with ThreadPoolExecutor(1) as executor:
            playback = executor.submit(self.play, identity)
            self.assertTrue(started.wait(4))
            status, _, _ = self.request("POST", "/api/v1/computer/folders/remove", self.mutation,
                                        json.dumps({"id": self.saved["id"]}))
            self.assertEqual(status, 200)
            self.assertEqual(playback.result(4)[0], 404)
        self.assertTrue(stopped.is_set())
        self.assertEqual(list(self.converter.cache.iterdir()), [])

    def test_direct_range_refuses_replaced_source(self):
        url = self.url()
        self.assertEqual(self.request("GET", url, {"Range": "bytes=1-2"})[0], 206)
        replacement = self.track.with_suffix(".tmp")
        replacement.write_bytes(self.data + b"replacement")
        os.replace(replacement, self.track)
        status, _, body = self.request("GET", url, {"Range": "bytes=3-"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"]["code"], "COMPUTER_FILE_GONE")
        self.index(self.track)
        self.assertEqual(self.request("GET", self.url(), {"Range": "bytes=3-"})[0], 206)

    def test_tokens_expire_twelve_hours_after_the_last_use(self):
        used = self.url()
        unused = self.url()
        self.now = TOKEN_TTL - 1
        with self.media.open(self.folders, used.split("/")[-1]) as (handle, _, _):
            self.assertEqual(handle.read(), self.data)
        self.now = TOKEN_TTL
        self.assertEqual(self.request("GET", unused)[0], 404)
        self.now = TOKEN_TTL * 2 - 1
        self.assertEqual(self.request("GET", used)[0], 404)

    def test_cap_evicts_least_recently_used_and_preserves_active_tokens(self):
        self.assertEqual(MAX_TOKENS, 64)
        urls = [self.media.register(self.folders, self.identity)["url"] for _ in range(64)]
        self.assertEqual(self.request("HEAD", urls[0])[0], 200)
        with self.media.open(self.folders, urls[1].split("/")[-1]):
            self.url()
            self.assertEqual(self.request("HEAD", urls[2])[0], 404)
            self.assertEqual(self.request("HEAD", urls[1])[0], 200)
        self.assertEqual(self.request("HEAD", urls[0])[0], 200)
        self.assertEqual(len(self.media._tokens), 64)

    def test_play_refusals_and_rechecks_after_removal(self):
        url = self.url()
        self.assertEqual(self.play("a" * 24)[0], 404)
        self.assertEqual(self.play("not-an-id")[0], 404)
        self.assertEqual(self.play(headers={"Content-Type": "application/json", "Origin": self.origin})[0], 403)
        self.assertEqual(self.play(headers={**self.mutation, "Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.play(headers={**self.mutation, "Host": "example.com"})[0], 403)
        self.assertEqual(self.play(headers=self.auth)[0], 403)
        self.track.unlink()
        status, payload = self.play()
        self.assertEqual((status, payload["error"]["message"]), (404, "That file is no longer there."))
        self.assertEqual(self.request("GET", url)[0], 404)
        self.folder.rmdir()
        status, payload = self.play()
        self.assertEqual((status, payload["error"]["message"]), (409, "That folder is not connected."))
        self.folder.mkdir()
        self.track.write_bytes(self.data)
        self.assertEqual(self.request("GET", url)[0], 404)
        self.index(self.track)
        url = self.url()
        self.assertEqual(self.request("GET", url)[0], 200)
        self.folders.remove(self.saved["id"])
        self.assertEqual(self.request("GET", url)[0], 404)
        self.assertEqual(self.play()[0], 404)

    def test_media_range_forms_and_head(self):
        url = self.url()
        cases = (
            (None, 200, None, self.data),
            ("bytes=2-5", 206, "bytes 2-5/10", self.data[2:6]),
            ("bytes=8-", 206, "bytes 8-9/10", self.data[8:]),
            ("bytes=-3", 206, "bytes 7-9/10", self.data[7:]),
            ("bytes=9-100", 206, "bytes 9-9/10", self.data[9:]),
            ("bytes=-100", 206, "bytes 0-9/10", self.data),
            ("bytes=10-", 416, "bytes */10", b""),
            ("bytes=5-4", 416, "bytes */10", b""),
            ("bytes=-0", 416, "bytes */10", b""),
            ("bytes=0-1,4-5", 200, None, self.data),
            ("bytes=one-two", 200, None, self.data),
            ("items=1-2", 200, None, self.data),
            ("bytes=-", 200, None, self.data),
        )
        for header, expected, content_range, data in cases:
            with self.subTest(range=header):
                headers = {} if header is None else {"Range": header}
                status, response, body = self.request("GET", url, headers)
                self.assertEqual((status, response.get("Content-Range")), (expected, content_range))
                self.assertEqual(response["Content-Length"], str(len(data)))
                self.assertEqual(body, data)
                status, response, body = self.request("HEAD", url, headers)
                self.assertEqual((status, response.get("Content-Range"), body), (200, None, b""))
                self.assertEqual(response["Content-Length"], str(len(self.data)))
        status, _, body = self.request("GET", url, [("Range", "bytes=0-1"), ("Range", "bytes=4-5")])
        self.assertEqual((status, body), (200, self.data))
        self.track.write_bytes(b"")
        self.assertEqual(self.request("GET", url, {"Range": "bytes=0-"})[0], 404)
        self.assertEqual(media_range(["bytes=0-"], 0), (416, 0, 0))
        self.assertEqual(media_range([], 0), (200, 0, 0))

    def test_media_headers_host_origin_and_redacted_log(self):
        url = self.url()
        status, response, body = self.request("GET", url, {"Origin": self.origin})
        self.assertEqual((status, body), (200, self.data))
        for name, value in {"Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'"}.items():
            self.assertEqual(response[name], value)
        self.assertNotIn("Access-Control-Allow-Origin", response)
        log = io.StringIO()
        with mock.patch.object(worldmedia_server.sys, "stderr", log):
            for headers in ({"Host": "example.com"}, {"Origin": "https://example.com"}):
                self.assertEqual(self.request("GET", url, headers)[0], 403)
            self.assertEqual(self.request("POST", url)[0], 405)
            self.assertEqual(self.request("GET", url + "?x=1")[0], 400)
        self.assertIn("/api/v1/computer/media/<redacted>", log.getvalue())
        self.assertNotIn(url.split("/")[-1], log.getvalue())
        self.assertNotIn(self.folder.name, log.getvalue())
        self.assertNotIn(self.track.name, log.getvalue())

    def test_non_ascii_headers_get_normal_errors(self):
        media_url = self.url()
        art_url = "/api/v1/computer/art/" + self.identity
        cases = (
            (media_url, {"Origin": self.origin + "\u00a0"}, 403, "INVALID_ORIGIN"),
            (media_url, {"Host": f"127.0.0.1:{self.port}\u00a0"}, 403, "INVALID_HOST"),
            (media_url, {"Range": "bytes=\xe9-"}, 400, "INVALID_RANGE"),
            (art_url, {**self.auth, "Origin": "\xe9"}, 403, "INVALID_ORIGIN"),
            (art_url, {"X-WorldMedia-Token": "\xe9"}, 403, "INVALID_TOKEN"),
            (art_url, {**self.auth, "If-None-Match": '"\xe9"'}, 400, "INVALID_VALIDATOR"),
        )
        for url, headers, expected_status, code in cases:
            with self.subTest(header=list(headers)[-1]):
                status, _, body = self.request("GET", url, headers)
                self.assertEqual((status, json.loads(body)["error"]["code"]), (expected_status, code))

    def test_unexpected_failures_are_logged_and_return_closed_500_responses(self):
        media_url = self.url()
        art_url = "/api/v1/computer/art/" + self.identity
        log = io.StringIO()
        with mock.patch.object(worldmedia_server.sys, "stderr", log):
            for url, headers, service, operation in (
                (art_url, self.auth, self.art, "read"), (media_url, {}, self.media, "open"),
            ):
                with self.subTest(operation=operation), mock.patch.object(
                    service, operation, side_effect=RuntimeError("private details\nsecond line")
                ):
                    status, response, body = self.request("GET", url, headers)
                    self.assertEqual((status, response["Connection"]), (500, "close"))
                    self.assertEqual(json.loads(body)["error"]["code"], "INTERNAL_ERROR")
        self.assertEqual([line.split("message=")[1] for line in log.getvalue().splitlines() if "message=" in line],
                         ["computer picture failure type=RuntimeError", "computer media failure type=RuntimeError"])
        self.assertNotIn("private details", log.getvalue())
        self.assertNotIn("Traceback", log.getvalue())

    def test_unexpected_media_failure_during_write_closes_started_response(self):
        url = self.url()

        @contextmanager
        def failing_file(*_):
            handle = mock.Mock()
            handle.read.side_effect = RuntimeError
            yield handle, 20, "audio/wav"

        log = io.StringIO()
        with mock.patch.object(worldmedia_server.sys, "stderr", log), mock.patch.object(
            self.media, "open", failing_file
        ):
            with self.assertRaises(http.client.IncompleteRead):
                self.request("GET", url)
        self.assertIn("computer media failure type=RuntimeError", log.getvalue())
        self.assertNotIn("Traceback", log.getvalue())

    def test_five_chunks_stream_in_order_and_file_is_shared_for_reading(self):
        self.assertEqual(MEDIA_CHUNK_SIZE, 256 * 1024)
        data = b"".join(bytes([index]) * MEDIA_CHUNK_SIZE for index in range(5))
        self.track.write_bytes(data)
        url = self.url()
        with self.track.open("rb") as other_handle:
            self.assertEqual(other_handle.read(1), b"\0")
            self.assertEqual(self.request("GET", url)[2], data)
        start, end = MEDIA_CHUNK_SIZE - 3, 4 * MEDIA_CHUNK_SIZE + 7
        status, _, body = self.request("GET", url, {"Range": f"bytes={start}-{end}"})
        self.assertEqual((status, body), (206, data[start:end + 1]))

    def test_media_file_shrinking_ends_the_connection(self):
        url = self.url()

        @contextmanager
        def changed_file(*_):
            yield io.BytesIO(b"short"), 20, "audio/wav"

        with mock.patch.object(self.media, "open", changed_file):
            with self.assertRaises(http.client.IncompleteRead) as error:
                self.request("GET", url)
        self.assertEqual(error.exception.partial, b"short")

    def test_media_client_disconnect_ends_the_request_quietly(self):
        token = self.url().split("/")[-1]
        handler = object.__new__(worldmedia_server.WorldMediaHandler)
        handler.headers = Message()
        handler.headers["Host"] = f"127.0.0.1:{self.port}"
        handler.server = SimpleNamespace(server_port=self.port)
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        handler.connection = mock.Mock()
        handler.wfile = mock.Mock()
        handler.wfile.write.side_effect = BrokenPipeError
        handler._send_api_error = mock.Mock()
        handler._handle_computer_media("GET", token, "")
        self.assertTrue(handler.close_connection)
        handler.connection.shutdown.assert_called_once()
        handler._send_api_error.assert_not_called()
        self.assertEqual(self.media._tokens[token].active, 0)

    @unittest.skipUnless(os.name == "nt", "Extended Windows paths are platform-specific.")
    def test_long_unicode_media_path(self):
        path = self.folder / ("é" * 100) / ("文" * 100) / "Sample 🎵.wav"
        disk_path = Path(_absolute_disk_path(str(path)))
        disk_path.parent.mkdir(parents=True)
        disk_path.write_bytes(self.data)
        self.addCleanup(disk_path.parent.parent.rmdir)
        self.addCleanup(disk_path.parent.rmdir)
        self.addCleanup(disk_path.unlink)
        self.assertGreater(len(str(path)), 260)
        self.assertEqual(self.request("GET", self.url(self.index(path)))[2], self.data)

    def test_link_outside_saved_roots_is_refused_for_media_and_art(self):
        external = self.root / "external"
        external.mkdir()
        (external / "track.wav").write_bytes(b"private")
        (external / "cover.png").write_bytes(b"private")
        link = self.folder / "link"
        link.mkdir()
        linked_track = link / "track.wav"
        linked_track.write_bytes(b"public")
        identity = self.index(linked_track)
        active = self.url(identity)
        linked_track.unlink()
        link.rmdir()
        try:
            link_directory(link, external)
        except OSError as error:
            self.skipTest(f"Directory links are unavailable: {error}")
        self.addCleanup(link.rmdir if os.name == "nt" else link.unlink)
        self.assertEqual(self.play(identity)[0], 404)
        self.assertEqual(self.request("GET", active)[0], 404)
        self.assertEqual(self.request("GET", "/api/v1/computer/art/" + identity, self.auth)[0], 404)
        self.index(self.track, art={"file": "link/cover.png"})
        self.assertEqual(self.request("GET", "/api/v1/computer/art/" + self.identity, self.auth)[0], 404)
        self.ffmpeg.assert_not_called()

    def test_art_auth_status_etag_headers_and_head(self):
        path = self.folder / "cover.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        self.index(self.track, art={"file": path.name})
        route = "/api/v1/computer/art/" + self.identity
        for headers in ({}, {**self.auth, "Host": "example.com"}, {**self.auth, "Origin": "https://example.com"}):
            self.assertEqual(self.request("GET", route, headers)[0], 403)
        self.assertEqual(self.request("POST", route, self.auth)[0], 405)
        self.assertEqual(self.request("GET", route + "?size=small", self.auth)[0], 400)
        for identity in ("g" * 24, "a" * 23, "b" * 24):
            status, _, body = self.request("GET", "/api/v1/computer/art/" + identity, self.auth)
            self.assertEqual((status, json.loads(body)["error"]["code"]), (404, "COMPUTER_ART_NOT_FOUND"))
        self.ffmpeg.assert_not_called()
        status, headers, data = self.request("GET", route, {**self.auth, "Origin": self.origin})
        self.assertEqual((status, data), (200, b"\xff\xd8\xff\xd9"))
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "private, max-age=86400")
        etag = headers["ETag"]
        self.assertRegex(etag, r'^"[0-9a-f]{64}"$')
        status, head, body = self.request("HEAD", route, self.auth)
        self.assertEqual((status, head["ETag"], head["Content-Length"], body), (200, etag, "4", b""))
        for tag in (etag, "*", '"different", W/' + etag):
            status, headers, body = self.request("GET", route, {**self.auth, "If-None-Match": tag})
            self.assertEqual((status, headers["ETag"], body), (304, etag, b""))
            self.assertEqual(headers["Cache-Control"], "private, max-age=86400")
        self.ffmpeg.assert_called_once()
        self.assertEqual(self.request("HEAD", route + "?size=large", self.auth)[0], 200)
        self.assertEqual(self.ffmpeg.call_count, 2)


class ComputerMediaFormatTests(unittest.TestCase):
    def test_all_mime_extensions(self):
        cases = {
            "audio/mpeg": "mp3 mp2", "audio/mp4": "m4a m4b", "audio/aac": "aac", "audio/flac": "flac",
            "audio/wav": "wav", "audio/aiff": "aiff aif", "audio/ogg": "ogg oga opus", "audio/x-ms-wma": "wma",
            "audio/x-matroska": "mka", "video/mp4": "mp4 m4v", "video/quicktime": "mov", "video/webm": "webm",
            "video/x-matroska": "mkv", "video/x-msvideo": "avi", "video/x-ms-wmv": "wmv",
            "video/mpeg": "mpg mpeg vob", "video/mp2t": "ts m2ts mts", "video/x-flv": "flv", "video/ogg": "ogv",
            "video/3gpp": "3gp", "application/octet-stream": "ape dsf unknown",
        }
        for mime, extensions in cases.items():
            for ext in extensions.split():
                with self.subTest(ext=ext):
                    self.assertEqual(media_mime({"kind": mime.partition("/")[0], "ext": ext.upper()}), mime)

    def test_probed_container_and_kind_override_extension(self):
        cases = (
            ("audio", "flac", "mp3", "audio/flac"),
            ("audio", "asf", "wmv", "audio/x-ms-wma"),
            ("video", "asf", "wma", "video/x-ms-wmv"),
            ("audio", "ogg", "ogv", "audio/ogg"),
            ("video", "ogg", "oga", "video/ogg"),
            ("audio", "mov,mp4,m4a,3gp,3g2,mj2", "mp4", "audio/mp4"),
            ("video", "mov,mp4,m4a,3gp,3g2,mj2", "mp4", "video/mp4"),
            ("video", "mov,mp4,m4a,3gp,3g2,mj2", "mov", "video/quicktime"),
            ("video", "mov,mp4,m4a,3gp,3g2,mj2", "3gp", "video/3gpp"),
            ("video", "matroska,webm", "webm", "video/webm"),
            ("video", "matroska,webm", "mkv", "video/x-matroska"),
            ("audio", "matroska,webm", "mka", "audio/x-matroska"),
            ("audio", "matroska,webm", "webm", "audio/webm"),
            ("audio", "", "webm", "audio/webm"),
            ("audio", "", "mp4", "audio/mp4"),
        )
        for kind, container, ext, mime in cases:
            with self.subTest(kind=kind, container=container, ext=ext):
                self.assertEqual(media_mime({"kind": kind, "container": container, "ext": ext}), mime)

    def test_range_arithmetic_with_large_offsets_and_long_numbers(self):
        large = 3 * 1024**3
        self.assertEqual(media_range(["bytes=3000000000-3000000005"], large), (206, 3_000_000_000, 6))
        digits = "9" * 10_000
        self.assertEqual(media_range(["bytes=" + digits + "-"], 10), (416, 0, 0))
        self.assertEqual(media_range(["bytes=2-" + digits], 10), (206, 2, 8))
        self.assertEqual(media_range(["bytes=-" + digits], 10), (206, 0, 10))
