from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worldmedia_ffmpeg import ToolStatus
from worldmedia_jobs import JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_recording import (
    PROFILES,
    RecordingController,
    RecordingError,
    RecordingService,
    RecordingTool,
    build_probe_args,
    build_record_args,
    build_remux_args,
    build_validate_args,
    choose_recording_kind,
    normalize_recording_eq,
    parse_probe_json,
    recording_eq_filter,
    validate_output_probe,
)
from worldmedia_runtime import get_runtime_paths
from worldmedia_security import MAX_FILENAME_STEM


class FakeFfmpegService:
    def __init__(self, root: Path) -> None:
        self.ffmpeg = root / "ffmpeg.exe"
        self.ffprobe = root / "ffprobe.exe"
        self.ffmpeg.touch()
        self.ffprobe.touch()

    def status(self):
        return ToolStatus(
            state="ready", source="PATH", ffmpeg_path=str(self.ffmpeg),
            ffprobe_path=str(self.ffprobe), version="ffmpeg test",
        )


class FakeStdin:
    def __init__(self, process) -> None:
        self.process = process
        self.writes = []

    def write(self, value):
        self.writes.append(value)
        if "q" in value and not self.process.ignore_q:
            self.process.returncode = 0
        return len(value)

    def flush(self):
        return None


class ControlledProcess:
    def __init__(self, output: Path, *, returncode=None, ignore_q=False, stderr="") -> None:
        output.write_bytes(b"recoverable-working-media")
        self.returncode = returncode
        self.ignore_q = ignore_q
        self.stdin = FakeStdin(self)
        self.stdout = io.StringIO("total_size=2048\nout_time_us=100000\nprogress=continue\n")
        self.stderr = io.StringIO(stderr)
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("ffmpeg", timeout)
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9


class ProcessFactory:
    def __init__(self, *, returncode=None, ignore_q=False, stderr="") -> None:
        self.returncode = returncode
        self.ignore_q = ignore_q
        self.stderr = stderr
        self.calls = []
        self.processes = []

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        process = ControlledProcess(
            Path(args[-1]), returncode=self.returncode, ignore_q=self.ignore_q, stderr=self.stderr,
        )
        self.processes.append(process)
        return process


class Runner:
    def __init__(self, kind="audio") -> None:
        self.kind = kind
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        executable = Path(args[0]).name.lower()
        if "ffprobe" in executable:
            if str(args[-1]).startswith("http://127.0.0.1:"):
                streams = [{"codec_type": self.kind, "codec_name": "h264" if self.kind == "video" else "mp3"}]
            elif self.kind == "video":
                streams = [
                    {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 480},
                    {"codec_type": "audio", "codec_name": "aac"},
                ]
            else:
                streams = [{"codec_type": "audio", "codec_name": "mp3"}]
            return SimpleNamespace(
                returncode=0, stdout=json.dumps({"streams": streams, "format": {"duration": "1.25"}}), stderr="",
            )
        Path(args[-1]).write_bytes(b"finalized-media")
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class RecordingArgumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tool = RecordingTool(Path("C:/tools/ffmpeg.exe"), Path("C:/tools/ffprobe.exe"))
        self.relay = "http://127.0.0.1:9124/api/v1/media/opaque_media_token_1234567890"

    def test_profiles_generate_exact_fixed_audio_and_video_arguments(self) -> None:
        for name, profile in PROFILES.items():
            audio = build_record_args(self.tool, self.relay, Path("C:/safe/out.mp3"), kind="audio", profile=name)
            video = build_record_args(self.tool, self.relay, Path("C:/safe/out.mp4"), kind="video", profile=name)
            self.assertIn(f"{profile['audio']}k", audio)
            self.assertIn("libmp3lame", audio)
            self.assertIn(str(profile["crf"]), video)
            self.assertIn(f"{profile['video_audio']}k", video)
            self.assertTrue(any(f"min(ih\\,{profile['height']})" in value for value in video))
            self.assertIn("frag_keyframe+empty_moov+default_base_moof", video)
            self.assertEqual(video[video.index("-probesize") + 1], "1000000")
            self.assertEqual(video[video.index("-analyzeduration") + 1], "2000000")
            self.assertEqual(audio[audio.index("-i") + 1], self.relay)
            self.assertFalse(any(value.startswith("https://") for value in audio + video))
            required = build_record_args(
                self.tool, self.relay, Path("C:/safe/out.mp4"), kind="video", profile=name,
                require_audio=True,
            )
            self.assertIn("0:a:0", required)
            self.assertNotIn("0:a:0?", required)

    def test_all_builders_reject_remote_or_injected_inputs_and_use_no_shell(self) -> None:
        hostile = [
            "https://example.test/live", "http://127.0.0.1:9124/api/v1/media/x;calc",
            "http://localhost:9124/api/v1/media/opaque_media_token_1234567890",
        ]
        for value in hostile:
            with self.subTest(value=value), self.assertRaises(RecordingError):
                build_probe_args(self.tool, value)
        self.assertEqual(build_remux_args(self.tool, Path("in.mp4"), Path("out.mp4"))[-2:], ["+faststart", "out.mp4"])
        self.assertEqual(build_validate_args(self.tool, Path("out.mp4"))[-1], "out.mp4")

    def test_eq_snapshot_builds_fixed_audio_filters_for_mp3_and_mp4(self) -> None:
        curve = {
            "preamp": -3,
            "bands": [2, 0, -1, 0, 0, 1.5, 0, 0, 0, 3],
            "bypassed": False,
        }
        expected = (
            "volume=-3dB,bass=f=31:t=q:w=1:g=2,"
            "equalizer=f=125:t=q:w=1.414214:g=-1,"
            "equalizer=f=1000:t=q:w=1.414214:g=1.5,"
            "treble=f=16000:t=q:w=1:g=3,alimiter=limit=0.95:level=false"
        )
        self.assertEqual(recording_eq_filter(curve), expected)
        for kind, suffix in (("audio", "mp3"), ("video", "mp4")):
            args = build_record_args(
                self.tool, self.relay, Path(f"C:/safe/out.{suffix}"),
                kind=kind, profile="balanced", eq=curve,
            )
            self.assertEqual(args[args.index("-af") + 1], expected)
        self.assertNotIn("-af", build_record_args(
            self.tool, self.relay, Path("C:/safe/flat.mp3"), kind="audio", profile="balanced",
            eq={"preamp": 6, "bands": [12] * 10, "bypassed": True},
        ))

    def test_eq_validation_rejects_malformed_nonfinite_and_out_of_range_values(self) -> None:
        valid = {"preamp": 0, "bands": [0] * 10, "bypassed": False}
        self.assertEqual(normalize_recording_eq(valid)["bands"], [0.0] * 10)
        invalid = [
            {},
            {**valid, "filter": "volume=99"},
            {**valid, "preamp": True},
            {**valid, "preamp": float("nan")},
            {**valid, "preamp": 7},
            {**valid, "bands": [0] * 9},
            {**valid, "bands": [0] * 9 + [13]},
            {**valid, "bands": [0] * 9 + [True]},
            {**valid, "bypassed": 0},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(RecordingError, "EQ is invalid"):
                normalize_recording_eq(value)

    def test_output_validation_requires_duration_codecs_and_even_height_ceiling(self) -> None:
        validate_output_probe({
            "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720},
                        {"codec_type": "audio", "codec_name": "aac"}],
            "format": {"duration": "2"},
        }, "video", 720)
        with self.assertRaises(RecordingError):
            validate_output_probe({
                "streams": [{"codec_type": "video", "codec_name": "h264", "width": 640, "height": 480}],
                "format": {"duration": "2"},
            }, "video", 720, require_audio=True)
        invalid = [
            ({"streams": [], "format": {"duration": "2"}}, "video"),
            ({"streams": [{"codec_type": "audio", "codec_name": "aac"}], "format": {"duration": "0"}}, "audio"),
            ({"streams": [{"codec_type": "video", "codec_name": "h264", "width": 641, "height": 481}], "format": {"duration": "2"}}, "video"),
        ]
        for probe, kind in invalid:
            with self.assertRaises(RecordingError):
                validate_output_probe(probe, kind, 720 if kind == "video" else None)

    def test_hls_program_only_ffprobe_shape_selects_video(self) -> None:
        probe = parse_probe_json(json.dumps({
            "programs": [{
                "streams": [
                    {"codec_type": "audio", "codec_name": "aac"},
                    {"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720},
                ],
            }],
            "streams": [],
        }))
        self.assertEqual(choose_recording_kind(probe), "video")
        self.assertEqual({stream["codec_type"] for stream in probe["streams"]}, {"audio", "video"})


class RecordingServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        self.registry = MediaRegistry(SafeConnector(address_policy=lambda _address: True), ttl_seconds=300)
        self.jobs = JobRegistry()
        self.ffmpeg = FakeFfmpegService(base)

    def tearDown(self) -> None:
        self.jobs.shutdown(timeout=2)
        self.temporary.cleanup()

    def registration(self, media_type="audio", recording_kind=""):
        payload = {
            "item_id": f"fixture:{media_type}", "url": "http://127.0.0.1:18080/stream",
            "delivery": "live", "media_type": media_type, "capture_headers": {},
            "title": f"Fixture {media_type}", "source": "radio-browser" if media_type == "audio" else "iptv-org",
            "download_name": "",
        }
        if recording_kind:
            payload["recording_kind"] = recording_kind
        return self.registry.register(payload)

    def wait_state(self, job_id, states, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.jobs.snapshot(job_id)
            if value["state"] in states:
                return value
            time.sleep(0.01)
        self.fail(self.jobs.snapshot(job_id))

    def test_progress_start_gate_requires_a_video_frame_but_not_for_audio(self) -> None:
        service = object.__new__(RecordingService)
        service.jobs = mock.Mock()

        video_started = threading.Event()
        service._drain_progress(
            "job-video",
            io.StringIO("frame=0\nout_time_us=1500000\nframe=1\n"),
            video_started,
            "video",
        )
        self.assertTrue(video_started.is_set())

        header_only = threading.Event()
        service._drain_progress(
            "job-header",
            io.StringIO("frame=0\nout_time_us=1500000\ntotal_size=28\n"),
            header_only,
            "video",
        )
        self.assertFalse(header_only.is_set())

        audio_started = threading.Event()
        service._drain_progress(
            "job-audio", io.StringIO("out_time_us=1000000\n"), audio_started, "audio",
        )
        self.assertTrue(audio_started.is_set())

    def test_audio_and_video_stop_finalize_with_fixed_process_contract(self) -> None:
        for kind in ("audio", "video"):
            with self.subTest(kind=kind):
                factory = ProcessFactory()
                runner = Runner(kind)
                service = RecordingService(
                    self.registry, self.jobs, self.ffmpeg, self.paths, popen=factory, runner=runner,
                )
                started = service.start(
                    self.registration("hls" if kind == "video" else "audio").token,
                    "balanced", "http://127.0.0.1:9124",
                )
                self.wait_state(started["id"], {"running"})
                self.jobs.request_stop(started["id"])
                completed = self.wait_state(started["id"], {"completed", "failed"})
                self.assertEqual(completed["state"], "completed", completed)
                output = Path(completed["output_path"])
                self.assertTrue(output.is_file())
                self.assertEqual(output.suffix, ".mp4" if kind == "video" else ".mp3")
                self.assertRegex(output.name, r" - \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?: \(\d+\))?\.(?:mp3|mp4)$")
                args, kwargs = factory.calls[0]
                self.assertFalse(kwargs["shell"])
                if sys.platform == "win32":
                    self.assertTrue(
                        kwargs["creationflags"] & getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
                    )
                self.assertEqual(args[args.index("-i") + 1], f"http://127.0.0.1:9124/api/v1/media/{started['media_id']}")
                self.assertEqual(factory.processes[0].stdin.writes, ["q\n"])
                self.assertFalse(factory.processes[0].killed)

    def test_explicit_hls_recording_kind_avoids_duplicate_input_probe(self) -> None:
        factory = ProcessFactory()
        runner = Runner("video")
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths, popen=factory, runner=runner,
        )
        started = service.start(
            self.registration("hls", "video").token,
            "compact",
            "http://127.0.0.1:9124",
        )
        self.wait_state(started["id"], {"running"})
        self.jobs.request_stop(started["id"])
        completed = self.wait_state(started["id"], {"completed", "failed"})
        self.assertEqual(completed["state"], "completed", completed)
        self.assertFalse(any(
            str(args[-1]).startswith("http://127.0.0.1:")
            for args, _kwargs in runner.calls
        ))

    def test_early_exit_preserves_recoverable_and_hang_escalates_without_orphan(self) -> None:
        early = ProcessFactory(returncode=1, stderr="token=secret https://example.test/path?key=secret\nfailed")
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths, popen=early, runner=Runner("audio"),
        )
        started = service.start(self.registration().token, "compact", "http://127.0.0.1:9124")
        failed = self.wait_state(started["id"], {"failed"})
        self.assertEqual(failed["error"]["code"], "FFMPEG_RECORDING_FAILED")
        self.assertTrue(Path(failed["output_path"]).is_file())
        self.assertNotIn("secret", failed["error"]["message"])

        hanging = ProcessFactory(ignore_q=True)
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths, popen=hanging, runner=Runner("audio"),
        )
        started = service.start(self.registration().token, "high", "http://127.0.0.1:9124")
        self.wait_state(started["id"], {"running"})
        with mock.patch("worldmedia_recording.GRACEFUL_STOP_TIMEOUT", 0.01), \
             mock.patch("worldmedia_recording.TERMINATE_TIMEOUT", 0.01):
            self.jobs.request_stop(started["id"])
            completed = self.wait_state(started["id"], {"completed", "failed"})
        self.assertTrue(hanging.processes[0].terminated)
        self.assertIsNotNone(hanging.processes[0].poll())
        self.assertEqual(completed["state"], "completed", completed)

    def test_stderr_flood_is_drained_bounded_and_redacted_without_deadlock(self) -> None:
        flood = "".join(f"warning-{index}\n" for index in range(5000))
        flood += "https://user:password@example.test/live?token=secret-value\n"
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths,
            popen=ProcessFactory(returncode=1, stderr=flood), runner=Runner("audio"),
        )
        started = service.start(self.registration().token, "compact", "http://127.0.0.1:9124")
        failed = self.wait_state(started["id"], {"failed"})
        rendered = json.dumps(failed)
        self.assertNotIn("password", rendered)
        self.assertNotIn("secret-value", rendered)

    def test_controller_stop_is_idempotent_and_cancel_terminates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            process = ControlledProcess(Path(temporary) / "working", ignore_q=True)
            controller = RecordingController()
            controller.attach(process)
            controller.stop()
            controller.stop()
            self.assertEqual(process.stdin.writes, ["q\n", "q\n"])
            controller.cancel()
            self.assertTrue(process.terminated)

    def test_service_shutdown_reaps_a_recorder_that_ignores_graceful_stop(self) -> None:
        hanging = ProcessFactory(ignore_q=True)
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths, popen=hanging, runner=Runner("audio"),
        )
        started = service.start(self.registration().token, "balanced", "http://127.0.0.1:9124")
        self.wait_state(started["id"], {"running"})
        with mock.patch("worldmedia_recording.GRACEFUL_STOP_TIMEOUT", 0.01):
            self.assertTrue(service.shutdown(timeout=0.05))
        self.assertIsNotNone(hanging.processes[0].poll())
        with service._lock:
            self.assertFalse(service._workers)
            self.assertFalse(service._controllers)

    def test_shutdown_reaps_a_hung_probe_or_finalization_child(self) -> None:
        service = RecordingService(self.registry, self.jobs, self.ffmpeg, self.paths)
        finished = threading.Event()

        def run_utility() -> None:
            service._run([sys.executable, "-c", "import time; time.sleep(60)"], timeout=120)
            finished.set()

        thread = threading.Thread(target=run_utility)
        thread.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with service._lock:
                if service._utility_processes:
                    break
            time.sleep(0.01)
        else:
            self.fail("utility process was not tracked")
        self.assertTrue(service.shutdown(timeout=0.05))
        thread.join(timeout=2)
        self.assertTrue(finished.is_set())
        with service._lock:
            self.assertFalse(service._utility_processes)

    def test_recoverable_failures_in_the_same_second_never_overwrite_each_other(self) -> None:
        service = RecordingService(
            self.registry, self.jobs, self.ffmpeg, self.paths,
            popen=ProcessFactory(returncode=1, stderr="failed"), runner=Runner("audio"),
        )
        outputs = []
        with mock.patch("worldmedia_recording.time.strftime", return_value="2026-01-01_00-00-00"):
            for _index in range(2):
                started = service.start(
                    self.registration().token, "compact", "http://127.0.0.1:9124",
                )
                failed = self.wait_state(started["id"], {"failed"})
                outputs.append(Path(failed["output_path"]))
        self.assertEqual(len(set(outputs)), 2)
        self.assertTrue(all(path.is_file() for path in outputs))

    def test_long_recording_titles_retain_readable_timestamp_and_collision_suffix(self) -> None:
        service = RecordingService(self.registry, self.jobs, self.ffmpeg, self.paths)
        with mock.patch("worldmedia_recording.time.strftime", return_value="2026-07-14_09-08-07"):
            first = service._reserve_paths("job_long_first", "Very Long Channel " * 30, "video")
            first.final.touch()
            second = service._reserve_paths("job_long_second", "Very Long Channel " * 30, "video")
        self.assertIn(" - 2026-07-14_09-08-07", first.final.stem)
        self.assertIn(" - 2026-07-14_09-08-07 (2)", second.final.stem)
        self.assertLessEqual(len(first.final.stem), MAX_FILENAME_STEM)


if __name__ == "__main__":
    unittest.main()
