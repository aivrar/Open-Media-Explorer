"""Saved folders and file boundaries for the Computer tab."""
from __future__ import annotations

import json
import os
import re
import secrets
import stat
import threading
from concurrent.futures import Future, wait
from datetime import datetime, timedelta, timezone
from pathlib import Path

from worldmedia_computer_stars import COMPUTER_STARS_FILENAME, ComputerStars
from worldmedia_computer_library import COMPUTER_LIBRARY_FILENAME, ComputerLibrary, _absolute_disk_path, _relative
from worldmedia_runtime import _atomic_write_json


COMPUTER_FOLDERS_FILENAME = "computer-folders.json"
MAX_FOLDERS = 200
AVAILABILITY_TIMEOUT = 2.0
_MAX_PATH_LENGTH = 32_767
_MAX_STATE_BYTES = MAX_FOLDERS * (_MAX_PATH_LENGTH * 24 + 256) + 1024
_STORE_LOCK = threading.Lock()
_FOLDER_ID = re.compile(r"[0-9a-f]{32}")
_DRIVE_ROOT = re.compile(r"^[A-Za-z]:\\")
_UNC_ROOT = re.compile(r'^\\\\([^\\:*?"<>|]+)\\([^\\:*?"<>|]+)(?:\\|$)')


def _windows_disk_path(path: str) -> str:
    """Validate a drive or ordinary UNC path and strip any extended prefix."""
    path = path.replace("/", "\\")
    if path[:8].lower() == "\\\\?\\unc\\":
        path = "\\\\" + path[8:]
    elif path.startswith("\\\\?\\"):
        path = path[4:]
        if not _DRIVE_ROOT.match(path):
            raise ValueError("Choose a drive or network folder.")

    drive = _DRIVE_ROOT.match(path)
    if ":" in path[2 if drive else 0:]:
        raise ValueError("That path contains a reserved Windows name.")
    if drive:
        tail = path[3:]
    else:
        unc = _UNC_ROOT.match(path)
        if (not unc or not unc[1].strip(" .") or
                unc[2].lower().rstrip(" .") in {"", "pipe", "mailslot", "ipc$"}):
            raise ValueError("Choose a drive or network folder.")
        tail = path[unc.end():]
    if os.path.isreserved(tail):
        raise ValueError("That path contains a reserved Windows name.")
    return path


def _absolute_path(path: object) -> str:
    if not isinstance(path, str) or not path or len(path) > _MAX_PATH_LENGTH or "\0" in path:
        raise ValueError("Enter a valid folder path.")
    if not os.path.isabs(path):
        raise ValueError("Enter an absolute folder path.")
    if os.name == "nt":
        _windows_disk_path(path)
    return path


def _disk_path(path: str) -> str:
    if os.name == "nt":
        path = _windows_disk_path(path)
        drive, tail = os.path.splitdrive(path)
        if drive and not tail:
            path += os.sep
    return os.path.normpath(path)


def _path_key(path: str) -> str:
    return os.path.normcase(_disk_path(path))


def _real_path(path: str) -> str:
    return _absolute_path(os.path.realpath(path, strict=True))


def _folder_available(path: str) -> bool:
    try:
        with os.scandir(_absolute_disk_path(_disk_path(path))) as entries:
            next(entries, None)
        return True
    except (OSError, ValueError):
        return False


class FolderMismatch(ValueError):
    pass


def _selected_directory(path: str) -> tuple[str, str]:
    path = os.path.normpath(os.path.abspath(_absolute_path(path)))
    _absolute_path(path)
    try:
        real = _real_path(path)
        if not stat.S_ISDIR(os.stat(real).st_mode):
            raise ValueError("Choose a folder, not a file.")
    except (FileNotFoundError, NotADirectoryError) as error:
        raise ValueError("That folder was not found.") from error
    except OSError as error:
        raise ValueError("That folder could not be opened.") from error
    return path, real


def _inside(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


class ComputerFolders:
    def __init__(self, path: Path, *, ffprobe=None) -> None:
        self.path = path
        self.stars = ComputerStars(path.with_name(COMPUTER_STARS_FILENAME))
        self._probe_lock = threading.Lock()
        self._read_cache: tuple[tuple[int, int, int], list[dict], bool] | None = None
        self._probes: dict[tuple[str, str | None], Future[str | None]] = {}
        self.library = ComputerLibrary(path.with_name(COMPUTER_LIBRARY_FILENAME), self, ffprobe=ffprobe)

    def _read(self) -> tuple[list[dict], bool]:
        """Return the entries and whether the file is damaged. I/O errors propagate."""
        try:
            info = self.path.stat()
        except FileNotFoundError:
            return [], False
        if not stat.S_ISREG(info.st_mode):
            raise OSError("The saved folder list is not a regular file.")
        if info.st_size > _MAX_STATE_BYTES:
            return [], True
        # Every play, picture and media request asks for the folder list, several times each.
        # Parse the file once per version of it: the signature changes with every save.
        signature = (info.st_mtime_ns, info.st_size, info.st_ino)
        cached = self._read_cache
        if cached is not None and cached[0] == signature:
            return [dict(folder) for folder in cached[1]], cached[2]
        folders, damaged = self._parse(info.st_size)
        self._read_cache = (signature, [dict(folder) for folder in folders], damaged)
        return folders, damaged

    def _parse(self, size: int) -> tuple[list[dict], bool]:
        with self.path.open("rb") as handle:
            # Ask only for what the file holds: read(n) reserves n bytes up front, and the
            # ceiling is very large.
            raw = handle.read(min(size, _MAX_STATE_BYTES) + 1)
        try:
            if len(raw) > _MAX_STATE_BYTES:
                return [], True
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
                return [], True
            folders = data.get("folders")
            if not isinstance(folders, list) or len(folders) > MAX_FOLDERS:
                return [], True
            ids = set()
            for folder in folders:
                if not isinstance(folder, dict) or folder.keys() - {"real", "relocated"} != {"id", "path", "added"}:
                    return [], True
                if ("relocated" in folder and (folder["relocated"] is not True or "real" not in folder)
                        or not all(isinstance(value, str) for key, value in folder.items() if key != "relocated")):
                    return [], True
                identity = folder["id"]
                if not _FOLDER_ID.fullmatch(identity) or identity in ids:
                    return [], True
                ids.add(identity)
                _absolute_path(folder["path"])
                if "real" in folder:
                    _absolute_path(folder["real"])
                if datetime.fromisoformat(folder["added"]).utcoffset() != timedelta(0):
                    return [], True
        except (ValueError, RecursionError):
            return [], True
        return folders, False

    def _snapshot(self, *, strict: bool = False) -> list[dict]:
        with _STORE_LOCK:
            try:
                folders, damaged = self._read()
                if strict and damaged:
                    raise OSError("The saved folder list is damaged.")
                return folders
            except OSError:
                if strict:
                    raise
                return []

    def _save(self, folders: list[dict], *, damaged: bool) -> None:
        if damaged:
            backup = self.path.with_name(f"{self.path.stem}-unreadable-{secrets.token_hex(8)}.json")
            self.path.replace(backup)
        _atomic_write_json(self.path, {"version": 1, "folders": folders})

    def add(self, path: str) -> dict:
        path, real = _selected_directory(path)
        path_key = _path_key(path)
        real_key = _path_key(real)
        with _STORE_LOCK:
            folders, damaged = self._read()
            legacy = None
            for folder in folders:
                if "real" in folder:
                    if _path_key(folder["real"]) == real_key:
                        return folder
                elif _path_key(folder["path"]) == path_key:
                    legacy = folder
            if legacy is not None:
                # The user selected this legacy folder again, so reuse its ID.
                legacy["real"] = real
                self._save(folders, damaged=damaged)
                return legacy
            if len(folders) >= MAX_FOLDERS:
                raise ValueError(f"You can add up to {MAX_FOLDERS} folders.")
            entry = {
                "id": secrets.token_hex(16),
                "path": path,
                "added": datetime.now(timezone.utc).isoformat(),
                "real": real,
            }
            self._save([*folders, entry], damaged=damaged)
            return entry

    def relocate(self, identity: str, path: str) -> dict:
        if not isinstance(identity, str) or not _FOLDER_ID.fullmatch(identity):
            raise ValueError("That folder ID is invalid.")
        folders = self._snapshot(strict=True)
        source = next((folder for folder in folders if folder["id"] == identity), None)
        if source is None:
            raise ValueError("That folder was not found.")
        path, real = _selected_directory(path)
        real_key = _path_key(real)

        def check_overlap(entries):
            for folder in entries:
                if folder["id"] == identity:
                    continue
                other = _path_key(folder.get("real", folder["path"]))
                if _inside(real_key, other) or _inside(other, real_key):
                    raise ValueError("Choose a folder that does not overlap another approved folder.")

        check_overlap(folders)
        sample = self.library.relocation_sample(identity, 200)
        matched = 0
        for rel in sample:
            try:
                candidate = _real_path(_absolute_disk_path(os.path.join(real, rel.replace("/", os.sep))))
                if _inside(_path_key(candidate), real_key) and stat.S_ISREG(os.stat(candidate).st_mode):
                    matched += 1
            except (OSError, ValueError):
                continue
        if matched * 2 < len(sample):
            raise FolderMismatch("That folder does not look like the same collection.")

        def update():
            with _STORE_LOCK:
                folders, damaged = self._read()
                if source not in folders:
                    raise ValueError("That saved folder has changed.")
                check_overlap(folders)
                entry = {**source, "path": path, "real": real, "relocated": True}
                self._save([entry if folder["id"] == identity else folder for folder in folders], damaged=damaged)
                return entry

        return self.library.relocate_folder(identity, update)

    def remove(self, identity: str) -> bool:
        if not isinstance(identity, str) or not _FOLDER_ID.fullmatch(identity):
            raise ValueError("That folder ID is invalid.")
        with _STORE_LOCK:
            folders, damaged = self._read()
            remaining = [folder for folder in folders if folder["id"] != identity]
            if remaining != folders:
                self._save(remaining, damaged=damaged)
                return True
        return False

    def _fill_real(self, path: str, identity: str) -> str | None:
        real = _real_path(path)
        with _STORE_LOCK:
            folders, damaged = self._read()
            for folder in folders:
                if folder["id"] == identity and folder["path"] == path:
                    if "real" not in folder:
                        folder["real"] = real
                        self._save(folders, damaged=damaged)
                    if folder["real"] == real:
                        return real
                    break
        return None

    def _probe(self, key: tuple[str, str | None], result: Future[str | None]) -> None:
        path, legacy_id = key
        real = None
        try:
            if _folder_available(path):
                real = self._fill_real(path, legacy_id) if legacy_id else path
        except (OSError, ValueError):
            pass
        finally:
            with self._probe_lock:
                result.set_result(real)
                del self._probes[key]

    def list(self, *, include_real: bool = False, strict: bool = False) -> list[dict]:
        folders = self._snapshot(strict=strict)
        entries = []
        offline = self.library.offline_roots() if not include_real else set()
        for folder, real in zip(folders, self._available_roots(folders)):
            entry = {key: folder[key] for key in ("id", "path", "added")}
            entry["available"] = real is not None and folder["id"] not in offline
            if include_real:
                entry["real"] = folder.get("real", real)
                if folder.get("relocated"):
                    entry["relocated"] = True
            entries.append(entry)
        return entries

    def saved_folder(self, identity: str) -> dict | None:
        return next((folder for folder in self._snapshot() if folder["id"] == identity), None)

    def connected_root(self, folder: dict) -> str | None:
        if folder["id"] in self.library.offline_roots():
            return None
        return self._available_roots([folder])[0]

    def allowed_path(self, folder: dict | None, rel: str) -> str | None:
        root = folder.get("real") if folder else None
        if root is None or not _relative(rel):
            return None
        candidate = _absolute_disk_path(os.path.join(root, rel.replace("/", os.sep)))
        real = self.is_allowed_file(candidate)
        return _absolute_disk_path(real) if real is not None else None

    def _available_roots(self, folders: list[dict]) -> list[str | None]:
        probes = []
        # A filesystem call on a disconnected share may outlive the request.
        # Reuse in-flight probes and bound their number even as folders change.
        with self._probe_lock:
            for folder in folders:
                key = (folder["real"], None) if "real" in folder else (folder["path"], folder["id"])
                if key not in self._probes and len(self._probes) < MAX_FOLDERS:
                    probe: Future[str | None] = Future()
                    self._probes[key] = probe
                    try:
                        threading.Thread(target=self._probe, args=(key, probe), daemon=True).start()
                    except RuntimeError:
                        del self._probes[key]
                probes.append(self._probes.get(key))
        done, _ = wait([probe for probe in probes if probe is not None], timeout=AVAILABILITY_TIMEOUT)
        return [probe.result() if probe in done else None for probe in probes]

    def is_allowed_file(self, path: str) -> str | None:
        """Return the real path of an existing regular file inside a saved real root.

        Saved roots can themselves be links or junctions. A link or junction
        within a root cannot grant access to a file outside every saved root.
        The result describes the filesystem at the time of the check.
        """
        try:
            real = _real_path(_absolute_path(path))
            if not stat.S_ISREG(os.stat(real).st_mode):
                return None
            file_key = _path_key(real)
        except (OSError, ValueError):
            return None

        for folder in self._snapshot():
            if "real" not in folder:
                continue
            root_key = _path_key(folder["real"])
            if file_key != root_key and _inside(file_key, root_key):
                return real
        return None
