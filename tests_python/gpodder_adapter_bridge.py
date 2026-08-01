"""Test-only JSON bridge from defended production podcast parser to JS adapter."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from worldmedia_catalog import ApiError, attach_podcast_identities, parse_podcast_feed  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "five-new-sources"
ALLOWED = {
    "podcast-atom.xml",
    "podcast-explicit.xml",
    "podcast-live.xml",
    "podcast-malformed.xml",
    "podcast-malicious.xml",
    "podcast-rss.xml",
}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ALLOWED:
        print(json.dumps({"ok": False, "error": {"code": "INVALID_FIXTURE"}}))
        return 0
    name, requested = sys.argv[1], sys.argv[2]
    try:
        parsed = parse_podcast_feed((FIXTURES / name).read_bytes(), requested)
        value = attach_podcast_identities(parsed, requested, requested)
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
