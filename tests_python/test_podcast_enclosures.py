"""Podcast enclosure formats: what is listed, what stays refused, and in what order.

src/adapters/gpodder.js applies the same rules on the page; tests/gpodder.test.js
holds the matching cases.
"""
from __future__ import annotations

import unittest

from worldmedia_catalog import _enclosure, parse_podcast_feed


def kind(url: str, mime: str = "", codecs: str = "") -> str | None:
    value = _enclosure(url, mime, 0, codecs=codecs)
    return value["kind"] if value else None


NO_EXTENSION = "https://cdn.example/episodes/42"


class NewlyListedFormatTests(unittest.TestCase):
    def test_declared_type_alone(self) -> None:
        for mime, expected in (
            ("audio/mp4", "audio"), ("audio/x-m4a", "audio"), ("audio/m4a", "audio"),
            ("audio/aac", "audio"), ("audio/aacp", "audio"), ("audio/x-aac", "audio"),
            ("audio/ogg", "audio"), ("audio/opus", "audio"), ("audio/vorbis", "audio"),
            ("audio/flac", "audio"), ("audio/x-flac", "audio"),
            ("audio/wav", "audio"), ("audio/x-wav", "audio"), ("audio/wave", "audio"),
            ("audio/webm", "audio"),
            ("video/x-m4v", "video"), ("video/quicktime", "video"), ("video/webm", "video"),
            ('Audio/MP4; codecs="mp4a.40.2"', "audio"),
        ):
            with self.subTest(mime=mime):
                self.assertEqual(kind(NO_EXTENSION, mime), expected)
                self.assertEqual(_enclosure(NO_EXTENSION, mime, 0)["type"], mime.split(";")[0].lower())

    def test_file_name_alone(self) -> None:
        for suffix, expected in (
            ("m4a", "audio"), ("aac", "audio"), ("ogg", "audio"), ("oga", "audio"),
            ("opus", "audio"), ("flac", "audio"), ("wav", "audio"),
            ("m4v", "video"), ("mov", "video"), ("webm", "video"),
        ):
            with self.subTest(suffix=suffix):
                self.assertEqual(kind(f"https://cdn.example/episode.{suffix}"), expected)
                self.assertEqual(
                    kind(f"https://cdn.example/episode.{suffix.upper()}?download=1", "application/octet-stream"),
                    expected,
                )

    def test_type_and_file_name_agree(self) -> None:
        for mime, suffix, expected in (
            ("audio/mp4", "m4a", "audio"), ("audio/x-m4a", "m4a", "audio"),
            ("audio/mp4", "mp4", "audio"), ("audio/x-m4a", "mp4", "audio"), ("audio/m4a", "mp4", "audio"),
            ("audio/aac", "aac", "audio"), ("audio/aacp", "aac", "audio"),
            ("audio/ogg", "ogg", "audio"), ("audio/ogg", "oga", "audio"), ("audio/ogg", "opus", "audio"),
            ("audio/opus", "opus", "audio"), ("audio/vorbis", "ogg", "audio"),
            ("application/ogg", "ogg", "audio"), ("application/ogg", "oga", "audio"),
            ("application/ogg", "opus", "audio"),
            ("audio/flac", "flac", "audio"), ("audio/x-flac", "flac", "audio"),
            ("audio/wav", "wav", "audio"), ("audio/x-wav", "wav", "audio"), ("audio/wave", "wav", "audio"),
            ("audio/webm", "webm", "audio"),
            ("video/x-m4v", "m4v", "video"), ("video/mp4", "m4v", "video"),
            ("video/quicktime", "mov", "video"), ("video/mp4", "mov", "video"),
            ("video/webm", "webm", "video"),
        ):
            with self.subTest(mime=mime, suffix=suffix):
                self.assertEqual(kind(f"https://cdn.example/episode.{suffix}", mime), expected)

    def test_codecs_the_browser_plays(self) -> None:
        for mime, codecs, expected in (
            ("audio/mp4", "mp4a.40.2", "audio"), ("audio/ogg", "opus", "audio"),
            ("audio/ogg", "vorbis", "audio"), ("audio/flac", "flac", "audio"),
            ("audio/webm", "opus", "audio"),
            ("video/webm", "vp09.00.10.08,opus", "video"), ("video/webm", "vp8, vorbis", "video"),
            ("video/mp4", "av01.0.05M.08,mp4a.40.2", "video"),
            ("video/quicktime", "avc1.4d401f,mp4a.40.2", "video"),
            # HLS with Opus audio was refused before.
            ("application/vnd.apple.mpegurl", "mp4a.40.2,opus", "hls"),
            ("application/x-mpegurl", "vp09.00.10.08,opus", "hls"),
        ):
            with self.subTest(mime=mime, codecs=codecs):
                url = "https://cdn.example/live.m3u8" if "mpegurl" in mime else NO_EXTENSION
                value = _enclosure(url, mime, 0, codecs=codecs)
                self.assertEqual(value["kind"], expected)
                self.assertEqual(value["codecs"], codecs.lower())

    def test_formats_listed_before_are_unchanged(self) -> None:
        for url, mime, codecs, expected in (
            ("https://cdn.example/episode.mp3", "audio/mpeg", "", "audio"),
            ("https://cdn.example/episode.mp3", "", "", "audio"),
            (NO_EXTENSION, "audio/mp3", "mp3", "audio"),
            ("https://cdn.example/episode.mp4", "video/mp4", "avc1.4d401f,mp4a.40.2", "video"),
            ("https://cdn.example/episode.mp4", "application/octet-stream", "", "video"),
            ("https://cdn.example/live.m3u8", "application/vnd.apple.mpegurl", "", "hls"),
            (NO_EXTENSION, "audio/mpegurl", "", "hls"),
        ):
            with self.subTest(url=url, mime=mime):
                self.assertEqual(kind(url, mime, codecs), expected)


class StillRefusedFormatTests(unittest.TestCase):
    def test_type_and_file_name_disagree(self) -> None:
        for url, mime in (
            ("https://cdn.example/episode.m4v", "audio/mp4"),
            ("https://cdn.example/episode.mp4", "audio/ogg"),
            ("https://cdn.example/episode.mp4", "audio/mpeg"),
            ("https://cdn.example/episode.mov", "audio/flac"),
            ("https://cdn.example/episode.mov", "audio/webm"),
            ("https://cdn.example/episode.webm", "audio/mpeg"),
            ("https://cdn.example/episode.m4a", "video/webm"),
            ("https://cdn.example/episode.ogg", "video/quicktime"),
            ("https://cdn.example/episode.opus", "video/mp4"),
            ("https://cdn.example/episode.m3u8", "audio/x-m4a"),
            ("https://cdn.example/episode.m4a", "application/vnd.apple.mpegurl"),
            # application/ogg needs an audio Ogg name.
            (NO_EXTENSION, "application/ogg"),
            ("https://cdn.example/episode.mp4", "application/ogg"),
        ):
            with self.subTest(url=url, mime=mime):
                self.assertIsNone(kind(url, mime))

    def test_formats_the_browser_cannot_be_relied_on_to_play(self) -> None:
        for url, mime, codecs in (
            ("https://cdn.example/episode.ogv", "video/ogg", ""),
            ("https://cdn.example/episode.ogv", "", ""),
            ("https://cdn.example/episode.ogv", "application/ogg", ""),
            (NO_EXTENSION, "video/ogg", ""),
            ("https://cdn.example/episode.ogg", "audio/ogg", "theora, vorbis"),
            ("https://cdn.example/episode.mkv", "video/x-matroska", ""),
            ("https://cdn.example/episode.mkv", "", ""),
            ("https://cdn.example/episode.mkv", "video/webm", ""),
            ("https://cdn.example/episode.mp4", "video/mp4", "hvc1.1.6.L93"),
            ("https://cdn.example/episode.mp4", "video/mp4", "hev1.1.6.L93.B0"),
            ("https://cdn.example/episode.mov", "video/quicktime", "hvc1.2.4.L120,mp4a.40.2"),
            ("https://cdn.example/live.m3u8", "application/vnd.apple.mpegurl", "hvc1.1.6.L93,mp4a.40.2"),
            ("https://cdn.example/episode.torrent", "", ""),
            ("https://cdn.example/episode.torrent", "audio/ogg", ""),
            (NO_EXTENSION, "application/x-bittorrent", ""),
            (NO_EXTENSION, "text/html", ""),
            (NO_EXTENSION, "audio/ac3", ""),
            # A codecs value with no codec of the declared kind.
            ("https://cdn.example/episode.m4a", "audio/mp4", "ac-3"),
            ("https://cdn.example/episode.mp4", "video/mp4", "mp4a.40.2"),
        ):
            with self.subTest(url=url, mime=mime, codecs=codecs):
                self.assertIsNone(kind(url, mime, codecs))

    def test_a_refused_codec_named_inside_the_type_is_refused(self) -> None:
        self.assertIsNone(_enclosure("https://media.example/a.mp4", 'video/mp4; codecs="hvc1.1.6.L93.B0"', 0))
        self.assertIsNone(_enclosure("https://media.example/a.ogg", "audio/ogg; codecs=theora", 0))
        self.assertEqual(_enclosure("https://media.example/a.opus", "audio/ogg;codecs=opus", 0)["kind"], "audio")
        self.assertEqual(
            _enclosure("https://media.example/a.mp4", 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 0)["kind"],
            "video",
        )

    def test_unsafe_addresses_stay_refused_whatever_the_format(self) -> None:
        for url in (
            "file:///C:/episode.m4a",
            "https://user:pass@cdn.example/episode.ogg",
            "ftp://cdn.example/episode.flac",
        ):
            with self.subTest(url=url):
                self.assertIsNone(kind(url, "audio/mp4"))


class EnclosureOrderTests(unittest.TestCase):
    FEED = b'''<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
    <title>Order</title>
    <item><title>AAC first</title><guid>aac-first</guid>
    <enclosure url="https://cdn.example/one.m4a" type="audio/x-m4a" />
    <podcast:alternateEnclosure type="audio/opus" default="true"><podcast:source uri="https://cdn.example/one.opus" /></podcast:alternateEnclosure>
    <podcast:alternateEnclosure type="audio/mpeg"><podcast:source uri="https://cdn.example/one.mp3" /></podcast:alternateEnclosure>
    <podcast:alternateEnclosure type="video/mp4" codecs="avc1.4d401f"><podcast:source uri="https://cdn.example/one.mp4" /></podcast:alternateEnclosure>
    </item>
    <item><title>No GUID</title>
    <enclosure url="https://cdn.example/two.ogg" type="audio/ogg" />
    <podcast:alternateEnclosure type="audio/mpeg"><podcast:source uri="https://cdn.example/two.mp3" /></podcast:alternateEnclosure>
    </item>
    <item><title>Only new formats</title>
    <enclosure url="https://cdn.example/three.flac" type="audio/flac" />
    <podcast:alternateEnclosure type="audio/aac"><podcast:source uri="https://cdn.example/three.aac" /></podcast:alternateEnclosure>
    </item>
    <item><title>Same address twice</title><guid>same</guid>
    <enclosure url="https://cdn.example/four" type="audio/ogg" />
    <podcast:alternateEnclosure type="audio/mpeg"><podcast:source uri="https://cdn.example/four" /></podcast:alternateEnclosure>
    </item>
    </channel></rss>'''

    def test_formats_listed_before_come_first_in_feed_order(self) -> None:
        items = parse_podcast_feed(self.FEED, "https://feed.example/order.xml")["items"]
        self.assertEqual(
            [entry["url"] for entry in items[0]["enclosures"]],
            [
                "https://cdn.example/one.mp3", "https://cdn.example/one.mp4",
                "https://cdn.example/one.m4a", "https://cdn.example/one.opus",
            ],
        )
        self.assertEqual(
            [entry["url"] for entry in items[2]["enclosures"]],
            ["https://cdn.example/three.flac", "https://cdn.example/three.aac"],
        )
        # The record that was listed before wins a duplicated address.
        self.assertEqual(
            [(entry["url"], entry["type"]) for entry in items[3]["enclosures"]],
            [("https://cdn.example/four", "audio/mpeg")],
        )

    def test_an_episode_without_a_guid_keeps_the_identity_it_had(self) -> None:
        items = parse_podcast_feed(self.FEED, "https://feed.example/order.xml")["items"]
        # Before, the Ogg file was dropped and the MP3 address was the identity.
        self.assertEqual(items[1]["guid"], "https://cdn.example/two.mp3")
        self.assertEqual(items[2]["guid"], "https://cdn.example/three.flac")

    def test_atom_enclosures_follow_the_same_order(self) -> None:
        feed = b'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom order</title><id>atom</id>
        <entry><title>One</title>
        <link rel="enclosure" type="audio/webm" href="https://cdn.example/one.webm" />
        <link rel="enclosure" type="audio/mpeg" href="https://cdn.example/one.mp3" />
        </entry>
        <entry><title>Two</title><id>two</id>
        <link rel="enclosure" type="video/quicktime" href="https://cdn.example/two.mov" />
        </entry></feed>'''
        items = parse_podcast_feed(feed, "https://feed.example/atom.xml")["items"]
        self.assertEqual(
            [(entry["url"], entry["kind"]) for entry in items[0]["enclosures"]],
            [("https://cdn.example/one.mp3", "audio"), ("https://cdn.example/one.webm", "audio")],
        )
        self.assertEqual(items[0]["guid"], "https://cdn.example/one.mp3")
        self.assertEqual(items[1]["enclosures"][0]["kind"], "video")

    def test_a_show_with_only_m4a_episodes_has_episodes(self) -> None:
        feed = b'''<rss version="2.0"><channel><title>AAC show</title>
        <item><guid>a</guid><enclosure url="https://cdn.example/a.m4a" type="audio/x-m4a" length="1000" /></item>
        <item><guid>b</guid><enclosure url="https://cdn.example/b.m4a" type="audio/mp4" length="2000" /></item>
        </channel></rss>'''
        items = parse_podcast_feed(feed, "https://feed.example/aac.xml")["items"]
        self.assertEqual([item["guid"] for item in items], ["a", "b"])
        self.assertEqual(
            [(entry["kind"], entry["type"], entry["length"]) for item in items for entry in item["enclosures"]],
            [("audio", "audio/x-m4a", 1000), ("audio", "audio/mp4", 2000)],
        )


if __name__ == "__main__":
    unittest.main()
