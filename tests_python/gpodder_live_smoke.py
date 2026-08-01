"""Opt-in, metadata-only gPodder/publisher-feed live smoke.

This file is deliberately excluded from unittest discovery.  It requires an
explicit flag and a disposable state root below this repository's ``build``
directory so it can never read or migrate the desktop WebView profile that
contains the user's favorites.
"""
from __future__ import annotations

import concurrent.futures
import contextlib
import json
import os
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Iterator, Mapping


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_STATE_PARENT = (ROOT / "build").resolve()
SEARCH_URL = "https://gpodder.net/search.json?q=science"
MAX_CANDIDATES = 4

# Direct script execution starts with tests_python/ on sys.path.  Add only the
# repository root so the smoke imports the production modules beside it.
sys.path.insert(0, str(ROOT))


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


class _ConcurrencyTracker:
    """Record the bounded live probe without exposing provider URLs."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._host_gates: dict[str, threading.Semaphore] = {}
        self._active_global = 0
        self._active_hosts: dict[str, int] = {}
        self.max_global = 0
        self.max_per_host = 0

    @contextlib.contextmanager
    def slot(self, host: str) -> Iterator[None]:
        with self._lock:
            gate = self._host_gates.setdefault(host, threading.Semaphore(1))
        gate.acquire()
        with self._lock:
            self._active_global += 1
            self._active_hosts[host] = self._active_hosts.get(host, 0) + 1
            self.max_global = max(self.max_global, self._active_global)
            self.max_per_host = max(self.max_per_host, self._active_hosts[host])
        try:
            yield
        finally:
            with self._lock:
                self._active_global -= 1
                remaining = self._active_hosts.get(host, 1) - 1
                if remaining:
                    self._active_hosts[host] = remaining
                else:
                    self._active_hosts.pop(host, None)
            gate.release()


def _directory_policy(target: Any) -> bool:
    return (
        target.scheme == "https"
        and target.host in {"gpodder.net", "www.gpodder.net"}
        and target.port == 443
    )


def _candidate_feeds(payload: Any, canonical_http_url: Any) -> list[tuple[str, str]]:
    if not isinstance(payload, list) or len(payload) > 10_000:
        raise RuntimeError("gPodder search returned an invalid result collection")
    candidates: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in payload[:100]:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("url"), str):
            continue
        try:
            url = canonical_http_url(raw["url"])
            host = (urllib.parse.urlsplit(url).hostname or "").lower()
        except Exception:
            continue
        if not host or url in seen:
            continue
        seen.add(url)
        candidates.append((url, host))
        if len(candidates) >= MAX_CANDIDATES:
            break
    return candidates


def main() -> int:
    if os.environ.get("WORLDMEDIA_GPODDER_LIVE") != "1":
        print("Set WORLDMEDIA_GPODDER_LIVE=1 to run this opt-in public-network smoke.")
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

    # Imports stay below the state guard.  These production boundaries do not
    # use the WebView profile; CatalogService receives the isolated cache path.
    from worldmedia_catalog import BoundedFetcher, CatalogService, canonical_http_url
    from worldmedia_media import SafeConnector
    from worldmedia_security import ApiError

    directory_connector = SafeConnector(target_policy=_directory_policy)
    fetched = BoundedFetcher(directory_connector).fetch(
        SEARCH_URL,
        accept="application/json",
        allowed_types={"application/json"},
        max_compressed=2 * 1024 * 1024,
        max_decoded=2 * 1024 * 1024,
    )
    try:
        directory_payload = json.loads(fetched.data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("gPodder search returned invalid JSON") from error
    candidates = _candidate_feeds(directory_payload, canonical_http_url)
    if not candidates:
        raise RuntimeError("gPodder search produced no valid candidate feed URLs")

    service = CatalogService(state_root / "catalog-cache")
    tracker = _ConcurrencyTracker()

    def resolve(index: int, url: str, host: str) -> dict[str, Any]:
        started = time.monotonic()
        try:
            with tracker.slot(host):
                feed = service.resolve_feed({"url": url})
            items = feed.get("items") if isinstance(feed, Mapping) else None
            return {
                "candidate": index,
                "host": host[:253],
                "ok": True,
                "episodes": len(items) if isinstance(items, list) else 0,
                "cache": str(feed.get("cache", {}).get("state", ""))[:24],
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }
        except ApiError as error:
            return {
                "candidate": index,
                "host": host[:253],
                "ok": False,
                "error": error.code,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }
        except (OSError, ValueError) as error:
            return {
                "candidate": index,
                "host": host[:253],
                "ok": False,
                "error": type(error).__name__,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CANDIDATES) as executor:
            futures = [
                executor.submit(resolve, index, url, host)
                for index, (url, host) in enumerate(candidates, start=1)
            ]
            results = [future.result() for future in futures]
    finally:
        stopped = service.shutdown(timeout=35)

    successful = [result for result in results if result.get("ok")]
    episode_count = sum(int(result.get("episodes", 0)) for result in successful)
    report = {
        "candidate_cap": MAX_CANDIDATES,
        "candidate_feeds": len(candidates),
        "directory_results": min(len(directory_payload), 10_000),
        "episode_metadata": episode_count,
        "feed_failures": len(results) - len(successful),
        "feed_successes": len(successful),
        "isolated_state": True,
        "max_global_feed_concurrency": tracker.max_global,
        "max_per_host_feed_concurrency": tracker.max_per_host,
        "no_episode_media_download": True,
        "results": results,
        "service_stopped": stopped,
    }
    print(json.dumps(report, sort_keys=True))
    return 0 if (
        successful
        and episode_count > 0
        and tracker.max_global <= 4
        and tracker.max_per_host <= 1
        and stopped
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
