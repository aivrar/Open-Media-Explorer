from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

from worldmedia_jobs import (
    DuplicateJobError,
    JobLimitError,
    JobNotFoundError,
    JobRegistry,
    JobStateError,
)


SCHEMAS = Path(__file__).parent / "fixtures" / "schemas"


def complete_download(registry: JobRegistry, job_id: str) -> None:
    registry.transition(job_id, "preparing")
    registry.transition(job_id, "running")
    registry.transition(job_id, "finalizing")
    registry.transition(job_id, "completed")


class JobRegistryTests(unittest.TestCase):
    def test_monotonic_transitions_progress_and_public_schema(self) -> None:
        registry = JobRegistry()
        job = registry.create(
            kind="download", title="Fixture", media_id="media:one", item_id="fixture:item",
        )
        with self.assertRaises(JobStateError):
            registry.transition(job.id, "completed")
        registry.transition(job.id, "preparing")
        registry.transition(job.id, "running")
        registry.update_progress(job.id, progress=2, bytes_written=200)
        registry.update_progress(job.id, progress=-1, bytes_written=100)
        self.assertEqual(job.progress, 0)
        self.assertEqual(job.bytes_written, 200)
        with tempfile.TemporaryDirectory() as temp:
            allowed = Path(temp) / "downloads"
            allowed.mkdir()
            output = allowed / "fixture.mp3"
            registry.set_validated_output_path(job.id, output, allowed)
            self.assertEqual(job.output_path, str(output.resolve()))
            with self.assertRaises(ValueError):
                registry.set_validated_output_path(job.id, Path(temp) / "escape.mp3", allowed)
        registry.transition(job.id, "finalizing")
        registry.transition(job.id, "completed", return_code=0)
        self.assertEqual(job.progress, 1)
        with self.assertRaises(JobStateError):
            registry.update_progress(job.id, bytes_written=300)

        schema = json.loads((SCHEMAS / "job.schema.json").read_text(encoding="utf-8"))
        public = job.to_public()
        self.assertEqual(set(public), set(schema["required"]) | {"profile"})
        self.assertIn(public["state"], schema["properties"]["state"]["enum"])
        self.assertEqual(public["item_id"], "fixture:item")
        self.assertIn(public["kind"], schema["properties"]["kind"]["enum"])
        self.assertGreaterEqual(public["elapsed_seconds"], 0)

    def test_duplicates_concurrency_limits_and_bounded_history(self) -> None:
        registry = JobRegistry(max_downloads=2)
        first = registry.create(kind="download", title="One", media_id="same")
        with self.assertRaises(DuplicateJobError) as duplicate:
            registry.create(kind="download", title="One again", media_id="same")
        self.assertEqual(duplicate.exception.existing_id, first.id)
        registry.create(kind="download", title="Two", media_id="two")
        with self.assertRaises(JobLimitError):
            registry.create(kind="download", title="Three", media_id="three")

        recordings = JobRegistry()
        recordings.create(kind="record-audio", title="Radio", media_id="radio")
        with self.assertRaises(JobLimitError):
            recordings.create(kind="record-video", title="TV", media_id="tv")

        raced = JobRegistry(max_downloads=8)
        barrier = threading.Barrier(8)
        created: list[str] = []
        duplicates: list[str] = []
        lock = threading.Lock()

        def contender() -> None:
            barrier.wait()
            try:
                candidate = raced.create(kind="download", title="Race", media_id="race")
                with lock:
                    created.append(candidate.id)
            except DuplicateJobError as error:
                with lock:
                    duplicates.append(error.existing_id)

        threads = [threading.Thread(target=contender) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        self.assertEqual(len(created), 1)
        self.assertEqual(duplicates, [created[0]] * 7)
        self.assertEqual(len(raced.list()), 1)

        history = JobRegistry(max_history=2)
        old = history.create(kind="download", title="Old", media_id="old")
        complete_download(history, old.id)
        current = history.create(kind="download", title="Current", media_id="current")
        complete_download(history, current.id)
        newest = history.create(kind="download", title="Newest", media_id="newest")
        self.assertEqual({job.id for job in history.list()}, {current.id, newest.id})
        with self.assertRaises(JobNotFoundError):
            history.get(old.id)

    def test_stop_cancel_shutdown_and_redacted_errors(self) -> None:
        registry = JobRegistry()
        recording = registry.create(kind="record-audio", title="Radio", media_id="radio")
        registry.transition(recording.id, "preparing")
        registry.transition(recording.id, "running")
        stopped = threading.Event()

        def stop() -> None:
            stopped.set()
            registry.transition(recording.id, "finalizing")
            registry.transition(recording.id, "completed")

        registry.attach_controller(recording.id, stop=stop)
        self.assertTrue(registry.shutdown(timeout=1))
        self.assertTrue(stopped.is_set())
        self.assertEqual(recording.state, "completed")

        timed_out = JobRegistry()
        hanging = timed_out.create(kind="record-video", title="Hanging", media_id="hanging")
        timed_out.transition(hanging.id, "preparing")
        timed_out.transition(hanging.id, "running")
        self.assertFalse(timed_out.shutdown(timeout=0))
        self.assertEqual(hanging.state, "failed")
        self.assertEqual(hanging.error["code"], "SHUTDOWN_TIMEOUT")

        queued = registry.create(kind="download", title="Queued", media_id="queued")
        registry.request_cancel(queued.id)
        self.assertEqual(queued.state, "cancelled")
        self.assertIs(registry.request_cancel(queued.id), queued)

        cancel_failure = registry.create(kind="download", title="Cancel failure", media_id="cancel-failure")
        registry.attach_controller(cancel_failure.id, cancel=lambda: (_ for _ in ()).throw(RuntimeError("secret")))
        registry.request_cancel(cancel_failure.id)
        self.assertEqual(cancel_failure.state, "failed")
        self.assertEqual(cancel_failure.error["code"], "CANCEL_FAILED")

        failed = registry.create(kind="download", title="Failure", media_id="failure")
        registry.transition(
            failed.id,
            "failed",
            error_code="UPSTREAM_FAILED",
            error_message="https://user:password@example.test/file?token=secret-value",
            retryable=True,
        )
        rendered = json.dumps(failed.to_public())
        self.assertNotIn("password", rendered)
        self.assertNotIn("secret-value", rendered)
        self.assertLessEqual(len(failed.error["message"]), 512)


if __name__ == "__main__":
    unittest.main()
