from __future__ import annotations

import csv
import http.client
import io
import json
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import worldmedia_server
import worldmedia_songlog
from worldmedia_backup import create_backup
from worldmedia_playlists import PlaylistStore
from worldmedia_runtime import (
    PROFILE_TRANSFER_FILENAME,
    PROFILE_TRANSFER_KEYS,
    RuntimePaths,
    load_profile_transfer,
)
from worldmedia_songlog import (
    MAX_BODY_BYTES,
    MAX_ENTRIES,
    SongLogError,
    export_song_log,
    load_song_log,
    normalize_entries,
    save_song_log,
    song_log_csv,
)

NOW = datetime(2026, 11, 15, 9, 30, 5)
# 2026-11-15 08:00:00 in local time, whatever the test machine's time zone.
MORNING_MS = int(datetime(2026, 11, 15, 8, 0, 0).timestamp() * 1000)
# The only profile keys World Media 0.1.8 knows (worldmedia_runtime.py at v0.1.8).
V018_PROFILE_KEYS = frozenset({
    "worldmedia.favorites.v1", "worldmedia.settings.v1", "worldmedia.volume.v1",
    "worldmedia.jobs.v1", "worldmedia.eq.v1",
})


def entry(**fields) -> dict:
    value = {"time": MORNING_MS, "station": "Jazz FM", "stationId": "radio-browser:jazz",
             "source": "radio-browser", "title": "Artist - Song"}
    value.update(fields)
    return value


def save(paths: RuntimePaths, revision: int, entries: list) -> dict:
    return save_song_log({"revision": revision, "entries": entries}, paths, now=NOW)


def v018_load_profile(path: Path) -> dict:
    """What World Media 0.1.8 does with profile-preferences.json: any key it
    does not know makes it ignore the whole file."""

    raw = json.loads(path.read_text(encoding="utf-8"))
    values = raw.get("values")
    if raw.get("version") != 1 or not isinstance(values, dict):
        return {}
    if any(key not in V018_PROFILE_KEYS for key in values):
        return {}
    return values


class SongLogTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = RuntimePaths(
            portable_root=self.root,
            state_root=self.root / "WorldMediaWindows-data",
            downloads_root=self.root / "downloads",
            tools_root=self.root / "tools" / "ffmpeg",
        )
        self.state = self.paths.state_root / "state"
        self.state.mkdir(parents=True)
        self.log_file = self.state / "song-log.json"

    def download_files(self) -> list[str]:
        folder = self.paths.downloads_root
        return sorted(path.name for path in folder.iterdir()) if folder.exists() else []


class ValidationTests(SongLogTestCase):
    def test_valid_entries_are_kept_exactly(self) -> None:
        entries = [entry(), entry(title="Other", stationId="", station="", source="")]
        self.assertEqual(normalize_entries(entries), entries)

    def test_anything_else_is_rejected(self) -> None:
        cases = {
            "not a list": {"entries": []},
            "missing key": [{key: value for key, value in entry().items() if key != "source"}],
            "extra key": [entry(path="C:/Windows")],
            "time is text": [entry(time="1")],
            "time is a flag": [entry(time=True)],
            "time is fractional": [entry(time=1.5)],
            "time is zero": [entry(time=0)],
            "time too far": [entry(time=worldmedia_songlog.MAX_TIME_MS + 1)],
            "title not text": [entry(title=5)],
            "title empty": [entry(title="   ")],
            "title too long": [entry(title="x" * 201)],
            "station too long": [entry(station="x" * 201)],
            "station id too long": [entry(stationId="x" * 301)],
            "source too long": [entry(source="x" * 65)],
            "line break": [entry(title="a\nb")],
            "tab": [entry(station="\tJazz")],
            "lone surrogate": [entry(title="a\ud800b")],
            "entry not an object": ["Artist - Song"],
            "too many": [entry() for _ in range(MAX_ENTRIES + 1)],
        }
        for name, value in cases.items():
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    normalize_entries(value)

    def test_limits_count_characters_not_bytes(self) -> None:
        wide = "\U0001F3B5" * 200  # 200 characters, 800 bytes of UTF-8
        self.assertEqual(normalize_entries([entry(title=wide)])[0]["title"], wide)
        self.assertEqual(len(normalize_entries([entry() for _ in range(MAX_ENTRIES)])), MAX_ENTRIES)

    def test_the_body_limit_fits_the_largest_valid_log(self) -> None:
        widest = entry(time=worldmedia_songlog.MAX_TIME_MS, title="\U0001F3B5" * 200, station="\"" * 200,
                       stationId="\\" * 300, source="\u00e9" * 64)
        body = json.dumps({"entries": [widest] * MAX_ENTRIES}, ensure_ascii=False, separators=(",", ":"))
        self.assertLessEqual(len(body.encode("utf-8")), MAX_BODY_BYTES)


class StoreTests(SongLogTestCase):
    def test_save_and_load_round_trip(self) -> None:
        entries = [entry(), entry(title="Next \u266a \u201cquoted\u201d", time=MORNING_MS + 1000)]
        self.assertEqual(save(self.paths, 1, entries), {"saved": True, "revision": 1, "count": 2})
        self.assertEqual(load_song_log(self.paths), {"entries": entries, "revision": 1, "unreadable": False})
        stored = json.loads(self.log_file.read_text(encoding="utf-8"))
        self.assertEqual(stored, {"version": 1, "revision": 1, "entries": entries})
        self.assertEqual([path.name for path in self.state.iterdir()], ["song-log.json"])

    def test_saving_requires_only_a_revision_and_an_entries_list(self) -> None:
        for body in ({}, {"entries": [entry()]}, {"revision": 1, "entries": [entry()], "path": "x"}, [],
                     {"revision": 1, "entries": "x"}, {"revision": True, "entries": []},
                     {"revision": 0, "entries": []}, {"revision": 1.5, "entries": []},
                     {"revision": "2", "entries": []}, {"revision": 2**53, "entries": []}):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    save_song_log(body, self.paths)
        self.assertFalse(self.log_file.exists())

    def test_only_a_missing_file_is_an_ordinary_empty_log(self) -> None:
        self.assertEqual(load_song_log(self.paths), {"entries": [], "revision": 0, "unreadable": False})

    def test_a_file_from_before_revisions_counts_as_revision_0(self) -> None:
        self.log_file.write_text(json.dumps({"version": 1, "entries": [entry()]}), encoding="utf-8")
        self.assertEqual(load_song_log(self.paths), {"entries": [entry()], "revision": 0, "unreadable": False})

    def test_untrusted_text_is_stored_as_plain_text(self) -> None:
        markup = '<img src=x onerror="alert(1)"> & =HYPERLINK("x")'
        save(self.paths, 1, [entry(title=markup, station=markup)])
        self.assertEqual(load_song_log(self.paths)["entries"][0]["title"], markup)


UNREADABLE = {
    "not json": b"not json",
    "not UTF-8": b"\xff\xfe\x00",
    "a list": b"[]",
    "newer version": b'{"version":2,"revision":9,"entries":[]}',
    "entries not a list": b'{"version":1,"entries":{}}',
    "invalid entry": json.dumps({"version": 1, "entries": [entry(), {"title": "<b>no time</b>"}]}).encode(),
    "bad revision": json.dumps({"version": 1, "revision": -1, "entries": []}).encode(),
    "too many entries": json.dumps({"version": 1, "entries": [entry()] * (MAX_ENTRIES + 1)}).encode(),
    "deeply nested": b"[" * 100000,
}


class UnreadableFileTests(SongLogTestCase):
    def test_an_unreadable_file_is_reported_and_left_alone_by_reading(self) -> None:
        for name, data in UNREADABLE.items():
            with self.subTest(name):
                self.log_file.write_bytes(data)
                self.assertEqual(load_song_log(self.paths), {"entries": [], "revision": 0, "unreadable": True})
                self.assertEqual(self.log_file.read_bytes(), data)

    def test_an_oversized_file_is_unreadable_and_not_read(self) -> None:
        save(self.paths, 1, [entry()])
        with mock.patch.object(worldmedia_songlog, "MAX_FILE_BYTES", 10), \
             mock.patch.object(Path, "read_bytes", side_effect=AssertionError("read")):
            self.assertTrue(load_song_log(self.paths)["unreadable"])

    def test_the_first_write_moves_an_unreadable_file_aside_and_starts_afresh(self) -> None:
        for name, data in UNREADABLE.items():
            with self.subTest(name):
                for child in self.state.iterdir():
                    child.unlink()
                self.log_file.write_bytes(data)
                self.assertEqual(save(self.paths, 1, [entry()]), {"saved": True, "revision": 1, "count": 1})
                kept = self.state / "song-log-unreadable-20261115-093005.json"
                self.assertEqual(kept.read_bytes(), data)
                self.assertEqual(load_song_log(self.paths), {"entries": [entry()], "revision": 1, "unreadable": False})
                self.assertEqual(sorted(p.name for p in self.state.iterdir()), [kept.name, "song-log.json"])

    def test_set_aside_files_never_replace_each_other_and_only_the_newest_three_stay(self) -> None:
        older = ["song-log-unreadable-20250101-000000.json", "song-log-unreadable-20260101-000000.json",
                 "song-log-unreadable-20261115-093005.json"]
        for name in older:
            (self.state / name).write_text(name, encoding="utf-8")
        (self.state / "song-log-unreadable-notes.txt").write_text("not ours", encoding="utf-8")
        self.log_file.write_bytes(b"broken")
        save(self.paths, 1, [entry()])
        names = sorted(p.name for p in self.state.iterdir())
        self.assertEqual(names, [
            "song-log-unreadable-20260101-000000.json", "song-log-unreadable-20261115-093005-2.json",
            "song-log-unreadable-20261115-093005.json", "song-log-unreadable-notes.txt", "song-log.json",
        ])
        self.assertEqual((self.state / "song-log-unreadable-20261115-093005-2.json").read_bytes(), b"broken")
        self.assertEqual((self.state / "song-log-unreadable-20261115-093005.json").read_text(encoding="utf-8"),
                         older[2], "an earlier file with the same name is never replaced")

    def test_a_failed_move_changes_nothing(self) -> None:
        self.log_file.write_bytes(b"broken")
        with mock.patch.object(worldmedia_songlog, "_publish", side_effect=PermissionError("locked")):
            with self.assertRaises(SongLogError) as caught:
                save(self.paths, 1, [entry()])
        self.assertEqual(caught.exception.code, "SONG_LOG_SET_ASIDE_FAILED")
        self.assertEqual(self.log_file.read_bytes(), b"broken")
        self.assertEqual([p.name for p in self.state.iterdir()], ["song-log.json"])

    def test_a_file_that_cannot_be_read_right_now_is_an_error_and_never_moved(self) -> None:
        save(self.paths, 3, [entry()])
        before = self.log_file.read_bytes()
        for target in ("read_bytes",):
            with mock.patch.object(Path, target, side_effect=PermissionError("locked")):
                with self.assertRaises(SongLogError) as caught:
                    load_song_log(self.paths)
                self.assertEqual((caught.exception.code, caught.exception.status), ("SONG_LOG_UNAVAILABLE", 503))
                self.assertTrue(caught.exception.retryable)
                with self.assertRaises(SongLogError):
                    save(self.paths, 4, [])
        with mock.patch.object(worldmedia_songlog.os, "stat", side_effect=PermissionError("denied")):
            with self.assertRaises(SongLogError):
                load_song_log(self.paths)
        self.assertEqual(self.log_file.read_bytes(), before)
        self.assertEqual([p.name for p in self.state.iterdir()], ["song-log.json"])

    def test_a_folder_in_place_of_the_file_is_refused(self) -> None:
        self.log_file.mkdir()
        with self.assertRaises(SongLogError) as caught:
            load_song_log(self.paths)
        self.assertEqual(caught.exception.code, "SONG_LOG_UNSAFE")


class RevisionTests(SongLogTestCase):
    def test_a_write_that_is_not_newer_is_answered_with_what_is_stored(self) -> None:
        save(self.paths, 4, [entry(title="Newer")])
        for revision in (4, 3, 1):
            with self.subTest(revision=revision):
                self.assertEqual(save(self.paths, revision, [entry(title="Older")]), {
                    "saved": False, "stale": True, "revision": 4, "entries": [entry(title="Newer")],
                })
        self.assertEqual(load_song_log(self.paths)["entries"], [entry(title="Newer")])

    def test_writes_arriving_out_of_order_keep_the_newest(self) -> None:
        self.assertTrue(save(self.paths, 2, [entry(title="A"), entry(title="B")])["saved"])
        self.assertFalse(save(self.paths, 1, [entry(title="A")])["saved"])
        self.assertEqual([item["title"] for item in load_song_log(self.paths)["entries"]], ["A", "B"])

    def test_a_late_older_write_after_a_clear_does_not_bring_entries_back(self) -> None:
        save(self.paths, 1, [entry(title="A")])
        self.assertTrue(save(self.paths, 3, [])["saved"])  # Clear is a write like any other
        self.assertFalse(save(self.paths, 2, [entry(title="A"), entry(title="B")])["saved"])
        self.assertEqual(load_song_log(self.paths), {"entries": [], "revision": 3, "unreadable": False})

    def test_concurrent_writes_end_with_the_highest_revision(self) -> None:
        import random
        import threading as threads
        revisions = list(range(1, 41))
        random.Random(7).shuffle(revisions)
        workers = [threads.Thread(target=save, args=(self.paths, revision, [entry(title=f"Rev {revision}")]))
                   for revision in revisions]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(load_song_log(self.paths), {
            "entries": [entry(title="Rev 40")], "revision": 40, "unreadable": False,
        })


class OlderBuildTests(SongLogTestCase):
    def write_profile(self, values: dict) -> Path:
        path = self.state / PROFILE_TRANSFER_FILENAME
        path.write_text(json.dumps({"version": 1, "values": values}), encoding="utf-8")
        return path

    def test_an_unknown_profile_key_makes_0_1_8_ignore_the_whole_profile(self) -> None:
        # Why the song log is not a profile key: in 0.1.8 this costs the favorites.
        favorites = json.dumps([{"id": "radio-browser:one"}])
        path = self.write_profile({"worldmedia.favorites.v1": favorites, "worldmedia.songlog.v1": "[]"})
        self.assertEqual(v018_load_profile(path), {})

    def test_the_song_log_never_touches_the_profile_files(self) -> None:
        favorites = json.dumps([{"id": "radio-browser:one"}])
        path = self.write_profile({"worldmedia.favorites.v1": favorites})
        before = path.read_bytes()
        save(self.paths, 1, [entry()])
        export_song_log({"entries": [entry()]}, self.paths, now=NOW)
        save(self.paths, 2, [])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(v018_load_profile(path), {"worldmedia.favorites.v1": favorites})
        self.assertEqual(load_profile_transfer(self.paths), {"worldmedia.favorites.v1": favorites})
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), [PROFILE_TRANSFER_FILENAME, "song-log.json"])

    def test_the_song_log_is_not_a_profile_key(self) -> None:
        self.assertNotIn("worldmedia.songlog.v1", PROFILE_TRANSFER_KEYS)
        self.assertNotIn("song", " ".join(PROFILE_TRANSFER_KEYS))


class CsvTests(SongLogTestCase):
    def rows(self, data: bytes) -> list[list[str]]:
        return list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline="")))

    def test_bom_header_local_date_and_time_and_crlf(self) -> None:
        data = song_log_csv([entry(), entry(title="Older", time=MORNING_MS - 61_000)])
        self.assertTrue(data.startswith(b"\xef\xbb\xbfDate,Time,Song,Station\r\n"))
        self.assertEqual(self.rows(data), [
            ["Date", "Time", "Song", "Station"],
            ["2026-11-15", "08:00:00", "Artist - Song", "Jazz FM"],
            ["2026-11-15", "07:58:59", "Older", "Jazz FM"],
        ])

    def test_quoting_keeps_every_cell_intact(self) -> None:
        title = 'He said "hi", then; left'
        station = "Rock, Pop & \u00c9mile \U0001F3B8"
        data = song_log_csv([entry(title=title, station=station)])
        self.assertIn(b'"He said ""hi"", then; left"', data)
        self.assertEqual(self.rows(data)[1][2:], [title, station])

    def test_formula_starts_are_neutralised(self) -> None:
        for start in ("=", "+", "-", "@", "\t", "\r"):
            with self.subTest(start=repr(start)):
                text = f"{start}HYPERLINK(\"http://x\")"
                row = self.rows(song_log_csv([entry(title=text, station=text)]))[1]
                self.assertTrue(row[2].startswith("'"), row[2])
                self.assertTrue(row[3].startswith("'"), row[3])
        safe = self.rows(song_log_csv([entry(title="Song = Good", station="A-Z")]))[1]
        self.assertEqual(safe[2:], ["Song = Good", "A-Z"])

    def test_line_breaks_cannot_start_a_new_row(self) -> None:
        data = song_log_csv([entry(title="one\ntwo\u2028three", station="a\r\nb")])
        self.assertEqual(len(self.rows(data)), 2)
        self.assertEqual(self.rows(data)[1][2:], ["one two three", "a  b"])


class ExportTests(SongLogTestCase):
    def test_writes_a_named_csv_into_the_downloads_folder(self) -> None:
        result = export_song_log({"entries": [entry()]}, self.paths, now=NOW)
        self.assertEqual(result, {"name": "WorldMedia-song-log-20261115-093005.csv", "count": 1})
        data = (self.paths.downloads_root / result["name"]).read_bytes()
        self.assertTrue(data.startswith(b"\xef\xbb\xbfDate,Time,Song,Station\r\n"))
        self.assertEqual(self.download_files(), [result["name"]])

    def test_an_empty_log_still_writes_the_header(self) -> None:
        result = export_song_log({"entries": []}, self.paths, now=NOW)
        data = (self.paths.downloads_root / result["name"]).read_bytes()
        self.assertEqual(data, b"\xef\xbb\xbfDate,Time,Song,Station\r\n")

    def test_saves_in_the_same_second_never_overwrite(self) -> None:
        names = [export_song_log({"entries": [entry(title=f"Song {n}")]}, self.paths, now=NOW)["name"]
                 for n in range(3)]
        self.assertEqual(names, ["WorldMedia-song-log-20261115-093005.csv", "WorldMedia-song-log-20261115-093005-2.csv",
                                 "WorldMedia-song-log-20261115-093005-3.csv"])
        self.assertIn(b"Song 0", (self.paths.downloads_root / names[0]).read_bytes())
        self.assertEqual(self.download_files(), sorted(names))

    def test_too_many_in_one_second_is_refused_without_leftovers(self) -> None:
        with mock.patch.object(worldmedia_songlog, "MAX_NAME_ATTEMPTS", 1):
            export_song_log({"entries": []}, self.paths, now=NOW)
            with self.assertRaises(SongLogError) as caught:
                export_song_log({"entries": []}, self.paths, now=NOW)
        self.assertEqual(caught.exception.code, "SONG_LOG_NAME_COLLISION")
        self.assertEqual(self.download_files(), ["WorldMedia-song-log-20261115-093005.csv"])

    def test_invalid_bodies_write_nothing(self) -> None:
        for body in ({}, {"entries": [entry()], "path": "C:/x.csv"}, {"entries": [entry(time="x")]},
                     {"entries": [entry() for _ in range(MAX_ENTRIES + 1)]}):
            with self.subTest(body=str(body)[:40]):
                with self.assertRaises(SongLogError) as caught:
                    export_song_log(body, self.paths, now=NOW)
                self.assertEqual(caught.exception.code, "INVALID_SONG_LOG")
                self.assertEqual(caught.exception.status, 400)
        self.assertEqual(self.download_files(), [])

    def test_a_failure_while_writing_leaves_no_file(self) -> None:
        with mock.patch.object(worldmedia_songlog.os, "fsync", side_effect=OSError("disk full")):
            with self.assertRaises(SongLogError) as caught:
                export_song_log({"entries": [entry()]}, self.paths, now=NOW)
        self.assertEqual(caught.exception.code, "SONG_LOG_WRITE_FAILED")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(self.download_files(), [])

    def test_a_failure_while_publishing_leaves_no_file(self) -> None:
        with mock.patch.object(worldmedia_songlog, "_publish", side_effect=PermissionError("locked")):
            with self.assertRaises(SongLogError):
                export_song_log({"entries": [entry()]}, self.paths, now=NOW)
        self.assertEqual(self.download_files(), [])

    def test_a_downloads_folder_outside_the_app_is_refused(self) -> None:
        outside = RuntimePaths(portable_root=self.root / "app", state_root=self.paths.state_root,
                               downloads_root=self.root / "elsewhere", tools_root=self.paths.tools_root)
        with self.assertRaises(SongLogError) as caught:
            export_song_log({"entries": [entry()]}, outside, now=NOW)
        self.assertEqual(caught.exception.code, "UNSAFE_DOWNLOAD_ROOT")
        self.assertFalse((self.root / "elsewhere").exists())


class BackupTests(SongLogTestCase):
    def test_the_backup_includes_the_song_log(self) -> None:
        save(self.paths, 1, [entry()])
        store = PlaylistStore(self.state / "playlists.json")
        result = create_backup(self.paths, store, now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            stored = archive.read("WorldMediaWindows-data/state/song-log.json")
            readme = archive.read("README.txt").decode("utf-8")
        self.assertEqual(stored, self.log_file.read_bytes())
        self.assertIn("song-log.json - the songs radio stations announced", readme)

    def test_set_aside_files_are_left_out_and_an_unreadable_log_is_copied_as_stored(self) -> None:
        self.log_file.write_bytes(b"{broken")
        save(self.paths, 1, [entry()])  # moves the broken file aside
        self.log_file.write_bytes(b"{broken again")
        store = PlaylistStore(self.state / "playlists.json")
        result = create_backup(self.paths, store, now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            names = archive.namelist()
            self.assertEqual(archive.read("WorldMediaWindows-data/state/song-log.json"), b"{broken again")
        self.assertFalse(any("unreadable" in name for name in names), names)

    def test_a_song_log_too_large_to_be_one_is_left_out_without_stopping_the_backup(self) -> None:
        save(self.paths, 1, [entry()])
        store = PlaylistStore(self.state / "playlists.json")
        with mock.patch("worldmedia_backup.MAX_SONG_LOG_FILE_BYTES", 10):
            result = create_backup(self.paths, store, now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertNotIn("WorldMediaWindows-data/state/song-log.json", archive.namelist())

    def test_no_song_log_means_no_song_log_in_the_backup(self) -> None:
        store = PlaylistStore(self.state / "playlists.json")
        result = create_backup(self.paths, store, now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertNotIn("WorldMediaWindows-data/state/song-log.json", archive.namelist())
            self.assertNotIn("song-log.json", archive.read("README.txt").decode("utf-8"))


class RouteTests(unittest.TestCase):
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
        with worldmedia_server._rate_lock:
            worldmedia_server._rate_log.clear()
        self.token = worldmedia_server.SESSION_TOKEN
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.paths = RuntimePaths(portable_root=root, state_root=root / "WorldMediaWindows-data",
                                  downloads_root=root / "downloads", tools_root=root / "tools")
        patcher = mock.patch.object(worldmedia_server, "RUNTIME_PATHS", self.paths)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method: str, route: str, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, route, skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None and "Content-Length" not in (headers or {}):
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response, payload

    def headers(self, **overrides: str) -> dict[str, str]:
        headers = {"Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json"}
        headers.update(overrides)
        return {name: value for name, value in headers.items() if value}

    def body(self, entries: list, revision: int | None = None) -> bytes:
        value = {"entries": entries} if revision is None else {"revision": revision, "entries": entries}
        return json.dumps(value).encode("utf-8")

    def get(self):
        return self.request("GET", "/api/v1/song-log", {"X-WorldMedia-Token": self.token})

    def test_routes_are_validated_like_other_mutating_routes(self) -> None:
        # The length is refused before the body is read, so only the header is
        # oversized (sending the full body races the server's early answer).
        too_large = self.headers(**{"Content-Length": str(MAX_BODY_BYTES + 1)})
        for route in ("/api/v1/song-log", "/api/v1/song-log/export"):
            revision = 1 if route == "/api/v1/song-log" else None
            good = self.body([entry()], revision)
            cases = [
                (self.headers(**{"X-WorldMedia-Token": ""}), good, 403, "INVALID_TOKEN"),
                (self.headers(**{"X-WorldMedia-Token": "wrong"}), good, 403, "INVALID_TOKEN"),
                (self.headers(Origin=""), good, 403, "ORIGIN_REQUIRED"),
                (self.headers(Origin="http://evil.example"), good, 403, "INVALID_ORIGIN"),
                (self.headers(**{"Content-Type": "text/plain"}), good, 415, "JSON_REQUIRED"),
                (self.headers(), b"[]", 400, "JSON_OBJECT_REQUIRED"),
                (too_large, b"", 413, "BODY_TOO_LARGE"),
                (self.headers(), b'{"revision":1,"entries":[],"path":"C:/Windows/x.csv"}', 400, "INVALID_SONG_LOG"),
                (self.headers(), b'{"entries":[],"path":"C:/Windows/x.csv"}', 400, "INVALID_SONG_LOG"),
                (self.headers(), self.body([entry(time="soon")], revision), 400, "INVALID_SONG_LOG"),
                (self.headers(), self.body([entry()] * (MAX_ENTRIES + 1), revision), 400, "INVALID_SONG_LOG"),
            ]
            if revision:
                cases.append((self.headers(), self.body([entry()]), 400, "INVALID_SONG_LOG"))
                cases.append((self.headers(), self.body([entry()], 0), 400, "INVALID_SONG_LOG"))
            for headers, body, status, code in cases:
                with self.subTest(route=route, code=code, body=body[:24]):
                    response, payload = self.request("POST", route, headers, body)
                    self.assertEqual(response.status, status)
                    self.assertEqual(payload["error"]["code"], code)
        self.assertFalse((self.paths.state_root / "state" / "song-log.json").exists())
        self.assertFalse(self.paths.downloads_root.exists())

    def test_reading_needs_the_session_token(self) -> None:
        response, payload = self.request("GET", "/api/v1/song-log", {"Origin": self.origin})
        self.assertEqual(response.status, 403)
        response, payload = self.request("GET", "/api/v1/song-log/export", {"X-WorldMedia-Token": self.token})
        self.assertEqual(response.status, 405)

    def test_save_load_and_export_through_the_routes(self) -> None:
        response, payload = self.get()
        self.assertEqual((response.status, payload["data"]), (200, {"entries": [], "revision": 0, "unreadable": False}))
        entries = [entry(), entry(title="=cmd|' /C calc'!A0", time=MORNING_MS + 5000)]
        response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body(entries, 1))
        self.assertEqual((response.status, payload["data"]), (200, {"saved": True, "revision": 1, "count": 2}))
        response, payload = self.get()
        self.assertEqual(payload["data"], {"entries": entries, "revision": 1, "unreadable": False})
        # A write that is not newer is a normal answer carrying what is stored.
        response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body([], 1))
        self.assertEqual((response.status, payload["data"]),
                         (200, {"saved": False, "stale": True, "revision": 1, "entries": entries}))
        response, payload = self.request("POST", "/api/v1/song-log/export", self.headers(), self.body(entries[::-1]))
        self.assertEqual(response.status, 200)
        name = payload["data"]["name"]
        self.assertRegex(name, r"^WorldMedia-song-log-\d{8}-\d{6}\.csv$")
        self.assertEqual(payload["data"]["count"], 2)
        self.assertNotIn("path", payload["data"])
        data = (self.paths.downloads_root / name).read_bytes()
        self.assertIn(b"'=cmd", data)
        response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body([], 2))
        self.assertEqual(payload["data"], {"saved": True, "revision": 2, "count": 0})
        self.assertEqual(load_song_log(self.paths), {"entries": [], "revision": 2, "unreadable": False})

    def test_unreadable_and_unavailable_files_through_the_routes(self) -> None:
        state = self.paths.state_root / "state"
        state.mkdir(parents=True)
        (state / "song-log.json").write_bytes(b"{broken")
        response, payload = self.get()
        self.assertEqual(payload["data"], {"entries": [], "revision": 0, "unreadable": True})
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError("locked")):
            response, payload = self.get()
            self.assertEqual((response.status, payload["error"]["code"]), (503, "SONG_LOG_UNAVAILABLE"))
            self.assertTrue(payload["error"]["retryable"])
            response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body([entry()], 1))
            self.assertEqual(response.status, 503)
        self.assertEqual((state / "song-log.json").read_bytes(), b"{broken")
        response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body([entry()], 1))
        self.assertEqual(payload["data"], {"saved": True, "revision": 1, "count": 1})
        kept = [p.name for p in state.iterdir() if p.name.startswith("song-log-unreadable-")]
        self.assertEqual(len(kept), 1)
        self.assertEqual((state / kept[0]).read_bytes(), b"{broken")

    def test_export_errors_are_reported_plainly(self) -> None:
        error = SongLogError("The downloads folder is not available, so the song log was not saved.",
                             code="DOWNLOADS_NOT_WRITABLE", status=409, retryable=True)
        with mock.patch.object(worldmedia_server, "export_song_log", side_effect=error):
            response, payload = self.request("POST", "/api/v1/song-log/export", self.headers(), self.body([]))
        self.assertEqual(response.status, 409)
        self.assertEqual(payload["error"], {
            "code": "DOWNLOADS_NOT_WRITABLE",
            "message": "The downloads folder is not available, so the song log was not saved.",
            "retryable": True,
        })

    def test_a_disk_error_while_saving_is_reported_plainly(self) -> None:
        with mock.patch.object(worldmedia_songlog, "_atomic_write_json", side_effect=OSError("disk full")):
            response, payload = self.request("POST", "/api/v1/song-log", self.headers(), self.body([entry()], 1))
        self.assertEqual(response.status, 500)
        self.assertEqual(payload["error"]["code"], "SONG_LOG_SAVE_FAILED")
        self.assertTrue(payload["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
