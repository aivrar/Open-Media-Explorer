from __future__ import annotations

import csv
import http.client
import io
import json
import os
import stat
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import worldmedia_server
import worldmedia_starred
from worldmedia_backup import create_backup
from worldmedia_playlists import PlaylistStore
from worldmedia_runtime import PROFILE_TRANSFER_KEYS, RuntimePaths
from worldmedia_songlog import load_song_log, save_song_log
from worldmedia_starred import (
    MAX_BODY_BYTES,
    MAX_ENTRIES,
    StarredSongsError,
    export_starred_songs,
    load_starred_songs,
    normalize_entries,
    save_starred_songs,
    starred_songs_csv,
    starred_songs_text,
)

NOW = datetime(2026, 11, 19, 9, 30, 5)
MORNING_MS = int(datetime(2026, 11, 19, 8, 0, 0).timestamp() * 1000)


def entry(**fields) -> dict:
    value = {"starred": MORNING_MS, "station": "Jazz FM", "stationId": "radio-browser:jazz",
             "source": "radio-browser", "title": "Artist - Song"}
    value.update(fields)
    return value


class StarredTestCase(unittest.TestCase):
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
        self.file = self.state / "starred-songs.json"

    def save(self, revision: int, entries: list) -> dict:
        return save_starred_songs({"revision": revision, "entries": entries}, self.paths, now=NOW)


class ValidationTests(StarredTestCase):
    def test_valid_entries_are_kept_exactly_and_anything_else_is_refused(self) -> None:
        entries = [entry(), entry(title="Other", station="", stationId="", source="")]
        self.assertEqual(normalize_entries(entries), entries)
        cases = {
            "not a list": {"entries": []},
            "song log shape": [{"time": MORNING_MS, **{k: v for k, v in entry().items() if k != "starred"}}],
            "extra key": [entry(path="C:/Windows")],
            "date is text": [entry(starred="1")],
            "date is a flag": [entry(starred=True)],
            "date is zero": [entry(starred=0)],
            "title empty": [entry(title="  ")],
            "title too long": [entry(title="x" * 201)],
            "line break": [entry(title="a\nb")],
            "lone surrogate": [entry(station="a\ud800")],
            "too many": [entry() for _ in range(MAX_ENTRIES + 1)],
        }
        for name, value in cases.items():
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    normalize_entries(value)

    def test_the_body_limit_fits_the_largest_valid_list(self) -> None:
        self.assertEqual(MAX_ENTRIES, 2000)
        widest = entry(starred=worldmedia_starred.MAX_TIME_MS, title="\U0001F3B5" * 200, station="\"" * 200,
                       stationId="\\" * 300, source="\u00e9" * 64)
        body = json.dumps({"revision": 1, "entries": [widest] * MAX_ENTRIES}, ensure_ascii=False, separators=(",", ":"))
        self.assertLessEqual(len(body.encode("utf-8")), MAX_BODY_BYTES)


class StoreTests(StarredTestCase):
    def test_save_and_load_round_trip_in_a_file_of_its_own(self) -> None:
        self.assertEqual(load_starred_songs(self.paths), {"entries": [], "revision": 0, "unreadable": False})
        self.assertEqual(self.save(1, [entry()]), {"saved": True, "revision": 1, "count": 1})
        self.assertEqual(load_starred_songs(self.paths), {"entries": [entry()], "revision": 1, "unreadable": False})
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ["starred-songs.json"])

    def test_a_write_that_is_not_newer_is_answered_with_what_is_stored(self) -> None:
        self.save(2, [entry()])
        self.assertEqual(self.save(2, []), {"saved": False, "stale": True, "revision": 2, "entries": [entry()]})
        self.assertEqual(self.save(1, []), {"saved": False, "stale": True, "revision": 2, "entries": [entry()]})
        self.assertEqual(load_starred_songs(self.paths)["entries"], [entry()])

    def test_an_unreadable_file_is_reported_then_moved_aside_by_the_first_write(self) -> None:
        self.file.write_bytes(b"{broken")
        self.assertEqual(load_starred_songs(self.paths), {"entries": [], "revision": 0, "unreadable": True})
        self.assertEqual(self.file.read_bytes(), b"{broken")
        self.save(1, [entry()])
        kept = [p for p in self.state.iterdir() if p.name.startswith("starred-songs-unreadable-")]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].read_bytes(), b"{broken")
        self.assertEqual(load_starred_songs(self.paths)["entries"], [entry()])

    def test_a_file_that_cannot_be_read_right_now_is_an_error_and_never_moved(self) -> None:
        self.file.write_bytes(b"{broken")
        with mock.patch.object(worldmedia_starred.os, "open", side_effect=PermissionError("locked")):
            with self.assertRaises(StarredSongsError) as caught:
                self.save(1, [entry()])
        self.assertEqual((caught.exception.code, caught.exception.status), ("STARRED_SONGS_UNAVAILABLE", 503))
        self.assertEqual([p.name for p in self.state.iterdir()], ["starred-songs.json"])

    def test_a_link_at_the_file_path_is_never_followed(self) -> None:
        elsewhere = self.root / "elsewhere.json"
        elsewhere.write_text(json.dumps({"version": 1, "revision": 1, "entries": [entry()]}), encoding="utf-8")
        try:
            os.symlink(elsewhere, self.file)
        except (OSError, NotImplementedError):
            self.skipTest("links cannot be made here")
        for action in (lambda: load_starred_songs(self.paths), lambda: self.save(5, [])):
            with self.assertRaises(StarredSongsError) as caught:
                action()
            self.assertEqual((caught.exception.code, caught.exception.status), ("STARRED_SONGS_UNSAFE", 409))
        self.assertTrue(os.path.islink(self.file))
        self.assertEqual(json.loads(elsewhere.read_text(encoding="utf-8"))["entries"], [entry()])

    def test_a_link_or_a_swapped_file_is_refused_as_the_checks_see_it(self) -> None:
        self.save(1, [entry()])
        real = os.lstat(self.file)
        link = os.stat_result((stat.S_IFLNK | 0o777, *real[1:]))
        with mock.patch.object(worldmedia_starred.os, "lstat", return_value=link):
            with self.assertRaises(StarredSongsError) as caught:
                load_starred_songs(self.paths)
        self.assertEqual(caught.exception.code, "STARRED_SONGS_UNSAFE")
        # A Windows junction or symlink is a reparse point that names another place.
        junction = mock.Mock(wraps=real, st_mode=real.st_mode, st_size=real.st_size, st_ino=real.st_ino,
                             st_dev=real.st_dev, st_reparse_tag=0xA0000003)
        with mock.patch.object(worldmedia_starred.os, "lstat", return_value=junction):
            with self.assertRaises(StarredSongsError) as caught:
                load_starred_songs(self.paths)
        self.assertEqual(caught.exception.code, "STARRED_SONGS_UNSAFE")
        # The file opened is not the one that was checked (swapped in between).
        other = os.stat_result((real.st_mode, real.st_ino + 1, *real[2:]))
        with mock.patch.object(worldmedia_starred.os, "fstat", return_value=other):
            with self.assertRaises(StarredSongsError) as caught:
                load_starred_songs(self.paths)
        self.assertEqual((caught.exception.code, caught.exception.status), ("STARRED_SONGS_UNAVAILABLE", 503))
        self.assertEqual(load_starred_songs(self.paths)["entries"], [entry()])

    def test_clearing_the_song_log_never_touches_starred_songs(self) -> None:
        self.save(1, [entry()])
        save_song_log({"revision": 1, "entries": [{"time": MORNING_MS, "station": "Jazz FM",
                                                   "stationId": "x", "source": "", "title": "Song"}]}, self.paths)
        save_song_log({"revision": 2, "entries": []}, self.paths)
        self.assertEqual(load_song_log(self.paths)["entries"], [])
        self.assertEqual(load_starred_songs(self.paths)["entries"], [entry()])

    def test_never_a_profile_key(self) -> None:
        self.assertFalse(any("starred" in key for key in PROFILE_TRANSFER_KEYS))


class UnsafeTextTests(StarredTestCase):
    UNSAFE = ("\u0085", "\u0080", "\u009f", "\u202a", "\u202e", "\u2066", "\u2069", "\u200e", "\u200f",
              "\u061c", "\u200b", "\u200d", "\u2060", "\ufeff", "\u2028", "\u2029", "\u00ad")

    def test_requests_with_control_or_invisible_characters_are_refused(self) -> None:
        for char in self.UNSAFE:
            for field in ("title", "station", "source", "stationId"):
                with self.subTest(char=hex(ord(char)), field=field):
                    with self.assertRaises(ValueError):
                        normalize_entries([entry(**{field: f"a{char}b"})])
                    with self.assertRaises(StarredSongsError) as caught:
                        export_starred_songs({"format": "csv", "entries": [entry(**{field: f"a{char}b"})]}, self.paths)
                    self.assertEqual(caught.exception.code, "INVALID_STARRED_SONGS")
                    with self.assertRaises(ValueError):
                        self.save(1, [entry(**{field: f"a{char}b"})])
        self.assertFalse(self.file.exists())
        self.assertFalse((self.root / "downloads").exists() and any((self.root / "downloads").iterdir()))

    def test_a_stored_file_with_them_is_cleaned_the_way_the_page_cleans(self) -> None:
        stored = entry(title="Art\u202eist\u0085-\u2028Song\u200b\u061c", station="Jazz\u2066 FM\ufeff",
                       stationId="radio-browser:jazz", source="radio-browser\u00ad")
        self.file.write_text(json.dumps({"version": 1, "revision": 3, "entries": [stored]}), encoding="utf-8")
        loaded = load_starred_songs(self.paths)
        self.assertEqual(loaded["unreadable"], False)
        self.assertEqual(loaded["entries"], [entry(title="Artist - Song", station="Jazz FM")])
        # So nothing of it reaches an export either.
        self.assertEqual(starred_songs_csv(loaded["entries"]).decode("utf-8-sig").splitlines()[1].split(",")[:2],
                         ["Artist - Song", "Jazz FM"])
        self.assertEqual(worldmedia_starred.clean_text("a\ud800b"), "a\ufffdb")


class ExportTests(StarredTestCase):
    def test_csv_has_a_bom_crlf_local_date_and_neutralised_formulas(self) -> None:
        data = starred_songs_csv([entry(), entry(title="=cmd|' /C calc'!A0", station="+Radio")])
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"))
        text = data.decode("utf-8-sig")
        self.assertIn("\r\n", text)
        rows = list(csv.reader(io.StringIO(text, newline="")))
        self.assertEqual(rows[0], ["Song", "Station", "Date starred", "Time starred"])
        self.assertEqual(rows[1], ["Artist - Song", "Jazz FM", "2026-11-19", "08:00:00"])
        self.assertEqual(rows[2][:2], ["'=cmd|' /C calc'!A0", "'+Radio"])

    def test_text_is_one_song_a_line(self) -> None:
        data = starred_songs_text([entry(), entry(title="No station", station="")])
        self.assertEqual(data.decode("utf-8-sig"),
                         "Artist - Song (Jazz FM, 2026-11-19)\r\nNo station (2026-11-19)\r\n")
        self.assertEqual(starred_songs_text([]), "\ufeff".encode("utf-8"))

    def test_writes_a_named_file_into_the_downloads_folder(self) -> None:
        for kind in ("txt", "csv"):
            with self.subTest(kind):
                result = export_starred_songs({"format": kind, "entries": [entry()]}, self.paths, now=NOW)
                self.assertRegex(result["name"], rf"^WorldMedia-starred-songs-20261119-093005(-\d+)?\.{kind}$")
                self.assertEqual(result["count"], 1)
                self.assertTrue((self.paths.downloads_root / result["name"]).is_file())
        leftovers = [p.name for p in self.paths.downloads_root.iterdir() if p.name.endswith(".partial")]
        self.assertEqual(leftovers, [])

    def test_invalid_bodies_write_nothing(self) -> None:
        for body in ({"entries": []}, {"format": "html", "entries": []}, {"format": "txt", "entries": [], "path": "x"},
                     {"format": "csv", "entries": [entry(starred=0)]}):
            with self.subTest(body=str(body)[:40]):
                with self.assertRaises(StarredSongsError) as caught:
                    export_starred_songs(body, self.paths, now=NOW)
                self.assertEqual(caught.exception.code, "INVALID_STARRED_SONGS")
        self.assertFalse(self.paths.downloads_root.exists())


class BackupTests(StarredTestCase):
    def test_the_backup_includes_starred_songs_as_stored(self) -> None:
        self.save(1, [entry()])
        result = create_backup(self.paths, PlaylistStore(self.state / "playlists.json"), now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            stored = archive.read("WorldMediaWindows-data/state/starred-songs.json")
            readme = archive.read("README.txt").decode("utf-8")
        self.assertEqual(stored, self.file.read_bytes())
        self.assertIn("starred-songs.json - the songs you starred", readme)
        self.assertIn("song log and starred songs come back straight away", readme)

    def test_set_aside_files_and_oversized_lists_are_left_out(self) -> None:
        self.file.write_bytes(b"{broken")
        self.save(1, [entry()])
        with mock.patch("worldmedia_backup.MAX_STARRED_FILE_BYTES", 10):
            result = create_backup(self.paths, PlaylistStore(self.state / "playlists.json"), now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            names = archive.namelist()
        self.assertFalse(any("starred" in name for name in names), names)

    def test_no_starred_songs_means_none_in_the_backup(self) -> None:
        result = create_backup(self.paths, PlaylistStore(self.state / "playlists.json"), now=NOW)
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertNotIn("starred-songs.json", " ".join(archive.namelist()))
            self.assertNotIn("starred-songs.json", archive.read("README.txt").decode("utf-8"))


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

    def test_routes_are_validated_like_other_mutating_routes(self) -> None:
        too_large = self.headers(**{"Content-Length": str(MAX_BODY_BYTES + 1)})
        save = json.dumps({"revision": 1, "entries": [entry()]}).encode()
        export = json.dumps({"format": "txt", "entries": [entry()]}).encode()
        for route, good, code in (("/api/v1/starred-songs", save, "INVALID_STARRED_SONGS"),
                                  ("/api/v1/starred-songs/export", export, "INVALID_STARRED_SONGS")):
            cases = [
                (self.headers(**{"X-WorldMedia-Token": ""}), good, 403, "INVALID_TOKEN"),
                (self.headers(Origin="http://evil.example"), good, 403, "INVALID_ORIGIN"),
                (self.headers(**{"Content-Type": "text/plain"}), good, 415, "JSON_REQUIRED"),
                (too_large, b"", 413, "BODY_TOO_LARGE"),
                (self.headers(), b'{"revision":1,"format":"txt","entries":[],"path":"C:/x"}', 400, code),
            ]
            for headers, body, status, expected in cases:
                with self.subTest(route=route, code=expected):
                    response, payload = self.request("POST", route, headers, body)
                    self.assertEqual(response.status, status)
                    self.assertEqual(payload["error"]["code"], expected)
        self.assertFalse((self.paths.state_root / "state" / "starred-songs.json").exists())
        self.assertFalse(self.paths.downloads_root.exists())

    def test_save_load_and_export_through_the_routes(self) -> None:
        get = lambda: self.request("GET", "/api/v1/starred-songs", {"X-WorldMedia-Token": self.token})
        response, payload = self.request("GET", "/api/v1/starred-songs", {"Origin": self.origin})
        self.assertEqual(response.status, 403)
        response, payload = get()
        self.assertEqual(payload["data"], {"entries": [], "revision": 0, "unreadable": False})
        body = json.dumps({"revision": 1, "entries": [entry()]}).encode()
        response, payload = self.request("POST", "/api/v1/starred-songs", self.headers(), body)
        self.assertEqual(payload["data"], {"saved": True, "revision": 1, "count": 1})
        response, payload = get()
        self.assertEqual(payload["data"]["entries"], [entry()])
        response, payload = self.request("POST", "/api/v1/starred-songs", self.headers(), body)
        self.assertEqual(payload["data"]["stale"], True)
        response, payload = self.request("GET", "/api/v1/starred-songs/export", {"X-WorldMedia-Token": self.token})
        self.assertEqual(response.status, 405)
        export = json.dumps({"format": "csv", "entries": [entry()]}).encode()
        response, payload = self.request("POST", "/api/v1/starred-songs/export", self.headers(), export)
        self.assertEqual(response.status, 200)
        self.assertRegex(payload["data"]["name"], r"^WorldMedia-starred-songs-\d{8}-\d{6}\.csv$")
        self.assertNotIn("path", payload["data"])

    def test_a_disk_error_while_saving_is_reported_plainly(self) -> None:
        body = json.dumps({"revision": 1, "entries": [entry()]}).encode()
        with mock.patch.object(worldmedia_starred, "_atomic_write_json", side_effect=OSError("disk full")):
            response, payload = self.request("POST", "/api/v1/starred-songs", self.headers(), body)
        self.assertEqual(response.status, 500)
        self.assertEqual(payload["error"]["code"], "STARRED_SONGS_SAVE_FAILED")


if __name__ == "__main__":
    unittest.main()
