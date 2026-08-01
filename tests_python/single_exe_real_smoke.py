"""Opt-in real download/recording smoke for the classic one-file EXE."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests_python.packaged_release_real_smoke import (
    Client,
    diagnose_managed_hls,
    finite_download,
    free_port,
    record_first_working,
)
from tests_python.recording_real_smoke import radio_candidates


EXECUTABLE = ROOT / "dist" / "WorldMediaWindows.exe"


def main() -> int:
    if os.environ.get("WORLDMEDIA_SINGLE_EXE_INTEGRATION") != "1":
        print("Set WORLDMEDIA_SINGLE_EXE_INTEGRATION=1 to run the one-file smoke.")
        return 2
    if not EXECUTABLE.is_file():
        raise FileNotFoundError(EXECUTABLE)

    result: dict = {}
    process: subprocess.Popen | None = None
    with tempfile.TemporaryDirectory(prefix="worldmedia-single-exe-") as temporary:
        temporary_root = Path(temporary)
        portable_root = temporary_root / "portable"
        state_root = temporary_root / "state"
        portable_root.mkdir()
        environment = os.environ.copy()
        port = free_port()
        environment.update({
            "WORLDMEDIA_NO_BROWSER": "1",
            "WORLDMEDIA_WINDOWS_PORT": str(port),
            "WORLDMEDIA_PORTABLE_ROOT": str(portable_root),
            "WORLDMEDIA_STATE_ROOT": str(state_root),
        })
        process = subprocess.Popen(
            [str(EXECUTABLE)], cwd=EXECUTABLE.parent, env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        client = Client(port)
        try:
            client.connect(timeout=45)
            tool = client.request("GET", "/api/v1/ffmpeg/status")
            if tool["state"] != "ready" or not tool.get("ffmpeg_path") or not tool.get("ffprobe_path"):
                raise AssertionError(f"one-file EXE did not discover a capable FFmpeg: {tool}")
            result["ffmpeg"] = {
                "source": tool["source"], "version": tool["version"],
                "managed": tool["managed"], "capabilities": tool["capabilities"],
            }
            hls_fixture = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
            result["hls_probe"] = diagnose_managed_hls(client, tool, hls_fixture)
            result["download"] = finite_download(client, portable_root)
            result["record_audio"] = record_first_working(
                client, portable_root, source="radio-browser", media_type="audio",
                expected_kind="audio", candidates=radio_candidates(),
            )
            result["record_video"] = record_first_working(
                client, portable_root, source="hls-test", media_type="hls",
                expected_kind="video", candidates=[hls_fixture],
            )
            leftovers = [
                str(path.relative_to(portable_root)) for path in portable_root.rglob("*")
                if path.is_file() and path.name.endswith((
                    ".part", ".working.mp4", ".finalizing.mp4",
                ))
            ]
            if leftovers:
                raise AssertionError(f"one-file smoke left partial output: {leftovers}")
            client.request("POST", "/api/shutdown", {})
            process.wait(timeout=20)
            result["shutdown"] = {
                "exit_code": process.returncode, "partials": 0, "listener_released": True,
            }
        finally:
            if process.poll() is None:
                try:
                    client.request("POST", "/api/shutdown", {})
                    process.wait(timeout=8)
                except Exception:
                    process.kill()
                    process.wait(timeout=5)
            if process.returncode not in {0, None}:
                log = state_root / "logs" / "native.log"
                detail = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
                raise AssertionError(f"one-file process exited {process.returncode}: {detail[-4000:]}")

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
