"""Test-only bridge from defended Owncast M3U/rating join to the JS adapter."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from worldmedia_catalog import ApiError, normalize_owncast_snapshot  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "five-new-sources"


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"valid", "ratings-missing"}:
        print(json.dumps({"ok": False, "error": {"code": "INVALID_FIXTURE"}}))
        return 0
    playlist = (FIXTURES / "owncast-directory.m3u").read_bytes()
    home = (FIXTURES / "owncast-home.json").read_bytes()
    if sys.argv[1] == "ratings-missing":
        payload = json.loads(home)
        for section in payload.get("sections", []):
            for item in section.get("instances", []):
                item["nsfw"] = "false"
        if isinstance(payload.get("featured"), dict):
            payload["featured"]["nsfw"] = "false"
        home = json.dumps(payload).encode()
    try:
        value = normalize_owncast_snapshot(playlist, home)
        value["cache"] = {"state": "updated", "stale": False}
        print(json.dumps({"ok": True, "value": value}, ensure_ascii=False))
    except ApiError as error:
        print(json.dumps({
            "ok": False,
            "error": {
                "code": error.code,
                "message": str(error),
                "status": int(error.status),
                "retryable": bool(error.retryable),
            },
        }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
