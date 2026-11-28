from __future__ import annotations

import gzip
import hashlib
import http.client
import json
import os
import random
import shutil
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

import worldmedia_computer_library as library
import worldmedia_server
from worldmedia_computer import ComputerFolders
from worldmedia_computer_probe import ProbeError, RetryableProbeError, run_ffprobe


AUDIO = {"streams": [{"codec_type": "audio", "codec_name": "mp3", "duration": "1.0"}]}
VIDEO = {"streams": [{"codec_type": "video", "codec_name": "h264"}]}


def wait_for_scan(scanner):
    deadline = time.monotonic() + 5
    while (status := scanner.status())["scanning"]:
        if time.monotonic() >= deadline:
            raise AssertionError(f"Scan did not finish: {status}")
        threading.Event().wait(0.01)
    return status


class ComputerLibraryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.state = self.root / "state"
        self.media = self.root / "Music"
        self.media.mkdir()
        self.folders = ComputerFolders(self.state / "computer-folders.json")
        self.folder = self.folders.add(str(self.media))
        self.index = self.state / "computer-library.json"

    def make_scanner(self, runner=None, ffprobe=None, **options):
        scanner = library.ComputerLibrary(self.index, self.folders, runner=runner or self.runner,
                                          ffprobe=ffprobe or (lambda refresh: "fake"), **options)
        self.addCleanup(scanner.shutdown)
        return scanner

    def runner(self, executable, path, cancel):
        return VIDEO if Path(path).suffix.lower().removeprefix(".") in library.VIDEO_EXTENSIONS else AUDIO

    @staticmethod
    def age(path):
        stamp = 1_700_000_000_000_000_000
        os.utime(path, ns=(stamp, stamp))

    def create(self, *names: str):
        for name in names:
            target = self.media / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bytes(1024) if target.suffix.lower()[1:] in library.VIDEO_EXTENSIONS else b"a")
            self.age(target)

    def scan(self, scanner):
        self.assertTrue(scanner.start()["scanning"])
        status = wait_for_scan(scanner)
        self.assertEqual(status["phase"], "idle")
        return status

    def test_walk_kinds_skips_links_unicode_and_sidecars(self):
        self.create("歌/03 - Tune.MP3", "歌/cover.PNG", "Film.MKV", "Film.en.srt", "Film.ssa",
                    "Film.fr.vtt", "film.Signs.ass", "Other.srt", "Film.txt", "Film.JPG",
                    "$RECYCLE.BIN/Trash.mp3", "System Volume Information/Trash.mp3", ".ignored/Trash.mp3",
                    "unreadable/Track.wav", "Picture.png", "Text.txt", "._Film.MKV",
                    "@EADir/Track.mp3", "Film 2.srt", "Film..srt", "Filming.srt")
        self.create(*(f"Film.{index:02d}.srt" for index in range(25)))
        real = os.scandir

        def scandir(path):
            if Path(path).name == "unreadable":
                raise PermissionError()
            return real(path)

        scanner = self.make_scanner(ffprobe=lambda refresh: None)
        with mock.patch.object(library.os, "scandir", side_effect=scandir):
            status = self.scan(scanner)
        self.assertEqual(status["counts"], {"audio": 1, "video": 1})
        self.assertEqual(status["skipped"], 6)
        self.assertEqual(status["files_found"], 2)
        self.assertEqual(status["files_to_read"], 2)
        self.assertEqual(status["files_read"], 0)
        self.assertFalse(status["ffprobe"])
        self.assertEqual(status["last_error"], "Tags are waiting for FFmpeg.")
        audio, video = sorted(scanner.snapshot()["items"], key=lambda item: item["kind"])
        self.assertEqual((audio["rel"], audio["title"], audio["track"], audio["album"]),
                         ("歌/03 - Tune.MP3", "Tune", 3, "歌"))
        self.assertEqual(audio["art"], {"file": "歌/cover.PNG"})
        self.assertEqual(video["subs"], ["Film.ssa", *(f"Film.{index:02d}.srt" for index in range(19))])
        self.assertEqual(video["art"], {"file": "Film.JPG"})
        self.assertTrue(all(not item["probed"] for item in (audio, video)))

    def test_duration_estimate_survives_reload_and_scans_until_measured(self):
        self.create("Film.vob")
        (self.media / "Film.vob").write_bytes(bytes(512_000))
        # An old file: a just-written one is re-checked by the next scans for a moment, which
        # would make the rows compared below depend on how long the test takes.
        old = time.time() - 60
        os.utime(self.media / "Film.vob", (old, old))
        scanner = self.make_scanner(ffprobe=lambda refresh: None)
        self.scan(scanner)
        row, = scanner.snapshot()["items"]
        fingerprint = (row["size"], row["mtime"])
        scanner.update_video_duration(row, fingerprint, 70, True)
        reader = self.make_scanner(runner=mock.Mock(return_value=VIDEO))
        saved = reader.entry(row["id"])
        self.assertEqual((saved["duration"], saved["duration_estimated"]), (70, True))
        self.scan(reader)
        fresh = reader.entry(row["id"])
        self.assertTrue(fresh["probed"])
        self.assertEqual((fresh["duration"], fresh["duration_estimated"]), (70, True))
        self.scan(reader)
        self.assertEqual(reader.entry(row["id"]), fresh)
        # A damaged clock can produce a positive, physically implausible duration.
        reader._items[row["id"]] = {**fresh, "probed": False}
        reader._runner.return_value = {**VIDEO, "format": {"duration": "70000"}}
        self.scan(reader)
        self.assertEqual(reader.entry(row["id"]), fresh)
        # A repeat of a single-cell duration cannot replace the packet estimate.
        reader._items[row["id"]] = {**fresh, "retry": True}
        reader._runner.return_value = {**VIDEO, "format": {"format_name": "mpeg", "duration": "32"}}
        self.scan(reader)
        rescanned = reader.entry(row["id"])
        self.assertEqual((rescanned["duration"], rescanned["duration_estimated"]), (70, True))
        # Retry the same file with a probe that now reports a measured length.
        reader._items[row["id"]] = {**rescanned, "retry": True}
        reader._runner.return_value = {**VIDEO, "format": {"format_name": "mpeg", "duration": "65.25"}}
        self.scan(reader)
        self.assertEqual(reader.entry(row["id"])["duration"], 70)
        measured = reader.update_video_duration(row, fingerprint, 65.25, False)
        self.assertEqual(measured["duration"], 65.25)
        self.assertNotIn("duration_estimated", measured)
        measured = reader.update_video_duration(row, fingerprint, 64, False)
        self.assertEqual(reader.entry(row["id"])["duration"], 64)
        self.assertIsNone(reader.update_video_duration(row, (row["size"] + 1, row["mtime"]), 99, True))
        reader._items[row["id"]] = {**measured, "retry": True}
        self.scan(reader)
        self.assertEqual(reader.entry(row["id"]), measured)

    def test_scan_marks_only_short_silent_video(self):
        for name in ("silent.mp4", "audio.mp4", "conflict.mp4"):
            with (self.media / name).open("wb") as handle:
                handle.truncate(1024**2)
        (self.media / "Still.vob").write_bytes(bytes(26 * 1024))
        (self.media / "Large.vob").write_bytes(bytes(5 * 1024**2))

        def runner(executable, path, cancel):
            streams = list(VIDEO["streams"])
            if path.endswith("audio.mp4"):
                streams.append({"codec_type": "audio"})
            if path.endswith("conflict.mp4"):
                streams = [{**streams[0], "duration": "90"}]
            container = {"format_name": "mpeg"} if path.endswith(".vob") else {"duration": ".5"}
            return {"streams": streams, "format": container}

        scanner = self.make_scanner(runner=runner)
        self.scan(scanner)
        rows = {row["rel"]: row for row in scanner.snapshot()["items"]}
        self.assertEqual({name: row.get("error") for name, row in rows.items()},
                         {"audio.mp4": None, "conflict.mp4": None, "Large.vob": None,
                          "silent.mp4": library.TOO_SHORT, "Still.vob": library.TOO_SHORT})
        for name in ("silent.mp4", "Still.vob"):
            scanner._items[rows[name]["id"]].pop("error")
        self.scan(scanner)
        for name in ("silent.mp4", "Still.vob"):
            self.assertEqual(scanner.entry(rows[name]["id"])["error"], library.TOO_SHORT)

    def test_tiny_videos_are_unreadable_including_cached_rows(self):
        self.create("empty.vob", "small.mp4", "valid.mkv")
        for name, size in (("empty.vob", 0), ("small.mp4", 1023)):
            (self.media / name).write_bytes(bytes(size))
        runner = mock.Mock(side_effect=self.runner)
        scanner = self.make_scanner(runner=runner)
        self.scan(scanner)
        rows = {row["rel"]: row for row in scanner.snapshot()["items"]}
        self.assertEqual([Path(call.args[1]).name for call in runner.call_args_list], ["valid.mkv"])
        for name in ("empty.vob", "small.mp4"):
            self.assertEqual(rows[name]["error"], "This file could not be read.")
            self.assertTrue(rows[name]["probed"])
        old = scanner._items[rows["empty.vob"]["id"]]
        old.pop("error")
        old["duration"] = 0
        self.scan(scanner)
        self.assertEqual(scanner.entry(old["id"])["error"], "This file could not be read.")
        self.assertEqual(runner.call_count, 1)

    def test_directory_and_file_links_are_skipped_if_supported(self):
        outside = self.root / "Outside"
        outside.mkdir()
        (outside / "Secret.mp3").touch()
        try:
            (self.media / "Link").symlink_to(outside, target_is_directory=True)
            (self.media / "Secret.mp3").symlink_to(outside / "Secret.mp3")
        except (OSError, NotImplementedError):
            self.skipTest("The current account cannot create symlinks.")
        self.create("Track.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        self.assertEqual([item["rel"] for item in scanner.snapshot()["items"]], ["Track.mp3"])

    @unittest.skipUnless(os.name == "nt", "Directory junctions are Windows-specific.")
    def test_junction_is_skipped_if_supported(self):
        import _winapi

        outside = self.root / "Outside"
        outside.mkdir()
        (outside / "Secret.mp3").touch()
        junction = self.media / "Junction"
        try:
            _winapi.CreateJunction(str(outside), str(junction))
        except OSError:
            self.skipTest("The current account cannot create junctions.")
        self.addCleanup(junction.rmdir)
        self.create("Track.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        self.assertEqual([item["rel"] for item in scanner.snapshot()["items"]], ["Track.mp3"])

    def test_scan_migrates_legacy_root_and_uses_its_saved_location_after_alias_changes(self):
        self.create("Approved.mp3")
        alias = self.root / "Alias"
        try:
            if os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(self.media), str(alias))
            else:
                alias.symlink_to(self.media, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("The current account cannot create directory links.")
        self.folders.remove(self.folder["id"])
        folder = self.folders.add(str(alias))
        legacy = {key: value for key, value in folder.items() if key != "real"}
        self.folders.path.write_text(json.dumps({"version": 1, "folders": [legacy]}), encoding="utf-8")
        scanner = self.make_scanner()

        self.scan(scanner)
        [item] = scanner.snapshot()["items"]
        self.assertEqual(item["rel"], "Approved.mp3")
        self.assertEqual(json.loads(self.folders.path.read_bytes())["folders"], [folder])

        if os.name == "nt":
            alias.rmdir()
        else:
            alias.unlink()
        alias.mkdir()
        (alias / "Unapproved.mp3").touch()
        self.scan(scanner)
        snapshot = scanner.snapshot()
        self.assertEqual(snapshot["items"], [item])
        self.assertEqual(snapshot["folders"], [{"id": folder["id"], "path": str(alias), "available": True}])

        (self.media / "Approved.mp3").unlink()
        self.media.rmdir()
        if os.name == "nt":
            _winapi.CreateJunction(str(alias), str(self.media))
        else:
            self.media.symlink_to(alias, target_is_directory=True)
        self.assertEqual(self.scan(scanner)["skipped"], 1)
        self.assertEqual(scanner.snapshot()["items"], [item])

    def test_long_unicode_path(self):
        prefix = ("歌" * 44 + "/") * 6
        target = Path(library._absolute_disk_path(str(self.media))) / prefix / "01 - 🎵.mp3"
        target.parent.mkdir(parents=True)
        target.touch()
        # Remove this branch via its extended path during cleanup as well.
        for directory in reversed(list(target.parents)[:6]):
            self.addCleanup(directory.rmdir)
        self.addCleanup(target.unlink)
        scanner = self.make_scanner()
        self.scan(scanner)
        [item] = scanner.snapshot()["items"]
        self.assertEqual(item["rel"], prefix + "01 - 🎵.mp3")
        self.assertEqual(item["title"], "🎵")
        self.assertTrue(item["probed"])

    def test_art_order_and_subtitle_extensions(self):
        self.create("Video/Film.mkv", "Audio/Tune.mp3", "Video/Film.EN.SRT", "Video/Film.vtt",
                    "Video/Film.ass", "Video/film.ssa", "Video/Film.eng.forced.srt",
                    "Video/Film.notes.txt", "Video/Fun.srt")
        choices = {
            "Video": ["Film.jpg", "Film.jpeg", "Film.png", "Film.webp", "Film-poster.png",
                      "poster.webp", "folder.jpg", "cover.jpeg", "movie.png"],
            "Audio": ["cover.webp", "folder.jpg", "front.jpeg", "album.png", "ALBUMART-01.jpg", "One.webp"],
        }
        for directory, names in choices.items():
            self.create(*(f"{directory}/{name}" for name in names))
        scanner = self.make_scanner()
        while any(choices.values()):
            self.scan(scanner)
            for item in scanner.snapshot()["items"]:
                directory = item["rel"].split("/")[0]
                names = choices[directory]
                self.assertEqual(item.get("art"), {"file": f"{directory}/{names[0]}"} if names else None)
                if directory == "Video":
                    self.assertEqual(item["subs"], [
                        "Video/Film.ass", "Video/film.ssa", "Video/Film.vtt",
                        "Video/Film.EN.SRT", "Video/Film.eng.forced.srt",
                    ])
            for directory, names in choices.items():
                if names:
                    (self.media / directory / names.pop(0)).unlink()
        self.create("Audio/Two.jpg", "Audio/Three.png", "Video/Unrelated.png")
        self.scan(scanner)
        self.assertTrue(all("art" not in item for item in scanner.snapshot()["items"]))

    def test_change_detection_offline_removed_and_stable_ids(self):
        self.create("A.mp3", "B.mp3", "C.mp3")
        runner = mock.Mock(side_effect=self.runner)
        scanner = self.make_scanner(runner)
        first = self.scan(scanner)
        original = {item["rel"]: item for item in scanner.snapshot()["items"]}
        self.assertEqual(runner.call_count, 3)
        identity = hashlib.sha256(str((self.media / "A.mp3").resolve()).casefold().encode()).hexdigest()[:24]
        self.assertEqual(original["A.mp3"]["id"], identity)
        rebuilt = self.make_scanner()
        self.assertGreater(rebuilt.snapshot()["revision"], first["revision"])
        self.assertEqual(rebuilt.snapshot()["items"], list(original.values()))
        self.assertEqual(self.scan(scanner)["revision"], first["revision"])
        self.assertEqual(runner.call_count, 3)
        fresh = library.ComputerLibrary(self.state / "rebuilt.json", self.folders,
                                        ffprobe=lambda refresh: "fake", runner=self.runner)
        self.addCleanup(fresh.shutdown)
        self.scan(fresh)
        self.assertEqual({item["rel"]: item["id"] for item in fresh.snapshot()["items"]},
                         {rel: item["id"] for rel, item in original.items()})
        (self.media / "B.mp3").write_bytes(b"changed size")
        self.age(self.media / "B.mp3")
        (self.media / "C.mp3").unlink()
        self.scan(scanner)
        self.assertEqual(runner.call_count, 4)
        self.assertEqual(Path(runner.call_args.args[1]).name, "B.mp3")
        items = scanner.snapshot()["items"]
        self.assertEqual({item["rel"] for item in items}, {"A.mp3", "B.mp3"})
        self.assertTrue(all(item["id"] == original[item["rel"]]["id"] for item in items))
        current = (self.media / "A.mp3").stat()
        os.utime(self.media / "A.mp3", ns=(current.st_atime_ns, current.st_mtime_ns + 2_000_000_000))
        self.scan(scanner)
        self.assertEqual(runner.call_count, 5)
        self.assertEqual(Path(runner.call_args.args[1]).name, "A.mp3")
        items = scanner.snapshot()["items"]
        self.media.rename(self.root / "Offline")
        scan = self.scan(scanner)
        self.assertEqual(scan["skipped"], 1)
        self.assertEqual(scanner.snapshot()["items"], items)
        self.assertFalse(scanner.snapshot()["folders"][0]["available"])
        self.assertEqual(runner.call_count, 5)
        self.folders.remove(self.folder["id"])
        self.scan(scanner)
        self.assertEqual(scanner.snapshot()["items"], [])
        self.assertEqual(runner.call_count, 5)

    def test_nested_folders_deduplicate_and_reassign_after_remove(self):
        self.create("Album/03 - Song.mp3", "Album/cover.jpg", "Parent song.mp3")
        nested = self.folders.add(str(self.media / "Album"))
        runner = mock.Mock(side_effect=self.runner)
        scanner = self.make_scanner(runner)
        self.scan(scanner)
        items = {item["rel"]: item for item in scanner.snapshot()["items"]}
        self.assertEqual(len(items), 2)
        item = items["Album/03 - Song.mp3"]
        self.assertEqual(item["folder"], self.folder["id"])
        self.assertEqual(runner.call_count, 2)
        (self.media / "Album" / "cover.jpg").unlink()
        self.create("Album/folder.png")
        scanner.remove_folder(self.folder["id"], self.folders.remove(self.folder["id"]))
        self.assertEqual(wait_for_scan(scanner)["folders_done"], 1)
        [moved] = scanner.snapshot()["items"]
        self.assertEqual(moved, {**item, "rel": "03 - Song.mp3", "folder": nested["id"],
                                 "art": {"file": "folder.png"}})
        self.assertEqual(runner.call_count, 2)

    def test_folder_list_read_failure_leaves_index_untouched(self):
        self.create("Old.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        previous = scanner.snapshot()
        saved = self.index.read_bytes()
        (self.media / "Old.mp3").unlink()
        self.create("New.mp3")
        with mock.patch.object(self.folders, "_read", side_effect=PermissionError), \
                mock.patch.object(scanner, "_save", wraps=scanner._save) as save:
            status = self.scan(scanner)
            save.assert_not_called()
        self.assertEqual(status["last_error"], "The folder list could not be read.")
        self.assertEqual(scanner.snapshot(), previous)
        self.assertEqual(self.index.read_bytes(), saved)
        self.scan(scanner)
        self.assertEqual([item["rel"] for item in scanner.snapshot()["items"]], ["New.mp3"])

    def test_stat_failure_keeps_exact_prior_row(self):
        self.create("Old.mp3", "cover.png")
        scanner = self.make_scanner()
        self.scan(scanner)
        previous = scanner.snapshot()["items"]
        (self.media / "cover.png").unlink()
        self.create("New.mp3")
        real_scandir = os.scandir

        def scandir(path):
            with real_scandir(path) as entries:
                unreadable = []
                for entry in entries:
                    wrapped = mock.Mock(wraps=entry)
                    wrapped.name = entry.name
                    wrapped.stat.side_effect = PermissionError
                    unreadable.append(wrapped)
            result = mock.MagicMock()
            result.__enter__.return_value = iter(unreadable)
            return result

        with mock.patch.object(library.os, "scandir", side_effect=scandir):
            self.assertEqual(self.scan(scanner)["skipped"], 2)
        self.assertEqual(scanner.snapshot()["items"], previous)

    def test_live_nested_walk_wins_over_unavailable_or_unreadable_parent(self):
        self.create("Album/Track.mp3")
        nested = self.folders.add(str(self.media / "Album"))
        scanner = self.make_scanner()
        for operation in ("scandir", "_files_in_directory"):
            with self.subTest(operation=operation):
                self.scan(scanner)
                [old] = scanner.snapshot()["items"]
                self.assertEqual(old["folder"], self.folder["id"])
                (self.media / "Album" / "Track.mp3").write_bytes(bytes(old["size"] + 1))
                target = library.os if operation == "scandir" else library
                original = getattr(target, operation)

                def denied(path, *args):
                    if Path(path).name == self.media.name:
                        raise PermissionError()
                    return original(path, *args)

                with mock.patch.object(target, operation, side_effect=denied):
                    self.assertEqual(self.scan(scanner)["files_read"], 1)
                [item] = scanner.snapshot()["items"]
                self.assertEqual((item["id"], item["folder"], item["rel"]),
                                 (old["id"], nested["id"], "Track.mp3"))
                self.assertEqual(item["size"], old["size"] + 1)
                self.assertTrue(item["probed"])

    def test_remove_queues_reassignment_while_walking(self):
        self.create("Album/Track.mp3")
        nested = self.folders.add(str(self.media / "Album"))
        runner = mock.Mock(side_effect=self.runner)
        scanner = self.make_scanner(runner)
        self.scan(scanner)
        [item] = scanner.snapshot()["items"]
        entered, release = threading.Event(), threading.Event()
        walk = scanner._walk

        def pause(folders):
            entered.set()
            release.wait(5)
            return walk(folders)

        with mock.patch.object(scanner, "_walk", side_effect=pause) as scans:
            scanner.start()
            try:
                self.assertTrue(entered.wait(3))
                scanner.remove_folder(self.folder["id"], self.folders.remove(self.folder["id"]))
                self.assertEqual(scanner.snapshot()["items"], [])
            finally:
                release.set()
            self.assertEqual(wait_for_scan(scanner)["folders_done"], 1)
        self.assertEqual(scans.call_count, 2)
        self.assertEqual(scanner.snapshot()["items"], [{**item, "folder": nested["id"], "rel": "Track.mp3"}])
        self.assertEqual(runner.call_count, 1)

    def test_removed_parent_stays_hidden_when_reassignment_scan_is_cancelled(self):
        self.create("Album/Track.mp3", "Parent video.mkv")
        nested = self.folders.add(str(self.media / "Album"))
        scanner = self.make_scanner()
        self.scan(scanner)
        previous = scanner.snapshot()
        entered, release = threading.Event(), threading.Event()
        walk = scanner._walk

        def pause(folders):
            entered.set()
            release.wait(5)
            return walk(folders)

        with mock.patch.object(scanner, "_walk", side_effect=pause) as scans:
            scanner.start()
            try:
                self.assertTrue(entered.wait(3))
                scanner.remove_folder(self.folder["id"], self.folders.remove(self.folder["id"]))
                cancelling = scanner.cancel()
            finally:
                release.set()
            idle = wait_for_scan(scanner)
        self.assertEqual(scans.call_count, 1)
        for status in (cancelling, idle):
            self.assertEqual(status["counts"], {"audio": 0, "video": 0})
        for current in (scanner, self.make_scanner()):
            snapshot = current.snapshot(since=previous["revision"], gen=previous["generation"])
            self.assertEqual(snapshot["items"], [])
            self.assertEqual([folder["id"] for folder in snapshot["folders"]], [nested["id"]])
            for item in previous["items"]:
                self.assertIsNone(current.entry(item["id"]))
            self.assertEqual(current.status()["counts"], {"audio": 0, "video": 0})

    def test_space_only_tracks_use_all_audio_names_in_each_directory(self):
        self.create("Numbered/01 One.mp3", "Numbered/02 Two.flac", "Numbered/Cover.jpg", "Numbered/Movie.mkv",
                    "Mixed/99 Luftballons.mp3", "Mixed/Song.flac", "Solo/03 Untitled.mp3")
        tool = None
        scanner = self.make_scanner(ffprobe=lambda refresh: tool)
        for tool in (None, "fake"):
            self.scan(scanner)
            audio = {item["rel"]: (item["title"], item.get("track")) for item in scanner.snapshot()["items"]
                     if item["kind"] == "audio"}
            self.assertEqual(audio, {
                "Numbered/01 One.mp3": ("One", 1), "Numbered/02 Two.flac": ("Two", 2),
                "Mixed/99 Luftballons.mp3": ("99 Luftballons", None), "Mixed/Song.flac": ("Song", None),
                "Solo/03 Untitled.mp3": ("03 Untitled", None),
            })
        self.assertEqual(scanner.status()["files_read"], 6)

    def test_missing_tool_then_probe_and_keep_failures_until_changed(self):
        self.create("Success.mp3", "Failure.mp3", "Film.mka", "Film.jpg", "cover.png", "Audio.mp4")
        executable = None

        def runner(tool, path, cancel):
            match Path(path).name:
                case "Failure.mp3":
                    raise ProbeError(path)
                case "Film.mka":
                    return VIDEO
            return AUDIO

        track = mock.Mock(side_effect=runner)
        scanner = self.make_scanner(track, ffprobe=lambda refresh: executable)
        self.assertEqual(self.scan(scanner)["last_error"], "Tags are waiting for FFmpeg.")
        self.assertEqual(track.call_count, 0)
        executable = "fake"
        status = self.scan(scanner)
        self.assertIsNone(status["last_error"])
        self.assertTrue(status["ffprobe"])
        self.assertEqual(status["counts"], {"audio": 3, "video": 1})
        items = {item["rel"]: item for item in scanner.snapshot()["items"]}
        self.assertTrue(items["Failure.mp3"]["probed"])
        self.assertEqual(items["Failure.mp3"]["error"], "This file could not be read.")
        self.assertEqual(items["Film.mka"]["art"], {"file": "Film.jpg"})
        self.assertEqual(items["Audio.mp4"]["art"], {"file": "cover.png"})
        self.scan(scanner)
        self.assertEqual(track.call_count, 4)
        (self.media / "Failure.mp3").write_bytes(b"changed")
        self.scan(scanner)
        self.assertEqual(track.call_count, 5)

    def test_tag_version_refreshes_only_opus_once(self):
        self.create("Track.opus", "Track.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        payload = json.loads(self.index.read_bytes())
        del payload["tags_version"]
        self.index.write_text(json.dumps(payload), encoding="utf-8")
        scanner = self.make_scanner()

        def tag_reader(path, ext, **kwargs):
            self.assertEqual(ext, "opus")
            return {"kind": "audio", "acodec": "opus", "duration": 1, "rg_track_gain": 4.0}

        with mock.patch.object(library, "read_tags", side_effect=tag_reader) as reader:
            self.scan(scanner)
            reader.assert_called_once()
            tagged = next(item for item in scanner.snapshot()["items"] if item["ext"] == "opus")
            self.assertEqual((tagged["duration"], tagged["rg_track_gain"]), (1, 4))
            self.assertEqual(json.loads(self.index.read_bytes())["tags_version"], library.TAGS_VERSION)
            self.scan(self.make_scanner())
            reader.assert_called_once()

    def test_measured_loudness_delta_save_and_file_changes(self):
        self.create("Track.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        snapshot = scanner.snapshot()
        [entry] = snapshot["items"]
        fingerprint = (entry["size"], entry["mtime"])
        cancel = threading.Event()
        self.assertIsNone(scanner.update_loudness(entry, (entry["size"] + 1, entry["mtime"]), 5, 0.1, cancel))
        with mock.patch.object(scanner, "_save", wraps=scanner._save) as save:
            measured = scanner.update_loudness(entry, fingerprint, 5, 0.1, cancel)
            save.assert_not_called()
        self.assertTrue(measured["rg_measured"])
        self.assertEqual(scanner.snapshot(snapshot["revision"], snapshot["generation"])["items"], [measured])
        self.scan(scanner)
        self.assertEqual(scanner.entry(entry["id"]), measured)
        self.assertTrue(scanner.shutdown())
        scanner = self.make_scanner()
        self.assertEqual(scanner.entry(entry["id"]), measured)
        path = self.media / "Track.mp3"
        path.write_bytes(b"new untagged version")
        self.scan(scanner)
        entry = scanner.entry(entry["id"])
        self.assertFalse(entry.keys() & library._MEASURED_FIELDS)
        fingerprint = (entry["size"], entry["mtime"])
        scanner.update_loudness(entry, fingerprint, 5, 0.1, cancel)
        # A tag reread of the same fingerprint takes precedence over a measurement.
        with mock.patch.object(library, "read_tags", return_value={
            "kind": "audio", "acodec": "mp3", "duration": 1, "rg_track_gain": 3.0, "rg_track_peak": 0.3,
        }):
            tagged = scanner.play_properties(entry, str(path), cancel)
            updated = scanner.update_play_entry(entry, str(path), fingerprint, tagged, cancel)
        self.assertEqual((updated["rg_track_gain"], updated["rg_track_peak"]), (3, 0.3))
        self.assertNotIn("rg_measured", updated)

    def test_reads_local_audio_without_ffprobe_and_keeps_waiting_rows(self):
        self.create("Movie.mkv", "Invalid.flac")
        with wave.open(str(self.media / "01 - Local.wav"), "wb") as handle:
            handle.setparams((1, 2, 8000, 0, "NONE", ""))
            handle.writeframes(bytes(3200))
        self.age(self.media / "01 - Local.wav")
        tool = None
        runner = mock.Mock(side_effect=self.runner)
        scanner = self.make_scanner(runner, ffprobe=lambda refresh: tool)
        status = self.scan(scanner)
        self.assertEqual(status["last_error"], "Tags are waiting for FFmpeg.")
        self.assertFalse(status["ffprobe"])
        self.assertEqual((status["files_to_read"], status["files_read"]), (3, 1))
        self.assertEqual(status["counts"], {"audio": 2, "video": 1})
        items = {item["rel"]: item for item in scanner.snapshot()["items"]}
        self.assertTrue(items["01 - Local.wav"]["probed"])
        self.assertEqual(items["01 - Local.wav"]["title"], "Local")
        self.assertFalse(items["Invalid.flac"]["probed"])
        self.assertFalse(items["Movie.mkv"]["probed"])
        runner.assert_not_called()

        tool = "fake"
        with mock.patch.object(library, "read_tags", wraps=library.read_tags) as reader:
            status = self.scan(scanner)
        self.assertIsNone(status["last_error"])
        self.assertEqual((status["files_to_read"], status["files_read"]), (2, 2))
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(reader.call_args.kwargs["rel"], "Invalid.flac")
        self.assertEqual(scanner.entry(items["01 - Local.wav"]["id"]), items["01 - Local.wav"])

    def test_delta_round_trip_across_random_scans_and_folder_changes(self):
        randomizer = random.Random(74)
        scanner = self.make_scanner()
        baseline = scanner.snapshot()
        revision = baseline["revision"]
        entries = {}
        observed_removal = observed_delta = observed_full = False
        other = self.root / "Other"
        other.mkdir()
        (other / "Other.mp3").write_bytes(b"audio")
        second = None

        for step in range(35):
            if step == 7:
                second = self.folders.add(str(other))
                scanner.start(folder_added=True)
            elif step == 19:
                self.folders.remove(second["id"])
                scanner.remove_folder(second["id"])
            else:
                for index in randomizer.sample(range(10), randomizer.randrange(1, 5)):
                    path = self.media / f"Track {index}.mp3"
                    if path.exists() and randomizer.randrange(2):
                        path.unlink()
                    else:
                        path.write_bytes(f"{step}-{index}".encode())
                scanner.start()
                if step % 7 == 1:
                    scanner.cancel()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                update = scanner.snapshot(since=revision, gen=baseline["generation"])
                if update.get("delta"):
                    observed_delta = True
                    observed_removal |= bool(update["removed"])
                    for identity in update["removed"]:
                        entries.pop(identity, None)
                    entries.update((item["id"], item) for item in update["items"])
                elif not update.get("unchanged"):
                    observed_full = True
                    entries = {item["id"]: item for item in update["items"]}
                revision = update["revision"]
                fresh = scanner.snapshot()
                if fresh["revision"] == revision:
                    self.assertEqual(entries, {item["id"]: item for item in fresh["items"]})
                    if "folders" in update:
                        self.assertEqual(update["folders"], fresh["folders"])
                if not scanner.status()["scanning"] and fresh["revision"] == revision:
                    break
                threading.Event().wait(0.001)
            else:
                self.fail("The library did not settle after a scan")
        self.assertTrue(observed_delta and observed_removal and observed_full)

    def test_bounded_journal_and_restart_fall_back_to_full(self):
        scanner = self.make_scanner()
        first_revision = scanner.snapshot()["revision"]
        with mock.patch.object(library, "_JOURNAL_REVISIONS", 2):
            for name in ("One.mp3", "Two.mp3", "Three.mp3"):
                self.create(name)
                self.scan(scanner)
        self.assertEqual(scanner.snapshot(first_revision, scanner.status()["generation"]), scanner.snapshot())
        saved = scanner.snapshot()
        with mock.patch.object(library, "_GENERATION", "after-restart"):
            restarted = self.make_scanner()
        initial = restarted.snapshot()
        self.assertNotEqual(saved["generation"], initial["generation"])
        self.create("Four.mp3")
        self.scan(restarted)
        full = restarted.snapshot()
        gen, revision = full["generation"], full["revision"]
        for since in (initial["revision"], revision):
            self.assertEqual(restarted.snapshot(since, saved["generation"]), full)
            self.assertEqual(restarted.snapshot(since), full)
        self.assertTrue(restarted.snapshot(initial["revision"], gen)["delta"])
        self.assertEqual(restarted.snapshot(revision, gen),
                         {"generation": gen, "revision": revision, "unchanged": True})
        self.assertEqual(restarted.status()["generation"], gen)

    def test_cancel_and_shutdown_abandon_blocked_tag_and_ffprobe_workers(self):
        for stage in ("tag", "ffprobe"):
            with self.subTest(stage=stage):
                self.create(stage + (".wav" if stage == "tag" else ".mkv"))
                release = threading.Event()
                entered = threading.Event()
                threads = []

                def block(*args, **kwargs):
                    threads.append(threading.current_thread())
                    entered.set()
                    release.wait(5)
                    return {"kind": "audio", "title": "Late result"} if stage == "tag" else AUDIO

                def release_threads():
                    release.set()
                    for thread in threads:
                        thread.join(2)

                self.addCleanup(release_threads)
                scanner = self.make_scanner(block if stage == "ffprobe" else None)
                with mock.patch.object(library, "read_tags", side_effect=block if stage == "tag" else None):
                    scanner.start()
                    self.assertTrue(entered.wait(2))
                    mark = time.monotonic()
                    if stage == "tag":
                        scanner.cancel()
                        self.assertFalse(wait_for_scan(scanner)["scanning"])
                    else:
                        self.assertTrue(scanner.shutdown(timeout=2))
                        self.assertFalse(scanner.status()["scanning"])
                self.assertLess(time.monotonic() - mark, 2)
                self.assertTrue(threads[0].daemon and threads[0].is_alive())
                targets = [row for row in scanner.snapshot()["items"] if row["rel"].startswith(stage)]
                self.assertFalse(targets[0]["probed"])
                release_threads()
                self.assertTrue(all(not thread.is_alive() for thread in threads))
                self.assertEqual(scanner.status()["files_read"], 0)
                self.assertFalse(scanner.entry(targets[0]["id"])["probed"])
                (self.media / targets[0]["rel"]).unlink()

    def test_abandoned_workers_limit_scans_until_drives_respond(self):
        self.create(*(f"Track {i}.wav" for i in range(4)))
        release = threading.Event()
        threads = []
        arrived = threading.Condition()

        def read(*args, **kwargs):
            with arrived:
                threads.append(threading.current_thread())
                arrived.notify_all()
            release.wait(10)
            return {"kind": "audio", "title": "Late result"}

        scanner = self.make_scanner()
        try:
            with mock.patch.object(library, "read_tags", side_effect=read):
                for size in (4, 8):
                    scanner.start()
                    with arrived:
                        self.assertTrue(arrived.wait_for(lambda: len(threads) == size, timeout=3))
                    scanner.cancel()
                    self.assertEqual(wait_for_scan(scanner)["files_read"], 0)
                # The worker limit is shared even across two library owners.
                other = self.make_scanner()
                with self.assertLogs(library.__name__, level="WARNING") as log:
                    status = self.scan(other)
                self.assertEqual(status["last_error"],
                                 "A drive is not responding. Tags will be read when it answers.")
                self.assertEqual((status["files_found"], status["files_read"], len(threads)), (4, 0, 8))
                self.assertEqual(len(log.output), 1)
                self.assertRegex(log.output[0], r"files=4 walk=[0-9.]+s tags=0\.000s "
                                                r"in_process=0 ffprobe=0 failed=0 cancelled=False".replace(r'\\', '\\'))
                self.assertNotIn("Track", log.output[0])
        finally:
            release.set()
            for thread in threads:
                thread.join(2)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertFalse(any(row["probed"] for row in scanner.snapshot()["items"]))
        self.assertEqual(scanner.status()["files_read"], 0)
        with mock.patch.object(library, "read_tags", return_value={"kind": "audio", "title": "Ready"}):
            self.assertEqual(self.scan(other)["files_read"], 4)

    def test_ffprobe_process_slots_are_bounded_and_scan_logs_accepted_results(self):
        self.create("Song.wav")
        for i in range(4):
            with (self.media / f"Film {i}.mkv").open("wb") as handle:
                handle.truncate(1024**2)
        release = threading.Event()
        arrived = threading.Condition()
        calls = []

        def run(tool, path, cancel):
            with arrived:
                calls.append(path)
                arrived.notify_all()
            release.wait(4)
            if Path(path).stem.endswith("0"):
                raise ProbeError("Could not read")
            return VIDEO

        scanner = self.make_scanner(run)
        with (mock.patch.object(library, "_MAX_WORKERS", 4),
              mock.patch.object(library, "read_tags", return_value={"kind": "audio", "title": "Song"}),
              self.assertLogs(library.__name__, level="WARNING") as log):
            try:
                scanner.start()
                with arrived:
                    self.assertTrue(arrived.wait_for(lambda: len(calls) >= 3, timeout=3))
                    self.assertFalse(arrived.wait_for(lambda: len(calls) == 4, timeout=0.15))
            finally:
                release.set()
            self.assertEqual(wait_for_scan(scanner)["files_read"], 5)
        self.assertEqual(len(log.output), 1)
        self.assertIn("in_process=1 ffprobe=3 failed=1 cancelled=False", log.output[0])
        self.assertNotIn("Film", log.output[0])

    def test_unreadable_audio_requires_an_audio_stream(self):
        unknown_lengths = {"NoLength.flac": "flac", "NoLength.ogg": "vorbis", "NoLength.wav": "pcm_s16le"}
        self.create("Fake.flac", "NoAudio.mka", *unknown_lengths)
        with (self.media / "Movie.mp4").open("wb") as handle:
            handle.truncate(1024**2)
        (self.media / "Empty.mp3").touch()
        for path in (self.media / "Movie.mp4", self.media / "Empty.mp3"):
            self.age(path)
        responses = {
            "Fake.flac": {"format": {"format_name": "flac", "probe_score": 1},
                          "streams": [{"codec_type": "audio", "codec_name": "flac",
                                       "sample_rate": "0", "channels": 0}]},
            **{name: {"streams": [{"codec_type": "audio", "codec_name": codec}]}
               for name, codec in unknown_lengths.items()},
            "NoAudio.mka": {"format": {"duration": 1}},
            "Movie.mp4": VIDEO,
        }
        scanner = self.make_scanner(lambda tool, path, cancel: responses[Path(path).name])
        self.scan(scanner)
        rows = {item["rel"]: item for item in scanner.snapshot()["items"]}
        self.assertTrue(all(row["probed"] for row in rows.values()))
        self.assertNotIn("error", rows.pop("Movie.mp4"))
        for name in unknown_lengths:
            row = rows.pop(name)
            self.assertNotIn("duration", row)
            self.assertNotIn("error", row)
        self.assertEqual({item["error"] for item in rows.values()}, {"This file could not be read."})
        self.assertEqual(self.scan(scanner)["files_read"], 0)

    @unittest.skipUnless(shutil.which("ffprobe"), "ffprobe is not on PATH")
    def test_rescan_repairs_saved_audio_rows_for_plain_text_files(self):
        names = [f"Not Media/fake.{ext}" for ext in ("flac", "mp3", "wav", "m4a")]
        for name in names:
            path = self.media / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("This is plain text, not a media file.", encoding="utf-8")
            self.age(path)
        first = self.make_scanner()
        self.scan(first)
        first.shutdown()
        saved = json.loads(self.index.read_text(encoding="utf-8"))
        for item in saved["items"]:
            for key in ("acodec", "duration", "error"):
                item.pop(key, None)
            item["container"] = item["ext"]
            if item["ext"] == "flac":
                item["acodec"] = "flac"  # Older FFprobe handling saved this guess as a codec.
        self.index.write_text(json.dumps(saved), encoding="utf-8")

        scanner = self.make_scanner(run_ffprobe, ffprobe=lambda _: shutil.which("ffprobe"))
        self.assertEqual(self.scan(scanner)["files_read"], len(names))
        self.assertEqual(sorted(item["rel"] for item in scanner.snapshot()["items"]), sorted(names))
        for item in scanner.snapshot()["items"]:
            self.assertTrue(item["probed"])
            self.assertEqual(item["error"], "This file could not be read.")
            self.assertNotIn("acodec", item)
        self.assertEqual(self.scan(scanner)["files_read"], 0)

    def test_saved_episode_titles_are_cleaned_on_load(self):
        self.create("Test.Show.S01E01.720p.mkv", "Test.Show.S01E02.Pilot.WEB-DL-[Group].mkv")
        scanner = self.make_scanner()
        self.scan(scanner)
        scanner.shutdown()
        saved = json.loads(self.index.read_text(encoding="utf-8"))
        for item in saved["items"]:
            del item["episode_title"]
        self.index.write_text(json.dumps(saved), encoding="utf-8")

        rows = self.make_scanner().snapshot()["items"]
        self.assertEqual({item["episode"]: item["episode_title"] for item in rows}, {1: "", 2: "Pilot"})

    def test_cancel_during_in_process_read(self):
        self.create("Album/01 First.wav", "Album/02 Slow.wav", "Album/03 Later.wav", "Album/Film.mp4")
        entered = threading.Event()
        calls = []

        def reader(path, ext, *, rel, cancel, **kwargs):
            calls.append(rel)
            if len(calls) == 1:
                return {"kind": "audio", "title": "First"}
            entered.set()
            cancel.wait(3)
            return {"kind": "audio", "title": "Cancelled"}

        runner = mock.Mock(return_value=VIDEO)
        scanner = self.make_scanner(runner)
        with mock.patch.object(library, "_TAG_WORKERS", 1), mock.patch.object(library, "read_tags", reader):
            scanner.start()
            self.assertTrue(entered.wait(3))
            started = time.monotonic()
            self.assertEqual(scanner.cancel()["phase"], "cancelling")
            self.assertTrue(scanner.shutdown(timeout=1))
            self.assertLess(time.monotonic() - started, 1)
        runner.assert_not_called()
        self.assertEqual(calls, ["Album/01 First.wav", "Album/02 Slow.wav"])
        self.assertEqual(scanner.status()["files_read"], 1)
        rows = json.loads(self.index.read_text())["items"]
        self.assertEqual([item["rel"] for item in rows if item["probed"]], ["Album/01 First.wav"])

    def test_reads_whole_folders_in_path_order_with_local_audio_first(self):
        self.create("Zed/02 Song.flac", "Zed/01 Film.mkv", "Alpha/02 Song.flac",
                    "Alpha/01 Film.mkv", "Alpha/03 Needs FFprobe.mp3", "Alpha/04 Song.aiff")
        calls = []

        def reader(path, ext, *, rel, **kwargs):
            calls.append(("local", rel))
            return None if ext == "mp3" else {"kind": "audio", "title": Path(path).stem}

        def runner(tool, path, cancel):
            calls.append(("ffprobe", f"{Path(path).parent.name}/{Path(path).name}"))
            return self.runner(tool, path, cancel)

        scanner = self.make_scanner(runner)
        with (mock.patch.object(library, "_TAG_WORKERS", 1),
              mock.patch.object(library, "_MAX_WORKERS", 1),
              mock.patch.object(library, "read_tags", reader)):
            status = self.scan(scanner)
        self.assertEqual(status["files_read"], 6)
        self.assertEqual(calls, [
            ("local", "Alpha/02 Song.flac"), ("local", "Alpha/03 Needs FFprobe.mp3"),
            ("local", "Alpha/04 Song.aiff"), ("ffprobe", "Alpha/01 Film.mkv"),
            ("ffprobe", "Alpha/03 Needs FFprobe.mp3"), ("local", "Zed/02 Song.flac"), ("ffprobe", "Zed/01 Film.mkv"),
        ])

    def test_soft_probe_failure_retries_once_per_run_and_persists(self):
        self.create("Timeout.mp3", "Launch.mp3")

        def fail(tool, path, cancel):
            message = "FFprobe timed out." if Path(path).name == "Timeout.mp3" else "FFprobe could not run."
            raise RetryableProbeError(message)

        runner = mock.Mock(side_effect=fail)
        with mock.patch.object(library, "run_ffprobe", runner):
            scanner = self.make_scanner(runner)
            self.assertEqual(self.scan(scanner)["files_read"], 2)
            first = {item["rel"]: item for item in scanner.snapshot()["items"]}
            for name, error in [("Timeout.mp3", "FFprobe timed out."), ("Launch.mp3", "FFprobe could not run.")]:
                self.assertEqual((first[name]["retry"], first[name]["probed"], first[name]["error"]),
                                 (True, True, error))
            reloaded = self.make_scanner(runner)
            self.assertEqual(reloaded.snapshot()["items"], list(first.values()))
            self.assertEqual(reloaded.status()["skipped"], 0)

            def recover_launch(tool, path, cancel):
                if Path(path).name == "Launch.mp3":
                    return AUDIO
                return fail(tool, path, cancel)

            runner.side_effect = recover_launch
            for current in (scanner, reloaded):
                self.assertEqual(self.scan(current)["files_read"], 2)
                self.assertEqual(self.scan(current)["files_read"], 0)
                items = {item["rel"]: item for item in current.snapshot()["items"]}
                self.assertNotIn("retry", items["Launch.mp3"])
                self.assertNotIn("error", items["Launch.mp3"])
                self.assertTrue(items["Timeout.mp3"]["retry"])
        self.assertEqual(runner.call_count, 6)

    def test_thread_start_failure_leaves_idle_and_can_restart(self):
        scanner = self.make_scanner()
        with mock.patch.object(library.threading.Thread, "start", side_effect=RuntimeError):
            status = scanner.start()
        self.assertFalse(status["scanning"])
        self.assertEqual(status["phase"], "idle")
        self.assertEqual(status["last_error"], "The library scan could not start.")
        self.assertIsNone(self.scan(scanner)["last_error"])

    def test_unexpected_walk_and_save_errors_leave_idle(self):
        self.create("Track.mp3")
        scanner = self.make_scanner()
        for operation in ("_walk", "_save"):
            with self.subTest(operation=operation), mock.patch.object(scanner, operation, side_effect=ValueError):
                status = self.scan(scanner)
                self.assertFalse(status["scanning"])
                self.assertIsNotNone(status["finished"])
                self.assertEqual(status["last_error"], "The library scan failed.")
        self.assertEqual(self.scan(scanner)["counts"]["audio"], 1)

    def test_cancel_start_order_controls_the_queued_scan(self):
        scanner = self.make_scanner()
        for cancel_again in (False, True):
            with self.subTest(cancel_again=cancel_again):
                entered, release = threading.Event(), threading.Event()
                walk = scanner._walk

                def pause(folders):
                    entered.set()
                    release.wait(5)
                    return walk(folders)

                with mock.patch.object(scanner, "_walk", side_effect=pause) as scans:
                    scanner.start()
                    try:
                        self.assertTrue(entered.wait(3))
                        self.assertEqual(scanner.cancel()["phase"], "cancelling")
                        self.assertEqual(scanner.start()["phase"], "cancelling")
                        self.assertEqual(scanner.start()["phase"], "cancelling")
                        if cancel_again:
                            scanner.cancel()
                    finally:
                        release.set()
                    self.assertEqual(wait_for_scan(scanner)["phase"], "idle")
                self.assertEqual(scans.call_count, 1 if cancel_again else 2)

    def test_cancel_walk_keeps_new_and_unvisited_entries(self):
        self.create("z-last/Old.mp3")
        scanner = self.make_scanner(ffprobe=lambda refresh: None)
        self.scan(scanner)
        self.create("New.mp3")
        original = library._files_in_directory
        entered, release = threading.Event(), threading.Event()

        def pause(path, cancel):
            if Path(path).name == "z-last":
                entered.set()
                release.wait(5)
            return original(path, cancel)

        with mock.patch.object(library, "_files_in_directory", side_effect=pause):
            scanner.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(scanner.start()["phase"], "walking")
                self.assertEqual(scanner.cancel()["phase"], "cancelling")
            finally:
                release.set()
            status = wait_for_scan(scanner)
        self.assertEqual(status["files_found"], 1)
        self.assertEqual({item["rel"] for item in scanner.snapshot()["items"]}, {"New.mp3", "z-last/Old.mp3"})
        self.assertEqual(json.loads(self.index.read_text(encoding="utf-8"))["revision"], status["revision"])

    def test_cancel_reading_and_shutdown_save_completed_work(self):
        self.create(*(f"{index}.mp3" for index in range(8)))
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def runner(executable, path, cancel):
            calls.append(Path(path).name)
            if len(calls) == 1:
                return AUDIO
            entered.set()
            cancel.wait(3)
            release.set()
            return None

        scanner = self.make_scanner(runner)
        with mock.patch.object(library, "_MAX_WORKERS", 1):
            scanner.start()
            self.assertTrue(entered.wait(3))
            self.assertEqual(scanner.status()["phase"], "reading")
            self.assertEqual(scanner.cancel()["phase"], "cancelling")
            self.assertTrue(scanner.shutdown(timeout=2))
        self.assertTrue(release.is_set())
        self.assertEqual(len(calls), 2)
        self.assertEqual(scanner.status()["files_read"], 1)
        self.assertEqual(sum(item["probed"] for item in json.loads(self.index.read_text())["items"]), 1)
        self.assertFalse(scanner.start()["scanning"])

    def test_removal_during_reading_cannot_restore_item(self):
        self.create("Track.mp3")
        entered, release = threading.Event(), threading.Event()

        def runner(executable, path, cancel):
            entered.set()
            release.wait(3)
            return AUDIO

        scanner = self.make_scanner(runner)
        scanner.start()
        try:
            self.assertTrue(entered.wait(3))
            self.folders.remove(self.folder["id"])
            scanner.remove_folder(self.folder["id"])
            self.assertEqual(scanner.snapshot()["items"], [])
        finally:
            release.set()
        self.assertEqual(wait_for_scan(scanner)["counts"], {"audio": 0, "video": 0})
        self.assertEqual(json.loads(self.index.read_text())["items"], [])

    def test_added_folder_queues_a_scan_during_reading(self):
        self.create("Track.mp3")
        entered, release = threading.Event(), threading.Event()

        def runner(executable, path, cancel):
            if Path(path).name == "Track.mp3":
                entered.set()
                release.wait(3)
            return AUDIO

        scanner = self.make_scanner(runner)
        scanner.start()
        try:
            self.assertTrue(entered.wait(3))
            second = self.root / "Second"
            second.mkdir()
            (second / "Added.mp3").touch()
            self.folders.add(str(second))
            self.assertEqual(scanner.start(folder_added=True)["phase"], "reading")
        finally:
            release.set()
        status = wait_for_scan(scanner)
        self.assertEqual(status["folders_done"], 2)
        self.assertEqual(status["counts"], {"audio": 2, "video": 0})
        self.assertEqual(status["files_read"], 1)

    def test_save_cadence_and_atomic_replace_outside_reader_lock(self):
        self.create(*(f"{index}.mp3" for index in range(5)))
        clock = 0
        times = iter((10, 30, 59, 60, 61))
        replaces = []
        replace = os.replace

        def runner(executable, path, cancel):
            nonlocal clock
            clock = next(times)
            return AUDIO

        def checked_replace(source, destination):
            if destination == self.index:
                self.assertEqual(source.parent, destination.parent)
                self.assertNotEqual(source, destination)
                self.assertTrue(scanner._lock.acquire(blocking=False))
                scanner._lock.release()
                data = json.loads(source.read_text())
                replaces.append((clock, sum(item["probed"] for item in data["items"])))
                if len(replaces) > 1:
                    self.assertTrue(destination.is_file())
            replace(source, destination)

        scanner = self.make_scanner(runner, clock=lambda: clock)
        with mock.patch.object(library, "_MAX_WORKERS", 1), \
                mock.patch.object(library.os, "replace", side_effect=checked_replace):
            status = self.scan(scanner)
        self.assertIsNone(status["last_error"])
        self.assertEqual(replaces, [(0, 0), (30, 2), (60, 4), (61, 5)])
        self.assertEqual(list(self.state.glob(".computer-library.json.*.tmp")), [])

    def test_index_loaded_lazily_and_damaged_file_set_aside(self):
        bad = b'{"version":1,"revision":5,"items":{}}'
        scanner = self.make_scanner()
        self.assertFalse(scanner._loaded)
        self.index.write_bytes(bad)
        self.assertEqual(scanner.snapshot()["items"], [])
        self.assertEqual(self.index.read_bytes(), bad)
        self.create("Tune.mp3")
        self.scan(scanner)
        [backup] = self.state.glob("computer-library-unreadable-*.json")
        self.assertEqual(backup.read_bytes(), bad)
        self.assertEqual(json.loads(self.index.read_text())["version"], 2)
        restored = self.make_scanner().snapshot()
        self.assertGreater(restored.pop("revision"), scanner.snapshot()["revision"])
        self.assertEqual(restored, {key: value for key, value in scanner.snapshot().items() if key != "revision"})

    def test_invalid_index_rows_are_skipped_and_counted(self):
        self.create("Good.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        payload = json.loads(self.index.read_bytes())
        [item] = payload["items"]
        bad = {**item, "id": "a" * 24, "rel": "C:/absolute.mp3"}
        payload["items"] = [bad, item, None, item]
        self.index.write_text(json.dumps(payload), encoding="utf-8")
        reloaded = self.make_scanner()
        self.assertEqual(reloaded.snapshot()["items"], [item])
        status = reloaded.status()
        self.assertGreater(status["revision"], payload["revision"])
        self.assertEqual((status["skipped"], status["counts"]), (3, {"audio": 1, "video": 0}))
        self.create("Other.mp3")
        self.scan(reloaded)
        self.assertEqual(list(self.state.glob("computer-library-unreadable-*.json")), [])
        self.assertEqual(len(json.loads(self.index.read_bytes())["items"]), 2)

    def test_invalid_index_numbers_skip_rows(self):
        self.create("Good.mp3")
        scanner = self.make_scanner()
        self.scan(scanner)
        payload = json.loads(self.index.read_bytes())
        [item] = payload["items"]
        good = {**item, "duration": 10_000_000, "size": 2**53 - 1, "cover_stream": 0}
        bad = (
            {"duration": -1}, {"duration": 10_000_001}, {"duration": 10**400},
            {"fps": float("inf")}, {"rg_track_gain": float("nan")}, {"fps": 10**400},
            {"size": -1}, {"size": 2**53}, {"mtime": 10**400},
            {"width": -1}, {"track_total": 2**53},
            {"audio_tracks": [{"index": 10**400, "default": True}]},
            {"chapters": [{"start": 10**400}]},
        )
        payload["items"] = [good] + [{**item, "id": f"{index:024x}", **fields}
                                     for index, fields in enumerate(bad)]
        self.index.write_text(json.dumps(payload), encoding="utf-8")
        reloaded = self.make_scanner()
        self.assertEqual(reloaded.snapshot()["items"], [good])
        self.assertEqual(reloaded.status()["skipped"], len(bad))

    def test_probed_index_round_trips_long_and_odd_tags(self):
        self.create("Fixture.mkv")
        long_tag = "x" * 1022 + " / Live"
        sample = {
            "format": {"tags": {"title": long_tag, "artist": "  \x00AC/DC ▶ \x7f "}},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {"index": 1, "codec_type": "subtitle", "codec_name": "ass",
                 "tags": {"title": r"\\server\Live", "language": long_tag}},
            ],
            "chapters": [{"start_time": "0", "tags": {"title": "https://example.org/Chapter"}}],
        }
        scanner = self.make_scanner(lambda *args: sample)
        self.assertEqual(self.scan(scanner)["files_read"], 1)
        [item] = scanner.snapshot()["items"]
        self.assertEqual(item["title"], "x" * 1022 + " /")
        self.assertEqual(item["artist"], "AC/DC ▶")
        self.assertEqual(item["subtitle_tracks"][0]["title"], r"\\server\Live")
        self.assertEqual(item["subtitle_tracks"][0]["language"], item["title"])
        self.assertEqual(item["chapters"][0]["title"], "https://example.org/Chapter")
        reloaded = self.make_scanner()
        restored = reloaded.snapshot()
        self.assertEqual(restored["items"], scanner.snapshot()["items"])
        self.assertEqual(restored["folders"], scanner.snapshot()["folders"])
        self.assertEqual(reloaded.status()["skipped"], 0)


class ComputerLibraryRouteTests(unittest.TestCase):
    base = "/api/v1/computer"

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.media = root / "Private Media"
        self.media.mkdir()
        (self.media / "Track.mp3").write_bytes(b"mock audio")
        ComputerLibraryTests.age(self.media / "Track.mp3")
        self.store = ComputerFolders(root / "computer-folders.json")
        self.store.library = library.ComputerLibrary(
            root / "computer-library.json", self.store, ffprobe=lambda refresh: "fake",
            runner=lambda tool, path, cancel: {
                **AUDIO, "format": {"filename": path, "tags": {"artist": r"C:\Artist\Live"}}
            },
        )
        self.addCleanup(self.store.library.shutdown)
        self.enterContext(mock.patch.object(worldmedia_server, "COMPUTER_FOLDERS", self.store))
        server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
        self.port = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        _, session, _ = self.request("GET", "/api/v1/session")
        self.token = {"X-WorldMedia-Token": session["data"]["token"]}
        self.mutation = {**self.token, "Origin": f"http://127.0.0.1:{self.port}",
                         "Content-Type": "application/json"}

    def request(self, method, path, headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, headers or {})
            response = connection.getresponse()
            raw = response.read()
            if response.getheader("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return response.status, json.loads(raw), dict(response.getheaders())
        finally:
            connection.close()

    def test_auth_origin_methods_and_validation(self):
        for method, suffix, headers, body, status, code in [
            ("GET", "/status", {}, None, 403, "INVALID_TOKEN"),
            ("GET", "/library?since=0", {}, None, 403, "INVALID_TOKEN"),
            ("GET", "/library", {**self.token, "Origin": "https://evil.example"}, None, 403, "INVALID_ORIGIN"),
            ("POST", "/scan", {**self.mutation, "X-WorldMedia-Token": "wrong"}, {"action": "start"},
             403, "INVALID_TOKEN"),
            ("POST", "/scan", self.token, {"action": "start"}, 403, "ORIGIN_REQUIRED"),
            ("POST", "/scan", self.mutation, {"action": []}, 400, "INVALID_COMPUTER_SCAN"),
            ("POST", "/status", self.mutation, {}, 405, "METHOD_NOT_ALLOWED"),
            ("POST", "/library", self.mutation, {}, 405, "METHOD_NOT_ALLOWED"),
            ("GET", "/scan", self.token, None, 405, "METHOD_NOT_ALLOWED"),
            ("GET", "/library?since=1&since=0", self.token, None, 400, "INVALID_COMPUTER_REVISION"),
            ("GET", "/status?since=0", self.token, None, 400, "QUERY_NOT_ALLOWED"),
        ]:
            with self.subTest(method=method, suffix=suffix, code=code):
                actual, payload, _ = self.request(method, self.base + suffix, headers, body)
                self.assertEqual((actual, payload["error"]["code"]), (status, code))
        self.assertFalse(self.store.library._loaded)

    def test_folder_routes_work_when_index_cannot_open(self):
        self.store.library.path.mkdir()
        status, response, _ = self.request("GET", self.base + "/folders", self.token)
        self.assertEqual((status, response["data"]["folders"]), (200, []))
        status, response, _ = self.request("POST", self.base + "/folders/add", self.mutation, {"path": str(self.media)})
        self.assertEqual(status, 200)
        folder = response["data"]["folder"]
        status, response, _ = self.request("GET", self.base + "/folders", self.token)
        self.assertEqual((status, response["data"]["folders"]), (200, [folder]))
        status, response, _ = self.request("GET", self.base + "/status", self.token)
        self.assertEqual((status, response["data"]["last_error"]), (200, "The library index could not be opened."))
        status, response, _ = self.request("POST", self.base + "/folders/remove", self.mutation, {"id": folder["id"]})
        self.assertEqual((status, response["data"]["folders"]), (200, []))
        status, response, _ = self.request("GET", self.base + "/status", self.token)
        self.assertEqual((status, response["data"]["last_error"]), (200, "The library index could not be opened."))
        status, response, _ = self.request("GET", self.base + "/library", self.token)
        self.assertEqual((status, response["error"]["code"]), (503, "COMPUTER_LIBRARY_UNAVAILABLE"))

    def test_remove_reports_index_save_failure_through_status(self):
        status, response, _ = self.request("POST", self.base + "/folders/add", self.mutation, {"path": str(self.media)})
        self.assertEqual(status, 200)
        folder = response["data"]["folder"]
        wait_for_scan(self.store.library)
        with mock.patch.object(self.store.library, "_save", side_effect=PermissionError):
            status, response, _ = self.request("POST", self.base + "/folders/remove", self.mutation,
                                               {"id": folder["id"]})
        self.assertEqual((status, response["data"]["folders"]), (200, []))
        status, response, _ = self.request("GET", self.base + "/status", self.token)
        self.assertEqual((status, response["data"]["last_error"]), (200, "The library could not be saved."))

    def test_relocate_requires_auth_and_keeps_ids_after_matching_sample(self):
        _, added, _ = self.request("POST", self.base + "/folders/add", self.mutation, {"path": str(self.media)})
        identity = added["data"]["folder"]["id"]
        wait_for_scan(self.store.library)
        [before] = self.store.library.snapshot()["items"]
        destination = self.media.with_name("New Drive")
        destination.mkdir()
        endpoint = self.base + "/folders/relocate"
        request = {"id": identity, "path": str(destination)}
        self.assertEqual(self.request("POST", endpoint, {}, request)[0], 403)
        self.assertEqual(self.request("GET", endpoint, self.token)[0], 405)
        self.assertEqual(self.request("POST", endpoint, self.mutation, {"id": identity})[0], 400)
        code, response, _ = self.request("POST", endpoint, self.mutation, request)
        self.assertEqual(code, 409)
        self.assertEqual(response["error"]["code"], "COMPUTER_FOLDER_MISMATCH")
        self.assertEqual(response["error"]["message"], "That folder does not look like the same collection.")
        self.assertEqual(self.store.saved_folder(identity)["path"], str(self.media))
        (self.media / "Track.mp3").rename(destination / "Track.mp3")
        code, response, _ = self.request("POST", endpoint, self.mutation, request)
        self.assertEqual(code, 200, response)
        self.assertEqual(response["data"]["folder"]["id"], identity)
        self.assertNotIn("real", response["data"]["folder"])
        wait_for_scan(self.store.library)
        self.assertEqual(self.store.library.snapshot()["items"], [before])

    def test_auto_scan_gzip_revision_path_privacy_and_immediate_remove(self):
        status, added, _ = self.request("POST", self.base + "/folders/add", self.mutation, {"path": str(self.media)})
        self.assertEqual(status, 200)
        folder = added["data"]["folder"]
        scan = wait_for_scan(self.store.library)
        self.assertEqual(scan["files_read"], 1)
        status, payload, headers = self.request("GET", self.base + "/library",
                                                {**self.token, "Accept-Encoding": "br, gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertEqual(headers["Vary"], "Accept-Encoding")
        self.assertEqual(headers["X-Request-ID"], payload["request_id"])
        with mock.patch.object(worldmedia_server, "_encode_computer_library", wraps=worldmedia_server._encode_computer_library) as encode:
            for encoding in ("gzip", "identity"):
                _, repeated, repeat_headers = self.request(
                    "GET", self.base + "/library", {**self.token, "Accept-Encoding": encoding})
                self.assertEqual(repeated["data"], payload["data"])
                self.assertEqual(repeated["request_id"], repeat_headers["X-Request-ID"])
                self.assertNotEqual(repeated["request_id"], payload["request_id"])
            encode.assert_not_called()
        data = payload["data"]
        revision, gen = data["revision"], data["generation"]
        self.assertEqual(data.pop("folders"), [{"id": folder["id"], "path": str(self.media), "available": True}])
        [item] = data["items"]
        self.assertEqual(item["rel"], "Track.mp3")
        self.assertNotIn(json.dumps(str(self.media))[1:-1], json.dumps(data))
        self.assertNotIn("filename", item)
        self.assertEqual(item["artist"], r"C:\Artist\Live")
        for query in (f"since={revision}", f"since={revision}&gen=old"):
            status, response, _ = self.request("GET", f"{self.base}/library?{query}", self.token)
            self.assertEqual((status, response["data"]), (200, self.store.library.snapshot()))
        status, response, headers = self.request("GET", f"{self.base}/library?since={revision}&gen={gen}", self.token)
        self.assertEqual((status, response["data"]), (200, {"generation": gen, "revision": revision, "unchanged": True}))
        self.assertNotIn("Content-Encoding", headers)
        _, _, headers = self.request("GET", self.base + "/library", {**self.token, "Accept-Encoding": "gzip;q=0"})
        self.assertNotIn("Content-Encoding", headers)
        status, response, _ = self.request("GET", self.base + "/status", self.token)
        self.assertEqual((status, response["data"]["counts"]), (200, {"audio": 1, "video": 0}))
        self.assertEqual(response["data"]["generation"], gen)
        (self.media / "Track.mp3").unlink()
        (self.media / "Replacement.mp3").write_bytes(b"mock audio")
        self.store.library.start()
        wait_for_scan(self.store.library)
        status, payload, _ = self.request("GET", f"{self.base}/library?gen={gen}&since={revision}", self.token)
        self.assertEqual(status, 200)
        delta = payload["data"]
        self.assertTrue(delta["delta"])
        self.assertEqual(delta["removed"], [item["id"]])
        self.assertEqual([row["rel"] for row in delta["items"]], ["Replacement.mp3"])
        full = self.store.library.snapshot()
        self.assertEqual({k: v for k, v in delta.items() if k not in {"delta", "removed"}}, full)
        for action in ("start", "cancel"):
            status, response, _ = self.request("POST", self.base + "/scan", self.mutation, {"action": action})
            self.assertEqual(status, 200)
            self.assertIn("scanning", response["data"])
        status, _, _ = self.request("POST", self.base + "/folders/remove", self.mutation, {"id": folder["id"]})
        self.assertEqual(status, 200)
        _, response, _ = self.request("GET", f"{self.base}/library?since={revision}", self.token)
        self.assertEqual(response["data"]["items"], [])
        self.assertEqual(response["data"]["folders"], [])


if __name__ == "__main__":
    unittest.main()
