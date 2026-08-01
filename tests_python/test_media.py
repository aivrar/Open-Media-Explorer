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
    MediaError,
    MediaRegistry,
    ResolvedTarget,
    SafeConnector,
    Upstream,
    _PinnedHTTPSConnection,
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


if __name__ == "__main__":
    unittest.main()
