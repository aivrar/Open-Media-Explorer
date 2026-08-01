"""Runtime root selection and atomic writability probes."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import sys
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
})
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


def load_profile_transfer(paths: RuntimePaths | None = None) -> dict[str, str]:
    """Read the latest safe handoff, treating corrupt data as unavailable."""

    path = profile_transfer_path(paths)
    try:
        if not path.is_file() or path.stat().st_size > PROFILE_TRANSFER_MAX_BYTES + 8 * 1024:
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("version") != PROFILE_TRANSFER_VERSION:
            return {}
        return normalize_profile_transfer_values(raw.get("values"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def save_profile_transfer(values: object, paths: RuntimePaths | None = None) -> dict[str, str]:
    """Atomically store browser data before its localhost origin changes."""

    selected = paths or get_runtime_paths()
    normalized = normalize_profile_transfer_values(values)
    _atomic_write_json(
        profile_transfer_path(selected),
        {"version": PROFILE_TRANSFER_VERSION, "values": normalized},
    )
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
