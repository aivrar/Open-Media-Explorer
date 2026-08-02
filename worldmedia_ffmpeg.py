"""Verified FFmpeg discovery, capability probing, and managed installation."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable

from worldmedia_media import MediaError, ResolvedTarget, SafeConnector
from worldmedia_runtime import RuntimePaths, get_runtime_paths, probe_writable
from worldmedia_security import safe_message


GITHUB_REPOSITORY = "BtbN/FFmpeg-Builds"
GITHUB_RELEASE_API = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
MANAGED_ASSET_NAME = "ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
ASSET_MIN_BYTES = 100 * 1024 * 1024
ASSET_MAX_BYTES = 300 * 1024 * 1024
DOWNLOAD_MAX_BYTES = 320 * 1024 * 1024
MAX_RELEASE_JSON_BYTES = 4 * 1024 * 1024
MAX_ZIP_FILES = 5000
MAX_ZIP_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ZIP_MEMBER_BYTES = 700 * 1024 * 1024
MAX_COMPRESSION_RATIO = 250
PROBE_TIMEOUT = 20
WINDOWS_DEVICE_NAMES = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
})

REQUIRED_CAPABILITIES = {
    "protocols": frozenset({"http", "https", "pipe"}),
    "demuxers": frozenset({"hls", "mov", "mp3", "mpegts"}),
    "decoders": frozenset({"aac", "h264", "mp3"}),
    "encoders": frozenset({"aac", "libmp3lame", "libx264"}),
    "muxers": frozenset({"mp3", "mp4"}),
    "filters": frozenset({"alimiter", "bass", "equalizer", "treble", "volume"}),
}


class FfmpegError(RuntimeError):
    code = "FFMPEG_ERROR"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, retryable: bool | None = None) -> None:
        super().__init__(safe_message(message))
        if code:
            self.code = code
        if retryable is not None:
            self.retryable = retryable


class InstallCancelled(FfmpegError):
    code = "INSTALL_CANCELLED"


@dataclass(frozen=True, slots=True)
class ToolCandidate:
    source: str
    ffmpeg_path: Path
    ffprobe_path: Path
    managed: bool


@dataclass(slots=True)
class ProbeResult:
    ready: bool
    version: str | None
    capabilities: dict[str, list[str]]
    missing: dict[str, list[str]] = field(default_factory=dict)
    reason: str | None = None


@dataclass(slots=True)
class ToolStatus:
    state: str = "missing"
    source: str | None = None
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None
    version: str | None = None
    capabilities: dict[str, list[str]] = field(default_factory=lambda: {
        "protocols": [], "demuxers": [], "decoders": [], "encoders": [], "muxers": [], "filters": [],
    })
    progress: float | None = None
    error: dict | None = None
    managed: bool = False
    actionable_reason: str | None = None

    def as_data(self) -> dict:
        return {
            "state": self.state,
            "source": self.source,
            "ffmpeg_path": self.ffmpeg_path,
            "ffprobe_path": self.ffprobe_path,
            "version": self.version,
            "capabilities": self.capabilities,
            "progress": self.progress,
            "error": self.error,
            "managed": self.managed,
            "actionable_reason": self.actionable_reason,
        }


def _windows_process_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _run_probe(command: list[str], runner: Callable = subprocess.run) -> str:
    try:
        completed = runner(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT,
            shell=False,
            creationflags=_windows_process_flags(),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FfmpegError("FFmpeg capability probe could not run.", code="PROBE_FAILED") from error
    if completed.returncode != 0:
        raise FfmpegError("FFmpeg capability probe returned an error.", code="PROBE_FAILED")
    return (completed.stdout or "") + "\n" + (completed.stderr or "")


def _parse_protocols(output: str) -> set[str]:
    found: set[str] = set()
    active = False
    for raw in output.splitlines():
        line = raw.strip()
        if line in {"Input:", "Output:"}:
            active = True
            continue
        if active and re.fullmatch(r"[a-zA-Z0-9_+.-]+", line or ""):
            found.add(line.lower())
    return found


def _parse_capability_table(output: str) -> set[str]:
    found: set[str] = set()
    for raw in output.splitlines():
        parts = raw.split()
        if len(parts) < 2:
            continue
        flags = parts[0]
        if len(flags) <= 8 and re.fullmatch(r"[A-Z.]+", flags) and flags != ".":
            for name in parts[1].split(","):
                if re.fullmatch(r"[a-zA-Z0-9_+.-]+", name):
                    found.add(name.lower())
    return found


def probe_toolchain(candidate: ToolCandidate, runner: Callable = subprocess.run) -> ProbeResult:
    if not candidate.ffmpeg_path.is_file() or not candidate.ffprobe_path.is_file():
        return ProbeResult(False, None, _empty_capabilities(), reason="Both ffmpeg.exe and ffprobe.exe are required.")
    try:
        version_output = _run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-version"], runner)
        probe_version = _run_probe([str(candidate.ffprobe_path), "-hide_banner", "-version"], runner)
        if "ffmpeg version" not in version_output.lower() or "ffprobe version" not in probe_version.lower():
            raise FfmpegError("Tool version output is invalid.", code="PROBE_FAILED")
        protocols = _parse_protocols(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-protocols"], runner))
        values = {
            "protocols": protocols,
            "demuxers": _parse_capability_table(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-demuxers"], runner)),
            "decoders": _parse_capability_table(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-decoders"], runner)),
            "encoders": _parse_capability_table(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-encoders"], runner)),
            "muxers": _parse_capability_table(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-muxers"], runner)),
            "filters": _parse_capability_table(_run_probe([str(candidate.ffmpeg_path), "-hide_banner", "-filters"], runner)),
        }
        capabilities = {name: sorted(items) for name, items in values.items()}
        missing = {
            name: sorted(required - values[name])
            for name, required in REQUIRED_CAPABILITIES.items()
            if required - values[name]
        }
        version_line = next(
            (line.strip() for line in version_output.splitlines() if line.lower().startswith("ffmpeg version")),
            None,
        )
        if missing:
            detail = "; ".join(f"{name}: {', '.join(items)}" for name, items in missing.items())
            return ProbeResult(False, version_line, capabilities, missing, f"Missing required capabilities ({detail}).")
        return ProbeResult(True, version_line, capabilities)
    except FfmpegError as error:
        return ProbeResult(False, None, _empty_capabilities(), reason=str(error))


def _empty_capabilities() -> dict[str, list[str]]:
    return {
        "protocols": [], "demuxers": [], "decoders": [], "encoders": [], "muxers": [], "filters": [],
    }


def _managed_candidate(root: Path, source: str) -> ToolCandidate | None:
    manifest = root / "current.json"
    bin_root: Path | None = None
    if manifest.is_file():
        try:
            value = json.loads(manifest.read_text(encoding="utf-8"))
            relative = value.get("relative_path")
            if isinstance(relative, str):
                selected = (root / relative).resolve()
                selected.relative_to(root.resolve())
                bin_root = selected / "bin"
        except (OSError, ValueError, json.JSONDecodeError):
            bin_root = None
    if bin_root is None and (root / "bin").is_dir():
        bin_root = root / "bin"
    if bin_root is None:
        return None
    return ToolCandidate(source, bin_root / "ffmpeg.exe", bin_root / "ffprobe.exe", True)


def discovery_candidates(paths: RuntimePaths | None = None) -> list[ToolCandidate]:
    selected = paths or get_runtime_paths()
    candidates: list[ToolCandidate] = []
    override = os.environ.get("WORLDMEDIA_FFMPEG_PATH")
    if override:
        given = Path(override).expanduser()
        directory = given.parent if given.name.lower() == "ffmpeg.exe" else given
        candidates.append(ToolCandidate("override", directory / "ffmpeg.exe", directory / "ffprobe.exe", False))
    portable = _managed_candidate(selected.tools_root, "portable")
    if portable:
        candidates.append(portable)
    system_ffmpeg = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
    system_ffprobe = shutil.which("ffprobe.exe") or shutil.which("ffprobe")
    if system_ffmpeg or system_ffprobe:
        candidates.append(ToolCandidate(
            "PATH",
            Path(system_ffmpeg or "ffmpeg.exe"),
            Path(system_ffprobe or "ffprobe.exe"),
            False,
        ))
    local_root = selected.state_root / "tools" / "ffmpeg"
    local = _managed_candidate(local_root, "LocalAppData")
    if local:
        candidates.append(local)
    unique: list[ToolCandidate] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        key = (str(candidate.ffmpeg_path.resolve()), str(candidate.ffprobe_path.resolve()))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def discover_toolchain(
    paths: RuntimePaths | None = None,
    *,
    runner: Callable = subprocess.run,
) -> tuple[ToolStatus, ToolCandidate | None]:
    failures: list[str] = []
    for candidate in discovery_candidates(paths):
        probe = probe_toolchain(candidate, runner)
        if probe.ready:
            return ToolStatus(
                state="ready",
                source=candidate.source,
                ffmpeg_path=str(candidate.ffmpeg_path.resolve()),
                ffprobe_path=str(candidate.ffprobe_path.resolve()),
                version=probe.version,
                capabilities=probe.capabilities,
                managed=candidate.managed,
            ), candidate
        failures.append(f"{candidate.source}: {probe.reason or 'not capable'}")
    reason = "No capable FFmpeg toolchain was found."
    if failures:
        reason += " " + " ".join(failures)
    reason += " Install the verified managed GPL build or repair the managed copy."
    return ToolStatus(state="missing", actionable_reason=safe_message(reason)), None


@dataclass(frozen=True, slots=True)
class ReleaseAsset:
    release_id: int
    release_name: str
    published_at: str
    asset_id: int
    name: str
    size: int
    digest: str
    download_url: str


def parse_release_asset(
    value: object,
    *,
    minimum_size: int = ASSET_MIN_BYTES,
    maximum_size: int = ASSET_MAX_BYTES,
) -> ReleaseAsset:
    if not isinstance(value, dict):
        raise FfmpegError("GitHub release response is invalid.", code="INVALID_RELEASE")
    api_url = value.get("url")
    if not isinstance(api_url, str) or not re.fullmatch(
        rf"https://api\.github\.com/repos/{re.escape(GITHUB_REPOSITORY)}/releases/\d+", api_url
    ):
        raise FfmpegError("GitHub release repository identity is invalid.", code="INVALID_RELEASE")
    if value.get("tag_name") != "latest" or value.get("draft") is True or value.get("prerelease") is True:
        raise FfmpegError("GitHub release state is not approved.", code="INVALID_RELEASE")
    matches = [asset for asset in value.get("assets", []) if isinstance(asset, dict) and asset.get("name") == MANAGED_ASSET_NAME]
    if len(matches) != 1:
        raise FfmpegError("The exact approved FFmpeg asset was not found once.", code="INVALID_ASSET")
    asset = matches[0]
    size = asset.get("size")
    digest = asset.get("digest")
    download_url = asset.get("browser_download_url")
    if asset.get("state") != "uploaded" or not isinstance(size, int) or not minimum_size <= size <= maximum_size:
        raise FfmpegError("FFmpeg asset state or size is invalid.", code="INVALID_ASSET")
    if asset.get("content_type") not in {"application/zip", "application/octet-stream"}:
        raise FfmpegError("FFmpeg asset content type is invalid.", code="INVALID_ASSET")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise FfmpegError("FFmpeg asset has no valid GitHub SHA-256 digest.", code="INVALID_ASSET")
    if not isinstance(download_url, str) or not re.fullmatch(
        rf"https://github\.com/{re.escape(GITHUB_REPOSITORY)}/releases/download/[^/]+/{re.escape(MANAGED_ASSET_NAME)}",
        download_url,
    ):
        raise FfmpegError("FFmpeg asset download URL is invalid.", code="INVALID_ASSET")
    if not isinstance(value.get("id"), int) or not isinstance(asset.get("id"), int):
        raise FfmpegError("GitHub release identifiers are invalid.", code="INVALID_RELEASE")
    return ReleaseAsset(
        release_id=value["id"],
        release_name=str(value.get("name") or "Latest Auto-Build")[:256],
        published_at=str(value.get("published_at") or "")[:64],
        asset_id=asset["id"],
        name=MANAGED_ASSET_NAME,
        size=size,
        digest=digest,
        download_url=download_url,
    )


def _github_target_allowed(target: ResolvedTarget) -> bool:
    return target.host in {
        "api.github.com",
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    }


def github_connector() -> SafeConnector:
    return SafeConnector(target_policy=_github_target_allowed, idle_timeout=30)


def query_release_asset(
    connector: SafeConnector | None = None,
    *,
    minimum_size: int = ASSET_MIN_BYTES,
    maximum_size: int = ASSET_MAX_BYTES,
    cancel: threading.Event | None = None,
    retries: int = 3,
) -> ReleaseAsset:
    selected = connector or github_connector()
    cancellation = cancel or threading.Event()
    last_error: FfmpegError | None = None
    chunks: list[bytes] = []
    for attempt in range(max(1, retries)):
        if cancellation.is_set():
            raise InstallCancelled("FFmpeg installation was cancelled.")
        chunks = []
        try:
            upstream = selected.open(
                GITHUB_RELEASE_API,
                headers={"User-Agent": "WorldMediaWindows/0.1.2"},
                cancel=cancellation,
            )
            try:
                if upstream.response.status != 200:
                    raise FfmpegError("GitHub release query failed.", code="RELEASE_HTTP_ERROR", retryable=True)
                total = 0
                for chunk in upstream.iter_chunks(cancel=cancellation):
                    total += len(chunk)
                    if total > MAX_RELEASE_JSON_BYTES:
                        raise FfmpegError("GitHub release response is too large.", code="INVALID_RELEASE")
                    chunks.append(chunk)
            finally:
                upstream.close()
            break
        except InstallCancelled:
            raise
        except MediaError as error:
            last_error = FfmpegError(
                "GitHub release query failed.", code="RELEASE_HTTP_ERROR", retryable=True
            )
            last_error.__cause__ = error
        except FfmpegError as error:
            last_error = error
            if not error.retryable:
                raise
        if attempt + 1 < max(1, retries) and cancellation.wait(min(2 ** attempt, 4)):
            raise InstallCancelled("FFmpeg installation was cancelled.")
    else:
        raise last_error or FfmpegError(
            "GitHub release query failed.", code="RELEASE_HTTP_ERROR", retryable=True
        )
    try:
        value = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise FfmpegError("GitHub release response is malformed.", code="INVALID_RELEASE") from None
    return parse_release_asset(value, minimum_size=minimum_size, maximum_size=maximum_size)


def inspect_zip(
    archive: Path,
    *,
    max_files: int = MAX_ZIP_FILES,
    max_expanded_bytes: int = MAX_ZIP_EXPANDED_BYTES,
    max_member_bytes: int = MAX_ZIP_MEMBER_BYTES,
    cancel: threading.Event | None = None,
) -> tuple[list[zipfile.ZipInfo], str]:
    cancellation = cancel or threading.Event()
    try:
        package = zipfile.ZipFile(archive)
    except (OSError, zipfile.BadZipFile):
        raise FfmpegError("Downloaded FFmpeg archive is not a valid ZIP.", code="INVALID_ZIP") from None
    with package:
        members = package.infolist()
        files = [member for member in members if not member.is_dir()]
        if not files or len(members) > max_files:
            raise FfmpegError("FFmpeg archive file count is unsafe.", code="UNSAFE_ZIP")
        expanded = 0
        first_parts: set[str] = set()
        names: set[str] = set()
        for member in members:
            if cancellation.is_set():
                raise InstallCancelled("FFmpeg installation was cancelled.")
            name = member.filename
            if not name or "\\" in name or "\0" in name:
                raise FfmpegError("FFmpeg archive contains an unsafe path.", code="UNSAFE_ZIP")
            path = PurePosixPath(name)
            if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
                raise FfmpegError("FFmpeg archive contains traversal paths.", code="UNSAFE_ZIP")
            for part in path.parts:
                stem = part.split(".", 1)[0].upper()
                if (
                    len(part) > 255
                    or ":" in part
                    or part.startswith("~")
                    or part.endswith((" ", "."))
                    or any(ord(character) < 32 for character in part)
                    or stem in WINDOWS_DEVICE_NAMES
                ):
                    raise FfmpegError("FFmpeg archive contains a Windows-unsafe path.", code="UNSAFE_ZIP")
            if len(name) > 1024 or member.flag_bits & 0x1:
                raise FfmpegError("FFmpeg archive contains an unsafe member.", code="UNSAFE_ZIP")
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise FfmpegError("FFmpeg archive contains a symbolic link.", code="UNSAFE_ZIP")
            if member.file_size < 0 or member.file_size > max_member_bytes:
                raise FfmpegError("FFmpeg archive member is too large.", code="UNSAFE_ZIP")
            expanded += member.file_size
            if expanded > max_expanded_bytes:
                raise FfmpegError("FFmpeg archive expands beyond the safety limit.", code="UNSAFE_ZIP")
            if member.file_size and (
                member.compress_size <= 0 or member.file_size / member.compress_size > MAX_COMPRESSION_RATIO
            ):
                raise FfmpegError("FFmpeg archive compression ratio is unsafe.", code="UNSAFE_ZIP")
            if path.parts:
                first_parts.add(path.parts[0])
            normalized_name = "/".join(part.casefold() for part in path.parts)
            if normalized_name in names:
                raise FfmpegError("FFmpeg archive contains duplicate paths.", code="UNSAFE_ZIP")
            names.add(normalized_name)
        try:
            for member in files:
                with package.open(member) as source:
                    while source.read(1024 * 1024):
                        if cancellation.is_set():
                            raise InstallCancelled("FFmpeg installation was cancelled.")
        except zipfile.BadZipFile:
            raise FfmpegError("FFmpeg archive failed its CRC test.", code="ZIP_CRC_FAILED") from None
        if len(first_parts) != 1:
            raise FfmpegError("FFmpeg archive must have one package root.", code="UNSAFE_ZIP")
        package_root = next(iter(first_parts))
        required_suffixes = {"/bin/ffmpeg.exe", "/bin/ffprobe.exe"}
        if not all(any(name.endswith(suffix) for name in names) for suffix in required_suffixes):
            raise FfmpegError("FFmpeg archive is missing required executables.", code="MISSING_TOOL")
        if not any("license" in PurePosixPath(name).name or "copying" in PurePosixPath(name).name for name in names):
            raise FfmpegError("FFmpeg archive is missing license material.", code="MISSING_LICENSE")
        return members, package_root


def extract_zip_safely(
    archive: Path,
    destination: Path,
    members: Iterable[zipfile.ZipInfo],
    package_root: str,
    *,
    cancel: threading.Event | None = None,
) -> None:
    cancellation = cancel or threading.Event()
    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as package:
        for member in members:
            if cancellation.is_set():
                raise InstallCancelled("FFmpeg installation was cancelled.")
            path = PurePosixPath(member.filename)
            relative_parts = path.parts[1:] if path.parts and path.parts[0] == package_root else path.parts
            if not relative_parts:
                continue
            target = (root.joinpath(*relative_parts)).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                raise FfmpegError("FFmpeg extraction escaped staging.", code="UNSAFE_ZIP") from None
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.open(member) as source, target.open("xb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    if cancellation.is_set():
                        raise InstallCancelled("FFmpeg installation was cancelled.")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    data = json.dumps(value, indent=2, sort_keys=True).encode("utf-8")
    with temporary.open("xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def managed_root(paths: RuntimePaths, destination: str) -> tuple[Path, str]:
    if destination == "portable":
        root, source, boundary = paths.tools_root, "portable", paths.portable_root
    elif destination == "LocalAppData":
        root, source, boundary = paths.state_root / "tools" / "ffmpeg", "LocalAppData", paths.state_root
    else:
        raise FfmpegError("Managed FFmpeg destination is invalid.", code="INVALID_DESTINATION")
    current = root
    boundary = boundary.absolute()
    while True:
        if current.exists() and (
            current.is_symlink()
            or (hasattr(os.path, "isjunction") and os.path.isjunction(current))
        ):
            raise FfmpegError("Managed FFmpeg paths cannot use links or junctions.", code="UNSAFE_PATH")
        if current.absolute() == boundary:
            break
        if current.parent == current:
            raise FfmpegError("Managed FFmpeg root is outside its runtime boundary.", code="UNSAFE_PATH")
        current = current.parent
    return root, source


def _remove_tree_with_retry(target: Path) -> None:
    def make_writable(function, path, _error) -> None:
        try:
            os.chmod(path, stat.S_IWRITE)
            function(path)
        except OSError:
            raise

    last_error: OSError | None = None
    for attempt in range(8):
        try:
            shutil.rmtree(target, onexc=make_writable)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            last_error = error
            if attempt < 7:
                time.sleep(min(0.2 * (2 ** attempt), 2.0))
    raise FfmpegError(
        "Managed FFmpeg staging cleanup is temporarily blocked by Windows.",
        code="STAGING_CLEANUP_FAILED",
        retryable=True,
    ) from last_error


def _safe_remove_tree(target: Path, approved_root: Path) -> None:
    resolved_target = target.resolve()
    resolved_root = approved_root.resolve()
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError:
        raise FfmpegError("Refusing to remove a path outside the managed root.", code="UNSAFE_PATH") from None
    if resolved_target == resolved_root:
        raise FfmpegError("Refusing to remove the managed root through a staging cleanup.", code="UNSAFE_PATH")
    if resolved_target.exists():
        _remove_tree_with_retry(resolved_target)


def _replace_directory_with_retry(
    source: Path,
    destination: Path,
    *,
    cancel: threading.Event | None = None,
    timeout: float = 45.0,
) -> None:
    """Commit a staged directory despite short-lived Windows scanner locks."""
    cancellation = cancel or threading.Event()
    last_error: OSError | None = None
    deadline = time.monotonic() + max(0.0, float(timeout))
    delay = 0.25
    while True:
        if cancellation.is_set():
            raise InstallCancelled("FFmpeg installation was cancelled.")
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            last_error = error
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if cancellation.wait(min(delay, 2.0, remaining)):
                raise InstallCancelled("FFmpeg installation was cancelled.")
            delay = min(delay * 2, 2.0)
    raise FfmpegError(
        "Windows temporarily blocked activation of the verified FFmpeg staging directory.",
        code="INSTALL_COMMIT_FAILED",
        retryable=True,
    ) from last_error


def download_asset(
    asset: ReleaseAsset,
    destination: Path,
    *,
    connector: SafeConnector | None = None,
    cancel: threading.Event | None = None,
    progress: Callable[[float], None] | None = None,
    maximum_bytes: int = DOWNLOAD_MAX_BYTES,
    retries: int = 3,
) -> str:
    selected = connector or github_connector()
    cancellation = cancel or threading.Event()
    expected_digest = asset.digest.removeprefix("sha256:")
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        if cancellation.is_set():
            raise InstallCancelled("FFmpeg installation was cancelled.")
        destination.unlink(missing_ok=True)
        digest = hashlib.sha256()
        total = 0
        try:
            upstream = selected.open(
                asset.download_url,
                headers={"User-Agent": "WorldMediaWindows/0.1.2"},
                cancel=cancellation,
            )
            try:
                if upstream.response.status != 200:
                    raise FfmpegError("FFmpeg asset download failed.", code="ASSET_HTTP_ERROR", retryable=True)
                declared = upstream.response.getheader("Content-Length")
                if declared and (not declared.isdigit() or int(declared) != asset.size):
                    raise FfmpegError("FFmpeg asset length does not match GitHub metadata.", code="ASSET_LENGTH_MISMATCH")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as output:
                    for chunk in upstream.iter_chunks(cancel=cancellation):
                        total += len(chunk)
                        if total > maximum_bytes or total > asset.size:
                            raise FfmpegError("FFmpeg asset exceeded its verified size.", code="ASSET_TOO_LARGE")
                        output.write(chunk)
                        digest.update(chunk)
                        if progress:
                            progress(min(1.0, total / asset.size))
                    output.flush()
                    os.fsync(output.fileno())
            finally:
                upstream.close()
            if cancellation.is_set():
                raise InstallCancelled("FFmpeg installation was cancelled.")
            if total != asset.size:
                raise FfmpegError("FFmpeg asset was truncated.", code="ASSET_LENGTH_MISMATCH", retryable=True)
            actual = digest.hexdigest()
            if actual != expected_digest:
                raise FfmpegError("FFmpeg asset SHA-256 verification failed.", code="BAD_ASSET_DIGEST")
            return actual
        except InstallCancelled:
            destination.unlink(missing_ok=True)
            raise
        except MediaError as error:
            last_error = FfmpegError("FFmpeg asset download failed.", code="ASSET_HTTP_ERROR", retryable=True)
            destination.unlink(missing_ok=True)
        except FfmpegError as error:
            last_error = error
            destination.unlink(missing_ok=True)
            if not error.retryable:
                raise
        if attempt + 1 < max(1, retries):
            if cancellation.wait(min(2 ** attempt, 4)):
                raise InstallCancelled("FFmpeg installation was cancelled.")
    if isinstance(last_error, FfmpegError):
        raise last_error
    raise FfmpegError("FFmpeg asset download failed.", code="ASSET_HTTP_ERROR", retryable=True)


def install_managed(
    paths: RuntimePaths,
    destination: str,
    *,
    connector: SafeConnector | None = None,
    runner: Callable = subprocess.run,
    cancel: threading.Event | None = None,
    progress: Callable[[float], None] | None = None,
    minimum_asset_size: int = ASSET_MIN_BYTES,
    maximum_asset_size: int = ASSET_MAX_BYTES,
) -> tuple[ToolStatus, ToolCandidate, dict]:
    root, source = managed_root(paths, destination)
    writable, _reason = probe_writable(root)
    if not writable:
        raise FfmpegError(
            "Selected managed FFmpeg destination is not writable. Choose the explicit LocalAppData fallback.",
            code="DESTINATION_NOT_WRITABLE",
        )
    cancellation = cancel or threading.Event()
    selected_connector = connector or github_connector()
    if progress:
        progress(0.01)
    asset = query_release_asset(
        selected_connector,
        minimum_size=minimum_asset_size,
        maximum_size=maximum_asset_size,
        cancel=cancellation,
    )
    if cancellation.is_set():
        raise InstallCancelled("FFmpeg installation was cancelled.")
    token = secrets.token_hex(10)
    workspace = root / f".download-{token}"
    staging = root / f".staging-{token}"
    archive = workspace / f"{asset.name}.part"
    final: Path | None = None
    pointer_switched = False
    try:
        workspace.mkdir(parents=True, exist_ok=False)
        actual_digest = download_asset(
            asset,
            archive,
            connector=selected_connector,
            cancel=cancellation,
            progress=(lambda value: progress(0.02 + value * 0.68)) if progress else None,
        )
        if progress:
            progress(0.72)
        members, package_root = inspect_zip(archive, cancel=cancellation)
        if cancellation.is_set():
            raise InstallCancelled("FFmpeg installation was cancelled.")
        extract_zip_safely(archive, staging, members, package_root, cancel=cancellation)
        if progress:
            progress(0.84)
        candidate = ToolCandidate(source, staging / "bin" / "ffmpeg.exe", staging / "bin" / "ffprobe.exe", True)
        probe = probe_toolchain(candidate, runner)
        if not probe.ready:
            raise FfmpegError(probe.reason or "Staged FFmpeg failed its capability probe.", code="MISSING_CAPABILITY")
        if cancellation.is_set():
            raise InstallCancelled("FFmpeg installation was cancelled.")
        source_text = (
            f"FFmpeg managed by Open Media Explorer\n"
            f"Provider: https://github.com/{GITHUB_REPOSITORY}\n"
            f"Release API: {GITHUB_RELEASE_API}\n"
            f"Asset: {asset.download_url}\n"
            f"License information: https://ffmpeg.org/legal.html\n"
        )
        (staging / "SOURCE.txt").write_text(source_text, encoding="utf-8")
        manifest = {
            "schema_version": 1,
            "repository": GITHUB_REPOSITORY,
            "release_id": asset.release_id,
            "release_name": asset.release_name,
            "published_at": asset.published_at,
            "asset_id": asset.asset_id,
            "asset_name": asset.name,
            "asset_size": asset.size,
            "asset_digest": asset.digest,
            "verified_digest": f"sha256:{actual_digest}",
            "download_url": asset.download_url,
            "version": probe.version,
            "capabilities": probe.capabilities,
            "installed_at": time.time(),
            "license_url": "https://ffmpeg.org/legal.html",
            "source_url": f"https://github.com/{GITHUB_REPOSITORY}",
        }
        _atomic_json(staging / "manifest.json", manifest)
        version_name = f"release-{asset.release_id}-asset-{asset.asset_id}-{int(time.time())}-{token[:8]}"
        # Keep the atomic rename at the same directory depth. Some Windows
        # security products deny moving a newly executed directory into a
        # freshly created child directory even though a sibling rename is safe.
        final = root / version_name
        _replace_directory_with_retry(staging, final, cancel=cancellation)
        pointer = {
            "schema_version": 1,
            "relative_path": version_name,
            "release_id": asset.release_id,
            "asset_id": asset.asset_id,
            "updated_at": time.time(),
        }
        _atomic_json(root / "current.json", pointer)
        pointer_switched = True
        installed = ToolCandidate(source, final / "bin" / "ffmpeg.exe", final / "bin" / "ffprobe.exe", True)
        if progress:
            progress(1.0)
        status = ToolStatus(
            state="ready",
            source=source,
            ffmpeg_path=str(installed.ffmpeg_path.resolve()),
            ffprobe_path=str(installed.ffprobe_path.resolve()),
            version=probe.version,
            capabilities=probe.capabilities,
            progress=1.0,
            managed=True,
        )
        return status, installed, manifest
    finally:
        if workspace.exists():
            _safe_remove_tree(workspace, root)
        if staging.exists():
            _safe_remove_tree(staging, root)
        if final is not None and final.exists() and not pointer_switched:
            _safe_remove_tree(final, root)


def remove_managed(paths: RuntimePaths, destination: str) -> None:
    root, _source = managed_root(paths, destination)
    approved = {paths.tools_root.resolve(), (paths.state_root / "tools" / "ffmpeg").resolve()}
    resolved = root.resolve()
    if resolved not in approved:
        raise FfmpegError("Managed FFmpeg root is not approved.", code="UNSAFE_PATH")
    if root.exists():
        _remove_tree_with_retry(resolved)


class FfmpegService:
    def __init__(
        self,
        paths: RuntimePaths | None = None,
        *,
        connector: SafeConnector | None = None,
        runner: Callable = subprocess.run,
    ) -> None:
        self.paths = paths or get_runtime_paths()
        self.connector = connector or github_connector()
        self.runner = runner
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._status = ToolStatus(state="checking")
        self._checked_at = 0.0

    def status(self, *, refresh: bool = False) -> ToolStatus:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self._status
            if refresh or time.monotonic() - self._checked_at > 30:
                self._status, _candidate = discover_toolchain(self.paths, runner=self.runner)
                self._checked_at = time.monotonic()
            return self._status

    def start_install(self, destination: str = "portable") -> ToolStatus:
        managed_root(self.paths, destination)
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise FfmpegError("FFmpeg installation is already active.", code="INSTALL_ACTIVE")
            self._cancel = threading.Event()
            self._status = ToolStatus(
                state="installing",
                source=destination,
                progress=0.0,
                managed=True,
                actionable_reason="Downloading and verifying the managed FFmpeg GPL build.",
            )
            self._thread = threading.Thread(
                target=self._install_worker,
                args=(destination,),
                name="worldmedia-ffmpeg-install",
                daemon=True,
            )
            self._thread.start()
            return self._status

    def _install_worker(self, destination: str) -> None:
        def update(value: float) -> None:
            with self._lock:
                self._status.progress = max(0.0, min(1.0, value))

        try:
            status, _candidate, _manifest = install_managed(
                self.paths,
                destination,
                connector=self.connector,
                runner=self.runner,
                cancel=self._cancel,
                progress=update,
            )
            with self._lock:
                self._status = status
                self._checked_at = time.monotonic()
        except InstallCancelled as error:
            with self._lock:
                self._status = ToolStatus(
                    state="cancelled",
                    source=destination,
                    error={"code": error.code, "message": str(error), "retryable": True},
                    managed=True,
                    actionable_reason="Installation was cancelled; no working toolchain was replaced.",
                )
                self._checked_at = time.monotonic()
        except FfmpegError as error:
            with self._lock:
                self._status = ToolStatus(
                    state="error",
                    source=destination,
                    error={"code": error.code, "message": str(error), "retryable": error.retryable},
                    managed=True,
                    actionable_reason="Repair the managed copy or select another writable destination.",
                )
                self._checked_at = time.monotonic()
        except Exception:
            with self._lock:
                self._status = ToolStatus(
                    state="error",
                    source=destination,
                    error={
                        "code": "INSTALL_FAILED",
                        "message": "The managed FFmpeg installation failed safely before activation.",
                        "retryable": True,
                    },
                    managed=True,
                    actionable_reason="Retry the managed installation or select another writable destination.",
                )
                self._checked_at = time.monotonic()

    def cancel_install(self) -> ToolStatus:
        with self._lock:
            if not self._thread or not self._thread.is_alive():
                raise FfmpegError("No FFmpeg installation is active.", code="NO_ACTIVE_INSTALL")
            self._cancel.set()
            return self._status

    def remove(self, destination: str) -> ToolStatus:
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise FfmpegError("Cannot remove FFmpeg during installation.", code="INSTALL_ACTIVE")
            remove_managed(self.paths, destination)
            self._status, _candidate = discover_toolchain(self.paths, runner=self.runner)
            self._checked_at = time.monotonic()
            return self._status

    def wait(self, timeout: float | None = None) -> ToolStatus:
        thread = self._thread
        if thread:
            thread.join(timeout)
        return self.status()

    def shutdown(self, timeout: float = 10.0) -> bool:
        """Cancel an active managed install and give its worker time to clean staging."""
        with self._lock:
            thread = self._thread
            if thread and thread.is_alive():
                self._cancel.set()
        if thread and thread.is_alive():
            thread.join(timeout)
        return not (thread and thread.is_alive())
