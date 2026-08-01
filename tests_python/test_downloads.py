from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import worldmedia_downloads
from tests_python.fixture_server import AUDIO_BYTES, VIDEO_BYTES, ZIP_BYTES, MediaFixtureServer
from worldmedia_downloads import DownloadService
from worldmedia_jobs import DuplicateJobError, JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_runtime import get_runtime_paths


class DownloadServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = MediaFixtureServer()
        cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        connector = SafeConnector(address_policy=lambda _address: True, idle_timeout=1)
        self.registry = MediaRegistry(connector, ttl_seconds=300)
        self.jobs = JobRegistry(max_downloads=2)
        self.service = DownloadService(self.registry, self.jobs, self.paths)

    def tearDown(self) -> None:
        self.jobs.shutdown(timeout=2)
        self.service.shutdown(timeout=2)
        self.temporary.cleanup()

    def register(self, path: str, *, title="Fixture", source="internet-archive",
                 media_type="audio", download_name="fixture.mp3", delivery="on-demand"):
        return self.registry.register({
            "item_id": f"{source}:{title}:{path}",
            "url": f"{self.fixture.base_url}{path}",
            "delivery": delivery,
            "media_type": media_type,
            "capture_headers": {},
            "title": title,
            "source": source,
            "download_name": download_name,
        })

    def wait(self, job_id: str, timeout=5) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.jobs.snapshot(job_id)
            if value["state"] in {"completed", "failed", "cancelled"}:
                return value
            time.sleep(0.01)
        self.fail(f"job {job_id} did not finish: {self.jobs.snapshot(job_id)}")

    def assert_no_temporary_outputs(self) -> None:
        root = self.paths.downloads_root
        self.assertEqual(list(root.glob("*.part")) + list(root.glob(".*.part")), [])

    def test_shutdown_reaps_cancelled_stream_worker_and_partial(self) -> None:
        registration = self.register("/stream/endless", title="Endless")
        started = self.service.start(registration.token)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.jobs.snapshot(started["id"])["state"] == "running":
                break
            time.sleep(0.01)
        self.assertEqual(self.jobs.snapshot(started["id"])["state"], "running")
        self.assertTrue(self.jobs.shutdown(timeout=0.5))
        self.assertTrue(self.service.shutdown(timeout=2))
        self.assertEqual(self.service._workers, {})
        self.assert_no_temporary_outputs()

    def test_download_service_shutdown_alone_leaves_no_active_job(self) -> None:
        registration = self.register("/stream/endless", title="Direct Service Shutdown")
        started = self.service.start(registration.token)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.jobs.snapshot(started["id"])["state"] == "running":
                break
            time.sleep(0.01)
        self.assertTrue(self.service.shutdown(timeout=2))
        self.assertEqual(self.jobs.snapshot(started["id"])["state"], "cancelled")
        self.assertFalse(self.jobs.active())
        self.assert_no_temporary_outputs()

    def test_known_unknown_redirect_and_collision_publish_exact_originals(self) -> None:
        cases = [
            ("/media/audio.mp3", "Known", AUDIO_BYTES),
            ("/media/unknown.mp3", "Unknown", AUDIO_BYTES),
            ("/redirect/public", "Redirect", AUDIO_BYTES),
        ]
        for path, title, expected in cases:
            registration = self.register(path, title=title)
            started = self.service.start(registration.token)
            job = self.wait(started["id"])
            self.assertEqual(job["state"], "completed", job)
            output = Path(job["output_path"])
            self.assertEqual(output.read_bytes(), expected)
            self.assertEqual(output.suffix, ".mp3")
            self.assertEqual(job["bytes_written"], len(expected))
            if title == "Unknown":
                self.assertIsNone(job["progress"] if job["state"] != "completed" else None)

        collision = self.paths.downloads_root / "Collision.mp3"
        collision.write_bytes(b"existing")
        job = self.wait(self.service.start(self.register(
            "/media/audio.mp3", title="Collision",
        ).token)["id"])
        self.assertEqual(collision.read_bytes(), b"existing")
        self.assertNotEqual(Path(job["output_path"]), collision)
        self.assertEqual(Path(job["output_path"]).read_bytes(), AUDIO_BYTES)

    def test_stable_resume_and_changed_validator_restart_safely(self) -> None:
        with self.fixture.state.lock:
            self.fixture.state.requests.clear()
            self.fixture.state.counters.clear()
        stable = self.wait(self.service.start(self.register(
            "/resume/stable.mp3", title="Stable",
        ).token)["id"])
        self.assertEqual(stable["state"], "completed", stable)
        self.assertEqual(Path(stable["output_path"]).read_bytes(), AUDIO_BYTES)
        with self.fixture.state.lock:
            requests = [r for r in self.fixture.state.requests if r["path"] == "/resume/stable.mp3"]
        self.assertEqual(requests[1]["headers"].get("Range"), f"bytes={len(AUDIO_BYTES) // 2}-")
        self.assertEqual(requests[1]["headers"].get("If-Range"), '"stable"')

        weak = self.wait(self.service.start(self.register(
            "/resume/weak.mp3", title="Weak",
        ).token)["id"])
        self.assertEqual(weak["state"], "completed", weak)
        with self.fixture.state.lock:
            weak_requests = [r for r in self.fixture.state.requests if r["path"] == "/resume/weak.mp3"]
        self.assertNotIn("Range", weak_requests[1]["headers"])

        changed = self.wait(self.service.start(self.register(
            "/resume/changed.mp3", title="Changed",
        ).token)["id"])
        self.assertEqual(changed["state"], "completed", changed)
        self.assertEqual(Path(changed["output_path"]).read_bytes(), AUDIO_BYTES)
        with self.fixture.state.lock:
            changed_requests = [r for r in self.fixture.state.requests if r["path"] == "/resume/changed.mp3"]
        self.assertGreaterEqual(len(changed_requests), 3)
        self.assertIn("Range", changed_requests[1]["headers"])
        self.assertNotIn("Range", changed_requests[2]["headers"])

    def test_cancel_duplicate_malformed_and_disk_failure_leave_no_final_file(self) -> None:
        endless = self.register("/stream/endless", title="Endless")
        started = self.service.start(endless.token)
        deadline = time.monotonic() + 3
        while self.jobs.snapshot(started["id"])["state"] != "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        running = self.jobs.snapshot(started["id"])
        self.assertIsNone(running["progress"])
        self.assertIsNone(running["output_path"])
        with self.assertRaises(DuplicateJobError):
            self.service.start(endless.token)
        second_registration = self.register("/stream/endless", title="Endless")
        with self.assertRaises(DuplicateJobError):
            self.service.start(second_registration.token)
        self.jobs.request_cancel(started["id"])
        cancelled = self.wait(started["id"])
        self.assertEqual(cancelled["state"], "cancelled")
        time.sleep(0.05)
        self.assertFalse(any(self.paths.downloads_root.glob("Endless*")))
        self.assert_no_temporary_outputs()

        malformed = self.wait(self.service.start(self.register(
            "/media/html.mp3", title="HTML Error",
        ).token)["id"])
        self.assertEqual(malformed["state"], "failed")
        self.assertEqual(malformed["error"]["code"], "INVALID_MEDIA_CONTENT")
        self.assertFalse(any(self.paths.downloads_root.glob("HTML Error*")))

        empty = self.wait(self.service.start(self.register(
            "/media/empty.mp3", title="Empty",
        ).token)["id"])
        self.assertEqual(empty["state"], "failed")
        self.assertEqual(empty["error"]["code"], "EMPTY_DOWNLOAD")
        self.assertFalse(any(self.paths.downloads_root.glob("Empty*")))

        with mock.patch("worldmedia_downloads.os.replace", side_effect=OSError("disk failure")):
            failed = self.wait(self.service.start(self.register(
                "/media/audio.mp3", title="Disk Failure",
            ).token)["id"])
        self.assertEqual(failed["state"], "failed")
        self.assertFalse(any(self.paths.downloads_root.glob("Disk Failure*")))
        self.assert_no_temporary_outputs()

        original_open = Path.open
        def fail_partial_write(path, mode="r", *args, **kwargs):
            if str(path).endswith(".part") and mode in {"wb", "ab"}:
                raise OSError("write failure")
            return original_open(path, mode, *args, **kwargs)
        with mock.patch("worldmedia_downloads.Path.open", new=fail_partial_write):
            write_failed = self.wait(self.service.start(self.register(
                "/media/audio.mp3", title="Write Failure",
            ).token)["id"])
        self.assertEqual(write_failed["state"], "failed")
        self.assertFalse(any(self.paths.downloads_root.glob("Write Failure*")))

        with mock.patch("worldmedia_downloads.RETRY_DELAYS", (0, 0)):
            http_failed = self.wait(self.service.start(self.register(
                "/does-not-exist.mp3", title="HTTP Failure",
            ).token)["id"])
        self.assertEqual(http_failed["state"], "failed")
        self.assertEqual(http_failed["error"]["code"], "DOWNLOAD_HTTP_ERROR")
        self.assertFalse(any(self.paths.downloads_root.glob("HTTP Failure*")))

    def test_failed_job_is_not_terminal_until_private_output_cleanup_finishes(self) -> None:
        cleanup_entered = threading.Event()
        allow_cleanup = threading.Event()
        original_unlink = worldmedia_downloads._unlink_with_retry

        def blocked_unlink(path: Path) -> None:
            cleanup_entered.set()
            allow_cleanup.wait(5)
            original_unlink(path)

        with (
            mock.patch("worldmedia_downloads.os.replace", side_effect=OSError("disk failure")),
            mock.patch("worldmedia_downloads._unlink_with_retry", side_effect=blocked_unlink),
        ):
            started = self.service.start(self.register(
                "/media/audio.mp3", title="Ordered Cleanup",
            ).token)
            self.assertTrue(cleanup_entered.wait(2), "worker never entered output cleanup")
            self.assertIn(self.jobs.snapshot(started["id"])["state"], {
                "queued", "preparing", "running", "finalizing",
            })
            allow_cleanup.set()
            failed = self.wait(started["id"])

        self.assertEqual(failed["state"], "failed")
        self.assertFalse(any(self.paths.downloads_root.glob("Ordered Cleanup*")))
        self.assert_no_temporary_outputs()

    def test_librivox_zip_and_each_on_demand_source_keep_correct_artifacts(self) -> None:
        book = self.wait(self.service.start(self.register(
            "/media/book.zip", title="Public Book", source="librivox", download_name="book.zip",
        ).token)["id"])
        self.assertEqual(book["state"], "completed", book)
        self.assertEqual(Path(book["output_path"]).read_bytes(), ZIP_BYTES)
        self.assertIn("Full Audiobook", Path(book["output_path"]).name)

        for source, path, media_type, name, expected in (
            ("internet-archive", "/media/video.mp4", "video", "archive.mp4", VIDEO_BYTES),
            ("nasa", "/media/video.mp4", "video", "nasa.mp4", VIDEO_BYTES),
            ("wikimedia", "/media/audio.mp3", "audio", "commons.mp3", AUDIO_BYTES),
            ("media-ccc", "/media/video.mp4", "video", "conference-talk.mp4", VIDEO_BYTES),
            ("library-of-congress", "/media/audio.mp3", "audio", "loc-audio.mp3", AUDIO_BYTES),
            ("gpodder", "/media/audio.mp3", "audio", "podcast-episode.mp3", AUDIO_BYTES),
            ("peertube", "/media/video.mp4", "video", "peertube-video.mp4", VIDEO_BYTES),
        ):
            job = self.wait(self.service.start(self.register(
                path, title=f"Sample {source}", source=source,
                media_type=media_type, download_name=name,
            ).token)["id"])
            self.assertEqual(job["state"], "completed", job)
            self.assertEqual(Path(job["output_path"]).read_bytes(), expected)

    def test_open_folder_is_fixed_to_runtime_download_root(self) -> None:
        with mock.patch("worldmedia_downloads.os.startfile", create=True) as startfile:
            opened = self.service.open_downloads_folder()
        self.assertEqual(Path(opened), self.paths.downloads_root.resolve())
        startfile.assert_called_once_with(str(self.paths.downloads_root.resolve()))
        with mock.patch("pathlib.Path.is_symlink", return_value=True):
            with self.assertRaises(Exception) as error:
                self.service.open_downloads_folder()
        self.assertEqual(error.exception.code, "UNSAFE_DOWNLOAD_ROOT")


if __name__ == "__main__":
    unittest.main()
