import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from worldmedia_computer import ComputerFolders
from worldmedia_computer_stars import ComputerStars
from worldmedia_runtime import _atomic_write_json
from worldmedia_security import ApiError


class ComputerStarsTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.folders = ComputerFolders(self.root / "computer-folders.json")
        self.path = self.root / "computer-stars.json"
        self.now = 123_456_000_000
        self.store = ComputerStars(self.path, clock=lambda: self.now)
        self.ids = [f"{value:024x}" for value in (10, 11, 12, 13)]

    def test_order_snapshot_validation_and_persistent_counter(self):
        a, b, c, d = self.ids
        self.assertEqual(self.store.snapshot(), {"stars": [], "count": 0})
        self.assertFalse(self.path.exists())
        with mock.patch("worldmedia_computer_stars._atomic_write_json", wraps=_atomic_write_json) as save:
            result = self.store.update({"add": [
                {"id": a.upper(), "snap": {"title": "x" * 350, "artist": ["discard"], "size": 99,
                                           "duration": 1.5, "album": True, "format": float("inf"), "ext": "wav"}},
                {"id": b, "snap": {"kind": "audio"}}, {"id": c, "snap": {}},
            ]})
            save.assert_called_once()
        self.assertEqual(result, {"added": [
            {"id": a, "t": 123456, "seq": 3}, {"id": b, "t": 123456, "seq": 2},
            {"id": c, "t": 123456, "seq": 1},
        ], "removed": [], "count": 3})
        self.assertEqual(self.store.snapshot()["stars"][0]["snap"], {"title": "x" * 300, "duration": 1.5, "ext": "wav"})

        self.now += 1_000_000
        updated = self.store.update({"add": [{"id": b, "snap": {"title": "New"}}], "remove": [a, d]})
        self.assertEqual(updated, {"added": [{"id": b, "t": 123456, "seq": 2}], "removed": [a], "count": 2})
        reloaded = ComputerStars(self.path)
        self.assertEqual(reloaded.snapshot(), self.store.snapshot())
        reloaded.update({"remove": [b, c]})
        reloaded = ComputerStars(self.path)
        self.assertEqual(reloaded.update({"add": [{"id": a, "snap": {}}]})["added"][0]["seq"], 4)

    def test_damaged_store_is_preserved_once(self):
        bad = b'{"version":1,"stars":[43]}'
        self.path.write_bytes(bad)
        self.assertEqual(self.store.snapshot(), {"stars": [], "count": 0})
        self.store.update({"add": [{"id": self.ids[0], "snap": {}}]})
        [backup] = self.root.glob("computer-stars-unreadable-*.json")
        self.assertEqual(backup.read_bytes(), bad)
        self.assertEqual(ComputerStars(self.path).snapshot()["count"], 1)

    def test_limits_and_failed_save_leave_previous_snapshot_intact(self):
        a, b, *_ = self.ids
        self.store.update({"add": [{"id": a, "snap": {}}]})
        before = self.store.snapshot()
        with mock.patch("worldmedia_computer_stars._MAX_STARS", 1):
            with self.assertRaisesRegex(ApiError, "Too many starred files."):
                self.store.update({"add": [{"id": b, "snap": {}}]})
        for body in ({"remove": [a] * 2001}, {"remove": "bad"}, {"remove": ["g" * 24]},
                     {"add": [{"id": b, "snap": None}]}):
            with self.subTest(body=str(body)[:50]), self.assertRaises(ApiError):
                self.store.update(body)
        with mock.patch("worldmedia_computer_stars._atomic_write_json", side_effect=OSError):
            with self.assertRaises(OSError):
                self.store.update({"remove": [a]})
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(len(json.loads(self.path.read_bytes())["stars"]), 1)

    def test_stars_survive_file_and_folder_removal(self):
        media = self.root / "Music"
        media.mkdir()
        folder = self.folders.add(str(media))
        track = media / "Song.mp3"
        track.touch()
        self.folders.stars.update({"add": [{"id": self.ids[0], "snap": {"title": "Song"}}]})
        track.unlink()
        self.folders.remove(folder["id"])
        self.folders.library.remove_folder(folder["id"])
        self.assertEqual(self.folders.stars.snapshot()["count"], 1)
