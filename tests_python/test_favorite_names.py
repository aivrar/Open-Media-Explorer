"""The user's own names for favorites: kept in the newer profile file, carried
by the backup, and used for the favorites exports."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worldmedia_backup import build_favorite_exports, create_backup, favorite_names
from worldmedia_playlists import PlaylistStore, parse_playlist
from worldmedia_runtime import (
    LEGACY_PROFILE_TRANSFER_KEYS,
    PROFILE_TRANSFER_EXTRA_FILENAME,
    PROFILE_TRANSFER_KEYS,
    RuntimePaths,
    load_profile_transfer,
    profile_transfer_extra_path,
    profile_transfer_path,
    save_profile_transfer,
)

NAMES_KEY = "worldmedia.favnames.v1"
DATA = "WorldMediaWindows-data/state/"


def names_value(names: dict[str, str]) -> str:
    return json.dumps({"version": 1, "names": names})


class FavoriteNamesTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.paths = RuntimePaths(
            portable_root=root, state_root=root / "WorldMediaWindows-data",
            downloads_root=root / "downloads", tools_root=root / "tools" / "ffmpeg",
        )
        self.state = self.paths.state_root / "state"
        self.state.mkdir(parents=True)
        self.store = PlaylistStore(self.state / "playlists.json")
        self.favorites = [
            {"id": "rb:one", "title": "One FM", "source": "radio-browser", "type": "radio",
             "stream_url": "https://radio.example.org/one.mp3", "thumbnail": ""},
            {"id": "rb:two", "title": "Two FM", "source": "radio-browser", "type": "radio",
             "stream_url": "https://radio.example.org/two.mp3", "thumbnail": ""},
        ]

    def test_the_key_goes_in_the_newer_file_never_the_one_older_releases_read(self) -> None:
        self.assertIn(NAMES_KEY, PROFILE_TRANSFER_KEYS)
        self.assertNotIn(NAMES_KEY, LEGACY_PROFILE_TRANSFER_KEYS)
        values = {
            "worldmedia.favorites.v1": json.dumps(self.favorites),
            NAMES_KEY: names_value({"rb:one": "Morning radio"}),
        }
        self.assertEqual(save_profile_transfer(values, self.paths), values)
        main = json.loads(profile_transfer_path(self.paths).read_text(encoding="utf-8"))
        self.assertNotIn(NAMES_KEY, main["values"])
        extra = json.loads(profile_transfer_extra_path(self.paths).read_text(encoding="utf-8"))
        self.assertEqual(extra["values"], {NAMES_KEY: values[NAMES_KEY]})
        self.assertEqual(load_profile_transfer(self.paths), values)

    def test_names_are_read_safely(self) -> None:
        self.assertEqual(favorite_names({NAMES_KEY: names_value({"rb:one": "Mine", "rb:two": "  ", "rb:x": 5})}),
                         {"rb:one": "Mine"})
        for raw in ("not json", "[]", '{"version":2,"names":{}}', '{"version":1,"names":[]}', '{"version":1}'):
            with self.subTest(raw=raw):
                self.assertEqual(favorite_names({NAMES_KEY: raw}), {})
        self.assertEqual(favorite_names({}), {})

    def test_a_renamed_favorite_is_exported_under_its_new_name(self) -> None:
        files, written, skipped = build_favorite_exports(
            self.favorites, {}, {"rb:one": "Morning \"radio\"\r\n#EXTINF:-1,x", "rb:gone": "Gone"})
        self.assertEqual((written, skipped), (2, 0))
        radio = files["favorites-radio.m3u8"]
        # Cleaned through the same writer: one line.
        self.assertIn('group-title="Radio Browser",Morning "radio" #EXTINF:-1,x\n', radio)
        self.assertIn('group-title="Radio Browser",Two FM\n', radio)
        self.assertEqual(len(parse_playlist(radio, "radio")["items"]), 2)
        # A name that cleans to nothing keeps the station's own name.
        files, _, _ = build_favorite_exports(self.favorites[:1], {}, {"rb:one": "\u202E\r\n"})
        self.assertIn(",One FM\n", files["favorites-radio.m3u8"])

    def test_the_backup_carries_the_names_and_uses_them(self) -> None:
        values = {
            "worldmedia.favorites.v1": json.dumps(self.favorites),
            NAMES_KEY: names_value({"rb:two": "Evening jazz"}),
        }
        save_profile_transfer(values, self.paths)
        result = create_backup(self.paths, self.store, now=datetime(2026, 11, 19, 10, 0, 0))
        with zipfile.ZipFile(result["path"]) as archive:
            extra = json.loads(archive.read(DATA + PROFILE_TRANSFER_EXTRA_FILENAME))
            self.assertEqual(extra["values"][NAMES_KEY], values[NAMES_KEY])
            radio = archive.read("exports/favorites-radio.m3u8").decode("utf-8")
            self.assertIn(",Evening jazz\n", radio)
            self.assertIn(",One FM\n", radio)
            readme = archive.read("README.txt").decode("utf-8")
            self.assertIn("categories and the names you gave favorites", readme)


if __name__ == "__main__":
    unittest.main()
