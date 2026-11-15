"""Song log: the songs radio stations announced while the user listened.

The log lives in its own file, state/song-log.json, and never in
profile-preferences.json. World Media 0.1.8 and older treat a profile file
that holds any key they do not know as unreadable: they ignore all of it,
favorites and settings included, and refuse to save such a file. A song log
key there could therefore cost a user their favorites after going back to an
older version. Older versions never open this file, so they are unaffected.

Every value is plain text. Nothing from a request ever names a file: "Save to
file" writes a CSV with a name chosen here into the downloads folder, through
a partial file that is renamed into place only once it is complete and never
over an existing file.

Nothing saved is ever lost to a bad read. A missing file is an empty log. A
file that cannot be understood (not JSON, a newer version, an invalid entry,
too large) is reported as unreadable and is moved aside, under a new name in
the same folder, just before the first write that replaces it; the newest
MAX_SET_ASIDE such files are kept. A file that cannot be read right now
(locked, no permission) is an error, so the page retries instead of writing.

Writes are ordered by the server: each carries a revision, the file keeps the
latest one, and a write whose revision is not newer than the stored one is
not applied. It is answered with the stored revision and entries instead, so
the page can merge in what it lacks and write again. A late or repeated
request can therefore never undo a newer write or a clear.
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


SONG_LOG_FILENAME = "song-log.json"
SONG_LOG_VERSION = 1
MAX_ENTRIES = 500
# Longest text per field, in characters (code points), same as the page.
FIELD_LIMITS = {"title": 200, "station": 200, "stationId": 300, "source": 64}
ENTRY_KEYS = frozenset({"time", *FIELD_LIMITS})
# Milliseconds since 1970; the top is 3000-01-01, which Windows can still show
# as a local date.
MAX_TIME_MS = 32_503_680_000_000
# A body the page sends: every character is at most four bytes of UTF-8 (JSON
# writes them unescaped), plus keys, quotes and the time for each entry.
MAX_BODY_BYTES = MAX_ENTRIES * (sum(FIELD_LIMITS.values()) * 4 + 128) + 1024
# The stored file: JSON may write a character as an escape of up to twelve bytes.
MAX_FILE_BYTES = MAX_ENTRIES * (sum(FIELD_LIMITS.values()) * 12 + 128) + 1024
# Revisions are whole numbers the page can count exactly (JavaScript's limit).
MAX_REVISION = 2**53 - 1
SET_ASIDE_PREFIX = "song-log-unreadable-"
MAX_SET_ASIDE = 3
_SET_ASIDE_NAME = re.compile(r"song-log-unreadable-(\d{8}-\d{6})(?:-(\d+))?\.json")
EXPORT_PREFIX = "WorldMedia-song-log-"
EXPORT_EXTENSION = ".csv"
MAX_NAME_ATTEMPTS = 100
CSV_HEADER = ("Date", "Time", "Song", "Station")
# A spreadsheet treats a cell that starts with one of these as a formula.
FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")

# Control characters and lone surrogates (which cannot be written as UTF-8).
_UNSAFE_TEXT = re.compile("[\x00-\x1f\x7f\ud800-\udfff]")
_CSV_LINE_BREAKS = re.compile(r"[\x00-\x08\x0a-\x1f\x7f\u2028\u2029]")

_STORE_LOCK = threading.Lock()


class SongLogError(RuntimeError):
    """A song log request that could not be done. The message is plain text."""

    def __init__(self, message: str, *, code: str = "SONG_LOG_FAILED", status: int = 500,
                 retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def song_log_path(paths: RuntimePaths) -> Path:
    return paths.state_root / "state" / SONG_LOG_FILENAME


def _entry(value: object) -> dict:
    """One entry exactly as the page sends it, or ValueError."""

    if not isinstance(value, dict) or set(value) != ENTRY_KEYS:
        raise ValueError("Each song log entry needs exactly time, station, stationId, source and title.")
    time_ms = value["time"]
    if isinstance(time_ms, bool) or not isinstance(time_ms, int) or not 0 < time_ms <= MAX_TIME_MS:
        raise ValueError("A song log time is invalid.")
    entry: dict = {"time": time_ms}
    for field, limit in FIELD_LIMITS.items():
        text = value[field]
        if not isinstance(text, str):
            raise ValueError("Song log text must be text.")
        if len(text) > limit:
            raise ValueError("A song log text is too long.")
        if _UNSAFE_TEXT.search(text):
            raise ValueError("A song log text contains characters that are not allowed.")
        entry[field] = text
    if not entry["title"].strip():
        raise ValueError("A song log entry needs a song title.")
    return entry


def normalize_entries(value: object) -> list[dict]:
    """The entries of a request: a list of at most MAX_ENTRIES valid entries."""

    if not isinstance(value, list):
        raise ValueError("Song log entries must be a list.")
    if len(value) > MAX_ENTRIES:
        raise ValueError(f"A song log holds at most {MAX_ENTRIES} songs.")
    return [_entry(item) for item in value]


def _entries_body(body: object) -> list[dict]:
    if not isinstance(body, dict) or set(body) != {"entries"}:
        raise ValueError("The song log requires only an entries list.")
    return normalize_entries(body["entries"])


def _save_body(body: object) -> tuple[int, list[dict]]:
    if not isinstance(body, dict) or set(body) != {"revision", "entries"}:
        raise ValueError("Saving the song log requires only a revision and an entries list.")
    revision = body["revision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 < revision <= MAX_REVISION:
        raise ValueError("The song log revision is invalid.")
    return revision, normalize_entries(body["entries"])


def _unavailable(error: OSError) -> SongLogError:
    return SongLogError("The saved song log cannot be read right now. It was not changed; try again in a moment.",
                        code="SONG_LOG_UNAVAILABLE", status=503, retryable=True)


def _read_state(paths: RuntimePaths) -> tuple[str, int, list[dict]]:
    """("missing" | "ok" | "unreadable", revision, entries oldest first).

    Raises SongLogError when the file exists but cannot be read right now."""

    path = song_log_path(paths)
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return "missing", 0, []
    except OSError as error:
        raise _unavailable(error) from error
    if not stat.S_ISREG(info.st_mode):
        raise SongLogError("song-log.json in your data folder is not an ordinary file, so it was not changed.",
                           code="SONG_LOG_UNSAFE", status=409)
    if info.st_size > MAX_FILE_BYTES:
        return "unreadable", 0, []
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return "missing", 0, []
    except OSError as error:
        raise _unavailable(error) from error
    try:
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("version") != SONG_LOG_VERSION:
            raise ValueError("unsupported song log file")
        revision = document.get("revision", 0)  # files from before revisions start at 0
        if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= MAX_REVISION:
            raise ValueError("invalid revision")
        entries = normalize_entries(document.get("entries"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return "unreadable", 0, []
    return "ok", revision, entries


def load_song_log(paths: RuntimePaths) -> dict:
    """{"entries", "revision", "unreadable"}. A missing file is an empty log;
    an unreadable one is an empty log with "unreadable" set (the file stays
    until the first write moves it aside). Raises SongLogError when the file
    cannot be read right now."""

    with _STORE_LOCK:
        status, revision, entries = _read_state(paths)
    return {"entries": entries, "revision": revision, "unreadable": status == "unreadable"}


def _set_aside_key(name: str) -> tuple[str, int] | None:
    match = _SET_ASIDE_NAME.fullmatch(name)
    return (match.group(1), int(match.group(2) or 1)) if match else None


def _set_aside(paths: RuntimePaths, now: datetime) -> Path:
    """Move an unreadable song-log.json aside (never over another file), then
    keep only the newest MAX_SET_ASIDE set-aside files."""

    path = song_log_path(paths)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    kept: Path | None = None
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
        raise SongLogError("The unreadable song log could not be moved aside, so it was not replaced.",
                           code="SONG_LOG_SET_ASIDE_FAILED", status=500, retryable=True) from error
    if kept is None:
        raise SongLogError("The unreadable song log could not be moved aside, so it was not replaced.",
                           code="SONG_LOG_SET_ASIDE_FAILED", status=409, retryable=True)
    try:
        found = []
        for child in path.parent.iterdir():
            key = _set_aside_key(child.name)
            if key is None or child.name == kept.name:
                continue
            info = os.lstat(child)
            if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                found.append((key, child))
        found.sort()
        # The file just moved aside always stays; the oldest others go.
        for _, child in found[: max(0, len(found) - (MAX_SET_ASIDE - 1))]:
            child.unlink()
    except OSError:
        pass  # Old set-aside files are only tidied up; that may wait.
    return kept


def save_song_log(body: object, paths: RuntimePaths, *, now: datetime | None = None) -> dict:
    """Apply a write if its revision is newer than the stored one.

    Applied: {"saved": True, "revision", "count"}. Not newer: {"saved": False,
    "stale": True, "revision", "entries"} with what is stored, so the page can
    merge and write again. Raises ValueError for an invalid body and
    SongLogError when the stored file cannot be read or moved aside."""

    revision, entries = _save_body(body)
    with _STORE_LOCK:
        status, current, stored = _read_state(paths)
        if revision <= current:
            return {"saved": False, "stale": True, "revision": current, "entries": stored}
        if status == "unreadable":
            _set_aside(paths, now or datetime.now())
        _atomic_write_json(song_log_path(paths),
                           {"version": SONG_LOG_VERSION, "revision": revision, "entries": entries})
    return {"saved": True, "revision": revision, "count": len(entries)}


def _cell(text: str) -> str:
    """One CSV cell: one line, and never read as a formula."""

    if text.startswith(FORMULA_STARTS):
        text = "'" + text
    return _CSV_LINE_BREAKS.sub(" ", text)


def song_log_csv(entries: list[dict]) -> bytes:
    """UTF-8 with a byte order mark, so Excel reads it as UTF-8; rows in the
    order given (the panel sends newest first) and local date and time."""

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for entry in entries:
        try:
            moment = datetime.fromtimestamp(entry["time"] / 1000)
            day, clock = moment.strftime("%Y-%m-%d"), moment.strftime("%H:%M:%S")
        except (OverflowError, OSError, ValueError):
            day, clock = "", ""
        writer.writerow((day, clock, _cell(entry["title"]), _cell(entry["station"])))
    return buffer.getvalue().encode("utf-8-sig")


def _publish(temporary: Path, final: Path) -> None:
    """Move the finished file into place without ever replacing an existing file."""

    if os.name == "nt":
        os.rename(temporary, final)  # Windows refuses to rename onto an existing file.
    else:
        os.link(temporary, final)
        temporary.unlink()


def _destination(paths: RuntimePaths) -> Path:
    try:
        root = _validated_download_root(paths)
        root.mkdir(parents=True, exist_ok=True)
    except DownloadError as error:
        raise SongLogError(str(error), code="UNSAFE_DOWNLOAD_ROOT", status=409) from error
    except OSError as error:
        raise SongLogError("The downloads folder is not available, so the song log was not saved.",
                           code="DOWNLOADS_NOT_WRITABLE", status=409, retryable=True) from error
    return root


def export_song_log(body: object, paths: RuntimePaths, *, now: datetime | None = None) -> dict:
    """Write the entries in a request body as a CSV file in the downloads folder."""

    try:
        entries = _entries_body(body)
    except ValueError as error:
        raise SongLogError(str(error), code="INVALID_SONG_LOG", status=400) from error
    data = song_log_csv(entries)
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
            candidate = destination / f"{EXPORT_PREFIX}{stamp}{suffix}{EXPORT_EXTENSION}"
            try:
                _publish(temporary, candidate)
            except FileExistsError:
                continue
            final = candidate
            break
        if final is None:
            raise SongLogError("Too many song logs were saved this second. Wait a moment and try again.",
                               code="SONG_LOG_NAME_COLLISION", status=409, retryable=True)
    except SongLogError:
        raise
    except (OSError, ValueError) as error:
        raise SongLogError("The song log could not be written to the downloads folder. Check free disk space and try again.",
                           code="SONG_LOG_WRITE_FAILED", status=500, retryable=True) from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return {"name": final.name, "count": len(entries)}
