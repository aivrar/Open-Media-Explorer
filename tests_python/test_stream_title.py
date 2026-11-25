from __future__ import annotations

import concurrent.futures
import errno
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

if __package__:
    from . import test_stream_probe as fixtures
else:
    import test_stream_probe as fixtures
import worldmedia_server
import worldmedia_stream_title as stream_title
from worldmedia_media import MediaError, MediaRegistry, SafeConnector
from worldmedia_runtime import (
    PROFILE_TRANSFER_EXTRA_FILENAME, get_runtime_paths,
    load_profile_transfer, profile_transfer_path, save_profile_transfer,
)
from worldmedia_stream_probe import ProbeBusy
from worldmedia_stream_title import PEEK_CONCURRENCY, PEEK_MAX_BYTES, PEEK_MAX_DIALS, peek_stream_title


def station(url=fixtures.OWN, **overrides):
    return {"item_id": "radio:jazz", "url": url, "title": "Jazz FM",
            "delivery": "live", "media_type": "audio", **overrides}


class CountingResponse(fixtures.FakeResponse):
    bytes_read = 0

    def read(self, size):
        chunk = super().read(size)
        self.bytes_read += len(chunk)
        return chunk


class StreamTitleTests(unittest.TestCase):
    def peek_fake(self, response):
        connector = fixtures.FakeConnector({fixtures.OWN: response})
        with mock.patch.object(stream_title, "DeadlineConnector", return_value=connector):
            result = peek_stream_title(MediaRegistry(), station())
        self.assertEqual(connector.calls, [(fixtures.OWN, {"Icy-MetaData": "1"})])
        self.assertTrue(connector.upstreams[0].closed)
        return result

    def test_stops_at_the_first_usable_title_and_uses_playback_cleaning(self):
        first = fixtures.icy_body(b"abcd", 4, "  Miles  Davis &amp; John Coltrane  ")
        second = fixtures.icy_body(b"abcd", 4, "Another song")
        response = CountingResponse(200, {"icy-metaint": "4", "icy-name": "Jazz FM"}, first + second)
        self.assertEqual(self.peek_fake(response), {"status": "title", "title": "Miles Davis & John Coltrane"})
        self.assertEqual(response.bytes_read, len(first))

    def test_missing_metaint_closes_without_reading_the_body(self):
        response = CountingResponse(200, {"Content-Type": "audio/mpeg"}, b"audio")
        self.assertEqual(self.peek_fake(response), {"status": "no title", "title": None})
        self.assertEqual(response.reads, 0)

    def test_skips_empty_blocks_and_reads_the_title_in_the_third(self):
        first = b"abcd\0"
        second = fixtures.icy_body(b"abcd", 4, "")
        third = fixtures.icy_body(b"abcd", 4, "Later")
        fourth = fixtures.icy_body(b"abcd", 4, "Unused")
        response = CountingResponse(200, {"icy-metaint": "4"}, first + second + third + fourth)
        self.assertEqual(self.peek_fake(response), {"status": "title", "title": "Later"})
        self.assertEqual(response.bytes_read, len(first + second + third))

    def test_32_kib_metaint_can_reach_a_title_in_the_fourth_block(self):
        interval = 32 * 1024
        audio = b"a" * interval
        body = fixtures.icy_body(audio * 3, interval, None) + fixtures.icy_body(audio, interval, "Later")
        response = CountingResponse(200, {"icy-metaint": str(interval)}, body)
        self.assertEqual(self.peek_fake(response), {"status": "title", "title": "Later"})
        self.assertEqual(response.bytes_read, len(body))

    def test_empty_stream_titles_stop_at_the_byte_cap_and_close(self):
        interval = 32 * 1024 - 17  # One length byte and 16 metadata bytes complete each 32 KiB frame.
        frame = fixtures.icy_body(b"a" * interval, interval, "")
        response = CountingResponse(200, {"icy-metaint": str(interval)}, frame * 6)
        self.assertEqual(self.peek_fake(response), {"status": "no title", "title": None})
        self.assertEqual(response.bytes_read, PEEK_MAX_BYTES)

    def test_byte_cap_rules_out_an_interval_or_block_that_cannot_fit(self):
        interval = PEEK_MAX_BYTES - 1
        response = CountingResponse(200, {"icy-metaint": str(interval)}, b"a" * interval + b"\x02" + b"b" * 32)
        self.assertEqual(self.peek_fake(response)["status"], "no title")
        self.assertEqual(response.bytes_read, PEEK_MAX_BYTES)
        response = CountingResponse(200, {"icy-metaint": str(PEEK_MAX_BYTES)}, b"a" * PEEK_MAX_BYTES)
        self.assertEqual(self.peek_fake(response)["status"], "no title")
        self.assertEqual(response.reads, 0)

    def test_known_hls_and_a_nonempty_playback_title_need_no_connection(self):
        registry = MediaRegistry(fixtures.loopback_connector(1))
        root = registry.register(station())
        with mock.patch.object(stream_title, "DeadlineConnector") as no_connector:
            self.assertEqual(peek_stream_title(registry, station(media_type="hls"))["status"], "not available")
            self.assertEqual(peek_stream_title(registry, station(url=fixtures.OWN + ".m3u8?token=abc"))["status"], "not available")
            registry.begin_playing_relay(root.token)
            try:
                registry.note_stream_title(root.token, "Cached track")
                self.assertEqual(peek_stream_title(registry, station(url=fixtures.ALT))["title"], "Cached track")
            finally:
                registry.end_playing_relay(root.token)
            no_connector.assert_not_called()

    def test_a_relay_with_no_title_still_allows_a_peek(self):
        registry = MediaRegistry(fixtures.loopback_connector(1))
        root = registry.register(station())
        registry.begin_playing_relay(root.token)
        self.addCleanup(registry.end_playing_relay, root.token)
        body = fixtures.icy_body(b"abcd", 4, "First track")
        connector = fixtures.FakeConnector({fixtures.OWN: CountingResponse(200, {"icy-metaint": "4"}, body)})
        with mock.patch.object(stream_title, "DeadlineConnector", return_value=connector):
            self.assertEqual(peek_stream_title(registry, station())["title"], "First track")

    def test_a_relay_starting_during_the_peek_can_supply_a_later_title(self):
        registry = MediaRegistry(fixtures.loopback_connector(1))
        release = threading.Event()

        def await_release(*_args):
            release.wait(2)
            return {"status": "no title", "title": None}

        with mock.patch.object(registry, "playing_relay_title", side_effect=[
            None, {"title": None}, {"title": "Later relay track"},
        ]), mock.patch.object(stream_title, "_read_title", side_effect=await_release):
            try:
                self.assertEqual(peek_stream_title(registry, station())["title"], "Later relay track")
            finally:
                release.set()

    def test_private_address_is_refused_before_dialling(self):
        connector = SafeConnector(resolver=lambda *_: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))])
        with mock.patch("worldmedia_media.socket.socket") as dial:
            with self.assertRaises(MediaError) as caught:
                peek_stream_title(MediaRegistry(connector), station())
        self.assertEqual(caught.exception.code, "NON_GLOBAL_MEDIA_TARGET")
        dial.assert_not_called()

    def test_redirect_uses_the_relay_address_policy_and_keeps_icy_header(self):
        seen = []

        def respond(server, client):
            with client:
                client.settimeout(2)
                with client.makefile("rb") as request:
                    line = request.readline()
                    headers = []
                    while header := request.readline().strip():
                        headers.append(header)
                seen.append((line, headers))
                if b"/start " in line:
                    reply = b"HTTP/1.0 302 Found\r\nLocation: /second\r\n\r\n"
                elif b"/second " in line or b"/private " in line:
                    host = "blocked.example" if b"/private " in line else "cdn.example"
                    reply = f"HTTP/1.0 302 Found\r\nLocation: http://{host}:{server.port}/song\r\n\r\n".encode()
                else:
                    reply = b"ICY 200 OK\r\nicy-metaint: 4\r\n\r\n" + fixtures.icy_body(b"abcd", 4, "Redirect song")
                client.sendall(reply)

        server = fixtures.LocalServer(respond)
        self.addCleanup(server.close)

        def resolve(host, port):
            ip = "127.0.0.2" if host == "blocked.example" else "127.0.0.1"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

        registry = MediaRegistry(SafeConnector(resolver=resolve, address_policy=lambda ip: ip == "127.0.0.1"))
        self.assertEqual(peek_stream_title(registry, station(f"http://station.example:{server.port}/start"))["title"],
                         "Redirect song")
        with self.assertRaises(MediaError) as caught:
            peek_stream_title(registry, station(f"http://station.example:{server.port}/private"))
        self.assertEqual(caught.exception.code, "NON_GLOBAL_MEDIA_TARGET")
        self.assertEqual([line.split()[1] for line, _ in seen], [b"/start", b"/second", b"/song", b"/private"])
        self.assertTrue(all(b"Icy-MetaData: 1" in headers for _, headers in seen))

    def test_a_peek_caps_attempts_across_resolved_addresses(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (f"93.184.216.{n}", 80)) for n in range(3, 8)]
        registry = MediaRegistry(SafeConnector(resolver=lambda *_: answers))
        attempts = []

        def failed_socket(*_args):
            attempt = mock.Mock()
            attempt.connect_ex.return_value = errno.ECONNREFUSED
            attempts.append(attempt)
            return attempt

        with mock.patch("worldmedia_media.socket.socket", side_effect=failed_socket):
            self.assertEqual(peek_stream_title(registry, station())["status"], "no title")
        self.assertEqual(len(attempts), PEEK_MAX_DIALS)
        for attempt in attempts:
            attempt.connect_ex.assert_called_once()
            attempt.close.assert_called()

    def test_a_single_dial_has_a_cancel_hook_before_connect(self):
        started = threading.Event()
        closed = threading.Event()
        attempt = mock.Mock()
        attempt.close.side_effect = closed.set

        def start_dial(_address):
            started.set()
            return errno.EINPROGRESS

        def wait_for_connect(_readable, _writable, _errors, timeout):
            closed.wait(timeout)
            return [], [], []

        attempt.connect_ex.side_effect = start_dial
        answer = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))
        registry = MediaRegistry(SafeConnector(resolver=lambda *_: [answer]))
        with mock.patch("worldmedia_media.socket.socket", return_value=attempt), \
             mock.patch("worldmedia_media.select.select", side_effect=wait_for_connect), \
             mock.patch.object(stream_title, "_close_socket", wraps=stream_title._close_socket) as cancel_dial:
            self.assertEqual(peek_stream_title(registry, station(), client_gone=started.is_set)["status"], "no title")
            cancel_dial.assert_called_once_with(attempt)
            self.assertTrue(closed.is_set())
        attempt.shutdown.assert_called_once_with(socket.SHUT_RDWR)

    def test_wall_clock_cap_cuts_off_dripping_headers_and_body(self):
        for headers in (False, True):
            with self.subTest(dripping_headers=headers):
                def drip(server, client):
                    with client:
                        client.settimeout(2)
                        try:
                            client.recv(4096)
                            client.sendall(b"HTTP/1.0 200 OK\r\nicy-metaint: 8000\r\n")
                            if not headers:
                                client.sendall(b"\r\n")
                            while not server.stop.is_set():
                                client.sendall(b"x")
                                time.sleep(0.03)
                        except OSError:
                            server.closed_by_peer.set()

                server = fixtures.LocalServer(drip)
                try:
                    registry = MediaRegistry(fixtures.loopback_connector(server.port))
                    started = time.monotonic()
                    with mock.patch.object(stream_title, "PEEK_SECONDS", 0.25):
                        self.assertEqual(peek_stream_title(registry, station(f"http://station.example:{server.port}/"))["status"],
                                         "no title")
                    self.assertLess(time.monotonic() - started, 1.0)
                    self.assertTrue(server.closed_by_peer.wait(2))
                finally:
                    server.close()

    def test_four_slots_are_shared_between_registries(self):
        entered = threading.Barrier(PEEK_CONCURRENCY + 1)
        release = threading.Event()
        playing = MediaRegistry(fixtures.loopback_connector(1))
        root = playing.register(station())
        playing.begin_playing_relay(root.token)
        playing.note_stream_title(root.token, "Cached track")
        self.addCleanup(playing.end_playing_relay, root.token)

        def wait_for_release(*args):
            entered.wait(3)
            release.wait(3)
            return {"status": "no title", "title": None}

        with mock.patch.object(stream_title, "_read_title", side_effect=wait_for_release), \
                concurrent.futures.ThreadPoolExecutor(PEEK_CONCURRENCY) as pool:
            jobs = [pool.submit(peek_stream_title, MediaRegistry(), station()) for _ in range(PEEK_CONCURRENCY)]
            try:
                entered.wait(3)
                self.assertEqual(peek_stream_title(playing, station()),
                                 {"status": "title", "title": "Cached track"})
                self.assertEqual(peek_stream_title(MediaRegistry(), station(media_type="hls")),
                                 {"status": "not available", "title": None})
                with self.assertRaises(ProbeBusy):
                    peek_stream_title(MediaRegistry(), station())
            finally:
                release.set()
            for job in jobs:
                self.assertEqual(job.result(timeout=3)["status"], "no title")

    def test_page_disconnect_closes_the_upstream_before_the_deadline(self):
        gone = threading.Event()

        def disconnect(server, client):
            with client:
                client.settimeout(2)
                client.recv(4096)
                client.sendall(b"HTTP/1.0 200 OK\r\nicy-metaint: 8000\r\n\r\n")
                gone.set()
                if client.recv(1) == b"":
                    server.closed_by_peer.set()

        server = fixtures.LocalServer(disconnect)
        self.addCleanup(server.close)
        registry = MediaRegistry(fixtures.loopback_connector(server.port))
        started = time.monotonic()
        result = peek_stream_title(
            registry, station(f"http://station.example:{server.port}/"), client_gone=gone.is_set,
        )
        self.assertEqual(result["status"], "no title")
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertTrue(server.closed_by_peer.wait(2))


class StreamTitleRouteTests(unittest.TestCase):
    def test_only_authenticated_post_can_trigger_a_peek(self):
        route = "/api/v1/streams/title-peek"
        with worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            self.port = server.server_port
            request = fixtures.ProbeRouteTests.request
            origin = f"http://127.0.0.1:{self.port}"
            headers = {"Origin": origin, "Content-Type": "application/json",
                       "X-WorldMedia-Token": worldmedia_server.SESSION_TOKEN}
            body = json.dumps(station(media_type="hls")).encode()
            try:
                with mock.patch.object(worldmedia_server, "peek_stream_title", wraps=peek_stream_title) as peek:
                    response, _ = request(self, "POST", route, {**headers, "X-WorldMedia-Token": "incorrect"}, body)
                    self.assertEqual(response.status, 403)
                    response, _ = request(self, "POST", route, {**headers, "Origin": "https://outside.example"}, body)
                    self.assertEqual(response.status, 403)
                    response, _ = request(self, "GET", route, headers)
                    self.assertEqual(response.status, 405)
                    peek.assert_not_called()
                    response, envelope = request(self, "POST", route, headers, body)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(envelope["data"], {"status": "not available", "title": None})
            finally:
                server.shutdown()
                worker.join(2)


class StreamTitleSettingsTests(unittest.TestCase):
    def test_switch_round_trips_in_the_same_settings_object_as_blur_and_tabs(self):
        with tempfile.TemporaryDirectory() as scratch:
            paths = get_runtime_paths(portable=Path(scratch), state=Path(scratch))
            settings = {"theme": "system", "nowPlayingBackgroundBlur": "off", "tabsShown": {"library": True}}
            legacy = profile_transfer_path(paths)
            extra = legacy.with_name(PROFILE_TRANSFER_EXTRA_FILENAME)
            for enabled in (True, False):
                with self.subTest(enabled=enabled):
                    settings["showFavoriteTitles"] = enabled
                    values = {"worldmedia.settings.v1": json.dumps(settings)}
                    save_profile_transfer(values, paths)
                    self.assertEqual(json.loads(legacy.read_text())["values"], values)
                    self.assertFalse(extra.exists())
                    self.assertEqual(load_profile_transfer(paths), values)
