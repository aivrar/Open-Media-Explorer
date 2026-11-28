"""Prepare non-native Computer audio as cached FLAC files."""
from __future__ import annotations

import errno
import hashlib
import math
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path

from worldmedia_computer_art import FfmpegResult, _run_ffmpeg
from worldmedia_computer_library import _is_reparse, _ordinary_path
from worldmedia_computer_probe import _FORMATS
from worldmedia_security import ApiError


CACHE_LIMIT = 2 * 1024**3
_MIN_FREE = 500 * 1024**2
_MIN_RUNNING_FREE = 300 * 1024**2
_LEASE_TTL = 10 * 60
_OUTPUT_MARGIN = 1024**2
_MAX_PENDING = 4
PLAY_WAIT = 120.0
_POLL_INTERVAL = 0.1
_CACHE_FILE = re.compile(r"[0-9a-f]{64}\.flac")
_TEMP_FILE = re.compile(r"convert-[a-z0-9_]+\.part")
# Add standalone audio demuxers. Keep demuxers that can open other files,
# such as concat, playlists, and image sequences, out of the whitelist.
_AUDIO_FORMATS = _FORMATS + ",amr,amrnb,amrwb,au,caf,mlp,shn,tak,truehd"
_NATIVE_CONTAINERS = {
    "flac": {"flac"},
    "mp3": {"mp3"},
    "aac": {"m4a", "m4b", "mp4"},
    "opus": {"ogg", "opus", "oga", "webm"},
    "vorbis": {"ogg", "opus", "oga", "webm"},
    **dict.fromkeys(("pcm_s16le", "pcm_s24le", "pcm_u8", "pcm_f32le"), {"wav"}),
}
_NATIVE_EXTENSIONS = set().union(*_NATIVE_CONTAINERS.values())
_DECODE = (HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_CONVERT_FAILED", "This file could not be converted.")
_DISK = (HTTPStatus.INSUFFICIENT_STORAGE, "COMPUTER_CONVERT_DISK",
         "There is not enough disk space to prepare this file.")
_NO_FFMPEG = (HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_CONVERT_FFMPEG",
              "Install FFmpeg in Settings to play this format.")
_WAIT = (HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_CONVERT_TIMEOUT", "This file takes too long to prepare.")
_PROCESS_TIMEOUT = (HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_CONVERT_PROCESS_TIMEOUT", _DECODE[2])
_BUSY = (HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_CONVERT_BUSY", "Audio conversion is busy.")
_CANCELLED = (HTTPStatus.CONFLICT, "COMPUTER_CONVERT_CANCELLED", "Playback was cancelled.")
_GONE = (HTTPStatus.NOT_FOUND, "COMPUTER_FILE_GONE", "That file is no longer there.")


def needs_conversion(entry: dict) -> bool:
    if entry.get("kind") != "audio":
        return False
    extension = (entry.get("ext") or "").lower().lstrip(".")
    codec = (entry.get("acodec") or "").lower()
    if not codec:
        return extension not in _NATIVE_EXTENSIONS
    containers = {value.strip() for value in (entry.get("container") or extension).lower().split(",")}
    # FFprobe reports all aliases for shared demuxers.
    if "matroska" in containers and extension != "webm":
        containers.discard("webm")
    if "mov" in containers and extension in {"mov", "3gp", "3g2", "mj2"}:
        containers.difference_update(_NATIVE_CONTAINERS["aac"])
    if (entry.get("sample_rate") or 0) > 192_000 or (codec == "flac" and (entry.get("bits") or 0) > 24):
        return True
    return not bool(containers & _NATIVE_CONTAINERS.get(codec, set()))


def _conversion_timeout(entry: dict) -> float:
    duration = entry.get("duration") or 0
    return min(1200, max(60, duration / 4 + 30)) if math.isfinite(duration) else 60


def _output_format(entry: dict) -> tuple[int, int, bool]:
    rate = entry.get("sample_rate") or 0
    codec = (entry.get("acodec") or "").lower()
    dsd = codec == "dst" or codec.startswith("dsd_") or (not codec and entry.get("ext") in {"dsf", "dff"})
    resample = dsd or rate > 192_000
    if resample:
        rate = 176400 if not rate or rate % 44100 == 0 else 192000
    bits = entry.get("bits") or 0
    pcm = re.match(r"pcm_[su](\d+)", codec)
    if not bits and pcm:
        bits = int(pcm[1])
    if dsd or bits > 16 or codec.startswith("pcm_f"):
        bits = 24
    return rate, bits, resample


def _estimate(entry: dict) -> int:
    rate, bits, _ = _output_format(entry)
    duration = entry.get("duration") or 0
    channels = entry.get("channels") or 8
    return math.ceil(duration * (rate or 192_000) * channels * (2 if 0 < bits <= 16 else 3)) + _OUTPUT_MARGIN


def _stream(entry: dict) -> str:
    return next((f"0:{track['index']}" for track in entry.get("audio_tracks", ()) if track.get("default")), "0:a:0")


def _command(executable: str, source: str, entry: dict, output: Path) -> list[str]:
    ordinary = _ordinary_path(source)
    if len(ordinary.encode("utf-16-le", errors="surrogatepass")) < 260 * 2:
        source = ordinary
    rate, bits, resample = _output_format(entry)
    sample_format = []
    if bits:
        sample_format = ["-sample_fmt", "s32" if bits > 16 else "s16"]
    rate_options = ["-ar", str(rate)] if resample else []
    return [executable, "-nostdin", "-hide_banner", "-v", "error", "-y", "-xerror", "-filter_threads", "1",
            "-protocol_whitelist", "file", "-format_whitelist", _AUDIO_FORMATS, "-i", source,
            "-map", _stream(entry), "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_metadata:s:a", "-1",
            "-map_chapters", "-1", "-fflags", "+bitexact", *rate_options, *sample_format,
            "-c:a", "flac", "-bits_per_raw_sample", "24", "-compression_level", "1", "-f", "flac", str(output)]


def _output_size(path: Path) -> int:
    size = _regular_info(path).st_size
    with path.open("rb") as handle:
        if handle.read(4) == b"fLaC":
            # Only metadata precedes the audio frames. Require STREAMINFO
            # first and verify a frame sync immediately after the last block.
            for index in range(256):
                block = handle.read(4)
                if len(block) != 4:
                    break
                length = int.from_bytes(block[1:], "big")
                if index == 0 and (block[0] & 127 or length != 34):
                    break
                end = handle.seek(length, os.SEEK_CUR)
                if end >= size:
                    break
                if block[0] & 128:
                    if handle.read(2) in (b"\xff\xf8", b"\xff\xf9"):
                        return size
                    break
    raise ValueError("Invalid converted FLAC")


def converted_duration(path: Path) -> float:
    # prepare() validated the FLAC STREAMINFO block. The encoder writes the
    # sample rate and total samples even when the source had no duration tag.
    with path.open("rb") as handle:
        handle.seek(18)
        stream = int.from_bytes(handle.read(8), "big")
    rate = stream >> 44
    return (stream & ((1 << 36) - 1)) / rate if rate else 0


def _io_failure(error: OSError) -> ApiError:
    return ApiError(*(_DISK if error.errno in {errno.ENOSPC, errno.EDQUOT} else _DECODE))


def _regular_info(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or _is_reparse(info):
        raise OSError("Expected a regular cache file")
    return info


def _touch(path: Path) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


@dataclass(eq=False)
class ConversionLease:
    expires: float
    standby: bool


@dataclass
class _Job:
    target: Path
    entry: dict
    source: str
    current: Callable[[], bool]
    cancel: threading.Event = field(default_factory=threading.Event)
    waiters: int = 0
    done: bool = False
    failure: tuple | None = None


class ComputerConvert:
    def __init__(self, cache: Path, *, ffmpeg, runner=_run_ffmpeg, limit: int = CACHE_LIMIT,
                 play_wait: float = PLAY_WAIT, clock=time.monotonic) -> None:
        self.cache = cache
        self._ffmpeg = ffmpeg
        self._runner = runner
        self._limit = limit
        self._play_wait = play_wait
        self._clock = clock
        self._condition = threading.Condition()
        self._running: _Job | None = None
        self._pending: deque[_Job] = deque()
        self._worker: threading.Thread | None = None
        self._in_use: dict[Path, int] = {}
        self._pins: dict[Path, int] = {}
        self._leases: dict[Path, set[ConversionLease]] = {}
        self._closed = False
        try:
            for path in self.cache.iterdir():
                if _TEMP_FILE.fullmatch(path.name):
                    try:
                        path.unlink()
                    except OSError:
                        pass
        except OSError:
            pass

    def target(self, identity: str, info: os.stat_result, entry: dict | None = None) -> Path:
        fields = (identity, info.st_size, info.st_mtime_ns, _stream(entry or {}), _output_format(entry or {}))
        key = hashlib.sha256(repr(fields).encode("ascii")).hexdigest()
        return self.cache / (key + ".flac")

    def pin(self, target: Path) -> None:
        with self._condition:
            self._pins[target] = self._pins.get(target, 0) + 1

    def unpin(self, target: Path) -> None:
        with self._condition:
            self._pins[target] -= 1
            if not self._pins[target]:
                del self._pins[target]

    def lease(self, target: Path, playback_seconds: float = 0, *, standby_seconds=None) -> ConversionLease:
        with self._condition:
            ttl = standby_seconds if standby_seconds is not None else max(_LEASE_TTL, playback_seconds)
            lease = ConversionLease(self._clock() + ttl, standby_seconds is not None)
            self._leases.setdefault(target, set()).add(lease)
            return lease

    def promote(self, lease: ConversionLease, playback_seconds: float) -> None:
        with self._condition:
            lease.standby = False
            lease.expires = max(lease.expires, self._clock() + max(_LEASE_TTL, playback_seconds))

    def release(self, target: Path, lease: ConversionLease) -> None:
        with self._condition:
            leases = self._leases.get(target)
            if leases:
                leases.discard(lease)
                if not leases:
                    del self._leases[target]

    def prepare(self, entry: dict, source: str, target: Path, *, current, client_gone=lambda: False) -> int:
        deadline = time.monotonic() + self._play_wait
        with self._condition:
            if self._closed:
                raise ApiError(*_CANCELLED)
            if client_gone():
                raise ConnectionAbortedError()
            try:
                size = _output_size(target)
            except FileNotFoundError:
                self._leases.pop(target, None)
            except ValueError:
                try:
                    target.unlink(missing_ok=True)
                    self._leases.pop(target, None)
                except OSError as error:
                    raise _io_failure(error) from None
            except OSError as error:
                raise _io_failure(error) from None
            else:
                _touch(target)
                return size
            job = next((existing for existing in (self._running, *self._pending)
                        if existing is not None and existing.target == target and not existing.cancel.is_set()), None)
            if job is None:
                if len(self._pending) >= _MAX_PENDING:
                    abandoned = next((pending for pending in self._pending if not pending.waiters), None)
                    if abandoned is None:
                        raise ApiError(*_BUSY, retryable=True)
                    self._cancel_pending(abandoned)
                if self._running is not None and not self._running.waiters:
                    self._running.cancel.set()
                job = _Job(target, entry, source, current)
                self._pending.append(job)
                if self._worker is None:
                    self._worker = threading.Thread(target=self._work, name="computer-convert", daemon=True)
                    self._worker.start()
            job.waiters += 1
            timed_out = False
            try:
                while not job.done:
                    if client_gone():
                        raise ConnectionAbortedError()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        if job.cancel.is_set():
                            raise ApiError(*(job.failure or _CANCELLED))
                        timed_out = True
                        raise ApiError(*_WAIT, retryable=True)
                    self._condition.wait(min(remaining, _POLL_INTERVAL))
                if job.failure is not None:
                    raise ApiError(*job.failure)
                try:
                    return _output_size(target)
                except (OSError, ValueError):
                    raise ApiError(*_DECODE) from None
            finally:
                job.waiters -= 1
                if not job.waiters:
                    if not timed_out and not job.done and job is self._running and self._pending:
                        job.cancel.set()
                    self._condition.notify_all()

    @contextmanager
    def open(self, target: Path, lease: ConversionLease | None = None):
        with self._condition:
            try:
                if lease is not None and lease not in self._leases.get(target, ()):
                    raise FileNotFoundError
                size = _regular_info(target).st_size
                handle = target.open("rb")
            except FileNotFoundError:
                raise ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_MEDIA_EXPIRED", "This play link has expired.") from None
            except OSError:
                raise ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_MEDIA_EXPIRED", "This play link has expired.") from None
            self._in_use[target] = self._in_use.get(target, 0) + 1
            if lease is not None and not lease.standby:
                lease.expires = max(lease.expires, self._clock() + _LEASE_TTL)
            _touch(target)
        try:
            with handle:
                yield handle, size
        finally:
            with self._condition:
                if lease is not None and not lease.standby:
                    lease.expires = max(lease.expires, self._clock() + _LEASE_TTL)
                _touch(target)
                self._in_use[target] -= 1
                if not self._in_use[target]:
                    del self._in_use[target]

    def cancel_folder(self, identity: str) -> None:
        with self._condition:
            for job in list(self._pending):
                if job.entry["folder"] == identity:
                    self._cancel_pending(job, _GONE)
            if self._running is not None and self._running.entry["folder"] == identity:
                self._running.failure = _GONE
                self._running.cancel.set()

    def shutdown(self, timeout: float) -> bool:
        with self._condition:
            self._closed = True
            for job in list(self._pending):
                self._cancel_pending(job)
            if self._running is not None:
                self._running.cancel.set()
            worker = self._worker
        if worker is not None:
            worker.join(max(0, timeout))
        return worker is None or not worker.is_alive()

    def _cancel_pending(self, job: _Job, failure=_CANCELLED) -> None:
        self._pending.remove(job)
        job.done = True
        job.failure = failure
        self._condition.notify_all()

    def _work(self) -> None:
        while True:
            with self._condition:
                job = self._pending.popleft() if self._pending else None
                self._running = job
                if job is None:
                    self._worker = None
                    return
            try:
                self._convert(job)
            except ApiError as error:
                failure = (error.status, error.code, error.message)
            except Exception:
                failure = _DECODE
            else:
                failure = None
            with self._condition:
                job.failure = job.failure or failure
                job.done = True
                self._running = None
                self._condition.notify_all()
                self._condition.wait_for(lambda: not job.waiters)

    def _convert(self, job: _Job) -> None:
        if job.cancel.is_set():
            raise ApiError(*_CANCELLED)
        if not job.current():
            raise ApiError(*_GONE)
        executable = self._ffmpeg()
        if not executable:
            raise ApiError(*_NO_FFMPEG)
        entry = job.entry
        estimate = _estimate(entry)
        temporary = None
        try:
            self.cache.mkdir(parents=True, exist_ok=True)
            with self._condition:
                reserve = max(0, estimate + _MIN_FREE - shutil.disk_usage(self.cache).free)
                if (not self._trim(max(0, self._limit - estimate), reserve)
                        or (reserve and shutil.disk_usage(self.cache).free < estimate + _MIN_FREE)):
                    raise ApiError(*_DISK)
            fd, name = tempfile.mkstemp(prefix="convert-", suffix=".part", dir=self.cache)
            temporary = Path(name)
            os.close(fd)

            oversized = low_space = False

            def check_output():
                nonlocal oversized, low_space
                try:
                    oversized |= temporary.stat().st_size > 2 * estimate
                except FileNotFoundError:
                    pass
                low_space |= shutil.disk_usage(self.cache).free < _MIN_RUNNING_FREE
                return oversized or low_space

            command = _command(executable, job.source, entry, temporary)
            try:
                result = self._runner(command, timeout=_conversion_timeout(entry),
                                      cancelled=lambda: job.cancel.is_set() or check_output())
            except FileNotFoundError:
                raise ApiError(*_NO_FFMPEG) from None
            except subprocess.SubprocessError:
                raise ApiError(*_DECODE) from None
            if job.cancel.is_set():
                raise ApiError(*_CANCELLED)
            check_output()
            if low_space:
                raise ApiError(*_DISK)
            if oversized:
                raise ApiError(*_DECODE)
            if result is FfmpegResult.TIMEOUT:
                raise ApiError(*_PROCESS_TIMEOUT)
            if not result:
                raise ApiError(*_DECODE)
            try:
                size = _output_size(temporary)
            except ValueError:
                raise ApiError(*_DECODE) from None
            with temporary.open("r+b") as handle:
                os.fsync(handle.fileno())
            if not job.current():
                raise ApiError(*_GONE)
            with self._condition:
                if job.cancel.is_set():
                    raise ApiError(*_CANCELLED)
                if not self._trim(max(0, self._limit - size)):
                    raise ApiError(*_DISK)
                temporary.replace(job.target)
                _touch(job.target)
        except OSError as error:
            raise _io_failure(error) from None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _trim(self, limit: int, reserve: int = 0) -> bool:
        files = []
        try:
            for path in self.cache.iterdir():
                if _CACHE_FILE.fullmatch(path.name):
                    try:
                        info = _regular_info(path)
                    except OSError:
                        continue
                    files.append((info.st_mtime_ns, path, info.st_size))
        except FileNotFoundError:
            return True
        except OSError:
            return False
        total = sum(size for _, _, size in files)
        needed = max(total - limit, reserve)
        now = self._clock()
        waiting = {job.target for job in (self._running, *self._pending) if job is not None and job.waiters}
        for _, path, size in sorted(files):
            if needed <= 0:
                break
            if (path in self._in_use or path in self._pins or path in waiting
                    or any(lease.expires > now for lease in self._leases.get(path, ()))):
                continue
            try:
                path.unlink()
            except OSError:
                continue
            self._leases.pop(path, None)
            needed -= size
        return needed <= 0
