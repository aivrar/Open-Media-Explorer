"""Computer loudness measurement and queue tests."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import worldmedia_computer_loudness as loudness
from worldmedia_computer import ComputerFolders
from worldmedia_computer_media import ComputerMedia
from worldmedia_computer_video import ComputerVideo
from worldmedia_security import ApiError


FFMPEG = shutil.which("ffmpeg")


class ComputerLoudnessTests(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.music = root / "Music"
        self.music.mkdir()
        self.folders = ComputerFolders(root / "computer-folders.json")
        self.folders.add(str(self.music))
        self.addCleanup(self.folders.library.shutdown)
        video = ComputerVideo(root / "cache", ffmpeg=lambda: FFMPEG)
        self.media = ComputerMedia(video=video)
        self.addCleanup(self.media.shutdown, 3)

    def scan(self):
        scanner = self.folders.library
        scanner.start()
        deadline = time.monotonic() + 5
        while scanner.status()["scanning"]:
            if time.monotonic() >= deadline:
                self.fail("Media scan did not finish.")
            time.sleep(0.01)
        return {entry["rel"]: entry for entry in scanner.snapshot()["items"]}

    def generate(self, name, expression, duration):
        path = self.music / name
        subprocess.run([
            FFMPEG, "-nostdin", "-v", "error", "-filter_threads", "1", "-f", "lavfi",
            "-i", f"aevalsrc={expression}:s=44100:d={duration}", "-threads", "1", str(path),
        ], check=True, timeout=30, capture_output=True)
        return path

    @unittest.skipUnless(FFMPEG, "FFmpeg is required to measure generated audio.")
    def test_five_minute_flac_and_silence(self):
        self.generate("Tone.flac", "0.1*sin(2*PI*1000*t)", 300)
        self.generate("Silence.flac", "0", 2)
        entries = self.scan()
        with self.assertLogs(loudness.__name__, level="INFO") as messages:
            started = time.perf_counter()
            data = self.media.loudness(self.folders, entries["Tone.flac"]["id"])
            elapsed = time.perf_counter() - started
        self.assertAlmostEqual(data["rg_track_gain"], 5, delta=0.5)
        self.assertAlmostEqual(data["rg_track_peak"], 0.1, delta=0.001)
        self.assertIs(data["rg_measured"], True)
        self.assertEqual(len(messages.output), 1)
        self.assertRegex(messages.output[0], r"seconds=300\.00 elapsed_ms=\d+ result=measured$")
        print(f"5-minute 44.1 kHz FLAC loudness measurement: {elapsed * 1000:.0f} ms", flush=True)
        with self.assertRaises(ApiError) as error:
            self.media.loudness(self.folders, entries["Silence.flac"]["id"])
        self.assertEqual((error.exception.status, error.exception.code, error.exception.retryable),
                         (422, "COMPUTER_LOUDNESS_UNAVAILABLE", False))

    @unittest.skipUnless(FFMPEG and shutil.which("ffprobe"), "FFmpeg and ffprobe are required.")
    def test_nonfirst_default_stream_is_measured(self):
        path = self.music / "Two.mka"
        subprocess.run([FFMPEG, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc",
                        "-f", "lavfi", "-i", "sine=frequency=1000", "-map", "0:a", "-map", "1:a",
                        "-t", "2", "-c:a", "flac", "-disposition:a:0", "0", "-disposition:a:1", "default",
                        str(path)], check=True, timeout=15)
        with mock.patch.object(self.folders.library, "_ffprobe", return_value=shutil.which("ffprobe")):
            entry = self.scan()[path.name]
        self.assertGreater(self.media.loudness(self.folders, entry["id"])["rg_track_peak"], 0.1)

    def test_measurement_rejects_a_file_replaced_during_decode(self):
        from tests_python.test_computer_tags import flac

        source = self.music / "Track.flac"
        source.write_bytes(flac())
        entry = self.scan()[source.name]

        def replace(*args):
            source.write_bytes(flac("REPLAYGAIN_TRACK_GAIN=2 dB"))
            return 5.0, 0.1

        with mock.patch.object(self.media._loudness, "_ffmpeg", return_value="ffmpeg"), \
                mock.patch.object(self.media._loudness, "_runner", side_effect=replace):
            with self.assertRaises(ApiError) as error:
                self.media.loudness(self.folders, entry["id"])
        self.assertEqual((error.exception.status, error.exception.code), (404, "COMPUTER_FILE_GONE"))
        self.assertNotIn("rg_track_gain", self.folders.library.entry(entry["id"]))

    def slow_decoder(self):
        launched = threading.Event()
        children = []
        launch = loudness._launch

        def real_time(command):
            inputs = command.index("-i")
            process = launch([*command[:inputs], "-re", *command[inputs:]])
            children.append(process)
            launched.set()
            return process

        self.enterContext(mock.patch.object(loudness, "_launch", side_effect=real_time))
        return launched, children

    @unittest.skipUnless(FFMPEG, "FFmpeg is required to check disconnect cleanup.")
    def test_last_disconnect_reaps_ffmpeg_without_storing_gain(self):
        file = self.generate("Abandoned.flac", "0.1*sin(2*PI*1000*t)", 20)
        identity = self.scan()[file.name]["id"]
        launched, children = self.slow_decoder()
        gone = threading.Event()
        with ThreadPoolExecutor(1) as callers:
            response = callers.submit(self.media.loudness, self.folders, identity, gone.is_set)
            try:
                self.assertTrue(launched.wait(3))
                self.assertIsNone(children[0].poll())
            finally:
                gone.set()
            with self.assertRaises(ConnectionAbortedError):
                response.result(timeout=2)
            wait_until(lambda: children[0].poll() is not None)
            wait_until(lambda: self.media._loudness._running is None)
        self.assertNotIn("rg_track_gain", self.folders.library.entry(identity))

    @unittest.skipUnless(FFMPEG, "FFmpeg is required to check child shutdown.")
    def test_shutdown_kills_ffmpeg_and_rejects_waiting_requests(self):
        self.generate("Playing.flac", "0.1*sin(2*PI*1000*t)", 20)
        self.generate("Queued.flac", "0.1*sin(2*PI*1000*t)", 1)
        entries = self.scan()
        launched, children = self.slow_decoder()
        with ThreadPoolExecutor(max_workers=2) as callers:
            running = callers.submit(self.media.loudness, self.folders, entries["Playing.flac"]["id"])
            try:
                self.assertTrue(launched.wait(3))
                self.assertIsNone(children[0].poll())
                waiting = callers.submit(self.media.loudness, self.folders, entries["Queued.flac"]["id"])
                wait_until(lambda: len(self.media._loudness._pending) == 1)
            finally:
                self.assertTrue(self.media.shutdown(3))
            for response in (running, waiting):
                with self.assertRaises(ApiError) as error:
                    response.result(timeout=3)
                self.assertEqual((error.exception.status, error.exception.code, error.exception.retryable),
                                 (503, "COMPUTER_LOUDNESS_STOPPED", True))
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertFalse(self.media._loudness._thread.is_alive())


def wait_until(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Loudness requests did not reach the expected state.")
        time.sleep(0.01)


class LoudnessQueueTests(unittest.TestCase):
    def test_only_last_disconnect_cancels_and_nothing_is_published(self):
        started, stopped = threading.Event(), threading.Event()
        def run(executable, source, cancel, stream):
            started.set()
            if cancel.wait(3):
                stopped.set()
            return 5, 0.1
        service = loudness.ComputerLoudness(lambda: "ffmpeg", runner=run)
        self.addCleanup(service.shutdown, 3)
        publish = mock.Mock()
        def measure(gone):
            entry = {"id": "file", "duration": 1}
            return service.measure(entry, (1, 2), "file", lambda: entry, publish, gone.is_set)

        with ThreadPoolExecutor(4) as pool:
            flags = [threading.Event() for _ in range(4)]
            calls = [pool.submit(measure, flag) for flag in flags]
            self.assertTrue(started.wait(2))
            wait_until(lambda: len(service._running.callers) == 4)
            with self.assertRaises(ApiError) as busy:
                measure(threading.Event())
            self.assertEqual((busy.exception.status, busy.exception.retryable), (503, True))
            for flag, call in zip(flags, calls):
                self.assertFalse(stopped.is_set())
                flag.set()
                with self.assertRaises(ConnectionAbortedError):
                    call.result(timeout=2)
            self.assertTrue(stopped.wait(2))
        publish.assert_not_called()

    def test_shares_running_and_queued_jobs_and_limits_waiting_requests(self):
        release = threading.Event()
        started = threading.Event()
        calls = []

        def runner(executable, source, cancel, stream):
            calls.append(source)
            started.set()
            if not release.wait(3):
                raise AssertionError("Test did not release the measurement.")
            return 5.0, 0.1

        service = loudness.ComputerLoudness(lambda: "ffmpeg", runner=runner)
        self.addCleanup(service.shutdown, 3)

        def measure(identity):
            entry = {"id": identity, "duration": 1}
            return service.measure(entry, (1, 2), identity, lambda: entry, lambda gain, peak, cancel: {
                **entry, "rg_track_gain": gain, "rg_track_peak": peak, "rg_measured": True,
            })

        with ThreadPoolExecutor(max_workers=4) as callers:
            first = callers.submit(measure, "first")
            try:
                self.assertTrue(started.wait(3))
                duplicate = callers.submit(measure, "first")
                wait_until(lambda: len(service._running.callers) == 2)
                queued = callers.submit(measure, "second")
                queued_duplicate = callers.submit(measure, "second")
                wait_until(lambda: service._pending and len(service._pending[0].callers) == 2)
                with self.assertRaises(ApiError):
                    measure("first")
                with self.assertRaises(ApiError) as error:
                    measure("third")
                self.assertEqual((error.exception.status, error.exception.code, error.exception.retryable),
                                 (503, "COMPUTER_LOUDNESS_BUSY", True))
            finally:
                release.set()
            self.assertEqual(first.result(timeout=3), duplicate.result(timeout=3))
            self.assertEqual(queued.result(timeout=3), queued_duplicate.result(timeout=3))
        self.assertEqual(calls, ["first", "second"])
