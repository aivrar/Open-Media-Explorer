import errno
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from worldmedia_computer_art import FfmpegResult, _run_ffmpeg
from worldmedia_computer_convert import ComputerConvert, _MIN_FREE, _MIN_RUNNING_FREE, _command, _estimate, needs_conversion
from worldmedia_security import ApiError


FFMPEG = shutil.which("ffmpeg")
# STREAMINFO and a real frame for 144 samples of 8 kHz, 16-bit mono silence.
FLAC_HEADER = b"fLaC" + bytes.fromhex("800000220240024000000c00000c01f400f0000000904556165d7fe41c7700cbe455a5767d40")
FLAC_FRAME = bytes.fromhex("fff86408008f4700000086b9")
FLAC_AUDIO = FLAC_HEADER + FLAC_FRAME


class ConversionDecisionTests(unittest.TestCase):
    def test_native_and_conversion_table(self):
        cases = (
            ("flac", "flac", "flac", False),
            ("flac", "mp3", "mp3", True),
            ("mp3", "mp3", "mp3", False),
            ("aac", "mov,mp4,m4a,3gp,3g2,mj2", "m4a", False),
            ("aac", "mp4", "mp4", False),
            ("aac", "aac", "aac", True),
            ("aac", "mov,mp4,m4a,3gp,3g2,mj2", "mov", True),
            ("opus", "ogg", "opus", False),
            ("opus", "opus", "ogg", False),
            ("vorbis", "oga", "oga", False),
            ("opus", "matroska,webm", "webm", False),
            ("vorbis", "webm", "webm", False),
            ("opus", "matroska,webm", "mka", True),
            ("pcm_s16le", "wav", "wav", False),
            ("pcm_s24le", "wav", "wav", False),
            ("pcm_u8", "wav", "wav", False),
            ("pcm_f32le", "wav", "wav", False),
            ("pcm_s32le", "wav", "wav", True),
            ("pcm_s16le", "aiff", "aiff", True),
            ("pcm_s16be", "aiff", "aif", True),
            ("alac", "mov,mp4,m4a", "m4a", True),
            ("wmav2", "asf", "wma", True),
            ("wavpack", "wv", "wv", True),
            ("tta", "tta", "tta", True),
            ("ac3", "ac3", "ac3", True),
            ("dts", "dts", "dts", True),
            ("mp2", "mp3", "mp2", True),
            ("ape", "ape", "ape", True),
            ("dsd_lsbf_planar", "dsf", "dsf", True),
            ("amr_nb", "amr", "amr", True),
            ("unknown", "wav", "wav", True),
        )
        for codec, container, ext, convert in cases:
            with self.subTest(codec=codec, ext=ext):
                entry = dict(ext=ext, container=container, acodec=codec, bits=16, sample_rate=44100, channels=2)
                self.assertEqual(needs_conversion(dict(entry, kind="audio")), convert)
                self.assertFalse(needs_conversion(dict(entry, kind="video")))

    def test_unprobed_extension_table(self):
        for ext in "flac mp3 m4a m4b mp4 opus oga ogg wav webm".split():
            with self.subTest(ext=ext):
                self.assertFalse(needs_conversion({"kind": "audio", "ext": ext.upper(), "acodec": None}))
        for ext in "aac aiff aif wma wv tta ac3 dts mp2 ape dsf dff amr mka unknown".split():
            with self.subTest(ext=ext):
                self.assertTrue(needs_conversion({"kind": "audio", "ext": ext}))

    def test_high_resolution_flac(self):
        entry = dict(kind="audio", ext="flac", container="flac", acodec="flac", channels=2)
        self.assertFalse(needs_conversion(dict(entry, sample_rate=192000, bits=24)))
        self.assertTrue(needs_conversion(dict(entry, sample_rate=384000, bits=24)))
        self.assertTrue(needs_conversion(dict(entry, sample_rate=96000, bits=32)))

    def test_command_uses_safe_local_formats_and_preserves_rate_family(self):
        for codec, input_rate, output_rate in (
            ("dsd_lsbf_planar", 2822400, "176400"), ("dsd_msbf", 3072000, "192000"),
            ("pcm_s32be", 352800, "176400"), ("pcm_f32be", 384000, "192000"),
        ):
            with self.subTest(codec=codec, input_rate=input_rate):
                entry = {"acodec": codec, "sample_rate": input_rate,
                         "audio_tracks": [{"index": 1, "default": False}, {"index": 2, "default": True}]}
                command = _command("ffmpeg", "source.aif", entry, Path("out.part"))
                options = dict(zip(command, command[1:]))
                self.assertEqual(options["-protocol_whitelist"], "file")
                self.assertTrue({"aiff", "dsf", "iff", "amr"} <= set(options["-format_whitelist"].split(",")))
                self.assertTrue({"hls", "concat", "image2"}.isdisjoint(options["-format_whitelist"].split(",")))
                self.assertEqual((options["-ar"], options["-map"]), (output_rate, "0:2"))
                self.assertEqual((options["-sample_fmt"], options["-bits_per_raw_sample"]), ("s32", "24"))
                self.assertTrue({"-ac", "-channel_layout"}.isdisjoint(command))


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache = self.root / "cache"
        self.runner = mock.Mock(side_effect=self.render)
        self.ffmpeg = mock.Mock(return_value="fake-ffmpeg")

    def converter(self, **options):
        convert = ComputerConvert(self.cache, ffmpeg=self.ffmpeg, runner=self.runner, **options)
        self.addCleanup(convert.shutdown, 5)
        return convert

    def entry(self, identity="track", **fields):
        path = self.root / (identity + ".aiff")
        path.write_bytes(b"fake source")
        return path, {"id": identity, "folder": "folder", "rel": path.name, "kind": "audio",
                      "ext": "aiff", "acodec": "pcm_s16be", "sample_rate": 44100, **fields}

    @staticmethod
    def render(command, **_):
        Path(command[-1]).write_bytes(FLAC_AUDIO)
        return True

    @staticmethod
    def prepare(convert, path, entry, **options):
        target = convert.target(entry["id"], path.stat(), entry)
        convert.prepare(entry, str(path), target, current=path.is_file, **options)
        return target

    def test_cache_hit_and_changed_mtime(self):
        path, entry = self.entry()
        convert = self.converter()
        first = self.prepare(convert, path, entry)
        self.assertEqual(self.prepare(convert, path, entry), first)
        self.ffmpeg.assert_called_once_with()
        self.runner.assert_called_once()
        info = path.stat()
        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 10**9))
        self.assertNotEqual(self.prepare(convert, path, entry), first)
        self.assertEqual(self.runner.call_count, 2)

    def test_oldest_used_trim_and_protect_open_file(self):
        self.cache.mkdir()
        stale = self.cache / "convert-dead.part"
        stale.write_bytes(b"part")
        self.enterContext(mock.patch("worldmedia_computer_convert._estimate", return_value=len(FLAC_AUDIO)))
        convert = self.converter(limit=3 * len(FLAC_AUDIO))
        self.assertFalse(stale.exists())
        inputs = [self.entry(identity) for identity in "abcde"]
        a, b, c = [self.prepare(convert, path, entry) for path, entry in inputs[:3]]
        for stamp, path in enumerate((a, b, c), start=1):
            os.utime(path, (stamp, stamp))
        self.assertEqual(self.prepare(convert, *inputs[0]), a)  # A is now most recently used.
        d = self.prepare(convert, *inputs[3])
        self.assertEqual(set(self.cache.iterdir()), {a, c, d})
        with convert.open(c) as (handle, _):
            os.utime(c, (1, 1))  # Oldest, but in use.
            e = self.prepare(convert, *inputs[4])
            self.assertEqual(handle.read(4), b"fLaC")
            self.assertEqual(set(self.cache.iterdir()), {c, d, e})

    def test_failures_and_partial_cleanup(self):
        path, entry = self.entry()
        convert = self.converter()
        with self.subTest(failure="missing executable"):
            self.ffmpeg.return_value = None
            with self.assertRaisesRegex(ApiError, "Install FFmpeg in Settings to play this format."):
                self.prepare(convert, path, entry)
            self.runner.assert_not_called()
        self.ffmpeg.return_value = "fake-ffmpeg"
        for error, message in (
            (None, "This file could not be converted."),
            (OSError(errno.ENOSPC, "private disk details"), "There is not enough disk space to prepare this file."),
        ):
            def fail(command, **_):
                self.render(command)
                if error:
                    raise error
                return False

            with self.subTest(error=error):
                self.runner.side_effect = fail
                with self.assertRaisesRegex(ApiError, message):
                    self.prepare(convert, path, entry)
                self.assertEqual(list(self.cache.iterdir()), [])
        with mock.patch("worldmedia_computer_convert.tempfile.mkstemp", side_effect=PermissionError):
            with self.assertRaisesRegex(ApiError, "This file could not be converted."):
                self.prepare(convert, path, entry)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_disk_reservation_happens_before_render_and_allows_one_oversized_file(self):
        self.cache.mkdir()
        previous = self.cache / ("a" * 64 + ".flac")
        previous.write_bytes(FLAC_AUDIO)
        convert = self.converter(limit=64)
        source, entry = self.entry(duration=1, channels=2, bits=16)
        self.assertEqual(_estimate(entry), 44100 * 2 * 2 + 1024**2)
        with mock.patch("worldmedia_computer_convert._estimate", return_value=80):
            with mock.patch("worldmedia_computer_convert.shutil.disk_usage",
                            return_value=mock.Mock(free=_MIN_FREE + 79)):
                with self.assertRaisesRegex(ApiError, "There is not enough disk space"):
                    self.prepare(convert, source, entry)
                self.runner.assert_not_called()

            def render(command, **_):
                self.assertFalse(previous.exists())
                Path(command[-1]).write_bytes(FLAC_AUDIO + bytes(30))
                return True

            self.runner.side_effect = render
            target = self.prepare(convert, source, entry)
            self.assertEqual(list(self.cache.iterdir()), [target])
            self.assertEqual(target.stat().st_size, 84)

    def test_watchdog_stops_oversized_output_and_invalid_cache_is_rebuilt(self):
        source, entry = self.entry()
        convert = self.converter()
        key = convert.target(entry["id"], source.stat(), entry)
        self.cache.mkdir()

        header_with_padding = FLAC_HEADER[:4] + bytes([0]) + FLAC_HEADER[5:] + bytes.fromhex("81000014") + bytes(20)
        for data in (b"not FLAC" + bytes(50), FLAC_HEADER, header_with_padding, FLAC_HEADER + bytes(12)):
            key.write_bytes(data)
            self.assertEqual(self.prepare(convert, source, entry).read_bytes(), FLAC_AUDIO)
        self.assertEqual(self.runner.call_count, 4)
        key.unlink()

        observed = []

        def overrun(command, *, cancelled, **_):
            Path(command[-1]).write_bytes(FLAC_AUDIO + bytes(59))
            observed.append(cancelled())
            return FfmpegResult.CANCELLED

        self.runner.side_effect = overrun
        with mock.patch("worldmedia_computer_convert._estimate", return_value=50):
            with self.assertRaisesRegex(ApiError, "This file could not be converted."):
                self.prepare(convert, source, entry)
        self.assertEqual(observed, [True])
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_watchdog_stops_when_free_space_falls_below_minimum(self):
        source, entry = self.entry()
        convert = self.converter()
        observed = []
        free = _MIN_FREE + _estimate(entry)

        def render(command, *, cancelled, **_):
            nonlocal free
            self.render(command)
            observed.append(cancelled())
            free = _MIN_RUNNING_FREE - 1
            observed.append(cancelled())
            return FfmpegResult.CANCELLED

        self.runner.side_effect = render
        with mock.patch("worldmedia_computer_convert.shutil.disk_usage", side_effect=lambda _: mock.Mock(free=free)):
            with self.assertRaises(ApiError) as error:
                self.prepare(convert, source, entry)
        self.assertEqual((error.exception.code, error.exception.retryable), ("COMPUTER_CONVERT_DISK", False))
        self.assertEqual(observed, [False, True])
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_waiting_jobs_keep_their_slots_and_oldest_abandoned_job_is_replaced(self):
        started, release = threading.Event(), threading.Event()
        rendered = []

        def render(command, *, cancelled, **_):
            name = Path(command[command.index("-i") + 1]).stem
            rendered.append(name)
            if name == "a":
                started.set()
                self.assertTrue(release.wait(4))
                self.assertFalse(cancelled())
            return self.render(command)

        self.runner.side_effect = render
        convert = self.converter()
        inputs = {name: self.entry(name) for name in "abcdef"}

        def wait_for_queue(count):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                with convert._condition:
                    if len(convert._pending) == count:
                        return
                threading.Event().wait(0.005)
            self.fail("Conversion queue did not fill")

        disconnect = threading.Event()
        with ThreadPoolExecutor(6) as workers:
            first = workers.submit(self.prepare, convert, *inputs["a"])
            self.assertTrue(started.wait(2))
            try:
                abandoned = workers.submit(self.prepare, convert, *inputs["b"], client_gone=disconnect.is_set)
                wait_for_queue(1)
                waiting = []
                for count, name in enumerate("cde", 2):
                    waiting.append(workers.submit(self.prepare, convert, *inputs[name]))
                    wait_for_queue(count)
                with self.assertRaisesRegex(ApiError, "Audio conversion is busy.") as error:
                    self.prepare(convert, *inputs["f"])
                self.assertEqual((error.exception.code, error.exception.retryable), ("COMPUTER_CONVERT_BUSY", True))
                disconnect.set()
                with self.assertRaises(ConnectionAbortedError):
                    abandoned.result(2)
                added = workers.submit(self.prepare, convert, *inputs["f"])
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    with convert._condition:
                        if convert._pending[-1].entry["id"] == "f":
                            break
                    threading.Event().wait(0.005)
                else:
                    self.fail("The abandoned conversion was not replaced")
            finally:
                release.set()
            for future in (first, *waiting, added):
                self.assertTrue(future.result(4).is_file())
        self.assertEqual(rendered, list("acdef"))

    def test_ffmpeg_result_reports_only_the_last_2_kib_of_stderr(self):
        with self.assertLogs("worldmedia_computer_art", level="WARNING") as log:
            result = _run_ffmpeg([sys.executable, "-B", "-c",
                                  "import sys; sys.stderr.write('PRIVATE-START' + 'x' * 10000 + 'TAIL'); sys.exit(7)"],
                                 timeout=5, cancelled=lambda: False)
        self.assertIs(result, FfmpegResult.FAILED)
        self.assertNotIn("PRIVATE-START", log.output[0])
        self.assertIn("x" * 2044 + "TAIL", log.output[0])
        self.assertIn("exit 7", log.output[0])
        self.assertIs(_run_ffmpeg([sys.executable, "-B", "-c", "pass"], timeout=5, cancelled=lambda: False),
                      FfmpegResult.SUCCESS)

    def test_process_timeout_is_bounded_by_duration(self):
        convert = self.converter()
        for duration, timeout in [(None, 60), (600, 180), (36000, 1200)]:
            with self.subTest(duration=duration):
                path, entry = self.entry(str(duration), duration=duration)
                self.prepare(convert, path, entry)
                self.assertEqual(self.runner.call_args.kwargs["timeout"], timeout)

    def test_route_deadline_leaves_worker_running_and_retry_uses_cache(self):
        started = threading.Event()
        finish = threading.Event()

        def render(command, **_):
            started.set()
            return finish.wait(4) and self.render(command)

        self.runner.side_effect = render
        convert = self.converter(play_wait=0.15)
        path, entry = self.entry()
        with self.assertRaisesRegex(ApiError, "This file takes too long to prepare.") as error:
            self.prepare(convert, path, entry)
        self.assertEqual((error.exception.code, error.exception.retryable), ("COMPUTER_CONVERT_TIMEOUT", True))
        self.assertTrue(started.is_set())
        finish.set()
        target = self.prepare(convert, path, entry)
        self.assertEqual(target.read_bytes()[:4], b"fLaC")
        self.runner.assert_called_once()

    def test_different_entry_cancels_after_the_original_waiter_disconnects(self):
        started = threading.Event()
        disconnected = threading.Event()
        cancelled_job = threading.Event()

        def render(command, *, cancelled, **_):
            if Path(command[command.index("-i") + 1]).stem == "first":
                started.set()
                for _ in range(200):
                    if cancelled():
                        cancelled_job.set()
                        return False
                    threading.Event().wait(0.02)
                self.fail("First job was never cancelled")
            self.assertTrue(cancelled_job.is_set())
            return self.render(command)

        self.runner.side_effect = render
        convert = self.converter()
        first = self.entry("first")
        second = self.entry("second")
        with ThreadPoolExecutor(2) as workers:
            older = workers.submit(self.prepare, convert, *first, client_gone=disconnected.is_set)
            self.assertTrue(started.wait(4))
            disconnected.set()
            newer = workers.submit(self.prepare, convert, *second)
            with self.assertRaises(ConnectionAbortedError):
                older.result(4)
            path = newer.result(4)
        self.assertEqual(list(self.cache.iterdir()), [path])

    def test_same_entry_shares_the_job_even_if_one_waiter_leaves(self):
        started = threading.Event()
        finish = threading.Event()
        disconnected = threading.Event()
        waiting = threading.Event()

        def render(command, **_):
            started.set()
            return finish.wait(4) and self.render(command)

        def second_waiter():
            waiting.set()
            return False

        self.runner.side_effect = render
        convert = self.converter()
        path, entry = self.entry()
        with ThreadPoolExecutor(2) as workers:
            first = workers.submit(self.prepare, convert, path, entry, client_gone=disconnected.is_set)
            self.assertTrue(started.wait(4))
            second = workers.submit(self.prepare, convert, path, entry, client_gone=second_waiter)
            self.assertTrue(waiting.wait(4))
            disconnected.set()
            with self.assertRaises(ConnectionAbortedError):
                first.result(4)
            finish.set()
            self.assertTrue(second.result(4).is_file())
        self.runner.assert_called_once()

    def test_real_child_is_terminated_on_shutdown_or_folder_removal_or_process_timeout(self):
        for stop in ("shutdown", "folder removal", "timeout"):
            with self.subTest(stop=stop):
                started = threading.Event()
                child = []

                def popen(*args, **kwargs):
                    process = real_popen(*args, **kwargs)
                    child.append(process)
                    started.set()
                    return process

                def run_fake_ffmpeg(command, *, cancelled, timeout):
                    timeout = 0.2 if stop == "timeout" else timeout
                    return _run_ffmpeg([sys.executable, "-B", "-c", "import time; time.sleep(10)"],
                                       cancelled=cancelled, timeout=timeout)

                real_popen = subprocess.Popen
                self.runner.side_effect = run_fake_ffmpeg
                convert = self.converter()
                path, entry = self.entry()
                with mock.patch("worldmedia_computer_art.subprocess.Popen", side_effect=popen):
                    with ThreadPoolExecutor(1) as workers:
                        result = workers.submit(self.prepare, convert, path, entry)
                        self.assertTrue(started.wait(4))
                        try:
                            if stop == "shutdown":
                                self.assertTrue(convert.shutdown(4))
                                message = "Playback was cancelled."
                            elif stop == "folder removal":
                                convert.cancel_folder(entry["folder"])
                                message = "That file is no longer there."
                            else:
                                message = "This file could not be converted."
                            with self.assertRaisesRegex(ApiError, message) as error:
                                result.result(4)
                            self.assertFalse(error.exception.retryable)
                            if stop == "timeout":
                                self.assertEqual(error.exception.code, "COMPUTER_CONVERT_PROCESS_TIMEOUT")
                            self.assertIsNotNone(child[0].poll())
                        finally:
                            convert.shutdown(4)
                self.assertEqual(list(self.cache.iterdir()), [])


@unittest.skipUnless(FFMPEG, "FFmpeg is not on PATH.")
class RealConversionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.convert = ComputerConvert(self.root / "cache", ffmpeg=lambda: FFMPEG)
        self.addCleanup(self.convert.shutdown, 5)

    def ffmpeg(self, *options):
        return subprocess.check_output([FFMPEG, "-nostdin", "-v", "error", *options], timeout=15)

    def audio_hash(self, path, pcm):
        return self.ffmpeg("-i", str(path), "-map", "0:a:0", "-c:a", pcm, "-f", "hash", "-hash", "sha256", "-")

    def stream_info(self, path):
        with path.open("rb") as handle:
            header = handle.read(42)
        self.assertEqual(header[:4], b"fLaC")
        info = int.from_bytes(header[18:26], "big")
        return info >> 44, ((info >> 41) & 7) + 1, ((info >> 36) & 31) + 1

    def test_aiff_16_and_24_bit_are_bit_exact(self):
        for bits, rate in [(16, 44100), (24, 96000)]:
            with self.subTest(bits=bits, sample_rate=rate):
                path = self.root / f"{bits}.aiff"
                codec = f"pcm_s{bits}be"
                self.ffmpeg("-f", "lavfi", "-i", f"aevalsrc=0.5*sin(2*PI*1234*t):s={rate}:d=0.1",
                            "-c:a", codec, str(path))
                entry = {"id": str(bits), "folder": "folder", "rel": path.name, "ext": "aiff",
                         "acodec": codec, "bits": bits, "sample_rate": rate}
                target = ConversionTests.prepare(self.convert, path, entry)
                self.assertEqual(self.stream_info(target), (rate, 1, bits))
                pcm = f"pcm_s{bits}le"
                self.assertEqual(self.audio_hash(path, pcm), self.audio_hash(target, pcm))

    def test_high_rate_float_becomes_24_bit_flac_at_192_khz(self):
        path = self.root / "float.aiff"
        self.ffmpeg("-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*1234*t):s=384000:d=0.1",
                    "-c:a", "pcm_f32be", str(path))
        entry = {"id": "float", "folder": "folder", "rel": path.name, "ext": "aiff",
                 "acodec": "pcm_f32be", "bits": 32, "sample_rate": 384000}
        target = ConversionTests.prepare(self.convert, path, entry)
        self.assertEqual(self.stream_info(target), (192000, 1, 24))

    def test_ac3_surround_keeps_six_distinct_channel_tones_in_order(self):
        import math
        from struct import iter_unpack

        path = self.root / "surround.ac3"
        tones = (240, 370, 510, 60, 670, 790)
        signals = "|".join(f"0.5*sin(2*PI*{tone}*t)" for tone in tones)
        self.ffmpeg("-f", "lavfi", "-i", f"aevalsrc={signals}:s=48000:d=0.35:c=5.1", "-c:a", "ac3", str(path))
        entry = {"id": "surround", "folder": "folder", "rel": path.name, "ext": "ac3", "duration": 0.35,
                 "acodec": "ac3", "sample_rate": 48000, "channels": 6}
        target = ConversionTests.prepare(self.convert, path, entry)
        self.assertEqual(self.stream_info(target), (48000, 6, 24))
        decoded = self.ffmpeg("-i", str(target), "-f", "f32le", "-")
        channels = list(zip(*iter_unpack("<6f", decoded)))
        for channel, tone in zip(channels, tones):
            samples = channel[4800:9600]
            energies = []
            for candidate in tones:
                omega = math.tau * candidate / 48000
                real = sum(value * math.cos(omega * index) for index, value in enumerate(samples))
                imag = sum(value * math.sin(omega * index) for index, value in enumerate(samples))
                energies.append(real**2 + imag**2)
            self.assertEqual(tones[energies.index(max(energies))], tone)
            self.assertGreater(max(energies), 1000 * sorted(energies)[-2])


if __name__ == "__main__":
    unittest.main()
