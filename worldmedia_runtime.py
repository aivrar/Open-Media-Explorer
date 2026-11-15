"""Runtime root selection and atomic writability probes."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import sys
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path


APP_ID = "WorldMediaWindows"
PORTABLE_STATE_DIR = f"{APP_ID}-data"
RUNTIME_CONFIG_FILENAME = "launcher.json"
PROFILE_TRANSFER_FILENAME = "profile-preferences.json"
PROFILE_TRANSFER_VERSION = 1
PROFILE_TRANSFER_MAX_BYTES = 2 * 1024 * 1024
PROFILE_TRANSFER_KEYS = frozenset({
    "worldmedia.favorites.v1",
    "worldmedia.settings.v1",
    "worldmedia.volume.v1",
    "worldmedia.jobs.v1",
    "worldmedia.eq.v1",
    "worldmedia.favgroups.v1",  # Favorites categories (src/lib/favorite-groups.js)
})
# Releases up to 0.1.8 know only these keys, and they treat a profile file that
# holds any other key as unreadable: the whole file, favorites included. So the
# main file keeps only these keys, and every newer key goes into a separate file
# that older releases never open (see save_profile_transfer).
LEGACY_PROFILE_TRANSFER_KEYS = frozenset({
    "worldmedia.favorites.v1",
    "worldmedia.settings.v1",
    "worldmedia.volume.v1",
    "worldmedia.jobs.v1",
    "worldmedia.eq.v1",
})
PROFILE_TRANSFER_EXTRA_FILENAME = "profile-preferences-extra.json"
# Write order for the two profile files. A page sends its own random id and a
# number that only goes up with every profile write (request headers, so the
# body stays what every client sends). A write whose number is not higher than
# the last one taken for that page is answered "superseded" and changes
# nothing: a save the page gave up on cannot land after a later save or clear.
# A write without the headers (an older client) is applied as it always was.
PROFILE_WRITER_HEADER = "X-WorldMedia-Profile-Writer"
PROFILE_SEQUENCE_HEADER = "X-WorldMedia-Profile-Sequence"
MAX_PROFILE_WRITERS = 8  # Page loads remembered; the oldest is forgotten first.
_PROFILE_WRITER_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
_PROFILE_SEQUENCE = re.compile(r"[0-9]{1,16}")
# Held for every write of the pair and every read of it, so both files always
# come from the same write.
PROFILE_FILES_LOCK = threading.Lock()
_profile_writers: OrderedDict[str, int] = OrderedDict()
# Keep the long-standing default so an ordinary EXE update retains the existing
# WebView local-storage origin.  The user may choose another port in Settings;
# that change uses the profile handoff below.
DEFAULT_SERVER_PORT = 9124
MIN_SERVER_PORT = 1024
MAX_SERVER_PORT = 65535


def portable_root() -> Path:
    """Return the persistent directory beside the portable launcher."""

    override = os.environ.get("WORLDMEDIA_PORTABLE_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def state_root(*, portable: Path | None = None) -> Path:
    """Return the persistent state directory beside the portable launcher."""

    override = os.environ.get("WORLDMEDIA_STATE_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    selected_portable = Path(portable).resolve() if portable is not None else portable_root()
    return (selected_portable / PORTABLE_STATE_DIR).resolve()


def legacy_state_root() -> Path | None:
    """Return the pre-portable LocalAppData state location, when available."""

    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if base:
        return (Path(base) / APP_ID).resolve()
    return None


@dataclass(frozen=True, slots=True)
class RuntimePaths:
    portable_root: Path
    state_root: Path
    downloads_root: Path
    tools_root: Path

    def as_data(self, *, portable_writable: bool, fallback_reason: str | None = None) -> dict:
        return {
            "portable_root": str(self.portable_root),
            "state_root": str(self.state_root),
            "downloads_root": str(self.downloads_root),
            "tools_root": str(self.tools_root),
            "portable_writable": portable_writable,
            "using_fallback": False,
            "fallback_reason": fallback_reason,
        }


def get_runtime_paths(*, portable: Path | None = None, state: Path | None = None) -> RuntimePaths:
    portable_path = Path(portable).resolve() if portable is not None else portable_root()
    state_path = Path(state).resolve() if state is not None else state_root(portable=portable_path)
    return RuntimePaths(
        portable_root=portable_path,
        state_root=state_path,
        downloads_root=portable_path / "downloads",
        tools_root=portable_path / "tools" / "ffmpeg",
    )


def server_port_config_path(paths: RuntimePaths | None = None) -> Path:
    """Return the small native-launcher preference file inside app state."""

    selected = paths or get_runtime_paths()
    return selected.state_root / "state" / RUNTIME_CONFIG_FILENAME


def profile_transfer_path(paths: RuntimePaths | None = None) -> Path:
    """Return the origin-independent user-preferences handoff file."""

    selected = paths or get_runtime_paths()
    return selected.state_root / "state" / PROFILE_TRANSFER_FILENAME


def profile_transfer_extra_path(paths: RuntimePaths | None = None) -> Path:
    """Return the handoff file for keys that releases up to 0.1.8 do not know."""

    # Always beside the main file, wherever that is.
    return profile_transfer_path(paths).with_name(PROFILE_TRANSFER_EXTRA_FILENAME)


def _atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def normalize_server_port(value: object) -> int:
    """Validate the local listener port accepted from the Settings UI."""

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Server port must be a whole number.")
    if not MIN_SERVER_PORT <= value <= MAX_SERVER_PORT:
        raise ValueError(f"Server port must be between {MIN_SERVER_PORT} and {MAX_SERVER_PORT}.")
    return value


def configured_server_port(paths: RuntimePaths | None = None) -> int:
    """Read the requested next-launch port, falling back safely on bad state."""

    config_path = server_port_config_path(paths)
    try:
        if not config_path.is_file() or config_path.stat().st_size > 8 * 1024:
            return DEFAULT_SERVER_PORT
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return DEFAULT_SERVER_PORT
        return normalize_server_port(raw.get("server_port"))
    except (OSError, ValueError, json.JSONDecodeError):
        return DEFAULT_SERVER_PORT


def save_server_port(port: object, paths: RuntimePaths | None = None) -> int:
    """Atomically persist the requested listener port for the next launch."""

    selected = paths or get_runtime_paths()
    normalized = normalize_server_port(port)
    _atomic_write_json(server_port_config_path(selected), {"server_port": normalized})
    return normalized


def normalize_profile_transfer_values(value: object) -> dict[str, str]:
    """Validate a bounded, explicit set of browser preferences for port moves."""

    if not isinstance(value, dict):
        raise ValueError("Profile preferences must be an object.")
    values: dict[str, str] = {}
    total = 0
    for key, entry in value.items():
        if key not in PROFILE_TRANSFER_KEYS:
            raise ValueError("Profile preferences contain an unsupported key.")
        if not isinstance(entry, str):
            raise ValueError("Profile preference values must be strings.")
        size = len(entry.encode("utf-8"))
        if size > PROFILE_TRANSFER_MAX_BYTES:
            raise ValueError("A profile preference value is too large.")
        total += size
        if total > PROFILE_TRANSFER_MAX_BYTES:
            raise ValueError("Profile preferences are too large.")
        values[key] = entry
    return values


def _read_profile_file(path: Path) -> dict[str, str]:
    """One handoff file's values; {} when it is missing or corrupt.

    A key this release does not know (written by a newer one) is skipped
    rather than making the whole file unreadable."""

    try:
        # JSON can expand each byte to a six-byte escape (ensure_ascii=True).
        if not path.is_file() or path.stat().st_size > PROFILE_TRANSFER_MAX_BYTES * 6 + 8 * 1024:
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("version") != PROFILE_TRANSFER_VERSION:
            return {}
        values = raw.get("values")
        if not isinstance(values, dict):
            return {}
        known = {key: entry for key, entry in values.items() if key in PROFILE_TRANSFER_KEYS}
        return normalize_profile_transfer_values(known)
    except (OSError, ValueError, TypeError, RecursionError):
        return {}


def load_profile_transfer(paths: RuntimePaths | None = None) -> dict[str, str]:
    """Read the latest safe handoff, treating corrupt data as unavailable."""

    path = profile_transfer_path(paths)
    with PROFILE_FILES_LOCK:
        main = _read_profile_file(path)
        extra = _read_profile_file(path.with_name(PROFILE_TRANSFER_EXTRA_FILENAME))
    merged = dict(main)
    merged.update({key: entry for key, entry in extra.items() if key not in LEGACY_PROFILE_TRANSFER_KEYS})
    try:
        return normalize_profile_transfer_values(merged)
    except ValueError:
        return main


def parse_profile_write_order(writer: object, sequence: object) -> tuple[str, int] | None:
    """The page id and number from a profile write's headers; None when the
    request has neither (an older client). Raises ValueError when they are
    malformed or only one is present."""

    if writer is None and sequence is None:
        return None
    if not isinstance(writer, str) or not _PROFILE_WRITER_ID.fullmatch(writer):
        raise ValueError("The profile write order is invalid.")
    if not isinstance(sequence, str) or not _PROFILE_SEQUENCE.fullmatch(sequence):
        raise ValueError("The profile write order is invalid.")
    number = int(sequence, 10)
    if number < 1:
        raise ValueError("The profile write order is invalid.")
    return writer, number


def reset_profile_write_order() -> None:
    """Forget every page's write order (tests)."""

    with PROFILE_FILES_LOCK:
        _profile_writers.clear()


def save_profile_transfer(
    values: object,
    paths: RuntimePaths | None = None,
    *,
    order: tuple[str, int] | None = None,
) -> dict[str, str] | None:
    """Atomically store browser data before its localhost origin changes.

    Keys every release knows go into the main file and newer keys into the
    extra file, so an older release can still read the main file (and with it
    the favorites) after a downgrade.

    Order of the two writes, for saves and clears alike: the main (legacy) file
    first, then the extra file (replaced, or removed when there is nothing to
    keep in it). If the second write fails, the favorites and settings are
    already the newest and only the categories are one step behind; their stale
    entries are pruned harmlessly by the page. The failure is still raised, so
    the page reports it and saves again.

    With ``order`` (page id, number), a write that is not newer than the last
    one taken for that page changes nothing and returns None ("superseded")."""

    selected = paths or get_runtime_paths()
    normalized = normalize_profile_transfer_values(values)
    legacy = {key: entry for key, entry in normalized.items() if key in LEGACY_PROFILE_TRANSFER_KEYS}
    newer = {key: entry for key, entry in normalized.items() if key not in LEGACY_PROFILE_TRANSFER_KEYS}
    main_path = profile_transfer_path(selected)
    extra_path = main_path.with_name(PROFILE_TRANSFER_EXTRA_FILENAME)
    with PROFILE_FILES_LOCK:
        if order is not None:
            writer, sequence = order
            last = _profile_writers.get(writer)
            if last is not None and sequence <= last:
                return None
            # Taken before writing: an older write arriving after this one
            # failed half-way is refused too; the page retries with a new number.
            _profile_writers[writer] = sequence
            _profile_writers.move_to_end(writer)
            while len(_profile_writers) > MAX_PROFILE_WRITERS:
                _profile_writers.popitem(last=False)
        _atomic_write_json(main_path, {"version": PROFILE_TRANSFER_VERSION, "values": legacy})
        if newer:
            _atomic_write_json(extra_path, {"version": PROFILE_TRANSFER_VERSION, "values": newer})
        else:
            extra_path.unlink(missing_ok=True)
    return normalized


def migrate_legacy_state(paths: RuntimePaths | None = None) -> bool:
    """Copy persistent legacy state to the portable root without deleting it.

    WebView2 keeps both browser cache and the application's localStorage in the
    same profile tree.  Copying the complete profile is therefore intentional:
    it preserves favorites and EQ assignments while relocating future writes.
    Explicit ``WORLDMEDIA_STATE_ROOT`` users are never migrated.
    """

    if os.environ.get("WORLDMEDIA_STATE_ROOT"):
        return False
    selected = paths or get_runtime_paths()
    source = legacy_state_root()
    destination = selected.state_root
    if source is None or source == destination or destination.exists():
        return False

    payloads = [name for name in ("webview2_data", "state") if (source / name).exists()]
    if not payloads:
        return False

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.with_name(
        f".{destination.name}.migrating-{os.getpid()}-{secrets.token_hex(6)}"
    )
    try:
        staging.mkdir()
        for name in payloads:
            source_path = source / name
            target_path = staging / name
            if source_path.is_dir():
                shutil.copytree(source_path, target_path)
            else:
                shutil.copy2(source_path, target_path)
        staging.replace(destination)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        if destination.exists():
            return False
        raise
    return True


def probe_writable(directory: Path) -> tuple[bool, str | None]:
    """Atomically create and remove a private probe in *directory*."""

    target = Path(directory)
    probe = target / f".worldmedia-write-{secrets.token_hex(12)}.tmp"
    descriptor: int | None = None
    try:
        target.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(descriptor, b"worldmedia")
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        probe.unlink()
        return True, None
    except OSError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass
        return False, "Portable downloads/tools directory is not writable."


def runtime_status(paths: RuntimePaths | None = None, *, active_port: int | None = None) -> dict:
    selected = paths or get_runtime_paths()
    downloads_ok, downloads_error = probe_writable(selected.downloads_root)
    tools_ok, tools_error = probe_writable(selected.tools_root)
    writable = downloads_ok and tools_ok
    data = selected.as_data(
        portable_writable=writable,
        fallback_reason=None if writable else downloads_error or tools_error,
    )
    data["server_port"] = active_port
    data["next_launch_port"] = configured_server_port(selected)
    return data


def ensure_state_directories(paths: RuntimePaths | None = None) -> RuntimePaths:
    selected = paths or get_runtime_paths()
    for name in ("cache", "state", "logs", "webview2_data"):
        (selected.state_root / name).mkdir(parents=True, exist_ok=True)
    return selected
