from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from tests_python.fixture_server import MediaFixtureServer
from tests_python.test_recording import FakeFfmpegService, ProcessFactory, Runner
from worldmedia_downloads import DownloadService
from worldmedia_jobs import JobRegistry
from worldmedia_media import CAPTURE_RELEASE_GRACE_SECONDS, MediaRegistry, SafeConnector
from worldmedia_recording import RecordingService
from worldmedia_runtime import get_runtime_paths


class CaptureReleaseMixin:
    ITEM = "fixture:capture-item"

    def wait_state(self, job_id: str, states: set[str], timeout: float = 5) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.jobs.snapshot(job_id)
            if value["state"] in states:
                return value
            time.sleep(0.01)
        self.fail(self.jobs.snapshot(job_id))

    def wait_released(self, token: str, timeout: float = 5) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            entry = self.registry._entries.get(token)
            if entry is None or entry.released:
                if entry is not None:
                    self.assertLessEqual(entry.expires_at, time.time() + CAPTURE_RELEASE_GRACE_SECONDS)
                return
            time.sleep(0.01)
        self.fail("the job's relay root was not released")

    def assert_alive(self, registration) -> None:
        entry = self.registry._entries[registration.token]
        self.assertFalse(entry.released)
        self.assertGreater(entry.expires_at, time.time() + 60)


class DownloadRelayReleaseTests(CaptureReleaseMixin, unittest.TestCase):
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

    def register(self, path: str, title: str = "Fixture"):
        return self.registry.register({
            "item_id": self.ITEM, "url": f"{self.fixture.base_url}{path}",
            "delivery": "on-demand", "media_type": "audio", "capture_headers": {},
            "title": title, "source": "internet-archive", "download_name": "fixture.mp3",
        })

    def test_every_ending_releases_only_that_jobs_root(self) -> None:
        playback = self.register("/media/audio.mp3", "Playback")
        endless = self.register("/stream/endless", "Endless")
        running = self.service.start(endless.token)
        self.wait_state(running["id"], {"running"})

        done = self.register("/media/audio.mp3", "Done")
        self.assertEqual(self.wait_state(self.service.start(done.token)["id"], {"completed", "failed"})["state"], "completed")
        self.wait_released(done.token)

        with mock.patch("worldmedia_downloads.RETRY_DELAYS", (0, 0)):
            failing = self.register("/does-not-exist.mp3", "Failing")
            failed = self.wait_state(self.service.start(failing.token)["id"], {"completed", "failed"})
        self.assertEqual(failed["state"], "failed")
        self.wait_released(failing.token)

        self.assert_alive(endless)  # The other job is still running on its own root.
        self.jobs.request_cancel(running["id"])
        self.assertEqual(self.wait_state(running["id"], {"cancelled", "failed"})["state"], "cancelled")
        self.wait_released(endless.token)
        self.assert_alive(playback)  # Same item, independent root: untouched.

    def test_a_job_started_from_a_child_token_leaves_the_root_alone(self) -> None:
        playback = self.register("/media/audio.mp3", "Playback")
        child = self.registry.child(playback, f"{self.fixture.base_url}/media/audio.mp3?copy=1", media_type="audio")
        job = self.service.start(child.token)
        self.wait_state(job["id"], {"completed", "failed"})
        time.sleep(0.1)
        self.assert_alive(playback)
        self.assertFalse(self.registry.release_root(child.token))


class RecordingRelayReleaseTests(CaptureReleaseMixin, unittest.TestCase):
    ORIGIN = "http://127.0.0.1:9124"

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

    def register(self):
        return self.registry.register({
            "item_id": self.ITEM, "url": "http://127.0.0.1:18080/stream",
            "delivery": "live", "media_type": "audio", "capture_headers": {},
            "title": "Fixture radio", "source": "radio-browser", "download_name": "",
        })

    def service(self, factory: ProcessFactory) -> RecordingService:
        return RecordingService(self.registry, self.jobs, self.ffmpeg, self.paths, popen=factory, runner=Runner("audio"))

    def test_stop_failure_and_shutdown_release_only_that_jobs_root(self) -> None:
        playback = self.register()

        stopped = self.register()
        started = self.service(ProcessFactory()).start(stopped.token, "compact", self.ORIGIN)
        self.wait_state(started["id"], {"running"})
        self.assert_alive(stopped)  # FFmpeg still reads it.
        self.jobs.request_stop(started["id"])
        self.assertEqual(self.wait_state(started["id"], {"completed", "failed"})["state"], "completed")
        self.wait_released(stopped.token)

        failing = self.register()
        started = self.service(ProcessFactory(returncode=1, stderr="failed")).start(failing.token, "compact", self.ORIGIN)
        self.assertEqual(self.wait_state(started["id"], {"completed", "failed"})["state"], "failed")
        self.wait_released(failing.token)

        hanging = self.register()
        service = self.service(ProcessFactory(ignore_q=True))
        started = service.start(hanging.token, "compact", self.ORIGIN)
        self.wait_state(started["id"], {"running"})
        with mock.patch("worldmedia_recording.GRACEFUL_STOP_TIMEOUT", 0.01):
            self.assertTrue(service.shutdown(timeout=0.05))
        self.wait_released(hanging.token)

        self.assert_alive(playback)


if __name__ == "__main__":
    unittest.main()
