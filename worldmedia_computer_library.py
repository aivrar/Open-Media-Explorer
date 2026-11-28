"""The Computer tab's local media index and background scanner."""
from __future__ import annotations

import bisect
import hashlib
import json
import logging
import math
import os
import re
import secrets
import stat
import threading
import time
from collections import Counter, deque
from concurrent.futures import FIRST_COMPLETED, Future, wait
from contextlib import contextmanager
from datetime import datetime, timezone
from itertools import chain, groupby, islice
from pathlib import Path, PurePosixPath
from queue import SimpleQueue

from worldmedia_computer_probe import (
    PROBE_TIMEOUT, UNREADABLE_AUDIO, ProbeError, RetryableProbeError, _gain_in_range, _peak_in_range,
    absolute_disk_path as _absolute_disk_path, name_fields, numbered_audio_names, probe_fields,
    run_ffprobe, tag_text, video_episode_title,
)
from worldmedia_computer_tags import TAG_EXTENSIONS, TagFileChanged, read_tags
from worldmedia_runtime import _atomic_write_json

COMPUTER_LIBRARY_FILENAME = "computer-library.json"
TAGS_VERSION = 1
MAX_VIDEO_DURATION = 24 * 3600
MIN_VIDEO_BIT_RATE = 50_000
TOO_SHORT = "This file is too short to play."
AUDIO_EXTENSIONS = frozenset("mp3 m4a m4b aac flac wav aiff aif ape wv dsf dff wma opus ogg oga mka ac3 dts mp2 mpc tta".split())
VIDEO_EXTENSIONS = frozenset("mp4 m4v mkv webm avi wmv mov mpg mpeg ts m2ts mts vob flv ogv 3gp divx asf".split())
_MEDIA_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS
_SUBTITLE_EXTENSIONS = {"srt", "vtt", "ass", "ssa"}
_IMAGE_EXTENSIONS = ("jpg", "jpeg", "png", "webp")
_SKIP_DIRECTORIES = {"$recycle.bin", "system volume information", "@eadir"}
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
_SAVE_INTERVAL = 30
_DIRECTORY_TIMEOUT = 2.0
_TAG_STALL_TIMEOUT = 5.0
_SETTLING_NS = 2_000_000_000
_MOVE_LIMIT = 2_000
_MAX_WORKERS = min(3, max(1, (os.cpu_count() or 1) // 2))
_TAG_WORKERS = 4
_PROBE_SLOTS = threading.BoundedSemaphore(3)
_ABANDONED_LIMIT = 8
_ABANDONED_LOCK = threading.Lock()
_ABANDONED_WORKERS: set[threading.Thread] = set()
_ABANDONED_WALKS: set[threading.Thread] = set()
_DRIVE_UNRESPONSIVE = "A drive is not responding. Tags will be read when it answers."
_GENERATION = secrets.token_hex(16)
_NEEDS_FFPROBE = object()
_JOURNAL_REVISIONS = 200
_JOURNAL_IDS = 100_000
_DRIVE_RELATIVE = re.compile(r"^[a-zA-Z]:")
_BAD_PATH_PARTS = frozenset(("", ".", ".."))
_IDENTITY = re.compile(r"[0-9a-f]{24}")
_FOLDER_ID = re.compile(r"[0-9a-f]{32}")
_SYNC_FIELDS = ("size", "mtime")
_COUNT_LIMIT = 2**53
_TEXT_FIELDS = frozenset("error title episode_title artist album album_artist genre composer container acodec vcodec pix_fmt".split())
_INT_FIELDS = frozenset("track track_total disc year season episode bitrate sample_rate bits channels width height cover_stream".split())
_RG_FIELDS = {"rg_track_gain": _gain_in_range, "rg_album_gain": _gain_in_range,
              "rg_track_peak": _peak_in_range, "rg_album_peak": _peak_in_range}
_MEASURED_FIELDS = {"rg_track_gain", "rg_track_peak", "rg_measured"}
_FLOAT_FIELDS = {"duration", "fps"} | _RG_FIELDS.keys()
_BOOL_FIELDS = {"lossless", "has_cover", "retry", "duration_estimated", "duration_validated", "settling"}
_TRACK_FIELDS = {"audio_tracks", "subtitle_tracks"}
_ITEM_FIELDS = (_TEXT_FIELDS | _INT_FIELDS | _FLOAT_FIELDS | _BOOL_FIELDS | _TRACK_FIELDS
                | {"id", "folder", "rel", "size", "mtime", "kind", "ext",
                   "probed", "chapters", "art", "subs", "rg_measured"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ordinary_path(path: str) -> str:
    if os.name == "nt":
        if path[:8].lower() == "\\\\?\\unc\\":
            return "\\\\" + path[8:]
        if path.startswith("\\\\?\\"):
            return path[4:]
    return path


def _file_id(real: str) -> str:
    return hashlib.sha256(_ordinary_path(real).casefold().encode("utf-8", "surrogatepass")).hexdigest()[:24]


def _matches_disk(path: str, fingerprint: tuple[int, int]) -> bool:
    try:
        info = os.lstat(path)
        return (stat.S_ISREG(info.st_mode) and not _is_reparse(info)
                and (info.st_size, info.st_mtime_ns) == fingerprint)
    except OSError:
        return False


def _is_reparse(info: os.stat_result) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def _split(name: str) -> tuple[str, str]:
    stem, ext = os.path.splitext(name)
    return stem.casefold(), ext[1:].casefold()


def _relative(value) -> bool:
    return (isinstance(value, str) and "\0" not in value and "\\" not in value
            and not _DRIVE_RELATIVE.match(value)
            and _BAD_PATH_PARTS.isdisjoint(value.split("/")))


def _count(value) -> bool:
    return type(value) is int and 0 <= value < _COUNT_LIMIT


def _finite(value) -> bool:
    return (type(value) is int and abs(value) < _COUNT_LIMIT) or (type(value) is float and math.isfinite(value))


def _valid_tracks(value) -> bool:
    return isinstance(value, list) and all(
        isinstance(track, dict) and not track.keys() - {"index", "default", "codec", "language", "title"}
        and _count(track.get("index")) and type(track.get("default")) is bool
        and all(tag_text(track[key]) is not None for key in track.keys() & {"codec", "language", "title"})
        for track in value
    )


def _valid_chapters(value) -> bool:
    return isinstance(value, list) and len(value) <= 500 and all(
        isinstance(chapter, dict) and not chapter.keys() - {"start", "title"} and _finite(chapter.get("start"))
        and ("title" not in chapter or tag_text(chapter["title"]) is not None)
        for chapter in value
    )


def _text(value) -> bool:
    return isinstance(value, str)


def _boolean(value) -> bool:
    return type(value) is bool


_FIELD_CHECKS = {
    **dict.fromkeys(_TEXT_FIELDS, _text),
    **dict.fromkeys(_INT_FIELDS, _count),
    **dict.fromkeys(_FLOAT_FIELDS, _finite),
    **dict.fromkeys(_BOOL_FIELDS, _boolean),
    **dict.fromkeys(_TRACK_FIELDS, _valid_tracks),
    "chapters": _valid_chapters,
}


def _valid_row_fields(item: dict) -> bool:
    check_for = _FIELD_CHECKS.get
    for key, value in item.items():
        check = check_for(key)
        if check is not None and not check(value):
            return False
    return True


def _read_index(path: Path) -> tuple[dict[str, dict], int, int, int, dict[str, tuple[int, int]]]:
    if not stat.S_ISREG(path.stat().st_mode):
        raise OSError("The library index is not a regular file.")
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if (not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] not in (1, 2)
            or not _count(data.get("revision"))
            or not isinstance(data.get("items"), list)):
        raise ValueError("Invalid library index.")
    items = {}
    skipped = 0
    for item in data["items"]:
        if not isinstance(item, dict) or item.keys() - _ITEM_FIELDS:
            skipped += 1
            continue
        identity = item.get("id")
        art = item.get("art", {})
        subs = item.get("subs", [])
        if (not isinstance(identity, str) or not _IDENTITY.fullmatch(identity) or identity in items
                or not isinstance(item.get("folder"), str) or not _FOLDER_ID.fullmatch(item["folder"])
                or not _relative(item.get("rel")) or item.get("kind") not in ("audio", "video")
                or not _count(item.get("size")) or type(item.get("mtime")) is not int
                or not -2**63 <= item["mtime"] < 2**63
                or type(item.get("probed")) is not bool or not isinstance(item.get("ext"), str)
                or item["ext"] not in _MEDIA_EXTENSIONS
                or not isinstance(art, dict) or (art and (art.keys() != {"file"} or not _relative(art["file"])))
                or not isinstance(subs, list) or len(subs) > 20 or not all(map(_relative, subs))
                or not _valid_row_fields(item)
                or not 0 <= item.get("duration", 0) <= 10_000_000
                or ((item.get("duration_estimated") or item.get("duration_validated")) and not item.get("duration"))):
            skipped += 1
            continue
        if item["kind"] == "video" and "episode" in item and "episode_title" not in item:
            item["episode_title"] = video_episode_title(item["rel"], item.get("title", ""))
        for key, check in _RG_FIELDS.items():
            if key in item and not check(item[key]):
                del item[key]
        if "rg_measured" in item and (item["rg_measured"] is not True or not _MEASURED_FIELDS <= item.keys()):
            del item["rg_measured"]
        items[identity] = item
    tags_version = data.get("tags_version", 0)
    roots = data.get("roots", {})
    identities = {}
    if isinstance(roots, dict):
        for key, value in roots.items():
            if (_FOLDER_ID.fullmatch(key) and isinstance(value, list) and len(value) == 2
                    and all(type(part) is int and part >= 0 for part in value)):
                identities[key] = tuple(value)
    return items, data["revision"], skipped, tags_version if _count(tags_version) else 0, identities


def _files_in_directory(path: str, cancel: threading.Event) -> tuple[list, list, list, list, int]:
    directories, media, subtitles, images = [], [], [], []
    skipped = 0
    with os.scandir(path) as entries:
        for entry in entries:
            if cancel.is_set():
                break
            if entry.name.startswith("._"):
                skipped += 1
                continue
            stem, ext = _split(entry.name)
            try:
                if entry.is_dir(follow_symlinks=False):
                    if entry.name.startswith(".") or entry.name.casefold() in _SKIP_DIRECTORIES:
                        skipped += 1
                    else:
                        directories.append(entry.name)
                    continue
                if ext not in _MEDIA_EXTENSIONS and ext not in _SUBTITLE_EXTENSIONS and ext not in _IMAGE_EXTENSIONS:
                    continue
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or _is_reparse(info):
                    continue
                if ext in _MEDIA_EXTENSIONS:
                    media.append((entry.name, stem, ext, info))
                elif ext in _SUBTITLE_EXTENSIONS:
                    subtitles.append((entry.name.casefold(), entry.name))
                else:
                    images.append((stem, ext, entry.name))
            except OSError:
                skipped += 1
                if ext in _MEDIA_EXTENSIONS:
                    media.append((entry.name, stem, ext, None))
    return directories, media, sorted(subtitles), sorted(images), skipped


def _sidecars(stem: str, subtitles: list, images: dict, album_art: str | None, only_image: str | None) -> tuple:
    prefix = stem + "."
    start = bisect.bisect_left(subtitles, (prefix,))
    exact, variants = [], []
    for index in range(start, len(subtitles)):
        folded, name = subtitles[index]
        if not folded.startswith(prefix):
            break
        qualifier, dot, _ = folded[len(prefix):].rpartition(".")
        if not dot:
            exact.append(name)
        elif qualifier:
            variants.append(name)
    subs = (exact + variants)[:20]
    video = next((images[key] for key in (stem, stem + "-poster", "poster", "folder", "cover", "movie")
                  if key in images), None)
    audio = next((images[key] for key in ("cover", "folder", "front", "album") if key in images),
                 album_art or only_image)
    return subs, audio, video


def usable_video_duration(end, size):
    if end and 0 < end <= MAX_VIDEO_DURATION and (not size or size * 8 >= end * MIN_VIDEO_BIT_RATE):
        return end
    return None


def mpeg_duration_needs_sample(container, duration, size):
    return container == "mpeg" and duration is not None and duration > 0 and size * 8 > 11_000_000 * duration


def _short_video(item, size):
    if item["kind"] != "video":
        return False
    duration = usable_video_duration(item.get("duration"), size)
    if duration is None:
        return size < 1024**2
    return duration < 1 and not mpeg_duration_needs_sample(item.get("container"), duration, size)


def _file_probe_fields(data, item, root_name, *, numbered=False):
    fields = probe_fields(data, item["rel"], root_name, numbered=numbered)
    if _short_video(fields, item["size"]):
        streams = [s for s in data.get("streams", []) if isinstance(s, dict)]
        for stream in streams:
            if stream.get("codec_type") == "audio":
                break
            try:
                if stream.get("codec_type") == "video" and float(stream.get("duration", 0)) >= 1:
                    break
            except (ValueError, TypeError):
                pass
        else:
            fields["error"] = TOO_SHORT
    return fields


def _keep_play_duration(old: dict, updated: dict) -> None:
    if not (old.get("duration_estimated") or old.get("duration_validated")) or any(old[key] != updated[key] for key in _SYNC_FIELDS):
        return
    size = updated["size"]
    duration = usable_video_duration(updated.get("duration"), size)
    if not duration or "mpeg" in (old.get("container"), updated.get("container")):
        updated["duration"] = old["duration"]
        for flag in ("duration_estimated", "duration_validated"):
            if old.get(flag):
                updated[flag] = True
            else:
                updated.pop(flag, None)
        if old.get("container") == "mpeg" and not updated.get("container"):
            updated["container"] = "mpeg"
        if updated.get("error") == TOO_SHORT and old["duration"] >= 1:
            updated.pop("error")


def _keep_measured(old: dict, updated: dict) -> None:
    if (old.get("rg_measured") and "rg_track_gain" not in updated
            and updated["kind"] == "audio" and not updated.get("error")
            and all(old[key] == updated[key] for key in _SYNC_FIELDS)):
        updated.update({key: old[key] for key in _MEASURED_FIELDS})


def _matches_scan_row(current: dict | None, expected: dict) -> bool:
    # A measurement arriving mid-scan only changes these three fields.
    return current == expected or (
        current is not None and current.get("rg_measured") and "rg_track_gain" not in expected
        and {key: value for key, value in current.items() if key not in _MEASURED_FIELDS}
        == {key: value for key, value in expected.items() if key not in _MEASURED_FIELDS}
    )


def _apply_sidecars(item: dict, subs: list[str], art: str | None) -> dict:
    if (item.get("subs") or []) == subs and (item.get("art") or {}).get("file") == art:
        return item
    updated = dict(item)
    updated.pop("subs", None)
    updated.pop("art", None)
    if subs:
        updated["subs"] = subs
    if art:
        updated["art"] = {"file": art}
    return updated


@contextmanager
def _tag_workers(count, *, abandoned=_ABANDONED_WORKERS, name="computer-tags"):
    queue = SimpleQueue()
    threads = []
    live = set()

    def work():
        thread = threading.current_thread()
        try:
            while (task := queue.get()) is not None:
                future, operation, args = task
                try:
                    future.set_result(operation(*args))
                except BaseException as error:
                    future.set_exception(error)
        finally:
            with _ABANDONED_LOCK:
                live.discard(thread)
                abandoned.discard(thread)

    def submit(operation, *args):
        future = Future()
        queue.put((future, operation, args))
        return future

    try:
        for _ in range(count):
            thread = threading.Thread(target=work, name=name, daemon=True)
            thread.start()
            live.add(thread)
            threads.append(thread)
        yield submit
    finally:
        for _ in threads:
            queue.put(None)
        # Give cooperative readers a chance to close their file or child
        # process. A stuck disk read can outlive this scan.
        deadline = time.monotonic() + 0.2
        for thread in threads:
            thread.join(max(0, deadline - time.monotonic()))
        with _ABANDONED_LOCK:
            abandoned.update(live)


def _tag_reads_blocked() -> bool:
    with _ABANDONED_LOCK:
        return len(_ABANDONED_WORKERS) >= _ABANDONED_LIMIT


class _DirectoryRead:
    def __init__(self, cancel):
        self.cancel = cancel
        self.abandoned = False
        self.progress = time.monotonic()

    def is_set(self):
        self.progress = time.monotonic()
        return self.abandoned or self.cancel.is_set()

    def read(self, path):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or _is_reparse(info):
            return info, None
        return info, _files_in_directory(path, self)


class _DriveStalled(Exception):
    pass


class ComputerLibrary:
    def __init__(self, path: Path, folders, *, ffprobe=None,
                 runner=run_ffprobe, clock=time.monotonic) -> None:
        self.path = path
        self.folders = folders
        self._ffprobe = ffprobe or (lambda refresh: None)
        self._runner = runner
        self._clock = clock
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._save_lock = threading.Lock()
        self._response_lock = threading.Lock()
        self._configuration_lock = threading.Lock()
        self._full_snapshot = None
        self._full_response = None
        self._response_revision = -1
        self._roots = {}
        self._saved_roots = {}
        self._offline_roots = set()
        self._moves = deque(maxlen=_MOVE_LIMIT)
        self._loaded = False
        self._damaged = False
        self._saved_revision = None
        self._tags_version = TAGS_VERSION
        self._saved_tags_version = TAGS_VERSION
        self._loudness_save: threading.Timer | None = None
        self._items: dict[str, dict] = {}
        self._generation = _GENERATION
        self._revision = time.time_ns() // 1_000
        self._journal = deque()
        self._journal_ids = 0
        self._journal_floor = self._revision
        self._counts: Counter[tuple[str, str]] = Counter()
        self._folder_view: list[dict] | None = None
        self._folder_generation = 0
        self._removed: set[str] = set()
        self._retried: set[str] = set()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._closing = False
        self._rescan = False
        self._progress = {"ffprobe": False, **self._scan_progress(scanning=False)}

    @staticmethod
    def _scan_progress(*, scanning: bool) -> dict:
        return {
            "scanning": scanning, "phase": "walking" if scanning else "idle", "folders_done": 0, "folders_total": 0,
            "files_found": 0, "files_to_read": 0, "files_read": 0, "skipped": 0,
            "started": _now() if scanning else None, "finished": None, "last_error": None,
        }

    def load(self) -> None:
        with self._load_lock:
            if self._loaded:
                return
            try:
                items, revision, skipped, tags_version, roots = _read_index(self.path)
            except FileNotFoundError:
                pass
            except (ValueError, RecursionError):
                self._damaged = True
            else:
                self._items = items
                self._roots = self._saved_roots = roots
                # A previous client may have seen revisions ahead of the last save.
                self._revision = max(self._revision, revision + 1)
                self._journal_floor = self._revision
                self._saved_revision = self._revision
                self._tags_version = self._saved_tags_version = tags_version
                self._progress["skipped"] = skipped
                self._counts = Counter((item["folder"], item["kind"]) for item in items.values())
            self._loaded = True

    def _save(self) -> None:
        with self._save_lock:
            with self._lock:
                revision = self._revision
                tags_version = self._tags_version
                roots = self._roots
                if (revision, tags_version, roots) == (self._saved_revision, self._saved_tags_version, self._saved_roots):
                    return
                items = list(self._items.values())
            if self._damaged:
                backup = self.path.with_name(f"{self.path.stem}-unreadable-{secrets.token_hex(8)}.json")
                self.path.replace(backup)
                self._damaged = False
            _atomic_write_json(self.path, {"version": 2, "tags_version": tags_version,
                                           "revision": revision, "items": items, "roots": roots},
                               buffered=True)
            self._saved_revision, self._saved_tags_version, self._saved_roots = revision, tags_version, roots

    def _saved_folder_ids(self) -> set[str]:
        return {folder["id"] for folder in self.folders._snapshot()}

    def _status(self, folder_ids: set[str]) -> dict:
        counts = {kind: sum(self._counts[identity, kind] for identity in folder_ids) for kind in ("audio", "video")}
        return {**self._progress, "generation": self._generation, "revision": self._revision, "counts": counts}

    def _load_for_status(self) -> bool:
        try:
            self.load()
        except OSError:
            with self._lock:
                self._progress["last_error"] = "The library index could not be opened."
            return False
        return True

    def status(self) -> dict:
        loaded = self._load_for_status()
        with self._lock:
            check_ffprobe = loaded and not self._progress["scanning"] and not self._closing
        executable = self._ffprobe(False) if check_ffprobe else None
        folder_ids = self._saved_folder_ids()
        with self._lock:
            if check_ffprobe and not self._progress["scanning"]:
                self._progress["ffprobe"] = bool(executable)
            return self._status(folder_ids)

    def entry(self, identity: object) -> dict | None:
        result = self.entry_with_folder(identity)
        return result[0] if result else None

    def entry_with_folder(self, identity: object) -> tuple[dict, dict] | None:
        if not isinstance(identity, str) or not _IDENTITY.fullmatch(identity.lower()):
            return None
        self.load()
        with self._lock:
            # Published items are replaced, so this reference survives a scan.
            item = self._items.get(identity.lower())
        if item is not None:
            folder = self.folders.saved_folder(item["folder"])
            if folder is not None:
                return item, folder
        return None

    def play_properties(self, entry: dict, path: str, cancel: threading.Event) -> dict | None:
        ext, rel = entry["ext"], entry["rel"]
        root_name = os.path.basename(os.path.dirname(path))
        if entry["kind"] == "audio" and not entry["size"]:
            return {"kind": "audio", "error": UNREADABLE_AUDIO, **name_fields(rel, "audio", root_name)}
        fields = read_tags(path, ext, rel=rel, root_name=root_name, cancel=cancel)
        if fields is not None or cancel.is_set():
            return fields
        executable = self._ffprobe(False)
        if executable:
            try:
                data = self._run_probe(executable, path, cancel)
            except RetryableProbeError:
                return None
            except (OSError, ProbeError):
                if entry["kind"] == "audio":
                    return {"kind": "audio", "error": UNREADABLE_AUDIO, **name_fields(rel, "audio", root_name)}
                return None
            if data is not None:
                return _file_probe_fields(data, entry, root_name)
        return None

    def update_play_entry(self, entry: dict, path: str, fingerprint: tuple[int, int], fields: dict | None,
                          cancel: threading.Event) -> dict | None:
        identity = entry["id"]
        with self._lock:
            old = self._items.get(identity)
            if (cancel.is_set() or old is None or old["folder"] in self._removed
                    or (old["folder"], old["rel"]) != (entry["folder"], entry["rel"])
                    or (old["size"], old["mtime"]) not in ((entry["size"], entry["mtime"]), fingerprint)):
                return None
            if fields is None and old != entry and old["probed"] and (old["size"], old["mtime"]) == fingerprint:
                return old
            updated = {key: old[key] for key in ("id", "folder", "rel", "ext", "kind")}
            properties = fields
            if properties is None:
                root_name = os.path.basename(os.path.dirname(path))
                properties = name_fields(old["rel"], old["kind"], root_name)
            updated.update(properties, size=fingerprint[0], mtime=fingerprint[1], probed=fields is not None)
            if old.get("settling") and (old["size"], old["mtime"]) == fingerprint:
                updated["settling"] = True
            _keep_play_duration(old, updated)
            _keep_measured(old, updated)
            updated = _apply_sidecars(updated, old.get("subs", []), old.get("art", {}).get("file"))
            if updated != old:
                self._items[identity] = updated
                self._counts[old["folder"], old["kind"]] -= 1
                self._counts[updated["folder"], updated["kind"]] += 1
                self._record_changes((identity,))
        self._save()
        return updated

    def update_video_duration(self, entry: dict, fingerprint: tuple[int, int], duration: float,
                              estimated: bool, *, indexed=False) -> dict | None:
        with self._lock:
            old = self._items.get(entry["id"])
            if (old is None or old["folder"] in self._removed
                    or (old["folder"], old["rel"]) != (entry["folder"], entry["rel"])
                    or (old["size"], old["mtime"]) != fingerprint):
                return None
            updated = {**old, "duration": duration}
            if duration >= 1 and updated.get("error") == TOO_SHORT:
                updated.pop("error")
            if indexed:
                updated["container"] = "mpeg"
            if updated.get("container") == "mpeg" and not estimated:
                updated["duration_validated"] = True
            else:
                updated.pop("duration_validated", None)
            if estimated:
                updated["duration_estimated"] = True
            else:
                updated.pop("duration_estimated", None)
            if updated == old:
                return old
            self._items[entry["id"]] = updated
            self._record_changes((entry["id"],))
        self._save()
        return updated

    def update_loudness(self, entry: dict, fingerprint: tuple[int, int], gain: float, peak: float,
                        cancel: threading.Event) -> dict | None:
        identity = entry["id"]
        with self._lock:
            old = self._items.get(identity)
            if (self._closing or cancel.is_set() or old is None or old["folder"] in self._removed
                    or old["kind"] != "audio" or old.get("error")
                    or (old["folder"], old["rel"]) != (entry["folder"], entry["rel"])
                    or (old["size"], old["mtime"]) != fingerprint):
                return None
            if "rg_track_gain" in old:
                return old
            if self._loudness_save is None:
                timer = threading.Timer(_SAVE_INTERVAL, self._save_loudness)
                timer.daemon = True
                timer.start()
                self._loudness_save = timer
            updated = {**old, "rg_track_gain": gain, "rg_track_peak": peak, "rg_measured": True}
            self._items[identity] = updated
            self._record_changes((identity,))
            return updated

    def _save_loudness(self) -> None:
        with self._lock:
            self._loudness_save = None
            if self._closing:
                return
        try:
            self._save()
        except OSError:
            with self._lock:
                self._progress["last_error"] = "The library could not be saved."

    def _run_probe(self, executable: str, path: str, cancel: threading.Event) -> dict | None:
        while not cancel.is_set():
            if _PROBE_SLOTS.acquire(timeout=0.05):
                try:
                    return None if cancel.is_set() else self._runner(executable, path, cancel)
                finally:
                    _PROBE_SLOTS.release()
        return None

    def _invalidate_journal(self) -> None:
        self._full_snapshot = None
        self._revision += 1
        self._journal.clear()
        self._journal_ids = 0
        self._journal_floor = self._revision

    def _record_changes(self, identities) -> None:
        changed = set()
        for identity in identities:
            changed.add(identity)
            if len(changed) > _JOURNAL_IDS:
                self._invalidate_journal()
                return
        if not changed:
            return
        self._full_snapshot = None
        self._revision += 1
        self._journal.append((self._revision, changed))
        self._journal_ids += len(changed)
        while len(self._journal) > _JOURNAL_REVISIONS or self._journal_ids > _JOURNAL_IDS:
            revision, discarded = self._journal.popleft()
            self._journal_floor = max(self._journal_floor, revision)
            self._journal_ids -= len(discarded)

    def snapshot(self, since: int | None = None, gen: str | None = None) -> dict:
        self.load()
        if gen != self._generation:
            since = None
        while True:
            with self._lock:
                generation = self._folder_generation
            folders = [{key: folder[key] for key in ("id", "path", "available")} for folder in self.folders.list()]
            with self._lock:
                if generation != self._folder_generation:
                    continue
                if self._folder_view is not None and self._folder_view != folders:
                    self._invalidate_journal()
                self._folder_view = folders
                version = {"generation": self._generation, "revision": self._revision}
                if since == self._revision:
                    return {**version, "unchanged": True}
                folder_ids = {folder["id"] for folder in folders}
                if since is not None and self._journal_floor <= since < self._revision:
                    changed = set().union(*(ids for revision, ids in self._journal if revision > since))
                    items, removed = [], []
                    for identity in sorted(changed):
                        item = self._items.get(identity)
                        if item is not None and item["folder"] in folder_ids:
                            items.append(item)
                        else:
                            removed.append(identity)
                    return {**version, "delta": True, "items": items, "removed": removed,
                            "folders": folders, "moved": [pair for rev, pair in self._moves if rev > since]}
                if self._full_snapshot is None:
                    items = [item for item in self._items.values() if item["folder"] in folder_ids]
                    self._full_snapshot = {**version, "items": items, "folders": folders,
                                           "moved": [pair for _, pair in self._moves]}
                return self._full_snapshot

    def response_snapshot(self, since, gen, encode_full):
        while True:
            data = self.snapshot(since, gen)
            if data.get("delta") or data.get("unchanged"):
                return data, None
            revision = data["revision"]
            with self._response_lock:
                # A newer request may have reached the encoder first.
                if revision < self._response_revision:
                    continue
                if revision != self._response_revision:
                    self._full_response = encode_full(data)
                    self._response_revision = revision
                return None, self._full_response

    def offline_roots(self) -> set[str]:
        with self._lock:
            return self._offline_roots

    def relocation_sample(self, identity: str, limit: int) -> list[str]:
        self.load()
        with self._lock:
            relative = (item["rel"] for item in self._items.values() if item["folder"] == identity)
            count = sum(self._counts[identity, kind] for kind in ("audio", "video"))
            return list(islice(relative, 0, None, max(1, (count + limit - 1) // limit)))[:limit]

    def relocate_folder(self, identity: str, update_folder) -> dict:
        with self._configuration_lock, self._lock:
            folder = update_folder()
            self._roots = {key: value for key, value in self._roots.items() if key != identity}
            self._offline_roots = self._offline_roots - {identity}
            self._folder_generation += 1
            self._invalidate_journal()
            if self._progress["scanning"]:
                self._removed.add(identity)
                self._rescan = True
            elif not self._closing:
                self._start()
            return folder

    def start(self, *, folder_added: bool = False) -> dict:
        """Start a scan, or queue one after a folder change or while cancelling.

        Repeated requests share one queued scan. Cancel clears that queue.
        """
        loaded = self._load_for_status()
        folder_ids = self._saved_folder_ids()
        with self._lock:
            if not loaded or self._closing:
                return self._status(folder_ids)
            if folder_added:
                self._folder_generation += 1
                self._invalidate_journal()
            if self._progress["scanning"]:
                self._rescan |= folder_added or self._cancel.is_set()
            else:
                self._start()
            return self._status(folder_ids)

    def _start(self) -> None:
        self._prepare_scan()
        try:
            thread = threading.Thread(target=self._run, name="computer-library-scan", daemon=True)
            thread.start()
        except Exception:
            self._progress.update(scanning=False, phase="idle", finished=_now(),
                                  last_error="The library scan could not start.")
        else:
            self._thread = thread

    def _prepare_scan(self) -> None:
        self._cancel = threading.Event()
        self._removed.clear()
        self._progress.update(self._scan_progress(scanning=True))

    def remove_folder(self, identity: str, folder_removed: bool = True) -> None:
        if not self._load_for_status():
            return
        with self._configuration_lock, self._lock:
            if folder_removed:
                self._folder_generation += 1
                self._roots = {key: value for key, value in self._roots.items() if key != identity}
                self._offline_roots = self._offline_roots - {identity}
                self._invalidate_journal()
            scanning = self._progress["scanning"]
            if scanning:
                self._removed.add(identity)
            if folder_removed:
                try:
                    remaining = self.folders._snapshot(strict=True)
                except OSError:
                    self._progress["last_error"] = "The folder list could not be read."
                    return
                if remaining:
                    # Keep existing rows for the next walk to reuse under a remaining root.
                    if scanning:
                        self._rescan = True
                    elif not self._closing:
                        self._start()
                    return
                self._replace_items({})
            else:
                self._replace_items({key: item for key, item in self._items.items() if item["folder"] != identity})
        try:
            self._save()
        except OSError:
            with self._lock:
                self._progress["last_error"] = "The library could not be saved."

    def _request_cancel(self) -> None:
        self._rescan = False
        if self._progress["scanning"]:
            self._cancel.set()
            self._progress["phase"] = "cancelling"

    def cancel(self) -> dict:
        self.load()
        folder_ids = self._saved_folder_ids()
        with self._lock:
            self._request_cancel()
            return self._status(folder_ids)

    def shutdown(self, timeout: float = 12.0) -> bool:
        with self._lock:
            self._closing = True
            self._request_cancel()
            thread = self._thread
            if self._loudness_save is not None:
                self._loudness_save.cancel()
                self._loudness_save = None
        if thread:
            thread.join(timeout=min(2.0, max(0, timeout)))
            if thread.is_alive():
                return False
        try:
            if self._loaded:
                self._save()
        except OSError:
            return False
        return True

    def _replace_items(self, items: dict[str, dict]) -> None:
        # Published items are replaced rather than mutated so shallow snapshots
        # can be serialized after the lock has been released.
        old = self._items
        if items == old:
            return
        self._record_changes(chain((key for key, item in items.items() if old.get(key) != item),
                                   (key for key in old if key not in items)))
        self._items = items
        self._counts = Counter((item["folder"], item["kind"]) for item in items.values())

    def _run(self) -> None:
        while True:
            error = None
            can_rescan = True
            try:
                error = self._scan()
            except OSError:
                error = "The library scan could not finish."
            except Exception:
                error = "The library scan failed."
            except BaseException:
                can_rescan = False
                error = "The library scan failed."
                raise
            finally:
                with self._lock:
                    self._progress.update(scanning=False, phase="idle", finished=_now(), last_error=error)
                    rescan = can_rescan and self._rescan and not self._closing
                    self._rescan = False
                    if rescan:
                        self._prepare_scan()
            if not rescan:
                return

    def _scan(self) -> str | None:
        started = self._clock()
        walked = tag_started = tag_finished = None
        counts = Counter()
        blocked = _tag_reads_blocked()
        try:
            try:
                folders = self.folders.list(include_real=True, strict=True)
            except OSError:
                return "The folder list could not be read."
            pending = self._walk(folders)
            walked = self._clock()
            self._save()
            if self._cancel.is_set():
                return None
            if blocked or _tag_reads_blocked():
                return _DRIVE_UNRESPONSIVE
            waiting = False
            if pending:
                tag_started = self._clock()
                try:
                    executable = self._ffprobe(True)
                    with self._lock:
                        self._progress["ffprobe"] = bool(executable)
                    waiting = self._read_tags(pending, executable, counts)
                except _DriveStalled as stall:
                    with self._lock:
                        self._offline_roots = self._offline_roots | set(stall.args)
                        self._folder_generation += 1
                        self._invalidate_journal()
                    return _DRIVE_UNRESPONSIVE
                finally:
                    tag_finished = self._clock()
                    self._save()
            with self._lock:
                if self._cancel.is_set():
                    return None
                refresh_tags = self._tags_version < TAGS_VERSION
                if refresh_tags:
                    self._tags_version = TAGS_VERSION
            if refresh_tags:
                self._save()
            return "Tags are waiting for FFmpeg." if waiting else None
        finally:
            finished = self._clock()
            with self._lock:
                found = self._progress["files_found"]
            logging.getLogger(__name__).warning(
                "Computer scan: files=%d walk=%.3fs tags=%.3fs in_process=%d ffprobe=%d failed=%d cancelled=%s",
                found, (finished if walked is None else walked) - started,
                0 if tag_finished is None else tag_finished - tag_started,
                counts["in_process"], counts["ffprobe"], counts["failed"], self._cancel.is_set(),
            )

    def _walk(self, folders: list[dict]) -> list[tuple]:
        with self._lock:
            previous = self._items.copy()
            self._progress["folders_total"] = len(folders)
            previous_roots = self._roots
        root_ids, offline = {}, set()
        recent = time.time_ns() - _SETTLING_NS
        old_by_folder = {}
        for key, item in previous.items():
            old_by_folder.setdefault(item["folder"], {})[key] = item

        found, pending, kept = {}, {}, {}
        reserved = {key for folder in folders if folder.get("relocated") for key in old_by_folder.get(folder["id"], {})}
        seen_paths = set() if reserved else None
        for folder in folders:
            identity = folder["id"]
            old = old_by_folder.get(identity, {})
            root = None
            skipped, unreadable = 0, set()
            if folder["available"] and not self._cancel.is_set():
                root = _absolute_disk_path(folder["real"])
            elif not folder["available"]:
                skipped = 1
            if root is not None:
                by_rel = {item["rel"].casefold(): item for item in old.values()}
                with _ABANDONED_LOCK:
                    walk_blocked = len(_ABANDONED_WALKS) >= _ABANDONED_LIMIT
                if walk_blocked:
                    unreadable.add(PurePosixPath())
                    root_id = None
                    skipped = 1
                else:
                    with _tag_workers(1, abandoned=_ABANDONED_WALKS, name="computer-walk") as submit:
                        root_id = self._walk_root(root, identity, found, pending, previous, unreadable, kept,
                                                  by_rel, previous_roots.get(identity), bool(old), recent, submit,
                                                  reserved, seen_paths)
                if root_id is not None:
                    root_ids[identity] = root_id
                elif PurePosixPath() in unreadable:
                    offline.add(identity)
            if root is None or unreadable or self._cancel.is_set():
                for key, item in old.items():
                    if root is None or self._cancel.is_set() or any(
                        part in unreadable for part in PurePosixPath(item["rel"]).parents
                    ):
                        kept[key] = item
            with self._lock:
                self._progress["skipped"] += skipped
                if not self._cancel.is_set():
                    self._progress["folders_done"] += 1
        with self._configuration_lock:
            with self._lock:
                if self._removed:
                    found = {key: item for key, item in found.items() if item["folder"] not in self._removed}
                for key, item in kept.items():
                    current = self._items.get(key, item)
                    if current["folder"] not in self._removed:
                        found.setdefault(key, current)
                # Keep rows from a concurrent remove or relocation for its queued walk.
                if self._removed:
                    for key, item in self._items.items():
                        if item["folder"] in self._removed:
                            found.setdefault(key, item)
                completed = not self._cancel.is_set()
                pairs = self._find_moves(found) if completed else []
            if pairs:
                # Commit stars before discarding their former IDs. Retrying the
                # same migration after an interrupted index save is harmless.
                self.folders.stars.move(pairs)
            with self._lock:
                for key, item in found.items():
                    current, old = self._items.get(key), previous.get(key)
                    if (current is not None and current is not old
                            and (current["folder"], current["rel"]) == (item["folder"], item["rel"])):
                        # Keep a play update unless the walk found a different version of the file.
                        fingerprint = item["size"], item["mtime"]
                        old_fingerprint = (old["size"], old["mtime"]) if old is not None else None
                        if fingerprint in ((current["size"], current["mtime"]), old_fingerprint):
                            found[key] = _apply_sidecars(current, item.get("subs", []), item.get("art", {}).get("file"))
                if completed:
                    offline = (self._offline_roots & self._removed) | (offline - self._removed)
                    if offline != self._offline_roots:
                        self._offline_roots = offline
                        self._folder_generation += 1
                        self._invalidate_journal()
                    self._roots = {**self._roots, **{key: value for key, value in root_ids.items()
                                                    if key not in self._removed}}
                    self._carry_moves(pairs, found, pending, recent)
                self._replace_items(found)
                self._moves.extend((self._revision, pair) for pair in pairs)
                work = [(item, *pending[key]) for key, item in found.items()
                        if item["folder"] not in self._removed and key in pending
                        and (not item["probed"] or item.get("retry") or item.get("settling") or self._refresh_opus(item))]
                self._progress["files_to_read"] = len(work)
        return work

    def _find_moves(self, found: dict) -> list[tuple[str, str]]:
        def unmatched(source, target):
            by_fingerprint = {}
            for key, item in source.items():
                if key not in target and item["folder"] not in self._removed:
                    signature = item["size"], item["mtime"], os.path.normcase(item["rel"].rsplit("/", 1)[-1])
                    by_fingerprint[signature] = None if signature in by_fingerprint else item
            return by_fingerprint

        missing = unmatched(self._items, found)
        if not missing:
            return []
        return [(missing[signature]["id"], new["id"])
                for signature, new in unmatched(found, self._items).items() if new and missing.get(signature)]

    def _carry_moves(self, pairs, found, pending, recent):
        for old_id, key in pairs:
            old, new = self._items[old_id], found[key]
            if (old["probed"] and not old.get("error")
                    and all(old[field] == new[field] for field in _SYNC_FIELDS)):
                carried = {**old, "id": key, "folder": new["folder"], "rel": new["rel"]}
                found[key] = _apply_sidecars(carried, new.get("subs", []), new.get("art", {}).get("file"))
                if not (old.get("retry") or old.get("settling") or old["mtime"] >= recent
                        or self._refresh_opus(old)):
                    pending.pop(key, None)

    def _walk_root(self, root: str, identity: str, found: dict, pending: dict, previous: dict,
                   unreadable: set, kept: dict, by_rel: dict, old_root, has_rows: bool, recent: int, submit,
                   reserved: set, seen_paths: set | None):
        root_name = os.path.basename(root)
        remaining = [""]
        root_id = None
        saw_media = False
        while remaining and not self._cancel.is_set():
            prefix = remaining.pop()
            path = os.path.normpath(os.path.join(root, prefix))
            try:
                operation = _DirectoryRead(self._cancel)
                future = submit(operation.read, path)
                while not future.done():
                    remaining_time = _DIRECTORY_TIMEOUT - (time.monotonic() - operation.progress)
                    if remaining_time <= 0:
                        operation.abandoned = True
                        unreadable.add(PurePosixPath())
                        self._advance_walk(skipped=1)
                        return None
                    wait((future,), timeout=remaining_time)
                info, contents = future.result()
                if contents is None:
                    if not prefix:
                        unreadable.add(PurePosixPath(prefix))
                    self._advance_walk(skipped=1)
                    continue
                directories, media, subtitles, images, skipped = contents
                if not prefix:
                    root_id = (info.st_dev, info.st_ino)
                saw_media |= bool(media)
            except OSError:
                unreadable.add(PurePosixPath(prefix))
                self._advance_walk(skipped=1)
                continue
            for name in directories:
                remaining.append(prefix + name + "/")
            pictures = {}
            for stem, ext, name in sorted(images, key=lambda image: _IMAGE_EXTENSIONS.index(image[1])):
                pictures.setdefault(stem, name)
            album_art = next((name for stem, name in pictures.items() if stem.startswith("albumart")), None)
            numbered = numbered_audio_names([name for name, _, ext, _ in media if ext in AUDIO_EXTENSIONS])
            scanned = 0
            for name, stem, ext, info in media:
                rel = prefix + name
                full_path = os.path.join(path, name)
                path_key = _file_id(full_path)
                if seen_paths is not None and path_key in seen_paths:
                    continue
                known = by_rel.get(rel.casefold())
                key = known["id"] if known is not None else path_key
                if known is None and key in reserved:
                    # A relocated row can own the hash of this file's old absolute path.
                    key = _file_id(full_path + "\0" + identity)
                if key in found:
                    continue
                old = known if known is not None else previous.get(key)
                if info is None:
                    if old:
                        kept[key] = old
                    continue
                kind = "audio" if ext in AUDIO_EXTENSIONS else "video"
                size, mtime = info.st_size, info.st_mtime_ns
                if old and old["size"] == size and old["mtime"] == mtime and not (kind == "video" and size < 1024):
                    item = old if old["folder"] == identity and old["rel"] == rel else {
                        **old, "folder": identity, "rel": rel}
                    if (_short_video(item, info.st_size) and not item.get("error")
                            and not any(item.get(key) for key in ("acodec", "audio_tracks", "channels"))):
                        # Verify older rows against the actual streams before marking them.
                        item = {**item, "probed": False}
                    if item["kind"] == "audio":
                        codec, error = item.get("acodec"), item.get("error")
                        # Recheck older extension-only FLAC guesses and rows with no codec.
                        guessed_flac = (codec == item.get("container") == "flac" and not (
                            item.get("sample_rate") or item.get("channels") or item.get("duration")
                        ))
                        if (not error and (not codec or guessed_flac)
                                or error == UNREADABLE_AUDIO and codec and not item.get("duration")):
                            item = {**item, "probed": False}
                else:
                    item = {"id": key, "folder": identity, "rel": rel, "size": size,
                            "mtime": mtime, "kind": kind, "ext": ext, "probed": False,
                            **name_fields(rel, kind, root_name, numbered=numbered)}
                    if kind == "video" and size < 1024:
                        item.update(error=UNREADABLE_AUDIO, probed=True)
                subs, audio, video = (_sidecars(stem, subtitles, pictures, album_art, images[0][2]
                                               if len(images) == 1 else None)
                                      if subtitles or images else ([], None, None))
                if audio:
                    audio = prefix + audio
                if video:
                    video = prefix + video
                if seen_paths is not None:
                    seen_paths.add(path_key)
                found[key] = _apply_sidecars(item, [prefix + name for name in subs],
                                             audio if item["kind"] == "audio" else video)
                if (not item["probed"] or (item.get("retry") and key not in self._retried)
                        or item.get("settling") or self._refresh_opus(item)):
                    pending[key] = (full_path, root_name, audio, video, numbered, recent)
                scanned += 1
            self._advance_walk(files=scanned, skipped=skipped)

        if root_id is not None and has_rows and not saw_media and root_id != old_root:
            # An empty replacement directory can be a disconnected mount.
            unreadable.add(PurePosixPath())
            return None
        return root_id

    def _refresh_opus(self, item: dict) -> bool:
        return self._tags_version < TAGS_VERSION and item["ext"] == "opus"

    def _advance_walk(self, *, files: int = 0, skipped: int = 0) -> None:
        with self._lock:
            self._progress["files_found"] += files
            self._progress["skipped"] += skipped

    def _probe_item(self, cancel: threading.Event, executable: str | None, item: dict, path: str,
                    root_name: str, audio_art: str | None, video_art: str | None, numbered: bool,
                    recent: int):
        if cancel.is_set():
            return None
        try:
            real = os.path.realpath(path, strict=True)
            if _ordinary_path(real).casefold() != _ordinary_path(path).casefold():
                return None
        except OSError:
            return None
        fingerprint = item["size"], item["mtime"]
        if item["kind"] == "audio" and not item["size"]:
            fields = {"kind": "audio", "error": UNREADABLE_AUDIO,
                      **name_fields(item["rel"], "audio", root_name, numbered=numbered)}
        elif executable is None:
            try:
                fields = read_tags(real, item["ext"], rel=item["rel"], root_name=root_name,
                                   numbered=numbered, cancel=cancel, fingerprint=fingerprint)
            except TagFileChanged:
                return None
            if cancel.is_set():
                return None
            if fields is None:
                return _NEEDS_FFPROBE
        else:
            if not _matches_disk(real, fingerprint):
                return None
            fields = self._probe_with_ffprobe(cancel, executable, item, real, root_name, numbered)
            if fields is None:
                return None
        if (executable is not None or not item["size"] or item["mtime"] >= recent) and not _matches_disk(real, fingerprint):
            return None
        updated = {key: item[key] for key in ("id", "folder", "rel", "size", "mtime", "ext")}
        if item["mtime"] >= recent:
            updated["settling"] = True
        return _apply_sidecars({**updated, **fields, "probed": True}, item.get("subs", []),
                               audio_art if fields["kind"] == "audio" else video_art)

    def _probe_with_ffprobe(self, cancel: threading.Event, executable: str, item: dict, real: str,
                            root_name: str, numbered: bool) -> dict | None:
        try:
            data = self._run_probe(executable, real, cancel)
        except (OSError, ProbeError) as error:
            if cancel.is_set():
                return None
            # Only messages from the built-in runner are suitable for display.
            if item["kind"] == "audio" and not isinstance(error, RetryableProbeError):
                message = UNREADABLE_AUDIO
            else:
                message = (str(error) if self._runner is run_ffprobe and isinstance(error, ProbeError)
                           else "FFprobe could not read this file.")
            fields = {**name_fields(item["rel"], item["kind"], root_name, numbered=numbered),
                      "kind": item["kind"], "error": message}
            if isinstance(error, RetryableProbeError):
                fields["retry"] = True
            return fields
        if data is None:
            return None
        return _file_probe_fields(data, item, root_name, numbered=numbered)

    def _read_tags(self, pending: list[tuple], executable: str | None, counts: Counter) -> bool:
        with self._lock:
            if not self._cancel.is_set():
                self._progress["phase"] = "reading"
        cancel = self._cancel
        next_save = self._clock() + _SAVE_INTERVAL

        def read_batch(submit, records, tool, limit):
            nonlocal next_save
            records = iter(records)
            active, fallback = {}, []
            progress = time.monotonic()
            timeout = _TAG_STALL_TIMEOUT if tool is None else PROBE_TIMEOUT + _DIRECTORY_TIMEOUT
            while not cancel.is_set():
                while len(active) < limit and not cancel.is_set():
                    record = next(records, None)
                    if record is None:
                        break
                    item = record[0]
                    with self._lock:
                        if item["folder"] in self._removed or not _matches_scan_row(self._items.get(item["id"]), item):
                            continue
                    active[submit(self._probe_item, cancel, tool, *record)] = record
                if not active:
                    return fallback
                done, _ = wait(active, timeout=0.05, return_when=FIRST_COMPLETED)
                if cancel.is_set():
                    break
                if done:
                    progress = time.monotonic()
                elif time.monotonic() - progress >= timeout:
                    cancel.set()
                    raise _DriveStalled(*(record[0]["folder"] for record in active.values()))
                results = []
                for future in done:
                    record = active.pop(future)
                    result = future.result()
                    if result is _NEEDS_FFPROBE:
                        fallback.append(record)
                    elif result is not None:
                        results.append((record[0], result))
                if results:
                    self._publish_tags(results, counts, "in_process" if tool is None else "ffprobe")
                if self._clock() >= next_save:
                    self._save()
                    next_save = self._clock() + _SAVE_INTERVAL
            return fallback

        def folder_key(record):
            return os.path.dirname(record[1]).casefold()

        def path_key(record):
            return folder_key(record), os.path.basename(record[1]).casefold()

        waiting = False
        pending.sort(key=path_key)
        with _tag_workers(max(_TAG_WORKERS, _MAX_WORKERS)) as submit:
            for _, group in groupby(pending, key=folder_key):
                if self._cancel.is_set():
                    break
                local, fallback = [], []
                for record in group:
                    (local if record[0]["ext"] in TAG_EXTENSIONS else fallback).append(record)
                fallback.extend(read_batch(submit, local, None, _TAG_WORKERS))
                if executable is not None:
                    read_batch(submit, sorted(fallback, key=path_key), executable, _MAX_WORKERS)
                elif fallback:
                    with self._lock:
                        waiting |= any(record[0]["folder"] not in self._removed for record in fallback)
        return waiting

    def _publish_tags(self, results: list[tuple[dict, dict]], counts: Counter, reader: str) -> None:
        with self._lock:
            if self._cancel.is_set():
                return
            changed = []
            for expected, item in results:
                identity = item["id"]
                old = self._items.get(identity)
                if item["folder"] in self._removed or not _matches_scan_row(old, expected):
                    continue
                counts["failed" if item.get("error") else reader] += 1
                self._progress["files_read"] += 1
                if old.get("retry") and item.get("retry"):
                    self._retried.add(identity)
                _keep_play_duration(old, item)
                _keep_measured(old, item)
                if item != old:
                    self._items[identity] = item
                    self._counts[old["folder"], old["kind"]] -= 1
                    self._counts[item["folder"], item["kind"]] += 1
                    changed.append(identity)
            self._record_changes(changed)
