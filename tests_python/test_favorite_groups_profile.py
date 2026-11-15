"""Favorites categories in the profile mirror and the backup.

Releases up to 0.1.8 reject the whole profile-preferences.json when it holds a
key they do not know, favorites included. The categories key (and any later
key) therefore goes into profile-preferences-extra.json, which those releases
never open.
"""
from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import worldmedia_runtime
import worldmedia_server
from worldmedia_backup import build_favorite_exports, create_backup, favorite_categories
from worldmedia_playlists import PlaylistStore, parse_playlist
from worldmedia_runtime import (
    LEGACY_PROFILE_TRANSFER_KEYS,
    MAX_PROFILE_WRITERS,
    PROFILE_FILES_LOCK,
    PROFILE_SEQUENCE_HEADER,
    PROFILE_TRANSFER_EXTRA_FILENAME,
    PROFILE_TRANSFER_KEYS,
    PROFILE_WRITER_HEADER,
    RuntimePaths,
    get_runtime_paths,
    load_profile_transfer,
    parse_profile_write_order,
    profile_transfer_extra_path,
    profile_transfer_path,
    reset_profile_write_order,
    save_profile_transfer,
)

GROUPS_KEY = "worldmedia.favgroups.v1"
# Exactly what release 0.1.8 accepts in profile-preferences.json.
V018_KEYS = {
    "worldmedia.favorites.v1", "worldmedia.settings.v1", "worldmedia.volume.v1",
    "worldmedia.jobs.v1", "worldmedia.eq.v1",
}
DATA = "WorldMediaWindows-data/state/"


def v018_reads(path: Path) -> dict:
    """How release 0.1.8 reads the main file: any unknown key loses all of it."""

    raw = json.loads(path.read_text(encoding="utf-8"))
    values = raw.get("values")
    if raw.get("version") != 1 or not isinstance(values, dict) or set(values) - V018_KEYS:
        return {}
    return values


def groups_value(groups: list[tuple[str, str]], assign: dict[str, str]) -> str:
    return json.dumps({"version": 1, "groups": [{"id": i, "name": n} for i, n in groups], "assign": assign})


class ProfileSplitTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        self.favorites = json.dumps([{"id": "radio-browser:one", "title": "One"}])

    def test_the_key_is_mirrored_but_never_in_the_file_older_releases_read(self) -> None:
        self.assertIn(GROUPS_KEY, PROFILE_TRANSFER_KEYS)
        self.assertEqual(set(LEGACY_PROFILE_TRANSFER_KEYS), V018_KEYS)
        values = {
            "worldmedia.favorites.v1": self.favorites,
            "worldmedia.settings.v1": '{"theme":"forest"}',
            GROUPS_KEY: groups_value([("g1", "Rock")], {"radio-browser:one": "g1"}),
        }
        self.assertEqual(save_profile_transfer(values, self.paths), values)
        main = profile_transfer_path(self.paths)
        extra = profile_transfer_extra_path(self.paths)
        self.assertEqual(extra, main.with_name(PROFILE_TRANSFER_EXTRA_FILENAME))
        # An older release still finds the favorites after a downgrade.
        self.assertEqual(v018_reads(main), {
            "worldmedia.favorites.v1": self.favorites, "worldmedia.settings.v1": '{"theme":"forest"}',
        })
        self.assertEqual(json.loads(extra.read_text(encoding="utf-8")),
                         {"version": 1, "values": {GROUPS_KEY: values[GROUPS_KEY]}})
        # This release puts the two back together.
        self.assertEqual(load_profile_transfer(self.paths), values)

    def test_without_newer_keys_there_is_no_extra_file_and_clearing_removes_it(self) -> None:
        save_profile_transfer({"worldmedia.favorites.v1": self.favorites}, self.paths)
        self.assertFalse(profile_transfer_extra_path(self.paths).exists())
        save_profile_transfer({"worldmedia.favorites.v1": self.favorites, GROUPS_KEY: "{}"}, self.paths)
        self.assertTrue(profile_transfer_extra_path(self.paths).exists())
        # Clear cache sends no values: both files are emptied.
        self.assertEqual(save_profile_transfer({}, self.paths), {})
        self.assertFalse(profile_transfer_extra_path(self.paths).exists())
        self.assertEqual(load_profile_transfer(self.paths), {})

    def test_a_save_still_refuses_unknown_keys(self) -> None:
        with self.assertRaises(ValueError):
            save_profile_transfer({GROUPS_KEY: "{}", "worldmedia.unknown.v1": "x"}, self.paths)
        self.assertFalse(profile_transfer_path(self.paths).exists())

    def test_loading_skips_keys_from_a_newer_release_instead_of_dropping_the_file(self) -> None:
        main = profile_transfer_path(self.paths)
        main.parent.mkdir(parents=True)
        main.write_text(json.dumps({"version": 1, "values": {
            "worldmedia.favorites.v1": self.favorites, "worldmedia.future.v9": "x",
        }}), encoding="utf-8")
        self.assertEqual(load_profile_transfer(self.paths), {"worldmedia.favorites.v1": self.favorites})

    def test_a_broken_extra_file_never_costs_the_favorites(self) -> None:
        save_profile_transfer({"worldmedia.favorites.v1": self.favorites, GROUPS_KEY: "{}"}, self.paths)
        extra = profile_transfer_extra_path(self.paths)
        for broken in ("{not json", '{"version":2,"values":{}}', '{"version":1,"values":[]}'):
            with self.subTest(broken=broken):
                extra.write_text(broken, encoding="utf-8")
                self.assertEqual(load_profile_transfer(self.paths), {"worldmedia.favorites.v1": self.favorites})

    def test_the_extra_file_cannot_override_keys_of_the_main_file(self) -> None:
        save_profile_transfer({"worldmedia.favorites.v1": self.favorites, GROUPS_KEY: "{}"}, self.paths)
        extra = profile_transfer_extra_path(self.paths)
        extra.write_text(json.dumps({"version": 1, "values": {
            "worldmedia.favorites.v1": "[]", GROUPS_KEY: "{}",
        }}), encoding="utf-8")
        self.assertEqual(load_profile_transfer(self.paths)["worldmedia.favorites.v1"], self.favorites)


PAGE = "a" * 32
OTHER_PAGE = "b" * 32


class WriteOrderTests(unittest.TestCase):
    """A write the page gave up on can arrive after a later one; it must not land."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        reset_profile_write_order()
        self.addCleanup(reset_profile_write_order)

    def pair(self, number: int) -> dict[str, str]:
        return {
            "worldmedia.favorites.v1": json.dumps([{"id": f"rb:{number}"}]),
            GROUPS_KEY: groups_value([("g1", f"Group {number}")], {f"rb:{number}": "g1"}),
        }

    def files(self) -> tuple[bytes | None, bytes | None]:
        main = profile_transfer_path(self.paths)
        extra = profile_transfer_extra_path(self.paths)
        return (main.read_bytes() if main.exists() else None, extra.read_bytes() if extra.exists() else None)

    def test_an_older_write_arriving_after_a_newer_one_changes_nothing(self) -> None:
        self.assertEqual(save_profile_transfer(self.pair(2), self.paths, order=(PAGE, 2)), self.pair(2))
        before = self.files()
        self.assertIsNone(save_profile_transfer(self.pair(1), self.paths, order=(PAGE, 1)))
        # The same number again is not newer either.
        self.assertIsNone(save_profile_transfer(self.pair(3), self.paths, order=(PAGE, 2)))
        self.assertEqual(self.files(), before)
        self.assertEqual(load_profile_transfer(self.paths), self.pair(2))

    def test_a_late_save_after_a_clear_does_not_bring_the_data_back(self) -> None:
        save_profile_transfer(self.pair(1), self.paths, order=(PAGE, 1))
        # Save 2 timed out on the page; then Clear cache (3) reached the server.
        self.assertEqual(save_profile_transfer({}, self.paths, order=(PAGE, 3)), {})
        self.assertIsNone(save_profile_transfer(self.pair(2), self.paths, order=(PAGE, 2)))
        self.assertEqual(load_profile_transfer(self.paths), {})
        self.assertFalse(profile_transfer_extra_path(self.paths).exists())
        self.assertEqual(json.loads(profile_transfer_path(self.paths).read_text(encoding="utf-8"))["values"], {})

    def test_pages_are_ordered_apart_and_writes_without_order_are_applied_as_before(self) -> None:
        save_profile_transfer(self.pair(5), self.paths, order=(PAGE, 5))
        # Another page load (after a reload, say) starts again from 1.
        self.assertEqual(save_profile_transfer(self.pair(1), self.paths, order=(OTHER_PAGE, 1)), self.pair(1))
        # An older client sends no order: always applied.
        self.assertEqual(save_profile_transfer(self.pair(9), self.paths), self.pair(9))
        self.assertEqual(load_profile_transfer(self.paths), self.pair(9))
        # The pages' numbers are untouched by it.
        self.assertIsNone(save_profile_transfer(self.pair(4), self.paths, order=(PAGE, 4)))

    def test_the_order_headers_are_strict(self) -> None:
        self.assertIsNone(parse_profile_write_order(None, None))
        self.assertEqual(parse_profile_write_order(PAGE, "7"), (PAGE, 7))
        self.assertEqual(parse_profile_write_order("A-b_" * 2, "9" * 16), ("A-b_" * 2, int("9" * 16)))
        for writer, sequence in (
            (PAGE, None), (None, "1"), ("short", "1"), ("a" * 65, "1"), ("a" * 31 + "!", "1"),
            (PAGE, "0"), (PAGE, "-1"), (PAGE, "1.5"), (PAGE, ""), (PAGE, "1" * 17), (PAGE, " 1"),
            (PAGE, "\u0661"), (["x"], "1"),
        ):
            with self.subTest(writer=writer, sequence=sequence):
                with self.assertRaises(ValueError):
                    parse_profile_write_order(writer, sequence)

    def test_only_a_handful_of_pages_are_remembered(self) -> None:
        pages = [f"page{index:04d}" for index in range(MAX_PROFILE_WRITERS + 1)]
        for page in pages:
            save_profile_transfer(self.pair(1), self.paths, order=(page, 5))
        self.assertEqual(len(worldmedia_runtime._profile_writers), MAX_PROFILE_WRITERS)
        # The oldest was forgotten; the others still refuse older writes.
        self.assertNotIn(pages[0], worldmedia_runtime._profile_writers)
        self.assertIsNone(save_profile_transfer(self.pair(2), self.paths, order=(pages[-1], 4)))
        self.assertIsNotNone(save_profile_transfer(self.pair(2), self.paths, order=(pages[0], 4)))

    def test_the_main_file_is_written_first_and_a_failed_second_write_is_reported(self) -> None:
        written: list[str] = []
        real_write = worldmedia_runtime._atomic_write_json

        def recording(path: Path, value: object) -> None:
            written.append(path.name)
            real_write(path, value)

        with mock.patch.object(worldmedia_runtime, "_atomic_write_json", recording):
            save_profile_transfer(self.pair(1), self.paths, order=(PAGE, 1))
        self.assertEqual(written, ["profile-preferences.json", PROFILE_TRANSFER_EXTRA_FILENAME])

        def failing_extra(path: Path, value: object) -> None:
            if path.name == PROFILE_TRANSFER_EXTRA_FILENAME:
                raise OSError("disk full")
            real_write(path, value)

        _, extra_before = self.files()
        with mock.patch.object(worldmedia_runtime, "_atomic_write_json", failing_extra):
            with self.assertRaises(OSError):
                save_profile_transfer(self.pair(2), self.paths, order=(PAGE, 2))
        main_after, extra_after = self.files()
        # The favorites are the newest; only the categories are a step behind.
        self.assertEqual(v018_reads(profile_transfer_path(self.paths)),
                         {"worldmedia.favorites.v1": self.pair(2)["worldmedia.favorites.v1"]})
        self.assertEqual(extra_after, extra_before)
        # The page saves again with a new number, and that one lands.
        self.assertEqual(save_profile_transfer(self.pair(2), self.paths, order=(PAGE, 3)), self.pair(2))
        self.assertEqual(load_profile_transfer(self.paths), self.pair(2))
        self.assertNotEqual(main_after, None)

    def test_a_clear_whose_second_step_fails_has_already_cleared_the_main_file(self) -> None:
        save_profile_transfer(self.pair(1), self.paths)
        real_unlink = Path.unlink

        def failing_unlink(path: Path, missing_ok: bool = False) -> None:
            if path.name == PROFILE_TRANSFER_EXTRA_FILENAME:
                raise PermissionError("in use")
            real_unlink(path, missing_ok=missing_ok)

        with mock.patch.object(Path, "unlink", failing_unlink):
            with self.assertRaises(OSError):
                save_profile_transfer({}, self.paths, order=(PAGE, 1))
        self.assertEqual(v018_reads(profile_transfer_path(self.paths)), {})
        self.assertEqual(load_profile_transfer(self.paths), {GROUPS_KEY: self.pair(1)[GROUPS_KEY]})
        # Cleared on the retry.
        self.assertEqual(save_profile_transfer({}, self.paths, order=(PAGE, 2)), {})
        self.assertEqual(load_profile_transfer(self.paths), {})

    def test_concurrent_writes_and_reads_always_see_both_files_from_the_same_write(self) -> None:
        errors: list[BaseException] = []
        mismatched: list[dict[str, str]] = []

        def writer(page: str) -> None:
            try:
                for number in range(1, 21):
                    save_profile_transfer(self.pair(number), self.paths, order=(page, number))
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)

        def reader() -> None:
            try:
                for _ in range(40):
                    values = load_profile_transfer(self.paths)
                    if not values:
                        continue
                    favorite = json.loads(values["worldmedia.favorites.v1"])[0]["id"]
                    if json.loads(values[GROUPS_KEY])["assign"] != {favorite: "g1"}:
                        mismatched.append(values)
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)

        threads = [threading.Thread(target=writer, args=(f"page{index:04d}",)) for index in range(4)]
        threads += [threading.Thread(target=reader) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(errors, [])
        self.assertEqual(mismatched, [])

    def test_reads_wait_for_a_write_in_progress(self) -> None:
        save_profile_transfer(self.pair(1), self.paths)
        done = threading.Event()
        with PROFILE_FILES_LOCK:
            thread = threading.Thread(target=lambda: (load_profile_transfer(self.paths), done.set()))
            thread.start()
            self.assertFalse(done.wait(0.2))
        thread.join(timeout=5)
        self.assertTrue(done.is_set())


class ProfileRouteOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        cls.port = cls.server.server_port
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.paths = get_runtime_paths(portable=base / "portable", state=base / "state")
        patcher = mock.patch.object(worldmedia_server, "RUNTIME_PATHS", self.paths)
        patcher.start()
        self.addCleanup(patcher.stop)
        reset_profile_write_order()
        self.addCleanup(reset_profile_write_order)
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        _, payload = self.request("GET", "/api/v1/session")
        self.token = payload["data"]["token"]

    def request(self, method: str, path: str, *, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader("Host", f"127.0.0.1:{self.port}")
            for name, value in (headers or {}).items():
                connection.putheader(name, value)
            if body is not None:
                connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            return response, json.loads(response.read())
        finally:
            connection.close()

    def save(self, values: dict[str, str], order: tuple[str, str] | None = None, **extra: str):
        headers = {"Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json"}
        if order is not None:
            headers[PROFILE_WRITER_HEADER], headers[PROFILE_SEQUENCE_HEADER] = order
        headers.update(extra)
        return self.request("POST", "/api/v1/profile/preferences", headers=headers,
                            body=json.dumps({"values": values}).encode())

    def test_a_stale_write_gets_a_success_shaped_superseded_answer(self) -> None:
        newer = {"worldmedia.favorites.v1": "[2]", GROUPS_KEY: "{}"}
        response, payload = self.save(newer, (PAGE, "2"))
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"], {"saved": True, "keys": sorted(newer)})
        response, payload = self.save({"worldmedia.favorites.v1": "[1]"}, (PAGE, "1"))
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"], {"saved": False, "superseded": True, "keys": []})
        self.assertEqual(load_profile_transfer(self.paths), newer)

    def test_writes_without_the_headers_are_applied_and_bad_headers_are_refused(self) -> None:
        response, payload = self.save({"worldmedia.favorites.v1": "[1]"})
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"], {"saved": True, "keys": ["worldmedia.favorites.v1"]})
        for headers in ({PROFILE_WRITER_HEADER: PAGE}, {PROFILE_SEQUENCE_HEADER: "1"},
                        {PROFILE_WRITER_HEADER: "x", PROFILE_SEQUENCE_HEADER: "1"},
                        {PROFILE_WRITER_HEADER: PAGE, PROFILE_SEQUENCE_HEADER: "one"}):
            with self.subTest(headers=headers):
                response, payload = self.save({"worldmedia.favorites.v1": "[2]"}, **headers)
                self.assertEqual(response.status, 400)
                self.assertEqual(payload["error"]["code"], "INVALID_PROFILE_PREFERENCES")
        self.assertEqual(load_profile_transfer(self.paths), {"worldmedia.favorites.v1": "[1]"})


class BackupCategoryTests(unittest.TestCase):
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
            {"id": "playlist:x", "title": "Mine", "source": "playlist", "type": "tv", "description": "Sports",
             "stream_url": "https://tv.example.org/x.m3u8", "thumbnail": ""},
        ]

    def backup(self) -> zipfile.ZipFile:
        result = create_backup(self.paths, self.store, now=datetime(2026, 11, 15, 10, 0, 0))
        archive = zipfile.ZipFile(result["path"])
        self.addCleanup(archive.close)
        return archive

    def test_a_category_name_becomes_the_group_title_otherwise_it_is_as_before(self) -> None:
        values = {GROUPS_KEY: groups_value([("g1", "Rock \"live\"\r\n#EXTINF:-1,x"), ("g2", "News")],
                                           {"rb:one": "g1", "playlist:x": "g2", "rb:gone": "g2"})}
        categories = favorite_categories(values)
        self.assertEqual(categories, {"rb:one": "Rock \"live\"\r\n#EXTINF:-1,x", "playlist:x": "News", "rb:gone": "News"})
        files, written, skipped = build_favorite_exports(self.favorites, categories)
        self.assertEqual((written, skipped), (3, 0))
        radio = files["favorites-radio.m3u8"]
        # Cleaned through the same writer: one line, no quote.
        self.assertIn('#EXTINF:-1 group-title="Rock \'live\' #EXTINF:-1,x",One FM\n', radio)
        self.assertIn('#EXTINF:-1 group-title="Radio Browser",Two FM\n', radio)
        self.assertEqual(len(parse_playlist(radio, "radio")["items"]), 2)
        self.assertIn('group-title="News",Mine', files["favorites-tv.m3u8"])
        # Without categories nothing changes.
        before, _, _ = build_favorite_exports(self.favorites)
        self.assertIn('group-title="Sports",Mine', before["favorites-tv.m3u8"])
        self.assertIn('group-title="Radio Browser",One FM', before["favorites-radio.m3u8"])

    def test_unreadable_categories_are_ignored(self) -> None:
        for raw in ("not json", "[]", '{"version":2}', '{"version":1,"groups":{},"assign":{}}',
                    json.dumps({"version": 1, "groups": [{"id": 5, "name": "x"}, "bad"], "assign": {"rb:one": 5}})):
            with self.subTest(raw=raw):
                self.assertEqual(favorite_categories({GROUPS_KEY: raw}), {})
        self.assertEqual(favorite_categories({}), {})
        # A name that cleans to nothing keeps the usual group.
        files, _, _ = build_favorite_exports(self.favorites[:1], {"rb:one": "\u202e\r\n"})
        self.assertIn('group-title="Radio Browser"', files["favorites-radio.m3u8"])

    def test_the_backup_copies_both_profile_files_and_uses_the_categories(self) -> None:
        values = {
            "worldmedia.favorites.v1": json.dumps(self.favorites),
            GROUPS_KEY: groups_value([("g1", "Rock")], {"rb:two": "g1"}),
        }
        save_profile_transfer(values, self.paths)
        archive = self.backup()
        names = archive.namelist()
        self.assertIn(DATA + "profile-preferences.json", names)
        self.assertIn(DATA + PROFILE_TRANSFER_EXTRA_FILENAME, names)
        self.assertEqual(archive.read(DATA + PROFILE_TRANSFER_EXTRA_FILENAME),
                         (self.state / PROFILE_TRANSFER_EXTRA_FILENAME).read_bytes())
        copied = json.loads(archive.read(DATA + "profile-preferences.json"))
        self.assertNotIn(GROUPS_KEY, copied["values"])
        radio = archive.read("exports/favorites-radio.m3u8").decode("utf-8")
        self.assertIn('group-title="Rock",Two FM', radio)
        self.assertIn('group-title="Radio Browser",One FM', radio)
        readme = archive.read("README.txt").decode("utf-8")
        self.assertIn("profile-preferences-extra.json - newer saved data, such as your favorites", readme)

    def test_the_backup_reads_both_profile_files_under_the_write_lock(self) -> None:
        save_profile_transfer({"worldmedia.favorites.v1": json.dumps(self.favorites)}, self.paths)
        done = threading.Event()
        failures: list[BaseException] = []

        def run() -> None:
            try:
                create_backup(self.paths, self.store, now=datetime(2026, 11, 15, 10, 0, 0))
            except BaseException as error:  # noqa: BLE001 - reported below
                failures.append(error)
            done.set()

        with PROFILE_FILES_LOCK:
            thread = threading.Thread(target=run)
            thread.start()
            self.assertFalse(done.wait(0.3))
        thread.join(timeout=10)
        self.assertTrue(done.is_set())
        self.assertEqual(failures, [])

    def test_a_broken_extra_file_is_left_out_without_stopping_the_backup(self) -> None:
        save_profile_transfer({"worldmedia.favorites.v1": json.dumps(self.favorites)}, self.paths)
        (self.state / PROFILE_TRANSFER_EXTRA_FILENAME).write_text("{broken", encoding="utf-8")
        archive = self.backup()
        self.assertNotIn(DATA + PROFILE_TRANSFER_EXTRA_FILENAME, archive.namelist())
        self.assertIn('group-title="Radio Browser",One FM',
                      archive.read("exports/favorites-radio.m3u8").decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
