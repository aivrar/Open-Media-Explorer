"""Test-only JSON bridge from defended PeerTube detail normalizer to JS adapter."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from worldmedia_catalog import CatalogError, normalize_peertube_detail  # noqa: E402


FIXTURE = ROOT / "tests" / "fixtures" / "five-new-sources" / "peertube.json"
ALLOWED = {"vod", "live", "explicit", "private", "unpublished", "malformed"}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ALLOWED:
        print(json.dumps({"ok": False, "error": {"code": "INVALID_FIXTURE"}}))
        return 0
    name = sys.argv[1]
    detail = json.loads(FIXTURE.read_text(encoding="utf-8"))["originDetails"][name]
    uuid_value = detail.get("uuid")
    if not isinstance(uuid_value, str):
        uuid_value = "66666666-6666-4666-8666-666666666666"
    watch_url = detail.get("url")
    if not isinstance(watch_url, str) or not watch_url.startswith(("http://", "https://")):
        watch_url = f"https://video.example.org/videos/watch/{uuid_value}"
    try:
        value = normalize_peertube_detail(detail, watch_url, uuid_value)
        value["cache"] = {"state": "updated", "stale": False}
        print(json.dumps({"ok": True, "value": value}, ensure_ascii=False))
    except CatalogError as error:
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
