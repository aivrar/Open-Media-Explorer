"""Station pictures from the data folder: matching, scanning, serving, backup."""
from __future__ import annotations

import base64
import hashlib
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
import worldmedia_station_images as station_images
from worldmedia_backup import create_backup
from worldmedia_catalog import _encode_png_rgba
from worldmedia_playlists import PlaylistStore
from worldmedia_runtime import RuntimePaths, load_profile_transfer, save_profile_transfer
from worldmedia_security import ApiError
from worldmedia_station_images import (
    StationImages,
    filename_allowed,
    normalize_station_name,
    picture_id,
    picture_key,
    validated_picture,
)

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "station-image-names.json"
NOW = datetime(2026, 11, 15, 10, 30, 0)
TOKEN = "session-token-" + "Z" * 50


def png(width: int = 2, height: int = 2, shade: int = 0) -> bytes:
    return _encode_png_rgba(width, height, [bytes((shade, 0, 0, 255)) * width] * height)


def jpeg(width: int = 3, height: int = 2) -> bytes:
    frame = (b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
             + b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8\xff\xc0" + (len(frame) + 2).to_bytes(2, "big") + frame + b"\xff\xd9"


def gif(width: int = 4, height: int = 4) -> bytes:
    return b"GIF89a" + width.to_bytes(2, "little") + height.to_bytes(2, "little") + b"\x00\x00\x00;"


def webp(width: int = 5, height: int = 6) -> bytes:
    body = (b"WEBP" + b"VP8X" + (10).to_bytes(4, "little") + b"\x00\x00\x00\x00"
            + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little"))
    return b"RIFF" + len(body).to_bytes(4, "little") + body


SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'


def can_symlink(directory: Path) -> bool:
    target = directory / ".probe-target"
    link = directory / ".probe-link"
    target.write_bytes(b"x")
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        return False
    finally:
        target.unlink(missing_ok=True)
    link.unlink(missing_ok=True)
    return True


def junction(target: Path, link: Path) -> None:
    try:
        import _winapi
    except ImportError:
        raise unittest.SkipTest("Junctions are a Windows feature.")
    _winapi.CreateJunction(str(target), str(link))


class FolderTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state_root = self.root / "WorldMediaWindows-data"
        self.state_root.mkdir()
        self.folder = self.state_root / "station-images"
        self.images = StationImages(self.state_root)

    def put(self, name: str, data: bytes) -> Path:
        self.folder.mkdir(exist_ok=True)
        path = self.folder / name
        path.write_bytes(data)
        return path

    def listing(self) -> dict:
        return self.images.listing()

    def keys(self, listing: dict | None = None) -> list[str]:
        return [entry["key"] for entry in (listing or self.listing())["images"]]

    def reasons(self, listing: dict) -> dict[str, int]:
        return {entry["reason"]: entry["count"] for entry in listing["ignored_reasons"]}


class NormalizationTests(unittest.TestCase):
    def test_the_shared_cases_match_the_page(self) -> None:
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 20)
        for value, expected in cases:
            with self.subTest(value=ascii(value)):
                self.assertEqual(normalize_station_name(value), expected)

    def test_case_spaces_and_forbidden_characters(self) -> None:
        for value in ("Radio Paradise", "radio  paradise", "RADIO PARADISE ", " Radio\tParadise"):
            self.assertEqual(normalize_station_name(value), "radio paradise")
        self.assertEqual(normalize_station_name('Hits: 80s/90s "Live"'), "hits 80s90s live")
        self.assertEqual(normalize_station_name("Radio X..."), "radio x")
        self.assertEqual(normalize_station_name("x" * 1025), "")
        self.assertEqual(normalize_station_name(None), "")

    def test_unicode_forms_match(self) -> None:
        composed = "Caf\u00e9 Radio"
        decomposed = "Cafe\u0301 Radio"
        self.assertEqual(normalize_station_name(composed), normalize_station_name(decomposed))
        self.assertEqual(normalize_station_name("\uff32\uff41\uff44\uff49\uff4f"), "radio")

    def test_picture_key_drops_only_the_extension(self) -> None:
        self.assertEqual(picture_key("Radio Paradise.png"), "radio paradise")
        self.assertEqual(picture_key("Radio.Paradise.jpeg"), "radio.paradise")
        self.assertEqual(picture_key("Radio X..png"), "radio x")
        self.assertEqual(picture_key("noextension"), "")

    def test_file_names_that_are_not_plain_files_are_refused(self) -> None:
        for name in ("CON.png", "con.PNG", "NUL .png", "nul.tar.png", "COM1.jpg", "LPT9.gif",
                     "LPT\u00b9.png", "CONIN$.png", "CONOUT$.webp", "CLOCK$.png",
                     "Radio.png:hidden.png", "a:b.png", "..\\x.png", "../x.png", "dir/x.png",
                     "x.png.", "x.png ", "bell\x07.png", "\u202eevil.png", "", ".", "..",
                     "x" * 252 + ".png"):
            with self.subTest(name=ascii(name)):
                self.assertFalse(filename_allowed(name))
        for name in ("Radio Paradise.png", "CONSOLE Radio.png", "Comet.jpg", "NULL FM.gif",
                     "Caf\u00e9.webp", ".977 Hits.png"):
            with self.subTest(name=ascii(name)):
                self.assertTrue(filename_allowed(name))


class ValidationTests(unittest.TestCase):
    def test_each_raster_type_is_detected_from_its_bytes(self) -> None:
        for data, expected in ((png(), "image/png"), (jpeg(), "image/jpeg"), (gif(), "image/gif"),
                               (webp(), "image/webp")):
            with self.subTest(expected=expected):
                self.assertEqual(validated_picture(data)[1], expected)

    def test_svg_text_and_broken_images_are_refused(self) -> None:
        for data in (SVG, b"hello", b"", png()[:-4], b"\x89PNG\r\n\x1a\n" + b"\x00" * 30, jpeg()[:-2]):
            with self.subTest(data=data[:12]):
                with self.assertRaises(station_images._Refused) as caught:
                    validated_picture(data)
                self.assertEqual(caught.exception.reason, "not_image")


class ScanTests(FolderTestCase):
    def test_a_missing_folder_is_not_an_error_and_is_not_created(self) -> None:
        listing = self.listing()
        self.assertEqual(listing["images"], [])
        self.assertFalse(listing["exists"])
        self.assertEqual(listing["found"], 0)
        self.assertEqual(listing["problem"], "")
        self.assertEqual(listing["folder"], str(self.folder))
        self.assertFalse(self.folder.exists())

    def test_pictures_are_listed_by_normalized_name(self) -> None:
        self.put("Radio Paradise.png", png())
        self.put("KEXP.JPG", jpeg())
        self.put("Tokyo  FM.gif", gif())
        self.put("BBC Radio 1.webp", webp())
        self.put("Jazz.jpeg", jpeg())
        listing = self.listing()
        self.assertEqual(self.keys(listing), ["bbc radio 1", "jazz", "kexp", "radio paradise", "tokyo fm"])
        self.assertEqual(listing["found"], 5)
        self.assertEqual(listing["ignored"], 0)
        for entry in listing["images"]:
            self.assertEqual(entry["id"], picture_id(entry["key"]))
            self.assertRegex(entry["id"], r"^[0-9a-f]{32}$")
            self.assertRegex(entry["v"], r"^[0-9a-f]{12}$")
        self.assertRegex(listing["version"], r"^[0-9a-f]{16}$")

    def test_the_type_comes_from_the_bytes_not_the_extension(self) -> None:
        self.put("Actually JPEG.png", jpeg())
        data, content_type, _ = self.images.read(picture_id("actually jpeg"))
        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(data, jpeg())

    def test_ignored_files_are_counted_with_a_reason(self) -> None:
        self.put("Good.png", png())
        self.put("Huge.png", b"\x00" * (station_images.MAX_FILE_BYTES + 1))
        self.put("Vector.png", SVG)
        self.put("Text.jpg", b"just text")
        self.put("Logo.svg", SVG)
        self.put("Logo.bmp", b"BM")
        self.put("notes.txt", b"hello")
        self.put("desktop.ini", b"[.ShellClassInfo]")
        self.put("Thumbs.db", b"cache")
        (self.folder / "Sub").mkdir()
        (self.folder / "Sub" / "Hidden Station.png").write_bytes(png())
        listing = self.listing()
        self.assertEqual(self.keys(listing), ["good"])
        self.assertEqual(self.reasons(listing), {"too_large": 1, "not_image": 2, "unsupported_type": 3})
        self.assertEqual(listing["ignored"], 6)
        texts = {entry["reason"]: entry["text"] for entry in listing["ignored_reasons"]}
        self.assertEqual(texts, {"too_large": "too large", "not_image": "not a picture",
                                 "unsupported_type": "unsupported type"})

    def test_a_too_large_file_is_never_read(self) -> None:
        self.put("Huge.png", b"\x00" * (station_images.MAX_FILE_BYTES + 1))
        with mock.patch.object(StationImages, "_read_file", side_effect=AssertionError("read")):
            self.assertEqual(self.reasons(self.listing()), {"too_large": 1})

    def test_names_that_normalize_alike_pick_the_first_file_name(self) -> None:
        self.put("Radio Paradise.png", png(shade=1))
        self.put("radio paradise.jpg", jpeg())
        self.put("RADIO  PARADISE.gif", gif())
        listing = self.listing()
        self.assertEqual(self.keys(listing), ["radio paradise"])
        self.assertEqual(self.reasons(listing), {"duplicate": 2})
        # Plain character-code order: "RADIO  PARADISE.gif" < "Radio Paradise.png" < "radio paradise.jpg".
        self.assertEqual(self.images.read(picture_id("radio paradise"))[1], "image/gif")

    def test_an_invalid_file_never_wins_a_name(self) -> None:
        self.put("A Station.png", SVG)
        self.put("a station.jpg", jpeg())
        listing = self.listing()
        self.assertEqual(self.reasons(listing), {"not_image": 1})
        self.assertEqual(self.images.read(picture_id("a station"))[1], "image/jpeg")

    def test_at_most_max_files_are_considered(self) -> None:
        for index in range(5):
            self.put(f"Station {index}.png", png())
        with mock.patch.object(station_images, "MAX_FILES", 3):
            listing = self.listing()
        self.assertEqual(self.keys(listing), ["station 0", "station 1", "station 2"])
        self.assertEqual(self.reasons(listing), {"too_many": 2})

    def test_unchanged_files_are_not_read_again(self) -> None:
        self.put("One.png", png())
        self.put("Two.png", png())
        calls = []
        original = StationImages._check_file

        def spy(instance, name, folder):
            calls.append(name)
            return original(instance, name, folder)

        with mock.patch.object(StationImages, "_check_file", spy):
            first = self.listing()
            self.assertEqual(sorted(calls), ["One.png", "Two.png"])
            calls.clear()
            second = self.listing()
            self.assertEqual(calls, [])
            self.assertEqual(first["version"], second["version"])
            path = self.folder / "Two.png"
            path.write_bytes(png(3, 3))
            os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 5_000_000_000))
            third = self.listing()
        self.assertEqual(calls, ["Two.png"])
        self.assertNotEqual(third["version"], second["version"])

    def test_the_version_follows_the_folder_contents(self) -> None:
        empty = self.listing()["version"]
        self.put("One.png", png())
        added = self.listing()["version"]
        self.put("Broken.png", b"oops")
        broken = self.listing()["version"]
        (self.folder / "One.png").unlink()
        (self.folder / "Broken.png").unlink()
        cleared = self.listing()["version"]
        self.assertEqual(len({empty, added, broken, cleared}), 4)
        self.assertEqual(self.listing()["version"], cleared)

    def test_serving_reuses_the_scan_until_the_folder_changes(self) -> None:
        self.put("One.png", png())
        scans = []
        original = StationImages._scan_locked

        def counting(instance):
            scans.append(1)
            return original(instance)

        with mock.patch.object(StationImages, "_scan_locked", counting):
            self.images.read(picture_id("one"))
            self.images.read(picture_id("one"))
            self.assertEqual(len(scans), 1)
            with self.assertRaises(ApiError):
                self.images.read(picture_id("two"))
            self.assertEqual(len(scans), 1)
            self.put("Two.png", png())
            info = self.folder.stat()
            os.utime(self.folder, ns=(info.st_atime_ns, info.st_mtime_ns + 7_000_000_000))
            self.assertEqual(self.images.read(picture_id("two"))[1], "image/png")
            self.assertEqual(len(scans), 2)

    def test_a_picture_that_turns_bad_after_the_scan_is_not_served(self) -> None:
        path = self.put("One.png", png())
        self.listing()
        path.write_bytes(SVG)
        with self.assertRaises(ApiError) as caught:
            self.images.read(picture_id("one"))
        self.assertEqual(caught.exception.status, 404)
        path.unlink()
        with self.assertRaises(ApiError) as caught:
            self.images.read(picture_id("one"))
        self.assertEqual(caught.exception.code, "STATION_IMAGE_NOT_FOUND")

    def test_served_bytes_carry_a_content_etag(self) -> None:
        path = self.put("One.png", png())
        data, content_type, etag = self.images.read(picture_id("one"))
        self.assertEqual((data, content_type), (png(), "image/png"))
        self.assertRegex(etag, r'^"si-[0-9a-f]{24}"$')
        path.write_bytes(png(4, 4))
        self.assertNotEqual(self.images.read(picture_id("one"))[2], etag)


class RefusalTests(FolderTestCase):
    def test_request_text_is_never_a_path(self) -> None:
        self.put("One.png", png())
        (self.state_root / "secret.png").write_bytes(png())
        self.listing()
        for value in ("../secret.png", "..\\secret.png", str(self.state_root / "secret.png"), "CON",
                      "One.png", "one", "One.png:stream", "", None, 42, "A" * 32, picture_id("one").upper(),
                      picture_id("one") + "0", picture_id("secret")):
            with self.subTest(value=value):
                with self.assertRaises(ApiError) as caught:
                    self.images.read(value)
                self.assertEqual(caught.exception.code, "STATION_IMAGE_NOT_FOUND")

    def test_device_names_and_streams_are_refused_before_the_disk_is_touched(self) -> None:
        self.folder.mkdir()
        folder = os.lstat(self.folder)
        with mock.patch.object(station_images.os, "lstat", side_effect=AssertionError("disk")):
            for name in ("CON.png", "nul.jpg", "One.png:hidden.png", "..", "..\\x.png", "x/../y.png"):
                with self.subTest(name=name):
                    with self.assertRaises(station_images._Refused) as caught:
                        self.images._read_file(name, folder)
                    self.assertEqual(caught.exception.reason, "bad_name")

    def test_an_alternate_data_stream_is_not_a_picture_of_its_own(self) -> None:
        self.put("Radio.png", png())
        try:
            with open(self.folder / "Radio.png:Other Station.png", "wb") as stream:
                stream.write(png())
        except OSError:
            self.skipTest("Alternate data streams need NTFS.")
        self.assertEqual(self.keys(), ["radio"])
        self.assertEqual(self.images.read(picture_id("radio"))[0], png())

    def test_a_linked_picture_is_ignored_and_never_served(self) -> None:
        self.folder.mkdir()
        if not can_symlink(self.folder):
            self.skipTest("Creating symbolic links needs Developer Mode on Windows.")
        outside = self.root / "outside.png"
        outside.write_bytes(png(7, 7))
        os.symlink(outside, self.folder / "Linked.png")
        listing = self.listing()
        self.assertEqual(listing["images"], [])
        self.assertEqual(self.reasons(listing), {"link": 1})
        with self.assertRaises(ApiError):
            self.images.read(picture_id("linked"))

    def test_a_picture_swapped_for_a_link_after_the_scan_is_not_served(self) -> None:
        path = self.put("Swapped.png", png())
        if not can_symlink(self.folder):
            self.skipTest("Creating symbolic links needs Developer Mode on Windows.")
        self.listing()
        outside = self.root / "outside.png"
        outside.write_bytes(png(9, 9))
        path.unlink()
        os.symlink(outside, path)
        with self.assertRaises(ApiError) as caught:
            self.images.read(picture_id("swapped"))
        self.assertEqual(caught.exception.status, 404)

    def test_a_file_replaced_between_check_and_open_is_not_served(self) -> None:
        self.put("Raced.png", png())
        self.listing()
        real_fstat = os.fstat

        def other_file(descriptor):
            info = real_fstat(descriptor)
            return os.stat_result((info.st_mode, info.st_ino + 1, *tuple(info)[2:10]))

        with mock.patch.object(station_images.os, "fstat", other_file):
            with self.assertRaises(ApiError) as caught:
                self.images.read(picture_id("raced"))
        self.assertEqual(caught.exception.status, 404)

    def test_a_junction_folder_is_refused(self) -> None:
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "Outside.png").write_bytes(png())
        junction(elsewhere, self.folder)
        listing = self.listing()
        self.assertEqual(listing["images"], [])
        self.assertIn("link", listing["problem"])
        with self.assertRaises(ApiError):
            self.images.read(picture_id("outside"))
        with self.assertRaises(ApiError) as caught:
            self.images.open_folder(opener=lambda path: None)
        self.assertEqual(caught.exception.code, "STATION_IMAGES_UNSAFE")

    def test_a_folder_swapped_for_a_junction_after_the_scan_is_not_read(self) -> None:
        self.put("Station.png", png())
        stale = self.images._current()
        self.assertIn(picture_id("station"), stale.pictures)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "Station.png").write_bytes(png(8, 8))
        self.folder.rename(self.root / "moved-away")
        junction(elsewhere, self.folder)
        # Even if the old scan were still used, the folder check stops the read.
        with mock.patch.object(StationImages, "_current", return_value=stale):
            with self.assertRaises(ApiError) as caught:
                self.images.read(picture_id("station"))
        self.assertEqual(caught.exception.code, "STATION_IMAGES_UNSAFE")
        with self.assertRaises(ApiError):
            self.images.read(picture_id("station"))

    def test_a_folder_swapped_while_a_file_is_read_is_refused(self) -> None:
        self.put("Station.png", png())
        self.listing()
        folder = os.lstat(self.folder)
        moved = os.stat_result((folder.st_mode, folder.st_ino + 1, *tuple(folder)[2:10]))
        with mock.patch.object(StationImages, "_folder_info", side_effect=[folder, moved]):
            with self.assertRaises(ApiError) as caught:
                self.images.read(picture_id("station"))
        self.assertEqual(caught.exception.status, 404)

    def test_a_file_in_place_of_the_folder_is_refused(self) -> None:
        self.folder.write_bytes(png())
        listing = self.listing()
        self.assertTrue(listing["problem"])
        self.assertEqual(listing["images"], [])

    def test_open_folder_creates_it_and_opens_only_that_path(self) -> None:
        opened = []
        path = self.images.open_folder(opener=opened.append)
        self.assertEqual(path, str(self.folder))
        self.assertEqual(opened, [str(self.folder)])
        self.assertTrue(self.folder.is_dir())
        # A second time it is simply opened again.
        self.assertEqual(self.images.open_folder(opener=opened.append), str(self.folder))
        with self.assertRaises(ApiError) as caught:
            self.images.open_folder(opener=mock.Mock(side_effect=OSError("no shell")))
        self.assertEqual(caught.exception.code, "OPEN_FOLDER_FAILED")


class BackupTests(FolderTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.paths = RuntimePaths(
            portable_root=self.root, state_root=self.state_root,
            downloads_root=self.root / "downloads", tools_root=self.root / "tools" / "ffmpeg",
        )
        (self.state_root / "state").mkdir()
        self.store = PlaylistStore(self.state_root / "state" / "playlists.json")

    def backup(self, **kwargs) -> tuple[dict, zipfile.ZipFile]:
        kwargs.setdefault("now", NOW)
        result = create_backup(self.paths, self.store, **kwargs)
        archive = zipfile.ZipFile(result["path"])
        self.addCleanup(archive.close)
        return result, archive

    def test_favorite_pictures_and_legacy_owners_survive_backup_restore(self) -> None:
        radio = {"id": "radio:news", "title": "Renamed", "type": "radio",
                 "stream_url": "https://example.org/radio"}
        tv = {"id": "tv:news", "title": "Local News", "type": "tv",
              "stream_url": "https://example.org/tv"}
        owner_key = "worldmedia.stationimageowners.v1"
        owners = json.dumps({"version": 1, "owners": {"local news": [radio["id"]]}, "hidden": []})
        save_profile_transfer({"worldmedia.favorites.v1": json.dumps([radio, tv]), owner_key: owners}, self.paths)
        self.put("Local News.png", png())
        saved = self.images.save(radio["title"], png(3, 3), station_id=radio["id"])
        _, archive = self.backup()

        prefix = self.state_root.name + "/"
        restored = self.root / "restore"
        for member in archive.namelist():
            if member.startswith(prefix):
                path = restored / member
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(member))
        restored_root = restored / self.state_root.name
        paths = RuntimePaths(portable_root=restored, state_root=restored_root,
                             downloads_root=restored / "downloads", tools_root=restored / "tools")
        values = load_profile_transfer(paths)
        self.assertEqual(json.loads(values["worldmedia.favorites.v1"]), [radio, tv])
        self.assertEqual(values[owner_key], owners)
        legacy = json.loads((restored_root / "state" / "profile-preferences.json").read_text(encoding="utf-8"))
        self.assertNotIn(owner_key, legacy["values"])
        images = StationImages(restored_root)
        self.assertEqual(images.read(saved["id"])[0], png(3, 3))
        self.assertEqual(images.read(picture_id("local news"))[0], png())

    def test_pictures_in_use_are_copied_and_described(self) -> None:
        self.put("Radio Paradise.png", png())
        self.put("KEXP.jpg", jpeg())
        self.put("radio paradise.gif", gif())  # loses to "Radio Paradise.png"
        self.put("Vector.png", SVG)
        self.put("notes.txt", b"private notes")
        (self.folder / "Sub").mkdir()
        (self.folder / "Sub" / "Deep.png").write_bytes(png())
        result, archive = self.backup(secrets_to_exclude=(TOKEN,))
        prefix = "WorldMediaWindows-data/station-images/"
        self.assertEqual(sorted(name for name in archive.namelist() if name.startswith(prefix)),
                         [prefix + "KEXP.jpg", prefix + "Radio Paradise.png"])
        self.assertEqual(archive.read(prefix + "Radio Paradise.png"), png())
        self.assertEqual(result["summary"]["station_images"], 2)
        self.assertEqual(result["summary"]["station_images_left_out"], 0)
        readme = archive.read("README.txt").decode("utf-8")
        self.assertIn("WorldMediaWindows-data\\station-images\\", readme)
        self.assertIn("Your own station pictures (2 pictures)", readme)
        blob = b"".join(archive.read(name) for name in archive.namelist())
        self.assertNotIn(b"private notes", blob)
        self.assertNotIn(b"<svg", blob)
        self.assertNotIn(TOKEN.encode(), blob)

    def test_no_folder_changes_nothing(self) -> None:
        result, archive = self.backup()
        self.assertEqual(archive.namelist(), ["README.txt"])
        self.assertNotIn("station_images", result["summary"])
        self.assertNotIn("station-images", archive.read("README.txt").decode("utf-8"))

    def test_pictures_that_do_not_fit_are_left_out_and_the_readme_says_so(self) -> None:
        self.put("A.png", png(30, 30))
        self.put("B.png", png(40, 40))
        self.put("C.png", png(2, 2))
        room = len(png(30, 30)) + len(png(2, 2)) + 10
        limit = worldmedia_backup.README_RESERVE_BYTES + room
        with mock.patch.object(worldmedia_backup, "MAX_ARCHIVE_INPUT_BYTES", limit):
            result, archive = self.backup()
        prefix = "WorldMediaWindows-data/station-images/"
        self.assertEqual(sorted(name for name in archive.namelist() if name.startswith(prefix)),
                         [prefix + "A.png", prefix + "C.png"])
        self.assertEqual(result["summary"]["station_images_left_out"], 1)
        readme = archive.read("README.txt").decode("utf-8")
        self.assertIn("1 picture did not fit in this backup", readme)
        self.assertLessEqual(sum(info.file_size for info in archive.infolist()), limit)

    def test_a_linked_folder_is_left_out_without_stopping_the_backup(self) -> None:
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "Outside.png").write_bytes(png())
        junction(elsewhere, self.folder)
        result, archive = self.backup()
        self.assertFalse(any("station-images/" in name for name in archive.namelist()))
        self.assertIn("Station pictures were left out.", archive.read("README.txt").decode("utf-8"))
        self.assertNotIn("station_images", result["summary"])

    def test_a_linked_picture_is_not_followed(self) -> None:
        self.put("Real.png", png())
        if not can_symlink(self.folder):
            self.skipTest("Creating symbolic links needs Developer Mode on Windows.")
        outside = self.root / "outside.png"
        outside.write_bytes(png(6, 6))
        os.symlink(outside, self.folder / "Linked.png")
        _, archive = self.backup()
        self.assertEqual([name for name in archive.namelist() if "station-images/" in name],
                         ["WorldMediaWindows-data/station-images/Real.png"])


class RouteTests(unittest.TestCase):
    LIST = "/api/v1/station-images"
    OPEN = "/api/v1/station-images/open-folder"

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
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state_root = Path(temporary.name).resolve() / "WorldMediaWindows-data"
        self.state_root.mkdir()
        self.images = StationImages(self.state_root)
        patcher = mock.patch.object(worldmedia_server, "STATION_IMAGES", self.images)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.token = worldmedia_server.SESSION_TOKEN
        (self.state_root / "station-images").mkdir()
        (self.state_root / "station-images" / "Radio Paradise.png").write_bytes(png())

    def request(self, method: str, path: str, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, path, skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response, data

    def headers(self, **overrides: str) -> dict[str, str]:
        headers = {"Origin": self.origin, "X-WorldMedia-Token": self.token}
        headers.update(overrides)
        return {name: value for name, value in headers.items() if value}

    def picture_path(self, key: str = "radio paradise") -> str:
        return f"{self.LIST}/{picture_id(key)}"

    def test_the_list_is_checked_like_other_get_routes(self) -> None:
        for headers, code in (
            (self.headers(**{"X-WorldMedia-Token": ""}), "INVALID_TOKEN"),
            (self.headers(**{"X-WorldMedia-Token": "wrong"}), "INVALID_TOKEN"),
            (self.headers(Origin="http://evil.example"), "INVALID_ORIGIN"),
        ):
            with self.subTest(code=code):
                response, data = self.request("GET", self.LIST, headers)
                self.assertEqual(response.status, 403)
                self.assertEqual(json.loads(data)["error"]["code"], code)
        response, data = self.request("GET", self.LIST + "?refresh=1", self.headers())
        self.assertEqual(response.status, 400)
        response, data = self.request("GET", self.LIST, self.headers())
        self.assertEqual(response.status, 200)
        listing = json.loads(data)["data"]
        self.assertEqual([entry["key"] for entry in listing["images"]], ["radio paradise"])
        self.assertEqual(listing["folder"], str(self.state_root / "station-images"))

    def test_a_picture_is_served_with_safe_headers(self) -> None:
        response, data = self.request("GET", self.picture_path(), self.headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(data, png())
        self.assertEqual(response.getheader("Content-Type"), "image/png")
        self.assertEqual(response.getheader("Content-Length"), str(len(png())))
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(response.getheader("Cache-Control"), "private, max-age=60")
        self.assertIn("sandbox", response.getheader("Content-Security-Policy"))
        etag = response.getheader("ETag")
        self.assertRegex(etag, r'^"si-[0-9a-f]{24}"$')
        response, data = self.request("GET", self.picture_path(), self.headers(**{"If-None-Match": etag}))
        self.assertEqual(response.status, 304)
        self.assertEqual(data, b"")
        # Without an Origin header (as a same-origin GET may be sent) the token still decides.
        response, _ = self.request("GET", self.picture_path(), self.headers(Origin=""))
        self.assertEqual(response.status, 200)

    def test_a_picture_is_checked_like_other_get_routes(self) -> None:
        for method, path, headers, status, code in (
            ("GET", self.picture_path(), self.headers(**{"X-WorldMedia-Token": ""}), 403, "INVALID_TOKEN"),
            ("GET", self.picture_path(), self.headers(Origin="http://evil.example"), 403, "INVALID_ORIGIN"),
            ("GET", self.picture_path() + "?x=1", self.headers(), 400, "QUERY_NOT_ALLOWED"),
            ("POST", self.picture_path(), self.headers(), 405, "METHOD_NOT_ALLOWED"),
            ("GET", self.picture_path("unknown"), self.headers(), 404, "STATION_IMAGE_NOT_FOUND"),
        ):
            with self.subTest(code=code, method=method):
                response, data = self.request(method, path, headers, b"{}" if method == "POST" else None)
                self.assertEqual(response.status, status)
                self.assertEqual(json.loads(data)["error"]["code"], code)

    def test_traversal_and_odd_paths_never_reach_a_file(self) -> None:
        (self.state_root / "secret.png").write_bytes(png(3, 3))
        for path in (
            self.LIST + "/../secret.png", self.LIST + "/..%2Fsecret.png", self.LIST + "/..%5Csecret.png",
            self.LIST + "/Radio%20Paradise.png", self.LIST + "/C:%5CWindows%5Cwin.ini", self.LIST + "/CON",
            self.LIST + "/" + picture_id("radio paradise").upper(), self.LIST + "/" + picture_id("radio paradise") + ":x",
        ):
            with self.subTest(path=path):
                response, data = self.request("GET", path, self.headers())
                self.assertIn(response.status, {400, 404})
                self.assertNotEqual(data, png(3, 3))
                self.assertNotEqual(data, png())

    def test_scoped_picture_routes_do_not_replace_same_name_files(self) -> None:
        headers = self.headers(**{"Content-Type": "application/json"})
        station_id = "radio:news"
        save = {"station": "Radio Paradise", "station_id": station_id}
        response, data = self.request("POST", self.LIST + "/save", headers,
                                      json.dumps({**save, "preview": True}).encode())
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(data)["data"]["files"], [])
        response, data = self.request("POST", self.LIST + "/save", headers,
                                      json.dumps({**save, "data": base64.b64encode(png(3, 3)).decode()}).encode())
        self.assertEqual(response.status, 200)
        saved = json.loads(data)["data"]
        key = "wm-station-id-" + hashlib.sha256(station_id.encode()).hexdigest()
        self.assertEqual(saved["key"], key)
        self.assertEqual(self.images.replace_files("Renamed", station_id=station_id)["files"], [saved["file"]])
        self.assertEqual(self.images.replace_files("Radio Paradise", station_id="tv:news")["files"], [])
        response, data = self.request("POST", self.LIST + "/remove", headers,
                                      json.dumps({"id": saved["id"], "files": [saved["file"]]}).encode())
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(data)["data"]["removed"], 1)
        self.assertEqual(self.images.read(picture_id("radio paradise"))[0], png())
        with self.assertRaises(ApiError):
            self.images.read(saved["id"])

    def test_open_folder_is_a_checked_mutation(self) -> None:
        json_headers = self.headers(**{"Content-Type": "application/json"})
        with mock.patch.object(StationImages, "open_folder", return_value="X") as opened:
            for headers, body, status, code in (
                (self.headers(**{"Content-Type": "application/json", "X-WorldMedia-Token": ""}), b"{}", 403,
                 "INVALID_TOKEN"),
                ({**json_headers, "Origin": ""}, b"{}", 403, "ORIGIN_REQUIRED"),
                (self.headers(**{"Content-Type": "application/json", "Origin": "http://evil.example"}), b"{}",
                 403, "INVALID_ORIGIN"),
                (json_headers, b'{"path":"C:/Windows"}', 400, "UNEXPECTED_FIELDS"),
            ):
                with self.subTest(code=code):
                    response, data = self.request("POST", self.OPEN, {k: v for k, v in headers.items() if v}, body)
                    self.assertEqual(response.status, status)
                    self.assertEqual(json.loads(data)["error"]["code"], code)
            response, _ = self.request("GET", self.OPEN, self.headers())
            self.assertEqual(response.status, 405)
            opened.assert_not_called()
            response, data = self.request("POST", self.OPEN, json_headers, b"{}")
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(data)["data"], {"opened": True, "path": "X"})
        opened.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
