"""Opt-in, metadata-only SepiaSearch/PeerTube live smoke.

This file is deliberately excluded from unittest discovery. It requires an
explicit flag and a disposable state root below this repository's ``build``
directory, so it cannot read or migrate the desktop WebView profile that holds
the user's favorites.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_STATE_PARENT = (ROOT / "build").resolve()
INDEX_URL = "https://sepiasearch.org/api/v1/search/videos"
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
MAX_ORIGIN_ATTEMPTS = 4

sys.path.insert(0, str(ROOT))


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _directory_policy(target: Any) -> bool:
    return target.scheme == "https" and target.host == "sepiasearch.org" and target.port == 443


def _index_url(*, search: str = "", live: bool = False) -> str:
    query = {
        "start": "0",
        "count": "30",
        "sort": "-publishedAt",
        "includeScheduledLive": "false",
        "nsfw": "false",
    }
    if search:
        query["search"] = search
    if live:
        query["isLive"] = "true"
    return f"{INDEX_URL}?{urllib.parse.urlencode(query)}"


def _read_index(fetcher: Any, url: str) -> dict[str, Any]:
    fetched = fetcher.fetch(
        url,
        accept="application/json",
        allowed_types={"application/json"},
        max_compressed=4 * 1024 * 1024,
        max_decoded=4 * 1024 * 1024,
    )
    try:
        payload = json.loads(fetched.data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("SepiaSearch returned invalid JSON") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise RuntimeError("SepiaSearch returned an invalid result envelope")
    if len(payload["data"]) > 30:
        raise RuntimeError("SepiaSearch exceeded the requested result bound")
    return payload


def _candidates(payloads: list[Mapping[str, Any]], *, live: bool) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for payload in payloads:
        for raw in payload.get("data", []):
            if not isinstance(raw, Mapping) or raw.get("isLive") is not live:
                continue
            privacy = raw.get("privacy")
            if not isinstance(privacy, Mapping) or privacy.get("id") != 1:
                continue
            if raw.get("nsfw") is not False or raw.get("nsfwFlags", 0) != 0:
                continue
            uuid_value = raw.get("uuid")
            watch_url = raw.get("url")
            if not isinstance(uuid_value, str) or not UUID.fullmatch(uuid_value):
                continue
            if not isinstance(watch_url, str):
                continue
            parsed = urllib.parse.urlsplit(watch_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                continue
            identity = (watch_url, uuid_value.lower())
            if identity in seen:
                continue
            seen.add(identity)
            result.append(identity)
            if len(result) >= MAX_ORIGIN_ATTEMPTS:
                return result
    return result


def _resolve(service: Any, candidates: list[tuple[str, str]], *, live: bool) -> dict[str, Any]:
    failures: list[str] = []
    started = time.monotonic()
    for watch_url, uuid_value in candidates:
        try:
            detail = service.resolve_peertube({"watch_url": watch_url, "uuid": uuid_value})
            if detail.get("is_live") is not live or not detail.get("playback_url"):
                failures.append("NO_CURRENT_MEDIA")
                continue
            return {
                "resolved": True,
                "attempts": len(failures) + 1,
                "media_type": str(detail.get("media_type", ""))[:16],
                "download_enabled": bool(detail.get("download_enabled")),
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "failures": failures,
            }
        except Exception as error:  # live smoke reports bounded provider failures
            failures.append(str(getattr(error, "code", type(error).__name__))[:80])
    return {
        "resolved": False,
        "attempts": len(candidates),
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "failures": failures,
    }


def main() -> int:
    if os.environ.get("WORLDMEDIA_PEERTUBE_LIVE") != "1":
        print("Set WORLDMEDIA_PEERTUBE_LIVE=1 to run this opt-in public-network smoke.")
        return 2
    raw_state = os.environ.get("WORLDMEDIA_STATE_ROOT", "").strip()
    if not raw_state:
        print("WORLDMEDIA_STATE_ROOT must name a disposable directory below build/.")
        return 2
    state_root = Path(raw_state).resolve()
    if state_root == ALLOWED_STATE_PARENT or not _inside(state_root, ALLOWED_STATE_PARENT):
        print("Refusing to run outside a disposable child of the repository build directory.")
        return 2
    state_root.mkdir(parents=True, exist_ok=True)

    from worldmedia_catalog import BoundedFetcher, CatalogService
    from worldmedia_media import SafeConnector

    fetcher = BoundedFetcher(SafeConnector(target_policy=_directory_policy))
    browse = _read_index(fetcher, _index_url())
    search = _read_index(fetcher, _index_url(search="science"))
    live_index = _read_index(fetcher, _index_url(live=True))
    payloads = [browse, search, live_index]
    vod_candidates = _candidates(payloads, live=False)
    live_candidates = _candidates([live_index, browse, search], live=True)
    service = CatalogService(state_root / "catalog-cache")
    try:
        vod = _resolve(service, vod_candidates, live=False)
        live = _resolve(service, live_candidates, live=True)
    finally:
        stopped = service.shutdown(timeout=35)

    report = {
        "browse_results": len(browse["data"]),
        "search_results": len(search["data"]),
        "live_index_results": len(live_index["data"]),
        "vod_candidates": len(vod_candidates),
        "live_candidates": len(live_candidates),
        "vod": vod,
        "live": live,
        "isolated_state": True,
        "metadata_only": True,
        "service_stopped": stopped,
    }
    print(json.dumps(report, sort_keys=True))
    # A current live stream is inherently optional. If Sepia reports one, at
    # least one of the bounded candidates must survive origin revalidation.
    live_ok = not live_candidates or live.get("resolved") is True
    return 0 if (
        browse["data"]
        and search["data"]
        and vod.get("resolved") is True
        and live_ok
        and stopped
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
