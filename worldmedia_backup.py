"""One-click backup: a ZIP of the user's saved data plus universal .m3u8 playlists.

Only an explicit list of files in the state folder is copied, plus the user's
station pictures (worldmedia_station_images.py: ordinary files directly in the
station-images folder that pass the artwork image check). Cache, logs, the
WebView profile, tools and anything else are never read, and no path from a
request is ever used. The ZIP is written to a partial file
in the downloads folder and renamed into place only once it is complete; a
backup never changes any state file.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import stat
import threading
import zipfile
from datetime import datetime
from pathlib import Path

from worldmedia_downloads import DownloadError, _validated_download_root
from worldmedia_playlists import MAX_STORE_BYTES, PlaylistStore, _web_url, parse_playlist
from worldmedia_runtime import (
    LEGACY_PROFILE_TRANSFER_KEYS,
    PORTABLE_STATE_DIR,
    PROFILE_FILES_LOCK,
    PROFILE_TRANSFER_EXTRA_FILENAME,
    PROFILE_TRANSFER_FILENAME,
    PROFILE_TRANSFER_MAX_BYTES,
    PROFILE_TRANSFER_VERSION,
    RuntimePaths,
    normalize_profile_transfer_values,
)
from worldmedia_security import sanitize_filename
from worldmedia_songlog import MAX_FILE_BYTES as MAX_SONG_LOG_FILE_BYTES, SONG_LOG_FILENAME
from worldmedia_starred import MAX_FILE_BYTES as MAX_STARRED_FILE_BYTES, STARRED_FILENAME
from worldmedia_station_images import FOLDER_NAME as STATION_IMAGES_FOLDER, StationImages


BACKUP_PREFIX = "WorldMedia-backup-"
BACKUP_EXTENSION = ".zip"
STATE_ARCHIVE_DIR = f"{PORTABLE_STATE_DIR}/state"
EXPORTS_DIR = "exports"
PLAYLISTS_FILENAME = "playlists.json"
FAVORITES_KEY = "worldmedia.favorites.v1"
# Favorites categories (src/lib/favorite-groups.js): the category name becomes a
# favorite's group-title in the exports.
FAVORITE_GROUPS_KEY = "worldmedia.favgroups.v1"
# The user's own names for favorites (src/lib/favorite-names.js): a renamed
# favorite is written under that name in the exports.
FAVORITE_NAMES_KEY = "worldmedia.favnames.v1"
# The old job-history key is never written by this version, and job records can
# hold local file paths, so it stays out of the copy in the ZIP.
STRIPPED_PROFILE_KEYS = frozenset({"worldmedia.jobs.v1"})
# Same bound as load_profile_transfer: JSON can turn one byte into six.
MAX_PROFILE_FILE_BYTES = PROFILE_TRANSFER_MAX_BYTES * 6 + 8 * 1024
MAX_PLAYLIST_FILE_BYTES = MAX_STORE_BYTES
# Everything that goes into one ZIP, before compression.
MAX_ARCHIVE_INPUT_BYTES = 192 * 1024 * 1024
STATION_IMAGES_ARCHIVE_DIR = f"{PORTABLE_STATE_DIR}/{STATION_IMAGES_FOLDER}"
# Room kept for README.txt when station pictures fill the rest of the limit.
README_RESERVE_BYTES = 64 * 1024
MAX_NAME_ATTEMPTS = 100
FAVORITE_FILES = (
    ("radio", "favorites-radio.m3u8"),
    ("tv", "favorites-tv.m3u8"),
    ("other", "favorites-other.m3u8"),
)
SOURCE_NAMES = {
    "radio-browser": "Radio Browser",
    "iptv-org": "iptv-org",
    "internet-archive": "Internet Archive",
    "nasa": "NASA",
    "wikimedia": "Wikimedia Commons",
    "librivox": "LibriVox",
    "media-ccc": "media.ccc.de",
    "gpodder": "gPodder Podcasts",
    "peertube": "PeerTube",
    "owncast": "Owncast",
    "library-of-congress": "Library of Congress",
}

# Every character that could end an M3U line in any reader (str.splitlines()
# breaks on several beyond CR and LF), other control characters, and the
# invisible direction overrides, and lone surrogates (which cannot be written
# as UTF-8). None of them may reach a written value.
_UNSAFE_TEXT = re.compile(
    "[\x00-\x1f\x7f-\x9f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]"
)
# Reparse tags with this bit are links (symbolic links, junctions). Others, such
# as OneDrive files, are ordinary files as far as a backup is concerned.
_NAME_SURROGATE = 0x20000000
# sanitize_filename() already handles CON, PRN, AUX, NUL, COM1-9 and LPT1-9.
_EXTRA_DEVICE_NAMES = re.compile(
    r"(?:CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)"
)
# Windows allows 255 UTF-16 units in one file name. Export names stay well below,
# so the full path still fits when the ZIP is extracted into a deep folder.
MAX_EXPORT_NAME_UNITS = 128
# An imported playlist keeps its file's name ("Weekend.xspf"); one such ending is
# dropped so the export is "Weekend.m3u8", not "Weekend.xspf.m3u8".
_PLAYLIST_FILE_ENDING = re.compile(r"\.(?:m3u8?|pls|xspf)$", re.IGNORECASE)

_BACKUP_LOCK = threading.Lock()


class BackupError(RuntimeError):
    """A backup that could not be made. The message is plain text for the UI."""

    def __init__(self, message: str, *, code: str = "BACKUP_FAILED", status: int = 500,
                 retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE)


def _not_ordinary(info: os.stat_result) -> bool:
    return _is_link(info) or not stat.S_ISREG(info.st_mode)


def _check_state_folder(folder: Path) -> bool:
    """True when the state folder exists; refuses a link or junction."""

    try:
        info = os.lstat(folder)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise BackupError("Your data folder could not be read.", code="BACKUP_STATE_UNREADABLE",
                          status=409, retryable=True) from error
    if _is_link(info) or not stat.S_ISDIR(info.st_mode):
        raise BackupError("The state folder in your data folder is a link, so no backup was made.",
                          code="BACKUP_STATE_UNSAFE", status=409)
    return True


def _read_state_file(path: Path, limit: int) -> bytes | None:
    """Read one ordinary file without following links; None when it is missing."""

    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise BackupError(f"{path.name} could not be read.", code="BACKUP_STATE_UNREADABLE",
                          status=409, retryable=True) from error
    if _not_ordinary(info):
        raise BackupError(
            f"{path.name} in your data folder is a link or not an ordinary file, so no backup was made.",
            code="BACKUP_STATE_UNSAFE", status=409,
        )
    if info.st_size > limit:
        raise BackupError(f"{path.name} is too large to back up.", code="BACKUP_TOO_LARGE", status=409)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            opened = os.fstat(handle.fileno())
            # The file that was opened must be the one that was checked.
            if (opened.st_ino, opened.st_dev) != (info.st_ino, info.st_dev) or _not_ordinary(opened):
                raise BackupError(f"{path.name} changed while it was being read. Try again.",
                                  code="BACKUP_STATE_CHANGED", status=409, retryable=True)
            data = handle.read(limit + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise BackupError(f"{path.name} could not be read.", code="BACKUP_STATE_UNREADABLE",
                          status=409, retryable=True) from error
    if len(data) > limit:
        raise BackupError(f"{path.name} is too large to back up.", code="BACKUP_TOO_LARGE", status=409)
    return data


def _profile_copy(raw: bytes) -> tuple[bytes, dict[str, str], bool]:
    """The profile file for the ZIP, its values, and whether anything was removed."""

    try:
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("version") != PROFILE_TRANSFER_VERSION:
            raise ValueError("unsupported profile file")
        values = normalize_profile_transfer_values(document.get("values"))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise BackupError(
            "Your saved favorites and settings could not be read, so no backup was made.",
            code="BACKUP_STATE_UNREADABLE", status=409,
        ) from error
    kept = {key: value for key, value in values.items() if key not in STRIPPED_PROFILE_KEYS}
    if len(kept) == len(values) and set(document) == {"version", "values"}:
        return raw, kept, False
    # Same layout the app writes (worldmedia_runtime._atomic_write_json).
    rewritten = json.dumps({"version": PROFILE_TRANSFER_VERSION, "values": kept},
                           separators=(",", ":")) + "\n"
    return rewritten.encode("utf-8"), kept, True


def _extra_profile_copy(raw: bytes) -> tuple[bytes, dict[str, str]] | None:
    """The file of newer profile keys for the ZIP and its values, or None when it
    cannot be read. It only holds extras such as favorites categories, so an
    unreadable one is left out instead of stopping the backup."""

    try:
        data, values, _ = _profile_copy(raw)
    except BackupError:
        return None
    return data, {key: value for key, value in values.items() if key not in LEGACY_PROFILE_TRANSFER_KEYS}


def _clean_text(value: object, limit: int = 300) -> str:
    text = value if isinstance(value, str) else ""
    text = _UNSAFE_TEXT.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _clean_attribute(value: object) -> str:
    return _clean_text(value, 200).replace('"', "'")


def _export_url(value: object) -> str:
    """A public http(s) address that fits on one line, or ''."""

    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or _UNSAFE_TEXT.search(value) or value.startswith("#"):
        return ""
    return _web_url(value)


def _export_logo(*values: object) -> str:
    """The first public picture address that can sit inside a quoted attribute."""

    for value in values:
        logo = _export_url(value)
        if logo and '"' not in logo:
            return logo
    return ""


def _m3u_entry(name: str, url: str, logo: str, group: str) -> str:
    """One extended M3U entry. Every value must already be cleaned."""

    attributes = f' tvg-logo="{logo}"' if logo else ""
    attributes += f' group-title="{group}"' if group else ""
    return f"#EXTINF:-1{attributes},{name}\n{url}\n"


def _favorite_bucket(item: dict) -> str:
    kind = item.get("type")
    return kind if kind in {"radio", "tv"} else "other"


def _favorite_entry(item: dict, index: int, category: str = "", own_name: str = "") -> str | None:
    url = _export_url(item.get("stream_url")) or _export_url(item.get("download_url"))
    if not url:
        return None
    extra = item.get("_extra") if isinstance(item.get("_extra"), dict) else {}
    logo = _export_logo(item.get("thumbnail"), extra.get("artworkUrl"))
    source = item.get("source") if isinstance(item.get("source"), str) else ""
    # The user's own category for this favorite, when it has one.
    group = _clean_attribute(category)
    if not group and source == "playlist":
        group = _clean_attribute(item.get("description")) or "My playlists"
    elif not group:
        group = _clean_attribute(SOURCE_NAMES.get(source, source))
    name = (_clean_text(own_name) or _clean_text(item.get("title")) or _clean_text(item.get("id"))
            or f"Favorite {index}")
    return _m3u_entry(name, url, logo, group)


def _favorites_from_profile(values: dict[str, str]) -> tuple[list[dict], bool]:
    """The saved favorites, and False when the list could not be read."""

    raw = values.get(FAVORITES_KEY)
    if raw is None:
        return [], True
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        return [], False
    if not isinstance(parsed, list):
        return [], False
    return [item for item in parsed if isinstance(item, dict)], True


def favorite_categories(values: dict[str, str]) -> dict[str, str]:
    """Favorite id -> category name from the saved categories; {} when there are
    none or they cannot be read. Never stops a backup."""

    raw = values.get(FAVORITE_GROUPS_KEY)
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        return {}
    if not isinstance(parsed, dict) or parsed.get("version") != 1:
        return {}
    groups, assign = parsed.get("groups"), parsed.get("assign")
    if not isinstance(groups, list) or not isinstance(assign, dict):
        return {}
    names: dict[str, str] = {}
    for group in groups:
        if isinstance(group, dict) and isinstance(group.get("id"), str) and isinstance(group.get("name"), str):
            names.setdefault(group["id"], group["name"])
    return {
        favorite_id: names[group_id] for favorite_id, group_id in assign.items()
        if isinstance(group_id, str) and group_id in names
    }


def favorite_names(values: dict[str, str]) -> dict[str, str]:
    """Favorite id -> the user's own name for it; {} when there are none or they
    cannot be read. Never stops a backup."""

    raw = values.get(FAVORITE_NAMES_KEY)
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        return {}
    if not isinstance(parsed, dict) or parsed.get("version") != 1 or not isinstance(parsed.get("names"), dict):
        return {}
    return {
        favorite_id: name for favorite_id, name in parsed["names"].items()
        if isinstance(favorite_id, str) and isinstance(name, str) and name.strip()
    }


def build_favorite_exports(favorites: list[dict], categories: dict[str, str] | None = None,
                           names: dict[str, str] | None = None,
                           ) -> tuple[dict[str, str], int, int]:
    """Extended M3U text per favorites file, how many were written, how many skipped.

    ``categories`` maps a favorite id to the name of the category it is in,
    ``names`` to the user's own name for it."""

    entries: dict[str, list[str]] = {bucket: [] for bucket, _ in FAVORITE_FILES}
    skipped = 0
    for index, item in enumerate(favorites, start=1):
        item_id = item.get("id")
        category = (categories or {}).get(item_id, "") if isinstance(item_id, str) else ""
        own_name = (names or {}).get(item_id, "") if isinstance(item_id, str) else ""
        entry = _favorite_entry(item, index, category, own_name)
        if entry is None:
            skipped += 1
            continue
        entries[_favorite_bucket(item)].append(entry)
    files = {
        filename: "#EXTM3U\n" + "".join(entries[bucket])
        for bucket, filename in FAVORITE_FILES if entries[bucket]
    }
    written = sum(len(lines) for lines in entries.values())
    return files, written, skipped


def playlist_export_text(entry: dict) -> tuple[str, int]:
    """An extended M3U file for one imported playlist, and how many entries it has.

    Built only from the entries the app's own parser accepts (with the stored
    address of an online list, so relative entries become absolute), and every
    value is cleaned like a favorite's. Nothing from the stored text is copied
    as it is: player options, local files and other lines are left out."""

    try:
        parsed = parse_playlist(entry.get("text"), entry.get("default_type"), entry.get("base_url", ""))
    except ValueError:
        return "#EXTM3U\n", 0
    lines: list[str] = []
    for index, item in enumerate(parsed["items"], start=1):
        url = _export_url(item.get("stream_url"))
        if not url:
            continue
        extra = item.get("_extra") if isinstance(item.get("_extra"), dict) else {}
        name = _clean_text(item.get("title")) or f"Channel {index}"
        lines.append(_m3u_entry(name, url, _export_logo(extra.get("artworkUrl")),
                                _clean_attribute(item.get("description"))))
    return "#EXTM3U\n" + "".join(lines), len(lines)


def _is_device_name(filename: str) -> bool:
    stem = filename.split(".", 1)[0].rstrip(" ").upper()
    return bool(_EXTRA_DEVICE_NAMES.fullmatch(stem))


def _fit_utf16(text: str, units: int) -> str:
    """The longest start of ``text`` that fits in ``units`` UTF-16 units, as Windows
    counts them. Whole characters only, so a surrogate pair is never split."""

    used = 0
    for index, character in enumerate(text):
        used += 2 if ord(character) > 0xFFFF else 1
        if used > units:
            return text[:index].rstrip(" .")
    return text


def safe_export_name(name: object, used: set[str]) -> str:
    """A Windows-safe .m3u8 file name, not yet in ``used`` (compared ignoring case).

    The whole name, with any " (2)" and the extension, fits MAX_EXPORT_NAME_UNITS.
    One playlist file ending the name still carries (.m3u, .m3u8, .pls, .xspf) is
    dropped first."""

    text = _PLAYLIST_FILE_ENDING.sub("", name.rstrip(), count=1) if isinstance(name, str) else ""
    filename = sanitize_filename(text, "m3u8", fallback="playlist")
    if _is_device_name(filename):
        filename = f"_{filename}"
    stem = filename[: -len(".m3u8")]
    room = MAX_EXPORT_NAME_UNITS - len(".m3u8")
    candidate = f"{_fit_utf16(stem, room) or 'playlist'}.m3u8"
    number = 2
    while candidate.casefold() in used:
        suffix = f" ({number})"
        candidate = f"{_fit_utf16(stem, room - len(suffix)) or 'playlist'}{suffix}.m3u8"
        number += 1
    used.add(candidate.casefold())
    return candidate


def _readme(*, created: datetime, favorites: int, skipped: int,
            favorites_unreadable: bool, playlists: int, playlists_unreadable: bool,
            export_names: list[str], state_names: list[str], stripped_jobs: bool,
            station_images: int = 0, station_images_left_out: int = 0, station_images_note: str = "") -> str:
    def plural(count: int, one: str, many: str) -> str:
        return f"{count} {one if count == 1 else many}"

    lines = [
        "World Media backup",
        f"Made on {created.strftime('%d %B %Y at %H:%M:%S')}.",
        f"It holds {plural(favorites, 'favorite', 'favorites')} and "
        f"{plural(playlists, 'imported playlist', 'imported playlists')}.",
        "",
        "WHAT IS IN THIS ZIP",
        "",
        "exports\\",
        "  Playlist files (.m3u8) that most media players can open.",
    ]
    descriptions = {
        "favorites-radio.m3u8": "your favorite radio stations",
        "favorites-tv.m3u8": "your favorite TV channels",
        "favorites-other.m3u8": "your other favorite videos and audio",
    }
    for filename in export_names:
        if filename in descriptions:
            lines.append(f"    {filename} - {descriptions[filename]}")
    if playlists:
        lines.append("  plus one .m3u8 file for each playlist you imported into World Media.")
    lines.append("  The exports are cleaned; the state copy below is your data exactly as stored.")
    if not export_names:
        lines.append("  (Empty: there was nothing that could be written as a playlist.)")
    lines += [
        "  They hold only web addresses World Media can play, with names, groups and",
        "  pictures. A file is only made when it has at least one entry.",
        "",
        f"{PORTABLE_STATE_DIR}\\state\\",
        "  A copy of your saved World Media data:",
    ]
    if PLAYLISTS_FILENAME in state_names:
        lines.append("    playlists.json - the playlists you imported or added by link")
    if PROFILE_TRANSFER_FILENAME in state_names:
        lines.append("    profile-preferences.json - your favorites, settings, volume and equalizer curves")
    if PROFILE_TRANSFER_EXTRA_FILENAME in state_names:
        lines.append("    profile-preferences-extra.json - newer saved data, such as your favorites")
        lines.append("      categories and the names you gave favorites, kept apart so older")
        lines.append("      versions of World Media can still read the file above")
    if SONG_LOG_FILENAME in state_names:
        lines.append("    song-log.json - the songs radio stations announced while you listened")
    if STARRED_FILENAME in state_names:
        lines.append("    starred-songs.json - the songs you starred")
    if not state_names:
        lines.append("    (Empty: there was no saved data yet.)")
    lines.append("  Cache, logs, browser data, FFmpeg tools and your downloads are not included.")
    if stripped_jobs:
        lines.append("  Old download history was left out of that copy, because it can contain file")
        lines.append("  locations on this computer.")
    if station_images or station_images_left_out or station_images_note:
        lines += ["", f"{PORTABLE_STATE_DIR}\\{STATION_IMAGES_FOLDER}\\"]
    if station_images:
        lines += [
            f"  Your own station pictures ({plural(station_images, 'picture', 'pictures')}), each checked to be",
            "  a real PNG, JPEG, GIF or WebP image. To restore them, copy this folder into",
            f"  the {PORTABLE_STATE_DIR} folder next to the World Media program.",
        ]
    if station_images_left_out:
        lines += [
            f"  {plural(station_images_left_out, 'picture', 'pictures')} did not fit in this backup, which is limited to",
            f"  {MAX_ARCHIVE_INPUT_BYTES // (1024 * 1024)} MB, and {'was' if station_images_left_out == 1 else 'were'}"
            " left out. Copy them from your station-images folder by hand.",
        ]
    if station_images_note:
        lines.append(f"  Station pictures were left out. {_clean_text(station_images_note)}")
    lines += [
        "",
        "USING THE .M3U8 FILES IN OTHER PLAYERS",
        "",
        "Open a file in your player (in VLC: Media > Open File), or drag it onto the",
        "player's window. Most players and IPTV or internet radio apps accept .m3u8",
        "files; some call them M3U playlists. Each entry is the station's or channel's",
        "own address, so the other player connects to it directly.",
        "",
        "RESTORING BY HAND",
        "",
        "1. Close World Media completely.",
        f"2. Copy the \"state\" folder from {PORTABLE_STATE_DIR} in this ZIP into the",
        f"   {PORTABLE_STATE_DIR} folder next to the World Media program, and let it",
        "   replace the files with the same names.",
        "3. Start World Media.",
        "Your imported playlists, song log and starred songs come back straight away.",
        "Favorites and settings are",
        "only taken from the backup by a copy of World Media that has none of its own",
        "yet, such as a new computer or a fresh copy of the app. A copy that already",
        "has favorites keeps its own.",
    ]
    if skipped or favorites_unreadable or playlists_unreadable:
        lines += ["", "LEFT OUT OF THE .M3U8 FILES", ""]
    if skipped:
        lines += [
            f"{plural(skipped, 'favorite has', 'favorites have')} no direct stream address saved,",
            f"so {'it' if skipped == 1 else 'they'} could not be written to the .m3u8 files. These are usually",
            "items World Media looks up again each time you play them. They are still in",
            "the copy of your data above.",
        ]
    if favorites_unreadable:
        lines.append("Your favorites list could not be read, so no favorites files were made.")
    if playlists_unreadable:
        lines += [
            "playlists.json could not be read, so no playlist files were made. It is",
            "copied into the ZIP unchanged.",
        ]
    lines += [
        "",
        "PRIVACY",
        "",
        "Playlist addresses can contain private links or account tokens. Share this",
        "ZIP only with people you trust.",
    ]
    return "\r\n".join(lines) + "\r\n"


def _publish(temporary: Path, final: Path) -> None:
    """Move the finished ZIP into place without ever replacing an existing file."""

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
        raise BackupError(str(error), code="UNSAFE_DOWNLOAD_ROOT", status=409) from error
    except OSError as error:
        raise BackupError("The downloads folder is not available, so no backup was made.",
                          code="DOWNLOADS_NOT_WRITABLE", status=409, retryable=True) from error
    return root


def create_backup(
    paths: RuntimePaths,
    store: PlaylistStore,
    *,
    secrets_to_exclude: tuple[str, ...] = (),
    now: datetime | None = None,
) -> dict:
    """Write one backup ZIP into the downloads folder and describe it."""

    if not _BACKUP_LOCK.acquire(blocking=False):
        raise BackupError("A backup is already being made. Please wait for it to finish.",
                          code="BACKUP_RUNNING", status=409, retryable=True)
    try:
        return _create_backup(paths, store, secrets_to_exclude, now or datetime.now())
    finally:
        _BACKUP_LOCK.release()


def _create_backup(paths: RuntimePaths, store: PlaylistStore, secrets_to_exclude: tuple[str, ...],
                   created: datetime) -> dict:
    state_folder = paths.state_root / "state"
    members: list[tuple[str, bytes]] = []
    state_names: list[str] = []
    playlists_raw: bytes | None = None
    playlist_entries: list[dict] | None = []
    profile_values: dict[str, str] = {}
    stripped_jobs = False

    if _check_state_folder(state_folder):
        playlist_path = state_folder / PLAYLISTS_FILENAME
        if Path(store.path).absolute() != playlist_path.absolute():
            raise BackupError("The playlist store is not in the data folder.", code="BACKUP_STATE_UNSAFE", status=409)
        playlists_raw, playlist_entries = store.backup_snapshot(
            lambda path: _read_state_file(path, MAX_PLAYLIST_FILE_BYTES)
        )
        # Both profile files come from the same write (see save_profile_transfer).
        with PROFILE_FILES_LOCK:
            profile_raw = _read_state_file(state_folder / PROFILE_TRANSFER_FILENAME, MAX_PROFILE_FILE_BYTES)
            extra_raw = _read_state_file(state_folder / PROFILE_TRANSFER_EXTRA_FILENAME, MAX_PROFILE_FILE_BYTES)
        if playlists_raw is not None:
            members.append((f"{STATE_ARCHIVE_DIR}/{PLAYLISTS_FILENAME}", playlists_raw))
            state_names.append(PLAYLISTS_FILENAME)
        if profile_raw is not None:
            profile_bytes, profile_values, stripped_jobs = _profile_copy(profile_raw)
            members.append((f"{STATE_ARCHIVE_DIR}/{PROFILE_TRANSFER_FILENAME}", profile_bytes))
            state_names.append(PROFILE_TRANSFER_FILENAME)
        extra_copy = _extra_profile_copy(extra_raw) if extra_raw is not None else None
        if extra_copy is not None:
            members.append((f"{STATE_ARCHIVE_DIR}/{PROFILE_TRANSFER_EXTRA_FILENAME}", extra_copy[0]))
            state_names.append(PROFILE_TRANSFER_EXTRA_FILENAME)
            profile_values = {**profile_values, **extra_copy[1]}
        # The song log is copied as stored, readable or not. A file too large to
        # be a song log is left out rather than stopping the backup. Files the
        # song log set aside (song-log-unreadable-*.json) are never included.
        try:
            song_log_raw = _read_state_file(state_folder / SONG_LOG_FILENAME, MAX_SONG_LOG_FILE_BYTES)
        except BackupError as error:
            if error.code != "BACKUP_TOO_LARGE":
                raise
            song_log_raw = None
        if song_log_raw is not None:
            members.append((f"{STATE_ARCHIVE_DIR}/{SONG_LOG_FILENAME}", song_log_raw))
            state_names.append(SONG_LOG_FILENAME)
        # Starred songs: the same (starred-songs-unreadable-*.json never included).
        try:
            starred_raw = _read_state_file(state_folder / STARRED_FILENAME, MAX_STARRED_FILE_BYTES)
        except BackupError as error:
            if error.code != "BACKUP_TOO_LARGE":
                raise
            starred_raw = None
        if starred_raw is not None:
            members.append((f"{STATE_ARCHIVE_DIR}/{STARRED_FILENAME}", starred_raw))
            state_names.append(STARRED_FILENAME)

    favorites, favorites_readable = _favorites_from_profile(profile_values)
    favorite_files, written, skipped = build_favorite_exports(
        favorites, favorite_categories(profile_values), favorite_names(profile_values))
    used_names: set[str] = {filename.casefold() for _, filename in FAVORITE_FILES}
    exports: list[tuple[str, str]] = [
        (filename, favorite_files[filename]) for _, filename in FAVORITE_FILES if filename in favorite_files
    ]
    for entry in playlist_entries or []:
        text, count = playlist_export_text(entry)
        if count:
            exports.append((safe_export_name(entry.get("name"), used_names), text))
    export_names = [filename for filename, _ in exports]
    playlist_count = len(playlist_entries or [])

    # Station pictures get whatever room the rest of the backup leaves, so the
    # overall limit still holds; the ones that do not fit are left out and the
    # README says so. A folder that cannot be used never stops the backup.
    picture_budget = (MAX_ARCHIVE_INPUT_BYTES - README_RESERVE_BYTES
                      - sum(len(data) for _, data in members)
                      - sum(len(text.encode("utf-8")) for _, text in exports))
    try:
        station_files, station_left_out, station_note = StationImages(paths.state_root).files_for_backup(
            max(0, picture_budget))
    except (OSError, ValueError):
        station_files, station_left_out, station_note = [], 0, "The station-images folder could not be read."
    members += [(f"{STATION_IMAGES_ARCHIVE_DIR}/{name}", data) for name, data in station_files]

    readme = _readme(
        created=created, favorites=len(favorites), skipped=skipped,
        favorites_unreadable=not favorites_readable, playlists=playlist_count,
        playlists_unreadable=playlist_entries is None, export_names=export_names,
        state_names=state_names, stripped_jobs=stripped_jobs,
        station_images=len(station_files), station_images_left_out=station_left_out,
        station_images_note=station_note,
    )
    members = (
        [("README.txt", readme.encode("utf-8"))]
        + [(f"{EXPORTS_DIR}/{filename}", text.encode("utf-8")) for filename, text in exports]
        + members
    )
    if sum(len(data) for _, data in members) > MAX_ARCHIVE_INPUT_BYTES:
        raise BackupError("Your saved data is too large to back up in one file.", code="BACKUP_TOO_LARGE", status=409)
    for secret in secrets_to_exclude:
        if isinstance(secret, str) and len(secret) >= 16:
            needle = secret.encode("utf-8")
            if any(needle in data for _, data in members):
                raise BackupError("The backup would have contained a private app key, so it was not saved.",
                                  code="BACKUP_SECRET_FOUND", status=500)

    destination = _destination(paths)
    stamp = created.strftime("%Y%m%d-%H%M%S")
    temporary = destination / f".{BACKUP_PREFIX}{secrets.token_hex(8)}.partial"
    final: Path | None = None
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            with zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                date_time = created.timetuple()[:6] if created.year >= 1980 else (1980, 1, 1, 0, 0, 0)
                for name, data in members:
                    info = zipfile.ZipInfo(name, date_time=date_time)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    archive.writestr(info, data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(1, MAX_NAME_ATTEMPTS + 1):
            suffix = "" if attempt == 1 else f"-{attempt}"
            candidate = destination / f"{BACKUP_PREFIX}{stamp}{suffix}{BACKUP_EXTENSION}"
            try:
                _publish(temporary, candidate)
            except FileExistsError:
                continue
            final = candidate
            break
        if final is None:
            raise BackupError("Too many backups were made this second. Wait a moment and try again.",
                              code="BACKUP_NAME_COLLISION", status=409, retryable=True)
        size = final.stat().st_size
    except BackupError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise BackupError("The backup file could not be written to the downloads folder. Check free disk space and try again.",
                          code="BACKUP_WRITE_FAILED", status=500, retryable=True) from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass

    return {
        "path": str(final),
        "name": final.name,
        "size": size,
        "summary": {
            "favorites": len(favorites),
            "favorites_exported": written,
            "favorites_skipped": skipped,
            "playlists": playlist_count,
            "playlists_unreadable": playlist_entries is None,
            "export_files": len(exports),
            # Only when the folder had pictures, so older readers see no change.
            **({"station_images": len(station_files), "station_images_left_out": station_left_out}
               if station_files or station_left_out else {}),
        },
    }
