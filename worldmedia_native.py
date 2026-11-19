#!/usr/bin/env python3
"""Windows-native World Media launcher.

This is the portable Windows entry point. It starts the local HTTP server on
127.0.0.1, opens the UI in a WebView2 desktop window, and stores all runtime
state beside the launcher. End users do not need Python, Node, WSL, or Linux.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

from worldmedia_runtime import (
    DEFAULT_SERVER_PORT,
    configured_server_port,
    ensure_state_directories,
    get_runtime_paths,
    migrate_legacy_state,
    normalize_server_port,
)
from worldmedia_theme import NativeThemeBridge, saved_theme


APP_TITLE = "World Media"
APP_ID = "WorldMediaWindows"
DEFAULT_PORT = DEFAULT_SERVER_PORT
# If the stable default is occupied, avoid common development ranges rather
# than silently switching the profile to a neighboring port.
FALLBACK_PORTS = range(19124, 19180)
# How long a busy preferred port is waited for at start (a copy that was just
# closed needs up to about 5 seconds to shut down; see main()).
PREFERRED_PORT_WAIT_SECONDS = 8.0
PORT_WAIT_STEP_SECONDS = 0.25
# How long the program on a busy port gets to say it is World Media.
PORT_CHECK_TIMEOUT_SECONDS = 0.5
PORT_BIND_ATTEMPTS = 5
MAX_NATIVE_LOG_BYTES = 8 * 1024 * 1024
_LOG_HANDLE = None


def bundled_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def _can_bind_port(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # On Windows SO_REUSEADDR makes this bind succeed even while another
        # World Media is listening on the port, so the check is made without
        # it there (POSIX SO_REUSEADDR only skips TIME_WAIT and is kept).
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _answers_as_world_media(port: int, *, timeout: float = PORT_CHECK_TIMEOUT_SECONDS) -> bool:
    """True when the program listening on ``port`` answers /api/health as
    World Media (worldmedia_server answers it until its very last moment,
    while it shuts its services down). Anything else, no answer, or no answer
    in time is False."""
    import http.client
    import json

    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        if response.status != 200:
            return False
        data = json.loads(response.read(4096) or b"null")
        return isinstance(data, dict) and data.get("app") == APP_TITLE
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def _forced_port() -> int | None:
    forced = os.environ.get("WORLDMEDIA_WINDOWS_PORT") or os.environ.get("WORLDMEDIA_PORT")
    if not forced:
        return None
    try:
        return normalize_server_port(int(forced))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("WORLDMEDIA_WINDOWS_PORT must be a valid unprivileged TCP port.") from exc


def choose_port(preferred: int = DEFAULT_PORT, *, wait_seconds: float = 0.0, exclude=(), sleep=time.sleep,
                clock=time.monotonic, is_world_media=_answers_as_world_media) -> tuple[int, str]:
    """The port to listen on, and a note for the log saying how it was chosen.

    A busy preferred port is waited for (up to ``wait_seconds``) only when the
    program holding it answers as World Media: a copy that was just closed
    keeps its port for a few seconds while it shuts down, and moving to
    another port would also move to another browser origin (other saved
    favorites). A port held by any other program is passed over at once, so
    nobody waits on every start. ``exclude`` are ports already tried."""
    forced = _forced_port()
    if forced is not None:
        if not _can_bind_port(forced):
            raise RuntimeError(f"World Media could not bind requested localhost port {forced}.")
        return forced, "port set by WORLDMEDIA_WINDOWS_PORT"

    candidates: list[int] = []
    for port in (preferred, DEFAULT_PORT, *FALLBACK_PORTS):
        try:
            port = normalize_server_port(port)
        except ValueError:
            continue
        if port not in candidates and port not in exclude:
            candidates.append(port)
    note = ""
    if candidates and candidates[0] == preferred and not _can_bind_port(preferred):
        if wait_seconds > 0 and is_world_media(preferred):
            start = clock()
            deadline = start + wait_seconds
            while clock() < deadline:
                sleep(PORT_WAIT_STEP_SECONDS)
                if _can_bind_port(preferred):
                    return preferred, (f"waited {clock() - start:.1f}s for port {preferred}, "
                                       "held by a World Media that was closing")
            note = f"port {preferred} was still held by World Media after {wait_seconds:g}s"
        else:
            note = f"port {preferred} is used by another program"
        candidates = candidates[1:]
    for port in candidates:
        if _can_bind_port(port):
            return port, note
    raise RuntimeError("No free localhost port found for World Media")


def find_port(preferred: int = DEFAULT_PORT, *, wait_seconds: float = 0.0, sleep=time.sleep,
              clock=time.monotonic, is_world_media=_answers_as_world_media) -> int:
    """The port to listen on (choose_port without the note)."""
    return choose_port(preferred, wait_seconds=wait_seconds, sleep=sleep, clock=clock,
                       is_world_media=is_world_media)[0]


def bind_with_retry(create, port: int, next_port, *, attempts: int = PORT_BIND_ATTEMPTS):
    """Make the listening server, choosing another port when the bind fails.

    Checking that a port is free and then binding it are two steps; two copies
    started together can both see it free, and the second bind then fails.
    ``create(port)`` makes the server; ``next_port(tried)`` picks a port not in
    ``tried`` (it raises RuntimeError when there is none). Returns
    (server, port, tried ports)."""
    tried: list[int] = []
    for _ in range(max(1, attempts)):
        try:
            return create(port), port, tried
        except OSError:
            tried.append(port)
            port = next_port(set(tried))
    raise RuntimeError("World Media could not listen on a localhost port.")


def configure_environment(port: int, paths=None) -> tuple[Path, Path]:
    root = bundled_root()
    selected = paths or get_runtime_paths()
    if paths is None:
        migrate_legacy_state(selected)
    selected = ensure_state_directories(selected)
    runtime = selected.state_root

    os.environ["WORLDMEDIA_APP_DIR"] = str(root)
    os.environ["WORLDMEDIA_PORTABLE_ROOT"] = str(selected.portable_root)
    os.environ["WORLDMEDIA_STATE_ROOT"] = str(selected.state_root)
    os.environ["WORLDMEDIA_FRONTEND"] = str(root / "frontend")
    os.environ["WORLDMEDIA_CACHE_DIR"] = str(runtime / "cache")
    os.environ["WORLDMEDIA_STATE_DIR"] = str(runtime / "state")
    os.environ["WORLDMEDIA_LOG_DIR"] = str(runtime / "logs")
    os.environ["WORLDMEDIA_BIND"] = "127.0.0.1"
    os.environ["WORLDMEDIA_PORT"] = str(port)
    os.environ["WORLDMEDIA_NATIVE"] = "1"
    return root, runtime


_BUNDLED_ASSEMBLY_PACKAGES = ("pythonnet", "clr_loader", "webview")


def unblock_bundled_assemblies(root: Path | None = None) -> int:
    """Clear the downloaded-file mark from the app's own .NET assemblies.

    Explorer copies a zip's "downloaded from the internet" mark
    (the ``Zone.Identifier`` stream) onto every extracted file. .NET Framework
    then refuses to load Python.Runtime.dll, and the window never opens
    ("Failed to resolve Python.Runtime.Loader.Initialize"). This is the same
    as ticking Unblock in the file's Properties, limited to the DLLs shipped
    inside this app's own pythonnet/clr_loader/pywebview folders. The single
    EXE unpacks to a fresh temporary folder and never has the mark.
    """

    if os.name != "nt":
        return 0
    base = Path(root) if root is not None else Path(__file__).resolve().parent / "Lib" / "site-packages"
    cleared = 0
    for package in _BUNDLED_ASSEMBLY_PACKAGES:
        folder = base / package
        if not folder.is_dir():
            continue
        for dll in folder.rglob("*.dll"):
            try:
                os.remove(f"{dll}:Zone.Identifier")
                cleared += 1
            except OSError:
                pass
    return cleared


def main() -> int:
    global _LOG_HANDLE

    paths = get_runtime_paths()
    migrate_legacy_state(paths)
    paths = ensure_state_directories(paths)
    preferred = configured_server_port(paths)
    forced = _forced_port()
    port, port_note = choose_port(preferred, wait_seconds=PREFERRED_PORT_WAIT_SECONDS)
    _root, runtime = configure_environment(port, paths)
    log_path = runtime / "logs" / "native.log"
    try:
        if log_path.is_file() and log_path.stat().st_size > MAX_NATIVE_LOG_BYTES:
            rotated = log_path.with_suffix(".log.1")
            rotated.unlink(missing_ok=True)
            log_path.replace(rotated)
        _LOG_HANDLE = log_path.open("a", encoding="utf-8", buffering=1)
        sys.stdout = _LOG_HANDLE
        sys.stderr = _LOG_HANDLE
    except OSError:
        pass

    import worldmedia_server

    # worldmedia_server reads environment at import time, so import after
    # configure_environment().
    def next_port(tried):
        if forced is not None:
            raise RuntimeError(f"World Media could not bind requested localhost port {forced}.")
        chosen, _note = choose_port(preferred, exclude=tried)
        configure_environment(chosen, paths)
        worldmedia_server.PORT = chosen
        return chosen

    httpd, port, lost = bind_with_retry(
        lambda candidate: worldmedia_server.ThreadingServer(("127.0.0.1", candidate), worldmedia_server.WorldMediaHandler),
        port, next_port,
    )
    url = f"http://127.0.0.1:{port}/"

    # The process id tells two copies apart in this log; a different port
    # means the saved favorites of another browser origin are in use.
    notes = [port_note] if port_note else []
    if lost:
        notes.append("another program took port " + ", ".join(str(value) for value in lost) + " first")
    note = f" ({'; '.join(notes)})" if notes else ""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] listening {url} pid={os.getpid()}{note}", flush=True)

    if os.environ.get("WORLDMEDIA_NO_BROWSER") == "1":
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            return 0
        finally:
            worldmedia_server.shutdown_services(timeout=5.0)
            httpd.server_close()
        return 0

    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()
    try:
        try:
            unblock_bundled_assemblies()
            import webview

            theme_bridge = NativeThemeBridge(saved_theme(os.environ.get("WORLDMEDIA_STATE_DIR")))
            window = webview.create_window(
                APP_TITLE,
                url,
                js_api=theme_bridge,
                width=1280,
                height=860,
                min_size=(980, 660),
                background_color="#11151b",
                text_select=False,
            )
            if window is None:
                raise RuntimeError("pywebview did not create the native window")
            theme_bridge._bind_window(window)
            webview.start(
                gui="edgechromium",
                debug=False,
                private_mode=False,
                storage_path=str(runtime / "webview2_data"),
                icon=str(_root / "assets" / "worldmedia.ico"),
            )
            return 0
        except Exception as exc:
            print(f"[native] WebView startup failed: {exc}", flush=True)
            if os.environ.get("WORLDMEDIA_ALLOW_SYSTEM_BROWSER") == "1":
                import webbrowser

                webbrowser.open(url)
                while True:
                    time.sleep(3600)
            return 1
    except KeyboardInterrupt:
        return 0
    finally:
        worldmedia_server.shutdown_services(timeout=5.0)
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
