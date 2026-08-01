from __future__ import annotations

import http.client
import io
import json
import threading
import unittest
import urllib.parse
from unittest import mock

import worldmedia_server
from worldmedia_ffmpeg import FfmpegError, ToolStatus
from worldmedia_security import MAX_JSON_BODY


class ControlApiTests(unittest.TestCase):
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
        self.assertEqual(response.status, 200)
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

    def assert_api_error(self, response, payload, status: int, code: str) -> None:
        self.assertEqual(response.status, status)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["api_version"], "v1")
        self.assertEqual(payload["error"]["code"], code)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_session_runtime_and_control_responses_are_same_origin(self) -> None:
        response, payload = self.request("GET", "/api/v1/session")
        self.assertEqual(payload["data"]["origin"], self.origin)
        self.assertGreaterEqual(len(payload["data"]["token"]), 32)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

        response, payload = self.request("GET", "/api/v1/runtime")
        self.assert_api_error(response, payload, 403, "INVALID_TOKEN")
        response, payload = self.request(
            "GET", "/api/v1/runtime", headers={"X-WorldMedia-Token": self.token}
        )
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("portable_root", payload["data"])
        self.assertEqual(payload["data"]["server_port"], self.port)
        self.assertIn("next_launch_port", payload["data"])

    def test_server_port_setting_is_authenticated_validated_and_next_launch_only(self) -> None:
        with mock.patch("worldmedia_server.save_server_port", return_value=21345) as save:
            response, payload = self.request(
                "POST", "/api/v1/runtime/server-port",
                headers=self.mutation_headers(), body=b'{"port":21345}',
            )
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"], {
            "server_port": self.port,
            "next_launch_port": 21345,
            "restart_required": True,
        })
        save.assert_called_once_with(21345, worldmedia_server.RUNTIME_PATHS)

        response, payload = self.request(
            "GET", "/api/v1/runtime/server-port", headers={"X-WorldMedia-Token": self.token}
        )
        self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")

        response, payload = self.request(
            "POST", "/api/v1/runtime/server-port",
            headers=self.mutation_headers(), body=b'{"port":"21345"}',
        )
        self.assert_api_error(response, payload, 400, "INVALID_SERVER_PORT")

    def test_profile_handoff_routes_are_authenticated_and_strict(self) -> None:
        values = {"worldmedia.favorites.v1": '[{"id":"saved:1"}]'}
        with mock.patch("worldmedia_server.load_profile_transfer", return_value=values) as load:
            response, payload = self.request(
                "GET", "/api/v1/profile/preferences", headers={"X-WorldMedia-Token": self.token}
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"], {"values": values})
        load.assert_called_once_with(worldmedia_server.RUNTIME_PATHS)

        with mock.patch("worldmedia_server.save_profile_transfer", return_value=values) as save:
            response, payload = self.request(
                "POST", "/api/v1/profile/preferences",
                headers=self.mutation_headers(), body=json.dumps({"values": values}).encode(),
            )
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["data"]["saved"])
        self.assertEqual(payload["data"]["keys"], ["worldmedia.favorites.v1"])
        save.assert_called_once_with(values, worldmedia_server.RUNTIME_PATHS)

        response, payload = self.request(
            "POST", "/api/v1/profile/preferences",
            headers=self.mutation_headers(), body=b'{"bad":true}',
        )
        self.assert_api_error(response, payload, 400, "INVALID_PROFILE_PREFERENCES")

    def test_host_origin_token_content_type_and_method_are_enforced(self) -> None:
        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(), body=b"{}", include_host=False,
        )
        self.assert_api_error(response, payload, 403, "INVALID_HOST")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(Origin="https://evil.example"), body=b"{}",
        )
        self.assert_api_error(response, payload, 403, "INVALID_ORIGIN")

        missing_origin = self.mutation_headers()
        del missing_origin["Origin"]
        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=missing_origin, body=b"{}",
        )
        self.assert_api_error(response, payload, 403, "ORIGIN_REQUIRED")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(**{"X-WorldMedia-Token": "wrong"}), body=b"{}",
        )
        self.assert_api_error(response, payload, 403, "INVALID_TOKEN")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(**{"Content-Type": "text/plain"}), body=b"{}",
        )
        self.assert_api_error(response, payload, 415, "JSON_REQUIRED")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(), body=None,
        )
        self.assert_api_error(response, payload, 411, "CONTENT_LENGTH_REQUIRED")

        response, payload = self.request(
            "GET", "/api/v1/session", headers={"Origin": "https://evil.example"}
        )
        self.assert_api_error(response, payload, 403, "INVALID_ORIGIN")

        response, payload = self.request(
            "GET", "/api/v1/session",
            headers={"Host": f"localhost:{self.port}", "Origin": f"http://localhost:{self.port}"},
            include_host=False,
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"]["origin"], f"http://localhost:{self.port}")

        response, payload = self.request(
            "PUT", "/api/v1/jobs", headers=self.mutation_headers(), body=b"{}"
        )
        self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")

        response, payload = self.request(
            "GET", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/stop",
            headers={"X-WorldMedia-Token": self.token},
        )
        self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")

    def test_preflight_malformed_and_oversized_json_are_rejected_before_work(self) -> None:
        response, payload = self.request(
            "OPTIONS", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        self.assert_api_error(response, payload, 403, "CORS_PREFLIGHT_REJECTED")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(), body=b"{",
        )
        self.assert_api_error(response, payload, 400, "MALFORMED_JSON")

        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(), body=None, declared_length=MAX_JSON_BODY + 1,
        )
        self.assert_api_error(response, payload, 413, "BODY_TOO_LARGE")
        self.assertEqual(response.getheader("Connection"), "close")

        response, payload = self.request(
            "GET", "/api/v1/session?token=must-not-be-accepted"
        )
        self.assert_api_error(response, payload, 400, "QUERY_NOT_ALLOWED")

    def test_job_lookup_shutdown_health_and_proxy_smokes(self) -> None:
        response, payload = self.request(
            "POST", "/api/v1/jobs/job_AbCdEfGhIjKlMnOp/cancel",
            headers=self.mutation_headers(), body=b"{}",
        )
        self.assert_api_error(response, payload, 404, "JOB_NOT_FOUND")

        response, payload = self.request("GET", "/api/health")
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        response, _payload = self.request("GET", "/api/proxy")
        self.assertEqual(response.status, 400)

        scheduled = threading.Event()
        with mock.patch(
            "worldmedia_server.schedule_process_exit",
            side_effect=lambda: scheduled.set(),
        ) as schedule:
            response, payload = self.request(
                "POST", "/api/shutdown", headers=self.mutation_headers(), body=b"{}"
            )
            self.assertTrue(scheduled.wait(1), "shutdown response won the race with its exit scheduler")
        self.assertEqual(response.status, 202)
        self.assertTrue(payload["ok"])
        schedule.assert_called_once()

        with mock.patch("worldmedia_server.shutdown_services", return_value=False), \
             mock.patch("worldmedia_server.schedule_process_exit") as schedule:
            response, payload = self.request(
                "POST", "/api/shutdown", headers=self.mutation_headers(), body=b"{}"
            )
        self.assertEqual(response.status, 202)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["data"]["graceful"])
        schedule.assert_called_once()

    def test_shutdown_services_requires_every_worker_owner_to_finish(self) -> None:
        with mock.patch.object(worldmedia_server.CATALOG_SERVICE, "shutdown", return_value=True) as catalogs, \
             mock.patch.object(worldmedia_server.ASSET_REGISTRY, "shutdown", return_value=True) as assets, \
             mock.patch.object(worldmedia_server.RECORDING_SERVICE, "shutdown", return_value=True) as recordings, \
             mock.patch.object(worldmedia_server.JOB_REGISTRY, "shutdown", return_value=True) as jobs, \
             mock.patch.object(worldmedia_server.DOWNLOAD_SERVICE, "shutdown", return_value=True) as downloads, \
             mock.patch.object(worldmedia_server.FFMPEG_SERVICE, "shutdown", return_value=True) as ffmpeg, \
             mock.patch.object(worldmedia_server.MEDIA_REGISTRY, "clear") as clear:
            self.assertTrue(worldmedia_server.shutdown_services(timeout=1))
        for owner in (catalogs, assets, recordings, jobs, downloads, ffmpeg):
            self.assertGreaterEqual(owner.call_args.kwargs["timeout"], 0)
            self.assertLessEqual(owner.call_args.kwargs["timeout"], 1)
        clear.assert_called_once_with()

        with mock.patch.object(worldmedia_server.CATALOG_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.ASSET_REGISTRY, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.RECORDING_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.JOB_REGISTRY, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.DOWNLOAD_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.FFMPEG_SERVICE, "shutdown", return_value=False), \
             mock.patch.object(worldmedia_server.MEDIA_REGISTRY, "clear"):
            self.assertFalse(worldmedia_server.shutdown_services(timeout=1))

        with mock.patch.object(worldmedia_server.CATALOG_SERVICE, "shutdown", return_value=False), \
             mock.patch.object(worldmedia_server.ASSET_REGISTRY, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.RECORDING_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.JOB_REGISTRY, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.DOWNLOAD_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.FFMPEG_SERVICE, "shutdown", return_value=True), \
             mock.patch.object(worldmedia_server.MEDIA_REGISTRY, "clear"):
            self.assertFalse(worldmedia_server.shutdown_services(timeout=1))

    def test_metadata_proxy_is_same_origin_bounded_and_uses_pinned_connector(self) -> None:
        class FakeResponse(io.BytesIO):
            status = 200
            headers = {
                "Content-Type": "application/json",
                "Content-Length": "2",
                "Link": '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next"',
                "Retry-After": "37",
                "Set-Cookie": "must-not-cross=1",
            }

            def __init__(self):
                super().__init__(b"{}")

        class FakeUpstream:
            def __init__(self):
                self.response = FakeResponse()

            def close(self):
                self.response.close()

        target = "https://images-api.nasa.gov/search?q=earth"
        path = "/api/proxy?" + urllib.parse.urlencode({"url": target})
        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=FakeUpstream()) as opened:
            response, payload = self.request("GET", path, headers={"Origin": "https://evil.example"})
            self.assert_api_error(response, payload, 403, "INVALID_ORIGIN")
            opened.assert_not_called()

            response, payload = self.request("GET", path)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {})
            self.assertEqual(
                response.getheader("Link"),
                '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next"',
            )
            self.assertEqual(response.getheader("Retry-After"), "37")
            self.assertIsNone(response.getheader("Set-Cookie"))
            self.assertEqual(opened.call_args.args, (target,))
            self.assertEqual(opened.call_args.kwargs["method"], "GET")

        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=FakeUpstream()) as opened:
            response, payload = self.request(
                "POST", path,
                headers={"Origin": self.origin, "Content-Type": "application/x-www-form-urlencoded"},
                body=b"vote=1",
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {})
            self.assertEqual(opened.call_args.kwargs["body"], b"vote=1")

        response, payload = self.request(
            "POST", path, headers={"Origin": self.origin}, declared_length=64 * 1024 + 1,
        )
        self.assert_api_error(response, payload, 413, "BODY_TOO_LARGE")

    def test_ffmpeg_status_and_managed_actions_are_authenticated_and_narrow(self) -> None:
        class FakeFfmpegService:
            def __init__(self):
                self.calls = []
                self.value = ToolStatus(
                    state="ready", source="PATH", ffmpeg_path="C:/ffmpeg/bin/ffmpeg.exe",
                    ffprobe_path="C:/ffmpeg/bin/ffprobe.exe", version="ffmpeg version test",
                )

            def status(self):
                self.calls.append(("status",))
                return self.value

            def start_install(self, destination):
                self.calls.append(("install", destination))
                return ToolStatus(state="installing", source=destination, progress=0.0, managed=True)

            def cancel_install(self):
                self.calls.append(("cancel",))
                return ToolStatus(state="cancelled", source="portable", managed=True)

            def remove(self, destination):
                self.calls.append(("remove", destination))
                return ToolStatus(state="missing")

        fake = FakeFfmpegService()
        old_service = worldmedia_server.FFMPEG_SERVICE
        worldmedia_server.FFMPEG_SERVICE = fake
        try:
            response, payload = self.request("GET", "/api/v1/ffmpeg/status")
            self.assert_api_error(response, payload, 403, "INVALID_TOKEN")
            response, payload = self.request(
                "GET", "/api/v1/ffmpeg/status", headers={"X-WorldMedia-Token": self.token}
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["data"]["source"], "PATH")

            for path in ("install", "repair"):
                response, payload = self.request(
                    "POST", f"/api/v1/ffmpeg/{path}", headers=self.mutation_headers(),
                    body=json.dumps({"confirmed": True, "destination": "portable"}).encode(),
                )
                self.assertEqual(response.status, 202)
                self.assertEqual(payload["data"]["state"], "installing")

            response, payload = self.request(
                "POST", "/api/v1/ffmpeg/cancel", headers=self.mutation_headers(), body=b"{}"
            )
            self.assertEqual(response.status, 200)
            response, payload = self.request(
                "POST", "/api/v1/ffmpeg/remove", headers=self.mutation_headers(),
                body=json.dumps({"confirmed": True, "destination": "LocalAppData"}).encode(),
            )
            self.assertEqual(response.status, 200)
            self.assertIn(("remove", "LocalAppData"), fake.calls)

            hostile = [
                {"confirmed": True, "destination": "C:/arbitrary"},
                {"confirmed": True, "destination": "portable", "url": "https://evil.test/tool.zip"},
                {"destination": "portable"},
            ]
            expected = ["INVALID_DESTINATION", "UNEXPECTED_FIELDS", "CONFIRMATION_REQUIRED"]
            for body, code in zip(hostile, expected):
                response, payload = self.request(
                    "POST", "/api/v1/ffmpeg/install", headers=self.mutation_headers(),
                    body=json.dumps(body).encode(),
                )
                self.assert_api_error(response, payload, 400, code)

            fake.start_install = mock.Mock(side_effect=FfmpegError(
                "already active", code="INSTALL_ACTIVE"
            ))
            response, payload = self.request(
                "POST", "/api/v1/ffmpeg/install", headers=self.mutation_headers(),
                body=b'{"confirmed":true,"destination":"portable"}',
            )
            self.assert_api_error(response, payload, 409, "INSTALL_ACTIVE")
        finally:
            worldmedia_server.FFMPEG_SERVICE = old_service

    def test_download_start_and_open_folder_accept_only_opaque_fixed_inputs(self) -> None:
        fake = mock.Mock()
        fake.start.return_value = {
            "id": "job_download_1234567890", "kind": "download", "state": "queued",
        }
        fake.open_downloads_folder.return_value = "E:\\WorldMediaWindows\\downloads"
        old_service = worldmedia_server.DOWNLOAD_SERVICE
        worldmedia_server.DOWNLOAD_SERVICE = fake
        try:
            media_id = "opaque_media_id_1234567890"
            response, payload = self.request(
                "POST", "/api/v1/jobs/download", headers=self.mutation_headers(),
                body=json.dumps({"media_id": media_id}).encode(),
            )
            self.assertEqual(response.status, 202)
            self.assertEqual(payload["data"]["state"], "queued")
            fake.start.assert_called_once_with(media_id)

            for body in (
                {"media_id": media_id, "url": "https://evil.test/file"},
                {"media_id": "short"},
                {"url": "https://evil.test/file"},
            ):
                response, payload = self.request(
                    "POST", "/api/v1/jobs/download", headers=self.mutation_headers(),
                    body=json.dumps(body).encode(),
                )
                self.assertEqual(response.status, 400)

            response, payload = self.request(
                "POST", "/api/v1/downloads/open-folder", headers=self.mutation_headers(), body=b"{}",
            )
            self.assertEqual(response.status, 200)
            self.assertTrue(payload["data"]["opened"])
            fake.open_downloads_folder.assert_called_once_with()

            response, payload = self.request("GET", "/api/v1/jobs/download")
            self.assert_api_error(response, payload, 403, "INVALID_TOKEN")
            response, payload = self.request(
                "GET", "/api/v1/jobs/download", headers={"X-WorldMedia-Token": self.token}
            )
            self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")
        finally:
            worldmedia_server.DOWNLOAD_SERVICE = old_service

    def test_recording_start_accepts_only_opaque_id_and_fixed_profile(self) -> None:
        fake = mock.Mock()
        fake.start.return_value = {
            "id": "job_record_1234567890", "kind": "record-audio", "state": "queued",
        }
        old_service = worldmedia_server.RECORDING_SERVICE
        worldmedia_server.RECORDING_SERVICE = fake
        try:
            media_id = "opaque_live_media_1234567890"
            eq = {"preamp": -2, "bands": [0, 1, 2, 3, 4, 3, 2, 1, 0, -1], "bypassed": False}
            response, payload = self.request(
                "POST", "/api/v1/jobs/record", headers=self.mutation_headers(),
                body=json.dumps({"media_id": media_id, "profile": "balanced", "eq": eq}).encode(),
            )
            self.assertEqual(response.status, 202)
            self.assertEqual(payload["data"]["state"], "queued")
            fake.start.assert_called_once_with(
                media_id, "balanced", f"http://127.0.0.1:{self.port}", eq,
            )
            hostile = [
                {"media_id": media_id, "profile": "ultra"},
                {"media_id": media_id, "profile": "high", "url": "https://evil.test/live"},
                {"media_id": "short", "profile": "compact"},
                {"profile": "compact", "url": "https://evil.test/live"},
                {"media_id": media_id, "profile": "compact", "eq": {"filter": "volume=99"}},
            ]
            for body in hostile:
                response, payload = self.request(
                    "POST", "/api/v1/jobs/record", headers=self.mutation_headers(),
                    body=json.dumps(body).encode(),
                )
                self.assertEqual(response.status, 400)
                self.assertFalse(payload["ok"])
            response, payload = self.request("GET", "/api/v1/jobs/record")
            self.assert_api_error(response, payload, 403, "INVALID_TOKEN")
            response, payload = self.request(
                "GET", "/api/v1/jobs/record", headers={"X-WorldMedia-Token": self.token}
            )
            self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")
        finally:
            worldmedia_server.RECORDING_SERVICE = old_service


if __name__ == "__main__":
    unittest.main()
