from __future__ import annotations

import http.client
import io
import json
import os
import re
import socket
import tempfile
import threading
import time
import unittest
import urllib.parse
from http import HTTPStatus
from unittest import mock

_ISOLATED_STATE = tempfile.TemporaryDirectory(prefix="worldmedia-stream-probe-")
os.environ.setdefault("WORLDMEDIA_STATE_ROOT", _ISOLATED_STATE.name)

import worldmedia_server  # noqa: E402  (state isolation must precede import)
import worldmedia_stream_probe as probe_module  # noqa: E402
from worldmedia_media import (  # noqa: E402
    MediaError, MediaRegistry, SafeConnector, rewrite_dash_manifest, rewrite_hls_manifest,
)
from worldmedia_stream_probe import (  # noqa: E402
    PROBE_MAX_BYTES,
    Deadline,
    DeadlineConnector,
    ProbeBusy,
    abandonable_resolver,
    probe_busy,
    probe_pair,
    probe_stream,
    valid_stream_url,
)


def icy_body(audio: bytes, metaint: int, title: str | None) -> bytes:
    """Audio with a metadata block after every `metaint` bytes (first one with the title)."""
    out = bytearray()
    first = True
    for start in range(0, len(audio), metaint):
        out += audio[start:start + metaint]
        if len(audio[start:start + metaint]) < metaint:
            break
        if first and title is not None:
            text = f"StreamTitle='{title}';".encode("utf-8")
            size = (len(text) + 15) // 16
            out += bytes([size]) + text.ljust(size * 16, b"\0")
        else:
            out += b"\0"
        first = False
    return bytes(out)


class FakeResponse:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self._headers = {name.lower(): value for name, value in headers.items()}
        self._body = io.BytesIO(body)
        self.reads = 0

    def getheader(self, name: str, default=None):
        return self._headers.get(name.lower(), default)

    def read(self, size: int) -> bytes:
        self.reads += 1
        return self._body.read(size)


class FakeUpstream:
    def __init__(self, response: FakeResponse, url: str) -> None:
        self.response = response
        self.url = url
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeConnector:
    def __init__(self, answers: dict[str, object], final: dict[str, str] | None = None) -> None:
        self.answers = answers
        self.final = final or {}
        self.calls: list[tuple[str, dict]] = []
        self.upstreams: list[FakeUpstream] = []

    def open(self, url: str, *, method: str = "GET", headers=None, **_kwargs):
        self.calls.append((url, dict(headers or {})))
        answer = self.answers[url]
        if isinstance(answer, Exception):
            raise answer
        upstream = FakeUpstream(answer, self.final.get(url, url))
        self.upstreams.append(upstream)
        return upstream


def station_response(*, bitrate: str = "128", name: str = "Jazz FM", title: str | None = "Miles Davis - So What",
                     content_type: str = "audio/mpeg", status: int = 200, size: int = 64 * 1024) -> FakeResponse:
    headers = {"Content-Type": content_type, "icy-br": bitrate, "icy-name": name,
               "icy-url": "https://www.jazzfm.example", "icy-metaint": "8192"}
    return FakeResponse(status, headers, icy_body(b"\x11" * size, 8192, title))


OWN = "https://stream.jazzfm.example/128.mp3"
ALT = "https://hq.jazzfm.example/320.mp3"


class ProbeStreamTests(unittest.TestCase):
    def test_reports_what_the_stream_says_about_itself(self) -> None:
        connector = FakeConnector({OWN: station_response()})
        facts = probe_stream(connector, OWN, Deadline(5))
        self.assertEqual(facts, {
            "ok": True, "content_type": "audio/mpeg", "bitrate": 128, "name": "Jazz FM",
            "url": "https://www.jazzfm.example", "title": "Miles Davis - So What",
            "audio_bytes": facts["audio_bytes"], "final_scheme": "https", "final_host": "stream.jazzfm.example",
        })
        self.assertGreaterEqual(facts["audio_bytes"], 8 * 1024)
        self.assertEqual(connector.calls[0][1], {"Icy-MetaData": "1"})
        self.assertTrue(connector.upstreams[0].closed)

    def test_reports_where_redirects_ended(self) -> None:
        connector = FakeConnector({OWN: station_response()}, final={OWN: "http://cdn.other.example/x.mp3"})
        facts = probe_stream(connector, OWN, Deadline(5))
        self.assertEqual((facts["final_scheme"], facts["final_host"]), ("http", "cdn.other.example"))

    def test_reads_are_bounded_by_bytes(self) -> None:
        endless = FakeResponse(200, {"Content-Type": "audio/mpeg"}, b"\x22" * (4 * PROBE_MAX_BYTES))
        facts = probe_stream(FakeConnector({OWN: endless}), OWN, Deadline(5))
        self.assertEqual(facts["audio_bytes"], PROBE_MAX_BYTES)
        self.assertEqual(facts["title"], "")

    def test_failures_are_simply_not_ok(self) -> None:
        cases = {
            "refused": OSError("refused"),
            "status": station_response(status=404),
            "empty": FakeResponse(200, {"Content-Type": "audio/mpeg"}, b""),
        }
        for label, answer in cases.items():
            self.assertFalse(probe_stream(FakeConnector({OWN: answer}), OWN, Deadline(5))["ok"], label)
        odd = station_response(bitrate="999999999")
        self.assertEqual(probe_stream(FakeConnector({OWN: odd}), OWN, Deadline(5))["bitrate"], 0)


class LocalServer:
    """A loopback server that accepts and then does what `behave` says."""

    def __init__(self, behave) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.behave = behave
        self.clients: list[socket.socket] = []
        self.closed_by_peer = threading.Event()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self) -> None:
        self.sock.settimeout(0.1)
        while not self.stop.is_set():
            try:
                client, _ = self.sock.accept()
            except OSError:
                continue
            self.clients.append(client)
            threading.Thread(target=self.behave, args=(self, client), daemon=True).start()

    def close(self) -> None:
        self.stop.set()
        for client in self.clients:
            try:
                client.close()
            except OSError:
                pass
        self.sock.close()


def never_answers(server: LocalServer, client: socket.socket) -> None:
    client.settimeout(0.2)
    while not server.stop.is_set():
        try:
            data = client.recv(1024)
        except socket.timeout:
            continue
        except OSError:
            break
        if data == b"":
            server.closed_by_peer.set()
            break


def slow_drip(server: LocalServer, client: socket.socket) -> None:
    try:
        client.recv(4096)
        client.sendall(b"HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\nicy-br: 128\r\n\r\n")
        while not server.stop.is_set():
            client.sendall(b"\x11")
            time.sleep(0.05)
    except OSError:
        server.closed_by_peer.set()


def loopback_connector(port: int, resolver=None) -> SafeConnector:
    return SafeConnector(
        resolver=resolver or (lambda host, _port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]),
        address_policy=lambda _ip: True,
        connect_timeout=30, header_timeout=30, idle_timeout=30,
    )


class DeadlineTests(unittest.TestCase):
    def run_pair(self, base, seconds=1.0, ceiling=3.0, port=1, **kwargs):
        started = time.monotonic()
        result = probe_pair(base, {"own_url": f"http://own.example:{port}/a", "alt_url": f"http://alt.example:{port}/b"},
                            seconds=seconds, ceiling=ceiling, **kwargs)
        return result, time.monotonic() - started

    def wait_idle(self) -> None:
        for _ in range(100):
            if not probe_busy():
                return
            time.sleep(0.05)
        self.fail("the probe workers did not end")

    def test_a_host_that_accepts_and_never_answers(self) -> None:
        server = LocalServer(never_answers)
        try:
            base = loopback_connector(server.port)
            # The relay's connector waits 30 s for headers; the probe does not.
            result, took = self.run_pair(base, port=server.port)
            self.assertLess(took, 2.5)
            self.assertFalse(result["own"]["ok"])
            self.assertFalse(result["alt"]["ok"])
            self.wait_idle()
        finally:
            server.close()

    def test_a_slow_drip_body_stops_at_the_deadline(self) -> None:
        server = LocalServer(slow_drip)
        try:
            result, took = self.run_pair(loopback_connector(server.port), port=server.port)
            self.assertLess(took, 2.5)
            self.assertLess(result["own"]["audio_bytes"], 100)
            self.assertTrue(server.closed_by_peer.wait(3), "the sockets were closed")
            self.wait_idle()
        finally:
            server.close()

    def test_a_blocked_resolver_is_abandoned_and_keeps_new_probes_out_until_it_ends(self) -> None:
        release = threading.Event()

        def blocked(_host, _port):
            release.wait(30)
            return []

        try:
            result, took = self.run_pair(loopback_connector(1, resolver=blocked))
            self.assertLess(took, 2.5)
            self.assertFalse(result["own"]["ok"])
            # The request was answered; the left-behind lookups still count.
            self.assertTrue(probe_busy())
        finally:
            release.set()
        self.wait_idle()
        self.assertFalse(probe_busy())

    def test_the_page_going_away_closes_the_sockets_at_once(self) -> None:
        server = LocalServer(slow_drip)
        try:
            gone = threading.Event()
            threading.Timer(0.3, gone.set).start()
            result, took = self.run_pair(loopback_connector(server.port), seconds=5.0, ceiling=8.0,
                                         port=server.port, client_gone=gone.is_set)
            self.assertGreater(result["own"]["audio_bytes"], 0, "it was reading when the page went away")
            self.assertLess(took, 2.0)
            self.assertTrue(result["cancelled"])
            self.wait_idle()
        finally:
            server.close()

    def test_the_slot_stays_taken_until_the_workers_end(self) -> None:
        release = threading.Event()

        def stuck(_connector, _url, _deadline):
            release.wait(10)
            return {}

        try:
            _result, took = self.run_pair(SafeConnector(), seconds=0.2, ceiling=0.5, probe=stuck)
            self.assertLess(took, 1.5)
            self.assertTrue(probe_busy())
            with self.assertRaises(ProbeBusy):
                self.run_pair(SafeConnector(), probe=stuck)
        finally:
            release.set()
        self.wait_idle()

    def test_the_connector_keeps_the_relay_rules(self) -> None:
        base = SafeConnector()
        deadline = Deadline(2)
        connector = DeadlineConnector(base, deadline)
        self.assertIs(connector.address_policy, base.address_policy)
        self.assertIs(connector.ssl_context, base.ssl_context)
        self.assertLessEqual(connector.connect_timeout, 2)
        deadline.stop()
        with self.assertRaises(OSError):
            connector.connect_timeout  # noqa: B018  (raises once the time is up)


class ProbePairTests(unittest.TestCase):
    def test_lookups_that_never_answer_leave_at_most_two_threads(self) -> None:
        release = threading.Event()
        self.addCleanup(release.set)

        def blocking_lookup(host, port):
            release.wait(30)
            return []

        def probe(_connector, url, deadline):
            try:
                abandonable_resolver(blocking_lookup, deadline)("blocked.example", 443)
            except Exception:  # noqa: BLE001 - the lookup timed out, as expected
                pass
            return {}

        busy = 0
        for _ in range(10):
            try:
                probe_pair(None, {"own_url": OWN, "alt_url": ALT}, seconds=0.2, ceiling=0.5,
                           probe=probe, make_connector=lambda base, _d: base)
            except ProbeBusy:
                busy += 1
        lookups = [t for t in threading.enumerate() if t.name == "stream-probe-dns" and t.is_alive()]
        self.assertLessEqual(len(lookups), 2)
        self.assertEqual(busy, 9, "the later requests are answered busy")
        release.set()
        for thread in lookups:
            thread.join(2)
        self.assertFalse(probe_busy(), "free again once the lookups end")

    def test_two_requests_at_once_start_one_pair(self) -> None:
        calls = []
        gate = threading.Event()
        self.addCleanup(gate.set)

        def probe(_connector, url, _deadline):
            calls.append(url)
            gate.wait(5)
            return {}

        second = {}
        original_start = threading.Thread.start
        state = {"done": False}

        def start(thread):
            # The second request arrives between the first one taking the
            # slot and its workers starting.
            if not state["done"] and thread.name == "stream-probe-own":
                state["done"] = True
                try:
                    probe_pair(None, {"own_url": OWN, "alt_url": ALT}, seconds=1, ceiling=2,
                               probe=probe, make_connector=lambda base, _d: base)
                    second["result"] = "started"
                except ProbeBusy:
                    second["result"] = "busy"
            return original_start(thread)

        def release_soon():
            time.sleep(0.3)
            gate.set()

        threading.Thread(target=release_soon, daemon=True).start()
        with mock.patch.object(threading.Thread, "start", start):
            probe_pair(None, {"own_url": OWN, "alt_url": ALT}, seconds=1, ceiling=2,
                       probe=probe, make_connector=lambda base, _d: base)
        self.assertEqual(second.get("result"), "busy")
        self.assertEqual(len(calls), 2, "one pair only")
        for _ in range(50):
            if not probe_busy():
                break
            time.sleep(0.05)
        self.assertFalse(probe_busy())

    def test_both_streams_are_probed(self) -> None:
        connector = FakeConnector({OWN: station_response(), ALT: station_response(bitrate="320")})
        result = probe_pair(connector, {"own_url": OWN, "alt_url": ALT}, make_connector=lambda base, _d: base)
        self.assertEqual(result["own"]["bitrate"], 128)
        self.assertEqual(result["alt"]["bitrate"], 320)
        self.assertEqual(result["own"]["title"], result["alt"]["title"])

    def test_only_two_different_web_addresses(self) -> None:
        connector = FakeConnector({})
        for payload in (
            None, [], {"own_url": OWN}, {"own_url": OWN, "alt_url": ALT, "extra": 1},
            {"own_url": OWN, "alt_url": OWN}, {"own_url": OWN, "alt_url": "file:///C:/x"},
            {"own_url": OWN, "alt_url": "https://user:pw@hq.jazzfm.example/"},
            {"own_url": OWN, "alt_url": "https://hq.jazzfm.example/" + "a" * 3000},
        ):
            with self.assertRaises(ValueError):
                probe_pair(connector, payload)
        self.assertEqual(connector.calls, [])
        self.assertEqual(valid_stream_url(" https://a.example/x "), "https://a.example/x")


class RelayHttpsTests(unittest.TestCase):
    def test_registration_takes_require_https_as_a_boolean_only(self) -> None:
        registry = MediaRegistry(connector=loopback_connector(1))
        base = {"item_id": "radio-browser:x", "url": "https://a.example/s.mp3", "delivery": "live",
                "media_type": "audio"}
        self.assertFalse(registry.register(base).require_https)
        self.assertTrue(registry.register({**base, "require_https": True}).require_https)
        with self.assertRaises(MediaError):
            registry.register({**base, "require_https": "yes"})

    def test_a_verified_stream_that_redirects_to_http_fails(self) -> None:
        registry = MediaRegistry(connector=loopback_connector(1))
        registration = registry.register({"item_id": "radio-browser:x", "url": "https://a.example/s.mp3",
                                          "delivery": "live", "media_type": "audio", "require_https": True})
        plain = FakeUpstream(station_response(), "http://a.example/s.mp3")
        with mock.patch.object(worldmedia_server, "_open_relay_upstream", return_value=(plain, None)):
            with self.assertRaises(MediaError) as caught:
                worldmedia_server.open_relay_upstream(registration, "GET", {}, ask_icy=False)
        self.assertEqual(caught.exception.code, "MEDIA_HTTPS_REQUIRED")
        self.assertTrue(plain.closed)
        registration.require_https = False
        with mock.patch.object(worldmedia_server, "_open_relay_upstream", return_value=(plain, None)):
            self.assertIs(worldmedia_server.open_relay_upstream(registration, "GET", {}, ask_icy=False)[0], plain)


class ManifestChildrenHttpsTests(unittest.TestCase):
    """A root registered with require_https passes it to every HLS child and
    DASH segment, and a child redirected to http is refused like the root."""

    @staticmethod
    def registry() -> MediaRegistry:
        connector = SafeConnector(
            resolver=lambda _host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))],
            address_policy=lambda _address: True,
        )
        return MediaRegistry(connector, ttl_seconds=60)

    def refused(self, registration) -> None:
        plain = FakeUpstream(station_response(), "http://cdn.example/redirected.ts")
        with mock.patch.object(worldmedia_server, "_open_relay_upstream", return_value=(plain, None)):
            with self.assertRaises(MediaError) as caught:
                worldmedia_server.open_relay_upstream(registration, "GET", {}, ask_icy=False)
        self.assertEqual(caught.exception.code, "MEDIA_HTTPS_REQUIRED")

    def allowed(self, registration) -> None:
        plain = FakeUpstream(station_response(), "http://cdn.example/redirected.ts")
        with mock.patch.object(worldmedia_server, "_open_relay_upstream", return_value=(plain, None)):
            self.assertIs(worldmedia_server.open_relay_upstream(registration, "GET", {}, ask_icy=False)[0], plain)

    def hls_children(self, flag):
        registry = self.registry()
        payload = {"item_id": "iptv:x", "url": "https://cdn.example/live/index.m3u8", "delivery": "live",
                   "media_type": "hls"}
        if flag:
            payload["require_https"] = True
        root = registry.register(payload)
        text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n#EXTINF:6,\nseg-2.ts\n"
        rewritten = rewrite_hls_manifest(text, root.url, root, registry)
        tokens = re.findall(r"/api/v1/media/([A-Za-z0-9_-]{22,128})", rewritten)
        self.assertEqual(len(tokens), 2)
        return [registry.get(token) for token in tokens]

    def dash_segment(self, flag):
        registry = self.registry()
        payload = {"item_id": "iptv:d", "url": "https://cdn.example/dash/manifest.mpd", "delivery": "live",
                   "media_type": "dash"}
        if flag:
            payload["require_https"] = True
        root = registry.register(payload)
        manifest = ('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period><AdaptationSet>'
                    '<SegmentTemplate media="chunk-$RepresentationID$-$Number$.m4s" initialization="init.mp4" />'
                    '<Representation id="v1" bandwidth="1000" /></AdaptationSet></Period></MPD>')
        rewritten = rewrite_dash_manifest(manifest, root.url, root, registry).decode("utf-8")
        relay = re.search(r'media="(/api/v1/dash/[^"]+)"', rewritten).group(1).replace("&amp;", "&")
        expanded = relay.replace("$RepresentationID$", "v1").replace("$Number$", "7")
        split = urllib.parse.urlsplit(expanded)
        token = split.path.rsplit("/", 1)[-1].split(".", 1)[0]
        return registry.expand_dash_template(token, split.query)

    def test_hls_children_keep_the_https_requirement(self) -> None:
        for child in self.hls_children(True):
            self.assertTrue(child.require_https)
            self.refused(child)

    def test_dash_segments_keep_the_https_requirement(self) -> None:
        segment = self.dash_segment(True)
        self.assertTrue(segment.require_https)
        self.refused(segment)

    def test_without_the_flag_children_behave_as_before(self) -> None:
        for child in self.hls_children(False):
            self.assertFalse(child.require_https)
            self.allowed(child)
        segment = self.dash_segment(False)
        self.assertFalse(segment.require_https)
        self.allowed(segment)


class ProbeRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        cls.port = cls.server.server_port
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method: str, path: str, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, path, skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response, payload

    def setUp(self) -> None:
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        _response, payload = self.request("GET", "/api/v1/session")
        self.headers = {"Origin": self.origin, "X-WorldMedia-Token": payload["data"]["token"],
                        "Content-Type": "application/json"}

    def test_route_needs_the_session_token_and_post(self) -> None:
        connector = FakeConnector({OWN: station_response(), ALT: station_response(bitrate="320")})
        body = json.dumps({"own_url": OWN, "alt_url": ALT}).encode()
        with mock.patch.object(worldmedia_server.MEDIA_REGISTRY, "connector", connector), \
                mock.patch.object(probe_module, "DeadlineConnector", lambda base, _deadline: base):
            response, _payload = self.request("POST", "/api/v1/streams/probe",
                                              {"Origin": self.origin, "Content-Type": "application/json"}, body)
            self.assertEqual(response.status, HTTPStatus.FORBIDDEN)
            self.assertEqual(connector.calls, [])
            response, _payload = self.request("GET", "/api/v1/streams/probe",
                                              {"X-WorldMedia-Token": self.headers["X-WorldMedia-Token"]})
            self.assertEqual(response.status, HTTPStatus.METHOD_NOT_ALLOWED)
            response, payload = self.request("POST", "/api/v1/streams/probe", self.headers,
                                             json.dumps({"own_url": OWN, "alt_url": "ftp://x/"}).encode())
            self.assertEqual(response.status, HTTPStatus.BAD_REQUEST)
            self.assertEqual(payload["error"]["code"], "INVALID_STREAM_PROBE")

    def test_busy_is_a_conflict(self) -> None:
        body = json.dumps({"own_url": OWN, "alt_url": ALT}).encode()
        release = threading.Event()
        stuck = threading.Thread(target=release.wait, args=(10,), daemon=True)
        stuck.start()
        with probe_module._SLOT_LOCK:
            probe_module._RESOLVERS.append(stuck)
        try:
            response, payload = self.request("POST", "/api/v1/streams/probe", self.headers, body)
        finally:
            release.set()
            stuck.join(2)
        self.assertEqual(response.status, HTTPStatus.CONFLICT)
        self.assertEqual(payload["error"]["code"], "STREAM_PROBE_BUSY")


if __name__ == "__main__":
    unittest.main()
