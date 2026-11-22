import socket
import threading
import time
import unittest
from unittest import mock

import worldmedia_media
from worldmedia_media import ResolvedTarget, SafeConnector, _connect_first, _dial_order


def answer(address: str, port: int):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (address, port))]


class _StuckSocket:
    """A connection attempt that never completes (a dead address)."""

    def __init__(self) -> None:
        self._pair = socket.socketpair()
        self.closed = False

    def setblocking(self, _flag) -> None:
        pass

    def connect_ex(self, _address) -> int:
        return 10035

    def fileno(self) -> int:
        # The far end of a socket pair that is never written to and whose
        # send buffer is never asked about: select reports nothing for it.
        return self._blocked.fileno()

    def close(self) -> None:
        self.closed = True
        for end in self._pair:
            end.close()
        self._listener.close()

    def getsockopt(self, *_args) -> int:
        return 0


def stuck_socket() -> _StuckSocket:
    # A listening socket is never writable and never in error: select stays
    # silent on it, which is what a dead address looks like while connecting.
    item = _StuckSocket()
    item._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    item._listener.bind(("127.0.0.1", 0))
    item._listener.listen(1)
    item._blocked = item._listener
    return item


class ConnectFirstTests(unittest.TestCase):
    def setUp(self) -> None:
        worldmedia_media._good_addresses.clear()
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.port = self.listener.getsockname()[1]
        self.addCleanup(self.listener.close)

    def dead_then_real(self):
        """socket.socket stand-in: the address 192.0.2.1 never connects, others are real."""
        real = socket.socket
        made: list = []

        class Chooser:
            def __init__(self, *args, **kwargs) -> None:
                self._real = real(*args, **kwargs)
                self._stuck = None

            def connect_ex(self, address):
                if address[0] == "192.0.2.1":
                    self._real.close()
                    self._stuck = stuck_socket()
                    made.append(self._stuck)
                    return self._stuck.connect_ex(address)
                return self._real.connect_ex(address)

            def fileno(self):
                return (self._stuck or self._real).fileno()

            def close(self):
                (self._stuck or self._real).close()

            def __getattr__(self, name):
                return getattr(self._stuck or self._real, name)

        def choose(*args, **kwargs):
            # accept() builds its socket through the same name; leave that alone.
            if kwargs.get("fileno") is not None:
                return real(*args, **kwargs)
            return Chooser(*args, **kwargs)

        return choose, made

    def test_a_dead_first_address_costs_a_moment_not_the_whole_time_limit(self) -> None:
        chooser, made = self.dead_then_real()
        started = time.monotonic()
        with mock.patch("worldmedia_media.socket.socket", chooser):
            sock, address = _connect_first(["192.0.2.1", "127.0.0.1"], self.port, 8.0)
        elapsed = time.monotonic() - started
        try:
            self.assertEqual(address, "127.0.0.1")
            self.assertLess(elapsed, 2.0)
            self.assertEqual(sock.gettimeout(), 8.0)
        finally:
            sock.close()
        self.assertEqual(len(made), 1)
        self.assertTrue(made[0].closed)

    def test_every_address_dead_gives_up_at_the_time_limit(self) -> None:
        chooser, made = self.dead_then_real()
        started = time.monotonic()
        with mock.patch("worldmedia_media.socket.socket", chooser):
            with self.assertRaises(OSError):
                _connect_first(["192.0.2.1", "192.0.2.1"], self.port, 0.8)
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.7)
        self.assertLess(elapsed, 3.0)
        self.assertEqual(len(made), 2)
        self.assertTrue(all(item.closed for item in made))

    def test_a_cancelled_attempt_stops_and_closes_everything(self) -> None:
        chooser, made = self.dead_then_real()
        stop = threading.Event()
        threading.Timer(0.3, stop.set).start()
        started = time.monotonic()
        with mock.patch("worldmedia_media.socket.socket", chooser):
            with self.assertRaises(OSError):
                _connect_first(["192.0.2.1", "192.0.2.1"], self.port, 8.0, stop.is_set)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertTrue(all(item.closed for item in made))

    def test_the_two_address_families_take_turns_ipv4_first_and_the_last_good_address_goes_first(self) -> None:
        target = ResolvedTarget(
            "https://media.example/a", "https", "media.example", 443, "/a", "2001:db8::1",
            ("2001:db8::1", "2001:db8::2", "192.0.2.1", "192.0.2.2", "2001:db8::3"),
        )
        self.assertEqual(
            _dial_order(target),
            ["192.0.2.1", "2001:db8::1", "192.0.2.2", "2001:db8::2", "2001:db8::3"],
        )
        only_v6 = ResolvedTarget(
            "https://media.example/a", "https", "media.example", 443, "/a", "2001:db8::1",
            ("2001:db8::1", "2001:db8::2"),
        )
        self.assertEqual(_dial_order(only_v6), ["2001:db8::1", "2001:db8::2"])
        worldmedia_media._remember_good_address("media.example", 443, "192.0.2.2")
        self.assertEqual(_dial_order(target)[0], "192.0.2.2")
        self.assertEqual(sorted(_dial_order(target)), sorted(target.addresses))
        # An address that is not in this lookup's answer is never added.
        worldmedia_media._remember_good_address("media.example", 443, "203.0.113.9")
        self.assertNotIn("203.0.113.9", _dial_order(target))
        self.assertEqual(_dial_order(target)[0], "192.0.2.1")

    def test_the_connector_answers_quickly_past_a_dead_address_and_remembers_the_good_one(self) -> None:
        def serve() -> None:
            for _ in range(2):
                client, _address = self.listener.accept()
                with client:
                    client.settimeout(5)
                    data = b""
                    while b"\r\n\r\n" not in data:
                        chunk = client.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")

        self.listener.settimeout(5)
        server = threading.Thread(target=serve, daemon=True)
        server.start()
        chooser, made = self.dead_then_real()
        connector = SafeConnector(
            resolver=lambda _host, port: answer("192.0.2.1", port) + answer("127.0.0.1", port),
            address_policy=lambda _address: True,
        )
        with mock.patch("worldmedia_media.socket.socket", chooser):
            for expected_dead_attempts in (1, 1):
                started = time.monotonic()
                upstream = connector.open(f"http://media.example:{self.port}/file")
                try:
                    self.assertEqual(upstream.response.read(), b"ok")
                finally:
                    upstream.close()
                self.assertLess(time.monotonic() - started, 2.0)
                # The second request goes straight to the address that worked.
                self.assertEqual(len(made), expected_dead_attempts)
        server.join(5)


if __name__ == "__main__":
    unittest.main()
