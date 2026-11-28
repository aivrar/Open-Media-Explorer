from __future__ import annotations

import gzip
import http.client
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import worldmedia_server
from worldmedia_ffmpeg import FfmpegError, ToolStatus
from worldmedia_computer_stars import ComputerStars
from worldmedia_runtime import _atomic_write_json
from worldmedia_security import MAX_JSON_BODY


class ControlApiTests(unittest.TestCase):
    def test_shutdown_response_precedes_cleanup_and_worker_exits_after_cleanup(self) -> None:
        with mock.patch.object(worldmedia_server, 'shutdown_services') as cleanup, \
             mock.patch.object(worldmedia_server, 'schedule_process_exit') as schedule:
            response, payload = self.request('POST', '/api/shutdown', headers=self.mutation_headers(), body=b'{}')
            self.assertEqual(response.status, 202)
            self.assertEqual(payload['data']['shutdown'], 'in_progress')
            self.assertIsNone(payload['data']['graceful'])
            cleanup.assert_not_called()  # The response handler never waits for cleanup.
            # HTTP response can win the race with finally on the request thread.
            deadline = time.monotonic() + 5
            while not schedule.called and time.monotonic() < deadline:
                threading.Event().wait(0.001)
            schedule.assert_called_once_with()
        order = []
        with mock.patch.object(worldmedia_server, 'shutdown_services', side_effect=lambda **_: order.append('cleanup')), \
             mock.patch.object(worldmedia_server.time, 'sleep'), \
             mock.patch.object(worldmedia_server.os, '_exit', side_effect=lambda _: order.append('exit')):
            worldmedia_server.finish_process_shutdown(0)
        self.assertEqual(order, ['cleanup', 'exit'])

    def test_shutdown_worker_exits_even_if_cleanup_raises(self) -> None:
        with mock.patch.object(worldmedia_server, 'shutdown_services', side_effect=RuntimeError('cleanup failed')), \
             mock.patch.object(worldmedia_server.time, 'sleep'), \
             mock.patch.object(worldmedia_server.os, '_exit') as exited:
            with self.assertRaises(RuntimeError):
                worldmedia_server.finish_process_shutdown(0)
            exited.assert_called_once_with(0)

    def test_repeated_shutdown_schedules_only_one_worker(self) -> None:
        with mock.patch.object(worldmedia_server, '_exit_scheduled', False), \
             mock.patch.object(worldmedia_server.threading, 'Thread') as thread:
            worldmedia_server.schedule_process_exit()
            worldmedia_server.schedule_process_exit()
            thread.assert_called_once()
            thread.return_value.start.assert_called_once_with()

    def test_shutdown_disconnect_still_schedules_exit(self) -> None:
        handler = object.__new__(worldmedia_server.WorldMediaHandler)
        handler.path = '/api/shutdown'
        handler.client_address = ('127.0.0.1', 1234)
        handler.server = mock.Mock(server_port=1234)
        handler.headers = {}
        handler.rfile = io.BytesIO(b'{}')
        handler._send_api_success = mock.Mock(side_effect=BrokenPipeError('Client disconnected'))
        with mock.patch.object(worldmedia_server, 'rate_limit', return_value=True), \
             mock.patch.object(worldmedia_server, 'validate_mutation', return_value={}), \
             mock.patch.object(worldmedia_server, 'shutdown_services', return_value=True), \
             mock.patch.object(worldmedia_server, 'schedule_process_exit') as schedule:
            with self.assertRaises(BrokenPipeError):
                handler._dispatch_api('POST')
            schedule.assert_called_once_with()

    def test_playlist_routes_require_auth_and_use_only_the_native_store(self) -> None:
        store = mock.Mock()
        store.list.return_value = []
        store.import_file.return_value = {'playlist': {'id': 'example', 'items': []}, 'replaced': False}
        store.import_link.return_value = {'playlist': {'id': 'link', 'items': []}, 'replaced': False, 'kind': 'stream'}
        with mock.patch.object(worldmedia_server, 'PLAYLIST_STORE', store):
            response, payload = self.request('GET', '/api/v1/playlists')
            self.assertEqual(response.status, 403)
            store.list.assert_not_called()
            response, payload = self.request('GET', '/api/v1/playlists', headers={'X-WorldMedia-Token': self.token})
            self.assertEqual(response.status, 200)
            self.assertEqual(payload['data']['playlists'], [])
            body = json.dumps({'name': 'test.m3u', 'text': '#EXTM3U\nhttps://example.org/live', 'default_type': 'tv'}).encode()
            response, _ = self.request('POST', '/api/v1/playlists/import', headers={'Content-Type': 'application/json'}, body=body)
            self.assertEqual(response.status, 403)
            store.import_file.assert_not_called()
            response, _ = self.request('POST', '/api/v1/playlists/import', headers=self.mutation_headers(), body=body)
            self.assertEqual(response.status, 200)
            store.import_file.assert_called_once_with(json.loads(body))
            link_body = b'{"url":"https://example.org/live","name":"Radio","kind":"stream","default_type":"radio"}'
            response, _ = self.request('POST', '/api/v1/playlists/link', headers={'Content-Type': 'application/json'}, body=link_body)
            self.assertEqual(response.status, 403)
            store.import_link.assert_not_called()
            response, _ = self.request('POST', '/api/v1/playlists/link', headers=self.mutation_headers(), body=link_body)
            self.assertEqual(response.status, 200)
            store.import_link.assert_called_once_with(json.loads(link_body))
            store.import_file.side_effect = ValueError('Invalid playlist')
            response, payload = self.request('POST', '/api/v1/playlists/import', headers=self.mutation_headers(), body=body)
            self.assertEqual(response.status, 400)
            self.assertEqual(payload['error']['code'], 'INVALID_PLAYLIST')
            response, _ = self.request('POST', '/api/v1/playlists/remove', headers=self.mutation_headers(), body=b'{"id":"example"}')
            self.assertEqual(response.status, 200)
            store.remove.assert_called_once_with('example')

    def test_session_actions_require_origin_and_token_and_accept_an_empty_post(self):
        token = "1" * 64
        for kind, action in (("media", "release"), ("media", "keep"), ("hls", "release")):
            route = f"/api/v1/computer/{kind}/{token}/{action}"
            with self.subTest(route=route), mock.patch.object(worldmedia_server.COMPUTER_MEDIA, action) as update:
                for headers in ({}, {"Origin": self.origin}, {"X-WorldMedia-Token": self.token},
                                self.mutation_headers(Origin="https://example.org")):
                    response, _ = self.request("POST", route, headers=headers)
                    self.assertEqual(response.status, 403)
                update.assert_not_called()
                for _ in range(2):
                    response, body = self.request("POST", route, headers={"Origin": self.origin,
                                                  "X-WorldMedia-Token": self.token})
                    self.assertEqual((response.status, body), (204, b""))
                expected = mock.call(token, hls=kind == "hls") if action == "release" else mock.call(token)
                self.assertEqual(update.call_args_list, [expected, expected])

    def test_computer_play_reports_nonretryable_control_failures(self) -> None:
        route = "/api/v1/computer/play"
        cases = (
            (None, b"{}", 400, "INVALID_COMPUTER_PLAY"),
            (None, b'{"id":"track","standby":1}', 400, "INVALID_COMPUTER_PLAY"),
            (OSError("private path"), b'{"id":"track"}', 503, "COMPUTER_LIBRARY_UNAVAILABLE"),
            (RuntimeError("private path"), b'{"id":"track"}', 500, "INTERNAL_ERROR"),
        )
        for error, body, status, code in cases:
            with self.subTest(code=code), mock.patch.object(worldmedia_server.COMPUTER_MEDIA, "register", side_effect=error):
                response, payload = self.request("POST", route, headers=self.mutation_headers(), body=body)
                self.assert_api_error(response, payload, status, code)
                self.assertIs(payload["error"]["retryable"], False)
                self.assertNotIn("private path", payload["error"]["message"])

    def test_computer_loudness_requires_authenticated_bounded_post(self) -> None:
        route = "/api/v1/computer/loudness"
        auth = {"X-WorldMedia-Token": self.token}
        headers = self.mutation_headers()
        with mock.patch.object(worldmedia_server.COMPUTER_MEDIA, "loudness") as measure:
            response, _ = self.request("POST", route, headers={"Content-Type": "application/json"}, body=b"{}")
            self.assertEqual(response.status, 403)
            response, payload = self.request("GET", route, headers=auth)
            self.assert_api_error(response, payload, 405, "METHOD_NOT_ALLOWED")
            response, payload = self.request("POST", route, headers=headers, declared_length=1025)
            self.assert_api_error(response, payload, 413, "BODY_TOO_LARGE")
            for body in (b"{}", b'{"id":2}', b'{"id":"track","path":"private"}'):
                response, payload = self.request("POST", route, headers=headers, body=body)
                self.assert_api_error(response, payload, 400, "INVALID_COMPUTER_LOUDNESS")
            measure.assert_not_called()

    def test_computer_stars_authentication_limits_and_responses(self) -> None:
        route = "/api/v1/computer/stars"
        identity = "0" * 24
        auth = {"X-WorldMedia-Token": self.token}
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        stars = ComputerStars(root / "computer-stars.json", clock=lambda: 1_000_000)
        with mock.patch.object(worldmedia_server.COMPUTER_FOLDERS, "stars", stars):
            for method, headers, body in (
                ("GET", {}, None), ("GET", {**auth, "Origin": "https://example.org"}, None),
                ("POST", auth, b"{}"), ("POST", self.mutation_headers(Origin="https://example.org"), b"{}"),
            ):
                response, _ = self.request(method, route, headers=headers, body=body)
                self.assertEqual(response.status, 403)
            response, payload = self.request("GET", route, headers=auth)
            self.assertEqual((response.status, payload["data"]), (200, {"stars": [], "count": 0}))
            response, payload = self.request("POST", route, headers=self.mutation_headers(),
                                             declared_length=4 * 1024 * 1024 + 1)
            self.assert_api_error(response, payload, 413, "BODY_TOO_LARGE")
            self.assertEqual(payload["error"]["message"], "JSON request body is too large.")
            self.assertEqual(response.getheader("Connection"), "close")
            batch = json.dumps({"remove": [f"{index:024x}" for index in range(2001)]},
                               separators=(",", ":")).encode()
            response, payload = self.request("POST", route, headers=self.mutation_headers(), body=batch)
            self.assert_api_error(response, payload, 400, "INVALID_COMPUTER_STARS")
            self.assertEqual(payload["error"]["message"], "Choose at most 2,000 files at a time.")
            snap = {"title": "Song"}
            body = json.dumps({"add": [{"id": identity, "snap": snap}]}).encode()
            response, payload = self.request("POST", route, headers=self.mutation_headers(), body=body)
            record = {"id": identity, "t": 1, "seq": 1}
            self.assertEqual((response.status, payload["data"]), (200, {"added": [record], "removed": [], "count": 1}))
            response, payload = self.request("GET", route, headers=auth)
            self.assertEqual((response.status, payload["data"]),
                             (200, {"stars": [{**record, "snap": snap}], "count": 1}))

    def test_computer_stars_saves_2000_snapshots_in_one_write(self) -> None:
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        stars = ComputerStars(root / "computer-stars.json")
        add = [
            {"id": f"{index:024x}", "snap": {
                "title": f"Night Train Across the Valley (Live at the Riverside Theater) - Track {index + 1}",
                "artist": "The Cedar Valley Orchestra featuring the Riverside Quartet",
                "album": "The Riverside Sessions: Complete Recordings and Alternate Takes",
                "duration": 245.75, "kind": "audio", "ext": "flac", "format": "FLAC",
            }}
            for index in range(2000)
        ]
        body = json.dumps({"add": add}, separators=(",", ":")).encode()
        self.assertGreater(len(body), MAX_JSON_BODY)
        with mock.patch.object(worldmedia_server.COMPUTER_FOLDERS, "stars", stars), \
             mock.patch("worldmedia_computer_stars._atomic_write_json", wraps=_atomic_write_json) as save:
            response, payload = self.request("POST", "/api/v1/computer/stars",
                                             headers=self.mutation_headers(), body=body)
            self.assertEqual(response.status, 200)
            save.assert_called_once()
        self.assertEqual(payload["data"]["count"], 2000)
        self.assertEqual([row["id"] for row in payload["data"]["added"]], [row["id"] for row in add])
        persisted = ComputerStars(stars.path).snapshot()
        self.assertEqual([{"id": row["id"], "snap": row["snap"]} for row in persisted["stars"]], add)

    def test_playlist_export_requires_authenticated_post(self) -> None:
        path = '/api/v1/playlists/export'
        data = {'format': 'm3u8', 'collection': 'Favorites', 'type': 'TV', 'stations': []}
        body = json.dumps(data).encode()
        with mock.patch.object(worldmedia_server, 'export_library_playlist', return_value={'count': 1}) as save:
            response, _ = self.request('GET', path, headers={'X-WorldMedia-Token': self.token})
            self.assertEqual(response.status, 405)
            response, _ = self.request('POST', path, headers={'Content-Type': 'application/json'}, body=body)
            self.assertEqual(response.status, 403)
            save.assert_not_called()
            response, payload = self.request('POST', path, headers=self.mutation_headers(), body=body)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload['data'], {'count': 1})
            save.assert_called_once_with(data, worldmedia_server.RUNTIME_PATHS)

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
        connection.putrequest(
            method, path, skip_host=True,
            skip_accept_encoding=any(name.lower() == "accept-encoding" for name in (headers or {})),
        )
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
        with mock.patch("worldmedia_server.load_profile_transfer_report", return_value=(values, [])) as load:
            response, payload = self.request(
                "GET", "/api/v1/profile/preferences", headers={"X-WorldMedia-Token": self.token}
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"], {"values": values, "copied": []})
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
            self.assertTrue(scheduled.wait(5), "shutdown response won the race with its exit scheduler")
        self.assertEqual(response.status, 202)
        self.assertTrue(payload["ok"])
        schedule.assert_called_once()

        scheduled = threading.Event()
        with mock.patch("worldmedia_server.shutdown_services", return_value=False), \
             mock.patch("worldmedia_server.schedule_process_exit",
                        side_effect=lambda: scheduled.set()) as schedule:
            response, payload = self.request(
                "POST", "/api/shutdown", headers=self.mutation_headers(), body=b"{}"
            )
            # The handler schedules the exit after its response; leaving the
            # patch first would let the real scheduler end the test process.
            self.assertTrue(scheduled.wait(5), "shutdown response won the race with its exit scheduler")
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
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            self.assertEqual(response.getheader("Content-Security-Policy"), "sandbox; default-src 'none'")
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            self.assertEqual(
                response.getheader("Link"),
                '<https://api.media.ccc.de/public/events/recent?page=2>; rel="next"',
            )
            self.assertEqual(response.getheader("Retry-After"), "37")
            self.assertIsNone(response.getheader("Set-Cookie"))
            self.assertEqual(opened.call_args.args, (target,))
            self.assertEqual(opened.call_args.kwargs["method"], "GET")
            # This client sent "Accept-Encoding: identity": no gzip is asked for.
            self.assertIs(opened.call_args.kwargs["accept_gzip"], False)
            self.assertIsNone(response.getheader("Content-Encoding"))

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

    def proxy_upstream(self, status: int, body: bytes, headers: dict[str, str]):
        class FakeResponse(io.BytesIO):
            closed_by_server = False

            def close(self):
                FakeResponse.closed_by_server = True
                super().close()

        response = FakeResponse(body)
        response.status = status
        response.headers = headers
        return mock.Mock(response=response, close=response.close)

    def test_metadata_proxy_serves_document_types_as_plain_text(self) -> None:
        body = b"<html><body>Upstream document</body></html>"
        path = "/api/proxy?" + urllib.parse.urlencode({"url": "https://images-api.nasa.gov/search"})
        for content_type in (
            "Text/HTML; charset=iso-8859-1", "application/xhtml+xml", "image/svg+xml",
            "application/octet-stream, text/html",
        ):
            with self.subTest(content_type=content_type):
                upstream = self.proxy_upstream(200, body, {
                    "Content-Type": content_type, "Content-Length": str(len(body)),
                })
                with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream):
                    response, payload = self.request("GET", path)
                self.assertEqual(response.status, 200)
                self.assertEqual(payload, body)
                self.assertEqual(response.getheader("Content-Type"), "text/plain; charset=utf-8")
                self.assertEqual(response.getheader("Content-Security-Policy"), "sandbox; default-src 'none'")
                self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")

    def test_metadata_proxy_asks_for_gzip_and_passes_it_through_compressed(self) -> None:
        payload = b"<rss>" + b"<item>same text again</item>" * 2000 + b"</rss>"
        compressed = gzip.compress(payload)
        target = "https://images-api.nasa.gov/search?q=earth"
        path = "/api/proxy?" + urllib.parse.urlencode({"url": target})
        upstream = self.proxy_upstream(200, compressed, {
            "Content-Type": "application/xml",
            "Content-Encoding": "gzip",
            "Content-Length": str(len(compressed)),
            "Link": '<https://images-api.nasa.gov/search?page=2>; rel="next"',
            "Set-Cookie": "must-not-cross=1",
        })
        # What WebView2 sends with fetch().
        browser = {"Accept-Encoding": "gzip, deflate, br, zstd"}
        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream) as opened:
            response, body = self.request("GET", path, headers=browser)
        self.assertIs(opened.call_args.kwargs["accept_gzip"], True)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Encoding"), "gzip")
        self.assertEqual(response.getheader("Content-Type"), "application/xml")
        self.assertEqual(response.getheader("Content-Security-Policy"), "sandbox; default-src 'none'")
        self.assertEqual(response.getheader("Content-Length"), str(len(compressed)))
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertEqual(response.getheader("Link"), '<https://images-api.nasa.gov/search?page=2>; rel="next"')
        self.assertIsNone(response.getheader("Set-Cookie"))
        self.assertEqual(body, compressed)
        self.assertEqual(gzip.decompress(body), payload)
        self.assertLess(len(body), len(payload))

        # Explicit identity behaves exactly like no Content-Encoding at all.
        upstream = self.proxy_upstream(200, b"{}", {
            "Content-Type": "application/json", "Content-Encoding": "identity", "Content-Length": "2",
        })
        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream):
            response, body = self.request("GET", path, headers=browser)
        self.assertEqual(response.status, 200)
        self.assertEqual(body, {})
        self.assertIsNone(response.getheader("Content-Encoding"))
        self.assertEqual(response.getheader("Content-Length"), "2")

        # The LibriVox empty-search 404 still answers an empty list.
        librivox = "https://librivox.org/api/feed/audiobooks?title=none&format=json"
        upstream = self.proxy_upstream(404, gzip.compress(b"{}"), {
            "Content-Type": "application/json", "Content-Encoding": "gzip",
        })
        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream):
            response, body = self.request(
                "GET", "/api/proxy?" + urllib.parse.urlencode({"url": librivox}), headers=browser,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(body, {"books": []})

    def test_metadata_proxy_asks_for_identity_when_the_client_does_not_take_gzip(self) -> None:
        target = "https://images-api.nasa.gov/search?q=earth"
        path = "/api/proxy?" + urllib.parse.urlencode({"url": target})
        # (A request with no Accept-Encoding at all is covered by the unit
        # test below; http.client always sends one.)
        for client in ("identity", "br, deflate", "*", "gzip;q=0", "GZIP; Q=0.000, br", "x-gzip"):
            with self.subTest(client=client):
                upstream = self.proxy_upstream(200, b"{}", {"Content-Type": "application/json", "Content-Length": "2"})
                with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream) as opened:
                    response, body = self.request("GET", path, headers={"Accept-Encoding": client})
                self.assertIs(opened.call_args.kwargs["accept_gzip"], False)
                self.assertEqual((response.status, body), (200, {}))
                self.assertIsNone(response.getheader("Content-Encoding"))
        # A source that sends gzip unasked is refused, not handed on unlabelled.
        upstream = self.proxy_upstream(200, gzip.compress(b"{}"), {
            "Content-Type": "application/json", "Content-Encoding": "gzip",
        })
        with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream):
            response, payload = self.request("GET", path, headers={"Accept-Encoding": "identity"})
        self.assert_api_error(response, payload, 502, "PROXY_ENCODING_UNSUPPORTED")
        self.assertTrue(upstream.response.closed_by_server)

    def test_client_gzip_check_is_a_plain_token_check_that_honours_only_q_zero(self) -> None:
        accepts = worldmedia_server.WorldMediaHandler._client_accepts_gzip
        for values in (
            ["gzip"], ["GZip"], [" gzip , br"], ["gzip, deflate, br, zstd"], ["br;q=1.0, gzip;q=0.5"],
            ["gzip;q=0.001"], ["gzip; level=1"], ["identity", "gzip"],
        ):
            with self.subTest(values=values):
                self.assertTrue(accepts(values))
        for values in (
            [], None, ["identity"], ["*"], ["*;q=1"], ["x-gzip"], ["gzipped"], ["deflate, br"],
            ["gzip;q=0"], ["gzip;Q=0.0"], ["gzip; q = 0.000"], ["gzip;q=abc"], ["gzip;q=nan"],
            ["gzip", "gzip;q=0"], ["gzip" + " " * 2000],
        ):
            with self.subTest(values=values):
                self.assertFalse(accepts(values))

    def test_metadata_proxy_refuses_an_encoding_other_than_gzip_before_any_header(self) -> None:
        target = "https://images-api.nasa.gov/search?q=earth"
        path = "/api/proxy?" + urllib.parse.urlencode({"url": target})
        for encoding in ("br", "deflate", "gzip, gzip", "compress"):
            with self.subTest(encoding=encoding):
                upstream = self.proxy_upstream(200, b"\x00\x01binary", {
                    "Content-Type": "application/json", "Content-Encoding": encoding, "Content-Length": "8",
                })
                with mock.patch.object(worldmedia_server.PROXY_CONNECTOR, "open", return_value=upstream):
                    response, payload = self.request("GET", path, headers={"Accept-Encoding": "gzip"})
                self.assert_api_error(response, payload, 502, "PROXY_ENCODING_UNSUPPORTED")
                self.assertIsNone(response.getheader("Content-Encoding"))
                self.assertTrue(upstream.response.closed_by_server)

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
                body=json.dumps({"media_id": media_id, "profile": "balanced", "eq": eq, "delivery": "unknown"}).encode(),
            )
            self.assertEqual(response.status, 202)
            self.assertEqual(payload["data"]["state"], "queued")
            fake.start.assert_called_once_with(
                media_id, "balanced", f"http://127.0.0.1:{self.port}", eq, delivery="unknown",
            )
            hostile = [
                {"media_id": media_id, "profile": "ultra"},
                {"media_id": media_id, "profile": "compact", "delivery": ["live"]},
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
