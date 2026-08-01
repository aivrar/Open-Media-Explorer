#!/usr/bin/env python3
"""World Media Windows local HTTP server.

The Windows-native build keeps the browser UI and the CORS-bypass proxy from
the Linux version, but drops the bundled WSL distro, setup scripts, bridge, and
rootfs. This server is imported by worldmedia_native.py for the desktop build
and can also run directly for development.
"""
from __future__ import annotations

import http.server
import json
import os
import re
import socket
import socketserver
import sys
import threading
import time
import urllib.parse
from collections import deque
from http import HTTPStatus
from pathlib import Path

from worldmedia_catalog import AssetRegistry, CatalogService, FIXED_METADATA_HOSTS
from worldmedia_downloads import DownloadError, DownloadService
from worldmedia_ffmpeg import FfmpegError, FfmpegService
from worldmedia_jobs import (
    DuplicateJobError,
    JobError,
    JobLimitError,
    JobNotFoundError,
    JobRegistry,
    JobStateError,
)
from worldmedia_media import (
    MEDIA_RELAY_SUFFIX_PATTERN,
    MAX_MANIFEST_BYTES,
    RELAY_CHUNK_SIZE,
    MediaError,
    MediaRegistry,
    SafeConnector,
    rewrite_dash_manifest,
    rewrite_hls_manifest,
)
from worldmedia_recording import RecordingError, RecordingService, normalize_recording_eq
from worldmedia_runtime import (
    DEFAULT_SERVER_PORT,
    get_runtime_paths,
    load_profile_transfer,
    runtime_status,
    save_profile_transfer,
    save_server_port,
)
from worldmedia_security import (
    ApiError,
    error_envelope,
    new_request_id,
    new_session_token,
    redact_text,
    success_envelope,
    validate_authenticated_get,
    validate_control_origin,
    validate_mutation,
)


APP_NAME = "World Media"
BASE_DIR = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("WORLDMEDIA_FRONTEND", BASE_DIR / "frontend")).resolve()
PORT = int(os.environ.get("WORLDMEDIA_PORT") or os.environ.get("WORLDMEDIA_WINDOWS_PORT") or DEFAULT_SERVER_PORT)
USER_AGENT = "WorldMediaWindows/0.1.2 (https://github.com/aivrar/worldmediawindows)"
MAX_SIZE = 50 * 1024 * 1024
TIMEOUT_SEC = 20

ALLOWED_HOSTS = frozenset(
    {
        "all.api.radio-browser.info",
        "iptv-org.github.io",
        "archive.org",
        "www.archive.org",
        "images-api.nasa.gov",
        "images-assets.nasa.gov",
        "commons.wikimedia.org",
        "upload.wikimedia.org",
        "librivox.org",
        "www.librivox.org",
    }
    | (FIXED_METADATA_HOSTS - {"directory.owncast.online", "owncast.directory"})
)

ALLOWED_SUFFIXES: tuple[str, ...] = (
    ".api.radio-browser.info",
    ".archive.org",
)

_rate_lock = threading.Lock()
_rate_log: dict[str, deque[float]] = {}
RATE_WINDOW_SEC = 1.0
RATE_MAX_PER_WINDOW = 240

SESSION_TOKEN = new_session_token()
JOB_REGISTRY = JobRegistry()
MEDIA_REGISTRY = MediaRegistry()
RUNTIME_PATHS = get_runtime_paths()
CATALOG_SERVICE = CatalogService(RUNTIME_PATHS.state_root / "cache")
ASSET_REGISTRY = AssetRegistry(RUNTIME_PATHS.state_root / "cache")
FFMPEG_SERVICE = FfmpegService(RUNTIME_PATHS)
DOWNLOAD_SERVICE = DownloadService(MEDIA_REGISTRY, JOB_REGISTRY, RUNTIME_PATHS)
RECORDING_SERVICE = RecordingService(MEDIA_REGISTRY, JOB_REGISTRY, FFMPEG_SERVICE, RUNTIME_PATHS)
RELAY_SLOTS = threading.BoundedSemaphore(16)
ASSET_SLOTS = threading.BoundedSemaphore(16)

CATALOG_BODY_LIMITS = {
    "/api/v1/catalog/feed/resolve": 12 * 1024,
    "/api/v1/catalog/peertube/resolve": 16 * 1024,
    "/api/v1/catalog/cache/clear": 1024,
    "/api/v1/assets/register": 24 * 1024,
    "/api/v1/runtime/server-port": 1024,
    "/api/v1/profile/preferences": 2 * 1024 * 1024,
}


def is_allowed_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host in ALLOWED_HOSTS:
        return True
    return any(host.endswith(suffix) for suffix in ALLOWED_SUFFIXES)


PROXY_CONNECTOR = SafeConnector(
    target_policy=lambda target: target.scheme == "https" and is_allowed_host(target.host),
)


def rate_limit(client_ip: str) -> bool:
    now = time.monotonic()
    with _rate_lock:
        q = _rate_log.setdefault(client_ip, deque())
        while q and q[0] < now - RATE_WINDOW_SEC:
            q.popleft()
        if len(q) >= RATE_MAX_PER_WINDOW:
            return False
        q.append(now)
    return True


def schedule_process_exit(delay: float = 0.25) -> None:
    def exit_later() -> None:
        time.sleep(delay)
        os._exit(0)

    threading.Thread(target=exit_later, daemon=True).start()


def shutdown_services(timeout: float = 12.0) -> bool:
    """Stop all media work within one shared deadline before accepting exit."""

    deadline = time.monotonic() + max(0.0, timeout)

    def remaining() -> float:
        return max(0.0, deadline - time.monotonic())

    # Cancel metadata/artwork reads first; their registries contain only
    # ephemeral opaque IDs and never browser-profile favorites or EQ state.
    catalogs_stopped = CATALOG_SERVICE.shutdown(timeout=remaining())
    assets_stopped = ASSET_REGISTRY.shutdown(timeout=remaining())
    recordings_stopped = RECORDING_SERVICE.shutdown(timeout=remaining())
    # Job cancellation signals active downloads without blocking on their
    # worker joins; DownloadService owns the bounded reaping below.
    jobs_stopped = JOB_REGISTRY.shutdown(timeout=remaining())
    downloads_stopped = DOWNLOAD_SERVICE.shutdown(timeout=remaining())
    ffmpeg_stopped = FFMPEG_SERVICE.shutdown(timeout=remaining())
    MEDIA_REGISTRY.clear()
    return (
        catalogs_stopped
        and assets_stopped
        and recordings_stopped
        and jobs_stopped
        and downloads_stopped
        and ffmpeg_stopped
    )


class WorldMediaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def handle_one_request(self) -> None:
        self.request_id = new_request_id()
        super().handle_one_request()

    def log_request(self, code="-", size="-") -> None:
        try:
            path = urllib.parse.urlsplit(getattr(self, "path", "")).path
        except ValueError:
            path = "<invalid-request-target>"
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        high_volume = (
            path in {"/api/health", "/api/ping", "/api/proxy"}
            or path.startswith("/api/v1/assets/")
            or path.startswith("/api/v1/catalog/")
            or path.startswith("/api/v1/media/")
            or path.startswith("/api/v1/dash/")
        )
        if high_volume and 200 <= status < 400:
            return
        path = redact_text(path, limit=256)
        request_id = getattr(self, "request_id", "-")
        method = (getattr(self, "command", None) or "-")[:16]
        sys.stderr.write(
            f"[{time.strftime('%H:%M:%S')}] request={request_id} client={self.client_address[0]} "
            f"method={method} path={path} status={code} size={size}\n"
        )

    def log_message(self, fmt: str, *args) -> None:
        request_id = getattr(self, "request_id", "-")
        try:
            message = fmt % args
        except (TypeError, ValueError):
            message = fmt
        sys.stderr.write(
            f"[{time.strftime('%H:%M:%S')}] request={request_id} "
            f"message={redact_text(message)}\n"
        )

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Browser timeouts and window shutdowns routinely close localhost
            # sockets while the proxy thread is finishing. They are not server
            # faults and should not flood native.log with tracebacks.
            self.close_connection = True

    def do_GET(self) -> None:
        if self.path.startswith("/api/"):
            return self._dispatch_api("GET")
        return super().do_GET()

    def do_HEAD(self) -> None:
        if self.path.startswith("/api/"):
            return self._dispatch_api("HEAD")
        return super().do_HEAD()

    def do_POST(self) -> None:
        if self.path.startswith("/api/"):
            return self._dispatch_api("POST")
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/api/v1/") or self.path == "/api/shutdown":
            return self._send_api_error(ApiError(
                HTTPStatus.FORBIDDEN,
                "CORS_PREFLIGHT_REJECTED",
                "Cross-origin control requests are not authorized.",
            ))
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_PUT(self) -> None:
        return self._unsupported_method("PUT")

    def do_PATCH(self) -> None:
        return self._unsupported_method("PATCH")

    def do_DELETE(self) -> None:
        return self._unsupported_method("DELETE")

    def do_TRACE(self) -> None:
        return self._unsupported_method("TRACE")

    def do_CONNECT(self) -> None:
        return self._unsupported_method("CONNECT")

    def _unsupported_method(self, method: str) -> None:
        if self.path.startswith("/api/"):
            return self._dispatch_api(method)
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def send_response(self, code, message=None):
        super().send_response(code, message)
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")

    def _dispatch_api(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        media_match = re.fullmatch(
            rf"/api/v1/media/([A-Za-z0-9_-]{{22,128}})(?:\.({MEDIA_RELAY_SUFFIX_PATTERN}))?",
            parsed.path,
        )
        if media_match and not parsed.query:
            return self._handle_media_relay(method, media_match.group(1))
        dash_match = re.fullmatch(
            rf"/api/v1/dash/([A-Za-z0-9_-]{{22,128}})(?:\.({MEDIA_RELAY_SUFFIX_PATTERN}))?",
            parsed.path,
        )
        if dash_match:
            return self._handle_media_relay(method, dash_match.group(1), dash_query=parsed.query)
        asset_match = re.fullmatch(r"/api/v1/assets/([A-Za-z0-9_-]{22,128})", parsed.path)
        if asset_match:
            if parsed.query:
                return self._send_api_error(ApiError(
                    HTTPStatus.BAD_REQUEST,
                    "QUERY_NOT_ALLOWED",
                    "Artwork relay does not accept query parameters.",
                ))
            return self._handle_asset_relay(method, asset_match.group(1))
        if not rate_limit(self.client_address[0]):
            if parsed.path == "/api/v1" or parsed.path.startswith("/api/v1/"):
                return self._send_api_error(ApiError(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "RATE_LIMITED",
                    "Too many localhost requests. Try again shortly.",
                    retryable=True,
                ))
            return self.send_error(HTTPStatus.TOO_MANY_REQUESTS, "rate limit")

        if parsed.path == "/api/v1" or parsed.path.startswith("/api/v1/"):
            if parsed.query:
                return self._send_api_error(ApiError(
                    HTTPStatus.BAD_REQUEST,
                    "QUERY_NOT_ALLOWED",
                    "Control routes do not accept query parameters.",
                ))
            return self._handle_control_api(method, parsed.path)
        if parsed.path == "/api/proxy":
            return self._handle_proxy(method, parsed.query)
        if parsed.path in ("/api/health", "/api/ping"):
            return self._send_json({"ok": True, "app": APP_NAME, "port": PORT})
        if parsed.path == "/api/shutdown":
            if parsed.query:
                return self._send_api_error(ApiError(
                    HTTPStatus.BAD_REQUEST, "QUERY_NOT_ALLOWED", "Shutdown does not accept query parameters."
                ))
            if method != "POST":
                return self._send_api_error(ApiError(
                    HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "POST is required for shutdown."
                ))
            try:
                body = validate_mutation(
                    self.headers, self.rfile, self.server.server_port, SESSION_TOKEN
                )
                if body:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS", "Shutdown accepts an empty JSON object.")
            except ApiError as error:
                return self._send_api_error(error)
            # Shutdown is terminal.  The worker owners are deliberately given
            # a bounded grace period, but a worker still winding down must not
            # leave the native app alive after its registries have already
            # been closed.  That former "retry shutdown" path stranded the
            # UI with catalog/artwork services disabled, so thumbnails and
            # subsequent catalog requests could only return 503.
            graceful = shutdown_services(timeout=3.0)
            self._send_api_success(
                {"shutdown": "in_progress", "graceful": graceful},
                status=HTTPStatus.ACCEPTED,
            )
            schedule_process_exit()
            return None
        return self.send_error(HTTPStatus.NOT_FOUND)

    def _handle_control_api(self, method: str, path: str) -> None:
        try:
            if path == "/api/v1/session":
                validate_control_origin(self.headers, self.server.server_port, required=False)
                if method != "GET":
                    if method in {"POST", "PUT", "PATCH", "DELETE"}:
                        validate_mutation(self.headers, self.rfile, self.server.server_port, SESSION_TOKEN)
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "GET is required.")
                host = self.headers.get("Host", "").strip().lower()
                return self._send_api_success({
                    "api_version": "v1",
                    "token": SESSION_TOKEN,
                    "origin": f"http://{host}",
                    "poll_interval_ms": 750,
                })

            if method == "GET":
                validate_authenticated_get(self.headers, self.server.server_port, SESSION_TOKEN)
                if path == "/api/v1/runtime":
                    return self._send_api_success(
                        runtime_status(RUNTIME_PATHS, active_port=self.server.server_port)
                    )
                if path == "/api/v1/runtime/server-port":
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "POST is required.")
                if path == "/api/v1/profile/preferences":
                    return self._send_api_success({"values": load_profile_transfer(RUNTIME_PATHS)})
                if path == "/api/v1/ffmpeg/status":
                    return self._send_api_success(FFMPEG_SERVICE.status().as_data())
                if path == "/api/v1/catalog/owncast/snapshot":
                    return self._send_api_success(CATALOG_SERVICE.owncast_snapshot())
                if path in {
                    "/api/v1/catalog/feed/resolve",
                    "/api/v1/catalog/peertube/resolve",
                    "/api/v1/catalog/cache/clear",
                    "/api/v1/assets/register",
                } or re.fullmatch(r"/api/v1/assets/[A-Za-z0-9_-]{22,128}/expire", path):
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "POST is required.")
                if path in {"/api/v1/jobs/download", "/api/v1/jobs/record"}:
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "POST is required.")
                if path == "/api/v1/jobs":
                    return self._send_api_success({"jobs": JOB_REGISTRY.snapshots()})
                if path.startswith("/api/v1/jobs/"):
                    if path.endswith("/stop") or path.endswith("/cancel"):
                        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "POST is required.")
                    job_id = path.removeprefix("/api/v1/jobs/")
                    if not job_id or "/" in job_id:
                        raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "Control route was not found.")
                    return self._send_api_success(JOB_REGISTRY.snapshot(job_id))
                raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "Control route was not found.")

            if method == "POST":
                body_limit = CATALOG_BODY_LIMITS.get(path, 64 * 1024)
                if re.fullmatch(r"/api/v1/assets/[A-Za-z0-9_-]{22,128}/expire", path):
                    body_limit = 4 * 1024
                body = validate_mutation(
                    self.headers,
                    self.rfile,
                    self.server.server_port,
                    SESSION_TOKEN,
                    max_bytes=body_limit,
                )
                if path == "/api/v1/catalog/feed/resolve":
                    return self._send_api_success(CATALOG_SERVICE.resolve_feed(body))
                if path == "/api/v1/catalog/peertube/resolve":
                    return self._send_api_success(CATALOG_SERVICE.resolve_peertube(body))
                if path == "/api/v1/catalog/owncast/snapshot":
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "GET is required.")
                if path == "/api/v1/catalog/cache/clear":
                    if body:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS", "Catalog cache clearing accepts an empty JSON object.")
                    data = CATALOG_SERVICE.clear_cache()
                    data["asset_files_removed"] = ASSET_REGISTRY.clear_cache()
                    return self._send_api_success(data)
                if path == "/api/v1/runtime/server-port":
                    if set(body) != {"port"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST,
                            "INVALID_SERVER_PORT",
                            "Server port settings require only a port number.",
                        )
                    try:
                        next_port = save_server_port(body.get("port"), RUNTIME_PATHS)
                    except ValueError as error:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_SERVER_PORT", str(error)
                        ) from error
                    return self._send_api_success({
                        "server_port": self.server.server_port,
                        "next_launch_port": next_port,
                        "restart_required": True,
                    })
                if path == "/api/v1/profile/preferences":
                    if set(body) != {"values"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST,
                            "INVALID_PROFILE_PREFERENCES",
                            "Profile preferences require only a values object.",
                        )
                    try:
                        saved_values = save_profile_transfer(body.get("values"), RUNTIME_PATHS)
                    except ValueError as error:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST,
                            "INVALID_PROFILE_PREFERENCES",
                            str(error),
                        ) from error
                    return self._send_api_success({
                        "saved": True,
                        "keys": sorted(saved_values),
                    })
                if path == "/api/v1/assets/register":
                    registration = ASSET_REGISTRY.register(body)
                    return self._send_api_success(registration.public_data(), status=HTTPStatus.CREATED)
                asset_expire = re.fullmatch(r"/api/v1/assets/([A-Za-z0-9_-]{22,128})/expire", path)
                if asset_expire:
                    ASSET_REGISTRY.expire(asset_expire.group(1), body)
                    return self._send_api_success({"expired": True})
                if path == "/api/v1/jobs/download":
                    if set(body) != {"media_id"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_DOWNLOAD_REQUEST",
                            "Download start requires only a media registration ID.",
                        )
                    media_id = body.get("media_id")
                    if not isinstance(media_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,128}", media_id):
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_ID", "Media registration ID is invalid."
                        )
                    return self._send_api_success(
                        DOWNLOAD_SERVICE.start(media_id), status=HTTPStatus.ACCEPTED,
                    )
                if path == "/api/v1/jobs/record":
                    if (
                        not {"media_id", "profile"}.issubset(body)
                        or set(body) - {"media_id", "profile", "eq"}
                    ):
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_RECORDING_REQUEST",
                            "Recording start requires a media registration ID, quality profile, and optional EQ snapshot.",
                        )
                    media_id = body.get("media_id")
                    profile = body.get("profile")
                    if not isinstance(media_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,128}", media_id):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_ID", "Media registration ID is invalid.")
                    if profile not in {"compact", "balanced", "high"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_RECORDING_PROFILE", "Recording quality is invalid."
                        )
                    eq = normalize_recording_eq(body.get("eq"))
                    relay_origin = f"http://127.0.0.1:{self.server.server_port}"
                    return self._send_api_success(
                        RECORDING_SERVICE.start(media_id, profile, relay_origin, eq),
                        status=HTTPStatus.ACCEPTED,
                    )
                if path == "/api/v1/downloads/open-folder":
                    if body:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS",
                            "Open downloads folder accepts an empty JSON object.",
                        )
                    return self._send_api_success({
                        "opened": True, "path": DOWNLOAD_SERVICE.open_downloads_folder(),
                    })
                if path in {"/api/v1/ffmpeg/install", "/api/v1/ffmpeg/repair"}:
                    allowed = {"confirmed", "destination"}
                    if set(body) - allowed:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS",
                            "FFmpeg installation contains unsupported fields.",
                        )
                    if body.get("confirmed") is not True:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "CONFIRMATION_REQUIRED",
                            "Explicit confirmation is required before downloading FFmpeg.",
                        )
                    destination = body.get("destination", "portable")
                    if destination not in {"portable", "LocalAppData"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_DESTINATION",
                            "FFmpeg destination must be portable or LocalAppData.",
                        )
                    return self._send_api_success(
                        FFMPEG_SERVICE.start_install(destination).as_data(),
                        status=HTTPStatus.ACCEPTED,
                    )
                if path == "/api/v1/ffmpeg/cancel":
                    if body:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS",
                            "FFmpeg cancellation accepts an empty JSON object.",
                        )
                    return self._send_api_success(FFMPEG_SERVICE.cancel_install().as_data())
                if path == "/api/v1/ffmpeg/remove":
                    allowed = {"confirmed", "destination"}
                    if set(body) - allowed:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS",
                            "FFmpeg removal contains unsupported fields.",
                        )
                    if body.get("confirmed") is not True:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "CONFIRMATION_REQUIRED",
                            "Explicit confirmation is required before removing managed FFmpeg.",
                        )
                    destination = body.get("destination")
                    if destination not in {"portable", "LocalAppData"}:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST, "INVALID_DESTINATION",
                            "FFmpeg destination must be portable or LocalAppData.",
                        )
                    return self._send_api_success(FFMPEG_SERVICE.remove(destination).as_data())
                if path == "/api/v1/media/register":
                    registration = MEDIA_REGISTRY.register(body)
                    return self._send_api_success(registration.public_data(), status=HTTPStatus.CREATED)
                expire_match = re.fullmatch(r"/api/v1/media/([A-Za-z0-9_-]{22,128})/expire", path)
                if expire_match:
                    allowed = {"grace_seconds"}
                    if set(body) - allowed:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS", "Media expiry contains unsupported fields.")
                    grace = body.get("grace_seconds", 0)
                    if not isinstance(grace, (int, float)) or isinstance(grace, bool):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_GRACE", "Media expiry grace is invalid.")
                    MEDIA_REGISTRY.expire(expire_match.group(1), grace_seconds=grace)
                    return self._send_api_success({"expired": True})
                if body:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS", "This operation accepts an empty JSON object.")
                match = re.fullmatch(r"/api/v1/jobs/([A-Za-z0-9_-]{16,128})/(stop|cancel)", path)
                if not match:
                    raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "Control route was not found.")
                job_id, action = match.groups()
                job = JOB_REGISTRY.request_stop(job_id) if action == "stop" else JOB_REGISTRY.request_cancel(job_id)
                return self._send_api_success(job.to_public())

            if method in {"PUT", "PATCH", "DELETE"}:
                validate_mutation(self.headers, self.rfile, self.server.server_port, SESSION_TOKEN)
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "HTTP method is not supported.")
        except JobNotFoundError as error:
            return self._send_api_error(ApiError(HTTPStatus.NOT_FOUND, error.code, str(error)))
        except (JobStateError, DuplicateJobError, JobLimitError) as error:
            return self._send_api_error(ApiError(HTTPStatus.CONFLICT, error.code, str(error)))
        except JobError as error:
            return self._send_api_error(ApiError(HTTPStatus.BAD_REQUEST, error.code, str(error)))
        except FfmpegError as error:
            status = HTTPStatus.CONFLICT if error.code in {
                "INSTALL_ACTIVE", "NO_ACTIVE_INSTALL", "DESTINATION_NOT_WRITABLE"
            } else HTTPStatus.BAD_REQUEST
            return self._send_api_error(ApiError(status, error.code, str(error), error.retryable))
        except DownloadError as error:
            status = HTTPStatus.CONFLICT if error.code in {
                "DOWNLOAD_NOT_FINITE", "DOWNLOAD_NAME_COLLISION"
            } else HTTPStatus.BAD_REQUEST
            return self._send_api_error(ApiError(status, error.code, str(error), error.retryable))
        except RecordingError as error:
            status = HTTPStatus.CONFLICT if error.code in {
                "RECORDING_NOT_LIVE", "RECORDING_TOOL_UNAVAILABLE", "RECORDING_NAME_COLLISION"
            } else HTTPStatus.BAD_REQUEST
            return self._send_api_error(ApiError(status, error.code, str(error), error.retryable))
        except ApiError as error:
            return self._send_api_error(error)
        except Exception as error:
            self.log_message("control failure type=%s", type(error).__name__)
            return self._send_api_error(ApiError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "The local control service could not complete the request.",
                retryable=True,
            ))

    def _handle_asset_relay(self, method: str, token: str) -> None:
        try:
            validate_control_origin(self.headers, self.server.server_port, required=False)
            if method not in {"GET", "HEAD"}:
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Artwork relay supports GET and HEAD only.")
            ranges = list(self.headers.get_all("Range", []))
            validators = list(self.headers.get_all("If-None-Match", []))
            if_ranges = list(self.headers.get_all("If-Range", []))
            if len(ranges) > 1 or len(validators) > 1 or len(if_ranges) > 1:
                raise ApiError(HTTPStatus.BAD_REQUEST, "DUPLICATE_HEADER", "Artwork request headers must appear at most once.")
            range_value = ranges[0].strip() if ranges else ""
            validator = validators[0].strip() if validators else ""
            if_range = if_ranges[0].strip() if if_ranges else ""
            if range_value and (
                len(range_value) > 128 or not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", range_value)
            ):
                raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "INVALID_RANGE", "Artwork byte range is invalid.")
            if validator and (len(validator) > 1024 or re.search(r"[\r\n\0]", validator)):
                raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_VALIDATOR", "Artwork cache validator is invalid.")
            if if_range and (len(if_range) > 1024 or re.search(r"[\r\n\0]", if_range)):
                raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_VALIDATOR", "Artwork range validator is invalid.")
            if not ASSET_SLOTS.acquire(blocking=False):
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "ASSET_RELAY_BUSY", "Artwork relay is busy.", retryable=True)
            try:
                blob = ASSET_REGISTRY.read(token)
            finally:
                ASSET_SLOTS.release()
            if validator in {"*", blob.etag}:
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self.send_header("ETag", blob.etag)
                self.send_header("Cache-Control", "private, max-age=300")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Request-ID", getattr(self, "request_id", new_request_id()))
                self.end_headers()
                return None
            data = blob.data
            status = HTTPStatus.OK
            start = 0
            end = len(data) - 1
            if range_value and if_range and if_range != blob.etag:
                range_value = ""
            if range_value:
                spec = range_value.removeprefix("bytes=")
                first, last = spec.split("-", 1)
                if first:
                    start = int(first)
                    end = int(last) if last else end
                else:
                    suffix = int(last)
                    if suffix <= 0:
                        raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "INVALID_RANGE", "Artwork byte range is invalid.")
                    start = max(0, len(data) - suffix)
                if start >= len(data) or end < start:
                    raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "INVALID_RANGE", "Artwork byte range is outside the image.")
                end = min(end, len(data) - 1)
                data = data[start:end + 1]
                status = HTTPStatus.PARTIAL_CONTENT
            self.send_response(status)
            self.send_header("Content-Type", blob.content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(blob.data)}")
            self.send_header("ETag", blob.etag)
            self.send_header("Cache-Control", "private, max-age=300")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Request-ID", getattr(self, "request_id", new_request_id()))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(data)
                self.wfile.flush()
        except (ApiError, MediaError) as error:
            return self._send_api_error(error)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self._abort_relay_response()
            return None
        except Exception as error:
            self.log_message("asset relay failure type=%s", type(error).__name__)
            return self._send_api_error(ApiError(
                HTTPStatus.BAD_GATEWAY,
                "ASSET_RELAY_FAILED",
                "Artwork relay could not complete the request.",
                retryable=True,
            ))

    def _handle_media_relay(self, method: str, token: str, *, dash_query: str | None = None) -> None:
        response_started = False
        try:
            validate_control_origin(self.headers, self.server.server_port, required=False)
            if method not in {"GET", "HEAD"}:
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Media relay supports GET and HEAD only.")
            ranges = list(self.headers.get_all("Range", []))
            if len(ranges) > 1:
                raise ApiError(HTTPStatus.BAD_REQUEST, "DUPLICATE_HEADER", "Range must appear at most once.")
            range_value = ranges[0].strip() if ranges else ""
            if range_value and not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", range_value):
                raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "INVALID_RANGE", "Media byte range is invalid.")
            registration = (
                MEDIA_REGISTRY.expand_dash_template(token, dash_query)
                if dash_query is not None else MEDIA_REGISTRY.get(token)
            )
            manifest_probe = registration.media_type in {"hls", "dash"} and range_value == "bytes=0-"
            if registration.media_type in {"hls", "dash"} and range_value and not manifest_probe:
                code = "HLS_RANGE_REJECTED" if registration.media_type == "hls" else "DASH_RANGE_REJECTED"
                raise ApiError(
                    HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
                    code,
                    "Streaming manifests do not accept byte ranges.",
                )
            if not RELAY_SLOTS.acquire(blocking=False):
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "RELAY_BUSY", "Media relay is busy.", retryable=True)
            try:
                headers = dict(registration.headers)
                if range_value and not manifest_probe:
                    headers["Range"] = range_value
                upstream = MEDIA_REGISTRY.connector.open(registration.url, method=method, headers=headers)
                try:
                    content_type = upstream.response.getheader("Content-Type", "application/octet-stream")
                    if len(content_type) > 2048 or re.search(r"[\r\n\0]", content_type):
                        content_type = "application/octet-stream"
                    content_type_lower = content_type.lower()
                    is_hls = registration.media_type == "hls" or "mpegurl" in content_type_lower
                    is_dash = registration.media_type == "dash" or "dash+xml" in content_type_lower
                    is_manifest = is_hls or is_dash
                    if is_manifest and method == "GET" and 200 <= upstream.response.status < 300:
                        encoding = (upstream.response.getheader("Content-Encoding") or "identity").lower()
                        if encoding != "identity":
                            raise ApiError(
                                HTTPStatus.BAD_GATEWAY,
                                "MANIFEST_ENCODING_UNSUPPORTED",
                                "Streaming manifest used an unsupported content encoding.",
                            )
                        manifest = upstream.response.read(MAX_MANIFEST_BYTES + 1)
                        if len(manifest) > MAX_MANIFEST_BYTES:
                            raise ApiError(HTTPStatus.BAD_GATEWAY, "MANIFEST_TOO_LARGE", "Streaming manifest is too large.")
                        try:
                            text = manifest.decode("utf-8-sig")
                        except UnicodeDecodeError:
                            raise ApiError(HTTPStatus.BAD_GATEWAY, "INVALID_MANIFEST", "Streaming manifest is not UTF-8.") from None
                        if is_dash:
                            rewritten = rewrite_dash_manifest(
                                text, upstream.url, registration, MEDIA_REGISTRY,
                            )
                            rewritten_type = "application/dash+xml"
                        else:
                            rewritten = rewrite_hls_manifest(
                                text, upstream.url, registration, MEDIA_REGISTRY,
                            ).encode("utf-8")
                            rewritten_type = "application/vnd.apple.mpegurl"
                        return self._send_relay_headers(
                            upstream.response.status,
                            rewritten_type,
                            len(rewritten),
                            body=rewritten,
                        )
                    self.send_response(upstream.response.status)
                    self.send_header("Content-Type", content_type)
                    for name in ("Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "Content-Encoding"):
                        value = upstream.response.getheader(name)
                        if value and len(value) <= 2048 and not re.search(r"[\r\n\0]", value):
                            self.send_header(name, value)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Request-ID", getattr(self, "request_id", new_request_id()))
                    if not upstream.response.getheader("Content-Length"):
                        self.send_header("Connection", "close")
                        self.close_connection = True
                    self.end_headers()
                    response_started = True
                    if method == "HEAD":
                        return None
                    for chunk in upstream.iter_chunks(chunk_size=RELAY_CHUNK_SIZE):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    return None
                finally:
                    upstream.close()
            finally:
                RELAY_SLOTS.release()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self._abort_relay_response()
            return None
        except socket.timeout:
            if response_started:
                self._abort_relay_response()
                return None
            return self._send_api_error(ApiError(
                HTTPStatus.GATEWAY_TIMEOUT,
                "MEDIA_IDLE_TIMEOUT",
                "Media source stopped responding.",
                retryable=True,
            ))
        except MediaError as error:
            if response_started:
                self._abort_relay_response()
                return None
            return self._send_api_error(error)
        except ApiError as error:
            if response_started:
                self._abort_relay_response()
                return None
            return self._send_api_error(error)
        except Exception as error:
            if response_started:
                self._abort_relay_response()
                return None
            self.log_message("relay failure type=%s", type(error).__name__)
            return self._send_api_error(ApiError(
                HTTPStatus.BAD_GATEWAY, "RELAY_FAILED", "Media relay could not complete the request.", retryable=True
            ))

    def _abort_relay_response(self) -> None:
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    def _send_relay_headers(
        self,
        status: int,
        content_type: str,
        content_length: int,
        *,
        body: bytes | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Request-ID", getattr(self, "request_id", new_request_id()))
        self.end_headers()
        if body is not None and getattr(self, "command", "") != "HEAD":
            self.wfile.write(body)
            self.wfile.flush()

    def _send_api_success(self, data, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._send_json(success_envelope(data, getattr(self, "request_id", new_request_id())), status=status)

    def _send_api_error(self, error: ApiError) -> None:
        # Header/auth/size failures may occur before a request body is read.
        # Closing prevents unread bytes from becoming a second request on the
        # persistent HTTP/1.1 connection.
        if getattr(self, "command", "") not in {"GET", "HEAD"}:
            self.close_connection = True
        retry_after = getattr(error, "retry_after", None)
        response_headers = (
            {"Retry-After": str(retry_after)}
            if isinstance(retry_after, int) and 0 <= retry_after <= 24 * 60 * 60
            else None
        )
        self._send_json(
            error_envelope(error, getattr(self, "request_id", new_request_id())),
            status=HTTPStatus(error.status),
            response_headers=response_headers,
        )

    def _send_json(
        self,
        payload: dict,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        response_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Request-ID", getattr(self, "request_id", new_request_id()))
        for name, value in (response_headers or {}).items():
            if name == "Retry-After" and value.isdecimal():
                self.send_header(name, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if getattr(self, "command", "") != "HEAD":
            self.wfile.write(body)
            self.wfile.flush()

    def _handle_proxy(self, method: str, query: str) -> None:
        try:
            validate_control_origin(self.headers, self.server.server_port, required=False)
            if method not in {"GET", "POST"}:
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Metadata proxy supports GET and POST only.")
            if not isinstance(query, str) or len(query) > 16_384:
                raise ApiError(HTTPStatus.REQUEST_URI_TOO_LONG, "QUERY_TOO_LARGE", "Metadata proxy query is too large.")
            try:
                qs = urllib.parse.parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=1)
            except ValueError:
                raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_PROXY_QUERY", "Metadata proxy query is invalid.") from None
            if set(qs) != {"url"} or len(qs["url"]) != 1 or not qs["url"][0]:
                raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_PROXY_QUERY", "Metadata proxy requires one URL.")
            url = qs["url"][0]
            target = urllib.parse.urlsplit(url)
            host = (target.hostname or "").lower()
            if target.scheme != "https" or not is_allowed_host(host):
                raise ApiError(HTTPStatus.FORBIDDEN, "PROXY_TARGET_REJECTED", "Metadata proxy target is not approved.")

            body = None
            headers = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*"}
            if method == "POST":
                transfer_values = self.headers.get_all("Transfer-Encoding", [])
                length_values = self.headers.get_all("Content-Length", [])
                if transfer_values:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "CHUNKED_BODY_REJECTED", "Chunked proxy requests are not supported.")
                if len(length_values) > 1:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "DUPLICATE_HEADER", "Content-Length must appear at most once.")
                raw_length = length_values[0] if length_values else "0"
                if not raw_length.isdecimal():
                    raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.")
                length = int(raw_length)
                if length > 64 * 1024:
                    raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "BODY_TOO_LARGE", "Metadata proxy body is too large.")
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "INCOMPLETE_BODY", "Metadata proxy body was incomplete.")
                content_type = self.headers.get("Content-Type")
                if content_type and len(content_type) <= 256 and not re.search(r"[\r\n\0]", content_type):
                    headers["Content-Type"] = content_type

            upstream = PROXY_CONNECTOR.open(url, method=method, headers=headers, body=body)
            if upstream.response.status == HTTPStatus.NOT_FOUND and self._is_expected_librivox_empty(target, upstream.response):
                upstream.close()
                return self._send_json({"books": []})
            return self._stream_upstream(upstream, upstream.response.status or 200)
        except (ApiError, MediaError) as error:
            return self._send_api_error(error)
        except (TypeError, ValueError):
            return self._send_api_error(ApiError(
                HTTPStatus.BAD_REQUEST, "INVALID_PROXY_QUERY", "Metadata proxy query is invalid."
            ))

    @staticmethod
    def _is_expected_librivox_empty(target: urllib.parse.SplitResult, response) -> bool:
        host = (target.hostname or "").lower()
        return (
            response.status == HTTPStatus.NOT_FOUND
            and host in {"librivox.org", "www.librivox.org"}
            and target.path.rstrip("/") == "/api/feed/audiobooks"
        )

    def _stream_upstream(self, upstream, status: int) -> None:
        try:
            response = getattr(upstream, "response", upstream)
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            content_length = response.headers.get("Content-Length")
            if content_length and content_length.isdigit() and int(content_length) > MAX_SIZE:
                self.close_connection = True
                return self.send_error(HTTPStatus.BAD_GATEWAY, "upstream response too large")

            self.send_response(status)
            self.send_header("Content-Type", content_type)
            if content_length and content_length.isdigit():
                self.send_header("Content-Length", content_length)
            else:
                self.send_header("Connection", "close")
            # Catalog pagination and scheduler backoff depend on these exact
            # passive headers. Never forward arbitrary upstream headers (for
            # example cookies, CORS policy, redirects, or active content).
            for header_name, max_length in (("Link", 16_384), ("Retry-After", 128)):
                value = response.headers.get(header_name)
                if (
                    isinstance(value, str)
                    and 0 < len(value) <= max_length
                    and not re.search(r"[\r\n\0]", value)
                ):
                    self.send_header(header_name, value)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_SIZE:
                    sys.stderr.write(f"[proxy] response > {MAX_SIZE} bytes; truncating\n")
                    self.close_connection = True
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    self.close_connection = True
                    return
        finally:
            try:
                upstream.close()
            except Exception:
                pass


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


WorldMediaHandler.protocol_version = "HTTP/1.1"


def main() -> int:
    if not ROOT.is_dir():
        sys.stderr.write(f"[server] frontend dir not found: {ROOT}\n")
        return 2
    if not (ROOT / "index.html").is_file():
        sys.stderr.write(f"[server] {ROOT / 'index.html'} missing\n")
        return 2

    bind_host = os.environ.get("WORLDMEDIA_BIND", "127.0.0.1")
    server = ThreadingServer((bind_host, PORT), WorldMediaHandler)
    sys.stderr.write(f"[server] World Media listening on http://{bind_host}:{PORT}/ (frontend={ROOT})\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("[server] shutting down\n")
    finally:
        shutdown_services(timeout=5.0)
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
