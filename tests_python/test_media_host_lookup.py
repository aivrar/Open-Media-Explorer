"""A media host name that does not exist is told apart from a lookup that could not be done."""
from __future__ import annotations

import socket
import unittest

import worldmedia_media
from worldmedia_security import ApiError


def failing_resolver(errno: int):
    def resolve(host: str, port: int):
        raise socket.gaierror(errno, "lookup failed")

    return resolve


class HostLookupTests(unittest.TestCase):
    def code_for(self, errno: int) -> str:
        with self.assertRaises(ApiError) as caught:
            worldmedia_media.resolve_target("https://station.example/live", resolver=failing_resolver(errno))
        return caught.exception.code

    def test_a_name_that_does_not_exist_has_its_own_code(self) -> None:
        for errno in sorted(worldmedia_media._NO_SUCH_NAME):
            with self.subTest(errno=errno):
                self.assertEqual(self.code_for(errno), "MEDIA_HOST_NOT_FOUND")
        self.assertIn(11001, worldmedia_media._NO_SUCH_NAME)
        self.assertIn(socket.EAI_NONAME, worldmedia_media._NO_SUCH_NAME)

    def test_a_lookup_that_could_not_be_done_keeps_the_old_code(self) -> None:
        for errno in (11002, 11003, getattr(socket, "EAI_AGAIN", 11002), getattr(socket, "EAI_FAIL", 11003)):
            with self.subTest(errno=errno):
                self.assertEqual(self.code_for(errno), "MEDIA_DNS_FAILED")

        def broken(host: str, port: int):
            raise OSError("no network")

        with self.assertRaises(ApiError) as caught:
            worldmedia_media.resolve_target("https://station.example/live", resolver=broken)
        self.assertEqual(caught.exception.code, "MEDIA_DNS_FAILED")


if __name__ == "__main__":
    unittest.main()
