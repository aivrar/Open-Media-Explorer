from __future__ import annotations

import base64
import gzip
import hashlib
import json
import socket
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest import mock

from worldmedia_catalog import (
    MAX_ASSET_BYTES,
    AssetCache,
    AssetRegistry,
    BoundedFetcher,
    CatalogCache,
    CatalogError,
    CatalogService,
    attach_podcast_identities,
    canonical_http_url,
    normalize_owncast_snapshot,
    normalize_peertube_detail,
    parse_owncast_home,
    parse_owncast_playlist,
    parse_podcast_feed,
    validate_image,
)
from worldmedia_media import ResolvedTarget
from worldmedia_media import SafeConnector
from worldmedia_security import ApiError
from tests_python.catalog_fixture_server import CatalogFixtureServer


FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "five-new-sources"
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def png_with_dimensions(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            len(data).to_bytes(4, "big")
            + kind
            + data
            + (zlib.crc32(kind + data) & 0xFFFFFFFF).to_bytes(4, "big")
        )

    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    scanline = b"\x00" + b"\x00\x00\x00\x00" * width
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(scanline)) + chunk(b"IEND", b"")


def png_without_image_data() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            len(data).to_bytes(4, "big") + kind + data
            + (zlib.crc32(kind + data) & 0xFFFFFFFF).to_bytes(4, "big")
        )

    ihdr = b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


class FakeClock:
    def __init__(self) -> None:
        self.value = 1_700_000_000.0

    def time(self) -> float:
        return self.value

    def monotonic(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FakeResponse:
    def __init__(self, status: int, body: bytes, content_type: str, headers=None) -> None:
        self.status = status
        self.body = body
        self.headers = {"content-type": content_type, **{str(k).lower(): str(v) for k, v in (headers or {}).items()}}

    def getheader(self, name: str, default=None):
        return self.headers.get(name.lower(), default)

    def close(self) -> None:
        pass


class FakeUpstream:
    def __init__(self, response: FakeResponse, url: str, *, gate: threading.Event | None = None) -> None:
        self.response = response
        self.url = url
        self.gate = gate

    def iter_chunks(self, *, cancel=None, chunk_size=64 * 1024):
        if self.gate:
            self.gate.wait(2)
        for offset in range(0, len(self.response.body), max(1, min(chunk_size, 4096))):
            if cancel and cancel.is_set():
                raise CatalogError(408, "CATALOG_CANCELLED", "cancelled")
            yield self.response.body[offset:offset + max(1, min(chunk_size, 4096))]

    def close(self) -> None:
        self.response.close()


class FakeConnector:
    def __init__(self, routes=None, *, policy=None, root=None) -> None:
        self.routes = routes if root is None else root.routes
        self.calls = [] if root is None else root.calls
        self.policy = policy
        self.root = self if root is None else root
        self.lock = threading.Lock() if root is None else root.lock

    def with_target_policy(self, policy):
        previous = self.policy
        return FakeConnector(
            policy=lambda target: (previous(target) if previous else True) and policy(target),
            root=self.root,
        )

    def resolve(self, url: str):
        normalized = canonical_http_url(url)
        parsed = __import__("urllib.parse").parse.urlsplit(normalized)
        target = ResolvedTarget(
            normalized,
            parsed.scheme,
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            __import__("urllib.parse").parse.urlunsplit(("", "", parsed.path, parsed.query, "")),
            "93.184.216.34",
        )
        if self.policy and not self.policy(target):
            raise CatalogError(403, "CATALOG_TARGET_REJECTED", "rejected")
        return target

    def open(self, url: str, **kwargs):
        target = self.resolve(url)
        with self.lock:
            self.calls.append((target.url, kwargs))
            route = self.routes[target.url]
            if isinstance(route, list):
                response = route.pop(0) if len(route) > 1 else route[0]
            else:
                response = route
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response()
        return FakeUpstream(response, getattr(response, "final_url", target.url), gate=getattr(response, "gate", None))


def response(status: int, body: bytes, content_type: str, **headers) -> FakeResponse:
    return FakeResponse(status, body, content_type, headers)


class CatalogUrlAndFeedTests(unittest.TestCase):
    def test_url_canonicalization_and_rejections(self) -> None:
        self.assertEqual(
            canonical_http_url(" HTTPS://Example.COM:443/feed.xml?q=one#fragment "),
            "https://example.com/feed.xml?q=one",
        )
        self.assertEqual(canonical_http_url("http://[2001:4860:4860::8888]:80"), "http://[2001:4860:4860::8888]/")
        for value in (
            "file:///etc/passwd",
            "https://user:pass@example.com/feed",
            "https://%31%32%37.0.0.1/feed",
            "https://bad_host.example/feed",
            "https://example.com:0/feed",
            "https://example.com/%zz",
            "https://example.com/a\\b",
        ):
            with self.subTest(value=value), self.assertRaises(CatalogError):
                canonical_http_url(value)

    def test_rss_atom_live_explicit_and_alternate_enclosure_normalize(self) -> None:
        expected = {
            "podcast-rss.xml": ("rss", 2, "not-explicit"),
            "podcast-atom.xml": ("atom", 1, "unrated"),
            "podcast-live.xml": ("rss", 1, "unrated"),
            "podcast-explicit.xml": ("rss", 1, "explicit"),
        }
        for name, contract in expected.items():
            with self.subTest(name=name):
                value = parse_podcast_feed((FIXTURES / name).read_bytes(), f"https://feeds.example.test/{name}")
                self.assertEqual((value["format"], len(value["items"]), value["content_rating"]), contract)
                self.assertTrue(all(item["guid"] and item["enclosures"] for item in value["items"]))
        live = parse_podcast_feed((FIXTURES / "podcast-live.xml").read_bytes(), "https://feeds.example.test/live")
        self.assertTrue(live["items"][0]["live"])
        self.assertEqual(live["items"][0]["enclosures"][0]["kind"], "hls")
        explicit = parse_podcast_feed((FIXTURES / "podcast-explicit.xml").read_bytes(), "https://feeds.example.test/explicit")
        self.assertEqual(explicit["items"][0]["content_rating"], "explicit")

        scheduled = b'''<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Schedule</title><podcast:liveItem status="pending"><guid>pending</guid>
        <enclosure url="https://cdn.example/pending.m3u8" type="application/x-mpegURL" /></podcast:liveItem>
        <podcast:liveItem status="ended"><guid>ended</guid>
        <enclosure url="https://cdn.example/ended.m3u8" type="application/x-mpegURL" /></podcast:liveItem>
        </channel></rss>'''
        self.assertEqual(parse_podcast_feed(
            scheduled, "https://feed.example/schedule.xml"
        )["items"], [])

        alternate = b'''<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Alternate</title><podcast:license url="https://license.example/">CC BY</podcast:license><item><title>One</title><guid>one</guid>
        <podcast:alternateEnclosure type="audio/mpeg" length="4"><podcast:source uri="https://cdn.example/one.mp3" /></podcast:alternateEnclosure>
        </item></channel></rss>'''
        value = parse_podcast_feed(alternate, "https://feed.example/show.xml")
        self.assertEqual(value["items"][0]["enclosures"][0]["relation"], "alternate")
        self.assertEqual(value["license"]["label"], "CC BY")
        self.assertEqual(value["items"][0]["license"]["label"], "CC BY")

        compatibility = b'''<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Compatibility</title><podcast:license>feed-license</podcast:license>
        <item><title>Supported</title><guid>supported</guid><podcast:license url="https://license.example/episode">episode-license</podcast:license>
        <enclosure url="https://cdn.example/default.mp3" type="audio/mpeg" />
        <podcast:alternateEnclosure type="video/mp4" default="true" codecs="avc1.4d401f"><podcast:source uri="https://cdn.example/preferred.mp4" /></podcast:alternateEnclosure></item>
        <item><title>Unsupported</title><guid>unsupported</guid><enclosure url="https://cdn.example/file.ogg" type="audio/ogg" /></item>
        <item><title>Mismatch</title><guid>mismatch</guid><enclosure url="https://cdn.example/file.mp4" type="audio/mpeg" /></item>
        <item><title>Torrent</title><guid>torrent</guid><podcast:alternateEnclosure type="audio/mpeg"><podcast:source uri="https://cdn.example/file.torrent" contentType="application/x-bittorrent" /></podcast:alternateEnclosure></item>
        <item><title>Wrong codec</title><guid>wrong-codec</guid><podcast:alternateEnclosure type="video/mp4" codecs="hvc1.1.6.L93"><podcast:source uri="https://cdn.example/hevc.mp4" /></podcast:alternateEnclosure></item>
        </channel></rss>'''
        compatible = parse_podcast_feed(compatibility, "https://feed.example/compatibility.xml")
        self.assertEqual([item["guid"] for item in compatible["items"]], ["supported"])
        self.assertEqual(compatible["items"][0]["license"]["label"], "episode-license")
        self.assertEqual(
            [(entry["kind"], entry["relation"], entry["default"], entry["codecs"])
             for entry in compatible["items"][0]["enclosures"]],
            [("audio", "enclosure", False, ""), ("video", "alternate", True, "avc1.4d401f")],
        )

        identifiers = b'''<rss version="2.0"><channel><title>Identifiers</title>
        <item><title>Preserved</title><guid>  fixture &amp;amp; id  </guid><enclosure url="https://cdn.example/preserved.mp3" type="audio/mpeg" /></item>
        <item><title>Control fallback</title><guid>line&#10;break</guid><enclosure url="https://cdn.example/fallback.mp3" type="audio/mpeg" /></item>
        </channel></rss>'''
        identifier_feed = parse_podcast_feed(identifiers, "https://feed.example/identifiers.xml")
        self.assertEqual(identifier_feed["items"][0]["guid"], "fixture &amp; id")
        self.assertEqual(identifier_feed["items"][1]["guid"], "https://cdn.example/fallback.mp3")

        namespace_variants = b'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
        xmlns:itunes="HTTPS://WWW.ITUNES.COM/DTDS/PODCAST-1.0.DTD" xml:lang="en">
        <title>Atom explicit</title><id>atom-explicit</id><subtitle>Atom summary</subtitle>
        <itunes:explicit>yes</itunes:explicit><itunes:image href="https://img.example/feed.png" />
        <entry><title>Clean episode</title><id>clean-one</id><itunes:explicit>no</itunes:explicit>
        <itunes:image href="https://img.example/item.png" />
        <link rel="enclosure" type="audio/mpeg" href="https://cdn.example/one.mp3" /></entry></feed>'''
        value = parse_podcast_feed(namespace_variants, "https://feed.example/atom.xml")
        self.assertEqual(value["content_rating"], "explicit")
        self.assertEqual(value["description"], "Atom summary")
        self.assertEqual(value["items"][0]["content_rating"], "not-explicit")
        self.assertEqual(value["items"][0]["artwork_url"], "https://img.example/item.png")

    def test_current_live_item_cannot_be_crowded_out_by_a_long_episode_archive(self) -> None:
        archived = "".join(
            f'<item><guid>archive-{index}</guid><enclosure url="https://cdn.example/{index}.mp3" type="audio/mpeg" /></item>'
            for index in range(1_000)
        )
        payload = (
            '<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>'
            '<title>Long live archive</title>'
            f'{archived}'
            '<podcast:liveItem status="live"><guid>current-live</guid>'
            '<enclosure url="https://cdn.example/live.m3u8" type="application/vnd.apple.mpegurl" />'
            '</podcast:liveItem></channel></rss>'
        ).encode("utf-8")
        parsed = parse_podcast_feed(payload, "https://feed.example/long-live.xml")
        self.assertEqual(len(parsed["items"]), 1_000)
        self.assertEqual(parsed["items"][0]["guid"], "current-live")
        self.assertTrue(parsed["items"][0]["live"])
        self.assertEqual(parsed["items"][-1]["guid"], "archive-998")

    def test_xml_security_malformed_and_independent_complexity_limits(self) -> None:
        for name, code in (("podcast-malicious.xml", "FEED_XML_UNSAFE"), ("podcast-malformed.xml", "FEED_XML_INVALID")):
            with self.subTest(name=name), self.assertRaises(CatalogError) as caught:
                parse_podcast_feed((FIXTURES / name).read_bytes(), "https://feed.example/show")
            self.assertEqual(caught.exception.code, code)
        deep = ("<rss><channel><title>x</title><item><title>x</title><guid>x</guid>" + "<x>" * 70 + "y" + "</x>" * 70 + '<enclosure url="https://cdn.example/x.mp3" type="audio/mpeg"/></item></channel></rss>').encode()
        with self.assertRaises(CatalogError) as caught:
            parse_podcast_feed(deep, "https://feed.example/deep")
        self.assertEqual(caught.exception.code, "FEED_XML_TOO_COMPLEX")
        huge_attribute = (b'<rss><channel><title>x</title><item a="' + b"a" * 9000 + b'"><enclosure url="https://cdn.example/x.mp3" type="audio/mpeg"/></item></channel></rss>')
        with self.assertRaises(CatalogError):
            parse_podcast_feed(huge_attribute, "https://feed.example/attribute")

    def test_bounded_fetcher_decodes_gzip_and_rejects_expansion_or_wrong_type(self) -> None:
        payload = b"<rss><channel><title>x</title></channel></rss>"
        compressed = gzip.compress(payload)
        connector = FakeConnector({
            "https://feed.example/gzip": response(200, compressed, "application/xml", **{"Content-Encoding": "gzip"}),
            "https://feed.example/html": response(200, b"<html>captcha</html>", "text/html"),
            "https://feed.example/bomb": response(200, gzip.compress(b"x" * 5000), "application/xml", **{"Content-Encoding": "gzip"}),
            "https://feed.example/rate": response(429, b"{}", "application/json", **{"Retry-After": "37"}),
        })
        fetcher = BoundedFetcher(connector)
        self.assertEqual(fetcher.fetch("https://feed.example/gzip", accept="application/xml", allowed_types={"application/xml"}).data, payload)
        with self.assertRaises(CatalogError) as wrong:
            fetcher.fetch("https://feed.example/html", accept="application/xml", allowed_types={"application/xml"})
        self.assertEqual(wrong.exception.code, "CATALOG_CONTENT_TYPE")
        with self.assertRaises(CatalogError) as bomb:
            fetcher.fetch("https://feed.example/bomb", accept="application/xml", allowed_types={"application/xml"}, max_decoded=1024)
        self.assertEqual(bomb.exception.code, "CATALOG_DECODED_TOO_LARGE")
        with self.assertRaises(CatalogError) as limited:
            fetcher.fetch("https://feed.example/rate", accept="application/xml", allowed_types={"application/xml"})
        self.assertEqual(limited.exception.code, "CATALOG_RATE_LIMITED")
        self.assertEqual(limited.exception.retry_after, 37)


class CatalogProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.peer = json.loads((FIXTURES / "peertube.json").read_text(encoding="utf-8"))

    def test_peertube_public_live_vod_ratings_choices_and_rejections(self) -> None:
        vod = self.peer["originDetails"]["vod"]
        normalized = normalize_peertube_detail(vod, vod["url"], vod["uuid"])
        self.assertEqual(normalized["content_rating"], "not-explicit")
        self.assertEqual(normalized["media_type"], "hls")
        self.assertTrue(normalized["download_url"].endswith("fixture-vod-720.mp4"))
        live = self.peer["originDetails"]["live"]
        normalized = normalize_peertube_detail(live, live["url"], live["uuid"])
        self.assertTrue(normalized["is_live"])
        self.assertFalse(normalized["download_enabled"])
        explicit = self.peer["originDetails"]["explicit"]
        normalized = normalize_peertube_detail(explicit, explicit["url"], explicit["uuid"])
        self.assertEqual(normalized["content_rating"], "explicit")
        self.assertEqual(normalized["playback_url"], "")
        for name, code in (("private", "PEERTUBE_NOT_PUBLIC"), ("unpublished", "PEERTUBE_NOT_PUBLISHED"), ("malformed", "PEERTUBE_SCHEMA_INVALID")):
            detail = self.peer["originDetails"][name]
            uuid_value = detail.get("uuid") if isinstance(detail.get("uuid"), str) else "66666666-6666-4666-8666-666666666666"
            watch = f"https://video.example.org/videos/watch/{uuid_value}"
            with self.subTest(name=name), self.assertRaises(CatalogError) as caught:
                normalize_peertube_detail(detail, watch, uuid_value)
            self.assertIn(caught.exception.code, {code, "PEERTUBE_ID_MISMATCH"})
        for field, code in (("privacy", "PEERTUBE_NOT_PUBLIC"), ("state", "PEERTUBE_NOT_PUBLISHED")):
            malformed_id = dict(vod)
            malformed_id[field] = {"id": True, "label": "boolean is not an integer ID"}
            with self.subTest(field=field), self.assertRaises(CatalogError) as caught:
                normalize_peertube_detail(malformed_id, vod["url"], vod["uuid"])
            self.assertEqual(caught.exception.code, code)

    def test_peertube_detail_permissions_ratings_licenses_and_choice_bounds(self) -> None:
        vod = self.peer["originDetails"]["vod"]

        for value in ("yes", 1, None):
            malformed_permission = json.loads(json.dumps(vod))
            malformed_permission["downloadEnabled"] = value
            with self.subTest(downloadEnabled=value), self.assertRaises(CatalogError) as caught:
                normalize_peertube_detail(malformed_permission, vod["url"], vod["uuid"])
            self.assertEqual(caught.exception.code, "PEERTUBE_SCHEMA_INVALID")

        for flags in (-1, 1, 8, "0", True):
            malformed_rating = json.loads(json.dumps(vod))
            malformed_rating["nsfwFlags"] = flags
            with self.subTest(nsfwFlags=flags), self.assertRaises(CatalogError) as caught:
                normalize_peertube_detail(malformed_rating, vod["url"], vod["uuid"])
            self.assertEqual(caught.exception.code, "PEERTUBE_RATING_INVALID")

        marked = json.loads(json.dumps(vod))
        marked["nsfw"] = True
        marked["nsfwFlags"] = 3
        self.assertEqual(
            normalize_peertube_detail(marked, vod["url"], vod["uuid"])["content_rating"],
            "explicit",
        )

        for license_id in range(1, 10):
            licensed = json.loads(json.dumps(vod))
            licensed["licence"] = {"id": license_id, "label": f"License {license_id}"}
            normalized = normalize_peertube_detail(licensed, vod["url"], vod["uuid"])
            self.assertEqual(normalized["license_id"], license_id)
            self.assertEqual(
                normalized["license"],
                "All Rights Reserved" if license_id == 9 else f"License {license_id}",
            )
        for license_id in (0, 10, True, "1"):
            malformed_license = json.loads(json.dumps(vod))
            malformed_license["licence"] = {"id": license_id, "label": "Malformed"}
            with self.subTest(license_id=license_id), self.assertRaises(CatalogError) as caught:
                normalize_peertube_detail(malformed_license, vod["url"], vod["uuid"])
            self.assertEqual(caught.exception.code, "PEERTUBE_SCHEMA_INVALID")

        unknown_license = json.loads(json.dumps(vod))
        unknown_license["licence"] = {"id": None, "label": "Unknown"}
        normalized_unknown = normalize_peertube_detail(
            unknown_license, vod["url"], vod["uuid"]
        )
        self.assertIsNone(normalized_unknown["license_id"])
        self.assertEqual(normalized_unknown["license"], "")
        unknown_license["licence"]["label"] = 42
        with self.assertRaises(CatalogError) as caught:
            normalize_peertube_detail(unknown_license, vod["url"], vod["uuid"])
        self.assertEqual(caught.exception.code, "PEERTUBE_SCHEMA_INVALID")

        bounded = json.loads(json.dumps(vod))
        bounded["streamingPlaylists"][0]["files"] = [
            {"fileUrl": f"https://cdn.example.org/static/web-videos/{index}.mp4"}
            for index in range(65)
        ]
        with self.assertRaises(CatalogError) as caught:
            normalize_peertube_detail(bounded, vod["url"], vod["uuid"])
        self.assertEqual(caught.exception.code, "PEERTUBE_SCHEMA_TOO_LARGE")

    def test_peertube_detail_choice_is_deterministic_and_live_never_falls_back_to_mp4(self) -> None:
        vod = json.loads(json.dumps(self.peer["originDetails"]["vod"]))
        vod["streamingPlaylists"] = [
            {"playlistUrl": "https://cdn.example.org/z-master.m3u8", "files": []},
            {"playlistUrl": "https://cdn.example.org/a-master.m3u8", "files": []},
        ]
        vod["files"] = [
            {
                "resolution": {"id": 720, "label": "720p"},
                "size": 100,
                "fileUrl": "https://cdn.example.org/z-play.mp4",
                "fileDownloadUrl": "https://cdn.example.org/z-download.mp4",
            },
            {
                "resolution": {"id": 720, "label": "720p"},
                "size": 100,
                "fileUrl": "https://cdn.example.org/a-play.mp4",
                "fileDownloadUrl": "https://cdn.example.org/a-download.mp4",
            },
        ]
        normalized = normalize_peertube_detail(vod, vod["url"], vod["uuid"])
        self.assertEqual(normalized["playback_url"], "https://cdn.example.org/a-master.m3u8")
        self.assertEqual(normalized["file_choices"][0]["url"], "https://cdn.example.org/a-play.mp4")
        self.assertEqual(normalized["download_url"], "https://cdn.example.org/a-download.mp4")
        self.assertTrue(normalized["download_permission"])

        live = json.loads(json.dumps(self.peer["originDetails"]["live"]))
        live["streamingPlaylists"] = []
        live["files"] = [{
            "resolution": {"id": 1080, "label": "1080p"},
            "size": 1000,
            "fileUrl": "https://live.example.org/stale.mp4",
            "fileDownloadUrl": "https://live.example.org/stale-download.mp4",
        }]
        normalized_live = normalize_peertube_detail(live, live["url"], live["uuid"])
        self.assertEqual(normalized_live["playback_url"], "")
        self.assertFalse(normalized_live["download_enabled"])
        self.assertEqual(normalized_live["download_choices"], [])

    def test_owncast_state_machine_quoted_commas_multiline_and_rating_fail_closed(self) -> None:
        playlist_data = (FIXTURES / "owncast-directory.m3u").read_bytes()
        home_data = (FIXTURES / "owncast-home.json").read_bytes()
        parsed = parse_owncast_playlist(playlist_data)
        comma = next(item for item in parsed if item["instance_url"] == "https://comma.example.org/")
        self.assertEqual(comma["title"], "Fixture Quoted, Comma")
        multiline = next(item for item in parsed if item["instance_url"] == "https://multiline.example.org/")
        self.assertEqual(multiline["name"], "Fixture Multiline Stream")
        normalized = normalize_owncast_snapshot(playlist_data, home_data)
        self.assertEqual(len(normalized["items"]), 5)
        ratings = {item["instance_url"]: item["content_rating"] for item in normalized["items"]}
        self.assertEqual(ratings["https://explicit.example.org/"], "explicit")
        self.assertNotIn("https://unrated.example.org/", ratings)
        broken = json.loads(home_data)
        for section in broken["sections"]:
            for item in section.get("instances", []):
                item["nsfw"] = "false"
        broken["featured"]["nsfw"] = "false"
        with self.assertRaises(CatalogError) as caught:
            parse_owncast_home(json.dumps(broken).encode())
        self.assertEqual(caught.exception.code, "OWNCAST_RATINGS_MISSING")

        commented = b'''#EXTM3U\n#EXTINF:-1 tvg-id="Quoted \\"Name\\"",Commented\n#EXTVLCOPT:http-referrer=https://example.org/\nhttps://comment.example.org/hls/stream.m3u8\n'''
        parsed = parse_owncast_playlist(commented)
        self.assertEqual(parsed[0]["instance_url"], "https://comment.example.org/")
        self.assertEqual(parsed[0]["name"], 'Quoted "Name"')

        private_playlist = b'''#EXTM3U
#EXTINF:-1,Private literal
http://127.0.0.1/hls/stream.m3u8
#EXTINF:-1,Local hostname
http://camera.local/hls/stream.m3u8
#EXTINF:-1,Public host
https://public.example.org/hls/stream.m3u8
'''
        parsed = parse_owncast_playlist(private_playlist)
        self.assertEqual([item["instance_url"] for item in parsed], ["https://public.example.org/"])

        private_home = {
            "sections": [{"instances": [
                {"url": "http://10.0.0.1", "name": "Private", "nsfw": False},
                {
                    "url": "https://public.example.org", "name": "Public", "nsfw": False,
                    "tags": [
                        {"name": "Current object tag", "slug": "current-object-tag"},
                        "Legacy string tag",
                        {"slug": "missing-name"},
                    ],
                },
            ]}],
        }
        ratings = parse_owncast_home(json.dumps(private_home).encode())
        self.assertEqual(list(ratings), ["https://public.example.org/"])
        self.assertEqual(
            ratings["https://public.example.org/"]["tags"],
            ["Current object tag", "Legacy string tag"],
        )


class CacheAndServiceTests(unittest.TestCase):
    def test_cache_is_atomic_bounded_corruption_safe_and_cannot_touch_favorites(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            cache_root = state / "cache"
            favorite = state / "webview2_data" / "Default" / "Local Storage" / "favorite-sentinel"
            favorite.parent.mkdir(parents=True)
            favorite.write_text("worldmedia.favorites.v1", encoding="utf-8")
            clock = FakeClock()
            cache = CatalogCache(cache_root, clock=clock, max_entries=2, max_total_bytes=10_000)
            self.assertIsNotNone(cache.put("feed", "one", {"value": 1}, ttl=10))
            self.assertIsNone(cache.put("feed", "secret", {"url": "https://x.example/a?access_token=secret"}, ttl=10))
            for index, sensitive in enumerate((
                "http://10.0.0.1/private", "192.168.1.20", "Authorization: Bearer hidden",
                "Cookie: session=hidden",
                r"C:\Users\person\private", "http://[::1]/private",
            )):
                self.assertIsNone(cache.put("feed", f"sensitive-{index}", {"value": sensitive}, ttl=10))
            cache.put("feed", "two", {"value": 2}, ttl=10)
            cache.put("feed", "three", {"value": 3}, ttl=10)
            self.assertLessEqual(len(list(cache.root.glob("*.json"))), 2)
            path = cache._path("feed", "three")
            if path.exists():
                payload = json.loads(path.read_text(encoding="utf-8"))
                payload["value"] = {"value": "valid JSON corruption"}
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertIsNone(cache.get("feed", "three"))
            unrelated = cache.root / "do-not-delete.txt"
            unrelated.write_text("keep", encoding="utf-8")
            persisted = b"".join(path.read_bytes() for path in cache.root.glob("*.json"))
            for marker in (
                b"10.0.0.1", b"192.168.1.20", b"Bearer hidden", b"session=hidden",
                b"C:\\\\Users", b"::1",
            ):
                self.assertNotIn(marker, persisted)
            cache.clear()
            self.assertTrue(unrelated.is_file())
            self.assertEqual(favorite.read_text(encoding="utf-8"), "worldmedia.favorites.v1")
            self.assertFalse(list(cache.root.glob("*.tmp")))

    def test_catalog_cache_prunes_in_batches_instead_of_scanning_per_response(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = CatalogCache(Path(directory) / "cache", max_entries=10)
            with mock.patch.object(cache, "_prune_locked", wraps=cache._prune_locked) as prune:
                for index in range(10):
                    self.assertIsNotNone(cache.put("feed", str(index), {"value": index}, ttl=60))
                self.assertEqual(prune.call_count, 0)
                self.assertIsNotNone(cache.put("feed", "overflow", {"value": 11}, ttl=60))
                self.assertEqual(prune.call_count, 1)
                self.assertEqual(len(cache._entry_sizes), 9)

    def test_feed_service_cache_revalidation_stale_fallback_and_no_secret_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            url = "https://feeds.example.test/show.xml"
            good = response(200, (FIXTURES / "podcast-rss.xml").read_bytes(), "application/rss+xml", ETag='"one"')
            not_modified = response(304, b"", "application/rss+xml", ETag='"one"')
            connector = FakeConnector({url: [good, not_modified, CatalogError(502, "CATALOG_DOWN", "down", True)]})
            service = CatalogService(Path(directory) / "cache", connector=connector, clock=clock)
            first = service.resolve_feed({"url": url})
            self.assertEqual(first["cache"]["state"], "updated")
            expected_id = hashlib.sha256(
                f"{url}\nfixture-rss-audio-1".encode("utf-8")
            ).hexdigest()
            self.assertEqual(first["items"][0]["stable_id"], expected_id)
            self.assertEqual(first["feed_identity_url"], url)
            self.assertEqual(first["feed_aliases"], [url])
            second = service.resolve_feed({"url": url})
            self.assertEqual(second["cache"]["state"], "fresh")
            self.assertEqual(len(connector.calls), 1)
            clock.advance(1801)
            third = service.resolve_feed({"url": url})
            self.assertEqual(third["cache"]["state"], "revalidated")
            clock.advance(1801)
            fourth = service.resolve_feed({"url": url})
            self.assertEqual(fourth["cache"]["state"], "stale")
            self.assertEqual(fourth["cache"]["reason"], "CATALOG_DOWN")
            self.assertNotIn("show.xml", "".join(path.name for path in service.cache.root.iterdir()))

    def test_feed_redirect_aliases_share_stable_backend_episode_ids(self) -> None:
        requested = "http://feeds.example.test/show.xml"
        first_final = "https://feeds.example.test/show.xml"
        moved_final = "https://cdn.example.test/show.xml"
        payload = (FIXTURES / "podcast-rss.xml").read_bytes()
        first_response = response(200, payload, "application/rss+xml")
        first_response.final_url = first_final
        moved_response = response(200, payload, "application/rss+xml")
        moved_response.final_url = moved_final
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            connector = FakeConnector({requested: [first_response, moved_response]})
            service = CatalogService(Path(directory) / "cache", connector=connector, clock=clock)
            first = service.resolve_feed({"url": requested})
            expected = hashlib.sha256(
                f"{first_final}\nfixture-rss-audio-1".encode("utf-8")
            ).hexdigest()
            self.assertEqual(first["items"][0]["stable_id"], expected)
            self.assertEqual(first["feed_aliases"], [requested, first_final])
            clock.advance(1801)
            moved = service.resolve_feed({"url": requested})
            self.assertEqual(moved["feed_identity_url"], first_final)
            self.assertEqual(moved["items"][0]["stable_id"], expected)
            self.assertEqual(moved["feed_aliases"], [requested, moved_final, first_final])

        direct = attach_podcast_identities(
            parse_podcast_feed(payload, first_final), first_final, first_final
        )
        self.assertEqual(direct["items"][0]["stable_id"], expected)

        overflow = attach_podcast_identities(
            {
                **parse_podcast_feed(payload, first_final),
                "feed_aliases": [f"https://old-{index}.example.test/feed.xml" for index in range(8)],
            },
            "https://requested.example.test/feed.xml",
            "https://resolved.example.test/feed.xml",
            identity_url="https://identity.example.test/feed.xml",
        )
        self.assertEqual(overflow["feed_aliases"][:3], [
            "https://requested.example.test/feed.xml",
            "https://resolved.example.test/feed.xml",
            "https://identity.example.test/feed.xml",
        ])
        self.assertLessEqual(len(overflow["feed_aliases"]), 8)

    def test_peertube_service_constructs_only_exact_origin_detail_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            detail = json.loads((FIXTURES / "peertube.json").read_text())["originDetails"]["vod"]
            uuid_value = detail["uuid"]
            watch = detail["url"]
            api = f"https://video.example.org/api/v1/videos/{uuid_value}"
            connector = FakeConnector({api: response(200, json.dumps(detail).encode(), "application/json")})
            service = CatalogService(Path(directory) / "cache", connector=connector)
            value = service.resolve_peertube({"watch_url": watch, "uuid": uuid_value})
            self.assertEqual(value["uuid"], uuid_value)
            self.assertEqual(connector.calls[0][0], api)
            for hostile in (
                {"watch_url": "https://video.example.org/videos/watch/not-a-uuid", "uuid": uuid_value},
                {"watch_url": "https://video.example.org/w/22222222-2222-4222-8222-222222222222", "uuid": uuid_value},
                {"watch_url": watch, "uuid": uuid_value, "url": "https://evil.example"},
            ):
                with self.assertRaises(CatalogError):
                    service.resolve_peertube(hostile)
            short_connector = FakeConnector({api: response(200, json.dumps(detail).encode(), "application/json")})
            short_service = CatalogService(Path(directory) / "short-cache", connector=short_connector)
            short = short_service.resolve_peertube({
                "watch_url": "https://video.example.org/w/shortId_123",
                "uuid": uuid_value,
            })
            self.assertEqual(short["uuid"], uuid_value)
            short_detail = dict(detail)
            short_detail["url"] = "https://video.example.org/w/shortId_123"
            self.assertEqual(
                normalize_peertube_detail(
                    short_detail, "https://video.example.org/w/shortId_123", uuid_value
                )["uuid"],
                uuid_value,
            )
            short_detail["url"] = "https://video.example.org/w/different_123"
            with self.assertRaises(CatalogError):
                normalize_peertube_detail(
                    short_detail, "https://video.example.org/w/shortId_123", uuid_value
                )

            redirected = response(200, json.dumps(detail).encode(), "application/json")
            redirected.final_url = "https://evil.example/api/v1/videos/" + uuid_value
            redirect_service = CatalogService(
                Path(directory) / "redirect-cache", connector=FakeConnector({api: redirected})
            )
            with self.assertRaises(CatalogError) as caught:
                redirect_service.resolve_peertube({"watch_url": watch, "uuid": uuid_value})
            self.assertEqual(caught.exception.code, "PEERTUBE_CROSS_ORIGIN_REDIRECT")

    def test_peertube_authoritative_private_refresh_never_uses_stale_public_detail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            public = json.loads((FIXTURES / "peertube.json").read_text())["originDetails"]["vod"]
            private = json.loads(json.dumps(public))
            private["privacy"] = {"id": 3, "label": "Private"}
            uuid_value = public["uuid"]
            watch = public["url"]
            api = f"https://video.example.org/api/v1/videos/{uuid_value}"
            connector = FakeConnector({api: [
                response(200, json.dumps(public).encode(), "application/json"),
                response(200, json.dumps(private).encode(), "application/json"),
            ]})
            service = CatalogService(Path(directory) / "cache", connector=connector, clock=clock)
            first = service.resolve_peertube({"watch_url": watch, "uuid": uuid_value})
            self.assertEqual(first["cache"]["state"], "updated")
            clock.advance(601)
            with self.assertRaises(CatalogError) as caught:
                service.resolve_peertube({"watch_url": watch, "uuid": uuid_value})
            self.assertEqual(caught.exception.code, "PEERTUBE_NOT_PUBLIC")

    def test_owncast_suspicious_empty_uses_last_known_good(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            playlist_url = "https://directory.owncast.online/api/iptv"
            home_url = "https://owncast.directory/api/home"
            connector = FakeConnector({
                playlist_url: [
                    response(200, (FIXTURES / "owncast-directory.m3u").read_bytes(), "application/vnd.apple.mpegurl"),
                    response(200, b"#EXTM3U\n", "application/vnd.apple.mpegurl"),
                    response(200, b"#EXTM3U\n", "application/vnd.apple.mpegurl"),
                ],
                home_url: [
                    response(200, (FIXTURES / "owncast-home.json").read_bytes(), "text/plain"),
                    response(200, (FIXTURES / "owncast-home.json").read_bytes(), "application/json"),
                    response(200, (FIXTURES / "owncast-home.json").read_bytes(), "application/json"),
                ],
            })
            service = CatalogService(Path(directory) / "cache", connector=connector, clock=clock)
            first = service.owncast_snapshot()
            self.assertEqual(first["cache"]["state"], "updated")
            self.assertEqual(len(first["items"]), 5)
            clock.advance(121)
            second = service.owncast_snapshot()
            self.assertEqual(second["cache"]["state"], "stale")
            self.assertEqual(second["cache"]["reason"], "SUSPICIOUS_EMPTY_REFRESH")
            self.assertEqual(len(second["items"]), 5)
            clock.advance(121)
            third = service.owncast_snapshot()
            self.assertEqual(third["cache"]["state"], "updated")
            self.assertEqual(third["items"], [], "a repeated valid empty snapshot is eventually accepted")

    def test_cache_write_failures_return_uncached_catalog_and_asset_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            feed_url = "https://feeds.example.test/uncached.xml"
            connector = FakeConnector({
                feed_url: response(
                    200, (FIXTURES / "podcast-rss.xml").read_bytes(), "application/rss+xml"
                )
            })
            cache = CatalogCache(Path(directory) / "catalog")
            service = CatalogService(Path(directory) / "catalog", connector=connector, cache=cache)
            with mock.patch.object(cache, "_atomic_write", side_effect=OSError("disk full")):
                result = service.resolve_feed({"url": feed_url})
            self.assertEqual(result["cache"]["state"], "uncached")
            self.assertEqual(result["title"], "Fixture RSS Show")

            image_url = "https://images.example.test/uncached.png"
            image_connector = FakeConnector({image_url: response(200, PNG_1X1, "image/png")})
            asset_cache = AssetCache(Path(directory) / "assets")
            registry = AssetRegistry(
                Path(directory) / "assets", connector=image_connector, cache=asset_cache
            )
            registration = registry.register({
                "url": image_url, "source_id": "gpodder", "item_id": "uncached-cover",
            })
            with mock.patch.object(asset_cache, "put", side_effect=OSError("disk full")):
                blob = registry.read(registration.token)
            self.assertEqual(blob.data, PNG_1X1)
            self.assertFalse(list(asset_cache.root.glob("*.bin")))

    def test_unavailable_cache_storage_never_blocks_catalog_or_asset_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch(
            "worldmedia_catalog.Path.mkdir", side_effect=OSError("disk full")
        ):
            cache = CatalogCache(Path(directory) / "catalog")
            self.assertIsNone(cache.get("feed", "one"))
            self.assertIsNone(cache.put("feed", "one", {"value": 1}, ttl=60))
            self.assertEqual(cache.clear(), 0)
            feed_url = "https://feeds.example.test/no-cache.xml"
            service = CatalogService(
                Path(directory) / "catalog",
                connector=FakeConnector({
                    feed_url: response(
                        200,
                        (FIXTURES / "podcast-rss.xml").read_bytes(),
                        "application/rss+xml",
                    )
                }),
                cache=cache,
            )
            self.assertEqual(service.resolve_feed({"url": feed_url})["cache"]["state"], "uncached")

            asset_cache = AssetCache(Path(directory) / "assets")
            self.assertIsNone(asset_cache.get("https://images.example.test/cover.png"))
            with self.assertRaises(OSError):
                asset_cache.put(
                    "https://images.example.test/cover.png", PNG_1X1, "image/png", ttl=60
                )
            self.assertEqual(asset_cache.clear(), 0)
            image_url = "https://images.example.test/no-cache.png"
            registry = AssetRegistry(
                Path(directory) / "assets",
                connector=FakeConnector({image_url: response(200, PNG_1X1, "image/png")}),
                cache=asset_cache,
            )
            registration = registry.register({
                "url": image_url,
                "source_id": "gpodder",
                "item_id": "disk-full-cover",
            })
            self.assertEqual(registry.read(registration.token).data, PNG_1X1)

    def test_cache_clear_epoch_blocks_inflight_repopulation_and_shutdown_waits_boundedly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            url = "https://feeds.example.test/inflight.xml"
            gate = threading.Event()
            fixture_response = response(
                200, (FIXTURES / "podcast-rss.xml").read_bytes(), "application/rss+xml"
            )
            fixture_response.gate = gate
            connector = FakeConnector({url: fixture_response})
            service = CatalogService(Path(directory) / "cache", connector=connector)
            result = []
            errors = []

            def resolve():
                try:
                    result.append(service.resolve_feed({"url": url}))
                except Exception as error:  # captured for deterministic assertion
                    errors.append(error)

            thread = threading.Thread(target=resolve)
            thread.start()
            for _ in range(100):
                if connector.calls:
                    break
                threading.Event().wait(0.005)
            self.assertTrue(connector.calls)
            self.assertEqual(service.clear_cache()["catalog_records_removed"], 0)
            gate.set()
            thread.join(2)
            self.assertFalse(errors)
            self.assertEqual(result[0]["cache"]["state"], "uncached")
            self.assertFalse(list(service.cache.root.glob("*.json")))
            self.assertTrue(service.shutdown(timeout=1))

            image_url = "https://images.example.test/inflight.png"
            image_gate = threading.Event()
            image_response = response(200, PNG_1X1, "image/png")
            image_response.gate = image_gate
            image_connector = FakeConnector({image_url: image_response})
            registry = AssetRegistry(Path(directory) / "asset-cache", connector=image_connector)
            registration = registry.register({
                "url": image_url, "source_id": "gpodder", "item_id": "inflight",
            })
            asset_errors = []

            def read_asset():
                try:
                    registry.read(registration.token)
                except Exception as error:  # cancellation is expected
                    asset_errors.append(error)

            asset_thread = threading.Thread(target=read_asset)
            asset_thread.start()
            for _ in range(100):
                if image_connector.calls:
                    break
                threading.Event().wait(0.005)
            self.assertFalse(registry.shutdown(timeout=0.01))
            image_gate.set()
            asset_thread.join(2)
            self.assertTrue(asset_errors)
            self.assertTrue(registry.shutdown(timeout=1))


class AssetTests(unittest.TestCase):
    def test_mime_magic_dimensions_and_size_are_enforced(self) -> None:
        self.assertEqual(validate_image(PNG_1X1, "image/png"), (1, 1))
        for data, mime, code in (
            (b"<html>not image</html>", "text/html", "ASSET_TYPE_REJECTED"),
            (PNG_1X1, "image/jpeg", "ASSET_MAGIC_MISMATCH"),
            (png_without_image_data(), "image/png", "ASSET_MAGIC_MISMATCH"),
            (png_with_dimensions(9000, 1), "image/png", "ASSET_DIMENSIONS_REJECTED"),
            (b"x" * (MAX_ASSET_BYTES + 1), "image/png", "ASSET_TYPE_REJECTED"),
        ):
            with self.subTest(code=code), self.assertRaises(CatalogError) as caught:
                validate_image(data, mime)
            self.assertEqual(caught.exception.code, code)

    def test_asset_registry_is_opaque_scoped_coalesced_cached_and_shutdown_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            url = "https://images.example.test/cover.png?size=large"
            connector = FakeConnector({url: response(200, PNG_1X1, "image/png")})
            registry = AssetRegistry(Path(directory) / "cache", connector=connector, ttl_seconds=60)
            one = registry.register({"url": url, "source_id": "gpodder", "item_id": "item:one"})
            same = registry.register({"url": url, "source_id": "gpodder", "item_id": "item:one"})
            other = registry.register({"url": url, "source_id": "gpodder", "item_id": "item:two"})
            self.assertEqual(one.token, same.token)
            self.assertNotEqual(one.token, other.token)
            self.assertNotIn("images.example", one.public_data()["relay_url"])
            with self.assertRaises(CatalogError) as mismatch:
                registry.get(one.token, source_id="gpodder", item_id="item:two")
            self.assertEqual(mismatch.exception.code, "ASSET_SCOPE_MISMATCH")
            barrier = threading.Barrier(3)
            values = []

            def read(token):
                barrier.wait()
                values.append(registry.read(token))

            threads = [threading.Thread(target=read, args=(token,)) for token in (one.token, other.token)]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(2)
            self.assertEqual(len(values), 2)
            self.assertEqual(len(connector.calls), 1)
            self.assertNotIn("avif", connector.calls[0][1]["headers"]["Accept"])
            self.assertEqual(values[0].data, PNG_1X1)
            registry.expire(one.token, {"source_id": "gpodder", "item_id": "item:one"})
            with self.assertRaises(CatalogError):
                registry.get(one.token)
            registry.shutdown()
            with self.assertRaises(CatalogError):
                registry.register({"url": url, "source_id": "gpodder", "item_id": "item:three"})

    def test_asset_registry_uses_expiry_heap_for_large_thumbnail_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            registry = AssetRegistry(
                Path(directory) / "cache",
                connector=FakeConnector({}),
                clock=clock,
                ttl_seconds=60,
            )
            for index in range(5_000):
                registry.register({
                    "url": f"https://images.example.test/{index}.png",
                    "source_id": "nasa",
                    "item_id": f"item:{index}",
                })
            self.assertEqual(len(registry._entries), 5_000)
            self.assertEqual(len(registry._expiry_heap), 5_000)

            clock.advance(61)
            current = registry.register({
                "url": "https://images.example.test/current.png",
                "source_id": "nasa",
                "item_id": "item:current",
            })
            self.assertEqual(len(registry._entries), 1)
            self.assertEqual(len(registry._expiry_heap), 1)
            self.assertEqual(registry.get(current.token).item_id, "item:current")
            registry.clear_registrations()
            self.assertEqual(registry._expiry_heap, [])

    def test_asset_cache_corruption_lru_clear_and_sibling_sentinel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            sentinel = state / "webview2_data" / "favorite-sentinel"
            sentinel.parent.mkdir(parents=True)
            sentinel.write_text("58 favorites", encoding="utf-8")
            asset_root = state / "cache" / "assets-v1"
            asset_root.mkdir(parents=True)
            orphan = asset_root / ("a" * 64 + ".bin")
            orphan.write_bytes(PNG_1X1)
            startup_unrelated = asset_root / "startup-do-not-delete.txt"
            startup_unrelated.write_text("keep", encoding="utf-8")
            cache = AssetCache(state / "cache", max_entries=1)
            self.assertFalse(orphan.exists())
            self.assertTrue(startup_unrelated.exists())
            first = cache.put("https://img.example/one.png", PNG_1X1, "image/png", ttl=60)
            self.assertEqual(first.width, 1)
            meta, binary = cache._paths("https://img.example/one.png")
            binary.write_bytes(b"corrupt")
            self.assertIsNone(cache.get("https://img.example/one.png"))
            cache.put("https://img.example/two.png", PNG_1X1, "image/png", ttl=60)
            unrelated = cache.root / "do-not-delete.txt"
            unrelated.write_text("keep", encoding="utf-8")
            cache.clear()
            self.assertTrue(unrelated.exists())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "58 favorites")

    def test_asset_cache_prunes_in_batches_instead_of_scanning_per_thumbnail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = AssetCache(Path(directory) / "cache", max_entries=10)
            with mock.patch.object(cache, "_prune_locked", wraps=cache._prune_locked) as prune:
                for index in range(10):
                    cache.put(
                        f"https://images.example.test/{index}.png",
                        PNG_1X1,
                        "image/png",
                        ttl=60,
                    )
                self.assertEqual(prune.call_count, 0)
                cache.put(
                    "https://images.example.test/overflow.png",
                    PNG_1X1,
                    "image/png",
                    ttl=60,
                )
                self.assertEqual(prune.call_count, 1)
                self.assertEqual(len(cache._entry_sizes), 9)


class SocketBoundaryTests(unittest.TestCase):
    def test_real_socket_gateway_valid_and_hostile_paths(self) -> None:
        with CatalogFixtureServer() as fixture, tempfile.TemporaryDirectory() as directory:
            def resolver(host: str, port: int):
                address = "10.0.0.1" if host == "10.0.0.1" else "127.0.0.1"
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

            connector = SafeConnector(
                resolver=resolver,
                address_policy=lambda address: address == "127.0.0.1",
                connect_timeout=2,
                header_timeout=2,
                idle_timeout=2,
            )
            service = CatalogService(Path(directory) / "cache", connector=connector)
            feed = service.resolve_feed({"url": fixture.base_url + "/feed.xml"})
            self.assertEqual(feed["title"], "Fixture RSS Show")
            self.assertEqual(feed["cache"]["state"], "updated")

            clock = FakeClock()
            redirect_service = CatalogService(Path(directory) / "redirect-cache", connector=connector, clock=clock)
            redirect_url = fixture.base_url + "/redirect-cross"
            self.assertEqual(redirect_service.resolve_feed({"url": redirect_url})["cache"]["state"], "updated")
            clock.advance(1801)
            self.assertEqual(redirect_service.resolve_feed({"url": redirect_url})["cache"]["state"], "updated")
            mirror_calls = [call for call in fixture.calls if call["host"].startswith("mirror-fixture.test:")]
            self.assertEqual(len(mirror_calls), 2)
            self.assertNotIn("If-None-Match", mirror_calls[-1]["headers"])

            gzip_feed = service.resolve_feed({"url": fixture.base_url + "/gzip.xml"})
            self.assertEqual(gzip_feed["title"], "Fixture Atom Show")
            for path, code in (
                ("/malicious.xml", "FEED_XML_UNSAFE"),
                ("/wrong-type", "CATALOG_CONTENT_TYPE"),
                ("/gzip-bomb.xml", "CATALOG_DECODED_TOO_LARGE"),
                ("/redirect-private", "NON_GLOBAL_MEDIA_TARGET"),
            ):
                with self.subTest(path=path), self.assertRaises(ApiError) as caught:
                    service.resolve_feed({"url": fixture.base_url + path})
                self.assertEqual(caught.exception.code, code)

            video_uuid = "11111111-1111-4111-8111-111111111111"
            watch = f"http://video.example.test:{fixture.port}/videos/watch/{video_uuid}"
            peer = service.resolve_peertube({"watch_url": watch, "uuid": video_uuid})
            self.assertEqual(peer["uuid"], video_uuid)

            playlist_url = f"http://directory.owncast.online:{fixture.port}/api/iptv"
            home_url = f"http://owncast.directory:{fixture.port}/api/home"
            with mock.patch("worldmedia_catalog.OWNCAST_PLAYLIST_URL", playlist_url), mock.patch(
                "worldmedia_catalog.OWNCAST_HOME_URL", home_url
            ):
                owncast = service.owncast_snapshot()
            self.assertEqual(len(owncast["items"]), 5)

            assets = AssetRegistry(Path(directory) / "cache", connector=connector)
            asset = assets.register({
                "url": f"http://images.example.test:{fixture.port}/cover.png",
                "source_id": "gpodder",
                "item_id": "fixture:cover",
            })
            self.assertEqual(assets.read(asset.token).data, PNG_1X1)
            for path in ("/svg", "/html-as-png"):
                registration = assets.register({
                    "url": f"http://images.example.test:{fixture.port}{path}",
                    "source_id": "gpodder",
                    "item_id": f"fixture:{path}",
                })
                with self.assertRaises(CatalogError):
                    assets.read(registration.token)

            requested_paths = {call["path"] for call in fixture.calls}
            self.assertTrue({
                "/feed.xml", "/gzip.xml", "/malicious.xml", "/wrong-type",
                "/gzip-bomb.xml", "/redirect-private", "/api/iptv", "/api/home",
                "/cover.png", "/svg", "/html-as-png",
            }.issubset(requested_paths))


if __name__ == "__main__":
    unittest.main()
