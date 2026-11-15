from __future__ import annotations

import socket
import struct
import http.client
import json
import re
import threading
import time
import unittest
import urllib.parse
import xml.etree.ElementTree as ET
from unittest import mock

import worldmedia_server
from tests_python.fixture_server import AUDIO_BYTES, LARGE_BYTES, SEGMENT_BYTES, VIDEO_BYTES, MediaFixtureServer
from worldmedia_media import (
    LIVE_CHILD_EVICTION_BATCH,
    LIVE_CHILD_MIN_RETENTION_SECONDS,
    LIVE_CHILD_SOFT_LIMIT,
    MAX_CHILDREN_PER_ROOT,
    MediaError,
    MediaRegistry,
    ResolvedTarget,
    SafeConnector,
    Upstream,
    _PinnedHTTPSConnection,
    is_live_hls_media_playlist,
    resolve_target,
    rewrite_hls_manifest,
    rewrite_dash_manifest,
    sanitize_capture_headers,
    select_hls_recording_variant,
)


def answer(address: str, port: int = 443):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (address, port))]


class MediaSecurityTests(unittest.TestCase):
    def test_hls_recording_variant_selection_is_kind_and_profile_aware(self) -> None:
        manifest = '''#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640829,mp4a.40.2"
video/high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.640829,mp4a.40.2"
video/medium.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=176000,CODECS="mp4a.40.2"
audio/main.m3u8
'''
        root = "https://media.example/live/master.m3u8"
        self.assertEqual(
            select_hls_recording_variant(manifest, root, recording_kind="video", max_height=480),
            "https://media.example/live/video/medium.m3u8",
        )
        self.assertEqual(
            select_hls_recording_variant(manifest, root, recording_kind="video", max_height=720),
            "https://media.example/live/video/medium.m3u8",
        )
        self.assertEqual(
            select_hls_recording_variant(manifest, root, recording_kind="video", max_height=1080),
            "https://media.example/live/video/high.m3u8",
        )
        self.assertEqual(
            select_hls_recording_variant(manifest, root, recording_kind="audio", max_height=720),
            "https://media.example/live/audio/main.m3u8",
        )
        self.assertEqual(
            select_hls_recording_variant(
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\naudio/low.m3u8\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=128000\naudio/high.m3u8\n",
                root,
                recording_kind="audio",
                max_height=720,
            ),
            "https://media.example/live/audio/high.m3u8",
        )
        self.assertEqual(
            select_hls_recording_variant(
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1\"\nfile:///private.m3u8\n",
                root,
                recording_kind="video",
                max_height=720,
            ),
            "",
        )

    def test_url_validation_rejects_local_encoded_credentials_and_schemes(self) -> None:
        private_cases = [
            "http://127.0.0.1/media", "http://[::1]/media",
            "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/media",
        ]
        for url in private_cases:
            host = url.split("//", 1)[1].split("/", 1)[0].strip("[]")
            address = host.split("]", 1)[0].lstrip("[")
            with self.subTest(url=url), self.assertRaises(MediaError):
                resolve_target(url, lambda _host, port, address=address: answer(address, port))
        for url in (
            "file:///etc/passwd", "ftp://example.test/media",
            "https://user:password@example.test/media", "https://%31%32%37.0.0.1/media",
        ):
            with self.subTest(url=url), self.assertRaises(MediaError):
                resolve_target(url, lambda _host, port: answer("93.184.216.34", port))

    def test_dns_sets_must_be_entirely_global_and_are_rechecked(self) -> None:
        mixed = lambda _host, port: answer("93.184.216.34", port) + answer("127.0.0.1", port)
        with self.assertRaises(MediaError):
            resolve_target("https://example.test/media", mixed)
        calls = 0

        def rebinding(_host, port):
            nonlocal calls
            calls += 1
            return answer("93.184.216.34" if calls == 1 else "127.0.0.1", port)

        connector = SafeConnector(resolver=rebinding)
        connector.resolve("https://example.test/media")
        with self.assertRaises(MediaError):
            connector.resolve("https://example.test/media")

    def test_registration_headers_tokens_expiry_and_hls_children_are_opaque(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        registry = MediaRegistry(connector, ttl_seconds=60)
        registration = registry.register({
            "item_id": "fixture:item",
            "url": "http://fixture.test/hls/master.m3u8?secret=one",
            "delivery": "on-demand",
            "media_type": "hls",
            "recording_kind": "video",
            "capture_headers": {
                "referer": "https://catalog.example/item",
                "userAgent": "Fixture/1",
                "authorization": "secret",
            },
        })
        self.assertNotIn("fixture.test", registration.public_data()["relay_url"])
        self.assertNotIn("secret", registration.public_data()["relay_url"])
        self.assertEqual(registration.headers, {
            "Referer": "https://catalog.example/item", "User-Agent": "Fixture/1",
        })
        self.assertEqual(registration.recording_kind, "video")
        manifest = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8?key=two"
#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?token=three"
#EXT-X-STREAM-INF:BANDWIDTH=1000
video/index.m3u8
"""
        rewritten = rewrite_hls_manifest(manifest, registration.url, registration, registry)
        self.assertNotIn("fixture.test", rewritten)
        self.assertNotIn("key=two", rewritten)
        self.assertNotIn("token=three", rewritten)
        self.assertEqual(rewritten.count("/api/v1/media/"), 3)
        self.assertIn(".m3u8", rewritten)
        self.assertIn(".bin", rewritten)
        registry.expire(registration.token)
        with self.assertRaises(MediaError):
            registry.get(registration.token)

    def test_registry_and_per_manifest_children_are_hard_bounded(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        registry = MediaRegistry(connector, ttl_seconds=60)

        def payload(index: int, media_type: str = "audio") -> dict:
            return {
                "item_id": f"fixture:bounded:{index}",
                "url": f"http://fixture.test/media/{index}.mp3",
                "delivery": "on-demand", "media_type": media_type,
                "capture_headers": {}, "title": f"Bounded {index}",
            }

        with mock.patch("worldmedia_media.MAX_REGISTRATIONS", 3):
            for index in range(3):
                registry.register(payload(index))
            with self.assertRaises(MediaError) as full:
                registry.register(payload(4))
            self.assertEqual(full.exception.code, "MEDIA_REGISTRY_FULL")
        registry.clear()

        root = registry.register(payload(10, "hls"))
        with mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", 2):
            registry.child(root, "http://fixture.test/media/one.ts")
            registry.child(root, "http://fixture.test/media/two.ts")
            with self.assertRaises(MediaError) as too_many:
                registry.child(root, "http://fixture.test/media/three.ts")
            self.assertEqual(too_many.exception.code, "HLS_CHILD_LIMIT")

    def test_large_media_registry_prunes_with_heap_and_constant_time_child_counts(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        now = [1_000.0]
        with mock.patch("worldmedia_media.time.time", side_effect=lambda: now[0]):
            registry = MediaRegistry(connector, ttl_seconds=60)
            root = registry.register({
                "item_id": "fixture:large-hls",
                "url": "http://fixture.test/media/master.m3u8",
                "delivery": "on-demand",
                "media_type": "hls",
                "capture_headers": {},
            })
            for index in range(500):
                registry.child(root, f"http://fixture.test/media/{index}.ts")
            self.assertEqual(registry._root_child_counts[root.token], 500)
            self.assertEqual(len(registry._expiry_heap), 501)

            now[0] += 61
            with self.assertRaises(MediaError):
                registry.get(root.token)
            self.assertEqual(registry._entries, {})
            self.assertEqual(registry._child_index, {})
            self.assertEqual(registry._root_child_counts, {})
            self.assertEqual(registry._expiry_heap, [])

    def test_dash_templates_are_opaque_allowlisted_and_expire_with_the_root(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        registry = MediaRegistry(connector, ttl_seconds=60)
        registration = registry.register({
            "item_id": "fixture:dash", "url": "http://fixture.test/dash/manifest.mpd?catalog=secret",
            "delivery": "live", "media_type": "dash", "capture_headers": {},
        })
        manifest = '''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
<Location>alternate.mpd?location=secret</Location><Metrics metrics="buffer"><Reporting
schemeIdUri="urn:dvb:dash:reporting:2014" value="https://telemetry.example/collect" /></Metrics><Period>
<AdaptationSet><SegmentTemplate media="chunk-$RepresentationID$-$Number%05d$.m4s?token=secret"
initialization="init-$RepresentationID$.mp4" />
<Representation id="safe-v1" bandwidth="1000" /></AdaptationSet></Period></MPD>'''
        rewritten = rewrite_dash_manifest(
            manifest, registration.url, registration, registry,
        ).decode("utf-8")
        self.assertNotIn("fixture.test", rewritten)
        self.assertNotIn("token=secret", rewritten)
        self.assertNotIn("location=secret", rewritten)
        self.assertNotIn("telemetry.example", rewritten)
        root = ET.fromstring(rewritten)
        template_element = next(element for element in root.iter() if element.tag.endswith("SegmentTemplate"))
        relay_template = template_element.attrib["media"]
        self.assertRegex(relay_template, r"^/api/v1/dash/[A-Za-z0-9_-]+\.m4s\?")
        expanded_path = relay_template.replace("$RepresentationID$", "safe-v1").replace("$Number%05d$", "00007")
        split = urllib.parse.urlsplit(expanded_path)
        token = split.path.rsplit("/", 1)[-1].split(".", 1)[0]
        expanded = registry.expand_dash_template(token, split.query)
        self.assertEqual(
            expanded.url,
            "http://fixture.test/dash/chunk-safe-v1-00007.m4s?token=secret",
        )
        rejected_query = split.query.replace("safe-v1", "../private")
        with self.assertRaises(MediaError) as rejected:
            registry.expand_dash_template(token, rejected_query)
        self.assertEqual(rejected.exception.code, "DASH_VALUE_REJECTED")
        with self.assertRaises(MediaError) as unexpected:
            registry.expand_dash_template(token, split.query + "&url=http%3A%2F%2Flocalhost")
        self.assertEqual(unexpected.exception.code, "INVALID_DASH_PARAMETERS")
        registry.expire(registration.token)
        with self.assertRaises(MediaError) as expired:
            registry.expand_dash_template(token, split.query)
        self.assertEqual(expired.exception.code, "DASH_TEMPLATE_EXPIRED")

    def test_dash_xml_rejects_drm_entities_xlinks_and_host_placeholders(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        registry = MediaRegistry(connector, ttl_seconds=60)
        registration = registry.register({
            "item_id": "fixture:dash-security", "url": "http://fixture.test/manifest.mpd",
            "delivery": "live", "media_type": "dash", "capture_headers": {},
        })
        cases = [
            ('''<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:test" />
              <Representation id="v" bandwidth="1" /></AdaptationSet></Period></MPD>''', "DASH_DRM_UNSUPPORTED"),
            ('''<!DOCTYPE MPD [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><MPD>&xxe;</MPD>''', "UNSAFE_DASH_XML"),
            ('''<MPD xmlns:xlink="http://www.w3.org/1999/xlink"><Period xlink:href="https://example.test/external" /></MPD>''', "DASH_XLINK_UNSUPPORTED"),
            ('''<MPD><Period><AdaptationSet><SegmentTemplate media="https://$RepresentationID$.example/seg-$Number$.m4s" />
              <Representation id="v" bandwidth="1" /></AdaptationSet></Period></MPD>''', "INVALID_DASH_TEMPLATE"),
            ("<MPD>" + "<Period>" * 66 + "</Period>" * 66 + "</MPD>", "DASH_MANIFEST_TOO_COMPLEX"),
            ("<MPD><Period><AdaptationSet><SegmentTemplate media=\"seg-$RepresentationID$.m4s\"/>"
             + "".join(f'<Representation id="r{index}" bandwidth="{index + 1}"/>' for index in range(257))
             + "</AdaptationSet></Period></MPD>", "DASH_MANIFEST_TOO_COMPLEX"),
        ]
        for xml, code in cases:
            with self.subTest(code=code), self.assertRaises(MediaError) as rejected:
                rewrite_dash_manifest(xml, registration.url, registration, registry)
            self.assertEqual(rejected.exception.code, code)

    def test_dash_segment_templates_respect_representation_specific_base_urls(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        registry = MediaRegistry(connector, ttl_seconds=60)
        registration = registry.register({
            "item_id": "fixture:dash-bases", "url": "http://fixture.test/root/manifest.mpd",
            "delivery": "live", "media_type": "dash", "capture_headers": {},
        })
        manifest = '''<MPD><Period><AdaptationSet>
<SegmentTemplate media="segment-$Number$.m4s" initialization="init-$RepresentationID$.mp4" />
<Representation id="one" bandwidth="1000"><BaseURL>quality-one/</BaseURL></Representation>
<Representation id="two" bandwidth="2000"><BaseURL>quality-two/</BaseURL></Representation>
</AdaptationSet></Period></MPD>'''
        root = ET.fromstring(rewrite_dash_manifest(
            manifest, registration.url, registration, registry,
        ))
        template = next(element for element in root.iter() if element.tag.endswith("SegmentTemplate"))
        relay = template.attrib["media"]
        self.assertIn("wm_r=$RepresentationID$", relay)
        for representation_id, directory in (("one", "quality-one"), ("two", "quality-two")):
            expanded_path = relay.replace("$Number$", "8").replace("$RepresentationID$", representation_id)
            split = urllib.parse.urlsplit(expanded_path)
            token = split.path.rsplit("/", 1)[-1].split(".", 1)[0]
            expanded = registry.expand_dash_template(token, split.query)
            self.assertEqual(
                expanded.url,
                f"http://fixture.test/root/{directory}/segment-8.m4s",
            )

    def test_header_sanitizer_drops_line_injection_and_private_names(self) -> None:
        self.assertEqual(sanitize_capture_headers({
            "referer": "https://good.example/\r\nX-Evil: yes",
            "userAgent": "Good/1",
            "cookie": "secret",
        }), {"User-Agent": "Good/1"})

    def test_https_dials_the_validated_ip_but_verifies_the_original_hostname(self) -> None:
        target = ResolvedTarget(
            "https://media.example/file", "https", "media.example", 443,
            "/file", "93.184.216.34",
        )
        raw_socket = mock.Mock()
        wrapped_socket = mock.Mock()
        context = mock.Mock()
        context.wrap_socket.return_value = wrapped_socket
        connection = _PinnedHTTPSConnection(target, 3.5, context)
        with mock.patch("worldmedia_media.socket.create_connection", return_value=raw_socket) as dial:
            connection.connect()
        dial.assert_called_once_with(("93.184.216.34", 443), 3.5)
        context.wrap_socket.assert_called_once_with(raw_socket, server_hostname="media.example")
        self.assertIs(connection.sock, wrapped_socket)

    def test_connector_falls_back_across_every_validated_dns_address(self) -> None:
        with MediaFixtureServer() as fixture:
            port = urllib.parse.urlsplit(fixture.base_url).port

            def resolver(_host: str, _port: int):
                return answer("127.0.0.2", port) + answer("127.0.0.1", port)

            connector = SafeConnector(
                resolver=resolver,
                address_policy=lambda _address: True,
                connect_timeout=0.5,
            )
            upstream = connector.open(f"http://media.example:{port}/media/audio.mp3")
            try:
                self.assertEqual(upstream.response.status, 200)
                self.assertEqual(upstream.response.read(), AUDIO_BYTES)
            finally:
                upstream.close()

    def test_stream_iteration_is_bounded_and_cancellable(self) -> None:
        response = mock.Mock()
        response.read.side_effect = [b"x" * 2048, b""]
        upstream = Upstream(response, mock.Mock(), "https://media.example/file")
        self.assertEqual(list(upstream.iter_chunks(chunk_size=10_000_000)), [b"x" * 2048])
        response.read.assert_called_with(64 * 1024)
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(MediaError) as error:
            list(upstream.iter_chunks(cancel=cancelled))
        self.assertEqual(error.exception.code, "MEDIA_CANCELLED")

    def test_redirect_revalidates_the_destination_address(self) -> None:
        with MediaFixtureServer() as fixture:
            resolutions = 0

            def policy(_address: str) -> bool:
                nonlocal resolutions
                resolutions += 1
                return resolutions == 1

            connector = SafeConnector(address_policy=policy)
            with self.assertRaises(MediaError) as rejected:
                connector.open(f"{fixture.base_url}/redirect/private")
            self.assertEqual(rejected.exception.code, "NON_GLOBAL_MEDIA_TARGET")


class RelayIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = MediaFixtureServer()
        cls.fixture.__enter__()
        connector = SafeConnector(address_policy=lambda _address: True, idle_timeout=1)
        cls.registry = MediaRegistry(connector, ttl_seconds=60)
        cls.old_registry = worldmedia_server.MEDIA_REGISTRY
        worldmedia_server.MEDIA_REGISTRY = cls.registry
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
        worldmedia_server.MEDIA_REGISTRY = cls.old_registry
        cls.fixture.__exit__(None, None, None)

    def setUp(self) -> None:
        # The metadata limiter is process-global because production owns one
        # server. Tests create several independent fixture servers in the same
        # process, so isolate them just as ControlApiTests does. This also
        # prevents the deliberate limiter-exhaustion test from poisoning later
        # relay cases when the suite order is reversed.
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        response, payload, _headers = self.request("GET", "/api/v1/session")
        self.assertEqual(response, 200)
        self.token = payload["data"]["token"]

    def request(self, method: str, path: str, *, headers=None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        status = response.status
        response_headers = dict(response.getheaders())
        content_type = response.getheader("Content-Type", "")
        connection.close()
        payload = json.loads(raw) if content_type.startswith("application/json") else raw
        return status, payload, response_headers

    def register(self, path: str, media_type: str = "audio", capture_headers=None) -> dict:
        body = json.dumps({
            "item_id": f"fixture:{path}",
            "url": f"{self.fixture.base_url}{path}",
            "delivery": "on-demand",
            "media_type": media_type,
            "capture_headers": capture_headers or {},
        }).encode()
        status, payload, _headers = self.request("POST", "/api/v1/media/register", headers={
            "Origin": self.origin,
            "X-WorldMedia-Token": self.token,
            "Content-Type": "application/json",
        }, body=body)
        self.assertEqual(status, 201, payload)
        return payload["data"]

    def test_finite_head_range_redirect_and_required_headers(self) -> None:
        media = self.register("/media/audio.mp3")
        status, body, headers = self.request("HEAD", media["relay_url"])
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(headers["Content-Length"]), len(AUDIO_BYTES))
        status, body, headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=4-12"})
        self.assertEqual(status, 206)
        self.assertEqual(body, AUDIO_BYTES[4:13])
        self.assertEqual(headers["Content-Range"], f"bytes 4-12/{len(AUDIO_BYTES)}")

        redirected = self.register("/redirect/public")
        self.assertEqual(self.request("GET", redirected["relay_url"])[1], AUDIO_BYTES)
        protected = self.register("/protected", capture_headers={
            "referer": "https://catalog.example/item", "userAgent": "WorldMediaFixture/1",
            "cookie": "must-not-pass",
        })
        self.assertEqual(self.request("GET", protected["relay_url"])[1], b"allowed")
        with self.fixture.state.lock:
            last = next(entry for entry in reversed(self.fixture.state.requests) if entry["path"] == "/protected")
        self.assertNotIn("Cookie", last["headers"])

        interrupted = self.register("/interrupted")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        connection.request("GET", interrupted["relay_url"])
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        with self.assertRaises(http.client.IncompleteRead) as incomplete:
            response.read()
        self.assertEqual(incomplete.exception.partial, b"partial")
        connection.close()

    def test_nested_hls_is_rewritten_opaque_and_children_work(self) -> None:
        master = self.register("/hls/master.m3u8?catalog=secret", "hls")
        zero_status, zero_body, _zero_headers = self.request(
            "GET", master["relay_url"], headers={"Range": "bytes=0-"},
        )
        self.assertEqual(zero_status, 200)
        self.assertTrue(zero_body.startswith(b"#EXTM3U"))
        rejected_status, rejected_body, _rejected_headers = self.request(
            "GET", master["relay_url"], headers={"Range": "bytes=1-"},
        )
        self.assertEqual(rejected_status, 416)
        self.assertEqual(rejected_body["error"]["code"], "HLS_RANGE_REJECTED")
        status, body, _headers = self.request("GET", master["relay_url"])
        self.assertEqual(status, 200)
        text = body.decode()
        self.assertNotIn(self.fixture.base_url, text)
        self.assertNotIn("secret", text)
        child_paths = re.findall(r"/api/v1/media/[A-Za-z0-9_-]+(?:\.[a-z0-9]+)?", text)
        self.assertEqual(len(set(child_paths)), 2)
        self.assertTrue(all(path.endswith(".m3u8") for path in child_paths))
        rejected_suffix = child_paths[0].rsplit(".", 1)[0] + ".exe"
        rejected_status, rejected_payload, _headers = self.request("GET", rejected_suffix)
        self.assertEqual(rejected_status, 403)
        self.assertEqual(rejected_payload["error"]["code"], "INVALID_TOKEN")
        status, media_body, _headers = self.request("GET", child_paths[0])
        self.assertEqual(status, 200)
        rewritten_media = media_body.decode()
        resource_paths = re.findall(r"/api/v1/media/[A-Za-z0-9_-]+(?:\.[a-z0-9]+)?", rewritten_media)
        self.assertEqual(len(set(resource_paths)), 3)
        self.assertNotIn("secret", rewritten_media)
        results = [self.request("GET", path)[1] for path in resource_paths]
        self.assertTrue(any(payload == SEGMENT_BYTES for payload in results))

    def test_dash_manifest_templates_static_urls_ranges_and_security(self) -> None:
        manifest = self.register("/dash/manifest.mpd?catalog=secret", "dash")
        status, body, headers = self.request("GET", manifest["relay_url"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/dash+xml")
        text = body.decode("utf-8")
        self.assertNotIn(self.fixture.base_url, text)
        self.assertNotIn("secret", text)
        root = ET.fromstring(text)
        template = next(element for element in root.iter() if element.tag.endswith("SegmentTemplate"))
        media_template = template.attrib["media"]
        self.assertTrue(media_template.startswith("/api/v1/dash/"))
        segment_path = media_template.replace("$RepresentationID$", "v1").replace("$Number%05d$", "00001")
        status, segment, range_headers = self.request(
            "GET", segment_path, headers={"Range": "bytes=1-3"},
        )
        self.assertEqual(status, 206)
        self.assertEqual(segment, SEGMENT_BYTES[1:4])
        self.assertEqual(range_headers["Content-Range"], f"bytes 1-3/{len(SEGMENT_BYTES)}")

        static_urls = []
        for element in root.iter():
            for attribute in ("sourceURL", "media"):
                value = element.attrib.get(attribute, "")
                if value.startswith("/api/v1/media/"):
                    static_urls.append(value)
        self.assertGreaterEqual(len(static_urls), 2)
        self.assertIn(self.request("GET", static_urls[0])[1], {VIDEO_BYTES, SEGMENT_BYTES})

        denied_path = segment_path.replace("wm_r=v1", "wm_r=not-allowed")
        denied_status, denied, _headers = self.request("GET", denied_path)
        self.assertEqual(denied_status, 403)
        self.assertEqual(denied["error"]["code"], "DASH_VALUE_REJECTED")

        for path, expected_status, expected_code in (
            ("/dash/drm.mpd", 422, "DASH_DRM_UNSUPPORTED"),
            ("/dash/unsafe.mpd", 502, "UNSAFE_DASH_XML"),
        ):
            rejected = self.register(path, "dash")
            rejected_status, payload, _headers = self.request("GET", rejected["relay_url"])
            self.assertEqual(rejected_status, expected_status)
            self.assertEqual(payload["error"]["code"], expected_code)

    def test_slow_consumer_is_complete_and_independent_from_metadata_rate_limit(self) -> None:
        media = self.register("/media/large.bin")
        for _index in range(worldmedia_server.RATE_MAX_PER_WINDOW + 2):
            self.request("GET", "/api/health")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", media["relay_url"])
        response = connection.getresponse()
        chunks = []
        while True:
            chunk = response.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
            time.sleep(0.0005)
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(b"".join(chunks), LARGE_BYTES)
        self.assertLessEqual(worldmedia_server.RELAY_CHUNK_SIZE, 64 * 1024)

    def test_endless_disconnect_cancels_upstream_and_expiry_revokes_token(self) -> None:
        self.fixture.state.stream_cancelled.clear()
        stream = self.register("/stream/endless")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", stream["relay_url"])
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertTrue(response.read(64))
        client_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if client_socket:
            client_socket.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            client_socket.shutdown(socket.SHUT_RDWR)
        connection.close()
        self.assertTrue(self.fixture.state.stream_cancelled.wait(5))

        body = json.dumps({"grace_seconds": 0}).encode()
        status, payload, _headers = self.request(
            "POST", f"{stream['relay_url']}/expire",
            headers={"Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json"},
            body=body,
        )
        self.assertEqual(status, 200, payload)
        status, payload, _headers = self.request("GET", stream["relay_url"])
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "MEDIA_TOKEN_EXPIRED")


class LiveHlsChildLifetimeTests(unittest.TestCase):
    """Live media playlists slide; old entries go only under pressure, oldest listed first."""

    BASE = "http://fixture.test/live/"
    MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex.m3u8\n"

    def setUp(self) -> None:
        self.now = [1_000.0]
        patcher = mock.patch("worldmedia_media.time.time", side_effect=lambda: self.now[0])
        patcher.start()
        self.addCleanup(patcher.stop)
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        self.registry = MediaRegistry(connector)
        self.root = self.registry.register({
            "item_id": "fixture:live", "url": self.BASE + "master.m3u8",
            "delivery": "live", "media_type": "hls", "capture_headers": {},
        })

    def window(self, first: int, size: int = 6, *, ended: bool = False, extra: str = "") -> str:
        lines = [
            "#EXTM3U", "#EXT-X-TARGETDURATION:6", f"#EXT-X-MEDIA-SEQUENCE:{first}", extra,
            '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"',
        ]
        for index in range(first, first + size):
            lines += ["#EXTINF:6,", f"seg{index}.ts"]
        if ended:
            lines.append("#EXT-X-ENDLIST")
        return "\n".join(line for line in lines if line) + "\n"

    def rewrite(self, text: str) -> str:
        return rewrite_hls_manifest(text, self.BASE + "index.m3u8", self.root, self.registry)

    def entry(self, name: str):
        token = self.registry._child_index.get((self.root.token, self.BASE + name))
        return self.registry._entries.get(token) if token else None

    def count(self) -> int:
        return self.registry._root_child_counts.get(self.root.token, 0)

    def listed(self) -> dict:
        return self.registry._live_listed.get(self.root.token, {})

    def assert_consistent(self) -> None:
        registry = self.registry
        children = set(registry._entries) - {self.root.token}
        self.assertEqual(set(registry._child_keys_by_token), children)
        self.assertEqual(set(registry._child_index.values()), children)
        self.assertEqual(self.count(), len(children))
        for token in self.listed():
            self.assertTrue(registry._entries[token].evictable)
        self.assertEqual(
            {token for token in children if registry._entries[token].evictable}, set(self.listed()),
        )

    def test_playlist_kind_decides_which_entries_are_evictable(self) -> None:
        self.assertTrue(is_live_hls_media_playlist(self.window(0)))
        self.assertTrue(is_live_hls_media_playlist(self.window(0, extra="#EXT-X-PLAYLIST-TYPE:EVENT")))
        self.assertFalse(is_live_hls_media_playlist(self.window(0, ended=True)))
        self.assertFalse(is_live_hls_media_playlist(self.window(0, extra="#EXT-X-PLAYLIST-TYPE:VOD")))
        self.assertFalse(is_live_hls_media_playlist(self.MASTER))

    def test_below_the_soft_limit_nothing_is_evicted_for_the_root_lifetime(self) -> None:
        first_tokens = None
        for first in range(LIVE_CHILD_SOFT_LIMIT - 8 + 1):  # Ends with exactly the soft limit.
            self.rewrite(self.window(first))
            first_tokens = first_tokens or {name: self.entry(name).token for name in ("seg0.ts", "key.bin")}
            self.now[0] += 6
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        self.now[0] = self.root.expires_at - 60  # Hours later, just before the root itself expires.
        self.rewrite(self.window(LIVE_CHILD_SOFT_LIMIT - 8))
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        for token in first_tokens.values():
            entry = self.registry.get(token)
            self.assertEqual(entry.expires_at, self.root.expires_at)  # Exactly the root's lifetime, as before.

    def test_sliding_window_runs_to_five_thousand_segments(self) -> None:
        most = largest_heap = 0
        for first in range(5_000):  # One new 6 s segment per reload; the hard limit is 2,048.
            self.rewrite(self.window(first))
            most = max(most, self.count())
            largest_heap = max(largest_heap, len(self.registry._expiry_heap))
            self.now[0] += 6
        # Retention holds 600 s / 6 s = 100 slid-out segments, far below the soft limit.
        self.assertEqual(most, LIVE_CHILD_SOFT_LIMIT)
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        self.assertIsNone(self.entry("seg0.ts"))
        self.assertIsNotNone(self.entry(f"seg{5_005 - LIVE_CHILD_SOFT_LIMIT + 2}.ts"))
        # Evicted entries leave heap records behind, but the heap is rebuilt before they pile up.
        self.assertLessEqual(largest_heap, 4 * (LIVE_CHILD_SOFT_LIMIT + 1) + 1024 + 8)
        self.assert_consistent()

    def test_entries_listed_within_the_retention_are_kept_over_the_soft_limit(self) -> None:
        step = 0.5  # A very fast stream: two new segments a second.
        for first in range(3_000):
            self.rewrite(self.window(first))
            self.now[0] += step
        held = int(LIVE_CHILD_MIN_RETENTION_SECONDS / step)
        self.assertGreater(self.count(), LIVE_CHILD_SOFT_LIMIT)
        self.assertLessEqual(self.count(), held + 6 + 2 + 1)
        last = 2_999
        for index in range(last - held + 2, last + 6):
            self.assertIsNotNone(self.entry(f"seg{index}.ts"), index)
        self.assert_consistent()

    def test_a_window_larger_than_the_soft_limit_keeps_every_listed_entry(self) -> None:
        for reload in range(20):  # 1,500 listed, ten new every minute.
            first = reload * 10
            self.rewrite(self.window(first, size=1_500))
            self.now[0] += 60
        for index in range(first, first + 1_500):
            self.assertIsNotNone(self.entry(f"seg{index}.ts"), index)
        # Plus what slid out within the retention (ten reloads of ten).
        self.assertLessEqual(self.count(), 1_502 + 100)
        self.assertIsNone(self.entry("seg0.ts"))
        self.assert_consistent()

    def flood(self) -> None:
        """1,102 children listed at once, then six new segments 601 s later."""
        self.rewrite(self.window(0, size=1_100))
        self.assertEqual(self.count(), 1_102)  # All listed just now: nothing evicted.
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
        self.rewrite(self.window(1_100))

    def test_eviction_takes_the_oldest_listed_first_and_stops_at_the_soft_limit(self) -> None:
        self.flood()
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        # 1,108 children; key and map were listed again, so the first 84 segments went.
        for index in range(84):
            self.assertIsNone(self.entry(f"seg{index}.ts"), index)
        for name in ("seg84.ts", "seg1099.ts", "seg1105.ts", "key.bin", "init.mp4"):
            self.assertIsNotNone(self.entry(name), name)
        self.assert_consistent()

    def test_an_evicted_token_is_expired_and_relisting_gets_a_fresh_token(self) -> None:
        old_text = self.rewrite(self.window(0, size=1_100))
        old_path = next(line for line in old_text.splitlines() if line.startswith("/api/v1/media/") and line.endswith(".ts"))
        old_token = old_path.rsplit("/", 1)[-1].split(".", 1)[0]
        self.assertEqual(self.registry.get(old_token).url, self.BASE + "seg0.ts")
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
        self.rewrite(self.window(1_100))
        with self.assertRaises(MediaError) as expired:
            self.registry.get(old_token)
        self.assertEqual(expired.exception.code, "MEDIA_TOKEN_EXPIRED")
        self.rewrite(self.window(0))
        fresh = self.entry("seg0.ts").token
        self.assertNotEqual(fresh, old_token)
        self.assertEqual(self.registry.get(fresh).url, self.BASE + "seg0.ts")
        self.assert_consistent()

    HISTORY = MAX_CHILDREN_PER_ROOT - 596  # Plus key and map, then 600 new: six over the hard limit.

    def test_a_large_rewrite_near_the_hard_limit_makes_room_from_old_history(self) -> None:
        self.rewrite(self.window(0, size=self.HISTORY))
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
        self.rewrite(self.window(self.HISTORY, size=600))
        for index in range(self.HISTORY, self.HISTORY + 600):
            self.assertIsNotNone(self.entry(f"seg{index}.ts"), index)
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        self.assert_consistent()

    def test_a_large_rewrite_without_old_history_fails_before_adding_anything(self) -> None:
        self.rewrite(self.window(0, size=self.HISTORY))
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS - 1
        with self.assertRaises(MediaError) as too_many:
            self.rewrite(self.window(self.HISTORY, size=600))
        self.assertEqual(too_many.exception.code, "HLS_CHILD_LIMIT")
        self.assertEqual(self.count(), self.HISTORY + 2)
        self.assertIsNone(self.entry(f"seg{self.HISTORY + 5}.ts"))
        self.assert_consistent()

    def test_a_window_larger_than_the_hard_limit_still_fails(self) -> None:
        with mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", 5):
            with self.assertRaises(MediaError) as too_many:
                self.rewrite(self.window(0))
        self.assertEqual(too_many.exception.code, "HLS_CHILD_LIMIT")

    def live(self, *names: str) -> str:
        return "#EXTM3U\n#EXT-X-TARGETDURATION:6\n" + "".join(f"#EXTINF:6,\n{name}\n" for name in names)

    def test_a_rewrite_at_the_hard_limit_keeps_the_tokens_it_lists(self) -> None:
        self.rewrite(self.window(0, size=MAX_CHILDREN_PER_ROOT - 2))
        self.assertEqual(self.count(), MAX_CHILDREN_PER_ROOT)
        old = self.entry("seg0.ts").token  # Among the oldest history.
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1  # Say, back from sleep.
        text = self.rewrite(self.live("fresh.ts", "seg0.ts"))
        self.assertEqual(self.entry("seg0.ts").token, old)
        self.assertIn(f"/{old}.", text)
        self.assertIsNotNone(self.entry("fresh.ts"))
        self.assertEqual(self.count(), LIVE_CHILD_SOFT_LIMIT)
        self.assert_consistent()

    def test_a_rewrite_at_the_hard_limit_without_other_history_still_fails(self) -> None:
        self.rewrite(self.window(0, size=MAX_CHILDREN_PER_ROOT - 3, ended=True))  # All but one place permanent.
        self.rewrite(self.live("old.ts"))
        old = self.entry("old.ts").token
        self.assertEqual(self.count(), MAX_CHILDREN_PER_ROOT)
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
        with self.assertRaises(MediaError) as too_many:
            self.rewrite(self.live("fresh.ts", "old.ts"))
        self.assertEqual(too_many.exception.code, "HLS_CHILD_LIMIT")
        self.assertEqual(self.entry("old.ts").token, old)
        self.assertIsNone(self.entry("fresh.ts"))
        self.assert_consistent()

    def test_permanent_children_do_not_count_toward_the_soft_limit(self) -> None:
        # 998 ended segments plus the key and map the live playlist shares: 1,000 permanent.
        self.rewrite(self.window(0, size=998, ended=True).replace("seg", "vod"))
        for first in range(600):
            self.rewrite(self.window(first))
            self.now[0] += 6
        self.assertEqual(len(self.listed()), 605)  # Segments 0-604: nothing evicted yet.
        self.assertIsNotNone(self.entry("seg0.ts"))
        for first in range(600, 1_500):
            self.rewrite(self.window(first))
            self.now[0] += 6
        self.assertEqual(len(self.listed()), LIVE_CHILD_SOFT_LIMIT)
        self.assertEqual(self.count(), 1_000 + LIVE_CHILD_SOFT_LIMIT)
        self.assertIsNotNone(self.entry("vod0.ts"))
        self.assert_consistent()

    def test_the_hard_limit_trims_only_what_is_needed_when_permanent_children_leave_less_room(self) -> None:
        room = 948  # Fewer places than the soft limit.
        permanent = MAX_CHILDREN_PER_ROOT - room
        self.rewrite(self.window(0, size=permanent - 2, ended=True).replace("seg", "vod"))
        fewest = None
        for first in range(1_500):
            self.rewrite(self.window(first))
            self.now[0] += 6
            self.assertLessEqual(self.count(), MAX_CHILDREN_PER_ROOT)
            if first >= room:
                fewest = min(fewest or room, len(self.listed()))
        # Each rewrite's preflight evicts exactly the one place its new segment needs.
        self.assertEqual(fewest, room)
        self.assertIsNotNone(self.entry("vod0.ts"))
        # A child added outside a rewrite (or racing one) trims a batch instead.
        self.registry.child(self.root, self.BASE + "direct.ts", evictable=True)
        self.assertEqual(self.count(), MAX_CHILDREN_PER_ROOT - LIVE_CHILD_EVICTION_BATCH)
        self.assert_consistent()

    def test_touch_creates_nothing_and_ignores_permanent_entries_and_other_roots(self) -> None:
        other = self.registry.register({
            "item_id": "fixture:other", "url": self.BASE + "other.m3u8",
            "delivery": "live", "media_type": "hls", "capture_headers": {},
        })
        rewrite_hls_manifest(self.live("shared.ts"), self.BASE + "index.m3u8", other, self.registry)
        self.rewrite(self.window(0, size=1, ended=True))  # seg0, key and map are permanent here.
        self.rewrite(self.live("seg1.ts"))
        before_other = dict(self.registry._live_listed[other.token])
        before = dict(self.listed())
        entries = len(self.registry._entries)
        self.now[0] += 50
        self.registry.touch_live_children(
            self.root, [self.BASE + name for name in ("shared.ts", "new.ts", "seg0.ts", "key.bin")],
        )
        self.assertEqual(len(self.registry._entries), entries)
        self.assertIsNone(self.entry("new.ts"))
        self.assertIsNone(self.entry("shared.ts"))
        self.assertFalse(self.entry("seg0.ts").evictable)
        self.assertEqual(dict(self.listed()), before)
        self.assertEqual(dict(self.registry._live_listed[other.token]), before_other)
        self.registry.touch_live_children(self.root, [self.BASE + "seg1.ts"])
        self.assertEqual(self.listed()[self.entry("seg1.ts").token], self.now[0])

    def test_each_authority_is_looked_up_once_per_rewrite(self) -> None:
        connector = self.registry.connector
        lookups = []
        policy_checks = []
        answers = {"fixture.test": "203.0.113.5", "cdn.test": "203.0.113.6", "private.test": "10.0.0.1"}

        def resolver(host, port):
            lookups.append((host, port))
            return answer(answers[host], port)

        def policy(address):
            policy_checks.append(address)
            return not address.startswith("10.")

        connector.resolver, connector.address_policy = resolver, policy
        text = self.window(0) + '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
        self.rewrite(text + "http://cdn.test/a.ts\nhttp://cdn.test/b.ts\nhttp://CDN.test:80/c.ts\n")
        self.assertEqual(lookups, [("fixture.test", 80), ("cdn.test", 80)])
        self.assertEqual(len(policy_checks), 8 + 3)  # Every distinct URL is still checked.
        self.rewrite(text)
        self.assertEqual(len(lookups), 3)  # A second rewrite looks up again.
        entries = len(self.registry._entries)
        for listed in ("http://private.test/x.ts\n", "http://private.test/y.ts\nhttp://private.test/x.ts\n"):
            with self.assertRaises(MediaError) as refused:
                self.rewrite(text + listed)
            self.assertEqual(refused.exception.code, "NON_GLOBAL_MEDIA_TARGET")
        with self.assertRaises(MediaError) as refused:
            connector.resolve_batch(["http://private.test/y.ts"])
        self.assertEqual(refused.exception.code, "NON_GLOBAL_MEDIA_TARGET")
        self.assertEqual(len(self.registry._entries), entries)

    def test_a_playlist_that_cannot_fit_adds_nothing(self) -> None:
        self.rewrite(self.MASTER)
        shared = self.entry("index.m3u8").token
        vod = self.window(0, size=MAX_CHILDREN_PER_ROOT - 2, ended=True) + "index.m3u8\n"
        with self.assertRaises(MediaError) as too_many:
            self.rewrite(vod)  # The shared playlist plus 4,096 new entries: one too many.
        self.assertEqual(too_many.exception.code, "HLS_CHILD_LIMIT")
        self.assertEqual(self.count(), 1)
        self.assertEqual(len(self.registry._entries), 2)
        self.assertEqual(self.entry("index.m3u8").token, shared)
        # Exactly filling the root still works, the shared entry included.
        self.rewrite(self.window(0, size=MAX_CHILDREN_PER_ROOT - 3, ended=True) + "index.m3u8\n")
        self.assertEqual(self.count(), MAX_CHILDREN_PER_ROOT)
        self.assertEqual(self.entry("index.m3u8").token, shared)

    def test_a_playlist_that_would_fill_the_registry_adds_nothing(self) -> None:
        self.rewrite(self.MASTER)
        before = len(self.registry._entries)
        with mock.patch("worldmedia_media.MAX_REGISTRATIONS", before + 8):
            with self.assertRaises(MediaError) as full:
                self.rewrite(self.window(0, size=7))  # Nine new entries, eight places.
            self.assertEqual(full.exception.code, "MEDIA_REGISTRY_FULL")
            self.assertEqual(len(self.registry._entries), before)
            self.rewrite(self.window(0, size=6))  # Eight new entries fit exactly.
        self.assertEqual(len(self.registry._entries), before + 8)

    def test_concurrent_rewrites_that_only_one_can_fit_never_mix(self) -> None:
        connector = self.registry.connector
        resolve_batch = connector.resolve_batch
        both_resolved = threading.Barrier(2, timeout=5)

        def resolve_then_meet(urls):
            targets = resolve_batch(urls)
            both_resolved.wait()  # Both rewrites reach registration together.
            return targets

        results: dict[str, object] = {}

        def rewrite(prefix: str) -> None:
            text = self.window(0, ended=True).replace("seg", prefix).replace("key", prefix).replace("init", prefix)
            try:
                results[prefix] = self.rewrite(text)
            except MediaError as error:
                results[prefix] = error

        with mock.patch.object(connector, "resolve_batch", side_effect=resolve_then_meet), \
                mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", 10):
            threads = [threading.Thread(target=rewrite, args=(prefix,)) for prefix in ("a", "b")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
        failed = [prefix for prefix, value in results.items() if isinstance(value, MediaError)]
        self.assertEqual(len(results), 2)
        self.assertEqual(len(failed), 1)
        self.assertEqual(results[failed[0]].code, "HLS_CHILD_LIMIT")
        winner = "b" if failed == ["a"] else "a"
        self.assertEqual(self.count(), 8)
        self.assertIsNotNone(self.entry(f"{winner}0.ts"))
        self.assertFalse(any(self.entry(f"{failed[0]}{index}.ts") for index in range(6)))
        self.assert_consistent()

    def test_a_rewrite_refused_by_the_registry_limit_evicts_nothing(self) -> None:
        with mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", 20), \
                mock.patch("worldmedia_media.MAX_REGISTRATIONS", 30):
            self.rewrite(self.window(0, size=10))  # 12 evictable children.
            other = self.registry.register({
                "item_id": "fixture:other", "url": self.BASE + "other.m3u8",
                "delivery": "live", "media_type": "hls", "capture_headers": {},
            })
            rewrite_hls_manifest(self.window(0, size=13, ended=True), self.BASE + "vod.m3u8", other, self.registry)
            history = {index: self.entry(f"seg{index}.ts").token for index in range(10)}
            self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
            # Twelve new segments: four over the root limit and eleven over the
            # registry limit, but only ten old segments could go.
            with self.assertRaises(MediaError) as full:
                self.rewrite(self.window(10, size=12))
            self.assertEqual(full.exception.code, "MEDIA_REGISTRY_FULL")
            self.assertEqual(self.count(), 12)
            for index, token in history.items():
                self.assertEqual(self.entry(f"seg{index}.ts").token, token)
            # With the other root gone, only the four places the root limit needs are taken.
            self.registry.expire(other.token)
            self.rewrite(self.window(10, size=12))
            self.assertEqual(self.count(), 20)
            self.assertIsNone(self.entry("seg3.ts"))
            self.assertEqual(self.entry("seg4.ts").token, history[4])
        self.assert_consistent()

    def test_permanent_wins_and_leaves_eviction_tracking(self) -> None:
        self.rewrite(self.window(0, size=20))
        self.assertTrue(self.entry("seg0.ts").evictable)
        self.rewrite(self.window(0, size=3, ended=True))  # seg0-seg2, key and map become permanent.
        self.rewrite("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nseg5.ts\n")
        self.rewrite("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nboth.m3u8\n")
        self.rewrite(self.window(0, size=3).replace("seg1.ts", "both.m3u8"))  # A live sighting later changes nothing.
        permanent = ["seg0.ts", "seg1.ts", "seg2.ts", "seg5.ts", "key.bin", "init.mp4", "both.m3u8"]
        for name in permanent:
            with self.subTest(name=name):
                self.assertFalse(self.entry(name).evictable)
                self.assertNotIn(self.entry(name).token, self.listed())
        self.now[0] += LIVE_CHILD_MIN_RETENTION_SECONDS + 1
        self.rewrite(self.window(100, size=1_100))
        # 1,123 children: the 16 old evictable segments went, all recent ones stayed over the limit.
        self.assertEqual(self.count(), 1_123 - 16)
        for name in permanent:
            self.registry.get(self.entry(name).token)
        self.assertIsNone(self.entry("seg3.ts"))
        self.assertIsNone(self.entry("seg19.ts"))
        self.assert_consistent()

    def test_stop_and_root_expiry_drop_the_tracking(self) -> None:
        self.rewrite(self.window(0))
        self.registry.expire(self.root.token, grace_seconds=30)
        self.rewrite(self.window(1))  # Still allowed during the grace period.
        token = self.entry("seg6.ts").token
        self.now[0] += 31
        with self.assertRaises(MediaError) as expired:
            self.registry.get(token)
        self.assertEqual(expired.exception.code, "MEDIA_TOKEN_EXPIRED")
        self.assertEqual(self.registry._entries, {})
        self.assertEqual(self.registry._root_child_counts, {})
        self.assertEqual(self.registry._live_listed, {})

        self.setUp()
        self.rewrite(self.window(0))
        token = self.entry("seg0.ts").token
        self.now[0] = self.root.expires_at + 1
        with self.assertRaises(MediaError):
            self.registry.get(token)
        self.assertEqual(self.registry._live_listed, {})

    def test_master_and_ended_playlists_keep_entries_for_the_session(self) -> None:
        self.rewrite(self.MASTER + '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n')
        self.rewrite(self.window(0, ended=True).replace("seg", "vod"))
        self.rewrite(self.window(0, extra="#EXT-X-PLAYLIST-TYPE:VOD").replace("seg", "typed"))
        names = ["index.m3u8", "audio.m3u8", "vod0.ts", "typed0.ts"]
        for name in names:
            self.assertFalse(self.entry(name).evictable)
            self.assertEqual(self.entry(name).expires_at, self.root.expires_at)
        self.assertEqual(self.listed(), {})

    def test_classification_matches_whole_tags_and_empty_live_playlists(self) -> None:
        master = "#EXTM3U\n#EXTINFORMATION about this list\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex.m3u8\n"
        self.assertFalse(is_live_hls_media_playlist(master))
        self.assertTrue(is_live_hls_media_playlist(self.window(0, extra="#EXT-X-ENDLIST-EXAMPLE")))
        self.assertFalse(is_live_hls_media_playlist(self.window(0) + "#ext-x-endlist  \n"))
        empty = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n'
        self.assertTrue(is_live_hls_media_playlist(empty))
        self.rewrite(empty)
        self.assertTrue(self.entry("key.bin").evictable)
        self.assertTrue(self.entry("init.mp4").evictable)
        self.rewrite(master)
        self.assertFalse(self.entry("index.m3u8").evictable)

    def test_rewriting_a_large_live_playlist_is_quick(self) -> None:
        started = time.perf_counter()
        self.rewrite(self.window(0, size=1_000))
        first = time.perf_counter() - started
        started = time.perf_counter()
        self.rewrite(self.window(0, size=1_000))
        reload = time.perf_counter() - started
        self.assertEqual(self.count(), 1_002)
        self.assertLess(first, 10.0, f"{first * 1000:.0f} ms")
        self.assertLess(reload, 10.0, f"{reload * 1000:.0f} ms")

    def test_dash_entries_keep_the_root_lifetime(self) -> None:
        dash = self.registry.register({
            "item_id": "fixture:live-dash", "url": "http://fixture.test/dash/manifest.mpd",
            "delivery": "live", "media_type": "dash", "capture_headers": {},
        })
        rewrite_dash_manifest('''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period>
<AdaptationSet><SegmentTemplate media="chunk-$Number$.m4s" initialization="init.mp4" />
<Representation id="v" bandwidth="1" /></AdaptationSet></Period></MPD>''', dash.url, dash, self.registry)
        children = [entry for entry in self.registry._entries.values() if entry.root_token == dash.token and entry is not dash]
        templates = [entry for entry in self.registry._dash_templates.values() if entry.root_token == dash.token]
        self.assertTrue(children or templates)
        for entry in [*children, *templates]:
            self.assertEqual(entry.expires_at, dash.expires_at)
        self.assertFalse(any(entry.evictable for entry in children))
        self.assertNotIn(dash.token, self.registry._live_listed)


class LiveRootLeaseTests(unittest.TestCase):
    """A live root lives LIVE_TTL after it was last used, not 24 h after it was registered."""

    HOUR = 60 * 60
    DASH = '''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period>
<AdaptationSet><SegmentTemplate media="chunk-$Number$.m4s" initialization="init.mp4" />
<Representation id="v" bandwidth="1" /></AdaptationSet></Period></MPD>'''

    def setUp(self) -> None:
        self.now = [1_000.0]
        patcher = mock.patch("worldmedia_media.time.time", side_effect=lambda: self.now[0])
        patcher.start()
        self.addCleanup(patcher.stop)
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        self.registry = MediaRegistry(connector)
        self.assertEqual(self.registry.live_ttl_seconds, 24 * self.HOUR)

    def register(self, delivery: str = "live", media_type: str = "hls"):
        return self.registry.register({
            "item_id": "fixture:lease", "url": f"http://fixture.test/{media_type}/root",
            "delivery": delivery, "media_type": media_type, "capture_headers": {},
        })

    def assert_expired(self, token: str) -> None:
        with self.assertRaises(MediaError) as expired:
            self.registry.get(token)
        self.assertEqual(expired.exception.code, "MEDIA_TOKEN_EXPIRED")

    def test_use_keeps_a_live_root_alive_past_24_hours(self) -> None:
        root = self.register()
        segment = self.registry.child(root, "http://fixture.test/hls/seg1.ts")
        for _hour in range(72):
            self.now[0] += self.HOUR
            self.registry.get(segment.token)  # Any of the root's tokens counts as use.
        self.assertGreater(root.expires_at, self.now[0] + 12 * self.HOUR)
        self.assertEqual(segment.expires_at, root.expires_at)
        self.now[0] = root.expires_at - 1  # Idle from here: the lease from the last renewal.
        self.registry.get(root.token)

    def test_an_idle_live_root_still_expires_at_24_hours(self) -> None:
        root = self.register()
        self.now[0] += 11 * self.HOUR  # More than half the lease left: no renewal.
        self.registry.get(root.token)
        self.assertEqual(root.expires_at, 1_000.0 + 24 * self.HOUR)
        self.now[0] = 1_000.0 + 24 * self.HOUR
        self.assert_expired(root.token)

    def test_an_explicitly_expired_root_is_not_revived(self) -> None:
        for release in ("expire", "release_root"):
            with self.subTest(release=release):
                root = self.register()
                self.now[0] += 13 * self.HOUR  # Any use now would renew a live root.
                if release == "expire":
                    self.registry.expire(root.token, grace_seconds=30)
                else:
                    self.assertTrue(self.registry.release_root(root.token, grace_seconds=30))
                deadline = self.now[0] + 30
                self.now[0] += 10
                self.registry.get(root.token)  # Still usable during the grace period...
                self.assertEqual(root.expires_at, deadline)  # ...but not renewed.
                self.assertTrue(root.released)
                self.now[0] = deadline
                self.assert_expired(root.token)

    def test_children_and_dash_templates_are_extended_together(self) -> None:
        root = self.register(media_type="dash")
        rewrite_dash_manifest(self.DASH, root.url, root, self.registry)
        templates = [token for token, entry in self.registry._dash_templates.items() if entry.root_token == root.token]
        self.assertTrue(templates)
        self.now[0] += 13 * self.HOUR
        self.registry.expand_dash_template(templates[0], "wm_n=1")
        renewed = self.now[0] + 24 * self.HOUR
        self.assertEqual(root.expires_at, renewed)
        for entry in self.registry._entries.values():
            self.assertEqual(entry.expires_at, renewed)
        for token in templates:
            self.assertEqual(self.registry._dash_templates[token].expires_at, renewed)
        # The original deadline passes: its old heap records are skipped, nothing goes.
        self.now[0] = 1_000.0 + 24 * self.HOUR + 1
        self.registry.get(root.token)
        self.assertEqual(len(self.registry._dash_templates), len(templates))

    def test_non_live_roots_keep_their_fixed_lifetime(self) -> None:
        for delivery in ("on-demand", "unknown"):
            with self.subTest(delivery=delivery):
                root = self.register(delivery=delivery, media_type="audio")
                created = self.now[0]
                self.now[0] += 5 * self.HOUR
                self.registry.get(root.token)
                self.assertEqual(root.expires_at, created + 6 * self.HOUR)
                self.now[0] = created + 6 * self.HOUR
                self.assert_expired(root.token)


class DashAllOrNothingTests(unittest.TestCase):
    """One DASH rewrite registers everything it lists, or nothing at all."""

    # Three templates (the audio init differs per representation, so it is one too),
    # the video init child and the audio BaseURL child.
    DASH = '''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period>
<AdaptationSet><SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" />
<Representation id="v" bandwidth="1" /></AdaptationSet>
<AdaptationSet><SegmentTemplate media="a-$Number$.m4s" initialization="a-init.mp4" />
<Representation id="a" bandwidth="2"><BaseURL>audio/</BaseURL></Representation></AdaptationSet>
</Period></MPD>'''
    NEW_ENTRIES = 5

    def setUp(self) -> None:
        connector = SafeConnector(
            resolver=lambda _host, port: answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        self.registry = MediaRegistry(connector)
        self.root = self.registry.register({
            "item_id": "fixture:dash", "url": "http://fixture.test/dash/manifest.mpd",
            "delivery": "on-demand", "media_type": "dash", "capture_headers": {},
        })

    def snapshot(self) -> tuple:
        registry = self.registry
        return (
            dict(registry._entries), dict(registry._child_index), dict(registry._child_keys_by_token),
            dict(registry._dash_templates), dict(registry._dash_template_index),
            dict(registry._dash_keys_by_token), dict(registry._root_child_counts), len(registry._expiry_heap),
            {token: (entry.evictable, entry.expires_at) for token, entry in registry._entries.items()},
            {root: list(listed.items()) for root, listed in registry._live_listed.items()},
        )

    def rewrite(self, text: str = DASH) -> ET.Element:
        return ET.fromstring(rewrite_dash_manifest(text, self.root.url, self.root, self.registry))

    def test_a_manifest_over_either_limit_leaves_the_registry_unchanged(self) -> None:
        cases = (
            ("MAX_CHILDREN_PER_ROOT", self.NEW_ENTRIES - 1, "DASH_CHILD_LIMIT"),
            # The root is one registration already.
            ("MAX_REGISTRATIONS", self.NEW_ENTRIES, "MEDIA_REGISTRY_FULL"),
        )
        for limit, value, code in cases:
            with self.subTest(limit=limit), mock.patch(f"worldmedia_media.{limit}", value):
                before = self.snapshot()
                with self.assertRaises(MediaError) as raised:
                    self.rewrite()
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(self.snapshot(), before)

    def test_a_later_invalid_template_leaves_the_registry_unchanged(self) -> None:
        before = self.snapshot()
        with self.assertRaises(MediaError) as raised:
            self.rewrite(self.DASH.replace("a-$Number$", "a-$Unknown$"))
        self.assertEqual(raised.exception.code, "INVALID_DASH_TEMPLATE")
        self.assertEqual(self.snapshot(), before)

    def test_a_manifest_that_just_fits_registers_everything(self) -> None:
        with mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", self.NEW_ENTRIES),                 mock.patch("worldmedia_media.MAX_REGISTRATIONS", self.NEW_ENTRIES + 1):
            root = self.rewrite()
            self.assertEqual(self.registry._root_child_counts[self.root.token], self.NEW_ENTRIES)
            self.assertEqual(len(self.registry._dash_templates), 3)
            self.assertEqual(len(self.registry._entries), 1 + 2)  # The root and two children.
            # Rewriting it again adds nothing, so a full root still serves it.
            before = self.snapshot()
            self.assertEqual(ET.tostring(self.rewrite()), ET.tostring(root))
            self.assertEqual(self.snapshot(), before)
        namespace = "{urn:mpeg:dash:schema:mpd:2011}"
        references = [
            *(element.attrib[name] for element in root.iter(f"{namespace}SegmentTemplate")
              for name in ("media", "initialization")),
            *(element.text for element in root.iter(f"{namespace}BaseURL")),
        ]
        self.assertEqual(len(references), self.NEW_ENTRIES)
        for reference in references:
            token = re.match(r"/api/v1/\w+/([\w-]+)", reference).group(1)
            if reference.startswith("/api/v1/dash/"):
                self.assertIn(token, self.registry._dash_templates)
            else:
                self.assertTrue(reference.startswith("/api/v1/media/"), reference)
                self.assertEqual(self.registry.get(token).root_token, self.root.token)
        self.assertNotIn("fixture.test", ET.tostring(root, encoding="unicode"))


    def test_a_manifest_that_grows_too_large_when_rewritten_registers_nothing(self) -> None:
        first_set = self.DASH.split("<AdaptationSet>", 2)
        video_only = first_set[0] + "<AdaptationSet>" + first_set[1] + "</Period></MPD>"
        kept = self.rewrite(video_only)  # Two entries this manifest shares with the full one.
        before = self.snapshot()
        # The input fits, but relay paths are longer than the URLs they replace.
        with mock.patch("worldmedia_media.MAX_MANIFEST_BYTES", len(self.DASH.encode("utf-8"))):
            for _attempt in range(3):  # Repeated failures cannot fill the registry either.
                with self.assertRaises(MediaError) as raised:
                    self.rewrite()
                self.assertEqual(raised.exception.code, "DASH_MANIFEST_TOO_LARGE")
                self.assertEqual(self.snapshot(), before)
        full = ET.tostring(self.rewrite(), encoding="unicode")
        self.assertEqual(self.registry._root_child_counts[self.root.token], self.NEW_ENTRIES)
        namespace = "{urn:mpeg:dash:schema:mpd:2011}"
        for name in ("media", "initialization"):  # The earlier entries were reused, not replaced.
            self.assertIn(next(kept.iter(f"{namespace}SegmentTemplate")).attrib[name], full)

    def test_the_parent_is_checked_once_for_the_whole_step(self) -> None:
        manifest = "#EXTM3U\n#EXT-X-ENDLIST\n" + "".join(f"#EXTINF:6,\nseg{index}.ts\n" for index in range(3))
        expiry = self.root.expires_at
        readings = []

        def clock() -> float:
            # The first reading is before the root's expiry, every later one after it.
            readings.append(None)
            return expiry - 10 if len(readings) == 1 else expiry + 10

        with mock.patch("worldmedia_media.time.time", side_effect=clock):
            rewritten = rewrite_hls_manifest(manifest, self.root.url, self.root, self.registry)
        self.assertEqual(len(readings), 1)
        self.assertEqual(rewritten.count("/api/v1/media/"), 3)
        self.assertEqual(self.registry._root_child_counts[self.root.token], 3)

    def test_a_live_playlist_over_the_limit_changes_nothing_at_all(self) -> None:
        now = [1_000.0]
        with mock.patch("worldmedia_media.time.time", side_effect=lambda: now[0]):
            live = self.registry.register({
                "item_id": "fixture:live", "url": "http://fixture.test/hls/live.m3u8",
                "delivery": "live", "media_type": "hls", "capture_headers": {},
            })

            def window(start: int, size: int) -> str:
                return "#EXTM3U\n#EXT-X-TARGETDURATION:6\n" + "".join(
                    f"#EXTINF:6,\nseg{index}.ts\n" for index in range(start, start + size)
                )

            rewrite_hls_manifest(window(0, 3), live.url, live, self.registry)
            now[0] += 5  # Too recent to evict, so the next window cannot fit.
            before = self.snapshot()
            with mock.patch("worldmedia_media.MAX_CHILDREN_PER_ROOT", 4):
                with self.assertRaises(MediaError) as raised:
                    rewrite_hls_manifest(window(0, 5), live.url, live, self.registry)
            self.assertEqual(raised.exception.code, "HLS_CHILD_LIMIT")
            self.assertEqual(self.snapshot(), before)  # Listing times included.


if __name__ == "__main__":
    unittest.main()
