"""Starred songs: the songs the user starred in the song log or the player bar.

They live in their own file, state/starred-songs.json, apart from the song log,
so they survive the log's size limit and its "Clear log", and an older World
Media (which rewrites song-log.json with only the keys it knows) can never
drop them. Like the song log they are never a key of profile-preferences.json:
World Media 0.1.8 and older ignore that whole file when it holds a key they do
not know.

Each entry is { starred, title, station, stationId, source }: plain text and
the time it was starred, in milliseconds since 1970. Writes are ordered by a
revision exactly as the song log's are (worldmedia_songlog.py): a write that is
not newer than the stored one is answered with what is stored, so a late
request can never undo a newer write. A file that cannot be understood is
moved aside before the first write that replaces it.

"Save as text" and "Save as CSV" write a file with a name chosen here into the
downloads folder; nothing from a request ever names a file.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import secrets
import stat
import threading
from datetime import datetime
from pathlib import Path

from worldmedia_downloads import DownloadError, _validated_download_root
from worldmedia_runtime import RuntimePaths, _atomic_write_json
from worldmedia_songlog import FIELD_LIMITS, MAX_TIME_MS, _cell, _publish


STARRED_FILENAME = "starred-songs.json"
STARRED_VERSION = 1
MAX_ENTRIES = 2000
ENTRY_KEYS = frozenset({"starred", *FIELD_LIMITS})
MAX_BODY_BYTES = MAX_ENTRIES * (sum(FIELD_LIMITS.values()) * 4 + 128) + 1024
MAX_FILE_BYTES = MAX_ENTRIES * (sum(FIELD_LIMITS.values()) * 12 + 128) + 1024
MAX_REVISION = 2**53 - 1
SET_ASIDE_PREFIX = "starred-songs-unreadable-"
MAX_SET_ASIDE = 3
_SET_ASIDE_NAME = re.compile(r"starred-songs-unreadable-(\d{8}-\d{6})(?:-(\d+))?\.json")
EXPORT_PREFIX = "WorldMedia-starred-songs-"
EXPORT_FORMATS = {"txt": ".txt", "csv": ".csv"}
MAX_NAME_ATTEMPTS = 100
CSV_HEADER = ("Song", "Station", "Date starred", "Time starred")

# Never stored or exported. The page cleans them out before it sends anything
# (starred-songs.js cleanStarredText), so a request that still has one is
# refused; a stored file that has one (restored by hand, or written by an
# older version) is cleaned the page's way when read: controls (C0 and C1) and
# the line and paragraph separators become a space; bidi marks and controls,
# zero-width characters, the soft hyphen and the byte order mark are removed;
# a lone surrogate becomes U+FFFD.
_CONTROL_TEXT = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")
_INVISIBLE_TEXT = re.compile("[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_SURROGATES = re.compile("[\ud800-\udfff]")
_UNSAFE_TEXT = re.compile(f"{_CONTROL_TEXT.pattern}|{_INVISIBLE_TEXT.pattern}|{_SURROGATES.pattern}")
_TEXT_LINE_BREAKS = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]")
# An entry on Windows that is a link (a symlink or a junction).
_NAME_SURROGATE = 0x20000000

_STORE_LOCK = threading.Lock()


class StarredSongsError(RuntimeError):
    """A starred songs request that could not be done. The message is plain text."""

    def __init__(self, message: str, *, code: str = "STARRED_SONGS_FAILED", status: int = 500,
                 retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def starred_songs_path(paths: RuntimePaths) -> Path:
    return paths.state_root / "state" / STARRED_FILENAME


def clean_text(value: str) -> str:
    """One plain line: what the page would have saved for this text."""

    text = _SURROGATES.sub("\ufffd", value)
    text = _INVISIBLE_TEXT.sub("", _CONTROL_TEXT.sub(" ", text))
    return re.sub(r"\s+", " ", text).strip()


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE)


def _not_ordinary(info: os.stat_result) -> bool:
    return _is_link(info) or not stat.S_ISREG(info.st_mode)


def _entry(value: object, clean: bool = False) -> dict:
    if not isinstance(value, dict) or set(value) != ENTRY_KEYS:
        raise ValueError("Each starred song needs exactly starred, station, stationId, source and title.")
    when = value["starred"]
    if isinstance(when, bool) or not isinstance(when, int) or not 0 < when <= MAX_TIME_MS:
        raise ValueError("A starred song's date is invalid.")
    entry: dict = {"starred": when}
    for field, limit in FIELD_LIMITS.items():
        text = value[field]
        if not isinstance(text, str):
            raise ValueError("Starred song text must be text.")
        if clean:
            text = clean_text(text)
        elif _UNSAFE_TEXT.search(text):
            raise ValueError("A starred song text contains characters that are not allowed.")
        if len(text) > limit:
            raise ValueError("A starred song text is too long.")
        entry[field] = text
    if not entry["title"].strip():
        raise ValueError("A starred song needs a song title.")
    return entry


def normalize_entries(value: object, *, clean: bool = False) -> list[dict]:
    """A list of at most MAX_ENTRIES valid entries. With ``clean`` (a stored
    file), unsafe characters are cleaned out instead of refused."""

    if not isinstance(value, list):
        raise ValueError("Starred songs must be a list.")
    if len(value) > MAX_ENTRIES:
        raise ValueError(f"At most {MAX_ENTRIES} songs can be starred.")
    return [_entry(item, clean) for item in value]


def _save_body(body: object) -> tuple[int, list[dict]]:
    if not isinstance(body, dict) or set(body) != {"revision", "entries"}:
        raise ValueError("Saving starred songs requires only a revision and an entries list.")
    revision = body["revision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 < revision <= MAX_REVISION:
        raise ValueError("The starred songs revision is invalid.")
    return revision, normalize_entries(body["entries"])


def _export_body(body: object) -> tuple[str, list[dict]]:
    if not isinstance(body, dict) or set(body) != {"format", "entries"}:
        raise ValueError("Saving starred songs to a file requires only a format and an entries list.")
    if body["format"] not in EXPORT_FORMATS:
        raise ValueError("Starred songs can be saved as text or as CSV.")
    return body["format"], normalize_entries(body["entries"])


def _read_state(paths: RuntimePaths) -> tuple[str, int, list[dict]]:
    """("missing" | "ok" | "unreadable", revision, entries oldest first)."""

    path = starred_songs_path(paths)
    unavailable = StarredSongsError(
        "The saved starred songs cannot be read right now. They were not changed; try again in a moment.",
        code="STARRED_SONGS_UNAVAILABLE", status=503, retryable=True)
    unsafe = StarredSongsError(
        "starred-songs.json in your data folder is a link or not an ordinary file, so it was not used or changed.",
        code="STARRED_SONGS_UNSAFE", status=409)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return "missing", 0, []
    except OSError as error:
        raise unavailable from error
    if _not_ordinary(info):
        raise unsafe
    if info.st_size > MAX_FILE_BYTES:
        return "unreadable", 0, []
    # Opened without following a link, and checked to be the file looked at.
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_ino, opened.st_dev) != (info.st_ino, info.st_dev) or _not_ordinary(opened):
                raise unavailable
            raw = handle.read(MAX_FILE_BYTES + 1)
    except FileNotFoundError:
        return "missing", 0, []
    except StarredSongsError:
        raise
    except OSError as error:
        raise unavailable from error
    if len(raw) > MAX_FILE_BYTES:
        return "unreadable", 0, []
    try:
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("version") != STARRED_VERSION:
            raise ValueError("unsupported starred songs file")
        revision = document.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= MAX_REVISION:
            raise ValueError("invalid revision")
        entries = normalize_entries(document.get("entries"), clean=True)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return "unreadable", 0, []
    return "ok", revision, entries


def load_starred_songs(paths: RuntimePaths) -> dict:
    """{"entries", "revision", "unreadable"}; raises StarredSongsError when the
    file cannot be read right now."""

    with _STORE_LOCK:
        status, revision, entries = _read_state(paths)
    return {"entries": entries, "revision": revision, "unreadable": status == "unreadable"}


def _set_aside(paths: RuntimePaths, now: datetime) -> None:
    path = starred_songs_path(paths)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    kept: Path | None = None
    failed = StarredSongsError("The unreadable starred songs file could not be moved aside, so it was not replaced.",
                               code="STARRED_SONGS_SET_ASIDE_FAILED", status=500, retryable=True)
    try:
        for attempt in range(1, MAX_NAME_ATTEMPTS + 1):
            suffix = "" if attempt == 1 else f"-{attempt}"
            candidate = path.with_name(f"{SET_ASIDE_PREFIX}{stamp}{suffix}.json")
            try:
                _publish(path, candidate)
            except FileExistsError:
                continue
            kept = candidate
            break
    except OSError as error:
        raise failed from error
    if kept is None:
        raise failed
    try:
        found = []
        for child in path.parent.iterdir():
            match = _SET_ASIDE_NAME.fullmatch(child.name)
            if match is None or child.name == kept.name:
                continue
            info = os.lstat(child)
            if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                found.append(((match.group(1), int(match.group(2) or 1)), child))
        found.sort()
        for _, child in found[: max(0, len(found) - (MAX_SET_ASIDE - 1))]:
            child.unlink()
    except OSError:
        pass  # Old set-aside files are only tidied up; that may wait.


def save_starred_songs(body: object, paths: RuntimePaths, *, now: datetime | None = None) -> dict:
    """Apply a write if its revision is newer than the stored one, as
    worldmedia_songlog.save_song_log does."""

    revision, entries = _save_body(body)
    with _STORE_LOCK:
        status, current, stored = _read_state(paths)
        if revision <= current:
            return {"saved": False, "stale": True, "revision": current, "entries": stored}
        if status == "unreadable":
            _set_aside(paths, now or datetime.now())
        _atomic_write_json(starred_songs_path(paths),
                           {"version": STARRED_VERSION, "revision": revision, "entries": entries})
    return {"saved": True, "revision": revision, "count": len(entries)}


def _local(entry: dict) -> tuple[str, str]:
    try:
        moment = datetime.fromtimestamp(entry["starred"] / 1000)
        return moment.strftime("%Y-%m-%d"), moment.strftime("%H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return "", ""


def starred_songs_csv(entries: list[dict]) -> bytes:
    """UTF-8 with a byte order mark (Excel), rows in the order given."""

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for entry in entries:
        day, clock = _local(entry)
        writer.writerow((_cell(entry["title"]), _cell(entry["station"]), day, clock))
    return buffer.getvalue().encode("utf-8-sig")


def starred_songs_text(entries: list[dict]) -> bytes:
    """One song a line: "Song (Station, date starred)", UTF-8 with a byte order mark."""

    lines = []
    for entry in entries:
        title = _TEXT_LINE_BREAKS.sub(" ", entry["title"])
        station = _TEXT_LINE_BREAKS.sub(" ", entry["station"])
        day, _ = _local(entry)
        details = ", ".join(part for part in (station, day) if part)
        lines.append(f"{title} ({details})" if details else title)
    return ("\r\n".join(lines) + ("\r\n" if lines else "")).encode("utf-8-sig")


def _destination(paths: RuntimePaths) -> Path:
    try:
        root = _validated_download_root(paths)
        root.mkdir(parents=True, exist_ok=True)
    except DownloadError as error:
        raise StarredSongsError(str(error), code="UNSAFE_DOWNLOAD_ROOT", status=409) from error
    except OSError as error:
        raise StarredSongsError("The downloads folder is not available, so the starred songs were not saved.",
                                code="DOWNLOADS_NOT_WRITABLE", status=409, retryable=True) from error
    return root


def export_starred_songs(body: object, paths: RuntimePaths, *, now: datetime | None = None) -> dict:
    """Write the entries of a request body as a .txt or .csv file in the downloads folder."""

    try:
        kind, entries = _export_body(body)
    except ValueError as error:
        raise StarredSongsError(str(error), code="INVALID_STARRED_SONGS", status=400) from error
    data = starred_songs_csv(entries) if kind == "csv" else starred_songs_text(entries)
    destination = _destination(paths)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    temporary = destination / f".{EXPORT_PREFIX}{secrets.token_hex(8)}.partial"
    final: Path | None = None
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(1, MAX_NAME_ATTEMPTS + 1):
            suffix = "" if attempt == 1 else f"-{attempt}"
            candidate = destination / f"{EXPORT_PREFIX}{stamp}{suffix}{EXPORT_FORMATS[kind]}"
            try:
                _publish(temporary, candidate)
            except FileExistsError:
                continue
            final = candidate
            break
        if final is None:
            raise StarredSongsError("Too many files were saved this second. Wait a moment and try again.",
                                    code="STARRED_SONGS_NAME_COLLISION", status=409, retryable=True)
    except StarredSongsError:
        raise
    except (OSError, ValueError) as error:
        raise StarredSongsError(
            "The starred songs could not be written to the downloads folder. Check free disk space and try again.",
            code="STARRED_SONGS_WRITE_FAILED", status=500, retryable=True) from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return {"name": final.name, "count": len(entries)}
