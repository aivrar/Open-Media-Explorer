"""Opt-in Phase 0 startup/resource baseline; excluded from unittest discovery.

The harness launches isolated source and/or packaged instances, samples the
complete process tree at fixed elapsed times, summarizes the local request log,
and shuts each instance down through the real authenticated control API.  It
never reads the user's normal state directory.  DOM/search/scroll metrics are
left explicitly unavailable unless the supported visual-control runtime is
present; callers must not reinterpret proxy timing as a rendered-card timing.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

import psutil


ROOT = Path(__file__).resolve().parents[1]
PACKAGED_EXE = ROOT / "dist" / "WorldMediaWindows.exe"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev_environment import configure_local_cache


configure_local_cache()


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def request_json(port: int, path: str, *, method: str = "GET", token: str = "") -> dict:
    origin = f"http://127.0.0.1:{port}"
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["X-WorldMedia-Token"] = token
    if method != "GET":
        data = b"{}"
        headers.update({"Content-Type": "application/json", "Origin": origin})
    request = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.loads(response.read())


def wait_healthy(process: subprocess.Popen, port: int, timeout: float = 45.0) -> tuple[float, str]:
    started = time.perf_counter()
    deadline = started + timeout
    while time.perf_counter() < deadline and process.poll() is None:
        try:
            health = request_json(port, "/api/health")
            if health.get("ok"):
                session = request_json(port, "/api/v1/session")
                return time.perf_counter() - started, session["data"]["token"]
        except (OSError, urllib.error.URLError, KeyError, ValueError, json.JSONDecodeError):
            time.sleep(0.1)
    if process.poll() is not None:
        raise RuntimeError(f"process exited during startup with {process.returncode}")
    raise TimeoutError(f"port {port} did not become healthy")


def process_tree_snapshot(root_process: psutil.Process, elapsed: float, port: int) -> dict:
    processes: list[psutil.Process] = []
    for candidate in [root_process, *root_process.children(recursive=True)]:
        try:
            if candidate.is_running() and candidate.status() != psutil.STATUS_ZOMBIE:
                processes.append(candidate)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    rss = private = cpu = threads = 0.0
    names: list[str] = []
    for process in processes:
        try:
            memory = process.memory_info()
            rss += memory.rss
            private += getattr(memory, "private", 0)
            times = process.cpu_times()
            cpu += times.user + times.system
            threads += process.num_threads()
            names.append(process.name())
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    health_started = time.perf_counter()
    health_ok = False
    try:
        health_ok = bool(request_json(port, "/api/health").get("ok"))
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        pass
    return {
        "elapsedSeconds": round(elapsed, 3),
        "processCount": len(processes),
        "processNames": sorted(names),
        "workingSetMiB": round(rss / (1024 * 1024), 3),
        "privateMiB": round(private / (1024 * 1024), 3),
        "cpuSeconds": round(cpu, 3),
        "threadCount": int(threads),
        "healthOk": health_ok,
        "healthLatencyMs": round((time.perf_counter() - health_started) * 1000, 3),
    }


def summarize_log(path: Path, process_started_wall: float) -> dict:
    if not path.is_file():
        return {"available": False}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    proxy_seconds: list[str] = []
    frontend_second = proxy_second = None
    adapter_assets: set[str] = set()
    for line in lines:
        if not line.startswith("["):
            continue
        timestamp = line[1:9] if len(line) >= 9 else ""
        if " method=GET path=/ status=200 " in line and frontend_second is None:
            frontend_second = timestamp
        if " path=/api/proxy " in line:
            proxy_seconds.append(timestamp)
            if proxy_second is None:
                proxy_second = timestamp
        if " method=GET path=/assets/" in line and any(name in line for name in (
            "radio-browser", "iptv-org", "internet-archive", "nasa", "wikimedia", "librivox",
            "media-ccc", "library-of-congress", "gpodder", "peertube", "owncast",
        )):
            adapter_assets.add(line.split(" path=", 1)[1].split(" status=", 1)[0])

    per_second = Counter(proxy_seconds)
    return {
        "available": True,
        "lineCount": len(lines),
        "frontendFirstRequestClock": frontend_second,
        "proxyFirstCompletionClock": proxy_second,
        "adapterAssetsRequested": sorted(adapter_assets),
        "proxyCompletions": len(proxy_seconds),
        "proxyActiveSeconds": len(per_second),
        "proxyMeanPerActiveSecond": round(sum(per_second.values()) / len(per_second), 3) if per_second else 0,
        "proxyMaxPerSecond": max(per_second.values(), default=0),
        "note": "Completion timestamps have one-second resolution; this is request-rate evidence, not exact in-flight concurrency.",
        "processStartedEpoch": round(process_started_wall, 3),
    }


def force_stop_tree(process: subprocess.Popen) -> None:
    try:
        root = psutil.Process(process.pid)
        children = root.children(recursive=True)
        for child in reversed(children):
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        try:
            root.terminate()
        except psutil.NoSuchProcess:
            pass
        _, alive = psutil.wait_procs([*children, root], timeout=5)
        for candidate in alive:
            try:
                candidate.kill()
            except psutil.NoSuchProcess:
                pass
    except psutil.NoSuchProcess:
        pass


def launch_case(label: str, targets: list[float], *, backend_only: bool) -> dict:
    if label == "packaged" and not PACKAGED_EXE.is_file():
        raise FileNotFoundError(PACKAGED_EXE)
    port = free_port()
    # WebView2 can retain its disposable BrowserMetrics file for a fraction of
    # a second after every owned process has exited.  That Windows-only lock
    # must not discard an otherwise complete 15-minute measurement report.
    with tempfile.TemporaryDirectory(
        prefix=f"worldmedia-phase0-{label}-",
        ignore_cleanup_errors=True,
    ) as temp:
        state = Path(temp) / "state"
        portable = Path(temp) / "portable"
        environment = os.environ.copy()
        environment.update({
            "WORLDMEDIA_WINDOWS_PORT": str(port),
            "WORLDMEDIA_STATE_ROOT": str(state),
            "WORLDMEDIA_PORTABLE_ROOT": str(portable),
        })
        if backend_only:
            environment["WORLDMEDIA_NO_BROWSER"] = "1"
        else:
            environment.pop("WORLDMEDIA_NO_BROWSER", None)
        command = [str(PACKAGED_EXE)] if label == "packaged" else [sys.executable, str(ROOT / "worldmedia_native.py")]
        process_started_wall = time.time()
        process_started = time.perf_counter()
        process = subprocess.Popen(
            command,
            cwd=PACKAGED_EXE.parent if label == "packaged" else ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        startup_seconds = None
        token = ""
        samples: list[dict] = []
        shutdown_seconds = None
        clean_shutdown = False
        try:
            startup_seconds, token = wait_healthy(process, port)
            root_process = psutil.Process(process.pid)
            for target in targets:
                remaining = target - (time.perf_counter() - process_started)
                if remaining > 0:
                    time.sleep(remaining)
                if process.poll() is not None:
                    raise RuntimeError(f"{label} exited before the {target}-second sample")
                samples.append(process_tree_snapshot(root_process, time.perf_counter() - process_started, port))

            before_shutdown = time.perf_counter()
            request_json(port, "/api/shutdown", method="POST", token=token)
            process.wait(timeout=20)
            shutdown_seconds = time.perf_counter() - before_shutdown
            clean_shutdown = process.returncode == 0
        finally:
            if process.poll() is None:
                force_stop_tree(process)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            # Stop every process owned by this isolated launch before reading
            # logs or allowing TemporaryDirectory cleanup.  This ordering also
            # guarantees a log-read error cannot strand a WebView/backend tree.
            log_summary = summarize_log(state / "logs" / "native.log", process_started_wall)

        return {
            "mode": label,
            "backendOnly": backend_only,
            "port": port,
            "startupHealthSeconds": round(startup_seconds or 0, 3),
            "samples": samples,
            "requestLog": log_summary,
            "shutdownSeconds": round(shutdown_seconds or 0, 3),
            "cleanShutdown": clean_shutdown,
            "uiMetrics": {
                "available": False,
                "firstCardMs": None,
                "domCardCount": None,
                "scrollFrameP95Ms": None,
                "searchLatencyMs": None,
                "reason": "Requires the supported Browser or Computer Use connection; proxy completion is not substituted.",
            },
        }


def parse_targets(value: str) -> list[float]:
    targets = sorted({float(part.strip()) for part in value.split(",") if part.strip()})
    if not targets or targets[0] <= 0:
        raise argparse.ArgumentTypeError("targets must be positive comma-separated seconds")
    return targets


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("source", "packaged", "both"), default="both")
    parser.add_argument("--targets", type=parse_targets, default=parse_targets("60,300,900"),
                        help="elapsed sampling seconds (default: 60,300,900)")
    parser.add_argument("--backend-only", action="store_true",
                        help="measure the local backend without creating WebView2")
    args = parser.parse_args()
    if os.environ.get("WORLDMEDIA_PHASE0_BASELINE") != "1":
        print("Set WORLDMEDIA_PHASE0_BASELINE=1 to run the isolated baseline.")
        return 2

    labels = [args.mode] if args.mode != "both" else ["source", "packaged"]
    report = {
        "schemaVersion": 1,
        "captured": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "targetsSeconds": args.targets,
        "cases": [launch_case(label, args.targets, backend_only=args.backend_only) for label in labels],
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if all(case["cleanShutdown"] for case in report["cases"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
