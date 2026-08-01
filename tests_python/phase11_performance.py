"""Opt-in Phase 11 resource benchmark; excluded from unittest discovery."""
from __future__ import annotations

import http.client
import json
import os
import statistics
import subprocess
import sys
import threading
import time
import tracemalloc
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import psutil

import worldmedia_server
from tests_python.fixture_server import LARGE_BYTES, MediaFixtureServer
from tests_python.test_recording_integration import RealRecordingIntegrationTests
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_recording import RecordingService


def percentile(values: list[float], percentage: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * percentage) - 1))
    return ordered[index]


def relay_benchmark() -> dict:
    old_registry = worldmedia_server.MEDIA_REGISTRY
    registry = MediaRegistry(
        SafeConnector(address_policy=lambda _address: True, idle_timeout=5), ttl_seconds=120,
    )
    worldmedia_server.MEDIA_REGISTRY = registry
    relay = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
    relay_thread = threading.Thread(target=relay.serve_forever, daemon=True)
    relay_thread.start()
    latencies: list[float] = []
    total = 0
    try:
        with MediaFixtureServer() as fixture:
            registration = registry.register({
                "item_id": "phase11:relay-memory", "url": f"{fixture.base_url}/media/large.bin",
                "delivery": "on-demand", "media_type": "video", "capture_headers": {},
                "title": "Phase 11 relay memory", "source": "internet-archive",
                "download_name": "large.bin",
            })
            origin = f"http://127.0.0.1:{relay.server_port}"
            tracemalloc.start()
            baseline, _peak = tracemalloc.get_traced_memory()
            started = time.perf_counter()
            # Transfer 64 MiB without ever retaining a response body.
            for _index in range(64):
                with urllib.request.urlopen(origin + registration.public_data()["relay_url"], timeout=10) as response:
                    while chunk := response.read(64 * 1024):
                        total += len(chunk)
            elapsed = time.perf_counter() - started
            _current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()

            for _index in range(40):
                before = time.perf_counter()
                connection = http.client.HTTPConnection("127.0.0.1", relay.server_port, timeout=3)
                connection.request("GET", "/api/health")
                response = connection.getresponse()
                response.read()
                connection.close()
                if response.status != 200:
                    raise AssertionError(f"health response {response.status}")
                latencies.append((time.perf_counter() - before) * 1000)
    finally:
        registry.clear()
        relay.shutdown(); relay.server_close(); relay_thread.join(timeout=2)
        worldmedia_server.MEDIA_REGISTRY = old_registry

    peak_growth = peak - baseline
    if total != len(LARGE_BYTES) * 64:
        raise AssertionError(f"relay transferred {total} bytes")
    if peak_growth > 16 * 1024 * 1024:
        raise AssertionError(f"relay peak grew by {peak_growth} bytes")
    p95 = percentile(latencies, 0.95)
    if p95 > 200:
        raise AssertionError(f"local control p95 was {p95:.2f} ms")
    return {
        "bytes": total,
        "seconds": round(elapsed, 3),
        "throughput_mib_s": round(total / elapsed / (1024 * 1024), 2),
        "tracemalloc_peak_growth_mib": round(peak_growth / (1024 * 1024), 3),
        "control_latency_p95_ms": round(p95, 3),
    }


class TrackingPopen:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.processes: list[psutil.Process] = []

    def __call__(self, *args, **kwargs):
        process = subprocess.Popen(*args, **kwargs)
        tracked = psutil.Process(process.pid)
        tracked.cpu_percent(None)
        with self.lock:
            self.processes.append(tracked)
        return process

    def snapshot(self) -> list[psutil.Process]:
        with self.lock:
            return list(self.processes)


def recording_benchmark() -> dict:
    suite = RealRecordingIntegrationTests
    suite.setUpClass()
    case = suite("test_hls_video_profiles_finalize_h264_aac_mp4_without_upscaling")
    case.setUp()
    tracker = TrackingPopen()
    case.service = RecordingService(
        case.registry, case.jobs, case.service.ffmpeg, case.paths,
        popen=tracker, utility_popen=tracker,
    )
    cpu_samples: list[float] = []
    latencies: list[float] = []
    stop = threading.Event()

    def sample() -> None:
        while not stop.wait(0.2):
            total_cpu = 0.0
            for process in tracker.snapshot():
                try:
                    total_cpu += process.cpu_percent(None)
                except (psutil.NoSuchProcess, psutil.ZombieProcess):
                    pass
            if total_cpu:
                cpu_samples.append(total_cpu)
            before = time.perf_counter()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{case.relay.server_port}/api/health", timeout=2,
                ) as response:
                    response.read()
                latencies.append((time.perf_counter() - before) * 1000)
            except OSError:
                pass

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        status = case.run_recording("video", "balanced")
    finally:
        stop.set(); sampler.join(2)
        case.service.shutdown(timeout=10)
        case.tearDown()
        suite.tearDownClass()

    if status["state"] != "completed" or not cpu_samples or not latencies:
        raise AssertionError("recording benchmark did not collect a completed sample")
    logical_cpus = max(1, psutil.cpu_count(logical=True) or 1)
    average = statistics.fmean(cpu_samples)
    peak = max(cpu_samples)
    p95 = percentile(latencies, 0.95)
    if p95 > 250:
        raise AssertionError(f"control p95 during recording was {p95:.2f} ms")
    return {
        "ffmpeg_cpu_average_percent": round(average, 2),
        "ffmpeg_cpu_peak_percent": round(peak, 2),
        "normalized_average_percent": round(average / logical_cpus, 2),
        "normalized_peak_percent": round(peak / logical_cpus, 2),
        "control_latency_during_recording_p95_ms": round(p95, 3),
        "samples": len(cpu_samples),
    }


def main() -> int:
    if os.environ.get("WORLDMEDIA_PHASE11_PERFORMANCE") != "1":
        print("Set WORLDMEDIA_PHASE11_PERFORMANCE=1 to run the resource benchmark.")
        return 2
    report = {
        "relay": relay_benchmark(),
        "recording": recording_benchmark(),
        "eq": {
            "idle_contexts": 0,
            "rapid_updates": 5000,
            "limit_ms": 1000,
            "evidence": "tests/audio-engine.test.js",
        },
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
