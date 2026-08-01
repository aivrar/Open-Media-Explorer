"""Finite original-media downloads with safe paths and resumable streaming."""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from worldmedia_jobs import ACTIVE_STATES, DuplicateJobError, Job, JobRegistry, JobStateError
from worldmedia_media import MediaError, MediaRegistration, MediaRegistry
from worldmedia_runtime import RuntimePaths, get_runtime_paths, probe_writable
from worldmedia_security import sanitize_filename


MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 * 1024
DOWNLOAD_RETRIES = 3
RETRY_DELAYS = (0.5, 1.5)
DOWNLOAD_CANCEL_WAIT_SECONDS = 5.0
SAFE_EXTENSIONS = frozenset({
    "mp3", "mp4", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus",
    "webm", "ogv", "mov", "mkv", "ts", "zip", "pdf", "epub", "bin",
})
CONTENT_EXTENSIONS = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a",
    "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/flac": "flac", "audio/ogg": "ogg", "audio/opus": "opus",
    "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv",
    "video/quicktime": "mov", "video/mp2t": "ts",
    "application/zip": "zip", "application/x-zip-compressed": "zip",
    "application/pdf": "pdf", "application/epub+zip": "epub",
}
REJECTED_CONTENT_TYPES = frozenset({
    "text/html", "application/xhtml+xml", "application/json", "application/xml", "text/xml",
})


class DownloadError(RuntimeError):
    code = "DOWNLOAD_FAILED"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False) -> None:
        super().__init__(message)
        if code:
            self.code = code
        self.retryable = retryable


@dataclass(slots=True)
class DownloadPaths:
    final: Path
    partial: Path


def _content_type(response) -> str:
    return (response.getheader("Content-Type") or "application/octet-stream").split(";", 1)[0].strip().lower()


def _trusted_extension(registration: MediaRegistration, content_type: str) -> str:
    suggested = Path(registration.download_name).suffix.lower().lstrip(".")
    mapped = CONTENT_EXTENSIONS.get(content_type)
    if suggested in SAFE_EXTENSIONS and (not mapped or suggested == mapped or content_type == "application/octet-stream"):
        return suggested
    if mapped:
        return mapped
    return "bin"


def _validate_content(registration: MediaRegistration, content_type: str, first_chunk: bytes) -> None:
    if content_type in REJECTED_CONTENT_TYPES or first_chunk.lstrip()[:32].lower().startswith((b"<!doctype html", b"<html")):
        raise DownloadError("The source returned a web/error document instead of media.", code="INVALID_MEDIA_CONTENT")
    if registration.media_type == "audio" and content_type.startswith("video/"):
        raise DownloadError("The source returned video for an audio download.", code="CONTENT_TYPE_MISMATCH")
    if registration.media_type == "video" and content_type.startswith("audio/"):
        raise DownloadError("The source returned audio for a video download.", code="CONTENT_TYPE_MISMATCH")


def _declared_length(response) -> int | None:
    value = response.getheader("Content-Length")
    if not value:
        return None
    if not value.isdigit():
        raise DownloadError("The source returned an invalid content length.", code="INVALID_CONTENT_LENGTH")
    length = int(value)
    if length > MAX_DOWNLOAD_BYTES:
        raise DownloadError("The media file exceeds the download size limit.", code="DOWNLOAD_TOO_LARGE")
    return length


def _validated_download_root(paths: RuntimePaths) -> Path:
    root = paths.downloads_root
    boundary = paths.portable_root.absolute()
    current = root
    while True:
        if current.exists() and (
            current.is_symlink()
            or (hasattr(os.path, "isjunction") and os.path.isjunction(current))
        ):
            raise DownloadError("Downloads paths cannot use links or junctions.", code="UNSAFE_DOWNLOAD_ROOT")
        if current.absolute() == boundary:
            break
        if current.parent == current:
            raise DownloadError("Downloads directory is outside the portable root.", code="UNSAFE_DOWNLOAD_ROOT")
        current = current.parent
    return root.resolve()


def _unlink_with_retry(path: Path) -> None:
    for attempt in range(8):
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            if attempt == 7:
                raise
            time.sleep(min(0.1 * (2 ** attempt), 1.0))


class DownloadService:
    def __init__(
        self,
        registry: MediaRegistry,
        jobs: JobRegistry,
        paths: RuntimePaths | None = None,
    ) -> None:
        self.registry = registry
        self.jobs = jobs
        self.paths = paths or get_runtime_paths()
        self._lock = threading.RLock()
        self._workers: dict[
            str, tuple[threading.Thread, threading.Event, threading.Event]
        ] = {}
        self._partials: dict[str, Path] = {}
        self._active_sources: dict[str, str] = {}
        self._job_sources: dict[str, str] = {}
        self._upstreams: dict[str, object] = {}

    def start(self, media_id: str) -> dict:
        registration = self.registry.get(media_id)
        if registration.delivery != "on-demand" or registration.media_type in {"hls", "dash"}:
            raise DownloadError("Only finite original media can be downloaded.", code="DOWNLOAD_NOT_FINITE")
        title = registration.title
        source_key = registration.url
        with self._lock:
            existing = self._active_sources.get(source_key)
            if existing:
                raise DuplicateJobError(existing)
            job = self.jobs.create(
                kind="download", title=title, media_id=media_id,
                item_id=registration.item_id, source=registration.source,
            )
            self._active_sources[source_key] = job.id
            self._job_sources[job.id] = source_key
        cancel = threading.Event()
        done = threading.Event()
        thread = threading.Thread(
            target=self._worker, args=(job.id, registration, cancel, done),
            name=f"worldmedia-download-{job.id[-8:]}", daemon=True,
        )
        def cancel_worker() -> None:
            cancel.set()
            with self._lock:
                upstream = self._upstreams.get(job.id)
            if upstream:
                try:
                    upstream.close()
                except Exception:
                    pass
            if thread is not threading.current_thread():
                done.wait(DOWNLOAD_CANCEL_WAIT_SECONDS)

        self.jobs.attach_controller(job.id, cancel=cancel_worker)
        with self._lock:
            self._workers[job.id] = (thread, cancel, done)
        try:
            thread.start()
        except Exception:
            with self._lock:
                self._workers.pop(job.id, None)
                self._active_sources.pop(source_key, None)
                self._job_sources.pop(job.id, None)
            done.set()
            self.jobs.transition(
                job.id, "failed", error_code="DOWNLOAD_START_FAILED",
                error_message="The download worker could not start.", retryable=True,
            )
            raise DownloadError("The download worker could not start.", code="DOWNLOAD_START_FAILED", retryable=True)
        return self.jobs.snapshot(job.id)

    def shutdown(self, timeout: float = 10.0) -> bool:
        """Cancel, disconnect, and synchronously reap every download worker."""

        deadline = time.monotonic() + max(0.0, timeout)
        with self._lock:
            workers = list(self._workers.values())
            upstreams = list(self._upstreams.values())
        for _thread, cancel, _done in workers:
            cancel.set()
        for upstream in upstreams:
            try:
                upstream.close()
            except Exception:
                pass
        for thread, _cancel, _done in workers:
            if thread is threading.current_thread():
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(remaining)
        with self._lock:
            return not self._workers

    def _reserve_paths(self, job: Job, registration: MediaRegistration, extension: str) -> DownloadPaths:
        root = _validated_download_root(self.paths)
        writable, reason = probe_writable(root)
        if not writable:
            raise DownloadError(reason or "Downloads directory is not writable.", code="DOWNLOADS_NOT_WRITABLE")
        resolved_root = root
        title = registration.title
        if registration.source == "librivox" and extension == "zip":
            title = f"{title} - Full Audiobook"
        base = sanitize_filename(title, extension)
        stem, suffix = Path(base).stem, Path(base).suffix
        stamp = time.strftime("%Y%m%d-%H%M%S")
        with self._lock:
            for attempt in range(1000):
                name = base if attempt == 0 else f"{stem} ({stamp}{'' if attempt == 1 else f'-{attempt}'}){suffix}"
                final = (resolved_root / name).resolve()
                final.relative_to(resolved_root)
                partial = resolved_root / f".{name}.{job.id}.part"
                if final.exists() or partial.exists():
                    continue
                try:
                    descriptor = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    continue
                os.close(descriptor)
                self._partials[job.id] = partial
                return DownloadPaths(final, partial)
        raise DownloadError("A unique download filename could not be reserved.", code="DOWNLOAD_NAME_COLLISION")

    def _worker(
        self,
        job_id: str,
        registration: MediaRegistration,
        cancel: threading.Event,
        done: threading.Event,
    ) -> None:
        paths: DownloadPaths | None = None
        committed = False
        terminal_state: str | None = None
        terminal_error: tuple[str, str, bool] | None = None
        try:
            self.jobs.transition(job_id, "preparing")
            paths = self._transfer(job_id, registration, cancel)
            if cancel.is_set() or self.jobs.get(job_id).state == "cancelled":
                raise DownloadError("Download was cancelled.", code="DOWNLOAD_CANCELLED")
            self.jobs.transition(job_id, "finalizing")
            try:
                descriptor = os.open(paths.final, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                raise DownloadError("The final download name was taken before completion.", code="DOWNLOAD_NAME_COLLISION")
            os.close(descriptor)
            try:
                os.replace(paths.partial, paths.final)
            except Exception:
                _unlink_with_retry(paths.final)
                raise
            self.jobs.set_validated_output_path(job_id, paths.final, self.paths.downloads_root)
            committed = True
            terminal_state = "completed"
        except (DownloadError, MediaError, OSError) as error:
            if cancel.is_set():
                terminal_state = "cancelled"
            else:
                code = getattr(error, "code", "DOWNLOAD_IO_FAILED")
                retryable = bool(getattr(error, "retryable", isinstance(error, OSError)))
                terminal_state = "failed"
                terminal_error = (code, str(error), retryable)
        except JobStateError:
            if cancel.is_set():
                terminal_state = "cancelled"
        except Exception:
            if cancel.is_set():
                terminal_state = "cancelled"
            else:
                terminal_state = "failed"
                terminal_error = (
                    "DOWNLOAD_INTERNAL_ERROR",
                    "The download failed safely before publication.",
                    True,
                )
        finally:
            cleanup_error: Exception | None = None
            with self._lock:
                partial = self._partials.pop(job_id, None)
            try:
                if partial and partial.exists():
                    _unlink_with_retry(partial)
                if paths and paths.final.exists() and not committed:
                    _unlink_with_retry(paths.final)
            except Exception as error:
                cleanup_error = error
            finally:
                with self._lock:
                    self._workers.pop(job_id, None)
                    source_key = self._job_sources.pop(job_id, None)
                    if source_key:
                        self._active_sources.pop(source_key, None)
                    self._upstreams.pop(job_id, None)

            try:
                job = self.jobs.get(job_id)
                if job.state in ACTIVE_STATES:
                    if cleanup_error is not None and not committed:
                        self.jobs.transition(
                            job_id,
                            "failed",
                            error_code="DOWNLOAD_CLEANUP_FAILED",
                            error_message="The incomplete download could not be removed safely.",
                            retryable=True,
                        )
                    elif terminal_state == "completed":
                        self.jobs.transition(job_id, "completed")
                    elif terminal_state == "cancelled":
                        self.jobs.transition(job_id, "cancelled")
                    elif terminal_state == "failed" and terminal_error:
                        code, message, retryable = terminal_error
                        self.jobs.transition(
                            job_id,
                            "failed",
                            error_code=code,
                            error_message=message,
                            retryable=retryable,
                        )
            except JobStateError:
                pass
            finally:
                done.set()

    def _transfer(
        self, job_id: str, registration: MediaRegistration, cancel: threading.Event,
    ) -> DownloadPaths:
        paths: DownloadPaths | None = None
        written = 0
        total: int | None = None
        validator: str | None = None
        resumable = False
        content_type: str | None = None
        last_error: Exception | None = None
        for attempt in range(DOWNLOAD_RETRIES):
            if cancel.is_set():
                raise DownloadError("Download was cancelled.", code="DOWNLOAD_CANCELLED")
            headers = dict(registration.headers)
            resume_offset = written if written and resumable and validator and total is not None else 0
            if resume_offset:
                headers["Range"] = f"bytes={resume_offset}-"
                headers["If-Range"] = validator
            elif written:
                written = 0
                if paths:
                    paths.partial.write_bytes(b"")
            try:
                upstream = self.registry.connector.open(registration.url, headers=headers, cancel=cancel)
                with self._lock:
                    self._upstreams[job_id] = upstream
                try:
                    response = upstream.response
                    if response.status not in {200, 206}:
                        raise DownloadError("The media source rejected the download.", code="DOWNLOAD_HTTP_ERROR", retryable=True)
                    etag = response.getheader("ETag")
                    current_validator = (
                        etag if etag and not etag.lstrip().lower().startswith("w/")
                        else response.getheader("Last-Modified")
                    )
                    if resume_offset:
                        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", response.getheader("Content-Range") or "")
                        if (
                            response.status != 206 or not match
                            or int(match.group(1)) != resume_offset
                            or match.group(3) == "*" or int(match.group(3)) != total
                            or current_validator != validator
                        ):
                            written = 0
                            if paths:
                                paths.partial.write_bytes(b"")
                            last_error = DownloadError("The source changed during resume; restarting.", code="RESUME_CHANGED", retryable=True)
                            continue
                    elif response.status != 200:
                        raise DownloadError("Unexpected partial media response.", code="INVALID_RANGE_RESPONSE")
                    declared = _declared_length(response)
                    if resume_offset:
                        if total is not None and declared is not None and declared != total - resume_offset:
                            raise DownloadError("Resumed media length changed.", code="RESUME_CHANGED", retryable=True)
                    else:
                        total = declared
                        validator = current_validator
                        resumable = bool(
                            total is not None and validator and
                            (response.getheader("Accept-Ranges") or "").lower() == "bytes"
                        )
                    current_type = _content_type(response)
                    if content_type and current_type != content_type:
                        raise DownloadError("Media content type changed during download.", code="CONTENT_TYPE_MISMATCH")
                    content_type = content_type or current_type
                    if paths is None:
                        paths = self._reserve_paths(
                            self.jobs.get(job_id), registration, _trusted_extension(registration, content_type),
                        )
                        if total is None:
                            self.jobs.update_progress(job_id, bytes_written=written, indeterminate=True)
                        self.jobs.transition(job_id, "running")
                    mode = "ab" if resume_offset else "wb"
                    first = written == 0
                    with paths.partial.open(mode) as output:
                        for chunk in upstream.iter_chunks(cancel=cancel):
                            if first:
                                _validate_content(registration, content_type, chunk)
                                first = False
                            written += len(chunk)
                            if written > MAX_DOWNLOAD_BYTES or (total is not None and written > total):
                                raise DownloadError("Media exceeded its expected size.", code="DOWNLOAD_TOO_LARGE")
                            output.write(chunk)
                            self.jobs.update_progress(
                                job_id, progress=(written / total if total else None), bytes_written=written,
                                indeterminate=total is None,
                            )
                        output.flush()
                        os.fsync(output.fileno())
                    if total is not None and written != total:
                        raise DownloadError("Media ended before its declared length.", code="DOWNLOAD_TRUNCATED", retryable=True)
                    if written == 0:
                        raise DownloadError("The media source returned an empty file.", code="EMPTY_DOWNLOAD")
                    return paths
                finally:
                    with self._lock:
                        self._upstreams.pop(job_id, None)
                    upstream.close()
            except (MediaError, DownloadError, OSError) as error:
                last_error = error
                if not getattr(error, "retryable", isinstance(error, (MediaError, OSError))):
                    raise
            if attempt + 1 < DOWNLOAD_RETRIES and cancel.wait(RETRY_DELAYS[attempt]):
                raise DownloadError("Download was cancelled.", code="DOWNLOAD_CANCELLED")
        if isinstance(last_error, Exception):
            raise last_error
        raise DownloadError("Download failed.")

    def open_downloads_folder(self) -> str:
        root = _validated_download_root(self.paths)
        writable, reason = probe_writable(root)
        if not writable:
            raise DownloadError(reason or "Downloads directory is unavailable.", code="DOWNLOADS_NOT_WRITABLE")
        if not hasattr(os, "startfile"):
            raise DownloadError("Opening the downloads folder is unavailable.", code="OPEN_FOLDER_UNAVAILABLE")
        os.startfile(str(root))  # type: ignore[attr-defined]
        return str(root)
