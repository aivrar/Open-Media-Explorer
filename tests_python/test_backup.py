from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import worldmedia_backup
import worldmedia_server
from worldmedia_backup import (
    BackupError,
    build_favorite_exports,
    create_backup,
    playlist_export_text,
    safe_export_name,
)
from worldmedia_playlists import PlaylistStore, parse_playlist
from worldmedia_runtime import RuntimePaths

NOW = datetime(2026, 11, 14, 22, 15, 0)
TOKEN = "session-token-" + "Q" * 50
DATA = "WorldMediaWindows-data/state/"


def favorite(**fields) -> dict:
    item = {
        "id": fields.pop("id", "radio-browser:one"), "title": "One FM", "source": "radio-browser",
        "type": "radio", "stream_url": "https://radio.example.org/one.mp3", "download_url": "",
        "thumbnail": "https://radio.example.org/one.png", "description": "",
    }
    item.update(fields)
    return item


class BackupTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        # Cleanups run last-in first-out, so open ZIPs close before this removal.
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
        self.store = PlaylistStore(self.state / "playlists.json")

    def write_profile(self, favorites: list | None = None, **extra: str) -> None:
        values = dict(extra)
        if favorites is not None:
            values["worldmedia.favorites.v1"] = json.dumps(favorites)
        (self.state / "profile-preferences.json").write_text(
            json.dumps({"version": 1, "values": values}, separators=(",", ":")) + "\n", encoding="utf-8",
        )

    def backup(self, **kwargs) -> tuple[dict, zipfile.ZipFile]:
        kwargs.setdefault("now", NOW)
        result = create_backup(self.paths, self.store, **kwargs)
        archive = zipfile.ZipFile(result["path"])
        self.addCleanup(archive.close)
        return result, archive

    def text(self, archive: zipfile.ZipFile, name: str) -> str:
        return archive.read(name).decode("utf-8")

    def download_files(self) -> list[str]:
        folder = self.paths.downloads_root
        return sorted(path.name for path in folder.iterdir()) if folder.exists() else []


class BackupContentsTests(BackupTestCase):
    def test_layout_state_copies_and_summary(self) -> None:
        self.store.import_file({"name": "My TV", "text": "#EXTM3U\n#EXTINF:-1,News\nhttps://tv.example.org/news.m3u8\n",
                                "default_type": "tv"})
        self.store.import_link({"url": "https://radio.example.org/jazz", "name": "Jazz", "kind": "stream",
                                "default_type": "radio"})
        favorites = [
            favorite(),
            favorite(id="iptv-org:tv1", title="TV One", source="iptv-org", type="tv",
                     stream_url="https://tv.example.org/one.m3u8", thumbnail=""),
            favorite(id="nasa:clip", title="Clip", source="nasa", type="video", stream_url="",
                     download_url="https://images.example.org/clip.mp4"),
            favorite(id="internet-archive:x", title="Needs lookup", type="audio", stream_url=""),
        ]
        self.write_profile(favorites, **{"worldmedia.settings.v1": '{"theme":"forest"}',
                                         "worldmedia.volume.v1": "40",
                                         "worldmedia.eq.v1": '{"version":1}'})
        (self.state / "launcher.json").write_text('{"server_port":21345}\n', encoding="utf-8")
        for folder in ("cache", "logs", "webview2_data", "tools"):
            (self.paths.state_root / folder).mkdir()
            (self.paths.state_root / folder / "private.txt").write_text("not user data", encoding="utf-8")

        result, archive = self.backup()

        self.assertEqual(result["name"], "WorldMedia-backup-20261114-221500.zip")
        self.assertEqual(Path(result["path"]).parent, self.paths.downloads_root.resolve())
        self.assertEqual(result["size"], Path(result["path"]).stat().st_size)
        self.assertEqual(result["summary"], {
            "favorites": 4, "favorites_exported": 3, "favorites_skipped": 1, "playlists": 2,
            "playlists_unreadable": False, "export_files": 5,
        })
        self.assertEqual(sorted(archive.namelist()), sorted([
            "README.txt",
            "exports/favorites-radio.m3u8", "exports/favorites-tv.m3u8", "exports/favorites-other.m3u8",
            "exports/My TV.m3u8", "exports/Jazz.m3u8",
            DATA + "playlists.json", DATA + "profile-preferences.json",
        ]))
        self.assertEqual(archive.read(DATA + "playlists.json"), (self.state / "playlists.json").read_bytes())
        self.assertEqual(archive.read(DATA + "profile-preferences.json"),
                         (self.state / "profile-preferences.json").read_bytes())
        self.assertIsNone(archive.testzip())
        readme = self.text(archive, "README.txt")
        self.assertIn("1 favorite has no direct stream address", readme)
        self.assertIn("share this\r\nZIP only with people you trust".lower(), readme.lower())
        self.assertIn("Close World Media", readme)
        self.assertEqual(self.download_files(), [result["name"]])

    def test_favorite_exports_are_extended_m3u_and_parse_with_the_app(self) -> None:
        self.write_profile([
            favorite(),
            favorite(id="radio-browser:two", title="Two, with comma", thumbnail="",
                     stream_url="https://radio.example.org/two"),
            favorite(id="playlist:abc", title="Mine", source="playlist", type="tv", description="Sports",
                     stream_url="https://tv.example.org/sport.m3u8", thumbnail="",
                     _extra={"artworkUrl": "https://tv.example.org/logo.png"}),
        ])
        _, archive = self.backup()
        radio = self.text(archive, "exports/favorites-radio.m3u8")
        self.assertEqual(radio, (
            "#EXTM3U\n"
            '#EXTINF:-1 tvg-logo="https://radio.example.org/one.png" group-title="Radio Browser",One FM\n'
            "https://radio.example.org/one.mp3\n"
            '#EXTINF:-1 group-title="Radio Browser",Two, with comma\n'
            "https://radio.example.org/two\n"
        ))
        parsed = parse_playlist(radio, "radio")["items"]
        self.assertEqual([item["title"] for item in parsed], ["One FM", "Two, with comma"])
        self.assertEqual(parsed[0]["_extra"]["artworkUrl"], "https://radio.example.org/one.png")
        tv = parse_playlist(self.text(archive, "exports/favorites-tv.m3u8"), "tv")["items"]
        self.assertEqual(tv[0]["description"], "Sports")
        self.assertEqual(tv[0]["_extra"]["artworkUrl"], "https://tv.example.org/logo.png")
        self.assertNotIn("exports/favorites-other.m3u8", archive.namelist())

    def test_favorites_without_a_direct_url_are_skipped_and_counted(self) -> None:
        favorites = [
            favorite(stream_url="", download_url=""),
            favorite(id="a", stream_url="/api/v1/media/AAAAAAAAAAAAAAAAAAAAAAAA"),
            favorite(id="b", stream_url="file:///C:/Users/me/song.mp3"),
            favorite(id="c", stream_url="http://192.168.1.10/live"),
            favorite(id="d", stream_url="https://user:pass@radio.example.org/x"),
            favorite(id="e", stream_url=None),
        ]
        files, written, skipped = build_favorite_exports(favorites)
        self.assertEqual((files, written, skipped), ({}, 0, 6))
        self.write_profile(favorites)
        result, archive = self.backup()
        self.assertEqual(result["summary"]["favorites_skipped"], 6)
        self.assertFalse([name for name in archive.namelist() if name.startswith("exports/")])
        self.assertIn("6 favorites have no direct stream address", self.text(archive, "README.txt"))

    def test_line_and_attribute_injection_is_impossible(self) -> None:
        evil = '"\r\n#EXTINF:-1,Injected\r\nhttps://evil.example.org/x\u2028https://evil.example.org/y\x85z'
        favorites = [
            favorite(title=evil, description=evil, source=evil, thumbnail='https://img.example.org/a".png'),
            favorite(id="2", title="Ok", stream_url="https://radio.example.org/a\u2028https://evil.example.org/"),
            favorite(id="3", title="Ok", stream_url="https://radio.example.org/b\nhttps://evil.example.org/"),
            favorite(id="4", title="Bidi \u202eevil", source="playlist", description=evil,
                     stream_url="https://radio.example.org/four.mp3",
                     _extra={"artworkUrl": "https://img.example.org/\u2029x"}, thumbnail=""),
        ]
        one, four = "https://radio.example.org/one.mp3", "https://radio.example.org/four.mp3"
        files, written, skipped = build_favorite_exports(favorites)
        self.assertEqual((written, skipped), (2, 2))
        text = files["favorites-radio.m3u8"]
        self.assertEqual(text.count("\n"), 5)
        for line in text.splitlines():
            self.assertTrue(line.startswith("#EXT") or line in {one, four}, line)
        self.assertNotIn("\u202e", text)
        parsed = parse_playlist(text, "radio")
        self.assertEqual(len(parsed["items"]), 2)
        self.assertEqual(parsed["skipped"], 0)
        self.assertEqual([item["stream_url"] for item in parsed["items"]], [one, four])
        first = parsed["items"][0]
        self.assertEqual(first["_extra"]["artworkUrl"], "")  # The logo with a quote was dropped.
        self.assertTrue(first["description"].startswith("' #EXTINF:-1,Injected https://evil"))
        self.assertTrue(first["title"].startswith('" #EXTINF:-1,Injected'))

    def test_playlist_exports_are_rebuilt_from_accepted_entries_only(self) -> None:
        stored = (
            "#EXTM3U x-tvg-url=\"https://epg.example.org/guide.xml\"\n"
            "#EXTINF:-1 tvg-logo=\"logo.png\" group-title=\"News\" tvg-id=\"n1\",Relative\nlive/one.m3u8\n"
            "#EXTINF:-1,Absolute\n#EXTVLCOPT:http-user-agent=Player/1\n#EXTVLCOPT:http-referrer=https://x.example.org/\n"
            "https://other.example.org/two.m3u8\n"
            "#EXTINF:-1,Local file\nfile:///C:/Users/me/secret.mp4\n"
            "#EXTINF:-1,Private\nhttp://192.168.1.20/cam\n"
            "#EXTINF:-1,Login\nhttps://user:pw@tv.example.org/x\n"
            "#EXT-X-SESSION-DATA:not-allowed\n#KODIPROP:inputstream=adaptive\n#PLAYLIST:Name\n"
            "#EXTINF:-1,Absolute again\nhttps://other.example.org/two.m3u8\n"
            # The same address under the same name is the same channel: dropped.
            "#EXTINF:-1,Absolute\nhttps://other.example.org/two.m3u8\n"
        ).replace("#EXT-X-SESSION-DATA:not-allowed\n", "")  # HLS tags make the app refuse the list.
        data = {"version": 1, "playlists": [
            {"id": "a" * 64, "name": "Online", "text": stored, "default_type": "tv",
             "base_url": "https://lists.example.org/dir/list.m3u"},
            {"id": "b" * 64, "name": "No header", "text": "https://radio.example.org/a.mp3\n", "default_type": "radio"},
        ]}
        stored_file = json.dumps(data).encode("utf-8")
        (self.state / "playlists.json").write_bytes(stored_file)
        _, archive = self.backup()
        online = self.text(archive, "exports/Online.m3u8")
        self.assertEqual(online, (
            "#EXTM3U\n"
            '#EXTINF:-1 tvg-logo="https://lists.example.org/dir/logo.png" group-title="News",Relative\n'
            "https://lists.example.org/dir/live/one.m3u8\n"
            "#EXTINF:-1,Absolute\n"
            "https://other.example.org/two.m3u8\n"
            # Same address, another name: kept as its own channel.
            "#EXTINF:-1,Absolute again\n"
            "https://other.example.org/two.m3u8\n"
        ))
        original = parse_playlist(stored, "tv", "https://lists.example.org/dir/list.m3u")["items"]
        exported = parse_playlist(online, "tv")["items"]
        self.assertEqual([item["stream_url"] for item in exported], [item["stream_url"] for item in original])
        no_header = self.text(archive, "exports/No header.m3u8")
        self.assertEqual(no_header, "#EXTM3U\n#EXTINF:-1,Channel 1\nhttps://radio.example.org/a.mp3\n")
        # The restore copy is the stored file, byte for byte, options and all.
        self.assertEqual(archive.read(DATA + "playlists.json"), stored_file)
        self.assertIn("The exports are cleaned; the state copy below is your data exactly as stored.",
                      self.text(archive, "README.txt"))

    def test_playlist_export_values_cannot_break_lines_or_attributes(self) -> None:
        entry = {"default_type": "tv", "text": (
            '#EXTM3U\n#EXTINF:-1 tvg-logo="https://img.example.org/a.png" group-title="G\u202e\u200f\x85x",'
            'Name "quoted" \u2066x\n'
            "https://tv.example.org/a.m3u8\n"
            "#EXTINF:-1 tvg-logo='https://img.example.org/q\"uote.png' group-title='Say \"hi\"',B\n"
            "https://tv.example.org/b.m3u8\n"
        )}
        text, count = playlist_export_text(entry)
        self.assertEqual(count, 2)
        self.assertEqual(text.count("\n"), 5)
        for line in text.splitlines():
            self.assertTrue(line.startswith("#EXT") or line.startswith("https://tv.example.org/"), line)
        for character in ("\u202e", "\u200f", "\u2066", "\x85"):
            self.assertNotIn(character, text)
        parsed = parse_playlist(text, "tv")["items"]
        self.assertEqual([item["stream_url"] for item in parsed],
                         ["https://tv.example.org/a.m3u8", "https://tv.example.org/b.m3u8"])
        self.assertEqual(parsed[1]["description"], "Say 'hi'")
        self.assertEqual(parsed[1]["_extra"]["artworkUrl"], "")

    def test_a_playlist_with_nothing_exportable_gets_no_file(self) -> None:
        # The app's parser accepts a direction mark in an address; the export does not.
        stored = {"version": 1, "playlists": [
            {"id": "c" * 64, "name": "Odd", "text": "https://tv.example.org/a\u202eb.m3u8\n", "default_type": "tv"},
        ]}
        (self.state / "playlists.json").write_text(json.dumps(stored), encoding="utf-8")
        self.assertEqual(playlist_export_text(stored["playlists"][0]), ("#EXTM3U\n", 0))
        result, archive = self.backup()
        self.assertEqual(result["summary"]["playlists"], 1)
        self.assertEqual(result["summary"]["export_files"], 0)
        self.assertIn(DATA + "playlists.json", archive.namelist())
        self.assertFalse([name for name in archive.namelist() if name.startswith("exports/")])

    def test_export_names_are_windows_safe_and_unique(self) -> None:
        used = {"favorites-radio.m3u8", "favorites-tv.m3u8", "favorites-other.m3u8"}
        names = [safe_export_name(name, used) for name in [
            "CON", "con.txt", "CON .x", "COM\u00b9", "LPT9", "NUL", "aux", "conin$",
            'a<b>c:"d"/e\\f|g?h*', "  ..  ", "", "Favorites-Radio", "News", "news", "NEWS",
            "x" * 500, "x" * 500, "tab\there\nnew\u202eline",
        ]]
        self.assertEqual(names[:8], [
            "_CON.m3u8", "_con.txt.m3u8", "_CON .x.m3u8", "_COM\u00b9.m3u8", "_LPT9.m3u8", "_NUL.m3u8",
            "_aux.m3u8", "_conin$.m3u8",
        ])
        self.assertEqual(names[8], "a_b_c__d__e_f_g_h_.m3u8")
        self.assertEqual(names[9:12], ["playlist.m3u8", "playlist (2).m3u8", "Favorites-Radio (2).m3u8"])
        self.assertEqual(names[12:15], ["News.m3u8", "news (2).m3u8", "NEWS (3).m3u8"])
        self.assertEqual(names[15], "x" * 120 + ".m3u8")
        self.assertEqual(names[16], "x" * 119 + " (2).m3u8")
        self.assertEqual(names[17], "tabherenewline.m3u8")
        self.assertEqual(len({name.casefold() for name in names}), len(names))
        for name in names:
            self.assertFalse(set(name) & set('<>:"/\\|?*'), name)
            self.assertFalse(any(ord(ch) < 32 for ch in name), name)

    def test_export_names_are_bounded_in_utf16_units_without_splitting_pairs(self) -> None:
        def units(text: str) -> int:
            return len(text.encode("utf-16-le")) // 2

        emoji = "\U0001F3B5"  # Two UTF-16 units each.
        used: set[str] = set()
        names = [safe_export_name(name, used) for name in [
            emoji * 300, emoji * 300, emoji * 300, "a" + emoji * 300, "\u00e9" * 300, "\ud83c" + "x" * 10,
        ]]
        for name in names:
            self.assertLessEqual(units(name), worldmedia_backup.MAX_EXPORT_NAME_UNITS, name)
            name.encode("utf-8")  # No lone surrogate: a split pair would fail here.
            self.assertTrue(name.endswith(".m3u8"))
        self.assertEqual(names[0], emoji * 61 + ".m3u8")
        self.assertEqual(names[1], emoji * 59 + " (2).m3u8")
        self.assertEqual(names[2], emoji * 59 + " (3).m3u8")
        self.assertEqual(names[3], "a" + emoji * 61 + ".m3u8")
        self.assertEqual(names[4], "\u00e9" * 120 + ".m3u8")
        self.assertEqual(names[5], "x" * 10 + ".m3u8")
        many = [safe_export_name(emoji * 300, used) for _ in range(150)]
        self.assertEqual(len({name.casefold() for name in many}), 150)
        self.assertTrue(all(units(name) <= worldmedia_backup.MAX_EXPORT_NAME_UNITS for name in many))

    def test_export_names_drop_one_playlist_file_ending(self) -> None:
        used = {"favorites-radio.m3u8", "favorites-tv.m3u8", "favorites-other.m3u8"}
        names = [safe_export_name(name, used) for name in [
            "Listen List.m3u", "Weekend.xspf", "Rock.PLS", "Mix.M3U8", "Chill.m3u ", "Weekend",
            "Twice.m3u.m3u", "notes.txt", "CON.pls", ".m3u", ".xspf", "y" * 500 + ".xspf",
            "Favorites-Radio.m3u",
        ]]
        self.assertEqual(names, [
            "Listen List.m3u8", "Weekend.m3u8", "Rock.m3u8", "Mix.m3u8", "Chill.m3u8", "Weekend (2).m3u8",
            "Twice.m3u.m3u8", "notes.txt.m3u8", "_CON.m3u8", "playlist.m3u8", "playlist (2).m3u8",
            "y" * 120 + ".m3u8", "Favorites-Radio (2).m3u8",
        ])
        for name in names:
            self.assertLessEqual(len(name.encode("utf-16-le")) // 2, worldmedia_backup.MAX_EXPORT_NAME_UNITS)
        self.assertEqual(safe_export_name(None, set()), "playlist.m3u8")

    def test_imported_playlist_names_do_not_get_a_second_ending_in_the_zip(self) -> None:
        for name in ("Listen List.m3u", "Weekend.xspf", "Road Trip.pls", "Live.M3U8"):
            self.store.import_file({"name": name, "text": "https://tv.example.org/a.m3u8\n", "default_type": "tv"})
        _, archive = self.backup()
        exports = sorted(name for name in archive.namelist() if name.startswith("exports/"))
        self.assertEqual(exports, sorted([
            "exports/Listen List.m3u8", "exports/Weekend.m3u8", "exports/Road Trip.m3u8", "exports/Live.m3u8",
        ]))

    def test_playlist_files_in_zip_use_the_safe_names(self) -> None:
        for name in ("CON", "AUX", "favorites-tv", "a/b", "a:b"):
            self.store.import_file({"name": name, "text": "https://tv.example.org/a.m3u8\n", "default_type": "tv"})
        self.write_profile([favorite(type="tv", stream_url="https://tv.example.org/fav.m3u8")])
        _, archive = self.backup()
        exports = sorted(name for name in archive.namelist() if name.startswith("exports/"))
        self.assertEqual(exports, sorted([
            "exports/_CON.m3u8", "exports/_AUX.m3u8", "exports/favorites-tv (2).m3u8",
            "exports/favorites-tv.m3u8", "exports/a_b.m3u8", "exports/a_b (2).m3u8",
        ]))

    def test_job_history_is_stripped_from_the_profile_copy(self) -> None:
        jobs = json.dumps([{"output_path": "C:\\Users\\me\\Music\\song.mp3"}])
        self.write_profile([favorite()], **{"worldmedia.jobs.v1": jobs, "worldmedia.settings.v1": "{}"})
        before = (self.state / "profile-preferences.json").read_bytes()
        _, archive = self.backup()
        copy = json.loads(archive.read(DATA + "profile-preferences.json"))
        self.assertEqual(copy["version"], 1)
        self.assertEqual(sorted(copy["values"]), ["worldmedia.favorites.v1", "worldmedia.settings.v1"])
        self.assertNotIn(b"song.mp3", b"".join(archive.read(name) for name in archive.namelist()))
        self.assertIn("download history was left out", self.text(archive, "README.txt"))
        self.assertEqual((self.state / "profile-preferences.json").read_bytes(), before)

    def test_unreadable_profile_fails_cleanly(self) -> None:
        (self.state / "profile-preferences.json").write_text("{broken", encoding="utf-8")
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_STATE_UNREADABLE")
        self.assertEqual(self.download_files(), [])

    def test_unreadable_playlists_are_copied_but_not_exported(self) -> None:
        (self.state / "playlists.json").write_text('{"version": 9}', encoding="utf-8")
        result, archive = self.backup()
        self.assertTrue(result["summary"]["playlists_unreadable"])
        self.assertEqual(archive.read(DATA + "playlists.json"), b'{"version": 9}')
        self.assertIn("playlists.json could not be read", self.text(archive, "README.txt"))

    def test_empty_data_folder_still_makes_a_readme_only_backup(self) -> None:
        result, archive = self.backup()
        self.assertEqual(archive.namelist(), ["README.txt"])
        self.assertEqual(result["summary"]["favorites"], 0)


class BackupSafetyTests(BackupTestCase):
    def test_only_allow_listed_state_files_are_included(self) -> None:
        self.write_profile([favorite()])
        outside = self.root / "outside-secret.txt"
        outside.write_text("outside", encoding="utf-8")
        (self.state / "launcher.json").write_text('{"server_port":9124}\n', encoding="utf-8")
        (self.state / "notes.txt").write_text("odd file", encoding="utf-8")
        (self.state / ".playlists.json.0123.tmp").write_text("partial", encoding="utf-8")
        (self.state / "folder").mkdir()
        try:
            os.symlink(outside, self.state / "link.json")
        except (OSError, NotImplementedError):
            pass
        _, archive = self.backup()
        state_members = [name for name in archive.namelist() if name.startswith("WorldMediaWindows-data/")]
        self.assertEqual(state_members, [DATA + "profile-preferences.json"])
        blob = b"".join(archive.read(name) for name in archive.namelist())
        self.assertNotIn(b"outside", blob)
        self.assertNotIn(b"odd file", blob)
        self.assertNotIn(b"server_port", blob)

    def test_a_linked_state_file_is_refused(self) -> None:
        outside = self.root / "outside.json"
        outside.write_text('{"version":1,"values":{}}', encoding="utf-8")
        try:
            os.symlink(outside, self.state / "profile-preferences.json")
        except (OSError, NotImplementedError):
            self.skipTest("Creating symbolic links needs Developer Mode on Windows.")
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_STATE_UNSAFE")
        self.assertEqual(self.download_files(), [])

    def test_a_junction_state_folder_is_refused(self) -> None:
        try:
            import _winapi
        except ImportError:
            self.skipTest("Junctions are a Windows feature.")
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "playlists.json").write_text('{"version":1,"playlists":[]}', encoding="utf-8")
        self.state.rmdir()
        _winapi.CreateJunction(str(elsewhere), str(self.state))
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_STATE_UNSAFE")
        self.assertEqual(self.download_files(), [])

    def test_a_folder_in_place_of_a_state_file_is_refused(self) -> None:
        (self.state / "playlists.json").mkdir()
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_STATE_UNSAFE")

    def test_the_session_token_never_reaches_the_zip(self) -> None:
        self.write_profile([favorite()])
        result, archive = self.backup(secrets_to_exclude=(TOKEN,))
        blob = b"".join(archive.read(name) for name in archive.namelist())
        self.assertNotIn(TOKEN.encode(), blob)
        archive.close()
        Path(result["path"]).unlink()
        # Even if it somehow got into saved data, the backup refuses to write it.
        self.write_profile([favorite(title=f"x{TOKEN}x")])
        with self.assertRaises(BackupError) as caught:
            create_backup(self.paths, self.store, secrets_to_exclude=(TOKEN,), now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_SECRET_FOUND")
        self.assertEqual(self.download_files(), [])

    def test_a_failure_while_writing_leaves_no_file(self) -> None:
        self.write_profile([favorite()])
        original = zipfile.ZipFile.writestr
        calls = []

        def failing(archive, info, data, *args, **kwargs):
            calls.append(info)
            if len(calls) == 2:
                raise OSError("disk full")
            return original(archive, info, data, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, "writestr", failing):
            with self.assertRaises(BackupError) as caught:
                create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_WRITE_FAILED")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(self.download_files(), [])

    def test_a_failure_while_publishing_leaves_no_file(self) -> None:
        with mock.patch.object(worldmedia_backup, "_publish", side_effect=PermissionError("locked")):
            with self.assertRaises(BackupError):
                create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(self.download_files(), [])

    def test_too_large_input_is_refused_before_writing(self) -> None:
        self.write_profile([favorite()])
        with mock.patch.object(worldmedia_backup, "MAX_ARCHIVE_INPUT_BYTES", 100):
            with self.assertRaises(BackupError) as caught:
                create_backup(self.paths, self.store, now=NOW)
        self.assertEqual(caught.exception.code, "BACKUP_TOO_LARGE")
        self.assertEqual(self.download_files(), [])

    def test_backups_in_the_same_second_never_overwrite(self) -> None:
        self.write_profile([favorite()])
        first, _ = self.backup()
        before = Path(first["path"]).read_bytes()
        second, _ = self.backup()
        third, _ = self.backup()
        self.assertEqual(
            [first["name"], second["name"], third["name"]],
            ["WorldMedia-backup-20261114-221500.zip", "WorldMedia-backup-20261114-221500-2.zip",
             "WorldMedia-backup-20261114-221500-3.zip"],
        )
        self.assertEqual(Path(first["path"]).read_bytes(), before)
        self.assertEqual(len(self.download_files()), 3)

    def test_backup_does_not_change_state_files(self) -> None:
        self.store.import_file({"name": "L", "text": "https://tv.example.org/a.m3u8\n", "default_type": "tv"})
        self.write_profile([favorite()], **{"worldmedia.jobs.v1": "[]"})
        before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in self.state.iterdir()}
        self.backup()
        after = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in self.state.iterdir()}
        self.assertEqual(before, after)

    def test_a_second_backup_while_one_runs_is_refused(self) -> None:
        self.assertTrue(worldmedia_backup._BACKUP_LOCK.acquire(blocking=False))
        try:
            with self.assertRaises(BackupError) as caught:
                create_backup(self.paths, self.store, now=NOW)
            self.assertEqual(caught.exception.code, "BACKUP_RUNNING")
        finally:
            worldmedia_backup._BACKUP_LOCK.release()

    def test_each_state_file_is_read_once_and_those_bytes_are_what_is_exported(self) -> None:
        self.store.import_file({"name": "Before", "text": "https://tv.example.org/before.m3u8\n", "default_type": "tv"})
        self.write_profile([favorite()])
        reads = []
        original = worldmedia_backup._read_state_file

        def read_then_change(path, limit):
            data = original(path, limit)
            reads.append(path.name)
            if path.name == "playlists.json":
                # The file changes right after the safe read; only the bytes read may be used.
                changed = json.loads(data)
                changed["playlists"][0]["name"] = "After"
                changed["playlists"][0]["text"] = "https://tv.example.org/after.m3u8\n"
                path.write_text(json.dumps(changed), encoding="utf-8")
            return data

        with mock.patch.object(worldmedia_backup, "_read_state_file", read_then_change), \
             mock.patch.object(PlaylistStore, "_read", side_effect=AssertionError("path read again")):
            _, archive = self.backup()
        # Each allow-listed state file is looked at once (a missing one too).
        self.assertEqual(sorted(reads), ["playlists.json", "profile-preferences-extra.json",
                                         "profile-preferences.json", "song-log.json", "starred-songs.json"])
        self.assertEqual(sorted(name for name in archive.namelist() if name.startswith("exports/")),
                         ["exports/Before.m3u8", "exports/favorites-radio.m3u8"])
        self.assertIn("before.m3u8", self.text(archive, "exports/Before.m3u8"))
        self.assertIn(b"before.m3u8", archive.read(DATA + "playlists.json"))

    def test_playlists_are_read_under_the_store_lock(self) -> None:
        self.store.import_file({"name": "L", "text": "https://tv.example.org/a.m3u8\n", "default_type": "tv"})
        seen = []
        original = worldmedia_backup._read_state_file

        def spy(path, limit):
            if path.name == "playlists.json":
                # An RLock owned by another thread cannot be taken without blocking.
                taken = []
                thread = threading.Thread(target=lambda: taken.append(self.store._lock.acquire(blocking=False)))
                thread.start()
                thread.join()
                seen.append(taken[0])
            return original(path, limit)

        with mock.patch.object(worldmedia_backup, "_read_state_file", spy):
            self.backup()
        self.assertEqual(seen, [False])


class BackupRouteTests(unittest.TestCase):
    ROUTE = "/api/v1/backup/create"

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

    def request(self, method: str, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, self.ROUTE, skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None:
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

    def test_route_is_validated_like_other_mutating_routes(self) -> None:
        with mock.patch.object(worldmedia_server, "create_backup") as create:
            cases = [
                (self.headers(**{"X-WorldMedia-Token": ""}), b"{}", 403, "INVALID_TOKEN"),
                (self.headers(**{"X-WorldMedia-Token": "wrong"}), b"{}", 403, "INVALID_TOKEN"),
                (self.headers(Origin=""), b"{}", 403, "ORIGIN_REQUIRED"),
                (self.headers(Origin="http://evil.example"), b"{}", 403, "INVALID_ORIGIN"),
                (self.headers(**{"Content-Type": "text/plain"}), b"{}", 415, "JSON_REQUIRED"),
                (self.headers(), b'{"path":"C:/Windows"}', 400, "UNEXPECTED_FIELDS"),
                (self.headers(), b"[]", 400, "JSON_OBJECT_REQUIRED"),
                (self.headers(), b"{" + b" " * 2048 + b"}", 413, "BODY_TOO_LARGE"),
            ]
            for headers, body, status, code in cases:
                with self.subTest(code=code, body=body[:20]):
                    response, payload = self.request("POST", headers, body)
                    self.assertEqual(response.status, status)
                    self.assertEqual(payload["error"]["code"], code)
            response, payload = self.request("GET", {"X-WorldMedia-Token": self.token})
            self.assertEqual(response.status, 405)
            create.assert_not_called()

    def test_route_returns_the_backup_description(self) -> None:
        data = {"path": "D:\\app\\downloads\\WorldMedia-backup-20261114-221500.zip",
                "name": "WorldMedia-backup-20261114-221500.zip", "size": 1234,
                "summary": {"favorites": 2, "playlists": 1}}
        with mock.patch.object(worldmedia_server, "create_backup", return_value=data) as create:
            response, payload = self.request("POST", self.headers(), b"{}")
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["data"], data)
        create.assert_called_once_with(
            worldmedia_server.RUNTIME_PATHS, worldmedia_server.PLAYLIST_STORE,
            secrets_to_exclude=(worldmedia_server.SESSION_TOKEN,),
        )

    def test_route_reports_backup_errors_plainly(self) -> None:
        error = BackupError("The downloads folder is not available, so no backup was made.",
                            code="DOWNLOADS_NOT_WRITABLE", status=409, retryable=True)
        with mock.patch.object(worldmedia_server, "create_backup", side_effect=error):
            response, payload = self.request("POST", self.headers(), b"{}")
        self.assertEqual(response.status, 409)
        self.assertEqual(payload["error"], {
            "code": "DOWNLOADS_NOT_WRITABLE",
            "message": "The downloads folder is not available, so no backup was made.",
            "retryable": True,
        })


if __name__ == "__main__":
    unittest.main()
