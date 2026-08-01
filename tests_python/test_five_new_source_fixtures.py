from __future__ import annotations

import hashlib
import json
import re
import unittest
import xml.etree.ElementTree as etree
from pathlib import Path


FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "five-new-sources"


class FiveNewSourceFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
        cls.entries = {entry["file"]: entry for entry in cls.manifest["files"]}

    def test_manifest_is_complete_and_hashes_exact_capture_bytes(self) -> None:
        actual = {path.name for path in FIXTURES.iterdir() if path.is_file() and path.name != "manifest.json"}
        self.assertEqual(set(self.entries), actual)
        self.assertEqual(len(self.entries), len(self.manifest["files"]))
        for name, entry in self.entries.items():
            with self.subTest(name=name):
                payload = (FIXTURES / name).read_bytes()
                self.assertNotIn(b"\r", payload)
                self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"])
                self.assertRegex(entry["contentType"], r"^[\w.+-]+/[\w.+-]+$")
                self.assertTrue(entry["endpoint"])
                self.assertIn("status", entry)

    def test_json_and_benign_xml_parse_as_declared_media_types(self) -> None:
        for entry in self.manifest["files"]:
            path = FIXTURES / entry["file"]
            content_type = entry["contentType"]
            with self.subTest(file=path.name, content_type=content_type):
                if content_type == "application/json":
                    self.assertIsNotNone(json.loads(path.read_text(encoding="utf-8")))
                elif content_type in {"application/rss+xml", "application/atom+xml"} and not entry.get("allowSecurityMarkers"):
                    if path.name == "podcast-malformed.xml":
                        with self.assertRaises(etree.ParseError):
                            etree.fromstring(path.read_bytes())
                    else:
                        root = etree.fromstring(path.read_bytes())
                        self.assertIn(root.tag.rsplit("}", 1)[-1], {"rss", "feed"})
                elif content_type == "text/html":
                    text = path.read_text(encoding="utf-8")
                    self.assertRegex(text.lower(), r"<!doctype html>|<html")
                elif content_type == "application/vnd.apple.mpegurl":
                    self.assertTrue(path.read_text(encoding="utf-8").startswith("#EXTM3U\n"))

    def test_malicious_xml_is_declared_and_never_treated_as_benign(self) -> None:
        entry = self.entries["podcast-malicious.xml"]
        self.assertTrue(entry["allowSecurityMarkers"])
        payload = (FIXTURES / entry["file"]).read_text(encoding="utf-8")
        self.assertIn("<!DOCTYPE", payload)
        self.assertIn("<!ENTITY", payload)
        self.assertIn("SYSTEM", payload)
        self.assertIn("http://127.0.0.1/", payload)
        for name in ["podcast-rss.xml", "podcast-atom.xml", "podcast-live.xml", "podcast-explicit.xml"]:
            safe_payload = (FIXTURES / name).read_text(encoding="utf-8")
            self.assertNotIn("<!DOCTYPE", safe_payload)
            self.assertNotIn("<!ENTITY", safe_payload)

    def test_owncast_capture_contains_state_machine_edge_cases_and_rating_join(self) -> None:
        playlist = (FIXTURES / "owncast-directory.m3u").read_text(encoding="utf-8")
        home = json.loads((FIXTURES / "owncast-home.json").read_text(encoding="utf-8"))
        instances = [item for section in home["sections"] for item in section.get("instances", [])]

        self.assertIn('tvg-ID="Fixture Quoted, Comma"', playlist)
        self.assertIn('tvg-ID="Fixture\nMultiline Stream"', playlist)
        self.assertIn("http://http-stream.example.org:8080/hls/stream.m3u8", playlist)
        self.assertIn("ftp://malformed.example.org/stream.m3u8", playlist)
        self.assertTrue(playlist.rstrip().endswith("Fixture Missing URI"))
        self.assertTrue(any(item.get("nsfw") is True for item in instances))
        self.assertTrue(any(item.get("nsfw") is False for item in instances))
        self.assertTrue(any("nsfw" not in item for item in instances))
        self.assertTrue(any(type(item.get("nsfw")) is str for item in instances))

        playlist_origins = set(re.findall(r"^https?://([^/]+)", playlist, flags=re.MULTILINE))
        verified_origins = {
            re.sub(r"^https?://", "", item["url"]).rstrip("/")
            for item in instances
            if isinstance(item.get("url"), str) and type(item.get("nsfw")) is bool
        }
        self.assertIn("safe.example.org", playlist_origins & verified_origins)
        self.assertIn("explicit.example.org", playlist_origins & verified_origins)
        self.assertNotIn("unrated.example.org", verified_origins)
        self.assertNotIn("malformed.example.org", verified_origins)

    def test_fixture_text_has_no_credentials_or_personal_paths(self) -> None:
        forbidden = [
            re.compile(r"\bauthorization\s*:", re.I),
            re.compile(r"\bset-cookie\s*:", re.I),
            re.compile(r'["\'](?:api[_-]?key|access[_-]?token|password|client[_-]?secret)["\']\s*:', re.I),
            re.compile(r"[a-z]:[\\/]users[\\/]", re.I),
            re.compile(r"[\\/]appdata[\\/]", re.I),
        ]
        for name in self.entries:
            text = (FIXTURES / name).read_text(encoding="utf-8")
            with self.subTest(name=name):
                for pattern in forbidden:
                    self.assertIsNone(pattern.search(text))


if __name__ == "__main__":
    unittest.main()
