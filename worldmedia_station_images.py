"""Station pictures the user keeps in the data folder.

A picture named like a station ("Radio Paradise.png") is shown for it in place
of the station's own artwork. Only ordinary files directly inside
<data folder>/station-images are looked at: subfolders are not opened, and
links and junctions are never followed. A file is only ever served from the
list a scan built (never from request text), after the folder and the file
have been checked again, and only when its bytes pass the same
validate_image() check as remote artwork. The folder is written to only when
the user asks: creating it to open it, saving a picture chosen for a station,
and removing a station's pictures. Pictures set in the app use a filename
made from the saved station ID, so they can travel with a portable backup.

Matching rule (normalize_station_name; src/lib/station-images.js has the same
one, and tests/fixtures/station-image-names.json holds the shared cases):
Unicode NFKC, every kind of whitespace becomes one space, the characters
Windows forbids in file names (\\ / : * ? " < > |) and control characters are
removed, lower case, runs of spaces become one, leading and trailing spaces
and trailing dots are removed. A file is used for a station when its name
without the extension normalizes to the same text as the station's name.
When several files normalize to the same name, the one whose file name comes
first in plain character-code order is used and the others are ignored.

A station's name can hold characters a file name cannot. The page (and only
the page) therefore also accepts a file
in which each such character of the station's name is written as "-", "_" or
a space, or left out, and a name Windows reserves (CON, PRN, AUX, NUL, COM1 to
COM9, LPT1 to LPT9) followed by "_" or "-". So "Nu-Metal/Alternative" can use
"Nu-Metal-Alternative.png" and "AUX" can use "AUX_.png". See the loose rule
in src/lib/station-images.js (which picture wins when several fit, and which
station when one fits several). File names themselves are checked exactly as
before (filename_allowed).

The page can also give a station a picture (save) or take its picture away
(remove); see StationImages.save. The bytes are checked by the same
validated_picture() as the scan, the file name is made here from the
station's ID or legacy name, and the file is
written whole (a temporary file renamed into place) inside the folder only.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import stat
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path

from worldmedia_catalog import normalize_artwork, validate_image
from worldmedia_security import ApiError


FOLDER_NAME = "station-images"
_SCOPED_STEM = re.compile(r"wm-station-id-[0-9a-f]{64}")
MAX_STATION_ID_LENGTH = 4096
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

# Why one file is not used, for the short list in Settings: the plain reason
# per file. "svg" is counted under "not_image" or "unsupported_type" above.
REJECT_DETAILS = {
    "too_large": "too large (the limit is 2 MB)",
    "not_image": "not a valid picture",
    "svg": "SVG is not allowed",
    "unsupported_type": "not a supported picture type",
    "duplicate": "another picture has the same name",
    "link": "a link, not a file",
    "bad_name": "file name not allowed",
    "too_many": "over the 2,000 picture limit",
    "unreadable": "could not be read",
}
# Files named in the listing at most; the rest are only counted.
MAX_REJECTED_LISTED = 20
# Characters left out of a file name when it is shown: invisible direction
# marks and control characters.
_HIDDEN_IN_NAMES = re.compile(r"[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]")
_SVG_TAG = re.compile(rb"<svg[\s>/]", re.IGNORECASE)

UNSAFE_FOLDER = ("The station-images folder is a link or is not inside your data folder, "
                 "so its pictures are not used.")
UNREADABLE_FOLDER = "The station-images folder could not be read."

# A picture sent by the page (save): its file type comes from its content.
SAVED_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
# The JSON body of a save: the picture as base64, the station name and a few flags.
MAX_SAVE_BODY_BYTES = 4 * ((MAX_FILE_BYTES + 2) // 3) + 16 * 1024
# Names of the temporary files a save writes; the scan passes over them ("._")
# and removes its own that a crash left behind, once they are an hour old.
_TEMPORARY_PREFIX = "._worldmedia-save-"
_TEMPORARY_NAME = re.compile(r"\._worldmedia-save-[0-9a-f]{16}\.tmp")
STALE_TEMPORARY_SECONDS = 60 * 60
# At most this many files are named in a question or a removal.
MAX_FILES_NAMED = 20
SAVE_TOO_LARGE = "The picture is too large. The limit is 2 MB."
SAVE_NOT_PICTURE = ("The file is not a picture the app can use. Use a PNG, JPG, WebP or GIF picture "
                    "of at most 8192 pixels on each side.")
SAVE_SVG = "SVG drawings are not allowed as station pictures. Use a PNG, JPG, WebP or GIF picture."
SAVE_BAD_NAME = "This station's name cannot be used as a file name, so it cannot have a picture of its own."
SAVE_LINK = ("A link or a folder has the name this station's picture would get, "
             "so nothing was changed. Remove it from the station-images folder first.")
TOO_MANY_FILES = ("More than 20 files in the station-images folder, where your station pictures are kept, "
                  "belong to this station, so nothing was changed and nothing was deleted. Tidy that folder "
                  "by hand first, then try again.")
SAVE_CHANGED = ("The station's picture files changed while you were asked, so nothing was changed. "
                "Try again.")
SAVE_TOO_MANY = ("There are too many files in the station-images folder (more than 10,000), "
                 "so nothing was changed. Remove some files from it first.")
SAVE_FAILED = "The picture could not be saved in the station-images folder."
REMOVE_FAILED = "The picture could not be removed from the station-images folder."

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


_FILE_FORBIDDEN = re.compile(r'[\\/:*?"<>|]')
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _stem_and_rule(station: object) -> tuple[str, bool]:
    """(picture_stem, True when the page matches the station by its loose
    rule: its name has a character Windows forbids in file names, or is a
    name Windows keeps for itself)."""

    if not isinstance(station, str) or not station or len(station) > MAX_NAME_INPUT:
        return "", False
    text = unicodedata.normalize("NFKC", station)
    text = _SPACES.sub(" ", text)
    text = _CONTROL.sub("", text)
    loose = _FILE_FORBIDDEN.search(text) is not None
    text = _FILE_FORBIDDEN.sub("-", text)
    text = _SPACE_RUNS.sub(" ", text).strip(" ").rstrip(". ")
    if not text or text.startswith("._") or _BAD_NAME_CHARACTER.search(text):
        return "", False
    head, dot, rest = text.partition(".")
    if _DEVICE_NAME.fullmatch(head.rstrip(" ")):
        return f"{head}_{dot}{rest}", True
    if not loose and normalize_station_name(text) != normalize_station_name(station):
        return "", False
    return text, loose


def picture_stem(station: object) -> str:
    """The file name, without extension, of a station's own picture, made from
    the station's name by the naming rule: the name as written (capital
    letters do not matter for matching), each character Windows forbids in
    file names (\\ / : * ? " < > |) written as "-", and a name Windows keeps
    for itself (CON, AUX, COM1...) followed by "_". The page matches such a
    file to the station (the loose rule in src/lib/station-images.js).
    '' when no file name can stand for the station."""

    return _stem_and_rule(station)[0]


def _save_stem(station: object, station_id: object) -> tuple[str, bool]:
    if station_id is not None:
        if not isinstance(station_id, str) or not 0 < len(station_id) <= MAX_STATION_ID_LENGTH:
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE", "A saved station ID is required.")
        try:
            identity = hashlib.sha256(station_id.encode("utf-8")).hexdigest()
        except UnicodeError as error:
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE", "The saved station ID is invalid.") from error
        return f"wm-station-id-{identity}", False
    stem, loose = _stem_and_rule(station)
    return ("", False) if _SCOPED_STEM.fullmatch(normalize_station_name(stem)) else (stem, loose)


def _same_name(first: str, second: str) -> bool:
    """True when two file names in one folder name the same file (Windows
    does not tell capital letters apart)."""

    return first == second or first.lower() == second.lower()


def exists_question(names: list[str]) -> str:
    """The question before a picture replaces these files: every name, in
    full (there are never more than MAX_FILES_NAMED; see TOO_MANY_FILES)."""

    if len(names) == 1:
        return f"The file {names[0]} is already there. Replace it?"
    return f"The files {', '.join(names[:-1])} and {names[-1]} are already there. Replace them?"


def _check_save_request(replace: object, current: object, files: object) -> None:
    """The flags of a save: `replace` a bool, `current` a string or nothing,
    and with `replace` the list of file names the user said yes to."""

    valid = isinstance(replace, bool) and (current is None or isinstance(current, str))
    if valid and replace:
        valid = (isinstance(files, list) and len(files) <= MAX_FILES_NAMED
                 and all(isinstance(name, str) and filename_allowed(name) for name in files))
    elif valid:
        valid = files is None
    if not valid:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE", "The request for the picture is not valid.")


def canonical_key(key: str) -> str:
    """A picture's name with "-", "_", spaces and dots taken out: the spellings
    of one station's name (the page files pictures the same way)."""

    return re.sub(r"[-_ .]", "", key)


def decode_picture_data(value: object) -> bytes:
    """The picture's bytes from the base64 text a save sends; refuses a text
    longer than the size limit allows before decoding it."""

    if not isinstance(value, str) or not value:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE", "The picture did not arrive whole. Try again.")
    if len(value) > 4 * ((MAX_FILE_BYTES + 2) // 3):
        raise _error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "STATION_IMAGE_TOO_LARGE", SAVE_TOO_LARGE)
    try:
        data = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as error:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE",
                     "The picture did not arrive whole. Try again.") from error
    if len(data) > MAX_FILE_BYTES:
        raise _error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "STATION_IMAGE_TOO_LARGE", SAVE_TOO_LARGE)
    return data


def shown_name(filename: str) -> str:
    """A file name as it may be shown in Settings: plain text, at most 120 characters."""

    text = _HIDDEN_IN_NAMES.sub("", filename)
    return text if len(text) <= 120 else text[:119] + "\u2026"


def looks_like_svg(data: bytes) -> bool:
    """True when the bytes start like an SVG drawing (which is never shown)."""

    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n")
    return head.startswith(b"<") and _SVG_TAG.search(head) is not None


def picture_id(key: str) -> str:
    """A fixed-format handle for a key, used in the picture's URL."""

    return hashlib.sha256(f"station-image\0{key}".encode("utf-8")).hexdigest()[:32]


def _digest(value: object, length: int = 16) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=True).encode("ascii")).hexdigest()[:length]


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE)


def _error(status: int, code: str, message: str, retryable: bool = False) -> ApiError:
    return ApiError(status, code, message, retryable)


def _remove_quietly(path: Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _rename_new(source: Path, target: Path) -> None:
    """Give `source` the name `target` only if nothing has that name; raises
    FileExistsError otherwise. On Windows os.rename never replaces; elsewhere
    a hard link is made (it fails on an existing name) and the old name goes."""

    if os.name == "nt":
        os.rename(source, target)
        return
    os.link(source, target)
    _remove_quietly(source)


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
    # (file name, detail key of REJECT_DETAILS) in file-name order, capped.
    rejected: tuple[tuple[str, str], ...] = ()


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
            data = self._read_file(name, folder)
        except _Refused as refused:
            return "!" + refused.reason
        try:
            _, content_type = validated_picture(data)
        except _Refused as refused:
            # Counted as "not a picture"; Settings names the reason.
            return "!svg" if looks_like_svg(data) else "!" + refused.reason
        return content_type

    # ---- scanning ------------------------------------------------------

    def _remove_stale_temporary(self, entry: os.DirEntry) -> None:
        """A save's temporary file left by a crash between writing and
        renaming: removed once it is an hour old. Only an ordinary file with
        exactly that name pattern; never a link."""

        # os.unlink removes a link itself, never what it points to, and
        # refuses a folder, so a name swapped after this look harms nothing.
        try:
            path = self.folder / entry.name
            info = os.lstat(path)
            if _is_link(info) or not stat.S_ISREG(info.st_mode):
                return
            if time.time() - info.st_mtime < STALE_TEMPORARY_SECONDS:
                return
            os.unlink(path)
        except OSError:
            pass

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
        rejected: list[tuple[str, str]] = []

        def refuse(name: str, reason: str, detail: str = "") -> None:
            ignored[reason] += 1
            rejected.append((name, detail or reason))

        try:
            with os.scandir(self.folder) as entries:
                for count, entry in enumerate(entries):
                    if count >= MAX_DIRECTORY_ENTRIES:
                        ignored["too_many"] += 1
                        break
                    name = entry.name
                    lowered = name.lower()
                    if _TEMPORARY_NAME.fullmatch(name):
                        self._remove_stale_temporary(entry)
                        continue
                    if lowered in _QUIET_NAMES or name.startswith("._"):
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        refuse(name, "unreadable")
                        continue
                    if _is_link(info):
                        refuse(name, "link")
                    elif stat.S_ISDIR(info.st_mode):
                        continue  # Subfolders are not looked into.
                    elif not stat.S_ISREG(info.st_mode) or not lowered.endswith(EXTENSIONS):
                        refuse(name, "unsupported_type",
                               "svg" if stat.S_ISREG(info.st_mode) and lowered.endswith((".svg", ".svgz")) else "")
                    elif not filename_allowed(name) or not picture_key(name):
                        refuse(name, "bad_name")
                    else:
                        candidates.append((name, info))
        except OSError:
            self._checked = {}
            return Scan(self._folder_stamp(), True, UNREADABLE_FOLDER, version=_digest(["unreadable"]))

        candidates.sort(key=lambda candidate: candidate[0])
        for name, _info in candidates[MAX_FILES:]:
            refuse(name, "too_many")
        checked: dict[tuple[str, int, int], str] = {}
        groups: dict[str, list[Picture]] = {}
        described: list[list[object]] = []
        for name, info in candidates[:MAX_FILES]:
            if info.st_size > MAX_FILE_BYTES:
                refuse(name, "too_large")
                continue
            cache_key = (name, info.st_size, info.st_mtime_ns)
            result = self._checked.get(cache_key) or self._check_file(name, folder)
            if result != "!unreadable":  # A file being saved right now is looked at again.
                checked[cache_key] = result
            if result.startswith("!"):
                detail = result[1:]
                refuse(name, "not_image" if detail == "svg" else detail, detail)
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
            for loser in group[1:]:
                refuse(loser.filename, "duplicate")
            described.append([key, winner.filename, winner.stamp])
        counts = {reason: ignored[reason] for reason in IGNORE_REASONS if ignored.get(reason)}
        described.sort()
        rejected.sort()
        stamp = (folder.st_ino, folder.st_dev, folder.st_mtime_ns)
        return Scan(stamp, True, "", pictures, counts, _digest([described, sorted(counts.items())]),
                    tuple(rejected))

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
            ({"key": picture.key, "id": picture.id, "v": picture.stamp, "file": shown_name(picture.filename)}
             for picture in scan.pictures.values()),
            key=lambda entry: entry["key"],
        )
        rejected = [
            {"file": shown_name(name), "reason": detail, "text": REJECT_DETAILS.get(detail, REJECT_DETAILS["unreadable"])}
            for name, detail in scan.rejected[:MAX_REJECTED_LISTED]
        ]
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
            # The files not used and why, in file-name order; rejected_more says
            # how many more there are (the directory-entry limit is only counted).
            "rejected": rejected,
            "rejected_more": max(0, len(scan.rejected) - len(rejected)),
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

    # ---- saving and removing ----------------------------------------------

    def _ensure_folder(self) -> os.stat_result:
        """The folder, made when there is none yet; raises when it is unsafe."""

        try:
            os.mkdir(self.folder)
        except FileExistsError:
            pass
        except OSError as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_NOT_WRITABLE",
                         "The station-images folder could not be made in your data folder.", True) from error
        folder = self._folder_info()
        if folder is None:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True)
        return folder

    def _entries(self) -> list[tuple[str, os.DirEntry]]:
        """Every entry directly in the folder, as listed. Refuses (rather than
        look at only some of them) when there are more than the scan reads."""

        found: list[tuple[str, os.DirEntry]] = []
        try:
            with os.scandir(self.folder) as entries:
                for count, entry in enumerate(entries):
                    if count >= MAX_DIRECTORY_ENTRIES:
                        raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_TOO_MANY", SAVE_TOO_MANY)
                    found.append((entry.name, entry))
        except OSError as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True) from error
        return found

    def _listed_as(self, name: str) -> str:
        """The name the folder's listing has for `name` (capital letters
        aside), or ''. A file found under another name only, such as its
        Windows short name (RADIOP~1.PNG), is another file's: never touched."""

        for listed, _ in self._entries():
            if _same_name(listed, name):
                return listed
        return ""

    def _same_key(self, key: str) -> list[tuple[str, os.stat_result]]:
        """Every entry directly in the folder whose name is a picture name for
        `key`, as (name, its own status: links are not followed)."""

        found: list[tuple[str, os.stat_result]] = []
        try:
            for name, entry in self._entries():
                if not name.lower().endswith(EXTENSIONS) or picture_key(name) != key:
                    continue
                found.append((name, entry.stat(follow_symlinks=False)))
        except OSError as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True) from error
        return found

    def _still_inside(self, folder: os.stat_result, path: Path) -> None:
        """The folder is still the same real folder, and `path` is really in it."""

        after = self._folder_info()
        if after is None or (after.st_ino, after.st_dev) != (folder.st_ino, folder.st_dev):
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNSAFE", UNSAFE_FOLDER)
        try:
            parent = os.path.dirname(os.path.normcase(os.path.realpath(path)))
            real_folder = os.path.normcase(os.path.realpath(self.folder))
        except (OSError, ValueError) as error:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNREADABLE", UNREADABLE_FOLDER, True) from error
        if parent != real_folder:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGES_UNSAFE", UNSAFE_FOLDER)

    def _write(self, folder: os.stat_result, filename: str, data: bytes, *, may_replace: bool) -> None:
        """Write `data` as `filename` in the folder, whole or not at all: a new
        temporary file there, renamed over the name. A link or folder of that
        name is never written through or replaced; neither is a file the
        folder's listing does not show under that name (a short name of
        another file). An existing file is only replaced with `may_replace`
        (the user said yes), whatever was checked before."""

        temporary = self.folder / f"{_TEMPORARY_PREFIX}{secrets.token_hex(8)}.tmp"
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                 | getattr(os, "O_NOFOLLOW", 0))
        try:
            descriptor = os.open(temporary, flags, 0o644)
        except OSError as error:
            raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATION_IMAGE_NOT_SAVED", SAVE_FAILED, True) from error
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            self._still_inside(folder, temporary)
            target = self.folder / filename
            try:
                info = os.lstat(target)
            except FileNotFoundError:
                info = None
            if info is not None:
                listed = self._listed_as(filename)
                if not listed or _is_link(info) or not stat.S_ISREG(info.st_mode):
                    raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_LINK", SAVE_LINK)
                if not may_replace:
                    raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_EXISTS", exists_question([listed]))
            if may_replace:
                os.replace(temporary, target)
            else:
                # Not confirmed: the last step itself fails if a file came in
                # the meantime, so nothing is ever replaced without a yes.
                try:
                    _rename_new(temporary, target)
                except FileExistsError:
                    self._refuse_existing(filename)
        except ApiError:
            _remove_quietly(temporary)
            raise
        except OSError as error:
            _remove_quietly(temporary)
            raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATION_IMAGE_NOT_SAVED", SAVE_FAILED, True) from error

    def _refuse_existing(self, filename: str) -> None:
        """Something took the name just before the last step: the same answers
        as when it was there before (a file to ask about, or a link/folder)."""

        try:
            info = os.lstat(self.folder / filename)
        except OSError:
            info = None
        listed = self._listed_as(filename)
        if info is not None and listed and not _is_link(info) and stat.S_ISREG(info.st_mode):
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_EXISTS", exists_question([listed]))
        raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_LINK", SAVE_LINK)

    def _unlink(self, folder: os.stat_result, name: str) -> bool:
        """Delete one ordinary file directly in the folder; a link is left alone."""

        if not filename_allowed(name):
            return False
        path = self.folder / name
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return False
        except OSError as error:
            raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATION_IMAGE_NOT_REMOVED", REMOVE_FAILED, True) from error
        if _is_link(info) or not stat.S_ISREG(info.st_mode):
            return False
        # Found, but listed under no such name: another file's short name.
        if not self._listed_as(name):
            return False
        self._still_inside(folder, path)
        try:
            os.unlink(path)
        except FileNotFoundError:
            return False
        except OSError as error:
            raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATION_IMAGE_NOT_REMOVED", REMOVE_FAILED, True) from error
        return True

    def _existing_locked(self, key: str, loose: bool, current: object) -> list[str]:
        """The files a new picture for the station (picture key `key`) would
        replace, in full, as the folder lists them: every file of that name,
        and the picture the page shows for it under another spelling. Refuses
        a link or folder in the way, and more files than a question can name."""

        same = self._same_key(key)
        if any(_is_link(info) or not stat.S_ISREG(info.st_mode) for _, info in same):
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_LINK", SAVE_LINK)
        # The picture the page shows for the station under another spelling of
        # its name counts only where the page itself matches by spelling: a
        # name with a character Windows forbids, or a name Windows keeps for
        # itself. Any other station uses only its exact name, so another
        # station's picture is never touched.
        shown = None
        if loose and isinstance(current, str) and _PICTURE_ID.fullmatch(current):
            found = self._scan_locked().pictures.get(current)
            if found is not None and found.key != key and canonical_key(found.key) == canonical_key(key):
                shown = found
        existing = sorted([name for name, _ in same] + ([shown.filename] if shown else []), key=str.lower)
        if len(existing) > MAX_FILES_NAMED:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_TOO_MANY_FILES", TOO_MANY_FILES)
        return existing

    def replace_files(self, station: object, current: object = None, *, station_id: object = None) -> dict:
        """The files a new picture for `station` would replace (every name in
        full), so the page can name them in its question; changes nothing."""

        stem, loose = _save_stem(station, station_id)
        key = picture_key(stem + ".png") if stem else ""
        if not key or not filename_allowed(stem + ".webp"):
            raise _error(HTTPStatus.BAD_REQUEST, "STATION_IMAGE_BAD_NAME", SAVE_BAD_NAME)
        _check_save_request(False, current, None)
        with self._lock:
            if self._folder_info() is None:
                return {"files": []}
            return {"files": self._existing_locked(key, loose, current)}

    def save(self, station: object, data: object, *, replace: bool = False, current: object = None,
             files: object = None, station_id: object = None) -> dict:
        """Make `data` the own picture of the station named `station`.

        The bytes pass validated_picture() (the scan's check: the type from the
        content, size and dimension limits, no SVG) and the validated bytes are
        written. For a saved station the file name comes from its ID and the
        picture's type. Name-based saves use the legacy spelling rule. A station that already has a picture of its
        own (a file for the same name, or `current`, the id of the picture the
        page shows for it) gets the new one only with `replace` and `files`,
        the full names the user was shown (replace_files) and said yes to;
        those old files then go, and nothing else. Without them the answer is
        409, naming every file. `current` is only acted on for a station the
        page matches by spelling (a name with a character Windows forbids, or
        a reserved name), when it is a picture of the last scan under another
        spelling of the same name."""

        if not isinstance(data, (bytes, bytearray)) or not data:
            raise _error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "STATION_IMAGE_NOT_PICTURE", SAVE_NOT_PICTURE)
        data = bytes(data)
        if len(data) > MAX_FILE_BYTES:
            raise _error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "STATION_IMAGE_TOO_LARGE", SAVE_TOO_LARGE)
        try:
            picture, content_type = validated_picture(data)
        except _Refused as refused:
            if looks_like_svg(data):
                raise _error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "STATION_IMAGE_SVG", SAVE_SVG) from refused
            raise _error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "STATION_IMAGE_NOT_PICTURE", SAVE_NOT_PICTURE) from refused
        if len(picture) > MAX_FILE_BYTES:
            raise _error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "STATION_IMAGE_TOO_LARGE", SAVE_TOO_LARGE)
        extension = SAVED_EXTENSIONS.get(content_type)
        if extension is None:
            raise _error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "STATION_IMAGE_NOT_PICTURE", SAVE_NOT_PICTURE)
        stem, loose = _save_stem(station, station_id)
        filename = stem + extension
        key = picture_key(filename) if stem else ""
        if not key or not filename_allowed(filename):
            raise _error(HTTPStatus.BAD_REQUEST, "STATION_IMAGE_BAD_NAME", SAVE_BAD_NAME)
        _check_save_request(replace, current, files)
        with self._lock:
            folder = self._ensure_folder()
            existing = self._existing_locked(key, loose, current)
            if existing and not replace:
                raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_EXISTS", exists_question(existing))
            # The yes was to exactly these files: if the folder holds others
            # for the station now, nothing is replaced or deleted.
            agreed = {name.lower() for name in files or []}
            if replace and (len(agreed) != len(existing) or {name.lower() for name in existing} != agreed):
                raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_CHANGED", SAVE_CHANGED)
            self._write(folder, filename, picture,
                        may_replace=replace and any(_same_name(name, filename) for name in existing))
            old = [name for name in existing if not _same_name(name, filename)]
            try:
                for name in old:
                    self._unlink(folder, name)
            except ApiError as error:
                raise _error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATION_IMAGE_OLD_KEPT",
                             "The new picture was saved, but the station's old picture could not be "
                             "removed, so it may still be shown.", True) from error
            finally:
                self._scan = None
        return {
            "file": shown_name(filename), "key": key, "id": picture_id(key), "replaced": bool(existing),
        }

    def _removable(self, picture: Picture) -> list[str]:
        """The files that make up `picture`: every ordinary file directly in
        the folder with its name (in any picture type), as the folder lists
        them. Links and folders are left out. Refuses more than a question can
        name, rather than delete files the user was not shown."""

        files = sorted(
            name for name, info in self._same_key(picture.key)
            if not _is_link(info) and stat.S_ISREG(info.st_mode) and filename_allowed(name)
        )
        if len(files) > MAX_FILES_NAMED:
            raise _error(HTTPStatus.CONFLICT, "STATION_IMAGE_TOO_MANY_FILES", TOO_MANY_FILES)
        return files

    def removal_files(self, requested_id: object) -> dict:
        """What Remove picture would delete for picture `requested_id`, so the
        page can name the files in its question; deletes nothing."""

        missing = _error(HTTPStatus.NOT_FOUND, "STATION_IMAGE_NOT_FOUND",
                         "That station picture is not in the station-images folder any more.")
        if not isinstance(requested_id, str) or not _PICTURE_ID.fullmatch(requested_id):
            raise missing
        with self._lock:
            picture = self._scan_locked().pictures.get(requested_id)
            if picture is None or self._folder_info() is None:
                raise missing
            files = self._removable(picture)
        if not files:
            raise missing
        return {"files": files, "file": shown_name(picture.filename)}

    def remove(self, requested_id: object, files: object) -> dict:
        """Delete the files `files` (named in the question the user said yes
        to; see removal_files) of the station picture `requested_id`. Only
        files that still make up that picture go; nothing else, and no link."""

        missing = _error(HTTPStatus.NOT_FOUND, "STATION_IMAGE_NOT_FOUND",
                         "That station picture is not in the station-images folder any more.")
        if not isinstance(requested_id, str) or not _PICTURE_ID.fullmatch(requested_id):
            raise missing
        if (not isinstance(files, list) or not files or len(files) > MAX_FILES_NAMED
                or not all(isinstance(name, str) and filename_allowed(name) for name in files)):
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_STATION_IMAGE", "The request for the picture is not valid.")
        with self._lock:
            picture = self._scan_locked().pictures.get(requested_id)
            if picture is None:
                raise missing
            folder = self._folder_info()
            if folder is None:
                raise missing
            removed = 0
            try:
                for name in self._removable(picture):
                    if name in files and self._unlink(folder, name):
                        removed += 1
            finally:
                self._scan = None
        return {"removed": removed, "file": shown_name(picture.filename)}

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
