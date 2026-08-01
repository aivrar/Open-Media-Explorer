"""Opt-in real Radio Browser/iptv-org recording smoke; excluded from discovery."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev_environment import configure_local_cache


configure_local_cache()

import worldmedia_server
from worldmedia_ffmpeg import ToolStatus
from worldmedia_jobs import JobError, JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_recording import RecordingService
from worldmedia_runtime import get_runtime_paths


FFMPEG = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe.exe") or shutil.which("ffprobe")
USER_AGENT = "WorldMediaWindows/0.1.2 recording integration"


class ActualToolService:
    def status(self) -> ToolStatus:
        return ToolStatus(
            state="ready", source="PATH", ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE, version="real-source-smoke",
        )


def fetch_text(url: str, timeout: float = 20) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def radio_candidates() -> list[str]:
    query = urllib.parse.urlencode({
        "hidebroken": "true", "limit": 40, "order": "clickcount", "reverse": "true",
    })
    data = json.loads(fetch_text(f"https://de1.api.radio-browser.info/json/stations/search?{query}"))
    return list(dict.fromkeys(
        value for station in data
        if isinstance(station, dict)
        for value in [station.get("url_resolved") or station.get("url")]
        if isinstance(value, str) and value.startswith(("http://", "https://"))
    ))


def iptv_candidates() -> list[str]:
    playlist = fetch_text("https://iptv-org.github.io/iptv/categories/news.m3u")
    return list(dict.fromkeys(
        line.strip() for line in playlist.splitlines()
        if line.strip().startswith(("http://", "https://")) and ".m3u8" in line.lower()
    ))


def direct_probe(url: str, expected_kind: str) -> bool:
    try:
        result = subprocess.run([
            FFPROBE, "-v", "error", "-rw_timeout", "6000000", "-seekable", "0",
            "-show_entries", "stream=codec_type", "-of", "json", url,
        ], check=False, capture_output=True, text=True, timeout=10, shell=False)
        streams = json.loads(result.stdout).get("streams", []) if result.returncode == 0 else []
        return any(stream.get("codec_type") == expected_kind for stream in streams)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return False


def wait_for_recording(jobs: JobRegistry, job_id: str, timeout: float = 45) -> dict:
    deadline = time.monotonic() + timeout
    stopped = False
    while time.monotonic() < deadline:
        status = jobs.snapshot(job_id)
        if status["state"] == "running" and not stopped:
            time.sleep(2)
            try:
                jobs.request_stop(job_id)
            except JobError:
                pass
            stopped = True
        if status["state"] in {"completed", "failed", "cancelled"}:
            return status
        time.sleep(0.1)
    raise TimeoutError(job_id)


def probe_output(path: Path) -> dict:
    result = subprocess.run([
        FFPROBE, "-v", "error", "-show_entries",
        "format=format_name,duration:stream=codec_type,codec_name,width,height,bit_rate",
        "-of", "json", str(path),
    ], check=False, capture_output=True, text=True, timeout=20, shell=False)
    if result.returncode != 0:
        raise AssertionError("A completed real recording did not pass ffprobe.")
    return json.loads(result.stdout)


def verify_windows_media_open(path: Path, expected_kind: str) -> None:
    if os.name != "nt":
        return
    script = r"""
& {
    $InputPath = [Environment]::GetEnvironmentVariable('WORLDMEDIA_MEDIA_CHECK_PATH')
    $ExpectedKind = [Environment]::GetEnvironmentVariable('WORLDMEDIA_MEDIA_CHECK_KIND')
    Add-Type -AssemblyName PresentationCore
    $media = [System.Windows.Media.MediaPlayer]::new()
    try {
        $media.Open([Uri]::new($InputPath))
        $ready = $false
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            if ($media.HasAudio -or $media.HasVideo) { $ready = $true; break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $ready) { exit 10 }
        if ($ExpectedKind -eq 'audio' -and -not $media.HasAudio) { exit 11 }
        if ($ExpectedKind -eq 'video' -and -not $media.HasVideo) { exit 12 }
    } finally {
        $media.Close()
    }
}
"""
    environment = os.environ.copy()
    environment["WORLDMEDIA_MEDIA_CHECK_PATH"] = str(path)
    environment["WORLDMEDIA_MEDIA_CHECK_KIND"] = expected_kind
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
        check=False, capture_output=True, text=True, timeout=20, shell=False, env=environment,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"Windows MediaPlayer could not open the {expected_kind} recording "
            f"(exit {result.returncode})."
        )


def record_first_working(
    source: str, media_type: str, expected_kind: str, profile: str, candidates: list[str],
    registry: MediaRegistry, jobs: JobRegistry, service: RecordingService, origin: str,
) -> dict:
    for index, url in enumerate(candidates[:30]):
        if not direct_probe(url, expected_kind):
            continue
        registration = registry.register({
            "item_id": f"{source}:real-smoke:{index}", "url": url,
            "delivery": "live", "media_type": media_type, "capture_headers": {},
            "title": f"{source} real recording", "source": source, "download_name": "",
        })
        status = wait_for_recording(jobs, service.start(registration.token, profile, origin)["id"])
        if status["state"] != "completed":
            continue
        output = Path(status["output_path"])
        probe = probe_output(output)
        kinds = {stream.get("codec_type") for stream in probe.get("streams", [])}
        if expected_kind not in kinds:
            continue
        try:
            verify_windows_media_open(output, expected_kind)
        except AssertionError:
            # A valid FFmpeg output may still use a codec/profile unavailable
            # to the installed Windows Media Foundation stack.  Continue to a
            # different current source; the exit gate requires both checks.
            continue
        return {
            "source": source, "profile": profile, "bytes": output.stat().st_size,
            "suffix": output.suffix, "ffprobe": probe,
            "windows_media_opened": True,
        }
    raise RuntimeError(f"No current {source} candidate passed the {profile} recording gate.")


def main() -> int:
    if os.environ.get("WORLDMEDIA_RECORDING_INTEGRATION") != "1":
        print("Set WORLDMEDIA_RECORDING_INTEGRATION=1 to record current public streams.")
        return 2
    if not FFMPEG or not FFPROBE:
        print("A capable FFmpeg/ffprobe pair must be available on PATH.")
        return 2

    old_registry = worldmedia_server.MEDIA_REGISTRY
    results = []
    with tempfile.TemporaryDirectory(prefix="worldmedia-recording-real-") as temporary:
        base = Path(temporary)
        paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        registry = MediaRegistry(SafeConnector(idle_timeout=15), ttl_seconds=600)
        jobs = JobRegistry()
        service = RecordingService(registry, jobs, ActualToolService(), paths)
        worldmedia_server.MEDIA_REGISTRY = registry
        relay = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        relay_thread = threading.Thread(target=relay.serve_forever, daemon=True)
        relay_thread.start()
        try:
            origin = f"http://127.0.0.1:{relay.server_port}"
            radio_urls = radio_candidates()
            iptv_urls = iptv_candidates()
            for profile in ("compact", "balanced", "high"):
                results.append(record_first_working(
                    "radio-browser", "audio", "audio", profile, radio_urls,
                    registry, jobs, service, origin,
                ))
                results.append(record_first_working(
                    "iptv-org", "hls", "video", profile, iptv_urls,
                    registry, jobs, service, origin,
                ))
        finally:
            service.shutdown(timeout=12)
            jobs.shutdown(timeout=2)
            registry.clear()
            relay.shutdown()
            relay.server_close()
            relay_thread.join(timeout=2)
            worldmedia_server.MEDIA_REGISTRY = old_registry
        if service._workers:
            raise AssertionError("A recording worker survived integration shutdown.")
    print(json.dumps(results, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
