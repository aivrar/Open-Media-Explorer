from __future__ import annotations

import http.client
import json
import time
import unittest
import urllib.error
import urllib.request

from tests_python.fixture_server import AUDIO_BYTES, MediaFixtureServer


class MediaFixtureServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = MediaFixtureServer()
        cls.server.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.__exit__(None, None, None)

    def fetch(self, path: str, **kwargs) -> urllib.response.addinfourl:
        return urllib.request.urlopen(self.server.base_url + path, timeout=2, **kwargs)

    def test_finite_audio_video_and_range(self) -> None:
        with self.fetch("/media/audio.mp3") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), AUDIO_BYTES)
            self.assertEqual(response.headers["Accept-Ranges"], "bytes")
        request = urllib.request.Request(
            self.server.base_url + "/media/audio.mp3", headers={"Range": "bytes=3-9"}
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), AUDIO_BYTES[3:10])
            self.assertEqual(response.headers["Content-Range"], f"bytes 3-9/{len(AUDIO_BYTES)}")
        with self.fetch("/media/video.mp4") as response:
            self.assertEqual(response.headers.get_content_type(), "video/mp4")

    def test_vod_and_live_hls_manifests(self) -> None:
        with self.fetch("/hls/vod/index.m3u8") as response:
            vod = response.read().decode()
        with self.fetch("/hls/live/index.m3u8") as response:
            live = response.read().decode()
        self.assertIn("#EXT-X-ENDLIST", vod)
        self.assertNotIn("#EXT-X-ENDLIST", live)
        self.assertIn("#EXT-X-MEDIA-SEQUENCE", live)

    def test_redirects_expose_public_and_private_targets(self) -> None:
        no_redirect = urllib.request.build_opener(_NoRedirect())
        for path, expected in [
            ("/redirect/public", "/media/audio.mp3"),
            ("/redirect/private", "http://127.0.0.1:1/private"),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                no_redirect.open(self.server.base_url + path, timeout=2)
            self.assertEqual(caught.exception.code, 302)
            self.assertEqual(caught.exception.headers["Location"], expected)

    def test_required_headers_are_enforced_and_recorded(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as denied:
            self.fetch("/protected")
        self.assertEqual(denied.exception.code, 403)
        request = urllib.request.Request(self.server.base_url + "/protected", headers={
            "Referer": "https://catalog.example/item",
            "User-Agent": "WorldMediaFixture/1",
        })
        with urllib.request.urlopen(request, timeout=2) as response:
            self.assertEqual(response.read(), b"allowed")
        self.assertEqual(self.server.state.requests[-1]["path"], "/protected")

    def test_slow_malformed_and_interrupted_responses(self) -> None:
        started = time.monotonic()
        with self.fetch("/slow?seconds=0.02") as response:
            self.assertEqual(response.read(), b"slow")
        self.assertGreaterEqual(time.monotonic() - started, 0.015)
        with self.fetch("/malformed.json") as response:
            with self.assertRaises(json.JSONDecodeError):
                json.loads(response.read())
        with self.fetch("/malformed.m3u8") as response:
            self.assertNotIn(b"#EXTM3U", response.read())
        with self.fetch("/interrupted") as response:
            with self.assertRaises(http.client.IncompleteRead):
                response.read()

    def test_endless_stream_can_be_cancelled(self) -> None:
        response = self.fetch("/stream/endless")
        self.assertEqual(len(response.read(64)), 64)
        response.close()
        self.assertTrue(self.server.state.stream_cancelled.wait(1.5))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        del req, fp, code, msg, headers, newurl
        return None


if __name__ == "__main__":
    unittest.main()
