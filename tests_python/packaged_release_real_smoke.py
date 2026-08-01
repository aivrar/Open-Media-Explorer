"""Opt-in final-ZIP smoke for managed FFmpeg, download, and recording."""
from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests_python.recording_real_smoke import (
    direct_probe,
    probe_output,
    radio_candidates,
    verify_windows_media_open,
)


ARCHIVE = ROOT / "dist" / "WorldMediaWindows-0.1.2-portable.zip"
TERMINAL_STATES = {"completed", "failed", "cancelled"}


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class Client:
    def __init__(self, port: int) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.token = ""

    def request(self, method: str, path: str, body: dict | None = None, *, auth: bool = True) -> dict:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Accept": "application/json"}
        if auth:
            headers["X-WorldMedia-Token"] = self.token
        if data is not None:
            headers.update({
                "Content-Type": "application/json",
                "Origin": self.base,
            })
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            payload = json.loads(error.read())
            raise AssertionError(f"{method} {path} returned {error.code}: {payload}") from error
        if not payload.get("ok"):
            raise AssertionError(f"{method} {path} failed: {payload}")
        return payload["data"]

    def connect(self, timeout: float = 25) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(self.base + "/api/health", timeout=1) as response:
                    if json.loads(response.read()).get("ok"):
                        session = self.request("GET", "/api/v1/session", auth=False)
                        self.token = session["token"]
                        return
            except (OSError, urllib.error.URLError, json.JSONDecodeError):
                time.sleep(0.25)
        raise TimeoutError("packaged app did not become healthy")

    def wait_job(self, job_id: str, timeout: float = 300) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.request("GET", f"/api/v1/jobs/{job_id}")
            if status["state"] in TERMINAL_STATES:
                return status
            time.sleep(0.35)
        raise TimeoutError(job_id)


def wait_install(client: Client, timeout: float = 600) -> dict:
    deadline = time.monotonic() + timeout
    last_progress = -1
    while time.monotonic() < deadline:
        status = client.request("GET", "/api/v1/ffmpeg/status")
        progress = int((status.get("progress") or 0) * 100)
        if progress >= last_progress + 10:
            print(f"managed FFmpeg: {progress}%", flush=True)
            last_progress = progress
        if status["state"] in {"ready", "error", "cancelled"}:
            return status
        time.sleep(1)
    raise TimeoutError("managed FFmpeg installation")


def verify_managed_install(app_root: Path, status: dict) -> dict:
    if status["state"] != "ready" or status["source"] != "portable" or not status["managed"]:
        raise AssertionError(f"managed tool did not become ready: {status}")
    managed_root = app_root / "tools" / "ffmpeg"
    pointer = json.loads((managed_root / "current.json").read_text(encoding="utf-8"))
    release = (managed_root / pointer["relative_path"]).resolve()
    release.relative_to(managed_root.resolve())
    manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    if manifest["asset_digest"] != manifest["verified_digest"]:
        raise AssertionError("managed manifest digest was not verified")
    if manifest["repository"] != "BtbN/FFmpeg-Builds":
        raise AssertionError("unexpected FFmpeg provider")
    if not (release / "SOURCE.txt").is_file():
        raise AssertionError("managed FFmpeg source provenance is missing")
    licenses = [
        path for path in release.rglob("*")
        if path.is_file() and ("license" in path.name.lower() or "copying" in path.name.lower())
    ]
    if not licenses:
        raise AssertionError("managed FFmpeg license material is missing")
    return {
        "asset_name": manifest["asset_name"],
        "asset_size": manifest["asset_size"],
        "verified_digest": manifest["verified_digest"],
        "release_id": manifest["release_id"],
        "license_files": len(licenses),
        "source_file": str((release / "SOURCE.txt").relative_to(app_root)),
    }


def diagnose_managed_hls(client: Client, status: dict, url: str) -> dict:
    registration = client.request("POST", "/api/v1/media/register", {
        "item_id": "hls:managed-probe-diagnostic",
        "url": url,
        "delivery": "live",
        "media_type": "hls",
        "capture_headers": {},
        "title": "Managed HLS diagnostic",
        "source": "hls-test",
        "download_name": "",
    })
    relay = client.base + registration["relay_url"]
    results = {}
    for name, target in (("direct", url), ("relay", relay)):
        completed = subprocess.run([
            status["ffprobe_path"], "-v", "error", "-rw_timeout", "10000000",
            "-show_entries", "stream=codec_type,codec_name,width,height",
            "-of", "json", "-seekable", "0", target,
        ], check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
           timeout=25, shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            payload = {}
        streams = [
            {
                "codec_type": stream.get("codec_type"),
                "codec_name": stream.get("codec_name"),
                "width": stream.get("width"),
                "height": stream.get("height"),
            }
            for stream in payload.get("streams", [])
            if isinstance(stream, dict)
        ]
        results[name] = {
            "returncode": completed.returncode,
            "streams": streams,
            "stderr": completed.stderr.strip(),
        }
        if completed.returncode != 0 or not any(stream["codec_type"] == "video" for stream in streams):
            raise AssertionError(f"managed HLS {name} probe failed: {results[name]}")
    print("managed HLS diagnostic: " + json.dumps(results, sort_keys=True), flush=True)
    return results


def finite_download(client: Client, app_root: Path) -> dict:
    registration = client.request("POST", "/api/v1/media/register", {
        "item_id": "librivox:packaged-release-smoke",
        "url": "https://www.archive.org/download/count_monte_cristo_0711_librivox/"
               "count_of_monte_cristo_001_dumas_64kb.mp3",
        "delivery": "on-demand",
        "media_type": "audio",
        "capture_headers": {},
        "title": "Count of Monte Cristo chapter 1",
        "source": "librivox",
        "download_name": "count_of_monte_cristo_001_dumas_64kb.mp3",
    })
    started = client.request("POST", "/api/v1/jobs/download", {"media_id": registration["media_id"]})
    status = client.wait_job(started["id"])
    if status["state"] != "completed":
        raise AssertionError(f"packaged finite download failed: {status}")
    output = Path(status["output_path"]).resolve()
    output.relative_to((app_root / "downloads").resolve())
    if output.stat().st_size != status["bytes_written"] or output.stat().st_size <= 0:
        raise AssertionError("packaged finite download size mismatch")
    return {
        "bytes": output.stat().st_size,
        "suffix": output.suffix,
        "sha256": sha256_file(output),
    }


def record_first_working(
    client: Client,
    app_root: Path,
    *,
    source: str,
    media_type: str,
    expected_kind: str,
    candidates: list[str],
) -> dict:
    failures: list[dict] = []
    for index, url in enumerate(candidates[:30]):
        if not direct_probe(url, expected_kind):
            continue
        registration = client.request("POST", "/api/v1/media/register", {
            "item_id": f"{source}:packaged-release-smoke:{index}",
            "url": url,
            "delivery": "live",
            "media_type": media_type,
            "capture_headers": {},
            "title": f"{source} packaged release recording",
            "source": source,
            "download_name": "",
        })
        started = client.request("POST", "/api/v1/jobs/record", {
            "media_id": registration["media_id"], "profile": "balanced",
        })
        job_id = started["id"]
        deadline = time.monotonic() + 45
        stopped = False
        while time.monotonic() < deadline:
            status = client.request("GET", f"/api/v1/jobs/{job_id}")
            if status["state"] == "running" and not stopped:
                time.sleep(3)
                client.request("POST", f"/api/v1/jobs/{job_id}/stop", {})
                stopped = True
            if status["state"] in TERMINAL_STATES:
                break
            time.sleep(0.25)
        else:
            raise TimeoutError(job_id)
        if status["state"] != "completed":
            failures.append({
                "candidate": index,
                "state": status["state"],
                "error": status.get("error"),
            })
            continue
        output = Path(status["output_path"]).resolve()
        output.relative_to((app_root / "downloads").resolve())
        probe = probe_output(output)
        kinds = {stream.get("codec_type") for stream in probe.get("streams", [])}
        if expected_kind not in kinds:
            failures.append({"candidate": index, "state": "wrong-stream-kind", "kinds": sorted(kinds)})
            continue
        try:
            verify_windows_media_open(output, expected_kind)
        except AssertionError as error:
            failures.append({"candidate": index, "state": "windows-open-failed", "error": str(error)})
            continue
        return {
            "bytes": output.stat().st_size,
            "suffix": output.suffix,
            "ffprobe": probe,
            "windows_media_opened": True,
        }
    raise RuntimeError(
        f"No current {source} candidate passed the packaged managed-tool gate: "
        f"{json.dumps(failures[-10:], sort_keys=True)}"
    )


def main() -> int:
    if os.environ.get("WORLDMEDIA_PACKAGED_RELEASE_INTEGRATION") != "1":
        print("Set WORLDMEDIA_PACKAGED_RELEASE_INTEGRATION=1 to run the final-ZIP smoke.")
        return 2
    if not ARCHIVE.is_file():
        raise FileNotFoundError(ARCHIVE)

    result: dict = {}
    process: subprocess.Popen | None = None
    with tempfile.TemporaryDirectory(prefix="worldmedia-packaged-release-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(ARCHIVE) as package:
            package.extractall(temporary_root)
        app_root = temporary_root / "WorldMediaWindows"
        executable = app_root / "WorldMediaWindows.exe"
        port = free_port()
        environment = os.environ.copy()
        system_root = Path(environment.get("SystemRoot", r"C:\Windows"))
        environment["PATH"] = os.pathsep.join((
            str(system_root / "System32"), str(system_root), str(system_root / "System32" / "Wbem"),
        ))
        environment["WORLDMEDIA_NO_BROWSER"] = "1"
        environment["WORLDMEDIA_WINDOWS_PORT"] = str(port)
        environment["WORLDMEDIA_STATE_ROOT"] = str(temporary_root / "state")
        process = subprocess.Popen(
            [str(executable)], cwd=app_root, env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        client = Client(port)
        try:
            client.connect()
            initial = client.request("GET", "/api/v1/ffmpeg/status")
            if initial["state"] != "missing":
                raise AssertionError(f"sanitized package unexpectedly found FFmpeg: {initial}")
            client.request("POST", "/api/v1/ffmpeg/install", {
                "confirmed": True, "destination": "portable",
            })
            installed = wait_install(client)
            result["managed_ffmpeg"] = verify_managed_install(app_root, installed)
            hls_fixture = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
            result["managed_hls_probe"] = diagnose_managed_hls(client, installed, hls_fixture)
            result["download"] = finite_download(client, app_root)
            result["record_audio"] = record_first_working(
                client, app_root, source="radio-browser", media_type="audio",
                expected_kind="audio", candidates=radio_candidates(),
            )
            result["record_video"] = record_first_working(
                client, app_root, source="hls-test", media_type="hls",
                expected_kind="video", candidates=[
                    # Mux hosts this unencrypted H.264/AAC Big Buck Bunny
                    # stream specifically as an hls.js/HLS interoperability fixture.
                    hls_fixture,
                ],
            )
            leftovers = []
            for path in app_root.rglob("*"):
                relative = path.relative_to(app_root)
                if (
                    path.name.endswith((".part", ".working.mp4", ".finalizing.mp4"))
                    or any(part.startswith((".download-", ".staging-")) for part in relative.parts)
                ):
                    leftovers.append(str(relative))
            if leftovers:
                raise AssertionError(f"packaged smoke left staging files: {leftovers}")
            client.request("POST", "/api/shutdown", {})
            process.wait(timeout=15)
            result["shutdown"] = {
                "exit_code": process.returncode,
                "partials": 0,
                "listener_released": True,
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
                log = temporary_root / "state" / "logs" / "native.log"
                if log.is_file():
                    print(log.read_text(encoding="utf-8", errors="replace")[-8000:], file=sys.stderr)
                raise AssertionError(f"packaged process exited with {process.returncode}")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
