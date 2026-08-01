"""Opt-in real public-source finite download smoke; excluded from unit discovery."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev_environment import configure_local_cache


configure_local_cache()

from worldmedia_downloads import DownloadService
from worldmedia_jobs import JobRegistry
from worldmedia_media import MediaRegistry, SafeConnector
from worldmedia_runtime import get_runtime_paths


SAMPLES = (
    {
        "source": "internet-archive", "title": "Health: Your Posture", "media_type": "video",
        "name": "HealthYo1953.mp4", "magic": b"ftyp",
        "url": "https://archive.org/download/HealthYo1953/HealthYo1953.mp4",
    },
    {
        "source": "nasa", "title": "CHAPEA 2 Audio Log 1", "media_type": "audio",
        "name": "Ep411_CHAPEA_2_AudioLog_1~orig.mp3", "magic": None,
        "url": "https://images-assets.nasa.gov/audio/Ep411_CHAPEA_2_AudioLog_1/"
               "Ep411_CHAPEA_2_AudioLog_1~orig.mp3",
    },
    {
        "source": "wikimedia", "title": "John Hossack speech", "media_type": "audio",
        "name": "Speech_of_John_Hossack.ogg", "magic": b"OggS",
        "url": "https://upload.wikimedia.org/wikipedia/commons/7/7e/"
               "Speech_of_John_Hossack_by_John_Hossack_as_read_by_Veronica_Jenkins_for_LibriVox_%282011%29.ogg",
    },
    {
        "source": "librivox", "title": "Count of Monte Cristo chapter 1", "media_type": "audio",
        "name": "count_of_monte_cristo_001_dumas_64kb.mp3", "magic": None,
        "url": "https://www.archive.org/download/count_monte_cristo_0711_librivox/"
               "count_of_monte_cristo_001_dumas_64kb.mp3",
    },
)


def wait(jobs: JobRegistry, job_id: str, timeout: float = 300) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = jobs.snapshot(job_id)
        if status["state"] in {"completed", "failed", "cancelled"}:
            return status
        time.sleep(0.1)
    raise TimeoutError(job_id)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if os.environ.get("WORLDMEDIA_DOWNLOAD_INTEGRATION") != "1":
        print("Set WORLDMEDIA_DOWNLOAD_INTEGRATION=1 to download the public samples.")
        return 2
    results = []
    with tempfile.TemporaryDirectory(prefix="worldmedia-download-integration-") as temporary:
        base = Path(temporary)
        paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        registry = MediaRegistry(SafeConnector(idle_timeout=30), ttl_seconds=600)
        jobs = JobRegistry(max_downloads=2)
        service = DownloadService(registry, jobs, paths)
        for sample in SAMPLES:
            registration = registry.register({
                "item_id": f"{sample['source']}:real-smoke", "url": sample["url"],
                "delivery": "on-demand", "media_type": sample["media_type"],
                "capture_headers": {}, "title": sample["title"],
                "source": sample["source"], "download_name": sample["name"],
            })
            status = wait(jobs, service.start(registration.token)["id"])
            if status["state"] != "completed":
                print(json.dumps({"source": sample["source"], "status": status}, sort_keys=True))
                return 1
            output = Path(status["output_path"])
            head = output.read_bytes()[:16]
            if sample["magic"] and sample["magic"] not in head:
                raise AssertionError(f"{sample['source']} magic mismatch")
            if output.stat().st_size != status["bytes_written"] or output.stat().st_size <= 0:
                raise AssertionError(f"{sample['source']} size mismatch")
            results.append({
                "source": sample["source"], "bytes": output.stat().st_size,
                "suffix": output.suffix, "sha256": sha256_file(output),
            })
        if any(paths.downloads_root.glob("*.part")) or any(paths.downloads_root.glob(".*.part")):
            raise AssertionError("temporary downloads remained")
    print(json.dumps(results, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
