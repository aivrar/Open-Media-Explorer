"""Find approved Computer subtitles and deliver bounded, cached WebVTT."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import stat
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs

from worldmedia_computer_convert import _regular_info, _touch
from worldmedia_computer_library import VIDEO_EXTENSIONS, _IDENTITY, _is_reparse, _ordinary_path
from worldmedia_computer_probe import _FORMATS, _disposition, _tags, tag_text
from worldmedia_security import ApiError, validate_authenticated_get


SUBTITLE_ROUTE = "/api/v1/computer/subtitle"
_NOT_FOUND = (HTTPStatus.NOT_FOUND, "COMPUTER_SUBTITLE_NOT_FOUND", "That subtitle is no longer there.")
_UNREADABLE = (HTTPStatus.UNPROCESSABLE_ENTITY, "COMPUTER_SUBTITLE_UNREADABLE", "This subtitle cannot be read.")
_BUSY = (HTTPStatus.SERVICE_UNAVAILABLE, "COMPUTER_SUBTITLE_BUSY", "This subtitle is being prepared.")
_KEY = re.compile(r"[A-Za-z0-9_-]{1,64}")
_SIDECAR_EXTS = {".srt": "srt", ".vtt": "webvtt", ".ass": "ass", ".ssa": "ass", ".sub": None}
_SUB_DIRS = {"subs", "subtitles", "sub"}
_TEXT_CODECS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
_MARKERS = {"forced": "Forced", "sdh": "SDH", "cc": "CC"}
_CACHE_NAME = re.compile(r"[0-9a-f]{64}\.vtt")
_CUE = re.compile(rb"(?m)^\d[\d:.]+ --> \d[\d:.]+[^\r\n]*\r?\n[ \t]*\S")
SIDECAR_LIMIT = 40
SIDECAR_BYTES = 20 * 1024 * 1024
CACHE_LIMIT = 64 * 1024 * 1024
_LOG = logging.getLogger(__name__)

# Two-letter codes, three-letter aliases and the names commonly used in filenames.
_LANGUAGES = """af afr Afrikaans
ar ara Arabic
be bel Belarusian
bg bul Bulgarian
bn ben Bengali
ca cat Catalan
cs ces/cze Czech
da dan Danish
de deu/ger German
el ell/gre Greek
en eng English
es spa Spanish
et est Estonian
fa fas/per Persian
fi fin Finnish
fr fra/fre French
he heb Hebrew
hi hin Hindi
hr hrv Croatian
hu hun Hungarian
id ind Indonesian
it ita Italian
ja jpn Japanese
ko kor Korean
lt lit Lithuanian
lv lav Latvian
mk mkd/mac Macedonian
lv lav Latvian
ms msa/may Malay
nl nld/dut Dutch
no nor Norwegian
pl pol Polish
pt por Portuguese
ro ron/rum Romanian
ru rus Russian
sk slk/slo Slovak
sl slv Slovenian
sr srp Serbian
sv swe Swedish
ta tam Tamil
th tha Thai
tr tur Turkish
uk ukr Ukrainian
vi vie Vietnamese
zh zho/chi Chinese"""
_LANGUAGE_ALIASES = {}
for _line in _LANGUAGES.splitlines():
    _code, _aliases, _name = _line.split()
    for _alias in (_code, *_aliases.split("/"), _name.lower()):
        _LANGUAGE_ALIASES[_alias] = (_code, _name)


def track_language(value):
    value = (tag_text(value) or "").lower().replace("_", "-")
    primary, _, tail = value.partition("-")
    if primary in {"und", "unk", "zxx", "mul"}:
        return "", ""
    if not re.fullmatch(r"(?:[a-z]{2,3}|[a-z]{4,12})(?:-[a-z0-9]{2,8})*", value):
        return "", ""
    if primary not in _LANGUAGE_ALIASES and len(primary) > 3:
        return "", ""
    code, name = _LANGUAGE_ALIASES.get(primary, (primary, primary.upper()))
    return (f"{code}-{tail}", f"{name} ({tail.upper()})") if tail else (code, name)


def track_title(stream):
    title = tag_text(_tags(stream).get("title")) or ""
    return title[:80] if "/" not in title and "\\" not in title else ""


@dataclass(frozen=True)
class Subtitle:
    key: str
    label: str
    language: str
    default: bool = False
    forced: bool = False
    stream: int | None = None
    rel: str = ""
    path: str = ""
    fingerprint: tuple[int, int] | None = None
    demuxer: str = ""

    def public(self):
        return {"key": self.key, "label": self.label, "language": self.language,
                "source": "file" if self.rel else "embedded", "default": self.default, "forced": self.forced}


def embedded_subtitles(data):
    tracks = []
    position = 0
    for stream in data.get("streams", []):
        if not isinstance(stream, dict) or stream.get("codec_type") != "subtitle":
            continue
        position += 1
        index = stream.get("index")
        if stream.get("codec_name") not in _TEXT_CODECS or type(index) is not int or index < 0:
            continue
        language, name = track_language(_tags(stream).get("language"))
        title = track_title(stream)
        label = name or f"Track {position}"
        if title and title.casefold() != label.casefold():
            label += f": {title}"
        forced = _disposition(stream, "forced") or "forced" in title.casefold()
        tracks.append(Subtitle(f"e{index}", label, language, _disposition(stream, "default"), forced, index))
    return tracks


def _names(directory, prefix, longer_stems, *, subfolders=False):
    matches, dirs, indexes = [], [], set()
    try:
        with os.scandir(directory) as entries:
            for item in entries:
                stem, ext = os.path.splitext(item.name.casefold())
                if stem == prefix or stem.startswith(prefix + "."):
                    if subfolders and stem != prefix and ext[1:] in VIDEO_EXTENSIONS:
                        try:
                            if item.is_file(follow_symlinks=False):
                                longer_stems.add(stem)
                        except OSError:
                            continue
                    if ext in _SIDECAR_EXTS:
                        matches.append(item.name)
                    if ext == ".idx":
                        indexes.add(stem)
                if subfolders and item.name.casefold() in _SUB_DIRS:
                    try:
                        info = item.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(info.st_mode) and not _is_reparse(info):
                        dirs.append(item.name)
    except OSError:
        return [], []
    names = [name for name in matches if not (name.casefold().endswith(".sub") and name[:-4].casefold() in indexes)]
    return sorted(names, key=str.casefold), sorted(dirs, key=str.casefold)


_LEGACY_PAGES = {language: page for page, languages in (
    ("cp1251", "ru uk bg sr mk be"), ("cp1253", "el"), ("cp1254", "tr"),
    ("cp1255", "he"), ("cp1256", "ar fa"), ("cp1250", "pl cs sk hu ro hr sl"),
    ("cp1257", "lt lv et"),
) for language in languages.split()}


def _legacy_page(data):
    sample = data[:65536]
    high = len(re.findall(rb"[\xc0-\xff]", sample))
    runs = sum(len(match[0]) for match in re.finditer(rb"[\xc0-\xff]{3,}", sample))
    if runs and runs * 2 > high:
        return "cp1251"
    # Some letters share a byte with a Western accent (e.g. ę / ê).
    # Give these less weight than an interior ł / ą or a caron.
    if re.search(rb"[\xa3\xb3\xb9\x8f\x9f\xbf\xf8]|\x9c(?![iu])", sample, re.I):
        return "cp1250"
    ambiguous = set(sample) & {0xea, 0xf9, 0xe8, 0xec, 0xf2}
    if len(ambiguous) >= 2 and not re.search(rb"[\xe0\xe7\xe9]|o\xf9", sample, re.I):
        return "cp1250"
    return "cp1252"


def _decode_sidecar(data, language=""):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        page = _LEGACY_PAGES.get(language.partition("-")[0], "cp1252") if language else _legacy_page(data)
        return data.decode(page, errors="replace")


def _sub_demuxer(path):
    with open(path, "rb") as handle:
        sample = _decode_sidecar(handle.read(4096)).lstrip()
    if "\x00" in sample:
        return None
    if re.match(r"\{\d+\}\{\d*\}", sample):
        return "microdvd"
    if re.match(r"\[\d+:\d+:\d+\]", sample):
        return "subviewer1"
    if re.match(r"\[(?:information|subtitle)\]|\d+:\d+:\d+\.\d+,", sample, re.I):
        return "subviewer"
    return None


def _sidecar(folders, folder, rel, parts, position):
    path = folders.allowed_path(folder, rel)
    if path is None:
        return None
    try:
        info = _regular_info(Path(path))
        if info.st_size > SIDECAR_BYTES:
            return None
        demuxer = _SIDECAR_EXTS[PurePosixPath(rel).suffix.lower()] or _sub_demuxer(path)
    except OSError:
        return None
    if demuxer is None:
        return None
    fingerprint = info.st_size, info.st_mtime_ns
    key = hashlib.sha256(repr((rel, fingerprint)).encode("utf-8", "surrogatepass")).hexdigest()[:24]
    language, name = next((choice for part in parts if part not in _MARKERS and (choice := track_language(part))[0]),
                          ("", ""))
    flags = dict.fromkeys(_MARKERS[part] for part in parts if part in _MARKERS)
    label = " ".join([name or f"Track {position}", *flags, "(file)"])
    return Subtitle("f" + key, label, language, forced="forced" in parts, rel=rel, path=path,
                    fingerprint=fingerprint, demuxer=demuxer)


def sidecar_subtitles(folders, folder, entry, source):
    rel = PurePosixPath(entry["rel"])
    prefix = rel.stem.casefold()
    directory = Path(source).parent
    longer_stems = set()
    names, subfolders = _names(directory, prefix, longer_stems, subfolders=True)
    tracks = []
    for subfolder in ["", *subfolders]:
        if subfolder:
            names, _ = _names(directory / subfolder, prefix, longer_stems)
        for name in names:
            stem = Path(name).stem.casefold()
            owner = stem
            while owner != prefix and owner not in longer_stems:
                owner = owner.rsplit(".", 1)[0]
            if owner != prefix:
                continue
            suffix = stem[len(prefix):]
            parts = suffix[1:].split(".") if suffix else []
            if any(not part for part in parts):
                continue
            track = _sidecar(folders, folder, (rel.parent / subfolder / name).as_posix(), parts, len(tracks) + 1)
            if track is not None:
                tracks.append(track)
                if len(tracks) == SIDECAR_LIMIT:
                    return tracks
    return tracks


class ComputerSubtitles:
    def __init__(self, cache, *, ffmpeg, runner):
        self.cache = Path(cache)
        self.ffmpeg = ffmpeg
        self.runner = runner
        self.closed = threading.Event()
        self._slot = threading.Condition()
        self._active = False
        self._request = None
        self._metadata_lock = threading.Lock()
        self._embedded = OrderedDict()

    def remember(self, identity, fingerprint, tracks):
        with self._metadata_lock:
            key = identity, fingerprint
            self._embedded[key] = tracks
            self._embedded.move_to_end(key)
            if len(self._embedded) > 64:
                self._embedded.popitem(last=False)

    def embedded(self, identity, fingerprint):
        with self._metadata_lock:
            key = identity, fingerprint
            if key in self._embedded:
                self._embedded.move_to_end(key)
                return self._embedded[key]
        return None

    def shutdown(self, timeout):
        self.closed.set()
        with self._slot:
            self._slot.notify_all()
            return self._slot.wait_for(lambda: not self._active, timeout=max(0, timeout))

    def _check_cancelled(self, cancel):
        if cancel.is_set():
            raise ConnectionAbortedError()
        if self.closed.is_set():
            raise ApiError(*_BUSY, retryable=True)

    def read(self, identity, fingerprint, source, track, *, current, cancel, fps=None):
        selection = identity, fingerprint, track.key
        request = selection, cancel
        acquired = False
        with self._slot:
            self._check_cancelled(cancel)
            if self._request is not None:
                previous, previous_cancel = self._request
                if selection == previous and not previous_cancel.is_set():
                    raise ApiError(*_BUSY, retryable=True)
                previous_cancel.set()
            self._request = request
        try:
            with self._slot:
                # The previous reader cleans up its output before handing over the cache.
                while self._active:
                    self._check_cancelled(cancel)
                    self._slot.wait(0.05)
                self._check_cancelled(cancel)
                acquired = self._active = True
            if not current():
                raise ApiError(*_NOT_FOUND)
            cache_key = (identity, fingerprint, track.key)
            if track.rel:
                cache_key += ("legacy-pages-v2",)
            digest = hashlib.sha256(repr(cache_key).encode("ascii")).hexdigest()
            target = self.cache / (digest + ".vtt")
            self.cache.mkdir(parents=True, exist_ok=True)
            info = self.cache.lstat()
            if not stat.S_ISDIR(info.st_mode) or _is_reparse(info):
                raise OSError("Expected a regular subtitle cache directory")
            try:
                cached = self._read_vtt(target)
            except FileNotFoundError:
                cached = None
            if cached is None:
                cached = self._convert(source, track, target, current, cancel, fps)
            self._check_cancelled(cancel)
            if not current():
                raise ApiError(*_NOT_FOUND)
            _touch(target)
            return cached
        except ConnectionAbortedError:
            raise
        except OSError:
            raise ApiError(*_UNREADABLE) from None
        finally:
            with self._slot:
                if self._request is request:
                    self._request = None
                if acquired:
                    self._active = False
                    self._slot.notify_all()

    @staticmethod
    def _read_vtt(path):
        if not 0 < _regular_info(path).st_size <= CACHE_LIMIT:
            return None
        with path.open("rb") as handle:
            data = handle.read(CACHE_LIMIT + 1)
        if len(data) <= CACHE_LIMIT and data.startswith(b"WEBVTT") and _CUE.search(data):
            return data
        return None

    def _convert(self, source, track, target, current, cancel, fps):
        executable = self.ffmpeg()
        if not executable:
            raise ApiError(*_BUSY, retryable=True)
        success = False
        kind = "file" if track.rel else "embedded"
        timeout = 60 if track.rel else 300
        try:
            with tempfile.TemporaryDirectory() as directory:
                fd, output = tempfile.mkstemp(prefix="subtitle-", suffix=".part", dir=self.cache)
                os.close(fd)
                output = Path(output)
                try:
                    inputs, mapping = self._input(source, track, Path(directory), fps)
                    args = [executable, "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file",
                            "-vn", "-an", "-dn", *inputs, "-map", mapping, "-map_metadata", "-1",
                            "-c:s", "webvtt", "-f", "webvtt", "-fs", str(CACHE_LIMIT), str(output)]
                    self._check_cancelled(cancel)
                    # A reader can report late errors after writing usable cues.
                    started = time.monotonic()
                    complete = self.runner(args, timeout=timeout, cancelled=lambda: self.closed.is_set() or cancel.is_set())
                    self._check_cancelled(cancel)
                    if not current():
                        raise ApiError(*_NOT_FOUND)
                    if not complete and (not track.rel or time.monotonic() - started >= timeout):
                        raise ApiError(*_UNREADABLE)
                    data = self._read_vtt(output)
                    if data is None or len(data) >= CACHE_LIMIT:
                        raise ApiError(*_UNREADABLE)
                    self._trim(target, len(data))
                    output.replace(target)
                    success = True
                    return data
                finally:
                    output.unlink(missing_ok=True)
        finally:
            log = _LOG.info if success else _LOG.warning
            log("Computer subtitle conversion source=%s result=%s", kind, "ready" if success else "failed")

    @staticmethod
    def _input(source, track, directory, fps):
        if not track.rel:
            # Like HLS, ffmpeg's default input clock subtracts the demuxer's
            # start time. Native playback uses the same film-relative clock.
            # Indexed MPEG-PS has no supported embedded text subtitle codec.
            path = _ordinary_path(source)
            if len(path.encode("utf-16-le", errors="surrogatepass")) >= 520:
                path = source
            return ["-format_whitelist", _FORMATS, "-i", path], f"0:{track.stream}"
        with open(track.path, "rb") as handle:
            data = handle.read(SIDECAR_BYTES + 1)
        if len(data) > SIDECAR_BYTES:
            raise ApiError(*_UNREADABLE)
        normalized = directory / ("subtitle" + PurePosixPath(track.rel).suffix.lower())
        normalized.write_text(_decode_sidecar(data, track.language), encoding="utf-8", newline="\n")
        options = ["-f", track.demuxer]
        if track.demuxer == "microdvd" and isinstance(fps, (int, float)) and 0 < fps <= 1000:
            options += ["-subfps", str(fps)]
        # Sidecars already use film time. Keep even a nonzero first cue intact.
        return ["-copyts", *options, "-i", str(normalized)], "0:s:0"

    def _trim(self, target, size):
        files = []
        for path in self.cache.iterdir():
            if path == target or not _CACHE_NAME.fullmatch(path.name):
                continue
            try:
                info = _regular_info(path)
            except OSError:
                continue
            files.append((info.st_mtime_ns, path, info.st_size))
            size += info.st_size
        for _, path, length in sorted(files):
            if size <= CACHE_LIMIT:
                break
            try:
                path.unlink()
            except OSError:
                continue
            size -= length
        if size > CACHE_LIMIT:
            raise OSError("Subtitle cache is full")


def serve_subtitle(handler, method, query, *, media, folders, session_token, client_gone):
    started = False
    try:
        validate_authenticated_get(handler.headers, handler.server.server_port, session_token)
        if method != "GET":
            handler.close_connection = True
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "GET is required.")
        try:
            params = parse_qs(query, strict_parsing=True, max_num_fields=2) if len(query) <= 512 else {}
        except ValueError:
            params = {}
        entry, key = params.get("entry", [""])[0], params.get("key", [""])[0]
        if set(params) != {"entry", "key"} or not _IDENTITY.fullmatch(entry.lower()) or not _KEY.fullmatch(key):
            raise ApiError(*_NOT_FOUND)
        data = media.subtitle(folders, entry, key, client_gone=client_gone)
        handler.send_response(HTTPStatus.OK)
        handler.send_header("Content-Type", "text/vtt; charset=utf-8")
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        handler._send_upstream_safety_headers()
        handler.send_header("X-Request-ID", handler.request_id)
        started = True
        handler.end_headers()
        handler.wfile.write(data)
    except ApiError as error:
        handler._send_api_error(error)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        handler._abort_relay_response()
    except Exception as error:
        handler._computer_response_failed("subtitle", error, started)
