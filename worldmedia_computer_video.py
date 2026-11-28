"""Seekable Computer video playback on a six-second MPEG-TS grid."""
from __future__ import annotations

import ctypes
import hashlib
import io
import json
import logging
import math
import os
import queue
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from collections import Counter, OrderedDict
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from functools import lru_cache
from fractions import Fraction
from http import HTTPStatus
from pathlib import Path

from worldmedia_computer_art import _stderr_reader
from worldmedia_computer_convert import _DECODE, _DISK, _GONE, _NO_FFMPEG, _regular_info
from worldmedia_computer_library import (
    MAX_VIDEO_DURATION, MIN_VIDEO_BIT_RATE, TOO_SHORT, _PROBE_SLOTS, _is_reparse, _ordinary_path, mpeg_duration_needs_sample, usable_video_duration,
)
from worldmedia_computer_probe import _FORMATS, ProbeError, _default_stream, run_ffprobe
from worldmedia_runtime import _atomic_write_json
from worldmedia_security import ApiError


HLS_ROUTE = "/api/v1/computer/hls/"
GRID = 6
_PTS_WRAP = 2**33 / 90000
SEGMENT_WAIT = 30
CACHE_LIMIT = 1536 * 1024**2
HARDWARE = ("h264_nvenc", "h264_qsv", "h264_amf")
QUALITY = {
    "libx264": ["-preset", "veryfast", "-crf", "21", "-sc_threshold", "0"],
    "h264_nvenc": ["-rc", "vbr", "-cq", "21", "-b:v", "0", "-forced-idr", "1"],
    "h264_qsv": ["-global_quality", "21", "-forced_idr", "1"],
    "h264_amf": ["-rc", "cqp", "-qp_i", "21", "-qp_p", "21"],
}
MIN_FREE = 500 * 1024**2
_HEAD_BYTES = 16 << 20
_TAIL_BYTES = 4 << 20
# A sample that leaves no usable two-packet span must not turn into a
# fraction-of-a-second length. The byte-rate fallback below one second is
# treated as unreadable instead.
_MIN_ESTIMATE = 1.0
_index_slot = threading.BoundedSemaphore(1)
_index_cache_lock = threading.Lock()
_indexes = OrderedDict()
_INDEX_VERSION = 1
_INDEX_LIMIT = 2000
_index_store_lock = threading.Lock()
_detection_samples = OrderedDict()
_DISK_FULL = (HTTPStatus.INTERNAL_SERVER_ERROR, *_DISK[1:])
_FAILED = (HTTPStatus.INTERNAL_SERVER_ERROR, *_DECODE[1:])
_END = (HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "COMPUTER_VIDEO_END", "This file has ended.")
_EXPIRED = (HTTPStatus.GONE, "COMPUTER_MEDIA_EXPIRED", "This play link has expired.")
_AUDIO = (HTTPStatus.BAD_REQUEST, "INVALID_COMPUTER_AUDIO", "Choose an audio track.")
_LOG = logging.getLogger(__name__)


def needs_video_conversion(entry: dict) -> bool:
    if entry.get("kind") != "video":
        return False
    ext = (entry.get("ext") or "").lower().lstrip(".")
    containers = set((entry.get("container") or ext).lower().split(","))
    # Shared MOV demuxer also reports mp4 for 3GP and Motion JPEG 2000.
    if "mov" in containers and ext in {"3gp", "3gpp", "3g2", "mj2"}:
        return True
    video = entry.get("vcodec")
    return not (
        containers.intersection({"mp4", "m4v", "mov", "mkv", "matroska", "webm"})
        and (video in {"vp8", "vp9", "av1"} or video == "h264" and entry.get("pix_fmt") == "yuv420p")
        and entry.get("acodec") in {None, "", "aac", "mp3", "opus", "vorbis", "flac"}
    )


def check_video_length(duration, has_audio):
    if duration is not None and 0 <= duration < 1 and not has_audio:
        raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_VIDEO_TOO_SHORT",
                       TOO_SHORT)


def segment_count(duration):
    whole, tail = divmod(round(duration * 1_000_000), GRID * 1_000_000)
    return max(1, int(whole) + (tail >= 100_000))


def playlist(duration: float) -> bytes:
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-TARGETDURATION:6"]
    count = segment_count(duration)
    for n in range(count):
        length = max(.1, duration - GRID*n) if n == count - 1 else GRID
        lines.extend([f"#EXTINF:{length:.3f},", f"seg/{n}.ts"])
    return ("\n".join([*lines, "#EXT-X-ENDLIST", ""])).encode("ascii")


def _ratio(value, default):
    try:
        rate = Fraction(str(value).replace(":", "/"))
        return rate if rate > 0 else default
    except (ValueError, ZeroDivisionError):
        return default


@dataclass
class PictureCheck:
    size: int
    origin: float
    track: str
    offsets: dict = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass(frozen=True)
class Anchor:
    time: float
    stamp: float  # Raw 33-bit MPEG presentation timestamp, in seconds.
    position: int
    piece: int


@dataclass(frozen=True)
class Timeline:
    duration: float
    anchors: tuple[Anchor, ...]
    pieces: int
    audio_extends_picture: bool = False


@dataclass
class Movie:
    executable: str
    source: str
    duration: float
    video: int
    audio: int | None
    channels: int
    fps: Fraction
    filters: str
    audio_pad: float = 2
    tone_map_filters: str = ""
    video_end: float | None = None
    duration_estimated: bool = False
    timestamp_jump: bool = False
    picture_from_start: bool = False
    picture_check: PictureCheck | None = None
    timeline: Timeline | None = None
    video_id: str | None = None
    audio_id: str | None = None
    video_delay: float = 0


def _stream_end(stream, origin):
    try:
        if stream.get("duration") not in (None, "N/A"):
            if _number(stream["duration"]) <= 0:
                return None
            start = stream.get("start_time")
            end = float(start if start not in (None, "N/A") else origin) - origin + float(stream["duration"])
        else:
            # Matroska DURATION tags are end timestamps.
            h, m, seconds = stream["tags"]["DURATION"].split(":")
            end = int(h)*3600 + int(m)*60 + float(seconds) - origin
        return end if math.isfinite(end) and end > 0 else None
    except (KeyError, ValueError, TypeError, OverflowError):
        return None


def _number(value, default=0.0):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (ValueError, TypeError, OverflowError):
        return default


def _packet_sample(probe, source, start, end, track, interval, deadline, cancelled, *, require_success=False):
    """ffprobe has no EOF-relative seek. Expose only the chosen byte range."""
    if cancelled():
        raise ConnectionAbortedError()
    if end <= start or time.monotonic() >= deadline:
        return None
    args = [probe, "-v", "error", "-protocol_whitelist", "subfile,file", "-format_whitelist", _FORMATS,
            "-start", str(start), "-end", str(end), "-skip_estimate_duration_from_pts", "1",
            "-select_streams", track, "-read_intervals", interval,
            "-show_entries", "packet=pts_time,dts_time,duration_time,pos:packet_side_data=",
            "-of", "compact=p=0", "-i", "subfile:" + os.fspath(source)]
    try:
        child = _launch(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return None
    with child as process:
        try:
            while not cancelled():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                try:
                    output, _ = process.communicate(timeout=min(.2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
                except OSError:
                    if require_success:
                        return None
                    raise
            else:
                raise ConnectionAbortedError()
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
    if require_success and process.returncode:
        return None
    packets = []
    for line in output.splitlines():
        fields = dict(field.split(b"=", 1) for field in line.split(b"|") if b"=" in field)
        if b"pos" in fields:
            stamp = _number(fields.get(b"dts_time"), _number(fields.get(b"pts_time"), None))
            packets.append((stamp, _number(fields.get(b"pos"), None), _number(fields.get(b"duration_time"))))
    return packets if packets or process.returncode == 0 else None


def _mux_rate(head):
    # Packet positions include intervening audio, navigation and mux overhead.
    # Only measure a continuous stretch of at most sixty seconds.
    elapsed = 0.0
    first = last = previous = None
    previous_length = 0
    measured = 0
    for stamp, pos, length in head:
        step = stamp - previous if stamp is not None and previous is not None else previous_length
        if step < -.5 or elapsed + step > 60:
            break
        elapsed += max(0, step)
        if pos is not None:
            if first is None:
                first = (pos, elapsed)
            last = pos
            measured = elapsed - first[1]
        previous, previous_length = stamp, length
    return (last - first[0]) / measured if measured >= 1 and last > first[0] else 0


def _rate_estimate(size, rate, container, margin):
    rate = rate or max(MIN_VIDEO_BIT_RATE / 8, _number(container.get("bit_rate")) / 8)
    span = size / rate
    if span < _MIN_ESTIMATE:
        return 0
    return min(MAX_VIDEO_DURATION, math.ceil(round(span * margin, 6)) / 1000)


def _estimate_duration(probe, source, size, container, video, cancel):
    """Estimate a missing non-PS length from bounded head and tail samples."""
    deadline = time.monotonic() + 10
    track = "i:" + str(video["id"]) if video.get("id") else str(video["index"])
    short = size <= _TAIL_BYTES
    head = _packet_sample(probe, source, 0, min(size, _HEAD_BYTES), track, "%" if short else "%+60",
                          deadline, cancel.is_set) or []
    tail = head if short else _packet_sample(probe, source, size - _TAIL_BYTES, size, track, "%",
                                              deadline, cancel.is_set) or []
    rate = _mux_rate(head)
    starts = [stamp for stamp, _, _ in head if stamp is not None]
    last, length = next(((t, d) for t, _, d in reversed(tail) if t is not None), (None, 0))
    enough = len({stamp for packets in (head, tail) for stamp, _, _ in packets if stamp is not None}) >= 2
    span = last + length - starts[0] if enough and starts and last is not None else 0
    jump = bool(enough and starts and last is not None and not 0 < span <= MAX_VIDEO_DURATION)
    for packets in (head, tail):
        times = [stamp for stamp, _, _ in packets if stamp is not None]
        jump |= any(b - a < -.5 or b - a > MAX_VIDEO_DURATION for a, b in zip(times, times[1:]))
    if jump or not usable_video_duration(span, size):
        return _rate_estimate(size, rate, container, 1050), jump, rate
    return min(MAX_VIDEO_DURATION, math.ceil(round(span * 1050, 6)) / 1000), jump, rate


@dataclass(frozen=True)
class _Window:
    earliest: float
    latest: float
    backward: bool


def _window(packets):
    times = [stamp for stamp, _, _ in packets if stamp is not None]
    if times:
        return _Window(min(times), max(times), any(b < a - .5 for a, b in zip(times, times[1:])))


def _ps_samples(probe, source, size, track, cancel):
    fingerprint = _index_key(source)
    key = (fingerprint, track)
    with _index_cache_lock:
        if cancel.is_set():
            raise ConnectionAbortedError()
        if key in _detection_samples:
            _detection_samples.move_to_end(key)
            return _detection_samples[key]

    # Disjoint byte ranges make equal timestamps in successive windows meaningful
    # even on a short VOB. Read to each range's end, including across clock resets.
    width = min(2 << 20, max(1, size // 8))
    starts = (0, size // 4, size // 2, 3 * size // 4, max(0, size - width))
    windows = []
    head_rate = 0
    for start in starts:
        for _ in range(2):
            packets = _packet_sample(probe, source, start, min(size, start + width), track, "%",
                                     time.monotonic() + 3, cancel.is_set, require_success=True) or []
            window = _window(packets)
            if window is not None:
                break
        if not windows:
            head_rate = _mux_rate(packets)
        windows.append(window)
        if window is None:
            break
    result = head_rate, tuple(windows)
    if fingerprint and all(windows) and _index_key(source) == fingerprint:
        with _index_cache_lock:
            _detection_samples[key] = result
            if len(_detection_samples) > 32:
                _detection_samples.popitem(last=False)
    return result


def _ps_length_verdict(size, reported, head_rate, windows, *, indexed=False):
    if not usable_video_duration(reported, size):
        return "index", "missing"
    if mpeg_duration_needs_sample("mpeg", reported, size):
        return "index", "bitrate"
    if head_rate and size / reported > 1.5 * head_rate:
        return "index", "mux"
    if len(windows) != 5 or None in windows:
        return "index", "unreadable"
    if not head_rate:
        return "index", "unmeasured"
    previous = None
    for window in windows:
        if window.backward or (previous is not None and window.earliest <= previous.latest):
            return "index", "clock"
        previous = window
    if indexed:
        return "index", "cached"
    return "trusted", "ordered"


def _read_timeline(lines, frame):
    anchors = []
    first = previous = None
    total = 0
    piece = 0
    length = frame
    for line in lines:
        fields = dict(item.split(b"=", 1) for item in line.rstrip().split(b"|") if b"=" in item)
        pts = _number(fields.get(b"pts_time"), None)
        stamp = _number(fields.get(b"dts_time"), pts)
        if stamp is None:
            continue
        if previous is not None and not -.5 <= stamp - previous <= 10:
            total += previous - first + length
            first = None
            piece += 1
        if first is None:
            first = stamp
            first_pts = pts if pts is not None else stamp
        previous = stamp
        length = _number(fields.get(b"duration_time")) or frame
        if pts is not None and b"K" in fields.get(b"flags", b"") and fields.get(b"pos", b"").isdigit():
            when = total + pts - first_pts
            if not anchors or when - anchors[-1].time >= 2 - 1e-6:
                raw_pts = (round(pts * 90000) % 2**33) / 90000
                anchors.append(Anchor(round(when, 6), raw_pts, int(fields[b"pos"]), piece))
    if first is not None:
        duration = round(total + previous - first + length, 6)
        if 0 < duration <= MAX_VIDEO_DURATION:
            return Timeline(duration, tuple(anchors), piece + 1)


def _probe_timeline(probe, source, track, frame, cancel):
    args = [probe, "-v", "error", "-protocol_whitelist", "file", "-f", "mpeg",
            "-skip_estimate_duration_from_pts", "1", "-select_streams", track,
            "-show_entries", "packet=pts_time,dts_time,duration_time,pos,flags:packet_side_data=",
            "-of", "compact=p=0", "-i", source]
    with _launch(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        result = []

        def read():
            result.append(_read_timeline(process.stdout, frame))

        reader = threading.Thread(target=read, name="computer-video-packets")
        deadline = time.monotonic() + 60
        reader.start()
        try:
            while not cancel.is_set():
                if time.monotonic() >= deadline:
                    return None
                if process.poll() is not None:
                    reader.join()
                    return result[0] if result and process.returncode == 0 else None
                cancel.wait(.05)
            raise ConnectionAbortedError()
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            reader.join()


def _index_key(source):
    try:
        info = os.stat(source)
        return os.path.normcase(os.path.abspath(source)), info.st_size, info.st_mtime_ns
    except OSError:
        return None


def _cached_index(key):
    with _index_cache_lock:
        index = _indexes.get(key)
        if index is not None:
            _indexes.move_to_end(key)
        return index


def _remember_index(key, timeline):
    with _index_cache_lock:
        _indexes[key] = timeline
        if len(_indexes) > 32:
            _indexes.popitem(last=False)


class _TimelineStore:
    def __init__(self, directory, limit):
        self.directory = directory
        self.limit = limit
        self.warned = False

    def _warn(self):
        if not self.warned:
            self.warned = True
            _LOG.warning("Computer video index store could not be used.")

    @staticmethod
    def _digest(value):
        return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode("ascii")).hexdigest()

    def _path(self, key):
        return self.directory / (self._digest(key) + ".json")

    def _source_tag(self, key):
        return self._digest((key[0][0], key[1]))

    def read(self, key):
        with _index_store_lock:
            path = self._path(key)
            try:
                ComputerVideo._check_directory(self.directory)
                info = path.lstat()
                if _is_reparse(info) or not stat.S_ISREG(info.st_mode):
                    raise OSError("Expected a regular index file")
                data = json.loads(path.read_text(encoding="utf-8"))
                _, size, mtime_ns = key[0]
                if (data["version"], data["size"], data["mtime_ns"], data["track"], data["source"]) == (
                        _INDEX_VERSION, size, mtime_ns, key[1], self._source_tag(key)):
                    timeline = self._decode(data, size)
                    self._touch(path)
                    return timeline
            except FileNotFoundError:
                return None
            except OSError:
                self._warn()
                return None
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
                self._warn()
            try:
                path.unlink(missing_ok=True)
            except OSError:
                self._warn()
            return None

    @staticmethod
    def _decode(data, size):
        duration, pieces = data["duration"], data["pieces"]
        extends = data["audio_extends_picture"]
        if (type(duration) not in (int, float) or not 0 < duration <= MAX_VIDEO_DURATION
                or type(pieces) is not int or pieces < 1 or type(extends) is not bool
                or not isinstance(data["anchors"], list)):
            raise ValueError("Invalid timeline")
        anchors = []
        for moment, stamp, position, piece in data["anchors"]:
            if (type(moment) not in (int, float) or not math.isfinite(moment)
                    or type(stamp) not in (int, float) or not 0 <= stamp < _PTS_WRAP
                    or type(position) is not int or not 0 <= position < size
                    or type(piece) is not int or not 0 <= piece < pieces):
                raise ValueError("Invalid timeline anchor")
            anchors.append(Anchor(moment, stamp, position, piece))
        return Timeline(duration, tuple(anchors), pieces, extends)

    def _touch(self, path):
        try:
            info = path.lstat()
            if _is_reparse(info) or not stat.S_ISREG(info.st_mode):
                raise OSError("Expected a regular index file")
            os.utime(path)
        except FileNotFoundError:
            pass
        except OSError:
            self._warn()

    def touch(self, key):
        with _index_store_lock:
            try:
                ComputerVideo._check_directory(self.directory)
                self._touch(self._path(key))
            except FileNotFoundError:
                pass
            except OSError:
                self._warn()

    def write(self, key, timeline):
        _, size, mtime_ns = key[0]
        source = self._source_tag(key)
        data = {"source": source, "version": _INDEX_VERSION, "size": size, "mtime_ns": mtime_ns, "track": key[1],
                "duration": timeline.duration, "pieces": timeline.pieces,
                "audio_extends_picture": timeline.audio_extends_picture,
                "anchors": [[a.time, a.stamp, a.position, a.piece] for a in timeline.anchors]}
        with _index_store_lock:
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                ComputerVideo._check_directory(self.directory)
                path = self._path(key)
                _atomic_write_json(path, data)
                self._prune(path, source)
            except OSError:
                self._warn()


    def _prune(self, current, source):
        # The source hash is the first field, so checking for an older
        # fingerprint does not need to read the anchors from other files.
        prefix = f'{{"source":"{source}",'.encode("ascii")
        files = []
        with os.scandir(self.directory) as entries:
            for entry in entries:
                if not re.fullmatch(r"[0-9a-f]{64}\.json", entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or _is_reparse(info):
                        continue
                    path = self.directory / entry.name
                    if path != current:
                        with path.open("rb") as handle:
                            obsolete = handle.read(len(prefix)) == prefix
                        if obsolete:
                            path.unlink(missing_ok=True)
                            continue
                    files.append((info.st_mtime_ns, path))
                except FileNotFoundError:
                    continue
                except OSError:
                    self._warn()
        for _, path in sorted(files)[:max(0, len(files) - self.limit)]:
            path.unlink(missing_ok=True)


def _timeline(probe, source, stream, cancel, *, store=None, checked_store=False):
    while not cancel.is_set():
        if _index_slot.acquire(timeout=.05):
            break
    else:
        raise ConnectionAbortedError()
    try:
        fingerprint = _index_key(source)
        key = (fingerprint, stream["index"])
        cached = _cached_index(key)
        if cached:
            if store:
                store.touch(key)
            return cached
        if store and fingerprint and not checked_store:
            stored = store.read(key)
            if stored is not None:
                _remember_index(key, stored)
                return stored
        frame = 1 / float(_ratio(stream.get("r_frame_rate"), Fraction(25)))
        result = _probe_timeline(probe, source, str(stream["index"]), frame, cancel)
        if cancel.is_set():
            raise ConnectionAbortedError()
        if result is not None and fingerprint and _index_key(source) == fingerprint:
            _remember_index(key, result)
            if store:
                store.write(key, result)
        return result
    except ConnectionAbortedError:
        raise
    except OSError:
        return None
    finally:
        _index_slot.release()


def _program_timeline(probe, source, video, audio, picture_check, reported, origin, cancel, *,
                      store=None, timeline=None):
    if timeline is None:
        timeline = _timeline(probe, source, video, cancel, store=store, checked_store=True)
    # A music DVD can play audio long after its last picture. Measure the
    # selected audio through EOF before using a short continuous picture index.
    if timeline and timeline.pieces == 1 and picture_check and audio and reported - timeline.duration > GRID:
        sound = _timeline(probe, source, audio, cancel, store=store)
        if sound is None:
            return None
        end = sound.duration + max(0, _number(audio.get("start_time"), origin) - origin)
        if end > timeline.duration:
            # Only video keyframes are valid byte-seek anchors.
            return Timeline(end, timeline.anchors, sound.pieces, audio_extends_picture=True)
    return timeline


def _movie_length(executable, source, container, size, reported, video, audio, picture_check, origin, cancel, *,
                  store=None, log_length=True):
    started = time.monotonic()
    duration = reported
    estimated = not duration
    jump = False
    head_rate = 0
    timeline = None
    verdict, reason = "trusted", "reported"
    cancel = cancel or threading.Event()
    probe = str(Path(executable).with_name("ffprobe" + Path(executable).suffix))
    if container.get("format_name") == "mpeg":
        key = (_index_key(source), video["index"])
        cached = _cached_index(key)
        stored = store.read(key) if store and key[0] and cached is None else None
        if stored is not None:
            _remember_index(key, stored)
            verdict, reason = "index", "stored"
        else:
            track = "i:" + str(video["id"]) if video.get("id") else str(video["index"])
            head_rate, windows = _ps_samples(probe, source, size, track, cancel)
            # A previous prepare may have indexed after a transient sample failure.
            verdict, reason = _ps_length_verdict(size, reported, head_rate, windows, indexed=cached is not None)
        if verdict == "index":
            timeline = _program_timeline(probe, source, video, audio, picture_check, reported, origin, cancel,
                                         store=store, timeline=stored)
            if timeline:
                duration, jump = timeline.duration, timeline.pieces > 1
                estimated, verdict = False, "indexed"
            else:
                duration = _rate_estimate(size, head_rate, container, 1250)
                estimated, jump, verdict = True, True, "estimated"
    elif estimated:
        duration, jump, head_rate = _estimate_duration(probe, source, size, container, video, cancel)
        verdict, reason = "estimated", "missing"
    if duration <= 0 or (duration < 1 and not audio):
        verdict = "refused"
    if log_length:
        raw_reported = _number(container.get("duration")) or reported or "none"
        _LOG.warning("Computer video length: container=%s size=%d reported=%s head_rate=%.3f verdict=%s "
                     "reason=%s pieces=%d seconds=%s probe_ms=%.0f",
                     container.get("format_name") or "unknown", size, raw_reported, head_rate,
                     verdict, reason, timeline.pieces if timeline else 0, duration, (time.monotonic() - started) * 1000)
    return duration, estimated, jump, timeline


def playable_audio(data):
    streams = [s for s in data.get("streams", []) if isinstance(s, dict) and s.get("codec_type") == "audio"]
    return [(position, stream) for position, stream in enumerate(streams)
            if type(stream.get("index")) is int and stream["index"] >= 0
            and _number(stream.get("channels")) > 0 and _number(stream.get("sample_rate")) > 0]


def movie_info(executable, source, data, audio_index, *, cancel=None, store=None, log_length=True):
    streams = [s for s in data.get("streams", []) if isinstance(s, dict)]
    videos = [s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    audios = [stream for _, stream in playable_audio(data)]
    video = _default_stream(videos)
    audio = _default_stream(audios)
    if audio_index is not None:
        audio = next((s for s in audios if s["index"] == audio_index), None)
        if audio is None:
            raise ApiError(*_AUDIO)
    try:
        container = data.get("format", {})
        origin = _number(container.get("start_time"))
        try:
            size = os.path.getsize(source)
        except OSError:
            size = int(_number(container.get("size")))

        container_end = usable_video_duration(_number(container.get("duration")), size)
        video_end = usable_video_duration(_stream_end(video, origin), size)
        audio_end = usable_video_duration(_stream_end(audio, origin), size)
        selected = [video_end, audio_end] if audio else [video_end]
        duration = (max(selected) if all(selected) else
                    container_end or max(end or 0 for end in selected))
        picture_check = None
        ps = container.get("format_name") == "mpeg"
        if ps and video:
            longest = max(duration, container_end or 0)
            if (video_end and longest - video_end > GRID) or (not video_end and audio_end):
                duration = longest
                video_tracks = [s for s in streams if s.get("codec_type") == "video"]
                track = "i:" + str(video["id"]) if video.get("id") else f"v:{video_tracks.index(video)}"
                picture_check = PictureCheck(size, origin, track)
        w, h = int(video["width"]), int(video["height"])
        if w <= 0 or h <= 0:
            raise ValueError
        duration, estimated, jump, timeline = _movie_length(
            executable, source, container, size, duration, video, audio, picture_check, origin, cancel,
            store=store, log_length=log_length)
        if jump:
            video_end = audio_end = picture_check = None
        elif timeline and not timeline.audio_extends_picture:
            # A stale stream end would clone the picture on later seeks even
            # though the index found continuous video through the final packet.
            video_end, picture_check = duration, None
        check_video_length(duration, audio)
        if duration <= 0:
            raise ValueError
        fps = min(Fraction(60), _ratio(video.get("r_frame_rate"), _ratio(video.get("avg_frame_rate"), Fraction(25))))
        dar = _ratio(video.get("display_aspect_ratio"), Fraction(w, h) * _ratio(video.get("sample_aspect_ratio"), 1))
        rotation = next((side["rotation"] for side in video.get("side_data_list", []) if "rotation" in side),
                        video.get("tags", {}).get("rotate", 0))
        if round(float(rotation) / 90) % 2:
            dar, h = 1 / dar, w
        height = min(h, 1080, 1920 / dar)
        width = max(2, 2 * round(height * dar / 2))
        height = max(2, 2 * round(height / 2))
        order = video.get("field_order")
        filters = []
        if order in {"tt", "bb", "tb", "bt"}:
            filters.append("yadif=mode=send_frame")
        elif order != "progressive":
            filters.append("yadif=mode=send_frame:deint=interlaced")
        tone_map = ""
        if video.get("color_transfer") in {"smpte2084", "arib-std-b67"}:
            linear = "zscale=t=linear:npl=100"
            if video.get("color_primaries") in (None, "unknown", "unspecified"):
                linear += ":pin=bt2020"
            if video.get("color_space") in (None, "unknown", "unspecified"):
                linear += ":min=bt2020nc"
            tone_map = linear + ",format=gbrpf32le,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv"
            filters.append(tone_map)
        # MPEG-PS can also omit just the picture duration in a music DVD.
        # Preserve later sparse pictures by decoding this input through EOF.
        video_pad = 2 + max(0, duration - video_end) if video_end is not None else 2
        if picture_check and video_end is None:
            video_pad = duration + 2
        audio_pad = 2 + max(0, (video_end or 0) - audio_end) if audio_end is not None else 2
        filters += [f"scale={width}:{height}", "setsar=1"]
        if jump and timeline and timeline.audio_extends_picture:
            video_pad = duration + 2
        if not jump or (timeline and timeline.audio_extends_picture):
            filters.append(f"tpad=stop_mode=clone:stop_duration={video_pad:g}")
        filters += [f"fps={fps}:start_time=0", "format=yuv420p"]
        # NTSC frames rarely fall on an exact six-second boundary. Move just
        # the first frame across each boundary onto the grid in MPEG-TS ticks.
        if (fps * GRID).denominator != 1:
            filters += ["settb=1/90000", "setpts='if(eq(floor(PTS/540000),floor(PREV_INPTS/540000)),"
                                        "PTS,floor(PTS/540000)*540000)'"]
        return Movie(executable, source, duration, video["index"], audio.get("index"),
                     6 if _number(audio.get("channels")) >= 6 else 2, fps, ",".join(filters), audio_pad,
                     tone_map, video_end, estimated, jump, False, picture_check, timeline, video.get("id"), audio.get("id"),
                     max(0, _number(video.get("start_time"), origin) - origin))
    except ConnectionAbortedError:
        raise
    except (OSError, KeyError, ValueError, TypeError, OverflowError):
        raise ApiError(*_DECODE) from None


def _input(movie: Movie, seconds: float, length=None, *, byte_start=0) -> list[str]:
    source = _ordinary_path(movie.source)
    if len(source.encode("utf-16-le", errors="surrogatepass")) >= 520:
        source = movie.source
    if byte_start:
        return ["-protocol_whitelist", "file,subfile", "-format_whitelist", "mpeg", "-f", "mpeg",
                "-start", str(byte_start), "-skip_estimate_duration_from_pts", "1", "-i", "subfile:" + source]
    return ["-protocol_whitelist", "file", "-format_whitelist", _FORMATS,
            *(["-ss", str(seconds)] if seconds else []), *(["-t", str(length)] if length else []), "-i", source]


def _check_picture(movie, offset, cancel):
    check = movie.picture_check
    if check is None:
        return movie
    # Each command gets its own view of the picture evidence for this offset.
    with check.lock:
        cached = check.offsets.get(offset)
    if cached is not None:
        return replace(movie, video_end=cached[0], picture_from_start=cached[1])
    probe = Path(movie.executable).with_name("ffprobe" + Path(movie.executable).suffix)
    deadline = time.monotonic() + 5
    result = replace(movie)
    if movie.video_end is None:
        target = offset or min(GRID, movie.duration) / 2
        start = int(check.size * target / movie.duration)
        packets = _packet_sample(str(probe), movie.source, start, min(start + (2 << 20), check.size),
                                 check.track, "%+1", deadline, cancel)
        result.picture_from_start = packets == []
    else:
        _check_reported_picture(result, offset, probe, deadline, cancel)
    with check.lock:
        if offset not in check.offsets and len(check.offsets) >= 8:
            check.offsets.pop(next(iter(check.offsets)))
        check.offsets[offset] = (result.video_end, result.picture_from_start)
    return result


def _check_reported_picture(movie, offset, probe, deadline, cancel):
    check = movie.picture_check
    # Only packets later than the advertised end can disprove it. For a long
    # first part, sample halfway through the disputed remainder as well.
    midpoint = movie.duration / 2
    if midpoint <= movie.video_end:
        midpoint = (movie.video_end + movie.duration) / 2
    inconclusive = False
    for target in dict.fromkeys((max(offset, movie.video_end + 1), midpoint)):
        start = int(check.size * target / movie.duration)
        packets = _packet_sample(str(probe), movie.source, start, min(start + (2 << 20), check.size),
                                 check.track, "%+1", deadline, cancel)
        if packets is None or (packets and all(stamp is None for stamp, _, _ in packets)):
            inconclusive = True
        elif any(stamp is not None and stamp > check.origin + movie.video_end for stamp, _, _ in packets):
            movie.video_end = movie.duration
            break
    else:
        # If probing failed, decode the picture through EOF before cloning.
        movie.picture_from_start = inconclusive


def command(movie: Movie, n: int, encoder: str, *, stream=False, cancel=None, retry=False) -> list[str]:
    movie = _check_picture(movie, n * GRID, (cancel or threading.Event()).is_set)
    return _command(movie, n, encoder, stream=stream, retry=retry)


def _command(movie, n, encoder, *, stream, retry):
    offset = n * GRID
    # Accurate input seek is relative to the container start, including for TS.
    # Decode two segments of preroll for open GOP references before trimming.
    # After a clock reset a timestamp seek can land in either recording.
    # Sparse DVD pictures and empty timestamp seeks need the original timeline.
    suspect_end = movie.picture_check and movie.video_end not in (None, movie.duration)
    seek = 0 if retry or movie.timestamp_jump or suspect_end else max(0, n - 2)
    trim = (n - seek) * GRID
    limit = "" if movie.timestamp_jump and not movie.timeline else f":duration={movie.duration - offset:.6f}"
    tone_mapped = movie.tone_map_filters and _hdr_filters(movie.executable)
    filters = movie.filters
    if movie.tone_map_filters and not tone_mapped:
        filters = filters.replace(movie.tone_map_filters + ",", "", 1)
    inputs = _input(movie, seek * GRID)
    audio_input = 0
    video_offset = offset
    video_seek = seek * GRID
    video_track, audio_track = movie.video, movie.audio
    anchor = None
    if movie.timeline and movie.timestamp_jump and not retry and movie.video_id and (movie.audio is None or movie.audio_id):
        anchor = next((a for a in reversed(movie.timeline.anchors) if 0 < a.time <= offset - 2), None)
    if anchor:
        trim = round(offset - anchor.time - movie.video_delay, 6)
        inputs = ["-copyts", *_input(movie, 0, byte_start=anchor.position)]
        video_track = "i:" + movie.video_id
        if movie.audio is not None:
            audio_track = "i:" + movie.audio_id
    elif movie.picture_from_start:
        video_seek = 0
        if movie.audio is not None:
            inputs = _input(movie, 0) + inputs
            audio_input = 1
    elif n and (movie.audio is not None or movie.picture_check) and movie.video_end and offset >= movie.video_end:
        # Decode a bounded tail of the picture on a separate input. Advance
        # into the cloned last frame before starting the local segment clock.
        picture_seek = max(0, movie.video_end - 2) if movie.video_end >= 10 and not (retry or movie.picture_check) else 0
        tail = min(movie.video_end, offset) - picture_seek
        inputs = _input(movie, picture_seek, tail + 1) + (inputs if movie.audio is not None else [])
        filters = (f"tpad=stop_mode=clone:stop_duration=1,trim=start={tail},setpts=PTS-STARTPTS,"
                   + filters)
        audio_input = 1
        video_offset = video_seek = 0
    elif movie.audio is not None and movie.video_end and movie.duration - movie.video_end > GRID:
        inputs = inputs + inputs
        audio_input = 1
    if anchor:
        # Quantize on the continuous frame grid before trimming. An NTSC
        # frame and a six-second boundary rarely share the same timestamp.
        base = anchor.time + movie.video_delay
        # A demuxer opened at this byte may choose a different wrap epoch.
        # Measure the signed distance to the indexed keyframe on the MPEG clock.
        def from_anchor(pts):
            delta = f"({pts}*TB-{anchor.stamp:.6f})"
            return f"round(({delta}-round({delta}/{_PTS_WRAP})*{_PTS_WRAP})/TB)"

        filters = (f"settb=1/90000,setpts={from_anchor('STARTPTS')}+{base:.6f}/TB+N/({movie.fps}*TB),"
                   + filters.replace(":start_time=0", f":start_time={math.floor(anchor.time)}"))
    elif movie.timestamp_jump:
        filters = (f"setpts=STARTPTS+N/({movie.fps}*TB),trim=start={trim},setpts=PTS-{trim}/TB," + filters)
        video_offset = 0

    if video_seek:
        # Quantize frames on the same source timeline as a continuous run.
        # This matters when a six-second offset is a fractional frame.
        filters = (f"settb=1/90000,setpts=PTS+{video_seek}/TB," +
                   filters.replace(":start_time=0", f":start_time={video_seek}"))
    video_filters = (f"{filters},settb=1/90000,trim=start={video_offset}{limit},"
                     f"setpts=PTS-{video_offset}/TB")
    count = segment_count(movie.duration)
    merge_tail = (not movie.timestamp_jump or movie.timeline is not None) and movie.duration > count * GRID
    gop = math.ceil(movie.fps * (GRID + (.1 if merge_tail else 0)))
    force = "expr:gte(t,n_forced*6)"
    if merge_tail:
        force += f"*lt(n_forced,{count - n})"
    audio = []
    if movie.audio is not None:
        clock = "asetpts=STARTPTS+N/SR/TB," if movie.timestamp_jump else ""
        if anchor:
            # A partial first audio PES can carry the next frame's timestamp.
            # Synchronize during preroll, then retain the sequential sample clock.
            clock = (f"asetpts='if(isnan(PREV_INPTS),{from_anchor('PTS')},PREV_OUTPTS+"
                     "if(lt(N,SR)*between((PTS-PREV_INPTS)*TB,-0.5,10),PTS-PREV_INPTS,round(NB_SAMPLES/SR/TB)))',")
        pad = "apad," if movie.timestamp_jump else f"apad=pad_dur={movie.audio_pad:g},"
        resample = "aresample=48000:async=1:first_pts=0" + (":min_hard_comp=0.001" if anchor else "")
        grid_delay = (-offset * 48000) % 1024
        audio_trim = max(0, trim + (grid_delay - 2048) / 48000) if anchor else trim
        audio_limit = f":end={trim + movie.duration - offset:.6f}" if anchor else limit
        audio = ["-map", f"{audio_input}:{audio_track}", "-af", f"{clock}{resample},{pad}"
                 f"atrim=start={audio_trim}{audio_limit},asetpts=PTS-round({trim}/TB)+1024",
                 *(["-bsf:a", "noise=drop=lt(pts\\,0)"] if anchor else []),
                 "-c:a", "aac", "-ar", "48000", "-ac", str(movie.channels),
                 *(["-channel_layout", "5.1"] if movie.channels == 6 else []),
                 "-b:a", "384k" if movie.channels == 6 else "192k"]
    # Force keyframes in local encode time. Offset only the inner TS muxer:
    # applying the offset before HLS segmentation also shifts its cut points.
    ts_options = f"mpegts_copyts=1:output_ts_offset={offset}:avoid_negative_ts=disabled"
    output = (["-hls_flags", "independent_segments+single_file", "-hls_list_size", "1",
               "-hls_segment_filename", "pipe:1", "pipe:2"] if stream else
              ["-hls_flags", "independent_segments+temp_file", "-hls_list_size", "0",
               "-hls_segment_filename", "%d.ts", "working.m3u8"])
    return [movie.executable, "-nostdin", "-hide_banner", "-v", "error", "-y", "-filter_threads", "2",
            *inputs, "-map", f"0:{video_track}", *audio,
            "-sn", "-dn", "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
            "-vf", video_filters, "-c:v", encoder, *_quality(movie.executable, encoder),
            "-threads:v", "4", "-pix_fmt", "yuv420p",
            *(["-fps_mode", "passthrough", "-enc_time_base", "1:90000"] if (movie.fps * GRID).denominator != 1 else []),
            *(["-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", "-color_range", "tv"]
              if tone_mapped else []),
            *(["-shortest"] if movie.audio is not None else []),
            "-bf", "0", "-g", str(gop), "-force_key_frames", force,
            # Wait for both streams before HLS cuts on a video keyframe. A late
            # audio input can deliver the preceding silence in a single burst.
            "-max_interleave_delta", "0", "-muxdelay", "0", "-avoid_negative_ts", "disabled", "-f", "hls", "-hls_time", "6",
            "-hls_segment_type", "mpegts", "-hls_segment_options", ts_options, "-start_number", str(n),
            *output]


_job_lock = threading.Lock()
_job = None
_job_warned = False


def _kill_job():
    global _job
    from ctypes import wintypes
    with _job_lock:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        if _job is None:
            # JOBOBJECT_EXTENDED_LIMIT_INFORMATION (Windows SDK, pointer-sized fields).
            class Basic(ctypes.Structure):
                _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                            ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
                            ("max_ws", ctypes.c_size_t), ("processes", wintypes.DWORD),
                            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                            ("scheduling", wintypes.DWORD)]

            class Extended(ctypes.Structure):
                _fields_ = [("basic", Basic), ("io", ctypes.c_uint64 * 6),
                            ("memory_limits_and_peaks", ctypes.c_size_t * 4)]

            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            _job = kernel.CreateJobObjectW(None, None) or 0
            if _job:
                limits = Extended()
                limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if not kernel.SetInformationJobObject(wintypes.HANDLE(_job), 9, ctypes.byref(limits),
                                                      ctypes.sizeof(limits)):
                    kernel.CloseHandle(wintypes.HANDLE(_job))
                    _job = 0
        return _job


def _warn_job():
    global _job_warned
    with _job_lock:
        if not _job_warned:
            _LOG.warning("Computer video process cleanup unavailable (Windows error %d)", ctypes.get_last_error())
            _job_warned = True


def _create_in_job(args, cwd, flags, job, stdin, stdout, stderr):
    from ctypes import wintypes as win
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class Startup(ctypes.Structure):
        _fields_ = [("cb", win.DWORD), ("reserved_strings", ctypes.c_void_p * 3),
                    ("window", win.DWORD * 7), ("flags", win.DWORD), ("show", win.WORD),
                    ("reserved_size", win.WORD), ("reserved", ctypes.c_void_p),
                    ("stdin", win.HANDLE), ("stdout", win.HANDLE), ("stderr", win.HANDLE),
                    ("attributes", ctypes.c_void_p)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [("process", win.HANDLE), ("thread", win.HANDLE),
                    ("pid", win.DWORD), ("tid", win.DWORD)]

    size = ctypes.c_size_t()
    kernel.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
    attrs = ctypes.create_string_buffer(size.value)
    if not kernel.InitializeProcThreadAttributeList(attrs, 2, 0, ctypes.byref(size)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        # Only inherit the three Popen pipe handles. JOB_LIST associates the
        # child during creation, closing the crash window before assignment.
        handles = tuple(dict.fromkeys((int(stdin), int(stdout), int(stderr))))
        pipes = (win.HANDLE * len(handles))(*handles)
        jobs = (win.HANDLE * 1)(job)
        for attribute, values in ((0x20002, pipes), (0x2000D, jobs)):
            if not kernel.UpdateProcThreadAttribute(attrs, 0, attribute, values, ctypes.sizeof(values), None, None):
                raise ctypes.WinError(ctypes.get_last_error())
        startup = Startup(cb=ctypes.sizeof(Startup), flags=0x100, stdin=int(stdin), stdout=int(stdout),
                          stderr=int(stderr), attributes=ctypes.addressof(attrs))
        result = ProcessInfo()
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(args))
        directory = ctypes.c_wchar_p(os.fspath(cwd)) if cwd is not None else None
        if not kernel.CreateProcessW(None, command_line, None, None, True, flags | 0x80000, None, directory,
                                     ctypes.byref(startup), ctypes.byref(result)):
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(win.HANDLE(result.thread))
        return subprocess.Handle(result.process), result.pid
    finally:
        kernel.DeleteProcThreadAttributeList(attrs)


class _WindowsVideoProcess(subprocess.Popen):
    # Popen owns pipe creation, communicate(), wait(), and handle cleanup.
    # Supply the Win32 job attribute at its process-creation hook.
    def _execute_child(self, args, executable, preexec_fn, close_fds, pass_fds, cwd, env, startupinfo,
                       creationflags, shell, p2cread, p2cwrite, c2pread, c2pwrite, errread, errwrite, *options):
        job = _kill_job()
        if job:
            try:
                self._handle, self.pid = _create_in_job(args, cwd, creationflags, job, p2cread, c2pwrite, errwrite)
            except OSError:
                pass
            else:
                self._child_created = True
                self._close_pipe_fds(p2cread, p2cwrite, c2pread, c2pwrite, errread, errwrite)
                return
        _warn_job()
        super()._execute_child(args, executable, preexec_fn, close_fds, pass_fds, cwd, env, startupinfo,
                               creationflags, shell, p2cread, p2cwrite, c2pread, c2pwrite, errread, errwrite, *options)


def _launch(args, cwd=None, *, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE):
    flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0
    if args[-1] == "pipe:2":
        stdout = subprocess.PIPE
    launch = _WindowsVideoProcess if os.name == "nt" else subprocess.Popen
    return launch(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, creationflags=flags)


def _run_ffmpeg(args, *, timeout, cancelled, cwd=None):
    with _launch(args, cwd, stderr=subprocess.DEVNULL) as process:
        deadline = time.monotonic() + timeout
        try:
            while not cancelled() and time.monotonic() < deadline:
                try:
                    return process.wait(timeout=.05) == 0
                except subprocess.TimeoutExpired:
                    pass
            return False
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()


def _output(args):
    with _launch(args, stdout=subprocess.PIPE) as process:
        try:
            output, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            return b""
        return output if process.returncode == 0 else b""


@lru_cache(maxsize=None)
def _hdr_filters(executable):
    available = _output([executable, "-hide_banner", "-filters"]).split()
    if b"zscale" in available and b"tonemap" in available:
        return True
    _LOG.warning("HDR tone mapping is unavailable in this FFmpeg.")
    return False


@lru_cache(maxsize=None)
def _quality(executable, encoder):
    options = QUALITY[encoder]
    if encoder == "h264_amf":
        help_text = _output([executable, "-hide_banner", "-h", "encoder=h264_amf"]).split()
        for flag in ("-forced_idr", "-forced-idr"):
            if flag.encode() in help_text:
                return [*options, flag, "1"]
    return options


def _idr_on_grid(probe, path, start):
    raw = _output([probe, "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
                   "-show_packets", "-show_data", "-show_entries", "packet=pts_time,data", "-of", "json", str(path)])
    try:
        packet = json.loads(raw)["packets"][0]
        # Strip ffprobe's address and printable columns before reading Annex B NAL units.
        payload = bytes.fromhex("".join(line.split(": ", 1)[1].split("  ", 1)[0]
                                        for line in packet["data"].splitlines() if line))
        first_slice = next(unit[0] & 31 for unit in re.split(b"\\x00\\x00(?:\\x00)?\\x01", payload)
                           if unit and 1 <= unit[0] & 31 <= 5)
        return first_slice == 5 and abs(float(packet["pts_time"]) - start) < 1/90000
    except (ValueError, KeyError, IndexError, StopIteration):
        return False


def probe_encoder(executable, encoder, cancelled):
    movie = Movie(executable, "synthetic", 12, 0, None, 2, Fraction(24), "setsar=1")
    args = command(movie, 0, encoder)
    args[args.index("-protocol_whitelist"):args.index("-map")] = [
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=12"]
    probe = str(Path(executable).with_name("ffprobe" + Path(executable).suffix))
    with tempfile.TemporaryDirectory() as directory:
        return (_run_ffmpeg(args, timeout=12, cancelled=cancelled, cwd=directory)
                and not (Path(directory) / "2.ts").exists()
                and all(_idr_on_grid(probe, Path(directory) / f"{i}.ts", i * GRID) for i in range(2)))


def _open_segment(path):
    if os.name != "nt":
        return path.open("rb")
    # FILE_SHARE_DELETE allows release/fallback while an HTTP response drains.
    import _winapi
    import msvcrt
    handle = _winapi.CreateFile(str(path), 0x80000000, 7, 0, 3, 0x80, 0)
    return os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb")


@dataclass(eq=False)
class Session:
    movie: Movie
    directory: Path
    current: Callable[[], bool]
    lease: object
    last_request: float
    highest: int = -1
    failures: int = 0
    failed_at: int | None = None
    end: int | None = None
    disk_error: bool = False
    blocked_size: int = 0
    blocked_at: int | None = None
    sequence: int = 0
    last_seek: int = 0
    readers: Counter = field(default_factory=Counter)
    software: bool = False
    retry_at: int | None = None
    empty_failed: int | None = None
    hardware_produced: bool = False
    sizes: dict = field(default_factory=dict)
    recent: dict = field(default_factory=dict)
    total: int = 0


class _CacheFull(Exception):
    def __init__(self, size):
        self.size = size


class _SegmentOutput:
    """FFmpeg writes TS to stdout and atomically delimits it with HLS byte ranges on stderr.

    Only Python writes session files. Check the exact byte budget before every
    write, including the unfinished segment. The bounded queue gives the
    encoder backpressure while the worker validates a saved folder or serves a seek.
    """
    def __init__(self, process, work, condition):
        self.process = process
        self.condition = condition
        self.path = work / "pending.tmp"
        self.file = None
        self.chunks = queue.Queue(8)
        self.stopped = threading.Event()
        self.reader = threading.Thread(target=self._read, name="computer-video-output", daemon=True)
        self.pending = b""
        self.line = b""
        self.lengths = {}
        self.offset = self.size = 0
        self.eof = False
        os.set_blocking(process.stderr.fileno(), False)
        self.reader.start()

    def _read(self):
        while not self.stopped.is_set():
            block = self.process.stdout.read1(128 * 1024)
            while not self.stopped.is_set():
                try:
                    self.chunks.put(block, timeout=.05)
                    # Stop may be joining this reader with the condition held.
                    if self.condition.acquire(blocking=False):
                        try:
                            self.condition.notify_all()
                        finally:
                            self.condition.release()
                    break
                except queue.Full:
                    pass
            if not block:
                return

    def _ranges(self):
        while True:
            try:
                block = os.read(self.process.stderr.fileno(), 65536)
            except BlockingIOError:
                break
            except OSError as error:
                if getattr(error, "winerror", None) in (109, 232):  # closed / empty Windows pipe
                    break
                raise
            if not block:
                break
            lines = (self.line + block).split(b"\n")
            self.line = lines.pop()[-4096:]
            for line in lines:
                match = re.fullmatch(rb"#EXT-X-BYTERANGE:(\d{1,20})@(\d{1,20})\r?", line)
                if match and int(match[1]) and int(match[2]) >= self.offset:
                    self.lengths[int(match[2])] = int(match[1])

    def advance(self, ready, reserve):
        # FFmpeg writes the previous range before it starts the next segment.
        # Read ranges AFTER taking bytes out of the pipe, including at EOF.
        while True:
            if not self.pending and not self.eof:
                try:
                    self.pending = self.chunks.get_nowait()
                    self.eof = not self.pending
                except queue.Empty:
                    pass
            self._ranges()
            length = self.lengths.get(self.offset)
            if length == self.size:
                self.file.close()
                self.file = None
                self.path.replace(ready)
                del self.lengths[self.offset]
                self.offset += self.size
                self.size = 0
                return
            if not self.pending:
                if self.eof and self.size and self.process.poll() == 0:
                    raise OSError("Incomplete segment boundary")
                return
            count = len(self.pending) if length is None else min(len(self.pending), length - self.size)
            if count <= 0:
                raise OSError("Invalid segment boundary")
            if not reserve(self.size + count):
                raise _CacheFull(self.size + count)
            if self.file is None:
                self.file = self.path.open("wb")
            self.file.write(self.pending[:count])
            self.size += count
            self.pending = self.pending[count:]

    def close(self):
        self.stopped.set()
        self.reader.join()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.file is not None:
            self.file.close()


@dataclass
class Run:
    session: Session
    process: object
    encoder: str
    next_segment: int
    check_disk_at: float
    start: int
    retry: bool
    confirm_start: bool
    first_size: int = 0
    output: _SegmentOutput | None = None
    tail: bytearray = field(default_factory=bytearray)
    reader: threading.Thread | None = None

    @property
    def needs_start_retry(self):
        return not self.retry and (self.next_segment == self.start or self.first_size > 0)


_encoder_lock = threading.Lock()
_encoder_choices = {}
_hardware_failures = Counter()


class ComputerVideo:
    def __init__(self, cache, *, ffmpeg, probe=run_ffprobe, launch=_launch, encoder_probe=probe_encoder,
                 clock=time.monotonic, limit=CACHE_LIMIT, free_space=None, index_limit=_INDEX_LIMIT):
        self.cache = Path(cache)
        self.index_store = _TimelineStore(self.cache.parent / "computer-video-index", index_limit)
        self.logged_lengths = set()
        self.ffmpeg = ffmpeg
        self.probe = probe
        self.launch = launch
        self.encoder_probe = encoder_probe
        self.encoder_lock = _encoder_lock
        self.encoders = _encoder_choices if encoder_probe is probe_encoder else {}
        self.hardware_failures = _hardware_failures if encoder_probe is probe_encoder else Counter()
        self.free_space = free_space or (lambda path: shutil.disk_usage(path).free)
        self.clock = clock
        self.limit = limit
        self.condition = threading.Condition()
        self.closed = threading.Event()
        self.sessions = {}
        self.seek_generation = 0
        self.probes = set()
        self.probe_slot = threading.BoundedSemaphore(1)
        self.run = self.worker = self.encoder = None
        self.next_check = 0
        self.validator = None
        if self.cache.exists():
            try:
                self._check_directory(self.cache)
                shutil.rmtree(self.cache)
            except OSError as error:
                _LOG.warning("Computer video cache cleanup failed (%s)", type(error).__name__)

    @staticmethod
    def _check_directory(path):
        info = path.lstat()
        if _is_reparse(info) or not stat.S_ISDIR(info.st_mode):
            raise OSError("Expected a regular cache directory")

    def prepare(self, source, current, audio, cancel, *, probe_data=None):
        with self.condition:
            if self.closed.is_set():
                raise ApiError(*_EXPIRED)
            for pending in self.probes:
                pending.set()
            self.probes.add(cancel)
        try:
            while not cancel.is_set():
                if self.probe_slot.acquire(timeout=.1):
                    try:
                        return self._prepare(source, current, audio, cancel, probe_data)
                    finally:
                        self.probe_slot.release()
            raise ConnectionAbortedError()
        finally:
            with self.condition:
                self.probes.discard(cancel)
                self.condition.notify_all()

    def read_probe(self, source, cancel, *, executable=None):
        executable = executable or self.ffmpeg()
        if not executable:
            return None
        probe = Path(executable).with_name("ffprobe" + Path(executable).suffix)
        while not cancel.is_set():
            if _PROBE_SLOTS.acquire(timeout=.05):
                try:
                    return None if cancel.is_set() else self.probe(str(probe), source, cancel)
                finally:
                    _PROBE_SLOTS.release()
        return None

    def _prepare(self, source, current, audio, cancel, probe_data):
        executable = self.ffmpeg()
        if not executable:
            raise ApiError(*_NO_FFMPEG)
        if not current():
            raise ApiError(*_GONE)
        try:
            data = self.read_probe(source, cancel, executable=executable) if probe_data is None else probe_data
        except (ProbeError, OSError):
            raise ApiError(*_DECODE) from None
        if cancel.is_set():
            raise ConnectionAbortedError()
        if not current():
            raise ApiError(*_GONE)
        fingerprint = _index_key(source)
        movie = movie_info(executable, source, data or {}, audio, cancel=cancel, store=self.index_store,
                           log_length=fingerprint not in self.logged_lengths)
        if fingerprint is not None:
            self.logged_lengths.add(fingerprint)
        self._check_space()
        if cancel.is_set():
            raise ConnectionAbortedError()
        if not current():
            raise ApiError(*_GONE)
        return movie

    def _check_space(self):
        path = self.cache
        while not path.exists() and path != path.parent:
            path = path.parent
        if self.free_space(path) < MIN_FREE:
            _LOG.error(_DISK_FULL[2])
            raise ApiError(*_DISK_FULL)

    def _choose_encoder(self, executable):
        with self.encoder_lock:
            if executable not in self.encoders:
                encoder = "libx264"
                for candidate in HARDWARE:
                    if self.closed.is_set():
                        raise ApiError(*_EXPIRED)
                    self._check_space()
                    try:
                        if self.encoder_probe(executable, candidate, self.closed.is_set):
                            encoder = candidate
                            break
                    except OSError:
                        continue
                self.encoders[executable] = encoder
            return self.encoders[executable]

    def register(self, token, movie, current, lease):
        self._check_space()
        with self.condition:
            if self.closed.is_set():
                raise ApiError(*_EXPIRED)
            self.sessions[token] = Session(movie, self.cache / token, current, lease, self.clock())
            if self.worker is None:
                self.worker = threading.Thread(target=self._watch, name="computer-video", daemon=True)
                self.worker.start()

    def _remove_directory(self, directory):
        try:
            self._check_directory(self.cache)
            self._check_directory(directory.parent)
            self._check_directory(directory)
            shutil.rmtree(directory)
        except FileNotFoundError:
            pass
        except OSError as error:
            _LOG.debug("Computer video directory cleanup deferred (%s)", type(error).__name__)

    def _stop(self):
        if self.run is not None:
            process = self.run.process
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            process.wait()
            if self.run.output:
                self.run.output.close()
            if self.run.reader:
                if self.run.reader.ident is not None:
                    self.run.reader.join()
                process.stderr.close()
            self._remove_directory(self.run.session.directory / "work")
            self.run = None
            self.condition.notify_all()

    def _discard(self, token):
        session = self.sessions.pop(token, None)
        if session:
            if self.run and self.run.session is session:
                self._stop()
            self._remove_directory(session.directory)
        self.condition.notify_all()

    def discard(self, token):
        with self.condition:
            self._discard(token)

    def _start(self, token, session, n, deadline, client_gone):
        self.seek_generation += 1
        generation = self.seek_generation
        retry = session.retry_at == n
        self._stop()
        try:
            self._check_space()
        except ApiError:
            session.disk_error = True
            self.condition.notify_all()
            raise
        executable = session.movie.executable
        encoder = ("libx264" if session.software or self.hardware_failures[executable] >= 2
                   else self._choose_encoder(executable))
        self.encoder = encoder
        work = session.directory / "work"
        try:
            for path in (self.cache, session.directory, work):
                path.mkdir(parents=True, exist_ok=True)
                self._check_directory(path)
            # Old partial segments and unpublished output must never satisfy a seek.
            for path in work.iterdir():
                path.unlink()
            if client_gone():
                raise ConnectionAbortedError()
            if time.monotonic() >= deadline:
                return None
            movie = session.movie
            if movie.picture_check:
                def cancelled():
                    return (self.closed.is_set() or self.sessions.get(token) is not session
                            or self.seek_generation != generation or client_gone())

                self.condition.release()
                try:
                    movie = _check_picture(movie, n * GRID, cancelled)
                except ConnectionAbortedError:
                    movie = None
                finally:
                    self.condition.acquire()
                if self.sessions.get(token) is not session:
                    raise ApiError(*_EXPIRED)
                if self.seek_generation != generation:
                    return None
                if movie is None:
                    raise ConnectionAbortedError()
            args = _command(movie, n, encoder, stream=True, retry=retry)
            if client_gone() or self.closed.is_set():
                raise ConnectionAbortedError()
            if time.monotonic() >= deadline:
                return None
            process = self.launch(args, work)
        except ConnectionAbortedError:
            raise
        except OSError as error:
            self._failure(session, n, encoder, type(error).__name__)
            return None
        if retry:
            session.retry_at = None
        confirm_start = not retry and n + 1 < segment_count(movie.duration)
        self.run = Run(session, process, encoder, n, self.clock() + 5, n, retry, confirm_start)
        if getattr(process, "stdout", None):
            try:
                self.run.output = _SegmentOutput(process, work, self.condition)
            except (OSError, RuntimeError) as error:
                self._stop()
                process.stdout.close()
                process.stderr.close()
                self._failure(session, n, encoder, type(error).__name__)
                return None
        elif process.stderr:
            self.run.tail, self.run.reader = _stderr_reader(process)
            try:
                self.run.reader.start()
            except RuntimeError:
                self._stop()
                self._failure(session, n, encoder, "could not start stderr reader")
                return None
        self.condition.notify_all()
        return self.run

    @staticmethod
    def _retry_from_start(run, reason):
        run.session.retry_at = run.start
        if reason:
            run.session.software |= run.encoder != "libx264"
            _LOG.warning("Computer video retrying segment %d from the start (%s, %s)", run.start, run.encoder, reason)

    def _failure(self, session, position, encoder, reason):
        session.failures = session.failures + 1 if session.failed_at == position else 1
        session.failed_at = position
        if encoder != "libx264":
            session.software = True
            if session.hardware_produced:
                self.hardware_failures[session.movie.executable] += 1
            try:
                self._clear_segments(session)
            except OSError:
                session.failures = 3
                session.sizes.clear()
                _LOG.warning("Computer video cache cleanup failed")
        _LOG.warning("Computer video segment failed (%s, %s, attempt %d)", encoder, reason, session.failures)
        self.condition.notify_all()

    @staticmethod
    def _clear_segments(session):
        # Readers share delete access. Retire the name before removing an
        # open file so the new run can immediately publish the same segment.
        for i in list(session.sizes):
            path = session.directory / f"{i}.ts"
            retired = path.with_suffix(f".{session.sequence}.retired")
            try:
                path.replace(retired)
                retired.unlink()
            except FileNotFoundError:
                pass
            session.total -= session.sizes.pop(i)
        session.recent.clear()

    def _trim(self, session, reserve=0):
        now = self.clock()
        session.recent = {i: t for i, t in session.recent.items() if now - t < 30}
        if session.total + reserve > self.limit:
            for i, size in list(session.sizes.items()):
                if (i not in session.recent and not session.readers[i]
                        and not session.highest < i <= session.highest + 5):
                    try:
                        (session.directory / f"{i}.ts").unlink(missing_ok=True)
                    except OSError:
                        continue
                    session.total -= size
                    del session.sizes[i]
                    if session.total + reserve <= self.limit:
                        break
        return session.total + reserve <= self.limit

    def _poll(self):
        run = self.run
        if run is None:
            return
        session = run.session
        if self.clock() >= run.check_disk_at:
            try:
                self._check_space()
            except (ApiError, OSError):
                session.disk_error = True
                self._stop()
                return
            run.check_disk_at = self.clock() + 5
        code = run.process.poll()
        while True:
            i = run.next_segment
            ready = session.directory / "work" / f"{i}.ts"
            try:
                if run.output:
                    run.output.advance(ready, lambda reserve: self._trim(session, run.first_size + reserve))
                size = _regular_info(ready).st_size
                if not size and code in (0, None):
                    break
                if not size:
                    raise OSError("Empty segment")
                reserve = run.first_size + size
                if not self._trim(session, reserve):
                    session.blocked_at = run.start if run.first_size else i
                    session.blocked_size = reserve
                    self._stop()
                    return
                if run.confirm_start and i == run.start:
                    # A broken seek can close a singleton playlist successfully.
                    # Keep that file in work until the next segment confirms it.
                    run.first_size = size
                    run.next_segment += 1
                    continue
                if run.first_size:
                    first = ready.with_name(f"{run.start}.ts")
                    first.replace(session.directory / first.name)
                    session.sizes[run.start] = run.first_size
                    session.total += run.first_size
                    run.first_size = 0
                if i in session.sizes:
                    ready.unlink()
                else:
                    ready.replace(session.directory / ready.name)
                    session.sizes[i] = size
                    session.total += size
            except FileNotFoundError:
                break
            except _CacheFull as full:
                session.blocked_at = run.start if run.first_size else i
                session.blocked_size = run.first_size + full.size
                self._stop()
                return
            except OSError as error:
                self._stop()
                if run.needs_start_retry:
                    self._retry_from_start(run, type(error).__name__)
                else:
                    self._failure(session, run.next_segment, run.encoder, type(error).__name__)
                return
            session.hardware_produced |= run.encoder != "libx264"
            session.retry_at = None
            run.next_segment += 1
            session.failures = 0
            self.condition.notify_all()
            if i >= session.highest + 20:
                self._stop()
                return
        if code is not None and (not run.output or run.output.eof):
            self._stop()
            if run.needs_start_retry:
                self._retry_from_start(run, f"exit {code}" if code else None)
            elif code:
                self._failure(session, run.next_segment, run.encoder, f"exit {code} at segment {run.next_segment}")
            elif run.next_segment == run.start and run.start < segment_count(session.movie.duration) - 2:
                session.empty_failed = run.start
                session.retry_at = None
            else:
                session.end = min(run.next_segment, segment_count(session.movie.duration))
        elif self.clock() - session.last_request >= 60:
            self._stop()
        elif not run.output:
            partial = ready.with_suffix(".ts.tmp")
            try:
                size = _regular_info(partial).st_size
                if not self._trim(session, run.first_size + size):
                    session.blocked_at = run.start if run.first_size else i
                    session.blocked_size = run.first_size + size
                    self._stop()
            except FileNotFoundError:
                pass
            except OSError as error:
                self._stop()
                self._failure(session, run.next_segment, run.encoder, type(error).__name__)

    def _validate(self, token, session):
        try:
            current = session.current()
        except OSError:
            current = False
        with self.condition:
            if not current and self.sessions.get(token) is session:
                self._discard(token)

    def _watch(self):
        with self.condition:
            while self.sessions and not self.closed.is_set():
                now = self.clock()
                for token, s in list(self.sessions.items()):
                    if now >= self.next_check and not (self.validator and self.validator.is_alive()):
                        self.sessions[token] = self.sessions.pop(token)
                        self.next_check = now + 5
                        self.validator = threading.Thread(target=self._validate, args=(token, s),
                                                          name="computer-video-source", daemon=True)
                        self.validator.start()
                        self._trim(s)
                    if not s.lease.active and s.lease.expires <= self.clock():
                        self._discard(token)
                self._poll()
                self.condition.wait(.05 if self.run else .5)
            self.worker = None

    def _segment(self, token, s, n, sequence, deadline, head, client_gone):
        attempted = None
        while self.sessions.get(token) is s and not self.closed.is_set():
            if s.disk_error:
                raise ApiError(*_DISK_FULL)
            if n < 0 or n >= (s.end if s.end is not None else segment_count(s.movie.duration)):
                raise ApiError(*_END)
            run = self.run
            if n in s.sizes:
                try:
                    path = s.directory / f"{n}.ts"
                    _regular_info(path)
                    stream = _open_segment(path)
                except FileNotFoundError:
                    self._discard(token)
                    raise ApiError(*_EXPIRED) from None
                if not head:
                    s.highest = max(s.highest, n)
                    s.recent[n] = self.clock()
                s.readers[n] += 1
                return stream, s.sizes[n], "video/mp2t"
            if s.failures >= 3 or s.empty_failed == n:
                raise ApiError(*_FAILED)
            if head:
                break
            if client_gone():
                raise ConnectionAbortedError()
            remaining = deadline - time.monotonic()
            if attempted and attempted is run and run.needs_start_retry and remaining <= SEGMENT_WAIT / 2:
                self._stop()
                self._retry_from_start(attempted, "seek timeout")
                run = None
            retry_pending = attempted and run is None and s.retry_at == attempted.start
            if retry_pending:
                remaining = SEGMENT_WAIT
                deadline = time.monotonic() + remaining
            if remaining <= 0:
                if attempted and attempted is self.run:
                    self._stop()
                    self._failure(s, attempted.next_segment, attempted.encoder, "timeout")
                break
            start = n
            near = run and run.session is s and ((run.first_size and n == run.start) or run.next_segment <= n <= run.next_segment + 3)
            if near:
                attempted = run
                s.highest = max(s.highest, n)
            elif run is not attempted and attempted is not None:
                # Superseded waiters may attach to a reachable run, but cannot
                # seek back. A failed hardware run gets one software retry.
                if run:
                    break
                if retry_pending:
                    start = attempted.start
                elif attempted.encoder == "libx264" or not s.software:
                    break
                attempted = None
            if not near and attempted is None:
                if sequence < s.last_seek:
                    break
                s.highest = n
                if n == s.blocked_at and not self._trim(s, s.blocked_size):
                    break
                s.blocked_at = None
                s.blocked_size = 0
                s.last_seek = sequence
                attempted = self._start(token, s, start, deadline, client_gone)
                if attempted is None:
                    if s.failures >= 3:
                        raise ApiError(*_FAILED)
                    break
            s.recent[n] = self.clock()
            self.condition.wait(min(.1, remaining))
        if self.sessions.get(token) is not s:
            raise ApiError(*_EXPIRED)
        raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_SEGMENT_PENDING",
                       "This segment is not ready.", retryable=True)

    @contextmanager
    def open(self, token, n, *, head=False, client_gone=lambda: False):
        deadline = time.monotonic() + SEGMENT_WAIT
        with self.condition:
            s = self.sessions.get(token)
            if not s:
                raise ApiError(*_EXPIRED)
            s.sequence += 1
            sequence = s.sequence
        valid = s.current()
        with self.condition:
            if self.sessions.get(token) is not s:
                raise ApiError(*_EXPIRED)
            if not valid:
                self._discard(token)
                raise ApiError(*_EXPIRED)
            s.last_request = self.clock()
            if s.disk_error:
                raise ApiError(*_DISK_FULL)
            if n is None:
                data = playlist(s.movie.duration)
                result = io.BytesIO(data), len(data), "application/vnd.apple.mpegurl"
            else:
                self._poll()
                result = self._segment(token, s, n, sequence, deadline, head, client_gone)
        try:
            with result[0]:
                yield result
        finally:
            with self.condition:
                if n is not None:
                    s.readers[n] -= 1
                    if not s.readers[n]:
                        del s.readers[n]
                if self.sessions.get(token) is not s:
                    self._remove_directory(s.directory)

    def shutdown(self, timeout):
        deadline = time.monotonic() + timeout
        self.closed.set()
        with self.condition:
            for cancel in self.probes:
                cancel.set()
            for token in list(self.sessions):
                self._discard(token)
            worker, validator = self.worker, self.validator
            self.condition.notify_all()
            drained = self.condition.wait_for(lambda: not self.probes, max(0, deadline - time.monotonic()))
        if worker:
            worker.join(max(0, deadline - time.monotonic()))
        if validator:
            validator.join(max(0, deadline - time.monotonic()))
        return drained and not any(thread and thread.is_alive() for thread in (worker, validator))
