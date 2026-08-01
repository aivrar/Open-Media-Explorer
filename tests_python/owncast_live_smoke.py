"""Opt-in real Owncast directory, relay, playback-probe, and recording smoke.

Excluded from unittest discovery. The caller must supply an isolated state root
below this repository's build directory, so the desktop WebView profile and its
favorites are never opened, migrated, or cleared.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_STATE_PARENT = (ROOT / "build").resolve()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server
from worldmedia_catalog import CatalogService
from worldmedia_ffmpeg import ToolStatus
from worldmedia_jobs import JobError, JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector, media_relay_path
from worldmedia_recording import RecordingService
from worldmedia_runtime import get_runtime_paths


FFMPEG = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe.exe") or shutil.which("ffprobe")


class ActualToolService:
    def status(self) -> ToolStatus:
        return ToolStatus(
            state="ready", source="PATH", ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE, version="owncast-live-smoke",
        )


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _probe(url: str, timeout: float = 12) -> dict[str, Any] | None:
    try:
        result = subprocess.run([
            FFPROBE, "-v", "error", "-rw_timeout", "7000000", "-seekable", "0",
            "-analyzeduration", "8000000", "-probesize", "8000000",
            "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name",
            "-of", "json", url,
        ], check=False, capture_output=True, text=True, timeout=timeout, shell=False)
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout)
        return payload if isinstance(payload, dict) else None
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def _wait_recording(jobs: JobRegistry, job_id: str, timeout: float = 55) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    stop_at: float | None = None
    while time.monotonic() < deadline:
        status = jobs.snapshot(job_id)
        if status["state"] == "running" and stop_at is None:
            stop_at = time.monotonic() + 3
        if stop_at is not None and time.monotonic() >= stop_at and status["state"] == "running":
            try:
                jobs.request_stop(job_id)
            except JobError:
                pass
            stop_at = None
        if status["state"] in {"completed", "failed", "cancelled"}:
            return status
        time.sleep(0.1)
    raise TimeoutError(job_id)


def main() -> int:
    if os.environ.get("WORLDMEDIA_OWNCAST_LIVE") != "1":
        print("Set WORLDMEDIA_OWNCAST_LIVE=1 to run this opt-in public-network smoke.")
        return 2
    raw_state = os.environ.get("WORLDMEDIA_STATE_ROOT", "").strip()
    if not raw_state:
        print("WORLDMEDIA_STATE_ROOT must name a disposable directory below build/.")
        return 2
    state_root = Path(raw_state).resolve()
    if state_root == ALLOWED_STATE_PARENT or not _inside(state_root, ALLOWED_STATE_PARENT):
        print("Refusing to run outside a disposable child of the repository build directory.")
        return 2
    if not FFMPEG or not FFPROBE:
        print("FFmpeg and ffprobe must be available on PATH.")
        return 2
    state_root.mkdir(parents=True, exist_ok=True)

    catalog = CatalogService(state_root / "catalog-cache")
    old_registry = worldmedia_server.MEDIA_REGISTRY
    registry = MediaRegistry(SafeConnector(idle_timeout=15), ttl_seconds=600)
    jobs = JobRegistry()
    paths = get_runtime_paths(
        portable=state_root / "portable",
        state=state_root / "state",
    )
    recorder = RecordingService(registry, jobs, ActualToolService(), paths)
    worldmedia_server.MEDIA_REGISTRY = registry
    relay = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
    relay_thread = threading.Thread(target=relay.serve_forever, daemon=True)
    relay_thread.start()
    report: dict[str, Any] = {
        "isolated_state": True,
        "favorites_profile_opened": False,
        "directory": {},
        "playback": {},
        "recording": {},
        "unreachable": {},
    }
    catalog_stopped = False
    recorder_stopped = False
    try:
        first = catalog.owncast_snapshot()
        items = first.get("items", [])
        safe = [item for item in items if item.get("nsfw") is False]
        explicit = [item for item in items if item.get("nsfw") is True]
        report["directory"] = {
            "items": len(items),
            "safe": len(safe),
            "explicit": len(explicit),
            "cache_state": first.get("cache", {}).get("state", ""),
            "all_rated": all(
                item.get("content_rating") in {"explicit", "not-explicit"}
                and isinstance(item.get("nsfw"), bool)
                for item in items
            ),
        }
        origin = f"http://127.0.0.1:{relay.server_port}"
        selected = None
        selected_probe = None
        selected_registration = None
        failures: list[str] = []
        for index, item in enumerate(safe[:20]):
            try:
                registration = registry.register({
                    "item_id": f"owncast:live-smoke:{index}",
                    "url": item["stream_url"],
                    "delivery": "live",
                    "media_type": "hls",
                    "recording_kind": "video",
                    "capture_headers": {},
                    "title": str(item.get("stream_title") or item.get("name") or "Owncast")[:512],
                    "source": "owncast",
                    "download_name": "",
                })
                probe = _probe(f"{origin}{media_relay_path(registration)}")
                if not probe or not any(
                    stream.get("codec_type") == "video" for stream in probe.get("streams", [])
                ):
                    failures.append("NO_RELAY_VIDEO")
                    registry.expire(registration.token)
                    continue
                selected = item
                selected_probe = probe
                selected_registration = registration
                break
            except Exception as error:  # report bounded current-provider failure
                failures.append(str(getattr(error, "code", type(error).__name__))[:80])
        report["playback"] = {
            "reachable": selected is not None,
            "attempts": min(len(safe), 20),
            "failures": failures,
            "instance": selected.get("instance_url", "") if selected else "",
            "probe": selected_probe or {},
        }
        if selected_registration is not None:
            status = _wait_recording(
                jobs,
                recorder.start(selected_registration.token, "compact", origin)["id"],
            )
            output = Path(status.get("output_path") or "")
            output_probe = _probe(str(output), timeout=20) if output.is_file() else None
            report["recording"] = {
                "state": status["state"],
                "bytes": output.stat().st_size if output.is_file() else 0,
                "suffix": output.suffix if output.is_file() else "",
                "probe": output_probe or {},
            }

        unreachable_failed = False
        try:
            unreachable = registry.register({
                "item_id": "owncast:unreachable-smoke",
                "url": "https://unreachable.invalid/hls/stream.m3u8",
                "delivery": "live",
                "media_type": "hls",
                "recording_kind": "video",
                "capture_headers": {},
                "title": "Unreachable Owncast smoke",
                "source": "owncast",
                "download_name": "",
            })
            unreachable_failed = _probe(f"{origin}{media_relay_path(unreachable)}", timeout=8) is None
        except Exception:
            unreachable_failed = True
        after_failure = catalog.owncast_snapshot()
        report["unreachable"] = {
            "failed_cleanly": unreachable_failed,
            "snapshot_still_available": isinstance(after_failure.get("items"), list),
        }
    finally:
        recorder_stopped = recorder.shutdown(timeout=15)
        jobs.shutdown(timeout=3)
        registry.clear()
        relay.shutdown()
        relay.server_close()
        relay_thread.join(timeout=3)
        worldmedia_server.MEDIA_REGISTRY = old_registry
        catalog_stopped = catalog.shutdown(timeout=35)
        report["recorder_stopped"] = recorder_stopped
        report["catalog_stopped"] = catalog_stopped
        report["relay_stopped"] = not relay_thread.is_alive()
        report["workers_remaining"] = len(recorder._workers)

    print(json.dumps(report, sort_keys=True))
    recorded = report["recording"].get("state") == "completed"
    recording_has_video = any(
        stream.get("codec_type") == "video"
        for stream in report["recording"].get("probe", {}).get("streams", [])
    )
    return 0 if (
        report["directory"].get("items", 0) > 0
        and report["directory"].get("all_rated") is True
        and report["playback"].get("reachable") is True
        and recorded and recording_has_video
        and report["unreachable"].get("failed_cleanly") is True
        and report["unreachable"].get("snapshot_still_available") is True
        and recorder_stopped and catalog_stopped and report["relay_stopped"]
        and report["workers_remaining"] == 0
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
