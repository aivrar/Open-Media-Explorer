"""Thread-safe capture job registry and monotonic state machine."""
from __future__ import annotations

import secrets
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from worldmedia_security import safe_message


JOB_KINDS = frozenset({"download", "record-audio", "record-video", "ffmpeg-install"})
ACTIVE_STATES = frozenset({"queued", "preparing", "running", "stopping", "finalizing"})
TERMINAL_STATES = frozenset({"completed", "cancelled", "failed"})
ALLOWED_TRANSITIONS = {
    "queued": frozenset({"preparing", "cancelled", "failed"}),
    "preparing": frozenset({"running", "cancelled", "failed"}),
    "running": frozenset({"stopping", "finalizing", "cancelled", "failed"}),
    "stopping": frozenset({"finalizing", "failed"}),
    "finalizing": frozenset({"completed", "failed"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
    "failed": frozenset(),
}


class JobError(RuntimeError):
    code = "JOB_ERROR"


class JobNotFoundError(JobError):
    code = "JOB_NOT_FOUND"


class JobStateError(JobError):
    code = "INVALID_JOB_STATE"


class DuplicateJobError(JobError):
    code = "DUPLICATE_ACTIVE_JOB"

    def __init__(self, existing_id: str) -> None:
        super().__init__("An equivalent job is already active.")
        self.existing_id = existing_id


class JobLimitError(JobError):
    code = "JOB_LIMIT_REACHED"


@dataclass(slots=True)
class Job:
    id: str
    kind: str
    title: str
    media_id: str | None
    item_id: str | None
    source: str | None
    profile: str | None
    state: str = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    progress: float | None = 0.0
    bytes_written: int = 0
    output_path: str | None = None
    error: dict | None = None
    return_code: int | None = None
    _started_monotonic: float = field(default_factory=time.monotonic, repr=False)
    _elapsed_final: float | None = field(default=None, repr=False)
    _stop_callback: Callable[[], None] | None = field(default=None, repr=False)
    _cancel_callback: Callable[[], None] | None = field(default=None, repr=False)

    def elapsed_seconds(self) -> float:
        if self._elapsed_final is not None:
            return self._elapsed_final
        return max(0.0, time.monotonic() - self._started_monotonic)

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "title": self.title,
            "media_id": self.media_id,
            "item_id": self.item_id,
            "profile": self.profile,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "progress": self.progress,
            "bytes_written": self.bytes_written,
            "elapsed_seconds": self.elapsed_seconds(),
            "output_path": self.output_path,
            "error": self.error,
        }


class JobRegistry:
    def __init__(self, *, max_history: int = 200, max_downloads: int = 2) -> None:
        if max_history < 1 or max_downloads < 1:
            raise ValueError("job registry limits must be positive")
        self.max_history = max_history
        self.max_downloads = max_downloads
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)

    def create(
        self,
        *,
        kind: str,
        title: str,
        media_id: str | None = None,
        item_id: str | None = None,
        source: str | None = None,
        profile: str | None = None,
    ) -> Job:
        if kind not in JOB_KINDS:
            raise ValueError("unsupported job kind")
        normalized_title = str(title or "").strip()[:512]
        if not normalized_title:
            raise ValueError("job title is required")
        normalized_media = str(media_id)[:512] if media_id else None
        normalized_item = str(item_id).strip()[:512] if item_id else None
        if kind != "ffmpeg-install" and not normalized_media:
            raise ValueError("media_id is required for capture jobs")
        with self._changed:
            duplicate = self._find_duplicate(kind, normalized_media)
            if duplicate:
                raise DuplicateJobError(duplicate.id)
            self._enforce_limits(kind)
            self._prune_terminal_locked()
            job = Job(
                id=f"job_{secrets.token_urlsafe(18)}",
                kind=kind,
                title=normalized_title,
                media_id=normalized_media,
                item_id=normalized_item,
                source=str(source)[:128] if source else None,
                profile=profile if profile in {"compact", "balanced", "high"} else None,
            )
            self._jobs[job.id] = job
            self._changed.notify_all()
            return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            try:
                return self._jobs[job_id]
            except KeyError:
                raise JobNotFoundError("Job was not found.") from None

    def list(self) -> list[Job]:
        with self._lock:
            return list(reversed(self._jobs.values()))

    def snapshot(self, job_id: str) -> dict:
        with self._lock:
            return self._get_locked(job_id).to_public()

    def snapshots(self) -> list[dict]:
        with self._lock:
            return [job.to_public() for job in reversed(self._jobs.values())]

    def active(self) -> list[Job]:
        with self._lock:
            return [job for job in self._jobs.values() if job.state in ACTIVE_STATES]

    def transition(
        self,
        job_id: str,
        new_state: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        retryable: bool = False,
        return_code: int | None = None,
    ) -> Job:
        with self._changed:
            job = self._get_locked(job_id)
            if new_state == job.state:
                return job
            if new_state not in ALLOWED_TRANSITIONS[job.state]:
                raise JobStateError(f"Cannot transition job from {job.state} to {new_state}.")
            job.state = new_state
            job.updated_at = time.time()
            if new_state == "completed":
                job.progress = 1.0
            if new_state == "failed":
                code = error_code if error_code and re.fullmatch(r"[A-Z0-9_]{2,64}", error_code) else "JOB_FAILED"
                job.error = {
                    "code": code.upper()[:64],
                    "message": safe_message(error_message or "The job failed."),
                    "retryable": bool(retryable),
                }
            if new_state in TERMINAL_STATES:
                job._elapsed_final = job.elapsed_seconds()
                job.return_code = return_code
                job._stop_callback = None
                job._cancel_callback = None
            self._changed.notify_all()
            return job

    def update_progress(
        self,
        job_id: str,
        *,
        progress: float | None = None,
        bytes_written: int | None = None,
        indeterminate: bool = False,
    ) -> Job:
        with self._changed:
            job = self._get_locked(job_id)
            if job.state not in ACTIVE_STATES:
                raise JobStateError("A terminal job cannot receive progress updates.")
            if indeterminate:
                job.progress = None
            elif progress is not None:
                job.progress = max(0.0, min(1.0, float(progress)))
            if bytes_written is not None:
                job.bytes_written = max(job.bytes_written, int(bytes_written), 0)
            job.updated_at = time.time()
            self._changed.notify_all()
            return job

    def set_validated_output_path(self, job_id: str, output_path: Path, allowed_root: Path) -> Job:
        """Publish only a backend-resolved path contained by its approved root."""

        resolved_root = Path(allowed_root).resolve()
        resolved_output = Path(output_path).resolve()
        try:
            resolved_output.relative_to(resolved_root)
        except ValueError:
            raise ValueError("output path is outside its approved root") from None
        if resolved_output == resolved_root:
            raise ValueError("output path must name a file")
        with self._changed:
            job = self._get_locked(job_id)
            if job.state not in ACTIVE_STATES:
                raise JobStateError("A terminal job cannot change its output path.")
            job.output_path = str(resolved_output)
            job.updated_at = time.time()
            self._changed.notify_all()
            return job

    def set_recording_kind(self, job_id: str, kind: str) -> Job:
        if kind not in {"record-audio", "record-video"}:
            raise ValueError("recording kind is invalid")
        with self._changed:
            job = self._get_locked(job_id)
            if job.kind not in {"record-audio", "record-video"} or job.state not in {"queued", "preparing"}:
                raise JobStateError("Recording kind can only be refined while preparing.")
            job.kind = kind
            job.updated_at = time.time()
            self._changed.notify_all()
            return job

    def attach_controller(
        self,
        job_id: str,
        *,
        stop: Callable[[], None] | None = None,
        cancel: Callable[[], None] | None = None,
    ) -> None:
        with self._lock:
            job = self._get_locked(job_id)
            if job.state in TERMINAL_STATES:
                raise JobStateError("Cannot attach a controller to a terminal job.")
            job._stop_callback = stop
            job._cancel_callback = cancel

    def request_stop(self, job_id: str) -> Job:
        callback: Callable[[], None] | None
        with self._changed:
            job = self._get_locked(job_id)
            if job.kind not in {"record-audio", "record-video"}:
                raise JobStateError("Only a recording job can be stopped.")
            if job.state == "stopping":
                return job
            if job.state != "running":
                raise JobStateError("Recording is not running.")
            self.transition(job_id, "stopping")
            callback = job._stop_callback
        if callback:
            try:
                callback()
            except Exception:
                with self._changed:
                    if job.state in ACTIVE_STATES:
                        self.transition(
                            job.id,
                            "failed",
                            error_code="STOP_FAILED",
                            error_message="The recording controller could not stop cleanly.",
                            retryable=True,
                        )
        return job

    def request_cancel(self, job_id: str) -> Job:
        callback: Callable[[], None] | None
        with self._changed:
            job = self._get_locked(job_id)
            if job.state == "cancelled":
                return job
            if job.state not in {"queued", "preparing", "running"}:
                raise JobStateError("Job cannot be cancelled in its current state.")
            if job.state == "running" and job.kind in {"record-audio", "record-video"}:
                raise JobStateError("Use Stop Recording to finalize an active recording.")
            callback = job._cancel_callback
        if callback:
            try:
                callback()
            except Exception:
                with self._changed:
                    if job.state in ACTIVE_STATES:
                        self.transition(
                            job.id,
                            "failed",
                            error_code="CANCEL_FAILED",
                            error_message="The job controller could not cancel cleanly.",
                            retryable=True,
                        )
                    return job
        with self._changed:
            if job.state == "cancelled":
                return job
            if job.state in TERMINAL_STATES:
                return job
            if job.state not in {"queued", "preparing", "running"}:
                raise JobStateError("Job cannot be cancelled in its current state.")
            self.transition(job_id, "cancelled")
            return job

    def shutdown(self, timeout: float = 5.0) -> bool:
        """Request cancellation/finalization, then wait a bounded interval."""

        with self._lock:
            active = [(job.id, job.kind, job.state) for job in self._jobs.values() if job.state in ACTIVE_STATES]
        for job_id, kind, state in active:
            try:
                if kind in {"record-audio", "record-video"} and state == "running":
                    self.request_stop(job_id)
                elif state in {"queued", "preparing"} or (
                    state == "running" and kind not in {"record-audio", "record-video"}
                ):
                    self.request_cancel(job_id)
            except JobError:
                # A worker may have advanced concurrently. The bounded wait
                # below observes its current state and handles any leftovers.
                pass

        deadline = time.monotonic() + max(0.0, timeout)
        with self._changed:
            while any(job.state in ACTIVE_STATES for job in self._jobs.values()):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._changed.wait(remaining)
            leftovers = [job for job in self._jobs.values() if job.state in ACTIVE_STATES]
            for job in leftovers:
                self.transition(
                    job.id,
                    "failed",
                    error_code="SHUTDOWN_TIMEOUT",
                    error_message="The job did not stop before application shutdown.",
                    retryable=True,
                )
            return not leftovers

    def _find_duplicate(self, kind: str, media_id: str | None) -> Job | None:
        if not media_id:
            return None
        return next(
            (
                job for job in self._jobs.values()
                if job.kind == kind and job.media_id == media_id and job.state in ACTIVE_STATES
            ),
            None,
        )

    def _enforce_limits(self, kind: str) -> None:
        active = [job for job in self._jobs.values() if job.state in ACTIVE_STATES]
        if kind == "download" and sum(job.kind == "download" for job in active) >= self.max_downloads:
            raise JobLimitError("At most two downloads can run at once.")
        if kind in {"record-audio", "record-video"} and any(
            job.kind in {"record-audio", "record-video"} for job in active
        ):
            raise JobLimitError("Only one live recording can run at once.")
        if kind == "ffmpeg-install" and any(job.kind == "ffmpeg-install" for job in active):
            raise JobLimitError("An FFmpeg installation is already active.")

    def _prune_terminal_locked(self) -> None:
        while len(self._jobs) >= self.max_history:
            terminal_id = next(
                (job_id for job_id, job in self._jobs.items() if job.state in TERMINAL_STATES),
                None,
            )
            if terminal_id is None:
                raise JobLimitError("Job history is full of active jobs.")
            del self._jobs[terminal_id]

    def _get_locked(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError:
            raise JobNotFoundError("Job was not found.") from None
