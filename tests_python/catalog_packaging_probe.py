"""Source/one-file Phase 2 localhost gateway smoke; excluded from discovery."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


_ISOLATED_STATE = tempfile.TemporaryDirectory(prefix="worldmedia-phase2-package-")
os.environ.setdefault("WORLDMEDIA_STATE_ROOT", str(Path(_ISOLATED_STATE.name) / "state"))
os.environ.setdefault("WORLDMEDIA_PORTABLE_ROOT", str(Path(_ISOLATED_STATE.name) / "portable"))

import defusedxml  # noqa: E402  (state isolation must precede backend imports)
import worldmedia_catalog  # noqa: E402
import worldmedia_server  # noqa: E402
from tests_python.catalog_fixture_server import CatalogFixtureServer, PNG_1X1  # noqa: E402
from worldmedia_catalog import AssetRegistry, CatalogService  # noqa: E402
from worldmedia_media import SafeConnector  # noqa: E402


def _request(
    port: int,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    payload: dict | None = None,
) -> tuple[int, dict | bytes]:
    body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.putrequest(method, path, skip_host=True)
    connection.putheader("Host", f"127.0.0.1:{port}")
    for name, value in (headers or {}).items():
        connection.putheader(name, value)
    if body is not None:
        connection.putheader("Content-Length", str(len(body)))
    connection.endheaders(body)
    response = connection.getresponse()
    raw = response.read()
    status = response.status
    content_type = response.getheader("Content-Type", "")
    connection.close()
    return status, json.loads(raw) if content_type.startswith("application/json") else raw


def _expect(status: int, expected: int, payload: dict | bytes) -> dict | bytes:
    if status != expected:
        raise RuntimeError(f"localhost gateway returned {status}, expected {expected}: {payload!r}")
    return payload


def main() -> int:
    fixture_server = None
    gateway_server = None
    gateway_thread = None
    service = None
    assets = None
    try:
        fixture_server = CatalogFixtureServer()
        fixture_server.__enter__()

        def resolver(host: str, port: int):
            del host
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))]

        connector = SafeConnector(
            resolver=resolver,
            address_policy=lambda address: address == "127.0.0.1",
            connect_timeout=2,
            header_timeout=2,
            idle_timeout=2,
        )
        cache_root = Path(_ISOLATED_STATE.name) / "state" / "cache"
        service = CatalogService(cache_root, connector=connector)
        assets = AssetRegistry(cache_root, connector=connector)
        worldmedia_server.CATALOG_SERVICE = service
        worldmedia_server.ASSET_REGISTRY = assets

        gateway_server = worldmedia_server.ThreadingServer(
            ("127.0.0.1", 0), worldmedia_server.WorldMediaHandler
        )
        port = gateway_server.server_port
        gateway_thread = threading.Thread(target=gateway_server.serve_forever, daemon=True)
        gateway_thread.start()

        session_status, session_payload = _request(port, "GET", "/api/v1/session")
        session = _expect(session_status, 200, session_payload)
        if not isinstance(session, dict):
            raise RuntimeError("session response was not JSON")
        token = session["data"]["token"]
        origin = f"http://127.0.0.1:{port}"
        mutation_headers = {
            "Origin": origin,
            "X-WorldMedia-Token": token,
            "Content-Type": "application/json",
        }
        get_headers = {"X-WorldMedia-Token": token}

        status, payload = _request(
            port,
            "POST",
            "/api/v1/catalog/feed/resolve",
            headers=mutation_headers,
            payload={"url": fixture_server.base_url + "/feed.xml"},
        )
        feed = _expect(status, 200, payload)

        video_uuid = "11111111-1111-4111-8111-111111111111"
        status, payload = _request(
            port,
            "POST",
            "/api/v1/catalog/peertube/resolve",
            headers=mutation_headers,
            payload={
                "watch_url": f"http://video.example.test:{fixture_server.port}/videos/watch/{video_uuid}",
                "uuid": video_uuid,
            },
        )
        peer = _expect(status, 200, payload)

        playlist_url = f"http://directory.owncast.online:{fixture_server.port}/api/iptv"
        home_url = f"http://owncast.directory:{fixture_server.port}/api/home"
        with mock.patch.object(worldmedia_catalog, "OWNCAST_PLAYLIST_URL", playlist_url), mock.patch.object(
            worldmedia_catalog, "OWNCAST_HOME_URL", home_url
        ):
            status, payload = _request(
                port,
                "GET",
                "/api/v1/catalog/owncast/snapshot",
                headers=get_headers,
            )
        owncast = _expect(status, 200, payload)

        status, payload = _request(
            port,
            "POST",
            "/api/v1/assets/register",
            headers=mutation_headers,
            payload={
                "url": f"http://images.example.test:{fixture_server.port}/cover.png",
                "source_id": "gpodder",
                "item_id": "package-probe-cover",
            },
        )
        registration = _expect(status, 201, payload)
        if not isinstance(registration, dict):
            raise RuntimeError("asset registration response was not JSON")
        relay_url = registration["data"]["relay_url"]
        status, image = _request(port, "GET", relay_url)
        _expect(status, 200, image)

        if not all(isinstance(value, dict) and value.get("ok") for value in (feed, peer, owncast)):
            raise RuntimeError("one or more catalog gateway envelopes failed")
        result = {
            "defusedxml": defusedxml.__version__,
            "feed_title": feed["data"]["title"],
            "peertube_uuid": peer["data"]["uuid"],
            "owncast_items": len(owncast["data"]["items"]),
            "asset_sha256": hashlib.sha256(image).hexdigest() if isinstance(image, bytes) else "",
            "asset_matches": image == PNG_1X1,
            "transport": "localhost-control-and-upstream",
        }
        print(json.dumps(result, sort_keys=True))
        return 0 if (
            result["feed_title"] == "Fixture RSS Show"
            and result["peertube_uuid"] == video_uuid
            and result["owncast_items"] == 5
            and result["asset_matches"]
        ) else 1
    finally:
        if gateway_server is not None:
            gateway_server.shutdown()
            gateway_server.server_close()
        if gateway_thread is not None:
            gateway_thread.join(timeout=2)
        if service is not None:
            service.shutdown(timeout=2)
        if assets is not None:
            assets.shutdown(timeout=2)
        if fixture_server is not None:
            fixture_server.__exit__(None, None, None)
        _ISOLATED_STATE.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
