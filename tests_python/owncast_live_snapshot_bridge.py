"""Opt-in current Owncast snapshot bridge for the frontend live smoke."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_STATE_PARENT = (ROOT / "build").resolve()
sys.path.insert(0, str(ROOT))

from worldmedia_catalog import CatalogService  # noqa: E402


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def main() -> int:
    if os.environ.get("WORLDMEDIA_OWNCAST_LIVE") != "1":
        print(json.dumps({"ok": False, "error": "LIVE_FLAG_REQUIRED"}))
        return 2
    state = Path(os.environ.get("WORLDMEDIA_STATE_ROOT", "")).resolve()
    if state == ALLOWED_STATE_PARENT or not _inside(state, ALLOWED_STATE_PARENT):
        print(json.dumps({"ok": False, "error": "ISOLATED_STATE_REQUIRED"}))
        return 2
    state.mkdir(parents=True, exist_ok=True)
    service = CatalogService(state / "catalog-cache")
    try:
        value = service.owncast_snapshot()
    finally:
        stopped = service.shutdown(timeout=35)
    print(json.dumps({"ok": bool(stopped), "value": value, "service_stopped": stopped}))
    return 0 if stopped else 1


if __name__ == "__main__":
    raise SystemExit(main())
