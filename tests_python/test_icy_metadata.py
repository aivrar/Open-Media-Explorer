"""Station-announced song titles: icy stripping, title parsing, relay and route."""
from __future__ import annotations

import http.client
import json
import random
import socket
import socketserver
import struct
import tempfile
import threading
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import worldmedia_server
from tests_python.fixture_server import MediaFixtureServer
from worldmedia_icy import (
    MAX_METAINT,
    MAX_TITLE_CHARS,
    IcyStripper,
    RefusedIcyHosts,
    clean_stream_title,
    parse_metaint,
    parse_stream_title,
)
from worldmedia_jobs import JobRegistry
from worldmedia_media import MediaError, MediaRegistry, SafeConnector, Upstream, sanitize_capture_headers
import worldmedia_media
from worldmedia_recording import RecordingError, RecordingService
from worldmedia_runtime import get_runtime_paths


def icy_encode(audio: bytes, metaint: int, blocks: list[bytes]) -> bytes:
    """Insert one metadata block after every `metaint` audio bytes, as a station does.

    Each block is NUL-padded to a multiple of 16; once `blocks` run out, empty
    (length 0) blocks follow. A block is written only after a full interval.
    """
    out = bytearray()
    pending = list(blocks)
    for start in range(0, len(audio), metaint):
        piece = audio[start:start + metaint]
        out += piece
        if len(piece) < metaint:
            break
        block = pending.pop(0) if pending else b""
        units = -(-len(block) // 16)
        out.append(units)
        out += block + b"\0" * (units * 16 - len(block))
    return bytes(out)


def random_splits(data: bytes, rng: random.Random, *, max_size: int) -> list[bytes]:
    chunks, position = [], 0
    while position < len(data):
        size = rng.choice((1, 1, 2, 3, rng.randint(1, max_size)))
        chunks.append(data[position:position + size])
        position += size
    return chunks


class IcyStripperTests(unittest.TestCase):
    def strip_all(self, encoded: bytes, metaint: int, chunks: list[bytes]) -> tuple[bytes, list[bytes]]:
        seen: list[bytes] = []
        stripper = IcyStripper(metaint, seen.append)
        out = b"".join(stripper.feed(chunk) for chunk in chunks)
        self.assertEqual(b"".join(chunks), encoded)
        return out, seen

    def test_generated_streams_survive_any_chunking(self) -> None:
        rng = random.Random(20261114)
        for metaint in (1, 2, 3, 15, 16, 17, 255, 256, 1000, 8192, 16000):
            audio = rng.randbytes(max(metaint * 6 + rng.randint(0, metaint), 600))
            blocks = [
                b"", b"StreamTitle='One';", b"", b"x" * (255 * 16),
                b"StreamTitle='Two';StreamUrl='http://example.invalid/';", b"",
            ]
            encoded = icy_encode(audio, metaint, blocks)
            expected_blocks = []
            for block in blocks[: len(audio) // metaint]:
                if block:
                    expected_blocks.append(block + b"\0" * (-len(block) % 16))
            splittings = [
                [encoded],
                [encoded[i:i + 1] for i in range(len(encoded))] if len(encoded) < 20_000 else None,
                random_splits(encoded, rng, max_size=64),
                random_splits(encoded, rng, max_size=70_000),
            ]
            for chunks in splittings:
                if chunks is None:
                    continue
                with self.subTest(metaint=metaint, chunks=len(chunks)):
                    out, seen = self.strip_all(encoded, metaint, chunks)
                    self.assertEqual(out, audio)
                    self.assertEqual(seen, expected_blocks)

    def test_split_at_every_position_around_a_block(self) -> None:
        metaint = 32
        audio = bytes(range(256)) * 2
        encoded = icy_encode(audio, metaint, [b"StreamTitle='Split';"] * 20)
        for cut in range(len(encoded) + 1):
            for second in (cut, min(len(encoded), cut + 1), min(len(encoded), cut + 33)):
                chunks = [encoded[:cut], encoded[cut:second], encoded[second:]]
                out, seen = self.strip_all(encoded, metaint, chunks)
                self.assertEqual(out, audio, (cut, second))
                self.assertEqual(len(seen), len(audio) // metaint)

    def test_audio_only_chunk_is_passed_on_unchanged_and_partial_block_is_held(self) -> None:
        stripper = IcyStripper(1000)
        chunk = b"a" * 600
        self.assertIs(stripper.feed(chunk), chunk)
        self.assertEqual(stripper.feed(b"b" * 400 + b"\x02" + b"m" * 10), b"b" * 400)
        self.assertEqual(stripper.feed(b"m" * 22 + b"c" * 5), b"c" * 5)
        self.assertEqual(stripper.feed(b""), b"")

    def test_a_failing_metadata_consumer_never_breaks_the_audio(self) -> None:
        def explode(_block: bytes) -> None:
            raise RuntimeError("consumer failed")

        audio = b"z" * 100
        encoded = icy_encode(audio, 10, [b"StreamTitle='x';"] * 10)
        self.assertEqual(IcyStripper(10, explode).feed(encoded), audio)

    def test_iter_available_yields_what_arrived_and_keeps_the_relay_guards(self) -> None:
        class Response:
            def __init__(self, pieces, length=None):
                self.pieces = list(pieces)
                self.length = length
                self.sizes = []

            def read1(self, size):
                self.sizes.append(size)
                piece = self.pieces.pop(0) if self.pieces else b""
                if isinstance(piece, BaseException):
                    raise piece
                return piece

        def upstream(response):
            return Upstream(response, SimpleNamespace(close=lambda: None), "http://radio.example/")

        response = Response([b"a" * 65_484, b"b" * 52, b"c"])
        self.assertEqual(list(upstream(response).iter_available()), [b"a" * 65_484, b"b" * 52, b"c"])
        self.assertTrue(all(size == 64 * 1024 for size in response.sizes))
        with self.assertRaises(MediaError) as idle:
            list(upstream(Response([b"x", socket.timeout()])).iter_available())
        self.assertEqual(idle.exception.code, "MEDIA_IDLE_TIMEOUT")
        with self.assertRaises(MediaError) as truncated:
            list(upstream(Response([b"x"], length=10)).iter_available())
        self.assertEqual(truncated.exception.code, "UPSTREAM_BODY_TRUNCATED")
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(MediaError) as cancelled:
            list(upstream(Response([b"x"])).iter_available(cancel=cancel))
        self.assertEqual(cancelled.exception.code, "MEDIA_CANCELLED")

    def test_metaint_range_is_enforced(self) -> None:
        for value in (0, -1, MAX_METAINT + 1, "16"):
            with self.assertRaises(ValueError):
                IcyStripper(value)  # type: ignore[arg-type]

    def test_parse_metaint_accepts_only_a_sane_range(self) -> None:
        for raw, expected in (
            ("16000", 16000), (" 8192 ", 8192), ("1", 1), (str(MAX_METAINT), MAX_METAINT),
            ("0", None), ("-1", None), ("+5", None), (str(MAX_METAINT + 1), None), ("99999999", None),
            ("abc", None), ("", None), ("16000, 16000", None), ("1e4", None),
            ("\uFF11\uFF12", None), (None, None), (16000, None),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(parse_metaint(raw), expected)


class StreamTitleTests(unittest.TestCase):
    def title(self, block: bytes, names=()) -> str | None:
        return clean_stream_title(parse_stream_title(block), names)

    def test_quotes_and_semicolons_inside_titles(self) -> None:
        cases = {
            b"StreamTitle='Artist - Song';StreamUrl='http://x/';\0\0\0": "Artist - Song",
            b"StreamTitle='Don't Stop; Believin'';StreamUrl='x';": "Don't Stop; Believin'",
            b"StreamTitle='Rock 'n' Roll';": "Rock 'n' Roll",
            b"StreamTitle='Guns N' Roses - Patience'": "Guns N' Roses - Patience",
            b"StreamTitle='A;B';": "A;B",
            b"StreamUrl='http://a/StreamTitle=';StreamTitle='Real';": "Real",
            b"streamtitle = 'Lower case key';": "Lower case key",
            b"StreamTitle='Unterminated value": "Unterminated value",
        }
        for block, expected in cases.items():
            with self.subTest(block=block):
                self.assertEqual(self.title(block), expected)

    def test_blocks_without_a_title(self) -> None:
        for block in (b"", b"\0" * 32, b"StreamUrl='http://x/';", b"Garbage", b"XStreamTitle='No';"):
            with self.subTest(block=block):
                self.assertIsNone(parse_stream_title(block))
        self.assertEqual(parse_stream_title(b"StreamTitle='';"), "")

    def test_encodings(self) -> None:
        text = "Sigur R\u00F3s \u2013 Hopp\u00EDpolla \u266A"
        self.assertEqual(self.title(f"StreamTitle='{text}';".encode("utf-8")), text)
        self.assertEqual(
            self.title("StreamTitle='Beyonc\u00E9 \u201CHalo\u201D';".encode("cp1252")),
            "Beyonc\u00E9 \u201CHalo\u201D",
        )
        # Bytes cp1252 leaves undefined still decode, never raise.
        self.assertEqual(self.title(b"StreamTitle='Odd \x81 byte';"), "Odd \uFFFD byte")

    def test_control_characters_whitespace_and_cap(self) -> None:
        self.assertEqual(self.title(b"StreamTitle='A\x07B\nC\tD\x00E';"), "A B C D E")
        self.assertEqual(self.title("StreamTitle='Safe\u202Eevil\u200B';".encode()), "Safeevil")
        self.assertEqual(self.title(b"StreamTitle='   Lots    of   space   ';"), "Lots of space")
        long_title = self.title(("StreamTitle='" + "x" * 900 + "';").encode())
        self.assertEqual(long_title, "x" * MAX_TITLE_CHARS)
        self.assertEqual(len(self.title(("StreamTitle='" + "\u266A" * 300 + "a';").encode())), MAX_TITLE_CHARS)

    def test_html_character_references_are_decoded_once_and_stay_text(self) -> None:
        cases = {
            "NTS 1 - Ondas w/ Dubby &amp; yangdead": "NTS 1 - Ondas w/ Dubby & yangdead",
            "Don&#39;t Stop": "Don't Stop",
            "Tom &amp;amp; Jerry": "Tom &amp; Jerry",  # decoded once only
            "A&#10;B&#9;C&#x0D;D": "A B C D",  # decoded controls are still removed
            "Safe&#x202E;evil&#8203;": "Safeevil",  # decoded invisible characters too
            "Bell&#7; ring": "Bell ring",
            "&lt;b&gt;Bold&lt;/b&gt;": "<b>Bold</b>",  # plain text, never markup
            "AT&T &amp no semicolon": "AT&T & no semicolon",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(clean_stream_title(raw), expected)
        self.assertIsNone(clean_stream_title("&#45; &#45;"))  # "- -" is still no title
        self.assertIsNone(clean_stream_title("Rock &amp; Roll FM", ("Rock & Roll FM",)))
        self.assertEqual(len(clean_stream_title("&amp;" * 300 + "x")), MAX_TITLE_CHARS)

    def test_no_title_rule(self) -> None:
        names = ("My Station FM", "MYSTATION")
        for raw in ("", " ", "-", " - ", "--", " -  - ", "...", "\x00\x01", "My Station FM",
                    "  my   station fm ", "mystation", None):
            with self.subTest(raw=raw):
                self.assertIsNone(clean_stream_title(raw, names))
        self.assertEqual(clean_stream_title("Artist - ", names), "Artist")
        self.assertEqual(clean_stream_title(" - Song", names), "Song")
        self.assertEqual(clean_stream_title("My Station FM - Live", names), "My Station FM - Live")
        self.assertEqual(clean_stream_title("\u6771\u4EAC", names), "\u6771\u4EAC")


class RefusedIcyHostsTests(unittest.TestCase):
    def test_refusal_expires_is_per_host_and_port_and_is_bounded(self) -> None:
        now = [1000.0]
        hosts = RefusedIcyHosts(ttl_seconds=60, max_hosts=3, clock=lambda: now[0])
        self.assertTrue(hosts.should_ask("http://radio.example/stream"))
        hosts.refuse("http://Radio.Example/other")
        self.assertFalse(hosts.should_ask("http://radio.example:80/stream"))
        self.assertTrue(hosts.should_ask("http://radio.example:8000/stream"))
        self.assertTrue(hosts.should_ask("https://radio.example/stream"))
        now[0] += 61
        self.assertTrue(hosts.should_ask("http://radio.example/stream"))
        for index in range(10):
            hosts.refuse(f"http://host{index}.example/")
        self.assertEqual(len(hosts), 3)
        self.assertFalse(hosts.should_ask("http://host9.example/"))
        self.assertTrue(hosts.should_ask("http://host0.example/"))
        self.assertFalse(hosts.should_ask("not a url"))


RESET = object()  # A route result: reset the connection instead of replying.


class FakeStation:
    """Raw-socket station: each route returns complete response bytes, so it can
    answer with a non-HTTP status line. Records every request's headers."""

    def __init__(self) -> None:
        self.routes: dict[str, object] = {}
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.lock = threading.Lock()
        self.hung_up = threading.Event()  # A timed reply could not be sent: the relay closed.
        station = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                data = b""
                while b"\r\n\r\n" not in data and len(data) < 65536:
                    piece = self.request.recv(4096)
                    if not piece:
                        return
                    data += piece
                head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
                method, target, _version = head[0].split(" ", 2)
                headers = {}
                for line in head[1:]:
                    name, _, value = line.partition(":")
                    headers[name.strip().lower()] = value.strip()
                with station.lock:
                    station.requests.append((method, target, headers))
                route = station.routes.get(target)
                reply = route(method, headers) if callable(route) else b"HTTP/1.0 404 Not Found\r\n\r\n"
                if reply is RESET:
                    # Abort: the client sees a reset instead of a reply.
                    self.request.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    self.request.close()
                    return
                if isinstance(reply, list):
                    # Timed pieces: bytes are sent, numbers are pauses in seconds.
                    try:
                        for part in reply:
                            if isinstance(part, (int, float)):
                                time.sleep(part)
                            else:
                                self.request.sendall(part)
                    except OSError:
                        station.hung_up.set()
                    return
                try:
                    self.request.sendall(reply)  # b"": closed with no reply at all
                except OSError:
                    pass

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def asked(self, target: str) -> list[bool]:
        with self.lock:
            return [headers.get("icy-metadata") == "1" for _m, path, headers in self.requests if path == target]


def reply(status: bytes, headers: dict[str, str], body: bytes, method: str = "GET") -> bytes:
    lines = [status] + [f"{name}: {value}".encode("latin-1") for name, value in headers.items()]
    return b"\r\n".join(lines) + b"\r\n\r\n" + (b"" if method == "HEAD" else body)


AUDIO = random.Random(7).randbytes(6000)
METAINT = 256
BLOCKS = [b"StreamTitle='First Song';", b"", b"StreamTitle='Don't Stop; Believin'';StreamUrl='http://x/';"]
ICY_BODY = icy_encode(AUDIO, METAINT, BLOCKS)


def icy_station(method: str, headers: dict[str, str]) -> bytes:
    """An Icecast-like live station: blocks only when asked for them; endless, so no length."""
    if headers.get("icy-metadata") == "1":
        return reply(b"HTTP/1.0 200 OK", {
            "Content-Type": "audio/mpeg", "icy-metaint": str(METAINT), "icy-name": "Test FM",
            "icy-br": "128", "ETag": '"live"',
        }, ICY_BODY, method)
    return reply(b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg"}, AUDIO, method)


class RelayTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.station = FakeStation()
        connector = SafeConnector(address_policy=lambda _address: True, idle_timeout=2)
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
        cls.station.close()

    def setUp(self) -> None:
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        worldmedia_server.ICY_REFUSED_HOSTS.clear()
        self.addCleanup(worldmedia_server.ICY_REFUSED_HOSTS.clear)
        with self.station.lock:
            self.station.requests.clear()
        self.station.routes.clear()
        status, payload, _headers = self.request("GET", "/api/v1/session")
        self.assertEqual(status, 200)
        self.token = payload["data"]["token"]

    def request(self, method: str, path: str, *, headers=None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        response_headers = {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        payload = json.loads(raw) if response_headers.get("content-type", "").startswith("application/json") else raw
        return response.status, payload, response_headers

    def register(self, url: str, *, delivery: str = "live", media_type: str = "audio", title: str = "Test FM") -> dict:
        body = json.dumps({
            "item_id": f"fixture:{url}", "url": url, "delivery": delivery,
            "media_type": media_type, "capture_headers": {}, "title": title,
        }).encode()
        status, payload, _headers = self.request("POST", "/api/v1/media/register", headers={
            "Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json",
        }, body=body)
        self.assertEqual(status, 201, payload)
        return payload["data"]

    def now_playing(self, media_id: str, headers=None):
        return self.request("GET", f"/api/v1/media/{media_id}/now-playing", headers=headers or {
            "Origin": self.origin, "X-WorldMedia-Token": self.token,
        })


class IcyRelayTests(RelayTestBase):
    def test_live_station_is_stripped_and_its_title_is_kept(self) -> None:
        self.station.routes["/live"] = icy_station
        media = self.register(f"{self.station.base_url}/live")
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"], {"title": None, "changed_at": None})
        # The media element's usual first request; a live station ignores the range.
        status, body, headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=0-"})
        self.assertEqual(status, 200)
        self.assertEqual(body, AUDIO)
        self.assertEqual(self.station.asked("/live"), [True])
        for dropped in ("content-length", "content-range", "accept-ranges", "etag", "last-modified"):
            self.assertNotIn(dropped, headers)
        self.assertFalse([name for name in headers if name.startswith("icy-")])
        self.assertEqual(headers["content-type"], "audio/mpeg")
        self.assertEqual(headers["connection"], "close")
        status, payload, _headers = self.now_playing(media["media_id"])
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["title"], "Don't Stop; Believin'")
        self.assertLessEqual(abs(payload["data"]["changed_at"] - time.time()), 30)

    def burst_then_trickle(
        self, target: str, *, trickle_seconds: float, pieces=(1, 7, 100, 3, 250, 16, 2), audio_size: int = 80_000,
    ):
        """A slow station: one 64 KiB opening burst, then small pieces now and then."""
        metaint = 16000
        audio = random.Random(11).randbytes(audio_size)
        blocks = [b"StreamTitle='Burst Song';", b"", b"StreamTitle='Trickle Song';StreamUrl='x';"] + [b""] * 10
        encoded = icy_encode(audio, metaint, blocks)
        head = reply(b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg", "icy-metaint": str(metaint)}, b"")
        parts: list = [head + encoded[:65_536]]
        position, index, steps = 65_536, 0, 0
        pause = 0.02
        while position < len(encoded):
            size = pieces[index % len(pieces)]
            parts += [pause, encoded[position:position + size]]
            position += size
            index += 1
            steps += 1
            if steps * pause >= trickle_seconds:
                parts += [pause, encoded[position:]]  # the rest, so the body ends
                break
        self.station.routes[target] = lambda method, headers, parts=parts: (
            parts if headers.get("icy-metadata") == "1" else reply(b"HTTP/1.0 200 OK", {}, audio, method)
        )
        return audio

    def test_a_slow_station_delivers_its_first_64_kib_without_waiting_for_another_full_read(self) -> None:
        audio = self.burst_then_trickle("/slow", trickle_seconds=1.5)
        media = self.register(f"{self.station.base_url}/slow")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("GET", media["relay_url"], headers={"Range": "bytes=0-"})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        started = time.monotonic()
        first = response.read(65_536)
        elapsed = time.monotonic() - started
        # The burst held about 65,500 audio bytes; the first trickle pieces top
        # it up within a fraction of a second. A relay that waits for another
        # full 64 KiB read would not get there before the station ends.
        self.assertEqual(len(first), 65_536)
        self.assertLess(elapsed, 1.0)
        rest = response.read()
        connection.close()
        self.assertEqual(first + rest, audio)  # byte for byte, across every awkward boundary
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"]["title"], "Trickle Song")

    def test_a_listener_that_goes_away_stops_the_stripped_relay(self) -> None:
        self.station.hung_up.clear()
        self.burst_then_trickle("/leaving", trickle_seconds=20, pieces=(200,), audio_size=400_000)
        media = self.register(f"{self.station.base_url}/leaving")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", media["relay_url"])
        response = connection.getresponse()
        self.assertEqual(len(response.read(70_000)), 70_000)
        client_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if client_socket:
            client_socket.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            client_socket.shutdown(socket.SHUT_RDWR)
        connection.close()
        # The relay notices on its next write and closes the station connection.
        self.assertTrue(self.station.hung_up.wait(8))

    def test_station_name_alone_is_no_title(self) -> None:
        body = icy_encode(AUDIO, METAINT, [b"StreamTitle='Real Song';", b"StreamTitle='TEST fm';"])
        self.station.routes["/named"] = lambda method, headers: reply(b"HTTP/1.0 200 OK", {
            "Content-Type": "audio/mpeg", "icy-metaint": str(METAINT),
        }, body if headers.get("icy-metadata") == "1" else AUDIO, method)
        media = self.register(f"{self.station.base_url}/named", title="Test FM")
        self.assertEqual(self.request("GET", media["relay_url"])[1], AUDIO)
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"], {"title": None, "changed_at": None})

    def test_reply_without_metaint_passes_through_exactly(self) -> None:
        self.station.routes["/plain"] = lambda method, headers: reply(b"HTTP/1.0 200 OK", {
            "Content-Type": "audio/aacp", "Content-Length": str(len(AUDIO)), "icy-name": "Plain",
        }, AUDIO, method)
        media = self.register(f"{self.station.base_url}/plain")
        status, body, headers = self.request("GET", media["relay_url"])
        self.assertEqual((status, body), (200, AUDIO))
        self.assertEqual(headers["content-length"], str(len(AUDIO)))
        self.assertNotIn("icy-name", headers)
        self.assertEqual(self.station.asked("/plain"), [True])
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"]["title"], None)

    def test_unusable_metaint_is_fetched_again_without_asking(self) -> None:
        for index, value in enumerate(("0", "abc", str(MAX_METAINT + 1), "256, 256", "-5")):
            worldmedia_server.ICY_REFUSED_HOSTS.clear()
            target = f"/bad{index}"
            self.station.routes[target] = lambda method, headers, value=value: (
                reply(b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg", "icy-metaint": value}, ICY_BODY, method)
                if headers.get("icy-metadata") == "1"
                else reply(b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg"}, AUDIO, method)
            )
            with self.subTest(value=value):
                media = self.register(f"{self.station.base_url}{target}")
                self.assertEqual(self.request("GET", media["relay_url"])[1], AUDIO)
                self.assertEqual(self.station.asked(target), [True, False])
                # The host is remembered: the next playback does not ask at all.
                self.assertEqual(self.request("GET", media["relay_url"])[1], AUDIO)
                self.assertEqual(self.station.asked(target), [True, False, False])

    def test_an_old_shoutcast_icy_status_line_plays_with_its_song(self) -> None:
        # Shoutcast version 1: "ICY 200 OK" for every request, header names in
        # small letters with no space after the colon, no length.
        def old_shoutcast(method, headers):
            lines = [b"ICY 200 OK", b"icy-notice1:<BR>This stream requires Winamp<BR>", b"icy-name:",
                     b"content-type:audio/aacp", b"icy-pub:0"]
            if headers.get("icy-metadata") == "1":
                return b"\r\n".join(lines + [b"icy-metaint:%d" % METAINT, b"icy-br:320"]) + b"\r\n\r\n" + ICY_BODY
            return b"\r\n".join(lines + [b"icy-br:320"]) + b"\r\n\r\n" + AUDIO

        self.station.routes["/old"] = old_shoutcast
        media = self.register(f"{self.station.base_url}/old")
        status, body, headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=0-"})
        self.assertEqual((status, body), (200, AUDIO))
        self.assertEqual(headers["content-type"], "audio/aacp")
        self.assertNotIn("icy-metaint", headers)
        self.assertEqual(self.station.asked("/old"), [True])  # one request, no repeat
        self.assertEqual(self.now_playing(media["media_id"])[1]["data"]["title"], "Don't Stop; Believin'")
        # Not put on the do-not-ask list: the next playback asks for the song again.
        self.assertTrue(worldmedia_server.ICY_REFUSED_HOSTS.should_ask(f"{self.station.base_url}/old"))
        # A request that does not ask (not from the start) gets the plain sound.
        status, body, _headers = self.request("GET", media["relay_url"], headers={"Range": "bytes=100-"})
        self.assertEqual((status, body), (200, AUDIO))
        self.assertEqual(self.station.asked("/old"), [True, False])

    def test_an_icy_status_line_keeps_its_status(self) -> None:
        self.station.routes["/icy-gone"] = lambda method, headers: (
            b"ICY 404 Resource Not Found\r\nicy-notice2:The resource requested was not found<BR>\r\n\r\n"
        )
        media = self.register(f"{self.station.base_url}/icy-gone")
        self.assertEqual(self.request("GET", media["relay_url"])[0], 404)
        self.assertEqual(self.station.asked("/icy-gone"), [True])

    def test_only_a_first_line_that_starts_with_icy_and_a_space_is_taken(self) -> None:
        # "ICY" is read as "HTTP/1.0" only at the very start of the reply; any
        # other first line is still no HTTP reply, asked again once without the
        # header and, when that fails too, reported as before.
        for index, first_line in enumerate((b"ICYX 200 OK", b"icy 200 OK", b" ICY 200 OK", b"NOPE 200 OK", b"ICY")):
            target = f"/not-http{index}"
            self.station.routes[target] = lambda method, headers, first_line=first_line: reply(
                first_line, {"Content-Type": "audio/mpeg"}, AUDIO, method,
            )
            with self.subTest(first_line=first_line):
                media = self.register(f"{self.station.base_url}{target}")
                status, payload, _headers = self.request("GET", media["relay_url"])
                self.assertEqual(status, 502)
                self.assertEqual(payload["error"]["code"], "MEDIA_CONNECT_FAILED")
                self.assertEqual(self.station.asked(target), [True, False])
                # The repeat failed too, so the host is not put on the do-not-ask list.
                self.assertEqual(self.request("GET", media["relay_url"])[0], 502)
                self.assertEqual(self.station.asked(target), [True, False, True, False])

    def test_a_later_line_that_starts_with_icy_is_left_alone(self) -> None:
        body = b"ICY 200 OK\r\n" + AUDIO
        self.station.routes["/icy-in-body"] = lambda method, headers: reply(
            b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg", "Content-Length": str(len(body))}, body, method,
        )
        media = self.register(f"{self.station.base_url}/icy-in-body")
        self.assertEqual(self.request("GET", media["relay_url"])[:2], (200, body))

    def test_a_finite_file_with_an_interval_keeps_its_length_and_seeking(self) -> None:
        cases = {
            "/finite-length": {"Content-Length": str(len(ICY_BODY))},
            "/finite-range": {"Content-Range": f"bytes 0-{len(ICY_BODY) - 1}/{len(ICY_BODY)}"},
        }
        for target, extra in cases.items():
            self.station.routes[target] = lambda method, headers, extra=extra: (
                reply(b"HTTP/1.0 200 OK", {
                    "Content-Type": "audio/mpeg", "icy-metaint": str(METAINT), "Accept-Ranges": "bytes", **extra,
                }, ICY_BODY, method)
                if headers.get("icy-metadata") == "1"
                else reply(b"HTTP/1.0 200 OK", {
                    "Content-Type": "audio/mpeg", "Content-Length": str(len(AUDIO)), "Accept-Ranges": "bytes",
                }, AUDIO, method)
            )
            with self.subTest(target=target):
                worldmedia_server.ICY_REFUSED_HOSTS.clear()
                media = self.register(f"{self.station.base_url}{target}", delivery="unknown")
                status, body, headers = self.request("GET", media["relay_url"])
                self.assertEqual((status, body), (200, AUDIO))
                self.assertEqual(headers["content-length"], str(len(AUDIO)))
                self.assertEqual(headers["accept-ranges"], "bytes")
                self.assertEqual(self.station.asked(target), [True, False])
                self.assertFalse(worldmedia_server.ICY_REFUSED_HOSTS.should_ask(f"{self.station.base_url}{target}"))

    def test_only_a_request_from_the_start_asks(self) -> None:
        self.station.routes["/live"] = icy_station
        media = self.register(f"{self.station.base_url}/live")
        for range_value, asked in (("bytes=0-", True), ("bytes=100-", False), ("bytes=0-0", False),
                                   ("bytes=-500", False), (None, True)):
            with self.subTest(range_value=range_value):
                headers = {"Range": range_value} if range_value else {}
                status, body, _headers = self.request("GET", media["relay_url"], headers=headers)
                self.assertEqual(status, 200)
                self.assertEqual(body, AUDIO)  # stripped when asked, plain audio when not
                self.assertEqual(self.station.asked("/live")[-1], asked)

    def test_a_station_that_drops_or_rejects_the_header_is_asked_again_without_it(self) -> None:
        plain = reply(b"HTTP/1.0 200 OK", {"Content-Type": "audio/mpeg"}, AUDIO)
        behaviours = {"/reset": RESET, "/closed": b""}
        for status_code in (400, 406, 412, 415, 431):
            behaviours[f"/status{status_code}"] = reply(
                f"HTTP/1.0 {status_code} Rejected".encode(), {"Content-Type": "text/plain"}, b"no",
            )
        for target, when_asked in behaviours.items():
            self.station.routes[target] = lambda method, headers, when_asked=when_asked: (
                when_asked if headers.get("icy-metadata") == "1" else plain
            )
            with self.subTest(target=target):
                worldmedia_server.ICY_REFUSED_HOSTS.clear()
                media = self.register(f"{self.station.base_url}{target}")
                self.assertEqual(self.request("GET", media["relay_url"])[:2], (200, AUDIO))
                self.assertEqual(self.station.asked(target), [True, False])
                # The repeat worked: this host is not asked again for a while.
                self.assertEqual(self.request("GET", media["relay_url"])[:2], (200, AUDIO))
                self.assertEqual(self.station.asked(target), [True, False, False])

    def test_other_failures_are_never_repeated_and_never_remembered(self) -> None:
        for status_code in (401, 403, 404, 410, 500, 503):
            target = f"/fail{status_code}"
            self.station.routes[target] = lambda method, headers, status_code=status_code: reply(
                f"HTTP/1.0 {status_code} Failed".encode(), {"Content-Type": "text/plain"}, b"no", method,
            )
            with self.subTest(status=status_code):
                media = self.register(f"{self.station.base_url}{target}")
                self.assertEqual(self.request("GET", media["relay_url"])[0], status_code)
                self.assertEqual(self.station.asked(target), [True])
        # Both ways rejected: not the header's fault, so the host is not remembered.
        self.station.routes["/always400"] = lambda method, headers: reply(
            b"HTTP/1.0 400 Bad", {"Content-Type": "text/plain"}, b"no", method,
        )
        media = self.register(f"{self.station.base_url}/always400")
        self.assertEqual(self.request("GET", media["relay_url"])[0], 400)
        self.assertEqual(self.request("GET", media["relay_url"])[0], 400)
        self.assertEqual(self.station.asked("/always400"), [True, False, True, False])
        # Reset both ways: one repeat only, and not remembered.
        self.station.routes["/dead"] = lambda method, headers: RESET
        media = self.register(f"{self.station.base_url}/dead")
        self.assertEqual(self.request("GET", media["relay_url"])[0], 502)
        self.assertEqual(self.station.asked("/dead"), [True, False])
        self.assertTrue(worldmedia_server.ICY_REFUSED_HOSTS.should_ask(f"{self.station.base_url}/dead"))

    def test_a_timeout_is_not_repeated(self) -> None:
        def silent(method: str, headers: dict[str, str]) -> bytes:
            time.sleep(1.0)
            return b""

        self.station.routes["/silent"] = silent
        connector = self.registry.connector
        previous = connector.header_timeout
        connector.header_timeout = 0.3
        self.addCleanup(setattr, connector, "header_timeout", previous)
        media = self.register(f"{self.station.base_url}/silent")
        status, payload, _headers = self.request("GET", media["relay_url"])
        self.assertEqual((status, payload["error"]["code"]), (502, "MEDIA_CONNECT_FAILED"))
        self.assertEqual(self.station.asked("/silent"), [True])
        self.assertTrue(worldmedia_server.ICY_REFUSED_HOSTS.should_ask(f"{self.station.base_url}/silent"))

    def test_partial_content_is_never_stripped(self) -> None:
        def ranged(method: str, headers: dict[str, str]) -> bytes:
            extra = {"icy-metaint": "256"} if headers.get("icy-metadata") == "1" else {}
            ranges = {"bytes=10-19": (10, 19), "bytes=0-": (0, len(AUDIO) - 1)}
            if headers.get("range") in ranges:
                first, last = ranges[headers["range"]]
                return reply(b"HTTP/1.1 206 Partial Content", {
                    "Content-Type": "audio/mpeg", "Content-Range": f"bytes {first}-{last}/{len(AUDIO)}",
                    "Content-Length": str(last - first + 1), "Accept-Ranges": "bytes", "Connection": "close",
                    **extra,
                }, AUDIO[first:last + 1], method)
            return reply(b"HTTP/1.1 200 OK", {
                "Content-Type": "audio/mpeg", "Content-Length": str(len(AUDIO)), "Connection": "close",
            }, AUDIO, method)

        self.station.routes["/file"] = ranged
        for delivery, range_value, expected in (
            ("on-demand", "bytes=10-19", [False]),
            ("on-demand", "bytes=0-", [False]),
            ("live", "bytes=10-19", [False]),  # a seek never asks
            ("unknown", "bytes=0-", [True, False]),  # asked, but a 206 is never stripped
        ):
            worldmedia_server.ICY_REFUSED_HOSTS.clear()
            with self.station.lock:
                self.station.requests.clear()
            with self.subTest(delivery=delivery, range_value=range_value):
                first, last = (10, 19) if range_value == "bytes=10-19" else (0, len(AUDIO) - 1)
                media = self.register(f"{self.station.base_url}/file", delivery=delivery)
                status, body, headers = self.request("GET", media["relay_url"], headers={"Range": range_value})
                self.assertEqual((status, body), (206, AUDIO[first:last + 1]))
                self.assertEqual(headers["content-range"], f"bytes {first}-{last}/{len(AUDIO)}")
                self.assertEqual(headers["content-length"], str(last - first + 1))
                self.assertEqual(headers["accept-ranges"], "bytes")
                self.assertEqual(self.station.asked("/file"), expected)

    def test_on_demand_head_capture_and_children_never_ask(self) -> None:
        self.station.routes["/live"] = icy_station
        self.station.routes["/index.m3u8"] = lambda method, headers: reply(b"HTTP/1.0 200 OK", {
            "Content-Type": "application/vnd.apple.mpegurl",
        }, b"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.aac\n", method)
        self.station.routes["/seg1.aac"] = icy_station
        url = f"{self.station.base_url}/live"

        on_demand = self.register(url, delivery="on-demand")
        self.assertEqual(self.request("GET", on_demand["relay_url"])[1], AUDIO)
        self.assertEqual(self.request("HEAD", self.register(url)["relay_url"])[0], 200)
        captured = self.register(url)
        self.registry.mark_capture(captured["media_id"])
        self.assertEqual(self.request("GET", captured["relay_url"])[1], AUDIO)
        self.assertEqual(self.request("GET", self.register(url, media_type="video")["relay_url"])[1], AUDIO)
        self.assertEqual(self.station.asked("/live"), [False, False, False, False])

        playlist = self.register(f"{self.station.base_url}/index.m3u8", media_type="hls")
        status, text, _headers = self.request("GET", playlist["relay_url"])
        self.assertEqual(status, 200)
        child = next(line for line in text.decode().splitlines() if line.startswith("/api/v1/media/"))
        self.assertEqual(self.request("GET", child)[1], AUDIO)  # An .aac child is "audio", but not a root.
        self.assertEqual(self.station.asked("/index.m3u8"), [False])
        self.assertEqual(self.station.asked("/seg1.aac"), [False])

    def test_recording_start_marks_its_root_as_capture(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        missing = SimpleNamespace(status=lambda: SimpleNamespace(
            state="missing", ffmpeg_path=None, ffprobe_path=None, actionable_reason="No FFmpeg.",
        ))
        jobs = JobRegistry()
        self.addCleanup(jobs.shutdown, timeout=2)
        service = RecordingService(self.registry, jobs, missing, paths)
        media = self.register(f"{self.station.base_url}/live")
        with self.assertRaises(RecordingError):
            service.start(media["media_id"], "compact", "http://127.0.0.1:9124")
        self.assertTrue(self.registry._entries[media["media_id"]].capture)
        self.assertFalse(worldmedia_server.wants_icy_metadata(
            self.registry.get(media["media_id"]), "GET", dash=False,
        ))

    def test_capture_headers_cannot_ask_for_metadata(self) -> None:
        self.assertEqual(
            sanitize_capture_headers({"Icy-MetaData": "1", "icy-metadata": "1", "referer": "https://a.example/"}),
            {"Referer": "https://a.example/"},
        )


class IcyDashRelayTests(RelayTestBase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.fixture = MediaFixtureServer()
        cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)
        super().tearDownClass()

    def test_dash_manifest_and_template_requests_never_ask(self) -> None:
        manifest = self.register(f"{self.fixture.base_url}/dash/manifest.mpd", media_type="dash")
        status, body, _headers = self.request("GET", manifest["relay_url"])
        self.assertEqual(status, 200)
        root = ET.fromstring(body.decode("utf-8"))
        template = next(element for element in root.iter() if element.tag.endswith("SegmentTemplate"))
        segment = template.attrib["media"].replace("$RepresentationID$", "v1").replace("$Number%05d$", "00001")
        self.assertEqual(self.request("GET", segment)[0], 200)  # An .m4s template is inferred as "audio".
        with self.fixture.state.lock:
            seen = [entry for entry in self.fixture.state.requests if entry["path"].startswith("/dash/")]
        self.assertGreaterEqual(len(seen), 2)
        for entry in seen:
            self.assertNotIn("icy-metadata", {name.lower() for name in entry["headers"]})


class NowPlayingRouteTests(RelayTestBase):
    def play(self) -> dict:
        self.station.routes["/live"] = icy_station
        media = self.register(f"{self.station.base_url}/live")
        self.assertEqual(self.request("GET", media["relay_url"])[1], AUDIO)
        self.assertIsNotNone(self.now_playing(media["media_id"])[1]["data"]["title"])
        return media

    def test_route_validation(self) -> None:
        media = self.play()
        path = f"/api/v1/media/{media['media_id']}/now-playing"
        status, payload, _headers = self.request("GET", path)
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "INVALID_TOKEN")
        status, payload, _headers = self.request("GET", path, headers={"X-WorldMedia-Token": "wrong"})
        self.assertEqual(status, 403)
        status, payload, _headers = self.request("GET", path, headers={
            "X-WorldMedia-Token": self.token, "Origin": "http://evil.example",
        })
        self.assertEqual((status, payload["error"]["code"]), (403, "INVALID_ORIGIN"))
        status, payload, _headers = self.request("GET", f"{path}?x=1", headers={"X-WorldMedia-Token": self.token})
        self.assertEqual((status, payload["error"]["code"]), (400, "QUERY_NOT_ALLOWED"))
        status, payload, _headers = self.request("GET", "/api/v1/media/short/now-playing", headers={
            "X-WorldMedia-Token": self.token,
        })
        self.assertEqual((status, payload["error"]["code"]), (404, "ROUTE_NOT_FOUND"))
        status, payload, _headers = self.request("POST", path, headers={
            "Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json",
        }, body=b"{}")
        self.assertEqual((status, payload["error"]["code"]), (405, "METHOD_NOT_ALLOWED"))
        unknown = "A" * 43
        self.assertEqual(self.now_playing(unknown)[1]["data"], {"title": None, "changed_at": None})
        status, payload, _headers = self.now_playing(media["media_id"], headers={"X-WorldMedia-Token": self.token})
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["title"], "Don't Stop; Believin'")

    def test_release_and_expiry_clean_up(self) -> None:
        released = self.play()
        status, payload, _headers = self.request(
            "POST", f"/api/v1/media/{released['media_id']}/expire",
            headers={"Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json"},
            body=json.dumps({"grace_seconds": 5}).encode(),
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.now_playing(released["media_id"])[1]["data"], {"title": None, "changed_at": None})
        self.assertNotIn(released["media_id"], self.registry._now_playing)
        # A stream still being relayed after its release cannot bring it back.
        self.registry.note_stream_title(released["media_id"], "Late")
        self.assertNotIn(released["media_id"], self.registry._now_playing)

        expired = self.play()
        later = time.time() + self.registry.live_ttl_seconds + 1
        with mock.patch("worldmedia_media.time.time", return_value=later):
            self.assertEqual(self.now_playing(expired["media_id"])[1]["data"], {"title": None, "changed_at": None})
        self.assertNotIn(expired["media_id"], self.registry._now_playing)


class NowPlayingRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = MediaRegistry(SafeConnector(address_policy=lambda _address: True), ttl_seconds=300)

    def register(self, title: str = "Station"):
        return self.registry.register({
            "item_id": "fixture:radio", "url": "http://127.0.0.1:18080/stream", "delivery": "live",
            "media_type": "audio", "capture_headers": {}, "title": title,
        })

    def test_changes_are_timed_repeats_are_not_and_none_means_nothing(self) -> None:
        root = self.register()
        token = root.token
        self.registry.note_stream_title(token, None)
        self.assertNotIn(token, self.registry._now_playing)
        with mock.patch("worldmedia_media.time.time", return_value=time.time()):
            self.registry.note_stream_title(token, "Song A")
            first = self.registry.now_playing(token)
        self.assertEqual(first["title"], "Song A")
        with mock.patch("worldmedia_media.time.time", return_value=time.time() + 50):
            self.registry.note_stream_title(token, "Song A")
            self.assertEqual(self.registry.now_playing(token), first)
            self.registry.note_stream_title(token, None)
            self.assertEqual(self.registry.now_playing(token), {"title": None, "changed_at": None})
            self.registry.note_stream_title(token, "Song B")
            self.assertGreater(self.registry.now_playing(token)["changed_at"], first["changed_at"])

    def test_only_live_roots_and_bounded(self) -> None:
        root = self.register()
        child = self.registry.child(root, "http://127.0.0.1:18080/other.aac")
        self.registry.note_stream_title(child.token, "Child")
        self.assertNotIn(child.token, self.registry._now_playing)
        self.registry.note_stream_title("unknown-token", "Nobody")
        self.assertNotIn("unknown-token", self.registry._now_playing)
        with mock.patch.object(worldmedia_media, "MAX_NOW_PLAYING", 3):
            roots = [self.register() for _ in range(6)]
            for index, entry in enumerate(roots):
                self.registry.note_stream_title(entry.token, f"Song {index}")
        self.assertEqual(list(self.registry._now_playing), [entry.token for entry in roots[-3:]])
        self.registry.clear()
        self.assertEqual(len(self.registry._now_playing), 0)

    def test_polling_keeps_a_live_playback_and_its_title_alive(self) -> None:
        root = self.register()
        self.registry.note_stream_title(root.token, "Long Song")
        lease = self.registry.live_ttl_seconds
        start = time.time()
        clock = start
        # Poll every 5 minutes for twice the lease; no relay request in between.
        for _ in range(int(2 * lease / 300) + 1):
            clock += 300
            with mock.patch("worldmedia_media.time.time", return_value=clock):
                self.assertEqual(self.registry.now_playing(root.token)["title"], "Long Song")
        self.assertGreater(clock - start, lease)
        self.assertGreater(root.expires_at, clock)
        with mock.patch("worldmedia_media.time.time", return_value=clock + 1):
            self.registry.note_stream_title(root.token, "Next Song")  # still accepted
            self.assertEqual(self.registry.now_playing(root.token)["title"], "Next Song")
            self.assertIs(self.registry.get(root.token), root)  # what a reconnect needs

    def test_polling_never_revives_released_or_expired_playback(self) -> None:
        released = self.register()
        self.registry.note_stream_title(released.token, "Song")
        self.registry.expire(released.token, grace_seconds=30)
        deadline = released.expires_at
        self.assertEqual(self.registry.now_playing(released.token), {"title": None, "changed_at": None})
        self.assertEqual(released.expires_at, deadline)

        expired = self.register()
        self.registry.note_stream_title(expired.token, "Song")
        later = expired.expires_at + 1
        with mock.patch("worldmedia_media.time.time", return_value=later):
            self.assertEqual(self.registry.now_playing(expired.token), {"title": None, "changed_at": None})
            self.assertNotIn(expired.token, self.registry._entries)
            with self.assertRaises(worldmedia_media.MediaError):
                self.registry.get(expired.token)

    def test_expire_item_and_removal_drop_titles(self) -> None:
        root = self.register()
        self.registry.note_stream_title(root.token, "Song")
        self.registry.expire_item("fixture:radio", grace_seconds=0)
        self.assertNotIn(root.token, self.registry._now_playing)
        other = self.register()
        self.registry.note_stream_title(other.token, "Song")
        with self.registry._lock:
            self.registry._remove_entry_locked(other.token)
        self.assertNotIn(other.token, self.registry._now_playing)


class WantsIcyMetadataTests(unittest.TestCase):
    def test_only_plain_live_audio_roots_with_get(self) -> None:
        def registration(**overrides):
            values = {
                "token": "t" * 43, "root_token": "t" * 43, "media_type": "audio", "delivery": "live",
                "capture": False, "url": "http://radio.example/stream",
            }
            values.update(overrides)
            return SimpleNamespace(**values)

        worldmedia_server.ICY_REFUSED_HOSTS.clear()
        self.addCleanup(worldmedia_server.ICY_REFUSED_HOSTS.clear)
        wants = worldmedia_server.wants_icy_metadata
        self.assertTrue(wants(registration(), "GET", dash=False))
        self.assertTrue(wants(registration(delivery="unknown"), "GET", dash=False))
        for overrides in (
            {"media_type": "hls"}, {"media_type": "dash"}, {"media_type": "video"},
            {"delivery": "on-demand"}, {"root_token": "r" * 43}, {"capture": True},
        ):
            with self.subTest(overrides=overrides):
                self.assertFalse(wants(registration(**overrides), "GET", dash=False))
        self.assertFalse(wants(registration(), "HEAD", dash=False))
        self.assertFalse(wants(registration(), "GET", dash=True))
        self.assertTrue(wants(registration(), "GET", dash=False, range_value="bytes=0-"))
        for range_value in ("bytes=0-0", "bytes=1-", "bytes=100-200", "bytes=-10", "bytes=0-100"):
            with self.subTest(range_value=range_value):
                self.assertFalse(wants(registration(), "GET", dash=False, range_value=range_value))
        worldmedia_server.ICY_REFUSED_HOSTS.refuse("http://radio.example/other")
        self.assertFalse(wants(registration(), "GET", dash=False))


if __name__ == "__main__":
    unittest.main()
