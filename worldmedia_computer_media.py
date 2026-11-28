"""Short-lived playback URLs for files in the Computer library."""
from __future__ import annotations

import hmac
import os
import re
import secrets
import stat
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from http import HTTPStatus
from os import fstat
from pathlib import Path

from worldmedia_computer_convert import ComputerConvert, ConversionLease, converted_duration, needs_conversion
from worldmedia_computer_library import _file_probe_fields
from worldmedia_computer_loudness import ComputerLoudness, MAX_AUDIO_DURATION, loudness_result, unavailable
from worldmedia_computer_probe import (
    UNREADABLE_AUDIO, ProbeError, RetryableProbeError, _default_stream, _disposition, _tags, name_fields,
)
from worldmedia_computer_subtitles import (
    ComputerSubtitles, _BUSY, _NOT_FOUND, embedded_subtitles, sidecar_subtitles, track_language, track_title,
)
from worldmedia_computer_tags import read_tags
from worldmedia_computer_video import (
    ComputerVideo, HLS_ROUTE, _AUDIO, _run_ffmpeg, check_video_length, needs_video_conversion, playable_audio,
)
from worldmedia_security import ApiError


MEDIA_ROUTE = "/api/v1/computer/media/"
MEDIA_CHUNK_SIZE = 256 * 1024
TOKEN_TTL = 12 * 60 * 60
STANDBY_TTL = 120
RECENT_REQUEST = 30
MAX_HLS = 4
MAX_TOKENS = 64
_TOKEN = re.compile(r"[0-9a-f]{64}")
_RANGE = re.compile(r"bytes=([0-9]*)-([0-9]*)", re.IGNORECASE | re.ASCII)
_AUDIO_CODECS = {
    "ac3": "AC-3", "eac3": "E-AC-3", "dts": "DTS", "truehd": "TrueHD", "mlp": "MLP",
    "aac": "AAC", "mp3": "MP3", "mp2": "MP2", "flac": "FLAC", "alac": "ALAC",
    "opus": "Opus", "vorbis": "Vorbis", "wmav2": "WMA", "wmapro": "WMA", "wmalossless": "WMA Lossless",
}
_DTS_HD_PROFILES = {"DTS-HD MA", "DTS-HD HRA"}
_AUDIO_LAYOUTS = {1: "Mono", 2: "Stereo", 3: "3.0", 4: "4.0", 5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1"}

# MIME type, extensions, and ffprobe format names for each media kind.
_MIME_TYPES = (
    ("audio/mpeg", "mp3 mp2", "mp3 mp2"),
    ("audio/mp4", "m4a m4b", "mov mp4 m4a m4b"),
    ("audio/aac", "aac", "aac"),
    ("audio/flac", "flac", "flac"),
    ("audio/wav", "wav", "wav"),
    ("audio/aiff", "aiff aif", "aiff"),
    ("audio/ogg", "ogg oga opus", "ogg oga opus"),
    ("audio/x-ms-wma", "wma", "asf asf_o wma"),
    ("audio/x-matroska", "mka", "matroska mka"),
    ("audio/webm", "", "webm"),
    ("video/mp4", "mp4 m4v", "mp4 m4v"),
    ("video/quicktime", "mov", "mov"),
    ("video/webm", "webm", "webm"),
    ("video/x-matroska", "mkv", "matroska mkv"),
    ("video/x-msvideo", "avi", "avi"),
    ("video/x-ms-wmv", "wmv", "asf asf_o wmv"),
    ("video/mpeg", "mpg mpeg vob", "mpeg mpegvideo mpg vob"),
    ("video/mp2t", "ts m2ts mts", "mpegts mpegtsraw ts m2ts mts"),
    ("video/x-flv", "flv", "flv"),
    ("video/ogg", "ogv", "ogg ogv"),
    ("video/3gpp", "3gp 3gpp", "3gp 3gpp"),
)
_EXTENSION_MIME = {ext: mime for mime, extensions, _ in _MIME_TYPES for ext in extensions.split()}
_CONTAINER_MIME = {
    (mime.split("/")[0], alias): mime
    for mime, _, aliases in _MIME_TYPES for alias in aliases.split()
}


def media_mime(entry: dict) -> str:
    ext = (entry.get("ext") or "").lower()
    extension = _EXTENSION_MIME.get(ext)
    if entry["kind"] == "audio":
        extension = {"webm": "audio/webm", "mp4": "audio/mp4"}.get(ext, extension)
    matches = [mime for name in (entry.get("container") or "").lower().split(",")
               if (mime := _CONTAINER_MIME.get((entry["kind"], name.strip())))]
    # ffprobe reports all aliases for shared demuxers such as mov/mp4 and matroska/webm.
    if matches and extension not in matches:
        return matches[0]
    return extension or "application/octet-stream"


def media_range(headers: list[str], size: int) -> tuple[int, int, int]:
    """Return status, starting offset, and response length for a Range request."""
    match = _RANGE.fullmatch(headers[0].strip()) if len(headers) == 1 else None
    if match is None or not any(match.groups()):
        return HTTPStatus.OK, 0, size
    # Only numbers up to size matter. This also handles arbitrarily long digit strings.
    digits = len(str(size)) + 1
    first, last = (int(value.lstrip("0")[:digits] or "0") for value in match.groups())
    if match[1]:
        start, end = first, min(last, size - 1) if match[2] else size - 1
    else:
        start, end = max(0, size - last), size - 1
    if end < start:
        return HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, 0, 0
    return HTTPStatus.PARTIAL_CONTENT, start, end - start + 1


class _RequestCancel(threading.Event):
    def __init__(self, client_gone):
        super().__init__()
        self._client_gone = client_gone

    def is_set(self) -> bool:
        if not super().is_set() and self._client_gone():
            self.set()
        return super().is_set()

    def wait(self, timeout=None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.is_set():
            delay = 0.05 if deadline is None else min(0.05, deadline - time.monotonic())
            if delay <= 0:
                return False
            super().wait(delay)
        return True


def _missing_file() -> ApiError:
    return ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_FILE_GONE", "That file is no longer there.")


def _open_file(folders, folder: dict | None, entry: dict, *, unreadable=None):
    path = folders.allowed_path(folder, entry["rel"])
    if path is None:
        raise _missing_file()
    try:
        handle = open(path, "rb")
        try:
            info = fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise _missing_file()
            return handle, info, path
        except BaseException:
            handle.close()
            raise
    except (FileNotFoundError, NotADirectoryError):
        raise _missing_file() from None
    except OSError:
        raise (unreadable or _missing_file)() from None


def _current_file(folders, entry, source, fingerprint) -> bool:
    checked = folders.allowed_path(folders.saved_folder(entry["folder"]), entry["rel"])
    if checked != source:
        return False
    try:
        current = Path(source).stat()
    except OSError:
        return False
    return (current.st_size, current.st_mtime_ns) == fingerprint


def _audio_choices(data, request):
    candidates = playable_audio(data)
    default = _default_stream([stream for _, stream in candidates]).get("index")
    selected = default
    if request is not None:
        selected = next((stream["index"] for position, stream in candidates if position == request), None)
        if selected is None:
            raise ApiError(*_AUDIO)
    tracks = []
    for number, (position, stream) in enumerate(candidates, 1):
        language, name = track_language(_tags(stream).get("language"))
        label = name or f"Track {number}"
        title = track_title(stream)
        if title and title.casefold() != label.casefold():
            label += f": {title}"
        channels = int(stream["channels"])
        layout = _AUDIO_LAYOUTS.get(channels, f"{channels} ch")
        actual_layout = stream.get("channel_layout") or ""
        if re.fullmatch(r"\d+\.\d+(?:\.\d+)?(?:\([a-z]+\))?", actual_layout):
            layout = actual_layout.partition("(")[0]
        codec = stream.get("codec_name") or ""
        codec_label = "PCM" if codec.startswith("pcm_") else _AUDIO_CODECS.get(codec, codec.upper().replace("_", " "))
        if codec == "dts" and (profile := str(stream.get("profile", "")).upper()) in _DTS_HD_PROFILES:
            codec_label = profile
        details = " ".join(filter(None, (layout, codec_label)))
        tracks.append({"index": position, "label": f"{label} ({details})", "language": language,
                       "codec": codec, "channels": channels, "default": _disposition(stream, "default"),
                       "selected": stream["index"] == selected})
    return tracks, selected, selected != default


@dataclass
class _Playback:
    entry: str
    folder: str
    rel: str
    expires: float
    mime: str
    converted: Path | None = None
    fingerprint: tuple[int, int] | None = None
    lease: ConversionLease | None = None
    registered: float = 0
    last_request: float | None = None
    standby: bool = False
    playback_seconds: float = 0
    active: int = 0
    hls: bool = False


class ComputerMedia:
    def __init__(self, converter: ComputerConvert | None = None, *, video=None, clock=time.monotonic) -> None:
        self._video = video
        self._loudness = ComputerLoudness(video.ffmpeg if isinstance(video, ComputerVideo) else lambda: None)
        self._subtitles = (ComputerSubtitles(video.cache.parent / "computer-subs",
                                            ffmpeg=lambda: video.ffmpeg(), runner=_run_ffmpeg)
                           if isinstance(video, ComputerVideo) else None)
        self._hls_key = secrets.token_bytes(32)
        self._converter = converter
        self._closed = False
        self._clock = clock
        self._tokens: OrderedDict[str, _Playback] = OrderedDict()
        self._lock = threading.Lock()

    def _read_probe(self, library, executable, source, cancel):
        if executable:
            return library._run_probe(executable, source, cancel)
        if isinstance(self._video, ComputerVideo):
            return self._video.read_probe(source, cancel)
        return None

    def _play_probe(self, library, entry, source, cancel, *, refresh):
        video = entry["kind"] == "video"
        executable = library._ffprobe(False)
        if not video and (not executable or not entry["size"]):
            return library.play_properties(entry, source, cancel), None
        if not video:
            root_name = os.path.basename(os.path.dirname(source))
            fields = read_tags(source, entry["ext"], rel=entry["rel"], root_name=root_name, cancel=cancel)
            if fields is not None or cancel.is_set():
                return fields, None
        try:
            data = self._read_probe(library, executable, source, cancel)
        except RetryableProbeError:
            return None, None
        except (ProbeError, OSError):
            if video:
                return None, None
            return {"kind": "audio", "error": UNREADABLE_AUDIO, **name_fields(entry["rel"], "audio", root_name)}, None
        fields = None
        if refresh and data is not None:
            fields = _file_probe_fields(data, entry, os.path.basename(os.path.dirname(source)))
        return fields, data

    def register(self, folders, identity: object, client_gone=lambda: False, convert: bool = False,
                 audio: int | None = None, standby: bool = False) -> dict:
        result = folders.library.entry_with_folder(identity)
        if result is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_ENTRY_NOT_FOUND", "That file is not in the library.")
        entry, folder = result
        try:
            handle, info, source = _open_file(folders, folder, entry)
        except ApiError:
            if folder and folders.connected_root(folder) is None:
                raise ApiError(HTTPStatus.CONFLICT, "COMPUTER_FOLDER_OFFLINE", "That folder is not connected.") from None
            raise
        handle.close()
        size = info.st_size
        fingerprint = (size, info.st_mtime_ns)
        properties = entry
        properties_read = True
        converted = None

        def source_is_current() -> bool:
            return _current_file(folders, entry, source, fingerprint)

        response_entry = probe_data = None
        cancel = _RequestCancel(client_gone)
        refresh = (not entry.get("probed") or entry.get("error") or entry.get("retry")
                   or (entry["size"], entry["mtime"]) != fingerprint or (size == 0 and entry["kind"] == "audio"))
        if refresh or entry["kind"] == "video":
            facts, probe_data = self._play_probe(folders.library, {**entry, "size": size}, source, cancel,
                                                 refresh=refresh)
            if cancel.is_set():
                raise ConnectionAbortedError()
            if not source_is_current():
                raise _missing_file()
            if refresh and (facts is not None or not entry.get("error")):
                response_entry = folders.library.update_play_entry(entry, source, fingerprint, facts, cancel)
                if cancel.is_set():
                    raise ConnectionAbortedError()
                if response_entry is None:
                    raise _missing_file()
                # Native playback can still try the original when probing is unavailable.
                properties_read = response_entry["probed"]
                properties = response_entry

        movie = None
        video_fields = {}
        if properties["kind"] == "video":
            audio_tracks, selected, change_audio = _audio_choices(probe_data or {}, audio)
            if self._video and (convert or change_audio or needs_video_conversion(properties)):
                movie = self._video.prepare(source, source_is_current, selected, cancel, probe_data=probe_data or {})
            elif change_audio:
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_MEDIA_UNAVAILABLE",
                               "The audio track could not be played.", retryable=True)
            elif properties_read and properties.get("probed"):
                has_audio = properties.get("acodec") or properties.get("channels") or properties.get("audio_tracks")
                check_video_length(properties.get("duration"), has_audio)
            embedded = embedded_subtitles(probe_data or {})
            if self._subtitles is not None and probe_data is not None:
                self._subtitles.remember(entry["id"], fingerprint, embedded)
            subtitles = embedded + sidecar_subtitles(folders, folder, entry, source)
            if not source_is_current():
                raise _missing_file()
            video_fields = {"audio_tracks": audio_tracks, "subtitles": [track.public() for track in subtitles]}
        if properties.get("error") and movie is None:
            raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_FILE_UNREADABLE", "This file cannot be read.")
        if convert and not properties_read and properties["kind"] == "audio":
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_PLAY_PROPERTIES_UNAVAILABLE",
                           "This file cannot be read.")

        with self._lock:
            self._prune(self._clock())
        try:
            if (self._converter is not None and properties_read and properties["kind"] == "audio"
                    and (convert or needs_conversion(properties))):
                target = self._converter.target(entry["id"], info, properties)
                self._converter.pin(target)
                converted = target
                size = self._converter.prepare(properties, source, converted, current=source_is_current,
                                               client_gone=client_gone)
                if not source_is_current():
                    raise _missing_file()
                properties = {**properties, "container": "flac", "acodec": "flac"}

            if movie is not None:
                current_entry = folders.library.update_video_duration(entry, fingerprint, movie.duration,
                                                                      movie.duration_estimated,
                                                                      indexed=movie.timeline is not None)
            else:
                current_entry = folders.library.entry(entry["id"])
            if current_entry is None or (current_entry["folder"], current_entry["rel"]) != (entry["folder"], entry["rel"]):
                raise _missing_file()
            mime = media_mime(properties)
            token = secrets.token_hex(32)
            # A progressive element can close its first range after buffering and
            # make its next request much later, near the end of a long track.
            duration = properties.get("duration") or 0
            if converted is not None and not duration:
                duration = converted_duration(converted)
            playback_seconds = duration + 60 if properties["kind"] == "audio" else 0
            with self._lock:
                if self._closed:
                    raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_MEDIA_UNAVAILABLE",
                                   "Playback is unavailable during shutdown.")
                now = self._clock()
                self._prune(now)
                oldest = None
                hls_full = movie is not None and sum(p.hls for p in self._tokens.values()) >= MAX_HLS
                if hls_full or len(self._tokens) >= MAX_TOKENS:
                    oldest = next((key for key, p in self._tokens.items()
                                   if not p.active and (not hls_full or p.hls)
                                   and (p.last_request is None or now - p.last_request >= RECENT_REQUEST)), None)
                    if oldest is None:
                        raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_MEDIA_BUSY",
                                       "Too many files are playing.", retryable=True)
                lease = (self._converter.lease(converted, playback_seconds, standby_seconds=STANDBY_TTL if standby else None)
                         if converted is not None else None)
                expires = now + (STANDBY_TTL if standby else max(TOKEN_TTL, playback_seconds))
                playback = _Playback(entry["id"], entry["folder"], entry["rel"], expires, mime,
                                     converted, fingerprint, lease, registered=now, standby=standby,
                                     playback_seconds=playback_seconds)
                if movie is not None:
                    # An authenticated token distinguishes ended sessions from unknown
                    # links without keeping an unbounded set of expired tokens.
                    token = token[:32] + self._hls_signature(token[:32])
                    playback.hls = True
                    self._video.register(token, movie, source_is_current, playback)
                    if oldest:
                        self._drop(oldest)
                    self._tokens[token] = playback
                    return {"hls": True, "url": HLS_ROUTE + token + "/index.m3u8", "duration": movie.duration,
                            **({"duration_estimated": True} if movie.duration_estimated else {}),
                            "entry": current_entry, "converted": True, **video_fields}
                if oldest:
                    self._drop(oldest)
                self._tokens[token] = playback
            return {"url": MEDIA_ROUTE + token, "mime": mime, "size": size,
                    **{key: properties.get(key) for key in ("kind", "container", "vcodec", "acodec", "duration")},
                    **({"duration_estimated": True} if properties.get("duration_estimated") else {}),
                    **({"converted": True, "format": "flac"} if converted is not None else {}),
                    "entry": response_entry if response_entry is not None else current_entry, **video_fields}
        finally:
            if converted is not None:
                self._converter.unpin(converted)

    def loudness(self, folders, identity: object, client_gone=lambda: False) -> dict:
        self._loudness.check_open()
        library = folders.library
        result = library.entry_with_folder(identity)
        if result is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_ENTRY_NOT_FOUND", "That file is not in the library.")
        entry, folder = result
        handle, info, source = _open_file(folders, folder, entry, unreadable=unavailable)
        handle.close()
        fingerprint = info.st_size, info.st_mtime_ns
        if (entry["size"], entry["mtime"]) != fingerprint:
            raise _missing_file()

        def eligible(item):
            if item["kind"] != "audio":
                raise unavailable()
            duration = item.get("duration") or 0
            if "rg_track_gain" not in item and (item.get("error") or not 0 < duration <= MAX_AUDIO_DURATION):
                raise unavailable()
            return item

        def current():
            latest = library.entry(entry["id"])
            if (latest is None or (latest["folder"], latest["rel"]) != (entry["folder"], entry["rel"])
                    or (latest["size"], latest["mtime"]) != fingerprint
                    or not _current_file(folders, entry, source, fingerprint)):
                raise _missing_file()
            return eligible(latest)

        def publish(gain, peak, cancel):
            latest = current()
            if "rg_track_gain" in latest:
                return latest
            updated = library.update_loudness(entry, fingerprint, gain, peak, cancel)
            if updated is None:
                self._loudness.check_open()
                raise _missing_file()
            return updated

        self._loudness.check_open()
        eligible(entry)
        if "rg_track_gain" in entry:
            return loudness_result(entry)
        return self._loudness.measure(entry, fingerprint, source, current, publish, client_gone)

    def subtitle(self, folders, identity, key, *, client_gone):
        result = folders.library.entry_with_folder(identity)
        if result is None or result[0]["kind"] != "video":
            raise ApiError(*_NOT_FOUND)
        entry, folder = result
        try:
            handle, info, source = _open_file(folders, folder, entry)
        except ApiError:
            raise ApiError(*_NOT_FOUND) from None
        handle.close()
        fingerprint = info.st_size, info.st_mtime_ns
        cancel = _RequestCancel(client_gone)
        if key.startswith("f"):
            tracks = sidecar_subtitles(folders, folder, entry, source)
        elif key.startswith("e"):
            tracks = self._subtitles.embedded(entry["id"], fingerprint) if self._subtitles is not None else None
            if tracks is None:
                try:
                    data = self._read_probe(folders.library, folders.library._ffprobe(False), source, cancel)
                except RetryableProbeError:
                    raise ApiError(*_BUSY, retryable=True) from None
                except (ProbeError, OSError):
                    raise ApiError(*_NOT_FOUND) from None
                if cancel.is_set():
                    raise ConnectionAbortedError()
                tracks = embedded_subtitles(data or {})
                if data is not None and self._subtitles is not None:
                    self._subtitles.remember(entry["id"], fingerprint, tracks)
        else:
            tracks = []
        track = next((track for track in tracks if track.key == key), None)
        if track is None:
            raise ApiError(*_NOT_FOUND)
        if self._subtitles is None:
            raise ApiError(*_BUSY, retryable=True)

        def current():
            saved = folders.saved_folder(entry["folder"])
            paths = [(entry["rel"], source, fingerprint)]
            if track.rel:
                paths.append((track.rel, track.path, track.fingerprint))
            for rel, path, expected in paths:
                if folders.allowed_path(saved, rel) != path:
                    return False
                try:
                    info = os.stat(path)
                except OSError:
                    return False
                if (info.st_size, info.st_mtime_ns) != expected:
                    return False
            return True

        return self._subtitles.read(entry["id"], fingerprint, source, track, current=current, cancel=cancel,
                                    fps=entry.get("fps"))

    def _hls_signature(self, nonce):
        return hmac.digest(self._hls_key, nonce.encode("ascii"), "sha256").hex()[:32]

    def release(self, token, *, hls=True):
        with self._lock:
            playback = self._tokens.get(token)
            if playback and playback.hls == hls:
                self._drop(token)

    def _promote(self, playback, now):
        if playback.standby:
            playback.standby = False
            playback.expires = now + max(TOKEN_TTL, playback.playback_seconds)
            if playback.lease is not None:
                self._converter.promote(playback.lease, playback.playback_seconds)

    def keep(self, token):
        with self._lock:
            now = self._clock()
            self._prune(now)
            playback = self._tokens.get(token)
            if playback and not playback.hls:
                self._promote(playback, now)
                self._touch(token, playback, now)

    @contextmanager
    def open(self, folders, token: str, *, hls=False, head=False, start=False, client_gone=lambda: False):
        segment = None
        if hls:
            match = re.fullmatch(r"([0-9a-f]{64})/(?:index\.m3u8|seg/([0-9]+)\.ts)", token)
            token = match[1] if match else ""
            segment = int((match[2].lstrip("0") or "0")[:10]) if match and match[2] is not None else None
        with self._lock:
            now = self._clock()
            self._prune(now)
            playback = self._tokens.get(token) if _TOKEN.fullmatch(token) else None
            if playback is None or playback.hls != hls:
                if hls and token and hmac.compare_digest(token[32:], self._hls_signature(token[:32])):
                    raise ApiError(HTTPStatus.GONE, "COMPUTER_MEDIA_EXPIRED", "This play link has expired.")
                raise ApiError(HTTPStatus.NOT_FOUND, "COMPUTER_MEDIA_EXPIRED", "This play link has expired.")
            if hls or (start and now > playback.registered):
                self._promote(playback, now)
            playback.active += 1
            self._touch(token, playback, now)
        try:
            if hls:
                with self._video.open(token, segment, head=head, client_gone=client_gone) as result:
                    yield result
                return
            cache = (self._converter.open(playback.converted, playback.lease)
                     if playback.converted is not None else nullcontext())
            with cache as converted:
                result = folders.library.entry_with_folder(playback.entry)
                if result is None:
                    raise _missing_file()
                entry, folder = result
                if (entry["folder"], entry["rel"]) != (playback.folder, playback.rel):
                    raise _missing_file()
                handle, info, _ = _open_file(folders, folder, entry)
                with handle:
                    if (info.st_size, info.st_mtime_ns) != playback.fingerprint:
                        raise _missing_file()
                    if converted is None:
                        yield handle, info.st_size, playback.mime
                        return
                stream, size = converted
                yield stream, size, "audio/flac"
        finally:
            with self._lock:
                playback.active -= 1
                if token in self._tokens:
                    self._touch(token, playback, self._clock())

    def _touch(self, token: str, playback: _Playback, now: float) -> None:
        playback.last_request = now
        if not playback.standby:
            playback.expires = max(playback.expires, now + TOKEN_TTL)
        self._tokens.move_to_end(token)

    def _drop(self, token: str) -> None:
        playback = self._tokens.pop(token)
        if playback.lease is not None:
            self._converter.release(playback.converted, playback.lease)
        if playback.hls:
            self._video.discard(token)

    def _prune(self, now: float) -> None:
        for token in [key for key, value in self._tokens.items() if (value.standby or not value.active) and value.expires <= now]:
            self._drop(token)

    def cancel_folder(self, identity: str) -> None:
        with self._lock:
            for token, playback in list(self._tokens.items()):
                if playback.folder == identity and (playback.hls or playback.lease is not None):
                    self._drop(token)
        if self._converter is not None:
            self._converter.cancel_folder(identity)

    def shutdown(self, timeout: float) -> bool:
        with self._lock:
            self._closed = True
            for token in list(self._tokens):
                self._drop(token)
        deadline = time.monotonic() + timeout
        loudness_stopped = self._loudness.shutdown(max(0, deadline - time.monotonic()))
        subtitles_stopped = self._subtitles is None or self._subtitles.shutdown(max(0, deadline - time.monotonic()))
        stopped = self._video is None or self._video.shutdown(max(0, deadline - time.monotonic()))
        return ((self._converter is None or self._converter.shutdown(max(0, deadline - time.monotonic())))
                and stopped and subtitles_stopped and loudness_stopped)

    def clear(self) -> None:
        with self._lock:
            for token in list(self._tokens):
                self._drop(token)
