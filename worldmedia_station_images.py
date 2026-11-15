"""Station pictures the user keeps in the data folder.

A picture named like a station ("Radio Paradise.png") is shown for it in place
of the station's own artwork. Only ordinary files directly inside
<data folder>/station-images are looked at: subfolders are not opened, and
links and junctions are never followed. A file is only ever served from the
list a scan built (never from request text), after the folder and the file
have been checked again, and only when its bytes pass the same
validate_image() check as remote artwork. Nothing here writes to the folder
except creating it when the user asks to open it.

Matching rule (normalize_station_name; src/lib/station-images.js has the same
one, and tests/fixtures/station-image-names.json holds the shared cases):
Unicode NFKC, every kind of whitespace becomes one space, the characters
Windows forbids in file names (\\ / : * ? " < > |) and control characters are
removed, lower case, runs of spaces become one, leading and trailing spaces
and trailing dots are removed. A file is used for a station when its name
without the extension normalizes to the same text as the station's name.
When several files normalize to the same name, the one whose file name comes
first in plain character-code order is used and the others are ignored.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import threading
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path

from worldmedia_catalog import normalize_artwork, validate_image
from worldmedia_security import ApiError


FOLDER_NAME = "station-images"
MAX_FILES = 2_000
MAX_FILE_BYTES = 2 * 1024 * 1024
# Directory entries read before a scan stops, whatever they are.
MAX_DIRECTORY_ENTRIES = 10_000
# Longer names can never match: Windows file names are at most 255 units long.
MAX_NAME_INPUT = 1_024
MAX_FILENAME_LENGTH = 255
EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
# Files Windows and macOS drop into folders by themselves; not worth a mention.
_QUIET_NAMES = frozenset({"desktop.ini", "thumbs.db", "ehthumbs.db", ".ds_store"})

# Why a file was ignored, as plain text for the status line, in display order.
IGNORE_REASONS = {
    "too_large": "too large",
    "not_image": "not a picture",
    "unsupported_type": "unsupported type",
    "duplicate": "same name as another picture",
    "link": "a link, not a file",
    "bad_name": "file name not allowed",
    "too_many": "over the 2,000 picture limit",
    "unreadable": "could not be read",
}

UNSAFE_FOLDER = ("The station-images folder is a link or is not inside your data folder, "
                 "so its pictures are not used.")
UNREADABLE_FOLDER = "The station-images folder could not be read."

_SPACES = re.compile(
    r"[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)
_DROPPED = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f-\x9f]')
_SPACE_RUNS = re.compile(r" {2,}")
# Names a picture file may not have: anything Windows treats specially, and
# invisible direction overrides that could make a name read differently.
_BAD_NAME_CHARACTER = re.compile(
    r'[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]'
)
_DEVICE_NAME = re.compile(
    r"(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])",
    re.IGNORECASE,
)
_PICTURE_ID = re.compile(r"[0-9a-f]{32}")
# Reparse tags with this bit are links (symbolic links, junctions). Others,
# such as OneDrive files, are ordinary files (the same rule as the backup).
_NAME_SURROGATE = 0x20000000


def normalize_station_name(value: object) -> str:
    """The text a station name or a picture's file name (without extension) is
    compared by; '' when it can never match."""

    if not isinstance(value, str) or len(value) > MAX_NAME_INPUT:
        return ""
    text = unicodedata.normalize("NFKC", value)
    text = _SPACES.sub(" ", text)
    text = _DROPPED.sub("", text)
    text = text.lower()
    text = _SPACE_RUNS.sub(" ", text).strip(" ")
    return text.rstrip(". ")


def filename_allowed(name: object) -> bool:
    """True for a plain file name that cannot mean anything but a file in the
    folder: no separators, colons (alternate data streams), device names,
    control characters, or trailing dots or spaces (Windows drops those)."""

    if not isinstance(name, str) or not name or len(name) > MAX_FILENAME_LENGTH:
        return False
    if _BAD_NAME_CHARACTER.search(name) or name[-1] in ". ":
        return False
    return not _DEVICE_NAME.fullmatch(name.split(".", 1)[0].rstrip(" "))


def picture_key(filename: str) -> str:
    """The normalized name of a picture file, from its name without extension."""

    return normalize_station_name(filename.rsplit(".", 1)[0]) if "." in filename else ""


def picture_id(key: str) -> str:
    """A fixed-format handle for a key, used in the picture's URL."""

    return hashlib.sha256(f"station-image\0{key}".encode("utf-8")).hexdigest()[:32]


def _digest(value: object, length: int = 16) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=True).encode("ascii")).hexdigest()[:length]


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE)


def _error(status: int, code: str, message: str, retryable: bool = False) -> ApiError:
    return ApiError(status, code, message, retryable)


class _Refused(Exception):
    """A file that is not used; ``reason`` is a key of IGNORE_REASONS."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def validated_picture(data: bytes) -> tuple[bytes, str]:
    """The bytes to serve and their type, or _Refused('not_image').

    The same repair and check remote artwork gets (normalize_artwork with an
    unknown type, then validate_image): the type comes from the bytes, never
    from the file's extension, and SVG or anything else that is not a PNG,
    JPEG, GIF or WebP raster is refused."""

    try:
        data, content_type = normalize_artwork(data, "application/octet-stream")
        validate_image(data, content_type)
    except Exception as error:  # Malformed input of any kind is simply not a picture.
        raise _Refused("not_image") from error
    return data, content_type


@dataclass(frozen=True, slots=True)
class Picture:
    key: str
    id: str
    filename: str
    stamp: str


@dataclass(frozen=True, slots=True)
class Scan:
    folder_stamp: tuple[int, int, int] | None
    exists: bool
    problem: str = ""
    pictures: dict[str, Picture] = field(default_factory=dict)
    ignored: dict[str, int] = field(default_factory=dict)
    version: str = ""


class StationImages:
    """The pictures in one data folder's station-images folder."""

    def __init__(self, state_root: Path) -> None:
        self.state_root = Path(state_root)
        self.folder = self.state_root / FOLDER_NAME
        self._lock = threading.Lock()
        self._scan: Scan | None = None
        # (file name, size, mtime_ns) -> content type, or "!" + ignore reason.
        self._checked: dict[tuple[str, int, int], str] = {}

    # ---- the folder ----------------------------------------------------

    def _folder_info(self) -> os.stat_result | None:
        """The folder's own status; None when it does not exist. Raises when it
        is a link or junction, not a folder, or not directly in the data folder."""

        try:
            info = os.lstat(self.folder)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True) from error
        if _is_link(info) or not stat.S_ISDIR(info.st_mode):
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNSAFE", UNSAFE_FOLDER)
        try:
            real = os.path.normcase(os.path.realpath(self.folder))
            root = os.path.normcase(os.path.realpath(self.state_root))
        except (OSError, ValueError) as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True) from error
        if os.path.dirname(real) != root:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNSAFE", UNSAFE_FOLDER)
        return info

    def _folder_stamp(self) -> tuple[int, int, int] | None:
        try:
            info = os.lstat(self.folder)
        except OSError:
            return None
        return (info.st_ino, info.st_dev, info.st_mtime_ns)

    # ---- one file ------------------------------------------------------

    def _read_file(self, name: str, folder: os.stat_result) -> bytes:
        """Read one picture file without following links; raises _Refused."""

        if not filename_allowed(name):
            raise _Refused("bad_name")
        path = self.folder / name
        try:
            info = os.lstat(path)
        except OSError as error:
            raise _Refused("unreadable") from error
        if _is_link(info):
            raise _Refused("link")
        if not stat.S_ISREG(info.st_mode):
            raise _Refused("unsupported_type")
        if info.st_size > MAX_FILE_BYTES:
            raise _Refused("too_large")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
            with os.fdopen(descriptor, "rb") as handle:
                opened = os.fstat(handle.fileno())
                # The file that was opened must be the one that was checked.
                if ((opened.st_ino, opened.st_dev) != (info.st_ino, info.st_dev)
                        or _is_link(opened) or not stat.S_ISREG(opened.st_mode)):
                    raise _Refused("unreadable")
                data = handle.read(MAX_FILE_BYTES + 1)
            real_parent = os.path.dirname(os.path.normcase(os.path.realpath(path)))
        except (OSError, ValueError) as error:
            raise _Refused("unreadable") from error
        if len(data) > MAX_FILE_BYTES:
            raise _Refused("too_large")
        # The folder is still the same real folder, and the file really is in it.
        try:
            after = self._folder_info()
        except ApiError as error:
            raise _Refused("link") from error
        if after is None or (after.st_ino, after.st_dev) != (folder.st_ino, folder.st_dev):
            raise _Refused("unreadable")
        if real_parent != os.path.normcase(os.path.realpath(self.folder)):
            raise _Refused("link")
        return data

    def _check_file(self, name: str, folder: os.stat_result) -> str:
        try:
            _, content_type = validated_picture(self._read_file(name, folder))
        except _Refused as refused:
            return "!" + refused.reason
        return content_type

    # ---- scanning ------------------------------------------------------

    def _scan_locked(self) -> Scan:
        try:
            folder = self._folder_info()
        except ApiError as error:
            self._checked = {}
            return Scan(self._folder_stamp(), True, error.message, version=_digest(["problem", error.code]))
        if folder is None:
            self._checked = {}
            return Scan(None, False, version=_digest(["missing"]))
        ignored: Counter[str] = Counter()
        candidates: list[tuple[str, os.stat_result]] = []
        try:
            with os.scandir(self.folder) as entries:
                for count, entry in enumerate(entries):
                    if count >= MAX_DIRECTORY_ENTRIES:
                        ignored["too_many"] += 1
                        break
                    name = entry.name
                    lowered = name.lower()
                    if lowered in _QUIET_NAMES or name.startswith("._"):
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        ignored["unreadable"] += 1
                        continue
                    if _is_link(info):
                        ignored["link"] += 1
                    elif stat.S_ISDIR(info.st_mode):
                        continue  # Subfolders are not looked into.
                    elif not stat.S_ISREG(info.st_mode) or not lowered.endswith(EXTENSIONS):
                        ignored["unsupported_type"] += 1
                    elif not filename_allowed(name) or not picture_key(name):
                        ignored["bad_name"] += 1
                    else:
                        candidates.append((name, info))
        except OSError:
            self._checked = {}
            return Scan(self._folder_stamp(), True, UNREADABLE_FOLDER, version=_digest(["unreadable"]))

        candidates.sort(key=lambda candidate: candidate[0])
        ignored["too_many"] += max(0, len(candidates) - MAX_FILES)
        checked: dict[tuple[str, int, int], str] = {}
        groups: dict[str, list[Picture]] = {}
        described: list[list[object]] = []
        for name, info in candidates[:MAX_FILES]:
            if info.st_size > MAX_FILE_BYTES:
                ignored["too_large"] += 1
                continue
            cache_key = (name, info.st_size, info.st_mtime_ns)
            result = self._checked.get(cache_key) or self._check_file(name, folder)
            if result != "!unreadable":  # A file being saved right now is looked at again.
                checked[cache_key] = result
            if result.startswith("!"):
                ignored[result[1:]] += 1
                continue
            key = picture_key(name)
            stamp = _digest([name, info.st_size, info.st_mtime_ns, result], 12)
            groups.setdefault(key, []).append(Picture(key, picture_id(key), name, stamp))
        self._checked = checked
        pictures: dict[str, Picture] = {}
        for key, group in groups.items():
            # Candidates are in file-name order, so the first is the one used.
            winner = group[0]
            pictures[winner.id] = winner
            ignored["duplicate"] += len(group) - 1
            described.append([key, winner.filename, winner.stamp])
        counts = {reason: ignored[reason] for reason in IGNORE_REASONS if ignored.get(reason)}
        described.sort()
        stamp = (folder.st_ino, folder.st_dev, folder.st_mtime_ns)
        return Scan(stamp, True, "", pictures, counts, _digest([described, sorted(counts.items())]))

    def _current(self) -> Scan:
        """The last scan, scanning again when the folder itself has changed."""

        with self._lock:
            if self._scan is None or self._scan.folder_stamp != self._folder_stamp():
                self._scan = self._scan_locked()
            return self._scan

    def listing(self) -> dict:
        """Scan now (only new or changed files are read) and describe the result."""

        with self._lock:
            self._scan = scan = self._scan_locked()
        images = sorted(
            ({"key": picture.key, "id": picture.id, "v": picture.stamp} for picture in scan.pictures.values()),
            key=lambda entry: entry["key"],
        )
        return {
            "folder": str(self.folder),
            "exists": scan.exists,
            "version": scan.version,
            "images": images,
            "found": len(images),
            "ignored": sum(scan.ignored.values()),
            "ignored_reasons": [
                {"reason": reason, "text": IGNORE_REASONS[reason], "count": count}
                for reason, count in scan.ignored.items()
            ],
            "problem": scan.problem,
        }

    # ---- serving -------------------------------------------------------

    def read(self, requested_id: object) -> tuple[bytes, str, str]:
        """(validated bytes, content type, ETag) for one picture of the last scan."""

        missing = _error(HTTPStatus.NOT_FOUND, "STATION_IMAGE_NOT_FOUND",
                         "That station picture is not available.")
        if not isinstance(requested_id, str) or not _PICTURE_ID.fullmatch(requested_id):
            raise missing
        picture = self._current().pictures.get(requested_id)
        if picture is None:
            raise missing
        folder = self._folder_info()
        if folder is None:
            raise missing
        try:
            data, content_type = validated_picture(self._read_file(picture.filename, folder))
        except _Refused as refused:
            raise missing from refused
        etag = '"si-' + hashlib.sha256(data).hexdigest()[:24] + '"'
        return data, content_type, etag

    def files_for_backup(self, budget: int) -> tuple[list[tuple[str, bytes]], int, str]:
        """The pictures in use, as (file name, validated bytes) in file-name order,
        that fit in ``budget`` bytes together; how many did not fit; and a plain
        note when the folder could not be used at all."""

        with self._lock:
            scan = self._scan_locked()
        if scan.problem or not scan.pictures:
            return [], 0, scan.problem
        try:
            folder = self._folder_info()
        except ApiError as error:
            return [], 0, error.message
        if folder is None:
            return [], 0, ""
        files: list[tuple[str, bytes]] = []
        left_out = 0
        used = 0
        for picture in sorted(scan.pictures.values(), key=lambda entry: entry.filename):
            try:
                data, _ = validated_picture(self._read_file(picture.filename, folder))
            except _Refused:
                continue  # Changed or removed since the scan.
            if used + len(data) > budget:
                left_out += 1
                continue
            files.append((picture.filename, data))
            used += len(data)
        return files, left_out, ""

    # ---- opening -------------------------------------------------------

    def open_folder(self, opener=None) -> str:
        """Create the folder when there is none, then show it in Explorer."""

        try:
            os.mkdir(self.folder)
        except FileExistsError:
            pass
        except OSError as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_NOT_WRITABLE",
                         "The station-images folder could not be made in your data folder.", True) from error
        if self._folder_info() is None:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True)
        start = opener or getattr(os, "startfile", None)
        if start is None:
            raise _error(HTTPStatus.CONFLICT, "OPEN_FOLDER_UNAVAILABLE", "Opening folders is not available here.")
        try:
            start(str(self.folder))
        except OSError as error:
            raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "OPEN_FOLDER_FAILED",
                         "The station-images folder could not be opened.", True) from error
        return str(self.folder)
