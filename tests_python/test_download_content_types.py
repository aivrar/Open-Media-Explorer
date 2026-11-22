import types
import unittest

from worldmedia_downloads import DownloadError, _trusted_extension, _validate_content


def registration(media_type, name):
    return types.SimpleNamespace(media_type=media_type, download_name=name)


class AudioInVideoContainerTests(unittest.TestCase):
    def test_sound_served_under_a_picture_type_is_accepted_and_keeps_its_ending(self):
        mp4 = b"\x00\x00\x00 ftypM4A \x00\x00\x00\x00"
        webm = b"\x1a\x45\xdf\xa3\x01\x00\x00\x00"
        ogg = b"OggS\x00\x02\x00\x00"
        for name, content_type, start in (
            ("Episode.m4a", "video/mp4", mp4),
            ("Episode.m4a", "video/quicktime", mp4),
            ("Episode.webm", "video/webm", webm),
            ("Episode.ogg", "video/ogg", ogg),
            ("Episode.opus", "video/ogg", ogg),
        ):
            with self.subTest(name=name, content_type=content_type):
                item = registration("audio", name)
                _validate_content(item, content_type, start)
                self.assertEqual(_trusted_extension(item, content_type), name.rsplit(".", 1)[1])

    def test_the_file_must_begin_the_way_its_container_begins(self):
        for name, content_type, start in (
            ("Episode.m4a", "video/mp4", b"%PDF-1.7 not sound at all"),
            ("Episode.m4a", "video/mp4", b'{"error": "not found"}'),
            ("Episode.m4a", "video/mp4", b""),
            ("Episode.webm", "video/webm", b"\x00\x00\x00 ftypisom"),
            ("Episode.ogg", "video/ogg", b"ID3\x04\x00"),
        ):
            with self.subTest(name=name, start=start[:8]):
                with self.assertRaises(DownloadError) as caught:
                    _validate_content(registration("audio", name), content_type, start)
                self.assertEqual(caught.exception.code, "CONTENT_TYPE_MISMATCH")

    def test_a_real_mismatch_is_still_refused(self):
        for name, content_type in (
            ("Episode.mp3", "video/mp4"),
            ("Episode.m4a", "video/webm"),
            ("Episode.flac", "video/quicktime"),
        ):
            with self.subTest(name=name, content_type=content_type):
                with self.assertRaises(DownloadError) as caught:
                    _validate_content(registration("audio", name), content_type, b"data")
                self.assertEqual(caught.exception.code, "CONTENT_TYPE_MISMATCH")
        with self.assertRaises(DownloadError):
            _validate_content(registration("video", "Film.mp4"), "audio/mpeg", b"data")
        with self.assertRaises(DownloadError):
            _validate_content(registration("audio", "Episode.m4a"), "text/html", b"<html>")

    def test_newer_sound_types_get_the_right_ending(self):
        for content_type, ending in (
            ("audio/x-m4a", "m4a"), ("audio/x-flac", "flac"), ("audio/wave", "wav"),
            ("audio/aacp", "aac"), ("audio/webm", "webm"), ("application/ogg", "ogg"),
        ):
            with self.subTest(content_type=content_type):
                self.assertEqual(_trusted_extension(registration("audio", "Episode.bin"), content_type), ending)

    def test_a_video_download_named_mp4_is_unchanged(self):
        item = registration("video", "Film.mp4")
        _validate_content(item, "video/mp4", b"data")
        self.assertEqual(_trusted_extension(item, "video/mp4"), "mp4")


if __name__ == "__main__":
    unittest.main()
