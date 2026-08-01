"""Opt-in real approved-provider install smoke; excluded from unit discovery."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from dev_environment import configure_local_cache


configure_local_cache()

from worldmedia_ffmpeg import install_managed, query_release_asset
from worldmedia_runtime import get_runtime_paths


def main() -> int:
    if os.environ.get("WORLDMEDIA_FFMPEG_INTEGRATION") != "1":
        print("Set WORLDMEDIA_FFMPEG_INTEGRATION=1 to run the real 160+ MiB install smoke.")
        return 2
    asset = query_release_asset()
    print(json.dumps({
        "release_id": asset.release_id,
        "asset_id": asset.asset_id,
        "name": asset.name,
        "size": asset.size,
        "digest": asset.digest,
    }, sort_keys=True))
    with tempfile.TemporaryDirectory(prefix="worldmedia-ffmpeg-integration-") as temporary:
        base = Path(temporary)
        paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        status, candidate, manifest = install_managed(paths, "portable")
        package = candidate.ffmpeg_path.parent.parent
        assertions = {
            "ready": status.state == "ready",
            "managed": status.managed,
            "ffmpeg": candidate.ffmpeg_path.is_file(),
            "ffprobe": candidate.ffprobe_path.is_file(),
            "license": any(path.is_file() for path in package.rglob("*LICENSE*")),
            "source": (package / "SOURCE.txt").is_file(),
            "manifest": (package / "manifest.json").is_file(),
            "digest": manifest.get("verified_digest") == asset.digest,
        }
        print(json.dumps({"version": status.version, "assertions": assertions}, sort_keys=True))
        if not all(assertions.values()):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
