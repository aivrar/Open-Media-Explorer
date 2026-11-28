"""On-demand ReplayGain measurements for the Computer library."""
from __future__ import annotations

import logging
import math
import re
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from http import HTTPStatus

from worldmedia_computer_art import _stderr_reader
from worldmedia_computer_convert import _stream
from worldmedia_computer_probe import _FORMATS, _gain_in_range, _peak_in_range
from worldmedia_computer_video import _launch
from worldmedia_security import ApiError


MAX_AUDIO_DURATION = 3 * 3600
_TIMEOUT = 120
_MAX_WAITING = 4
_MAX_PEAK_DB = 20 * math.log10(16)
_LOG = logging.getLogger(__name__)
_INTEGRATED = re.compile(rb"Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?)\s+LUFS")
_SAMPLE_PEAK = re.compile(rb"Sample peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS")


def unavailable() -> ApiError:
    return ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_LOUDNESS_UNAVAILABLE",
                    "The loudness of this file cannot be measured.")


def _stopped() -> ApiError:
    return ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_LOUDNESS_STOPPED",
                    "The app is closing.", retryable=True)


def loudness_result(entry: dict) -> dict:
    return {"id": entry["id"], "rg_track_gain": entry["rg_track_gain"],
            "rg_track_peak": entry.get("rg_track_peak"), "rg_measured": entry.get("rg_measured") is True}


def _summary(stderr: bytes) -> tuple[float, float] | None:
    _, marker, summary = stderr.rpartition(b"Summary:")
    if not marker:
        return None
    integrated = _INTEGRATED.search(summary)
    sample_peak = _SAMPLE_PEAK.search(summary)
    if integrated is None or sample_peak is None:
        return None
    loudness, peak_db = float(integrated[1]), float(sample_peak[1])
    gain = round(-18 - loudness, 2)
    if loudness < -70 or not _gain_in_range(gain) or peak_db > _MAX_PEAK_DB:
        return None
    peak = round(10 ** (peak_db / 20), 4)
    return (gain, peak) if _peak_in_range(peak) else None


def measure_file(executable: str, source: str, cancel: threading.Event, stream: str) -> tuple[float, float] | None:
    if cancel.is_set():
        return None
    command = [
        executable, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-xerror",
        "-protocol_whitelist", "file", "-format_whitelist", _FORMATS, "-threads", "1", "-i", source,
        "-map", stream, "-vn", "-sn", "-dn", "-filter_threads", "1",
        "-af", "ebur128=peak=sample:framelog=verbose", "-threads", "1", "-f", "null", "-",
    ]
    deadline = time.monotonic() + _TIMEOUT
    with _launch(command) as process:
        tail, reader = _stderr_reader(process)
        try:
            reader.start()
            while not cancel.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                try:
                    if process.wait(timeout=min(remaining, 0.05)) != 0:
                        return None
                    break
                except subprocess.TimeoutExpired:
                    continue
            else:
                return None
        finally:
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            process.wait()
            if reader.ident is not None:
                reader.join()
    return _summary(tail)


@dataclass
class _Measurement:
    key: tuple[str, tuple[int, int]]
    run: Callable[[_Measurement], dict]
    result: Future = field(default_factory=Future)
    cancel: threading.Event = field(default_factory=threading.Event)
    callers: dict = field(default_factory=dict)


class ComputerLoudness:
    def __init__(self, ffmpeg, *, runner=measure_file) -> None:
        self._ffmpeg = ffmpeg
        self._runner = runner
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._waiters = 0
        self._running: _Measurement | None = None
        self._pending: deque[_Measurement] = deque()
        self._thread: threading.Thread | None = None

    def check_open(self) -> None:
        if self._cancel.is_set():
            raise _stopped()

    def measure(self, entry, fingerprint, source, current, publish, client_gone=lambda: False) -> dict:
        key = (entry["id"], fingerprint)
        caller = object()
        with self._lock:
            self.check_open()
            if self._waiters >= _MAX_WAITING:
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_LOUDNESS_BUSY",
                               "Loudness measurement is busy. Try again.", retryable=True)
            job = next((job for job in (self._running, *self._pending)
                        if job and job.key == key and not job.cancel.is_set()), None)
            if job is None:
                job = _Measurement(key, lambda job: self._measure(entry, source, current, publish, job))
                if self._running is None:
                    self._running = job
                    thread = threading.Thread(target=self._work, name="computer-loudness", daemon=True)
                    try:
                        thread.start()
                    except RuntimeError:
                        self._running = None
                        raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_LOUDNESS_BUSY",
                                       "Loudness measurement could not start.", retryable=True) from None
                    self._thread = thread
                else:
                    self._pending.append(job)
            job.callers[caller] = client_gone
            self._waiters += 1
        try:
            while not client_gone():
                try:
                    return job.result.result(timeout=0.05)
                except TimeoutError:
                    if job.result.done():
                        return job.result.result()
            raise ConnectionAbortedError()
        finally:
            with self._lock:
                self._waiters -= 1
                del job.callers[caller]
                if not job.callers:
                    job.cancel.set()
                    if job in self._pending:
                        self._pending.remove(job)

    def _work(self) -> None:
        while True:
            with self._lock:
                job = self._running
            try:
                data = job.run(job)
            except Exception as error:
                job.result.set_exception(error)
            else:
                job.result.set_result(data)
            with self._lock:
                self._running = self._pending.popleft() if self._pending else None
                if self._running is None:
                    return

    def _measure(self, entry, source, current, publish, job) -> dict:
        cancel = job.cancel
        self.check_open()
        latest = current()
        if "rg_track_gain" in latest:
            return loudness_result(latest)
        started = time.monotonic()
        outcome = "unavailable"
        try:
            executable = self._ffmpeg()
            try:
                measured = self._runner(executable, source, cancel, _stream(latest)) if executable else None
            except OSError:
                measured = None
            self.check_open()
            with self._lock:
                if cancel.is_set() or all(gone() for gone in job.callers.values()):
                    cancel.set()
                    raise ConnectionAbortedError()
            if measured is None:
                raise unavailable()
            outcome = "file changed"
            result = publish(*measured, cancel)
            self.check_open()
            outcome = "measured" if result.get("rg_measured") else "tagged"
            return loudness_result(result)
        finally:
            _LOG.info("Computer loudness: seconds=%.2f elapsed_ms=%d result=%s", entry["duration"],
                      round((time.monotonic() - started) * 1000), "cancelled" if cancel.is_set() else outcome)

    def shutdown(self, timeout: float) -> bool:
        with self._lock:
            self._cancel.set()
            if self._running:
                self._running.cancel.set()
            while self._pending:
                self._pending.popleft().result.set_exception(_stopped())
            thread = self._thread
        if thread is None:
            return True
        thread.join(max(0, timeout))
        return not thread.is_alive()
