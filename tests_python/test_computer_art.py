from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
import wave
import zlib

from worldmedia_computer import ComputerFolders
from worldmedia_computer_art import ART_TIMEOUT, FAILURE_TTL, MAX_WAITING, ComputerArt, _run_ffmpeg
from worldmedia_computer_library import _file_id
from worldmedia_computer_probe import probe_fields
from worldmedia_security import ApiError


JPEG = b"\xff\xd8\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n"
FFMPEG = shutil.which("ffmpeg")


def write_png(path, width, height):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = (b"\0" + b"\x00\x80\xff" * width) * height
    path.write_bytes(PNG + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def jpeg_dimensions(data):
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("Missing JPEG signature.")
    offset = 2
    while data[offset:offset + 1] == b"\xff":
        marker = data[offset + 1]
        if marker in (0xc0, 0xc1, 0xc2):
            height, width = struct.unpack_from(">HH", data, offset + 5)
            return width, height
        offset += 2 + struct.unpack_from(">H", data, offset + 2)[0]
    raise ValueError("Missing JPEG dimensions.")


class ComputerArtTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.media = self.root / "media"
        self.media.mkdir()
        self.cache = self.root / "cache" / "computer-art"
        self.folders = ComputerFolders(self.root / "state" / "computer-folders.json")
        self.folder = self.folders.add(str(self.media))
        self.song = self.media / "Song.wav"
        self.song.write_bytes(b"audio")
        self.cover = self.media / "Cover.png"
        self.cover.write_bytes(PNG)
        self.now = 0.0
        self.runner = mock.Mock(side_effect=self.render)
        self.art = self.service()

    def service(self, *, ffmpeg="ffmpeg", runner=None):
        art = ComputerArt(self.cache, ffmpeg=lambda: ffmpeg, runner=runner or self.runner, clock=lambda: self.now)
        self.addCleanup(art.shutdown)
        return art

    def item(self, path=None, **fields):
        path = path or self.song
        identity = _file_id(str(path))
        info = path.stat()
        entry = {"id": identity, "folder": self.folder["id"], "rel": path.relative_to(self.media).as_posix(),
                 "size": info.st_size, "mtime": info.st_mtime_ns, "kind": "audio", **fields}
        self.folders.library.load()
        with self.folders.library._lock:
            self.folders.library._items[identity] = entry
        return identity

    @staticmethod
    def render(command, *, timeout, cancelled):
        data = Path(command[command.index("-i") + 1]).read_bytes()
        Path(command[-1]).write_bytes(JPEG + data)
        return True

    def read(self, identity, **kwargs):
        return self.art.read(self.folders, identity, **kwargs)

    def assert_missing(self, identity):
        with self.assertRaises(ApiError) as error:
            self.read(identity)
        self.assertEqual((error.exception.status, error.exception.code), (404, "COMPUTER_ART_NOT_FOUND"))

    def test_sidecar_cover_then_video_frame_and_ffmpeg_arguments(self):
        identity = self.item(art={"file": self.cover.name}, has_cover=True, cover_stream=2, kind="video", duration=90)
        self.assertEqual(self.read(identity)[0], JPEG + PNG)
        self.cover.unlink()
        self.assertEqual(self.read(identity)[0], JPEG + b"audio")

        def read_frame(command, **kwargs):
            return False if "[cover]" in command else self.render(command, **kwargs)

        self.item(has_cover=True, kind="video", duration=90)
        self.runner.side_effect = read_frame
        self.assertEqual(self.read(identity, large=True)[0], JPEG + b"audio")
        sidecar, cover, bad_cover, frame = [call.args[0] for call in self.runner.call_args_list]
        self.assertIn("0:v:0", sidecar)
        self.assertEqual(cover[cover.index("-map") + 1], "0:2")
        self.assertEqual(bad_cover[bad_cover.index("-map") + 1], "[cover]")
        self.assertLess(bad_cover.index("-discard:V"), bad_cover.index("-i"))
        self.assertEqual(frame[frame.index("-map") + 1], "0:V:0")
        self.assertLess(frame.index("-ss"), frame.index("-i"))
        self.assertEqual(float(frame[frame.index("-ss") + 1]), 9)
        for command in (sidecar, cover, frame):
            self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file")
            inputs = command[:command.index("-i")]
            if command is sidecar:
                self.assertEqual(inputs[inputs.index("-f") + 1], "png_pipe")
            else:
                self.assertNotIn("-f", inputs)
            self.assertEqual(command[command.index("-frames:v") + 1], "1")
            self.assertEqual(command[command.index("-q:v") + 1], "3")
            self.assertIn("-an", command)
            self.assertIn("-sn", command)
            self.assertEqual(Path(command[-1]).parent, self.cache)
        self.assertIn("min(iw,480)", sidecar[sidecar.index("-vf") + 1])
        self.assertIn("min(iw,1200)", frame[frame.index("-vf") + 1])
        self.assertEqual([call.kwargs["timeout"] for call in self.runner.call_args_list], [ART_TIMEOUT] * 4)
        self.assertEqual(list(self.cache.glob("thumb-*")), [])

    def test_probe_records_the_first_attached_picture_stream(self):
        streams = [{"index": 0, "codec_type": "video"}, {"index": 1, "codec_type": "audio"}]
        streams.extend({"index": number, "codec_type": "video", "disposition": {"attached_pic": 1}}
                       for number in (2, 3))
        entry = probe_fields({"streams": streams}, "Movie.mp4", "Media")
        self.assertTrue(entry["has_cover"])
        self.assertEqual(entry["cover_stream"], 2)
        self.assertEqual(entry["kind"], "video")

    def test_changed_media_does_not_reuse_the_indexed_cover_stream_number(self):
        identity = self.item(has_cover=True, cover_stream=2)
        self.song.write_bytes(b"different file")
        self.read(identity)
        command = self.runner.call_args.args[0]
        self.assertEqual(command[command.index("-map") + 1], "[cover]")

    def test_short_unknown_and_minimum_seek_times(self):
        for duration, expected in ((None, 0), (2, 1.96), (5.01, 5), (20, 5)):
            with self.subTest(duration=duration):
                self.song.write_bytes(str(duration).encode())
                self.read(self.item(kind="video", duration=duration))
                command = self.runner.call_args.args[0]
                self.assertAlmostEqual(float(command[command.index("-ss") + 1]), expected)

    def test_no_picture_or_allowed_media(self):
        self.assert_missing("f" * 24)
        self.assert_missing("not-an-id")
        self.assert_missing(self.item())
        self.assert_missing(self.item(art={"file": "../Cover.png"}))
        self.assert_missing(self.item(art={"file": "missing.png"}))
        directory = self.media / "Directory.png"
        directory.mkdir()
        self.assert_missing(self.item(art={"file": directory.name}))
        identity = self.item(art={"file": self.cover.name})
        self.song.unlink()
        self.assert_missing(identity)
        self.song.mkdir()
        self.assert_missing(identity)
        self.song.rmdir()
        self.song.write_bytes(b"audio")
        self.folders.remove(self.folder["id"])
        self.assert_missing(identity)
        self.runner.assert_not_called()

    def test_ffmpeg_sidecar_format_comes_from_magic_bytes(self):
        identity = self.item(art={"file": self.cover.name})
        for data, demuxer in ((JPEG, "jpeg_pipe"), (PNG, "png_pipe"),
                              (b"RIFF\x00\x00\x00\x00WEBP", "webp_pipe")):
            with self.subTest(demuxer=demuxer):
                self.cover.write_bytes(data)
                self.assertEqual(self.read(identity)[0], JPEG + data)
                command = self.runner.call_args.args[0]
                self.assertEqual(command[command.index("-f") + 1], demuxer)
                self.assertEqual(command[command.index("-format_whitelist") + 1], demuxer)
        self.cover.write_bytes(b"<svg/>")
        self.assert_missing(identity)
        self.assertEqual(self.runner.call_count, 3)

    def test_passthrough_checks_magic_and_size_when_ffmpeg_is_unavailable(self):
        self.art = self.service(ffmpeg=None)
        identity = self.item(art={"file": self.cover.name}, has_cover=True, kind="video")
        for data, mime in ((JPEG, "image/jpeg"), (PNG, "image/png"), (b"RIFF\x00\x00\x00\x00WEBP", "image/webp")):
            with self.subTest(mime=mime):
                self.cover.write_bytes(data)
                self.assertEqual(self.read(identity, large=True)[:2], (data, mime))
        self.cover.write_bytes(b"<svg/>")
        self.assert_missing(identity)
        with self.cover.open("wb") as handle:
            handle.write(PNG)
            handle.truncate(6 * 1024 * 1024 + 1)
        self.assert_missing(identity)
        self.assert_missing(self.item(has_cover=True))
        self.assert_missing(self.item(kind="video"))
        self.runner.assert_not_called()

    def test_cache_key_uses_source_size_mtime_and_output_size(self):
        identity = self.item(art={"file": self.cover.name})
        first = self.read(identity)
        self.assertEqual(self.read(identity), first)
        self.runner.assert_called_once()
        self.read(identity, large=True)
        original = self.cover.stat()
        self.cover.write_bytes(PNG + b"!")
        os.utime(self.cover, ns=(original.st_atime_ns, original.st_mtime_ns))
        self.assertNotEqual(self.read(identity)[2], first[2])
        os.utime(self.cover, ns=(original.st_atime_ns, original.st_mtime_ns + 1_000_000_000))
        self.read(identity)
        second_cover = self.media / "Another.png"
        second_cover.write_bytes(self.cover.read_bytes())
        os.utime(second_cover, ns=(original.st_atime_ns, self.cover.stat().st_mtime_ns))
        self.item(art={"file": second_cover.name})
        self.read(identity)
        self.assertEqual(self.runner.call_count, 5)
        self.assertEqual(len(list(self.cache.glob("*.jpg"))), 5)

    def test_cache_key_uses_the_current_cover_stream_and_frame_time(self):
        for fields, option, expected in (
            ({"has_cover": True, "cover_stream": 1}, "-map", "0:1"),
            ({"has_cover": True, "cover_stream": 2}, "-map", "0:2"),
            ({"kind": "video", "duration": 50}, "-ss", "5.000000"),
            ({"kind": "video", "duration": 90}, "-ss", "9.000000"),
            ({"kind": "video", "duration": 2, "fps": 25}, "-ss", "1.960000"),
            ({"kind": "video", "duration": 2, "fps": 50}, "-ss", "1.980000"),
        ):
            with self.subTest(fields=fields):
                self.runner.reset_mock()
                self.read(self.item(**fields))
                self.runner.assert_called_once()
                command = self.runner.call_args.args[0]
                self.assertEqual(command[command.index(option) + 1], expected)

    def test_rendered_picture_is_returned_when_cache_replace_fails(self):
        identity = self.item(art={"file": self.cover.name})
        with mock.patch("worldmedia_computer_art.os.replace", side_effect=PermissionError) as replace:
            self.assertEqual(self.read(identity)[0], JPEG + PNG)
            replace.assert_called_once()
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertEqual(self.read(identity)[0], JPEG + PNG)
        self.assertEqual(self.runner.call_count, 2)
        self.assertEqual(len(list(self.cache.glob("*.jpg"))), 1)

    def test_picture_is_rendered_uncached_when_cache_cannot_be_written(self):
        identity = self.item(art={"file": self.cover.name})
        self.cache.parent.mkdir()
        self.cache.touch()
        self.assertEqual(self.read(identity)[0], JPEG + PNG)
        self.cache.unlink()
        self.cache.mkdir()
        mkstemp = tempfile.mkstemp

        def read_only_cache(**kwargs):
            if kwargs.get("dir") == self.cache:
                raise PermissionError
            return mkstemp(**kwargs)

        with mock.patch("worldmedia_computer_art.tempfile.mkstemp", side_effect=read_only_cache):
            self.assertEqual(self.read(identity)[0], JPEG + PNG)
        self.assertEqual(self.runner.call_count, 2)
        for call in self.runner.call_args_list:
            temporary = Path(call.args[0][-1])
            self.assertEqual(temporary.parent, Path(tempfile.gettempdir()))
            self.assertFalse(temporary.exists())
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_failed_ffmpeg_is_remembered_for_ten_minutes(self):
        identity = self.item(has_cover=True)
        self.runner.return_value = False
        self.runner.side_effect = None
        self.assert_missing(identity)
        self.now += FAILURE_TTL - 1
        self.assert_missing(identity)
        self.runner.assert_called_once()
        self.now += 1
        self.assert_missing(identity)
        self.assertEqual(self.runner.call_count, 2)
        self.song.write_bytes(b"changed")
        self.assert_missing(identity)
        self.assertEqual(self.runner.call_count, 3)

    def test_cache_is_trimmed_off_thread_in_least_recently_used_order(self):
        self.cache.mkdir(parents=True)
        paths = [self.cache / (character * 64 + ".jpg") for character in "abc"]
        for index, path in enumerate(paths):
            path.write_bytes((JPEG * 4)[:15])
            os.utime(path, (index + 1, index + 1))
        unrelated = self.cache / "untouched.jpg"
        unrelated.write_bytes(b"untouched")
        with mock.patch("worldmedia_computer_art.CACHE_LIMIT", 40), mock.patch("worldmedia_computer_art.CACHE_TARGET", 32):
            trimmed = threading.Event()
            caller = threading.current_thread()
            trim = self.art._trim_cache

            def observe_trim():
                self.assertIsNot(threading.current_thread(), caller)
                trim()
                trimmed.set()

            with mock.patch.object(self.art, "_trim_cache", side_effect=observe_trim) as observed:
                self.art._cached(paths[0])  # Reading changes the oldest entry to the newest.
                self.assertTrue(trimmed.wait(3))
                self.assertTrue(paths[0].exists())
                self.assertFalse(paths[1].exists())
                self.assertTrue(paths[2].exists())
                self.assertTrue(unrelated.exists())
                self.art._schedule_trim()
                observed.assert_called_once()
                self.now += 60
                trimmed.clear()
                self.art._schedule_trim()
                self.assertTrue(trimmed.wait(3))
                self.assertEqual(observed.call_count, 2)

    def test_two_jobs_bounded_queue_and_disconnected_waiter(self):
        self.assertEqual(MAX_WAITING, 200)
        identity = self.item(art={"file": self.cover.name}, has_cover=True)
        other = self.media / "Other.wav"
        other.write_bytes(b"other")
        second_identity = self.item(other, has_cover=True)
        started = threading.Barrier(3)
        release = threading.Event()
        gone = threading.Event()

        def blocked_render(command, **kwargs):
            if "0:v:0" in command:
                started.wait(4)
                self.assertTrue(release.wait(4))
            return self.render(command, **kwargs)

        self.runner.side_effect = blocked_render
        # A smaller limit exercises the same overflow branch without creating 200 threads.
        # Two running jobs here too (the app runs four): the test fills exactly two slots.
        with (mock.patch("worldmedia_computer_art.MAX_WAITING", 2),
              mock.patch("worldmedia_computer_art.MAX_RUNNING", 2),
              ThreadPoolExecutor(max_workers=4) as pool):
            first = pool.submit(self.read, identity)
            second = pool.submit(self.read, identity, large=True)
            try:
                started.wait(4)
                disconnected = pool.submit(self.read, second_identity, client_gone=gone.is_set)
                duplicate = pool.submit(self.read, identity)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    with self.art._condition:
                        if len(self.art._waiting) == 2:
                            break
                    time.sleep(0.01)
                else:
                    self.fail("Both requests should be waiting for a job slot.")
                with self.assertRaises(ApiError) as error:
                    self.read(second_identity, large=True)
                self.assertEqual(error.exception.status, 503)
                self.assertTrue(error.exception.retryable)
                self.assertEqual(self.runner.call_count, 2)
                gone.set()
                with self.assertRaises(ConnectionAbortedError):
                    disconnected.result(timeout=3)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=3), duplicate.result(timeout=3))
            self.assertEqual(second.result(timeout=3)[1], "image/jpeg")
            self.assertEqual(self.runner.call_count, 2)

    def test_shutdown_kills_and_reaps_an_active_ffmpeg_child(self):
        self.art = self.service(runner=_run_ffmpeg)
        identity = self.item(has_cover=True)
        launched = threading.Event()
        child = mock.MagicMock()
        child.__enter__.return_value = child
        child.poll.return_value = None
        child.stderr.read1.return_value = b""

        def wait_for_child(timeout=None):
            if timeout is None:
                return 1
            launched.set()
            self.art._cancel.wait(timeout)
            raise subprocess.TimeoutExpired("ffmpeg", timeout)

        child.wait.side_effect = wait_for_child
        with mock.patch("worldmedia_computer_art.subprocess.Popen", return_value=child) as popen:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.read, identity)
                self.assertTrue(launched.wait(3))
                self.assertTrue(self.art.shutdown(timeout=3))
                with self.assertRaises(ApiError) as error:
                    future.result(timeout=3)
                self.assertEqual(error.exception.status, 503)
            self.assertFalse(popen.call_args.kwargs["shell"])
        child.kill.assert_called_once_with()
        child.__exit__.assert_called_once()
        self.assertEqual(list(self.cache.iterdir()), [])

    @unittest.skipUnless(FFMPEG, "ffmpeg is not on PATH")
    def test_real_ffmpeg_generates_a_jpeg_without_enlarging(self):
        self.art = ComputerArt(self.cache, ffmpeg=lambda: FFMPEG)
        self.addCleanup(self.art.shutdown)
        self.song = self.media / "Canción ♫.wav"
        with wave.open(str(self.song), "wb") as track:
            track.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            track.writeframes(b"\0\0" * 400)
        self.cover = self.media / "Canción ♫.png"
        write_png(self.media / "cover0.png", 32, 32)
        write_png(self.media / "cover1.png", 32, 32)
        for path in (self.cover, self.media / "cover%d.png"):
            with self.subTest(name=path.name):
                write_png(path, 640, 32)
                identity = self.item(art={"file": path.name})
                data, mime, _ = self.read(identity)
                self.assertEqual(mime, "image/jpeg")
                self.assertEqual(jpeg_dimensions(data), (480, 24))
                self.assertEqual(jpeg_dimensions(self.read(identity, large=True)[0]), (640, 32))
