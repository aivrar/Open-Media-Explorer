"""Drive changes and large-library server regressions."""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import worldmedia_computer as computer
import worldmedia_computer_library as library
import worldmedia_server
from tests_python.test_computer_library import wait_for_scan


class ComputerLibraryChangesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.media = self.root / "Media"
        self.media.mkdir()
        self.store = self.new_store()
        self.folder = self.store.add(str(self.media))
        self.scan = self.store.library

    def new_store(self):
        store = computer.ComputerFolders(self.root / "state" / "computer-folders.json")
        self.addCleanup(store.library.shutdown)
        return store

    def track(self, relative, *, recent=False):
        path = self.media / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as output:
            output.setparams((1, 2, 8000, 0, "NONE", ""))
            output.writeframes(bytes(3200))
        if not recent:
            os.utime(path, ns=(1_700_000_000_000_000_000,) * 2)
        return path

    def rescan(self, scanner=None):
        scanner = scanner or self.scan
        self.assertTrue(scanner.start()["scanning"])
        result = wait_for_scan(scanner)
        self.assertIsNone(result["last_error"])
        return result

    def test_offline_at_start_denied_blocked_and_restored_without_reading(self):
        self.track("Old.wav")
        self.rescan()
        before = self.scan.snapshot()["items"]
        disconnected = self.root / "Unplugged"
        self.media.rename(disconnected)
        restarted = self.new_store().library
        self.assertFalse(restarted._loaded)
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot["items"], before)
        self.assertFalse(snapshot["folders"][0]["available"])
        with self.assertLogs(library.__name__, "WARNING") as logs:
            self.rescan(restarted)
        self.assertEqual(len(logs.output), 1)
        disconnected.rename(self.media)
        entered, release = threading.Event(), threading.Event()

        def dead_root(_):
            entered.set()
            release.wait(4)
            return False

        with mock.patch.object(library, "read_tags", wraps=library.read_tags) as tags:
            with mock.patch.object(computer, "_folder_available", side_effect=PermissionError):
                self.rescan(restarted)
                self.assertFalse(restarted.snapshot()["folders"][0]["available"])
            with mock.patch.object(computer, "_folder_available", side_effect=dead_root) as probe, \
                    mock.patch.object(computer, "AVAILABILITY_TIMEOUT", 0.05):
                try:
                    self.rescan(restarted)
                    self.assertTrue(entered.is_set())
                    snapshot = restarted.snapshot()
                    self.assertFalse(snapshot["folders"][0]["available"])
                    self.assertEqual(snapshot["items"], before)
                    self.assertEqual(probe.call_count, 1)
                finally:
                    with restarted.folders._probe_lock:
                        inflight = list(restarted.folders._probes.values())
                    release.set()
                    for result in inflight:
                        result.result(timeout=2)
            self.rescan(restarted)
            snapshot = restarted.snapshot()
            self.assertTrue(snapshot["folders"][0]["available"])
            self.assertEqual(snapshot["items"], before)
            tags.assert_not_called()

    def test_walk_stall_after_root_probe_keeps_rows(self):
        self.track("Album/Track.wav")
        self.rescan()
        before = self.scan.snapshot()["items"]
        entered, release = threading.Event(), threading.Event()
        original = library._files_in_directory

        def stalled(path, cancel):
            if Path(path).name == "Album":
                entered.set()
                release.wait(4)
            return original(path, cancel)

        with mock.patch.object(library, "_DIRECTORY_TIMEOUT", 0.05), \
                mock.patch.object(library, "_files_in_directory", side_effect=stalled):
            try:
                self.rescan()
                self.assertTrue(entered.is_set())
                snapshot = self.scan.snapshot()
                self.assertFalse(snapshot["folders"][0]["available"])
                self.assertEqual(snapshot["items"], before)
            finally:
                with library._ABANDONED_LOCK:
                    workers = list(library._ABANDONED_WALKS)
                release.set()
                for thread in workers:
                    thread.join(2)
        self.rescan()
        self.assertTrue(self.scan.snapshot()["folders"][0]["available"])

    def test_tag_stall_marks_the_root_offline_and_leaves_completed_rows(self):
        self.track("Old.wav")
        self.rescan()
        before = self.scan.snapshot()["items"][0]
        self.track("New.wav")
        entered, release = threading.Event(), threading.Event()

        def stalled(*args, **options):
            entered.set()
            release.wait(4)
            return {"kind": "audio", "title": "Late result"}

        with mock.patch.object(library, "_TAG_STALL_TIMEOUT", 0.05), \
                mock.patch.object(library, "read_tags", side_effect=stalled):
            try:
                self.scan.start()
                status = wait_for_scan(self.scan)
                self.assertEqual(status["last_error"], library._DRIVE_UNRESPONSIVE)
                self.assertTrue(entered.is_set())
                snapshot = self.scan.snapshot()
                self.assertFalse(snapshot["folders"][0]["available"])
                self.assertIn(before, snapshot["items"])
                self.assertEqual(status["files_read"], 0)
            finally:
                with library._ABANDONED_LOCK:
                    workers = list(library._ABANDONED_WORKERS)
                release.set()
                for thread in workers:
                    thread.join(2)
        self.assertEqual(self.rescan()["files_read"], 1)
        self.assertTrue(self.scan.snapshot()["folders"][0]["available"])

    def test_empty_replacement_is_offline_but_deletion_from_same_root_works(self):
        path = self.track("Track.wav")
        self.rescan()
        before = self.scan.snapshot()["items"]
        original = self.root / "Original"
        self.media.rename(original)
        self.media.mkdir()
        restarted = self.new_store().library
        self.rescan(restarted)
        self.rescan(restarted)
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot["items"], before)
        self.assertFalse(snapshot["folders"][0]["available"])
        self.assertTrue(json.loads(restarted.path.read_bytes())["roots"])
        self.media.rmdir()
        original.rename(self.media)
        path.unlink()
        self.rescan(restarted)
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot["items"], [])
        self.assertTrue(snapshot["folders"][0]["available"])

    def test_unique_moves_carry_stars_gain_and_video_duration(self):
        self.track("Album/Track.wav")
        for name in ("Duplicate/Copy.wav", "Other/Copy.wav"):
            self.track(name)
        video = self.media / "Album" / "Movie.mpg"
        video.write_bytes(bytes(1024 * 1024))
        os.utime(video, ns=(1_700_000_000_000_000_000,) * 2)
        self.scan._ffprobe = lambda _: "fake"
        self.scan._runner = lambda *_: {
            "format": {"format_name": "mpeg", "duration": "20"},
            "streams": [{"codec_type": "video", "codec_name": "mpeg2video"}],
        }
        self.rescan()
        before = self.scan.snapshot()
        rows = {row["rel"]: row for row in before["items"]}
        audio, movie, duplicate = (rows[name] for name in ("Album/Track.wav", "Album/Movie.mpg", "Duplicate/Copy.wav"))
        for row in (audio, duplicate):
            self.store.stars.update({"add": [{"id": row["id"], "snap": row}]})
        star = next(row for row in self.store.stars.snapshot()["stars"] if row["id"] == audio["id"])
        self.scan.update_loudness(audio, (audio["size"], audio["mtime"]), 3.5, 0.25, threading.Event())
        self.scan.update_video_duration(movie, (movie["size"], movie["mtime"]), 25, False, indexed=True)
        for name in ("Album", "Duplicate", "Other"):
            (self.media / name).rename(self.media / (name + " New"))
        self.assertEqual(self.rescan()["files_read"], 2)
        updated = self.scan.snapshot()
        rows = {row["rel"]: row for row in updated["items"]}
        new_audio, new_movie = rows["Album New/Track.wav"], rows["Album New/Movie.mpg"]
        pairs = {(audio["id"], new_audio["id"]), (movie["id"], new_movie["id"])}
        self.assertEqual(set(updated["moved"]), pairs)
        delta = self.scan.snapshot(before["revision"], before["generation"])
        self.assertTrue(delta["delta"])
        self.assertEqual(set(delta["moved"]), pairs)
        self.assertEqual(len(delta["removed"]), 4)
        self.assertEqual((new_audio["rg_measured"], new_audio["rg_track_gain"], new_audio["rg_track_peak"]),
                         (True, 3.5, 0.25))
        self.assertEqual((new_movie["duration_validated"], new_movie["duration"]), (True, 25))
        restarted = self.new_store()
        stars = restarted.stars.snapshot()["stars"]
        self.assertEqual({row["id"] for row in stars}, {duplicate["id"], new_audio["id"]})
        self.assertIn({**star, "id": new_audio["id"]}, stars)
        self.assertEqual(restarted.library.snapshot()["moved"], [])

    def test_move_history_keeps_latest_pairs(self):
        with mock.patch.object(library, "_MOVE_LIMIT", 2):
            scan = self.new_store().library
        path = self.track("A/Track.wav")
        self.rescan(scan)
        initial = scan.snapshot()
        ids = [initial["items"][0]["id"]]
        for folder in ("B", "C", "D"):
            replacement = self.media / folder / path.name
            replacement.parent.mkdir()
            path.rename(replacement)
            path = replacement
            self.rescan(scan)
            ids.append(scan.snapshot()["items"][0]["id"])
        pairs = list(zip(ids[1:-1], ids[2:]))
        self.assertEqual(scan.snapshot()["moved"], pairs)
        self.assertEqual(scan.snapshot(initial["revision"], initial["generation"])["moved"], pairs)
        self.assertEqual(self.scan._moves.maxlen, 2000)

    def test_relocation_refuses_overlap_and_keeps_matching_ids_after_restart(self):
        for name in ("One.wav", "Two.wav", "Three.wav", "Four.wav"):
            self.track(name)
        self.rescan()
        before = {item["rel"]: item for item in self.scan.snapshot()["items"]}
        first = before["One.wav"]
        self.store.stars.update({"add": [{"id": first["id"], "snap": first}]})
        self.scan.update_loudness(first, (first["size"], first["mtime"]), 2, 0.1, threading.Event())
        approved = self.root / "Other"
        target = approved / "Target"
        target.mkdir(parents=True)
        (self.media / "One.wav").rename(target / "One.wav")
        with self.assertRaises(computer.FolderMismatch):
            self.store.relocate(self.folder["id"], str(target))
        self.store.add(str(approved))
        (self.media / "Two.wav").rename(target / "Two.wav")
        with self.assertRaisesRegex(ValueError, "overlap"):
            self.store.relocate(self.folder["id"], str(target))
        destination = self.root / "New Location"
        target.rename(destination)
        self.store.relocate(self.folder["id"], str(destination))
        status = wait_for_scan(self.scan)
        self.assertEqual(status["files_read"], 0)
        self.assertEqual(status["counts"]["audio"], 2)
        restarted = self.new_store()
        self.assertEqual(self.rescan(restarted.library)["files_read"], 0)
        rows = {item["rel"]: item for item in restarted.library.snapshot()["items"]}
        self.assertEqual({name: row["id"] for name, row in rows.items()},
                         {name: before[name]["id"] for name in ("One.wav", "Two.wav")})
        self.assertTrue(rows["One.wav"]["rg_measured"])
        self.assertEqual(restarted.stars.snapshot()["stars"][0]["id"], first["id"])
        self.assertEqual(restarted.library.snapshot()["moved"], [])
        self.assertEqual(restarted.saved_folder(self.folder["id"])["path"], str(destination))

        # The former path can be approved for a different collection later.
        self.track("One.wav")
        added = restarted.add(str(self.media))
        self.rescan(restarted.library)
        rows = {(row["folder"], row["rel"]): row for row in restarted.library.snapshot()["items"]}
        self.assertEqual(rows[(self.folder["id"], "One.wav")]["id"], first["id"])
        new_id = rows[(added["id"], "One.wav")]["id"]
        self.assertNotEqual(new_id, first["id"])
        self.rescan(restarted.library)
        self.assertEqual(restarted.library.entry(new_id)["folder"], added["id"])

    def test_recent_file_is_rechecked_and_growing_file_is_not_published(self):
        source = self.track("Track.wav", recent=True)
        first_mtime = source.stat().st_mtime_ns
        with mock.patch.object(library.time, "time_ns", return_value=first_mtime):
            self.rescan()
        [row] = self.scan.snapshot()["items"]
        self.assertTrue(row["settling"])
        restarted = self.new_store().library
        with mock.patch.object(library.time, "time_ns", return_value=first_mtime + 3_000_000_000), \
                mock.patch.object(library, "read_tags", wraps=library.read_tags) as reader:
            self.assertEqual(self.rescan(restarted)["files_read"], 1)
            self.assertEqual(self.rescan(restarted)["files_read"], 0)
        reader.assert_called_once()
        self.assertNotIn("settling", restarted.entry(row["id"]))

        source = self.track("Copy.wav", recent=True)
        original = library.read_tags

        def grow(path, *args, **options):
            result = original(path, *args, **options)
            if Path(path).name == source.name:
                with wave.open(str(source), "wb") as output:
                    output.setparams((1, 2, 8000, 0, "NONE", ""))
                    output.writeframes(bytes(6400))
            return result

        with mock.patch.object(library, "read_tags", side_effect=grow):
            self.rescan(restarted)
        current = {row["rel"]: row for row in restarted.snapshot()["items"]}
        self.assertFalse(current["Copy.wav"]["probed"])
        self.rescan(restarted)
        self.assertTrue(restarted.entry(current["Copy.wav"]["id"])["probed"])


class ComputerLibraryScaleTests(unittest.TestCase):
    def test_50000_rows_save_load_snapshot_and_delta(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = computer.ComputerFolders(root / "computer-folders.json")
            folder = store.add(str(root))
            scan = store.library
            rows = {}
            for i in range(50_000):
                identity = f"{i:024x}"
                rows[identity] = {
                    "id": identity, "folder": folder["id"], "rel": f"Artist {i // 100}/Album {i // 20}/Track {i}.mp3",
                    "kind": "audio", "ext": "mp3", "size": 20_000, "mtime": 1_700_000_000_000_000_000,
                    "probed": True, "duration": 234.5, "artist": f"Artist {i // 100}", "album": f"Album {i // 20}",
                    "title": f"Track {i}", "genre": "Rock", "track": i % 20 + 1, "year": 1990 + i % 30,
                    "acodec": "mp3", "sample_rate": 44100, "channels": 2, "bitrate": 128_000,
                }
            scan.load()
            scan._replace_items(rows)
            start = time.perf_counter()
            scan._save()
            self.assertLess(time.perf_counter() - start, 2.0)

            scan = computer.ComputerFolders(store.path).library
            start = time.perf_counter()
            scan.load()
            self.assertLess(time.perf_counter() - start, 4.5)
            full = scan.snapshot()
            self.assertEqual(full["items"], list(rows.values()))
            self.assertIs(scan.snapshot(), full)

            encode = mock.Mock(wraps=worldmedia_server._encode_computer_library)
            start = time.perf_counter()
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: scan.response_snapshot(None, None, encode), range(8)))
            self.assertLess(time.perf_counter() - start, 3.0)
            encode.assert_called_once()
            self.assertTrue(all(result[1] is results[0][1] for result in results))

            first, second = list(rows)[:2]
            new_rows = {**rows, first: {**rows[first], "title": "New title"}}
            del new_rows[second]
            scan._replace_items(new_rows)
            with mock.patch.object(scan, "_items", wraps=scan._items) as indexed:
                data, wire = scan.response_snapshot(full["revision"], full["generation"], encode)
                self.assertEqual(indexed.get.call_count, 2)
                indexed.values.assert_not_called()
            self.assertIsNone(wire)
            self.assertTrue(data["delta"])
            self.assertEqual(data["removed"], [second])
            self.assertEqual(data["items"], [new_rows[first]])
            encode.assert_called_once()
            scan.response_snapshot(None, None, encode)
            self.assertEqual(encode.call_count, 2)
