"""Artwork for the Computer library, with bounded local FFmpeg work."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from enum import Enum
from http import HTTPStatus
from pathlib import Path

from worldmedia_computer_library import _ordinary_path
from worldmedia_computer_probe import _FORMATS
from worldmedia_ffmpeg import discovery_candidates
from worldmedia_security import ApiError


ART_ROUTE = "/api/v1/computer/art/"
ART_TIMEOUT = 20.0
MAX_RUNNING = 4
MAX_WAITING = 200
FAILURE_TTL = 10 * 60
TRIM_INTERVAL = 60.0
CACHE_LIMIT = 400 * 1024 * 1024
CACHE_TARGET = 320 * 1024 * 1024
_FORMAT_VERSION = 2
_MAX_IMAGE_BYTES = 6 * 1024 * 1024
_IMAGE_FORMATS = {"image/jpeg": "jpeg_pipe", "image/png": "png_pipe", "image/webp": "webp_pipe"}
_CACHE_FILE = re.compile(r"[0-9a-f]{64}\.jpg")
_POLL_INTERVAL = 0.1


_FOUND_FFMPEG: tuple[float, str] | None = None
_FOUND_FFMPEG_SECONDS = 30.0


def find_art_ffmpeg(paths) -> str | None:
    # Artwork only needs the FFmpeg executable. Reuse the app's discovery order
    # without launching the recording service's separate capability probes.
    # Every picture, play and subtitle request asks: remember a found one for a short while.
    global _FOUND_FFMPEG
    found = _FOUND_FFMPEG
    if found is not None and time.monotonic() - found[0] < _FOUND_FFMPEG_SECONDS and os.path.isfile(found[1]):
        return found[1]
    for candidate in discovery_candidates(paths):
        path = candidate.ffmpeg_path
        if candidate.source == "PATH" and not path.is_absolute():
            continue
        if path.is_file():
            _FOUND_FFMPEG = (time.monotonic(), str(path.resolve()))
            return _FOUND_FFMPEG[1]
    _FOUND_FFMPEG = None
    return None


class FfmpegResult(Enum):
    SUCCESS = "success"
    FAILED = "failed"
    TIMEOUT = "timed out"
    CANCELLED = "cancelled"

    def __bool__(self) -> bool:
        return self is FfmpegResult.SUCCESS


def _stderr_reader(process):
    """Drain FFmpeg without allowing a long encode to accumulate a large log."""
    tail = bytearray()

    def drain():
        try:
            while block := process.stderr.read1(8192):
                tail.extend(block)
                del tail[:-2048]
        except OSError:
            pass

    return tail, threading.Thread(target=drain, name="computer-ffmpeg-stderr", daemon=True)


def _run_ffmpeg(command: list[str], *, timeout: float, cancelled) -> FfmpegResult:
    if cancelled():
        return FfmpegResult.CANCELLED
    flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0
    deadline = time.monotonic() + timeout
    with subprocess.Popen(command, shell=False, creationflags=flags, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as process:
        tail, reader = _stderr_reader(process)
        try:
            reader.start()
            while True:
                if cancelled():
                    result = FfmpegResult.CANCELLED
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    result = FfmpegResult.TIMEOUT
                    break
                try:
                    result = FfmpegResult.FAILED if process.wait(timeout=min(remaining, _POLL_INTERVAL)) else FfmpegResult.SUCCESS
                    break
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            process.wait()
            if reader.ident is not None:
                reader.join()
        if result in (FfmpegResult.FAILED, FfmpegResult.TIMEOUT):
            logging.getLogger(__name__).warning("Computer FFmpeg %s (exit %s). stderr tail: %r",
                                               result.value, process.returncode, tail.decode("utf-8", "replace"))
        return result


def _image_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _image_bytes(path) -> bytes:
    with open(path, "rb") as handle:
        size = os.fstat(handle.fileno())
        if not stat.S_ISREG(size.st_mode) or size.st_size > _MAX_IMAGE_BYTES:
            return b""
        return handle.read(size.st_size + 1)


def _frame_time(entry: dict) -> str:
    duration = entry.get("duration") or 0
    seek = max(5, duration * 0.1)
    if seek >= duration:
        fps = entry.get("fps") or 25
        seek = max(0, duration - 1 / (fps if fps > 0 else 25))
    return f"{seek:.6f}"


def _command(executable: str, path: str, source: str, entry: dict, width: int, output: str,
             *, image_format: str | None) -> list[str]:
    # Limit auto-detection to local-file demuxers. Playlists can open other files
    # even with a file-only protocol.
    formats = image_format or _FORMATS
    command = [executable, "-nostdin", "-hide_banner", "-v", "error", "-y", "-filter_threads", "1",
               "-protocol_whitelist", "file", "-format_whitelist", formats]
    ordinary = _ordinary_path(path)
    if len(ordinary.encode("utf-16-le", errors="surrogatepass")) < 260 * 2:
        path = ordinary
    if image_format:
        # The pipe demuxer reads the one file opened by the file protocol.
        command.extend(["-f", image_format])
    scale = f"scale=w='min(iw,{width})':h='min(ih,{width})':force_original_aspect_ratio=decrease"
    filters = ["-vf", scale]
    mapping = ["-map", "0:v:0"]
    if source == "cover":
        stream = entry.get("cover_stream")
        if stream is not None and stream >= 0:
            mapping = ["-map", f"0:{stream}"]
        else:
            # Old index entries only recorded has_cover. Connect a single
            # enabled video stream after discarding all regular video streams.
            command.extend(["-discard:V", "all"])
            filters = ["-filter_complex_threads", "1", "-filter_complex", scale + "[cover]"]
            mapping = ["-map", "[cover]"]
    if source == "frame":
        command.extend(["-ss", _frame_time(entry)])
        mapping = ["-map", "0:V:0"]
    return [*command, "-i", path, *mapping, "-frames:v", "1", "-an", "-sn", "-dn",
            "-map_metadata", "-1", *filters, "-c:v", "mjpeg", "-threads", "1", "-q:v", "3",
            "-f", "image2", "-update", "1", output]


def _no_art() -> ApiError:
    return ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_ART_NOT_FOUND", "No picture was found.")


class ComputerArt:
    def __init__(self, cache: Path, *, ffmpeg, runner=_run_ffmpeg, clock=time.monotonic) -> None:
        self.cache = cache
        self._ffmpeg = ffmpeg
        self._runner = runner
        self._clock = clock
        self._condition = threading.Condition()
        self._cancel = threading.Event()
        self._active: set[str] = set()
        self._waiting: deque[object] = deque()
        self._failures: OrderedDict[str, float] = OrderedDict()
        self._trim_thread: threading.Thread | None = None
        self._trim_pending = False

    def read(self, folders, identity: str, *, large: bool = False, client_gone=lambda: False) -> tuple[bytes, str, str]:
        self._check_request(client_gone)
        result = folders.library.entry_with_folder(identity)
        if result is None:
            raise _no_art()
        entry, folder = result
        media = folders.allowed_path(folder, entry["rel"])
        if media is None:
            raise _no_art()
        artwork = entry.get("art", {}).get("file")
        sources = []
        if artwork:
            sources.append(("sidecar", artwork))
        if entry.get("has_cover"):
            sources.append(("cover", entry["rel"]))
        if entry["kind"] == "video":
            sources.append(("frame", entry["rel"]))
        executable = self._ffmpeg() if sources else None
        for source, rel in sources:
            path = folders.allowed_path(folder, rel) if source == "sidecar" else media
            if path is None:
                continue
            if executable:
                data = self._thumbnail(folders, entry, executable, source, rel, path, large, client_gone)
                content_type = "image/jpeg" if data else None
            elif source == "sidecar":
                try:
                    data = _image_bytes(path)
                except OSError:
                    continue
                content_type = _image_type(data) if len(data) <= _MAX_IMAGE_BYTES else None
            else:
                continue
            if content_type:
                return data, content_type, '"' + hashlib.sha256(data).hexdigest() + '"'
        raise _no_art()

    def _thumbnail(self, folders, entry, executable, source, rel, path, large, client_gone) -> bytes | None:
        fingerprint = self._fingerprint(entry, source, rel, path, large)
        if fingerprint is None:
            return None
        key, cover_stream = fingerprint
        target = self.cache / (key + ".jpg")
        data = self._cached(target)
        if data is not None:
            return data
        if self._failed(key):
            return None
        with self._slot(key, client_gone):
            data = self._cached(target)
            if data is not None or self._failed(key):
                return data
            # Files or folders can change while the request waits for a worker.
            folder = folders.saved_folder(entry["folder"])
            media = folders.allowed_path(folder, entry["rel"])
            checked = folders.allowed_path(folder, rel) if source == "sidecar" and media else media
            if checked != path or self._fingerprint(entry, source, rel, path, large) != fingerprint:
                return None
            if source == "cover":
                entry = {**entry, "cover_stream": cover_stream}
            data = self._render(executable, entry, source, path, large, target, client_gone)
            if data is None:
                with self._condition:
                    self._failures[key] = self._clock() + FAILURE_TTL
            return data

    @staticmethod
    def _fingerprint(entry, source, rel, path, large) -> tuple[str, int | None] | None:
        try:
            info = os.stat(path)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode):
            return None
        cover_stream = None
        # A file can be replaced before the scanner has read its new streams.
        if source == "cover" and (entry.get("size"), entry.get("mtime")) == (info.st_size, info.st_mtime_ns):
            cover_stream = entry.get("cover_stream")
        frame_time = _frame_time(entry) if source == "frame" else None
        fields = (entry["id"], source, rel, info.st_size, info.st_mtime_ns, cover_stream, frame_time,
                  "large" if large else "small", _FORMAT_VERSION)
        key = hashlib.sha256(json.dumps(fields).encode("ascii")).hexdigest()
        return key, cover_stream

    def _cached(self, target: Path) -> bytes | None:
        try:
            data = _image_bytes(target)
        except OSError:
            return None
        if len(data) > _MAX_IMAGE_BYTES or _image_type(data) != "image/jpeg":
            return None
        try:
            os.utime(target, None)
        except OSError:
            pass
        self._schedule_trim()
        return data

    def _failed(self, key: str) -> bool:
        with self._condition:
            now = self._clock()
            while self._failures and next(iter(self._failures.values())) <= now:
                self._failures.popitem(last=False)
            return key in self._failures

    def _check_request(self, client_gone) -> None:
        if client_gone():
            raise ConnectionAbortedError()
        if self._cancel.is_set():
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_ART_STOPPED",
                           "Pictures are unavailable during shutdown.", retryable=True)

    @contextmanager
    def _slot(self, key: str, client_gone):
        ticket = object()
        with self._condition:
            self._check_request(client_gone)
            if len(self._waiting) >= MAX_WAITING:
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_ART_BUSY", "Pictures are busy.", retryable=True)
            self._waiting.append(ticket)
            try:
                while True:
                    self._check_request(client_gone)
                    if self._waiting[0] is ticket and len(self._active) < MAX_RUNNING and key not in self._active:
                        self._active.add(key)
                        break
                    self._condition.wait(_POLL_INTERVAL)
            finally:
                self._waiting.remove(ticket)
                self._condition.notify_all()
        try:
            yield
        finally:
            with self._condition:
                self._active.remove(key)
                self._condition.notify_all()

    def _render(self, executable, entry, source, path, large, target, client_gone) -> bytes | None:
        temporary = None
        try:
            image_format = None
            if source == "sidecar":
                with open(path, "rb") as handle:
                    image_format = _IMAGE_FORMATS.get(_image_type(handle.read(12)))
                if image_format is None:
                    return None
            try:
                self.cache.mkdir(parents=True, exist_ok=True)
                fd, temporary = tempfile.mkstemp(prefix="thumb-", suffix=".jpg", dir=self.cache)
                cacheable = True
            except OSError:
                fd, temporary = tempfile.mkstemp(prefix="thumb-", suffix=".jpg")
                cacheable = False
            os.close(fd)
            command = _command(executable, path, source, entry, 1200 if large else 480, temporary,
                               image_format=image_format)
            self._check_request(client_gone)
            ok = self._runner(command, timeout=ART_TIMEOUT, cancelled=lambda: self._cancel.is_set() or client_gone())
            self._check_request(client_gone)
            if ok:
                data = _image_bytes(temporary)
                if len(data) <= _MAX_IMAGE_BYTES and _image_type(data) == "image/jpeg":
                    if cacheable:
                        try:
                            os.replace(temporary, target)
                        except OSError:
                            pass
                        else:
                            self._schedule_trim()
                    return data
        except ConnectionAbortedError:
            raise
        except (OSError, subprocess.SubprocessError):
            self._check_request(client_gone)
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        return None

    def _schedule_trim(self) -> None:
        with self._condition:
            if self._cancel.is_set():
                return
            self._trim_pending = True
            if self._trim_thread is None:
                self._trim_thread = threading.Thread(target=self._trim_loop, name="computer-art-cache", daemon=True)
                self._trim_thread.start()
            self._condition.notify_all()

    def _trim_loop(self) -> None:
        next_check = self._clock()
        while not self._cancel.is_set():
            with self._condition:
                while not self._cancel.is_set():
                    delay = next_check - self._clock()
                    if self._trim_pending and delay <= 0:
                        self._trim_pending = False
                        next_check = self._clock() + TRIM_INTERVAL
                        break
                    self._condition.wait(max(0, delay) if self._trim_pending else None)
            if not self._cancel.is_set():
                self._trim_cache()

    def _trim_cache(self) -> None:
        files = []
        try:
            with os.scandir(self.cache) as entries:
                for entry in entries:
                    if self._cancel.is_set():
                        return
                    if not _CACHE_FILE.fullmatch(entry.name):
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISREG(info.st_mode):
                        files.append((info.st_mtime_ns, entry.path, info.st_size))
        except OSError:
            return
        total = sum(size for _, _, size in files)
        if total <= CACHE_LIMIT:
            return
        for _, path, size in sorted(files):
            if total < CACHE_TARGET or self._cancel.is_set():
                return
            try:
                os.unlink(path)
            except OSError:
                continue
            total -= size

    def shutdown(self, timeout: float = 12.0) -> bool:
        deadline = time.monotonic() + max(0, timeout)
        with self._condition:
            self._cancel.set()
            self._condition.notify_all()
            drained = self._condition.wait_for(lambda: not self._active and not self._waiting,
                                               timeout=max(0, deadline - time.monotonic()))
            worker = self._trim_thread
        if worker is not None:
            worker.join(max(0, deadline - time.monotonic()))
        return drained and (worker is None or not worker.is_alive())
