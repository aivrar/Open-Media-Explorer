"""A station picture sent by the page: saved or removed in the station-images folder."""
from __future__ import annotations

import base64
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import worldmedia_server
import worldmedia_station_images as station_images
from tests_python.test_station_images import SVG, FolderTestCase, can_symlink, gif, jpeg, junction, png, webp
from worldmedia_catalog import _encode_png_rgba
from worldmedia_security import ApiError
from worldmedia_station_images import (
    MAX_FILE_BYTES,
    MAX_SAVE_BODY_BYTES,
    StationImages,
    decode_picture_data,
    picture_id,
    picture_stem,
    validated_picture,
)

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "station-image-file-names.json"


def windows_short_name(path: Path) -> str:
    """The Windows short (8.3) name of `path`, or '' where there is none."""

    if os.name != "nt":
        return ""
    import ctypes

    buffer = ctypes.create_unicode_buffer(1024)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer)):
        return ""
    return Path(buffer.value).name


class NamingTests(unittest.TestCase):
    def test_the_shared_file_names_match_the_page(self) -> None:
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 15)
        for station, stem in cases:
            with self.subTest(station=ascii(station)):
                self.assertEqual(picture_stem(station), stem)

    def test_names_that_cannot_be_a_file_name_give_none(self) -> None:
        for station in (None, 42, "", "...", ". .", "\u200eRadio", "x" * 1025, "A" * 300):
            with self.subTest(station=ascii(station)[:40]):
                stem = picture_stem(station)
                if stem:
                    # A long name gives a stem, but no file name that fits.
                    self.assertFalse(station_images.filename_allowed(stem + ".png"))
        self.assertEqual(picture_stem("A" * 300), "A" * 300)


class SaveTests(FolderTestCase):
    def save(self, station: object, data: bytes, **kwargs) -> dict:
        # As the page does: a yes is to the files it was shown (replace_files).
        if kwargs.get("replace") is True and "files" not in kwargs:
            kwargs["files"] = self.images.replace_files(station, kwargs.get("current"))["files"]
        return self.images.save(station, data, **kwargs)

    def refused(self, station: object, data: bytes, **kwargs) -> ApiError:
        with self.assertRaises(ApiError) as caught:
            self.save(station, data, **kwargs)
        return caught.exception

    def files(self) -> list[str]:
        return sorted(os.listdir(self.folder)) if self.folder.exists() else []

    def test_a_good_picture_is_saved_under_the_station_name(self) -> None:
        self.assertFalse(self.folder.exists())
        result = self.save("Radio Paradise", png(3, 3))
        self.assertEqual(result, {
            "file": "Radio Paradise.png", "key": "radio paradise", "id": picture_id("radio paradise"),
            "replaced": False,
        })
        self.assertEqual(self.files(), ["Radio Paradise.png"])
        self.assertEqual((self.folder / "Radio Paradise.png").read_bytes(), validated_picture(png(3, 3))[0])
        # The folder scan finds and serves it like a picture put there by hand.
        self.assertEqual(self.keys(), ["radio paradise"])
        self.assertEqual(self.images.read(picture_id("radio paradise"))[1], "image/png")

    def test_the_type_comes_from_the_content_not_a_name(self) -> None:
        self.assertEqual(self.save("One", jpeg())["file"], "One.jpg")
        self.assertEqual(self.save("Two", webp())["file"], "Two.webp")
        self.assertEqual(self.save("Three", gif())["file"], "Three.gif")
        self.assertEqual(self.files(), ["One.jpg", "Three.gif", "Two.webp"])
        for data in (b"hello", b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, png()[:-4], b"GIF89a"):
            with self.subTest(data=data[:12]):
                error = self.refused("Four", data)
                self.assertEqual((error.status, error.code), (415, "STATION_IMAGE_NOT_PICTURE"))
                self.assertIn("PNG, JPG, WebP or GIF", error.message)
        self.assertEqual(self.files(), ["One.jpg", "Three.gif", "Two.webp"])

    def test_an_svg_is_refused_and_says_why(self) -> None:
        for data in (SVG, b"\xef\xbb\xbf  " + SVG, b'<?xml version="1.0"?>\n' + SVG):
            with self.subTest(data=data[:20]):
                error = self.refused("Vector", data)
                self.assertEqual((error.status, error.code), (415, "STATION_IMAGE_SVG"))
                self.assertIn("SVG", error.message)
        self.assertNotIn("Vector.png", self.files())

    def test_an_oversized_picture_is_refused(self) -> None:
        error = self.refused("Big", png() + b"\x00" * MAX_FILE_BYTES)
        self.assertEqual((error.status, error.code), (413, "STATION_IMAGE_TOO_LARGE"))
        self.assertIn("2 MB", error.message)
        # Too many pixels: the scan's dimension limit, said in plain words.
        wide = _encode_png_rgba(9000, 1, [bytes((1, 2, 3, 255)) * 9000])
        error = self.refused("Wide", wide)
        self.assertEqual(error.code, "STATION_IMAGE_NOT_PICTURE")
        self.assertIn("8192 pixels", error.message)
        self.assertEqual(self.files(), [])

    def test_the_sent_text_is_measured_before_it_is_decoded(self) -> None:
        too_long = "A" * (4 * ((MAX_FILE_BYTES + 2) // 3) + 4)
        with mock.patch.object(station_images.base64, "b64decode", side_effect=AssertionError("decoded")):
            with self.assertRaises(ApiError) as caught:
                decode_picture_data(too_long)
        self.assertEqual(caught.exception.code, "STATION_IMAGE_TOO_LARGE")
        for value in ("not base64!", "QUJD\n", "", None, 5):
            with self.subTest(value=value):
                with self.assertRaises(ApiError) as caught:
                    decode_picture_data(value)
                self.assertEqual(caught.exception.code, "INVALID_STATION_IMAGE")
        self.assertEqual(decode_picture_data(base64.b64encode(png()).decode("ascii")), png())
        self.assertGreater(MAX_SAVE_BODY_BYTES, 4 * ((MAX_FILE_BYTES + 2) // 3))

    def test_a_name_that_tries_to_leave_the_folder_stays_inside_it(self) -> None:
        outside_before = sorted(os.listdir(self.root))
        for station, expected in (
            ("../../evil", "..-..-evil.png"),
            ("..\\..\\evil2", "..-..-evil2.png"),
            ("C:\\Windows\\evil3", "C--Windows-evil3.png"),
            ("/etc/passwd", "-etc-passwd.png"),
            ("a/../../b", "a-..-..-b.png"),
            ("Radio.png:stream", "Radio.png-stream.png"),
        ):
            with self.subTest(station=station):
                self.assertEqual(self.save(station, png())["file"], expected)
                self.assertTrue((self.folder / expected).is_file())
        for station in ("..", ".", "", "   ", "\u202eevil", "._hidden", "x" * 300, None, 7):
            with self.subTest(station=ascii(station)[:20]):
                error = self.refused(station, png())
                self.assertEqual((error.status, error.code), (400, "STATION_IMAGE_BAD_NAME"))
        self.assertEqual(sorted(os.listdir(self.root)), outside_before)
        self.assertEqual(sorted(os.listdir(self.state_root)), ["station-images"])
        self.assertFalse(any(name.startswith("._worldmedia-save-") for name in self.files()))

    def test_reserved_and_forbidden_names_follow_the_naming_rule(self) -> None:
        self.assertEqual(self.save("AUX", png())["file"], "AUX_.png")
        self.assertEqual(self.save("COM1.FM", png())["file"], "COM1_.FM.png")
        self.assertEqual(self.save("Nu-Metal/Alternative", png())["file"], "Nu-Metal-Alternative.png")
        self.assertEqual(self.keys(), ["aux_", "com1_.fm", "nu-metal-alternative"])

    def test_a_folder_in_the_way_is_never_replaced(self) -> None:
        (self.folder / "Radio Paradise.png").mkdir(parents=True)
        error = self.refused("Radio Paradise", png(), replace=True)
        self.assertEqual((error.status, error.code), (409, "STATION_IMAGE_LINK"))
        self.assertIn("nothing was changed", error.message)
        self.assertTrue((self.folder / "Radio Paradise.png").is_dir())
        self.assertEqual(self.files(), ["Radio Paradise.png"])

    def test_a_junction_in_the_way_is_never_followed_or_replaced(self) -> None:
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.folder.mkdir()
        junction(elsewhere, self.folder / "Radio Paradise.jpg")
        error = self.refused("Radio Paradise", png(), replace=True)
        self.assertEqual(error.code, "STATION_IMAGE_LINK")
        self.assertEqual(os.listdir(elsewhere), [])
        self.assertEqual(self.files(), ["Radio Paradise.jpg"])

    def test_a_link_in_the_way_is_never_followed_or_replaced(self) -> None:
        self.folder.mkdir()
        if not can_symlink(self.folder):
            self.skipTest("Creating symbolic links needs Developer Mode on Windows.")
        outside = self.root / "outside.png"
        outside.write_bytes(png(7, 7))
        os.symlink(outside, self.folder / "Radio Paradise.png")
        error = self.refused("Radio Paradise", png(), replace=True)
        self.assertEqual(error.code, "STATION_IMAGE_LINK")
        self.assertEqual(outside.read_bytes(), png(7, 7))
        self.assertTrue(os.path.islink(self.folder / "Radio Paradise.png"))

    def test_a_link_made_at_the_last_moment_is_not_written_through(self) -> None:
        # The name turns into something other than a file between the check
        # and the rename (here a folder): the rename is not done.
        self.folder.mkdir()
        real_replace = os.replace
        calls = []

        def replace_after_swap(source, target):
            calls.append(target)
            return real_replace(source, target)

        real_lstat = os.lstat

        def lstat_sees_folder(path, *args, **kwargs):
            if str(path).endswith("Late.png"):
                (self.folder / "Late.png").mkdir(exist_ok=True)
            return real_lstat(path, *args, **kwargs)

        with mock.patch.object(station_images.os, "lstat", lstat_sees_folder), \
                mock.patch.object(station_images.os, "replace", replace_after_swap):
            error = self.refused("Late", png())
        self.assertEqual(error.code, "STATION_IMAGE_LINK")
        self.assertEqual(calls, [])
        self.assertEqual(self.files(), ["Late.png"])
        self.assertTrue((self.folder / "Late.png").is_dir())

    def test_replacing_a_picture_needs_the_users_yes(self) -> None:
        self.put("Radio Paradise.jpg", jpeg())
        error = self.refused("Radio Paradise", png())
        self.assertEqual((error.status, error.code), (409, "STATION_IMAGE_EXISTS"))
        # The question names the file (never a path).
        self.assertEqual(error.message, "The file Radio Paradise.jpg is already there. Replace it?")
        self.assertEqual(self.files(), ["Radio Paradise.jpg"])
        self.assertEqual((self.folder / "Radio Paradise.jpg").read_bytes(), jpeg())

        result = self.save("radio paradise", png(4, 4), replace=True)
        self.assertTrue(result["replaced"])
        self.assertEqual(result["file"], "radio paradise.png")
        # The old file of the same name (another type) is gone, so the new one is used.
        self.assertEqual(self.files(), ["radio paradise.png"])
        self.assertEqual(self.images.read(picture_id("radio paradise"))[0], validated_picture(png(4, 4))[0])

    def test_the_same_file_name_is_replaced_whole(self) -> None:
        self.put("KEXP.png", png(2, 2))
        self.save("KEXP", png(5, 5), replace=True)
        self.assertEqual(self.files(), ["KEXP.png"])
        self.assertEqual((self.folder / "KEXP.png").read_bytes(), validated_picture(png(5, 5))[0])

    def test_the_picture_the_page_shows_counts_only_with_the_users_yes(self) -> None:
        # "Rock/Pop" uses Rock_Pop.png (another spelling of its name).
        self.put("Rock_Pop.png", png(2, 2))
        self.put("Jazz.png", png(3, 3))
        self.listing()
        error = self.refused("Rock/Pop", png(4, 4), current=picture_id("rock_pop"))
        self.assertEqual(error.code, "STATION_IMAGE_EXISTS")
        self.assertEqual(error.message, "The file Rock_Pop.png is already there. Replace it?")
        self.assertEqual(self.files(), ["Jazz.png", "Rock_Pop.png"])

        result = self.save("Rock/Pop", png(4, 4), replace=True, current=picture_id("rock_pop"))
        self.assertTrue(result["replaced"])
        self.assertEqual(self.files(), ["Jazz.png", "Rock-Pop.png"])
        # A picture of another name is never removed, whatever the page sends.
        self.save("Rock/Pop", png(5, 5), replace=True, current=picture_id("jazz"))
        self.assertEqual(self.files(), ["Jazz.png", "Rock-Pop.png"])
        for current in (5, ["x"], {"id": "x"}):
            with self.subTest(current=current):
                self.assertEqual(self.refused("Rock/Pop", png(), replace=True, current=current).code,
                                 "INVALID_STATION_IMAGE")
        self.assertEqual(self.refused("Rock/Pop", png(), replace="yes").code, "INVALID_STATION_IMAGE")

    def test_a_failed_write_leaves_the_old_picture_and_no_temporary_file(self) -> None:
        self.put("Radio Paradise.png", png(2, 2))
        with mock.patch.object(station_images.os, "replace", side_effect=OSError("disk full")):
            error = self.refused("Radio Paradise", png(6, 6), replace=True)
        self.assertEqual(error.code, "STATION_IMAGE_NOT_SAVED")
        self.assertEqual(self.files(), ["Radio Paradise.png"])
        self.assertEqual((self.folder / "Radio Paradise.png").read_bytes(), png(2, 2))

    def test_an_unsafe_folder_is_not_written_to(self) -> None:
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        junction(elsewhere, self.folder)
        error = self.refused("Radio Paradise", png())
        self.assertEqual(error.code, "STATION_IMAGES_UNSAFE")
        self.assertEqual(os.listdir(elsewhere), [])

    def test_another_stations_exact_picture_is_never_taken_as_the_shown_one(self) -> None:
        # "Radio 1" matches only Radio 1.png; Radio1.png is the exact picture of
        # the station "Radio1". The page's `current` cannot make it go.
        self.put("Radio1.png", png(2, 2))
        self.listing()
        result = self.save("Radio 1", png(4, 4), current=picture_id("radio1"))
        self.assertFalse(result["replaced"])
        self.assertEqual(self.files(), ["Radio 1.png", "Radio1.png"])
        self.save("Radio 1", png(5, 5), replace=True, current=picture_id("radio1"))
        self.assertEqual(self.files(), ["Radio 1.png", "Radio1.png"])
        self.assertEqual((self.folder / "Radio1.png").read_bytes(), png(2, 2))

    def test_two_stations_sharing_one_file_name_are_asked_about_it_by_name(self) -> None:
        self.assertEqual(self.save("AC/DC", png())["file"], "AC-DC.png")
        for station in ("AC-DC", "AC:DC"):
            with self.subTest(station=station):
                error = self.refused(station, png(3, 3))
                self.assertEqual(error.code, "STATION_IMAGE_EXISTS")
                self.assertEqual(error.message, "The file AC-DC.png is already there. Replace it?")
        self.put("ac-dc.gif", gif())
        error = self.refused("AC:DC", jpeg())
        self.assertEqual(error.message, "The files ac-dc.gif and AC-DC.png are already there. Replace them?")

    def test_the_write_itself_never_replaces_a_file_without_the_users_yes(self) -> None:
        # Even when the earlier look at the folder missed the file.
        self.put("KEXP.png", png(2, 2))
        with mock.patch.object(StationImages, "_same_key", return_value=[]):
            error = self.refused("KEXP", png(5, 5))
        self.assertEqual((error.code, error.message), ("STATION_IMAGE_EXISTS", "The file KEXP.png is already there. Replace it?"))
        self.assertEqual((self.folder / "KEXP.png").read_bytes(), png(2, 2))
        self.assertEqual(self.files(), ["KEXP.png"])

    def test_a_file_that_appears_just_before_the_last_step_is_not_replaced(self) -> None:
        # Not there at any check; it comes in between the last check and the
        # rename. Without the user's yes the rename itself refuses.
        self.folder.mkdir()
        real_lstat = os.lstat
        appeared = []

        def lstat_then_appear(path, *args, **kwargs):
            if Path(path).name == "Late Comer.png" and not appeared:
                appeared.append(True)
                (self.folder / "Late Comer.png").write_bytes(png(9, 9))
                raise FileNotFoundError(str(path))
            return real_lstat(path, *args, **kwargs)

        with mock.patch.object(station_images.os, "lstat", lstat_then_appear), \
                mock.patch.object(station_images.os, "replace", side_effect=AssertionError("replaced")):
            error = self.refused("Late Comer", png(3, 3))
        self.assertEqual(appeared, [True])
        self.assertEqual((error.code, error.message),
                         ("STATION_IMAGE_EXISTS", "The file Late Comer.png is already there. Replace it?"))
        self.assertEqual((self.folder / "Late Comer.png").read_bytes(), png(9, 9))
        self.assertEqual(self.files(), ["Late Comer.png"], "no temporary file is left")
        # With the user's yes it is replaced.
        self.save("Late Comer", png(3, 3), replace=True)
        self.assertEqual((self.folder / "Late Comer.png").read_bytes(), validated_picture(png(3, 3))[0])

    def test_the_question_names_every_file_in_full_and_the_yes_covers_only_those(self) -> None:
        long_stem = "Long " + "x" * 150
        self.put(f"{long_stem}.png", png(2, 2))
        self.put(f"{long_stem}.gif", gif())
        self.listing()
        self.assertEqual(self.images.replace_files(long_stem), {"files": [f"{long_stem}.gif", f"{long_stem}.png"]})
        error = self.refused(long_stem, jpeg())
        self.assertEqual(error.message,
                         f"The files {long_stem}.gif and {long_stem}.png are already there. Replace them?")
        # Another file came in after the question: nothing is replaced or deleted.
        self.put(f"{long_stem}.webp", webp())
        error = self.refused(long_stem, jpeg(), replace=True, files=[f"{long_stem}.gif", f"{long_stem}.png"])
        self.assertEqual(error.code, "STATION_IMAGE_CHANGED")
        self.assertEqual(len(self.files()), 3)
        # A yes without the names, or with names of other files, is refused.
        for files in (None, [], ["Other.png", f"{long_stem}.png", f"{long_stem}.gif"], "x.png"):
            with self.subTest(files=files):
                error = self.refused(long_stem, jpeg(), replace=True, files=files)
                self.assertIn(error.code, {"INVALID_STATION_IMAGE", "STATION_IMAGE_CHANGED"})
        self.assertEqual(len(self.files()), 3)
        everything = self.images.replace_files(long_stem)["files"]
        self.save(long_stem, jpeg(), replace=True, files=everything)
        self.assertEqual(self.files(), [f"{long_stem}.jpg"])
        # Files sent without a yes are refused.
        self.assertEqual(self.refused("New", png(), files=["New.png"]).code, "INVALID_STATION_IMAGE")

    def test_more_files_than_a_question_can_name_are_refused_and_nothing_is_deleted(self) -> None:
        self.put("Radio Paradise.png", png())
        self.put("radio paradise.gif", gif())
        self.listing()
        with mock.patch.object(station_images, "MAX_FILES_NAMED", 1):
            for call in (lambda: self.images.replace_files("Radio Paradise"),
                         lambda: self.save("Radio Paradise", jpeg()),
                         lambda: self.images.save("Radio Paradise", jpeg(), replace=True,
                                                  files=["Radio Paradise.png"]),
                         lambda: self.images.removal_files(picture_id("radio paradise")),
                         lambda: self.images.remove(picture_id("radio paradise"), ["Radio Paradise.png"])):
                with self.assertRaises(ApiError) as caught:
                    call()
                self.assertEqual(caught.exception.code, "STATION_IMAGE_TOO_MANY_FILES")
                self.assertIn("Tidy that folder by hand", caught.exception.message)
                self.assertIn("where your station pictures are kept", caught.exception.message)
                self.assertNotIn(str(self.root), caught.exception.message)
        self.assertEqual(self.files(), ["Radio Paradise.png", "radio paradise.gif"])
        self.assertIn(f"More than {station_images.MAX_FILES_NAMED} files", station_images.TOO_MANY_FILES)

    def test_a_folder_with_too_many_files_is_refused_not_half_read(self) -> None:
        self.put("Zulu.png", png(2, 2))
        for number in range(5):
            self.put(f"other {number}.txt", b"x")
        with mock.patch.object(station_images, "MAX_DIRECTORY_ENTRIES", 4):
            error = self.refused("Zulu", png(5, 5), replace=True)
            self.assertEqual((error.status, error.code), (409, "STATION_IMAGES_TOO_MANY"))
            self.assertIn("too many files", error.message)
        self.assertEqual((self.folder / "Zulu.png").read_bytes(), png(2, 2))
        self.assertFalse(any(name.startswith("._worldmedia-save-") for name in self.files()))

    def test_another_files_windows_short_name_is_never_written_through(self) -> None:
        long_name = "Radio Paradise Long Name.png"
        self.put(long_name, png(7, 7))
        short = windows_short_name(self.folder / long_name)
        if not short or short.lower() == long_name.lower():
            self.skipTest("This volume makes no short (8.3) file names, so there is no short name to try.")
        station = short.rsplit(".", 1)[0]
        error = self.refused(station, png(3, 3))
        self.assertEqual(error.code, "STATION_IMAGE_LINK")
        error = self.refused(station, png(3, 3), replace=True)
        self.assertEqual(error.code, "STATION_IMAGE_LINK")
        self.assertEqual((self.folder / long_name).read_bytes(), png(7, 7))
        self.assertEqual(self.files(), [long_name])
        # Nor deleted through it.
        folder = self.images._folder_info()
        self.assertFalse(self.images._unlink(folder, short))
        self.assertEqual(self.files(), [long_name])

    def test_a_name_that_opens_another_listed_file_is_never_written_or_deleted(self) -> None:
        # The same rule on any volume: here "RADIOP~1.png" is made to open the
        # file listed as "Radio Paradise Long Name.png", as a short name does.
        long_name = "Radio Paradise Long Name.png"
        victim = self.put(long_name, png(7, 7))
        real_lstat = os.lstat

        def short_name_opens_victim(path, *args, **kwargs):
            if Path(path).name.lower() == "radiop~1.png":
                return real_lstat(victim, *args, **kwargs)
            return real_lstat(path, *args, **kwargs)

        with mock.patch.object(station_images.os, "lstat", short_name_opens_victim):
            for replace in (False, True):
                with self.subTest(replace=replace):
                    self.assertEqual(self.refused("RADIOP~1", png(3, 3), replace=replace).code, "STATION_IMAGE_LINK")
            self.assertFalse(self.images._unlink(self.images._folder_info(), "RADIOP~1.png"))
        self.assertEqual(victim.read_bytes(), png(7, 7))
        self.assertEqual(self.files(), [long_name])

    def test_a_crashed_saves_old_temporary_file_is_cleared_by_the_scan(self) -> None:
        self.put("KEXP.png", png())
        old = self.folder / "._worldmedia-save-0123456789abcdef.tmp"
        fresh = self.folder / "._worldmedia-save-fedcba9876543210.tmp"
        other = self.folder / "._worldmedia-save-mine.tmp"
        for path in (old, fresh, other):
            path.write_bytes(b"partial")
        hour_ago = time.time() - 2 * 60 * 60
        os.utime(old, (hour_ago, hour_ago))
        os.utime(other, (hour_ago, hour_ago))
        self.listing()
        self.assertEqual(self.files(), [
            "._worldmedia-save-fedcba9876543210.tmp", "._worldmedia-save-mine.tmp", "KEXP.png",
        ])
        self.assertEqual(self.keys(), ["kexp"])

    def test_a_folder_named_like_a_temporary_file_is_left_alone(self) -> None:
        self.folder.mkdir()
        named = self.folder / "._worldmedia-save-0123456789abcdef.tmp"
        named.mkdir()
        hour_ago = time.time() - 2 * 60 * 60
        os.utime(named, (hour_ago, hour_ago))
        self.listing()
        self.assertTrue(named.is_dir())

    def remove_all(self, picture: str) -> dict:
        files = self.images.removal_files(picture_id(picture))["files"]
        return self.images.remove(picture_id(picture), files)

    def test_remove_names_the_files_then_takes_only_those(self) -> None:
        self.put("Radio Paradise.png", png())
        self.put("radio paradise.gif", gif())
        self.put("KEXP.jpg", jpeg())
        self.listing()
        preview = self.images.removal_files(picture_id("radio paradise"))
        self.assertEqual(preview, {"files": ["Radio Paradise.png", "radio paradise.gif"], "file": "Radio Paradise.png"})
        self.assertEqual(len(self.files()), 3, "a preview deletes nothing")
        # Only the files the user was asked about go.
        result = self.images.remove(picture_id("radio paradise"), ["radio paradise.gif", "KEXP.jpg"])
        self.assertEqual(result, {"removed": 1, "file": "Radio Paradise.png"})
        self.assertEqual(self.files(), ["KEXP.jpg", "Radio Paradise.png"])
        self.listing()
        self.assertEqual(self.remove_all("radio paradise")["removed"], 1)
        self.assertEqual(self.files(), ["KEXP.jpg"])
        self.assertEqual(self.keys(), ["kexp"])
        for value in (picture_id("radio paradise"), "../KEXP.jpg", "KEXP.jpg", None, picture_id("kexp").upper()):
            with self.subTest(value=value):
                with self.assertRaises(ApiError) as caught:
                    self.images.remove(value, ["KEXP.jpg"])
                self.assertEqual(caught.exception.code, "STATION_IMAGE_NOT_FOUND")
        for files in ([], "KEXP.jpg", ["../KEXP.jpg"], [5], ["x.png"] * 21):
            with self.subTest(files=files):
                with self.assertRaises(ApiError) as caught:
                    self.images.remove(picture_id("kexp"), files)
                self.assertEqual(caught.exception.code, "INVALID_STATION_IMAGE")
        self.assertEqual(self.files(), ["KEXP.jpg"])

    def test_a_renamed_favorites_picture_under_its_new_name_is_removed_alone(self) -> None:
        # The favorite "Radio One" renamed "Morning": its picture is Morning.png.
        self.put("Morning.png", png())
        self.put("Radio One.png", png(2, 2))
        self.listing()
        self.assertEqual(self.images.removal_files(picture_id("morning"))["files"], ["Morning.png"])
        self.assertEqual(self.remove_all("morning")["removed"], 1)
        self.assertEqual(self.files(), ["Radio One.png"])

    def test_remove_never_follows_a_link(self) -> None:
        self.put("Radio Paradise.png", png())
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "keep.txt").write_bytes(b"keep")
        junction(elsewhere, self.folder / "Radio Paradise.jpg")
        self.listing()
        self.assertEqual(self.images.removal_files(picture_id("radio paradise"))["files"], ["Radio Paradise.png"])
        self.assertEqual(self.images.remove(picture_id("radio paradise"), ["Radio Paradise.png", "Radio Paradise.jpg"])
                         ["removed"], 1)
        self.assertEqual(self.files(), ["Radio Paradise.jpg"])
        self.assertEqual(os.listdir(elsewhere), ["keep.txt"])


class SaveRouteTests(unittest.TestCase):
    SAVE = "/api/v1/station-images/save"
    REMOVE = "/api/v1/station-images/remove"

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
        self.folder = self.state_root / "station-images"
        self.images = StationImages(self.state_root)
        patcher = mock.patch.object(worldmedia_server, "STATION_IMAGES", self.images)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.token = worldmedia_server.SESSION_TOKEN

    def request(self, method: str, path: str, headers: dict[str, str] | None = None, body: bytes | None = None,
                length: int | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, path, skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None:
            connection.putheader("Content-Length", str(len(body) if length is None else length))
        connection.endheaders(body)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response, json.loads(data or b"null")

    def headers(self, **overrides: str) -> dict[str, str]:
        headers = {"Origin": self.origin, "X-WorldMedia-Token": self.token, "Content-Type": "application/json"}
        headers.update(overrides)
        return {name: value for name, value in headers.items() if value}

    def body(self, **fields) -> bytes:
        payload = {"station": "Radio Paradise", "data": base64.b64encode(png()).decode("ascii")}
        payload.update(fields)
        return json.dumps({key: value for key, value in payload.items() if value is not ...}).encode("utf-8")

    def test_a_save_is_guarded_like_other_control_routes(self) -> None:
        for headers, status, code in (
            (self.headers(**{"X-WorldMedia-Token": ""}), 403, "INVALID_TOKEN"),
            (self.headers(**{"X-WorldMedia-Token": "wrong"}), 403, "INVALID_TOKEN"),
            (self.headers(Origin=""), 403, "ORIGIN_REQUIRED"),
            (self.headers(Origin="http://evil.example"), 403, "INVALID_ORIGIN"),
            (self.headers(**{"Content-Type": "image/png"}), 415, "JSON_REQUIRED"),
        ):
            with self.subTest(code=code, headers=sorted(headers)):
                response, envelope = self.request("POST", self.SAVE, headers, self.body())
                self.assertEqual(response.status, status)
                self.assertEqual(envelope["error"]["code"], code)
        self.assertFalse(self.folder.exists())
        for path in (self.SAVE, self.REMOVE):
            response, envelope = self.request("GET", path, self.headers())
            self.assertEqual((response.status, envelope["error"]["code"]), (405, "METHOD_NOT_ALLOWED"))
        response, envelope = self.request("POST", self.SAVE + "?file=x.png", self.headers(), self.body())
        self.assertEqual(envelope["error"]["code"], "QUERY_NOT_ALLOWED")

    def test_the_size_limit_comes_before_the_body_is_read(self) -> None:
        response, envelope = self.request(
            "POST", self.SAVE, self.headers(), b"{}", length=MAX_SAVE_BODY_BYTES + 1,
        )
        self.assertEqual((response.status, envelope["error"]["code"]), (413, "BODY_TOO_LARGE"))
        big = base64.b64encode(b"\x00" * (MAX_FILE_BYTES + 3)).decode("ascii")
        response, envelope = self.request("POST", self.SAVE, self.headers(), self.body(data=big))
        self.assertEqual((response.status, envelope["error"]["code"]), (413, "STATION_IMAGE_TOO_LARGE"))
        self.assertIn("2 MB", envelope["error"]["message"])

    def test_the_page_never_names_the_file(self) -> None:
        for extra in ({"file": "x.png"}, {"path": "C:\\x.png"}, {"name": "x"}):
            with self.subTest(extra=extra):
                response, envelope = self.request("POST", self.SAVE, self.headers(), self.body(**extra))
                self.assertEqual((response.status, envelope["error"]["code"]), (400, "INVALID_STATION_IMAGE"))
        response, envelope = self.request("POST", self.SAVE, self.headers(), self.body(station=...))
        self.assertEqual(envelope["error"]["code"], "INVALID_STATION_IMAGE")
        self.assertFalse(self.folder.exists())

    def test_save_replace_and_remove_through_the_routes(self) -> None:
        response, envelope = self.request("POST", self.SAVE, self.headers(), self.body())
        self.assertEqual(response.status, 200, envelope)
        self.assertEqual(envelope["data"]["file"], "Radio Paradise.png")
        self.assertEqual(sorted(os.listdir(self.folder)), ["Radio Paradise.png"])

        jpg = base64.b64encode(jpeg()).decode("ascii")
        response, envelope = self.request("POST", self.SAVE, self.headers(), self.body(data=jpg))
        self.assertEqual((response.status, envelope["error"]["code"]), (409, "STATION_IMAGE_EXISTS"))
        self.assertEqual(envelope["error"]["message"], "The file Radio Paradise.png is already there. Replace it?")
        body = json.dumps({"station": "Radio Paradise", "preview": True}).encode("utf-8")
        response, envelope = self.request("POST", self.SAVE, self.headers(), body)
        self.assertEqual((response.status, envelope["data"]), (200, {"files": ["Radio Paradise.png"]}))
        for wrong in ({"station": "Radio Paradise", "preview": False}, {"preview": True},
                      {"station": "Radio Paradise", "preview": True, "data": jpg}):
            with self.subTest(body=sorted(wrong)):
                response, envelope = self.request("POST", self.SAVE, self.headers(), json.dumps(wrong).encode("utf-8"))
                self.assertEqual((response.status, envelope["error"]["code"]), (400, "INVALID_STATION_IMAGE"))
        response, envelope = self.request(
            "POST", self.SAVE, self.headers(), self.body(data=jpg, replace=True, files=["Radio Paradise.png"]),
        )
        self.assertEqual(response.status, 200, envelope)
        self.assertEqual(sorted(os.listdir(self.folder)), ["Radio Paradise.jpg"])

        svg = base64.b64encode(SVG).decode("ascii")
        response, envelope = self.request("POST", self.SAVE, self.headers(), self.body(station="Vector", data=svg))
        self.assertEqual((response.status, envelope["error"]["code"]), (415, "STATION_IMAGE_SVG"))

        self.images.listing()
        identity = picture_id("radio paradise")
        # First the files it would delete (named in the question), then those.
        body = json.dumps({"id": identity, "preview": True}).encode("utf-8")
        response, envelope = self.request("POST", self.REMOVE, self.headers(), body)
        self.assertEqual(response.status, 200, envelope)
        self.assertEqual(envelope["data"]["files"], ["Radio Paradise.jpg"])
        self.assertEqual(os.listdir(self.folder), ["Radio Paradise.jpg"])
        for wrong in ({"id": identity}, {"id": identity, "preview": "yes"}, {"id": identity, "file": "x"},
                      {"id": identity, "files": ["Radio Paradise.jpg"], "preview": True}):
            with self.subTest(body=wrong):
                response, envelope = self.request("POST", self.REMOVE, self.headers(), json.dumps(wrong).encode("utf-8"))
                self.assertEqual((response.status, envelope["error"]["code"]), (400, "INVALID_STATION_IMAGE"))
        self.assertEqual(os.listdir(self.folder), ["Radio Paradise.jpg"])
        body = json.dumps({"id": identity, "files": ["Radio Paradise.jpg"]}).encode("utf-8")
        response, envelope = self.request("POST", self.REMOVE, self.headers(), body)
        self.assertEqual(response.status, 200, envelope)
        self.assertEqual(envelope["data"]["removed"], 1)
        self.assertEqual(os.listdir(self.folder), [])


if __name__ == "__main__":
    unittest.main()
