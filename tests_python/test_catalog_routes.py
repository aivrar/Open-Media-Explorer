from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import unittest
from http import HTTPStatus
from unittest import mock


_ISOLATED_STATE = tempfile.TemporaryDirectory(prefix="worldmedia-phase2-routes-")
os.environ.setdefault("WORLDMEDIA_STATE_ROOT", _ISOLATED_STATE.name)

import worldmedia_server  # noqa: E402  (state isolation must precede import)
from worldmedia_catalog import AssetBlob, CatalogError  # noqa: E402


class FakeRegistration:
    def public_data(self):
        return {
            "asset_id": "opaque_asset_token_1234567890",
            "relay_url": "/api/v1/assets/opaque_asset_token_1234567890",
            "expires_at": 2_000_000_000,
        }


class CatalogRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = worldmedia_server.ThreadingServer(
            ("127.0.0.1", 0), worldmedia_server.WorldMediaHandler
        )
        cls.port = cls.server.server_port
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        response, payload = self.request("GET", "/api/v1/session")
        self.assertEqual(response.status, HTTPStatus.OK)
        self.token = payload["data"]["token"]

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        declared_length: int | None = None,
        include_host: bool = True,
    ):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, path, skip_host=True)
        if include_host:
            connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if declared_length is not None:
            connection.putheader("Content-Length", str(declared_length))
        elif body is not None and not any(name.lower() == "content-length" for name in (headers or {})):
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        raw = response.read()
        payload = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw
        connection.close()
        return response, payload

    def mutation_headers(self, **overrides: str) -> dict[str, str]:
        headers = {
            "Origin": self.origin,
            "X-WorldMedia-Token": self.token,
            "Content-Type": "application/json",
        }
        headers.update(overrides)
        return headers

    def get_headers(self, **overrides: str) -> dict[str, str]:
        headers = {"X-WorldMedia-Token": self.token}
        headers.update(overrides)
        return headers

    def assert_error(self, response, payload, status: int, code: str) -> None:
        self.assertEqual(response.status, status)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], code)

    def test_fixed_catalog_hosts_are_exact_and_dynamic_hosts_have_no_proxy_wildcards(self) -> None:
        expected = {
            "api.media.ccc.de", "media.ccc.de", "streaming.media.ccc.de",
            "www.loc.gov", "loc.gov", "gpodder.net", "www.gpodder.net", "sepiasearch.org",
        }
        self.assertTrue(expected.issubset(worldmedia_server.ALLOWED_HOSTS))
        self.assertNotIn("directory.owncast.online", worldmedia_server.ALLOWED_HOSTS)
        self.assertNotIn("owncast.directory", worldmedia_server.ALLOWED_HOSTS)
        self.assertEqual(worldmedia_server.ALLOWED_SUFFIXES, (".api.radio-browser.info", ".archive.org"))
        for dynamic in (
            "feeds.example.org", "video.example.org", "cdn.example.org",
            "safe.example.org", "images.example.org",
        ):
            self.assertFalse(worldmedia_server.is_allowed_host(dynamic))

    def test_auth_method_type_and_route_body_limits_precede_catalog_outbound_work(self) -> None:
        catalog = mock.Mock()
        catalog.resolve_feed.return_value = {"title": "fixture"}
        catalog.resolve_peertube.return_value = {"uuid": "fixture"}
        catalog.owncast_snapshot.return_value = {"items": []}
        catalog.clear_cache.return_value = {"catalog_records_removed": 2}
        assets = mock.Mock()
        assets.clear_cache.return_value = 3
        assets.register.return_value = FakeRegistration()

        with mock.patch.object(worldmedia_server, "CATALOG_SERVICE", catalog), mock.patch.object(
            worldmedia_server, "ASSET_REGISTRY", assets
        ):
            body = b'{"url":"https://feeds.example/show.xml"}'
            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve",
                headers={"Origin": self.origin, "Content-Type": "application/json"}, body=body,
            )
            self.assert_error(response, payload, 403, "INVALID_TOKEN")
            catalog.resolve_feed.assert_not_called()

            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve",
                headers=self.mutation_headers(Origin="https://evil.example"), body=body,
            )
            self.assert_error(response, payload, 403, "INVALID_ORIGIN")
            catalog.resolve_feed.assert_not_called()

            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve",
                headers={
                    "Origin": self.origin,
                    "X-WorldMedia-Token": self.token,
                    "Content-Type": "text/plain",
                },
                body=body,
            )
            self.assert_error(response, payload, 415, "JSON_REQUIRED")
            catalog.resolve_feed.assert_not_called()

            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve",
                headers=self.mutation_headers(), declared_length=12 * 1024 + 1,
            )
            self.assert_error(response, payload, 413, "BODY_TOO_LARGE")
            catalog.resolve_feed.assert_not_called()

            response, payload = self.request(
                "GET", "/api/v1/catalog/feed/resolve", headers=self.get_headers()
            )
            self.assert_error(response, payload, 405, "METHOD_NOT_ALLOWED")
            catalog.resolve_feed.assert_not_called()

            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve", headers=self.mutation_headers(), body=body,
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["data"]["title"], "fixture")
            catalog.resolve_feed.assert_called_once_with({"url": "https://feeds.example/show.xml"})

            catalog.resolve_feed.side_effect = CatalogError(
                429, "CATALOG_RATE_LIMITED", "Retry later.", True, retry_after=37
            )
            response, payload = self.request(
                "POST", "/api/v1/catalog/feed/resolve", headers=self.mutation_headers(), body=body,
            )
            self.assert_error(response, payload, 429, "CATALOG_RATE_LIMITED")
            self.assertEqual(response.getheader("Retry-After"), "37")
            catalog.resolve_feed.side_effect = None

            peer_body = json.dumps({
                "watch_url": "https://video.example/videos/watch/11111111-1111-4111-8111-111111111111",
                "uuid": "11111111-1111-4111-8111-111111111111",
            }).encode()
            response, _payload = self.request(
                "POST", "/api/v1/catalog/peertube/resolve", headers=self.mutation_headers(), body=peer_body,
            )
            self.assertEqual(response.status, 200)
            catalog.resolve_peertube.assert_called_once()

            response, payload = self.request(
                "GET", "/api/v1/catalog/owncast/snapshot", headers=self.get_headers()
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["data"], {"items": []})
            catalog.owncast_snapshot.assert_called_once_with()
            response, payload = self.request(
                "POST", "/api/v1/catalog/owncast/snapshot", headers=self.mutation_headers(), body=b"{}"
            )
            self.assert_error(response, payload, 405, "METHOD_NOT_ALLOWED")

            response, payload = self.request(
                "POST", "/api/v1/catalog/cache/clear", headers=self.mutation_headers(), body=b"{}"
            )
            self.assertEqual(payload["data"], {"catalog_records_removed": 2, "asset_files_removed": 3})
            catalog.clear_cache.assert_called_once_with()
            assets.clear_cache.assert_called_once_with()

    def test_asset_registration_expiry_relay_ranges_validators_and_origin(self) -> None:
        assets = mock.Mock()
        assets.register.return_value = FakeRegistration()
        assets.read.return_value = AssetBlob(
            b"0123456789", "image/png", 1, 1, '"asset-etag"', 2_000_000_000
        )
        with mock.patch.object(worldmedia_server, "ASSET_REGISTRY", assets):
            registration_body = json.dumps({
                "url": "https://images.example/cover.png",
                "source_id": "gpodder",
                "item_id": "gpodder:item-one",
            }).encode()
            response, payload = self.request(
                "POST", "/api/v1/assets/register", headers=self.mutation_headers(), body=registration_body,
            )
            self.assertEqual(response.status, 201)
            self.assertTrue(payload["data"]["relay_url"].startswith("/api/v1/assets/"))

            token = "opaque_asset_token_1234567890"
            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}", headers={"Origin": "https://evil.example"}
            )
            self.assert_error(response, payload, 403, "INVALID_ORIGIN")
            assets.read.assert_not_called()

            response, payload = self.request("GET", f"/api/v1/assets/{token}")
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, b"0123456789")
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            self.assertEqual(response.getheader("Cache-Control"), "private, max-age=300")

            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}", headers={"Range": "bytes=2-5"}
            )
            self.assertEqual(response.status, 206)
            self.assertEqual(payload, b"2345")
            self.assertEqual(response.getheader("Content-Range"), "bytes 2-5/10")

            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}",
                headers={"Range": "bytes=2-5", "If-Range": '"different-etag"'},
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, b"0123456789")

            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}",
                headers={"Range": "bytes=2-5", "If-Range": '"asset-etag"'},
            )
            self.assertEqual(response.status, 206)
            self.assertEqual(payload, b"2345")

            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}", headers={"If-None-Match": '"asset-etag"'}
            )
            self.assertEqual(response.status, 304)
            self.assertEqual(payload, b"")

            response, payload = self.request("HEAD", f"/api/v1/assets/{token}")
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, b"")
            self.assertEqual(response.getheader("Content-Length"), "10")

            response, payload = self.request("GET", f"/api/v1/assets/{token}?url=https://evil.example")
            self.assert_error(response, payload, 400, "QUERY_NOT_ALLOWED")

            response, payload = self.request(
                "GET", f"/api/v1/assets/{token}", headers={"Range": "bytes=" + "9" * 256 + "-"}
            )
            self.assert_error(response, payload, 416, "INVALID_RANGE")

            expiry = json.dumps({"source_id": "gpodder", "item_id": "gpodder:item-one"}).encode()
            response, payload = self.request(
                "POST", f"/api/v1/assets/{token}/expire", headers=self.mutation_headers(), body=expiry,
            )
            self.assertEqual(response.status, 200)
            assets.expire.assert_called_once_with(token, {"source_id": "gpodder", "item_id": "gpodder:item-one"})


if __name__ == "__main__":
    unittest.main()
