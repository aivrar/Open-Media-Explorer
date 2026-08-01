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
from worldmedia_theme import NativeThemeBridge


APP_TITLE = "World Media"
APP_ID = "WorldMediaWindows"
DEFAULT_PORT = DEFAULT_SERVER_PORT
# If the stable default is occupied, avoid common development ranges rather
# than silently switching the profile to a neighboring port.
FALLBACK_PORTS = range(19124, 19180)
MAX_NATIVE_LOG_BYTES = 8 * 1024 * 1024
_LOG_HANDLE = None


def bundled_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def _can_bind_port(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def find_port(preferred: int = DEFAULT_PORT) -> int:
    forced = os.environ.get("WORLDMEDIA_WINDOWS_PORT") or os.environ.get("WORLDMEDIA_PORT")
    if forced:
        try:
            port = normalize_server_port(int(forced))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("WORLDMEDIA_WINDOWS_PORT must be a valid unprivileged TCP port.") from exc
        if not _can_bind_port(port):
            raise RuntimeError(f"World Media could not bind requested localhost port {port}.")
        return port

    candidates: list[int] = []
    for port in (preferred, DEFAULT_PORT, *FALLBACK_PORTS):
        try:
            port = normalize_server_port(port)
        except ValueError:
            continue
        if port not in candidates:
            candidates.append(port)
    for port in candidates:
        if _can_bind_port(port):
            return port
    raise RuntimeError("No free localhost port found for World Media")


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


def main() -> int:
    global _LOG_HANDLE

    paths = get_runtime_paths()
    migrate_legacy_state(paths)
    paths = ensure_state_directories(paths)
    port = find_port(configured_server_port(paths))
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
    httpd = worldmedia_server.ThreadingServer(("127.0.0.1", port), worldmedia_server.WorldMediaHandler)
    url = f"http://127.0.0.1:{port}/"

    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] listening {url}", flush=True)

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
            import webview

            theme_bridge = NativeThemeBridge()
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
