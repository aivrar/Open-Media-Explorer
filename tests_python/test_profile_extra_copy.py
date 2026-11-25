"""The second copy of the profile keys that releases 0.1.9 to 0.1.11 drop.

Those releases open profile-preferences-extra.json but rewrite it with only the
keys they know (and remove it when none are left), so the names given to
favorites and the stations kept on their own stream would be lost when such a
release runs in between. profile-preferences-extra-copy.json keeps a second
copy that no older release opens.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import worldmedia_backup
import worldmedia_runtime
from worldmedia_backup import BackupError, create_backup
from worldmedia_playlists import PlaylistStore
from worldmedia_runtime import (
    LEGACY_PROFILE_TRANSFER_KEYS,
    PROFILE_TRANSFER_COPY_FILENAME,
    PROFILE_TRANSFER_COPY_KEYS,
    PROFILE_TRANSFER_EXTRA_FILENAME,
    PROFILE_TRANSFER_FILENAME,
    PROFILE_TRANSFER_KEYS,
    RuntimePaths,
    load_profile_transfer,
    load_profile_transfer_report,
    profile_transfer_copy_path,
    profile_transfer_extra_path,
    profile_transfer_path,
    save_profile_transfer,
)

FAVORITES_KEY = "worldmedia.favorites.v1"
SETTINGS_KEY = "worldmedia.settings.v1"
GROUPS_KEY = "worldmedia.favgroups.v1"
NAMES_KEY = "worldmedia.favnames.v1"
OWN_STREAM_KEY = "worldmedia.ownstream.v1"
DATA = "WorldMediaWindows-data/state/"
# The keys release 0.1.11 knows: the five legacy keys and the categories.
V0111_KEYS = set(LEGACY_PROFILE_TRANSFER_KEYS) | {GROUPS_KEY}


def names_value(names: dict[str, str]) -> str:
    return json.dumps({"version": 1, "names": names})


def v0111_save(values: dict[str, str], paths: RuntimePaths) -> None:
    """How release 0.1.11 writes the profile files: the page only sends keys
    it knows, the main file gets the legacy keys, the extra file the
    categories, and the extra file is removed when there are none."""

    known = {key: entry for key, entry in values.items() if key in V0111_KEYS}
    main = profile_transfer_path(paths)
    main.parent.mkdir(parents=True, exist_ok=True)
    legacy = {key: entry for key, entry in known.items() if key in LEGACY_PROFILE_TRANSFER_KEYS}
    main.write_text(json.dumps({"version": 1, "values": legacy}), encoding="utf-8")
    newer = {key: entry for key, entry in known.items() if key not in LEGACY_PROFILE_TRANSFER_KEYS}
    extra = profile_transfer_extra_path(paths)
    if newer:
        extra.write_text(json.dumps({"version": 1, "values": newer}), encoding="utf-8")
    else:
        extra.unlink(missing_ok=True)


class ProfileExtraCopyTests(unittest.TestCase):
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
        self.favorites = json.dumps([
            {"id": "rb:one", "title": "One FM", "source": "radio-browser", "type": "radio",
             "stream_url": "https://radio.example.org/one.mp3", "thumbnail": ""},
        ])
        self.values = {
            FAVORITES_KEY: self.favorites,
            SETTINGS_KEY: '{"theme":"forest"}',
            GROUPS_KEY: json.dumps({"version": 1, "groups": [{"id": "g1", "name": "Rock"}], "assign": {}}),
            NAMES_KEY: names_value({"rb:one": "Morning radio"}),
            OWN_STREAM_KEY: '{"version":1,"ids":["rb:one"]}',
        }

    def read_json(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_the_copy_holds_only_the_keys_older_releases_drop_in_a_file_of_its_own(self) -> None:
        self.assertEqual(set(PROFILE_TRANSFER_COPY_KEYS), {NAMES_KEY, OWN_STREAM_KEY})
        self.assertTrue(PROFILE_TRANSFER_COPY_KEYS <= PROFILE_TRANSFER_KEYS)
        self.assertFalse(PROFILE_TRANSFER_COPY_KEYS & V0111_KEYS)
        self.assertNotIn(PROFILE_TRANSFER_COPY_FILENAME, {PROFILE_TRANSFER_FILENAME, PROFILE_TRANSFER_EXTRA_FILENAME})
        self.assertEqual(profile_transfer_copy_path(self.paths),
                         profile_transfer_path(self.paths).with_name(PROFILE_TRANSFER_COPY_FILENAME))

    def test_appearance_settings_round_trip_inside_the_legacy_settings_value(self) -> None:
        settings = json.dumps({
            "theme": "forest",
            "nowPlayingBackgroundBlur": "off",
            "tabsShown": {"library": True, "tuner": False},
        })
        values = {**self.values, SETTINGS_KEY: settings}
        old_keys = ("worldmedia.now-playing-background-blur.v1", "worldmedia.tabs-shown.v1")
        for key in old_keys:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "unsupported key"):
                save_profile_transfer({**values, key: "off"}, self.paths)

        self.assertEqual(save_profile_transfer(values, self.paths), values)
        self.assertEqual(self.read_json(profile_transfer_path(self.paths))["values"], {
            FAVORITES_KEY: self.favorites, SETTINGS_KEY: settings,
        })
        extra = profile_transfer_extra_path(self.paths)
        self.assertTrue(set(old_keys).isdisjoint(self.read_json(extra)["values"]))
        extra.unlink()
        self.assertEqual(load_profile_transfer(self.paths)[SETTINGS_KEY], settings)

    def test_a_normal_write_fills_all_three_files_and_reads_back_unchanged(self) -> None:
        self.assertEqual(save_profile_transfer(self.values, self.paths), self.values)
        main = self.read_json(profile_transfer_path(self.paths))
        extra = self.read_json(profile_transfer_extra_path(self.paths))
        copy = self.read_json(profile_transfer_copy_path(self.paths))
        self.assertEqual(set(main["values"]), {FAVORITES_KEY, SETTINGS_KEY})
        self.assertEqual(set(extra["values"]), {GROUPS_KEY, NAMES_KEY, OWN_STREAM_KEY})
        self.assertEqual(copy, {"version": 1, "values": {
            NAMES_KEY: self.values[NAMES_KEY], OWN_STREAM_KEY: self.values[OWN_STREAM_KEY],
        }})
        self.assertEqual(load_profile_transfer(self.paths), self.values)
        # Without names or own-stream choices there is no copy.
        save_profile_transfer({FAVORITES_KEY: self.favorites, GROUPS_KEY: self.values[GROUPS_KEY]}, self.paths)
        self.assertFalse(profile_transfer_copy_path(self.paths).exists())
        self.assertTrue(profile_transfer_extra_path(self.paths).exists())

    def test_the_copy_is_written_before_the_extra_file(self) -> None:
        written = []
        original = worldmedia_runtime._atomic_write_json

        def record(path, value):
            written.append(path.name)
            return original(path, value)

        with mock.patch.object(worldmedia_runtime, "_atomic_write_json", record):
            save_profile_transfer(self.values, self.paths)
        self.assertEqual(written, [PROFILE_TRANSFER_FILENAME, PROFILE_TRANSFER_COPY_FILENAME,
                                   PROFILE_TRANSFER_EXTRA_FILENAME])

    def test_names_come_back_after_an_older_release_rewrote_the_extra_file(self) -> None:
        save_profile_transfer(self.values, self.paths)
        # 0.1.11 runs and saves: a new favorite and a changed category list.
        later = dict(self.values)
        later[FAVORITES_KEY] = json.dumps([{"id": "rb:one"}, {"id": "rb:two"}])
        later[GROUPS_KEY] = json.dumps({"version": 1, "groups": [], "assign": {}})
        v0111_save(later, self.paths)
        self.assertEqual(set(self.read_json(profile_transfer_extra_path(self.paths))["values"]), {GROUPS_KEY})
        # Back on 0.1.12 on another port: the hand-off has everything.
        self.assertEqual(load_profile_transfer(self.paths), later)

    def test_names_come_back_when_the_older_release_removed_the_extra_file(self) -> None:
        values = {key: entry for key, entry in self.values.items() if key != GROUPS_KEY}
        save_profile_transfer(values, self.paths)
        v0111_save(values, self.paths)
        self.assertFalse(profile_transfer_extra_path(self.paths).exists())
        self.assertEqual(load_profile_transfer(self.paths), values)

    def test_the_extra_file_wins_over_the_copy_for_keys_it_has(self) -> None:
        save_profile_transfer(self.values, self.paths)
        copy = profile_transfer_copy_path(self.paths)
        copy.write_text(json.dumps({"version": 1, "values": {NAMES_KEY: names_value({"rb:one": "Old"})}}),
                        encoding="utf-8")
        self.assertEqual(load_profile_transfer(self.paths)[NAMES_KEY], self.values[NAMES_KEY])

    def test_clear_cache_is_not_undone_by_the_copy(self) -> None:
        save_profile_transfer(self.values, self.paths)
        self.assertEqual(save_profile_transfer({}, self.paths), {})
        self.assertFalse(profile_transfer_copy_path(self.paths).exists())
        self.assertEqual(load_profile_transfer(self.paths), {})
        # Clear cache, then an older release saves a new profile: no old names.
        fresh = {FAVORITES_KEY: self.favorites}
        v0111_save(fresh, self.paths)
        self.assertEqual(load_profile_transfer(self.paths), fresh)

    def test_a_name_removed_or_changed_here_does_not_come_back_from_the_copy(self) -> None:
        save_profile_transfer(self.values, self.paths)
        # The last name is removed (the page then sends no names key).
        without_names = {key: entry for key, entry in self.values.items() if key != NAMES_KEY}
        save_profile_transfer(without_names, self.paths)
        v0111_save(without_names, self.paths)
        loaded = load_profile_transfer(self.paths)
        self.assertNotIn(NAMES_KEY, loaded)
        self.assertEqual(loaded[OWN_STREAM_KEY], self.values[OWN_STREAM_KEY])
        # A name changed here is the one that comes back.
        changed = dict(self.values, **{NAMES_KEY: names_value({"rb:one": "Evening radio"})})
        save_profile_transfer(changed, self.paths)
        v0111_save(changed, self.paths)
        self.assertEqual(load_profile_transfer(self.paths)[NAMES_KEY], changed[NAMES_KEY])

    def test_an_older_release_clearing_its_profile_does_not_bring_names_back(self) -> None:
        save_profile_transfer(self.values, self.paths)
        v0111_save({}, self.paths)  # Clear cache in the older release.
        self.assertEqual(load_profile_transfer(self.paths), {})

    def test_a_damaged_copy_is_ignored_without_costing_anything_else(self) -> None:
        save_profile_transfer(self.values, self.paths)
        v0111_save(self.values, self.paths)
        copy = profile_transfer_copy_path(self.paths)
        expected = {key: entry for key, entry in self.values.items() if key not in PROFILE_TRANSFER_COPY_KEYS}
        for broken in ("{not json", "", "[]", '{"version":2,"values":{}}', '{"version":1,"values":[]}',
                       '{"version":1,"values":{"worldmedia.favnames.v1":5}}', '{"version":1}'):
            with self.subTest(broken=broken):
                copy.write_text(broken, encoding="utf-8")
                self.assertEqual(load_profile_transfer(self.paths), expected)
        copy.write_bytes(b"\xff\xfe\x00{")
        self.assertEqual(load_profile_transfer(self.paths), expected)
        # The copy can never replace favorites, settings or categories.
        copy.write_text(json.dumps({"version": 1, "values": {
            FAVORITES_KEY: "[]", GROUPS_KEY: "{}", NAMES_KEY: self.values[NAMES_KEY],
        }}), encoding="utf-8")
        loaded = load_profile_transfer(self.paths)
        self.assertEqual(loaded[FAVORITES_KEY], self.favorites)
        self.assertEqual(loaded[GROUPS_KEY], self.values[GROUPS_KEY])
        self.assertEqual(loaded[NAMES_KEY], self.values[NAMES_KEY])

    def test_the_hand_off_reports_which_keys_came_from_the_copy(self) -> None:
        save_profile_transfer(self.values, self.paths)
        self.assertEqual(load_profile_transfer_report(self.paths), (self.values, []))
        v0111_save(self.values, self.paths)
        values, copied = load_profile_transfer_report(self.paths)
        self.assertEqual(values, self.values)
        self.assertEqual(copied, [NAMES_KEY, OWN_STREAM_KEY])
        # A key in the extra file is never reported as copied.
        extra = profile_transfer_extra_path(self.paths)
        extra.write_text(json.dumps({"version": 1, "values": {NAMES_KEY: self.values[NAMES_KEY]}}), encoding="utf-8")
        self.assertEqual(load_profile_transfer_report(self.paths)[1], [OWN_STREAM_KEY])

    def test_names_survive_an_older_release_that_moved_the_port_itself(self) -> None:
        # 0.1.12 on port A, then 0.1.11, which saves and moves to port B: the
        # browser storage of B gets favorites and settings from the files.
        save_profile_transfer(self.values, self.paths)
        v0111_save(self.values, self.paths)
        origin_b = {key: entry for key, entry in load_profile_transfer(self.paths).items() if key in V0111_KEYS}
        # 0.1.12 then starts on B. B has a profile, so the page takes only the
        # keys the report names as copied, and only those B lacks.
        values, copied = load_profile_transfer_report(self.paths)
        for key in copied:
            origin_b.setdefault(key, values[key])
        # Its first save keeps the names and the copy.
        save_profile_transfer(origin_b, self.paths)
        self.assertTrue(profile_transfer_copy_path(self.paths).exists())
        self.assertEqual(load_profile_transfer(self.paths), self.values)

    def test_names_cleared_by_an_older_release_stay_cleared_after_its_next_save(self) -> None:
        save_profile_transfer(self.values, self.paths)
        v0111_save({}, self.paths)  # Clear cache in the older release.
        v0111_save({"worldmedia.volume.v1": "0.5"}, self.paths)  # Then it saves a volume change.
        values, copied = load_profile_transfer_report(self.paths)
        self.assertNotIn(NAMES_KEY, values)
        # Own-stream choices are kept: they are for any station, not only
        # favorites, and this release's own Clear cache keeps them too.
        self.assertEqual(values, {"worldmedia.volume.v1": "0.5", OWN_STREAM_KEY: self.values[OWN_STREAM_KEY]})
        self.assertEqual(copied, [OWN_STREAM_KEY])
        # The older release saves a different favorite: still no old names.
        v0111_save({FAVORITES_KEY: json.dumps([{"id": "rb:other"}])}, self.paths)
        self.assertNotIn(NAMES_KEY, load_profile_transfer(self.paths))
        # The same station saved again there: its name comes back, and only its.
        names = names_value({"rb:one": "Morning radio", "rb:gone": "Gone"})
        save_profile_transfer(dict(self.values, **{NAMES_KEY: names}), self.paths)
        v0111_save({FAVORITES_KEY: self.favorites}, self.paths)
        loaded = load_profile_transfer(self.paths)
        self.assertEqual(json.loads(loaded[NAMES_KEY]), {"version": 1, "names": {"rb:one": "Morning radio"}})

    def test_a_copy_too_large_together_with_the_rest_is_left_out_first(self) -> None:
        values = {FAVORITES_KEY: self.favorites, GROUPS_KEY: self.values[GROUPS_KEY],
                  NAMES_KEY: names_value({"rb:one": "y" * 700_000})}
        save_profile_transfer(values, self.paths)
        self.assertEqual(self.read_json(profile_transfer_copy_path(self.paths))["values"],
                         {NAMES_KEY: values[NAMES_KEY]}, "the copy alone is valid")
        # The older release then saves a much larger favorites list.
        big_favorites = json.dumps([{"id": "rb:one", "title": "x" * 1_400_000}])
        v0111_save(dict(values, **{FAVORITES_KEY: big_favorites}), self.paths)
        loaded, copied = load_profile_transfer_report(self.paths)
        self.assertEqual(copied, [])
        self.assertEqual(loaded, {FAVORITES_KEY: big_favorites, GROUPS_KEY: self.values[GROUPS_KEY]})

    def test_an_oversized_copy_is_left_out_of_the_backup_and_an_unsafe_one_still_refused(self) -> None:
        store = PlaylistStore(self.state / "playlists.json")
        save_profile_transfer({FAVORITES_KEY: self.favorites, NAMES_KEY: names_value({"rb:one": "Mine"})}, self.paths)
        copy = profile_transfer_copy_path(self.paths)
        copy.write_text(json.dumps({"version": 1, "values": {NAMES_KEY: names_value({"rb:one": "z" * 6000})}}),
                        encoding="utf-8")
        with mock.patch.object(worldmedia_backup, "MAX_PROFILE_FILE_BYTES", 4096):
            result = create_backup(self.paths, store, now=datetime(2026, 11, 20, 10, 0, 2))
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertNotIn(DATA + PROFILE_TRANSFER_COPY_FILENAME, archive.namelist())
            self.assertIn(DATA + PROFILE_TRANSFER_EXTRA_FILENAME, archive.namelist())
        copy.unlink()
        copy.mkdir()
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, store, now=datetime(2026, 11, 20, 10, 0, 3))
        self.assertEqual(caught.exception.code, "BACKUP_STATE_UNSAFE")

    def test_station_eq_and_q_are_saved_and_backed_up_in_the_extra_profile(self) -> None:
        key = "worldmedia.eq-extra.v1"
        advanced = json.dumps({"assignments": {"rb:one": "bass-boost"}, "q": {"global": [3]}})
        values = {**self.values, "worldmedia.eq.v1": '{"version":1}', key: advanced}
        save_profile_transfer(values, self.paths)
        self.assertNotIn(key, self.read_json(profile_transfer_path(self.paths))["values"])
        self.assertEqual(self.read_json(profile_transfer_extra_path(self.paths))["values"][key], advanced)
        self.assertEqual(load_profile_transfer(self.paths), values)

        store = PlaylistStore(self.state / "playlists.json")
        result = create_backup(self.paths, store, now=datetime(2026, 11, 20, 10, 0, 0))
        with zipfile.ZipFile(result["path"]) as archive:
            extra = json.loads(archive.read(DATA + PROFILE_TRANSFER_EXTRA_FILENAME))
            self.assertEqual(extra["values"][key], advanced)

        save_profile_transfer({}, self.paths)
        self.assertEqual(load_profile_transfer(self.paths), {})

    def test_the_backup_carries_the_copy_and_uses_its_names(self) -> None:
        store = PlaylistStore(self.state / "playlists.json")
        save_profile_transfer(self.values, self.paths)
        v0111_save(self.values, self.paths)
        result = create_backup(self.paths, store, now=datetime(2026, 11, 20, 10, 0, 0))
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertEqual(archive.read(DATA + PROFILE_TRANSFER_COPY_FILENAME),
                             profile_transfer_copy_path(self.paths).read_bytes())
            radio = archive.read("exports/favorites-radio.m3u8").decode("utf-8")
            self.assertIn(",Morning radio\n", radio)
            readme = archive.read("README.txt").decode("utf-8")
            self.assertIn("profile-preferences-extra-copy.json - a second copy of the names you gave", readme)

    def test_a_damaged_copy_is_left_out_of_the_backup_without_stopping_it(self) -> None:
        store = PlaylistStore(self.state / "playlists.json")
        save_profile_transfer(self.values, self.paths)
        profile_transfer_copy_path(self.paths).write_text("{broken", encoding="utf-8")
        result = create_backup(self.paths, store, now=datetime(2026, 11, 20, 10, 0, 1))
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertNotIn(DATA + PROFILE_TRANSFER_COPY_FILENAME, archive.namelist())
            self.assertIn(DATA + PROFILE_TRANSFER_EXTRA_FILENAME, archive.namelist())
            self.assertIn(",Morning radio\n", archive.read("exports/favorites-radio.m3u8").decode("utf-8"))
            self.assertNotIn("extra-copy", archive.read("README.txt").decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
